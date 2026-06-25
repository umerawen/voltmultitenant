// ════════════════════════════════════════════════════════════════════
// supabase.js — auth + tenant-scoped data layer for VOLT // DRAFT
// Replaces the old window.storage get/set shim. Every read/write here is
// authenticated and RLS-scoped to the caller's community automatically,
// so you never pass community_id from the client for reads — the DB
// filters it. You DO stamp community_id on inserts (policies check it).
// ════════════════════════════════════════════════════════════════════
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Auth ────────────────────────────────────────────────────────────
export const auth = {
  // Password sign-in / sign-up
  signUpEmail: (email, password) =>
    supabase.auth.signUp({ email, password }),
  signInEmail: (email, password) =>
    supabase.auth.signInWithPassword({ email, password }),
  // Magic link (passwordless) — supabase emails a login link
  sendMagicLink: (email) =>
    supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } }),
  signOut: () => supabase.auth.signOut(),
  getSession: () => supabase.auth.getSession(),
  onChange: (cb) => supabase.auth.onAuthStateChange((_e, s) => cb(s)),
};

// ── Onboarding (calls the SECURITY DEFINER RPCs) ────────────────────
export const onboarding = {
  // Host self-serve: make a community, become its host. Starts 'pending'.
  createCommunity: (name, slug, displayName) =>
    supabase.rpc("create_community", {
      p_name: name, p_slug: slug, p_display_name: displayName,
    }),
  // Player joins an existing community by its slug/code.
  joinCommunity: (slug, displayName, wantsCaptain) =>
    supabase.rpc("join_community", {
      p_slug: slug, p_display_name: displayName, p_wants_captain: wantsCaptain,
    }),
};

// ── Identity / current user context ─────────────────────────────────
export const me = {
  // The caller's user row (role, community_id, wants_captain). null if not
  // yet onboarded into a community.
  async profile() {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return null;
    const { data } = await supabase
      .from("users").select("*, communities(*)").eq("id", user.id).maybeSingle();
    return data;
  },
  setWantsCaptain: (val) =>
    supabase.from("users").update({ wants_captain: val })
      .eq("id", supabase.auth.getUser().then((u) => u.data.user?.id)),
};

// ── Seasons ─────────────────────────────────────────────────────────
export const seasons = {
  list: () =>
    supabase.from("seasons").select("*").order("starts_at", { ascending: false }),
  active: () =>
    supabase.from("seasons").select("*").eq("status", "active").maybeSingle(),
  create: (communityId, payload) =>
    supabase.from("seasons").insert({ community_id: communityId, ...payload })
      .select().single(),
  update: (id, patch) =>
    supabase.from("seasons").update(patch).eq("id", id).select().single(),
};

// ── Events (the weekend) ────────────────────────────────────────────
export const events = {
  forSeason: (seasonId) =>
    supabase.from("events").select("*").eq("season_id", seasonId)
      .order("reg_opens", { ascending: true }),
  get: (id) => supabase.from("events").select("*").eq("id", id).single(),
  create: (communityId, seasonId, payload) =>
    supabase.from("events")
      .insert({ community_id: communityId, season_id: seasonId, ...payload })
      .select().single(),
  // Host advances/overrides phase. Setting phase manually flags override.
  setPhase: (id, phase, overridden = true) =>
    supabase.from("events").update({ phase, phase_overridden: overridden })
      .eq("id", id).select().single(),
};

// Client-side "auto" phase from the schedule — used when not overridden.
// A real cron does this server-side later; this keeps it live meanwhile.
export function computeAutoPhase(ev, now = new Date()) {
  if (ev.phase_overridden) return ev.phase; // host is in control
  const t = (d) => (d ? new Date(d).getTime() : null);
  const n = now.getTime();
  if (t(ev.matches_end) && n > t(ev.matches_end)) return "settled";
  if (t(ev.matches_start) && n >= t(ev.matches_start)) return "matches_live";
  if (t(ev.draft_at) && n >= t(ev.draft_at)) return "drafting";
  if (t(ev.reg_closes) && n >= t(ev.reg_closes)) return "registration_closed";
  return "registration_open";
}

// ── Registrations (per-weekend opt-in + captain selection) ──────────
export const registrations = {
  forEvent: (eventId) =>
    supabase.from("registrations")
      .select("*, users(display_name, wants_captain)").eq("event_id", eventId),
  // Player self-registers for a weekend (is_captain forced false by RLS).
  register: (communityId, eventId, userId) =>
    supabase.from("registrations")
      .insert({ community_id: communityId, event_id: eventId, user_id: userId })
      .select().single(),
  unregister: (eventId, userId) =>
    supabase.from("registrations").delete()
      .eq("event_id", eventId).eq("user_id", userId),
  // Host picks captains for THIS weekend (per-weekend captaincy).
  setCaptain: (id, isCaptain) =>
    supabase.from("registrations").update({ is_captain: isCaptain })
      .eq("id", id).select().single(),
  // The draft pool = registered, non-captain players for this weekend.
  async draftPool(eventId) {
    const { data } = await supabase.from("registrations")
      .select("*, users(*)").eq("event_id", eventId).eq("is_captain", false);
    return data ?? [];
  },
};

// ── Teams + draft output ────────────────────────────────────────────
export const teams = {
  forEvent: (eventId) =>
    supabase.from("teams").select("*, team_players(*, users(display_name))")
      .eq("event_id", eventId),
  create: (communityId, eventId, captainUserId, name) =>
    supabase.from("teams").insert({
      community_id: communityId, event_id: eventId,
      captain_user_id: captainUserId, name,
    }).select().single(),
  addPlayer: (communityId, teamId, userId, price) =>
    supabase.from("team_players").insert({
      community_id: communityId, team_id: teamId, user_id: userId,
      draft_price: price,
    }).select().single(),
};

// ── Match results + leaderboard ─────────────────────────────────────
// Combined scoring: tune these constants to taste.
export const SCORING = { perKill: 1, perAssist: 0.5, winBonus: 10 };

export function computePoints(stat, teamWon) {
  const k = stat?.kills ?? 0, a = stat?.assists ?? 0;
  return k * SCORING.perKill + a * SCORING.perAssist + (teamWon ? SCORING.winBonus : 0);
}

export const results = {
  // Host enters a player's line for a weekend; points materialized on write.
  record: (communityId, eventId, userId, teamId, stat, teamWon) =>
    supabase.from("match_results").insert({
      community_id: communityId, event_id: eventId, user_id: userId,
      team_id: teamId, stat_payload: stat, team_won: teamWon,
      points_computed: computePoints(stat, teamWon),
    }).select().single(),

  // Season leaderboard: sum points per player across the season's events.
  // (Done client-side here; promote to a SQL view if it gets heavy.)
  async leaderboard(seasonId) {
    const { data: evs } = await supabase.from("events").select("id")
      .eq("season_id", seasonId);
    const ids = (evs ?? []).map((e) => e.id);
    if (!ids.length) return [];
    const { data: rows } = await supabase.from("match_results")
      .select("user_id, points_computed, users(display_name)")
      .in("event_id", ids);
    const tally = new Map();
    for (const r of rows ?? []) {
      const cur = tally.get(r.user_id) ?? {
        user_id: r.user_id, name: r.users?.display_name, points: 0,
      };
      cur.points += Number(r.points_computed);
      tally.set(r.user_id, cur);
    }
    return [...tally.values()].sort((a, b) => b.points - a.points);
  },
};

// ── Tournament (season-end, single-elim, size scales w/ player count) ─
// Largest power of two that fits the active-player count, capped sensibly.
export function tournamentSize(activePlayers) {
  if (activePlayers < 4) return 0;            // not enough for a bracket
  const p = Math.floor(Math.log2(activePlayers));
  return Math.min(2 ** p, 32);                // 4,8,16,32
}

export const tournaments = {
  seedFromLeaderboard: async (communityId, seasonId) => {
    const board = await results.leaderboard(seasonId);
    const size = tournamentSize(board.length);
    const seeds = board.slice(0, size);
    return supabase.from("tournaments").insert({
      community_id: communityId, season_id: seasonId, size,
      bracket: { seeds, rounds: [] },
    }).select().single();
  },
  forSeason: (seasonId) =>
    supabase.from("tournaments").select("*").eq("season_id", seasonId).maybeSingle(),
  saveBracket: (id, bracket) =>
    supabase.from("tournaments").update({ bracket }).eq("id", id).select().single(),
};
