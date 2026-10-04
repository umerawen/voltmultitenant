// The VOLT reels. `node reels.mjs [filter]` writes each one's HyperFrames
// project into videos/<id>/ (index.html, assets/, cues.json).
// Then `bash render.sh [filter]` renders, synthesises the SFX and muxes.
//
// Times are seconds; keep cuts on the 0.5s grid (120 BPM bed).
// Text markup: [red]  {blue}  |green|  ~gold~
import { reel, C } from "./lib/engine.mjs";

const ART = {
  jett: { src: "art-jett.webp", fx: 0.6 },
  reyna: { src: "art-reyna.webp", fx: 0.42, ih: 824 },
  sage: { src: "art-sage-gold.webp", fx: 0.58 },
  omen: { src: "league-hero.webp", fx: 0.6 },
};
const FEAT = "Solo sign-ups · Live auction · Brackets · Stats";
const QF2 = "[aria-label^='QF 2']", SF1 = "[aria-label^='SF 1']", FINAL = "[aria-label^='Final']", DIALOG = "[role=dialog]";

export const REELS = [
  // 01 ── players: you don't need a team
  {
    id: "volt-solo-to-signed", duration: 21,
    scenes: [
      { kind: "hook", t: 0, d: 3, agent: "jett", label: "FOR SOLO PLAYERS", lines: ["NO TEAM?", "[NO PROBLEM.]"], size: 156, sub: "Sign up alone. Get drafted by a captain." },
      { kind: "screen", t: 3, d: 4, shot: "player-pool", url: "PLAYER POOL",
        head: { label: "STEP 1 · SIGN UP", lines: ["JOIN THE POOL", "{SOLO}."] },
        cam: [{ at: 0, w: 1000, center: [860, 600] }, { at: 1.4, focus: "KAIRO", w: 620 }],
        marks: [{ at: 2.2, mark: "KAIRO", pad: 14, tag: "THAT'S YOU" }] },
      { kind: "screen", t: 7, d: 3.5, shot: "scout-modal", url: "PLAYER POOL / KAIRO",
        head: { label: "STEP 2 · GET SCOUTED", lines: ["YOUR STATS", "DO THE [TALKING]."] },
        cam: [{ at: 0, w: 1000, center: [870, 520] }, { at: 1.2, center: [1080, 420], w: 640 }] },
      { kind: "screen", t: 10.5, d: 4, shot: "auction-block", url: "LIVE AUCTION",
        head: { label: "STEP 3 · GET BOUGHT", lines: ["CAPTAINS", "{BID ON YOU}."] },
        cam: [{ at: 0, focus: "ZEPHYR", w: 900 }, { at: 1.3, focus: "CURRENT BID", w: 600 }],
        toasts: [{ at: 1.3, k: "FROSTBYTE", v: "BIDS |$2,700|", color: C.money }, { at: 2.3, k: "NOVA STRIKE", v: "BIDS |$2,900|", color: C.money, side: "left" }] },
      { kind: "screen", t: 14.5, d: 3, shot: "rosters", url: "ROSTERS",
        head: { label: "STEP 4 · PLAY", lines: ["NOW YOU'RE", "ON A [TEAM]."] },
        cam: [{ at: 0, w: 1000, center: [800, 500] }, { at: 1.0, center: [840, 540], w: 560 }],
        marks: [{ at: 1.7, mark: "KAIRO", pad: 10, tag: "SIGNED", color: C.money }] },
      { kind: "cta", t: 17.5, d: 3.5, lines: ["SIGN UP SOLO.", "[GET DRAFTED.]"], feat: FEAT, button: "FIND A LEAGUE" },
    ],
  },

  // 02 ── the auction draft
  {
    id: "volt-bidding-war", duration: 20,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, art: ART.reyna, label: "LIVE AUCTION DRAFT", lines: ["EVERY PLAYER", "HAS A [PRICE]."], size: 140 },
      { kind: "screen", t: 2.5, d: 5, shot: "auction-block", url: "LIVE AUCTION",
        head: { label: "ON THE BLOCK", lines: ["ZEPHYR IS UP.", "{6 CAPTAINS} WANT HIM."], size: 92 },
        cam: [{ at: 0, focus: "ZEPHYR", w: 860 }, { at: 1.8, focus: "CURRENT BID", w: 560 }],
        toasts: [{ at: 1.0, k: "EMBERFALL", v: "BIDS |$2,500|", color: C.money }, { at: 2.0, k: "FROSTBYTE", v: "BIDS |$2,700|", color: C.money, side: "left" }, { at: 3.0, k: "NOVA STRIKE", v: "BIDS |$2,900|", color: C.money }] },
      { kind: "screen", t: 7.5, d: 3.5, shot: "auction-block", url: "LIVE AUCTION",
        head: { label: "HAMMER DOWN", lines: ["GOING… GOING…"] },
        cam: [{ at: 0, focus: "SOLD", w: 760 }],
        cursor: [{ at: 0.2, to: "SOLD", fx: 0.45 }],
        stamp: { at: 1.5, text: "SOLD", sub: "NOVA STRIKE · $2,900", y: 980 } },
      { kind: "screen", t: 11, d: 3.5, shot: "rosters", url: "ROSTERS",
        head: { label: "THE LOCKER ROOM", lines: ["SPEND SMART.", "BUDGETS ARE {REAL}."], size: 96 },
        cam: [{ at: 0, w: 640, center: [600, 560] }, { at: 1.4, w: 640, center: [1300, 560] }] },
      { kind: "stat", t: 14.5, d: 2.5, label: "ONE DRAFT NIGHT",
        items: [{ to: 24, label: "Players" }, { to: 6, label: "Captains", color: C.voltHi }, { to: 60000, prefix: "$", label: "In purses", color: C.money }] },
      { kind: "cta", t: 17, d: 3, lines: ["BUILD YOUR", "[DREAM TEAM.]"], feat: FEAT, button: "JOIN THE DRAFT" },
    ],
  },

  // 03 ── hosts: hand it all to VOLT
  {
    id: "volt-host-autopilot", duration: 24.5,
    scenes: [
      { kind: "hook", t: 0, d: 3, ghost: "?", label: "FOR LEAGUE HOSTS", lines: ["RUNNING A", "[LEAGUE?]"], size: 160, sub: "Here's what that usually looks like." },
      { kind: "list", t: 3, d: 4.5, style: "strike", strikeAt: 2.6, step: 0.3, label: "THE OLD WAY", lines: ["SOUND", "[FAMILIAR?]"],
        items: ["SPREADSHEETS", "SIGN-UPS IN DMS", "BRACKETS BY HAND", "CHASING SCORES", "SORTING ROLES"] },
      { kind: "hook", t: 7.5, d: 2.5, agent: "sage", label: "ENTER VOLT", lines: ["MEET YOUR", "[CO-HOST.]"], size: 156 },
      { kind: "list", t: 10, d: 4.5, step: 0.32, label: "VOLT HANDLES", lines: ["THE BORING", "{STUFF}."],
        items: ["SIGN-UPS & APPROVALS", "AUCTION DRAFT", "BRACKETS & SCHEDULES", "SCORES & STATS", "DISCORD ROLES"] },
      { kind: "screen", t: 14.5, d: 3.5, shot: "fixtures-bracket", url: "FIXTURES",
        head: { label: "AUTO BRACKETS", lines: ["SEEDED. SCHEDULED.", "{DONE.}"], size: 92 },
        cam: [{ at: 0, w: 1000, center: [900, 560] }, { at: 1.2, focus: SF1, w: 720 }],
        marks: [{ at: 1.9, mark: SF1, pad: 8, tag: "AUTO-SCHEDULED" }] },
      { kind: "screen", t: 18, d: 3, shot: "league-page", url: "LEAGUE",
        head: { label: "YOUR LEAGUE HQ", lines: ["ONE LINK.", "[EVERYTHING.]"] },
        cam: [{ at: 0, w: 1000, center: [870, 480] }, { at: 1.0, focus: "ENTER TOURNAMENT →", w: 760 }],
        cursor: [{ at: 1.2, to: "ENTER TOURNAMENT →" }] },
      { kind: "cta", t: 21, d: 3.5, lines: ["YOU HOST.", "[VOLT RUNS IT.]"], feat: "Sign-ups · Draft · Brackets · Stats · Discord", button: "START YOUR LEAGUE" },
    ],
  },

  // 04 ── captains: scout before you spend
  {
    id: "volt-scout-hub", duration: 20.5,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, art: ART.omen, label: "FOR CAPTAINS", lines: ["SCOUT BEFORE", "YOU [SPEND]."], size: 140 },
      { kind: "screen", t: 2.5, d: 4.5, shot: "player-pool", url: "PLAYER POOL",
        head: { label: "THE SCOUT HUB", lines: ["EVERY PLAYER.", "{ONE BOARD.}"] },
        cam: [{ at: 0, w: 1000, center: [1000, 640] }, { at: 1.5, focus: "VANTA", w: 600 }, { at: 2.9, focus: "NYX", w: 600 }],
        marks: [{ at: 2.2, mark: "VANTA", pad: 12, tag: "IMMORTAL 1 · DUELIST", d: 0.9 }, { at: 3.6, mark: "NYX", pad: 12, tag: "ASCENDANT 3 · CONTROLLER" }] },
      { kind: "screen", t: 7, d: 4, shot: "scout-modal", url: "PLAYER POOL / KAIRO",
        head: { label: "THE SCOUT FILE", lines: ["KNOW WHO", "YOU'RE [BUYING]."] },
        cam: [{ at: 0, w: 1000, center: [870, 520] }, { at: 1.3, center: [1180, 330], w: 620 }] },
      { kind: "stat", t: 11, d: 3, label: "KAIRO · IMMORTAL 2 · DUELIST", lines: ["THE NUMBERS", "DON'T [LIE]."], size: 104,
        items: [{ to: 1.42, dec: 2, label: "KDA", color: C.voltHi }, { to: 286, label: "ACS" }, { to: 31, suffix: "%", label: "Headshot", color: C.money }] },
      { kind: "screen", t: 14, d: 3, shot: "auction-block", url: "LIVE AUCTION",
        head: { label: "DRAFT NIGHT", lines: ["THEN BID LIKE", "YOU [MEAN IT]."] },
        cam: [{ at: 0, focus: "CURRENT BID", w: 700 }],
        toasts: [{ at: 1.0, k: "VIPERS", v: "RAISE TO |$3,100|", color: C.money }] },
      { kind: "cta", t: 17, d: 3.5, lines: ["SCOUT. BID.", "[WIN.]"], feat: FEAT, button: "START SCOUTING" },
    ],
  },

  // 05 ── players: your stats, all season
  {
    id: "volt-every-match-counts", duration: 21,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, agent: "reyna", label: "PLAYER STATS", lines: ["EVERY MATCH", "[COUNTS.]"], size: 150 },
      { kind: "screen", t: 2.5, d: 4, shot: "match-modal", url: "FIXTURES / SEMIFINAL",
        head: { label: "AFTER THE GAME", lines: ["DROP THE SCORE.", "{THAT'S IT.}"], size: 96 },
        cam: [{ at: 0, w: 1000, center: [870, 540] }, { at: 1.2, focus: DIALOG, w: 700 }] },
      { kind: "screen", t: 6.5, d: 4, shot: "leaderboard", url: "LEADERBOARD",
        head: { label: "SEASON LEADERBOARD", lines: ["YOUR NAME.", "[UP HERE.]"] },
        cam: [{ at: 0, w: 1000, center: [870, 560] }, { at: 1.3, center: [640, 540], w: 640 }],
        marks: [{ at: 2.0, mark: "KAIRO", pad: 12, tag: "#2 THIS SEASON" }] },
      { kind: "stat", t: 10.5, d: 3, label: "KAIRO · THIS SEASON", lines: ["TRACKED.", "{AUTOMATICALLY.}"], size: 104,
        items: [{ to: 286, label: "Avg ACS" }, { to: 1.42, dec: 2, label: "KDA", color: C.voltHi }, { to: 61, suffix: "%", label: "Win rate", color: C.money }] },
      { kind: "screen", t: 13.5, d: 4, shot: "league-page", url: "LEAGUE",
        head: { label: "THE SEASON RACE", lines: ["EVERY POINT", "{STACKS UP}."] },
        cam: [{ at: 0, w: 1000, center: [870, 480] }, { at: 1.2, center: [1380, 600], w: 620 }],
        marks: [{ at: 1.9, mark: "// SEASON RACE", pad: 10, tag: "LIVE STANDINGS", fill: false }] },
      { kind: "cta", t: 17.5, d: 3.5, lines: ["PLAY. TRACK.", "[CLIMB.]"], feat: FEAT, button: "JOIN A LEAGUE" },
    ],
  },

  // 06 ── formats: league or knockout
  {
    id: "volt-any-format", duration: 19,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, ghost: "VS", label: "TOURNAMENT FORMATS", lines: ["LEAGUE OR", "[KNOCKOUT?]"], size: 160, sub: "Pick one. VOLT runs either." },
      { kind: "screen", t: 2.5, d: 4.5, shot: "fixtures-league", url: "FIXTURES",
        head: { label: "LEAGUE PLAY", lines: ["EVERYONE PLAYS", "{EVERYONE}."], size: 96 },
        cam: [{ at: 0, w: 1000, center: [870, 450] }, { at: 1.4, w: 820, center: [800, 560] }] },
      { kind: "screen", t: 7, d: 4, shot: "fixtures-league-rounds", url: "FIXTURES",
        head: { label: "AUTO FIXTURES", lines: ["EVERY ROUND", "[SCHEDULED.]"] },
        cam: [{ at: 0, w: 1000, center: [870, 420] }, { at: 1.3, center: [700, 420], w: 700 }] },
      { kind: "screen", t: 11, d: 4, shot: "fixtures-bracket", url: "FIXTURES",
        head: { label: "OR GO KNOCKOUT", lines: ["SINGLE", "{ELIMINATION}."] },
        cam: [{ at: 0, w: 1000, center: [900, 560] }, { at: 1.2, focus: QF2, w: 640 }, { at: 2.5, focus: SF1, w: 640 }] },
      { kind: "cta", t: 15, d: 4, lines: ["ANY FORMAT.", "[ZERO ADMIN.]"], feat: "League · Single elimination · Best-of", button: "START YOUR LEAGUE" },
    ],
  },

  // 07 ── the bracket, all the way to the trophy
  {
    id: "volt-road-to-the-final", duration: 19.5,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, art: ART.sage, label: "THE BRACKET", lines: ["EIGHT TEAMS.", "~ONE CHAMPION.~"], size: 140, stripeColor: C.gold },
      { kind: "screen", t: 2.5, d: 3, shot: "fixtures-bracket", frame: false, head: { label: "QUARTERFINALS", lines: ["WIN OR", "[GO HOME.]"], size: 130 },
        cam: [{ at: 0, focus: QF2, w: 480 }] },
      { kind: "screen", t: 5.5, d: 3, shot: "fixtures-bracket", frame: false, head: { label: "SEMIFINALS", lines: ["TWO STEPS", "{AWAY.}"], size: 130 },
        cam: [{ at: 0, focus: SF1, w: 480 }] },
      { kind: "screen", t: 8.5, d: 3, shot: "fixtures-champion", frame: false, head: { label: "THE FINAL", lines: ["ONE MATCH.", "[EVERYTHING.]"], size: 130 },
        cam: [{ at: 0, focus: FINAL, w: 480 }] },
      { kind: "screen", t: 11.5, d: 4.5, shot: "fixtures-champion", url: "FIXTURES",
        head: { label: "CHAMPIONS", lines: ["VIPERS", "~TAKE IT ALL.~"] },
        cam: [{ at: 0, w: 1000, center: [1080, 480] }, { at: 1.0, focus: "★ CHAMPION ★", w: 760 }],
        stamp: { at: 2.0, text: "CHAMPIONS", size: 140, sub: "VIPERS · APEX LEAGUE", color: C.gold, y: 1000 },
        cues: [] },
      { kind: "cta", t: 16, d: 3.5, lines: ["WHO TAKES", "[YOURS?]"], feat: FEAT, button: "HOST A TOURNAMENT" },
    ],
    cues: [{ t: 13.6, k: "shimmer", g: 0.5 }],
  },

  // 08 ── predictions
  {
    id: "volt-call-it", duration: 20.5,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, agent: "raze", label: "MATCH NIGHT", lines: ["CALL IT", "[BEFORE] IT", "HAPPENS."], size: 140 },
      { kind: "screen", t: 2.5, d: 4.5, shot: "fixtures-league-rounds", url: "FIXTURES",
        head: { label: "PREDICTIONS", lines: ["PICK YOUR", "{WINNER.}"] },
        cam: [{ at: 0, w: 1000, center: [870, 420] }, { at: 1.3, center: [560, 440], w: 600 }] },
      { kind: "screen", t: 7, d: 4, shot: "match-modal", url: "FIXTURES / SEMIFINAL",
        head: { label: "THE CROWD", lines: ["SEE WHO", "BACKS [WHO.]"] },
        cam: [{ at: 0, focus: DIALOG, w: 760 }, { at: 1.3, center: [960, 600], w: 560 }] },
      { kind: "stat", t: 11, d: 3, label: "SEMIFINAL 1 · CROWD PICKS", lines: ["VIPERS", "VS {EMBERFALL}"], size: 110,
        items: [{ to: 64, suffix: "%", label: "Back Vipers", color: C.hot }, { to: 36, suffix: "%", label: "Back Emberfall", color: C.voltHi }] },
      { kind: "screen", t: 14, d: 3, shot: "fixtures-bracket", url: "FIXTURES",
        head: { label: "THEN WATCH", lines: ["PROVE YOU", "[CALLED IT.]"] },
        cam: [{ at: 0, focus: SF1, w: 720 }],
        marks: [{ at: 1.0, mark: SF1, pad: 8, tag: "UP NEXT", color: C.hot }] },
      { kind: "cta", t: 17, d: 3.5, lines: ["PICK. WATCH.", "[GLOAT.]"], feat: FEAT, button: "JOIN A LEAGUE" },
    ],
  },

  // 09 ── captains: run the team
  {
    id: "volt-captain-mode", duration: 21,
    scenes: [
      { kind: "hook", t: 0, d: 2.5, agent: "phoenix", agentSide: "right", label: "CAPTAIN MODE", lines: ["YOU'RE THE", "[CAPTAIN.]"], size: 156 },
      { kind: "screen", t: 2.5, d: 4, shot: "dashboard", url: "DASHBOARD",
        head: { label: "DRAFT DASHBOARD", lines: ["EVERYTHING", "AT A {GLANCE.}"] },
        cam: [{ at: 0, w: 1000, center: [870, 540] }, { at: 1.3, focus: "$2,900", w: 620, center: [1560, 480] }],
        marks: [{ at: 2.0, mark: "$2,900", pad: 10, tag: "ON THE BLOCK", color: C.money }] },
      { kind: "screen", t: 6.5, d: 4, shot: "rosters", url: "ROSTERS",
        head: { label: "YOUR SQUAD", lines: ["FOUR PICKS.", "{ONE BUDGET.}"] },
        cam: [{ at: 0, w: 1000, center: [800, 520] }, { at: 1.3, w: 560, center: [520, 560] }] },
      { kind: "stat", t: 10.5, d: 3, label: "STARTING PURSE", value: { from: 0, to: 10000, prefix: "$", color: C.money }, valueLabel: "Per captain", sub: "Blow it on a star, or build deep." },
      { kind: "screen", t: 13.5, d: 4, shot: "auction-block", url: "LIVE AUCTION",
        head: { label: "DRAFT NIGHT", lines: ["OUTBID YOUR", "[RIVALS.]"] },
        cam: [{ at: 0, focus: "CURRENT BID", w: 640 }],
        toasts: [{ at: 0.9, k: "EMBERFALL", v: "BIDS |$3,000|", color: C.money }, { at: 1.9, k: "YOU", v: "RAISE TO |$3,200|", color: C.volt, side: "left" }] },
      { kind: "cta", t: 17.5, d: 3.5, lines: ["LEAD YOUR", "[SQUAD.]"], feat: FEAT, button: "CLAIM YOUR TEAM" },
    ],
  },

  // 10 ── the whole thing in 14 seconds
  {
    id: "volt-this-is-volt", duration: 14.5,
    scenes: [
      { kind: "hook", t: 0, d: 2, ghost: "V", lines: ["THIS IS", "[VOLT.]"], size: 190, delay: 0.05 },
      { kind: "montage", t: 2, beat: 1, items: [
        { shot: "player-pool", center: [1171, 760], word: "SIGN UP", small: "SOLO OR SQUAD" },
        { shot: "scout-modal", center: [760, 440], word: "GET SCOUTED" },
        { shot: "auction-block", center: [1027, 700], word: "GET DRAFTED", small: "LIVE AUCTION" },
        { shot: "rosters", center: [840, 560], word: "BUILD TEAMS" },
        { shot: "fixtures-league-rounds", center: [560, 440], word: "PREDICT" },
        { shot: "fixtures-bracket", center: [1083, 575], word: "COMPETE" },
        { shot: "leaderboard", center: [1080, 560], word: "CLIMB" },
        { shot: "fixtures-champion", center: [1080, 440], word: "~WIN.~" },
      ] },
      { kind: "cta", t: 10, d: 4.5, lines: ["RUN YOUR LEAGUE", "ON [VOLT.]"], size: 104, feat: FEAT, button: "START YOUR LEAGUE" },
    ],
  },
];

const only = process.argv[2];
if (only === "--list") { REELS.forEach((r, i) => console.log(String(i + 1).padStart(2, "0") + " " + r.id)); process.exit(0); }
for (const spec of REELS) {
  if (only && !spec.id.includes(only)) continue;
  const r = reel(spec);
  console.log("✓", spec.id, r.cues, "cues");
}
