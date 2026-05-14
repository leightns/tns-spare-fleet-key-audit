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
};
