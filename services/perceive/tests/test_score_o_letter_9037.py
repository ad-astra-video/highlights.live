"""ADAAAA-9037 — perceive mirror of the letter-O score plate normalisation.

The server's ``ocrLetterOScorePair`` / ``parseOcrScoreLine``
(services/server/src/analyzer.ts) and perceive's ``_letter_o_score_pair`` /
``parse_ocr_score`` (app/scoreboard.py) read the SAME OCR lines on their own side
of the wire, so they must not disagree about them. The shared table at
``services/server/test/fixtures/8841-ocr-parity-table.json`` pins the string-level
verdict for both layers; this file pins the perceive-specific parts:

* the FALLBACK ordering (a legible plate on any line outranks a letter-O plate),
* the ROI scoping still applies to a letter-O line,
* the tracker replay over the stored first-goal boundary windows.

Measured on the natural live Sky Sports share ``771f42de`` (ADAAAA-9035 artifact):
354 of 11849 timeline records carry the letter-O plate, and the five windows
before the first goal carried 0 score reads because of it.
"""
import json
from datetime import datetime
from pathlib import Path

import pytest

from app.scoreboard import (
    ScoreboardRoi,
    ScoreboardTracker,
    _letter_o_score_pair,
    parse_ocr_score,
)

FIXTURES = Path(__file__).resolve().parents[2] / "server" / "test" / "fixtures"
BOUNDARY = json.loads((FIXTURES / "9037-letter-o-boundary-windows.json").read_text())
TABLE = json.loads((FIXTURES / "8841-ocr-parity-table.json").read_text())["cases"]

SPORT = BOUNDARY["sport"]


def _window(gk):
    for w in BOUNDARY["windows"]:
        if w["gk"] == gk:
            return w
    raise AssertionError(f"fixture has no window {gk}")


def _reads(gk):
    out = []
    for o in _window(gk)["observations"]:
        p = parse_ocr_score(o["ocr"], sport=SPORT)
        if p is not None:
            out.append((o["ts"], p))
    return out


def test_predicate_normalises_the_measured_plate_forms():
    for line in (
        "O-O38:55",
        "O-O39.02",
        "O-Osky Sports36.09main e",
        "O-Osky SPORTS37:51",
        "sky sportsALO-O38:40",
        "O-O-OPY SPORTS36:15|0-0O-OJAY SPORTS36:15BER",
    ):
        assert _letter_o_score_pair(line, SPORT) == (0, 0), line
        assert parse_ocr_score([line], sport=SPORT) == (0, 0), line


def test_predicate_refuses_a_pair_that_is_not_plate_shaped():
    # no clock on the line => not plate-shaped
    assert _letter_o_score_pair("O-O", SPORT) is None
    # between two team tokens => the O's are a NAME, not zeros
    assert _letter_o_score_pair("RMA O-O BAR", SPORT) is None
    assert _letter_o_score_pair("RMA O-O BAR 38:55", SPORT) is None
    # clock too far away => an ad board, not a one-crop plate
    assert _letter_o_score_pair("O-O betway main event 36:09", SPORT) is None
    # the inherited chrome refusal still applies to the normalised pair
    assert parse_ocr_score(["LALIGA|LALIGA O-O 09-40"], sport=SPORT) is None
    # the measured separator-less shape stays unreadable
    assert parse_ocr_score(["OALsky sportsmain eventL"], sport=SPORT) is None


def test_letter_o_is_a_fallback_never_an_override():
    digit = "0-1sky sports39.24main e"
    assert parse_ocr_score(["O-O39.02", digit], sport=SPORT) == (0, 1)
    assert parse_ocr_score([digit, "O-O39.02"], sport=SPORT) == (0, 1)
    assert parse_ocr_score(["O-O38:55", "1-1sky sports47:21main e"], sport=SPORT) == (1, 1)
    assert parse_ocr_score(["O-Osky SPORTS35:36|0-1sky sports35:36EXCUE "], sport=SPORT) == (0, 1)


def test_digit_plate_never_moves():
    """Every digit control in the shared table keeps its verdict byte for byte."""
    import re

    letter_o = re.compile("[Oo]\\s*[-–—]\\s*[Oo]")
    checked = 0
    for case in TABLE:
        if letter_o.search(case["line"]):
            continue  # the letter-O family itself, covered above
        expected = tuple(case["expected"]) if case["expected"] is not None else None
        assert parse_ocr_score([case["line"]], sport=case["sport"]) == expected, case["line"]
        checked += 1
    assert checked >= 40


def test_roi_scoping_still_applies_to_a_letter_o_line():
    """The ROI gate runs BEFORE any parse, so an out-of-ROI letter-O plate is
    never evidence (the production path crops to the ROI, but the box form is
    still honoured)."""
    roi = ScoreboardRoi(x0=0.0, y0=0.0, x1=0.25, y1=0.1)
    # the line's box sits at the bottom of the frame, outside the ROI
    assert parse_ocr_score(["O-O38:55"], roi=roi, ocr_boxes=[(0.0, 0.9, 0.5, 0.99)], sport=SPORT) is None
    # ...and inside it, the same line parses
    assert parse_ocr_score(["O-O38:55"], roi=roi, ocr_boxes=[(0.0, 0.0, 0.2, 0.05)], sport=SPORT) == (0, 0)


def test_replay_pre_side_of_the_first_goal_boundary_appears():
    """g79 .. g83 carried 0 reads at 5455d64; every read they carry now is (0,0)."""
    for gk in ("g79", "g79:call2", "g81", "g82", "g83"):
        reads = _reads(gk)
        assert reads, gk
        assert {p for _ts, p in reads} == {(0, 0)}, gk
    assert [len(_reads(gk)) for gk in ("g81", "g82", "g83")] == [13, 9, 3]
    # the POST side is unchanged by this fix
    for gk in ("g85", "g86", "g87"):
        assert {p for _ts, p in _reads(gk)} == {(0, 1)}, gk


def test_replay_tracker_fires_the_boundary_once_with_the_fix():
    """Perceive's own lane: the tracker sees (0,0) -> (0,1) exactly once.

    Note the measured mirror divergence (reported on ADAAAA-9037, not changed
    here): the tracker's confirm gap runs from the FIRST POST read to the
    confirming read, while the server's ``scoreboardDeltaFromReadings`` runs from
    the last PRE read to the transition instant. The 13.65 s occlusion across
    this goal wipe therefore fails the server clause and passes perceive's.
    """
    def epoch(iso):
        return datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp()

    pooled = {}
    for w in BOUNDARY["windows"]:
        base = epoch(w["created"])
        for o in w["observations"]:
            p = parse_ocr_score(o["ocr"], sport=SPORT)
            if p is None:
                continue
            pooled.setdefault(round(base + o["ts"], 3), p)

    tracker = ScoreboardTracker()
    fired = []
    for ts, score in sorted(pooled.items()):
        tracker.record(ts, score)
        delta = tracker.delta(ts)
        if delta is not None:
            fired.append((ts, delta))

    assert len(fired) == 1
    ts, delta = fired[0]
    assert (delta.pre, delta.post) == ((0, 0), (0, 1))
    assert delta.pre_samples >= 2
    assert delta.post_samples == 2
    # fires ONCE per transition: no later frame re-reports the same change
    assert all(d.pre != (0, 0) or d.post != (0, 1) for _t, d in fired[1:])
