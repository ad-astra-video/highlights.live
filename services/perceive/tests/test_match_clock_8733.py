"""ADAAAA-8733 (GT-2): the scorebug MATCH CLOCK parser (perceive mirror).

The server's ``parseOcrMatchClockLine`` (services/server/src/analyzer.ts) and
perceive's ``parse_match_clock_line`` (app/scoreboard.py) read the SAME OCR line
on their own side of the wire, so they must not disagree about it. The table
below is duplicated verbatim in
``services/server/test/match-clock-combine-8733.test.ts``; a divergence in either
parser fails one of the two suites.

Strings are the measured census strings (ADAAAA-8732, ``decide_audit``), not
invented ones.
"""
from app.scoreboard import (
    parse_match_clock,
    parse_match_clock_line,
    parse_match_clock_period,
    parse_ocr_score,
)

# (line, seconds, shape, period) — mirrored in the TS suite.
CLOCK_FIXTURES = [
    ("LALIGA00:56", 56, "mm:ss", None),
    ("LALIGA25:27 ATM", 1527, "mm:ss", None),
    ("RMA 1/2 FCB36:54", 2214, "mm:ss", None),
    ("RMA 1.0 FCB 17:22HOTELSK", 1042, "mm:ss", None),
    ("GER 4 1 SCO86:35FOXEURO2", 5195, "mm:ss", None),
    ("POL 1 2NED82:45EURO2024G", 4965, "mm:ss", None),
    ("ENG82.29", 4949, "dot", None),
    ("HUN99.34", 5974, "dot", None),
    ("Q3 1:05:30 LAL", 3930, "hh:mm:ss", "Q3"),
    ("RMA 27' FCB", 1620, "bare_minute", None),
    ("RMA 45+2' FCB", 2820, "bare_minute", None),
    ("1H 36:54", 2214, "mm:ss", "1H"),
]

# Lines that carry NO match clock (absent evidence, never fabricated).
NO_CLOCK_FIXTURES = [
    "",
    "STANLEY",
    "LALIGA",
    # The player scrub overlay that scores 100 % on a naive mm:ss regex.
    "0:03:04:800 3696",
    # The sponsor/banner chrome of a browser share.
    "BAR0LALIGA 022 ALAMERCUR",
    # A colon-form SCORE pair is not a clock.
    "RMA2:1 BAR",
    # A garbled colon token (the census's `27:067`) is not a clock either.
    "RMA 1 1 FCB 27:067",
]


def test_clock_fixtures_match_the_server_table():
    for line, seconds, shape, period in CLOCK_FIXTURES:
        reading = parse_match_clock_line(line)
        assert reading is not None, line
        assert reading["seconds"] == seconds, line
        assert reading["shape"] == shape, line
        assert reading["period"] == period, line
        assert reading["legible"] is True, line


def test_no_clock_lines_are_absent_evidence():
    for line in NO_CLOCK_FIXTURES:
        assert parse_match_clock_line(line) is None, line
        assert parse_match_clock([line]) is None, line


def test_token_is_the_text_that_produced_the_reading():
    reading = parse_match_clock_line("RMA 1/2 FCB36:54")
    assert reading is not None
    assert "RMA 1/2 FCB36:54".find(reading["token"]) >= 0


def test_period_markers_normalize_the_same_way_as_the_server():
    assert parse_match_clock_period("RMA 1/2 FCB36:54 1H") == "1H"
    assert parse_match_clock_period("2H 36:54") == "2H"
    assert parse_match_clock_period("Q3 01:20") == "Q3"
    assert parse_match_clock_period("1.Ç 05:12") == "Q1"
    assert parse_match_clock_period("HT 0-0") == "HT"
    assert parse_match_clock_period("LALIGA36:54") is None


def test_first_legible_clock_wins_across_lines():
    first = parse_match_clock(["LALIGA", "LALIGA27:00 KM"])
    assert first is not None and first["seconds"] == 1620
    assert parse_match_clock(["LALIGA", "STANLEY"]) is None
    assert parse_match_clock(None) is None


def test_clock_never_becomes_a_score():
    """The whole point of the separate parser: the score lane is untouched."""
    assert parse_ocr_score(["LALIGA36:54"]) is None
    assert parse_ocr_score(["RMA 1/2 FCB36:54"]) == (1, 2)
    tick = parse_match_clock_line("RMA 1/2 FCB36:54")
    assert tick is not None and tick["seconds"] == 2214
