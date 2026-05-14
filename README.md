# tns-spare-fleet-key-audit

Internal tool for auditing spare vehicle keys at The Next Street hub locations: snap a photo of the spare-key box, OCR the vehicle numbers on the tags, reconcile against the expected hub roster, and surface the misplaced / missing / offboarded keys as action items.

**Status:** in active development. OCR pipeline validated on 2 photos at 100% recall / 0 false positives; async queue + central inbox built; M365 SSO + Planner integration + deployment still ahead.

## Quick start (local dev)

```bash
npm install                          # one-time
echo "ANTHROPIC_API_KEY=sk-ant-..." > .env   # add your key
node server.js                       # boots on :3000
```

- `http://localhost:3000` — original single-user audit UI (synchronous)
- `http://localhost:3000/inbox` — central-team inbox (async submissions)
- `node scripts/test-retry-flow.js` — validate the OCR job backoff curve

## Architecture (today)

- **Field flow:** `POST /api/submissions` accepts a photo + hub + submitter, stores to `uploads/`, returns immediately with a submission ID. OCR runs asynchronously.
- **Background worker:** polls every 30s, claims one pending submission, runs the OCR pipeline (auto-rotate → 3 parallel Opus 4.7 passes → consensus merge), persists result. On Anthropic 529s, backs off (1m → 5m → 30m → 2h → 6h → 24h) for up to 6 attempts before transitioning to `exhausted` for manual retry.
- **Central inbox:** `/inbox` lists submissions with state badges, expandable detail (photo + OCR chips), manual retry button.
- **Persistence:** SQLite at `data/app.db` (submissions + state); photos on disk in `uploads/`; vehicle roster in `vehicle_roster.csv` (refreshable from OneStep GPS API).

## Where to read more

- **[docs/requirements.md](docs/requirements.md)** — full requirements doc: users, flows, data model, M365 integrations, open questions. Read this first for context.
- **[`server.js`](server.js)** — single Express app; all API routes + the OCR pipeline.
- **[`db.js`](db.js)** — SQLite schema + submission state machine helpers.
- **[`public/index.html`](public/index.html)** — original mobile audit UI.
- **[`public/inbox.html`](public/inbox.html)** — central-team inbox.

## Notable conventions

- Photos are gitignored (`samples/`, `uploads/`); database is gitignored (`data/`).
- No tests yet (beyond `scripts/test-retry-flow.js`); manual E2E is the current verification.
- API model is locked to `claude-opus-4-7`; no fallback to weaker models when overloaded — we queue and retry instead.
