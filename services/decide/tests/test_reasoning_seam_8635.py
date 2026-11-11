"""ADAAAA-8635 — the decide boundary's optional `reasoning` must add NO key.

Follow-up to ADAAAA-8625 (the same seam, one field over). `phase` was fixed by
making an unknown phase add no key on the producer side and tolerating `null` on
the consumer side. `reasoning` was still stamped unconditionally, and the decide
producers that build a decision WITHOUT a rationale emitted an explicit
``"reasoning": null`` on the retained per-window analysis:

  * the deterministic **rule-fallback** dict (`decide_with_gemma` on a gemma
    transport/parse failure) has no `reasoning` key at all;
  * a **group verdict** is the model's raw per-candidate dict, so it carries no
    `reasoning` when the model omitted it;
  * an unparseable (prose) gemma reply takes the first path — measured on the
    deployed `f1e7cc3` build, job `22ff6ca2-96c0-4b97-bcb3-d762c14e6b1a` had six
    `decide_audit` rows whose `raw_reply` is prose (no JSON, no `reasoning`), and
    one window lost its WHOLE analysis block:
    `[decide-note:22ff6ca2-…] window analysis rejected: response.reasoning:
    Expected string, received null`.

The server's ``AnalysisResponseSchema.reasoning`` was ``.optional()``, which
accepts an ABSENT key and REJECTS an explicit null, so one field deleted the
whole analysis (prompt, dataItems, frames, response) from the decide note.

These tests pin the seam in BOTH directions:
  * producer: absent / empty / JSON-null `reasoning` adds NO key — in
    `parse_decision`, in `_response_block` (the analysis capture), in the
    rule-fallback decision, and in the `/highlight` wire response;
  * a real rationale is still carried byte-for-byte in all four places;
  * consumer tolerance lives in `packages/events/src/index.ts`
    (`reasoning: z.string().nullish()`), pinned by
    `services/server/test/reasoning-null-window-analysis-8635.test.ts`;
  * `phase` behaviour is unchanged by this change (absent = unknown, AC8): a
    window still emits no phase key at all.
"""
import json

from fastapi.testclient import TestClient

from app import HighlightDecision
from app import app as decide_app
from app.gemma import _response_block, decide_with_gemma, parse_decision

from test_gemma import MockLlama  # plain module import; the tests dir is on sys.path

EV = {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0}

# A prose reply — what the six `decide_audit` rows in job 22ff6ca2 carried. It is
# not JSON, so `parse_decision` returns None and the decide takes the
# deterministic rule-fallback path (the producer that emitted the null).
PROSE_REPLY = (
    "The ball clearly crosses the goal line and enters the net, as seen in the "
    "dense frame sequence and the final keyframe where the net ripples."
)

# A valid compact-rail reply WITH a rationale.
REASONING = "Observed the net ripple before the keeper moved, testing the goal hypothesis."
JSON_WITH_REASONING = json.dumps(
    {
        "isHighlight": False,
        "score": 40,
        "eventType": "BIG_PLAY",
        "outcome": "not_highlight",
        "reason": "ball cleared to the touchline at t=0.4s",
        "reasoning": REASONING,
    }
)

# The same reply with the rationale omitted entirely.
JSON_WITHOUT_REASONING = json.dumps(
    {
        "isHighlight": False,
        "score": 40,
        "eventType": "BIG_PLAY",
        "outcome": "not_highlight",
        "reason": "ball cleared to the touchline at t=0.4s",
    }
)

# ... and with an explicit JSON null (the model's own way of saying "none").
JSON_NULL_REASONING = json.dumps(
    {
        "isHighlight": False,
        "score": 40,
        "eventType": "BIG_PLAY",
        "outcome": "not_highlight",
        "reason": "ball cleared to the touchline at t=0.4s",
        "reasoning": None,
    }
)


# --- the analysis capture (_response_block) -------------------------------


def test_response_block_omits_an_absent_reasoning():
    block = _response_block({"isHighlight": False, "outcome": "not_highlight"})
    assert "reasoning" not in block
    # the sibling optional key `phase` keeps its ADAAAA-8625 behaviour
    assert "phase" not in block


def test_response_block_omits_an_empty_or_null_reasoning():
    assert "reasoning" not in _response_block({"isHighlight": False, "reasoning": ""})
    assert "reasoning" not in _response_block({"isHighlight": False, "reasoning": None})


def test_response_block_still_carries_a_real_reasoning():
    block = _response_block({"isHighlight": False, "reasoning": REASONING, "phase": "replay"})
    assert block["reasoning"] == REASONING
    assert block["phase"] == "replay"


# --- parse_decision -------------------------------------------------------


def test_parse_decision_omits_the_key_when_the_reply_omits_it():
    d = parse_decision(JSON_WITHOUT_REASONING)
    assert d is not None
    assert "reasoning" not in d
    # an explicit JSON null is the same "no rationale"
    d = parse_decision(JSON_NULL_REASONING)
    assert d is not None
    assert "reasoning" not in d


def test_parse_decision_still_carries_a_real_reasoning():
    d = parse_decision(JSON_WITH_REASONING)
    assert d is not None
    assert d["reasoning"] == REASONING


def test_parse_decision_unparseable_prose_still_returns_none():
    # the path that produced the null: prose -> None -> rule fallback
    assert parse_decision(PROSE_REPLY) is None


# --- the rule-fallback producer (the measured cause) ----------------------


def test_rule_fallback_analysis_carries_no_reasoning_key():
    d = decide_with_gemma("KILL", EV, url="http://127.0.0.1:1")
    assert d["source"] == "rule-fallback"
    assert "reasoning" not in d
    resp = d["analysis"]["response"]
    # THIS is the key that used to be an explicit null and deleted the analysis
    assert "reasoning" not in resp
    assert "phase" not in resp
    # the rest of the retained analysis is untouched
    assert resp["outcome"] in ("scoring_play", "near_miss", "big_play", "not_highlight")
    assert isinstance(resp["evidenceAttested"], list)
    assert len(d["analysis"]["dataItems"]) >= 6


# --- the wire: /highlight -------------------------------------------------


def _post(monkeypatch, reply: str):
    mock = MockLlama(reply)
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    try:
        r = TestClient(decide_app).post(
            "/app/highlight",
            json={
                "sessionId": "reasoning-8635",
                "eventType": "BIG_PLAY",
                "timestamp": 12.0,
                "gameHint": "soccer",
                "compact": True,
                "evidence": {"trackCount": 2},
            },
        )
    finally:
        mock.stop()
    return r


def test_highlight_wire_omits_reasoning_on_the_rule_fallback_path(monkeypatch):
    """A prose reply (unparseable) takes the rule fallback; the served body must
    carry NO `reasoning` key, top-level or inside the analysis — an explicit null
    is what the server rejected."""
    r = _post(monkeypatch, PROSE_REPLY)
    assert r.status_code == 200
    body = r.json()
    assert body["source"] == "rule-fallback"
    assert "reasoning" not in body
    assert "reasoning" not in body["analysis"]["response"]
    assert "phase" not in body["analysis"]["response"]


def test_highlight_wire_omits_reasoning_when_the_model_omits_it(monkeypatch):
    r = _post(monkeypatch, JSON_WITHOUT_REASONING)
    assert r.status_code == 200
    body = r.json()
    assert "reasoning" not in body
    assert "reasoning" not in body["analysis"]["response"]


def test_highlight_wire_keeps_a_real_reasoning(monkeypatch):
    r = _post(monkeypatch, JSON_WITH_REASONING)
    assert r.status_code == 200
    body = r.json()
    assert body["reasoning"] == REASONING
    assert body["analysis"]["response"]["reasoning"] == REASONING


# --- the response model ---------------------------------------------------


def test_response_model_declares_reasoning_and_drops_an_empty_one():
    assert "reasoning" in HighlightDecision.model_fields
    assert HighlightDecision(isHighlight=False, reasoning="").model_dump().get("reasoning") is None
    kept = HighlightDecision(isHighlight=False, reasoning=REASONING)
    assert kept.model_dump()["reasoning"] == REASONING
