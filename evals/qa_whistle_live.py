#!/usr/bin/env python3
"""Live end-to-end check of the deployed EMITTING whistle path (ADAAAA-7707).

Feeds the deployed perceive /audio endpoint the same synthetic stimulus the unit
tests use: ~3 s of crowd ambient (no whistle, zero candidates expected), then a
2.8 kHz tonal burst over that ambient (one whistle, one emitted stageB
candidate expected). Prints the whistle evidence and asserts the shipped
emitting contract (ADAAAA-7705 Option 3).
"""
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

# Perceive keeps one SessionState per X-Session-Id for the life of the process,
# and the audio gates keep their fired-at timestamp (``_last_fired_ts``) on it to
# enforce the cooldown. A fixed session id therefore makes a rerun inherit the
# previous run's cooldown: ``ts`` restarts at 0.0 while ``_last_fired_ts`` is
# still ~3.2, so the tone phase never clears the 2.0 s cooldown and the probe
# fails without any regression in the deployed path. Use a fresh id per
# invocation (and per warm-up session) so reruns against one long-lived process
# are independent.
RUN_TAG = "%d-%d" % (int(time.time() * 1000), os.getpid())

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
SID = "qa-ad7682-whistle-" + RUN_TAG
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
SID = "qa-ad7707-whistle-run-" + RUN_TAG
ts = 0.0
whistle = None
stage_a = 0
whistle_candidates = []
for _ in range(30):
    body = post(ts, crowd(), path)
    ts += 0.1
    assert body.get("whistle") is None, "crowd ambient must not fire the whistle path"
    assert body.get("candidate") is None, "crowd ambient must emit zero candidates"
for _ in range(8):
    body = post(ts, crowd() + tone(), path)
    ts += 0.1
    cand = body.get("candidate")
    if cand:
        if cand["audio"].get("thresholdId", "").startswith("stageB/"):
            whistle_candidates.append(cand)
        else:
            stage_a += 1
    if body.get("whistle"):
        whistle = body["whistle"]

print("stageA candidates during tone:", stage_a)
print("whistle candidates during tone:", len(whistle_candidates))
print("whistle evidence:", json.dumps(whistle, indent=1))
assert whistle is not None, (
    "deployed path did not report a whistle fire (session %s)" % SID
)
# ADAAAA-7707: the path ships EMITTING (PO Option 3 on ADAAAA-7705).
assert whistle["emitted"] is True and whistle["measureOnly"] is False
assert whistle["thresholdId"] == "stageB/whistle/2.4-3.4k/5x/0.3s", whistle["thresholdId"]
assert 0.0 <= whistle["onsetLatencyS"] <= 5.0
assert len(whistle_candidates) == 1, (
    "the emitted whistle fire must reach candidate scheduling exactly once "
    "(got %d)" % len(whistle_candidates)
)
wc = whistle_candidates[0]
assert wc["type"] == "candidate" and wc["eventType"] == "AUDIO", wc
assert wc["audio"]["thresholdId"] == "stageB/whistle/2.4-3.4k/5x/0.3s", wc["audio"]
assert wc["timestamp"] == whistle["ts"], (wc["timestamp"], whistle["ts"])
print("VERDICT: PASS — deployed whistle path fires and EMITS one stageB candidate")
