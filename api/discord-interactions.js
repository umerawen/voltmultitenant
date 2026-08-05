// api/discord-interactions.js — the endpoint Discord calls when someone runs a
// slash command. Set this URL as the "Interactions Endpoint URL" in the Discord
// developer portal.
//
// Discord signs every request. If the signature check is wrong Discord refuses to
// even save the URL, so this must be exactly right — it's verified with Node's
// built-in ed25519 rather than pulling in a dependency.
//
// Env vars needed on Vercel:
//   DISCORD_PUBLIC_KEY      — from the app's General Information page
//   SUPABASE_URL            — same project URL the app uses
//   SUPABASE_SERVICE_KEY    — service role key (server-only, never in the browser)

import crypto from "node:crypto";

export const config = { api: { bodyParser: false } };   // raw body needed for the signature

const PING = 1, APP_COMMAND = 2;
const REPLY = 4;
const EPHEMERAL = 64;                                    // only the caller sees it

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }

  const raw = await readRaw(req);
  if (!verify(req, raw)) return res.status(401).send("bad signature");

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { return res.status(400).send("bad json"); }

  if (body.type === PING) return res.status(200).json({ type: 1 });
  if (body.type !== APP_COMMAND) return res.status(200).json({ type: 1 });

  const name = body.data?.name;
  // In a guild the user is under `member`; in a DM it's `user`.
  const discordId = body.member?.user?.id || body.user?.id;
  const opt = (k) => body.data?.options?.find((o) => o.name === k)?.value;

  try {
    if (name === "link") {
      const code = String(opt("code") || "").trim();
      if (!code) return reply(res, "Give me the code from VOLT: `/link code:ABC123`");
      const r = await rpc("volt_discord_redeem", { p_code: code, p_discord_id: discordId });
      return reply(res, r?.ok
        ? `Linked. You're **${r.name}** in **${r.league}** — I'll DM you about drafts and matches.`
        : (r?.error || "Couldn't link that code."));
    }

    if (name === "status") {
      const rows = await rest(`/rest/v1/rpc/volt_discord_status`, {
        method: "POST", body: JSON.stringify({ p_guild: body.guild_id }),
      });
      if (!rows || !rows.weekend) return reply(res, "No weekend is open right now.");
      return reply(res,
        `**${rows.weekend}** — ${rows.phase.replace(/_/g, " ")}\n` +
        `Registered: **${rows.approved}** · Awaiting review: **${rows.pending}**` +
        (rows.you ? `\nYou: ${rows.you}` : `\nYou haven't signed up yet.`));
    }

    return reply(res, "Unknown command.");
  } catch (e) {
    console.error("interaction failed", name, e);
    return reply(res, "Something went wrong. Try again in a moment.");
  }
}

function reply(res, content) {
  return res.status(200).json({ type: REPLY, data: { content, flags: EPHEMERAL } });
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// Discord signs `timestamp + body` with ed25519. Node can verify it directly once
// the raw 32-byte key is wrapped in the SPKI DER header ed25519 keys use.
function verify(req, raw) {
  const sig = req.headers["x-signature-ed25519"];
  const ts = req.headers["x-signature-timestamp"];
  const pub = process.env.DISCORD_PUBLIC_KEY;
  if (!sig || !ts || !pub) return false;
  try {
    const der = Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      Buffer.from(pub, "hex"),
    ]);
    const key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
    return crypto.verify(null, Buffer.concat([Buffer.from(ts), raw]), key, Buffer.from(sig, "hex"));
  } catch (e) {
    console.error("signature check threw", e);
    return false;
  }
}

async function rest(path, init = {}) {
  const r = await fetch(process.env.SUPABASE_URL + path, {
    ...init,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return r.json();
}

const rpc = (fn, args) => rest(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
