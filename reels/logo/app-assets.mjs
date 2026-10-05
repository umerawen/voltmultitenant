// App icons and splash screens for the Capacitor projects, rendered from the
// brand SVGs in public/brand at every size iOS and Android ask for.
//
//   node reels/logo/app-assets.mjs     (from the repo root or anywhere)
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const brand = (f) => pathToFileURL(path.join(ROOT, "public", "brand", f)).href;
const RES = path.join(ROOT, "android", "app", "src", "main", "res");
const IOS = path.join(ROOT, "ios", "App", "App", "Assets.xcassets");
const NAVY = "#0a0d18";

// shape: "square" (iOS: opaque, the OS rounds it), "rounded", "circle", "fg" (adaptive foreground, transparent)
const icon = (size, shape) => {
  const fg = shape === "fg";
  const mark = fg ? 0.46 : 0.6;   // adaptive icons crop to the inner 66%; keep the bolt inside it
  const radius = shape === "circle" ? "50%" : shape === "rounded" ? "22%" : "0";
  const bg = fg ? "transparent" : "radial-gradient(circle at 50% 38%, #1c2c5a 0%, #111a35 45%, #080c18 100%)";
  return `<html><body style="margin:0;background:transparent">
  <div style="width:${size}px;height:${size}px;border-radius:${radius};overflow:hidden;position:relative;background:${bg};display:grid;place-items:center">
    ${fg ? "" : `<div style="position:absolute;inset:0;background:radial-gradient(circle at 50% 50%, rgba(61,123,255,0.35), rgba(61,123,255,0) 55%)"></div>`}
    <img src="${brand("volt-mark.svg")}" style="position:relative;width:${Math.round(size * mark)}px;height:auto;filter:drop-shadow(0 ${Math.round(size * 0.02)}px ${Math.round(size * 0.05)}px rgba(61,123,255,0.45))">
  </div></body></html>`;
};
const splash = (w, h) => {
  const m = Math.min(w, h);
  return `<html><body style="margin:0;background:${NAVY}">
  <div style="width:${w}px;height:${h}px;display:grid;place-items:center;background:radial-gradient(ellipse at 50% 45%, #14204a 0%, ${NAVY} 60%)">
    <img src="${brand("volt-wordmark.svg")}" style="width:${Math.round(m * 0.42)}px;height:auto;filter:drop-shadow(0 0 ${Math.round(m * 0.03)}px rgba(61,123,255,0.5))">
  </div></body></html>`;
};

const jobs = [];
const DENS = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
for (const [d, k] of Object.entries(DENS)) {
  jobs.push([icon(48 * k, "rounded"), 48 * k, 48 * k, `${RES}/mipmap-${d}/ic_launcher.png`]);
  jobs.push([icon(48 * k, "circle"), 48 * k, 48 * k, `${RES}/mipmap-${d}/ic_launcher_round.png`]);
  jobs.push([icon(108 * k, "fg"), 108 * k, 108 * k, `${RES}/mipmap-${d}/ic_launcher_foreground.png`]);
}
const SPL = { mdpi: [320, 480], hdpi: [480, 800], xhdpi: [720, 1280], xxhdpi: [960, 1600], xxxhdpi: [1280, 1920] };
for (const [d, [w, h]] of Object.entries(SPL)) {
  jobs.push([splash(w, h), w, h, `${RES}/drawable-port-${d}/splash.png`]);
  jobs.push([splash(h, w), h, w, `${RES}/drawable-land-${d}/splash.png`]);
}
jobs.push([splash(480, 320), 480, 320, `${RES}/drawable/splash.png`]);
jobs.push([icon(1024, "square"), 1024, 1024, `${IOS}/AppIcon.appiconset/AppIcon-512@2x.png`]);
for (const f of ["splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"])
  jobs.push([splash(2732, 2732), 2732, 2732, `${IOS}/Splash.imageset/${f}`]);
// store listing icon (Play Console wants 512)
jobs.push([icon(512, "square"), 512, 512, path.join(ROOT, "public", "brand", "app-store-icon-512.png")]);

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();
for (const [html, w, h, out] of jobs) {
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  const tmp = path.join(ROOT, "reels", "logo", ".tmp-asset.html");
  fs.writeFileSync(tmp, html);
  await page.goto(pathToFileURL(tmp).href, { waitUntil: "networkidle0" });
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  fs.unlinkSync(tmp);
}
await browser.close();
// adaptive icon background colour
fs.writeFileSync(`${RES}/values/ic_launcher_background.xml`, `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0D1430</color>\n</resources>\n`);
console.log("✓", jobs.length, "assets");
