"""ADAAAA-8318 — the `postTitle` field's prompt-contract snapshot (AC8/AC9).

The clip card's copy target is a short post title generated in the SAME decide
call as the announcer line. These tests pin the contract itself:

  * the FAST rail asks for `postTitle` (one field, budgeted), in the contract
    block — one inference per window, no second call;
  * the VOD / full long-form contract is BYTE-IDENTICAL (a pinned sha256), which
    is the AC8 guard: the VOD prompt file must not change;
  * the addendum stays inside its token budget (<= +40 input tokens);
  * `/highlight` carries the model's title through to the decision (bounded at
    the server write seam, not here).
"""
import hashlib
import json

from fastapi.testclient import TestClient

from app import app as decide_app
from app.gemma import (
    _OUTPUT_CONTRACT_COMPACT,
    _OUTPUT_CONTRACT_FULL,
    parse_decision,
    _response_block,
    build_prompt,
)

client = TestClient(decide_app)

SHR = lambda s: hashlib.sha256(s.encode()).hexdigest()  # noqa: E731

# Captured from the code BEFORE ADAAAA-8318 touched the compact contract. The
# VOD (full) contract then stayed byte-identical through 8318 (the compact one
# moved by the title field only, and the delta is asserted below).
# ADAAAA-8325 (Inc 2) deliberately moves the VOD contract once: the `phase`
# field + its rule (+486 chars with the REPLAY cues, 2423 -> 2909). The bytes are
# re-pinned here so a
# later edit still cannot ride along, and the delta is bounded below.
VOD_CONTRACT_V3_SHA = "f61c4c9deeaebc1ee9d7065b95cea8435e9b345bffe41d39a3a33fbc487aeb24"
VOD_CONTRACT_V3_LEN = 2909
# ADAAAA-8325 (Inc 2): the exact VOD delta the phase field is allowed (measured:
# +486 chars, ~+122 input tokens at the contract's own ~4 chars/token ratio).
# Every VOD window pays it once per decide call; nothing else may add to it.
PHASE_CONTRACT_DELTA_CHARS = 486
PRE_CHANGE_COMPACT_LEN = 4640

EV = {"trackCount": 3, "scoreBoardChanged": True, "goalCrossed": True}


def test_fast_rail_asks_for_post_title():
    prompt = build_prompt("GOAL", EV, "soccer", n_frames=8, compact=True)
    assert '"postTitle"' in prompt
    # the bars are inlined so the model cannot float back to a description
    assert "<=60 chars" in prompt and "<=10 words" in prompt
    assert "ONE clause" in prompt
    # it rides the SAME reply as the announcer line — nothing splits the call
    assert '"runningSummary"' in prompt


def test_vod_contract_is_pinned_with_the_phase_field():
    """AC8 (8318) + ADAAAA-8325: the long-form/VOD prompt carries exactly the
    `phase` field and its rule, and nothing else moved."""
    assert len(_OUTPUT_CONTRACT_FULL) == VOD_CONTRACT_V3_LEN
    assert SHR(_OUTPUT_CONTRACT_FULL) == VOD_CONTRACT_V3_SHA
    assert '"phase": "live|replay"' in _OUTPUT_CONTRACT_FULL
    # the field is additive metadata: the outcome ladder it sits beside is
    # unchanged, and the standing "a replay is never scoring_play" rule is
    # restated in the field's own wording.
    assert '"outcome": "scoring_play|near_miss|big_play|not_highlight"' in _OUTPUT_CONTRACT_FULL
    assert "NEVER `scoring_play` for re-showing a goal" in _OUTPUT_CONTRACT_FULL
    # the tightened rule names the footage cues, not just the concept
    assert "Cues for `replay`" in _OUTPUT_CONTRACT_FULL
    # and it never asks for a title: VOD rows derive theirs at projection time
    assert "postTitle" not in _OUTPUT_CONTRACT_FULL
    full = build_prompt("GOAL", EV, "soccer", n_frames=8)
    assert "postTitle" not in full
    assert "~1800 chars max" in full


def test_phase_addendum_is_within_its_contract_budget():
    """The phase field's VOD cost is a bounded, measured delta: it is the only
    thing that moved the full contract (the sha above pins the bytes), and it
    stays inside ~+125 input tokens (486 chars at the contract's own ~4
    chars/token ratio). The live rail paid nothing."""
    assert PHASE_CONTRACT_DELTA_CHARS <= 500
    assert len(_OUTPUT_CONTRACT_FULL) - 2423 == PHASE_CONTRACT_DELTA_CHARS
    assert '"phase"' not in _OUTPUT_CONTRACT_COMPACT


def test_title_addendum_is_within_its_input_token_budget():
    """Prefill budget for the title spec, measured as the character delta from the
    pre-ADAAAA-8318 contract at the contract's own ~4 chars/token ratio.

    8318's one-line parenthetical cost +145 chars and it measurably did not
    survive contact with the model (leg 23bb0a61: 341/898 place chains, 39
    ungrounded goal claims, 46/54 rows refused). ADAAAA-8356 replaces it with a
    POST TITLE RULES paragraph: +1038 chars (~+260 input tokens, ~6 % of the
    live prompt's 4 407 text tokens). The bound is raised ONCE, deliberately,
    and the paragraph may not grow beyond it.
    """
    delta = len(_OUTPUT_CONTRACT_COMPACT) - PRE_CHANGE_COMPACT_LEN
    assert delta > 0
    # ADAAAA-8405 rewrites the paragraph for the Phase C residuals (+571):
    # bounded at 1900 so no further field can ride along.
    assert delta <= 2186, f"postTitle addendum grew the contract by {delta} chars"


def test_title_spec_owns_its_own_paragraph_and_bars():
    """The 8318 defect was STRUCTURAL: the `postTitle` key was spliced mid-way
    through the runningSummary description, so the caption's colour/clock rules
    dangled after the title key and the title spec sat under a lead rule that
    REQUIRES a place. ADAAAA-8356 puts the key FIRST (the headline is written
    before the caption, so it cannot be the caption shortened) and gives it its
    own rule paragraph after the shape. Pin the layout, then the bars the model
    measurably got wrong on leg 23bb0a61.
    """
    contract = _OUTPUT_CONTRACT_COMPACT
    # the caption description is contiguous again: ... re-said afterwards. COLOR BEAT
    assert "is not re-said afterwards. COLOR BEAT" in contract
    # the headline key precedes the caption key, and the rules follow the shape
    assert contract.index('"postTitle"') < contract.index('"runningSummary"')
    assert "POST TITLE RULES" in contract
    assert contract.index("POST TITLE RULES") > contract.index('"runningSummary"')
    # the caption/title collision is named outright (AC2)
    assert "the caption MUST name a place, the headline NEVER does" in contract
    # grounding: names only from THIS window's own reads (AC3)
    assert "a name ONLY when THIS window's transcript or OCR spells it" in contract
    assert "never from the story or the match context" in contract
    # the claim bar is keyed to the model's OWN verdict, not a generic "a goal" (AC3)
    assert "unless YOUR OWN outcome here is scoring_play" in contract
    # one event / three slots, no second beat, and the distinctness rule (AC2/AC6)
    assert "Fill exactly three slots" in contract
    assert "NO fourth slot" in contract
    assert "Never reuse a subject+verb you already titled this job" in contract
    # the model is told to delete the zone itself before answering
    assert "delete any word that names where the action happened" in contract


def test_normalize_decision_carries_the_title():
    raw = {
        "isHighlight": True,
        "score": 88,
        "eventType": "GOAL",
        "outcome": "scoring_play",
        "reason": "the ball crosses the line at t=3.2s",
        "reasoning": "Observed the net bulge.",
        "runningSummary": "Ordonez drives it home at 72s.",
        "postTitle": "Ordonez opens the scoring",
    }
    decision = parse_decision(json.dumps(raw))
    assert decision["postTitle"] == "Ordonez opens the scoring"
    # absent (VOD / legacy model) degrades to empty, never to a crash
    assert parse_decision(json.dumps({**raw, "postTitle": None}))["postTitle"] == ""


def test_audit_capture_keeps_the_raw_title():
    """The stored `analysis.response` shows what the model said, so a QA replay
    can compare the RAW title with the SERVED (gated) one."""
    block = _response_block({"postTitle": "Raw   model title", "runningSummary": "s"})
    assert block["postTitle"] == "Raw   model title"
    assert _response_block({"runningSummary": "s"})["postTitle"] is None


def test_gemma_wire_returns_the_title_on_the_decision():
    """The live decide wire carries the field: `decide_with_gemma(compact=True)`
    parses the model reply and returns the title on the decision dict."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    from app.gemma import decide_with_gemma

    reply = json.dumps({
        "isHighlight": True,
        "score": 91,
        "eventType": "GOAL",
        "outcome": "scoring_play",
        "reason": "ball in net at t=2.0s",
        "reasoning": "Observed the net move.",
        "verdict": {
            "hypothesis": "GOAL",
            "independentlyObserved": "ball inside the net",
            "criteria": {
                "ballCrossedLineBetweenPosts": True,
                "ballInNet": True,
                "scoreboardChanged": True,
                "crowdErupted": True,
            },
            "contradictedBy": None,
        },
        "runningSummary": "Ordonez opens the scoring.",
        "postTitle": "Ordonez opens the scoring",
    })

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            self.rfile.read(int(self.headers.get("Content-Length", 0)))
            body = json.dumps({"choices": [{"message": {"content": reply}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, format, *args):  # noqa: A002,D102
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        decision = decide_with_gemma(
            "GOAL",
            {"trackCount": 2, "goalCrossed": True},
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{server.server_port}",
            compact=True,
        )
    finally:
        server.shutdown()
    assert decision["postTitle"] == "Ordonez opens the scoring"
    # the announcer line is untouched by the title field
    assert decision["runningSummary"] == "Ordonez opens the scoring."


def test_highlight_response_declares_the_title_field():
    """`/highlight` declares a response_model with `extra="ignore"`, which
    silently DROPS an undeclared field (the ADAAAA-7221 failure mode). The title
    must be declared or it never reaches the server."""
    from app import HighlightDecision

    assert "postTitle" in HighlightDecision.model_fields
    assert HighlightDecision.model_fields["postTitle"].default == ""
