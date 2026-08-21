// api/discord-notify.js — VOLT calls this to reach players.
//
// Two jobs:
//   1. DM specific players ("the draft starts in 30 minutes")
//   2. Post an announcement in the league's channel
//
// The important detail: a bot can only DM someone who shares a server with it AND
// hasn't turned off DMs from server members. That's Discord error 50007, and it is
// common enough that silently swallowing it would recreate the exact problem this
// feature exists to solve. So every failure is reported back, and anyone who can't
// be DM'd gets @mentioned in the announcement channel instead.
//
// Env vars needed on Vercel:
//   DISCORD_BOT_TOKEN     — Bot section of the developer portal
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   VOLT_NOTIFY_SECRET    — shared secret so only your app can trigger sends

const API = "https://discord.com/api/v10";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  // Two ways in, so this works from the browser as well as server-to-server:
  //   1. A logged-in host/moderator calling from VOLT (Authorization: Bearer <jwt>)
  //   2. A trusted backend job (x-volt-secret)
  // The first is what the app uses — requiring a shared secret would have meant
  // putting it in the browser bundle, which would let anyone DM your whole league.
  const bySecret = (req.headers["x-volt-secret"] || "") === process.env.VOLT_NOTIFY_SECRET
                   && !!process.env.VOLT_NOTIFY_SECRET;
  let caller = null;
  if (!bySecret) {
    const jwt = (req.headers.authorization || "").replace(/^Bearer /i, "");
    if (!jwt) return res.status(401).json({ error: "unauthorized" });
    caller = await whoami(jwt);
    if (!caller) return res.status(401).json({ error: "session expired — sign in again" });
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).json({ error: "DISCORD_BOT_TOKEN is not set" });

  // `buttons: "register"` attaches the one-tap sign-up row to the announcement.
  // That's the whole point of the feature: responding should cost one click, not
  // a link, a login and a form.
  // `buttons` picks a button set; `dmButtons` attaches it to the DMs too, which
  // is what the availability check needs — the question has to be answerable
  // right there in the DM, not by going somewhere else.
  // `embed` renders the channel post as a rich embed instead of plain content.
  // Worth the extra field: an embed description holds 4096 characters against
  // 2000 for a message, and a long pinned guide would otherwise be truncated
  // mid-sentence with no error.
  // `pin` pins that post — needs Manage Messages on the bot.
  // `channelName` posts to a named channel instead of the announcements one,
  // creating it if it doesn't exist. That's how the signup guide gets its own
  // #sign-up-here without the host copying a channel ID by hand.
  // `syncRole` recomputes who holds the league's player role and fixes the
  // difference; `mentionRole` pings it on the channel post.
  const { communityId, message, userIds, announce, buttons, dmButtons, embed, pin,
          channelName, syncRole, mentionRole, roleName, buttonUrl } = req.body || {};
  if (!communityId) return res.status(400).json({ error: "communityId is required" });
  // A role-only sync sends nothing, so it legitimately has no message.
  if (!message && !syncRole) return res.status(400).json({ error: "message is required" });

  try {
    const [community] = await sb(
      `/rest/v1/communities?id=eq.${communityId}` +
      `&select=name,discord_channel_id,discord_guild_id,discord_role_id,discord_role_name`);
    if (!community) return res.status(404).json({ error: "league not found" });

    // Stamp every outgoing message with the tournament it belongs to, so a DM
    // read three days later still says what it was about. Resolved server-side
    // from one DB function rather than passed in, so the bot and the app can't
    // disagree about what the current tournament is called.
    const tag = await rpcTag(community.discord_guild_id);
    const stamp = (t) => (tag ? `-# ◈ ${tag}\n${t}` : t);

    // A browser caller must be staff of THIS league — not just any logged-in user.
    if (caller) {
      const [me] = await sb(
        `/rest/v1/users?id=eq.${caller}&select=role,community_id`);
      if (!me || me.community_id !== communityId || !["host", "moderator"].includes(me.role)) {
        return res.status(403).json({ error: "only the host or a moderator can send this" });
      }
    }

    // Resolve VOLT user ids -> Discord ids. Anyone who never linked simply can't
    // be reached, and the host needs to know that rather than assume delivery.
    let targets = [];
    let unlinked = [];
    if (Array.isArray(userIds) && userIds.length) {
      const list = userIds.map(encodeURIComponent).join(",");
      const rows = await sb(`/rest/v1/player_contacts?community_id=eq.${communityId}` +
        `&user_id=in.(${list})&select=user_id,discord_user_id`);
      const byUser = new Map(rows.map((r) => [r.user_id, r.discord_user_id]));
      for (const uid of userIds) {
        const d = byUser.get(uid);
        if (d) targets.push({ userId: uid, discordId: d });
        else unlinked.push(uid);
      }
    }

    const delivered = [];
    const blocked = [];
    for (const t of targets) {
      const r = await dm(token, t.discordId, stamp(message), dmButtons ? buttonRow(buttons, buttonUrl) : null);
      if (r.ok) delivered.push(t.userId);
      else blocked.push({ ...t, reason: r.reason });
      await sleep(250);           // stay well inside Discord's rate limits
    }

    // ── Player role ──────────────────────────────────────────────────────
    // One role per league, membership re-synced per tournament. The desired
    // membership is recomputed from the database every time rather than
    // tracked incrementally, so a sync that failed while the bot was offline
    // or missing a permission simply corrects itself on the next run.
    let roleId = community.discord_role_id || null;
    let roleSynced = null;
    let roleError = null;
    if ((syncRole || mentionRole) && community.discord_guild_id) {
      const g = community.discord_guild_id;
      const ensured = await ensureRole(token, g, roleId,
        roleName || community.discord_role_name || "VOLT Player");
      if (!ensured.ok) roleError = ensured.reason;
      else {
        if (ensured.id !== roleId) {
          roleId = ensured.id;
          await patchCommunity(communityId, { discord_role_id: roleId,
            discord_role_name: ensured.name });
        }
        if (syncRole) {
          const want = await rpc("volt_dc_role_members", { p_guild: g });
          const r = await syncRoleMembers(token, g, roleId, want?.members || [], want?.names || {});
          roleSynced = r.counts;
          if (r.reason) roleError = r.reason;
        }
      }
    }

    // Announcement, plus a mention fallback for anyone the DM couldn't reach.
    let announced = false;
    let announceError = null;
    let pinned = false;
    let pinError = null;
    let channel = community.discord_channel_id;
    let channelId = null;          // reported back so the app can remember it
    let lockError = null;

    // Reuse before create: running this twice must not leave two #sign-up-here
    // channels behind, and a host who already made one by hand should keep it.
    if (channelName && community.discord_guild_id) {
      const want = slugChannel(channelName);
      const list = await get(token, `/guilds/${community.discord_guild_id}/channels`);
      const found = Array.isArray(list.body)
        ? list.body.find((c) => c.type === 0 && c.name === want) : null;
      if (found) { channel = found.id; channelId = found.id; }
      else {
        const made = await post(token, `/guilds/${community.discord_guild_id}/channels`,
          { name: want, type: 0, topic: `How to join ${community.name} — a weekend Valorant auction-draft league. Everything you need is here.` });
        if (!made.ok) {
          return res.status(502).json({ error:
            made.reason === "dms_closed" ? "Couldn't create the channel."
              : `Couldn't create #${want} — ${made.reason}. The bot needs the Manage Channels permission.` });
        }
        channel = made.body.id; channelId = made.body.id;
      }
      // Read-only for members. A signup channel with one post in it is a sign;
      // the moment people can reply it becomes a chat and the instructions
      // scroll away, which is the whole thing this channel exists to prevent.
      // Applied to an adopted channel too, not just a freshly created one.
      lockError = await lockChannel(token, community.discord_guild_id, channel);
    }
    if (channel && (announce || blocked.length)) {
      let content = announce ? stamp(message) : "";
      // The ping goes on its own first line so the message body reads cleanly
      // whether or not a role is attached.
      if (announce && mentionRole && roleId) content = `<@&${roleId}>\n${content}`;
      if (blocked.length) {
        const mentions = blocked.map((b) => `<@${b.discordId}>`).join(" ");
        content += (content ? "\n\n" : "") +
          `${mentions}\n_(couldn't DM you — your Discord privacy settings block messages from server members)_`;
      }
      const payload = embed
        ? { embeds: [{ description: content.slice(0, 4000), color: 0x3d7bff }] }
        : { content: content.slice(0, 1900) };
      // A mention inside an embed never notifies anyone, so when we're pinging
      // the role it has to be hoisted into plain content above the embed.
      if (embed && mentionRole && roleId) payload.content = `<@&${roleId}>`;
      // Whitelist exactly what may be pinged. Without this a stray @everyone in
      // a host's message would notify the whole server.
      payload.allowed_mentions = { parse: [], roles: mentionRole && roleId ? [roleId] : [],
                                   users: blocked.map((b) => b.discordId) };
      // Mention fallbacks have to sit outside the embed — Discord does not fire
      // a notification for a mention that only appears inside one.
      if (embed && blocked.length) payload.content = blocked.map((b) => `<@${b.discordId}>`).join(" ");
      const row = buttonRow(buttons, buttonUrl);
      if (row) payload.components = row;
      const r = await post(token, `/channels/${channel}/messages`, payload);
      announced = r.ok;
      if (!r.ok) {
        console.error("announce failed", r.reason);
        announceError = r.reason === "Missing Access"
          ? "the bot can't see your announcements channel — give its role View Channel and Send Messages there"
          : r.reason === "Missing Permissions"
          ? "the bot can't post in your announcements channel — give its role Send Messages there"
          : /unknown channel/i.test(r.reason || "")
          ? "that announcements channel no longer exists — pick a new one under Discord server"
          : r.reason;
      }

      // Pinning is best-effort and reported separately. It needs Manage
      // Messages, which plenty of servers won't have granted, and a failure to
      // pin must never look like a failure to post.
      if (r.ok && pin && r.body?.id) {
        const pr = await put(token, `/channels/${channel}/pins/${r.body.id}`);
        pinned = pr.ok;
        if (!pr.ok) { pinError = pr.reason; console.error("pin failed", pr.reason); }
      }
    }

    return res.status(200).json({
      delivered: delivered.length,
      blocked: blocked.map((b) => b.userId),
      unlinked,
      announced,
      announceError,
      pinned,
      pinError,
      channelId,
      lockError,
      roleId,
      roleSynced,
      roleError,
    });
  } catch (e) {
    console.error("notify failed", e);
    return res.status(500).json({ error: "Could not reach Discord." });
  }
}

// A DM needs a channel opening first; Discord reuses it on subsequent sends.
async function dm(token, discordId, content, components) {
  const ch = await post(token, "/users/@me/channels", { recipient_id: discordId });
  if (!ch.ok) return { ok: false, reason: ch.reason };
  const payload = { content: content.slice(0, 1900) };
  if (components) payload.components = components;
  return post(token, `/channels/${ch.body.id}/messages`, payload);
}

// Button sets the bot knows how to send. custom_id has to match the handler in
// discord-interactions.js.
function buttonRow(kind, url) {
  if (kind === "register") return [{ type: 1, components: [
    { type: 2, style: 1, label: "Register", custom_id: "volt_register" },
    { type: 2, style: 2, label: "Register + captain", custom_id: "volt_register_captain" },
  ] }];
  // Labels name the matches, not the draft. "I'm in" was ambiguous once the
  // question became "are you free to play the weekend" — people read it as
  // "I'll be at the draft" and withdrew over a night they needn't attend.
  // The second label says what actually happens rather than sounding final —
  // "can't play" reads as leaving the tournament, when it only moves you to
  // reserve and you can still be subbed in.
  if (kind === "availability") return [{ type: 1, components: [
    { type: 2, style: 3, label: "I can play the matches", custom_id: "volt_confirm" },
    { type: 2, style: 2, label: "I might not be available, move me to reserve", custom_id: "volt_withdraw" },
  ] }];
  // For the pinned welcome post. Same register action, but labelled to read
  // right under a guide rather than under a one-off announcement.
  // custom_id carries the request id so the handler knows which vacancy the
  // tap refers to — a player can be asked about two at once on a bad night.
  // Prediction buttons carry the match id and the side, so one handler serves
  // every fixture without any per-match state on the bot.
  if (String(kind).startsWith("pred:")) {
    const [, id, a, b] = String(kind).split("|");
    return [{ type: 1, components: [
      { type: 2, style: 1, label: (a || "A").slice(0, 60), custom_id: `volt_pred:${id}:a` },
      { type: 2, style: 1, label: (b || "B").slice(0, 60), custom_id: `volt_pred:${id}:b` },
    ] }];
  }
  if (String(kind).startsWith("sub:")) {
    const id = String(kind).slice(4);
    return [{ type: 1, components: [
      { type: 2, style: 3, label: "I can sub", custom_id: `volt_sub_yes:${id}` },
    ] }];
  }
  // The welcome row leads with a LINK button (style 5). Link buttons open a URL
  // without firing an interaction, so a newcomer — who is the person most likely
  // to tap the first thing they see — lands on the sign-up page instead of an
  // error telling them the bot doesn't know who they are.
  //
  // The one-tap register stays, but second and explicitly labelled for people
  // who already have an account.
  if (kind === "welcome") {
    const row = [];
    if (url) row.push({ type: 2, style: 5, label: "Create your account →", url });
    row.push({ type: 2, style: 1, label: "Already signed up? Add me", custom_id: "volt_register" });
    row.push({ type: 2, style: 2, label: "…and I'll captain", custom_id: "volt_register_captain" });
    return [{ type: 1, components: row }];
  }
  return null;
}

// Pinning is a PUT with no body, so it can't go through post().
async function put(token, path, body) {
  const r = await fetch(API + path, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await sleep(retry * 1000 + 250);
    return put(token, path, body);
  }
  if (!r.ok) {
    let reason = `http ${r.status}`;
    try {
      const j = await r.json();
      // 50013 here always means the same thing: no Manage Messages.
      if (j?.code === 50013) reason = "the bot needs the Manage Messages permission to pin";
      else if (j?.code === 30003) reason = "that channel already has 50 pinned messages";
      else reason = j?.message || reason;
    } catch { /* keep the status */ }
    return { ok: false, reason };
  }
  return { ok: true };
}

// Make a channel read-only for everyone except the bot.
//
// The @everyone role always shares the guild's own ID, which is how you target
// "everybody" in a permission overwrite. The bot is a member of @everyone too,
// so denying there would silence the bot as well — hence the explicit
// member-level allow for its own user ID.
const PERM = {
  SEND_MESSAGES:            1n << 11n,
  CREATE_PUBLIC_THREADS:    1n << 35n,
  CREATE_PRIVATE_THREADS:   1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
async function lockChannel(token, guild, channel) {
  // Reactions stay allowed — they're a harmless way to acknowledge the post,
  // and blocking them buys nothing.
  const deny = (PERM.SEND_MESSAGES | PERM.CREATE_PUBLIC_THREADS
              | PERM.CREATE_PRIVATE_THREADS | PERM.SEND_MESSAGES_IN_THREADS).toString();

  const everyone = await put(token, `/channels/${channel}/permissions/${guild}`,
    { type: 0, deny, allow: "0" });          // type 0 = role
  if (!everyone.ok) {
    return `couldn't make the channel read-only — ${everyone.reason}`;
  }
  const me = await get(token, "/users/@me");
  if (me.ok && me.body?.id) {
    const self = await put(token, `/channels/${channel}/permissions/${me.body.id}`,
      { type: 1, allow: PERM.SEND_MESSAGES.toString(), deny: "0" });   // type 1 = member
    if (!self.ok) return `locked the channel but couldn't grant myself posting rights — ${self.reason}`;
  }
  return null;
}

// Find-or-create the league's player role. Prefers the stored ID so a host who
// renames it in Discord keeps the same role; falls back to matching by name so
// a role they made by hand gets adopted instead of duplicated.
async function ensureRole(token, guild, storedId, wantName) {
  const list = await get(token, `/guilds/${guild}/roles`);
  const roles = Array.isArray(list.body) ? list.body : [];
  if (storedId) {
    const still = roles.find((r) => r.id === storedId);
    if (still) return { ok: true, id: still.id, name: still.name };
    // Deleted in Discord — fall through and make a new one.
  }
  const byName = roles.find((r) => r.name.toLowerCase() === String(wantName).toLowerCase());
  if (byName) return { ok: true, id: byName.id, name: byName.name };

  const made = await post(token, `/guilds/${guild}/roles`,
    // mentionable so anyone can ping it, and hoisted so signed-up players are
    // visible in the member list — that visibility is half the point.
    { name: wantName, color: 0x3d7bff, mentionable: true, hoist: true });
  if (!made.ok) {
    return { ok: false, reason: made.reason === "Missing Permissions"
      ? "the bot needs Manage Roles to create the player role" : made.reason };
  }
  return { ok: true, id: made.body.id, name: made.body.name };
}

// Diff the role's current holders against who should hold it, then apply only
// the difference. Sending every member every time would burn rate limit on a
// 60-player league and re-notify people who already had it.
async function syncRoleMembers(token, guild, roleId, wantIds, names) {
  const want = new Set((wantIds || []).filter(Boolean).map(String));
  const counts = { added: 0, removed: 0, kept: 0, notInServer: 0 };
  let reason = null;

  // Paginate: /members caps at 1000 per page.
  let after = "0", have = [];
  for (let page = 0; page < 10; page++) {
    const r = await get(token, `/guilds/${guild}/members?limit=1000&after=${after}`);
    if (!r.ok) { return { counts, reason: "couldn't read the member list — enable the Server Members Intent for the bot" }; }
    const batch = Array.isArray(r.body) ? r.body : [];
    have = have.concat(batch);
    if (batch.length < 1000) break;
    after = batch[batch.length - 1]?.user?.id || after;
  }

  const holders = new Set(have.filter((m) => (m.roles || []).includes(roleId))
                              .map((m) => m.user?.id).filter(Boolean));
  // Everyone actually in the server. A player can link Discord and then never
  // join, or leave later — assigning a role to them returns "Unknown Member"
  // (10007), which previously aborted the report and hid the fact that the rest
  // of the sync had worked. The member list is already in hand, so skip them up
  // front and count them instead of burning a failed request each.
  const inServer = new Set(have.map((m) => m.user?.id).filter(Boolean));
  for (const id of want) {
    if (!inServer.has(id)) {
      counts.notInServer++;
      // Name them: "3 players aren't in the server" is a dead end, a list is
      // something the host can chase.
      if (names && names[id]) counts.missing = (counts.missing || []).concat(names[id]);
      continue;
    }
    if (holders.has(id)) { counts.kept++; continue; }
    const r = await put(token, `/guilds/${guild}/members/${id}/roles/${roleId}`);
    if (r.ok) counts.added++; else if (!reason) reason = r.reason;
    await sleep(250);
  }
  for (const id of holders) {
    if (want.has(id)) continue;
    const r = await del(token, `/guilds/${guild}/members/${id}/roles/${roleId}`);
    if (r.ok) counts.removed++; else if (!reason) reason = r.reason;
    await sleep(250);
  }
  return { counts, reason };
}

async function del(token, path) {
  const r = await fetch(API + path, { method: "DELETE", headers: { Authorization: `Bot ${token}` } });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await sleep(retry * 1000 + 250);
    return del(token, path);
  }
  if (!r.ok) return { ok: false, reason: r.status === 403
    ? "the bot's role must sit above the player role in Server Settings → Roles" : `http ${r.status}` };
  return { ok: true };
}

// Write back the role we created, using the service key — the browser never
// touches this, so a client can't point a league at an arbitrary role.
async function patchCommunity(id, patch) {
  try {
    await fetch(`${process.env.SUPABASE_URL}/rest/v1/communities?id=eq.${id}`, {
      method: "PATCH",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json", Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
  } catch (e) { console.error("save role", e); }
}

// Generic RPC helper, same shape as the tag lookup.
async function rpc(fn, args) {
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { console.error("rpc", fn, e); return null; }
}

// Same tag the bot's slash commands use, via the same DB function.
async function rpcTag(guild) {
  if (!guild) return null;
  try {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/volt_dc_tag`, {
      method: "POST",
      headers: {
        apikey: process.env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ p_guild: guild }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j?.tag ? String(j.tag) : null;
  } catch (e) { console.error("tag lookup", e); return null; }
}

async function get(token, path) {
  const r = await fetch(API + path, { headers: { Authorization: `Bot ${token}` } });
  if (!r.ok) return { ok: false, reason: `http ${r.status}` };
  return { ok: true, body: await r.json().catch(() => null) };
}

// Discord lowercases channel names and replaces spaces with hyphens anyway;
// doing it here means the find-or-create comparison actually matches.
function slugChannel(name) {
  return String(name).toLowerCase().trim()
    .replace(/[^a-z0-9\-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || "sign-up-here";
}

async function post(token, path, body) {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.status === 429) {                       // rate limited — wait it out once
    const retry = Number(r.headers.get("retry-after") || 1);
    await sleep(retry * 1000 + 250);
    return post(token, path, body);
  }
  if (!r.ok) {
    let reason = `http ${r.status}`;
    try {
      const j = await r.json();
      // 50007 is the one that matters: DMs are closed, not a bug on our side.
      reason = j?.code === 50007 ? "dms_closed" : (j?.message || reason);
    } catch { /* keep the status */ }
    return { ok: false, reason };
  }
  return { ok: true, body: await r.json().catch(() => ({})) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ask Supabase who this token belongs to. Returns the user id, or null if the
// token is invalid or expired — we never trust an id sent by the client.
async function whoami(jwt) {
  try {
    const r = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${jwt}` },
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u?.id || null;
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
