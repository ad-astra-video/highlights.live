"""ADAAAA-6481 — trackable-class reconciliation unit tests.

Locks the §8 target_precision fix: a plan `goalkeeper` target and a delivered
`player` track are the SAME trackable class (Florence-2 boxes the keeper as a
player), so target resolution must reconcile at the class level rather than by
verbatim label, or a genuinely-present plan target is wrongly counted as
untracked.
"""
from app.tracking_plan import canonical_trackable_class, count_trackable_targets, target_classes


def test_canonical_class_goalkeeper_is_player():
    assert canonical_trackable_class("goalkeeper") == "player"
    assert canonical_trackable_class("player") == "player"
    assert canonical_trackable_class("person") == "player"
    assert canonical_trackable_class("soccer ball") == "ball"
    assert canonical_trackable_class("goal") == "goal"
    assert canonical_trackable_class("banner") == "banner"  # off-class stays itself
    assert canonical_trackable_class("") == "unknown"


def test_goalkeeper_plan_target_resolves_to_player_track():
    # Perceiver delivers the keeper as a `player` track (3 tracks).
    targets = [
        {"label": "soccer ball", "role": "ball"},
        {"label": "player", "role": "player"},
        {"label": "goalkeeper", "role": "player"},
    ]
    tracks = [{"label": "soccer ball"}, {"label": "player"}, {"label": "player"}]
    assert count_trackable_targets(targets, tracks) == 3


def test_only_one_player_delivered_resolves_one_player_class_target():
    # Only one player track delivered -> ball + one player resolve (2/3).
    targets = [
        {"label": "soccer ball", "role": "ball"},
        {"label": "player", "role": "player"},
        {"label": "goalkeeper", "role": "player"},
    ]
    tracks = [{"label": "soccer ball"}, {"label": "player"}]
    assert count_trackable_targets(targets, tracks) == 2


def test_target_classes_keeps_per_player_class_count():
    targets = [
        {"label": "player", "role": "player", "slotPriority": 1},
        {"label": "goalkeeper", "role": "player", "slotPriority": 2},
        {"label": "soccer ball", "role": "ball", "slotPriority": 0},
    ]
    cls = target_classes(targets)
    assert cls.count("player") == 2
    assert cls.count("ball") == 1


def test_normalize_dedupes_same_trackable_class_targets():
    from app.tracking_plan import normalize

    plan, warnings = normalize(
        {"targets": [{"label": "soccer ball", "role": "ball"},
                     {"label": "player", "role": "player"},
                     {"label": "goalkeeper", "role": "player"}]}
    )
    # `goalkeeper` is the same trackable class as `player` (Florence-2 boxes the
    # keeper as a player) -> the justified roster is ball + player (2 targets).
    labels = [t["label"] for t in plan["targets"]]
    assert labels == ["soccer ball", "player"]
    assert len(plan["targets"]) == 2
    assert any("deduplicated" in w for w in warnings)


def test_normalize_keeps_distinct_ball_and_player_classes():
    from app.tracking_plan import normalize

    plan, _ = normalize(
        {"targets": [{"label": "soccer ball", "role": "ball"},
                     {"label": "player", "role": "player"},
                     {"label": "goal", "role": "entity"}]}
    )
    assert [t["label"] for t in plan["targets"]] == ["soccer ball", "player", "goal"]
