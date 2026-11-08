"""ADAAAA-8103 — decide-emphasis v3 (SYSTEM_PROMPT_VERSION="3").

Ruling R26 of ADAAAA-8047 rev 8 §7 (parent ADAAAA-8101): "More emphasis should
be placed on the other information available in the window and use the frames as
confirmation." v2 read the frames as the primary evidence and the enriched
window evidence as auxiliary; v3 keeps the v2 wire LAYOUT and rewrites the
STATIC text so:

  - the perceive-timeline records (one per perceived frame) are the primary
    temporal read,
  - the ASR commentary, the audio-noise level curve and the detection geometry
    are primary evidence, cited by timestamp,
  - match context / prior game state bound the interpretation,
  - the shipped frames are the CONFIRMATION channel (they resolve contradictions
    and attest the decisive instant) — not the only evidence.

Binding semantics that must NOT move:
  - the candidate type stays a hypothesis;
  - the anti-fabrication rule and `evidenceAttested` stay (full contract);
  - isHighlight=true|false|null keeps its audited meaning (null = unverifiable);
  - "text says goal, frames contradict" still returns isHighlight=false.

Acceptance criteria pinned here:
  AC1 emphasis markers present, and the frames-are-primary claim is gone
  AC2 static-only: the per-window Context block is byte-identical (no drift)
  AC3 budget: preamble/contract deltas bounded, static block ceiling asserted
  AC4 retained semantics (hypothesis / anti-fabrication / tri-state / attest)
  AC5 auditability: version bumped, exact prompt recorded on the row + descriptor
  AC6 contradiction regression: the frames-contradict case rejects (not null)
"""
import hashlib
import json
import os

from app.gemma import (
    SYSTEM_PROMPT,
    SYSTEM_PROMPT_VERSION,
    STATIC_PREAMBLE,
    _OUTPUT_CONTRACT_COMPACT,
    _OUTPUT_CONTRACT_FULL,
    build_prompt,
    build_prompt_parts,
    decide_with_gemma,
    load_audit_records,
)
from test_gemma import MockLlama

AUDIT_DIR = "/tmp/test-decide-audit-8103"

# v2 lengths (origin/master@334fe57 / ADAAAA-7993), the baseline the deltas are
# measured against.
V2_PREAMBLE_CHARS = 6808
V2_COMPACT_CONTRACT_CHARS = 4547
V2_FULL_CONTRACT_CHARS = 2354
# ceiling for the static prefix: a later edit may not silently inflate every
# window's prompt (measured 9193 chars / ~2 240 tokens at v3).
MAX_STATIC_PREAMBLE_CHARS = 9400
# SYSTEM_PROMPT + preamble + compact contract. ADAAAA-8356 moved this ceiling
# once, by +500: the compact contract gained a POST TITLE RULES paragraph
# (+893 chars over the 8318 field spec, measured 15 197 here) because the terse
# parenthetical measurably failed on leg 23bb0a61. The preamble ceiling above is
# untouched — the caption contract itself did not grow a character.
# ADAAAA-8405 moves it once more (+571 to the contract, 15 872 here): the Phase C
# residuals needed the headline's place/claim/name rules stated as closed sets.
MAX_STATIC_BLOCK_CHARS = 16662

EV = {
    "trackCount": 3,
    "maxVelocity": 0.42,
    "ocrHits": 2,
    "scoreBoardChanged": False,
    "reaction": {"crowdEnergy": 0.2, "humansInMotion": 2, "burstAt": 9.0},
    "detections": [
        {"label": "player", "bbox": [0.1, 0.2, 0.3, 0.4], "confidence": 0.91, "trackId": "t1"}
    ],
    "audioLevels": [0.1, 0.2, 0.15, 0.1],
    "perceiveTimeline": [
        {"ts": 1.0, "tracks": 3, "maxVelocity": 0.2, "objects": ["player", "ball"]},
        {"ts": 4.5, "tracks": 4, "maxVelocity": 0.41, "objects": ["player", "ball"]},
        {"ts": 8.0, "tracks": 2, "maxVelocity": 0.11, "objects": ["player"]},
    ],
}
TRANSCRIPT = "and the shot is dragged wide of the far post, no danger"
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

REJECT_REPLY = (
    '{"isHighlight":false,"score":12,"eventType":"GOAL",'
    '"outcome":"not_highlight","reason":"ball wide of the far post at t=4.5, no net",'
    '"reasoning":"timeline shows no goal-line record and the shot goes wide, so the'
    ' goal call is contradicted","verdict":{"hypothesis":"GOAL",'
    '"independentlyObserved":"shot dragged wide, ball never near the net",'
    '"criteria":{"ballCrossedLineBetweenPosts":false,"ballInNet":false,'
    '"scoreboardChanged":false,"crowdErupted":false},'
    '"contradictedBy":"ball wide of the far post"}}'
)
ACCEPT_REPLY = (
    '{"isHighlight":true,"score":88,"eventType":"GOAL","outcome":"scoring_play",'
    '"reason":"ball in the net at t=4.5 with the level curve peaking",'
    '"reasoning":"timeline records the ball outcome goal at t=4.5 and the frames '
    'confirm the net","verdict":{"hypothesis":"GOAL",'
    '"independentlyObserved":"ball crosses the line and the net moves",'
    '"criteria":{"ballCrossedLineBetweenPosts":true,"ballInNet":true,'
    '"scoreboardChanged":true,"crowdErupted":true},'
    '"contradictedBy":null},'
    '"evidenceAttested":["perceive timeline t=4.5 ballOutcome=goal",'
    '"ASR at 4.5s: goal call","frame at t=4.5 shows the ball in the net"],'
    '"runningSummary":"No. 9 drives it home at 72s."}'
)


def _sha(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def _parts(compact: bool = False, transcript: str = TRANSCRIPT):
    return build_prompt_parts(
        "GOAL",
        EV,
        "soccer",
        n_frames=4,
        has_audio=True,
        transcript=transcript,
        story_so_far="0-0, Brazil pressing.",
        compact=compact,
        match_context=MC,
        prior_game_state=PG,
        perceive_window={"seeds": 4, "withFindings": 3},
    )


# --- AC1: the emphasis actually moved ---------------------------------------

def test_preamble_makes_the_window_evidence_primary():
    p = STATIC_PREAMBLE
    # the directive's four channels, in the preamble's own words
    assert "MEASURED EVIDENCE CARRIES THE READ" in p
    assert "FRAMES CONFIRM IT" in p
    assert "PRIMARY TEMPORAL READ" in p
    assert "perceive timeline" in p
    assert "audio-noise level curve" in p
    assert "detection geometry" in p
    assert "BOUND the interpretation" in p
    assert "CONFIRMATION CHANNEL" in p
    # the reading order is dossier-first, frames-second
    assert "PASS 1 — READ THE DOSSIER" in p
    assert "PASS 1b — CONFIRM WITH THE FRAMES" in p
    assert "PASS 2 — HYPOTHESIS TEST" in p
    assert p.index("PASS 1 — READ THE DOSSIER") < p.index("PASS 1b — CONFIRM WITH THE FRAMES")
    # timestamps must be cited (the "cited by timestamp" clause)
    assert "`t=`" in p
    assert "quote them with the timestamp" in p


def test_frames_are_no_longer_the_only_primary_evidence():
    p = STATIC_PREAMBLE
    assert "FRAMES ARE THE PRIMARY EVIDENCE" not in p
    assert "you are shown a temporal SEQUENCE of frames" not in p
    assert "describe only what you can actually SEE and HEAR" not in p
    # the frames still arbitrate a conflict (the audited rule) ...
    assert "THE FRAMES ARE THE FINAL ARBITER" in p
    assert "conflict resolves toward the frames" in p
    # ... and frame-silence is explicitly not a rejection
    assert "frame-silence is NOT a rejection" in p


def test_contract_cites_the_timestamp_of_the_deciding_evidence():
    assert "its timestamp" in _OUTPUT_CONTRACT_COMPACT
    assert "timeline t=" in _OUTPUT_CONTRACT_COMPACT
    assert "its timestamp" in _OUTPUT_CONTRACT_FULL


# --- AC2: static-only -------------------------------------------------------

def test_context_block_and_prompt_assembly_are_static_only():
    """preamble + Context + contract is still the flat prompt, and the Context
    block is untouched by the reword (the v2 hash is pinned in
    test_prompt_layout_v2.py). The system turn still carries the static block."""
    for compact in (False, True):
        p = _parts(compact)
        assert p["prompt"] == p["preamble"] + p["context"] + p["contract"]
        assert p["system"] == SYSTEM_PROMPT + p["preamble"] + p["contract"]
        assert p["system"].startswith(SYSTEM_PROMPT)
        # the same window's prompt only moves in the static block
        assert p["context"].startswith("Context:\n- candidate event type: GOAL")
        assert STATIC_PREAMBLE not in p["context"]


# --- AC3: budget ------------------------------------------------------------

def test_static_block_budget():
    assert len(STATIC_PREAMBLE) <= MAX_STATIC_PREAMBLE_CHARS
    static_block = len(SYSTEM_PROMPT) + len(STATIC_PREAMBLE) + len(_OUTPUT_CONTRACT_COMPACT)
    assert static_block <= MAX_STATIC_BLOCK_CHARS
    # measured deltas vs v2 (reported on the ticket, bounded here)
    assert len(STATIC_PREAMBLE) - V2_PREAMBLE_CHARS <= 2500
    # v3 added +93; ADAAAA-8318 adds the `postTitle` field (+145); ADAAAA-8356
    # rebuilds that spec as its own POST TITLE RULES paragraph (+1038 over the
    # pre-8318 contract) — bounded at 1200 so another field cannot ride along.
    # ADAAAA-8405 raises it once more (+571, the headline rule rewrite): live
    # prefill ~+140 tokens, output unchanged (the rail is decode-bound).
    assert len(_OUTPUT_CONTRACT_COMPACT) - V2_COMPACT_CONTRACT_CHARS <= 2456
    # ADAAAA-8325 (Inc 2): the VOD (FULL) contract gained the `phase` field and
    # its rule (+486 chars with the REPLAY cues); bounded so a later edit cannot inflate every VOD
    # window's prefill any further. The COMPACT bound above is untouched — the
    # live rail did not gain a character.
    assert len(_OUTPUT_CONTRACT_FULL) - V2_FULL_CONTRACT_CHARS <= 560


# --- AC4: retained semantics ------------------------------------------------

def test_hypothesis_antifabrication_and_tristate_semantics_retained():
    p = STATIC_PREAMBLE
    assert "is a HYPOTHESIS to test, NOT a fact" in p
    assert "NEVER assume the hypothesis is true" in p
    assert "NEVER infer a goal from the candidate event type" in p
    assert "never overrides a clear frame" in p
    # tri-state: null is unverifiable, not a rejection
    assert "isHighlight=null means you genuinely cannot tell" in p
    assert "it is NOT a rejection and NOT a confirmation" in p
    # evidenceAttested stays on the audited full contract, unchanged in kind
    assert '"evidenceAttested"' in _OUTPUT_CONTRACT_FULL
    # the compact contract stays lean (no attestation list: decode-bound rail)
    assert "evidenceAttested" not in _OUTPUT_CONTRACT_COMPACT


# --- AC5: auditability ------------------------------------------------------

def _clean():
    import shutil

    shutil.rmtree(AUDIT_DIR, ignore_errors=True)


def test_version_is_3():
    assert SYSTEM_PROMPT_VERSION == "3"


def test_audit_row_records_the_exact_prompt_on_every_graded_row():
    _clean()
    old = os.environ.get("DECIDE_AUDIT_DIR")
    os.environ["DECIDE_AUDIT_DIR"] = AUDIT_DIR
    mock = MockLlama(REJECT_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL",
            EV,
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
            asr_prefetched=True,
            asr_transcript=TRANSCRIPT,
            story_so_far="0-0, Brazil pressing.",
            match_context=MC,
            prior_game_state=PG,
            perceive_window={"seeds": 1, "withFindings": 3},
            compact=True,
            audit_ctx={"sessionId": "job-8103", "jobId": "job-8103", "groupKey": "g1"},
        )
    finally:
        mock.stop()
        if old is None:
            os.environ.pop("DECIDE_AUDIT_DIR", None)
        else:
            os.environ["DECIDE_AUDIT_DIR"] = old

    sent = mock.requests[0]
    # the model really saw the v3 static block in the system turn
    assert sent["messages"][0]["role"] == "system"
    assert sent["messages"][0]["content"].startswith(SYSTEM_PROMPT + STATIC_PREAMBLE)

    rec = load_audit_records(AUDIT_DIR)[0]
    assert rec["systemPromptVersion"] == "3"
    assert rec["promptLayout"]["system"]["content"] == sent["messages"][0]["content"]
    assert rec["promptLayout"]["version"] == "v2"  # the LAYOUT did not move
    # the descriptor (what the server persists as the decide_audit row) carries
    # the exact prompt text, both turns, so a row can re-create the request
    audit = d["audit"]
    assert audit["systemPromptVersion"] == "3"
    assert audit["promptText"].startswith(SYSTEM_PROMPT)
    assert "MEASURED EVIDENCE CARRIES THE READ" in audit["promptText"]
    assert "PASS 1 — READ THE DOSSIER" in audit["promptText"]
    assert "Context:\n- candidate event type: GOAL" in audit["promptText"]
    assert "Now answer with ONLY one JSON object" in audit["promptText"]
    assert d["analysis"]["prompt"] == build_prompt(
        "GOAL",
        EV,
        "soccer",
        n_frames=1,
        has_audio=True,
        transcript=TRANSCRIPT,
        story_so_far="0-0, Brazil pressing.",
        compact=True,
        match_context=MC,
        prior_game_state=PG,
        perceive_window={"seeds": 1, "withFindings": 3},
    )
    _clean()


# --- AC6: the text-says-goal / frames-contradict regression -----------------

def test_text_says_goal_frames_contradict_returns_false():
    """A window whose ASR commentary carries a goal call but whose evidence
    plainly contradicts it must reject (isHighlight=false), not go null."""
    goal_shout = "IT'S IN! what a finish, 2-1!"
    parts = _parts(compact=True, transcript=goal_shout)
    # the prompt carries the goal shout AND the contradiction rule it must lose to
    assert goal_shout[:20] in parts["context"]
    assert "but whose frames plainly contradict it MUST return isHighlight=false" in STATIC_PREAMBLE

    mock = MockLlama(REJECT_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL",
            EV,
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
            asr_prefetched=True,
            asr_transcript=goal_shout,
            compact=True,
        )
    finally:
        mock.stop()
    assert d is not None
    assert d["isHighlight"] is False          # a rejection, byte-consistent
    assert d["isHighlight"] is not None       # ... never the unverifiable tri-state
    assert d["outcome"] != "scoring_play"
    assert d["verdict"]["contradictedBy"]     # the contradicting evidence is attested
    assert d["verdict"]["criteria"]["ballInNet"] is False


def test_accepted_row_attests_evidence_on_the_full_contract():
    mock = MockLlama(ACCEPT_REPLY)
    try:
        d = decide_with_gemma(
            "GOAL",
            dict(EV, ballOutcome="goal", goalCrossed=True, scoreBoardChanged=True),
            game_hint="soccer",
            frames=[{"seq": 1, "base64": "AAA"}],
            url=f"http://127.0.0.1:{mock.port}",
            asr_prefetched=True,
            asr_transcript=TRANSCRIPT,
            compact=False,
        )
    finally:
        mock.stop()
    assert d["isHighlight"] is True
    assert d["evidenceAttested"], "accepted rows must carry evidenceAttested"
    assert json.dumps(d["evidenceAttested"])  # plain JSON, no objects
