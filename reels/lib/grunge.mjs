// The grunge cut of reel 04 ("volt-scout-grunge"): same voiceover as volt-scout-hub,
// presented as a street poster wall. Big Shoulders slams, Mr Dafoe brush paint-ons,
// taped prints of the real app, and match cuts that carry one shape across a cut:
//   the red slash  -> the VOLT bolt          (0:03, and again at the end)
//   a pool card    -> the same player on the block
//   $10,000        -> the purse it lands in
//   a scope ring   -> the scout board's marker
//   a board card   -> its scout file (flip)
//   the last bid   -> SCOUT. BID. WIN.
// Writes a HyperFrames project like engine.mjs does (index.html, assets/, cues.json).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REELS as ROOT, W, H } from "./engine.mjs";

const SCREENS = path.join(ROOT, "screens"), TEX = path.join(ROOT, "tex"), IMG = path.resolve(ROOT, "../public/img"), CACHE = path.join(ROOT, ".cache");
const FF = process.env.FFMPEG || "ffmpeg";
const SW = 1920, SH = 1080;
const INK = "#ece8e0", RED = "#e8343f", DIM = "rgba(236,232,224,0.72)";
const J = (v) => JSON.stringify(v);
const r = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function webp(src, name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, name);
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs)
    execFileSync(FF, ["-y", "-loglevel", "error", "-i", src, "-c:v", "libwebp", "-quality", "90", "-compression_level", "6", out]);
  return out;
}

// the VOLT mark (same paths as the engine's sting)
const ARM = "M344.811 140.139H0L273.118 552.012L436.988 278.57L344.811 140.139Z";
const BOLT = "M392.606 466.561L689.622 0H1002L303.843 834L549.649 401.619L392.606 466.561Z";
const O_ = "M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z", L_ = "M80 0H89.5V31H105V40H80Z", T_ = "M109 0H146V9.5H132.25V40H122.75V9.5H109Z";

export function grungeScout(spec) {
  const { id, duration: D } = spec;
  const dir = path.join(ROOT, "videos", id);
  if (!fs.existsSync(path.join(TEX, "grunge-wall.png"))) execFileSync(process.execPath, [path.join(ROOT, "lib", "grunge-textures.mjs")], { stdio: "inherit" });
  const html = [], js = [], cues = [], files = new Map();
  let n = 0;
  const uid = (p) => `${p}${++n}`;
  const cue = (t, k, o = {}) => cues.push({ t: r(t), k, ...o });
  const tw = (sel, from, to, at) => js.push(`tl.fromTo(${J(sel)},${J(from)},${J({ ...to, immediateRender: to.immediateRender ?? true })},${r(at)});`);
  const to = (sel, v, at) => js.push(`tl.to(${J(sel)},${J(v)},${r(at)});`);
  const set = (sel, v, at) => js.push(`tl.set(${J(sel)},${J(v)},${r(at)});`);
  const clip = (t0, d, inner, track = 1) => html.push(`<div class="clip" data-start="${r(t0)}" data-duration="${r(d)}" data-track-index="${track}">${inner}</div>`);

  // ── assets
  const shot = (name) => { files.set(`${name}.webp`, () => webp(path.join(SCREENS, name + ".png"), "screen-" + name + ".webp")); return `assets/${name}.webp`; };
  const tex = (name) => { files.set(`${name}.webp`, () => webp(path.join(TEX, name + ".png"), "tex-" + name + ".webp")); return `assets/${name}.webp`; };
  const art = (name) => { files.set(name, () => path.join(IMG, name)); return `assets/${name}`; };

  // ── type
  // Big Shoulders block; each word is its own span (#id-wN) so words can slam on their syllable
  const bs = (idp, words, { x = 70, y, size, color = INK, center = false, op = 1 }) =>
    `<div class="bs" id="${idp}" style="${center ? "left:0;width:1080px;text-align:center" : `left:${x}px`};top:${y}px;font-size:${size}px;color:${color};opacity:${op}">${words.map((w, i) => `<span class="w" id="${idp}-w${i}">${esc(w)}</span>`).join(" ")}</div>`;
  const slam = (sel, at, { from = 1.7, g = 0.42, rot = 0 } = {}) => {
    tw(sel, { opacity: 0, scale: from, rotation: rot }, { opacity: 1, scale: 1, rotation: 0, duration: 0.2, ease: "power4.out" }, at);
    cue(at + 0.02, "thump", { g });
  };
  const slamWords = (idp, times, o) => times.forEach((t, i) => slam(`#${idp}-w${i}`, t, o));
  // Mr Dafoe, painted on left to right through a dry-brush mask
  const br = (idp, text, { x, y, size, color = RED, rot = -7, center = false }) =>
    `<div class="br" id="${idp}" style="${center ? "left:0;width:1080px;text-align:center" : `left:${x}px`};top:${y}px;font-size:${size}px;color:${color};transform:rotate(${rot}deg)">${esc(text)}</div>`;
  const paint = (sel, at, d = 0.45, g = 0.55) => {
    tw(sel, { clipPath: "inset(-50% 100% -50% -10%)" }, { clipPath: "inset(-50% -10% -50% -10%)", duration: d, ease: "power2.inOut" }, at);
    cue(at, "scrape", { d: d + 0.1, g });
  };
  const te = (idp, text, { y, size = 40, color = DIM, ls = 0.25, center = true, x = 0 }) =>
    `<div class="te" id="${idp}" style="${center ? "left:0;width:1080px;text-align:center" : `left:${x}px`};top:${y}px;font-size:${size}px;color:${color};letter-spacing:${ls}em">${esc(text)}</div>`;
  const fadeIn = (sel, at, d = 0.3) => tw(sel, { opacity: 0 }, { opacity: 1, duration: d, ease: "power2.out" }, at);

  // ── prints of the app, taped or pinned to the wall
  const print = (idp, name, rect, { cx, cy, w, tape = true, pin = false, z = 1 }) => {
    const [rx, ry, rw, rh] = rect, S = w / rw, hh = rh * S;
    const tapes = tape ? `<i class="tape" style="left:-34px;top:-14px;transform:rotate(-32deg)"></i><i class="tape" style="right:-34px;top:-14px;transform:rotate(30deg)"></i>` : "";
    const pins = pin ? `<i class="pin" style="left:${w / 2 - 16}px;top:-12px"></i>` : "";
    return { w, h: hh, cx, cy, html: `<div class="print" id="${idp}" style="left:${cx - w / 2}px;top:${cy - hh / 2}px;width:${w}px;height:${hh}px;z-index:${z}"><div class="crop"><img src="${shot(name)}" style="width:${SW * S}px;height:${SH * S}px;left:${-rx * S}px;top:${-ry * S}px"></div><div class="print-wear"></div>${tapes}${pins}</div>` };
  };
  const slap = (sel, at, rot = 0, g = 0.5) => {
    tw(sel, { opacity: 0, scale: 1.32, rotation: rot + 8, y: -30 }, { opacity: 1, scale: 1, rotation: rot, y: 0, duration: 0.26, ease: "power4.out" }, at);
    cue(at + 0.04, "slap", { g });
  };
  // torn poster of key art (greyscale, a red wash, a ragged bottom edge)
  const poster = (idp, img, { x, y, w, h, pos = "50% 30%" }) => {
    const teeth = Array.from({ length: 23 }, (_, i) => `${(i / 22) * 100}% ${100 - (i % 2 ? 0 : 3.5) - ((i * 37) % 5) * 0.6}%`).join(",");
    return `<div class="poster" id="${idp}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px"><div class="poster-in" style="clip-path:polygon(0 1.5%,30% 0,62% 1.2%,100% 0,${teeth.split(",").reverse().join(",")})"><img src="${art(img)}" style="object-position:${pos}"><i class="poster-wash"></i><div class="print-wear"></div></div><i class="tape" style="left:42%;top:-18px;transform:rotate(-4deg)"></i></div>`;
  };

  // ── hand-drawn marks (SVG strokes drawn on with stroke-dashoffset)
  const marks = (inner, cls = "") => `<svg class="ov ${cls}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${inner}</svg>`;
  const pathEl = (idp, d, { w = 9, color = RED, op = 1, filt = "rough" } = {}) =>
    `<path id="${idp}" d="${d}" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" opacity="${op}" filter="url(#${filt})"/>`;
  const draw = (sel, at, d = 0.3, g = 0.4) => { tw(sel, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: d, ease: "power2.inOut" }, at); cue(at, "scrape", { d: d + 0.05, g }); };
  // a marker loop around something: a bit more than one turn, wobbling
  const loop = (cx, cy, rx, ry, { rot = -5, turns = 1.12, seed = 1 } = {}) => {
    const N = 64, a0 = -2.2 + seed, k = (rot * Math.PI) / 180, pts = [];
    for (let i = 0; i <= N; i++) {
      const a = a0 + (turns * 2 * Math.PI * i) / N, w = 1 + 0.035 * Math.sin(3 * a + seed) + 0.06 * (i / N);
      const x = rx * w * Math.cos(a), y = ry * w * Math.sin(a);
      pts.push(`${r(cx + x * Math.cos(k) - y * Math.sin(k))} ${r(cy + x * Math.sin(k) + y * Math.cos(k))}`);
    }
    return "M" + pts.join(" L");
  };
  const check = (x, y, s = 1) => `M${x} ${y} l${22 * s} ${26 * s} l${46 * s} ${-62 * s}`;

  // camera helpers: every beat is clip > .cam (push / whip) > .shk (shake) > content
  const beat = (idp, t0, d, inner, track = 1) => clip(t0, d, `<div class="cam" id="${idp}"><div class="shk" id="${idp}-s">${inner}</div></div>`, track);
  const shake = (idp, at, a = 16) => tw(`#${idp}-s`, { x: 0, y: 0 }, { keyframes: { x: [0, -a, a * 0.8, -a * 0.5, a * 0.3, 0], y: [0, a * 0.6, -a * 0.5, a * 0.3, -a * 0.15, 0] }, duration: 0.34, ease: "none", immediateRender: false }, at);
  const push = (idp, t0, d, s = 1.05, origin = "50% 50%") => tw(`#${idp}`, { scale: 1, transformOrigin: origin }, { scale: s, duration: d, ease: "none" }, t0);
  const flash = (at, peak = 0.5) => tw("#flash", { opacity: 0 }, { keyframes: { opacity: [0, peak, 0] }, duration: 0.14, ease: "none", immediateRender: false }, at);

  // the mark: a red brush slash that becomes the bolt, then the logo settles
  // (bolt centre lands at BX,BY; the slash starts 3x bigger at the frame centre)
  const LX = 155, LY = 600, LS = 0.7, BIG = 3;
  const BX = LX + 329 * LS, BY = LY + 210 * LS;
  const logoBeat = (idp, t0, d, slashAt, cutAt, extra = "") => {
    const svg = `<svg class="ov" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}"><defs>
      <linearGradient id="${idp}-gb" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8db3ff"/><stop offset="0.55" stop-color="#3d7bff"/><stop offset="1" stop-color="#1f47c9"/></linearGradient>
      <mask id="${idp}-m" maskUnits="userSpaceOnUse" x="-600" y="-600" width="2400" height="2200"><path id="${idp}-mp" d="M200 990 L1100 -150" stroke="#fff" stroke-width="560" pathLength="1" stroke-dasharray="1 1" stroke-dashoffset="1" fill="none"/></mask></defs>
      <g id="${idp}-z"><g transform="translate(${LX} ${LY}) scale(${LS})">
        <g transform="scale(0.5036)"><path id="${idp}-arm" d="${ARM}" fill="${INK}" opacity="0"/>
          <g mask="url(#${idp}-m)"><path id="${idp}-br" d="${BOLT}" fill="${RED}" filter="url(#roughB)"/><path id="${idp}-bb" d="${BOLT}" fill="url(#${idp}-gb)" opacity="0"/></g></g>
        <g transform="translate(205 90) scale(6)" fill="${INK}"><path id="${idp}-o" fill-rule="evenodd" d="${O_}" opacity="0"/><path id="${idp}-l" d="${L_}" opacity="0"/><path id="${idp}-t" d="${T_}" opacity="0"/></g>
      </g></g></svg>`;
    clip(t0, d, `<div class="cam" id="${idp}"><div class="erode-all">${svg}</div>${extra}</div>`, 3);
    tw(`#${idp}-z`, { scale: BIG, x: 540 - BX, y: 980 - BY, svgOrigin: `${BX} ${BY}` }, { scale: BIG, x: 540 - BX, y: 980 - BY, duration: 0.01 }, t0);
    tw(`#${idp}-mp`, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.3, ease: "power1.inOut" }, slashAt);
    cue(slashAt, "scrape", { d: 0.4, g: 0.8 }); cue(slashAt - 0.1, "whoosh", { d: 0.5, g: 0.5 });
    // the cut: red brush -> blue bolt, and the camera pulls back to the mark
    to(`#${idp}-br`, { opacity: 0, duration: 0.16 }, cutAt);
    to(`#${idp}-bb`, { opacity: 1, duration: 0.16 }, cutAt);
    to(`#${idp}-z`, { scale: 1, x: 0, y: 0, duration: 0.45, ease: "expo.inOut" }, cutAt);
    tw(`#${idp}-arm`, { opacity: 0, x: -240 }, { opacity: 1, x: 0, duration: 0.4, ease: "expo.out" }, cutAt + 0.25);
    ["o", "l", "t"].forEach((c, i) => tw(`#${idp}-${c}`, { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.35, ease: "power4.out" }, cutAt + 0.3 + i * 0.06));
    cue(cutAt + 0.28, "boom", { g: 0.9 }); cue(cutAt + 0.3, "chime", { p: 0, g: 0.45, chord: true });
    flash(cutAt, 0.35);
  };

  // ════════════════════════════════════════════════════════════════════
  // 1 · "This is how Valorant communities run their own leagues."
  beat("b1", 0, 3.32, [
    bs("b1a", ["THIS", "IS", "HOW"], { y: 640, size: 96, color: DIM }),
    bs("b1b", ["VALORANT"], { x: 64, y: 730, size: 250 }),
    bs("b1c", ["COMMUNITIES"], { x: 66, y: 950, size: 182 }),
    br("b1d", "run their own", { x: 130, y: 1112, size: 185, rot: -7 }),
    bs("b1e", ["LEAGUES."], { x: 60, y: 1300, size: 282 }),
  ].join(""));
  slamWords("b1a", [0.43, 0.6, 0.72], { from: 1.3, g: 0.25 });
  slamWords("b1b", [0.88], { from: 1.9, g: 0.55 });
  slamWords("b1c", [1.41], { from: 1.6, g: 0.45 });
  paint("#b1d", 1.98, 0.42);
  slamWords("b1e", [2.45], { from: 2.1, g: 0.75 });
  shake("b1", 2.47, 18);
  push("b1", 0, 3.32, 1.05, "50% 45%");
  to("#b1-s", { opacity: 0.28, duration: 0.18 }, 2.9);

  // 2 · "VOLT."  the slash paints across the type and becomes the bolt
  logoBeat("b2", 2.8, 2.05, 2.86, 3.32,
    te("b2a", "THE LEAGUE PLATFORM", { y: 950, size: 38, ls: 0.42 }) + br("b2b", "built for Valorant.", { center: true, y: 1045, size: 150, rot: -5 }));
  fadeIn("#b2a", 3.85);
  paint("#b2b", 4.05, 0.5);
  flash(4.85, 0.4);

  // 3 · "Players sign up."
  const p3 = [
    print("b3p1", "kami-pool-scrolled", [344, 375, 358, 186], { cx: 335, cy: 1010, w: 520 }),
    print("b3p2", "kami-pool-scrolled", [1464, 375, 358, 186], { cx: 750, cy: 1205, w: 520 }),
    print("b3p3", "kami-pool-scrolled", [1464, 577, 358, 186], { cx: 540, cy: 1450, w: 600, z: 3 }),
  ];
  beat("b3", 4.83, 1.42, [
    bs("b3n", ["01"], { x: 610, y: 120, size: 520, op: 1 }).replace('class="bs"', 'class="bs outline"'),
    bs("b3a", ["PLAYERS"], { y: 300, size: 230 }),
    br("b3b", "sign up.", { x: 170, y: 505, size: 200 }),
    ...p3.map((p) => p.html),
  ].join(""));
  slam("#b3n", 4.84, { from: 1.2, g: 0.3 });
  slamWords("b3a", [4.94], { from: 1.8, g: 0.55 });
  paint("#b3b", 5.32, 0.38);
  slap("#b3p1", 5.0, -6); slap("#b3p2", 5.2, 5); slap("#b3p3", 5.45, -2, 0.65);
  shake("b3", 5.47, 10);
  // push into Kamijeee: the cut lands on the same player, on the block
  tw("#b3", { scale: 1, transformOrigin: "540px 1450px" }, { scale: 1.35, duration: 0.35, ease: "power3.in" }, 5.9);

  // 4 · "Captains draft them in a live auction."
  const card = print("b4c", "kami-auction-block", [852, 90, 462, 602], { cx: 540, cy: 1010, w: 420, tape: false });
  const bids = [["$800", "OPENS AT", DIM], ["$1,200", "PATIENCE", "#9d6bff"], ["$1,400", "DOOM", "#ff8a3d"], ["$1,600", "MISFITS", RED]];
  const bidT = [6.5, 6.95, 7.4, 7.82];
  beat("b4", 6.25, 2.47, [
    bs("b4n", ["02"], { x: 600, y: 120, size: 520 }).replace('class="bs"', 'class="bs outline"'),
    bs("b4a", ["CAPTAINS"], { y: 290, size: 220 }),
    br("b4b", "draft live.", { x: 150, y: 490, size: 190 }),
    card.html,
    ...bids.map(([v], i) => bs(`b4v${i}`, [v], { center: true, y: 1305, size: 230 })),
    ...bids.map(([, k, c], i) => te(`b4k${i}`, `— ${k} —`, { y: 1520, size: 52, color: c, ls: 0.2 })),
    `<div class="stamp" id="b4st" style="left:250px;top:880px"><b>SOLD</b><small>MISFITS · $1,600</small></div>`,
  ].join(""));
  slam("#b4n", 6.26, { from: 1.2, g: 0.3 });
  slamWords("b4a", [6.27], { from: 1.6, g: 0.5 });
  paint("#b4b", 6.72, 0.42);
  tw("#b4c", { scale: (600 * 1.35) / 420, y: 440, rotation: 0 }, { scale: 1, y: 0, rotation: -2, duration: 0.42, ease: "expo.out" }, 6.25);
  flash(6.25, 0.3);
  bids.forEach((_, i) => {
    const t = bidT[i], nx = bidT[i + 1];
    slam(`#b4v${i}`, t, { from: 1.6, g: i ? 0.6 : 0.3 });
    fadeIn(`#b4k${i}`, t + 0.05, 0.12);
    if (nx) { to(`#b4v${i}`, { opacity: 0, duration: 0.05 }, nx); to(`#b4k${i}`, { opacity: 0, duration: 0.05 }, nx); }
    if (i) shake("b4", t + 0.02, 8 + i * 3);
  });
  tw("#b4st", { opacity: 0, scale: 2.4, rotation: -20 }, { opacity: 1, scale: 1, rotation: -11, duration: 0.3, ease: "expo.out" }, 8.12);
  cue(8.14, "slap", { g: 0.9 }); cue(8.15, "thump", { g: 0.8 });
  shake("b4", 8.16, 22); flash(8.14, 0.35);
  // whip down the wall to the bracket
  to("#b4", { y: -1920, duration: 0.24, ease: "power3.in" }, 8.48);
  cue(8.42, "whoosh", { d: 0.55, g: 0.7 });
  to("#wallpan", { y: -260, duration: 0.5, ease: "power3.inOut" }, 8.48);

  // 5 · "And the bracket runs itself."
  const sf1 = print("b5p1", "kami-playoffs-final", [366, 486, 713, 110], { cx: 400, cy: 905, w: 600 });
  const sf2 = print("b5p2", "kami-playoffs-final", [1098, 486, 703, 110], { cx: 400, cy: 1095, w: 600 });
  const fin = print("b5p3", "kami-playoffs-final", [765, 700, 635, 130], { cx: 560, cy: 1380, w: 760 });
  beat("b5", 8.7, 2.1, [
    bs("b5n", ["03"], { x: 600, y: 120, size: 520 }).replace('class="bs"', 'class="bs outline"'),
    bs("b5a", ["THE", "BRACKET"], { y: 290, size: 196 }),
    br("b5b", "runs itself.", { x: 140, y: 468, size: 185 }),
    sf1.html, sf2.html, fin.html,
    marks(pathEl("b5l", "M702 905 H835 V1095 H702 M835 1000 H915 V1240 H860", { w: 10, color: INK, op: 0.9 }) + pathEl("b5o", loop(820, 1382, 130, 56, { seed: 2 }), { w: 9 })),
  ].join(""));
  tw("#b5", { y: 1920 }, { y: 0, duration: 0.26, ease: "power3.out" }, 8.7);
  slam("#b5n", 8.9, { from: 1.2, g: 0.25 });
  slamWords("b5a", [8.92, 9.08], { from: 1.6, g: 0.45 });
  slap("#b5p1", 9.0, -2); slap("#b5p2", 9.18, 1.5);
  paint("#b5b", 9.5, 0.45);
  draw("#b5l", 9.55, 0.4, 0.3);
  slap("#b5p3", 9.98, -1, 0.65); shake("b5", 10.0, 10);
  draw("#b5o", 10.25, 0.32);
  push("b5", 8.96, 1.84, 1.04);

  // 6 · "But the draft is where it's won."
  beat("b6", 10.78, 2.22, [
    poster("b6p", "art-jett.webp", { x: 50, y: 130, w: 980, h: 820, pos: "60% 25%" }),
    bs("b6a", ["THE", "DRAFT", "IS"], { y: 990, size: 180 }),
    bs("b6b", ["WHERE", "IT'S"], { y: 1150, size: 180 }),
    br("b6c", "won.", { x: 600, y: 1150, size: 330, rot: -9 }),
    marks(pathEl("b6u", "M600 1520 C730 1500 870 1510 1020 1478", { w: 16 })),
  ].join(""));
  slap("#b6p", 10.79, 2, 0.7); flash(10.79, 0.3);
  slamWords("b6a", [10.92, 11.08, 11.55], { from: 1.6, g: 0.4 });
  slamWords("b6b", [11.72, 11.93], { from: 1.6, g: 0.4 });
  paint("#b6c", 12.1, 0.4, 0.7); shake("b6", 12.22, 14);
  draw("#b6u", 12.45, 0.25, 0.3);
  push("b6", 10.78, 2.22, 1.05, "50% 35%");

  // 7 · "Every captain gets ten thousand to spend."  the number lands in the purse
  const purse = print("b7p", "kami-dashboard", [1340, 795, 483, 273], { cx: 540, cy: 1420, w: 900 });
  const S7 = 900 / 483, top7 = 1420 - (273 * S7) / 2;
  const cellX = 90 + ((1756 + 1803) / 2 - 1340) * S7, cellY = top7 + (846 - 795) * S7;
  beat("b7", 12.98, 2.82, [
    bs("b7a", ["EVERY", "CAPTAIN", "GETS"], { y: 300, size: 122 }),
    `<div class="bs num" id="b7n" style="left:0;width:1080px;text-align:center;top:470px;font-size:330px">$0</div>`,
    br("b7b", "to spend.", { x: 360, y: 940, size: 190 }),
    purse.html,
    marks(pathEl("b7o", loop(540, cellY, 450, 34, { rot: -1, seed: 3 }), { w: 8 })),
  ].join(""));
  flash(12.98, 0.3);
  slamWords("b7a", [13.03, 13.36, 13.75], { from: 1.5, g: 0.35 });
  fadeIn("#b7n", 13.95, 0.08);
  js.push(`(function(){const el=document.getElementById("b7n");const o={v:0};const w=(v)=>{el.textContent="$"+Math.round(v).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g,",");};w(0);tl.fromTo(o,{v:0},{v:10000,duration:0.38,ease:"power2.out",immediateRender:false,onUpdate:()=>w(o.v)},13.96);})();`);
  cue(13.96, "rise", { d: 0.38, g: 0.4 });
  tw("#b7n", { scale: 1.25 }, { scale: 1, duration: 0.22, ease: "power4.out", immediateRender: false }, 14.34);
  cue(14.35, "thump", { g: 0.85 }); shake("b7", 14.36, 16);
  paint("#b7b", 14.92, 0.36);
  slap("#b7p", 15.0, -1, 0.55);
  // fly: centre of the number (540, 470 + 400*.84/2) -> the PATIENCE cell
  to("#b7n", { x: cellX - 540, y: cellY - (470 + 139), scale: 0.09, duration: 0.36, ease: "power3.inOut" }, 15.12);
  to("#b7n", { opacity: 0, duration: 0.08 }, 15.48);
  cue(15.12, "air", { g: 0.5 }); cue(15.5, "pop", { p: 3, g: 0.6 });
  draw("#b7o", 15.48, 0.28);

  // 8 · "So before you bid… you scout."  a scope ring finds its mark
  beat("b8", 15.8, 2.5, [
    poster("b8p", "art-omen-void.webp", { x: 40, y: 120, w: 1000, h: 880, pos: "47% 20%" }),
    bs("b8a", ["BEFORE", "YOU", "BID,"], { y: 1060, size: 150 }),
    br("b8b", "you scout.", { x: 150, y: 1190, size: 270 }),
  ].join(""));
  slap("#b8p", 15.81, -2, 0.6); flash(15.8, 0.3);
  slamWords("b8a", [15.84, 16.22, 16.5], { from: 1.6, g: 0.4 });
  paint("#b8b", 17.26, 0.42, 0.7);
  push("b8", 15.8, 2.5, 1.05, "50% 30%");
  // the ring lives on its own layer so it can cross the cut
  clip(17.2, 2.3, marks(`<g id="ring">${pathEl("ringp", loop(0, 0, 165, 165, { seed: 4, turns: 1.08 }), { w: 10 })}<path id="ringx" d="M-215 0 H-150 M150 0 H215 M0 -215 V-150 M0 150 V215" stroke="${RED}" stroke-width="9" stroke-linecap="round" fill="none" filter="url(#rough)" opacity="0"/></g>`), 6);
  set("#ring", { x: 545, y: 455 }, 0);
  draw("#ringp", 17.32, 0.32);
  fadeIn("#ringx", 17.55, 0.12);
  // after the cut it shrinks onto the main card's name
  to("#ring", { x: 400, y: 1004, scaleX: 1.2, scaleY: 0.3, duration: 0.45, ease: "power3.inOut" }, 18.4);
  to("#ringx", { opacity: 0, duration: 0.15 }, 18.35);
  to("#ring", { opacity: 0, duration: 0.25 }, 19.25);

  // 9 · "Every player, on one board. Rank, role, and stats."  the scout wall
  const board = [
    print("b9p1", "kami-pool-scrolled", [344, 375, 358, 186], { cx: 290, cy: 700, w: 420, tape: false, pin: true }),
    print("b9p2", "kami-pool-scrolled", [1464, 375, 358, 186], { cx: 800, cy: 690, w: 420, tape: false, pin: true }),
    print("b9p3", "kami-pool-scrolled", [344, 577, 358, 186], { cx: 280, cy: 1560, w: 420, tape: false, pin: true }),
    print("b9p4", "kami-pool-scrolled", [1091, 577, 358, 186], { cx: 800, cy: 1570, w: 420, tape: false, pin: true }),
  ];
  const main = print("b9m", "kami-pool-scrolled", [1464, 577, 358, 186], { cx: 540, cy: 1120, w: 640, tape: false, pin: true, z: 3 });
  const S9 = 640 / 358, L9 = 540 - 320, T9 = 1120 - (186 * S9) / 2;
  const at9 = (x, y) => [L9 + (x - 1464) * S9, T9 + (y - 577) * S9];
  const [rkx, rky] = at9(1480 + 55, 623 + 9), [rlx, rly] = at9(1480, 645 + 22), [stx, sty] = at9(1478, 676);
  const strings = [[290, 600], [800, 590], [280, 1460], [800, 1470]].map(([x, y]) => `M540 ${T9 + 4} Q${(540 + x) / 2} ${(T9 + y) / 2 + 60} ${x} ${y}`).join(" ");
  beat("b9", 18.3, 4.85, [
    marks(pathEl("b9s", strings, { w: 4, op: 0.8, filt: "none" }), "under"),
    ...board.map((p) => p.html), main.html,
    bs("b9a", ["EVERY", "PLAYER."], { y: 210, size: 165 }),
    br("b9b", "one board.", { x: 400, y: 362, size: 175 }),
    marks([
      pathEl("b9r", loop(rkx, rky, 120, 30, { seed: 5 }), { w: 8 }),
      pathEl("b9o", `M${rlx - 6} ${rly - 8} C${rlx + 90} ${rly - 14} ${rlx + 200} ${rly - 6} ${rlx + 300} ${rly - 12}`, { w: 8 }),
      pathEl("b9t", `M${stx - 12} ${sty} L${stx + 460} ${sty - 6} L${stx + 466} ${sty + 50} L${stx - 10} ${sty + 54} Z`, { w: 8 }),
    ].join("")),
    br("b9k1", "rank", { x: rkx + 130, y: rky - 95, size: 92, rot: -10 }),
    br("b9k2", "role", { x: rlx + 320, y: rly - 70, size: 92, rot: -8 }),
    br("b9k3", "stats", { x: stx + 478, y: sty - 30, size: 92, rot: -8 }),
  ].join(""));
  flash(18.3, 0.25);
  slap("#b9m", 18.32, 0, 0.6);
  ["b9p1", "b9p2", "b9p3", "b9p4"].forEach((p, i) => slap(`#${p}`, 18.5 + i * 0.13, [-5, 4, 3, -4][i], 0.4));
  slamWords("b9a", [18.34, 18.62], { from: 1.6, g: 0.4 });
  paint("#b9b", 19.38, 0.4);
  draw("#b9s", 19.45, 0.45, 0.2);
  draw("#b9r", 20.65, 0.3); paint("#b9k1", 20.7, 0.25, 0.3);
  draw("#b9o", 21.36, 0.25); paint("#b9k2", 21.4, 0.25, 0.3);
  draw("#b9t", 22.02, 0.36); paint("#b9k3", 22.1, 0.28, 0.3);
  // into the card for the flip
  tw("#b9", { scale: 1, transformOrigin: `540px 1120px` }, { scale: 1.25, duration: 0.3, ease: "power3.in" }, 22.85);

  // 10 · "Open a scout file, and it's all there."  the card flips into its file
  const front = print("b10f", "kami-pool-scrolled", [1464, 577, 358, 186], { cx: 540, cy: 1120, w: 800, tape: false, z: 4 });
  const file = print("b10m", "kami-scout-modal", [510, 117, 435, 603], { cx: 330, cy: 1090, w: 440, tape: false, z: 3 });
  const radar = print("b10r", "kami-scout-modal", [1035, 195, 315, 270], { cx: 800, cy: 900, w: 400, z: 2 });
  const facts = print("b10d", "kami-scout-modal", [995, 522, 398, 146], { cx: 800, cy: 1300, w: 460, z: 2 });
  beat("b10", 23.15, 3.1, [
    radar.html, facts.html, file.html, front.html,
    bs("b10a", ["OPEN", "A", "FILE."], { y: 230, size: 175 }),
    br("b10b", "it's all there.", { x: 200, y: 395, size: 165 }),
    marks([pathEl("b10c1", check(470, 840), { w: 12 }), pathEl("b10c2", check(930, 760), { w: 12 }), pathEl("b10c3", check(975, 1250), { w: 12 })].join("")),
  ].join(""));
  // front: the board card, flipping away; file: the same player's scout card, flipping in
  tw("#b10f", { rotationY: 0, transformPerspective: 1800 }, { rotationY: 90, duration: 0.18, ease: "power2.in" }, 23.15);
  tw("#b10m", { rotationY: -90, x: 210, y: 30, scale: 1.1, transformPerspective: 1800 }, { rotationY: 0, x: 210, y: 30, scale: 1.1, duration: 0.2, ease: "power2.out" }, 23.33);
  to("#b10m", { x: 0, y: 0, scale: 1, rotation: -2, duration: 0.4, ease: "expo.out" }, 23.75);
  cue(23.2, "air", { g: 0.55 }); cue(23.4, "slap", { g: 0.45 });
  tw("#b10r", { x: -470, opacity: 0, rotation: 0 }, { x: 0, opacity: 1, rotation: 4, duration: 0.4, ease: "expo.out" }, 24.05);
  tw("#b10d", { x: -440, opacity: 0, rotation: 0 }, { x: 0, opacity: 1, rotation: -3, duration: 0.4, ease: "expo.out" }, 24.3);
  cue(24.07, "air", { g: 0.45 }); cue(24.32, "air", { g: 0.45 });
  slamWords("b10a", [23.3, 23.47, 23.62], { from: 1.6, g: 0.4 });
  paint("#b10b", 24.76, 0.45);
  draw("#b10c1", 25.0, 0.18, 0.35); draw("#b10c2", 25.2, 0.18, 0.35); draw("#b10c3", 25.4, 0.18, 0.35);
  push("b10", 23.6, 2.6, 1.04);

  // 11 · "Then bid like you mean it."
  const bids11 = [["$1,200", "PATIENCE", "#9d6bff"], ["$1,400", "DOOM", "#ff8a3d"], ["$1,600", "MISFITS", RED]];
  const bt11 = [26.75, 27.18, 27.6];
  beat("b11", 26.25, 2.1, [
    bs("b11a", ["THEN"], { y: 250, size: 175 }),
    br("b11b", "bid like you mean it.", { x: 70, y: 400, size: 132, rot: -6 }),
    ...bids11.map(([v], i) => bs(`b11v${i}`, [v], { center: true, y: 760, size: 380 })),
    ...bids11.map(([, k, c], i) => te(`b11k${i}`, `— ${k} —`, { y: 1110, size: 60, color: c, ls: 0.2 })),
    marks(pathEl("b11u", "M170 1240 C400 1210 700 1236 920 1196", { w: 18 })),
  ].join(""));
  flash(26.25, 0.3);
  slamWords("b11a", [26.3], { from: 1.6, g: 0.4 });
  paint("#b11b", 26.5, 0.6, 0.6);
  bt11.forEach((t, i) => {
    slam(`#b11v${i}`, t, { from: 1.7, g: 0.55 + i * 0.1 }); fadeIn(`#b11k${i}`, t + 0.04, 0.1); shake("b11", t + 0.02, 10 + i * 5);
    if (bt11[i + 1]) { to(`#b11v${i}`, { opacity: 0, duration: 0.04 }, bt11[i + 1]); to(`#b11k${i}`, { opacity: 0, duration: 0.04 }, bt11[i + 1]); }
  });
  draw("#b11u", 27.7, 0.22, 0.5);

  // 12 · "Scout. Bid. Win."  each word lands where the last bid stood, then they stack
  beat("b12", 28.3, 2.72, [
    bs("b12a", ["SCOUT."], { center: true, y: 760, size: 380 }),
    bs("b12b", ["BID."], { center: true, y: 760, size: 380 }),
    br("b12c", "Win.", { center: true, y: 830, size: 520, rot: -8 }),
  ].join(""));
  slam("#b12a", 28.39, { from: 1.8, g: 0.7 }); shake("b12", 28.41, 14);
  to("#b12a", { y: -420, scale: 0.8, duration: 0.25, ease: "power3.out" }, 29.2);
  slam("#b12b", 29.24, { from: 1.8, g: 0.75 }); shake("b12", 29.26, 16);
  to("#b12a", { y: -640, duration: 0.25, ease: "power3.out" }, 29.98);
  to("#b12b", { y: -380, scale: 0.8, duration: 0.25, ease: "power3.out" }, 29.98);
  paint("#b12c", 30.03, 0.35, 0.9); shake("b12", 30.2, 22);
  cue(30.05, "boom", { g: 0.6 });
  to("#b12-s", { opacity: 0.28, duration: 0.15 }, 30.62);

  // 13 · "Start your league on VOLT."  the slash again, the mark, the ask
  logoBeat("b13", 30.5, D - 30.5, 30.62, 31.02, [
    `<svg class="ov under" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">${pathEl("b13btn", "M150 1175 C400 1162 700 1180 930 1168", { w: 150, filt: "roughB" })}</svg>`,
    `<div class="bs" id="b13t" style="left:0;width:1080px;text-align:center;top:1128px;font-size:96px;color:${INK}">START YOUR LEAGUE</div>`,
    te("b13h", "@volt.leagues", { y: 1300, size: 52, color: INK, ls: 0.12 }),
    te("b13f", "SOLO SIGN-UPS · LIVE AUCTION · BRACKETS · STATS", { y: 1390, size: 28, ls: 0.16 }),
    te("b13p", "THE LEAGUE PLATFORM", { y: 945, size: 38, ls: 0.42 }),
  ].join(""));
  draw("#b13btn", 31.55, 0.35, 0.6);
  slam("#b13t", 31.8, { from: 1.4, g: 0.6 });
  fadeIn("#b13p", 31.6, 0.4);
  fadeIn("#b13h", 32.4, 0.4);
  fadeIn("#b13f", 32.7, 0.5);
  cue(31.8, "shimmer", { g: 0.3 });

  // ── wall boil (stop-motion jitter), grain steps, fade at the end
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let t = 0; t < D; t += 1 / 12) {
    set("#wall", { x: r(rnd() * 7), y: r(rnd() * 7) }, r(t));
    set("#grain", { x: r(rnd() * 60), y: r(rnd() * 60) }, r(t));
  }
  tw("#fade", { opacity: 1 }, { opacity: 0, duration: 0.3, ease: "power1.out" }, 0);
  to("#fade", { opacity: 1, duration: 0.45, ease: "power1.in" }, D - 0.5);

  const css = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#111}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#151413;color:${INK}}
.clip{position:absolute;inset:0}
.cam,.shk{position:absolute;inset:0}
#wallpan{position:absolute;left:-80px;top:-140px;width:1240px;height:2200px}
#wall{position:absolute;inset:0;background:url(${tex("grunge-wall")}) 0 0/1240px 2200px}
#grain{position:absolute;inset:-60px;opacity:.1;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='3' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
#vig{position:absolute;inset:0;background:radial-gradient(ellipse 90% 70% at 50% 45%,transparent 50%,rgba(0,0,0,.55))}
#flash{position:absolute;inset:0;background:#f4efe6;opacity:0;mix-blend-mode:overlay}
#fade{position:absolute;inset:0;background:#000}
.bs{position:absolute;font-family:"Big Shoulders Display",sans-serif;font-weight:900;text-transform:uppercase;line-height:.84;letter-spacing:.004em;white-space:nowrap;
  -webkit-mask-image:url(${tex("grunge-erode")});-webkit-mask-size:520px 520px;mask-image:url(${tex("grunge-erode")});mask-size:520px 520px}
.bs .w{display:inline-block;transform-origin:50% 80%}
.bs.outline{color:transparent!important;-webkit-text-stroke:3px rgba(236,232,224,.32)}
.bs.num{transform-origin:50% 50%}
.br{position:absolute;z-index:6;font-family:"Mr Dafoe",cursive;line-height:1;white-space:nowrap;transform-origin:0 60%;padding:0 .12em;
  -webkit-mask-image:url(${tex("grunge-streak")});-webkit-mask-size:760px 380px;mask-image:url(${tex("grunge-streak")});mask-size:760px 380px;
  filter:drop-shadow(0 2px 0 rgba(0,0,0,.35))}
.te{position:absolute;font-family:"Special Elite",monospace;white-space:nowrap;text-transform:uppercase}
.print{position:absolute;background:#0d1326;box-shadow:0 26px 40px rgba(0,0,0,.7),0 4px 10px rgba(0,0,0,.55)}
.crop{position:absolute;inset:0;overflow:hidden}
.crop img{position:absolute;max-width:none}
.print-wear{position:absolute;inset:0;pointer-events:none;background:url(${tex("grunge-erode")}) 0 0/400px 400px;opacity:.07;mix-blend-mode:screen}
.tape{position:absolute;width:150px;height:44px;background:rgba(214,205,180,.82);clip-path:polygon(4% 0,96% 6%,100% 30%,97% 62%,100% 100%,3% 94%,0 66%,2% 34%);box-shadow:0 1px 2px rgba(0,0,0,.25)}
.pin{position:absolute;width:32px;height:32px;border-radius:50%;background:radial-gradient(circle at 35% 32%,#ff9a9a,#d0101c 52%,#5e0810);box-shadow:0 8px 10px rgba(0,0,0,.6);z-index:5}
.poster{position:absolute;filter:drop-shadow(0 24px 30px rgba(0,0,0,.7))}
.poster-in{position:absolute;inset:0;overflow:hidden}
.poster-in img{width:100%;height:100%;object-fit:cover;filter:grayscale(1) contrast(1.35) brightness(.82)}
.poster-wash{position:absolute;inset:0;background:linear-gradient(180deg,rgba(232,52,63,.10),rgba(232,52,63,.28));mix-blend-mode:multiply}
.stamp{position:absolute;width:580px;padding:18px 0 22px;border:14px solid ${RED};color:${RED};text-align:center;font-family:"Big Shoulders Display";font-weight:900;line-height:.85;
  -webkit-mask-image:url(${tex("grunge-erode")});-webkit-mask-size:300px 300px;mask-image:url(${tex("grunge-erode")});mask-size:300px 300px;z-index:6}
.stamp b{display:block;font-size:230px}
.stamp small{display:block;font-size:52px;letter-spacing:.12em;margin-top:6px}
.erode-all{position:absolute;inset:0;-webkit-mask-image:url(${tex("grunge-erode")});-webkit-mask-size:700px 700px;mask-image:url(${tex("grunge-erode")});mask-size:700px 700px}
svg.ov{position:absolute;left:0;top:0;overflow:visible;pointer-events:none;z-index:7}
svg.ov.under{z-index:0}
`;

  const defs = `<svg width="0" height="0" style="position:absolute"><defs>
<filter id="rough" filterUnits="userSpaceOnUse" x="-300" y="-300" width="1700" height="2600"><feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="6"/><feDisplacementMap in="SourceGraphic" scale="9"/></filter>
<filter id="roughB" filterUnits="userSpaceOnUse" x="-300" y="-300" width="1700" height="2600"><feTurbulence type="fractalNoise" baseFrequency="0.025" numOctaves="3" seed="4"/><feDisplacementMap in="SourceGraphic" scale="26"/></filter>
<filter id="none"><feOffset dx="0" dy="0"/></filter></defs></svg>`;

  const doc = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Mr+Dafoe&family=Special+Elite&display=block" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${css}</style></head><body>
${defs}
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
<div id="bg" class="clip" data-start="0" data-duration="${D}" data-track-index="0"><div id="wallpan"><div id="wall"></div></div></div>
${html.join("\n")}
<div id="fx" class="clip" data-start="0" data-duration="${D}" data-track-index="9"><div id="grain"></div><div id="vig"></div><div id="flash"></div><div id="fade"></div></div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
${js.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script></body></html>
`;

  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const [name, src] of files) fs.copyFileSync(src(), path.join(dir, "assets", name));
  fs.writeFileSync(path.join(dir, "index.html"), doc);
  cues.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify({ id, duration: D, fps: spec.fps || 30, bpm: 120, bed: "grit", vo: spec.vo || null, hush: null, outro: 30.5, cues }, null, 1));
  return { dir, cues: cues.length };
}
