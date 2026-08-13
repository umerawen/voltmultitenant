// api/discord-recap.js — posts the draft recap when the auction finishes, and
// creates the Discord scheduled event for draft night.
//
// Two jobs in one file because both are "turn a VOLT fact into something native
// in Discord", and both are one-shot host actions rather than ongoing traffic.
//
// The recap exists because the auction is the most exciting hour in the product
// and currently ends with a roster page. This is the thing people screenshot and
// argue about, and arguing is what brings them back the following weekend.
//
// Env: DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY

const API = "https://discord.com/api/v10";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  const jwt = (req.headers.authorization || "").replace(/^Bearer /i, "");
  if (!jwt) return res.status(401).json({ error: "unauthorized" });
  const uid = await whoami(jwt);
  if (!uid) return res.status(401).json({ error: "session expired — sign in again" });

  const { eventId, mode } = req.body || {};
  if (!eventId) return res.status(400).json({ error: "eventId is required" });

  try {
    const [ev] = await sb(`/rest/v1/events?id=eq.${eventId}&select=community_id,weekend_label,draft_at`);
    if (!ev) return res.status(404).json({ error: "tournament not found" });

    const [me] = await sb(`/rest/v1/users?id=eq.${uid}&select=role,community_id`);
    if (!me || me.community_id !== ev.community_id || !["host", "moderator"].includes(me.role)) {
      return res.status(403).json({ error: "only the host or a moderator can do this" });
    }
    const [c] = await sb(`/rest/v1/communities?id=eq.${ev.community_id}` +
      `&select=name,discord_channel_id,discord_guild_id,discord_role_id`);
    if (!c?.discord_guild_id) return res.status(400).json({ error: "connect your Discord server first" });

    if (mode === "event") return await makeScheduledEvent(res, token, c, ev);
    return await postRecap(res, token, c, ev, eventId);
  } catch (e) {
    console.error("recap failed", e);
    return res.status(500).json({ error: "Couldn't reach Discord." });
  }
}

/* ── draft recap ─────────────────────────────────────────────────────────── */

async function postRecap(res, token, c, ev, eventId) {
  if (!c.discord_channel_id) return res.status(400).json({ error: "set an announcements channel first" });
  const r = await rpc("volt_draft_recap", { p_event: eventId });
  if (r?.error === "noboard") return res.status(400).json({ error: "there's no auction board for this tournament yet" });
  if (!r?.teams?.length) return res.status(400).json({ error: "no teams on the board yet" });

  const money = (n) => "$" + Number(n || 0).toLocaleString("en-US");
  const sales = r.sales || [];
  const top = sales[0];
  // "Best value" = cheapest player who still drew a real bidding war. A cheap
  // player nobody contested isn't a bargain, it's just a cheap player.
  const contested = sales.filter((s) => (s.bids || 0) >= 3);
  const value = contested.length ? contested[contested.length - 1] : null;
  const war = sales.slice().sort((a, b) => (b.bids || 0) - (a.bids || 0))[0];

  // One embed per team: Discord renders up to 10, and separate embeds give each
  // roster its own coloured spine instead of one undifferentiated wall.
  const embeds = r.teams.slice(0, 9).map((t) => ({
    title: t.name,
    color: hexToInt(t.hue) ?? 0x3d7bff,
    description:
      (t.captain ? `Captain **${t.captain}**\n` : "") +
      (t.roster || []).map((p) =>
        `\`${money(p.price).padStart(7)}\`  **${p.name}**  ${p.rank || ""}` +
        ((p.bids || 0) >= 3 ? `  · ${p.bids} bids` : "")).join("\n") +
      `\n-# Spent ${money(t.spent)} · ${money(t.left)} left over`,
  }));

  const header = [
    `# Draft results — ${r.tag || c.name}`,
    "",
    `**${r.sold}** players sold${r.unsold ? ` · ${r.unsold} went undrafted` : ""}.`,
    "",
    top ? `**Biggest buy** — ${top.name} at ${money(top.price)}` : null,
    war && (war.bids || 0) >= 3 ? `**Longest fight** — ${war.name}, ${war.bids} bids` : null,
    value ? `**Best value** — ${value.name} at ${money(value.price)} after ${value.bids} bids` : null,
    "",
    "Rosters below. Good luck this weekend.",
  ].filter((x) => x !== null).join("\n");

  const payload = { content: header.slice(0, 1900), embeds,
    allowed_mentions: { parse: [], roles: c.discord_role_id ? [c.discord_role_id] : [] } };
  if (c.discord_role_id) payload.content = `<@&${c.discord_role_id}>\n` + payload.content.slice(0, 1850);

  const post = await call(token, `/channels/${c.discord_channel_id}/messages`, "POST", payload);
  if (!post.ok) return res.status(502).json({ error: `Couldn't post — ${post.reason}` });
  return res.status(200).json({ ok: true, teams: r.teams.length, sold: r.sold });
}

/* ── scheduled event ─────────────────────────────────────────────────────── */

// A native Discord event people can mark Interested on. Discord then notifies
// them itself, which matters because blocked DMs are the main way reminders
// currently fail to land.
async function makeScheduledEvent(res, token, c, ev) {
  if (!ev.draft_at) return res.status(400).json({ error: "set a draft time first" });
  const start = new Date(ev.draft_at);
  if (start.getTime() < Date.now()) {
    return res.status(400).json({ error: "that draft time is in the past" });
  }
  // Discord requires an end time for external events; the auction runs an hour
  // or two, so two hours is a safe visible window.
  const end = new Date(start.getTime() + 2 * 60 * 60 * 1000);

  const existing = await call(token, `/guilds/${c.discord_guild_id}/scheduled-events`, "GET");
  const name = `${ev.weekend_label || "Tournament"} — Draft`;
  const dupe = Array.isArray(existing.body)
    ? existing.body.find((e) => e.name === name && e.status === 1) : null;
  if (dupe) {
    // Re-running after a time change should move the event, not make a second.
    const upd = await call(token, `/guilds/${c.discord_guild_id}/scheduled-events/${dupe.id}`, "PATCH",
      { scheduled_start_time: start.toISOString(), scheduled_end_time: end.toISOString() });
    if (!upd.ok) return res.status(502).json({ error: `Couldn't update the event — ${upd.reason}` });
    return res.status(200).json({ ok: true, updated: true, id: dupe.id });
  }

  const made = await call(token, `/guilds/${c.discord_guild_id}/scheduled-events`, "POST", {
    name,
    description: "The auction for this tournament. Be in voice — captains bid live for the player pool.",
    scheduled_start_time: start.toISOString(),
    scheduled_end_time: end.toISOString(),
    privacy_level: 2,               // guild only — the only value Discord accepts
    entity_type: 3,                 // external
    entity_metadata: { location: "Voice channel — see pinned" },
  });
  if (!made.ok) {
    return res.status(502).json({ error: made.reason === "Missing Permissions"
      ? "the bot needs the Manage Events permission" : `Couldn't create the event — ${made.reason}` });
  }
  return res.status(200).json({ ok: true, id: made.body?.id });
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

function hexToInt(h) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ""));
  return m ? parseInt(m[1], 16) : null;
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

async function whoami(jwt) {
  try {
    const r = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return null;
    return (await r.json())?.id || null;
  } catch { return null; }
}

async function sb(path) {
  const r = await fetch(process.env.SUPABASE_URL + path, {
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY,
               Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
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
