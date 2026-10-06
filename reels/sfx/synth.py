"""Soft SFX + ambient bed for the VOLT reels, synthesised from scratch (numpy only).

    python sfx/synth.py videos/<id>/cues.json out.wav

Every sound is built to be soft: no attack faster than ~4 ms, everything
low-passed, a shared room reverb, nothing above ~7 kHz with a fast edge.
The bed is a warm pad + sub + round kick + quiet off-beat shaker at 120 BPM so
the reel's cuts (on the 0.5 s grid) land on the beat.
"""
import json
import sys

import numpy as np
import soundfile as sf

SR = 48000
BPM = 120
BEAT = 60 / BPM
rng = np.random.default_rng(7)


# ── primitives ───────────────────────────────────────────────────────────
def t_axis(d):
    return np.arange(int(d * SR)) / SR


def env_ar(n, attack, decay_tau, sustain=0.0):
    """Raised-cosine attack, exponential decay."""
    t = np.arange(n) / SR
    a = np.clip(t / max(attack, 1e-4), 0, 1)
    a = 0.5 - 0.5 * np.cos(np.pi * a)
    d = np.exp(-np.maximum(t - attack, 0) / decay_tau)
    return a * (sustain + (1 - sustain) * d)


def fade_out(x, d):
    n = min(len(x), int(d * SR))
    if n > 0:
        x[-n:] *= 0.5 + 0.5 * np.cos(np.linspace(0, np.pi, n))
    return x


def spectral(x, fn):
    """Static filter in the frequency domain: fn(freqs) -> gain."""
    n = len(x)
    m = 2 * n  # zero-pad: no circular wrap of tails into the attack
    X = np.fft.rfft(x, n=m)
    f = np.fft.rfftfreq(m, 1 / SR)
    return np.fft.irfft(X * fn(f), n=m)[:n]


def lowpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (f / fc) ** (2 * order)))


def highpass(x, fc, order=2):
    return spectral(x, lambda f: 1 / np.sqrt(1 + (fc / np.maximum(f, 1e-3)) ** (2 * order)))


def bandpass(x, lo, hi, order=2):
    return highpass(lowpass(x, hi, order), lo, order)


def pink(n):
    w = rng.standard_normal(n)
    return spectral(w, lambda f: 1 / np.sqrt(np.maximum(f, 20)))


def moving_band(noise, centers, width_oct, gains, nfft=2048, hop=512):
    """Noise through a band-pass whose centre moves (per STFT frame)."""
    win = np.hanning(nfft)
    n = len(noise)
    frames = 1 + (n - nfft) // hop if n > nfft else 1
    out = np.zeros(n + nfft)
    norm = np.zeros(n + nfft)
    f = np.fft.rfftfreq(nfft, 1 / SR)
    lf = np.log2(np.maximum(f, 1))
    for i in range(frames):
        s = i * hop
        seg = noise[s:s + nfft]
        if len(seg) < nfft:
            seg = np.pad(seg, (0, nfft - len(seg)))
        k = min(int(s / max(n - 1, 1) * (len(centers) - 1)), len(centers) - 1)
        c, g = centers[k], gains[k]
        shape = np.exp(-0.5 * ((lf - np.log2(c)) / width_oct) ** 2) * g
        shape *= 1 / np.sqrt(1 + (f / 7000) ** 4)
        y = np.fft.irfft(np.fft.rfft(seg * win) * shape, n=nfft) * win
        out[s:s + nfft] += y
        norm[s:s + nfft] += win ** 2
    return (out / np.maximum(norm, 1e-3))[:n]


def make_ir(d=2.2, tau=0.55):
    n = int(d * SR)
    t = np.arange(n) / SR
    ir = np.zeros((n, 2))
    for ch in range(2):
        w = rng.standard_normal(n) * np.exp(-t / tau)
        # darker as it decays: blend a bright and a dark copy
        dark = lowpass(w, 1800)
        bright = lowpass(w, 6500)
        mix = np.exp(-t / 0.25)
        ir[:, ch] = bright * mix + dark * (1 - mix)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))[:, None]
    return ir / np.sqrt(np.sum(ir ** 2, axis=0))


IR = make_ir()


def reverb(x_st, wet):
    """x_st: (n,2). FFT convolution with the shared room."""
    n = len(x_st) + len(IR)
    out = np.zeros((n, 2))
    for ch in range(2):
        out[:, ch] = np.fft.irfft(np.fft.rfft(x_st[:, ch], n) * np.fft.rfft(IR[:, ch], n), n)
    out[: len(x_st)] = out[: len(x_st)] * wet + x_st * (1 - wet * 0.35)
    out[len(x_st):] *= wet
    return out


def stereo(x, pan=0.0, width=0.0):
    """pan -1..1; width adds a few ms of Haas spread."""
    l = np.cos((pan + 1) * np.pi / 4)
    r = np.sin((pan + 1) * np.pi / 4)
    y = np.stack([x * l, x * r], axis=1) * np.sqrt(2)
    if width:
        d = int(width * SR)
        y[:, 1] = np.concatenate([np.zeros(d), y[:-d, 1]]) if d else y[:, 1]
    return y


def note(n):
    """MIDI note -> Hz."""
    return 440 * 2 ** ((n - 69) / 12)


# ── the sounds ───────────────────────────────────────────────────────────
def s_whoosh(d=0.7, g=1.0, **_):
    n = int(d * SR)
    c = np.concatenate([np.geomspace(260, 2400, int(n * 0.6)), np.geomspace(2400, 700, n - int(n * 0.6))])
    tt = np.linspace(0, 1, n)
    e = np.sin(np.pi * np.clip(tt / 0.62, 0, 1) / 2) ** 2 * np.exp(-np.maximum(tt - 0.62, 0) * 7)
    x = moving_band(pink(n), c, 0.55, e) * 2.2
    x = fade_out(x, 0.05)
    pan = np.linspace(-0.6, 0.6, n)
    y = np.stack([x * np.cos((pan + 1) * np.pi / 4), x * np.sin((pan + 1) * np.pi / 4)], axis=1) * np.sqrt(2)
    return y * g * 0.5, 0.25


def s_air(g=1.0, **_):
    """A gentler, shorter whoosh for camera moves."""
    y, _ = s_whoosh(d=0.55, g=g * 0.55)
    return lowpass_st(y, 2600), 0.2


def lowpass_st(y, fc):
    return np.stack([lowpass(y[:, 0], fc), lowpass(y[:, 1], fc)], axis=1)


def s_swell(d=1.2, g=1.0, **_):
    n = int(d * SR)
    tt = np.linspace(0, 1, n)
    e = tt ** 2.2
    x = moving_band(pink(n), np.geomspace(180, 3200, n), 0.7, e) * 2.0
    t = t_axis(d)
    pad = np.zeros(n)
    for m in (57, 64, 69, 72):
        f0 = note(m)
        ph = 2 * np.pi * np.cumsum(f0 * (1 + 0.06 * tt ** 2) / SR)
        pad += np.sin(ph) + 0.3 * np.sin(2 * ph)
    pad = lowpass(pad, 2400) * e * 0.12
    y = x + pad
    y = fade_out(y, 0.06)
    return stereo(y, 0, 0.012) * g * 0.45, 0.3


def s_thump(g=1.0, **_):
    """Soft low impact: a pitch-dropping sine with a dark body."""
    d = 1.1
    t = t_axis(d)
    f = 42 + 58 * np.exp(-t / 0.07)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * env_ar(len(t), 0.006, 0.32)
    dirt = lowpass(pink(len(t)), 380) * env_ar(len(t), 0.005, 0.09) * 1.6
    x = lowpass(body + dirt, 900)
    return stereo(x, 0, 0.0) * g * 0.9, 0.18


def s_boom(g=1.0, **_):
    """The CTA landing: deep thump + warm chord bloom."""
    th, _ = s_thump(g=1.0)
    d = 3.0
    t = t_axis(d)
    pad = np.zeros(len(t))
    for m, a in ((45, 0.5), (57, 0.6), (64, 0.45), (69, 0.4), (73, 0.25), (76, 0.2)):
        for det in (-0.004, 0.004):
            pad += a * np.sin(2 * np.pi * note(m) * (1 + det) * t)
    pad = lowpass(pad, 2200) * env_ar(len(t), 0.04, 1.1) * 0.16
    y = stereo(pad, 0, 0.015)
    y[: len(th)] += th
    return y * g, 0.3


def s_chime(p=0, g=1.0, chord=False, **_):
    """Glassy, rounded bell. p steps up an A-major pentatonic."""
    scale = [76, 78, 81, 83, 85, 88, 90, 93]
    base = scale[int(p) % len(scale)]
    notes = [base, base + 7, base + 12] if chord else [base, base + 12]
    d = 2.0
    t = t_axis(d)
    x = np.zeros(len(t))
    for i, m in enumerate(notes):
        f0 = note(m)
        a = 1.0 if i == 0 else 0.35
        for k, (mul, amp, tau) in enumerate(((1, 1, 0.9), (2.01, 0.25, 0.35), (3.0, 0.08, 0.2))):
            x += a * amp * np.sin(2 * np.pi * f0 * mul * t + k) * env_ar(len(t), 0.012, tau)
        x += a * 0.4 * np.sin(2 * np.pi * f0 * 1.003 * t) * env_ar(len(t), 0.02, 0.8)
    x = lowpass(x, 4200) * 0.22
    return stereo(x, 0.15 * ((p % 3) - 1), 0.01) * g, 0.42


def s_pop(p=0, g=1.0, **_):
    """Soft bubble blip, pitch rising; p steps up the scale."""
    scale = [64, 66, 69, 71, 73, 76, 78, 81]
    f0 = note(scale[int(p) % len(scale)])
    d = 0.35
    t = t_axis(d)
    f = f0 * (0.78 + 0.22 * (1 - np.exp(-t / 0.03)))
    ph = 2 * np.pi * np.cumsum(f) / SR
    x = (np.sin(ph) + 0.18 * np.sin(2 * ph)) * env_ar(len(t), 0.004, 0.075)
    x = lowpass(x, 3000) * 0.42
    return stereo(x, 0.25 * ((p % 3) - 1)) * g, 0.2


def s_click(g=1.0, **_):
    """Muted 'tock' for the cursor."""
    d = 0.2
    t = t_axis(d)
    f = 240 + 160 * np.exp(-t / 0.01)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ar(len(t), 0.003, 0.03)
    x += lowpass(rng.standard_normal(len(t)), 1400) * env_ar(len(t), 0.002, 0.012) * 0.25
    x = lowpass(x, 1800) * 0.5
    return stereo(x, 0.1) * g, 0.1


def s_rise(d=1.4, g=1.0, **_):
    """Counter tone: a soft upward glide that settles."""
    t = t_axis(d + 0.3)
    k = np.clip(t / d, 0, 1)
    f = note(57) * 2 ** (k * 1.0)
    ph = 2 * np.pi * np.cumsum(f) / SR
    e = np.minimum(t / 0.08, 1) * (0.4 + 0.6 * k) * np.exp(-np.maximum(t - d, 0) / 0.1)
    x = (np.sin(ph) + 0.25 * np.sin(2 * ph) + 0.1 * np.sin(3 * ph)) * e
    x = lowpass(x, 2200) * 0.12
    return stereo(x, 0, 0.008) * g, 0.25


def s_shimmer(g=1.0, **_):
    d = 2.6
    t = t_axis(d)
    x = np.zeros(len(t))
    pent = [81, 83, 85, 88, 90, 93, 95, 97]
    r = np.random.default_rng(11)
    for i in range(14):
        st = 0.08 * i + r.uniform(0, 0.04)
        m = pent[r.integers(len(pent))]
        s0 = int(st * SR)
        n = len(t) - s0
        tt = np.arange(n) / SR
        x[s0:] += np.sin(2 * np.pi * note(m) * tt) * env_ar(n, 0.02, 0.5) * r.uniform(0.4, 1)
    x = lowpass(x, 6000) * 0.06
    return stereo(x, 0, 0.018) * g, 0.55


def s_heart(g=1.0, **_):
    """A soft heartbeat: two muffled low pulses (lub-dub), no click on the attack."""
    d = 0.9
    t = t_axis(d)
    x = np.zeros(len(t))
    for off, amp in ((0.0, 1.0), (0.24, 0.7)):
        tt = np.clip(t - off, 0, None)
        f = 48 + 22 * np.exp(-tt / 0.05)
        e = np.where(t >= off, (1 - np.exp(-tt / 0.012)) * np.exp(-tt / 0.11), 0)
        x += amp * np.sin(2 * np.pi * np.cumsum(f) / SR) * e
    x = lowpass(x, 260) * 0.8
    return stereo(x, 0, 0.0) * g, 0.12


def s_scrape(d=0.45, g=1.0, **_):
    """A dry brush dragged across a wall: band-passed noise with bristle flutter."""
    n = int(d * SR)
    t = np.arange(n) / SR
    flutter = 0.55 + 0.45 * lowpass(rng.standard_normal(n), 38) / 0.08
    flutter = np.clip(flutter, 0.15, 1.4)
    e = np.sin(np.pi * np.clip(t / d, 0, 1)) ** 0.7
    c = np.geomspace(1400, 2600, n)
    x = moving_band(pink(n), c, 0.7, e * flutter) * 3.2
    x = lowpass(x, 5200)
    x = fade_out(x, 0.04)
    return stereo(x, 0.15, 0.008) * g * 0.5, 0.12


def s_slap(g=1.0, **_):
    """A print slapped on the wall: paper smack + a short low knock."""
    d = 0.4
    t = t_axis(d)
    smack = bandpass(rng.standard_normal(len(t)), 500, 3800) * env_ar(len(t), 0.002, 0.03) * 0.9
    f = 90 + 70 * np.exp(-t / 0.02)
    knock = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_ar(len(t), 0.003, 0.07) * 0.8
    x = lowpass(smack + knock, 4200)
    return stereo(x, 0, 0.004) * g * 0.75, 0.16


SOUNDS = {"heart": s_heart, "scrape": s_scrape, "slap": s_slap, "whoosh": s_whoosh, "air": s_air, "swell": s_swell, "thump": s_thump, "boom": s_boom,
          "chime": s_chime, "pop": s_pop, "click": s_click, "rise": s_rise, "shimmer": s_shimmer}


# ── the bed ──────────────────────────────────────────────────────────────
# A minor-ish loop, a chord per 2 bars (4 s): Am – F – C – G
CHORDS = [(57, [57, 60, 64, 69]), (53, [53, 57, 60, 65]), (48, [55, 60, 64, 67]), (55, [55, 59, 62, 67])]


def saw_additive(f0, t, fc=1400):
    """Band-limited, already low-passed saw (additive)."""
    y = np.zeros(len(t))
    nmax = int(min(5000, SR / 2) / f0)
    for k in range(1, nmax + 1):
        a = (1 / k) / np.sqrt(1 + (k * f0 / fc) ** 4)
        if a < 0.002:
            break
        y += a * np.sin(2 * np.pi * k * f0 * t + k * 0.7)
    return y


def bed(duration, outro):
    n = int(duration * SR)
    t = np.arange(n) / SR
    pad = np.zeros(n)
    sub = np.zeros(n)
    bar2 = 4 * BEAT * 2
    for ci in range(int(np.ceil(duration / bar2)) + 1):
        root, ch = CHORDS[ci % 4]
        s0, s1 = ci * bar2, (ci + 1) * bar2
        a, b = int(max(s0 - 0.25, 0) * SR), int(min(s1 + 0.25, duration) * SR)
        if a >= n:
            break
        tt = t[a:b]
        seg = np.zeros(len(tt))
        for m in ch:
            for det in (-0.0035, 0, 0.0035):
                seg += saw_additive(note(m) * (1 + det), tt, fc=1100 + 500 * np.sin(ci))
        w = np.ones(len(tt))
        xf = int(0.5 * SR)
        w[:xf] = np.linspace(0, 1, len(w[:xf])) if s0 > 0 else 1
        w[-xf:] = np.minimum(w[-xf:], np.linspace(1, 0, len(w[-xf:])))
        pad[a:b] += seg * w
        sub[a:b] += np.sin(2 * np.pi * note(root - 12) * tt) * w
    pad *= 0.045
    sub *= 0.07

    beat_ph = (t % BEAT) / BEAT
    xb = t % BEAT
    pump = 1 - 0.4 * np.clip(np.exp(-xb / 0.11) - np.exp(-BEAT / 0.11), 0, 1) * (1 - np.exp(-xb / 0.008))
    pad *= pump
    sub *= pump

    kick = np.zeros(n)
    shaker = np.zeros(n)
    arp = np.zeros(n)
    kd = int(0.48 * SR)
    kt = np.arange(kd) / SR
    kf = 46 + 70 * np.exp(-kt / 0.035)
    k1 = np.sin(2 * np.pi * np.cumsum(kf) / SR) * env_ar(kd, 0.004, 0.16)
    k1 = fade_out(lowpass(k1, 700), 0.12) * 0.34
    sd = int(0.12 * SR)
    sh = fade_out(bandpass(rng.standard_normal(sd), 2500, 6000) * env_ar(sd, 0.018, 0.03), 0.04) * 0.04
    ad = int(0.45 * SR)
    at_ = np.arange(ad) / SR
    groove_from = BEAT * 2           # pad alone for the first bar-half
    groove_to = outro if outro else duration
    i = 0
    while i * BEAT < duration:
        bt = i * BEAT
        s = int(bt * SR)
        if groove_from <= bt < groove_to - 0.01:
            e = min(n, s + kd)
            kick[s:e] += k1[: e - s]
            so = int((bt + BEAT / 2) * SR)
            if so < n:
                e2 = min(n, so + sd)
                shaker[so:e2] += sh[: e2 - so]
        # quiet arp on 8ths
        for half in (0, 1):
            at = bt + half * BEAT / 2
            if groove_from + BEAT * 2 <= at < groove_to - 0.01:
                ci = int(at // bar2) % 4
                ch = CHORDS[ci][1]
                m = ch[(i * 2 + half) % len(ch)] + 12
                s2 = int(at * SR)
                e3 = min(n, s2 + ad)
                tone = (np.sin(2 * np.pi * note(m) * at_) + 0.3 * np.sin(4 * np.pi * note(m) * at_)) * env_ar(ad, 0.008, 0.12)
                tone = fade_out(tone, 0.05)
                arp[s2:e3] += tone[: e3 - s2] * 0.028
        i += 1
    arp = lowpass(arp, 2600)

    y = stereo(pad, 0, 0.014) + stereo(sub) + stereo(kick) + stereo(shaker, 0.3) + stereo(arp, -0.2, 0.01)
    # intro: fade in over the first beat; outro: gentle tail
    fi = int(0.4 * SR)
    y[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(1.6 * SR)
    y[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
    wet = reverb(y, 0.18)[:n]
    return wet


def bed_grit(duration, outro):
    """The grunge cut's bed: half-time boom-bap at 120 BPM (kick on 1, snare on 3),
    a dark detuned minor pad through tape saturation, dusty hats and vinyl crackle."""
    n = int(duration * SR)
    t = np.arange(n) / SR
    bar = 4 * BEAT
    pad = np.zeros(n)
    prog = [(45, [45, 52, 57, 60]), (41, [41, 48, 53, 57]), (43, [43, 50, 55, 58]), (40, [40, 47, 52, 55])]
    for ci in range(int(np.ceil(duration / (bar * 2))) + 1):
        s0, s1 = ci * bar * 2, (ci + 1) * bar * 2
        a, b = int(max(s0 - 0.2, 0) * SR), int(min(s1 + 0.2, duration) * SR)
        if a >= n:
            break
        tt = t[a:b]
        seg = np.zeros(len(tt))
        for m in prog[ci % 4][1]:
            for det in (-0.006, 0.0, 0.006):
                seg += saw_additive(note(m) * (1 + det), tt, fc=650)
        w = np.ones(len(tt))
        xf = int(0.4 * SR)
        if s0 > 0:
            w[:xf] = np.linspace(0, 1, len(w[:xf]))
        w[-xf:] = np.minimum(w[-xf:], np.linspace(1, 0, len(w[-xf:])))
        pad[a:b] += seg * w
    pad = np.tanh(pad * 0.9) * 0.05 * (1 + 0.12 * np.sin(2 * np.pi * 0.25 * t))
    kd = int(0.6 * SR)
    kt = np.arange(kd) / SR
    kick = np.sin(2 * np.pi * np.cumsum(44 + 90 * np.exp(-kt / 0.03)) / SR) * env_ar(kd, 0.003, 0.2)
    kick = np.tanh(kick * 2.2) * 0.42
    sd = int(0.35 * SR)
    snare = (bandpass(rng.standard_normal(sd), 900, 5000) * env_ar(sd, 0.002, 0.07) * 0.8
             + np.sin(2 * np.pi * 185 * np.arange(sd) / SR) * env_ar(sd, 0.002, 0.04) * 0.5)
    snare = lowpass(snare, 5500) * 0.32
    hd = int(0.08 * SR)
    hat = bandpass(rng.standard_normal(hd), 4000, 7000) * env_ar(hd, 0.002, 0.018) * 0.05
    drums = np.zeros(n)
    start = BEAT * 2
    stop = outro if outro else duration
    i = 0
    while i * BEAT / 2 < duration:
        bt = i * BEAT / 2
        s_ = int(bt * SR)
        if start <= bt < stop - 0.01:
            pos = i % 8  # 8 eighths per bar
            if pos in (0, 5):
                e = min(n, s_ + kd); drums[s_:e] += kick[: e - s_]
            if pos == 4:
                e = min(n, s_ + sd); drums[s_:e] += snare[: e - s_]
            if pos % 2 == 1 or rng.random() < 0.3:
                e = min(n, s_ + hd); drums[s_:e] += hat[: e - s_] * (0.6 + 0.6 * rng.random())
        i += 1
    crackle = np.zeros(n)
    for _ in range(int(duration * 14)):
        k = int(rng.random() * (n - 200))
        crackle[k:k + 60] += rng.standard_normal(60) * np.exp(-np.arange(60) / 9) * (0.02 + 0.05 * rng.random())
    crackle = bandpass(crackle, 1200, 6000)
    y = stereo(pad, 0, 0.016) + stereo(drums) + stereo(crackle, 0.2, 0.01)
    fi = int(0.3 * SR)
    y[:fi] *= np.linspace(0, 1, fi)[:, None]
    fo = int(1.4 * SR)
    y[-fo:] *= np.linspace(1, 0, fo)[:, None] ** 1.5
    return reverb(y, 0.12)[:n]


# ── mix ──────────────────────────────────────────────────────────────────
def main(cue_path, out):
    spec = json.load(open(cue_path, encoding="utf8"))
    dur = float(spec["duration"])
    n = int(dur * SR)
    mix = np.zeros((n + SR * 4, 2))
    sfx = np.zeros_like(mix)
    for c in spec["cues"]:
        fn = SOUNDS.get(c["k"])
        if not fn:
            continue
        args = {k: v for k, v in c.items() if k not in ("t", "k")}
        y, wet = fn(**args)
        y = reverb(y, wet)
        s = int(max(c["t"], 0) * SR)
        e = min(len(sfx), s + len(y))
        sfx[s:e] += y[: e - s]
    b = (bed_grit if spec.get("bed") == "grit" else bed)(dur, spec.get("outro"))
    duck_bed = np.ones(len(mix))
    duck_sfx = np.ones(len(mix))
    vo_track = np.zeros_like(mix)
    vo = spec.get("vo")
    if vo:
        # Voiceover: dry, peak-normalised, and everything else ducks under it.
        v, vsr = sf.read(vo["file"])
        if v.ndim > 1:
            v = v.mean(1)
        assert vsr == SR, "voiceover must be 48 kHz"
        v = highpass(v, 70) / max(np.max(np.abs(v)), 1e-6) * vo.get("gain", 0.8)
        s0 = int(vo.get("t", 0) * SR)
        e0 = min(len(mix), s0 + len(v))
        vo_track[s0:e0] += np.stack([v[: e0 - s0]] * 2, axis=1)
        env = np.abs(vo_track[:, 0])
        k = int(0.04 * SR)
        env = np.convolve(env, np.ones(k) / k, mode="same")
        # hold + slow release so the bed doesn't pump between words
        rel = int(0.35 * SR)
        env_s = np.copy(env)
        a_r = np.exp(-1 / rel)
        for i in range(1, len(env_s)):
            if env_s[i] < env_s[i - 1] * a_r:
                env_s[i] = env_s[i - 1] * a_r
        lvl = np.clip(env_s / 0.05, 0, 1)
        duck_bed = 1 - 0.62 * lvl
        duck_sfx = 1 - 0.4 * lvl
    # hush: the bed fades right out for a beat of silence (e.g. before a SOLD)
    for h in spec.get("hush") or []:
        t0, t1 = float(h["t"]), float(h["t"]) + float(h["d"])
        ramp = float(h.get("ramp", 0.35))
        tt = np.arange(len(duck_bed)) / SR
        g = np.clip(np.maximum((t0 - tt) / ramp, (tt - t1) / 0.08), 0, 1)
        duck_bed = duck_bed * g
    mix[:n] += b * 0.42 * duck_bed[:n, None]
    mix += sfx * 0.9 * duck_sfx[:, None]
    mix += vo_track
    mix = mix[:n]
    mix = np.stack([highpass(mix[:, 0], 32), highpass(mix[:, 1], 32)], axis=1)
    # gentle glue: soft-knee saturation then normalise peak
    mix = np.tanh(mix * 1.1) / np.tanh(1.1)
    end = int(0.25 * SR)
    mix[-end:] *= np.linspace(1, 0, end)[:, None]
    peak = np.max(np.abs(mix))
    mix = mix / max(peak, 1e-6) * 0.89
    sf.write(out, mix.astype(np.float32), SR, subtype="FLOAT")
    print("wrote", out, f"{dur:.1f}s", len(spec["cues"]), "cues")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
