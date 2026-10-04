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
  killjoy: { src: "art-killjoy.webp", fx: 0.47, ih: 1013 },
  archer: { src: "art-archer.webp", fx: 0.4, ih: 1013 },
  omenVoid: { src: "art-omen-void.webp", fx: 0.47, ih: 1012 },
};
const FEAT = "Solo sign-ups · Live auction · Brackets · Stats";
const QF2 = "[aria-label^='QF 2']", SF1 = "[aria-label^='SF 1']", FINAL = "[aria-label^='Final']", DIALOG = "[role=dialog]";



export const REELS = [
  // 01 ── players: you don't need a team (Kami Labs: Kamijeee signed solo, drafted by MISFITS)
  {
    id: "volt-solo-to-signed", duration: 20.5, fps: 60,
    vo: { file: "vo/solo.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "No team? No problem."
      { kind: "hook", t: 0, d: 2.25, agent: "jett", label: "FOR SOLO PLAYERS", lines: ["NO TEAM?", "[NO PROBLEM.]"], size: 156 },
      // "Sign up solo, and you land in the player pool."
      { kind: "stage", t: 2.25, d: 2.6, shot: "kami-pool-scrolled", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "SIGN UP SOLO", lines: ["YOU LAND IN", "THE {PLAYER POOL}."], size: 96 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [{ at: 0.45, rect: [1462, 578, 360, 180], w: 820, y: 1080,
          focus: [{ at: 1.0, rect: [1482, 594, 138, 22], tag: "THAT'S YOU", color: C.volt }] }] },
      // "Captains scout your stats…"
      { kind: "stage", t: 4.85, d: 2.05, shot: "kami-scout-modal", plateW: 1040, plateY: 1060, sweep: false,
        heads: [{ at: 0, label: "GET SCOUTED", lines: ["CAPTAINS SCOUT", "YOUR [STATS]."], size: 96 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 0.2, rect: [510, 117, 435, 603], w: 420, x: 290, y: 1080, shape: "notch", cut: 24 },
          { at: 0.35, rect: [1035, 195, 315, 270], w: 430, x: 790, y: 930 },
          { at: 0.5, rect: [995, 522, 398, 146], w: 430, x: 790, y: 1230 },
        ] },
      // "then the draw spins — and lands on YOU."
      { kind: "draw", t: 6.9, d: 3.4, draw: "kami-draw", spin: 2.75, delay: 0.1, y: 1010, cardW: 400,
        reveal: { name: "KAMIJEEE", sub: "Silver · heads to the block at $800" },
        head: { label: "DRAFT NIGHT", lines: ["THE DRAW SPINS…", "AND LANDS ON [YOU]."], size: 100 } },
      // "Kamijee went for sixteen hundred, straight onto Yona's squad."
      { kind: "stage", t: 10.3, d: 5.13, shot: "kami-rosters", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "SIGNED", lines: ["SOLD FOR |$1,600|.", "ONTO {MISFITS}."], size: 96 }],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.3, rect: [343, 233, 357, 535], w: 580, y: 1110, shape: "notch", cut: 24,
          focus: [{ at: 1.0, rect: [361, 516, 285, 50], tag: "KAMIJEEE · $1,600", color: C.money }] }] },
      // "Sign up solo. Get drafted… on VOLT."
      { kind: "cta", t: 15.43, d: 5.07, lines: ["SIGN UP SOLO.", "[GET DRAFTED.]"], feat: FEAT, button: "FIND A LEAGUE" },
    ],
  },

  // 02 ── the auction draft, Kami Labs' real draft night. Opens on the app's
  //       draw, rebuilt from its card stills (capture-cards.mjs, screens/kami-draw), voiceover
  //       vo/bidding-war-kami.flac at t=1.0 so "Kamijee" lands with the card.
  {
    id: "volt-bidding-war", duration: 27.3, fps: 60,
    vo: { file: "vo/bidding-war-kami.flac", t: 1.0, gain: 0.85 },
    scenes: [
      // the draw: 119 cards fly past, it lands on Kamijeee at 3.3s
      { kind: "draw", t: 0, d: 4.1, draw: "kami-draw", spin: 3.2, delay: 0.1, y: 1010, cardW: 400,
        reveal: { name: "KAMIJEEE", sub: "Silver · heads to the block at $800" },
        head: { label: "LIVE AUCTION DRAFT", lines: ["EVERY PLAYER", "HAS A [PRICE]."], size: 118 } },
      // "Kamijee's on the block — and six captains want him. 1200… 1400… 1600!  Going… going… SOLD!"
      { kind: "stage", t: 4.1, d: 11.4, shot: "kami-auction-block", plateW: 1040, plateY: 1040, sweep: false,
        heads: [
          { at: 0, label: "ON THE BLOCK", lines: ["KAMIJEEE IS UP.", "{6 CAPTAINS} WANT HIM."], size: 92 },
          { at: 6.75, label: "HAMMER DOWN", lines: ["GOING… GOING…"] },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }, { at: 6.55, rx: 12, ry: 15, dur: 1.1 }],
        pieces: [
          { at: 0.0, d: 0.55, rect: [852, 90, 462, 602], w: 560, y: 1080, shape: "notch", cut: 24 },     // Kamijeee's card
          // the six captains and their purses, one card each
          { at: 0.6, d: 1.8, rect: [268, 88, 254, 206], w: 380, x: 290, y: 742 },
          { at: 0.67, d: 1.73, rect: [268, 303, 254, 206], w: 380, x: 290, y: 1070 },
          { at: 0.74, d: 1.66, rect: [268, 517, 254, 206], w: 380, x: 290, y: 1398 },
          { at: 0.7, d: 1.7, rect: [1645, 88, 254, 206], w: 380, x: 790, y: 742 },
          { at: 0.77, d: 1.63, rect: [1645, 303, 254, 206], w: 380, x: 790, y: 1070 },
          { at: 0.84, d: 1.56, rect: [1645, 517, 254, 206], w: 380, x: 790, y: 1398 },
          { at: 2.45, d: 4.15, rect: [916, 714, 334, 87], w: 900, y: 1010, shape: "slant", cut: 22,       // the bid, ticking up
            live: [
              { rect: [945, 742, 160, 50], size: 36, color: "#5b8dff", steps: [{ at: 0, text: "$800" }, { at: 2.71, text: "$1,200" }, { at: 3.98, text: "$1,400" }, { at: 5.19, text: "$1,600" }] },
              { rect: [1128, 750, 108, 30], size: 20, font: "raj", steps: [{ at: 0, text: "—", color: "rgba(200,215,255,0.4)" }, { at: 2.71, text: "PATIENCE", color: "#9d6bff" }, { at: 3.98, text: "DOOM", color: "#ff8a3d" }, { at: 5.19, text: "MISFITS", color: "#ff4655" }] },
            ] },
          { at: 6.8, d: 4.6, rect: [836, 822, 494, 72], w: 970, y: 1080, shape: "slant", cut: 22 },     // SOLD / PASS
        ],
        toasts: [{ at: 2.71, k: "PATIENCE", v: "BIDS |$1,200|", color: "#9d6bff", y: 1230 }, { at: 3.98, k: "DOOM", v: "BIDS |$1,400|", color: "#ff8a3d", side: "left", y: 1230 }, { at: 5.19, k: "MISFITS", v: "BIDS |$1,600|", color: "#ff4655", y: 1230, d: 1.0 }],
        cursor: [{ at: 8.1, x: 426, y: 1082, d: 2.2 }],
        stamp: { at: 9.09, text: "SOLD", sub: "MISFITS · $1,600", y: 840 } },
      // "Every captain gets a budget — spend it smart."
      { kind: "stage", t: 15.5, d: 3.16, shot: "kami-rosters", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE LOCKER ROOM", lines: ["SPEND SMART.", "BUDGETS ARE {REAL}."], size: 96 }],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.35, rect: [343, 233, 357, 535], w: 580, y: 1110, shape: "notch", cut: 24,
          focus: [{ at: 1.1, rect: [361, 313, 155, 68], tag: "BUDGET LEFT", color: C.money, tagBelow: true }, { at: 2.0, rect: [361, 515, 285, 52], tag: "KAMIJEEE · $1,600", color: C.volt }] }] },
      // "Twenty-four players. Six captains. One draft night."
      { kind: "stat", t: 18.66, d: 4.42, label: "ONE DRAFT NIGHT",
        items: [{ to: 24, label: "Players", at: 0.3, dur: 0.9 }, { to: 6, label: "Captains", color: C.voltHi, at: 1.77, dur: 0.8 }, { to: 1, label: "Draft night", color: C.money, at: 3.19, dur: 0.5 }] },
      // "Build your dream team… on VOLT."
      { kind: "cta", t: 23.08, d: 4.22, lines: ["BUILD YOUR", "[DREAM TEAM.]"], feat: FEAT, button: "JOIN THE DRAFT" },
    ],
  },

  // 03 ── hosts: hand it all to VOLT (Kami Labs ran a whole tournament on it)
  {
    id: "volt-host-autopilot", duration: 26.5, fps: 60,
    vo: { file: "vo/host.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Running a league?"
      { kind: "hook", t: 0, d: 2.0, ghost: "?", label: "FOR LEAGUE HOSTS", lines: ["RUNNING A", "[LEAGUE?]"], size: 160 },
      // "Spreadsheets. Sign-ups in DMs. Brackets by hand. Chasing scores. Stop."
      { kind: "list", t: 2.0, d: 6.3, style: "strike", strikeAt: 5.76, label: "THE OLD WAY", lines: ["SOUND", "[FAMILIAR?]"],
        items: [{ t: "SPREADSHEETS", at: 0.4 }, { t: "SIGN-UPS IN DMS", at: 1.4 }, { t: "BRACKETS BY HAND", at: 2.73 }, { t: "CHASING SCORES", at: 4.11 }] },
      // "VOLT runs it for you."
      { kind: "hook", t: 8.3, d: 1.7, art: ART.killjoy, label: "ENTER VOLT", lines: ["VOLT RUNS IT", "[FOR YOU.]"], size: 140 },
      // "Sign-ups and approvals. The auction draft. Groups and brackets. Scores, stats, and Discord roles."
      { kind: "list", t: 10.0, d: 6.3, label: "VOLT HANDLES", lines: ["THE BORING", "{STUFF}."],
        items: [{ t: "SIGN-UPS & APPROVALS", at: 0.18 }, { t: "AUCTION DRAFT", at: 1.3 }, { t: "GROUPS & BRACKETS", at: 2.84 }, { t: "SCORES & STATS", at: 4.12 }, { t: "DISCORD ROLES", at: 5.2 }] },
      // "Kami Labs ran a full tournament on it: six teams, twenty-four players, one champion."
      { kind: "stage", t: 16.3, d: 6.1, shot: "kami-fixtures-champion", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "KAMI LABS", lines: ["A FULL TOURNAMENT", "ON {VOLT}."], size: 92 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.4, d: 3.8, rect: [345, 513, 723, 282], w: 860, y: 860 },
          { at: 0.55, d: 3.65, rect: [1100, 513, 723, 282], w: 860, y: 1230 },
          { at: 4.6, rect: [775, 350, 617, 135], w: 900, y: 1040 },
        ],
        toasts: [{ at: 2.75, k: "KAMI LABS", v: "6 TEAMS", color: C.volt, y: 1420, d: 0.9 }, { at: 3.7, k: "KAMI LABS", v: "24 PLAYERS", color: C.volt, side: "left", y: 1420, d: 0.9 }] },
      // "You host… VOLT runs it."
      { kind: "cta", t: 22.4, d: 4.1, lines: ["YOU HOST.", "[VOLT RUNS IT.]"], feat: "Sign-ups · Draft · Brackets · Stats · Discord", button: "START YOUR LEAGUE" },
    ],
  },

  // 04 ── captains: scout before you spend
  {
    id: "volt-scout-hub", duration: 14.8, fps: 60,
    vo: { file: "vo/scout.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Scout before you spend."
      { kind: "hook", t: 0, d: 2.1, art: ART.omen, label: "FOR CAPTAINS", lines: ["SCOUT BEFORE", "YOU [SPEND]."], size: 140 },
      // "Every player on one board: rank, role, and stats."
      { kind: "stage", t: 2.1, d: 4.2, shot: "kami-pool-scrolled", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE SCOUT HUB", lines: ["EVERY PLAYER.", "{ONE BOARD.}"], size: 96 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.35, rect: [345, 378, 360, 184], w: 440, x: 295, y: 830 },
          { at: 0.45, rect: [1462, 378, 360, 184], w: 440, x: 785, y: 830,
            focus: [{ at: 2.07, rect: [1480, 421, 110, 18], tag: "RANK" }, { at: 2.73, rect: [1480, 443, 170, 18], tag: "ROLE", tagBelow: true }, { at: 3.4, rect: [1480, 478, 250, 22], tag: "STATS", color: C.money, tagBelow: true }] },
          { at: 0.55, rect: [1090, 578, 360, 180], w: 440, x: 295, y: 1120 },
          { at: 0.65, rect: [717, 378, 360, 184], w: 440, x: 785, y: 1120 },
        ] },
      // "Open a scout file, and it's all there."
      { kind: "stage", t: 6.3, d: 2.6, shot: "kami-scout-modal", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE SCOUT FILE", lines: ["OPEN A FILE.", "IT'S {ALL THERE}."], size: 96 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 0.25, rect: [510, 117, 435, 603], w: 420, x: 290, y: 1080, shape: "notch", cut: 24 },
          { at: 0.4, rect: [1035, 195, 315, 270], w: 430, x: 790, y: 930 },
          { at: 0.55, rect: [995, 522, 398, 146], w: 430, x: 790, y: 1230 },
        ] },
      // "Then bid like you mean it."
      { kind: "stage", t: 8.9, d: 2.0, shot: "kami-auction-block", plateW: 1040, plateY: 1040, sweep: false,
        heads: [{ at: 0, label: "DRAFT NIGHT", lines: ["THEN BID LIKE", "YOU [MEAN IT]."], size: 96 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [{ at: 0.15, rect: [916, 714, 334, 87], w: 900, y: 1010, shape: "slant", cut: 22,
          live: [
            { rect: [945, 742, 160, 50], size: 36, color: "#5b8dff", steps: [{ at: 0, text: "$1,200" }, { at: 0.75, text: "$1,400" }, { at: 1.35, text: "$1,600" }] },
            { rect: [1128, 750, 108, 30], size: 20, font: "raj", steps: [{ at: 0, text: "PATIENCE", color: "#9d6bff" }, { at: 0.75, text: "DOOM", color: "#ff8a3d" }, { at: 1.35, text: "MISFITS", color: "#ff4655" }] },
          ] }],
        toasts: [{ at: 0.75, k: "DOOM", v: "BIDS |$1,400|", color: "#ff8a3d", y: 1230 }, { at: 1.35, k: "MISFITS", v: "BIDS |$1,600|", color: "#ff4655", side: "left", y: 1230 }] },
      // "Know who you're buying… on VOLT."
      { kind: "cta", t: 10.9, d: 3.9, lines: ["SCOUT. BID.", "[WIN.]"], feat: FEAT, button: "START SCOUTING" },
    ],
  },

  // 05 ── players: every match counts (Nia, 588 pts, top of the Kami Labs season)
  {
    id: "volt-every-match-counts", duration: 18.2, fps: 60,
    vo: { file: "vo/every.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Every match counts."
      { kind: "hook", t: 0, d: 2.2, agent: "reyna", label: "PLAYER STATS", lines: ["EVERY MATCH", "[COUNTS.]"], size: 150 },
      // "Drop the score after the game, and VOLT does the rest."
      { kind: "stage", t: 2.2, d: 3.2, shot: "kami-final-modal", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "AFTER THE GAME", lines: ["DROP THE SCORE.", "{VOLT DOES THE REST.}"], size: 88 }],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.2, rect: [652, 314, 616, 451], w: 860, y: 1060,
          focus: [{ at: 0.6, rect: [826, 696, 265, 46], tag: "DROP THE SCORE", color: C.money }] }] },
      // "Nia topped the Kami Labs season with 588 points. Every kill, every round, tracked automatically."
      { kind: "stage", t: 5.4, d: 7.6, shot: "kami-leaderboard", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "SEASON LEADERBOARD", lines: ["NIA TOPPED", "THE {SEASON}."], size: 100 },
          { at: 4.1, label: "EVERY MATCH", lines: ["EVERY KILL.", "[TRACKED.]"], size: 100 },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.3, d: 3.8, rect: [843, 357, 483, 281], w: 640, y: 990,
            focus: [{ at: 2.6, rect: [1100, 594, 72, 26], tag: "588 PTS", color: C.gold, tagBelow: true }] },
          { at: 1.1, d: 3.0, rect: [345, 420, 483, 218], w: 420, x: 300, y: 1360 },
          { at: 1.2, d: 2.9, rect: [1340, 420, 483, 218], w: 420, x: 780, y: 1360 },
          { at: 4.3, rect: [345, 705, 1478, 345], w: 1000, y: 1060 },
        ] },
      // "Play. Track. Climb… on VOLT."
      { kind: "cta", t: 13.0, d: 5.2, lines: ["PLAY. TRACK.", "[CLIMB.]"], feat: FEAT, button: "JOIN A LEAGUE" },
    ],
  },

  // 06 ── formats: groups, then knockouts (how Kami Labs ran it)
  {
    id: "volt-any-format", duration: 17.8, fps: 60,
    vo: { file: "vo/format.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Groups, then knockouts."
      { kind: "hook", t: 0, d: 2.4, art: ART.archer, label: "TOURNAMENT FORMATS", lines: ["GROUPS, THEN", "[KNOCKOUTS.]"], size: 140 },
      // "Kami Labs split six teams into two groups. Every fixture, scheduled automatically."
      { kind: "stage", t: 2.4, d: 5.9, shot: "kami-fixtures-league", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "KAMI LABS", lines: ["SIX TEAMS.", "{TWO GROUPS.}"], size: 100 },
          { at: 3.3, label: "AUTO FIXTURES", lines: ["EVERY FIXTURE", "[SCHEDULED.]"], size: 100 },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.45, d: 2.75, rect: [345, 352, 723, 285], w: 880, y: 850 },
          { at: 0.6, d: 2.6, rect: [1100, 352, 723, 285], w: 880, y: 1220 },
          { at: 3.5, rect: [345, 667, 723, 413], w: 880, y: 1080 },
        ] },
      // "The top teams go to the semis… and one team takes the final."
      { kind: "stage", t: 8.3, d: 4.8, shot: "kami-playoffs-final", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "PLAYOFFS", lines: ["TOP TEAMS", "TO THE {SEMIS}."], size: 100 },
          { at: 2.5, label: "THE FINAL", lines: ["ONE TEAM", "TAKES IT [ALL]."], size: 100 },
        ],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 0.4, d: 2.1, rect: [366, 486, 713, 110], w: 960, y: 900 },
          { at: 0.55, d: 1.95, rect: [1098, 486, 703, 110], w: 960, y: 1100 },
          { at: 2.65, rect: [765, 700, 635, 130], w: 960, y: 1020 },
        ] },
      // "Any format. Zero admin. On VOLT."
      { kind: "cta", t: 13.1, d: 4.7, lines: ["ANY FORMAT.", "[ZERO ADMIN.]"], feat: "Groups · Playoffs · Single elimination · League", button: "START YOUR LEAGUE" },
    ],
  },

  // 07 ── the real Kami Labs run to the trophy
  {
    id: "volt-road-to-the-final", duration: 21.5, fps: 60,
    vo: { file: "vo/final.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Six teams. One champion."
      { kind: "hook", t: 0, d: 3.6, art: ART.sage, label: "KAMI LABS TOURNAMENT", lines: ["SIX TEAMS.", "~ONE CHAMPION.~"], size: 140, stripeColor: C.gold },
      // "Vanguard went unbeaten in Group A. Patience did the same in Group B."
      { kind: "stage", t: 3.6, d: 4.4, shot: "kami-fixtures-league", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "GROUP A", lines: ["VANGUARD", "{UNBEATEN.}"], size: 96 },
          { at: 2.4, label: "GROUP B", lines: ["PATIENCE", "[UNBEATEN.]"], size: 96 },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.3, d: 2.1, rect: [345, 352, 723, 285], w: 940, y: 1040,
            focus: [{ at: 1.1, rect: [368, 450, 700, 48], tag: "2–0", color: C.volt }] },
          { at: 2.5, rect: [1100, 352, 723, 285], w: 940, y: 1040,
            focus: [{ at: 3.1, rect: [1122, 450, 700, 48], tag: "2–0", color: C.hot }] },
        ] },
      // "The semis… thirteen-ten. Thirteen-five."
      { kind: "stage", t: 8.0, d: 4.3, shot: "kami-playoffs", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "SEMIFINALS", lines: ["THE {SEMIS}."], size: 110 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 1.44, rect: [366, 486, 713, 110], w: 960, y: 900 },
          { at: 2.87, rect: [1098, 486, 703, 110], w: 960, y: 1110 },
        ] },
      // "Then the final: Patience, thirteen to four. Champions!"
      { kind: "stage", t: 12.3, d: 5.2, shot: "kami-playoffs-final", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "GRAND FINAL", lines: ["THEN THE {FINAL}."], size: 110 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [{ at: 2.1, rect: [765, 700, 635, 130], w: 960, y: 1000 }],
        stamp: { at: 3.8, text: "CHAMPIONS", size: 140, sub: "PATIENCE · KAMI LABS", color: C.gold, y: 1130 } },
      // "Who takes yours? On VOLT."
      { kind: "cta", t: 17.5, d: 4.0, lines: ["WHO TAKES", "[YOURS?]"], feat: FEAT, button: "HOST A TOURNAMENT" },
    ],
    cues: [{ t: 16.3, k: "shimmer", g: 0.5 }],
  },

  // 08 ── predictions (every vote backed PATIENCE in the final; they won 13–4)
  {
    id: "volt-call-it", duration: 15.8, fps: 60,
    vo: { file: "vo/call.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "Call it before it happens."
      { kind: "hook", t: 0, d: 2.6, agent: "raze", label: "MATCH NIGHT", lines: ["CALL IT", "[BEFORE] IT", "HAPPENS."], size: 140 },
      // "Every match, the crowd picks a side."
      { kind: "stage", t: 2.6, d: 2.4, shot: "kami-fixtures-league", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "PREDICTIONS", lines: ["THE CROWD", "{PICKS A SIDE.}"], size: 100 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [{ at: 0.3, rect: [345, 667, 723, 413], w: 900, y: 1080 }] },
      // "Before the Kami Labs final, every single vote backed Patience."
      { kind: "stage", t: 5.0, d: 3.9, shot: "kami-final-modal", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE FINAL", lines: ["EVERY VOTE", "BACKED [PATIENCE.]"], size: 100 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [{ at: 0.25, rect: [652, 314, 616, 451], w: 860, y: 1060,
          focus: [{ at: 2.9, rect: [679, 610, 562, 45], tag: "4 OF 4 VOTES · PATIENCE", color: C.hot }] }] },
      // "They won thirteen to four."
      { kind: "stage", t: 8.9, d: 2.3, shot: "kami-playoffs-final", plateW: 1040, plateY: 1060, sweep: false,
        heads: [{ at: 0, label: "RESULT", lines: ["THEY WON", "|13–4|."], size: 110 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [{ at: 0.1, rect: [765, 700, 635, 130], w: 960, y: 1000 }],
        stamp: { at: 1.07, text: "CALLED IT", size: 150, sub: "PATIENCE · 13–4", color: C.money, y: 1140 } },
      // "Pick. Watch. Gloat… on VOLT."
      { kind: "cta", t: 11.2, d: 4.6, lines: ["PICK. WATCH.", "[GLOAT.]"], feat: FEAT, button: "JOIN A LEAGUE" },
    ],
  },

  // 09 ── captains: run the team (Yona's MISFITS: limonataa for $4,100, the rest for $5,400)
  {
    id: "volt-captain-mode", duration: 16.8, fps: 60,
    vo: { file: "vo/captain.flac", t: 0.35, gain: 0.85 },
    scenes: [
      // "You're the captain."
      { kind: "hook", t: 0, d: 1.6, agent: "phoenix", label: "CAPTAIN MODE", lines: ["YOU'RE THE", "[CAPTAIN.]"], size: 156, delay: 0.05 },
      // "Ten thousand to spend. Four players to buy."
      { kind: "stat", t: 1.6, d: 2.7, label: "EVERY CAPTAIN GETS",
        items: [{ to: 10000, prefix: "$", label: "To spend", color: C.money, at: 0.1, dur: 0.9 }, { to: 4, label: "Players to buy", color: C.voltHi, at: 1.5, dur: 0.5 }] },
      // "Watch every purse on the board."
      { kind: "stage", t: 4.3, d: 2.5, shot: "kami-dashboard", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "DRAFT DASHBOARD", lines: ["WATCH EVERY", "{PURSE.}"], size: 100 }],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.3, rect: [1340, 795, 483, 273], w: 900, y: 1060 }] },
      // "Yona went big on limonata: forty-one hundred. Then built the rest for under fifty-five hundred."
      { kind: "stage", t: 6.8, d: 6.1, shot: "kami-rosters", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "YONA · MISFITS", lines: ["WENT BIG.", "|$4,100|."], size: 110 },
          { at: 3.8, label: "YONA · MISFITS", lines: ["THEN BUILT", "{DEEP.}"], size: 110 },
        ],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.3, rect: [343, 233, 357, 535], w: 580, y: 1110, shape: "notch", cut: 24,
          focus: [{ at: 2.4, rect: [361, 457, 285, 50], tag: "LIMONATAA · $4,100", color: C.money }, { at: 4.2, rect: [361, 516, 285, 168], tag: "3 MORE · $5,400", color: C.volt, tagBelow: true }] }] },
      // "Lead your squad… on VOLT."
      { kind: "cta", t: 12.9, d: 3.9, lines: ["LEAD YOUR", "[SQUAD.]"], feat: FEAT, button: "CLAIM YOUR TEAM" },
    ],
  },

  // 10 ── the whole thing in 14 seconds, every cut on its word
  {
    id: "volt-this-is-volt", duration: 14.2, fps: 60,
    vo: { file: "vo/this.flac", t: 0.35, gain: 0.85 },
    scenes: [
      { kind: "hook", t: 0, d: 1.5, art: ART.omenVoid, lines: ["THIS IS", "[VOLT.]"], size: 180, delay: 0.05 },
      { kind: "montage", t: 1.5, beat: 1, items: [
        { at: 0.06, shot: "kami-pool-scrolled", center: [1642, 668], word: "SIGN UP", small: "SOLO OR SQUAD" },
        { at: 1.09, shot: "kami-scout-modal", center: [727, 420], word: "GET SCOUTED" },
        { at: 2.3, shot: "kami-auction-block", center: [1083, 757], word: "GET DRAFTED", small: "LIVE AUCTION" },
        { at: 3.58, shot: "kami-rosters", center: [520, 500], word: "BUILD TEAMS" },
        { at: 4.82, shot: "kami-final-modal", center: [960, 600], word: "PREDICT" },
        { at: 5.73, shot: "kami-playoffs", center: [1082, 540], word: "COMPETE" },
        { at: 6.65, shot: "kami-leaderboard", center: [1083, 470], word: "CLIMB" },
        { at: 7.61, d: 0.89, shot: "kami-fixtures-champion", center: [1083, 417], word: "~WIN.~" },
      ] },
      { kind: "cta", t: 10.0, d: 4.2, lines: ["RUN YOUR LEAGUE", "ON [VOLT.]"], size: 104, feat: FEAT, button: "START YOUR LEAGUE" },
    ],
  },

  // 11 ── the launch: the first reel, the whole product on Kami Labs' real season.
  //       Its own voice ("Jett", young and gritty; vo/launch.flac at t=0.25).
  {
    id: "volt-launch", duration: 46.0, fps: 60,
    vo: { file: "vo/launch.flac", t: 0.25, gain: 0.85 },
    scenes: [
      // "Your Valorant league… just went pro."  (cold open on the draw)
      { kind: "draw", t: 0, d: 3.0, draw: "kami-draw", spin: 2.35, delay: 0.05, y: 1010, cardW: 400,
        reveal: { name: "KAMIJEEE", sub: "Silver · heads to the block at $800" },
        head: { label: "VALORANT LEAGUES", lines: ["YOUR LEAGUE", "JUST WENT [PRO.]"], size: 118 } },
      // "Introducing VOLT."
      { kind: "cta", t: 3.0, d: 2.0, tag: "// INTRODUCING", lines: ["{VALORANT} LEAGUES,", "[DONE RIGHT.]"], size: 92, button: false, exit: "fade" },
      // "Players sign up solo, with their real rank and stats."
      { kind: "stage", t: 5.0, d: 3.6, shot: "kami-pool-scrolled", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "SIGN UP SOLO", lines: ["REAL RANK.", "{REAL STATS.}"], size: 100 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.35, rect: [345, 378, 360, 184], w: 440, x: 295, y: 830 },
          { at: 0.45, rect: [1462, 378, 360, 184], w: 440, x: 785, y: 830,
            focus: [{ at: 1.3, rect: [1480, 421, 110, 18], tag: "RANK" }, { at: 1.95, rect: [1480, 443, 170, 18], tag: "ROLE", tagBelow: true }, { at: 2.6, rect: [1480, 478, 250, 22], tag: "STATS", color: C.money, tagBelow: true }] },
          { at: 0.55, rect: [1090, 578, 360, 180], w: 440, x: 295, y: 1120 },
          { at: 0.65, rect: [717, 378, 360, 184], w: 440, x: 785, y: 1120 },
        ] },
      // "Captains scout every single one."
      { kind: "stage", t: 8.6, d: 2.6, shot: "kami-scout-modal", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "FOR CAPTAINS", lines: ["SCOUT EVERY", "[PLAYER.]"], size: 100 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 0.25, rect: [510, 117, 435, 603], w: 420, x: 290, y: 1080, shape: "notch", cut: 24 },
          { at: 0.4, rect: [1035, 195, 315, 270], w: 430, x: 790, y: 930 },
          { at: 0.55, rect: [995, 522, 398, 146], w: 430, x: 790, y: 1230 },
        ] },
      // "Then it's draft night. A live auction.  Kamijee's on the block. 1200… 1400… 1600! Sold!"
      { kind: "stage", t: 11.2, d: 10.05, shot: "kami-auction-block", plateW: 1040, plateY: 1040, sweep: false,
        heads: [
          { at: 0, label: "DRAFT NIGHT", lines: ["A LIVE", "[AUCTION.]"], size: 118 },
          { at: 3.15, label: "ON THE BLOCK", lines: ["KAMIJEEE IS UP.", "{6 CAPTAINS} WANT HIM."], size: 92 },
          { at: 7.5, label: "HAMMER DOWN", lines: ["GOING… GOING…"] },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }, { at: 7.3, rx: 12, ry: 15, dur: 1.1 }],
        pieces: [
          { at: 0.2, d: 1.5, rect: [852, 90, 462, 602], w: 560, y: 1080, shape: "notch", cut: 24 },     // Kamijeee's card
          { at: 1.75, d: 1.5, rect: [268, 88, 254, 206], w: 380, x: 290, y: 742 },
          { at: 1.82, d: 1.43, rect: [268, 303, 254, 206], w: 380, x: 290, y: 1070 },
          { at: 1.89, d: 1.36, rect: [268, 517, 254, 206], w: 380, x: 290, y: 1398 },
          { at: 1.85, d: 1.4, rect: [1645, 88, 254, 206], w: 380, x: 790, y: 742 },
          { at: 1.92, d: 1.33, rect: [1645, 303, 254, 206], w: 380, x: 790, y: 1070 },
          { at: 1.99, d: 1.26, rect: [1645, 517, 254, 206], w: 380, x: 790, y: 1398 },
          { at: 3.3, d: 4.4, rect: [916, 714, 334, 87], w: 900, y: 1010, shape: "slant", cut: 22,       // the bid, ticking up
            live: [
              { rect: [945, 742, 160, 50], size: 36, color: "#5b8dff", steps: [{ at: 0, text: "$800" }, { at: 4.98, text: "$1,200" }, { at: 6.17, text: "$1,400" }, { at: 7.14, text: "$1,600" }] },
              { rect: [1128, 750, 108, 30], size: 20, font: "raj", steps: [{ at: 0, text: "—", color: "rgba(200,215,255,0.4)" }, { at: 4.98, text: "PATIENCE", color: "#9d6bff" }, { at: 6.17, text: "DOOM", color: "#ff8a3d" }, { at: 7.14, text: "MISFITS", color: "#ff4655" }] },
            ] },
          { at: 7.6, rect: [836, 822, 494, 72], w: 970, y: 1080, shape: "slant", cut: 22 },     // SOLD / PASS
        ],
        toasts: [{ at: 4.98, k: "PATIENCE", v: "BIDS |$1,200|", color: "#9d6bff", y: 1230 }, { at: 6.17, k: "DOOM", v: "BIDS |$1,400|", color: "#ff8a3d", side: "left", y: 1230 }, { at: 7.14, k: "MISFITS", v: "BIDS |$1,600|", color: "#ff4655", y: 1230, d: 0.9 }],
        cursor: [{ at: 7.8, x: 426, y: 1082, d: 1.8 }],
        stamp: { at: 8.79, text: "SOLD", sub: "MISFITS · $1,600", y: 840 } },
      // "Teams lock in…"
      { kind: "stage", t: 21.25, d: 1.7, shot: "kami-rosters", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE ROSTERS", lines: ["TEAMS", "[LOCK IN.]"], size: 118 }],
        plate: [{ at: 0, rx: 14, ry: 16 }],
        pieces: [{ at: 0.2, rect: [343, 233, 357, 535], w: 580, y: 1110, shape: "notch", cut: 24 }] },
      // "…and VOLT builds the whole tournament. Groups."
      { kind: "stage", t: 22.95, d: 2.35, shot: "kami-fixtures-league", plateW: 1040, plateY: 1060,
        heads: [
          { at: 0, label: "AUTO FIXTURES", lines: ["VOLT BUILDS", "THE {TOURNAMENT}."], size: 100 },
          { at: 1.5, label: "STAGE ONE", lines: ["{GROUPS.}"], size: 150 },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.2, rect: [345, 352, 723, 285], w: 880, y: 900 },
          { at: 0.3, rect: [1100, 352, 723, 285], w: 880, y: 1240 },
        ] },
      // "Playoffs. A grand final."
      { kind: "stage", t: 25.3, d: 2.7, shot: "kami-playoffs-final", plateW: 1040, plateY: 1060, sweep: false,
        heads: [
          { at: 0, label: "STAGE TWO", lines: ["[PLAYOFFS.]"], size: 150 },
          { at: 1.12, label: "STAGE THREE", lines: ["A GRAND", "~FINAL.~"], size: 150 },
        ],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [
          { at: 0.1, d: 1.02, rect: [366, 486, 713, 110], w: 960, y: 900 },
          { at: 0.2, d: 0.92, rect: [1098, 486, 703, 110], w: 960, y: 1110 },
          { at: 1.17, rect: [765, 700, 635, 130], w: 960, y: 1080 },
        ] },
      // "The crowd predicts every match."
      { kind: "stage", t: 28.0, d: 2.6, shot: "kami-final-modal", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "PREDICTIONS", lines: ["THE CROWD", "[CALLS IT.]"], size: 110 }],
        plate: [{ at: 0, rx: 12, ry: 15 }],
        pieces: [{ at: 0.2, rect: [652, 314, 616, 451], w: 860, y: 1060,
          focus: [{ at: 1.2, rect: [679, 610, 562, 45], tag: "4 OF 4 VOTES · PATIENCE", color: C.hot }] }] },
      // "And every kill hits the leaderboard."
      { kind: "stage", t: 30.6, d: 2.55, shot: "kami-leaderboard", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "LEADERBOARD", lines: ["EVERY KILL.", "{TRACKED.}"], size: 110 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.2, rect: [843, 357, 483, 281], w: 640, y: 990,
            focus: [{ at: 1.3, rect: [1100, 594, 72, 26], tag: "588 PTS", color: C.gold, tagBelow: true }] },
          { at: 0.45, rect: [345, 420, 483, 218], w: 420, x: 300, y: 1360 },
          { at: 0.55, rect: [1340, 420, 483, 218], w: 420, x: 780, y: 1360 },
        ] },
      // "Hosting? It runs itself."
      { kind: "list", t: 33.15, d: 2.45, label: "FOR HOSTS", lines: ["HOSTING?", "[IT RUNS ITSELF.]"], size: 104,
        items: [{ t: "SIGN-UPS & APPROVALS", at: 0.75 }, { t: "AUCTION DRAFT", at: 1.0 }, { t: "BRACKETS & SCORES", at: 1.25 }, { t: "DISCORD ROLES", at: 1.5 }] },
      // "Kami Labs ran their entire tournament on it."
      { kind: "stage", t: 35.6, d: 3.25, shot: "kami-fixtures-champion", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "KAMI LABS", lines: ["A FULL TOURNAMENT", "ON {VOLT}."], size: 92 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.3, d: 1.9, rect: [345, 513, 723, 282], w: 860, y: 860 },
          { at: 0.45, d: 1.75, rect: [1100, 513, 723, 282], w: 860, y: 1230 },
          { at: 2.2, rect: [775, 350, 617, 135], w: 900, y: 1040 },
        ],
        toasts: [{ at: 1.1, k: "KAMI LABS", v: "6 TEAMS", color: C.volt, y: 1420, d: 0.75 }, { at: 1.75, k: "KAMI LABS", v: "24 PLAYERS", color: C.volt, side: "left", y: 1420, d: 0.75 }] },
      // "Your league is next."
      { kind: "hook", t: 38.85, d: 1.2, art: ART.omenVoid, label: "NOW LIVE", lines: ["YOUR LEAGUE", "IS [NEXT.]"], size: 150 },
      // "VOLT. Now live."
      { kind: "cta", t: 40.05, d: 5.95, lines: ["NOW", "[LIVE.]"], size: 140, feat: "Solo sign-ups · Live auction · Brackets · Predictions · Stats", button: "START YOUR LEAGUE" },
    ],
  },

];

// 12 ── "Watch the number": Nia on the block, every $100 from $2,000 to $4,100.
//       The board kept the opening price, the 12+ bid count, the winner (VANGUARD) and
//       the price; who placed each step in between is a reconstruction.
{
  const TEAM = [["MISFITS", "#ff4655"], ["CHAOS", "#00e5ff"], ["PATIENCE", "#9d6bff"], ["VANGUARD", "#5ad1ff"], ["DOOM", "#ff8a3d"], ["IN&OUT", "#3ddc84"]];
  const SEQ = [2, 4, 0, 1, 5, 2, 3, 4, 0, 1, 2, 3, 4, 5, 0, 3, 4, 0, 3, 4, 3];
  // gaps shrink from 0.42s to 0.12s, so the last bid lands on "forty-one hundred" (9.69s)
  const LAST = 9.69, N = SEQ.length, gap = (i) => 0.42 - (0.30 * i) / (N - 2);
  const T = []; let t = LAST;
  for (let i = N - 1; i >= 0; i--) { T[i] = +t.toFixed(2); if (i) t -= gap(i - 1); }
  const money = (v) => "$" + v.toLocaleString("en-US");
  const bids = SEQ.map((k, i) => ({ at: T[i], v: 2100 + 100 * i, team: TEAM[k] }));
  REELS.push({
    id: "volt-watch-the-number", duration: 26.5, fps: 60,
    vo: { file: "vo/nia.flac", t: 0.3, gain: 0.85 },
    hush: [{ t: 12.95, d: 1.72 }],           // silence between "going…" and "SOLD"
    scenes: [
      // "Watch the number.  Nia. Diamond Jett. Opens at two thousand. And six captains want her.
      //  …forty-one hundred. Going… going…  Sold. To Vanguard."
      { kind: "stage", t: 0, d: 16.45, shot: "nia-auction-block", plateW: 1040, plateY: 1040, sweep: false,
        heads: [
          { at: 0, label: "LIVE AUCTION", lines: ["WATCH THE", "[NUMBER.]"], size: 140 },
          { at: 2.15, label: "ON THE BLOCK", lines: ["NIA · DIAMOND JETT", "OPENS AT |$2,000|."], size: 88 },
          { at: 5.05, label: "BIDDING WAR", lines: ["{6 CAPTAINS}", "WANT HER."], size: 120 },
          { at: 11.05, label: "HAMMER DOWN", lines: ["GOING…", "GOING…"], size: 130 },
        ],
        plate: [{ at: 0, rx: 14, ry: -16 }, { at: 10.9, rx: 12, ry: 15, dur: 1.2 }],
        pieces: [
          { at: 0.1, rect: [916, 714, 334, 87], w: 900, y: 1400, shape: "slant", cut: 22,          // the bid
            live: [
              { rect: [928, 745, 182, 49], size: 36, color: "#5b8dff", steps: [{ at: 0, text: "$2,000" }, ...bids.map((b) => ({ at: b.at, text: money(b.v) }))] },
              { rect: [1128, 750, 108, 30], size: 20, font: "raj", steps: [{ at: 0, text: "—", color: "rgba(200,215,255,0.4)" }, ...bids.map((b) => ({ at: b.at, text: b.team[0], color: b.team[1] }))] },
            ] },
          { at: 1.95, d: 9.1, rect: [852, 90, 462, 602], w: 440, y: 815, shape: "notch", cut: 24 },  // Nia's card
          { at: 11.2, shot: "nia-sold-auction-block", rect: [836, 822, 494, 72], w: 970, y: 1080, shape: "slant", cut: 22 },  // SOLD / PASS, from the end state
        ],
        toasts: bids.map((b, i) => ({ at: b.at, k: b.team[0], v: `BIDS |${money(b.v)}|`, color: b.team[1], y: 1640,
          p: Math.min(7, Math.floor((i * 8) / N)), g: 0.55, ...(i === N - 1 ? { d: 1.3 } : {}) })),
        cursor: [{ at: 13.6, x: 426, y: 1082, d: 1.4 }],
        stamp: { at: 14.69, text: "SOLD", sub: "VANGUARD · $4,100", color: C.money, y: 840 } },
      // "Then she topped the entire season. Five hundred and eighty-eight points."
      { kind: "stage", t: 16.45, d: 4.2, shot: "kami-leaderboard", plateW: 1040, plateY: 1060,
        heads: [{ at: 0, label: "THE SEASON", lines: ["THEN SHE TOPPED", "THE {LEADERBOARD.}"], size: 92 }],
        plate: [{ at: 0, rx: 14, ry: -16 }],
        pieces: [
          { at: 0.25, rect: [843, 357, 483, 281], w: 640, y: 990,
            focus: [{ at: 2.05, rect: [1100, 594, 72, 26], tag: "588 PTS · #1", color: C.gold, tagBelow: true }] },
          { at: 0.6, rect: [345, 420, 483, 218], w: 420, x: 300, y: 1360 },
          { at: 0.7, rect: [1340, 420, 483, 218], w: 420, x: 780, y: 1360 },
        ] },
      // "Worth it?"
      { kind: "hook", t: 20.65, d: 1.4, ghost: "?", label: "VANGUARD PAID $4,100", lines: ["WORTH", "|IT?|"], size: 190 },
      // "Get drafted… on VOLT."
      { kind: "cta", t: 22.05, d: 4.45, lines: ["GET", "[DRAFTED.]"], size: 130, feat: FEAT, button: "FIND A LEAGUE" },
    ],
    cues: [
      ...[1.0, 1.95, 2.9, 3.8].map((t) => ({ t, k: "heart", g: 0.55 })),
      ...[13.05, 13.85].map((t) => ({ t, k: "heart", g: 0.8 })),
    ],
  });
}

const only = process.argv[2];
if (only === "--list") { REELS.forEach((r, i) => console.log(String(i + 1).padStart(2, "0") + " " + r.id)); process.exit(0); }
for (const spec of REELS) {
  if (only && !spec.id.includes(only)) continue;
  const r = reel(spec);
  console.log("✓", spec.id, r.cues, "cues");
}
