#!/usr/bin/env python3
"""Build the SuperTuxKart window labels for ADAAAA-7768 from the reader pass.

Reads the per-second OCR band reads (race clock / centre banner / grand-prix
panel) and emits:

  evals/supertuxkart_val/label-manifest.json   window labels + frame proof
  evals/supertuxkart_val/audio-labels.json     audio-harness corpus

Label method: the *clock* instants come from the race clock digits read at
native pixel resolution (`ocr_clock.json`), the *banner* instants from the
centre banner band, and the one missing final-lap banner (race D) from the
lap counter going 2/3 -> 3/3. Nothing is parsed from a kill feed, and the
audio gate that scores these labels never sees the HUD.

Usage: python3 build_stk_labels.py <scratch-dir> <repo-root>
"""
import json
import os
import re
import sys

SCRATCH, REPO = sys.argv[1], sys.argv[2]
CLIP = "sh_onfoss_20230923_tournament.mp4"

# --- race clock: start = read_time - clock_value -----------------------------
CLOCK_RE = re.compile(r"(\d{1,2})[:.'](\d{2})[.:](\d{3})")
reads = {}
for rec in json.load(open(f"{SCRATCH}/ocr_clock.json")):
    for txt, conf in rec["texts"]:
        m = CLOCK_RE.search(txt.replace(" ", ""))
        if m and conf >= 0.35:
            mm, ss, ms = (int(g) for g in m.groups())
            if ss < 60 and mm < 10:
                reads[rec["t"]] = (mm * 60 + ss + ms / 1000.0, conf)
                break

# race starts observed as clusters of (t - clock) around the five resets
START_CLUSTERS = {"A": 4429.5, "B": 4764.5, "C": 5126.5, "D": 5342.5, "E": 5545.5}
race_reads = {k: [] for k in START_CLUSTERS}
for t, (v, c) in reads.items():
    for k, s in START_CLUSTERS.items():
        if abs((t - v) - s) < 1.5:
            race_reads[k].append((t, v, c))
            break
for k in race_reads:
    race_reads[k].sort()
    assert race_reads[k], f"no clock reads for race {k}"

# first clock read per race -> exact start bracket
starts = {}
for k, rs in race_reads.items():
    t0, v0, _ = rs[0]
    starts[k] = {"instant": round(t0 - v0, 2), "bracket": [round(t0 - v0 - 1, 1), t0],
                 "read": f"clock {v0:.2f} s at t={t0}", "first_read_t": t0}

# --- verified banner / lap-counter instants (1 fps band reads) --------------
FINAL_LAP = {  # centre banner "Final lap!" except D, which has the lap counter
    "A": (4547, [4547, 4548], "banner", "'Final lap!' read at t=4547 (0.762) and t=4548 (0.810)"),
    "B": (4873, [4873, 4874], "banner", "'Finallap!' read at t=4873 (0.763) and 'Final lap!' at t=4874 (0.779)"),
    "C": (5222, [5222, 5223], "banner", "'Finallap!' read at t=5222 (0.789)"),
    "D": (5440, [5437, 5440], "lap-counter", "lap counter '2/38' (=2/3) at t=5436, counter unread at 5437-5439, '3/38' (=3/3) from t=5440"),
    "E": (5649, [5649, 5650], "banner", "'Fral lape' (=Final lap!) read at t=5649 (0.660)"),
}
FINISH = {  # "You finished the race in rank N" banner; E by clock stop
    "A": (4596, [4596, 4597], "banner", "'finished the race in rank 5' read at t=4596 (0.783) and t=4597 (0.853)"),
    "B": (4974, [4974, 4975], "banner", "'You finished the race in rank 6' read at t=4974 (0.791)"),
    "C": (5251, [5251, 5252], "banner", "'You finished the race in rank 6!' read at t=5251 (0.827) and t=5252 (0.883)"),
    "D": (5490, [5490, 5492], "banner", "'You finished the race in rank 5' read at t=5490 (garbled OCR 'YotfiaispecheraceinransS')"),
    "E": (5698, [5697, 5699], "clock-stop", "last coherent clock read 02:31.675 at t=5697, no clock at t=5698, race-results overlay ('Best lap time') at t=5699"),
}

race_span = {}
for k in START_CLUSTERS:
    last_t, last_v, _ = race_reads[k][-1]
    race_span[k] = (starts[k]["instant"], last_t)

events = []
for k in "ABCDE":
    s = starts[k]
    events.append({"id": f"{k}-start", "race": k, "event_type": "race_start",
                   "instant": s["instant"], "bracket": s["bracket"], "channel": "race-clock-zero",
                   "ground_truth": "objective_event",
                   "evidence": [s["read"], "clock absent in the frame before the reset (menu / prior race)"]})
    inst, br, ch, ev = FINAL_LAP[k]
    events.append({"id": f"{k}-final-lap", "race": k, "event_type": "final_lap",
                   "instant": inst, "bracket": br, "channel": ch, "evidence": [ev],
                   "ground_truth": "objective_event"})
    inst, br, ch, ev = FINISH[k]
    events.append({"id": f"{k}-finish", "race": k, "event_type": "race_finish",
                   "instant": inst, "bracket": br, "channel": ch, "evidence": [ev],
                   "ground_truth": "objective_event"})

onsets = [e["instant"] for e in events]
assert len(events) == 15, len(events)


def clock_at(t, race):
    """Clock seconds around t for that race (nearest coherent read within 2 s)."""
    best = None
    for rt, (v, _c) in reads.items():
        if abs(rt - t) > 3:
            continue
        if abs((rt - v) - START_CLUSTERS[race]) >= 1.5:
            continue  # a misread digit, not this race's clock
        if best is None or abs(rt - t) < abs(best[0] - t):
            best = (rt, v)
    return best


# --- non-event windows: mid-race, >=10 s clear of every labelled instant ----
CANDIDATE_WINDOWS = [
    ("A", 4460), ("A", 4500), ("A", 4560),
    ("B", 4795), ("B", 4830), ("B", 4890),
    ("C", 5140), ("C", 5175),
    ("D", 5360), ("D", 5390), ("D", 5455),
    ("E", 5560), ("E", 5600),
]
negatives = []
for i, (race, t0) in enumerate(CANDIDATE_WINDOWS, 1):
    t1 = t0 + 24
    lo, hi = race_span[race]
    assert lo <= t0 and t1 <= hi, (race, t0, t1, lo, hi)
    a, b = clock_at(t0, race), clock_at(t1 + 1, race)
    assert a and b, (race, t0, t1, a, b)
    d = b[1] - a[1]
    elapsed = b[0] - a[0]
    assert abs(d - elapsed) <= 2.0, (race, t0, "clock delta", d, "elapsed", elapsed)
    near = [t for t in onsets if t0 - 10 <= t <= t1 + 10]
    assert not near, (race, t0, "event too close", near)
    negatives.append({
        "id": f"N{i:02d}", "kind": "non_event", "t_start": t0, "t_end": t1,
        "window_class": "mid_race_no_objective_event",
        "evidence": [
            f"race {race} clock {a[1]:.2f} s at t={a[0]} and {b[1]:.2f} s at t={b[0]} (delta {d:.2f} s; the race is running, not a menu)",
            f"no labelled start/final-lap/finish instant within +/-10 s of the window (nearest {min(min(abs(t0 - t), abs(t - t1)) for t in onsets):.0f} s outside)",
        ],
        "ground_truth": "no_objective_event",
    })
assert len(negatives) >= 10, len(negatives)

manifest = {
    "$comment": (
        "ADAAAA-7768 - frame-derived window labels for the SuperTuxKart half of the rights-cleared "
        "CC0 onFOSS 2023-09-23 tournament livestream. Labels were read from the pixels only: the race "
        "clock digits at native resolution (1 fps), the centre event banner ('Final lap!', 'You finished "
        "the race in rank N') and, for the one race whose banner the reader could not resolve, the lap "
        "counter going 2/3 -> 3/3. No label comes from decide reason text, from a detection model's "
        "output, from any kill-feed/HUD parser (none was built), or from a soccer/football clip. Each "
        "instant carries the bracket it was narrowed to; the per-second grid bounds most brackets at "
        "1-2 s and one at 3 s (race D final lap)."
    ),
    "video": {
        "id": "onfoss-2023-09-23-stk-tournament",
        "path": CLIP,
        "source": "https://archive.org/details/on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream",
        "source_file": "https://archive.org/download/on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream/onFOSS_%202023-09-23%20-%20Hypersomnia%20and%20STK-Tournament%20Livestream-240p.mp4",
        "rights_basis": "CC0 1.0 (public-domain dedication)",
        "license_url": "https://creativecommons.org/publicdomain/zero/1.0/",
        "rights_holder": "onFOSS (event organiser publishing its own tournament stream; uploader gnudist@tutanota.com)",
        "attribution": "onFOSS 2023-09-23 Hypersomnia and STK-Tournament livestream, CC0 1.0, via the Internet Archive",
        "sha256": "3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264",
        "bytes": 435639290,
        "duration_s": 5950.549,
        "width": 426,
        "height": 240,
        "audio": "aac 48 kHz stereo; caster commentary over game SFX (the bed this type's audio trigger is measured on)",
        "frame_source": "native 426x240 frames decoded at 1 fps; the race-clock band (x 364-428, y 30-56), the centre banner band (x 120-320, y 60-110) and the grand-prix panel (x 60-170, y 50-180) were cropped per frame and read at 4x-6x Lanczos",
        "labels_by": "Highlights.live Developer (Paperclip run 4bdaad60-108d-4961-b36c-46918a1a7024)",
        "labelled_at": "2026-11-02",
        "label_method": "race-clock catalogue: every frame of the SuperTuxKart half (t=4380-5731) cropped to the clock/banner/panel bands at 1 fps and read as text; a race start is the instant where (frame time - clock value) is constant across the race's reads, a final lap is the centre banner (or the lap counter's 3/3 transition), a finish is the 'You finished the race in rank N' banner, and non-event windows are 24 s mid-race windows with the clock running at both ends and no labelled instant within +/-10 s.",
        "label_confidence_note": "The 1 fps grid bounds an instant to 1 s. Race D's final lap is bracketed at 3 s because its banner was not resolvable by the reader and the lap counter transition sits between two frames (5436 -> 5440). The audio harness is scored at its default -3 s/+2 s match window, which covers every bracket in this file.",
        "segment_note": "Only the SuperTuxKart tournament half is labelled. The earlier Hypersomnia (2D arena shooter) half carries no label-grade event channel at 426x240 and is NOT labelled, so fires there are outside the labelled window and are reported separately rather than counted as certified false positives.",
    },
    "coverage": {
        "competitive_races": 5,
        "race_spans_s": {k: [round(v[0], 1), v[1]] for k, v in race_span.items()},
        "competitive_play_s": sum(race_span[k][1] - race_span[k][0] for k in race_span),
        "objective_events": len(events),
        "non_event_windows": len(negatives),
        "non_event_window_s": 24,
        "event_classes": {"race_start": 5, "final_lap": 5, "race_finish": 5},
        "floor_note": "the issue's floor is >=15 objective events and >=10 non-event windows; met at 15 and 13 on 833 s of one grand prix across five races. Read narrowly (only start + finish count as objective events, laps do not) the set is 10 events and misses the floor; that reading is stated in RESULTS.md so the margin is not smuggled in.",
        "objective_events_floor_met": True,
        "non_event_windows_floor_met": True,
        "narrow_reading_events": 10,
    },
    "windows": events + negatives,
    "known_gaps": [
        "race E's finish banner was not resolvable by the reader, so its finish instant is the clock stop (bracket 2 s) rather than a banner read",
        "the Hypersomnia half of the stream has no label-grade event channel at 426x240 and is unlabelled",
        "no frame-level detection slice exists for this type, so detect_precision has no esports label space (reference.detectionSlice stays null)",
    ],
}

audio_labels = {
    "$comment": (
        "ADAAAA-7768 - SuperTuxKart audio-trigger eval corpus. One measured class: the objective-event "
        "moments of a kart grand prix (race start / final lap / race finish), read from the race clock and "
        "the centre event banner in evals/supertuxkart_val/label-manifest.json. Negatives are 24 s mid-race "
        "windows from the same clip that carry the race clock running at both ends and no labelled instant "
        "within +/-10 s (rotations/pack racing between events, not a menu or a replay cutaway). The clip is a "
        "box-side clip-root artifact (CC0 1.0, sha256 in the label manifest); it is not committed to the repo."
    ),
    "frameS": 0.1,
    "sr": 8000,
    "matchPre": 3.0,
    "matchPost": 2.0,
    "classes": [
        {
            "id": "objective_event",
            "clip": CLIP,
            "onsets": onsets,
            "labelSource": "evals/supertuxkart_val/label-manifest.json objective-event windows (race clock zero / 'Final lap!' banner / 'You finished the race in rank N' banner)",
            "measured": True,
            "negatives": [
                {"clip": CLIP, "start": n["t_start"], "end": n["t_end"],
                 "window_class": n["window_class"]}
                for n in negatives
            ],
        }
    ],
}

out = os.path.join(REPO, "evals", "supertuxkart_val")
os.makedirs(os.path.join(out, "run"), exist_ok=True)
json.dump(manifest, open(os.path.join(out, "label-manifest.json"), "w"), indent=1)
json.dump(audio_labels, open(os.path.join(out, "audio-labels.json"), "w"), indent=1)
print("events:", len(events), "negatives:", len(negatives))
for e in events:
    print(f"  {e['id']:14s} {e['instant']:7.2f} {str(e['bracket']):18s} {e['channel']}")
print("onsets:", onsets)
