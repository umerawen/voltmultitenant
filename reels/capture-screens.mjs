// Capture VOLT web screens for the reels.
//
// Runs against the offline preview (`volt-offline`, port 5174) with demo data
// (?demo=<scene>), so every name on screen is invented. Desktop viewport
// 1920x1080 at 2x, so the reels can push in without going soft.
//
// Next to every screens/<name>.png it writes screens/<name>.json: the 1x CSS
// rect of each named mark (an element found by its text or a selector), so a
// reel can frame, highlight or overlay the real UI exactly.
//
//   node capture-screens.mjs            → every shot
//   node capture-screens.mjs auction    → only shots whose name contains "auction"
//   node capture-screens.mjs auction --real data/kami-labs.json --prefix kami-
//       → the same shots filled with a real league (a git-ignored JSON file,
//         see src/demo.js), saved as screens/kami-<name>.png
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.VOLT_URL || "http://localhost:5174/";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = new URL("./screens/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const nav = (label) => async (page) => {
  await page.evaluate((l) => document.querySelector(`button[aria-label="${l}"]`)?.click(), label);
  await wait(2800);
};
const click = (sel) => async (page) => { await page.evaluate((s) => document.querySelector(s)?.click(), sel); await wait(1800); };
const clickText = (text) => async (page) => {
  await page.evaluate((t) => {
    const els = [...document.querySelectorAll("button, [role=button], div, a")].filter((e) => e.textContent.trim().toUpperCase().startsWith(t));
    els.sort((a, b) => a.textContent.length - b.textContent.length);
    els[0]?.click();
  }, text.toUpperCase());
  await wait(2000);
};
const scrollTo = (y) => async (page) => { await page.evaluate((v) => window.scrollTo(0, v), y); await wait(900); };
const portal = async (page) => {
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /league hub/i.test(b.textContent))?.click());
  await wait(3600);
};

// Text marks: the smallest visible element whose text is exactly this
// (case-insensitive). Selector marks: "sel:<css>" → first match.
const SHOTS = [
  // [file, scene, steps[], marks[]]
  ["dashboard", "auction", [], ["KAIRO#1000", "sel:.volt-yc .volt-cell", "$2,900", "ZEPHYR", "LATEST SALES", "CAPTAINS' PURSES"]],
  ["player-pool", "pool", [nav("Player Pool")], ["KAIRO", "ZEPHYR", "VANTA", "NYX", "SCOUT HUB", "24"]],
  ["scout-modal", "pool", [nav("Player Pool"), clickText("KAIRO")], ["KAIRO"]],
  ["auction-block", "auction", [nav("Live Auction")], ["$2,900", "NOVA STRIKE", "SOLD", "PASS", "ZEPHYR", "VIPERS", "PHANTOMS", "EMBERFALL", "FROSTBYTE", "TITANS", "// BIDDING WAR", "// AUCTION FEED", "CURRENT BID"]],
  ["rosters", "drafted", [nav("Rosters")], ["VIPERS", "PHANTOMS", "NOVA STRIKE", "EMBERFALL", "FROSTBYTE", "TITANS", "KAIRO"]],
  ["reserve-pool", "drafted", [nav("Reserve Pool")], []],
  ["mock-draft", "pool", [nav("Mock Draft")], []],
  ["fixtures-bracket", "bracket", [nav("Fixtures")], ["sel:[aria-label^='QF 2']", "sel:[aria-label^='SF 1']", "sel:[aria-label^='Final']", "SINGLE ELIMINATION", "// BRACKET"]],
  ["match-modal", "bracket", [nav("Fixtures"), click("[aria-label^='SF 1']")], ["sel:[role=dialog]"]],
  ["fixtures-champion", "final", [nav("Fixtures")], ["sel:[aria-label^='Final']", "★ CHAMPION ★"]],
  ["fixtures-league", "league", [nav("Fixtures")], ["// STANDINGS", "LEAGUE PLAY"]],
  ["fixtures-league-rounds", "league", [nav("Fixtures"), scrollTo(760)], []],
  ["leaderboard", "league", [nav("Leaderboard")], ["LEADERBOARD", "VANTA", "KAIRO", "ZEPHYR"]],
  ["league-page", "league", [portal], ["APEX LEAGUE", "YOU'RE IN ✓", "ENTER TOURNAMENT →", "// SEASON RACE", "OCT 10–11", "// PAST TOURNAMENTS"]],
];

const args = process.argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args.splice(i, 2)[1] : null; };
const realFile = flag("--real"), prefix = flag("--prefix") || "";
const real = realFile ? JSON.parse(fs.readFileSync(new URL(realFile, import.meta.url), "utf8")) : null;
const only = args[0];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
try {
  for (const [file, scene, steps, marks] of SHOTS) {
    if (only && !file.includes(only)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
    if (real) await page.evaluateOnNewDocument((r) => { window.__demoReal = r; }, real);
    await page.goto(`${BASE}?demo=${scene}`, { waitUntil: "networkidle2" });
    await wait(3500);
    for (const step of steps) await step(page);
    await wait(600);
    const rects = await page.evaluate((marks) => {
      const out = {};
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
      for (const m of marks) {
        let el = null;
        if (m.startsWith("sel:")) el = [...document.querySelectorAll(m.slice(4))].find(vis) || null;
        else {
          const want = m.toUpperCase();
          const cands = [...document.querySelectorAll("body *")].filter((e) => vis(e) && e.textContent.trim().toUpperCase() === want);
          cands.sort((a, b) => a.getBoundingClientRect().width * a.getBoundingClientRect().height - b.getBoundingClientRect().width * b.getBoundingClientRect().height);
          el = cands[0] || null;
        }
        if (el) { const r = el.getBoundingClientRect(); out[m.replace(/^sel:/, "")] = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }
      }
      return out;
    }, marks);
    await page.screenshot({ path: `${OUT}${prefix}${file}.png` });
    fs.writeFileSync(`${OUT}${prefix}${file}.json`, JSON.stringify(rects, null, 1));
    console.log("✓", prefix + file, Object.keys(rects).length + "/" + marks.length, "marks");
    await page.close();
  }
} finally {
  await browser.close();
}
