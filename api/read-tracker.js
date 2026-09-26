// api/read-tracker.js — Vercel serverless function.
//
// Reads a Valorant tracker profile screenshot (tracker.gg, blitz.gg, or the
// in-game career tab) and returns the seven fields a scouting profile needs.
//
// Deliberately NOT folded into read-scoreboard.js. That one works because
// Valorant's end-of-match screen is fixed — same columns, same order, every
// time. Tracker sites are not: layouts differ per site, and one page can show
// lifetime, per-act and per-playlist numbers at once. Different problem,
// different prompt, and a much greater chance of reading the wrong panel.
//
// The key risk isn't a misread digit, it's a misread SCOPE: if one player
// screenshots lifetime stats and another screenshots the current act, their
// cards aren't comparable and the auction is quietly distorted. So the model is
// told to prefer current-act competitive, and to report back what it actually
// read so the player can see it grabbed the wrong tab.
//
// Anything illegible comes back null, never 0 — a zero in a profile looks like
// a real value and nobody re-checks it. read-scoreboard.js clamps to 0 instead,
// which is right there (a host is reviewing every row) and wrong here.


const MAX_B64_CHARS = 6_000_000; // ≈4.5MB of image

const TIERS = ["Iron", "Bronze", "Silver", "Gold", "Platinum",
               "Diamond", "Ascendant", "Immortal", "Radiant"];

const SCHEMA = {
  type: "OBJECT",
  properties: {
    ign:           { type: "STRING", nullable: true },
    rank:          { type: "STRING", nullable: true },
    rankDiv:       { type: "INTEGER", nullable: true },
    peakRank:      { type: "STRING", nullable: true },
    peakRankDiv:   { type: "INTEGER", nullable: true },
    agent:         { type: "STRING", nullable: true },
    kda:           { type: "NUMBER", nullable: true },
    acs:           { type: "INTEGER", nullable: true },
    hs:            { type: "INTEGER", nullable: true },
    win:           { type: "INTEGER", nullable: true },
    scope:         { type: "STRING", nullable: true },
    confident:     { type: "BOOLEAN" },
  },
  propertyOrdering: ["ign", "rank", "rankDiv", "peakRank", "peakRankDiv", "agent",
                     "kda", "acs", "hs", "win", "scope", "confident"],
  required: ["confident"],
};

const PROMPT = `This is a screenshot of a Valorant player's stats profile — from
tracker.gg, blitz.gg, or the in-game career screen.

Read these fields:

- "ign": the player's in-game name, shown at the top of the page next to their
  avatar. Give the name only, WITHOUT the #tag that follows it. For example if
  the page shows "rumer #sea", return "rumer".
- "rank": the player's CURRENT competitive rank tier. One of exactly:
  Iron, Bronze, Silver, Gold, Platinum, Diamond, Ascendant, Immortal, Radiant.
- "rankDiv": the division number shown next to that tier, 1, 2 or 3.
  Radiant has no divisions — use null. If no number is shown, use null.
- "peakRank": the highest rank tier the player has ever reached. Labelled
  "Peak Rating", "Peak Rank", "Best Rank" or similar. Same tier names as above.
- "peakRankDiv": the division number for the peak rank, 1-3, or null.
- "agent": the agent they play most, from a "Top Agents" table or similar.
  Just the agent name.
- "kda": the K/D ratio (often labelled "K/D Ratio" or "KD"). A decimal like 1.10.
  If only raw kills/deaths totals are shown, divide kills by deaths.
- "acs": Average Combat Score, a whole number usually 100-400. Round to a whole
  number. Do NOT confuse this with ADR or Damage/Round, which is a different and
  usually smaller number, nor with "Tracker Score" which is out of 1000.
- "hs": headshot percentage, a whole number 0-100. Round.
- "win": win percentage, a whole number 0-100. Round. If only a W-L record is
  shown, compute wins / (wins + losses) * 100.

Which numbers to take, when the page shows several sets:
- Prefer COMPETITIVE over Premier, Unrated, Deathmatch, Swiftplay or Spike Rush.
- Prefer the CURRENT act or episode over lifetime or all-acts totals.
- Ignore anything in a match-history row; use the summary panels.

- "scope": describe in a short phrase which set of numbers you actually read,
  copying the labels visible on the page. For example "V26: A4 Competitive" or
  "Lifetime Competitive" or "Episode 9 Act 2". Null if you cannot tell.
- "confident": true only if this is clearly a Valorant stats profile and you
  read the values directly. False if the image is something else, is too blurry,
  or you had to guess.

Critical: if a field is not visible or not clearly legible, return null for it.
Do NOT substitute 0, and do NOT estimate. A missing value is fine — a wrong one
is not, because captains bid real money against these numbers.`;

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
  if (!key) return res.status(500).json({ error: "GEMINI_API_KEY is not set on the server." });

  const { image, mimeType } = req.body || {};
  if (typeof image !== "string" || !image) return res.status(400).json({ error: "No image supplied." });
  if (image.length > MAX_B64_CHARS) {
    return res.status(413).json({ error: "That screenshot is too large. Try a smaller one." });
  }
  const mt = /^image\/(png|jpeg|webp)$/.test(mimeType || "") ? mimeType : "image/jpeg";

  try {
    const g = await callGemini(key, {
        contents: [{ parts: [{ inline_data: { mime_type: mt, data: image } }, { text: PROMPT }] }],
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
    try { parsed = JSON.parse(text); }
    catch {
      console.error("unparseable model output", text.slice(0, 500));
      return res.status(502).json({ error: "Couldn't read that screenshot. Try a fuller capture of the overview page." });
    }

    if (!parsed?.confident) {
      return res.status(422).json({
        error: "That doesn't look like a Valorant stats page, or it's too blurry to read. " +
               "Try a full screenshot of your tracker.gg overview.",
      });
    }

    const out = {
      // The scoreboard reader matches players by this name, so reading it off
      // the tracker page saves the one field a typo does the most damage to.
      ign:         parsed.ign ? String(parsed.ign).trim().replace(/^#/, "").split("#")[0].slice(0, 24) : null,
      rank:        tier(parsed.rank),
      rankDiv:     div(parsed.rankDiv, tier(parsed.rank)),
      peakRank:    tier(parsed.peakRank),
      peakRankDiv: div(parsed.peakRankDiv, tier(parsed.peakRank)),
      agent:       parsed.agent ? String(parsed.agent).trim().slice(0, 24) : null,
      kda:         range(parsed.kda, 0, 20, 2),
      acs:         range(parsed.acs, 0, 1000, 0),
      hs:          range(parsed.hs, 0, 100, 0),
      win:         range(parsed.win, 0, 100, 0),
      scope:       parsed.scope ? String(parsed.scope).trim().slice(0, 60) : null,
    };

    // Nothing usable came back — say so rather than handing over a blank form.
    if (!out.rank && out.acs == null && out.kda == null) {
      return res.status(422).json({ error: "Couldn't find any stats in that image." });
    }
    return res.status(200).json(out);
  } catch (e) {
    console.error("read-tracker failed", e);
    return res.status(500).json({ error: "Couldn't reach the reader. Try again, or type your stats in." });
  }
}

// Only the nine real tiers — anything else the model invents is dropped rather
// than written to a profile the whole league reads.
function tier(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  return TIERS.find((t) => t.toLowerCase() === s) || null;
}

// Radiant has no divisions, so a number there is a misread.
function div(v, forTier) {
  if (forTier === "Radiant" || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n : null;
}

// Out of range means misread, so return null — never a clamped fake value.
function range(v, lo, hi, dp) {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) return null;
  return dp ? Number(n.toFixed(dp)) : Math.round(n);
}
