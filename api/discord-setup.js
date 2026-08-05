// api/discord-setup.js — registers the slash commands with Discord.
//
// Visit this in your browser once after adding or changing a command:
//   https://voltmultitenant.vercel.app/api/discord-setup?secret=YOUR_VOLT_NOTIFY_SECRET
//
// Replaces the whole command set each time, so it's safe to re-run — no
// duplicates, and removing a command from the list below removes it from Discord.
//
// Env vars: DISCORD_BOT_TOKEN, VOLT_NOTIFY_SECRET

const COMMANDS = [
  {
    name: "link",
    description: "Connect your Discord account to your VOLT profile",
    options: [{ name: "code", description: "The 6-character code from VOLT", type: 3, required: true }],
  },
  { name: "status",      description: "How this weekend's registration is going" },
  { name: "me",          description: "Your rank, stats and season points" },
  { name: "roster",      description: "Your team and teammates this weekend" },
  { name: "leaderboard", description: "Season leaderboard" },
  { name: "subs",        description: "Who's available to sub in" },
];

export default async function handler(req, res) {
  // Same secret the notify endpoint uses, so there's nothing new to remember.
  // Without it, anyone who found this URL could rewrite your command list.
  const secret = req.query?.secret || req.headers["x-volt-secret"];
  if (!process.env.VOLT_NOTIFY_SECRET || secret !== process.env.VOLT_NOTIFY_SECRET) {
    return res.status(401).send("Wrong or missing secret.");
  }
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return res.status(500).send("DISCORD_BOT_TOKEN is not set on Vercel.");

  try {
    // A bot's own user id IS its application id, so there's no separate env var
    // to configure — and this doubles as a check that the token actually works.
    const meRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (!meRes.ok) {
      return res.status(502).send(`Discord rejected the bot token (${meRes.status}). ` +
        `Check DISCORD_BOT_TOKEN on Vercel — if you reset it in the developer portal, update it here too.`);
    }
    const me = await meRes.json();

    const r = await fetch(`https://discord.com/api/v10/applications/${me.id}/commands`, {
      method: "PUT",                                  // PUT replaces the entire set
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(COMMANDS),
    });
    const body = await r.json().catch(() => null);
    if (!r.ok) {
      console.error("register failed", r.status, body);
      return res.status(502).send(`Discord said no (${r.status}): ${JSON.stringify(body)}`);
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.status(200).send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#0a0d18;color:#ecf3ff;padding:40px;line-height:1.6">
  <h2 style="color:#3ddc84;margin:0 0 4px">✓ Commands registered</h2>
  <p style="color:#93a4c8;margin:0 0 20px">Bot: <b>${escapeHtml(me.username)}</b></p>
  <ul style="color:#c8d6f5">
    ${body.map((c) => `<li><code>/${escapeHtml(c.name)}</code> — ${escapeHtml(c.description)}</li>`).join("")}
  </ul>
  <p style="color:#93a4c8;margin-top:24px">
    Try one in your Discord server. They may take a minute to appear.
  </p>
</body>`);
  } catch (e) {
    console.error("discord-setup failed", e);
    return res.status(500).send("Couldn't reach Discord. Try again in a moment.");
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
