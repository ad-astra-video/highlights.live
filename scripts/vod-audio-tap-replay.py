#!/usr/bin/env python3
"""Replay the VOD audio tap + highlight localization offline (ADAAAA-7845).

Mirrors the production tap path byte-for-byte:

  * services/server/src/vod-audio.ts decodes `0:a:0` to mono pcm_s16le 16 kHz and
    chunks it into 100 ms (1600 sample) blocks; timestamps are chunk ENDS
    (`chunkPcmBytes`: baseTs + (index + 1) * 0.1).
  * analyzer.ts `rmsNormalized()` = min(1, sqrt(mean(s^2)) / 32768).

So `--source <video>` reproduces the exact `(ts, rms)` series the localizer sees,
without a server, a re-run, or any inference. `--json` prints the per-trigger
windows (the regression fixture used by services/server/test/clip-window.test.ts);
the default prints the peak/burst metrics the anchor rule reads.

Usage (on the box, where the source VOD still lives):
  python3 vod-audio-tap-replay.py \
      --source /home/brad/highlights.live/docker/data/uploads/<job>/<file>.mp4 \
      --trigger 117 --trigger 153
"""
import argparse
import array
import json
import statistics
import subprocess

SR = 16000
CHUNK_S = 0.1
CHUNK_BYTES = int(SR * CHUNK_S) * 2


def taps(source: str, sr: int = SR, chunk_s: float = CHUNK_S):
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", source,
         "-map", "0:a:0?", "-ac", "1", "-ar", str(sr), "-c:a", "pcm_s16le",
         "-f", "s16le", "-"],
        capture_output=True, check=True)
    raw = proc.stdout
    out = []
    for i in range(len(raw) // CHUNK_BYTES):
        a = array.array("h")
        a.frombytes(raw[i * CHUNK_BYTES:(i + 1) * CHUNK_BYTES])
        s = sum(v * v for v in a) / max(1, len(a))
        out.append((round((i + 1) * chunk_s, 2), round(min(1.0, (s ** 0.5) / 32768.0), 5)))
    return out


def metrics(window):
    if not window:
        return None
    peak_ts, peak = max(window, key=lambda x: x[1])
    vals = [v for _, v in window]
    baseline = statistics.median(vals)
    return {
        "peakTs": peak_ts,
        "peakRms": round(peak, 4),
        "baselineRms": round(baseline, 4),
        "peakToBaseline": round(peak / max(baseline, 0.005), 2),
        # mirrors assessAudioBurst(): share of taps at >= half the peak energy
        "sustainedFraction": round(sum(1 for v in vals if v >= 0.5 * peak) / len(vals), 3),
        "isBurst": (peak / max(baseline, 0.005)) >= 2.0
        and (sum(1 for v in vals if v >= 0.5 * peak) / len(vals)) <= 0.35,
        "n": len(vals),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True)
    ap.add_argument("--trigger", type=float, action="append", default=[])
    ap.add_argument("--lookahead", type=float, default=8)
    ap.add_argument("--json", action="store_true", help="emit per-trigger tap windows as JSON")
    args = ap.parse_args()

    t = taps(args.source)
    if args.json:
        out = {"source": args.source.split("/")[-1], "tapCadenceS": CHUNK_S,
               "sampleRate": SR, "windows": {}}
        for trig in args.trigger:
            out["windows"][str(int(trig)) if trig.is_integer() else str(trig)] = [
                {"ts": ts, "rms": v} for ts, v in t if trig - 1 <= ts <= trig + args.lookahead
            ]
        print(json.dumps(out, separators=(",", ":")))
        return
    print(f"taps {len(t)} first={t[0]} last={t[-1]}")
    for trig in args.trigger:
        window = [(ts, v) for ts, v in t if ts > trig and ts <= trig + args.lookahead]
        print(f"trigger={trig} {metrics(window)}")


if __name__ == "__main__":
    main()
