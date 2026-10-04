// Reel covers: 1080x1920 JPGs for Instagram / TikTok / Shorts. Each one composes
// a real VOLT screen in a tilted browser mockup, a lifted component, an agent
// cut-out and the headline. The profile grid crops covers to 3:4 (1080x1440,
// y 240-1680), so the headline and key visuals stay inside that band.
//
//   node covers/build.mjs [filter]   → covers/out/NN-<id>.jpg + covers/out/grid.jpg
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = path.join(HERE, "..", "screens");
const IMG = path.join(HERE, "..", "..", "public", "img");
const OUT = path.join(HERE, "out");
fs.mkdirSync(OUT, { recursive: true });
const url = (p) => pathToFileURL(p).href;
const shot = (n) => url(path.join(SCREENS, n + ".png"));
const img = (n) => url(path.join(IMG, n));

const C = { hot: "#ff4655", volt: "#5b8dff", money: "#3ddc84", gold: "#f5c453" };
// [red] {blue} |green| ~gold~
const rich = (s) => s.replace(/\[(.+?)\]/g, '<span class="c-hot">$1</span>').replace(/\{(.+?)\}/g, '<span class="c-volt">$1</span>')
  .replace(/\|(.+?)\|/g, '<span class="c-money">$1</span>').replace(/~(.+?)~/g, '<span class="c-gold">$1</span>');

// A crop of a screen (rect in 1920x1080 screen px) shown w px wide.
const crop = (name, [x, y, w, h], W) => {
  const k = W / w;
  return `<div class="crop" style="width:${W}px;height:${h * k}px"><img src="${shot(name)}" style="width:${1920 * k}px;left:${-x * k}px;top:${-y * k}px"></div>`;
};
// The browser mockup.
const mock = (m) => `<div class="mock" style="left:${m.x}px;top:${m.y}px;transform:perspective(2600px) rotateY(${m.ry ?? -22}deg) rotateX(${m.rx ?? 8}deg) rotateZ(${m.rz ?? 0}deg) scale(${m.s ?? 1})">
  <div class="bar"><i></i><i></i><i></i><span>volt.leagues · ${m.page || "kami labs"}</span>${m.live ? '<b>● LIVE</b>' : ""}</div>${crop(m.shot, m.crop, m.w)}</div>`;
// A component lifted off the screen.
const float = (f) => `<div class="float${f.shape ? " " + f.shape : ""}" style="left:${f.x}px;top:${f.y}px;transform:rotate(${f.rot ?? 0}deg)${f.glow ? `;box-shadow:0 40px 90px rgba(0,0,0,.6),0 0 60px ${f.glow}66` : ""}">${crop(f.shot, f.rect, f.w)}${f.tag ? `<em style="background:${f.tagColor || C.volt}">${f.tag}</em>` : ""}</div>`;

const WORDMARK = fs.readFileSync(path.join(HERE, "..", "..", "public", "brand", "volt-wordmark.svg"), "utf8").replace(/<svg /, '<svg class="wm" ');

// Layout: the app screen is the hero (big tilted mockup across the top), a lifted
// component floats over its lower-left, the agent overlaps the lower-right, the
// headline sits bottom-left. Mock defaults: x 40, y 420, w 1060.
const M = (shot, crop, page, o = {}) => ({ shot, crop, page, x: 40, y: 420, w: 1060, ...o });
const COVERS = [
  { n: 1, id: "volt-solo-to-signed", accent: C.volt, agent: { src: "jett.webp", h: 1060, right: -110 },
    label: "FOR SOLO PLAYERS", lines: ["NO TEAM?", "[GET DRAFTED.]"],
    mocks: [M("kami-pool-scrolled", [330, 300, 1520, 760], "player pool")],
    floats: [{ shot: "kami-pool-scrolled", rect: [1462, 578, 360, 180], w: 520, x: 70, y: 930, rot: -3, tag: "THAT'S YOU", glow: C.volt }] },
  { n: 2, id: "volt-bidding-war", accent: C.hot, agent: { src: "reyna.webp", h: 1080, right: -130 },
    label: "LIVE AUCTION DRAFT", lines: ["6 CAPTAINS.", "1 [BIDDING WAR.]"], size: 136,
    mocks: [M("kami-auction-block", [262, 76, 1660, 870], "live auction", { live: true })],
    floats: [{ shot: "kami-auction-block", rect: [916, 714, 334, 87], w: 620, x: 60, y: 1010, rot: -2, shape: "slant", glow: C.hot, tag: "SOLD · $1,600", tagColor: C.money }] },
  { n: 3, id: "volt-host-autopilot", accent: C.volt, agent: { src: "killjoy.webp", h: 1040, right: -190 },
    label: "FOR LEAGUE HOSTS", lines: ["YOU HOST.", "[VOLT RUNS IT.]"],
    mocks: [M("kami-fixtures-champion", [330, 320, 1510, 760], "fixtures")],
    floats: [{ shot: "kami-fixtures-champion", rect: [775, 350, 617, 135], w: 600, x: 60, y: 1010, rot: -2, glow: C.gold }] },
  { n: 4, id: "volt-scout-hub", accent: C.volt, agent: { src: "omen.webp", h: 1060, right: -120 },
    label: "FOR CAPTAINS", lines: ["SCOUT BEFORE", "YOU [SPEND.]"],
    mocks: [M("kami-scout-modal", [470, 90, 980, 700], "scout file", { w: 980 })],
    floats: [{ shot: "kami-scout-modal", rect: [1035, 195, 315, 270], w: 420, x: 60, y: 960, rot: -3, glow: C.volt, tag: "SCOUT FILE" }] },
  { n: 5, id: "volt-every-match-counts", accent: C.gold, agent: { src: "neon.webp", h: 1020, right: -210 },
    label: "PLAYER STATS", lines: ["EVERY MATCH", "[COUNTS.]"],
    mocks: [M("kami-leaderboard", [330, 330, 1510, 740], "leaderboard")],
    floats: [{ shot: "kami-leaderboard", rect: [843, 357, 483, 281], w: 470, x: 70, y: 900, rot: -3, tag: "588 PTS · #1", tagColor: C.gold, glow: C.gold }] },
  { n: 6, id: "volt-any-format", accent: C.volt, agent: { src: "sova.webp", h: 1020, right: -190 },
    label: "TOURNAMENT FORMATS", lines: ["GROUPS, THEN", "[KNOCKOUTS.]"],
    mocks: [M("kami-fixtures-league", [330, 330, 1510, 760], "fixtures")],
    floats: [{ shot: "kami-playoffs-final", rect: [765, 700, 635, 130], w: 600, x: 60, y: 1010, rot: -2, glow: C.volt, tag: "GRAND FINAL" }] },
  { n: 7, id: "volt-road-to-the-final", accent: C.gold, agent: { src: "sage.webp", h: 1080, right: -80 },
    label: "KAMI LABS TOURNAMENT", lines: ["ROAD TO", "THE ~FINAL.~"],
    mocks: [M("kami-playoffs-final", [330, 420, 1500, 560], "playoffs", { y: 470 })],
    floats: [{ shot: "kami-playoffs-final", rect: [765, 700, 635, 130], w: 620, x: 50, y: 990, rot: -2, tag: "CHAMPIONS · PATIENCE", tagColor: C.gold, glow: C.gold }] },
  { n: 8, id: "volt-call-it", accent: C.hot, agent: { src: "raze.webp", h: 1000, right: -210 },
    label: "PREDICTIONS", lines: ["CALL IT", "[BEFORE] IT", "HAPPENS."], size: 140,
    mocks: [M("kami-final-modal", [600, 280, 720, 520], "grand final", { w: 900, live: true })],
    floats: [{ shot: "kami-final-modal", rect: [679, 600, 562, 65], w: 580, x: 60, y: 880, rot: -2, tag: "4 OF 4 VOTES", tagColor: C.hot, glow: C.hot }] },
  { n: 9, id: "volt-captain-mode", accent: C.money, agent: { src: "phoenix.webp", h: 1060, right: -140 },
    label: "CAPTAIN MODE", lines: ["YOU'RE THE", "[CAPTAIN.]"],
    mocks: [M("kami-dashboard", [262, 70, 1650, 1000], "dashboard", { live: true })],
    floats: [{ shot: "kami-rosters", rect: [343, 233, 357, 535], w: 330, x: 70, y: 760, rot: -3, shape: "notch", glow: C.hot, tag: "$10,000 TO SPEND", tagColor: C.money }] },
  { n: 10, id: "volt-this-is-volt", accent: C.volt, art: { src: "art-omen-void.webp", fx: 0.3 },
    label: "VALORANT LEAGUES", lines: ["THIS IS", "[VOLT.]"], size: 190,
    mocks: [
      M("kami-auction-block", [262, 76, 1660, 870], "live auction", { x: 330, y: 560, w: 820, ry: -24, rz: 2, live: true }),
      M("kami-playoffs-final", [330, 420, 1500, 560], "playoffs", { x: 230, y: 960, w: 820, ry: -24, rz: 2 }),
    ] },
  { n: 11, id: "volt-launch", accent: C.volt, label: "NOW LIVE", lines: ["YOUR LEAGUE", "JUST WENT [PRO.]"], size: 128, logo: true,
    mocks: [
      M("kami-pool-scrolled", [330, 300, 1520, 760], "player pool", { x: -260, y: 640, w: 760, ry: 22, rx: 6, rz: -2 }),
      M("kami-fixtures-league", [330, 330, 1510, 760], "fixtures", { x: 580, y: 640, w: 760, ry: -22, rx: 6, rz: 2 }),
      M("kami-auction-block", [262, 76, 1660, 870], "live auction", { x: 110, y: 600, w: 860, ry: 0, rx: 8, live: true }),
    ],
    floats: [{ shot: "kami-auction-block", rect: [916, 714, 334, 87], w: 520, x: 280, y: 1060, rot: -2, shape: "slant", glow: C.hot }] },
  { n: 12, id: "volt-watch-the-number", accent: C.money, agent: { src: "jett.webp", h: 1060, right: -110 },
    label: "LIVE AUCTION · NIA", lines: ["WATCH THE", "[NUMBER.]"],
    mocks: [M("nia-sold-auction-block", [262, 76, 1660, 870], "live auction", { live: true })],
    floats: [{ shot: "nia-sold-auction-block", rect: [916, 714, 334, 87], w: 700, x: 50, y: 980, rot: -2, shape: "slant", glow: C.money, tag: "SOLD · VANGUARD", tagColor: C.money }] },
];

const css = fs.readFileSync(path.join(HERE, "cover.css"), "utf8");
const page = (c) => {
  const art = c.art ? `<div class="art"><img src="${img(c.art.src)}" style="left:${Math.round(540 - c.art.fx * 1800 * (1500 / 1012))}px"></div>` : "";
  const agent = c.agent ? `<div class="agent" style="right:${c.agent.right ?? -80}px"><div class="aglow" style="background:radial-gradient(closest-side, ${c.accent}55, ${c.accent}18 55%, transparent)"></div><img src="${img(c.agent.src)}" style="height:${c.agent.h}px"></div>` : "";
  const stat = c.stat ? `<div class="stat" style="left:${c.stat.x}px;top:${c.stat.y}px"><b>${rich(c.stat.text)}</b><span>${c.stat.sub}</span></div>` : "";
  const logo = c.logo ? `<div class="biglogo">${WORDMARK.replace('class="wm"', 'class="wm big"')}</div>` : "";
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=IBM+Plex+Mono:wght@500;700&family=Space+Grotesk:wght@500;700&display=block" rel="stylesheet">
<style>${css} :root{--accent:${c.accent}}</style></head><body><div id="root">
<div class="bg"></div><div class="glow"></div><div class="grid"></div>${art}
${(c.mocks || []).map(mock).join("")}
${agent}
${(c.floats || []).map(float).join("")}
<div class="shade"></div>
${stat}
${logo || `<div class="top">${WORDMARK}</div>`}
<div class="title"><div class="lab">// ${c.label}<i></i></div>${c.lines.map((l) => `<div class="ln" style="font-size:${c.size || 150}px">${rich(l)}</div>`).join("")}<div class="stripe"></div></div>
<div class="vig"></div></div></body></html>`;
};

const only = process.argv[2];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--allow-file-access-from-files", "--force-color-profile=srgb"] });
const tab = await browser.newPage();
await tab.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
const made = [];
for (const c of COVERS) {
  if (only && !c.id.includes(only)) continue;
  const file = path.join(OUT, `.cover-${c.n}.html`);
  fs.writeFileSync(file, page(c));
  await tab.goto(url(file), { waitUntil: "networkidle0" });
  await tab.evaluate(() => document.fonts.ready);
  const out = path.join(OUT, `${String(c.n).padStart(2, "0")}-${c.id}.jpg`);
  await tab.screenshot({ path: out, type: "jpeg", quality: 92 });
  fs.unlinkSync(file);
  made.push(out);
  console.log("✓", path.basename(out));
}
await browser.close();
