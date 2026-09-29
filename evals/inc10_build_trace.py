#!/usr/bin/env python3
"""ADAAAA-5786 — build a decide_discernment-style JSONL trace from an INC-10
drive output (evals/inc10-trace.json), mapping each recorded decide decision
back to its manifest phase/truth. One JSONL line per candidate:
{phase, truth, isHighlight, score, eventType, eventClass, corroborated, reason, reaction}.
"""
import json, sys

def main():
    trace_path = sys.argv[1] if len(sys.argv) > 1 else "inc10-trace.json"
    manifest_path = sys.argv[2] if len(sys.argv) > 2 else "label-manifest.json"
    out_path = sys.argv[3] if len(sys.argv) > 3 else "inc10-decisions.jsonl"

    man = json.load(open(manifest_path))
    clips = man["clips"] if isinstance(man, dict) else man
    meta = {c["id"]: c for c in clips}

    trace = json.load(open(trace_path))
    events = trace.get("events", [])
    n_cand = n_dec = 0
    lines = []
    for ev in events:
        if ev.get("type") == "candidate":
            n_cand += 1
            continue
        if ev.get("type") != "decision":
            continue
        cid = ev["clipId"]
        c = meta.get(cid)
        if c is None:
            print(f"!! no manifest entry for {cid}", file=sys.stderr)
            continue
        d = ev.get("decision") or {}
        rec = {
            "phase": c["phase"],
            "truth": bool(c["groundTruth"]["isHighlight"]),
            "isHighlight": bool(d.get("isHighlight", False)),
            "score": d.get("score"),
            "eventType": d.get("eventType") or ev.get("eventType"),
            "source": d.get("source"),
            "reason": d.get("reason"),
            "eventClass": d.get("eventClass"),
            "corroborated": d.get("corroborated"),
            "reaction": ev.get("reaction"),
            "clipId": cid,
        }
        lines.append(rec)
        n_dec += 1
    with open(out_path, "w") as fh:
        for r in lines:
            fh.write(json.dumps(r) + "\n")
    print(f"candidates={n_cand} decisions={n_dec} -> {out_path}")

    # Criterion-1 summary: any negative-phase surfaced highlight.
    print("\n## Criterion 1 — surfaced highlights by phase")
    print(f"{'phase':18}{'n':>3}{'surfaced':>9}{'truth':>7}")
    from collections import defaultdict
    agg = defaultdict(list)
    for r in lines:
        agg[r["phase"]].append(r)
    any_neg_surf = False
    for phase in sorted(agg):
        rs = agg[phase]
        n = len(rs)
        surf = sum(1 for r in rs if r["isHighlight"])
        t = any(r["truth"] for r in rs)
        print(f"{phase:18}{n:>3}{surf:>9}{str(t):>7}")
        if not t and surf:
            any_neg_surf = True
    print(f"\nANY_NEGATIVE_PHASE_SURFACED={any_neg_surf}")

if __name__ == "__main__":
    main()
