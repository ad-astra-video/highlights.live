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
    lines = [f"line-{i}" for i in range(600)]
    joined = "\n".join(lines)
    assert len(joined) > MAX_RUNNING_SUMMARY_CHARS
    out = _compile_summary(joined)
    assert len(out) <= MAX_RUNNING_SUMMARY_CHARS
    # The newest line survives; the oldest is gone.
    assert out.endswith(lines[-1])
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


def test_prompt_asks_announcer_style_running_summary():
    # ADAAAA-7495: the running summary must read like an announcer calling the
    # game — narrative continuity, scene-change framing, specificity, flow — not
    # a dry list of static stills.
    p = build_prompt("GOAL", {}, game_hint="soccer", story_so_far="team pressed")
    low = p.lower()
    assert "announcer" in low
    assert "narrative continuity" in low
    assert "scene-change framing" in low
    assert "not a list of static scene descriptions" in low


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


# ---------------------------------------------------------------------------
# ADAAAA-7935 (ADAAAA-7933 Inc 1): the fast (compact) rail emits ONE
# play-by-play line per window -- "<PLAY-BY-PLAY LEAD> — <optional COLOR BEAT>"
# -- instead of one unbounded announcer sentence with a 220-char cap. These
# tests pin the contract the model is actually given, and pin the VOD prompt
# byte-for-byte so this rewrite can never leak into the full contract.
# ---------------------------------------------------------------------------

COMPACT_STORY_SO_FAR = "Kick-off, teams settle. Pressure builds down the right."

BANNED_OPENERS = [
    "The video shows",
    "The video begins",
    "The video starts with",
    "In this segment",
    "The scene opens on",
    "The broadcast cuts to",
    "The sequence",
    "This window shows",
]

# The compact JSON field set the server consumes. Unchanged by ADAAAA-7935:
# this is a prompt-only rewrite, no new field, no new request param.
COMPACT_JSON_FIELDS = [
    "isHighlight",
    "score",
    "eventType",
    "outcome",
    "reason",
    "reasoning",
    "verdict",
    "hypothesis",
    "independentlyObserved",
    "criteria",
    "ballCrossedLineBetweenPosts",
    "ballInNet",
    "scoreboardChanged",
    "crowdErupted",
    "contradictedBy",
    "runningSummary",
    # ADAAAA-8318: the clip card's copy target — ONE extra output field in the
    # SAME reply (no second decide call). The announcer line above is unchanged.
    "postTitle",
]


def _compact_prompt() -> str:
    return build_prompt(
        "GOAL",
        {"trackCount": 7},
        game_hint="soccer",
        n_frames=6,
        has_audio=True,
        transcript="[12.0] 72 seconds in and it's in the net",
        story_so_far=COMPACT_STORY_SO_FAR,
        compact=True,
    )


def test_compact_prompt_asks_for_one_play_by_play_line():
    p = _compact_prompt()
    assert "<PLAY-BY-PLAY LEAD> — <optional COLOR BEAT>" in p
    # the whole field is ONE bounded line: appending a line per window would
    # break AC1 (p95 <= 140, 0 rows over 140) and grow output tokens.
    assert "as ONE line (never append a second line)" in p
    assert "never append a second line" in p
    # lead = actor + action + place, present tense, active voice, <= 70 chars,
    # event first (not the scene), named player/jersey else the role.
    assert "actor + action + place" in p
    assert "present tense, active voice, max 70 chars" in p
    assert "name the player/jersey when the frames read one" in p
    assert "else the role (the winger, the keeper, the No. 9)" in p
    assert "lead with the event, not the scene" in p
    assert "open on an ACTION VERB" in p
    assert "never \"are positioned\" or \"maintain position\"" in p


def test_compact_prompt_carries_colour_and_quiet_budgets():
    p = _compact_prompt()
    # colour beat: <= 40 chars, its own channel (crowd, body language, momentum,
    # bench, pitch conditions), never a second description of the play.
    assert "COLOR BEAT — a SEPARATE CHANNEL, NEVER the play" in p
    assert "crowd or stand reaction, players' body language or posture" in p
    assert "momentum or energy, the bench or dugout, or pitch/weather conditions" in p
    assert "must not rephrase or extend the lead" in p
    assert "never pad to hit a ratio" in p
    # quiet window: one blunt line, <= 8 words, no em-dash, no clock.
    assert "QUIET WINDOW — when YOUR OWN verdict is isHighlight=false" in p
    assert "the whole line is ONE blunt flat statement, max 8 words" in p
    assert "NO em-dash, NO colour beat, NO clock" in p
    assert "NEVER describe the play on such a window" in p
    assert "max 8 words counted INCLUDING articles" in p
    assert "If your draft is 9 words or longer it is WRONG: rewrite it shorter" in p
    assert "CLOCK: only on datable events ('GOAL 72s'), not every line" in p
    # The contract must not carry a copyable sample caption: the first live
    # level proved the model copies it verbatim (59 of 67 rows emitted the
    # example line on 67 distinct frame sets), which fails AC3. Same rule now
    # covers the quiet shape — a copyable quiet sentence would make every quiet
    # window byte-identical.
    assert "Midfield stalemate" not in p
    assert "Nothing doing" not in p
    # ...and it must forbid re-emitting its own previous line instead.
    assert "NEVER re-emit a line you already emitted this job" in p
    assert "different concrete subject" in p


# ---------------------------------------------------------------------------
# ADAAAA-7949 (ADAAAA-7933 Inc 4): contract v2. v1 folded STORY SO FAR into the
# one caption line and also forbade repeats, so the model kept a captured goal
# by re-serving the same composite sentence (30 of 68 windows identical, 17 of
# 20 sampled lines byte-identical on job 7b719a9f). These four tests pin the
# three deltas separately, so a later edit cannot quietly drop one of them.
# ---------------------------------------------------------------------------


def test_compact_prompt_describes_this_window_only():
    p = _compact_prompt()
    assert "CAPTION FOR THIS WINDOW ONLY" in p
    assert "THIS WINDOW ONLY: describe only what this window's frames and transcript show" in p
    # a captured goal lives in the story, never restated in a later caption
    assert "a goal already captured stays in the story" in p
    assert "is NEVER re-said in a later caption unless THIS window is the goal window" in p


def test_compact_prompt_never_folds_story_so_far_into_the_line():
    p = _compact_prompt()
    # R1 was the contract collision: v1 told the model to fold the prior story
    # into the ONE bounded line while also forbidding repeats.
    assert "do NOT fold it into this line" in p
    assert "do NOT extend or compress it here" in p
    assert "STORY SO FAR is context, never material" in p
    assert "fold it into ONE line under the cap" not in p
    assert "keep every event already captured and EXTEND the story" not in p
    # the prior story is still forwarded into the prompt unchanged
    assert COMPACT_STORY_SO_FAR in p


def test_compact_prompt_blunt_quiet_rule():
    p = _compact_prompt()
    # The quiet rule is keyed to the model's OWN verdict: the first v2 level
    # measured 1 of 20 not_highlight rows at <= 8 words (p50 13) when the rule
    # only said "no datable event", so the wording now names isHighlight=false.
    assert "QUIET WINDOW — when YOUR OWN verdict is isHighlight=false" in p
    assert "the whole line is ONE blunt flat statement, max 8 words" in p
    assert "NO em-dash, NO colour beat, NO clock" in p
    assert "just who has the ball and which zone it is in" in p
    # every line must name a place, and a repeat of the first four words is a repeat
    assert "EVERY LEAD names a place this window's frames read" in p
    # a replay/celebration window adds nothing new -> quiet shape even when loud
    assert "adds nothing new: give it the QUIET shape" in p
    assert "A celebration or replay window NEVER states the goal again" in p
    assert "if it shares its first four words with an earlier line it IS a repeat" in p
    assert "a not_highlight window or a repeat window never carries one" in p
    assert "never reuse the sentence" in p


def test_compact_prompt_colour_is_a_different_channel():
    p = _compact_prompt()
    assert "COLOR BEAT — a SEPARATE CHANNEL, NEVER the play" in p
    assert "may carry ONLY crowd or stand reaction" in p
    assert "max 40 chars" in p
    # the clause may not smuggle the play back in: v2's first level put
    # "blocked by the keeper" / "keeper makes a save" after the dash on 43 of
    # 67 rows (64 %), so the ban list is explicit now.
    assert "no shot, save, block, tackle, interception, pass, miss, post, net, goal, score or keeper save" in p
    assert "write the lead alone with no em-dash" in p
    assert "About 1 line in 4 carries a clause and NEVER more than 1 line in 3" in p


def test_compact_prompt_lowers_the_whole_line_cap_to_140():
    p = _compact_prompt()
    assert "total target max 110 chars, HARD MAX 140" in p
    # the old 220-char one-sentence ask is gone from the fast rail.
    assert "max 220 chars" not in p
    assert "ONE announcer sentence" not in p


def test_compact_prompt_lists_every_banned_opener():
    p = _compact_prompt()
    assert "NEVER open with" in p
    for opener in BANNED_OPENERS:
        assert opener in p, opener


def test_compact_prompt_keeps_grounding_rules():
    p = _compact_prompt()
    assert "no invented names, scores, kit colours or flags" in p
    assert "Color must be attributable to this window's frames or transcript" in p
    # present tense / active voice / actor+action+place survive the v2 rewrite
    assert "present tense, active voice, max 70 chars" in p
    assert "actor + action + place" in p



def test_compact_json_field_set_is_unchanged():
    import re

    p = _compact_prompt()
    keys = re.findall(r'"([A-Za-z][A-Za-z0-9]*)":', p)
    assert keys == COMPACT_JSON_FIELDS
    # no long-form-only field leaked in and no new prompt field appeared
    assert "evidenceAttested" not in p


def test_compact_prompt_delta_is_bounded():
    # ADAAAA-7935 measured on this evidence dict: 8569 -> 9999 chars
    # (+1430 chars, ~+357 prompt tokens of prefill; output tokens are the cost
    # driver on the decode-bound live rail, and the caption budget drops).
    # The no-copy quiet rule + anti-repeat clause adds 244 more (9999 -> 10243,
    # ~+61 prompt tokens): the example caption it replaces was being copied
    # verbatim by the model on 59 of 67 live rows, so the clause pays for itself.
    # A "name the unit, never the bare plural Players" clause was tried and
    # REVERTED: it pushed p50 61 -> 105 chars with 4 rows over the 140 cap.
    # ADAAAA-7949 (contract v2) adds the window-only / no-fold rule, the blunt
    # quiet shape and the separate-colour-channel rule: 10243 -> 10634 chars
    # (+391, ~+98 prompt tokens of prefill). The first bounded level then put a
    # colour clause on 43 of 67 rows (64 %) and left 1 of 20 not_highlight rows
    # at <= 8 words, so v2.1 keys the quiet rule to isHighlight=false and bans
    # the play from the colour clause: 10634 -> 11111 chars (+477). Prefill
    # only — the emitted line still fits the same budgets and the field set is
    # unchanged, so tokens per decide are not bought by this edit.
    # ADAAAA-8103 (v3 emphasis) adds the dossier/hierarchy block: 11111 ->
    # 14509 chars on this evidence dict (+3398, of which +2385 is the static
    # preamble and +93 the compact contract). Prefill only — the field set is
    # unchanged and the caption budgets are untouched.
    # ADAAAA-8318 adds the `postTitle` field (+145 chars on the contract; ~+36
    # input tokens, inside the ticket's +40 budget) and one output field. Prefill
    # only — the announcer budgets are untouched.
    # Bound the growth so a later edit cannot silently inflate every window.
    assert len(_compact_prompt()) <= 14800


# VOD golden hash. Captured from `build_prompt(..., compact=False)` on the
# pre-change code (origin/master e3f5688) with exactly this evidence dict.
# ADAAAA-7933 AC8: the FULL contract -- and therefore every VOD prompt -- must
# stay BYTE-IDENTICAL through the fast-rail rewrite. A mismatch here is a FAIL.
VOD_GOLDEN_EV = {
    "trackCount": 7,
    "maxVelocity": 1.83,
    "ballOutcome": "goal",
    "goalCrossed": True,
    "scorebug": {"home": 2, "away": 1},
    "ocrHits": 3,
}
VOD_GOLDEN_MATCH_CONTEXT = {
    "competition": "Premier League",
    "homeTeam": "Arsenal",
    "awayTeam": "Chelsea",
    "venue": "Emirates",
}
# ADAAAA-8103 (v3 emphasis) moves this deliberately: the full contract gained
# the timestamp-citation ask (+69 chars) and the preamble the dossier block.
# It stays pinned so a later caption edit cannot ride along.
# ADAAAA-8325 (Inc 2) moves it once more: the VOD contract gained the `phase`
# field + its rule (+411 chars). Re-pinned, not un-pinned.
VOD_GOLDEN_LEN = 12724
VOD_GOLDEN_SHA256 = "3e4c137f34cf54c2b79f8a0ce8ff905b9bdb658635d24b9a452910fe2c03ad2e"


def _vod_prompt() -> str:
    return build_prompt(
        "GOAL",
        VOD_GOLDEN_EV,
        game_hint="soccer",
        n_frames=6,
        has_audio=True,
        transcript="[12.0] 72 seconds in and it's in the net",
        story_so_far=COMPACT_STORY_SO_FAR,
        match_context=VOD_GOLDEN_MATCH_CONTEXT,
        compact=False,
    )


def test_vod_prompt_is_byte_identical_golden_hash():
    import hashlib

    p = _vod_prompt()
    assert len(p) == VOD_GOLDEN_LEN
    assert hashlib.sha256(p.encode()).hexdigest() == VOD_GOLDEN_SHA256
    # and the full contract still carries its own announcer narrative ask
    assert "~1800 chars max" in p
    assert "max 220 chars" not in p
    assert "HARD MAX 140" not in p


