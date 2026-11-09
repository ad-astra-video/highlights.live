"""ADAAAA-8507: a score read must be a score PLATE, not broadcast chrome.

The browser (customer) live share read the sponsor banner as the scoreboard.
On job ``c4d33a26`` (147 decide calls, 11.1 min, STATIC scorebug) the crop's
lines are ``LALIGA``, ``LALIGASPOTIFY CAMP NOU``, ``whitebitwhitebitLALIGA``,
``LAUGASTANLEY STANLEYSTAN``, ``LALIGA|0JALIGA05-40 AL1UberFC B``; the dash lane
turned CLOCK fragments into scores ``(5,40)``, ``(9,40)``, ``(28,1)``, ``(53,1)``
and 79/147 windows claimed a score change.

Pure functions only — no GPU, no network, no job.
"""
from __future__ import annotations

from app.scoreboard import ScoreboardTracker, parse_ocr_score

# The exact strings the stored prompts of `c4d33a26` carried next to each
# garbage score read.
GARBAGE = {
    "5-40": "LALIGA|0JALIGA05-40 AL1UberFC B",
    "53-1": "LALIGANEWALBUMNEW ALBUM|ALB 04:53-1NEWALBUM-0 NE",
    "29-1": "BIMDOBIMDLALIGA|LALIGA03:29-1at a Spotif",
    "9-40": "LALIGA|LALIGA09-40-1GIMODGIMOOG",
    "28-1": "LALIGAMootballnike.com/f|LALIGA02:28-1om/football",
    "15-0": "LALIGACcomiglow GLOW Fre|0LALIGA04:15-0LOW-free-t",
    "30-1": "LALIGA|LALIGA00:30-1STRELLI28%4",
    "8-10": "LALIGALALIGASTANLEYSTANL|EY08-10 AM1STANLEYSTANLE",
}


def test_rejects_every_garbage_score_the_browser_share_read():
    for score, line in GARBAGE.items():
        assert parse_ocr_score([line]) is None, f"{score} from {line}"


def test_rejects_them_when_the_crop_reads_the_whole_banner():
    assert parse_ocr_score(list(GARBAGE.values())) is None
    assert parse_ocr_score(["LALIGA", "LAUGATIEMPOmico football", "whitebitwhitebitLALIGA"]) is None


def test_keeps_the_8459_legible_series():
    assert parse_ocr_score(["RMA 1-1 BAR"]) == (1, 1)
    assert parse_ocr_score(["RMA 2-1 BAR"]) == (2, 1)
    assert parse_ocr_score(["RMA 2-2 BAR"]) == (2, 2)


def test_keeps_a_clock_prefixed_real_plate():
    assert parse_ocr_score(["19-41 RMA-2-1 BAR"]) == (2, 1)
    assert parse_ocr_score(["18:13 |RMA2-1 BAR"]) == (2, 1)


def test_keeps_a_double_digit_basketball_plate():
    # No leading zero, so it is a plate, not a `mm:ss` clock. This is the
    # shipped contract (`test_parse_ocr_score_separator_variants`).
    assert parse_ocr_score(["45-42"]) == (45, 42)


def test_keeps_a_real_plate_on_a_sponsor_line():
    # Pair sandwiched between the two team tokens: a plate, not chrome.
    assert parse_ocr_score(["LALIGA RMA 1-1 BAR"]) == (1, 1)


def test_static_scorebug_never_fires_a_change():
    # The whole class the ticket measured: the crop only ever reads chrome, so
    # the tracker records no reading and can never report a transition.
    tracker = ScoreboardTracker()
    for ts, line in enumerate(GARBAGE.values()):
        tracker.record(float(ts), parse_ocr_score([line]))
    assert tracker.changed(6.0) is False
    assert tracker.delta(6.0) is None
