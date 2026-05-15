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

  // Try multiple group endpoint variants
  let groupMap = {};
  const groupEndpoints = ["group", "groups", "device-group", "device-groups"];
  for (const ep of groupEndpoints) {
    try {
      const groupsRes = await fetch(`${ONESTEP_BASE}/${ep}?api-key=${apiKey}`);
      if (groupsRes.ok) {
        const groupsData = await groupsRes.json();
        console.log(`Groups endpoint /${ep} succeeded:`, JSON.stringify(groupsData).slice(0, 500));
        const groupList = groupsData.result_list || groupsData || [];
        (Array.isArray(groupList) ? groupList : []).forEach((g) => {
          const id = g.group_id || g.id;
          const name = g.group_name || g.name || g.display_name || "";
          if (id) groupMap[id] = name;
        });
        if (Object.keys(groupMap).length > 0) {
          console.log(`Loaded ${Object.keys(groupMap).length} groups from /${ep}`);
          break;
        }
      } else {
        console.log(`Groups endpoint /${ep} returned ${groupsRes.status}`);
      }
    } catch (err) {
      console.log(`Groups endpoint /${ep} failed: ${err.message}`);
    }
  }

  // If no group endpoint worked, try to extract group info from devices themselves
  if (Object.keys(groupMap).length === 0) {
    console.log("No group endpoint worked. Extracting group info from device data...");
    deviceList.forEach((d) => {
      // Check for inline group data
      const groups = d.groups || d.group_list || d.device_groups || [];
      if (Array.isArray(groups)) {
        groups.forEach((g) => {
          if (typeof g === "object") {
            const id = g.group_id || g.id;
            const name = g.group_name || g.name || g.display_name || "";
            if (id && name) groupMap[id] = name;
          }
        });
      }
    });
    if (Object.keys(groupMap).length > 0) {
      console.log(`Extracted ${Object.keys(groupMap).length} groups from device data`);
    } else {
      console.log("WARNING: Could not resolve any group names. Using display_name for group assignment.");
    }
  }

  return { devices: deviceList, groupMap };
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

// Batch reverse geocode with rate limiting (1 req/sec for Nominatim)
async function batchReverseGeocode(items) {
  const results = [];
  for (const item of items) {
    if (item.lat && item.lng) {
      const address = await reverseGeocode(item.lat, item.lng);
      results.push({ ...item, address });
      // Rate limit: 1 request per second for Nominatim
      if (items.indexOf(item) < items.length - 1) {
        await new Promise((r) => setTimeout(r, 1100));
      }
    } else {
      results.push({ ...item, address: "" });
    }
  }
  return results;
}

function convertOneStepToRoster(devices, groupMap) {
  const hasGroupMap = Object.keys(groupMap).length > 0;

  return devices.map((d) => {
    const displayName = d.display_name || d.device_id || "";
    const point = d.latest_device_point || d.latest_accurate_device_point || {};
    const lat = point.lat || 0;
    const lng = point.lng || 0;

    // Try multiple ways to resolve group names
    let groupNames = [];

    if (hasGroupMap) {
      // Use group map to resolve IDs to names
      const groupIds = d.group_id_list || d.group_ids || [];
      groupNames = (Array.isArray(groupIds) ? groupIds : [groupIds])
        .map((id) => groupMap[id] || "")
        .filter(Boolean);
    }

    // If no group names from IDs, try inline group objects
    if (groupNames.length === 0) {
      const inlineGroups = d.groups || d.group_list || d.device_groups || [];
      if (Array.isArray(inlineGroups)) {
        inlineGroups.forEach((g) => {
          if (typeof g === "string") groupNames.push(g);
          else if (typeof g === "object") {
            const name = g.group_name || g.name || g.display_name || "";
            if (name) groupNames.push(name);
          }
        });
      }
    }

    // Log for debugging first few devices
    if (devices.indexOf(d) < 3) {
      console.log(`Device "${displayName}": groupNames=[${groupNames.join(", ")}], active_state=${d.active_state}`);
    }

    // Determine location and status
    let status = "active";
    let assignedLocation = "";

    if (groupNames.length === 0 || groupNames.includes("Offboard") || groupNames.includes("N/A")) {
      status = "offboard";
      assignedLocation = "";
    } else {
      const locationParts = groupNames.filter((n) => n !== "PEP");
      assignedLocation = locationParts[0] || groupNames[0] || "";
    }

    // Also check active_state from the device
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
    const { devices, groupMap } = await fetchOneStepDevices();
    console.log(`Fetched ${devices.length} devices and ${Object.keys(groupMap).length} groups`);

    let vehicles = convertOneStepToRoster(devices, groupMap);
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

// Photos are served from /uploads/<filename> for the inbox UI.
app.use("/uploads", express.static(UPLOADS_DIR, {
  setHeaders: (res) => res.set("Cache-Control", "private, max-age=3600"),
}));

// Central-team inbox view.
app.get("/inbox", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "inbox.html"));
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
