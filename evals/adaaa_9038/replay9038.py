"""ADAAAA-9038 $0 replay: paired-plate corroboration on the six stored live jobs.

Evidence source (read-only, pulled from the box Postgres): each job's stored
`matchContextEvidence.channelOutcomes.scorebug_ocr` in jobs.json, and — for the one
job whose decide audits survive — the per-frame OCR the decide windows carried
(ocr_corpus.raw). Nothing here re-reads a stream, calls a model, or spends.

Passes:
  1. TODAY'S SUPPLY (1 frame per job): the stored OCR frame text through the
     patched resolver, compared against the served published context.
  2. FRAME-COUNT SENSITIVITY: the same stored text on 2 frames. A sensitivity of
     the RULE, not a measurement of the rail's supply (stated as such).
  3. REAL MULTI-FRAME SUPPLY (771f42de only): every per-frame OCR read the job's
     decide windows carried (11,849 reads, prompt-rendered and so truncated at
     ~40 chars). Checks the lift cannot fire on ad-board noise.
"""
import collections
import json
import sys

from app.match_context import PAIRED_PLATE_CONFIDENCE, USABLE_CONFIDENCE, resolve_match_context

CORPUS = "/tmp/paperclip-run-adaaaa-9038-d18401f8-e89-z2BIEB/ocr_corpus.raw"
OUT = "/tmp/paperclip-run-adaaaa-9038-d18401f8-e89-z2BIEB/replay9038.json"
JOBS = json.load(open("/tmp/hl9035/jobs.json"))
WINDOWS = json.load(open("/tmp/hl9035/windows.json"))


def stored(job):
    rec = job.get("record") or job
    ev = rec.get("matchContextEvidence") or {}
    so = (ev.get("channelOutcomes") or {}).get("scorebug_ocr") or {}
    mc = rec.get("matchContext") or {}
    return rec.get("id"), so.get("rawLines") or [], so, mc


def run(frames, sport="soccer"):
    out = resolve_match_context(sport_hint=sport, game_hint=sport, ocr_frames=frames)
    mc = out["matchContext"]
    so = (out["evidenceStatus"].get("channelOutcomes") or {}).get("scorebug_ocr") or {}
    teams = {t["side"]: (t["name"], t["confidence"]) for t in mc["teams"]}
    return teams, bool(mc["ambiguous"]), so.get("frames"), so.get("pairedPlates") or [], mc


def fmt(teams):
    return " ".join(f"{s}={n}@{c}" for s, (n, c) in sorted(teams.items())) or "none"


report = {"ticket": "ADAAAA-9038", "spend_usd": 0, "jobs": {}, "supply": {}}
print("== pass 1: today's supply (the stored OCR frame text, 1 frame) ==")
for job in JOBS:
    jid, raw, so, mc = stored(job)
    stored_teams = {t["side"]: (t["name"], t["confidence"]) for t in mc.get("teams") or []}
    one = run([{"lines": raw}] if raw else [])
    two = run([{"lines": raw}, {"lines": raw}]) if raw else ([], False, 0, [], {})
    print(
        f"{jid[:8]} stored_frames={so.get('frames')} replay_frames={one[2]}\n"
        f"   served  : {fmt(stored_teams)}\n"
        f"   patched1: {fmt(one[0])} paired={len(one[3])}"
        f" {'MATCH' if one[0] == stored_teams else 'DIFF'}\n"
        f"   patched2: {fmt(two[0])} paired={[(p['home'], p['away'], p['frames']) for p in two[3]]}"
    )
    report["jobs"][jid] = {
        "stored_frames": so.get("frames"),
        "served": {s: {"name": n, "confidence": c} for s, (n, c) in stored_teams.items()},
        "patched_1frame": {s: {"name": n, "confidence": c} for s, (n, c) in one[0].items()},
        "patched_2frames": {s: {"name": n, "confidence": c} for s, (n, c) in two[0].items()},
        "paired_2frames": two[3],
        "served_ambiguous": mc.get("ambiguous"),
        "ambiguity_note": "replay carries no kit samples/swatches, so `ambiguous` is not comparable",
    }

print("\n== pass 2: frame-count sensitivity of the rule (same stored text x2) ==")
usable_jobs = []
for job in JOBS:
    jid, raw, so, mc = stored(job)
    if not raw:
        continue
    teams, amb, frames, paired, _ = run([{"lines": raw}, {"lines": raw}])
    us = [f"{s}={n}@{c}" for s, (n, c) in sorted(teams.items()) if c >= USABLE_CONFIDENCE]
    if us:
        usable_jobs.append(jid[:8])
    print(f"{jid[:8]} frames={frames} usable={us or 'none'} paired={[(p['home'], p['away'], p['frames']) for p in paired]}")
report["usable_after_two_frames"] = usable_jobs

print("\n== pass 3: real multi-frame supply (771f42de decide windows) ==")
per = collections.defaultdict(list)
for line in open(CORPUS):
    line = line.rstrip("\n")
    if "\x1f" in line:
        jid, ocr = line.split("\x1f", 1)
        per[jid[:8]].append(ocr)
obs = [len(w.get("observations") or []) for w in WINDOWS]
strings = collections.Counter(
    line for w in WINDOWS for o in (w.get("observations") or []) for line in (o.get("ocr") or [])
)
report["supply"] = {
    "windows": len(WINDOWS),
    "observations_per_window": {"min": min(obs), "median": sorted(obs)[len(obs) // 2], "max": max(obs)},
    "distinct_ocr_strings": len(strings),
    "strings_repeated_ge_2": sum(1 for v in strings.values() if v >= 2),
}
print(
    f"771f42de decide windows={len(WINDOWS)} observations/window "
    f"min={min(obs)} median={sorted(obs)[len(obs)//2]} max={max(obs)}; "
    f"{sum(1 for v in strings.values() if v >= 2)}/{len(strings)} distinct OCR strings repeat"
)
for jid, reads in per.items():
    frames = [{"lines": [ocr]} for ocr in reads]
    teams, amb, nframes, paired, _ = run(frames)
    name_lines = [o for o in reads if any(k in o for k in ("Liverpool", "Chelsea"))]
    print(
        f"{jid} real_frames={nframes} of {len(reads)} reads; "
        f"{len(name_lines)} carry a club; patched: {fmt(teams)} paired={len(paired)}"
    )
    report["jobs_3"] = {}
    report.setdefault("real_corpus", {})[jid] = {
        "frames": nframes,
        "reads": len(reads),
        "club_reading_frames": len(name_lines),
        "teams": {s: {"name": n, "confidence": c} for s, (n, c) in teams.items()},
        "paired": len(paired),
        "note": "prompt-rendered OCR is truncated at ~40 chars, so this corpus is lossy vs the session's own reads",
    }

report["policy"] = {"USABLE_CONFIDENCE": USABLE_CONFIDENCE, "PAIRED_PLATE_CONFIDENCE": PAIRED_PLATE_CONFIDENCE}
json.dump(report, open(OUT, "w"), indent=2)
print(f"\nwrote {OUT}")
