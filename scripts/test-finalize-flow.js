// Exercises the finalize → reconciliation → action-items flow without hitting Anthropic.
// 1. Inserts a fake submission with a known OCR result already attached
//    (skips the real OCR by using markReady directly)
// 2. Calls reconcile() directly to verify bucket logic
// 3. POSTs to /api/submissions/:id/finalize and verifies the audit + action items
// 4. Verifies a second finalize attempt is rejected

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const db = require("./../db");
const { reconcile } = require("./../reconciliation");

const sqlite = new Database(path.join(__dirname, "..", "data", "app.db"));

function expect(label, ok, detail) {
  console.log(`${ok ? "✅" : "❌"} ${label}${detail ? ": " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // ---- Setup: minimal roster fixture and a submission with a pre-baked OCR result ----
  const roster = [
    { vehicle_number: "201", assigned_location: "CT - Fairfield", current_address: "addr-201", status: "active" },
    { vehicle_number: "202", assigned_location: "CT - Fairfield", current_address: "addr-202", status: "active" },
    { vehicle_number: "203", assigned_location: "CT - Wallingford", current_address: "addr-203", status: "active" },
    { vehicle_number: "204", assigned_location: "CT - Fairfield", current_address: "addr-204", status: "offboard" },
  ];

  // 1. Direct unit test of reconcile()
  const chipList = ["201", "203", "204", "999"]; // Fairfield reviewer reports these
  const { buckets, actionItems } = reconcile(chipList, "CT - Fairfield", roster);

  expect("belongHere has 201",
    buckets.belongHere.length === 1 && buckets.belongHere[0].vehicle_number === "201");
  expect("belongElsewhere has 203",
    buckets.belongElsewhere.length === 1 && buckets.belongElsewhere[0].vehicle_number === "203");
  expect("offboarded has 204 (offboarded vehicle) and 999 (not in roster)",
    buckets.offboarded.length === 2);
  expect("missing has 202 (assigned to Fairfield but not in chip list)",
    buckets.missing.length === 1 && buckets.missing[0].vehicle_number === "202");
  expect("action items: 1 move (203), 1 locate (202), 2 remove (204, 999)",
    actionItems.filter(a => a.actionType === "move").length === 1
    && actionItems.filter(a => a.actionType === "locate").length === 1
    && actionItems.filter(a => a.actionType === "remove").length === 2);

  // 2. End-to-end through the HTTP layer
  const submission = db.insertSubmission({
    photoPath: "__fixture__.jpg",
    hub: "CT - Fairfield",
    submitterName: "test-finalize",
    note: "automated finalize-flow test",
  });
  // Pretend the worker has already processed it.
  db.markReady(submission.id, { numbers: chipList, expectedCount: chipList.length, rotation: 0, passDetails: [] });

  // Reviewer hits finalize.
  const resp = await fetch(`http://localhost:3000/api/submissions/${submission.id}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chip_list: chipList,
      finalized_by_name: "test-reviewer",
    }),
  });
  const body = await resp.json();
  expect("finalize endpoint returns 200", resp.status === 200, `status ${resp.status} body ${JSON.stringify(body).slice(0, 200)}`);
  expect("finalize returns audit + action items", body.audit && body.actionItems);

  // Reject a second finalize attempt.
  const second = await fetch(`http://localhost:3000/api/submissions/${submission.id}/finalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chip_list: chipList, finalized_by_name: "test-reviewer" }),
  });
  expect("second finalize rejected with 409", second.status === 409);

  // GET /api/audits/:id
  const auditGet = await fetch(`http://localhost:3000/api/audits/${body.audit.id}`).then(r => r.json());
  expect("audit fetchable by ID", auditGet.id === body.audit.id);

  // GET /api/action-items?audit_id=...
  const ai = await fetch(`http://localhost:3000/api/action-items?audit_id=${body.audit.id}`).then(r => r.json());
  expect("action-items endpoint returns rows for this audit", ai.length === body.actionItems.length);

  // ---- Cleanup ----
  sqlite.prepare("DELETE FROM action_items WHERE audit_id IN (SELECT id FROM audits WHERE submission_id = ?)").run(submission.id);
  sqlite.prepare("DELETE FROM audits WHERE submission_id = ?").run(submission.id);
  sqlite.prepare("DELETE FROM submissions WHERE id = ?").run(submission.id);
  console.log("\nCleaned up test rows.");

  sqlite.close();
}

main().catch(err => { console.error(err); process.exit(1); });
