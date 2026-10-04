#!/usr/bin/env bash
# Contact sheet from a finished MP4: bash sheet.sh renders/01-x.mp4 out.png
FF=${FFMPEG:-ffmpeg}
D=$("${FF%ffmpeg.exe}ffprobe.exe" -v error -show_entries format=duration -of csv=p=0 "$1" 2>/dev/null || echo 20)
"$FF" -nostdin -y -loglevel error -i "$1" -vf "fps=12/$D,scale=270:480,tile=6x2" -frames:v 1 "$2"
