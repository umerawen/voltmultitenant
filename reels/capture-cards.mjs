// Capture the auction draw's cards as stills so a reel can rebuild the spin
// natively (deterministic, 60fps, motion blur) instead of screen-recording it.
//
// For each player in the draw, freeze the app clock at a moment that player
// sits centred under the marker, let the transitions settle, and screenshot
// the card. Also grabs the reveal ("KAMIJEEE · heads to the block at $800").
//
//   node capture-cards.mjs --real data/kami-labs.json --out screens/kami-draw
//   → <out>/card-00.png … card-NN.png, reveal.png, draw.json (pool order, winner)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const realFile = opt("--real", null), out = opt("--out", "screens/draw");
const BASE = process.env.VOLT_URL || "http://localhost:5174/";
const real = realFile ? JSON.parse(fs.readFileSync(realFile, "utf8")) : null;
fs.mkdirSync(out, { recursive: true });

// the app's REEL_EASE
const T1 = 0.45, D1 = (3 * T1) / (1 + 2 * T1);
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t <= T1 ? (D1 / T1) * t : D1 + (1 - D1) * (1 - Math.pow(1 - (t - T1) / (1 - T1), 3)));
const timeFor = (frac) => { let lo = 0, hi = 1; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (ease(m) < frac) lo = m; else hi = m; } return hi; };

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((r) => {
  if (r) window.__demoReal = r;
  const rn = Date.now.bind(Date); let f = null;
  window.__freeze = (t) => { f = t; };
  Date.now = () => (f ?? rn());
}, real);
await page.goto(`${BASE}?demo=spin`, { waitUntil: "networkidle2" });
await page.evaluate(() => document.querySelector('button[aria-label="Live Auction"]')?.click());
await page.waitForFunction(() => window.__demoBoard?.spin);
const draw = await page.evaluate(() => {
  const b = window.__demoBoard, sp = b.spin;
  const name = (id) => b.players.find((p) => p.id === id)?.name;
  return { startTs: sp.startTs, duration: sp.duration, pool: sp.pool.map(name), winner: name(sp.playerId) };
});
// The app's reel always travels REEL_TRAVEL cards, starting where that lands on the winner.
const REEL_TRAVEL = 60, REEL_LEAD = 6;
const n = draw.pool.length, winnerIdx = draw.pool.indexOf(draw.winner), winnerIndex = REEL_LEAD + REEL_TRAVEL;

// the card nearest the marker
const centreCard = () => page.evaluate(() => {
  const cards = [...document.querySelectorAll(".volt-reel-stage")];
  const marker = document.querySelector(".volt-reel-stage")?.closest(".relative.w-full")?.getBoundingClientRect();
  const mid = marker ? marker.x + marker.width / 2 : 960;
  let best = null, bd = 1e9;
  for (const el of cards) { const r = el.getBoundingClientRect(); const d = Math.abs(r.x + r.width / 2 - mid); if (d < bd) { bd = d; best = { x: r.x, y: r.y, w: r.width, h: r.height, text: el.textContent }; } }
  return best;
});

// hide the red centre marker: the reel draws its own, it must not be baked into the cards
await page.addStyleTag({ content: ".relative.w-full > .absolute.z-20.pointer-events-none { visibility: hidden !important; }" });

// in time order (the app's spin loop stops for good once it lands), winner last
const shots = [...Array(n).keys()].map((k) => [k, winnerIndex - ((winnerIdx - k + n) % n)]).filter(([, i]) => i > REEL_LEAD).sort((a, b) => a[1] - b[1]);
for (const [k, i] of shots) {
  // the last time player k passes the marker before the winner lands
  await page.evaluate((v) => window.__freeze(v), draw.startTs + timeFor((i - REEL_LEAD) / REEL_TRAVEL) * draw.duration + 1);
  await new Promise((r) => setTimeout(r, 700));
  const c = await centreCard();
  await page.screenshot({ path: path.join(out, `card-${String(k).padStart(2, "0")}.png`), clip: { x: c.x, y: c.y, width: c.w, height: c.h } });
  console.log(k, draw.pool[k], c.text.includes(draw.pool[k].toUpperCase()) || c.text.toUpperCase().includes(draw.pool[k].toUpperCase()) ? "ok" : "?", Math.round(c.w) + "x" + Math.round(c.h));
}
// the reveal under the reel, after its pop has finished
await page.evaluate((v) => window.__freeze(v), draw.startTs + draw.duration + 1500);
await new Promise((r) => setTimeout(r, 1500));
const rv = await page.evaluate(() => { const el = document.querySelector(".bid-pop"); const r = el?.getBoundingClientRect(); return r && { x: r.x - 40, y: r.y - 10, w: r.width + 80, h: r.height + 20 }; });
if (rv) await page.screenshot({ path: path.join(out, "reveal.png"), clip: { x: rv.x, y: rv.y, width: rv.w, height: rv.h } });
const size = await page.evaluate(() => { const r = document.querySelector(".volt-reel-stage").getBoundingClientRect(); return { w: r.width, h: r.height }; });
fs.writeFileSync(path.join(out, "draw.json"), JSON.stringify({ ...draw, winnerIdx, travel: REEL_TRAVEL, reveal: !!rv, slotW: 292, cardScale: 1.1 }, null, 1));
await browser.close();
console.log("✓", out, n, "cards; winner", draw.winner, "at pool index", winnerIdx);
