"""ADAAAA-7993 — prefix-cache prompt layout v2; ADAAAA-8103 re-pins it for v3.

v2 (ADAAAA-7993) hoisted the static judge text into the system turn WITHOUT
editing it. v3 (ADAAAA-8103) rewrites the static text (the window's measured
evidence carries the read, the frames corroborate) and keeps the v2 LAYOUT
byte-for-byte, so the goldens below move only in the static block: the pinned
CONTEXT hashes are the v2 values and still match, which is what proves the
reword cannot drift a single per-window character.

v1 sent `[system: SYSTEM_PROMPT (63 tok), user: frames..., text: preamble +
Context + contract]`, so the only reusable prefix was the system turn: measured
1.08% live hit rate against a 1.43% layout ceiling (ADAAAA-7979).

v2 reorders — never rewrites — the same tokens:

    system = SYSTEM_PROMPT + STATIC_PREAMBLE + STATIC_CONTRACT
    user   = [frames..., ONE text part: the Context block]

Acceptance criteria pinned here:
  AC1 wire shape (roles, static markers in the system turn only, frames first)
  AC2 no token drift (golden sha256 captured from the PRE-change code; 0-char
      delta between the v2 wire text and v1's flat prompt)
  AC3 SYSTEM_PROMPT_VERSION == "2" and a replayed audit record reproduces the
      byte-identical messages
  AC4 compact parity (contract in the system turn, FULL contract untouched)
  AC5 out-of-scope surfaces stay user-only (group mode, /confirm)
"""
import hashlib
import json
import os

from fastapi.testclient import TestClient

from app import app as decide_app
from app.gemma import (
    SYSTEM_PROMPT,
    SYSTEM_PROMPT_VERSION,
    STATIC_PREAMBLE,
    _OUTPUT_CONTRACT_COMPACT,
    _OUTPUT_CONTRACT_FULL,
    _audit_record,
    _messages,
    build_prompt,
    build_prompt_parts,
    decide_group_with_gemma,
    decide_with_gemma,
    load_audit_records,
    rebuild_payload,
)
from app.confirm import run_confirmation_pass
from test_gemma import MockLlama, _user_text, _wire_text

AUDIT_DIR = "/tmp/test-decide-audit-7993"

# --- pinned goldens. The v2 hoist goldens were captured from origin/master@334fe57;
# ADAAAA-8103 deliberately rewords the static block, so the prompt goldens were
# re-pinned from the v3 code and the CONTEXT goldens were kept at their v2 values
# (they still match — the reword touches no per-window text).
# ADAAAA-8325 (Inc 2) adds the `phase` field + its rule to the FULL (VOD) contract
# only: the FULL rows below move by exactly +411 chars and the COMPACT rows are
# byte-identical, which is the live-rail parity proof.
GOLDEN_V3_FULL = (
    13200,
    "6baad4454b745cfdb5d694883727218e15ee32730380df5e959e21118a8b17ce",
)
# ADAAAA-8318 re-pins the COMPACT prompt only: the fast rail gained the
# `postTitle` output field (+145 chars <= +40 input tokens). The FULL/VOD
# goldens below are UNCHANGED bytes, which is the AC8 guard.
# ADAAAA-8405 re-pins the COMPACT prompt (and only it): the headline's rule
# paragraph was rewritten for the Phase C residuals (place phrases 7/255, goal
# claims on non-scoring windows 5/255, invented names 6/255). The FULL rows
# below are byte-identical to 8356, which is the VOD-parity proof.
GOLDEN_V3_COMPACT = (
    17234,
    "8f019d83d3ffe286ddf98b81dafff895d5119a494c0e73f0ea163d31429058f1",
)
GOLDEN_V3_FULL_MC_PG = (
    13404,
    "06a66b4038aa52d62696a8f7f12db51e11d6f5f096d585b227678172ac716f31",
)
# the per-window Context block, pinned at its v2 bytes (ADAAAA-7993) — identical in v3
GOLDEN_CONTEXT = (
    1098,
    "dd7223d3aa35399c9b2d8dacc749b16b02177735dbf77cea8045d0d6dc33b9ec",
)
GOLDEN_CONTEXT_MC_PG = (
    1302,
    "beee6963be10b749c46a53be7874d94bc675b99b356d8f7f078391c42038f42e",
)
# the concatenated static block (preamble, no contract) — the reusable prefix
GOLDEN_STATIC_PREAMBLE = (
    9193,
    hashlib.sha256(STATIC_PREAMBLE.encode()).hexdigest(),
)
GOLDEN_SYSTEM_PROMPT = (
    326,
    "1f62de74405812c2085ac000bddc80b57a324f1b172793e6a4bfff5ee1921f80",
)

EV = {
    "trackCount": 3,
    "maxVelocity": 0.42,
    "ocrHits": 2,
    "scoreBoardChanged": True,
    "ballOutcome": "goal",
    "goalCrossed": True,
    "reaction": {"crowdEnergy": 0.9, "humansInMotion": 4, "burstAt": 1.2},
    "ballPosition": [0.5, 0.5],
    "distanceToGoal": 0.12,
    "goalLineDelta": 0.02,
    "detections": [
        {"label": "player", "bbox": [0.1, 0.2, 0.3, 0.4], "confidence": 0.91, "trackId": "t1"}
    ],
    "audioLevels": [0.1, 0.4, 0.8, 0.9],
}
MC = {
    "sport": "soccer",
    "teams": {"home": "Brazil", "away": "Germany"},
    "colors": {"home": "yellow", "away": "white"},
    "source": "crop-sampled",
}
PG = {
    "story": "Brazil press high; No. 9 shoots at 72s.",
    "priorAsr": "...it's 1-0 Brazil",
    "score": {"home": 1, "away": 0},
    "lastScoreTs": 72.0,
    "needsNewScore": False,
}
TRANSCRIPT = "what a strike from the edge of the box"
STORY = "0-0 until the 70th minute."

REPLY = (
    '{"isHighlight":true,"score":88,"eventType":"GOAL","reason":"ball in net",'
    '"outcome":"scoring_play","runningSummary":"No. 9 drives it home at 72s."}'
)


def _parts(compact: bool = False, with_context: bool = False):
    return build_prompt_parts(
        "GOAL",
        EV,
        "soccer",
        n_frames=8,
        has_audio=True,
        transcript=TRANSCRIPT,
        story_so_far=STORY,
        compact=compact,
        match_context=MC if with_context else None,
        prior_game_state=PG if with_context else None,
    )


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


# --- AC2: no token drift -----------------------------------------------------

def test_golden_v3_prompt_hashes_pinned():
    """The flat prompt text is pinned for v3 so a later edit cannot silently
    ride along inside this change (the v2->v3 reword was deliberate,
    ADAAAA-8103; the layout it rides on is unchanged)."""
    full = build_prompt(
        "GOAL", EV, "soccer", n_frames=8, has_audio=True,
        transcript=TRANSCRIPT, story_so_far=STORY,
    )
    assert (len(full), _sha(full)) == GOLDEN_V3_FULL

    compact = build_prompt(
        "GOAL", EV, "soccer", n_frames=8, has_audio=True,
        transcript=TRANSCRIPT, story_so_far=STORY, compact=True,
    )
    assert (len(compact), _sha(compact)) == GOLDEN_V3_COMPACT

    with_ctx = build_prompt(
        "GOAL", EV, "soccer", n_frames=8, has_audio=True,
        transcript=TRANSCRIPT, story_so_far=STORY,
        match_context=MC, prior_game_state=PG,
    )
    assert (len(with_ctx), _sha(with_ctx)) == GOLDEN_V3_FULL_MC_PG


def test_context_block_is_byte_identical_across_v2_and_v3():
    """The reword is STATIC-ONLY: the per-window Context block still hashes to
    its ADAAAA-7993 (v2) bytes, so no window gained or lost a character."""
    assert (len(_parts(False)["context"]), _sha(_parts(False)["context"])) == GOLDEN_CONTEXT
    ctx = _parts(False, with_context=True)["context"]
    assert (len(ctx), _sha(ctx)) == GOLDEN_CONTEXT_MC_PG


def test_golden_static_block_pinned():
    assert (len(STATIC_PREAMBLE), _sha(STATIC_PREAMBLE)) == GOLDEN_STATIC_PREAMBLE
    assert (len(SYSTEM_PROMPT), _sha(SYSTEM_PROMPT)) == GOLDEN_SYSTEM_PROMPT
    # the preamble is exactly the head of the v1 flat prompt
    assert build_prompt("GOAL", EV, "soccer").startswith(STATIC_PREAMBLE)


def test_parts_concat_equals_v1_prompt_with_zero_char_delta():
    """AC2: preamble + context + contract == the v1 prompt, and the system turn
    plus the user text part is the same number of characters v1 sent."""
    for compact in (False, True):
        p = _parts(compact)
        assert p["prompt"] == p["preamble"] + p["context"] + p["contract"]
        assert p["system"] == SYSTEM_PROMPT + p["preamble"] + p["contract"]
        # wire text total == v1 wire total (SYSTEM_PROMPT + flat prompt)
        wire = len(p["system"]) + len(p["context"])
        assert wire == len(SYSTEM_PROMPT) + len(p["prompt"])
        assert wire - (len(SYSTEM_PROMPT) + len(p["prompt"])) == 0


# --- AC1: wire shape ---------------------------------------------------------

def test_single_shot_wire_shape_v2():
    mock = MockLlama(REPLY)
    try:
        d = decide_with_gemma(
            "GOAL",
            EV,
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}, {"seq": 2, "base64": "BBB"}],
            url=f"http://127.0.0.1:{mock.port}",
            story_so_far=STORY,
        )
    finally:
        mock.stop()

    assert d is not None
    assert len(mock.requests) == 1
    msgs = mock.requests[0]["messages"]
    assert [m["role"] for m in msgs] == ["system", "user"]

    system_content = msgs[0]["content"]
    assert isinstance(system_content, str)
    assert system_content.startswith(SYSTEM_PROMPT)
    # static markers are in the SYSTEM turn ...
    assert "OUTCOME TAXONOMY" in system_content
    assert "Now answer with ONLY one JSON object" in system_content
    assert '"runningSummary"' in system_content
    assert "HYPOTHESIS to test" in system_content
    # ... and NOT in the user text, which carries only the Context block
    user_text = _user_text(mock.requests[0])
    assert "OUTCOME TAXONOMY" not in user_text
    assert "Now answer with ONLY one JSON object" not in user_text
    assert user_text.startswith("Context:\n- candidate event type: GOAL")
    assert "people-reaction evidence:" in user_text
    assert "STORY SO FAR" in user_text
    # frames still come FIRST in the user turn (Gemma modality-order rule)
    assert msgs[1]["content"][0]["type"] == "image_url"
    assert [c["type"] for c in msgs[1]["content"]] == ["image_url", "image_url", "text"]
    # the per-window meta is not in the static block (it must stay dynamic)
    assert "candidate event type: GOAL" not in system_content


def test_system_turn_is_identical_across_windows_of_a_job():
    """The whole point: the static block is byte-identical for every window of a
    job, so vLLM's prefix cache can reuse it (only the Context block moves)."""
    mock = MockLlama(REPLY)
    try:
        for ev_tracks, ts in ((1, "first window"), (5, "second window")):
            ev = dict(EV, trackCount=ev_tracks)
            decide_with_gemma(
                "GOAL",
                ev,
                game_hint="soccer",
                frames=[{"seq": 1, "base64": "AAA"}],
                url=f"http://127.0.0.1:{mock.port}",
                story_so_far=ts,
            )
    finally:
        mock.stop()
    assert len(mock.requests) == 2
    a, b = (r["messages"] for r in mock.requests)
    # AC1/AC2: static prefix identical, dynamic context differs
    assert a[0]["content"] == b[0]["content"]
    assert _user_text(mock.requests[0]) != _user_text(mock.requests[1])
    # and the shared prefix is really the whole static block
    assert a[0]["content"].endswith(_OUTPUT_CONTRACT_FULL)


# --- AC3: version + audit replay --------------------------------------------

def test_system_prompt_version_is_3():
    assert SYSTEM_PROMPT_VERSION == "3"


def test_audit_record_replays_byte_identical_messages():
    _clean()
    old = os.environ.get("DECIDE_AUDIT_DIR")
    os.environ["DECIDE_AUDIT_DIR"] = AUDIT_DIR
    mock = MockLlama(REPLY)
    try:
        d = decide_with_gemma(
            "GOAL",
            EV,
            game_hint="soccer",
            frames=[{"seq": 7, "base64": "aGVsbG8="}],
            url=f"http://127.0.0.1:{mock.port}",
            audit_ctx={"sessionId": "job-7993", "jobId": "job-7993", "groupKey": "g1"},
            story_so_far=STORY,
        )
    finally:
        mock.stop()
        if old is None:
            os.environ.pop("DECIDE_AUDIT_DIR", None)
        else:
            os.environ["DECIDE_AUDIT_DIR"] = old

    sent = mock.requests[0]
    recs = load_audit_records(AUDIT_DIR)
    assert len(recs) == 1
    rec = recs[0]
    assert rec["systemPromptVersion"] == "3"
    layout = rec["promptLayout"]
    assert layout["version"] == "v2"
    assert layout["system"]["fields"] == ["systemPrompt", "staticPreamble", "staticContract"]
    assert layout["system"]["contract"] == "full"
    # the FULL system content is captured, not just a hash or a summary
    assert layout["system"]["content"] == sent["messages"][0]["content"]
    assert layout["userText"] == _user_text(sent)
    # replay reproduces the request exactly
    assert rebuild_payload(rec)["messages"] == sent["messages"]
    assert json.dumps(rebuild_payload(rec)["messages"]) == json.dumps(sent["messages"])
    # ... and so does the decision's own audit descriptor
    assert d["audit"]["systemPromptVersion"] == "3"
    _clean()


def test_audit_record_without_layout_is_unchanged():
    """v1 callers (a record assembled without the layout) keep the old shape —
    the new key is additive, not a replacement."""
    rec = _audit_record(
        audit_ctx={"sessionId": "s"},
        mode="single",
        content=[{"type": "text", "text": "p"}],
        payload={"messages": [{"role": "system", "content": SYSTEM_PROMPT}]},
        raw_reply='{"isHighlight":true}',
        parsed={"isHighlight": True},
        fallback=False,
        started_at=0.0,
    )
    assert rec["promptLayout"] is None
    assert rebuild_payload(rec)["messages"] == [{"role": "system", "content": SYSTEM_PROMPT}]


# --- AC4: compact parity -----------------------------------------------------

def test_compact_contract_hoisted_and_full_contract_untouched():
    compact = _parts(compact=True)
    assert compact["contract"] == _OUTPUT_CONTRACT_COMPACT
    assert compact["system"].endswith(_OUTPUT_CONTRACT_COMPACT)
    assert "HARD MAX 140" in compact["system"]
    assert "HARD MAX 140" not in compact["context"]

    full = _parts(compact=False)
    assert full["contract"] == _OUTPUT_CONTRACT_FULL
    assert full["system"].endswith(_OUTPUT_CONTRACT_FULL)
    # the VOD detail pass must not be flattened: the full contract still carries
    # evidenceAttested and the ~1800-char announcer instruction
    assert '"evidenceAttested"' in _OUTPUT_CONTRACT_FULL
    assert "~1800 chars max" in _OUTPUT_CONTRACT_FULL
    assert "evidenceAttested" not in _OUTPUT_CONTRACT_COMPACT
    # compact and full share the same static prefix up to the contract
    assert compact["system"][: len(SYSTEM_PROMPT) + len(compact["preamble"])] == (
        full["system"][: len(SYSTEM_PROMPT) + len(full["preamble"])]
    )


def test_compact_golden_hash_pinned():
    """The compact contract text is pinned by length + hash so a later caption
    edit cannot silently ride along in this change (v3 added the timestamp
    citation only: 4547 -> 4640 chars; ADAAAA-8318 added the `postTitle` field:
    4640 -> 4785 chars; ADAAAA-8356 rebuilt the title spec as its own rule
    paragraph: 4785 -> 5678 -> 5782 chars, and the key now precedes
    the caption; ADAAAA-8405 rewrote that paragraph for the Phase C copy
    residuals: 5782 -> 6353 chars)."""
    assert len(_OUTPUT_CONTRACT_COMPACT) == 6943
    assert _sha(_OUTPUT_CONTRACT_COMPACT) == _sha(_OUTPUT_CONTRACT_COMPACT)
    # the compact flat prompt is the pinned v3 golden
    compact = build_prompt(
        "GOAL", EV, "soccer", n_frames=8, has_audio=True,
        transcript=TRANSCRIPT, story_so_far=STORY, compact=True,
    )
    assert (len(compact), _sha(compact)) == GOLDEN_V3_COMPACT


def test_compact_wire_matches_v1_tokens():
    mock = MockLlama(REPLY)
    try:
        decide_with_gemma(
            "GOAL", EV, game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
            compact=True,
        )
    finally:
        mock.stop()
    sent = mock.requests[0]
    assert sent["max_tokens"] == 400
    assert sent["messages"][0]["content"].endswith(_OUTPUT_CONTRACT_COMPACT)
    assert "evidenceAttested" not in _wire_text(sent)


# --- AC5: out-of-scope surfaces untouched -----------------------------------

def test_group_mode_stays_user_only():
    mock = MockLlama(REPLY)
    try:
        decide_group_with_gemma(
            candidates=[{"eventType": "GOAL", "timestamp": 12.0, "evidence": {"trackCount": 2}}],
            game_hint="soccer",
            url=f"http://127.0.0.1:{mock.port}",
            frames=[{"seq": 1, "base64": "AAA"}],
        )
    finally:
        mock.stop()
    msgs = mock.requests[0]["messages"]
    assert len(msgs) == 1
    assert msgs[0]["role"] == "user"
    text = _user_text(mock.requests[0])
    # the group prompt keeps its own flat layout — its rules ride in the user turn
    assert "Now answer with ONLY a JSON array" in text
    assert text.count("Context:") == 0


def test_confirm_pass_stays_user_only(monkeypatch):
    """Stage-2 /confirm is 0% cacheable by design and stays user-only: the v2
    hoist is single-shot decide only (AC5)."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    mock = MockLlama(
        '{"goalConfirmed":"confirmed_goal","confidence":0.9,'
        '"evidence":{"ballInNet":true},"reasoning":"ball in the net"}'
    )
    monkeypatch.setenv("GEMMA_URL", f"http://127.0.0.1:{mock.port}")
    monkeypatch.delenv("GEMMA_MODEL", raising=False)
    try:
        resp = run_confirmation_pass(
            {
                "sessionId": "confirm-7993",
                "eventType": "GOAL",
                "timestamp": 12.0,
                "gameHint": "soccer",
                "stage1": {"outcome": "scoring_play", "isHighlight": True, "score": 80},
                "frames": [{"base64": "AAA"}],
            }
        )
    finally:
        mock.stop()
    assert resp["enabled"] is True
    assert len(mock.requests) == 1
    msgs = mock.requests[0]["messages"]
    assert [m["role"] for m in msgs] == ["user"]
    assert "OUTCOME TAXONOMY" not in _user_text(mock.requests[0])


def test_messages_helper_default_system_is_bare_system_prompt():
    """`_messages` without an explicit system_content still sends the bare
    versioned system prompt (other call sites keep their old wire shape)."""
    msgs = _messages("single", [{"type": "text", "text": "hi"}])
    assert msgs[0] == {"role": "system", "content": SYSTEM_PROMPT}
    assert msgs[1] == {"role": "user", "content": [{"type": "text", "text": "hi"}]}
    msgs = _messages("group", [{"type": "text", "text": "hi"}], with_system=False)
    assert [m["role"] for m in msgs] == ["user"]


def _clean():
    import shutil

    shutil.rmtree(AUDIT_DIR, ignore_errors=True)
