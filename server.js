require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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

const roster = loadRoster();
console.log(`Loaded ${roster.length} vehicles from roster`);

// Get unique active locations sorted: CT first, then MA
const locations = [
  ...new Set(
    roster
      .filter((v) => v.status === "active" && v.assigned_location)
      .map((v) => v.assigned_location)
  ),
].sort((a, b) => {
  const aState = a.startsWith("CT") ? 0 : 1;
  const bState = b.startsWith("CT") ? 0 : 1;
  if (aState !== bState) return aState - bState;
  return a.localeCompare(b);
});

// API routes
app.get("/api/locations", (_req, res) => {
  res.json(locations);
});

app.get("/api/roster", (_req, res) => {
  res.json(roster);
});

app.post("/api/analyze", upload.single("photo"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No photo uploaded" });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY not configured on server" });
  }

  const client = new Anthropic({ apiKey });
  const base64Image = req.file.buffer.toString("base64");
  const mediaType = req.file.mimetype || "image/jpeg";

  try {
    const ocrPrompt = `You are analyzing a photo of vehicle spare keys laid out on a table for a fleet management audit.

TASK: Identify every vehicle number printed on key tags/fobs that have The Next Street branding (the logo features an "X" mark).

RULES:
- Read ONLY numbers on Next Street branded key tags. Ignore house keys, personal keys, or non-branded tags.
- Vehicle numbers are typically 2-4 digit numbers (e.g. 44, 201, 252, 1023).
- Some tags may be partially obscured, upside down, or at an angle - do your best to read them.
- If a number is partially legible, include your best guess with a "?" suffix (e.g. "44?").
- Look carefully at every key in the image. Count the total keys you see and make sure you identify a number for each Next Street key.
- Common OCR confusions: 1 vs 7, 3 vs 8, 5 vs 6, 0 vs O. Use context (these are vehicle numbers) to resolve ambiguity.

Return ONLY a JSON array of strings, e.g. ["201", "252", "283"]. No other text.`;

    const response = await client.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Image },
            },
            { type: "text", text: ocrPrompt },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      const numbers = JSON.parse(match[0]);
      res.json({ numbers });
    } else {
      res.json({ numbers: [], raw: text });
    }
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(500).json({ error: "Failed to analyze image: " + err.message });
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

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
