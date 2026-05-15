# Microsoft Planner Integration — Design

**Status:** Design doc. Not yet implemented. Stub in place (`plannerSyncStub` in `server.js`) that logs intended tasks but doesn't call Graph.
**Owner:** Engineering (Leigh) + Fleet Ops (for plan-structure decisions)
**Depends on:** [SSO design](sso-design.md) — uses the same Entra app registration

---

## Goal

When an audit is finalized, automatically create Microsoft Planner tasks for each action item (move / locate / remove) so fleet ops can track resolution in their existing task surface rather than building a separate UI.

Out of scope for v1: closing Planner tasks from inside our app, two-way sync, Planner-to-action-items reconciliation.

---

## What needs to happen in Entra / M365 (admin work)

### 1. Decide on the Planner plan structure

This is the **first product decision** that gates implementation. Two viable shapes:

#### Option A: One plan per hub

- **Pro**: Each hub manager / regional fleet ops can see "their" plan cleanly.
- **Pro**: Plan permissions can be granted per-hub if needed later.
- **Con**: 15 plans to maintain.
- **Con**: Inbound moves to a hub are mixed with internal hub work in their plan.

#### Option B: One master plan, buckets per action type — **recommended for v1**

- One plan: "TNS Spare Key Audit Actions"
- Three buckets: `Move`, `Locate`, `Remove`
- Filter / sort by labels (e.g., hub names as labels) for views
- **Pro**: Single surface; lower maintenance.
- **Pro**: Fleet ops sees the firehose of work cleanly.
- **Pro**: Easy to add more action types later (e.g., `Verify`, `Investigate`) by adding buckets.
- **Con**: Hub managers can't easily see "what's pending for my hub" without filtering.

#### Option C: One master plan, buckets per destination hub

- 15 buckets, one per hub.
- **Pro**: Inbound moves clearly visible per hub.
- **Con**: "Locate at hub X" and "Remove from hub X" tasks would also live in the X bucket — mixed semantics.
- **Con**: 15-bucket UI is visually noisy.

**Recommendation: Option B.** Action-type bucketing is the cleanest semantic and matches our action-items data model. Use Planner **labels** for hub names so views can filter.

### 2. Create the plan in Microsoft 365

Once we agree on Option B:

- Owner of the plan: Fleet Ops Team (an existing M365 group, or create one)
- **Plan name**: `TNS Spare Key Audit Actions`
- **Buckets** (in this order):
  1. `Move` (default)
  2. `Locate`
  3. `Remove`
- **Labels** (called "categories" in Planner): one per hub, color-coded — `CT - Fairfield` (blue), `CT - Wallingford` (green), etc. Up to 25 categories supported; we have 15 hubs so plenty of room.
- Record the **plan ID** (visible in the URL when you open the plan) → goes into `PLANNER_PLAN_ID` env var.

### 3. Add Graph permissions to the app

In the existing app registration (from [sso-design.md](sso-design.md)):

- **API permissions → Microsoft Graph → Application permissions** (not delegated — we want the server to act as itself, not as a logged-in user):
  - `Tasks.ReadWrite.All`
  - `Group.ReadWrite.All` (Planner plans live under M365 Groups)
- **Grant admin consent**.

Application permissions allow the server's service principal to call Graph without a user being present — important because the worker runs server-side without a logged-in human.

---

## Library choice: `@microsoft/microsoft-graph-client`

Microsoft's official Graph SDK. Pairs cleanly with MSAL for auth.

```bash
npm install @microsoft/microsoft-graph-client isomorphic-fetch
```

Auth strategy: client-credentials grant (already supported by `@azure/msal-node`).

---

## Code design

### New module: `planner.js`

Replaces the `plannerSyncStub` in `server.js`. Same call site, real Graph calls inside.

```javascript
const { Client } = require("@microsoft/microsoft-graph-client");
const { ClientSecretCredential } = require("@azure/identity");
require("isomorphic-fetch");

const credential = new ClientSecretCredential(
  process.env.AZURE_TENANT_ID,
  process.env.AZURE_CLIENT_ID,
  process.env.AZURE_CLIENT_SECRET,
);

const graph = Client.initWithMiddleware({
  authProvider: {
    getAccessToken: async () => {
      const token = await credential.getToken("https://graph.microsoft.com/.default");
      return token.token;
    },
  },
});

const BUCKET_IDS = {
  move:   process.env.PLANNER_BUCKET_MOVE,
  locate: process.env.PLANNER_BUCKET_LOCATE,
  remove: process.env.PLANNER_BUCKET_REMOVE,
};

async function createPlannerTask(action, audit, hubLabelId) {
  const title = formatTitle(action);
  const description = formatDescription(action, audit);
  const task = await graph.api("/planner/tasks").post({
    planId: process.env.PLANNER_PLAN_ID,
    bucketId: BUCKET_IDS[action.action_type],
    title,
    appliedCategories: hubLabelId ? { [hubLabelId]: true } : {},
  });
  // Description goes on a separate "details" endpoint
  await graph.api(`/planner/tasks/${task.id}/details`).patch({
    description,
  });
  return task.id;
}
```

### Where it's called

In `server.js`, replace `plannerSyncStub(audit, persistedActions)` with:

```javascript
const { syncToPlanner } = require("./planner");
// ... inside POST /api/submissions/:id/finalize:
syncToPlanner(audit, persistedActions).catch(err => {
  console.error(`[planner] sync failed for audit ${audit.id}:`, err.message);
  // Don't block finalize; planner sync is best-effort. Failed-to-sync items
  // can be retried via a separate /api/audits/:id/sync endpoint or admin job.
});
```

Note: `await` is deliberately NOT used at the call site. We don't want the finalize endpoint to fail or stall because Graph is slow / down. The audit + action items are already persisted by that point.

### Task title and description format

```
title: "Move key #283: CT - Fairfield → CT - Wallingford"
       "Locate missing key #229 at CT - Wallingford"
       "Remove offboarded key #160 from CT - Enfield spare box"

description: Auto-generated from audit
  ─────────────────────────────────
  Audit: <audit-link>
  Submitter: <name>
  Reviewer: <name>
  Finalized: <iso>
  Hub: <hub>
  Vehicle: #<vehicle_number>
  Last known address: <address>
  ─────────────────────────────────
```

### Persisting the Planner task ID

The `action_items.planner_task_id` column exists in the schema (currently NULL for all rows). After each successful Graph call, update the row:

```javascript
db.prepare("UPDATE action_items SET planner_task_id = ? WHERE id = ?")
  .run(task.id, actionItem.id);
```

This is the **idempotency key**: if the sync is re-run for an audit (manually or via retry), we only create tasks for rows where `planner_task_id IS NULL`.

---

## Retry handling

Graph API failures (rate limits, transient 5xx, network blips) need backoff. The simplest path:

- Sync runs async after finalize, no caller blocking.
- Per-action item: try 3 times with 30s exponential backoff (`@microsoft/microsoft-graph-client` has built-in retry middleware for 429 / 5xx).
- If still failing after retries: log + leave the row's `planner_task_id` NULL. A daily background job (cron-style, separate from the OCR worker) scans for `planner_task_id IS NULL AND created_at > now-7d` and retries.

A `/api/audits/:id/sync-planner` admin endpoint should exist for manual force-retry.

---

## Auto-close on subsequent audits (FR-4.4)

When a later audit at hub B confirms that key #N (which was previously a "move from A → B" action) has arrived, the corresponding Planner task should be closed.

This is already implemented in `server.js` for the *action_items* table — `closeActionItem` runs when a later finalize includes the key in `belongHere` for the destination hub. The Planner-side equivalent:

```javascript
async function closePlannerTask(plannerTaskId) {
  // Mark task as 100% complete; that triggers Planner's "completed" state
  const task = await graph.api(`/planner/tasks/${plannerTaskId}`).get();
  await graph.api(`/planner/tasks/${plannerTaskId}`).header("If-Match", task["@odata.etag"]).patch({
    percentComplete: 100,
  });
}
```

Wire into `closeActionItem` in db.js (or its caller in server.js): after updating the row, call `closePlannerTask` if `planner_task_id` is set.

---

## Decisions still needed

| # | Question | Recommendation | Decider |
|---|---|---|---|
| P1 | Plan structure (A / B / C above) | **B: one plan, three buckets per action type** | Fleet Ops |
| P2 | Default task assignee | **No default assignee in v1** — fleet ops triages from the Planner board. Less rigid, no risk of dumping work on someone away. | Fleet Ops |
| P3 | Should locate tasks have a default due date (e.g., +7 days)? | **Yes — +7 days** for `locate`; no due date for `move` or `remove` (those are scheduling-dependent) | Fleet Ops |
| P4 | Color coding on hub labels — which colors? | Match the geography (e.g., all CT hubs blue, all MA hubs green) | Fleet Ops |
| P5 | Do we link back to the audit from the Planner task? | **Yes** — include `/audits/<id>` URL in the task description. Requires the app to be at a public URL (post-deploy). | Engineering + Fleet Ops |
| P6 | What happens to Planner tasks for action items that get auto-closed because of a subsequent audit? | **Mark complete** (percentComplete: 100). Don't delete. Keeps history visible in Planner. | Engineering |
| P7 | Manual sync-retry endpoint visibility | **Yes** — small button in the inbox detail view for failed-sync audits | Engineering + Fleet Ops |

---

## Implementation order

Once decisions are made and credentials are available:

1. **First**: create the plan, buckets, and labels in Planner manually. Record the IDs.
2. **Then**: implement `planner.js` and replace the stub in `server.js`. Test with one real submission end-to-end.
3. **Then**: implement `closePlannerTask` in the auto-close path.
4. **Then**: implement the daily retry job + `/api/audits/:id/sync-planner` manual retry endpoint.
5. **Then**: surface sync status in the inbox UI (e.g., "Planner: synced (4)" or "Planner: 2/4 synced, retry?").

---

## Risk / open issues

- **Rate limits**: Graph has both per-app and per-tenant rate limits. At 15–30 audits/month, each generating maybe 5–15 tasks, total throughput is well under the limit. Document this in case it ever changes.
- **Plan ownership**: the plan needs to belong to an M365 Group. If the group is deleted, the plan + all tasks are also deleted. Document the plan + group as a critical pinned resource.
- **Task limit per plan**: Planner has a hard cap of ~10,000 tasks per plan. At our rate (~300 tasks/year), this would take ~30 years to hit. Not a near-term concern; flagged for future-future planning.
- **Permissions drift**: someone could revoke the app's Graph permissions after the fact. The sync function should catch 401/403 specifically and alert (rather than silently failing).

---

## What's NOT in this design

- **Bidirectional sync** — if someone closes a Planner task, our action_item stays open. Acceptable trade for v1 simplicity.
- **Planner comments / attachments** — task description carries everything we need.
- **Planner views or filters** — fleet ops sets these up in the Planner UI, not in our code.
- **Migration of historical action items** — only new finalizations sync. If we want to backfill, that's a separate one-time script.
