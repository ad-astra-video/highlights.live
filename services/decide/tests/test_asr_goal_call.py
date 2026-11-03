"""ASR goal-call detector (ADAAAA-7843).

The confirm pass credits a `confirmed_goal` only when an INDEPENDENT
corroboration signal is present. One of those signals is `audio_calls_goal` —
the (fallible) ASR commentary text calling the goal. The detector used to be one
flat substring tuple, which made retrospective STAT commentary corroborate a
goal while the real score-transition call matched nothing.

Ground truth cases below are the EXACT persisted transcripts of job
`dee44c2f-d962-400d-ad62-6cf9dc53fd91` (`job_candidates.record.analysis.asr
.transcript` for the stage-1 windows and `highlights.record.asrTranscript` for
the confirm-pass windows), read back with SQL — no live GPU inference.

Run from `services/decide` with `python3 -m pytest tests/test_asr_goal_call.py -q`.
"""

import pytest

from app import confirm as cf
from app.confirm import run_confirmation_pass

# --- the persisted job, stage-1 windows (analysis.asr.transcript) -----------
# ts 117-132 is the retrospective-stat stretch: a penalty/free-kick setup whose
# commentary is reciting Ronaldo's World Cup record. No goal occurs there.
_STAT_WINDOWS = [
    (117.0, "Christiana Ronaldo has scored"),
    (120.0, "Christiana Ronaldo has scored seven penalties for Portugal."),
    (
        123.0,
        "Cristiano Ronaldo has scored seven penalties for Portugal, but he scored "
        "only three goals  in his previous.",
    ),
    (
        126.0,
        "seven penalties for Portugal, but he scored only three goals in his "
        "previous 13 World  Cut Finals appearances.",
    ),
    (
        129.0,
        "scored only three goals in his  previous 13 World Cup Finals  "
        "appearances.  He's the only Portuguese.",
    ),
    (
        132.0,
        "13 World Cup Finals appearances.  He's the only Portuguese player to "
        "score at three different World Cup.",
    ),
]

# The REAL call. Stage-1 window ts 150 carries it; the 15 s confirm-pass window
# of the accepted goal highlight (localizedTs 153.6) carries the fuller line the
# ticket quotes.
_GOAL_CALLS = [
    (150.0, "against David Deheyer.  It's 1-0 Portugal and what's that?"),
    (153.6, "against David DeHair.  It's 1-0 Portugal and was there ever any doubt?"),
]

# Post-goal retrospective credit that fired only because of a substring match.
_STAT_LATE = [
    (183.0, "Ronaldo goes the other.  It's his 82nd goal for Portugal."),
    (186.0, "It's his 82nd goal for Portugal on his 150 first appearance."),
    (189.0, "second goal for Portugal on his 151st appearance.  It just had to be him."),
]


# --- requirement 1: retrospective-stat framing is not a goal call -----------


@pytest.mark.parametrize("ts,transcript", _STAT_WINDOWS + _STAT_LATE)
def test_retrospective_stat_windows_do_not_call_a_goal(ts, transcript):
    assert cf.audio_calls_goal(transcript) is False, f"ts={ts} {transcript!r}"


@pytest.mark.parametrize(
    "transcript",
    [
        # each rejector the ticket enumerates, on its own
        "Ronaldo has scored seven penalties for Portugal.",   # "has scored <N>"
        "He had scored only once before that night.",          # "had scored"
        "three goals in his previous 13 finals appearances.",  # "previous"
        "that is a new World Cup record for him.",             # "record"
        "It's his 151st appearance for Portugal.",             # "appearance"
        "It's his 82nd goal for Portugal.",                    # "Nth goal"
        "seven penalties for Portugal at the World Cup.",      # "penalties for"
    ],
)
def test_each_retrospective_stat_marker_is_not_a_goal_call(transcript):
    assert cf.audio_calls_goal(transcript) is False
    assert cf.retrospective_stat_framing(transcript) is True


def test_retrospective_framing_needs_a_real_marker():
    assert cf.retrospective_stat_framing("the ball has crossed the line") is False
    assert cf.retrospective_stat_framing("") is False
    assert cf.retrospective_stat_framing(None) is False


# --- requirement 2: a literal score transition IS a goal call ---------------


@pytest.mark.parametrize("ts,transcript", _GOAL_CALLS)
def test_score_transition_call_is_a_goal_call(ts, transcript):
    assert cf.audio_calls_goal(transcript) is True, f"ts={ts} {transcript!r}"


@pytest.mark.parametrize(
    "transcript",
    [
        "It's 1-0 Portugal",
        "it's 1-0 to Portugal",
        "Portugal lead 2-1 after that header",
        "now 3-2 to Spain",
        "make it 2-0 Ronaldo",
        "the score is 2-1 Portugal",
    ],
)
def test_score_transition_variants_fire(transcript):
    assert cf.audio_calls_goal(transcript) is True


@pytest.mark.parametrize(
    "transcript",
    [
        # a readout of an unchanged score is not a transition
        "the scoreboard reads POR 0-0 ESP",
        "it's still 2-2 at the break",
        # a number pair with neither an entity name nor a transition cue
        "he has 13 - 2 in shot attempts",
        "clip runs 3:01 to 3-09",
        # a scoreboard read with no transition cue and no trailing entity
        "the scoreboard shows 1-0",
    ],
)
def test_non_transition_number_pairs_do_not_fire(transcript):
    assert cf.audio_calls_goal(transcript) is False


# --- existing goal-call / conservative cases stay intact --------------------


def test_goal_calls_still_fire():
    assert cf.audio_calls_goal("GOOOAL!!! And it's in the net") is True
    assert cf.audio_calls_goal("it's in!") is True
    assert cf.audio_calls_goal("what a goal from the striker") is True
    assert cf.audio_calls_goal("scores!") is True
    # a strong exclamatory call still wins over surrounding stat narration
    assert cf.audio_calls_goal("GOOOAL! that's his 82nd goal for Portugal") is True
    # an explicit perfect-tense EXCLAMATION is a call, not a record
    assert cf.audio_calls_goal("Ronaldo has scored!") is True


def test_bare_goal_and_replay_narration_stay_uncorroborated():
    assert cf.audio_calls_goal("the goal is the objective of the game") is False
    assert cf.audio_calls_goal("that was the goal that decided the tie") is False
    assert cf.audio_calls_goal("") is False
    assert cf.audio_calls_goal(None) is False


# --- ADAAAA-7162 fabrication guard + shootout credit are preserved ----------


def _stage1_goal():
    return {
        "outcome": "scoring_play",
        "isHighlight": True,
        "score": 95,
        "eventType": "GOAL",
        "reason": "stage-1 read",
    }


def _confirm_with(monkeypatch, *, reply, transcript, scoreboard_changed=False, audio=True):
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("DECIDE_CONFIRM_REQUIRE_CORROBORATION", "1")
    if audio:
        monkeypatch.setenv("AUDIO_CONTEXT", "1")
        monkeypatch.setattr(cf, "_asr_url", lambda: "http://asr:9999")
        monkeypatch.setattr(cf, "transcribe_audio", lambda *a, **k: (transcript, None))
    monkeypatch.setattr(cf, "_call_gemma", lambda *a, **k: reply)
    req = {"stage1": _stage1_goal(), "eventType": "GOAL", "frames": [{"base64": "x"}]}
    if audio:
        req["audioB64"] = "AAA"
    if scoreboard_changed:
        req["scoreBoardChanged"] = True
    return run_confirmation_pass(req)


def test_bare_ball_in_net_read_stays_uncorroborated(monkeypatch):
    """ADAAAA-7162: a self-reported 'ball in the net' with a stat-line
    transcript and no measured scoreboard change is NOT a goal."""
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.95, '
        '"reason": "ball clearly enters the net", "evidence": {"ballInNet": true}}'
    )
    resp = _confirm_with(
        monkeypatch, reply=canned, transcript=_STAT_WINDOWS[2][1]
    )
    assert resp["corroborated"] is False
    assert resp["corroborationSource"] is None
    assert resp["decision"]["outcome"] == "near_miss"
    assert resp["decision"]["isHighlight"] is False


def test_score_transition_transcript_corroborates_a_goal(monkeypatch):
    """A confirmed_goal with a score-transition call is accepted (requirement 2)."""
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "ball crosses the line", "evidence": {"ballInNet": true}}'
    )
    resp = _confirm_with(monkeypatch, reply=canned, transcript=_GOAL_CALLS[1][1])
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "audio_text"
    assert resp["decision"]["isHighlight"] is True


def test_shootout_tally_credit_is_unchanged_by_a_stat_transcript(monkeypatch):
    """ADAAAA-7402: during a shootout the PENALTIS tally (scoreboard) still
    credits a converted penalty, and scoreboard keeps precedence over audio."""
    canned = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "penalty converted, PENALTIS tally increments", '
        '"evidence": {"ballInNet": true, "penaltyShootout": true, '
        '"penaltyTallyChanged": true}}'
    )
    resp = _confirm_with(
        monkeypatch, reply=canned, transcript=_STAT_WINDOWS[3][1]
    )
    assert resp["corroborated"] is True
    assert resp["corroborationSource"] == "scoreboard"
    assert resp["decision"]["isHighlight"] is True


def test_corroboration_precedence_scoreboard_gt_goal_call_gt_frame(monkeypatch):
    """Precedence stays measured-scoreboard > goal call > two-signal attestation."""
    goal_reply = (
        '{"goalConfirmed": "confirmed_goal", "confidence": 0.9, '
        '"reason": "ball in the net, crossed the line", '
        '"evidence": {"ballInNet": true, "ballTrajectoryCrossedLine": true}}'
    )
    # scoreboard + goal-call transcript + two-signal frame read -> scoreboard
    resp = _confirm_with(
        monkeypatch,
        reply=goal_reply,
        transcript=_GOAL_CALLS[1][1],
        scoreboard_changed=True,
    )
    assert resp["corroborationSource"] == "scoreboard"
    # goal call + two-signal frame read (no scoreboard) -> audio_text
    resp = _confirm_with(monkeypatch, reply=goal_reply, transcript=_GOAL_CALLS[1][1])
    assert resp["corroborationSource"] == "audio_text"
    # no scoreboard, no goal call, two-signal frame read -> frame_attestation
    resp = _confirm_with(monkeypatch, reply=goal_reply, transcript=_STAT_WINDOWS[0][1])
    assert resp["corroborationSource"] == "frame_attestation"
    assert resp["corroborated"] is True


# --- AC4: the fix costs no extra inference ---------------------------------


@pytest.mark.parametrize("transcript", [_STAT_WINDOWS[2][1], _GOAL_CALLS[0][1], ""])
def test_confirm_pass_call_count_is_unchanged_by_the_detector(monkeypatch, transcript):
    """Cost per decide is unchanged: the detector is pure string matching, so
    the pass still makes exactly ONE gemma call (and one ASR call when audio
    context is available) regardless of how the transcript classifies."""
    monkeypatch.setenv("DECIDE_CONFIRM_ENABLED", "1")
    monkeypatch.setenv("AUDIO_CONTEXT", "1")
    monkeypatch.setattr(cf, "_asr_url", lambda: "http://asr:9999")
    asr_calls = []
    gemma_calls = []

    def _asr(*a, **k):
        asr_calls.append(1)
        return (transcript, None)

    def _gemma(*a, **k):
        gemma_calls.append(k.get("prompt") or (a[1] if len(a) > 1 else ""))
        return (
            '{"goalConfirmed": "not_goal", "confidence": 0.5, '
            '"reason": "no goal", "evidence": {}}'
        )

    monkeypatch.setattr(cf, "transcribe_audio", _asr)
    monkeypatch.setattr(cf, "_call_gemma", _gemma)
    run_confirmation_pass(
        {
            "stage1": _stage1_goal(),
            "eventType": "GOAL",
            "frames": [{"base64": "x"}],
            "audioB64": "AAA",
        }
    )
    assert len(gemma_calls) == 1
    assert len(asr_calls) == 1
