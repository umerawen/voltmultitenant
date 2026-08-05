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
  const { communityId, message, userIds, announce, buttons } = req.body || {};
  if (!communityId || !message) return res.status(400).json({ error: "communityId and message are required" });

  try {
    const [community] = await sb(
      `/rest/v1/communities?id=eq.${communityId}&select=name,discord_channel_id`);
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
      const r = await dm(token, t.discordId, message);
      if (r.ok) delivered.push(t.userId);
      else blocked.push({ ...t, reason: r.reason });
      await sleep(250);           // stay well inside Discord's rate limits
    }

    // Announcement, plus a mention fallback for anyone the DM couldn't reach.
    let announced = false;
    const channel = community.discord_channel_id;
    if (channel && (announce || blocked.length)) {
      let content = announce ? message : "";
      if (blocked.length) {
        const mentions = blocked.map((b) => `<@${b.discordId}>`).join(" ");
        content += (content ? "\n\n" : "") +
          `${mentions}\n_(couldn't DM you — your Discord privacy settings block messages from server members)_`;
      }
      const payload = { content: content.slice(0, 1900) };
      if (buttons === "register") {
        payload.components = [{
          type: 1,                                  // action row
          components: [
            { type: 2, style: 1, label: "Register", custom_id: "volt_register" },
            { type: 2, style: 2, label: "Register + captain", custom_id: "volt_register_captain" },
          ],
        }];
      }
      const r = await post(token, `/channels/${channel}/messages`, payload);
      announced = r.ok;
      if (!r.ok) console.error("announce failed", r.reason);
    }

    return res.status(200).json({
      delivered: delivered.length,
      blocked: blocked.map((b) => b.userId),
      unlinked,
      announced,
    });
  } catch (e) {
    console.error("notify failed", e);
    return res.status(500).json({ error: "Could not reach Discord." });
  }
}

// A DM needs a channel opening first; Discord reuses it on subsequent sends.
async function dm(token, discordId, content) {
  const ch = await post(token, "/users/@me/channels", { recipient_id: discordId });
  if (!ch.ok) return { ok: false, reason: ch.reason };
  return post(token, `/channels/${ch.body.id}/messages`, { content: content.slice(0, 1900) });
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
