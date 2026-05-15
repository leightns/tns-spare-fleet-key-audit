const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "app.db");

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id                  TEXT PRIMARY KEY,
    photo_path          TEXT NOT NULL,
    hub                 TEXT NOT NULL,
    submitter_name      TEXT NOT NULL,
    note                TEXT,
    created_at          TEXT NOT NULL,
    ocr_state           TEXT NOT NULL,
    ocr_attempts        INTEGER NOT NULL DEFAULT 0,
    ocr_last_error      TEXT,
    ocr_next_retry_at   TEXT,
    ocr_result          TEXT,
    ocr_completed_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_state
    ON submissions(ocr_state, ocr_next_retry_at);

  CREATE INDEX IF NOT EXISTS idx_submissions_created
    ON submissions(created_at DESC);

  CREATE TABLE IF NOT EXISTS audits (
    id                  TEXT PRIMARY KEY,
    submission_id       TEXT NOT NULL UNIQUE REFERENCES submissions(id),
    hub                 TEXT NOT NULL,
    final_chip_list     TEXT NOT NULL,
    reconciliation      TEXT NOT NULL,
    finalized_by_name   TEXT NOT NULL,
    finalized_at        TEXT NOT NULL,
    roster_snapshot     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audits_hub
    ON audits(hub, finalized_at DESC);

  CREATE TABLE IF NOT EXISTS action_items (
    id                  TEXT PRIMARY KEY,
    audit_id            TEXT NOT NULL REFERENCES audits(id),
    action_type         TEXT NOT NULL,
    vehicle_number      TEXT NOT NULL,
    source_hub          TEXT NOT NULL,
    destination_hub     TEXT,
    status              TEXT NOT NULL DEFAULT 'open',
    planner_task_id     TEXT,
    created_at          TEXT NOT NULL,
    closed_at           TEXT,
    closed_by_audit_id  TEXT REFERENCES audits(id)
  );

  CREATE INDEX IF NOT EXISTS idx_action_items_status
    ON action_items(status, source_hub);

  CREATE INDEX IF NOT EXISTS idx_action_items_audit
    ON action_items(audit_id);
`);

function newId() {
  return "subm_" + crypto.randomBytes(6).toString("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function insertSubmission({ photoPath, hub, submitterName, note }) {
  const id = newId();
  const stmt = db.prepare(`
    INSERT INTO submissions (id, photo_path, hub, submitter_name, note, created_at, ocr_state)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `);
  stmt.run(id, photoPath, hub, submitterName, note || null, nowIso());
  return getSubmission(id);
}

function getSubmission(id) {
  const row = db.prepare("SELECT * FROM submissions WHERE id = ?").get(id);
  return row ? hydrateRow(row) : null;
}

function listSubmissions({ state } = {}) {
  const sql = state
    ? "SELECT * FROM submissions WHERE ocr_state = ? ORDER BY created_at DESC"
    : "SELECT * FROM submissions ORDER BY created_at DESC";
  const rows = state ? db.prepare(sql).all(state) : db.prepare(sql).all();
  return rows.map(hydrateRow);
}

// Find next submission that's eligible for processing.
function claimNextForProcessing() {
  const txn = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM submissions
      WHERE ocr_state = 'pending'
         OR (ocr_state = 'failed' AND (ocr_next_retry_at IS NULL OR ocr_next_retry_at <= ?))
      ORDER BY created_at ASC
      LIMIT 1
    `).get(nowIso());
    if (!row) return null;
    db.prepare(`
      UPDATE submissions
      SET ocr_state = 'processing', ocr_attempts = ocr_attempts + 1
      WHERE id = ?
    `).run(row.id);
    return getSubmission(row.id);
  });
  return txn();
}

function markReady(id, result) {
  db.prepare(`
    UPDATE submissions
    SET ocr_state = 'ready',
        ocr_result = ?,
        ocr_completed_at = ?,
        ocr_last_error = NULL,
        ocr_next_retry_at = NULL
    WHERE id = ?
  `).run(JSON.stringify(result), nowIso(), id);
}

// Backoff schedule, in seconds, by attempt number (1-indexed).
const BACKOFF_SECONDS = [60, 5 * 60, 30 * 60, 2 * 3600, 6 * 3600, 24 * 3600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

function markFailed(id, errorMessage) {
  const row = db.prepare("SELECT ocr_attempts FROM submissions WHERE id = ?").get(id);
  const attempts = row ? row.ocr_attempts : 0;
  if (attempts >= MAX_ATTEMPTS) {
    db.prepare(`
      UPDATE submissions
      SET ocr_state = 'exhausted',
          ocr_last_error = ?,
          ocr_next_retry_at = NULL
      WHERE id = ?
    `).run(String(errorMessage).slice(0, 500), id);
  } else {
    const delaySec = BACKOFF_SECONDS[Math.min(attempts - 1, BACKOFF_SECONDS.length - 1)];
    const nextAt = new Date(Date.now() + delaySec * 1000).toISOString();
    db.prepare(`
      UPDATE submissions
      SET ocr_state = 'failed',
          ocr_last_error = ?,
          ocr_next_retry_at = ?
      WHERE id = ?
    `).run(String(errorMessage).slice(0, 500), nextAt, id);
  }
}

// Manual retry: bump state back to pending so the worker picks it up immediately.
function requestRetry(id) {
  db.prepare(`
    UPDATE submissions
    SET ocr_state = 'pending',
        ocr_next_retry_at = NULL
    WHERE id = ? AND ocr_state IN ('failed', 'exhausted')
  `).run(id);
  return getSubmission(id);
}

function hydrateRow(row) {
  return {
    ...row,
    ocr_result: row.ocr_result ? JSON.parse(row.ocr_result) : null,
  };
}

// ---- Audits ----

function newAuditId() {
  return "aud_" + crypto.randomBytes(6).toString("hex");
}

function insertAudit({ submissionId, hub, finalChipList, reconciliation, finalizedByName, rosterSnapshot }) {
  const id = newAuditId();
  db.prepare(`
    INSERT INTO audits (id, submission_id, hub, final_chip_list, reconciliation, finalized_by_name, finalized_at, roster_snapshot)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    submissionId,
    hub,
    JSON.stringify(finalChipList),
    JSON.stringify(reconciliation),
    finalizedByName,
    nowIso(),
    JSON.stringify(rosterSnapshot),
  );
  return getAudit(id);
}

function getAudit(id) {
  const row = db.prepare("SELECT * FROM audits WHERE id = ?").get(id);
  return row ? hydrateAudit(row) : null;
}

function getAuditBySubmission(submissionId) {
  const row = db.prepare("SELECT * FROM audits WHERE submission_id = ?").get(submissionId);
  return row ? hydrateAudit(row) : null;
}

function listAudits({ hub } = {}) {
  const rows = hub
    ? db.prepare("SELECT * FROM audits WHERE hub = ? ORDER BY finalized_at DESC").all(hub)
    : db.prepare("SELECT * FROM audits ORDER BY finalized_at DESC").all();
  return rows.map(hydrateAudit);
}

function hydrateAudit(row) {
  return {
    ...row,
    final_chip_list: row.final_chip_list ? JSON.parse(row.final_chip_list) : [],
    reconciliation: row.reconciliation ? JSON.parse(row.reconciliation) : null,
    roster_snapshot: row.roster_snapshot ? JSON.parse(row.roster_snapshot) : null,
  };
}

// ---- Action items ----

function newActionId() {
  return "act_" + crypto.randomBytes(6).toString("hex");
}

function insertActionItem({ auditId, actionType, vehicleNumber, sourceHub, destinationHub, plannerTaskId }) {
  const id = newActionId();
  db.prepare(`
    INSERT INTO action_items (id, audit_id, action_type, vehicle_number, source_hub, destination_hub, status, planner_task_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(id, auditId, actionType, vehicleNumber, sourceHub, destinationHub || null, plannerTaskId || null, nowIso());
  return db.prepare("SELECT * FROM action_items WHERE id = ?").get(id);
}

function listActionItems({ status, sourceHub, auditId } = {}) {
  const where = [];
  const args = [];
  if (status) { where.push("status = ?"); args.push(status); }
  if (sourceHub) { where.push("source_hub = ?"); args.push(sourceHub); }
  if (auditId) { where.push("audit_id = ?"); args.push(auditId); }
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  return db.prepare(`SELECT * FROM action_items ${whereSql} ORDER BY created_at DESC`).all(...args);
}

function closeActionItem(id, closedByAuditId) {
  db.prepare(`
    UPDATE action_items
    SET status = 'closed', closed_at = ?, closed_by_audit_id = ?
    WHERE id = ? AND status = 'open'
  `).run(nowIso(), closedByAuditId || null, id);
}

module.exports = {
  insertSubmission,
  getSubmission,
  listSubmissions,
  claimNextForProcessing,
  markReady,
  markFailed,
  requestRetry,
  MAX_ATTEMPTS,
  BACKOFF_SECONDS,
  insertAudit,
  getAudit,
  getAuditBySubmission,
  listAudits,
  insertActionItem,
  listActionItems,
  closeActionItem,
};
