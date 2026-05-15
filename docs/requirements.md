# Spare Fleet Key Audit — Requirements

**Doc owner:** Leigh Buckens
**Status:** Draft for review
**Last updated:** 2026-05-15
**Reviewers needed:** Fleet/Ops lead, IT/Admin (for Entra/Azure), one Hub Manager (for field flow sanity check)
**Companion docs:** [sso-design.md](sso-design.md), [planner-design.md](planner-design.md), [azure-deployment.md](azure-deployment.md)

> This is a working draft. Sections marked **OPEN** require a decision before implementation can proceed in that area. Mark up freely.

---

## 1. Purpose

The Spare Fleet Key Audit app turns a manual, error-prone process — counting and reconciling spare vehicle keys at each hub — into a phone-snap-and-submit workflow.

A hub manager photographs the spare-key box; the app reads the vehicle numbers on the tags via OCR; a central fleet-ops team reviews the results and reconciles them against the expected roster for that hub; reconciliation outputs are pushed to Microsoft Planner as actionable tasks (move key X from Hub A to Hub B, locate missing key Y, remove offboarded key Z).

**Why this exists:** Manual audits are slow, easy to skip, and produce results that aren't actionable without a separate write-up. Spare keys are a security and operations concern — a missing or misplaced key may indicate a process failure that needs to be addressed quickly.

**What success looks like:**
- Every hub completes its monthly audit on time, with negligible manager effort (under 2 minutes of field time per audit).
- Each completed audit produces concrete movement/locate/remove tasks in Planner with named owners.
- Central fleet ops can answer "where are all the keys right now?" from a single dashboard.

---

## 2. Users & Roles

### 2.1 Field Staff (Hub Managers)

- **Who:** Manager (or designated audit owner) at each hub location.
- **Count:** ~15 today, one per hub.
- **Device:** Personal or work mobile phone (iOS or Android) on cellular or hub wifi.
- **Frequency:** 1–2 audits per month.
- **What they do:** Open a link, log in via M365 SSO, pick their hub, snap a photo of the open spare-key box, optionally add a note, hit submit. Done.
- **What they do NOT do:** Interpret OCR output, edit chips, or reconcile against the roster. Those are central-team concerns.

### 2.2 Central Processing Team (Fleet Ops)

- **Who:** Existing fleet/operations group at TNS.
- **Count:** Small team (2–3 people anticipated).
- **Device:** Desktop or tablet, in the office.
- **What they do:** Review each field submission in a queue. Inspect the photo and the auto-generated OCR output, edit/correct chips as needed, click Finalize. The finalize action produces the four-bucket reconciliation (belongs here / belongs elsewhere / offboarded / missing) and creates Planner tasks for any movement/missing/remove actions.
- **What they do NOT do:** Submit photos themselves (unless covering for a missing hub manager). They are processors, not capturers.

### 2.3 Read-only Stakeholders

- **Who:** Hub managers viewing history for *their own* hub; leadership viewing aggregate stats.
- **What they can see:** Finalized audit records for their hub (or all hubs, for leadership). Cannot edit.

---

## 3. User Flows

### 3.1 Field Submission Flow

1. Hub manager taps a bookmarked link (`https://keyaudit.thenextstreet.com` or similar) on their phone.
2. Redirected to Microsoft sign-in; authenticates with their @thenextstreet.com account.
3. Lands on a single screen showing:
   - Their name (auto-populated from SSO).
   - A hub picker (defaulted to their assigned hub if we can map it; otherwise dropdown).
   - A large "Take photo" button.
   - An optional note field ("missing 174 — left in vehicle at customer site").
   - A "Submit" button.
4. Tap "Take photo" → phone offers camera or gallery (no `capture=environment` restriction).
5. Confirm photo, optionally add note.
6. Submit → server-side confirmation: "Audit #1234 received for CT-Fairfield. Fleet ops will follow up. Estimated completion: within 1 business day."
7. Optionally: link to view this submission and (later) the finalized result.

**Time target:** under 2 minutes from opening the link to submission confirmation.

### 3.2 Central Review Flow

1. Fleet-ops user opens the desktop app (same URL, different role detected via Entra group membership).
2. Lands on the **Inbox**: a list of pending submissions, sorted oldest first, showing thumbnail + hub + submitter + timestamp + note.
3. Click a submission → opens the **Review view**:
   - Full-size photo (the rotated version, but with toggle to see original).
   - Auto-generated OCR chip list (generated on submit or on first review-view open).
   - Chip-editing UX: remove false positives, add missed numbers, mark uncertain as confirmed.
   - "Auto-detected count" vs "Final count" indicator.
   - Side panel showing the expected roster for this hub for cross-reference.
4. Click **Finalize** → server runs reconciliation against the expected roster, produces four buckets, generates action items, and pushes Planner tasks. Submission status moves from `in_review` to `finalized`.
5. Or click **Request Retake** → submission status moves to `rejected_for_retake`, notifies the original submitter (Teams / email) with a reason.

### 3.3 Cross-Hub Action Board

- Aggregated view across all `finalized` audits, showing all open action items.
- Grouped by:
  - **Movements** — keys present at one hub but assigned to another. Groupable by destination hub.
  - **Missing** — keys assigned to a hub but not present in the most recent audit.
  - **Offboarded** — keys present in a hub box that should no longer be in service.
- Each item shows: vehicle number, source hub, destination hub (for movements), last-known address, link to the source audit.
- Items close automatically when a subsequent audit at the relevant hub confirms resolution (e.g., "missing 174 at Fairfield" closes when 174 is found at Wallingford in their next audit). **OPEN: confirm this auto-close behavior is desired vs. manual close.**

### 3.4 Read-only History Access

- Hub managers can view past finalized audits for their own hub: a list view, click for details, photo + reconciliation result.
- Used to build trust ("yes, my last submission was acted on") and to provide context ("we've had key 283 missing for 2 months").

---

## 4. Functional Requirements

### 4.1 Photo Capture & Submission

- **FR-1.1** Field UI must accept photos via both camera capture and gallery selection on iOS Safari and Android Chrome.
- **FR-1.2** Maximum upload size 20 MB (multer cap); client-side downscale not yet specified — **OPEN** whether to add it.
- **FR-1.3** Each submission record stores: photo, hub, submitter (auto from SSO), submission timestamp, optional note, status.
- **FR-1.4** Photo storage must persist independently of the application server (so server restarts/redeploys don't lose data). See §6.3.
- **FR-1.5** Confirmation page must show submission ID and current status.

### 4.2 OCR & Reconciliation

- **FR-2.1** Server auto-rotates portrait images to landscape before OCR (current behavior: rotate 270° CW if `height > width`). **OPEN: confirm this heuristic generalizes across more photos.**
- **FR-2.2** OCR uses Claude Opus 4.7 (`claude-opus-4-7`), 3 parallel passes with prompt variations.
- **FR-2.3** Merge logic: a number is included if ≥2 of 3 passes agreed; numbers seen by all 3 passes are confident, numbers seen by 2 of 3 are flagged uncertain (`?`). Singleton readings are dropped.
- **FR-2.4** Reconciliation: for each confirmed-final chip, classify into one of four buckets relative to the audit's hub:
  - **Belong here** — vehicle is active, roster-assigned to this hub.
  - **Belong elsewhere** — vehicle is active, but assigned to a different hub.
  - **Offboarded / unknown** — vehicle is not in roster, or roster status is `offboard`.
  - **Missing** — vehicle is assigned to this hub but not in the confirmed chip list.
- **FR-2.5** Auto-detected count and final-after-edit count both retained for QA.

### 4.3 Audit Lifecycle / Status Model

Each submission carries an `ocr_state` (managed by the queue / worker). Once OCR is ready, the central reviewer can finalize, which creates an immutable `Audit` record (with reconciliation + action items). Both the OCR state and the review/finalize flow are implemented as of 2026-05-15.

**OCR state machine** (implemented in db.js, see §4.6 for the retry curve):

```
pending ──► processing ──► ready              (happy path; result available)
   ▲              │
   │              └──► failed ──► (after backoff) ──► processing ─┐
   │                                                              │
   └──── retry endpoint, or worker pickup ────────────────────────┘
                  │
                  └──► (6 attempts exhausted) ──► exhausted (manual retry only)
```

**Review state machine** (implemented as of 2026-05-15):

```
ready ──► reviewer opens ──► (edits chips) ──► finalize ──► finalized (Audit row created)
                                  │
                                  └── (planned) request retake ──► rejected_for_retake
```

Finalize is idempotent at the submission level: a second finalize attempt on the same submission returns 409. The Audit row links one-to-one to its source Submission. "Request retake" is not yet implemented; reviewers can ask the field user to submit again as a workaround.

- **FR-3.1** Submissions are immutable; edits during review live on the *audit* record (one-to-one with submission for v1).
- **FR-3.2** Hub managers can submit multiple times for the same audit period. Each submission is a separate record. Only one is finalized as the canonical audit for that period; others stay as history.
- **FR-3.3** Status transitions are timestamped (`ocr_completed_at` for OCR; finalize/retake timestamps when those are built).
- **FR-3.4** A submission whose OCR is in any non-ready state cannot be finalized.

### 4.4 Action Items & Planner Sync

- **FR-4.1** On finalize, the server generates one Planner task per non-trivial bucket entry:
  - For each "belongs elsewhere" key: task "Move key #N from Hub A → Hub B"
  - For each "missing" key: task "Locate missing key #N (assigned to Hub A)"
  - For each "offboarded" key: task "Remove offboarded key #N from Hub A spare box"
- **FR-4.2** Each task includes a deep-link back to the source audit and is assigned to a default owner (**OPEN: who is the default owner?**).
- **FR-4.3** Tasks are created in a single Planner plan; **OPEN: structure (buckets per hub vs. buckets per action type)**.
- **FR-4.4** Auto-close: if a later audit at the destination hub confirms the key has arrived, the corresponding "move" task closes. **OPEN: confirm desired.**

### 4.5 Roster Management

- **FR-5.1** Roster source-of-truth is OneStep GPS, refreshed manually via the existing "Refresh from OneStep GPS" button (now fixed). **OPEN: scheduled auto-refresh?**
- **FR-5.2** Reconciliation always uses the roster as of the time of *audit finalization*, not the time of submission. Store the snapshot used on each finalized audit for repeatability.
- **FR-5.3** Manual roster overrides (e.g., a key reassigned outside of OneStep) — **OPEN: needed for v1, or wait?**

### 4.6 OCR Job Queue & Retry Behavior

OCR runs asynchronously after submission. The field user never waits for OCR to complete; they get an immediate confirmation and walk away.

- **FR-6.1** `POST /api/submissions` persists the photo + metadata and returns within 1 second with `{id, state: "pending"}`. OCR has not yet run at that point.
- **FR-6.2** A background worker (in-process, single-concurrency) polls every 30 seconds, claims the oldest eligible submission, and runs the OCR pipeline. The worker's first tick fires on server startup (so submissions queued during downtime are processed immediately on restart).
- **FR-6.3** On Anthropic API failure (529 overloaded, network error, etc.), the submission moves to `failed` with the next retry scheduled per the backoff curve below. No fallback to a weaker model — always Opus 4.7.
- **FR-6.4** **Backoff curve** (cumulative wall-clock from first failure): 1 min → 5 min → 30 min → 2 hr → 6 hr → 24 hr.
- **FR-6.5** After 6 failed attempts (total elapsed ≈ 33 hr), the submission transitions to `exhausted`. An admin alert must fire (see §10 Q22) and the row requires a manual retry via the inbox or the `POST /api/submissions/:id/retry` endpoint.
- **FR-6.6** Manual retry (any state in `{failed, exhausted}`) resets the submission to `pending` for immediate re-pickup by the worker. Attempt count is preserved for telemetry.

---

## 5. Non-Functional Requirements

### 5.1 Performance

- **Field flow** (synchronous): photo upload and submission confirmation in under 10 seconds on cellular. The user does **not** wait for OCR — they get a "received" confirmation immediately.
- **OCR processing** (async): typical end-to-end ≈ 10–30 seconds from submission to `ready` under normal API load. On 529 / throttling, processing may be delayed by up to 33 hours before exhaustion; admin alert fires after 24 hours of accumulated retries.
- **Central inbox**: full page render under 2 seconds; auto-refresh polls every 10 seconds.
- **Page load** under 3 seconds on a typical phone over hub wifi.

### 5.2 OCR Accuracy

Validated on **2 photos** through 6 successful runs as of 2026-05-14 (recall computed against high-confidence ground truth confirmed with Leigh):

| Photo | Tags in GT | Tags detected | False positives | Consistency across 3 runs |
|---|---|---|---|---|
| Photo 1 | 15 | 15 (100%) | 0 | identical output |
| Photo 2 | 12 | 12 (100%) | 0 | identical output |

- **Recall target:** ≥95% of legitimate TNS-branded tag numbers detected per audit. Achieved 100% on the two validation photos.
- **False positive target:** ≤1 unflagged hallucination per audit. Achieved 0 on both validation photos.
- **Consistency target:** identical output across re-runs of the same photo. Achieved 6/6 runs (3 per photo).
- **Out of scope:** detecting tags that aren't TNS-branded (handwritten generic labels, slot/hanger tags, fuel-card numbers) — these are intentionally excluded by the OCR prompt (see [[project-valid-tag-signals]]).
- **Generalization risk:** validated on only 2 photos. Recall and false-positive numbers may shift on different lighting, hub layouts, or denser boxes. See task #18.

### 5.3 Availability

- 99% during business hours (M–F 7am–7pm ET).
- Off-hours outages acceptable; field staff aren't doing audits at 3am.
- Submitted-but-unprocessed queue must survive server restarts (durable storage).

### 5.4 Audit Trail / Immutability

- Every submission is permanent — never deleted, only superseded.
- Every status change is logged with timestamp and acting user.
- Photos are retained for at least 2 years for compliance/security purposes. **OPEN: confirm retention policy with legal/compliance.**
- Roster snapshots stored with each finalized audit (see FR-5.2).

### 5.5 Security

- All access gated by Microsoft SSO; tenant-restricted to thenextstreet.com.
- Role separation: hub managers can submit + view their own hub's history; fleet-ops team has review/finalize/action-board access.
- No anonymous access. No shared accounts.
- API keys (Anthropic, OneStep, Graph) stored as Azure App Service config or Key Vault, never in source.

---

## 6. Data Model

### 6.1 Entities

**Implemented in v1 (see `db.js`):**

- **`Submission`** — the field upload, the OCR job, and (later) the audit basis. One row per upload.

  | Column | Type | Notes |
  |---|---|---|
  | `id` | TEXT PK | `subm_` + 12 random hex chars |
  | `photo_path` | TEXT | filename inside `uploads/` (server-resolves to absolute) |
  | `hub` | TEXT | e.g. `"CT - Fairfield"` |
  | `submitter_name` | TEXT | manual entry today; auto from SSO later |
  | `note` | TEXT NULLABLE | optional free-text note |
  | `created_at` | TEXT (ISO) | submission timestamp |
  | `ocr_state` | TEXT | `pending` / `processing` / `ready` / `failed` / `exhausted` |
  | `ocr_attempts` | INTEGER | count of OCR attempts (caps at 6) |
  | `ocr_last_error` | TEXT NULLABLE | last error message (truncated to 500 chars) |
  | `ocr_next_retry_at` | TEXT (ISO) NULLABLE | when worker should re-attempt this failed row |
  | `ocr_result` | TEXT (JSON) NULLABLE | `{ numbers, expectedCount, rotation, passDetails }` |
  | `ocr_completed_at` | TEXT (ISO) NULLABLE | when `ready` was reached |

**Implemented as of 2026-05-15 (see `db.js`):**

- **`Audit`** — finalized output, one row per finalized submission.

  | Column | Type | Notes |
  |---|---|---|
  | `id` | TEXT PK | `aud_` + 12 random hex chars |
  | `submission_id` | TEXT UNIQUE FK | enforces one Audit per Submission |
  | `hub` | TEXT | denormalized for query speed |
  | `final_chip_list` | TEXT (JSON) | reviewer-edited chip list |
  | `reconciliation` | TEXT (JSON) | `{belongHere, belongElsewhere, offboarded, missing}` |
  | `finalized_by_name` | TEXT | manual today; from SSO later |
  | `finalized_at` | TEXT (ISO) | |
  | `roster_snapshot` | TEXT (JSON) | the roster array used at finalize time, for repeatability |

- **`ActionItem`** — denormalized for the cross-hub board, one row per action implied by the reconciliation.

  | Column | Type | Notes |
  |---|---|---|
  | `id` | TEXT PK | `act_` + 12 random hex chars |
  | `audit_id` | TEXT FK | |
  | `action_type` | TEXT | `move` / `locate` / `remove` |
  | `vehicle_number` | TEXT | |
  | `source_hub` | TEXT | hub where the item is / should be |
  | `destination_hub` | TEXT NULLABLE | only for `move` |
  | `status` | TEXT | `open` / `closed` |
  | `planner_task_id` | TEXT NULLABLE | populated when Planner sync is real (currently stubbed) |
  | `created_at`, `closed_at`, `closed_by_audit_id` | timestamps + back-reference |

**Planned for v2 (not yet built):**

- **`Vehicle`** — roster record (currently lives in `vehicle_roster.csv`; will migrate to DB). Fields: vehicle_number, assigned_location, current_address, status (active/offboard), as_of_timestamp.
- **`Hub`** — derived list. Fields: code, state, sort_order.
- **`User`** — projection of Entra user info, cached locally. Fields: entra_oid, email, name, role, default_hub.

### 6.2 Audit Lifecycle

See §4.3. OCR states are implemented; review states are planned.

### 6.3 Storage

- **Application data**: **SQLite** in `data/app.db` (WAL mode, FK enforcement). Single-process, file-on-disk. Decision rationale: at 15–30 audits/month volume, no need for Postgres or multi-instance scaling; SQLite-on-volume is simpler operationally and the project's existing flat-file pattern (CSV roster, JSON audit log) suggested low ceremony. Closes original Q14.
- **Photos**: filesystem in `uploads/` folder for v1 (gitignored). Production deployment must mount this on persistent storage on the host (Azure App Service mounted disk, or upgrade to SharePoint document library as originally planned). **OPEN: when do we migrate from local disk → SharePoint?**
- **Secrets**: `.env` file in dev; Azure Key Vault or App Service config in production.

---

## 7. Integrations

### 7.1 Anthropic API (OCR)

- Model: `claude-opus-4-7` for **all** OCR passes. **No fallback to weaker models** — if Opus is unavailable, we queue and retry rather than degrade accuracy (see §4.6).
- 3 parallel passes per audit, prompted with explicit valid-tag-vs-noise rules (see [[project-valid-tag-signals]]).
- Consensus merge: ≥2 of 3 passes required for inclusion; partial agreement flagged with `?`; singletons dropped.
- Cost at projected volume (30/mo × 3 passes Opus): **~$47/year**.
- API key in `.env` (dev) / Azure Key Vault (prod).

### 7.2 OneStep GPS (Roster Source)

- Endpoint: `https://track.onestepgps.com/v3/api/public/device` (paginated).
- Reverse geocoding via OpenStreetMap Nominatim (1 req/sec rate limit; cache results keyed by lat/lng to avoid re-geocoding unchanged vehicles).
- Trigger: manual button today; auto-refresh on a schedule **OPEN**.

### 7.3 Microsoft 365: Entra ID (SSO)

- App registered in TNS Entra tenant.
- OAuth 2.0 / OIDC flow via Microsoft Authentication Library (MSAL) for Node.
- Tenant-restricted: only thenextstreet.com accounts allowed.
- Roles enforced via Entra group membership:
  - `KeyAudit-FleetOps` group → fleet-ops role (central review/finalize/action board access).
  - All other authenticated users → hub-manager role (submit + view own hub's history).
  - **OPEN: leadership/read-only-all-hubs group?**

### 7.4 Microsoft 365: Planner (via Graph API)

- One Planner plan named "Spare Key Movements" (or similar).
- Buckets: **OPEN — one bucket per hub, or one bucket per action type (Move / Locate / Remove)?**
- Each task includes a back-link to the source audit and a structured description (vehicle number, hubs involved, date).
- Default assignment: **OPEN: a service account, a rotating fleet-ops member, or no default assignment (manual)?**
- Graph API auth via service principal with `Tasks.ReadWrite.All` and `Group.ReadWrite.All` (or narrower if a single group is sufficient).

### 7.5 Microsoft 365: SharePoint (Photo Storage)

- Document library named "KeyAuditPhotos" (or similar) on a TNS site.
- Photos uploaded by the app on submission; metadata (hub, submitter, timestamp) captured as columns.
- Application server pre-signs / deep-links to photos for display.
- **OPEN: retention policy enforcement via SharePoint retention labels vs. application logic.**

---

## 8. Architecture & Hosting

- **Hosting:** Azure App Service (Linux, Node 22 LTS).
- **Why Azure (not Render/Railway/Vercel):** tight integration with M365 — same tenancy for SSO, Planner, SharePoint, Key Vault; TNS likely already has an Azure presence with established billing/security; auth flow is much simpler with the identity provider colocated.
- **Domain:** subdomain of thenextstreet.com (e.g., `keyaudit.thenextstreet.com`), CNAME'd to the App Service. **OPEN: confirm with IT.**
- **CI/CD:** GitHub Actions → Azure App Service deployment.
- **Environments:** at minimum a `prod` slot; ideally also a `staging` slot for testing changes before promoting.
- **Persistent storage:** App Service mounted disk for SQLite + SharePoint for photos.

---

## 9. Security & Privacy

- **Authentication:** Microsoft SSO; tenant-restricted.
- **Authorization:** role-based via Entra groups (see §7.3).
- **Data classification:** Audit photos and roster data are internal-only. Vehicle numbers + locations are non-personal but operationally sensitive. **OPEN: confirm with security/compliance.**
- **PII in photos:** photos may incidentally capture employee names handwritten on tags, the interior of an office, or personal items. Retention and access should reflect this; treat photos as internal-only.
- **Secrets:** in Key Vault, rotated annually.
- **Audit logging:** all status transitions logged with user + timestamp (already required for audit trail; reused for security).

---

## 10. Open Questions (consolidated)

Track and resolve before / during build. Each should have an owner.

| # | Question | Suggested owner |
|---|---|---|
| Q1 | Should the orientation heuristic be validated against a wider photo set before lock-in? | Engineering / Leigh |
| Q2 | Auto-detect hub from M365 user profile, or always pick from dropdown? | Fleet Ops |
| Q3 | Default assignee for Planner tasks (service acct / rotating / unassigned)? | Fleet Ops |
| Q4 | Planner plan structure: buckets per hub vs. per action type? | Fleet Ops |
| Q5 | Auto-close Planner tasks when subsequent audit confirms? | Fleet Ops |
| Q6 | Notification flow when a submission lands in the inbox? (Teams ping, email digest, none) | Fleet Ops |
| Q7 | Service-level expectation for review turnaround (1 business day? 3?) | Fleet Ops |
| Q8 | Notification flow when a submission is rejected for retake? | Fleet Ops |
| Q9 | Read-only "all hubs" view — who gets this access? | Leadership |
| Q10 | Photo retention period (2 years? 5? Indefinite?) | Legal / Compliance |
| Q11 | Manual roster overrides supported in v1, or out of scope? | Fleet Ops |
| Q12 | Scheduled auto-refresh of OneStep GPS roster (daily? weekly? manual only?) | Fleet Ops |
| Q13 | Confirm `keyaudit.thenextstreet.com` subdomain availability and CNAME setup | IT |
| ~~Q14~~ | ~~Storage: SQLite-on-volume vs SharePoint list vs Postgres?~~ | **DECIDED 2026-05-14**: SQLite-on-volume for v1 (see §6.3) |
| ~~Q15~~ | ~~Staging environment required for v1?~~ | **DECIDED 2026-05-15**: yes (staging slot + smoke test gate before swap to prod). See [azure-deployment.md](azure-deployment.md) |
| Q16 | OCR accuracy target: lock at 95% recall, or revise after more photo validation? | Leigh / Fleet Ops |
| Q17 | When do photos migrate from local disk → SharePoint document library? | Engineering / IT |
| Q18 | Admin-alert mechanism when an OCR job hits `exhausted` (email, Teams DM, dashboard banner)? | Fleet Ops / IT |
| Q19 | Should the inbox be paginated or filtered by default? At what backlog size does a flat list stop being usable? | Fleet Ops |
| ~~Q20~~ | ~~Worker concurrency: stay single-process, or move to a real job queue?~~ | **DECIDED 2026-05-15 (AZ5)**: in-process for v1; revisit only on multi-instance scaling. See [azure-deployment.md](azure-deployment.md) |

---

## 11. Out of Scope (v1)

These were considered and explicitly deferred. Re-raise in v2 if needed.

- Native mobile app (iOS/Android). Web app on phone is sufficient.
- Offline submission (queued locally, synced when network returns).
- Voice notes or video.
- Reading non-vehicle tags (e.g., spare house keys, generic identifiers).
- Automatic key-box-tampering detection from photos.
- Two-factor / hardware-key authentication beyond what M365 enforces.
- Multi-tenant support (only TNS).
- Integrations beyond Planner (e.g., Slack, ServiceNow, Zendesk).
- Internationalization / localization.
- Bulk-export of all photos.

---

## 12. Acceptance Criteria

A v1 release is shippable when:

**OCR + submission flow:**
- [x] **OCR pipeline returns identical, accurate results across re-runs** of the same photo (validated 2026-05-14 on 2 photos, 2026-05-15 on a 3rd photo, 3 runs each).
- [x] **OCR pipeline achieves ≥95% recall on a validation set of ≥3 photos with varied conditions** (100% on 3 photos across portrait+rotated, portrait+noise-mixed, and landscape conditions; recommend more photos but no longer a blocker).
- [x] **`POST /api/submissions` returns within 1 second**; OCR completes asynchronously.
- [x] **OCR backoff and exhaustion behavior validated** (see `scripts/test-retry-flow.js`).
- [x] **Submission and worker state survive a server restart** — SQLite + on-disk uploads persist; worker re-picks pending rows on boot.

**Field flow:**
- [x] **Field user can submit a photo end-to-end** via `/submit` — local-dev verified; mobile-network field test pending pilot.

**Central flow:**
- [x] **Central reviewer can finalize an audit** via `/inbox` review pane: edit chips → click Finalize → reconciliation + action items persisted (see `scripts/test-finalize-flow.js`).
- [ ] **Finalizing an audit auto-generates correctly-scoped Planner tasks** — currently stubbed to log-only (see `plannerSyncStub`); real Graph integration designed in [planner-design.md](planner-design.md) but not yet implemented (needs credentials).

**Platform / pilot:**
- [ ] SSO works for both field and central roles; correct role-based access verified — designed in [sso-design.md](sso-design.md) but not yet implemented.
- [x] Roster refresh from OneStep GPS completes successfully end-to-end (the now-fixed code path).
- [ ] At least one pilot hub (one manager, one fleet ops reviewer) has run the full flow with real photos over a 2-week period without showstopper issues — gated on Azure deployment ([azure-deployment.md](azure-deployment.md)).

---

## 13. Glossary

- **Audit** — a finalized record of which keys were present in a hub's spare-key box at a point in time, with reconciliation against the expected roster.
- **Bucket** — one of the four categorizations of a key in an audit result: belongs here, belongs elsewhere, offboarded/unknown, missing.
- **Central Team / Fleet Ops** — the small team that reviews field submissions, edits OCR output, and finalizes audits.
- **Chip** — a single OCR-detected vehicle number, shown as a removable pill in the review UI.
- **Entra ID** — Microsoft's identity provider (formerly Azure Active Directory). Source of SSO.
- **Field Staff / Hub Manager** — the person at a hub who takes the audit photo.
- **Finalize** — the central-team action that turns a draft submission into a canonical audit record and generates Planner tasks.
- **Graph API** — Microsoft's unified API surface for M365 services (Planner, SharePoint, Users, etc.).
- **Hub** — a TNS driving-school location where vehicles and spare keys are kept.
- **OCR** — optical character recognition; here, reading vehicle numbers off photographed key tags via Claude vision.
- **OneStep GPS** — the GPS tracking provider that owns the authoritative vehicle roster.
- **Planner** — Microsoft's task-tracking tool, part of M365. The destination for action items.
- **Roster** — the list of all active vehicles with their assigned hub.
- **Submission** — an immutable record of a single field upload (photo + metadata). Becomes the input to one Audit.

---

*End of draft. Mark up anywhere; we can iterate.*
