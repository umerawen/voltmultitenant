---
format: 1080x1920
duration: 20s
message: "No team? Sign up solo, get bid on in a live auction, play for a team."
arc: Hook → Sign up → Your card → Scouted → Bid on → Signed → CTA
audience: Valorant players without a five-stack
mode: collaborative
music: energetic electronic, punchy drums, builds into a drop at the SOLD beat
---

## Frame 1 — Hook: "No team?"

- scene: Giant kinetic type on navy: "NO TEAM?" slams in, a red voltage stripe wipes, "NO PROBLEM." replaces it
- duration: 2.2s
- transition_in: cut
- blueprint: kinetic-type-beats
- onscreen: "NO TEAM?" → "NO PROBLEM."
- asset_candidates: none (pure type)

Open on the pain every solo player knows. Two hits on the beat, the second word swap is the payoff.

## Frame 2 — Sign up solo

- scene: Browser frame flies up holding the league page; camera pushes into the tournament card; a cursor taps; "YOU'RE IN ✓" chip pops with a green flash
- duration: 3s
- transition_in: whip up
- blueprint: cursor-ui-demo
- onscreen: "SIGN UP SOLO."
- asset_candidates: league-page.png (tournament card + "You're in ✓" chip, x≈410–1190, y≈470–780 at 1x)

One tap is the whole message. The push lands exactly on the "You're in" chip.

## Frame 3 — Your stats are your card

- scene: Dashboard player card fills the frame; slow drift across the Jett art; rank crest pulses; ACS 286 / KDA 1.42 count up as floating chips beside it
- duration: 3.2s
- transition_in: match cut on the card frame
- blueprint: dataviz-countup
- onscreen: "YOUR STATS BECOME YOUR SCOUTING CARD."
- asset_candidates: dashboard.png (player card, x≈360–1380, y≈260–1120)

The card is what captains see. Numbers counting up sells "real stats, not vibes".

## Frame 4 — Captains scout you

- scene: Scout Hub grid tilts in 3D and scrolls; every other card dims while one (KAIRO) lights up with a volt bracket
- duration: 3s
- transition_in: crossfade 0.25s
- blueprint: zoom-out-workspace-reveal
- onscreen: "CAPTAINS SCOUT EVERY PLAYER."
- asset_candidates: player-pool.png (grid, KAIRO card x≈1135–1510, y≈720–915)

Social pressure, in a good way: you're being looked at.

## Frame 5 — They bid on you

- scene: Auction block screen; the price counter races $2,100 → $2,900 as bid rows stack in the "Bidding war" list; team purses flicker; at the drop a red-and-green "SOLD" stamp slams with a white flash and a small shake
- duration: 3.6s
- transition_in: cut on the downbeat
- blueprint: ticker-takeover
- onscreen: "THEN THEY BID ON YOU." → "SOLD."
- asset_candidates: auction-block.png (current bid x≈940–1320, y≈745–830; SOLD button x≈880–1265, y≈858–930; bidding-war list y≈985+)

The peak of the reel. Music drop lands on SOLD.

## Frame 6 — Signed

- scene: Rosters screen; the new player's name drops into a team card with a team-colour glow; "WELCOME TO THE TEAM." types in
- duration: 2.6s
- transition_in: flash-cut
- blueprint: kinetic-type-beats
- onscreen: "WELCOME TO THE TEAM."
- asset_candidates: rosters.png (team cards)

Resolution: from solo to signed.

## Frame 7 — CTA

- scene: VOLT crest assembles from its notched shield, league lockup, "GET DRAFTED THIS WEEKEND." with a volt button "SIGN UP — LINK IN BIO"
- duration: 2.4s
- transition_in: crossfade 0.3s
- blueprint: cta-morph-press
- onscreen: "GET DRAFTED THIS WEEKEND." / "LINK IN BIO"
- asset_candidates: VOLT crest (built in HTML from the app's LeagueMark)
