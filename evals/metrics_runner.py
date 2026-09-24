#!/usr/bin/env python3
"""INC-5 / ADAAAA-4329 acceptance-metric runner (QA).

Reads a labeled eval clip manifest plus a trace of the staged detection
pipeline's OutboundEvents (packages/events contract) and computes the
acceptance metrics from research $6, printing PASS/FAIL against the bars.

Pure stdlib, no runtime deps: this is the reproducible accounting tool for the
acceptance-metric run. Real traces come from driving the deployed perceive+
decide pipeline over the labeled clips; a synthetic trace (evals/fixtures) shows
the accounting is correct against the component-tested behaviour.

Trace shape (subsume the OutboundEvent contract):
{
  "events": [
    {"type":"candidate","clipId":"soc-goal-01","eventType":"GOAL","timestamp":12.0},
    {"type":"decision","clipId":"soc-goal-01","timestamp":14.5,
     "decision":{"isHighlight":true,"eventType":"GOAL",
                 "reason":"crowd erupted; group pile in the goal mouth"}}
  ],
  "stageA": {"totalCandidates": N, "rejected": M},        # Stage-A FP-rate cost bound
  "tracking": {                                           # ball-track lens, per clip
    "soc-near-01": {"persistencePct": 0.97, "speedErrorPct": 0.08, "possessionCorrect": true}
  }
}
"""
import argparse
import json
import re
import sys

REACTION_CUES = re.compile(
    r"crowd|erupt|celebrat|pile|bench|dugout|reaction|applause|cheer", re.I
)


def compute(clips, events, stage_a, tracking, accept):
    clips_by_id = {c["id"]: c for c in clips}
    cand_by_clip = {}
    dec_by_clip = {}
    for ev in events:
        cid = ev.get("clipId")
        if ev.get("type") == "candidate":
            cand_by_clip.setdefault(cid, []).append(ev)
        elif ev.get("type") == "decision":
            dec_by_clip.setdefault(cid, []).append(ev)

    # --- recall / precision -------------------------------------------------
    positives = [c for c in clips if c["groundTruth"]["isHighlight"]]
    negatives = [c for c in clips if not c["groundTruth"]["isHighlight"]]
    tp = 0
    for c in positives:
        decs = dec_by_clip.get(c["id"], [])
        if any(d["decision"].get("isHighlight") for d in decs):
            tp += 1
    recall_live = _recall(subset(modes=("live",)), clips, dec_by_clip)
    recall_vod = _recall(subset(modes=("vod",)), clips, dec_by_clip)

    # precision: predicted-positive decisions on non-highlight clips are FP
    fp = 0
    for c in negatives:
        decs = dec_by_clip.get(c["id"], [])
        if any(d["decision"].get("isHighlight") for d in decs):
            fp += 1
    precision = tp / (tp + fp) if (tp + fp) else None

    # --- Stage-A noise-trigger FP rate ---------------------------------------
    total_cand = stage_a.get("totalCandidates", 0)
    rejected = stage_a.get("rejected", 0)
    fp_rate = rejected / total_cand if total_cand else None

    # --- end-to-end latency --------------------------------------------------
    latencies = []
    goal_latencies = []
    for cid, cands in cand_by_clip.items():
        for cand in cands:
            ts = cand.get("timestamp")
            decs = dec_by_clip.get(cid, [])
            if not decs:
                continue
            dts = min(d["timestamp"] for d in decs)
            lat = max(0.0, dts - ts)
            latencies.append(lat)
            if cand.get("eventType", "").upper() == "GOAL":
                goal_latencies.append(lat)
    e2e_max = max(latencies) if latencies else None
    goal_median = _median(goal_latencies) if goal_latencies else None

    # --- reaction cited on true positives ------------------------------------
    reaction_tp = 0
    cited = 0
    for c in positives:
        decs = dec_by_clip.get(c["id"], [])
        hit = [d for d in decs if d["decision"].get("isHighlight")]
        if not hit:
            continue
        reaction_tp += 1
        if any(REACTION_CUES.search((d["decision"].get("reason") or "") + " " +
                                    json.dumps(d["decision"]))
               for d in hit):
            cited += 1
    reaction_rate = cited / reaction_tp if reaction_tp else None

    # --- tracking lens --------------------------------------------------------
    persist = _avg_track(tracking, "persistencePct")
    speed_err = _avg_track(tracking, "speedErrorPct")
    poss = _avg_track(tracking, "possessionCorrect")

    return {
        "recallLive": recall_live, "recallVod": recall_vod, "precision": precision,
        "e2eLatencyMax": e2e_max, "goalLatencyMedian": goal_median,
        "fpRate": fp_rate, "reactionCited": reaction_rate,
        "persistence": persist, "speedError": speed_err, "possession": poss,
    }, accept


def subset(modes):
    return lambda c: c.get("mode") in modes


def _recall(sel, clips, dec_by_clip):
    pos = [c for c in clips if c["groundTruth"]["isHighlight"] and sel(c)]
    hit = 0
    for c in pos:
        decs = dec_by_clip.get(c["id"], [])
        if any(d["decision"].get("isHighlight") for d in decs):
            hit += 1
    return hit / len(pos) if pos else None


def _median(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        return None
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def _avg_track(tracking, key):
    vals = [t.get(key) for t in tracking.values() if t.get(key) is not None]
    return sum(vals) / len(vals) if vals else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("trace")
    args = ap.parse_args()

    manifest = json.load(open(args.manifest))
    trace = json.load(open(args.trace))
    clips = manifest["clips"]
    accept = manifest["acceptance"]
    m, a = compute(clips, trace.get("events", []), trace.get("stageA", {}),
                   trace.get("tracking", {}), accept)

    rows = [
        ("highlight recall < live >= 85%",        m["recallLive"],   a["recallLivePct"] / 100.0, "gte"),
        ("highlight recall < vod  >= 90%",        m["recallVod"],    a["recallVodPct"] / 100.0, "gte"),
        ("precision >= 70%",                      m["precision"],    a["precisionPct"] / 100.0, "gte"),
        ("e2e latency max <= 5s",                 m["e2eLatencyMax"], a["e2eLatencyMaxS"],       "lte"),
        ("GOAL latency median <= 3s",            m["goalLatencyMedian"], a["goalLatencyMedianMaxS"], "lte"),
        ("noise-trigger FP rate <= 60%",          m["fpRate"],       a["noiseTriggerFpRateMaxPct"] / 100.0, "lte"),
        ("reaction cited >= 80% of TP",           m["reactionCited"], a["reactionCitedMinPct"] / 100.0, "gte"),
        ("ball-track persistence >= 95%",         m["persistence"],  a["ballTrackPersistenceMinPct"] / 100.0, "gte"),
        ("ground-plane speed error <= 15%",       m["speedError"],   a["groundPlaneSpeedErrorMaxPct"] / 100.0, "lte"),
        ("possession accuracy >= 90%",            m["possession"],   a["possessionAccuracyMinPct"] / 100.0, "gte"),
    ]
    overall = True
    incomplete = False
    print(f"acceptance-metric run  (sport={manifest['sport']}, clips={len(clips)})")
    for name, got, bar, op in rows:
        if got is None:
            print(f"  INCOMPLETE  {name:<42} got=NA (not measured in this trace)")
            incomplete = True
            continue
        ok = got >= bar if op == "gte" else got <= bar
        overall = overall and ok
        print(f"  {'PASS' if ok else 'FAIL':<7}  {name:<42} got={got:.3f} bar={bar:.3f}")
    if incomplete:
        print("OVERALL: INCOMPLETE (at least one metric not measured; overall is not a pass)")
        return 1
    print("OVERALL:", "PASS" if overall else "FAIL")
    return 0 if overall else 1


if __name__ == "__main__":
    sys.exit(main())


def _compute_alias(*a, **k):  # noqa
    return compute(*a, **k)
