#!/usr/bin/env bash
# Build, render, score and mux the VOLT reels.
#   bash render.sh            → every reel
#   bash render.sh bidding    → reels whose id contains "bidding"
# Finished files land in renders/NN-<id>.mp4 (1080x1920, H.264 + AAC, -14 LUFS).
set -euo pipefail
cd "$(dirname "$0")"
FFMPEG=${FFMPEG:-ffmpeg}
export FFMPEG
mkdir -p renders
while read -r num id <&3; do
  [[ -n "${1:-}" && "$id" != *"$1"* ]] && continue
  echo "── $num $id"
  node reels.mjs "$id" > /dev/null
  dir="videos/$id"
  mkdir -p "$dir/renders"
  (cd "$dir" && npx hyperframes render --quality high --fps 30 --output "renders/$id-silent.mp4" < /dev/null > "renders/render.log" 2>&1) || { echo "render failed: $dir/renders/render.log"; exit 1; }
  python sfx/synth.py "$dir/cues.json" "$dir/renders/$id.wav"
  "$FFMPEG" -nostdin -y -loglevel error -i "$dir/renders/$id-silent.mp4" -i "$dir/renders/$id.wav" \
    -map 0:v -map 1:a -c:v copy -af "loudnorm=I=-14:TP=-1.5:LRA=9" -ar 48000 -c:a aac -b:a 192k -shortest -movflags +faststart \
    "renders/$num-$id.mp4"
  echo "   ✓ renders/$num-$id.mp4"
done 3< <(node reels.mjs --list)
