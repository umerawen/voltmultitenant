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
const REPLY = 4, AUTOCOMPLETE_RESULT = 8;
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

  try {
    if (body.type === AUTOCOMPLETE) return await onAutocomplete(res, body, guild);
    if (body.type === COMPONENT) return await onButton(res, body.data?.custom_id, guild, discordId);
    if (body.type === APP_COMMAND) return await onCommand(res, body, guild, discordId);
    return res.status(200).json({ type: 1 });
  } catch (e) {
    console.error("interaction failed", e);
    return reply(res, "Something went wrong. Try again in a moment.");
  }
}

/* ── slash commands ──────────────────────────────────────────────────────── */

async function onCommand(res, body, guild, discordId) {
  const name = body.data?.name;
  const opt = (k) => body.data?.options?.find((o) => o.name === k)?.value;

  if (name === "link") {
    const code = String(opt("code") || "").trim();
    if (!code) return reply(res, "Add the code from VOLT: `/link code:ABC123`");
    const r = await rpc("volt_discord_redeem", { p_code: code, p_discord_id: discordId });
    return reply(res, r?.ok
      ? `Linked. You're **${r.name}** in **${r.league}** — I'll message you about drafts and matches.`
      : (r?.error || "Couldn't link that code."));
  }

  if (name === "status") {
    const s = await rpc("volt_discord_status", { p_guild: guild });
    if (s?.error) return reply(res, s.error);
    if (!s?.weekend) return reply(res, "No weekend is open right now.");
    return reply(res,
      `**${s.weekend}** — ${s.phase.replace(/_/g, " ")}\n` +
      `Registered: **${s.approved}** · Awaiting review: **${s.pending}**`);
  }

  if (name === "me") {
    const m = await rpc("volt_dc_me", { p_guild: guild, p_discord_id: discordId });
    if (m?.error === "link") return needsLink(res);
    return reply(res,
      `**${m.name}** · ${m.rank} · ${m.role}${m.agent && m.agent !== "—" ? ` (${m.agent})` : ""}\n` +
      `KDA ${num(m.kda)} · ACS ${num(m.acs, 0)} · HS ${num(m.hs, 0)}%\n` +
      `Season: **${num(m.points, 0)}** points from ${m.matches} match${m.matches === 1 ? "" : "es"}` +
      (m.streak > 0 ? ` · 🏆 ${m.streak} weekend streak` : ""));
  }

  if (name === "roster") {
    const r = await rpc("volt_dc_roster", { p_guild: guild, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(res);
    if (r?.error === "noweekend") return reply(res, "No weekend is running.");
    if (r?.error === "noboard") return reply(res, "The draft hasn't been built yet.");
    if (r?.error === "undrafted") return reply(res, "You're not on a team this weekend — you can still be subbed in.");
    const mates = (r.mates || []).map((p) => `• ${p.name} — ${p.rank}${p.role ? ` · ${p.role}` : ""}`).join("\n");
    return reply(res,
      `**${r.team}**${r.youAreCaptain ? " — you're the captain" : `\nCaptain: ${r.captain}`}\n` +
      (mates || "_No players drafted yet._") +
      (r.budget ? `\n\nBudget left: $${Number(r.budget).toLocaleString()}` : ""));
  }

  if (name === "leaderboard") {
    const rows = await rpc("volt_dc_leaderboard", { p_guild: guild });
    if (rows?.error === "unlinked") return reply(res, "This server isn't linked to a VOLT league yet.");
    if (!rows?.length) return reply(res, "No points banked yet this season.");
    const medal = ["🥇", "🥈", "🥉"];
    return reply(res, "**Season leaderboard**\n" + rows.map((r, i) =>
      `${medal[i] || `${i + 1}.`} **${r.name}** — ${num(r.pts, 0)} pts (${r.played})`).join("\n"));
  }

  if (name === "subs") {
    const rows = await rpc("volt_dc_subs", { p_guild: guild });
    if (rows?.error === "unlinked") return reply(res, "This server isn't linked to a VOLT league yet.");
    if (rows?.error === "noweekend") return reply(res, "No weekend is running.");
    if (!rows?.length) return reply(res, "Nobody is on the reserve list right now.");
    return reply(res, "**Available to sub in**\n" + rows.map((r) =>
      `• **${r.name}** — ${r.rank}${r.discord ? ` · <@${r.discord}>` : ""}`).join("\n"));
  }

  if (name === "scout") {
    const who = String(opt("player") || "").trim();
    if (!who) return reply(res, "Give me a name: `/scout player:Rumer`");
    const p = await rpc("volt_dc_scout", { p_guild: guild, p_name: who });
    if (p?.error === "unlinked") return reply(res, "This server isn't linked to a VOLT league yet.");
    if (p?.error === "notfound") return reply(res, `No player called **${who}** in this league.`);
    const flags = [];
    if (p.suspended > 0) flags.push(`⛔ suspended for ${p.suspended} more weekend${p.suspended === 1 ? "" : "s"}`);
    if (p.strikes > 0) flags.push(`⚠ ${p.strikes} no-show${p.strikes === 1 ? "" : "s"}`);
    if (p.streak > 0) flags.push(`🏆 ${p.streak} weekend streak`);
    return reply(res,
      `**${p.name}** · ${p.rank} · ${p.role}${p.agent && p.agent !== "—" ? ` (${p.agent})` : ""}\n` +
      `KDA ${num(p.kda)} · ACS ${num(p.acs, 0)} · HS ${num(p.hs, 0)}%\n` +
      `Season: **${num(p.points, 0)}** points from ${p.matches} match${p.matches === 1 ? "" : "es"}` +
      (p.wins > 0 ? ` · ${p.wins} weekend${p.wins === 1 ? "" : "s"} won` : "") +
      (p.signedUp ? `\nThis weekend: ${p.signedUp}` : "\nNot signed up this weekend.") +
      (p.discord ? `\nDiscord: ${p.discord}` : "") +
      (flags.length ? `\n${flags.join(" · ")}` : ""));
  }

  return reply(res, "Unknown command.");
}

/* ── autocomplete ────────────────────────────────────────────────────────── */

// Fires as the user types, so they pick a real name instead of guessing spelling.
async function onAutocomplete(res, body, guild) {
  const focused = body.data?.options?.find((o) => o.focused);
  const q = String(focused?.value || "");
  let choices = [];
  try {
    const rows = await rpc("volt_dc_search", { p_guild: guild, p_query: q });
    choices = Array.isArray(rows) ? rows.slice(0, 25) : [];
  } catch (e) { console.error("autocomplete", e); }
  return res.status(200).json({ type: AUTOCOMPLETE_RESULT, data: { choices } });
}

/* ── buttons ─────────────────────────────────────────────────────────────── */

async function onButton(res, customId, guild, discordId) {
  // The whole point: registering is one tap, with no link to follow and nothing
  // to log into. Every failure says exactly what to do next.
  if (customId === "volt_register" || customId === "volt_register_captain") {
    const wantsCaptain = customId === "volt_register_captain";
    const r = await rpc("volt_dc_register", {
      p_guild: guild, p_discord_id: discordId, p_captain: wantsCaptain });

    if (r?.error === "link") return needsLink(res);
    if (r?.error === "closed") return reply(res, "Registration isn't open right now.");
    if (r?.error === "already") return reply(res, "You're already signed up for this weekend.");
    if (r?.error === "suspended") return reply(res, `You're suspended for ${r.n} more weekend${r.n === 1 ? "" : "s"}.`);
    if (r?.error === "profile") return reply(res,
      "Your scouting profile isn't finished — captains need your rank and role before they can draft you. " +
      "Complete it in VOLT, then tap Register again.");
    if (!r?.ok) return reply(res, "Couldn't sign you up. Try again in a moment.");

    return reply(res,
      (r.status === "approved"
        ? `You're in for **${r.weekend}**.`
        : `Application sent for **${r.weekend}** — the host will review it shortly.`) +
      (r.pool ? "" : "\n_The draft pool has closed, so you're signed up as a reserve._") +
      (wantsCaptain ? "\nYou've put your hand up to captain — the host decides." : ""));
  }
  if (customId === "volt_confirm") {
    const r = await rpc("volt_dc_confirm", { p_guild: guild, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(res);
    if (r?.error === "noweekend") return reply(res, "No weekend is running.");
    if (r?.error === "notin") return reply(res, "You're not signed up for this weekend.");
    return reply(res, `Thanks — you're confirmed for **${r.weekend}**. See you at the draft.`);
  }

  if (customId === "volt_withdraw") {
    const r = await rpc("volt_dc_withdraw", { p_guild: guild, p_discord_id: discordId });
    if (r?.error === "link") return needsLink(res);
    if (r?.error === "noweekend") return reply(res, "No weekend is running.");
    if (r?.error === "notin") return reply(res, "You weren't signed up for this weekend.");
    if (r?.error === "toolate") return reply(res,
      "The draft has already started, so I can't pull you out from here — message your host directly.");
    return reply(res,
      `You're out of **${r.weekend}**. No strike — telling us early is exactly right.\n` +
      `If you change your mind and registration is still open, you can sign up again.`);
  }

  return reply(res, "That button isn't recognised.");
}

/* ── plumbing ────────────────────────────────────────────────────────────── */

const num = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

function reply(res, content) {
  return res.status(200).json({ type: REPLY, data: { content, flags: EPHEMERAL } });
}
const needsLink = (res) => reply(res,
  "I don't know who you are yet. Open VOLT → your account → **Connect Discord**, then run `/link` with the code.");

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
