// Exercises the failure → backoff → exhausted lifecycle in db.js without hitting Anthropic.
// Inserts a fake submission, then loops: claim → simulate fail → manually fast-forward retry_at
// → repeat, until the row transitions to 'exhausted'.

const Database = require("better-sqlite3");
const path = require("path");
const db = require("./../db");

const sqlite = new Database(path.join(__dirname, "..", "data", "app.db"));

// 1. Insert a fake submission (we don't need a real photo for this test).
const sub = db.insertSubmission({
  photoPath: "__test__.jpg",
  hub: "TEST",
  submitterName: "retry-test",
  note: "automated retry-flow test",
});
console.log(`Inserted: ${sub.id} state=${sub.ocr_state}`);

let attempt = 0;
while (true) {
  attempt++;

  // Make this row eligible: pending or (failed AND retry_at <= now).
  // First iteration: it's already pending. Subsequent: fast-forward retry_at.
  sqlite.prepare("UPDATE submissions SET ocr_next_retry_at = ? WHERE id = ?")
    .run(new Date(Date.now() - 1000).toISOString(), sub.id);

  const claimed = db.claimNextForProcessing();
  if (!claimed || claimed.id !== sub.id) {
    console.log(`No row claimed on attempt ${attempt} — terminating loop`);
    break;
  }
  console.log(`Attempt ${attempt}: claimed; attempts_in_db=${claimed.ocr_attempts}, state=${claimed.ocr_state}`);

  db.markFailed(sub.id, `simulated failure on attempt ${attempt}`);
  const after = db.getSubmission(sub.id);
  console.log(`         after markFailed: state=${after.ocr_state}, attempts=${after.ocr_attempts}, next_retry=${after.ocr_next_retry_at}`);

  if (after.ocr_state === "exhausted") {
    console.log(`\nReached exhausted state after ${attempt} attempts. Last error: "${after.ocr_last_error}"`);
    break;
  }

  if (attempt > 10) {
    console.log("Safety: stopping at 10 attempts to avoid runaway");
    break;
  }
}

// Verify retry endpoint resets state.
const beforeRetry = db.getSubmission(sub.id);
console.log(`\nBefore manual retry: state=${beforeRetry.ocr_state}`);
const afterRetry = db.requestRetry(sub.id);
console.log(`After requestRetry:  state=${afterRetry.ocr_state}, attempts=${afterRetry.ocr_attempts}`);

// Cleanup: delete the test submission so it doesn't clutter the inbox.
sqlite.prepare("DELETE FROM submissions WHERE id = ?").run(sub.id);
console.log(`\nCleaned up test row ${sub.id}`);

sqlite.close();
