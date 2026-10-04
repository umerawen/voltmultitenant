// Record the auction draw (the player-card spin) frame by frame.
//
// The spin is driven by Date.now(), so this freezes the page clock and steps
// it: every frame is exact, at any speed. Spin frames advance `speed`× real
// time; after the landing the reveal plays at 1×.
//
//   node capture-spin.mjs --real data/kami-labs.json --out screens/kami-spin.mp4 [--speed 2.25] [--hold 1.2]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const realFile = opt("--real", null), out = opt("--out", "screens/spin.mp4");
const speed = +opt("--speed", 2.25), hold = +opt("--hold", 1.2), fps = 30;
const BASE = process.env.VOLT_URL || "http://localhost:5174/";
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const real = realFile ? JSON.parse(fs.readFileSync(realFile, "utf8")) : null;
const tmp = path.join(path.dirname(out), ".spin-frames");
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--hide-scrollbars", "--force-color-profile=srgb"] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument((r) => {
  if (r) window.__demoReal = r;
  const realNow = Date.now.bind(Date);
  let frozen = null;
  window.__clock = { freeze: (t) => { frozen = t; }, real: realNow };
  Date.now = () => (frozen ?? realNow());
}, real);
await page.goto(`${BASE}?demo=spin`, { waitUntil: "networkidle2" });
await page.evaluate(() => document.querySelector('button[aria-label="Live Auction"]')?.click());
// wait for the board, then freeze just before the spin starts
await page.waitForFunction(() => window.__demoBoard?.spin, { timeout: 20000 });
const { startTs, duration } = await page.evaluate(() => window.__demoBoard.spin);
await page.evaluate((t) => window.__clock.freeze(t), startTs - 1);
await new Promise((r) => setTimeout(r, 1500));
const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
await raf();
// the stage: heading + reel + status
const clip = await page.evaluate(() => {
  const h = [...document.querySelectorAll("h2")].find((e) => /drawing the next player|target acquired/i.test(e.textContent));
  const root = h?.closest(".w-full.flex.flex-col.items-center");
  const r = (root || document.body).getBoundingClientRect();
  return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: Math.min(r.width, 1920 - r.x), height: r.height };
});
console.log("stage", clip);

const stepSpin = (1000 / fps) * speed, stepHold = 1000 / fps;
let t = 0, k = 0;
const frames = [];
while (t <= duration) { frames.push(t); t += stepSpin; }
frames.push(duration);
for (let h = stepHold; h <= hold * 1000; h += stepHold) frames.push(duration + h);
for (const ft of frames) {
  await page.evaluate((v) => window.__clock.freeze(v), startTs + ft);
  await raf();
  await page.screenshot({ path: path.join(tmp, `f${String(k++).padStart(4, "0")}.png`), clip });
}
await browser.close();
execFileSync(FFMPEG, ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(tmp, "f%04d.png"),
  "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]);
fs.rmSync(tmp, { recursive: true, force: true });
console.log("✓", out, k, "frames", (k / fps).toFixed(2) + "s", "landing at", ((Math.ceil(duration / stepSpin)) / fps).toFixed(2) + "s");
