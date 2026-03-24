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
    const ocrPrompt = `You are analyzing a photo of vehicle spare keys hanging on hooks or laid out for a fleet management audit.

TASK: Identify every vehicle number visible on key tags/fobs in this image.

Key tags for "The Next Street" driving school typically have:
- A colored plastic key tag (often blue, red, green, yellow, or white)
- A vehicle number printed/written on the tag (2-4 digits like 44, 201, 252, 1023)
- Sometimes the company name or an "X" logo

INSTRUCTIONS - Think step by step:
1. First, scan the ENTIRE image systematically. Divide it into quadrants (top-left, top-right, bottom-left, bottom-right) and examine each.
2. Count every key tag you can see - there may be 10, 20, 30+ keys in the image.
3. For EACH key tag, read the number. Describe its position and color to stay organized.
4. Some tags may be:
   - Upside down or sideways - mentally rotate to read them
   - Partially hidden behind other keys - read what you can see
   - At steep angles - adjust perspective
   - Small or blurry - give your best read with "?" suffix
5. Double-check: go back through the image one more time to catch any you missed.

IMPORTANT: These photos typically contain MANY keys (often 15-40+). If you only found a few, look again more carefully - you are likely missing keys.

After your analysis, output your final answer as a JSON object on its own line in this exact format:
RESULT: {"count": <total key tags seen>, "numbers": ["201", "252", "283"]}`;

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
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt }] }],
      }),
      client.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        messages: [{ role: "user", content: [imageContent, { type: "text", text: ocrPrompt + pass2Extra }] }],
      }),
      client.messages.create({
        model: "claude-sonnet-4-20250514",
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
