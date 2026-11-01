#!/usr/bin/env python3
"""Re-survey the whistle negatives at a permissive operating point.

AC0 requires the negative windows to contain no whistle. The default gate found
one verified whistle (09dccf1b 6.2 s) inside a window the original survey
called clean, so every window is re-checked with the ratio lowered to 3x and
the guard relaxed; anything that fires is verified independently afterwards.
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
import measure_audio_recall as m  # noqa: E402

ROOT = "/home/brad/highlights.live/docker/data"
manifest = json.load(open(os.path.join(here, "audio-labels.json")))
cls = [c for c in manifest["classes"] if c["id"] == "whistle"][0]
mod = m.load_gate()

for w in cls["negatives"]:
    path = os.path.join(ROOT, w["clip"])
    if not os.path.exists(path):
        print(w["clip"], w["start"], "MISSING")
        continue
    gate = m.build_gate(mod, "whistle", 0.1, 16000, whistle_ratio=3.0,
                        min_tonality=4.0, max_flatness=0.35, guard_max_ratio=4.0)
    fires, lats, kinds = m.run_gate_stream(path, 16000, 0.1, gate,
                                           start_s=w["start"], dur_s=w["end"] - w["start"])
    if fires:
        print(w["clip"], w["start"], w["end"], "->",
              [round(f + w["start"], 2) for f in fires])
    else:
        print(w["clip"], w["start"], w["end"], "-> clean")
