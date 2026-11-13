"""ADAAAA-8841 — perceive mirror of the clock-dash score refusal.

The server's ``parseOcrScoreLine`` / ``ocrScorePairIsNoise``
(services/server/src/analyzer.ts) and perceive's ``_score_pair_in_line`` /
``_pair_is_noise`` (app/scoreboard.py) read the SAME OCR line on their own side
of the wire, so they must not disagree about it. Both suites read the shared
table at ``services/server/test/fixtures/8841-ocr-parity-table.json``; a
divergence in either parser fails one of the two.

Strings in the table are the measured census strings (live job ``1ee3c97d``, the
Sky Sports share, ADAAAA-8841), the 8507 garbage family and the pinned controls
— not invented ones.
"""
import json
from pathlib import Path

import pytest

from app.scoreboard import _pair_is_noise, parse_ocr_score

TABLE_PATH = (
    Path(__file__).resolve().parents[2]
    / "server"
    / "test"
    / "fixtures"
    / "8841-ocr-parity-table.json"
)
CASES = json.loads(TABLE_PATH.read_text())["cases"]


@pytest.mark.parametrize(
    "case", CASES, ids=[f"{c['line']}|{c['sport']}" for c in CASES]
)
def test_shared_table_parity(case):
    expected = tuple(case["expected"]) if case["expected"] is not None else None
    assert parse_ocr_score([case["line"]], sport=case["sport"]) == expected


def test_table_covers_the_measured_families():
    lines = [c["line"] for c in CASES]
    assert len(CASES) >= 30
    for measured in ("24-35", "0-01951", "0-034.02GREATEST FANSTHE", "45-42"):
        assert measured in lines


def test_unknown_sport_is_lenient_no_regression():
    """The pre-8841 gate is byte-identical for a job with no sport: the pinned
    basketball pair and the four 8507 garbage strings behave exactly as today."""
    assert parse_ocr_score(["45-42"]) == (45, 42)
    assert parse_ocr_score(["Q3 45-42"]) == (45, 42)


def test_zero_padded_group_is_never_a_plate():
    assert parse_ocr_score(["0-01951"]) is None
    assert parse_ocr_score(["0-034.02GREATEST FANSTHE"]) is None
    assert parse_ocr_score(["LALIGA|0JALIGA05-40 AL1UberFC B"]) is None


def test_pair_equal_to_the_line_clock_is_refused_in_any_sport():
    # sport-independent: the line itself names the clock (GT-2).
    assert parse_ocr_score(["24-35 24:35"]) is None
    assert parse_ocr_score(["LAL 45-42 45:42"], sport="basketball") is None
    # ...and a plate that is NOT the clock survives.
    assert parse_ocr_score(["45-42 Q3 12:00"], sport="basketball") == (45, 42)
    assert parse_ocr_score(["1-1 1:01"]) == (1, 1)


def test_predicate_is_directly_callable_with_the_sport():
    text = "24-35"
    assert _pair_is_noise(text, "24", "35", 0, 5, (False, False), "soccer") is True
    assert _pair_is_noise(text, "24", "35", 0, 5, (False, False), "basketball") is False
