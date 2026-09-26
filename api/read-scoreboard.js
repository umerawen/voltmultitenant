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

// ── Resilient Gemini call ────────────────────────────────────────────────
// "This model is currently experiencing high demand" is Google's 503: the
// model is overloaded, not broken. Retry it briefly, then fall back to the
// next model in the list. A model name that doesn't exist on this key (404)
// is simply skipped. The whole thing stays inside Vercel's time limit.
const MODELS = ["gemini-3.6-flash", "gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest"];
const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callGemini(key, payload, budgetMs = 50000) {
  const started = Date.now();
  let last = { status: 503, message: "The reader is busy right now." };
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = budgetMs - (Date.now() - started);
      if (left < 4000) return { ok: false, ...last };
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), Math.min(left - 1000, 25000));
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", signal: ctl.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify(payload),
        });
        const body = await r.json().catch(() => null);
        if (r.ok) return { ok: true, body, model };
        last = { status: r.status, message: body?.error?.message || `Gemini returned ${r.status}.` };
        console.error("gemini", model, r.status, last.message);
        if (r.status === 404 || r.status === 400 && /not found|not supported/i.test(last.message)) break; // try next model
        if (!RETRY_STATUS.has(r.status)) return { ok: false, ...last };      // a real error — don't mask it
        if (attempt === 0) await sleep(900 + Math.random() * 600);
      } catch (e) {
        last = { status: 504, message: e.name === "AbortError" ? "The reader took too long." : String(e.message || e) };
        console.error("gemini", model, last.message);
      } finally { clearTimeout(t); }
    }
  }
  return { ok: false, ...last };
}

// What the player sees when every model is busy: a plain next step, not
// Google's wording.
const busyMessage = (status) => RETRY_STATUS.has(status) || status === 404
  ? "The screenshot reader is busy right now. Try again in a minute, or type your stats in below."
  : null;

// Room for a retry and a fallback model when Gemini is overloaded.
export const config = { maxDuration: 60 };

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
    const g = await callGemini(key, {
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
      });
    if (!g.ok) {
      return res.status(g.status === 429 || g.status === 503 ? 503 : 502)
        .json({ error: busyMessage(g.status) || g.message });
    }
    const body = g.body;

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
