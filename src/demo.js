// Demo data for marketing captures. Loaded only in the offline preview (no
// Supabase keys) with ?demo=<scene>, so it never ships into a live session.
// Every name here is invented — no real players appear in marketing footage.
//
// Scenes: pool · auction · drafted · bracket · league

const PLAYERS = [
  // name, rank, div, role, agent, kda, acs, hs, win
  ["Kairo", "Immortal", 2, "Duelist", "Jett", 1.42, 286, 31, 61],
  ["Nyx", "Ascendant", 3, "Controller", "Omen", 1.18, 231, 24, 57],
  ["Sable", "Diamond", 2, "Initiator", "Sova", 1.21, 224, 26, 54],
  ["Rook", "Ascendant", 1, "Sentinel", "Killjoy", 1.09, 212, 22, 58],
  ["Vanta", "Immortal", 1, "Duelist", "Reyna", 1.51, 298, 33, 63],
  ["Zephyr", "Diamond", 3, "Duelist", "Raze", 1.27, 251, 27, 52],
  ["Juno", "Platinum", 3, "Controller", "Viper", 1.04, 198, 21, 55],
  ["Talon", "Diamond", 1, "Initiator", "Fade", 1.13, 216, 23, 51],
  ["Mira", "Ascendant", 2, "Sentinel", "Cypher", 1.11, 207, 25, 56],
  ["Onyx", "Gold", 3, "Flex", "Gekko", 0.98, 181, 19, 49],
  ["Haze", "Platinum", 2, "Duelist", "Neon", 1.16, 232, 24, 50],
  ["Lumen", "Diamond", 2, "Controller", "Astra", 1.07, 203, 22, 53],
  ["Kite", "Platinum", 1, "Initiator", "Skye", 1.02, 194, 20, 48],
  ["Rift", "Ascendant", 3, "Duelist", "Yoru", 1.34, 266, 29, 55],
  ["Saber", "Gold", 2, "Sentinel", "Sage", 0.95, 172, 18, 52],
  ["Quill", "Diamond", 3, "Flex", "Harbor", 1.05, 205, 21, 50],
  ["Ember", "Platinum", 3, "Duelist", "Phoenix", 1.12, 221, 23, 47],
  ["Vex", "Immortal", 3, "Initiator", "Breach", 1.24, 238, 26, 60],
  ["Drift", "Gold", 1, "Controller", "Brimstone", 0.93, 169, 17, 46],
  ["Halo", "Diamond", 1, "Sentinel", "Deadlock", 1.06, 199, 22, 54],
  ["Pixel", "Platinum", 2, "Flex", "KAY/O", 1.0, 188, 20, 51],
  ["Nova", "Ascendant", 1, "Controller", "Clove", 1.15, 218, 24, 57],
  ["Grit", "Silver", 3, "Sentinel", "Chamber", 0.9, 160, 18, 45],
  ["Wisp", "Gold", 3, "Initiator", "Tejo", 0.97, 176, 19, 49],
];
// Captains: name, team, rank, div, role, agent, kda, acs, hs, win
const CAPTAINS = [
  ["Ace", "VIPERS", "Immortal", 3, "Duelist", "Phoenix", 1.38, 274, 30, 62],
  ["Bolt", "PHANTOMS", "Ascendant", 3, "Initiator", "Sova", 1.22, 236, 25, 59],
  ["Cipher", "NOVA STRIKE", "Immortal", 1, "Controller", "Omen", 1.19, 228, 24, 60],
  ["Dusk", "EMBERFALL", "Ascendant", 2, "Sentinel", "Killjoy", 1.14, 219, 23, 57],
  ["Echo", "FROSTBYTE", "Diamond", 3, "Initiator", "Fade", 1.12, 214, 24, 55],
  ["Fury", "TITANS", "Ascendant", 1, "Duelist", "Neon", 1.29, 249, 28, 56],
];
// A real league can be handed in for marketing captures (reels/capture-screens.mjs
// injects window.__demoReal from a git-ignored file), with the same tuple shapes
// plus optional peak rank, a sale order and the player on the block.
const REAL = typeof window !== "undefined" ? window.__demoReal : null;
export const DEMO_LEAGUE_NAME = REAL?.league || "APEX LEAGUE";

export function demoBoard(scene, h) {
  const CAPS = REAL?.captains || CAPTAINS, POOL = REAL?.players || PLAYERS;
  const captains = CAPS.map(([name, team, rank, rankDiv, role, agent, kda, acs, hs, win, peak, peakDiv], i) => ({
    userId: "demo-cap-" + i + "-0000-0000-0000-000000000000", name, teamName: team, rank, rankDiv, peakRank: peak || rank, peakRankDiv: peakDiv ?? rankDiv,
    role, agent, kda, acs, hs, win, discord: REAL ? "" : name.toLowerCase(), trophies: !REAL && i === 1 ? 2 : 0 }));
  const pool = POOL.map(([name, rank, rankDiv, role, agent, kda, acs, hs, win, peak, peakDiv], i) => ({
    userId: "demo-p-" + String(i).padStart(2, "0") + "-0000-0000-0000-000000000000",
    name, ign: REAL ? name : name + "#" + (1000 + i * 37), rank, rankDiv, peakRank: peak || rank, peakRankDiv: peakDiv ?? Math.min(3, rankDiv + 1),
    role, agent, kda, acs, hs, win, discord: REAL ? "" : name.toLowerCase(), trophies: !REAL && i % 7 === 0 ? 1 : 0,
  }));
  const s = h.freshState(captains, pool);
  const players = s.players.filter((p) => !p.isCaptain);
  // Captains show their real names on teams
  s.teams.forEach((t, i) => { t.captain = CAPS[i][0]; if (REAL?.hues?.[i]) t.hue = REAL.hues[i]; });

  const sell = (pi, ti, price) => {
    const p = players[pi], t = s.teams[ti];
    p.status = "sold"; p.soldTo = t.id; p.soldPrice = price;
    t.roster.push(p.id); t.budget -= price;
    s.recentSales.unshift({ playerId: p.id, name: p.name, teamId: t.id, price, bidCount: 3 + (price % 7), ts: Date.now() - (pi + 1) * 60000 });
  };

  if (scene === "pool") return s;

  if (REAL) {
    // Replay the real draft in order, up to the player on the block (auction)
    // or to the end (drafted).
    const byName = (n) => players.find((p) => p.name === n);
    for (const [name, ti, price] of REAL.sales) {
      if ((scene === "auction" || scene === "spin") && name === REAL.block?.name) break;
      const p = byName(name), t = s.teams[ti];
      if (!p || !t) continue;
      p.status = "sold"; p.soldTo = t.id; p.soldPrice = price;
      t.roster.push(p.id); t.budget -= price;
      s.recentSales.unshift({ playerId: p.id, name: p.name, teamId: t.id, price, bidCount: 3 + (price % 7), ts: Date.now() - 60000 });
    }
    if (scene === "auction" && REAL.block) {
      const p = byName(REAL.block.name), now = Date.now();
      const bids = REAL.block.bids;
      p.status = "block";
      s.block = { playerId: p.id, startingBid: REAL.block.start, currentBid: bids[bids.length - 1][1], leaderId: s.teams[bids[bids.length - 1][0]].id, ts: now };
      s.bidHistory = bids.map(([ti, amount], i) => ({ teamId: s.teams[ti].id, amount, ts: now - (bids.length - i) * 1500 }));
      s.recentSales = s.recentSales.slice(0, 6);
    }
    if (scene === "spin" && REAL.block) {
      // The draw that picks who goes on the block. It starts a moment after
      // load (the capture script freezes the clock and steps through it).
      const p = byName(REAL.block.name);
      const pool = players.filter((x) => x.status === "pool").map((x) => x.id);
      // a fixed shuffle so every capture spins through the same order
      const order = pool.map((id, i) => [id, ((i + 5) * 7919) % 31]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
      p.status = "block";
      s.block = { playerId: p.id, startingBid: REAL.block.start, currentBid: REAL.block.start, leaderId: null, ts: Date.now() };
      s.spin = { playerId: p.id, pool: order, startTs: Date.now() + 4000, duration: 7200 };
      s.bidHistory = [];
    }
    return s;
  }

  if (scene === "auction") {
    // A third of the way through: some rosters filling, one bidding war live.
    [[4, 0, 4100], [0, 1, 3900], [17, 2, 3600], [1, 3, 2700], [3, 4, 2600], [13, 5, 3100], [8, 0, 2400], [21, 1, 2500]]
      .forEach(([pi, ti, price]) => sell(pi, ti, price));
    const onBlock = players[5]; // Zephyr, Diamond duelist
    onBlock.status = "block";
    const now = Date.now();
    s.block = { playerId: onBlock.id, startingBid: 2000, currentBid: 2900, leaderId: s.teams[2].id, ts: now };
    s.bidHistory = [
      { teamId: s.teams[4].id, amount: 2100, ts: now - 9000 },
      { teamId: s.teams[2].id, amount: 2300, ts: now - 7500 },
      { teamId: s.teams[0].id, amount: 2500, ts: now - 6000 },
      { teamId: s.teams[4].id, amount: 2700, ts: now - 3500 },
      { teamId: s.teams[2].id, amount: 2900, ts: now - 1200 },
    ];
    s.recentSales = s.recentSales.slice(0, 6);
    return s;
  }

  // Everything sold: four players a team.
  const order = [4, 0, 17, 1, 3, 13, 8, 21, 5, 2, 9, 10, 11, 12, 6, 7, 14, 15, 16, 18, 19, 20, 22, 23];
  order.forEach((pi, k) => sell(pi, k % 6, Math.max(500, 3400 - k * 110)));
  if (scene === "drafted") return s;

  const ids = s.teams.map((t) => t.id);
  const play = (m, a, b) => { m.maps = [{ a, b }]; h.resolveMatch(m); return m; };
  // Match nights start at 7pm local; each slot an hour apart.
  const at = (hrs) => { const d = new Date(); d.setHours(19 + Math.floor(hrs / 2), (hrs % 2) * 30, 0, 0); return d.toISOString(); };
  const votes = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => ["v" + i, { name: PLAYERS[i][0], side: i % 3 ? "a" : "b" }]));

  if (scene === "bracket" || scene === "final") {
    const eight = [...ids, null, null];
    const t = { format: "single", bo: 1, overrides: {}, locked: true, createdAt: Date.now(), slots: eight, rounds: h.buildSingleElim(eight, 1) };
    const real = t.rounds[0].filter((m) => !m.bye);
    if (real[0]) play(real[0], 13, 9);
    if (real[1]) { real[1].scheduledAt = at(2); real[1].votes = votes(14); }
    h.propagateElim(t);
    (t.rounds[1] || []).forEach((m, i) => { if (!m.done) { m.scheduledAt = at(4 + i); m.votes = votes(9 + i * 4); } });
    if (scene === "final") {
      // Play everything out: the rest of round one, the semis, then the final.
      const finish = () => t.rounds.forEach((r) => r.forEach((m) => { if (!m.done && m.teamA && m.teamB) { play(m, 13, 6 + ((m.id.length * 3) % 6)); h.propagateElim(t); } }));
      finish(); finish(); finish();
    }
    s.tournament = t;
    return s;
  }

  // league
  const t = { format: "league", bo: 1, overrides: {}, locked: true, createdAt: Date.now(), teamIds: ids, matches: h.leagueMatches(ids, 1) };
  t.matches.slice(0, 3).forEach((m, i) => play(m, 13, [7, 11, 9][i]));
  t.matches.slice(3, 6).forEach((m, i) => { m.scheduledAt = at(1 + i); m.votes = votes(6 + i * 3); });
  s.tournament = t;
  return s;
}

// The viewer's own card on the tournament dashboard.
export const demoProfile = {
  user_id: "demo-me", display_name: "Kairo", ign: "Kairo#1000", rank: "Immortal", rank_div: 2, peak_rank: "Immortal", peak_rank_div: 3,
  role: "Duelist", agent: "Jett", kda: 1.42, acs: 286, hs: 31, win: 61, linked: true, discord: "kairo", whatsapp: "x",
};

// Season leaderboard rows (the view sorts them).
export const demoLeaderboard = PLAYERS.slice(0, 16).map(([name, rank, rankDiv, role, , , acs], i) => {
  const m = 4 + (i % 3), w = Math.max(0, 3 - (i % 4));
  return { id: "demo-l-" + i, name, rank, rankDiv, role, m, w, k: 40 + ((i * 13) % 45), as: 10 + ((i * 7) % 18), pts: Math.round(acs / 4 * m + w * 50), avgAcs: acs };
});

// The league page.
export const demoLeague = {
  name: "APEX LEAGUE",
  events: [
    { id: "demo-ev-2", phase: "registration_open", weekend_label: null, starts_on: "2026-10-10", ends_on: "2026-10-11", created_at: "2026-10-01", draft_at: "2026-10-10T19:00:00" },
    { id: "demo-ev-1", phase: "settled", weekend_label: "Apex Invitational", starts_on: "2026-09-19", ends_on: "2026-09-20", created_at: "2026-09-10",
      recap: { team: "PHANTOMS", mvp: "Vanta", mvpPts: 312, decidedBy: "final" } },
  ],
  live: { count: 24, pending: 3, mineStatus: "approved" },
  board: PLAYERS.slice(0, 30).map(([name, , , , , , acs], i) => ({ name, pts: Math.round(acs * 2.1 - i * 9) })).sort((a, b) => b.pts - a.pts),
};
