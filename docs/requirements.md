# Spare Fleet Key Audit — Requirements

**Doc owner:** Leigh Buckens
**Status:** Draft for review
**Last updated:** 2026-05-14
**Reviewers needed:** Fleet/Ops lead, IT/Admin (for Entra/Azure), one Hub Manager (for field flow sanity check)

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

```
submitted ── reviewer opens ──► in_review ── finalize ──► finalized
     │                              │
     │                              └── request retake ──► rejected_for_retake
     │
     └── (no review action in N days) ──► stale (alert fleet ops)
```

- **FR-3.1** Submissions are immutable; edits during review live on the *audit* record (one-to-one with submission for v1).
- **FR-3.2** Hub managers can submit multiple times for the same audit period. Each submission is a separate record. Only one is finalized as the canonical audit for that period; others stay as history.
- **FR-3.3** Status transitions are timestamped and logged.

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

---

## 5. Non-Functional Requirements

### 5.1 Performance

- Field flow: photo upload and submission confirmation in under 10 seconds on cellular.
- Central flow: OCR results visible within 30 seconds of opening a submission in review (whether generated on submit or on first review).
- Page load under 3 seconds on a typical phone over hub wifi.

### 5.2 OCR Accuracy

- **Recall target:** ≥95% of clearly visible vehicle numbers detected per audit. Current measurement: ~98% on one test photo (n=3 runs). Needs validation across 3–5 photos before locking the target.
- **False positive target:** ≤1 unflagged hallucination per audit. Uncertain (`?`) hallucinations acceptable but must be visually distinct in the UI.
- **Consistency:** ≥90% of detected numbers should be stable across re-runs of the same photo.
- **Out of scope:** detecting tags that are physically illegible (handwriting too faded, tag flipped) — human judgment fills these gaps.

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

- **`Submission`** — raw field upload. Fields: id, hub_id, submitter_user_id, photo_blob_ref, note, status, created_at, status_updated_at.
- **`Audit`** — finalized output. Fields: id, submission_id (FK), final_chip_list (JSON), reconciliation (4 buckets), roster_snapshot_ref, finalized_by_user_id, finalized_at.
- **`ActionItem`** — denormalized for the cross-hub board. Fields: id, audit_id (FK), action_type (move/locate/remove), vehicle_number, source_hub, destination_hub (nullable), planner_task_id, status (open/closed), closed_by_audit_id (nullable).
- **`Vehicle`** — roster record. Fields: vehicle_number, assigned_location, current_address, status (active/offboard), as_of_timestamp.
- **`Hub`** — derived list. Fields: code (e.g., "CT - Fairfield"), state, sort_order.
- **`User`** — projection of Entra user info, cached locally. Fields: entra_oid, email, name, role (hub_manager / fleet_ops / leadership), default_hub (nullable).

### 6.2 Audit Lifecycle

See §4.3 diagram. Statuses: `submitted` → `in_review` → `finalized` | `rejected_for_retake` | `stale`.

### 6.3 Storage

- **Application data** (submissions, audits, action items, roster snapshots): SQLite file mounted on durable Azure App Service storage, or Postgres if multi-instance scaling is ever needed (unlikely at this volume). **OPEN: SQLite vs. SharePoint list vs. Postgres.**
- **Photos:** SharePoint document library on the TNS tenant. Access controlled via the same SSO; deep-linkable from the app.
- **Secrets:** Azure Key Vault (preferred) or App Service config.

---

## 7. Integrations

### 7.1 Anthropic API (OCR)

- Model: `claude-opus-4-7` for OCR passes. May revisit if newer Opus released.
- 3 parallel passes per audit (kept for robustness despite cost; cost at this volume is ~$50/year).
- API key in Azure config or Key Vault.

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
| Q14 | Storage: SQLite-on-volume vs SharePoint list vs Postgres? | Engineering / IT |
| Q15 | Staging environment required for v1? | Engineering / Fleet Ops |
| Q16 | OCR accuracy target: lock at 95% recall, or revise after more photo validation? | Leigh / Fleet Ops |

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

- [ ] Field user can submit a photo end-to-end from a phone in under 2 minutes (target: 90 seconds).
- [ ] OCR pipeline (post-fixes) achieves ≥95% recall on a validation set of ≥5 photos with varied conditions.
- [ ] Central reviewer can finalize an audit in under 5 minutes from opening the submission.
- [ ] Finalizing an audit auto-generates correctly-scoped Planner tasks (verified on 3 audits with different bucket distributions).
- [ ] SSO works for both field and central roles; correct role-based access verified.
- [ ] Photo storage persists across app restarts (no data loss in a redeploy test).
- [ ] Roster refresh from OneStep GPS completes successfully end-to-end (the now-fixed code path).
- [ ] At least one pilot hub (one manager, one fleet ops reviewer) has run the full flow with real photos over a 2-week period without showstopper issues.

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
