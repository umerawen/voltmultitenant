// api/discord-predictions.js — posts a prediction card an hour before kick-off.
//
// Called on a schedule (Vercel cron or the DB tick). Idempotent: each match is
// stamped `predictedAt` on the board once announced, so repeated runs never
// double-post. Safe to call every few minutes.
//
// Env: DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CRON_SECRET

const API = "https://discord.com/api/v10";
const WINDOW_MINS = 60;

export default async function handler(req, res) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  // Vercel cron sends a bearer; a manual call can pass ?secret=. Anything else
  // is refused, since this posts publicly.
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || "";
  const qs = new URL(req.url, "http://x").searchParams.get("secret");
  if (secret && auth !== `Bearer ${secret}` && qs !== secret) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const due = await rpc("volt_pred_due", { p_mins: WINDOW_MINS });
    if (!Array.isArray(due) || !due.length) return res.status(200).json({ posted: 0 });

    let posted = 0;
    const errors = [];
    for (const m of due) {
      // Where to post. Falls back to the announcements channel if the league
      // hasn't built a #predictions channel yet — better a slightly noisy
      // announcement than a silently skipped match.
      const ch = (await rpc("volt_dc_channel", { p_guild: m.guild, p_ref: "predictions" }))?.channel
        || (await community(m.communityId))?.discord_channel_id;
      if (!ch) { errors.push(`${m.a} vs ${m.b}: no channel`); continue; }

      const body = [
        `## ${m.a}  vs  ${m.b}`,
        "",
        `Starts <t:${m.at}:R> — <t:${m.at}:t>${m.bo ? `  ·  Bo${m.bo}` : ""}`,
        "",
        "**Who takes it?** Tap below. You can change your mind until kick-off.",
      ].join("\n");

      const payload = {
        content: body,
        components: buttons(m.matchId, m.a, m.b),
        allowed_mentions: { parse: [] },
      };
      const r = await call(token, `/channels/${ch}/messages`, "POST", payload);
      if (!r.ok) { errors.push(`${m.a} vs ${m.b}: ${r.reason}`); continue; }

      // Stamp only after a successful post, so a failure retries next tick.
      await rpc("volt_pred_mark", { p_event: m.eventId, p_match: m.matchId });
      posted++;
    }
    return res.status(200).json({ posted, errors });
  } catch (e) {
    console.error("predictions failed", e);
    return res.status(500).json({ error: e.message || "failed" });
  }
}

// Labels are the team names themselves — clearer than "Team A"/"Team B" when
// the card is read on a phone hours later.
function buttons(matchId, a, b) {
  return [{ type: 1, components: [
    { type: 2, style: 1, label: String(a).slice(0, 60), custom_id: `volt_pred:${matchId}:a` },
    { type: 2, style: 1, label: String(b).slice(0, 60), custom_id: `volt_pred:${matchId}:b` },
  ] }];
}

async function community(id) {
  const r = await sb(`/rest/v1/communities?id=eq.${id}&select=discord_channel_id`);
  return r?.[0] || null;
}

async function call(token, path, method, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await new Promise((x) => setTimeout(x, retry * 1000 + 250));
    return call(token, path, method, body);
  }
  if (!r.ok) {
    let reason = `http ${r.status}`;
    try { const j = await r.json(); reason = j?.message || reason; } catch { /* keep status */ }
    return { ok: false, reason };
  }
  const text = await r.text();
  return { ok: true, body: text ? JSON.parse(text) : {} };
}

async function sb(path) {
  const r = await fetch(process.env.SUPABASE_URL + path, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}`);
  return r.json();
}

async function rpc(fn, args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
               "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
