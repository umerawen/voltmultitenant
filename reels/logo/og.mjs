// The picture shown when a VOLT link is pasted into Discord, WhatsApp etc.
//   node logo/og.mjs  → public/brand/volt-og.jpg (1200×630)
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.resolve(HERE, "../../public");
const lockup = fs.readFileSync(path.join(PUBLIC, "brand/volt-lockup.svg"), "utf8");
const art = pathToFileURL(path.join(PUBLIC, "img/art-omen-void.webp")).href;

const html = `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@700&display=block" rel="stylesheet">
<style>
  * { margin: 0; box-sizing: border-box; }
  body { width: 1200px; height: 630px; overflow: hidden; position: relative; background: #070a14; font-family: Rajdhani, sans-serif; }
  /* Mirrored so the hooded figure stands on the right and the left stays clear for type. */
  .art { position: absolute; inset: 0; background: url("${art}") -244px 0 / 1300px auto no-repeat; transform: scaleX(-1); }
  .fade { position: absolute; inset: 0; background: linear-gradient(90deg, #070a14 0%, rgba(7,10,20,0.92) 36%, rgba(7,10,20,0.25) 62%, rgba(7,10,20,0) 78%); }
  .copy { position: absolute; left: 72px; top: 0; bottom: 0; display: flex; flex-direction: column; justify-content: center; }
  .copy svg { display: block; width: 400px; height: auto; margin-bottom: 44px; }
  h1 { font-size: 68px; line-height: 0.98; font-weight: 700; letter-spacing: 0.005em; text-transform: uppercase; color: #f4f8ff; }
  h1 b { color: #6f9bff; font-weight: 700; }
</style></head><body>
  <div class="art"></div><div class="fade"></div>
  <div class="copy">${lockup}<h1>Valorant leagues<br>with a <b>live<br>auction draft</b></h1></div>
</body></html>`;

const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--allow-file-access-from-files"] });
const page = await browser.newPage();
await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
const tmp = path.join(HERE, "og.tmp.html");
fs.writeFileSync(tmp, html);
await page.goto(pathToFileURL(tmp).href, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: path.join(PUBLIC, "brand/volt-og.jpg"), type: "jpeg", quality: 88 });
await browser.close();
fs.unlinkSync(tmp);
