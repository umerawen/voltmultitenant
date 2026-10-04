// Export the VOLT brand kit (mark by the owner; colour, wordmark and icon here).
//   node logo/build.mjs   → public/brand/*.svg + *.png, public/favicon.ico-sized PNGs
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../../public/brand");
fs.mkdirSync(OUT, { recursive: true });

const ARM = "M344.811 140.139H0L273.118 552.012L436.988 278.57L344.811 140.139Z";
const BOLT = "M392.606 466.561L689.622 0H1002L303.843 834L549.649 401.619L392.606 466.561Z";
const WORD = [
  "M0 0H10.5L17.5 27L24.5 0H35L23 40H12Z",
  "M40 0H66L74 8V40H48L40 32ZM49 9V31H65V9Z",
  "M80 0H89.5V31H105V40H80Z",
  "M109 0H146V9.5H132.25V40H122.75V9.5H109Z",
];
const grads = `
  <linearGradient id="bolt" x1="1" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#8db3ff"/><stop offset="0.55" stop-color="#3d7bff"/><stop offset="1" stop-color="#1f47c9"/></linearGradient>
  <linearGradient id="arm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9cbef"/></linearGradient>
  <linearGradient id="armBlue" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6b9cff"/><stop offset="1" stop-color="#2a5be0"/></linearGradient>
  <linearGradient id="red" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff7a85"/><stop offset="1" stop-color="#e2303f"/></linearGradient>
  <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16203d"/><stop offset="1" stop-color="#090d1a"/></linearGradient>`;
const svg = (w, h, body, vb = `0 0 ${w} ${h}`) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${vb}" fill="none"><defs>${grads}</defs>${body}</svg>\n`;
const mark = (arm, bolt, tf = "") => `<g${tf ? ` transform="${tf}"` : ""}><path d="${ARM}" fill="${arm}"/><path d="${BOLT}" fill="${bolt}"/></g>`;
const word = (fill, tf) => `<g transform="${tf}" fill="${fill}">${WORD.map((d) => `<path d="${d}" fill-rule="evenodd"/>`).join("")}</g>`;
const olt = (fill, tf) => `<g transform="${tf}" fill="${fill}">${WORD.slice(1).map((d) => `<path d="${d}" fill-rule="evenodd"/>`).join("")}</g>`;
const tile = `<path d="M0 0H432L512 80V512H80L0 432Z" fill="url(#tile)"/><path d="M3 3H431L509 81V509H81L3 431Z" fill="none" stroke="#7da6ff" stroke-opacity="0.28" stroke-width="6"/>`;

const files = {
  // marks
  "volt-mark.svg": svg(1002, 834, mark("url(#arm)", "url(#bolt)")),
  "volt-mark-voltage.svg": svg(1002, 834, mark("url(#armBlue)", "url(#red)")),
  "volt-mark-white.svg": svg(1002, 834, mark("#f4f8ff", "#f4f8ff")),
  "volt-mark-navy.svg": svg(1002, 834, mark("#0a0f1e", "#0a0f1e")),
  "volt-mark-on-light.svg": svg(1002, 834, mark("#0a0f1e", "url(#bolt)")),
  // lockups: mark + VOLT (dark and light backgrounds)
  "volt-lockup.svg": svg(1640, 420, mark("url(#arm)", "url(#bolt)", "translate(0 0) scale(0.5036)") + word("#f4f8ff", "translate(600 60) scale(7)")),
  "volt-lockup-on-light.svg": svg(1640, 420, mark("#0a0f1e", "url(#bolt)", "scale(0.5036)") + word("#0a0f1e", "translate(600 60) scale(7)")),
  // the mark standing in as the V of VOLT
  "volt-wordmark.svg": svg(1280, 420, mark("url(#arm)", "url(#bolt)", "scale(0.5036)") + olt("#f4f8ff", "translate(156 100) scale(7.6)")),
  "volt-wordmark-on-light.svg": svg(1280, 420, mark("#0a0f1e", "url(#bolt)", "scale(0.5036)") + olt("#0a0f1e", "translate(156 100) scale(7.6)")),
  // app / Discord / favicon tile
  "volt-icon.svg": svg(512, 512, tile + mark("url(#arm)", "url(#bolt)", "translate(76 112) scale(0.36)")),
};
for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(OUT, name), body);

// rasters
const PNG = [
  ["volt-icon.svg", "volt-icon-512.png", 512, 512],
  ["volt-icon.svg", "volt-icon-192.png", 192, 192],
  ["volt-icon.svg", "apple-touch-icon.png", 180, 180],
  ["volt-icon.svg", "favicon-32.png", 32, 32],
  ["volt-icon.svg", "favicon-16.png", 16, 16],
  ["volt-lockup.svg", "volt-lockup.png", 1640, 420],
  ["volt-lockup-on-light.svg", "volt-lockup-on-light.png", 1640, 420],
  ["volt-wordmark.svg", "volt-wordmark.png", 1280, 420],
  ["volt-mark.svg", "volt-mark.png", 1002, 834],
];
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
for (const [src, out, w, h] of PNG) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const body = fs.readFileSync(path.join(OUT, src), "utf8").replace(/width="\d+" height="\d+"/, `width="${w}" height="${h}"`);
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}</body></html>`);
  await page.screenshot({ path: path.join(OUT, out), omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
}
await browser.close();
console.log("wrote", Object.keys(files).length, "svg +", PNG.length, "png to public/brand/");
