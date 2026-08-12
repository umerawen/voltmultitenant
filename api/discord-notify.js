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
  const { communityId, message, userIds, announce, buttons, dmButtons, embed, pin,
          channelName } = req.body || {};
  if (!communityId || !message) return res.status(400).json({ error: "communityId and message are required" });

  try {
    const [community] = await sb(
      `/rest/v1/communities?id=eq.${communityId}&select=name,discord_channel_id,discord_guild_id`);
    if (!community) return res.status(404).json({ error: "league not found" });

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
      const r = await dm(token, t.discordId, message, dmButtons ? buttonRow(buttons) : null);
      if (r.ok) delivered.push(t.userId);
      else blocked.push({ ...t, reason: r.reason });
      await sleep(250);           // stay well inside Discord's rate limits
    }

    // Announcement, plus a mention fallback for anyone the DM couldn't reach.
    let announced = false;
    let pinned = false;
    let pinError = null;
    let channel = community.discord_channel_id;
    let channelId = null;          // reported back so the app can remember it

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
          { name: want, type: 0, topic: `How to join ${community.name} — read the pinned post.` });
        if (!made.ok) {
          return res.status(502).json({ error:
            made.reason === "dms_closed" ? "Couldn't create the channel."
              : `Couldn't create #${want} — ${made.reason}. The bot needs the Manage Channels permission.` });
        }
        channel = made.body.id; channelId = made.body.id;
      }
    }
    if (channel && (announce || blocked.length)) {
      let content = announce ? message : "";
      if (blocked.length) {
        const mentions = blocked.map((b) => `<@${b.discordId}>`).join(" ");
        content += (content ? "\n\n" : "") +
          `${mentions}\n_(couldn't DM you — your Discord privacy settings block messages from server members)_`;
      }
      const payload = embed
        ? { embeds: [{ description: content.slice(0, 4000), color: 0x3d7bff }] }
        : { content: content.slice(0, 1900) };
      // Mention fallbacks have to sit outside the embed — Discord does not fire
      // a notification for a mention that only appears inside one.
      if (embed && blocked.length) payload.content = blocked.map((b) => `<@${b.discordId}>`).join(" ");
      const row = buttonRow(buttons);
      if (row) payload.components = row;
      const r = await post(token, `/channels/${channel}/messages`, payload);
      announced = r.ok;
      if (!r.ok) console.error("announce failed", r.reason);

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
      pinned,
      pinError,
      channelId,
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
function buttonRow(kind) {
  if (kind === "register") return [{ type: 1, components: [
    { type: 2, style: 1, label: "Register", custom_id: "volt_register" },
    { type: 2, style: 2, label: "Register + captain", custom_id: "volt_register_captain" },
  ] }];
  if (kind === "availability") return [{ type: 1, components: [
    { type: 2, style: 3, label: "I'm in", custom_id: "volt_confirm" },
    { type: 2, style: 4, label: "Can't make it", custom_id: "volt_withdraw" },
  ] }];
  // For the pinned welcome post. Same register action, but labelled to read
  // right under a guide rather than under a one-off announcement.
  if (kind === "welcome") return [{ type: 1, components: [
    { type: 2, style: 1, label: "Sign up for this tournament", custom_id: "volt_register" },
    { type: 2, style: 2, label: "Sign up + captain", custom_id: "volt_register_captain" },
  ] }];
  return null;
}

// Pinning is a PUT with no body, so it can't go through post().
async function put(token, path) {
  const r = await fetch(API + path, {
    method: "PUT",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
  });
  if (r.status === 429) {
    const retry = Number(r.headers.get("retry-after") || 1);
    await sleep(retry * 1000 + 250);
    return put(token, path);
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
