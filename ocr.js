const sharp = require("sharp");

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

const OCR_MODEL = "claude-opus-4-7";

const OCR_PROMPT = `You are analyzing a photo of vehicle spare keys for a fleet management audit at "The Next Street" driving school. Identify the vehicle number on every VALID TNS KEY TAG in the image.

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

const PASS2_EXTRA = `\n\nFocus especially on:
- Keys in the CORNERS and EDGES of the image that are easy to overlook
- Keys that are overlapping or clustered together
- Any keys hanging at the back that are partially obscured
- Keys with faded or small numbers`;

const PASS3_EXTRA = `\n\nThis is your FINAL careful pass. Be extremely thorough:
- Look for keys at ALL orientations (0°, 90°, 180°, 270°)
- Check for keys in shadows or darker areas of the image
- Look for any keys you might dismiss as non-branded - include ALL numbered tags
- Count every single tag visible, even partially`;

// Parse a single OCR response into { count, numbers }.
function parsePassResponse(text, passIndex) {
  const resultMatch = text.match(/RESULT:\s*(\{[\s\S]*?\})\s*$/m);
  const objMatch = resultMatch
    ? resultMatch[1].match(/\{[\s\S]*\}/)
    : text.match(/\{[^{}]*"numbers"[^{}]*\}/s) || text.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      return { count: parsed.count || 0, numbers: (parsed.numbers || []).map(String) };
    } catch {}
  }
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const nums = JSON.parse(arrMatch[0]).map(String);
      return { count: nums.length, numbers: nums };
    } catch {}
  }
  console.warn(`Pass ${passIndex + 1} failed to parse:`, text);
  return { count: 0, numbers: [] };
}

// Consensus merge across all parsed passes.
// >=2 of 3 passes required for inclusion (drops singleton hallucinations).
// Unanimous + clean = confident; partial agreement or uncertainty flagged with "?".
function consensusMerge(passResults) {
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

  const totalPasses = passResults.length;
  const minVotes = totalPasses >= 3 ? 2 : 1;
  const merged = Object.entries(freq)
    .filter(([, f]) => f.seen >= minVotes)
    .map(([num, f]) => {
      if (f.seen < totalPasses) return num + "?";
      if (f.uncertain > f.seen / 2) return num + "?";
      return num;
    });

  merged.sort((a, b) => {
    const na = parseInt(a.replace("?", ""));
    const nb = parseInt(b.replace("?", ""));
    return na - nb;
  });

  return { merged, maxCount };
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

  const imageContent = {
    type: "image",
    source: { type: "base64", media_type: mediaType, data: base64Image },
  };

  const passPrompts = [OCR_PROMPT, OCR_PROMPT + PASS2_EXTRA, OCR_PROMPT + PASS3_EXTRA];
  const passes = await Promise.all(passPrompts.map(prompt =>
    client.messages.create({
      model: OCR_MODEL,
      max_tokens: 4096,
      messages: [{ role: "user", content: [imageContent, { type: "text", text: prompt }] }],
    })
  ));

  const passResults = passes.map((response, i) => {
    const text = response.content[0].text.trim();
    console.log(`Pass ${i + 1} response length: ${text.length} chars`);
    return parsePassResponse(text, i);
  });

  const { merged, maxCount } = consensusMerge(passResults);
  console.log(`OCR passes found: [${passResults.map(p => p.numbers.length).join(", ")}] keys. Merged: ${merged.length}. Expected: ${maxCount}`);

  return {
    numbers: merged,
    expectedCount: maxCount,
    rotation,
    passDetails: passResults.map(p => ({ count: p.count, found: p.numbers.length })),
  };
}

module.exports = {
  preprocessImage,
  runOCR,
  // Exposed for tests / future tooling
  consensusMerge,
  parsePassResponse,
  OCR_MODEL,
};
