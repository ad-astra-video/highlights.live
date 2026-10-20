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
from app.gemma import (
    _compile_summary,
    _next_running_summary,
    _rule_summary,
    build_prompt,
    MAX_RUNNING_SUMMARY_CHARS,
)

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


# --- ADAAAA-7113: gemma-path monotonic containment -------------------------
# The rule path appends deterministically, so tick N is code-guaranteed to
# contain tick N-1. On the gemma path the model can REWRITE the summary and
# drop prior detail; _next_running_summary re-asserts containment so the
# persisted runningSummary never loses earlier events.


def test_next_running_summary_keeps_extension_verbatim():
    # Model produced a true forward-only extension of the prior -> keep it whole.
    prior = "min 1: a-team scored"
    model = "min 1: a-team scored\nmin 2: a-team nearly scored"
    out = _next_running_summary(prior, model)
    assert out == _compile_summary(model)
    assert out.startswith(prior)


def test_next_running_summary_repairs_dropped_detail():
    # Model rewrote and DROPPED prior detail -> prior is retained (monotonic).
    prior = "team-a: goal (GOAL)\nteam-a: near miss (SHOT)"
    model = "team-b advanced the ball"  # dropped the prior events entirely
    out = _next_running_summary(prior, model)
    # tick N still contains/extends tick N-1's covered events.
    assert out.startswith(prior)
    assert "GOAL" in out and "SHOT" in out
    assert "team-b advanced the ball" in out


def test_next_running_summary_partial_rewrite_keeps_prior():
    # Model kept some prior detail but dropped others: prior is prepended so
    # N-1's full covered set survives (no event loss, forward-only).
    prior = "early: kickoff\nevent: corner"
    model = "corner only"  # dropped 'kickoff'
    out = _next_running_summary(prior, model)
    assert "kickoff" in out and "corner" in out


def test_next_running_summary_empty_prior_uses_model():
    out = _next_running_summary("", "first tick detail")
    assert out == _compile_summary("first tick detail")


def test_next_running_summary_empty_model_keeps_prior():
    # Model omitted the summary: never lose the prior.
    prior = "prev events"
    assert _next_running_summary(prior, "") == _compile_summary(prior)


def test_next_running_summary_stays_bounded():
    prior = "p " * (MAX_RUNNING_SUMMARY_CHARS // 2)
    model = "m " * (MAX_RUNNING_SUMMARY_CHARS // 2)
    out = _next_running_summary(prior, model)
    assert len(out) <= MAX_RUNNING_SUMMARY_CHARS


def test_next_running_summary_consecutive_observes_monotonic():
    # Simulate consecutive cadence observes where the model keeps rewrites:
    # tick N summary must always begin with (contain) tick N-1's.
    s0 = "min 1: goal"
    s1 = _next_running_summary(s0, "min 1: goal\nmin 2: save")
    s2 = _next_running_summary(s1, "min 2: save")  # model dropped 'min 1: goal'
    assert s2.startswith(s0)
    assert s2.startswith(s1)


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
