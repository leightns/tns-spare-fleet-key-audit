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

STEP 1: First, carefully scan the entire image and count the total number of Next Street branded key tags you can see. State this count.
STEP 2: Now systematically go through each key tag, working left-to-right, top-to-bottom. For each tag, read the vehicle number.

RULES:
- Read ONLY numbers on Next Street branded key tags. Ignore house keys, personal keys, or non-branded tags.
- Vehicle numbers are typically 2-4 digit numbers (e.g. 44, 201, 252, 1023).
- Some tags may be partially obscured, upside down, or at an angle - do your best to read them.
- If a number is partially legible, include your best guess with a "?" suffix (e.g. "44?").
- Common OCR confusions: 1 vs 7, 3 vs 8, 5 vs 6, 0 vs O. Use context (these are vehicle numbers) to resolve ambiguity.
- IMPORTANT: Your array length MUST match the count of key tags from Step 1. If it doesn't, re-examine the image for missed keys.

Return a JSON object with this exact format:
{"count": <number of Next Street key tags seen>, "numbers": ["201", "252", "283"]}
Return ONLY this JSON object, no other text.`;

    // Run 3 parallel passes for consistency
    const imageContent = {
      type: "image",
      source: { type: "base64", media_type: mediaType, data: base64Image },
    };

    const passes = await Promise.all([
      client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt }] }],
      }),
      client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt + "\n\nLook especially carefully at keys that may be overlapping, at angles, or partially hidden behind other keys." }] }],
      }),
      client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt + "\n\nTry rotating your perspective mentally - some tags may be upside down or sideways. Be thorough." }] }],
      }),
    ]);

    // Parse each pass
    const passResults = passes.map((response, i) => {
      const text = response.content[0].text.trim();
      // Try to parse as JSON object with count
      const objMatch = text.match(/\{[\s\S]*\}/);
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

    // Merge: union of all numbers found across passes, track frequency
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

    // Build merged result: include all numbers, mark uncertain if only seen once or flagged
    const merged = Object.entries(freq).map(([num, f]) => {
      if (f.seen === 1 && passResults.length > 1) return num + "?"; // Only one pass saw it
      if (f.uncertain > f.seen / 2) return num + "?"; // Majority uncertain
      return num;
    });

    // Sort numerically
    merged.sort((a, b) => {
      const na = parseInt(a.replace("?", ""));
      const nb = parseInt(b.replace("?", ""));
      return na - nb;
    });

    console.log(`OCR passes found: [${passResults.map(p => p.numbers.length).join(", ")}] keys. Merged: ${merged.length}. Expected: ${maxCount}`);

    res.json({
      numbers: merged,
      expectedCount: maxCount,
      passDetails: passResults.map(p => ({ count: p.count, found: p.numbers.length })),
    });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
