// Bakes the grunge reel's textures (procedural, no stock images):
//   tex/grunge-wall.png    dark concrete wall, 1240x2200 (a little larger than
//                                 the frame, so it can "boil" by a few px)
//   tex/grunge-streak.png a dry-brush mask for the brush lettering
//   tex/grunge-erode.png   a type mask: opaque, with worn specks punched out
//   node lib/grunge-textures.mjs
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "../tex");
fs.mkdirSync(OUT, { recursive: true });

// a seeded random, so the wall is the same on every bake
const rnd = `let s=20261007;const R=()=>(s=(s*16807)%2147483647)/2147483647;`;

const wall = (W, H) => `<!doctype html><html><body style="margin:0;background:#141312">
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <defs>
    <filter id="stain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.0035" numOctaves="5" seed="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncR type="linear" slope="1.6" intercept="-0.3"/><feFuncG type="linear" slope="1.6" intercept="-0.3"/><feFuncB type="linear" slope="1.6" intercept="-0.3"/></feComponentTransfer></filter>
    <filter id="conc" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.045" numOctaves="4" seed="9"/><feColorMatrix type="saturate" values="0"/></filter>
    <filter id="grain" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="5"/><feColorMatrix type="saturate" values="0"/></filter>
    <filter id="chips" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="5" seed="11"/><feColorMatrix type="matrix" values="0 0 0 0 0.85  0 0 0 0 0.84  0 0 0 0 0.82  16 0 0 0 -11.6"/></filter>
    <filter id="rough"><feTurbulence type="fractalNoise" baseFrequency="0.08" numOctaves="2" seed="2"/><feDisplacementMap in="SourceGraphic" scale="14"/></filter>
    <radialGradient id="pool" cx="48%" cy="38%" r="55%"><stop offset="0" stop-color="#fff" stop-opacity="0.07"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <radialGradient id="vig" cx="50%" cy="46%" r="75%"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></radialGradient>
  </defs>
  <rect width="100%" height="100%" fill="#1c1b1a"/>
  <rect width="100%" height="100%" filter="url(#stain)" style="opacity:0.22"/>
  <rect width="100%" height="100%" fill="url(#pool)"/>
  <rect width="100%" height="100%" filter="url(#conc)" style="mix-blend-mode:soft-light;opacity:0.7"/>
  <rect width="100%" height="100%" filter="url(#grain)" style="mix-blend-mode:overlay;opacity:0.22"/>
  <rect width="100%" height="100%" filter="url(#chips)" style="opacity:0.13"/>
  <g id="scratch" filter="url(#rough)"></g>
  <g id="splat"></g>
  <rect width="100%" height="100%" fill="url(#vig)"/>
</svg>
<script>${rnd}
const NS="http://www.w3.org/2000/svg", W=${W}, H=${H};
const g=document.getElementById("scratch");
for(let i=0;i<70;i++){ // thin scratches, mostly vertical, a few long
  const x=R()*W,y=R()*H,len=40+R()*(R()<0.15?700:220),a=(R()-0.5)*0.5+(R()<0.25?1.4:0);
  const p=document.createElementNS(NS,"path");
  p.setAttribute("d","M"+x+" "+y+" q"+(Math.sin(a)*len*0.5+(R()-0.5)*20)+" "+(Math.cos(a)*len*0.5)+" "+Math.sin(a)*len+" "+Math.cos(a)*len);
  p.setAttribute("stroke","rgba(220,215,205,"+(0.04+R()*0.1)+")");p.setAttribute("stroke-width",(0.6+R()*1.6));p.setAttribute("fill","none");
  g.appendChild(p);
}
const sp=document.getElementById("splat");
const blob=(cx,cy,r,col,op)=>{ // a paint splat: a core, satellites, a drip or two
  const add=(x,y,rr)=>{const c=document.createElementNS(NS,"circle");c.setAttribute("cx",x);c.setAttribute("cy",y);c.setAttribute("r",rr);c.setAttribute("fill",col);c.setAttribute("opacity",op);sp.appendChild(c);};
  add(cx,cy,r);
  for(let i=0;i<26;i++){const a=R()*6.283,d=r*(0.8+R()*2.6);add(cx+Math.cos(a)*d,cy+Math.sin(a)*d,r*(0.04+R()*0.18));}
  for(let i=0;i<2;i++){const x=cx+(R()-0.5)*r,l=r*(1+R()*3);const p=document.createElementNS(NS,"path");p.setAttribute("d","M"+x+" "+cy+" v"+l);p.setAttribute("stroke",col);p.setAttribute("stroke-width",r*0.12);p.setAttribute("stroke-linecap","round");p.setAttribute("opacity",op);sp.appendChild(p);}
};
blob(W*0.9,H*0.08,26,"#d8d4cc",0.12); blob(W*0.08,H*0.72,18,"#d8d4cc",0.10); blob(W*0.85,H*0.9,34,"#b3242c",0.16); blob(W*0.15,H*0.22,10,"#d8d4cc",0.14);
for(let i=0;i<260;i++){const c=document.createElementNS(NS,"circle");c.setAttribute("cx",R()*W);c.setAttribute("cy",R()*H);c.setAttribute("r",0.6+R()*2.2);c.setAttribute("fill","rgba(230,226,218,"+(0.08+R()*0.3)+")");sp.appendChild(c);}
</script></body></html>`;

// type mask: white (kept) with holes; the holes come from thresholded noise
const erode = (S) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${S}" height="${S}" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <filter id="e" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="4" seed="21" stitchTiles="stitch" result="n"/>
    <feTurbulence type="fractalNoise" baseFrequency="0.6" numOctaves="2" seed="4" stitchTiles="stitch" result="g"/>
    <feComposite in="n" in2="g" operator="arithmetic" k2="0.75" k3="0.45" result="m"/>
    <feColorMatrix in="m" type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -14 0 0 0 9.4"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#e)"/>
</svg></body></html>`;

// dry-brush mask: long horizontal bristle gaps
const streak = (W, H) => `<!doctype html><html><body style="margin:0;background:transparent">
<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="display:block">
  <filter id="e" x="0" y="0" width="100%" height="100%">
    <feTurbulence type="fractalNoise" baseFrequency="0.0025 0.11" numOctaves="3" seed="8" stitchTiles="stitch"/>
    <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -12 0 0 0 8.1"/>
  </filter>
  <rect width="100%" height="100%" filter="url(#e)"/>
</svg></body></html>`;

const b = await puppeteer.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: "new" });
const p = await b.newPage();
await p.setViewport({ width: 1240, height: 2200 });
await p.setContent(wall(1240, 2200), { waitUntil: "load" });
await p.screenshot({ path: path.join(OUT, "grunge-wall.png"), clip: { x: 0, y: 0, width: 1240, height: 2200 } });
await p.setViewport({ width: 1024, height: 1024 });
await p.setContent(erode(1024), { waitUntil: "load" });
await p.screenshot({ path: path.join(OUT, "grunge-erode.png"), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 1024 } });
await p.setViewport({ width: 1024, height: 512 });
await p.setContent(streak(1024, 512), { waitUntil: "load" });
await p.screenshot({ path: path.join(OUT, "grunge-streak.png"), omitBackground: true, clip: { x: 0, y: 0, width: 1024, height: 512 } });
await b.close();
console.log("baked", OUT);
