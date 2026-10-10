"""ADAAAA-6481: target-precision roster reification (decide planner dedup).

A `player` and a `goalkeeper` plan target are ONE trackable class (Florence-2
boxes the keeper as a `player` track; both role="player"). The planner must
emit the justified distinct-object set so target_precision (delivered-trackable
/ planned-target) is not under-counted by an over-requested roster. These tests
pin that behaviour without a live Gemma.
"""

from app.planner import _dedupe_targets_by_class, _plan_target_class


def test_plan_target_class_reconciles_keeper_to_player():
    assert _plan_target_class({"label": "goalkeeper"}) == "player"
    assert _plan_target_class({"label": "player"}) == "player"
    assert _plan_target_class({"label": "person"}) == "player"
    assert _plan_target_class({"label": "soccer ball"}) == "ball"
    assert _plan_target_class({"label": "goal"}) == "goal"
    assert _plan_target_class({"label": "banner"}) == "banner"  # off-class stays itself


def test_dedupe_targets_by_class_collapses_keeper():
    plan = {
        "targets": [
            {"label": "soccer ball", "role": "ball"},
            {"label": "player", "role": "player"},
            {"label": "goalkeeper", "role": "player"},
        ]
    }
    out = _dedupe_targets_by_class(plan)
    assert [t["label"] for t in out["targets"]] == ["soccer ball", "player"]
    assert out.get("_rosterDeduped") == 1
    # input is untouched
    assert len(plan["targets"]) == 3


def test_dedupe_preserves_zones_and_distinct_entities():
    plan = {
        "targets": [
            {"label": "soccer ball", "role": "ball"},
            {"label": "player", "role": "player"},
            {"label": "goalkeeper", "role": "player"},
            {"label": "goal mouth", "role": "zone"},
            {"label": "corner flag", "role": "entity"},
            {"label": "coach", "role": "agent"},
        ]
    }
    out = _dedupe_targets_by_class(plan)
    labels = [t["label"] for t in out["targets"]]
    assert "goal mouth" in labels     # zone preserved
    assert "corner flag" in labels    # distinct class preserved
    assert "coach" in labels          # distinct class preserved
    assert "goalkeeper" not in labels  # collapsed into player
    assert "player" in labels


def test_dedupe_ignores_non_dict_plan():
    assert _dedupe_targets_by_class(None) is None
    assert _dedupe_targets_by_class({"targets": []})["targets"] == []
