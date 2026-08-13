// api/discord-interactions.js — everything Discord sends when someone uses the
// bot: slash commands and button clicks.
//
// Set this URL as the "Interactions Endpoint URL" in the Discord developer portal.
// Discord signs every request; the signature check below is what proves it.
//
// Env vars on Vercel:
//   DISCORD_PUBLIC_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

import crypto from "node:crypto";

export const config = { api: { bodyParser: false } };   // raw body needed for the signature

const PING = 1, APP_COMMAND = 2, COMPONENT = 3, AUTOCOMPLETE = 4;
const REPLY = 4, DEFERRED = 5, AUTOCOMPLETE_RESULT = 8;
const EPHEMERAL = 64;                                    // only the clicker sees it

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }

  const raw = await readRaw(req);
  if (!verify(req, raw)) return res.status(401).send("bad signature");

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("bad json"); }
  if (body.type === PING) return res.status(200).json({ type: 1 });

  // In a guild the user sits under `member`; in a DM it's `user`.
  const discordId = body.member?.user?.id || body.user?.id;
  const guild = body.guild_id;

  // Autocomplete is the one thing that can't be deferred — Discord wants the
  // choices in the immediate response — but it's also a single fast query.
  if (body.type === AUTOCOMPLETE) {
    try { return await onAutocomplete(res, body, guild); }
    catch (e) { console.error("autocomplete", e);
      return res.status(200).json({ type: AUTOCOMPLETE_RESULT, data: { choices: [] } }); }
  }

  // ── Everything else is DEFERRED ────────────────────────────────────────
  // Discord gives an endpoint 3 seconds to acknowledge an interaction, and
  // shows "This interaction failed" if it misses. A Vercel cold start plus two
  // Supabase round trips can exceed that, which made the sign-up button look
  // broken even when the registration succeeded — the work completed, the
  // acknowledgement just arrived too late to count.
  //
  // Answering with type 5 acknowledges instantly and buys a 15-minute window to
  // send the real message, so the reply can never race the timeout again.
  const isPublic = body.type === APP_COMMAND && body.data?.name === "rollcall";
  res.status(200).json({ type: DEFERRED, data: isPublic ? {} : { flags: EPHEMERAL } });

  const out = { content: null };
  try {
    const origin = `https://${req.headers.host}`;
    // Fetched alongside the handler rather than before it: the tag is only
    // decoration, and it shouldn't add latency to the work that matters.
    const tagP = guild ? tagFor(guild) : Promise.resolve(null);
    if (body.type === COMPONENT) await onButton(out, body.data?.custom_id, guild, discordId, origin);
    else if (body.type === APP_COMMAND) await onCommand(out, body, guild, discordId);
    ctx.tag = await tagP;
  } catch (e) {
    console.error("interaction failed", e);
    out.content = "Something went wrong. Try again in a moment.";
  }
  // Follow up on the deferred response. The interaction token is valid for 15
  // minutes and needs no bot token of its own.
  try {
    await fetch(`https://discord.com/api/v10/webhooks/${body.application_id}/${body.token}/messages/@original`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: stamp(out.content || "Done.").slice(0, 1900) }),
    });
  } catch (e) { console.error("followup failed", e); }
}

/* ── slash commands ──────────────────────────────────────────────────────── */

async function onCommand(out, body, guild, discordId) {
  const name = body.data?.name;
  const opt = (k) => body.data?.options?.find((o) => o.name === k)?.value;

  if (name === "link") {
    const code = String(opt("code") || "").trim();
    if (!code) return reply(out, "Add the code from VOLT: `/link code:ABC123`");
    // Pass the Discord username through so captains see the right handle on the
    // scouting card. The OAuth flow already does this; without it, anyone who
    // links by code shows as "Discord not connected" even though they are.
    const r = await rpc("volt_discord_redeem", {
      p_code: code,
      p_discord_id: discordId,
      p_handle: body.member?.user?.username || body.user?.username || null,
    });
    if (r?.ok) return reply(out,
      `Linked. You're **${r.name}** in **${r.league}** — I'll message you about drafts and matches.`);
    return reply(out,
      "That code didn't work — they expire after 15 minutes. Open VOLT → your account → " +
      "**Connect Discord** for a fresh one, or just use the one-click button there instead.");
  }

  // These read a league from the server they're run in, so they can't work in a DM.
  if (!guild && ["status", "leaderboard", "subs", "scout"].includes(name)) {
    return reply(out, "Run that one in your league's Discord server — I can't tell which league you mean from a DM.");
  }

  if (name === "status") {
    const s = await rpc("volt_discord_status", { p_guild: guild || null });
    if (s?.error) return reply(out, s.error);
    if (!s?.weekend) return reply(out, "No weekend is open right now.");
    return reply(out,
      `**${s.weekend}** — ${s.phase.replace(/_/g, " ")}\n` +
      `Registered: **${s.approved}** · Awaiting review: **${s.pending}**`);
  }

  if (name === "me") {
    const m = await rpc("volt_dc_me", { p_guild: guild || null, p_discord_id: discordId });
    if (m?.error === "link") return needsLink(out);
    return reply(out,
      `**${m.name}** · ${m.rank} · ${m.role}${m.agent && m.agent !== "—" ? ` (${m.agent})` : ""}\n` +
      `KDA ${num(m.kda)} · ACS ${num(m.acs, 0)} · HS ${num(m.hs, 0)}%\n` +
      `Season: **${num(m.points, 0)}** points from ${m.matches} match${m.matches === 1 ? "" : "es"}` +
      (m.streak > 0 ? ` · 🏆 ${m.streak} weekend streak` : ""));
  }

  if (name === "roster") {
    const r = await rpc("volt_dc_roster", { p_guild: guild || null, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(out);
    if (r?.error === "noweekend") return reply(out, "No weekend is running.");
    if (r?.error === "noboard") return reply(out, "The draft hasn't been built yet.");
    if (r?.error === "undrafted") return reply(out, "You're not on a team this weekend — you can still be subbed in.");
    const mates = (r.mates || []).map((p) => `• ${p.name} — ${p.rank}${p.role ? ` · ${p.role}` : ""}`).join("\n");
    return reply(out,
      `**${r.team}**${r.youAreCaptain ? " — you're the captain" : `\nCaptain: ${r.captain}`}\n` +
      (mates || "_No players drafted yet._") +
      (r.budget ? `\n\nBudget left: $${Number(r.budget).toLocaleString()}` : ""));
  }

  if (name === "leaderboard") {
    const rows = await rpc("volt_dc_leaderboard", { p_guild: guild || null });
    if (rows?.error === "unlinked") return reply(out, "This server isn't linked to a VOLT league yet.");
    if (!rows?.length) return reply(out, "No points banked yet this season.");
    const medal = ["🥇", "🥈", "🥉"];
    return reply(out, "**Season leaderboard**\n" + rows.map((r, i) =>
      `${medal[i] || `${i + 1}.`} **${r.name}** — ${num(r.pts, 0)} pts (${r.played})`).join("\n"));
  }

  if (name === "subs") {
    const rows = await rpc("volt_dc_subs", { p_guild: guild || null });
    if (rows?.error === "unlinked") return reply(out, "This server isn't linked to a VOLT league yet.");
    if (rows?.error === "noweekend") return reply(out, "No weekend is running.");
    if (!rows?.length) return reply(out, "Nobody is on the reserve list right now.");
    return reply(out, "**Available to sub in**\n" + rows.map((r) =>
      `• **${r.name}** — ${r.rank}${r.discord ? ` · <@${r.discord}>` : ""}`).join("\n"));
  }

  if (name === "rollcall") {
    const r = await rpc("volt_dc_rollcall", { p_guild: guild });
    if (r?.error === "unlinked") return reply(out, "This server isn't linked to a VOLT league yet.");
    if (r?.error === "noweekend") return reply(out, "No weekend is running.");
    const missing = r?.missing || [];
    if (!missing.length) return reply(out, "Everyone registered has connected Discord. Nothing to chase.");
    // Public on purpose — the point is that the named players actually see it.
    return reply(out,
      `**${missing.length} player${missing.length === 1 ? " hasn't" : "s haven't"} connected Discord yet**\n` +
      missing.map((m) => m.discord ? `<@${m.discord}>` : `**${m.name}**`).join(" ") +
      `\n\nOpen VOLT → your account → **Connect Discord**. Without it you won't get draft reminders or your team DM.`);
  }

  if (name === "scout") {
    const who = String(opt("player") || "").trim();
    if (!who) return reply(out, "Give me a name: `/scout player:Rumer`");
    const p = await rpc("volt_dc_scout", { p_guild: guild || null, p_name: who });
    if (p?.error === "unlinked") return reply(out, "This server isn't linked to a VOLT league yet.");
    if (p?.error === "notfound") return reply(out, `No player called **${who}** in this league.`);
    const flags = [];
    if (p.suspended > 0) flags.push(`⛔ suspended for ${p.suspended} more weekend${p.suspended === 1 ? "" : "s"}`);
    if (p.strikes > 0) flags.push(`⚠ ${p.strikes} no-show${p.strikes === 1 ? "" : "s"}`);
    if (p.streak > 0) flags.push(`🏆 ${p.streak} weekend streak`);
    return reply(out,
      `**${p.name}** · ${p.rank} · ${p.role}${p.agent && p.agent !== "—" ? ` (${p.agent})` : ""}\n` +
      `KDA ${num(p.kda)} · ACS ${num(p.acs, 0)} · HS ${num(p.hs, 0)}%\n` +
      `Season: **${num(p.points, 0)}** points from ${p.matches} match${p.matches === 1 ? "" : "es"}` +
      (p.wins > 0 ? ` · ${p.wins} weekend${p.wins === 1 ? "" : "s"} won` : "") +
      (p.signedUp ? `\nThis weekend: ${p.signedUp}` : "\nNot signed up this weekend.") +
      (p.discord ? `\nDiscord: ${p.discord}` : "") +
      (flags.length ? `\n${flags.join(" · ")}` : ""));
  }

  return reply(out, "Unknown command.");
}

/* ── autocomplete ────────────────────────────────────────────────────────── */

// Fires as the user types, so they pick a real name instead of guessing spelling.
async function onAutocomplete(res, body, guild) {
  const focused = body.data?.options?.find((o) => o.focused);
  const q = String(focused?.value || "");
  let choices = [];
  try {
    const rows = await rpc("volt_dc_search", { p_guild: guild || null, p_query: q });
    choices = Array.isArray(rows) ? rows.slice(0, 25) : [];
  } catch (e) { console.error("autocomplete", e); }
  return res.status(200).json({ type: AUTOCOMPLETE_RESULT, data: { choices } });
}

/* ── buttons ─────────────────────────────────────────────────────────────── */

async function onButton(out, customId, guild, discordId, origin) {
  // The whole point: registering is one tap, with no link to follow and nothing
  // to log into. Every failure says exactly what to do next.
  if (customId === "volt_register" || customId === "volt_register_captain") {
    const wantsCaptain = customId === "volt_register_captain";
    const r = await rpc("volt_dc_register", {
      p_guild: guild || null, p_discord_id: discordId, p_captain: wantsCaptain });

    // A newcomer pressing this button is the most common first contact anyone
    // has with VOLT. Bouncing them with "I don't know who you are" wastes it —
    // so every failure hands back the exact link that fixes it. The reply is
    // ephemeral, so the channel stays clean however many people tap it.
    if (r?.error === "link") {
      const j = joinUrl(origin, r.league);
      return reply(out,
        `**Welcome!** You're not in ${r.league?.name || "the league"} yet — it takes about a minute.\n\n` +
        `**1.** Sign up here: ${j}\n` +
        `**2.** Fill in your rank, role and a WhatsApp number.\n` +
        `**3.** Press **Connect Discord** on your profile.\n\n` +
        `Then come back and tap the button again — it'll put you straight in the pool.`);
    }
    if (r?.error === "closed") return reply(out,
      "There's no tournament open for sign-ups at the moment. I'll post in here the moment there is.");
    if (r?.error === "already") return reply(out,
      "✅ **You're already in — nothing more to do.**\n" +
      "You signed up on the site, so I've got you. I'll DM you the day before the draft to check " +
      "you're still free, and again when the draft is about to start.");
    if (r?.error === "suspended") return reply(out, `You're suspended for ${r.n} more tournament${r.n === 1 ? "" : "s"}.`);
    if (r?.error === "profile") {
      const miss = (r.missing || []).join(", ") || "a few details";
      return reply(out,
        `Almost — your profile still needs **${miss}**.\n\n` +
        `Finish it here: ${joinUrl(origin, r.league)}\n` +
        `Captains see your profile when they bid, so this is what gets you a fair price.\n\n` +
        `Then tap the button again.`);
    }
    if (!r?.ok) return reply(out, "Couldn't sign you up. Try again in a moment.");

    // Grant the player role immediately rather than waiting for the host's
    // next sync — someone who just signed up should be pingable now, and show
    // up in the member list as playing.
    await setPlayerRole(guild, discordId, true);

    return reply(out,
      (r.status === "approved"
        ? `You're in for **${r.weekend}**. I'll DM you the day before to check you're still free, and again when the draft is about to start.`
        : `Application sent for **${r.weekend}** — the host will review it shortly, and I'll let you know either way.`) +
      (r.pool ? "" : "\n_The draft pool has closed, so you're signed up as a reserve._") +
      (wantsCaptain ? "\nYou've put your hand up to captain — the host decides." : ""));
  }
  if (customId === "volt_confirm") {
    const r = await rpc("volt_dc_confirm", { p_guild: guild || null, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(out);
    if (r?.error === "noweekend") return reply(out, "No weekend is running.");
    if (r?.error === "notin") return reply(out, "You're not signed up for this weekend.");
    return reply(out, `Thanks — you're confirmed for **${r.weekend}**. See you at the draft.`);
  }

  if (customId === "volt_withdraw") {
    const r = await rpc("volt_dc_withdraw", { p_guild: guild || null, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(out);
    if (r?.error === "noweekend") return reply(out, "No weekend is running.");
    if (r?.error === "notin") return reply(out, "You weren't signed up for this weekend.");
    if (r?.error === "toolate") return reply(out,
      "The draft has already started, so I can't pull you out from here — message your host directly.");
    // Pulling out drops the role too, so the next ping doesn't reach someone
    // who already said they can't make it.
    await setPlayerRole(guild, discordId, false);
    return reply(out,
      `Thanks for telling us — you're out of the draft for **${r.weekend}**. No strike.\n` +
      `You're on the reserve list, so if you free up you can still be subbed into a match. ` +
      `Changed your mind? Tick "I'm available" again in VOLT.`);
  }

  // Offering to sub. The rank rule is enforced in volt_sub_offer, not here —
  // the DM went out minutes ago and the situation may have moved since.
  if (customId.startsWith("volt_sub_yes:")) {
    const reqId = customId.slice("volt_sub_yes:".length);
    const u = await rpc("volt_dc_user", { p_guild: guild || null, p_discord_id: discordId });
    const uid = Array.isArray(u) ? u[0]?.user_id : u?.user_id;
    if (!uid) return needsLink(out);
    const r = await rpc("volt_sub_offer", { p_request: reqId, p_user: uid });
    if (r?.error === "gone") return reply(out, "That request no longer exists.");
    if (r?.error === "closed") return reply(out, "Too late — that spot has already been filled.");
    if (r?.error === "ineligible") return reply(out,
      "You're not eligible for this one. Subs have to be a lower rank than the player they're covering, " +
      "so the team can't come out stronger than it went in.");
    if (!r?.ok) return reply(out, "Couldn't record that. Try again in a moment.");
    return reply(out,
      `Thanks — **${r.team}** knows you're available to cover for **${r.out}**.\n` +
      `The captain picks from everyone who offered, so hold tight. I'll message you either way.`);
  }

  return reply(out, "That button isn't recognised.");
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

// Per-request scratch space. Vercel gives each invocation its own module
// instance, so there's no cross-request bleed between different leagues.
const ctx = { tag: null };

// Add or remove the league's player role for one person. Best-effort by
// design: a missing permission must never turn a successful sign-up into an
// error, and the host's next full sync will correct it either way.
async function setPlayerRole(guild, discordId, grant) {
  if (!guild || !discordId) return;
  try {
    const r = await rpc("volt_dc_role_for", { p_guild: guild, p_discord_id: discordId });
    const roleId = r?.roleId;
    if (!roleId) return;                       // league hasn't set one up yet
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return;
    const resp = await fetch(
      `https://discord.com/api/v10/guilds/${guild}/members/${discordId}/roles/${roleId}`,
      { method: grant ? "PUT" : "DELETE", headers: { Authorization: `Bot ${token}` } });
    if (!resp.ok) console.error("role", grant ? "grant" : "revoke", "failed", resp.status);
  } catch (e) { console.error("setPlayerRole", e); }
}

async function tagFor(guild) {
  try {
    const t = await rpc("volt_dc_tag", { p_guild: guild });
    return t?.tag ? String(t.tag) : null;
  } catch (e) { console.error("tag lookup", e); return null; }
}

// `-#` is Discord's subtext: small and grey, so the tag labels the message
// without competing with it. Prepended in one place so every reply carries it.
const stamp = (content) => (ctx.tag ? `-# ◈ ${ctx.tag}\n${content}` : content);

// Records the reply rather than sending it. The deferred flow above does the
// sending, which means every existing `return reply(...)` call site keeps
// working with no change.
function reply(out, content) {
  if (out && typeof out === "object") out.content = content;
  return out;
}
const needsLink = (out) => reply(out,
  "I don't know who you are yet. Open VOLT → your account → **Connect Discord**. " +
  "It's one click — no code to type.");
// Deep link that pre-fills the join code, so nobody has to copy it between apps.
const joinUrl = (origin, league) =>
  league?.slug ? `${origin}/?join=${encodeURIComponent(league.slug)}` : origin;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Discord signs `timestamp + body` with ed25519. Node verifies it once the raw
// 32-byte key is wrapped in the SPKI DER header ed25519 keys use.
function verify(req, raw) {
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const pub = process.env.DISCORD_PUBLIC_KEY;
  if (!sig || !ts || !pub) return false;
  try {
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(pub, "hex")]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, "hex"));
  } catch (e) {
    console.error("signature check threw", e);
    return false;
  }
}

async function rpc(fn, args) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}
