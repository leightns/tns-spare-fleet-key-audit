// Read tns-fleet-agent's nightly enriched output instead of calling OneStep
// directly. tns-fleet-agent already does the OneStep pull + Nominatim geocoding
// + zone-based classification (Hub / Kiosk / Home Vehicle / Instructor /
// Unknown), so consuming its xlsx avoids duplicating that work here.

const fs = require("fs");
const path = require("path");
const XLSX = require("xlsx");

// Default to the OneDrive sync path; override with TNS_FLEET_AGENT_XLSX env var
// for non-Mac environments or for testing.
const DEFAULT_XLSX_PATH = path.join(
  process.env.HOME || "",
  "Library/CloudStorage/OneDrive-TheNextStreet/AI Agents - Fleet Agent/Aggregates/Agg_Fleet_OSGPS_CurrentPosition.xlsx"
);

function xlsxPath() {
  return process.env.TNS_FLEET_AGENT_XLSX || DEFAULT_XLSX_PATH;
}

// Parse the "Group (Hub)" column. Examples:
//   "CT - Monroe"                  -> { primary: "CT - Monroe", flags: [] }
//   "CT - Middlebury, Offboard"    -> { primary: "CT - Middlebury", flags: ["Offboard"] }
//   "CT - Wallingford, PEP"        -> { primary: "CT - Wallingford", flags: ["PEP"] }
//   "PEP"                          -> { primary: "", flags: ["PEP"] }   (rare)
//   ""                             -> { primary: "", flags: [] }
function parseGroupColumn(raw) {
  if (!raw) return { primary: "", flags: [] };
  const parts = String(raw).split(",").map(p => p.trim()).filter(Boolean);
  const flagsSet = new Set(["Offboard", "PEP", "N/A"]);
  const primary = parts.find(p => !flagsSet.has(p)) || "";
  const flags = parts.filter(p => flagsSet.has(p));
  return { primary, flags };
}

function readVehicleRoster({ xlsxPath: explicitPath } = {}) {
  const p = explicitPath || xlsxPath();
  if (!fs.existsSync(p)) {
    throw new Error(`tns-fleet-agent xlsx not found at: ${p}`);
  }
  const wb = XLSX.read(fs.readFileSync(p), { type: "buffer" });
  const ws = wb.Sheets["Vehicle Locations"];
  if (!ws) {
    throw new Error('Expected sheet "Vehicle Locations" not found in xlsx');
  }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  if (!rows.length) throw new Error('"Vehicle Locations" sheet is empty');

  // Find column indices by header name (resilient to column order changes upstream)
  const headers = rows[0].map(h => String(h || "").trim());
  const col = name => {
    const i = headers.indexOf(name);
    if (i === -1) throw new Error(`Expected column "${name}" not found; headers: ${JSON.stringify(headers)}`);
    return i;
  };
  const ix = {
    device: col("Device"),
    group: col("Group (Hub)"),
    address: col("Current Address"),
    zones: col("Zone(s)"),
    locationType: col("Location Type"),
    lastUpdated: col("Last Updated"),
  };

  const vehicles = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row[ix.device] == null) continue;

    const device = String(row[ix.device]).trim();
    const rawGroup = String(row[ix.group] || "").trim();
    const { primary: assignedLocation, flags } = parseGroupColumn(rawGroup);
    const locationType = String(row[ix.locationType] || "Unknown").trim();
    const isOffboard = flags.includes("Offboard") || locationType === "Unknown" && !assignedLocation;
    const status = isOffboard ? "offboard" : "active";

    vehicles.push({
      vehicle_number: device,
      assigned_location: assignedLocation,
      current_address: String(row[ix.address] || "").trim(),
      zones: String(row[ix.zones] || "").trim(),
      location_type: locationType,
      status,
      last_updated: String(row[ix.lastUpdated] || "").trim(),
    });
  }

  return vehicles;
}

// Compute the list of HUBS for the field-flow picker.
//
// Uses the assigned_location (OneStep group) — NOT the location_type. The
// location_type reflects a vehicle's CURRENT position (Hub/Kiosk/Home Vehicle/
// Instructor/Unknown), which varies day to day. The OneStep group is the
// stable answer to "where this vehicle is assigned / which hub owns it."
//
// Excludes non-hub groups by name pattern: "Home Vehicles" and "Personal
// Vehicles" are OneStep groups, not audit-able hubs.
function isHubGroup(name) {
  if (!name) return false;
  if (/home\s*vehicles?/i.test(name)) return false;
  if (/^personal\s*vehicles?/i.test(name)) return false;
  return true;
}

function deriveHubs(vehicles) {
  const hubs = new Set();
  vehicles.forEach(v => {
    if (v.status !== "active") return;
    if (!isHubGroup(v.assigned_location)) return;
    hubs.add(v.assigned_location);
  });
  return [...hubs].sort((a, b) => {
    // CT first, then alphabetical — matches existing convention.
    const aCT = a.startsWith("CT") ? 0 : 1;
    const bCT = b.startsWith("CT") ? 0 : 1;
    if (aCT !== bCT) return aCT - bCT;
    return a.localeCompare(b);
  });
}

module.exports = {
  readVehicleRoster,
  deriveHubs,
  xlsxPath,
};
