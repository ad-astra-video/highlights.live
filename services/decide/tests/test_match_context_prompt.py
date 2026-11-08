"""ADAAAA-7856: match-context prompt injection (Stage 6-7 of ADAAAA-7849).

Locks the four things the parent spec grades:

* AC6 no-op — with no ``matchContext`` the prompt is BYTE-IDENTICAL to the
  pre-feature text (pinned sha256 captured from the code before this change),
  so live/older jobs cannot regress.
* the MATCH CONTEXT block renders teams + kit colours (sport-aware) and the
  anti-fabrication rule appears in BOTH the verdict prompt and the
  running-summary instruction;
* a malformed ``matchContext`` never 422s the request (constraint 4);
* no extra inference call per window — a decide with context still makes
  EXACTLY one model call.
"""

import hashlib
import json

import pytest
from fastapi.testclient import TestClient

from app import create_app
from app.gemma import (
    build_group_prompt,
    build_prompt,
    decide_with_gemma,
    title_with_gemma,
    _build_data_items,
)
from app.match_context_prompt import (
    MAX_BLOCK_CHARS,
    match_context_rule,
    render_match_context_block,
    sanitize_match_context,
)
from app.team_attribution_scan import scan_texts

from test_gemma import MockLlama

# --- fixture shared with the pinned no-op hashes -----------------------------

EV = {
    "trackCount": 2,
    "maxVelocity": 0.42,
    "ocrHits": 1,
    "scoreBoardChanged": True,
    "ballOutcome": "goal",
    "goalCrossed": True,
    "reaction": {"crowdEnergy": 0.8, "humansInMotion": 3},
    "detections": [{"label": "person", "bbox": [0.1, 0.2, 0.3, 0.4], "confidence": 0.9, "trackId": "t1"}],
    "audioLevels": [0.1, 0.5, 0.9],
}

SCRATCH = "Portugal press high and Spain sit deep."
STORY = "0-0, Portugal dominating the left channel."

#: sha256 of build_prompt(...) computed from the code BEFORE this change
#: (branch feat/adaaa-7855-match-context @ 02e8e93). Any drift is a regression.
#: `True` (the compact live contract) was re-pinned for ADAAAA-7935, which
#: intentionally rewrote the fast-rail `runningSummary` instruction into the
#: play-by-play caption; the no-op property this test guards is unchanged, and
#: the FULL (`False`) hash still matches the pre-feature value byte-for-byte.
#: The compact pin moved once more in the same issue when the copyable quiet-window
#: example caption was replaced by a no-repeat clause (the model copied the example
#: verbatim on 59 of 67 live rows), then by ADAAAA-7949 contract v2 (window-only
#: caption, blunt quiet line, colour as its own channel); FULL stayed
#: byte-identical through all three edits and still pins e12f4d6f (AC8).
# ADAAAA-8103 (v3 emphasis) re-pinned these: the static preamble moved by
# +2385 chars, the absent-match-context invariant itself is unchanged (the
# block still renders nothing — see test_absent_match_context_adds_no_tokens).
#: ADAAAA-8318 re-pinned ONLY `True` (compact): the fast rail gained the
#: `postTitle` output field (+145 chars).
#: ADAAAA-8325 (Inc 2) re-pins ONLY `False` (VOD/full): the phase field + rule
#: (+411 chars). The two rows move independently, which is the live-rail parity
#: proof in both directions.
GOLDEN_PROMPT_SHA = {
    False: "642b3b36ff994d4700be18392555270a93b8a965b65cae9c38e635e301f71133",
    True: "936532411d2453b2e97c1839c582b207531523cfcaee35480c62c11a0c6b685b",
}

PORTUGAL_SPAIN = {
    "sport": "soccer",
    "ambiguous": False,
    "teams": [
        {
            "name": "Portugal",
            "side": "home",
            "kitColors": [{"primary": "red", "secondary": "green"}],
            "confidence": 0.95,
            "evidence": [{"source": "scorebug_ocr", "snippet": "POR 0 - 0 ESP"}],
        },
        {
            "name": "Spain",
            "side": "away",
            "kitColors": [{"primary": "white", "secondary": "navy"}],
            "confidence": 0.95,
            "evidence": [{"source": "asr", "snippet": "Spain in the white shirts"}],
        },
    ],
}


def _prompt(compact: bool, match_context=None) -> str:
    return build_prompt(
        "GOAL",
        EV,
        "soccer",
        n_frames=6,
        has_audio=True,
        transcript=SCRATCH,
        story_so_far=STORY,
        compact=compact,
        match_context=match_context,
    )


# --- AC6: absent context is a strict no-op -----------------------------------


@pytest.mark.parametrize("compact", [False, True])
def test_absent_match_context_prompt_is_byte_identical(compact):
    """AC6: prompt bytes equal the pre-change prompt (pinned hash)."""
    p = _prompt(compact)
    assert hashlib.sha256(p.encode()).hexdigest() == GOLDEN_PROMPT_SHA[compact]


@pytest.mark.parametrize("compact", [False, True])
def test_absent_match_context_adds_no_tokens(compact):
    assert "MATCH CONTEXT" not in _prompt(compact)


@pytest.mark.parametrize(
    "unusable",
    [
        None,
        {},
        {"teams": []},
        {"teams": [{"name": "unknown", "side": "home", "confidence": 0.0}]},
        {"teams": "Portugal vs Spain"},  # wrong type
        {"teams": [None, 42, {"name": ""}]},
        {"sport": 42, "teams": []},
    ],
)
def test_unusable_match_context_renders_empty(unusable):
    """A malformed/unusable context must render nothing, never raise."""
    assert render_match_context_block(unusable) == ""
    assert _prompt(False, unusable) == _prompt(False)


def test_unknown_fields_are_dropped():
    ctx = sanitize_match_context(
        {
            "sport": "Soccer",
            "resolverVersion": 1,
            "trail": [{"progressPct": 0}],
            "teams": [{"name": "Portugal", "side": "home", "junk": [1, 2], "confidence": 1.7}],
        }
    )
    assert ctx == {
        "sport": "soccer",
        "teams": [{"name": "Portugal", "side": "home", "kitColors": [], "confidence": 1.0}],
        "ambiguous": False,
    }


# --- the rendered block ------------------------------------------------------


def test_block_names_teams_and_kit_colours():
    block = render_match_context_block(PORTUGAL_SPAIN)
    assert block.startswith("MATCH CONTEXT (inferred, authoritative for naming):")
    assert "home: Portugal — red shirts, green trim" in block
    assert "away: Spain — white shirts, navy trim" in block
    assert "Rule: name only the teams above." in block
    assert 'say "the defender"' in block


def test_block_is_bounded_for_prompt_budget():
    block = render_match_context_block(PORTUGAL_SPAIN)
    # ~67 tokens at 4 chars/token for the block itself.
    assert len(block) <= MAX_BLOCK_CHARS
    # Whole-window delta (block + the rule line appended to the output contract):
    # measured 520 chars (~130 tokens) on the cited job's context. The bound keeps
    # a future edit from inflating the per-window prompt (no extra GPU call is
    # added either way — asserted by the one-call test below).
    delta = len(_prompt(False, PORTUGAL_SPAIN)) - len(_prompt(False))
    assert delta <= 620, f"per-window prompt delta grew to {delta} chars"


def test_block_is_sport_aware_for_esports():
    ctx = {
        "sport": "valorant",
        "teams": [
            {"name": "Sentinels", "side": "home", "kitColors": [{"primary": "red"}]},
            {"name": "Fnatic", "side": "away", "kitColors": [{"primary": "orange", "secondary": "black"}]},
        ],
    }
    block = render_match_context_block(ctx)
    assert "red agent/side colours" in block
    assert "shirts" not in block
    assert 'say "the player"' in block
    assert "nationality from kit/agent colour, org logo" in block


def test_ambiguous_context_is_flagged_not_guessed():
    ctx = dict(PORTUGAL_SPAIN, ambiguous=True)
    assert "side assignment is ambiguous" in render_match_context_block(ctx)


def test_rule_is_in_both_the_verdict_prompt_and_the_summary_instruction():
    p = _prompt(False, PORTUGAL_SPAIN)
    assert "MATCH CONTEXT (inferred, authoritative for naming):" in p
    assert match_context_rule("soccer") in p
    # the running-summary instruction is in the output contract; the rule line
    # names it explicitly so the narrative cannot invent a team either.
    assert "also governs runningSummary" in p


def test_group_prompt_also_carries_the_block():
    cands = [{"eventType": "GOAL", "timestamp": 12.0, "evidence": EV}]
    with_ctx = build_group_prompt(cands, "soccer", n_frames=3, match_context=PORTUGAL_SPAIN)
    without = build_group_prompt(cands, "soccer", n_frames=3)
    assert "home: Portugal — red shirts, green trim" in with_ctx
    assert "MATCH CONTEXT" not in without


def test_data_items_include_the_block_for_the_window_ui():
    items = _build_data_items("GOAL", EV, "soccer", story_so_far=STORY, match_context=PORTUGAL_SPAIN)
    mc = [i for i in items if i["type"] == "match_context"]
    assert len(mc) == 1
    assert "Portugal" in mc[0]["value"]
    plain = _build_data_items("GOAL", EV, "soccer", story_so_far=STORY)
    assert [i for i in plain if i["type"] == "match_context"] == []


# --- request contract: additive, never a 422 ---------------------------------


def _client():
    return TestClient(create_app())


def test_highlight_request_accepts_and_ignores_match_context_in_rule_mode():
    r = _client().post(
        "/highlight",
        json={
            "sessionId": "s1",
            "eventType": "GOAL",
            "timestamp": 12.0,
            "gameHint": "soccer",
            "matchContext": PORTUGAL_SPAIN,
            "evidence": EV,
        },
    )
    assert r.status_code == 200
    assert "isHighlight" in r.json()


@pytest.mark.parametrize(
    "bad",
    [
        "Portugal vs Spain",
        [],
        {"teams": "not-a-list"},
        {"teams": [{"name": 42}]},
        {"sport": None, "teams": [{"name": "Portugal", "kitColors": "red"}]},
    ],
)
def test_malformed_match_context_never_422s(bad):
    """Constraint 4: validate/drop unknown fields, never hard-fail the window."""
    r = _client().post(
        "/highlight",
        json={
            "sessionId": "s1",
            "eventType": "GOAL",
            "timestamp": 12.0,
            "gameHint": "soccer",
            "matchContext": bad,
            "evidence": EV,
        },
    )
    assert r.status_code == 200, r.text


def test_existing_request_without_match_context_still_works():
    r = _client().post(
        "/highlight",
        json={"sessionId": "s1", "eventType": "GOAL", "timestamp": 12.0, "evidence": EV},
    )
    assert r.status_code == 200


def test_title_request_accepts_match_context_and_stays_200():
    r = _client().post(
        "/title",
        json={
            "gameHint": "soccer",
            "eventTypes": ["GOAL"],
            "reasons": ["a goal"],
            "highlightCount": 1,
            "matchContext": PORTUGAL_SPAIN,
        },
    )
    assert r.status_code == 200
    assert r.json()["title"]


# --- no extra inference call per window --------------------------------------


def test_decide_with_context_makes_exactly_one_model_call():
    mock = MockLlama('{"isHighlight":true,"score":80,"eventType":"GOAL","reason":"Portugal score","outcome":"scoring_play"}')
    try:
        decide_with_gemma(
            "GOAL",
            EV,
            "soccer",
            frames=[{"role": "full", "base64": ""}],
            url=f"http://127.0.0.1:{mock.port}",
            match_context=PORTUGAL_SPAIN,
        )
    finally:
        mock.stop()
    assert len(mock.requests) == 1, "match context must never add an inference call"
    text = [c for c in mock.requests[0]["messages"][-1]["content"] if c.get("type") == "text"][0]["text"]
    assert "MATCH CONTEXT (inferred, authoritative for naming):" in text
    assert "home: Portugal — red shirts, green trim" in text


def test_title_prompt_carries_the_block_with_one_call():
    mock = MockLlama("Portugal 1-0 Spain")
    try:
        t = title_with_gemma(
            game_hint="soccer",
            event_types=["GOAL"],
            reasons=["Portugal score from the left"],
            highlight_count=1,
            url=f"http://127.0.0.1:{mock.port}",
            match_context=PORTUGAL_SPAIN,
        )
    finally:
        mock.stop()
    assert t == "Portugal 1-0 Spain"
    assert len(mock.requests) == 1
    prompt = mock.requests[0]["messages"][0]["content"]
    assert "home: Portugal — red shirts, green trim" in prompt
    assert "name only the teams above" in prompt


# --- AC2 scripted scan helper ------------------------------------------------


def test_scan_flags_the_german_defender_class_of_error():
    hits = scan_texts(
        ["The German defender steps up and clears the ball."],
        PORTUGAL_SPAIN,
    )
    assert len(hits) == 1
    assert hits[0]["token"].lower() == "german"
    assert hits[0]["team"] == "Germany"


def test_scan_passes_texts_that_only_name_context_teams():
    texts = [
        "Portugal win it back and Spain drop into a low block.",
        "The Portuguese defender clears; the Spanish keeper restarts.",
        "Portugal — red shirts — break down the left.",
    ]
    assert scan_texts(texts, PORTUGAL_SPAIN) == []


def test_scan_flags_an_unrelated_team_name():
    hits = scan_texts(["Real Madrid's coach is watching from the stands."], PORTUGAL_SPAIN)
    assert [h["team"] for h in hits] == ["Real Madrid"]


def test_scan_is_empty_when_the_context_names_nobody():
    # No stored context: nothing can be attributed, so every team word is a hit
    # (that is exactly the "invented a nationality" failure) — but the scan must
    # still run and never raise.
    hits = scan_texts(["the German defender"], None)
    assert len(hits) == 1


def test_scan_helper_cli_shape():
    """The scan is also a CLI so a board replay can run it on stored text."""
    from app.team_attribution_scan import main

    import tempfile

    with tempfile.TemporaryDirectory() as d:
        ctx_path = f"{d}/ctx.json"
        txt_path = f"{d}/texts.json"
        with open(ctx_path, "w", encoding="utf-8") as fh:
            json.dump(PORTUGAL_SPAIN, fh)
        with open(txt_path, "w", encoding="utf-8") as fh:
            json.dump(["Portugal attack", "the German defender clears"], fh)
        out_path = f"{d}/report.json"
        rc = main(["--match-context", ctx_path, "--text", txt_path, "--out", out_path])
        assert rc == 1
        with open(out_path, "r", encoding="utf-8") as fh:
            report = json.load(fh)
        assert report["hitCount"] == 1
        assert report["teamsInContext"] == ["Portugal", "Spain"]
