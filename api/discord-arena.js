// api/discord-arena.js — builds the tournament's home inside Discord.
//
// Four modes, deliberately separate so a host can run the safe ones early:
//   common     — category + channels that don't depend on the draft
//   teams      — one role + private text + private voice per team (after the draft)
//   results    — post a match result card to #results
//   standings  — post/refresh the leaderboard, editing one message in place
//
// Everything is idempotent. Each object created is recorded in discord_objects,
// so a second run updates instead of duplicating — pressing "build" twice must
// never leave two #results channels and two roles per team with nothing knowing
// which is live.
//
// Permissions: Manage Channels, Manage Roles, plus the bot's role sitting ABOVE
// the team roles it creates. Send Messages and Embed Links for the posts.
//
// Env: DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY

const API = "https://discord.com/api/v10";

// Vercel kills a function at its timeout with no JSON body, which surfaces in
// the UI as a bare "Failed (500)" — no message, nothing to act on. Asking for
// longer, and bailing out cleanly before the limit, turns that into a partial
// result the host can just re-run.
export const config = { maxDuration: 60 };
// Budget for the worst case, not the configured one. maxDuration only lifts the
// ceiling on some Vercel plans; where it doesn't, the hard limit is 10s and a
// 45s budget would never fire — the function just dies with no JSON body, which
// is exactly the opaque 500 this is meant to prevent. 8s is safe on either, and
// since every step is idempotent, finishing across two presses costs nothing.
const BUDGET_MS = 8000;

const P = {
  VIEW:    1n << 10n,
  SEND:    1n << 11n,
  CONNECT: 1n << 20n,
  SPEAK:   1n << 21n,
};

// Channels that make sense before anyone is drafted. Kept short on purpose: a
// server with twelve dead channels reads as abandoned, and every extra one is
// somewhere a message can be missed.
const COMMON = [
  { ref: "results",   name: "results",    type: 0, readOnly: true,
    topic: "Valorant match results as they come in. Posted automatically." },
  { ref: "standings", name: "standings",  type: 0, readOnly: true,
    topic: "The season race. Updated after every match." },
  { ref: "fixtures",  name: "fixtures",   type: 0, readOnly: true,
    topic: "Who plays who, and when. Updated whenever the schedule changes." },
  { ref: "general",   name: "trash-talk", type: 0, readOnly: false,
    topic: "Say something you'll regret." },
  { ref: "stage",     name: "Draft Stage", type: 2 },
  { ref: "vc-a",      name: "Match A",     type: 2 },
  { ref: "vc-b",      name: "Match B",     type: 2 },
];

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  const jwt = (req.headers.authorization || "").replace(/^Bearer /i, "");
  if (!jwt) return res.status(401).json({ error: "unauthorized" });
  const uid = await whoami(jwt);
  if (!uid) return res.status(401).json({ error: "session expired — sign in again" });

  const { eventId, mode = "common", payload } = req.body || {};
  if (!eventId) return res.status(400).json({ error: "eventId is required" });

  try {
    const [ev] = await sb(`/rest/v1/events?id=eq.${eventId}&select=community_id,weekend_label`);
    if (!ev) return res.status(404).json({ error: "tournament not found" });
    const [me] = await sb(`/rest/v1/users?id=eq.${uid}&select=role,community_id`);
    if (!me || me.community_id !== ev.community_id || !["host", "moderator"].includes(me.role)) {
      return res.status(403).json({ error: "only the host or a moderator can do this" });
    }
    const [c] = await sb(`/rest/v1/communities?id=eq.${ev.community_id}` +
      `&select=name,discord_guild_id,discord_role_id`);
    if (!c?.discord_guild_id) return res.status(400).json({ error: "connect your Discord server first" });

    const ctx = { token, guild: c.discord_guild_id, community: ev.community_id, eventId, ev, c };
    // Preload the two things every ensureChannel() used to fetch for itself.
    // Building seven channels meant seven full guild-channel listings and seven
    // registry queries — enough sequential round trips to blow Vercel's function
    // timeout, which surfaces as a bare 500 with no JSON body to explain it.
    if (mode === "common" || mode === "teams") {
      const list = await call(token, `/guilds/${ctx.guild}/channels`, "GET");
      ctx.channels = Array.isArray(list.body) ? list.body : [];
      ctx.registry = await sb(`/rest/v1/discord_objects?community_id=eq.${ctx.community}` +
        `&or=(event_id.eq.${eventId},event_id.is.null)&select=kind,ref,discord_id,event_id`);
      ctx.me = await selfId(token);
    }
    if (mode === "common")    return res.status(200).json(await buildCommon(ctx));
    if (mode === "teams")     return res.status(200).json(await buildTeams(ctx));
    if (mode === "results")   return res.status(200).json(await postResult(ctx, payload));
    if (mode === "standings") return res.status(200).json(await postStandings(ctx));
    if (mode === "fixtures")  return res.status(200).json(await postFixtures(ctx));
    return res.status(400).json({ error: `unknown mode ${mode}` });
  } catch (e) {
    console.error("arena failed", e);
    return res.status(500).json({ error: e.message || "Couldn't reach Discord." });
  }
}

/* ── common channels ─────────────────────────────────────────────────────── */

async function buildCommon(ctx) {
  const out = { created: [], reused: [], errors: [] };
  ctx.deadline = Date.now() + BUDGET_MS;
  // A category keeps the tournament's channels together and, more usefully,
  // lets one permission change apply to all of them at once later.
  const cat = await ensureChannel(ctx, {
    ref: "category", name: ctx.ev.weekend_label || ctx.c.name, type: 4, eventScoped: false,
  }, out);
  if (!cat) return out;

  for (const spec of COMMON) {
    if (outOfTime(ctx, out)) break;
    await ensureChannel(ctx, { ...spec, parent_id: cat, eventScoped: false }, out);
  }
  return out;
}

/* ── team roles + private channels ───────────────────────────────────────── */

async function buildTeams(ctx) {
  const out = { created: [], reused: [], errors: [], teams: 0, assigned: 0 };
  ctx.deadline = Date.now() + BUDGET_MS;
  const data = await rpc("volt_dc_teams", { p_event: ctx.eventId });
  if (data?.error === "noboard") throw new Error("There's no draft board yet — run the auction first.");
  const teams = (data?.teams || []).filter((t) => t.name);
  if (!teams.length) throw new Error("No teams on the board yet.");

  const cat = await ensureChannel(ctx, {
    ref: "team-category", name: `${ctx.ev.weekend_label || "Tournament"} · Teams`, type: 4, eventScoped: true,
  }, out);

  const existingRoles = await listRoles(ctx);

  for (const t of teams) {
    if (outOfTime(ctx, out)) break;
    out.teams++;
    const roleName = `VOLT ${t.name}`;
    // Reuse by name so a role left over from a previous run is adopted rather
    // than duplicated — Discord happily allows two roles with the same name.
    let role = existingRoles.find((r) => r.name === roleName);
    if (!role) {
      const made = await call(ctx.token, `/guilds/${ctx.guild}/roles`, "POST",
        { name: roleName, color: hexToInt(t.hue) ?? 0x3d7bff, mentionable: true, hoist: false });
      if (!made.ok) { out.errors.push(`role ${t.name}: ${made.reason}`); continue; }
      role = made.body; existingRoles.push(role);
      out.created.push(roleName);
    } else out.reused.push(roleName);
    await remember(ctx, "role", t.name, role.id, true);

    for (const did of t.discordIds || []) {
      if (outOfTime(ctx, out)) break;
      const r = await call(ctx.token, `/guilds/${ctx.guild}/members/${did}/roles/${role.id}`, "PUT");
      if (r.ok) out.assigned++;
      else if (!out.errors.some((e) => e.startsWith("assign"))) out.errors.push(`assign: ${r.reason}`);
      // 80ms is ample spacing for member-role writes and saves a lot of dead
      // time across a full league compared with 200ms.
      await sleep(80);
    }

    // Private text + voice: invisible to everyone but the team and staff. This
    // is the part that makes a drafted team feel like a team rather than a row
    // on a website.
    const overwrites = [
      { id: ctx.guild, type: 0, deny: P.VIEW.toString(), allow: "0" },
      { id: role.id, type: 0,
        allow: (P.VIEW | P.SEND | P.CONNECT | P.SPEAK).toString(), deny: "0" },
    ];
    if (ctx.me) overwrites.push({ id: ctx.me, type: 1,
      allow: (P.VIEW | P.SEND | P.CONNECT | P.SPEAK).toString(), deny: "0" });

    await ensureChannel(ctx, { ref: `team-text:${t.name}`, name: `${slug(t.name)}-room`, type: 0,
      parent_id: cat, eventScoped: true, permission_overwrites: overwrites,
      topic: `${t.name} only. Captain: ${t.captain || "—"}` }, out);
    await ensureChannel(ctx, { ref: `team-vc:${t.name}`, name: t.name, type: 2,
      parent_id: cat, eventScoped: true, permission_overwrites: overwrites }, out);
  }
  return out;
}

/* ── results + standings ─────────────────────────────────────────────────── */

async function postResult(ctx, payload) {
  const ch = await lookup(ctx, "text", "results");
  if (!ch) throw new Error("Run “Set up channels” first — there's no #results channel yet.");
  if (!payload?.teamA) throw new Error("Nothing to post.");

  const rows = (payload.players || []).slice(0, 12)
    .map((p) => `\`${String(p.acs ?? "—").padStart(4)}\` **${p.name}** ${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`)
    .join("\n");
  const embed = {
    title: `${payload.teamA} ${payload.scoreA ?? ""} — ${payload.scoreB ?? ""} ${payload.teamB}`,
    color: 0x3d7bff,
    description: (payload.map ? `**${payload.map}**\n` : "") + (rows || "_No player stats recorded._"),
    footer: { text: payload.tag || ctx.ev.weekend_label || "" },
  };
  const r = await call(ctx.token, `/channels/${ch}/messages`, "POST",
    { embeds: [embed], allowed_mentions: { parse: [] } });
  if (!r.ok) throw new Error(`Couldn't post the result — ${r.reason}`);
  return { ok: true };
}

// Like standings, this edits one message rather than posting a new one. A
// fixtures channel that grows by a post per reschedule is a changelog, not a
// schedule — players need the current answer at a glance, not its history.
async function postFixtures(ctx) {
  const ch = await lookup(ctx, "text", "fixtures");
  if (!ch) throw new Error("Run “Set up channels” first — there's no #fixtures channel yet.");
  const f = await rpc("volt_dc_fixtures", { p_event: ctx.eventId });
  if (f?.error === "noboard") throw new Error("There's no draft board yet.");
  if (f?.error === "nofixtures") throw new Error("No fixtures have been built yet — set the format and lock the schedule first.");
  const list = f.matches || [];
  if (!list.length) throw new Error("The schedule is empty.");

  const rounds = {};
  for (const m of list) (rounds[m.round || 1] ||= []).push(m);

  const body = Object.keys(rounds).sort((a, b) => a - b).map((r) => {
    const head = f.format === "single" ? `**Round ${r}**` : `**Matchday ${r}**`;
    const lines = rounds[r].map((m) => {
      // <t:unix:f> renders in each reader's own timezone, which is the whole
      // reason for posting this in Discord rather than linking to the site.
      const when = m.at ? `<t:${Math.floor(new Date(m.at).getTime() / 1000)}:f>` : "_time TBA_";
      if (m.done) {
        return `~~${m.a} vs ${m.b}~~ — **${m.winner || "done"}** won`;
      }
      return `**${m.a}** vs **${m.b}** · ${when}${m.bo ? ` · Bo${m.bo}` : ""}`;
    });
    return `${head}\n${lines.join("\n")}`;
  }).join("\n\n");

  const embed = { title: "Fixtures", color: 0x3d7bff,
    description: body.slice(0, 4000),
    footer: { text: f.tag || ctx.ev.weekend_label || "" },
    timestamp: new Date().toISOString() };

  const prior = await lookup(ctx, "message", "fixtures");
  if (prior) {
    const upd = await call(ctx.token, `/channels/${ch}/messages/${prior}`, "PATCH", { embeds: [embed] });
    if (upd.ok) return { ok: true, edited: true, matches: list.length };
    // Deleted by hand — fall through and post a fresh one.
  }
  const r = await call(ctx.token, `/channels/${ch}/messages`, "POST", { embeds: [embed] });
  if (!r.ok) throw new Error(`Couldn't post fixtures — ${r.reason}`);
  await remember(ctx, "message", "fixtures", r.body.id, false, { channel: ch });
  return { ok: true, edited: false, matches: list.length };
}

async function postStandings(ctx) {
  const ch = await lookup(ctx, "text", "standings");
  if (!ch) throw new Error("Run “Set up channels” first — there's no #standings channel yet.");
  const rows = await rpc("volt_dc_leaderboard", { p_guild: ctx.guild });
  if (rows?.error) throw new Error("Couldn't read the leaderboard.");

  const medal = ["🥇", "🥈", "🥉"];
  const body = (rows || []).slice(0, 20).map((r, i) =>
    `${medal[i] || `\`${String(i + 1).padStart(2)}\``} **${r.name}** — ${Math.round(r.pts)} pts (${r.played})`)
    .join("\n") || "_Nobody has banked points yet._";
  const embed = { title: "Season standings", color: 0xf5c453, description: body,
    footer: { text: "+50 win · ACS÷4 · K+⅓A" }, timestamp: new Date().toISOString() };

  // Edit the same message rather than posting a new one each time: a standings
  // channel that grows by one post per match becomes a scroll, not a scoreboard.
  const prior = await lookup(ctx, "message", "standings");
  if (prior) {
    const upd = await call(ctx.token, `/channels/${ch}/messages/${prior}`, "PATCH", { embeds: [embed] });
    if (upd.ok) return { ok: true, edited: true };
    // Message was deleted by hand — fall through and post a fresh one.
  }
  const r = await call(ctx.token, `/channels/${ch}/messages`, "POST", { embeds: [embed] });
  if (!r.ok) throw new Error(`Couldn't post standings — ${r.reason}`);
  await remember(ctx, "message", "standings", r.body.id, false, { channel: ch });
  return { ok: true, edited: false };
}

/* ── helpers ─────────────────────────────────────────────────────────────── */

// Create if missing, adopt if a channel of that name already exists, and record
// the ID either way. The registry is checked first so a rename in Discord
// doesn't cause a duplicate.
async function ensureChannel(ctx, spec, out) {
  if (outOfTime(ctx, out)) return null;
  const kind = kindOf(spec.type);
  const want = spec.type === 2 || spec.type === 4 ? spec.name : slug(spec.name);

  // Registry first, then the live channel list — both already in memory, so a
  // reused channel costs zero API calls.
  const known = fromRegistry(ctx, kind, spec.ref);
  if (known && ctx.channels.some((x) => x.id === known)) {
    out.reused.push(spec.name);
    return known;
  }
  const found = ctx.channels.find((x) => x.type === spec.type && x.name === want);
  if (found) {
    await remember(ctx, kind, spec.ref, found.id, spec.eventScoped);
    out.reused.push(spec.name);
    return found.id;
  }

  const body = { name: want, type: spec.type };
  if (spec.parent_id) body.parent_id = spec.parent_id;
  if (spec.topic) body.topic = spec.topic;
  if (spec.permission_overwrites) body.permission_overwrites = spec.permission_overwrites;
  // Read-only commons: members can read and react, only the bot writes.
  if (spec.readOnly) {
    body.permission_overwrites = [{ id: ctx.guild, type: 0, deny: P.SEND.toString(), allow: "0" }];
    if (ctx.me) body.permission_overwrites.push({ id: ctx.me, type: 1, allow: P.SEND.toString(), deny: "0" });
  }
  const made = await call(ctx.token, `/guilds/${ctx.guild}/channels`, "POST", body);
  if (!made.ok) { out.errors.push(`${spec.name}: ${made.reason}`); return null; }
  // Keep the in-memory list current so a later spec in the same run sees it.
  ctx.channels.push({ id: made.body.id, type: spec.type, name: want });
  await remember(ctx, kind, spec.ref, made.body.id, spec.eventScoped);
  out.created.push(spec.name);
  return made.body.id;
}

// Preloaded registry lookup. A row scoped to this tournament beats a
// league-wide one, same as the query it replaces.
function fromRegistry(ctx, kind, ref) {
  const rows = (ctx.registry || []).filter((r) => r.kind === kind && r.ref === ref);
  if (!rows.length) return null;
  return (rows.find((r) => r.event_id === ctx.eventId) || rows[0]).discord_id;
}

// Everything here is idempotent, so stopping early is safe: re-running picks up
// exactly where it left off rather than duplicating what already exists.
function outOfTime(ctx, out) {
  if (!ctx.deadline || Date.now() < ctx.deadline) return false;
  out.partial = true;
  if (!out.errors.some((e) => e.startsWith("Ran out"))) {
    out.errors.push("Ran out of time — press the button again to finish the rest.");
  }
  return true;
}

const kindOf = (t) => (t === 4 ? "category" : t === 2 ? "voice" : "text");
const slug = (n) => String(n).toLowerCase().trim()
  .replace(/[^a-z0-9\-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "channel";
const hexToInt = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || "")); return m ? parseInt(m[1], 16) : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _selfId = null;
async function selfId(token) {
  if (_selfId) return _selfId;
  const r = await call(token, "/users/@me", "GET");
  _selfId = r.ok ? r.body?.id : null;
  return _selfId;
}

async function listRoles(ctx) {
  const r = await call(ctx.token, `/guilds/${ctx.guild}/roles`, "GET");
  return r.ok && Array.isArray(r.body) ? r.body : [];
}

async function lookup(ctx, kind, ref) {
  const ev = ctx.eventId;
  const rows = await sb(`/rest/v1/discord_objects?community_id=eq.${ctx.community}` +
    `&kind=eq.${encodeURIComponent(kind)}&ref=eq.${encodeURIComponent(ref)}` +
    `&or=(event_id.eq.${ev},event_id.is.null)&select=discord_id,event_id`);
  if (!rows?.length) return null;
  // Prefer a row scoped to this tournament over a league-wide one.
  return (rows.find((r) => r.event_id === ev) || rows[0]).discord_id;
}

async function remember(ctx, kind, ref, id, eventScoped, meta) {
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/discord_objects` +
    `?on_conflict=community_id,event_id,kind,ref`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify({ community_id: ctx.community, event_id: eventScoped ? ctx.eventId : null,
                           kind, ref, discord_id: id, meta: meta || null }),
  }).catch((e) => console.error("remember", e));
}

async function call(token, path, method, body) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await sleep(retry * 1000 + 250);
    return call(token, path, method, body);
  }
  if (!r.ok) {
    let reason = `http ${r.status}`;
    try {
      const j = await r.json();
      if (j?.code === 50013) reason = "missing permissions — the bot needs Manage Channels and Manage Roles, and its role must sit above the team roles";
      else if (j?.code === 30013) reason = "this server has hit Discord's 500-channel limit";
      else reason = j?.message || reason;
    } catch { /* keep status */ }
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
