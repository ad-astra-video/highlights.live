"""ADAAAA-8935: the FILE rail publishes its measured kit swatches.

Every served `source=file` job stored `kitSamples: 0` (no player-crop samples on
the VOD rail) while carrying ~60 score-bug swatch readings, so
`matchContext.teams[].kitColors` was `[]` on every post-fix job and the
surface-identity kit channel had nothing of the job's own to compare against
(`kitReference: "prior"`, `kitDistance: null` on real sessions).

These tests pin the resolver half of the fix: when NO player-crop cluster was
observed at all, a side's STABLE score-bug swatch names its kit colour, with the
shipped vetoes intact (unstable reading -> nothing, ADAAAA-8076 contradiction ->
nothing, below-floor clusters keep the shipped honest miss).
"""
from __future__ import annotations

from app.match_context import resolve_match_context

# The served La Liga bug + the away plate population ADAAAA-8919 measured.
BLUE = [99.0, 102.0, 182.0]
WHITE = [236.0, 238.0, 236.0]
CYAN = [40.0, 200.0, 200.0]
RED = [190.0, 30.0, 32.0]

LA_LIGA_LINES = ["22:04 RMA 2-1 BAR"]


def _frames(n: int = 30, line: str = LA_LIGA_LINES[0]):
    return [{"ts": float(i), "lines": [line]} for i in range(n)]


def _swatches(side: str, rgb, color: str, n: int = 30):
    return [{"side": side, "rgb": list(rgb), "color": color, "ts": float(i)} for i in range(n)]


def _published(ctx) -> dict[str, list[str]]:
    return {
        str(t.get("side")): [k.get("primary") for k in (t.get("kitColors") or [])]
        for t in ctx["teams"]
    }


def test_file_rail_stable_swatch_names_the_kit_with_no_player_crops():
    # The exact served shape: kitSamples 0, 60 swatch readings, one attributed
    # side. The away half reads BLUE on every frame, so it is a measurement.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=_frames(),
        kit_samples=[],
        scorebug_swatches=_swatches("away", BLUE, "blue") + _swatches("home", WHITE, "white"),
    )
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert status["kitSamples"] == 0
    assert status["scorebugSwatches"] == 60
    by_side = {t["side"]: t for t in ctx["teams"]}
    assert by_side["away"]["name"] == "Barcelona"
    # AC-B3: length(teams[].kitColors) > 0 on a file-rail job.
    assert _published(ctx)["away"] == ["blue"]
    assert status["kitSwatchUsed"] == ["away"]
    assert ctx["ambiguous"] is False
    # A measured swatch is a measurement, not a curated prior attribution.
    assert status.get("kitPriorUsed") == []


def test_file_rail_unstable_swatch_publishes_nothing():
    # The cited ad-board shape: the away half disagrees frame to frame, so no
    # modal reading exists and no colour may be published (an honest miss).
    swatches = _swatches("away", BLUE, "blue", n=6) + _swatches("away", CYAN, "cyan", n=6)
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=_frames(),
        kit_samples=[],
        scorebug_swatches=swatches,
    )
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert _published(ctx)["away"] == []
    assert "kitSwatchUsed" not in status


def test_file_rail_swatch_that_contradicts_the_curated_primary_is_vetoed():
    # ADAAAA-8076 kept unchanged: Portugal's curated primary is red, so a stable
    # CYAN swatch may not publish, and the record names the withheld reading.
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=_frames(line="POR 1 - 0 ESP"),
        kit_samples=[],
        scorebug_swatches=_swatches("home", CYAN, "cyan"),
    )
    ctx, status = out["matchContext"], out["evidenceStatus"]
    by_side = {t["side"]: t for t in ctx["teams"]}
    assert by_side["home"]["name"] == "Portugal"
    assert by_side["home"]["kitColors"] == []
    assert status["kitSwatchVetoed"] == [{"side": "home", "swatch": "cyan", "curated": "red"}]
    assert "kitSwatchUsed" not in status


def test_below_floor_clusters_keep_the_shipped_honest_miss():
    # A thin pass DID observe player crops (below the ADAAAA-8072 floor). The
    # swatch channel must not turn that into a published colour: the pre-8935
    # shape (both sides unattributed, clusters named) is preserved exactly.
    def sample(rgb, ts, seq):
        return {"rgb": list(rgb), "ts": ts, "frameSeq": seq, "trackId": "t%d" % seq}

    samples = [sample(RED, 10.0 + i, i) for i in range(3)] + [sample(CYAN, 20.0 + i, 10 + i) for i in range(2)]
    out = resolve_match_context(
        game_hint="soccer",
        ocr_frames=_frames(line="POR 1 - 0 ESP"),
        hints={"title": "Portugal vs Spain"},
        kit_samples=samples,
        scorebug_swatches=_swatches("home", CYAN, "cyan") + _swatches("away", WHITE, "white"),
    )
    ctx, status = out["matchContext"], out["evidenceStatus"]
    assert _published(ctx) == {"home": [], "away": []}
    assert "kitSwatchUsed" not in status
    assert set(status["kitClustersBelowFloor"]) == {"cyan", "red"}
