---
format: 1080x1920
duration: 18s
message: "Draft night is a live auction: every captain, $10,000, one player on the block."
arc: Hook → The draw → The war → The stakes → SOLD → Aftermath → CTA
audience: Valorant communities and their players
mode: collaborative
music: tense rising pulse, heartbeat kick that speeds up, hard drop on SOLD
---

## Frame 1 — Hook: the number

- scene: Black. A huge mono "$2,100" counts up to "$2,900" in fast jumps, each jump with a tick; label above: "// WHO WANTS ZEPHYR?"
- duration: 2.4s
- transition_in: cut
- blueprint: dataviz-countup
- onscreen: "WHO WANTS ZEPHYR?" + counter
- asset_candidates: none (type + counter)

Tension before context. The counter is the hook.

## Frame 2 — The draw

- scene: Player Pool cards rush past in a horizontal reel (slot-machine blur), slow down, and lock on ZEPHYR between two red markers; card flares
- duration: 2.8s
- transition_in: whip left
- blueprint: spatial-pan-stations
- onscreen: "THE DRAW PICKS WHO'S UP."
- asset_candidates: player-pool.png (card tiles cut from the grid: ZEPHYR x≈1525–1900, y≈930–1120)

Mirrors the app's real draw reel.

## Frame 3 — The war

- scene: Auction block in browser frame, camera tight on "CURRENT BID"; the bidding-war rows slide in one per beat (ECHO $2,100 → CIPHER $2,300 → ACE $2,500 → ECHO $2,700 → CIPHER $2,900); counter and "HELD BY" swap team each time; screen nudges on every bid
- duration: 4s
- transition_in: cut on the downbeat
- blueprint: ticker-takeover
- onscreen: "CAPTAINS BID LIVE."
- asset_candidates: auction-block.png (current bid x≈940–1320, y≈745–830; bidding-war list x≈610–1115, y≈985+)

The escalation. Five bids, five beats, the heartbeat speeds up.

## Frame 4 — The stakes

- scene: Pull back to the team purses on both sides; each purse bar drains a little; "$10,000 EACH. SPEND IT WISELY." in mono
- duration: 2.4s
- transition_in: zoom out
- blueprint: constellation-hub
- onscreen: "$10,000 EACH. SPEND IT WISELY."
- asset_candidates: auction-block.png (team cards left x≈280–545 and right x≈1715–1975)

Strategy, not just clicking. Budgets make every bid a decision.

## Frame 5 — SOLD

- scene: Camera slams onto the green SOLD button; it presses; giant "SOLD" stamp in voltage red with a white one-frame flash, sparks, slight shake; "ZEPHYR → NOVA STRIKE · $2,900"
- duration: 2.4s
- transition_in: cut on the drop
- blueprint: cta-morph-press
- onscreen: "SOLD." / "ZEPHYR → NOVA STRIKE · $2,900"
- asset_candidates: auction-block.png (SOLD button x≈880–1265, y≈858–930)

The peak. Everything resolves on the drop.

## Frame 6 — Aftermath

- scene: Auction feed card "RECORD SALE · VANTA · $4,100" slides up; latest-sales list ticks; a quick roster card fills
- duration: 2s
- transition_in: crossfade 0.2s
- blueprint: kinetic-type-beats
- onscreen: "24 PLAYERS. ONE NIGHT."
- asset_candidates: auction-block.png (auction feed x≈1160–1630, y≈1005+); dashboard.png (latest sales)

Shows it's a whole night of this.

## Frame 7 — CTA

- scene: VOLT crest + "RUN YOUR DRAFT NIGHT ON VOLT." + "LINK IN BIO"
- duration: 2s
- transition_in: crossfade 0.3s
- blueprint: cta-morph-press
- onscreen: "RUN YOUR DRAFT NIGHT ON VOLT." / "LINK IN BIO"
- asset_candidates: VOLT crest (HTML)
