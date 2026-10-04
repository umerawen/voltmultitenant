// Builds storyboard/index.html from the three STORYBOARD.md plans: one row of
// 9:16 frame sketches per reel, each showing the real screen region the camera
// lands on. Re-run after editing a storyboard: node storyboard/build.mjs
import fs from "node:fs";

const REELS = [
  { id: "volt-solo-to-signed", title: "Reel 1 · Solo to Signed", who: "Players", music: "Energetic electronic, drop on SOLD", frames: [
    { t: "Hook", d: 2.2, tr: "cut", type: ["NO TEAM?", "NO PROBLEM."], note: "Type slams in; red stripe wipes; second line swaps in." },
    { t: "Sign up solo", d: 3.0, tr: "whip up", img: "league-page", pos: "28% 62%", zoom: 2.3, text: "SIGN UP SOLO.", note: "Push into the tournament card; cursor taps; YOU'RE IN ✓ pops." },
    { t: "Your card", d: 3.2, tr: "match cut", img: "dashboard", pos: "38% 60%", zoom: 1.9, text: "YOUR STATS BECOME YOUR SCOUTING CARD.", note: "Drift across the Jett card; ACS 286 and KDA 1.42 count up." },
    { t: "Scouted", d: 3.0, tr: "crossfade", img: "player-pool", pos: "70% 78%", zoom: 1.8, text: "CAPTAINS SCOUT EVERY PLAYER.", note: "Grid tilts and scrolls; KAIRO lights up, the rest dim." },
    { t: "Bid on", d: 3.6, tr: "cut on beat", img: "auction-block", pos: "52% 70%", zoom: 2.1, text: "THEN THEY BID ON YOU.", hit: "SOLD", note: "Price races $2,100 → $2,900; bids stack; SOLD stamp on the drop." },
    { t: "Signed", d: 2.6, tr: "flash cut", img: "rosters", pos: "40% 45%", zoom: 1.7, text: "WELCOME TO THE TEAM.", note: "Your name drops into a team card with a team-colour glow." },
    { t: "CTA", d: 2.4, tr: "crossfade", cta: ["GET DRAFTED", "THIS WEEKEND."], note: "VOLT crest assembles; LINK IN BIO button." },
  ]},
  { id: "volt-bidding-war", title: "Reel 2 · The Bidding War", who: "Players & communities", music: "Tense rising pulse, hard drop on SOLD", frames: [
    { t: "Hook", d: 2.4, tr: "cut", counter: "$2,900", type: ["WHO WANTS", "ZEPHYR?"], note: "Huge mono counter jumps $2,100 → $2,900 with ticks." },
    { t: "The draw", d: 2.8, tr: "whip left", img: "player-pool", pos: "96% 92%", zoom: 2.4, text: "THE DRAW PICKS WHO'S UP.", note: "Cards rush past like a slot reel and lock on ZEPHYR." },
    { t: "The war", d: 4.0, tr: "cut on beat", img: "auction-block", pos: "50% 80%", zoom: 2.2, text: "CAPTAINS BID LIVE.", note: "Five bids, five beats: rows slide in, HELD BY swaps team each time." },
    { t: "The stakes", d: 2.4, tr: "zoom out", img: "auction-block", pos: "50% 40%", zoom: 1.15, text: "$10,000 EACH. SPEND IT WISELY.", note: "Pull back to both columns of team purses; bars drain." },
    { t: "SOLD", d: 2.4, tr: "cut on drop", img: "auction-block", pos: "53% 80%", zoom: 2.6, hit: "SOLD", text: "ZEPHYR → NOVA STRIKE · $2,900", note: "Slam onto SOLD; red stamp, one-frame flash, sparks, shake." },
    { t: "Aftermath", d: 2.0, tr: "crossfade", img: "auction-block", pos: "72% 96%", zoom: 2.2, text: "24 PLAYERS. ONE NIGHT.", note: "Record-sale card slides up; latest sales tick." },
    { t: "CTA", d: 2.0, tr: "crossfade", cta: ["RUN YOUR", "DRAFT NIGHT."], note: "VOLT crest; LINK IN BIO." },
  ]},
  { id: "volt-host-autopilot", title: "Reel 3 · Host on Autopilot", who: "League hosts", music: "Confident mid-tempo electronic, lift into CTA", frames: [
    { t: "Hook", d: 2.6, tr: "cut", type: ["RUNNING A LEAGUE", "IS A SECOND JOB."], strike: "WAS.", note: "Red strike through JOB, then WAS. types in." },
    { t: "One home", d: 3.0, tr: "whip up", img: "league-page", pos: "50% 22%", zoom: 1.6, text: "SIGN-UPS, TEAMS, STANDINGS. ONE PAGE.", note: "League page rises; stats count up; season race slides in." },
    { t: "Brackets", d: 3.2, tr: "cut", img: "fixtures-bracket", pos: "60% 66%", zoom: 1.6, text: "BRACKETS BUILD THEMSELVES.", note: "Connector lines draw; match cards drop in; a score lands." },
    { t: "Standings", d: 3.0, tr: "slide up", img: "fixtures-league", pos: "50% 55%", zoom: 1.5, text: "STANDINGS UPDATE THEMSELVES.", note: "Table rows reorder; a team climbs to #1 with a flash." },
    { t: "Discord", d: 3.0, tr: "cut", cards: ["TEAM ROOMS CREATED", "ROLES ASSIGNED", "MATCH REMINDERS SENT", "PREDICTIONS POSTED"], text: "YOUR DISCORD, ON AUTOPILOT.", note: "Four VOLT status cards tick in on the beat." },
    { t: "Database", d: 2.8, tr: "crossfade", img: "leaderboard", pos: "50% 40%", zoom: 1.5, text: "EVERY MATCH. EVERY STAT. SAVED.", note: "Podium and table scroll; ACS counts up." },
    { t: "CTA", d: 2.4, tr: "crossfade", cta: ["YOU PLAY.", "VOLT RUNS IT."], note: "VOLT crest; HOST YOUR LEAGUE — LINK IN BIO." },
  ]},
];

// Thumbnails are inlined so the sheet is one self-contained file.
const thumb = (n) => "data:image/jpeg;base64," + fs.readFileSync(new URL("./thumbs/" + n + ".jpg", import.meta.url)).toString("base64");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const crest = `<svg viewBox="0 0 40 44" width="44" height="48"><path d="M2.5 1.5h27l8 8v18.5L20 42.5 2.5 30z" fill="#1d3f9a" stroke="#9cbcff" stroke-width="1.2"/><path d="M30.6 3.4l4.9 4.9" stroke="#ff4655" stroke-width="2.2"/><text x="20" y="27.5" text-anchor="middle" font-family="Rajdhani" font-weight="700" font-size="21" fill="#fff">V</text></svg>`;

function cell(f, i, start) {
  let art = "";
  if (f.img) {
    art = `<div class="browser"><div class="bar"><i></i><i></i><i></i><span>volt.gg/apex-league</span></div>
      <div class="plate" style="background-image:url(${thumb(f.img)});background-size:${f.zoom * 100 * (16 / 9) / (16 / 9)}% auto;background-position:${f.pos}"></div></div>`;
  } else if (f.cards) {
    art = `<div class="cards">${f.cards.map((c) => `<div class="sc"><b>✓</b>${esc(c)}</div>`).join("")}</div>`;
  } else if (f.cta) {
    art = `<div class="cta">${crest}<div class="big">${f.cta.map(esc).join("<br>")}</div><div class="btn">LINK IN BIO</div></div>`;
  }
  const type = f.type ? `<div class="type">${f.counter ? `<div class="counter">${esc(f.counter)}</div>` : ""}${f.type.map((l, k) => `<div class="${k ? "l2" : "l1"}">${esc(l)}</div>`).join("")}${f.strike ? `<div class="strike">${esc(f.strike)}</div>` : ""}<span class="stripe"></span></div>` : "";
  const hit = f.hit ? `<div class="stamp">${esc(f.hit)}</div>` : "";
  const caption = f.text ? `<div class="cap">${esc(f.text)}</div>` : "";
  return `<figure class="cell">
    <div class="phone">${art}${type}${hit}${caption}</div>
    <figcaption><div class="row"><b>${i + 1} · ${esc(f.t)}</b><span>${start.toFixed(1)}–${(start + f.d).toFixed(1)}s</span></div>
    <div class="tr">in: ${esc(f.tr)}</div><p>${esc(f.note)}</p></figcaption></figure>`;
}

const rows = REELS.map((r) => {
  let t = 0;
  const cells = r.frames.map((f, i) => { const c = cell(f, i, t); t += f.d; return c; }).join("");
  return `<section><header><h2>${esc(r.title)}</h2><span>${esc(r.who)} · ${t.toFixed(1)}s · 1080×1920 · ${esc(r.music)}</span></header><div class="strip">${cells}</div></section>`;
}).join("");

fs.writeFileSync(new URL("./index.html", import.meta.url), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VOLT Reels Storyboard</title>
<link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&family=IBM+Plex+Mono:wght@500;700&family=Space+Grotesk:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{--bg:#0a0d18;--panel:#111728;--ink:#ecf3ff;--dim:rgba(200,215,255,.6);--volt:#3d7bff;--hi:#7da6ff;--red:#ff4655;--money:#3ddc84}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 "Space Grotesk",system-ui,sans-serif;padding:28px 24px 60px}
h1{font:700 34px Rajdhani;text-transform:uppercase;margin:0}h1+p{color:var(--dim);margin:6px 0 26px}
section{margin-bottom:38px}header{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:12px;border-bottom:1px solid rgba(120,150,220,.2);padding-bottom:8px}
h2{font:700 22px Rajdhani;text-transform:uppercase;letter-spacing:.04em;margin:0;color:var(--hi)}header span{color:var(--dim);font-size:13px}
.strip{display:grid;grid-template-columns:repeat(7,minmax(150px,1fr));gap:14px;overflow-x:auto}
.cell{margin:0}.phone{position:relative;aspect-ratio:9/16;background:radial-gradient(ellipse at 70% 20%,#14234d,var(--bg) 70%);border:1px solid rgba(120,150,220,.25);clip-path:polygon(0 0,calc(100% - 12px) 0,100% 12px,100% 100%,12px 100%,0 calc(100% - 12px));overflow:hidden}
.browser{position:absolute;left:7%;right:7%;top:24%;height:42%;background:#0d1322;border:1px solid rgba(120,150,220,.3);clip-path:polygon(0 0,calc(100% - 8px) 0,100% 8px,100% 100%,8px 100%,0 calc(100% - 8px))}
.bar{height:12px;display:flex;align-items:center;gap:3px;padding:0 5px;border-bottom:1px solid rgba(120,150,220,.2)}.bar i{width:4px;height:4px;border-radius:50%;background:rgba(200,215,255,.35)}.bar span{font:500 6px "IBM Plex Mono";color:var(--dim);margin-left:6px}
.plate{position:absolute;inset:12px 0 0 0;background-repeat:no-repeat}
.cap{position:absolute;left:8%;right:8%;top:70%;font:700 15px/0.95 Rajdhani;text-transform:uppercase;letter-spacing:.01em}
.type{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;padding:0 9%}.type .l1{font:700 26px/0.92 Rajdhani;text-transform:uppercase}.type .l2{font:700 26px/0.92 Rajdhani;color:var(--hi);text-transform:uppercase;margin-top:6px}
.type .strike{font:700 26px Rajdhani;color:var(--red);margin-top:6px}.type .stripe{position:absolute;left:0;right:30%;top:58%;height:4px;background:var(--red);transform:skewX(-28deg)}
.counter{font:700 34px "IBM Plex Mono";color:var(--money);margin-bottom:10px}
.stamp{position:absolute;left:50%;top:44%;transform:translate(-50%,-50%) rotate(-8deg);font:700 34px Rajdhani;color:var(--red);border:3px solid var(--red);padding:0 10px;letter-spacing:.06em;background:rgba(10,13,24,.6)}
.cards{position:absolute;left:8%;right:8%;top:22%;display:grid;gap:6px}.sc{font:700 9.5px Rajdhani;letter-spacing:.1em;padding:7px 8px;background:#111a30;border:1px solid rgba(61,123,255,.4);clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,0 100%)}.sc b{color:var(--money);margin-right:6px}
.cta{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center}.cta .big{font:700 20px/0.95 Rajdhani;text-transform:uppercase}.cta .btn{font:700 9px Rajdhani;letter-spacing:.2em;background:var(--volt);padding:6px 12px;clip-path:polygon(0 0,calc(100% - 6px) 0,100% 6px,100% 100%,6px 100%,0 calc(100% - 6px))}
figcaption{padding-top:8px}.row{display:flex;justify-content:space-between;gap:6px}.row b{font:700 13px Rajdhani;text-transform:uppercase;letter-spacing:.06em}.row span{font:500 11px "IBM Plex Mono";color:var(--dim)}
.tr{font:500 10.5px "IBM Plex Mono";color:var(--hi);margin-top:2px}figcaption p{margin:4px 0 0;color:var(--dim);font-size:12px;line-height:1.45}
</style></head><body><h1>VOLT reels · storyboard</h1><p>Three 9:16 reels built from real web screens (demo data). Each cell is the frame the viewer sees; thumbnails show the exact region the camera lands on.</p>${rows}</body></html>`);
console.log("storyboard/index.html written");
