---
name: volt-reels
description: Make VOLT marketing reels (Instagram Reels / TikTok / Shorts) from real VOLT web screens with HyperFrames. Use when asked for a promo, reel, short, ad or social video for VOLT, its players or its hosts.
---

# VOLT reels

Short vertical videos that sell VOLT using the product's real web screens,
never mock-ups, and never real players' names. Built with HyperFrames (HTML +
GSAP compositions rendered to MP4). HyperFrames' own skills are installed
globally (`/hyperframes`, `/product-launch-video`, `/hyperframes-core`, …);
read `/hyperframes` first for any new video, then follow this file for the
VOLT-specific parts.

## Where things live

- `reels/` — the video workspace (own package.json with `hyperframes`).
- `reels/frame.md` — VOLT's design system for video (copied into each project).
  Not a HyperFrames preset: none of them fit a dark esports product.
- `reels/videos/<project>/` — one HyperFrames project per reel
  (`BRIEF.md`, `STORYBOARD.md`, `frame.md`, `compositions/`, `renders/`).
- `reels/screens/` — 2x desktop captures (git-ignored; regenerate).
- `reels/storyboard/` — the review sheet (`node storyboard/build.mjs`).
- `reels/music/` — tracks the user downloaded (git-ignored).

## 1. Get real screens with invented data

The app has a demo mode: in the **offline preview** (no Supabase keys) add
`?demo=<scene>` and it fills the board, your player card, the leaderboard and
the league page from `src/demo.js`. Scenes: `pool`, `auction`, `drafted`,
`bracket`, `league`. It is compiled out of production builds.

1. Start the offline preview: launch config `volt-offline` (port 5174).
2. `cd reels && node capture-screens.mjs [filter]` → `screens/*.png`
   (1920x1080 at 2x, so a reel can push in up to 2x and stay sharp).
3. Need a new screen? Add a row to `SHOTS` in `capture-screens.mjs`; need new
   data? Extend `src/demo.js` (keep every name invented).

Web screens only, shown in a browser frame. Never capture the live site with a
real league: those are real people.

## 2. Plan

Per reel: `BRIEF.md` (message, audience, length, assets) and `STORYBOARD.md`
in HyperFrames' storyboard format (`/hyperframes` → references/storyboard-format.md).
Keep reels 15–22s, 6–8 frames, one idea per frame, words on screen instead of
narration. Then add the reel to `reels/storyboard/build.mjs` and send the user
`storyboard/index.html` for approval before building motion.

## 3. Music

Royalty-free only (Pixabay Content License or similar). Pixabay blocks scripted
downloads, so the user downloads the chosen tracks into `reels/music/`; then
`npx hyperframes beats` maps the downbeats so cuts land on them.

## 4. Build and render

Follow `/product-launch-video` Steps 4–6 inside `reels/videos/<project>/`,
with `frame.md` as the visual source of truth: navy canvas, VOLT blue, one red
accent hit per frame, Rajdhani display, IBM Plex Mono numbers, notched corners.
`npx hyperframes check` and `snapshot` before showing the user; render with
`npx hyperframes render --quality high --output renders/<project>.mp4` only
after they approve.
