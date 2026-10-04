#!/usr/bin/env bash
# Snapshot each reel at evenly spaced points: bash snap.sh [filter] [count]
cd "$(dirname "$0")"
n=${2:-7}
for dir in videos/volt-*${1}*/; do
  id=$(basename "$dir")
  at=$(python -c "import json;D=json.load(open('$dir/cues.json'))['duration'];print(','.join(str(round((D-0.6)*(k+0.5)/$n+0.3,1)) for k in range($n)))")
  rm -rf "$dir/snapshots"
  (cd "$dir" && npx hyperframes snapshot --at "$at" --no-end --describe false > /dev/null 2>&1) && echo "$id $at" || echo "$id FAILED"
done
