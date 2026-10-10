"""Tests for the increment-D /plan HTTP route (ADAAAA-6467).

The decide runner exposes the single-shot what-to-track planner over HTTP
(planogram 4.4 / 7 D) so the server/worker can fire it at stream-start
warm-up + out-of-band re-check — NEVER from the per-frame path.

Rule/stub mode (DECIDE_MODE unset -> "rule") returns a deterministic
safe-default plan so the worker always gets a valid, type-specific,
non-empty-ish contract; the gemma mode path is covered by test_planner /
test_planner_finetune (the planner module's own unit tests), so this file
locks the HTTP contract + mode cap + degrade-to-safe-default behaviour.
"""

from fastapi.testclient import TestClient

from app import create_app, TrackingPlanResponse


def _client():
    return TestClient(create_app())


def test_plan_route_live_mode_clamps_to_3():
    c = _client()
    r = c.post(
        "/plan",
        json={"intent": "goal scoring", "category": "soccer", "mode": "live", "image": "aGk="},
    )
    assert r.status_code == 200
    plan = r.json()
    # Valid, type-specific contract with the LIVE cap (3) applied.
    assert plan["planVersion"] == 1
    assert plan["maxTracks"] == 3
    assert plan["source"] == "planner-fallback"  # rule mode, no gemma
    assert plan["category"] == "soccer"
    assert plan["intent"] == "goal scoring"


def test_plan_route_vod_mode_clamps_to_8():
    c = _client()
    r = c.post("/plan", json={"intent": "plays", "category": "basketball", "mode": "vod"})
    assert r.status_code == 200
    plan = r.json()
    assert plan["maxTracks"] == 8
    assert plan["source"] in ("planner", "planner-fallback")


def test_plan_route_response_schema_is_valid():
    c = _client()
    r = c.post("/plan", json={"intent": "", "category": "", "mode": "live"})
    plan = r.json()
    # Validate against the response model (extra=ignore should tolerate future fields).
    parsed = TrackingPlanResponse.model_validate(plan)
    assert parsed.source in ("planner", "planner-fallback")
    assert parsed.maxTracks in (3, 8)
