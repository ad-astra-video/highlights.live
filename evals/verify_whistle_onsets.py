#!/usr/bin/env python3
"""Independent whistle-onset verification for the ADAAAA-7682 label corpus.

For each candidate onset (`<clip>:<ts>`) this prints the measurement that the
`labelSource` in `evals/audio-labels.json` quotes — deliberately NOT the gate's
own trigger condition:

  - per-band energy rise of the onset window over a 10 s ambient window that
    ends 0.5 s before the onset (whistle 2.4-3.4 kHz, speech 0.3-2 kHz,
    low <0.3 kHz, high 4-7 kHz)
  - spectral flatness of the whistle band (tonal vs broadband)
  - the whistle-band peak frequency and how far it moves across the run

A referee whistle is verified when the whistle band rises far over ambient while
speech/low stay near ambient, the band is tonal (low flatness) and the peak
frequency is inside 2.4-3.4 kHz. A crowd roar raises every band; a click/pop
raises the high band by orders of magnitude.

``--compare-sr 8000`` additionally re-measures the 2.4-3.4 kHz rise on the same
onset decoded at the given rate, which is the ADAAAA-7682 AC1 sample-rate fidelity
check (manifest default 8 kHz vs production 16 kHz).

Usage:
  python3 evals/verify_whistle_onsets.py --clip-root <root> clip.mp4:1682.0 ...
"""
import argparse
import json
import os
import subprocess

import numpy as np

SR = 16000
FRAME_S = 0.1
AMBIENT_S = 10.0
GUARD_S = 0.5
BANDS = {
    "low": (60.0, 300.0),
    "speech": (300.0, 2000.0),
    "whistle": (2400.0, 3400.0),
    "high": (4000.0, 7000.0),
}
HANN = np.hanning(int(SR * FRAME_S))


def decode(path, sr=SR):
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-ac", "1", "-ar", str(sr),
         "-f", "s16le", "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<i2").astype(np.float64) / 32768.0


def frame_at(pcm, t, sr=SR):
    a = int(t * sr)
    n = int(sr * FRAME_S)
    return pcm[a:a + n]


def band_energies(x, sr=SR):
    window = np.hanning(x.size) if x.size else np.array([])
    spec = np.abs(np.fft.rfft(x * window)) ** 2
    freqs = np.fft.rfftfreq(x.size, 1.0 / sr)
    idx = {k: np.where((freqs >= lo) & (freqs <= hi))[0] for k, (lo, hi) in BANDS.items()}
    e = {k: float(spec[i].sum()) for k, i in idx.items()}
    w = spec[idx["whistle"]]
    mean = float(w.mean()) if w.size else 0.0
    e["tonality"] = float(w.max()) / mean if mean > 0 else 0.0
    e["flatness"] = float(np.exp(np.mean(np.log(np.maximum(w, 1e-12)))) / max(mean, 1e-12)) if w.size else 1.0
    e["peak_hz"] = float(freqs[idx["whistle"][int(np.argmax(w))]]) if w.size else 0.0
    return e


def verify(pcm, ts, sr=SR):
    amb_lo = max(0.0, ts - GUARD_S - AMBIENT_S)
    amb_hi = max(0.0, ts - GUARD_S)
    amb_frames = [band_energies(frame_at(pcm, t, sr), sr)
                  for t in np.arange(amb_lo, amb_hi, FRAME_S)]
    amb = {k: float(np.mean([f[k] for f in amb_frames])) for k in BANDS}

    peak = band_energies(frame_at(pcm, ts, sr), sr)
    run = [peak]
    t = ts + FRAME_S
    while t < ts + 1.5:
        f = band_energies(frame_at(pcm, t, sr), sr)
        run.append(f)
        if f["whistle"] > peak["whistle"]:
            peak = f
        t += FRAME_S
        if len(run) >= 3 and f["whistle"] < 2.0 * amb["whistle"]:
            break

    out = {
        "ts": round(ts, 2),
        "sr": sr,
        "run_s": round(len(run) * FRAME_S, 2),
        "peak_hz": round(peak["peak_hz"], 1),
        "flatness": round(peak["flatness"], 3),
        "tonality": round(peak["tonality"], 1),
    }
    for k in BANDS:
        a = max(amb[k], 1e-12)
        out[f"{k}_rise"] = round(peak[k] / a, 1)
        out[f"{k}_db"] = round(10.0 * np.log10(max(peak[k], 1e-12) / a), 1)
    freqs = [f["peak_hz"] for f in run if f["whistle"] > 2.0 * amb["whistle"]]
    out["peak_hz_spread"] = round(float(np.std(freqs)), 1) if len(freqs) > 1 else 0.0
    out["verdict"] = (
        "whistle" if (out["whistle_rise"] >= 6.0 and out["speech_rise"] <= 3.0
                      and out["low_rise"] <= 4.0 and out["flatness"] <= 0.25
                      and 2400.0 <= out["peak_hz"] <= 3400.0)
        else "reject"
    )
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="+", help="clip.mp4:ts")
    ap.add_argument("--clip-root", default="")
    ap.add_argument("--compare-sr", type=int, default=None,
                    help="also measure the whistle-band rise at this decode rate (AC1)")
    ap.add_argument("--json", help="write the result table here")
    a = ap.parse_args()

    rows = []
    cache = {}
    for target in a.targets:
        clip, _, ts = target.rpartition(":")
        path = os.path.join(a.clip_root, clip) if a.clip_root else clip
        if path not in cache:
            cache[path] = decode(path)
        r = verify(cache[path], float(ts))
        r["clip"] = clip
        if a.compare_sr:
            alt_path = f"{path}@{a.compare_sr}"
            if alt_path not in cache:
                cache[alt_path] = decode(path, a.compare_sr)
            alt = verify(cache[alt_path], float(ts), a.compare_sr)
            r["alt_sr"] = a.compare_sr
            r["alt_whistle_rise"] = alt["whistle_rise"]
            r["alt_verdict"] = alt["verdict"]
            r["rise_delta_pct"] = round(
                100.0 * (r["whistle_rise"] - alt["whistle_rise"]) / max(alt["whistle_rise"], 1e-9), 1)
        rows.append(r)

    print("| clip | ts | run | whistle rise | speech rise | low rise | high rise | peak Hz | flat | verdict |")
    print("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for r in rows:
        print(f"| {r['clip']} | {r['ts']:.1f} s | {r['run_s']:.1f} s | {r['whistle_rise']:.1f}x "
              f"({r['whistle_db']:+.1f} dB) | {r['speech_rise']:.1f}x | {r['low_rise']:.1f}x | "
              f"{r['high_rise']:.0f}x | {r['peak_hz']:.0f} | {r['flatness']:.3f} | {r['verdict']} |")
    if a.compare_sr:
        print(f"\nSample-rate fidelity (AC1): whistle-band rise at {SR} Hz vs {a.compare_sr} Hz decode")
        print("| clip | ts | 16 kHz rise | alt rise | delta % |")
        print("| --- | --- | --- | --- | --- |")
        for r in rows:
            print(f"| {r['clip']} | {r['ts']:.1f} s | {r['whistle_rise']:.1f}x | "
                  f"{r['alt_whistle_rise']:.1f}x | {r['rise_delta_pct']:+.1f}% |")
    if a.json:
        json.dump(rows, open(a.json, "w"), indent=2)


if __name__ == "__main__":
    main()
