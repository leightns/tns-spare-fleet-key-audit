require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Anthropic = require("@anthropic-ai/sdk").default;
const XLSX = require("xlsx");
const sharp = require("sharp");
const submissionsDb = require("./db");

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

// Normalize image orientation before OCR.
// 1. Apply EXIF rotation (most cameras tag this; rotates pixels accordingly).
// 2. If still portrait (H > W), rotate 270° CW — phones held vertically photographing
//    a horizontal key-box scene leave tags running sideways in the pixel data.
// Returns the rotated buffer and the rotation applied (in degrees, for diagnostics).
async function preprocessImage(buffer) {
  const exifNormalized = await sharp(buffer).rotate().toBuffer();
  const meta = await sharp(exifNormalized).metadata();
  if (meta.height > meta.width) {
    const rotated = await sharp(exifNormalized).rotate(270).toBuffer();
    return { buffer: rotated, applied: 270 };
  }
  return { buffer: exifNormalized, applied: 0 };
}

// Run the full OCR pipeline (preprocess → 3 parallel passes → consensus merge).
// Returns { numbers, expectedCount, rotation, passDetails }.
// Throws on Anthropic API failure so callers can decide retry strategy.
async function runOCR(client, buffer, mediaType = "image/jpeg") {
  let base64Image;
  let rotation = 0;
  try {
    const pre = await preprocessImage(buffer);
    base64Image = pre.buffer.toString("base64");
    rotation = pre.applied;
    console.log(`Preprocess: applied ${rotation}° rotation`);
  } catch (err) {
    console.warn("Image preprocessing failed; using original:", err.message);
    base64Image = buffer.toString("base64");
  }

  const ocrPrompt = `You are analyzing a photo of vehicle spare keys for a fleet management audit at "The Next Street" driving school. Identify the vehicle number on every VALID TNS KEY TAG in the image.

WHAT COUNTS AS A VALID TNS KEY TAG (only these — ignore everything else):
- Small (~1-2 inch) rectangular plastic tag, attached to a key or key fob by a metal ring
- Most are WHITE with blue "THE NEXT STREET" text and a red/orange X-shaped logo
- Some are colorful "Drive Politely" branded tags (rainbow-colored, compass-style design)
- Each valid tag has a 2-4 digit vehicle number printed or handwritten on it (e.g. 44, 179, 201, 282, 1023)

DO NOT REPORT NUMBERS FROM ANY OF THE FOLLOWING (these are NOT vehicle tags, even though they have numbers):
- Fuel cards (WEX, Exxon Mobil, or similar credit-card-shaped items). TNS stores a spare gas card alongside the keys, so they often appear in audit photos. Their account numbers (like "0455 00 114582 0", "5529-1", "8 LL3848") and any "HONDA CIVIC 249" / vehicle-model labels printed ON the card are NOT vehicle key tags. Skip them entirely.
- Slot or hanger tags from inside the key storage box. These are small plastic numbered tags (typically 001-050) that identify hooks/slots in the storage box itself. They are not attached to keys. Skip them.
- Barcodes, serial numbers, sticker IDs, QR codes, or any other numbered labels.

ONLY include numbers that are clearly printed/written on a TNS-BRANDED tag (logo visible) or a "Drive Politely" colored tag, attached to a key.

INSTRUCTIONS - Think step by step:
1. Scan the ENTIRE image systematically. Divide into quadrants and examine each.
2. For each numbered item you see, FIRST decide: is this a valid TNS key tag (logo visible, attached to a key) or is it something to ignore (fuel card, slot tag, barcode)?
3. For valid tags only, read the vehicle number. Describe its position to stay organized.
4. Some valid tags may be:
   - Upside down or sideways - mentally rotate to read them
   - Partially hidden behind other keys - read what you can see
   - At steep angles - adjust perspective
   - Small or blurry/handwritten - give your best read with "?" suffix
5. Double-check: go back through the image once more, confirming each number you report is on a valid TNS key tag (not a fuel card or slot tag).

After your analysis, output your final answer as a JSON object on its own line in this exact format:
RESULT: {"count": <total VALID TNS key tags seen>, "numbers": ["201", "252", "283"]}`;

    const pass2Extra = `\n\nFocus especially on:
- Keys in the CORNERS and EDGES of the image that are easy to overlook
- Keys that are overlapping or clustered together
- Any keys hanging at the back that are partially obscured
- Keys with faded or small numbers`;

    const pass3Extra = `\n\nThis is your FINAL careful pass. Be extremely thorough:
- Look for keys at ALL orientations (0°, 90°, 180°, 270°)
- Check for keys in shadows or darker areas of the image
- Look for any keys you might dismiss as non-branded - include ALL numbered tags
- Count every single tag visible, even partially`;

    // Run 3 parallel passes for consistency
    const imageContent = {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64Image },
    };

    const passes = await Promise.all([
      client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 4096,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt }] }],
      }),
      client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 4096,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt + pass2Extra }] }],
      }),
      client.messages.create({
        model: "claude-opus-4-7",
        max_tokens: 4096,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt + pass3Extra }] }],
      }),
    ]);

    // Parse each pass
    const passResults = passes.map((response, i) => {
      const text = response.content[0].text.trim();
      console.log(`Pass ${i + 1} response length: ${text.length} chars`);
      // Look for RESULT: line first, then fall back to last JSON object
      const resultMatch = text.match(/RESULT:\s*(\{[\s\S]*?\})\s*$/m);
      const objMatch = resultMatch ? resultMatch[1].match(/\{[\s\S]*\}/) : text.match(/\{[^{}]*"numbers"[^{}]*\}/s) || text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          const parsed = JSON.parse(objMatch[0]);
          return { count: parsed.count || 0, numbers: (parsed.numbers || []).map(String) };
        } catch {}
      }
      // Fallback: try array
      const arrMatch = text.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          const nums = JSON.parse(arrMatch[0]).map(String);
          return { count: nums.length, numbers: nums };
        } catch {}
      }
      console.warn(`Pass ${i + 1} failed to parse:`, text);
      return { count: 0, numbers: [] };
    });

    // Merge: track frequency across passes
    const freq = {};
    let maxCount = 0;
    passResults.forEach(p => {
      if (p.count > maxCount) maxCount = p.count;
      p.numbers.forEach(n => {
        const clean = n.replace(/\?$/, "");
        const isUncertain = n.endsWith("?");
        if (!freq[clean]) freq[clean] = { seen: 0, uncertain: 0 };
        freq[clean].seen++;
        if (isUncertain) freq[clean].uncertain++;
      });
    });

    // Consensus merge: require >=2 of 3 passes to include (drops singleton hallucinations).
    // Unanimous + clean = confident; partial agreement or uncertainty = flagged with "?".
    const totalPasses = passResults.length;
    const minVotes = totalPasses >= 3 ? 2 : 1;
    const merged = Object.entries(freq)
      .filter(([, f]) => f.seen >= minVotes)
      .map(([num, f]) => {
        if (f.seen < totalPasses) return num + "?";
        if (f.uncertain > f.seen / 2) return num + "?";
        return num;
      });

    // Sort numerically
    merged.sort((a, b) => {
      const na = parseInt(a.replace("?", ""));
      const nb = parseInt(b.replace("?", ""));
      return na - nb;
    });

    console.log(`OCR passes found: [${passResults.map(p => p.numbers.length).join(", ")}] keys. Merged: ${merged.length}. Expected: ${maxCount}`);

  return {
    numbers: merged,
    expectedCount: maxCount,
    rotation,
    passDetails: passResults.map(p => ({ count: p.count, found: p.numbers.length })),
  };
}

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
