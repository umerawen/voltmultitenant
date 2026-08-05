// register-commands.mjs — run ONCE from your computer to tell Discord which slash
// commands exist. Re-run only when you add or change a command.
//
//   node register-commands.mjs
//
// Needs two values from the Discord developer portal:
const APP_ID    = process.env.DISCORD_APP_ID;      // General Information → Application ID
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;   // Bot → Reset Token

const commands = [
  {
    name: "link",
    description: "Connect your Discord account to your VOLT profile",
    options: [{ name: "code", description: "The 6-character code from VOLT", type: 3, required: true }],
  },
  { name: "status", description: "How this weekend's registration is going" },
];

const r = await fetch(`https://discord.com/api/v10/applications/${APP_ID}/commands`, {
  method: "PUT",                                   // PUT replaces the whole set
  headers: { Authorization: `Bot ${BOT_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify(commands),
});
console.log(r.ok ? "✓ commands registered" : `✗ ${r.status}: ${await r.text()}`);
