"""ADAAAA-9038 $0 replay, SERVED resolver (328bb3b) on the same stored inputs.

Run with PYTHONPATH=/tmp/base9038 so `app.match_context` resolves to the served
bytes. Prints the same table shape as replay9038.py, so the two can be diffed.
"""
import json

from app.match_context import resolve_match_context

JOBS = json.load(open("/tmp/hl9035/jobs.json"))


def run(frames):
    out = resolve_match_context(sport_hint="soccer", game_hint="soccer", ocr_frames=frames)
    return {t["side"]: {"name": t["name"], "confidence": t["confidence"]}
            for t in out["matchContext"]["teams"]}


result = {}
for job in JOBS:
    rec = job.get("record") or job
    so = ((rec.get("matchContextEvidence") or {}).get("channelOutcomes") or {}).get("scorebug_ocr") or {}
    raw = so.get("rawLines") or []
    result[rec["id"]] = {
        "served_1frame": run([{"lines": raw}]),
        "served_2frames": run([{"lines": raw}] * 2),
    }
json.dump(result, open("/tmp/paperclip-run-adaaaa-9038-d18401f8-e89-z2BIEB/served9038.json", "w"), indent=2)
print(json.dumps(result, indent=2, sort_keys=True))
