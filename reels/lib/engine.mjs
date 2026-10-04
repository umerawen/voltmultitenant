// VOLT reel engine: turns a reel spec (scenes on a timeline) into a
// HyperFrames project — index.html (1080x1920, one paused GSAP timeline),
// assets/ (screens + art) and cues.json (the SFX cue sheet sfx/synth.py mixes).
//
// Scenes are absolutely timed ({ t, d } in seconds). Cuts sit on a 120 BPM
// grid (0.5s) so they land on the bed's beats.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REELS = path.resolve(HERE, "..");
const SCREENS = path.join(REELS, "screens");
const PUBLIC_IMG = path.resolve(REELS, "../public/img");
const CACHE = path.join(REELS, ".cache");
const FFMPEG = process.env.FFMPEG || "ffmpeg";

export const W = 1080, H = 1920;
const SW = 1920, SH = 1080; // screen capture size in CSS px (files are 2x)

// ── colour + text helpers ────────────────────────────────────────────────
export const C = { volt: "#3d7bff", voltHi: "#7da6ff", hot: "#ff4655", money: "#3ddc84", gold: "#f5c453", ink: "#ecf3ff" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// [red]  {blue}  |green|  ~gold~
export function rich(s) {
  return esc(s)
    .replace(/\[([^\]]+)\]/g, '<span class="c-hot">$1</span>')
    .replace(/\{([^}]+)\}/g, '<span class="c-volt">$1</span>')
    .replace(/\|([^|]+)\|/g, '<span class="c-money">$1</span>')
    .replace(/~([^~]+)~/g, '<span class="c-gold">$1</span>');
}
const J = (v) => JSON.stringify(v);
const r2 = (n) => Math.round(n * 1000) / 1000;

function marksFor(shot) {
  const f = path.join(SCREENS, shot + ".json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

// ── assets ───────────────────────────────────────────────────────────────
function cachedWebp(src, name, scale) {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, name);
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
    const vf = scale ? ["-vf", scale] : [];
    execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-i", src, ...vf, "-c:v", "libwebp", "-quality", "92", "-compression_level", "6", out]);
  }
  return out;
}

// ── the reel ─────────────────────────────────────────────────────────────
export function reel(spec) {
  const { id, duration } = spec;
  const dir = path.join(REELS, "videos", id);
  const assets = new Set();
  const html = [];
  const js = [];
  const cues = [];
  let uid = 0;
  const nid = (p) => `${p}${++uid}`;

  const asset = (kind, name) => {
    // kind: "screen" | "img" | "agent"
    if (kind === "screen") { assets.add(["screen", name]); return `assets/${name}.webp`; }
    assets.add(["img", name]); return `assets/${name.replace(/\//g, "-").replace(/\.\w+$/, "")}.webp`;
  };
  const cue = (t, k, o = {}) => cues.push({ t: r2(t), k, ...o });
  const tw = (sel, from, to, at) => js.push(`tl.fromTo(${J(sel)},${J(from)},${J({ ...to, immediateRender: to.immediateRender ?? true })},${r2(at)});`);
  const tset = (sel, v, at) => js.push(`tl.set(${J(sel)},${J(v)},${r2(at)});`);
  const tto = (sel, to, at) => js.push(`tl.to(${J(sel)},${J(to)},${r2(at)});`);

  // Counter: writes formatted numbers into an element.
  const counter = (sel, from, to, at, dur, fmt = {}) => {
    const f = { prefix: "", suffix: "", dec: 0, comma: true, ...fmt };
    js.push(`(function(){const el=document.querySelector(${J(sel)});const o={v:${from}};const f=${J(f)};const w=(v)=>{let s=v.toFixed(f.dec);if(f.comma){const p=s.split('.');p[0]=p[0].replace(/\\B(?=(\\d{3})+(?!\\d))/g,',');s=p.join('.');}el.textContent=f.prefix+s+f.suffix;};w(${from});tl.fromTo(o,{v:${from}},{v:${to},duration:${dur},ease:"power2.out",immediateRender:false,onUpdate:()=>w(o.v)},${r2(at)});})();`);
  };
  const fmtNum = (v, f = {}) => {
    let s = Number(v).toFixed(f.dec || 0);
    if (f.comma !== false) { const p = s.split("."); p[0] = p[0].replace(/\B(?=(\d{3})+(?!\d))/g, ","); s = p.join("."); }
    return (f.prefix || "") + s + (f.suffix || "");
  };

  // Lines of display type that rise out of a mask, staggered.
  const lines = (sid, arr, { size = 104, at, stagger = 0.09, cls = "" } = {}) => {
    const out = arr.map((l, i) => `<div class="ln ${cls}" style="font-size:${size}px"><span id="${sid}-l${i}" class="ln-i">${rich(l)}</span></div>`).join("");
    arr.forEach((_, i) => tw(`#${sid}-l${i}`, { yPercent: 115, opacity: 1 }, { yPercent: 0, duration: 0.55, ease: "power4.out" }, at + i * stagger));
    return out;
  };
  const label = (sid, text, at, { color } = {}) => {
    tw(`#${sid}-lab`, { opacity: 0, x: -24 }, { opacity: 1, x: 0, duration: 0.4, ease: "power3.out" }, at);
    tw(`#${sid}-labr`, { scaleX: 0 }, { scaleX: 1, duration: 0.6, ease: "power3.out" }, at + 0.1);
    return `<div class="lab" id="${sid}-lab"${color ? ` style="color:${color}"` : ""}><span>// ${esc(text)}</span><i id="${sid}-labr"></i></div>`;
  };
  const stripe = (sid, at, { w = 220, color = C.hot } = {}) => {
    tw(`#${sid}-st`, { scaleX: 0 }, { scaleX: 1, duration: 0.45, ease: "expo.out" }, at);
    return `<div class="stripe" id="${sid}-st" style="width:${w}px;background:${color}"></div>`;
  };

  // Scene wrapper with enter / exit.
  const scene = (s, inner, { enter = "rise", exit = "fade" } = {}) => {
    const sid = s._id;
    // Cross-fade: a scene starts OV early so it is already rising while the
    // previous one leaves (no empty frame at the cut).
    const OV = s.t > 0 && enter !== "zoom" ? 0.2 : 0;
    const t0 = s.t - OV;
    html.push(`<div id="${sid}" class="clip scene" data-start="${r2(t0)}" data-duration="${r2(s.d + OV)}" data-track-index="${s.track ?? 1}"><div class="sc-in" id="${sid}-in"><div class="sc-out" id="${sid}-out">${inner}</div></div></div>`);
    if (enter === "rise") tw(`#${sid}-in`, { opacity: 0, y: 70, scale: 1.02 }, { opacity: 1, y: 0, scale: 1, duration: 0.55, ease: "power3.out" },t0);
    else if (enter === "zoom") tw(`#${sid}-in`, { opacity: 0, scale: 1.12 }, { opacity: 1, scale: 1, duration: 0.6, ease: "expo.out" }, s.t);
    else if (enter === "left") tw(`#${sid}-in`, { opacity: 0, x: 220 }, { opacity: 1, x: 0, duration: 0.55, ease: "expo.out" },t0);
    else if (enter === "fade") tw(`#${sid}-in`, { opacity: 0 }, { opacity: 1, duration: 0.5, ease: "power2.out" },t0);
    if (exit === "fade") tto(`#${sid}-out`, { opacity: 0, y: -50, scale: 0.98, duration: 0.32, ease: "power2.in" }, s.t + s.d - 0.32);
    else if (exit === "left") tto(`#${sid}-out`, { opacity: 0, x: -260, duration: 0.32, ease: "power3.in" }, s.t + s.d - 0.32);
    else if (exit === "zoom") tto(`#${sid}-out`, { opacity: 0, scale: 1.15, duration: 0.32, ease: "power2.in" }, s.t + s.d - 0.32);
  };
  // A light band across the frame at a cut, plus its whoosh.
  const sweep = (at, { sound = true } = {}) => {
    const id = nid("sw");
    html.push(`<div id="${id}" class="clip sweep-c" data-start="${r2(Math.max(0, at - 0.3))}" data-duration="0.8" data-track-index="9"><div class="sweep" id="${id}-b"></div></div>`);
    tw(`#${id}-b`, { xPercent: -160, opacity: 0.9 }, { xPercent: 160, duration: 0.7, ease: "power2.inOut" }, Math.max(0, at - 0.3));
    if (sound) cue(at - 0.32, "whoosh");
  };

  // ── scene kinds ─────────────────────────────────────────────────────
  const kinds = {};

  // Big kinetic statement. Optional art band (landscape key art) or agent cut-out.
  kinds.hook = (s) => {
    const sid = s._id, at = s.t + (s.delay ?? (s.t > 0 ? -0.12 : 0.15));
    let bgEl = "";
    if (s.art) {
      const src = asset("img", s.art.src);
      const h = s.art.h || 1250, iw = (s.art.w || 1800) * (h / (s.art.ih || 1014));
      const left = Math.round(540 - (s.art.fx ?? 0.6) * iw);
      bgEl = `<div class="art"><img id="${sid}-art" src="${src}" style="height:${h}px;width:${Math.round(iw)}px;left:${left}px"><div class="art-fade"></div></div>`;
      tw(`#${sid}-art`, { opacity: 0 }, { opacity: 1, duration: 0.7, ease: "power2.out" }, s.t);
      tw(`#${sid}-art`, { scale: 1.1 }, { scale: 1.0, duration: s.d, ease: "power1.out" }, s.t);
    } else if (s.agent) {
      const src = asset("img", s.agent + ".webp");
      bgEl = `<div class="agent" style="${s.agentSide === "left" ? "left:-120px" : "right:-140px"}"><img id="${sid}-ag" src="${src}"><div class="agent-glow"></div></div>`;
      tw(`#${sid}-ag`, { x: s.agentSide === "left" ? -80 : 80, opacity: 0 }, { x: 0, opacity: 0.95, duration: 0.9, ease: "power3.out" }, s.t);
      tto(`#${sid}-ag`, { y: -30, duration: s.d - 0.9, ease: "none" }, s.t + 0.9);
    }
    if (s.ghost) {
      bgEl += `<div class="ghost" id="${sid}-gh">${esc(s.ghost)}</div>`;
      tw(`#${sid}-gh`, { opacity: 0, x: 120 }, { opacity: 1, x: 0, duration: 1.2, ease: "power3.out" }, s.t);
      tto(`#${sid}-gh`, { x: -60, duration: s.d - 1.2, ease: "none" }, s.t + 1.2);
    }
    const pos = s.art || s.agent ? "bottom:380px" : "top:700px";
    const inner = `${bgEl}<div class="hook-txt" style="${pos}">${s.label ? label(sid, s.label, at) : ""}${lines(sid, s.lines, { size: s.size || 150, at: at + 0.1 })}${s.stripe !== false ? stripe(sid, at + 0.45, { w: s.stripeW || 260, color: s.stripeColor || C.hot }) : ""}${s.sub ? `<div class="sub" id="${sid}-sub">${rich(s.sub)}</div>` : ""}</div>`;
    if (s.sub) tw(`#${sid}-sub`, { opacity: 0, y: 24 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, at + 0.45 + s.lines.length * 0.09);
    cue(at + 0.1, "pop", { p: 0, g: 0.5 });
    scene(s, inner, { enter: s.enter || "fade", exit: s.exit || "fade" });
  };

  // canvas-space toasts (one replaces the next unless they say otherwise)
  const mkToasts = (s, sid) => (s.toasts || []).map((o, i) => {
    const id2 = nid(sid + "-to");
    const at = s.t + o.at, side = o.side || (i % 2 ? "left" : "right");
    const y = o.y ?? 1400;
    if (o.d == null && s.toasts[i + 1]) o.d = s.toasts[i + 1].at - o.at - 0.05;
    tw(`#${id2}`, { x: side === "right" ? 160 : -160, opacity: 0 }, { x: 0, opacity: 1, duration: 0.5, ease: "expo.out" }, at);
    if (o.d) tto(`#${id2}`, { opacity: 0, x: side === "right" ? 60 : -60, duration: 0.3 }, at + o.d);
    cue(at, o.sound || "pop", { p: o.p ?? i + 1, g: 0.7 });
    return `<div class="toast ${side}" id="${id2}" style="top:${y}px;border-left-color:${o.color || C.volt}"><div class="toast-k" style="color:${o.color || C.voltHi}">${rich(o.k || "")}</div><div class="toast-v">${rich(o.v)}</div></div>`;
  }).join("");
  // a stamp slammed over everything; shakeSel gets a short jolt
  const mkStamp = (s, sid, shakeSel) => {
    if (!s.stamp) return "";
    const st = s.stamp, at = s.t + st.at, col = st.color || C.money;
    tw(`#${sid}-stamp`, { scale: 2.4, opacity: 0, rotation: -14 }, { scale: 1, opacity: 1, rotation: -6, duration: 0.42, ease: "expo.out" }, at);
    tw(`#${sid}-fl`, { opacity: 0 }, { keyframes: { opacity: [0, 0.35, 0] }, duration: 0.65, ease: "power2.out" }, at + 0.08);
    if (shakeSel) tw(shakeSel, { x: 0 }, { keyframes: { x: [0, -14, 11, -7, 4, 0] }, duration: 0.42, ease: "none", immediateRender: false }, at + 0.1);
    cue(at - 1.1, "swell", { d: 1.1, g: 0.6 });
    cue(at + 0.08, "thump", { g: 1 });
    cue(at + 0.12, "chime", { p: 0, g: 0.55 });
    return `<div class="stamp-wrap" style="top:${st.y ?? 900}px"><div class="stamp" id="${sid}-stamp" style="--c:${col}"><div class="stamp-t"${st.size ? ` style="font-size:${st.size}px"` : ""}>${rich(st.text)}</div>${st.sub ? `<div class="stamp-s">${rich(st.sub)}</div>` : ""}</div></div><div class="flash" id="${sid}-fl"></div>`;
  };

  // A product screen in a browser frame (or full bleed) with a moving camera.
  kinds.screen = (s) => {
    const sid = s._id;
    const marks = marksFor(s.shot);
    const full = s.frame === false;
    const VW = full ? W : 960, VH = full ? H : 1000;
    const rectOf = (m, pad = 0) => {
      const r = Array.isArray(m) ? { x: m[0], y: m[1], w: m[2], h: m[3] } : marks[m];
      if (!r) throw new Error(`${id}: mark "${m}" not found in ${s.shot}.json`);
      return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
    };
    // camera state for a focus: center + visible width in screen px
    const camOf = (k) => {
      let cx, cy, vw;
      if (k.center) [cx, cy] = k.center; else { const r = rectOf(k.focus); cx = r.x + r.w / 2; cy = r.y + r.h / 2; }
      vw = k.w || (k.focus ? Math.max(rectOf(k.focus).w * 1.6, 520) : 1000);
      vw = Math.min(vw, VW * SH / VH); // always cover the view
      if (full && k.w && k.w < vw) vw = Math.max(k.w, 440); // full bleed may push closer
      const sc = VW / vw, vh = VH / sc;
      if (vw < SW) cx = Math.min(Math.max(cx, vw / 2), SW - vw / 2); else cx = SW / 2;
      if (vh < SH) cy = Math.min(Math.max(cy, vh / 2), SH - vh / 2); else cy = SH / 2;
      // full-bleed: the headline owns the top, so the subject sits lower
      const fy = full ? 0.6 : 0.5;
      if (full && vh < SH) cy = Math.min(Math.max(cy - (fy - 0.5) * vh, vh / 2), SH - vh / 2);
      return { s: sc, x: VW / 2 - cx * sc, y: VH / 2 - cy * sc };
    };
    const cam = s.cam || [{ at: 0, w: 1100 }];
    const plate = `${sid}-pl`;
    const states = cam.map((k) => ({ ...camOf(k), at: s.t + (k.at || 0), dur: k.dur ?? 0.9, ease: k.ease || "power3.inOut" }));
    const scaleAt = (t) => { let st = states[0]; for (const x of states) if (x.at <= t) st = x; return st.s; };
    tset(`#${plate}`, { transformOrigin: "0 0", x: states[0].x, y: states[0].y, scale: states[0].s * 0.94 }, 0);
    // first: a gentle settle in; then each move; between moves a slow drift
    tw(`#${plate}`, { x: states[0].x + VW * 0.03, y: states[0].y + VH * 0.03, scale: states[0].s * 0.94 }, { x: states[0].x, y: states[0].y, scale: states[0].s, duration: 1.0, ease: "power3.out" }, s.t);
    states.forEach((st, i) => {
      const prev = i ? states[i - 1] : null;
      if (prev) {
        const pd = (prev.dr || prev);
        tw(`#${plate}`, { x: pd.x, y: pd.y, scale: pd.s }, { x: st.x, y: st.y, scale: st.s, duration: st.dur, ease: st.ease, immediateRender: false }, st.at);
        cue(st.at, "air", { g: 0.35 });
      }
      const holdStart = i ? st.at + st.dur : s.t + 1.0;
      const next = states[i + 1];
      const holdEnd = next ? next.at : s.t + s.d;
      if (holdEnd - holdStart > 0.3) {
        // drift: zoom 2.5% about the same center
        const k = 1.025, cxv = VW / 2, cyv = VH / 2;
        const dr = { s: st.s * k, x: cxv - (cxv - st.x) * k, y: cyv - (cyv - st.y) * k };
        tw(`#${plate}`, { x: st.x, y: st.y, scale: st.s }, { x: dr.x, y: dr.y, scale: dr.s, duration: holdEnd - holdStart, ease: "none", immediateRender: false }, holdStart);
        st.dr = dr;
      }
    });

    // overlays in screen space (they ride the camera)
    const ov = [];
    for (const o of s.marks || []) {
      const oid = nid(sid + "-m");
      const r = rectOf(o.mark, o.pad ?? 8);
      const at = s.t + o.at;
      const sc = scaleAt(at + 0.01) * 1.0125;
      const bw = 3 / sc, arm = 22 / sc;
      const color = o.color || C.volt;
      if (o.kind === "pulse") {
        ov.push(`<div id="${oid}" class="ov-pulse" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;border:${bw}px solid ${color};box-shadow:0 0 ${24 / sc}px ${color}"></div>`);
        tw(`#${oid}`, { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: 0.45, ease: "power3.out" }, at);
        tto(`#${oid}`, { opacity: 0, duration: 0.4 }, at + (o.d || 1.6));
      } else {
        // corner brackets + soft fill
        const c = (pos) => `<i style="${pos};width:${arm}px;height:${arm}px;border-color:${color};border-width:${bw}px"></i>`;
        ov.push(`<div id="${oid}" class="ov-box" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;background:${o.fill === false ? "transparent" : color + "1f"};box-shadow:0 0 ${40 / sc}px ${color}55">${c("left:0;top:0;border-right:0;border-bottom:0;border-style:solid")}${c("right:0;top:0;border-left:0;border-bottom:0;border-style:solid")}${c("left:0;bottom:0;border-right:0;border-top:0;border-style:solid")}${c("right:0;bottom:0;border-left:0;border-top:0;border-style:solid")}</div>`);
        tw(`#${oid}`, { opacity: 0, scale: 1.18 }, { opacity: 1, scale: 1, duration: 0.42, ease: "back.out(1.6)" }, at);
        if (o.d) tto(`#${oid}`, { opacity: 0, duration: 0.35 }, at + o.d);
      }
      if (o.tag) {
        const tid = oid + "t", fs = (o.tagSize || 30) / sc;
        const above = o.tagPos !== "below";
        ov.push(`<div id="${tid}" class="ov-tag" style="left:${r.x}px;${above ? `top:${r.y - fs * 1.9}px` : `top:${r.y + r.h + fs * 0.5}px`};font-size:${fs}px;background:${color};padding:${fs * 0.18}px ${fs * 0.45}px">${rich(o.tag)}</div>`);
        tw(`#${tid}`, { opacity: 0, y: 12 / sc }, { opacity: 1, y: 0, duration: 0.35, ease: "power3.out" }, at + 0.15);
        if (o.d) tto(`#${tid}`, { opacity: 0, duration: 0.35 }, at + o.d);
      }
      cue(at, o.sound || "pop", { p: o.p ?? 2, g: 0.6 });
    }
    // cursor (screen space)
    for (const cu of s.cursor || []) {
      const cid = nid(sid + "-cu");
      const to = rectOf(cu.to);
      const tx = to.x + to.w * (cu.fx ?? 0.5), ty = to.y + to.h * (cu.fy ?? 0.55);
      const [fx, fy] = cu.from || [tx + 260, ty + 220];
      const at = s.t + cu.at, sc = scaleAt(at + 0.5);
      const size = 46 / sc;
      ov.push(`<div id="${cid}" class="cursor" style="left:0;top:0;width:${size}px;height:${size}px"><svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.3-2.8 1.5-3.9-7.4L4.9 19z" fill="#fff" stroke="#0a0d18" stroke-width="1.4" stroke-linejoin="round"/></svg></div><div id="${cid}r" class="ripple" style="left:${tx - 40 / sc}px;top:${ty - 40 / sc}px;width:${80 / sc}px;height:${80 / sc}px;border-width:${3 / sc}px"></div>`);
      tw(`#${cid}`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, at);
      tw(`#${cid}`, { x: fx, y: fy }, { x: tx, y: ty, duration: 0.75, ease: "power3.inOut" }, at + 0.1);
      if (cu.click !== false) {
        tw(`#${cid}`, { scale: 1 }, { scale: 0.82, duration: 0.09, yoyo: true, repeat: 1, ease: "power1.inOut", immediateRender: false }, at + 0.9);
        tw(`#${cid}r`, { opacity: 0 }, { keyframes: { opacity: [0, 0.9, 0] }, duration: 0.6, ease: "none" }, at + 0.9);
        tw(`#${cid}r`, { scale: 0.2 }, { scale: 1.4, duration: 0.6, ease: "power2.out" }, at + 0.9);
        cue(at + 0.92, "click");
      }
      tto(`#${cid}`, { opacity: 0, duration: 0.3 }, at + (cu.d || 1.8));
    }

    const img = asset("screen", s.shot);
    const plateEl = `<div class="plate" id="${plate}"><img src="${img}" width="${SW}" height="${SH}">${ov.join("")}</div>`;
    const crumbs = s.url || "APEX LEAGUE";
    const view = full
      ? `<div class="view full" style="width:${VW}px;height:${VH}px">${plateEl}<div class="full-shade"></div></div>`
      : `<div class="bw-wrap" id="${sid}-bw"><div class="bw"><div class="bw-bar"><b></b><b></b><b></b><span class="bw-url"><em>VOLT</em> / ${esc(crumbs)}</span><span class="bw-live">● LIVE</span></div><div class="view" style="width:${VW}px;height:${VH}px">${plateEl}<div class="view-vig"></div></div></div><i class="br tl"></i><i class="br tr"></i><i class="br bl"></i><i class="br brr"></i></div>`;
    if (!full) tw(`#${sid}-bw`, { y: 120, opacity: 0, rotationX: 14, transformPerspective: 1600 }, { y: 0, opacity: 1, rotationX: 0, duration: 0.8, ease: "expo.out" }, s.t - 0.15);

    // headline above the frame (or over the top of a full-bleed shot)
    let head = "";
    if (s.head) {
      const at = s.t + 0.02;
      head = `<div class="head${full ? " head-full" : ""}">${s.head.label ? label(sid, s.head.label, at) : ""}${lines(sid, s.head.lines, { size: s.head.size || 100, at: at + 0.08 })}</div>`;
    }
    const toasts = mkToasts(s, sid);
    const stamp = mkStamp(s, sid, full ? null : `#${sid}-bw`);
    // a counter shown above / over the frame
    let count = "";
    if (s.count) {
      const k = s.count, at = s.t + k.at;
      count = `<div class="count" style="top:${k.y ?? 560}px"><div class="count-k">${rich(k.label || "")}</div><div class="count-v" id="${sid}-cv" style="color:${k.color || C.money}">${fmtNum(k.from, k)}</div></div>`;
      counter(`#${sid}-cv`, k.from, k.to, at, k.dur || 1.6, k);
      tw(`#${sid}-cv`, { scale: 1.0 }, { scale: 1.08, duration: 0.18, yoyo: true, repeat: 1, ease: "power2.out", immediateRender: false }, at + (k.dur || 1.6));
      cue(at, "rise", { d: k.dur || 1.6, g: 0.5 });
      cue(at + (k.dur || 1.6), "chime", { p: 2, g: 0.6 });
    }
    const pos = full ? "" : `style="top:${s.frameY ?? 600}px"`;
    scene(s, `<div class="frame-pos" ${pos}>${view}</div>${head}${count}${toasts}${stamp}`, { enter: s.enter || "fade", exit: s.exit || "fade" });
  };

  // The whole screen as a floating, tilted plane — nothing cropped — and the
  // parts that matter lift off it as big, readable cards (exploded UI).
  //   plate:  [{ at, rx, ry, s, dur }]      poses of the plane (deg)
  //   pieces: [{ at, d, rect, w, x, y, live, focus }]
  //   heads:  [{ at, label, lines, size }]   headline per beat
  //   cursor: [{ at, x, y, d }]              canvas-space click
  kinds.stage = (s) => {
    const sid = s._id;
    const marks = marksFor(s.shot);
    const rectOf = (m) => {
      const r = Array.isArray(m) ? { x: m[0], y: m[1], w: m[2], h: m[3] } : marks[m];
      if (!r) throw new Error(`${id}: mark "${m}" not found in ${s.shot}.json`);
      return r;
    };
    const PW = s.plateW || 1000, k = PW / SW, PH = SH * k, P = 2400;
    const CX = 540, CY = s.plateY ?? 1000;
    const pl = `${sid}-p3`, pos = `${sid}-pp`;
    const poses = (s.plate || [{ at: 0 }]).map((p) => ({ rx: 14, ry: -16, s: 1, dur: 1.2, ...p, at: s.t + (p.at || 0) }));
    const rad = Math.PI / 180;
    const project = (p, px, py) => {
      const lx = (px - SW / 2) * k * p.s, ly = (py - SH / 2) * k * p.s;
      const a = p.rx * rad, b = p.ry * rad;
      const y1 = ly * Math.cos(a), z1 = ly * Math.sin(a);
      const x2 = lx * Math.cos(b) + z1 * Math.sin(b), z2 = -lx * Math.sin(b) + z1 * Math.cos(b);
      const f = P / (P - z2);
      return [CX + x2 * f, CY + y1 * f];
    };
    const poseAt = (t) => { let q = poses[0]; for (const p of poses) if (p.at <= t) q = p; return q; };

    // plane: fly in, then poses with a slow drift between them
    const p0 = poses[0];
    const base = { transformPerspective: P, transformOrigin: "50% 50%" };
    if (s.flyIn !== false) tw(`#${pl}`, { ...base, rotationX: 50, rotationY: -40, scale: p0.s * 0.72, opacity: 0, y: 260 }, { rotationX: p0.rx, rotationY: p0.ry, scale: p0.s, opacity: 1, y: 0, duration: 1.15, ease: "expo.out" }, s.t - 0.15);
    else tw(`#${pl}`, { ...base, rotationX: p0.rx, rotationY: p0.ry, scale: p0.s, opacity: 1, y: 0 }, { rotationX: p0.rx, rotationY: p0.ry, scale: p0.s, opacity: 1, y: 0, duration: 0.01 }, s.t - 0.2);
    let last = { rx: p0.rx, ry: p0.ry, s: p0.s };
    poses.forEach((p, i) => {
      const arrive = i ? p.at + p.dur : s.t + 1.0;
      if (i) tw(`#${pl}`, { rotationX: last.rx, rotationY: last.ry, scale: last.s }, { rotationX: p.rx, rotationY: p.ry, scale: p.s, duration: p.dur, ease: "power2.inOut", immediateRender: false }, p.at);
      const until = poses[i + 1] ? poses[i + 1].at : s.t + s.d;
      if (until - arrive > 0.3) {
        const dr = { rx: p.rx - 1.5, ry: p.ry + 4, s: p.s * 1.02 };
        tw(`#${pl}`, { rotationX: p.rx, rotationY: p.ry, scale: p.s }, { rotationX: dr.rx, rotationY: dr.ry, scale: dr.s, duration: until - arrive, ease: "none", immediateRender: false }, arrive);
        last = dr;
      } else last = { rx: p.rx, ry: p.ry, s: p.s };
    });
    tw(`#${pos}`, { y: 14 }, { y: -14, duration: s.d, ease: "sine.inOut" }, s.t);

    // pieces
    const img = asset("screen", s.shot);
    const hl = [];
    const pieces = (s.pieces || []).map((pc, i) => {
      const id2 = `${sid}-pc${i}`, r = rectOf(pc.rect);
      const S = pc.w / r.w, W2 = r.w * S, H2 = r.h * S;
      const cx = pc.x ?? 540, cy = pc.y ?? 1020, at = s.t + pc.at;
      const pose = poseAt(at);
      const [ox, oy] = project(pose, r.x + r.w / 2, r.y + r.h / 2);
      const [ax] = project(pose, r.x, r.y + r.h / 2), [bx] = project(pose, r.x + r.w, r.y + r.h / 2);
      const s0 = Math.max(Math.abs(bx - ax) / W2, 0.05);
      tw(`#${id2}`, { x: ox - cx, y: oy - cy, scale: s0, rotationX: pose.rx, rotationY: pose.ry, transformPerspective: P }, { x: 0, y: 0, scale: 1, rotationX: 0, rotationY: 0, duration: 0.8, ease: "expo.out" }, at);
      tw(`#${id2}`, { opacity: 0 }, { opacity: 1, duration: 0.16, ease: "none" }, at);
      tw(`#${id2}-f`, { y: 0 }, { y: -16, duration: pc.d || 3, ease: "sine.inOut" }, at + 0.6);
      if (pc.d) tto(`#${id2}`, { opacity: 0, scale: 0.9, y: 40, duration: 0.35, ease: "power2.in" }, at + pc.d - 0.35);
      cue(at, "air", { g: 0.45 });
      cue(at + 0.25, "pop", { p: i + 1, g: 0.5 });
      // where it came from, on the plane
      const hid = `${id2}-hl`;
      hl.push(`<div class="p3-hl" id="${hid}" style="left:${r.x * k}px;top:${r.y * k}px;width:${r.w * k}px;height:${r.h * k}px"></div>`);
      tw(`#${hid}`, { opacity: 0 }, { opacity: 1, duration: 0.3 }, at);
      if (pc.d) tto(`#${hid}`, { opacity: 0, duration: 0.3 }, at + pc.d - 0.3);
      // live values painted over the capture (a price ticking up, a leader changing)
      const live = (pc.live || []).map((L, j) => {
        const lr = { x: (L.rect[0] - r.x) * S, y: (L.rect[1] - r.y) * S, w: L.rect[2] * S, h: L.rect[3] * S };
        const spans = L.steps.map((st, q) => {
          const sidq = `${id2}-l${j}-${q}`;
          if (q > 0) tw(`#${sidq}`, { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)" }, s.t + st.at);
          if (L.steps[q + 1]) tto(`#${sidq}`, { opacity: 0, duration: 0.08 }, s.t + L.steps[q + 1].at);
          return `<span id="${sidq}" class="live-v" style="${q > 0 ? "opacity:0;" : ""}color:${st.color || L.color || C.ink}">${esc(st.text)}</span>`;
        }).join("");
        return `<div class="live ${L.font === "raj" ? "live-raj" : "live-mono"}" style="left:${lr.x}px;top:${lr.y}px;width:${lr.w}px;height:${lr.h}px;font-size:${(L.size || 36) * S}px;background:${L.bg || "#0d1326"}">${spans}</div>`;
      }).join("");
      const focus = (pc.focus || []).map((F, j) => {
        const fr = { x: (F.rect[0] - r.x) * S - 8, y: (F.rect[1] - r.y) * S - 8, w: F.rect[2] * S + 16, h: F.rect[3] * S + 16 };
        const fid = `${id2}-fo${j}`, col = F.color || C.volt;
        tw(`#${fid}`, { opacity: 0, scale: 1.15 }, { opacity: 1, scale: 1, duration: 0.4, ease: "back.out(1.6)" }, s.t + F.at);
        cue(s.t + F.at, "pop", { p: 4, g: 0.5 });
        const c = (p2) => `<i style="${p2};border-color:${col}"></i>`;
        return `<div class="pc-focus" id="${fid}" style="left:${fr.x}px;top:${fr.y}px;width:${fr.w}px;height:${fr.h}px;box-shadow:0 0 30px ${col}66;background:${col}14">${c("left:0;top:0;border-right:0;border-bottom:0")}${c("right:0;top:0;border-left:0;border-bottom:0")}${c("left:0;bottom:0;border-right:0;border-top:0")}${c("right:0;bottom:0;border-left:0;border-top:0")}${F.tag ? `<b style="background:${col};${F.tagBelow ? "top:auto;bottom:-46px" : ""}">${rich(F.tag)}</b>` : ""}</div>`;
      }).join("");
      // cut the card to the component's own outline so no stray page shows
      const n = (pc.cut || 0) * S;
      const shape = pc.shape === "slant" ? `clip-path:polygon(${n}px 0,100% 0,calc(100% - ${n}px) 100%,0 100%)`
        : pc.shape === "notch" ? `clip-path:polygon(0 0,calc(100% - ${n}px) 0,100% ${n}px,100% 100%,0 100%)`
        : "border-radius:14px";
      return `<div class="piece" id="${id2}" style="left:${cx - W2 / 2}px;top:${cy - H2 / 2}px;width:${W2}px;height:${H2}px"><div class="piece-in" id="${id2}-f"><div class="piece-clip${pc.shape ? "" : " feather"}" style="${shape}"><img src="${img}" style="width:${SW * S}px;height:${SH * S}px;left:${-r.x * S}px;top:${-r.y * S}px">${live}</div>${focus}</div></div>`;
    }).join("");
    // dim the plane while a card is out
    (s.pieces || []).forEach((pc, i) => {
      const prev = s.pieces[i - 1];
      const gapBefore = prev ? pc.at - (prev.at + (prev.d || 99)) : 99;
      if (gapBefore > 0.4) tto(`#${sid}-dim`, { opacity: 0.62, duration: 0.4 }, s.t + pc.at);
      const next = s.pieces[i + 1];
      const end = pc.at + (pc.d || 99);
      if (pc.d && (!next || next.at - end > 0.4)) tto(`#${sid}-dim`, { opacity: 0, duration: 0.4 }, s.t + end - 0.3);
    });

    // headlines per beat
    const heads = (s.heads || []).map((h, i) => {
      const hid = `${sid}-h${i}`, at = s.t + h.at + (i ? 0 : 0.02);
      const next = s.heads[i + 1];
      if (next) tto(`#${hid}`, { opacity: 0, y: -30, duration: 0.3, ease: "power2.in" }, s.t + next.at - 0.3);
      return `<div class="head" id="${hid}">${h.label ? label(hid, h.label, at) : ""}${lines(hid, h.lines, { size: h.size || 100, at: at + 0.08 })}</div>`;
    }).join("");

    // canvas-space cursor
    const cursors = (s.cursor || []).map((cu, i) => {
      const cid = `${sid}-cu${i}`, at = s.t + cu.at;
      const [fx, fy] = cu.from || [cu.x + 240, cu.y + 260];
      tw(`#${cid}`, { opacity: 0 }, { opacity: 1, duration: 0.25 }, at);
      tw(`#${cid}`, { x: fx, y: fy }, { x: cu.x, y: cu.y, duration: 0.75, ease: "power3.inOut" }, at + 0.1);
      tw(`#${cid}`, { scale: 1 }, { scale: 0.8, duration: 0.09, yoyo: true, repeat: 1, ease: "power1.inOut", immediateRender: false }, at + 0.9);
      tw(`#${cid}r`, { opacity: 0 }, { keyframes: { opacity: [0, 0.9, 0] }, duration: 0.6, ease: "none" }, at + 0.9);
      tw(`#${cid}r`, { scale: 0.2 }, { scale: 1.5, duration: 0.6, ease: "power2.out" }, at + 0.9);
      tto(`#${cid}`, { opacity: 0, duration: 0.3 }, at + (cu.d || 1.8));
      cue(at + 0.92, "click");
      return `<div id="${cid}" class="cursor" style="left:0;top:0;width:58px;height:58px"><svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M4 2.5l15 9.2-6.6 1.4 3.9 7.3-2.8 1.5-3.9-7.4L4.9 19z" fill="#fff" stroke="#0a0d18" stroke-width="1.4" stroke-linejoin="round"/></svg></div><div id="${cid}r" class="ripple" style="left:${cu.x - 50}px;top:${cu.y - 50}px;width:100px;height:100px;border-width:4px"></div>`;
    }).join("");

    const toasts = mkToasts(s, sid);
    const stamp = mkStamp(s, sid, `#${pos}`);
    const plane = `<div class="p3-pos" id="${pos}"><div class="p3-floor" style="left:${CX - PW * 0.55}px;top:${CY + PH * 0.38}px;width:${PW * 1.1}px"></div><div class="p3" id="${pl}" style="left:${CX - PW / 2}px;top:${CY - PH / 2}px;width:${PW}px;height:${PH}px"><div class="p3-glow"></div><div class="p3-face"><img src="${img}" width="${PW}" height="${PH}"><div class="p3-glare"></div>${hl.join("")}<div class="p3-dim" id="${sid}-dim"></div></div></div></div>`;
    scene(s, `${plane}${heads}${pieces}${toasts}${cursors}${stamp}`, { enter: s.enter || "fade", exit: s.exit || "fade" });
  };

  // A big number.
  kinds.stat = (s) => {
    const sid = s._id, at = s.t - 0.05;
    const items = s.items || [{ ...s.value, label: s.valueLabel }];
    const big = items.length === 1;
    const cells = items.map((it, i) => {
      const cid = `${sid}-v${i}`;
      const t0 = it.at != null ? s.t + it.at : at + i * 0.25; // item.at: when its line is spoken
      counter(`#${cid}`, it.from ?? 0, it.to, t0 + 0.2, it.dur || 1.4, it);
      tw(`#${sid}-c${i}`, { opacity: 0, y: 60 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, t0);
      cue(t0 + 0.2, "pop", { p: i + 2, g: 0.6 });
      return `<div class="stat-c${big ? " big" : ""}" id="${sid}-c${i}"><div class="stat-v" id="${cid}" style="color:${it.color || C.ink}">${fmtNum(it.from ?? 0, it)}</div><div class="stat-l">${rich(it.label || "")}</div></div>`;
    }).join("");
    cue(at + 1.6, "chime", { p: 1, g: 0.55 });
    const inner = `<div class="stat-wrap">${s.label ? label(sid, s.label, at) : ""}${s.lines ? lines(sid, s.lines, { size: s.size || 110, at: at + 0.05 }) : ""}<div class="stat-row${big ? " big" : ""}">${cells}</div>${s.sub ? `<div class="sub" id="${sid}-sub">${rich(s.sub)}</div>` : ""}</div>`;
    if (s.sub) tw(`#${sid}-sub`, { opacity: 0 }, { opacity: 1, duration: 0.5 }, at + 1.2);
    scene(s, inner, { enter: s.enter || "fade", exit: s.exit || "fade" });
  };

  // A list of rows that tick (or get struck through) one by one.
  kinds.list = (s) => {
    const sid = s._id, at = s.t - 0.1;
    const step = s.step || 0.32;
    const rows = s.items.map((it, i) => {
      const rid = `${sid}-r${i}`, t0 = at + 0.55 + i * step;
      tw(`#${rid}`, { opacity: 0, x: 90 }, { opacity: 1, x: 0, duration: 0.45, ease: "expo.out" }, t0);
      tw(`#${rid}-ic`, { scale: 0 }, { scale: 1, duration: 0.4, ease: "back.out(2.2)" }, t0 + 0.12);
      if (s.style === "strike") {
        tw(`#${rid}-x`, { scaleX: 0 }, { scaleX: 1, duration: 0.35, ease: "power3.out" }, t0 + (s.strikeAt ? s.strikeAt - 0.55 - i * step + i * 0.12 : 0.3));
        tto(`#${rid}`, { opacity: 0.45, duration: 0.3 }, t0 + (s.strikeAt ? s.strikeAt - 0.55 - i * step + i * 0.12 : 0.3) + 0.2);
        cue(t0 + (s.strikeAt ? s.strikeAt - 0.55 - i * step + i * 0.12 : 0.3), "click", { g: 0.6 });
      }
      cue(t0 + 0.1, "pop", { p: i, g: 0.65 });
      const icon = s.style === "strike"
        ? `<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18" stroke="${C.hot}" stroke-width="3" fill="none" stroke-linecap="square"/></svg>`
        : `<svg viewBox="0 0 24 24"><path d="M4.5 12.5l5 5 10-11" stroke="${C.money}" stroke-width="3" fill="none" stroke-linecap="square"/></svg>`;
      return `<div class="row" id="${rid}"><div class="row-ic" id="${rid}-ic" style="border-color:${s.style === "strike" ? C.hot : C.money}55">${icon}</div><div class="row-t">${rich(typeof it === "string" ? it : it.t)}${s.style === "strike" ? `<i class="row-x" id="${rid}-x"></i>` : ""}</div>${it.k ? `<div class="row-k">${rich(it.k)}</div>` : ""}</div>`;
    }).join("");
    const inner = `<div class="list-wrap" style="top:${s.y ?? 330}px">${s.label ? label(sid, s.label, at) : ""}${lines(sid, s.lines, { size: s.size || 112, at: at + 0.05 })}<div class="rows">${rows}</div></div>`;
    scene(s, inner, { enter: s.enter || "fade", exit: s.exit || "fade" });
  };

  // Rapid word + screen cuts (each beat a different crop, full bleed).
  kinds.montage = (s) => {
    s.items.forEach((it, i) => {
      const t = s.t + i * s.beat;
      const d = it.d || s.beat;
      const sub = { ...it, _id: nid("mo"), t, d, frame: false, head: null, cam: it.cam || [{ at: 0, focus: it.focus, w: it.w || 640, center: it.center }], enter: i ? "zoom" : s.enter || "zoom", exit: "none" };
      kinds.screen(sub);
      // the word, over the shot
      const wid = nid("mw");
      html.push(`<div id="${wid}" class="clip" data-start="${r2(t)}" data-duration="${r2(d)}" data-track-index="5"><div class="mo-word" id="${wid}-w">${rich(it.word)}</div>${it.small ? `<div class="mo-small" id="${wid}-s">${rich(it.small)}</div>` : ""}</div>`);
      tw(`#${wid}-w`, { scale: 1.35, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.32, ease: "expo.out" }, t);
      if (it.small) tw(`#${wid}-s`, { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.3 }, t + 0.12);
      cue(t, i % 2 ? "air" : "thump", { g: i % 2 ? 0.5 : 0.55 });
    });
  };

  // The VOLT crest and the ask.
  kinds.cta = (s) => {
    const sid = s._id, at = s.t;
    tw(`#${sid}-crest`, { scale: 0.4, opacity: 0, rotation: -20 }, { scale: 1, opacity: 1, rotation: 0, duration: 0.9, ease: "expo.out" }, at);
    tw(`#${sid}-ring`, { opacity: 0 }, { keyframes: { opacity: [0, 0.9, 0] }, duration: 1.4, ease: "none" }, at + 0.1);
    tw(`#${sid}-ring`, { scale: 0.6, rotation: 45 }, { scale: 2.2, rotation: 45, duration: 1.4, ease: "power2.out" }, at + 0.1);
    tw(`#${sid}-ring2`, { opacity: 0 }, { keyframes: { opacity: [0, 0.6, 0] }, duration: 1.8, ease: "none" }, at + 0.3);
    tw(`#${sid}-ring2`, { scale: 0.6, rotation: 45 }, { scale: 2.8, rotation: 45, duration: 1.8, ease: "power2.out" }, at + 0.3);
    tw(`#${sid}-word`, { opacity: 0, scale: 1.25 }, { opacity: 1, scale: 1, duration: 0.9, ease: "power3.out" }, at + 0.3);
    tw(`#${sid}-btn`, { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: 0.5, ease: "power3.out" }, at + 1.1);
    tw(`#${sid}-btnsh`, { xPercent: -120 }, { xPercent: 220, duration: 1.0, ease: "power2.inOut" }, at + 1.6);
    tw(`#${sid}-feat`, { opacity: 0 }, { opacity: 1, duration: 0.6 }, at + 1.3);
    cue(at - 1.2, "swell", { d: 1.2, g: 0.5 });
    cue(at, "boom", { g: 1 });
    cue(at + 0.05, "chime", { p: 0, g: 0.6, chord: true });
    cue(at + 1.6, "shimmer", { g: 0.35 });
    const crest = `<svg viewBox="0 0 40 44" width="230" height="253"><defs><linearGradient id="cf" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f66e0"/><stop offset="1" stop-color="#0b1530"/></linearGradient><linearGradient id="cs" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9cbcff"/><stop offset="1" stop-color="#3d7bff" stop-opacity="0.35"/></linearGradient></defs><path d="M2.5 1.5h27l8 8v18.5L20 42.5 2.5 30z" fill="url(#cf)" stroke="url(#cs)" stroke-width="1.2"/><path d="M6.5 5.5h21.5l5.5 5.5v15.3L20 37.6 6.5 27.9z" fill="none" stroke="rgba(170,200,255,0.22)" stroke-width="0.8"/><path d="M30.6 3.4l4.9 4.9" stroke="#ff4655" stroke-width="2.2"/><text x="20" y="27.5" text-anchor="middle" font-family="Rajdhani" font-weight="700" font-size="21" fill="#f4f8ff">V</text></svg>`;
    const inner = `<div class="cta"><div class="crest-wrap"><div class="ring" id="${sid}-ring"></div><div class="ring" id="${sid}-ring2"></div><div class="crest" id="${sid}-crest">${crest}</div></div><div class="cta-word" id="${sid}-word">VOLT LEAGUE</div><div class="cta-lines">${lines(sid, s.lines, { size: s.size || 118, at: at + 0.5 })}</div>${s.feat ? `<div class="cta-feat" id="${sid}-feat">${rich(s.feat)}</div>` : ""}<div class="btn" id="${sid}-btn"><span>${rich(s.button || "START YOUR LEAGUE")}</span><i class="btn-sh" id="${sid}-btnsh"></i></div></div>`;
    scene(s, inner, { enter: "fade", exit: "none" });
  };

  // ── assemble ─────────────────────────────────────────────────────────
  spec.scenes.forEach((s, i) => {
    s._id = s.id || `s${i + 1}`;
    if (!kinds[s.kind]) throw new Error("unknown scene kind " + s.kind);
    kinds[s.kind](s);
    if (i > 0 && s.sweep !== false && s.kind !== "montage") sweep(s.t);
  });
  for (const c of spec.cues || []) cue(c.t, c.k, c);

  // background drift
  js.unshift(`tl.fromTo("#glow1",{x:-120,y:-60},{x:140,y:80,duration:${duration},ease:"sine.inOut",immediateRender:true},0);tl.fromTo("#glow2",{x:80,y:40},{x:-120,y:-90,duration:${duration},ease:"sine.inOut",immediateRender:true},0);tl.fromTo("#grid",{backgroundPosition:"0px 0px"},{backgroundPosition:"0px 240px",duration:${duration},ease:"none",immediateRender:true},0);`);
  // fade the whole thing up from black, and out at the very end
  js.push(`tl.fromTo("#fadein",{opacity:1},{opacity:0,duration:0.35,ease:"power1.out",immediateRender:true},0);`);

  const doc = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=${W}, height=${H}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=IBM+Plex+Mono:wght@500;700&family=Space+Grotesk:wght@400;500;700&display=block" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>${fs.readFileSync(path.join(HERE, "reel.css"), "utf8")}</style>
</head>
<body>
<div id="root" data-composition-id="main" data-start="0" data-duration="${duration}" data-width="${W}" data-height="${H}">
<div id="bg" class="clip" data-start="0" data-duration="${duration}" data-track-index="0"><div id="glow1"></div><div id="glow2"></div><div id="grid"></div><div id="grain"></div><div id="vig"></div></div>
${html.join("\n")}
<div id="fadein-c" class="clip" data-start="0" data-duration="0.5" data-track-index="10"><div id="fadein"></div></div>
</div>
<script>
const tl = gsap.timeline({ paused: true });
${js.join("\n")}
window.__timelines["main"] = tl;
tl.seek(0);
</script>
</body>
</html>
`;

  // write project
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  for (const [kind, name] of assets) {
    if (kind === "screen") {
      const src = cachedWebp(path.join(SCREENS, name + ".png"), "screen-" + name + ".webp");
      fs.copyFileSync(src, path.join(dir, "assets", name + ".webp"));
    } else {
      const flat = name.replace(/\//g, "-").replace(/\.\w+$/, "");
      const src = cachedWebp(path.join(PUBLIC_IMG, name), "img-" + flat + ".webp");
      fs.copyFileSync(src, path.join(dir, "assets", flat + ".webp"));
    }
  }
  fs.writeFileSync(path.join(dir, "index.html"), doc);
  cues.sort((a, b) => a.t - b.t);
  fs.writeFileSync(path.join(dir, "cues.json"), JSON.stringify({ id, duration, bpm: 120, vo: spec.vo || null, outro: spec.outro ?? (spec.scenes.find((x) => x.kind === "cta")?.t ?? null), cues }, null, 1));
  return { dir, cues: cues.length };
}
