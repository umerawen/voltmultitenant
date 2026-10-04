"""Tighten a voiceover's long pauses and print where each phrase lands.

    python vo/tighten.py in.wav out.wav [max_gap]

Pauses longer than max_gap (s) are shortened to max_gap with short
cross-fades; the phrase start times after tightening are printed as JSON.
"""
import json
import sys

import numpy as np
import soundfile as sf

x, sr = sf.read(sys.argv[1])
if x.ndim > 1:
    x = x.mean(1)
max_gap = float(sys.argv[3]) if len(sys.argv) > 3 else 0.55
hop = int(0.01 * sr)
rms = np.sqrt(np.convolve(x ** 2, np.ones(hop * 3) / (hop * 3), mode="same"))[::hop]
thr = 10 ** (-38 / 20)
voiced = rms > thr
# phrases = voiced runs, merging gaps shorter than 0.18 s
runs, start, quiet = [], None, 0
for i, v in enumerate(voiced):
    if v:
        if start is None:
            start = i
        quiet = 0
    elif start is not None:
        quiet += 1
        if quiet * 0.01 >= 0.18:
            runs.append((start, i - quiet + 1))
            start, quiet = None, 0
if start is not None:
    runs.append((start, len(voiced)))
runs = [(a * hop, b * hop) for a, b in runs]

pad = int(0.06 * sr)
out, starts, t = [], [], 0
prev_end = 0
for k, (a, b) in enumerate(runs):
    gap = a - prev_end
    keep = gap if k == 0 or gap <= max_gap * sr else int(max_gap * sr)
    if k == 0:
        seg_start = 0
    else:
        seg_start = a - min(keep, gap)
    seg = x[seg_start:b + pad].copy()
    f = min(int(0.02 * sr), len(seg) // 2)
    seg[:f] *= np.linspace(0, 1, f)
    seg[-f:] *= np.linspace(1, 0, f)
    starts.append(round((t + (a - seg_start)) / sr, 3))
    out.append(seg)
    t += len(seg)
    prev_end = b + pad
y = np.concatenate(out + [np.zeros(int(0.2 * sr))])
sf.write(sys.argv[2], y.astype(np.float32), sr, subtype="PCM_24" if sys.argv[2].endswith(".flac") else "FLOAT")
print(json.dumps({"duration": round(len(y) / sr, 3), "phrases": starts}))
