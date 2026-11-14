"""ADAAAA-9039 — perceive mirror of the glued plate-and-clock normalisation.

The server's ``ocrGluedClockScorePair`` / ``parseOcrScoreLine``
(services/server/src/analyzer.ts) and perceive's ``_glued_clock_score_pair`` /
``parse_ocr_score`` (app/scoreboard.py) read the SAME OCR line on their own side
of the wire, so they must not disagree about it. The shared table at
``services/server/test/fixtures/8841-ocr-parity-table.json`` carries the measured
family and its refusals, and both suites read it.

Measured on the natural live Sky Sports share ``771f42de``: window ``g84`` (the
one that owns the first goal boundary) carries ``sky sports0-139:21`` — the POST
plate ``0-1`` glued to its clock ``39:21`` — which the digit lane read as one
pair ``(0, 139)`` and refused, leaving the boundary with no POST side.
"""
import json
from pathlib import Path

import pytest

from app.scoreboard import _glued_clock_score_pair, parse_ocr_score

TABLE_PATH = (
    Path(__file__).resolve().parents[2]
    / "server"
    / "test"
    / "fixtures"
    / "8841-ocr-parity-table.json"
)
CASES = json.loads(TABLE_PATH.read_text())["cases"]

MEASURED = "sky sports0-139:21"


@pytest.mark.parametrize(
    "case",
    [c for c in CASES if c["why"].startswith("9039")],
    ids=[f"{c['line']}|{c['sport']}" for c in CASES if c["why"].startswith("9039")],
)
def test_shared_table_9039_rows(case):
    expected = tuple(case["expected"]) if case["expected"] is not None else None
    assert parse_ocr_score([case["line"]], sport=case["sport"]) == expected


def test_the_measured_plate_reads_as_the_plate_it_carries():
    assert _glued_clock_score_pair(MEASURED, "soccer") == (0, 1)
    assert parse_ocr_score([MEASURED], sport="soccer") == (0, 1)
    assert _glued_clock_score_pair("0-142:15ELIN", "soccer") == (0, 1)
    assert _glued_clock_score_pair("0-142:31PENDERSSKIN30", "soccer") == (0, 1)
    assert _glued_clock_score_pair("sky sports1-149:36PREDAT", "soccer") == (1, 1)


def test_sport_scoped_never_global():
    """A sport that can print two-digit plates keeps today's verdict."""
    for sport in ("basketball", "american football", None):
        assert _glued_clock_score_pair(MEASURED, sport) is None
        assert parse_ocr_score([MEASURED], sport=sport) is None
    # the pinned two-digit pairs are untouched
    assert parse_ocr_score(["45-42"], sport="basketball") == (45, 42)
    assert parse_ocr_score(["24-17"], sport="american football") == (24, 17)
    assert parse_ocr_score(["45-42"], sport="soccer") is None


def test_ambiguous_families_are_refused():
    # no clock on the line
    assert _glued_clock_score_pair("0-139", "soccer") is None
    assert parse_ocr_score(["0-139"], sport="soccer") is None
    # zero-run: B=0 is indistinguishable from the clock's own leading zero
    assert _glued_clock_score_pair("0-038:37", "soccer") is None
    assert parse_ocr_score(["0-038:37"], sport="soccer") is None
    assert parse_ocr_score(["0-019:57"], sport="soccer") is None
    assert parse_ocr_score(["0-01951"], sport="soccer") is None
    # one-digit-minute run: plate `1-` + clock `50:22`, not `1-5` at `0:22`
    assert _glued_clock_score_pair("rea1-50:22", "soccer") is None
    assert parse_ocr_score(["rea1-50:22"], sport="soccer") is None
    assert parse_ocr_score(["1-71:57G Google GerminGe"], sport="soccer") is None
    # mid-run: a legible plate in front of an ad clock is never re-sliced
    assert _glued_clock_score_pair("1-1-148:51-3 MINSLIVE", "soccer") is None
    assert parse_ocr_score(["1-1-148:51-3 MINSLIVE"], sport="soccer") == (1, 1)


def test_control_set_unchanged():
    assert parse_ocr_score(["RMA 1-1 BAR"], sport="soccer") == (1, 1)
    assert parse_ocr_score(["2-5 3-2FULLMATCHFINALVS"], sport="soccer") == (3, 2)
    assert parse_ocr_score(["0-01951"], sport="soccer") is None
    assert parse_ocr_score(["24-35"], sport="soccer") is None
    assert parse_ocr_score(["1-1sky soccer45:11LIVE3"], sport="soccer") == (1, 1)


def test_precedence_never_outranks_a_legible_plate():
    digit = "1-1sky sports47:21main e"
    assert parse_ocr_score([MEASURED, digit], sport="soccer") == (1, 1)
    assert parse_ocr_score([digit, MEASURED], sport="soccer") == (1, 1)
    # same line: the legible plate wins even with the glued run behind it
    assert parse_ocr_score(["0-1sky sports39.24main e|" + MEASURED], sport="soccer") == (0, 1)
    # ...and the glued plate outranks the letter-O glyph lane
    assert parse_ocr_score(["O-O39.02", MEASURED], sport="soccer") == (0, 1)
