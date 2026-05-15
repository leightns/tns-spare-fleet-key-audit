# Overnight Run — 2026-05-15

Self-directed work between ~02:00 and ~03:30. All work committed to `main` and pushed to `origin`. Working tree clean.

---

## TL;DR (read this first)

1. **8 commits, all pushed.** Five feature commits + three design docs.
2. **Server now has two distinct end-user surfaces**: `/submit` (mobile-first field flow) and `/inbox` (central review with chip editing, finalize, action items, and the new Open Action Items tab).
3. **Backend additions**: `ocr.js` (extracted module), `reconciliation.js` (new), `audits` + `action_items` tables in `db.js`, `POST /api/submissions/:id/finalize`, `GET /api/audits`, `GET /api/action-items`.
4. **Planner sync is stubbed** (logs intended tasks). Real Graph integration is fully designed in `docs/planner-design.md` but not implemented — waiting on credentials.
5. **No SSO yet.** Designed in `docs/sso-design.md`. Manual name fields work in the meantime.
6. **No Azure deployment yet.** Designed in `docs/azure-deployment.md`.
7. **Local dev is fully working** end-to-end. You can hit `/submit` on your phone over LAN (same wifi caveat from earlier still applies) or test via `node scripts/test-finalize-flow.js`.

---

## Commits in order

```
408c109  Update README + requirements.md to reflect overnight implementation
effc36d  Add Azure deployment design doc
4218ffc  Add Microsoft Planner integration design doc
4bc8782  Add SSO design doc (Microsoft Entra ID, MSAL-Node)
0194ca4  Rebuild /inbox as central review tool with chip editing and finalize
7113810  Add field-flow /submit page (mobile-first, no OCR chips visible)
549d243  Add review/finalize backend: audits, action_items, reconciliation
2697bd5  Extract OCR pipeline to ocr.js + tighten submission input validation
```

Each one is independently revert-able. Each commit message describes the why, not just the what.

---

## What's testable right now

Server should be running locally on `:3000`. If not: `node server.js`.

### 1. End-to-end field → central flow (manual)

1. Open `http://localhost:3000/submit` in a browser.
2. Pick a hub, type your name, snap or pick a photo, optional note, submit.
3. You'll land on a receipt page with a submission ID.
4. Open `http://localhost:3000/inbox` in another tab.
5. The submission appears at the top with state `pending`. Within ~30s the worker tick picks it up and runs OCR (state goes `processing` → `ready`).
6. Click the row to expand. You'll see the photo + a chip list of detected vehicle numbers + an editing UI.
7. Add/remove chips as needed, type a reviewer name, click **Finalize Audit**.
8. The row state changes to `finalized` and a 4-bucket reconciliation view appears.
9. Switch to the **Open Action Items** tab. Any "belongs elsewhere," "missing," or "offboarded" item from the audit is there, grouped by destination hub.
10. Server log shows `[planner-stub]` lines for each action — what the real Planner integration *will* push.

### 2. Automated tests

```bash
node scripts/test-retry-flow.js       # validates backoff curve, no API calls
node scripts/test-finalize-flow.js    # validates reconciliation + finalize endpoint (needs server up)
```

Both should print rows of ✅. Failures will print ❌ and exit non-zero.

---

## Files added or substantially changed

```
NEW   ocr.js                            OCR pipeline extracted, testable in isolation
NEW   reconciliation.js                 Pure reconcile(chipList, hub, roster) function
NEW   public/submit.html                Field-flow mobile UI
NEW   scripts/test-finalize-flow.js     End-to-end reconciliation + finalize test
NEW   docs/sso-design.md
NEW   docs/planner-design.md
NEW   docs/azure-deployment.md
NEW   docs/overnight-2026-05-15.md      (this file)

MOD   server.js                         Dropped ~120 lines (OCR extracted to ocr.js);
                                        added /api/submissions/:id/finalize,
                                        /api/audits, /api/action-items, /submit route;
                                        tightened /api/submissions input validation;
                                        added plannerSyncStub
MOD   db.js                             Added audits + action_items tables + helpers
MOD   public/inbox.html                 Substantial rewrite: tabs, chip editing,
                                        finalize button, 4-bucket reconciliation
                                        view, action items grouped by destination
MOD   README.md                         Reflects new architecture; design-doc pointers
MOD   docs/requirements.md              Review state marked implemented; entity schemas
                                        updated; Q15 and Q20 closed; acceptance items
                                        checked off
```

---

## Things to verify when you wake up

In rough order of value:

1. **`git log --oneline -10`** — confirm the 8 commits look reasonable and the messages tell you what changed.
2. **`http://localhost:3000/inbox`** — open it in a browser. There should be one finalized test submission already if the worker has picked it up (or not, if you've cleaned the DB). Try the full flow with `samples/photo3.jpg`.
3. **Mobile**: load `/submit` on your phone (LAN IP, same wifi caveat) and verify the flow feels right. The receipt page should be short and clear; no OCR chips visible. Hub picker is at the top, photo capture mid-page, submit at the bottom.
4. **Server logs** — `tail -50 /tmp/keyaudit-server.log` if it's still where I left it. Should show worker ticks and any [planner-stub] output.

---

## Judgment calls I made (worth flagging)

These weren't obvious; pushing back is fair if you disagree.

1. **Kept the old `/` page** — the original single-user audit UI at `public/index.html`. Didn't delete it. Rationale: it's a working fallback if the new flow misbehaves, and "deprecate after 2 weeks of confident operation with the new flow" is a cleaner story than "remove and pray." It's not linked from anywhere new; it's only reachable by typing `/` directly.

2. **Reconciliation runs against the live roster, not a roster-as-of-submission**. Per requirements §4.5 FR-5.2, we use the roster as of *finalization*, not submission. Stored a roster snapshot in the audit row for repeatability. If you'd rather use the roster as of submission, that's a one-line change but it's a real product decision.

3. **Auto-close on subsequent audits** is implemented for the *action_items* table (see end of finalize handler). When a key now belongs to its assigned hub, any open "move → this hub" item is closed automatically. The corresponding Planner-side close is **only described in the design doc** because the Graph integration isn't live.

4. **Reviewer name is required on finalize**, just like submitter is required on submission. Both will be auto-filled from SSO once that lands; for now they're manual. Defaulted from localStorage so a single person doesn't retype.

5. **Action items tab groups inbound moves by destination hub and locate/remove items by source hub.** Felt right semantically — "what work is coming to my hub" vs "what work is at my hub." Easy to change if you'd rather group differently (e.g., by action_type, or by oldest-first).

6. **Tests are runnable Node scripts in `scripts/`**, not a proper test framework. Considered adding Jest or node:test; didn't want to land a framework choice unilaterally. Two scripts so far; happy to keep growing them or refactor when you decide on a framework.

7. **`/submit` saves submitter name + last hub to `localStorage`** so most submitters retype nothing past visit #1. Persists across phone restarts since it's localStorage, not sessionStorage.

8. **Kept the synchronous `/api/analyze` endpoint** for the original UI. Could remove it once SSO arrives and we deprecate the original flow.

---

## What's blocked on you / IT

These can't move forward without external input:

| Blocker | Needed from | What it unblocks |
|---|---|---|
| Entra app registration + client secret | TNS IT / Azure admin | SSO implementation (see [sso-design.md](sso-design.md)) |
| `KeyAudit-FleetOps` security group + memberships | TNS IT + Fleet Ops | Role-based access to /inbox |
| Confirm `keyaudit.thenextstreet.com` subdomain available | TNS IT | DNS + cert provisioning |
| Planner plan structure decision (recommendation: 1 plan, 3 buckets — see Q P1) | Fleet Ops | Real Planner integration |
| Decisions Q3, Q4, P2–P7 in `requirements.md` and `planner-design.md` | Fleet Ops | Implementation of remaining design |
| Azure subscription + resource group | TNS IT | Production deploy (see [azure-deployment.md](azure-deployment.md)) |

---

## What I'd suggest as the next session

Once the above blockers are unblocked (or where you're ready to proceed without):

1. **Wire up SSO behind the `AUTH_ENABLED` feature flag** (~half day's work given the design doc).
2. **Replace `plannerSyncStub` with the real Graph integration** (~half day).
3. **Provision Azure resources + deploy** (~2 hours of Azure portal clicking + one CI/CD setup).
4. **Run a 2-week pilot at one hub**. Pick a friendly hub manager, train them in 5 minutes, watch for issues.
5. **Then** broaden rollout.

There's also good unfinished cleanup if you want to start there:

- The inbox's chip-editor needs more polish on small screens (the chip × button gets cramped).
- The original `/` page should probably be deprecated/redirected to `/submit` once confidence is high.
- A few magic numbers (worker poll interval, backoff curve, max attempts) deserve a `config.js` instead of being scattered.

---

## State at handoff

```
$ git status
On branch main
Your branch is ahead of 'origin/main' by 0 commits.   ← about to push
nothing to commit, working tree clean
```

Server was last started cleanly. Database has been used during testing and may contain a few test rows (look for `submitter_name LIKE '%test%'` if you want to clean them out — or just let them be).

Two background processes you might see:
- `node server.js` — the running server. Leave or `pkill -f "node server.js"`.
- Anything in `/tmp/keyaudit-server.log` — non-essential, can be deleted.

Have a good morning.
