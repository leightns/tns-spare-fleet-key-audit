# tns-spare-fleet-key-audit

Internal tool for auditing spare vehicle keys at The Next Street hub locations: snap a photo of the spare-key box, OCR the vehicle numbers on the tags, reconcile against the expected hub roster, and surface the misplaced / missing / offboarded keys as action items.

**Status:** in active development. OCR pipeline validated on 3 photos at 100% recall / 0 false positives. Field + central UIs built end-to-end. Local dev works fully. Still ahead: M365 SSO (designed), Microsoft Planner integration (designed), Azure deployment (designed).

## Quick start (local dev)

```bash
npm install                                    # one-time
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env     # add your key
node server.js                                 # boots on :3000
```

URLs:
- `http://localhost:3000/submit` — **field** submission flow (mobile-first; hub manager taps to capture + submit)
- `http://localhost:3000/inbox` — **central** team inbox (review queue, edit OCR chips, finalize, action items)
- `http://localhost:3000/` — original single-user audit UI (synchronous; predecessor to /submit + /inbox)

Test scripts:
- `node scripts/test-retry-flow.js` — validates the OCR queue backoff curve
- `node scripts/test-finalize-flow.js` — end-to-end test of reconciliation + finalize + action items (requires server running)

## Architecture (today)

```
                        Field staff                          Central fleet ops
                            │                                      │
                            ▼                                      ▼
       ┌─────────────────────────────────┐         ┌──────────────────────────────┐
       │  /submit (mobile)               │         │  /inbox                       │
       │  pick hub → snap → submit       │         │  list, review, finalize       │
       └────────────┬────────────────────┘         └──────────────┬───────────────┘
                    │                                              │
                    ▼                                              ▼
       POST /api/submissions               POST /api/submissions/:id/finalize
                    │                                              │
                    ▼                                              ▼
       ┌─────────────────────────────────┐         ┌──────────────────────────────┐
       │  submissions table              │         │  audits + action_items tables│
       │  + photo on disk in uploads/    │         │  + planner_task_id slot      │
       └────────────┬────────────────────┘         └──────────────┬───────────────┘
                    │                                              │
              picked up by                                  triggers Planner
              background worker                            sync (currently stub)
                    │                                              │
                    ▼                                              ▼
       ┌─────────────────────────────────┐         ┌──────────────────────────────┐
       │  ocr.js: auto-rotate +          │         │  reconciliation.js           │
       │  3-pass Opus 4.7 +              │         │  4 buckets + action items    │
       │  consensus merge                │         └──────────────────────────────┘
       │  on 529: backoff retry          │
       │  (1m, 5m, 30m, 2h, 6h, 24h)     │
       └─────────────────────────────────┘
```

- **Field flow:** `POST /api/submissions` accepts a photo + hub + submitter, stores to `uploads/`, returns immediately with a submission ID. OCR runs asynchronously.
- **Background worker:** polls every 30s, claims one pending submission, runs the OCR pipeline. On Anthropic 529s, backs off for up to 6 attempts before transitioning to `exhausted` for manual retry.
- **Central inbox:** `/inbox` has two tabs (`Inbox` + `Open Action Items`). The Inbox tab shows submissions with state badges; clicking a `ready` row opens a chip-editing pane with photo + Finalize button. Finalize runs `reconciliation.js`, persists the audit + action items, stubs Planner sync.
- **Persistence:** SQLite at `data/app.db`; photos on disk in `uploads/`; vehicle roster in `vehicle_roster.csv`.

## Where to read more

**Specs / design**
- **[docs/requirements.md](docs/requirements.md)** — full requirements doc: users, flows, data model, M365 integrations, open questions. Read this first for context.
- **[docs/sso-design.md](docs/sso-design.md)** — Microsoft Entra ID + MSAL-Node design for gating /submit and /inbox.
- **[docs/planner-design.md](docs/planner-design.md)** — Microsoft Planner integration via Graph API (replaces the current `plannerSyncStub`).
- **[docs/azure-deployment.md](docs/azure-deployment.md)** — Azure App Service deployment plan with cost estimate and smoke-test checklist.

**Source files**
- **[`server.js`](server.js)** — Express app: API routes, the background worker, finalize endpoint.
- **[`ocr.js`](ocr.js)** — OCR pipeline: preprocess, 3-pass Claude calls, consensus merge.
- **[`reconciliation.js`](reconciliation.js)** — Pure function that buckets chip lists against the roster.
- **[`db.js`](db.js)** — SQLite schema + helpers for submissions, audits, action_items.
- **[`public/submit.html`](public/submit.html)** — Field-flow mobile UI.
- **[`public/inbox.html`](public/inbox.html)** — Central-team review UI.
- **[`public/index.html`](public/index.html)** — Original single-user audit UI (kept for parity).

## Notable conventions

- Photos are gitignored (`samples/`, `uploads/`); database is gitignored (`data/`).
- Tests are runnable Node scripts in `scripts/`; no test framework yet.
- API model is locked to `claude-opus-4-7`; no fallback to weaker models when overloaded — we queue and retry instead.
- Planner sync is currently a stub that logs intended tasks; the real Graph integration is designed but not implemented (see `docs/planner-design.md`).
