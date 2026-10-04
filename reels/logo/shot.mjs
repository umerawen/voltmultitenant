// Render a logo sheet to PNG: node logo/shot.mjs logo/concepts.html out.png
import puppeteer from "puppeteer-core";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [src, out] = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const page = await browser.newPage();
await page.setViewport({ width: 1880, height: 1000, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(path.resolve(src)).href, { waitUntil: "networkidle0" });
await page.evaluate(() => document.fonts.ready);
await page.screenshot({ path: out, fullPage: true });
await browser.close();
