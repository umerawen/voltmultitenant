// "What if teams were bought?" — the premium VOLT reel for community owners.
// 1080x1920, ~53s, voice "Jax Meridian" (vo/premium.flac at 0.5s). Restrained:
// real Kami Labs screens (no browser frames), slow eased camera, one soft light,
// a quiet score (sfx/synth.py bed "premium"), one accent on SOLD.
// Each scene is its own block below (times are absolute seconds, from the
// voiceover's word times). Writes a HyperFrames project like engine.mjs does.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REELS as ROOT, W, H } from "./engine.mjs";

const SCREENS = path.join(ROOT, "screens"), CACHE = path.join(ROOT, ".cache");
const FF = process.env.FFMPEG || "ffmpeg";
const SW = 1920, SH = 1080;
const INK = "#ecf3ff", BLUE = "#3d7bff", HI = "#7da6ff", DIM = "rgba(205,218,255,0.62)";
const T = { P: "#9d6bff", M: "#ff4655", D: "#ff8a3d" };     // PATIENCE, MISFITS, DOOM
const J = (v) => JSON.stringify(v);
const r = (n) => Math.round(n * 1000) / 1000;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const VO = 0.5;

function webp(src, name) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, name);
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs)
    execFileSync(FF, ["-y", "-loglevel", "error", "-i", src, "-c:v", "libwebp", "-quality", "92", "-compression_level", "6", out]);
  return out;
}
const ARM = "M344.811 140.139H0L273.118 552.012L436.988 278.57L344.811 140.139Z";
const BOLT = "M392.606 466.561L689.622 0H1002L303.843 834L549.649 401.619L392.606 466.561Z";

export function premiumReel(spec) {
  const { id, duration: D } = spec;
  const dir = path.join(ROOT, "videos", id);
  const html = [], js = [], cues = [], files = new Map();
  let n = 0;
  const uid = (p) => `${p}${++n}`;
  const cue = (t, k, o = {}) => cues.push({ t: r(t), k, ...o });
  const tw = (sel, from, to, at) => js.push(`tl.fromTo(${J(sel)},${J(from)},${J({ ...to, immediateRender: to.immediateRender ?? true })},${r(at)});`);
  const to = (sel, v, at) => js.push(`tl.to(${J(sel)},${J(v)},${r(at)});`);
  const set = (sel, v, at) => js.push(`tl.set(${J(sel)},${J(v)},${r(at)});`);
  const shot = (name) => { files.set(`${name}.webp`, () => webp(path.join(SCREENS, name + ".png"), "screen-" + name + ".webp")); return `assets/${name}.webp`; };
  const card = (k) => { const f = `draw-card-${String(k).padStart(2, "0")}.webp`; files.set(f, () => webp(path.join(SCREENS, "kami-draw", `card-${String(k).padStart(2, "0")}.png`), "draw-" + f)); return `assets/${f}`; };
  // a timed scene: .clip > .sc (fade) > .cam (camera) — the clip itself is never tweened
  const scene = (idp, t0, d, inner, { fadeIn = 0.6, fadeOut = 0.5, track = 1 } = {}) => {
    html.push(`<div class="clip" data-start="${r(t0)}" data-duration="${r(d)}" data-track-index="${track}"><div class="sc" id="${idp}"><div class="cam" id="${idp}-c">${inner}</div></div></div>`);
    tw(`#${idp}`, { opacity: 0 }, { opacity: 1, duration: fadeIn, ease: "power2.inOut" }, t0);
    if (fadeOut) to(`#${idp}`, { opacity: 0, duration: fadeOut, ease: "power2.inOut" }, t0 + d - fadeOut);
  };
  // a crop of a real screen: rounded, soft shadow, no frame. (x, y) = centre
  const ui = (idp, name, [rx, ry, rw, rh], { x = 540, y, w, radius = 18, cls = "" }) => {
    const S = w / rw, h = rh * S;
    return { h, w, html: `<div class="ui ${cls}" id="${idp}" style="left:${r(x - w / 2)}px;top:${r(y - h / 2)}px;width:${r(w)}px;height:${r(h)}px;border-radius:${radius}px"><img src="${shot(name)}" style="width:${r(SW * S)}px;height:${r(SH * S)}px;left:${r(-rx * S)}px;top:${r(-ry * S)}px"></div>` };
  };
  // display type: words rise out of a mask, one by one on their syllable
  const head = (idp, words, { y, size = 96, color = INK, times, center = true, x = 0, weight = 800 }) => {
    times.forEach((t, i) => tw(`#${idp}-w${i}`, { yPercent: 105 }, { yPercent: 0, duration: 0.7, ease: "expo.out" }, t));
    return `<div class="hd" id="${idp}" style="${center ? "left:0;right:0;text-align:center" : `left:${x}px`};top:${y}px;font-size:${size}px;color:${color};font-weight:${weight}">${words.map((w, i) => `<span class="m"><span class="w" id="${idp}-w${i}">${w}</span></span>`).join(" ")}</div>`;
  };
  const label = (idp, text, { y, at, color = HI }) => {
    tw(`#${idp}`, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, at);
    return `<div class="lb" id="${idp}" style="top:${y}px;color:${color}">${esc(text)}</div>`;
  };
  const rise = (sel, at, { y = 40, d = 0.9, scale = 0.98 } = {}) => tw(sel, { opacity: 0, y, scale }, { opacity: 1, y: 0, scale: 1, duration: d, ease: "expo.out" }, at);
  const fade = (sel, at, d = 0.5) => to(sel, { opacity: 0, duration: d, ease: "power2.inOut" }, at);
  const cam = (idp, at, v, d, ease = "power2.inOut") => to(`#${idp}-c`, { ...v, duration: d, ease }, at);
  const camStart = (idp, v) => set(`#${idp}-c`, { transformOrigin: "50% 50%", ...v }, 0);

  // ── the team panel (the real AuctionTeamCell, rebuilt so its numbers can move)
  const team = (idp, { name, cap, hue, budget, max, roster, incoming }) =>
    `<div class="tc" id="${idp}" style="--h:${hue}"><div class="tc-top"><span class="tc-mono">${name[0]}</span><div><div class="tc-name">${name}</div><div class="tc-cap">${cap}</div></div><span class="tc-lead" id="${idp}-lead">LEADING</span></div>
     <div class="tc-row"><span class="tc-bud" id="${idp}-bud">$${budget.toLocaleString("en-US")}</span><span class="tc-max">max <b id="${idp}-max">$${max.toLocaleString("en-US")}</b></span></div>
     <div class="tc-bar"><i id="${idp}-bar" style="width:${budget / 100}%"></i></div>
     <div class="tc-ros">${[0, 1, 2, 3].map((k) => roster[k] ? `<div class="tc-p"><span>${roster[k][0]}</span><b>${roster[k][1]}</b><em>${roster[k][2]}</em></div>`
        : k === roster.length && incoming ? `<div class="tc-slot"><div class="tc-e"></div><div class="tc-p tc-in" id="${idp}-in"><span>${incoming[0]}</span><b>${incoming[1]}</b><em>${incoming[2]}</em></div></div>` : `<div class="tc-e"></div>`).join("")}</div></div>`;
  const steps = (idp, vals, cls = "") => `<span class="stk ${cls}" id="${idp}">${vals.map((v, i) => `<span id="${idp}-${i}" style="${i ? "opacity:0;" : ""}${v[1] ? `color:${v[1]}` : ""}">${esc(v[0])}</span>`).join("")}</span>`;
  const step = (idp, i, t) => { tw(`#${idp}-${i}`, { opacity: 0 }, { opacity: 1, duration: 0.12 }, t); to(`#${idp}-${i - 1}`, { opacity: 0, duration: 0.08 }, t); };
  const money = (sel, from, to2, at, dur = 0.5) => js.push(`(function(){const el=document.querySelector(${J(sel)});const o={v:${from}};const w=(v)=>{el.textContent="$"+Math.round(v).toLocaleString("en-US");};tl.fromTo(o,{v:${from}},{v:${to2},duration:${dur},ease:"power2.out",immediateRender:false,onUpdate:()=>w(o.v)},${r(at)});})();`);

  // ════════════════════════════════════════════════════════════════════
  // 1 · THE HOOK  "What if Valorant teams weren't chosen… but bought, in a live auction?"
  {
    const c = ui("s1card", "kami-auction-block", [852, 89, 461, 602], { y: 880, w: 520, radius: 22 });
    scene("s1", 0, 5.75, `
      <div class="glow" id="s1g" style="top:560px"></div>
      ${c.html}
      ${head("s1a", ["WHAT", "IF", "TEAMS"], { y: 250, size: 104, times: [0.5, 0.62, 1.54] })}
      <div class="hd swap" style="left:0;right:0;top:350px;font-size:104px;text-align:center">
        <span class="m"><span class="w" id="s1b0">WEREN'T</span></span>
        <span class="m swapbox"><span class="w" id="s1b1">CHOSEN?</span><span class="w alt" id="s1b2">BOUGHT.</span></span></div>
      <div class="bidbox" id="s1bid" style="top:1250px"><div><small>CURRENT BID</small><b>${steps("s1v", [["$800"], ["$1,200"], ["$1,400"], ["$1,600"]])}</b></div><div><small>HELD BY</small><em>${steps("s1h", [["—", DIM], ["PATIENCE", T.P], ["DOOM", T.D], ["MISFITS", T.M]])}</em></div></div>
      <div class="sold" id="s1sold" style="top:1420px">SOLD <small>MISFITS · $1,600</small></div>`, { fadeIn: 0.9, fadeOut: 0.45 });
    tw("#s1card", { opacity: 0, scale: 0.94, y: 30 }, { opacity: 1, scale: 1, y: 0, duration: 1.6, ease: "expo.out" }, 0.05);
    tw("#s1g", { opacity: 0, scale: 0.8 }, { opacity: 1, scale: 1, duration: 2.2, ease: "power2.out" }, 0.05);
    tw("#s1b0", { yPercent: 105 }, { yPercent: 0, duration: 0.7, ease: "expo.out" }, 1.86);
    tw("#s1b1", { yPercent: 105 }, { yPercent: 0, duration: 0.7, ease: "expo.out" }, 2.12);
    // "but bought" — CHOSEN leaves upward, BOUGHT arrives in blue
    to("#s1b1", { yPercent: -105, duration: 0.55, ease: "power3.in" }, 3.2);
    tw("#s1b2", { yPercent: 105 }, { yPercent: 0, duration: 0.7, ease: "expo.out" }, 3.5);
    camStart("s1", { scale: 1 });
    cam("s1", 0, { scale: 1.04 }, 5.5, "none");
    // "in a live auction" — the bid climbs, then the hammer
    rise("#s1bid", 3.95, { y: 24, d: 0.6 });
    [4.3, 4.55, 4.78].forEach((t, i) => { step("s1v", i + 1, t); step("s1h", i + 1, t); cue(t, "tick", { g: 0.22 }); });
    tw("#s1sold", { opacity: 0, letterSpacing: "0.5em" }, { opacity: 1, letterSpacing: "0.22em", duration: 0.5, ease: "expo.out" }, 4.95);
    cue(4.95, "tick", { g: 0.3 });
  }

  // 2 · YOUR COMMUNITY  "You've got the players. You've got the community. So why aren't you running your own Valorant league?"
  {
    const P = [[344, 375], [1464, 375], [717, 375], [1091, 577], [344, 577], [1464, 577]];   // LIMONATAA, NIA, KRAKEN, LIANO, GOODGUYSHANII, KAMIJEEE
    const cards = P.map(([x, y], i) => ui(`s2p${i}`, "kami-pool-scrolled", [x, y, 358, 186], { x: i % 2 ? 790 : 290, y: 620 + Math.floor(i / 2) * 270, w: 470, radius: 14 }));
    const dash = ui("s2d", "kami-dashboard", [330, 94, 1500, 986], { y: 890, w: 1000, radius: 20 });
    scene("s2", 5.55, 6.75, `
      <div class="glow" style="top:520px;opacity:.75"></div>
      <div id="s2grid">${cards.map((c) => c.html).join("")}</div>
      ${dash.html}
      <div class="stack" style="top:236px">
        <div class="ln" id="s2t0">YOUR PLAYERS.</div><div class="ln" id="s2t1">YOUR COMMUNITY.</div><div class="ln b" id="s2t2">YOUR LEAGUE.</div></div>`);
    // scattered → ordered: the community becomes a league
    const scatter = [[-160, -120, -9], [180, -80, 7], [-220, 60, 6], [200, 110, -8], [-120, 180, -5], [150, 220, 9]];
    cards.forEach((_, i) => tw(`#s2p${i}`, { opacity: 0, x: scatter[i][0], y: scatter[i][1], rotation: scatter[i][2], scale: 0.9 },
      { opacity: 1, x: 0, y: 0, rotation: 0, scale: 1, duration: 1.3, ease: "expo.out" }, 5.6 + i * 0.12));
    tw("#s2t0", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 5.7);
    to("#s2t0", { opacity: 0.35, duration: 0.4 }, 7.5);
    tw("#s2t1", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 7.54);
    to("#s2t1", { opacity: 0.35, duration: 0.4 }, 10.6);
    // "your own Valorant league" — the grid gives way to the league itself (the dashboard home)
    to("#s2grid", { opacity: 0, scale: 0.92, y: -40, duration: 0.8, ease: "power2.inOut" }, 9.6);
    tw("#s2d", { opacity: 0, y: 80, scale: 0.96 }, { opacity: 1, y: 0, scale: 1, duration: 1.2, ease: "expo.out" }, 9.95);
    tw("#s2t2", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.6, ease: "power2.out" }, 10.66);
    tw("#s2d img", { x: 0 }, { x: -18, duration: 2.4, ease: "none" }, 9.95);
  }

  // 3 · THE SETUP  "Players sign up. You appoint captains. And then… things get interesting."
  {
    const pool = ui("s3pool", "kami-player-pool", [335, 92, 760, 870], { y: 900, w: 940, radius: 20 });
    const caps = ui("s3caps", "kami-player-pool", [343, 488, 735, 394], { y: 880, w: 960, radius: 18 });
    const file = ui("s3file", "kami-scout-modal", [509, 117, 902, 845], { y: 800, w: 900, radius: 20 });
    const kami = ui("s3k", "kami-pool-scrolled", [1464, 577, 358, 186], { y: 900, w: 640, radius: 16 });
    scene("s3", 12.15, 6.6, `
      <div class="glow" style="top:560px;opacity:.7"></div>
      ${pool.html}${caps.html}${file.html}${kami.html}
      ${label("s3l0", "THE POOL", { y: 270, at: 12.35 })}
      ${label("s3l1", "THE CAPTAINS", { y: 300, at: 13.9 })}
      ${label("s3l2", "THE SCOUT HUB", { y: 300, at: 14.9 })}`);
    rise("#s3pool", 12.2, { y: 50 });
    tw("#s3pool img", { y: 0 }, { y: -14, duration: 1.8, ease: "power1.inOut" }, 12.2);
    to("#s3l0", { opacity: 0, duration: 0.3 }, 13.6);
    // "You appoint captains" — the captain row, tagged in the app
    fade("#s3pool", 13.7, 0.45);
    rise("#s3caps", 13.86, { y: 30, d: 0.8 });
    to("#s3l1", { opacity: 0, duration: 0.3 }, 14.7);
    fade("#s3caps", 14.7, 0.4);
    // the Scout Hub: a player's whole file
    rise("#s3file", 14.85, { y: 30, d: 0.8 });
    to("#s3l2", { opacity: 0, duration: 0.3 }, 15.75);
    fade("#s3file", 15.75, 0.5);
    // "And then…" — slow down; one card, the light gathers on it
    rise("#s3k", 15.95, { y: 20, d: 1.4, scale: 0.96 });
    to("#s3k", { scale: 1.06, duration: 2.6, ease: "power1.inOut" }, 16.3);
  }

  // 4 · THE LIVE AUCTION  "Captains go head-to-head in a live player auction. Scouting talent, outbidding rivals, and building their dream teams."
  {
    // the draw: real card stills on a strip, easing onto Kamijeee (card 05)
    const meta = JSON.parse(fs.readFileSync(path.join(SCREENS, "kami-draw", "draw.json"), "utf8"));
    const nPool = meta.pool.length, lead = 14, CW = 300, GAP = 26, SLOT = CW + GAP;
    const CH = Math.round(CW * 878 / 670);
    const strip = Array.from({ length: lead + 4 }, (_, i) => (((meta.winnerIdx - lead + i) % nPool) + nPool) % nPool);
    const cardsHtml = strip.map((k, i) => `<img class="dc" src="${card(k)}" style="left:${i * SLOT}px;width:${CW}px">`).join("");
    const startX = 540 - CW / 2, endX = 540 - CW / 2 - lead * SLOT;
    const block = ui("s4card", "kami-auction-block", [852, 89, 461, 602], { y: 590, w: 420, radius: 20 });
    const misfitsRoster = ui("s4team", "kami-rosters", [343, 233, 357, 535], { y: 900, w: 520, radius: 18 });
    scene("s4", 18.6, 8.4, `
      <div class="glow" id="s4g" style="top:420px"></div><div class="glow green" id="s4gg" style="top:420px"></div>
      <div class="strip" id="s4strip" style="top:${900 - CH / 2}px">${cardsHtml}</div>
      <div class="marker" id="s4mk"></div>
      ${block.html}
      ${label("s4l0", "ON THE BLOCK", { y: 250, at: 20.55 })}
      <div class="rival" id="s4L" style="left:60px">${team("s4P", { name: "PATIENCE", cap: "Rumer", hue: T.P, budget: 10000, max: 7600, roster: [] })}</div>
      <div class="rival" id="s4R" style="right:60px">${team("s4M", { name: "MISFITS", cap: "Yona", hue: T.M, budget: 5900, max: 4300, roster: [["DUE", "limonataa", "$4,100"]], incoming: ["DUE", "Kamijeee", "$1,600"] })}</div>
      <div class="vs" id="s4vs">VS</div>
      <div class="bidbox big" id="s4bid" style="top:900px"><div><small>CURRENT BID</small><b>${steps("s4v", [["$800"], ["$1,200"], ["$1,400"], ["$1,600"]])}</b></div><div><small>HELD BY</small><em>${steps("s4h", [["—", DIM], ["PATIENCE", T.P], ["DOOM", T.D], ["MISFITS", T.M]])}</em></div></div>
      <div class="sold big" id="s4sold" style="top:870px">SOLD <small>KAMIJEEE → MISFITS · $1,600</small></div>
      ${misfitsRoster.html}
      ${label("s4l1", "THE DREAM TEAM", { y: 250, at: 25.3, color: T.M })}`, { fadeIn: 0.5 });
    // a. the draw
    tw("#s4strip", { x: startX }, { x: endX, duration: 1.9, ease: "power3.out" }, 18.65);
    tw("#s4mk", { opacity: 0 }, { opacity: 1, duration: 0.4 }, 18.7);
    cue(18.65, "rise", { d: 1.6, g: 0.18 });
    // b. the landed card becomes the auction's own card, up top
    to("#s4strip", { opacity: 0, duration: 0.5, ease: "power2.inOut" }, 20.55); to("#s4mk", { opacity: 0, duration: 0.4 }, 20.55);
    tw("#s4card", { opacity: 0, y: 240, scale: 0.86 }, { opacity: 1, y: 0, scale: 1, duration: 1.0, ease: "expo.out" }, 20.6);
    to("#s4l0", { opacity: 0, duration: 0.3 }, 21.7);
    // c. two captains, split either side; the bid in the middle
    tw("#s4L", { opacity: 0, x: -60 }, { opacity: 1, x: 0, duration: 0.8, ease: "expo.out" }, 21.65);
    tw("#s4R", { opacity: 0, x: 60 }, { opacity: 1, x: 0, duration: 0.8, ease: "expo.out" }, 21.75);
    tw("#s4vs", { opacity: 0 }, { opacity: 1, duration: 0.6 }, 21.9);
    rise("#s4bid", 21.8, { y: 24, d: 0.7 });
    const bids = [[22.55, "$1,200", "PATIENCE", T.P, "s4P"], [23.3, "$1,400", "DOOM", T.D, null], [24.0, "$1,600", "MISFITS", T.M, "s4M"]];
    bids.forEach(([t, , , , panel], i) => {
      step("s4v", i + 1, t); step("s4h", i + 1, t);
      if (i > 0) { to("#s4P-lead", { opacity: 0, duration: 0.2 }, t); to("#s4P", { "--on": 0, duration: 0.3 }, t); }
      if (panel) { tw(`#${panel}-lead`, { opacity: 0 }, { opacity: 1, duration: 0.3 }, t); tw(`#${panel}`, { "--on": 0 }, { "--on": 1, duration: 0.3 }, t); }
      cue(t, "tick", { g: 0.24 + i * 0.04 });
    });
    // d. SOLD — the light turns, one quiet accent
    to("#s4g", { opacity: 0.25, duration: 0.6 }, 24.6);
    tw("#s4gg", { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "power2.out" }, 24.6);
    tw("#s4sold", { opacity: 0, letterSpacing: "0.55em" }, { opacity: 1, letterSpacing: "0.24em", duration: 0.7, ease: "expo.out" }, 24.62);
    to("#s4bid", { opacity: 0, duration: 0.22 }, 24.38); to("#s4vs", { opacity: 0, duration: 0.3 }, 24.6);
    money("#s4M-bud", 5900, 4300, 24.75, 0.6);
    tw("#s4M-in", { opacity: 0, x: 20 }, { opacity: 1, x: 0, duration: 0.5, ease: "expo.out" }, 24.9);
    cue(24.62, "sold", { g: 0.5 });
    // e. "…building their dream teams" — the card joins MISFITS
    to("#s4card", { opacity: 0, scale: 0.6, x: 300, y: 380, duration: 0.7, ease: "power3.in" }, 25.1);
    to("#s4L", { opacity: 0, duration: 0.4 }, 25.1); to("#s4sold", { opacity: 0, duration: 0.4 }, 25.3);
    to("#s4R", { opacity: 0, x: 40, duration: 0.5 }, 25.55);
    rise("#s4team", 25.55, { y: 40, d: 1.0 });
  }

  // 5 · THE LEAGUE COMES ALIVE  one connected journey down the season
  {
    const items = [
      ui("s5a", "kami-match-modal", [343, 664, 726, 416], { y: 0, w: 900 }),
      ui("s5b", "kami-leaderboard", [344, 100, 1478, 545], { y: 0, w: 960 }),
      ui("s5c", "kami-final-modal", [652, 314, 616, 451], { y: 0, w: 860 }),
      ui("s5d", "kami-fixtures-champion", [343, 108, 1480, 422], { y: 0, w: 1000 }),
    ];
    const GAP5 = 520;
    let yy = 0; const ys = items.map((it) => { const c = yy + it.h / 2; yy += it.h + GAP5; return c; });
    const placed = items.map((it, i) => it.html.replace(/top:[-\d.]+px/, `top:${r(ys[i] - it.h / 2)}px`)).join("");
    const stopAt = (i) => 900 - ys[i];          // camera y so item i sits at y≈900
    scene("s5", 26.85, 8.9, `
      <div class="glow" style="top:520px;opacity:.6"></div>
      <div class="track" id="s5t" style="top:0">${placed}</div>
      ${label("s5l0", "THE MATCHUPS.", { y: 290, at: 29.1 })}
      ${label("s5l1", "THE RIVALRIES.", { y: 290, at: 30.9 })}
      ${label("s5l2", "THE CHAMPIONS.", { y: 290, at: 32.95, color: "#f5c453" })}`);
    tw("#s5t", { y: stopAt(0) + 260, opacity: 0 }, { y: stopAt(0), opacity: 1, duration: 1.4, ease: "expo.out" }, 27.0);
    to("#s5t", { y: stopAt(1), duration: 1.0, ease: "power2.inOut" }, 29.85);
    to("#s5l0", { opacity: 0, duration: 0.3 }, 29.7);
    to("#s5t", { y: stopAt(2), duration: 1.0, ease: "power2.inOut" }, 30.75);
    to("#s5l1", { opacity: 0, duration: 0.3 }, 31.75);
    to("#s5t", { y: stopAt(3), duration: 1.0, ease: "power2.inOut" }, 32.0);
    // "All in one place" — pull back: the whole season in one column
    to("#s5t", { y: 150, scale: 0.38, transformOrigin: "50% 0%", duration: 1.3, ease: "power3.inOut" }, 34.1);
    to("#s5l2", { opacity: 0, duration: 0.3 }, 34.0);
  }

  // 6 · THE BENEFIT  the dashboard, and everything it ties together
  {
    const dash = ui("s6d", "kami-dashboard", [330, 94, 1500, 986], { y: 860, w: 980, radius: 20 });
    const tiles = [
      ui("s6t0", "kami-rosters", [343, 233, 1480, 535], { x: 290, y: 330, w: 440, radius: 14 }),
      ui("s6t1", "kami-auction-block", [852, 89, 461, 602], { x: 790, y: 330, w: 190, radius: 14 }),
      ui("s6t2", "kami-match-modal", [343, 664, 726, 416], { x: 290, y: 1330, w: 440, radius: 14 }),
      ui("s6t3", "kami-match-modal", [1096, 349, 727, 297], { x: 790, y: 1330, w: 440, radius: 14 }),
    ];
    const tl6 = [["TEAMS", 290, 470], ["AUCTION", 790, 470], ["FIXTURES", 290, 1166], ["STANDINGS", 790, 1166]];
    scene("s6", 35.6, 8.15, `
      <div class="glow" style="top:560px;opacity:.7"></div>
      <div id="s6zoom">${dash.html}</div>
      ${tiles.map((t) => t.html).join("")}
      ${tl6.map(([t, x, y], i) => `<div class="tl" id="s6l${i}" style="left:${x - 200}px;top:${y}px">${t}</div>`).join("")}`);
    // start close on the dashboard's hero card, pull back to the whole thing
    set("#s6zoom", { transformOrigin: "30% 45%", scale: 1.9 }, 0);
    tw("#s6zoom", { scale: 1.9, opacity: 0 }, { scale: 1.9, opacity: 1, duration: 0.6 }, 35.65);
    to("#s6zoom", { scale: 1, duration: 2.4, ease: "power3.inOut" }, 36.0);
    to("#s6zoom", { scale: 0.86, y: 0, duration: 1.0, ease: "power2.inOut" }, 38.3);
    [38.5, 39.0, 40.0, 40.45].forEach((t, i) => { rise(`#s6t${i}`, t, { y: i < 2 ? -24 : 24, d: 0.9 }); tw(`#s6l${i}`, { opacity: 0 }, { opacity: 1, duration: 0.5 }, t + 0.2); });
  }

  // 7 · BRAND REVEAL  "This is VOLT. Your community. Your league. Your rules."
  {
    const lg = `<svg class="logo" viewBox="0 0 1100 420" width="620" height="237"><defs>
      <linearGradient id="gb7" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8db3ff"/><stop offset="0.55" stop-color="#3d7bff"/><stop offset="1" stop-color="#1f47c9"/></linearGradient>
      <linearGradient id="ga7" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9cbef"/></linearGradient></defs>
      <g transform="scale(0.5036)"><path id="l7a" d="${ARM}" fill="url(#ga7)"/><path id="l7b" d="${BOLT}" fill="url(#gb7)"/></g>
      <g transform="translate(205 90) scale(6)" fill="#f4f8ff"><path id="l7o" fill-rule="evenodd" d="M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z"/><path id="l7l" d="M80 0H89.5V31H105V40H80Z"/><path id="l7t" d="M109 0H146V9.5H132.25V40H122.75V9.5H109Z"/></g></svg>`;
    scene("s7", 43.6, D - 43.6, `
      <div class="glow" id="s7g" style="top:470px"></div>
      <div class="logo-w" id="s7lg">${lg}</div>
      <div class="tag3"><span id="s7a">YOUR COMMUNITY.</span><span id="s7b">YOUR LEAGUE.</span><span id="s7c" class="b">YOUR RULES.</span></div>
      <div class="cta" id="s7cta">DM US TO LAUNCH YOUR LEAGUE<i id="s7u"></i></div>`, { fadeIn: 0.8, fadeOut: 0 });
    tw("#s7g", { opacity: 0, scale: 0.7 }, { opacity: 1, scale: 1, duration: 2.4, ease: "power2.out" }, 44.1);
    tw("#l7a", { opacity: 0, x: -40 }, { opacity: 1, x: 0, duration: 1.1, ease: "expo.out" }, 44.2);
    tw("#l7b", { opacity: 0, x: 40, y: -40 }, { opacity: 1, x: 0, y: 0, duration: 1.1, ease: "expo.out" }, 44.35);
    ["o", "l", "t"].forEach((c, i) => tw(`#l7${c}`, { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "power3.out" }, 44.6 + i * 0.08));
    cue(44.5, "resolve", { g: 0.6 });
    [["s7a", 45.86], ["s7b", 47.38], ["s7c", 48.66]].forEach(([s, t]) => tw(`#${s}`, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: "power2.out" }, t));
    tw("#s7cta", { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.8, ease: "power2.out" }, 50.3);
    tw("#s7u", { scaleX: 0 }, { scaleX: 1, duration: 0.9, ease: "power3.inOut" }, 50.7);
  }

  // ── captions (synced to the voice; off for the hook's own type and the logo)
  const CAP = [
    ["You've got the players.", 5.7, 7.3], ["You've got the community.", 7.54, 9.0], ["So why aren't you running your own Valorant league?", 9.3, 12.2],
    ["Players sign up.", 12.34, 13.65], ["You appoint captains.", 13.86, 15.45], ["And then… things get interesting.", 15.78, 18.6],
    ["Captains go head-to-head in a live player auction.", 18.98, 22.3], ["Scouting talent, outbidding rivals,", 22.5, 24.9], ["and building their dream teams.", 24.98, 26.9],
    ["And that's only the beginning.", 27.14, 28.95], ["Fixtures, leaderboards, predictions,", 29.14, 31.5], ["and the race to become champions.", 31.62, 33.95], ["All in one place.", 34.18, 35.65],
    ["Less admin for you.", 36.26, 38.35], ["More competition, more rivalries,", 38.5, 41.35], ["and way more fun for your community.", 41.46, 43.6],
  ];
  CAP.forEach(([text, a, b], i) => {
    html.push(`<div class="clip" data-start="${r(a)}" data-duration="${r(b - a)}" data-track-index="8"><div class="cap" id="cap${i}">${esc(text)}</div></div>`);
    tw(`#cap${i}`, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.3, ease: "power2.out" }, a);
    to(`#cap${i}`, { opacity: 0, duration: 0.2 }, b - 0.2);
  });

  // background light drifts very slowly; the frame breathes, nothing else
  tw("#amb", { x: -60, y: -20 }, { x: 60, y: 30, duration: D, ease: "sine.inOut" }, 0);
  tw("#fade", { opacity: 1 }, { opacity: 0, duration: 0.6, ease: "power1.out" }, 0);

  const css = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#090c16}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#090c16;color:${INK};font-family:"Space Grotesk",sans-serif;-webkit-font-smoothing:antialiased}
.clip{position:absolute;inset:0}
.sc,.cam{position:absolute;inset:0}
#amb{position:absolute;left:-200px;right:-200px;top:-300px;height:1500px;background:radial-gradient(ellipse 55% 45% at 50% 40%,rgba(61,123,255,0.16),rgba(61,123,255,0) 70%)}
#base{position:absolute;inset:0;background:linear-gradient(180deg,#0b1020 0%,#090c16 55%,#07090f 100%)}
#grain{position:absolute;inset:-40px;opacity:.035;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='4' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
#fade{position:absolute;inset:0;background:#000}
.glow{position:absolute;left:50%;width:1300px;height:900px;margin-left:-650px;background:radial-gradient(closest-side,rgba(61,123,255,0.22),rgba(61,123,255,0.07) 55%,rgba(61,123,255,0));pointer-events:none}
.glow.green{background:radial-gradient(closest-side,rgba(61,220,132,0.20),rgba(61,220,132,0.05) 55%,rgba(61,220,132,0));opacity:0}
.ui{position:absolute;overflow:hidden;box-shadow:0 40px 90px rgba(0,0,0,0.55),0 10px 30px rgba(0,0,0,0.35),0 0 0 1px rgba(150,180,255,0.08)}
.ui img{position:absolute;max-width:none}
.hd{position:absolute;font-family:"Big Shoulders Display",sans-serif;text-transform:uppercase;line-height:1;letter-spacing:.01em}
.hd .m{display:inline-block;overflow:hidden;vertical-align:top;padding:0 .02em}
.hd .w{display:inline-block}
.swapbox{position:relative}
.swapbox .alt{position:absolute;left:0;top:0;color:${BLUE}}
.lb{position:absolute;left:0;right:0;text-align:center;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:24px;letter-spacing:.42em}
.stack{position:absolute;left:0;right:0;text-align:center;font-family:"Big Shoulders Display",sans-serif;font-weight:800;font-size:76px;line-height:1.02;text-transform:uppercase}
.stack .b{color:${BLUE}}
.stack .small{font-size:60px;letter-spacing:.02em}
.bidbox{position:absolute;left:50%;transform:translateX(-50%);display:flex;gap:36px;align-items:center;padding:22px 40px;border-radius:14px;background:rgba(13,19,38,0.92);box-shadow:0 0 0 1px rgba(91,141,255,0.25),0 30px 60px rgba(0,0,0,.5)}
.bidbox small{display:block;font-family:"Rajdhani",sans-serif;font-weight:600;font-size:20px;letter-spacing:.2em;color:${DIM}}
.bidbox b{display:block;font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:64px;line-height:1;color:#5b8dff;transform-origin:50% 60%}
.bidbox em{display:block;font-style:normal;font-family:"Rajdhani",sans-serif;font-weight:700;font-size:36px;letter-spacing:.04em;margin-top:6px}
.bidbox.big b{font-size:84px}
.sold{position:absolute;left:0;right:0;text-align:center;font-family:"Big Shoulders Display",sans-serif;font-weight:900;font-size:120px;letter-spacing:.22em;color:#3ddc84;line-height:1}
.sold small{display:block;margin-top:14px;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:24px;letter-spacing:.2em;color:${DIM}}
.sold.big{font-size:150px}
.strip{position:absolute;left:0;height:786px}
.dc{position:absolute;top:0;height:auto;border-radius:16px;box-shadow:0 30px 60px rgba(0,0,0,.5)}
.marker{position:absolute;left:50%;top:470px;width:2px;height:860px;margin-left:-1px;background:linear-gradient(180deg,transparent,rgba(125,166,255,.7),transparent)}
.rival{position:absolute;top:1090px;width:440px}
.vs{position:absolute;left:0;right:0;top:1220px;text-align:center;font-family:"Big Shoulders Display";font-weight:800;font-size:40px;letter-spacing:.3em;color:rgba(205,218,255,.35)}
.tc{--on:0;position:relative;padding:20px 22px 18px;clip-path:polygon(0 0,calc(100% - 16px) 0,100% 16px,100% 100%,16px 100%,0 calc(100% - 16px));background:linear-gradient(160deg,color-mix(in srgb,var(--h) 12%,transparent),rgba(10,13,22,0.88) 62%);border:2px solid color-mix(in srgb,var(--h) calc(30% + 60% * var(--on)),transparent)}
.tc-top{display:flex;align-items:center;gap:12px}
.tc-mono{width:34px;height:34px;display:grid;place-items:center;font-family:"Rajdhani";font-weight:700;font-size:20px;color:#fff;background:var(--h);clip-path:polygon(0 0,100% 0,100% 72%,50% 100%,0 72%)}
.tc-name{font-family:"Rajdhani",sans-serif;font-weight:700;font-size:26px;color:var(--h);line-height:1}
.tc-cap{font-size:16px;color:rgba(200,215,255,.5);margin-top:3px}
.tc-lead{margin-left:auto;font-family:"Rajdhani";font-weight:700;font-size:13px;letter-spacing:.16em;color:#3ddc84;border:1px solid rgba(61,220,132,.55);padding:3px 7px;opacity:0}
.tc-row{display:flex;align-items:baseline;justify-content:space-between;margin-top:16px}
.tc-bud{font-family:"IBM Plex Mono",monospace;font-weight:700;font-size:36px;color:${INK}}
.tc-max{font-family:"IBM Plex Mono",monospace;font-size:15px;color:rgba(200,215,255,.45)}
.tc-max b{color:${HI};font-weight:500}
.tc-bar{height:4px;background:rgba(255,255,255,.07);margin-top:8px}
.tc-bar i{display:block;height:100%;background:var(--h)}
.tc-ros{display:grid;gap:6px;margin-top:14px}
.tc-p{display:flex;align-items:center;gap:10px;font-size:18px;min-height:26px}
.tc-p span{width:38px;font-family:"IBM Plex Mono";font-size:12px;color:rgba(200,215,255,.45)}
.tc-p b{flex:1;font-weight:500;color:rgba(236,243,255,.9)}
.tc-p em{font-style:normal;font-family:"IBM Plex Mono";font-size:15px;color:#3ddc84}
.tc-e{height:26px;border:1px dashed rgba(120,150,220,.2)}
.track{position:absolute;left:0;width:1080px}
#s2grid,#s6zoom{position:absolute;inset:0}
.stk{position:relative;display:inline-grid}
.stk > span{grid-area:1/1}
.tc-slot{position:relative}
.tc-in{position:absolute;inset:0;opacity:0;background:rgba(10,13,22,.6)}
.tl{position:absolute;width:400px;text-align:center;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:20px;letter-spacing:.34em;color:${HI}}
.logo-w{position:absolute;left:230px;top:560px;width:620px;height:237px}
.tag3{position:absolute;left:0;right:0;top:880px;display:flex;justify-content:center;gap:22px;font-family:"Big Shoulders Display",sans-serif;font-weight:800;font-size:54px;letter-spacing:.02em}
.tag3 .b{color:${BLUE}}
.cta{position:absolute;left:0;right:0;top:1090px;text-align:center;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:28px;letter-spacing:.24em;color:${INK}}
.cta i{display:block;width:420px;height:2px;margin:18px auto 0;background:${BLUE};transform-origin:50% 50%}
.cap{position:absolute;left:110px;right:110px;top:1500px;text-align:center;font-family:"Space Grotesk",sans-serif;font-weight:500;font-size:36px;line-height:1.3;color:rgba(236,243,255,0.92);text-shadow:0 2px 14px rgba(0,0,0,.65)}
`;

  const doc = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=Rajdhani:wght@600;700&family=IBM+Plex+Mono:wght@500;600;700&family=Space+Grotesk:wght@400;500;700&display=block" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${css}</style></head><body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${D}" data-width="${W}" data-height="${H}">
<div id="bg" class="clip" data-start="0" data-duration="${D}" data-track-index="0"><div id="base"></div><div id="amb"></div></div>
${html.join("\n")}
<div id="fx" class="clip" data-start="0" data-duration="${D}" data-track-index="9"><div id="grain"></div><div id="fade"></div></div>
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
  fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify({ id, duration: D, fps: spec.fps || 60, bpm: 120, bed: "premium", score: { pulse: 5.4, hold: [15.7, 18.6], groove: 18.6, sold: 24.62, full: 26.85 }, vo: spec.vo || null, hush: null, outro: 43.6, cues }, null, 1));
  return { dir, cues: cues.length };
}
