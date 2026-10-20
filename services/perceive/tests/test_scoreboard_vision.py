"""Unit tests for the vision-LLM scoreboard gate / OCR (ADAAAA-7084, design
follow-up to ADAAAA-7081).

The vision-LLM path has two jobs that remove the ADAAAA-7082
calibration-dependent recall of the fixed-ROI approach:

1. **Gate** — assess whether a scoreboard is actually visible in the frame; when
   it answers no, the `<OCR>` pass is skipped so crowd / banner / ad-board text
   can never be read as a score.
2. **Supplying the OCR** — when visible, return a normalized scoreboard box (the
   caller crops `<OCR>` to it) and optionally the score text it read.

Pure functions + an injectable transport are tested here with no GPU and no
network. The false-positive protections are preserved as the FINAL gate (see
test_scoreboard.py): the score still only comes from ``parse_ocr_score`` and a
delta still only from the two-concrete-readings tracker, so a hallucinated
LLM box/score degrades to "no clean score line" and never forges a delta.
"""
from __future__ import annotations

import json
import os

import pytest

from app.scoreboard import parse_ocr_score
from app.scoreboard_vision import (
    ScoreboardVerdict,
    _normalize_box,
    _normalize_score_text,
    _strip_json_fence,
    build_scoreboard_prompt,
    enabled,
    parse_scoreboard_verdict,
    vision_scoreboard,
)


# --- enabled() ---------------------------------------------------------------
def test_enabled_default_off(monkeypatch):
    monkeypatch.delenv("PERCEIVE_SCOREBOARD_LLM", raising=False)
    assert enabled() is False


@pytest.mark.parametrize("val", ["1", "true", "on", "yes", "TRUE", " On "])
def test_enabled_on_variants(monkeypatch, val):
    monkeypatch.setenv("PERCEIVE_SCOREBOARD_LLM", val)
    assert enabled() is True


@pytest.mark.parametrize("val", ["0", "false", "off", "no", "nope"])
def test_enabled_off_variants(monkeypatch, val):
    monkeypatch.setenv("PERCEIVE_SCOREBOARD_LLM", val)
    assert enabled() is False


# --- Prompt ------------------------------------------------------------------
def test_build_prompt_is_json_output_contract():
    prompt = build_scoreboard_prompt()
    assert "scoreboardVisible" in prompt
    assert '"box"' in prompt and '"score"' in prompt
    assert "score" in prompt.lower()


# --- _normalize_box -----------------------------------------------------------
def test_normalize_box_valid():
    assert _normalize_box([0.0, 0.0, 0.5, 0.25]) == (0.0, 0.0, 0.5, 0.25)


@pytest.mark.parametrize(
    "raw",
    [
        None,
        "not a list",
        [0.0, 0.0, 0.5],  # wrong arity
        [0.0, 0.0, 0.5, 0.25, 0.9],  # wrong arity
        ["a", "b", "c", "d"],  # non-numeric
        [0.5, 0.5, 0.2, 0.9],  # x0 > x1
        [0.0, 0.0, 0.0, 0.5],  # degenerate (x0 == x1)
        [0.0, 0.0, 1.1, 0.5],  # out of range
        [-0.1, 0.0, 0.5, 0.5],  # out of range
        [0.0, 0.0, 0.5, 0.5],  # valid but included above for completeness
    ],
)
def test_normalize_box_rejects_invalid(raw):
    if raw == [0.0, 0.0, 0.5, 0.5]:
        return  # valid, covered in test_normalize_box_valid
    assert _normalize_box(raw) is None


# --- _normalize_score_text ---------------------------------------------------
def test_normalize_score_text_keeps_dash_score():
    assert _normalize_score_text("2 - 1") == "2 - 1"


def test_normalize_score_text_none_and_non_string():
    assert _normalize_score_text(None) is None
    # A bare number has no score separator ("N - M") -> not a score -> None.
    assert _normalize_score_text(123) is None
    assert _normalize_score_text(["x"]) is None


def test_normalize_score_text_rejects_non_score_prose():
    # prose / team names only / a bare number are NOT scores -> None, so they
    # can never be mistaken for a score even before parse_ocr_score.
    assert _normalize_score_text("Chelsea vs Arsenal") is None
    assert _normalize_score_text("2") is None
    assert _normalize_score_text("second half") is None


def test_normalize_score_text_rejects_oversize():
    assert _normalize_score_text("2 - 1 " * 20) is None  # > 64 chars


def test_normalize_score_text_keeps_colon_but_parse_rejects_clock():
    # A colon-separated string passes the loose pre-filter but is NOT a score
    # (clock/minute read) — parse_ocr_score (the FINAL gate) must reject it.
    assert _normalize_score_text("90:00") == "90:00"
    assert parse_ocr_score(["90:00"]) is None


# --- parse_scoreboard_verdict ------------------------------------------------
def test_parse_verdict_full():
    v = parse_scoreboard_verdict(
        '{"scoreboardVisible": true, "box": [0.0, 0.1, 0.4, 0.2], "score": "2 - 1"}'
    )
    assert v is not None
    assert v.visible is True
    assert v.box == (0.0, 0.1, 0.4, 0.2)
    assert v.score_text == "2 - 1"


def test_parse_verdict_not_visible():
    v = parse_scoreboard_verdict('{"scoreboardVisible": false, "box": null, "score": null}')
    assert v is not None
    assert v.visible is False
    assert v.box is None
    assert v.score_text is None


def test_parse_verdict_fenced_json():
    v = parse_scoreboard_verdict('```json\n{"scoreboardVisible": true, "box": null, "score": null}\n```')
    assert v is not None and v.visible is True


def test_parse_verdict_with_prose_prefix():
    # The model wrapped its JSON in prose — we must still extract the object.
    v = parse_scoreboard_verdict('Sure! Here you go: {"scoreboardVisible": true, "box": null, "score": null}')
    assert v is not None and v.visible is True


def test_parse_verdict_visible_true_from_string():
    v = parse_scoreboard_verdict('{"scoreboardVisible": "true", "box": null, "score": null}')
    assert v is not None and v.visible is True


def test_parse_verdict_degrades_on_missing_visibility():
    assert parse_scoreboard_verdict('{"box": [0,0,1,1], "score": "2 - 1"}') is None


def test_parse_verdict_non_standard_string_is_not_visible():
    # A visibility string that is not one of true/yes/1 maps to NOT visible
    # (conservative: skip the <OCR> pass rather than risk a false score), but
    # still yields a coherent verdict rather than degrading. The prompt enforces
    # true/false, so this only fires on an off-contract reply.
    v = parse_scoreboard_verdict('{"scoreboardVisible": "maybe", "box": null, "score": null}')
    assert v is not None
    assert v.visible is False


def test_parse_verdict_bad_box_and_score_are_nulled_not_fatal():
    # A JSON object that parses but has a malformed box / score still yields a
    # verdict — bad fields normalize to None (graceful degradation), no raise.
    v = parse_scoreboard_verdict(
        '{"scoreboardVisible": true, "box": [0, 0, 9, 9], "score": "not a score"}'
    )
    assert v is not None
    assert v.visible is True
    assert v.box is None
    assert v.score_text is None


@pytest.mark.parametrize(
    "text",
    ["", None, "not json at all", "[]", '{"foo": 1}', "[1,2,3]"],
)
def test_parse_verdict_degrades_on_bad_input(text):
    assert parse_scoreboard_verdict(text) is None


# --- _strip_json_fence -------------------------------------------------------
def test_strip_json_fence():
    assert _strip_json_fence("```json\n{\"a\": 1}\n```") == '{"a": 1}'
    assert _strip_json_fence("plain") == "plain"
    assert _strip_json_fence("") == ""


# --- vision_scoreboard (injectable transport) --------------------------------
class _FakeResp:
    def __init__(self, payload):
        self.content = json.dumps(payload).encode()

    def read(self):
        return self.content


def _ok_content(payload):
    return {"content": json.dumps(payload).encode()}


def _post_success(url, payload, timeout, **resp_kw):
    calls = []

    def post(url, payload, timeout):
        calls.append((url, payload, timeout))
        return resp_kw.pop("resp", None) or _FakeResp(
            {"choices": [{"message": {"content": json.dumps(payload)} }]}
        )

    return post, calls


def test_vision_scoreboard_returns_verdict_on_success(monkeypatch):
    resp = _FakeResp({"choices": [{"message": {"content": '{"scoreboardVisible": true, "box": [0.0,0.0,0.5,0.25], "score": "3 - 2"}'}}]})
    seen = {}

    def post(url, payload, timeout):
        seen["url"] = url
        seen["timeout"] = timeout
        return resp

    v = vision_scoreboard("aGVsbG8=", url="http://ml:9", post=post)
    assert v is not None
    assert v.visible is True
    assert v.box == (0.0, 0.0, 0.5, 0.25)
    assert v.score_text == "3 - 2"
    assert seen["url"] == "http://ml:9/v1/chat/completions"
    assert seen["timeout"] > 0


def test_vision_scoreboard_sends_no_model_without_gemma_model(monkeypatch):
    monkeypatch.delenv("GEMMA_MODEL", raising=False)
    captured = {}

    def post(url, payload, timeout):
        captured["payload"] = payload
        return _FakeResp({"choices": [{"message": {"content": '{"scoreboardVisible": false}'}}]})

    vision_scoreboard("aGVsbG8=", post=post)
    assert "model" not in captured["payload"]


def test_vision_scoreboard_sends_model_when_set(monkeypatch):
    monkeypatch.setenv("GEMMA_MODEL", "my-visual-model")
    captured = {}

    def post(url, payload, timeout):
        captured["payload"] = payload
        return _FakeResp({"choices": [{"message": {"content": '{"scoreboardVisible": false}'}}]})

    vision_scoreboard("aGVsbG8=", post=post)
    assert captured["payload"]["model"] == "my-visual-model"


def test_vision_scoreboard_degrades_on_transport_exception():
    def boom(url, payload, timeout):
        raise ConnectionError("boom")

    assert vision_scoreboard("aGVsbG8=", post=boom) is None


def test_vision_scoreboard_degrades_on_non_json_reply():
    def post(url, payload, timeout):
        return _FakeResp({"choices": [{"message": {"content": "oops"}}]})

    assert vision_scoreboard("aGVsbG8=", post=post) is None


def test_vision_scoreboard_degrades_on_missing_content():
    def post(url, payload, timeout):
        return _FakeResp({"choices": [{}]})

    assert vision_scoreboard("aGVsbG8=", post=post) is None


def test_vision_scoreboard_empty_image_degrades():
    assert vision_scoreboard("", post=None) is None
    assert vision_scoreboard(None, post=None) is None  # type: ignore[arg-type]


def test_vision_scoreboard_passes_image_and_prompt_to_model(monkeypatch):
    captured = {}

    def post(url, payload, timeout):
        captured["payload"] = payload
        return _FakeResp({"choices": [{"message": {"content": '{"scoreboardVisible": false}'}}]})

    vision_scoreboard("aGVsbG8=", post=post)
    content = captured["payload"]["messages"][0]["content"]
    # first content part = the image, second = the prompt text
    assert content[0]["type"] == "image_url"
    assert content[0]["image_url"]["url"] == "data:image/jpeg;base64,aGVsbG8="
    assert content[1]["type"] == "text"
    assert "scoreboardVisible" in content[1]["text"]


# --- integration glue: _vision_box_roi (app package) -------------------------
def test_vision_box_roi_converts_verdict_box_to_roi(monkeypatch):
    from types import SimpleNamespace

    from app import _vision_box_roi

    state = SimpleNamespace(scoreboard_vision=ScoreboardVerdict(visible=True, box=(0.0, 0.0, 0.5, 0.25)))
    roi = _vision_box_roi(state)
    assert roi is not None
    assert roi.pixel_box(1920, 1080) is not None


def test_vision_box_roi_none_when_no_verdict(monkeypatch):
    from types import SimpleNamespace

    from app import _vision_box_roi

    assert _vision_box_roi(SimpleNamespace(scoreboard_vision=None)) is None
    assert _vision_box_roi(SimpleNamespace()) is None


def test_vision_box_roi_none_when_degenerate_box(monkeypatch):
    from types import SimpleNamespace

    from app import _vision_box_roi

    # A box the ROI sanity check rejects -> None so the caller falls back to the
    # configured ROI.
    state = SimpleNamespace(scoreboard_vision=ScoreboardVerdict(visible=True, box=(0.0, 0.0, 0.0, 0.1)))
    assert _vision_box_roi(state) is None
