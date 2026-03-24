import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

app.post("/analyze", async (req, res) => {
  const { images, imageBase64, mediaType, gender } = req.body;

  const imageList = images && images.length
    ? images
    : imageBase64 ? [{ data: imageBase64, mediaType: mediaType || "image/jpeg" }] : [];

  if (!imageList.length) {
    return res.status(400).json({ error: "No image provided" });
  }

  for (const img of imageList) {
    if (img.data.length > 5_500_000) {
      return res.status(400).json({ error: "אחת התמונות גדולה מדי. אנא השתמש בתמונות עד 4MB." });
    }
  }

  const multiImageNote = imageList.length > 1
    ? `You received ${imageList.length} images (front/side/back). Use ALL of them together for a more accurate estimate — do not rely on just one.`
    : `You received one image. Note that a single image is limited — parts of the body may not be visible.`;

  const genderScale = (gender === "female") ? `
Gender calibration (female):
- Ab lines visible at rest + vascularity = 14-17%
- Ab lines visible when flexed = 17-21%
- Toned but no clear lines = 21-26%
- No definition, soft = 26%+` : `
Gender calibration (male):
- Abs + ab veins at rest = 6-10%
- Clear abs at rest, no ab veins = 10-13%
- Abs visible when flexed + arm veins = 13-16%
- Abs only with hard flex = 16-19%
- No clear definition, soft belly = 20%+`;

  const prompt = `Act as a strict, professional body composition judge.

Your task is to estimate body fat percentage using a consistent visual scoring system — not general impression.

${multiImageNote}
${genderScale}

Score ONLY based on these criteria:

1. Upper Abs (0–4)
   0 = no visible abs
   1 = faint lines
   2 = visible but soft
   3 = clearly defined
   4 = very sharp and deep

2. Lower Abs (0–4) [MOST IMPORTANT]
   0 = soft, no structure
   1 = slight line only
   2 = partial visibility
   3 = clearly defined
   4 = sharp and fully separated

3. Chest Separation (0–3)
   0 = soft
   1 = minimal separation
   2 = clear separation
   3 = sharp separation

4. Shoulders & Arms (0–3)
   0 = smooth
   1 = slight definition
   2 = clear definition
   3 = sharp with vascularity

5. Conditioning / Dryness (0–3)
   0 = soft look
   1 = lean but smooth
   2 = dry
   3 = very dry / grainy

Rules:
- Score each category strictly
- Lower abs have highest priority
- If lower abs are NOT clearly defined, do NOT estimate 10% or lower
- Do NOT give optimistic estimates — if unsure, choose the HIGHER body fat range
- Lighting, pump, and pose can make someone look 2-3% leaner than reality — compensate for this

Score-to-BF conversion:
0–4   = 18%+
5–7   = 15–17%
8–10  = 13–14%
11–13 = 11–12%
14–15 = 9–10%
16–17 = 7–8%

Respond ONLY with valid JSON (no markdown, no code blocks, no explanation outside JSON):
{
  "scores": {
    "upperAbs": <0-4>,
    "lowerAbs": <0-4>,
    "chest": <0-3>,
    "shouldersArms": <0-3>,
    "conditioning": <0-3>,
    "total": <0-17>
  },
  "bodyFatPercent": <midpoint of range as single number>,
  "range": "<e.g. 13-14%>",
  "confidence": "<low|medium|high>",
  "category": "<essential|athletic|fitness|average|obese>",
  "analysis": "<בעברית: 2-3 נקודות קצרות — מה הוביל לניקוד זה>",
  "whyNotLower": "<בעברית: 1-2 סיבות ספציפיות מדוע האחוז לא נמוך יותר>",
  "keyIndicators": ["<סממן 1 בעברית>", "<סממן 2 בעברית>", "<סממן 3 בעברית>"]
}`;

  // Build Gemini request parts: images first, then text prompt
  const parts = [
    ...imageList.map(img => ({
      inline_data: {
        mime_type: img.mediaType || "image/jpeg",
        data: img.data
      }
    })),
    { text: prompt }
  ];

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4000,
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || JSON.stringify(data));
    }

    // Gemini 2.5 uses thinking tokens — find the actual text part (not thought)
    const responseParts = data.candidates?.[0]?.content?.parts || [];
    const textPart = responseParts.find(p => p.text && !p.thought);
    const rawText = textPart?.text?.trim();
    if (!rawText) {
      console.error("No text part found. Full response:", JSON.stringify(data).slice(0, 800));
      throw new Error("Empty response from Gemini");
    }

    let result;
    const parseGeminiJson = (text) => {
      // Strip markdown code blocks
      let clean = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
      // Extract first { ... } block
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No JSON object found in response");
      clean = match[0];
      // Try direct parse
      try { return JSON.parse(clean); } catch {}
      // Fix trailing commas before } or ]
      clean = clean.replace(/,\s*([\}\]])/g, '$1');
      return JSON.parse(clean);
    };
    try {
      result = parseGeminiJson(rawText);
    } catch (parseErr) {
      console.error("Parse failed. Raw:", rawText.slice(0, 500));
      throw new Error("שגיאת פענוח תגובה — נסה שוב");
    }

    res.json(result);
  } catch (err) {
    console.error("Gemini API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/health", (req, res) => res.json({
  ok: true,
  engine: "gemini-2.5-flash",
  auth: GEMINI_API_KEY ? "gemini_api_key" : "none"
}));

import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 4568;
app.listen(PORT, () => {
  console.log(`✅ Body composition server running at http://localhost:${PORT}`);
  console.log(`🔮 Engine: Gemini 1.5 Flash Vision (free tier)`);
  console.log(`📄 Open http://localhost:${PORT}/weight-tracker.html`);
});
