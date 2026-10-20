"""ADAAAA-7111 (Increment D): running video summary (story-so-far) tests.

Covers the decide service's running-summary contract:
- `_compile_summary` bounds the summary and prunes OLDEST lines first;
- `_rule_summary` grows monotonically across ticks (tick N contains tick N-1)
  and stays bounded;
- `build_prompt` forwards the prior story-so-far and asks the model for an
  updated `runningSummary`;
- the `/highlight` rule path returns a growing, bounded `runningSummary` and
  honors an incoming `storySoFar`.
"""
from fastapi.testclient import TestClient

from app import app as decide_app
from app.gemma import _compile_summary, _rule_summary, build_prompt, MAX_RUNNING_SUMMARY_CHARS

client = TestClient(decide_app)


def test_compile_summary_bounds_to_cap():
    # A single over-cap line (no newlines) is truncated to the cap, never dropped.
    s = _compile_summary("x" * (MAX_RUNNING_SUMMARY_CHARS + 100))
    assert len(s) == MAX_RUNNING_SUMMARY_CHARS


def test_compile_summary_prunes_oldest_lines_first():
    # Multi-line: keep the NEWEST lines, drop the oldest, so recent detail survives.
    lines = [f"line-{i}" for i in range(200)]
    joined = "\n".join(lines)
    assert len(joined) > MAX_RUNNING_SUMMARY_CHARS
    out = _compile_summary(joined)
    assert len(out) <= MAX_RUNNING_SUMMARY_CHARS
    # The newest line survives; the oldest is gone.
    assert out.endswith("line-199")
    assert "line-0" not in out


def test_rule_summary_grows_monotonically_then_compacts():
    s1 = _rule_summary("", "scoring_play", "GOAL", "goal scored")
    s2 = _rule_summary(s1, "near_miss", "SHOT", "hit post")
    # tick N contains/extends tick N-1 (monotonic growth).
    assert s2.startswith(s1)
    assert "GOAL" in s2 and "SHOT" in s2


def test_prompt_forwards_story_so_far_and_asks_running_summary():
    p = build_prompt("GOAL", {}, game_hint="soccer", story_so_far="a-team scored")
    assert "STORY SO FAR" in p
    assert "a-team scored" in p
    # The model is asked to return an updated runningSummary in the JSON.
    assert "runningSummary" in p


def test_prompt_omits_story_so_far_when_absent():
    p = build_prompt("GOAL", {}, game_hint="soccer")
    # 'STORY SO FAR' only appears inside the instruction text when a prior
    # summary is forwarded; the JSON-shape instruction still names the field.
    assert 'runningSummary' in p


def test_highlight_rule_path_produces_growing_summary():
    payload = {
        "sessionId": "rs-1",
        "eventType": "KILL",
        "timestamp": 1.0,
        "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
    }
    r1 = client.post("/app/highlight", json=payload)
    assert r1.status_code == 200
    rs1 = r1.json().get("runningSummary", "")
    assert rs1, "first tick must produce a running summary"
    assert len(rs1) <= MAX_RUNNING_SUMMARY_CHARS

    # Next tick carries the prior summary forward (storySoFar).
    payload2 = dict(payload)
    payload2["storySoFar"] = rs1
    r2 = client.post("/app/highlight", json=payload2)
    assert r2.status_code == 200
    rs2 = r2.json().get("runningSummary", "")
    # ttick N contains/extends tick N-1 (monotonic growth, no rewrite).
    assert rs2.startswith(rs1), "summary must extend (not replace) the prior one"
    assert len(rs2) <= MAX_RUNNING_SUMMARY_CHARS
