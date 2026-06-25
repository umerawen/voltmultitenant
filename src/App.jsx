import { useState, useEffect } from "react";
import { auth, onboarding, me } from "./supabase.js";

/* ════════════════════════════════════════════════════════════════════
   VOLT League — front door
   Three states:
     1. Not signed in       → Auth screen (email+password or magic link)
     2. Signed in, no community → Onboarding (host create / player join)
     3. Signed in + onboarded   → Home (placeholder; the app grows here)
   ════════════════════════════════════════════════════════════════════ */

const HAS_SUPABASE =
  !!import.meta.env.VITE_SUPABASE_URL && !!import.meta.env.VITE_SUPABASE_ANON_KEY;

// ── tiny styled bits ───────────────────────────────────────────────
const card = {
  width: "100%", maxWidth: 440, margin: "0 auto",
  background: "rgba(13,18,30,0.85)", border: "1px solid rgba(0,229,255,0.18)",
  borderRadius: 14, padding: "28px 26px",
  boxShadow: "0 0 40px rgba(0,229,255,0.06)",
};
const label = { fontSize: 12, letterSpacing: "0.14em", textTransform: "uppercase", color: "#7fa8c9", marginBottom: 6, display: "block" };
const input = {
  width: "100%", boxSizing: "border-box", padding: "11px 13px", marginBottom: 14,
  background: "rgba(5,9,16,0.9)", border: "1px solid rgba(0,229,255,0.22)",
  borderRadius: 8, color: "#e8eef7", fontSize: 15, fontFamily: "'Rajdhani',sans-serif",
};
const btn = (primary = true) => ({
  width: "100%", padding: "12px", border: "none", borderRadius: 8, cursor: "pointer",
  fontFamily: "'Oswald',sans-serif", fontWeight: 600, fontSize: 15,
  letterSpacing: "0.1em", textTransform: "uppercase",
  background: primary ? "linear-gradient(135deg,#00e5ff,#0090ff)" : "transparent",
  color: primary ? "#04121c" : "#7fa8c9",
  outline: primary ? "none" : "1px solid rgba(0,229,255,0.25)",
  marginTop: 4,
});
const wrap = { minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 };
const head = { fontFamily: "'Oswald',sans-serif", fontSize: 30, fontWeight: 700, letterSpacing: "0.06em", margin: "0 0 4px", color: "#fff" };
const sub = { color: "#6f8bab", fontSize: 14, margin: "0 0 22px" };
const err = { background: "rgba(255,70,85,0.1)", border: "1px solid rgba(255,70,85,0.4)", color: "#ff9aa3", padding: "9px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 };
const note = { background: "rgba(61,220,132,0.08)", border: "1px solid rgba(61,220,132,0.35)", color: "#86e6b0", padding: "9px 12px", borderRadius: 8, fontSize: 13, marginBottom: 14 };

// ════════════════════════════════════════════════════════════════════
export default function App() {
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!HAS_SUPABASE) { setLoading(false); return; }
    auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = auth.onChange((s) => setSession(s));
    return () => listener?.subscription?.unsubscribe();
  }, []);

  // when signed in, load the profile (tells us if they have a community yet)
  useEffect(() => {
    if (!HAS_SUPABASE) return;
    if (!session) { setProfile(null); setLoading(false); return; }
    setLoading(true);
    me.profile().then((p) => { setProfile(p); setLoading(false); });
  }, [session]);

  if (!HAS_SUPABASE) return <ConfigNeeded />;
  if (loading) return <Centered>Loading…</Centered>;
  if (!session) return <AuthScreen />;
  if (!profile) return <Onboarding onDone={() => me.profile().then(setProfile)} />;
  return <Home profile={profile} />;
}

// ── shown until Supabase keys are added (so it never looks broken) ──
function ConfigNeeded() {
  return (
    <div style={wrap}><div style={card}>
      <h1 style={head}>VOLT League</h1>
      <p style={sub}>Almost there — the database isn't connected yet.</p>
      <div style={note}>
        Add your Supabase URL and anon key as environment variables
        (<b>VITE_SUPABASE_URL</b> and <b>VITE_SUPABASE_ANON_KEY</b>), then redeploy.
        See the README for the click-by-click steps.
      </div>
    </div></div>
  );
}

const Centered = ({ children }) => (
  <div style={wrap}><div style={{ ...card, textAlign: "center" }}>{children}</div></div>
);

// ════════════════ 1. AUTH ═══════════════════════════════════════════
function AuthScreen() {
  const [mode, setMode] = useState("signin"); // signin | signup | magic
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  async function go() {
    setMsg(null); setBusy(true);
    try {
      if (mode === "magic") {
        const { error } = await auth.sendMagicLink(email);
        if (error) throw error;
        setMsg({ ok: true, text: "Check your email for a login link." });
      } else if (mode === "signup") {
        const { error } = await auth.signUpEmail(email, pw);
        if (error) throw error;
        setMsg({ ok: true, text: "Account made! If asked, confirm via email, then sign in." });
      } else {
        const { error } = await auth.signInEmail(email, pw);
        if (error) throw error;
      }
    } catch (e) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  }

  return (
    <div style={wrap}><div style={card}>
      <h1 style={head}>VOLT League</h1>
      <p style={sub}>Sign in to run or join a league.</p>

      {msg && <div style={msg.ok ? note : err}>{msg.text}</div>}

      <label style={label}>Email</label>
      <input style={input} type="email" value={email}
        onChange={(e) => setEmail(e.target.value)} placeholder="you@email.com" />

      {mode !== "magic" && (
        <>
          <label style={label}>Password</label>
          <input style={input} type="password" value={pw}
            onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        </>
      )}

      <button style={btn(true)} disabled={busy} onClick={go}>
        {busy ? "…" :
          mode === "magic" ? "Send login link" :
          mode === "signup" ? "Create account" : "Sign in"}
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16, fontSize: 13 }}>
        <button onClick={() => setMode(mode === "signup" ? "signin" : "signup")}
          style={{ background: "none", border: "none", color: "#00e5ff", cursor: "pointer", padding: 0 }}>
          {mode === "signup" ? "Have an account? Sign in" : "New here? Create account"}
        </button>
        <button onClick={() => setMode(mode === "magic" ? "signin" : "magic")}
          style={{ background: "none", border: "none", color: "#7fa8c9", cursor: "pointer", padding: 0 }}>
          {mode === "magic" ? "Use password" : "Email me a link"}
        </button>
      </div>
    </div></div>
  );
}

// ════════════════ 2. ONBOARDING ═════════════════════════════════════
function Onboarding({ onDone }) {
  const [tab, setTab] = useState("join"); // join | host
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [commName, setCommName] = useState("");
  const [wantsCaptain, setWantsCaptain] = useState(false);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const slugify = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

  async function submit() {
    setMsg(null); setBusy(true);
    try {
      if (!name.trim()) throw new Error("Enter your display name.");
      if (tab === "host") {
        if (!commName.trim()) throw new Error("Enter a community name.");
        const { error } = await onboarding.createCommunity(commName, slugify(commName), name);
        if (error) throw error;
      } else {
        if (!code.trim()) throw new Error("Enter the community code.");
        const { error } = await onboarding.joinCommunity(slugify(code), name, wantsCaptain);
        if (error) throw error;
      }
      onDone();
    } catch (e) { setMsg({ ok: false, text: e.message }); setBusy(false); }
  }

  const tabBtn = (id, text) => (
    <button onClick={() => setTab(id)} style={{
      flex: 1, padding: "10px", cursor: "pointer", fontFamily: "'Oswald',sans-serif",
      fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", fontSize: 13,
      background: tab === id ? "rgba(0,229,255,0.12)" : "transparent",
      color: tab === id ? "#00e5ff" : "#6f8bab",
      border: "1px solid rgba(0,229,255,0.2)",
      borderRadius: 8, marginRight: id === "join" ? 8 : 0,
    }}>{text}</button>
  );

  return (
    <div style={wrap}><div style={card}>
      <h1 style={head}>Welcome</h1>
      <p style={sub}>Join a community, or start your own league.</p>

      <div style={{ display: "flex", marginBottom: 20 }}>
        {tabBtn("join", "Join as player")}
        {tabBtn("host", "Start a league")}
      </div>

      {msg && <div style={msg.ok ? note : err}>{msg.text}</div>}

      <label style={label}>Your display name</label>
      <input style={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Phoenix" />

      {tab === "join" ? (
        <>
          <label style={label}>Community code</label>
          <input style={input} value={code} onChange={(e) => setCode(e.target.value)} placeholder="given by your host" />
          <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", color: "#cfe0f0", fontSize: 14, marginBottom: 14 }}>
            <input type="checkbox" checked={wantsCaptain} onChange={(e) => setWantsCaptain(e.target.checked)} />
            I'm willing to be a captain
          </label>
        </>
      ) : (
        <>
          <label style={label}>Community name</label>
          <input style={input} value={commName} onChange={(e) => setCommName(e.target.value)} placeholder="e.g. Karachi Valorant Club" />
          <div style={{ ...note, marginTop: 0 }}>
            Your community starts inactive until it's activated. Players join using
            the code: <b>{commName ? slugify(commName) : "your-name-here"}</b>
          </div>
        </>
      )}

      <button style={btn(true)} disabled={busy} onClick={submit}>
        {busy ? "…" : tab === "host" ? "Create league" : "Join"}
      </button>

      <button onClick={() => auth.signOut()} style={{ ...btn(false), marginTop: 12 }}>Sign out</button>
    </div></div>
  );
}

// ════════════════ 3. HOME (placeholder — app grows here) ════════════
function Home({ profile }) {
  const isHost = profile.role === "host";
  return (
    <div style={{ minHeight: "100vh", padding: "40px 20px", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <h1 style={{ ...head, margin: 0 }}>VOLT League</h1>
        <button onClick={() => auth.signOut()} style={{ ...btn(false), width: "auto", padding: "8px 18px", marginTop: 0 }}>Sign out</button>
      </div>

      <div style={card}>
        <p style={sub}>
          Signed in as <b style={{ color: "#fff" }}>{profile.display_name}</b>
          {" · "}<span style={{ color: isHost ? "#f5c453" : "#00e5ff" }}>{isHost ? "HOST" : "PLAYER"}</span>
        </p>
        <p style={{ color: "#cfe0f0", lineHeight: 1.6, fontSize: 15 }}>
          Community: <b style={{ color: "#fff" }}>{profile.communities?.name}</b><br />
          Status: <b style={{ color: "#86e6b0" }}>{profile.communities?.subscription_status}</b>
          {isHost && (<><br /><br />
            Share this code so players can join: <b style={{ color: "#00e5ff" }}>{profile.communities?.slug}</b>
          </>)}
        </p>
        <div style={{ ...note, marginTop: 18 }}>
          🎉 The foundation works! Next we'll add seasons, weekend registration,
          the draft, leaderboard, and tournament — building on this exact screen.
        </div>
      </div>
    </div>
  );
}
