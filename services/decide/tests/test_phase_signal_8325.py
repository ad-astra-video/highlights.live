"""ADAAAA-8325 (Inc 2) — the decide verdict's footage `phase` signal.

`phase` is ADDITIVE metadata beside `outcome`: this window's footage is live
action or a replay of earlier action. The server uses it only as CORROBORATION
for attaching a replay window to the moment it repeats. These tests pin the
contract the ticket asks for:

  * the model is asked for `phase` in the VOD (full) contract only — the live
    (compact) rail pays nothing;
  * `parse_decision` normalizes it exactly like `outcome` BUT with no default:
    absent or malformed adds NO key (unknown), never `"live"` and never an
    explicit `null` (ADAAAA-8625 — the explicit null dropped every live window
    analysis at the server's `AnalysisResponseSchema`, which only tolerated an
    ABSENT phase);
  * the deterministic CPU fallback returns None instead of guessing;
  * `/highlight` declares the field, so `response_model` (extra="ignore") does
    not silently drop it — the ADAAAA-7221 failure mode;
  * the outcome ladder is untouched: a replay verdict never becomes
    `scoring_play`, and a scoring play keeps its outcome whatever the phase says.
"""
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from fastapi.testclient import TestClient

from app import HighlightDecision
from app import app as decide_app
from app.decider import decide as rule_decide
from app.gemma import (
    PHASE_TAXONOMY,
    _OUTPUT_CONTRACT_COMPACT,
    _OUTPUT_CONTRACT_FULL,
    _response_block,
    _rule_outcome,
    _window_analysis,
    build_prompt,
    decide_with_gemma,
    normalize_phase,
    parse_decision,
)

EV = {"trackCount": 3, "scoreBoardChanged": True, "goalCrossed": True}


class MockLlama:
    """Minimal llama.cpp /v1/chat/completions stand-in (records the request)."""

    def __init__(self, reply: str):
        self.reply = reply
        self.requests: list = []
        self._srv = HTTPServer(("127.0.0.1", 0), self._handler())
        self.port = self._srv.server_address[1]
        self._t = threading.Thread(target=self._srv.serve_forever, daemon=True)
        self._t.start()

    def _handler(self):
        owner = self

        class H(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802
                n = int(self.headers.get("content-length", 0))
                owner.requests.append(json.loads(self.rfile.read(n)))
                resp = json.dumps({"choices": [{"message": {"content": owner.reply}}]})
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(resp.encode())

            def log_message(self, format, *args):  # noqa: A002,D102
                pass

        return H

    def stop(self):
        self._srv.shutdown()


# --- the taxonomy --------------------------------------------------------


def test_phase_taxonomy_is_exactly_live_and_replay():
    assert PHASE_TAXONOMY == ("live", "replay")


def test_normalize_phase_keeps_only_taxonomy_members():
    assert normalize_phase("live") == "live"
    assert normalize_phase("replay") == "replay"
    # model formatting noise is tolerated, like `outcome` is today
    assert normalize_phase("  REPLAY ") == "replay"
    assert normalize_phase("Live") == "live"


def test_normalize_phase_unknown_never_defaults_to_live():
    """An unreadable phase must stay UNKNOWN. Defaulting to `live` would let a
    garbage reply assert live footage the model never observed (AC8)."""
    for garbage in (None, "", "   ", "unknown", "not sure", "replay?", "live!", 1, 0, True, False,
                    ["live"], {"phase": "live"}, "replay_of_goal"):
        assert normalize_phase(garbage) is None, garbage


# --- parse_decision -------------------------------------------------------


def test_parse_decision_carries_a_replay_phase():
    d = parse_decision(
        '{"isHighlight":false,"score":20,"eventType":"BIG_PLAY",'
        '"reason":"replay insert of the goal, ball already in the net",'
        '"outcome":"big_play","phase":"replay"}'
    )
    assert d is not None
    assert d["phase"] == "replay"
    assert d["outcome"] == "big_play"


def test_parse_decision_carries_a_live_phase():
    d = parse_decision(
        '{"isHighlight":true,"score":95,"eventType":"GOAL",'
        '"reason":"ball crosses the line at t=3.2s","outcome":"scoring_play","phase":"live"}'
    )
    assert d["phase"] == "live"
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


def test_parse_decision_absent_phase_is_omitted_not_null():
    """ADAAAA-8625: an UNKNOWN phase adds NO KEY.

    The live compact contract never asks the model for `phase`, so every live
    reply omits it. Stamping an explicit ``None`` put ``"phase": null`` on the
    wire, and the server's ``AnalysisResponseSchema.phase`` (``.optional()``)
    rejected the explicit null — dropping the whole window analysis for every
    live window. Absent = unknown, exactly as before (never an inferred "live").
    """
    d = parse_decision('{"isHighlight":true,"score":88,"eventType":"GOAL","reason":"goal","outcome":"scoring_play"}')
    assert d is not None
    assert "phase" not in d
    # the rest of the contract is untouched by the omission
    assert d["outcome"] == "scoring_play"
    assert d["isHighlight"] is True


def test_parse_decision_malformed_phase_is_dropped_and_does_not_crash():
    for raw in ('"REPLAAY"', '"scoring"', "42", "true", "null", '["live"]', '{"v":"live"}'):
        d = parse_decision(
            '{"isHighlight":false,"score":12,"eventType":"BIG_PLAY",'
            '"reason":"nothing","outcome":"not_highlight","phase":' + raw + "}"
        )
        assert d is not None, raw
        assert "phase" not in d, raw


def test_phase_is_metadata_and_never_moves_the_outcome_ladder():
    """The standing rule stays: a window re-showing a goal is never
    `scoring_play`, and the phase field does not change the ladder either way."""
    replay_of_goal = parse_decision(
        '{"isHighlight":true,"score":99,"eventType":"GOAL",'
        '"reason":"slow-motion repeat of the goal","outcome":"scoring_play","phase":"replay"}'
    )
    # outcome parsing is unchanged by the phase field (the accept gate reads
    # `outcome`): whatever the model claims, a replay window's own outcome is
    # still derived from its frame read.
    assert replay_of_goal["outcome"] == "scoring_play"
    assert replay_of_goal["phase"] == "replay"
    # and the reverse: a live phase cannot promote a non-scoring outcome
    live_but_not_scoring = parse_decision(
        '{"isHighlight":false,"score":30,"eventType":"GOAL",'
        '"reason":"shot wide","outcome":"near_miss","phase":"live"}'
    )
    assert live_but_not_scoring["outcome"] == "near_miss"
    assert live_but_not_scoring["isHighlight"] is False
    assert live_but_not_scoring["phase"] == "live"


# --- the prompt -----------------------------------------------------------


def test_vod_contract_asks_for_the_phase_field():
    assert '"phase": "live|replay"' in _OUTPUT_CONTRACT_FULL
    # the rule is spelled out (footage read, and the never-scoring_play reminder)
    assert "PHASE (the `phase` field)" in _OUTPUT_CONTRACT_FULL
    assert "NEVER `scoring_play` for re-showing a goal" in _OUTPUT_CONTRACT_FULL
    # "omit when the frames cannot tell" is what keeps unknown as unknown
    assert "Omit `phase`" in _OUTPUT_CONTRACT_FULL


def test_live_rail_does_not_ask_for_the_phase_field():
    """The live (compact) rail is decode-bound: it pays no output tokens and no
    prefill for a VOD-only concern."""
    assert '"phase"' not in _OUTPUT_CONTRACT_COMPACT
    assert "PHASE (the `phase` field)" not in _OUTPUT_CONTRACT_COMPACT
    # the full VOD prompt actually renders it (not just the constant)
    assert '"phase": "live|replay"' in build_prompt("GOAL", EV, "soccer", n_frames=8)
    # ... and the compact prompt does not
    assert '"phase"' not in build_prompt("GOAL", EV, "soccer", n_frames=8, compact=True)


# --- the deterministic fallback ------------------------------------------


def test_rule_fallback_returns_none_rather_than_a_guess():
    d = rule_decide(event_type="GOAL", track_count=3, max_velocity=9.0, ocr_hits=1,
                    reaction={"crowdEnergy": 0.9}, score_board_changed=True)
    assert d.phase is None


def test_rule_fallback_dict_omits_an_unknown_phase(monkeypatch):
    """ADAAAA-8625 — the SECOND producer on the same wire is the rule-fallback dict.

    When the model call yields nothing (`ask` returns None) `decide_with_gemma`
    assembles the response from the deterministic rule, which has no footage
    read. That dict must carry NO `phase` key: an explicit ``"phase": None``
    there is the same ``response.phase: null`` shape that made the server drop
    the WHOLE per-window analysis. Fixing only `parse_decision` leaves this path
    non-conformant.
    """
    monkeypatch.setattr("app.gemma.ask", lambda *a, **k: None)
    evidence = {
        "trackCount": 3,
        "maxVelocity": 9.0,
        "ocrHits": 1,
        "reaction": {"crowdEnergy": 0.9},
        "scoreBoardChanged": True,
    }
    d = decide_with_gemma("GOAL", evidence, game_hint="soccer", score_board_changed=True)
    assert d["source"] == "rule-fallback"
    assert "phase" not in d
    assert "phase" not in d["analysis"]["response"]
    # AC3: the omission never moves the ladder — the verdict is the rule's own
    expected = _rule_outcome(
        rule_decide(
            event_type="GOAL",
            track_count=3,
            max_velocity=9.0,
            ocr_hits=1,
            reaction={"crowdEnergy": 0.9},
            score_board_changed=True,
        )
    )
    assert d["outcome"] == expected
    assert d["analysis"]["response"]["outcome"] == expected


def test_response_model_declares_the_phase_field():
    """`/highlight` uses a response_model with extra="ignore": an undeclared
    field is parsed and then DROPPED at the boundary (ADAAAA-7221)."""
    assert "phase" in HighlightDecision.model_fields
    assert HighlightDecision.model_fields["phase"].default is None
    assert HighlightDecision(isHighlight=False).phase is None
    assert HighlightDecision(isHighlight=False, phase="replay").phase == "replay"


# --- the wire: /highlight returns the phase -------------------------------


def _reply(phase_field: str) -> str:
    return (
        '{"isHighlight":false,"score":60,"eventType":"BIG_PLAY",'
        '"reason":"replay insert: ball already in the net at the far post",'
        '"outcome":"big_play","phase":' + phase_field + "}"
    )


def test_highlight_route_returns_the_phase(monkeypatch):
    mock = MockLlama(_reply('"replay"'))
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    try:
        r = TestClient(decide_app).post(
            "/app/highlight",
            json={"sessionId": "phase-1", "eventType": "BIG_PLAY", "timestamp": 207.0,
                  "gameHint": "soccer", "evidence": {"trackCount": 2}},
        )
    finally:
        mock.stop()
    assert r.status_code == 200
    assert r.json()["phase"] == "replay"
    assert r.json()["outcome"] == "big_play"


def test_highlight_route_omits_the_phase_when_unknown(monkeypatch):
    mock = MockLlama(
        '{"isHighlight":true,"score":92,"eventType":"GOAL",'
        '"reason":"ball crosses the line at t=2.4s","outcome":"scoring_play"}'
    )
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    monkeypatch.setenv("DECIDE_MODE", "gemma")
    try:
        r = TestClient(decide_app).post(
            "/app/highlight",
            json={"sessionId": "phase-2", "eventType": "GOAL", "timestamp": 159.0,
                  "gameHint": "soccer", "evidence": {"trackCount": 2}},
        )
    finally:
        mock.stop()
    assert r.status_code == 200
    body = r.json()
    assert body["outcome"] == "scoring_play"
    # ADAAAA-8625: the response model declares `phase`, so pydantic would stamp
    # `"phase": null` here. The model serializer drops it: an unknown phase is
    # ABSENT on the wire, both at the top level and inside the analysis block.
    assert "phase" not in body
    assert "phase" not in body["analysis"]["response"]


def test_response_block_omits_an_unknown_phase_and_keeps_a_known_one():
    """ADAAAA-8625: the analysis capture carries the phase only when it is known.

    The analysis block is a plain dict passed through `/highlight` untouched, so
    this is the field that actually reached the server as ``"phase": null`` and
    dropped every live window analysis.
    """
    unknown_decision = parse_decision(
        '{"isHighlight":false,"score":0,"eventType":"AUDIO_BURST",'
        '"outcome":"not_highlight","reason":"ball in play"}'
    )
    assert unknown_decision is not None
    unknown = _response_block(unknown_decision)
    assert "phase" not in unknown
    # an explicit null in the decision dict is the same UNKNOWN
    assert "phase" not in _response_block({"outcome": "not_highlight", "phase": None})
    # a known phase still rides the capture (VOD/replay parity)
    known_decision = parse_decision(
        '{"isHighlight":false,"score":20,"eventType":"BIG_PLAY",'
        '"outcome":"big_play","reason":"replay insert","phase":"replay"}'
    )
    assert known_decision is not None
    known = _response_block(known_decision)
    assert known["phase"] == "replay"


def _real_live_analysis():
    """The real live-rail window analysis, built from a stored decide_audit row.

    PROBE-FREE: `fixtures/live-reply-8625.json` is the verbatim `raw_reply` of a
    live window on the deployed build (`highlights-live-decide:8603`, job
    `a6d4380e`, `max_tokens=400` = the compact live contract), read out of
    `decide_audit`. No engine call and no hand-shaped model output.
    """
    fixture = json.loads(
        (Path(__file__).parent / "fixtures" / "live-reply-8625.json").read_text()
    )
    raw = fixture["raw_reply"]
    assert "phase" not in raw.lower(), "the live contract must not ask for a phase"
    decision = parse_decision(raw)
    assert decision is not None
    analysis = _window_analysis(
        prompt="live compact prompt (real prompt_text, trimmed)",
        data_items=[],
        frames=[],
        images=[],
        response=_response_block(decision),
    )
    return analysis


def test_real_live_window_analysis_carries_no_phase_key():
    """ADAAAA-8625 acceptance: on a REAL live reply the analysis block has no
    `phase` key at all — the shape the server's AnalysisResponseSchema used to
    reject (`Expected 'live' | 'replay', received null`)."""
    analysis = _real_live_analysis()
    assert "phase" not in analysis["response"]
    # every other captured field survives the omission byte-for-byte
    assert analysis["response"]["outcome"] == "not_highlight"
    assert analysis["response"]["evidenceAttested"] == []
    assert analysis["response"]["source"] == "gemma"
    assert analysis["prompt"].startswith("live compact prompt")


def test_decide_with_gemma_returns_the_phase_to_the_caller():
    mock = MockLlama(_reply('"replay"'))
    try:
        d = decide_with_gemma(
            "BIG_PLAY",
            {"trackCount": 2},
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
        )
    finally:
        mock.stop()
    assert d["phase"] == "replay"
    assert d["outcome"] == "big_play"
