require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk").default;
const XLSX = require("xlsx");
const submissionsDb = require("./db");
const { runOCR } = require("./ocr");
const { reconcile } = require("./reconciliation");
const fleetAgent = require("./fleet_agent");

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function saveUploadedPhoto(buffer, mimeType) {
  const ext = mimeType === "image/png" ? "png" : "jpg";
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buffer);
  return filename;
}

function photoAbsPath(filename) {
  return path.join(UPLOADS_DIR, filename);
}

// Audit log file
const AUDIT_LOG_PATH = path.join(__dirname, "audit_log.json");
function loadAuditLog() {
  try {
    return JSON.parse(fs.readFileSync(AUDIT_LOG_PATH, "utf-8"));
  } catch { return []; }
}
function saveAuditLog(log) {
  fs.writeFileSync(AUDIT_LOG_PATH, JSON.stringify(log, null, 2));
}

// Load vehicle roster CSV at startup
function loadRoster() {
  const csvPath = path.join(__dirname, "vehicle_roster.csv");
  const raw = fs.readFileSync(csvPath, "utf-8");
  const lines = raw.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim());

  return lines.slice(1).map((line) => {
    // Handle CSV fields that might contain commas in addresses
    const fields = [];
    let current = "";
    let inQuotes = false;
    for (const char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === "," && !inQuotes) {
        fields.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    fields.push(current.trim());

    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = fields[i] || "";
    });
    return obj;
  });
}

let roster = loadRoster();
let locations = fleetAgent.deriveHubs(roster);
console.log(`Loaded ${roster.length} vehicles from roster; ${locations.length} hubs in picker`);
if (locations.length === 0) {
  console.warn("Hub picker is empty. The current vehicle_roster.csv may predate the Location Type column — POST /api/refresh-roster to repopulate from tns-fleet-agent's xlsx.");
}

// Convert GPS xlsx to roster CSV
function convertXlsxToRoster(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const allRows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Find the header row (contains "Device", "Group(s)", etc.)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(allRows.length, 10); i++) {
    const row = allRows[i];
    if (row && row[0] === "Device" && row[1] && row[1].includes("Group")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) throw new Error("Could not find header row with 'Device' and 'Group' columns");

  const vehicles = [];
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row[0] == null) continue;

    const device = String(row[0]);
    const groupStr = row[1] ? String(row[1]) : "";
    const address = row[5] ? String(row[5]) : "";

    let status, assignedLocation;
    if (groupStr === "Offboard" || groupStr === "N/A" || !groupStr) {
      status = "offboard";
      assignedLocation = "";
    } else {
      status = "active";
      const parts = groupStr.split(",").map((p) => p.trim());
      const locationParts = parts.filter((p) => p !== "PEP");
      assignedLocation = locationParts[0] || groupStr;
    }

    vehicles.push({
      vehicle_number: device,
      assigned_location: assignedLocation,
      current_address: address,
      status,
    });
  }

  return vehicles;
}

function saveRosterCsv(vehicles) {
  const csvPath = path.join(__dirname, "vehicle_roster.csv");
  const header = "vehicle_number,assigned_location,current_address,status,location_type,zones,last_updated";
  const q = s => (s || "").includes(",") ? `"${(s || "").replace(/"/g, '""')}"` : (s || "");
  const lines = vehicles.map((v) => [
    v.vehicle_number,
    v.assigned_location || "",
    q(v.current_address),
    v.status || "",
    v.location_type || "",
    q(v.zones),
    v.last_updated || "",
  ].join(","));
  fs.writeFileSync(csvPath, [header, ...lines].join("\n"));
}

// API routes
app.get("/api/locations", (_req, res) => {
  res.json(locations);
});

app.get("/api/roster", (_req, res) => {
  res.json(roster);
});

app.post("/api/analyze", upload.single("photo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No photo uploaded" });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  try {
    const client = new Anthropic({ apiKey });
    const mediaType = req.file.mimetype || "image/jpeg";
    const result = await runOCR(client, req.file.buffer, mediaType);
    res.json(result);
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(500).json({ error: "Failed to analyze image: " + err.message });
  }
});

// Roster upload API
app.post("/api/upload-roster", upload.single("roster"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }
  try {
    const vehicles = convertXlsxToRoster(req.file.buffer);
    saveRosterCsv(vehicles);
    roster = vehicles;
    locations = fleetAgent.deriveHubs(roster);
    const active = vehicles.filter((v) => v.status === "active").length;
    const offboard = vehicles.filter((v) => v.status === "offboard").length;
    console.log(`Roster updated: ${vehicles.length} vehicles (${active} active, ${offboard} offboard)`);
    res.json({
      ok: true,
      total: vehicles.length,
      active,
      offboard,
      locations: locations.length,
    });
  } catch (err) {
    console.error("Roster upload error:", err.message);
    res.status(400).json({ error: "Failed to process file: " + err.message });
  }
});

app.get("/api/roster-info", (_req, res) => {
  const csvPath = path.join(__dirname, "vehicle_roster.csv");
  const stat = fs.statSync(csvPath);
  res.json({
    lastUpdated: stat.mtime.toISOString(),
    total: roster.length,
    active: roster.filter((v) => v.status === "active").length,
    locations: locations.length,
  });
});


// Refresh roster from tns-fleet-agent's nightly xlsx output.
// tns-fleet-agent does the OneStep pull, Nominatim geocoding, and zone-based
// classification (Hub/Kiosk/Home Vehicle/Instructor/Unknown). We just read it.
app.post("/api/refresh-roster", async (_req, res) => {
  try {
    console.log(`Reading enriched roster from ${fleetAgent.xlsxPath()}`);
    const vehicles = fleetAgent.readVehicleRoster();
    saveRosterCsv(vehicles);
    roster = vehicles;
    locations = fleetAgent.deriveHubs(roster);

    const counts = { hub: 0, kiosk: 0, home: 0, instructor: 0, unknown: 0 };
    roster.forEach(v => {
      const t = (v.location_type || "").toLowerCase().replace(" ", "_");
      if (t === "hub") counts.hub++;
      else if (t === "kiosk") counts.kiosk++;
      else if (t === "home_vehicle") counts.home++;
      else if (t === "instructor") counts.instructor++;
      else counts.unknown++;
    });
    const active = roster.filter(v => v.status === "active").length;
    const offboard = roster.filter(v => v.status === "offboard").length;
    console.log(`Roster refreshed: ${roster.length} vehicles (${active} active, ${offboard} offboard); ${counts.hub} Hub, ${counts.kiosk} Kiosk, ${counts.home} Home Vehicle, ${counts.instructor} Instructor, ${counts.unknown} Unknown. Picker hubs: ${locations.length}`);

    res.json({
      ok: true,
      total: roster.length,
      active,
      offboard,
      hubs: locations.length,
      breakdown: counts,
    });
  } catch (err) {
    console.error("Roster refresh error:", err.message);
    res.status(500).json({ error: "Failed to refresh roster: " + err.message });
  }
});

// Audit log API
app.post("/api/audit-log", (req, res) => {
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    ...req.body,
  };
  const log = loadAuditLog();
  log.unshift(entry);
  saveAuditLog(log);
  res.json({ ok: true, id: entry.id });
});

app.get("/api/audit-log", (_req, res) => {
  res.json(loadAuditLog());
});

// ---- Submissions API (field flow: queue-based, OCR happens asynchronously) ----

app.post("/api/submissions", upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

  const hub = (req.body.hub || "").trim();
  const submitterName = (req.body.submitter_name || "").trim();
  const note = (req.body.note || "").trim();

  if (!hub) return res.status(400).json({ error: "hub is required" });
  if (!submitterName) return res.status(400).json({ error: "submitter_name is required" });
  if (hub.length > 80) return res.status(400).json({ error: "hub too long (max 80 chars)" });
  if (submitterName.length > 80) return res.status(400).json({ error: "submitter_name too long (max 80 chars)" });
  if (note.length > 1000) return res.status(400).json({ error: "note too long (max 1000 chars)" });
  if (!req.file.mimetype || !req.file.mimetype.startsWith("image/")) {
    return res.status(400).json({ error: "uploaded file is not an image" });
  }
  if (!locations.includes(hub)) {
    // Log a warning but don't reject — roster may be stale or a new hub may not be in the CSV yet.
    console.warn(`Submission for unknown hub "${hub}" — accepting but flagging`);
  }

  try {
    const photoFilename = saveUploadedPhoto(req.file.buffer, req.file.mimetype);
    const sub = submissionsDb.insertSubmission({
      photoPath: photoFilename,
      hub,
      submitterName,
      note,
    });
    res.status(201).json({
      id: sub.id,
      state: sub.ocr_state,
      created_at: sub.created_at,
      message: "Received. Fleet ops will follow up.",
    });
  } catch (err) {
    console.error("Submission failed:", err.message);
    res.status(500).json({ error: "Failed to save submission: " + err.message });
  }
});

app.get("/api/submissions", (req, res) => {
  const state = req.query.state ? String(req.query.state) : undefined;
  res.json(submissionsDb.listSubmissions({ state }));
});

app.get("/api/submissions/:id", (req, res) => {
  const sub = submissionsDb.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: "Submission not found" });
  res.json(sub);
});

app.post("/api/submissions/:id/retry", (req, res) => {
  const sub = submissionsDb.requestRetry(req.params.id);
  if (!sub) return res.status(404).json({ error: "Submission not found" });
  res.json(sub);
});

// Stub for Microsoft Planner integration. Logs the tasks that would be created
// so we have visibility while we wait on credentials / plan-structure decisions.
// See docs/planner-design.md for the planned implementation.
function plannerSyncStub(audit, actionItems) {
  if (!actionItems.length) {
    console.log(`[planner-stub] audit ${audit.id}: no action items to sync`);
    return;
  }
  console.log(`[planner-stub] audit ${audit.id} (${audit.hub}): would create ${actionItems.length} task(s):`);
  actionItems.forEach(a => {
    if (a.action_type === "move") {
      console.log(`  [planner-stub]   Move key #${a.vehicle_number} from ${a.source_hub} → ${a.destination_hub}`);
    } else if (a.action_type === "locate") {
      console.log(`  [planner-stub]   Locate missing key #${a.vehicle_number} (assigned to ${a.source_hub})`);
    } else if (a.action_type === "remove") {
      console.log(`  [planner-stub]   Remove offboarded key #${a.vehicle_number} from ${a.source_hub} spare box`);
    }
  });
}

// Finalize a submission: take the reviewer-edited chip list, reconcile against
// the current roster, persist the audit + action items, and stub Planner sync.
app.post("/api/submissions/:id/finalize", (req, res) => {
  const sub = submissionsDb.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: "Submission not found" });
  if (sub.ocr_state !== "ready") {
    return res.status(409).json({ error: `Submission OCR state is "${sub.ocr_state}"; cannot finalize until "ready"` });
  }
  // Prevent re-finalizing the same submission.
  if (submissionsDb.getAuditBySubmission(sub.id)) {
    return res.status(409).json({ error: "Submission already finalized" });
  }

  const chipList = Array.isArray(req.body.chip_list) ? req.body.chip_list : null;
  const finalizedByName = (req.body.finalized_by_name || "").trim();
  if (!chipList) return res.status(400).json({ error: "chip_list (array) is required" });
  if (!finalizedByName) return res.status(400).json({ error: "finalized_by_name is required" });
  if (finalizedByName.length > 80) return res.status(400).json({ error: "finalized_by_name too long (max 80 chars)" });

  // Reconcile against the current roster, snapshot the roster used for repeatability.
  const { buckets, actionItems } = reconcile(chipList, sub.hub, roster);
  const audit = submissionsDb.insertAudit({
    submissionId: sub.id,
    hub: sub.hub,
    finalChipList: chipList,
    reconciliation: buckets,
    finalizedByName,
    rosterSnapshot: roster,
  });

  // Persist action items, capture inserted rows for response + stub planner sync.
  const persistedActions = actionItems.map(a => submissionsDb.insertActionItem({
    auditId: audit.id,
    actionType: a.actionType,
    vehicleNumber: a.vehicleNumber,
    sourceHub: a.sourceHub,
    destinationHub: a.destinationHub,
  }));

  plannerSyncStub(audit, persistedActions);

  // Auto-close logic (per requirements §4.4 FR-4.4): when a key now belongs here,
  // close any open "move ... → this hub" action items targeting this vehicle.
  buckets.belongHere.forEach(v => {
    const openMoves = submissionsDb.listActionItems({ status: "open" }).filter(
      a => a.action_type === "move" && a.vehicle_number === v.vehicle_number && a.destination_hub === sub.hub
    );
    openMoves.forEach(om => submissionsDb.closeActionItem(om.id, audit.id));
  });

  res.json({
    audit,
    actionItems: persistedActions,
  });
});

app.get("/api/audits", (req, res) => {
  const hub = req.query.hub ? String(req.query.hub) : undefined;
  res.json(submissionsDb.listAudits({ hub }));
});

app.get("/api/audits/:id", (req, res) => {
  const a = submissionsDb.getAudit(req.params.id);
  if (!a) return res.status(404).json({ error: "Audit not found" });
  res.json(a);
});

app.get("/api/action-items", (req, res) => {
  const filters = {};
  if (req.query.status) filters.status = String(req.query.status);
  if (req.query.source_hub) filters.sourceHub = String(req.query.source_hub);
  if (req.query.audit_id) filters.auditId = String(req.query.audit_id);
  res.json(submissionsDb.listActionItems(filters));
});

// Photos are served from /uploads/<filename> for the inbox UI.
app.use("/uploads", express.static(UPLOADS_DIR, {
  setHeaders: (res) => res.set("Cache-Control", "private, max-age=3600"),
}));

// Central-team inbox view.
app.get("/inbox", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "inbox.html"));
});

// Field-staff submission page (mobile-first, no OCR results shown).
app.get("/submit", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "submit.html"));
});

// Serve static files with no-cache headers to prevent stale versions
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  },
}));

// ---- Background OCR worker ----
// Polls every WORKER_POLL_MS, claims one pending submission at a time,
// runs the OCR pipeline against the on-disk photo, marks ready/failed.
// On failure, db.js schedules the next retry per the backoff curve.

const WORKER_POLL_MS = 30 * 1000;
let workerBusy = false;

async function processOnePending() {
  if (workerBusy) return; // single concurrent job at a time
  const claimed = submissionsDb.claimNextForProcessing();
  if (!claimed) return;
  workerBusy = true;
  console.log(`[worker] processing ${claimed.id} (attempt ${claimed.ocr_attempts})`);
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");
    const buffer = fs.readFileSync(photoAbsPath(claimed.photo_path));
    const client = new Anthropic({ apiKey });
    const result = await runOCR(client, buffer, "image/jpeg");
    submissionsDb.markReady(claimed.id, result);
    console.log(`[worker] ${claimed.id} ready (${result.numbers.length} numbers, ${result.rotation}° rotation)`);
  } catch (err) {
    submissionsDb.markFailed(claimed.id, err.message);
    console.warn(`[worker] ${claimed.id} failed: ${err.message}`);
  } finally {
    workerBusy = false;
  }
}

function startWorker() {
  // Run once on startup so any submissions queued during downtime get picked up,
  // then poll on an interval.
  processOnePending().catch(err => console.error("[worker] startup run failed:", err));
  setInterval(() => {
    processOnePending().catch(err => console.error("[worker] tick failed:", err));
  }, WORKER_POLL_MS);
  console.log(`[worker] started, polling every ${WORKER_POLL_MS / 1000}s`);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startWorker();
});
