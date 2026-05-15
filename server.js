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
let locations = buildLocations(roster);
console.log(`Loaded ${roster.length} vehicles from roster`);

function buildLocations(rosterData) {
  return [
    ...new Set(
      rosterData
        .filter((v) => v.status === "active" && v.assigned_location)
        .map((v) => v.assigned_location)
    ),
  ].sort((a, b) => {
    const aState = a.startsWith("CT") ? 0 : 1;
    const bState = b.startsWith("CT") ? 0 : 1;
    if (aState !== bState) return aState - bState;
    return a.localeCompare(b);
  });
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
  const header = "vehicle_number,assigned_location,current_address,status";
  const lines = vehicles.map((v) => {
    const addr = v.current_address.includes(",") ? `"${v.current_address}"` : v.current_address;
    return `${v.vehicle_number},${v.assigned_location},${addr},${v.status}`;
  });
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
    locations = buildLocations(roster);
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

// OneStep GPS API integration
const ONESTEP_BASE = "https://track.onestepgps.com/v3/api/public";

async function fetchOneStepDevices() {
  const apiKey = process.env.ONESTEP_API_KEY;
  if (!apiKey) throw new Error("ONESTEP_API_KEY not configured");

  // Fetch all devices with pagination (API defaults to 100 per page; we use 200 to be safe)
  const PAGE_SIZE = 200;
  let allDevices = [];
  let offset = 0;

  while (true) {
    const devicesRes = await fetch(
      `${ONESTEP_BASE}/device?latest_point=true&limit=${PAGE_SIZE}&offset=${offset}&api-key=${apiKey}`
    );
    if (!devicesRes.ok) throw new Error(`OneStep devices API returned ${devicesRes.status}`);
    const devicesData = await devicesRes.json();

    const page = devicesData.result_list || devicesData || [];
    const pageList = Array.isArray(page) ? page : [];
    allDevices = allDevices.concat(pageList);
    console.log(`Fetched offset=${offset}: ${pageList.length} devices (running total: ${allDevices.length})`);

    // Done when this page is shorter than requested
    if (pageList.length < PAGE_SIZE) break;

    offset += PAGE_SIZE;
    if (offset > 10000) { console.warn("Pagination safety limit reached"); break; }
  }

  // Log first device structure to help debug group mapping
  const deviceList = allDevices;
  if (deviceList.length > 0) {
    const sample = deviceList[0];
    console.log("Sample device keys:", Object.keys(sample).join(", "));
    console.log("Sample device_id:", sample.device_id);
    console.log("Sample display_name:", sample.display_name);
    console.log("Sample active_state:", sample.active_state);
    // Log all group-related and status-related fields
    for (const key of Object.keys(sample)) {
      if (key.toLowerCase().includes("group") || key.toLowerCase().includes("state") || key.toLowerCase().includes("status")) {
        console.log(`Sample ${key}:`, JSON.stringify(sample[key]));
      }
    }
  }

  // Try group endpoint variants. Each group entry includes a device_id_list
  // we use to build an inverse device_id -> [group names] map.
  let groupMap = {};                    // group_id -> group_name
  const deviceToGroups = {};            // device_id -> [group_name, ...]
  const groupEndpoints = ["device-group", "device-groups", "group", "groups"];
  for (const ep of groupEndpoints) {
    try {
      const groupsRes = await fetch(`${ONESTEP_BASE}/${ep}?api-key=${apiKey}`);
      if (!groupsRes.ok) {
        console.log(`Groups endpoint /${ep} returned ${groupsRes.status}`);
        continue;
      }
      const groupsData = await groupsRes.json();
      const groupList = groupsData.result_list || groupsData || [];
      (Array.isArray(groupList) ? groupList : []).forEach((g) => {
        // OneStep's /device-group response uses `device_group_id`; older shapes use `group_id` or `id`.
        const id = g.device_group_id || g.group_id || g.id;
        const name = g.group_name || g.name || g.display_name || "";
        if (id && name) groupMap[id] = name;
        // Forward mapping group -> devices, invert to device -> [groups]
        const deviceIds = g.device_id_list || g.device_ids || [];
        if (name && Array.isArray(deviceIds)) {
          deviceIds.forEach((deviceId) => {
            if (!deviceToGroups[deviceId]) deviceToGroups[deviceId] = [];
            if (!deviceToGroups[deviceId].includes(name)) deviceToGroups[deviceId].push(name);
          });
        }
      });
      if (Object.keys(groupMap).length > 0) {
        console.log(`Loaded ${Object.keys(groupMap).length} groups from /${ep}; ${Object.keys(deviceToGroups).length} devices mapped to at least one group`);
        break;
      }
    } catch (err) {
      console.log(`Groups endpoint /${ep} failed: ${err.message}`);
    }
  }

  if (Object.keys(groupMap).length === 0) {
    console.log("WARNING: Could not resolve any group names from OneStep.");
  }

  return { devices: deviceList, groupMap, deviceToGroups };
}

// Reverse geocode lat/lng to address using OpenStreetMap Nominatim
async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
      { headers: { "User-Agent": "TNS-Key-Audit-App/1.0" } }
    );
    if (!res.ok) return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    const data = await res.json();
    return data.display_name || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  } catch {
    return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  }
}

// Batch reverse geocode with rate limiting (1 req/sec for Nominatim).
// Writes the resolved address to `current_address` so saveRosterCsv picks it up.
async function batchReverseGeocode(items) {
  const results = [];
  for (const item of items) {
    if (item.lat && item.lng) {
      const current_address = await reverseGeocode(item.lat, item.lng);
      results.push({ ...item, current_address });
      // Rate limit: 1 request per second for Nominatim
      if (items.indexOf(item) < items.length - 1) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    } else {
      results.push({ ...item });
    }
  }
  return results;
}

function convertOneStepToRoster(devices, groupMap, deviceToGroups) {
  return devices.map((d) => {
    const displayName = d.display_name || d.device_id || "";
    const point = d.latest_device_point || d.latest_accurate_device_point || {};
    const lat = point.lat || 0;
    const lng = point.lng || 0;

    // Group resolution, in priority order:
    //   1. deviceToGroups inverse mapping built from /device-group response
    //   2. d.device_groups_name_list when populated by OneStep on the device record
    //   3. d.device_groups_id_list resolved via groupMap
    //   4. Older shapes (legacy fallbacks)
    let groupNames = (deviceToGroups && deviceToGroups[d.device_id]) || [];

    if (groupNames.length === 0 && Array.isArray(d.device_groups_name_list)) {
      groupNames = d.device_groups_name_list.filter(Boolean);
    }
    if (groupNames.length === 0 && Array.isArray(d.device_groups_id_list)) {
      groupNames = d.device_groups_id_list.map((id) => groupMap[id] || "").filter(Boolean);
    }
    if (groupNames.length === 0) {
      const legacyIds = d.group_id_list || d.group_ids || [];
      groupNames = (Array.isArray(legacyIds) ? legacyIds : [legacyIds])
        .map((id) => groupMap[id] || "")
        .filter(Boolean);
    }

    if (devices.indexOf(d) < 3) {
      console.log(`Device "${displayName}" (${d.device_id}): groupNames=[${groupNames.join(", ")}], active_state=${d.active_state}`);
    }

    let status = "active";
    let assignedLocation = "";

    if (groupNames.length === 0 || groupNames.includes("Offboard") || groupNames.includes("N/A")) {
      status = "offboard";
      assignedLocation = "";
    } else {
      const locationParts = groupNames.filter((n) => n !== "PEP");
      assignedLocation = locationParts[0] || groupNames[0] || "";
    }

    if (d.active_state === "deactivated" || d.active_state === "inactive") {
      status = "offboard";
    }

    return {
      vehicle_number: displayName,
      assigned_location: assignedLocation,
      current_address: "",
      status,
      lat,
      lng,
    };
  });
}

// Refresh roster from OneStep GPS API
app.post("/api/refresh-roster", async (_req, res) => {
  try {
    console.log("Refreshing roster from OneStep GPS...");
    const { devices, groupMap, deviceToGroups } = await fetchOneStepDevices();
    console.log(`Fetched ${devices.length} devices and ${Object.keys(groupMap).length} groups`);

    let vehicles = convertOneStepToRoster(devices, groupMap, deviceToGroups);
    console.log(`Converted to ${vehicles.length} vehicles. Reverse geocoding addresses...`);

    // Only reverse geocode active vehicles (saves ~200 API calls / ~4 min)
    const activeVehicles = vehicles.filter((v) => v.status === "active");
    const inactiveVehicles = vehicles.filter((v) => v.status !== "active");
    console.log(`Geocoding ${activeVehicles.length} active vehicles (skipping ${inactiveVehicles.length} offboard)...`);
    const geocoded = await batchReverseGeocode(activeVehicles);
    vehicles = [...geocoded, ...inactiveVehicles];

    // Remove lat/lng helper fields before saving
    const rosterVehicles = vehicles.map(({ lat, lng, ...rest }) => rest);

    saveRosterCsv(rosterVehicles);
    roster = rosterVehicles;
    locations = buildLocations(roster);

    const active = rosterVehicles.filter((v) => v.status === "active").length;
    const offboard = rosterVehicles.filter((v) => v.status === "offboard").length;
    console.log(`Roster refreshed: ${rosterVehicles.length} vehicles (${active} active, ${offboard} offboard, ${locations.length} locations)`);

    res.json({
      ok: true,
      total: rosterVehicles.length,
      active,
      offboard,
      locations: locations.length,
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
