// "What if teams were bought?" — the premium VOLT reel for community owners.
// 1080x1920, ~53s, voice on vo/premium.flac at 0.5s. Restrained: whole real
// screens (desktop Kami Labs captures and the phone app), large and bleeding off
// the frame, a slow eased camera, one soft light, a quiet score (sfx/synth.py
// bed "premium") and one accent on SOLD. No captions: the type is the brief's
// on-screen lines plus a small eyebrow per chapter, all on one left margin.
// Times are absolute seconds from the voiceover's word times.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REELS as ROOT, W, H } from "./engine.mjs";

const SCREENS = path.join(ROOT, "screens"), PHONE = path.join(ROOT, "mobile", "view"), CACHE = path.join(ROOT, ".cache");
const FF = process.env.FFMPEG || "ffmpeg";
const DW = 1920, DH = 1080, PW = 780, PH = 1688;          // desktop (1920 space) and phone capture sizes
const INK = "#ecf3ff", BLUE = "#3d7bff", HI = "#7da6ff", GOLD = "#f5c453";
const J = (v) => JSON.stringify(v);
const r = (n) => Math.round(n * 1000) / 1000;
const X0 = 88;                                              // the one left margin
const EY = 196, HY = 240;                                   // eyebrow, headline tops

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
  const cue = (t, k, o = {}) => cues.push({ t: r(t), k, ...o });
  const tw = (sel, from, to, at) => js.push(`tl.fromTo(${J(sel)},${J(from)},${J({ ...to, immediateRender: to.immediateRender ?? true })},${r(at)});`);
  const to = (sel, v, at) => js.push(`tl.to(${J(sel)},${J(v)},${r(at)});`);
  const set = (sel, v, at) => js.push(`tl.set(${J(sel)},${J(v)},${r(at)});`);
  const desk = (name) => { files.set(`${name}.webp`, () => webp(path.join(SCREENS, name + ".png"), "screen-" + name + ".webp")); return `assets/${name}.webp`; };
  const phone = (name) => { const f = `phone-${name}.webp`; files.set(f, () => webp(path.join(PHONE, name + ".png"), f)); return `assets/${f}`; };

  // a timed scene: .clip > .sc (fade) — the clip itself is never tweened
  const scene = (idp, t0, d, inner, { fadeIn = 0.5, fadeOut = 0.45, track = 1 } = {}) => {
    html.push(`<div class="clip" data-start="${r(t0)}" data-duration="${r(d)}" data-track-index="${track}"><div class="sc" id="${idp}">${inner}</div></div>`);
    tw(`#${idp}`, { opacity: 0 }, { opacity: 1, duration: fadeIn, ease: "power2.inOut" }, t0);
    if (fadeOut) to(`#${idp}`, { opacity: 0, duration: fadeOut, ease: "power2.inOut" }, t0 + d - fadeOut);
  };
  // a whole screen, top-left at (x, y), w wide — desktop or phone, nothing cropped.
  // Screens are laid out at their largest size and only ever scaled down (stays sharp).
  const scr = (idp, src, { x, y, w, kind = "d", inner = "" }) => {
    const h = w * (kind === "d" ? DH / DW : PH / PW);
    return `<div class="scr ${kind === "p" ? "ph" : "dk"}" id="${idp}" style="left:${r(x)}px;top:${r(y)}px;width:${r(w)}px;height:${r(h)}px"><img src="${src}">${inner}</div>`;
  };
  // a full-width window the screens slide inside (no frame: its edges are the video's)
  const vp = (idp, top, inner) => `<div class="vp" id="${idp}" style="top:${top}px">${inner}</div>`;
  const eyebrow = (idp, text, at, out, color = HI) => {
    tw(`#${idp}`, { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.6, ease: "power2.out" }, at);
    if (out) to(`#${idp}`, { opacity: 0, duration: 0.35 }, out);
    return `<div class="eb" id="${idp}" style="color:${color}">${text}</div>`;
  };
  const enter = (sel, at, { y = 90, d = 1.5, rx = 0 } = {}) =>
    tw(sel, { opacity: 0, y, rotationX: rx, transformPerspective: 2400 }, { opacity: 1, y: 0, rotationX: 0, duration: d, ease: "expo.out" }, at);
  const fadeAway = (sel, at, d = 0.45) => to(sel, { opacity: 0, duration: d, ease: "power2.inOut" }, at);
  const w1 = (idp, text, cls = "") => `<span class="w ${cls}" id="${idp}">${text}</span>`;
  const word = (idp, text, cls = "") => `<span class="m">${w1(idp, text, cls)}</span>`;
  const riseWord = (idp, at) => tw(`#${idp}`, { yPercent: 108 }, { yPercent: 0, duration: 0.75, ease: "expo.out" }, at);
  const dropWord = (idp, at) => to(`#${idp}`, { yPercent: -108, duration: 0.5, ease: "power3.in" }, at);

  // ════════════════════════════════════════════════════════════════════
  // 1 · THE HOOK  "What if Valorant teams weren't chosen… but bought, in a live auction?"
  {
    // the live auction page, 2000 wide: the frame holds the card, the bid and SOLD
    const k = 2000 / DW;
    scene("s1", 0, 5.75, `
      <div class="hd" style="top:${HY}px">
        <div class="ln">${word("s1w0", "WHAT")} ${word("s1w1", "IF")} ${word("s1w2", "TEAMS")}</div>
        <div class="ln">${word("s1w3", "WEREN'T")} <span class="m swap">${w1("s1w4", "CHOSEN?")}${w1("s1w5", "BOUGHT.", "alt")}</span></div>
      </div>
      ${vp("s1v", 560, scr("s1s", desk("kami-auction-block"), { x: 540 - 980 * k, y: -60 * k, w: 2000,
        inner: `<i class="lite green" id="s1g" style="left:${r(1020 / DW * 100)}%;top:${r(860 / DH * 100)}%"></i>` }))}`, { fadeIn: 0.9 });
    [0.5, 0.66, 1.54, 1.86, 2.12].forEach((t, i) => riseWord(`s1w${i}`, t));
    dropWord("s1w4", 3.2); riseWord("s1w5", 3.5);
    set("#s1s", { transformOrigin: "50% 40%" }, 0);
    enter("#s1s", 0.1, { y: 140, d: 2.2, rx: 14 });
    to("#s1s", { scale: 1.06, duration: 5.4, ease: "none" }, 0.3);
    // "…in a live auction?" — the SOLD key warms up
    tw("#s1g", { opacity: 0 }, { opacity: 1, duration: 0.8, ease: "power2.out" }, 4.3);
  }

  // 2 · YOUR COMMUNITY  three phones, one per line
  {
    const pw = 420, tops = [700, 760, 820], xs = [X0, X0 + 242, X0 + 484];
    const ph = ["04-player-pool", "18-hub-season", "17-hub-overview"];
    scene("s2", 5.55, 6.75, `
      <div class="hd stack" style="top:${HY - 40}px">
        <div class="ln" id="s2t0">YOUR PLAYERS.</div><div class="ln" id="s2t1">YOUR COMMUNITY.</div><div class="ln b" id="s2t2">YOUR LEAGUE.</div></div>
      ${ph.map((f, i) => scr(`s2p${i}`, phone(f), { x: xs[i], y: tops[i], w: pw, kind: "p" })).join("")}`);
    [5.7, 7.54, 10.66].forEach((t, i) => {
      tw(`#s2t${i}`, { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7, ease: "power2.out" }, t);
      if (i) to(`#s2t${i - 1}`, { opacity: 0.3, duration: 0.5 }, t);
      enter(`#s2p${i}`, t + 0.05, { y: 120, d: 1.4 });
      if (i) to(`#s2p${i - 1}`, { filter: "brightness(0.55)", duration: 0.6 }, t + 0.1);
    });
  }

  // 3 · THE SETUP  "Players sign up. You appoint captains. And then… things get interesting."
  {
    // the Scout Hub at 2400 wide: title, counts and the first two card columns
    const k = 2400 / DW;
    scene("s3", 12.15, 6.6, `
      ${eyebrow("s3e0", "SIGN-UPS", 12.3, 13.7)}${eyebrow("s3e1", "CAPTAINS", 13.86, 15.5, GOLD)}
      ${vp("s3v", 290, scr("s3s", desk("kami-player-pool"), { x: X0 - 343 * k, y: -92 * k + 20, w: 2400,
        inner: `<i class="lite gold" id="s3g" style="left:${r(560 / DW * 100)}%;top:${r(645 / DH * 100)}%"></i>` }))}
      ${scr("s3d", phone("07-spin"), { x: 540 - 310, y: 300, w: 620, kind: "p" })}`);
    enter("#s3s", 12.2, { y: 80, d: 1.4 });
    // "You appoint captains" — across the captains' row, a gold light finds their tags
    to("#s3s", { x: -300, y: -40, duration: 1.8, ease: "power2.inOut" }, 13.8);
    tw("#s3g", { opacity: 0, xPercent: -80 }, { opacity: 1, xPercent: 60, duration: 1.6, ease: "power1.inOut" }, 14.0);
    to("#s3g", { opacity: 0, duration: 0.4 }, 15.3);
    fadeAway("#s3v", 15.45, 0.5);
    // "And then…" — the draw screen, nearly empty, waiting
    tw("#s3d", { opacity: 0, y: 60, scale: 0.97 }, { opacity: 1, y: 0, scale: 1, duration: 2.4, ease: "power2.out" }, 15.9);
    to("#s3d", { scale: 1.035, duration: 2.6, ease: "none" }, 16.2);
  }

  // 4 · THE LIVE AUCTION  "Captains go head-to-head in a live player auction. Scouting talent, outbidding rivals, and building their dream teams."
  {
    const w = 680, x = 540 - w / 2, y = 330;
    // the SOLD key on the phone capture (780 space): x 47..533, y 893..1015
    const sold = `<i class="key" id="s4k" style="left:${r(47 / PW * 100)}%;top:${r(893 / PH * 100)}%;width:${r(486 / PW * 100)}%;height:${r(122 / PH * 100)}%"></i>`;
    scene("s4", 18.6, 8.4, `
      <div class="eb" id="s4e" style="color:${INK}"><b class="live" id="s4dot"></b>LIVE AUCTION</div>
      ${scr("s4a", phone("06-auction"), { x, y, w, kind: "p", inner: sold })}
      ${scr("s4r", phone("09-rosters"), { x: X0 + 464, y: 480, w: 440, kind: "p" })}
      ${eyebrow("s4e2", "THE DREAM TEAMS", 25.6)}`);
    tw("#s4e", { opacity: 0, x: -10 }, { opacity: 1, x: 0, duration: 0.6, ease: "power2.out" }, 18.9);
    tw("#s4dot", { opacity: 0.35 }, { opacity: 1, duration: 0.6, ease: "sine.inOut", repeat: 9, yoyo: true }, 19.0);
    to("#s4e", { opacity: 0, duration: 0.3 }, 25.2);
    enter("#s4a", 18.65, { y: 160, d: 1.8, rx: 10 });
    // scouting → outbidding: the camera leans in, slowly
    set("#s4a", { transformOrigin: "50% 45%" }, 18.6);
    to("#s4a", { scale: 1.03, duration: 5.6, ease: "none" }, 19.0);
    // SOLD — the key lights, one quiet accent
    tw("#s4k", { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "expo.out" }, 24.62);
    cue(24.62, "sold", { g: 0.5 });
    // "…building their dream teams" — the auction steps aside for the rosters
    set("#s4a", { transformOrigin: "0% 0%" }, 25.2);
    to("#s4a", { x: X0 - x, y: 480 - y, scale: 440 / w, filter: "brightness(0.55)", duration: 1.2, ease: "power3.inOut" }, 25.3);
    to("#s4k", { opacity: 0, duration: 0.6 }, 25.6);
    enter("#s4r", 25.5, { y: 140, d: 1.4 });
  }

  // 5 · THE SEASON  fixtures → leaderboard → predictions → champions → all in one place
  {
    const vt = 440;                                      // the screens' window starts under the headline
    const kg = 2200 / DW, kf = 2820 / DW, kc = 1520 / DW;
    scene("s5", 26.85, 8.9, `
      ${eyebrow("s5e", "THE SEASON", 27.1)}
      <div class="hd one" style="top:${HY}px">
        ${word("s5h0", "THE MATCHUPS.")}<span class="m abs">${w1("s5h1", "THE RIVALRIES.")}</span><span class="m abs">${w1("s5h2", "THE CHAMPIONS.", "gold")}</span></div>
      ${vp("s5v", vt, `
        ${scr("s5g", desk("kami-match-modal"), { x: X0 - 343 * kg, y: 40 - 100 * kg, w: 2200 })}
        ${scr("s5f", desk("kami-final-modal"), { x: 540 - 960 * kf, y: 40 - 300 * kf, w: 2820 })}
        ${scr("s5c", desk("kami-fixtures-champion"), { x: X0 - 343 * kc, y: 40 - 60 * kc, w: 1520 })}`)}
      ${scr("s5l", phone("14-leaderboard"), { x: 1080 - X0 - 400, y: 900, w: 400, kind: "p" })}
      ${scr("s5b", phone("11-fixtures-bracket"), { x: X0 + 40, y: 1120, w: 300, kind: "p" })}
      ${scr("s5l2", phone("13-fixtures-league"), { x: 1080 - X0 - 340, y: 1120, w: 300, kind: "p" })}`);
    enter("#s5g", 27.0, { y: 120, d: 1.6 });
    // "Fixtures" — down to the results
    to("#s5g", { y: -(640 - 100) * kg, duration: 1.1, ease: "power2.inOut" }, 29.0);
    riseWord("s5h0", 29.1);
    // "leaderboards" — the phone table rises in front
    enter("#s5l", 29.95, { y: 160, d: 0.6 });
    // "predictions" — the grand final and its prediction bar
    dropWord("s5h0", 30.45); riseWord("s5h1", 30.98);
    fadeAway("#s5g", 30.55, 0.35); fadeAway("#s5l", 30.55, 0.35);
    enter("#s5f", 30.95, { y: 80, d: 1.2 });
    // "champions" — the gold banner, close
    dropWord("s5h1", 32.42); riseWord("s5h2", 32.95);
    fadeAway("#s5f", 32.5, 0.35);
    tw("#s5c", { opacity: 0 }, { opacity: 1, duration: 0.6, ease: "power2.out" }, 32.95);
    // "All in one place" — pull back to the whole page, the phone views beside it
    set("#s5c", { transformOrigin: "0% 0%" }, 0);
    to("#s5c", { scale: 904 / 1520, x: 343 * kc, y: 60 * kc, duration: 1.4, ease: "power3.inOut" }, 34.1);
    enter("#s5b", 34.5, { y: 120, d: 1.2 }); enter("#s5l2", 34.65, { y: 120, d: 1.2 });
  }

  // 6 · THE BENEFIT  the dashboard home, and the same league in your pocket
  {
    const kd = 2592 / DW;                                // close on the hero, then the whole home screen
    scene("s6", 35.6, 8.15, `
      ${eyebrow("s6e", "YOUR DASHBOARD", 35.9)}
      ${vp("s6v", 300, scr("s6d", desk("kami-dashboard"), { x: X0 - 343 * kd, y: -30 * kd, w: 2592 }))}
      ${scr("s6p", phone("01-dashboard"), { x: 1080 - X0 - 360, y: 1000, w: 360, kind: "p" })}`);
    set("#s6d", { transformOrigin: "0% 0%" }, 0);
    tw("#s6d", { opacity: 0 }, { opacity: 1, duration: 0.8, ease: "power2.out" }, 35.65);
    // glide across: the live auction hero → bids, sales and every captain's purse
    to("#s6d", { x: -(1090 - 343) * kd, duration: 3.2, ease: "power1.inOut" }, 36.1);
    // pull back to the whole home screen
    to("#s6d", { scale: 904 / 2592, x: 343 * kd, y: 120 + 30 * kd, duration: 1.6, ease: "power3.inOut" }, 39.4);
    enter("#s6p", 40.6, { y: 160, d: 1.5 });
  }

  // 7 · BRAND REVEAL  "This is VOLT. Your community. Your league. Your rules."
  {
    const lg = `<svg class="logo" viewBox="0 0 1100 420" width="620" height="237"><defs>
      <linearGradient id="gb7" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8db3ff"/><stop offset="0.55" stop-color="#3d7bff"/><stop offset="1" stop-color="#1f47c9"/></linearGradient>
      <linearGradient id="ga7" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9cbef"/></linearGradient></defs>
      <g transform="scale(0.5036)"><path id="l7a" d="${ARM}" fill="url(#ga7)"/><path id="l7b" d="${BOLT}" fill="url(#gb7)"/></g>
      <g transform="translate(205 90) scale(6)" fill="#f4f8ff"><path id="l7o" fill-rule="evenodd" d="M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z"/><path id="l7l" d="M80 0H89.5V31H105V40H80Z"/><path id="l7t" d="M109 0H146V9.5H132.25V40H122.75V9.5H109Z"/></g></svg>`;
    scene("s7", 43.6, D - 43.6, `
      <div class="glow" id="s7g" style="top:420px"></div>
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

  // background light drifts very slowly; the frame breathes, nothing else
  tw("#amb", { x: -60, y: -20 }, { x: 60, y: 30, duration: D, ease: "sine.inOut" }, 0);
  tw("#fade", { opacity: 1 }, { opacity: 0, duration: 0.6, ease: "power1.out" }, 0);

  const css = `
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#090c16}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#090c16;color:${INK};font-family:"Space Grotesk",sans-serif;-webkit-font-smoothing:antialiased}
.clip{position:absolute;inset:0}
.sc{position:absolute;inset:0}
#amb{position:absolute;left:-200px;right:-200px;top:-300px;height:1500px;background:radial-gradient(ellipse 55% 45% at 50% 40%,rgba(61,123,255,0.14),rgba(61,123,255,0) 70%)}
#base{position:absolute;inset:0;background:linear-gradient(180deg,#0b1020 0%,#090c16 55%,#07090f 100%)}
#grain{position:absolute;inset:-40px;opacity:.035;mix-blend-mode:overlay;background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='240' height='240'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' seed='4' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")}
#fade{position:absolute;inset:0;background:#000}
.glow{position:absolute;left:50%;width:1300px;height:900px;margin-left:-650px;background:radial-gradient(closest-side,rgba(61,123,255,0.22),rgba(61,123,255,0.07) 55%,rgba(61,123,255,0));pointer-events:none}
.vp{position:absolute;left:0;right:0;bottom:0;overflow:hidden}
.scr{position:absolute;overflow:hidden}
.scr > img{position:absolute;inset:0;width:100%;height:100%}
.scr.dk{border-radius:20px;box-shadow:0 50px 120px rgba(0,0,0,.6),0 0 0 1px rgba(150,180,255,.10)}
.scr.ph{border-radius:44px;box-shadow:0 40px 100px rgba(0,0,0,.65),0 0 0 1.5px rgba(160,190,255,.16)}
.lite{position:absolute;width:900px;height:420px;margin:-210px 0 0 -450px;border-radius:50%;mix-blend-mode:screen;opacity:0;pointer-events:none}
.lite.green{background:radial-gradient(closest-side,rgba(61,220,132,.42),rgba(61,220,132,0))}
.lite.gold{width:1100px;height:520px;margin:-260px 0 0 -550px;background:radial-gradient(closest-side,rgba(245,196,83,.30),rgba(245,196,83,0))}
.key{position:absolute;opacity:0;mix-blend-mode:screen;background:rgba(61,220,132,.35);box-shadow:0 0 60px 16px rgba(61,220,132,.55),0 0 160px 40px rgba(61,220,132,.25);clip-path:polygon(4% 0,100% 0,96% 100%,0 100%)}
.eb{position:absolute;left:${X0}px;top:${EY}px;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:24px;letter-spacing:.38em;display:flex;align-items:center;gap:16px}
.eb .live{width:14px;height:14px;border-radius:50%;background:#ff4655;box-shadow:0 0 18px rgba(255,70,85,.8)}
.hd{position:absolute;left:${X0}px;right:${X0}px;font-family:"Big Shoulders Display",sans-serif;font-weight:800;font-size:132px;line-height:.98;letter-spacing:.005em;text-transform:uppercase;color:${INK}}
.hd .ln{display:block}
.hd .m{display:inline-block;overflow:hidden;vertical-align:top;padding:0 .02em}
.hd .w{display:inline-block}
.hd .swap{position:relative}
.hd .swap .alt{position:absolute;left:.02em;top:0;color:${BLUE}}
.hd.stack{font-size:112px;line-height:1.0}
.hd.stack .b{color:${BLUE}}
.hd.one{height:140px}
.hd.one .abs{position:absolute;left:0;top:0}
.hd .gold{color:${GOLD}}
.logo-w{position:absolute;left:230px;top:620px;width:620px;height:237px}
.tag3{position:absolute;left:0;right:0;top:940px;display:flex;justify-content:center;gap:22px;font-family:"Big Shoulders Display",sans-serif;font-weight:800;font-size:54px;letter-spacing:.02em}
.tag3 .b{color:${BLUE}}
.cta{position:absolute;left:0;right:0;top:1150px;text-align:center;font-family:"IBM Plex Mono",monospace;font-weight:600;font-size:28px;letter-spacing:.24em;color:${INK}}
.cta i{display:block;width:420px;height:2px;margin:18px auto 0;background:${BLUE};transform-origin:50% 50%}
`;

  const doc = `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=${W}, height=${H}">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Big+Shoulders+Display:wght@800;900&family=IBM+Plex+Mono:wght@500;600;700&family=Space+Grotesk:wght@400;500;700&display=block" rel="stylesheet">
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
  fs.rmSync(path.join(dir, "assets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const [name, src] of files) fs.copyFileSync(src(), path.join(dir, "assets", name));
  fs.writeFileSync(path.join(dir, "index.html"), doc);
  cues.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify({ id, duration: D, fps: spec.fps || 60, bpm: 120, bed: "premium", score: { pulse: 5.4, hold: [15.7, 18.6], groove: 18.6, sold: 24.62, full: 26.85 }, vo: spec.vo || null, hush: null, outro: 43.6, cues }, null, 1));
  return { dir, cues: cues.length };
}
