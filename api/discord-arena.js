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
  // Writable, not read-only: people run /scout in here, and a denied
  // Send Messages blocks slash commands along with typing.
  // Read-only: the bot posts the fixture, everyone answers with the buttons.
  { ref: "predictions", name: "predictions", type: 0, readOnly: true,
    topic: "Call the winner before each match. Closes at kick-off." },
  { ref: "scout",     name: "scout",      type: 0, readOnly: false,
    topic: "Look anyone up with /scout. Everyone sees who's been scouted." },
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

  // Done in three parallel phases rather than team-by-team.
  //
  // Sequentially this was a role POST, then a PUT per member with an 80ms
  // sleep, then two channel POSTs — about 1.8s per team, so six teams needed
  // ~11s against an 8s budget and only the first few ever got built. Discord
  // rate-limits per route and call() already backs off on 429, so a bounded
  // pool is both faster and safe.
  const pool = async (items, n, fn) => {
    const queue = items.slice();
    await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
      while (queue.length) {
        if (outOfTime(ctx, out)) return;
        await fn(queue.shift());
      }
    }));
  };

  // 1. Roles. Reused by name so a previous run's roles are adopted, never doubled.
  const roleOf = new Map();
  await pool(teams, 3, async (t) => {
    const roleName = `VOLT ${t.name}`;
    const found = existingRoles.find((r) => r.name === roleName);
    if (found) { roleOf.set(t.name, found.id); out.reused.push(roleName); return; }
    const made = await call(ctx.token, `/guilds/${ctx.guild}/roles`, "POST",
      { name: roleName, color: hexToInt(t.hue) ?? 0x3d7bff, mentionable: true, hoist: false });
    if (!made.ok) { out.errors.push(`role ${t.name}: ${made.reason}`); return; }
    roleOf.set(t.name, made.body.id);
    out.created.push(roleName);
  });
  for (const t of teams) {
    const id = roleOf.get(t.name);
    if (id) await remember(ctx, "role", t.name, id, true, null, out);
  }
  out.teams = roleOf.size;

  // 2. Channels. ensureChannel mutates ctx.channels, so these stay sequential —
  //    two teams racing could otherwise both decide a channel is missing.
  for (const t of teams) {
    const roleId = roleOf.get(t.name);
    if (!roleId || outOfTime(ctx, out)) continue;
    const overwrites = [
      { id: ctx.guild, type: 0, deny: P.VIEW.toString(), allow: "0" },
      { id: roleId, type: 0, allow: (P.VIEW | P.SEND | P.CONNECT | P.SPEAK).toString(), deny: "0" },
    ];
    if (ctx.me) overwrites.push({ id: ctx.me, type: 1,
      allow: (P.VIEW | P.SEND | P.CONNECT | P.SPEAK).toString(), deny: "0" });
    await ensureChannel(ctx, { ref: `team-text:${t.name}`, name: `${slug(t.name)}-room`, type: 0,
      parent_id: cat, eventScoped: true, permission_overwrites: overwrites,
      topic: `${t.name} only. Captain: ${t.captain || "—"}` }, out);
    await ensureChannel(ctx, { ref: `team-vc:${t.name}`, name: t.name, type: 2,
      parent_id: cat, eventScoped: true, permission_overwrites: overwrites }, out);
  }

  // 3. Member roles — the bulk of the calls, and fully independent of each other.
  const grants = [];
  for (const t of teams) {
    const roleId = roleOf.get(t.name);
    if (!roleId) continue;
    for (const did of t.discordIds || []) grants.push({ did, roleId, team: t.name });
  }
  await pool(grants, 5, async (g) => {
    const r = await call(ctx.token, `/guilds/${ctx.guild}/members/${g.did}/roles/${g.roleId}`, "PUT");
    if (r.ok) out.assigned++;
    else if (/unknown member/i.test(r.reason || "")) {
      if (!out.errors.some((e) => e.startsWith("Some players aren't"))) {
        out.errors.push("Some players aren't in this Discord server, so they couldn't be given their team role.");
      }
    } else if (!out.errors.some((e) => e.startsWith("assign"))) {
      out.errors.push(`assign: ${r.reason}`);
    }
  });

  return out;
}

/* ── results + standings ─────────────────────────────────────────────────── */

async function postResult(ctx, payload) {
  const ch = await liveChannel(ctx, "results");
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
  const ch = await liveChannel(ctx, "fixtures");
  const f = await rpc("volt_dc_fixtures", { p_event: ctx.eventId });
  if (f?.error === "noboard") throw new Error("There's no draft board yet.");
  if (f?.error === "nofixtures") throw new Error("No fixtures have been built yet — set the format and lock the schedule first.");
  const list = f.matches || [];
  if (!list.length) throw new Error("The schedule is empty.");

  // Group by the day a match is actually played, not by round.
  //
  // Rounds are a bracket concept: "Matchday 1" happily contained both Saturday
  // and Sunday games, which is exactly the thing a player scanning for their
  // own fixture gets wrong. Unscheduled matches fall into their own group at
  // the end rather than being silently attached to a day.
  const dayKey = (m) => (m.at ? new Date(m.at).toISOString().slice(0, 10) : "tba");
  const groups = new Map();
  for (const m of list) {
    const k = dayKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "tba" ? 1 : b === "tba" ? -1 : a < b ? -1 : 1));

  const dayName = (k) => {
    if (k === "tba") return "Time to be confirmed";
    const d = new Date(k + "T12:00:00Z");
    return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  };

  const blocks = keys.map((k) => {
    const rows = groups.get(k)
      .sort((a, b) => (a.at || "").localeCompare(b.at || ""))
      .map((m) => {
        if (m.done) {
          return `~~${m.a}  vs  ${m.b}~~\n**${m.winner || "Result in"}** won`;
        }
        // <t:unix:t> is the local clock time for each reader — the whole reason
        // this lives in Discord rather than on the site.
        const when = m.at ? `<t:${Math.floor(new Date(m.at).getTime() / 1000)}:t>` : "time TBA";
        return `**${m.a}**  vs  **${m.b}**\n${when}${m.bo ? `  ·  Bo${m.bo}` : ""}`;
      });
    return `### ${dayName(k)}\n\n${rows.join("\n\n")}`;
  });

  const header = `# Fixtures — ${f.tag || ctx.ev.weekend_label || "Tournament"}`;
  const body = [header, "", blocks.join("\n\n"), "",
    "-# Times shown in your own timezone. Be in voice ten minutes before yours."].join("\n");

  // Plain content, not an embed: Discord renders embed text a size smaller and
  // shrinks the headings with it, which is what made this cramped. Fall back to
  // an embed only if a long schedule would breach the 2000-character limit.
  const useEmbed = body.length > 1900;
  const payload = useEmbed
    ? { embeds: [{ description: body.slice(0, 4000), color: 0x3d7bff }] }
    : { content: body };

  // Ping the player role so the schedule actually reaches people.
  if (ctx.c.discord_role_id) {
    const ping = `<@&${ctx.c.discord_role_id}>`;
    if (useEmbed) payload.content = ping;
    else payload.content = `${ping}\n\n${body}`.slice(0, 1990);
    payload.allowed_mentions = { parse: [], roles: [ctx.c.discord_role_id] };
  } else {
    payload.allowed_mentions = { parse: [] };
  }

  const prior = await lookup(ctx, "message", "fixtures");
  if (prior) {
    const upd = await call(ctx.token, `/channels/${ch}/messages/${prior}`, "PATCH", payload);
    if (upd.ok) return { ok: true, edited: true, matches: list.length };
    // Deleted by hand — fall through and post a fresh one.
  }
  const r = await call(ctx.token, `/channels/${ch}/messages`, "POST", payload);
  if (!r.ok) throw new Error(`Couldn't post fixtures — ${r.reason}`);
  await remember(ctx, "message", "fixtures", r.body.id, false, { channel: ch });
  return { ok: true, edited: false, matches: list.length };
}

async function postStandings(ctx) {
  const ch = await liveChannel(ctx, "standings");
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
    await remember(ctx, kind, spec.ref, found.id, spec.eventScoped, null, out);
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
  await remember(ctx, kind, spec.ref, made.body.id, spec.eventScoped, null, out);
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

// Resolve a channel and confirm it still exists in Discord. Hosts rename and
// delete channels freely, so a stored ID is a hint, not a guarantee.
async function liveChannel(ctx, ref) {
  const id = await lookup(ctx, "text", ref);
  if (!id) throw new Error(`Run “Set up channels” first — there's no #${ref} channel yet.`);
  const still = await call(ctx.token, `/channels/${id}`, "GET");
  if (!still.ok) {
    throw new Error(`#${ref} has been deleted or the bot can't see it. Press “Set up channels” to rebuild it.`);
  }
  return id;
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

// Record what we made. A silent failure here is expensive rather than
// cosmetic: without the registry, "find or create" falls back to matching by
// name, and posted standings/fixtures messages can never be found again to be
// edited in place. So the error is surfaced, not swallowed.
async function remember(ctx, kind, ref, id, eventScoped, meta, out) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/discord_objects` +
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
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error("remember failed", kind, ref, r.status, txt);
      if (out && !out.errors.some((e) => e.startsWith("Couldn't record"))) {
        out.errors.push("Couldn't record what was created — re-running may duplicate channels.");
      }
    }
  } catch (e) { console.error("remember", e); }
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
