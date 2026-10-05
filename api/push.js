// api/push.js — phone app push notifications (Firebase Cloud Messaging).
//
// Called by the database (trigger notifications_push → volt_push_new_notifications)
// with the ids of new in-app notifications whose person has the app installed.
// Looks up their devices and sends each one through FCM; Android directly,
// iPhones through the APNs key you upload to Firebase.
//
// Env:
//   VOLT_NOTIFY_SECRET        — the shared secret the database sends (x-volt-secret)
//   SUPABASE_URL, SUPABASE_SERVICE_KEY
//   FIREBASE_SERVICE_ACCOUNT  — the service-account JSON from Firebase (Project
//                               settings → Service accounts → Generate new private key),
//                               pasted whole. Without it this does nothing.
import crypto from "node:crypto";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).end(); }
  const secret = process.env.VOLT_NOTIFY_SECRET;
  if (!secret || req.headers["x-volt-secret"] !== secret) return res.status(401).json({ error: "unauthorized" });

  let sa = null;
  try { sa = process.env.FIREBASE_SERVICE_ACCOUNT ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT) : null; } catch { sa = null; }
  if (!sa?.client_email || !sa?.private_key || !sa?.project_id) return res.status(200).json({ skipped: "push not configured" });

  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).filter((x) => /^[0-9a-f-]{36}$/i.test(String(x))).slice(0, 500);
  if (!ids.length) return res.status(200).json({ sent: 0 });

  try {
    const notes = await rest(`notifications?id=in.(${ids.join(",")})&select=id,user_id,kind,title,body,event_id`);
    const users = [...new Set(notes.map((n) => n.user_id))];
    if (!users.length) return res.status(200).json({ sent: 0 });
    const toks = await rest(`push_tokens?user_id=in.(${users.join(",")})&select=token,user_id`);
    const byUser = {};
    toks.forEach((t) => { (byUser[t.user_id] = byUser[t.user_id] || []).push(t.token); });

    const access = await googleToken(sa);
    const jobs = [];
    for (const n of notes) for (const token of byUser[n.user_id] || []) jobs.push({ n, token });

    let sent = 0; const dead = [];
    for (let i = 0; i < jobs.length; i += 50) {
      await Promise.all(jobs.slice(i, i + 50).map(async ({ n, token }) => {
        const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
          method: "POST",
          headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: {
            token,
            notification: { title: n.title, body: n.body || "" },
            data: { kind: String(n.kind || ""), event_id: String(n.event_id || ""), notification_id: String(n.id) },
            android: { priority: "HIGH", notification: { color: "#3D7BFF", sound: "default" } },
            apns: { payload: { aps: { sound: "default" } } },
          } }),
        });
        if (r.ok) { sent++; return; }
        const err = await r.text();
        // The app was uninstalled or the token rotated: forget it.
        if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT.*registration/i.test(err)) dead.push(token);
        else console.error("fcm", r.status, err.slice(0, 300));
      }));
    }
    if (dead.length) await rest(`push_tokens?token=in.(${dead.map((t) => `"${t}"`).join(",")})`, "DELETE");
    return res.status(200).json({ sent, removed: dead.length });
  } catch (e) {
    console.error("push failed", e);
    return res.status(500).json({ error: "push failed" });
  }
}

async function rest(pathAndQuery, method = "GET") {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
    method,
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` },
  });
  if (!r.ok) throw new Error(`supabase ${r.status}: ${await r.text()}`);
  return method === "GET" ? r.json() : null;
}

// An OAuth access token for FCM from the service account (a signed JWT
// exchanged at Google's token endpoint), cached while it's valid.
let cached = { token: null, exp: 0 };
async function googleToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  if (cached.token && cached.exp - 60 > now) return cached.token;
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${enc({ alg: "RS256", typ: "JWT" })}.${enc({
    iss: sa.client_email, scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
  })}`;
  const sig = crypto.createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
  });
  if (!r.ok) throw new Error(`google token ${r.status}: ${await r.text()}`);
  const j = await r.json();
  cached = { token: j.access_token, exp: now + (j.expires_in || 3600) };
  return cached.token;
}
