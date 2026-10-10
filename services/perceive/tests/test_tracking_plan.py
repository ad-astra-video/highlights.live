"""Tests for the TrackingPlan contract + validator (increment A — ADAAAA-6462,
child of ADAAAA-6441).

Lock the increment A acceptance on the CONTRACT side (plan §7 A validator
rules; plan §14.2):
  * role is an open enum (ball|player|agent|entity|zone) and UNKNOWN roles
    coerce to the safe default — never crash the per-frame path;
  * exactly one anchor, and the anchor always appears in targets after
    normalize() (missing/foreign anchor is repaired);
  * targets[].label runs through the trackability gate: UI/HUD and
    abstract labels are dropped (the closed-vocab gate the roster feeds);
  * zones[].normalized are floats in [0,1] (clamped, reordered, never
    rejected);
  * maxTracks: LLM proposes, the clamp enforces 3 live / 8 VOD;
  * discovery is optional but recorded when present;
  * the module re-exports the contract from the perceive app package.
"""
import pytest

from app.tracking_plan import (
    LIVE_MAX_TRACKS,
    PLAN_VERSION,
    SAFE_DEFAULT_ROLE,
    VOD_MAX_TRACKS,
    FLORENCE_TASKS,
    TrackingPlan,
    clamp_max_tracks,
    coerce_role,
    is_abstract_label,
    is_ui_hud_label,
    label_trackable,
    normalize,
    plan_vocabulary,
    validate,
)


def _good_targets():
    return [
        {"label": "soccer ball", "role": "ball", "slotPriority": 0, "track": True},
        {"label": "player", "role": "player", "slotPriority": 1, "track": True},
        {"label": "goalkeeper", "role": "player", "slotPriority": 2, "track": True},
    ]


def _good_plan(**overrides):
    raw = {
        "planVersion": PLAN_VERSION,
        "category": "Soccer",
        "intent": "highlight goal scoring and key plays",
        "anchor": {"label": "soccer ball", "role": "ball"},
        "targets": _good_targets(),
        "zones": [
            {"name": "goal-mouth-right", "normalized": [0.7, 0.4, 1.0, 0.9], "purpose": "goal_detect"}
        ],
        "discovery": {"method": "od", "florenceTasks": ["<OD>"], "notes": "canned roster"},
        "maxTracks": 3,
        "reason": "ball + players + keeper carry the intent",
    }
    raw.update(overrides)
    return raw


# --- role coercion (open enum, safe default) --------------------------------


def test_known_roles_pass_through():
    for role in ("ball", "player", "agent", "entity", "zone"):
        got, coerced = coerce_role(role)
        assert got == role and not coerced


def test_unknown_role_safe_default_never_crashes():
    got, coerced = coerce_role("sentiment")
    assert got == SAFE_DEFAULT_ROLE == "entity" and coerced
    assert coerce_role(None) == ("entity", True)
    assert coerce_role("BALL ") == ("ball", False)  # case/whitespace normalized


# --- target trackability gate (closed vocab) ---------------------------------


def test_ui_hud_labels_dropped():
    for bad in ("scoreboard", "minimap", "kill feed", "HUD timer", "spectator list"):
        assert is_ui_hud_label(bad)
        assert not label_trackable(bad)
        plan, _ = normalize(_good_plan(targets=["soccer ball", bad]))
        assert bad not in [t["label"] for t in plan["targets"]]
        assert plan["targets"][0]["label"] == "soccer ball"


def test_abstract_labels_dropped():
    for bad in ("atmosphere", "crowd energy", "camera work", "tension"):
        assert is_abstract_label(bad)
        assert not label_trackable(bad)


def test_all_targets_untrackable_is_hard_invalid():
    raw = _good_plan(
        anchor={"label": "mood", "role": "zone"},
        targets=[
            {"label": "atmosphere", "role": "player"},
            {"label": "scoreboard", "role": "entity"},
        ],
    )
    ok, issues = validate(raw)
    assert not ok
    assert any("no trackable targets" in e for e in issues)


# --- anchor invariant --------------------------------------------------------


def test_anchor_must_appear_in_targets_repaired():
    plan, warnings = normalize(_good_plan(anchor={"label": "hoop", "role": "entity"}))
    assert plan["anchor"]["label"] == "soccer ball"
    assert any("does not appear in targets" in w for w in warnings)


def test_anchor_missing_safe_defaults_to_first_target():
    raw = _good_plan()
    del raw["anchor"]
    plan, warnings = normalize(raw)
    assert plan["anchor"]["label"] == "soccer ball"
    assert any("anchor missing" in w for w in warnings)


def test_anchor_cannot_be_a_zone():
    raw = _good_plan()
    raw["targets"].append({"label": "end zone", "role": "zone", "slotPriority": 3})
    raw["anchor"] = {"label": "end zone", "role": "zone"}
    plan, warnings = normalize(raw)
    assert plan["anchor"]["label"] == "soccer ball"
    assert any("re-anchored" in w for w in warnings)


def test_anchor_invariant_holds_after_normalize():
    for anchor in ({"label": "", "role": "ball"}, None, {"label": 42, "role": "x"}):
        plan, _ = normalize(_good_plan(anchor=anchor))
        assert plan["anchor"]["label"] in {t["label"] for t in plan["targets"]}


# --- zones -------------------------------------------------------------------


def test_zones_normalized_clamped_and_reordered():
    raw = _good_plan(
        zones=[
            # out-of-range floats + swapped x — must clamp into [0,1]
            {"name": "a", "normalized": [1.5, -0.5, 0.2, 0.9], "purpose": "goal_detect"},
            # non-numeric box — dropped with a warning, never a crash
            {"name": "bad", "normalized": ["x", "y", "z", "w"]},
            # dict form accepted
            {"name": "c", "normalized": {"x1": 0.1, "y1": 0.2, "x2": 0.3, "y2": 0.4}},
        ]
    )
    plan, warnings = normalize(raw)
    assert len(plan["zones"]) == 2
    for z in plan["zones"]:
        assert len(z["normalized"]) == 4
        assert all(0.0 <= v <= 1.0 for v in z["normalized"])
        assert z["normalized"][0] <= z["normalized"][2]
        assert z["normalized"][1] <= z["normalized"][3]
    assert any("bad" in w or "normalized" in w for w in warnings)


def test_zones_absent_yields_empty_list():
    raw = _good_plan()
    raw["zones"] = None
    plan, _ = normalize(raw)
    assert plan["zones"] == []


# --- maxTracks (LLM proposes, server clamps) ---------------------------------


def test_clamp_max_tracks_live_vod():
    assert clamp_max_tracks(8, "live") == LIVE_MAX_TRACKS == 3
    assert clamp_max_tracks(3, "vod") == 3
    assert clamp_max_tracks(100, "vod") == VOD_MAX_TRACKS == 8
    assert clamp_max_tracks(None, "live") == 0
    assert clamp_max_tracks("5", "vod") == 5
    assert clamp_max_tracks(-2, "live") == 0
    assert clamp_max_tracks(7, "unknown-mode") == 0


def test_plan_normalize_clamps_proposed_max_tracks():
    plan, _ = normalize(_good_plan(maxTracks=99))
    assert plan["maxTracks"] == VOD_MAX_TRACKS
    plan, warnings = normalize(_good_plan(maxTracks="bogus"))
    assert plan["maxTracks"] == LIVE_MAX_TRACKS
    assert any("not an int" in w for w in warnings)


def test_plan_tracking_clamp_applies_mode_cap():
    # The planner's server-side clamp (increment A call path) never exceeds
    # the mode cap: 3 live / 8 VOD.
    assert clamp_max_tracks(99, "live") == 3
    assert clamp_max_tracks(99, "vod") == 8


# --- discovery (optional but recorded) ---------------------------------------


def test_discovery_recorded_when_present():
    raw = _good_plan(
        discovery={
            "method": "caption",
            "florenceTasks": ["<DETAILED_CAPTION>", "<OD>"],
            "notes": "caption named the ball and #10",
        }
    )
    plan, _ = normalize(raw)
    assert plan["discovery"]["method"] == "caption"
    assert plan["discovery"]["florenceTasks"] == ["<DETAILED_CAPTION>", "<OD>"]
    assert "caption named" in plan["discovery"]["notes"]


def test_discovery_absent_yields_none():
    raw = _good_plan()
    raw.pop("discovery")
    plan, _ = normalize(raw)
    assert plan["discovery"] is None


def test_discovery_unknown_method_falls_back_to_mixed():
    plan, _ = normalize(_good_plan(discovery={"method": "vibes"}))
    assert plan["discovery"]["method"] == "mixed"


# --- category + never-raise contract ------------------------------------------


def test_category_normalized_lowercase():
    plan, _ = normalize(_good_plan())
    assert plan["category"] == "soccer"


@pytest.mark.parametrize("raw", [None, 42, "not a dict", [], {"targets": "oops"}])
def test_normalize_never_raises(raw):
    plan, _ = normalize(raw)
    assert isinstance(plan, dict)
    assert plan["planVersion"] == PLAN_VERSION
    assert isinstance(plan["targets"], list)


def test_florence_task_table_complete():
    # Increment A acceptance: the contract knows the FULL Florence-2 task table.
    assert set(FLORENCE_TASKS) == {
        "<OD>",
        "<CAPTION>",
        "<DETAILED_CAPTION>",
        "<MORE_DETAILED_CAPTION>",
        "<DENSE_REGION_CAPTION>",
        "<REGION_PROPOSAL>",
        "<CAPTION_TO_PHRASE_GROUNDING>",
        "<REFERRING_EXPRESSION_SEGMENTATION>",
        "<OCR>",
    }


# --- dataclass shape + vocabulary ---------------------------------------------


def test_tracking_plan_round_trip_and_vocabulary():
    raw = _good_plan()
    raw["targets"].append({"label": "end zone", "role": "zone", "slotPriority": 3})
    plan = TrackingPlan.from_dict(raw)
    assert plan.is_valid
    # zones excluded from the detection roster; slotPriority order kept
    assert plan.vocabulary() == ["soccer ball", "player", "goalkeeper"]
    d = plan.to_dict()
    # normalize() canonicalizes every target to the full contract shape
    # (track defaults to True); zones keep name/normalized/purpose
    assert all(t["track"] is True for t in d["targets"])
    assert {t["label"] for t in d["targets"]} == {t["label"] for t in raw["targets"]}
    assert d["zones"] == raw["zones"]
    # round-trip is stable
    assert TrackingPlan.from_dict(d).to_dict() == d


def test_plan_vocabulary_empty_for_invalid():
    assert plan_vocabulary(None) == []
    assert plan_vocabulary({"targets": [{"label": "atmosphere"}]}) == []


# --- re-export from the perceive app package ----------------------------------


def test_reexported_from_perceive_app_package():
    import app as app_mod

    assert app_mod.TrackingPlan is TrackingPlan
    assert app_mod.validate is validate
    assert app_mod.normalize is normalize
    assert app_mod.clamp_max_tracks is clamp_max_tracks
    assert app_mod.plan_vocabulary is plan_vocabulary
    assert app_mod.FLORENCE_TASKS == FLORENCE_TASKS
    assert app_mod.LIVE_MAX_TRACKS == 3 and app_mod.VOD_MAX_TRACKS == 8
