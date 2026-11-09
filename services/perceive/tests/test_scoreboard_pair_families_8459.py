"""ADAAAA-8459: perceive reads the pair families the server's parser reads.

The measured live supply glued the score pair instead of hyphenating it
(`RMA 1/2 FCB36:54` on leg `348bd511`, `BAR0LALIGA 022 ALAMERCUR` on the
480-wide share `b55c5781`). The server's `parseOcrScoreLine`
(`services/server/src/analyzer.ts`, ADAAAA-8189) reads the `/`, `.` and single
space families with a per-side ceiling, so the attestation layer counted those
windows while perceive's own `ScoreboardTracker` recorded nothing and
`scoreBoardChanged` / `scoreboardDelta` never fired. These tests pin the two
layers to the same grammar, and pin the guardrails that keep a clock, a glued
two-digit component and the watermark-glued form from becoming a score.
"""
from __future__ import annotations

from app.scoreboard import ScoreboardRoi, ScoreboardTracker, parse_ocr_score


def test_slash_glued_pair_is_read():
    """Leg 348bd511 — 1450 `/` readings, 0 hyphens."""
    assert parse_ocr_score(["RMA 1/2 FCB36:54"]) == (1, 2)


def test_dot_glued_pair_is_read():
    assert parse_ocr_score(["RMA 1.0 FCB 17:22HOTELSK"]) == (1, 0)


def test_single_space_glued_pair_is_read():
    assert parse_ocr_score(["RMA 1 1 FCB 27:067"]) == (1, 1)


def test_clock_ahead_of_the_pair_does_not_win():
    """ADAAAA-8134: `19-41 RMA-2-1 BAR` is a clock then the score."""
    assert parse_ocr_score(["19-41 RMA-2-1 BAR"]) == (2, 1)


def test_glued_pair_needs_team_adjacency_on_both_sides():
    # A clock read with the score separator carries no team tokens -> absent.
    assert parse_ocr_score(["10/47"]) is None
    assert parse_ocr_score(["17.141"]) is None
    # Team text on one side only is not the score surface either.
    assert parse_ocr_score(["RMA 1/2"]) is None


def test_glued_two_digit_component_is_refused():
    """Per-side ceiling 9: a two-digit glued clock can never be a score."""
    assert parse_ocr_score(["RMA 10/47 FCB"]) is None
    assert parse_ocr_score(["RMA 17.141 FCB"]) is None


def test_watermark_glued_line_stays_absent_evidence():
    """The measured one-sided line must NOT be split into a phantom pair.

    `BAR0LALIGA 022 ALAMERCUR` reads a home plate, the competition watermark and
    a three-digit run: there is no separator and no away plate, so the honest
    answer is "no score" (ADAAAA-8459 AC3 — do not loosen the access gate).
    """
    assert parse_ocr_score(["BAR0LALIGA 022 ALAMERCUR"]) is None
    assert parse_ocr_score(["BAR1LALIGA"]) is None
    assert parse_ocr_score(["2LALIGA|2LALIGA28-26SPOTTY CAMP "]) == (28, 26)  # legacy hyphen


def test_roi_scoping_survives_the_glued_families():
    roi = ScoreboardRoi(0.0, 0.0, 0.5, 0.25)
    assert parse_ocr_score(["RMA 1/2 FCB"], roi=roi, ocr_boxes=[[0.7, 0.6, 0.9, 0.7]]) is None
    assert parse_ocr_score(["RMA 1/2 FCB"], roi=roi, ocr_boxes=[[0.1, 0.1, 0.4, 0.2]]) == (1, 2)


def test_glued_pair_feeds_the_delta_lane():
    """A `/`-glued pair now reaches the tracker, so the delta can fire there."""
    tracker = ScoreboardTracker(window_seconds=60.0)
    roi = ScoreboardRoi(0.0, 0.0, 1.0, 0.25)

    def step(ts: float, line: str):
        tracker.record(ts, parse_ocr_score([line], roi=roi))
        return tracker.delta(ts)

    # ADAAAA-7844: the delta fires ONCE, on the read that completes the
    # `SCOREBOARD_MIN_CONSISTENT_SAMPLES` (2) post-side run — a later frame that
    # keeps reading the same score is not a fresh measurement.
    assert step(0.0, "20:34 RMA 2/1 BAR") is None
    assert step(4.0, "20:38 RMA 2/1 BAR") is None
    assert step(8.0, "20:42 RMA 2/2 BAR") is None  # post side is 1 sample
    delta = step(12.0, "20:46 RMA 2/2 BAR")  # post side reaches 2 samples
    assert delta is not None
    assert delta.pre == (2, 1)
    assert delta.post == (2, 2)
    assert (delta.pre_samples, delta.post_samples) == (2, 2)
    assert step(16.0, "20:50 RMA 2/2 BAR") is None


def test_sponsor_glue_space_pair_is_accepted_like_the_server():
    """`BAR1 1 LBUM-NEWALBUM - N` reads (1, 1) on BOTH layers — KNOWN risk.

    Verified on the deployed `highlights-server` (probe `parseOcrScoreLine`,
    2026-11-09): the attestation parser returns `[1,1]` for this sponsor line,
    so perceive accepting it is parity, not a new loosening. Pinned here so the
    two grammars cannot drift apart silently, and so the phantom-pair risk this
    sponsor copy carries is visible: tightening it belongs to the SHARED
    grammar (`services/server/src/analyzer.ts` + this module together), never to
    one layer alone.
    """
    assert parse_ocr_score(["BAR1 1 LBUM-NEWALBUM - N"]) == (1, 1)
