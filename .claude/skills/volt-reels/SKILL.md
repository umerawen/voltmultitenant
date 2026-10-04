---
name: volt-reels
description: Make VOLT marketing reels (Instagram Reels / TikTok / Shorts) from real VOLT web screens with HyperFrames. Use when asked for a promo, reel, short, ad or social video for VOLT, its players or its hosts.
---

# VOLT reels

Vertical 1080x1920 videos that sell VOLT using the product's real web screens
(never mock-ups, never real players' names), soft synthesised SFX and no
voiceover. Built with HyperFrames (HTML + GSAP rendered to MP4) through a small
engine, so a new reel is a spec, not hand-written HTML.

## Where things live

- `reels/reels.mjs` — every reel as a spec (scenes on a timeline). Start here.
- `reels/lib/engine.mjs` + `reel.css` — scene kinds, camera, overlays,
  transitions; writes `videos/<id>/index.html`, `assets/`, `cues.json`.
- `reels/sfx/synth.py` — numpy-only soft SFX + 120 BPM ambient bed, mixed from
  `cues.json`.
- `reels/render.sh [filter]` — build → `hyperframes render` → synth → mux with
  loudnorm (-14 LUFS) → `reels/renders/NN-<id>.mp4`.
- `reels/snap.sh [filter] [n]` — contact sheet per reel for review.
- `reels/capture-screens.mjs` — the screens, `reels/screens/` (git-ignored).
- `reels/frame.md` — the visual rules (navy, VOLT blue, one red hit per frame,
  Rajdhani / IBM Plex Mono, notched corners).

## 1. Screens with invented data

The offline preview (no Supabase keys) has a demo mode: `?demo=<scene>` fills
the app from `src/demo.js` (scenes `pool`, `auction`, `drafted`, `bracket`,
`final`, `league`; compiled out of production).

1. Start launch config `volt-offline` (port 5174).
2. `cd reels && node capture-screens.mjs [filter]` → `screens/<name>.png`
   (1920x1080 at 2x) plus `screens/<name>.json`, the rects of named marks.
3. New screen: add a row to `SHOTS` (steps + marks). New data: extend
   `src/demo.js`, invented names only.

## 2. Write the reel

Add a spec to `REELS` in `reels.mjs`. Scene kinds:

- `hook` — kinetic statement; optional `art` (landscape key art band),
  `agent` (cut-out from public/img) or `ghost` (huge outlined word).
- `screen` — a screen in a browser frame (or `frame: false` full bleed) with
  `cam` keyframes (`focus` a mark or `center` + `w` visible width in screen
  px), `marks` (brackets + tags), `cursor`, `toasts`, `stamp`, `count`.
- `stat` — count-up numbers. `list` — rows that tick or get struck through.
- `montage` — one-beat full-bleed cuts with a word each. `cta` — crest + ask.

Keep cuts on the 0.5s grid, 15–25s per reel, end on a `cta`. Markup in text:
`[red] {blue} |green| ~gold~`. Every scene adds its own SFX cues; extra cues go
in the spec's `cues`.

## 3. Review and render

`bash snap.sh <id>` and look at `videos/<id>/snapshots/contact-sheet.jpg`;
`npx hyperframes lint` inside the project (structural warnings are expected).
Then `FFMPEG=<path> bash render.sh <id>`. Sound stays soft: no fast attacks, no
bright transients; tune `sfx/synth.py`, not per reel.

## Real league, stage, draw, voiceover (current practice)

- **Real data.** Marketing uses the owner's last league (Kami Labs) with their OK.
  Pull it from Supabase into `reels/data/<league>.json` (git-ignored: players,
  captains, draft-night team names, sale order, block, tournament, leaderboard,
  league events, the viewer's card). Capture with
  `node capture-screens.mjs --real data/<league>.json --prefix <league>-`.
  Use draft-night team names (one team was later renamed "ISIS"); skip test events.
- **No cropping frames.** Use the `stage` scene: the whole screen as a tilted,
  feathered plane, and `pieces` (rects in screen px) lifted off it as cards,
  cut to the component's shape (`shape: "notch" | "slant"`), with `live`
  values (a ticking price) and `focus` tags. Lift grouped cards separately,
  with space between them.
- **The auction spin.** Never screen-record it. `node capture-cards.mjs --real ...
  --out screens/<league>-draw` grabs each card still; the `draw` scene animates
  it (ease up, cruise ~14 cards/s, glide to the winner, motion blur, ticks).
- **Voiceover.** ElevenLabs (voice "Christina", `eleven_v3`; use
  `eleven_multilingual_v2` with `<break>` tags when every beat must be
  separable). Download, `python vo/tighten.py raw.wav vo/<reel>.flac 0.5`,
  then time scenes to the printed phrase starts (`vo: { file, t }` in the spec).
  The bed and SFX duck under the voice automatically.
- Reels render at `fps: 60`.
- **The launch reel** (`volt-launch`, ~46s) uses its own voice, "Jett - Gritty,
  Spunky Young Hero" (`6IwYbsNENZgAB1dtBZDp`, multilingual_v2 with breaks), so the
  brand launch sounds distinct from the feature reels. A mid-reel logo sting
  is a `cta` with `button: false, exit: "fade", tag: "// INTRODUCING"`.
- Prefer `stage` scenes over `montage`: the montage crops screens full-bleed.
