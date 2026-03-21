import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Use OAuth token from Claude Code environment (requires anthropic-beta: oauth-2025-04-20)
const OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const API_KEY = process.env.ANTHROPIC_API_KEY;

// Build a pre-configured client using available credentials
function makeClient(userApiKey) {
  // Priority: user-supplied key > env API key > OAuth token
  if (userApiKey && userApiKey.startsWith("sk-ant-api")) {
    return new Anthropic({ apiKey: userApiKey });
  }
  if (API_KEY) {
    return new Anthropic({ apiKey: API_KEY });
  }
  if (OAUTH_TOKEN) {
    // Use authToken — SDK sets Authorization: Bearer <token>
    return new Anthropic({
      authToken: OAUTH_TOKEN,
      defaultHeaders: { "anthropic-beta": "oauth-2025-04-20" },
    });
  }
  return null;
}

app.post("/analyze", async (req, res) => {
  const { imageBase64, mediaType, height, weight, age, gender, neck, waist, hip, apiKey } = req.body;

  if (!imageBase64) {
    return res.status(400).json({ error: "No image provided" });
  }

  const client = makeClient(apiKey);
  if (!client) {
    return res.status(500).json({ error: "No API credentials available on server." });
  }

  // Limit image size to ~4MB base64 (~3MB raw) to avoid API limits
  if (imageBase64.length > 5_500_000) {
    return res.status(400).json({ error: "התמונה גדולה מדי. אנא השתמש בתמונה עד 4MB." });
  }

  // Build measurement context string
  const measurements = [];
  if (neck) measurements.push(`neck: ${neck}cm`);
  if (waist) measurements.push(`waist: ${waist}cm`);
  if (hip && gender === "female") measurements.push(`hip: ${hip}cm`);

  const measurementStr = measurements.length > 0
    ? `\nOptional circumference measurements provided: ${measurements.join(", ")}.`
    : "";

  // Compute a BMI-based baseline estimate to anchor the visual analysis
  const bmi = weight / Math.pow(height / 100, 2);
  const bmiBfBaseline = gender === "male"
    ? Math.max(4, Math.min(40, 1.20 * bmi + 0.23 * age - 16.2))
    : Math.max(10, Math.min(50, 1.20 * bmi + 0.23 * age - 5.4));

  const prompt = `You are an expert body composition analyst. Your job is to give an ACCURATE body fat estimate by cross-referencing the photo with the person's objective measurements.

=== OBJECTIVE DATA (use as primary anchor) ===
- Gender: ${gender}
- Height: ${height} cm
- Weight: ${weight} kg
- Age: ${age} years
- BMI: ${bmi.toFixed(1)}
- BMI-based BF% estimate: ${bmiBfBaseline.toFixed(1)}% (Deurenberg formula — use as baseline)${measurementStr}

=== PHOTO ANALYSIS INSTRUCTIONS ===
Step 1 — Start from the BMI baseline: ${bmiBfBaseline.toFixed(1)}%
Step 2 — Adjust based on visual cues:
  • Visible 6-pack abs AT REST → subtract 1-3%
  • Visible veins on abdomen → subtract 2-4%
  • Visible veins on arms only → subtract 0-1%
  • No abdominal definition at all → add 2-5%
  • Visible lower belly fat / love handles → add 3-6%
  • Smooth/soft appearance, no muscle lines → add 4-8%

Step 3 — CRITICAL CALIBRATION RULES:
  • Photos are often taken in favorable lighting/poses — do NOT underestimate
  • A person can look lean in a photo but carry more fat than it appears
  • The anthropometric data (BMI, weight) is ground truth — weight it heavily
  • If the visual looks very lean but BMI baseline is ${bmiBfBaseline.toFixed(1)}%, your estimate should stay within ±4% of the baseline unless there is overwhelming visual evidence
  • For males: veins on abs + clear 6-pack = 8-12% range. Abs visible with effort + some vascularity = 12-16%
  • For females: clear ab lines at rest = 14-18%. Toned but no lines = 18-24%

Step 4 — Combine: give more weight to anthropometric data (60%) vs visual (40%).

Respond ONLY with valid JSON (no markdown, no code blocks, just raw JSON):
{
  "bodyFatPercent": <your final cross-referenced estimate, a number>,
  "bmiBaseline": ${bmiBfBaseline.toFixed(1)},
  "visualAdjustment": <how much you adjusted from baseline, e.g. -2.5 or +1.0>,
  "confidence": "<low|medium|high>",
  "category": "<essential|athletic|fitness|average|obese>",
  "analysis": "<2-3 sentences: what visual cues you saw AND how the objective data influenced the final number>",
  "keyIndicators": ["<visual indicator 1>", "<visual indicator 2>", "<data indicator>"]
}`;

  try {
    const requestParams = {
      model: "claude-haiku-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType || "image/jpeg",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: prompt,
            },
          ],
        },
      ],
    };

    const stream = client.messages.stream(requestParams);
    const finalMessage = await stream.finalMessage();
    const rawText = finalMessage.content[0].text.trim();

    // Parse the JSON response
    let result;
    try {
      result = JSON.parse(rawText);
    } catch {
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error("Could not parse Claude response as JSON: " + rawText.slice(0, 200));
      }
    }

    res.json(result);
  } catch (err) {
    console.error("Anthropic API error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check — also reports which auth method is active
app.get("/health", (req, res) => res.json({
  ok: true,
  auth: API_KEY ? "api_key" : OAUTH_TOKEN ? "oauth" : "none",
}));

// Serve static files
import { fileURLToPath } from "url";
import { dirname } from "path";
const __dirname = dirname(fileURLToPath(import.meta.url));
app.use(express.static(__dirname));

const PORT = 4568;
app.listen(PORT, () => {
  const authMode = API_KEY ? "API Key" : OAUTH_TOKEN ? "OAuth (Claude Code)" : "⚠️  NO CREDENTIALS";
  console.log(`✅ Body composition server running at http://localhost:${PORT}`);
  console.log(`🔑 Auth: ${authMode}`);
  console.log(`📄 Open http://localhost:${PORT}/weight-tracker.html`);
});
