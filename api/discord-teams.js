// api/discord-teams.js — runs once when the draft finishes.
//
// Two jobs, both things a host currently does by hand:
//   1. DM every drafted player their team, captain and teammates
//   2. Create a Discord role per team and assign it, so team voice/text channels
//      work without anyone setting up permissions each weekend
//
// Roles need the bot to have Manage Roles, AND the bot's own role must sit ABOVE
// the team roles in Server Settings → Roles. Discord refuses otherwise, so role
// failures are reported rather than silently swallowed — the DMs still go out.
//
// Env: DISCORD_BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY

const API = "https://discord.com/api/v10";
const ROLE_PREFIX = "VOLT ";                  // so we only ever touch roles we made

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  // Caller must be a host or moderator of this league (browser) — same rule as notify.
  const jwt = (req.headers.authorization || "").replace(/^Bearer /i, "");
  if (!jwt) return res.status(401).json({ error: "unauthorized" });
  const uid = await whoami(jwt);
  if (!uid) return res.status(401).json({ error: "session expired — sign in again" });

  const { eventId, assignRoles = true } = req.body || {};
  if (!eventId) return res.status(400).json({ error: "eventId is required" });

  try {
    const [ev] = await sb(`/rest/v1/events?id=eq.${eventId}&select=community_id,weekend_label`);
    if (!ev) return res.status(404).json({ error: "weekend not found" });

    const [me] = await sb(`/rest/v1/users?id=eq.${uid}&select=role,community_id`);
    if (!me || me.community_id !== ev.community_id || !["host", "moderator"].includes(me.role)) {
      return res.status(403).json({ error: "only the host or a moderator can do this" });
    }

    const [community] = await sb(
      `/rest/v1/communities?id=eq.${ev.community_id}&select=discord_guild_id`);
    const guild = community?.discord_guild_id;

    // The board is the source of truth for who ended up where.
    const key = encodeURIComponent(`volt-auction-v2::${eventId}`);
    const [row] = await sb(
      `/rest/v1/community_kv?community_id=eq.${ev.community_id}&k=eq.${key}&shared=eq.true&select=val`);
    if (!row?.val) return res.status(404).json({ error: "no draft board for this weekend" });
    const board = JSON.parse(row.val);

    // Discord ids for everyone in this league who has linked.
    const contacts = await sb(
      `/rest/v1/player_contacts?community_id=eq.${ev.community_id}&discord_user_id=not.is.null&select=user_id,discord_user_id`);
    const discordOf = new Map(contacts.map((c) => [c.user_id, c.discord_user_id]));

    const existingRoles = guild && assignRoles ? await listRoles(token, guild) : [];
    // Every role this bot manages, so last weekend's team roles can be stripped.
    const voltRoleIds = new Set(existingRoles.filter((r) => r.name.startsWith(ROLE_PREFIX)).map((r) => r.id));
    const out = { dmed: 0, unlinked: 0, blocked: 0, rolesCreated: 0, rolesAssigned: 0, roleErrors: [] };

    for (const team of board.teams || []) {
      const memberIds = [
        ...(team.captainUserId ? [team.captainUserId] : []),
        ...(team.roster || []),
      ];
      const names = (team.roster || [])
        .map((id) => (board.players || []).find((p) => p.id === id))
        .filter(Boolean)
        .map((p) => `• ${p.name}${p.rank ? ` — ${p.rank}` : ""}${p.role ? ` · ${p.role}` : ""}`);

      // One role per team, reused if it already exists from a previous weekend.
      let roleId = null;
      if (guild && assignRoles) {
        const roleName = ROLE_PREFIX + team.name;
        const found = existingRoles.find((r) => r.name === roleName);
        if (found) roleId = found.id;
        else {
          const made = await createRole(token, guild, roleName, team.hue);
          if (made.ok) { roleId = made.body.id; voltRoleIds.add(roleId); out.rolesCreated++; }
          else if (!out.roleErrors.includes(made.reason)) out.roleErrors.push(made.reason);
        }
      }

      for (const uidMember of memberIds) {
        const did = discordOf.get(uidMember);
        if (!did) { out.unlinked++; continue; }

        const isCaptain = uidMember === team.captainUserId;
        const msg =
          `**You're on ${team.name}** for ${ev.weekend_label || "this weekend"}.\n` +
          (isCaptain ? "You're the captain.\n" : `Captain: ${team.captain}\n`) +
          (names.length ? `\nYour squad:\n${names.join("\n")}` : "\nNo squad yet.") +
          `\n\nUse \`/roster\` any time to see this again.`;

        const r = await dm(token, did, msg);
        if (r.ok) out.dmed++; else out.blocked++;

        if (roleId) {
          const ar = await setTeamRole(token, guild, did, roleId, voltRoleIds);
          if (ar.ok) out.rolesAssigned++;
          else if (!out.roleErrors.includes(ar.reason)) out.roleErrors.push(ar.reason);
        }
        await sleep(250);                    // stay inside Discord's rate limits
      }
    }

    return res.status(200).json(out);
  } catch (e) {
    console.error("discord-teams failed", e);
    return res.status(500).json({ error: "Couldn't finish. Some players may have been messaged." });
  }
}

/* ── discord helpers ─────────────────────────────────────────────────────── */

async function listRoles(token, guild) {
  const r = await call(token, `/guilds/${guild}/roles`, "GET");
  return r.ok && Array.isArray(r.body) ? r.body : [];
}

function createRole(token, guild, name, hue) {
  // Discord wants an integer colour; team hues are "#rrggbb" or an hsl() string.
  let color = 0;
  const m = /^#([0-9a-f]{6})$/i.exec(hue || "");
  if (m) color = parseInt(m[1], 16);
  return call(token, `/guilds/${guild}/roles`, "POST",
    { name, color, mentionable: true, hoist: false });
}

// Set a member's VOLT role to exactly one team, clearing any from previous
// weekends. Done as a single PATCH of the whole role list rather than a DELETE
// per stale role — otherwise a player who's been in five weekends costs five
// extra API calls, and rate limits start to bite on a 60-player league.
async function setTeamRole(token, guild, userId, roleId, voltRoleIds) {
  const m = await call(token, `/guilds/${guild}/members/${userId}`, "GET");
  if (!m.ok) return { ok: false, reason: m.reason };
  const current = m.body?.roles || [];
  const kept = current.filter((r) => !voltRoleIds.has(r));   // drop every VOLT role
  const next = roleId ? [...kept, roleId] : kept;
  // Nothing to change — skip the write so we don't burn a rate-limit slot.
  if (next.length === current.length && next.every((r) => current.includes(r))) {
    return { ok: true, unchanged: true };
  }
  return call(token, `/guilds/${guild}/members/${userId}`, "PATCH", { roles: next });
}

async function dm(token, discordId, content) {
  const ch = await call(token, "/users/@me/channels", "POST", { recipient_id: discordId });
  if (!ch.ok) return { ok: false, reason: ch.reason };
  return call(token, `/channels/${ch.body.id}/messages`, "POST", { content: content.slice(0, 1900) });
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
      // 50013 = Missing Permissions, and it's nearly always the role hierarchy:
      // the bot's role has to sit above the roles it's managing.
      if (j?.code === 50013) reason = "missing permissions — give the bot Manage Roles and move its role above the team roles";
      else if (j?.code === 50007) reason = "dms_closed";
      else reason = j?.message || reason;
    } catch { /* keep the status */ }
    return { ok: false, reason };
  }
  const text = await r.text();
  return { ok: true, body: text ? JSON.parse(text) : {} };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
