const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk").default;

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

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
            {
              type: "text",
              text: 'Look at this photo of vehicle keys on a table. Identify ONLY the vehicle numbers printed on key tags that have The Next Street branding (logo with an X). Ignore all other text, numbers, labels, or markings in the image that are not on Next Street branded key tags. Return the vehicle numbers as a JSON array of strings, e.g. ["201", "252", "283"]. If you cannot confidently read a number, include it with a question mark suffix, e.g. "44?". Return ONLY the JSON array, no other text.',
            },
          ],
        },
      ],
    });

    const text = response.content[0].text.trim();
    // Extract JSON array from response
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

// Serve static files
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
