// Quick stills of a built reel without a full render:
//   node lib/peek.mjs <id> <out.png> t1 t2 ...   (tiles the frames, 4 across)
// Clips are shown/hidden by their data-start/duration like the renderer does.
import puppeteer from "puppeteer-core";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REELS } from "./engine.mjs";

const [id, out, ...ts] = process.argv.slice(2);
const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new", args: ["--allow-file-access-from-files"] });
const p = await b.newPage();
await p.evaluateOnNewDocument(() => { window.__timelines = {}; });
await p.setViewport({ width: 1080, height: 1920 });
await p.goto("file:///" + path.join(REELS, "videos", id, "index.html").replace(/\\/g, "/"), { waitUntil: "networkidle0" });
await p.evaluate(() => document.fonts.ready);
const shots = [];
for (const [i, t] of ts.entries()) {
  await p.evaluate((t) => {
    for (const c of document.querySelectorAll("#root > .clip, #root > video.clip")) {
      const s = +c.dataset.start, d = +c.dataset.duration;
      c.style.visibility = t >= s && t < s + d ? "visible" : "hidden";
    }
    window.__timelines.main.seek(t, false);
  }, +t);
  await new Promise((r) => setTimeout(r, 60));
  const f = out.replace(/\.png$/, `-${i}.png`);
  await p.screenshot({ path: f });
  shots.push(f);
}
await b.close();
const FF = process.env.FFMPEG || "ffmpeg";
const cols = Math.min(4, shots.length), rows = Math.ceil(shots.length / cols);
execFileSync(FF, ["-y", "-loglevel", "error", ...shots.flatMap((f) => ["-i", f]), "-filter_complex",
  shots.map((_, i) => `[${i}]scale=360:640,drawtext=text='${ts[i]}':x=10:y=10:fontsize=28:fontcolor=yellow[v${i}]`).join(";") + ";" +
  shots.map((_, i) => `[v${i}]`).join("") + `xstack=inputs=${shots.length}:layout=` + shots.map((_, i) => `${(i % cols) * 360}_${Math.floor(i / cols) * 640}`).join("|") + (shots.length === 1 ? "" : ""),
  "-frames:v", "1", out]);
console.log(out);
