"""ADAAAA-7938 (Spec A): the PRIOR GAME STATE block on the VOD decide prompt.

Three properties are pinned here, and none of them is a prose claim:

- AC-A2 (no-op): with no prior-game-state payload the prompt is BYTE-IDENTICAL
  to the pre-change prompt. The golden sha256 values below were captured from
  the pre-change `build_prompt` on the deployed decide build (f9a1a29,
  `services/decide/app/gemma.py` sha256 cb639f47…), on a fixed evidence dict.
- AC-A3 (cost bound): the WHOLE rendered block is <= 600 chars and the
  whole-prompt delta is <= 620 chars, asserted so a later edit cannot silently
  inflate every VOD window.
- The block actually names what the model cannot see (prior ASR + score
  transition), and it only claims "needsNewScore" inside the deterministic
  ADAAAA-7865 reach.
"""
import hashlib
import json

from fastapi.testclient import TestClient

from app.gemma import (
    PRIOR_GAME_STATE_MAX_CHARS,
    PRIOR_REPEAT_REACH_S,
    build_prompt,
    decide_with_gemma,
    render_prior_game_state_block,
)

EV = {"trackCount": 3, "maxVelocity": 0.5, "ocrHits": 16, "scoreBoardChanged": False}
STORY = "Goal at 42s: Ronaldo finishes low to make it 1-0 Portugal."

#: COMPACT (`compact=True`) pins move whenever the fast-rail runningSummary
#: contract changes: ADAAAA-7935 rewrote that instruction into the bounded
#: play-by-play caption (and later replaced its copyable quiet-window example
#: with a no-repeat clause), and ADAAAA-7949 rewrote it again for contract v2
#: (window-only caption, blunt quiet line, colour as its own channel). The
#: no-op property -- FULL prompts stay byte-identical to the
#: pre-change build -- is what this test guards, and it holds for both FULL rows.
#: Captured from the PRE-CHANGE build_prompt (no prior_game_state argument
#: existed). If any of these move, the no-op guarantee is broken.
# ADAAAA-8103 (v3 emphasis) re-pinned these: only the STATIC block moved
# (+2385 preamble chars). The block-absent invariant is unchanged — an empty or
# malformed prior game state still renders nothing (see the degrade test below).
GOLDEN = {
    ("full", ""): (12034, "462ff1861c902722391ab48f592ba39e86343992cfbecbb43e3ce0c3c8793409"),
    ("full", STORY): (12286, "fceba52d260de7e1ac2540d8721903d88ae7026cc5b1a1f6f9ccc68c27e642ab"),
    # ADAAAA-8318 re-pinned the two COMPACT rows (+145 chars: the `postTitle`
    # field). Both FULL rows above are untouched pre-change bytes (AC8).
    ("compact", ""): (14396, "a9abe8a55aa8cbf48447073c49b7d131e4a7fb190c8471cc91e56c92ac1c49ea"),
    ("compact", STORY): (14648, "feb868075998c61158d831fb1e3a5c88d098006a5ef6a24c551a0037d2f4fc33"),
}


def _prompt(compact=False, story="", prior=None):
    kw = {} if prior is None else {"prior_game_state": prior}
    return build_prompt(
        "SPORTING_EVENT",
        EV,
        "soccer",
        n_frames=16,
        has_audio=True,
        transcript="just had to be him.",
        story_so_far=story,
        compact=compact,
        **kw,
    )


def test_prompt_is_byte_identical_without_prior_game_state():
    for (flavour, story), (expected_len, expected_sha) in GOLDEN.items():
        p = _prompt(compact=flavour == "compact", story=story)
        assert len(p) == expected_len, (flavour, story)
        assert hashlib.sha256(p.encode()).hexdigest() == expected_sha, (flavour, story)


def test_empty_or_malformed_prior_game_state_degrades_to_the_golden_prompt():
    golden = _prompt(compact=False, story=STORY)
    sha = hashlib.sha256(golden.encode()).hexdigest()
    for bad in (
        {},
        {"story": "", "priorAsr": "", "score": None, "needsNewScore": False},
        "not-an-object",
        42,
        [1, 2, 3],
        {"story": 12, "priorAsr": ["x"], "score": {}, "lastScoreTs": "nan"},
        {"story": "   ", "priorAsr": "\n\t", "needsNewScore": "yes"},
    ):
        assert hashlib.sha256(_prompt(compact=False, story=STORY, prior=bad).encode()).hexdigest() == sha


def test_block_names_the_prior_goal_so_a_celebration_window_is_not_a_second_goal():
    block = render_prior_game_state_block(
        {
            "story": STORY,
            "priorAsr": "Ronaldo wheels away... it's 1-0 Portugal.",
            "score": "1-0",
            "lastScoreTs": 42.4,
            "needsNewScore": True,
            "sinceLastScoreS": 5.6,
        }
    )
    assert "PRIOR GAME STATE" in block
    assert "story so far" in block
    assert "it's 1-0 Portugal" in block
    assert "score 1-0" in block
    assert "needsNewScore=true" in block
    assert "outcome=big_play, never scoring_play" in block
    # the measured-evidence wording the guardrail requires (no model prose)
    assert "MEASURED score change" in block


def test_block_is_bounded_even_with_long_inputs():
    huge = ("Portugal press high and Spain counter down the left flank. " * 40).strip()
    block = render_prior_game_state_block(
        {"story": huge, "priorAsr": huge, "score": "2-1", "lastScoreTs": 88.0, "needsNewScore": True}
    )
    assert block
    assert len(block) <= PRIOR_GAME_STATE_MAX_CHARS
    assert "needsNewScore=true" in block  # the decisive line survives the shrink


def test_whole_prompt_delta_stays_inside_the_token_budget():
    base = _prompt(compact=False, story=STORY)
    huge = ("Portugal press high and Spain counter down the left flank. " * 40).strip()
    with_block = _prompt(
        compact=False,
        story=STORY,
        prior={"story": huge, "priorAsr": huge, "score": "1-0", "lastScoreTs": 42.4, "needsNewScore": True},
    )
    delta = len(with_block) - len(base)
    assert 0 < delta <= 620, delta


def test_needs_new_score_claim_does_not_reach_a_later_distinct_goal():
    # Outside the ADAAAA-7865 reach the prompt must NOT tell the model a goal is
    # impossible: a second real goal 20 s later keeps its scoring chance.
    far = render_prior_game_state_block(
        {"score": "1-0", "lastScoreTs": 42.4, "needsNewScore": True, "sinceLastScoreS": PRIOR_REPEAT_REACH_S + 20}
    )
    assert "needsNewScore=true" not in far
    assert "score: 1-0" in far
    near = render_prior_game_state_block(
        {"score": "1-0", "lastScoreTs": 42.4, "needsNewScore": True, "sinceLastScoreS": PRIOR_REPEAT_REACH_S}
    )
    assert "needsNewScore=true" in near


def test_score_only_block_needs_no_story():
    block = render_prior_game_state_block({"score": "1-0", "lastScoreTs": 42.4, "needsNewScore": False})
    assert block and "story so far" not in block and "score: 1-0" in block


def test_decide_forwards_prior_game_state_into_the_model_request():
    from test_gemma import MockLlama

    mock = MockLlama('{"isHighlight":false,"score":20,"eventType":"SPORTING_EVENT","reason":"celebration only"}')
    prior = {
        "story": STORY,
        "priorAsr": "it's 1-0 Portugal",
        "score": "1-0",
        "lastScoreTs": 42.4,
        "needsNewScore": True,
        "sinceLastScoreS": 5.6,
    }
    try:
        decide_with_gemma(
            "SPORTING_EVENT",
            EV,
            game_hint="soccer",
            url=f"http://127.0.0.1:{mock.port}",
            prior_game_state=prior,
        )
    finally:
        mock.stop()
    assert len(mock.requests) == 1  # no extra inference for the block
    text_content = [c for c in mock.requests[0]["messages"][-1]["content"] if c.get("type") == "text"]
    prompt = text_content[0]["text"]
    assert "PRIOR GAME STATE" in prompt
    assert "it's 1-0 Portugal" in prompt
    assert "needsNewScore=true" in prompt


def test_highlight_route_accepts_a_malformed_prior_game_state(monkeypatch):
    # A shaped-but-wrong payload must degrade to "no block", never a 422 that
    # drops the window.
    from app import app

    monkeypatch.setenv("DECIDE_MODE", "gemma")
    c = TestClient(app)
    bodies = [
        {"story": ["not", "a", "string"]},
        {"score": 5, "lastScoreTs": "x"},
        {"teams": "POR-ESP", "name": 1},
        {"needsNewScore": "true"},
        [1, 2, 3],
        "string",
        7,
    ]
    for prior in bodies:
        r = c.post(
            "/app/highlight",
            json={
                "sessionId": "s1",
                "eventType": "KILL",
                "timestamp": 1.0,
                "gameHint": "valorant",
                "evidence": {"trackCount": 2, "maxVelocity": 0.4, "ocrHits": 0},
                "priorGameState": prior,
            },
        )
        assert r.status_code == 200, (prior, r.status_code, r.text[:200])
        assert "isHighlight" in r.json()


def test_audit_carries_the_block_as_its_own_data_item():
    from test_gemma import MockLlama

    mock = MockLlama(json.dumps({"isHighlight": False, "score": 10, "eventType": "NONE", "reason": "lull"}))
    try:
        d = decide_with_gemma(
            "SPORTING_EVENT",
            EV,
            game_hint="soccer",
            url=f"http://127.0.0.1:{mock.port}",
            prior_game_state={"story": STORY, "score": "1-0", "lastScoreTs": 42.4, "needsNewScore": True},
        )
    finally:
        mock.stop()
    labels = [i["label"] for i in d["analysis"]["dataItems"]]
    assert "Prior game state (from earlier windows)" in labels
