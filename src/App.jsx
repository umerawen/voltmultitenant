import { useState, useEffect, useRef, useCallback } from "react";
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
let __sb = null;
if (HAS_SUPABASE) __sb = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);

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
        const { data: meta } = await probe.maybeSingle();
        if (!meta) return null;
        if (sinceUpdatedAt && meta.updated_at && meta.updated_at <= sinceUpdatedAt) {
          return { unchanged: true, updatedAt: meta.updated_at };
        }
        // 2) It changed (or caller had nothing) → fetch the full value once.
        let full = __sb.from("community_kv").select("val, updated_at").eq("community_id", cid).eq("k", key).eq("shared", !!shared);
        if (!shared) full = full.eq("user_id", window.__VOLT.userId);
        const { data } = await full.maybeSingle();
        return data ? { key, value: data.val, updatedAt: data.updated_at, shared: !!shared } : null;
      } catch (e) { console.error("storage.getIfChanged", e); return memGet(key, shared); }
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
const IMG_HERO = "/img/hero.webp";


/* ════════════════════════════════════════════════════════════════════
   VOLT PROTOCOL — Community Valorant Auction Draft
   4 routed screens · live-synced via shared storage
   Lobby · Scout Hub · Auction Block · Locker Room
   ════════════════════════════════════════════════════════════════════ */

// The board key is scoped per tournament so each tournament runs its own isolated
// draft (within its community, which the storage layer already scopes).
// window.__VOLT.weekendId is set by the season shell; null → the community's
// standing/default board (back-compatible with the old single-board behavior).
const STORE_KEY_BASE = "volt-auction-v2";
function boardKey() {
  const w = (typeof window !== "undefined" && window.__VOLT && window.__VOLT.weekendId) || null;
  return w ? `${STORE_KEY_BASE}::${w}` : STORE_KEY_BASE;
}
const POLL_MS = 2500;        // active-tab auction poll (was 1500 — every 300ms saved adds up across clients)
const POLL_MS_SAFETY = 20000; // Realtime is up — poll only to catch a dead socket
const POLL_MS_HOT = 1200;    // a player is on the block: bids are contended, so sync hard. With
                             // conditional GET an extra poll is a ~43-byte probe — the full board
                             // only downloads when it actually changed, so this costs almost nothing.
const POLL_MS_HIDDEN = 15000; // hidden tab: still sync, but rarely (conditional GET makes these near-free anyway)

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

// Hardcoded access codes (baked into the build — nobody sets these in-app).
// Host: 1218.  Captains: by seat order, seat 1 → "0001" ... seat 8 → "0008".
const COMMISH_CODE = "1218";
const seatCode = (seatIndex) => String(seatIndex + 1).padStart(4, "0"); // 0-based index → "0001".."0008"



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
// Ranks arrive from player_profiles.rank, a free-text column with no CHECK —
// so an unexpected value (legacy row, hand-edited data) must not crash a lookup.
// Everything that indexes RANKS from data should go through these.
const rankKey = (r) => (RANKS[r] ? r : "Silver");
const rankOf = (r) => RANKS[r] || RANKS.Silver;
// Divisions are display only. The tier stays in `rank` because bid values,
// filters and sorting all key off it — folding "Platinum 3" into one string
// would mean every one of those lookups has to parse it back apart.
const RANK_DIVS = [1, 2, 3];
const hasDivisions = (r) => !!RANKS[r] && r !== "Radiant";
const rankLabel = (r, div) => (r ? r + (hasDivisions(r) && div ? ` ${div}` : "") : "—");
const ROLES = ["Duelist", "Initiator", "Controller", "Sentinel", "Flex"];
const ROLE_GLYPH = { Duelist: "◆", Initiator: "▲", Controller: "●", Sentinel: "■", Flex: "✦" };
const AGENTS = ["Jett","Reyna","Raze","Phoenix","Neon","Yoru","Iso","Omen","Brimstone","Viper","Astra","Harbor","Clove","Sova","Skye","Breach","Fade","KAY/O","Gekko","Killjoy","Cypher","Sage","Chamber","Deadlock","Vyse"];

const TEAM_HUES = ["#ff4655", "#00e5ff", "#9d6bff", "#5ad1ff", "#ff8a3d", "#e35cff", "#3ddc84", "#f5c453", "#ff6fae", "#7c9cff", "#ffd24a", "#4dd6c1"];
const MIN_TEAMS = 2;   // no maximum — a league runs as many teams as it has captains

// Team colour for the nth team. The hand-picked palette covers the first dozen;
// past that, colours are generated on the golden angle so a 20-team league still
// gets visually distinct teams instead of team 13 looking identical to team 1.
function teamHue(i) {
  if (i < TEAM_HUES.length) return TEAM_HUES[i];
  const h = (i * 137.508) % 360;                  // golden angle → maximally spread
  const l = 58 + ((i % 3) - 1) * 7;               // nudge lightness so neighbours differ
  return `hsl(${h.toFixed(0)}, 78%, ${l}%)`;
}

// No demo teams/players: a real league seeds itself from registrations. An
// empty board is the honest empty state — fake operators in the Scout Hub read
// as real ones and get scouted, tagged, and drafted by mistake.

const uid = () => Math.random().toString(36).slice(2, 10);

// Tally win/loss/points across all of a tournament's tournament matches (+3 per win),
// used to snapshot standings into the season log at settle time.
function computeSeasonPoints(s) {
  const t = s.tournament; if (!t) return [];
  const acc = {};
  const ensure = (id) => { if (id && !acc[id]) acc[id] = { teamId: id, won: 0, lost: 0, pts: 0 }; };
  const allMatches = [];
  if (t.groups) Object.values(t.groups).forEach(g => (g.matches || []).forEach(m => allMatches.push(m)));
  if (Array.isArray(t.matches)) t.matches.forEach(m => allMatches.push(m));
  else if (t.matches && typeof t.matches === "object") Object.values(t.matches).forEach(a => Array.isArray(a) && a.forEach(m => allMatches.push(m)));
  if (t.rounds) t.rounds.forEach(r => (r || []).forEach(m => allMatches.push(m)));
  for (const m of allMatches) {
    if (!m || !m.done || m.teamA == null || m.teamB == null) continue;
    ensure(m.teamA); ensure(m.teamB);
    if (m.winner === m.teamA) { acc[m.teamA].won++; acc[m.teamA].pts += 3; acc[m.teamB].lost++; }
    else if (m.winner === m.teamB) { acc[m.teamB].won++; acc[m.teamB].pts += 3; acc[m.teamA].lost++; }
  }
  return Object.values(acc);
}


// Tournament display name from its date — "Jul 20–21" (Sat–Sun) with an
// optional nickname. Falls back to the legacy counter label when no date exists.
// A tournament is Sat–Sun; starts_on is the Saturday.
// Module scope, not component scope: the signup-guide builder sits above the
// schedule component and needs these too, and a phase should read identically
// wherever it appears.
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

// Normalize a registration row (as returned by fetchRosterForEvent, which keys
// people by `userId`) into a board player keyed by `id`. Shared by freshState
// and the live registration preview so both produce identical shapes — folding
// a raw registration row straight into state.players yields a card with no id
// and no rank, which then breaks every lookup that assumes a real player.
function regToPlayer(p, isCap) {
  return {
    id: p.userId, status: "pool", soldTo: null, soldPrice: null,
    ...(isCap ? { isCaptain: true } : {}),
    name: p.name, rank: rankKey(p.rank), rankDiv: p.rankDiv ?? null,
    peakRank: p.peakRank ?? null, peakRankDiv: p.peakRankDiv ?? null,
    role: p.role || "Flex", agent: p.agent || "—",
    kda: p.kda ?? null, acs: p.acs ?? null, hs: p.hs ?? null, win: p.win ?? null,
    badges: p.badges || [], tracker: p.tracker || null, trophies: p.trophies || 0,
    discord: p.discord || null,
    poolEligible: p.poolEligible !== false,
    // false once they've tapped "Can't make it" — the Reserve Hub has to show
    // this or a captain will call someone who has already said no.
    available: p.available !== false,
  };
}

// A player the host typed in by hand has a short generated id; anyone
// who registered carries their auth uuid. Manual entries have no registration
// to rebuild from, so they must be carried across board rebuilds explicitly.
const isManualPlayer = (p) => !(typeof p?.id === "string" && p.id.length > 30);

// The league owner, strictly — moderators are staff but do NOT run the live
// auction. Undefined means the no-Supabase preview, where everything is allowed.
const isLeagueOwner = () => window.__VOLT?.isHost !== false;

function freshState(captains, poolPlayers) {  // captains: optional [{ userId, name, teamName? }] from the real community.
  // When present, teams are built from real registered captains (each tied to a
  // userId so login-based seat claiming maps to the right seat). Otherwise the
  // old demo seeds are used (preview / first-run before captains exist).
  // poolPlayers: optional [{ userId, name, rank, role, agent, kda, acs, hs, win, badges }]
  // — the tournament's registered (non-captain) players with their scouting stats.
  const capList = (captains && captains.length) ? captains : [];
  const poolList = (poolPlayers && poolPlayers.length) ? poolPlayers : [];
  // Teams need at least MIN_TEAMS captains to be a real draft. Below that the
  // board stays team-less while sign-ups run — but everyone who registered is
  // still listed below, so the Scout Hub fills up from the first registration.
  const teamDefs = capList.length >= MIN_TEAMS
    ? capList.map((c, i) => ({
        name: c.teamName || `TEAM ${String(i + 1).padStart(2, "0")}`,
        captain: c.name,
        captainUserId: c.userId,
        hue: teamHue(i),
      }))
    : [];
  const poolDefs = [
    ...capList.map((c) => regToPlayer(c, true)),
    ...poolList.map((p) => regToPlayer(p, false)),
  ];
  return {
    v: 2,
    teams: teamDefs.map((t, i) => ({ id: "t" + (i + 1), ...t, budget: 10000, roster: [] })),
    players: poolDefs,
    block: null,
    spin: null,
    draftAt: null, // auction start comes from the tournament (events.draft_at)
    commishCode: null, // set by the first host; required thereafter
    teamCodes: {}, // { teamId: passcode } gating each captain's War Room; set once by that captain
    bidHistory: [],   // [{teamId, amount, ts}] for active block
    soldFlash: null,  // ts of last sale (for red flash)
    lastSoldTo: null, // teamId that secured the most recent sale (for won/lost audio)
    recentSales: [],  // [{playerId, name, teamId, price, bidCount, ts}] newest-first, for the auction feed ticker
    tournament: null, // { format, matchType, groups, matches, slots, ... } — built by Host
    log: [],
    stamp: Date.now(),
  };
}

// Board-read cache, keyed by boardKey(), so polling can use a conditional GET:
// when the row hasn't changed since we last read it, nothing is downloaded and
// we hand back the parsed object we already have. This is what keeps a live
// auction (8+ clients polling every ~2s) from re-downloading the whole board
// blob on every tick — the dominant source of Supabase egress.
const __boardCache = new Map(); // key -> { updatedAt, parsed }
async function readState() {
  const key = boardKey();
  try {
    const cached = __boardCache.get(key);
    const r = await window.storage.getIfChanged(key, true, cached ? cached.updatedAt : null);
    if (!r) { __boardCache.delete(key); return null; }        // row gone
    if (r.unchanged) return cached ? cached.parsed : null;    // nothing downloaded
    const parsed = JSON.parse(r.value);
    __boardCache.set(key, { updatedAt: r.updatedAt, parsed });
    return parsed;
  } catch { const cached = __boardCache.get(key); return cached ? cached.parsed : null; }
}
// The updatedAt this client last saw for the board — the version token that
// makes a write conditional. Null means we've never read it, so the write goes
// through unconditionally.
function boardVersion() {
  const c = __boardCache.get(boardKey());
  return c ? c.updatedAt : null;
}
// Unconditional write — for building, rebuilding and resetting the board, where
// overwriting whatever is there IS the intent.
async function writeState(s) {
  if (!s.stamp) s.stamp = Date.now();
  const key = boardKey();
  const json = JSON.stringify(s);
  // Deliberately NOT swallowing errors: a silent failure here is what made
  // edits appear to "revert" — the UI kept the optimistic value while the
  // server never received it, then the next poll painted the old state back.
  const r = await window.storage.cas(key, null, json);
  // Prime the cache with the server's own updated_at so our next poll neither
  // re-downloads what we just wrote nor misses what someone else writes next.
  if (r && r.updatedAt) __boardCache.set(key, { updatedAt: r.updatedAt, parsed: JSON.parse(json) });
  else __boardCache.delete(key);
  return s;
}
// Conditional write — lands only if nobody else has written since we last read.
// On conflict, returns the state that won so the caller can re-apply on top of
// it. This is what stops two simultaneous bids from erasing each other.
async function writeStateChecked(s, expected) {
  if (!s.stamp) s.stamp = Date.now();
  const key = boardKey();
  const json = JSON.stringify(s);
  const r = await window.storage.cas(key, expected, json);
  if (r.ok) {
    if (r.updatedAt) __boardCache.set(key, { updatedAt: r.updatedAt, parsed: JSON.parse(json) });
    return { ok: true, state: s };
  }
  let current = null;
  try { current = r.value ? JSON.parse(r.value) : null; } catch { current = null; }
  if (current && r.updatedAt) __boardCache.set(key, { updatedAt: r.updatedAt, parsed: current });
  return { ok: false, current };
}

/* ── private (per-captain) war-room storage: shared=false keeps it off the synced board ── */
const warRoomKey = (teamId) => `volt-warroom-${teamId}`;
async function readWarRoom(teamId) {
  try { const r = await window.storage.get(warRoomKey(teamId), false); return r ? JSON.parse(r.value) : null; }
  catch { return null; }
}
async function writeWarRoom(teamId, data) {
  try { await window.storage.set(warRoomKey(teamId), JSON.stringify(data), false); } catch (e) { console.error(e); }
}

/* ════════════════════════════════════════════════════════════════════
   TOURNAMENT ENGINE — pure helpers for groups, brackets & standings.
   Formats: "group" (N groups, round-robin each, top advances to final),
            "roundrobin" (one table, everyone plays once),
            "single" (single-elimination bracket).
   A match: { id, teamA, teamB, bo, maps:[{a,b}], done, winner }
     - bo: 1 or 3 (best-of). maps holds per-map scores {a,b}.
     - winner: teamId or null. For byes, teamB=null and winner=teamA.
   ════════════════════════════════════════════════════════════════════ */
const tuid = () => "m" + Math.random().toString(36).slice(2, 9);

// stats label linking a fixture to its match_results rows (must stay stable)
function fxLabel(a, b, match) {
  return a && b ? `${a.name} vs ${b.name}${match.id ? " · " + String(match.id).slice(-4).toUpperCase() : ""}` : null;
}
// round-robin pairing for a list of teamIds (each plays each once)
function roundRobinMatches(teamIds, bo) {
  const ms = [];
  for (let i = 0; i < teamIds.length; i++)
    for (let j = i + 1; j < teamIds.length; j++)
      ms.push({ id: tuid(), teamA: teamIds[i], teamB: teamIds[j], bo, maps: [], done: false, winner: null });
  return ms;
}

// League Play fixtures — no bracket. Circle-method rotation for 4 rounds so
// every team plays 4 matches per tournament (vs 4 different opponents when the
// team count allows; small leagues see a rematch, odd counts a bye per round).
function leagueMatches(teamIds, bo) {
  const arr = [...teamIds];
  if (arr.length % 2) arr.push(null); // bye slot
  const n = arr.length, ms = [];
  const rounds = Math.min(4, Math.max(1, 4)); // 4 matches per team per tournament
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n / 2; i++) {
      const a = arr[i], b = arr[n - 1 - i];
      if (a != null && b != null) ms.push({ id: tuid(), round: r + 1, teamA: a, teamB: b, bo, maps: [], done: false, winner: null });
    }
    arr.splice(1, 0, arr.pop()); // rotate, first seat fixed
  }
  return ms;
}

// next power of two >= n
const nextPow2 = (n) => { let p = 1; while (p < n) p *= 2; return p; };

// build a single-elim bracket from an ordered slot list (may contain nulls for empty slots)
function buildSingleElim(slotIds, bo) {
  const size = Math.max(nextPow2(slotIds.length || 2), 2);
  const seeds = slotIds.slice(0, size);
  while (seeds.length < size) seeds.push(null);
  const rounds = [];
  // round 0: pair 0-1, 2-3, ...
  let r0 = [];
  for (let i = 0; i < size; i += 2) {
    const a = seeds[i], b = seeds[i + 1];
    const m = { id: tuid(), teamA: a, teamB: b, bo, maps: [], done: false, winner: null };
    if (a && !b) { m.done = true; m.winner = a; }       // bye
    else if (!a && b) { m.done = true; m.winner = b; }   // bye
    r0.push(m);
  }
  rounds.push(r0);
  // subsequent rounds: empty matches fed by winners
  let count = r0.length;
  while (count > 1) {
    const r = [];
    for (let i = 0; i < count; i += 2)
      r.push({ id: tuid(), teamA: null, teamB: null, bo, maps: [], done: false, winner: null, from: [count > 0 ? i : null, i + 1] });
    rounds.push(r);
    count = r.length;
  }
  return rounds;
}

// has this match been decided by its map scores? sets winner + returns it
function resolveMatch(m) {
  if (m.teamB == null) { m.done = !!m.teamA; m.winner = m.teamA || null; return m; }
  const need = m.bo === 3 ? 2 : 1;
  let aw = 0, bw = 0;
  for (const mp of (m.maps || [])) {
    if (mp.a == null || mp.b == null) continue;
    if (mp.a > mp.b) aw++; else if (mp.b > mp.a) bw++;
  }
  if (aw >= need) { m.done = true; m.winner = m.teamA; }
  else if (bw >= need) { m.done = true; m.winner = m.teamB; }
  else { m.done = false; m.winner = null; }
  return m;
}

// round tallies for one team from one resolved match (sum of all map rounds)
function matchTally(m, teamId) {
  let rf = 0, ra = 0;
  for (const mp of (m.maps || [])) {
    if (mp.a == null || mp.b == null) continue;
    if (m.teamA === teamId) { rf += mp.a; ra += mp.b; }
    else if (m.teamB === teamId) { rf += mp.b; ra += mp.a; }
  }
  return { rf, ra };
}

// standings table for a set of teamIds across a set of matches
// returns sorted rows: { teamId, played, won, lost, pts, rf, ra, diff }
function computeStandings(teamIds, matches, overrides) {
  const row = {};
  teamIds.forEach((id) => { row[id] = { teamId: id, played: 0, won: 0, lost: 0, pts: 0, rf: 0, ra: 0, diff: 0 }; });
  for (const m of matches) {
    if (!m.done || m.teamA == null || m.teamB == null) continue;
    if (!row[m.teamA] || !row[m.teamB]) continue;
    const ta = matchTally(m, m.teamA), tb = matchTally(m, m.teamB);
    row[m.teamA].rf += ta.rf; row[m.teamA].ra += ta.ra;
    row[m.teamB].rf += tb.rf; row[m.teamB].ra += tb.ra;
    row[m.teamA].played++; row[m.teamB].played++;
    if (m.winner === m.teamA) { row[m.teamA].won++; row[m.teamA].pts += 3; row[m.teamB].lost++; }
    else if (m.winner === m.teamB) { row[m.teamB].won++; row[m.teamB].pts += 3; row[m.teamA].lost++; }
  }
  let rows = teamIds.map((id) => { const r = row[id]; r.diff = r.rf - r.ra; return r; });
  // apply manual overrides (host can hand-edit pts/diff)
  if (overrides) rows = rows.map((r) => overrides[r.teamId] ? { ...r, ...overrides[r.teamId], _ov: true } : r);
  // head-to-head helper between two teams
  const h2h = (x, y) => {
    for (const m of matches) {
      if (!m.done) continue;
      if ((m.teamA === x && m.teamB === y) || (m.teamA === y && m.teamB === x)) {
        if (m.winner === x) return -1; if (m.winner === y) return 1;
      }
    }
    return 0;
  };
  rows.sort((a, b) =>
    b.pts - a.pts || b.diff - a.diff || b.rf - a.rf || h2h(a.teamId, b.teamId) || 0
  );
  return rows;
}

// locate a match inside a tournament by locator: {kind, ...}
//  group: {kind:"group", groupId, matchId}  | rr: {kind:"rr", matchId}
//  final: {kind:"final"} | elim: {kind:"elim", round, idx}
function findMatch(t, loc) {
  if (!loc) return null;
  if (loc.kind === "group") return (t.matches?.[loc.groupId] || []).find((m) => m.id === loc.matchId) || null;
  if (loc.kind === "rr") return (t.matches || []).find((m) => m.id === loc.matchId) || null;
  if (loc.kind === "final") return t.final || null;
  if (loc.kind === "elim") return t.rounds?.[loc.round]?.[loc.idx] || null;
  return null;
}

// after a single-elim result, feed winners into the next round's matches
function propagateElim(t) {
  if (!t.rounds) return;
  for (let r = 0; r < t.rounds.length - 1; r++) {
    const next = t.rounds[r + 1];
    t.rounds[r].forEach((m, i) => {
      const slot = Math.floor(i / 2);
      const isA = i % 2 === 0;
      const nm = next[slot]; if (!nm) return;
      const w = m.done ? m.winner : null;
      if (isA) { if (nm.teamA !== w) { nm.teamA = w; if (!nm.done) { nm.maps = []; nm.winner = null; } } }
      else { if (nm.teamB !== w) { nm.teamB = w; if (!nm.done) { nm.maps = []; nm.winner = null; } } }
      resolveMatch(nm);
    });
  }
}

const fmt = (n) => "$" + Number(n || 0).toLocaleString();

// aggregate a player's per-match tournament stats: K/D/A totaled, ACS averaged
const emptySlots = (t) => 4 - ((t?.roster || []).length);

// Starting-bid value for an available player (rank-priced). Lower = cheaper.
const playerBidValue = (p) => (rankOf(p.rank)?.bid ?? 0);

// The N cheapest available players' starting bids, summed.
// `availablePlayers` = the live pool (status === "pool"), i.e. NOT the player on the block and NOT sold.
// N = roster slots this captain must still fill AFTER the current pick succeeds.
//   Each captain drafts 4 players, so after winning the player on the block they have
//   (4 - roster.length - 1) slots left. Clamped at 0 (never negative).
const reserveFor = (t, availablePlayers) => {
  const slotsAfterThisPick = Math.max(4 - t.roster.length - 1, 0);
  if (slotsAfterThisPick === 0) return 0;
  // sort by actual starting-bid value (not rank label) so equal-priced ranks tie correctly
  const cheapest = availablePlayers
    .map(playerBidValue)
    .sort((a, b) => a - b)
    .slice(0, slotsAfterThisPick);
  return cheapest.reduce((sum, v) => sum + v, 0);
};

// Live max bid: budget minus the reserve needed to still fill remaining slots
// from the cheapest players left in the pool. Recomputed against the live pool,
// so any captain buying a cheap player shifts every captain's ceiling.
const maxAllowedBid = (t, availablePlayers = []) => t.budget - reserveFor(t, availablePlayers);
const requiredBid = (b) => (b.leaderId ? b.currentBid + 100 : b.startingBid);

/* ════════════════ atoms ═══════════════════════════════════════════ */

/* ════════════════════════════════════════════════════════════════════
   TOURNAMENT UI — Host builds & runs brackets; everyone watches.
   ════════════════════════════════════════════════════════════════════ */

// notched HUD panel wrapper
function TPanel({ children, hue = "#3d7bff", className = "", style = {} }) {
  return (
    <div className={"relative p-5 " + className} style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.05), rgba(10,15,28,0.5))", border: `1px solid ${hue}33`, clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", backdropFilter: "blur(8px)", ...style }}>
      <span className="absolute left-0 top-0" style={{ width: 11, height: 11, borderLeft: `2px solid ${hue}`, borderTop: `2px solid ${hue}` }} />
      {children}
    </div>
  );
}

// a small team chip
function TTeamChip({ team, onClick, active, sub }) {
  if (!team) return <span className="uppercase tracking-widest" style={{ fontSize: 14, color: "rgba(200,215,255,0.3)", fontFamily: "'Rajdhani',sans-serif" }}>— TBD —</span>;
  return (
    <button onClick={onClick} disabled={!onClick} className="flex items-center gap-2 px-3 py-2 transition-all"
      style={{ cursor: onClick ? "pointer" : "default", background: active ? team.hue + "22" : "rgba(255,255,255,0.03)", border: `1px solid ${active ? team.hue : "rgba(120,150,220,0.18)"}`, clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))" }}>
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: team.hue }} />
      <span className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 16, color: team.hue, letterSpacing: "0.03em" }}>{team.name}</span>
      {sub && <span style={{ fontSize: 13, color: "rgba(200,215,255,0.4)", fontFamily: "'IBM Plex Mono',monospace" }}>{sub}</span>}
    </button>
  );
}

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

// ── Match scheduling — green time chip everyone sees; hosts get the picker ──
function MatchSchedule({ match, locator, isAdmin, onSetTime }) {
  const iso = match.scheduledAt || null;
  const toLocalInput = (v) => {
    if (!v) return "";
    const d = new Date(v); if (isNaN(d)) return "";
    const p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const pretty = iso ? (() => {
    const d = new Date(iso); if (isNaN(d)) return null;
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }).toUpperCase()
      + ", " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  })() : null;
  if (!pretty && !isAdmin) return null;
  return (
    <div className="flex items-center justify-center gap-2 flex-wrap">
      {pretty && (
        <span className="inline-flex items-center gap-2" style={{ padding: "6px 13px", background: "rgba(61,220,132,0.1)", border: "1px solid rgba(61,220,132,0.4)", clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>
          <span style={{ color: "#3ddc84", fontSize: 12 }}>◷</span>
          <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 12.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#9af5c2" }}>{pretty}</span>
        </span>
      )}
      {isAdmin && onSetTime && (
        <VoltDateTime value={iso} onChange={(v) => onSetTime(locator, v)} placeholder="Set match time" />
      )}
    </div>
  );
}

// ── Final prediction — one vote per person, publicly attributed. Expand to
//    see who backed which side. Locks once the match is played. ──
function MatchPrediction({ match, locator, a, b, onVote }) {
  const [open, setOpen] = useState(false);
  const votes = match.votes && typeof match.votes === "object" ? match.votes : {};
  const list = Object.entries(votes);
  const aV = list.filter(([, v]) => v.side === "a");
  const bV = list.filter(([, v]) => v.side === "b");
  const total = list.length;
  const uid = window.__VOLT?.userId;
  const mine = uid ? votes[uid]?.side : null;
  const canVote = !!(onVote && uid && !match.done && a && b);
  if (!a || !b) return null;
  if (match.done && total === 0) return null;
  const aPct = total ? (aV.length / total) * 100 : 50;
  const hueA = a.hue, hueB = b.hue;
  const side = (label, arr, hue, align) => (
    <div style={{ flex: 1, minWidth: 0, padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: `1px solid ${hue}33`, clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))" }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: hue, textAlign: align }}>{label} · {arr.length}</div>
      <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.6)", marginTop: 5, lineHeight: 1.5, textAlign: align }}>
        {arr.length ? arr.map(([, v]) => v.name).join(", ") : "—"}
      </div>
    </div>
  );
  return (
    <div style={{ borderTop: "1px dashed rgba(120,150,220,0.18)", paddingTop: 9, marginTop: 2 }}>
      <div className="flex items-center justify-between gap-2">
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(160,185,235,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>
          Final prediction{mine ? <span style={{ color: "#7da6ff" }}> · you picked {mine === "a" ? a.name : b.name}</span> : null}
        </span>
        <button onClick={() => setOpen(o => !o)} disabled={!total}
          style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: total ? "rgba(200,215,255,0.55)" : "rgba(200,215,255,0.25)", background: "none", border: "none", cursor: total ? "pointer" : "default", fontFamily: "'Rajdhani',sans-serif" }}>
          {total} vote{total === 1 ? "" : "s"} {total ? (open ? "▲" : "▼") : ""}
        </button>
      </div>
      {/* split bar */}
      <div className="flex" style={{ height: 7, marginTop: 7, background: "rgba(255,255,255,0.05)", overflow: "hidden" }}>
        <div style={{ width: `${total ? aPct : 50}%`, background: hueA, opacity: total ? 1 : 0.25, transition: "width .25s ease" }} />
        <div style={{ flex: 1, background: hueB, opacity: total ? 1 : 0.25 }} />
      </div>
      {open && total > 0 && (
        <div className="flex gap-2 mt-2.5 flex-wrap">
          {side(a.name, aV, hueA, "left")}
          {side(b.name, bV, hueB, "right")}
        </div>
      )}
      {canVote && (
        <div className="flex items-center justify-center gap-2 mt-2.5">
          {[["a", a, hueA], ["b", b, hueB]].map(([sd, tm, hue]) => (
            <button key={sd} onClick={() => onVote(locator, sd)}
              style={{ flex: 1, maxWidth: 200, padding: "7px 12px", fontSize: 11, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", fontFamily: "'Rajdhani',sans-serif", cursor: "pointer",
                background: mine === sd ? `${hue}26` : "rgba(255,255,255,0.03)",
                border: `1px solid ${mine === sd ? hue : "rgba(120,150,220,0.22)"}`,
                color: mine === sd ? hue : "rgba(200,215,255,0.6)",
                clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))" }}>
              {mine === sd ? "✓ " : ""}{tm.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Format switcher — swap the tournament's bracket format in place. Played
//    fixtures for the same team pairing are carried over (same match id), so
//    reported stats stay linked and every leaderboard keeps reading the same
//    match_results rows regardless of format. ──
function FormatSwitcher({ t, actions }) {
  const [open, setOpen] = useState(false);
  const [fmt, setFmt] = useState(t.format === "league" ? "roundrobin" : t.format);
  const [bo, setBo] = useState(t.bo === 3 ? "bo3" : "bo1");
  const [groups, setGroups] = useState(t.groups?.length || 2);
  const OPTS = [
    { id: "league", name: "League", desc: "Auto round-robin — the standard tournament." },
    { id: "group", name: "Group Stage", desc: "Groups, then a final." },
    { id: "single", name: "Single Elim", desc: "Straight knockout bracket." },
    { id: "roundrobin", name: "Round Robin", desc: "One table, everyone once." },
  ];
  return (
    <>
      <button onClick={() => setOpen(true)} className="text-xs uppercase tracking-widest px-3 py-1.5"
        style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif", border: "1px solid rgba(61,123,255,0.35)", background: "rgba(61,123,255,0.06)" }}>⇄ Change format</button>
      {open && (
        <VoltOverlay onClose={() => setOpen(false)} zIndex={130} dim="rgba(4,6,12,0.85)">
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", padding: "24px 26px", fontFamily: "'Rajdhani',sans-serif" }}>
            <div className="flex items-center justify-between gap-3">
              <span style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// Change format</span>
              <button onClick={() => setOpen(false)} style={{ background: "none", border: "1px solid rgba(120,150,220,0.3)", color: "rgba(200,215,255,0.6)", padding: "4px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
            </div>
            <p style={{ fontSize: 13, color: "rgba(200,215,255,0.6)", margin: "10px 0 16px", lineHeight: 1.5 }}>
              Matches already played are kept — if the same two teams meet in the new format, their score, time and votes carry over. Player points are never affected.
            </p>
            <div className="grid sm:grid-cols-2 gap-2 mb-4">
              {OPTS.map((o) => (
                <button key={o.id} onClick={() => setFmt(o.id)} style={{ textAlign: "left", padding: "11px 13px", cursor: "pointer",
                  background: fmt === o.id ? "rgba(61,123,255,0.14)" : "rgba(255,255,255,0.03)",
                  border: `1px solid ${fmt === o.id ? "#3d7bff" : "rgba(120,150,220,0.2)"}`,
                  clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: fmt === o.id ? "#ecf3ff" : "rgba(200,215,255,0.75)" }}>{o.name}</div>
                  <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)", marginTop: 2 }}>{o.desc}</div>
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3 flex-wrap mb-5">
              <span style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(200,215,255,0.5)", fontWeight: 700 }}>Match type</span>
              {["bo1", "bo3"].map((b) => (
                <button key={b} onClick={() => setBo(b)} style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", cursor: "pointer",
                  background: bo === b ? "rgba(61,123,255,0.16)" : "transparent", border: `1px solid ${bo === b ? "#3d7bff" : "rgba(120,150,220,0.25)"}`, color: bo === b ? "#ecf3ff" : "rgba(200,215,255,0.55)" }}>{b.toUpperCase()}</button>
              ))}
              {fmt === "group" && (
                <>
                  <span style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(200,215,255,0.5)", fontWeight: 700, marginLeft: 6 }}>Groups</span>
                  <input type="number" min="2" max="8" value={groups} onChange={(e) => setGroups(Number(e.target.value) || 2)}
                    style={{ width: 60, padding: "6px 8px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(61,123,255,0.3)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }} />
                </>
              )}
            </div>
            <button onClick={() => { actions.tSwitchFormat(fmt, bo, groups); setOpen(false); }}
              style={{ width: "100%", padding: "13px", fontSize: 13, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase", cursor: "pointer",
                background: "rgba(61,123,255,0.16)", border: "1px solid #3d7bff", color: "#ecf3ff",
                clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))" }}>
              Switch to {OPTS.find((o) => o.id === fmt)?.name} →
            </button>
            <p style={{ fontSize: 11.5, color: "rgba(200,215,255,0.4)", marginTop: 10, textAlign: "center" }}>You'll re-seed the teams, then lock it in.</p>
          </div>
        </VoltOverlay>
      )}
    </>
  );
}

// editable score row for a single match
function TMatchRow({ match, locator, teamOf, isAdmin, onSetMap, onSetBo, onSetTime, onVote }) {
  const a = teamOf(match.teamA), b = teamOf(match.teamB);
  const bo = match.bo || 1;
  // League mode: fixtures hand off to the player-stats report, pre-filled.
  const statsLabel = fxLabel(a, b, match);
  const statsRecorded = statsLabel && window.__VOLT?.reportedLabels?.has(statsLabel);
  const canReport = !!(a && b && window.__VOLT?.openReport);
  // A score has been entered (or the match closed) but player stats aren't in
  // yet — the state that previously had no signal at all.
  const scoreIn = !!(match.done || (match.maps || []).some(m => m && (m.a != null || m.b != null)));
  const mapsNeeded = bo === 3 ? 3 : 1;
  const winA = match.done && match.winner === match.teamA;
  const winB = match.done && match.winner === match.teamB;
  const bye = match.teamB == null && match.teamA != null;
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(120,150,220,0.14)", clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px))" }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: a ? a.hue : "rgba(120,150,220,0.4)" }} />
          <span className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 18, color: a ? a.hue : "rgba(200,215,255,0.35)", opacity: winB ? 0.5 : 1 }}>{a ? a.name : "TBD"}{winA && <span style={{ color: "#3ddc84" }}> ✓</span>}</span>
        </div>
        <span className="uppercase tracking-widest px-2 py-0.5 shrink-0" style={{ fontSize: 11, color: "rgba(200,215,255,0.45)", fontFamily: "'IBM Plex Mono',monospace", border: "1px solid rgba(120,150,220,0.2)" }}>{bye ? "BYE" : "BO" + bo}</span>
        <div className="flex items-center gap-2 min-w-0 flex-1 justify-end">
          <span className="font-bold uppercase truncate text-right" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 18, color: b ? b.hue : "rgba(200,215,255,0.35)", opacity: winA ? 0.5 : 1 }}>{winB && <span style={{ color: "#3ddc84" }}>✓ </span>}{b ? b.name : (bye ? "—" : "TBD")}</span>
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: b ? b.hue : "rgba(120,150,220,0.4)" }} />
        </div>
      </div>
      {!bye && <MatchSchedule match={match} locator={locator} isAdmin={isAdmin} onSetTime={onSetTime} />}
      {!bye && <MatchPrediction match={match} locator={locator} a={a} b={b} onVote={onVote} />}
      {!bye && (
        <div className="flex items-center justify-center gap-2.5 flex-wrap">
          {Array.from({ length: mapsNeeded }).map((_, mi) => {
            const mp = match.maps?.[mi] || { a: null, b: null };
            // hide map 3 of a Bo3 if already decided in 2
            const decidedEarly = bo === 3 && mi === 2 && match.done && (match.maps || []).slice(0, 2).filter((x) => x && x.a != null && x.b != null && x.a !== x.b).length === 2 && ((match.maps[0].a > match.maps[0].b) === (match.maps[1].a > match.maps[1].b));
            if (decidedEarly && mp.a == null) return null;
            return (
              <div key={mi} className="flex items-center gap-1.5">
                {bo === 3 && <span className="uppercase" style={{ fontSize: 11, color: "rgba(200,215,255,0.35)", fontFamily: "'IBM Plex Mono',monospace" }}>M{mi + 1}</span>}
                <input type="number" inputMode="numeric" min="0" disabled={!isAdmin || !a || !b} value={mp.a == null ? "" : mp.a}
                  onChange={(e) => onSetMap(locator, mi, e.target.value, mp.b)} placeholder="–"
                  className="text-center py-1.5 outline-none" style={{ width: 52, background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 17 }} />
                <span style={{ color: "rgba(200,215,255,0.35)", fontSize: 16 }}>:</span>
                <input type="number" inputMode="numeric" min="0" disabled={!isAdmin || !a || !b} value={mp.b == null ? "" : mp.b}
                  onChange={(e) => onSetMap(locator, mi, mp.a, e.target.value)} placeholder="–"
                  className="text-center py-1.5 outline-none" style={{ width: 52, background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 17 }} />
              </div>
            );
          })}
          {isAdmin && onSetBo && (
            <button onClick={() => onSetBo(locator, bo === 1 ? 3 : 1)} className="uppercase tracking-widest px-2.5 py-1.5 ml-1" style={{ fontSize: 11, color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", border: "1px solid rgba(61,123,255,0.3)", background: "rgba(61,123,255,0.06)" }} title="Toggle best-of">→ BO{bo === 1 ? 3 : 1}</button>
          )}
        </div>
      )}
      {(canReport || statsRecorded) && !bye && (
        <div className="flex items-center justify-center gap-2 flex-wrap" style={{ marginTop: 2 }}>
          {statsRecorded ? (
            <span className="uppercase tracking-widest px-2 py-1" style={{ fontSize: 10, color: "#9af5c2", border: "1px solid rgba(61,220,132,0.35)", background: "rgba(61,220,132,0.06)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.14em", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}>✓ Stats recorded</span>
          ) : scoreIn ? (
            <span title="Score is in — player stats still needed for season points" className="uppercase tracking-widest px-2 py-1" style={{ fontSize: 10, color: "#f5c453", border: "1px solid rgba(245,196,83,0.45)", background: "rgba(245,196,83,0.07)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.14em", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}>⚠ Stats pending</span>
          ) : null}
          {canReport && (
            <button onClick={() => window.__VOLT.openReport({
                teamAName: a.name, teamBName: b.name, label: statsLabel,
                winner: match.done ? (match.winner === match.teamA ? "A" : "B") : null,
              })}
              className="uppercase tracking-widest px-3 py-1 transition-all hover:scale-[1.03]"
              style={{ fontSize: 10.5, color: statsRecorded ? "rgba(200,215,255,0.55)" : scoreIn ? "#ffe4a0" : "#9af5c2",
                border: `1px solid ${statsRecorded ? "rgba(120,150,220,0.25)" : scoreIn ? "rgba(245,196,83,0.5)" : "rgba(61,220,132,0.45)"}`,
                background: statsRecorded ? "transparent" : scoreIn ? "rgba(245,196,83,0.1)" : "rgba(61,220,132,0.06)",
                fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}>
              ▦ {statsRecorded ? "Edit stats" : scoreIn ? "Add player stats" : "Player stats"}</button>
          )}
        </div>
      )}
    </div>
  );
}

// standings table
// ── MATCHDAY VIEW — the league's fixtures as a season, not a form ──
//    Completed rounds collapse to result strips (score, winner glow, match MVP),
//    the active matchday gets full cards with stakes/form context, future
//    rounds wait dimmed. Standings feed position chips + stakes lines.
function TMatchdays({ t, teamOf, isAdmin, A }) {
  const standings = computeStandings(t.teamIds, t.matches, t.overrides);
  const pos = {}; standings.forEach((r, i) => { pos[r.teamId] = { rank: i + 1, pts: r.pts }; });
  const topPts = standings[0]?.pts ?? 0;
  const anyPlayed = standings.some(r => r.played > 0); // no context noise at 0-0
  const n = standings.length;
  const rounds = {}; (t.matches || []).forEach(m => { const r = m.round || 1; (rounds[r] = rounds[r] || []).push(m); });
  const keys = Object.keys(rounds).map(Number).sort((x, y) => x - y);
  const isDone = (k) => rounds[k].every(m => m.done || m.teamB == null);
  const active = keys.find(k => !isDone(k)) ?? keys[keys.length - 1];

  const formOf = (teamId) => (t.matches || []).filter(m => m.done && (m.teamA === teamId || m.teamB === teamId)).slice(-4).map(m => m.winner === teamId);
  const streakOf = (teamId) => { const f = formOf(teamId); let s = 0; for (let i = f.length - 1; i >= 0 && f[i]; i--) s++; return s; };
  const scoreOf = (m) => {
    const maps = (m.maps || []).filter(x => x && x.a != null && x.b != null);
    if (!maps.length) return null;
    if ((m.bo || 1) === 1) return [maps[0].a, maps[0].b];
    return [maps.filter(x => Number(x.a) > Number(x.b)).length, maps.filter(x => Number(x.b) > Number(x.a)).length];
  };
  const stakesOf = (m) => {
    if (!anyPlayed || topPts === 0) return null; // stakes only exist once the table does
    const a = pos[m.teamA], b = pos[m.teamB];
    if (!a || !b) return null;
    if (a.rank <= 2 && b.rank <= 2) return "TOP-OF-THE-TABLE CLASH";
    // "go top": a non-leader whose win overtakes or ties the current leader
    if ((a.rank !== 1 && a.pts + 3 >= topPts) || (b.rank !== 1 && b.pts + 3 >= topPts)) return "WINNER CAN GO TOP";
    if (n >= 4 && a.rank >= n - 1 && b.rank >= n - 1) return "BASEMENT BATTLE";
    return null;
  };
  const mvpOf = (m) => {
    const a = teamOf(m.teamA), b = teamOf(m.teamB);
    const lbl = fxLabel(a, b, m);
    return lbl ? window.__VOLT?.reportedStats?.[lbl] : null;
  };
  const posChip = (teamId, right) => {
    if (!anyPlayed) return null;
    const p = pos[teamId]; if (!p) return null;
    return <span style={{ fontSize: 10.5, fontFamily: "'IBM Plex Mono',monospace", color: "rgba(200,215,255,0.5)" }}>#{p.rank} · {p.pts} PTS</span>;
  };
  const pips = (teamId) => {
    if (!anyPlayed) return null;
    const f = formOf(teamId); if (!f.length) return null;
    const s = streakOf(teamId);
    return (
      <span className="inline-flex items-center gap-1">
        {f.map((w, i) => <span key={i} style={{ width: 7, height: 7, borderRadius: "50%", background: w ? "#3ddc84" : "rgba(255,70,85,0.7)", boxShadow: w ? "0 0 5px rgba(61,220,132,0.6)" : "none" }} />)}
        {s >= 3 && <span style={{ fontSize: 10, color: "#f5c453", fontWeight: 700, fontFamily: "'Rajdhani',sans-serif" }}>🔥{s}W</span>}
      </span>
    );
  };
  const mvpChip = (m) => {
    const v = mvpOf(m); if (!v) return null;
    return <span className="uppercase" style={{ fontSize: 10.5, color: "#f5c453", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.1em" }}>⭐ {v.name} · {v.pts} PTS</span>;
  };

  const roundTag = (k) => isDone(k)
    ? <span style={{ fontSize: 10, letterSpacing: "0.2em", color: "#3ddc84", fontWeight: 700 }}>✓ COMPLETE</span>
    : k === active
      ? <span className="inline-flex items-center gap-1.5" style={{ fontSize: 10, letterSpacing: "0.2em", color: "#5b8dff", fontWeight: 700 }}><span className="animate-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#5b8dff", boxShadow: "0 0 8px rgba(61,123,255,0.9)" }} />IN PLAY</span>
      : <span style={{ fontSize: 10, letterSpacing: "0.2em", color: "rgba(200,215,255,0.3)", fontWeight: 700 }}>UPCOMING</span>;

  return (
    <div className="flex flex-col gap-5">
      {keys.map(k => (
        <div key={k} style={{ opacity: !isDone(k) && k !== active ? 0.55 : 1 }}>
          <div className="flex items-center gap-3 mb-2">
            <span className="uppercase font-bold tracking-widest" style={{ color: k === active && !isDone(k) ? "#eaf1ff" : "rgba(200,215,255,0.55)", fontFamily: "'Rajdhani',sans-serif", fontSize: 14 }}>Round {k}</span>
            {roundTag(k)}
            <span className="flex-1" style={{ height: 1, background: "linear-gradient(90deg, rgba(61,123,255,0.3), transparent)" }} />
          </div>

          {/* completed round → result strips */}
          {isDone(k) && (
            <div className="grid sm:grid-cols-2 gap-2">
              {rounds[k].map(m => {
                const a = teamOf(m.teamA), b = teamOf(m.teamB);
                if (!b) return null;
                const sc = scoreOf(m); const winA = m.winner === m.teamA;
                return (
                  <div key={m.id} className="flex flex-col gap-1 px-4 py-2.5" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(120,150,220,0.12)", clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 15, color: a?.hue, opacity: winA ? 1 : 0.45, textShadow: winA ? `0 0 12px ${a?.hue}66` : "none", flex: 1 }}>{a?.name}{winA && " ✓"}</span>
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 17, fontWeight: 700, color: "#eaf1ff" }}>{sc ? `${sc[0]} : ${sc[1]}` : "—"}</span>
                      <span className="font-bold uppercase truncate text-right" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 15, color: b?.hue, opacity: winA ? 0.45 : 1, textShadow: !winA ? `0 0 12px ${b?.hue}66` : "none", flex: 1 }}>{!winA && "✓ "}{b?.name}</span>
                    </div>
                    <div className="flex items-center justify-center">{mvpChip(m) || (isAdmin && window.__VOLT?.openReport && <button onClick={() => window.__VOLT.openReport({ teamAName: a.name, teamBName: b.name, label: fxLabel(a, b, m), winner: winA ? "A" : "B" })} className="uppercase" style={{ fontSize: 9.5, letterSpacing: "0.14em", color: "rgba(200,215,255,0.4)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>▦ add player stats</button>)}</div>
                  </div>
                );
              })}
            </div>
          )}

          {/* active round → full cards with context */}
          {!isDone(k) && k === active && (
            <div className="grid sm:grid-cols-2 gap-2">
              {rounds[k].map(m => {
                const a = teamOf(m.teamA), b = teamOf(m.teamB);
                const st = b ? stakesOf(m) : null;
                return (
                  <div key={m.id} className="flex flex-col gap-1.5">
                    {st && <div className="text-center uppercase" style={{ fontSize: 10, letterSpacing: "0.22em", color: "#f5c453", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>⚡ {st}</div>}
                    {b && (
                      <div className="flex items-center justify-between px-1">
                        <span className="flex items-center gap-2">{posChip(m.teamA)}{pips(m.teamA)}</span>
                        <span className="flex items-center gap-2">{pips(m.teamB)}{posChip(m.teamB)}</span>
                      </div>
                    )}
                    <TMatchRow match={m} locator={{ kind: "rr", matchId: m.id }} teamOf={teamOf} isAdmin={isAdmin} {...A} />
                  </div>
                );
              })}
            </div>
          )}

          {/* future rounds → quiet schedule */}
          {!isDone(k) && k !== active && (
            <div className="grid sm:grid-cols-2 gap-1.5">
              {rounds[k].map(m => {
                const a = teamOf(m.teamA), b = teamOf(m.teamB);
                return (
                  <div key={m.id} className="flex items-center justify-between px-4 py-2" style={{ background: "rgba(255,255,255,0.015)", border: "1px solid rgba(120,150,220,0.08)" }}>
                    <span className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 13.5, color: a?.hue, flex: 1 }}>{a?.name || "TBD"}</span>
                    <span style={{ fontSize: 10, color: "rgba(200,215,255,0.3)", fontFamily: "'IBM Plex Mono',monospace", padding: "0 10px" }}>VS</span>
                    <span className="font-bold uppercase truncate text-right" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 13.5, color: b?.hue, flex: 1 }}>{b?.name || (m.teamA ? "BYE" : "TBD")}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TStandings({ teamIds, matches, overrides, teamOf, advance = 1, hue = "#3d7bff" }) {
  const rows = computeStandings(teamIds, matches, overrides);
  return (
    <div className="overflow-x-auto">
      <table className="w-full" style={{ borderCollapse: "collapse", fontFamily: "'Rajdhani',sans-serif" }}>
        <thead>
          <tr style={{ color: "rgba(200,215,255,0.5)" }}>
            {["#", "Team", "P", "W", "L", "RF", "RA", "DIFF", "PTS"].map((h, i) => (
              <th key={h} className="text-left uppercase tracking-widest py-3 px-2.5" style={{ fontSize: 14, textAlign: i < 2 ? "left" : "center", borderBottom: "1px solid rgba(120,150,220,0.18)" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const tm = teamOf(r.teamId); const adv = i < advance;
            return (
              <tr key={r.teamId} style={{ background: adv ? hue + "12" : "transparent" }}>
                <td className="py-3 px-2.5" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, color: adv ? hue : "rgba(200,215,255,0.5)", fontWeight: 700 }}>{i + 1}{adv && <span style={{ color: hue }}> ▲</span>}</td>
                <td className="py-3 px-2.5">
                  <span className="flex items-center gap-2.5">
                    <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: tm?.hue }} />
                    <span className="font-bold uppercase truncate" style={{ color: tm?.hue, fontSize: 18 }}>{tm?.name}{r._ov && <span title="manually adjusted" style={{ color: "#ffb020" }}> *</span>}</span>
                  </span>
                </td>
                <td className="text-center py-3 px-2.5" style={{ color: "rgba(236,243,255,0.7)", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.played}</td>
                <td className="text-center py-3 px-2.5" style={{ color: "#3ddc84", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.won}</td>
                <td className="text-center py-3 px-2.5" style={{ color: "rgba(255,120,135,0.8)", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.lost}</td>
                <td className="text-center py-3 px-2.5" style={{ color: "rgba(236,243,255,0.55)", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.rf}</td>
                <td className="text-center py-3 px-2.5" style={{ color: "rgba(236,243,255,0.55)", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.ra}</td>
                <td className="text-center py-3 px-2.5" style={{ color: r.diff > 0 ? "#3ddc84" : r.diff < 0 ? "rgba(255,120,135,0.8)" : "rgba(236,243,255,0.55)", fontFamily: "'IBM Plex Mono',monospace", fontSize: 16 }}>{r.diff > 0 ? "+" : ""}{r.diff}</td>
                <td className="text-center py-3 px-2.5" style={{ color: "#5b8dff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 19, fontWeight: 700, textShadow: "0 0 10px rgba(61,123,255,0.5)" }}>{r.pts}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// one bracket match — two stacked team rows + a score box on the right (reference style)
function TBracketMatch({ match, locator, teamOf, isAdmin, onSetMap, onSetBo, onSetTime, onVote }) {
  const a = teamOf(match.teamA), b = teamOf(match.teamB);
  const bo = match.bo || 1;
  const bye = match.teamB == null && match.teamA != null;
  const statsLabel = fxLabel(a, b, match);
  const statsRecorded = statsLabel && window.__VOLT?.reportedLabels?.has(statsLabel);
  const canReport = !!(a && b && window.__VOLT?.openReport);
  const scoreIn = !!(match.done || (match.maps || []).some(m => m && (m.a != null || m.b != null)));
  const winA = match.done && match.winner === match.teamA;
  const winB = match.done && match.winner === match.teamB;

  // per-team series score = number of maps won (what shows in the right cell)
  const mapsWon = (who) => {
    let n = 0;
    for (const mp of (match.maps || [])) {
      if (mp.a == null || mp.b == null) continue;
      if (who === "a" && mp.a > mp.b) n++;
      if (who === "b" && mp.b > mp.a) n++;
    }
    return n;
  };
  // for Bo1 we show the single map's round score; for Bo3 we show maps won
  const scoreFor = (who) => {
    if (bo === 1) { const mp = match.maps?.[0]; return mp && mp[who] != null ? mp[who] : null; }
    return mapsWon(who);
  };

  const row = (team, win, dim, who) => (
    <div className="flex items-center gap-2.5 px-3" style={{ height: 38, background: win ? (team ? team.hue + "26" : "transparent") : "transparent", borderLeft: `3px solid ${win && team ? team.hue : "transparent"}`, opacity: dim ? 0.45 : 1, transition: "all .2s" }}>
      <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: team ? team.hue : "rgba(120,150,220,0.35)" }} />
      <span className="font-bold uppercase truncate flex-1" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 16, letterSpacing: "0.02em", color: team ? team.hue : "rgba(200,215,255,0.4)" }}>
        {team ? team.name : (bye && who === "b" ? "—" : "TBD")}{win && <span style={{ color: "#3ddc84", marginLeft: 4 }}>✓</span>}
      </span>
      {/* score cell */}
      <span className="grid place-items-center shrink-0" style={{ width: 34, height: 26, fontFamily: "'IBM Plex Mono',monospace", fontSize: 15, fontWeight: 700, color: win ? "#eaf1ff" : "rgba(200,215,255,0.55)", background: win ? "rgba(61,123,255,0.22)" : "rgba(255,255,255,0.04)", border: `1px solid ${win ? "rgba(61,123,255,0.5)" : "rgba(120,150,220,0.18)"}` }}>
        {scoreFor(who) == null ? "–" : scoreFor(who)}
      </span>
    </div>
  );

  return (
    <div className="relative" style={{ background: "rgba(10,15,28,0.6)", border: "1px solid rgba(120,150,220,0.18)", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
      <span className="absolute left-0 top-0" style={{ width: 9, height: 9, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
      {row(a, winA, winB, "a")}
      <div style={{ height: 1, background: "rgba(120,150,220,0.16)" }} />
      {row(b, winB, winA || bye, "b")}

      {!bye && (match.scheduledAt || isAdmin) && (
        <div className="px-2 py-2" style={{ borderTop: "1px solid rgba(120,150,220,0.16)" }}>
          <MatchSchedule match={match} locator={locator} isAdmin={isAdmin} onSetTime={onSetTime} />
        </div>
      )}
      {!bye && a && b && (
        <div className="px-3 pb-2" style={{ borderTop: "1px solid rgba(120,150,220,0.16)" }}>
          <MatchPrediction match={match} locator={locator} a={a} b={b} onVote={onVote} />
        </div>
      )}
      {!bye && (canReport || statsRecorded) && (
        <div className="flex items-center justify-center gap-2 flex-wrap px-3 pb-2.5" style={{ borderTop: "1px solid rgba(120,150,220,0.16)", paddingTop: 8 }}>
          {statsRecorded ? (
            <span className="uppercase tracking-widest px-2 py-1" style={{ fontSize: 9.5, color: "#9af5c2", border: "1px solid rgba(61,220,132,0.35)", background: "rgba(61,220,132,0.06)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.14em" }}>✓ Stats recorded</span>
          ) : scoreIn ? (
            <span title="Score is in — player stats still needed for season points" className="uppercase tracking-widest px-2 py-1" style={{ fontSize: 9.5, color: "#f5c453", border: "1px solid rgba(245,196,83,0.45)", background: "rgba(245,196,83,0.07)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.14em" }}>⚠ Stats pending</span>
          ) : null}
          {canReport && (
            <button onClick={() => window.__VOLT.openReport({ teamAName: a.name, teamBName: b.name, label: statsLabel, winner: match.done ? (match.winner === match.teamA ? "A" : "B") : null })}
              className="uppercase tracking-widest px-2.5 py-1 transition-all hover:scale-[1.03]"
              style={{ fontSize: 10, color: statsRecorded ? "rgba(200,215,255,0.55)" : scoreIn ? "#ffe4a0" : "#9af5c2",
                border: `1px solid ${statsRecorded ? "rgba(120,150,220,0.25)" : scoreIn ? "rgba(245,196,83,0.5)" : "rgba(61,220,132,0.45)"}`,
                background: statsRecorded ? "transparent" : scoreIn ? "rgba(245,196,83,0.1)" : "rgba(61,220,132,0.06)",
                fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>
              ▦ {statsRecorded ? "Edit" : "Player stats"}</button>
          )}
        </div>
      )}

      {/* score-entry strip (admin only, not for byes) */}
      {isAdmin && !bye && a && b && (
        <div className="flex items-center justify-center gap-2 px-2 py-2 flex-wrap" style={{ borderTop: "1px solid rgba(120,150,220,0.16)", background: "rgba(61,123,255,0.04)" }}>
          {Array.from({ length: bo === 3 ? 3 : 1 }).map((_, mi) => {
            const mp = match.maps?.[mi] || { a: null, b: null };
            const decidedEarly = bo === 3 && mi === 2 && match.done && (match.maps || []).slice(0, 2).filter((x) => x && x.a != null && x.b != null && x.a !== x.b).length === 2 && ((match.maps[0].a > match.maps[0].b) === (match.maps[1].a > match.maps[1].b));
            if (decidedEarly && mp.a == null) return null;
            return (
              <span key={mi} className="flex items-center gap-1">
                {bo === 3 && <span style={{ fontSize: 10, color: "rgba(200,215,255,0.35)", fontFamily: "'IBM Plex Mono',monospace" }}>M{mi + 1}</span>}
                <input type="number" inputMode="numeric" min="0" value={mp.a == null ? "" : mp.a} onChange={(e) => onSetMap(locator, mi, e.target.value, mp.b)} placeholder="–"
                  className="text-center outline-none" style={{ width: 40, height: 28, background: "rgba(61,123,255,0.07)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 14 }} />
                <span style={{ color: "rgba(200,215,255,0.3)", fontSize: 13 }}>:</span>
                <input type="number" inputMode="numeric" min="0" value={mp.b == null ? "" : mp.b} onChange={(e) => onSetMap(locator, mi, mp.a, e.target.value)} placeholder="–"
                  className="text-center outline-none" style={{ width: 40, height: 28, background: "rgba(61,123,255,0.07)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 14 }} />
              </span>
            );
          })}
          {onSetBo && (
            <button onClick={() => onSetBo(locator, bo === 1 ? 3 : 1)} className="uppercase tracking-widest px-2 py-1 ml-0.5" style={{ fontSize: 10, color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", border: "1px solid rgba(61,123,255,0.3)", background: "rgba(61,123,255,0.06)" }} title="Toggle best-of">→ BO{bo === 1 ? 3 : 1}</button>
          )}
        </div>
      )}
    </div>
  );
}

// single-elim bracket display — columns of matches joined by elbow connector lines
function TBracket({ rounds, teamOf, isAdmin, onSetMap, onSetBo, onSetTime, onVote }) {
  const roundName = (ri, total) => {
    const fromEnd = total - 1 - ri;
    if (fromEnd === 0) return "Final";
    if (fromEnd === 1) return "Semifinals";
    if (fromEnd === 2) return "Quarterfinals";
    return "Round " + (ri + 1);
  };
  const LINE = "rgba(110,150,230,0.4)";
  return (
    <div className="flex overflow-x-auto pb-3" style={{ minHeight: 200 }}>
      {rounds.map((round, ri) => {
        const isLast = ri === rounds.length - 1;
        return (
          <div key={ri} className="flex" style={{ minWidth: 286 }}>
            {/* match column */}
            <div className="flex flex-col justify-around flex-1" style={{ gap: 0 }}>
              <p className="uppercase text-sm font-bold tracking-widest text-center mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>{roundName(ri, rounds.length)}</p>
              {round.map((m, idx) => (
                <div key={m.id} className="flex flex-col justify-center flex-1" style={{ position: "relative" }}>
                  <TBracketMatch match={m} locator={{ kind: "elim", round: ri, idx }} teamOf={teamOf} isAdmin={isAdmin} onSetMap={onSetMap} onSetBo={onSetBo} onSetTime={onSetTime} onVote={onVote} />
                </div>
              ))}
            </div>
            {/* connector column (between this round and the next) */}
            {!isLast && (
              <div className="flex flex-col" style={{ width: 30 }}>
                <div style={{ height: 30 }} />{/* offset for the round label */}
                <div className="flex flex-col flex-1">
                  {Array.from({ length: Math.ceil(round.length / 2) }).map((_, pi) => (
                    <div key={pi} className="flex-1 flex items-center" style={{ position: "relative" }}>
                      {/* top match out-line, elbow down, into next match */}
                      <div style={{ position: "absolute", left: 0, right: "50%", top: "25%", borderTop: `2px solid ${LINE}` }} />
                      <div style={{ position: "absolute", left: 0, right: "50%", bottom: "25%", borderTop: `2px solid ${LINE}` }} />
                      <div style={{ position: "absolute", left: "50%", top: "25%", bottom: "25%", borderLeft: `2px solid ${LINE}` }} />
                      <div style={{ position: "absolute", left: "50%", right: 0, top: "50%", borderTop: `2px solid ${LINE}` }} />
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// champion banner once a bracket / final resolves
function TChampion({ team }) {
  if (!team) return null;
  return (
    <div className="relative flex flex-col items-center gap-1 py-5 px-8 mx-auto" style={{ maxWidth: 420, background: `linear-gradient(160deg, ${team.hue}22, rgba(10,15,28,0.6))`, border: `1px solid ${team.hue}`, clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))", boxShadow: `0 0 50px ${team.hue}33` }}>
      <p className="uppercase text-xs font-bold tracking-[0.3em]" style={{ color: "#ffd166", fontFamily: "'Rajdhani',sans-serif" }}>★ Champion ★</p>
      <p className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "2.4rem", lineHeight: 1, color: team.hue, letterSpacing: "0.03em" }}>{team.name}</p>
    </div>
  );
}

// ── main tournament view ──
function TournamentView({ state, isAdmin, teamOf, actions }) {
  const t = state.tournament;
  const [draftFormat, setDraftFormat] = useState("group");
  const [draftBo, setDraftBo] = useState("bo1");
  const [draftGroups, setDraftGroups] = useState(2);
  const [pickGroup, setPickGroup] = useState(null); // active group id for assignment

  const header = (eyebrow, word1, word2) => (
    <div className="flex flex-col items-center text-center mb-7">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
        <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>{eyebrow}</p>
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
      </div>
      <h2 className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>{word1} <span style={{ color: "#3d7bff" }}>{word2}</span></h2>
    </div>
  );

  // ── EMPTY STATE: no tournament yet ──
  if (!t) {
    if (!isAdmin) return (
      <div className="view-in page-wrap py-12 flex flex-col items-center text-center">
        {header("Competition", "Tournament", "Brackets")}
        <p className="max-w-md" style={{ color: "rgba(200,215,255,0.55)" }}>No tournament has been set up yet. The host will configure the format and brackets — they'll appear here live once it begins.</p>
      </div>
    );
    const maxGroups = Math.max(2, Math.floor(state.teams.length / 2));
    return (
      <div className="view-in page-wrap py-10 flex flex-col items-center">
        {header("Competition", "New", "Tournament")}
        <div className="w-full max-w-2xl flex flex-col gap-5">
          <TPanel>
            <p className="uppercase text-sm font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>1 · Format</p>
            <div className="grid sm:grid-cols-3 gap-3">
              {[
                { id: "group", name: "Group Stage", desc: "Split into groups, round-robin each, top of each advances to a final." },
                { id: "roundrobin", name: "Round Robin", desc: "One table — every team plays every other team once." },
                { id: "league", name: "League Play", desc: "No bracket — 4 matches per team, every match banks points." },
                { id: "single", name: "Single Elim", desc: "Seeded knockout bracket. Lose once, you're out." },
              ].map((f) => (
                <button key={f.id} onClick={() => setDraftFormat(f.id)} className="text-left p-3 transition-all"
                  style={{ background: draftFormat === f.id ? "rgba(61,123,255,0.12)" : "rgba(255,255,255,0.03)", border: `1px solid ${draftFormat === f.id ? "#3d7bff" : "rgba(120,150,220,0.18)"}`, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
                  <p className="font-bold uppercase text-sm mb-1" style={{ fontFamily: "'Rajdhani',sans-serif", color: draftFormat === f.id ? "#aec6ff" : "#dce6ff" }}>{f.name}</p>
                  <p className="text-xs leading-snug" style={{ color: "rgba(200,215,255,0.45)" }}>{f.desc}</p>
                </button>
              ))}
            </div>
          </TPanel>

          <TPanel>
            <p className="uppercase text-sm font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>2 · Default match length</p>
            <div className="flex gap-3">
              {[{ id: "bo1", name: "Best of 1", desc: "One map per match" }, { id: "bo3", name: "Best of 3", desc: "First to 2 maps" }].map((b) => (
                <button key={b.id} onClick={() => setDraftBo(b.id)} className="flex-1 text-left p-3 transition-all"
                  style={{ background: draftBo === b.id ? "rgba(61,123,255,0.12)" : "rgba(255,255,255,0.03)", border: `1px solid ${draftBo === b.id ? "#3d7bff" : "rgba(120,150,220,0.18)"}`, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
                  <p className="font-bold uppercase text-sm" style={{ fontFamily: "'Rajdhani',sans-serif", color: draftBo === b.id ? "#aec6ff" : "#dce6ff" }}>{b.name}</p>
                  <p className="text-xs" style={{ color: "rgba(200,215,255,0.45)" }}>{b.desc}</p>
                </button>
              ))}
            </div>
            <p className="text-[11px] mt-2" style={{ color: "rgba(200,215,255,0.4)" }}>You can switch any single match (e.g. the final) to a different length later.</p>
          </TPanel>

          {draftFormat === "group" && (
            <TPanel>
              <p className="uppercase text-sm font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>3 · Number of groups</p>
              <div className="flex gap-2 flex-wrap">
                {Array.from({ length: maxGroups - 1 }).map((_, i) => {
                  const n = i + 2;
                  return (
                    <button key={n} onClick={() => setDraftGroups(n)} className="w-12 h-12 font-bold transition-all"
                      style={{ fontFamily: "'IBM Plex Mono',monospace", background: draftGroups === n ? "rgba(61,123,255,0.18)" : "rgba(255,255,255,0.03)", border: `1px solid ${draftGroups === n ? "#3d7bff" : "rgba(120,150,220,0.18)"}`, color: draftGroups === n ? "#aec6ff" : "#dce6ff", clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>{n}</button>
                  );
                })}
              </div>
              <p className="text-[11px] mt-2" style={{ color: "rgba(200,215,255,0.4)" }}>{state.teams.length} teams available · winner of each group meets in the final.</p>
            </TPanel>
          )}

          {(() => {
            const nTeams = state.teams.length;
            const need = draftFormat === "group" ? draftGroups * 2 : 2;
            const short = nTeams < need;
            return (
              <>
                <button disabled={short} onClick={() => actions.tCreate(draftFormat, draftBo, draftGroups)} className="gate-cta py-3.5 font-bold uppercase tracking-[0.2em]"
                  style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", background: short ? "rgba(120,150,220,0.08)" : "rgba(61,123,255,0.18)", border: `1px solid ${short ? "rgba(120,150,220,0.3)" : "#3d7bff"}`, color: short ? "rgba(200,215,255,0.4)" : "#eaf1ff", cursor: short ? "not-allowed" : "pointer" }}>
                  Create Tournament →
                </button>
                {short && (
                  <p className="text-center text-[12px] mt-2" style={{ color: "#f5c453", fontFamily: "'Rajdhani',sans-serif" }}>
                    {nTeams === 0
                      ? "No teams yet — run the auction (or add teams in the Locker Room) first."
                      : draftFormat === "group"
                        ? `${nTeams} team${nTeams === 1 ? "" : "s"} on the board — ${draftGroups} groups needs at least ${need}. Add teams or pick fewer groups.`
                        : `${nTeams} team${nTeams === 1 ? "" : "s"} on the board — you need at least 2.`}
                  </p>
                )}
              </>
            );
          })()}
        </div>
      </div>
    );
  }

  // ── SETUP STATE: tournament exists but not locked ──
  const unassigned = state.teams.filter((tm) => {
    if (t.format === "group") return !t.groups.some((g) => g.teamIds.includes(tm.id));
    if ((t.format === "roundrobin" || t.format === "league")) return !t.teamIds.includes(tm.id);
    if (t.format === "single") return !t.slots.includes(tm.id);
    return false;
  });

  const fmtName = t.format === "group" ? "Group Stage" : t.format === "single" ? "Single Elimination" : "Round Robin";

  if (!t.locked) {
    if (!isAdmin) return (
      <div className="view-in page-wrap py-12 flex flex-col items-center text-center">
        {header("Competition", "Tournament", "Setup")}
        <p className="max-w-md" style={{ color: "rgba(200,215,255,0.55)" }}>The host is setting up a <b style={{ color: "#7da6ff" }}>{fmtName}</b> ({"BO" + t.bo}). Brackets will appear here once it's locked in.</p>
      </div>
    );

    const canLock = t.format === "group" ? t.groups.every((g) => g.teamIds.length >= 2)
      : (t.format === "roundrobin" || t.format === "league") ? t.teamIds.length >= 2
      : t.slots.filter(Boolean).length >= 2;

    return (
      <div className="view-in page-wrap py-10">
        {header("Competition", fmtName.split(" ")[0], fmtName.split(" ").slice(1).join(" ") || "Setup")}
        <div className="flex items-center justify-center gap-3 mb-6 flex-wrap">
          <span className="text-xs uppercase tracking-widest px-3 py-1.5" style={{ color: "#7da6ff", fontFamily: "'IBM Plex Mono',monospace", border: "1px solid rgba(61,123,255,0.3)", background: "rgba(61,123,255,0.06)" }}>{"BO" + t.bo}</span>
          <button onClick={actions.armTClear} className="text-xs uppercase tracking-widest px-3 py-1.5" style={{ color: actions.tClearArmed ? "#ffd2d7" : "rgba(255,120,135,0.8)", fontFamily: "'Rajdhani',sans-serif", border: `1px solid ${actions.tClearArmed ? "#ff4655" : "rgba(255,120,135,0.3)"}`, background: actions.tClearArmed ? "rgba(255,70,85,0.18)" : "transparent" }}>{actions.tClearArmed ? "Click again to confirm" : "Clear tournament"}</button>
        </div>

        {/* unassigned pool (group / round-robin only — single elim uses seed dropdowns) */}
        {t.format !== "single" && (
        <TPanel className="mb-5">
          <p className="uppercase text-sm font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>
            {t.format === "group" ? (pickGroup ? `Tap a team to add to ${t.groups.find((g) => g.id === pickGroup)?.name}` : "Pick a group below, then tap teams to fill it") : "Tap teams to add them to the bracket"}
          </p>
          <div className="flex flex-wrap gap-2">
            {unassigned.length === 0 ? <span className="text-sm" style={{ color: "rgba(200,215,255,0.4)" }}>All teams assigned.</span>
              : unassigned.map((tm) => (
                <TTeamChip key={tm.id} team={tm} onClick={() => {
                  if (t.format === "group") { if (pickGroup) actions.tAssign(pickGroup, tm.id); }
                  else actions.tAssign(null, tm.id);
                }} />
              ))}
          </div>
        </TPanel>
        )}

        {/* group format: group columns */}
        {t.format === "group" && (
          <div className="grid sm:grid-cols-2 gap-4 mb-6">
            {t.groups.map((g) => (
              <TPanel key={g.id} hue={pickGroup === g.id ? "#5b8dff" : "#3d7bff"} style={{ outline: pickGroup === g.id ? "1px solid #5b8dff" : "none" }}>
                <div className="flex items-center justify-between mb-3">
                  <p className="uppercase text-base font-bold tracking-widest" style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif" }}>{g.name}</p>
                  <button onClick={() => setPickGroup(pickGroup === g.id ? null : g.id)} className="text-[11px] uppercase tracking-widest px-2.5 py-1" style={{ color: pickGroup === g.id ? "#06080e" : "#7da6ff", fontFamily: "'Rajdhani',sans-serif", background: pickGroup === g.id ? "#5b8dff" : "rgba(61,123,255,0.08)", border: "1px solid rgba(61,123,255,0.4)" }}>{pickGroup === g.id ? "Selected" : "Select"}</button>
                </div>
                <div className="flex flex-col gap-2">
                  {g.teamIds.length === 0 ? <span className="text-sm" style={{ color: "rgba(200,215,255,0.35)" }}>Empty — select this group, then tap teams above.</span>
                    : g.teamIds.map((id) => <div key={id} className="flex items-center justify-between"><TTeamChip team={teamOf(id)} /><button onClick={() => actions.tAssign(null, id)} aria-label="Remove team from group" className="text-xs px-2" style={{ color: "rgba(255,120,135,0.7)" }}>✕</button></div>)}
                </div>
              </TPanel>
            ))}
          </div>
        )}

        {/* roundrobin: single list */}
        {(t.format === "roundrobin" || t.format === "league") && (
          <TPanel className="mb-6">
            <p className="uppercase text-base font-bold tracking-widest mb-3" style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif" }}>Participants ({t.teamIds.length})</p>
            <div className="flex flex-wrap gap-2">
              {t.teamIds.length === 0 ? <span className="text-sm" style={{ color: "rgba(200,215,255,0.35)" }}>None yet — tap teams above.</span>
                : t.teamIds.map((id) => <div key={id} className="flex items-center gap-1"><TTeamChip team={teamOf(id)} /><button onClick={() => actions.tAssign(null, id)} aria-label="Remove team from group" className="text-xs px-1" style={{ color: "rgba(255,120,135,0.7)" }}>✕</button></div>)}
            </div>
          </TPanel>
        )}

        {/* single elim: numbered bracket slots */}
        {t.format === "single" && (
          <TPanel className="mb-6">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <p className="uppercase text-base font-bold tracking-widest" style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif" }}>Bracket Seeding</p>
              <div className="flex items-center gap-2">
                <span className="uppercase" style={{ fontSize: 13, color: "rgba(200,215,255,0.45)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.1em" }}>Bracket size</span>
                <select value={t.slots.length} onChange={(e) => actions.tSetSlotCount(Number(e.target.value))}
                  className="px-2 py-1.5 outline-none" style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 15 }}>
                  {[2, 4, 8, 16, 32].map((n) => <option key={n} value={n} style={{ background: "#0a0d18" }}>{n} teams</option>)}
                </select>
              </div>
            </div>
            <p className="mb-4" style={{ fontSize: 13, color: "rgba(200,215,255,0.4)" }}>Pick the team for each seed. Seeds 1 &amp; 2 meet last; adjacent seeds (1–2, 3–4…) play in round one. Empty seeds become byes.</p>
            <div className="grid sm:grid-cols-2 gap-3">
              {t.slots.map((id, i) => {
                const taken = new Set(t.slots.filter((x, k) => x && k !== i));
                return (
                  <div key={i} className="flex items-center gap-3 px-3 py-2.5" style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(120,150,220,0.16)", clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px))" }}>
                    <span className="grid place-items-center shrink-0 font-bold" style={{ width: 34, height: 34, fontFamily: "'IBM Plex Mono',monospace", fontSize: 16, color: "#5b8dff", background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.3)" }}>{i + 1}</span>
                    <select value={id || ""} onChange={(e) => actions.tSetSlot(i, e.target.value || null)}
                      className="flex-1 min-w-0 px-2.5 py-2 outline-none uppercase" style={{ background: "rgba(61,123,255,0.05)", border: "1px solid rgba(61,123,255,0.22)", color: id ? (teamOf(id)?.hue || "#ecf3ff") : "rgba(200,215,255,0.4)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: 16, letterSpacing: "0.03em" }}>
                      <option value="" style={{ background: "#0a0d18", color: "#8aa" }}>— Bye / empty —</option>
                      {state.teams.map((tm) => (
                        <option key={tm.id} value={tm.id} disabled={taken.has(tm.id)} style={{ background: "#0a0d18", color: "#ecf3ff" }}>{tm.name}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </TPanel>
        )}

        <div className="flex justify-center">
          <button onClick={() => canLock && actions.tLock()} disabled={!canLock} className="gate-cta py-3.5 px-12 font-bold uppercase tracking-[0.2em]"
            style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", background: canLock ? "rgba(61,123,255,0.18)" : "rgba(255,255,255,0.04)", border: `1px solid ${canLock ? "#3d7bff" : "rgba(255,255,255,0.1)"}`, color: canLock ? "#eaf1ff" : "rgba(236,243,255,0.3)", cursor: canLock ? "pointer" : "not-allowed" }}>
            Lock & Generate Matches →
          </button>
        </div>
        {!canLock && <p className="text-center text-xs mt-3" style={{ color: "rgba(255,120,135,0.7)" }}>{t.format === "group" ? "Each group needs at least 2 teams." : "Add at least 2 teams."}</p>}
      </div>
    );
  }

  // ── LIVE STATE: locked, scores being entered ──
  const A = { onSetMap: actions.tSetMap, onSetBo: actions.tSetBo, onSetTime: actions.tSetTime, onVote: actions.tVote };
  let champion = null;
  if (t.format === "single" && t.rounds?.length) { const fm = t.rounds[t.rounds.length - 1][0]; if (fm?.done) champion = teamOf(fm.winner); }
  // Any format that ends in a decider (group final, or the league Sunday final)
  if (!champion && t.final?.done && t.final.winner) champion = teamOf(t.final.winner);

  return (
    <div className="view-in page-wrap py-10">
      {header("Live Competition", fmtName.split(" ")[0], fmtName.split(" ").slice(1).join(" ") || "")}
      <div className="flex items-center justify-center gap-3 mb-7 flex-wrap">
        <span className="text-xs uppercase tracking-widest px-3 py-1.5" style={{ color: "#7da6ff", fontFamily: "'IBM Plex Mono',monospace", border: "1px solid rgba(61,123,255,0.3)", background: "rgba(61,123,255,0.06)" }}>{"BO" + t.bo} default</span>
        {isAdmin && actions.tSwitchFormat && <FormatSwitcher t={t} actions={actions} />}
        {isAdmin && <button onClick={actions.armTClear} className="text-xs uppercase tracking-widest px-3 py-1.5" style={{ color: actions.tClearArmed ? "#ffd2d7" : "rgba(255,120,135,0.8)", fontFamily: "'Rajdhani',sans-serif", border: `1px solid ${actions.tClearArmed ? "#ff4655" : "rgba(255,120,135,0.3)"}`, background: actions.tClearArmed ? "rgba(255,70,85,0.18)" : "transparent" }}>{actions.tClearArmed ? "Click again to confirm" : "Clear tournament"}</button>}
      </div>

      {champion && <div className="mb-8"><TChampion team={champion} /></div>}

      {/* GROUP STAGE */}
      {t.format === "group" && (
        <>
          <div className="grid lg:grid-cols-2 gap-6 mb-8">
            {t.groups.map((g) => (
              <div key={g.id} className="flex flex-col gap-4">
                <TPanel>
                  <p className="uppercase text-base font-bold tracking-widest mb-3" style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif" }}>{g.name} · Standings</p>
                  <TStandings teamIds={g.teamIds} matches={t.matches[g.id] || []} overrides={t.overrides} teamOf={teamOf} advance={1} />
                </TPanel>
                <TPanel>
                  <p className="uppercase text-base font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>{g.name} · Matches</p>
                  <div className="flex flex-col gap-2">
                    {(t.matches[g.id] || []).map((m) => (
                      <TMatchRow key={m.id} match={m} locator={{ kind: "group", groupId: g.id, matchId: m.id }} teamOf={teamOf} isAdmin={isAdmin} {...A} />
                    ))}
                  </div>
                </TPanel>
              </div>
            ))}
          </div>
          {/* the final */}
          <TPanel hue="#ffd166">
            <p className="uppercase text-lg font-bold tracking-widest mb-3 text-center" style={{ color: "#ffd166", fontFamily: "'Rajdhani',sans-serif" }}>★ Grand Final ★</p>
            {t.final ? (
              <div className="max-w-md mx-auto">
                <TMatchRow match={t.final} locator={{ kind: "final" }} teamOf={teamOf} isAdmin={isAdmin} {...A} />
              </div>
            ) : (
              <p className="text-center text-sm" style={{ color: "rgba(200,215,255,0.45)" }}>Awaiting both group winners — complete every group match to set the final.</p>
            )}
          </TPanel>
        </>
      )}

      {/* ROUND ROBIN */}
      {(t.format === "roundrobin" || t.format === "league") && (
        <div className="flex flex-col gap-6">
          <TPanel>
            <p className="uppercase text-base font-bold tracking-widest mb-3" style={{ color: "#aec6ff", fontFamily: "'Rajdhani',sans-serif" }}>Standings</p>
            <TStandings teamIds={t.teamIds} matches={t.matches} overrides={t.overrides} teamOf={teamOf} advance={1} />
          </TPanel>
          <TPanel>
            <p className="uppercase text-base font-bold tracking-widest mb-3" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>Fixtures</p>
            <TMatchdays t={t} teamOf={teamOf} isAdmin={isAdmin} A={A} />
          </TPanel>

          {/* ── THE SUNDAY FINAL — top two from the table settle the tournament ── */}
          <TPanel hue="#ffd166">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <p className="uppercase text-lg font-bold tracking-widest" style={{ color: "#ffd166", fontFamily: "'Rajdhani',sans-serif" }}>★ Sunday Final ★</p>
              {isAdmin && t.finalLock && !t.final?.done && actions.tResetFinal && (
                <button onClick={actions.tResetFinal} className="text-[11px] uppercase tracking-widest px-3 py-1.5"
                  style={{ color: "rgba(200,215,255,0.6)", fontFamily: "'Rajdhani',sans-serif", border: "1px solid rgba(120,150,220,0.3)", background: "transparent" }}>↺ Use table seeding</button>
              )}
            </div>
            {t.final ? (
              <div className="max-w-md mx-auto">
                <TMatchRow match={t.final} locator={{ kind: "final" }} teamOf={teamOf} isAdmin={isAdmin} {...A} />
                {t.finalLock && !t.final.done && (
                  <p className="text-center text-[11px] mt-2" style={{ color: "rgba(255,209,102,0.7)" }}>Teams set manually — the table won't re-seed this.</p>
                )}
              </div>
            ) : (
              <p className="text-center text-sm" style={{ color: "rgba(200,215,255,0.45)" }}>
                {(t.matches || []).length === 0
                  ? "Lock the fixtures first."
                  : "Report every round and the top two seed automatically."}
              </p>
            )}
            {/* host override — pick either side by hand */}
            {isAdmin && !t.final?.done && actions.tSetFinalTeam && (
              <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
                {["a", "b"].map((side) => (
                  <select key={side} value={(side === "a" ? t.final?.teamA : t.final?.teamB) || ""}
                    onChange={(e) => actions.tSetFinalTeam(side, e.target.value || null)}
                    style={{ padding: "7px 10px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(255,209,102,0.3)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 12.5, fontWeight: 600 }}>
                    <option value="">{side === "a" ? "— Team A —" : "— Team B —"}</option>
                    {t.teamIds.map((id) => { const tm = teamOf(id); return tm ? <option key={id} value={id}>{tm.name}</option> : null; })}
                  </select>
                ))}
              </div>
            )}
          </TPanel>
        </div>
      )}

      {/* SINGLE ELIM */}
      {t.format === "single" && (
        <TPanel>
          <TBracket rounds={t.rounds} teamOf={teamOf} isAdmin={isAdmin} {...A} />
        </TPanel>
      )}

      {/* manual override panel (admin) */}
      {isAdmin && (t.format === "group" || (t.format === "roundrobin" || t.format === "league")) && (
        <TPanel className="mt-6" hue="#ffb020">
          <p className="uppercase text-sm font-bold tracking-widest mb-2" style={{ color: "#ffb020", fontFamily: "'Rajdhani',sans-serif" }}>⚙ Manual standings override</p>
          <p className="text-[11px] mb-3" style={{ color: "rgba(200,215,255,0.45)" }}>Force points / round-diff for a team (forfeits, penalties). Leave blank to clear. Overridden teams show a *.</p>
          <TOverrideEditor state={state} t={t} teamOf={teamOf} onOverride={actions.tOverride} />
        </TPanel>
      )}
    </div>
  );
}

// small override editor
function TOverrideEditor({ state, t, teamOf, onOverride }) {
  const ids = t.format === "group" ? t.groups.flatMap((g) => g.teamIds) : t.teamIds;
  const [sel, setSel] = useState(ids[0] || "");
  const [pts, setPts] = useState("");
  const [diff, setDiff] = useState("");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <select value={sel} onChange={(e) => setSel(e.target.value)} className="px-2 py-1.5 outline-none" style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 13 }}>
        {ids.map((id) => <option key={id} value={id} style={{ background: "#0a0d18" }}>{teamOf(id)?.name}</option>)}
      </select>
      <div className="flex flex-col"><span className="text-[10px] uppercase" style={{ color: "rgba(200,215,255,0.4)" }}>pts</span><input type="number" value={pts} onChange={(e) => setPts(e.target.value)} placeholder="—" className="w-16 px-2 py-1.5 outline-none" style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }} /></div>
      <div className="flex flex-col"><span className="text-[10px] uppercase" style={{ color: "rgba(200,215,255,0.4)" }}>diff</span><input type="number" value={diff} onChange={(e) => setDiff(e.target.value)} placeholder="—" className="w-16 px-2 py-1.5 outline-none" style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13 }} /></div>
      <button onClick={() => { const patch = {}; if (pts !== "") patch.pts = Number(pts); if (diff !== "") patch.diff = Number(diff); onOverride(sel, Object.keys(patch).length ? patch : null); }} className="px-3 py-1.5 text-xs uppercase tracking-widest" style={{ color: "#06080e", background: "#ffb020", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>Apply</button>
      <button onClick={() => onOverride(sel, null)} className="px-3 py-1.5 text-xs uppercase tracking-widest" style={{ color: "rgba(255,176,32,0.9)", border: "1px solid rgba(255,176,32,0.4)", fontFamily: "'Rajdhani',sans-serif" }}>Clear</button>
    </div>
  );
}
function RankBadge({ rank, div, size = "md" }) {
  const r = RANKS[rank] || RANKS.Iron;
  const dim = size === "xl" ? 80 : size === "lg" ? 64 : size === "md" ? 34 : 24;
  const showDiv = hasDivisions(rank) && !!div;
  return (
    <div className="relative grid place-items-center" style={{ width: dim, height: dim }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 w-full h-full">
        <polygon points="50,4 93,27 93,73 50,96 7,73 7,27" fill={r.c + "14"} stroke={r.c} strokeWidth="5"
          style={{ filter: `drop-shadow(0 0 ${size === "lg" || size === "xl" ? 10 : 5}px ${r.glow})` }} />
        <polygon points="50,22 76,36 76,64 50,78 24,64 24,36" fill={r.c} opacity="0.9" />
      </svg>
      <span className="relative font-bold text-black" style={{ fontSize: dim * 0.34, fontFamily: "'Rajdhani',sans-serif" }}>
        {rank === "Radiant" ? "R" : rank[0]}
      </span>
      {/* Division rides in the corner rather than inside the crest — at 24px the
          hexagon has no room for two glyphs without both becoming unreadable. */}
      {showDiv && (
        <span style={{ position: "absolute", right: dim * -0.06, bottom: dim * -0.04,
          minWidth: dim * 0.38, height: dim * 0.38, display: "grid", placeItems: "center",
          fontSize: dim * 0.28, lineHeight: 1, fontWeight: 700, fontFamily: "'Rajdhani',sans-serif",
          color: r.c, background: "#0a0d18", border: `1px solid ${r.c}`, borderRadius: dim * 0.1,
          padding: `0 ${dim * 0.06}px` }}>{div}</span>
      )}
    </div>
  );
}


// Big hero crest that foregrounds the player's RANK (the meaningful headline stat)
function RankCrest({ rank, div }) {
  const r = RANKS[rank] || RANKS.Iron;
  const s = 104;
  const letter = rank === "Radiant" ? "R" : rank[0];
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
        style={{ color: r.c, fontSize: s * 0.40, fontFamily: "'Rajdhani',sans-serif", textShadow: `0 0 16px ${r.glow}` }}>
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

function Tag({ children, hue = "#9d6bff" }) {
  return (
    <span className="inline-flex items-center px-3.5 py-1.5 text-xs uppercase tracking-widest font-semibold leading-none"
      style={{ fontFamily: "'Rajdhani',sans-serif", color: hue, border: `1px solid ${hue}55`, background: `${hue}14`,
        clipPath: "polygon(8px 0,100% 0,calc(100% - 8px) 100%,0 100%)" }}>
      {children}
    </span>
  );
}

function Stat({ label, value, hue }) {
  return (
    <div className="flex flex-col items-center gap-1 px-3 py-2 rounded-md"
      style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
      <span className="text-2xl font-bold leading-none" style={{ fontFamily: "'Rajdhani',sans-serif", color: hue, textShadow: `0 0 14px ${hue}66` }}>{value}</span>
      <span className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.5)" }}>{label}</span>
    </div>
  );
}

/* ── KDA / performance radar ── */
function StatRadar({ player, size = 200, hue }) {
  // normalize stats to 0..1 against sensible community ceilings
  const axes = [
    { label: "KDA", v: Math.min(player.kda / 1.8, 1) },
    { label: "ACS", v: Math.min(player.acs / 320, 1) },
    { label: "HS%", v: Math.min(player.hs / 45, 1) },
    { label: "WIN%", v: Math.min((player.win || 0) / 100, 1) },
    { label: "RANK", v: (RANK_LIST.indexOf(player.rank) + 1) / RANK_LIST.length },
  ];
  const c = size / 2, R = c - 30, n = axes.length;
  const pt = (i, rad) => {
    const a = (Math.PI * 2 * i) / n - Math.PI / 2;
    return [c + rad * Math.cos(a), c + rad * Math.sin(a)];
  };
  const ring = (f) => axes.map((_, i) => pt(i, R * f).join(",")).join(" ");
  const shape = axes.map((ax, i) => pt(i, R * Math.max(ax.v, 0.05)).join(",")).join(" ");
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <polygon key={f} points={ring(f)} fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="1" />
      ))}
      {axes.map((_, i) => { const [x, y] = pt(i, R); return <line key={i} x1={c} y1={c} x2={x} y2={y} stroke="rgba(255,255,255,0.10)" />; })}
      <polygon points={shape} fill={hue + "33"} stroke={hue} strokeWidth="2" style={{ filter: `drop-shadow(0 0 8px ${hue}88)` }} />
      {axes.map((ax, i) => {
        const [x, y] = pt(i, R + 18);
        return <text key={i} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fontSize="11" fontFamily="'Rajdhani',sans-serif"
          fontWeight="700" letterSpacing="1" fill="rgba(236,243,255,0.7)">{ax.label}</text>;
      })}
      {axes.map((ax, i) => { const [x, y] = pt(i, R * Math.max(ax.v, 0.05)); return <circle key={i} cx={x} cy={y} r="3" fill={hue} />; })}
    </svg>
  );
}

/* ════════════════ TRADING CARD ════════════════════════════════════ */

function PlayerCard({ player, lite = false }) {
  if (!player) return null;
  const r = RANKS[player.rank] || RANKS.Iron;
  return (
    <div className="relative mx-auto w-full" style={{ maxWidth: 420 }}>
      <div className="absolute -inset-6 pointer-events-none"
        style={{ background: `radial-gradient(ellipse at 50% 30%, ${r.glow}, transparent 70%)`, filter: "blur(18px)" }} />
      <div className="relative overflow-hidden"
        style={{
          clipPath: "polygon(0 0, calc(100% - 26px) 0, 100% 26px, 100% 100%, 26px 100%, 0 calc(100% - 26px))",
          background: "linear-gradient(160deg, rgba(20,26,42,0.92), rgba(10,13,22,0.92))",
          border: `1px solid ${r.c}66`, boxShadow: `0 0 0 1px rgba(255,255,255,0.04) inset, 0 30px 60px rgba(0,0,0,0.6)`,
          backdropFilter: lite ? undefined : "blur(14px)",
        }}>
        {!lite && <div className="absolute inset-0 pointer-events-none holo-sweep" />}
        <div className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 4px)" }} />
        <div className="flex items-center justify-between px-5 pt-5">
          <span className="text-xs uppercase tracking-widest font-semibold" style={{ color: r.c, fontFamily: "'Rajdhani',sans-serif" }}>// SCOUT FILE</span>
          <span className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.4)" }}>{ROLE_GLYPH[player.role]} {player.role}</span>
        </div>
        <div className="relative flex flex-col items-center pt-8 pb-5 mt-4 mx-3 rounded-xl overflow-hidden"
          style={{ background: `linear-gradient(115deg, rgba(255,70,85,0.34), rgba(157,107,255,0.22) 60%, rgba(0,229,255,0.10))`, border: "1px solid rgba(255,255,255,0.08)" }}>
          <span className="absolute pointer-events-none select-none font-bold leading-none"
            style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 150, right: -10, top: -18, color: "rgba(255,255,255,0.07)", letterSpacing: "-0.04em" }}>{player.acs}</span>
          <span className="absolute pointer-events-none select-none uppercase font-bold"
            style={{ fontFamily: "'Rajdhani',sans-serif", right: 14, top: 112, fontSize: 12, letterSpacing: 3, color: "rgba(255,255,255,0.18)" }}>ACS</span>
          <div className={lite ? "" : "float-soft"}><RankCrest rank={player.rank} div={player.rankDiv} /></div>
          <h2 className="relative mt-6 text-5xl font-bold uppercase leading-none text-center px-4"
            style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff", letterSpacing: "0.04em", textShadow: `0 0 24px ${r.glow}` }}>{player.name}</h2>
          <div className="relative mt-4 flex items-center gap-3 pb-2">
            <span className="uppercase tracking-widest font-semibold" style={{ color: r.c, fontFamily: "'Rajdhani',sans-serif", textShadow: `0 0 10px ${r.glow}` }}>{rankLabel(player.rank, player.rankDiv)}</span>
            <span style={{ color: "rgba(236,243,255,0.35)" }}>·</span>
            <span className="uppercase tracking-widest text-sm" style={{ color: "rgba(236,243,255,0.75)" }}>{player.agent}</span>
          </div>
          {/* Peak sits under the current rank, deliberately quieter — it's context
              for a captain, not the number the auction runs on. */}
          {player.peakRank && (
            <div className="relative flex items-center gap-2 pb-1" title="Highest rank ever reached. Does not affect the opening bid.">
              <span className="uppercase text-[10px] tracking-[0.2em]" style={{ color: "rgba(236,243,255,0.35)", fontFamily: "'Rajdhani',sans-serif" }}>Peak</span>
              <span className="uppercase text-xs font-semibold tracking-widest" style={{ color: rankOf(player.peakRank).c, opacity: 0.85, fontFamily: "'Rajdhani',sans-serif" }}>{rankLabel(player.peakRank, player.peakRankDiv)}</span>
            </div>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2 px-5 pt-5">
          <Stat label="KDA" value={player.kda == null ? "—" : Number(player.kda).toFixed(2)} hue="#00e5ff" />
          <Stat label="ACS" value={player.acs == null ? "—" : player.acs} hue="#ff4655" />
          <Stat label="HS %" value={player.hs == null ? "—" : player.hs + "%"} hue="#9d6bff" />
        </div>
        <div className="px-5 pt-5 pb-7">
          <p className="text-xs uppercase tracking-widest mb-2" style={{ color: "rgba(236,243,255,0.4)" }}>Trophy cabinet</p>
          <div className="flex flex-wrap items-center gap-2" style={{ minHeight: 40 }}>
            {player.trophies > 0 && <Tag hue="#f5c453">🏆 ×{player.trophies} in a row</Tag>}
            {player.badges?.length ? player.badges.map((b, i) => <Tag key={i} hue={i % 2 ? "#00e5ff" : "#9d6bff"}>{b}</Tag>)
              : !player.trophies && <span className="text-sm" style={{ color: "rgba(236,243,255,0.3)" }}>No titles yet — write the first chapter.</span>}
          </div>
        </div>
        <div style={{ height: 4, background: `linear-gradient(90deg, transparent, ${r.c}, transparent)` }} />
      </div>
    </div>
  );
}

/* ── full scouting modal with radar ── */
function ScoutModal({ player, onClose, isAdmin, onEdit, onDelete, onToggleCaptain, onViewProfile, onMoveReserve }) {
  const [confirmDel, setConfirmDel] = useState(false);
  useEffect(() => { setConfirmDel(false); }, [player && player.id]);
  // Close on Escape for keyboard users.
  useEffect(() => {
    if (!player) return;
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [player, onClose]);
  if (!player) return null;
  const r = rankOf(player.rank);
  const drafted = player.status === "sold";
  return (
    <div role="dialog" aria-modal="true" aria-label={`Scouting report for ${player.name}`} className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(5,6,12,0.84)", backdropFilter: "blur(8px)" }} onClick={onClose}>
      <div className="relative w-full grid md:grid-cols-2 gap-6 items-stretch" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <button onClick={onClose} aria-label="Close" className="absolute -top-2 right-0 md:-right-2 z-10 w-9 h-9 grid place-items-center rounded-full"
          style={{ background: "rgba(61,123,255,0.12)", border: "1px solid rgba(61,123,255,0.4)", color: "#ecf3ff" }}>✕</button>
        <PlayerCard player={player} />
        <div className="p-5 flex flex-col" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.06), rgba(10,15,28,0.55))", border: `1px solid ${r.c}44`, backdropFilter: "blur(12px)", clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))" }}>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: r.c }}>Performance profile</p>
          <div className="grid place-items-center flex-1 pt-4"><StatRadar player={player} hue={r.c} size={300} /></div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }}><span style={{ color: "rgba(200,215,255,0.5)" }}>Role</span><span style={{ color: "#ecf3ff" }}>{player.role}</span></div>
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }}><span style={{ color: "rgba(200,215,255,0.5)" }}>Agent</span><span style={{ color: "#ecf3ff" }}>{player.agent}</span></div>
            {/* Naming the tier here removes the ambiguity a peak rank introduces:
                the opener comes from CURRENT rank, never peak. */}
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }} title="Set by current rank — peak rank never affects the price"><span style={{ color: "rgba(200,215,255,0.5)" }}>Opens at</span><span style={{ fontFamily: "'IBM Plex Mono',monospace", color: r.c }}>{fmt(r.bid)} <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 11, opacity: 0.6, textTransform: "uppercase", letterSpacing: "0.08em" }}>{player.rank}</span></span></div>
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }}><span style={{ color: "rgba(200,215,255,0.5)" }}>Status</span><span style={{ color: player.status === "sold" ? "#3ddc84" : "#5b8dff" }}>{player.status === "sold" ? "Drafted" : player.status === "block" ? "On block" : "Available"}</span></div>
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }}><span style={{ color: "rgba(200,215,255,0.5)" }}>Current</span><span style={{ color: r.c, fontWeight: 600 }}>{rankLabel(player.rank, player.rankDiv)}</span></div>
            <div className="flex justify-between px-3 py-2 rounded" style={{ background: "rgba(61,123,255,0.06)" }} title="Highest rank ever reached. Does not affect the opening bid."><span style={{ color: "rgba(200,215,255,0.5)" }}>Peak</span><span style={{ color: player.peakRank ? (rankOf(player.peakRank).c) : "rgba(200,215,255,0.35)", fontWeight: 600 }}>{player.peakRank ? rankLabel(player.peakRank, player.peakRankDiv) : "—"}</span></div>
          </div>
          {onViewProfile && typeof player.id === "string" && player.id.length > 30 && (
            <button onClick={() => onViewProfile(player.id)}
              className="mt-3 w-full py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
              style={{ fontFamily: "'Rajdhani',sans-serif", background: `${r.c}1f`, border: `1px solid ${r.c}`, color: r.c, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", textShadow: `0 0 12px ${r.c}66` }}>
              ⊹ View full profile →
            </button>
          )}
          {player.tracker && (
            <a href={player.tracker} target="_blank" rel="noopener noreferrer"
              className="mt-3 block w-full py-2.5 text-center text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
              style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(0,229,255,0.08)", border: "1px solid rgba(0,229,255,0.45)", color: "#7deaff", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", textDecoration: "none" }}>
              ⌖ View tracker profile ↗
            </a>
          )}
          {isAdmin && (
            <button onClick={() => onEdit(player)} className="mt-4 w-full py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
              style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)", color: "#aec6ff", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
              ✎ Edit player profile
            </button>
          )}
          {isAdmin && (
            <button onClick={() => onToggleCaptain(player.id)} className="mt-2 w-full py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
              style={{ fontFamily: "'Rajdhani',sans-serif",
                background: player.isCaptain ? "rgba(245,196,83,0.18)" : "rgba(255,255,255,0.04)",
                border: `1px solid ${player.isCaptain ? "#f5c453" : "rgba(120,150,220,0.3)"}`,
                color: player.isCaptain ? "#f5d58a" : "rgba(200,215,255,0.6)",
                clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
              {player.isCaptain ? "★ Captain — excluded from draw" : "☆ Tag as captain"}
            </button>
          )}
          {isAdmin && typeof player.id === "string" && player.id.length > 30 && (
            <p className="mt-2 text-center" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 11, color: "rgba(200,215,255,0.4)", letterSpacing: "0.06em" }}>Registered player — leaves the pool by dropping their tournament registration.</p>
          )}
          {isAdmin && !(typeof player.id === "string" && player.id.length > 30) && (
            confirmDel ? (
              <div className="mt-2 flex gap-2">
                <button onClick={() => { onDelete(player.id); onClose(); }} className="flex-1 py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
                  style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(255,70,85,0.2)", border: "1px solid #ff4655", color: "#ff8a94", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
                  Confirm delete
                </button>
                <button onClick={() => setConfirmDel(false)} className="px-4 py-2.5 text-sm font-bold uppercase tracking-widest"
                  style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.16)", color: "rgba(236,243,255,0.6)", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
                  Cancel
                </button>
              </div>
            ) : (
              <button onClick={() => setConfirmDel(true)} className="mt-2 w-full py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
                style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(255,70,85,0.1)", border: "1px solid rgba(255,70,85,0.45)", color: "#ff8a94", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
                {drafted ? "✕ Delete player (drafted)" : "✕ Delete player"}
              </button>
            )
          )}
          {isAdmin && onMoveReserve && !player.isCaptain && (
            <button onClick={() => {
                const toReserve = player.poolEligible !== false;
                if (toReserve && player.status === "sold" && !window.confirm(
                  `Move ${player.name} to the reserves? ${fmt(Number(player.soldPrice) || 0)} goes back to their team and the roster slot reopens.`)) return;
                onMoveReserve(player.id, !toReserve);
                onClose();
              }}
              className="mt-2 w-full py-2.5 text-sm font-bold uppercase tracking-widest transition-transform active:scale-95"
              style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(61,220,132,0.08)", border: "1px solid rgba(61,220,132,0.45)", color: "#9af5c2", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
              {player.poolEligible === false ? "⊞ Move to draft pool" : "⊕ Move to reserves"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ════════════════ FATE WHEEL ══════════════════════════════════════ */
const REEL_SCALE = 0.66;  // scale applied to the real 420px PlayerCard
const REEL_CARD_H = 520;  // fixed slot height — fits the taller portrait card
const REEL_CARD_W = 292;  // full slot width incl. gap (scaled card ≈277 + small gap)
const REEL_GAP = 14;
const REEL_INNER = REEL_CARD_W - REEL_GAP;
/* mini player card used inside the reel */
// Two-phase reel easing: constant-speed cruise (first 45% of time → 71% of distance),
// then a velocity-continuous cubic ease-out that glides to ZERO velocity at the end.
// This avoids the abrupt stop a single cubic-bezier produces.
const REEL_T1 = 0.45;                 // cruise portion of the timeline
const REEL_D1 = (3 * REEL_T1) / (1 + 2 * REEL_T1); // distance covered during cruise (velocity-matched)
function REEL_EASE(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  if (t <= REEL_T1) return (REEL_D1 / REEL_T1) * t;          // linear cruise
  const u = (t - REEL_T1) / (1 - REEL_T1);
  return REEL_D1 + (1 - REEL_D1) * (1 - Math.pow(1 - u, 3)); // soft ease-out tail
}

function ReelCard({ player, center, dim, idle }) {
  // render the REAL trading card, scaled to fit the reel slot; center card grows
  return (
    <div className="relative shrink-0 overflow-visible" style={{
      width: REEL_INNER, height: REEL_CARD_H, marginRight: REEL_GAP,
      opacity: idle ? 0.82 : dim ? 0.4 : 1,
      transform: center ? "scale(1.1)" : idle ? "scale(0.92)" : "scale(0.9)",
      transition: idle ? "none" : "opacity 220ms, transform 220ms",
      zIndex: center ? 3 : 1,
    }}>
      <div className="absolute left-1/2 top-1/2" style={{ width: 420, transform: `translate(-50%, -50%) scale(${REEL_SCALE})` }}>
        <PlayerCard player={player} lite={!center} />
      </div>
    </div>
  );
}

function ReelStage({ spin, players, pool, isAdmin, onDraw, canDraw }) {
  // active draw if a spin exists and hasn't fully revealed yet, OR landed (show winner)
  const drawing = !!spin;
  const wheelPool = drawing ? spin.pool.map((id) => players.find((p) => p.id === id)).filter(Boolean) : pool;
  const n = Math.max(wheelPool.length, 1);

  const [vw, setVw] = useState(typeof window !== "undefined" ? window.innerWidth : 1200);
  useEffect(() => { const f = () => setVw(window.innerWidth); window.addEventListener("resize", f); return () => window.removeEventListener("resize", f); }, []);
  // inline stage is inside the page shell (max 1760, with padding); approximate usable width
  const stageW = Math.min(vw - 40, 1720);

  const [x, setX] = useState(0);
  const [centerIdx, setCenterIdx] = useState(0);

  // ── DRAW animation ──
  const LOOPS = 6;
  const winnerPoolIdx = drawing ? Math.max(spin.pool.indexOf(spin.playerId), 0) : 0;
  const winnerIndex = LOOPS * n + winnerPoolIdx;
  const drawReel = drawing ? Array.from({ length: winnerIndex + n + 8 }, (_, i) => wheelPool[i % n]) : [];
  const winner = drawing ? players.find((p) => p.id === spin.playerId) : null;
  const wr = winner ? rankOf(winner.rank) : RANKS.Iron;
  const done = drawing && Date.now() >= spin.startTs + spin.duration;

  useEffect(() => {
    if (!drawing) return;
    const startX = stageW / 2 - (REEL_CARD_W - REEL_GAP) / 2;
    const finalX = -(winnerIndex * REEL_CARD_W + (REEL_CARD_W - REEL_GAP) / 2) + stageW / 2;
    const total = startX - finalX;
    let lastTickIdx = -1;
    const apply = (t) => {
      const curX = startX - total * REEL_EASE(t);
      setX(curX);
      const idx = Math.round((stageW / 2 - curX - (REEL_CARD_W - REEL_GAP) / 2) / REEL_CARD_W);
      const clamped = Math.max(0, Math.min(idx, drawReel.length - 1));
      setCenterIdx(clamped);
      // play a mechanical tick on each new card that crosses center (skip the very first frame)
      if (clamped !== lastTickIdx) {
        if (lastTickIdx !== -1 && t < 0.999) SndFX.play("tick", t);
        lastTickIdx = clamped;
      }
    };
    if (Date.now() - spin.startTs >= spin.duration) { apply(1); return; }
    let frame;
    const step = () => {
      const t = Math.min((Date.now() - spin.startTs) / spin.duration, 1);
      apply(t);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [spin?.startTs, drawing, stageW]); // eslint-disable-line

  // ── IDLE slow drift (CSS-driven, no per-frame React renders) ──
  // strip is two identical halves; CSS shifts it -50% then loops seamlessly
  // idle strip only needs enough cards to fill the visible stage (×2 for seamless loop), not the whole pool
  const idleCount = Math.min(n, Math.ceil(stageW / REEL_CARD_W) + 2);
  const idleHalf = Array.from({ length: Math.max(idleCount, 4) }, (_, i) => wheelPool[i % n]);
  const idleReel = drawing ? [] : [...idleHalf, ...idleHalf];

  const headline = drawing ? (done ? "Target acquired" : "Drawing the next player") : "The draft pool";
  const glow = drawing ? (done ? wr.glow : "rgba(61,123,255,0.32)") : "rgba(61,123,255,0.22)";

  return (
    <div className="w-full flex flex-col items-center">
      {/* heading */}
      <div className="text-center mb-4">
        <p className="uppercase tracking-[0.35em] font-bold text-sm" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#5b8dff", textShadow: "0 0 14px rgba(61,123,255,0.7)" }}>{drawing ? "// FATE PROTOCOL ENGAGED" : "// AWAITING DRAW"}</p>
        <h2 className="text-3xl md:text-4xl font-bold uppercase mt-1" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff", letterSpacing: "0.06em" }}>{headline}</h2>
      </div>

      {/* reel */}
      <div className="relative w-full mt-4" style={{ height: REEL_CARD_H + 50, overflow: "hidden" }}>
        <div className="absolute pointer-events-none" style={{ left: 0, right: 0, top: -20, bottom: -20, background: `radial-gradient(ellipse 30% 80% at 50% 50%, ${glow}, transparent 70%)`, filter: "blur(20px)", transition: "background 600ms" }} />
        {/* edge fades */}
        <div className="absolute inset-y-0 left-0 z-10 pointer-events-none" style={{ width: 80, background: "linear-gradient(90deg, #0a0d18, transparent)" }} />
        <div className="absolute inset-y-0 right-0 z-10 pointer-events-none" style={{ width: 80, background: "linear-gradient(270deg, #0a0d18, transparent)" }} />
        {/* center marker */}
        <div className="absolute left-1/2 top-0 bottom-0 z-20 pointer-events-none" style={{ transform: "translateX(-50%)" }}>
          <div className="absolute left-1/2" style={{ top: -14, transform: "translateX(-50%)", filter: "drop-shadow(0 0 9px rgba(255,70,85,0.9))" }}>
            <div style={{ width: 0, height: 0, borderLeft: "11px solid transparent", borderRight: "11px solid transparent", borderTop: "18px solid #ff4655" }} />
          </div>
          <div className="absolute left-1/2" style={{ bottom: -14, transform: "translateX(-50%)", filter: "drop-shadow(0 0 9px rgba(255,70,85,0.9))" }}>
            <div style={{ width: 0, height: 0, borderLeft: "11px solid transparent", borderRight: "11px solid transparent", borderBottom: "18px solid #ff4655" }} />
          </div>
          <div className="absolute top-0 bottom-0 left-1/2" style={{ width: 2, transform: "translateX(-50%)", background: "linear-gradient(180deg, transparent, rgba(255,70,85,0.45), transparent)" }} />
        </div>

        {drawing ? (
          <div className="absolute top-1/2 flex items-center" style={{ left: 0, transform: `translate(${x}px, -50%)`, willChange: "transform" }}>
            {drawReel.map((p, i) => {
              // windowing: only mount real cards near the visible center; far cards are width-preserving spacers
              const WIN = 7;
              if (Math.abs(i - centerIdx) > WIN) {
                return <div key={i} className="shrink-0" style={{ width: REEL_INNER, height: REEL_CARD_H, marginRight: REEL_GAP }} />;
              }
              return <ReelCard key={i} player={p} center={i === centerIdx} dim={i !== centerIdx} />;
            })}
          </div>
        ) : (
          <div className="absolute top-1/2 flex items-center reel-drift" style={{ left: 0, transform: "translateY(-50%)", willChange: "transform" }}>
            {idleReel.map((p, i) => <ReelCard key={i} player={p} center={false} dim idle />)}
          </div>
        )}
      </div>

      {/* status / controls */}
      <div className="mt-5 min-h-[88px] flex flex-col items-center justify-center text-center">
        {drawing && done && winner ? (
          <div className="bid-pop">
            <p className="text-5xl font-bold uppercase leading-none" style={{ fontFamily: "'Rajdhani',sans-serif", color: wr.c, textShadow: `0 0 30px ${wr.glow}` }}>{winner.name}</p>
            <p className="uppercase tracking-widest text-sm mt-2" style={{ color: "rgba(236,243,255,0.6)" }}>{winner.rank} · heads to the block at {fmt(rankOf(winner.rank).bid)}</p>
          </div>
        ) : drawing ? (
          <p className="uppercase tracking-widest text-sm animate-pulse" style={{ color: "rgba(236,243,255,0.45)" }}>{n} candidates in the draw…</p>
        ) : isAdmin ? (
          <>
            <p className="text-sm mb-4" style={{ color: "rgba(236,243,255,0.5)" }}>{canDraw ? `${pool.length} players in the pool. Hit draw and fate decides who's up.` : "Pool is empty — add players in the Scout Hub."}</p>
            <button onClick={onDraw} disabled={!canDraw} className={"ea-btn relative" + (canDraw ? "" : " ea-disabled")}
              style={{ display: "inline-block", padding: "2px", clipPath: "polygon(0 0, calc(100% - 20px) 0, 100% 20px, 100% 100%, 20px 100%, 0 calc(100% - 20px))", background: canDraw ? "#3d7bff" : "rgba(120,140,180,0.25)", boxShadow: canDraw ? "0 0 34px rgba(61,123,255,0.45)" : "none", cursor: canDraw ? "pointer" : "not-allowed" }}>
              <span className="ea-fill flex items-center justify-center gap-3 font-bold uppercase tracking-[0.28em]"
                style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "clamp(1rem,1.8vw,1.5rem)", lineHeight: 1, padding: "18px 44px", clipPath: "polygon(0 0, calc(100% - 19px) 0, 100% 19px, 100% 100%, 19px 100%, 0 calc(100% - 19px))", background: "linear-gradient(180deg, #0b1426, #070d18)", color: canDraw ? "#cfe0ff" : "rgba(200,215,255,0.3)" }}>
                <span className="ea-arrow" style={{ fontFamily: "'IBM Plex Mono',monospace", lineHeight: 1, position: "relative", top: "-0.04em" }}>⇆</span>
                <span style={{ lineHeight: 1 }}>Draw a Player</span>
              </span>
            </button>
          </>
        ) : (
          <p className="text-sm uppercase tracking-widest animate-pulse" style={{ color: "rgba(236,243,255,0.45)" }}>Waiting for the host to draw the next player…</p>
        )}
      </div>
    </div>
  );
}


/* ════════════════ ADD PLAYER FORM ═════════════════════════════════ */
const inputCls = "w-full px-3 py-2 rounded-sm text-sm outline-none";
const inputStyle = { background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "#ecf3ff", fontFamily: "'Space Grotesk',sans-serif" };
function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)" }}>{label}</span>{children}</label>;
}
function AddPlayerForm({ onAdd, editing, onSave, onCancel }) {
  const init = editing
    ? { name: editing.name, rank: editing.rank, role: editing.role, agent: editing.agent, kda: String(editing.kda), acs: String(editing.acs), hs: String(editing.hs), win: editing.win != null ? String(editing.win) : "", badgeInput: "", badges: editing.badges || [] }
    : { name: "", rank: "Gold", role: "Duelist", agent: "Jett", kda: "", acs: "", hs: "", win: "", badgeInput: "", badges: [] };
  const [f, setF] = useState(init);
  // re-seed when switching which player is being edited
  useEffect(() => { setF(init); }, [editing?.id]); // eslint-disable-line
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const addBadge = () => { const b = f.badgeInput.trim(); if (b) setF({ ...f, badges: [...f.badges, b], badgeInput: "" }); };
  const submit = () => {
    if (!f.name.trim()) return;
    const data = { name: f.name.trim(), rank: f.rank, role: f.role, agent: f.agent, kda: parseFloat(f.kda) || 1.0, acs: parseInt(f.acs) || 200, hs: parseInt(f.hs) || 20, win: Math.max(0, Math.min(parseInt(f.win) || 50, 100)), badges: f.badges };
    if (editing) { onSave({ ...editing, ...data }); }
    else { onAdd({ id: uid(), ...data, status: "pool", soldTo: null, soldPrice: null }); setF(init); }
  };
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Field label="Player name"><input className={inputCls} style={inputStyle} value={f.name} onChange={set("name")} placeholder="e.g. Zephyr" /></Field>
      <Field label="Rank"><select className={inputCls} style={inputStyle} value={f.rank} onChange={set("rank")}>{RANK_LIST.map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label="Primary role"><select className={inputCls} style={inputStyle} value={f.role} onChange={set("role")}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></Field>
      <Field label="Main agent"><select className={inputCls} style={inputStyle} value={f.agent} onChange={set("agent")}>{AGENTS.map((a) => <option key={a}>{a}</option>)}</select></Field>
      <Field label="KDA"><input className={inputCls} style={inputStyle} value={f.kda} onChange={set("kda")} placeholder="1.24" /></Field>
      <Field label="ACS"><input className={inputCls} style={inputStyle} value={f.acs} onChange={set("acs")} placeholder="245" /></Field>
      <Field label="Headshot %"><input className={inputCls} style={inputStyle} value={f.hs} onChange={set("hs")} placeholder="28" /></Field>
      <Field label="Win %"><input className={inputCls} style={inputStyle} value={f.win} onChange={set("win")} placeholder="52" /></Field>
      <Field label="Add badge / title">
        <div className="flex gap-2">
          <input className={inputCls} style={inputStyle} value={f.badgeInput} onChange={set("badgeInput")} onKeyDown={(e) => e.key === "Enter" && addBadge()} placeholder="MVP, IGL…" />
          <button onClick={addBadge} className="px-3 rounded-sm text-sm font-bold" style={{ background: "#3d7bff22", border: "1px solid #3d7bff66", color: "#aec6ff" }}>+</button>
        </div>
      </Field>
      {f.badges.length > 0 && (
        <div className="col-span-2 lg:col-span-4 flex flex-wrap gap-2">
          {f.badges.map((b, i) => <button key={i} onClick={() => setF({ ...f, badges: f.badges.filter((_, j) => j !== i) })}><Tag hue="#3d7bff">{b} ✕</Tag></button>)}
        </div>
      )}
      <div className="col-span-2 lg:col-span-4 flex gap-3">
        <button onClick={submit} className="flex-1 py-3 font-bold uppercase tracking-widest text-sm transition-transform active:scale-95"
          style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(14px 0,100% 0,calc(100% - 14px) 100%,0 100%)", background: editing ? "linear-gradient(90deg,#3ddc8422,#3ddc8444)" : "linear-gradient(90deg,#3d7bff22,#3d7bff44)", border: `1px solid ${editing ? "#3ddc8488" : "#3d7bff88"}`, color: editing ? "#9af5c2" : "#aec6ff" }}>
          {editing ? "Save changes" : "Add to draft pool"}
        </button>
        {editing && <button onClick={onCancel} className="px-6 py-3 text-sm font-bold uppercase tracking-widest rounded-sm" style={{ border: "1px solid rgba(120,150,220,0.2)", color: "rgba(200,215,255,0.6)" }}>Cancel</button>}
      </div>
    </div>
  );
}

/* ════════════════ TEAM CARD (locker room, editable by admin) ══════ */
function TeamCard({ team, players, lead, isAdmin, onRename, onScout, onRemove, canRemove, onAddToRoster, onRemoveFromRoster, onSetBudget }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(team.name);
  const [cap, setCap] = useState(team.captain);
  const [confirmDel, setConfirmDel] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [addPid, setAddPid] = useState("");
  const [addPrice, setAddPrice] = useState("");
  const [budgetEdit, setBudgetEdit] = useState(false);
  const [budgetVal, setBudgetVal] = useState(String(team.budget));
  useEffect(() => { if (!budgetEdit) setBudgetVal(String(team.budget)); }, [team.budget, budgetEdit]);
  useEffect(() => { if (!editing) { setName(team.name); setCap(team.captain); setConfirmDel(false); } }, [team.name, team.captain, editing]);
  const saveBudget = () => { const v = Math.max(0, parseInt(budgetVal, 10) || 0); onSetBudget(team.id, v); setBudgetEdit(false); };

  const rosterPlayers = team.roster.map((id) => players.find((p) => p.id === id)).filter(Boolean);
  const rolesHave = new Set(rosterPlayers.map((p) => p.role));
  const rolesNeed = ROLES.filter((r) => r !== "Flex" && !rolesHave.has(r));
  // Same definition the auction uses: captains and late sign-ups can't be bought,
  // so they must not count toward the budget a captain has to hold back.
  const availablePool = players.filter((p) => p.status === "pool" && !p.isCaptain && p.poolEligible !== false);
  const submitAdd = () => { if (!addPid) return; onAddToRoster(team.id, addPid, addPrice === "" ? 0 : Number(addPrice)); setAddPid(""); setAddPrice(""); setAddOpen(false); };
  const save = () => { onRename(team.id, name, cap); setEditing(false); };

  return (
    <div className="relative overflow-hidden rounded-2xl flex flex-col" style={{ background: `linear-gradient(160deg, ${team.hue}16, rgba(255,255,255,0.03) 55%)`, border: `1px solid ${lead ? "#ff4655" : team.hue + "55"}`, boxShadow: lead ? "0 0 24px rgba(255,70,85,0.3)" : "0 14px 30px rgba(0,0,0,0.35)" }}>
      <div style={{ height: 3, background: `linear-gradient(90deg, ${team.hue}, transparent)` }} />
      <div className="p-4 flex flex-col gap-3 flex-1">
        <div className="flex items-start justify-between gap-2">
          {editing ? (
            <div className="flex-1 flex flex-col gap-1.5">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" maxLength={22}
                className="w-full px-2 py-1.5 rounded text-sm font-bold uppercase outline-none"
                style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(255,255,255,0.06)", border: `1px solid ${team.hue}66`, color: team.hue }} />
              <input value={cap} onChange={(e) => setCap(e.target.value)} placeholder="Captain" maxLength={18}
                onKeyDown={(e) => e.key === "Enter" && save()}
                className="w-full px-2 py-1 rounded text-xs outline-none"
                style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", color: "#ecf3ff" }} />
              <div className="flex gap-2 mt-1">
                <button onClick={save} className="px-3 py-1 text-xs font-bold uppercase tracking-widest rounded" style={{ background: "rgba(61,220,132,0.18)", border: "1px solid #3ddc8488", color: "#9af5c2" }}>Save</button>
                <button onClick={() => setEditing(false)} className="px-3 py-1 text-xs uppercase tracking-widest rounded" style={{ border: "1px solid rgba(255,255,255,0.14)", color: "rgba(236,243,255,0.5)" }}>Cancel</button>
                {canRemove && (
                  <button onClick={() => { if (confirmDel) { onRemove(team.id); } else { setConfirmDel(true); setTimeout(() => setConfirmDel(false), 4000); } }}
                    className="ml-auto px-3 py-1 text-xs uppercase tracking-widest rounded"
                    style={{ background: confirmDel ? "rgba(255,70,85,0.25)" : "transparent", border: "1px solid rgba(255,70,85,0.5)", color: "#ff8a94" }}>
                    {confirmDel ? "Confirm?" : "Remove"}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="min-w-0">
                <h3 className="font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: team.hue }}>{team.name}</h3>
                <p className="text-xs" style={{ color: "rgba(236,243,255,0.5)" }}>Capt. {team.captain}</p>
              </div>
              {isAdmin && (
                <button onClick={() => setEditing(true)} title="Rename team" className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-xs"
                  style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(236,243,255,0.6)" }}>✎</button>
              )}
            </>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.04)" }}>
            <div className="flex items-center gap-1">
              <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)" }}>Budget</p>
              {isAdmin && !budgetEdit && (
                <button onClick={() => { setBudgetVal(String(team.budget)); setBudgetEdit(true); }} title="Edit budget" className="ml-auto text-[10px] leading-none px-1 py-0.5 rounded" style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.12)", color: "rgba(236,243,255,0.55)" }}>✎</button>
              )}
            </div>
            {isAdmin && budgetEdit ? (
              <div className="flex items-center gap-1 mt-0.5">
                <input value={budgetVal} onChange={(e) => setBudgetVal(e.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") saveBudget(); if (e.key === "Escape") setBudgetEdit(false); }}
                  inputMode="numeric" autoFocus
                  className="w-full px-1.5 py-0.5 rounded text-base font-bold outline-none"
                  style={{ fontFamily: "'IBM Plex Mono',monospace", background: "rgba(10,14,24,0.9)", border: `1px solid ${team.hue}88`, color: "#ecf3ff" }} />
                <button onClick={saveBudget} className="text-[11px] px-1.5 py-1 rounded shrink-0" style={{ background: "rgba(61,220,132,0.2)", border: "1px solid #3ddc8488", color: "#9af5c2" }}>✓</button>
                <button onClick={() => setBudgetEdit(false)} aria-label="Cancel budget edit" className="text-[11px] px-1.5 py-1 rounded shrink-0" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", color: "rgba(236,243,255,0.5)" }}>✕</button>
              </div>
            ) : (
              <p className="text-lg font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ecf3ff" }}>{fmt(team.budget)}</p>
            )}
          </div>
          <div className="px-3 py-2 rounded-lg" style={{ background: "rgba(255,255,255,0.04)" }}>
            <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)" }}>Max bid</p>
            <p className="text-lg font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#5b8dff" }}>{fmt(Math.max(maxAllowedBid(team, players.filter((p) => p.status === "pool")), 0))}</p>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded" style={{ background: team.hue + "14" }}>
            <span style={{ color: team.hue }}>★</span>
            <span className="text-sm font-semibold truncate" style={{ color: "#ecf3ff" }}>{team.captain}</span>
            <span className="ml-auto text-xs uppercase shrink-0" style={{ color: "rgba(236,243,255,0.4)" }}>Captain</span>
          </div>
          {rosterPlayers.map((p) => { const r = rankOf(p.rank); return (
            <div key={p.id} className="flex items-center gap-1.5">
              <button onClick={() => onScout(p.id)} className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded text-left" style={{ background: "rgba(255,255,255,0.04)" }}>
                <RankBadge rank={p.rank} div={p.rankDiv} size="sm" />
                <div className="min-w-0">
                  <p className="text-sm truncate" style={{ color: "#ecf3ff" }}>{p.name}</p>
                  <p className="text-xs truncate" style={{ color: r.c }}>{ROLE_GLYPH[p.role]} {p.role}</p>
                </div>
                <span className="ml-auto text-xs" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.55)" }}>{fmt(p.soldPrice)}</span>
              </button>
              {isAdmin && (
                <button onClick={() => onRemoveFromRoster(team.id, p.id)} title="Remove from roster (returns to pool)"
                  className="shrink-0 w-7 h-7 grid place-items-center rounded-lg text-xs"
                  style={{ background: "rgba(255,70,85,0.1)", border: "1px solid rgba(255,70,85,0.4)", color: "#ff8a94" }}>✕</button>
              )}
            </div>
          ); })}
          {Array.from({ length: emptySlots(team) }).map((_, i) => {
            if (isAdmin && i === 0) {
              return addOpen ? (
                <div key={i} className="flex flex-col gap-1.5 p-2 rounded" style={{ border: `1px solid ${team.hue}55`, background: "rgba(255,255,255,0.03)" }}>
                  <select value={addPid} onChange={(e) => setAddPid(e.target.value)}
                    className="w-full px-2 py-1.5 rounded text-xs outline-none"
                    style={{ background: "rgba(10,14,24,0.9)", border: "1px solid rgba(255,255,255,0.14)", color: "#ecf3ff" }}>
                    <option value="">Select player…</option>
                    {availablePool.map((p) => <option key={p.id} value={p.id}>{p.name} · {ROLE_GLYPH[p.role]} {p.role} · {rankLabel(p.rank, p.rankDiv)}</option>)}
                  </select>
                  <input value={addPrice} onChange={(e) => setAddPrice(e.target.value.replace(/[^0-9]/g, ""))} placeholder="Price label (optional)"
                    inputMode="numeric"
                    className="w-full px-2 py-1.5 rounded text-xs outline-none"
                    style={{ fontFamily: "'IBM Plex Mono',monospace", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.14)", color: "#ecf3ff" }} />
                  <div className="flex gap-2">
                    <button onClick={submitAdd} disabled={!addPid} className="px-3 py-1 text-xs font-bold uppercase tracking-widest rounded disabled:opacity-40" style={{ background: "rgba(61,220,132,0.18)", border: "1px solid #3ddc8488", color: "#9af5c2" }}>Add</button>
                    <button onClick={() => { setAddOpen(false); setAddPid(""); setAddPrice(""); }} className="px-3 py-1 text-xs uppercase tracking-widest rounded" style={{ border: "1px solid rgba(255,255,255,0.14)", color: "rgba(236,243,255,0.5)" }}>Cancel</button>
                  </div>
                </div>
              ) : (
                <button key={i} onClick={() => setAddOpen(true)} className="px-2 py-1.5 rounded text-xs uppercase tracking-widest text-center"
                  style={{ border: `1px dashed ${team.hue}66`, color: team.hue + "cc", background: team.hue + "0d" }}>+ Add player</button>
              );
            }
            return <div key={i} className="px-2 py-1.5 rounded text-xs uppercase tracking-widest text-center" style={{ border: "1px dashed rgba(255,255,255,0.12)", color: "rgba(236,243,255,0.25)" }}>open slot</div>;
          })}
        </div>
        <div className="mt-auto pt-2">
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "rgba(236,243,255,0.4)" }}>{emptySlots(team) === 0 ? "Squad complete" : "Roles still open"}</p>
          <div className="flex flex-wrap gap-1.5">
            {emptySlots(team) === 0 ? <span className="text-xs" style={{ color: "#3ddc84" }}>✓ Full roster locked in</span>
              : rolesNeed.length ? rolesNeed.map((r) => <span key={r} className="px-2 py-0.5 text-xs uppercase tracking-widest rounded" style={{ background: "rgba(255,70,85,0.12)", color: "#ff8a94" }}>{ROLE_GLYPH[r]} {r}</span>)
              : <span className="text-xs" style={{ color: "rgba(236,243,255,0.5)" }}>Core roles covered</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ════════════════ SEAT GATE ═══════════════════════════════════════ */
function RoleGate({ teams, onPick, auth }) {
  const [mode, setMode] = useState("seats"); // seats | commish | captain
  const [seat, setSeat] = useState(null);     // team being unlocked (captain mode)
  const [seatIdx, setSeatIdx] = useState(0);  // its seat index (for the code)
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const loggedIn = !!auth;           // authenticated via Supabase → no passcodes
  const isHost = auth?.role === "host";

  const submit = () => {
    setErr("");
    if (code.trim() === COMMISH_CODE) { onPick("admin"); }
    else { setErr("Incorrect passcode."); setCode(""); }
  };

  // Logged in → seats are LOCKED to their assigned captain (captainUserId).
  // Unowned seats (legacy/guest boards) stay claimable. Legacy → passcode step.
  const openSeat = (t, i) => {
    if (loggedIn) {
      if (t.captainUserId && t.captainUserId !== auth.userId) {
        setErr(`${t.name} is locked to its captain. Enter as a spectator to watch.`); return;
      }
      onPick(t.id); return;
    }
    setSeat(t); setSeatIdx(i); setMode("captain"); setCode(""); setErr("");
  };

  // Host: hosts enter directly; legacy asks for passcode.
  const enterCommish = () => {
    if (isHost) { onPick("admin"); return; }
    if (loggedIn) { setErr("Only the community host can enter here."); return; }
    setMode("commish"); setCode(""); setErr("");
  };

  const submitSeat = () => {
    setErr("");
    if (code.trim() === seatCode(seatIdx)) { onPick(seat.id); }
    else { setErr("Incorrect seat passcode."); setCode(""); }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-14 relative overflow-hidden">
      {/* faint hero art backdrop */}
      <img src={IMG_HERO} alt="" className="absolute pointer-events-none select-none" style={{ right: "-8%", top: "50%", transform: "translateY(-50%)", height: "112%", width: "auto", opacity: 0.16, objectFit: "cover", maskImage: "linear-gradient(90deg, transparent, #000 55%)", WebkitMaskImage: "linear-gradient(90deg, transparent, #000 55%)" }} />
      <div className="absolute inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 70% 50% at 50% 38%, rgba(61,123,255,0.10), transparent 70%)" }} />

      <div className="relative w-full max-w-4xl flex flex-col items-center">
        {/* eyebrow with HUD ticks */}
        <div className="flex items-center gap-3 mb-4">
          <span style={{ width: 22, height: 2, background: "#3d7bff" }} />
          <p className="uppercase text-sm" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", fontWeight: 600, letterSpacing: "0.4em" }}>{(window.__VOLT.communityName || "VOLT Protocol")} — {(window.__VOLT.weekendLabel || "Auction Draft")}</p>
          <span style={{ width: 22, height: 2, background: "#3d7bff" }} />
        </div>

        {/* Tungsten headline, matching the hero */}
        <h1 className="font-bold uppercase text-center" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(3.4rem,9vw,7rem)", lineHeight: 0.82, letterSpacing: "0.04em" }}>
          <span style={{ color: "#f4f8ff" }}>Auction </span><span style={{ color: "#3d7bff" }}>Draft</span>
        </h1>

        {mode === "seats" ? (
          <>
            <p className="mt-4 text-center max-w-md uppercase" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.18em", fontSize: "0.85rem" }}>Claim your seat — everything syncs live to every open session</p>
            <div className="mt-10 grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
              {teams.map((t, i) => {
                return (
                <button key={t.id} onClick={() => openSeat(t, i)} className="seat-card relative p-6 text-left flex items-center gap-4"
                  style={{ "--hue": t.hue, clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))", background: "linear-gradient(160deg, rgba(61,123,255,0.05), rgba(10,15,28,0.55))", border: "1px solid rgba(120,150,220,0.18)", backdropFilter: "blur(8px)" }}>
                  {/* team-color HUD corner bracket */}
                  <span className="absolute left-0 top-0" style={{ width: 12, height: 12, borderLeft: `2px solid ${t.hue}`, borderTop: `2px solid ${t.hue}` }} />
                  {/* seat number tab */}
                  <span className="shrink-0 flex items-center justify-center font-bold" style={{ width: 52, height: 52, fontFamily: "'IBM Plex Mono',monospace", fontSize: "1.05rem", color: t.hue, background: `${t.hue}1a`, border: `1px solid ${t.hue}66`, clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>{String(i + 1).padStart(2, "0")}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "1.35rem", letterSpacing: "0.04em", color: t.hue }}>{t.name}</span>
                    <span className="block text-sm mt-0.5" style={{ color: "rgba(220,230,255,0.55)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.05em" }}>Captain · {t.captain}</span>
                  </span>
                  <span className="seat-go shrink-0 font-bold uppercase text-xs tracking-widest flex items-center gap-1.5" style={{ fontFamily: "'Rajdhani',sans-serif", color: t.hue }}>
                    Claim <span style={{ fontFamily: "'IBM Plex Mono',monospace" }}>→</span>
                  </span>
                </button>
                );
              })}
            </div>
            <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
              <button onClick={() => onPick("spectator")} className="gate-cta px-10 py-3.5 font-bold uppercase tracking-[0.22em] flex items-center gap-3"
                style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "0.95rem", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", background: "rgba(120,160,255,0.08)", border: "1px solid rgba(120,160,255,0.4)", color: "#cfe0ff" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" style={{ flexShrink: 0 }}>
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3" opacity="0.7" />
                  <circle cx="12" cy="12" r="6.5" />
                  <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
                </svg>
                Enter as Player
              </button>
              {(!loggedIn || isHost) && <button onClick={enterCommish} className="gate-cta px-10 py-3.5 font-bold uppercase tracking-[0.22em] flex items-center gap-3"
                style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "0.95rem", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.55)", color: "#aec6ff" }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square" strokeLinejoin="miter" style={{ flexShrink: 0 }}>
                  <path d="M12 2.5l7 3v5.5c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9V5.5z" />
                  <path d="M9.4 11.8l1.9 1.9 3.6-3.9" />
                </svg>
                Enter as host
              </button>}
            </div>
            <p className="mt-4 text-xs text-center max-w-md" style={{ color: "rgba(200,215,255,0.4)" }}>Players can watch the auction, rosters and scouting reports live, but can't place bids.</p>
          </>
        ) : mode === "captain" ? (
          <div className="mt-10 w-full max-w-sm flex flex-col gap-3 p-7 relative" style={{ background: `linear-gradient(160deg, ${seat.hue}1c, rgba(10,15,28,0.6))`, border: `1px solid ${seat.hue}66`, clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))", backdropFilter: "blur(10px)", boxShadow: `0 0 50px ${seat.hue}22` }}>
            <span className="absolute left-0 top-0" style={{ width: 12, height: 12, borderLeft: `2px solid ${seat.hue}`, borderTop: `2px solid ${seat.hue}` }} />
            <p className="uppercase tracking-[0.25em] text-sm font-bold text-center" style={{ fontFamily: "'Rajdhani',sans-serif", color: seat.hue }}>{seat.name}</p>
            <p className="text-xs text-center -mt-1 leading-relaxed" style={{ color: "rgba(220,230,255,0.5)" }}>
              Enter this seat's captain passcode to take control.
            </p>
            <input type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitSeat()}
              placeholder="Passcode" className="px-3 py-2.5 rounded-lg outline-none text-center tracking-widest"
              style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace" }} />
            {err && <p className="text-xs text-center" style={{ color: "#ff6b7d" }}>{err}</p>}
            <button onClick={submitSeat} className="gate-cta py-3 font-bold uppercase tracking-[0.2em]"
              style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))", background: `${seat.hue}28`, border: `1px solid ${seat.hue}`, color: "#eaf1ff" }}>
              Unlock seat
            </button>
            <button onClick={() => { setMode("seats"); setSeat(null); setErr(""); }} className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.45)" }}>← back to seats</button>
          </div>
        ) : (
          <div className="mt-10 w-full max-w-sm flex flex-col gap-3 p-7 relative" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.08), rgba(10,15,28,0.6))", border: "1px solid rgba(61,123,255,0.4)", clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))", backdropFilter: "blur(10px)", boxShadow: "0 0 50px rgba(61,123,255,0.18)" }}>
            <span className="absolute left-0 top-0" style={{ width: 12, height: 12, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
            <p className="uppercase tracking-[0.25em] text-sm font-bold text-center" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#7da6ff" }}>Host Access</p>
            <p className="text-xs text-center -mt-1 leading-relaxed" style={{ color: "rgba(220,230,255,0.5)" }}>
              Enter the host passcode.
            </p>
            <input type="password" autoFocus value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Passcode" className="px-3 py-2.5 rounded-lg outline-none text-center tracking-widest"
              style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace" }} />
            {err && <p className="text-xs text-center" style={{ color: "#ff6b7d" }}>{err}</p>}
            <button onClick={submit} className="gate-cta py-3 font-bold uppercase tracking-[0.2em]"
              style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))", background: "rgba(61,123,255,0.18)", border: "1px solid #3d7bff", color: "#eaf1ff" }}>
              Unlock
            </button>
            <button onClick={() => { setMode("seats"); setErr(""); }} className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.45)" }}>← back to seats</button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ════════════════ COUNTDOWN ═══════════════════════════════════════ */
function useCountdown(target) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const diff = Math.max(target - now, 0);
  return { d: Math.floor(diff / 86400000), h: Math.floor(diff / 3600000) % 24, m: Math.floor(diff / 60000) % 60, s: Math.floor(diff / 1000) % 60, live: diff === 0 };
}

/* ════════════════ WAR ROOM (private captain sandbox) ══════════════ */
const WR_BUDGET = 10000;
const WR_SLOTS = 4;  // captain is the 5th player, so they draft 4
const WR_PLANS = 5;
const emptyLineup = () => Array.from({ length: WR_SLOTS }, () => ({ playerId: "", target: "" }));

function PlayerPicker({ value, players, onChange }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const sel = players.find((p) => p.id === value);
  const list = players.filter((p) => !q || p.name.toLowerCase().includes(q.toLowerCase()) || p.agent.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="relative flex-1 min-w-0">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 px-3 py-2.5 rounded-lg text-left"
        style={{ background: "rgba(255,255,255,0.05)", border: `1px solid ${sel ? rankOf(sel.rank).c + "66" : "rgba(255,255,255,0.12)"}`, color: "#ecf3ff" }}>
        {sel ? (
          <>
            <RankBadge rank={sel.rank} div={sel.rankDiv} size="sm" />
            <span className="font-semibold truncate" style={{ fontFamily: "'Rajdhani',sans-serif" }}>{sel.name}</span>
            <span className="text-xs truncate" style={{ color: rankOf(sel.rank).c }}>{ROLE_GLYPH[sel.role]} {sel.role}</span>
          </>
        ) : <span className="text-sm" style={{ color: "rgba(236,243,255,0.4)" }}>Select a player…</span>}
        <span className="ml-auto text-xs" style={{ color: "rgba(236,243,255,0.4)" }}>▾</span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg overflow-hidden" style={{ background: "#0d1120", border: "1px solid rgba(255,255,255,0.15)", boxShadow: "0 20px 40px rgba(0,0,0,0.6)" }}>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full px-3 py-2 text-sm outline-none" style={{ background: "rgba(255,255,255,0.05)", color: "#ecf3ff", borderBottom: "1px solid rgba(255,255,255,0.1)" }} />
          <div style={{ maxHeight: 220, overflowY: "auto" }}>
            {value && <button onClick={() => { onChange(""); setOpen(false); setQ(""); }} className="w-full text-left px-3 py-2 text-xs uppercase tracking-widest" style={{ color: "#ff8a94" }}>✕ Clear slot</button>}
            {list.map((p) => { const r = rankOf(p.rank); return (
              <button key={p.id} onClick={() => { onChange(p.id); setOpen(false); setQ(""); }} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:opacity-80" style={{ background: p.id === value ? r.c + "1f" : "transparent" }}>
                <RankBadge rank={p.rank} div={p.rankDiv} size="sm" />
                <span className="text-sm truncate" style={{ color: "#ecf3ff" }}>{p.name}</span>
                <span className="text-xs truncate" style={{ color: r.c }}>{rankLabel(p.rank, p.rankDiv)}</span>
                <span className="ml-auto text-xs" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.5)" }}>{fmt(r.bid)}</span>
              </button>
            ); })}
            {list.length === 0 && <p className="px-3 py-3 text-sm" style={{ color: "rgba(236,243,255,0.4)" }}>No matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}


function WarRoom({ teamId, teamHue, players: allPlayers }) {
  // Captains lead teams — they never enter the auction pool, so they can't be
  // planned as picks. Mirrors the draw's `!p.isCaptain` exclusion.
  const players = (allPlayers || []).filter((p) => !p.isCaptain);
  const [plans, setPlans] = useState(() => Array.from({ length: WR_PLANS }, () => emptyLineup()));
  const [active, setActive] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [dirty, setDirty] = useState(false);

  // load this captain's private plans on mount / team change
  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await readWarRoom(teamId);
      if (alive) {
        const draftable = new Set(players.map((p) => p.id));
        if (data?.plans?.length) setPlans(data.plans.map((pl) => {
          const norm = emptyLineup();
          (pl || []).slice(0, WR_SLOTS).forEach((s, i) => {
            const pid = s?.playerId || "";
            // Clear picks that aren't draftable any more (promoted to captain).
            norm[i] = { playerId: pid && draftable.has(pid) ? pid : "", target: s?.target ?? "" };
          });
          return norm;
        }).concat(Array.from({ length: Math.max(0, WR_PLANS - data.plans.length) }, () => emptyLineup())).slice(0, WR_PLANS));
        setLoaded(true);
      }
    })();
    return () => { alive = false; };
  }, [teamId, allPlayers]);

  const lineup = plans[active];
  const setSlot = (i, patch) => {
    setPlans((prev) => prev.map((pl, pi) => pi === active ? pl.map((s, si) => si === i ? { ...s, ...patch } : s) : pl));
    setDirty(true);
  };

  // browser filters + tap-to-fill
  const [wrRank, setWrRank] = useState("All");
  const [wrRole, setWrRole] = useState("All");
  const [wrQuery, setWrQuery] = useState("");
  const tapToFill = (p) => {
    const emptyIdx = lineup.findIndex((s) => !s.playerId);
    if (emptyIdx === -1) return; // all 4 slots full
    setSlot(emptyIdx, { playerId: p.id, target: String(rankOf(p.rank).bid) });
  };
  const wrChip = (active2, hue = "#3d7bff") => ({
    fontFamily: "'Rajdhani',sans-serif", fontWeight: 700,
    background: active2 ? hue + "22" : "rgba(255,255,255,0.04)",
    border: `1px solid ${active2 ? hue : "rgba(120,150,220,0.18)"}`,
    color: active2 ? hue : "rgba(200,215,255,0.55)",
  });

  const projected = lineup.reduce((sum, s) => sum + (s.playerId ? (parseInt(s.target) || 0) : 0), 0);
  const over = projected > WR_BUDGET;
  const pct = Math.min((projected / WR_BUDGET) * 100, 100);
  const filledCount = lineup.filter((s) => s.playerId).length;

  const save = async () => {
    await writeWarRoom(teamId, { plans, savedAt: Date.now() });
    setSavedAt(Date.now()); setDirty(false);
  };
  const clearPlan = () => { setPlans((prev) => prev.map((pl, pi) => pi === active ? emptyLineup() : pl)); setDirty(true); };

  const chosenIds = new Set(lineup.filter((s) => s.playerId).map((s) => s.playerId));

  return (
    <div className="view-in page-wrap py-6">
      <div className="flex items-start justify-between flex-wrap gap-3 mb-1">
        <h2 className="text-3xl font-bold uppercase" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}><span style={{ color: teamHue }}>//</span> War Room</h2>
        <span className="text-xs px-3 py-1 rounded-full inline-flex items-center gap-2" style={{ background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(236,243,255,0.6)" }}>
          <span style={{ color: "#3ddc84" }}>●</span> Private to you
        </span>
      </div>
      <p className="text-sm mb-5" style={{ color: "rgba(236,243,255,0.5)" }}>Brainstorm mock lineups and target bids before the auction. Only you can see these — not other captains, not the host.</p>

      {/* projected spend bar */}
      <div className="p-4 rounded-2xl mb-5" style={{ background: "rgba(255,255,255,0.04)", border: `1px solid ${over ? "#ff4655" : "rgba(255,255,255,0.1)"}`, boxShadow: over ? "0 0 24px rgba(255,70,85,0.3)" : "none", transition: "all 250ms" }}>
        <div className="flex items-end justify-between mb-2 flex-wrap gap-2">
          <div>
            <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.5)" }}>Total projected spend</p>
            <p className="text-4xl font-bold leading-none" style={{ fontFamily: "'IBM Plex Mono',monospace", color: over ? "#ff4655" : "#5b8dff", textShadow: over ? "0 0 18px rgba(255,70,85,0.6)" : "0 0 14px rgba(61,123,255,0.45)" }}>{fmt(projected)}</p>
          </div>
          <div className="text-right">
            <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.5)" }}>Budget</p>
            <p className="text-xl font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ecf3ff" }}>{fmt(WR_BUDGET)}</p>
          </div>
        </div>
        <div className="h-3 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
          <div style={{ width: pct + "%", height: "100%", borderRadius: 999, background: over ? "linear-gradient(90deg,#ff4655,#ff2d55)" : `linear-gradient(90deg, ${teamHue}, #3d7bff)`, boxShadow: over ? "0 0 12px rgba(255,70,85,0.8)" : `0 0 10px ${teamHue}`, transition: "width 300ms" }} />
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs uppercase tracking-widest" style={{ color: over ? "#ff8a94" : "rgba(236,243,255,0.45)" }}>
            {over ? `⚠ Over budget by ${fmt(projected - WR_BUDGET)}` : `${fmt(WR_BUDGET - projected)} remaining · ${filledCount}/${WR_SLOTS} slots`}
          </span>
          {!over && filledCount === WR_SLOTS && <span className="text-xs uppercase tracking-widest" style={{ color: "#3ddc84" }}>✓ Full lineup within budget</span>}
        </div>
      </div>

      {/* plan tabs */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        {plans.map((pl, i) => {
          const used = pl.some((s) => s.playerId);
          const isActive = i === active;
          return (
            <button key={i} onClick={() => setActive(i)} className="px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-widest transition-all"
              style={{ fontFamily: "'Rajdhani',sans-serif", background: isActive ? teamHue + "22" : "rgba(255,255,255,0.04)", border: `1px solid ${isActive ? teamHue : "rgba(255,255,255,0.12)"}`, color: isActive ? teamHue : "rgba(236,243,255,0.55)" }}>
              Plan {String.fromCharCode(65 + i)}{used && <span className="ml-1.5" style={{ color: "#3ddc84" }}>●</span>}
            </button>
          );
        })}
      </div>

      {/* slots */}
      <div className="flex flex-col gap-3">
        {lineup.map((slot, i) => {
          const avail = players.filter((p) => !chosenIds.has(p.id) || p.id === slot.playerId);
          const sel = players.find((p) => p.id === slot.playerId);
          const r = sel ? rankOf(sel.rank) : null;
          return (
            <div key={i} className="flex items-center gap-4 p-3 rounded-xl" style={{ background: "rgba(255,255,255,0.035)", border: `1px solid ${r ? r.c + "44" : "rgba(255,255,255,0.08)"}` }}>
              <span className="w-7 h-7 grid place-items-center rounded-lg text-sm font-bold shrink-0" style={{ background: "rgba(255,255,255,0.06)", color: teamHue, fontFamily: "'Rajdhani',sans-serif" }}>{i + 1}</span>
              <div className="shrink-0" style={{ width: 300 }}>
                <PlayerPicker value={slot.playerId} players={avail} onChange={(id) => { const np = players.find((p) => p.id === id); const minBid = np ? rankOf(np.rank).bid : 0; setSlot(i, { playerId: id, target: id ? String(minBid) : "" }); }} />
              </div>
              {/* slider target bid */}
              <div className="flex-1 min-w-0 flex items-center gap-4" style={{ opacity: slot.playerId ? 1 : 0.35, pointerEvents: slot.playerId ? "auto" : "none" }}>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)" }}>Target bid</span>
                    {sel && <span className="text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.35)" }}>opens {fmt(rankOf(sel.rank).bid)}</span>}
                  </div>
                  <input type="range" min="0" max={WR_BUDGET} step="100" disabled={!slot.playerId}
                    value={parseInt(slot.target) || 0} onChange={(e) => { const minBid = sel ? rankOf(sel.rank).bid : 0; setSlot(i, { target: String(Math.max(minBid, parseInt(e.target.value) || 0)) }); }}
                    className="wr-slider w-full" style={{ "--wr-hue": r ? r.c : teamHue, "--wr-pct": ((parseInt(slot.target) || 0) / WR_BUDGET) * 100 + "%" }} />
                </div>
                <div className="shrink-0 flex items-center gap-1 px-3 py-2 rounded-lg" style={{ width: 130, background: "rgba(255,255,255,0.05)", border: `1px solid ${r ? r.c + "55" : "rgba(255,255,255,0.12)"}` }}>
                  <span style={{ color: "rgba(236,243,255,0.5)", fontFamily: "'IBM Plex Mono',monospace" }}>$</span>
                  <input type="number" min={sel ? rankOf(sel.rank).bid : 0} max={WR_BUDGET} step="100" disabled={!slot.playerId} value={slot.target}
                    onChange={(e) => setSlot(i, { target: e.target.value })}
                    onBlur={(e) => { const minBid = sel ? rankOf(sel.rank).bid : 0; const v = parseInt(e.target.value) || 0; if (slot.playerId && v < minBid) setSlot(i, { target: String(minBid) }); }}
                    placeholder={sel ? String(rankOf(sel.rank).bid) : "0"}
                    className="w-full bg-transparent outline-none text-right font-bold" style={{ color: r ? r.c : "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace" }} />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* actions */}
      <div className="flex items-center gap-3 mt-5 flex-wrap">
        <button onClick={save} className="px-8 py-3 font-bold uppercase tracking-widest transition-all active:scale-95"
          style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(16px 0,100% 0,calc(100% - 16px) 100%,0 100%)", background: `linear-gradient(90deg, ${teamHue}, #3d7bff)`, color: "#06080e", boxShadow: `0 0 24px ${teamHue}66` }}>
          Save Plan {String.fromCharCode(65 + active)}
        </button>
        <button onClick={clearPlan} className="px-5 py-3 text-sm font-bold uppercase tracking-widest rounded-lg" style={{ border: "1px solid rgba(255,70,85,0.4)", color: "#ff8a94" }}>Clear plan</button>
        {dirty ? <span className="text-xs uppercase tracking-widest" style={{ color: "#f5c453" }}>Unsaved changes</span>
          : savedAt ? <span className="text-xs uppercase tracking-widest" style={{ color: "#3ddc84" }}>✓ Saved</span> : null}
      </div>

      {/* ── player browser (filterable, tap to fill next slot) ── */}
      <div className="mt-8 pt-6" style={{ borderTop: "1px solid rgba(61,123,255,0.16)" }}>
        <div className="flex items-center gap-2 mb-3">
          <span style={{ width: 14, height: 2, background: teamHue }} />
          <p className="uppercase text-xs font-bold" style={{ color: teamHue, fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.26em" }}>Operator Database</p>
          <span className="text-xs ml-auto" style={{ color: "rgba(200,215,255,0.4)" }}>Tap a card to fill the next open slot</span>
        </div>

        <div className="flex items-center gap-2 mb-3 p-2" style={{ background: "rgba(61,123,255,0.05)", border: "1px solid rgba(120,150,220,0.18)", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
          <span style={{ color: "rgba(120,150,220,0.5)" }}>⌕</span>
          <input value={wrQuery} onChange={(e) => setWrQuery(e.target.value)} placeholder="Search players or agents…" className="flex-1 bg-transparent outline-none text-sm" style={{ color: "#ecf3ff" }} />
        </div>
        <div className="flex flex-wrap gap-2 mb-2">
          <button onClick={() => setWrRank("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={wrChip(wrRank === "All")}>All ranks</button>
          {RANK_LIST.map((r) => <button key={r} onClick={() => setWrRank(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={wrChip(wrRank === r, RANKS[r].c)}>{r}</button>)}
        </div>
        <div className="flex flex-wrap gap-2 mb-4">
          <button onClick={() => setWrRole("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={wrChip(wrRole === "All")}>All roles</button>
          {ROLES.map((r) => <button key={r} onClick={() => setWrRole(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={wrChip(wrRole === r)}>{ROLE_GLYPH[r]} {r}</button>)}
        </div>

        <div className="wr-grid">
          {players
            .filter((p) => (wrRank === "All" || p.rank === wrRank) && (wrRole === "All" || p.role === wrRole) && (!wrQuery || p.name.toLowerCase().includes(wrQuery.toLowerCase()) || p.agent.toLowerCase().includes(wrQuery.toLowerCase())))
            .map((p) => {
              const r = rankOf(p.rank); const picked = chosenIds.has(p.id); const full = lineup.every((s) => s.playerId);
              const disabled = picked || full;
              return (
                <button key={p.id} onClick={() => tapToFill(p)} disabled={disabled}
                  className="relative text-left p-3 overflow-hidden transition-transform"
                  style={{ background: picked ? "rgba(61,220,132,0.08)" : `linear-gradient(150deg, ${r.c}18, rgba(10,15,28,0.5) 60%)`,
                    border: `1px solid ${picked ? "rgba(61,220,132,0.5)" : r.c + "44"}`,
                    clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))",
                    opacity: disabled && !picked ? 0.4 : 1, cursor: disabled ? "default" : "pointer",
                    transform: disabled ? "none" : undefined }}>
                  <div className="absolute top-0 left-0 right-0" style={{ height: 2, background: `linear-gradient(90deg, ${r.c}, transparent)` }} />
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-base font-bold uppercase leading-none truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{p.name}</p>
                      <p className="text-[11px] uppercase tracking-widest mt-1" style={{ color: r.c }}>{ROLE_GLYPH[p.role]} {p.role}</p>
                    </div>
                    <RankBadge rank={p.rank} div={p.rankDiv} size="sm" />
                  </div>
                  <div className="flex items-center gap-3 mt-2.5" style={{ fontFamily: "'IBM Plex Mono',monospace" }}>
                    <span className="text-xs"><span style={{ color: "#5b8dff" }}>{p.acs}</span><span className="text-[9px] ml-0.5" style={{ color: "rgba(200,215,255,0.4)" }}>ACS</span></span>
                    <span className="text-xs"><span style={{ color: "#3be8d8" }}>{p.kda}</span><span className="text-[9px] ml-0.5" style={{ color: "rgba(200,215,255,0.4)" }}>KDA</span></span>
                    <span className="text-xs"><span style={{ color: "#c08bff" }}>{p.hs}%</span><span className="text-[9px] ml-0.5" style={{ color: "rgba(200,215,255,0.4)" }}>HS</span></span>
                    {!picked && <span className="ml-auto text-xs" style={{ color: "rgba(236,243,255,0.55)" }}>{fmt(r.bid)}</span>}
                  </div>
                  {picked && <span className="absolute bottom-2 right-2.5 text-[10px] uppercase tracking-widest font-bold" style={{ color: "#3ddc84" }}>✓ In plan</span>}
                </button>
              );
            })}
        </div>
      </div>
    </div>
  );
}


/* agent artwork flanking the hero */

/* ════════════════ MAP VETO (host pick/ban tool — local, not synced) ══════ */
const ALL_MAPS = ["Ascent", "Bind", "Breeze", "Corrode", "Fracture", "Haven", "Icebox", "Lotus", "Pearl", "Split", "Summit", "Sunset", "Abyss"];
// Map splash thumbnails. Paste a URL or base64 data URI per map; blanks render a styled placeholder.
// Served from public/img/maps/ — see README. Keeping these out of the bundle
// means the browser fetches them in parallel and caches them separately.
const MAP_IMG = {
  Ascent: "/img/maps/ascent.jpg",
  Bind: "/img/maps/bind.jpg",
  Breeze: "/img/maps/breeze.jpg",
  Corrode: "/img/maps/corrode.jpg",
  Fracture: "/img/maps/fracture.jpg",
  Haven: "/img/maps/haven.jpg",
  Icebox: "/img/maps/icebox.jpg",
  Lotus: "/img/maps/lotus.jpg",
  Pearl: "/img/maps/pearl.jpg",
  Split: "/img/maps/split.jpg",
  Sunset: "/img/maps/sunset.jpg",
  Abyss: "/img/maps/abyss.jpg",
};
// Distinct placeholder tint per map so the grid reads as cards before real art is supplied.
const MAP_TINT = {
  Ascent: "#6b8cff", Bind: "#d9a441", Breeze: "#4fc4d6", Corrode: "#b56ad9",
  Fracture: "#7a8a55", Haven: "#c4773f", Icebox: "#73b4e6", Lotus: "#5fae7a",
  Pearl: "#4f8fd9", Split: "#8a93a8", Summit: "#8fb9c9", Sunset: "#e08a5a", Abyss: "#5566aa",
};

// One card. `state` = "active" | "off" (setup, toggled out) | "banned" | "decider" | "live".
// `stamp` is the small label shown at the bottom (e.g. "BANNED · TEAM" or "★ DECIDER").
/* shared HUD panel — notched clip + corner brackets, matching the Lobby command-center style */
function HudPanel({ children, className = "", accent = "#3d7bff", pad = "px-4 py-3.5", style = {} }) {
  return (
    <div className={`relative ${pad} ${className}`} style={{
      background: "linear-gradient(180deg, rgba(11,16,28,0.82), rgba(8,11,20,0.6))",
      border: `1px solid ${accent}44`,
      clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))",
      backdropFilter: "blur(4px)",
      boxShadow: "0 8px 34px rgba(0,0,0,0.4)",
      ...style,
    }}>
      <span className="absolute left-0 top-0" style={{ width: 14, height: 14, borderLeft: `2px solid ${accent}`, borderTop: `2px solid ${accent}` }} />
      <span className="absolute right-0 bottom-0" style={{ width: 14, height: 14, borderRight: `2px solid ${accent}`, borderBottom: `2px solid ${accent}` }} />
      {children}
    </div>
  );
}

/* small section eyebrow — dot + label + gradient rule, like System Status */
function HudLabel({ children, dot = "#3d7bff" }) {
  return (
    <>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 6, height: 6, background: dot, boxShadow: `0 0 8px ${dot}`, borderRadius: 1 }} />
        <p className="uppercase text-xs" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.28em" }}>{children}</p>
      </div>
      <div className="mb-3" style={{ height: 1, background: "linear-gradient(90deg, rgba(61,123,255,0.5), transparent)" }} />
    </>
  );
}

/* HUD coin — octagonal clip, blue HUD frame, monospace face */
function HudCoin({ coin, flipping }) {
  const lit = !!coin;
  const oct = "polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)";
  return (
    <div className="relative" style={{ width: 108, height: 108 }}>
      <div className="absolute inset-0" style={{
        clipPath: oct,
        background: lit ? "linear-gradient(150deg, rgba(61,123,255,0.35), rgba(8,12,24,0.9))" : "rgba(255,255,255,0.04)",
        border: `1px solid ${lit ? "rgba(61,123,255,0.7)" : "rgba(120,150,220,0.25)"}`,
        boxShadow: lit ? "0 0 30px rgba(61,123,255,0.4), inset 0 0 22px rgba(61,123,255,0.12)" : "none",
        transform: flipping ? "rotateX(180deg)" : "none",
        transition: "transform .09s linear, box-shadow .3s ease",
      }} />
      <div className="absolute inset-0 grid place-items-center">
        <div className="grid place-items-center" style={{
          width: 64, height: 64, clipPath: oct,
          background: lit ? "rgba(61,123,255,0.12)" : "transparent",
          border: `1px solid ${lit ? "rgba(120,160,255,0.4)" : "rgba(120,150,220,0.18)"}`,
        }}>
          <span className="font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: coin ? 13 : 22, letterSpacing: "0.08em", color: lit ? "#cfe0ff" : "rgba(236,243,255,0.3)", textShadow: lit ? "0 0 12px rgba(61,123,255,0.7)" : "none" }}>{coin ? coin : "?"}</span>
        </div>
      </div>
    </div>
  );
}

function MapTile({ m, onClick, state, stamp, stampColor, disabled }) {
  const img = MAP_IMG[m];
  const tint = MAP_TINT[m] || "#5b8dff";
  const dimmed = state === "off" || state === "banned";
  const isDecider = state === "decider";
  return (
    <button onClick={onClick} disabled={disabled}
      className="relative rounded-lg overflow-hidden group text-left"
      style={{
        aspectRatio: "16 / 10",
        border: `1px solid ${isDecider ? "#3ddc84" : state === "banned" ? "rgba(255,70,85,0.4)" : state === "off" ? "rgba(120,150,220,0.15)" : tint + "99"}`,
        boxShadow: isDecider ? "0 0 26px rgba(61,220,132,0.45)" : "none",
        cursor: disabled ? "default" : "pointer",
        transition: "all .18s ease",
      }}>
      {/* art layer (image if supplied, otherwise tinted gradient placeholder).
          Images get a slight scale-up so the source art's soft/blurred baked-in
          edges crop out beyond the card frame. */}
      <div className="absolute inset-0" style={{
        background: img ? `url("${img}") center/cover no-repeat` : `linear-gradient(150deg, ${tint}55, #0a0f1c 75%)`,
        transform: img ? "scale(1.08)" : "none",
        filter: dimmed ? "grayscale(1) brightness(0.4)" : "none",
        transition: "filter .18s ease",
      }} />
      {/* hover accent for clickable cards */}
      {!disabled && <div className="absolute inset-0 opacity-0 group-hover:opacity-100" style={{ background: `linear-gradient(to top, ${tint}22, transparent 60%)`, transition: "opacity .15s" }} />}
      {/* name — centered & enlarged */}
      <span className="absolute inset-0 grid place-items-center text-center px-2 font-bold uppercase pointer-events-none" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(1.5rem,3.2vw,2.4rem)", lineHeight: 1, letterSpacing: "0.06em", color: dimmed ? "rgba(236,243,255,0.5)" : "#f4f8ff", textShadow: "0 2px 14px rgba(0,0,0,0.75)" }}>{m}</span>
      {/* decider checkmark, corner-style like the in-game select */}
      {isDecider && (
        <>
          <span className="absolute top-0 left-0" style={{ width: 0, height: 0, borderTop: "26px solid #3ddc84", borderRight: "26px solid transparent" }} />
          <span className="absolute top-1.5 left-1/2 -translate-x-1/2" style={{ fontSize: 30, color: "#3ddc84", textShadow: "0 0 14px rgba(61,220,132,0.7)" }}>✓</span>
        </>
      )}
      {/* off (toggled out in setup) marker */}
      {state === "off" && <span className="absolute top-1.5 right-2 text-xs font-bold uppercase tracking-widest" style={{ color: "rgba(255,138,148,0.7)" }}>OUT</span>}
      {/* bottom stamp */}
      {stamp && <span className="absolute left-1/2 -translate-x-1/2 bottom-2 text-[10px] font-semibold tracking-widest whitespace-nowrap" style={{ color: stampColor || "rgba(236,243,255,0.6)" }}>{stamp}</span>}
    </button>
  );
}

/* ════════════════ LEADERBOARD (tournament stats, sorted by avg ACS) ══════════ */

// SEASON LEADERBOARD — the league's single source of truth for player points.
// Reads match_results (host's Report Match): +50 win · ACS÷4 · K+⅓A, summed
// across every match of every tournament in the community.
function Leaderboard({ isAdmin }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    async function load() {
      if (!HAS_SUPABASE || !window.__VOLT.communityId) { if (alive) setRows([]); return; }
      try {
        const { data: mrs } = await __sb.from("match_results")
          .select("user_id, points_computed, team_won, stat_payload")
          .eq("community_id", window.__VOLT.communityId);
        const { data: us } = await __sb.from("users").select("id, display_name").eq("community_id", window.__VOLT.communityId);
        const { data: pp } = await __sb.from("player_profiles").select("user_id, rank, role").eq("community_id", window.__VOLT.communityId);
        if (!alive) return;
        const names = {}; (us || []).forEach(u => { names[u.id] = u.display_name; });
        const profs = {}; (pp || []).forEach(p => { profs[p.user_id] = p; });
        const agg = {};
        (mrs || []).forEach(r => {
          const a = (agg[r.user_id] = agg[r.user_id] || { name: names[r.user_id] || "Player", rank: profs[r.user_id]?.rank, role: profs[r.user_id]?.role, pts: 0, m: 0, w: 0, k: 0, as: 0, acsSum: 0 });
          a.pts += Number(r.points_computed || 0); a.m++; if (r.team_won) a.w++;
          const sp = r.stat_payload || {}; a.k += Number(sp.k || 0); a.as += Number(sp.a || 0); a.acsSum += Number(sp.acs || 0);
        });
        setRows(Object.values(agg).map(a => ({ ...a, avgAcs: a.m ? Math.round(a.acsSum / a.m) : 0 })).sort((x, y) => y.pts - x.pts || y.avgAcs - x.avgAcs));
      } catch (e) { console.error("leaderboard", e); if (alive) setRows([]); }
    }
    load();
    const stop = visInterval(load, 15000);
    return () => { alive = false; stop(); };
  }, []);

  return (
    <div className="view-in page-wrap py-8">
      <div className="flex items-center gap-3 mb-1">
        <span style={{ width: 26, height: 3, background: "#3d7bff" }} />
        <span className="uppercase text-xs tracking-[0.3em]" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>Season standings · every match counts</span>
      </div>
      <h1 className="text-5xl font-extrabold uppercase mb-1" style={{ fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.02em" }}>Leader<span style={{ color: "#3d7bff" }}>board</span></h1>
      <p className="text-sm mb-6" style={{ color: "rgba(200,215,255,0.5)" }}>+50 win · ACS÷4 · K+⅓A — summed across all tournaments.{isAdmin ? " Record results via ▦ Report match during the matches phase." : ""}</p>

      {rows === null && <p style={{ color: "rgba(200,215,255,0.5)" }}>Loading…</p>}
      {rows && rows.length === 0 && (
        <div className="px-5 py-4" style={{ background: "rgba(61,123,255,0.05)", border: "1px solid rgba(61,123,255,0.2)", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))", color: "rgba(200,215,255,0.6)", fontFamily: "'Rajdhani',sans-serif" }}>
          No matches recorded this season yet. Points appear the moment the host reports the first match.
        </div>
      )}
      {rows && rows.length > 0 && (
        <div>
          <div className="grid items-center px-4 py-2 text-[11px] uppercase tracking-[0.16em]" style={{ gridTemplateColumns: "44px 1fr 76px 56px 56px 56px 70px 84px", color: "rgba(200,215,255,0.45)", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>
            <span>#</span><span>Player</span><span className="text-right">Matches</span><span className="text-right">W</span><span className="text-right">K</span><span className="text-right">A</span><span className="text-right">Avg ACS</span><span className="text-right">Points</span>
          </div>
          <div className="grid gap-1.5">
            {rows.map((r, i) => {
              const rc = (RANKS[r.rank] || {}).c || "#8d97a8";
              return (
                <div key={i} className="grid items-center px-4 py-3" style={{ gridTemplateColumns: "44px 1fr 76px 56px 56px 56px 70px 84px", background: i === 0 ? "rgba(245,196,83,0.07)" : "rgba(255,255,255,0.025)", border: "1px solid " + (i === 0 ? "rgba(245,196,83,0.35)" : "rgba(120,150,220,0.13)"), clipPath: "polygon(0 0, calc(100% - 12px) 0, 100% 12px, 100% 100%, 12px 100%, 0 calc(100% - 12px))" }}>
                  <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: i === 0 ? "#f5c453" : "#5b8dff" }}>{String(i + 1).padStart(2, "0")}</span>
                  <span>
                    <span className="font-bold uppercase" style={{ fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.03em", fontSize: 15 }}>{r.name}</span>
                    {(r.rank || r.role) && <span className="ml-2 text-[11px] uppercase tracking-[0.1em]" style={{ color: rc, fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>{[r.role, r.rank].filter(Boolean).join(" · ")}</span>}
                  </span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.75)" }}>{r.m}</span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#3ddc84" }}>{r.w}</span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.75)" }}>{r.k}</span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.75)" }}>{r.as}</span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#00e5ff" }}>{r.avgAcs}</span>
                  <span className="text-right" style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: i === 0 ? "#f5c453" : "#ecf3ff", fontSize: 15 }}>{r.pts}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function MapVeto({ teams }) {
  // Two sides for this veto. Default to the first two seeded teams if present.
  const seedA = teams[0] || null, seedB = teams[1] || null;
  const [teamA, setTeamA] = useState(seedA ? seedA.id : "");
  const [teamB, setTeamB] = useState(seedB ? seedB.id : "");
  const [active, setActive] = useState(new Set(ALL_MAPS));    // maps eligible this veto
  const [banned, setBanned] = useState({});                    // mapName -> teamId who banned it
  const [decider, setDecider] = useState(null);                // final map name
  const [sidePick, setSidePick] = useState(null);              // { teamId, side }
  const [coin, setCoin] = useState(null);                      // "HEADS" | "TAILS"
  const [flipping, setFlipping] = useState(false);
  const [coinTeam, setCoinTeam] = useState(null);              // teamId assigned the coin result
  const [turn, setTurn] = useState(null);                      // teamId whose ban turn it is
  const [setup, setSetup] = useState(true);                    // setup vs running
  const [showRules, setShowRules] = useState(false);           // veto rules explainer

  const resolve = (id) => teams.find((t) => t.id === id) || null;
  const A = resolve(teamA), B = resolve(teamB);
  const nameOf = (id) => { const t = resolve(id); return t ? t.name : "—"; };
  const hueOf = (id) => { const t = resolve(id); return t ? t.hue : "#5b8dff"; };
  const other = (id) => (id === teamA ? teamB : teamA);

  const pool = ALL_MAPS.filter((m) => active.has(m));
  const remaining = pool.filter((m) => !banned[m]);

  const toggleActive = (m) => {
    if (!setup) return;
    setActive((prev) => { const n = new Set(prev); n.has(m) ? n.delete(m) : n.add(m); return n; });
  };


  const flip = () => {
    if (flipping) return;
    setFlipping(true); setCoin(null); setCoinTeam(null);
    let n = 0;
    const iv = setInterval(() => {
      setCoin(Math.random() < 0.5 ? "HEADS" : "TAILS"); n++;
      if (n > 12) { clearInterval(iv); setFlipping(false); }
    }, 90);
  };

  const banMap = (m) => {
    if (setup || decider || banned[m] || !turn) return;
    const nextBanned = { ...banned, [m]: turn };
    const left = pool.filter((x) => !nextBanned[x]);
    setBanned(nextBanned);
    if (left.length === 1) {
      // last map standing becomes the decider; the OTHER team (not whoever just banned) picks side
      setDecider(left[0]);
      setSidePick({ teamId: other(turn), side: null });   // sensible default; host can switch
      setTurn(null);
    } else {
      setTurn(other(turn)); // alternate
    }
  };

  const startVeto = () => {
    if (!teamA || !teamB || teamA === teamB || remaining.length < 2 || !turn) return;
    setSetup(false);
  };

  const resetAll = () => {
    setActive(new Set(ALL_MAPS)); setBanned({}); setDecider(null); setSidePick(null);
    setCoin(null); setCoinTeam(null); setFlipping(false); setTurn(null); setSetup(true);
  };

  const teamPill = (id, label) => {
    const sel = coinTeam === id;
    return (
      <button onClick={() => { if (setup && coin) setCoinTeam(id); }} disabled={!coin || !setup}
        className="relative flex-1 px-3 py-2.5 text-left disabled:cursor-default"
        style={{ background: sel ? hueOf(id) + "22" : "rgba(255,255,255,0.03)", border: `1px solid ${sel ? hueOf(id) : "rgba(120,150,220,0.2)"}`, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", boxShadow: sel ? `0 0 18px ${hueOf(id)}33` : "none" }}>
        <p className="text-[10px] uppercase tracking-[0.2em]" style={{ color: "rgba(236,243,255,0.45)", fontFamily: "'Rajdhani',sans-serif" }}>{label}{sel ? " · WON" : ""}</p>
        <p className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: hueOf(id) }}>{nameOf(id) || "—"}</p>
      </button>
    );
  };

  return (
    <div className="view-in page-wrap py-8">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
        <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Host Tool</p>
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
      </div>
      <h2 className="font-bold uppercase mb-1" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.4rem,5vw,3.8rem)", lineHeight: 0.86, letterSpacing: "0.04em", color: "#f4f8ff", textShadow: "0 0 40px rgba(61,123,255,0.22)" }}>Map <span style={{ color: "#3d7bff" }}>Veto</span></h2>
      <div className="flex items-center gap-3 mb-6 flex-wrap">
        <p className="text-sm" style={{ color: "rgba(200,215,255,0.5)", margin: 0 }}>Flip the coin, assign who bans first, then tap maps to ban them down to a decider. Nothing is saved — hit Reset to run the next one.</p>
        <button onClick={() => setShowRules(true)} title="How the veto works"
          className="uppercase shrink-0" style={{ fontSize: 10.5, letterSpacing: "0.14em", fontWeight: 700, color: "#7da6ff", border: "1px solid rgba(61,123,255,0.4)", background: "rgba(61,123,255,0.08)", padding: "5px 11px", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}>
          ◈ Veto rules
        </button>
      </div>

      {showRules && (
        <VoltOverlay onClose={() => setShowRules(false)} zIndex={150}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "88vh", overflowY: "auto", padding: "24px 26px 22px",
            background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)",
            clipPath: SHELL_NOTCH(16), fontFamily: "'Rajdhani',sans-serif" }}>
            <div className="flex items-center justify-between gap-3">
              <span style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// How the veto works</span>
              <button onClick={() => setShowRules(false)} style={{ background: "none", border: "1px solid rgba(120,150,220,0.3)", color: "rgba(200,215,255,0.6)", padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
            </div>

            {[
              ["1 · Coin toss", <>Both captains call it. The winner gets <b style={{ color: "#ecf3ff" }}>one choice</b> — and the loser automatically gets the other.</>],
              ["2 · The choice", <>
                <b style={{ color: "#f5c453" }}>Map pick</b> — you ban <b style={{ color: "#ecf3ff" }}>second</b>, and you choose the map that gets played from the final two.<br />
                <b style={{ color: "#f5c453" }}>Side pick</b> — you choose <b style={{ color: "#ecf3ff" }}>Attack or Defence</b> on whatever map ends up being played.
              </>],
              ["3 · Banning", <>Teams take turns removing maps, one at a time, until the decider is settled. Whoever bans first removes one more map than their opponent — that's the cost of going first.</>],
              ["4 · The decider", <>The map that survives is played. The team holding <b style={{ color: "#f5c453" }}>side pick</b> then calls Attack or Defence; the other team takes the opposite side.</>],
            ].map(([title, body], i) => (
              <div key={i} style={{ marginTop: 16 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#7da6ff", marginBottom: 5 }}>{title}</div>
                <p style={{ fontSize: 14, lineHeight: 1.65, color: "rgba(214,226,255,0.82)", margin: 0 }}>{body}</p>
              </div>
            ))}

            <div style={{ marginTop: 18, padding: "14px 16px", background: "rgba(10,16,30,0.6)", border: "1px solid rgba(61,123,255,0.22)", clipPath: SHELL_NOTCH(9) }}>
              <div style={{ fontSize: 11, letterSpacing: "0.16em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 7 }}>In short</div>
              <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(200,215,255,0.7)", margin: 0 }}>
                One team decides <b style={{ color: "#ecf3ff" }}>where</b> you play, the other decides <b style={{ color: "#ecf3ff" }}>which side</b> you start on. The toss just decides who gets which.
              </p>
            </div>
          </div>
        </VoltOverlay>
      )}

      {/* ─── SETUP ─── */}
      {setup && (
        <div className="flex flex-col gap-4">
          {/* team selectors */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[["Combatant A", teamA, setTeamA, teamB], ["Combatant B", teamB, setTeamB, teamA]].map(([label, val, setVal, exclude]) => (
              <HudPanel key={label} accent={val ? hueOf(val) : "#3d7bff"}>
                <HudLabel dot={val ? hueOf(val) : "#3d7bff"}>{label}</HudLabel>
                <select value={val} onChange={(e) => setVal(e.target.value)}
                  className="w-full px-3 py-2 text-sm outline-none uppercase font-semibold"
                  style={{ fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.06em", background: "rgba(7,12,22,0.9)", border: "1px solid rgba(61,123,255,0.3)", color: val ? hueOf(val) : "#ecf3ff", clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px))" }}>
                  <option value="">Select team…</option>
                  {teams.filter((t) => t.id !== exclude).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </HudPanel>
            ))}
          </div>

          {/* coin flip */}
          <HudPanel pad="px-5 py-5">
            <HudLabel dot="#3ddc84">Coin Toss</HudLabel>
            <div className="flex flex-col items-center gap-3">
              <HudCoin coin={coin} flipping={flipping} />
              <button onClick={flip} disabled={flipping} className="ea-btn relative" style={{ display: "inline-flex", alignItems: "center", gap: 12, padding: "11px 30px", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: "0.85rem", letterSpacing: "0.28em", textTransform: "uppercase", color: "#cfe0ff", background: "linear-gradient(180deg, rgba(13,22,42,0.55), rgba(7,13,24,0.45))", border: "1px solid rgba(61,123,255,0.5)", clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 12px), calc(100% - 12px) 100%, 0 100%)", opacity: flipping ? 0.5 : 1 }}>
                <span className="absolute left-0 top-0" style={{ width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                <span className="absolute right-0 top-0" style={{ width: 10, height: 10, borderRight: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                {flipping ? "Flipping…" : coin ? "Flip again" : "Flip coin"}
              </button>
              {coin && !flipping && <p className="text-xs text-center" style={{ color: "rgba(200,215,255,0.5)" }}>Tap the team that won the flip, then choose who bans first.</p>}
              {coin && !flipping && (
                <div className="w-full flex gap-3 mt-1">{teamPill(teamA, "Side A")}{teamPill(teamB, "Side B")}</div>
              )}
            </div>
          </HudPanel>

          {/* who bans first */}
          {teamA && teamB && teamA !== teamB && (
            <HudPanel>
              <HudLabel>First Ban</HudLabel>
              <div className="flex gap-3">
                {[teamA, teamB].map((id) => (
                  <button key={id} onClick={() => setTurn(id)} className="relative flex-1 px-3 py-2.5 font-bold uppercase text-sm"
                    style={{ fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.04em", background: turn === id ? hueOf(id) + "22" : "rgba(255,255,255,0.03)", border: `1px solid ${turn === id ? hueOf(id) : "rgba(120,150,220,0.2)"}`, color: hueOf(id), clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", boxShadow: turn === id ? `0 0 18px ${hueOf(id)}33` : "none" }}>
                    {nameOf(id)} bans 1st
                  </button>
                ))}
              </div>
            </HudPanel>
          )}

          {/* map pool toggles */}
          <div>
            <HudLabel>Map Pool · {remaining.length} active — tap to toggle out</HudLabel>
            <div className="grid grid-cols-4 gap-3">
              {ALL_MAPS.map((m) => (
                <MapTile key={m} m={m} onClick={() => toggleActive(m)} state={active.has(m) ? "active" : "off"} />
              ))}
            </div>
          </div>

          <button onClick={startVeto} disabled={!teamA || !teamB || teamA === teamB || remaining.length < 2 || !turn}
            className="ea-btn relative self-start" style={{ display: "inline-flex", alignItems: "center", gap: 14, padding: "15px 38px", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: "0.9rem", letterSpacing: "0.3em", textTransform: "uppercase", color: "#9af5c2", background: "linear-gradient(180deg, rgba(13,32,24,0.55), rgba(7,18,14,0.45))", border: "1px solid rgba(61,220,132,0.5)", clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%)", opacity: (!teamA || !teamB || teamA === teamB || remaining.length < 2 || !turn) ? 0.4 : 1 }}>
            <span className="absolute left-0 top-0" style={{ width: 11, height: 11, borderLeft: "2px solid #3ddc84", borderTop: "2px solid #3ddc84" }} />
            <span className="absolute left-0 bottom-0" style={{ width: 11, height: 11, borderLeft: "2px solid #3ddc84", borderBottom: "2px solid #3ddc84" }} />
            Start veto <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 400 }}>→</span>
          </button>
        </div>
      )}

      {/* ─── RUNNING ─── */}
      {!setup && (
        <div className="flex flex-col gap-4">
          {/* status banner */}
          <HudPanel className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5" style={{ background: hueOf(teamA), boxShadow: `0 0 8px ${hueOf(teamA)}`, borderRadius: 1 }} />
              <span className="font-bold uppercase" style={{ fontFamily: "'Rajdhani',sans-serif", color: hueOf(teamA) }}>{nameOf(teamA)}</span>
              <span className="text-xs mx-1" style={{ color: "rgba(200,215,255,0.4)", fontFamily: "'IBM Plex Mono',monospace" }}>VS</span>
              <span className="w-2.5 h-2.5" style={{ background: hueOf(teamB), boxShadow: `0 0 8px ${hueOf(teamB)}`, borderRadius: 1 }} />
              <span className="font-bold uppercase" style={{ fontFamily: "'Rajdhani',sans-serif", color: hueOf(teamB) }}>{nameOf(teamB)}</span>
            </div>
            {decider ? (
              <span className="flex items-center gap-1.5 text-sm font-bold uppercase tracking-widest" style={{ color: "#3ddc84" }}><span className="cd-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#3ddc84", color: "#3ddc84" }} />Decider locked</span>
            ) : turn ? (
              <span className="relative text-sm font-bold uppercase tracking-widest px-3 py-1" style={{ background: hueOf(turn) + "22", color: hueOf(turn), clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))" }}>{nameOf(turn)} bans next</span>
            ) : null}
          </HudPanel>

          {/* maps grid */}
          <div className="grid grid-cols-4 gap-3">
            {pool.map((m) => {
              const by = banned[m];
              const isDecider = decider === m;
              const state = isDecider ? "decider" : by ? "banned" : "live";
              return (
                <MapTile key={m} m={m} onClick={() => banMap(m)} disabled={!!by || !!decider || !turn} state={state}
                  stamp={by ? `BANNED · ${nameOf(by)}` : isDecider ? "★ DECIDER" : null}
                  stampColor={by ? hueOf(by) : "#3ddc84"} />
              );
            })}
          </div>

          {/* side pick */}
          {decider && sidePick && (
            <HudPanel pad="px-5 py-5" accent="#3ddc84">
              <HudLabel dot="#3ddc84">Side Selection</HudLabel>
              <p className="text-sm mb-3" style={{ color: "rgba(200,215,255,0.6)" }}>
                Decider is <span className="font-bold" style={{ color: "#9af5c2" }}>{decider}</span>. <span className="font-bold uppercase" style={{ color: hueOf(sidePick.teamId), fontFamily: "'Rajdhani',sans-serif" }}>{nameOf(sidePick.teamId)}</span> picks side:
                {!sidePick.side && (
                  <button onClick={() => setSidePick({ teamId: other(sidePick.teamId), side: null })}
                    className="ml-2 uppercase" style={{ fontSize: 10.5, letterSpacing: "0.12em", fontWeight: 700, color: "rgba(200,215,255,0.55)", border: "1px solid rgba(120,150,220,0.3)", padding: "3px 8px", background: "transparent", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>
                    ⇄ Switch team
                  </button>
                )}
              </p>
              <div className="flex gap-3">
                {["ATTACK", "DEFENSE"].map((s) => {
                  const on = sidePick.side === s;
                  const c = s === "ATTACK" ? "#ff4655" : "#3d7bff";
                  return (
                    <button key={s} onClick={() => setSidePick((p) => ({ ...p, side: s }))} className="relative flex-1 px-4 py-3 font-bold uppercase tracking-widest text-sm"
                      style={{ fontFamily: "'Rajdhani',sans-serif", background: on ? c + "26" : "rgba(255,255,255,0.03)", border: `1px solid ${on ? c : "rgba(120,150,220,0.2)"}`, color: on ? (s === "ATTACK" ? "#ff8a94" : "#aec6ff") : "rgba(200,215,255,0.55)", clipPath: "polygon(0 0, calc(100% - 11px) 0, 100% 11px, 100% 100%, 11px 100%, 0 calc(100% - 11px))", boxShadow: on ? `0 0 20px ${c}33` : "none" }}>{s}</button>
                  );
                })}
              </div>
              {sidePick.side && (
                <div className="relative mt-4 text-center px-4 py-5" style={{ background: "linear-gradient(180deg, rgba(13,32,24,0.6), rgba(7,18,14,0.4))", border: "1px solid rgba(61,220,132,0.4)", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))" }}>
                  <span className="absolute left-0 top-0" style={{ width: 14, height: 14, borderLeft: "2px solid #3ddc84", borderTop: "2px solid #3ddc84" }} />
                  <span className="absolute right-0 bottom-0" style={{ width: 14, height: 14, borderRight: "2px solid #3ddc84", borderBottom: "2px solid #3ddc84" }} />
                  <p className="text-xs uppercase tracking-[0.3em] mb-1" style={{ color: "rgba(154,245,194,0.7)", fontFamily: "'Rajdhani',sans-serif" }}>Locked In</p>
                  <p className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "2.1rem", lineHeight: 1, letterSpacing: "0.03em", color: "#f4f8ff", textShadow: "0 0 24px rgba(61,220,132,0.4)" }}>{decider}</p>
                  <p className="text-sm mt-2" style={{ color: "rgba(200,215,255,0.65)" }}><span style={{ color: hueOf(sidePick.teamId), fontWeight: 700 }}>{nameOf(sidePick.teamId)}</span> starts <span style={{ color: sidePick.side === "ATTACK" ? "#ff8a94" : "#aec6ff", fontWeight: 700 }}>{sidePick.side}</span> · <span style={{ color: hueOf(other(sidePick.teamId)), fontWeight: 700 }}>{nameOf(other(sidePick.teamId))}</span> takes the other side</p>
                </div>
              )}
            </HudPanel>
          )}

          <button onClick={resetAll} className="relative self-start px-7 py-3 text-sm font-bold uppercase tracking-widest" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ff8a94", background: "linear-gradient(180deg, rgba(32,13,16,0.55), rgba(18,7,9,0.45))", border: "1px solid rgba(255,70,85,0.45)", clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%)" }}>
            <span className="absolute left-0 top-0" style={{ width: 10, height: 10, borderLeft: "2px solid #ff4655", borderTop: "2px solid #ff4655" }} />
            <span className="absolute left-0 bottom-0" style={{ width: 10, height: 10, borderLeft: "2px solid #ff4655", borderBottom: "2px solid #ff4655" }} />
            ↺ Reset veto
          </button>
        </div>
      )}
    </div>
  );
}

/* ════════════════ NAV ═════════════════════════════════════════════ */
// Plain names in the nav — it's a signpost you scan in half a second, so it has
// to say what's behind it. The pages keep their own flavour in their headings.
const NAV = [
  { id: "lobby", label: "Home", glyph: "⌂" },
  { id: "scout", label: "Player Pool", glyph: "⊞" },
  { id: "block", label: "Live Auction", glyph: "⟁" },
  { id: "reserve", label: "Reserve Pool", glyph: "⊕" },
  { id: "locker", label: "Rosters", glyph: "▦" },
  { id: "warroom", label: "Mock Draft", glyph: "✦" },
];
// grouped under the "Tournament" dropdown to keep the nav from overflowing
const TOURNEY_NAV = [
  { id: "bracket", label: "Fixtures", glyph: "◈" },
  { id: "leaderboard", label: "Leaderboard", glyph: "≣" },
  { id: "veto", label: "Map Veto", glyph: "⊘", adminOnly: true },
];

/* ════════════════════════════════════════════════════════════════════
   AUDIO ENGINE — synthesized cyberpunk SFX + musical ambient bed
   Self-contained Web Audio. No files. Lazily inits on first user gesture.
   ════════════════════════════════════════════════════════════════════ */
const SndFX = (() => {
  let ctx = null, master = null, ambGain = null, ambNodes = [], started = false, enabled = true;
  const now = () => ctx.currentTime;

  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.0;
    master.connect(ctx.destination);
    master.gain.setValueAtTime(0.0001, now());
    master.gain.exponentialRampToValueAtTime(0.9, now() + 0.6);
    return ctx;
  }

  // a short tone with an envelope
  function blip({ type = "square", f0 = 440, f1 = null, dur = 0.08, vol = 0.18, attack = 0.004, dest = null, detune = 0 } = {}) {
    if (!ctx || !enabled) return;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f0, now());
    if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now() + dur);
    g.gain.setValueAtTime(0.0001, now());
    g.gain.exponentialRampToValueAtTime(vol, now() + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, now() + dur);
    o.connect(g); g.connect(dest || master);
    o.start(); o.stop(now() + dur + 0.02);
  }

  // filtered noise burst — for electricity zaps / hammer crack
  function noise({ dur = 0.12, vol = 0.2, type = "highpass", freq = 1800, q = 0.7, sweepTo = null, dest = null } = {}) {
    if (!ctx || !enabled) return;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filt = ctx.createBiquadFilter(); filt.type = type; filt.frequency.value = freq; filt.Q.value = q;
    if (sweepTo) filt.frequency.exponentialRampToValueAtTime(Math.max(40, sweepTo), now() + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, now());
    g.gain.exponentialRampToValueAtTime(0.0001, now() + dur);
    src.connect(filt); filt.connect(g); g.connect(dest || master);
    src.start(); src.stop(now() + dur + 0.02);
  }

  // ── musical cyberpunk ambient: warm minor pad + pulsing sub-bass + sparse pentatonic arp ──
  function startAmbient() {
    if (!ctx || ambNodes.length) return;
    ambGain = ctx.createGain(); ambGain.gain.value = 0.0001;
    ambGain.connect(master);

    // lush space: feedback delay (cinematic tail) — kept modest so it doesn't build into a wash
    const delay = ctx.createDelay(); delay.delayTime.value = 0.5;
    const fb = ctx.createGain(); fb.gain.value = 0.25;
    const wet = ctx.createGain(); wet.gain.value = 0.32;
    delay.connect(fb); fb.connect(delay); delay.connect(wet); wet.connect(ambGain);

    // master tone filter the whole bed runs through (warm, rounded)
    const toneFilt = ctx.createBiquadFilter(); toneFilt.type = "lowpass"; toneFilt.frequency.value = 1400; toneFilt.Q.value = 0.5;
    toneFilt.connect(ambGain); toneFilt.connect(delay);

    ambGain.gain.exponentialRampToValueAtTime(0.04, now() + 4);
    ambNodes = [delay, fb, wet, toneFilt, ambGain];

    // ── cinematic chord progression (emotional minor-key loop): Am · F · C · G ──
    // each entry: root sub freq + a warm triad of frequencies (close voicing)
    const PROG = [
      { sub: 55.00, notes: [220.00, 261.63, 329.63] }, // Am  (A C E)
      { sub: 43.65, notes: [174.61, 220.00, 261.63] }, // F   (F A C)
      { sub: 65.41, notes: [196.00, 261.63, 329.63] }, // C   (G C E) — C add over G-ish
      { sub: 49.00, notes: [196.00, 246.94, 293.66] }, // G   (G B D)
    ];
    // a gentle melody that sits over each chord (one sustained note per chord, top-voice)
    const MELODY = [659.25, 523.25, 587.33, 493.88]; // E5 C5 D5 B4

    // play ONE chord: a slow swell in, hold, swell out — the Zimmer "breath"
    function playChord(idx, dur) {
      if (!ctx || !enabled || !ambNodes.length) return;
      const c = PROG[idx % PROG.length];
      const t0 = now();
      const swellIn = dur * 0.4, swellOut = dur * 0.45;

      // bass — soft sine, gentle (raised so it's a warm note, not a sub-rumble)
      const subO = ctx.createOscillator(); subO.type = "sine"; subO.frequency.value = c.sub * 2;
      const subG = ctx.createGain(); subG.gain.setValueAtTime(0.0001, t0);
      subG.gain.exponentialRampToValueAtTime(0.05, t0 + swellIn);
      subG.gain.setValueAtTime(0.05, t0 + dur - swellOut);
      subG.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      subO.connect(subG); subG.connect(ambGain); subO.start(t0); subO.stop(t0 + dur + 0.1);

      // triad pad — detuned triangle pairs per note, swelling
      const oscs = [];
      c.notes.forEach((f, i) => {
        const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0);
        const peak = 0.028 - i * 0.004; // top notes slightly softer
        g.gain.exponentialRampToValueAtTime(peak, t0 + swellIn);
        g.gain.setValueAtTime(peak, t0 + dur - swellOut);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(toneFilt);
        [-5, 6].forEach((det) => {
          const o = ctx.createOscillator(); o.type = "triangle"; o.frequency.value = f; o.detune.value = det;
          o.connect(g); o.start(t0); o.stop(t0 + dur + 0.1); oscs.push(o);
        });
      });

      // melody note — a soft sine bell that fades in late and rings, through the delay for echoes
      const mF = MELODY[idx % MELODY.length];
      const mDelay = dur * 0.25;
      const mo = ctx.createOscillator(); mo.type = "sine"; mo.frequency.value = mF;
      const mg = ctx.createGain(); mg.gain.setValueAtTime(0.0001, t0 + mDelay);
      mg.gain.exponentialRampToValueAtTime(0.05, t0 + mDelay + 0.5);
      mg.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      mo.connect(mg); mg.connect(toneFilt); mg.connect(delay);
      mo.start(t0 + mDelay); mo.stop(t0 + dur + 0.1);
    }

    // ── phrase: play the 4-chord progression, then PAUSE in silence, then return ──
    let chordIdx = 0;
    const CHORD_DUR = 7.5;   // seconds per chord (slow, cinematic)
    const PHRASE_LEN = 4;    // chords per phrase (one full progression)
    const PAUSE_MS = 22000;  // ~22s of clear silence between phrases

    function runPhrase() {
      if (!ctx || !enabled || !ambNodes.length) return;
      for (let i = 0; i < PHRASE_LEN; i++) {
        ambTimer = setTimeout(() => playChord(chordIdx + i, CHORD_DUR), i * CHORD_DUR * 1000);
      }
      chordIdx += PHRASE_LEN;
      // schedule next phrase after this one finishes + a silent pause
      const total = PHRASE_LEN * CHORD_DUR * 1000 + PAUSE_MS;
      ambTimer = setTimeout(runPhrase, total);
    }
    // first phrase starts shortly after boot
    ambTimer = setTimeout(runPhrase, 1200);
  }
  let ambTimer = null;

  // ── named SFX
  const sfx = {
    hover() { blip({ type: "sine", f0: 880, f1: 1320, dur: 0.05, vol: 0.05 }); },
    click() { blip({ type: "sine", f0: 520, f1: 660, dur: 0.085, vol: 0.07, attack: 0.012 }); blip({ type: "sine", f0: 1040, dur: 0.05, vol: 0.018, attack: 0.012 }); },
    nav() { blip({ type: "triangle", f0: 480, f1: 760, dur: 0.1, vol: 0.085, attack: 0.01 }); blip({ type: "sine", f0: 960, dur: 0.06, vol: 0.025, attack: 0.01 }); },
    enter() {
      blip({ type: "sawtooth", f0: 180, f1: 720, dur: 0.32, vol: 0.16 });
      blip({ type: "square", f0: 360, f1: 1440, dur: 0.34, vol: 0.08 });
      noise({ dur: 0.4, vol: 0.12, type: "bandpass", freq: 600, q: 1.2, sweepTo: 5000 });
    },
    transition() { blip({ type: "sine", f0: 380, f1: 620, dur: 0.16, vol: 0.045, attack: 0.02 }); },
    spin() { // subtle rising underlay — the per-card ticks carry the motion
      if (!ctx || !enabled) return;
      const o = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
      o.type = "sawtooth"; f.type = "bandpass"; f.Q.value = 7;
      o.frequency.setValueAtTime(90, now()); o.frequency.exponentialRampToValueAtTime(560, now() + 2.4);
      f.frequency.setValueAtTime(300, now()); f.frequency.exponentialRampToValueAtTime(2200, now() + 2.4);
      g.gain.setValueAtTime(0.0001, now()); g.gain.exponentialRampToValueAtTime(0.05, now() + 0.3);
      g.gain.exponentialRampToValueAtTime(0.0001, now() + 2.6);
      o.connect(f); f.connect(g); g.connect(master); o.start(); o.stop(now() + 2.7);
    },
    tick(p = 0) { // each card pass — soft rounded tick that rises & warms as it slows (kept exciting, easy on ears)
      const f = 600 + p * 1300;
      blip({ type: "triangle", f0: f, f1: f * 0.78, dur: 0.03 + p * 0.035, vol: 0.045 + p * 0.06, attack: 0.006 });
      // gentle low body so it feels tactile without the sharp noise crack
      blip({ type: "sine", f0: f * 0.5, dur: 0.04 + p * 0.02, vol: 0.025 + p * 0.03, attack: 0.005 });
      // soft shimmer on the final slow ticks for the climactic feel
      if (p > 0.8) blip({ type: "sine", f0: f * 2, dur: 0.05, vol: 0.035, attack: 0.008 });
    },
    reveal() { // soft celebratory "confetti" — warm rising chime + scattered gentle twinkles
      if (!ctx || !enabled) return;
      // a warm major chord bloom underneath (C major: C E G C) — soft sines, gentle swell
      [261.63, 329.63, 392.0, 523.25].forEach((f, i) =>
        setTimeout(() => blip({ type: "sine", f0: f, dur: 0.7, vol: 0.07, attack: 0.04 }), i * 70)
      );
      // rising sparkle run up a pleasant pentatonic — soft triangles, rounded
      const upRun = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5];
      upRun.forEach((f, i) =>
        setTimeout(() => blip({ type: "triangle", f0: f, dur: 0.28, vol: 0.06, attack: 0.015 }), 120 + i * 60)
      );
      // scattered confetti twinkles — many tiny soft bells at random times/pitches, fading out
      const twinkle = [659.25, 783.99, 880.0, 987.77, 1046.5, 1318.5, 1567.98];
      for (let i = 0; i < 14; i++) {
        const f = twinkle[Math.floor(Math.random() * twinkle.length)];
        const t = 150 + Math.random() * 1100;
        const v = 0.018 + Math.random() * 0.022;
        setTimeout(() => blip({ type: "sine", f0: f, dur: 0.2 + Math.random() * 0.2, vol: v, attack: 0.012 }), t);
      }
      // very soft airy shimmer (gentle, no sharp sweep)
      noise({ dur: 0.7, vol: 0.025, type: "bandpass", freq: 6000, q: 1.2 });
    },
    bid() { blip({ type: "square", f0: 740, f1: 1180, dur: 0.07, vol: 0.14 }); blip({ type: "sine", f0: 1480, dur: 0.05, vol: 0.05 }); },
    sold() { // hammer crack + triumphant chord
      noise({ dur: 0.16, vol: 0.3, type: "lowpass", freq: 2200, sweepTo: 400 });
      blip({ type: "sawtooth", f0: 90, f1: 60, dur: 0.3, vol: 0.2 });
      [392, 494, 587, 784].forEach((f) => blip({ type: "triangle", f0: f, dur: 0.5, vol: 0.09 }));
    },
    error() { blip({ type: "sawtooth", f0: 200, f1: 120, dur: 0.2, vol: 0.16 }); },
  };

  return {
    boot() {
      if (started) return;
      const c = ensure(); if (!c) return;
      if (c.state === "suspended") c.resume();
      started = true;
      startAmbient();
    },
    play(name, ...args) {
      if (!started || !enabled) return;
      const fn = sfx[name] || (() => {});
      if (ctx && ctx.state === "suspended") {
        // context not running yet (first gesture) — wait for resume, then play so the sound isn't lost
        const p = ctx.resume();
        if (p && p.then) p.then(() => { if (enabled) fn(...args); }).catch(() => {});
        else fn(...args);
        return;
      }
      fn(...args);
    },
    setEnabled(on) {
      enabled = on;
      if (!ctx) return;
      master.gain.cancelScheduledValues(now());
      master.gain.setTargetAtTime(on ? 0.9 : 0.0001, now(), 0.2);
    },
    isEnabled() { return enabled; },
    isStarted() { return started; },
  };
})();

/* ════════════════════════════════════════════════════════════════════
   MAIN
   ════════════════════════════════════════════════════════════════════ */
function DraftApp({ auth, browse, chrome, initialView }) {
  const [state, setState] = useState(null);
  // Auto-resolve in-app identity from the logged-in role:
  //  host  → "admin" (Host)   ·   others start unpicked (choose seat/spectator)
  // A moderator lands in the same "admin" identity as the host — they run the
  // same operational screens. The narrower powers are gated separately below by
  // isTrueHost, not by hiding whole surfaces from them.
  const [identity, setIdentity] = useState((auth?.role === "host" || auth?.role === "moderator") ? "admin" : null);
  const [view, setView] = useState(initialView || "lobby");
  const [tourneyOpen, setTourneyOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false); // side nav
  const [isDesk, setIsDesk] = useState(typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(min-width: 768px)").matches : true);
  // Expanded by default: the labels are the whole point of the rail, and a
  // first-time host shouldn't have to decode nine glyphs. A saved "0" still
  // wins — collapsing is a deliberate choice, an absent key is not.
  const [railWide, setRailWide] = useState(() => {
    try { const v = localStorage.getItem("volt_rail_wide"); return v === null ? true : v === "1"; }
    catch { return true; }
  });
  useEffect(() => { try { localStorage.setItem("volt_rail_wide", railWide ? "1" : "0"); } catch {} }, [railWide]);
  const [railTip, setRailTip] = useState(null); // { label, y } — collapsed-rail hover tooltip
  const [nowTick, setNowTick] = useState(Date.now()); // draft countdown tick
  useEffect(() => { if (!chrome?.draftAt) return; const t = setInterval(() => setNowTick(Date.now()), 30000); return () => clearInterval(t); }, [chrome?.draftAt]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(min-width: 768px)");
    const on = (e) => setIsDesk(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  useEffect(() => { if (!tourneyOpen) return; const close = () => setTourneyOpen(false); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, [tourneyOpen]);
  useEffect(() => { if (!mobileNavOpen) return; const close = () => setMobileNavOpen(false); window.addEventListener("click", close); return () => window.removeEventListener("click", close); }, [mobileNavOpen]);
  const [liveCount, setLiveCount] = useState(1);
  const sessionIdRef = useRef(null);
  if (!sessionIdRef.current) sessionIdRef.current = Math.random().toString(36).slice(2, 12);
  useEffect(() => {
    const sid = sessionIdRef.current;
    const KEY = "volt-presence";   // single shared row: { sessionId: lastSeenTs, ... }
    const FRESH_MS = 14000;        // a session is "live" if seen within 14s
    const BEAT_MS = 5000;          // heartbeat + recount every 5s
    let cancelled = false;

    const tick = async () => {
      try {
        const r = await window.storage.get(KEY, true);
        let map = {};
        if (r) { try { map = JSON.parse(r.value) || {}; } catch {} }
        const now = Date.now();
        map[sid] = now;                                   // stamp myself
        for (const k of Object.keys(map)) if (now - map[k] >= FRESH_MS) delete map[k]; // prune stale
        await window.storage.set(KEY, JSON.stringify(map), true);
        if (!cancelled) setLiveCount(Math.max(1, Object.keys(map).length));
      } catch {}
    };

    tick();
    // Only heartbeat while the tab is visible. A hidden tab that stops stamping
    // simply ages out of the presence map after FRESH_MS — which is the correct
    // behavior anyway (a backgrounded viewer isn't really "watching"), and it
    // stops idle tabs from churning a read+write every 5s.
    const stopBeat = visInterval(tick, BEAT_MS);
    const onLeave = async () => {
      try {
        const r = await window.storage.get(KEY, true);
        if (r) { const map = JSON.parse(r.value) || {}; delete map[sid]; await window.storage.set(KEY, JSON.stringify(map), true); }
      } catch {}
    };
    window.addEventListener("beforeunload", onLeave);
    return () => { cancelled = true; stopBeat(); onLeave(); window.removeEventListener("beforeunload", onLeave); };
  }, []);
  const [saveErr, setSaveErr] = useState(null); // surfaced when a board write fails
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(false);
  const [scouted, setScouted] = useState(null);
  const [profileUser, setProfileUser] = useState(null); // player profile shown inside the tournament
  const [profileFrom, setProfileFrom] = useState(null); // view to return to
  const [reportFrom, setReportFrom] = useState(null);   // view to return to after reporting
  // Reporting is a view — follow chrome.reportNode in and out of it. Must live
  // with the other hooks, above any early return, or the hook count changes
  // between renders and React blanks the screen.
  useEffect(() => {
    if (chrome?.reportNode) setView(v => (v === "report" ? v : (setReportFrom(v), "report")));
    else setView(v => (v === "report" ? (reportFrom || "bracket") : v));
  }, [chrome?.reportNode]); // player id for modal
  const [editingPlayer, setEditingPlayer] = useState(null); // player object being edited by admin
  useEffect(() => { if (editingPlayer) { const t = setTimeout(() => document.getElementById("wr-admin-form")?.scrollIntoView({ behavior: "smooth", block: "center" }), 60); return () => clearTimeout(t); } }, [editingPlayer]);
  const [filterRank, setFilterRank] = useState("All");
  const [filterRole, setFilterRole] = useState("All");
  const [query, setQuery] = useState("");
  // Reserve Hub keeps its own filters — a different question ("who can stand in
  // tonight") than the Scout Hub's ("who should I bid on"). These MUST live up
  // here with the other hooks: DraftApp early-returns on `!state` further down,
  // so a hook declared below that runs on some renders and not others, which is
  // exactly the inconsistent hook count React #310 reports.
  const [rQuery, setRQuery] = useState("");
  const [rRank, setRRank] = useState("All");
  const [rRole, setRRole] = useState("All");
  const [replacing, setReplacing] = useState(null);   // which of my players is out
  const [resetArmed, setResetArmed] = useState(false);
  const [tClearArmed, setTClearArmed] = useState(false);
  const prevBid = useRef(null);
  const stateRef = useRef(null);
  const localStampRef = useRef(0);
  const writeTimerRef = useRef(null);
  stateRef.current = state;

  // ── AUDIO: boot on first user gesture, then delegate UI click/hover sounds globally
  const [soundOn, setSoundOn] = useState(true);
  const soundOnRef = useRef(true);
  soundOnRef.current = soundOn;
  useEffect(() => {
    const boot = () => { SndFX.boot(); };
    const onClick = (e) => {
      SndFX.boot();
      if (!soundOnRef.current) return;
      const el = e.target.closest("button, a, [role=button], input, select");
      if (!el) return;
      if (el.dataset.snd === "off") return;
      SndFX.play(el.dataset.snd || "click");
    };
    const onOver = (e) => {
      if (!soundOnRef.current || !SndFX.isStarted()) return;
      const el = e.target.closest("button, a, [role=button]");
      if (!el || el.dataset.nohover === "1") return;
      SndFX.play("hover");
    };
    window.addEventListener("pointerdown", boot, { once: false });
    window.addEventListener("click", onClick, true);
    window.addEventListener("pointerover", onOver, true);
    return () => {
      window.removeEventListener("pointerdown", boot);
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("pointerover", onOver, true);
    };
  }, []);
  useEffect(() => { SndFX.setEnabled(soundOn); }, [soundOn]);

  // whoosh on page/view change
  const firstView = useRef(true);
  useEffect(() => {
    if (firstView.current) { firstView.current = false; return; }
    if (soundOnRef.current) SndFX.play("transition");
  }, [view]);

  // Once the board loads, map a logged-in captain to their own seat automatically
  // (matched by captainUserId). Host stays "admin"; others can still pick/spectate.
  useEffect(() => {
    if (identity || !state || !auth) return;
    // Owning a seat wins over being staff. A host or moderator who captains a
    // team needs their seat (budget, roster, War Room, bidding) — they keep their
    // admin powers regardless, because isAdmin is derived from their role below,
    // not from this value. Checking staff first was the bug: a host-captain was
    // pinned to "admin", so they had no team and the War Room told them it wasn't
    // theirs to see.
    const mine = state.teams.find(t => t.captainUserId && t.captainUserId === auth.userId);
    if (mine) { setIdentity(mine.id); return; }
    if (auth.role === "host" || auth.role === "moderator") { setIdentity("admin"); return; }
    // Browsing during registration with no seat of your own: spectate.
    if (browse) { setIdentity("spectator"); return; }
    // League users never self-claim seats — the host assigns captains.
    // Anyone logged in without an owned seat watches as spectator, even on a
    // sample/unbuilt board. The seat gate remains only for legacy/preview mode.
    if (auth.userId) setIdentity("spectator");
  }, [state, auth, identity, browse]);

  // draft time lives in shared state so the countdown matches for everyone
  // The auction start, from the board or the tournament itself. No invented
  // fallback — if nothing is scheduled we say so rather than fake a countdown.
  const draftTarget = chrome?.draftAt ? new Date(chrome.draftAt).getTime() : (state?.draftAt ?? null);
  const cd = useCountdown(draftTarget ?? 0);
  const hasDraftTime = Number.isFinite(draftTarget) && draftTarget > 0;

  useEffect(() => {
    let alive = true;
    // Browse mode (registration phase): show a LIVE view of who's registered,
    // with their scouting stats — built in memory, never written to the board,
    // so the real draft board stays untouched until the host opens the draft.
    if (browse && HAS_SUPABASE && window.__VOLT.weekendId) {
      const loadLive = async () => {
        try {
          const { captains, pool } = await fetchRosterForEvent(window.__VOLT.weekendId);
          if (!alive) return;
          // A saved board wins. Regenerating over it is what made every edit
          // (teams, names, budgets, groups) revert a few seconds later — and
          // what erased hand-added players. The test is whether a board exists
          // at all, NOT whether it has teams: a league with fewer than two
          // captains legitimately has none, and gating on teams.length threw
          // that whole board away every poll.
          const saved = await readState();
          if (!alive) return;
          if (saved && Array.isArray(saved.players)) {
            // Keep the host's board; fold in anyone who registered since. Match
            // on userId — registration rows have no `id`, so comparing p.id
            // matched nothing and re-appended the entire roster every poll.
            const known = new Set((saved.players || []).map(p => p.id));
            const added = [
              ...(captains || []).filter(c => !known.has(c.userId)).map(c => regToPlayer(c, true)),
              ...(pool || []).filter(p => !known.has(p.userId)).map(p => regToPlayer(p, false)),
            ];
            const merged = added.length
              ? { ...saved, players: [...(saved.players || []), ...added] }
              : saved;
            // Don't stomp an edit that hasn't finished writing yet.
            const local = stateRef.current;
            if (local && local.stamp && merged.stamp && local.stamp > merged.stamp) return;
            setState(merged);
            return;
          }
          // No board yet — show a live preview of registrations (never written).
          // freshState is truthful on its own now: no seeds, so an empty league
          // yields an empty board, and captains still show even with no pool.
          setState(freshState(captains, pool));
        } catch (e) { console.error("browse roster", e); if (alive && !stateRef.current) setState(freshState(null)); }
      };
      loadLive();
      const stop = visInterval(loadLive, 8000); // pick up new registrations live
      return () => { alive = false; stop(); };
    }
    const load = async () => {
      let s = await readState();
      if (!s) {
        // First boot for this community: build teams from real registered captains.
        let captains = null;
        if (HAS_SUPABASE && window.__VOLT.communityId) {
          try {
            const { data } = await __sb
              .from("users")
              .select("id, display_name, wants_captain, role")
              .eq("community_id", window.__VOLT.communityId);
            const caps = (data || []).filter(u => u.wants_captain || u.role === "captain");
            if (caps.length >= 2) captains = caps.map(u => ({ userId: u.id, name: u.display_name }));
          } catch (e) { console.error("load captains", e); }
        }
        s = await writeState(freshState(captains));
      }
      if (alive) setState(s);
    };
    load();
    // One place that decides whether an incoming board should replace ours.
    // Both the poll and the Realtime subscription go through here, so the
    // guards below can never drift apart between the two paths.
    applyIncomingRef.current = (s) => {
      if (!alive || !s) return;
    // ignore remote state that isn't newer than what we have locally (prevents clobbering optimistic writes)
    if (s.stamp <= localStampRef.current) return;
    // Guard the draw: if WE have a live spin (or a block the remote lacks) that
    // the incoming state would erase, keep ours until our write propagates.
    const local = stateRef.current;
    // A debounced write is still pending — our local state is ahead of the
    // server, so anything the poll returns is stale by definition.
    if (writeTimerRef.current) return;
    if (local) {
      const localSpinLive = local.spin && Date.now() < local.spin.startTs + local.spin.duration + 2000;
      if (localSpinLive && (!s.spin || s.spin.startTs !== local.spin.startTs)) return;
      if (local.block && !s.block && (!s.spin || (local.spin && s.spin?.startTs !== local.spin.startTs))) return;
      // Never let a remote read delete a tournament we're mid-setup on, or
      // roll back group/seed assignments we've already made locally.
      if (local.tournament && !s.tournament) return;
      if (local.tournament && s.tournament && !local.tournament.locked) {
        const count = (t) => {
          if (!t) return 0;
          if (t.format === "group") return (t.groups || []).reduce((n, g) => n + (g.teamIds || []).length, 0);
          if (t.format === "single") return (t.slots || []).filter(Boolean).length;
          return (t.teamIds || []).length;
        };
        if (count(local.tournament) > count(s.tournament)) return;
      }
    }
    if (!stateRef.current || s.stamp !== stateRef.current.stamp) { localStampRef.current = s.stamp; setState(s); }
    };

    const stop = visInterval(async () => {
      const s = await readState();
      applyIncomingRef.current(s);
    }, () => {
      // Bidding is the only moment where a stale price does real damage, so
      // tighten the cadence while a player is on the block (or the wheel is
      // spinning) and ease back off the rest of the time.
      const s = stateRef.current;
      // Realtime confirmed up → this poll is only a safety net, so back right
      // off. The instant the socket reports anything other than SUBSCRIBED we
      // return to full speed, so a silent disconnect degrades to today's
      // behaviour rather than to a frozen board.
      if (liveSyncRef.current) return POLL_MS_SAFETY;
      if (!s) return POLL_MS;
      if (s.block) return POLL_MS_HOT;
      if (s.spin && Date.now() < s.spin.startTs + s.spin.duration + 2000) return POLL_MS_HOT;
      return POLL_MS;
    }, POLL_MS_HIDDEN);
    // ── Realtime ────────────────────────────────────────────────────────────
    // The board is ~29KB at 12 teams, so pushing the whole row on every bid would
    // cost ~940MB of egress across a full 60-player auction. Instead the database
    // broadcasts a ~210-byte delta and each client applies it locally. The 20s
    // safety poll doubles as a reconciler: if an applied delta ever drifts from
    // the truth, the next full read silently corrects it.
    let ch = null;
    const cid = window.__VOLT?.communityId;
    if (HAS_SUPABASE && cid) {
      const evId = window.__VOLT?.weekendId || null;
      const applyDelta = (d) => {
        const cur = stateRef.current;
        if (!cur || !d || (d.event && evId && d.event !== evId)) return false;
        // Older than what we have, or already applied — ignore.
        if (d.stamp && cur.stamp && d.stamp <= cur.stamp) return true;
        const s2 = structuredClone(cur);
        if (d.t === "bid") {
          if (!s2.block) return false;                 // we're behind; fall back to a fetch
          s2.block.currentBid = d.currentBid;
          s2.block.leaderId = d.leaderId;
          s2.block.ts = d.stamp;
          s2.bidHistory = [{ teamId: d.leaderId, amount: d.currentBid, ts: d.stamp }, ...(s2.bidHistory || [])].slice(0, 12);
          s2.log = [`${d.teamName} bids ${fmt(d.currentBid)} on ${d.playerName}`, ...(s2.log || [])].slice(0, 8);
        } else if (d.t === "sell") {
          const pl = (s2.players || []).find((x) => x.id === d.playerId);
          const tm = (s2.teams || []).find((x) => x.id === d.teamId);
          if (!pl || !tm) return false;
          if (pl.status !== "sold") {
            pl.status = "sold"; pl.soldTo = d.teamId; pl.soldPrice = d.price; pl.bidCount = d.bidCount;
            tm.budget -= d.price;
            tm.roster = [...(tm.roster || []), d.playerId];
          }
          s2.recentSales = [{ playerId: d.playerId, name: d.playerName, teamId: d.teamId,
            price: d.price, bidCount: d.bidCount, ts: d.stamp }, ...(s2.recentSales || [])].slice(0, 10);
          s2.log = [`SOLD — ${d.playerName} → ${d.teamName} for ${fmt(d.price)}`, ...(s2.log || [])].slice(0, 8);
          s2.block = null; s2.bidHistory = []; s2.soldFlash = d.stamp; s2.lastSoldTo = d.teamId;
        } else {
          return false;                                 // unknown kind → fetch
        }
        s2.stamp = d.stamp;
        if (d.updatedAt) __boardCache.set(boardKey(), { updatedAt: d.updatedAt, parsed: s2 });
        applyIncomingRef.current(s2);
        return true;
      };

      ch = __sb.channel(`volt:${cid}`, { config: { private: true } })
        .on("broadcast", { event: "volt" }, (msg) => {
          const d = msg?.payload;
          if (!d) return;
          // Anything we can't apply exactly — a spin, a host edit, or a delta we
          // arrived too late for — falls back to one full read.
          if (!applyDelta(d)) readState().then((s) => applyIncomingRef.current(s)).catch(() => {});
        })
        .subscribe((status) => {
          const up = status === "SUBSCRIBED";
          setLiveSync(up);
          if (up) readState().then((s) => applyIncomingRef.current(s)).catch(() => {});
        });
    }
    return () => { alive = false; stop(); if (ch) __sb.removeChannel(ch); };
  }, []);

  useEffect(() => {
    const bid = state?.block?.currentBid ?? null;
    if (prevBid.current !== null && bid !== null && bid !== prevBid.current) { setFlash(true); if (soundOnRef.current) SndFX.play("bid"); const t = setTimeout(() => setFlash(false), 600); return () => clearTimeout(t); }
    prevBid.current = bid;
  }, [state?.block?.currentBid]);

  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state?.spin) return;
    if (soundOnRef.current && Date.now() - state.spin.startTs < 600) SndFX.play("spin");
    const end = state.spin.startTs + state.spin.duration + 2000;
    if (Date.now() > end) return;
    const t = setInterval(() => { setTick((x) => x + 1); if (Date.now() > end + 300) clearInterval(t); }, 150);
    return () => clearInterval(t);
  }, [state?.spin?.startTs]);

  // Guaranteed transition: force a render exactly when the spin animation ends
  // and again when the reveal window closes (spinLive → false), so the view
  // flips from the reel to the bidding panel even if the tick loop missed it.
  useEffect(() => {
    const sp = state?.spin;
    if (!sp) return;
    const landAt = sp.startTs + sp.duration;          // reel stops
    const liveEnd = landAt + REVEAL_MS;                // spinLive expires → bidding
    const timers = [];
    const bump = () => setTick((x) => x + 1);
    [landAt + 60, liveEnd + 60].forEach((at) => {
      const d = at - Date.now();
      if (d > -2000) timers.push(setTimeout(bump, Math.max(d, 0)));
    });
    return () => timers.forEach(clearTimeout);
  }, [state?.spin?.startTs]);

  // red sale flash + sale sound
  const [saleFlash, setSaleFlash] = useState(false);
  useEffect(() => {
    if (!state?.soldFlash) return;
    if (Date.now() - state.soldFlash < 1600) { setSaleFlash(true); if (soundOnRef.current) SndFX.play("sold"); const t = setTimeout(() => setSaleFlash(false), 1300); return () => clearTimeout(t); }
  }, [state?.soldFlash]);

  // play a sparkle when the spin lands on its winner
  const revealedRef = useRef(null);
  useEffect(() => {
    const sp = state?.spin;
    if (!sp) { return; }
    if (revealedRef.current === sp.startTs) return;
    const landAt = sp.startTs + sp.duration;
    const delay = landAt - Date.now();
    if (delay < -1500) return; // already long past
    const fire = () => { revealedRef.current = sp.startTs; if (soundOnRef.current) SndFX.play("reveal"); };
    if (delay <= 0) fire();
    else { const t = setTimeout(fire, delay); return () => clearTimeout(t); }
  }, [state?.spin?.startTs]);

  // if a captain's seat is removed by the host, send them back to the gate
  useEffect(() => {
    if (identity && identity !== "admin" && identity !== "spectator" && state && !state.teams.some((t) => t.id === identity)) setIdentity(null);
  }, [identity, state?.teams?.length]);

  const mutate = useCallback(async (fn, optimistic = false, debounce = false) => {
    if (busy) return;
    if (optimistic) {
      // apply instantly against current in-memory state (no read round-trip), then persist
      const base = stateRef.current || freshState();
      const next = fn(structuredClone(base));
      if (!next) return;
      next.stamp = Date.now();                // stamp now so the poll guard is exact
      localStampRef.current = next.stamp;
      setState(next);
      const persist = async (st, attempt = 0) => {
        try {
          // Conditional on the version we last read. If someone wrote in the
          // gap between our read and this write, the server rejects us and
          // hands back the winner — we then re-run `fn` on THAT state instead
          // of overwriting it. For a bid this means the second captain lands
          // on top of the first ($2,200 over $2,100) rather than erasing them.
          const r = await writeStateChecked(st, boardVersion());
          if (r.ok) { localStampRef.current = Math.max(localStampRef.current, r.state.stamp); setSaveErr(null); return; }
          if (!r.current || attempt >= 3) {
            // Give up gracefully: adopt whatever is on the server rather than
            // leaving the UI showing a value that never persisted.
            if (r.current) { localStampRef.current = r.current.stamp; setState(r.current); }
            setSaveErr("Someone else moved first — showing the latest board.");
            return;
          }
          const merged = fn(structuredClone(r.current));
          if (!merged) {
            // Our change no longer applies to the new state (already outbid,
            // player already sold, budget no longer covers it). Accept theirs.
            localStampRef.current = r.current.stamp;
            setState(r.current);
            setSaveErr(null);
            return;
          }
          merged.stamp = Date.now();
          localStampRef.current = merged.stamp;
          setState(merged);
          return persist(merged, attempt + 1);
        } catch (e) {
          // The write never reached the server. Say so — otherwise the next
          // poll silently paints the old state back and it looks like a ghost.
          console.error("board write failed:", e);
          setSaveErr(e?.message || "Couldn't save — check your connection.");
        }
      };
      if (debounce) {
        // coalesce bursts of rapid edits into one network write shortly after the last one
        if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
        writeTimerRef.current = setTimeout(() => {
          writeTimerRef.current = null;
          const latest = stateRef.current;
          if (latest) persist(latest);
        }, 280);
      } else {
        persist(next);
      }
      return;
    }
    setBusy(true);
    try {
      // Same conditional write as the optimistic path: read, apply, and only
      // commit if nobody wrote in between. On conflict we re-read and re-apply
      // rather than clobbering, so a host edit can't erase a bid landing at
      // the same moment (or the other way round).
      for (let attempt = 0; attempt < 4; attempt++) {
        const latest = (await readState()) || freshState();
        const expected = boardVersion();
        const next = fn(structuredClone(latest));
        if (!next) break;
        next.stamp = Date.now();
        const r = await writeStateChecked(next, expected);
        if (r.ok) { localStampRef.current = next.stamp; setState(next); break; }
        if (!r.current || attempt === 3) {
          if (r.current) { localStampRef.current = r.current.stamp; setState(r.current); }
          break;
        }
      }
    }
    finally { setBusy(false); }
  }, [busy]);

  const SPIN_MS = 7200, REVEAL_MS = 2000;
  // `reserve` decides which hub a hand-added player belongs to. It reuses
  // poolEligible rather than adding a second flag: false already means "not in
  // the draft", which is exactly what a reserve is.
  const addPlayer = (p, reserve = false) =>
    mutate((s) => { s.players.push({ ...p, poolEligible: !reserve }); return s; });
  const editPlayer = (p) => {
    mutate((s) => { const i = s.players.findIndex((x) => x.id === p.id); if (i < 0) return null; s.players[i] = { ...s.players[i], ...p }; return s; });
    // Real players (id = auth uuid) → persist to their profile so edits survive
    // board rebuilds and follow the player across tournaments.
    if (HAS_SUPABASE && typeof p.id === "string" && p.id.length > 30 && window.__VOLT.communityId) {
      __sb.from("player_profiles").upsert({
        user_id: p.id, community_id: window.__VOLT.communityId,
        rank: p.rank ?? null, role: p.role ?? null, agent: p.agent ?? null,
        kda: p.kda ?? null, acs: p.acs ?? null, hs: p.hs ?? null, win: p.win ?? null,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" }).then(({ error }) => { if (error) console.error("profile write-through:", error.message); });
    }
  };
  const removePlayer = (pid) => mutate((s) => {
    if (s.block?.playerId === pid) return null; // not while on the block
    const p = s.players.find((x) => x.id === pid);
    if (p && p.status === "sold" && p.soldTo) {
      const t = s.teams.find((x) => x.id === p.soldTo);
      if (t) { t.roster = t.roster.filter((id) => id !== pid); t.budget += Math.max(0, Number(p.soldPrice) || 0); }
    }
    s.players = s.players.filter((x) => x.id !== pid);
    return s;
  }, true, true);
  // Move a player between the draft roster and the reserve list. The board holds a
  // copy for rendering, but registrations.pool_eligible is the durable truth — so
  // the move survives a rebuild from registrations. Moving a SOLD player out
  // refunds their team and frees the slot, per the host's call that this is an undo.
  const setPoolEligible = async (pid, next) => {
    mutate((s) => {
      const p = s.players.find((x) => x.id === pid); if (!p) return null;
      if (p.poolEligible === next) return null;
      p.poolEligible = next;
      if (!next && p.status === "sold") {
        const t = s.teams.find((x) => x.id === p.soldTo);
        const paid = Math.max(0, Number(p.soldPrice) || 0);
        if (t) { t.roster = (t.roster || []).filter((id) => id !== pid); t.budget += paid; }
        s.log.unshift(`${p.name} moved to reserves — ${fmt(paid)} refunded to ${t ? t.name : "their team"}`);
        s.log = s.log.slice(0, 8);
        p.status = "pool"; p.soldTo = null; p.soldPrice = null;
      } else {
        s.log.unshift(`${p.name} moved to the ${next ? "draft pool" : "reserves"}`);
        s.log = s.log.slice(0, 8);
      }
      return s;
    }, true);
    // Registered players have a uuid id; hand-added ones have no registration row.
    const registered = typeof pid === "string" && pid.length > 30;
    if (HAS_SUPABASE && registered && window.__VOLT?.weekendId) {
      try {
        await __sb.from("registrations").update({ pool_eligible: next })
          .eq("event_id", window.__VOLT.weekendId).eq("user_id", pid);
      } catch (e) { console.error("pool_eligible write failed", e); }
    }
  };
  const spinNominate = () => { if (!isLeagueOwner()) return; return mutate((s) => {
    if (s.block || (s.spin && Date.now() < s.spin.startTs + SPIN_MS + REVEAL_MS)) return null;
    const poolIds = s.players.filter((p) => p.status === "pool" && !p.isCaptain).map((p) => p.id);
    if (!poolIds.length) return null;
    for (let i = poolIds.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [poolIds[i], poolIds[j]] = [poolIds[j], poolIds[i]]; }
    const winnerId = poolIds[Math.floor(Math.random() * poolIds.length)];
    const p = s.players.find((x) => x.id === winnerId);
    p.status = "block";
    s.block = { playerId: winnerId, startingBid: rankOf(p.rank).bid, currentBid: rankOf(p.rank).bid, leaderId: null, ts: Date.now() };
    s.spin = { playerId: winnerId, pool: poolIds, startTs: Date.now(), duration: SPIN_MS };
    s.bidHistory = [];
    s.log.unshift(`Fate chose ${p.name} — opening at ${fmt(s.block.startingBid)}`); s.log = s.log.slice(0, 8);
    return s;
  }, true); };  // optimistic — overlay appears instantly
  // ── Bidding and selling are decided by the SERVER, not here ──────────────
  // The client used to compute the new price from its own copy of the board and
  // write the whole thing back. That is what produced every symptom of the last
  // tournament: two captains computing the same price, a bid landing on a stale
  // board, and the host selling to whoever they last saw leading. Now the client
  // sends only the intent — "I bid", "sell" — and the database reads the live
  // price under a row lock, validates, and returns the authoritative board.
  const [bidPending, setBidPending] = useState(false);
  // Shared by the poll and the Realtime subscription so their guards can't drift.
  const applyIncomingRef = useRef(() => {});
  // Realtime health. A websocket that dies quietly is worse than slow polling —
  // the board would stop updating while still looking live. So the poll never
  // goes away: it just relaxes to a safety net while the socket is proven up,
  // and snaps back to full speed the moment it isn't.
  const [liveSync, setLiveSync] = useState(false);
  const liveSyncRef = useRef(false);
  useEffect(() => { liveSyncRef.current = liveSync; }, [liveSync]);

  // Adopt a board handed back by an RPC. It is by definition newer than anything
  // local, so drop the conditional-GET cache and let the next poll re-prime it.
  // Adopt a board handed back by an RPC, keeping the version cache primed.
  // Dropping the cache instead would leave boardVersion() null, and the next
  // client-side write (spin, pass, a host edit) would then go through as an
  // UNCONDITIONAL write — silently reinstating last-write-wins.
  const adoptServerBoard = (res) => {
    const board = res?.board || null;
    if (!board) return;
    localStampRef.current = board.stamp || Date.now();
    if (res.updatedAt) __boardCache.set(boardKey(), { updatedAt: res.updatedAt, parsed: board });
    else __boardCache.delete(boardKey());
    setState(board);
  };

  const placeBid = async (teamId) => {
    if (bidPending || !HAS_SUPABASE || !window.__VOLT?.weekendId) return;
    setBidPending(true); setSaveErr(null);
    try {
      const { data, error } = await __sb.rpc("volt_place_bid", {
        p_event: window.__VOLT.weekendId, p_team: teamId,
      });
      if (error) throw new Error(error.message || "Bid failed.");
      adoptServerBoard(data);
    } catch (e) {
      // Real rejections are meaningful here (outbid, roster full, over your
      // limit), so show them rather than failing silently.
      setSaveErr(String(e.message || "Bid failed.").replace(/^.*?:\s*/, ""));
    }
    setBidPending(false);
  };

  const sell = async () => {
    if (!isLeagueOwner() || !HAS_SUPABASE || !window.__VOLT?.weekendId) return;
    setBidPending(true); setSaveErr(null);
    try {
      const { data, error } = await __sb.rpc("volt_sell", { p_event: window.__VOLT.weekendId });
      if (error) throw new Error(error.message || "Could not sell.");
      adoptServerBoard(data);
    } catch (e) {
      setSaveErr(String(e.message || "Could not sell.").replace(/^.*?:\s*/, ""));
    }
    setBidPending(false);
  };

  const passPlayer = () => { if (!isLeagueOwner()) return; return mutate((s) => {
    const b = s.block; if (!b) return null;
    const p = s.players.find((x) => x.id === b.playerId);
    if (p) { p.status = "pool"; s.log.unshift(`${p.name} passed — back to the pool`); s.log = s.log.slice(0, 8); }
    s.block = null; s.bidHistory = []; return s;
  }, true) };
  const resetAll = () => { if (!resetArmed) { setResetArmed(true); setTimeout(() => setResetArmed(false), 4000); return; } setResetArmed(false); mutate(() => freshState()); };
  const renameTeam = (teamId, name, captain) => mutate((s) => {
    const t = s.teams.find((x) => x.id === teamId); if (!t) return null;
    const nm = (name ?? "").trim(), cap = (captain ?? "").trim();
    if (nm) t.name = nm.toUpperCase();
    if (cap) t.captain = cap;
    return s;
  }, true, true);
  const addTeam = () => mutate((s) => {
    const used = new Set(s.teams.map((t) => t.hue));
    const hue = TEAM_HUES.find((h) => !used.has(h)) || teamHue(s.teams.length);
    const n = s.teams.length + 1;
    s.teams.push({ id: "t" + uid(), name: "TEAM " + n, captain: "Captain " + n, hue, budget: 10000, roster: [] });
    s.log.unshift(`New team added — ${s.teams.length} teams in the draft`); s.log = s.log.slice(0, 8);
    return s;
  }, true, true);
  const removeTeam = (teamId) => mutate((s) => {
    if (s.teams.length <= MIN_TEAMS) return null;
    if (s.block?.leaderId === teamId) return null; // can't remove the team holding the live bid
    const t = s.teams.find((x) => x.id === teamId); if (!t) return null;
    // return any drafted players to the pool
    t.roster.forEach((pid) => { const p = s.players.find((x) => x.id === pid); if (p) { p.status = "pool"; p.soldTo = null; p.soldPrice = null; } });
    s.teams = s.teams.filter((x) => x.id !== teamId);
    if (s.teamCodes) delete s.teamCodes[teamId];
    s.log.unshift(`${t.name} removed — ${t.roster.length ? "drafted players returned to pool" : "had no draftees"}`); s.log = s.log.slice(0, 8);
    return s;
  }, true, true);

  /* ── manual roster edits (Host only) — add deducts the price, remove refunds it, so budget stays correct ── */
  const adminAddToRoster = (teamId, playerId, price) => mutate((s) => {
    const t = s.teams.find((x) => x.id === teamId); if (!t || emptySlots(t) === 0) return null;
    const p = s.players.find((x) => x.id === playerId); if (!p || p.status === "sold") return null;
    if (s.block?.playerId === playerId) return null; // not while on the block
    const cost = Math.max(0, Number(price) || 0);
    p.status = "sold"; p.soldTo = t.id; p.soldPrice = cost;
    t.budget -= cost;            // deduct so add/remove stay symmetric with budget
    t.roster.push(p.id);
    s.log.unshift(`Commish added ${p.name} → ${t.name} (${fmt(cost)})`); s.log = s.log.slice(0, 8);
    return s;
  }, true, true);
  const adminRemoveFromRoster = (teamId, playerId) => mutate((s) => {
    const t = s.teams.find((x) => x.id === teamId); if (!t) return null;
    const p = s.players.find((x) => x.id === playerId); if (!p) return null;
    const refund = Math.max(0, Number(p.soldPrice) || 0); // refund what was actually paid (auction sales carry a price)
    t.roster = t.roster.filter((id) => id !== playerId);
    if (refund > 0) t.budget += refund;
    p.status = "pool"; p.soldTo = null; p.soldPrice = null;
    s.log.unshift(`Commish removed ${p.name} from ${t.name}${refund > 0 ? ` — ${fmt(refund)} refunded` : ""}`); s.log = s.log.slice(0, 8);
    return s;
  }, true, true);

  const setTeamBudget = (teamId, value) => mutate((s) => {
    const t = s.teams.find((x) => x.id === teamId); if (!t) return null;
    const v = Math.max(0, Number(value) || 0);
    s.log.unshift(`Commish set ${t.name} budget → ${fmt(v)} (was ${fmt(t.budget)})`); s.log = s.log.slice(0, 8);
    t.budget = v;
    return s;
  }, true, true);

  // tournament stats — per-match entries that aggregate on the leaderboard (separate from scouting stats)
  const addMatchStat = (pid, entry) => mutate((s) => {
    const p = s.players.find((x) => x.id === pid); if (!p) return null;
    if (!Array.isArray(p.tourneyStats)) p.tourneyStats = [];
    p.tourneyStats.push({
      k: Math.max(0, parseInt(entry.k) || 0),
      d: Math.max(0, parseInt(entry.d) || 0),
      a: Math.max(0, parseInt(entry.a) || 0),
      acs: Math.max(0, parseInt(entry.acs) || 0),
      ts: Date.now(),
    });
    return s;
  }, true, true);
  const removeMatchStat = (pid, idx) => mutate((s) => {
    const p = s.players.find((x) => x.id === pid); if (!p || !Array.isArray(p.tourneyStats)) return null;
    p.tourneyStats.splice(idx, 1);
    return s;
  }, true, true);

  // tag a player as a captain → excluded from the auction draw (stays visible/scoutable)
  const toggleCaptain = (pid) => {
    const p0 = stateRef.current?.players?.find((x) => x.id === pid);
    const promoting = p0 ? !p0.isCaptain : true;
    mutate((s) => {
      const p = s.players.find((x) => x.id === pid); if (!p) return null;
      if (!p.isCaptain) {
        // Promote: exclude from the draw AND spin up their roster in the Locker Room.
        p.isCaptain = true;
        const nid = "t" + (Math.max(0, ...s.teams.map((t) => parseInt(String(t.id).slice(1)) || 0)) + 1);
        s.teams.push({
          id: nid, name: p.name.toUpperCase().slice(0, 22),
          captain: p.name,
          captainUserId: (typeof p.id === "string" && p.id.length > 30) ? p.id : null,
          hue: teamHue(s.teams.length),
          budget: 10000, roster: [],
        });
        s.log.unshift(`${p.name} tagged as captain — roster created in the Locker Room`);
      } else {
        // Demote: remove their (empty) roster and return them to the draw.
        const t = s.teams.find((x) => (x.captainUserId && x.captainUserId === p.id) || x.captain === p.name);
        if (t && t.roster && t.roster.length) {
          s.log.unshift(`Can't untag ${p.name} — their roster already has players`);
          s.log = s.log.slice(0, 8); return s;
        }
        if (t) s.teams = s.teams.filter((x) => x !== t);
        p.isCaptain = false;
        s.log.unshift(`${p.name} untagged — roster removed`);
      }
      s.log = s.log.slice(0, 8);
      return s;
    }, true, true);
    // Keep the registration panel + future board rebuilds in agreement.
    if (HAS_SUPABASE && typeof pid === "string" && pid.length > 30 && window.__VOLT.weekendId) {
      __sb.from("registrations").update({ is_captain: promoting })
        .eq("event_id", window.__VOLT.weekendId).eq("user_id", pid)
        .then(({ error }) => { if (error) console.error("captain sync:", error.message); });
    }
  };

  /* ── tournament mutators (Host only) ── */
  const tCreate = (format, matchType, numGroups) => mutate((s) => {
    const ids = s.teams.map((t) => t.id);
    const boNum = matchType === "bo3" ? 3 : 1;       // numeric best-of for match logic
    const t = { format, bo: boNum, overrides: {}, createdAt: Date.now() };
    if (format === "group") {
      const g = Math.max(2, Math.min(numGroups || 2, Math.max(2, Math.floor(ids.length / 2) || 2)));
      t.groups = Array.from({ length: g }, (_, i) => ({ id: "g" + i, name: "Group " + String.fromCharCode(65 + i), teamIds: [] }));
      t.matches = {}; // per-group matches generated when groups are locked
      t.locked = false;
      t.final = null; // { teamA, teamB, bo, maps, done, winner } once groups complete
    } else if (format === "roundrobin" || format === "league") {
      t.teamIds = []; // host adds all participating teams
      t.matches = [];
      t.locked = false;
    } else if (format === "single") {
      // fixed-length bracket positions (power of 2 >= team count, min 2), filled by the host
      const size = Math.max(nextPow2(ids.length || 2), 2);
      t.slots = Array.from({ length: size }, () => null);
      t.rounds = []; // built on lock
      t.locked = false;
    }
    s.tournament = t;
    s.log.unshift(`Tournament created — ${format === "group" ? "Group Stage" : format === "single" ? "Single Elimination" : "Round Robin"} (${matchType.toUpperCase()})`); s.log = s.log.slice(0, 8);
    return s;
  }, true);

  const tClear = () => mutate((s) => { s.tournament = null; if (!Array.isArray(s.log)) s.log = []; s.log.unshift("Tournament cleared"); s.log = s.log.slice(0, 8); return s; }, true);

  // Every match currently in the tournament, flattened — used to carry results
  // across a format switch.
  const flattenMatches = (t) => {
    if (!t) return [];
    const out = [];
    if (t.format === "group") {
      Object.values(t.matches || {}).forEach((arr) => (arr || []).forEach((m) => out.push(m)));
      if (t.final) out.push(t.final);
    } else if (t.format === "single") {
      (t.rounds || []).forEach((r) => (r || []).forEach((m) => out.push(m)));
    } else {
      (t.matches || []).forEach((m) => out.push(m));
    }
    return out.filter(Boolean);
  };
  const pairKey = (x, y) => [x, y].filter(Boolean).sort().join("~");

  // Switch the tournament's format, preserving played fixtures where the same two
  // teams meet again. Results keep feeding the same leaderboards either way.
  const tSwitchFormat = (format, matchType, numGroups) => mutate((s) => {
    const prev = s.tournament;
    const carry = {};
    flattenMatches(prev).forEach((m) => {
      if (!m.teamA || !m.teamB) return;
      const played = m.done || (m.maps || []).some((x) => x && (x.a != null || x.b != null));
      if (played || m.scheduledAt || (m.votes && Object.keys(m.votes).length)) carry[pairKey(m.teamA, m.teamB)] = m;
    });
    s.__carry = carry;              // consumed by tLock below
    const ids = s.teams.map((t) => t.id);
    const boNum = matchType === "bo3" ? 3 : 1;
    const t = { format, bo: boNum, overrides: prev?.overrides || {}, createdAt: Date.now() };
    if (format === "group") {
      const g = Math.max(2, Math.min(numGroups || 2, Math.max(2, Math.floor(ids.length / 2) || 2)));
      t.groups = Array.from({ length: g }, (_, i) => ({ id: "g" + i, name: "Group " + String.fromCharCode(65 + i), teamIds: [] }));
      t.matches = {}; t.locked = false; t.final = null;
    } else if (format === "roundrobin" || format === "league") {
      t.teamIds = []; t.matches = []; t.locked = false;
    } else if (format === "single") {
      const size = Math.max(nextPow2(ids.length || 2), 2);
      t.slots = Array.from({ length: size }, () => null);
      t.rounds = []; t.locked = false;
    }
    s.tournament = t;
    if (!Array.isArray(s.log)) s.log = [];
    s.log.unshift(`Format switched — ${format === "group" ? "Group Stage" : format === "single" ? "Single Elimination" : "League"} (${matchType.toUpperCase()})`);
    s.log = s.log.slice(0, 8);
    return s;
  }, true);
  const armTClear = () => { if (!tClearArmed) { setTClearArmed(true); setTimeout(() => setTClearArmed(false), 4000); return; } setTClearArmed(false); tClear(); };

  // assign / remove a team to a group (group format) or the pool list (roundrobin) or a slot (single)
  const tAssign = (target, teamId) => mutate((s) => {
    const t = s.tournament; if (!t || t.locked) return null;
    if (t.format === "group") {
      // remove from all groups first, then add to target group
      t.groups.forEach((g) => { g.teamIds = g.teamIds.filter((x) => x !== teamId); });
      if (target) { const g = t.groups.find((x) => x.id === target); if (g && !g.teamIds.includes(teamId)) g.teamIds.push(teamId); }
    } else if ((t.format === "roundrobin" || t.format === "league")) {
      if (t.teamIds.includes(teamId)) t.teamIds = t.teamIds.filter((x) => x !== teamId);
      else t.teamIds.push(teamId);
    }
    return s;
  }, true, true);

  // place a team into a specific bracket position (or clear it with teamId=null).
  // a team can only occupy one slot, so remove it from any other slot first.
  const tSetSlot = (index, teamId) => mutate((s) => {
    const t = s.tournament; if (!t || t.locked || t.format !== "single") return null;
    if (index < 0 || index >= t.slots.length) return null;
    if (teamId) { for (let k = 0; k < t.slots.length; k++) if (t.slots[k] === teamId) t.slots[k] = null; }
    t.slots[index] = teamId || null;
    return s;
  }, true, true);

  // resize the bracket (number of positions). keeps existing picks that still fit.
  const tSetSlotCount = (size) => mutate((s) => {
    const t = s.tournament; if (!t || t.locked || t.format !== "single") return null;
    size = Math.max(2, size);
    const cur = t.slots.slice(0, size);
    while (cur.length < size) cur.push(null);
    t.slots = cur;
    return s;
  }, true);

  const tLock = () => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    if (t.format === "group") {
      t.matches = {};
      t.groups.forEach((g) => { t.matches[g.id] = roundRobinMatches(g.teamIds, t.bo); });
    } else if ((t.format === "roundrobin" || t.format === "league")) {
      t.matches = t.format === "league" ? leagueMatches(t.teamIds, t.bo) : roundRobinMatches(t.teamIds, t.bo);
    } else if (t.format === "single") {
      t.rounds = buildSingleElim(t.slots, t.bo);
    }
    // Restore anything already played/scheduled for the same team pairing so a
    // format switch doesn't orphan reported stats (fxLabel depends on match id).
    if (s.__carry && Object.keys(s.__carry).length) {
      const key = (x, y) => [x, y].filter(Boolean).sort().join("~");
      const restore = (m) => {
        if (!m || !m.teamA || !m.teamB) return;
        const old = s.__carry[key(m.teamA, m.teamB)];
        if (!old) return;
        m.id = old.id;                       // keeps fxLabel stable → stats stay linked
        m.maps = old.maps || [];
        m.bo = old.bo || m.bo;
        m.done = !!old.done;
        m.winner = old.winner ?? null;
        if (old.scheduledAt) m.scheduledAt = old.scheduledAt;
        if (old.votes) m.votes = old.votes;
      };
      if (t.format === "group") { Object.values(t.matches || {}).forEach((arr) => (arr || []).forEach(restore)); }
      else if (t.format === "single") { (t.rounds || []).forEach((r) => (r || []).forEach(restore)); propagateElim(t); }
      else { (t.matches || []).forEach(restore); }
      delete s.__carry;
    }
    t.locked = true;
    s.log.unshift("Tournament bracket locked — matches generated"); s.log = s.log.slice(0, 8);
    return s;
  }, true);

  // set a single map score within a match, then re-resolve the match + propagate bracket winners
  const tSetMap = (locator, mapIdx, aScore, bScore) => mutate((s) => {
    const t = s.tournament; if (!t || !t.locked) return null;
    const m = findMatch(t, locator); if (!m) return null;
    if (!m.maps) m.maps = [];
    while (m.maps.length <= mapIdx) m.maps.push({ a: null, b: null });
    m.maps[mapIdx] = { a: aScore == null || aScore === "" ? null : Number(aScore), b: bScore == null || bScore === "" ? null : Number(bScore) };
    resolveMatch(m);
    if (t.format === "single") propagateElim(t);
    if (t.format === "group") syncFinal(s, t);
    syncLeagueFinal(s, t);
    return s;
  }, true, true);

  // set best-of for a specific match (e.g. finals to Bo3)
  const tSetBo = (locator, bo) => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    const m = findMatch(t, locator); if (!m) return null;
    m.bo = bo; resolveMatch(m);
    if (t.format === "single") propagateElim(t);
    return s;
  }, true, true);

  // Schedule a match (host). Stored as an ISO string on the match itself.
  const tSetTime = (locator, iso) => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    const m = findMatch(t, locator); if (!m) return null;
    m.scheduledAt = iso || null;
    return s;
  }, true, true);

  // Final prediction — one vote per user per match, publicly attributed.
  // votes: { [userId]: { side: "a"|"b", name } }
  const tVote = (locator, side) => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    const m = findMatch(t, locator); if (!m) return null;
    if (m.done) return null;                       // locked once played
    const uid = window.__VOLT?.userId; if (!uid) return null;
    if (!m.votes || typeof m.votes !== "object") m.votes = {};
    const name = window.__VOLT?.userName || "Player";
    if (m.votes[uid] && m.votes[uid].side === side) delete m.votes[uid];  // tap again = undo
    else m.votes[uid] = { side, name };
    return s;
  }, true, true);

  // Host control over the Sunday final: set either side manually (locks
  // auto-seeding), or clear the lock to let the table decide again.
  const tSetFinalTeam = (side, teamId) => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    if (!t.final) t.final = { id: "final", teamA: null, teamB: null, bo: t.bo, maps: [], done: false, winner: null };
    if (t.final.done) return null;
    t.final[side === "a" ? "teamA" : "teamB"] = teamId || null;
    t.finalLock = true;
    return s;
  }, true);

  const tResetFinal = () => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    if (t.final?.done) return null;
    t.finalLock = false;
    t.final = null;
    syncLeagueFinal(s, t);
    return s;
  }, true);

  const tOverride = (teamId, patch) => mutate((s) => {
    const t = s.tournament; if (!t) return null;
    if (!t.overrides) t.overrides = {};
    if (patch == null) delete t.overrides[teamId];
    else t.overrides[teamId] = { ...(t.overrides[teamId] || {}), ...patch };
    return s;
  }, true, true);

  // build the group-stage final from current group winners (top of each group)
  // League/round-robin decider — "the Sunday final". Auto-seeds the top two
  // once every round-robin match is reported; leaves it alone if the host has
  // manually set the teams (t.finalLock) or once it's been played.
  function syncLeagueFinal(s, t) {
    if (!t || (t.format !== "league" && t.format !== "roundrobin")) return;
    if (t.final?.done) return;                 // played — never touch
    if (t.finalLock) return;                   // host chose the teams
    const ms = t.matches || [];
    const allDone = ms.length > 0 && ms.every((m) => m.done);
    if (!allDone) { if (t.final && !t.final.done) t.final = null; return; }
    const rows = computeStandings(t.teamIds, ms, t.overrides);
    if (rows.length < 2) return;
    const [a, b] = [rows[0].teamId, rows[1].teamId];
    if (!t.final) t.final = { id: "final", teamA: a, teamB: b, bo: t.bo, maps: [], done: false, winner: null };
    else { t.final.teamA = a; t.final.teamB = b; }
  }

  function syncFinal(s, t) {
    const winners = t.groups.map((g) => {
      const rows = computeStandings(g.teamIds, t.matches[g.id] || [], t.overrides);
      const allDone = (t.matches[g.id] || []).every((m) => m.done);
      return allDone && rows.length ? rows[0].teamId : null;
    });
    if (winners.length >= 2 && winners[0] && winners[1]) {
      if (!t.final) t.final = { id: "final", teamA: winners[0], teamB: winners[1], bo: t.bo, maps: [], done: false, winner: null };
      else if (!t.final.done) { t.final.teamA = winners[0]; t.final.teamB = winners[1]; }
    } else if (t.final && !t.final.done) {
      t.final = null;
    }
  }

  /* ── loading ── */
  if (!state) return (
    <div className="min-h-screen grid place-items-center" style={{ background: "#0a0d18", color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif" }}>
      <span className="uppercase tracking-widest animate-pulse">Initializing auction grid…</span>
    </div>
  );

  const fonts = (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Space+Grotesk:wght@400;500;700&family=IBM+Plex+Mono:wght@500;700&display=swap');
      /* Global UI scale — bumps the whole app up a notch, like a light browser zoom. */
      html { zoom: 1.1; }
      /* Keyboard focus — visible ring for keyboard users only (not mouse clicks). */
      *:focus { outline: none; }
      *:focus-visible { outline: 2px solid #6fa0ff; outline-offset: 2px; border-radius: 2px; }
      button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible, [tabindex]:focus-visible {
        outline: 2px solid #6fa0ff; outline-offset: 2px; box-shadow: 0 0 0 4px rgba(61,123,255,0.25);
      }
      .sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
      /* Tungsten webfont stripped for artifact rendering; falls back to condensed system fonts via the font stacks below */
      .holo-sweep { background: linear-gradient(115deg, transparent 30%, rgba(0,229,255,0.10) 45%, rgba(255,255,255,0.16) 50%, rgba(157,107,255,0.10) 55%, transparent 70%); background-size: 250% 250%; animation: sweep 4.5s ease-in-out infinite; }
      @keyframes sweep { 0% { background-position: 120% 0; } 60%,100% { background-position: -120% 0; } }
      /* diagonal shine flowing through the hero headline letters */
      @keyframes textshine { 0% { background-position: 220% 0; } 100% { background-position: -120% 0; } }
      .shine-text { background-size: 250% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; color: transparent; animation: textshine 4s linear infinite; }
      .shine-white { background-image: linear-gradient(100deg, #ffffff 0%, #ffffff 44%, #ffffff 48%, #ffffff 50%, #ffffff 52%, #f2f6ff 58%, #ffffff 100%); }
      .shine-blue { background-image: linear-gradient(100deg, #2f6dff 0%, #2f6dff 42%, #bcd6ff 48%, #ffffff 50%, #bcd6ff 52%, #2f6dff 58%, #2f6dff 100%); }
      @media (prefers-reduced-motion: reduce) { .shine-text { animation: none; } }
      @keyframes bidpop { 0% { transform: scale(1); } 35% { transform: scale(1.12); } 100% { transform: scale(1); } }
      .bid-pop { animation: bidpop 0.55s cubic-bezier(.2,.9,.3,1.4); }
      /* hide native number-input spinner arrows */
      input[type=number]::-webkit-outer-spin-button,
      input[type=number]::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
      input[type=number] { -moz-appearance: textfield; appearance: textfield; }
      .idle-rotor { animation: rotor 14s linear infinite; }
      .ea-btn { transition: transform .18s ease, box-shadow .18s ease, background .18s ease, border-color .18s ease; }
      .ea-btn .ea-arrow { transition: transform .18s ease; display: inline-block; }
      .ea-btn:hover { transform: translateY(-2px); border-color: rgba(111,160,255,0.95); background: linear-gradient(180deg, rgba(22,41,77,0.7), rgba(12,23,48,0.55)); color: #ffffff; box-shadow: 0 0 38px rgba(61,123,255,0.45), inset 0 0 22px rgba(61,123,255,0.12); }
      .ea-btn:hover .ea-arrow { transform: translateX(6px); }
      .ea-btn:active { transform: translateY(0) scale(0.98); }
      .ea-btn.ea-disabled { pointer-events: none; }
      .ea-btn.ea-disabled:hover { transform: none; box-shadow: none; }
      .seat-card { transition: transform .16s ease, box-shadow .16s ease, border-color .16s ease, background .16s ease; }
      .seat-card:hover { transform: translateY(-4px); border-color: var(--hue) !important; box-shadow: 0 0 0 1px var(--hue), 0 0 32px -4px var(--hue), 0 18px 40px rgba(0,0,0,0.5); background: linear-gradient(160deg, color-mix(in srgb, var(--hue) 14%, transparent), rgba(8,12,24,0.6)) !important; }
      .seat-card:active { transform: translateY(-1px); }
      .seat-card .seat-go { opacity: 0; transform: translateX(-4px); transition: opacity .16s ease, transform .16s ease; }
      .seat-card:hover .seat-go { opacity: 1; transform: translateX(0); }
      .gate-cta { transition: transform .18s ease, box-shadow .18s ease, background .18s ease; }
      .gate-cta:hover { transform: translateY(-2px) scale(1.02); box-shadow: 0 0 40px rgba(61,123,255,0.5); background: rgba(61,123,255,0.16) !important; }
      @keyframes rotor { to { transform: rotate(360deg); } }
      .reel-drift { animation: reeldrift 60s linear infinite; }
      @keyframes reeldrift { from { transform: translate(0, -50%); } to { transform: translate(-50%, -50%); } }
      .burst { animation: burst 1.1s ease-out infinite; }
      @keyframes burst { 0% { transform: scale(1); opacity: 0.9; } 100% { transform: scale(1.18); opacity: 0; } }
      .float-soft { animation: floaty 7s ease-in-out infinite; }
      @keyframes floaty { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
      .marquee { display: inline-flex; white-space: nowrap; animation: marq 28s linear infinite; }
      @keyframes marq { from { transform: translateX(0); } to { transform: translateX(-50%); } }
      .cd-pulse { animation: cdpulse 1.6s ease-in-out infinite; }
      @keyframes cdpulse { 0%,100% { opacity: 1; box-shadow: 0 0 6px currentColor; } 50% { opacity: 0.35; box-shadow: 0 0 2px currentColor; } }
      /* one shared horizontal inset for all aligned sections (nav, hero text, cards, ticker) */
      .page-wrap { max-width: 1760px; margin-left: auto; margin-right: auto; padding-left: 5vw; padding-right: 5vw; }
      @media (min-width: 1400px) { .page-wrap { padding-left: 88px; padding-right: 88px; } }
      /* Hero bleeds to the edges of the CONTENT area (inside the rail), not the
         viewport — a 100vw escape would slide it under the fixed rail. */
      .volt-hero-bleed { width: auto; margin-left: -5vw; margin-right: -5vw; }
      @media (min-width: 1400px) { .volt-hero-bleed { margin-left: -88px; margin-right: -88px; } }
      @media (max-width: 900px) { .volt-hero-bleed { margin-left: -18px; margin-right: -18px; } }
      /* Tighter gutters on small screens so content isn't squeezed by 5vw padding. */
      @media (max-width: 900px) { .page-wrap { padding-left: 18px; padding-right: 18px; } }
      /* The hero lives right of the rail, so its copy column needs more of the
         remaining width as the screen shrinks — and the title must come down
         with it or it overflows. */
      @media (max-width: 1680px) {
        .volt-hero-copy { width: min(760px, 78%) !important; }
        .volt-hero-title { font-size: clamp(2.2rem, 5.6vw, 5.6rem) !important; }
      }
      @media (max-width: 1280px) {
        .volt-hero-copy { width: min(700px, 80%) !important; }
        .volt-hero-title { font-size: clamp(2.2rem, 5.2vw, 4.4rem) !important; }
      }
      /* Hero copy keeps real breathing room on every screen, and can never
         exceed its own column no matter how the rail is set. */
      .volt-hero-copy { padding-right: clamp(16px, 4%, 56px); box-sizing: border-box; }
      .volt-hero-title { overflow-wrap: break-word; hyphens: none; max-width: 100%; }
      /* Container queries: the hero measures the space LEFT OF the rail, so
         expanding the rail shrinks the headline instead of pushing it off. */
      @supports (container-type: inline-size) {
        .volt-hero-title { font-size: clamp(2rem, 7cqw, 8rem) !important; }
        .volt-hero-copy  { width: min(820px, 62cqw) !important; }
        @container (max-width: 1500px) {
          .volt-hero-title { font-size: clamp(2rem, 6.2cqw, 5.2rem) !important; }
          .volt-hero-copy  { width: min(700px, 72cqw) !important; }
        }
        @container (max-width: 1150px) {
          .volt-hero-title { font-size: clamp(1.9rem, 6cqw, 4rem) !important; }
          .volt-hero-copy  { width: 82cqw !important; }
        }
        @container (max-width: 860px) {
          .volt-hero-title { font-size: clamp(1.8rem, 7.5cqw, 3.2rem) !important; }
          .volt-hero-copy  { width: 92cqw !important; }
        }
      }
      @media (max-width: 1024px) {
        .volt-hero-copy { width: 88% !important; }
        .volt-hero-title { font-size: clamp(2rem, 6vw, 3.8rem) !important; }
      }
      @media (max-width: 768px) {
        .volt-hero-copy { width: 100% !important; top: 14% !important; bottom: 12% !important; }
        .volt-hero-title { font-size: clamp(1.9rem, 9vw, 3rem) !important; }
      }
      /* The 10% global scale-up is generous on laptops — ease it off so layouts
         that fit at 100% don't overflow. */
      @media (max-width: 1440px) { html { zoom: 1.04; } }
      @media (max-width: 1180px) { html { zoom: 1; } }
      .grid-bg { background-image: linear-gradient(rgba(157,107,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(157,107,255,0.06) 1px, transparent 1px); background-size: 44px 44px; }
      .sale-flash { animation: saleflash 1.3s ease-out; }
      @keyframes saleflash { 0% { background: rgba(255,70,85,0.55); } 100% { background: rgba(255,70,85,0); } }
      .view-in { animation: viewin 0.4s ease; }
      @keyframes viewin { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .holo-sweep,.bid-pop,.animate-pulse,.idle-rotor,.reel-drift,.burst,.float-soft,.marquee,.sale-flash,.view-in { animation: none !important; } }
      /* Branded dropdowns — arrow + dark on-brand option list (all selects) */
      select { -webkit-appearance: none; -moz-appearance: none; appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1.5L6 6.5L11 1.5' stroke='%235b8dff' stroke-width='1.6' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat; background-position: right 12px center; padding-right: 32px !important;
        accent-color: #3d7bff; color-scheme: dark; cursor: pointer; }
      select:hover { border-color: rgba(111,160,255,0.6) !important; }
      select option { background: #0b0f1a !important; color: #ecf3ff !important; font-weight: 600;
        padding: 8px 10px; }
      select option:checked, select option:hover { background: #16233f !important; color: #7da6ff !important; }
      .nav-desktop { display: flex; }
      .nav-mobile-btn { display: none; }
      @media (max-width: 860px) {
        .nav-desktop { display: none !important; }
        .nav-mobile-btn { display: flex !important; }
      }
      @media (max-width: 640px) {
        .hero-cta { padding: 13px 26px !important; gap: 12px !important; letter-spacing: 0.22em !important; font-size: 0.82rem !important; }
      }
      .wr-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      @media (min-width: 680px) { .wr-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
      .wr-slider { -webkit-appearance: none; appearance: none; height: 8px; border-radius: 999px; outline: none; cursor: pointer;
        background: linear-gradient(90deg, var(--wr-hue) 0%, var(--wr-hue) var(--wr-pct), rgba(255,255,255,0.10) var(--wr-pct), rgba(255,255,255,0.10) 100%); }
      .wr-slider:disabled { cursor: default; }
      .wr-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 20px; height: 20px; border-radius: 50%;
        background: #ecf3ff; border: 3px solid var(--wr-hue); box-shadow: 0 0 10px var(--wr-hue), 0 2px 6px rgba(0,0,0,0.5); transition: transform 120ms; }
      .wr-slider::-webkit-slider-thumb:hover { transform: scale(1.18); }
      .wr-slider::-moz-range-thumb { width: 20px; height: 20px; border-radius: 50%; background: #ecf3ff; border: 3px solid var(--wr-hue); box-shadow: 0 0 10px var(--wr-hue); }
      .wr-slider::-moz-range-track { height: 8px; border-radius: 999px; background: transparent; }
      ::-webkit-scrollbar { width: 8px; height: 8px; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
    `}</style>
  );

  const shell = (children) => (
    <div className="min-h-screen volt-shell-box" style={{ color: "#ecf3ff", fontFamily: "'Space Grotesk',sans-serif", background: "#0a0d18", overflowX: "hidden", paddingLeft: isDesk ? (railWide ? 224 : 60) : 0, transition: "padding-left .18s cubic-bezier(.2,.8,.3,1)", containerType: "inline-size" }}>
      {fonts}
      <div className="fixed inset-0 pointer-events-none" style={{ background: "radial-gradient(ellipse 60% 40% at 50% -5%, rgba(61,123,255,0.10), transparent 60%), radial-gradient(ellipse 45% 35% at 100% 100%, rgba(61,123,255,0.08), transparent 60%), radial-gradient(ellipse 45% 35% at 0% 100%, rgba(0,229,255,0.06), transparent 60%)" }} />
      <div className="relative min-h-screen">
        {children}
      </div>
    </div>
  );

  if (!identity) return shell(<>
    {chrome && (
      <div className="vg-shell flex items-center justify-between px-5 py-3" style={{ borderBottom: "1px solid rgba(61,123,255,0.18)", fontFamily: "'Rajdhani',sans-serif" }}>
        <button onClick={chrome.onBack} style={shellBtn("ghost", { padding: "8px 14px" })}>‹ {chrome.backLabel}</button>
        {chrome.account && <AccountChip account={chrome.account} onSignOut={chrome.onSignOut} />}
      </div>
    )}
    <RoleGate teams={state.teams} onPick={setIdentity} auth={auth} />
  </>);

  // Staff keep their admin powers even while holding a captain's seat — the two
  // are independent. Only an explicit choice to spectate stands them down.
  const isStaffRole = auth?.role === "host" || auth?.role === "moderator";
  const isAdmin = isStaffRole ? identity !== "spectator" : identity === "admin";
  // Moderators share the admin identity but not the live auction. window.__VOLT
  // .isHost is strictly the league owner; it is undefined in the no-Supabase
  // preview, so treat undefined as allowed there.
  const isOwner = window.__VOLT?.isHost !== false;
  const canRunAuction = isAdmin && isOwner;
  const isSpectator = identity === "spectator";
  const myTeam = state.teams.find((t) => t.id === identity) || null;  // "admin"/"spectator" match nothing
  const block = state.block;
  const blockPlayer = block ? state.players.find((p) => p.id === block.playerId) : null;
  const leaderTeam = block?.leaderId ? state.teams.find((t) => t.id === block.leaderId) : null;
  // Draftable pool only — captains sit in state.players so they stay scoutable,
  // but they can never be nominated or bought, so they must not count toward
  // the draw, the wheel, or the bid-ceiling reserve. Mirrors spinNominate.
  // The auction wheel: draft-eligible, unsold, not a captain. A late sign-up is
  // in the league and subbable but was never in the draft, so it must not appear
  // on the wheel or in the bid-ceiling reserve maths.
  const pool = state.players.filter((p) => p.status === "pool" && !p.isCaptain && p.poolEligible !== false);
  const sold = state.players.filter((p) => p.status === "sold").sort((a, b) => b.soldPrice - a.soldPrice);
  const spinLive = state.spin && Date.now() < state.spin.startTs + state.spin.duration + REVEAL_MS;
  const teamOf = (id) => state.teams.find((t) => t.id === id);

  // ── Lobby data: what's next, and where everyone stands ──────────────────
  // Both derive from the board that's already loaded, so the Lobby costs no
  // extra network. Byes (teamB null) are skipped — they aren't matches anyone
  // turns up for.
  const allMatches = flattenMatches(state.tournament);
  const upcoming = allMatches
    .filter((m) => !m.done && m.teamA != null && m.teamB != null)
    .sort((a, b) => {
      const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : Infinity;
      const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : Infinity;
      return ta - tb; // unscheduled fixtures sink below scheduled ones
    })
    .slice(0, 3);
  const standings = state.tournament
    ? computeStandings(state.tournament.teamIds || state.teams.map((t) => t.id), allMatches, state.tournament.overrides).slice(0, 4)
    : [];
  const fmtKickoff = (iso) => {
    if (!iso) return "TBD";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return "TBD";
    return d.toLocaleDateString(undefined, { weekday: "short" }) + " " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  // Applications waiting on the host. Players are always sent 0, so the same
  // Registration button serves both roles — it just grows a badge for the host.
  const pendingReview = chrome?.pendingCount || 0;

  // Current view name for the bar (rail may be collapsed to glyphs).
  const viewLabel = view === "account" ? "My Account" : view === "profile" ? "Player File" : view === "report" ? "Report Match" : ([...NAV, ...TOURNEY_NAV].find(n => n.id === view)?.label || "");
  const draftMs = chrome?.draftAt ? new Date(chrome.draftAt).getTime() - nowTick : -1;
  const draftIn = draftMs > 0 ? (() => {
    const m = Math.floor(draftMs / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
    return d > 0 ? `${d}D ${h}H` : h > 0 ? `${h}H ${String(mm).padStart(2, "0")}M` : `${mm}M`;
  })() : null;

  // Seat identity folded into the account chip — no separate pill.
  // Your seat wins the chip: a host who captains a team wants their budget and
  // open slots at a glance during the auction, not a badge telling them they're
  // the host — the Manage controls already make that obvious.
  const chipSeat = myTeam
    ? { label: myTeam.name, color: myTeam.hue, sub: `${fmt(myTeam.budget)} · ${emptySlots(myTeam)} slots open${isAdmin ? " · host" : ""}` }
    : isAdmin ? { label: "Host", color: "#3d7bff" }
    : isSpectator ? { label: "Spectator", color: "#7da6ff", sub: "View only · bidding disabled" }
    : null;

  /* ── desktop rail — persistent primary nav, collapsible ↔ wide ── */
  const railSections = [
    { title: "League", items: NAV },
    { title: "Tournament", items: TOURNEY_NAV },
  ].map(s => ({ ...s, items: s.items.filter(n => !n.adminOnly || isAdmin) })).filter(s => s.items.length);
  const RAIL_W = railWide ? 224 : 60;
  const railItem = (key, glyph, label, { active = false, liveDot = false, onClick, color } = {}) => (
    <button key={key} onClick={onClick} className="volt-rail-item flex items-center" aria-label={label}
      onMouseEnter={e => { if (!railWide) setRailTip({ label, y: e.currentTarget.getBoundingClientRect().top + e.currentTarget.getBoundingClientRect().height / 2 }); }}
      onMouseLeave={() => setRailTip(null)}
      style={{ width: railWide ? RAIL_W - 16 : 44, height: 42, justifyContent: railWide ? "flex-start" : "center", gap: 10, paddingLeft: railWide ? 12 : 0, paddingRight: railWide ? 10 : 0,
        background: active ? "linear-gradient(90deg, rgba(61,123,255,0.2), rgba(61,123,255,0.04))" : "transparent",
        clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))",
        borderLeft: active ? "2px solid #3d7bff" : "2px solid transparent" }}>
      <span className="volt-rail-glyph" style={{ fontSize: 17, color: active ? "#3d7bff" : color || "rgba(200,215,255,0.5)", textShadow: active ? "0 0 10px rgba(61,123,255,0.7)" : "none", transition: "color .12s", position: "relative" }}>
        {glyph}
        {liveDot && !railWide && <span className="animate-pulse" style={{ position: "absolute", top: -3, right: -6, width: 7, height: 7, borderRadius: "50%", background: "#ff4655", boxShadow: "0 0 8px rgba(255,70,85,0.8)" }} />}
      </span>
      {railWide && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", color: active ? "#eaf1ff" : "rgba(200,215,255,0.72)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>}
      {liveDot && railWide && <span className="ml-auto animate-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff4655", boxShadow: "0 0 8px rgba(255,70,85,0.8)" }} />}
    </button>
  );
  const Rail = isDesk && createPortal(<>
    <nav aria-label="Primary" style={{ position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 40, width: RAIL_W, display: "flex", flexDirection: "column", alignItems: railWide ? "stretch" : "center", padding: railWide ? "12px 8px 14px" : "12px 0 14px", background: "linear-gradient(180deg, rgba(12,17,30,0.98), rgba(7,10,18,0.98))", borderRight: "1px solid rgba(61,123,255,0.22)", fontFamily: "'Rajdhani',sans-serif", transition: "width .18s cubic-bezier(.2,.8,.3,1)", overflowY: "auto", overflowX: "hidden" }}>
      <style>{`
        .volt-expand-btn { transition: background .15s, border-color .15s, transform .15s; }
        .volt-expand-btn:hover { background: rgba(61,123,255,0.3); border-color: #6fa0ff; transform: scale(1.08); }
        .volt-expand-btn { animation: voltExpandHint 2.4s ease-in-out 3; }
        @keyframes voltExpandHint {
          0%, 100% { box-shadow: 0 0 0 0 rgba(61,123,255,0); }
          50%      { box-shadow: 0 0 0 4px rgba(61,123,255,0.22); }
        }
        @media (prefers-reduced-motion: reduce) { .volt-expand-btn { animation: none; } }

        .volt-rail-item { position: relative; }
        .volt-rail-item:hover .volt-rail-glyph { color: #eaf1ff !important; }
        @keyframes voltTipIn { from { opacity: 0; transform: translateY(-50%) translateX(-8px); } to { opacity: 1; transform: translateY(-50%) translateX(0); } }
      `}</style>
      {/* league mark + collapse toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: railWide ? "space-between" : "center", gap: 8, marginBottom: 4, paddingLeft: railWide ? 4 : 0 }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <span className="grid place-items-center shrink-0" style={{ width: 42, height: 42, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: "#3d7bff", textShadow: "0 0 12px rgba(61,123,255,0.8)" }}>{(window.__VOLT.communityName || "V").slice(0, 1).toUpperCase()}</span>
          </span>
          {railWide && <span style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#3d7bff", textShadow: "0 0 14px rgba(61,123,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{window.__VOLT.communityName || "VOLT"}</span>}
        </div>
        {railWide && (
          <button onClick={() => setRailWide(false)} aria-label="Collapse navigation" title="Collapse"
            style={{ width: 26, height: 26, display: "grid", placeItems: "center", color: "rgba(200,215,255,0.55)", border: "1px solid rgba(120,150,220,0.25)", background: "rgba(255,255,255,0.03)", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))", fontSize: 12 }}>«</button>
        )}
      </div>
      {!railWide && (
        <button onClick={() => setRailWide(true)} aria-label="Expand navigation" title="Expand menu"
          className="volt-expand-btn grid place-items-center"
          onMouseEnter={e => setRailTip({ label: "Expand menu", y: e.currentTarget.getBoundingClientRect().top + 15 })}
          onMouseLeave={() => setRailTip(null)}
          style={{ width: 34, height: 30, margin: "2px auto 0", cursor: "pointer",
            color: "#9dc0ff", background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)",
            clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}>
          <span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>»</span>
        </button>
      )}
      <div style={{ width: railWide ? "auto" : 26, height: 1, margin: railWide ? "8px 6px 10px" : "8px auto 10px", background: "rgba(61,123,255,0.35)" }} />
      {/* the portal/registration entry now lives in the top bar */}
      {railSections.map((sec, si) => (
        <div key={sec.title} style={{ display: "flex", flexDirection: "column", alignItems: railWide ? "stretch" : "center", gap: 2 }}>
          {si > 0 && <div style={{ width: railWide ? "auto" : 26, height: 1, margin: railWide ? "8px 6px" : "8px auto", background: "rgba(120,150,220,0.2)" }} />}
          {railWide && <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700, padding: "2px 12px 6px" }}>// {sec.title}</div>}
          {sec.items.map(nav => railItem(nav.id, nav.glyph, nav.label, { active: view === nav.id, liveDot: nav.id === "block" && (block || spinLive), onClick: () => setView(nav.id) }))}
        </div>
      ))}
      <div style={{ marginTop: "auto" }} />
      {chrome?.account && railItem("__account", "◉", "My Account", { active: view === "account", onClick: () => setView("account") })}
      <button data-snd="off" data-nohover="1" onClick={() => setSoundOn(v => !v)} className="volt-rail-item flex items-center" aria-label={soundOn ? "Mute sound" : "Unmute sound"}
        onMouseEnter={e => { if (!railWide) setRailTip({ label: soundOn ? "Sound on" : "Sound off", y: e.currentTarget.getBoundingClientRect().top + 20 }); }}
        onMouseLeave={() => setRailTip(null)}
        style={{ width: railWide ? RAIL_W - 16 : 42, height: 40, justifyContent: railWide ? "flex-start" : "center", gap: 10, paddingLeft: railWide ? 12 : 0, color: soundOn ? "#7da6ff" : "rgba(180,195,225,0.4)", margin: railWide ? 0 : "0 auto" }}>
        <span style={{ fontSize: 15 }}>{soundOn ? "🔊" : "🔇"}</span>
        {railWide && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase" }}>{soundOn ? "Sound on" : "Sound off"}</span>}
      </button>
    </nav>
    {!railWide && railTip && (
      <div style={{ position: "fixed", left: RAIL_W + 12, top: railTip.y, transform: "translateY(-50%)", zIndex: 46, pointerEvents: "none",
        padding: "6px 13px", whiteSpace: "nowrap", fontFamily: "'Rajdhani',sans-serif", fontSize: 11.5, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "#eaf1ff",
        background: "linear-gradient(160deg, rgba(16,23,40,0.98), rgba(9,13,23,0.98))", border: "1px solid rgba(61,123,255,0.45)",
        clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))",
        boxShadow: "0 0 24px rgba(61,123,255,0.18), 8px 8px 30px rgba(0,0,0,0.5)",
        animation: "voltTipIn .16s cubic-bezier(.2,.8,.3,1)" }}>
        <span style={{ position: "absolute", left: 0, top: 0, width: 7, height: 7, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
        <span style={{ color: "#3d7bff", marginRight: 6 }}>//</span>{railTip.label}
      </div>
    )}
  </>, document.body);

  /* ── top nav (transparent, hero-themed) ── */
  const TopNav = (
    <header className="sticky top-0 z-30" style={{ background: "rgba(6,9,16,0.94)", borderBottom: "1px solid rgba(61,123,255,0.14)", backdropFilter: "blur(12px)" }}>
      <div className="page-wrap flex items-center gap-4 py-3.5 flex-wrap" style={{ fontFamily: "'Rajdhani',sans-serif" }}>
        {/* mobile: hamburger opens the floating drawer; desktop uses the rail */}
        {!isDesk && (
          <button onClick={() => setDrawerOpen(true)} aria-label="Open navigation"
            className="shrink-0 grid place-items-center transition-all hover:scale-105"
            style={{ width: 42, height: 38, clipPath: SHELL_NOTCH(9), background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.45)" }}>
            <span className="flex flex-col gap-1">
              <span style={{ width: 16, height: 2, background: "#7da6ff" }} />
              <span style={{ width: 16, height: 2, background: "#7da6ff" }} />
              <span style={{ width: 16, height: 2, background: "#7da6ff" }} />
            </span>
          </button>
        )}
        {/* context — tournament · phase · view, one consistent breadcrumb line */}
        <div className="flex items-center gap-3 min-w-0 shrink">
          {/* tournament date — the anchor, in its own notched HUD frame */}
          <div className="flex items-center gap-2.5 shrink-0"
            style={{ height: 36, padding: "0 14px", clipPath: SHELL_NOTCH(9), background: "linear-gradient(180deg, rgba(61,123,255,0.12), rgba(61,123,255,0.04))", border: "1px solid rgba(61,123,255,0.4)" }}>
            {chrome?.phaseTag && <span title={chrome.phaseTag} style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: chrome.phaseColor || "#5b8dff", boxShadow: `0 0 9px ${chrome.phaseColor || "#5b8dff"}` }} />}
            <span style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#eaf1ff", whiteSpace: "nowrap", textShadow: "0 0 12px rgba(61,123,255,0.35)" }}>{window.__VOLT.weekendLabel || "Draft"}</span>
            {chrome?.phaseTag && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: chrome.phaseColor || "#5b8dff", whiteSpace: "nowrap", paddingLeft: 9, marginLeft: 2, borderLeft: "1px solid rgba(120,150,220,0.25)" }}>{chrome.phaseTag}</span>}
          </div>
          {/* current view — quiet trail, clearly secondary */}
          {viewLabel && (
            <span className="hidden sm:inline" style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(160,185,235,0.5)", whiteSpace: "nowrap" }}>{viewLabel}</span>
          )}
        </div>

        <div className="flex-1 min-w-0" />

        {/* right cluster — one flat row, unified pill sizing, no corner brackets */}
        <div className="flex items-center gap-2.5 shrink-0">
          {draftIn && (
            <div className="hidden sm:flex items-center gap-2" title={new Date(chrome.draftAt).toLocaleString()}
              style={{ height: 36, padding: "0 14px", clipPath: SHELL_NOTCH(9), background: "rgba(245,196,83,0.09)", border: "1px solid rgba(245,196,83,0.42)" }}>
              <span className="animate-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#f5c453", boxShadow: "0 0 8px rgba(245,196,83,0.8)" }} />
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.16em", textTransform: "uppercase", color: "rgba(245,196,83,0.8)" }}>Draft</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, fontWeight: 700, color: "#ffe4a0" }}>{draftIn}</span>
            </div>
          )}
          {chrome?.onReport && (
            <button onClick={() => {
                // With fixtures built, land on the fixture list rather than a blank
                // form: reporting from a fixture pre-fills both teams, the label and
                // the winner, and shows which matches still need stats. The blank
                // form is only the right answer when there's no bracket to pick from.
                if (state.tournament && flattenMatches(state.tournament).length) setView("bracket");
                else chrome.onReport();
              }}
              title={state.tournament && flattenMatches(state.tournament).length ? "Pick the match to report" : "Report a match"}
              style={{ height: 36, padding: "0 15px", clipPath: SHELL_NOTCH(9), display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", background: "rgba(61,220,132,0.1)", border: "1px solid rgba(61,220,132,0.45)", color: "#9af5c2", textShadow: "0 0 10px rgba(61,220,132,0.4)", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>▦ Report</button>
          )}
          {/* portal — back out to Registration (or the league hub). One button for
              both roles: for a host with applications waiting it carries the count,
              which is why there's no separate Approvals control. */}
          {chrome?.onBack && (
            <button onClick={chrome.onBack}
              title={pendingReview > 0 ? `${pendingReview} application${pendingReview === 1 ? "" : "s"} awaiting review` : (chrome.portalLabel || "League hub")}
              style={{ height: 36, padding: "0 13px", clipPath: SHELL_NOTCH(9), display: "inline-flex", alignItems: "center", gap: 8, flex: "0 0 auto", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif",
                background: pendingReview > 0 ? "rgba(245,196,83,0.12)" : "rgba(61,123,255,0.09)",
                border: `1px solid ${pendingReview > 0 ? "rgba(245,196,83,0.5)" : "rgba(61,123,255,0.35)"}`,
                color: pendingReview > 0 ? "#ffe4a0" : "#9dc0ff" }}>
              {pendingReview > 0
                ? <span className="animate-pulse" style={{ width: 6, height: 6, borderRadius: "50%", background: "#f5c453", boxShadow: "0 0 8px rgba(245,196,83,0.8)" }} />
                : <span style={{ fontSize: 14, lineHeight: 1 }}>⊞</span>}
              <span className="hidden sm:inline" style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{chrome.portalLabel || "League hub"}</span>
              {pendingReview > 0 && (
                <span style={{ minWidth: 18, height: 18, padding: "0 5px", display: "grid", placeItems: "center", background: "#f5c453", color: "#0a0d18", fontSize: 10.5, fontWeight: 700, borderRadius: 9, fontFamily: "'IBM Plex Mono',monospace" }}>{pendingReview}</span>
              )}
            </button>
          )}
          {chrome && HAS_SUPABASE && <NotifBell />}
          {chrome?.hostControls && <HostMenu>{chrome.hostControls}</HostMenu>}
          {chrome?.account && <AccountChip account={chrome.account} onSignOut={chrome.onSignOut} onProfile={() => setView("account")} seat={chipSeat} />}
          {!chrome && (
            <button data-snd="off" data-nohover="1" onClick={() => setSoundOn((v) => !v)} aria-label={soundOn ? "Mute sound" : "Unmute sound"}
              className="grid place-items-center transition-all hover:scale-110" style={{ width: 36, height: 36, clipPath: SHELL_NOTCH(9), background: soundOn ? "rgba(61,123,255,0.12)" : "rgba(120,140,180,0.06)", border: `1px solid ${soundOn ? "rgba(61,123,255,0.5)" : "rgba(120,140,180,0.3)"}`, color: soundOn ? "#7da6ff" : "rgba(180,195,225,0.5)", fontSize: 15 }}>
              {soundOn ? "🔊" : "🔇"}
            </button>
          )}
        </div>
      </div>

      {/* ── side drawer — floating HUD panel, portaled to <body> because the
             sticky header's backdrop-filter traps fixed descendants ── */}
      {drawerOpen && createPortal(<>
        <style>{`
          @keyframes voltDrawerIn { from { transform: translateX(-24px); opacity: 0; } to { transform: translateX(0); opacity: 1; } }
          @keyframes voltFadeIn { from { opacity: 0; } to { opacity: 1; } }
          .volt-drawer-item { transition: background .15s ease, color .15s ease, padding-left .15s ease; }
          .volt-drawer-item:hover { background: rgba(61,123,255,0.1) !important; color: #eaf1ff !important; padding-left: 16px !important; }
        `}</style>
        <div onClick={() => setDrawerOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 95, background: "rgba(3,5,10,0.65)", backdropFilter: "blur(3px)", animation: "voltFadeIn .18s ease" }} />
        <aside style={{ position: "fixed", left: 16, top: 16, maxHeight: "calc(100vh - 32px)", zIndex: 96, width: 288, display: "flex", flexDirection: "column",
          background: "linear-gradient(165deg, rgba(16,23,42,0.97), rgba(8,11,20,0.97))",
          border: "1px solid rgba(61,123,255,0.4)",
          clipPath: "polygon(0 0, calc(100% - 22px) 0, 100% 22px, 100% 100%, 22px 100%, 0 calc(100% - 22px))",
          boxShadow: "0 0 60px rgba(61,123,255,0.14), 24px 0 80px rgba(0,0,0,0.6)",
          padding: "20px 14px 16px", overflowY: "auto", fontFamily: "'Rajdhani',sans-serif",
          animation: "voltDrawerIn .22s cubic-bezier(.2,.8,.3,1)" }}>
          <span style={{ position: "absolute", left: 0, top: 0, width: 12, height: 12, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
          <span style={{ position: "absolute", right: 0, bottom: 0, width: 12, height: 12, borderRight: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />
          <div className="flex items-center justify-between" style={{ padding: "0 8px 6px" }}>
            <div>
              <div style={{ fontSize: 9, letterSpacing: "0.34em", textTransform: "uppercase", color: "rgba(120,150,220,0.6)", fontWeight: 700 }}>// VOLT LEAGUE</div>
              <div className="text-lg font-bold uppercase tracking-wide" style={{ color: "#3d7bff", textShadow: "0 0 16px rgba(61,123,255,0.65)" }}>{window.__VOLT.communityName || "VOLT"}</div>
            </div>
            <button onClick={() => setDrawerOpen(false)} aria-label="Close navigation"
              style={{ color: "rgba(200,215,255,0.6)", fontSize: 14, width: 30, height: 30, display: "grid", placeItems: "center", clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))", border: "1px solid rgba(120,150,220,0.25)", background: "rgba(255,255,255,0.03)" }}>✕</button>
          </div>
          {chrome && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px 0" }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: chrome.phaseColor || "#5b8dff", boxShadow: `0 0 8px ${chrome.phaseColor || "#5b8dff"}` }} />
              <span style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: "rgba(200,215,255,0.75)" }}>{window.__VOLT.weekendLabel || "Tournament"}</span>
              <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.14em", color: chrome.phaseColor || "#5b8dff" }}>· {chrome.phaseTag}</span>
            </div>
          )}
          <div style={{ height: 1, margin: "10px 6px 14px", background: "linear-gradient(90deg, rgba(61,123,255,0.5), transparent)" }} />
          {[{ title: "League", items: NAV }, { title: "Tournament", items: TOURNEY_NAV }].map(sec => {
            const items = sec.items.filter(n => !n.adminOnly || isAdmin);
            if (!items.length) return null;
            return (
              <div key={sec.title} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700, padding: "0 8px 7px" }}>// {sec.title}</div>
                {items.map(nav => {
                  const active = view === nav.id;
                  const live = nav.id === "block" && (block || spinLive);
                  return (
                    <button key={nav.id} onClick={() => { setView(nav.id); setDrawerOpen(false); }}
                      className="volt-drawer-item w-full flex items-center gap-3 py-2.5 text-left"
                      style={{ paddingLeft: 12, paddingRight: 12, background: active ? "linear-gradient(90deg, rgba(61,123,255,0.18), rgba(61,123,255,0.03))" : "transparent", color: active ? "#eaf1ff" : "rgba(200,215,255,0.72)", clipPath: "polygon(0 0, calc(100% - 9px) 0, 100% 9px, 100% 100%, 9px 100%, 0 calc(100% - 9px))", borderLeft: active ? "2px solid #3d7bff" : "2px solid transparent" }}>
                      <span className="text-base" style={{ color: active ? "#3d7bff" : "rgba(200,215,255,0.4)", textShadow: active ? "0 0 10px rgba(61,123,255,0.7)" : "none" }}>{nav.glyph}</span>
                      <span className="font-semibold uppercase tracking-[0.12em] text-sm">{nav.label}</span>
                      {live && <span className="ml-auto animate-pulse" style={{ width: 7, height: 7, borderRadius: "50%", background: "#ff4655", boxShadow: "0 0 8px rgba(255,70,85,0.8)" }} />}
                      {active && !live && <span className="ml-auto" style={{ fontSize: 9, letterSpacing: "0.2em", color: "#3d7bff", fontWeight: 700 }}>◂</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
          <div style={{ marginTop: "auto", borderTop: "1px solid rgba(120,150,220,0.15)", paddingTop: 12 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700, padding: "0 8px 7px" }}>// You</div>
            {chrome?.account && (
              <button onClick={() => { setView("account"); setDrawerOpen(false); }}
                className="volt-drawer-item w-full flex items-center gap-3 py-2.5 text-left"
                style={{ paddingLeft: 12, paddingRight: 12, background: view === "account" ? "linear-gradient(90deg, rgba(61,123,255,0.18), rgba(61,123,255,0.03))" : "transparent", color: view === "account" ? "#eaf1ff" : "rgba(200,215,255,0.72)", borderLeft: view === "account" ? "2px solid #3d7bff" : "2px solid transparent" }}>
                <span className="text-base" style={{ color: view === "account" ? "#3d7bff" : "rgba(200,215,255,0.4)" }}>◉</span>
                <span className="font-semibold uppercase tracking-[0.12em] text-sm">My Account</span>
              </button>
            )}
            {!auth?.userId && (
              <button onClick={() => { setDrawerOpen(false); setIdentity(null); }}
                className="volt-drawer-item w-full flex items-center gap-3 py-2.5 text-left" style={{ paddingLeft: 12, paddingRight: 12, color: "rgba(200,215,255,0.72)", borderLeft: "2px solid transparent" }}>
                <span className="text-base" style={{ color: "rgba(200,215,255,0.4)" }}>⇄</span>
                <span className="font-semibold uppercase tracking-[0.12em] text-sm">Switch Seat</span>
              </button>
            )}
            {!isDesk && (
              <button data-snd="off" data-nohover="1" onClick={() => setSoundOn(v => !v)}
                className="volt-drawer-item w-full flex items-center gap-3 py-2.5 text-left" style={{ paddingLeft: 12, paddingRight: 12, color: "rgba(200,215,255,0.72)", borderLeft: "2px solid transparent" }}>
                <span className="text-base" style={{ color: soundOn ? "#7da6ff" : "rgba(200,215,255,0.4)" }}>{soundOn ? "🔊" : "🔇"}</span>
                <span className="font-semibold uppercase tracking-[0.12em] text-sm">{soundOn ? "Sound on" : "Sound off"}</span>
              </button>
            )}
            {chrome && (
              <button onClick={() => { setDrawerOpen(false); chrome.onBack(); }}
                className="volt-drawer-item w-full flex items-center gap-3 py-2.5 text-left" style={{ paddingLeft: 12, paddingRight: 12, color: "#aec6ff", borderLeft: "2px solid transparent" }}>
                <span className="text-base" style={{ color: "#7da6ff" }}>⊞</span>
                <span className="font-semibold uppercase tracking-[0.12em] text-sm">{chrome.portalLabel || ("Back to " + chrome.backLabel)}</span>
              </button>
            )}
          </div>
        </aside>
      </>, document.body)}
    </header>
  );

  /* global ticker tape (lobby + reused) */
  // League headlines: results + match MVPs outrank auction chatter once matches exist.
  const leagueHeadlines = (() => {
    const out = [];
    const tt = state.tournament || {};
    // matches: array (league/rr) | object keyed by group | rounds[] (single elim)
    const allMs = [];
    if (Array.isArray(tt.matches)) allMs.push(...tt.matches);
    else if (tt.matches && typeof tt.matches === "object") Object.values(tt.matches).forEach(arr => Array.isArray(arr) && allMs.push(...arr));
    if (Array.isArray(tt.rounds)) tt.rounds.forEach(r => Array.isArray(r) && allMs.push(...r));
    if (tt.final) allMs.push(tt.final);
    allMs.filter(Boolean).forEach(m => {
      if (!m.done || m.teamB == null) return;
      const w = state.teams.find(x => x.id === m.winner), l = state.teams.find(x => x.id === (m.winner === m.teamA ? m.teamB : m.teamA));
      if (!w || !l) return;
      const maps = (m.maps || []).filter(x => x && x.a != null && x.b != null);
      const sc = maps.length ? ((m.bo || 1) === 1 ? `${maps[0].a}-${maps[0].b}` : `${maps.filter(x => Number(x.a) > Number(x.b)).length}-${maps.filter(x => Number(x.b) > Number(x.a)).length}`) : "";
      out.push(`${w.name} DEF. ${l.name}${sc ? " " + sc : ""}`.toUpperCase());
      const mvp = window.__VOLT?.reportedStats?.[fxLabel(state.teams.find(x => x.id === m.teamA), state.teams.find(x => x.id === m.teamB), m)];
      if (mvp) out.push(`⭐ ${mvp.name} DROPS ${mvp.pts} PTS`.toUpperCase());
    });
    return out.slice(-10);
  })();
  const tickerItems = leagueHeadlines.length
    ? leagueHeadlines
    : sold.length
      ? sold.map((p) => `${teamOf(p.soldTo)?.name ?? "?"} secured ${p.name} (${p.rank}) for ${fmt(p.soldPrice)}`)
      : ["No players sold yet — the board is wide open", "Spin the wheel to nominate the first name", `${state.teams.length} captains · $10,000 each · 4 slots to fill`];
  const TickerTape = (
    <div className="overflow-hidden py-2" style={{ borderTop: "1px solid rgba(61,123,255,0.18)", borderBottom: "1px solid rgba(61,123,255,0.18)", background: "linear-gradient(180deg, rgba(8,14,28,0.6), rgba(5,9,18,0.6))" }}>
      <div className="marquee">
        {[...tickerItems, ...tickerItems].map((t, i) => (
          <span key={i} className="mx-6 text-sm uppercase tracking-widest" style={{ fontFamily: "'Rajdhani',sans-serif", color: "rgba(200,215,255,0.6)" }}>
            <span style={{ color: "#3d7bff" }}>◆</span> {t}
          </span>
        ))}
      </div>
    </div>
  );

  /* ════════ VIEW: LOBBY ════════ */
  const LobbyView = (
    <div className="view-in">
      <div className="relative overflow-hidden volt-hero-bleed" style={{ height: "clamp(520px, 78vh, 900px)", background: "#05070e" }}>
        {/* Figma hero art (Neon + watermark baked in) */}
        <img src={IMG_HERO} alt="" className="absolute inset-0 w-full h-full" style={{ objectFit: "cover", objectPosition: "right 30%" }} />
        {/* left-side legibility scrim so live text stays crisp over the art */}
        <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(5,7,14,0.92) 0%, rgba(5,7,14,0.78) 30%, rgba(5,7,14,0.28) 50%, transparent 66%)" }} />

        {/* HUD rails + live text, all anchored inside the shared page-wrap inset so they align with the nav and cards */}
        <div className="page-wrap absolute inset-0">
          <div className="relative h-full">

            {/* live text + buttons — centered in the upper band, clear of the baked-in
                top rail (~12%) above and the status panel / bottom rail below */}
            <div className="absolute flex flex-col justify-center items-start text-left volt-hero-copy"
              style={{ left: "clamp(20px, 5%, 72px)", right: "auto", top: "17%", bottom: "16%", width: "min(820px, 64%)", maxWidth: "calc(100% - clamp(40px, 10%, 144px))" }}>
              <h1 className="font-bold uppercase volt-hero-title" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.4rem,7.5vw,9.4rem)", lineHeight: 0.82, letterSpacing: "0.04em", textShadow: "0 0 50px rgba(61,123,255,0.25)", overflowWrap: "break-word" }}>
                <span className="shine-text shine-white" style={{ animationDelay: "0s" }}>Initiation</span><br />
                <span className="shine-text shine-blue" style={{ animationDelay: "0s" }}>Protocol</span><br />
                <span className="shine-text shine-white" style={{ animationDelay: "0s" }}>// Draft</span>
              </h1>

              {/* DEFY THE LIMITS tagline */}
              <p className="uppercase mt-4" style={{ fontFamily: "'Rajdhani',sans-serif", fontWeight: 600, fontSize: "clamp(0.85rem,1.5vw,1.15rem)", letterSpacing: "0.5em", color: "#5b8dff", textShadow: "0 0 18px rgba(61,123,255,0.5)" }}>Defy the Limits</p>

              {/* ENTER AUCTION button — outlined HUD frame, only bottom-right notched,
                  with card-style corner brackets on the three square corners */}
              {(() => {
                // Registration open → the toggle IS the primary action (flipping it applies).
                if (chrome?.regToggle) {
                  return (
                    <div className="mt-7" style={{ maxWidth: 380, padding: "18px 20px", background: "linear-gradient(180deg, rgba(13,22,42,0.72), rgba(7,13,24,0.6))", border: "1px solid rgba(61,220,132,0.4)", clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 16px), calc(100% - 16px) 100%, 0 100%)", backdropFilter: "blur(3px)", boxShadow: "0 0 26px rgba(61,220,132,0.12)" }}>
                      <div style={{ fontSize: "0.72rem", letterSpacing: "0.3em", textTransform: "uppercase", color: "#3ddc84", fontWeight: 700, marginBottom: 12, fontFamily: "'Rajdhani',sans-serif" }}>// Registration open</div>
                      {chrome.regToggle}
                    </div>
                  );
                }
                const cta = identity === "admin"
                  ? { label: "Run the Draft", view: "block" }
                  : (identity && identity !== "spectator")
                    ? { label: "Enter Auction", view: "block" }
                    : { label: "Watch the Draft", view: "block" };
                return (
                  <div className="mt-7">
                    <button onClick={() => setView(cta.view)} className="ea-btn hero-cta relative group"
                      style={{
                        display: "inline-flex", alignItems: "center", gap: 18,
                        padding: "18px 44px",
                        fontFamily: "'Rajdhani',sans-serif", fontWeight: 700,
                        fontSize: "clamp(0.85rem,1.3vw,1.05rem)", letterSpacing: "0.34em",
                        textTransform: "uppercase", color: "#cfe0ff",
                        background: "linear-gradient(180deg, rgba(13,22,42,0.55), rgba(7,13,24,0.45))",
                        border: "1px solid rgba(61,123,255,0.5)",
                        clipPath: "polygon(0 0, 100% 0, 100% calc(100% - 18px), calc(100% - 18px) 100%, 0 100%)",
                        backdropFilter: "blur(2px)",
                        boxShadow: "0 0 24px rgba(61,123,255,0.18), inset 0 0 18px rgba(61,123,255,0.06)",
                      }}>
                      <span className="absolute left-0 top-0" style={{ width: 12, height: 12, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                      <span className="absolute right-0 top-0" style={{ width: 12, height: 12, borderRight: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                      <span className="absolute left-0 bottom-0" style={{ width: 12, height: 12, borderLeft: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />
                      <span>{cta.label}</span>
                      <span className="ea-arrow" style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 400, fontSize: "1.15em" }}>→</span>
                    </button>
                    {/* your locked-in status for THIS live tournament — the registration decision is already closed */}
                    <div className="mt-4" style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "0.9rem", letterSpacing: "0.04em" }}>
                      {identity === "admin"
                        ? <span style={{ color: "#7da6ff" }}>◈ You're running this tournament as host.</span>
                        : (identity && identity !== "spectator")
                          ? <span style={{ color: "#3ddc84" }}>✓ You're a captain this tournament — {(state.teams.find(t => t.id === identity)?.name) || "your squad"}.</span>
                          : <span style={{ color: "rgba(200,215,255,0.6)" }}>● You're spectating this tournament's draft.</span>}
                    </div>
                  </div>
                );
              })()}
            </div>

            {/* command-center system status — bottom-RIGHT corner, framed with its own
                HUD brackets; keeps the left column (headline + CTA) completely clear */}
            <div className="hidden md:block absolute select-none" style={{ right: 0, bottom: "12%", width: 272, zIndex: 5 }}>
              <div
                className="relative px-5 py-4"
                style={{
                  background: "linear-gradient(180deg, rgba(11,16,28,0.82), rgba(8,11,20,0.62))",
                  border: "1px solid rgba(61,123,255,0.28)",
                  clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))",
                  backdropFilter: "blur(4px)",
                  boxShadow: "0 8px 40px rgba(0,0,0,0.45)",
                }}
              >
                {/* full corner bracket frame */}
                <span className="absolute left-0 top-0" style={{ width: 16, height: 16, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                <span className="absolute right-0 top-0" style={{ width: 16, height: 16, borderRight: "2px solid rgba(61,123,255,0.55)", borderTop: "2px solid rgba(61,123,255,0.55)" }} />
                <span className="absolute left-0 bottom-0" style={{ width: 16, height: 16, borderLeft: "2px solid rgba(61,123,255,0.55)", borderBottom: "2px solid rgba(61,123,255,0.55)" }} />
                <span className="absolute right-0 bottom-0" style={{ width: 16, height: 16, borderRight: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />

                <div className="flex items-center gap-2 mb-1">
                  <span style={{ width: 6, height: 6, background: "#3ddc84", boxShadow: "0 0 8px #3ddc84", borderRadius: 1 }} />
                  <p className="uppercase text-xs" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, letterSpacing: "0.34em" }}>System Status</p>
                </div>
                <div className="mb-3" style={{ height: 1, background: "linear-gradient(90deg, rgba(61,123,255,0.5), transparent)" }} />

                {/* total players on the board */}
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="uppercase text-xs" style={{ color: "rgba(220,230,255,0.5)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.12em", whiteSpace: "nowrap" }}>Total Players</span>
                  <span className="text-sm font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#3ddc84", letterSpacing: "0.04em" }}>{state.players.length}</span>
                </div>

                {/* devices live — real-time presence */}
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="uppercase text-xs" style={{ color: "rgba(220,230,255,0.5)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.12em", whiteSpace: "nowrap" }}>Devices Live</span>
                  <span className="flex items-center gap-1.5">
                    <span className="cd-pulse" style={{ width: 5, height: 5, borderRadius: "50%", background: "#3ddc84", color: "#3ddc84" }} />
                    <span className="text-sm font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#3ddc84", letterSpacing: "0.04em" }}>{liveCount}</span>
                  </span>
                </div>

                {/* sync — makes a dead websocket visible instead of silent */}
                <div className="flex items-baseline justify-between gap-3 py-1">
                  <span className="uppercase text-xs" style={{ color: "rgba(220,230,255,0.5)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.12em", whiteSpace: "nowrap" }}>Sync</span>
                  <span className="text-sm font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: liveSync ? "#3ddc84" : "#f5c453", letterSpacing: "0.04em" }}>
                    {liveSync ? "Live" : "Polling"}
                  </span>
                </div>

                {/* auction phase — live countdown */}
                <div className="mt-2 pt-3" style={{ borderTop: "1px solid rgba(61,123,255,0.16)" }}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="uppercase text-xs" style={{ color: "rgba(220,230,255,0.5)", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.12em" }}>Auction Phase</span>
                    <span className="flex items-center gap-1 ml-auto">
                      <span className="cd-pulse" style={{ width: 5, height: 5, borderRadius: "50%", background: !hasDraftTime ? "rgba(200,215,255,0.35)" : cd.live ? "#3ddc84" : "#3d7bff", color: !hasDraftTime ? "rgba(200,215,255,0.35)" : cd.live ? "#3ddc84" : "#3d7bff" }} />
                      <span className="uppercase" style={{ fontSize: 9, letterSpacing: "0.18em", color: !hasDraftTime ? "rgba(200,215,255,0.45)" : cd.live ? "#3ddc84" : "#5b8dff", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>{!hasDraftTime ? "Not scheduled" : cd.live ? "Live" : "Starts in"}</span>
                    </span>
                  </div>

                  {!hasDraftTime ? (
                    <div style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: "0.95rem", lineHeight: 1.5, color: "rgba(200,215,255,0.5)" }}>
                      No auction time set yet.{isAdmin ? " Set one in Manage." : " Your host will announce it."}
                    </div>
                  ) : cd.live ? (
                    <div className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "1.9rem", lineHeight: 1, letterSpacing: "0.04em", color: "#3ddc84", textShadow: "0 0 18px rgba(61,220,132,0.45)" }}>
                      Underway
                    </div>
                  ) : (
                    <div className="flex items-end gap-1" style={{ fontFamily: "'IBM Plex Mono',monospace" }}>
                      {(cd.d > 0
                        ? [["D", cd.d], ["H", cd.h], ["M", cd.m]]
                        : [["H", cd.h], ["M", cd.m], ["S", cd.s]]
                      ).map(([unit, val], i, arr) => (
                        <span key={unit} className="flex items-end">
                          <span className="flex flex-col items-center">
                            <span style={{ fontSize: "2rem", lineHeight: 0.95, fontWeight: 700, color: "#eaf2ff", textShadow: "0 0 16px rgba(61,123,255,0.55)", letterSpacing: "0.01em" }}>
                              {String(val).padStart(2, "0")}
                            </span>
                            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.22em", color: "rgba(170,198,255,0.92)", marginTop: 4, fontFamily: "'Rajdhani',sans-serif" }}>{unit}</span>
                          </span>
                          {i < arr.length - 1 && (
                            <span style={{ fontSize: "1.7rem", lineHeight: 0.95, color: "rgba(61,123,255,0.55)", margin: "0 3px", alignSelf: "flex-start" }}>:</span>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {TickerTape}

      {/* what's next + where everyone stands — both self-hiding until the
          tournament actually has a tournament built, so the Lobby stays clean
          through registration and the auction. */}
      {(upcoming.length > 0 || standings.length > 0) && (
        <div className="page-wrap pt-8">
          <div className="grid lg:grid-cols-2 gap-4">

            {upcoming.length > 0 && (
              <div className="relative p-5" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.07), rgba(10,15,28,0.5))", border: "1px solid rgba(61,123,255,0.22)", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", backdropFilter: "blur(10px)" }}>
                <span className="absolute left-0 top-0" style={{ width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                <div className="flex items-center justify-between gap-3 mb-3">
                  <p className="uppercase text-xs font-bold" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.28em" }}>Upcoming Matches</p>
                  <button onClick={() => setView("bracket")} className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>All →</button>
                </div>
                <div className="flex flex-col gap-2">
                  {upcoming.map((m, i) => { const A = teamOf(m.teamA), B = teamOf(m.teamB); return (
                    <div key={m.id ?? i} className="flex items-center gap-3 py-2" style={{ borderTop: i ? "1px solid rgba(61,123,255,0.14)" : "none" }}>
                      <span className="text-xs shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(200,215,255,0.45)", minWidth: 58 }}>{fmtKickoff(m.scheduledAt)}</span>
                      <span className="font-bold uppercase truncate text-sm" style={{ fontFamily: "'Rajdhani',sans-serif", color: A?.hue || "#ecf3ff" }}>{A?.name || "TBD"}</span>
                      <span className="text-xs shrink-0" style={{ color: "rgba(200,215,255,0.35)", fontFamily: "'IBM Plex Mono',monospace" }}>vs</span>
                      <span className="font-bold uppercase truncate text-sm" style={{ fontFamily: "'Rajdhani',sans-serif", color: B?.hue || "#ecf3ff" }}>{B?.name || "TBD"}</span>
                    </div>
                  ); })}
                </div>
              </div>
            )}

            {standings.length > 0 && (
              <div className="relative p-5" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.07), rgba(10,15,28,0.5))", border: "1px solid rgba(61,123,255,0.22)", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", backdropFilter: "blur(10px)" }}>
                <span className="absolute left-0 top-0" style={{ width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
                <div className="flex items-center justify-between gap-3 mb-3">
                  <p className="uppercase text-xs font-bold" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.28em" }}>Standings</p>
                  <button onClick={() => setView("bracket")} className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>Full table →</button>
                </div>
                <div className="flex flex-col">
                  {standings.map((r, i) => { const t = teamOf(r.teamId); return (
                    <div key={r.teamId} className="flex items-center gap-3 py-2" style={{ borderTop: i ? "1px solid rgba(61,123,255,0.14)" : "none" }}>
                      <span className="text-xs shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: i === 0 ? "#f5c453" : "rgba(200,215,255,0.4)", width: 16 }}>{i + 1}</span>
                      <span className="font-bold uppercase truncate text-sm flex-1" style={{ fontFamily: "'Rajdhani',sans-serif", color: t?.hue || "#ecf3ff" }}>{t?.name || "—"}</span>
                      <span className="text-xs shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(200,215,255,0.5)" }}>{r.won}–{r.lost}</span>
                      <span className="text-sm font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#3ddc84", minWidth: 26, textAlign: "right" }}>{r.pts}</span>
                    </div>
                  ); })}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* rule summary */}
      <div className="page-wrap py-8">
        <div className="grid md:grid-cols-3 gap-4">
        {[
          { t: "The Budget", b: "$10,000 per team, 4 slots to fill. Captains are already seated." },
          { t: "The Wheel", b: "No hand-picking — the host spins and a random name hits the block." },
          { t: "The Bidding", b: "Bids rise in $100 steps. Your ceiling adjusts live so you can always fill your slots." },
        ].map((r, i) => (
          <div key={i} className="relative p-5" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.07), rgba(10,15,28,0.5))", border: "1px solid rgba(61,123,255,0.22)", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))", backdropFilter: "blur(10px)" }}>
            <span className="absolute left-0 top-0" style={{ width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
            <div className="flex items-center gap-2 mb-2">
              <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: "rgba(61,123,255,0.16)", color: "#7da6ff", fontFamily: "'IBM Plex Mono',monospace" }}>{String(i + 1).padStart(2, "0")}</span>
              <h3 className="font-bold uppercase tracking-wide" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{r.t}</h3>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "rgba(220,230,255,0.62)" }}>{r.b}</p>
          </div>
        ))}
        </div>
      </div>

      {/* top sales strip */}
      {sold.length > 0 && (
        <div className="page-wrap pb-10">
          <p className="text-xs uppercase tracking-widest mb-3" style={{ color: "#7da6ff" }}>Biggest signings so far</p>
          <div className="flex gap-3 overflow-x-auto pb-2">
            {sold.slice(0, 6).map((p) => { const r = rankOf(p.rank), tm = teamOf(p.soldTo); return (
              <div key={p.id} className="shrink-0 flex items-center gap-3 p-3 rounded-xl" style={{ minWidth: 230, background: `linear-gradient(135deg, ${r.c}1f, rgba(255,255,255,0.03))`, border: `1px solid ${r.c}44` }}>
                <RankBadge rank={p.rank} div={p.rankDiv} />
                <div className="min-w-0">
                  <p className="font-bold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{p.name}</p>
                  <p className="text-xs truncate" style={{ color: tm?.hue }}>{tm?.name}</p>
                  <p className="text-sm font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: r.c }}>{fmt(p.soldPrice)}</p>
                </div>
              </div>
            ); })}
          </div>
        </div>
      )}
    </div>
  );

  /* ════════ VIEW: SCOUT HUB ════════ */
  // Scout Hub is the draft roster — sold and unsold both, but not late sign-ups.
  // Those live in the Reserve Hub, which is a different question.
  const filtered = state.players.filter((p) => p.poolEligible !== false).filter((p) =>
    (filterRank === "All" || p.rank === filterRank) &&
    (filterRole === "All" || p.role === filterRole) &&
    (!query || p.name.toLowerCase().includes(query.toLowerCase()) || p.agent.toLowerCase().includes(query.toLowerCase()))
  );
  const chip = (active, hue = "#3d7bff") => ({
    background: active ? hue + "22" : "rgba(61,123,255,0.05)", border: `1px solid ${active ? hue : "rgba(120,150,220,0.18)"}`,
    color: active ? hue : "rgba(200,215,255,0.6)",
  });
  /* ── RESERVE HUB ── undrafted registrants, available as substitutes.
        Same shape and filters as the Scout Hub, but the job is different: a
        captain whose player has gone dark comes here to find a stand-in. The
        rank rule keeps that fair — a sub may be one rank below the player they
        replace, never above, so losing someone can't become an upgrade. ── */
  const rankIdx = (r) => RANK_LIST.indexOf(r);
  // "Undrafted" only means something once an auction has actually happened.
  // Before that every unsold player is a draft candidate, not a reserve — which
  // is why this can't key off status alone: during registration that would list
  // the entire league as reserves who "went undrafted".
  const draftHasRun = chrome?.phase === "matches_live" || chrome?.phase === "settled"
    || state.players.some((p) => p.status === "sold");
  // A reserve is someone deliberately outside the draft pool (late sign-up, added
  // as a reserve, or moved out by staff) — plus, once the draft is done, anyone
  // who registered on time and nobody bought. Hand-added Scout Hub players never
  // qualify: they were typed in for the draft, so they stay there.
  const reserves = state.players.filter((p) =>
    !p.isCaptain && p.status !== "sold" && (
      p.poolEligible === false || (draftHasRun && !isManualPlayer(p))
    ));
  const myRoster = myTeam ? (myTeam.roster || []).map((id) => state.players.find((x) => x.id === id)).filter(Boolean) : [];
  const missing = replacing ? myRoster.find((p) => p.id === replacing) : null;
  // At or below one rank down. Null when nobody is selected → no restriction shown.
  const capIdx = missing ? rankIdx(missing.rank) - 1 : null;
  const eligible = (p) => capIdx === null || rankIdx(p.rank) <= capIdx;

  const rFiltered = reserves.filter((p) =>
    (rRank === "All" || p.rank === rRank) &&
    (rRole === "All" || p.role === rRole) &&
    (!rQuery || p.name.toLowerCase().includes(rQuery.toLowerCase()) || (p.agent || "").toLowerCase().includes(rQuery.toLowerCase()))
  );
  const ReserveView = (
    <div className="view-in page-wrap py-6">
      <div className="flex items-end justify-between flex-wrap gap-3 mb-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ width: 18, height: 2, background: "#3ddc84" }} />
            <p className="uppercase text-xs font-semibold" style={{ color: "#3ddc84", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Substitutes</p>
          </div>
          <h2 className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>Reserve <span style={{ color: "#3ddc84" }}>Hub</span></h2>
        </div>
        <span className="text-sm" style={{ color: "rgba(200,215,255,0.5)", fontFamily: "'IBM Plex Mono',monospace" }}>{rFiltered.length} / {reserves.length}</span>
      </div>
      <p className="text-sm mb-5" style={{ color: "rgba(200,215,255,0.5)" }}>
        {draftHasRun
          ? "Players without a roster spot — available to sub in. Every match they play banks season points."
          : "Anyone outside this tournament's draft pool. Once the auction runs, undrafted players join them here."}
      </p>

      {myRoster.length > 0 && (
        <div className="mb-5 p-3" style={{ background: "rgba(61,220,132,0.05)", border: "1px solid rgba(61,220,132,0.25)", clipPath: SHELL_NOTCH(9) }}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.55)" }}>Who can't make it?</span>
            <select value={replacing || ""} onChange={(e) => setReplacing(e.target.value || null)}
              style={{ padding: "7px 10px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(61,220,132,0.35)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 13, fontWeight: 600 }}>
              <option value="">— nobody selected —</option>
              {myRoster.map((p) => <option key={p.id} value={p.id}>{p.name} · {rankLabel(p.rank, p.rankDiv)}</option>)}
            </select>
            {missing && (
              <span className="text-xs" style={{ color: "#9af5c2", fontFamily: "'Rajdhani',sans-serif" }}>
                Eligible subs: {capIdx >= 0 ? `${RANK_LIST[capIdx]} or below` : "none — they're already the lowest rank"}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center gap-2 mb-4 p-2" style={{ background: "rgba(61,220,132,0.04)", border: "1px solid rgba(120,150,220,0.18)", clipPath: SHELL_NOTCH(8) }}>
        <span style={{ color: "rgba(120,150,220,0.5)" }}>⌕</span>
        <input value={rQuery} onChange={(e) => setRQuery(e.target.value)} placeholder="Search reserves or agents…" className="flex-1 bg-transparent outline-none" style={{ color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 15 }} />
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button onClick={() => setRRank("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(rRank === "All", "#3ddc84")}>All ranks</button>
        {RANK_LIST.map((r) => <button key={r} onClick={() => setRRank(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(rRank === r, RANKS[r].c)}>{r}</button>)}
      </div>
      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => setRRole("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(rRole === "All", "#3ddc84")}>All roles</button>
        {ROLES.map((r) => <button key={r} onClick={() => setRRole(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(rRole === r, "#3ddc84")}>{ROLE_GLYPH[r]} {r}</button>)}
      </div>

      {reserves.length === 0 ? (
        <p className="text-sm" style={{ color: "rgba(200,215,255,0.45)" }}>
          {draftHasRun
            ? "No reserves — everyone who registered is on a roster."
            : "No reserves yet. Late sign-ups land here, and so does anyone you move out of the draft pool."}
        </p>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {rFiltered.map((p) => {
            const r = rankOf(p.rank) || RANKS.Silver;
            const ok = eligible(p);
            return (
              <div key={p.id} role="button" tabIndex={0}
                title={p.available === false ? "This player has said they can't make it" : "Open scouting file"}
                onClick={() => setScouted(p.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setScouted(p.id); } }}
                className="vg-row-x relative text-left p-4 overflow-hidden" style={{ background: `linear-gradient(150deg, ${r.c}1c, rgba(10,15,28,0.5) 60%)`, border: `1px solid ${ok ? r.c + "44" : "rgba(120,150,220,0.18)"}`, opacity: ok ? 1 : 0.45, clipPath: SHELL_NOTCH(10), cursor: "pointer" }}>
                <div className="absolute top-0 left-0 right-0" style={{ height: 2, background: `linear-gradient(90deg, ${r.c}, transparent)` }} />
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xl font-bold uppercase leading-none truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{p.name}</p>
                    <p className="text-xs uppercase tracking-widest mt-1.5" style={{ color: r.c }}>{ROLE_GLYPH[p.role]} {p.role} · {p.agent}</p>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <RankBadge rank={p.rank} div={p.rankDiv} size="sm" />
                    <span className="text-xs font-bold uppercase tracking-widest" style={{ fontFamily: "'Rajdhani',sans-serif", color: r.c }}>{rankLabel(p.rank, p.rankDiv)}</span>
                  </div>
                </div>
                <div className="flex gap-3 mt-3 text-xs" style={{ fontFamily: "'IBM Plex Mono',monospace" }}>
                  <span style={{ color: "#00e5ff" }}>KDA {p.kda == null ? "—" : Number(p.kda).toFixed(2)}</span>
                  <span style={{ color: "#ff4655" }}>ACS {p.acs == null ? "—" : p.acs}</span>
                  <span style={{ color: "#9d6bff" }}>HS {p.hs == null ? "—" : p.hs + "%"}</span>
                </div>
                {missing && (
                  <p className="mt-2 text-xs uppercase tracking-widest font-bold" style={{ color: ok ? "#3ddc84" : "rgba(255,138,148,0.8)" }}>
                    {ok ? "✓ Eligible sub" : "✕ Outranks your player"}
                  </p>
                )}
                <p className="mt-2 text-xs uppercase tracking-widest" style={{ color: p.available === false ? "rgba(255,138,148,0.9)" : "rgba(200,215,255,0.4)" }}>
                  {p.available === false ? "✕ Said they can't make it"
                    : p.poolEligible === false ? "Not in this tournament's draft"
                    : "Went undrafted"}
                </p>
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  {isAdmin && p.poolEligible === false && (
                    <button onClick={(e) => { e.stopPropagation(); setPoolEligible(p.id, true); }}
                      className="text-xs uppercase tracking-widest px-2.5 py-1" style={{ fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, color: "#9af5c2", border: "1px solid rgba(61,220,132,0.45)", background: "rgba(61,220,132,0.08)", clipPath: SHELL_NOTCH(5) }}>⊞ To draft pool</button>
                  )}
                  {p.discord
                    ? <span className="text-xs truncate" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(200,215,255,0.6)" }} title={"Discord: " + p.discord}>◈ {p.discord}</span>
                    : <span className="text-xs" style={{ color: "rgba(200,215,255,0.3)" }}>no discord on file</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isAdmin && (
        <div className="mt-8 p-5" style={{ background: "linear-gradient(160deg, rgba(61,220,132,0.06), rgba(10,15,28,0.5))", border: "1px solid rgba(61,220,132,0.3)", clipPath: SHELL_NOTCH(12) }}>
          <p className="text-xs uppercase tracking-widest mb-1" style={{ color: "#9af5c2" }}>Host · add a reserve</p>
          <p className="text-xs mb-3" style={{ color: "rgba(200,215,255,0.45)" }}>
            For someone who can stand in but isn't in this tournament's draft. They stay out of the Scout Hub and off the auction wheel.
          </p>
          <AddPlayerForm onAdd={(p) => addPlayer(p, true)} />
        </div>
      )}
    </div>
  );

  const ScoutView = (
    <div className="view-in page-wrap py-6">
      <div className="flex items-end justify-between flex-wrap gap-3 mb-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
            <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Operator Database</p>
          </div>
          <h2 className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>Scout <span style={{ color: "#3d7bff" }}>Hub</span></h2>
        </div>
        <span className="text-sm" style={{ color: "rgba(200,215,255,0.5)", fontFamily: "'IBM Plex Mono',monospace" }}>{filtered.length} / {state.players.length} players</span>
      </div>
      <p className="text-sm mb-5" style={{ color: "rgba(200,215,255,0.5)" }}>Tap any operator to open their full scouting file with a performance radar.</p>

      <div className="flex items-center gap-2 mb-4 p-2" style={{ background: "rgba(61,123,255,0.05)", border: "1px solid rgba(120,150,220,0.18)", clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))" }}>
        <span style={{ color: "rgba(120,150,220,0.5)" }}>⌕</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search players or agents…" className="flex-1 bg-transparent outline-none text-sm" style={{ color: "#ecf3ff" }} />
      </div>
      <div className="flex flex-wrap gap-2 mb-3">
        <button onClick={() => setFilterRank("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(filterRank === "All")}>All ranks</button>
        {RANK_LIST.map((r) => <button key={r} onClick={() => setFilterRank(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(filterRank === r, RANKS[r].c)}>{r}</button>)}
      </div>
      <div className="flex flex-wrap gap-2 mb-6">
        <button onClick={() => setFilterRole("All")} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(filterRole === "All")}>All roles</button>
        {ROLES.map((r) => <button key={r} onClick={() => setFilterRole(r)} className="px-3 py-1 text-xs uppercase tracking-widest rounded-full" style={chip(filterRole === r)}>{ROLE_GLYPH[r]} {r}</button>)}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
        {filtered.map((p) => { const r = rankOf(p.rank); const tm = p.soldTo ? teamOf(p.soldTo) : null; return (
          <button key={p.id} onClick={() => setScouted(p.id)} className="relative text-left p-4 transition-all hover:scale-[1.03] overflow-hidden"
            style={{ background: `linear-gradient(150deg, ${r.c}1c, rgba(10,15,28,0.5) 60%)`, border: `1px solid ${r.c}44`, boxShadow: "0 12px 28px rgba(0,0,0,0.35)", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))" }}>
            <div className="absolute top-0 left-0 right-0" style={{ height: 2, background: `linear-gradient(90deg, ${r.c}, transparent)` }} />
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xl font-bold uppercase leading-none truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{p.name}</p>
                <p className="text-xs uppercase tracking-widest mt-1.5" style={{ color: r.c }}>{ROLE_GLYPH[p.role]} {p.role} · {p.agent}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <RankBadge rank={p.rank} div={p.rankDiv} size="sm" />
                <span className="text-xs font-bold uppercase tracking-widest" style={{ fontFamily: "'Rajdhani',sans-serif", color: r.c }}>{rankLabel(p.rank, p.rankDiv)}</span>
              </div>
            </div>
            <div className="flex gap-3 mt-3 text-xs" style={{ fontFamily: "'IBM Plex Mono',monospace" }}>
              <span style={{ color: "#00e5ff" }}>KDA {p.kda == null ? "—" : Number(p.kda).toFixed(2)}</span>
              <span style={{ color: "#ff4655" }}>ACS {p.acs == null ? "—" : p.acs}</span>
              <span style={{ color: "#9d6bff" }}>HS {p.hs == null ? "—" : p.hs + "%"}</span>
            </div>
            {p.isCaptain ? <p className="mt-2 text-xs uppercase tracking-widest font-bold" style={{ color: "#f5c453" }}>★ Captain · not in draw</p>
              : tm ? <p className="mt-2 text-xs uppercase tracking-widest" style={{ color: tm.hue }}>◆ {tm.name} · {fmt(p.soldPrice)}</p>
              : <p className="mt-2 text-xs uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.4)" }}>Available · opens {fmt(r.bid)}</p>}
          </button>
        ); })}
        {filtered.length === 0 && <p className="col-span-full text-sm py-10 text-center" style={{ color: "rgba(236,243,255,0.4)" }}>No players match those filters.</p>}
      </div>

      {isAdmin && (
        <div id="wr-admin-form" className="mt-8 p-5" style={{ background: "linear-gradient(160deg, rgba(61,123,255,0.06), rgba(10,15,28,0.5))", border: `1px solid ${editingPlayer ? "#3ddc8455" : "rgba(61,123,255,0.22)"}`, clipPath: "polygon(0 0, calc(100% - 18px) 0, 100% 18px, 100% 100%, 18px 100%, 0 calc(100% - 18px))" }}>
          <div className="flex items-center justify-between mb-3">
            <p className="text-xs uppercase tracking-widest" style={{ color: editingPlayer ? "#3ddc84" : "#7da6ff" }}>
              {editingPlayer ? `Host · editing ${editingPlayer.name}` : "Host · add player"}
            </p>
            {isOwner && <button onClick={resetAll} className="text-xs uppercase tracking-widest px-3 py-1.5" style={{ border: `1px solid ${resetArmed ? "#ff4655" : "rgba(255,70,85,0.5)"}`, background: resetArmed ? "rgba(255,70,85,0.2)" : "transparent", color: resetArmed ? "#ffd2d7" : "#ff8a94" }}>{resetArmed ? "Click again to confirm" : "Reset auction"}</button>}
          </div>
          <AddPlayerForm onAdd={addPlayer} editing={editingPlayer} onSave={(p) => { editPlayer(p); setEditingPlayer(null); }} onCancel={() => setEditingPlayer(null)} />
        </div>
      )}
    </div>
  );

  /* ════════ VIEW: AUCTION BLOCK ════════ */
  const myReq = block ? requiredBid(block) : 0;
  const myMax = myTeam ? maxAllowedBid(myTeam, pool) : 0;
  const iLead = block && myTeam && block.leaderId === myTeam.id;
  const myFull = myTeam && emptySlots(myTeam) === 0;
  const canBid = block && myTeam && !iLead && !myFull && myMax >= myReq;

  // auction storylines — derived from sold players (spectator feed)
  const soldPlayers = state.players.filter((p) => p.status === "sold");
  const recordSale = soldPlayers.reduce((best, p) => (!best || (p.soldPrice || 0) > (best.soldPrice || 0) ? p : best), null);
  const mostContested = soldPlayers.reduce((best, p) => (!best || (p.bidCount || 0) > (best.bidCount || 0) ? p : best), null);
  const totalSpent = soldPlayers.reduce((s, p) => s + (p.soldPrice || 0), 0);
  const spendByTeam = {};
  soldPlayers.forEach((p) => { if (p.soldTo) spendByTeam[p.soldTo] = (spendByTeam[p.soldTo] || 0) + (p.soldPrice || 0); });
  const biggestSpenderId = Object.keys(spendByTeam).reduce((best, id) => (!best || spendByTeam[id] > spendByTeam[best] ? id : best), null);
  const completedTeams = state.teams.filter((t) => t.roster.length >= 4);

  const BlockView = (
    <div className={"view-in relative mx-auto " + (saleFlash ? "sale-flash" : "")} style={{ minHeight: 560, maxWidth: 1760 }}>
      {/* slim budget bar */}
      <div className="flex flex-wrap justify-center gap-2 px-5 md:px-8 pt-5 pb-3">
        {state.teams.map((t) => { const lead = block?.leaderId === t.id; return (
          <div key={t.id} className="shrink-0 flex items-center gap-2.5 px-3.5 py-2 rounded-lg" style={{ background: lead ? "rgba(255,70,85,0.16)" : "rgba(255,255,255,0.04)", border: `1px solid ${lead ? "#ff4655" : t.hue + "44"}` }}>
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.hue, boxShadow: `0 0 8px ${t.hue}` }} />
            <span className="text-sm font-bold uppercase tracking-wide" style={{ fontFamily: "'Rajdhani',sans-serif", color: t.hue }}>{t.name.split(" ")[0]}</span>
            <span className="text-base" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ecf3ff" }}>{fmt(t.budget)}</span>
          </div>
        ); })}
      </div>

      <div className="px-5 md:px-8 py-4 flex flex-col items-center gap-6">
        {/* center stage */}
        <div className="flex flex-col items-center gap-5 w-full">
          {blockPlayer && !spinLive ? (
            <>
              <button onClick={() => setScouted(blockPlayer.id)} className="group relative w-full max-w-[420px] transition-transform hover:scale-[1.015] active:scale-[0.99]" style={{ cursor: "pointer" }} title="View full scouting file">
                <PlayerCard player={blockPlayer} />
                <span className="absolute left-1/2 -translate-x-1/2 -bottom-3 px-3 py-1 text-[10px] uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" style={{ fontFamily: "'Rajdhani',sans-serif", background: "rgba(7,12,22,0.9)", border: "1px solid rgba(61,123,255,0.4)", color: "#7da6ff", clipPath: "polygon(0 0, calc(100% - 7px) 0, 100% 7px, 100% 100%, 7px 100%, 0 calc(100% - 7px))" }}>Tap for performance radar</span>
              </button>
              <div className={"flex items-center gap-6 px-8 py-3 " + (flash ? "bid-pop" : "")} style={{ clipPath: "polygon(18px 0,100% 0,calc(100% - 18px) 100%,0 100%)", background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.45)", backdropFilter: "blur(10px)", boxShadow: "0 0 26px rgba(61,123,255,0.2)" }}>
                <div className="text-center">
                  <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.45)" }}>Current bid</p>
                  <p className="text-4xl font-bold leading-none" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#5b8dff", textShadow: "0 0 18px rgba(61,123,255,0.6)" }}>{fmt(block.currentBid)}</p>
                </div>
                <div className="w-px self-stretch" style={{ background: "rgba(120,150,220,0.18)" }} />
                <div className="text-center">
                  <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.45)" }}>Held by</p>
                  <p className="text-xl font-bold uppercase leading-tight" style={{ fontFamily: "'Rajdhani',sans-serif", color: leaderTeam ? leaderTeam.hue : "rgba(200,215,255,0.4)" }}>{leaderTeam ? leaderTeam.name : "No bids yet"}</p>
                </div>
                {myTeam && (
                  <>
                    <div className="w-px self-stretch" style={{ background: "rgba(120,150,220,0.18)" }} />
                    <div className="text-center">
                      <p className="text-xs uppercase tracking-widest" style={{ color: "rgba(200,215,255,0.45)" }}>Your budget</p>
                      <p className="text-2xl font-bold leading-none" style={{ fontFamily: "'IBM Plex Mono',monospace", color: myTeam.hue, textShadow: `0 0 14px ${myTeam.hue}66` }}>{fmt(myTeam.budget)}</p>
                    </div>
                  </>
                )}
              </div>

              {myTeam && (
                <div className="w-full max-w-md flex flex-col items-center gap-2">
                  {/* live max-bid ceiling + the reserve note that explains it — kept together
                      so the shifting number reads as intentional, not random */}
                  {!myFull && (() => { const slotsLeft = Math.max(4 - myTeam.roster.length - 1, 0); const lowFunds = myMax < myReq; return (
                    <div className="flex flex-col items-center gap-1">
                      <div className="flex items-center gap-2 px-4 py-1.5" style={{ background: "rgba(61,123,255,0.08)", border: "1px solid rgba(61,123,255,0.35)", clipPath: "polygon(10px 0,100% 0,calc(100% - 10px) 100%,0 100%)" }}>
                        <span className="uppercase text-xs tracking-widest" style={{ color: "rgba(200,215,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>Max Bid</span>
                        <span className="text-lg font-bold leading-none" style={{ fontFamily: "'IBM Plex Mono',monospace", color: lowFunds ? "#ff6b7d" : "#5b8dff", textShadow: lowFunds ? "none" : "0 0 14px rgba(61,123,255,0.5)" }}>{fmt(Math.max(myMax, 0))}</span>
                      </div>
                      {slotsLeft > 0 && (
                        <span className="text-[10px] uppercase tracking-widest" style={{ color: lowFunds ? "#ff8a94" : "rgba(200,215,255,0.4)" }}>
                          {lowFunds ? "Insufficient — " : ""}reserve held for your {slotsLeft} remaining slot{slotsLeft === 1 ? "" : "s"}
                        </span>
                      )}
                    </div>
                  ); })()}
                  <button onClick={() => placeBid(myTeam.id)} disabled={!canBid || bidPending} className="w-full py-6 text-3xl font-bold uppercase tracking-widest transition-all active:scale-95"
                    style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(24px 0,100% 0,calc(100% - 24px) 100%,0 100%)", background: canBid ? "linear-gradient(90deg,#ff4655,#ff2d55)" : "rgba(255,255,255,0.05)", color: canBid ? "#fff" : "rgba(236,243,255,0.25)", border: canBid ? "1px solid #ff8a94" : "1px solid rgba(255,255,255,0.1)", boxShadow: canBid ? "0 0 36px rgba(255,70,85,0.5), 0 0 80px rgba(255,70,85,0.2)" : "none", cursor: canBid ? "pointer" : "not-allowed" }}>
                    {bidPending ? "Bidding…" : iLead ? "You hold the bid" : `BID ${fmt(myReq)}`}
                  </button>
                  {myFull ? (
                    <p className="text-xs uppercase tracking-widest text-center" style={{ color: "rgba(236,243,255,0.4)" }}>Roster full — spectating</p>
                  ) : iLead ? (
                    <p className="text-xs uppercase tracking-widest text-center" style={{ color: "rgba(236,243,255,0.4)" }}>Waiting on challengers…</p>
                  ) : (
                    <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full" style={{ color: "rgba(200,215,255,0.7)", background: "rgba(120,150,220,0.12)", border: "1px solid rgba(120,150,220,0.25)" }}>
                      +$100 min. raise
                    </span>
                  )}
                </div>
              )}

              {isSpectator && (
                <div className="w-full max-w-md flex flex-col items-center gap-1 py-4 px-6" style={{ background: "rgba(120,160,255,0.06)", border: "1px solid rgba(120,160,255,0.25)", clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 14px 100%, 0 calc(100% - 14px))" }}>
                  <p className="text-sm font-bold uppercase tracking-widest flex items-center gap-2" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#aec6ff" }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="square"><path d="M12 3v3M12 18v3M3 12h3M18 12h3" opacity="0.7" /><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>
                    Spectating
                  </p>
                  <p className="text-xs uppercase tracking-widest text-center" style={{ color: "rgba(200,215,255,0.4)" }}>You're watching live · only captains can place bids</p>
                </div>
              )}

              {canRunAuction && (
                <div className="flex gap-3 w-full max-w-md">
                  <button onClick={sell} disabled={!block.leaderId || bidPending} className="flex-1 py-4 text-2xl font-bold uppercase tracking-widest active:scale-95 transition-all"
                    style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(20px 0,100% 0,calc(100% - 20px) 100%,0 100%)", background: block.leaderId ? "linear-gradient(90deg,#1fbf75,#3ddc84)" : "rgba(255,255,255,0.05)", color: block.leaderId ? "#062b18" : "rgba(236,243,255,0.25)", boxShadow: block.leaderId ? "0 0 30px rgba(61,220,132,0.4)" : "none", cursor: block.leaderId ? "pointer" : "not-allowed" }}>SOLD</button>
                  <button onClick={passPlayer} className="px-6 py-4 font-bold uppercase tracking-widest" style={{ fontFamily: "'Rajdhani',sans-serif", clipPath: "polygon(14px 0,100% 0,calc(100% - 14px) 100%,0 100%)", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", color: "rgba(236,243,255,0.6)" }}>Pass</button>
                </div>
              )}
            </>
          ) : (
            <ReelStage spin={spinLive ? state.spin : null} players={state.players} pool={pool} isAdmin={canRunAuction} onDraw={spinNominate} canDraw={!!pool.length} />
          )}
        </div>

        {/* bidding war + auction feed, side by side */}
        <div className="w-full flex flex-col md:flex-row gap-4 justify-center items-stretch">
        {/* bidding war tracker */}
        <div className="w-full max-w-md p-4 rounded-2xl" style={{ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.09)", backdropFilter: "blur(10px)" }}>
          <p className="text-xs uppercase tracking-widest mb-3" style={{ color: "#ff4655" }}>Bidding war</p>
          {state.bidHistory.length === 0 ? (
            <p className="text-sm" style={{ color: "rgba(236,243,255,0.4)" }}>{block ? "No bids yet. First captain to act sets the pace." : "Tracker activates when a player hits the block."}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {state.bidHistory.map((h, i) => { const tm = teamOf(h.teamId); return (
                <div key={h.ts} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: i === 0 ? tm.hue + "1f" : "rgba(255,255,255,0.03)", border: `1px solid ${i === 0 ? tm.hue + "66" : "transparent"}` }}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: tm.hue, boxShadow: i === 0 ? `0 0 8px ${tm.hue}` : "none" }} />
                  <span className="flex flex-col min-w-0">
                    <span className="text-sm font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: tm.hue }}>{tm.captain || tm.name.split(" ")[0]}</span>
                    <span className="text-[10px] uppercase tracking-wider leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "rgba(236,243,255,0.45)" }}>{tm.name}</span>
                  </span>
                  <span className="ml-auto text-sm font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: i === 0 ? "#ecf3ff" : "rgba(236,243,255,0.6)" }}>{fmt(h.amount)}</span>
                </div>
              ); })}
            </div>
          )}
        </div>

        {/* auction feed — running storylines */}
        <div className="w-full max-w-md p-4 rounded-2xl" style={{ background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.09)", backdropFilter: "blur(10px)" }}>
          <p className="text-xs uppercase tracking-widest mb-3" style={{ color: "#3d7bff" }}>Auction feed</p>
          {soldPlayers.length === 0 ? (
            <p className="text-sm" style={{ color: "rgba(236,243,255,0.4)" }}>Storylines appear as players get sold.</p>
          ) : (
            <div className="flex flex-col gap-2">
              {recordSale && (() => { const tm = teamOf(recordSale.soldTo); return (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: "rgba(245,196,83,0.08)", border: "1px solid rgba(245,196,83,0.3)" }}>
                  <span className="text-lg shrink-0">🔨</span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-widest" style={{ color: "#f5c453", fontFamily: "'Rajdhani',sans-serif" }}>Record sale</span>
                    <span className="text-sm font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{recordSale.name}</span>
                    <span className="text-[10px] uppercase tracking-wider leading-tight truncate" style={{ color: tm ? tm.hue : "rgba(236,243,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>{tm ? (tm.captain || tm.name) : "—"}</span>
                  </span>
                  <span className="ml-auto text-base font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#f5c453" }}>{fmt(recordSale.soldPrice)}</span>
                </div>
              ); })()}

              {mostContested && (mostContested.bidCount || 0) > 1 && (() => { const tm = teamOf(mostContested.soldTo); return (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: "rgba(255,70,85,0.08)", border: "1px solid rgba(255,70,85,0.3)" }}>
                  <span className="text-lg shrink-0">🔥</span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-widest" style={{ color: "#ff8a94", fontFamily: "'Rajdhani',sans-serif" }}>Most contested</span>
                    <span className="text-sm font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{mostContested.name}</span>
                    <span className="text-[10px] uppercase tracking-wider leading-tight truncate" style={{ color: tm ? tm.hue : "rgba(236,243,255,0.5)", fontFamily: "'Rajdhani',sans-serif" }}>{tm ? (tm.captain || tm.name) : "—"}</span>
                  </span>
                  <span className="ml-auto text-sm font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ff8a94" }}>{mostContested.bidCount} bids</span>
                </div>
              ); })()}

              {biggestSpenderId && (() => { const tm = teamOf(biggestSpenderId); return (
                <div className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: "rgba(61,123,255,0.06)", border: "1px solid rgba(61,123,255,0.25)" }}>
                  <span className="text-lg shrink-0">💰</span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-widest" style={{ color: "#7da6ff", fontFamily: "'Rajdhani',sans-serif" }}>Biggest spender</span>
                    <span className="text-sm font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: tm ? tm.hue : "#ecf3ff" }}>{tm ? (tm.captain || tm.name) : "—"}</span>
                  </span>
                  <span className="ml-auto text-sm font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#7da6ff" }}>{fmt(spendByTeam[biggestSpenderId])}</span>
                </div>
              ); })()}

              {/* roster complete — milestone callout for any team that's drafted all 4 */}
              {completedTeams.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-3 py-2 rounded-lg" style={{ background: `${t.hue}14`, border: `1px solid ${t.hue}55` }}>
                  <span className="text-lg shrink-0">✅</span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[10px] uppercase tracking-widest" style={{ color: t.hue, fontFamily: "'Rajdhani',sans-serif" }}>Draft complete</span>
                    <span className="text-sm font-bold uppercase leading-tight truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{t.captain || t.name}</span>
                    <span className="text-[10px] uppercase tracking-wider leading-tight truncate" style={{ color: t.hue, fontFamily: "'Rajdhani',sans-serif" }}>{t.name} · roster locked</span>
                  </span>
                  <span className="ml-auto text-xs font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: t.hue }}>4/4</span>
                </div>
              ))}

              <div className="flex gap-2 mt-1">
                <div className="flex-1 px-3 py-2 rounded-lg text-center" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)", fontFamily: "'Rajdhani',sans-serif" }}>Players sold</p>
                  <p className="text-base font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ecf3ff" }}>{soldPlayers.length}</p>
                </div>
                <div className="flex-1 px-3 py-2 rounded-lg text-center" style={{ background: "rgba(255,255,255,0.03)" }}>
                  <p className="text-[10px] uppercase tracking-widest" style={{ color: "rgba(236,243,255,0.45)", fontFamily: "'Rajdhani',sans-serif" }}>Total spent</p>
                  <p className="text-base font-bold" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#ecf3ff" }}>{fmt(totalSpent)}</p>
                </div>
              </div>

              {/* recent sales ticker — last few hammers, newest first */}
              {Array.isArray(state.recentSales) && state.recentSales.length > 0 && (
                <div className="mt-1 pt-2" style={{ borderTop: "1px solid rgba(255,255,255,0.07)" }}>
                  <p className="text-[10px] uppercase tracking-widest mb-1.5" style={{ color: "rgba(236,243,255,0.4)", fontFamily: "'Rajdhani',sans-serif" }}>Recent sales</p>
                  <div className="flex flex-col gap-1">
                    {state.recentSales.slice(0, 5).map((sale) => { const tm = teamOf(sale.teamId); return (
                      <div key={sale.ts} className="flex items-center gap-2 px-2.5 py-1.5 rounded" style={{ background: "rgba(255,255,255,0.025)" }}>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: tm ? tm.hue : "#888" }} />
                        <span className="text-xs font-semibold uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: "#ecf3ff" }}>{sale.name}</span>
                        <span className="text-[10px] uppercase truncate" style={{ fontFamily: "'Rajdhani',sans-serif", color: tm ? tm.hue : "rgba(236,243,255,0.5)" }}>→ {tm ? (tm.captain || tm.name.split(" ")[0]) : "—"}</span>
                        <span className="ml-auto text-xs font-bold shrink-0" style={{ fontFamily: "'IBM Plex Mono',monospace", color: "rgba(236,243,255,0.85)" }}>{fmt(sale.price)}</span>
                      </div>
                    ); })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );

  /* ════════ VIEW: LOCKER ROOM ════════ */
  const canRemoveTeam = state.teams.length > MIN_TEAMS;
  const LockerView = (
    <div className="view-in page-wrap py-6">
      <div className="flex items-end justify-between flex-wrap gap-3 mb-1">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
            <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Rosters & Budgets</p>
          </div>
          <h2 className="font-bold uppercase" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>Locker <span style={{ color: "#3d7bff" }}>Room</span></h2>
        </div>
        <span className="text-sm px-3 py-1" style={{ background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.3)", color: "#7da6ff", clipPath: "polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 8px 100%, 0 calc(100% - 8px))", fontFamily: "'IBM Plex Mono',monospace" }}>{state.teams.length} teams</span>
      </div>
      <p className="text-sm mb-6" style={{ color: "rgba(200,215,255,0.5)" }}>
        Every roster, budget and the roles still missing — scout your rivals.{isAdmin && " Tap ✎ on a card to rename or remove a team."}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {state.teams.map((t) => (
          <TeamCard key={t.id} team={t} players={state.players} lead={block?.leaderId === t.id} isAdmin={isAdmin} onRename={renameTeam} onScout={setScouted} onRemove={removeTeam} canRemove={canRemoveTeam} onAddToRoster={adminAddToRoster} onRemoveFromRoster={adminRemoveFromRoster} onSetBudget={setTeamBudget} />
        ))}
        {isAdmin && (
          <button onClick={addTeam} className="flex flex-col items-center justify-center gap-2 py-10 transition-all hover:scale-[1.02] min-h-[220px]"
            style={{ border: "2px dashed rgba(61,123,255,0.4)", background: "rgba(61,123,255,0.05)", color: "#aec6ff", clipPath: "polygon(0 0, calc(100% - 16px) 0, 100% 16px, 100% 100%, 16px 100%, 0 calc(100% - 16px))" }}>
            <span className="text-4xl leading-none">＋</span>
            <span className="font-bold uppercase tracking-widest text-sm" style={{ fontFamily: "'Rajdhani',sans-serif" }}>Add team</span>
            <span className="text-xs" style={{ color: "rgba(200,215,255,0.4)" }}>$10,000 budget · 4 slots</span>
          </button>
        )}
      </div>
    </div>
  );

  // Holding a seat is what grants the War Room — a host who captains a team gets
  // their own sandbox like anyone else. The "you can't see this" panel is only for
  // staff with no team of their own.
  const WarRoomView = (isAdmin && !myTeam) ? (
    <div className="view-in page-wrap py-10 flex flex-col items-center text-center">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
        <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Captain Sandbox</p>
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
      </div>
      <h2 className="font-bold uppercase mb-2" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>War <span style={{ color: "#3d7bff" }}>Room</span></h2>
      <p className="max-w-md" style={{ color: "rgba(200,215,255,0.55)" }}>The War Room is each captain's private mock-draft sandbox. As host you can't view captains' saved lineups — they're visible only to the captain who made them.</p>
    </div>
  ) : (isSpectator && !chrome?.isCaptainElect) ? (
    <div className="view-in page-wrap py-10 flex flex-col items-center text-center">
      <div className="flex items-center gap-2 mb-2">
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
        <p className="uppercase text-xs font-semibold" style={{ color: "#5b8dff", fontFamily: "'Rajdhani',sans-serif", letterSpacing: "0.34em" }}>Captain Sandbox</p>
        <span style={{ width: 18, height: 2, background: "#3d7bff" }} />
      </div>
      <h2 className="font-bold uppercase mb-2" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>War <span style={{ color: "#3d7bff" }}>Room</span></h2>
      <p className="max-w-md" style={{ color: "rgba(200,215,255,0.55)" }}>The War Room is each captain's private mock-draft sandbox. As a spectating Player you don't have a roster to plan — take a captain's seat to use it.</p>
    </div>
  ) : (
    <WarRoom teamId={myTeam?.id || ("pre:" + (auth?.userId || "me"))} teamHue={myTeam?.hue || "#3d7bff"} players={state.players} />
  );

  const BracketView = (
    <TournamentView
      state={state}
      isAdmin={isAdmin}
      teamOf={teamOf}
      actions={{ tCreate, tClear, armTClear, tClearArmed, tAssign, tSetSlot, tSetSlotCount, tLock, tSetMap, tSetBo, tSetTime, tVote, tOverride, tSwitchFormat, tSetFinalTeam, tResetFinal }}
    />
  );

  const VetoView = isAdmin ? (
    <MapVeto teams={state.teams} />
  ) : (
    <div className="view-in page-wrap py-10 flex flex-col items-center text-center">
      <h2 className="font-bold uppercase mb-2" style={{ fontFamily: "'Tungsten','Rajdhani',sans-serif", fontSize: "clamp(2.6rem,5vw,3.8rem)", lineHeight: 0.9, letterSpacing: "0.04em", color: "#f4f8ff" }}>Map <span style={{ color: "#3d7bff" }}>Veto</span></h2>
      <p className="max-w-md" style={{ color: "rgba(200,215,255,0.55)" }}>The map veto is run by the host.</p>
    </div>
  );

  const LeaderboardView = (
    <Leaderboard isAdmin={isAdmin} />
  );

  const views = { lobby: LobbyView, scout: ScoutView, reserve: ReserveView, block: BlockView, locker: LockerView, warroom: WarRoomView, bracket: BracketView, veto: VetoView, leaderboard: LeaderboardView,
    account: <AccountView auth={auth} chrome={chrome} />,
    profile: <PlayerProfile userId={profileUser} onBack={() => { setProfileUser(null); setView(profileFrom || "scout"); }} />,
    report: chrome?.reportNode || null };
  const scoutedPlayer = scouted ? state.players.find((p) => p.id === scouted) : null;

  return shell(
    <>
      {scoutedPlayer && <ScoutModal player={scoutedPlayer} onClose={() => setScouted(null)} isAdmin={isAdmin} onEdit={(p) => { setEditingPlayer(p); setScouted(null); setView("scout"); }} onDelete={removePlayer} onToggleCaptain={toggleCaptain} onMoveReserve={setPoolEligible} onViewProfile={(uid) => { setScouted(null); setProfileFrom(view); setProfileUser(uid); setView("profile"); }} />}
      {saveErr && (
        <div style={{ position: "fixed", left: "50%", bottom: 22, transform: "translateX(-50%)", zIndex: 210, maxWidth: "92vw",
          display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", fontFamily: "'Rajdhani',sans-serif",
          background: "rgba(40,10,16,0.97)", border: "1px solid rgba(255,70,85,0.6)", clipPath: SHELL_NOTCH(10), boxShadow: "0 14px 40px rgba(0,0,0,0.5)" }}>
          <span style={{ color: "#ff8f9a", fontSize: 13, fontWeight: 700 }}>⚠ Not saved</span>
          <span style={{ color: "rgba(230,220,225,0.8)", fontSize: 12.5 }}>{saveErr}</span>
          <button onClick={() => window.location.reload()} style={shellBtn("ghost", { padding: "5px 11px", fontSize: 11 })}>Reload</button>
          <button onClick={() => setSaveErr(null)} style={{ background: "none", border: "none", color: "rgba(200,215,255,0.5)", cursor: "pointer", fontSize: 14 }}>✕</button>
        </div>
      )}
      {Rail}
      {TopNav}
      {views[view]}
    </>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MULTI-TENANT SHELL — login + community select, then the draft app.
   Sets window.__VOLT.{communityId,userId} so the storage layer is scoped.
   ════════════════════════════════════════════════════════════════════ */
function VoltGate() {
  const [phase, setPhase] = useState("loading"); // loading | welcome | signin | host | join | schedule | ready
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

  // ?join=<code> lets a host post one link instead of asking people to copy a
  // code between two apps. Read once on mount and stripped from the URL, so a
  // refresh after joining doesn't try to re-join.
  const joinLink = useRef(null);
  if (joinLink.current === null) {
    let c = "";
    try { c = new URLSearchParams(window.location.search).get("join") || ""; } catch { /* no URL */ }
    joinLink.current = c.trim().toLowerCase();
  }

  // In preview (no Supabase), skip straight into the app with a memory community.
  useEffect(() => {
    if (!HAS_SUPABASE) {
      window.__VOLT.communityId = "preview";
      window.__VOLT.userId = "preview-user";
      window.__VOLT.weekendId = "preview-tournament";
      setPhase("ready");
      return;
    }
    if (joinLink.current) {
      setCcode(joinLink.current);
      // Drop the query string but keep history usable — otherwise a refresh
      // after joining reopens the join screen for someone already in a league.
      try { window.history.replaceState({}, "", window.location.pathname); } catch { /* ignore */ }
    }
    (async () => {
      const { data } = await __sb.auth.getSession();
      if (data?.session) { setSession(data.session); await loadProfile(data.session.user.id); }
      // A code in the URL means they came from an invite, so send them straight
      // to the join form rather than a generic welcome screen.
      else setPhase(joinLink.current ? "join" : "welcome");
    })();
    const { data: sub } = __sb.auth.onAuthStateChange((_e, s) => {
      setSession(s || null);
      if (!s) setPhase("welcome");
    });
    return () => sub?.subscription?.unsubscribe?.();
  }, []);

  async function loadProfile(uid) {
    window.__VOLT.userId = uid;
    const { data: u } = await __sb.from("users").select("*, communities(*)").eq("id", uid).maybeSingle();
    if (u && u.community_id) {
      setProfile(u); setCommunity(u.communities);
      window.__VOLT.communityId = u.community_id;
      window.__VOLT.communityName = u.communities?.name || null;
      window.__VOLT.userName = u.display_name || null;   // used for vote attribution
      window.__VOLT.isHost = u.role === "host";              // strictly the owner
      window.__VOLT.isStaff = u.role === "host" || u.role === "moderator"; // + moderators
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
  async function doHost() {
    setErr(""); setBusy(true);
    try {
      if (!leagueName.trim()) throw new Error("Give your league a name.");
      const user = await ensureAuthedUser();
      window.__VOLT.userId = user.id;
      const slug = leagueName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 20) + "-" + Math.random().toString(36).slice(2, 5);
      const dn = displayName || email.split("@")[0];
      const { data: rows, error } = await __sb.rpc("create_league", { p_name: leagueName.trim(), p_slug: slug, p_display: dn });
      if (error) throw error;
      const c = Array.isArray(rows) ? rows[0] : rows;
      if (!c) throw new Error("League was not created — try again.");
      window.__VOLT.communityId = c.id; window.__VOLT.communityName = c.name; setCommunity(c);
      setProfile({ id: user.id, role: "host", display_name: dn, community_id: c.id });
      setPhase("schedule");
    } catch (e) { setErr(e.message || "Could not create the league."); }
    setBusy(false);
  }

  // Join path: code first, then account, placed as player.
  async function doJoin() {
    setErr(""); setBusy(true);
    try {
      if (!ccode.trim()) throw new Error("Enter your league's join code.");
      const { data: rows } = await __sb.rpc("join_lookup", { p_slug: ccode.trim() });
      const c = Array.isArray(rows) ? rows[0] : rows;
      if (!c) throw new Error("No league found with that code. Check with your host.");
      const user = await ensureAuthedUser();
      window.__VOLT.userId = user.id;
      // Does this account already belong to a league?
      const { data: existing } = await __sb.from("users").select("community_id, role, display_name").eq("id", user.id).maybeSingle();
      if (existing && existing.community_id && existing.community_id !== c.id) {
        if (existing.role === "host") {
          throw new Error("This account hosts another league. Hosts can't move — create a separate account to join as a player.");
        }
        if (!window.confirm(`This account is already in another league. Joining "${c.name}" will move you out of it. Continue?`)) {
          setBusy(false); return;
        }
      }
      await __sb.from("users").upsert({
        id: user.id, community_id: c.id,
        // Keep your role only when you're staying in the same league. A
        // moderator of one league joining another arrives as a plain player.
        role: (existing?.community_id === c.id && (existing?.role === "host" || existing?.role === "moderator"))
          ? existing.role : "player",
        display_name: displayName || existing?.display_name || email.split("@")[0],
      });
      window.__VOLT.communityId = c.id; window.__VOLT.communityName = c.name; setCommunity(c);
      setProfile({ id: user.id, role: "player", display_name: displayName || email.split("@")[0], community_id: c.id });
      setPhase("schedule");
    } catch (e) { setErr(e.message || "Could not join the league."); }
    setBusy(false);
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
          <div style={{ fontSize: 13, letterSpacing: "0.35em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase", textShadow: "0 0 14px rgba(61,123,255,0.6)" }}>// VOLT PROTOCOL</div>
          <div style={{ fontSize: 34, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", marginTop: 4 }}>VOLT <span style={{ color: "#3d7bff" }}>LEAGUE</span></div>
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
    return <WeekendApp
      auth={auth}
      event={activeEvent}
      isHost={profile?.role === "host" || profile?.role === "moderator"}
      isTrueHost={profile?.role === "host"}
      account={account} onSignOut={signOut}
      initialView={targetView}
      onBack={() => { window.__VOLT.weekendId = null; setActiveEvent(null); setTargetView(null); setPhase("schedule"); }} />;
  }

  const backLink = (
    <button onClick={() => { setErr(""); setPhase("welcome"); }} style={{ background: "none", border: "none", color: "rgba(200,215,255,0.55)", fontFamily: "'Rajdhani',sans-serif", fontSize: 13, letterSpacing: "0.06em", cursor: "pointer", marginBottom: 14, padding: 0 }}>‹ Back</button>
  );
  const emailPw = (<>
    <input style={field} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} />
    <input style={field} type="password" placeholder="Password" value={pw} onChange={e => setPw(e.target.value)} />
  </>);

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
  if (phase === "signin") return wrap(<>
    {backLink}
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Welcome back. Sign in to your league.</p>
    {emailPw}
    <button disabled={busy} onClick={doSignIn} style={btn(true)}>{busy ? "…" : "Sign in →"}</button>
  </>);

  // Host a league.
  if (phase === "host") return wrap(<>
    {backLink}
    <p style={{ margin: "0 0 6px", color: "#5dcaa5", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Host setup</p>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Name your league and create your host account. You'll get a join code to share with players.</p>
    <input style={field} placeholder="League name (e.g. Minaal.GG)" value={leagueName} onChange={e => setLeagueName(e.target.value)} />
    <input style={field} placeholder="Your display name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
    {!session && emailPw}
    <button disabled={busy} onClick={doHost} style={btn(true)}>{busy ? "…" : "Create my league →"}</button>
  </>);

  // Join a league.
  if (phase === "join") return wrap(<>
    {backLink}
    <p style={{ margin: "0 0 6px", color: "#af9aec", fontSize: 12, letterSpacing: "0.2em", textTransform: "uppercase", fontWeight: 700 }}>Join a league</p>
    <p style={{ margin: "0 0 16px", color: "rgba(200,215,255,0.7)", fontSize: 14 }}>Enter the join code your host gave you, then set up your account.</p>
    <input style={{ ...field, textTransform: "lowercase" }} placeholder="Join code" value={ccode} onChange={e => setCcode(e.target.value)} />
    <input style={field} placeholder="Your display name" value={displayName} onChange={e => setDisplayName(e.target.value)} />
    {!session && emailPw}
    <button disabled={busy} onClick={doJoin} style={btn(true)}>{busy ? "…" : "Join league →"}</button>
  </>);

  return wrap(<p className="vg-loading" style={{ margin: 0 }}>// Syncing…</p>);
}

// ── Shell design language — mirrors the old app's HUD aesthetic ─────────
// Notched clip-path corners, Rajdhani uppercase tracking, blue glow accents.
const SHELL_NOTCH = (n = 9) => `polygon(0 0, calc(100% - ${n}px) 0, 100% ${n}px, 100% 100%, ${n}px 100%, 0 calc(100% - ${n}px))`;
function shellBtn(kind, extra) {
  const kinds = {
    primary: { background: "linear-gradient(180deg,#4a86ff,#2f66e0)", borderColor: "rgba(140,180,255,0.55)", color: "#fff", boxShadow: "0 0 18px rgba(61,123,255,0.35)" },
    ghost:   { background: "linear-gradient(180deg, rgba(20,30,52,0.8), rgba(10,16,30,0.8))", borderColor: "rgba(90,130,210,0.4)", color: "#cfe0ff" },
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
function ShellStyles() {
  return <style>{`
    html { zoom: 1.1; }
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

  // Editing lives below the read-only profile — same screen, clear separation.
  const editor = (
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

      <div style={panel}>
        <div style={overline}>// Scouting profile</div>
        <p style={{ fontSize: 13, color: "rgba(200,215,255,0.5)", margin: "0 0 10px", fontFamily: "'Rajdhani',sans-serif" }}>Captains see this on the auction block — keep it honest, keep it current. Edits update the radar above.</p>
        <ScoutProfileCard userId={auth?.userId} onSaved={() => { try { __sb.from("users").select("*").eq("id", auth.userId).maybeSingle().then(({ data }) => data && setMe(data)); } catch {} }} />
      </div>
      {HAS_SUPABASE && <DiscordLinkCard />}

      {chrome?.onSignOut && (
        <button onClick={chrome.onSignOut} style={shellBtn("danger", { padding: "12px", letterSpacing: "0.14em" })}>Sign out</button>
      )}
    </div>
  );

  // The rich profile screen, rendered for the logged-in user, with the editor
  // dropped in as its footer. One coherent page, same visual language.
  return <PlayerProfile userId={auth?.userId} onBack={null} footer={editor} />;
}

// Collapsed host controls for narrow screens — same overlay pattern as the chip.
function HostMenu({ children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", fontFamily: "'Rajdhani',sans-serif" }}>
      <button onClick={() => setOpen(o => !o)} aria-label="Host controls"
        style={{ height: 36, padding: "0 15px", clipPath: SHELL_NOTCH(9), display: "inline-flex", alignItems: "center", gap: 7, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", background: "rgba(61,123,255,0.1)", border: "1px solid rgba(61,123,255,0.5)", color: "#aec6ff", textShadow: "0 0 10px rgba(61,123,255,0.45)", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>⚙ Manage<span style={{ fontSize: 9, color: "rgba(174,198,255,0.65)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s ease", display: "inline-block" }}>▼</span></button>
      {open && <>
        <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 90 }} />
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 91, minWidth: 230, background: "linear-gradient(160deg, rgba(16,23,40,0.98), rgba(9,13,23,0.98))", border: "1px solid rgba(61,123,255,0.35)", clipPath: SHELL_NOTCH(12), padding: 14, boxShadow: "0 18px 50px rgba(0,0,0,0.6)" }}>
          {children}
        </div>
      </>}
    </div>
  );
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

// A geometric chevron rather than the ▶ glyph. Filled-triangle characters have
// ink that isn't centred in their em box and it varies by font, so centring the
// box still looks off. An SVG path is centred in its viewBox by construction, and
// it rotates cleanly for the open state.
function TrophyIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={{ display: "block", flex: "0 0 auto" }}>
      <path d="M7 4h10v6a5 5 0 0 1-10 0V4z" />
      <path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" />
      <path d="M10 15h4M9 20h6M12 15v5" />
    </svg>
  );
}

function ChevronIcon({ size = 9 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"
      style={{ display: "block", overflow: "visible" }}>
      <path d="M9 5l7 7-7 7" />
    </svg>
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
  const [open, setOpen] = useState(false);
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
        style={{ height: 36, padding: "0 14px", clipPath: SHELL_NOTCH(9), display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", background: "rgba(255,255,255,0.045)", border: "1px solid rgba(120,150,220,0.32)", color: "#dce7ff", cursor: "pointer", fontFamily: "'Rajdhani',sans-serif" }}>
        <span style={{ width: 7, height: 7, borderRadius: "50%", flex: "0 0 auto", background: seat?.color || "#3ddc84", boxShadow: `0 0 8px ${seat?.color || "rgba(61,220,132,0.8)"}` }} />
        <span>{account.name}</span>
        <span style={{ color: "rgba(200,215,255,0.45)", fontSize: 9 }}>▼</span>
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
          <button onClick={onSignOut} style={shellBtn("danger", { width: "100%", marginTop: onProfile ? 8 : 12, padding: "9px", letterSpacing: "0.1em" })}>Sign out</button>
        </div>
      </>}
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
      style={{ position: "relative", width: 56, height: 28, flex: "0 0 auto", background: on ? c + "26" : "rgba(255,255,255,0.05)", border: `1px solid ${on ? c : "rgba(120,150,220,0.35)"}`, clipPath: SHELL_NOTCH(7), cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.45 : 1, padding: 0, boxShadow: on ? `0 0 14px ${c}44` : "none", transition: "all 160ms" }}>
      <span style={{ position: "absolute", top: 3, left: on ? 31 : 3, width: 20, height: 20, background: on ? c : "rgba(200,215,255,0.35)", clipPath: SHELL_NOTCH(5), transition: "left 160ms ease" }} />
    </button>
  );
}

// First-time onboarding — shown when a profile-less player flips "I'm playing".
// Explains the one-time setup, embeds the scouting editor, and auto-continues
// (applies them) on save so they never have to hunt for the toggle again.
function FirstTimeOnboard({ ev, wantCap, onClose, onApplied }) {
  const [phase, setPhase] = useState("intro"); // intro → edit → applying
  const [note, setNote] = useState("");
  const draftLine = ev?.draft_at
    ? new Date(ev.draft_at).toLocaleDateString(undefined, { weekday: "short" }) + " " + new Date(ev.draft_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : null;

  // Profile saved → show the commitment terms, then enter them.
  function afterSave() { setPhase("terms"); }

  async function applyNow() {
    setPhase("applying"); setNote("");
    try {
      const { error } = await __sb.rpc("volt_apply", { p_event: ev.id, p_wants_captain: !!wantCap });
      if (error) throw error;
      onApplied && await onApplied();
      onClose();
    } catch (e) { setNote(e.message || "Could not enter you in — try the toggle again."); setPhase("edit"); }
  }

  const step = (n, label, active, done) => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 22, height: 22, display: "grid", placeItems: "center", borderRadius: "50%", fontSize: 11, fontWeight: 700, fontFamily: "'IBM Plex Mono',monospace",
        background: done ? "#3ddc84" : active ? "rgba(61,123,255,0.2)" : "rgba(255,255,255,0.05)",
        color: done ? "#06210f" : active ? "#7da6ff" : "rgba(200,215,255,0.4)", border: `1px solid ${done ? "#3ddc84" : active ? "#3d7bff" : "rgba(120,150,220,0.25)"}` }}>{done ? "✓" : n}</span>
      <span style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: active || done ? "#ecf3ff" : "rgba(200,215,255,0.4)" }}>{label}</span>
    </div>
  );

  return (
    <VoltOverlay onClose={onClose} zIndex={130} dim="rgba(4,6,12,0.85)">
      <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 540, maxHeight: "90vh", overflowY: "auto", background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)", clipPath: SHELL_NOTCH(16), padding: "26px 26px 24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <div style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// Welcome to the league</div>
          <button onClick={onClose} style={shellBtn("ghost", { padding: "5px 11px", fontSize: 11 })}>✕</button>
        </div>

        {/* step rail */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "16px 0 20px", flexWrap: "wrap" }}>
          {step(1, "Your stats", phase === "intro" || phase === "edit", false)}
          <span style={{ flex: 1, height: 1, minWidth: 20, background: "rgba(120,150,220,0.2)" }} />
          {step(2, "You're in", phase === "applying", false)}
        </div>

        {phase === "intro" && <>
          <div style={{ fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.1 }}>Set up your scouting profile</div>
          <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "rgba(200,215,255,0.7)", marginTop: 10 }}>
            This is a <b style={{ color: "#7da6ff" }}>one-time setup</b>. Captains study it at the auction to decide who to draft, and it powers your player card and radar. You won't fill this in again — it carries across every tournament, and your match stats stack onto it automatically as you play.
          </p>
          <div style={{ display: "grid", gap: 12, margin: "18px 0", padding: "16px 18px", background: "rgba(10,16,30,0.6)", border: "1px solid rgba(61,123,255,0.22)", clipPath: SHELL_NOTCH(8) }}>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(210,222,255,0.82)" }}><b style={{ color: "#ecf3ff" }}>Required:</b> rank, role, a connected Discord and a WhatsApp number. Everything else (agent, KDA, ACS, tracker link) sharpens your card but is optional.</div>
            <div style={{ fontSize: 13.5, lineHeight: 1.6, color: "rgba(210,222,255,0.82)" }}><b style={{ color: "#ecf3ff" }}>Then you're entered</b> — available for the draft{draftLine ? ` (${draftLine})` : ""} and up to 4 matches this tournament.</div>
          </div>
          <button onClick={() => setPhase("edit")} style={shellBtn("primary", { width: "100%", padding: "13px", letterSpacing: "0.14em" })}>Set up my profile →</button>
        </>}

        {phase === "edit" && <>
          <div style={{ fontSize: 18, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", marginBottom: 4 }}>Your scouting profile</div>
          <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", marginBottom: 14 }}>Rank, role, a connected Discord and WhatsApp are required. Save to enter the tournament.</p>
          <ScoutProfileCard userId={window.__VOLT.userId} onSaved={afterSave} embedded />
          {note && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>{note}</div>}
        </>}

        {phase === "terms" && (
          <RegisterTerms ev={ev} onAccept={applyNow} onClose={() => setPhase("edit")} />
        )}

        {phase === "applying" && (
          <div style={{ textAlign: "center", padding: "30px 0" }}>
            <div className="vg-loading" style={{ fontSize: 14 }}>// Entering you in the pool…</div>
          </div>
        )}
      </div>
    </VoltOverlay>
  );
}

// The weekly ritual, one tap: OFF → PENDING (amber) → IN ✓ (green).
// Flipping on IS the application (availability implied); veterans with 2+
// ── Modal shell — portals to <body> so a parent's clip-path (our notched
//    cards) can never clip it. Every full-screen overlay should use this.
function VoltOverlay({ onClose, zIndex = 140, children, dim = "rgba(4,6,12,0.86)" }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && onClose) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex, background: dim, display: "grid", placeItems: "center", padding: 20 }}>
      {children}
    </div>,
    document.body
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
    try { await onSave({ starts_on: startYmd, ends_on: effectiveEnd, weekend_label: nick.trim() || null }); onClose(); }
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
function RegisterTerms({ ev, onAccept, onClose }) {
  const [ok, setOk] = useState(false);
  const line = (children) => (
    <li style={{ display: "flex", gap: 11, alignItems: "flex-start", fontSize: 14.5, lineHeight: 1.68, color: "rgba(214,226,255,0.85)" }}>
      <span style={{ color: "#5b8dff", flex: "0 0 auto", marginTop: 2 }}>▪</span><span>{children}</span>
    </li>
  );
  return (
    <VoltOverlay onClose={onClose} zIndex={140}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "90vh", overflowY: "auto", padding: "26px 28px 24px",
        background: "linear-gradient(160deg, rgba(20,26,42,0.98), rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.45)",
        clipPath: SHELL_NOTCH(16), fontFamily: "'Rajdhani',sans-serif" }}>
        <div className="flex items-center justify-between gap-3">
          <span style={{ fontSize: 11, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// Before you register</span>
          <button onClick={onClose} style={{ background: "none", border: "1px solid rgba(120,150,220,0.3)", color: "rgba(200,215,255,0.6)", padding: "3px 10px", fontSize: 11, cursor: "pointer" }}>✕</button>
        </div>

        <h3 style={{ fontSize: 24, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.2, margin: "18px 0 8px" }}>
          You're committing to <span style={{ color: "#f5c453" }}>Sat &amp; Sun, 7PM–2AM PKT</span>
        </h3>
        <p style={{ fontSize: 14.5, lineHeight: 1.7, color: "rgba(205,219,255,0.75)", margin: "0 0 20px" }}>
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
          <span style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.55, color: ok ? "#ecf3ff" : "rgba(200,215,255,0.75)" }}>
            I'm available and reachable for the full window, and I understand the strike policy.
          </span>
        </label>

        <button disabled={!ok} onClick={onAccept}
          style={{ width: "100%", marginTop: 18, padding: "15px", fontSize: 14, fontWeight: 700, letterSpacing: "0.18em", textTransform: "uppercase",
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
  const [terms, setTerms] = useState(false);      // availability + strike policy gate
  const status = mine ? (mine.status || "approved") : null;
  const on = status === "pending" || status === "approved";
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
      if (!profileComplete) { setOnboard(true); return; } // first-timer → guided setup + auto-continue
      setTerms(true);                                     // must accept the commitment each tournament
      return;
    } else {
      if (status === "approved" && !window.confirm(`Drop out of ${weekendName(ev)}? Your spot opens up — captains won't be able to draft you.`)) return;
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
    try { const { error } = await __sb.rpc("volt_apply", { p_event: ev.id, p_wants_captain: wantCap }); if (error) throw error; onChanged && await onChanged(); }
    catch (e) { setNote(e.message || "Could not apply."); }
    setBusy(false);
  }

  async function flipCap() {
    if (busy || rejected) return;
    const v = !capOn;
    if (!mine) { setWantCap(v); return; }
    setBusy(true);
    try { const { error } = await __sb.rpc("volt_wants_captain", { p_event: ev.id, p_v: v }); if (error) throw error; onChanged && await onChanged(); }
    catch (e) { console.error(e); }
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
      <div style={{ fontSize: 11.5, lineHeight: 1.45, color: "rgba(200,215,255,0.55)", marginTop: -4 }}>
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
        <div style={{ fontSize: 11, color: strikes % 2 === 1 ? "#ff8f9a" : "#f5c453", fontWeight: 600 }}>
          ⚠ {strikes} no-show{strikes === 1 ? "" : "s"} on record{strikes % 2 === 1 ? " — one more triggers a 2-tournament suspension" : ""}</div>
      )}
      {!rejected && susp === 0 && (
        <div style={row}>
          <span style={{ ...label, fontSize: compact ? 12 : 13, color: capOn ? "#7da6ff" : "rgba(200,215,255,0.6)" }}>I'll captain <span style={{ fontWeight: 500, textTransform: "none", letterSpacing: 0, color: "rgba(200,215,255,0.4)" }}>(the host decides)</span></span>
          <ToggleSwitch on={capOn} color="#3d7bff" disabled={busy} onClick={flipCap} />
        </div>
      )}
      {note && <div style={{ fontSize: 11.5, color: "#f5c453" }}>{note}</div>}
      {onboard && <FirstTimeOnboard ev={ev} wantCap={wantCap} onClose={() => setOnboard(false)} onApplied={onChanged} />}
      {terms && <RegisterTerms ev={ev} onAccept={doApply} onClose={() => setTerms(false)} />}
    </div>
  );
}

// Batch notification insert — fire-and-forget, host-side actions only.
async function voltNotify(rows) {
  try { if (HAS_SUPABASE && rows && rows.length) await __sb.from("notifications").insert(rows); }
  catch (e) { console.error("notify", e); }
}

const NOTIF_GLYPH = { approved: "✓", rejected: "✕", captain: "★", settled: "🏆", weekend_open: "▸", suspension: "⚠", new_application: "◈" };
const NOTIF_COLOR = { approved: "#3ddc84", rejected: "#ff4655", captain: "#f5c453", settled: "#f5c453", weekend_open: "#3ddc84", suspension: "#ff4655", new_application: "#f5c453" };

function NotifBell() {
  const [rows, setRows] = useState([]);
  const [open, setOpen] = useState(false);
  async function pull() {
    try {
      const { data } = await __sb.from("notifications").select("*").eq("user_id", window.__VOLT.userId).order("created_at", { ascending: false }).limit(15);
      setRows(data || []);
    } catch (e) { console.error(e); }
  }
  useEffect(() => { pull(); const stop = visInterval(pull, 20000); return () => stop(); }, []);
  const unread = rows.filter(r => !r.read).length;
  async function openPanel() {
    const v = !open; setOpen(v);
    if (v && unread) {
      try { await __sb.from("notifications").update({ read: true }).eq("user_id", window.__VOLT.userId).eq("read", false); } catch (e) {}
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
        ◈
      </button>
      {open && (
        <div style={{ position: "absolute", right: 0, top: "calc(100% + 8px)", width: 320, maxHeight: 400, overflowY: "auto", zIndex: 130, background: "linear-gradient(160deg,rgba(20,26,42,0.98),rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.4)", clipPath: SHELL_NOTCH(10), padding: "12px 14px", boxShadow: "0 20px 50px rgba(0,0,0,0.6)" }}>
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
    if (!window.confirm(isMod
      ? `Remove ${name} as moderator? They'll go back to being a player.`
      : `Make ${name} a moderator? They'll be able to approve players, assign captains, build brackets and report scores — but not settle or delete tournaments, run the live auction, or change roles.`)) return;
    setBusy(true); setErr("");
    try {
      const { error } = await __sb.from("users").update({ role: next }).eq("id", userId);
      if (error) throw error;
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

function PlayerProfile({ userId, onBack, footer }) {
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
  const acsRows = mrs.map(x => Number(x.stat_payload?.acs || 0)).filter(Boolean);
  const avgAcs = acsRows.length ? Math.round(acsRows.reduce((a, b) => a + b, 0) / acsRows.length) : null;
  const winRate = mrs.length ? Math.round(wins / mrs.length * 100) : null;
  const evMap = {}; evs.forEach(e => { evMap[e.id] = e; });
  const champEvents = evs.filter(e => Array.isArray(e.recap?.ids) && e.recap.ids.includes(userId));
  const byWeekend = {};
  mrs.forEach(x => { const w = (byWeekend[x.event_id] = byWeekend[x.event_id] || { pts: 0, m: 0, w: 0 }); w.pts += Number(x.points_computed || 0); w.m++; if (x.team_won) w.w++; });
  const weekendRows = Object.entries(byWeekend).sort((a, b) => new Date(evMap[a[0]]?.created_at || 0) - new Date(evMap[b[0]]?.created_at || 0));

  // Radar wants raw kda/acs/hs/win/rank — feed the scouting-profile numbers.
  const radarPlayer = { kda: Number(p.kda) || 0, acs: Number(p.acs) || 0, hs: Number(p.hs) || 0, win: Number(p.win) || 0, rank };
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

      {/* HERO — two equal panels, identity + radar, matched heights */}
      <style>{`@media (max-width: 720px){ .volt-hero-grid{ grid-template-columns: 1fr !important; } }`}</style>
      <div className="volt-hero-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap: 16, alignItems: "stretch" }}>
        <div style={{ position: "relative", clipPath: NOTCH, padding: 14, overflow: "hidden", minHeight: 300, display: "flex", flexDirection: "column", gap: 12,
          background: "linear-gradient(160deg, rgba(20,26,42,0.92), rgba(10,13,22,0.92))", border: `1px solid ${hue}66`, boxShadow: "0 0 0 1px rgba(255,255,255,0.04) inset" }}>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0 1px, transparent 1px 4px)" }} />

          {/* identity panel — contained gradient, watermark lives INSIDE it (no bleed) */}
          <div style={{ position: "relative", overflow: "hidden", borderRadius: 14, padding: "22px 22px 18px", border: "1px solid rgba(255,255,255,0.08)",
            background: `linear-gradient(120deg, ${hue}3a, ${hue}18 55%, rgba(10,13,22,0.35))` }}>
            <span style={{ position: "absolute", right: -8, top: -22, fontSize: 128, fontWeight: 800, lineHeight: 1, letterSpacing: "-0.04em", color: "rgba(255,255,255,0.07)", fontFamily: "'Rajdhani',sans-serif", pointerEvents: "none", userSelect: "none" }}>{avgAcs || p.acs || ""}</span>
            {(avgAcs || p.acs) ? <span style={{ position: "absolute", right: 16, top: 96, fontSize: 10, letterSpacing: 3, fontWeight: 700, color: "rgba(255,255,255,0.16)", fontFamily: "'Rajdhani',sans-serif" }}>ACS</span> : null}
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
            {[["Season pts", String(pts), "#f5c453"], ["Win rate", winRate != null ? winRate + "%" : "—", "#3ddc84"], ["Trophies", "🏆×" + (u.trophy_streak || 0), "#f5c453"]].map(([lb, v, c], i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "12px 6px", borderRadius: 8, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}>
                <span style={{ fontSize: 20, fontWeight: 700, lineHeight: 1, color: c, fontFamily: "'Rajdhani',sans-serif", textShadow: `0 0 14px ${c}66` }}>{v}</span>
                <span style={{ fontSize: 9.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(236,243,255,0.5)", fontWeight: 600 }}>{lb}</span>
              </div>
            ))}
          </div>

          {/* scouting stats — value-first, exactly the card's Stat treatment */}
          {hasScout ? (
            <div style={{ position: "relative", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginTop: "auto" }}>
              {[["KDA", p.kda != null ? p.kda : null, "#00e5ff"], ["ACS", p.acs != null ? p.acs : null, "#ff4655"], ["HS %", p.hs != null ? p.hs + "%" : null, "#9d6bff"], ["WIN %", p.win != null ? p.win + "%" : null, "#3ddc84"]].map(([lb, v, c], i) => (
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
        {bigTile("Avg ACS", avgAcs, "#ff4655")}
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
                  {won && <span style={{ color: "#f5c453", marginLeft: 8, fontSize: 12 }}>🏆 champion</span>}</span>
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
                            if (!window.confirm("Discount this strike? It stops counting toward a suspension and lifts any active ban.")) return;
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
      {footer}
    </div>
  );
}

function HubRail({ community, target, onEnter, onAccount, isHost, wide, setWide }) {
  const [tip, setTip] = useState(null);
  const [soundOn, setSoundOn] = useState(() => { try { return localStorage.getItem("volt_sound") !== "0"; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem("volt_sound", soundOn ? "1" : "0"); } catch {} }, [soundOn]);
  const W = wide ? 224 : 60;
  const enterable = !!target; // a tournament you can actually open (draft/matches/reg-closed)
  const mark = (community?.name || "V").slice(0, 1).toUpperCase();

  const item = (glyph, label, { onClick, disabled, accent, liveDot } = {}) => (
    <button key={label} disabled={disabled} onClick={disabled ? undefined : onClick}
      className="volt-rail-item flex items-center"
      onMouseEnter={e => { if (!wide) setTip({ label: disabled ? label + " — enter a live tournament first" : label, y: e.currentTarget.getBoundingClientRect().top + 21 }); }}
      onMouseLeave={() => setTip(null)}
      style={{ width: wide ? W - 16 : 44, height: 42, justifyContent: wide ? "flex-start" : "center", gap: 10, paddingLeft: wide ? 12 : 0, paddingRight: wide ? 10 : 0, background: "none", border: "none", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.32 : 1, color: accent || "rgba(200,215,255,0.72)", position: "relative", margin: wide ? 0 : "0 auto" }}>
      <span className="volt-rail-glyph" style={{ fontSize: 16, transition: "color .12s", position: "relative" }}>{glyph}
        {liveDot && <span style={{ position: "absolute", top: -2, right: -4, width: 6, height: 6, borderRadius: "50%", background: "#af9aec", boxShadow: "0 0 6px #af9aec" }} />}</span>
      {wide && <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: "0.12em", textTransform: "uppercase", whiteSpace: "nowrap" }}>{label}</span>}
    </button>
  );
  const divider = (mt = 8, mb = 8) => <div style={{ width: wide ? "auto" : 26, height: 1, margin: wide ? `${mt}px 6px ${mb}px` : `${mt}px auto ${mb}px`, background: "rgba(120,150,220,0.2)" }} />;
  const secLabel = (t) => wide && <div style={{ fontSize: 10, letterSpacing: "0.3em", textTransform: "uppercase", color: "rgba(120,150,220,0.55)", fontWeight: 700, padding: "2px 12px 6px" }}>// {t}</div>;

  const go = (view) => enterable && onEnter(target, view);
  const leagueViews = NAV.map(n => item(n.glyph, n.label, { onClick: () => go(n.id), disabled: !enterable, liveDot: n.id === "block" && target?.phase === "drafting" }));
  const tourneyViews = TOURNEY_NAV.filter(n => !n.adminOnly || isHost).map(n => item(n.glyph, n.label, { onClick: () => go(n.id), disabled: !enterable }));

  return (
    <nav aria-label="League" style={{ position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 40, width: W, display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", padding: wide ? "12px 8px 14px" : "12px 0 14px", background: "linear-gradient(180deg, rgba(12,17,30,0.98), rgba(7,10,18,0.98))", borderRight: "1px solid rgba(61,123,255,0.22)", fontFamily: "'Rajdhani',sans-serif", transition: "width .18s cubic-bezier(.2,.8,.3,1)", overflowY: "auto", overflowX: "hidden" }}>
      <style>{`.volt-rail-item:hover .volt-rail-glyph { color: #eaf1ff !important; } @keyframes voltTipIn { from { opacity: 0; transform: translateY(-50%) translateX(-8px); } to { opacity: 1; transform: translateY(-50%) translateX(0); } }`}</style>
      {/* league mark + collapse toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: wide ? "space-between" : "center", gap: 8, marginBottom: 4, paddingLeft: wide ? 4 : 0 }}>
        <div className="flex items-center gap-2" style={{ minWidth: 0 }}>
          <span className="grid place-items-center shrink-0" style={{ width: 42, height: 42, clipPath: "polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px))", background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)" }}>
            <span style={{ fontSize: 19, fontWeight: 700, color: "#3d7bff", textShadow: "0 0 12px rgba(61,123,255,0.8)" }}>{mark}</span>
          </span>
          {wide && <span style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: "#3d7bff", textShadow: "0 0 14px rgba(61,123,255,0.6)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{community?.name || "VOLT"}</span>}
        </div>
        {wide && <button onClick={() => setWide(false)} aria-label="Collapse" title="Collapse" style={{ width: 26, height: 26, display: "grid", placeItems: "center", color: "rgba(200,215,255,0.55)", border: "1px solid rgba(120,150,220,0.25)", background: "rgba(255,255,255,0.03)", clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))", fontSize: 12 }}>«</button>}
      </div>
      {!wide && <button onClick={() => setWide(true)} aria-label="Expand" title="Expand menu" className="volt-expand-btn grid place-items-center"
        onMouseEnter={e => setTip({ label: "Expand menu", y: e.currentTarget.getBoundingClientRect().top + 15 })} onMouseLeave={() => setTip(null)}
        style={{ width: 34, height: 30, margin: "2px auto 0", cursor: "pointer", color: "#9dc0ff",
          background: "rgba(61,123,255,0.14)", border: "1px solid rgba(61,123,255,0.5)",
          clipPath: "polygon(0 0, calc(100% - 6px) 0, 100% 6px, 100% 100%, 6px 100%, 0 calc(100% - 6px))" }}><span style={{ fontSize: 14, fontWeight: 700, lineHeight: 1 }}>»</span></button>}
      <div style={{ width: wide ? "auto" : 26, height: 1, margin: wide ? "8px 6px 10px" : "8px auto 10px", background: "rgba(61,123,255,0.35)" }} />

      {/* live-tournament entry — the inverse of the in-tournament portal button */}
      {item(enterable ? "▸" : "○", enterable ? "Live tournament" : "No live tournament", { onClick: () => enterable && onEnter(target), disabled: !enterable, accent: enterable ? "#af9aec" : undefined })}

      {divider()}
      {secLabel("League")}
      <div style={{ display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", gap: 2 }}>{leagueViews}</div>
      {tourneyViews.length > 0 && <>{divider()}{secLabel("Tournament")}
        <div style={{ display: "flex", flexDirection: "column", alignItems: wide ? "stretch" : "center", gap: 2 }}>{tourneyViews}</div></>}

      <div style={{ marginTop: "auto" }} />
      {divider()}
      {onAccount && item("◉", "My Account", { onClick: onAccount, accent: "rgba(200,215,255,0.72)" })}
      <button onClick={() => setSoundOn(v => !v)} className="volt-rail-item flex items-center" aria-label={soundOn ? "Mute" : "Unmute"}
        onMouseEnter={e => { if (!wide) setTip({ label: soundOn ? "Sound on" : "Sound off", y: e.currentTarget.getBoundingClientRect().top + 20 }); }} onMouseLeave={() => setTip(null)}
        style={{ width: wide ? W - 16 : 42, height: 40, justifyContent: wide ? "flex-start" : "center", gap: 10, paddingLeft: wide ? 12 : 0, color: soundOn ? "#7da6ff" : "rgba(180,195,225,0.4)", margin: wide ? 0 : "0 auto", background: "none", border: "none", cursor: "pointer" }}>
        <span style={{ fontSize: 15 }}>{soundOn ? "🔊" : "🔇"}</span>
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
            <input value={guild} onChange={(e) => setGuild(e.target.value)} placeholder="1192148403031908452" style={field} />
          </label>
          <label style={{ display: "block", marginBottom: 12 }}>
            <span style={{ display: "block", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", marginBottom: 4 }}>Announcements channel ID</span>
            <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="1534683642415153233" style={field} />
          </label>
          <div className="flex items-center gap-3 flex-wrap" style={{ gap: 10 }}>
            <button disabled={busy} onClick={() => save(false)} style={shellBtn("primary", { padding: "9px 16px", fontSize: 12, opacity: busy ? 0.5 : 1 })}>
              {busy ? "…" : connected ? "Update" : "Connect"}
            </button>
            {connected && (
              <button disabled={busy} onClick={() => { if (window.confirm("Disconnect Discord? Players stop getting DMs and announcements.")) save(true); }}
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
  const dcLinked = useDiscordLinked();
  useEffect(() => { (async () => {
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
  })(); }, [eventId]);

  const silent = d?.silent || [];
  if (!d?.asked && !unlinked.length) return null;
  return (
    <div style={{ marginTop: 14 }}>
      <SectionHead title="Who we can reach" />
      <div style={PANEL((silent.length || unlinked.length) ? "rgba(245,196,83,0.4)" : "rgba(61,220,132,0.3)")}>
        {d?.asked && (
          <div style={{ fontSize: 13.5, color: "#9af5c2", fontWeight: 700 }}>
            ✓ {d.confirmed} confirmed for the draft
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

  async function run() {
    setBusy(true); setErr(""); setRes(null);
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch("/api/discord-teams", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ eventId, assignRoles: roles }),
      });
      const b = await r.json().catch(() => null);
      if (!r.ok) throw new Error(b?.error || `Failed (${r.status})`);
      setRes(b);
    } catch (e) { setErr(e.message || "Couldn't send."); }
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
            {busy ? "Sending…" : "Send team DMs"}
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
  const [scope, setScope] = useState("approved");
  const [counts, setCounts] = useState({});          // scope → how many that reaches
  // What the recipient can tap. Explicit rather than inferred from the audience,
  // because "who gets it" and "what can they do about it" are separate decisions.
  const [reply, setReply] = useState("none");
  // Where it lands. A draft reminder wants DMs; "sign-ups are open" wants the
  // channel, where people who aren't in the league yet can still see it.
  const [deliver, setDeliver] = useState("both");
  const sendsDM = deliver !== "channel";
  const sendsChannel = deliver !== "dm";
  const regOpen = phase === "registration_open";
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
  useEffect(() => {
    let dead = false;
    (async () => {
      const out = {};
      for (const [k] of SCOPES) {
        try {
          const { data } = await __sb.rpc("volt_notify_targets", { p_event: eventId, p_scope: k });
          out[k] = { total: data?.userIds?.length || 0, unlinked: data?.unlinked || 0 };
        } catch (e) { console.error("target preview", k, e); }
      }
      if (!dead) setCounts(out);
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
      const r = await fetch("/api/discord-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        // dmButtons puts the row in the DM itself — the point of asking a question
        // is that answering costs one tap, not a trip back to the app.
        body: JSON.stringify({ communityId, message: msg.trim(),
                               userIds: sendsDM ? (t?.userIds || []) : [],
                               announce: sendsChannel,
                               buttons: reply === "none" ? undefined : reply,
                               dmButtons: reply === "none" || !sendsDM ? undefined : true }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
      // Stamp the event so "Who we can reach" starts counting replies. Without
      // this the card never appears no matter how many people answer.
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
      <SectionHead title="Message the league" hint="DMs the audience you pick, and posts to your channel" />
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
        {result && (
          <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
            {result.delivered > 0
              ? <span style={{ color: "#9af5c2" }}>✓ DM'd {result.delivered}</span>
              : <span style={{ color: "#9af5c2" }}>✓ Sent</span>}
            {result.announced && <span style={{ color: "rgba(200,215,255,0.5)" }}> · posted to the channel</span>}
            {result.blocked?.length > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {result.blocked.length} have DMs closed — they were @mentioned in the channel instead.</div>}
            {result.unlinked?.length > 0 && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ {result.unlinked.length} haven't connected Discord yet — they got nothing.</div>}
            {!result.announced && !result.delivered && <div style={{ color: "rgba(245,196,83,0.9)" }}>⚠ Nothing was delivered. Check your announcements channel is set under Discord server.</div>}
          </div>
        )}
        {err && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {err}</div>}
      </div>
    </div>
  );
}

// Every "Connect Discord" entry point goes through here so they behave the same:
// hand Discord a signed token identifying this VOLT account and let it redirect.
async function startDiscordOAuth() {
  const { data: sess } = await __sb.auth.getSession();
  const jwt = sess?.session?.access_token;
  if (!jwt) throw new Error("Session expired — sign in again.");
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
  add("**You don't need a team.** Sign up on your own, captains bid for you at a live auction, " +
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
    add("Tap the button below. That's it — you're in the pool.", "");
  }

  add("## First time here?", "");
  add(`**1. Make your account** — ${link}`);
  add("> The join code is already filled in. Takes about a minute.");
  add("**2. Fill in your profile** — your rank, your role, and a WhatsApp number.");
  add("> Quickest way: paste a screenshot of your tracker.gg Competitive page and it reads your stats for you.");
  add("> Your number is only ever seen by the host and mods, and only if a match is falling apart.");
  if (connected) {
    add("**3. Press Connect Discord** on your profile.");
    add("> One click, no code to type. It's how you hear when the draft starts and which team picked you.");
    add("");
    add("Then tap the button below. If you get stuck, tap it anyway — it'll tell you what's missing.");
  } else {
    add("**3. Flip “I'm playing this tournament”** on the site.");
    add("> ⚠ This league hasn't connected its Discord server yet, so sign-ups happen on the site for now.");
  }
  add("");

  add("**Worth knowing:**", "");
  add("· Captains see your rank and stats when they bid, so put down an honest one — it gets you a fairer price.");
  add("· The day before the draft I'll ask if you're still free. **Answer it.** " +
      "Pulling out costs you nothing; going quiet and not showing up is a no-show.");
  add("· Your first tournament gets reviewed by the host. After two clean ones you're approved instantly.");
  add("");

  if (connected) {
    add("`/me` your stats · `/roster` your team · `/leaderboard` the season · " +
        "`/subs` who's free · `/scout` look up a player", "");
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
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  useEffect(() => {
    if (!open || connected !== null) return;
    (async () => {
      try {
        const { data } = await __sb.rpc("volt_get_discord");
        setConnected(!!(data?.guild && data?.channel));
        setHasSignup(!!data?.signupChannel);
      } catch (e) { console.error("guide discord", e); setConnected(false); }
    })();
  }, [open, connected]);

  const text = buildJoinGuide({ community, current, connected: !!connected, origin });

  // `where` is either the announcements channel the host already set, or a
  // dedicated #sign-up-here the bot creates. A guide buried in announcements
  // scrolls away in a week, which is the whole reason for the second option.
  async function post(where) {
    setBusy(where); setErr(""); setRes("");
    try {
      const { data: sess } = await __sb.auth.getSession();
      const jwt = sess?.session?.access_token;
      if (!jwt) throw new Error("Session expired — sign in again.");
      const r = await fetch("/api/discord-notify", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        // No userIds: this is a channel post, not a DM blast. DMing a reference
        // people come back to would be spam.
        body: JSON.stringify({ communityId: community?.id, message: text,
                               userIds: [], announce: true, buttons: "welcome",
                               embed: true, pin: true,
                               channelName: where === "signup" ? "sign-up-here" : undefined }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Failed (${r.status})`);
      // Remember the channel so a second run reuses it instead of hunting again.
      if (body?.channelId) {
        try { await __sb.rpc("volt_set_signup_channel", { p_channel: body.channelId }); setHasSignup(true); }
        catch (e) { console.error("save signup channel", e); }
      }
      const dest = where === "signup" ? "#sign-up-here" : "your announcements channel";
      if (!body?.announced) setErr("Couldn't post — check your announcements channel is set under Discord server.");
      else if (body.pinned) setRes(`Posted and pinned to ${dest}.`);
      // Failing to pin is not failing to post, so it reads as a footnote.
      else setRes(`Posted to ${dest}. Couldn't pin it — ` + (body.pinError || "pin it yourself") + ".");
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
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)" }}>
              {connected
                ? "Posting attaches the sign-up button and pins it. A pasted copy can't have either — only the bot can."
                : "Connect your Discord server above and the bot can post this itself, with a sign-up button attached."}
            </span>
          </div>
          <div style={{ fontSize: 11, color: text.length > DISCORD_MSG_LIMIT ? "#f5c453" : "rgba(200,215,255,0.3)",
            marginTop: 8, fontFamily: "'IBM Plex Mono',monospace" }}>
            {text.length} / {DISCORD_MSG_LIMIT} characters
            {text.length > DISCORD_MSG_LIMIT && " — too long to paste by hand; use “Post it for me” instead"}
          </div>
          {res && <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 10 }}>✓ {res}</div>}
          {err && <div style={{ fontSize: 12, color: "#ff8f9a", marginTop: 10 }}>⚠ {err}</div>}
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
function LeagueLedger({ onOpenPlayer }) {
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
    <div style={{ marginTop: 42 }}>
      <SectionHead title="Transactions" hint="Every roster move, newest first" />
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
    const typed = window.prompt(
      `Transfer ownership of this league to ${name}?\n\n` +
      `They become the host with full control. You become a moderator — you keep ` +
      `approvals, brackets and scores, but you can no longer settle or delete tournaments, ` +
      `run the auction, or change roles. Only ${name} can give it back.\n\n` +
      `Type their name to confirm:`);
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
                      onClick={() => { if (window.confirm(
                        `Make ${u.display_name || "this player"} a host?\n\n` +
                        `They get full control: settling and deleting tournaments, resetting the auction, league settings, and changing anyone's role — including yours.\n\n` +
                        `You stay a host too. Do this before handing the league over, since a league can't be left without one.`
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

function WeekendSchedule({ community, isHost, isTrueHost, account, onSignOut, onEnter, openProfile, onProfileOpened }) {
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [season, setSeason] = useState(null); // aggregated captain standings across tournaments
  const [board, setBoard] = useState(null);   // player points leaderboard (match_results)
  const [live, setLive] = useState(null);     // { count, mine } — registrations for the current tournament
  const [showProfile, setShowProfile] = useState(false);
  const [editTime, setEditTime] = useState(false);
  const [draftAtDraft, setDraftAtDraft] = useState(null); // controlled value for the draft-time picker
  const [setupWeekend, setSetupWeekend] = useState(null); // { mode:"create"|"edit", ev }
  const [myRegs, setMyRegs] = useState({});   // eventId → my registration row (open tournaments)
  const [pendingByEvent, setPendingByEvent] = useState({}); // host: eventId → # awaiting review
  const [myProf, setMyProf] = useState(null); // rank/role — gates the play toggle
  const [mySusp, setMySusp] = useState(0);
  const [myStrikes, setMyStrikes] = useState(0);
  const [showPlayer, setShowPlayer] = useState(null); // public player-profile screen (full-screen, rail intact)
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
      const { data: ns } = await __sb.from("registrations").select("id")
        .eq("community_id", window.__VOLT.communityId).eq("user_id", window.__VOLT.userId).eq("no_show", true);
      setMyStrikes((ns || []).length);
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

  // Player season leaderboard: sum of every match's points (+50 win · ACS÷4 · K+⅓A).
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
    if (!window.confirm(`Delete ${weekendName(ev)}? This removes the tournament and its registrations. Reported match points are kept.`)) return;
    try {
      await __sb.from("registrations").delete().eq("event_id", ev.id);
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
  const RANK_ENTER = { matches_live: 4, drafting: 3, registration_closed: 2 };
  const railTarget = HAS_SUPABASE && Array.isArray(events)
    ? events.filter(e => RANK_ENTER[e.phase]).sort((a, b) => (RANK_ENTER[b.phase] - RANK_ENTER[a.phase]) || (new Date(a.created_at) - new Date(b.created_at)))[0] || null
    : null;
  const showRail = HAS_SUPABASE && hubDesk;
  const railPad = showRail ? (railWideHub ? 224 : 60) : 0;

  const wrap = (inner, hideHeader) => (
    <div className="vg-shell" style={{ minHeight: "100vh", background: "#0a0d18", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", padding: "0 0 40px", paddingLeft: railPad, transition: "padding-left .18s cubic-bezier(.2,.8,.3,1)" }}>
      <ShellStyles />
      {showRail && <HubRail community={community} target={railTarget} onEnter={onEnter} onAccount={() => setShowProfile(true)} isHost={isHost} wide={railWideHub} setWide={setRailWide} />}
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, padding: "14px 20px", borderBottom: "1px solid rgba(61,123,255,0.2)", background: "linear-gradient(180deg, rgba(12,17,30,0.95), rgba(9,12,21,0.9))" }}>
        {HAS_SUPABASE && <NotifBell />}
        {account && <AccountChip account={account} onSignOut={onSignOut} onProfile={HAS_SUPABASE ? () => setShowProfile(true) : null} />}
      </div>
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
      {showProfile && (
        <VoltOverlay onClose={() => setShowProfile(false)} zIndex={120} dim="rgba(4,6,12,0.8)">
          <div onClick={e => e.stopPropagation()} style={{ width: "100%", maxWidth: 560, maxHeight: "86vh", overflowY: "auto", background: "linear-gradient(160deg,rgba(20,26,42,0.98),rgba(10,13,22,0.98))", border: "1px solid rgba(61,123,255,0.4)", clipPath: SHELL_NOTCH(16), padding: "22px 24px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <span style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>// My scouting profile</span>
              <button onClick={() => setShowProfile(false)} style={shellBtn("ghost", { padding: "5px 10px", fontSize: 11 })}>✕</button>
            </div>
            <p style={{ color: "rgba(200,215,255,0.5)", fontSize: 12.5, margin: "0 0 6px" }}>Captains study this before bidding — keep it current between tournaments.</p>
            <ScoutProfileCard userId={window.__VOLT.userId} onSaved={loadMyMeta} />
            {HAS_SUPABASE && <DiscordLinkCard />}
          </div>
        </VoltOverlay>
      )}
      <div style={{ maxWidth: hideHeader ? 1000 : 840, margin: "0 auto", padding: hideHeader ? "16px 20px 0" : "34px 20px 0" }}>
        {!hideHeader && <div style={{ textAlign: "center", marginBottom: 30 }}>
          <div style={{ fontSize: 10, letterSpacing: "0.44em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase", textShadow: "0 0 14px rgba(61,123,255,0.6)" }}>// VOLT LEAGUE</div>
          <div style={{ fontSize: "clamp(32px, 5.2vw, 48px)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.04, marginTop: 8, textShadow: "0 0 40px rgba(61,123,255,0.35)" }}>
            {community?.name || "Community"}</div>
          {/* A short rule under the name gives the block a base line, so the join
              code pill reads as attached to it rather than floating. */}
          <div style={{ width: 88, height: 2, margin: "12px auto 0", background: "linear-gradient(90deg, rgba(61,123,255,0), #3d7bff, rgba(61,123,255,0))", opacity: 0.7 }} />
          {community?.slug && (
            <div style={{ display: "inline-flex", alignItems: "center", gap: 12, marginTop: 16, padding: "7px 8px 7px 15px", background: "rgba(61,123,255,0.07)", border: "1px solid rgba(61,123,255,0.28)", clipPath: SHELL_NOTCH(8) }}>
              <span style={{ fontSize: 9.5, letterSpacing: "0.2em", textTransform: "uppercase", color: "rgba(200,215,255,0.45)", fontWeight: 700 }}>Join code</span>
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 14, fontWeight: 700, color: "#ecf3ff", letterSpacing: "0.02em" }}>{community.slug}</span>
              <CopyButton text={community.slug} label="Copy" style={shellBtn("ghost", { padding: "5px 11px", fontSize: 9.5, letterSpacing: "0.16em" })} />
            </div>
          )}
          {events && events.length > 0 && (() => {
            const bits = [];
            bits.push(<span key="s"><b style={{ color: "#7da6ff", fontWeight: 700 }}>{events.filter(e => e.phase === "settled").length}</b> settled</span>);
            if (board) bits.push(<span key="p"><b style={{ color: "#7da6ff", fontWeight: 700 }}>{board.length}</b> on the board</span>);
            if (board && board[0]) bits.push(<span key="l">leader <b style={{ color: "#f5c453", fontWeight: 700, textTransform: "uppercase" }}>{board[0].name}</b> · {board[0].pts} pts</span>);
            return (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", flexWrap: "wrap", rowGap: 6, marginTop: 18, fontFamily: "'IBM Plex Mono',monospace", fontSize: 11.5, letterSpacing: "0.03em", color: "rgba(200,215,255,0.45)" }}>
                {bits.map((b, i) => <span key={i} style={{ padding: "0 15px", lineHeight: 1.15, borderLeft: i ? "1px solid rgba(120,150,220,0.22)" : "none" }}>{b}</span>)}
              </div>
            );
          })()}
        </div>}
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

  return wrap(<>
    {HAS_SUPABASE && <DiscordConnectBanner />}
    {events.length === 0
      ? <div style={{ textAlign: "center", padding: "30px 0", color: "rgba(200,215,255,0.6)" }}>
          <p>No tournaments yet.{isHost ? " Create the first one to start." : " Check back when your host opens a tournament."}</p>
        </div>
      : <div style={{ display: "grid", gap: 12, marginBottom: 22 }}>
          {current && (
            <div style={{ position: "relative", padding: "20px 24px 22px", background: "linear-gradient(160deg,rgba(24,32,54,0.95),rgba(10,13,22,0.95))", border: "1px solid rgba(61,123,255,0.45)", clipPath: SHELL_NOTCH(16), boxShadow: "0 0 40px rgba(61,123,255,0.12)" }}>
              <span style={{ position: "absolute", left: 0, top: 0, width: 10, height: 10, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
              <span style={{ position: "absolute", right: 0, bottom: 0, width: 10, height: 10, borderRight: "2px solid #3d7bff", borderBottom: "2px solid #3d7bff" }} />
              {/* Label rule spans the card and carries the host's edit/delete out
                  of the headline — they were breaking the title's line before. */}
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
                <span style={SEC_LABEL}>// This tournament</span>
                <span style={SEC_RULE} />
                {isHost && <>
                  <button onClick={() => setSetupWeekend({ mode: "edit", ev: current })} title="Edit date / nickname" style={shellBtn("ghost", { padding: "4px 9px", fontSize: 10, lineHeight: 1, opacity: 0.8 })}>✎</button>
                  <button onClick={() => deleteWeekend(current)} title="Delete tournament" style={shellBtn("danger", { padding: "4px 9px", fontSize: 10, lineHeight: 1, opacity: 0.8 })}>✕</button>
                </>}
              </div>
              <div className="volt-tourn-hero">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: "clamp(22px, 2.7vw, 31px)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em", lineHeight: 1.08 }}>{weekendName(current)}</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 11, flexWrap: "wrap", rowGap: 8 }}>
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
                        : <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.5)", lineHeight: 1.5 }}>No applications waiting. Approvals show up here.</span>}
                      <div style={{ display: "grid", gap: 8, marginTop: 2 }}>
                        <button onClick={() => onEnter(current)} style={shellBtn(live?.pending > 0 ? "warn" : "primary", { padding: "11px 16px", fontSize: 12 })}>Review applications →</button>
                        <button onClick={() => onEnter(current, "lobby")} style={shellBtn("ghost", { padding: "9px 16px", fontSize: 11 })}>⊞ Enter the tournament →</button>
                      </div>
                    </div>
                  : (current.phase === "registration_open" || current.phase === "registration_closed") && HAS_SUPABASE
                  ? <div style={{ display: "flex", flexDirection: "column", gap: 11, padding: "16px 17px", background: "rgba(8,12,24,0.6)", border: "1px solid rgba(61,123,255,0.25)", clipPath: SHELL_NOTCH(10) }}>
                      <PlayToggle ev={current} mine={myRegs[current.id]} profileComplete={profileIsComplete(myProf)} susp={mySusp} strikes={myStrikes}
                        onEditProfile={() => setShowProfile(true)} onChanged={load} />
                      <button onClick={() => onEnter(current, "lobby")} style={shellBtn("ghost", { padding: "9px 16px", fontSize: 11 })}>⊞ Enter the tournament →</button>
                    </div>
                  : <button onClick={() => onEnter(current)} style={shellBtn("primary", { padding: "15px 22px", fontSize: 13, width: "100%" })}>{heroCTA}</button>}
              </div>
              {myRegs[current.id]?.is_captain && (myRegs[current.id]?.status || "approved") === "approved" && (
                <div style={{ marginTop: 18, padding: "13px 16px", background: "rgba(245,196,83,0.08)", border: "1px solid rgba(245,196,83,0.55)", clipPath: SHELL_NOTCH(9), boxShadow: "0 0 24px rgba(245,196,83,0.12)" }}>
                  <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase", color: "#f5c453", textShadow: "0 0 12px rgba(245,196,83,0.6)" }}>★ You're a captain this tournament</span>
                  <span style={{ fontSize: 12, color: "rgba(200,215,255,0.6)", marginLeft: 10 }}>$10,000 budget{current.draft_at ? ` · draft ${fmtDraftAt(current.draft_at)}` : ""} — scout the pool, then run your auction.</span>
                </div>
              )}
            </div>
          )}
          {(() => {
            // Next tournament already open while this one runs → its toggle rides
            // right on home. The weekly rhythm on one screen.
            const nextReg = current?.phase !== "registration_open" && events.find(e => e.phase === "registration_open" && e.id !== current?.id);
            return nextReg && HAS_SUPABASE ? (
              <div style={{ padding: "16px 18px", background: "linear-gradient(160deg,rgba(16,24,40,0.9),rgba(10,13,22,0.9))", border: "1px solid rgba(61,220,132,0.3)", clipPath: SHELL_NOTCH(12) }}>
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
                        onEditProfile={() => setShowProfile(true)} onChanged={load} compact />
                    )}
                  </div>
                </div>
              </div>
            ) : null;
          })()}
          {upcoming.filter(e => !(current?.phase !== "registration_open" && e.phase === "registration_open")).map(ev => strip(ev, false))}
          {past.length > 0 && <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
              <div style={{ fontSize: 10, letterSpacing: "0.28em", textTransform: "uppercase", color: "rgba(200,215,255,0.35)", fontWeight: 700 }}>// Past tournaments</div>
              {/* Always-on history jump — pick any settled tournament, its recap opens. */}
              <select value="" onChange={e => { const id = e.target.value; if (id) { setExpandPast(id); const el = document.getElementById("volt-past-" + id); if (el) el.scrollIntoView({ behavior: "smooth", block: "center" }); } }}
                style={{ padding: "7px 30px 7px 12px", background: "rgba(10,16,30,0.8)", border: "1px solid rgba(61,123,255,0.35)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 12.5, fontWeight: 600, letterSpacing: "0.04em", clipPath: SHELL_NOTCH(6) }}>
                <option value="">Jump to a tournament…</option>
                {[...past].reverse().map(ev => <option key={ev.id} value={ev.id}>{weekendName(ev)}{ev.recap?.team ? " — 🏆 " + ev.recap.team : ""}</option>)}
              </select>
            </div>
            {past.map(ev => {
              const rc = ev.recap || null;
              const openIt = expandPast === ev.id;
              return (
                <div key={ev.id} id={"volt-past-" + ev.id} style={{ background: openIt ? "rgba(61,123,255,0.05)" : "rgba(255,255,255,0.02)", border: `1px solid ${openIt ? "rgba(61,123,255,0.35)" : "rgba(120,150,220,0.12)"}`, clipPath: SHELL_NOTCH(8), transition: "border-color .2s, background .2s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 16px", flexWrap: "wrap" }}>
                    <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 13.5, opacity: 0.75 }}>{weekendName(ev)}</span>
                    {rc?.team && <span style={{ fontSize: 11.5, color: "#f5c453", fontWeight: 700, letterSpacing: "0.06em" }}>🏆 {rc.team}</span>}
                    {rc?.mvp && <span style={{ fontSize: 11, color: "rgba(200,215,255,0.6)" }}>⭐ {rc.mvp}{rc.mvpPts ? " · " + rc.mvpPts : ""}</span>}
                    <span style={{ flex: 1 }} />
                    {rc && <button onClick={() => setExpandPast(openIt ? null : ev.id)} style={shellBtn("ghost", { padding: "5px 11px", fontSize: 10.5 })}>{openIt ? "Hide" : "Recap"}</button>}
                    {isHost && <>
                      <button onClick={() => setSetupWeekend({ mode: "edit", ev })} title="Edit date / nickname" style={shellBtn("ghost", { padding: "5px 8px", fontSize: 10 })}>✎</button>
                      <button onClick={() => deleteWeekend(ev)} title="Delete tournament" style={shellBtn("danger", { padding: "5px 8px", fontSize: 10 })}>✕</button>
                    </>}
                    <button onClick={() => onEnter(ev)} style={shellBtn("ghost", { padding: "6px 12px", fontSize: 11 })}>View →</button>
                  </div>
                  {openIt && rc && (
                    <div style={{ padding: "4px 16px 16px", borderTop: "1px solid rgba(120,150,220,0.12)" }}>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginTop: 12 }}>
                        {rc.team && <div style={{ padding: "10px 12px", background: "rgba(245,196,83,0.06)", border: "1px solid rgba(245,196,83,0.3)", clipPath: SHELL_NOTCH(6) }}><div style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "#f5c453", fontWeight: 700 }}>Champion</div><div style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", marginTop: 2 }}>{rc.team}</div></div>}
                        {rc.mvp && <div style={{ padding: "10px 12px", background: "rgba(10,16,30,0.7)", border: "1px solid rgba(61,123,255,0.25)", clipPath: SHELL_NOTCH(6) }}><div style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>⭐ Tournament MVP</div><div style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", marginTop: 2 }}>{rc.mvp}<span style={{ fontFamily: "'IBM Plex Mono',monospace", color: "#7da6ff", marginLeft: 6, fontSize: 12 }}>{rc.mvpPts || ""}</span></div></div>}
                        {rc.topFrag && <div style={{ padding: "10px 12px", background: "rgba(10,16,30,0.7)", border: "1px solid rgba(255,70,85,0.25)", clipPath: SHELL_NOTCH(6) }}><div style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "#ff8f9a", fontWeight: 700 }}>Top fragger</div><div style={{ fontSize: 15, fontWeight: 700, textTransform: "uppercase", marginTop: 2 }}>{rc.topFrag}</div></div>}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </>}
        </div>}
    {isHost && current && (() => {
      // Nudge the host when a tournament has been sitting in a live phase — the
      // loop needs a manual flip and it's easy to forget one on a busy night.
      const hrs = current.created_at ? (Date.now() - new Date(current.created_at).getTime()) / 3.6e6 : 0;
      const stale = { registration_open: hrs > 72, registration_closed: true, drafting: true, matches_live: true }[current.phase];
      const advLabel = { registration_open: "Start draft phase", registration_closed: "Start draft phase", drafting: "Start matches", matches_live: "Settle the tournament" }[current.phase];
      return stale && advLabel ? (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, marginBottom: 16, padding: "11px 16px", background: "rgba(245,196,83,0.06)", border: "1px solid rgba(245,196,83,0.35)", clipPath: SHELL_NOTCH(9), flexWrap: "wrap" }}>
          <span style={{ fontSize: 12.5, color: "#f5c453", fontWeight: 600 }}>⚙ {weekendName(current)} is waiting on you — next step: <b style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>{advLabel}</b></span>
          <button onClick={() => onEnter(current)} style={shellBtn("warn", { padding: "7px 14px", fontSize: 11.5 })}>Manage tournament →</button>
        </div>
      ) : null;
    })()}
    {!isHost && !current && events.length > 0 && (
      <div style={{ textAlign: "center", padding: "22px 0", color: "rgba(200,215,255,0.55)" }}>
        <p style={{ fontSize: 14 }}>Next tournament hasn't been announced yet.</p>
        <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.4)", marginTop: 4 }}>You'll get a notification the moment the host opens registration.</p>
      </div>
    )}
    {isHost && <div style={{ textAlign: "center", marginTop: 2 }}>
      <button disabled={busy} onClick={() => setSetupWeekend({ mode: "create", ev: null })} style={btn(events.length === 0 || !current)}>{busy ? "…" : current ? "+ Create next tournament" : "+ Create tournament"}</button>
    </div>}
    {/* Everything below is host machinery. One quiet divider separates it from
        the league itself, so players' eyes stop here and hosts' don't. */}
    {isHost && HAS_SUPABASE && (
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 38, marginBottom: 2 }}>
        <span style={{ ...SEC_LABEL, color: "rgba(200,215,255,0.32)", letterSpacing: "0.34em" }}>// Running the league</span>
        <span style={{ flex: 1, height: 1, background: "linear-gradient(90deg, rgba(120,150,220,0.22), rgba(120,150,220,0))" }} />
      </div>
    )}
    {isTrueHost && HAS_SUPABASE && <DiscordServerCard />}
    {isHost && HAS_SUPABASE && <JoinGuideCard community={community} current={current} />}
    {isHost && HAS_SUPABASE && current && <AvailabilityCard eventId={current.id} />}
    {isHost && HAS_SUPABASE && current && ["drafting","matches_live"].includes(current.phase) && (
      <DiscordTeamsCard eventId={current.id} />
    )}
    {isHost && HAS_SUPABASE && current && (
      <DiscordAnnounce eventId={current.id} communityId={window.__VOLT.communityId} phase={current.phase} />
    )}
    {isTrueHost && HAS_SUPABASE && <StaffPanel onOpenPlayer={(uid) => setShowPlayer(uid)} />}
    {/* Public to every member, not staff-only — the feed is the league's own
        record of itself, and that only works if players can read it. */}
    {HAS_SUPABASE && <LeagueLedger onOpenPlayer={(uid) => setShowPlayer(uid)} />}
    {board && <div style={{ marginTop: 42 }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.38em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase" }}>// Season</div>
        <div style={{ fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 2 }}>Season <span style={{ color: "#3d7bff" }}>Race</span></div>
        <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.4)", marginTop: 5 }}>+50 win · ACS÷4 · K+⅓A — every match counts, subs included</div>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {board.map((r, i) => (
          <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 16px", background: i === 0 ? "rgba(245,196,83,0.08)" : "rgba(255,255,255,0.03)", border: "1px solid " + (i === 0 ? "rgba(245,196,83,0.35)" : "rgba(120,150,220,0.15)"), clipPath: SHELL_NOTCH(8) }}>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: i === 0 ? "#f5c453" : "#5b8dff", width: 24 }}>{String(i + 1).padStart(2, "0")}</span>
            <span onClick={() => r.uid && setShowPlayer(r.uid)} title="View player profile" style={{ flex: 1, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", cursor: r.uid ? "pointer" : "default", display: "inline-flex", alignItems: "center" }}>{r.name}
              <TrophyChip n={r.trophies} />
              {r.move === "new" && <span style={{ fontSize: 9.5, letterSpacing: "0.14em", color: "#7da6ff", fontWeight: 700, marginLeft: 8, border: "1px solid rgba(61,123,255,0.4)", padding: "1px 6px", clipPath: SHELL_NOTCH(4) }}>NEW</span>}
              {typeof r.move === "number" && r.move > 0 && <span style={{ fontSize: 11.5, color: "#3ddc84", fontWeight: 700, marginLeft: 8, fontFamily: "'IBM Plex Mono',monospace" }}>▲{r.move}</span>}
              {typeof r.move === "number" && r.move < 0 && <span style={{ fontSize: 11.5, color: "#ff8f9a", fontWeight: 700, marginLeft: 8, fontFamily: "'IBM Plex Mono',monospace" }}>▼{-r.move}</span>}
            </span>
            <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)" }}>{r.matches}m · {r.wins}w</span>
            <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: "#ecf3ff", width: 66, textAlign: "right" }}>{r.pts} pts</span>
          </div>
        ))}
      </div>
    </div>}
    {season && <div style={{ marginTop: 42 }}>
      <div style={{ textAlign: "center", marginBottom: 16 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.38em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase" }}>// Season</div>
        <div style={{ fontSize: 24, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 2 }}>Captain <span style={{ color: "#3d7bff" }}>Standings</span></div>
      </div>
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
    </div>}
  </>);
}

// ── Tournament roster fetch (module-level: used by the phase shell AND the
// draft app's live browse mode) ──────────────────────────────────────────
async function fetchRosterForEvent(eventId) {
  const { data: regs } = await __sb.from("registrations")
    .select("id, user_id, is_captain, status, availability_confirmed, no_show, wants_captain, pool_eligible, users(display_name, wants_captain, trophy_streak)")
    .eq("event_id", eventId);
  const rows = regs || [];
  const ids = rows.map(r => r.user_id);
  let profs = {}, noShowCounts = {};
  if (ids.length) {
    const { data: pp } = await __sb.from("player_profiles").select("*").in("user_id", ids);
    (pp || []).forEach(p => { profs[p.user_id] = p; });
    // season no-show history — the reliability signal hosts review against
    const { data: ns } = await __sb.from("registrations").select("user_id")
      .eq("community_id", window.__VOLT.communityId).eq("no_show", true).in("user_id", ids);
    (ns || []).forEach(r => { noShowCounts[r.user_id] = (noShowCounts[r.user_id] || 0) + 1; });
  }
  const withProfile = (r) => {
    const p = profs[r.user_id] || {};
    return { userId: r.user_id, regId: r.id, isCaptain: !!r.is_captain,
      // Was this person in the draft? Late sign-ups are false. Missing = legacy
      // row from before the column existed, which was always draft-eligible.
      poolEligible: r.pool_eligible !== false,
      volunteered: !!(r.wants_captain || r.users?.wants_captain), // per-tournament hand; legacy users flag as fallback
      trophies: r.users?.trophy_streak || 0,
      status: r.status || "approved", available: !!r.availability_confirmed,
      noShow: !!r.no_show, noShows: noShowCounts[r.user_id] || 0,
      name: r.users?.display_name || "Player",
      rank: p.rank, rankDiv: p.rank_div ?? null,
      peakRank: p.peak_rank ?? null, peakRankDiv: p.peak_rank_div ?? null,
      role: p.role, agent: p.agent, kda: p.kda, acs: p.acs, hs: p.hs, win: p.win, badges: p.badges,
      discord: p.discord,   // captains reach reserves here; community-readable, not sensitive
      tracker: p.tracker_url || null };
  };
  const mapped = rows.map(withProfile);
  // Only host-approved players exist to the league — pools, boards, subs.
  const approved = mapped.filter(r => r.status === "approved");
  return {
    captains: approved.filter(r => r.isCaptain),
    pool: approved.filter(r => !r.isCaptain),
    all: approved,
    pending: mapped.filter(r => r.status === "pending"),
    rejected: mapped.filter(r => r.status === "rejected"),
  };
}

// ── SEASON SCORING — per-match player points ────────────────────────────
//   +50 win bonus (heaviest) · ACS÷4 (middle) · K + ⅓A (lightest)
//   Season total = sum of every match's points across all tournaments.
function matchPoints({ won, acs, kills, assists }) {
  const win = won ? 50 : 0;
  const perf = Math.round((Number(acs) || 0) / 4);
  const frags = Math.round((Number(kills) || 0) + (Number(assists) || 0) / 3);
  return win + perf + frags;
}

/* ════════════════════════════════════════════════════════════════════
   WEEKEND APP — phase router. Registration → Draft → Matches, per tournament.
   ════════════════════════════════════════════════════════════════════ */
function WeekendApp({ auth, event, isHost, isTrueHost, account, onSignOut, onBack, initialView }) {
  // isHost here means "staff" — host or moderator, both run the tournament. The
  // owner-only powers (settling, deleting, resetting) check isTrueHost instead,
  // so a moderator can do the work without being able to undo the league.
  const [ev, setEv] = useState(event);
  const [busy, setBusy] = useState(false);
  const phase = ev?.phase || "drafting";
  // During registration a player lands on the Lobby (app) — the "I'm playing"
  // toggle is there. Hosts still default to the gate to review applications.
  const [regView, setRegView] = useState(initialView ? "app" : (isHost ? "gate" : "app"));
  const [matchView, setMatchView] = useState(false); // host match-report form
  const [reportPrefill, setReportPrefill] = useState(null); // fixture → report handoff
  // My registration status for this tournament — powers the Lobby's "I'm playing"
  // toggle while registration is open.
  const [myReg, setMyReg] = useState(null);
  const [myProfile, setMyProfile] = useState(null);
  const [mySusp2, setMySusp2] = useState(0);
  const [myStrikes2, setMyStrikes2] = useState(0);
  async function loadMyReg() {
    if (!HAS_SUPABASE || !auth?.userId || !ev?.id) return;
    try {
      const { data: r } = await __sb.from("registrations").select("id, status, wants_captain, is_captain").eq("event_id", ev.id).eq("user_id", auth.userId).maybeSingle();
      setMyReg(r || null);
      setMyProfile(await loadProfileGate(auth.userId));
      const { data: u } = await __sb.from("users").select("suspension_remaining").eq("id", auth.userId).maybeSingle();
      setMySusp2(u?.suspension_remaining || 0);
      const { data: ns } = await __sb.from("registrations").select("id").eq("community_id", window.__VOLT.communityId).eq("user_id", auth.userId).eq("no_show", true);
      setMyStrikes2((ns || []).length);
    } catch (e) { console.error(e); }
  }
  useEffect(() => { if (phase === "registration_open" || phase === "registration_closed") loadMyReg(); }, [phase, ev?.id]);
  // Host-only: how many applications are waiting for review this tournament.
  // Powers the header Approvals pill + its live count. Cheap: probes ids only,
  // and pauses on hidden tabs via visInterval (egress-friendly).
  const [pendingCount, setPendingCount] = useState(0);
  async function loadPending() {
    if (!HAS_SUPABASE || !isHost || !ev?.id) return 0;
    try {
      const { data } = await __sb.from("registrations").select("id").eq("event_id", ev.id).eq("status", "pending");
      const n = (data || []).length;
      setPendingCount(n);
      return n;
    } catch (e) { console.error(e); return pendingCount; }
  }
  useEffect(() => {
    if (!isHost || !(phase === "registration_open" || phase === "registration_closed")) { setPendingCount(0); return; }
    loadPending();
    const stop = visInterval(loadPending, 15000);
    return () => stop();
  }, [isHost, phase, ev?.id]);
  // Which fixtures already have player stats banked (by match_label) — lets
  // the fixtures screen show "✓ recorded" and keeps the two systems in sync.
  async function refreshReported() {
    if (!HAS_SUPABASE || !ev?.id) return;
    try {
      const { data } = await __sb.from("match_results").select("match_label, points_computed, stat_payload").eq("event_id", ev.id);
      const labels = new Set(); const stats = {};
      (data || []).forEach(r => {
        labels.add(r.match_label);
        const cur = stats[r.match_label];
        if (!cur || Number(r.points_computed || 0) > cur.pts)
          stats[r.match_label] = { name: r.stat_payload?.name || "Player", pts: Number(r.points_computed || 0) };
      });
      window.__VOLT.reportedLabels = labels;
      window.__VOLT.reportedStats = stats;
    } catch (e) { console.error(e); }
  }
  useEffect(() => { if (phase === "matches_live" || phase === "settled") refreshReported(); }, [phase, ev?.id]);
  // Bridge: fixture cards deep in DraftApp open the report form pre-filled.
  useEffect(() => {
    if (isHost && phase === "matches_live" && HAS_SUPABASE) {
      window.__VOLT.openReport = (pf) => { setReportPrefill(pf || null); setMatchView(true); };
      return () => { delete window.__VOLT.openReport; };
    }
  }, [isHost, phase]);
  const [narrow, setNarrow] = useState(typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(max-width: 640px)").matches : false);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const on = (e) => setNarrow(e.matches);
    mq.addEventListener ? mq.addEventListener("change", on) : mq.addListener(on);
    return () => { mq.removeEventListener ? mq.removeEventListener("change", on) : mq.removeListener(on); };
  }, []);
  useEffect(() => { setRegView(initialView ? "app" : (isHost ? "gate" : "app")); setMatchView(false); }, [phase]);

  // Poll the tournament's phase so players follow the host's transitions live.
  useEffect(() => {
    if (!HAS_SUPABASE || !ev) return;
    const stop = visInterval(async () => {
      const { data } = await __sb.from("events").select("*").eq("id", ev.id).maybeSingle();
      if (data && data.phase !== ev.phase) setEv(data);
    }, 6000);
    return () => stop();
  }, [ev?.id, ev?.phase]);

  // registration_closed is back, and this time it earns the step: it's the line
  // that decides who was in the draft. Sign-ups stay open through it, but anyone
  // joining from here on is a reserve (pool_eligible = false), not an auction pick.
  const NEXT = { registration_open: "registration_closed", registration_closed: "drafting", drafting: "matches_live", matches_live: "settled", settled: "settled" };
  const NEXT_LABEL = { registration_open: "Close the draft pool", registration_closed: "Start draft phase", drafting: "Start matches", matches_live: "Settle tournament", settled: "Settled" };
  // settled → matches_live is a real reversal, not a plain phase step: it has to
  // restore the trophy counters that settling overwrote. stepBack routes it to
  // volt_unsettle rather than a straight phase update.
  const PREV = { registration_closed: "registration_open", drafting: "registration_closed", matches_live: "drafting", settled: "matches_live" };
  const [arm, setArm] = useState(false); // two-tap confirm on phase advance
  useEffect(() => { if (!arm) return; const t = setTimeout(() => setArm(false), 4000); return () => clearTimeout(t); }, [arm]);
  useEffect(() => { setArm(false); }, [phase]);

  // Step the tournament one phase backward (settled stays terminal — season
  // snapshots are written at settle and must not be re-rolled casually).
  async function stepBack() {
    if (!isHost || !HAS_SUPABASE || !PREV[phase]) return;
    // Reopening a settled tournament is not a phase change — it has to put back the
    // trophy streaks, wins and bracket counts that settling overwrote. Only the
    // host can do it, and only if that settle recorded an undo snapshot.
    if (phase === "settled") {
      if (!isTrueHost) { window.alert("Only the host can reopen a settled tournament."); return; }
      if (!window.confirm(
        `Reopen ${weekendName(ev)}?\n\n` +
        `Trophy streaks, tournaments won and bracket wins go back to what they were before it was settled, ` +
        `and the recap is cleared. Match results and season points are kept, so you can fix a report and settle again.`)) return;
      setBusy(true);
      try {
        const { error } = await __sb.rpc("volt_unsettle", { p_event: ev.id });
        if (error) throw error;
        const { data } = await __sb.from("events").select("*").eq("id", ev.id).maybeSingle();
        if (data) setEv(data);
      } catch (e) {
        console.error(e);
        window.alert(e.message || "Could not reopen that tournament.");
      }
      setBusy(false);
      return;
    }
    if (!window.confirm(`Move ${weekendName(ev)} back to "${PREV[phase].replace(/_/g, " ")}"? The draft board is kept.`)) return;
    setBusy(true);
    try {
      const { data } = await __sb.from("events").update({ phase: PREV[phase] }).eq("id", ev.id).select().maybeSingle();
      if (data) setEv(data);
    } catch (e) { console.error(e); }
    setBusy(false);
  }

  // Fetch this tournament's full roster: registered captains, the non-captain
  // player pool, and everyone's scouting profiles (rank/KDA/ACS/HS/win).
  async function fetchWeekendRoster() { return fetchRosterForEvent(ev.id); }

  // Build this tournament's draft board from its registered captains.
  // Called when the host opens the draft. Won't clobber an existing board
  // that already has picks (roster/sales) — safe to re-run.
  async function buildBoardFromRegistrations() {
    try {
      const existing = await readState();
      const hasProgress = existing && (
        (existing.recentSales && existing.recentSales.length) ||
        (existing.teams && existing.teams.some(t => t.roster && t.roster.length)) ||
        existing.block || existing.spin
      );
      if (hasProgress) return; // a real draft is underway — leave it alone

      const { captains, pool } = await fetchWeekendRoster();
      const stamp = (st) => { if (ev?.draft_at) st.draftAt = new Date(ev.draft_at).getTime(); return st; };
      // Carry over any team names the captains already set, so rebuilding the
      // board from registrations doesn't reset them to the default seeds.
      const priorName = {};
      (existing?.teams || []).forEach(t => { if (t.captainUserId && t.name) priorName[t.captainUserId] = t.name; });
      const withNames = captains.map(c => (priorName[c.userId] ? { ...c, teamName: priorName[c.userId] } : c));
      // freshState decides for itself whether there are enough captains to form
      // teams, so one call covers both cases — and either way every registered
      // player lands on the board instead of being dropped.
      if (captains.length >= MIN_TEAMS || !existing) {
        const built = stamp(freshState(withNames, pool));
        // Players the host typed in by hand have no registration to
        // rebuild from, so a plain rebuild would silently erase them. Carry
        // them over (minus any that a real registration now supersedes).
        const rebuiltIds = new Set(built.players.map(p => p.id));
        const manual = (existing?.players || []).filter(p => isManualPlayer(p) && !rebuiltIds.has(p.id));
        if (manual.length) built.players = [...built.players, ...manual];
        await writeState(built);
      }
    } catch (e) { console.error("buildBoard", e); }
  }

  async function advance() {
    if (!isHost || !HAS_SUPABASE) return;
    // Settling crowns champions and writes season points, and there's no undo.
    // The DB enforces this too (events_staff_update forbids phase='settled'
    // unless auth_is_host()), so this is the friendly message, not the lock.
    if (NEXT[phase] === "settled") {
      // Settling freezes season points. The commonest way to get burned is
      // settling with matches still unreported, so surface that first.
      // WeekendApp has no board in scope, so read it. A minimal flatten is
      // enough here — we only need played fixtures, whatever the format.
      const board = await readState();
      const t = board?.tournament || null;
      const all = [];
      if (t) {
        if (t.groups) Object.values(t.groups).forEach(g => (g?.matches || []).forEach(m => m && all.push(m)));
        if (Array.isArray(t.matches)) t.matches.forEach(m => m && all.push(m));
        else if (t.matches) Object.values(t.matches).forEach(a => Array.isArray(a) && a.forEach(m => m && all.push(m)));
        if (t.rounds) t.rounds.forEach(r => (r || []).forEach(m => m && all.push(m)));
        if (t.final) all.push(t.final);
      }
      const reported = window.__VOLT?.reportedLabels || new Set();
      const missing = all.filter(m => {
        if (!m.done || m.teamA == null || m.teamB == null) return false;
        const A = (board.teams || []).find(x => x.id === m.teamA);
        const B = (board.teams || []).find(x => x.id === m.teamB);
        return A && B && !reported.has(`${A.name} vs ${B.name}`);
      });
      if (missing.length && !window.confirm(
        `${missing.length} match${missing.length === 1 ? " has" : "es have"} a score but no player stats recorded.\n\n` +
        `Settling banks season points from what's been reported — those players get nothing for ${missing.length === 1 ? "that match" : "those matches"}.\n\n` +
        `Settle anyway?`)) return;
    }
    if (NEXT[phase] === "settled" && !isTrueHost) {
      // Belt and braces — events_staff_update also refuses phase='settled'
      // unless auth_is_host(), so this is the explanation, not the lock.
      window.alert("Only the host can settle a tournament. Ask them to close it out.");
      return;
    }
    // Closing registration and opening the draft are one step now, so this is
    // the last moment pending applications can be approved. Don't let them be
    // stranded silently — they'd never reach the pool.
    if (phase === "registration_closed") {
      const n = await loadPending();
      if (n > 0) {
        const ok = window.confirm(
          `${n} application${n === 1 ? " is" : "s are"} still awaiting review.\n\n` +
          `Opening the draft closes registration — ${n === 1 ? "that player" : "those players"} won't be in the pool.\n\n` +
          `Open the draft anyway?`
        );
        if (!ok) { setRegView("gate"); return; }
      }
    }
    setBusy(true);
    try {
      const next = NEXT[phase];
      // Opening the draft: (re)build the board from this tournament's captains first.
      if (next === "drafting") await buildBoardFromRegistrations();
      // Settling the tournament: snapshot standings, crown champions (trophy streak),
      // build the recap card, and notify players.
      if (next === "settled") { await snapshotStandings(); await settleTrophiesAndRecap(); }
      const { data } = await __sb.from("events").update({ phase: next }).eq("id", ev.id).select().maybeSingle();
      if (data) setEv(data);
    } catch (e) { console.error(e); }
    setBusy(false);
  }

  // Store the tournament's final standings under a season-scoped shared key so a
  // season leaderboard can aggregate across tournaments. Uses the tournament's own
  // draft state (teams + tournament results already computed there).
  async function snapshotStandings() {
    try {
      const s = await readState();
      if (!s || !s.teams) return;
      // Prefer computed tournament standings; fall back to roster/budget summary.
      const rows = s.teams.map(t => ({
        teamId: t.id, name: t.name, captain: t.captain, captainUserId: t.captainUserId || null,
        rosterCount: (t.roster || []).length, budgetLeft: t.budget,
      }));
      // If the tournament produced win/loss, fold it in.
      if (s.tournament) {
        try {
          const st = computeSeasonPoints(s);
          st.forEach(sp => { const r = rows.find(x => x.teamId === sp.teamId); if (r) { r.won = sp.won; r.lost = sp.lost; r.pts = sp.pts; } });
        } catch (e) { /* standings optional */ }
      }
      const payload = { weekendId: ev.id, label: ev.weekend_label, at: Date.now(), rows };
      // Season key is community-wide; one row per tournament.
      const prevWin = window.__VOLT.weekendId;
      window.__VOLT.weekendId = null; // write to the community-level season log, not the tournament board
      await window.storage.set("season-standings::" + ev.id, JSON.stringify(payload), true);
      window.__VOLT.weekendId = prevWin;
    } catch (e) { console.error("snapshotStandings", e); }
  }

  // Crown the tournament champion team, extend/reset trophy streaks league-wide,
  // build the recap card, and notify every approved player. Champion = top of
  // the tournament standings (wins → round diff via computeStandings ordering);
  // champion players = that team's drafted roster + any subs who played for it.
  async function settleTrophiesAndRecap() {
    try {
      const s = await readState();
      let team = null, championIds = [], recap = {}, kind = "tournament", decidedByFinal = false;
      if (s && s.tournament && s.teams) {
        const t = s.tournament;
        // A single-elim bracket crowns a bracket champion; league-play crowns
        // the tournament (top of the table). Both count as champions for trophies.
        kind = t.format === "single" ? "bracket" : "tournament";
        // Who actually won the tournament:
        //  1. the Sunday final / grand final, if it was played  → the real decider
        //  2. the last bracket match, for single elim
        //  3. otherwise top of the table (tournament never reached a final)
        let champTeamId = null;
        if (t.final?.done && t.final.winner) { champTeamId = t.final.winner; decidedByFinal = true; }
        else if (t.format === "single" && t.rounds?.length) {
          const fm = t.rounds[t.rounds.length - 1]?.[0];
          if (fm?.done && fm.winner) { champTeamId = fm.winner; decidedByFinal = true; }
        }
        if (champTeamId) kind = t.format === "single" ? "bracket" : "tournament";
        const standings = computeStandings(t.teamIds || s.teams.map(x => x.id), t.matches || [], t.overrides);
        const champ = champTeamId
          ? { teamId: champTeamId }
          : (standings.find(r => r.played > 0) ? standings[0] : null);
        if (champ) {
          const ct = s.teams.find(x => x.id === champ.teamId);
          team = ct?.name || null;
          // Drafted roster userIds (pool player ids are their userIds).
          const rosterIds = new Set((ct?.roster || []).map(p => p.id).filter(Boolean));
          if (ct?.captainUserId) rosterIds.add(ct.captainUserId);
          championIds = [...rosterIds];
        }
      }
      // Subs who actually played on the champion team this tournament (match_results).
      // Plus MVP + top fragger for the recap, all from banked stats.
      try {
        const { data: mrs } = await __sb.from("match_results").select("user_id, points_computed, team_won, stat_payload").eq("event_id", ev.id);
        const rows = mrs || [];
        // MVP: single highest-scoring match line.
        let mvp = null; rows.forEach(r => { if (!mvp || Number(r.points_computed || 0) > mvp.pts) mvp = { name: r.stat_payload?.name || "Player", pts: Number(r.points_computed || 0) }; });
        // Top fragger: most kills summed across the tournament.
        const kills = {};
        rows.forEach(r => { const nm = r.stat_payload?.name || "Player"; kills[nm] = (kills[nm] || 0) + Number(r.stat_payload?.k || 0); });
        const topFrag = Object.entries(kills).sort((a, b) => b[1] - a[1])[0];
        recap = { mvp: mvp?.name || null, mvpPts: mvp ? mvp.pts + " pts" : null, topFrag: topFrag ? topFrag[0] : null, decidedBy: decidedByFinal ? "final" : "table" };
      } catch (e) { console.error("recap stats", e); }
      // Fire the security-definer RPC: streak +1 for champions, reset for the rest.
      await __sb.rpc("volt_settle_trophies", { p_event: ev.id, p_team: team, p_champions: championIds, p_recap: recap, p_kind: kind });
      // Notify every approved player the tournament settled (+ champions get the crown).
      try {
        const r = await fetchRosterForEvent(ev.id);
        const champSet = new Set(championIds);
        const notes = r.all.map(p => ({
          community_id: window.__VOLT.communityId, user_id: p.userId, event_id: ev.id,
          kind: "settled",
          title: champSet.has(p.userId) ? "🏆 You won the tournament!" : weekendName(ev) + " settled",
          body: champSet.has(p.userId)
            ? (team ? team + " took the crown — your trophy streak grew." : "Your trophy streak grew.")
            : (team ? team + " won it. See where you land on the Season Race." : "See where you land on the Season Race."),
        }));
        await voltNotify(notes);
      } catch (e) { console.error("settle notify", e); }
    } catch (e) { console.error("settleTrophies", e); }
  }

  // Force a rebuild from current registered captains (wipes the tournament board).
  async function rebuildNow() {
    if (!isHost || !HAS_SUPABASE) return;
    if (!window.confirm("Rebuild the teams from the currently registered captains? This clears the current draft board for this tournament.")) return;
    setBusy(true);
    try {
      const { captains, pool } = await fetchWeekendRoster();
      // Keep custom team names through an explicit rebuild too.
      const prior = await readState();
      const priorName = {};
      (prior?.teams || []).forEach(t => { if (t.captainUserId && t.name) priorName[t.captainUserId] = t.name; });
      const withNames = captains.map(c => (priorName[c.userId] ? { ...c, teamName: priorName[c.userId] } : c));
      await writeState(freshState(withNames, pool));
      window.location.reload();
    } catch (e) { console.error(e); setBusy(false); }
  }

  const bar = (
    <div className="vg-shell" style={{ position: "sticky", top: 0, zIndex: 60, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", background: "linear-gradient(180deg, rgba(12,17,30,0.98), rgba(8,11,19,0.96))", borderBottom: "1px solid rgba(61,123,255,0.28)", boxShadow: "0 10px 30px rgba(0,0,0,0.35)", fontFamily: "'Rajdhani',sans-serif" }}>
      <ShellStyles />
      <button onClick={onBack} style={shellBtn("ghost", { padding: "8px 14px" })}>‹ Schedule</button>
      {/* Absolutely centred so uneven left/right clusters can't push it off-axis.
          Hidden on narrow screens where the side controls would overlap it. */}
      <div className="hidden lg:block" style={{ position: "absolute", left: "50%", top: "50%", transform: "translate(-50%, -50%)", whiteSpace: "nowrap", pointerEvents: "none", fontSize: 13, letterSpacing: "0.3em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, textShadow: "0 0 14px rgba(61,123,255,0.65)" }}>// {weekendName(ev)} · {({registration_open:"Registration",registration_closed:"Reg closed",drafting:"Draft",matches_live:"Matches",settled:"Settled"})[phase]}</div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        {(phase === "registration_open" || phase === "registration_closed") && regView === "app" &&
          <button onClick={() => setRegView("gate")} style={shellBtn("accent", { padding: "8px 12px" })}>‹ Registration</button>}
        {(phase === "registration_open" || phase === "registration_closed") && regView === "gate" &&
          <button onClick={() => setRegView("app")} style={shellBtn("primary", { padding: "8px 14px" })}>⊞<span className="hidden sm:inline"> Explore the league</span> →</button>}
        {isHost && (narrow
          ? <HostMenu>
              {PREV[phase] && <button disabled={busy} onClick={stepBack} style={shellBtn("ghost", { width: "100%", padding: "9px" })}>↶ Back a phase</button>}
              {phase === "drafting" && <button disabled={busy} onClick={rebuildNow} style={shellBtn("warn", { width: "100%", padding: "9px", marginTop: 8 })}>⟳ Rebuild teams</button>}
              {phase === "matches_live" && <button onClick={() => setMatchView(v => !v)} style={shellBtn(matchView ? "ghost" : "accent", { width: "100%", padding: "9px", marginTop: 8 })}>{matchView ? "‹ Back to app" : "▦ Report match"}</button>}
              {phase !== "settled" && <button disabled={busy} onClick={() => { if (!arm) { setArm(true); return; } setArm(false); advance(); }} style={shellBtn(arm ? "danger" : "primary", { width: "100%", padding: "9px", marginTop: 8 })}>{busy ? "…" : arm ? "Confirm: " + NEXT_LABEL[phase] + "?" : NEXT_LABEL[phase] + " →"}</button>}
            </HostMenu>
          : <>
              {PREV[phase] && <button disabled={busy} onClick={stepBack} title="Move this tournament back one phase" style={shellBtn("ghost", { padding: "8px 11px" })}>↶</button>}
              {phase === "drafting" &&
                <button disabled={busy} onClick={rebuildNow} title="Rebuild teams from registered captains" style={shellBtn("warn", { padding: "8px 12px" })}>⟳ Rebuild teams</button>}
              {phase === "matches_live" &&
                <button onClick={() => setMatchView(v => !v)} style={shellBtn(matchView ? "ghost" : "accent", { padding: "8px 12px" })}>{matchView ? "‹ Back to app" : "▦ Report match"}</button>}
              {phase !== "settled" &&
                <button disabled={busy} onClick={() => { if (!arm) { setArm(true); return; } setArm(false); advance(); }} style={shellBtn(arm ? "danger" : "ghost", { padding: "8px 16px" })}>{busy ? "…" : arm ? "Confirm: " + NEXT_LABEL[phase] + "?" : NEXT_LABEL[phase] + " →"}</button>}
            </>)}
        {account && <AccountChip account={account} onSignOut={onSignOut} />}
      </div>
    </div>
  );

  // Registration phases land on the sign-up card, but the league stays
  // browsable — "Explore the league" opens the full app (Scout Hub, rosters)
  // while registration is still open. Draft/matches/settled → full app.
  const inReg = (phase === "registration_open" || phase === "registration_closed");
  const showGate = inReg && regView === "gate";
  const showReport = matchView && isHost;

  // Merged mode: DraftApp owns the one nav bar; league chrome rides inside it.
  if (!showGate) {
    const PHASE_TAG = { registration_open: "Registration", registration_closed: "Reg closed", drafting: "Draft", matches_live: "Matches", settled: "Settled" };
    const PHASE_TAG_COLOR = { registration_open: "#3ddc84", registration_closed: "#f5c453", drafting: "#5b8dff", matches_live: "#af9aec", settled: "rgba(200,215,255,0.5)" };
    const hostControls = isHost ? <>
      {PREV[phase] && <button disabled={busy} onClick={stepBack} style={shellBtn("ghost", { width: "100%", padding: "9px" })}>↶ Back a phase</button>}
      {phase === "drafting" && <button disabled={busy} onClick={rebuildNow} style={shellBtn("warn", { width: "100%", padding: "9px", marginTop: PREV[phase] ? 8 : 0 })}>⟳ Rebuild teams</button>}
      {phase === "matches_live" && <button onClick={() => setMatchView(true)} style={shellBtn("accent", { width: "100%", padding: "9px", marginTop: 8 })}>▦ Report match</button>}
      {phase !== "settled" && <button disabled={busy} onClick={() => { if (!arm) { setArm(true); return; } setArm(false); advance(); }} style={shellBtn(arm ? "danger" : "primary", { width: "100%", padding: "9px", marginTop: 8 })}>{busy ? "…" : arm ? "Confirm: " + NEXT_LABEL[phase] + "?" : NEXT_LABEL[phase] + " →"}</button>}
    </> : null;
    const chrome = {
      backLabel: inReg ? "Registration" : "Schedule",
      portalLabel: inReg ? "Registration" : "League hub",
      onBack: inReg ? () => setRegView("gate") : onBack,
      phaseTag: PHASE_TAG[phase], phaseColor: PHASE_TAG_COLOR[phase],
    phase,   // raw phase — DraftApp needs to branch on it, not just label it
      draftAt: ev?.draft_at || null,
      // Confirmed captain for this tournament, from the registration record. The
      // auction board doesn't exist until the draft starts, so during
      // registration this is the only source of captaincy.
      isCaptainElect: !!(myReg?.is_captain && (myReg?.status || "approved") === "approved"),
      onReport: (isHost && phase === "matches_live") ? () => { setReportPrefill(null); setMatchView(true); } : null,
      // The top-bar Registration button already routes here via onBack during
      // registration, so it carries the count instead of a separate control.
      pendingCount: (isHost && (phase === "registration_open" || phase === "registration_closed")) ? pendingCount : 0,
      // Rendered as a normal view inside the tournament shell (rail + nav intact).
      reportNode: (isHost && matchView)
        ? <MatchReport ev={ev} prefill={reportPrefill} onDone={() => { setMatchView(false); setReportPrefill(null); refreshReported(); }} />
        : null,
      account, onSignOut, hostControls,
      // The Lobby shows this when registration is open — flipping it IS applying.
      regToggle: ((phase === "registration_open" || phase === "registration_closed") && HAS_SUPABASE && auth?.userId && !isHost)
        ? <PlayToggle ev={ev} mine={myReg} profileComplete={profileIsComplete(myProfile)} susp={mySusp2} strikes={myStrikes2}
            onEditProfile={() => setRegView("gate")} onChanged={loadMyReg} />
        : null,
    };
    return <DraftApp auth={auth} browse={inReg} chrome={chrome} initialView={initialView} />;
  }

  return <div>{bar}<WeekendRegistration ev={ev} auth={auth} phase={phase} /></div>;
}

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
    const { data: p } = await __sb.from("player_profiles").select("rank, role, discord").eq("user_id", userId).maybeSingle();
    if (p) { out.rank = p.rank; out.role = p.role; out.discord = p.discord; }
  } catch (e) { console.error("profile gate", e); }
  try {
    const { data: c } = await __sb.from("player_contacts").select("whatsapp, discord_user_id")
      .eq("user_id", userId).eq("community_id", window.__VOLT.communityId).maybeSingle();
    if (c) { out.whatsapp = c.whatsapp; out.linked = !!c.discord_user_id; }
  } catch (e) { console.error("contact gate", e); }
  return out;
}
const profileIsComplete = (p) => !!(p && p.rank && p.role && p.whatsapp && (p.linked || p.discord));
const profileMissing = (p) => {
  if (!p) return ["rank", "role", "a connected Discord", "WhatsApp number"];
  const m = [];
  if (!p.rank) m.push("rank");
  if (!p.role) m.push("role");
  if (!p.linked && !p.discord) m.push("a connected Discord");
  if (!p.whatsapp) m.push("WhatsApp number");
  return m;
};

// Match a name read off a screenshot to a player on the board. Riot IDs won't
// always equal VOLT display names, so this widens gradually: exact, then prefix,
// then substring, then a loose character-overlap score. Anything below the
// threshold returns null and the host picks manually — a wrong auto-match writes
// someone else's stats, which is worse than asking.
function matchScoreboardName(raw, players) {
  const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = norm(raw);
  if (!q) return null;
  const cand = players.map((p) => ({ p, n: norm(p.name) })).filter((c) => c.n);
  const exact = cand.find((c) => c.n === q);
  if (exact) return exact.p;
  const pre = cand.find((c) => c.n.startsWith(q) || q.startsWith(c.n));
  if (pre) return pre.p;
  const sub = cand.find((c) => c.n.includes(q) || q.includes(c.n));
  if (sub) return sub.p;
  // Loose fallback: share of the shorter string's characters in order.
  let best = null, bestScore = 0;
  for (const c of cand) {
    const [a, b] = c.n.length < q.length ? [c.n, q] : [q, c.n];
    let i = 0;
    for (const ch of b) if (i < a.length && a[i] === ch) i++;
    const score = i / a.length;
    if (score > bestScore) { bestScore = score; best = c.p; }
  }
  return bestScore >= 0.75 ? best : null;
}

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

function ScoutProfileCard({ userId, onSaved, embedded = false }) {
  const [prof, setProf] = useState(undefined);
  // `embedded` means a parent already asked "want to set up your profile?" and
  // the user said yes — so open straight into the form instead of showing a
  // second button that asks the same thing again.
  const [editing, setEditing] = useState(embedded);
  const [d, setD] = useState({ rank: "", rankDiv: "", peakRank: "", peakRankDiv: "", role: "", agent: "", kda: "", acs: "", hs: "", win: "", tracker: "", whatsapp: "" });
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
  const fieldS = { width: "100%", padding: "9px 10px", background: "rgba(10,16,30,0.65)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 14, boxSizing: "border-box" };
  const labS = { fontSize: 10, textTransform: "uppercase", letterSpacing: "0.12em", color: "rgba(200,215,255,0.5)", fontFamily: "'Rajdhani',sans-serif", display: "block", marginBottom: 4, textAlign: "left" };

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
    if (data || c) setD({ rank: data?.rank || "", rankDiv: data?.rank_div ?? "", peakRank: data?.peak_rank || "", peakRankDiv: data?.peak_rank_div ?? "", role: data?.role || "", agent: data?.agent || "", kda: data?.kda ?? "", acs: data?.acs ?? "", hs: data?.hs ?? "", win: data?.win ?? "", tracker: data?.tracker_url || "", whatsapp: c?.whatsapp || "" });
  }
  useEffect(() => { load(); }, [userId]);

  // Paste, drop or pick — all three land here. Paste is the one that matters:
  // Snipping Tool then Ctrl+V is the natural motion, and it skips saving a file.
  async function readTracker(file) {
    if (!file) return;
    setShotBusy(true); setShotErr(""); setShotScope(""); setShotFilled([]);
    try {
      const { base64, mimeType } = await downscaleImage(file);
      const r = await fetch("/api/read-tracker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
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
    }, { onConflict: "user_id" });
    // Digits only — wa.me needs a bare international number, and normalising on
    // the way in means the host never has to clean it up by hand.
    const waDigits = (d.whatsapp || "").replace(/[^0-9]/g, "");
    try {
      await __sb.from("player_contacts").upsert({
        user_id: userId, community_id: window.__VOLT.communityId,
        whatsapp: waDigits || null,
      }, { onConflict: "user_id,community_id" });
    } catch (e) { console.error("saveContacts:", e); }
    setBusy(false);
    if (error) {
      // Keep the form open and say what happened — collapsing silently made it
      // look like the save "reverted".
      console.error("saveProfile:", error.message);
      setSaveErr(error.message || "Couldn't save your profile. Check your connection and try again.");
      return;
    }
    setSaveErr("");
    setEditing(false); load(); onSaved?.();
  }

  if (prof === undefined) return null;
  const has = prof && prof.rank;
  return (
    <div style={{ marginTop: embedded ? 0 : 24, padding: embedded ? 0 : "18px 20px", position: "relative", background: embedded ? "none" : "linear-gradient(160deg,rgba(20,26,42,0.85),rgba(10,13,22,0.85))", border: "1px solid rgba(61,123,255,0.28)", clipPath: SHELL_NOTCH(14), textAlign: "left" }}>
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
        <button onClick={() => setEditing(true)} style={shellBtn(has ? "ghost" : "primary", { padding: "9px 18px", fontSize: 12 })}>{has ? "Edit my stats" : "Set up my stats →"}</button>
      </>}
      {editing && <>
        {/* Filling seven stat fields by hand is the heaviest friction in the
            gate. This reads them off a tracker screenshot instead — prefill
            only, never autosave. */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); readTracker(e.dataTransfer?.files?.[0]); }}
          style={{ marginBottom: 14, padding: "14px 16px", clipPath: SHELL_NOTCH(9),
            background: dragOver ? "rgba(61,123,255,0.12)" : "rgba(10,16,30,0.45)",
            border: `1px ${dragOver ? "solid" : "dashed"} rgba(61,123,255,${dragOver ? 0.6 : 0.3})` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: "#cfe0ff" }}>⎘ Fill this in from a screenshot</span>
            <label style={{ ...shellBtn("ghost", { padding: "7px 14px", fontSize: 11, cursor: shotBusy ? "wait" : "pointer" }), display: "inline-block" }}>
              {shotBusy ? "Reading…" : "Choose image"}
              <input type="file" accept="image/*" disabled={shotBusy} style={{ display: "none" }}
                onChange={(e) => { readTracker(e.target.files?.[0]); e.target.value = ""; }} />
            </label>
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.45)" }}>or paste with Ctrl+V, or drag one here</span>
          </div>
          <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.42)", marginTop: 6, lineHeight: 1.55 }}>
            Screenshot your tracker.gg overview on the <b style={{ color: "rgba(200,215,255,0.6)" }}>Competitive</b> tab
            for the current act. Everything it reads lands in the fields below for you to check before saving.
          </div>
          {shotScope && (
            <div style={{ fontSize: 12, color: "#9af5c2", marginTop: 8 }}>
              ✓ Read {shotFilled.length} field{shotFilled.length === 1 ? "" : "s"} from <b>{shotScope}</b>
              <span style={{ color: "rgba(200,215,255,0.45)" }}> — check that's the right tab, then review the values.</span>
            </div>
          )}
          {shotErr && <div style={{ fontSize: 12, color: "#f5c453", marginTop: 8 }}>⚠ {shotErr}</div>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(110px,1fr))", gap: 10, marginBottom: 14 }}>
          {/* Tier and division are separate controls because the tier alone
              drives opening bids and pool filters — the number is cosmetic. */}
          <label><span style={labS}>Rank *</span>
            <select value={d.rank} onChange={e => setD({ ...d, rank: e.target.value, rankDiv: hasDivisions(e.target.value) ? d.rankDiv : "" })} style={fieldS}>
              <option value="">— select —</option>{Object.keys(RANKS).map(r => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <label><span style={labS}>Division</span>
            <select value={d.rankDiv} disabled={!hasDivisions(d.rank)} onChange={e => setD({ ...d, rankDiv: e.target.value })}
              style={{ ...fieldS, opacity: hasDivisions(d.rank) ? 1 : 0.4 }}>
              <option value="">{d.rank === "Radiant" ? "n/a" : "—"}</option>{RANK_DIVS.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <label><span style={labS}>Peak rank</span>
            <select value={d.peakRank} onChange={e => setD({ ...d, peakRank: e.target.value, peakRankDiv: hasDivisions(e.target.value) ? d.peakRankDiv : "" })} style={fieldS}>
              <option value="">— none —</option>{Object.keys(RANKS).map(r => <option key={r} value={r}>{r}</option>)}
            </select></label>
          <label><span style={labS}>Peak division</span>
            <select value={d.peakRankDiv} disabled={!hasDivisions(d.peakRank)} onChange={e => setD({ ...d, peakRankDiv: e.target.value })}
              style={{ ...fieldS, opacity: hasDivisions(d.peakRank) ? 1 : 0.4 }}>
              <option value="">{d.peakRank === "Radiant" ? "n/a" : "—"}</option>{RANK_DIVS.map(n => <option key={n} value={n}>{n}</option>)}
            </select></label>
          <label><span style={labS}>Role</span>
            <select value={d.role} onChange={e => setD({ ...d, role: e.target.value })} style={fieldS}>
              <option value="">— select —</option>{ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select></label>
          {[["agent", "Main agent", "text"], ["kda", "KDA", "num"], ["acs", "ACS", "num"], ["hs", "HS %", "num"], ["win", "Win %", "num"]].map(([k, label, type]) => (
            <label key={k}><span style={labS}>{label}</span>
              <input value={d[k]} onChange={e => setD({ ...d, [k]: type === "num" ? e.target.value.replace(/[^0-9.]/g, "") : e.target.value })} style={fieldS} /></label>))}
          <label style={{ gridColumn: "1 / -1" }}><span style={labS}>Tracker link (tracker.gg, blitz.gg…)</span>
            <input value={d.tracker} placeholder="tracker.gg/valorant/profile/riot/yourname" onChange={e => setD({ ...d, tracker: e.target.value })} style={fieldS} /></label>
          {/* Not typed any more — a hand-entered handle proved nothing and the bot
              still couldn't reach anyone. The OAuth link is the source of both. */}
          <div style={{ gridColumn: "1 / -1" }}><span style={labS}>Discord *</span>
            {dc.linked
              ? <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", background: "rgba(61,220,132,0.06)", border: "1px solid rgba(61,220,132,0.35)", clipPath: SHELL_NOTCH(7), flexWrap: "wrap" }}>
                  <span style={{ fontSize: 13, color: "#9af5c2", fontWeight: 700 }}>✓ Connected</span>
                  {dc.handle && <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, color: "#ecf3ff" }}>{dc.handle}</span>}
                </div>
              : <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 10px 9px 12px", background: "rgba(245,196,83,0.07)", border: "1px solid rgba(245,196,83,0.45)", clipPath: SHELL_NOTCH(7), flexWrap: "wrap" }}>
                  <span style={{ fontSize: 12.5, color: "#ffe4a0", flex: "1 1 180px" }}>Not connected — required to enter a tournament.</span>
                  <button disabled={dcBusy} onClick={async () => { setDcBusy(true); try { await startDiscordOAuth(); } catch { setDcBusy(false); } }}
                    style={shellBtn("warn", { padding: "7px 14px", fontSize: 11, whiteSpace: "nowrap" })}>{dcBusy ? "…" : "◈ Connect Discord"}</button>
                </div>}
            <span style={{ fontSize: 10.5, color: "rgba(200,215,255,0.45)", display: "block", marginTop: 4 }}>
              Your handle is pulled from Discord, so captains always have the right one — and VOLT can DM you about drafts and matches.
            </span></div>
          <label style={{ gridColumn: "1 / -1" }}><span style={labS}>WhatsApp number *</span>
            <input value={d.whatsapp} inputMode="tel" placeholder="Country code first, e.g. 923001234567" onChange={e => setD({ ...d, whatsapp: e.target.value })} style={fieldS} />
            <span style={{ fontSize: 10.5, color: "rgba(200,215,255,0.45)", display: "block", marginTop: 4 }}>
              Required so you can be reached if a match is at risk. Only the host and moderators can see it, and only if you don't answer on Discord — captains and other players never do.
            </span></label>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button disabled={busy || !d.rank || !d.role || !(dc.linked || dc.handle) || (d.whatsapp || "").replace(/[^0-9]/g, "").length < 8} onClick={save} style={shellBtn("accent", { padding: "9px 18px", fontSize: 12 })}>{busy ? "…" : "✓ Save"}</button>
          {saveErr && <span style={{ fontSize: 12, color: "#ff8f9a", alignSelf: "center" }}>⚠ {saveErr}</span>}
          {!saveErr && (() => {
            const need = [];
            if (!d.rank) need.push("rank");
            if (!d.role) need.push("role");
            if (!dc.linked && !dc.handle) need.push("Discord connection");
            if ((d.whatsapp || "").replace(/[^0-9]/g, "").length < 8) need.push("WhatsApp number");
            return need.length ? <span style={{ fontSize: 11.5, color: "rgba(245,196,83,0.85)", alignSelf: "center" }}>Still needed: {need.join(", ")}</span> : null;
          })()}
          <button onClick={() => setEditing(false)} style={shellBtn("ghost", { padding: "9px 18px", fontSize: 12 })}>Cancel</button>
        </div>
      </>}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════
   MATCH REPORT — host records a match; every player earns season points.
   +50 win · ACS÷4 · K+⅓A  → one match_results row per player.
   ════════════════════════════════════════════════════════════════════ */
function MatchReport({ ev, onDone, prefill }) {
  const [teams, setTeams] = useState(null);   // [{id,name,captain,captainUserId,roster:[{id,name}]}]
  const [tA, setTA] = useState(""); const [tB, setTB] = useState("");
  const [winner, setWinner] = useState("A");
  // Round score. Optional, but entering it derives the winner — which is the
  // first thing you read off the scoreboard anyway. Stored on each player row's
  // stat_payload so the result isn't lost once the match is saved.
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const syncWinner = (a, b) => {
    const x = parseInt(a, 10), y = parseInt(b, 10);
    if (Number.isFinite(x) && Number.isFinite(y) && x !== y) setWinner(x > y ? "A" : "B");
  };
  const [label, setLabel] = useState("");
  const [lines, setLines] = useState({});     // userId → {k,a,acs}
  const [extras, setExtras] = useState({ A: [], B: [] }); // subs pulled into this match
  const [allRegs, setAllRegs] = useState([]); // every registrant this tournament (sub pool)
  const [saved, setSaved] = useState([]);     // reported matches for this tournament
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState(null); // match_label being edited (null = new match)
  // Screenshot reader. `shot` holds the parsed rows awaiting review — nothing is
  // written to the stat grid until the host confirms, because a misread ACS
  // becomes wrong season points that look plausible.
  const [shotBusy, setShotBusy] = useState(false);
  const [shotErr, setShotErr] = useState("");
  const [shot, setShot] = useState(null);   // [{ srcName, playerId|null, acs, kills, assists }]
  const fileRef = useRef(null);

  const panel = { position: "relative", background: "linear-gradient(160deg,rgba(20,26,42,0.85),rgba(10,13,22,0.85))", border: "1px solid rgba(61,123,255,0.28)", clipPath: SHELL_NOTCH(16), padding: "22px 24px", textAlign: "left" };
  const fieldS = { padding: "8px 9px", background: "rgba(10,16,30,0.65)", border: "1px solid rgba(61,123,255,0.22)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 13, boxSizing: "border-box", width: 64 };
  const secLabel = (t) => <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 12 }}>// {t}</div>;

  async function load() {
    const s = await readState();
    const board = (s?.teams || []).map(t => {
      // A team made by hand (Locker Room → add team) has a captain NAME but no
      // linked account, so there's no id to hang stats on and the captain simply
      // vanished from this form. If that captain also exists as a board player,
      // reuse THAT id — which recovers the case where a real registered player is
      // captaining a hand-made team. Otherwise keep them visible with their board
      // id so the host can see them and the screenshot reader can match them; the
      // save step filters out anyone who can't actually be stored.
      const norm = (x) => String(x || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      const capOnBoard = t.captainUserId ? null
        : (s.players || []).find(p => norm(p.name) === norm(t.captain));
      const capId = t.captainUserId || capOnBoard?.id || null;
      return {
      id: t.id, name: t.name, captainUserId: capId, captain: t.captain,
      players: [
        ...(capId ? [{ id: capId, name: t.captain, isCaptain: true }] : []),
        ...(t.roster || []).map(pid => { const p = (s.players || []).find(x => x.id === pid); return p ? { id: p.id, name: p.name } : null; }).filter(Boolean),
      ],
    };
    });
    setTeams(board);
    // Opened from a fixture card → teams, label, and winner arrive pre-filled.
    const pA = prefill && board.find(t => t.name === prefill.teamAName);
    const pB = prefill && board.find(t => t.name === prefill.teamBName);
    if (pA) setTA(pA.id); else if (board[0]) setTA(board[0].id);
    if (pB) setTB(pB.id); else if (board[1]) setTB(board[1].id);
    if (prefill?.winner) setWinner(prefill.winner);
    if (prefill?.label) setLabel(l => l || prefill.label);
    try { const r = await fetchRosterForEvent(ev.id); setAllRegs(r.all); } catch (e) { console.error(e); }
    const { data } = await __sb.from("match_results").select("match_label, team_won, points_computed, user_id, stat_payload").eq("event_id", ev.id).order("created_at", { ascending: false });
    const byLabel = {};
    (data || []).forEach(r => { const k = r.match_label || "match"; (byLabel[k] = byLabel[k] || []).push(r); });
    setSaved(Object.entries(byLabel));
  }
  useEffect(() => { load(); }, [ev?.id]);

  const teamOf = (id) => (teams || []).find(t => t.id === id);

  // Pull a reported match back into the form so its stats can be corrected.
  function editMatch(ml, rows) {
    const board = teams || [];
    const nameOfRow = (r) => r.stat_payload?.team;
    const idOfRow = (r) => r.stat_payload?.teamId;
    // Winning side first, so team A/B and the winner toggle line up.
    const sides = [...new Set(rows.map(r => idOfRow(r) || nameOfRow(r)))].filter(Boolean);
    const findTeam = (key) => board.find(t => t.id === key) || board.find(t => t.name === key);
    const t1 = findTeam(sides[0]), t2 = findTeam(sides[1]);
    if (t1) setTA(t1.id);
    if (t2) setTB(t2.id);
    const wonKey = rows.find(r => r.team_won);
    const wonId = wonKey ? (idOfRow(wonKey) || nameOfRow(wonKey)) : null;
    setWinner(wonId && t2 && (t2.id === wonId || t2.name === wonId) ? "B" : "A");
    setLabel(ml);
    // Restore the round score if it was recorded (it's identical on every row).
    const sp0 = rows.find(r => r.stat_payload && r.stat_payload.scoreA != null)?.stat_payload;
    setScoreA(sp0 ? String(sp0.scoreA) : "");
    setScoreB(sp0 ? String(sp0.scoreB) : "");
    // Restore the stat lines.
    const ls = {};
    rows.forEach(r => {
      const sp = r.stat_payload || {};
      ls[r.user_id] = { k: String(sp.k ?? ""), a: String(sp.a ?? ""), acs: String(sp.acs ?? "") };
    });
    setLines(ls);
    // Anyone in the saved match who isn't on the current roster is a sub.
    const onBoard = new Set([...(t1?.players || []), ...(t2?.players || [])].map(p => p.id));
    const exA = [], exB = [];
    rows.forEach(r => {
      if (onBoard.has(r.user_id)) return;
      const key = idOfRow(r) || nameOfRow(r);
      const who = { id: r.user_id, name: r.stat_payload?.name || "Player" };
      if (t2 && (t2.id === key || t2.name === key)) exB.push(who); else exA.push(who);
    });
    setExtras({ A: exA, B: exB });
    setEditing(ml);
    setErr("");
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch {}
  }

  function cancelEdit() {
    setEditing(null); setLines({}); setLabel(""); setExtras({ A: [], B: [] }); setErr("");
  }
  const line = (uid) => lines[uid] || { k: "", a: "", acs: "" };
  const setLine = (uid, k, v) => setLines(ls => ({ ...ls, [uid]: { ...line(uid), [k]: v.replace(/[^0-9]/g, "") } }));
  const ptsFor = (uid, won) => matchPoints({ won, acs: line(uid).acs, kills: line(uid).k, assists: line(uid).a });

  async function readScreenshot(file) {
    if (!file) return;
    setShotBusy(true); setShotErr(""); setShot(null);
    try {
      const { base64, mimeType } = await downscaleImage(file);
      const r = await fetch("/api/read-scoreboard", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image: base64, mimeType }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) throw new Error(body?.error || `Reader returned ${r.status}.`);
      const pool = [
        ...(teamOf(tA)?.players || []), ...extras.A,
        ...(teamOf(tB)?.players || []), ...extras.B,
      ];
      if (!pool.length) throw new Error("Pick the two teams first, then read the screenshot.");
      const used = new Set();
      const mapped = (body.rows || []).map((row) => {
        // One screenshot row per player — don't let a loose match claim a slot
        // an earlier, better match already took.
        const avail = pool.filter((p) => !used.has(p.id));
        const m = matchScoreboardName(row.name, avail);
        if (m) used.add(m.id);
        return { srcName: row.name, playerId: m ? m.id : null, acs: row.acs, kills: row.kills, assists: row.assists };
      });
      setShot(mapped);
    } catch (e) {
      setShotErr(e.message || "Couldn't read that screenshot.");
    }
    setShotBusy(false);
    if (fileRef.current) fileRef.current.value = "";   // let the same file be re-picked
  }

  function applyShot() {
    if (!shot) return;
    setLines((ls) => {
      const next = { ...ls };
      for (const row of shot) {
        if (!row.playerId) continue;
        next[row.playerId] = { k: String(row.kills), a: String(row.assists), acs: String(row.acs) };
      }
      return next;
    });
    setShot(null); setShotErr("");
  }


  async function save() {
    setErr(""); setBusy(true);
    try {
      const A = teamOf(tA), B = teamOf(tB);
      if (!A || !B || A.id === B.id) throw new Error("Pick two different teams.");
      // The winner drives the +50 bonus on every row, so a match saved without
      // one silently under-scores both squads. The banner can clear the winner,
      // so this has to be checked here rather than assumed.
      if (winner !== "A" && winner !== "B") throw new Error("Mark which team won before saving.");
      const ml = label.trim() || `${A.name} vs ${B.name}`;
      const rows = [];
      [[A, extras.A, winner === "A"], [B, extras.B, winner === "B"]].forEach(([team, subs, won]) => {
        [...team.players, ...subs].forEach(p => {
          if (!canBeScored(p)) return;   // no account → match_results.user_id can't be satisfied. The banner above names these players.
          const l = line(p.id);
          rows.push({
            event_id: ev.id, community_id: window.__VOLT.communityId, user_id: p.id,
            match_label: ml, team_won: won,
            // teamId is the board's stable slot id — it survives a captain
            // renaming the team. `team` is the name as it stood when reported,
            // kept so historical results read correctly.
            stat_payload: { name: p.name, team: team.name, teamId: team.id || null, k: +l.k || 0, a: +l.a || 0, acs: +l.acs || 0,
              // Round score, same on every row of the match — the only place it
              // can live, since match_results has no score column of its own.
              ...(scoreA !== "" && scoreB !== "" ? { scoreA: +scoreA, scoreB: +scoreB } : {}) },
            points_computed: ptsFor(p.id, won),
          });
        });
      });
      if (!rows.length) throw new Error(
        "Nobody on these rosters has an account, so there's nothing that can be saved. " +
        "Hand-added players can't be scored — they need to sign up for the tournament first.");
      // Always clear any existing rows for this label before inserting, not just
      // when the edit button was used. Reporting the same fixture twice from the
      // blank form used to stack a second set of rows and double every player's
      // points — silently, because nothing in the UI showed the duplicate.
      const clearKey = editing || ml;   // `ml` is the label these rows are saved under
      const { error: delErr } = await __sb.from("match_results").delete().eq("event_id", ev.id).eq("match_label", clearKey);
      if (delErr) throw delErr;
      const { error } = await __sb.from("match_results").insert(rows);
      // The DB also enforces one row per (event, player, match). If that trips,
      // say what happened rather than surfacing a constraint name.
      if (error) throw new Error(/match_results_uniq|duplicate key/i.test(error.message || "")
        ? "That match is already recorded. Open it from the bracket to edit it instead."
        : error.message);
      setLines({}); setLabel(""); setExtras({ A: [], B: [] }); setEditing(null); setScoreA(""); setScoreB(""); await load();
    } catch (e) { setErr(e.message || "Could not save the match."); }
    setBusy(false);
  }

  async function removeMatch(labelKey) {
    if (!window.confirm(`Delete "${labelKey}" and its points?`)) return;
    await __sb.from("match_results").delete().eq("event_id", ev.id).eq("match_label", labelKey);
    await load();
  }

  if (teams === null) return <div className="vg-shell" style={{ minHeight: "60vh", background: "#0a0d18", color: "rgba(200,215,255,0.6)", display: "grid", placeItems: "center", fontFamily: "'Rajdhani',sans-serif" }}>Loading rosters…</div>;

  // Attendance is scoped to the match being recorded. Listing every registrant
  // for the tournament meant scrolling past people who weren't playing to find the
  // two who didn't turn up. Subs count — they're on a roster for this match.
  // match_results.user_id is NOT NULL with a foreign key to users, so a player
  // without an account cannot be stored — at all. Hand-added players and hand-made
  // team captains fall in that bucket. They still show in the grid (so the host can
  // see the full line-up and the screenshot reader can match names), but they're
  // flagged, excluded from the save, and named in a warning. Silently dropping them
  // is what made this look like three separate bugs.
  const canBeScored = (p) => typeof p?.id === "string" && p.id.length > 30;

  const matchUserIds = new Set([
    ...(teamOf(tA)?.players || []).map((p) => p.id),
    ...(teamOf(tB)?.players || []).map((p) => p.id),
    ...extras.A.map((p) => p.id), ...extras.B.map((p) => p.id),
  ]);
  const matchRegs = allRegs.filter((r) => matchUserIds.has(r.userId));

  const rosterBlock = (teamId, side) => {
    const t = teamOf(teamId); if (!t) return null;
    const won = winner === side;
    const shown = new Set([...(teamOf(tA)?.players || []).map(p => p.id), ...(teamOf(tB)?.players || []).map(p => p.id), ...extras.A.map(p => p.id), ...extras.B.map(p => p.id)]);
    const subPool = allRegs.filter(r => !shown.has(r.userId));
    const linePlayers = [...t.players, ...extras[side]];
    return (
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <select value={teamId} onChange={e => (side === "A" ? setTA : setTB)(e.target.value)} style={{ ...fieldS, width: "auto", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700 }}>
            {teams.map(x => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
          <button onClick={() => setWinner(won ? null : side)}
            title={won ? "Click to clear the winner" : "Mark this team as the winner"}
            style={shellBtn(won ? "accent" : "ghost", { padding: "7px 12px", fontSize: 11, flex: "0 0 auto" })}>
            {won ? "✓ Winner" : "Mark winner"}
          </button>
        </div>
        {linePlayers.length === 0 && (
          <p style={{ color: "rgba(245,196,83,0.8)", fontSize: 12, margin: "0 0 8px" }}>
            Nobody on this roster — add a sub below, or pick a different team.
          </p>
        )}
        <div style={{ display: "grid", gap: 6 }}>
          {linePlayers.map(p => { const ok = canBeScored(p); return (
            <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px",
              background: ok ? "rgba(255,255,255,0.03)" : "rgba(245,196,83,0.08)",
              border: `1px solid ${ok ? "rgba(120,150,220,0.14)" : "rgba(245,196,83,0.4)"}`, clipPath: SHELL_NOTCH(6) }}>
              <span style={{ flex: 1, minWidth: 90, fontWeight: 700, textTransform: "uppercase", fontSize: 13 }}>{p.name}
                {p.isCaptain && <span style={{ fontSize: 9.5, letterSpacing: "0.1em", color: "#f5c453", marginLeft: 6 }}>CAPT</span>}
                {!ok && <span title="No account — stats can't be saved for this player" style={{ display: "block", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "rgba(245,196,83,0.85)", fontWeight: 700 }}>no account · won't save</span>}
              </span>
              {/* ACS first, then K then A — the column order Valorant's scoreboard
                  uses, so you read across the game screen and type across the row. */}
              <input placeholder="ACS" value={line(p.id).acs} onChange={e => setLine(p.id, "acs", e.target.value)} style={fieldS} aria-label={`${p.name} ACS`} />
              <input placeholder="K" value={line(p.id).k} onChange={e => setLine(p.id, "k", e.target.value)} style={fieldS} aria-label={`${p.name} kills`} />
              <input placeholder="A" value={line(p.id).a} onChange={e => setLine(p.id, "a", e.target.value)} style={fieldS} aria-label={`${p.name} assists`} />
              <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontWeight: 700, color: won ? "#3ddc84" : "#7da6ff", width: 58, textAlign: "right" }}>{ptsFor(p.id, won)} pts</span>
              {extras[side].some(x => x.id === p.id) &&
                <button onClick={() => setExtras(ex => ({ ...ex, [side]: ex[side].filter(x => x.id !== p.id) }))} aria-label={`Remove sub ${p.name}`} style={{ background: "none", border: "none", color: "#ff8a94", cursor: "pointer", fontSize: 13, padding: "0 2px" }}>✕</button>}
            </div>
          ); })}
        </div>
        {subPool.length === 0 && (
          <p style={{ fontSize: 11, color: "rgba(200,215,255,0.4)", margin: "6px 0 0" }}>
            No subs available — only approved registrants can be subbed in.
          </p>
        )}
        {subPool.length > 0 && (
          <select value="" onChange={e => { const r = subPool.find(x => x.userId === e.target.value); if (r) setExtras(ex => ({ ...ex, [side]: [...ex[side], { id: r.userId, name: r.name }] })); }}
            style={{ marginTop: 8, padding: "8px 9px", background: "rgba(10,16,30,0.65)", border: "1px dashed rgba(61,220,132,0.4)", color: "#9af5c2", fontFamily: "'Rajdhani',sans-serif", fontWeight: 700, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", cursor: "pointer" }}>
            <option value="">+ Add sub…</option>
            {subPool.map(r => <option key={r.userId} value={r.userId}>{r.name}{r.rank ? ` · ${r.rank}` : ""}</option>)}
          </select>
        )}
      </div>
    );
  };

  return <div className="vg-shell" style={{ minHeight: "70vh", background: "#0a0d18", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", padding: "40px 20px 60px" }}>
    <div style={{ maxWidth: 980, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 24 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.35em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase", textShadow: "0 0 14px rgba(61,123,255,0.6)" }}>// {weekendName(ev)} · Match report</div>
        <h1 style={{ fontSize: 34, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", margin: "6px 0 4px" }}>Record a <span style={{ color: "#3d7bff" }}>Match</span></h1>
        <p style={{ color: "rgba(200,215,255,0.55)", margin: 0, fontSize: 13 }}>+50 win · ACS÷4 · K+⅓A — points bank to the season leaderboard instantly.</p>
      </div>
      <div style={panel}>
        <span style={{ position: "absolute", left: 0, top: 0, width: 9, height: 9, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />
        {secLabel("Match")}
        {editing && (
          <div className="flex items-center justify-between gap-3 flex-wrap" style={{ padding: "10px 14px", marginBottom: 14, background: "rgba(245,196,83,0.08)", border: "1px solid rgba(245,196,83,0.45)", clipPath: SHELL_NOTCH(8) }}>
            <span style={{ fontSize: 12.5, color: "#f5c453", fontWeight: 700 }}>
              ✎ Editing <b style={{ color: "#ffe4a0" }}>{editing}</b> — saving replaces the existing stats and points.
            </span>
            <button onClick={cancelEdit} style={shellBtn("ghost", { padding: "5px 11px", fontSize: 11 })}>Cancel edit</button>
          </div>
        )}

        {/* Matchup banner — one line. The winner is a trophy beside the name rather
            than a second row of text, and the round score sits between them, which
            is the order you read it off the scoreboard. Entering the score sets the
            winner, so the buttons below become a fallback rather than a step. */}
        {(() => {
          const A = teamOf(tA), B = teamOf(tB);
          const ready = A && B && A.id !== B.id;
          const scoreBox = (val, set, other, side) => (
            <input value={val} inputMode="numeric" placeholder="–" aria-label={`${side === "A" ? "Team A" : "Team B"} rounds won`}
              onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, "").slice(0, 2); set(v); side === "A" ? syncWinner(v, other) : syncWinner(other, v); }}
              style={{ width: 46, padding: "5px 4px", textAlign: "center", background: "rgba(10,16,30,0.85)",
                border: `1px solid ${winner === side ? "rgba(61,220,132,0.5)" : "rgba(120,150,220,0.25)"}`,
                color: winner === side ? "#9af5c2" : "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace",
                fontSize: 17, fontWeight: 700 }} />
          );
          // Each side is one group: trophy (winner only) → name → score. Same
          // order on both sides, so the eye reads straight across.
          const sideGroup = (t, side, val, set, other) => {
            const won = winner === side;
            const hue = t?.hue || (side === "A" ? "#ff4655" : "#00e5ff");
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 9, minWidth: 0,
                justifyContent: side === "A" ? "flex-end" : "flex-start" }}>
                {won && <span style={{ color: "#f5c453" }} title="Winner"><TrophyIcon /></span>}
                <span style={{ minWidth: 0, overflowWrap: "anywhere", textAlign: side === "A" ? "right" : "left",
                  fontFamily: "'Rajdhani',sans-serif", fontSize: 21, fontWeight: 800, textTransform: "uppercase",
                  lineHeight: 1.1, color: t ? (won ? "#ffffff" : "rgba(220,231,255,0.6)") : "rgba(200,215,255,0.3)",
                  textShadow: won ? `0 0 20px ${hue}77` : "none" }}>{t?.name || "Not set"}</span>
                {scoreBox(val, set, other, side)}
              </div>
            );
          };
          return (
            <div style={{ padding: "14px 18px", marginBottom: 14,
              background: "linear-gradient(160deg, rgba(10,16,30,0.7), rgba(8,11,19,0.6))",
              border: `1px solid ${ready ? "rgba(61,123,255,0.3)" : "rgba(245,196,83,0.4)"}`, clipPath: SHELL_NOTCH(10) }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", columnGap: 14 }}>
                {sideGroup(A, "A", scoreA, setScoreA, scoreB)}
                <span style={{ fontFamily: "'Rajdhani',sans-serif", fontSize: 11, fontWeight: 800, letterSpacing: "0.18em", color: "rgba(200,215,255,0.35)" }}>VS</span>
                {sideGroup(B, "B", scoreB, setScoreB, scoreA)}
              </div>
              {!ready && (
                <div style={{ textAlign: "center", marginTop: 8, fontSize: 11.5, color: "rgba(245,196,83,0.85)" }}>
                  Pick two different teams to report a match.
                </div>
              )}
            </div>
          );
        })()}

        {(() => {
          const inMatch = [
            ...(teamOf(tA)?.players || []), ...extras.A,
            ...(teamOf(tB)?.players || []), ...extras.B,
          ];
          const unscoreable = inMatch.filter((p) => !canBeScored(p));
          if (!unscoreable.length) return null;
          return (
            <div style={{ margin: "4px 0 14px", padding: "12px 14px", background: "rgba(245,196,83,0.09)", border: "1px solid rgba(245,196,83,0.45)", clipPath: SHELL_NOTCH(9) }}>
              <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#f5c453" }}>
                {unscoreable.length} player{unscoreable.length === 1 ? "" : "s"} can't be scored
              </div>
              <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.6)", marginTop: 4, lineHeight: 1.5 }}>
                {unscoreable.map((p) => p.name).join(", ")} {unscoreable.length === 1 ? "was" : "were"} added by hand and {unscoreable.length === 1 ? "has" : "have"} no account,
                so season points can't be stored for {unscoreable.length === 1 ? "them" : "them"}. Everyone else saves normally.
                To score {unscoreable.length === 1 ? "them" : "them"}, they need to sign up for the tournament and be approved.
              </div>
            </div>
          );
        })()}

        {/* Screenshot reader. Optional shortcut — the grid below still works by
            hand, and stays the way you correct anything the reader gets wrong. */}
        <div style={{ margin: "4px 0 16px", padding: "12px 14px", background: "rgba(61,220,132,0.05)", border: "1px solid rgba(61,220,132,0.28)", clipPath: SHELL_NOTCH(9) }}>
          <div className="flex items-center gap-10 flex-wrap" style={{ gap: 10 }}>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: "none" }}
              onChange={(e) => readScreenshot(e.target.files && e.target.files[0])} />
            <button disabled={shotBusy} onClick={() => fileRef.current && fileRef.current.click()}
              style={shellBtn("accent", { padding: "9px 15px", fontSize: 12, opacity: shotBusy ? 0.5 : 1 })}>
              {shotBusy ? "Reading…" : "⊞ Read from screenshot"}
            </button>
            <span style={{ fontSize: 11.5, color: "rgba(200,215,255,0.5)" }}>
              Upload the end-of-match scoreboard. You'll review everything before it fills in.
            </span>
          </div>
          {shotErr && <div style={{ fontSize: 11.5, color: "#ff8f9a", marginTop: 8 }}>⚠ {shotErr}</div>}

          {shot && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", fontWeight: 700, color: "#9af5c2", marginBottom: 6 }}>
                Check this against the screenshot
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                {shot.map((row, i) => {
                  const pool = [
                    ...(teamOf(tA)?.players || []), ...extras.A,
                    ...(teamOf(tB)?.players || []), ...extras.B,
                  ];
                  const taken = new Set(shot.filter((r, k) => k !== i && r.playerId).map((r) => r.playerId));
                  return (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", padding: "7px 10px",
                      background: row.playerId ? "rgba(255,255,255,0.03)" : "rgba(245,196,83,0.1)",
                      border: `1px solid ${row.playerId ? "rgba(120,150,220,0.16)" : "rgba(245,196,83,0.45)"}`, clipPath: SHELL_NOTCH(5) }}>
                      <span style={{ fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, color: "rgba(200,215,255,0.7)", minWidth: 110 }}>{row.srcName}</span>
                      <span style={{ color: "rgba(200,215,255,0.35)", fontSize: 11 }}>→</span>
                      <select value={row.playerId || ""}
                        onChange={(e) => setShot((rs) => rs.map((r, k) => k === i ? { ...r, playerId: e.target.value || null } : r))}
                        style={{ padding: "5px 8px", background: "rgba(10,16,30,0.85)", border: "1px solid rgba(61,123,255,0.3)", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", fontSize: 12.5, fontWeight: 600 }}>
                        <option value="">— skip this row —</option>
                        {pool.map((p) => (
                          <option key={p.id} value={p.id} disabled={taken.has(p.id)}>{p.name}{taken.has(p.id) ? " (taken)" : ""}</option>
                        ))}
                      </select>
                      <span style={{ flex: 1 }} />
                      {["acs", "kills", "assists"].map((f) => (
                        <label key={f} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                          <span style={{ fontSize: 9.5, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)" }}>{f === "acs" ? "ACS" : f === "kills" ? "K" : "A"}</span>
                          <input value={row[f]} inputMode="numeric"
                            onChange={(e) => { const v = e.target.value.replace(/[^0-9]/g, ""); setShot((rs) => rs.map((r, k) => k === i ? { ...r, [f]: v === "" ? 0 : Number(v) } : r)); }}
                            style={{ width: 52, padding: "4px 6px", background: "rgba(10,16,30,0.85)", border: "1px solid rgba(120,150,220,0.25)", color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace", fontSize: 12, textAlign: "center" }} />
                        </label>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-3 flex-wrap" style={{ marginTop: 10, gap: 10 }}>
                <button onClick={applyShot} style={shellBtn("primary", { padding: "9px 16px", fontSize: 12 })}>
                  Fill in {shot.filter((r) => r.playerId).length} player{shot.filter((r) => r.playerId).length === 1 ? "" : "s"} →
                </button>
                <button onClick={() => { setShot(null); setShotErr(""); }} style={shellBtn("ghost", { padding: "9px 14px", fontSize: 12 })}>Discard</button>
                {shot.some((r) => !r.playerId) && (
                  <span style={{ fontSize: 11.5, color: "rgba(245,196,83,0.85)" }}>
                    {shot.filter((r) => !r.playerId).length} row{shot.filter((r) => !r.playerId).length === 1 ? "" : "s"} unmatched — assign or skip.
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 20, alignItems: "start" }}>
          {rosterBlock(tA, "A")}
          {rosterBlock(tB, "B")}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 18, alignItems: "center" }}>
          <button disabled={busy} onClick={save} style={shellBtn(editing ? "accent" : "primary", { padding: "11px 24px", fontSize: 13 })}>{busy ? "…" : editing ? "✎ Update match →" : "Save match →"}</button>
          <button onClick={onDone} style={shellBtn("ghost", { padding: "11px 18px", fontSize: 13 })}>Done</button>
          {err && <span style={{ color: "#ff8a94", fontSize: 13 }}>{err}</span>}
        </div>
      </div>

      {saved.length > 0 && <div style={{ ...panel, marginTop: 16 }}>
        {secLabel(`Reported this tournament · ${saved.length}`)}
        <div style={{ display: "grid", gap: 6 }}>
          {saved.map(([ml, rows]) => (
            <div key={ml} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(120,150,220,0.14)", clipPath: SHELL_NOTCH(7) }}>
              <span style={{ flex: 1, fontWeight: 700, textTransform: "uppercase", fontSize: 13 }}>{ml}</span>
              <span style={{ fontSize: 12, color: "rgba(200,215,255,0.5)" }}>{rows.length} players · {rows.reduce((s, r) => s + Number(r.points_computed || 0), 0)} pts</span>
              <button onClick={() => editMatch(ml, rows)} style={shellBtn(editing === ml ? "accent" : "ghost", { padding: "5px 10px", fontSize: 10 })}>{editing === ml ? "Editing…" : "✎ Edit stats"}</button>
              <button onClick={() => removeMatch(ml)} style={shellBtn("danger", { padding: "5px 10px", fontSize: 10 })}>Delete</button>
            </div>
          ))}
        </div>
      </div>}

      {/* ── Attendance — flag players who confirmed availability but ghosted.
             2nd strike auto-suspends them for the next 2 tournaments (DB trigger).
             Unmarking a mistake lifts an active suspension. ── */}
      {matchRegs.length === 0 && (teamOf(tA) || teamOf(tB)) && (
        <div style={{ ...panel, marginTop: 16, borderColor: "rgba(120,150,220,0.2)" }}>
          {secLabel("Attendance")}
          <p style={{ fontSize: 12, color: "rgba(200,215,255,0.45)", margin: 0 }}>
            No-shows are tracked against a player's registration, so there's nothing to mark here —
            nobody in this match signed up for the tournament through the app.
          </p>
        </div>
      )}
      {matchRegs.length > 0 && <div style={{ ...panel, marginTop: 16, borderColor: "rgba(255,70,85,0.3)" }}>
        {secLabel(`Attendance · ${matchRegs.filter(r => r.noShow).length} no-show${matchRegs.filter(r => r.noShow).length === 1 ? "" : "s"} in this match`)}
        <p style={{ fontSize: 12, color: "rgba(200,215,255,0.45)", margin: "0 0 10px" }}>
          Only the players in this match. Mark anyone who confirmed availability but didn't show — a strike counts for the whole tournament, and a 2nd auto-suspends them for the next 2 tournaments. Unmark to forgive (this also lifts an active suspension).
        </p>
        <div style={{ display: "grid", gap: 5 }}>
          {matchRegs.map(r => {
            const played = saved.some(([, rows]) => rows.some(x => x.user_id === r.userId));
            return (
              <div key={r.userId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: r.noShow ? "rgba(255,70,85,0.06)" : "rgba(255,255,255,0.02)", border: `1px solid ${r.noShow ? "rgba(255,70,85,0.3)" : "rgba(120,150,220,0.12)"}`, clipPath: SHELL_NOTCH(6), flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, textTransform: "uppercase", fontSize: 13, flex: 1, minWidth: 110, color: r.noShow ? "#ff8f9a" : "#ecf3ff" }}>{r.name}</span>
                {played && <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9af5c2", fontWeight: 700 }}>played ✓</span>}
                {!played && !r.noShow && <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(200,215,255,0.35)" }}>no matches yet</span>}
                {r.noShows > 0 && <span style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: r.noShows >= 2 ? "#ff4655" : "#f5c453", fontWeight: 700, border: `1px solid ${r.noShows >= 2 ? "rgba(255,70,85,0.5)" : "rgba(245,196,83,0.4)"}`, padding: "2px 7px", clipPath: SHELL_NOTCH(4) }}>⚠ {r.noShows} strike{r.noShows === 1 ? "" : "s"}</span>}
                <button disabled={busy} onClick={async () => { setBusy(true); try { await __sb.from("registrations").update({ no_show: !r.noShow }).eq("id", r.regId); await load(); } catch (e) { console.error(e); } setBusy(false); }}
                  style={shellBtn(r.noShow ? "ghost" : "danger", { padding: "5px 11px", fontSize: 10 })}>
                  {r.noShow ? "Unmark" : "No-show"}</button>
              </div>
            );
          })}
        </div>
      </div>}
    </div>
  </div>;
}

// Registration — professional single-flow: status, profile, live registrant
// roster. Captaincy is the host's call; players can only quietly
// signal availability. The host assigns captains from the roster below.
function WeekendRegistration({ ev, auth, phase }) {
  // Sign-ups run through BOTH registration phases. What changes at the boundary
  // is whether you land in the draft pool or the reserves, not whether you can join.
  const regOpen = phase === "registration_open" || phase === "registration_closed";
  const poolOpen = phase === "registration_open";
  const isHost = auth?.role === "host";
  const [reg, setReg] = useState(undefined);
  const [roster, setRoster] = useState([]);       // approved
  const [pendingQ, setPendingQ] = useState([]);   // host queue
  const [rejectedQ, setRejectedQ] = useState([]);
  const [myProf, setMyProf] = useState(undefined);
  const [susp, setSusp] = useState(0);            // tournaments left on suspension
  const [myStrikes, setMyStrikes] = useState(0);  // my season no-show count
  const [avail, setAvail] = useState(false);      // availability confirmation
  const [wantCap, setWantCap] = useState(false);  // captain volunteer (optional)
  const [openApp, setOpenApp] = useState(null);   // expanded applicant in the host queue
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!HAS_SUPABASE) { setReg(null); setRoster([]); setMyProf(null); return; }
    const { data } = await __sb.from("registrations").select("*").eq("event_id", ev.id).eq("user_id", window.__VOLT.userId).maybeSingle();
    setReg(data || null);
    try {
      const r = await fetchRosterForEvent(ev.id);
      setRoster(r.all); setPendingQ(r.pending); setRejectedQ(r.rejected);
    } catch (e) { console.error(e); }
    try {
      setMyProf(await loadProfileGate(window.__VOLT.userId));
    } catch (e) { console.error(e); setMyProf(null); }
    try {
      const { data: u } = await __sb.from("users").select("suspension_remaining, wants_captain").eq("id", window.__VOLT.userId).maybeSingle();
      setSusp(u?.suspension_remaining || 0);
      const { data: ns } = await __sb.from("registrations").select("id")
        .eq("community_id", window.__VOLT.communityId).eq("user_id", window.__VOLT.userId).eq("no_show", true);
      setMyStrikes((ns || []).length);
    } catch (e) { console.error(e); }
  }
  useEffect(() => { load(); const stop = visInterval(load, 10000); return () => stop(); }, [ev?.id]);

  const profileComplete = profileIsComplete(myProf);

  async function apply() {
    if (!profileComplete || !avail) return;
    setBusy(true);
    try {
      const { error } = await __sb.rpc("volt_apply", { p_event: ev.id, p_wants_captain: wantCap });
      if (error) throw error;
      await load();
    } catch (e) { console.error(e); }
    setBusy(false);
  }
  async function withdraw() {
    setBusy(true);
    try { const { error } = await __sb.rpc("volt_withdraw", { p_event: ev.id }); if (error) throw error; await load(); }
    catch (e) { console.error(e); }
    setBusy(false);
  }
  // Host decision — the only way into the tournament pool.
  async function hostDecide(entry, status) {
    setBusy(true);
    try {
      await __sb.from("registrations").update({ status }).eq("id", entry.regId);
      await voltNotify([{ community_id: window.__VOLT.communityId, user_id: entry.userId, event_id: ev.id, kind: status === "approved" ? "approved" : "rejected",
        title: status === "approved" ? "You're in — " + weekendName(ev) : "Application not approved",
        body: status === "approved" ? "Approved for the pool. Captains can draft you now." : "The host didn't approve this one. Reach out if that's a mistake." }]);
      await load();
    } catch (e) { console.error(e); }
    setBusy(false);
  }
  // Player side: a quiet availability signal only — not a captain claim.
  async function volunteer(v) {
    setBusy(true);
    try { const { error } = await __sb.rpc("volt_wants_captain", { p_event: ev.id, p_v: v }); if (error) throw error; await load(); }
    catch (e) { console.error(e); }
    setBusy(false);
  }
  // Host side: the actual captain decision.
  async function hostSetCaptain(entry, v) {
    setBusy(true);
    try {
      await __sb.from("registrations").update({ is_captain: v }).eq("id", entry.regId);
      if (v) await voltNotify([{ community_id: window.__VOLT.communityId, user_id: entry.userId, event_id: ev.id, kind: "captain",
        title: "★ You're a captain this tournament", body: "$10,000 budget in " + weekendName(ev) + ". Scout the pool and build your squad." }]);
      await load();
    } catch (e) { console.error(e); }
    setBusy(false);
  }

  // Full submitted profile — one renderer for the queue and the roster.
  const profileDetail = (r, borderColor) => {
    const stat = (label, val) => val != null && val !== "" && (
      <div key={label} style={{ padding: "7px 11px", background: "rgba(10,16,30,0.7)", border: "1px solid rgba(61,123,255,0.25)", clipPath: SHELL_NOTCH(6), minWidth: 62 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.18em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700 }}>{label}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#ecf3ff", fontFamily: "'IBM Plex Mono',monospace" }}>{val}</div>
      </div>
    );
    return (
      <div style={{ padding: "2px 14px 14px 34px", borderTop: `1px solid ${borderColor}` }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {stat("Rank", r.rank ? rankLabel(r.rank, r.rankDiv) : null)}{stat("Peak", r.peakRank ? rankLabel(r.peakRank, r.peakRankDiv) : null)}{stat("Role", r.role)}{stat("Agent", r.agent)}{stat("KDA", r.kda)}{stat("ACS", r.acs)}{stat("HS%", r.hs != null && r.hs !== "" ? r.hs + "%" : null)}{stat("Win%", r.win != null && r.win !== "" ? r.win + "%" : null)}
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", marginTop: 10, flexWrap: "wrap", fontSize: 12, color: "rgba(200,215,255,0.55)" }}>
          {r.volunteered && <span style={{ color: "#7da6ff", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 11 }}>✋ wants to captain</span>}
          <span>{r.noShows > 0 ? `${r.noShows} no-show${r.noShows === 1 ? "" : "s"} this season` : "Clean attendance record"}</span>
          {r.tracker
            ? <a href={r.tracker} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} style={{ color: "#7da6ff", textDecoration: "underline", fontWeight: 600 }}>Open tracker profile ↗</a>
            : <span style={{ color: "rgba(200,215,255,0.35)" }}>No tracker link provided</span>}
        </div>
        {!r.rank && !r.role && <p style={{ margin: "10px 0 0", fontSize: 12, color: "#ff8f9a" }}>⚠ Empty scouting profile — likely not a serious application.</p>}
      </div>
    );
  };

  const myStatus = reg ? (reg.status || "approved") : null;
  const isIn = myStatus === "approved";
  const me = roster.find(r => r.userId === window.__VOLT.userId);
  const panel = { position: "relative", background: "linear-gradient(160deg,rgba(20,26,42,0.85),rgba(10,13,22,0.85))", border: "1px solid rgba(61,123,255,0.28)", clipPath: SHELL_NOTCH(16), padding: "22px 24px", textAlign: "left" };
  const corner = <span style={{ position: "absolute", left: 0, top: 0, width: 9, height: 9, borderLeft: "2px solid #3d7bff", borderTop: "2px solid #3d7bff" }} />;
  const secLabel = (t) => <div style={{ fontSize: 11, letterSpacing: "0.28em", textTransform: "uppercase", color: "#5b8dff", fontWeight: 700, marginBottom: 12 }}>// {t}</div>;

  return <div className="vg-shell" style={{ minHeight: "70vh", background: "#0a0d18", color: "#ecf3ff", fontFamily: "'Rajdhani',sans-serif", padding: "44px 20px 60px" }}>
    <div style={{ maxWidth: 680, margin: "0 auto" }}>
      <div style={{ textAlign: "center", marginBottom: 26 }}>
        <div style={{ fontSize: 12, letterSpacing: "0.35em", color: "#5b8dff", fontWeight: 700, textTransform: "uppercase", textShadow: "0 0 14px rgba(61,123,255,0.6)" }}>// {weekendName(ev)}</div>
        <h1 style={{ fontSize: 38, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", margin: "6px 0 4px" }}>Registration {regOpen ? <span style={{ color: "#3ddc84" }}>Open</span> : <span style={{ color: "#ff8a94" }}>Closed</span>}</h1>
        <p style={{ color: "rgba(200,215,255,0.55)", margin: 0, fontSize: 14 }}>{poolOpen ? "Claim your spot in this tournament's draft pool." : regOpen ? "The draft pool is closed — you can still sign up as a reserve." : "Registration is closed for this tournament."}</p>
        <p style={{ color: "rgba(200,215,255,0.4)", margin: "8px auto 0", fontSize: 12.5, maxWidth: 520 }}>
          {ev?.draft_at && <span style={{ color: "#7da6ff", fontFamily: "'IBM Plex Mono',monospace" }}>Draft: {new Date(ev.draft_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} · {new Date(ev.draft_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} — </span>}
          Teams form from whoever registers (roughly one per 5 players). Not drafted? You can still be subbed into matches — every match you play banks season points.</p>
      </div>

      {reg === undefined ? <p className="vg-loading">// Syncing…</p> : (
        // Host sees the queue and roster first — reviewing people is the job;
        // their own application is secondary. Players see theirs first.
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* ── HOST: application review queue ── */}
        {isHost && (pendingQ.length > 0 || rejectedQ.length > 0) && (
          <div style={{ ...panel, order: 1, borderColor: "rgba(245,196,83,0.4)" }}>
            {corner}
            {secLabel(`Applications · ${pendingQ.length} pending`)}
            {pendingQ.length > 0 && (
              <p style={{ fontSize: 11.5, color: "rgba(200,215,255,0.5)", margin: "0 0 10px" }}>
                Tap a row to see their full stats and history before you decide.
              </p>
            )}
            {pendingQ.length === 0 && <p style={{ color: "rgba(200,215,255,0.45)", fontSize: 13, margin: 0 }}>Queue clear.</p>}
            <div style={{ display: "grid", gap: 6 }}>
              {pendingQ.map(r => {
                const openIt = openApp === r.userId;
                return (
                  <div key={r.userId} style={{ background: "rgba(245,196,83,0.05)", border: `1px solid rgba(245,196,83,${openIt ? "0.45" : "0.25"})`, clipPath: SHELL_NOTCH(7) }}>
                    <div onClick={() => setOpenApp(openIt ? null : r.userId)} role="button" tabIndex={0}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenApp(openIt ? null : r.userId); } }}
                      className="vg-row-x" title={openIt ? "Hide full stats" : "Show full stats before deciding"}
                      aria-expanded={openIt}
                      style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", flexWrap: "wrap", cursor: "pointer" }}>
                      <span aria-hidden="true" className="vg-chev" style={{ display: "grid", placeItems: "center",
                        width: 22, height: 22, flex: "0 0 auto", color: "#f5c453",
                        border: `1px solid rgba(245,196,83,${openIt ? "0.7" : "0.38"})`,
                        background: `rgba(245,196,83,${openIt ? "0.22" : "0.09"})`,
                        transform: openIt ? "rotate(90deg)" : "none" }}><ChevronIcon /></span>
                      <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 14, flex: 1, minWidth: 120 }}>{r.name}</span>
                      {r.rank && <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: (RANKS[r.rank] || {}).c || "#8d97a8", fontWeight: 700 }}>{r.rank}</span>}
                      {r.role && <span style={{ fontSize: 11, textTransform: "uppercase", color: "rgba(200,215,255,0.55)" }}>{r.role}</span>}
                      <span title="Confirmed availability" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: r.available ? "#9af5c2" : "#ff8f9a", fontWeight: 700 }}>{r.available ? "✓ available" : "no confirm"}</span>
                      {r.noShows > 0 && <span title="Season no-shows" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: r.noShows >= 2 ? "#ff4655" : "#f5c453", fontWeight: 700, border: `1px solid ${r.noShows >= 2 ? "rgba(255,70,85,0.5)" : "rgba(245,196,83,0.4)"}`, padding: "2px 7px", clipPath: SHELL_NOTCH(4) }}>⚠ {r.noShows} no-show{r.noShows === 1 ? "" : "s"}</span>}
                      <span className="vg-chev-label" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", fontWeight: 700, color: "rgba(245,196,83,0.7)", whiteSpace: "nowrap" }}>{openIt ? "Hide stats" : "Full stats"}</span>
                      <button disabled={busy} onClick={e => { e.stopPropagation(); hostDecide(r, "approved"); }} style={shellBtn("accent", { padding: "6px 14px", fontSize: 11 })}>Approve</button>
                      <button disabled={busy} onClick={e => { e.stopPropagation(); hostDecide(r, "rejected"); }} style={shellBtn("danger", { padding: "6px 12px", fontSize: 11 })}>Reject</button>
                    </div>
                    {openIt && profileDetail(r, "rgba(245,196,83,0.15)")}
                  </div>
                );
              })}
            </div>
            {rejectedQ.length > 0 && <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 10, letterSpacing: "0.24em", textTransform: "uppercase", color: "rgba(200,215,255,0.35)", fontWeight: 700, marginBottom: 6 }}>// Rejected · {rejectedQ.length}</div>
              <div style={{ display: "grid", gap: 4 }}>
                {rejectedQ.map(r => (
                  <div key={r.userId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", opacity: 0.6, background: "rgba(255,255,255,0.02)", border: "1px solid rgba(120,150,220,0.1)", clipPath: SHELL_NOTCH(6) }}>
                    <span style={{ fontWeight: 700, textTransform: "uppercase", fontSize: 12.5, flex: 1 }}>{r.name}</span>
                    <button disabled={busy} onClick={() => hostDecide(r, "approved")} style={shellBtn("ghost", { padding: "4px 10px", fontSize: 10 })}>Approve anyway</button>
                  </div>
                ))}
              </div>
            </div>}
          </div>
        )}

        <div style={{ ...panel, order: isHost ? 3 : 1 }}>
          {corner}
          {secLabel(isHost && !reg ? "Your registration (host)" : "Your application")}
          {/* status line */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%",
                background: isIn ? "#3ddc84" : myStatus === "pending" ? "#f5c453" : myStatus === "rejected" ? "#ff4655" : "rgba(200,215,255,0.25)",
                boxShadow: isIn ? "0 0 10px rgba(61,220,132,0.8)" : myStatus === "pending" ? "0 0 10px rgba(245,196,83,0.7)" : "none" }} />
              <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", fontSize: 15,
                color: isIn ? "#9af5c2" : myStatus === "pending" ? "#f5c453" : myStatus === "rejected" ? "#ff8f9a" : "rgba(200,215,255,0.7)" }}>
                {isIn ? "You're in this tournament" :
                 myStatus === "pending" ? "Application pending — waiting for host approval" :
                 myStatus === "rejected" ? "Not approved for this tournament" :
                 regOpen ? "Not applied" : "You didn't apply this tournament"}</span>
            </div>
            {regOpen && myStatus === "pending" && <button disabled={busy} onClick={withdraw} style={shellBtn("ghost", { padding: "8px 16px", fontSize: 12 })}>{busy ? "…" : "Withdraw"}</button>}
            {regOpen && isIn && <button disabled={busy} onClick={withdraw} style={shellBtn("ghost", { padding: "8px 16px", fontSize: 12 })}>{busy ? "…" : "Drop out"}</button>}
          </div>

          {/* suspended players sit out — the DB blocks the insert anyway */}
          {regOpen && !reg && susp > 0 && (
            <div style={{ marginTop: 14, padding: "14px 16px", background: "rgba(255,70,85,0.07)", border: "1px solid rgba(255,70,85,0.4)", clipPath: SHELL_NOTCH(8) }}>
              <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: "#ff8f9a" }}>Suspended — {susp} tournament{susp === 1 ? "" : "s"} remaining</div>
              <p style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", margin: "6px 0 0" }}>Repeated no-shows triggered an automatic suspension. It counts down as league tournaments settle. Talk to the host if you think this is a mistake.</p>
            </div>
          )}

          {/* application form — profile completeness + availability gate the button */}
          {regOpen && !reg && susp === 0 && <>
            <div style={{ marginTop: 14, padding: "12px 14px", background: "rgba(61,123,255,0.05)", border: "1px solid rgba(61,123,255,0.2)", clipPath: SHELL_NOTCH(8) }}>
              <div style={{ fontSize: 12, letterSpacing: "0.16em", textTransform: "uppercase", fontWeight: 700, color: profileComplete ? "#9af5c2" : "#f5c453" }}>
                {myProf === undefined ? "Checking your profile…" : profileComplete ? "✓ Scouting profile complete" : `① Complete your scouting profile — still needed: ${profileMissing(myProf).join(", ")}`}</div>
              {HAS_SUPABASE && <ScoutProfileCard userId={window.__VOLT.userId} onSaved={load} />}
              {HAS_SUPABASE && <DiscordLinkCard />}
            </div>
            {myStrikes > 0 && (
              <div style={{ marginTop: 14, padding: "11px 14px", background: myStrikes % 3 === 2 ? "rgba(255,70,85,0.07)" : "rgba(245,196,83,0.06)", border: `1px solid ${myStrikes % 3 === 2 ? "rgba(255,70,85,0.45)" : "rgba(245,196,83,0.35)"}`, clipPath: SHELL_NOTCH(7) }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: myStrikes % 3 === 2 ? "#ff8f9a" : "#f5c453" }}>
                  ⚠ {myStrikes} no-show{myStrikes === 1 ? "" : "s"} on record</span>
                <span style={{ fontSize: 12.5, color: "rgba(200,215,255,0.55)", marginLeft: 6 }}>
                  {myStrikes % 3 === 2 ? "— one more triggers an automatic 3-tournament suspension. Only apply if you can really make it." : "— every 3rd triggers an automatic 3-tournament suspension."}</span>
              </div>
            )}
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 14, cursor: "pointer", color: avail ? "#9af5c2" : "rgba(200,215,255,0.65)", fontSize: 13.5, lineHeight: 1.4 }}>
              <input type="checkbox" checked={avail} onChange={e => setAvail(e.target.checked)} style={{ accentColor: "#3ddc84", marginTop: 2, width: 16, height: 16 }} />
              <span><b style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>② I confirm I'm available this tournament</b> — {ev?.draft_at ? `draft on ${new Date(ev.draft_at).toLocaleDateString(undefined, { weekday: "short" })} ${new Date(ev.draft_at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} and` : "the draft and"} up to 4 matches. No-shows hurt your team.</span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 10, marginTop: 12, cursor: "pointer", color: wantCap ? "#7da6ff" : "rgba(200,215,255,0.55)", fontSize: 13, lineHeight: 1.4 }}>
              <input type="checkbox" checked={wantCap} onChange={e => setWantCap(e.target.checked)} style={{ accentColor: "#3d7bff", marginTop: 2, width: 16, height: 16 }} />
              <span><b style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}>Available to captain</b> <span style={{ color: "rgba(200,215,255,0.4)" }}>(optional)</span> — you'd run the auction budget and draft your squad. The host makes the final call.</span>
            </label>
            {!poolOpen && (
              <div style={{ marginTop: 12, padding: "11px 13px", background: "rgba(61,220,132,0.07)", border: "1px solid rgba(61,220,132,0.35)", clipPath: SHELL_NOTCH(8) }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "#9af5c2" }}>Signing up as a reserve</div>
                <div style={{ fontSize: 11.5, color: "rgba(200,215,255,0.55)", marginTop: 3 }}>
                  The draft pool has closed, so captains can't bid on you. You'll appear in the Reserve Hub and can be subbed into matches — every match you play still banks season points.
                </div>
              </div>
            )}
            <button disabled={busy || !profileComplete || !avail} onClick={apply}
              style={shellBtn("primary", { width: "100%", marginTop: 14, padding: "13px", fontSize: 14, opacity: (busy || !profileComplete || !avail) ? 0.45 : 1 })}>
              {busy ? "…" : "Submit application →"}</button>
            <p style={{ color: "rgba(200,215,255,0.4)", fontSize: 11.5, margin: "8px 0 0", textAlign: "center" }}>The host reviews every application before you enter the player pool.</p>
          </>}

          {myStatus === "pending" && <p style={{ color: "rgba(200,215,255,0.5)", fontSize: 12.5, margin: "12px 0 0" }}>Your profile and availability were sent to the host. You'll appear in the Scout Hub once approved — check back here.</p>}
          {myStatus === "rejected" && <p style={{ color: "rgba(200,215,255,0.5)", fontSize: 12.5, margin: "12px 0 0" }}>The host didn't approve this application. Reach out to them if you think that's a mistake.</p>}

          {isIn && me?.isCaptain && (
            <div style={{ marginTop: 14, padding: "12px 15px", background: "rgba(245,196,83,0.08)", border: "1px solid rgba(245,196,83,0.55)", clipPath: SHELL_NOTCH(8), boxShadow: "0 0 22px rgba(245,196,83,0.12)" }}>
              <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", color: "#f5c453", textShadow: "0 0 10px rgba(245,196,83,0.5)" }}>★ You're a captain this tournament</span>
              <span style={{ fontSize: 12, color: "rgba(200,215,255,0.6)", marginLeft: 8 }}>$10,000 budget — scout the pool, then run your auction at the draft.</span>
            </div>
          )}
          {isIn && !me?.isCaptain && (regOpen || phase === "registration_closed") && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 14, cursor: "pointer", color: me?.volunteered ? "#7da6ff" : "rgba(200,215,255,0.5)", fontSize: 12.5 }}>
              <input type="checkbox" checked={!!me?.volunteered} disabled={busy} onChange={e => volunteer(e.target.checked)} style={{ accentColor: "#3d7bff" }} />
              I'll captain if picked — the host makes the final call.
            </label>
          )}
          {isIn && HAS_SUPABASE && <ScoutProfileCard userId={window.__VOLT.userId} />}
          {isIn && HAS_SUPABASE && <DiscordLinkCard />}
        </div>


        <div style={{ ...panel, order: 2 }}>
          {corner}
          {secLabel(`Approved roster · ${roster.length}`)}
          {roster.length === 0
            ? <p style={{ color: "rgba(200,215,255,0.45)", fontSize: 13, margin: 0 }}>No approved players yet.</p>
            : <div style={{ display: "grid", gap: 6 }}>
                {roster.map(r => {
                  const openIt = openApp === "roster:" + r.userId;
                  return (
                  <div key={r.userId} style={{ background: "rgba(255,255,255,0.03)", border: `1px solid rgba(120,150,220,${openIt ? "0.3" : "0.14"})`, clipPath: SHELL_NOTCH(7) }}>
                  <div onClick={() => setOpenApp(openIt ? null : "roster:" + r.userId)} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpenApp(openIt ? null : "roster:" + r.userId); } }}
                    className="vg-row-x" title={openIt ? "Hide full stats" : "Show full stats"} aria-expanded={openIt}
                    style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 12px", cursor: "pointer", flexWrap: "wrap" }}>
                    <span aria-hidden="true" className="vg-chev" style={{ display: "grid", placeItems: "center",
                      width: 22, height: 22, flex: "0 0 auto", color: "#7da6ff",
                      border: `1px solid rgba(61,123,255,${openIt ? "0.7" : "0.38"})`,
                      background: `rgba(61,123,255,${openIt ? "0.22" : "0.09"})`,
                      transform: openIt ? "rotate(90deg)" : "none" }}><ChevronIcon /></span>
                    <span style={{ fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", fontSize: 14, flex: 1 }}>{r.name}
                      {r.userId === window.__VOLT.userId && <span style={{ color: "rgba(200,215,255,0.4)", fontWeight: 500, marginLeft: 6, fontSize: 11 }}>(you)</span>}
                    </span>
                    {r.rank && <span style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: (RANKS[r.rank] || {}).c || "#8d97a8", fontWeight: 700 }}>{r.rank}</span>}
                    {isHost && r.noShows > 0 && <span title="Season no-shows" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: r.noShows >= 2 ? "#ff4655" : "#f5c453", fontWeight: 700 }}>⚠ {r.noShows}</span>}
                    {r.isCaptain && <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "#f5c453", border: "1px solid rgba(245,196,83,0.45)", padding: "3px 8px", clipPath: SHELL_NOTCH(5), fontWeight: 700 }}>Captain</span>}
                    {!r.isCaptain && r.volunteered && <span title="Available to captain" style={{ fontSize: 10, letterSpacing: "0.1em", textTransform: "uppercase", color: "rgba(200,215,255,0.4)" }}>available</span>}
                    {isHost && (
                      <button disabled={busy} onClick={e => { e.stopPropagation(); hostSetCaptain(r, !r.isCaptain); }} style={shellBtn(r.isCaptain ? "ghost" : "warn", { padding: "5px 10px", fontSize: 10 })}>
                        {r.isCaptain ? "Unmake captain" : "Make captain"}</button>
                    )}
                    {isHost && r.userId !== window.__VOLT.userId && (
                      <button disabled={busy} title="Remove from this tournament's pool"
                        onClick={async e => {
                          e.stopPropagation();
                          if (!window.confirm(`Remove ${r.name} from this tournament's pool? They'll move to the rejected list (you can re-approve).`)) return;
                          setBusy(true);
                          try { await __sb.from("registrations").update({ status: "rejected", is_captain: false }).eq("id", r.regId); await load(); }
                          catch (err) { console.error(err); }
                          setBusy(false);
                        }}
                        style={shellBtn("danger", { padding: "5px 9px", fontSize: 10 })}>✕</button>
                    )}
                  </div>
                  {openIt && profileDetail(r, "rgba(120,150,220,0.15)")}
                  </div>
                  );
                })}
              </div>}
          {isHost && <p style={{ color: "rgba(200,215,255,0.4)", fontSize: 11.5, margin: "12px 0 0" }}>Captains you assign here become the teams when you open the draft. "Available" marks players who volunteered.</p>}
        </div>

        </div>
      )}
    </div>
  </div>;
}

export default function App() { return <VoltGate />; }
