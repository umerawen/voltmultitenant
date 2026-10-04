# VOLT — frame spec (all reels)

The reels must look like the product, because they show the product. Every
value here comes from the app itself (src/App.jsx), not a preset.

## Canvas

- format: 1080x1920 (9:16, Reels / TikTok / Shorts)
- canvas: #0a0d18 (navy-black, the app background)
- safe area: 90px left/right, 220px top, 340px bottom (platform UI: username, caption, buttons)

## Color

| role       | value                   | use                                              |
| ---------- | ----------------------- | ------------------------------------------------ |
| canvas     | #0a0d18                 | ground                                           |
| panel      | #111728 → #0a0d16       | cards, browser chrome                            |
| ink        | #ecf3ff                 | headlines                                        |
| ink-dim    | rgba(200,215,255,0.55)  | secondary copy                                   |
| volt       | #3d7bff                 | primary accent, brackets, rules, UI focus        |
| volt-hi    | #7da6ff                 | labels (// SECTION)                              |
| voltage    | #ff4655                 | the one hot accent: stripes, "SOLD", strikes     |
| money      | #3ddc84                 | bids, prices, success ticks                      |
| gold       | #f5c453                 | champions, MVP, season leader                    |

Team hues (from the demo board) may appear only inside product screens.

## Type

- display: Rajdhani 700, uppercase, tight (letter-spacing 0.01em, line-height 0.9)
- label: Rajdhani 700, uppercase, letter-spacing 0.3em, 22–26px, volt-hi, prefixed "// "
- data: IBM Plex Mono 700 for every number (prices, ACS, counters), tabular
- body: Space Grotesk 500 for the rare sentence

Headline sizes at 1080 wide: hero 150–190px, beat headline 96–120px, caption 54–64px.

## Shape language

- Notched corners everywhere: polygon cut 16–24px on top-right and bottom-left
  (the app's SHELL_NOTCH). No rounded corners, no pills.
- Corner brackets (2px volt, 14px arms) frame focal panels.
- Thin 1px rules fading right after every // label.
- Product screens sit in a dark browser frame (notched, 1px rgba(120,150,220,0.25)
  border, three tiny dots, the URL "volt.gg/apex-league").

## Motion

- Snappy and confident: power3/expo outs, 0.35–0.6s for UI, 0.2s for type hits.
- Camera = transform on the screen plate: push-ins to the exact element being
  named, never a generic zoom. Plates are 2x captures, so pushes up to 2x stay sharp.
- Numbers count up in IBM Plex Mono.
- One accent hit per beat (stripe wipe, stamp, flash), never several at once.
- Cuts land on the music's downbeats.

## Avoid

Stock photography, emoji, rounded SaaS cards, gradients that aren't the app's,
more than one hot accent per frame, any real player names (demo data only).
