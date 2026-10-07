// The landscape explainer (/brag, polished, 1920x1080, ~2 min): what VOLT is, every
// feature on the real Kami Labs screens, and what hosts, players and communities get.
// Writes a HyperFrames project to brag-output/composition/ (index.html + assets),
// timed to the Jax voiceover in reels/vo/explainer.flac (word times from
// `hyperframes transcribe`, VO placed at 0.6s).
//   node reels/lib/explainer.mjs   then   cd brag-output/composition && npx hyperframes check
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REELS = path.resolve(HERE, "..");
const ROOT = path.resolve(REELS, "..");
const OUT = path.join(ROOT, "brag-output", "composition");
const SCREENS = path.join(REELS, "screens");
const BRAG = path.join(process.env.USERPROFILE || process.env.HOME, ".claude", "skills", "brag", "assets");
const FF = process.env.FFMPEG || "ffmpeg";

const W = 1920, H = 1080, SW = 1920, SH = 1080, D = 120;
const VO = 0.6; // voiceover start
const C = { navy: "#0a0d18", panel: "#0d1326", blue: "#3d7bff", hi: "#7da6ff", red: "#ff4655", green: "#3ddc84", gold: "#f5c453", ink: "#ecf3ff", dim: "rgba(205,218,255,0.62)" };
const J = (v) => JSON.stringify(v);
const r = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const html = [], js = [], sfx = [];
const assets = new Map();
const tw = (sel, from, to, at) => js.push(`tl.fromTo(${J(sel)},${J(from)},${J({ ...to, immediateRender: to.immediateRender ?? true })},${r(at)});`);
const to = (sel, v, at) => js.push(`tl.to(${J(sel)},${J(v)},${r(at)});`);
const set = (sel, v, at) => js.push(`tl.set(${J(sel)},${J(v)},${r(at)});`);
const fx = (t, file, vol = 0.3) => sfx.push({ t: r(t), file, vol });
const shot = (name) => {
  const out = path.join(OUT, "assets", "screens", name + ".webp");
  assets.set(out, () => execFileSync(FF, ["-y", "-loglevel", "error", "-i", path.join(SCREENS, name + ".png"), "-c:v", "libwebp", "-quality", "90", out]));
  return `assets/screens/${name}.webp`;
};
let clipN = 0;
// a timed scene; everything inside fades/rises in and fades out (the .clip itself is never tweened)
const scene = (t0, d, inner, { track = 1, id = `sc${++clipN}`, fadeIn = 0.45, fadeOut = 0.35 } = {}) => {
  html.push(`<div class="clip" id="${id}" data-start="${r(t0)}" data-duration="${r(d)}" data-track-index="${track}"><div class="sc" id="${id}-in">${inner}</div></div>`);
  tw(`#${id}-in`, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: fadeIn, ease: "power2.out" }, t0);
  if (fadeOut) to(`#${id}-in`, { opacity: 0, duration: fadeOut, ease: "power1.in" }, t0 + d - fadeOut);
  return id;
};
const pop = (sel, at, { y = 14, d = 0.4, scale } = {}) => tw(sel, { opacity: 0, y, ...(scale ? { scale } : {}) }, { opacity: 1, y: 0, ...(scale ? { scale: 1 } : {}), duration: d, ease: "power3.out" }, at);

// ── the VOLT mark
const ARM = "M344.811 140.139H0L273.118 552.012L436.988 278.57L344.811 140.139Z";
const BOLT = "M392.606 466.561L689.622 0H1002L303.843 834L549.649 401.619L392.606 466.561Z";
const logo = (id, w) => `<svg class="logo" id="${id}" viewBox="0 0 1100 420" width="${w}" height="${Math.round((w * 420) / 1100)}"><defs>
  <linearGradient id="${id}-gb" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8db3ff"/><stop offset="0.55" stop-color="#3d7bff"/><stop offset="1" stop-color="#1f47c9"/></linearGradient>
  <linearGradient id="${id}-ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9cbef"/></linearGradient></defs>
  <g transform="scale(0.5036)"><path id="${id}-arm" d="${ARM}" fill="url(#${id}-ga)"/><path id="${id}-bolt" d="${BOLT}" fill="url(#${id}-gb)"/></g>
  <g transform="translate(205 90) scale(6)" fill="#f4f8ff"><path id="${id}-o" fill-rule="evenodd" d="M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z"/><path id="${id}-l" d="M80 0H89.5V31H105V40H80Z"/><path id="${id}-t" d="M109 0H146V9.5H132.25V40H122.75V9.5H109Z"/></g></svg>`;
const sting = (id, at) => {
  tw(`#${id}-arm`, { x: -260, opacity: 0 }, { x: 0, opacity: 1, duration: 0.55, ease: "expo.out" }, at);
  tw(`#${id}-bolt`, { x: 240, y: -320, opacity: 0 }, { x: 0, y: 0, opacity: 1, duration: 0.42, ease: "expo.in" }, at + 0.15);
  ["o", "l", "t"].forEach((c, i) => tw(`#${id}-${c}`, { y: 16, opacity: 0 }, { y: 0, opacity: 1, duration: 0.5, ease: "power4.out" }, at + 0.55 + i * 0.07));
};

// ── a browser frame on the right, with a camera over a real screen
const F = { x: 800, y: 210, w: 1040, bar: 40 };
F.vh = Math.round((F.w * SH) / SW);
const camOf = ({ cx = 960, cy = 540, w = 1920 }) => {
  const s = F.w / w;
  let x = F.w / 2 - cx * s, y = F.vh / 2 - cy * s;
  x = Math.min(0, Math.max(F.w - SW * s, x)); y = Math.min(0, Math.max(F.vh - SH * s, y));
  return { s, x: r(x), y: r(y) };
};
// shots: [{ id, name, at, cams: [{ at, cx, cy, w, dur }], callouts: [{ at, rect, tag, color, w }] }]
const frame = (fid, shots, { x = F.x, y = F.y, w = F.w, label = "KAMI LABS", live } = {}) => {
  const vh = Math.round((w * SH) / SW), k = w / F.w;
  const layers = shots.map((sh, i) => {
    const c0 = camOf(sh.cams[0]);
    const cos = (sh.callouts || []).map((co, j) => {
      const s = camOf(sh.cams.findLast((c) => c.at <= co.at) || sh.cams[0]).s * k;
      const [rx, ry, rw, rh] = co.rect, pad = 10 / s, col = co.color || C.blue, cid = `${sh.id}-co${j}`;
      tw(`#${cid}`, { opacity: 0, scale: 1.12 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(1.7)" }, co.at);
      if (co.d) to(`#${cid}`, { opacity: 0, duration: 0.3 }, co.at + co.d);
      fx(co.at, "ui/click2.ogg", 0.22);
      return `<div class="co" id="${cid}" style="left:${rx - pad}px;top:${ry - pad}px;width:${rw + pad * 2}px;height:${rh + pad * 2}px;border-width:${3 / s}px;border-color:${col};box-shadow:0 0 ${24 / s}px ${col}88;background:${col}1a">${co.tag ? `<b style="font-size:${18 / s}px;background:${col};${co.below ? `top:calc(100% + ${6 / s}px)` : `bottom:calc(100% + ${6 / s}px)`};padding:${3 / s}px ${10 / s}px">${esc(co.tag)}</b>` : ""}</div>`;
    }).join("");
    const live2 = sh.live || "";
    // camera: settle in, then each move
    tw(`#${sh.id}-c`, { x: c0.x * k, y: c0.y * k, scale: c0.s * k * 1.03, transformOrigin: "0 0" }, { x: c0.x * k, y: c0.y * k, scale: c0.s * k, duration: 1.2, ease: "power2.out" }, sh.at);
    sh.cams.slice(1).forEach((c) => { const q = camOf(c); to(`#${sh.id}-c`, { x: q.x * k, y: q.y * k, scale: q.s * k, duration: c.dur || 1.1, ease: "power2.inOut" }, c.at); });
    if (i > 0) tw(`#${sh.id}`, { opacity: 0 }, { opacity: 1, duration: 0.45, ease: "power1.inOut" }, sh.at);
    return `<div class="shot" id="${sh.id}"><div class="cam" id="${sh.id}-c"><img src="${shot(sh.name)}" width="${SW}" height="${SH}">${cos}${live2}</div></div>`;
  }).join("");
  return `<div class="frame" id="${fid}" style="left:${x}px;top:${y}px;width:${w}px"><div class="bar"><i></i><i></i><i></i><span class="url"><em>VOLT</em> / ${esc(label)}</span>${live ? `<span class="live" id="${fid}-live">● LIVE</span>` : ""}</div><div class="vp" style="height:${vh}px">${layers}</div></div>`;
};

// ── the left text panel of a chapter
const panel = (id, no, label, lines, bullets = []) => {
  const ls = lines.map(([t, at], i) => { pop(`#${id}-h${i}`, at, { y: 24, d: 0.55 }); return `<div class="hl" id="${id}-h${i}">${esc(t)}</div>`; }).join("");
  const bs = bullets.map(([t, at], i) => { pop(`#${id}-b${i}`, at, { y: 10, d: 0.4 }); fx(at, "ui/click2.ogg", 0.2); return `<div class="bl" id="${id}-b${i}"><i></i><span>${t}</span></div>`; }).join("");
  return `<div class="lp"><div class="chap"><span class="chn">${no}</span><span class="chl">${esc(label)}</span></div>${ls}<div class="bls">${bs}</div></div>`;
};
// a cropped piece of a screen as a floating card
const card = (id, name, [rx, ry, rw, rh], { x, y, w, cls = "" }) => {
  const s = w / rw;
  return `<div class="card ${cls}" id="${id}" style="left:${x}px;top:${y}px;width:${w}px;height:${r(rh * s)}px"><div class="crop"><img src="${shot(name)}" style="width:${SW * s}px;height:${SH * s}px;left:${-rx * s}px;top:${-ry * s}px"></div></div>`;
};

// ════════════════════════════════════════════════════════════════════
// 0 · "If you've seen our reels… here's the full picture."
{
  const names = ["kami-player-pool", "kami-auction-block", "kami-scout-modal", "kami-fixtures-league", "kami-leaderboard", "kami-rosters", "kami-playoffs-final", "kami-final-modal", "kami-league-page", "kami-dashboard", "kami-match-modal", "kami-fixtures-champion"];
  const tiles = names.map((n, i) => `<div class="tile" style="left:${(i % 4) * 620}px;top:${Math.floor(i / 4) * 360}px"><img src="${shot(n)}"></div>`).join("");
  scene(0, 5.55, `<div class="wall" id="w0">${tiles}</div><div class="wall-shade"></div>
    <div class="mid"><div class="big" id="i0a">SEEN OUR REELS?</div><div class="big" id="i0b">HERE'S THE <span class="b">FULL PICTURE.</span></div></div>`, { fadeIn: 0.6 });
  tw("#w0", { x: -40, y: -60, rotation: -7, scale: 1.05 }, { x: -260, y: -60, rotation: -7, scale: 1.05, duration: 5.6, ease: "none" }, 0);
  pop("#i0a", 0.95, { y: 30, d: 0.6 });
  to("#i0a", { opacity: 0, y: -24, duration: 0.3 }, 3.7);
  pop("#i0b", 3.95, { y: 30, d: 0.6 });
  fx(0.95, "impact/impactSoft_medium_001.ogg", 0.3); fx(3.95, "impact/impactSoft_medium_004.ogg", 0.3);
}

// 1 · what it is, and who it's for
{
  scene(5.4, 11.7, `<div class="logo-c" id="l1">${logo("lg1", 720)}</div>
    <div class="mid1"><div class="hl c" id="w1a">A PLATFORM FOR RUNNING</div><div class="hl c" id="w1b">YOUR OWN <span class="b">VALORANT LEAGUE.</span></div>
    <div class="for" id="w1f">BUILT FOR</div>
    <div class="chips"><span class="chip" id="w1c0">Community hosts</span><span class="chip" id="w1c1">Discord servers</span><span class="chip" id="w1c2">Clubs</span></div>
    <div class="line" id="w1l">Anyone who wants to run a real tournament, <span class="nos">without the <s id="w1s">spreadsheets</s></span>.</div></div>`);
  sting("lg1", 5.4); fx(5.95, "impact/impactBell_heavy_000.ogg", 0.28);
  tw("#l1", { y: 0, scale: 1 }, { y: -265, scale: 0.42, duration: 0.8, ease: "power3.inOut" }, 6.35);
  pop("#w1a", 6.6, { y: 24, d: 0.55 }); pop("#w1b", 7.2, { y: 24, d: 0.55 });
  pop("#w1f", 9.7);
  [10.1, 11.3, 12.55].forEach((t, i) => { pop(`#w1c${i}`, t, { scale: 0.85 }); fx(t, "ui/click2.ogg", 0.22); });
  pop("#w1l", 13.35);
  tw("#w1s", { "--strike": 0 }, { "--strike": 1, duration: 0.35, ease: "power2.out" }, 16.0);
}

// 2 · the problem
{
  const rows = [["Sign-ups in DMs", 19.45], ["A spreadsheet of ranks", 21.2], ["A draft over voice chat", 22.9], ["A bracket updated by hand", 24.75]];
  const chaos = [
    `<div class="mess dm" id="m0" data-layout-allow-overlap><b>DMs</b><p class="bub">yo can i still sign up??</p><p class="bub me">gold 2, duelist</p><p class="bub">wait which team am i on</p></div>`,
    `<div class="mess sheet" id="m1" data-layout-allow-overlap><b>League sheet (FINAL v3)</b>${["NAME|RANK|ROLE", "player1|Gold 2|Duelist", "player2|???|Sentinel", "player3|Plat 1|", "player4|Silver 3|Flex"].map((r0, i) => `<div class="tr${i ? "" : " th"}">${r0.split("|").map((c) => `<span>${esc(c)}</span>`).join("")}</div>`).join("")}</div>`,
    `<div class="mess vc" id="m2" data-layout-allow-overlap><b>🔊 Draft night · voice</b><p>"who's next?"</p><p>"wait, what's my budget"</p><p>"did anyone write that down"</p></div>`,
    `<div class="mess br2" id="m3" data-layout-allow-overlap><b>Bracket (by hand)</b><svg viewBox="0 0 300 150" width="300" height="150"><path d="M10 20h80v40h40M10 100h80v-40M130 60h60v40h40M10 140h80v-40" stroke="#c9d3ea" stroke-width="3" fill="none" stroke-linecap="round"/><text x="150" y="52" fill="#ff8a8a" font-size="18" font-family="Space Grotesk">TBD?</text></svg></div>`,
  ];
  scene(16.95, 13.65, `<div class="lp"><div class="chap"><span class="chl">THE PROBLEM</span></div><div class="hl" id="p2h0">RUNNING A LEAGUE</div><div class="hl" id="p2h1">TODAY MEANS…</div>
      <div class="rows">${rows.map(([t], i) => `<div class="row" id="p2r${i}"><i></i><span>${esc(t)}<s id="p2s${i}"></s></span></div>`).join("")}</div></div>
    <div class="pile" id="pile" data-layout-allow-overlap>${chaos.join("")}</div>
    <div class="verdict" id="p2v"><div id="p2v0">HOURS OF ADMIN.</div><div class="red" id="p2v1">SOMETHING ALWAYS BREAKS.</div></div>`);
  pop("#p2h0", 17.1, { y: 24, d: 0.55 }); pop("#p2h1", 17.5, { y: 24, d: 0.55 });
  const rot = [-4, 3, -2, 4], pos = [[0, 0], [395, 30], [10, 330], [400, 350]];
  rows.forEach(([, t], i) => {
    pop(`#p2r${i}`, t, { y: 10 }); fx(t, "interface/bong_001.ogg", 0.22);
    tw(`#m${i}`, { opacity: 0, x: pos[i][0] + 80, y: pos[i][1], rotation: rot[i] + 8, scale: 1.1 }, { opacity: 1, x: pos[i][0], y: pos[i][1], rotation: rot[i], scale: 1, duration: 0.45, ease: "power3.out" }, t + 0.05);
    tw(`#p2s${i}`, { scaleX: 0 }, { scaleX: 1, duration: 0.3, ease: "power2.out" }, 27.25 + i * 0.12);
  });
  to(".row span", { color: "rgba(205,218,255,0.45)", duration: 0.3 }, 27.5);
  to("#pile", { opacity: 0.18, duration: 0.4 }, 27.25);
  pop("#p2v0", 27.3, { y: 20, d: 0.5 }); pop("#p2v1", 28.75, { y: 20, d: 0.5 });
  fx(27.25, "interface/click_003.ogg", 0.25); fx(28.75, "impact/impactSoft_medium_002.ogg", 0.32);
}

// the header: small mark (from 17s) and the chapter rail (chapters 1–7)
const CH = [["01", "CREATE", 30.55], ["02", "SIGN-UPS", 34.25], ["03", "DRAFT", 46.9], ["04", "SCOUT", 57.45], ["05", "TEAMS", 65.05], ["06", "TOURNAMENT", 72.1], ["07", "COMMUNITY", 86.55]];
const RAIL_END = 92.35;
scene(16.95, 114.25 - 16.95, `<div class="hdr-logo">${logo("lgh", 132)}</div>`, { track: 8, fadeIn: 0.5 });
scene(30.45, RAIL_END - 30.45, `<div class="rail">${CH.map(([n, t], i) => `<div class="ri" id="ri${i}"><span>${n}</span>${t}<i id="ri${i}u"></i></div>`).join("")}</div>`, { track: 9 });
CH.forEach(([, , t], i) => {
  const end = CH[i + 1] ? CH[i + 1][2] : RAIL_END;
  tw(`#ri${i}`, { opacity: 0.38 }, { opacity: 1, duration: 0.3 }, t);
  to(`#ri${i}`, { opacity: 0.38, duration: 0.3 }, end);
  tw(`#ri${i}u`, { scaleX: 0 }, { scaleX: 1, duration: 0.4, ease: "power2.out" }, t);
  to(`#ri${i}u`, { scaleX: 0, duration: 0.25 }, end);
  fx(t, "impact/impactSoft_medium_001.ogg", 0.26);
});

// 3 · 01 create
scene(30.55, 3.8, panel("c3", "01", "CREATE", [["CREATE YOUR", 31.0], ["LEAGUE.", 31.25], ["SHARE ONE LINK.", 32.85]]) +
  frame("f3", [{ id: "f3a", name: "kami-league-page", at: 30.55, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 31.3, cx: 990, cy: 330, w: 1400, dur: 1.6 }] }], { label: "KAMI LABS · LEAGUE" }) +
  `<div class="toast" id="t3"><b>🔗</b>Invite link copied</div>`);
pop("#t3", 33.05, { y: 16 }); fx(33.05, "ui/click2.ogg", 0.28);

// 4 · 02 sign-ups (Kamijeee's card, his stats read from a tracker shot; then the pool)
{
  const S4 = 760 / 358, cx = 950, cy = 300, at = (x, y) => [r(cx + (x - 1464) * S4), r(cy + (y - 577) * S4)];
  const [ax, ay] = at(1474, 618), [sx, sy] = at(1474, 676);
  scene(34.25, 12.7, panel("c4", "02", "SIGN-UPS", [["PLAYERS SIGN UP", 34.35], ["SOLO.", 34.85]],
    [["Rank and role on every card", 36.3], ["Stats read from a tracker screenshot", 38.4], ["Every sign-up in one place, to approve", 42.85]]) +
    `<div class="grpA" id="g4a">${card("k4", "kami-pool-scrolled", [1464, 577, 358, 186], { x: cx, y: cy, w: 760 })}
      <div class="ring rt" id="k4r" style="left:${ax}px;top:${ay}px;width:${r(250 * S4)}px;height:${r(50 * S4)}px"><b>RANK · ROLE</b></div>
      <div class="ring g" id="k4s" style="left:${sx}px;top:${sy}px;width:${r(270 * S4)}px;height:${r(30 * S4)}px"><b>READ FROM THE SCREENSHOT</b></div>
      <div class="tracker" id="k4t"><b>tracker_screenshot.png</b><div class="tk-h">CURRENT ACT · COMPETITIVE</div><div class="tk-r"><span>ACS</span><em>242</em></div><div class="tk-r"><span>KDA</span><em>1.07</em></div><div class="tk-r"><span>HS%</span><em>15%</em></div><div class="tk-bars"><i style="width:72%"></i><i style="width:48%"></i><i style="width:61%"></i></div></div></div>` +
    `<div class="grpB" id="g4b">${frame("f4", [{ id: "f4a", name: "kami-player-pool", at: 42.6, cams: [{ cx: 1100, cy: 560, w: 1920 }, { at: 43.4, cx: 1120, cy: 520, w: 1500, dur: 2 }],
      callouts: [{ at: 44.2, rect: [1690, 160, 135, 34], tag: "34 PLAYERS", below: true }] }], { label: "KAMI LABS · PLAYER POOL" })}</div>`);
  tw("#k4", { opacity: 0, y: 30, rotation: -2 }, { opacity: 1, y: 0, rotation: 0, duration: 0.6, ease: "power3.out" }, 34.45);
  pop("#k4r", 36.3, { scale: 1.1, y: 0 });
  tw("#k4t", { opacity: 0, x: 220, rotation: 8 }, { opacity: 1, x: 0, rotation: 3, duration: 0.6, ease: "power3.out" }, 38.45); fx(38.45, "casino/card-slide-1.ogg", 0.3);
  to("#k4t", { x: -330, y: -250, scale: 0.35, opacity: 0, rotation: 0, duration: 0.55, ease: "power3.in" }, 40.55);
  pop("#k4s", 41.05, { scale: 1.1, y: 0 }); fx(41.05, "interface/bong_001.ogg", 0.25);
  to("#g4a", { opacity: 0, y: -20, duration: 0.4 }, 42.3);
  tw("#g4b", { opacity: 0 }, { opacity: 1, duration: 0.5 }, 42.55);
}

// 5 · 03 draft night (the bid ticks on "live auction")
{
  const bids = [["$800", "—", C.dim], ["$1,200", "PATIENCE", "#9d6bff"], ["$1,400", "DOOM", "#ff8a3d"], ["$1,600", "MISFITS", "#ff4655"]];
  const bt = [46.9, 51.65, 52.35, 53.05];
  const live = `<div class="lv" data-layout-allow-overlap style="left:945px;top:742px;width:160px;height:50px">${bids.map(([v], i) => `<span id="bv${i}" class="lvv">${v}</span>`).join("")}</div><div class="lv nm" data-layout-allow-overlap style="left:1128px;top:750px;width:108px;height:30px">${bids.map(([, n, c], i) => `<span id="bn${i}" class="lvn" style="color:${c}">${esc(n)}</span>`).join("")}</div>`;
  scene(46.9, 10.65, panel("c5", "03", "DRAFT NIGHT", [["A LIVE AUCTION", 47.0], ["DRAFT.", 47.5]],
    [["Every captain gets the same <em>$10,000</em>", 50.05], ["Bid on players, one at a time", 51.6], ["Everyone watches the same board, live", 53.95]]) +
    frame("f5", [{ id: "f5a", name: "kami-auction-block", at: 46.9, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 49.8, cx: 1080, cy: 450, w: 1300, dur: 1.2 }, { at: 54.0, cx: 960, cy: 540, w: 1920, dur: 1.2 }], live }], { label: "KAMI LABS · LIVE AUCTION", live: true }) +
    card("p5", "kami-dashboard", [1340, 795, 483, 273], { x: 740, y: 600, w: 380, cls: "float" }));
  bids.forEach((_, i) => {
    if (i) { tw(`#bv${i}`, { opacity: 0, scale: 1.3 }, { opacity: 1, scale: 1, duration: 0.25, ease: "back.out(2)" }, bt[i]); tw(`#bn${i}`, { opacity: 0 }, { opacity: 1, duration: 0.15 }, bt[i]); fx(bt[i], `casino/chips-stack-${i}.ogg`, 0.35); }
    if (bids[i + 1]) { to(`#bv${i}`, { opacity: 0, duration: 0.06 }, bt[i + 1]); to(`#bn${i}`, { opacity: 0, duration: 0.06 }, bt[i + 1]); }
  });
  tw("#p5", { opacity: 0, y: 30, rotation: -3 }, { opacity: 1, y: 0, rotation: -2, duration: 0.5, ease: "power3.out" }, 50.0); fx(50.0, "casino/card-slide-1.ogg", 0.28);
  to("#p5", { opacity: 0, y: 20, duration: 0.35 }, 53.7);
  tw("#f5-live", { opacity: 0.35 }, { opacity: 1, duration: 0.5, repeat: 3, yoyo: true, ease: "sine.inOut" }, 54.0);
}

// 6 · 04 scouting
scene(57.45, 7.6, panel("c6", "04", "SCOUTING", [["SCOUT EVERY", 57.55], ["PLAYER BEFORE", 57.8], ["YOU SPEND.", 58.1]],
  [["Rank", 61.0], ["Agents", 61.72], ["Stats", 62.5], ["Performance radar", 63.55]]) +
  frame("f6", [{ id: "f6a", name: "kami-scout-modal", at: 57.45, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 58.6, cx: 960, cy: 540, w: 1500, dur: 1.3 }],
    callouts: [{ at: 61.0, rect: [643, 422, 168, 25], tag: "RANK", below: true }, { at: 61.72, rect: [1197, 523, 190, 40], tag: "AGENT", below: true }, { at: 62.5, rect: [531, 525, 393, 67], tag: "STATS", below: true, color: C.green }, { at: 63.55, rect: [1056, 206, 274, 250], tag: "RADAR", color: C.gold }] }], { label: "KAMI LABS · SCOUT FILE" }));

// 7 · 05 teams land in Discord (VOLT's real DM text, MISFITS' real squad)
{
  const roles = [["MISFITS", "#ff4655"], ["CHAOS", "#00e5ff"], ["PATIENCE", "#9d6bff"], ["VANGUARD", "#5ad1ff"], ["DOOM", "#ff8a3d"], ["IN&OUT", "#3ddc84"]];
  const lines = [`<p><strong>You're on MISFITS</strong> for this weekend.</p>`, `<p>Captain: Yona</p>`, `<p class="gap">Your squad:</p>`, `<p>limonataa</p>`, `<p>aliya</p>`, `<p>Hakuna Matata</p>`, `<p>Kamijeee</p>`, `<p class="gap">Use <code>/roster</code> any time to see this again.</p>`];
  scene(65.05, 7.1, panel("c7", "05", "TEAMS", [["TEAMS LAND IN", 65.15], ["YOUR DISCORD.", 65.6]],
    [["Every player gets their team by DM", 66.35], ["Team roles set up in your server", 69.3]]) +
    `<div class="dc" id="dc"><div class="dc-top"># Direct Messages</div><div class="dc-msg"><div class="dc-av">${logo("lgd", 44)}</div><div class="dc-body"><div class="dc-name">VOLT <span class="app">APP</span></div>${lines.map((l, i) => l.replace("<p", `<p id="dl${i}"`)).join("")}</div></div></div>
    <div class="roles" id="rl"><div class="roles-h">SERVER ROLES</div><div class="roles-c">${roles.map(([n, c], i) => `<span class="role" id="ro${i}" style="color:${c};border-color:${c}66;background:${c}14"><i style="background:${c}"></i>@${esc(n)}</span>`).join("")}</div></div>`);
  pop("#dc", 66.3, { y: 24, d: 0.5 }); fx(66.35, "interface/bong_001.ogg", 0.28);
  lines.forEach((_, i) => pop(`#dl${i}`, 66.5 + i * 0.16, { y: 6, d: 0.3 }));
  pop("#rl", 69.25);
  roles.forEach((_, i) => { pop(`#ro${i}`, 69.45 + i * 0.14, { scale: 0.8, y: 0, d: 0.3 }); fx(69.45 + i * 0.14, "ui/click2.ogg", 0.16); });
}

// 8 · 06 tournament: groups → playoffs → final, a scoreboard read, the leaderboard
{
  const tk = (t) => `<span class="step" id="st${t}">`;
  scene(72.1, 14.5, panel("c8", "06", "TOURNAMENT", [["THE TOURNAMENT", 72.2], ["RUNS ITSELF.", 72.65]],
    [[`${tk(0)}Groups</span> → ${tk(1)}Playoffs</span> → ${tk(2)}Grand final</span>`, 73.55], ["Upload the scoreboard: VOLT reads it", 77.35], ["The bracket and leaderboard update", 82.65]]) +
    frame("f8", [
      { id: "f8a", name: "kami-match-modal", at: 72.1, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 72.9, cx: 1130, cy: 540, w: 1600, dur: 1.4 }] },
      { id: "f8b", name: "kami-playoffs", at: 74.85, cams: [{ cx: 1080, cy: 560, w: 1700 }] },
      { id: "f8c", name: "kami-playoffs-final", at: 76.0, cams: [{ cx: 1080, cy: 600, w: 1600 }],
        callouts: [{ at: 81.9, rect: [366, 486, 713, 110], tag: "RESULT IN", d: 2.6 }, { at: 82.7, rect: [765, 700, 635, 130], tag: "BRACKET UPDATED", below: true, color: C.green, d: 1.8 }] },
      { id: "f8d", name: "kami-leaderboard", at: 84.6, cams: [{ cx: 1083, cy: 500, w: 1500 }], callouts: [{ at: 85.1, rect: [1100, 594, 72, 26], tag: "LEADERBOARD", color: C.gold }] },
    ], { label: "KAMI LABS · FIXTURES" }) +
    `<div class="sb" id="sb"><b>scoreboard_screenshot.png</b>${Array.from({ length: 10 }, (_, i) => `<div class="sb-r${i < 5 ? " a" : " d"}"><i style="width:${40 + ((i * 37) % 45)}%"></i><span></span><span></span><span></span></div>`).join("")}<div class="scan" id="scan"></div></div>
    <div class="toast t8" id="t8"><b>✓</b>Scores read from the screenshot</div>`);
  [73.55, 74.25, 75.45].forEach((t, i) => tw(`#st${i}`, { color: "rgba(205,218,255,0.45)" }, { color: C.hi, duration: 0.3 }, t + (i ? 0 : 0.6)));
  tw("#sb", { opacity: 0, x: 260, rotation: 10 }, { opacity: 1, x: 0, rotation: 4, duration: 0.6, ease: "power3.out" }, 77.4); fx(77.4, "casino/card-slide-1.ogg", 0.3);
  tw("#scan", { y: 0, opacity: 0 }, { keyframes: { y: [0, 330], opacity: [1, 1, 0] }, duration: 0.9, ease: "none" }, 80.3);
  to("#sb", { opacity: 0, x: -200, y: -120, scale: 0.4, rotation: 0, duration: 0.5, ease: "power3.in" }, 81.3);
  pop("#t8", 81.2, { y: 14 }); to("#t8", { opacity: 0, duration: 0.3 }, 84.4); fx(81.2, "interface/bong_001.ogg", 0.28);
}

// 9 · 07 community
scene(86.55, 5.8, panel("c9", "07", "COMMUNITY", [["YOUR WHOLE", 86.65], ["SERVER PLAYS", 86.9], ["ALONG.", 87.15]],
  [["Predict every match", 87.55], ["Climb the season standings", 89.4]]) +
  frame("f9", [
    { id: "f9a", name: "kami-final-modal", at: 86.55, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 87.2, cx: 960, cy: 540, w: 1450, dur: 1.2 }], callouts: [{ at: 88.0, rect: [679, 610, 562, 45], tag: "4 OF 4 VOTES · PATIENCE", color: "#ff7a45", d: 1.15 }] },
    { id: "f9b", name: "kami-league-page", at: 89.3, cams: [{ cx: 1300, cy: 560, w: 1100 }], callouts: [{ at: 89.95, rect: [1183, 497, 350, 40], tag: "NIA · 588 PTS · #1", color: C.gold, below: true }] },
  ], { label: "KAMI LABS" }));

// 10 · what you actually get
{
  const cards = [
    ["HOSTS", "HOURS OF ADMIN, GONE.", "Run a league that looks professional.", "kami-league-page", [367, 104, 1186, 569], 93.75],
    ["PLAYERS", "DRAFTED ONTO A REAL TEAM.", "No squad needed. Just sign up.", "kami-rosters", [343, 233, 714, 343], 98.3],
    ["COMMUNITY", "A SEASON WORTH FOLLOWING.", "Predictions, standings and a champion.", "kami-leaderboard", [790, 357, 590, 283], 102.65],
  ];
  scene(92.35, 14.05, `<div class="vq" id="vq">SO WHAT DO YOU <span class="b">ACTUALLY GET?</span></div><div class="vals">${cards.map(([k, t, s, n, rect], i) =>
    `<div class="val" id="v${i}">${card(`v${i}i`, n, rect, { x: 0, y: 0, w: 500, cls: "thumb" })}<div class="vk">${k}</div><div class="vt">${esc(t)}</div><div class="vs">${esc(s)}</div></div>`).join("")}</div>`);
  pop("#vq", 92.45, { y: 24, d: 0.55 }); fx(92.45, "impact/impactSoft_medium_003.ogg", 0.3);
  cards.forEach(([, , , , , t], i) => { tw(`#v${i}`, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.6, ease: "power3.out" }, t); fx(t, "casino/card-slide-1.ogg", 0.26); });
}

// 11 · proof: Kami Labs
{
  const stats = [[24, "PLAYERS", 110.6], [6, "TEAMS", 111.95], [1, "CHAMPION", 113.15]];
  scene(106.4, 7.95, `<div class="proof-h" id="ph">KAMI LABS RAN THEIR WHOLE TOURNAMENT ON <span class="b">VOLT.</span></div>` +
    frame("f11", [{ id: "f11a", name: "kami-fixtures-champion", at: 106.4, cams: [{ cx: 960, cy: 540, w: 1920 }, { at: 107.2, cx: 1083, cy: 470, w: 1450, dur: 1.6 }] }], { x: 480, y: 175, w: 960, label: "KAMI LABS · CHAMPIONS" }) +
    `<div class="stats">${stats.map(([n, l], i) => `<div class="stat" id="s${i}"><b id="s${i}n">0</b><span>${l}</span></div>`).join("")}</div>`);
  pop("#ph", 106.5, { y: 20, d: 0.55 });
  stats.forEach(([n, , t], i) => {
    pop(`#s${i}`, t - 0.1, { y: 20 }); fx(t, "interface/bong_001.ogg", 0.26);
    js.push(`(function(){const el=document.getElementById("s${i}n");const o={v:0};tl.fromTo(o,{v:0},{v:${n},duration:${n > 1 ? 0.6 : 0.2},ease:"power2.out",immediateRender:false,onUpdate:()=>{el.textContent=Math.round(o.v);}},${t});})();`);
  });
}

// 12 · VOLT. Start your league.
scene(114.25, D - 114.25, `<div class="end"><div class="logo-e">${logo("lge", 760)}</div><div class="hl c big2" id="e1">START YOUR LEAGUE.</div><div class="feat" id="e2">SIGN-UPS · LIVE AUCTION DRAFT · AUTO BRACKETS · DISCORD</div></div>`, { fadeOut: 0 });
sting("lge", 114.3); fx(114.75, "impact/impactBell_heavy_003.ogg", 0.3);
pop("#e1", 115.6, { y: 24, d: 0.6 }); pop("#e2", 116.5, { y: 10, d: 0.6 });
tw("#fade", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "power1.in" }, D - 0.75);
tw("#glow", { x: -120, y: -40 }, { x: 160, y: 60, duration: D, ease: "sine.inOut" }, 0);

// ── audio
const music = "happy-beats-business-moves-vol-1-by-ende-dot-app.mp3";
const audio = [
  `<audio id="vo" src="assets/vo.wav" data-start="${VO}" data-track-index="20" data-volume="1"></audio>`,
  `<audio id="music" src="assets/music/${music}" data-start="0" data-duration="${D}" data-track-index="21" data-volume="1" data-automation='${J({ version: 1, lanes: [{ target: "volume", points: [{ t: 0, v: 0 }, { t: 1.5, v: 0.13 }, { t: 92.2, v: 0.13 }, { t: 92.8, v: 0.16 }, { t: 113.5, v: 0.16 }, { t: 114.6, v: 0.24 }, { t: 117.4, v: 0.24 }, { t: D, v: 0 }] }] })}'></audio>`,
  ...(() => { const free = []; return sfx.sort((a, b) => a.t - b.t).map((s, i) => {
    let lane = free.findIndex((end) => end <= s.t); if (lane < 0) lane = free.push(0) - 1; free[lane] = s.t + 1.6;
    return `<audio id="fx${i}" src="assets/sfx/${s.file}" data-start="${s.t}" data-duration="1.5" data-track-index="${22 + lane}" data-volume="${s.vol}"></audio>`; }); })(),
];

const css = `${fs.readFileSync(path.join(OUT, "assets", "fonts", "fonts.css"), "utf8")}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:${C.navy}}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:${C.navy};color:${C.ink};font-family:"Space Grotesk",sans-serif;-webkit-font-smoothing:antialiased}
.clip{position:absolute;inset:0}
.sc{position:absolute;inset:0}
#bg{position:absolute;inset:0;overflow:hidden}
#glow{position:absolute;width:1700px;height:1700px;left:-420px;top:-820px;background:radial-gradient(circle closest-side,rgba(61,123,255,0.22),rgba(61,123,255,0.06) 55%,rgba(61,123,255,0))}
#grid{position:absolute;inset:0;background-image:linear-gradient(rgba(120,150,220,0.06) 1px,transparent 1px),linear-gradient(90deg,rgba(120,150,220,0.06) 1px,transparent 1px);background-size:80px 80px;-webkit-mask-image:radial-gradient(ellipse 80% 70% at 50% 40%,#000 30%,transparent 85%);mask-image:radial-gradient(ellipse 80% 70% at 50% 40%,#000 30%,transparent 85%)}
#vig{position:absolute;inset:0;background:radial-gradient(ellipse 90% 80% at 50% 45%,transparent 55%,rgba(0,0,0,0.55))}
#fade{position:absolute;inset:0;background:#000;opacity:0}
.b{color:${C.blue}}
.red{color:${C.red}}
.big{position:absolute;left:0;right:0;top:420px;text-align:center;font-family:"Big Shoulders Display";font-weight:900;font-size:170px;line-height:.9;letter-spacing:.005em;text-shadow:0 10px 40px rgba(0,0,0,.6)}
.mid{position:absolute;inset:0}
.wall{position:absolute;left:-300px;top:-260px;width:2700px;height:1500px}
.tile{position:absolute;width:600px;height:338px;border-radius:12px;overflow:hidden;box-shadow:0 20px 40px rgba(0,0,0,.5)}
.tile img{width:100%;height:100%;object-fit:cover}
.wall-shade{position:absolute;inset:0;background:radial-gradient(ellipse 70% 60% at 50% 48%,rgba(10,13,24,.86),rgba(10,13,24,.55))}
.logo-c{position:absolute;left:600px;top:396px;width:720px;height:275px}
.mid1{position:absolute;left:0;right:0;top:330px}
.hl{font-family:"Big Shoulders Display";font-weight:900;font-size:92px;line-height:1.04;letter-spacing:.005em;text-transform:uppercase;white-space:nowrap}
.hl.c{text-align:center}
.for{margin-top:44px;text-align:center;font-family:"IBM Plex Mono";font-weight:600;font-size:22px;letter-spacing:.32em;color:${C.hi}}
.chips{margin-top:18px;display:flex;justify-content:center;gap:18px}
.chip{display:block;padding:14px 26px;border:2px solid rgba(61,123,255,.55);background:rgba(61,123,255,.12);border-radius:10px;font-size:36px;font-weight:500}
.line{margin-top:56px;text-align:center;font-size:38px;color:${C.dim}}
.nos{color:${C.ink}}
.line s{text-decoration:none;position:relative;display:inline-block;--strike:0}
.line s::after{content:"";position:absolute;left:-4px;right:-4px;top:54%;height:5px;background:${C.red};transform:scaleX(var(--strike));transform-origin:0 50%}
.lp{position:absolute;left:110px;top:230px;width:640px}
.chap{display:flex;align-items:center;gap:16px;margin-bottom:26px}
.chn{font-family:"Big Shoulders Display";font-weight:900;font-size:64px;line-height:1;color:rgba(61,123,255,.28);-webkit-text-stroke:2px rgba(125,166,255,.8)}
.chl{font-family:"IBM Plex Mono";font-weight:600;font-size:22px;letter-spacing:.3em;color:${C.hi}}
.bls{margin-top:42px;display:flex;flex-direction:column;gap:22px}
.bl{display:flex;gap:18px;align-items:flex-start;font-size:31px;line-height:1.25;color:${C.ink}}
.bl i{flex:none;width:22px;height:22px;margin-top:8px;border-radius:5px;background:${C.blue};box-shadow:0 0 14px rgba(61,123,255,.6)}
.bl em{font-style:normal;color:${C.green};font-weight:700}
.step{transition:none}
.rows{margin-top:40px;display:flex;flex-direction:column;gap:26px}
.row{display:flex;gap:18px;align-items:center;font-size:40px}
.row i{width:16px;height:16px;border-radius:50%;background:${C.red};flex:none}
.row span{position:relative;display:block}
.row s{position:absolute;left:-6px;right:-6px;top:52%;height:4px;background:${C.red};transform-origin:0 50%}
.pile{position:absolute;left:1040px;top:220px;width:760px;height:640px}
.mess{position:absolute;left:0;top:0;width:360px;padding:18px 20px;border-radius:12px;background:#151b2e;border:1px solid rgba(255,255,255,.08);box-shadow:0 24px 40px rgba(0,0,0,.55);font-size:20px;color:#c9d3ea}
.mess b{display:block;font-family:"IBM Plex Mono";font-weight:600;font-size:16px;letter-spacing:.12em;color:#8c9abd;margin-bottom:10px;text-transform:uppercase}
.mess p{margin-top:6px}
.bub{display:block;width:fit-content;padding:8px 14px;border-radius:14px;background:#252d46}
.bub.me{margin-left:auto;background:#2f4fa8;color:#fff}
.sheet .tr{display:grid;grid-template-columns:1.3fr 1fr 1fr;border-bottom:1px solid rgba(255,255,255,.08);padding:5px 0;font-family:"IBM Plex Mono";font-size:16px}
.sheet .th{color:#8c9abd}
.vc p{font-style:italic;line-height:1.35}
.verdict{position:absolute;left:1040px;top:420px;width:760px;text-align:center;font-family:"Big Shoulders Display";font-weight:900;font-size:96px;line-height:1.08}
.frame{position:absolute;border-radius:14px;overflow:hidden;background:${C.panel};box-shadow:0 40px 80px rgba(0,0,0,.6),0 0 0 1px rgba(125,166,255,.18),0 0 60px rgba(61,123,255,.12)}
.bar{height:${F.bar}px;display:flex;align-items:center;gap:9px;padding:0 16px;background:#0f1528;border-bottom:1px solid rgba(125,166,255,.12)}
.bar i{width:12px;height:12px;border-radius:50%;background:rgba(205,218,255,.18)}
.url{margin-left:14px;font-family:"IBM Plex Mono";font-weight:500;font-size:16px;letter-spacing:.14em;color:rgba(205,218,255,.6)}
.url em{font-style:normal;color:${C.hi}}
.live{margin-left:auto;font-family:"IBM Plex Mono";font-weight:600;font-size:16px;letter-spacing:.18em;color:${C.red}}
.vp{position:relative;overflow:hidden}
.shot{position:absolute;inset:0}
.cam{position:absolute;left:0;top:0;width:${SW}px;height:${SH}px}
.cam img{position:absolute;left:0;top:0;width:${SW}px;height:${SH}px}
.co{position:absolute;border-style:solid;border-radius:6px}
.co b{position:absolute;left:-3px;font-family:"IBM Plex Mono";font-weight:600;letter-spacing:.08em;color:#06101f;white-space:nowrap;border-radius:4px}
.lv{position:absolute;background:#0d1326;display:flex;align-items:center}
.lv span{position:absolute;left:0;top:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.lvv{font-family:"IBM Plex Mono";font-weight:600;font-size:34px;color:#5b8dff}
.lv.nm{background:#0d1326}
.lvn{font-family:"Big Shoulders Display";font-weight:800;font-size:21px;letter-spacing:.06em}
.toast{position:absolute;left:840px;top:760px;display:flex;align-items:center;gap:14px;padding:16px 24px;border-radius:12px;background:#121a33;border:1px solid rgba(61,123,255,.45);box-shadow:0 20px 40px rgba(0,0,0,.5);font-size:28px;font-weight:500}
.toast b{font-size:28px}
.t8{left:860px;top:745px;border-color:rgba(61,220,132,.5)}
.t8 b{color:${C.green}}
.card{position:absolute;border-radius:14px;overflow:hidden;box-shadow:0 30px 60px rgba(0,0,0,.6),0 0 0 1px rgba(125,166,255,.18)}
.card .crop{position:absolute;inset:0;overflow:hidden}
.card .crop img{position:absolute;max-width:none}
.grpA,.grpB{position:absolute;inset:0}
.ring{position:absolute;border:3px solid ${C.blue};border-radius:8px;box-shadow:0 0 22px rgba(61,123,255,.55);background:rgba(61,123,255,.08)}
.ring b{position:absolute;left:-3px;bottom:calc(100% + 8px);padding:4px 12px;border-radius:4px;background:${C.blue};color:#06101f;font-family:"IBM Plex Mono";font-weight:600;font-size:18px;letter-spacing:.08em;white-space:nowrap}
.ring.rt b{left:calc(100% + 12px);bottom:auto;top:50%;margin-top:-16px}
.ring.g{border-color:${C.green};box-shadow:0 0 22px rgba(61,220,132,.5);background:rgba(61,220,132,.08)}
.ring.g b{background:${C.green};top:calc(100% + 8px);bottom:auto}
.tracker{position:absolute;left:1360px;top:640px;width:380px;padding:20px 22px;border-radius:12px;background:#141414;border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 50px rgba(0,0,0,.6);font-family:"Space Grotesk";color:#ddd}
.tracker b{display:block;font-family:"IBM Plex Mono";font-weight:500;font-size:15px;color:#9aa;margin-bottom:12px}
.tk-h{font-size:15px;letter-spacing:.14em;color:#ff6b6b;font-weight:700;margin-bottom:10px}
.tk-r{display:flex;justify-content:space-between;font-size:24px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.06)}
.tk-r em{font-style:normal;font-weight:700;color:#fff}
.tk-bars{margin-top:12px;display:flex;flex-direction:column;gap:6px}
.tk-bars i{display:block;height:6px;border-radius:3px;background:linear-gradient(90deg,#ff6b6b,#ffb36b)}
.float{z-index:4}
.dc{position:absolute;left:840px;top:220px;width:960px;border-radius:14px;overflow:hidden;background:#313338;box-shadow:0 40px 80px rgba(0,0,0,.6);font-family:"Space Grotesk"}
.dc-top{padding:16px 24px;background:#2b2d31;color:#b5bac1;font-size:20px;font-weight:700;border-bottom:1px solid rgba(0,0,0,.3)}
.dc-msg{display:flex;gap:20px;padding:24px 28px 28px}
.dc-av{flex:none;width:64px;height:64px;border-radius:50%;background:#0a0d18;display:flex;align-items:center;justify-content:center;overflow:hidden}
.dc-av svg{width:52px;height:auto}
.dc-name{font-size:24px;font-weight:700;color:#fff;margin-bottom:8px;display:flex;align-items:center;gap:10px}
.app{font-size:13px;padding:2px 6px;border-radius:4px;background:#5865f2;color:#fff;letter-spacing:.04em}
.dc-body p{font-size:24px;line-height:1.38;color:#dbdee1}
.dc-body p.gap{margin-top:16px}
.dc-body strong{color:#fff}
.dc-body code{font-family:"IBM Plex Mono";font-size:21px;background:#1e1f22;padding:2px 6px;border-radius:4px}
.roles{position:absolute;left:840px;top:760px;width:960px}
.roles-h{font-family:"IBM Plex Mono";font-weight:600;font-size:18px;letter-spacing:.3em;color:${C.hi};margin-bottom:14px}
.roles-c{display:flex;gap:12px;flex-wrap:nowrap}
.role{display:flex;align-items:center;gap:8px;padding:8px 14px;border:2px solid;border-radius:999px;font-weight:700;font-size:21px;white-space:nowrap}
.role i{width:10px;height:10px;border-radius:50%}
.sb{position:absolute;left:1350px;top:450px;width:420px;padding:18px;border-radius:12px;background:#10141f;border:1px solid rgba(255,255,255,.12);box-shadow:0 30px 60px rgba(0,0,0,.65);overflow:hidden;z-index:5}
.sb b{display:block;font-family:"IBM Plex Mono";font-weight:500;font-size:15px;color:#9aa;margin-bottom:10px}
.sb-r{display:grid;grid-template-columns:1fr 40px 40px 40px;gap:8px;align-items:center;height:26px;padding:0 8px;margin-bottom:4px;border-radius:4px}
.sb-r.a{background:rgba(61,220,132,.12)}
.sb-r.d{background:rgba(255,70,85,.12)}
.sb-r i{display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.35)}
.sb-r span{display:block;height:8px;border-radius:4px;background:rgba(255,255,255,.2)}
.scan{position:absolute;left:0;right:0;top:40px;height:4px;background:${C.green};box-shadow:0 0 18px ${C.green}}
.rail{position:absolute;right:80px;top:56px;display:flex;gap:30px}
.ri{position:relative;font-family:"IBM Plex Mono";font-weight:600;font-size:16px;letter-spacing:.14em;color:${C.ink};opacity:.38}
.ri span{color:${C.hi};margin-right:8px}
.ri i{position:absolute;left:0;right:0;bottom:-10px;height:3px;background:${C.blue};transform-origin:0 50%}
.hdr-logo{position:absolute;left:80px;top:44px;width:132px;height:51px}
.vq{position:absolute;left:0;right:0;top:110px;text-align:center;font-family:"Big Shoulders Display";font-weight:900;font-size:96px;line-height:1}
.vals{position:absolute;left:150px;right:150px;top:300px;display:flex;gap:60px}
.val{position:relative;flex:1;height:600px;border-radius:16px;background:#101830;border:1px solid rgba(125,166,255,.18);box-shadow:0 30px 60px rgba(0,0,0,.45);overflow:hidden}
.val .card{position:relative;border-radius:0;box-shadow:none;width:100%!important}
.thumb{left:0!important;top:0!important}
.vk{margin:30px 34px 0;font-family:"IBM Plex Mono";font-weight:600;font-size:20px;letter-spacing:.3em;color:${C.hi}}
.vt{margin:14px 34px 0;font-family:"Big Shoulders Display";font-weight:900;font-size:56px;line-height:.95}
.vs{margin:16px 34px 0;font-size:27px;line-height:1.3;color:${C.dim}}
.proof-h{position:absolute;left:0;right:0;top:80px;text-align:center;font-family:"Big Shoulders Display";font-weight:900;font-size:62px;line-height:1}
.stats{position:absolute;left:0;right:0;top:785px;display:flex;justify-content:center;gap:140px}
.stat{text-align:center}
.stat b{display:block;font-family:"Big Shoulders Display";font-weight:900;font-size:150px;line-height:.9;color:${C.ink}}
.stat span{display:block;margin-top:8px;font-family:"IBM Plex Mono";font-weight:600;font-size:22px;letter-spacing:.3em;color:${C.hi}}
.end{position:absolute;inset:0}
.logo-e{position:absolute;left:580px;top:250px;width:760px;height:290px}
.big2{position:absolute;left:0;right:0;top:620px;font-size:130px}
.feat{position:absolute;left:0;right:0;top:800px;text-align:center;font-family:"IBM Plex Mono";font-weight:600;font-size:24px;letter-spacing:.24em;color:${C.dim}}
`;

const doc = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<script src="assets/gsap.min.js"></script>
<style>${css}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
<div class="clip" id="bgc" data-start="0" data-duration="${D}" data-track-index="0"><div id="bg"><div id="glow"></div><div id="grid"></div><div id="vig"></div></div></div>
${html.join("\n")}
<div class="clip" id="fadec" data-start="0" data-duration="${D}" data-track-index="30"><div id="fade"></div></div>
${audio.join("\n")}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${js.join("\n")}
window.__timelines["main"] = tl;
</script></body></html>
`;

// ── write the project
fs.mkdirSync(path.join(OUT, "assets", "screens"), { recursive: true });
fs.mkdirSync(path.join(OUT, "assets", "music"), { recursive: true });
for (const [out, make] of assets) if (!fs.existsSync(out)) make();
const music0 = path.join(OUT, "assets", "music", music);
if (!fs.existsSync(music0)) fs.copyFileSync(path.join(BRAG, "music", music), music0);
for (const s of sfx) {
  const out = path.join(OUT, "assets", "sfx", s.file);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (!fs.existsSync(out)) fs.copyFileSync(path.join(BRAG, "sfx", s.file), out);
}
const vo = path.join(OUT, "assets", "vo.wav");
execFileSync(FF, ["-y", "-loglevel", "error", "-i", path.join(REELS, "vo", "explainer.flac"), "-ar", "48000", "-ac", "2", vo]);
const gsap = path.join(OUT, "assets", "gsap.min.js");
if (!fs.existsSync(gsap)) execFileSync("curl", ["-s", "-o", gsap, "https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"]);
fs.writeFileSync(path.join(OUT, "index.html"), doc);
console.log("wrote", path.join(OUT, "index.html"), sfx.length, "sfx");
