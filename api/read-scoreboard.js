// api/read-scoreboard.js — Vercel serverless function.
//
// Reads a Valorant end-of-match scoreboard screenshot and returns one row per
// player: name, ACS, kills, assists. Those three are the only stats VOLT's
// scoring formula uses (+50 win · ACS÷4 · K+⅓A), so nothing else is requested.
//
// The Gemini key lives here as an environment variable and never reaches the
// browser. Do NOT move this logic client-side: a key in the bundle can be lifted
// by anyone who opens devtools, and they can exhaust the daily free quota — which
// would break match reporting mid-tournament.

const MODEL = "gemini-3.6-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

// Gemini's inline-image ceiling is 20MB for the whole request. The client
// downscales before sending, so anything near this is a bug or an abuse attempt.
const MAX_B64_CHARS = 6_000_000; // ≈4.5MB of image

const SCHEMA = {
  type: "OBJECT",
  properties: {
    rows: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          acs: { type: "INTEGER" },
          kills: { type: "INTEGER" },
          assists: { type: "INTEGER" },
        },
        propertyOrdering: ["name", "acs", "kills", "assists"],
        required: ["name", "acs", "kills", "assists"],
      },
    },
  },
  propertyOrdering: ["rows"],
  required: ["rows"],
};

const PROMPT = `This is a Valorant end-of-match scoreboard.

Read every player row and return one object per player.

For each row:
- "name": the player's display name exactly as shown, without the #TAG if one is present.
- "acs": the Average Combat Score column (a whole number, usually 100-500).
- "kills": the FIRST number in the K/D/A group.
- "assists": the THIRD number in the K/D/A group.

Critical: the K/D/A column shows three numbers in the order kills / deaths / assists.
Take the first as kills and the third as assists. Ignore deaths entirely.
Ignore every other column (econ rating, first bloods, plants, defuses).

Read the digits carefully and do not guess. If a row's numbers are not clearly
legible, still include the row but set the unreadable fields to 0 so a human can
correct them. Include every player from both teams.`;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Use POST." });
  }

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    // Deliberately explicit: this is the single most likely setup mistake.
    return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server." });
  }

  const { image, mimeType } = req.body || {};
  if (typeof image !== "string" || !image) {
    return res.status(400).json({ error: "No image supplied." });
  }
  if (image.length > MAX_B64_CHARS) {
    return res.status(413).json({ error: "That screenshot is too large. Try a smaller one." });
  }
  const mt = /^image\/(png|jpeg|webp)$/.test(mimeType || "") ? mimeType : "image/jpeg";

  try {
    const r = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{
          parts: [
            { inline_data: { mime_type: mt, data: image } },
            { text: PROMPT },
          ],
        }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: SCHEMA,
          temperature: 0, // transcription, not creativity
        },
      }),
    });

    const body = await r.json().catch(() => null);
    if (!r.ok) {
      // Surface Google's message but never the key or full request.
      const msg = body?.error?.message || `Gemini returned ${r.status}.`;
      console.error("gemini error", r.status, msg);
      return res.status(502).json({ error: msg });
    }

    const text = body?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("") || "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.error("unparseable model output", text.slice(0, 500));
      return res.status(502).json({ error: "Couldn't read that screenshot. Try a clearer or fuller capture." });
    }

    const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
    // Normalise and clamp: a hallucinated 99999 ACS should not reach the UI.
    const clean = rows
      .filter((x) => x && typeof x.name === "string" && x.name.trim())
      .slice(0, 12)
      .map((x) => ({
        name: String(x.name).trim().slice(0, 40),
        acs: clampInt(x.acs, 0, 1000),
        kills: clampInt(x.kills, 0, 200),
        assists: clampInt(x.assists, 0, 200),
      }));

    if (!clean.length) {
      return res.status(422).json({ error: "No player rows found in that image." });
    }
    return res.status(200).json({ rows: clean });
  } catch (e) {
    console.error("read-scoreboard failed", e);
    return res.status(500).json({ error: "Couldn't reach the reader. Try again, or type the stats in." });
  }
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 0;
  return Math.min(hi, Math.max(lo, n));
}
