#!/usr/bin/env python3
"""Live end-to-end check of the deployed measure-only whistle path (ADAAAA-7682).

Feeds the deployed perceive /audio endpoint the same synthetic stimulus the unit
tests use: ~3 s of crowd ambient (no whistle expected), then a 2.8 kHz tonal
burst over that ambient (one whistle expected). Prints the whistle evidence and
asserts it is measure-only.
"""
import base64
import json
import sys
import urllib.error
import urllib.request

import numpy as np

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SID = "qa-ad7682-whistle"
SR = 16000
N = int(SR * 0.1)


def crowd(seed=7, amp=0.03):
    rng = np.random.default_rng(seed)
    t = np.arange(N) / SR
    a = rng.standard_normal(N) * amp
    a += 0.02 * np.sin(2 * np.pi * 180 * t) + 0.01 * np.sin(2 * np.pi * 700 * t)
    return a


def tone(hz=2800.0, amp=0.05):
    t = np.arange(N) / SR
    return amp * np.sin(2 * np.pi * hz * t)


def post(ts, x, path):
    s = base64.b64encode((np.clip(x, -1, 1) * 32767).astype(np.int16).tobytes()).decode()
    body = json.dumps({"timestamp": ts, "samples": s, "seq": -1}).encode()
    req = urllib.request.Request(
        path, data=body,
        headers={"Content-Type": "application/json", "X-Session-Id": SID},
    )
    return json.loads(urllib.request.urlopen(req, timeout=10).read())


def find_path():
    for path in (f"{BASE}/audio", f"{BASE}/app/audio"):
        try:
            post(0.0, crowd(), path)
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                continue
            raise
    raise SystemExit("no /audio route found")


path = find_path()
print("route:", path)

# Fresh session for the real run so the warm-up frames are the only history.
SID = "qa-ad7682-whistle-run"
ts = 0.0
whistle = None
stage_a = 0
for _ in range(30):
    body = post(ts, crowd(), path)
    ts += 0.1
    assert body.get("whistle") is None, "crowd ambient must not fire the whistle path"
for _ in range(8):
    body = post(ts, crowd() + tone(), path)
    ts += 0.1
    if body.get("candidate"):
        stage_a += 1
    if body.get("whistle"):
        whistle = body["whistle"]

print("stageA candidates during tone:", stage_a)
print("whistle evidence:", json.dumps(whistle, indent=1))
assert whistle is not None, "deployed path did not report a whistle fire"
assert whistle["measureOnly"] is True and whistle["emitted"] is False
assert whistle["thresholdId"] == "stageB/whistle/2.4-3.4k/5x/0.3s", whistle["thresholdId"]
assert 0.0 <= whistle["onsetLatencyS"] <= 5.0
print("VERDICT: PASS — deployed whistle path fires, measure-only (no candidate emitted)")
