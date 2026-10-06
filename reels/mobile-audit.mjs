// Phone-width screenshots of every screen, for checking the mobile layout.
// Runs against the offline preview (`volt-offline`, port 5174) in demo mode.
//
//   node mobile-audit.mjs [filter] [--w 390]   → mobile/<name>.png (full page, 2x)
// Each run also prints any screen that scrolls sideways (wider than the phone).
import puppeteer from "puppeteer-core";
import fs from "node:fs";

const args = process.argv.slice(2);
const wi = args.indexOf("--w"), W = wi >= 0 ? +args.splice(wi, 2)[1] : 390;
const only = args[0];
const BASE = process.env.VOLT_URL || "http://localhost:5174/";
const OUT = new URL("./mobile/", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
fs.mkdirSync(OUT + "view", { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// phones: a bottom tab (short label) or a tile in the More sheet (full label)
const SHORT = { "Dashboard": "Home", "Player Pool": "Pool", "Live Auction": "Auction", "Rosters": "Rosters", "Fixtures": "Fixtures", "Leaderboard": "Ranks", "My Account": "My account" };
const byText = (p, t) => p.evaluate((t) => { const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim().toLowerCase() === t.toLowerCase()); b?.click(); return !!b; }, t);
const nav = (label) => async (p) => {
  if (!(await byText(p, SHORT[label] || label)) && !(await byText(p, label))) {
    await byText(p, "More"); await wait(500);
    await byText(p, label) || await byText(p, SHORT[label] || label);
  }
  await wait(2200);
};
const click = (sel) => async (p) => { await p.evaluate((s) => document.querySelector(s)?.click(), sel); await wait(1500); };
const clickText = (t) => async (p) => {
  await p.evaluate((t) => {
    const els = [...document.querySelectorAll("button, [role=button], div, a")].filter((e) => e.textContent.trim().toUpperCase().startsWith(t));
    els.sort((a, b) => a.textContent.length - b.textContent.length); els[0]?.click();
  }, t.toUpperCase());
  await wait(1600);
};
const hub = async (p) => {   // phones reach the hub through More
  if (!(await p.evaluate(() => { const b = [...document.querySelectorAll("button")].find((b) => /league hub/i.test(b.textContent)); b?.click(); return !!b; }))) {
    await byText(p, "More"); await wait(600);
    await p.evaluate(() => [...document.querySelectorAll("button")].find((b) => /league hub/i.test(b.textContent))?.click());
  }
  await wait(2500);
};
const hubPage = (label) => async (p) => { await p.evaluate((l) => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().toLowerCase() === l)?.click(), label); await wait(1200); };
const drawer = async (p) => { await byText(p, "More"); await wait(700); };
const menu = async (p) => { await p.evaluate(() => document.querySelector('button[aria-label="Account menu"]')?.click()); await wait(700); };

const SHOTS = [
  ["01-dashboard", "auction", []],
  ["02-more-sheet", "auction", [drawer]],
  ["03-account-menu", "auction", [menu]],
  ["04-player-pool", "pool", [nav("Player Pool")]],
  ["05-scout-modal", "pool", [nav("Player Pool"), clickText("KAIRO")]],
  ["06-auction", "auction", [nav("Live Auction")]],
  ["07-spin", "spin", [nav("Live Auction")]],
  ["08-reserve", "drafted", [nav("Reserve Pool")]],
  ["09-rosters", "drafted", [nav("Rosters")]],
  ["10-mock-draft", "pool", [nav("Mock Draft")]],
  ["11-fixtures-bracket", "bracket", [nav("Fixtures")]],
  ["12-match-modal", "bracket", [nav("Fixtures"), click("[aria-label^='SF 1']")]],
  ["13-fixtures-league", "league", [nav("Fixtures")]],
  ["14-leaderboard", "league", [nav("Leaderboard")]],
  ["15-map-veto", "bracket", [nav("Map Veto")]],
  ["16-account", "auction", [nav("My Account")]],
  ["17-hub-overview", "league", [hub]],
  ["18-hub-season", "league", [hub, hubPage("season")]],
  ["19-hub-tournaments", "league", [hub, hubPage("events")]],
  ["20-welcome", "", []],
];

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--hide-scrollbars"] });
try {
  for (const [name, scene, steps] of SHOTS) {
    if (only && !name.includes(only)) continue;
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(scene ? `${BASE}?demo=${scene}` : BASE, { waitUntil: "networkidle2" });
    await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
    await wait(3000);
    for (const s of steps) await s(page);
    await wait(500);
    const over = await page.evaluate((W) => {
      const wide = document.documentElement.scrollWidth;
      const culprits = [];
      if (wide > W + 1) for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.right > W + 2 && r.width > 0 && getComputedStyle(el).position !== "fixed") culprits.push(`${el.tagName.toLowerCase()}.${(el.className?.baseVal ?? el.className ?? "").toString().split(" ").slice(0, 2).join(".")} w${Math.round(r.width)} r${Math.round(r.right)} "${(el.textContent || "").trim().slice(0, 30)}"`);
      }
      return { wide, culprits: culprits.slice(0, 6) };
    }, W);
    await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
    await page.evaluate(() => window.scrollTo(0, 0)); await wait(200);
    await page.screenshot({ path: `${OUT}view/${name}.png` });   // what the phone shows first
    console.log(over.wide > W + 1 ? `⚠ ${name} scrolls sideways (${over.wide}px)\n    ` + over.culprits.join("\n    ") : `✓ ${name}`);
    await page.close();
  }
} finally { await browser.close(); }
