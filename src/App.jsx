import { useState, useEffect, useRef, useCallback, useId, memo, lazy, Suspense } from "react";
import { IS_NATIVE, SITE, apiUrl, siteOrigin, openAuthUrl, haptic, registerPush } from "./native.js";
import { createPortal } from "react-dom";
import { createClient } from "@supabase/supabase-js";

// ── Multi-tenant storage layer ──────────────────────────────────────────
// The old app talks to `window.storage.get/set(key, shared)`. We keep that
// exact interface but back it with Supabase, scoped to the current community.
// Everything downstream (readState/writeState, war rooms, presence) is
// untouched — only where the bytes live changes.
//
// `shared=true`  → community-wide state (the draft board, presence)
// `shared=false` → per-user private state (a captain's war room)
//
// Rows live in `community_kv (community_id, k, val, shared, user_id, updated_at)`.
const HAS_SUPABASE = !!(import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY);
// Marketing captures: the offline preview with ?demo=<scene> fills the app with
// invented players (src/demo.js, loaded on demand). Never active with Supabase.
const DEMO = !HAS_SUPABASE && typeof location !== "undefined" ? new URLSearchParams(location.search).get("demo") : null;
const loadDemo = () => import("./demo.js");

// The tournament shell (draft room, fixtures, match reports: most of the app)
// lives in tournament.jsx and is fetched on demand, so the landing page, sign-in
// and hub open without it. The hub starts the download once it has painted, so
// entering a tournament rarely waits.
//
// Every deploy replaces the hashed files. A tab still running the previous
// build can't fetch its old copy any more, so a failed load reloads the page
// once to pick up the new build.
const loadTournament = () => import("./tournament.jsx").then(
  (m) => { try { sessionStorage.removeItem("volt.chunkReload"); } catch (e) { /* private mode */ } return m; },
  (err) => {
    let tried = true;
    try { tried = !!sessionStorage.getItem("volt.chunkReload"); sessionStorage.setItem("volt.chunkReload", "1"); } catch (e) { /* private mode */ }
    if (!tried) { window.location.reload(); return new Promise(() => {}); }
    throw err;
  });
function TournamentLoadFailed() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0d18", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", padding: 24, textAlign: "center" }}>
      <div>
        <p style={{ fontSize: 18, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 0 6px" }}>Couldn't load the tournament</p>
        <p style={{ fontSize: 14, color: "rgba(214,226,255,0.7)", margin: "0 0 16px" }}>Check your connection and try again.</p>
        <button onClick={() => window.location.reload()} style={{ padding: "10px 20px", fontFamily: "inherit", fontWeight: 700, fontSize: 13, letterSpacing: "0.1em", textTransform: "uppercase", color: "#0a0d18", background: "#3ddc84", border: "none", cursor: "pointer" }}>Reload</button>
      </div>
    </div>
  );
}
const WeekendApp = lazy(() => loadTournament().then(
  (m) => ({ default: m.WeekendApp }),
  () => ({ default: TournamentLoadFailed })));
function TournamentLoading() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", background: "#0a0d18", color: "rgba(200,215,255,0.55)", fontFamily: "'Rajdhani',sans-serif", fontSize: 13, fontWeight: 700, letterSpacing: "0.3em", textTransform: "uppercase" }}>
      Loading tournament…
    </div>
  );
}
let __sb = null;
// Read before createClient: the client consumes the URL hash of a password-reset
// link while it initialises, so by the time React mounts the marker is gone.
const __RECOVERY_AT_LOAD = typeof window !== "undefined" && /type=recovery/.test(window.location.hash || "");
if (HAS_SUPABASE) __sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

// A device clock can be wrong, sometimes by hours, and predictions lock at
// kick-off. So "now" is the server's: measure how far this device is off and
// correct for it. voltNow() is what every deadline and countdown reads.
let __clockSkew = 0;
const voltNow = () => Date.now() + __clockSkew;
async function syncClock() {
  if (!HAS_SUPABASE) return;
  try {
    const t0 = Date.now();
    const { data, error } = await __sb.rpc("volt_now");
    const t1 = Date.now();
    if (error || !Number.isFinite(Number(data)) || t1 - t0 > 5000) return;   // too slow a round trip to trust
    const skew = Number(data) - (t0 + t1) / 2;
    __clockSkew = Math.abs(skew) < 2000 ? 0 : Math.round(skew);              // under 2s is network jitter
  } catch (e) { console.error("clock sync", e); }
}
if (HAS_SUPABASE && typeof document !== "undefined") {
  syncClock();
  setInterval(() => { if (document.visibilityState === "visible") syncClock(); }, 10 * 60 * 1000);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") syncClock(); });
}


// Set after login/community-select. Until then, storage is a no-op-ish memory map.
window.__VOLT = window.__VOLT || { communityId: null, userId: null };

if (typeof window !== "undefined") {
  const __mem = new Map();
  const memKey = (key, shared) => (shared ? "s:" : "p:") + (shared ? "" : (window.__VOLT.userId || "anon") + ":") + key;
  const memGet = (key, shared) => { const v = __mem.get(memKey(key, shared)); return v === undefined ? null : { key, value: v, shared: !!shared }; };
  const memSet = (key, value, shared) => { __mem.set(memKey(key, shared), value); return { key, value, shared: !!shared }; };

  window.storage = {
    async get(key, shared) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) return memGet(key, shared);
      try {
        let q = __sb.from("community_kv").select("val, updated_at").eq("community_id", cid).eq("k", key).eq("shared", !!shared);
        if (!shared) q = q.eq("user_id", window.__VOLT.userId);
        const { data } = await q.maybeSingle();
        return data ? { key, value: data.val, updatedAt: data.updated_at, shared: !!shared } : null;
      } catch (e) { console.error("storage.get", e); return memGet(key, shared); }
    },
    // Conditional GET — the single biggest egress saver. A poll first fetches
    // ONLY the row's `updated_at` (a timestamp, a few bytes) instead of the whole
    // `val` blob (which for the auction board is 100+ KB). The large column is
    // downloaded ONLY when the row is newer than what the caller already holds.
    // `sinceUpdatedAt` is the updatedAt the caller last saw (from a prior get).
    // Returns:
    //   { unchanged: true }                          → row not newer; nothing downloaded
    //   { key, value, updatedAt, shared }            → row is newer; full value included
    //   null                                         → row does not exist
    async getIfChanged(key, shared, sinceUpdatedAt) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) return memGet(key, shared); // memory path: no metering, just return value
      try {
        // 1) Cheap probe: timestamp only.
        let probe = __sb.from("community_kv").select("updated_at").eq("community_id", cid).eq("k", key).eq("shared", !!shared);
        if (!shared) probe = probe.eq("user_id", window.__VOLT.userId);
        // A failed read must throw, not look like "no board": the draft used
        // to build a fresh board when a read failed, overwriting a live auction.
        const { data: meta, error: probeErr } = await probe.maybeSingle();
        if (probeErr) throw probeErr;
        if (!meta) return null;
        if (sinceUpdatedAt && meta.updated_at && meta.updated_at <= sinceUpdatedAt) {
          return { unchanged: true, updatedAt: meta.updated_at };
        }
        // 2) It changed (or caller had nothing) → fetch the full value once.
        let full = __sb.from("community_kv").select("val, updated_at").eq("community_id", cid).eq("k", key).eq("shared", !!shared);
        if (!shared) full = full.eq("user_id", window.__VOLT.userId);
        const { data, error: fullErr } = await full.maybeSingle();
        if (fullErr) throw fullErr;
        return data ? { key, value: data.val, updatedAt: data.updated_at, shared: !!shared } : null;
      } catch (e) { console.error("storage.getIfChanged", e); throw e; }
    },
    async set(key, value, shared) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) return memSet(key, value, shared);
      try {
        const row = { community_id: cid, k: key, val: value, shared: !!shared, user_id: shared ? null : window.__VOLT.userId, updated_at: new Date().toISOString() };
        const { error } = await __sb.from("community_kv").upsert(row, { onConflict: "community_id,k,shared,user_id" });
        if (error) {
          console.error("storage.set failed:", error.message, { key, shared });
          memSet(key, value, shared);              // keep the value locally…
          throw new Error(error.message || "Save failed"); // …but never claim success
        }
        return { key, value, shared: !!shared };
      } catch (e) {
        console.error("storage.set", e);
        memSet(key, value, shared);
        throw e;                                   // let callers know it didn't persist
      }
    },
    // Compare-and-swap on a shared row. `expected` is the updatedAt this client
    // last saw; the write only lands if the row still carries it. On conflict it
    // returns { ok:false, ... } plus whatever actually won, so the caller can
    // re-apply its change on top rather than overwriting someone else's.
    // expected == null means "write unconditionally" (first build, rebuild, reset).
    async cas(key, expected, value) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) { memSet(key, value, true); return { ok: true, updatedAt: new Date().toISOString(), value }; }
      const { data, error } = await __sb.rpc("volt_kv_cas", { p_community: cid, p_key: key, p_expected: expected || null, p_val: value });
      if (error) {
        console.error("storage.cas failed:", error.message, { key });
        memSet(key, value, true);
        throw new Error(error.message || "Save failed");
      }
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) throw new Error("Save failed — no response from server");
      return { ok: !!row.ok, updatedAt: row.new_updated_at || null, value: row.cur_val ?? null };
    },
    async delete(key, shared) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) { const had = __mem.delete(memKey(key, shared)); return { key, deleted: had, shared: !!shared }; }
      try {
        let q = __sb.from("community_kv").delete().eq("community_id", cid).eq("k", key).eq("shared", !!shared);
        if (!shared) q = q.eq("user_id", window.__VOLT.userId);
        await q; return { key, deleted: true, shared: !!shared };
      } catch (e) { console.error("storage.delete", e); return { key, deleted: false, shared: !!shared }; }
    },
    async list(prefix, shared) {
      const cid = window.__VOLT.communityId;
      if (!HAS_SUPABASE || !cid) {
        const pfx = (shared ? "s:" : "p:") + (prefix || "");
        const keys = [...__mem.keys()].filter(x => x.startsWith(pfx)).map(x => x.slice(2));
        return { keys, prefix, shared: !!shared };
      }
      try {
        let q = __sb.from("community_kv").select("k").eq("community_id", cid).eq("shared", !!shared).like("k", (prefix || "") + "%");
        if (!shared) q = q.eq("user_id", window.__VOLT.userId);
        const { data } = await q;
        return { keys: (data || []).map(r => r.k), prefix, shared: !!shared };
      } catch (e) { console.error("storage.list", e); return { keys: [], prefix, shared: !!shared }; }
    },
  };
}


/* ── embedded agent artwork (data URIs, self-contained) ── */
// Landing/auth background — user-supplied art, embedded WebP (2000w, q72).
const IMG_GATE_BG = "/img/gate-bg.webp";
// ── Icons ────────────────────────────────────────────────────────────────
// One set, drawn for VOLT: 24px grid, 1.75 stroke, square ends and mitred
// joins so they share the angular, notched feel of the panels. They replace
// a mix of unicode symbols and emoji that rendered at different sizes and
// weights on every platform. Colour comes from currentColor.
const ICON_PATHS = {
  dashboard:   "M12 2.5l9.5 9.5-9.5 9.5L2.5 12zM12 8l4 4-4 4-4-4z",
  overview:    "M12 2.5l9.5 9.5-9.5 9.5L2.5 12zM12 8l4 4-4 4-4-4z",   // same as dashboard: each is its page's main view
  pool:        "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20v-.5A6.5 6.5 0 0 1 9 13a6.5 6.5 0 0 1 6.5 6.5v.5M16 4.3a3.5 3.5 0 0 1 0 6.4M21.5 20v-.5a6.5 6.5 0 0 0-3.8-5.9",
  auction:     "M13.5 3.5l7 7-3 3-7-7zM12 8L4 16l2 2 8-8M3 21h11",
  reserve:     "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20v-.5A6.5 6.5 0 0 1 9 13a6.5 6.5 0 0 1 6.5 6.5v.5M19 8v6M16 11h6",
  rosters:     "M12 2.5l8 3v6c0 4.8-3.4 8.6-8 10-4.6-1.4-8-5.2-8-10v-6zM8.5 10.5h7M8.5 14h7",
  mock:        "M12 3v4M12 17v4M3 12h4M17 12h4M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  fixtures:    "M2 4h5v5H2M7 6.5h5M2 15h5v5H2M7 17.5h5M12 6.5v11M12 12h4M16 9h6v6h-6z",  // a bracket: two pairs into a final
  leaderboard: "M3 14h5v7H3zM9.5 5h5v16h-5zM16 10h5v11h-5z",
  veto:        "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8",
  season:      "M7 4h10v5a5 5 0 0 1-10 0zM7 6H3.5v2A3.5 3.5 0 0 0 7 11.5M17 6h3.5v2a3.5 3.5 0 0 1-3.5 3.5M12 14v4M8 21h8M9.5 18h5",
  trophy:      "M7 4h10v5a5 5 0 0 1-10 0zM7 6H3.5v2A3.5 3.5 0 0 0 7 11.5M17 6h3.5v2a3.5 3.5 0 0 1-3.5 3.5M12 14v4M8 21h8M9.5 18h5",
  history:     "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2.5",
  discord:     "M3 4h18v12H9l-6 4.5zM8 10h.01M12 10h.01M16 10h.01",
  account:     "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21v-.5a8 8 0 0 1 16 0v.5",
  soundOn:     "M3 9h4l5-4.5v15L7 15H3zM16 9.5a3.5 3.5 0 0 1 0 5M18.5 6.5a8 8 0 0 1 0 11",
  soundOff:    "M3 9h4l5-4.5v15L7 15H3zM16 9.5l5 5M21 9.5l-5 5",
  back:        "M15 5l-7 7 7 7",
  forward:     "M9 5l7 7-7 7",
  collapse:    "M11 6l-6 6 6 6M19 6l-6 6 6 6",
  expand:      "M5 6l6 6-6 6M13 6l6 6-6 6",
  plus:        "M12 4v16M4 12h16",
  bell:        "M6 10a6 6 0 0 1 12 0v4.5l2 3H4l2-3zM10 20.5a2 2 0 0 0 4 0",
  settings:    "M4 6h9M17 6h3M15 4v4M4 12h3M11 12h9M9 10v4M4 18h11M19 18h1M17 16v4",
  clipboard:   "M8 4h8v3H8zM6 5.5H4V21h16V5.5h-2M8 12h8M8 16h5",
  calendar:    "M3 5h18v16H3zM3 10h18M8 3v4M16 3v4",
  clean:       "M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6",
  refresh:     "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  hash:        "M5 9h14M5 15h14M10 4L8 20M16 4l-2 16",
  eye:         "M2 12s3.8-7 10-7 10 7 10 7-3.8 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  swap:        "M4 8h14M14 4l4 4-4 4M20 16H6M10 12l-4 4 4 4",
  flame:       "M12 3c.8 3.6 5 5 5 10a5 5 0 0 1-10 0c0-2.6 1.5-3.8 2-6 1.2 1 2 2.2 2.4 3.6.6-2.4.8-5 .6-7.6z",
  star:        "M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z",
  coins:       "M9 9.5c3.3 0 6-1.1 6-2.5S12.3 4.5 9 4.5 3 5.6 3 7s2.7 2.5 6 2.5zM3 7v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7M9 13.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4c0-1.4-2.7-2.5-6-2.5",
  check:       "M4 12.5l5 5L20 6.5",
  flag:        "M5 21V4M5 4h12l-2.5 4L17 12H5",
  bolt:        "M13 2L4 14h7l-1 8 9-12h-7z",
  chevronDown: "M6 9l6 6 6-6",
};
function Icon({ name, size = 18, strokeWidth = 1.75, style, className, title }) {
  const d = ICON_PATHS[name];
  if (!d) return null;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="square" strokeLinejoin="miter" aria-hidden={title ? undefined : true} role={title ? "img" : undefined}
      className={className} style={{ display: "inline-block", verticalAlign: "-0.15em", flex: "0 0 auto", ...style }}>
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}
// The league's crest: a shield cut on the same corner as every panel, with a
// red accent along the cut and the league's initial. Used wherever the league
// is named in the chrome, so every league gets a proper mark without a logo upload.
// The VOLT brand: the owner's bolt-V mark, and the wordmark where the bolt
// stands in as the V of VOLT. Files in public/brand/ (reels/logo/build.mjs).
const VOLT_ARM = "M344.811 140.139H0L273.118 552.012L436.988 278.57L344.811 140.139Z";
const VOLT_BOLT = "M392.606 466.561L689.622 0H1002L303.843 834L549.649 401.619L392.606 466.561Z";
function VoltGrads({ id }) {
  return (
    <defs>
      <linearGradient id={`${id}b`} x1="1" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8db3ff" /><stop offset="0.55" stopColor="#3d7bff" /><stop offset="1" stopColor="#1f47c9" /></linearGradient>
      <linearGradient id={`${id}a`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#b9cbef" /></linearGradient>
    </defs>
  );
}
function VoltMark({ size = 24, glow = false, style }) {
  const id = "vm" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg viewBox="0 0 1002 834" width={size} height={Math.round(size * 0.832)} aria-hidden
      style={{ display: "block", flex: "0 0 auto", filter: glow ? "drop-shadow(0 0 8px rgba(61,123,255,0.45))" : undefined, ...style }}>
      <VoltGrads id={id} />
      <path d={VOLT_ARM} fill={`url(#${id}a)`} />
      <path d={VOLT_BOLT} fill={`url(#${id}b)`} />
    </svg>
  );
}
function VoltWordmark({ height = 40, style }) {
  const id = "vw" + useId().replace(/[^a-zA-Z0-9]/g, "");
  return (
    <svg viewBox="0 0 1100 420" height={height} width={Math.round((height * 1100) / 420)} role="img" aria-label="VOLT"
      style={{ display: "block", filter: "drop-shadow(0 0 14px rgba(61,123,255,0.35))", ...style }}>
      <VoltGrads id={id} />
      <g transform="scale(0.5036)"><path d={VOLT_ARM} fill={`url(#${id}a)`} /><path d={VOLT_BOLT} fill={`url(#${id}b)`} /></g>
      <g transform="translate(205 90) scale(6)" fill="#f4f8ff">
        <path fillRule="evenodd" d="M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z" />
        <path d="M80 0H89.5V31H105V40H80Z" />
        <path d="M109 0H146V9.5H132.25V40H122.75V9.5H109Z" />
      </g>
    </svg>
  );
}
// "Powered by VOLT" line under a league's name.
function VoltTag({ color = "#5b8dff", size = 9 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "'Rajdhani',sans-serif", fontSize: size, fontWeight: 700, letterSpacing: "0.32em", textTransform: "uppercase", color, whiteSpace: "nowrap" }}>
      <VoltMark size={Math.round(size * 1.35)} />VOLT LEAGUE
    </span>
  );
}

function LeagueMark({ name, size = 38 }) {
  // The platform itself (no league yet) wears the VOLT mark, not a letter crest.
  if (!name || name.trim().toUpperCase() === "VOLT") return <VoltMark size={Math.round(size * 1.05)} glow />;
  const ch = (name || "V").trim().charAt(0).toUpperCase() || "V";
  const g = "lmk";   // same gradients everywhere, so one id is fine
  return (
    <svg viewBox="0 0 40 44" width={size} height={Math.round(size * 1.1)} aria-hidden style={{ display: "block", flex: "0 0 auto", filter: "drop-shadow(0 0 8px rgba(61,123,255,0.35))" }}>
      <defs>
        <linearGradient id={`${g}f`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#2f66e0" /><stop offset="1" stopColor="#0b1530" /></linearGradient>
        <linearGradient id={`${g}s`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#9cbcff" /><stop offset="1" stopColor="#3d7bff" stopOpacity="0.35" /></linearGradient>
      </defs>
      <path d="M2.5 1.5h27l8 8v18.5L20 42.5 2.5 30z" fill={`url(#${g}f)`} stroke={`url(#${g}s)`} strokeWidth="1.2" strokeLinejoin="miter" />
      <path d="M6.5 5.5h21.5l5.5 5.5v15.3L20 37.6 6.5 27.9z" fill="none" stroke="rgba(170,200,255,0.22)" strokeWidth="0.8" />
      <path d="M30.6 3.4l4.9 4.9" stroke="#ff4655" strokeWidth="2.2" strokeLinecap="square" />
      <text x="20" y="27.5" textAnchor="middle" fontFamily="Rajdhani, sans-serif" fontWeight="700" fontSize="21" fill="#f4f8ff" style={{ letterSpacing: 0 }}>{ch}</text>
    </svg>
  );
}
// Crest plus name: the league's name in white with the platform line beneath.
// ── Switching leagues ───────────────────────────────────────────────────
// One account, many leagues. The current league lives on the account, and
// everything on screen is scoped to it, so a switch is a clean reload.
const LEAGUE_CHOSEN_KEY = "volt_league_chosen";
const LEAGUE_SWITCH_KEY = "volt_league_switch";
const LEAGUE_PHASES = {
  matches_live: ["Matches live", "#3ddc84"],
  drafting: ["Draft live", "#ff4655"],
  registration_open: ["Sign-ups open", "#7da6ff"],
  registration_closed: ["Sign-ups closed", "rgba(200,215,255,0.6)"],
};
function markLeagueChosen(switched) {
  try {
    sessionStorage.setItem(LEAGUE_CHOSEN_KEY, "1");
    if (switched) localStorage.setItem(LEAGUE_SWITCH_KEY, String(Date.now()));   // tells this browser's other tabs
  } catch { /* private mode */ }
}

function LeaguePanel({ anchor, onClose }) {
  const [leagues, setLeagues] = useState(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    let alive = true;
    __sb.rpc("volt_my_leagues").then(({ data }) => { if (alive) setLeagues(data?.leagues || []); });
    return () => { alive = false; };
  }, []);
  async function go(l) {
    if (l.active) return onClose();
    setBusy(l.id); setErr("");
    const { error } = await __sb.rpc("volt_switch_league", { p_community: l.id });
    if (error) { setErr(error.message); setBusy(null); return; }
    markLeagueChosen(true);
    window.location.reload();
  }
  async function join(e) {
    e.preventDefault();
    // People paste the whole invite link as often as the code.
    const c = code.trim().replace(/^.*[?&]join=/i, "").split("&")[0];
    if (!c) return;
    setBusy("join"); setErr("");
    const { error } = await __sb.rpc("volt_join_league", { p_slug: c });
    if (error) { setErr(error.message); setBusy(null); return; }
    markLeagueChosen(true);
    window.location.reload();
  }
  const W = 300;
  const vw = window.innerWidth;
  return createPortal(<>
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 9000 }} />
    <div role="menu" aria-label="Your leagues" style={{ position: "fixed", zIndex: 9001, top: anchor.bottom + 8, left: Math.max(12, Math.min(anchor.left, vw - Math.min(W, vw - 24) - 12)), width: Math.min(W, vw - 24), maxHeight: "calc(100vh - 100px)", overflowY: "auto",
      padding: 8, fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff", background: "linear-gradient(160deg, rgba(16,23,40,0.99), rgba(9,13,23,0.99))", border: "1px solid rgba(61,123,255,0.35)", boxShadow: "0 18px 40px rgba(0,0,0,0.55)" }}>
      <div style={{ padding: "6px 8px 8px", fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(200,215,255,0.55)" }}>Your leagues</div>
      {leagues === null && <div style={{ padding: "8px", fontSize: 13, color: "rgba(200,215,255,0.55)" }}>Loading…</div>}
      {(leagues || []).map((l) => {
        const [label, color] = LEAGUE_PHASES[l.phase] || ["Nothing running", "rgba(200,215,255,0.45)"];
        return (
          <button key={l.id} role="menuitem" onClick={() => go(l)} disabled={!!busy}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 52, padding: "8px", textAlign: "left", fontFamily: "inherit", color: "inherit", cursor: l.active ? "default" : "pointer",
              background: l.active ? "rgba(61,123,255,0.12)" : "transparent", border: "none", borderLeft: `2px solid ${l.active ? "#3d7bff" : "transparent"}` }}>
            <LeagueMark name={l.name} size={28} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{l.name}</span>
              <span style={{ display: "block", fontSize: 12.5, color, marginTop: 1 }}>{busy === l.id ? "Switching…" : label}</span>
            </span>
            {l.unread > 0 && <span aria-label={`${l.unread} unread`} style={{ minWidth: 20, padding: "1px 5px", textAlign: "center", fontSize: 11.5, fontWeight: 700, color: "#fff", background: "#ff4655", borderRadius: 10 }}>{l.unread}</span>}
            {l.active && <CheckIcon size={14} />}
          </button>
        );
      })}
      <form onSubmit={join} style={{ marginTop: 8, padding: "10px 8px 4px", borderTop: "1px solid rgba(120,150,220,0.18)" }}>
        <label htmlFor="volt-join-another" style={{ display: "block", marginBottom: 6, fontSize: 11, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(200,215,255,0.55)" }}>Join another league</label>
        <div style={{ display: "flex", gap: 6 }}>
          <input id="volt-join-another" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Join code or invite link" autoComplete="off"
            style={{ flex: 1, minWidth: 0, minHeight: 40, padding: "8px 10px", background: "rgba(10,16,30,0.65)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "inherit", fontSize: 14 }} />
          <button type="submit" disabled={!!busy || !code.trim()} style={shellBtn("primary", { padding: "0 14px", minHeight: 40, fontSize: 12, letterSpacing: "0.1em" })}>{busy === "join" ? "…" : "Join"}</button>
        </div>
      </form>
      {err && <div role="alert" style={{ padding: "8px", fontSize: 13, color: "#ff8f9a" }}>{err}</div>}
    </div>
  </>, document.body);
}

// The arrow beside a league's name. A dot means something's waiting in another league.
function LeagueSwitch({ size = 26, style }) {
  const [anchor, setAnchor] = useState(null);
  const [waiting, setWaiting] = useState(false);
  useEffect(() => {
    if (!HAS_SUPABASE) return;
    let alive = true;
    __sb.rpc("volt_my_leagues").then(({ data }) => {
      if (alive) setWaiting((data?.leagues || []).some((l) => !l.active && (l.unread > 0 || l.phase === "drafting" || l.phase === "matches_live")));
    });
    return () => { alive = false; };
  }, []);
  if (!HAS_SUPABASE) return null;
  return <>
    <button onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} aria-label="Switch league" aria-haspopup="menu" title="Switch league"
      style={{ position: "relative", flex: "0 0 auto", width: size, height: size, display: "grid", placeItems: "center", cursor: "pointer", color: "#9dc0ff", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(120,150,220,0.25)", ...style }}>
      <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      {waiting && <span style={{ position: "absolute", top: -3, right: -3, width: 8, height: 8, borderRadius: "50%", background: "#ff4655" }} />}
    </button>
    {anchor && <LeaguePanel anchor={anchor} onClose={() => setAnchor(null)} />}
  </>;
}

function LeagueLockup({ name, wide = true, size = 34 }) {
  // No league yet: the platform's own wordmark (the bolt is the V).
  if (wide && (!name || name.trim().toUpperCase() === "VOLT")) return <VoltWordmark height={Math.round(size * 0.95)} />;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, minWidth: 0 }}>
      <LeagueMark name={name} size={size} />
      {wide && (
        <span style={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: 1, textAlign: "left" }}>
          <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 15.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "#f1f5ff",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name || "VOLT"}</span>
          <span style={{ marginTop: 4 }}><VoltTag /></span>
        </span>
      )}
    </span>
  );
}
// Nav items name their icon; anything that isn't an icon name renders as-is.
const glyphNode = (g, size = 18) => (typeof g === "string" && ICON_PATHS[g] ? <Icon name={g} size={size} /> : g);
// Key art for banners. Each piece is mirrored so the figure stands on the
// right facing the text, graded to sit with the others (VOLT blue, or gold
// for champions), and faded out on the left behind the copy.
const ART = {
  omen: "/img/league-hero.webp",      // league page
  jett: "/img/art-jett.webp",         // fixtures, matches running
  reyna: "/img/art-reyna.webp",       // leaderboard, auction live
  sageGold: "/img/art-sage-gold.webp", // champions
};
// How each piece frames in a short, wide banner: the point to keep in view
// (the face) and how far the left fade reaches before the art is solid.
const ART_FRAME = {
  "/img/league-hero.webp":    { pos: "72% 4%",  fade: 48 },
  "/img/art-jett.webp":       { pos: "70% 18%", fade: 48 },
  "/img/art-reyna.webp":      { pos: "50% 18%", fade: 30 },
  "/img/art-sage-gold.webp":  { pos: "70% 25%", fade: 48 },
};
function KeyArt({ src, pos: posIn, width = "68%", fade: fadeIn, opacity = 1, center = false }) {
  const pos = posIn || ART_FRAME[src]?.pos || "72% 10%";
  const fade = fadeIn ?? ART_FRAME[src]?.fade ?? 48;
  const mask = center
    ? "radial-gradient(ellipse 75% 95% at 50% 45%, #000 30%, transparent 85%)"
    : `linear-gradient(90deg, transparent 0%, rgba(0,0,0,0.55) ${fade * 0.45}%, #000 ${fade}%)`;
  return (
    <>
      <style>{SWEEP_CSS}</style>
      <img src={src} alt="" aria-hidden className={center ? undefined : "volt-key-art"} style={{ position: "absolute", top: 0, height: "100%",
        right: 0, width: center ? "100%" : width, objectFit: "cover", objectPosition: pos, opacity, pointerEvents: "none",
        maskImage: mask, WebkitMaskImage: mask }} />
      {/* Texture lives on the art only, masked the same way, so the copy and
          buttons on the left sit on a clean panel. */}
      <span aria-hidden className="volt-scan" style={center ? undefined : { left: "auto", width, maskImage: mask, WebkitMaskImage: mask }} />
      <span aria-hidden className="volt-sweep" style={center ? undefined : { left: "auto", width, maskImage: mask, WebkitMaskImage: mask }} />
    </>
  );
}

// Broadcast finish for a photo banner: fine scanlines plus a slow light
// sweep. Restrained on purpose — motion that loops visibly looks cheap.
const SWEEP_CSS = `
  @keyframes voltSweep { 0% { background-position: 160% 0; } 55%, 100% { background-position: -60% 0; } }
  .volt-sweep { position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(105deg, transparent 42%, rgba(170,200,255,0.09) 50%, transparent 58%);
    background-size: 260% 100%; animation: voltSweep 11s cubic-bezier(.45,0,.25,1) infinite; }
  .volt-scan { position: absolute; inset: 0; pointer-events: none;
    background: repeating-linear-gradient(0deg, rgba(255,255,255,0.022) 0 1px, transparent 1px 3px); }
  @media (prefers-reduced-motion: reduce) { .volt-sweep { animation: none; opacity: 0; } }
  @media (max-width: 700px) { .volt-key-art { width: 100% !important; opacity: 0.35 !important; } }
`;

/* ════════════════════════════════════════════════════════════════════
   VOLT PROTOCOL — Community Valorant Auction Draft
   4 routed screens · live-synced via shared storage
   Lobby · Scout Hub · Auction Block · Locker Room
   ════════════════════════════════════════════════════════════════════ */

              // hidden tab: still sync, but rarely (conditional GET makes these near-free anyway)

// True when the tab is visible (or when the API is unavailable, e.g. SSR).
function tabVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}
// setInterval replacement that (a) skips the callback while the tab is hidden
// unless `runHidden` is set, and (b) fires once immediately on re-show so the
// UI catches up the moment the user comes back. Returns a cleanup function.
// activeMs/hiddenMs may be a number or a function returning one, so a caller can
// tighten its own cadence when it matters (a live auction) and relax otherwise.
function visInterval(fn, activeMs, hiddenMs) {
  let timer = null;
  const ms = (v) => (typeof v === "function" ? v() : v);
  const period = () => (tabVisible() ? ms(activeMs) : (ms(hiddenMs) || ms(activeMs)));
  const arm = () => { clearTimeout(timer); timer = setTimeout(tick, period()); };
  async function tick() { try { if (tabVisible() || hiddenMs) await fn(); } finally { arm(); } }
  const onVis = () => { if (tabVisible()) { fn(); } arm(); }; // catch up + re-cadence on show/hide
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
  arm();
  return () => { clearTimeout(timer); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
}

 // 0-based index → "0001".."0008"



const RANKS = {
  Iron:      { bid: 300,  c: "#8d97a8", glow: "rgba(141,151,168,0.45)" },
  Bronze:    { bid: 500,  c: "#c08a52", glow: "rgba(192,138,82,0.45)" },
  Silver:    { bid: 800,  c: "#d7e1ee", glow: "rgba(215,225,238,0.40)" },
  Gold:      { bid: 1100,  c: "#f5c453", glow: "rgba(245,196,83,0.45)" },
  Platinum:  { bid: 1500, c: "#3be8d8", glow: "rgba(59,232,216,0.45)" },
  Diamond:   { bid: 2000, c: "#c08bff", glow: "rgba(192,139,255,0.50)" },
  Ascendant: { bid: 2600, c: "#3ddc84", glow: "rgba(61,220,132,0.50)" },
  Immortal:  { bid: 3500, c: "#ff4d6d", glow: "rgba(255,77,109,0.55)" },
  Radiant:   { bid: 4500, c: "#fff3b0", glow: "rgba(255,243,176,0.60)" },
};
const RANK_LIST = Object.keys(RANKS);
const rankOf = (r) => RANKS[r] || RANKS.Silver;
// Divisions are display only. The tier stays in `rank` because bid values,
// filters and sorting all key off it — folding "Platinum 3" into one string
// would mean every one of those lookups has to parse it back apart.
const RANK_DIVS = [1, 2, 3];
const hasDivisions = (r) => !!RANKS[r] && r !== "Radiant";
const rankLabel = (r, div) => (r ? r + (hasDivisions(r) && div ? ` ${div}` : "") : "—");
const ROLE_GLYPH = { Duelist: "◆", Initiator: "▲", Controller: "●", Sentinel: "■", Flex: "✦" };
   // No demo teams/players: a real league seeds itself from registrations. An
// empty board is the honest empty state — fake operators in the Scout Hub read
// as real ones and get scouted, tagged, and drafted by mistake.


// Tournament display name from its date — "Jul 20–21" (Sat–Sun) with an
// optional nickname. Falls back to the legacy counter label when no date exists.
// A tournament is Sat–Sun; starts_on is the Saturday.
// Module scope, not component scope: the signup-guide builder sits above the
// schedule component and needs these too, and a phase should read identically
// wherever it appears.
// Phases that still take sign-ups. Only registration_open feeds the draft pool;
// the rest file people as reserves.
const LATE_SIGNUP_PHASES = ["registration_open", "registration_closed", "drafting", "matches_live"];
const PHASE_LABEL = { registration_open: "Registration open", registration_closed: "Registration closed", drafting: "Draft live", matches_live: "Matches live", settled: "Settled" };
const PHASE_COLOR = { registration_open: "#3ddc84", registration_closed: "#f5c453", drafting: "#3d7bff", matches_live: "#af9aec", settled: "rgba(200,215,255,0.4)" };

function weekendName(ev) {
  if (!ev) return "";
  const raw = ev.starts_on;
  if (!raw) return ev.weekend_label || "Tournament";
  const sat = new Date(raw + "T00:00:00");
  if (isNaN(sat)) return ev.weekend_label || "Tournament";
  // ends_on is optional — without it an event is the classic Sat–Sun tournament.
  // With it, the event can run any length (a fortnight-long tournament, a
  // single day) and the label spans whatever was actually set.
  let sun = new Date(sat); sun.setDate(sat.getDate() + 1);
  if (ev.ends_on) {
    const e = new Date(ev.ends_on + "T00:00:00");
    if (!isNaN(e) && e >= sat) sun = e;
  }
  const mon = sat.toLocaleDateString(undefined, { month: "short" });
  const monS = sun.toLocaleDateString(undefined, { month: "short" });
  const label = sat.getTime() === sun.getTime()
    ? `${mon} ${sat.getDate()}`
    : mon === monS
      ? `${mon} ${sat.getDate()}–${sun.getDate()}`
      : `${mon} ${sat.getDate()} – ${monS} ${sun.getDate()}`;
  // Keep a nickname only if the host set one that isn't the old auto counter.
  const nick = ev.weekend_label && !/^(week(end)?)\s*\d+$/i.test(ev.weekend_label.trim()) ? ev.weekend_label : null;
  return nick ? `${label} · ${nick}` : label;
}

// The coming Saturday (local), as a yyyy-mm-dd string — the default for a new tournament.
// Today as yyyy-mm-dd, local.
function ymdToday() {
  const d = new Date(), p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function comingSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7 || 7));
  const p = x => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The league owner, strictly — moderators are staff but do NOT run the live
// auction. Undefined means the no-Supabase preview, where everything is allowed.
const isLeagueOwner = () => window.__VOLT?.isHost !== false;

 const fmt = (n) => "$" + Number(n || 0).toLocaleString();

/* ════════════════ atoms ═══════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
   TOURNAMENT UI — Host builds & runs brackets; everyone watches.
   ════════════════════════════════════════════════════════════════════ */

// ── Branded date+time picker. Custom calendar/time panel on desktop (the
//    native one can't be themed); falls back to the native input on mobile,
//    where the OS wheel picker is genuinely better UX. ──
// Date RANGE picker — one calendar, click the start then the end. Deliberately
// separate from VoltDateTime: that one carries hours/minutes because match and
// draft times need them, whereas starts_on/ends_on are DATE columns, so any time
// shown here would be collected and then silently thrown away.
function VoltDateRange({ start, end, onChange, placeholder = "Pick the dates" }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => new Date((start || ymdToday()) + "T12:00:00"));
  const boxRef = useRef(null);
  // The calendar has to be portalled to <body>. Its usual home — the tournament
  // setup modal — carries clipPath for the notched corners, and clip-path clips
  // every descendant regardless of position or z-index. An absolutely
  // positioned dropdown just gets sliced off at the panel edge.
  const [anchor, setAnchor] = useState(null); // viewport rect of the trigger
  useEffect(() => { if (start) setView(new Date(start + "T12:00:00")); }, [start]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (boxRef.current && boxRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest("[data-volt-drpanel]")) return; // inside the portalled panel
      setOpen(false);
    };
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r) setAnchor({ top: r.bottom, bottom: r.top, left: r.left });
    };
    place();
    document.addEventListener("mousedown", onDoc);
    // Capture phase: the modal itself scrolls, and that scroll doesn't bubble.
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const y = view.getFullYear(), mo = view.getMonth();
  const startDow = new Date(y, mo, 1).getDay();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  const cellYmd = (d) => `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

  const pick = (d) => {
    const v = cellYmd(d);
    // No start yet, or a complete range already set → begin a new one.
    if (!start || (start && end)) { onChange(v, null); return; }
    // Second click closes the range; clicking before the start just re-anchors it.
    if (v < start) onChange(v, null); else onChange(start, v);
  };

  const fmtShort = (v) => v ? new Date(v + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" }) : null;
  const summary = !start ? placeholder
    : !end ? `${fmtShort(start)} → pick the end date`
    : start === end ? fmtShort(start)
    : `${fmtShort(start)} – ${fmtShort(end)}`;

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 9, padding: "9px 12px", cursor: "pointer",
          background: "rgba(10,16,30,0.8)", border: `1px solid ${start && !end ? "rgba(245,196,83,0.5)" : "rgba(61,123,255,0.35)"}`,
          color: start ? "#ecf3ff" : "rgba(200,215,255,0.45)", fontFamily: "'Rajdhani',sans-serif", fontSize: 13.5, fontWeight: 600 }}>
        <span style={{ color: "#7da6ff" }}>▦</span>
        <span>{summary}</span>
        {start && <span onClick={(e) => { e.stopPropagation(); onChange(null, null); }} title="Clear"
          style={{ color: "rgba(255,120,135,0.7)", fontSize: 13, marginLeft: 2 }}>✕</span>}
      </button>
      {open && anchor && createPortal((
        (() => {
          const vh = typeof window !== "undefined" ? window.innerHeight : 800;
          const vw = typeof window !== "undefined" ? window.innerWidth : 1200;
          const H = 330;                                   // roughly the panel's height
          // Flip above the button when there isn't room below, then clamp so it
          // can never sit off-screen on a short window.
          const below = anchor.top + 6;
          const flip = below + H > vh - 8;
          const top = flip ? Math.max(8, anchor.bottom - H - 6) : Math.min(below, Math.max(8, vh - H - 8));
          return (
        <div data-volt-drpanel="1" style={{ position: "fixed", zIndex: 200, top,
          left: Math.max(8, Math.min(anchor.left, vw - 288)), padding: 12, minWidth: 268,
          background: "linear-gradient(160deg,rgba(18,24,40,0.99),rgba(9,12,21,0.99))", border: "1px solid rgba(61,123,255,0.4)",
          clipPath: SHELL_NOTCH(10), boxShadow: "0 20px 50px rgba(0,0,0,0.6)" }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
            <button onClick={() => setView(new Date(y, mo - 1, 1))} style={{ background: "none", border: "1px solid rgba(120,150,220,0.25)", color: "#7da6ff", cursor: "pointer", padding: "2px 8px", fontSize: 12 }}>‹</button>
            <span style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#ecf3ff" }}>
              {view.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
            </span>
            <button onClick={() => setView(new Date(y, mo + 1, 1))} style={{ background: "none", border: "1px solid rgba(120,150,220,0.25)", color: "#7da6ff", cursor: "pointer", padding: "2px 8px", fontSize: 12 }}>›</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 4 }}>
            {["S","M","T","W","T","F","S"].map((w, i) => (
              <span key={i} style={{ textAlign: "center", fontSize: 9.5, letterSpacing: "0.1em", color: "rgba(200,215,255,0.35)" }}>{w}</span>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
            {cells.map((d, i) => {
              if (d === null) return <span key={i} />;
              const v = cellYmd(d);
              const isStart = v === start, isEnd = v === end;
              const inRange = start && end && v > start && v < end;
              const edge = isStart || isEnd;
              return (
                <button key={i} onClick={() => pick(d)}
                  style={{ padding: "6px 0", fontSize: 12.5, fontWeight: edge ? 800 : 600, cursor: "pointer",
                    fontFamily: "'Rajdhani',sans-serif",
                    background: edge ? "#3d7bff" : inRange ? "rgba(61,123,255,0.18)" : "transparent",
                    border: `1px solid ${edge ? "#3d7bff" : inRange ? "rgba(61,123,255,0.3)" : "transparent"}`,
                    color: edge ? "#fff" : inRange ? "#cfe0ff" : "rgba(220,230,255,0.75)" }}>{d}</button>
              );
            })}
          </div>
          <div className="flex items-center justify-between" style={{ marginTop: 10 }}>
            <span style={{ fontSize: 10.5, color: start && !end ? "#f5c453" : "rgba(200,215,255,0.4)" }}>
              {start && !end ? "Now pick the end date" : "Click a start, then an end"}
            </span>
            <button onClick={() => setOpen(false)} style={{ background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)", color: "#aec6ff", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", padding: "5px 12px", clipPath: SHELL_NOTCH(5) }}>Done</button>
          </div>
        </div>
          );
        })()
      ), document.body)}
    </div>
  );
}

function VoltDateTime({ value, onChange, placeholder = "Set date & time" }) {
  const [open, setOpen] = useState(false);
  const [desk, setDesk] = useState(typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 768px)").matches : true);
  const [view, setView] = useState(() => (value ? new Date(value) : new Date()));
  const boxRef = useRef(null);
  const [anchor, setAnchor] = useState(null); // viewport rect of the trigger
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const on = (e) => setDesk(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  useEffect(() => { if (value) setView(new Date(value)); }, [value]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (boxRef.current && boxRef.current.contains(e.target)) return;
      if (e.target.closest && e.target.closest("[data-volt-dtpanel]")) return; // clicks inside the portalled panel
      setOpen(false);
    };
    const place = () => { const r = boxRef.current?.getBoundingClientRect(); if (r) setAnchor({ top: r.bottom, left: r.left, right: r.right }); };
    place();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  const pad = (x) => String(x).padStart(2, "0");
  const toLocalInput = (v) => { if (!v) return ""; const d = new Date(v); if (isNaN(d)) return ""; return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

  // Mobile → native input (OS pickers beat anything custom on touch)
  if (!desk) {
    return (
      <input type="datetime-local" value={toLocalInput(value)}
        onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)}
        className="outline-none" style={{ padding: "7px 10px", background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.3)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, colorScheme: "dark" }} />
    );
  }

  const cur = value ? new Date(value) : null;
  const label = cur
    ? cur.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " · " + cur.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : placeholder;

  // calendar grid for the viewed month
  const y = view.getFullYear(), mo = view.getMonth();
  const first = new Date(y, mo, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(y, mo + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);

  const commit = (next) => onChange(next ? next.toISOString() : null);
  const pickDay = (d) => {
    const base = cur ? new Date(cur) : new Date(y, mo, d, 20, 0, 0, 0);
    base.setFullYear(y, mo, d);
    if (!cur) { base.setHours(20); base.setMinutes(0); }
    commit(base);
  };
  const setHM = (h, mi) => {
    const base = cur ? new Date(cur) : new Date(y, mo, view.getDate() || 1, 20, 0, 0, 0);
    if (h != null) base.setHours(h);
    if (mi != null) base.setMinutes(mi);
    base.setSeconds(0, 0);
    commit(base);
  };

  const isSameDay = (d) => cur && cur.getFullYear() === y && cur.getMonth() === mo && cur.getDate() === d;
  const today = new Date();
  const isToday = (d) => today.getFullYear() === y && today.getMonth() === mo && today.getDate() === d;

  const colBtn = (active, onClick, children, key) => (
    <button key={key} onClick={onClick} style={{ width: "100%", padding: "5px 0", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5, fontWeight: 700, cursor: "pointer",
      background: active ? "rgba(61,123,255,0.22)" : "transparent", border: active ? "1px solid #3d7bff" : "1px solid transparent",
      color: active ? "#ecf3ff" : "rgba(200,215,255,0.6)" }}>{children}</button>
  );

  return (
    <div ref={boxRef} style={{ position: "relative", display: "inline-block" }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 13px", cursor: "pointer",
          background: "rgba(61,123,255,0.07)", border: `1px solid ${open ? "#3d7bff" : "rgba(61,123,255,0.32)"}`,
          clipPath: SHELL_NOTCH(7), color: cur ? "#ecf3ff" : "rgba(200,215,255,0.5)",
          fontFamily: "'Rajdhani',sans-serif", fontSize: 12.5, fontWeight: 600, letterSpacing: "0.04em" }}>
        <span style={{ color: "#5b8dff" }}>▦</span>{label}
        {cur && <span onClick={(e) => { e.stopPropagation(); commit(null); }} title="Clear" style={{ color: "rgba(255,120,135,0.7)", fontSize: 13, marginLeft: 2 }}>✕</span>}
      </button>

      {open && anchor && createPortal((
        <div data-volt-dtpanel="1" style={{ position: "fixed", zIndex: 200,
          top: Math.min(anchor.top + 7, Math.max(8, (typeof window !== "undefined" ? window.innerHeight : 800) - 320)),
          left: Math.max(8, Math.min(anchor.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - 420)),
          display: "flex", gap: 0,
          background: "linear-gradient(160deg, rgba(20,26,42,0.99), rgba(10,13,22,0.99))", border: "1px solid rgba(61,123,255,0.45)",
          clipPath: SHELL_NOTCH(12), boxShadow: "0 20px 50px rgba(0,0,0,0.65)", fontFamily: "'Rajdhani',sans-serif" }}>
          {/* calendar */}
          <div style={{ padding: "14px 15px", width: 250 }}>
            <div className="flex items-center justify-between mb-2.5">
              <button onClick={() => setView(new Date(y, mo - 1, 1))} style={{ background: "none", border: "1px solid rgba(120,150,220,0.25)", color: "#7da6ff", cursor: "pointer", padding: "2px 8px", fontSize: 12 }}>‹</button>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#ecf3ff" }}>
                {view.toLocaleDateString(undefined, { month: "long", year: "numeric" })}
              </span>
              <button onClick={() => setView(new Date(y, mo + 1, 1))} style={{ background: "none", border: "1px solid rgba(120,150,220,0.25)", color: "#7da6ff", cursor: "pointer", padding: "2px 8px", fontSize: 12 }}>›</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2, marginBottom: 4 }}>
              {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
                <span key={i} style={{ textAlign: "center", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.1em", color: "rgba(120,150,220,0.6)" }}>{d}</span>
              ))}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 2 }}>
              {cells.map((d, i) => d === null ? <span key={i} /> : (
                <button key={i} onClick={() => pickDay(d)}
                  style={{ padding: "5px 0", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "'IBM Plex Mono',monospace",
                    background: isSameDay(d) ? "#3d7bff" : "transparent",
                    border: `1px solid ${isSameDay(d) ? "#3d7bff" : isToday(d) ? "rgba(245,196,83,0.5)" : "transparent"}`,
                    color: isSameDay(d) ? "#06101f" : isToday(d) ? "#f5c453" : "rgba(220,231,255,0.85)" }}>{d}</button>
              ))}
            </div>
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => { commit(null); setOpen(false); }} style={{ background: "none", border: "none", color: "rgba(255,120,135,0.75)", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}>Clear</button>
              <button onClick={() => setOpen(false)} style={{ background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)", color: "#aec6ff", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", padding: "5px 12px", clipPath: SHELL_NOTCH(5) }}>Done</button>
            </div>
          </div>
          {/* time columns */}
          <div style={{ display: "flex", borderLeft: "1px solid rgba(120,150,220,0.2)" }}>
            {[
              { key: "h", items: Array.from({ length: 12 }, (_, i) => i + 1), active: (v) => cur && ((cur.getHours() % 12) || 12) === v, on: (v) => { const pm = cur ? cur.getHours() >= 12 : true; setHM(pm ? (v % 12) + 12 : v % 12, null); } },
              { key: "m", items: [0, 15, 30, 45], active: (v) => cur && cur.getMinutes() === v, on: (v) => setHM(null, v) },
            ].map((col) => (
              <div key={col.key} style={{ width: 54, maxHeight: 252, overflowY: "auto", padding: "8px 5px", display: "flex", flexDirection: "column", gap: 2 }}>
                {col.items.map((v) => colBtn(col.active(v), () => col.on(v), pad(v), v))}
              </div>
            ))}
            <div style={{ width: 52, padding: "8px 5px", display: "flex", flexDirection: "column", gap: 2 }}>
              {["AM", "PM"].map((ap) => colBtn(
                cur && (ap === "PM" ? cur.getHours() >= 12 : cur.getHours() < 12),
                () => { const h = cur ? cur.getHours() : 20; const base = (h % 12); setHM(ap === "PM" ? base + 12 : base, null); },
                ap, ap))}
            </div>
          </div>
        </div>
      ), document.body)}
    </div>
  );
}

// Top bars: navy glass that lets the page glow through, with a lit lower edge,
// so the bar reads as part of the app rather than a black strip above it.
const TOPBAR = { background: "linear-gradient(180deg, rgba(20,29,54,0.86), rgba(13,19,36,0.74))", borderBottom: "1px solid rgba(61,123,255,0.24)",
  backdropFilter: "blur(16px) saturate(150%)", WebkitBackdropFilter: "blur(16px) saturate(150%)",
  boxShadow: "0 8px 26px rgba(3,6,14,0.38), inset 0 1px 0 rgba(150,180,255,0.07)" };
const TABBAR = { background: "linear-gradient(180deg, rgba(17,25,47,0.88), rgba(20,29,54,0.95))", borderTop: "1px solid rgba(61,123,255,0.3)",
  backdropFilter: "blur(16px) saturate(150%)", WebkitBackdropFilter: "blur(16px) saturate(150%)",
  boxShadow: "0 -8px 26px rgba(3,6,14,0.42), inset 0 1px 0 rgba(150,180,255,0.08)" };
const TOPBAR_LINE = { position: "absolute", left: 0, right: 0, bottom: -1, height: 12, pointerEvents: "none",
  background: "linear-gradient(90deg, #3d7bff, rgba(61,123,255,0.3) 24%, transparent 62%) bottom / 100% 1px no-repeat, radial-gradient(ellipse 34% 100% at 10% 100%, rgba(61,123,255,0.2), transparent 72%)" };

          // Single-elim bracket on a grid. Round one sets the rows; a match in round r
// spans 2^r of them and centres in that span, so it always sits exactly
// between the two matches that feed it, and the elbow connectors (drawn in
// their own columns at 25% / 75% / 50%) always meet the card centres.
// Is the screen at most `px` wide? Follows resizes and rotation.
function useNarrow(px = 640) {
  const q = `(max-width: ${px}px)`;
  const [on, setOn] = useState(() => typeof window !== "undefined" && window.matchMedia ? window.matchMedia(q).matches : false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(q), f = (e) => setOn(e.matches);
    mq.addEventListener ? mq.addEventListener("change", f) : mq.addListener(f);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", f) : mq.removeListener(f); };
  }, [q]);
  return on;
}


// Big hero crest that foregrounds the player's RANK (the meaningful headline stat)
function RankCrest({ rank, div }) {
  const r = RANKS[rank] || RANKS.Iron;
  const s = 104;
  const letter = rank === "Radiant" ? "R" : (rank || "?")[0];
  const showDiv = hasDivisions(rank) && !!div;
  return (
    <div className="relative grid place-items-center" style={{ width: s, height: s }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
        <polygon points="50,4 93,27 93,73 50,96 7,73 7,27" fill="none" stroke={r.c} strokeWidth="3.5" opacity="0.95"
          style={{ filter: `drop-shadow(0 0 14px ${r.glow})` }} />
        <polygon points="50,16 81,33 81,67 50,84 19,67 19,33" fill={r.c} opacity="0.16" />
        <polygon points="50,28 70,39 70,61 50,72 30,61 30,39" fill={r.c} opacity="0.22" />
      </svg>
      <span className="relative font-bold uppercase leading-none"
        style={{ color: r.c, fontSize: s * 0.40, fontFamily: "'Rajdhani',sans-serif", textShadow: `0 0 16px ${r.glow}`,
          // Rajdhani's capitals ride high in their line box; drop them to the optical centre.
          transform: "translateY(0.1em)" }}>
        {letter}
      </span>
      {showDiv && (
        <span className="absolute font-bold leading-none"
          style={{ right: 4, bottom: 10, fontSize: s * 0.19, fontFamily: "'Rajdhani',sans-serif",
            color: "#0a0d18", background: r.c, borderRadius: 5, padding: "3px 7px",
            boxShadow: `0 0 12px ${r.glow}` }}>{div}</span>
      )}
    </div>
  );
}

/* ── KDA / performance radar ── */
function StatRadar({ player, size = 200, hue, compare = null }) {
  // Each axis is normalised against a community ceiling so shapes stay
  // comparable between players — which hides the real numbers. Hovering
  // surfaces the value at its own corner.
  //
  // Tracking is angular rather than per-target: one pointer handler works out
  // which spoke the cursor is nearest, so sweeping around the radar hands off
  // between axes continuously instead of snapping in and out of five separate
  // hit boxes. A dead zone in the middle means resting on the shape selects
  // nothing.
  const [hot, setHot] = useState(null);
  const axes = [
    { label: "KDA",  v: Math.min(player.kda / 1.8, 1),
      show: player.kda != null ? Number(player.kda).toFixed(2) : "—" },
    { label: "ACS",  v: Math.min(player.acs / 320, 1),
      show: player.acs != null ? String(Math.round(player.acs)) : "—" },
    { label: "HS%",  v: Math.min(player.hs / 45, 1),
      show: player.hs != null ? Math.round(player.hs) + "%" : "—" },
    { label: "WIN%", v: Math.min((player.win || 0) / 100, 1),
      show: player.win != null ? Math.round(player.win) + "%" : "—" },
    { label: "RANK", v: (RANK_LIST.indexOf(player.rank) + 1) / RANK_LIST.length,
      show: rankLabel(player.rank, player.rankDiv) },
  ];
  const c = size / 2, R = c - 30, n = axes.length;
  // Padding in the viewBox rather than a smaller radius, so the value can sit
  // outside the label without clipping and the radar keeps its size.
  const pad = 30;
  const pt = (i, rad) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + rad * Math.cos(a), c + rad * Math.sin(a)];
  };
  const ring = (f) => axes.map((_, i) => pt(i, R * f).join(",")).join(" ");
  const shape = axes.map((ax, i) => pt(i, R * Math.max(ax.v, 0.05)).join(",")).join(" ");
  // Same normalisation as the player's shape, so the two are directly
  // comparable — the point of drawing a league average at all.
  const ghost = compare ? [
    Math.min((compare.kda || 0) / 1.8, 1),
    Math.min((compare.acs || 0) / 320, 1),
    Math.min((compare.hs || 0) / 45, 1),
    Math.min((compare.win || 0) / 100, 1),
    (RANK_LIST.indexOf(compare.rank) + 1) / RANK_LIST.length,
  ].map((v, i) => pt(i, R * Math.max(v, 0.05)).join(",")).join(" ") : null;

  function track(e) {
    const b = e.currentTarget.getBoundingClientRect();
    // Map client pixels back into viewBox units, which the padding offsets.
    const vb = size + pad * 2;
    const x = ((e.clientX - b.left) / b.width) * vb - pad;
    const y = ((e.clientY - b.top) / b.height) * vb - pad;
    const dx = x - c, dy = y - c;
    if (Math.hypot(dx, dy) < R * 0.3) { setHot(null); return; }   // dead centre
    let a = Math.atan2(dy, dx) + Math.PI / 2;                     // 0 = straight up
    if (a < 0) a += Math.PI * 2;
    setHot(Math.round(a / (Math.PI * 2 / n)) % n);
  }

  return (
    <svg viewBox={`${-pad} ${-pad} ${size + pad * 2} ${size + pad * 2}`} width={size} height={size}
      onPointerMove={track} onPointerDown={track} onPointerLeave={() => setHot(null)}
      style={{ touchAction: "manipulation" }}>
      <style>{`
        .rdd{transition:transform .22s cubic-bezier(.2,.9,.3,1),opacity .22s ease;transform-box:fill-box;transform-origin:center}
        .rdl{transition:fill .22s ease,opacity .22s ease}
        .rdv{transition:opacity .26s ease,transform .26s cubic-bezier(.2,.9,.3,1);transform-box:fill-box;transform-origin:center}
        .volt-radar-shape{stroke-dasharray:1;animation:voltDraw 1.2s cubic-bezier(.3,.7,.2,1) .15s backwards}
        @keyframes voltDraw{from{stroke-dashoffset:1;fill-opacity:0}55%{fill-opacity:0}to{stroke-dashoffset:0;fill-opacity:1}}
        @media (prefers-reduced-motion:reduce){.rdd,.rdl,.rdv{transition:none}.volt-radar-shape{animation:none}}
      `}</style>

      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
      ))}
      {axes.map((_, i) => {
        const [x, y] = pt(i, R);
        return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="rgba(255,255,255,0.10)" />;
      })}
      {ghost && <polygon points={ghost} fill="rgba(236,243,255,0.05)" stroke="rgba(236,243,255,0.5)"
        strokeWidth="1.2" strokeDasharray="4 3" />}
      <polygon className="volt-radar-shape" pathLength="1" points={shape} fill={hue + "33"} stroke={hue} strokeWidth="2"
        style={{ filter: `drop-shadow(0 0 8px ${hue}88)` }} />

      {/* Axis labels fade back when their value takes over. */}
      {axes.map((ax, i) => {
        const [x, y] = pt(i, R + 17);
        return <text key={i} className="rdl" x={x} y={y} textAnchor="middle" dominantBaseline="middle"
          fontSize="11" fontFamily="'Rajdhani',sans-serif" fontWeight="700" letterSpacing="1"
          opacity={hot === i ? 0.45 : 1}
          fill={hot === i ? hue : "rgba(236,243,255,0.7)"}>{ax.label}</text>;
      })}

      {/* Values live outside their own corner. Rendered always and faded, so
          they ease in and out instead of popping on mount.
          Every value is short except RANK, which can read "Ascendant 3" — on
          the left-hand spoke that overran the viewBox by about 20px and got
          clipped. Two fixes together: step the size down for long strings, then
          clamp the centre so the text box can't cross the edge whatever it says. */}
      {axes.map((ax, i) => {
        const [x0, y] = pt(i, R + 36);
        const txt = String(ax.show ?? "—");
        const fs = txt.length >= 10 ? 12.5 : txt.length >= 7 ? 14 : 16;
        const half = (txt.length * fs * 0.6) / 2;          // monospace, so width is predictable
        const x = Math.min(Math.max(x0, half - pad + 4), size + pad - half - 4);
        const live = hot === i;
        return <text key={i} className="rdv" x={x} y={y} textAnchor="middle" dominantBaseline="middle"
          fontSize={fs} fontFamily="'IBM Plex Mono',monospace" fontWeight="700" fill={hue}
          opacity={live ? 1 : 0} pointerEvents="none"
          style={{ transform: live ? "scale(1)" : "scale(0.82)",
                   filter: `drop-shadow(0 0 10px ${hue}aa)` }}>{txt}</text>;
      })}

      {axes.map((ax, i) => {
        const [x, y] = pt(i, R * Math.max(ax.v, 0.05));
        const live = hot === i;
        return (
          <g key={i}>
            <circle className="rdd" cx={x} cy={y} r="7" fill={hue}
              opacity={live ? 0.28 : 0} style={{ transform: live ? "scale(1)" : "scale(0.5)" }} />
            <circle className="rdd" cx={x} cy={y} r="3.5" fill={hue}
              style={{ transform: live ? "scale(1.25)" : "scale(1)" }} />
          </g>
        );
      })}
    </svg>
  );
}

/* ════════════════ TRADING CARD ════════════════════════════════════ */

                                 
  

/* agent artwork flanking the hero */

/* ════════════════ LEADERBOARD (tournament stats, sorted by avg performance) ══ */

/* ════════════════ NAV ═════════════════════════════════════════════ */
// Plain names in the nav — it's a signpost you scan in half a second, so it has
// to say what's behind it. The pages keep their own flavour in their headings.
const NAV = [
  { id: "lobby", label: "Dashboard", glyph: "dashboard" },
  { id: "scout", label: "Player Pool", glyph: "pool" },
  { id: "block", label: "Live Auction", glyph: "auction" },
  { id: "reserve", label: "Reserve Pool", glyph: "reserve" },
  { id: "locker", label: "Rosters", glyph: "rosters" },
  { id: "warroom", label: "Mock Draft", glyph: "mock" },
];
// grouped under the "Tournament" dropdown to keep the nav from overflowing
const TOURNEY_NAV = [
  { id: "bracket", label: "Fixtures", glyph: "fixtures" },
  { id: "leaderboard", label: "Leaderboard", glyph: "leaderboard" },
  { id: "veto", label: "Map Veto", glyph: "veto", adminOnly: true },
];

/* ════════════════════════════════════════════════════════════════════
   MULTI-TENANT SHELL — login + community select, then the draft app.
   Sets window.__VOLT.{communityId,userId} so the storage layer is scoped.
   ════════════════════════════════════════════════════════════════════ */
function VoltGate() {
  const [phase, setPhase] = useState("loading"); // loading | welcome | signin | host | join | schedule | ready
  // On the hub the next click is usually "enter the tournament": fetch its code
  // now, after the hub has had a moment to paint. (Hooks stay above this
  // component's early returns.)
  useEffect(() => {
    if (phase !== "schedule") return;
    const t = setTimeout(() => { loadTournament().catch(() => {}); }, 1200);
    return () => clearTimeout(t);
  }, [phase]);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [community, setCommunity] = useState(null);
  const [err, setErr] = useState("");
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [leagueName, setLeagueName] = useState("");
  const [ccode, setCcode] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingIntent, setPendingIntent] = useState(null); // host | join — what to do after auth
  const [activeEvent, setActiveEvent] = useState(null);
  const [targetView, setTargetView] = useState(null); // deep-link a rail view when entering a tournament
  const [pendingProfile, setPendingProfile] = useState(null); // open a player profile after routing to the hub
  const [hostNote, setHostNote] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [pendingChecked, setPendingChecked] = useState(null); // last "check again" on the pending screen
  const recoveryRef = useRef(false);   // signed in through a password-reset link
  const [showPw, setShowPw] = useState(false);
  const [pw2, setPw2] = useState("");  // new-password confirmation on the reset screen
  const [info, setInfo] = useState(""); // neutral status line (e.g. "check your email")
  const [invitedTo, setInvitedTo] = useState(null); // league name, when they arrived on an invite link
  const [invite, setInvite] = useState(null); // { league, card }: a signed-in player's invite to a new league
  const discordAuth = HAS_SUPABASE;
  const [showEmail, setShowEmail] = useState(false); // Discord leads; email is one tap away

  // ?join=<code> lets a host post one link instead of asking people to copy a
  // code between two apps. Read once on mount and stripped from the URL, so a
  // refresh after joining doesn't try to re-join.
  const joinLink = useRef(null);
  if (joinLink.current === null) {
    let c = "";
    try { c = new URLSearchParams(window.location.search).get("join") || ""; } catch { /* no URL */ }
    joinLink.current = c.trim().toLowerCase();
  }

  // The current league belongs to the account, not the tab. If it changed in
  // another tab or on another device, this one would otherwise keep asking for a
  // league it can no longer read and quietly show nothing.
  useEffect(() => {
    if (!HAS_SUPABASE) return;
    const onStorage = (e) => { if (e.key === LEAGUE_SWITCH_KEY) window.location.reload(); };
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || !window.__VOLT.communityId) return;
      try {
        const { data } = await __sb.rpc("volt_my_leagues");
        const current = (data?.leagues || []).find((l) => l.active);
        if (current && current.id !== window.__VOLT.communityId) window.location.reload();
      } catch { /* offline: try again next time */ }
    };
    window.addEventListener("storage", onStorage);
    document.addEventListener("visibilitychange", onVisible);
    return () => { window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisible); };
  }, []);

  // In preview (no Supabase), skip straight into the app with a memory community.
  useEffect(() => {
    if (!HAS_SUPABASE) {
      window.__VOLT.communityId = "preview";
      window.__VOLT.userId = "preview-user";
      window.__VOLT.weekendId = "preview-tournament";
      setPhase("ready");
      return;
    }
    // Back from Discord linking (api/discord-oauth redirects here with the result).
    let discordReturn = null;
    try { discordReturn = new URLSearchParams(window.location.search).get("discord"); } catch { /* no URL */ }
    // A password-reset email link lands here carrying a recovery session.
    const recovering = __RECOVERY_AT_LOAD || /type=recovery/.test(window.location.hash || "");
    if (recovering) recoveryRef.current = true;
    if (joinLink.current) {
      __sb.rpc("join_lookup", { p_slug: joinLink.current })
        .then(({ data }) => { const c = Array.isArray(data) ? data[0] : data; if (c?.name) setInvitedTo(c.name); })
        .catch(() => { /* fall back to the code field */ });
    }
    if (joinLink.current || discordReturn) {
      if (joinLink.current) setCcode(joinLink.current);
      // Drop the query string but keep history usable — otherwise a refresh
      // after joining reopens the join screen for someone already in a league.
      try { window.history.replaceState({}, "", window.location.pathname); } catch { /* ignore */ }
    }
    if (discordReturn) {
      const msg = {
        linked: ["Discord connected — VOLT can DM you about drafts and matches.", "ok"],
        cancelled: ["Discord wasn't connected. You can try again any time.", "warn"],
        expired: ["That Discord link expired — press Connect Discord again.", "warn"],
        failed: ["Couldn't reach Discord — try connecting again in a moment.", "error"],
        email_exists: ["That email already has a VOLT account. Sign in with your password, then press Connect Discord once and this button will work next time.", "warn"],
      }[discordReturn];
      if (msg) setTimeout(() => voltToast(msg[0], msg[1]), 400);
    }
    (async () => {
      // Back from "Continue with Discord": trade the single-use token for a session.
      const loginToken = /[#&]volt_login=([^&]+)/.exec(window.location.hash || "");
      if (loginToken) {
        try { window.history.replaceState({}, "", window.location.pathname + window.location.search); } catch { /* ignore */ }
        const { error } = await __sb.auth.verifyOtp({ token_hash: decodeURIComponent(loginToken[1]), type: "magiclink" });
        if (error) { console.error("discord login", error); setTimeout(() => voltToast("Discord sign-in didn't finish. Please try again.", "error"), 400); }
      }
      const { data } = await __sb.auth.getSession();
      if (data?.session) {
        setSession(data.session);
        if (recoveryRef.current) setPhase("reset");
        else await loadProfile(data.session.user.id);
      }
      // A code in the URL means they came from an invite, so send them straight
      // to the join form rather than a generic welcome screen.
      else if (discordReturn === "email_exists") { setShowEmail(true); setPhase("signin"); }
      else setPhase(joinLink.current ? "join" : "welcome");
    })();
    const { data: sub } = __sb.auth.onAuthStateChange((e, s) => {
      setSession(s || null);
      if (e === "PASSWORD_RECOVERY") { recoveryRef.current = true; setPhase("reset"); return; }
      if (!s) setPhase("welcome");
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  async function loadProfile(uid) {
    window.__VOLT.userId = uid;
    // Back from "Continue with Discord": finish what they started (join or
    // create) with the values they'd entered before the redirect.
    const authResume = takeResume((r) => r.kind === "auth");
    if (authResume) {
      const ok = authResume.intent === "host"
        ? await doHost({ leagueName: authResume.leagueName, displayName: authResume.displayName })
        : await doJoin({ code: authResume.code, displayName: authResume.displayName });
      if (ok) return;
      // Something went wrong — put them back on the form with their values.
      if (authResume.intent === "host") { setLeagueName(authResume.leagueName || ""); setPendingIntent("host"); setPhase("host"); }
      else { setCcode(authResume.code || ""); setPendingIntent("join"); setPhase("join"); }
      setDisplayName(authResume.displayName || "");
      return;
    }
    if (await routeLeague(uid)) return;
    const { data: u } = await __sb.from("users").select("*, communities(*)").eq("id", uid).maybeSingle();
    if (u && u.community_id) {
      // Discord sign-ins keep their league link current (idempotent).
      __sb.auth.getSession().then(({ data }) => linkDiscordIfAny(data?.session?.user)).catch(() => {});
      setProfile(u); setCommunity(u.communities);
      window.__VOLT.communityId = u.community_id;
      window.__VOLT.communityName = u.communities?.name || null;
      window.__VOLT.userName = u.display_name || null;   // used for vote attribution
      window.__VOLT.isHost = u.role === "host";              // strictly the owner
      window.__VOLT.isStaff = u.role === "host" || u.role === "moderator"; // + moderators
      // A league still awaiting review can't run anything yet. Returning hosts
      // used to land on the schedule and only learn that when creating a
      // tournament failed.
      if (u.communities?.status === "pending") { setPhase("pending"); return; }
      // Coming back from Discord mid-setup: the setup lives on the hub, so go
      // there rather than diving into a live tournament and stranding it.
      if (peekResume()) { setPhase("schedule"); return; }
      // Dive straight into a LIVE tournament (draft/matches) — login shouldn't
      // land on a list when there's a tournament to be inside. Registration and
      // "all settled" fall through to the hub (that's where the play toggle is).
      try {
        const { data: evs } = await __sb.from("events").select("*").eq("community_id", u.community_id);
        const RANK = { matches_live: 4, drafting: 3, registration_closed: 2, registration_open: 1, settled: 0 };
        const live = (evs || []).filter(e => e.phase === "drafting" || e.phase === "matches_live")
          .sort((a, b) => (RANK[b.phase] - RANK[a.phase]) || (new Date(a.created_at) - new Date(b.created_at)))[0];
        if (live) {
          window.__VOLT.weekendId = live.id; window.__VOLT.weekendLabel = weekendName(live);
          setActiveEvent(live); setPhase("ready"); return;
        }
      } catch (e) { console.error("auto-route", e); }
      setPhase("schedule");
    } else {
      // Authenticated but not yet in a community — route by the intent they picked.
      setProfile(u || null);
      setPhase(pendingIntent === "join" ? "join" : pendingIntent === "host" ? "host" : "welcome");
    }
  }

  // Signed in with Discord → their Discord is already verified, so link it to
  // the league profile now instead of asking them to connect it separately.
  async function linkDiscordIfAny(user) {
    if (!user?.app_metadata?.discord_id) return;
    try { await __sb.rpc("volt_link_discord_from_auth"); } catch (e) { console.error("discord auto-link", e); }
  }

  // Settle which league this session opens. Returns true when it has shown a
  // screen of its own and loading should stop there.
  async function routeLeague() {
    const { data, error } = await __sb.rpc("volt_my_leagues");
    if (error) { console.error("my leagues", error); return false; }
    const mine = data?.leagues || [];
    const code = joinLink.current;
    if (code) {
      // An invite link, which is also how a Discord message points at a league.
      joinLink.current = "";
      const hit = mine.find((l) => l.slug.toLowerCase() === code);
      if (hit) {
        if (!hit.active) await __sb.rpc("volt_switch_league", { p_community: hit.id });
      } else if (mine.length) {
        const { data: rows } = await __sb.rpc("join_lookup", { p_slug: code });
        const league = Array.isArray(rows) ? rows[0] : rows;
        if (league) { setInvite({ league, card: data.card }); setPhase("joinConfirm"); return true; }
        setTimeout(() => voltToast("That invite link isn't for a league that's open right now.", "warn"), 400);
      } else {
        setPendingIntent("join"); setPhase("join"); return true;
      }
      markLeagueChosen(false);
      return false;
    }
    // Fresh visit: a live draft or match in another league beats wherever they
    // were last. Once they've picked a league this session, leave them there.
    let chosen = false;
    try { chosen = sessionStorage.getItem(LEAGUE_CHOSEN_KEY) === "1"; } catch { /* private mode */ }
    if (!chosen && mine.length > 1) {
      const isLive = (l) => l.phase === "drafting" || l.phase === "matches_live";
      const live = mine.find(isLive);
      if (live && !mine.find((l) => l.active && isLive(l))) await __sb.rpc("volt_switch_league", { p_community: live.id });
    }
    markLeagueChosen(false);
    return false;
  }

  // "Continue with Discord" — one tap instead of email + password + a separate
  // Discord connection. The redirect wipes component state, so what they'd
  // chosen (join code, league name, display name) rides along as a resume note.
  async function continueWithDiscord(intent) {
    setErr(""); setBusy(true);
    try {
      if (intent === "join") {
        if (!ccode.trim()) throw new Error("Enter your league's join code first.");
        const { data: rows } = await __sb.rpc("join_lookup", { p_slug: ccode.trim() });
        if (!(Array.isArray(rows) ? rows[0] : rows)) throw new Error("No league found with that code. Check with your host.");
        setResume({ kind: "auth", intent, code: ccode.trim(), displayName: displayName.trim() });
      } else if (intent === "host") {
        if (!leagueName.trim()) throw new Error("Give your league a name first.");
        setResume({ kind: "auth", intent, leagueName: leagueName.trim(), displayName: displayName.trim() });
      }
      if (IS_NATIVE) {
        // In the app: sign in in the phone's browser, come back via com.voltleagues.app://auth.
        await openAuthUrl(`${SITE}/api/discord-oauth?login=1&app=1`);
        setBusy(false);
        return;
      }
      window.location.href = "/api/discord-oauth?login=1";
    } catch (e) { setErr(e.message || "Couldn't start Discord sign-in."); setBusy(false); }
  }

  // Returning user: plain sign in, then land wherever they belong.
  async function doSignIn() {
    setErr(""); setBusy(true);
    try {
      const { data, error } = await __sb.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
      if (data?.user) await loadProfile(data.user.id);
    } catch (e) { setErr(e.message || "Sign in failed"); }
    setBusy(false);
  }

  // Ensure we have an authenticated user WITH AN ACTIVE SESSION for the given
  // email/pw. Without a session, later inserts run as the anon role and RLS
  // denies them — so we require session, not just a user object.
  async function ensureAuthedUser() {
    // Already signed in? Reuse that session — don't re-auth or switch accounts.
    const { data: cur } = await __sb.auth.getSession();
    if (cur?.session?.user) return cur.session.user;
    let { data: si } = await __sb.auth.signInWithPassword({ email, password: pw });
    if (si?.session && si?.user) return si.user;
    // No existing account (or wrong pw) → create one.
    const { data: su, error: suErr } = await __sb.auth.signUp({ email, password: pw });
    if (suErr) {
      if (/registered|already/i.test(suErr.message)) throw new Error("That email already has an account — wrong password. Try Sign in instead.");
      throw suErr;
    }
    // signUp returns session:null when email confirmation is required.
    if (!su?.session) {
      if (su?.user && !su?.session) throw new Error("That email already exists — use Sign in with your existing password.");
      throw new Error("Check your email to confirm your account, then Sign in. (Or ask us to disable email confirmation.)");
    }
    return su.user;
  }

  // Host path: create the league, become host (atomic RPC — avoids RLS ordering).
  // over: values carried through a Discord sign-in (state is reset by the redirect).
  async function doHost(over = {}) {
    setErr(""); setBusy(true);
    try {
      const name = (over.leagueName ?? leagueName).trim();
      if (!name) throw new Error("Give your league a name.");
      const user = await ensureAuthedUser();
      window.__VOLT.userId = user.id;
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20) + "-" + Math.random().toString(36).slice(2, 5);
      const dn = (over.displayName ?? displayName) || discordNameOf(user) || (user.email || email).split("@")[0];
      const { data: rows, error } = await __sb.rpc("create_league", { p_name: name, p_slug: slug, p_display: dn });
      if (error) throw error;
      const c = Array.isArray(rows) ? rows[0] : rows;
      if (!c) throw new Error("League was not created — try again.");
      window.__VOLT.communityId = c.id; window.__VOLT.communityName = c.name; setCommunity(c);
      setProfile({ id: user.id, role: "host", display_name: dn, community_id: c.id });
      await linkDiscordIfAny(user);
      // New leagues are reviewed before they can run anything, so send the host
      // to a waiting screen rather than a schedule they can't use.
      setPhase(c.status === "approved" ? "schedule" : "pending");
      setBusy(false); return true;
    } catch (e) { setErr(e.message || "Could not create the league."); }
    setBusy(false); return false;
  }

  async function saveHostNote() {
    setBusy(true);
    try {
      // Via an RPC, not a table write: clients no longer have UPDATE on
      // communities at all, because that grant was what made the approval
      // gate bypassable from the console.
      const { error } = await __sb.rpc("volt_set_request_note", { p_note: hostNote.trim() });
      if (error) throw new Error(error.message);
      setNoteSaved(true);
    } catch (e) { console.error("host note", e); setNoteSaved(true); }
    setBusy(false);
  }

  // Join path: code first, then account, placed as player.
  async function doJoin(over = {}) {
    setErr(""); setBusy(true);
    try {
      const code = (over.code ?? ccode).trim();
      if (!code) throw new Error("Enter your league's join code.");
      const { data: rows } = await __sb.rpc("join_lookup", { p_slug: code });
      const c = Array.isArray(rows) ? rows[0] : rows;
      if (!c) throw new Error("No league found with that code. Check with your host.");
      const user = await ensureAuthedUser();
      window.__VOLT.userId = user.id;
      // Adds them to this league without touching any league they're already in,
      // and carries their player card, WhatsApp and Discord link across. Anyone
      // already in it just moves there.
      const { error: joinErr } = await __sb.rpc("volt_join_league", { p_slug: code, p_display: (over.displayName ?? displayName).trim() || null });
      if (joinErr) throw joinErr;
      await linkDiscordIfAny(user);
      markLeagueChosen(true);
      window.location.reload();
      setBusy(false); return true;
    } catch (e) { setErr(e.message || "Could not join the league."); }
    setBusy(false); return false;
  }

  const wrap = (inner) => (
    <div className="vg-shell" style={{ position: "relative", minHeight: "100vh", background: "#0a0d18", color: "#ecf3ff", display: "grid", placeItems: "center", fontFamily: "'Rajdhani',sans-serif", padding: 20, overflow: "hidden" }}>
      <ShellStyles />
      {/* ── Animated landing backdrop: dimmed art, real forked lightning,
             drifting particle field, and a perspective circuit grid. ── */}
      <style>{`
        @keyframes voltPulseA { 0%,100% { opacity: .16; transform: scale(1); } 50% { opacity: .30; transform: translate3d(2%, -2%, 0) scale(1.1); } }
        @keyframes voltGridPulse { 0% { transform: translateY(0); opacity: 0; } 12% { opacity: .55; } 100% { transform: translateY(-220px); opacity: 0; } }
        @keyframes voltMote { 0% { transform: translate3d(0,0,0); opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { transform: translate3d(var(--dx), var(--dy), 0); opacity: 0; } }
        @media (prefers-reduced-motion: reduce) {
          .volt-bg-img, .volt-bg-a, .volt-mote, .volt-gridline { animation: none !important; opacity: 0; }
          .volt-bg-img { opacity: 1 !important; }
        }
      `}</style>
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        {/* the art — dimmed so the UI reads clearly on top */}
        <img src={IMG_GATE_BG} alt="" className="volt-bg-img"
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", objectPosition: "center 40%",
            opacity: 0.38, filter: "brightness(0.62) saturate(1.08)" }} />

        {/* circuit grid — perspective floor with pulses running up its lines */}
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: "42%", overflow: "hidden",
          perspective: "340px", perspectiveOrigin: "50% 0%", opacity: 0.34 }}>
          <div style={{ position: "absolute", inset: "-40% -20% -10% -20%", transform: "rotateX(66deg)", transformOrigin: "50% 0%",
            backgroundImage: "linear-gradient(rgba(61,123,255,0.34) 1px, transparent 1px), linear-gradient(90deg, rgba(61,123,255,0.34) 1px, transparent 1px)",
            backgroundSize: "58px 58px", maskImage: "linear-gradient(to top, #000 5%, transparent 82%)", WebkitMaskImage: "linear-gradient(to top, #000 5%, transparent 82%)" }}>
            {[0, 1, 2].map(i => (
              <div key={i} className="volt-gridline" style={{ position: "absolute", left: 0, right: 0, height: 2,
                background: "linear-gradient(90deg, transparent, rgba(120,200,255,0.85), transparent)",
                bottom: 0, animation: `voltGridPulse ${7 + i * 2.5}s linear infinite`, animationDelay: `${i * 2.6}s` }} />
            ))}
          </div>
        </div>

        {/* particle drift — glowing motes rising slowly, "system online" */}
        {Array.from({ length: 26 }).map((_, i) => {
          const seed = (i * 37) % 100;
          const size = 1.5 + (i % 4) * 0.9;
          return (
            <span key={i} className="volt-mote" style={{
              position: "absolute", left: `${seed}%`, top: `${(i * 23) % 100}%`,
              width: size, height: size, borderRadius: "50%",
              background: i % 3 === 0 ? "rgba(120,220,255,0.95)" : "rgba(110,165,255,0.85)",
              boxShadow: `0 0 ${5 + size * 2}px rgba(90,180,255,0.75)`,
              "--dx": `${((i % 5) - 2) * 22}px`, "--dy": `-${90 + (i % 7) * 32}px`,
              animation: `voltMote ${13 + (i % 9) * 2.6}s linear infinite`, animationDelay: `${(i * 0.9) % 14}s`,
            }} />
          );
        })}

        {/* soft bloom + edge vignette */}
        <div className="volt-bg-a" style={{ position: "absolute", right: "8%", top: "14%", width: "38vw", height: "38vw", borderRadius: "50%",
          background: "radial-gradient(circle, rgba(61,123,255,0.26), rgba(61,123,255,0) 70%)", filter: "blur(30px)", animation: "voltPulseA 12s ease-in-out infinite" }} />
        <div style={{ position: "absolute", inset: 0, boxShadow: "inset 0 0 30vw 10vw rgba(6,9,18,0.9)" }} />
      </div>
      <div style={{ position: "relative", width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <VoltWordmark height={64} style={{ margin: "0 auto" }} />
          <div style={{ fontSize: 13, letterSpacing: "0.42em", color: "#6f9bff", fontWeight: 700, textTransform: "uppercase", marginTop: 14 }}>// League platform</div>
        </div>
        <div style={{ position: "relative", background: "linear-gradient(160deg,rgba(20,26,42,0.9),rgba(10,13,22,0.9))", border: "1px solid rgba(61,123,255,0.3)", clipPath: SHELL_NOTCH(18), padding: 26 }}>
          <span style={{ position: "absolute", left: 0, top: 0, width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
          <span style={{ position: "absolute", right: 0, bottom: 0, width: 10, height: 10, borderRight: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />
          {inner}
          {err && <p style={{ color: "#ff8a94", fontSize: 13, marginTop: 12 }}>{err}</p>}
        </div>
      </div>
    </div>
  );
  const field = { width: "100%", padding: "11px 12px", background: "rgba(10,16,30,0.65)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 15, marginBottom: 10, boxSizing: "border-box" };
  const btn = (primary) => shellBtn(primary ? "primary" : "ghost", { width: "100%", padding: "13px", fontSize: 13.5, letterSpacing: "0.18em", marginTop: 4, clipPath: SHELL_NOTCH(12) });

  if (phase === "loading") return wrap(<p className="vg-loading" style={{ margin: 0 }}>// Syncing…</p>);

  const account = {
    name: profile?.display_name || (HAS_SUPABASE ? (session?.user?.email || "You") : "Preview"),
    role: profile?.role || "player",
    community: community?.name,
    code: community?.slug,
  };
  const signOut = async () => {
    try { if (HAS_SUPABASE) await __sb.auth.signOut(); } catch (e) { console.error(e); }
    window.__VOLT.communityId = null; window.__VOLT.userId = null; window.__VOLT.weekendId = null;
    setProfile(null); setCommunity(null); setActiveEvent(null); setSession(null);
    setEmail(""); setPw(""); setDisplayName(""); setLeagueName(""); setCcode(""); setPendingIntent(null);
    setPhase("welcome");
  };

  if (phase === "schedule") return <WeekendSchedule community={community}
    isHost={profile?.role === "host" || profile?.role === "moderator"}
    isTrueHost={profile?.role === "host"}
    account={account} onSignOut={signOut}
    openProfile={pendingProfile} onProfileOpened={() => setPendingProfile(null)}
    onEnter={(ev, view) => { window.__VOLT.weekendId = ev.id; window.__VOLT.weekendLabel = weekendName(ev); setActiveEvent(ev); setTargetView(view || null); setPhase("ready"); }} />;

  if (phase === "ready") {
    const auth = HAS_SUPABASE
      ? { role: profile?.role || "player", name: profile?.display_name, userId: window.__VOLT.userId }
      : { role: "host", name: "Preview" };
    return <Suspense fallback={<TournamentLoading />}><WeekendApp
      auth={auth}
      event={activeEvent}
      isHost={profile?.role === "host" || profile?.role === "moderator"}
      isTrueHost={profile?.role === "host"}
      account={account} onSignOut={signOut}
      initialView={targetView}
      onBack={() => { window.__VOLT.weekendId = null; setActiveEvent(null); setTargetView(null); setPhase("schedule"); }} /></Suspense>;
  }

  const backLink = (
    <button type="button" onClick={() => { setErr(""); setInfo(""); setPhase("welcome"); }} style={{ background: "none", border: "none", color: "rgba(200,215,255,0.55)", fontFamily: "'Rajdhani',sans-serif", fontSize: 13, letterSpacing: "0.06em", cursor: "pointer", marginBottom: 14, padding: 0 }}>‹ Back</button>
  );
  // Real <form>s so Enter submits and password managers can save and fill.
  // Labels stay visible while typing (placeholders vanish, labels don't).
  const fieldLbl = { display: "block", fontSize: 10.5, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700,
    color: "rgba(200,215,255,0.55)", marginBottom: 5, fontFamily: "'Rajdhani',sans-serif", textAlign: "left" };
  const labelled = (text, input, hint) => (
    <label style={{ display: "block" }}>
      <span style={fieldLbl}>{text}</span>
      {input}
      {hint && <span style={{ display: "block", fontSize: 11.5, color: "rgba(200,215,255,0.42)", margin: "-5px 0 10px" }}>{hint}</span>}
    </label>
  );
  const pwInput = (value, onChange, autoComplete, placeholder) => (
    <div style={{ position: "relative" }}>
      <input style={{ ...field, paddingRight: 64 }} type={showPw ? "text" : "password"} name="password" autoComplete={autoComplete}
        placeholder={placeholder} value={value} onChange={onChange} required minLength={6} />
      <button type="button" onClick={() => setShowPw(v => !v)} aria-label={showPw ? "Hide password" : "Show password"}
        style={{ position: "absolute", right: 6, top: 6, padding: "6px 9px", background: "none", border: "none", color: "#7da6ff",
          fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>
        {showPw ? "Hide" : "Show"}</button>
    </div>
  );
  // newAccount: suggest a fresh password (sign-up) instead of filling a saved one.
  const emailPw = (newAccount) => (<>
    {labelled("Email", <input style={field} type="email" name="email" autoComplete="email" inputMode="email" required
      placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />)}
    {labelled("Password", pwInput(pw, e => setPw(e.target.value), newAccount ? "new-password" : "current-password",
      newAccount ? "At least 6 characters" : ""))}
  </>);
  const submitting = (fn) => (e) => { e.preventDefault(); if (!busy) fn(); };
  // One tap: account + verified Discord together. Email stays as the fallback.
  const emailHidden = discordAuth && !session && !showEmail;
  const discordFirst = (intent, label) => emailHidden && (<>
    <button type="button" disabled={busy} onClick={() => continueWithDiscord(intent)}
      style={{ ...btn(true), marginTop: 2, background: "#5865F2", borderColor: "#7983f5", color: "#fff", boxShadow: "0 0 24px rgba(88,101,242,0.35)" }}>
      {busy ? "…" : label}</button>
    <div style={{ textAlign: "center", marginTop: 14 }}>
      <button type="button" onClick={() => { setErr(""); setShowEmail(true); }}
        style={{ background: "none", border: "none", minHeight: 44, padding: "0 12px", color: "#7da6ff", fontSize: 14, fontWeight: 700, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.04em" }}>
        Use email instead</button>
      <p style={{ margin: "2px 0 0", fontSize: 12, color: "rgba(200,215,255,0.5)" }}>Have an account but never connected Discord to it? Use email.</p>
    </div>
  </>);
  const infoLine = info && <p style={{ color: "#9af5c2", fontSize: 13, marginTop: 12, lineHeight: 1.5 }}>{info}</p>;

  async function sendReset() {
    setErr(""); setInfo(""); setBusy(true);
    try {
      if (!email.trim()) throw new Error("Enter the email you signed up with.");
      const { error } = await __sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: siteOrigin() });
      if (error) throw error;
      // Same message whether or not the address has an account, so this can't
      // be used to find out who's signed up.
      setInfo("If that email has an account, a reset link is on its way. Open it on this device to set a new password.");
    } catch (e) { setErr(e.message || "Couldn't send the reset email."); }
    setBusy(false);
  }
  async function saveNewPassword() {
    setErr(""); setBusy(true);
    try {
      if (pw.length < 6) throw new Error("Use at least 6 characters.");
      if (pw !== pw2) throw new Error("Those passwords don't match.");
      const { data, error } = await __sb.auth.updateUser({ password: pw });
      if (error) throw error;
      recoveryRef.current = false;
      try { window.history.replaceState({}, "", window.location.pathname); } catch { /* ignore */ }
      setPw(""); setPw2("");
      voltToast("Password updated — you're signed in.");
      if (data?.user) await loadProfile(data.user.id);
    } catch (e) { setErr(e.message || "Couldn't update the password."); }
    setBusy(false);
  }

  // Intent picker — the three front doors.
  if (phase === "welcome") return wrap(<>
    <p style={{ margin: "0 0 20px", color: "rgba(200,215,255,0.7)", fontSize: 14, textAlign: "center" }}>Run a Valorant auction league, or join one you were invited to.</p>
    <button onClick={() => { setErr(""); setPendingIntent("host"); setPhase("host"); }} style={{ ...btn(true), marginTop: 0, marginBottom: 10 }}>◆ Host a league</button>
    <button onClick={() => { setErr(""); setPendingIntent("join"); setPhase("join"); }} style={{ ...btn(false), marginBottom: 18 }}>Join a league</button>
    <div style={{ textAlign: "center", borderTop: "1px solid rgba(120,150,220,0.15)", paddingTop: 14 }}>
      <span style={{ color: "rgba(200,215,255,0.5)", fontSize: 13 }}>Already have an account? </span>
      <button onClick={() => { setErr(""); setPhase("signin"); }} style={{ background: "none", border: "none", color: "#5b8dff", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", textTransform: "uppercase", letterSpacing: "0.06em" }}>Sign in</button>
    </div>
  </>);

  // Returning user.
  if (phase === "signin") return wrap(<form onSubmit={submitting(doSignIn)}>
    {backLink}
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Welcome back. Sign in to your league.</p>
    {discordFirst("signin", "Continue with Discord")}
    {!emailHidden && <>
      {emailPw(false)}
      <button type="submit" disabled={busy} style={btn(true)}>{busy ? "…" : "Sign in →"}</button>
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button type="button" onClick={() => { setErr(""); setInfo(""); setPhase("forgot"); }}
          style={{ background: "none", border: "none", color: "#7da6ff", fontSize: 13, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.04em" }}>
          Forgot your password?</button>
      </div>
    </>}
  </form>);

  // Forgot password → email a reset link.
  if (phase === "forgot") return wrap(<form onSubmit={submitting(sendReset)}>
    <button type="button" onClick={() => { setErr(""); setInfo(""); setPhase("signin"); }} style={{ background: "none", border: "none", color: "rgba(200,215,255,0.55)", fontFamily: "'Rajdhani',sans-serif", fontSize: 13, letterSpacing: "0.06em", cursor: "pointer", marginBottom: 14, padding: 0 }}>‹ Back to sign in</button>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Enter your email and we'll send you a link to set a new password.</p>
    {labelled("Email", <input style={field} type="email" name="email" autoComplete="email" inputMode="email" required
      placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} />)}
    <button type="submit" disabled={busy || !!info} style={btn(!info)}>{busy ? "…" : info ? "✓ Sent" : "Send reset link →"}</button>
    {infoLine}
  </form>);

  // Arrived from the reset email → choose a new password.
  if (phase === "reset") return wrap(<form onSubmit={submitting(saveNewPassword)}>
    <p style={{ margin: "0 0 6px", color: "#5dcaa5", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Reset password</p>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Choose a new password for your account.</p>
    <input type="email" name="email" autoComplete="username" value={session?.user?.email || ""} readOnly hidden />
    {labelled("New password", pwInput(pw, e => setPw(e.target.value), "new-password", "At least 6 characters"))}
    {labelled("Confirm new password", pwInput(pw2, e => setPw2(e.target.value), "new-password", ""))}
    <button type="submit" disabled={busy} style={btn(true)}>{busy ? "…" : "Save new password →"}</button>
  </form>);

  // Host a league.
  if (phase === "host") return wrap(<form onSubmit={submitting(doHost)}>
    {backLink}
    <p style={{ margin: "0 0 6px", color: "#5dcaa5", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Host setup</p>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Name your league and create your host account. You'll get an invite link to share with players.</p>
    {labelled("League name", <input style={field} name="organization" autoComplete="organization" required placeholder="e.g. Minaal.GG" value={leagueName} onChange={e => setLeagueName(e.target.value)} />)}
    {discordFirst("host", "Create with Discord →")}
    {!emailHidden && <>
      {labelled("Your display name", <input style={field} name="nickname" autoComplete="nickname" placeholder="What players will see" value={displayName} onChange={e => setDisplayName(e.target.value)} />)}
      {!session && emailPw(true)}
      <button type="submit" disabled={busy} style={btn(true)}>{busy ? "…" : "Create my league →"}</button>
    </>}
  </form>);

  if (phase === "pending") return wrap(<>
    <p style={{ margin: "0 0 6px", color: "#f5c453", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Request received</p>
    <p style={{ margin: "0 0 14px", fontSize: 22, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", textTransform: "uppercase", letterSpacing: "0.02em" }}>
      {community?.name || "Your league"} is waiting on approval
    </p>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.65)", fontSize: 14, lineHeight: 1.65 }}>
      Every new league gets a quick look before it goes live — it keeps the platform
      clean and means someone actually helps you set yours up. It's usually done
      within a day: sign in again or tap <b style={{ color: "#ecf3ff" }}>Check again</b> below
      and you'll go straight to your league once it's approved.
    </p>
    <p style={{ margin: "0 0 18px", color: "rgba(200,215,255,0.45)", fontSize: 13, lineHeight: 1.6 }}>
      In the meantime, tell me about your community — where your players hang out and
      roughly how many you expect. It speeds this up.
    </p>
    <textarea value={hostNote} onChange={(e) => setHostNote(e.target.value)} rows={3}
      placeholder="e.g. ~40 players, mostly Gold–Diamond, we run scrims on Fridays"
      style={{ ...field, height: "auto", resize: "vertical" }} />
    <button disabled={busy || noteSaved} onClick={saveHostNote} style={btn(!noteSaved)}>
      {noteSaved ? "✓ Sent — thanks" : busy ? "…" : "Send"}
    </button>
    {/* There was no way off this screen: no refresh, no sign-out. */}
    <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap", alignItems: "center" }}>
      <button disabled={busy} onClick={async () => {
          setBusy(true); setErr("");
          try {
            const { data } = await __sb.auth.getSession();
            if (data?.session) await loadProfile(data.session.user.id);
            setPendingChecked(Date.now());
          } catch (e) { setErr(e.message || "Couldn't check right now."); }
          setBusy(false);
        }}
        style={{ ...btn(false), width: "auto", flex: 1, minWidth: 140 }}>{busy ? "…" : "↻ Check again"}</button>
      <button disabled={busy} onClick={async () => { try { await __sb.auth.signOut(); } catch (e) { console.error(e); } }}
        style={{ ...btn(false), width: "auto", flex: 1, minWidth: 140 }}>Sign out</button>
    </div>
    {pendingChecked && (
      <p style={{ margin: "10px 0 0", color: "rgba(200,215,255,0.5)", fontSize: 12.5 }}>
        Still under review as of {new Date(pendingChecked).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.
      </p>
    )}
  </>);

  // Join a league.
  if (phase === "joinConfirm" && invite) {
    const c = invite.card || {};
    const rank = [c.rank, c.rankDiv].filter(Boolean).join(" ");
    return wrap(<form onSubmit={submitting(() => doJoin({ code: invite.league.slug }))}>
      <p style={{ margin: "0 0 6px", color: "#af9aec", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>You're invited</p>
      <h2 style={{ margin: "0 0 16px", fontSize: 28, fontWeight: 700, textTransform: "uppercase", color: "#ecf3ff", overflowWrap: "anywhere" }}>Join {invite.league.name}?</h2>
      <div style={{ padding: "14px 16px", marginBottom: 12, background: "rgba(175,154,236,0.08)", border: "1px solid rgba(175,154,236,0.4)", clipPath: SHELL_NOTCH(8) }}>
        <div style={{ fontSize: 20, fontWeight: 700, textTransform: "uppercase", color: "#ecf3ff", overflowWrap: "anywhere" }}>{c.ign || c.name || "You"}</div>
        <div style={{ fontSize: 14, color: "rgba(200,215,255,0.7)", marginTop: 2 }}>{[rank, c.role, c.agent].filter(Boolean).join(" · ") || "You'll add your rank and role next"}</div>
      </div>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: "rgba(200,215,255,0.6)" }}>Your profile comes with you, and you stay in your other leagues. Rank changed? Update it on your profile after joining.</p>
      <button type="submit" disabled={busy} style={btn(true)}>{busy ? "…" : "Join league →"}</button>
      <button type="button" disabled={busy} onClick={() => { setInvite(null); setErr(""); setPhase("loading"); loadProfile(window.__VOLT.userId); }}
        style={{ ...btn(false), marginTop: 10 }}>Not now</button>
    </form>);
  }

  if (phase === "join") return wrap(<form onSubmit={submitting(doJoin)}>
    {backLink}
    <p style={{ margin: "0 0 6px", color: "#af9aec", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Join a league</p>
    {invitedTo ? (
      // From an invite link: the code is already known, so confirm the league by
      // name instead of asking them to check a code they never typed.
      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0 16px", padding: "11px 14px",
        background: "rgba(175,154,236,0.08)", border: "1px solid rgba(175,154,236,0.4)", clipPath: SHELL_NOTCH(8) }}>
        <span style={{ flex: 1, fontSize: 15, color: "#ecf3ff" }}>You're joining <b>{invitedTo}</b></span>
        <button type="button" onClick={() => { setInvitedTo(null); setCcode(""); }}
          style={{ background: "none", border: "none", color: "#af9aec", fontSize: 12, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", textDecoration: "underline" }}>Not this league?</button>
      </div>
    ) : <>
      <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Enter the join code your host gave you, then set up your account.</p>
      {labelled("Join code", <input style={{ ...field, textTransform: "lowercase" }} name="join-code" autoComplete="off" required placeholder="e.g. minaal-gg-x7k" value={ccode} onChange={e => setCcode(e.target.value)} />)}
    </>}
    {discordFirst("join", invitedTo ? `Join ${invitedTo} with Discord →` : "Join with Discord →")}
    {!emailHidden && <>
      {labelled("Your display name", <input style={field} name="nickname" autoComplete="nickname" placeholder="What captains and players will see" value={displayName} onChange={e => setDisplayName(e.target.value)} />)}
      {!session && <>
        {emailPw(true)}
        <p style={{ margin: "-4px 0 8px", fontSize: 12, color: "rgba(200,215,255,0.45)" }}>Already have an account? Use the same email and password — we'll sign you in.</p>
      </>}
      <button type="submit" disabled={busy} style={btn(true)}>{busy ? "…" : invitedTo ? `Join ${invitedTo} →` : "Join league →"}</button>
    </>}
  </form>);

  return wrap(<p className="vg-loading" style={{ margin: 0 }}>// Syncing…</p>);
}

// ── Shell design language — mirrors the old app's HUD aesthetic ─────────
// Notched clip-path corners, Rajdhani uppercase tracking, blue glow accents.
// Rajdhani is for headings and buttons: it's too narrow for sentences and forms.
const READ_FONT = "'Space Grotesk',sans-serif";
const SHELL_NOTCH = (n = 9) => `polygon(0 0, calc(100% - ${n}px) 0, 100% ${n}px, 100% 100%, ${n}px 100%, 0 calc(100% - ${n}px))`;
function shellBtn(kind, extra) {
  const kinds = {
    primary: { background: "linear-gradient(180deg,#4a86ff,#2f66e0)", borderColor: "rgba(140,180,255,0.55)", color: "#fff", boxShadow: "0 0 18px rgba(61,123,255,0.35)" },
    ghost:   { background: "linear-gradient(180deg, rgba(61,123,255,0.22), rgba(61,123,255,0.12))", borderColor: "rgba(125,166,255,0.75)", color: "#e6efff" },
    accent:  { background: "rgba(61,220,132,0.08)", borderColor: "rgba(61,220,132,0.45)", color: "#9af5c2" },
    warn:    { background: "rgba(245,196,83,0.07)", borderColor: "rgba(245,196,83,0.45)", color: "#f5c453" },
    danger:  { background: "rgba(255,70,85,0.08)", borderColor: "rgba(255,70,85,0.45)", color: "#ff8a94" },
  };
  return {
    fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, textTransform: "uppercase",
    letterSpacing: "0.14em", fontSize: 12.5, cursor: "pointer", padding: "9px 16px",
    border: "1px solid", clipPath: SHELL_NOTCH(9),
    ...kinds[kind], ...(extra || {}),
  };
}
// ── Shared section chrome ────────────────────────────────────────────────
// Every panel on the league home draws its label, rule and shell from here so
// the page reads as one system instead of a stack of one-off boxes.
const SEC_LABEL = { fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", whiteSpace: "nowrap" };
const SEC_RULE = { flex: 1, minWidth: 12, height: 1, background: "linear-gradient(90deg, rgba(61,123,255,0.3), rgba(61,123,255,0))" };
const PANEL = (tone, pad) => ({
  padding: pad || "18px 20px",
  background: "linear-gradient(160deg, rgba(17,23,40,0.72), rgba(10,13,22,0.72))",
  border: `1px solid ${tone || "rgba(120,150,220,0.18)"}`,
  clipPath: SHELL_NOTCH(10),
});
function SectionHead({ title, hint, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
      <span style={SEC_LABEL}>// {title}</span>
      {hint && <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.42)", fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{hint}</span>}
      <span style={SEC_RULE} />
      {right}
    </div>
  );
}
// Panels that stay shut until needed (Discord setup, Staff) share one head, so a
// collapsed row and an open section still look like the same family.
function CollapseHead({ title, hint, open, onToggle, tone }) {
  return (
    <button onClick={onToggle}
      style={{ width: "100%", display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
        cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", textAlign: "left",
        background: "linear-gradient(160deg, rgba(17,23,40,0.72), rgba(10,13,22,0.72))",
        border: `1px solid ${tone || "rgba(120,150,220,0.18)"}`, clipPath: SHELL_NOTCH(10) }}>
      <span style={SEC_LABEL}>// {title}</span>
      {hint && <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", fontWeight: 500 }}>{hint}</span>}
      <span style={SEC_RULE} />
      <span style={{ color: "#7da6ff", fontSize: 10, transform: open ? "rotate(180deg)" : "none", transition: "transform .18s cubic-bezier(.2,.8,.3,1)" }}>▼</span>
    </button>
  );
}
// Phone-only rules (every one sits in a max-width query, so desktop never sees
// them). Shared by the shell screens and the draft app, which renders without
// the shell during the draft and the matches.
const MOBILE_CSS = `
    /* Collapsed roster card: header row only. */
    .volt-tc-shut .volt-tc-body > :not(:first-child) { display: none !important; }
    /* Swipeable strips: no scrollbar, momentum scroll. */
    .volt-hscroll { scrollbar-width: none; -webkit-overflow-scrolling: touch; scroll-snap-type: x proximity; }
    .volt-hscroll::-webkit-scrollbar { display: none; }
    .volt-hscroll > * { scroll-snap-align: start; }
    /* Phones and small tablets have the bottom tab bar (below 768px). */
    @media (max-width: 767px) {
      .volt-toast { bottom: calc(86px + env(safe-area-inset-bottom)) !important; }
    }
    /* Tablets and small laptops: slimmer stat columns, so the player's name
       and rank fit on one line instead of wrapping under each other. */
    @media (min-width: 721px) and (max-width: 1180px) {
      .volt-lb-head, .volt-lb-row { grid-template-columns: 36px minmax(0,1fr) 64px 36px 40px 40px 58px 66px !important; }
    }
    @media (max-width: 720px) {
      /* iOS Safari zooms the whole page when a focused input's text is under
         16px, and never zooms back out — the single worst mobile bug here,
         because it leaves the layout shifted with controls off-screen. */
      input, select, textarea { font-size: 16px !important; }

      /* Fingers, not cursors. Small ghost buttons were ~26px tall. */
      button, [role="button"], label > input[type="checkbox"] { min-height: 40px; }
      button { touch-action: manipulation; }

      /* The season table is 386px of fixed columns and the shell hides
         horizontal overflow, so on a 360px phone the last columns — including
         points — were clipped away with no way to scroll to them. Reflow to
         rank + name + points, and drop the per-stat columns. */
      .volt-lb-head { display: none !important; }
      .volt-lb-row {
        grid-template-columns: 30px minmax(0,1fr) auto auto !important;
        gap: 10px; padding-left: 12px !important; padding-right: 12px !important;
      }
      /* keep rank, name, points and performance; drop matches, W, K, A */
      .volt-lb-row > *:nth-child(n+3):nth-child(-n+6) { display: none; }

      /* Leaderboard podium: three cards in ~110px each — smaller type, the
         unit under the number, the meta line stacked. */
      .volt-podium { gap: 6px !important; }
      .volt-pod { padding: 14px 8px 12px !important; }
      .volt-pod-name { font-size: 16px !important; }
      .volt-pod-role { font-size: 8.5px !important; letter-spacing: 0.06em !important; }
      .volt-pod-val { font-size: 26px !important; }
      .volt-pod-val > span:last-child { display: block; margin: 4px 0 0 !important; font-size: 9.5px !important; }
      .volt-pod-meta { flex-direction: column; gap: 2px !important; font-size: 10px !important; }

      /* Page intros: two lines at most on a phone. */
      .volt-desc { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      /* Fixtures hero: tighter, and its host controls as small chips. */
      .volt-fxhero { padding: 18px 18px 16px !important; margin-bottom: 14px !important; }
      .volt-fxhero-actions { margin-top: 12px !important; gap: 6px !important; }
      .volt-fxhero-actions > *, .volt-fxhero-actions button { font-size: 10px !important; padding: 6px 9px !important; min-height: 32px !important; }

      /* Hub "last tournament" strip: label on its own line, button full width. */
      .volt-last-strip > :first-child { flex-basis: 100%; }
      .volt-last-strip > button:last-child { width: 100%; }

      /* Standings: RF/RA go, so points stay on screen without sideways scroll. */
      .volt-stand th:nth-child(6), .volt-stand td:nth-child(6),
      .volt-stand th:nth-child(7), .volt-stand td:nth-child(7) { display: none; }
      .volt-stand th, .volt-stand td { padding-left: 6px !important; padding-right: 6px !important; }
      .volt-stand th { letter-spacing: 0.08em !important; }
      .volt-stand td { font-size: 14px !important; }
      .volt-stand td:nth-child(2) .truncate { font-size: 15px !important; max-width: 30vw; display: inline-block; }

      /* Long unbroken strings — Discord handles, join codes, tracker URLs —
         would otherwise force the page wider than the screen. */
      /* break-word, not anywhere: "anywhere" also shrinks min-content widths,
         so tight cards (the leaderboard podium) split numbers mid-digit. */
      .page-wrap { overflow-wrap: break-word; }

      /* Modals: full height minus the notch, and scrollable. Several were
         taller than the viewport with the save button off the bottom and no
         way to reach it. Applied to the shared overlay's child, so it covers
         every dialog without each one needing its own class. */
      .volt-overlay { padding: 10px !important; align-items: start !important; }
      /* Short confirm/alert dialogs read better centred. */
      .volt-overlay.volt-overlay-center { align-items: center !important; }
      .volt-overlay > * {
        max-height: calc(100dvh - 20px) !important;
        overflow-y: auto !important;
        -webkit-overflow-scrolling: touch;
        width: 100% !important;
      }

      /* Anything genuinely wide — brackets — scrolls sideways on purpose
         instead of being cut off by the shell's overflow-x: hidden. */
      .volt-scroll-x { overflow-x: auto; -webkit-overflow-scrolling: touch; }

      /* Respect the home indicator and notch. */
      .page-wrap { padding-bottom: calc(28px + env(safe-area-inset-bottom)); }
    }

    /* Very narrow phones. */
    @media (max-width: 380px) {
      .page-wrap { padding-left: 12px !important; padding-right: 12px !important; }
    }

`;
function ShellStyles() {
  return <style>{`
    html { zoom: 1.1; }

    /* ── Phones ────────────────────────────────────────────────────────────
       Everything below is inside a max-width query, so the desktop layout is
       untouched. These fix things that are broken rather than merely tight. */
    /* The 1.1 page zoom costs ~33px of usable width on a 360px phone — the
       difference between the widest rows fitting and being clipped.
       Keyed on pointer type, NOT width, on purpose: zoom on <html> changes the
       viewport width that media queries are measured against, so resetting it
       inside a width query can flip a tablet back and forth between matching
       and not matching. Pointer type doesn't move when zoom does. */
    @media (pointer: coarse) {
      html { zoom: 1; }
    }

    ${MOBILE_CSS}
    .volt-expand-btn { transition: background .15s, border-color .15s, transform .15s; }
    .volt-expand-btn:hover { background: rgba(61,123,255,0.3); border-color: #6fa0ff; transform: scale(1.08); }
    /* Expandable list rows — the whole row is the control, so it has to look
       like one on hover, not just carry a small chevron. */
    .vg-row-x { transition: background .14s ease; }
    .vg-row-x:hover { background: rgba(255,255,255,0.055); }
    .vg-row-x:hover .vg-chev { filter: brightness(1.5); }
    .vg-row-x:hover .vg-chev-label { color: rgba(255,228,160,0.95); }
    .vg-chev { transition: transform .16s cubic-bezier(.2,.8,.3,1), background .14s ease, border-color .14s ease; }
    .vg-chev-label { transition: color .14s ease; }
    .volt-expand-btn { animation: voltExpandHint 2.4s ease-in-out 3; }
    @keyframes voltExpandHint {
      0%, 100% { box-shadow: 0 0 0 0 rgba(61,123,255,0); }
      50%      { box-shadow: 0 0 0 4px rgba(61,123,255,0.22); }
    }
    @media (prefers-reduced-motion: reduce) { .volt-expand-btn { animation: none; } }
    @media (max-width: 1440px) { html { zoom: 1.04; } }
    @media (max-width: 1180px) { html { zoom: 1; } }
    @media (max-width: 900px) { .page-wrap { padding-left: 18px; padding-right: 18px; } }
    /* Hero: headline block on the left, the one thing you'd act on pinned right.
       Without the explicit column the action box wrapped underneath and left
       half the card empty. */
    .volt-tourn-hero { display: grid; grid-template-columns: minmax(0,1fr) minmax(248px,318px); gap: 24px; align-items: start; }
    @media (max-width: 880px) { .volt-tourn-hero { grid-template-columns: minmax(0,1fr); gap: 18px; } }
    /* The card, not the window, decides: beside the season table on a tablet it
       is far narrower than the screen, and the copy was squeezed to a sliver. */
    #volt-current-hero { container-type: inline-size; }
    @container (max-width: 540px) { .volt-tourn-hero { grid-template-columns: minmax(0,1fr); gap: 18px; } }
    .vg-shell select { -webkit-appearance: none; -moz-appearance: none; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%235b8dff' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px !important;
      accent-color: #3d7bff; color-scheme: dark; cursor: pointer; }
    .vg-shell select:hover { border-color: rgba(111,160,255,0.6) !important; }
    .vg-shell select option { background: #0b0f1a !important; color: #ecf3ff !important; font-weight: 600; }
    .vg-shell select option:checked, .vg-shell select option:hover { background: #16233f !important; color: #7da6ff !important; }
    .vg-shell button { transition: transform .16s ease, box-shadow .16s ease, filter .16s ease; }
    .vg-shell button:hover:not(:disabled) { transform: translateY(-1px); filter: brightness(1.15); box-shadow: 0 0 20px rgba(61,123,255,0.3); }
    .vg-shell button:active:not(:disabled) { transform: translateY(0) scale(.98); }
    .vg-shell button:disabled { opacity: .45; cursor: not-allowed; }
    .vg-shell input:focus { border-color: rgba(111,160,255,0.8) !important; box-shadow: 0 0 0 3px rgba(61,123,255,0.18); outline: none; }
    .vg-shell *:focus-visible { outline: 2px solid #6fa0ff; outline-offset: 2px; }
    @keyframes vgPulse { 0%,100% { opacity: .35; } 50% { opacity: .9; } }
    .vg-loading { animation: vgPulse 1.4s ease-in-out infinite; letter-spacing: .28em; text-transform: uppercase; font-size: 12px; font-weight: 700; color: #5b8dff !important; text-align: center; }
  `}</style>;
}

// ── ACCOUNT PAGE — who you are in this league, and your season so far ──
//    Details (editable display name), season stat tiles from match_results,
//    and the scouting profile editor captains see before bidding.
function AccountView({ auth, chrome }) {
  const [me, setMe] = useState(null);
  const [nameDraft, setNameDraft] = useState("");
  const [saveMsg, setSaveMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!HAS_SUPABASE || !auth?.userId) return;
      try {
        const { data: u } = await __sb.from("users").select("*").eq("id", auth.userId).maybeSingle();
        if (alive && u) { setMe(u); setNameDraft(u.display_name || ""); }
      } catch (e) { console.error(e); }
    })();
    return () => { alive = false; };
  }, [auth?.userId]);

  async function saveName() {
    const v = nameDraft.trim();
    if (!v || !HAS_SUPABASE) return;
    setBusy(true); setSaveMsg("");
    try {
      const { error } = await __sb.from("users").update({ display_name: v }).eq("id", auth.userId);
      if (error) throw error;
      window.__VOLT.userName = v;
      setMe(m => ({ ...m, display_name: v }));
      setSaveMsg("Saved — shows everywhere from your next match on.");
    } catch (e) { console.error(e); setSaveMsg(e.message || "Couldn't save."); }
    setBusy(false);
  }

  const panel = { padding: "20px 22px", background: "linear-gradient(160deg, rgba(18,24,40,0.9), rgba(9,12,21,0.9))", border: "1px solid rgba(61,123,255,0.25)", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))" };
  const overline = { fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", marginBottom: 12 };
  const fieldLabel = { fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700, fontFamily: "'Rajdhani',sans-serif", marginBottom: 3 };

  // A new account has nothing to show until the scouting profile exists, so the
  // setup jumps to the top of the page; once it's filled in it returns to the
  // editing section at the bottom.
  const [bump, setBump] = useState(0);
  const onScoutSaved = () => { setBump((n) => n + 1); try { __sb.from("users").select("*").eq("id", auth.userId).maybeSingle().then(({ data }) => data && setMe(data)); } catch {} };
  const scoutPanelFor = (scoutFirst) => scoutFirst ? (
    // Top of the page: the setup card on its own, lit, no second frame around it.
    <div style={{ filter: "drop-shadow(0 0 22px rgba(61,123,255,0.22))" }}>
      <ScoutProfileCard userId={auth?.userId} onSaved={onScoutSaved} />
    </div>
  ) : (
    <div style={{ ...panel, ...(scoutFirst ? { border: "1px solid rgba(61,123,255,0.6)", boxShadow: "0 0 30px rgba(61,123,255,0.15)" } : {}) }}>
      <div style={overline}>// Scouting profile{scoutFirst ? " · start here" : ""}</div>
      <p style={{ fontSize: 13, color: "rgba(200,215,255,0.5)", margin: "0 0 10px", fontFamily: "'Rajdhani',sans-serif" }}>
        {scoutFirst ? "Your card, radar and stats are all built from this. Captains won't bid on a blank profile."
          : "Captains see this on the auction block — keep it honest, keep it current. Edits update the radar above."}</p>
      <ScoutProfileCard userId={auth?.userId} onSaved={() => { setBump((n) => n + 1); try { __sb.from("users").select("*").eq("id", auth.userId).maybeSingle().then(({ data }) => data && setMe(data)); } catch {} }} />
    </div>
  );
  // Editing lives below the read-only profile — same screen, clear separation.
  const editorFor = (empty) => (
    <div className="view-in" style={{ display: "grid", gap: 18, marginTop: 34 }}>
      {(me?.suspension_remaining || 0) > 0 && (
        <div style={{ padding: "14px 16px", background: "rgba(255,70,85,0.07)", border: "1px solid rgba(255,70,85,0.4)", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", fontFamily: "'Rajdhani',sans-serif" }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#ff8f9a" }}>Suspended — {me.suspension_remaining} tournament{me.suspension_remaining === 1 ? "" : "s"} remaining</div>
          <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", margin: "6px 0 0" }}>Triggered by repeated no-shows. It counts down automatically as tournaments settle.</p>
        </div>
      )}

      <div style={panel}>
        <div style={overline}>// Account details</div>
        <div style={{ display: "grid", gap: 14 }}>
          <div>
            <div style={fieldLabel}>Display name</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={nameDraft} onChange={e => setNameDraft(e.target.value)} maxLength={24}
                style={{ flex: 1, minWidth: 180, padding: "10px 12px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(61,123,255,0.35)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 15, fontWeight: 600 }} />
              <button disabled={busy || !nameDraft.trim() || nameDraft.trim() === (me?.display_name || "")} onClick={saveName}
                style={shellBtn("primary", { padding: "10px 20px", opacity: (busy || !nameDraft.trim() || nameDraft.trim() === (me?.display_name || "")) ? 0.5 : 1 })}>{busy ? "…" : "Save"}</button>
            </div>
            {saveMsg && <div style={{ fontSize: 12, color: saveMsg.startsWith("Saved") ? "#9af5c2" : "#ff8f9a", marginTop: 6 }}>{saveMsg}</div>}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, fontFamily: "'Rajdhani',sans-serif" }}>
            {me?.email && <div><div style={fieldLabel}>Email</div><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }}>{me.email}</div></div>}
            <div><div style={fieldLabel}>Role</div><div style={{ fontWeight: 700, textTransform: "uppercase", color: (me?.role || auth?.role) === "host" ? "#7da6ff" : "#ecf3ff" }}>{(me?.role || auth?.role) === "host" ? "Host" : "Player"}</div></div>
            <div><div style={fieldLabel}>League</div><div style={{ fontWeight: 700, textTransform: "uppercase" }}>{window.__VOLT.communityName || "—"}</div></div>
            {chrome?.account?.code && <div><div style={fieldLabel}>Join code</div><div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#7da6ff" }}>{chrome.account.code}</div></div>}
          </div>
        </div>
      </div>

      {!empty && scoutPanelFor(false)}
      {HAS_SUPABASE && <DiscordLinkCard />}

      {chrome?.onSignOut && (
        <button onClick={chrome.onSignOut} style={shellBtn("danger", { padding: "12px", letterSpacing: "0.14em" })}>Sign out</button>
      )}
    </div>
  );

  // The rich profile screen, rendered for the logged-in user, with the editor
  // dropped in as its footer. One coherent page, same visual language.
  return <PlayerProfile key={bump} userId={auth?.userId} onBack={null}
    lead={({ empty }) => empty ? <div style={{ marginBottom: 18 }}>{scoutPanelFor(true)}</div> : null}
    footer={({ empty }) => editorFor(empty)} />;
}

// Persistent account control — shows who you are + sign out. Used on every shell screen.
// Two stacked sheets with a folded corner — reads as "copy" at small sizes far
// better than the ⧉ glyph it replaces, which rendered inconsistently across
// fonts and was easy to mistake for a window or a table icon.
// Self-contained copy button — owns its own "copied" flash and the fallback for
// browsers where the async clipboard API is blocked, so callers just pass text.
function CopyButton({ text, label, style }) {
  const [done, setDone] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function go() {
    if (!text) return;
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand("copy"); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (!ok) return;                       // never claim success we didn't get
    setDone(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDone(false), 1600);
  }
  return (
    <button onClick={go} title={done ? "Copied" : "Copy"} aria-label={label || "Copy"}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", ...style }}>
      {done ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
      {label !== null && <span>{done ? "Copied" : (label || "Copy")}</span>}
    </button>
  );
}

function CopyIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={{ display: "block", flex: "0 0 auto" }}>
      <path d="M5 8v11h11" />
      <path d="M9 3h7l4 4v12H9z" />
      <path d="M16 3v4h4" />
    </svg>
  );
}
function CheckIcon({ size = 13 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={{ display: "block", flex: "0 0 auto" }}>
      <path d="M4 12.5l5.5 5.5L20 6.5" />
    </svg>
  );
}

function AccountChip({ account, onSignOut, onProfile, seat }) {
  const [leaguePanel, setLeaguePanel] = useState(null);
  const [open, setOpen] = useState(false);
  const compact = useNarrow(640);   // phones: just the initial, the menu holds the rest
  const dcLinked = useDiscordLinked();
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function copyCode(e) {
    e.stopPropagation();                      // keep the menu open
    const code = account?.code;
    if (!code) return;
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(code); ok = true; }
    } catch { /* falls through to the manual path below */ }
    if (!ok) {
      // The async clipboard API needs a secure context and can be blocked
      // outright, so fall back to the old selection trick rather than failing
      // silently on someone's phone.
      try {
        const ta = document.createElement("textarea");
        ta.value = code; ta.setAttribute("readonly", "");
        ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select(); ta.setSelectionRange(0, code.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (!ok) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div style={{ position: "relative", fontFamily: "'Rajdhani',sans-serif" }}>
      <button onClick={() => setOpen(o => !o)} aria-label="Account menu"
        style={{ height: 36, padding: compact ? 0 : "0 14px", width: compact ? 38 : undefined, justifyContent: "center", position: "relative", clipPath: SHELL_NOTCH(9), display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", background: "rgba(255,255,255,0.045)", border: "1px solid rgba(120,150,220,0.32)", color: "#dce7ff", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: seat?.color || "#3ddc84", boxShadow: `0 0 8px ${seat?.color || "rgba(61,220,132,0.8)"}`,
          ...(compact ? { position: "absolute", top: 5, right: 5, width: 6, height: 6 } : null) }} />
        {compact
          ? <span style={{ fontSize: 15, letterSpacing: 0 }}>{String(account.name || "?").trim().charAt(0).toUpperCase()}</span>
          : <><span>{account.name}</span><span style={{ color: "rgba(200,215,255,0.45)", fontSize: 9 }}>▼</span></>}
      </button>
      {open && <>
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 91, minWidth: 210, background: "linear-gradient(160deg, rgba(16,23,40,0.98), rgba(9,13,23,0.98))", border: "1px solid rgba(61,123,255,0.35)", clipPath: SHELL_NOTCH(12), padding: 14, boxShadow: "0 18px 50px rgba(0,0,0,0.6)" }}>
          <div style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", color: "#ecf3ff" }}>{account.name}</div>
          <div style={{ fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: account.role === "host" ? "#f5c453" : "#5b8dff", marginTop: 2, fontWeight: 600 }}>{account.role === "host" ? "Host" : "Player"}</div>
          {seat && (
            <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(120,150,220,0.15)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: seat.color, boxShadow: `0 0 8px ${seat.color}` }} />
                <span style={{ fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", color: seat.color }}>{seat.label}</span>
              </div>
              {seat.sub && <div style={{ fontSize: 11, color: "rgba(200,215,255,0.5)", marginTop: 3 }}>{seat.sub}</div>}
            </div>
          )}
          {account.community && <div style={{ fontSize: 12, color: "rgba(200,215,255,0.55)", marginTop: 8, paddingTop: 8, borderTop: "1px solid rgba(120,150,220,0.15)" }}>{account.community}{account.code && (
            <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: "#7da6ff" }}>code: {account.code}</span>
              <button onClick={copyCode} title={copied ? "Copied" : "Copy league code"} aria-label="Copy league code"
                style={{ display: "grid", placeItems: "center", width: 24, height: 24, padding: 0, flex: "0 0 auto", cursor: "pointer", lineHeight: 1,
                  background: copied ? "rgba(61,220,132,0.16)" : "rgba(61,123,255,0.1)",
                  border: `1px solid ${copied ? "rgba(61,220,132,0.55)" : "rgba(61,123,255,0.35)"}`,
                  color: copied ? "#9af5c2" : "#7da6ff" }}>{copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}</button>
              {copied && <span style={{ fontSize: 10.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9af5c2", fontWeight: 700 }}>Copied</span>}
            </span>
          )}</div>}
          {/* Only shown when they haven't linked — otherwise it's noise in a menu
              people open several times a session. */}
          {dcLinked === false && (
            <button onClick={() => { setOpen(false); startDiscordOAuth().catch(() => {}); }}
              style={shellBtn("accent", { width: "100%", marginTop: 12, padding: "9px", letterSpacing: "0.1em", fontSize: 11.5 })}>
              ◈ Connect Discord
            </button>
          )}
          {onProfile && <button onClick={() => { setOpen(false); onProfile(); }} style={shellBtn("ghost", { width: "100%", marginTop: 12, padding: "9px", letterSpacing: "0.1em" })}>⊞ My Account</button>}
          {onProfile && <button onClick={(e) => { setLeaguePanel(e.currentTarget.getBoundingClientRect()); setOpen(false); }} style={shellBtn("ghost", { width: "100%", marginTop: 8, padding: "9px", letterSpacing: "0.1em" })}>⇄ Switch league</button>}
          <button onClick={onSignOut} style={shellBtn("danger", { width: "100%", marginTop: onProfile ? 8 : 12, padding: "9px", letterSpacing: "0.1em" })}>Sign out</button>
        </div>
      </>}
      {leaguePanel && <LeaguePanel anchor={leaguePanel} onClose={() => setLeaguePanel(null)} />}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   SEASON SHELL — tournament schedule. Each tournament is its own scoped draft.
   ════════════════════════════════════════════════════════════════════ */
// ── Weekly-loop surfaces: trophy chips, play toggle, notifications, ──────
// public player profiles. All shell-level; the old app stays untouched.

const TrophyChip = ({ n, big }) => !n ? null : (
  <span title={`Won ${n} tournaments in a row`} style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 8, padding: big ? "3px 10px" : "1px 7px", fontSize: big ? 13 : 10.5, fontWeight: 700, letterSpacing: "0.08em", color: "#f5c453", border: "1px solid rgba(245,196,83,0.5)", background: "rgba(245,196,83,0.08)", clipPath: SHELL_NOTCH(5), fontFamily: "'IBM Plex Mono',monospace", textShadow: "0 0 10px rgba(245,196,83,0.5)" }}>🏆{n > 1 ? "×" + n : ""}</span>
);

function ToggleSwitch({ on, color, disabled, onClick }) {
  const c = color || "#3ddc84";
  return (
    <button onClick={disabled ? undefined : onClick} aria-pressed={on}
      style={{ position: "relative", width: 54, height: 28, flex: "0 0 auto", padding: 0,
        background: on ? `linear-gradient(90deg, ${c}33, ${c}55)` : "rgba(10,13,22,0.8)",
        border: `1px solid ${on ? c : "rgba(125,166,255,0.4)"}`, clipPath: SHELL_NOTCH(7),
        cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1,
        boxShadow: on ? `0 0 16px ${c}55, inset 0 0 10px ${c}33` : "inset 0 0 8px rgba(0,0,0,0.5)", transition: "all 180ms" }}>
      <span style={{ position: "absolute", top: 4, left: on ? 30 : 4, width: 18, height: 18,
        background: on ? c : "rgba(125,166,255,0.55)", clipPath: SHELL_NOTCH(5),
        boxShadow: on ? `0 0 10px ${c}` : "none", transition: "left 180ms cubic-bezier(.2,.8,.3,1), background 180ms" }} />
    </button>
  );
}

function FirstTimeOnboard({ ev, wantCap, onClose, onApplied, startPhase = "intro" }) {
  // "intro" opens straight on the form: a page of explanation before it only delayed people.
  const [phase, setPhase] = useState(startPhase === "intro" ? "edit" : startPhase); // edit → terms → applying → done
  const [note, setNote] = useState("");
  const [result, setResult] = useState(null);   // "approved" | "pending", from volt_apply
  const draftLine = ev?.draft_at
    ? new Date(ev.draft_at).toLocaleDateString(undefined, { weekday: "short" }) + " " + new Date(ev.draft_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  // Profile saved → show the commitment terms, then enter them.
  function afterSave() { setPhase("terms"); }

  async function applyNow() {
    setPhase("applying"); setNote("");
    try {
      const { data, error } = await __sb.rpc("volt_apply", { p_event: ev.id, p_wants_captain: !!wantCap });
      if (error) throw error;
      setResult(data === "approved" ? "approved" : "pending");
      setPhase("done");
      onApplied && await onApplied();
    } catch (e) { setNote(e.message || "Could not enter you in — try the toggle again."); setPhase("edit"); }
  }

  const step = (n, label, active, done) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "50%", fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace",
        background: done ? "#3ddc84" : active ? "rgba(61,123,255,0.2)" : "rgba(255,255,255,0.05)",
        color: done ? "#06210f" : active ? "#9dbdff" : "rgba(214,226,255,0.68)", border: `1px solid ${done ? "#3ddc84" : active ? "#3d7bff" : "rgba(120,150,220,0.25)"}` }}>{done ? "✓" : n}</span>
      <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 13.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap", color: active || done ? "#ecf3ff" : "rgba(214,226,255,0.68)" }}>{label}</span>
    </div>
  );

  // The commitment step is its own dialog, so draw only that rather than stacking
  // it on an empty copy of this one. Closing goes back to where the player came from.
  if (phase === "terms") return (
    <RegisterTerms ev={ev} onAccept={applyNow} onClose={() => (startPhase === "terms" ? onClose() : setPhase("edit"))} />
  );

  return (
    <VoltOverlay onClose={onClose} zIndex={130} dim="rgba(4,6,12,0.72)">
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto", background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)", clipPath: SHELL_NOTCH(16), padding: "24px 26px 26px", fontFamily: READ_FONT, color: "#ecf3ff", scrollbarWidth: "thin", scrollbarColor: "rgba(125,166,255,0.4) transparent" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 22, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.15 }}>{phase === "edit" ? "Your scouting profile" : weekendName(ev)}</div>
          <button onClick={onClose} aria-label="Close" style={shellBtn("ghost", { padding: "5px 11px", fontSize: 11 })}>✕</button>
        </div>

        {/* step rail — the three real steps, ticked off as they're done */}
        {(() => {
          const at = { edit: 1, applying: 3, done: 3 }[phase] || 1;
          const sep = <span style={{ flex: 1, height: 1, minWidth: 8, background: "rgba(120,150,220,0.3)" }} />;
          return (
            <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "14px 0 18px" }}>
              {step(1, "Profile", at === 1, at > 1)}{sep}
              {step(2, "Rules", at === 2, at > 2)}{sep}
              {step(3, "Done", at === 3 && phase !== "done", phase === "done")}
            </div>
          );
        })()}

        {phase === "edit" && <>
          <p style={{ fontSize: 15, lineHeight: 1.5, color: "rgba(224,233,255,0.85)", margin: "0 0 18px" }}>You only fill this in once. Captains read it before they bid on you.</p>
          <ScoutProfileCard userId={window.__VOLT.userId} onSaved={afterSave} embedded
            resume={{ kind: "onboard", eventId: ev.id, wantCap: !!wantCap }} />
          {note && <div style={{ fontSize: 13.5, color: "#ff8f9a", marginTop: 10 }}>{note}</div>}
        </>}

        {phase === "applying" && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div className="vg-loading" style={{ fontSize: 15 }}>// Entering you in the pool…</div>
          </div>
        )}

        {/* The finish line deserves a moment, and a clear picture of what happens next. */}
        {phase === "done" && <>
          <div style={{ textAlign: "center", padding: "6px 0 4px" }}>
            <div style={{ fontSize: 46, lineHeight: 1, color: result === "approved" ? "#3ddc84" : "#f5c453", textShadow: `0 0 30px ${result === "approved" ? "rgba(61,220,132,0.5)" : "rgba(245,196,83,0.45)"}` }}>{result === "approved" ? "✓" : "◷"}</div>
            <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 26, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", marginTop: 10 }}>
              {result === "approved" ? "You're in" : "Application sent"}
            </div>
            <p style={{ fontSize: 15, lineHeight: 1.5, color: "rgba(224,233,255,0.85)", margin: "8px 0 0" }}>
              {result === "approved"
                ? `You're in the pool for ${weekendName(ev)}.`
                : "Your first tournaments get a quick look from the host. You'll get a notification the moment you're approved."}
            </p>
          </div>
          <div style={{ display: "grid", gap: 10, margin: "18px 0", padding: "16px 18px", background: "rgba(10,16,30,0.6)", border: "1px solid rgba(61,123,255,0.22)", clipPath: SHELL_NOTCH(8) }}>
            <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9dbdff", fontWeight: 700 }}>What happens next</div>
            {[
              draftLine ? `The draft is ${draftLine}. You don't have to be there — captains bid on you either way.` : "The host sets the draft time — you'll see it here. You don't have to be there; captains bid on you either way.",
              "Once you're drafted, the bot DMs you your team on Discord.",
              "Can't make it after all? Flip \"I'm playing\" off before the draft — no strike.",
            ].map((t, i) => (
              <div key={i} style={{ display: "flex", gap: 10, fontSize: 14.5, lineHeight: 1.5, color: "rgba(224,233,255,0.88)" }}>
                <span style={{ color: "#7da6ff", fontWeight: 700 }}>{i + 1}</span><span>{t}</span>
              </div>
            ))}
          </div>
          <button onClick={onClose} style={shellBtn("primary", { width: "100%", padding: "13px", letterSpacing: "0.14em" })}>Done</button>
        </>}
      </div>
    </VoltOverlay>
  );
}

// The weekly ritual, one tap: OFF → PENDING (amber) → IN ✓ (green).
// Flipping on IS the application (availability implied); veterans with 2+
// ── Modal shell — portals to <body> so a parent's clip-path (our notched
//    cards) can never clip it. Every full-screen overlay should use this.
function VoltOverlay({ onClose, zIndex = 140, children, dim = "rgba(4,6,12,0.86)", center = false }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && onClose) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div className={"volt-overlay" + (center ? " volt-overlay-center" : "")} onClick={onClose}
      style={{ position: "fixed", inset: 0, zIndex, background: dim, display: "grid", placeItems: "center", padding: 20 }}>
      {children}
    </div>,
    document.body
  );
}

// ── In-app dialogs — replace window.confirm / alert / prompt, which render as
//    an unstyled grey browser box (and a cramped one on phones). Call from
//    anywhere: `if (!(await voltConfirm("Delete it?"))) return;`. One
//    <VoltDialogHost/> at the app root renders whichever is open.
const __dlg = { cur: null, subs: new Set() };
function __openDialog(d) {
  return new Promise((resolve) => {
    // A second dialog while one is open: resolve the first as cancelled.
    if (__dlg.cur) __dlg.cur.resolve(__dlg.cur.kind === "prompt" ? null : false);
    __dlg.cur = { ...d, resolve: (v) => { __dlg.cur = null; __dlg.subs.forEach((f) => f()); resolve(v); } };
    __dlg.subs.forEach((f) => f());
  });
}
// opts: { title, confirmLabel, cancelLabel, danger }
const voltConfirm = (message, opts = {}) => __openDialog({ kind: "confirm", message, ...opts });
// opts.match: the text the person must type to enable the confirm button.
const voltPrompt = (message, opts = {}) => __openDialog({ kind: "prompt", message, ...opts });

// ── Toasts — a brief, non-blocking confirmation ("Discord connected", "You're
//    in"). Unlike a dialog it asks nothing and gets out of the way.
const __toast = { cur: null, subs: new Set(), timer: null };
function voltToast(message, tone = "ok") {
  clearTimeout(__toast.timer);
  __toast.cur = { message, tone, id: Date.now() };
  __toast.subs.forEach((f) => f());
  __toast.timer = setTimeout(() => { __toast.cur = null; __toast.subs.forEach((f) => f()); }, 5000);
}
function VoltToastHost() {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); __toast.subs.add(f); return () => __toast.subs.delete(f); }, []);
  const t = __toast.cur;
  if (!t) return null;
  const col = t.tone === "warn" ? "#f5c453" : t.tone === "error" ? "#ff4655" : "#3ddc84";
  return createPortal(
    <div role="status" aria-live="polite" key={t.id} onClick={() => { __toast.cur = null; bump((n) => n + 1); }}
      className="volt-toast" style={{ position: "fixed", left: "50%", bottom: 22, transform: "translateX(-50%)", zIndex: 450, maxWidth: "min(92vw, 460px)",
        padding: "12px 18px", background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))",
        border: `1px solid ${col}88`, clipPath: SHELL_NOTCH(9), boxShadow: "0 16px 40px rgba(0,0,0,0.55)",
        color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 14.5, fontWeight: 600, cursor: "pointer",
        animation: "voltRise .3s backwards" }}>
      <span style={{ color: col, marginRight: 8 }}>{t.tone === "ok" ? "✓" : "⚠"}</span>{t.message}
    </div>,
    document.body);
}

// Display name from a Discord sign-in (global display name first). Null for
// email accounts, whose metadata has none of these.
function discordNameOf(user) {
  const m = user?.user_metadata || {};
  return m.custom_claims?.global_name || m.full_name || (m.name ? String(m.name).replace(/#0$/, "") : null) || null;
}

// ── Resume after a round trip to Discord. Connecting Discord is a full-page
//    redirect, so whatever the player was in the middle of is gone when they
//    come back. Before leaving we note where they were; the screen that owns
//    that flow takes the note on mount and reopens it. Expires after 30 min.
const RESUME_KEY = "volt.resume";
function setResume(r) { try { localStorage.setItem(RESUME_KEY, JSON.stringify({ ...r, at: Date.now() })); } catch { /* private mode */ } }
function peekResume() {
  try {
    const r = JSON.parse(localStorage.getItem(RESUME_KEY) || "null");
    if (!r || Date.now() - r.at > 30 * 60e3) { localStorage.removeItem(RESUME_KEY); return null; }
    return r;
  } catch { return null; }
}
function takeResume(match) {
  const r = peekResume();
  if (!r || (match && !match(r))) return null;
  try { localStorage.removeItem(RESUME_KEY); } catch { /* ignore */ }
  return r;
}

function VoltDialogHost() {
  const [, bump] = useState(0);
  const [text, setText] = useState("");
  useEffect(() => { const f = () => { bump((n) => n + 1); setText(""); }; __dlg.subs.add(f); return () => __dlg.subs.delete(f); }, []);
  const d = __dlg.cur;
  if (!d) return null;
  const isPrompt = d.kind === "prompt", isAlert = d.kind === "alert";
  const cancel = () => d.resolve(isPrompt ? null : isAlert ? undefined : false);
  const matchOk = !isPrompt || !d.match || text.trim().toLowerCase() === String(d.match).trim().toLowerCase();
  const ok = () => { if (!matchOk) return; d.resolve(isPrompt ? text : isAlert ? undefined : true); };
  const accent = d.danger ? "#ff4655" : "#3d7bff";
  return (
    <VoltOverlay onClose={cancel} zIndex={400} center>
      <div role="alertdialog" aria-modal="true" aria-label={d.title || "Confirm"} onClick={(e) => e.stopPropagation()}
        style={{ width: "100%", maxWidth: 440, padding: "22px 22px 18px", fontFamily: "'Rajdhani',sans-serif",
          background: "linear-gradient(160deg, rgba(20,26,42,0.99), rgba(10,13,22,0.99))",
          border: `1px solid ${accent}77`, clipPath: SHELL_NOTCH(14), boxShadow: "0 24px 60px rgba(0,0,0,0.6)" }}>
        {d.title && (
          <div style={{ fontSize: 11.5, letterSpacing: "0.28em", textTransform: "uppercase", fontWeight: 700, color: accent, marginBottom: 10 }}>
            {d.title}
          </div>
        )}
        <div style={{ fontSize: 15, lineHeight: 1.6, color: "rgba(226,234,255,0.9)", whiteSpace: "pre-line" }}>{d.message}</div>
        {isPrompt && (
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") ok(); }}
            placeholder={d.placeholder || (d.match ? `Type ${d.match}` : "")}
            style={{ width: "100%", marginTop: 14, padding: "10px 12px", outline: "none", fontSize: 15,
              background: "rgba(10,16,30,0.9)", border: `1px solid ${accent}66`, color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif" }} />
        )}
        <div style={{ display: "flex", gap: 10, marginTop: 18, justifyContent: "flex-end", flexWrap: "wrap" }}>
          {!isAlert && (
            <button onClick={cancel} style={shellBtn("ghost", { padding: "10px 18px", fontSize: 12.5 })}>{d.cancelLabel || "Cancel"}</button>
          )}
          <button autoFocus={!isPrompt} onClick={ok} disabled={!matchOk}
            style={shellBtn(d.danger ? "danger" : "primary", { padding: "10px 20px", fontSize: 12.5, opacity: matchOk ? 1 : 0.45 })}>
            {d.confirmLabel || (isAlert ? "OK" : "Confirm")}
          </button>
        </div>
      </div>
    </VoltOverlay>
  );
}

// ── Tournament setup — create or edit a tournament's date + optional nickname.
//    Hosts often plan a tournament or two ahead, so the date is fully theirs to
//    pick rather than always defaulting to the coming Saturday.
function WeekendSetup({ mode, ev, onSave, onClose }) {
  // One range, two plain yyyy-mm-dd strings. No parallel spanDays/customEnd/iso
  // state to keep in sync, and no time component that the date columns discard.
  // A new tournament opens blank — pre-selecting "this tournament" made the modal look
  // already-answered, so a host setting up a future date had to notice and undo a
  // choice they never made. Editing still loads the tournament's real dates.
  const [startYmd, setStartYmd] = useState(ev?.starts_on || null);
  const [endYmd, setEndYmd] = useState(ev?.ends_on || null);
  const [nick, setNick] = useState(
    ev?.weekend_label && !/^(week(end)?)\s*\d+$/i.test(ev.weekend_label.trim()) ? ev.weekend_label : "");
  // Draft time lives here too, so a new tournament is set up in one go rather
  // than created and then hunted down to add the time.
  const [draftAt, setDraftAt] = useState(ev?.draft_at || null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const addDays = (v, n) => { const x = new Date(v + "T12:00:00"); x.setDate(x.getDate() + n); const p2 = (q) => String(q).padStart(2, "0"); return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`; };
  const dayGap = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
  const notSaturday = startYmd && new Date(startYmd + "T12:00:00").getDay() !== 6;
  // An open range (start picked, end not yet) falls back to the classic Sat–Sun.
  const effectiveEnd = endYmd || (startYmd ? addDays(startYmd, 1) : null);
  const days = startYmd && effectiveEnd ? dayGap(startYmd, effectiveEnd) + 1 : 0;

  // One-tap shortcuts that set the WHOLE range, so the calendar is only needed
  // for genuinely custom spans.
  const sat = comingSaturday();
  const presets = [
    { t: "This tournament", s: sat, e: addDays(sat, 1) },
    { t: "Next tournament", s: addDays(sat, 7), e: addDays(sat, 8) },
    { t: "One week", s: sat, e: addDays(sat, 6) },
    { t: "Two weeks", s: sat, e: addDays(sat, 13) },
  ];

  const label = startYmd ? weekendName({ starts_on: startYmd, ends_on: effectiveEnd, weekend_label: nick.trim() || null }) : "—";

  async function save() {
    if (!startYmd) { setErr("Pick the dates first."); return; }
    setBusy(true); setErr("");
    try { await onSave({ starts_on: startYmd, ends_on: effectiveEnd, weekend_label: nick.trim() || null, draft_at: draftAt || null }); onClose(); }
    catch (e) { setErr(e.message || "Could not save."); setBusy(false); }
  }

  return (
    <VoltOverlay onClose={onClose} zIndex={150}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 470, padding: "24px 26px 22px",
        background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)",
        clipPath: SHELL_NOTCH(16), fontFamily: "'Rajdhani',sans-serif",
        // Without a cap the panel just grows past the viewport and the Save
        // button ends up unreachable on a laptop screen.
        maxHeight: "calc(100vh - 40px)", overflowY: "auto" }}>
        <div className="flex items-center justify-between gap-3">
          <span style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>
            // {mode === "create" ? "New tournament" : "Edit tournament"}
          </span>
          <button onClick={onClose} style={{ background: "none", border: "1px solid rgba(120,150,220,0.3)", color: "rgba(200,215,255,0.6)", padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>

        <div style={{ fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", margin: "14px 0 3px" }}>{label}</div>
        <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.5)", margin: "0 0 16px" }}>Pick a shortcut, or set any start and end date on the calendar.</p>

        {/* one-tap spans */}
        <div className="flex gap-2 flex-wrap" style={{ marginBottom: 12 }}>
          {presets.map((q) => {
            const active = startYmd === q.s && effectiveEnd === q.e;
            return (
              <button key={q.t} onClick={() => { setStartYmd(q.s); setEndYmd(q.e); }}
                style={{ padding: "7px 12px", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", cursor: "pointer",
                  background: active ? "rgba(61,123,255,0.18)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${active ? "#3d7bff" : "rgba(120,150,220,0.22)"}`,
                  color: active ? "#ecf3ff" : "rgba(200,215,255,0.65)", clipPath: SHELL_NOTCH(6) }}>
                {q.t}
                <span style={{ display: "block", fontSize: 10, opacity: 0.7, letterSpacing: 0 }}>
                  {new Date(q.s + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  {q.e !== q.s ? " – " + new Date(q.e + "T12:00:00").toLocaleDateString(undefined, { day: "numeric" }) : ""}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ marginBottom: 6, fontSize: 10.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700 }}>Or set the dates</div>
        <VoltDateRange start={startYmd} end={endYmd}
          onChange={(a, b) => { setStartYmd(a); setEndYmd(b); }} placeholder="Pick start and end" />
        <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.5)", marginTop: 8 }}>
          {days > 0 ? <>Runs {days} day{days === 1 ? "" : "s"}{!endYmd && " (Sat–Sun by default)"}.</> : "Pick a start date."}
        </div>
        {notSaturday && (
          <div style={{ fontSize: 11.5, color: "#f5c453", marginTop: 6 }}>
            Heads up — that starts on a {new Date(startYmd + "T12:00:00").toLocaleDateString(undefined, { weekday: "long" })}, not a Saturday. It'll still work.
          </div>
        )}

        <div style={{ margin: "16px 0 6px", fontSize: 10.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700 }}>Nickname (optional)</div>
        <input value={nick} onChange={(e) => setNick(e.target.value)} maxLength={28} placeholder="e.g. Playoffs"
          style={{ width: "100%", padding: "10px 12px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(61,123,255,0.3)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 14, fontWeight: 600 }} />

        <div style={{ margin: "16px 0 6px", fontSize: 10.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700 }}>Draft time (optional)</div>
        <VoltDateTime value={draftAt} onChange={setDraftAt} placeholder="Set the draft time" />
        <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)", marginTop: 6 }}>
          Players see a countdown, and the bot sends the availability check and reminders off it. You can set it later.
        </div>

        {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>{err}</div>}

        <button disabled={busy || !startYmd} onClick={save}
          style={{ width: "100%", marginTop: 16, padding: "12px", fontSize: 13, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase",
            cursor: busy || !startYmd ? "not-allowed" : "pointer", opacity: busy || !startYmd ? 0.5 : 1,
            background: "rgba(61,123,255,0.18)", border: "1px solid #3d7bff", color: "#ecf3ff", clipPath: SHELL_NOTCH(12) }}>
          {busy ? "…" : mode === "create" ? "Open registration →" : "Save changes"}
        </button>
      </div>
    </VoltOverlay>
  );
}

// ── Terms gate — shown every time a player enters a tournament. Availability
//    is a per-tournament commitment, so this is deliberately not a one-time
//    account-level accept. Ticking the box is the record.
// `returning`: they've played before and have seen the full rules, so the
// commitment is one deliberate tap on a button that says exactly what they're
// agreeing to. The full version stays one tap away.
function RegisterTerms({ ev, onAccept, onClose, returning = false }) {
  const [ok, setOk] = useState(false);
  const [full, setFull] = useState(!returning);
  const line = (children) => (
    <li style={{ display: "flex", gap: 11, alignItems: "flex-start", fontSize: 14.5, lineHeight: 1.5, color: "rgba(224,233,255,0.88)" }}>
      <span style={{ color: "#5b8dff", flex: "0 0 auto", marginTop: 2 }}>▪</span><span>{children}</span>
    </li>
  );
  if (!full) return (
    <VoltOverlay onClose={onClose} zIndex={140} center>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 460, padding: "22px 24px 20px",
        background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,220,132,0.45)",
        clipPath: SHELL_NOTCH(14), fontFamily: "'Rajdhani',sans-serif" }}>
        <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#3ddc84", fontWeight: 700 }}>// {weekendName(ev)}</div>
        <div style={{ fontSize: 21, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.2, margin: "10px 0 8px" }}>
          Free <span style={{ color: "#f5c453" }}>Sat &amp; Sun, 7PM–2AM PKT</span>?
        </div>
        <p style={{ fontFamily: READ_FONT, fontSize: 14.5, lineHeight: 1.5, color: "rgba(224,233,255,0.88)", margin: "0 0 16px" }}>
          Same deal as always: drop out before the draft and it costs nothing. Unreachable after you're drafted is a strike, and two strikes means a 2-tournament suspension.
        </p>
        <button onClick={onAccept}
          style={{ width: "100%", padding: "14px", fontSize: 13.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", cursor: "pointer",
            background: "rgba(61,220,132,0.16)", border: "1px solid #3ddc84", color: "#9af5c2", clipPath: SHELL_NOTCH(12) }}>
          I'm available all weekend — sign me up</button>
        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12 }}>
          <button onClick={() => setFull(true)} style={{ background: "none", border: "none", color: "#7da6ff", fontSize: 12.5, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>See the full rules</button>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "rgba(200,215,255,0.5)", fontSize: 12.5, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>Not this time</button>
        </div>
      </div>
    </VoltOverlay>
  );
  return (
    <VoltOverlay onClose={onClose} zIndex={140} dim="rgba(4,6,12,0.72)">
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", padding: "26px 28px 24px",
        background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)",
        clipPath: SHELL_NOTCH(16), fontFamily: READ_FONT }}>
        <div className="flex items-center justify-between gap-3">
          <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 14, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9dbdff", fontWeight: 700 }}>Before you register</span>
          <button onClick={onClose} style={{ background: "none", border: "1px solid rgba(120,150,220,0.3)", color: "rgba(200,215,255,0.6)", padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>

        <h3 style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.2, margin: "16px 0 8px" }}>
          You're committing to <span style={{ color: "#f5c453" }}>Sat &amp; Sun, 7PM–2AM PKT</span>
        </h3>
        <p style={{ fontSize: 15, lineHeight: 1.55, color: "rgba(224,233,255,0.85)", margin: "0 0 18px" }}>
          Matches are scheduled anywhere inside that window and you won't know your exact times until the bracket is set. You need to be <b style={{ color: "#ecf3ff" }}>reachable for all of it</b> — if you can't be, don't register for this tournament.
        </p>

        <div style={{ padding: "18px 20px", background: "rgba(10,16,30,0.6)", border: "1px solid rgba(61,123,255,0.22)", clipPath: SHELL_NOTCH(9), marginBottom: 20 }}>
          <ul style={{ display: "grid", gap: 14, margin: 0, padding: 0, listStyle: "none" }}>
            {line(<>Captains spend real budget drafting you and build a roster around you. If you don't show, <b style={{ color: "#ecf3ff" }}>your team plays short</b>.</>)}
            {line(<>Pulling out <b style={{ color: "#9af5c2" }}>before the draft</b> costs you nothing — flip the toggle off, no strike.</>)}
            {line(<>Going unreachable <b style={{ color: "#ff8f9a" }}>after you've been drafted</b> is a strike.</>)}
            {line(<><b style={{ color: "#ff8f9a" }}>Two strikes = suspended for the next 2 tournaments.</b></>)}
            {line(<>The draft is binding — you don't pick your team or your captain, and <b style={{ color: "#ecf3ff" }}>once the teams are drafted they can't be changed</b>.</>)}
          </ul>
        </div>

        <label style={{ display: "flex", gap: 13, alignItems: "flex-start", cursor: "pointer", padding: "15px 17px",
          background: ok ? "rgba(61,220,132,0.08)" : "rgba(255,255,255,0.03)", border: `1px solid ${ok ? "rgba(61,220,132,0.5)" : "rgba(120,150,220,0.25)"}`,
          clipPath: SHELL_NOTCH(8), transition: "background .15s, border-color .15s" }}>
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)}
            style={{ width: 19, height: 19, accentColor: "#3ddc84", marginTop: 1, flex: "0 0 auto", cursor: "pointer" }} />
          <span style={{ fontSize: 14.5, fontWeight: 500, lineHeight: 1.5, color: ok ? "#ecf3ff" : "rgba(224,233,255,0.88)" }}>
            I'm available and reachable for the full window, and I understand the strike policy.
          </span>
        </label>

        <button disabled={!ok} onClick={onAccept}
          style={{ width: "100%", marginTop: 18, padding: "15px", fontFamily: "'Rajdhani',sans-serif", fontSize: 14.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase",
            cursor: ok ? "pointer" : "not-allowed", opacity: ok ? 1 : 0.4,
            background: "rgba(61,220,132,0.16)", border: "1px solid #3ddc84", color: "#9af5c2",
            clipPath: SHELL_NOTCH(12) }}>Enter this tournament →</button>
      </div>
    </VoltOverlay>
  );
}

// played tournaments and a clean record are auto-approved by the volt_apply RPC.
// Flipping off while registration runs is a clean, strike-free withdrawal.
function PlayToggle({ ev, mine, profileComplete, susp, strikes, onEditProfile, onChanged, compact }) {
  const [busy, setBusy] = useState(false);
  const [wantCap, setWantCap] = useState(false); // captain intent before the row exists
  const [note, setNote] = useState("");
  const [onboard, setOnboard] = useState(false); // first-timer welcome + profile setup
  const [onboardStart, setOnboardStart] = useState("intro");
  const [terms, setTerms] = useState(false);      // availability + strike policy gate
  const [termsQuick, setTermsQuick] = useState(false); // returning player → one-tap commitment
  const status = mine ? (mine.status || "approved") : null;
  const on = status === "pending" || status === "approved";
  // Back from connecting Discord mid-setup → reopen it at the profile step,
  // with what they'd typed restored (ScoutProfileCard keeps a draft).
  useEffect(() => {
    const r = takeResume((x) => x.kind === "onboard" && x.eventId === ev?.id);
    if (!r || on) return;
    if (r.wantCap) setWantCap(true);
    setOnboardStart("edit"); setOnboard(true);
  }, [ev?.id]); // eslint-disable-line
  const capOn = mine ? !!mine.wants_captain : wantCap;
  const rejected = status === "rejected";
  const color = status === "approved" ? "#3ddc84" : status === "pending" ? "#f5c453" : "#3ddc84";
  const draftLine = ev?.draft_at
    ? new Date(ev.draft_at).toLocaleDateString(undefined, { weekday: "short" }) + " " + new Date(ev.draft_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  async function flipPlay() {
    if (busy || susp > 0 || rejected) return;
    setNote("");
    if (!on) {
      if (!profileComplete) { setOnboardStart("intro"); setOnboard(true); return; } // first-timer → guided setup + auto-continue
      // Played before? They've read the full rules, so the commitment is one tap.
      try {
        const { count } = await __sb.from("registrations").select("id", { count: "exact", head: true })
          .eq("community_id", window.__VOLT.communityId).eq("user_id", window.__VOLT.userId).eq("status", "approved");
        setTermsQuick((count || 0) > 0);
      } catch { setTermsQuick(false); }
      setTerms(true);                                     // must accept the commitment each tournament
      return;
    } else {
      if (status === "approved" && !(await voltConfirm("Your spot opens up — captains won't be able to draft you.",
        { title: `Drop out of ${weekendName(ev)}?`, confirmLabel: "Drop out", danger: true }))) return;
      setBusy(true);
      try { const { error } = await __sb.rpc("volt_withdraw", { p_event: ev.id }); if (error) throw error; onChanged && await onChanged(); }
      catch (e) { setNote(e.message || "Could not withdraw."); }
      setBusy(false);
    }
  }
  // Runs once the player has ticked the availability/strike box.
  async function doApply() {
    setTerms(false);
    setBusy(true);
    try {
      const { data, error } = await __sb.rpc("volt_apply", { p_event: ev.id, p_wants_captain: wantCap });
      if (error) throw error;
      voltToast(data === "approved"
        ? `You're in for ${weekendName(ev)}${draftLine ? ` — draft ${draftLine}` : ""}.`
        : "Application sent — the host will review it.");
      onChanged && await onChanged();
    }
    catch (e) { setNote(e.message || "Could not apply."); }
    setBusy(false);
  }

  async function flipCap() {
    if (busy || rejected) return;
    const v = !capOn;
    if (!mine) { setWantCap(v); return; }
    setBusy(true);
    try { const { error } = await __sb.rpc("volt_wants_captain", { p_event: ev.id, p_v: v }); if (error) throw error; onChanged && await onChanged(); }
    catch (e) { console.error(e); setNote(e.message || "Could not update that."); }
    setBusy(false);
  }

  const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14 };
  const label = { fontSize: compact ? 13 : 14.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" };
  return (
    <div style={{ display: "grid", gap: compact ? 8 : 10, minWidth: compact ? 220 : 260 }}>
      <div style={row}>
        <span style={{ ...label, color: on ? (status === "approved" ? "#9af5c2" : "#f5c453") : "#ecf3ff" }}>I'm playing this tournament</span>
        <ToggleSwitch on={on} color={color} disabled={busy || susp > 0 || rejected} onClick={flipPlay} />
      </div>
      <div style={{ fontFamily: READ_FONT, fontSize: 13, lineHeight: 1.45, color: "rgba(214,226,255,0.74)", marginTop: -4 }}>
        {susp > 0 ? <span style={{ color: "#ff8f9a", fontWeight: 700 }}>Suspended — {susp} tournament{susp === 1 ? "" : "s"} remaining. You can't enter yet.</span>
          : rejected ? <span style={{ color: "#ff8f9a" }}>Not approved this tournament — talk to the host.</span>
          : status === "approved" ? <span style={{ color: "#9af5c2" }}>You're in ✓{draftLine ? ` — draft ${draftLine}` : ""} · flip off to drop out</span>
          : status === "pending" ? <span style={{ color: "#f5c453" }}>Application pending — the host reviews it · flip off to withdraw</span>
          : <>One tap enters you in the pool — it confirms you're available for the draft{draftLine ? ` (${draftLine})` : ""} and up to 4 matches. No-shows hurt your team.</>}
      </div>
      {strikes > 0 && !on && susp === 0 && (
        // The rule lives in fn_no_show_penalty: every 2nd strike (2, 4, 6…)
        // sets a 2-tournament suspension. So the warning fires on odd counts —
        // you're one strike away whenever you're sitting on 1, 3, 5…
        <div style={{ fontFamily: READ_FONT, fontSize: 13, lineHeight: 1.4, color: strikes % 2 === 1 ? "#ff8f9a" : "#f5c453", fontWeight: 500 }}>
          ⚠ {strikes} no-show{strikes === 1 ? "" : "s"} on record{strikes % 2 === 1 ? " — one more triggers a 2-tournament suspension" : ""}</div>
      )}
      {!rejected && susp === 0 && (
        <div style={row}>
          <span style={{ ...label, fontSize: compact ? 12 : 13, color: capOn ? "#7da6ff" : "rgba(200,215,255,0.6)" }}>I'll captain <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "rgba(200,215,255,0.4)" }}>(the host decides)</span></span>
          <ToggleSwitch on={capOn} color="#3d7bff" disabled={busy} onClick={flipCap} />
        </div>
      )}
      {note && <div style={{ fontFamily: READ_FONT, fontSize: 13, lineHeight: 1.4, color: "#f5c453" }}>{note}</div>}
      {onboard && <FirstTimeOnboard ev={ev} wantCap={wantCap} startPhase={onboardStart} onClose={() => setOnboard(false)} onApplied={onChanged} />}
      {terms && <RegisterTerms ev={ev} returning={termsQuick} onAccept={doApply} onClose={() => setTerms(false)} />}
    </div>
  );
}

// Tell someone their role changed; the hub greets them with what it means.
async function notifyRole(userId, role) {
  await voltNotify([{ community_id: window.__VOLT.communityId, user_id: userId, kind: "role",
    title: role === "host" ? "◆ You're now a host" : "◆ You're now a moderator",
    body: role === "host" ? "Full control of the league — open VOLT to see what's new."
                          : "You can approve players, pick captains and report scores. Open VOLT for a quick tour." }]);
}

// Batch notification insert — fire-and-forget, host-side actions only.
async function voltNotify(rows) {
  try { if (HAS_SUPABASE && rows && rows.length) await __sb.from("notifications").insert(rows); }
  catch (e) { console.error("notify", e); }
}

const NOTIF_GLYPH = { role: "◆", approved: "✓", rejected: "✕", captain: "★", settled: "🏆", weekend_open: "▸", suspension: "⚠", new_application: "◈", sub_request: "⇄", sub_in: "✓", sub_filled: "⇄" };
const NOTIF_COLOR = { role: "#f5c453", approved: "#3ddc84", rejected: "#ff4655", captain: "#f5c453", settled: "#f5c453", weekend_open: "#3ddc84", suspension: "#ff4655", new_application: "#f5c453", sub_request: "#f5c453", sub_in: "#3ddc84", sub_filled: "#7da6ff" };

function NotifBell() {
  const narrow = useNarrow(640);   // phones: the panel spans the screen instead of hanging off the bell
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  async function pull() {
    try {
      const { data } = await __sb.from("notifications").select("*").eq("user_id", window.__VOLT.userId).eq("community_id", window.__VOLT.communityId).order("created_at", { ascending: false }).limit(15);
      setRows(data || []);
    } catch (e) { console.error(e); }
  }
  useEffect(() => { pull(); const stop = visInterval(pull, 20000); return () => stop(); }, []);
  const unread = rows.filter(r => !r.read).length;
  async function openPanel() {
    const v = !open; setOpen(v);
    if (v && unread) {
      try { await __sb.from("notifications").update({ read: true }).eq("user_id", window.__VOLT.userId).eq("community_id", window.__VOLT.communityId).eq("read", false); } catch (e) {}
      setRows(rs => rs.map(r => ({ ...r, read: true })));
    }
  }
  const ago = (d) => {
    const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
    if (s < 60) return s + "s"; if (s < 3600) return Math.floor(s / 60) + "m";
    if (s < 86400) return Math.floor(s / 3600) + "h"; return Math.floor(s / 86400) + "d";
  };
  return (
    <div style={{ position: "relative" }}>
      {unread > 0 && (
        <span style={{ position: "absolute", top: -5, right: -5, zIndex: 2, minWidth: 17, height: 17, padding: "0 4px",
          display: "grid", placeItems: "center", background: "#f5c453", color: "#0a0d18", fontSize: 10, fontWeight: 700,
          borderRadius: 9, fontFamily: "'IBM Plex Mono',monospace", pointerEvents: "none",
          boxShadow: "0 0 0 2px #0a0d18" }}>{unread}</span>
      )}
      <button onClick={openPanel} title="Notifications" style={shellBtn("ghost", { width: 36, height: 36, padding: 0, display: "grid", placeItems: "center", fontSize: 14, position: "relative" })}>
        <Icon name="bell" size={18} />
      </button>
      {open && (
        <div style={{ ...(narrow ? { position: "fixed", left: 8, right: 8, top: 66, maxHeight: "calc(100dvh - 160px)" } : { position: "absolute", right: 0, top: "calc(100% + 8px)", width: 320, maxHeight: 400 }), overflowY: "auto", zIndex: 130, background: "linear-gradient(160deg,rgba(20,26,42,0.98),rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.4)", clipPath: SHELL_NOTCH(10), padding: "12px 14px", boxShadow: "0 20px 50px rgba(0,0,0,0.6)" }}>
          <div style={{ fontSize: 10, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 8 }}>// Notifications</div>
          {rows.length === 0 && <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.45)", margin: 0 }}>Nothing yet — league news lands here.</p>}
          <div style={{ display: "grid", gap: 6 }}>
            {rows.map(r => (
              <div key={r.id} style={{ display: "flex", gap: 10, padding: "9px 10px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(120,150,220,0.14)", clipPath: SHELL_NOTCH(6) }}>
                <span style={{ color: NOTIF_COLOR[r.kind] || "#5b8dff", fontWeight: 700, fontSize: 13, width: 16, textAlign: "center" }}>{NOTIF_GLYPH[r.kind] || "▪"}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "#ecf3ff" }}>{r.title}</div>
                  {r.body && <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.55)", marginTop: 2 }}>{r.body}</div>}
                </div>
                <span style={{ fontSize: 10, color: "rgba(200,215,255,0.35)", fontFamily: "'IBM Plex Mono',monospace", flex: "0 0 auto" }}>{ago(r.created_at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Public player profile — the Season Race makes individuals the product;
// this is their page. Opened from leaderboard rows; My Account stays the
// private edit surface behind it.
// Contact card. The Discord handle lives on player_profiles and is readable by
// anyone in the league, so a captain can chase their own draftee without going
// through the host. The number lives in player_contacts behind a host-only RLS
// policy and is passed in as null for everyone else — it never reaches the
// client, so there is nothing here to reveal by accident.
function ContactPanel({ discord, whatsapp, name }) {
  const [showWa, setShowWa] = useState(false);
  const [copied, setCopied] = useState("");
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (text, which) => {
    if (!text) return;
    let ok = false;
    try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); ok = true; } } catch { /* fall through */ }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select();
        ok = document.execCommand("copy"); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    if (!ok) return;
    setCopied(which); clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(""), 1600);
  };
  const btn = (label, onClick, tone) => (
    <button onClick={onClick} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer",
      fontFamily: "'Rajdhani',sans-serif", clipPath: SHELL_NOTCH(6),
      background: tone === "ok" ? "rgba(61,220,132,0.14)" : "rgba(61,123,255,0.1)",
      border: `1px solid ${tone === "ok" ? "rgba(61,220,132,0.5)" : "rgba(61,123,255,0.35)"}`,
      color: tone === "ok" ? "#9af5c2" : "#7da6ff" }}>{label}</button>
  );
  const row = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 10 }}>// Contact</div>
      <div style={{ padding: "16px 18px", background: "rgba(10,16,30,0.5)", border: "1px solid rgba(120,150,220,0.18)", clipPath: SHELL_NOTCH(9), display: "flex", flexDirection: "column", gap: 12 }}>
        {discord ? (
          <div style={row}>
            <span style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", width: 62 }}>Discord</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#ecf3ff" }}>{discord}</span>
            {btn(copied === "d" ? <><CheckIcon size={11} />Copied</> : <><CopyIcon size={11} />Copy</>, () => copy(discord, "d"), copied === "d" ? "ok" : null)}
          </div>
        ) : (
          <div style={{ fontSize: 12, color: "rgba(200,215,255,0.45)" }}>Discord not connected.</div>
        )}

        {whatsapp && (showWa ? (
          <div style={{ ...row, paddingTop: 12, borderTop: "1px solid rgba(120,150,220,0.15)" }}>
            <span style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(245,196,83,0.7)", width: 62 }}>WhatsApp</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#ecf3ff" }}>+{whatsapp}</span>
            {btn(copied === "w" ? <><CheckIcon size={11} />Copied</> : <><CopyIcon size={11} />Copy</>, () => copy(whatsapp, "w"), copied === "w" ? "ok" : null)}
            <a href={`https://wa.me/${whatsapp}`} target="_blank" rel="noopener noreferrer"
              style={{ padding: "5px 10px", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", textDecoration: "none",
                fontFamily: "'Rajdhani',sans-serif", clipPath: SHELL_NOTCH(6), background: "rgba(61,220,132,0.12)", border: "1px solid rgba(61,220,132,0.45)", color: "#9af5c2" }}>Open chat →</a>
          </div>
        ) : (
          <div style={{ paddingTop: 12, borderTop: "1px solid rgba(120,150,220,0.15)" }}>
            <button onClick={() => setShowWa(true)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left",
              fontFamily: "'Rajdhani',sans-serif", fontSize: 12, fontWeight: 700, color: "#f5c453", letterSpacing: "0.04em" }}>
              ⚠ No reply on Discord? Reveal WhatsApp number →
            </button>
            <div style={{ fontSize: 11, color: "rgba(200,215,255,0.4)", marginTop: 4 }}>Host only — {name} shared this as a backup.</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Owner-only: appoint a helper. A moderator runs the operational side of a
// tournament — approvals, captains, brackets, scores — but cannot settle or delete
// a tournament, reset the auction, run the live draft, or change anyone's role.
// That last one is the important bit: a moderator can't promote themselves or
// demote the owner, because users_host_update stays gated on auth_is_host().
function ModeratorToggle({ userId, role, name, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const isMod = role === "moderator";
  async function flip() {
    const next = isMod ? "player" : "moderator";
    if (!(await voltConfirm(isMod
      ? "They'll go back to being a player."
      : "They'll be able to approve players, assign captains, build brackets and report scores — but not settle or delete tournaments, run the live auction, or change roles.",
      { title: isMod ? `Remove ${name} as moderator?` : `Make ${name} a moderator?`, confirmLabel: isMod ? "Remove" : "Make moderator", danger: isMod }))) return;
    setBusy(true); setErr("");
    try {
      const { error } = await __sb.from("users").update({ role: next }).eq("id", userId);
      if (error) throw error;
      if (next === "moderator") await notifyRole(userId, "moderator");
      onChanged && onChanged();
    } catch (e) { setErr(e.message || "Could not change that."); }
    setBusy(false);
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 10 }}>// Staff</div>
      <div style={{ padding: "16px 18px", background: "rgba(10,16,30,0.5)", border: `1px solid ${isMod ? "rgba(61,220,132,0.3)" : "rgba(120,150,220,0.18)"}`, clipPath: SHELL_NOTCH(9), display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: isMod ? "#9af5c2" : "rgba(200,215,255,0.7)" }}>
            {isMod ? "Moderator" : "Player"}
          </div>
          <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)", marginTop: 3 }}>
            {isMod
              ? "Can run approvals, captains, brackets and scores. Can't settle or delete a tournament, run the auction, or change roles."
              : "Promote to share the organising work for each tournament."}
          </div>
        </div>
        <button disabled={busy} onClick={flip}
          style={shellBtn(isMod ? "danger" : "accent", { padding: "9px 16px", fontSize: 11.5, opacity: busy ? 0.5 : 1 })}>
          {busy ? "…" : isMod ? "Remove moderator" : "Make moderator"}
        </button>
        {err && <span style={{ fontSize: 11.5, color: "#ff8f9a", width: "100%" }}>⚠ {err}</span>}
      </div>
    </div>
  );
}

function PlayerProfile({ userId, onBack, footer, lead }) {
  const [d, setD] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const cid = window.__VOLT.communityId;
        const [{ data: u }, { data: p }, { data: mrs }, { data: evs }, { data: strikes }] = await Promise.all([
          __sb.from("users").select("display_name, role, trophy_streak, best_streak, weekends_won, brackets_won, suspension_remaining").eq("id", userId).maybeSingle(),
          __sb.from("player_profiles").select("*").eq("user_id", userId).maybeSingle(),
          __sb.from("match_results").select("event_id, points_computed, team_won, stat_payload, created_at").eq("community_id", cid).eq("user_id", userId).order("created_at", { ascending: true }),
          __sb.from("events").select("id, weekend_label, starts_on, ends_on, created_at, recap").eq("community_id", cid),
          __sb.from("registrations").select("id, event_id, no_show").eq("community_id", cid).eq("user_id", userId).eq("no_show", true),
        ]);
        // RLS decides this, not the client: the row only comes back for the
        // player themselves or a host of this community. Everyone else gets
        // nothing, so there's no contact data on the wire to leak.
        let contact = null;
        try {
          const { data: c } = await __sb.from("player_contacts").select("whatsapp")
            .eq("user_id", userId).eq("community_id", cid).maybeSingle();
          contact = c || null;
        } catch (e) { console.error("contacts", e); }
        if (!u) console.error("player file: users row did not load for", userId,
          "— name, trophies, wins and suspension will all show as defaults.");
        setD({ u: u || {}, p: p || {}, mrs: mrs || [], evs: evs || [], strikes: strikes || [], contact });
      } catch (e) { console.error(e); setD({ u: {}, p: {}, mrs: [], evs: [], strikes: [], contact: null }); }
    })();
  }, [userId]);

  if (!d) return <div style={{ maxWidth: 980, margin: "0 auto", padding: "60px 22px" }}><p className="vg-loading">// Pulling the file…</p></div>;

  const { u, p, mrs, evs, strikes = [], contact = null } = d;
  const isHostViewer = window.__VOLT?.isHost;                 // league owner only
  const isStaffViewer = window.__VOLT?.isStaff ?? window.__VOLT?.isHost; // + moderators
  const rank = p.rank || "Iron";
  const rankDiv = p.rank_div ?? null;
  const r = RANKS[rank] || RANKS.Iron;
  const hue = r.c;
  const name = u.display_name || "Player";

  // Season aggregates from banked match results.
  const pts = mrs.reduce((a, x) => a + Number(x.points_computed || 0), 0);
  const wins = mrs.filter(x => x.team_won).length;
  const perfRows = mrs.map(x => perfOf(x.stat_payload)).filter(Boolean);
  const avgPerf = perfRows.length ? Math.round(perfRows.reduce((a, b) => a + b, 0) / perfRows.length) : null;
  const winRate = mrs.length ? Math.round(wins / mrs.length * 100) : null;
  const evMap = {}; evs.forEach(e => { evMap[e.id] = e; });
  const champEvents = evs.filter(e => Array.isArray(e.recap?.ids) && e.recap.ids.includes(userId));
  const byWeekend = {};
  mrs.forEach(x => { const w = (byWeekend[x.event_id] = byWeekend[x.event_id] || { pts: 0, m: 0, w: 0 }); w.pts += Number(x.points_computed || 0); w.m++; if (x.team_won) w.w++; });
  const weekendRows = Object.entries(byWeekend).sort((a, b) => new Date(evMap[a[0]]?.created_at || 0) - new Date(evMap[b[0]]?.created_at || 0));

  // Radar wants raw kda/acs/hs/win/rank — feed the scouting-profile numbers.
  // rankDiv included so the radar's RANK readout says "Gold 2", not "Gold".
  const radarPlayer = { kda: Number(p.kda) || 0, acs: Number(p.acs) || 0, hs: Number(p.hs) || 0, win: Number(p.win) || 0, rank, rankDiv };
  const hasScout = p.kda != null || p.acs != null || p.hs != null || p.rank;

  const NOTCH = "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))";
  // Every primary value renders at one fixed size/weight; a null shows a muted
  // dash that occupies the same box, so a row of tiles reads as one scale.
  const bigTile = (label, val, c, sub) => {
    const empty = val == null || val === "—" || val === "";
    return (
      <div style={{ padding: "15px 14px", minHeight: 96, display: "flex", flexDirection: "column", justifyContent: "center", background: "rgba(10,16,30,0.72)", border: `1px solid ${(c || "#3d7bff")}${empty ? "22" : "44"}`, clipPath: SHELL_NOTCH(9), textAlign: "center", position: "relative", overflow: "hidden" }}>
        {!empty && <div style={{ position: "absolute", inset: 0, background: `radial-gradient(120% 90% at 50% 0%, ${(c || "#3d7bff")}14, transparent 70%)`, pointerEvents: "none" }} />}
        <div style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.55)", fontWeight: 700, position: "relative" }}>{label}</div>
        <div style={{ fontSize: 30, fontWeight: 700, color: empty ? "rgba(200,215,255,0.28)" : (c || "#ecf3ff"), fontFamily: "'IBM Plex Mono',monospace", marginTop: 6, lineHeight: 1, position: "relative", textShadow: empty ? "none" : `0 0 16px ${(c || "#3d7bff")}55` }}>{empty ? "—" : val}</div>
        <div style={{ fontSize: 10, color: "rgba(200,215,255,0.4)", marginTop: 5, position: "relative", minHeight: 12 }}>{sub || ""}</div>
      </div>
    );
  };
  const sec = (t) => <div style={{ fontSize: 11, letterSpacing: "0.26em", textTransform: "uppercase", color: hue, fontWeight: 700, margin: "28px 0 12px", opacity: 0.85 }}>// {t}</div>;

  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "24px 20px 70px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// {onBack ? "Player file" : "My Account"}</span>
        {onBack && <button onClick={onBack} style={shellBtn("ghost", { padding: "8px 16px", fontSize: 12 })}>‹ Back</button>}
      </div>
      {/* Anything the page wants first — for a brand-new account, the setup. */}
      {typeof lead === "function" ? lead({ empty: !hasScout }) : lead}

      {/* HERO — two equal panels, identity + radar, matched heights */}
      <style>{`@media (max-width: 720px){ .volt-hero-grid{ grid-template-columns: 1fr !important; } }`}</style>
      <div className="volt-hero-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, alignItems: "stretch" }}>
        <div style={{ position: "relative", clipPath: NOTCH, padding: 14, overflow: "hidden", minHeight: 300, display: "flex", flexDirection: "column", gap: 12,
          background: "linear-gradient(160deg, rgba(20,26,42,0.92), rgba(10,13,22,0.92))", border: `1px solid ${hue}66`, boxShadow: "0 0 0 1px rgba(255,255,255,0.04) inset" }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 4px)" }} />

          {/* identity panel — contained gradient, watermark lives INSIDE it (no bleed) */}
          <div style={{ position: "relative", overflow: "hidden", borderRadius: 14, padding: "22px 22px 18px", border: "1px solid rgba(255,255,255,0.08)",
            background: `linear-gradient(120deg, ${hue}3a, ${hue}18 55%, rgba(10,13,22,0.35))` }}>
            <span style={{ position: "absolute", right: -8, top: -22, fontSize: 128, fontWeight: 800, lineHeight: 1, letterSpacing: "-0.04em", color: "rgba(255,255,255,0.07)", fontFamily: "'Rajdhani',sans-serif", pointerEvents: "none", userSelect: "none" }}>{avgPerf || p.acs || ""}</span>
            {(avgPerf || p.acs) ? <span style={{ position: "absolute", right: 16, top: 96, fontSize: 10, letterSpacing: 3, fontWeight: 700, color: "rgba(255,255,255,0.16)", fontFamily: "'Rajdhani',sans-serif" }}>{avgPerf ? "PERF" : "ACS"}</span> : null}
            <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 16 }}>
              <RankCrest rank={rank} div={rankDiv} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 34, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.03, display: "flex", alignItems: "center", flexWrap: "wrap", textShadow: `0 0 24px ${r.glow}` }}>{name}<TrophyChip n={u.trophy_streak} big /></div>
                <div style={{ display: "flex", gap: 9, marginTop: 8, fontSize: 12.5, flexWrap: "wrap", alignItems: "center" }}>
                  {/* Labelled outright. With two ranks on one line, an unlabelled
                      pair is guesswork — and only the current one sets the bid. */}
                  <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }} title="Current rank — this is what sets the opening bid">
                    <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>NOW</span>
                    <span style={{ color: hue, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", textShadow: `0 0 10px ${r.glow}` }}>{rankLabel(rank, rankDiv)}</span>
                  </span>
                  {p.peak_rank && (
                    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }} title="Highest rank ever reached. Does not affect the opening bid.">
                      <span style={{ fontSize: 10, letterSpacing: "0.18em", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>PEAK</span>
                      <span style={{ color: rankOf(p.peak_rank).c, opacity: 0.8, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em" }}>{rankLabel(p.peak_rank, p.peak_rank_div)}</span>
                    </span>
                  )}
                </div>
                {/* Role, agent and the tracker link share one row: they're all
                    "who this player is", and the button on its own line left a
                    ragged column of three short rows. */}
                <div style={{ display: "flex", gap: 10, marginTop: 9, fontSize: 12.5, flexWrap: "wrap", alignItems: "center" }}>
                  {p.role && <span style={{ color: "rgba(236,243,255,0.75)", textTransform: "uppercase", letterSpacing: "0.06em" }}>{ROLE_GLYPH[p.role] || "▪"} {p.role}</span>}
                  {p.agent && <span style={{ color: "rgba(200,215,255,0.55)", textTransform: "capitalize" }}>{p.agent}</span>}
                  {p.tracker_url
                    ? <a href={p.tracker_url} target="_blank" rel="noopener noreferrer"
                        style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", fontSize: 10.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#7deaff", background: "rgba(0,229,255,0.1)", border: "1px solid rgba(0,229,255,0.5)", borderRadius: 6, textDecoration: "none", whiteSpace: "nowrap" }}>⌖ View tracker ↗</a>
                    : !onBack && <span style={{ fontSize: 11, color: "rgba(200,215,255,0.4)" }}>No tracker link — add one in your scouting profile below.</span>}
                </div>
              </div>
            </div>
          </div>

          {/* season strip — three summary cells, value-first like the card's Stat boxes */}
          <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8 }}>
            {[["Season pts", String(pts), "#f5c453"], ["Win rate", winRate != null ? winRate + "%" : "—", "#3ddc84"], ["Trophies", "×" + (u.trophy_streak || 0), "#f5c453"]].map(([lb, v, c], i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "12px 6px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: c, fontFamily: "'Rajdhani',sans-serif", textShadow: `0 0 14px ${c}66` }}>{v}</span>
                <span style={{ fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(236,243,255,0.5)", fontWeight: 600 }}>{lb}</span>
              </div>
            ))}
          </div>

          {/* scouting stats — value-first, exactly the card's Stat treatment */}
          {hasScout ? (
            <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: "auto" }}>
              {[["KDA", p.kda != null ? p.kda : null, "#00e5ff"], ["Tracker ACS", p.acs != null ? p.acs : null, "#ff4655"], ["HS %", p.hs != null ? p.hs + "%" : null, "#9d6bff"], ["WIN %", p.win != null ? p.win + "%" : null, "#3ddc84"]].map(([lb, v, c], i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "12px 4px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                  <span style={{ fontSize: 21, fontWeight: 700, lineHeight: 1, color: v == null ? "rgba(200,215,255,0.3)" : c, fontFamily: "'Rajdhani',sans-serif", textShadow: v == null ? "none" : `0 0 14px ${c}66` }}>{v == null ? "—" : v}</span>
                  <span style={{ fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(236,243,255,0.5)", fontWeight: 600 }}>{lb}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ position: "relative", fontSize: 12, color: "rgba(200,215,255,0.4)", marginTop: "auto" }}>No scouting profile set yet.</div>
          )}
        </div>

        {/* RADAR panel — matched min-height */}
        <div style={{ clipPath: NOTCH, padding: "18px 18px 14px", minHeight: 300, background: "linear-gradient(160deg, rgba(18,24,40,0.85), rgba(10,13,22,0.92))", border: "1px solid rgba(61,123,255,0.28)", display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 10.5, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(200,215,255,0.6)", fontWeight: 700 }}>Performance profile</div>
          <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
            {hasScout
              ? <StatRadar player={radarPlayer} size={300} hue={hue} />
              : <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.4)", textAlign: "center", padding: "40px 10px" }}>No scouting profile yet — the radar fills in once stats are set.</p>}
          </div>
        </div>
      </div>

      {sec("This season")}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 12 }} className="volt-statgrid">
        {bigTile("Season pts", pts, "#f5c453")}
        {bigTile("Matches", mrs.length, "#5b8dff")}
        {bigTile("Wins", wins, "#3ddc84", winRate != null ? winRate + "% win rate" : null)}
        {bigTile("Tournaments won", u.weekends_won || 0, "#f5c453")}
        {bigTile("Avg performance", avgPerf, "#ff4655")}
      </div>
      <style>{`@media (max-width: 720px){ .volt-statgrid{ grid-template-columns: repeat(2, minmax(0,1fr)) !important; } } @media (min-width:721px) and (max-width:980px){ .volt-statgrid{ grid-template-columns: repeat(3, minmax(0,1fr)) !important; } }`}</style>


      {weekendRows.length > 0 && <>
        {sec("Tournament by tournament")}
        <div style={{ display: "grid", gap: 7 }}>
          {weekendRows.map(([eid, w]) => {
            const won = champEvents.some(e => e.id === eid);
            return (
              <div key={eid} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: won ? "rgba(245,196,83,0.07)" : "rgba(255,255,255,0.03)", border: `1px solid ${won ? "rgba(245,196,83,0.35)" : "rgba(120,150,220,0.14)"}`, clipPath: SHELL_NOTCH(8) }}>
                <span style={{ flex: 1, fontWeight: 700, textTransform: "uppercase", fontSize: 13.5 }}>{weekendName(evMap[eid]) || "Tournament"}
                  {won && <span style={{ color: "#f5c453", marginLeft: 8, fontSize: 12, display: "inline-flex", alignItems: "center", gap: 4 }}><Icon name="trophy" size={13} />champion</span>}</span>
                <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)", fontFamily: "'IBM Plex Mono',monospace" }}>{w.m} matches · {w.w}W</span>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: "#ecf3ff", width: 68, textAlign: "right" }}>{w.pts} pts</span>
              </div>
            );
          })}
        </div>
      </>}
      {mrs.length === 0 && <p style={{ fontSize: 13, color: "rgba(200,215,255,0.4)", marginTop: 28 }}>No matches played yet — the record starts the first tournament they take the server.</p>}

      {(p?.discord || (isStaffViewer && contact?.whatsapp)) && <ContactPanel discord={p?.discord} whatsapp={isStaffViewer ? contact?.whatsapp : null} name={u.display_name || "this player"} />}
      {/* ── Attendance & strikes. Hosts can discount a strike (keeps the record,
             stops it counting) — the escape valve for genuine emergencies. ── */}
      {isHostViewer && u.role !== "host" && <ModeratorToggle userId={userId} role={u.role} name={u.display_name || "this player"} onChanged={() => setD(null)} />}
      {(isStaffViewer || strikes.length > 0) && (
        <>
          {sec("Attendance")}
          <div style={{ padding: "16px 18px", background: "rgba(10,16,30,0.5)", border: `1px solid ${strikes.length >= 2 ? "rgba(255,70,85,0.35)" : "rgba(120,150,220,0.18)"}`, clipPath: SHELL_NOTCH(9) }}>
            <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginBottom: strikes.length ? 12 : 0 }}>
              <span style={{ fontSize: 13.5, fontWeight: 700, color: strikes.length ? "#f5c453" : "#9af5c2" }}>
                {strikes.length === 0 ? "✓ Clean record — no strikes" : `⚠ ${strikes.length} strike${strikes.length === 1 ? "" : "s"}`}
              </span>
              {(u.suspension_remaining || 0) > 0 && (
                <span style={{ fontSize: 12, fontWeight: 700, color: "#ff8f9a", border: "1px solid rgba(255,70,85,0.45)", padding: "4px 10px", clipPath: SHELL_NOTCH(5) }}>
                  Suspended · {u.suspension_remaining} tournament{u.suspension_remaining === 1 ? "" : "s"} left
                </span>
              )}
            </div>
            {strikes.length > 0 && (
              <div style={{ display: "grid", gap: 7 }}>
                {strikes.map((s) => {
                  const ev = evs.find((e) => e.id === s.event_id);
                  return (
                    <div key={s.id} className="flex items-center justify-between gap-3 flex-wrap"
                      style={{ padding: "9px 12px", background: "rgba(255,70,85,0.05)", border: "1px solid rgba(255,70,85,0.2)" }}>
                      <span style={{ fontSize: 12.5, color: "rgba(220,231,255,0.8)" }}>
                        No-show · <b style={{ color: "#ecf3ff" }}>{ev ? weekendName(ev) : "a past tournament"}</b>
                      </span>
                      {isStaffViewer && (
                        <button onClick={async () => {
                            if (!(await voltConfirm("It stops counting toward a suspension and lifts any active ban.",
                              { title: "Discount this strike?", confirmLabel: "Discount strike" }))) return;
                            try { await __sb.from("registrations").update({ no_show: false }).eq("id", s.id); setD(null); }
                            catch (e) { console.error(e); }
                          }}
                          style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", padding: "5px 11px", cursor: "pointer",
                            background: "rgba(61,220,132,0.08)", border: "1px solid rgba(61,220,132,0.4)", color: "#9af5c2", clipPath: SHELL_NOTCH(5) }}>
                          ↺ Discount
                        </button>
                      )}
                    </div>
                  );
                })}
                {isStaffViewer && (
                  <p style={{ fontSize: 11.5, color: "rgba(200,215,255,0.4)", marginTop: 2 }}>
                    Two strikes suspends a player for the next 2 tournaments. Discounting one lifts an active suspension.
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {typeof footer === "function" ? footer({ empty: !hasScout }) : footer}
    </div>
  );
}

// Pages worth showing for a tournament in each phase. Anything that has
// nothing to show yet is left out rather than greyed out.
const RAIL_PHASE_VIEWS = {
  registration_open:   ["lobby", "scout", "warroom", "leaderboard"],
  registration_closed: ["lobby", "scout", "warroom", "leaderboard"],
  drafting:            ["lobby", "block", "scout", "reserve", "locker", "warroom"],
  matches_live:        ["lobby", "bracket", "locker", "reserve", "leaderboard", "veto"],
  settled:             ["lobby", "bracket", "locker", "leaderboard"],
};
function HubRail({ community, target, onEnter, onAccount, isHost, wide, setWide, hasTournaments, onCreate, page, onPage, showStaff }) {
  const [tip, setTip] = useState(null);
  const [soundOn, setSoundOn] = useState(() => { try { return localStorage.getItem("volt_sound") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("volt_sound", soundOn ? "1" : "0"); } catch {} }, [soundOn]);
  const W = wide ? 224 : 60;
  const enterable = !!target;
  const finished = target?.phase === "settled";

  const item = (glyph, label, { onClick, disabled, accent, liveDot, active } = {}) => (
    <button key={label} disabled={disabled} onClick={disabled ? undefined : onClick} aria-current={active ? "page" : undefined}
      className={"volt-rail-item flex items-center" + (active ? " is-active" : "")}
      onMouseEnter={e => { if (!wide) setTip({ label: disabled ? label + " — enter a live tournament first" : label, y: e.currentTarget.getBoundingClientRect().top + 21 }); }}
      onMouseLeave={() => setTip(null)}
      style={{ width: wide ? W - 16 : 44, height: 42, justifyContent: wide ? "flex-start" : "center", gap: 10, paddingLeft: wide ? 12 : 0, paddingRight: wide ? 10 : 0, background: "none", border: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.32 : 1, color: active ? "#eaf1ff" : (accent || "rgba(200,215,255,0.72)"), position: "relative", margin: wide ? 0 : "0 auto",
        ...(active ? { background: "linear-gradient(90deg, rgba(61,123,255,0.2), rgba(61,123,255,0.04))", boxShadow: "inset 2px 0 0 #3d7bff" } : null) }}>
      <span className="volt-rail-glyph" style={{ fontSize: 16, transition: "color .12s", position: "relative", display: "inline-flex" }}>{glyphNode(glyph, 19)}
        {liveDot && <span style={{ position: "absolute", top: -2, right: -4, width: 6, height: 6, borderRadius: "50%", background: "#af9aec", boxShadow: "0 0 6px #af9aec" }} />}</span>
      {wide && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>}
    </button>
  );
  const divider = (mt = 8, mb = 8) => <div style={{ width: wide ? "auto" : 26, height: 1, margin: wide ? `${mt}px 6px ${mb}px` : `${mt}px auto ${mb}px`, background: "rgba(120,150,220,0.2)" }} />;
  const secLabel = (t) => wide && <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700, padding: "2px 12px 6px" }}>// {t}</div>;

  const go = (view) => enterable && onEnter(target, view);
  // The league's own pages.
  const pg = (glyph, label, key) => item(glyph, label, { onClick: () => onPage(key), active: page === key });
  const leagueViews = [
    pg("overview", "Overview", "overview"),
    pg("season", "Season race", "season"),
    hasTournaments && pg("history", "Tournaments", "tournaments"),
    isHost && pg("discord", "Discord", "discord"),
    showStaff && pg("settings", "Staff", "staff"),
  ].filter(Boolean);
  const byId = Object.fromEntries([...NAV, ...TOURNEY_NAV].map(n => [n.id, n]));
  const tourneyViews = enterable ? (RAIL_PHASE_VIEWS[target.phase] || []).map(id => byId[id])
    .filter(n => n && (!n.adminOnly || isHost))
    .map(n => item(n.glyph, n.label, { onClick: () => go(n.id), liveDot: n.id === "block" && target.phase === "drafting" })) : [];
  const tLabel = enterable ? (finished ? "Last tournament" : weekendName(target)) : null;

  return (
    <nav aria-label="League" style={{ position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 40, width: W, display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", padding: wide ? "12px 8px 14px" : "12px 0 14px", background: "linear-gradient(180deg, rgba(12,17,30,0.98), rgba(7,10,18,0.98))", borderRight: "1px solid rgba(61,123,255,0.22)", fontFamily: "'Rajdhani',sans-serif", transition: "width .18s cubic-bezier(.2,.8,.3,1)", overflowY: "auto", overflowX: "hidden" }}>
      <style>{`.volt-rail-item:hover .volt-rail-glyph { color: #eaf1ff !important; } @keyframes voltTipIn { from { opacity: 0; transform: translateY(-50%) translateX(-8px); } to { opacity: 1; transform: translateY(-50%) translateX(0); } }`}</style>
      {/* league mark + collapse toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: wide ? "space-between" : "center", gap: 8, marginBottom: 4, paddingLeft: wide ? 4 : 0 }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <LeagueLockup name={community?.name || window.__VOLT.communityName || "VOLT"} wide={wide} />
          {wide && <LeagueSwitch />}
        </div>
        {wide && <button onClick={() => setWide(false)} aria-label="Collapse" title="Collapse" style={{ width: 26, height: 26, display: "grid", placeItems: "center", color: "rgba(200,215,255,0.55)", border: "1px solid rgba(120,150,220,0.25)", background: "rgba(255,255,255,0.03)", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))", fontSize: 12 }}><Icon name="collapse" size={14} /></button>}
      </div>
      {!wide && <button onClick={() => setWide(true)} aria-label="Expand" title="Expand menu" className="volt-expand-btn grid place-items-center"
        onMouseEnter={e => setTip({ label: "Expand menu", y: e.currentTarget.getBoundingClientRect().top + 15 })} onMouseLeave={() => setTip(null)}
        style={{ width: 34, height: 30, margin: "2px auto 0", cursor: "pointer", color: "#9dc0ff",
          background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)",
          clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}><Icon name="expand" size={15} /></button>}
      <div style={{ width: wide ? "auto" : 26, height: 1, margin: wide ? "8px 6px 10px" : "8px auto 10px", background: "rgba(61,123,255,0.35)" }} />

      {secLabel("League")}
      <div style={{ display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", gap: 2 }}>{leagueViews}</div>

      {divider(10, 8)}
      {enterable ? <>
        {/* The tournament by name, with its phase, so it's clear what these open. */}
        {wide ? (
          <div style={{ padding: "2px 12px 8px", minWidth: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700 }}>// {finished ? "Last tournament" : "Tournament"}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 5, minWidth: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: PHASE_COLOR[target.phase], boxShadow: finished ? "none" : `0 0 8px ${PHASE_COLOR[target.phase]}` }} />
              <span style={{ fontSize: 13.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", color: "#eaf1ff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{finished ? weekendName(target) : tLabel}</span>
            </div>
            <div style={{ fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: PHASE_COLOR[target.phase], fontWeight: 700, marginTop: 3, paddingLeft: 14 }}>{PHASE_LABEL[target.phase]}</div>
          </div>
        ) : (
          <span title={`${weekendName(target)} · ${PHASE_LABEL[target.phase]}`} style={{ width: 8, height: 8, borderRadius: "50%", margin: "2px auto 8px", background: PHASE_COLOR[target.phase], boxShadow: finished ? "none" : `0 0 8px ${PHASE_COLOR[target.phase]}` }} />
        )}
        <div style={{ display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", gap: 2 }}>{tourneyViews}</div>
      </> : onCreate ? (
        item("plus", "Create tournament", { onClick: onCreate, accent: "#7da6ff" })
      ) : (
        wide && <div style={{ padding: "4px 12px", fontSize: 12, color: "rgba(200,215,255,0.4)", lineHeight: 1.5 }}>No tournament yet. You'll get a notification when sign-ups open.</div>
      )}

      <div style={{ marginTop: "auto" }} />
      {divider()}
      {onAccount && item("account", "My Account", { onClick: onAccount, accent: "rgba(200,215,255,0.72)", active: page === "account" })}
      <button onClick={() => setSoundOn(v => !v)} className="volt-rail-item flex items-center" aria-label={soundOn ? "Mute" : "Unmute"}
        onMouseEnter={e => { if (!wide) setTip({ label: soundOn ? "Sound on" : "Sound off", y: e.currentTarget.getBoundingClientRect().top + 20 }); }} onMouseLeave={() => setTip(null)}
        style={{ width: wide ? W - 16 : 42, height: 40, justifyContent: wide ? "flex-start" : "center", gap: 10, paddingLeft: wide ? 12 : 0, color: soundOn ? "#7da6ff" : "rgba(180,195,225,0.4)", margin: wide ? 0 : "0 auto", background: "none", border: "none", cursor: "pointer" }}>
        <span style={{ fontSize: 15 }}><Icon name={soundOn ? "soundOn" : "soundOff"} size={18} /></span>
        {wide && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" }}>{soundOn ? "Sound on" : "Sound off"}</span>}
      </button>

      {!wide && tip && (
        <div style={{ position: "fixed", left: W + 12, top: tip.y, transform: "translateY(-50%)", zIndex: 46, pointerEvents: "none", padding: "6px 11px", background: "rgba(10,14,26,0.97)", border: "1px solid rgba(61,123,255,0.5)", clipPath: SHELL_NOTCH(6), fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#eaf1ff", whiteSpace: "nowrap", animation: "voltTipIn 160ms ease", fontFamily: "'Rajdhani',sans-serif" }}>
          <span style={{ color: "#3d7bff", marginRight: 6 }}>//</span>{tip.label}
        </div>
      )}
    </nav>
  );
}

// Owner-only roster of everyone in the league, with one-tap promote/demote.
// Appointing a helper used to mean drilling into a player's profile from the
// Scout Hub, which meant it was effectively undiscoverable — and it only reached
// people registered for the current tournament. This lists the whole league.
// Player-facing: get a code, type /link in Discord. Kept deliberately small —
// it's a one-time action and then it never needs touching again.
// Host-facing: send a message to everyone registered for this tournament. DMs go to
// anyone who linked Discord; the rest are named back so the host knows who was
// missed rather than assuming everyone got it.
// Host-only: connect this league to a Discord server. Two IDs, copied out of
// Discord with Developer Mode on. Deliberately collapsed by default — it's a
// once-ever setup step, not something to look at every tournament.
// Three separate cards each asked the database for the same Discord config on
// every league-home render. It changes when a host edits it and at no other
// time, so it's fetched once and shared. `bust` is called after a write so the
// next read is fresh rather than stale for a minute.
let __dcCache = { at: 0, data: null, inflight: null };
async function loadDiscordCfg(force) {
  if (force) __dcCache = { at: 0, data: null, inflight: null };
  if (__dcCache.data && Date.now() - __dcCache.at < 60000) return __dcCache.data;
  if (__dcCache.inflight) return __dcCache.inflight;
  __dcCache.inflight = (async () => {
    try {
      const { data } = await __sb.rpc("volt_get_discord");
      __dcCache = { at: Date.now(), data: data || {}, inflight: null };
      return __dcCache.data;
    } catch (e) {
      console.error("discord cfg", e);
      __dcCache.inflight = null;
      return {};
    }
  })();
  return __dcCache.inflight;
}
function useDiscordCfg() {
  const [cfg, setCfg] = useState(null);
  useEffect(() => { let ok = true; loadDiscordCfg().then((d) => ok && setCfg(d)); return () => { ok = false; }; }, []);
  return cfg;
}

function DiscordServerCard() {
  const [open, setOpen] = useState(false);
  const [guild, setGuild] = useState("");
  const [channel, setChannel] = useState("");
  const [saved, setSaved] = useState(null);      // null = still loading
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ok, setOk] = useState("");

  async function load() {
    try {
      const { data } = await __sb.rpc("volt_get_discord");
      setSaved(data || { guild: null, channel: null });
      setGuild(data?.guild || ""); setChannel(data?.channel || "");
    } catch { setSaved({ guild: null, channel: null }); }
  }
  useEffect(() => { if (HAS_SUPABASE) load(); }, []);

  async function save(clear) {
    setBusy(true); setErr(""); setOk("");
    try {
      __dcCache = { at: 0, data: null, inflight: null };   // config changed — next read must be fresh
      const { error } = await __sb.rpc("volt_set_discord", {
        p_guild: clear ? null : guild, p_channel: clear ? null : channel });
      if (error) throw new Error(error.message);
      setOk(clear ? "Disconnected." : "Connected. Try /status in your server.");
      await load();
    } catch (e) { setErr(e.message || "Couldn't save that."); }
    setBusy(false);
  }

  const connected = !!saved?.guild;
  const field = { width: "100%", padding: "9px 11px", background: "rgba(10,16,30,0.85)",
    border: "1px solid rgba(61,123,255,0.3)", color: "#ecf3ff",
    fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 };

  return (
    <div style={{ marginTop: 14 }}>
      <CollapseHead title="Discord server" open={open} onToggle={() => setOpen((o) => !o)}
        tone={connected ? "rgba(61,220,132,0.3)" : "rgba(245,196,83,0.32)"}
        hint={saved === null ? "…" : connected ? "Connected" : "Not connected — players won't get messages"} />

      {open && (
        <div style={{ marginTop: 8, ...PANEL(null, "16px 18px") }}>
          <p style={{ fontSize: 11.5, color: "rgba(200,215,255,0.5)", margin: "0 0 12px", lineHeight: 1.6 }}>
            In Discord: <b style={{ color: "rgba(200,215,255,0.8)" }}>Settings → Advanced → Developer Mode</b> on.
            Then right-click your server name → <b style={{ color: "rgba(200,215,255,0.8)" }}>Copy Server ID</b>,
            and right-click your announcements channel → <b style={{ color: "rgba(200,215,255,0.8)" }}>Copy Channel ID</b>.
            The VOLT bot has to be in that server.
          </p>
          <label style={{ display: "block", marginBottom: 10 }}>
            <span style={{ display: "block", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", marginBottom: 4 }}>Server ID</span>
            <input value={guild} onChange={(e) => setGuild(e.target.value)} placeholder="e.g. 000000000000000000" style={field} />
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ display: "block", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", marginBottom: 4 }}>Announcements channel ID</span>
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="e.g. 000000000000000000" style={field} />
          </label>
          <div className="flex items-center gap-3 flex-wrap" style={{ gap: 10 }}>
            <button disabled={busy} onClick={() => save(false)} style={shellBtn("primary", { padding: "9px 16px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
              {busy ? "…" : connected ? "Update" : "Connect"}
            </button>
            {connected && (
              <button disabled={busy} onClick={async () => { if (await voltConfirm("Players stop getting DMs and announcements.", { title: "Disconnect Discord?", confirmLabel: "Disconnect", danger: true })) save(true); }}
                style={shellBtn("ghost", { padding: "9px 14px", fontSize: 12 })}>Disconnect</button>
            )}
          </div>
          {ok && <div style={{ fontSize: 11.5, color: "#9af5c2", marginTop: 10 }}>✓ {ok}</div>}
          {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// Fired once the draft is done: DMs every player their team and teammates, and
// gives them a Discord role so team channels work without manual setup. Separate
// from the announce box because it's a one-per-tournament action, not a message.
// The payoff for the availability check: the day before, silence is visible.
// Only shows once the check has actually gone out, so it isn't noise all week.
function AvailabilityCard({ eventId }) {
  const [d, setD] = useState(null);
  const [unlinked, setUnlinked] = useState([]);
  const [busy, setBusy] = useState(false);
  const [sendMsg, setSendMsg] = useState("");
  const [sendErr, setSendErr] = useState("");
  const dcLinked = useDiscordLinked();

  const load = async () => {
    try {
      const { data } = await __sb.rpc("volt_availability_summary", { p_event: eventId });
      setD(data || null);
    } catch { setD(null); }
    try {
      // Unlinked players are invisible to every Discord feature, so surface them
      // here rather than letting the host discover it when nobody turns up.
      const { data: u } = await __sb.rpc("volt_unlinked", { p_event: eventId });
      setUnlinked(Array.isArray(u) ? u : []);
    } catch { setUnlinked([]); }
  };
  useEffect(() => { load(); }, [eventId]);

  // Send it now rather than waiting for the automatic window ~24h before the
  // draft. Once registration is closed there's nothing left to wait for, and an
  // extra day to chase silence is worth more than the tidiness of a schedule.
  //
  // The text is built server-side by the same function the cron uses, so the
  // two can't drift into saying different things.
  async function sendNow() {
    setBusy(true); setSendErr(""); setSendMsg("");
    try {
      const { data: p, error } = await __sb.rpc("volt_availability_payload", { p_event: eventId });
      if (error) throw new Error(error.message);
      if (p?.error === "nodraft") throw new Error("Set a draft time first — the message references it.");
      if (!p?.userIds?.length) throw new Error("Nobody is approved yet.");

      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ communityId: p.communityId, message: p.message,
                               userIds: p.userIds, announce: false,
                               buttons: "availability", dmButtons: true }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`);

      // Stamp the event so the cron doesn't send it a second time, and so
      // replies start being counted.
      await __sb.rpc("volt_availability_mark_asked", { p_event: eventId });
      // Remember who couldn't be reached. The count alone told the host a
      // problem existed without saying who to chase.
      try {
        await __sb.rpc("volt_set_availability_blocked",
          { p_event: eventId, p_ids: b?.blocked || [] });
      } catch (e) { console.error("save blocked", e); }
      setSendMsg(`Asked ${b?.delivered ?? 0} player${b?.delivered === 1 ? "" : "s"}.` +
        // Say what was deliberately left out, so a smaller number than expected
        // doesn't look like a delivery failure.
        (p.skippedReserves > 0 ? ` ${p.skippedReserves} in reserve were skipped.` : "") +
        (b?.blocked?.length ? ` ${b.blocked.length} have DMs closed.` : ""));
      await load();
    } catch (e) { setSendErr(e.message || "Couldn't send."); }
    setBusy(false);
  }

  const silent = d?.silent || [];
  const asked = !!d?.asked;
  // Before it's been sent the card used to hide entirely, which left nowhere to
  // put the button and no sign the check existed.
  if (!asked && !unlinked.length && !sendMsg && !sendErr) {
    return (
      <div style={{ marginTop: 14 }}>
        <SectionHead title="Availability check" hint="Ask everyone if they're free to play" />
        <div style={PANEL()}>
          <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", margin: "0 0 12px", lineHeight: 1.6 }}>
            DMs everyone in the draft pool asking if they're free for the match window, with buttons
            to confirm or move themselves to reserve. Reserves aren't asked — they're already set
            aside. Sends automatically about a day before the draft, or send it now if registration
            is already closed.
          </p>
          <button disabled={busy} onClick={sendNow}
            style={shellBtn("primary", { padding: "10px 18px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
            {busy ? "Sending…" : "◈ Send availability check now"}
          </button>
          {sendErr && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {sendErr}</div>}
        </div>
      </div>
    );
  }
  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Who we can reach" />
      <div style={PANEL((silent.length || unlinked.length) ? "rgba(245,196,83,0.4)" : "rgba(61,220,132,0.3)")}>
        {/* Not sent yet: the button stays here. Before, one unconnected player
            switched the card to this view and the only way to send was gone. */}
        {!asked && (
          <div style={{ marginBottom: 4 }}>
            <button disabled={busy} onClick={sendNow}
              style={shellBtn("primary", { padding: "10px 18px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
              {busy ? "Sending…" : "◈ Send availability check now"}
            </button>
            <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", marginTop: 8, lineHeight: 1.55 }}>
              DMs everyone in the draft pool except reserves. Goes out automatically about a day before the draft if you don't.
            </div>
          </div>
        )}
        {d?.asked && (
          <div style={{ fontSize: 13.5, color: "#9af5c2", fontWeight: 700 }}>
            ✓ {d.confirmed} confirmed they can play
          </div>
        )}
        {/* Naming the confirmed matters as much as naming the silent: it's how
            you tell a real roster from a hoped-for one, and newest-first
            answers "who's come in since I last looked". */}
        {d?.confirmedNames?.length > 0 && (
          <div style={{ fontSize: 12.5, color: "rgba(154,245,194,0.85)", marginTop: 5, lineHeight: 1.65 }}>
            {d.confirmedNames.join(", ")}
          </div>
        )}
        {d?.declined?.length > 0 && (
          <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", marginTop: 10, lineHeight: 1.65 }}>
            ✗ {d.declined.length} moved themselves to reserve: <b style={{ color: "#cfe0ff" }}>{d.declined.join(", ")}</b>
          </div>
        )}
        {sendMsg && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 6 }}>✓ {sendMsg}</div>}
        {sendErr && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 6 }}>⚠ {sendErr}</div>}
        {d?.blocked?.length > 0 && (
          <div style={{ fontSize: 12.5, color: "rgba(245,196,83,0.9)", marginTop: 10, lineHeight: 1.65 }}>
            ⚠ {d.blocked.length} have DMs closed and never got the message: <b>{d.blocked.join(", ")}</b>
            <div style={{ color: "rgba(200,215,255,0.42)", marginTop: 4 }}>
              They need to allow DMs from server members, or you'll have to ask them in a channel.
            </div>
          </div>
        )}
        {unlinked.length > 0 && (
          <div style={{ fontSize: 12.5, color: "rgba(245,196,83,0.9)", marginTop: 10, lineHeight: 1.65 }}>
            ⚠ {unlinked.length} haven't connected Discord: {unlinked.join(", ")}
            <div style={{ color: "rgba(200,215,255,0.45)", marginTop: 2 }}>
              They get no reminders, no availability check and no team DM.
              {" "}Run <code style={{ color: "rgba(200,215,255,0.7)" }}>/rollcall</code> in Discord to nudge them.
            </div>
            {/* If the host is one of the unconnected, fixing it should be right
                here rather than "go and find the card". */}
            {dcLinked === false && (
              <button onClick={() => startDiscordOAuth().catch(() => {})}
                style={shellBtn("accent", { padding: "8px 14px", fontSize: 11.5, marginTop: 8 })}>
                ◈ Connect yours now
              </button>
            )}
          </div>
        )}
        {d?.asked && silent.length > 0 ? (
          <div style={{ fontSize: 12.5, color: "rgba(245,196,83,0.9)", marginTop: 10, lineHeight: 1.65 }}>
            ⚠ {silent.length} haven't answered: {silent.join(", ")}
            {/* Chasing silence is the whole point of asking early. */}
            <button disabled={busy} onClick={sendNow}
              style={shellBtn("ghost", { padding: "6px 13px", fontSize: 10.5, marginTop: 8, marginBottom: 2 })}>
              {busy ? "Sending…" : "◈ Ask again"}
            </button>
            <div style={{ color: "rgba(200,215,255,0.42)", marginTop: 4 }}>
              Worth chasing before the draft — these are the likely no-shows.
            </div>
          </div>
        ) : d?.asked ? (
          <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.5)", marginTop: 6 }}>Everyone has answered.</div>
        ) : null}
      </div>
    </div>
  );
}

function DiscordTeamsCard({ eventId }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState("");
  const [roles, setRoles] = useState(true);
  // Big leagues go out in batches (the API stops at ~40s and returns `next`).
  // A failed batch keeps its place, so trying again resumes rather than
  // messaging the first half twice.
  const [progress, setProgress] = useState(null);   // { done, total }
  const [resumeFrom, setResumeFrom] = useState(0);

  async function run() {
    setBusy(true); setErr("");
    const sum = resumeFrom > 0 && res ? { ...res } : { dmed: 0, unlinked: 0, blocked: 0, rolesCreated: 0, rolesAssigned: 0, roleErrors: [] };
    if (!resumeFrom) setRes(null);
    let from = resumeFrom;
    try {
      for (let guard = 0; guard < 100; guard++) {
        const { data: sess } = await __sb.auth.getSession();
        const jwt = sess?.session?.access_token;
        if (!jwt) throw new Error("Session expired — sign in again.");
        const r = await fetch(apiUrl("/api/discord-teams"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ eventId, assignRoles: roles, from }),
        });
        const b = await r.json().catch(() => null);
        if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`);
        for (const k of ["dmed", "unlinked", "blocked", "rolesCreated", "rolesAssigned"]) sum[k] += b[k] || 0;
        for (const e of b.roleErrors || []) if (!sum.roleErrors.includes(e)) sum.roleErrors.push(e);
        setRes({ ...sum });
        setProgress({ done: b.done ?? 0, total: b.total ?? 0 });
        if (b.next == null) { from = 0; break; }
        from = b.next;
        setResumeFrom(from);
      }
      setResumeFrom(0);
    } catch (e) {
      setResumeFrom(from);
      setErr((e.message || "Couldn't send.") + (from > 0 ? " Press the button again to carry on from where it stopped." : ""));
    }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Tell everyone their team" />
      <div style={PANEL()}>
        <p style={{ fontSize: 13, color: "rgba(200,215,255,0.6)", margin: "0 0 12px", lineHeight: 1.6 }}>
          DMs every drafted player their team, captain and squad — so nobody has to ask.
        </p>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 12.5, color: "rgba(200,215,255,0.7)", marginBottom: 14 }}>
          <input type="checkbox" checked={roles} onChange={(e) => setRoles(e.target.checked)} />
          Also give each player a Discord team role
        </label>
        <div>
          <button disabled={busy} onClick={run} style={shellBtn("primary", { padding: "9px 16px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
            {busy ? (progress?.total ? `Sending… ${progress.done} / ${progress.total}` : "Sending…") : resumeFrom > 0 ? `Carry on from ${resumeFrom}${progress?.total ? ` / ${progress.total}` : ""}` : "Send team DMs"}
          </button>
        </div>
        {res && (
          <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
            <div style={{ color: "#9af5c2" }}>✓ DM'd {res.dmed} player{res.dmed === 1 ? "" : "s"}
              {res.rolesAssigned > 0 && ` · ${res.rolesAssigned} role${res.rolesAssigned === 1 ? "" : "s"} assigned`}
              {res.rolesCreated > 0 && ` (${res.rolesCreated} created)`}</div>
            {res.blocked > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {res.blocked} have DMs closed.</div>}
            {res.unlinked > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {res.unlinked} haven't connected Discord — they got nothing.</div>}
            {res.roleErrors?.length > 0 && (
              <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ Roles: {res.roleErrors.join("; ")}</div>
            )}
          </div>
        )}
        {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

function DiscordAnnounce({ eventId, communityId, phase }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  // Who this goes to. It used to be hardcoded to people already registered,
  // which made the sign-up buttons useless — every recipient was already in.
  // "Not signed up yet" is the audience that actually needs a Register button.
  // "Approved" means approved for a specific tournament, which is meaningless
  // once that tournament is over — so between weekends the default audience is
  // the whole league.
  const [scope, setScope] = useState(phase === "settled" ? "all" : "approved");
  const [counts, setCounts] = useState({});          // scope → how many that reaches
  // What the recipient can tap. Explicit rather than inferred from the audience,
  // because "who gets it" and "what can they do about it" are separate decisions.
  const [reply, setReply] = useState("none");
  // Where it lands. A draft reminder wants DMs; "sign-ups are open" wants the
  // channel, where people who aren't in the league yet can still see it.
  const [deliver, setDeliver] = useState("both");
  // Pinging is opt-in per message. A role ping notifies everyone holding it, so
  // defaulting it on would train people to mute the channel.
  const [ping, setPing] = useState(false);
  const [role, setRole] = useState(null);      // { id, name } once known
  const sendsDM = deliver !== "channel";
  const sendsChannel = deliver !== "dm";

  useEffect(() => {
    let ok = true;
    loadDiscordCfg().then((d) => ok && setRole({ id: d?.roleId || null, name: d?.roleName || "VOLT Player" }));
    return () => { ok = false; };
  }, []);
  const regOpen = phase === "registration_open";
  const settled = phase === "settled";
  const SCOPES = regOpen
    ? [["approved", "Already signed up"], ["unregistered", "Not signed up yet"], ["all", "Whole league"]]
    : [["approved", "Already signed up"], ["all", "Whole league"]];
  // Each reply set is one row of real Discord buttons. Showing the exact labels
  // means the host knows what lands, instead of guessing from ours.
  const REPLIES = [
    { k: "none", label: "Nothing", note: "Just the message.", buttons: [] },
    { k: "register", label: "Sign up", note: "One tap to enter the tournament — no link, no login.",
      buttons: ["Register", "Register + captain"], needs: regOpen,
      why: "Registration has to be open for these to work." },
    { k: "availability", label: "Are you still coming?", note: "Answers land in “Who we can reach” below, so silence is visible before the draft.",
      // Answers are tracked per player, so a channel-only post has nobody to
      // attribute them to — "Who we can reach" would stay blank either way.
      buttons: ["I'm in", "Can't make it"], needs: scope !== "unregistered" && sendsDM,
      why: scope === "unregistered" ? "Only people already signed up can confirm."
        : "Needs to go out as a DM so replies can be tracked per player." },
  ];
  const activeReply = REPLIES.find(r => r.k === reply) || REPLIES[0];
  const replyOk = activeReply.needs !== false;

  // Preview the reach of each audience so the host isn't sending blind.
  // One call for all three: the chips render integers, so there's no reason to
  // download three full lists of user IDs to produce them.
  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const { data } = await __sb.rpc("volt_notify_counts", { p_event: eventId });
        if (!dead && data) setCounts(data);
      } catch (e) { console.error("target preview", e); }
    })();
    return () => { dead = true; };
  }, [eventId, phase, result]);

  useEffect(() => { if (!regOpen && scope === "unregistered") setScope("approved"); }, [regOpen]);
  useEffect(() => { if (!replyOk) setReply("none"); }, [replyOk]);

  async function send() {
    if (!msg.trim()) return;
    setBusy(true); setErr(""); setResult(null);
    try {
      const { data: t, error: te } = await __sb.rpc("volt_notify_targets", { p_event: eventId, p_scope: scope });
      if (te) throw new Error(te.message);
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        // dmButtons puts the row in the DM itself — the point of asking a question
        // is that answering costs one tap, not a trip back to the app.
        body: JSON.stringify({ communityId, message: msg.trim(),
                               userIds: sendsDM ? (t?.userIds || []) : [],
                               announce: sendsChannel,
                               buttons: reply === "none" ? undefined : reply,
                               dmButtons: reply === "none" || !sendsDM ? undefined : true,
                               // Always re-sync when pinging: a stale role would
                               // notify people who withdrew and miss people who
                               // just joined, which is worse than not pinging.
                               mentionRole: ping && sendsChannel,
                               syncRole: ping && sendsChannel,
                               roleName: role?.name || undefined }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
      // Stamp the event so "Who we can reach" starts counting replies. Without
      // this the card never appears no matter how many people answer.
      if (body?.roleId && !role?.id) setRole((r) => ({ ...(r || {}), id: body.roleId }));
      if (reply === "availability" && sendsDM) {
        try { await __sb.rpc("volt_availability_mark_asked", { p_event: eventId }); }
        catch (e) { console.error("mark asked", e); }
      }
      setResult(body); setMsg("");
    } catch (e) { setErr(e.message || "Couldn't send."); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Message the league"
        hint={settled ? "Between tournaments — goes to the whole league"
                      : "DMs the audience you pick, and posts to your channel"} />
      <div style={PANEL()}>
        <textarea value={msg} onChange={(e) => setMsg(e.target.value)} rows={3}
          placeholder="e.g. Draft starts in 30 minutes — be in the voice channel."
          style={{ width: "100%", padding: "11px 13px", background: "rgba(8,12,24,0.85)", border: "1px solid rgba(61,123,255,0.28)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 14, lineHeight: 1.5, resize: "vertical", clipPath: SHELL_NOTCH(7) }} />
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>Deliver as</span>
          {[["both", "DM + channel"], ["dm", "DM only"], ["channel", "Channel only"]].map(([k, label]) => {
            const on = deliver === k;
            return (
              <button key={k} onClick={() => setDeliver(k)}
                style={{ padding: "6px 12px", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", fontSize: 12, fontWeight: 700,
                  letterSpacing: "0.04em", clipPath: SHELL_NOTCH(6),
                  background: on ? "rgba(157,107,255,0.16)" : "rgba(10,16,30,0.5)",
                  border: `1px solid ${on ? "rgba(157,107,255,0.6)" : "rgba(120,150,220,0.18)"}`,
                  color: on ? "#d6bcff" : "rgba(200,215,255,0.55)" }}>
                {label}
              </button>
            );
          })}
        </div>
        {/* Channel-only reaches whoever is in the server, so picking an audience
            of VOLT members has nothing to act on. Say so rather than leaving a
            live-looking control that does nothing. */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12, opacity: sendsDM ? 1 : 0.4, pointerEvents: sendsDM ? "auto" : "none" }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>DM to</span>
          {SCOPES.map(([k, label]) => {
            const on = scope === k, c = counts[k];
            return (
              <button key={k} onClick={() => setScope(k)}
                style={{ padding: "6px 12px", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", fontSize: 12, fontWeight: 700,
                  letterSpacing: "0.04em", clipPath: SHELL_NOTCH(6),
                  background: on ? "rgba(61,123,255,0.16)" : "rgba(10,16,30,0.5)",
                  border: `1px solid ${on ? "rgba(61,123,255,0.6)" : "rgba(120,150,220,0.18)"}`,
                  color: on ? "#cfe0ff" : "rgba(200,215,255,0.55)" }}>
                {label}{c ? <span style={{ opacity: 0.6, fontWeight: 500 }}> · {c.total}</span> : null}
              </button>
            );
          })}
        </div>
        {!sendsDM && (
          <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)", marginTop: 6 }}>
            Nobody is DM'd — it goes to everyone who can see your announcements channel, in the league or not.
          </div>
        )}
        {sendsChannel && (
          <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", marginTop: 10, flexWrap: "wrap" }}>
            <input type="checkbox" checked={ping} onChange={(e) => setPing(e.target.checked)} />
            <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.7)" }}>
              Ping <b style={{ color: "#cfe0ff" }}>@{role?.name || "VOLT Player"}</b> on the channel post
            </span>
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)" }}>
              {role?.id ? "Members are re-synced to whoever's approved before it sends."
                        : "The bot will create the role the first time you use this."}
            </span>
          </label>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>Let them reply with</span>
          {REPLIES.map((r) => {
            const on = reply === r.k, off = r.needs === false;
            return (
              <button key={r.k} disabled={off} onClick={() => setReply(r.k)} title={off ? r.why : r.note}
                style={{ padding: "6px 12px", cursor: off ? "not-allowed" : "pointer", fontFamily: "'Rajdhani',sans-serif",
                  fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", clipPath: SHELL_NOTCH(6), opacity: off ? 0.35 : 1,
                  background: on ? "rgba(61,220,132,0.14)" : "rgba(10,16,30,0.5)",
                  border: `1px solid ${on ? "rgba(61,220,132,0.5)" : "rgba(120,150,220,0.18)"}`,
                  color: on ? "#9af5c2" : "rgba(200,215,255,0.55)" }}>
                {r.label}
              </button>
            );
          })}
        </div>
        {/* Show the actual Discord buttons rather than describing them. */}
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", marginTop: 9, minHeight: 26 }}>
          {activeReply.buttons.length > 0 && <>
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.4)" }}>They'll see:</span>
            {activeReply.buttons.map((b, i) => (
              <span key={b} style={{ padding: "4px 12px", fontSize: 11.5, fontWeight: 600, borderRadius: 4,
                background: i === 0 ? "#5865f2" : "rgba(120,130,150,0.28)", color: "#fff" }}>{b}</span>
            ))}
          </>}
          <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)", flex: "1 1 200px" }}>{activeReply.note}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", marginTop: 14 }}>
          <button disabled={busy || !msg.trim()} onClick={send}
            style={shellBtn("primary", { padding: "10px 18px", fontSize: 12, opacity: busy || !msg.trim() ? 0.5 : 1 })}>
            {busy ? "Sending…" : "Send"}
          </button>
          <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)" }}>
            {deliver === "both" ? "A DM to each person above, plus one post in your announcements channel."
              : deliver === "dm" ? "A DM to each person above. Nothing is posted publicly — except an @mention for anyone whose DMs are closed."
              : "One post in your announcements channel. No DMs."}
          </span>
        </div>
        {sendsDM && counts[scope]?.unlinked > 0 && (
          <div style={{ fontSize: 11.5, color: "rgba(245,196,83,0.85)", marginTop: 8 }}>
            ⚠ {counts[scope].unlinked} of them haven't connected Discord — they won't get the DM, only the channel post.
          </div>
        )}
        {result && (() => {
          // Nothing landed at all — report only the failure. Claiming success
          // and then contradicting it on the next line is worse than a plain
          // error, because it leaves you unsure whether anything went out.
          const nothing = !result.announced && !result.delivered;
          return (
            <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              {nothing ? (
                <div style={{ color: "#ff8f9a" }}>
                  ⚠ Nothing was delivered
                  {result.announceError ? ` — ${result.announceError}.`
                    : ". Check your announcements channel is set under Discord server."}
                </div>
              ) : (
                <>
                  {result.delivered > 0 && <span style={{ color: "#9af5c2" }}>✓ DM'd {result.delivered}</span>}
                  {result.announced && <span style={{ color: result.delivered > 0 ? "rgba(200,215,255,0.5)" : "#9af5c2" }}>
                    {result.delivered > 0 ? " · posted to the channel" : "✓ Posted to the channel"}</span>}
                  {!result.announced && result.announceError && (
                    <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ Channel post failed — {result.announceError}.</div>
                  )}
                </>
              )}
              {result.blocked?.length > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {result.blocked.length} have DMs closed — they were @mentioned in the channel instead.</div>}
              {result.unlinked?.length > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {result.unlinked.length} haven't connected Discord yet — they got nothing.</div>}
              {result.roleSynced && (result.roleSynced.added || result.roleSynced.removed) > 0 && (
                <div style={{ color: "rgba(200,215,255,0.5)" }}>
                  Role updated — {result.roleSynced.added} added, {result.roleSynced.removed} removed.
                </div>
              )}
              {result.roleError && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ Role: {result.roleError}</div>}
            </div>
          );
        })()}
        {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// Every "Connect Discord" entry point goes through here so they behave the same:
// hand Discord a signed token identifying this VOLT account and let it redirect.
// `resume` says what to reopen on the way back (see setResume).
async function startDiscordOAuth(resume) {
  const { data: sess } = await __sb.auth.getSession();
  const jwt = sess?.session?.access_token;
  if (!jwt) throw new Error("Session expired — sign in again.");
  if (resume) setResume(resume);
  if (IS_NATIVE) { await openAuthUrl(`${SITE}/api/discord-oauth?token=${encodeURIComponent(jwt)}&app=1`); return; }
  window.location.href = `/api/discord-oauth?token=${encodeURIComponent(jwt)}`;
}

// Is the signed-in player linked yet? Null while loading.
function useDiscordLinked() {
  const [linked, setLinked] = useState(null);
  useEffect(() => { (async () => {
    if (!HAS_SUPABASE || !window.__VOLT?.userId || !window.__VOLT?.communityId) { setLinked(true); return; }
    try {
      const { data } = await __sb.from("player_contacts").select("discord_user_id")
        .eq("user_id", window.__VOLT.userId).eq("community_id", window.__VOLT.communityId).maybeSingle();
      setLinked(!!data?.discord_user_id);
    } catch { setLinked(true); }   // fail quiet rather than nag on a network blip
  })(); }, []);
  return linked;
}

// Discord is where every reminder, availability check and team DM lands — an
// unlinked player is invisible to the whole loop. So this sits at the very top
// of the league home until it's done, then never appears again.
// ── Pinned signup guide ──────────────────────────────────────────────────
// Every league needs the same post in its #sign-up channel, but the contents
// differ per league — name, join code, whether the bot is even connected. So
// it's generated from live data rather than being a template the host fills in
// and then forgets to update when the draft time moves.
//
// Output is Discord-flavoured markdown, not the app's own styling: it's going
// to be pasted into Discord, so ** and > have to survive the trip.
// Discord hard-caps a message at 2000 characters and an embed description at
// 4096. The bot posts an embed so it has room, but a host who pastes this by
// hand is stuck with 2000 — so the text is written to fit under it.
//
// Shape: the action comes first, the walkthrough sits underneath it behind a
// heading that says who it's for. A returning player reads two lines and taps;
// a newcomer gets the full three steps without having to ask. Putting the
// steps first would make everyone read four paragraphs to find the button.
const DISCORD_MSG_LIMIT = 2000;
function buildJoinGuide({ community, current, connected, origin }) {
  const link = `${origin}/?join=${community?.slug || ""}`;
  const L = [];
  const add = (...xs) => L.push(...xs);

  add(`# ${community?.name || "Our league"}`, "");
  add("### A weekend Valorant league — and you don't need a team.", "");
  add("Sign up on your own, captains bid for you at a live auction, " +
      "and you play the weekend with whoever wins you.", "");

  if (current) {
    add(`**${weekendName(current)}** — ${PHASE_LABEL[current.phase] || current.phase}`);
    if (current.draft_at) {
      // <t:unix:F> renders in each reader's own clock. A fixed time in one
      // timezone is the biggest single cause of missed drafts.
      const unix = Math.floor(new Date(current.draft_at).getTime() / 1000);
      add(`Draft: <t:${unix}:F> — <t:${unix}:R>, in your timezone.`);
    }
    add("");
  }

  if (connected) {
    add("## Played with us before?", "");
    add("Hit **Already signed up? Add me** below. That's it — you're in the pool.", "");
  }

  add("## First time here?", "");
  add(`**1. Make your account** — ${link}`);
  add("> The join code is already filled in.");
  add("**2. Fill in your profile** — your rank, your role, and a WhatsApp number.");
  add("> Quickest way: paste a screenshot of your tracker.gg Competitive page and it reads your stats for you.");
  add("> Your number is only ever seen by the host and mods, and only if a match is falling apart.");
  if (connected) {
    add("**3. Press Connect Discord** on your profile.");
    add("> One click, no code to type. It's how you hear when the draft starts and which team picked you.");
    add("");
    add("Then hit **Already signed up? Add me**. If something's missing it'll say exactly what.");
  } else {
    add("**3. Flip “I'm playing this tournament”** on the site.");
    add("> ⚠ This league hasn't connected its Discord server yet, so sign-ups happen on the site for now.");
  }
  add("");

  add("## Worth knowing", "");
  add("· Captains see your rank and stats when they bid, so put down an honest one — it gets you a fairer price.");
  add("· The day before the draft I'll ask if you're still free. **Answer it.** " +
      "Pulling out costs you nothing; going quiet and not showing up is a no-show.");
  add("· Your first tournament gets reviewed by the host. After two clean ones you're approved instantly.");
  add("");

  if (connected) {
    add("## Commands you can use here", "");
    add("`/signup` · `/withdraw` — get in, or pull out before the draft");
    add("`/schedule` — upcoming matches, yours first");
    add("`/standings` — the tournament table");
    add("`/roster` — your team and teammates this tournament");
    add("`/me` — your rank, stats and season points");
    add("`/leaderboard` — the season race");
    add("`/scout` — look up any player in the league");
    add("`/help` — everything else", "");
  }

  add("-# We store your Discord name and ID, your display name, the stats you enter, and a WhatsApp " +
      "number that only the host and mods can see. We never see your Riot or email password, or any payment details.");
  return L.join("\n");
}

function JoinGuideCard({ community, current }) {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(null);
  const [hasSignup, setHasSignup] = useState(false);
  const [busy, setBusy] = useState("");
  const [res, setRes] = useState("");
  const [err, setErr] = useState("");
  const origin = typeof window !== "undefined" ? siteOrigin() : "";

  useEffect(() => {
    if (!open || connected !== null) return;
    let ok = true;
    loadDiscordCfg().then((d) => {
      if (!ok) return;
      setConnected(!!(d?.guild && d?.channel));
      setHasSignup(!!d?.signupChannel);
    });
    return () => { ok = false; };
  }, [open, connected]);

  const text = buildJoinGuide({ community, current, connected: !!connected, origin });

  // Fix the role without sending anything. Useful after approving a batch of
  // applications, or the first time — it's what creates the role.
  async function syncRole() {
    setBusy("role"); setErr(""); setRes("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        // announce:false and no userIds — nothing is sent, this is roles only.
        body: JSON.stringify({ communityId: community?.id, message: "(role sync)",
                               userIds: [], announce: false, syncRole: true }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
      const c = body?.roleSynced;
      // An endpoint that predates role support returns 200 and quietly ignores
      // syncRole. Reporting that as success is worse than failing — the host
      // walks away believing the role exists. Detect it by its absence.
      if (!("roleId" in (body || {}))) {
        setErr("The server is running an older version of /api/discord-notify — re-upload it to Vercel, then try again.");
      } else if (c) {
        // Report what happened first. A partial sync is progress, and burying
        // it under a single Discord error makes a working run look broken.
        const bits = [`${c.added} added`, `${c.removed} removed`, `${c.kept} already had it`];
        setRes(`Player role synced — ${bits.join(", ")}.`);
        const notes = [];
        if (c.notInServer > 0) notes.push(
          `${c.notInServer} ${c.notInServer === 1 ? "player has" : "players have"} connected Discord but ${c.notInServer === 1 ? "isn't" : "aren't"} in this server` +
          (c.missing?.length ? ` (${c.missing.join(", ")})` : "") +
          " — they'll still get DMs, but can't hold the role until they join.");
        if (body.roleError) notes.push(body.roleError);
        if (notes.length) setErr(notes.join(" "));
      } else if (body?.roleError) {
        setErr(`Role: ${body.roleError}`);
      } else if (!body?.roleId) {
        setErr("Couldn't create the role. Give the bot Manage Roles in Server Settings → Roles.");
      } else {
        setRes("Player role created. Nobody's approved for this tournament yet, so it's empty.");
      }
    } catch (e) { setErr(e.message || "Couldn't sync."); }
    setBusy("");
  }

  // `where` is either the announcements channel the host already set, or a
  // dedicated #sign-up-here the bot creates. A guide buried in announcements
  // scrolls away in a week, which is the whole reason for the second option.
  async function post(where) {
    setBusy(where); setErr(""); setRes("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        // No userIds: this is a channel post, not a DM blast. DMing a reference
        // people come back to would be spam.
        body: JSON.stringify({ communityId: community?.id, message: text,
                               userIds: [], announce: true, buttons: "welcome",
                               // Powers the link button, so a newcomer's first tap
                               // opens the sign-up page instead of erroring.
                               buttonUrl: `${origin}/?join=${community?.slug || ""}`,
                               embed: text.length > 1900,
                               // A dedicated channel holds this one post, so there's
                               // nothing for a pin to lift it above. Announcements
                               // scroll, so pin there.
                               pin: where === "announce",
                               channelName: where === "signup" ? "sign-up-here" : undefined }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
      // Remember the channel so a second run reuses it instead of hunting again.
      if (body?.channelId) {
        __dcCache = { at: 0, data: null, inflight: null };
        try { await __sb.rpc("volt_set_signup_channel", { p_channel: body.channelId }); setHasSignup(true); }
        catch (e) { console.error("save signup channel", e); }
      }
      const dest = where === "signup" ? "#sign-up-here" : "your announcements channel";
      if (!body?.announced) {
        setErr("Couldn't post — check your announcements channel is set under Discord server.");
      } else if (where === "signup") {
        setRes(`Posted to ${dest}${body.lockError ? "" : " — read-only, so it stays the only message there"}.`);
        // Locking is separate from posting; a failure there shouldn't read as
        // a failed post, but the host does need to know the channel is open.
        if (body.lockError) setErr(`Posted, but ${body.lockError}. Members can still write in that channel.`);
      } else if (body.pinned) {
        setRes(`Posted and pinned to ${dest}.`);
      } else {
        setRes(`Posted to ${dest}. Couldn't pin it — ` + (body.pinError || "pin it yourself") + ".");
      }
    } catch (e) { setErr(e.message || "Couldn't post."); }
    setBusy("");
  }

  return (
    <div style={{ marginTop: 14 }}>
      <CollapseHead title="Signup guide" open={open} onToggle={() => setOpen((o) => !o)}
        hint="The post that explains your league to new players" />
      {open && (
        <div style={{ marginTop: 8, ...PANEL(null, "16px 18px") }}>
          <p style={{ fontSize: 13, color: "rgba(200,215,255,0.6)", margin: "0 0 12px", lineHeight: 1.6 }}>
            Built from your league's live details, so the draft time is always current. Re-post it whenever
            something changes — the bot reuses the same channel rather than making another one.
          </p>
          <textarea readOnly value={text} rows={14}
            data-len={text.length}
            onFocus={(e) => e.target.select()}
            style={{ width: "100%", padding: "12px 14px", background: "rgba(8,12,24,0.85)",
              border: "1px solid rgba(61,123,255,0.24)", color: "rgba(236,243,255,0.85)",
              fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, lineHeight: 1.65,
              resize: "vertical", clipPath: SHELL_NOTCH(7) }} />
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
            {connected && (
              <button disabled={!!busy} onClick={() => post("signup")}
                style={shellBtn("primary", { padding: "10px 18px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
                {busy === "signup" ? "Working…" : hasSignup ? "◈ Update #sign-up-here" : "◈ Create #sign-up-here & post"}
              </button>
            )}
            {connected && (
              <button disabled={!!busy} onClick={() => post("announce")}
                style={shellBtn("ghost", { padding: "10px 18px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
                {busy === "announce" ? "Posting…" : "Post to announcements"}
              </button>
            )}
            <CopyButton text={text} label="Copy" style={shellBtn("ghost", { padding: "10px 16px", fontSize: 12 })} />
            {connected && (
              <button disabled={!!busy} onClick={syncRole}
                title="Give the player role to everyone approved, and take it off everyone who isn't"
                style={shellBtn("ghost", { padding: "10px 16px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
                {busy === "role" ? "Syncing…" : "⟳ Sync player role"}
              </button>
            )}
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)" }}>
              {connected
                ? "#sign-up-here is created read-only, so the post stays the only thing in it. A pasted copy can't carry the sign-up button — only the bot can add that."
                : "Connect your Discord server above and the bot can post this itself, with a sign-up button attached."}
            </span>
          </div>
          <div style={{ fontSize: 11, color: text.length > DISCORD_MSG_LIMIT ? "#f5c453" : "rgba(200,215,255,0.3)",
            marginTop: 8, fontFamily: "'IBM Plex Mono',monospace" }}>
            {text.length} / {DISCORD_MSG_LIMIT} characters
            {text.length > DISCORD_MSG_LIMIT
              ? " — over the limit, so it posts as a compact embed and can't be pasted by hand"
              : " — posts at full size"}
          </div>
          {res && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {res}</div>}
          {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Discord arena ────────────────────────────────────────────────────────
// Builds the tournament's home inside Discord. Split into two steps because
// they have different prerequisites: the common channels need nothing and are
// worth having up before sign-ups close, while team roles and private rooms
// can't exist until the auction has actually assigned people to teams.
function DiscordArenaCard({ eventId, phase }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [warn, setWarn] = useState("");
  const drafted = ["drafting", "matches_live", "settled"].includes(phase);

  async function run(mode, label) {
    if (mode === "wrapup" && !(await voltConfirm(
      "Deletes the team roles, team text rooms and team voice rooms from every finished tournament. " +
      "Their chat history goes with them.\n\n" +
      "The shared channels (#results, #standings and the rest) and anything the current tournament uses are kept.",
      { title: "Clear old tournaments from Discord?", confirmLabel: "Delete them", cancelLabel: "Keep", danger: true }))) return;
    setBusy(mode); setErr(""); setMsg(""); setWarn("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      // Each request stops after ~8s (Vercel's limit) and reports `partial`.
      // Every step is idempotent, so keep calling until it finishes instead of
      // asking the host to press the button again and again.
      const once = async () => {
        const r = await fetch(apiUrl("/api/discord-arena"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
          body: JSON.stringify({ eventId, mode }),
        });
        const b = await r.json().catch(() => null);
        if (!r.ok) {
          if (b?.error) throw new Error(b.error);
          if (r.status === 504 || r.status === 500) throw new Error(
            "The server gave up part-way through. Anything it already made is kept — press the button again to finish the rest.");
          if (r.status === 404) throw new Error(
            "/api/discord-arena isn't deployed yet — upload it to Vercel and wait for the build.");
          throw new Error(`Failed (${r.status})`);
        }
        return b;
      };
      const loops = mode === "teams" || mode === "common" || mode === "wrapup";
      let b = await once(), madeAll = b.created?.length || 0, deletedAll = b.deleted || 0;
      for (let i = 0; loops && b.partial && i < 10; i++) {
        setMsg(`Still working — ${madeAll} created so far…`);
        b = await once();
        madeAll += b.created?.length || 0;
        deletedAll += b.deleted || 0;
      }
      b.deleted = deletedAll;
      // Things made in an earlier round show up as "reused" in the last one.
      const made = madeAll, kept = Math.max(0, (b.reused?.length || 0) - (madeAll - (b.created?.length || 0)));
      const label = mode === "teams" ? "Team rooms" : mode === "common" ? "Channels" : "";
      if (mode === "wrapup") {
        const n = b.deleted || 0;
        setMsg((b.partial
          ? `Deleted ${n} so far — ran out of time, press again to finish.`
          : n ? `Deleted ${n} old team role${n === 1 ? "" : "s"} and room${n === 1 ? "" : "s"}.`
              : "Nothing to clear — no old team roles or rooms left.") +
          (b.renamed ? ` Shared category renamed to “${b.renamed}”.` : ""));
        if (b.errors?.length) setWarn(b.errors.slice(0, 3).join(" · "));
        setBusy(""); return;
      }
      if (b.partial) {
        setMsg(`${label}: ${made} created, ${kept} already there — ran out of time, press again to finish the rest.`);
        setBusy(""); return;
      }
      if (mode === "teams") {
        setMsg(`Team rooms: ${b.teams} teams — ${made} created, ${kept} already there, ` +
               `${b.assigned} players given their role.`);
      } else if (mode === "standings") {
        setMsg(b.edited ? "Standings updated in place." : "Standings posted.");
      } else if (mode === "fixtures") {
        setMsg(`${b.matches} fixtures ${b.edited ? "updated in place" : "posted"}.`);
      } else {
        setMsg(`${label || "Done"}: ${made} created, ${kept} already there.`);
      }
      // Partial success is the normal outcome when a permission is missing, so
      // errors surface alongside the result rather than replacing it.
      if (b.errors?.length) setWarn(b.errors.slice(0, 3).join(" · "));
    } catch (e) { setErr(e.message || "Couldn't do that."); }
    setBusy("");
  }

  // Opens voting for the whole schedule at once. Separate endpoint from the
  // channel builder because it posts as the host — the RPC checks staff against
  // their own token rather than trusting the client.
  async function openPredictions() {
    setBusy("predictions"); setErr(""); setMsg("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-predictions?mode=open"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ eventId }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`);
      setMsg(b.posted
        ? `Predictions open for ${b.posted} match${b.posted === 1 ? "" : "es"}. A reminder pings the role an hour before each.`
        : "Nothing to open — every upcoming match already has a card.");
      if (b.errors?.length) setErr(b.errors.slice(0, 3).join(" · "));
    } catch (e) { setErr(e.message || "Couldn't post."); }
    setBusy("");
  }

  const B = ({ mode, label, on = true, kind = "ghost", tip }) => (
    <button disabled={!!busy || !on} onClick={() => run(mode, label)} title={tip}
      style={shellBtn(kind, { padding: "10px 16px", fontSize: 12, opacity: (!on || busy) ? 0.5 : 1 })}>
      {busy === mode ? "Working…" : label}
    </button>
  );

  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Discord arena" hint="Channels, team rooms and live results" />
      <div style={PANEL()}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <B mode="common" label={<><Icon name="hash" size={15} style={{ marginRight: 6 }} />Set up channels</>} kind="primary"
             tip="Category, #results, #standings, #trash-talk, and voice rooms" />
          <B mode="teams" label={<><Icon name="rosters" size={15} style={{ marginRight: 6 }} />Build team rooms</>} on={drafted} kind={drafted ? "primary" : "ghost"}
             tip={drafted ? "A role, a private text room and a private voice room per team"
                          : "Available once the auction has run"} />
          <B mode="fixtures" label={<><Icon name="calendar" size={15} style={{ marginRight: 6 }} />Post fixtures</>} tip="Who plays who and when, in everyone's own timezone" />
          <button disabled={!!busy} onClick={openPredictions}
            title="Posts a prediction card for every upcoming match. A reminder pings the role an hour before each one."
            style={shellBtn("ghost", { padding: "10px 16px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
            {busy === "predictions" ? "Posting…" : <><Icon name="eye" size={15} style={{ marginRight: 6 }} />Open predictions</>}
          </button>
          <B mode="standings" label={<><Icon name="refresh" size={15} style={{ marginRight: 6 }} />Post standings</>} />
          <B mode="wrapup" label={<><Icon name="clean" size={15} style={{ marginRight: 6 }} />Clear old tournaments</>}
             tip="Delete team roles and rooms left over from finished tournaments" />
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)", marginTop: 11, lineHeight: 1.65 }}>
          <b style={{ color: "rgba(200,215,255,0.7)" }}>Set up channels</b> is safe to run now — nothing in it
          depends on the draft. <b style={{ color: "rgba(200,215,255,0.7)" }}>Build team rooms</b> gives each
          team a role, a private text channel and its own voice room, visible only to that team and staff.
          Both are safe to re-run: existing channels are reused, never duplicated.
          Post fixtures once the schedule is locked — re-run it after any reschedule and it edits
          the same message rather than posting a second one. Team roles and rooms are deleted
          automatically when you settle a tournament; <b style={{ color: "rgba(200,215,255,0.7)" }}>Clear
          old tournaments</b> does the same by hand.
        </div>
        {msg && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {msg}</div>}
        {warn && <div style={{ fontSize: 11.5, color: "rgba(245,196,83,0.9)", marginTop: 8 }}>⚠ {warn}</div>}
        {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// ── Draft recap + Discord event ──────────────────────────────────────────
// Two one-shot host actions that turn a VOLT fact into something native in
// Discord. The recap is the artifact the weekend has been missing; the
// scheduled event is a reminder channel that survives closed DMs.
function DiscordMomentsCard({ eventId, phase, draftAt }) {
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const drafted = ["drafting", "matches_live", "settled"].includes(phase);

  async function go(mode) {
    setBusy(mode); setErr(""); setMsg("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/discord-recap"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ eventId, mode }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`);
      setMsg(mode === "event"
        ? (b.updated ? "Event updated to the new draft time." : "Draft night is on the server's event list — people can hit Interested.")
        : `Posted — ${b.teams} rosters, ${b.sold} players.`);
    } catch (e) { setErr(e.message || "Couldn't do that."); }
    setBusy("");
  }

  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Post to Discord" hint="One-tap moments worth sharing" />
      <div style={PANEL()}>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button disabled={!!busy || !drafted} onClick={() => go("recap")}
            title={drafted ? "Every roster, every price, biggest buy and best value"
                           : "Available once the auction has run"}
            style={shellBtn("primary", { padding: "10px 18px", fontSize: 12, opacity: (!drafted || busy) ? 0.5 : 1 })}>
            {busy === "recap" ? "Posting…" : "◈ Post draft results"}
          </button>
          <button disabled={!!busy || !draftAt} onClick={() => go("event")}
            title={draftAt ? "Creates a Discord event people can mark Interested on"
                           : "Set a draft time first"}
            style={shellBtn("ghost", { padding: "10px 18px", fontSize: 12, opacity: (!draftAt || busy) ? 0.5 : 1 })}>
            {busy === "event" ? "Working…" : <><Icon name="calendar" size={15} style={{ marginRight: 6 }} />Add draft night to the server</>}
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)", marginTop: 10, lineHeight: 1.6 }}>
          {drafted ? "The results post shows every roster with what each captain paid, plus the biggest buy and the best value of the night."
                   : "Draft results unlock once the auction has run."}
          {" "}A server event notifies people through Discord itself, which still reaches anyone with DMs closed.
        </div>
        {msg && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {msg}</div>}
        {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// ── Valorant name check ──────────────────────────────────────────────────
// Scoreboard OCR matches stats to players by in-game name. Anyone without one
// gets their scores dropped on the floor — silently, because a failed match
// looks identical to a player who didn't play. Better to catch it before the
// weekend than to reconcile it afterwards.
function IgnCheckCard({ eventId }) {
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    try {
      const { data } = await __sb.rpc("volt_ign_check", { p_event: eventId });
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { console.error("ign check", e); setRows([]); }
  }
  useEffect(() => { load(); }, [eventId]);

  async function nudge() {
    setBusy(true); setErr(""); setMsg("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      const targets = rows.filter((r) => r.discord).map((r) => r.userId);
      if (!targets.length) { setErr("None of them have Discord connected, so I can't reach them."); setBusy(false); return; }
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          communityId: window.__VOLT.communityId,
          message: "**One thing missing from your profile.**\n" +
            "We read match scores off the end-of-game screenshot, and we match them to you by your " +
            "Valorant name. Yours isn't set, so right now your stats would go to nobody and you'd " +
            "score zero season points.\n\nOpen VOLT → your profile → **Valorant name**, and put it in " +
            "exactly as it appears in game (no #tag). Takes ten seconds.",
          userIds: targets, announce: false,
        }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || "Couldn't send.");
      setMsg(`Asked ${b?.delivered ?? targets.length} of them to fix it.`);
    } catch (e) { setErr(e.message || "Couldn't send."); }
    setBusy(false);
  }

  if (rows === null || !rows.length) return null;   // nothing to fix, say nothing
  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Valorant names missing" />
      <div style={PANEL("rgba(245,196,83,0.45)")}>
        <div style={{ fontSize: 13.5, color: "#ffe4a0", fontWeight: 700 }}>
          {rows.length} player{rows.length === 1 ? " hasn't" : "s haven't"} set their Valorant name
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", marginTop: 6, lineHeight: 1.6 }}>
          Scoreboard screenshots are matched to players by in-game name. Without it their stats are
          dropped and they score nothing — and nothing warns you at the time.
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.75)", marginTop: 8 }}>
          {rows.map((r) => r.name).join(", ")}
        </div>
        <button disabled={busy} onClick={nudge}
          style={shellBtn("warn", { padding: "9px 16px", fontSize: 11.5, marginTop: 12, opacity: busy ? 0.5 : 1 })}>
          {busy ? "Sending…" : "◈ Ask them to fix it"}
        </button>
        {msg && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {msg}</div>}
        {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// ── Operator review queue ────────────────────────────────────────────────
// Approving leagues from the Supabase dashboard means finding a row and editing
// a column by hand, on a phone, usually while a tournament is running. This is
// the same job with the context needed to decide and no chance of editing the
// wrong row. Only renders for accounts in platform_admins.
function AdminQueue() {
  const [rows, setRows] = useState(null);
  const [filter, setFilter] = useState("pending");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  async function load() {
    try {
      const { data, error } = await __sb.rpc("volt_admin_leagues",
        { p_status: filter === "all" ? null : filter });
      if (error) throw new Error(error.message);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) { console.error("admin queue", e); setRows([]); }
  }
  useEffect(() => { if (open) load(); }, [open, filter]);

  async function setStatus(id, status) {
    setBusy(id); setErr("");
    try {
      const { error } = await __sb.rpc("volt_admin_set_status", { p_community: id, p_status: status });
      if (error) throw new Error(error.message);
      await load();
    } catch (e) { setErr(e.message || "Couldn't update."); }
    setBusy("");
  }

  const pending = (rows || []).filter((r) => r.status === "pending").length;
  const TONE = { pending: "#f5c453", approved: "#9af5c2", rejected: "#ff8f9a", suspended: "#ff8f9a" };

  return (
    <div style={{ marginTop: 14 }}>
      <CollapseHead title="League requests" open={open} onToggle={() => setOpen((o) => !o)}
        tone={pending > 0 ? "rgba(245,196,83,0.45)" : null}
        hint={rows === null ? "Operator only" : pending > 0
          ? `${pending} waiting on you` : "Nothing waiting"} />
      {open && (
        <div style={{ marginTop: 8, ...PANEL(null, "16px 18px") }}>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
            {["pending", "approved", "all"].map((k) => (
              <button key={k} onClick={() => setFilter(k)}
                style={shellBtn(filter === k ? "primary" : "ghost", { padding: "6px 13px", fontSize: 11 })}>
                {k}
              </button>
            ))}
          </div>

          {rows === null && <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.45)" }}>Loading…</div>}
          {rows?.length === 0 && <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.45)" }}>Nothing here.</div>}

          {(rows || []).map((r) => (
            <div key={r.id} style={{ padding: "13px 0", borderTop: "1px solid rgba(120,150,220,0.12)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span style={{ fontSize: 15, fontWeight: 700, color: "#ecf3ff", textTransform: "uppercase" }}>{r.name}</span>
                <span style={{ fontSize: 10, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700,
                  color: TONE[r.status] || "rgba(200,215,255,0.5)" }}>{r.status}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11, color: "rgba(200,215,255,0.35)" }}>
                  {r.createdAt ? ledgerAgo(r.createdAt) : ""}
                </span>
              </div>
              <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, color: "rgba(200,215,255,0.45)", marginTop: 5 }}>
                {r.slug} · host {r.host || "—"} · {r.members} member{r.members === 1 ? "" : "s"}
                {r.events > 0 ? ` · ${r.events} tournament${r.events === 1 ? "" : "s"}` : ""}
                {r.discord ? " · Discord linked" : ""}
              </div>
              {r.note && (
                <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", marginTop: 7, lineHeight: 1.55,
                  padding: "8px 11px", background: "rgba(10,16,30,0.5)", clipPath: SHELL_NOTCH(6) }}>
                  “{r.note}”
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {r.status !== "approved" && (
                  <button disabled={!!busy} onClick={() => setStatus(r.id, "approved")}
                    style={shellBtn("primary", { padding: "7px 15px", fontSize: 11 })}>
                    {busy === r.id ? "…" : "Approve"}
                  </button>
                )}
                {r.status === "pending" && (
                  <button disabled={!!busy} onClick={() => setStatus(r.id, "rejected")}
                    style={shellBtn("ghost", { padding: "7px 15px", fontSize: 11 })}>Reject</button>
                )}
                {r.status === "approved" && (
                  <button disabled={!!busy} onClick={() => setStatus(r.id, "suspended")}
                    style={shellBtn("danger", { padding: "7px 15px", fontSize: 11 })}>Suspend</button>
                )}
              </div>
            </div>
          ))}
          {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Board gap warning ────────────────────────────────────────────────────
// The auction board is a snapshot. Anyone approved after it was built is
// invisible to the auction, and the only symptom is a pool count being one
// short — which nobody notices at a glance. Say it out loud instead.
//
// The board now merges late registrations when the draft opens, so this is a
// heads-up rather than a chore. It also catches the case that merge can't fix:
// a roster that no longer divides evenly into teams.
function BoardGapCard({ eventId }) {
  const [gap, setGap] = useState(null);
  useEffect(() => {
    let ok = true;
    const load = () => __sb.rpc("volt_board_gap", { p_event: eventId })
      .then(({ data }) => ok && setGap(data)).catch((e) => console.error("board gap", e));
    load();
    const iv = setInterval(load, 30000);
    return () => { ok = false; clearInterval(iv); };
  }, [eventId]);

  if (!gap?.onBoard) return null;
  const missing = gap.missing || [];
  const teams = gap.teams || 0;
  // Draftable only — reserves are cover for the weekend, not auction lots, and
  // the draw skips them. Counting them here reported a surplus that wasn't real.
  const pool = (gap.poolSize || 0) + missing.filter((m) => !m.captain).length;
  const reserves = gap.reserves || 0;
  // Four slots a team is the roster size the auction enforces.
  const slots = teams * 4;
  const short = slots - pool;
  const allGood = !missing.length && short === 0;

  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Draft board check" />
      <div style={PANEL(short !== 0 ? "rgba(245,196,83,0.45)"
                        : allGood ? "rgba(61,220,132,0.3)" : "rgba(120,150,220,0.18)")}>
        {allGood && (
          <div style={{ fontSize: 13, color: "#9af5c2" }}>
            ✓ {pool} draftable for {teams} teams — {teams * 4} slots, an exact fit.
            {reserves > 0 ? ` ${reserves} in reserve as cover.` : ""}
          </div>
        )}
        {missing.length > 0 && (
          <div style={{ fontSize: 13, color: "rgba(200,215,255,0.75)", lineHeight: 1.6 }}>
            <b style={{ color: "#cfe0ff" }}>{missing.map((m) => m.name).join(", ")}</b>{" "}
            {missing.length === 1 ? "was" : "were"} approved after the board was built.
            They'll be added automatically when you open the draft.
          </div>
        )}
        {short !== 0 && (
          <div style={{ fontSize: 13, color: "#ffe4a0", marginTop: missing.length ? 9 : 0, lineHeight: 1.6 }}>
            ⚠ {teams} teams need <b>{slots}</b> players, and the pool has <b>{pool}</b>.
            {short > 0
              ? ` ${short} slot${short === 1 ? "" : "s"} will go unfilled.` +
                (reserves > 0
                  ? ` You have ${reserves} in reserve — move ${Math.min(short, reserves)} back into the draft pool to cover it.`
                  : ` Recruit ${short} more, or drop a captain.`)
              : ` ${-short} player${-short === 1 ? "" : "s"} won't be drafted — add a captain, or move ${-short} to reserves.`}
          </div>
        )}
        {short === 0 && missing.length > 0 && (
          <div style={{ fontSize: 12.5, color: "#9af5c2", marginTop: 9 }}>
            ✓ {pool} draftable for {teams} teams — an exact fit.
            {reserves > 0 ? ` ${reserves} in reserve as cover.` : ""}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub desk ─────────────────────────────────────────────────────────────
// A captain short a player at 9pm shouldn't have to read a list and DM
// strangers. They pick who's out, everyone eligible gets a DM with one button,
// and the captain chooses from whoever offered.
//
// Deliberately not first-come: the point of collecting offers is that the
// captain picks the one who fits the composition, not the one with the fastest
// thumbs. The rank rule (a sub must be strictly LOWER ranked than the player
// going out) is enforced in the database, so a team can never come out of a
// substitution stronger than it went in.
//
// Staff see every team. A captain (team given) sees only their own requests,
// and names the player from the Reserve Hub's "Who can't make it?" picker,
// which arrives here as askFor.
function SubDesk({ eventId, onChanged, team = null, viewerId = null, askFor = null, onAsked, startOpen = false }) {
  const [open, setOpen] = useState(startOpen);
  const [roster, setRoster] = useState([]);
  const [reqs, setReqs] = useState([]);
  const [picking, setPicking] = useState(null);   // userId of the player going out
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  async function load() {
    try {
      const [{ data: open }, { data: ros }] = await Promise.all([
        __sb.rpc("volt_sub_open", { p_event: eventId }),
        __sb.rpc("volt_sub_roster", { p_event: eventId }),
      ]);
      setReqs((Array.isArray(open) ? open : []).filter((r) => !team || r.team === team || r.captainId === viewerId));
      setRoster((Array.isArray(ros) ? ros : []).filter((x) => !team || x.team === team));
    } catch (e) { console.error("sub desk", e); }
  }
  useEffect(() => { if (open) load(); }, [open, eventId]);
  // Offers arrive by Discord, so the picker has to refresh itself or the
  // captain sits looking at an empty list while taps land in the database.
  useEffect(() => {
    if (!open) return;
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [open, eventId]);

  // Close a request nobody can answer, so the player can be asked for again.
  async function cancel(reqId) {
    const { error } = await __sb.rpc("volt_sub_cancel", { p_request: reqId });
    if (error) throw new Error(error.message);
  }

  async function ask(outUserId) {
    setBusy(outUserId); setErr(""); setMsg("");
    let reqId = null;
    try {
      const teamName = team || (roster.find((x) => x.userId === outUserId) || {}).team || "the team";
      const { data, error } = await __sb.rpc("volt_sub_request",
        { p_event: eventId, p_out: outUserId, p_team: teamName });
      if (error) throw new Error(error.message);
      if (data?.error === "already_open") { setErr("There's already an open request for that player."); setPicking(null); setBusy(""); return; }
      reqId = data?.id || null;

      // The server picks who to ask (reserves below this player's rank) and
      // writes the message, so a captain can send it as well as staff. Everyone
      // eligible hears in the app; those with Discord connected get a DM too.
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      const r = await fetch(apiUrl("/api/discord-notify"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ subRequest: reqId }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || "Couldn't send the request.");
      if (!b?.eligible) {
        if (reqId) await cancel(reqId).catch((e) => console.error("sub cancel", e));
        setErr(`No reserve is ranked below ${data?.outRank || "that player"}, so there's no one to ask.`);
        setPicking(null); setBusy(""); load(); return;
      }
      setMsg(`Asked ${b.eligible} reserve${b.eligible === 1 ? "" : "s"}${b.delivered < b.eligible ? ` (${b.delivered} by Discord DM, the rest in the app)` : ""}. Offers show up here.`);
      setPicking(null); load();
    } catch (e) {
      // Nobody was asked, so don't leave a request open that blocks a retry.
      if (reqId) await cancel(reqId).catch((err) => console.error("sub cancel", err));
      setErr(e.message || "Couldn't open the request.");
      setPicking(null); load();
    }
    setBusy("");
  }

  async function fill(reqId, userId) {
    setBusy(userId); setErr(""); setMsg("");
    try {
      const { data, error } = await __sb.rpc("volt_sub_fill", { p_request: reqId, p_user: userId });
      if (error) throw new Error(error.message);
      if (data?.error === "closed") { setErr("That request was already filled."); load(); setBusy(""); return; }
      if (data?.error === "not_offered") { setErr("That player hasn't offered."); setBusy(""); return; }
      setMsg(`${data.name} is subbing in for ${data.team}.`);
      load(); onChanged && onChanged();
    } catch (e) { setErr(e.message || "Couldn't fill it."); }
    setBusy("");
  }

  const waiting = reqs.reduce((n, r) => n + (r.offers?.length || 0), 0);
  useEffect(() => {
    if (!askFor) return;
    setOpen(true); setPicking(askFor); ask(askFor); onAsked && onAsked();
  }, [askFor]); // eslint-disable-line
  // A captain's desk only exists while there's something on it.
  if (team && !reqs.length && !msg && !err && !busy) return null;

  return (
    <div style={{ marginTop: 14 }}>
      <CollapseHead title="Sub desk" open={open} onToggle={() => setOpen((o) => !o)}
        tone={waiting > 0 ? "rgba(61,220,132,0.4)" : reqs.length ? "rgba(245,196,83,0.35)" : null}
        hint={waiting > 0 ? `${waiting} offer${waiting === 1 ? "" : "s"} waiting`
              : reqs.length ? `${reqs.length} open` : "Someone dropped out?"} />
      {open && (
        <div style={{ marginTop: 8, ...PANEL(null, "16px 18px") }}>
          {reqs.map((r) => (
            <div key={r.id} style={{ marginBottom: 14, paddingBottom: 14, borderBottom: "1px solid rgba(120,150,220,0.12)" }}>
              <div style={{ fontSize: 13.5, color: "#ecf3ff", fontWeight: 700 }}>
                Covering for {r.outName} <span style={{ color: "rgba(200,215,255,0.45)", fontWeight: 500 }}>· {r.outRank} · {r.team}</span>
              </div>
              {r.offers?.length ? (
                <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
                  {r.offers.map((o) => (
                    <div key={o.userId} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px",
                      background: "rgba(61,220,132,0.06)", border: "1px solid rgba(61,220,132,0.3)", clipPath: SHELL_NOTCH(7) }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: "#ecf3ff", textTransform: "uppercase" }}>{o.name}</span>
                      <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)" }}>{rankLabel(o.rank, o.rankDiv)}{o.role ? ` · ${o.role}` : ""}</span>
                      <span style={{ flex: 1 }} />
                      <button disabled={!!busy} onClick={() => fill(r.id, o.userId)}
                        style={shellBtn("primary", { padding: "6px 14px", fontSize: 11, opacity: busy ? 0.5 : 1 })}>
                        {busy === o.userId ? "…" : "Pick"}
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "rgba(200,215,255,0.42)", marginTop: 6 }}>
                  Waiting on offers — everyone eligible has been DM'd.
                </div>
              )}
              <button disabled={!!busy} onClick={async () => {
                  if (!(await voltConfirm("Nobody else can offer for it once it's cancelled. You can ask again any time.",
                    { title: `Cancel the sub request for ${r.outName}?`, confirmLabel: "Cancel request", cancelLabel: "Keep it", danger: true }))) return;
                  setBusy(r.id); setErr(""); setMsg("");
                  try { await cancel(r.id); setMsg("Request cancelled."); load(); }
                  catch (e) { setErr(e.message || "Couldn't cancel it."); }
                  setBusy("");
                }}
                style={shellBtn("ghost", { padding: "5px 12px", fontSize: 10.5, marginTop: 8, opacity: busy ? 0.5 : 1 })}>
                {busy === r.id ? "…" : "Cancel request"}
              </button>
            </div>
          ))}

          {picking ? (
            <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)" }}>Opening the request…</div>
          ) : team ? null : (
            <>
              <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", marginBottom: 10, lineHeight: 1.6 }}>
                Who can't make it? Everyone <b style={{ color: "#cfe0ff" }}>below their rank</b> gets asked,
                so the team can't come out stronger than it went in.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {(roster || []).map((p) => (
                  <button key={p.userId} disabled={!!busy}
                    onClick={() => { setPicking(p.userId); ask(p.userId); }}
                    title={`${rankLabel(p.rank, p.rankDiv)}${p.team ? " · " + p.team : ""}`}
                    style={shellBtn("ghost", { padding: "8px 14px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
                    {busy === p.userId ? "…" : p.name}
                    <span style={{ opacity: 0.5, marginLeft: 7, fontSize: 10.5 }}>{p.rank}</span>
                  </button>
                ))}
                {!(roster || []).length && (
                  <span style={{ fontSize: 12, color: "rgba(200,215,255,0.4)" }}>
                    Nobody's been drafted yet — the sub desk opens once the auction has run.
                  </span>
                )}
              </div>
            </>
          )}
          {msg && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {msg}</div>}
          {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// Defined inside DraftApp, this was a NEW component type on every render,
// and the board polls every 1.2s. React sees a different type, unmounts the
// old subtree and mounts a fresh one, so any cell that fetches restarts for
// ever. It closes over nothing, so it belongs at module scope.
// Built on the shared PANEL so a change to the app's surface reaches the
// dashboard too, with the corner bracket and hover lift the rest of the
// product already uses on interactive panels.
function Cell({ title, action, onGo, span = 1, tall = false, tone, art, children }) {
  return (
    <div className="volt-cell" style={{
      ...PANEL(tone, "15px 17px"),
      position: "relative", overflow: "hidden",
      gridColumn: span === "full" ? "1 / -1" : `span ${span}`,
      display: "flex", flexDirection: "column",
      minHeight: tall ? 260 : 156,
      cursor: onGo ? "pointer" : "default",
    }} onClick={onGo || undefined}>
      {/* Optional art, faint and fading out to the left, for cells that have a
          picture to carry rather than only rows. */}
      {art && <img src={art} alt="" aria-hidden style={{ position: "absolute", right: 0, top: 0,
        width: "62%", height: "100%", objectFit: "cover", opacity: 0.13, pointerEvents: "none",
        maskImage: "linear-gradient(90deg, transparent, #000 70%)",
        WebkitMaskImage: "linear-gradient(90deg, transparent, #000 70%)" }} />}
      {/* Angular hatching in the top corner — the texture from the references,
          kept to one corner so it never sits under text. */}
      <span aria-hidden style={{ position: "absolute", right: 0, top: 0, width: 130, height: 86,
        pointerEvents: "none",
        background: "repeating-linear-gradient(135deg, rgba(125,166,255,0.09) 0 1px, transparent 1px 8px)",
        maskImage: "radial-gradient(circle at 100% 0, #000, transparent 72%)",
        WebkitMaskImage: "radial-gradient(circle at 100% 0, #000, transparent 72%)" }} />
      <span aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 9, height: 9,
        borderLeft: `2px solid ${tone || "rgba(61,123,255,0.5)"}`,
        borderTop: `2px solid ${tone || "rgba(61,123,255,0.5)"}` }} />
      <div style={{ position: "relative" }}>
      <SectionHead title={title} right={onGo ? (
        <span style={{ fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: 10,
          letterSpacing: "0.16em", textTransform: "uppercase", color: "#7da6ff", whiteSpace: "nowrap" }}>
          {action || "Open"} →
        </span>
      ) : null} />
      </div>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>{children}</div>
    </div>
  );
}


// ── Dashboard motion + atoms ─────────────────────────────────────────────

// Dashboard motion. Lives with the page, not in the desktop rail's <style>,
// so phones get it too.
const DASH_CSS = `
  @keyframes voltDot { 0%,100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; } 50% { box-shadow: 0 0 0 4px transparent; opacity: .45; } }
  .volt-live-dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: voltDot 1.4s ease-in-out infinite; }
  @keyframes voltSpin { to { transform: rotate(360deg); } }
  .volt-spin { animation: voltSpin 1.1s linear infinite; }
  @keyframes voltColGrow { from { transform: scaleY(0); } to { transform: scaleY(1); } }
  .volt-col { transform-origin: bottom center; animation: voltColGrow .7s cubic-bezier(.2,.8,.2,1) backwards; animation-delay: var(--d, 0ms); }
  @media (prefers-reduced-motion: reduce) { .volt-live-dot, .volt-spin, .volt-col, .volt-rays, .volt-cta-pulse { animation: none !important; } }
  .volt-yc > .volt-cell { flex: 1; }
  .volt-yc-body > :not(:last-child) { margin-right: 44%; }
  @keyframes voltRays { from { background-position: 0 0; } to { background-position: 280px 0; } }
  .volt-rays { animation: voltRays 14s linear infinite; }
  @keyframes voltCta { 0%,100% { box-shadow: 0 0 0 0 rgba(61,123,255,0.55); } 60% { box-shadow: 0 0 0 10px rgba(61,123,255,0); } }
  .volt-cta-pulse { animation: voltCta 2.4s ease-out infinite; }
  @media (max-width: 760px) {
    .volt-yc-body > :not(:last-child) { margin-right: 0; }
    .volt-yc-form { margin-left: 0 !important; }
    .volt-yc-fig, .volt-yc-floor { display: none; }
    /* Your card on a phone: no radar, the numbers in one row, no 460px floor. */
    .volt-yc > .volt-cell { min-height: 0 !important; padding: 20px 18px 18px !important; }
    .volt-yc-radar, .volt-yc-div { display: none !important; }
    .volt-yc-mid { margin: 16px 0 4px !important; }
    .volt-yc-stats { grid-template-columns: repeat(3, minmax(0, auto)); gap: 22px !important; }
    .volt-yc-stats > div > div:first-child { font-size: 28px !important; }
    /* The phase's main card first (on the block, next match, your entry), then yours. */
    .volt-bento > :nth-child(2) { order: -1; }
  }
  @keyframes voltGrow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
  .volt-bar { transform-origin: left center; animation: voltGrow .8s cubic-bezier(.2,.8,.2,1) backwards; animation-delay: var(--d, 0ms); }
  @keyframes voltRise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
  /* backwards, not both: a held end-state would override the hover lift. */
  .volt-bento > * { animation: voltRise .5s cubic-bezier(.2,.8,.3,1) backwards; }
  .volt-bento > *:nth-child(2) { animation-delay: 40ms; }
  .volt-bento > *:nth-child(3) { animation-delay: 80ms; }
  .volt-bento > *:nth-child(4) { animation-delay: 120ms; }
  .volt-bento > *:nth-child(5) { animation-delay: 160ms; }
  .volt-bento > *:nth-child(6) { animation-delay: 200ms; }
  .volt-bento > *:nth-child(7) { animation-delay: 240ms; }
  .volt-bento > *:nth-child(8) { animation-delay: 280ms; }
  @keyframes voltGlow { 0%, 100% { opacity: .25; } 50% { opacity: 1; } }
  .volt-live-glow { position: absolute; inset: 0; pointer-events: none;
    background: radial-gradient(ellipse 70% 120% at 15% 50%, rgba(61,123,255,0.22), transparent 70%);
    animation: voltGlow 2.4s ease-in-out infinite; }
  @keyframes voltShimmer { from { transform: translateX(-120%) skewX(-18deg); } to { transform: translateX(320%) skewX(-18deg); } }
  .volt-shimmer { position: absolute; top: 0; bottom: 0; left: 0; width: 34%; pointer-events: none;
    background: linear-gradient(90deg, transparent, rgba(255,223,154,0.2), transparent);
    animation: voltShimmer 2.4s cubic-bezier(.45,0,.2,1) .4s 1 both; }
  @keyframes voltSkel { from { background-position: -240px 0; } to { background-position: 240px 0; } }
  .volt-skel { background: linear-gradient(90deg, rgba(255,255,255,0.04), rgba(255,255,255,0.1), rgba(255,255,255,0.04));
    background-size: 480px 100%; animation: voltSkel 1.3s linear infinite; }
  .volt-pname { transition: color .15s; }
  .volt-pname:hover, .volt-pname:focus-visible { color: #cfe0ff !important; text-decoration: underline;
    text-underline-offset: 3px; text-decoration-color: rgba(125,166,255,0.55); outline: none; }
  /* Fixed-width digits, so live numbers don't jitter as they change. */
  .volt-bento [style*="IBM Plex Mono"], .volt-bento svg text { font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    .volt-bar, .volt-bento > *, .volt-live-glow, .volt-shimmer, .volt-skel { animation: none !important; }
  }
`;
// Everything here is shared by the dashboard cells so a number, a bar or a
// team mark looks and moves the same wherever it appears.

const prefersReduced = () =>
  typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// Counts a number up from where it last was. Numbers that jump straight to
// their value read as static text; counting says "this was just worked out".
function CountUp({ to, format = (v) => String(Math.round(v)), dur = 900, delay = 0 }) {
  const n = Number(to);
  const ok = to != null && to !== "" && Number.isFinite(n);
  const [v, setV] = useState(() => (ok && !prefersReduced() ? 0 : n));
  const from = useRef(0);
  useEffect(() => {
    if (!ok) return;
    if (prefersReduced()) { setV(n); from.current = n; return; }
    let raf, t0 = null;
    const start = from.current;
    const step = (t) => {
      if (t0 === null) t0 = t + delay;
      const k = Math.min(1, Math.max(0, (t - t0) / dur));
      setV(start + (n - start) * (1 - Math.pow(1 - k, 3)));
      if (k < 1) raf = requestAnimationFrame(step); else from.current = n;
    };
    raf = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(raf); from.current = n; };
  }, [n]);
  if (!ok) return <>{to ?? "—"}</>;
  return <>{format(v)}</>;
}

// A bar that grows in from the left. `i` staggers a list so the bars arrive
// one after another instead of all at once.
function Bar({ pct, h = 3, color, opacity = 1, i = 0, style }) {
  return (
    <div style={{ height: h, background: "rgba(255,255,255,0.05)", ...style }}>
      <div className="volt-bar" style={{ width: `${Math.max(0, Math.min(100, pct || 0))}%`, height: "100%",
        background: color, opacity, "--d": `${140 + i * 70}ms` }} />
    </div>
  );
}

// A shield with the team's initial, in the team's colour. Pips are hexagons
// and mean "position"; shields mean "team", so the two never get confused.
function TeamMono({ name, hue = "#7da6ff", size = 22 }) {
  const ch = (String(name || "?").match(/[A-Za-z0-9]/) || ["?"])[0].toUpperCase();
  return (
    <span aria-hidden style={{ flex: "0 0 auto", width: size, height: size * 1.1,
      display: "grid", placeItems: "center", paddingBottom: size * 0.12,
      clipPath: "polygon(0 0, 100% 0, 100% 68%, 50% 100%, 0 68%)",
      background: `linear-gradient(165deg, ${hue}, ${hue}88)`,
      fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: size * 0.56, lineHeight: 1,
      color: "#0a0d18" }}>{ch}</span>
  );
}

// What a cell says when there's nothing in it yet. A fresh league sees these
// more than anything else, so they explain what will appear rather than
// leaving a blank box.
function Empty({ title, hint, rows = 3, shape = "row" }) {
  // Not an icon-in-a-box with centred copy. The cell keeps the shape of what
  // will fill it: a plain line saying what's missing, then faint placeholder
  // slots in the same layout the real content uses, so the dashboard reads
  // as "waiting" rather than "broken".
  const slot = (i) => {
    const w = [72, 54, 63, 46, 58][i % 5];
    if (shape === "block") return (
      <div key={i} style={{ height: 38, background: "rgba(120,150,220,0.045)", borderLeft: "2px solid rgba(120,150,220,0.12)" }} />
    );
    return (
      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, height: 20 }}>
        <span style={{ width: 16, height: 16, flex: "0 0 auto", background: "rgba(120,150,220,0.07)",
          clipPath: "polygon(0 0, 100% 0, 100% 68%, 50% 100%, 0 68%)" }} />
        <span style={{ height: 7, width: `${w}%`, background: "rgba(120,150,220,0.07)" }} />
        <span style={{ marginLeft: "auto", height: 7, width: 34, background: "rgba(120,150,220,0.05)" }} />
      </div>
    );
  };
  return (
    <div style={{ height: "100%", minHeight: 96, display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 600, color: "rgba(236,243,255,0.78)" }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.45)", marginTop: 4, lineHeight: 1.5, maxWidth: 340 }}>{hint}</div>}
      </div>
      {rows > 0 && <div aria-hidden style={{ display: "grid", gap: 10, marginTop: "auto", maxWidth: 480 }}>
        {Array.from({ length: rows }, (_, i) => slot(i))}
      </div>}
    </div>
  );
}

// ── Dashboard cells ──────────────────────────────────────────────────────

// A numbered pip. Gold and filled for the leader, hollow for everyone else —
// so the eye lands on first place before it reads a single word.
function Pip({ i, hue }) {
  const lead = i === 0;
  return (
    <span style={{ flex: "0 0 auto", width: 19, height: 19, display: "grid", placeItems: "center",
      fontFamily: "'IBM Plex Mono',monospace", fontSize: 10, fontWeight: 700,
      clipPath: "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)",
      background: lead ? (hue || "#f5c453") : "rgba(255,255,255,0.06)",
      color: lead ? "#0a0d18" : "rgba(200,215,255,0.5)" }}>{i + 1}</span>
  );
}

// Each one summarises a rail page in a glance and links into it. They read
// from data the tournament shell already has, so none of them fetch.

// Trophies as a row for the current streak, with the lifetime total beside it.
// A broken streak empties the row but never the number — losing the streak
// shouldn't read as losing the wins.
function TrophyRow({ streak, total }) {
  if (!total) return null;
  const shown = Math.min(streak, 6);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 9, flexWrap: "wrap" }}>
      {shown > 0 && (
        <span style={{ display: "flex", gap: 2 }}>
          {Array.from({ length: shown }, (_, i) => (
            <span key={i} style={{ filter: "drop-shadow(0 0 5px rgba(245,196,83,0.6))", color: "#f5c453", display: "inline-flex" }}><Icon name="trophy" size={15} /></span>
          ))}
          {streak > 6 && (
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11,
              color: "#f5c453", alignSelf: "center", marginLeft: 3 }}>+{streak - 6}</span>
          )}
        </span>
      )}
      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 11,
        color: "rgba(200,215,255,0.45)" }}>
        {total} total{streak > 1 ? ` · ${streak} in a row` : ""}
      </span>
    </div>
  );
}

// The auction's own headline: who cost the most.
// ── Phase cells: registration, draft and match-day ───────────────────────
// Same atoms as the settled dashboard (Cell, CountUp, Bar, TeamMono, PName,
// Empty, FeatureTile, Pip) so every phase reads as one product.

// ── Host console ─────────────────────────────────────────────────────────
// The host page had grown to eleven cards, eight of them always open, all
// shouting equally. Two ideas fix that:
//
//   1. Anything that NEEDS the host floats to the top and is loud. Each of
//      those cards already renders null when there's nothing wrong, so a
//      healthy league shows an empty section and it disappears entirely.
//   2. Everything the bot can do is one context, not six, so it becomes a
//      single panel with tabs instead of six stacked cards.
//
// Tabs are right here and wrong for the alerts: switching between equal tools
// is exactly what tabs are for, but hiding a warning behind one means finding
// it too late.

function HostAlerts({ children }) {
  // Each child hides itself when there's nothing to report, so the heading has
  // to disappear with them. Counting the children doesn't work — an element
  // that renders null is still an element — so measure what actually landed in
  // the DOM and hide the heading when nothing did.
  const body = useRef(null);
  const [any, setAny] = useState(false);
  useEffect(() => {
    const check = () => setAny(!!body.current && body.current.childElementCount > 0);
    check();
    // The cards fetch after mount, so their content appears later.
    const mo = new MutationObserver(check);
    if (body.current) mo.observe(body.current, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [children]);

  return (
    <div style={{ marginTop: any ? 26 : 0 }}>
      {any && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
          <span style={{ ...SEC_LABEL, color: "#f5c453" }}>// Needs you</span>
          <span style={{ flex: 1, height: 1,
            background: "linear-gradient(90deg, rgba(245,196,83,0.35), rgba(245,196,83,0))" }} />
        </div>
      )}
      <div ref={body}>{children}</div>
    </div>
  );
}

// One tab shell, used by the host console and the league boards. Written once
// so the two can't drift into looking like different products.
function TabPanel({ label, tabs }) {
  const live = tabs.filter((t) => t && t.node);
  const [active, setActive] = useState(live[0]?.key || null);
  if (!live.length) return null;
  const current = live.find((t) => t.key === active) || live[0];

  return (
    <div style={{ marginTop: 30 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
        <span style={SEC_LABEL}>// {label}</span>
        {current.hint && (
          <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.4)", fontWeight: 500 }}>
            {current.hint}
          </span>
        )}
        <span style={SEC_RULE} />
      </div>

      {/* Tabs wrap on narrow screens rather than scrolling sideways — a tab you
          have to discover by swiping is a tab nobody finds. */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: -1,
        // Explicit rather than relying on the default: the surrounding column is
        // centred, and a stray text-align or align-items above would otherwise
        // pull the row back to the middle.
        justifyContent: "flex-start", textAlign: "left" }}>
        {live.map((t) => {
          const on = t.key === current.key;
          return (
            <button key={t.key} onClick={() => setActive(t.key)}
              style={{ padding: "9px 16px", fontSize: 11, letterSpacing: "0.16em",
                textTransform: "uppercase", fontWeight: 700,
                fontFamily: "'Rajdhani',sans-serif", cursor: "pointer",
                clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 0 100%)",
                color: on ? "#cfe0ff" : "rgba(200,215,255,0.45)",
                background: on ? "linear-gradient(160deg, rgba(23,32,56,0.95), rgba(12,17,30,0.95))"
                               : "transparent",
                border: `1px solid ${on ? "rgba(61,123,255,0.5)" : "rgba(120,150,220,0.14)"}`,
                borderBottom: on ? "1px solid transparent" : "1px solid rgba(120,150,220,0.14)" }}>
              {t.label}{t.badge ? ` · ${t.badge}` : ""}
            </button>
          );
        })}
      </div>

      <div style={{ padding: "10px 18px 18px",
        background: "linear-gradient(160deg, rgba(17,23,40,0.72), rgba(10,13,22,0.72))",
        border: "1px solid rgba(61,123,255,0.28)", clipPath: SHELL_NOTCH(12) }}>
        {current.node}
      </div>
    </div>
  );
}

const DiscordConsole = ({ tabs }) => <TabPanel label="Discord bot" tabs={tabs} />;

// ── Predictions leaderboard ──────────────────────────────────────────────
// Who calls matches best. Open to the whole league, not just whoever got
// drafted — predicting is how people sitting out a weekend stay in it, and the
// season race already belongs to the players.
//
// Ranked on points rather than accuracy, so it rewards turning up to every
// match: 1 for a correct call, 2 when it was an upset (the winner had under 25%
// of at least 5 picks). Correct calls, then accuracy, break ties. The streak is
// the run of correct calls they're on right now. All of it is worked out in
// volt_pred_standings.
function PredictionBoard({ bare = false }) {
  const [rows, setRows] = useState(null);
  const [all, setAll] = useState(false);
  useEffect(() => {
    let ok = true;
    const load = () => __sb.rpc("volt_pred_standings", { p_community: window.__VOLT.communityId })
      .then(({ data }) => ok && setRows(Array.isArray(data) ? data : []))
      .catch((e) => { console.error("pred standings", e); if (ok) setRows([]); });
    load();
    const stop = visInterval(load, 30000);
    return () => { ok = false; stop(); };
  }, []);

  // Nothing to show until a match has actually finished — an empty table before
  // the first result reads as broken.
  if (!rows?.length) return null;
  const shown = all ? rows : rows.slice(0, 5);
  const me = window.__VOLT?.userId;

  return (
    <div style={{ marginTop: bare ? 0 : 42 }}>
      {!bare && (
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.38em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase" }}>// Predictions</div>
          <div style={{ fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 2, fontFamily: "'Rajdhani',sans-serif" }}>
            Crystal <span style={{ color: "#3d7bff" }}>Ball</span>
          </div>
          <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.4)", marginTop: 5 }}>
            Call the winner before kick-off — anyone in the league can play. Calling an upset counts double.
          </div>
        </div>
      )}
      <div style={{ display: "grid", gap: 6 }}>
        {shown.map((r, i) => {
          const mine = r.userId === me;
          return (
            <div key={r.userId} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px",
              background: i === 0 ? "rgba(245,196,83,0.08)" : mine ? "rgba(61,123,255,0.08)" : "rgba(255,255,255,0.03)",
              border: `1px solid ${i === 0 ? "rgba(245,196,83,0.35)" : mine ? "rgba(61,123,255,0.35)" : "rgba(120,150,220,0.15)"}`,
              clipPath: SHELL_NOTCH(8) }}>
              <span style={{ width: 24, fontFamily: "'IBM Plex Mono',monospace", fontSize: 13,
                color: i === 0 ? "#f5c453" : "rgba(200,215,255,0.4)" }}>{i + 1}</span>
              <span style={{ flex: 1, minWidth: 0, fontWeight: 700, textTransform: "uppercase",
                fontFamily: "'Rajdhani',sans-serif", fontSize: 15,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.name}
                {/* Predicting is open to the whole Discord, account or not. The
                    badge is a nudge, not a demotion — they're on the board. */}
                {r.guest && <span style={{ fontSize: 9.5, letterSpacing: "0.14em", marginLeft: 8,
                  color: "rgba(200,215,255,0.35)" }}>GUEST</span>}
              </span>
              {r.streak >= 3 && <span title={`${r.streak} correct calls in a row`}
                style={{ fontSize: 12.5, fontWeight: 700, color: "#ffb454", whiteSpace: "nowrap" }}>🔥 {r.streak}</span>}
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "rgba(200,215,255,0.45)", whiteSpace: "nowrap" }}
                title={r.upsets > 0 ? `${r.upsets} of those were upsets, worth double` : undefined}>
                {r.hit}/{r.total}{r.upsets > 0 ? ` · ⚡${r.upsets}` : ""}
              </span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700,
                color: i === 0 ? "#f5c453" : "#00e5ff", minWidth: 58, textAlign: "right", whiteSpace: "nowrap" }}>
                {r.pts ?? r.hit}<span style={{ fontSize: 10.5, fontWeight: 500, opacity: 0.7 }}> pts</span>
              </span>
            </div>
          );
        })}
      </div>
      {rows.length > 5 && (
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <button onClick={() => setAll((a) => !a)} style={shellBtn("ghost", { padding: "7px 16px", fontSize: 11 })}>
            {all ? "Show top 5" : `Show all ${rows.length}`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Transactions ledger ──────────────────────────────────────────────────
// A public feed of every roster change. All of this already happened somewhere
// in the app, but scattered across the auction board, the roster page and the
// host's approval queue — so nothing answered "what changed since I looked?".
//
// Entries are written by DB triggers and inside volt_sell, not from here. Three
// code paths change registrations (web app, Discord bot, host review), and
// client-side logging would have silently missed two of them.
const LEDGER_KINDS = {
  DRAFTED:        { label: "Drafted",    hue: "#3ddc84", verb: (e) => `→ ${e.team_name}` },
  UNDRAFTED:      { label: "Released",   hue: "#ff8f9a", verb: (e) => (e.team_name ? `from ${e.team_name}` : "") },
  SUB_IN:         { label: "Sub in",     hue: "#00e5ff", verb: (e) => (e.team_name ? `→ ${e.team_name}` : "") },
  TRADE:          { label: "Trade",      hue: "#9d6bff", verb: (e) => e.detail || "" },
  CAPTAIN:        { label: "Captain",    hue: "#f5c453", verb: () => "is captaining this tournament" },
  UNCAPTAIN:      { label: "Stepped down", hue: "rgba(200,215,255,0.5)", verb: () => "is no longer captain" },
  APPLIED:        { label: "Applied",    hue: "#5b8dff", verb: () => "wants in" },
  APPROVED:       { label: "Approved",   hue: "#3ddc84", verb: () => "is in the pool" },
  REJECTED:       { label: "Declined",   hue: "#ff8f9a", verb: () => "" },
  WITHDREW:       { label: "Withdrew",   hue: "#f5c453", verb: () => "" },
  NO_SHOW:        { label: "No-show",    hue: "#ff8f9a", verb: () => "didn't turn up" },
  STRIKE_CLEARED: { label: "Strike lifted", hue: "#3ddc84", verb: () => "" },
  WON:            { label: "Won",        hue: "#f5c453", verb: (e) => (e.team_name ? `with ${e.team_name}` : "") },
  SETTLED:        { label: "Settled",    hue: "#f5c453", verb: (e) => e.detail || "" },
  TEAM_CREATED:   { label: "New team",   hue: "#00e5ff", verb: (e) => e.team_name || "" },
  NOTE:           { label: "Note",       hue: "rgba(200,215,255,0.5)", verb: (e) => e.detail || "" },
};
function ledgerAgo(d) {
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function LeagueLedger({ onOpenPlayer, bare = false }) {
  const PAGE = 8;
  const [rows, setRows] = useState(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load(before) {
    try {
      const { data, error } = await __sb.rpc("volt_ledger", { p_limit: PAGE + 1, p_before: before || null });
      if (error) throw new Error(error.message);
      const page = data || [];
      setMore(page.length > PAGE);
      const keep = page.slice(0, PAGE);
      setRows((prev) => (before ? [...(prev || []), ...keep] : keep));
    } catch (e) {
      console.error("ledger", e);
      setRows((prev) => prev || []);
    }
  }
  useEffect(() => { load(); }, []);

  if (rows === null) return null;           // stay invisible until we know
  if (!rows.length) return null;            // a brand-new league has no history

  return (
    <div style={{ marginTop: bare ? 0 : 42 }}>
      {!bare && <SectionHead title="Transactions" hint="Every roster move, newest first" />}
      <div style={PANEL(null, "6px 4px")}>
        {rows.map((e, i) => {
          const k = LEDGER_KINDS[e.kind] || LEDGER_KINDS.NOTE;
          const clickable = !!e.subject_user_id && !!onOpenPlayer;
          return (
            <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 14px",
              borderTop: i ? "1px solid rgba(120,150,220,0.09)" : "none" }}>
              {/* Fixed-width kind column, so the eye can scan one edge instead
                  of chasing labels that start at different places. */}
              <span style={{ flex: "0 0 96px", fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase",
                fontWeight: 700, color: k.hue, fontFamily: "'Rajdhani',sans-serif", overflow: "hidden",
                textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{k.label}</span>
              <span onClick={clickable ? () => onOpenPlayer(e.subject_user_id) : undefined}
                style={{ fontSize: 13.5, fontWeight: 700, color: "#ecf3ff", textTransform: "uppercase",
                  letterSpacing: "0.02em", cursor: clickable ? "pointer" : "default", whiteSpace: "nowrap" }}>
                {e.subject_name || "—"}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: "rgba(200,215,255,0.5)",
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {k.verb(e)}
              </span>
              {e.amount != null && (
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12.5, fontWeight: 700, color: "#9af5c2" }}>
                  {fmt(e.amount)}
                </span>
              )}
              <span style={{ flex: "0 0 auto", fontFamily: "'IBM Plex Mono',monospace", fontSize: 11,
                color: "rgba(200,215,255,0.3)", minWidth: 30, textAlign: "right" }}>{ledgerAgo(e.created_at)}</span>
            </div>
          );
        })}
      </div>
      {more && (
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <button disabled={busy} onClick={async () => {
            setBusy(true); await load(rows[rows.length - 1]?.created_at); setBusy(false);
          }} style={shellBtn("ghost", { padding: "7px 16px", fontSize: 11 })}>
            {busy ? "…" : "Show more"}
          </button>
        </div>
      )}
    </div>
  );
}

function DiscordConnectBanner() {
  const linked = useDiscordLinked();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  if (linked !== false) return null;   // null = still loading, true = done
  async function connect() {
    setBusy(true); setErr("");
    try { await startDiscordOAuth(); }
    catch (e) { setErr(e.message || "Couldn't start."); setBusy(false); }
  }
  return (
    <div style={{ marginBottom: 20, padding: "17px 20px", display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap",
      background: "linear-gradient(160deg, rgba(245,196,83,0.1), rgba(18,16,11,0.75))",
      border: "1px solid rgba(245,196,83,0.5)", clipPath: SHELL_NOTCH(12), boxShadow: "0 0 30px rgba(245,196,83,0.1)" }}>
      <div style={{ flex: "1 1 340px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 7 }}>
          <span style={{ ...SEC_LABEL, color: "#f5c453" }}>// Connect Discord</span>
          <span style={{ flex: 1, minWidth: 12, height: 1, background: "linear-gradient(90deg, rgba(245,196,83,0.35), rgba(245,196,83,0))" }} />
        </div>
        <div style={{ fontSize: 15.5, fontWeight: 700, color: "#ffe4a0", lineHeight: 1.3 }}>
          You won't get draft reminders until you connect Discord
        </div>
        <div style={{ fontSize: 12.5, color: "rgba(200,215,255,0.6)", marginTop: 6, lineHeight: 1.65 }}>
          VOLT messages you the day before to check you're still free, 30 minutes before the draft,
          and again when you find out your team. Without this you get none of it — and your captain can't reach you.
        </div>
        {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {err}</div>}
      </div>
      <button disabled={busy} onClick={connect}
        style={shellBtn("warn", { padding: "13px 22px", fontSize: 12.5, whiteSpace: "nowrap",
          background: "linear-gradient(180deg,#f5c453,#d9a52e)", borderColor: "rgba(255,228,160,0.65)",
          color: "#171104", boxShadow: "0 0 22px rgba(245,196,83,0.32)", opacity: busy ? 0.5 : 1 })}>
        {busy ? "…" : "◈ Connect Discord"}
      </button>
    </div>
  );
}

function DiscordLinkCard() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [linked, setLinked] = useState(null);
  const [code, setCode] = useState(null);       // fallback if OAuth is unavailable

  async function load() {
    if (!HAS_SUPABASE || !window.__VOLT?.userId) return;
    try {
      const { data } = await __sb.from("player_contacts").select("discord_user_id")
        .eq("user_id", window.__VOLT.userId).eq("community_id", window.__VOLT.communityId).maybeSingle();
      setLinked(!!data?.discord_user_id);
    } catch { setLinked(false); }
  }
  useEffect(() => { load(); }, []);

  // One click: hand Discord a signed token identifying this VOLT account, let
  // them approve, come back linked. The old code flow lost half the people who
  // started it — too many steps across two apps.
  async function connect() {
    setBusy(true); setErr("");
    try { await startDiscordOAuth(); }
    catch (e) { setErr(e.message || "Couldn't start."); setBusy(false); }
  }

  // Kept for anyone whose browser blocks the redirect, or who'd rather type.
  async function getCode() {
    setBusy(true); setErr("");
    try {
      const { data, error } = await __sb.rpc("volt_discord_link_code");
      if (error) throw new Error(error.message);
      setCode(data);
    } catch (e) { setErr(e.message || "Couldn't get a code."); }
    setBusy(false);
  }

  return (
    <div style={{ marginTop: 20 }}>
      <SectionHead title="Discord" />
      <div style={{ ...PANEL(linked ? "rgba(61,220,132,0.3)" : "rgba(245,196,83,0.45)"),
        background: linked ? "linear-gradient(160deg, rgba(17,23,40,0.72), rgba(10,13,22,0.72))" : "rgba(245,196,83,0.07)" }}>
        {linked ? (
          <div style={{ fontSize: 12.5, color: "#9af5c2" }}>✓ Connected — you'll get a DM when the draft is set and when matches go up.</div>
        ) : (
          <>
            {/* Say what they lose by skipping this, or it reads as optional and
                gets skipped — which is exactly what happened in testing. */}
            <div style={{ fontSize: 13, fontWeight: 700, color: "#ffe4a0", marginBottom: 4 }}>
              You won't get draft reminders until you connect Discord
            </div>
            <div style={{ fontSize: 12, color: "rgba(200,215,255,0.6)", marginBottom: 12, lineHeight: 1.6 }}>
              VOLT messages you the day before to check you're still free, 30 minutes before the draft,
              and again when you find out your team. Without this, you get none of it.
            </div>
            <button disabled={busy} onClick={connect}
              style={shellBtn("primary", { padding: "10px 18px", fontSize: 12.5, opacity: busy ? 0.5 : 1 })}>
              {busy ? "…" : "Connect Discord"}
            </button>
            {code ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.55)", marginBottom: 6 }}>
                  Or type this in your league's Discord:
                </div>
                <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, fontWeight: 700, color: "#ecf3ff",
                  padding: "9px 12px", background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.35)" }}>
                  /link code:{code}
                </div>
                <div style={{ fontSize: 11, color: "rgba(200,215,255,0.4)", marginTop: 6 }}>Expires in 15 minutes.</div>
              </div>
            ) : (
              <button onClick={getCode} style={{ display: "block", marginTop: 10, background: "none", border: "none",
                padding: 0, color: "rgba(200,215,255,0.5)", fontSize: 11.5, textDecoration: "underline", cursor: "pointer",
                fontFamily: "'Rajdhani',sans-serif" }}>
                Trouble connecting? Use a code instead
              </button>
            )}
          </>
        )}
        {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// Host-facing: send a message to everyone registered for this tournament. DMs go to
// anyone who linked Discord; the rest are named back so the host knows who was
// missed rather than assuming everyone got it.
// Host-only: connect this league to a Discord server. Two IDs, copied out of
// Discord with Developer Mode on. Deliberately collapsed by default — it's a
// once-ever setup step, not something to look at every tournament.
function StaffPanel({ onOpenPlayer }) {
  const [rows, setRows] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [err, setErr] = useState("");
  const [open, setOpen] = useState(false);

  async function load() {
    if (!HAS_SUPABASE) return;
    try {
      const { data } = await __sb.from("users")
        .select("id, display_name, role")
        .eq("community_id", window.__VOLT.communityId)
        .order("display_name");
      setRows(data || []);
    } catch (e) { console.error("staff", e); setRows([]); }
  }
  useEffect(() => { if (open && rows === null) load(); }, [open]);

  // Hand the league over and step down, in one server-side transaction. Typing
  // the name is deliberate friction: this is the one action the outgoing host
  // can't reverse on their own — only the new owner can give it back.
  async function transferOwnership(u) {
    const name = u.display_name || "this player";
    // The confirm button stays disabled until the name matches.
    const typed = await voltPrompt(
      `They become the host with full control. You become a moderator — you keep ` +
      `approvals, brackets and scores, but you can no longer settle or delete tournaments, ` +
      `run the auction, or change roles. Only ${name} can give it back.\n\n` +
      `Type their name to confirm:`,
      { title: `Transfer ownership to ${name}?`, match: name, confirmLabel: "Transfer ownership", danger: true });
    if (typed === null) return;
    if (typed.trim().toLowerCase() !== name.trim().toLowerCase()) {
      setErr("That name didn't match — nothing changed.");
      return;
    }
    setBusyId(u.id); setErr("");
    try {
      const { error } = await __sb.rpc("volt_transfer_ownership", { p_to: u.id });
      if (error) throw new Error(error.message || "Could not transfer ownership.");
      // Every permission on screen has just changed for this account, so reload
      // rather than trying to re-derive half the app's gating in place.
      window.location.reload();
    } catch (e) {
      setErr(e.message || "Could not transfer ownership.");
      setBusyId(null);
    }
  }

  async function setRole(u, next) {
    setBusyId(u.id); setErr("");
    try {
      const { error } = await __sb.from("users").update({ role: next }).eq("id", u.id);
      // The database refuses to leave a league without a host — pass that
      // message straight through instead of a raw constraint error.
      if (error) throw new Error(error.message || "Could not change that role.");
      if (next === "moderator" || next === "host") await notifyRole(u.id, next);
      await load();
    } catch (e) { setErr(e.message || "Could not change that role."); }
    setBusyId(null);
  }

  const mods = (rows || []).filter(r => r.role === "moderator").length;
  return (
    <div style={{ marginTop: 14 }}>
      <CollapseHead title="Staff" open={open} onToggle={() => setOpen(o => !o)}
        tone={mods > 0 ? "rgba(61,220,132,0.28)" : "rgba(120,150,220,0.18)"}
        hint={mods > 0 ? `${mods} moderator${mods === 1 ? "" : "s"} helping out` : "Appoint someone to help run tournaments"} />
      {open && (
        <div style={{ marginTop: 8, ...PANEL(null, "16px 18px") }}>
          <p style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)", margin: "0 0 12px" }}>
            Moderators can approve players, assign captains, build brackets and report scores. They can't run the live auction, settle or delete a tournament, or change roles.
          </p>
          {rows === null && <p className="vg-loading">// Loading…</p>}
          {rows && rows.length === 0 && <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.45)", margin: 0 }}>Nobody has joined yet.</p>}
          <div style={{ display: "grid", gap: 6 }}>
            {(rows || []).map(u => {
              const isOwner = u.role === "host";
              const isMod = u.role === "moderator";
              return (
                <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "9px 12px",
                  background: "rgba(255,255,255,0.03)", border: `1px solid ${isMod ? "rgba(61,220,132,0.3)" : "rgba(120,150,220,0.14)"}`, clipPath: SHELL_NOTCH(6) }}>
                  <span onClick={() => onOpenPlayer && onOpenPlayer(u.id)} title="View player profile"
                    style={{ flex: 1, minWidth: 120, fontWeight: 700, textTransform: "uppercase", fontSize: 13, cursor: "pointer" }}>{u.display_name || "Player"}</span>
                  <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700,
                    color: isOwner ? "#f5c453" : isMod ? "#9af5c2" : "rgba(200,215,255,0.4)" }}>
                    {isOwner ? "Host" : isMod ? "Moderator" : "Player"}
                  </span>
                  {!isOwner && (
                    <button disabled={busyId === u.id} onClick={() => setRole(u, isMod ? "player" : "moderator")}
                      style={shellBtn(isMod ? "danger" : "accent", { padding: "6px 11px", fontSize: 10.5, opacity: busyId === u.id ? 0.5 : 1 })}>
                      {busyId === u.id ? "…" : isMod ? "Remove" : "Make moderator"}
                    </button>
                  )}
                  {!isOwner && (
                    <button disabled={busyId === u.id}
                      onClick={async () => { if (await voltConfirm(
                        `They get full control: settling and deleting tournaments, resetting the auction, league settings, and changing anyone's role — including yours.\n\n` +
                        `You stay a host too. Do this before handing the league over, since a league can't be left without one.`,
                        { title: `Make ${u.display_name || "this player"} a host?`, confirmLabel: "Make host", danger: true }
                      )) setRole(u, "host"); }}
                      title="Give this player full control of the league"
                      style={shellBtn("ghost", { padding: "6px 11px", fontSize: 10.5, opacity: busyId === u.id ? 0.5 : 1 })}>
                      Make host
                    </button>
                  )}
                  {!isOwner && (
                    <button disabled={busyId === u.id} onClick={() => transferOwnership(u)}
                      title="Hand the league over and step down to moderator"
                      style={shellBtn("danger", { padding: "6px 11px", fontSize: 10.5, opacity: busyId === u.id ? 0.5 : 1 })}>
                      Transfer ownership
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
        </div>
      )}
    </div>
  );
}

// ── Onboarding checklists ────────────────────────────────────────────────
// One visual language for "here's what's left": a short list that ticks
// itself off from real data and disappears once everything's done.
function ChecklistCard({ eyebrow, title, steps, cta, footer, tone = "#3d7bff", onHide }) {
  const done = steps.filter((s) => s.done).length;
  return (
    <div style={{ position: "relative", overflow: "hidden", marginBottom: 14, padding: "18px 20px", background: `linear-gradient(160deg, ${tone}14, rgba(10,13,22,0.85))`,
      border: `1px solid ${tone}66`, clipPath: SHELL_NOTCH(12), boxShadow: `0 0 30px ${tone}14` }}>
      {/* The dashboard cells' chrome: hatching in one corner, a bracket in the other. */}
      <span aria-hidden style={{ position: "absolute", right: 0, top: 0, width: 150, height: 96, pointerEvents: "none",
        background: `repeating-linear-gradient(135deg, ${tone}1a 0 1px, transparent 1px 8px)`,
        maskImage: "radial-gradient(circle at 100% 0, #000, transparent 72%)", WebkitMaskImage: "radial-gradient(circle at 100% 0, #000, transparent 72%)" }} />
      <span aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 10, height: 10, borderLeft: `2px solid ${tone}`, borderTop: `2px solid ${tone}` }} />
      <div style={{ position: "relative" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
        <span style={{ ...SEC_LABEL, color: tone }}>{eyebrow}</span>
        <span style={{ flex: 1, minWidth: 12, height: 1, background: `linear-gradient(90deg, ${tone}55, transparent)` }} />
        <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "rgba(200,215,255,0.55)" }}>{done}/{steps.length}</span>
      </div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#ecf3ff", marginBottom: 12 }}>{title}</div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.06)", marginBottom: 14 }}>
        <div style={{ height: "100%", width: `${(done / steps.length) * 100}%`, background: tone, transition: "width .4s ease" }} />
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {steps.map((s) => (
          <div key={s.k} style={{ display: "flex", alignItems: "center", gap: 12, opacity: s.done ? 0.55 : 1 }}>
            <span style={{ width: 22, height: 22, flexShrink: 0, display: "grid", placeItems: "center", borderRadius: "50%", fontSize: 11, fontWeight: 700,
              background: s.done ? "#3ddc84" : "transparent", color: s.done ? "#06210f" : tone, border: `1px solid ${s.done ? "#3ddc84" : tone + "88"}` }}>{s.done ? "✓" : ""}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#ecf3ff", textDecoration: s.done ? "line-through" : "none" }}>{s.label}</div>
              {s.sub && !s.done && <div style={{ fontFamily: READ_FONT, fontSize: 13, lineHeight: 1.4, color: "rgba(214,226,255,0.74)", marginTop: 2 }}>{s.sub}</div>}
            </div>
            {!s.done && s.action}
          </div>
        ))}
      </div>
      {(cta || onHide || footer) && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
          {cta}
          {footer}
          {onHide && <button onClick={onHide} style={{ marginLeft: "auto", background: "none", border: "none", color: "rgba(200,215,255,0.4)", fontSize: 12, cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>Hide checklist</button>}
        </div>
      )}
      </div>
    </div>
  );
}

// Players: everything between "joined the league" and "in the draft pool".
// Mirrors the requirements volt_apply / the profile form enforce.
function MatchReadyCard({ prof, ev, myReg, susp, onOpenProfile, onChanged }) {
  const [flow, setFlow] = useState(null);   // FirstTimeOnboard start phase, when open
  if (!prof || susp > 0) return null;
  const profileOk = !!(prof.ign && prof.rank && prof.role);
  const discordOk = !!(prof.linked || prof.discord);
  const waOk = !!prof.whatsapp;
  const steps = [
    { k: "profile", label: "Scouting profile", sub: "Valorant name, rank and role — captains bid off this", done: profileOk },
    { k: "discord", label: "Connect Discord", sub: "So the bot can DM you reminders and your team", done: discordOk },
    { k: "wa", label: "WhatsApp number", sub: "Only staff see it, and only if Discord fails", done: waOk },
  ];
  // Sign-ups never close before the tournament is settled: after registration
  // they go to the reserve pool instead of the draft (volt_apply decides).
  const regOpen = ev && LATE_SIGNUP_PHASES.includes(ev.phase);
  // A rejected application isn't something a button can fix, so it isn't a step.
  if (regOpen && !(myReg && myReg.status === "rejected")) {
    steps.push({ k: "reg", label: ev.phase === "registration_open" ? `Sign up for ${weekendName(ev)}` : `Join ${weekendName(ev)} as a reserve`,
      sub: ev.phase !== "registration_open" ? "The draft pool is closed — you'd be a reserve, on call as a sub" : "One tap once your profile is done",
      done: !!myReg });
  }
  if (steps.every((s) => s.done)) return null;
  const ready = profileOk && discordOk && waOk;
  const cta = regOpen && !myReg
    ? { label: ready ? `Sign up for ${weekendName(ev)} →` : "Get match-ready →", go: () => setFlow(ready ? "terms" : "intro") }
    : { label: "Finish my profile →", go: onOpenProfile };
  return (
    <>
      <ChecklistCard eyebrow="// Get match-ready" tone="#3ddc84"
        title={ready ? "One step left — sign up for the tournament" : "A few things before captains can draft you"}
        steps={steps}
        cta={<button onClick={cta.go} style={shellBtn("primary", { padding: "11px 20px", fontSize: 12.5 })}>{cta.label}</button>}
        footer={!ready && <span style={{ fontFamily: READ_FONT, fontSize: 13, lineHeight: 1.4, color: "rgba(214,226,255,0.74)" }}>Takes about two minutes. A tracker screenshot fills in most of it.</span>} />
      {flow && <FirstTimeOnboard ev={ev} wantCap={false} startPhase={flow} onClose={() => setFlow(null)} onApplied={onChanged} />}
    </>
  );
}

// Hosts: the first-run path from "approved" to "first draft". Each step checks
// the real state, so it ticks itself off however the host gets there.
function HostSetupChecklist({ community, events, current, onCreate, onSetDraftTime, onPickCaptains, onDiscord }) {
  const [st, setSt] = useState(null);
  const hideKey = `volt.hostSetupHidden.${community?.id}`;
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(hideKey) === "1"; } catch { return false; } });
  useEffect(() => {
    if (!HAS_SUPABASE || !community?.id || hidden) return;
    let ok = true;
    (async () => {
      try {
        const [{ count: members }, { data: dc }, caps] = await Promise.all([
          __sb.from("users").select("id", { count: "exact", head: true }).eq("community_id", community.id),
          __sb.rpc("volt_get_discord"),
          current ? __sb.from("registrations").select("id", { count: "exact", head: true })
            .eq("event_id", current.id).eq("is_captain", true).eq("status", "approved") : Promise.resolve({ count: 0 }),
        ]);
        if (ok) setSt({ members: members || 0, discord: !!dc?.guild, captains: caps?.count || 0 });
      } catch (e) { console.error("host checklist", e); }
    })();
    return () => { ok = false; };
  }, [community?.id, current?.id, current?.draft_at, events?.length, hidden]);
  if (hidden || !st) return null;
  const link = `${siteOrigin()}/?join=${community?.slug || ""}`;
  const small = (label, onClick, disabled) => (
    <button disabled={disabled} onClick={onClick} style={shellBtn("ghost", { padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap", opacity: disabled ? 0.4 : 1 })}>{label}</button>
  );
  const steps = [
    { k: "invite", label: "Invite your players", sub: "Share the link — it fills in the join code for them",
      done: st.members >= 2, action: <CopyButton text={link} label="Copy invite link" style={shellBtn("accent", { padding: "6px 12px", fontSize: 11, whiteSpace: "nowrap" })} /> },
    { k: "discord", label: "Connect your Discord server", sub: "Reminders, sign-ups and team DMs run through the bot",
      done: st.discord, action: small("Set up →", onDiscord) },
    { k: "event", label: "Create your first tournament", sub: "Opens sign-ups and notifies everyone",
      done: (events || []).length > 0, action: small("Create →", onCreate) },
    { k: "time", label: "Set the draft time", sub: current ? "Players see a countdown, and the bot reminds them" : "Create a tournament first",
      done: !!current?.draft_at, action: small("Set time →", onSetDraftTime, !current) },
    { k: "caps", label: "Pick at least two captains", sub: current ? "Each captain becomes a team with a $10,000 budget" : "Create a tournament first",
      done: st.captains >= 2, action: small("Pick →", onPickCaptains, !current) },
  ];
  if (steps.every((s) => s.done)) return null;
  return (
    <ChecklistCard eyebrow="// Set up your league" title="Get your first draft running" steps={steps}
      onHide={() => { try { localStorage.setItem(hideKey, "1"); } catch { /* ignore */ } setHidden(true); }} />
  );
}

// First time someone opens the app in a new role: what they can do now.
// Shown once per role (per tournament, for captains).
function RoleWelcome({ userId, isModerator, captainEv, onWarRoom }) {
  const key = captainEv ? `volt.seen.captain.${userId}.${captainEv.id}` : isModerator ? `volt.seen.mod.${userId}` : null;
  const [seen, setSeen] = useState(() => { try { return !key || localStorage.getItem(key) === "1"; } catch { return true; } });
  useEffect(() => { try { setSeen(!key || localStorage.getItem(key) === "1"); } catch { setSeen(true); } }, [key]);
  if (seen || !key) return null;
  const dismiss = () => { try { localStorage.setItem(key, "1"); } catch { /* ignore */ } setSeen(true); };
  const cap = !!captainEv;
  const items = cap ? [
    "You lead a team with a $10,000 budget and 4 picks — you're not in the auction yourself.",
    "Plan your picks in the Mock Draft before the night; nobody else can see it.",
    "When the draft opens, bid from the Auction Block. Your limit always leaves room to fill your roster.",
    "If a player drops out after the draft, request a sub from the Sub desk.",
  ] : [
    "Approve or reject applications and pick captains for each tournament.",
    "Build brackets, set match times and report scores and player stats.",
    "The host still settles and deletes tournaments, runs the live auction and changes roles.",
  ];
  return (
    <div style={{ marginBottom: 20, padding: "18px 20px", background: "linear-gradient(160deg, rgba(245,196,83,0.1), rgba(10,13,22,0.85))",
      border: "1px solid rgba(245,196,83,0.5)", clipPath: SHELL_NOTCH(12) }}>
      <div style={{ ...SEC_LABEL, color: "#f5c453", marginBottom: 6 }}>{cap ? "// You're a captain" : "// You're a moderator"}</div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#ecf3ff", marginBottom: 10 }}>
        {cap ? `You're captaining ${weekendName(captainEv)}` : "Here's what you can do now"}
      </div>
      <div style={{ display: "grid", gap: 7 }}>
        {items.map((t, i) => (
          <div key={i} style={{ display: "flex", gap: 10, fontSize: 13.5, lineHeight: 1.5, color: "rgba(214,226,255,0.85)" }}>
            <span style={{ color: "#f5c453" }}>◆</span><span>{t}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 14, flexWrap: "wrap" }}>
        {cap && onWarRoom && <button onClick={() => { dismiss(); onWarRoom(); }} style={shellBtn("primary", { padding: "10px 18px", fontSize: 12 })}>Open the Mock Draft →</button>}
        <button onClick={dismiss} style={shellBtn("ghost", { padding: "10px 18px", fontSize: 12 })}>Got it</button>
      </div>
    </div>
  );
}

// Lives out here because its entrance animation restarts whenever it remounts: as
// a const inside WeekendSchedule it was a new component on every render, so the
// heading replayed its rise each time a piece of the page finished loading.
const PageHead = ({ league, title, sub, accent = "#3d7bff", right }) => (
  <div style={{ position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16, flexWrap: "wrap",
    padding: "4px 2px 20px", marginBottom: 20, borderBottom: "1px solid rgba(120,150,220,0.16)" }}>
    <div style={{ minWidth: 0, animation: "voltRise .4s backwards" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: accent, fontWeight: 700 }}>// {league}</div>
      <div style={{ fontSize: "clamp(32px, 4.2vw, 48px)", fontWeight: 700, textTransform: "uppercase", lineHeight: 0.95, marginTop: 8, letterSpacing: "0.01em", textShadow: `0 0 34px ${accent}40` }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5, color: "rgba(200,215,255,0.55)", marginTop: 9, maxWidth: 640, lineHeight: 1.5 }}>{sub}</div>}
    </div>
    {right}
    <span aria-hidden style={{ position: "absolute", left: 0, bottom: -1, width: 90, height: 2, background: accent, boxShadow: `0 0 12px ${accent}` }} />
  </div>
);

function WeekendSchedule({ community, isHost, isTrueHost, account, onSignOut, onEnter, openProfile, onProfileOpened }) {
  const [events, setEvents] = useState(null);
  // Platform operators see the league review queue below their own league.
  const [isOperator, setIsOperator] = useState(false);
  useEffect(() => {
    if (!HAS_SUPABASE) return;
    let ok = true;
    __sb.rpc("is_platform_admin").then(({ data }) => ok && setIsOperator(!!data))
      .catch(() => {});
    return () => { ok = false; };
  }, []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [season, setSeason] = useState(null); // aggregated captain standings across tournaments
  const [board, setBoard] = useState(null);   // player points leaderboard (match_results)
  const [live, setLive] = useState(null);     // { count, mine } — registrations for the current tournament
  // The league hub is a set of pages (the rail picks one), not one long scroll.
  const HUB_PAGES = ["overview", "season", "tournaments", "discord", "staff", "account"];
  const [page, setPageRaw] = useState(() => { try { const v = sessionStorage.getItem("volt_hub_page"); return HUB_PAGES.includes(v) ? v : "overview"; } catch { return "overview"; } });
  const setPage = (v) => {
    setPageRaw(v); setShowPlayer(null);
    try { sessionStorage.setItem("volt_hub_page", v); } catch {}
    window.scrollTo({ top: 0 });
  };
  const openAccount = () => setPage("account");
  const [hubMoreOpen, setHubMoreOpen] = useState(false);
  const [editTime, setEditTime] = useState(false);
  const [draftAtDraft, setDraftAtDraft] = useState(null); // controlled value for the draft-time picker
  const [setupWeekend, setSetupWeekend] = useState(null); // { mode:"create"|"edit", ev }
  const [myRegs, setMyRegs] = useState({});   // eventId → my registration row (open tournaments)
  const [pendingByEvent, setPendingByEvent] = useState({}); // host: eventId → # awaiting review
  const [myProf, setMyProf] = useState(null); // rank/role — gates the play toggle
  const [mySusp, setMySusp] = useState(0);
  const [myStrikes, setMyStrikes] = useState(0);
  const [showPlayer, setShowPlayer] = useState(null); // public player-profile screen (full-screen, rail intact)
  // Phone app: register this device for push once someone is signed in.
  useEffect(() => { if (HAS_SUPABASE) registerPush(__sb); }, []);
  // Back from connecting Discord while editing the profile → reopen it.
  useEffect(() => { if (takeResume((r) => r.kind === "profile")) setPage("account"); }, []);
  useEffect(() => { if (openProfile) { setShowPlayer(openProfile); onProfileOpened && onProfileOpened(); } }, [openProfile]);
  const [expandPast, setExpandPast] = useState(null); // settled strip → recap card
  const [railWideHub, setRailWideHub] = useState(() => {
    try { const v = localStorage.getItem("volt_rail_wide"); return v === null ? true : v === "1"; }
    catch { return true; }
  });
  const setRailWide = (v) => { setRailWideHub(v); try { localStorage.setItem("volt_rail_wide", v ? "1" : "0"); } catch {} };
  const [hubDesk, setHubDesk] = useState(typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 768px)").matches : true);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const on = e => setHubDesk(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);

  // My registration rows for every non-settled tournament — powers the toggles.
  async function loadMyRegs(evs) {
    try {
      const ids = (evs || []).filter(e => e.phase !== "settled").map(e => e.id);
      if (!ids.length) { setMyRegs({}); return; }
      const { data } = await __sb.from("registrations").select("id, event_id, status, wants_captain, is_captain")
        .eq("user_id", window.__VOLT.userId).in("event_id", ids);
      const map = {}; (data || []).forEach(r => { map[r.event_id] = r; });
      setMyRegs(map);
      // Host: how many applications are waiting on each open tournament.
      if (isHost) {
        const openIds = (evs || []).filter(e => e.phase === "registration_open" || e.phase === "registration_closed").map(e => e.id);
        if (openIds.length) {
          const { data: pend } = await __sb.from("registrations").select("event_id").eq("status", "pending").in("event_id", openIds);
          const pc = {}; (pend || []).forEach(r => { pc[r.event_id] = (pc[r.event_id] || 0) + 1; });
          setPendingByEvent(pc);
        } else setPendingByEvent({});
      }
    } catch (e) { console.error(e); }
  }
  async function loadMyMeta() {
    try {
      setMyProf(await loadProfileGate(window.__VOLT.userId));
      const { data: u } = await __sb.from("users").select("suspension_remaining").eq("id", window.__VOLT.userId).maybeSingle();
      setMySusp(u?.suspension_remaining || 0);
      setMyStrikes(await activeStrikeCount(window.__VOLT.userId));
    } catch (e) { console.error(e); }
  }

  // The tournament that IS the league right now: the non-settled one that's
  // furthest along (matches > draft > reg closed > reg open); ties → oldest.
  const PHASE_RANK = { matches_live: 4, drafting: 3, registration_closed: 2, registration_open: 1, settled: 0 };
  function pickCurrent(evs) {
    const open = (evs || []).filter(e => e.phase !== "settled");
    if (!open.length) return null;
    return open.sort((a, b) => (PHASE_RANK[b.phase] - PHASE_RANK[a.phase]) || (new Date(a.created_at) - new Date(b.created_at)))[0];
  }

  async function load() {
    if (DEMO) { const m = await loadDemo(); window.__VOLT.communityName = m.demoLeague.name; setEvents(m.demoLeague.events); setLive(m.demoLeague.live); setBoard(m.demoLeague.board); return; }
    if (!HAS_SUPABASE) { setEvents([]); return; }
    const { data } = await __sb.from("events").select("*").eq("community_id", window.__VOLT.communityId).order("created_at", { ascending: false });
    setEvents(data || []);
    const cur = pickCurrent(data);
    if (cur) {
      try {
        const { data: regs } = await __sb.from("registrations").select("user_id, status").eq("event_id", cur.id);
        const rows = regs || [];
        const appr = rows.filter(r => (r.status || "approved") === "approved");
        const mineRow = rows.find(r => r.user_id === window.__VOLT.userId);
        setLive({ count: appr.length, pending: rows.filter(r => r.status === "pending").length, mineStatus: mineRow ? (mineRow.status || "approved") : null });
      } catch (e) { console.error(e); setLive(null); }
    } else setLive(null);
    loadMyRegs(data);
    loadMyMeta();
    loadSeason();
    loadPlayerBoard();
  }

  // Player season leaderboard: sum of every match's points (+50 win · perf÷4 · K+⅓A).
  async function loadPlayerBoard() {
    try {
      const { data: mrs } = await __sb.from("match_results")
        .select("user_id, points_computed, team_won, event_id")
        .eq("community_id", window.__VOLT.communityId);
      if (!mrs || !mrs.length) { setBoard(null); return; }
      const { data: us } = await __sb.from("users").select("id, display_name, trophy_streak").eq("community_id", window.__VOLT.communityId);
      const names = {}, streaks = {}; (us || []).forEach(u => { names[u.id] = u.display_name; streaks[u.id] = u.trophy_streak || 0; });
      // rank movement: current standings vs standings before the latest settled tournament
      let lastSettled = null;
      try {
        const { data: le } = await __sb.from("events").select("id").eq("community_id", window.__VOLT.communityId).eq("phase", "settled").order("created_at", { ascending: false }).limit(1);
        lastSettled = le?.[0]?.id || null;
      } catch {}
      const build = (rows) => {
        const agg = {};
        rows.forEach(r => {
          const a = (agg[r.user_id] = agg[r.user_id] || { uid: r.user_id, name: names[r.user_id] || "Player", pts: 0, matches: 0, wins: 0 });
          a.pts += Number(r.points_computed || 0); a.matches++; if (r.team_won) a.wins++;
        });
        return Object.values(agg).sort((x, y) => y.pts - x.pts);
      };
      const cur = build(mrs);
      cur.forEach(p => { p.trophies = streaks[p.uid] || 0; });
      if (lastSettled) {
        const prev = build(mrs.filter(r => r.event_id !== lastSettled));
        const prevRank = {}; prev.forEach((p, i) => { prevRank[p.uid] = i + 1; });
        cur.forEach((p, i) => { p.move = prevRank[p.uid] == null ? "new" : prevRank[p.uid] - (i + 1); });
      }
      setBoard(cur);
    } catch (e) { console.error("playerBoard", e); }
  }

  // Aggregate settled tournaments' standings into a season leaderboard.
  async function loadSeason() {
    try {
      const prevWin = window.__VOLT.weekendId;
      window.__VOLT.weekendId = null; // season log is community-level
      const { keys } = await window.storage.list("season-standings::", true);
      const agg = {}; // captainUserId|name → { name, captain, tournaments, won, lost, pts }
      for (const k of (keys || [])) {
        const r = await window.storage.get(k, true);
        if (!r) continue;
        let snap; try { snap = JSON.parse(r.value); } catch { continue; }
        (snap.rows || []).forEach(row => {
          const key = row.captainUserId || row.name || row.teamId;
          if (!agg[key]) agg[key] = { name: row.name, captain: row.captain, tournaments: 0, won: 0, lost: 0, pts: 0 };
          agg[key].tournaments++;
          agg[key].won += row.won || 0; agg[key].lost += row.lost || 0; agg[key].pts += row.pts || 0;
        });
      }
      window.__VOLT.weekendId = prevWin;
      const rows = Object.values(agg).sort((a, b) => b.pts - a.pts || b.won - a.won);
      setSeason(rows.length ? rows : null);
    } catch (e) { console.error("loadSeason", e); }
  }
  useEffect(() => { load(); }, []);

  // Light poll (#events + current-tournament regs only) so phases/counters go
  // live without re-running the heavy season aggregation every tick.
  async function refreshEvents() {
    if (!HAS_SUPABASE) return;
    const { data } = await __sb.from("events").select("*").eq("community_id", window.__VOLT.communityId).order("created_at", { ascending: false });
    setEvents(data || []);
    const cur = pickCurrent(data);
    if (cur) {
      try {
        const { data: regs } = await __sb.from("registrations").select("user_id, status").eq("event_id", cur.id);
        const rows = regs || [];
        const appr = rows.filter(r => (r.status || "approved") === "approved");
        const mineRow = rows.find(r => r.user_id === window.__VOLT.userId);
        setLive({ count: appr.length, pending: rows.filter(r => r.status === "pending").length, mineStatus: mineRow ? (mineRow.status || "approved") : null });
      } catch (e) { console.error(e); }
    } else setLive(null);
    loadMyRegs(data);
  }
  useEffect(() => { const stop = visInterval(refreshEvents, 8000); return () => stop(); }, []);

  // ── Host tournament management ──
  async function saveWeekend(ev, patch) {
    setErr("");
    const { error } = await __sb.from("events").update(patch).eq("id", ev.id);
    if (error) { setErr(error.message || "Update failed."); throw error; }
    await refreshEvents();
  }
  async function deleteWeekend(ev) {
    if (!isTrueHost) { setErr("Only the host can delete a tournament."); return; }
    // match_results cascade with the event, so deleting a played tournament
    // would wipe everyone's season points from it — the old prompt promised
    // the opposite.
    const { count } = await __sb.from("match_results").select("id", { count: "exact", head: true }).eq("event_id", ev.id);
    if (count) {
      setErr(`${weekendName(ev)} has ${count} reported stat line${count === 1 ? "" : "s"}. Deleting it would erase those season points — settle it instead, or delete its matches in Report match first.`);
      return;
    }
    if (!(await voltConfirm("This removes the tournament and its registrations. It can't be undone.",
      { title: `Delete ${weekendName(ev)}?`, confirmLabel: "Delete tournament", danger: true }))) return;
    try {
      // Registrations, notifications and the draft row cascade with the event,
      // in one statement — deleting registrations first left them gone if the
      // event delete then failed.
      const { error } = await __sb.from("events").delete().eq("id", ev.id);
      if (error) throw error;
      await refreshEvents();
    } catch (e) { setErr(e.message || "Could not delete — the tournament may have linked data."); }
  }
  async function saveDraftTime(ev, localValue) {
    try {
      const iso = localValue ? new Date(localValue).toISOString() : null;
      const { error } = await __sb.from("events").update({ draft_at: iso }).eq("id", ev.id);
      if (error) throw error;
      await refreshEvents();
    } catch (e) { setErr(e.message || "Could not save draft time."); }
  }
  const fmtDraftAt = (d) => {
    if (!d) return null;
    const dt = new Date(d);
    return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " · " + dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  async function createWeekend(patch) {
    setErr(""); setBusy(true);
    try {
      const { data: created, error } = await __sb.from("events").insert({
        community_id: window.__VOLT.communityId,
        starts_on: patch?.starts_on || comingSaturday(),
        ends_on: patch?.ends_on ?? null,
        weekend_label: patch?.weekend_label ?? null,
        draft_at: patch?.draft_at ?? null,
        phase: "registration_open",
      }).select().maybeSingle();
      if (error) throw error;
      const nm = weekendName(created);
      // Ping every member: registration is open.
      try {
        const { data: us } = await __sb.from("users").select("id").eq("community_id", window.__VOLT.communityId).neq("id", window.__VOLT.userId);
        await voltNotify((us || []).map(u => ({ community_id: window.__VOLT.communityId, user_id: u.id, event_id: created?.id,
          kind: "weekend_open", title: `${nm} — registration open`, body: "Flip \"I'm playing\" on your dashboard to enter the pool." })));
      } catch (e) { console.error(e); }
      await load();
    } catch (e) { setErr(e.message || "Could not create tournament."); setBusy(false); throw e; }
    setBusy(false);
  }

  // Tournament to route the rail's view shortcuts into: the furthest-along
  // enterable tournament (matches/draft/reg-closed — reg-open lands on the gate).
  // The furthest-along running tournament, sign-ups included (it opens on the
  // page asked for, not the registration gate). With nothing running, the last
  // finished one, so its fixtures and rosters stay a click away.
  const RANK_ENTER = { matches_live: 4, drafting: 3, registration_closed: 2, registration_open: 1 };
  const railTarget = HAS_SUPABASE && Array.isArray(events)
    ? events.filter(e => RANK_ENTER[e.phase]).sort((a, b) => (RANK_ENTER[b.phase] - RANK_ENTER[a.phase]) || (new Date(a.created_at) - new Date(b.created_at)))[0]
      || events.find(e => e.phase === "settled") || null
    : null;
  const showRail = (HAS_SUPABASE || !!DEMO) && hubDesk;
  const showStaff = HAS_SUPABASE && (isTrueHost || isOperator);
  const hubPages = [["overview", "Home", "overview"], ["season", "Season", "season"], (events || []).length > 0 && ["tournaments", "Events", "history"],
    isHost && ["discord", "Discord", "discord"], showStaff && ["staff", "Staff", "settings"], ["account", "Me", "account"]].filter(Boolean);
  // Five fit in a tab bar; with more, the first four stay and the rest go in More.
  const hubTabs = hubPages.length <= 5 ? hubPages : hubPages.slice(0, 4);
  const hubMore = hubPages.length <= 5 ? [] : hubPages.slice(4);
  const railPad = showRail ? (railWideHub ? 224 : 60) : 0;

  const wrap = (inner, hideHeader) => (
    <div className="vg-shell" style={{ minHeight: "100vh", background: "#0a0d18", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", padding: "0 0 40px", paddingLeft: railPad,
      ...(showRail ? null : { paddingBottom: "calc(90px + env(safe-area-inset-bottom))" }), transition: "padding-left .18s cubic-bezier(.2,.8,.3,1)" }}>
      <ShellStyles />
      {showRail && <HubRail community={community} target={railTarget} onEnter={onEnter} onAccount={openAccount} isHost={isHost} wide={railWideHub} setWide={setRailWide}
        hasTournaments={(events || []).length > 0} onCreate={isHost ? () => setSetupWeekend({ mode: "create", ev: null }) : null}
        page={showPlayer ? null : page} onPage={setPage} showStaff={showStaff} />}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, padding: showRail ? "14px 20px" : "10px 14px", ...TOPBAR,
        // Beside the rail the bar scrolls with the page, so there is nothing to blur.
        ...(showRail ? { position: "relative", backdropFilter: undefined, WebkitBackdropFilter: undefined } : { position: "sticky", top: 0, zIndex: 50 }) }}>
        <span aria-hidden style={TOPBAR_LINE} />
        {/* phones have no rail, so the league's mark sits here */}
        {!showRail && <div style={{ marginRight: "auto", minWidth: 0, display: "flex", alignItems: "center", gap: 8 }}><LeagueLockup name={community?.name || window.__VOLT.communityName || "VOLT"} wide /><LeagueSwitch size={34} /></div>}
        {HAS_SUPABASE && <NotifBell />}
        {account && <AccountChip account={account} onSignOut={onSignOut} onProfile={HAS_SUPABASE ? openAccount : null} />}
      </div>
      {/* No rail on phones: the same pages as a bottom tab bar (More holds the rest). */}
      {!showRail && (HAS_SUPABASE || DEMO) && createPortal(<>
        <nav aria-label="League" style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 90,
          display: "grid", gridTemplateColumns: `repeat(${hubTabs.length + (hubMore.length ? 1 : 0)}, minmax(0, 1fr))`,
          padding: "6px 6px calc(6px + env(safe-area-inset-bottom))",
          ...TABBAR, fontFamily: "'Rajdhani',sans-serif" }}>
          {[...hubTabs, ...(hubMore.length ? [["__more", "More", null]] : [])].map(([k, label, glyph]) => {
            const on = k === "__more" ? (hubMoreOpen || (!showPlayer && hubMore.some(([m]) => m === page))) : page === k && !showPlayer && !hubMoreOpen;
            return (
              <button key={k} aria-current={on ? "page" : undefined} onClick={() => { if (k === "__more") setHubMoreOpen((o) => !o); else { setHubMoreOpen(false); setPage(k); } }}
                style={{ position: "relative", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, minHeight: 52, padding: "4px 0",
                  background: "none", border: "none", cursor: "pointer", color: on ? "#eaf1ff" : "rgba(170,190,230,0.55)", WebkitTapHighlightColor: "transparent" }}>
                {on && <span aria-hidden style={{ position: "absolute", top: -6, left: "22%", right: "22%", height: 2, background: "#3d7bff", boxShadow: "0 0 10px #3d7bff" }} />}
                <span style={{ display: "inline-flex", color: on ? "#7da6ff" : "inherit", filter: on ? "drop-shadow(0 0 6px rgba(61,123,255,0.7))" : "none" }}>
                  {glyph ? glyphNode(glyph, 21) : (
                    <span style={{ display: "grid", gridTemplateColumns: "repeat(2, 6px)", gap: 3, padding: 2 }}>
                      {[0, 1, 2, 3].map((i) => <i key={i} style={{ width: 6, height: 6, border: "1.6px solid currentColor", display: "block" }} />)}
                    </span>)}
                </span>
                <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>
              </button>
            );
          })}
        </nav>
        {hubMoreOpen && <>
          <div onClick={() => setHubMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 88, background: "rgba(3,5,10,0.6)", backdropFilter: "blur(3px)" }} />
          <div role="dialog" aria-label="More" style={{ position: "fixed", left: 8, right: 8, bottom: "calc(70px + env(safe-area-inset-bottom))", zIndex: 89,
            background: "linear-gradient(165deg, rgba(16,23,42,0.98), rgba(8,11,20,0.98))", border: "1px solid rgba(61,123,255,0.4)",
            clipPath: SHELL_NOTCH(16), padding: 12, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, fontFamily: "'Rajdhani',sans-serif" }}>
            {hubMore.map(([k, label, glyph]) => (
              <button key={k} onClick={() => { setHubMoreOpen(false); setPage(k); }}
                style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 7, minHeight: 78, cursor: "pointer",
                  background: page === k ? "rgba(61,123,255,0.16)" : "rgba(255,255,255,0.03)", border: `1px solid ${page === k ? "rgba(61,123,255,0.6)" : "rgba(120,150,220,0.16)"}`,
                  clipPath: SHELL_NOTCH(9), color: "rgba(220,230,252,0.9)" }}>
                <span style={{ color: "#7da6ff", display: "inline-flex" }}>{glyphNode(glyph, 22)}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>{label}</span>
              </button>
            ))}
          </div>
        </>}
      </>, document.body)}
      {setupWeekend && (
        <WeekendSetup
          mode={setupWeekend.mode}
          ev={setupWeekend.ev}
          onSave={async (patch) => {
            if (setupWeekend.mode === "create") await createWeekend(patch);
            else await saveWeekend(setupWeekend.ev, patch);
          }}
          onClose={() => setSetupWeekend(null)} />
      )}
      {/* hideHeader: true = a full-bleed screen (a profile), "page" = a hub page with its own heading */}
      <div style={{ maxWidth: hideHeader === true ? 1000 : 1120, margin: "0 auto", padding: hideHeader === true ? "16px 20px 0" : "30px 20px 0" }}>
        <style>{DASH_CSS + SWEEP_CSS + `
          .volt-lg-stats { display: flex; gap: 22px; align-items: flex-start; }
          .volt-lg-stats > :not(.volt-lg-rule) { flex: 0 1 auto; }
          .volt-lg-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
          .volt-lg-grid > .volt-lg-full { grid-column: 1 / -1; }
          @media (max-width: 860px) {
            .volt-lg-grid { grid-template-columns: 1fr; }
          }
          @media (max-width: 560px) {
            .volt-lg-hero { padding: 22px 18px 20px !important; min-height: 0 !important; }
            .volt-lg-stats { padding-top: 20px !important; }
            .volt-lg-stats { flex-wrap: wrap; gap: 16px 20px; }
            .volt-lg-rule { display: none; }
          }
        `}</style>
        {!hideHeader && (() => {
          // The league's banner, built like the player card on the tournament
          // home: same frame, grid, rays and brackets, the art standing on the
          // right, and the headline numbers big with a small label under each.
          const settled = (events || []).filter(e => e.phase === "settled").length;
          const lead = board && board[0];
          const H = "#3d7bff";
          const BIG = (c) => ({ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: "clamp(28px, 3.4vw, 40px)", lineHeight: 1, color: c,
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" });
          const LBL = { fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(200,215,255,0.6)", marginTop: 8, whiteSpace: "nowrap", textShadow: "0 1px 6px rgba(5,8,16,0.9)" };
          const stat = (v, label, col, i, sub) => (
            <div key={label} style={{ minWidth: 0, animation: `voltRise .45s ${120 + i * 70}ms backwards` }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
                <span style={BIG(col)}>{v}</span>
              </div>
              <div style={LBL}>{label}{sub && <span style={{ color: "rgba(245,196,83,0.85)", letterSpacing: "0.12em" }}> · {sub}</span>}</div>
            </div>
          );
          const rule = <div aria-hidden className="volt-lg-rule" style={{ alignSelf: "stretch", width: 1, background: "linear-gradient(180deg, transparent, rgba(120,150,220,0.25), transparent)" }} />;
          return (
            <div className="volt-lg-hero" style={{ ...PANEL(`${H}55`, "30px 34px 28px"), position: "relative", overflow: "hidden", clipPath: SHELL_NOTCH(18),
              marginBottom: 14, minHeight: 300, display: "flex", flexDirection: "column" }}>
              {/* The league's key art: mirrored so the figure stands on the right
                  facing the name, graded into VOLT blue, fading out behind the text. */}
              <KeyArt src={ART.omen} />
              <span aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 12, height: 12, borderLeft: `2px solid ${H}`, borderTop: `2px solid ${H}` }} />
              <span aria-hidden style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12, borderRight: `2px solid ${H}`, borderBottom: `2px solid ${H}` }} />

              <div style={{ position: "relative", display: "flex", flexDirection: "column", flex: 1, maxWidth: 620 }}>
                <VoltTag color="#7da6ff" size={10} />
                <div style={{ fontSize: "clamp(40px, 6vw, 72px)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.01em",
                  lineHeight: 0.92, marginTop: 10, textShadow: `0 0 40px ${H}55`, overflowWrap: "anywhere" }}>{community?.name || window.__VOLT.communityName || "Community"}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
                  {community?.slug && (
                    <div style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "6px 7px 6px 13px",
                      background: "rgba(8,11,20,0.75)", border: "1px solid rgba(61,123,255,0.3)", clipPath: SHELL_NOTCH(8) }}>
                      <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700 }}>Join code</span>
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, fontWeight: 700, color: "#ecf3ff" }}>{community.slug}</span>
                      {/* The link beats the code: it opens the join screen with the code
                          already in, so a new player types nothing they could get wrong. */}
                      <CopyButton text={`${siteOrigin()}/?join=${community.slug}`} label="Copy invite link" style={shellBtn("accent", { padding: "5px 11px", fontSize: 9.5, letterSpacing: "0.16em" })} />
                    </div>
                  )}
                  {isHost && events && (
                    <button disabled={busy} onClick={() => setSetupWeekend({ mode: "create", ev: null })}
                      className={pickCurrent(events) ? undefined : "volt-cta-pulse"}
                      style={shellBtn(pickCurrent(events) ? "ghost" : "primary", { padding: "11px 20px", fontSize: 12, whiteSpace: "nowrap" })}>
                      {busy ? "…" : pickCurrent(events) ? "+ Next tournament" : "+ Create tournament"}</button>
                  )}
                </div>
                {events && events.length > 0 && (
                  <div className="volt-lg-stats" style={{ marginTop: "auto", paddingTop: 26 }}>
                    {stat(<CountUp to={settled} />, "Tournaments played", "#ecf3ff", 0)}
                    {rule}
                    {stat(board ? <CountUp to={board.length} /> : "—", "Players ranked", "#7da6ff", 1)}
                    {rule}
                    {stat(lead ? String(lead.name).toUpperCase() : "—", "Season leader", "#f5c453", 2, lead ? `${lead.pts} pts` : null)}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
        {inner}
        {err && <p style={{ color: "#ff8a94", fontSize: 13, marginTop: 12, textAlign: "center" }}>{err}</p>}
      </div>
    </div>
  );

  if (events === null) return wrap(<p className="vg-loading">// Loading league…</p>);
  if (showPlayer) return wrap(<PlayerProfile userId={showPlayer} onBack={() => setShowPlayer(null)} />, true);

  const btn = (primary) => shellBtn(primary ? "primary" : "ghost", { padding: "11px 22px", fontSize: 13 });

  // ── Current tournament hero + the rest as quiet strips ──
  const current = pickCurrent(events);
  const upcoming = events.filter(e => e.phase !== "settled" && e.id !== current?.id);
  const past = events.filter(e => e.phase === "settled");
  // Falls back to the most recent finished tournament so league-wide tools keep
  // working between weekends. `past` is newest-first, matching the query order.
  const lastSettled = past[0] || null;

  const heroCTA = !current ? "" :
    current.phase === "registration_open" ? (live?.mineStatus === "approved" ? "Enter tournament →" : live?.mineStatus ? "View application →" : "Apply now →") :
    current.phase === "registration_closed" ? "Enter tournament →" :
    current.phase === "drafting" ? "Enter the draft →" : "Watch matches →";

  const strip = (ev, dim) => (
    <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(120,150,220," + (dim ? "0.1" : "0.18") + ")", clipPath: SHELL_NOTCH(8), opacity: dim ? 0.6 : 1 }}>
      <span style={{ flex: 1, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 14 }}>{weekendName(ev)}
        {ev.draft_at && <span style={{ fontWeight: 500, textTransform: "none", color: "rgba(200,215,255,0.4)", fontSize: 11.5, marginLeft: 8, fontFamily: "'IBM Plex Mono',monospace" }}>{fmtDraftAt(ev.draft_at)}</span>}
      </span>
      <span style={{ fontSize: 11, letterSpacing: "0.14em", textTransform: "uppercase", color: PHASE_COLOR[ev.phase] || "#5b8dff", fontWeight: 600 }}>{PHASE_LABEL[ev.phase] || ev.phase}</span>
      {isHost && <>
        <button onClick={() => setSetupWeekend({ mode: "edit", ev })} title="Edit date / nickname" style={shellBtn("ghost", { padding: "5px 8px", fontSize: 10 })}>✎</button>
        <button onClick={() => deleteWeekend(ev)} title="Delete tournament" style={shellBtn("danger", { padding: "5px 8px", fontSize: 10 })}>✕</button>
      </>}
      <button onClick={() => onEnter(ev)} style={shellBtn("ghost", { padding: "6px 12px", fontSize: 11 })}>{dim ? "View" : "Enter"} →</button>
    </div>
  );

  // ── page chrome ──
  const leagueName = community?.name || window.__VOLT.communityName || "League";
  const recapStat = (label, value, color, extra) => (
    <div style={{ minWidth: 0, padding: "9px 11px", background: "rgba(10,16,30,0.7)", border: `1px solid ${color}40`, clipPath: SHELL_NOTCH(6) }}>
      <div style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 14.5, fontWeight: 700, textTransform: "uppercase", marginTop: 3, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{value}{extra}</div>
    </div>
  );
  const hostEdit = (ev) => isHost && <>
    <button onClick={() => setSetupWeekend({ mode: "edit", ev })} title="Edit date / nickname" style={shellBtn("ghost", { padding: "5px 8px", fontSize: 10 })}>✎</button>
    <button onClick={() => deleteWeekend(ev)} title="Delete tournament" style={shellBtn("danger", { padding: "5px 8px", fontSize: 10 })}>✕</button>
  </>;
  const createBtn = isHost && (
    <button disabled={busy} onClick={() => setSetupWeekend({ mode: "create", ev: null })}
      style={shellBtn(current ? "ghost" : "primary", { padding: "11px 20px", fontSize: 12, whiteSpace: "nowrap" })}>{busy ? "…" : current ? "+ Next tournament" : "+ Create tournament"}</button>
  );

  // ── Season race ──
  if (page === "season") return wrap(<>
    <PageHead league={leagueName} title="Season race" sub="Every match counts toward the season, subs included: +50 for a win, performance score ÷ 4, and kills plus a third of assists." accent="#f5c453" />
    {board && board.length > 0 && (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 18 }}>
        {board.slice(0, 3).map((r, i) => {
          const col = ["#f5c453", "#cfd8ea", "#d79a6b"][i];
          return (
            <div key={r.uid || i} onClick={() => r.uid && setShowPlayer(r.uid)} className="volt-cell" style={{ ...PANEL(`${col}55`, "16px 18px"), clipPath: SHELL_NOTCH(12), cursor: r.uid ? "pointer" : "default",
              position: "relative", overflow: "hidden", animation: `voltRise .45s ${i * 80}ms backwards` }}>
              <span aria-hidden style={{ position: "absolute", inset: 0, background: `radial-gradient(ellipse 70% 90% at 100% 0%, ${col}1f, transparent 70%)`, pointerEvents: "none" }} />
              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10 }}>
                <Pip i={i} />
                <span style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: col, fontWeight: 700 }}>{["Season leader", "Second", "Third"][i]}</span>
              </div>
              <div style={{ position: "relative", fontSize: 24, fontWeight: 700, textTransform: "uppercase", marginTop: 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", display: "flex", alignItems: "center" }}>{r.name}<TrophyChip n={r.trophies} /></div>
              <div style={{ position: "relative", display: "flex", alignItems: "baseline", gap: 10, marginTop: 6 }}>
                <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: 26, color: col }}>{r.pts}</span>
                <span style={{ fontSize: 11, letterSpacing: "0.14em", color: "rgba(200,215,255,0.5)", textTransform: "uppercase" }}>pts{r.matches != null ? ` · ${r.matches} played · ${r.wins}W` : ""}</span>
              </div>
            </div>
          );
        })}
      </div>
    )}
    {HAS_SUPABASE && (
      <div>
      <TabPanel label="League" tabs={[
        { key: "race", label: "Season race",
          hint: "+50 a win, performance\u00f74, K+\u2153A. Every match counts, subs included.",
          node: board ? (
            <div style={{ display: "grid", gap: 6 }}>
            {board.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 16px", background: i === 0 ? "linear-gradient(90deg, rgba(245,196,83,0.12), rgba(10,13,22,0.5) 70%)" : "rgba(10,13,22,0.5)", border: "1px solid " + (i === 0 ? "rgba(245,196,83,0.35)" : "rgba(120,150,220,0.12)"), clipPath: SHELL_NOTCH(8) }}>
            <Pip i={i} />
            <span style={{ flex: 1, minWidth: 0 }}>
            <span onClick={() => r.uid && setShowPlayer(r.uid)} title="View player profile" style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", cursor: r.uid ? "pointer" : "default", display: "inline-flex", alignItems: "center", color: i === 0 ? "#f5c453" : "#ecf3ff" }}>{r.name}
            <TrophyChip n={r.trophies} />
            {r.move === "new" && <span style={{ fontSize: 9.5, letterSpacing: "0.14em", color: "#7da6ff", fontWeight: 700, marginLeft: 8, border: "1px solid rgba(61,123,255,0.4)", padding: "1px 6px", clipPath: SHELL_NOTCH(4) }}>NEW</span>}
            {typeof r.move === "number" && r.move > 0 && <span style={{ fontSize: 11.5, color: "#3ddc84", fontWeight: 700, marginLeft: 8, fontFamily: "'IBM Plex Mono',monospace" }}>▲{r.move}</span>}
            {typeof r.move === "number" && r.move < 0 && <span style={{ fontSize: 11.5, color: "#ff8f9a", fontWeight: 700, marginLeft: 8, fontFamily: "'IBM Plex Mono',monospace" }}>▼{-r.move}</span>}
            </span>
            <Bar pct={board[0].pts ? (r.pts / board[0].pts) * 100 : 0} h={2} i={i} color={i === 0 ? "#f5c453" : "#3d7bff"} opacity={0.6} style={{ marginTop: 5, maxWidth: 280 }} />
            </span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "rgba(200,215,255,0.5)", whiteSpace: "nowrap" }}>{r.matches} played · {r.wins}W</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: 15, color: i === 0 ? "#f5c453" : "#ecf3ff", minWidth: 78, textAlign: "right", whiteSpace: "nowrap" }}>{r.pts}<span style={{ fontSize: 10, color: "rgba(200,215,255,0.45)", marginLeft: 4 }}>PTS</span></span>
            </div>
            ))}
            </div>
          ) : null },
        { key: "captains", label: "Captains",
          hint: "How each captain's roster has performed",
          node: season ? (
            <div style={{ display: "grid", gap: 6 }}>
            {season.map((r, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", background: i === 0 ? "rgba(245,196,83,0.08)" : "rgba(255,255,255,0.03)", border: "1px solid " + (i === 0 ? "rgba(245,196,83,0.35)" : "rgba(120,150,220,0.15)"), clipPath: SHELL_NOTCH(8) }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: i === 0 ? "#f5c453" : "#5b8dff", width: 24 }}>{String(i + 1).padStart(2, "0")}</span>
            <span style={{ flex: 1, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>{r.name}<span style={{ color: "rgba(200,215,255,0.45)", fontWeight: 500, textTransform: "none", marginLeft: 8, fontSize: 13 }}>· {r.captain}</span></span>
            <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>{r.tournaments}w · {r.won}-{r.lost}</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: "#ecf3ff", width: 46, textAlign: "right" }}>{r.pts} pts</span>
            </div>
            ))}
            </div>
          ) : null },
        { key: "crystal", label: "Crystal ball",
          hint: "Call the winner before kick-off. Anyone in the league can play.",
          node: <PredictionBoard bare /> },
        { key: "ledger", label: "Transactions",
          hint: "Every roster move, newest first",
          node: <LeagueLedger bare onOpenPlayer={(uid) => setShowPlayer(uid)} /> },
      ]} />
      </div>
    )}
  </>, "page");

  // ── Tournaments: what's on now, what's next, and every one before ──
  if (page === "tournaments") return wrap(<>
    <PageHead league={leagueName} title="Tournaments" sub="The one running now, what's coming up, and the results of every tournament this league has played." right={createBtn} />
    {(current || upcoming.length > 0) && (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 10px" }}><span style={SEC_LABEL}>// Now and next</span><span style={SEC_RULE} /></div>
        <div style={{ display: "grid", gap: 8, marginBottom: 26 }}>
          {[current, ...upcoming].filter(Boolean).map((ev) => {
            const isCur = ev.id === current?.id, pc = PHASE_COLOR[ev.phase] || "#3d7bff";
            const pend = isCur ? live?.pending : pendingByEvent[ev.id];
            return (
              <div key={ev.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", flexWrap: "wrap",
                background: isCur ? `linear-gradient(90deg, ${pc}14, rgba(10,13,22,0.6) 60%)` : "rgba(10,13,22,0.55)",
                border: `1px solid ${isCur ? pc + "66" : "rgba(120,150,220,0.16)"}`, clipPath: SHELL_NOTCH(10) }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: pc, boxShadow: `0 0 8px ${pc}`, flexShrink: 0 }} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ fontSize: 19, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em" }}>{weekendName(ev)}</div>
                  <div style={{ fontSize: 12, color: "rgba(200,215,255,0.5)", marginTop: 3, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                    <span style={{ color: pc, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", fontSize: 11 }}>{PHASE_LABEL[ev.phase]}</span>
                    {isCur && live && <span><b style={{ color: "#cfe0ff" }}>{live.count}</b> in the pool</span>}
                    {isHost && pend > 0 && <span style={{ color: "#f5c453", fontWeight: 700 }}>{pend} awaiting review</span>}
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>Draft {ev.draft_at ? fmtDraftAt(ev.draft_at) : "not set"}</span>
                  </div>
                </div>
                {hostEdit(ev)}
                <button onClick={() => onEnter(ev)} style={shellBtn(isCur ? "primary" : "ghost", { padding: "9px 16px", fontSize: 11.5 })}>Enter →</button>
              </div>
            );
          })}
        </div>
      </>
    )}
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "0 0 10px" }}><span style={SEC_LABEL}>// Past tournaments</span><span style={SEC_RULE} />
      <span style={{ fontSize: 11, color: "rgba(200,215,255,0.4)", fontFamily: "'IBM Plex Mono',monospace" }}>{past.length}</span></div>
    {past.length === 0
      ? <div style={{ ...PANEL(null, "20px 22px"), clipPath: SHELL_NOTCH(12) }}><Empty rows={1} shape="block" title="No finished tournaments yet" hint="Results land here when a tournament is settled." /></div>
      : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(320px, 100%), 1fr))", gap: 12 }}>
          {past.map((ev, i) => {
            const rc = ev.recap || null;
            return (
              <div key={ev.id} className="volt-cell" style={{ ...PANEL(rc?.team ? "rgba(245,196,83,0.35)" : null, "16px 18px"), clipPath: SHELL_NOTCH(12), position: "relative", overflow: "hidden",
                display: "flex", flexDirection: "column", gap: 12, animation: `voltRise .4s ${Math.min(i, 8) * 50}ms backwards` }}>
                <span aria-hidden style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 80% at 100% 0%, rgba(245,196,83,0.08), transparent 70%)", pointerEvents: "none" }} />
                <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 12 }}>
                  {rc?.team ? <TeamMono name={rc.team} hue="#f5c453" size={34} /> : <TeamMono name="?" hue="#4a5570" size={34} />}
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 17, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{weekendName(ev)}</div>
                    <div style={{ fontSize: 12, color: "rgba(200,215,255,0.5)", marginTop: 2 }}>{rc?.team ? <>Won by <b style={{ color: "#f5c453" }}>{rc.team}</b></> : "No result recorded"}</div>
                  </div>
                </div>
                {rc && (rc.team || rc.mvp || rc.topFrag) && (
                  <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))", gap: 7 }}>
                    {rc.team && recapStat("Champion", rc.team, "#f5c453")}
                    {rc.mvp && recapStat("MVP", rc.mvp, "#5b8dff", rc.mvpPts ? <span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#7da6ff", marginLeft: 6, fontSize: 11 }}>{rc.mvpPts}</span> : null)}
                    {rc.topFrag && recapStat("Top fragger", rc.topFrag, "#ff8f9a")}
                  </div>
                )}
                <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 8, marginTop: "auto" }}>
                  <span style={{ flex: 1 }} />
                  {hostEdit(ev)}
                  <button onClick={() => onEnter(ev)} style={shellBtn("ghost", { padding: "7px 14px", fontSize: 11 })}>Bracket & rosters →</button>
                </div>
              </div>
            );
          })}
        </div>}
  </>, "page");

  // ── Discord ──
  if (page === "discord" && isHost) return wrap(<>
    <PageHead league={leagueName} title="Discord" sub="Connect the server, then let the bot announce, build channels, hand out roles and post the moments." accent="#8b9cff" />
    {/* Everything the bot does is one job with several tools, so it's one panel
        with tabs rather than six stacked cards. Tabs suit this and not the
        alerts above: switching between equal tools is what they're for. */}
    {isHost && HAS_SUPABASE && (
      <div><DiscordConsole tabs={[
        { key: "server", label: "Server", hint: "Connection, channels and the player role",
          node: (
            <>
              {isTrueHost && <DiscordServerCard />}
              <JoinGuideCard community={community} current={current} />
            </>
          ) },
        { key: "announce", label: "Announce", hint: "Message the league",
          node: (
            <DiscordAnnounce
              eventId={(current || lastSettled)?.id || null}
              communityId={window.__VOLT.communityId}
              phase={(current || lastSettled)?.phase || "settled"} />
          ) },
        current && { key: "arena", label: "Channels", hint: "Build the tournament's home in Discord",
          node: <DiscordArenaCard eventId={current.id} phase={current.phase} /> },
        current && ["drafting","matches_live"].includes(current.phase) && {
          key: "teams", label: "Teams", hint: "Tell every player who they're with",
          node: <DiscordTeamsCard eventId={current.id} /> },
        current && { key: "moments", label: "Moments", hint: "Draft recap and the server event",
          node: <DiscordMomentsCard eventId={current.id} phase={current.phase} draftAt={current.draft_at} /> },
      ].filter(Boolean)} /></div>
    )}

  </>, "page");

  // ── Staff ──
  if (page === "staff" && showStaff) return wrap(<>
    <PageHead league={leagueName} title="Staff" sub="Who helps you run the league, and the moderation tools that come with it." />
    {isTrueHost && HAS_SUPABASE && <StaffPanel onOpenPlayer={(uid) => setShowPlayer(uid)} />}
    {HAS_SUPABASE && isOperator && <AdminQueue />}
  </>, "page");

  // ── My account: the full profile page, the same one a tournament opens ──
  if (page === "account" && HAS_SUPABASE) return wrap(
    <AccountView auth={{ userId: window.__VOLT.userId, role: account?.role }} chrome={{ account, onSignOut }} />, true);

  // ── Overview ──
  const lastPast = past[0] || null;
  return wrap(<>
    {HAS_SUPABASE && (() => {
      // Which tournament is taking sign-ups: the current one, or the next one
      // opening while this one is still running.
      const regEv = (current && (current.phase === "registration_open" || current.phase === "registration_closed")) ? current
        : events.find(e => e.phase === "registration_open")
        || (current && LATE_SIGNUP_PHASES.includes(current.phase) ? current : null);
      const capEv = events.find(e => e.phase !== "settled" && myRegs[e.id]?.is_captain && (myRegs[e.id]?.status || "approved") === "approved") || null;
      const needsSetup = myProf && !(myProf.ign && myProf.rank && myProf.role && (myProf.linked || myProf.discord) && myProf.whatsapp);
      const jumpTo = (id) => setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
      return <>
        {isHost && <HostSetupChecklist community={community} events={events} current={current}
          onCreate={() => setSetupWeekend({ mode: "create", ev: null })}
          onSetDraftTime={() => { if (!current) return; setDraftAtDraft(current.draft_at ? new Date(current.draft_at).toISOString() : null); setEditTime(true); jumpTo("volt-current-hero"); }}
          onPickCaptains={() => current && onEnter(current)}
          onDiscord={() => setPage("discord")} />}
        <RoleWelcome userId={window.__VOLT.userId} isModerator={account?.role === "moderator"} captainEv={capEv}
          onWarRoom={() => capEv && onEnter(capEv, "warroom")} />
        <MatchReadyCard prof={myProf} ev={regEv} myReg={regEv ? myRegs[regEv.id] : null} susp={mySusp}
          onOpenProfile={openAccount} onChanged={load} />
        {/* The checklist above already covers Discord while setup is unfinished. */}
        {!needsSetup && <DiscordConnectBanner />}
      </>;
    })()}

    {events.length === 0
      ? <div style={{ ...PANEL(null, "22px 24px"), clipPath: SHELL_NOTCH(16), marginBottom: 22 }}>
          <Empty rows={2} shape="block" title="No tournaments yet"
            hint={isHost ? "Create the first one to open sign-ups." : "Check back when your host opens a tournament."} />
        </div>
      : <div className="volt-lg-grid" style={{ marginBottom: 22 }}>
          {current && (
            <div id="volt-current-hero" className="volt-cell" style={{ ...PANEL(`${PHASE_COLOR[current.phase] || "#3d7bff"}66`, "20px 24px 22px"), position: "relative", overflow: "hidden", clipPath: SHELL_NOTCH(16),
              boxShadow: current.phase === "drafting" ? "0 0 46px rgba(61,123,255,0.16)" : "none", height: "100%" }}>
              {/* Kept plain: the phase shows in the border and status line, and the
                  animated stripes behind the text read as noise. A faint glow in the
                  phase colour is all the card needs. */}
              <span aria-hidden style={{ position: "absolute", inset: 0, pointerEvents: "none",
                background: `radial-gradient(ellipse 55% 80% at 100% 0%, ${PHASE_COLOR[current.phase] || "#3d7bff"}14, transparent 70%)` }} />
              {current.phase === "drafting" && <span aria-hidden className="volt-live-glow" />}
              <span aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 11, height: 11, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
              <span aria-hidden style={{ position: "absolute", right: 0, bottom: 0, width: 11, height: 11, borderRight: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />
              {/* Label rule spans the card and carries the host's edit/delete out
                  of the headline — they were breaking the title's line before. */}
              <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={SEC_LABEL}>// This tournament</span>
                <span style={SEC_RULE} />
                {isHost && <>
                  <button onClick={() => setSetupWeekend({ mode: "edit", ev: current })} title="Edit date / nickname" style={shellBtn("ghost", { padding: "4px 9px", fontSize: 10, lineHeight: 1, opacity: 0.8 })}>✎</button>
                  <button onClick={() => deleteWeekend(current)} title="Delete tournament" style={shellBtn("danger", { padding: "4px 9px", fontSize: 10, lineHeight: 1, opacity: 0.8 })}>✕</button>
                </>}
              </div>
              <div className="volt-tourn-hero" style={{ position: "relative" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "clamp(28px, 3.4vw, 40px)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1,
                    textShadow: `0 0 34px ${PHASE_COLOR[current.phase] || "#3d7bff"}40` }}>{weekendName(current)}</div>
                  <div style={{ fontSize: 13, color: "rgba(200,215,255,0.55)", marginTop: 7, lineHeight: 1.45 }}>
                    {{ registration_open: "Sign-ups are open. Put your name in and captains can bid for you.",
                       registration_closed: "Roster locked. The draft is next.",
                       drafting: "The auction is live. Captains are bidding now.",
                       matches_live: "Matches are running. Check your fixture and be in voice ten minutes early." }[current.phase] || ""}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 13, flexWrap: "wrap", rowGap: 8 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 7, fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: PHASE_COLOR[current.phase], fontWeight: 700 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: PHASE_COLOR[current.phase], boxShadow: `0 0 8px ${PHASE_COLOR[current.phase]}` }} />
                      {PHASE_LABEL[current.phase]}
                    </span>
                    {live && <span style={{ display: "inline-flex", alignItems: "center", gap: 12, fontSize: 12.5, color: "rgba(200,215,255,0.5)" }}>
                      <span style={{ width: 1, height: 12, background: "rgba(120,150,220,0.25)" }} />
                      <span><b style={{ color: "#cfe0ff", fontWeight: 700 }}>{live.count}</b> in the pool</span>
                      {isHost && live.pending > 0 && <span style={{ color: "#f5c453", fontWeight: 700 }}>{live.pending} awaiting review</span>}
                    </span>}
                    {live?.mineStatus === "approved" && <span style={{ fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#9af5c2", background: "rgba(61,220,132,0.08)", border: "1px solid rgba(61,220,132,0.4)", padding: "4px 9px", clipPath: SHELL_NOTCH(5), fontWeight: 700 }}>You're in ✓</span>}
                    {live?.mineStatus === "pending" && <span style={{ fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#f5c453", background: "rgba(245,196,83,0.07)", border: "1px solid rgba(245,196,83,0.45)", padding: "4px 9px", clipPath: SHELL_NOTCH(5), fontWeight: 700 }}>Application pending</span>}
                    {live?.mineStatus === "rejected" && <span style={{ fontSize: 9.5, letterSpacing: "0.16em", textTransform: "uppercase", color: "#ff8f9a", background: "rgba(255,70,85,0.07)", border: "1px solid rgba(255,70,85,0.4)", padding: "4px 9px", clipPath: SHELL_NOTCH(5), fontWeight: 700 }}>Not approved</span>}
                    {(current.phase === "registration_open" || current.phase === "registration_closed") && live && !live.mineStatus && <span style={{ fontSize: 12.5, color: "#f5c453" }}>You haven't applied yet</span>}
                  </div>
                  {/* For the host: the move that's theirs to make, done from Manage inside the tournament. */}
                  {isHost && { registration_open: "Start the draft phase", registration_closed: "Start the draft phase", drafting: "Start the matches", matches_live: "Settle the tournament" }[current.phase] && (
                    <div style={{ fontSize: 12, color: "rgba(245,196,83,0.85)", marginTop: 10, letterSpacing: "0.02em" }}>
                      Next step · <b style={{ textTransform: "uppercase", letterSpacing: "0.08em" }}>{{ registration_open: "Start the draft phase", registration_closed: "Start the draft phase", drafting: "Start the matches", matches_live: "Settle the tournament" }[current.phase]}</b>
                      <span style={{ color: "rgba(200,215,255,0.45)" }}> — Manage, inside the tournament</span>
                    </div>
                  )}
                  {/* Draft time is the one fact everybody scans for — give it a
                      chip of its own rather than a loose line of mono text. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                    {editTime && isHost
                      ? <>
                          <VoltDateTime value={draftAtDraft} onChange={setDraftAtDraft} placeholder="Set draft time" />
                          <button onClick={() => { saveDraftTime(current, draftAtDraft ? (() => { const d = new Date(draftAtDraft); const p = x => String(x).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; })() : ""); setEditTime(false); }} style={shellBtn("accent", { padding: "6px 12px", fontSize: 11 })}>Save</button>
                          <button onClick={() => setEditTime(false)} style={shellBtn("ghost", { padding: "6px 10px", fontSize: 11 })}>Cancel</button>
                        </>
                      : <div style={{ display: "inline-flex", alignItems: "center", gap: 11, padding: "6px 7px 6px 13px", background: "rgba(10,16,30,0.6)", border: "1px solid rgba(61,123,255,0.2)", clipPath: SHELL_NOTCH(7), flexWrap: "wrap" }}>
                          <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)", fontWeight: 700 }}>Draft</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: current.draft_at ? "#cfe0ff" : "rgba(200,215,255,0.35)", fontFamily: "'IBM Plex Mono',monospace" }}>
                            {current.draft_at ? fmtDraftAt(current.draft_at) : "Not set yet"}</span>
                          {isHost && <button onClick={() => { setDraftAtDraft(current.draft_at ? new Date(current.draft_at).toISOString() : null); setEditTime(true); }} style={shellBtn("ghost", { padding: "4px 10px", fontSize: 9.5, letterSpacing: "0.16em" })}>{current.draft_at ? "Change" : "Set time"}</button>}
                        </div>}
                  </div>
                </div>
                {(current.phase === "registration_open" || current.phase === "registration_closed") && HAS_SUPABASE && isHost
                  ? <div style={{ display: "flex", flexDirection: "column", gap: 11, padding: "16px 17px", background: "rgba(8,12,24,0.6)", border: `1px solid ${live?.pending > 0 ? "rgba(245,196,83,0.4)" : "rgba(61,123,255,0.25)"}`, clipPath: SHELL_NOTCH(10) }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <span style={{ ...SEC_LABEL, fontSize: 9.5, letterSpacing: "0.26em" }}>// Host</span>
                        <span style={SEC_RULE} />
                      </div>
                      {live?.pending > 0
                        ? <span style={{ fontSize: 14.5, color: "#f5c453", fontWeight: 700, lineHeight: 1.35 }}>{live.pending} application{live.pending === 1 ? "" : "s"} awaiting your review</span>
                        : <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.5)", lineHeight: 1.5 }}>No applications waiting. New ones show up here.</span>}
                      {/* One way in. With applications waiting it opens the review desk;
                          otherwise the tournament itself, where the desk is a tab away. */}
                      {live?.pending > 0
                        ? <button onClick={() => onEnter(current)} style={shellBtn("warn", { padding: "11px 16px", fontSize: 12, width: "100%", marginTop: 2 })}>Review {live.pending} application{live.pending === 1 ? "" : "s"} →</button>
                        : <button onClick={() => onEnter(current, "lobby")} style={shellBtn("primary", { padding: "11px 16px", fontSize: 12, width: "100%", marginTop: 2 })}>⊞ Enter the tournament →</button>}
                    </div>
                  : (current.phase === "registration_open" || current.phase === "registration_closed") && HAS_SUPABASE
                  ? <div style={{ display: "flex", flexDirection: "column", gap: 11, padding: "16px 17px", background: "rgba(8,12,24,0.6)", border: "1px solid rgba(61,123,255,0.25)", clipPath: SHELL_NOTCH(10) }}>
                      <PlayToggle ev={current} mine={myRegs[current.id]} profileComplete={profileIsComplete(myProf)} susp={mySusp} strikes={myStrikes}
                        onEditProfile={openAccount} onChanged={load} />
                      <button onClick={() => onEnter(current, "lobby")} style={shellBtn("ghost", { padding: "9px 16px", fontSize: 11 })}>⊞ Enter the tournament →</button>
                    </div>
                  : <button onClick={() => onEnter(current)} style={shellBtn("primary", { padding: "15px 22px", fontSize: 13, width: "100%" })}>{heroCTA}</button>}
              </div>
              {myRegs[current.id]?.is_captain && (myRegs[current.id]?.status || "approved") === "approved" && (
                <div style={{ position: "relative", marginTop: 18, padding: "13px 16px", background: "rgba(245,196,83,0.08)", border: "1px solid rgba(245,196,83,0.55)", clipPath: SHELL_NOTCH(9), boxShadow: "0 0 24px rgba(245,196,83,0.12)" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#f5c453", textShadow: "0 0 12px rgba(245,196,83,0.6)" }}>★ You're a captain this tournament</span>
                  <span style={{ fontSize: 12, color: "rgba(200,215,255,0.6)", marginLeft: 10 }}>$10,000 budget{current.draft_at ? ` · draft ${fmtDraftAt(current.draft_at)}` : ""}. Scout the pool before the auction.</span>
                </div>
              )}
            </div>
          )}
          {!current && (
            <div style={{ ...PANEL(null, "22px 24px"), clipPath: SHELL_NOTCH(16) }}>
              <Empty rows={2} shape="block" title="No tournament running"
                hint={isHost ? "Create the next one to open sign-ups." : "You'll get a notification when the host opens sign-ups."} />
            </div>
          )}
          {/* Right of the live tournament: the season in five lines. */}
          {board && board.length > 0 && (
            <Cell title="Season race" action="Full table"
              onGo={() => setPage("season")}>
              <div style={{ display: "grid", gap: 9, marginTop: 2 }}>
                {board.slice(0, 5).map((r, i) => (
                  <div key={i} onClick={(e) => { if (r.uid) { e.stopPropagation(); setShowPlayer(r.uid); } }} className={r.uid ? "volt-pname" : undefined}
                    style={{ display: "flex", alignItems: "center", gap: 10, cursor: r.uid ? "pointer" : "default",
                      padding: i === 0 ? "8px 10px" : "2px 10px", background: i === 0 ? "linear-gradient(90deg, rgba(245,196,83,0.13), transparent 80%)" : "none",
                      borderLeft: `2px solid ${i === 0 ? "#f5c453" : "transparent"}`, animation: `voltRise .4s ${i * 60}ms backwards` }}>
                    <Pip i={i} />
                    <span style={{ flex: 1, minWidth: 0, fontWeight: 700, textTransform: "uppercase", fontSize: i === 0 ? 15 : 13,
                      color: i === 0 ? "#f5c453" : "rgba(236,243,255,0.85)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                    {typeof r.move === "number" && r.move !== 0 && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 10.5, color: r.move > 0 ? "#3ddc84" : "#ff8f9a" }}>{r.move > 0 ? "▲" : "▼"}{Math.abs(r.move)}</span>}
                    <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, fontSize: i === 0 ? 15 : 13, color: i === 0 ? "#f5c453" : "#ecf3ff" }}>{r.pts}</span>
                  </div>
                ))}
              </div>
            </Cell>
          )}
          {(() => {
            // Next tournament already open while this one runs → its toggle rides
            // right on home. The weekly rhythm on one screen.
            const nextReg = current?.phase !== "registration_open" && events.find(e => e.phase === "registration_open" && e.id !== current?.id);
            return nextReg && HAS_SUPABASE ? (
              <div className="volt-lg-full" style={{ padding: "16px 18px", background: "linear-gradient(160deg,rgba(16,24,40,0.9),rgba(10,13,22,0.9))", border: "1px solid rgba(61,220,132,0.3)", clipPath: SHELL_NOTCH(12) }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                  <div>
                    <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "#3ddc84", fontWeight: 700 }}>// Next tournament · registration open</div>
                    <div style={{ fontSize: 19, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 3 }}>{weekendName(nextReg)}
                      {nextReg.draft_at && <span style={{ fontWeight: 500, textTransform: "none", color: "rgba(200,215,255,0.45)", fontSize: 12, marginLeft: 10, fontFamily: "'IBM Plex Mono',monospace" }}>{fmtDraftAt(nextReg.draft_at)}</span>}</div>
                  </div>
                  <div style={{ flex: "0 1 300px" }}>
                    {isHost ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
                        {pendingByEvent[nextReg.id] > 0
                          ? <span style={{ fontSize: 12.5, color: "#f5c453", fontWeight: 700 }}>{pendingByEvent[nextReg.id]} application{pendingByEvent[nextReg.id] === 1 ? "" : "s"} awaiting review</span>
                          : <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)" }}>No applications yet.</span>}
                        <button onClick={() => onEnter(nextReg)} style={shellBtn(pendingByEvent[nextReg.id] > 0 ? "warn" : "ghost", { padding: "9px 16px", fontSize: 12 })}>Review applications →</button>
                      </div>
                    ) : (
                      <PlayToggle ev={nextReg} mine={myRegs[nextReg.id]} profileComplete={profileIsComplete(myProf)} susp={mySusp} strikes={myStrikes}
                        onEditProfile={openAccount} onChanged={load} compact />
                    )}
                  </div>
                </div>
              </div>
            ) : null;
          })()}
          {lastPast && (
            <div className="volt-lg-full volt-cell volt-last-strip" style={{ ...PANEL("rgba(245,196,83,0.28)", "14px 18px"), clipPath: SHELL_NOTCH(12), display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              <span style={{ ...SEC_LABEL, flexShrink: 0 }}>// Last tournament</span>
              {lastPast.recap?.team ? <TeamMono name={lastPast.recap.team} hue="#f5c453" size={26} /> : null}
              <div style={{ minWidth: 0, flex: 1 }}>
                <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", fontSize: 15 }}>{weekendName(lastPast)}</span>
                <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", marginLeft: 10 }}>
                  {lastPast.recap?.team ? <>Won by <b style={{ color: "#f5c453" }}>{lastPast.recap.team}</b></> : "No result recorded"}
                  {lastPast.recap?.mvp && <> · MVP <b style={{ color: "#ecf3ff" }}>{lastPast.recap.mvp}</b></>}
                </span>
              </div>
              <button onClick={() => setPage("tournaments")} style={shellBtn("ghost", { padding: "7px 14px", fontSize: 11 })}>All tournaments →</button>
            </div>
          )}
        </div>}
    {isHost && HAS_SUPABASE && current && (
      <HostAlerts>
        <BoardGapCard eventId={current.id} />
        <IgnCheckCard eventId={current.id} />
        <AvailabilityCard eventId={current.id} />
        {["drafting","matches_live"].includes(current.phase)
          ? <SubDesk eventId={current.id} onChanged={load} /> : null}
      </HostAlerts>
    )}
  </>);
}

// Strikes that still count: no-shows in the last 90 days — the same window
// volt_strike_count uses for suspensions and auto-approval.
async function activeStrikeCount(userId) {
  const since = new Date(Date.now() - 90 * 864e5).toISOString();
  const { data } = await __sb.from("registrations").select("id")
    .eq("community_id", window.__VOLT.communityId).eq("user_id", userId).eq("no_show", true)
    .or(`no_show_at.gte."${since}",and(no_show_at.is.null,created_at.gte."${since}")`);
  return (data || []).length;
}

// ── SEASON SCORING — per-match player points ────────────────────────────
//   +50 win bonus (heaviest) · performance score ÷4 (middle) · K + ⅓A (lightest)
//   Season total = sum of every match's points across all tournaments.
//
// Valorant's scoreboard swapped ACS for Performance Score (0-500) in patch
// 13.06. Matches reported since carry stat_payload.ps; older ones only have
// .acs. perfOf reads one or the other, so a season spanning the switch still
// averages (the two share a range). Tracker profiles are still ACS and never
// go through this.
function perfOf(sp) { return Number(sp?.ps ?? sp?.acs ?? 0) || 0; }
// Scouting profile — the stats captains study before bidding. Saved once per
// player (player_profiles), reused across tournaments, feeds the draft-pool cards.
// What a player must have on file before they can enter a tournament. rank and
// role live on player_profiles; whatsapp and the Discord link are in the
// host-only player_contacts table (a player can always read their own row), so
// the gate needs both reads. Returns an object rather than a boolean so callers
// can tell the user WHICH piece is missing.
//
// Discord is no longer a typed handle — it's the OAuth link, since a typed one
// proved nothing and left the bot unable to reach half the league. `discord`
// (the profile text) is kept as a fallback so members who filled it in under
// the old rules aren't locked out mid-season.
async function loadProfileGate(userId) {
  const out = { rank: null, role: null, discord: null, whatsapp: null, linked: false };
  try {
    const { data: p } = await __sb.from("player_profiles").select("*").eq("user_id", userId).maybeSingle();
    if (p) Object.assign(out, p);
  } catch (e) { console.error("profile gate", e); }
  try {
    // Trophies and the display name live on users, not the profile.
    const { data: u } = await __sb.from("users")
      .select("display_name, weekends_won, trophy_streak").eq("id", userId).maybeSingle();
    if (u) Object.assign(out, u);
  } catch (e) { console.error("profile user", e); }
  try {
    const { data: c } = await __sb.from("player_contacts").select("whatsapp, discord_user_id")
      .eq("user_id", userId).eq("community_id", window.__VOLT.communityId).maybeSingle();
    if (c) { out.whatsapp = c.whatsapp; out.linked = !!c.discord_user_id; }
  } catch (e) { console.error("contact gate", e); }
  return out;
}
const profileIsComplete = (p) => !!(p && p.rank && p.role && p.whatsapp && (p.linked || p.discord));
// Shrink before upload: a 4K screenshot is several MB of base64 for no accuracy
// gain, and the request has a hard size ceiling. 1600px wide keeps the digits
// crisp enough to read.
function downscaleImage(file, maxW = 1600) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxW / img.width);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL("image/jpeg", 0.9);
      resolve({ base64: dataUrl.split(",")[1], mimeType: "image/jpeg" });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That file isn't a readable image.")); };
    img.src = url;
  });
}

// resume: where to come back to after connecting Discord (see setResume).
function ScoutProfileCard({ userId, onSaved, embedded = false, resume = null }) {
  const [prof, setProf] = useState(undefined);
  // `embedded` means a parent already asked "want to set up your profile?" and
  // the user said yes — so open straight into the form instead of showing a
  // second button that asks the same thing again.
  const [editing, setEditing] = useState(embedded);
  const [d, setD] = useState({ ign: "", rank: "", rankDiv: "", peakRank: "", peakRankDiv: "", role: "", agent: "", kda: "", acs: "", hs: "", win: "", tracker: "", whatsapp: "" });
  // Screenshot import. Prefills the form and stops — the player still reviews
  // and saves, because captains bid real money against these numbers and an
  // auto-saved OCR result looks verified when it isn't.
  const [shotBusy, setShotBusy] = useState(false);
  const [shotErr, setShotErr] = useState("");
  const [shotScope, setShotScope] = useState("");   // which panel the reader used
  const [shotFilled, setShotFilled] = useState([]); // fields it actually populated
  const [dragOver, setDragOver] = useState(false);
  // Read-only: the handle and link state both come from the Discord OAuth flow.
  const [dc, setDc] = useState({ linked: false, handle: "" });
  const [dcBusy, setDcBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const ROLES = ["Duelist", "Initiator", "Controller", "Sentinel", "Flex"];
  // 16px inputs: anything smaller makes iPhones zoom the page on focus.
  const fieldS = { width: "100%", minHeight: 44, padding: "10px 12px", background: "rgba(10,16,30,0.75)", border: "1px solid rgba(125,166,255,0.42)", color: "#ecf3ff", fontFamily: READ_FONT, fontSize: 16, boxSizing: "border-box" };
  const labS = { fontSize: 13.5, fontWeight: 500, color: "rgba(232,239,255,0.95)", fontFamily: READ_FONT, display: "block", marginBottom: 6, textAlign: "left" };
  const helpS = { fontSize: 13, lineHeight: 1.45, color: "rgba(214,226,255,0.74)", fontFamily: READ_FONT, display: "block", marginTop: 6 };
  const groupS = { fontFamily: "'Rajdhani',sans-serif", fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#cfe0ff", margin: "22px 0 12px" };
  const twoCol = { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 12, marginBottom: 14 };

  async function load() {
    const { data } = await __sb.from("player_profiles").select("*").eq("user_id", userId).maybeSingle();
    setProf(data || null);
    // Contacts live in their own table, not player_profiles — that one is read
    // with select("*") by every client to build the draft board, so a phone
    // number sitting in it would be handed to the whole league.
    let c = null;
    try {
      const { data: cd } = await __sb.from("player_contacts").select("whatsapp, discord_user_id")
        .eq("user_id", userId).eq("community_id", window.__VOLT.communityId).maybeSingle();
      c = cd || null;
    } catch (e) { console.error("contacts", e); }
    setDc({ linked: !!c?.discord_user_id, handle: data?.discord || "" });
    const saved = { ign: data?.ign || "", rank: data?.rank || "", rankDiv: data?.rank_div ?? "", peakRank: data?.peak_rank || "", peakRankDiv: data?.peak_rank_div ?? "", role: data?.role || "", agent: data?.agent || "", kda: data?.kda ?? "", acs: data?.acs ?? "", hs: data?.hs ?? "", win: data?.win ?? "", tracker: data?.tracker_url || "", whatsapp: c?.whatsapp || "" };
    // An unsaved draft (typed before stepping out to connect Discord) wins over
    // what's stored, field by field.
    const draft = readDraft();
    if (draft) { setD({ ...saved, ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== "" && v != null)) }); setEditing(true); }
    else if (data || c) setD(saved);
  }
  useEffect(() => { load(); }, [userId]);

  // Draft kept in localStorage while editing, cleared on save. Without it,
  // connecting Discord (a full-page redirect) threw away everything typed.
  const draftKey = `volt.profileDraft.${userId}`;
  function readDraft() {
    try {
      const x = JSON.parse(localStorage.getItem(draftKey) || "null");
      if (!x || Date.now() - x.at > 24 * 3600e3) return null;
      return x.d;
    } catch { return null; }
  }
  useEffect(() => {
    if (!editing || prof === undefined) return;
    try { localStorage.setItem(draftKey, JSON.stringify({ at: Date.now(), d })); } catch { /* private mode */ }
  }, [d, editing]); // eslint-disable-line
  const clearDraft = () => { try { localStorage.removeItem(draftKey); } catch { /* ignore */ } };

  // Paste, drop or pick — all three land here. Paste is the one that matters:
  // Snipping Tool then Ctrl+V is the natural motion, and it skips saving a file.
  async function readTracker(file) {
    if (!file) return;
    setShotBusy(true); setShotErr(""); setShotScope(""); setShotFilled([]);
    try {
      const { base64, mimeType } = await downscaleImage(file);
      // Signed-in members only: the reader spends the league's Gemini quota.
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch(apiUrl("/api/read-tracker"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ image: base64, mimeType }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Reader returned ${r.status}.`);
      const filled = [];
      setD((prev) => {
        const next = { ...prev };
        const put = (key, val, label) => {
          if (val === null || val === undefined || val === "") return;
          next[key] = String(val); filled.push(label);
        };
        put("ign", body.ign, "Valorant name");
        put("rank", body.rank, "rank");
        if (body.rank) next.rankDiv = body.rankDiv ? String(body.rankDiv) : "";
        put("peakRank", body.peakRank, "peak rank");
        if (body.peakRank) next.peakRankDiv = body.peakRankDiv ? String(body.peakRankDiv) : "";
        put("agent", body.agent, "agent");
        put("kda", body.kda, "KDA");
        put("acs", body.acs, "ACS");
        put("hs", body.hs, "HS%");
        put("win", body.win, "win%");
        return next;
      });
      setShotFilled(filled);
      setShotScope(body.scope || "");
      // Role is a judgement call about how you play, not a number on a page.
      if (!body.rank) setShotErr("Couldn't find a rank — set that one yourself.");
    } catch (e) {
      setShotErr(e.message || "Couldn't read that screenshot.");
    }
    setShotBusy(false);
  }

  // Only while the form is open, so a stray paste elsewhere in the app is ignored.
  useEffect(() => {
    if (!editing) return;
    const onPaste = (e) => {
      const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      readTracker(item.getAsFile());
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [editing]);

  const [saveErr, setSaveErr] = useState("");
  async function save() {
    setBusy(true);
    const { error } = await __sb.from("player_profiles").upsert({
      user_id: userId, community_id: window.__VOLT.communityId,
      ign: d.ign.trim() || null,
      rank: d.rank || null,
      // Radiant has no divisions, so never persist one for it.
      rank_div: hasDivisions(d.rank) && d.rankDiv ? parseInt(d.rankDiv) : null,
      peak_rank: d.peakRank || null,
      peak_rank_div: hasDivisions(d.peakRank) && d.peakRankDiv ? parseInt(d.peakRankDiv) : null,
      role: d.role || null, agent: d.agent || null,
      kda: d.kda === "" ? null : parseFloat(d.kda), acs: d.acs === "" ? null : parseInt(d.acs),
      hs: d.hs === "" ? null : parseInt(d.hs), win: d.win === "" ? null : parseInt(d.win),
      tracker_url: d.tracker ? (/^https?:\/\//i.test(d.tracker) ? d.tracker.trim() : "https://" + d.tracker.trim()) : null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,community_id" });
    // Digits only — wa.me needs a bare international number, and normalising on
    // the way in means the host never has to clean it up by hand.
    const waDigits = (d.whatsapp || "").replace(/[^0-9]/g, "");
    let contactErr = null;
    try {
      const { error: ce } = await __sb.from("player_contacts").upsert({
        user_id: userId, community_id: window.__VOLT.communityId,
        whatsapp: waDigits || null,
      }, { onConflict: "user_id,community_id" });
      contactErr = ce || null;
    } catch (e) { contactErr = e; }
    setBusy(false);
    if (!error && contactErr) {
      console.error("saveContacts:", contactErr.message || contactErr);
      setSaveErr("Your stats saved, but the WhatsApp number didn't. You need it to enter a tournament — try again.");
      return;
    }
    if (error) {
      // Keep the form open and say what happened — collapsing silently made it
      // look like the save "reverted".
      console.error("saveProfile:", error.message);
      setSaveErr(error.message || "Couldn't save your profile. Check your connection and try again.");
      return;
    }
    setSaveErr("");
    clearDraft(); setEditing(false); load(); onSaved?.();
  }

  if (prof === undefined) return null;
  const has = prof && prof.rank;
  return (
    <div style={{ marginTop: embedded ? 0 : 24, padding: embedded ? 0 : "18px 20px", position: "relative", background: embedded ? "none" : "linear-gradient(160deg,rgba(20,26,42,0.85),rgba(10,13,22,0.85))", border: embedded ? "none" : "1px solid rgba(61,123,255,0.28)", clipPath: embedded ? "none" : SHELL_NOTCH(14), textAlign: "left", fontFamily: READ_FONT }}>
      {!embedded && <span style={{ position: "absolute", left: 0, top: 0, width: 9, height: 9, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />}
      {!embedded && <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 10 }}>// Your scouting profile</div>}
      {!editing && <>
        {has
          ? <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
              {[["RANK", rankLabel(prof.rank, prof.rank_div)], ["PEAK", prof.peak_rank ? rankLabel(prof.peak_rank, prof.peak_rank_div) : "—"], ["ROLE", prof.role || "—"], ["AGENT", prof.agent || "—"], ["KDA", prof.kda ?? "—"], ["ACS", prof.acs ?? "—"], ["HS%", prof.hs != null ? prof.hs + "%" : "—"], ["WIN%", prof.win != null ? prof.win + "%" : "—"]].map(([k, v]) => (
                <div key={k} style={{ padding: "6px 11px", background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", clipPath: SHELL_NOTCH(6) }}>
                  <div style={{ fontSize: 9, letterSpacing: "0.12em", textTransform: "uppercase", color: "#7da6ff" }}>{k}</div>
                  <div style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, color: "#ecf3ff", fontWeight: 700 }}>{v}</div>
                </div>))}
            </div>
          : <p style={{ color: "rgba(200,215,255,0.55)", fontSize: 13, margin: "0 0 12px" }}>Captains study this before bidding on you. Add your rank and tracker stats — it takes 30 seconds.</p>}
        <button onClick={() => setEditing(true)} style={shellBtn("primary", { padding: "9px 18px", fontSize: 12 })}>{has ? "Edit my stats" : "Set up my stats →"}</button>
      </>}
      {editing && <>
        {/* Filling seven stat fields by hand is the heaviest friction in the
            gate. This reads them off a tracker screenshot instead — prefill
            only, never autosave. */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); readTracker(e.dataTransfer?.files?.[0]); }}
          style={{ marginBottom: 6, padding: "14px 16px", clipPath: SHELL_NOTCH(9),
            background: dragOver ? "rgba(61,123,255,0.12)" : "rgba(10,16,30,0.45)",
            border: `1px ${dragOver ? "solid" : "dashed"} rgba(125,166,255,${dragOver ? 0.7 : 0.45})` }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: "#ecf3ff" }}>Fill this in from a screenshot</span>
            <label style={{ ...shellBtn("ghost", { padding: "8px 14px", fontSize: 12, cursor: shotBusy ? "wait" : "pointer" }), display: "inline-block" }}>
              {shotBusy ? "Reading…" : "Choose image"}
              <input type="file" accept="image/*" disabled={shotBusy} style={{ display: "none" }}
                onChange={(e) => { readTracker(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
          </div>
          <div style={{ ...helpS, marginTop: 8 }}>
            Screenshot your tracker.gg <b style={{ color: "#ecf3ff", fontWeight: 500 }}>Competitive</b> tab for the current act, then
            paste it with Ctrl+V or drag it here. Check the values before you save.
          </div>
          {shotScope && (
            <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "#9af5c2", marginTop: 8 }}>
              ✓ Read {shotFilled.length} field{shotFilled.length === 1 ? "" : "s"} from <b>{shotScope}</b>.
              <span style={{ color: "rgba(214,226,255,0.74)" }}> Check that's the right tab, then review the values.</span>
            </div>
          )}
          {shotErr && <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "#f5c453", marginTop: 8 }}>⚠ {shotErr}</div>}
        </div>

        {/* Required first, so what stands between a player and the Save button is
            all in one place. Match reporting looks players up by this name, which
            is why it leads. */}
        <div style={groupS}>Required</div>
        <label style={{ display: "block", marginBottom: 14 }}>
          <span style={labS}>Valorant name</span>
          <input value={d.ign} placeholder="Exactly as it appears in-game"
            onChange={(e) => setD({ ...d, ign: e.target.value })} style={fieldS} />
          <span style={helpS}>Leave off the #tag. If this doesn't match the game, your match stats won't reach you.</span>
        </label>
        <div style={twoCol}>
          {/* Tier and division are separate controls because the tier alone
              drives opening bids and pool filters — the number is cosmetic. */}
          <label><span style={labS}>Rank</span>
            <select value={d.rank} onChange={e => setD({ ...d, rank: e.target.value, rankDiv: hasDivisions(e.target.value) ? d.rankDiv : "" })} style={fieldS}>
              <option value="">Select</option>{Object.keys(RANKS).map(r => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <label><span style={labS}>Division</span>
            <select value={d.rankDiv} disabled={!hasDivisions(d.rank)} onChange={e => setD({ ...d, rankDiv: e.target.value })}
              style={{ ...fieldS, opacity: hasDivisions(d.rank) ? 1 : 0.55 }}>
              <option value="">{d.rank === "Radiant" ? "n/a" : "—"}</option>{RANK_DIVS.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
        </div>
        <label style={{ display: "block", marginBottom: 14 }}><span style={labS}>Role</span>
          <select value={d.role} onChange={e => setD({ ...d, role: e.target.value })} style={fieldS}>
            <option value="">Select</option>{ROLES.map(r => <option key={r} value={r}>{r}</option>)}
          </select></label>
        {/* Not typed any more — a hand-entered handle proved nothing and the bot
            still couldn't reach anyone. The OAuth link is the source of both. */}
        <div style={{ marginBottom: 14 }}><span style={labS}>Discord</span>
          {dc.linked
            ? <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", background: "rgba(61,220,132,0.06)", border: "1px solid rgba(61,220,132,0.35)", clipPath: SHELL_NOTCH(7), flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, color: "#9af5c2", fontWeight: 700 }}>✓ Connected</span>
                {dc.handle && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, color: "#ecf3ff" }}>{dc.handle}</span>}
              </div>
            : <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 8px 8px 12px", background: "rgba(10,16,30,0.75)", border: "1px solid rgba(125,166,255,0.42)", clipPath: SHELL_NOTCH(7), flexWrap: "wrap" }}>
                <span style={{ fontSize: 14, color: "rgba(224,233,255,0.85)", flex: "1 1 120px" }}>Not connected yet</span>
                <button disabled={dcBusy} onClick={async () => { setDcBusy(true); try { await startDiscordOAuth(resume || { kind: "profile" }); } catch { setDcBusy(false); } }}
                  style={shellBtn("primary", { padding: "8px 14px", fontSize: 12, whiteSpace: "nowrap" })}>{dcBusy ? "…" : "Connect Discord"}</button>
              </div>}
          <span style={helpS}>Lets VOLT DM you about drafts and matches. Anything you've typed is kept while you connect.</span>
        </div>
        <label style={{ display: "block" }}><span style={labS}>WhatsApp number</span>
          <input value={d.whatsapp} inputMode="tel" placeholder="e.g. 923001234567" onChange={e => setD({ ...d, whatsapp: e.target.value })} style={fieldS} />
          <span style={helpS}>Start with your country code. Only the host and moderators can see it, and only if you don't answer on Discord.</span>
        </label>

        <div style={groupS}>Optional <span style={{ fontFamily: READ_FONT, fontSize: 13, fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "rgba(214,226,255,0.74)" }}>· helps captains bid on you</span></div>
        <div style={twoCol}>
          <label><span style={labS}>Peak rank</span>
            <select value={d.peakRank} onChange={e => setD({ ...d, peakRank: e.target.value, peakRankDiv: hasDivisions(e.target.value) ? d.peakRankDiv : "" })} style={fieldS}>
              <option value="">None</option>{Object.keys(RANKS).map(r => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <label><span style={labS}>Peak division</span>
            <select value={d.peakRankDiv} disabled={!hasDivisions(d.peakRank)} onChange={e => setD({ ...d, peakRankDiv: e.target.value })}
              style={{ ...fieldS, opacity: hasDivisions(d.peakRank) ? 1 : 0.55 }}>
              <option value="">{d.peakRank === "Radiant" ? "n/a" : "—"}</option>{RANK_DIVS.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <label style={{ gridColumn: "1 / -1" }}><span style={labS}>Main agent</span>
            <input value={d.agent} onChange={e => setD({ ...d, agent: e.target.value })} style={fieldS} /></label>
          {[["kda", "KDA"], ["acs", "ACS"], ["hs", "HS %"], ["win", "Win %"]].map(([k, label]) => (
            <label key={k}><span style={labS}>{label}</span>
              <input value={d[k]} inputMode="decimal" onChange={e => setD({ ...d, [k]: e.target.value.replace(/[^0-9.]/g, "") })} style={fieldS} /></label>))}
          <label style={{ gridColumn: "1 / -1" }}><span style={labS}>Tracker link</span>
            <input value={d.tracker} placeholder="tracker.gg/valorant/profile/riot/yourname" onChange={e => setD({ ...d, tracker: e.target.value })} style={fieldS} /></label>
        </div>

        {(() => {
          const need = [];
          if (!d.ign.trim()) need.push("Valorant name");
          if (!d.rank) need.push("rank");
          if (!d.role) need.push("role");
          if (!dc.linked && !dc.handle) need.push("Discord");
          if ((d.whatsapp || "").replace(/[^0-9]/g, "").length < 8) need.push("WhatsApp number");
          const blocked = busy || need.length > 0;
          return <>
            {saveErr && <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "#ff8f9a", marginBottom: 10 }}>⚠ {saveErr}</div>}
            {!saveErr && need.length > 0 && <div style={{ fontSize: 13.5, lineHeight: 1.45, color: "rgba(224,233,255,0.85)", marginBottom: 10 }}>Still needed: {need.join(", ")}</div>}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button disabled={blocked} onClick={save} style={shellBtn("primary", { flex: embedded ? "1 1 100%" : "0 0 auto", padding: "13px 20px", fontSize: 13, opacity: blocked ? 0.5 : 1, cursor: blocked ? "not-allowed" : "pointer" })}>{busy ? "Saving…" : embedded ? "Save and continue →" : "Save"}</button>
              {/* In the sign-up dialog the ✕ already does this. */}
              {!embedded && <button onClick={() => { clearDraft(); setEditing(false); load(); }} style={shellBtn("ghost", { padding: "13px 20px", fontSize: 13 })}>Cancel</button>}
            </div>
          </>;
        })()}
      </>}
    </div>
  );
}

export default function App() { return <><VoltGate /><VoltDialogHost /><VoltToastHost /></>; }

// Shared with tournament.jsx (the lazily loaded tournament shell).
export {
  ART, AccountChip, AccountView, Bar, Cell, CountUp, DASH_CSS, DEMO,
  DiscordLinkCard, Empty, FirstTimeOnboard, HAS_SUPABASE, Icon, KeyArt, LeagueLockup, LeagueSwitch,
  MOBILE_CSS, NAV, NotifBell, PANEL, PHASE_COLOR, PHASE_LABEL, Pip, PlayToggle,
  PlayerProfile, RANKS, RANK_LIST, READ_FONT, ROLE_GLYPH, RankCrest, SEC_LABEL, SEC_RULE,
  SHELL_NOTCH, SWEEP_CSS, ScoutProfileCard, SectionHead, ShellStyles, StatRadar, SubDesk, TABBAR,
  TOPBAR, TOPBAR_LINE, TOURNEY_NAV, TeamMono, VoltDateTime, VoltOverlay, __openDialog, __sb,
  activeStrikeCount, downscaleImage, fmt, glyphNode, hasDivisions, loadDemo, loadProfileGate, perfOf,
  profileIsComplete, rankLabel, rankOf, shellBtn, useNarrow, visInterval, voltConfirm, voltNotify,
  voltNow, voltToast, weekendName,
};
