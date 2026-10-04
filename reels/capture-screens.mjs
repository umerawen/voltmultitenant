// Capture VOLT web screens for the reels.
//
// Runs against the offline preview (`volt-offline`, port 5174) with demo data
// (?demo=<scene>), so every name on screen is invented. Desktop viewport
// 1920x1080 at 2x, so the reels can push in without going soft.
//
//   node capture-screens.mjs            → screens/*.png
//   node capture-screens.mjs auction    → only shots whose name contains "auction"
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const BASE = process.env.VOLT_URL || "http://localhost:5174/";
const CHROME = process.env.CHROME || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT = new URL("./screens/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
fs.mkdirSync(OUT, { recursive: true });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Open a rail page by its accessible label, then let entrance animations settle.
const nav = (label) => async (page) => {
  await page.evaluate((l) => document.querySelector(`button[aria-label="${l}"]`)?.click(), label);
  await wait(2600);
};
const scrollTo = (y) => async (page) => { await page.evaluate((v) => window.scrollTo(0, v), y); await wait(900); };

const SHOTS = [
  // [file, scene, steps[]]
  ["dashboard", "auction", []],
  ["player-pool", "pool", [nav("Player Pool")]],
  ["auction-block", "auction", [nav("Live Auction")]],
  ["rosters", "drafted", [nav("Rosters")]],
  ["mock-draft", "pool", [nav("Mock Draft")]],
  ["fixtures-bracket", "bracket", [nav("Fixtures")]],
  ["fixtures-league", "league", [nav("Fixtures")]],
  ["fixtures-league-rounds", "league", [nav("Fixtures"), scrollTo(760)]],
  ["leaderboard", "league", [nav("Leaderboard")]],
  ["league-page", "league", [nav("League hub")]],
];

const only = process.argv[2];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
try {
  for (const [file, scene, steps] of SHOTS) {
    if (only && !file.includes(only)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
    await page.goto(`${BASE}?demo=${scene}`, { waitUntil: "networkidle2" });
    await wait(3500);
    for (const step of steps) await step(page);
    // League hub opens through the top-bar portal button.
    if (file === "league-page") {
      await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /league hub/i.test(b.textContent))?.click());
      await wait(3500);
    }
    await page.screenshot({ path: `${OUT}${file}.png` });
    console.log("✓", file);
    await page.close();
  }
} finally {
  await browser.close();
}
