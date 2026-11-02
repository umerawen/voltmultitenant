// api/discord-oauth.js — one-click account linking.
//
// Replaces the code flow (open VOLT → copy a code → switch to Discord → type
// /link → hope you typed it right). Half the testers never finished that. This
// is: click Connect → Discord asks "allow VOLT?" → done.
//
// Three routes through the same file:
//   GET /api/discord-oauth?token=<supabase jwt>  → redirects to Discord, to link
//   GET /api/discord-oauth?login=1               → redirects to Discord, to sign in
//   GET /api/discord-oauth?code=...&state=...    → Discord sends them back here
//
// Signing in lands on the account VOLT already knows for that Discord user, which
// Supabase's own Discord provider can't do: it would make them a second account.
//
// Env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SUPABASE_URL, SUPABASE_SERVICE_KEY
//      (DISCORD_CLIENT_ID is the Application ID; the secret is on the OAuth2 page)

import crypto from "node:crypto";

export default async function handler(req, res) {
  const { token, code, state, error, app, login } = req.query || {};
  // Started from the phone app? Then every ending goes back into it through its
  // link scheme rather than to the website. Leg 1 has ?app=1; leg 2 reads the
  // flag from the signed state.
  let fromApp = app === "1";
  if (state) { try { fromApp = Buffer.from(String(state), "base64url").toString("utf8").split(".")[3] === "a"; } catch { /* not ours */ } }
  const origin = `https://${req.headers.host}`;
  const redirectUri = `${origin}/api/discord-oauth`;

  // Every outcome goes straight back into the app, which reopens whatever the
  // player was doing (see setResume in App.jsx) and shows the result. Ending on
  // a static page meant a "Back to VOLT" tap that dropped them on the home
  // screen with their setup gone.
  const back = (status) => {
    res.setHeader("Location", fromApp ? `com.voltleagues.app://discord?status=${status}` : `/?discord=${status}`);
    return res.status(302).end();
  };

  // The user pressed "no" on Discord's consent screen.
  if (error) return back("cancelled");

  /* ── leg 1, signing in: nobody to name yet, so the state holds a nonce that
     must come back in this browser's cookie. Without that, an attacker could
     finish their own sign-in in someone else's browser. */
  if (login) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const payload = `login-${nonce}.${Date.now()}`;
    const sig = crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY).update(payload).digest("hex").slice(0, 32);
    const st = Buffer.from(`${payload}.${sig}${fromApp ? ".a" : ""}`).toString("base64url");
    res.setHeader("Set-Cookie", `volt_dl=${nonce}; Path=/api/discord-oauth; Max-Age=600; HttpOnly; Secure; SameSite=Lax`);

    const url = new URL("https://discord.com/api/oauth2/authorize");
    url.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID.trim());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify email");
    url.searchParams.set("state", st);
    res.setHeader("Location", url.toString());
    return res.status(302).end();
  }

  /* ── leg 1: send them to Discord ─────────────────────────────────────── */
  if (token) {
    const uid = await whoami(token);
    if (!uid) return page(res, "Session expired", "Sign in to VOLT again, then retry.", false);

    // `state` carries who this is, signed so it can't be forged into linking
    // someone else's Discord account to a different VOLT account.
    const payload = `${uid}.${Date.now()}`;
    const sig = crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY).update(payload).digest("hex").slice(0, 32);
    const st = Buffer.from(`${payload}.${sig}${fromApp ? ".a" : ""}`).toString("base64url");

    const url = new URL("https://discord.com/api/oauth2/authorize");
    url.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID.trim());
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "identify");     // just who they are — nothing else
    url.searchParams.set("state", st);
    res.setHeader("Location", url.toString());
    return res.status(302).end();
  }

  /* ── leg 2: Discord sends them back ──────────────────────────────────── */
  if (code && state) {
    let uid;
    try {
      const raw = Buffer.from(String(state), "base64url").toString("utf8");
      const [id, ts, sig] = raw.split(".");
      const expect = crypto.createHmac("sha256", process.env.SUPABASE_SERVICE_KEY)
        .update(`${id}.${ts}`).digest("hex").slice(0, 32);
      // Constant-time compare, and a 10-minute window so an old link can't be replayed.
      if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) throw new Error("bad signature");
      if (Date.now() - Number(ts) > 10 * 60 * 1000) throw new Error("expired");
      if (id.startsWith("login-")) {
        const cookie = /(?:^|;\s*)volt_dl=([0-9a-f]+)/.exec(req.headers.cookie || "");
        if (!cookie || `login-${cookie[1]}` !== id) throw new Error("wrong browser");
      }
      uid = id;
    } catch {
      return back("expired");
    }

    try {
      const tokRes = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: process.env.DISCORD_CLIENT_ID.trim(),
          client_secret: process.env.DISCORD_CLIENT_SECRET.trim(),
          grant_type: "authorization_code",
          code: String(code),
          redirect_uri: redirectUri,
        }),
      });
      if (!tokRes.ok) throw new Error(`token exchange ${tokRes.status}: ${await tokRes.text()}`);
      const tok = await tokRes.json();

      const meRes = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bearer ${tok.access_token}` },
      });
      if (!meRes.ok) throw new Error(`identify ${meRes.status}`);
      const me = await meRes.json();

      if (uid.startsWith("login-")) return await finishLogin(res, me, fromApp, back);

      const r = await rpc("volt_discord_link_oauth", {
        p_user: uid, p_discord_id: me.id, p_handle: me.username,
      });
      if (!r?.ok) throw new Error(r?.error || "link failed");

      return back("linked");
    } catch (e) {
      console.error("oauth callback failed", e);
      return back("failed");
    }
  }

  return page(res, "Nothing to do", "Open VOLT and press Connect Discord.", false);
}

// Discord has vouched for this person. Find or make their account, then hand the
// browser a single-use token it exchanges for a session (see volt_login in App.jsx).
async function finishLogin(res, me, fromApp, back) {
  const verifiedEmail = me.verified && me.email ? me.email : null;
  const found = await rpc("volt_discord_login_lookup", { p_discord_id: me.id, p_email: verifiedEmail });
  if (found?.email_exists) return back("email_exists");

  const app_metadata = { discord_id: me.id, discord_handle: me.username };
  let email = found?.email;
  if (found?.id) {
    await authAdmin(`/admin/users/${found.id}`, "PUT", { app_metadata });
  } else {
    email = verifiedEmail || `discord-${me.id}@discord.invalid`;
    await authAdmin("/admin/users", "POST", { email, email_confirm: true, app_metadata,
      user_metadata: { full_name: me.global_name || me.username } });
  }

  const link = await authAdmin("/admin/generate_link", "POST", { type: "magiclink", email });
  const hashed = link?.hashed_token || link?.properties?.hashed_token;
  if (!hashed) throw new Error("no sign-in token came back");
  // After the #, so the token never reaches a server log.
  res.setHeader("Set-Cookie", "volt_dl=; Path=/api/discord-oauth; Max-Age=0; HttpOnly; Secure; SameSite=Lax");
  res.setHeader("Location", `${fromApp ? "com.voltleagues.app://auth" : "/"}#volt_login=${encodeURIComponent(hashed)}`);
  return res.status(302).end();
}

async function authAdmin(path, method, body) {
  const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`auth ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

function page(res, title, body, ok) {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(200).send(`<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;background:#0a0d18;color:#ecf3ff;margin:0;
  display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">
  <div style="max-width:420px">
    <div style="font-size:44px;margin-bottom:8px">${ok ? "✓" : "•"}</div>
    <h2 style="margin:0 0 8px;color:${ok ? "#3ddc84" : "#f5c453"}">${escapeHtml(title)}</h2>
    <p style="color:#93a4c8;line-height:1.6;margin:0 0 24px">${body}</p>
    <a href="/" style="display:inline-block;padding:11px 22px;background:#3d7bff;color:#fff;
      text-decoration:none;font-weight:600">Back to VOLT</a>
  </div>
</body>`);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
