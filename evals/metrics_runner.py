#!/usr/bin/env python3
"""INC-5 / ADAAAA-4329 acceptance-metric runner (QA), extended for ADAAAA-4959
VOD-vs-live paired scoring (spec ADAAAA-4940 §3).

Reads a labeled eval clip manifest plus one or two traces of the staged
detection pipeline's OutboundEvents (packages/events contract) and computes the
acceptance metrics (§3 bars) plus the paired out-depth metric (A4, spec §3),
printing PASS/FAIL against the bars.

Pure stdlib, no runtime deps: this is the reproducible accounting tool for the
acceptance-metric run. Real traces come from driving the deployed perceive+
decide pipeline over the labeled clips; a synthetic trace (evals/fixtures) shows
the accounting is correct against the component-tested behaviour.

Two invocation modes:

1) Single-trace (legacy INC-5/INC-9):
     python3 evals/metrics_runner.py evals/label-manifest.json <trace.json>

2) Paired VOD-vs-live (ADAAAA-4940 §3):
     python3 evals/metrics_runner.py --vod <vod_trace.json> --live <live_trace.json> \
         evals/label-manifest.json
   Scores each pass against the §3 bars and emits a paired out-depth delta
   (mean D_vod > D_live). Used for the ADAAAA-4959 first-eval run.

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

ADAAAA-8122: `perceive` no longer emits candidates (commit ADAAAA-7108), so
`evals/drive_decide_cycle.py` now fires decide on the deployed observe cadence
and records each decided WINDOW as a `candidate` event with
`"source": "observe-cadence"` (`stageA.mode` names it). That keeps the
window-level accounting this runner already does — `rejected/totalCandidates`
is then the share of decided windows the model rejected, NOT a perceive
trigger false-positive rate.

A windows-shaped frame-verified manifest
(`{"windows":[...], "video":{...}}`, e.g.
`evals/kids_soccer_near_miss/label-manifest.json`) is scored directly: every
window becomes one clip (a `ground_truth: "goal"` window is a positive, the
rest are negatives) and its pixel-derived `instant` becomes the localisation
ground truth.
"""
import argparse
import json
import re
import sys

REACTION_CUES = re.compile(
    r"crowd|erupt|celebrat|pile|bench|dugout|reaction|applause|cheer", re.I
)


def compute(clips, events, stage_a, tracking, accept, localisation_tolerance_s=None):
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

    # --- detail score (A4) ---------------------------------------------------
    depth = _compute_depth(clips, events)

    # --- goal localisation (ADAAAA-8122) --------------------------------------
    # Per positive unit the ground truth is a single pixel-derived instant; the
    # localisation error is the nearest ACCEPTED decision's event time minus that
    # instant. Cadence-limited by construction (the drive never sees the label),
    # so report the median absolute error and the share inside the tolerance.
    tol = localisation_tolerance_s
    if tol is None:
        tol = float(accept.get("localisationToleranceS") or 5.0)
    loc = []
    for c in positives:
        instant = (c.get("groundTruth") or {}).get("instant")
        if instant is None:
            continue
        hits = [d for d in dec_by_clip.get(c["id"], [])
                if d["decision"].get("isHighlight")]
        if not hits:
            continue
        t = min(float(d.get("eventTime", d.get("timestamp"))) for d in hits)
        loc.append(round(t - float(instant), 3))
    loc_abs = sorted(abs(v) for v in loc)
    localisation = {
        "n": len(loc),
        "medianAbsS": _median(loc_abs) if loc_abs else None,
        "medianS": _median(loc) if loc else None,
        "withinTolerance": (sum(1 for v in loc_abs if v <= tol) / len(loc_abs)) if loc_abs else None,
        "toleranceS": tol,
        "missed": len([c for c in positives
                       if (c.get("groundTruth") or {}).get("instant") is not None]) - len(loc),
    }

    return {
        "recallLive": recall_live, "recallVod": recall_vod, "precision": precision,
        "e2eLatencyMax": e2e_max, "goalLatencyMedian": goal_median,
        "fpRate": fp_rate, "reactionCited": reaction_rate,
        "persistence": persist, "speedError": speed_err, "possession": poss,
        "depthMean": depth["mean"], "depthN": depth["n"],
        # ADAAAA-8122: goal-level FP + localisation, measured per labelled unit.
        "goalFpUnits": fp, "goalFpRate": (fp / len(negatives)) if negatives else None,
        "recallHits": tp, "negativesN": len(negatives), "positivesN": len(positives),
        "localisation": localisation,
    }, accept


# ---------------------------------------------------------------- A4 depth ---
# spec ADAAAA-4940 §3 / §2.2 "detail ground truth": a checklist of elements a
# detailed finding should cite (players, ball trajectory/possession, score/ctx,
# reaction, reason quality). D_detail(finding) = w1*frames + w2*evidence_cited +
# w3*reason_tokens + w4*event-window IoU, normalized 0-100. "Out-depth" = pooled
# VOD mean D_vod > live mean D_live (>=10% relative), with A5 FP gate healthy.

DEPTH_WEIGHTS = {"frames": 0.3, "evidence": 0.3, "reason": 0.2, "iou": 0.2}
_FRAMES_MAX = 24          # spec decideWindowN default
_REASON_CAP = 60          # reason-token normalization cap
_EVIDENCE_FIELDS = [      # detail checklist keys a decision may cite
    "players", "ball", "possession", "score", "reaction", "reason"
]


def _compute_depth(clips, events):
    """Per-finding D_detail pooled -> {mean, n}. No ground-truth leakage:
    only the finding's own frames/evidence/reason text is used, as with the
    deployed pipeline. Event-window IoU uses the clip groundTruth window."""
    by_clip = {c["id"]: c for c in clips}
    decs = [ev for ev in events if ev.get("type") == "decision"
            and ev.get("decision", {}).get("isHighlight")]
    scores = []
    for d in decs:
        cid = d.get("clipId")
        clip = by_clip.get(cid)
        if not clip:
            continue
        dec = d.get("decision", {})
        s = _detail_score(dec, clip)
        if s is not None:
            scores.append(s)
    return {"mean": (sum(scores) / len(scores)) if scores else None,
            "n": len(scores)}


def _detail_score(dec, clip):
    """D_detail for one highlight finding, 0-100. Returns None if nothing
    measurable (finding carries no frames/evidence/reason)."""
    reason = dec.get("reason") or ""
    gt = clip.get("groundTruth", {})
    detail_gt = clip.get("detail") or {}

    # w1 frames judged per trigger (from decision 'frames' or framesJudged)
    frames = dec.get("framesJudged")
    if frames is None and isinstance(dec.get("frames"), list):
        frames = len(dec["frames"])
    w1 = min(1.0, (frames or 0) / _FRAMES_MAX) if frames is not None else None

    # w2 evidence fields cited (detail checklist ∩ reason text)
    checklist = detail_gt.get("evidence", []) or _EVIDENCE_FIELDS
    text = (reason + " " + json.dumps(dec)).lower()
    cited = sum(1 for f in checklist if f.lower() in text)
    w2 = cited / len(checklist) if checklist else None

    # w3 reason token fraction
    w3 = min(1.0, len(reason.split()) / _REASON_CAP) if reason.strip() else None

    # w4 event-window IoU vs ground-truth window
    gt_win = gt.get("eventWindow") or detail_gt.get("eventWindow")
    w4 = _window_iou(dec, gt_win)

    comps = [w1, w2, w3, w4]
    weighted = sum(c * DEPTH_WEIGHTS[k] for c, k in zip(comps, DEPTH_WEIGHTS)
                   if c is not None)
    total_w = sum(DEPTH_WEIGHTS[k] for c, k in zip(comps, DEPTH_WEIGHTS)
                  if c is not None)
    if total_w == 0:
        return None
    return round(100.0 * weighted / total_w, 1)


def _window_iou(dec, gt_win):
    """IoU of a finding's temporal span vs the ground-truth event window.
    Finding span: [eventTime - 2s, eventTime + 2s] if present, else from the
    decision timestamp via a 4 s window. No span at all -> None (unmeasured)."""
    if not gt_win:
        return None
    g0, g1 = gt_win[0], gt_win[1]
    t = dec.get("eventTime") or dec.get("timestamp")
    span = dec.get("eventSpan")
    if span:
        f0, f1 = span
    elif t is not None:
        f0, f1 = float(t) - 2.0, float(t) + 2.0
    else:
        return None
    inter = max(0.0, min(f1, g1) - max(f0, g0))
    union = max(f1, g1) - min(f0, g0)
    if union <= 0:
        return None
    return inter / union


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


# ------------------------------------------------------- paired §3 table ----
_BARS = [
    ("highlight recall < live >= 85%", "recallLive", "recallLivePct", "gte", 100.0),
    ("highlight recall < vod  >= 90%", "recallVod", "recallVodPct", "gte", 100.0),
    ("precision >= 70%", "precision", "precisionPct", "gte", 100.0),
    ("e2e latency max <= 5s", "e2eLatencyMax", "e2eLatencyMaxS", "lte", 1.0),
    ("GOAL latency median <= 3s", "goalLatencyMedian", "goalLatencyMedianMaxS", "lte", 1.0),
    ("noise-trigger FP rate <= 60%", "fpRate", "noiseTriggerFpRateMaxPct", "lte", 100.0),
    ("reaction cited >= 80% of TP", "reactionCited", "reactionCitedMinPct", "gte", 100.0),
    ("ball-track persistence >= 95%", "persistence", "ballTrackPersistenceMinPct", "gte", 100.0),
    ("ground-plane speed error <= 15%", "speedError", "groundPlaneSpeedErrorMaxPct", "lte", 100.0),
    ("possession accuracy >= 90%", "possession", "possessionAccuracyMinPct", "gte", 100.0),
]


def _print_single(m, a, sport, label):
    incomplete = False
    overall = True
    print(f"acceptance-metric run  (sport={sport}, trace={label})")
    for name, mkey, akey, op, scale in _BARS:
        got = m.get(mkey)
        bar = a[akey] / scale if a.get(akey) is not None else None
        if got is None or bar is None:
            print(f"  INCOMPLETE  {name:<42} got=NA")
            incomplete = True
            continue
        ok = got >= bar if op == "gte" else got <= bar
        overall = overall and ok
        print(f"  {'PASS' if ok else 'FAIL':<7}  {name:<42} got={got:.3f} bar={bar:.3f}")
    # ADAAAA-8122: the goal axes the model comparison is graded on. These are
    # measured numbers, not bars — recall/precision above stay the gates and the
    # caller quotes these next to them.
    pos, neg = m.get("positivesN") or 0, m.get("negativesN") or 0
    fp, fpr = m.get("goalFpUnits"), m.get("goalFpRate")
    print(f"  MEASURED goal recall                       "
          f"got={m.get('recallHits', 0)}/{pos} positive units "
          f"(recallVod={m.get('recallVod')}, recallLive={m.get('recallLive')})")
    print(f"  MEASURED goal FP                           "
          f"got={fp if fp is not None else 'NA'}/{neg} negative units"
          f"{'' if fpr is None else f' (rate {fpr:.3f})'}")
    loc = m.get("localisation") or {}
    if loc.get("n"):
        print(f"  MEASURED goal localisation                 "
              f"n={loc['n']} median|dt|={loc['medianAbsS']:.2f}s "
              f"median_dt={loc['medianS']:+.2f}s "
              f"within±{loc['toleranceS']:.1f}s={loc['withinTolerance']:.3f} "
              f"missed={loc['missed']}")
    else:
        print(f"  INCOMPLETE  goal localisation              got=NA "
              f"(no accepted decision on a unit carrying a labelled instant)")
    if incomplete:
        print("OVERALL: INCOMPLETE (at least one metric not measured)")
        return 1
    print("OVERALL:", "PASS" if overall else "FAIL")
    return 0 if overall else 1


def _print_outdepth(vod, live):
    """Paired A4 out-depth: mean D_vod > D_live by >=10% relative."""
    dv, lv = vod.get("depthMean"), live.get("depthMean")
    print(f"out-depth D_vod={dv} (n={vod.get('depthN')}) vs D_live={lv} "
          f"(n={live.get('depthN')})")
    if dv is None or lv is None or lv <= 0:
        print("  INCOMPLETE  out-depth: depth not measured on one/both passes")
        return None
    rel = (dv - lv) / lv
    ok = rel >= 0.10
    print(f"  {'PASS' if ok else 'FAIL':<7}  out-depth mean D_vod>D_live "
          f"(>=10% rel)  rel={rel*100:.1f}%  (D_vod={dv:.1f}, D_live={lv:.1f})")
    return ok


# ------------------------------------------------------- HUD latency (A5) ----
# ADAAAA-8745: `evals/measure_hud_recall.py` exports the Stage-A HUD trigger's
# live-path latency as a JSON artifact; this runner grades it against the A5 bar
# so the latency number is read by the same acceptance tool as every other bar
# instead of living in a comment. No fixture export is admissible: the plan
# (§2 WP4) admits no `--backend fixture` number anywhere in WP1-WP4.

HUD_LATENCY_BAR_S = 0.5


def _hud_latency_verdict(doc):
    """Grade a `measure_hud_recall.py` export. Returns (ok, lines, incomplete)."""
    if not isinstance(doc, dict) or not doc.get("harness"):
        return False, ["  INCOMPLETE  hud latency export             got=not a hud export"], True
    backend = doc.get("backend")
    if backend != "live" or doc.get("admissible") is False:
        return False, [
            f"  INADMISSIBLE  hud latency export           backend={backend!r} "
            f"admissible={doc.get('admissible')!r}",
            "  (a fixture export is not a measurement — plan §2 WP4)",
        ], True
    lat = doc.get("latency") or {}
    cpu = lat.get("eventToCandidateCpuS") or {}
    frame = lat.get("cpuFrameS") or {}
    wall = lat.get("eventToCandidateWallS") or {}
    bar_cfg = ((doc.get("bars") or {}).get("stageAEventToCandidateCpuP95S") or {})
    bar = float(bar_cfg.get("bar", HUD_LATENCY_BAR_S))
    got = cpu.get("p95")
    lines = [
        f"== HUD stage-A latency (live path, {doc.get('frames')} frames, "
        f"{doc.get('candidates')} candidates) ==",
    ]
    if got is None or not cpu.get("n"):
        lines.append("  INCOMPLETE  event->candidate CPU p95       got=NA "
                     "(no candidate emitted — recall, not latency, is the finding)")
        return False, lines, True
    ok = float(got) <= bar
    lines.append(f"  {'PASS' if ok else 'FAIL':<7}  event->candidate CPU p95 <= "
                 f"{bar:.2f}s            got={float(got):.4f} bar={bar:.4f}")
    for label, block in (("cpu/frame p95", frame), ("event->candidate wall p95", wall)):
        if block.get("n"):
            lines.append(f"  MEASURED {label:<34} got={float(block['p95']):.4f}s "
                         f"(p50={float(block['p50']):.4f} max={float(block['max']):.4f})")
    if doc.get("wallS") is not None:
        lines.append(f"  MEASURED wall/compute share                 "
                     f"wall={float(doc['wallS']):.1f}s "
                     f"gpu-minutes={0.0 if not (doc.get('gpu') or {}).get('used') else 'see export'}")
    return ok, lines, False


def _print_hud_latency(path):
    doc = json.load(open(path))
    ok, lines, incomplete = _hud_latency_verdict(doc)
    for line in lines:
        print(line)
    return 0 if (ok and not incomplete) else 1


def load_manifest(path):
    """Load either label-manifest shape into (clips, acceptance, sport).

    `{"windows": [...]}` (frame-verified per-type manifests, ADAAAA-8122) is
    expanded into the clip shape this runner already scores: one unit per
    labelled window, `ground_truth == "goal"` -> positive, and the window's
    pixel-derived `instant` carried as the localisation ground truth. Windows
    manifests carry no acceptance block, so the same §3 bars the legacy manifest
    uses are applied (recall per mode, precision, reaction cited) plus the
    localisation tolerance this runner reads.
    """
    m = json.load(open(path))
    if not (isinstance(m, dict) and "windows" in m):
        return m["clips"], m["acceptance"], m.get("sport", "?")

    clips = []
    for w in m["windows"]:
        is_goal = str(w.get("ground_truth", "")).lower() == "goal"
        gt = {"isHighlight": is_goal,
              "eventType": ("GOAL" if is_goal else None),
              "eventWindow": [float(w["t_start"]), float(w["t_end"])]}
        if w.get("instant") is not None:
            gt["instant"] = float(w["instant"])
        clips.append({
            "id": w["id"],
            "mode": w.get("mode", "vod"),
            "groundTruth": gt,
            "detail": {"eventWindow": gt["eventWindow"]},
            "evidence": w.get("evidence"),
        })
    accept = m.get("acceptance") or {
        "recallLivePct": 85, "recallVodPct": 90, "precisionPct": 70,
        "reactionCitedMinPct": 80, "localisationToleranceS": 5.0,
    }
    return clips, accept, m.get("sport") or (m.get("video") or {}).get("sport") or "soccer"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("manifest")
    ap.add_argument("trace", nargs="?")
    ap.add_argument("--vod", help="VOD pass trace (paired mode)")
    ap.add_argument("--live", help="live baseline trace (paired mode)")
    ap.add_argument("--loc-tolerance", type=float, default=None,
                    help="localisation tolerance in seconds (default: manifest "
                         "acceptance.localisationToleranceS, else 5.0)")
    ap.add_argument("--hud-latency", default=None,
                    help="grade a measure_hud_recall.py latency export against the A5 "
                         "stage-A event->candidate p95 bar (ADAAAA-8745); may be combined "
                         "with a trace run")
    args = ap.parse_args()

    rc_lat = None
    if args.hud_latency:
        rc_lat = _print_hud_latency(args.hud_latency)
        if not args.trace and not (args.vod and args.live):
            return rc_lat

    clips, accept, sport = load_manifest(args.manifest)

    # Paired VOD-vs-live mode (ADAAAA-4959 / spec §3)
    if args.vod and args.live:
        vt = json.load(open(args.vod))
        lt = json.load(open(args.live))
        vm, _ = compute(clips, vt.get("events", []), vt.get("stageA", {}),
                        vt.get("tracking", {}), accept,
                        localisation_tolerance_s=args.loc_tolerance)
        lm, _ = compute(clips, lt.get("events", []), lt.get("stageA", {}),
                        lt.get("tracking", {}), accept,
                        localisation_tolerance_s=args.loc_tolerance)
        print(f"== VOD detail-first pass ==")
        _print_single(vm, accept, sport, "vod")
        print(f"\n== live baseline pass ==")
        _print_single(lm, accept, sport, "live")
        print(f"\n== paired out-depth (A4) ==")
        ok = bool(_print_outdepth(vm, lm))
        return 0 if ok and not rc_lat else 1

    # Single-trace legacy mode
    if not args.trace:
        ap.error("provide a trace (or --vod + --live for paired mode)")
    trace = json.load(open(args.trace))
    m, a = compute(clips, trace.get("events", []), trace.get("stageA", {}),
                   trace.get("tracking", {}), accept,
                   localisation_tolerance_s=args.loc_tolerance)
    rc = _print_single(m, a, sport, args.trace)
    dm = m.get("depthMean")
    if dm is not None:
        print(f"out-depth D_detail mean = {dm:.1f} (n={m.get('depthN')})")
    return rc if rc_lat is None else max(rc, rc_lat)


if __name__ == "__main__":
    sys.exit(main())


def _compute_alias(*a, **k):  # noqa
    return compute(*a, **k)
