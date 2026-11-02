"""ADAAAA-7754 — the per-type game-profile contract.

Covers the issue's acceptance criteria:

- soccer is the seeded default and the default profile reproduces today's
  firing set (no soccer regression);
- the `no-zone` fallback disables the detection-in-zone trigger and runs the
  perceive pass cleanly;
- a non-default per-type audio threshold changes the firing set, and the default
  profile reproduces today's firing set on a fixture;
- a profile with only motion + audio NEVER evaluates zone logic (asserted as
  absence, with a positive control so the assertion is not vacuous);
- the tracking caps stay 3 live / 8 VOD (schema ceiling 8) through the profile;
- the eval harnesses take the profile instead of hard-coded soccer constants.
"""
import base64
import os
import sys

import numpy as np
import pytest

from app import handle_control, process_audio, process_frame, stage_a
from app import florence
from app.audio_gate import AudioEnergyGate, GateConfig
from app.game_profile import (
    ALL_TRIGGERS,
    BASKETBALL_PROFILE,
    DEFAULT_PROFILE,
    ORACLE_SCOREBOARD_OCR,
    SOCCER_PROFILE,
    TRIGGER_AUDIO,
    TRIGGER_BALL_VELOCITY,
    TRIGGER_DETECTION_IN_ZONE,
    TRIGGER_MOTION,
    AudioThresholds,
    GameProfile,
    ScoreboardOcrOracle,
    TrackingRoster,
    TriggerSubset,
    ZoneModel,
    ZoneSpec,
    load_game_profile,
    profile_for,
    unmeasured_profile,
)
from app.session import (
    SessionRegistry,
    SessionState,
    apply_game_profile,
    mode_capacity,
    sync_game_profile,
)
from app.tracker import IoUTracker

_REPO_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..")
)

SEVEN_FIELDS = {
    "vocabulary",
    "zoneModel",
    "corroborationOracle",
    "triggerSubset",
    "audioThresholds",
    "trackingRoster",
    "evalSet",
}


# --- fixtures ---------------------------------------------------------------


def _pcm(energy: float, n: int = 800) -> str:
    """base64 int16 mono LE PCM whose RMS is approximately ``energy``."""
    arr = np.full(n, int(round(energy * 32768.0)), dtype=np.int16)
    return base64.b64encode(arr.tobytes()).decode()


def _audio_fixture():
    """A deterministic synthetic stream: quiet floor + two short roars.

    Chosen so the shipped defaults fire twice (one candidate per roar) while a
    stricter per-type operating point fires zero — the same fixture therefore
    proves both "default reproduces today" and "per-type thresholds change the
    firing set".
    """
    chunks = []
    ts = 0.0

    def segment(energy: float, seconds: float) -> None:
        nonlocal ts
        for _ in range(int(round(seconds * 10))):
            chunks.append((_pcm(energy), round(ts, 1)))
            ts = round(ts + 0.1, 1)

    segment(0.02, 10.0)  # calibration + one full lookback window of ambient floor
    segment(0.03, 0.6)   # roar 1
    segment(0.02, 2.4)   # quiet beyond cooldown_s
    segment(0.03, 0.6)   # roar 2
    segment(0.02, 2.0)
    return chunks


def _audio_fires(state) -> list:
    fires = []
    for samples, ts in _audio_fixture():
        cand, _series, _whistle = process_audio(state, -1, ts, samples)
        if cand is not None:
            fires.append((cand["audio"]["kind"], cand["audio"]["ts"]))
    return fires


def _bound_session(profile: GameProfile, clip_path: str = "") -> SessionState:
    reg = SessionRegistry(max_sessions=1)
    state = reg.get_or_create("sess-profile", "", clip_path)
    apply_game_profile(state, profile, explicit=True)
    return state


class _FakeDetector:
    """Minimal stand-in for the Florence detector (no model, no GPU)."""

    def __init__(self, objects):
        self._objects = objects
        self.stats = None
        self.requested_vocab = []

    def load(self):  # pragma: no cover - not used on the fake path
        pass

    def detect(self, image, vocabulary=None):
        self.requested_vocab.append(list(vocabulary or []))
        return [dict(o) for o in self._objects]

    def ocr(self, image, roi=None):
        return []


def _run_frame(monkeypatch, state, objects, seq: int = 1, ts: float = 1.0):
    detector = _FakeDetector(objects)
    monkeypatch.setattr("app.get_detector", lambda _ref=None: detector)
    monkeypatch.setattr(florence, "get_detector", lambda _ref=None: detector)
    state.last_rgb = np.zeros((60, 80, 3), dtype=np.uint8)
    return process_frame(state, seq, ts, "ix.")


# --- 1. the contract -------------------------------------------------------


def test_profile_carries_the_seven_approved_fields():
    d = SOCCER_PROFILE.to_dict()
    assert SEVEN_FIELDS <= set(d)
    assert d["corroborationOracle"] == ORACLE_SCOREBOARD_OCR
    assert d["evalSet"] is not None and d["measured"] is True


def test_soccer_is_the_seeded_default_and_the_reference_oracle():
    assert DEFAULT_PROFILE is SOCCER_PROFILE
    assert load_game_profile("soccer") is SOCCER_PROFILE
    assert load_game_profile(None).key == "safe-default"
    assert isinstance(SOCCER_PROFILE.corroboration_oracle, ScoreboardOcrOracle)
    # Every other oracle seam is named but belongs to a later issue.
    from app.game_profile import ORACLE_AUDIO_TEXT, ORACLE_HUD_PARSE, ORACLE_KINDS

    assert ORACLE_KINDS == (ORACLE_SCOREBOARD_OCR, ORACLE_HUD_PARSE, ORACLE_AUDIO_TEXT)


def test_unregistered_profile_key_is_never_silently_soccer():
    with pytest.raises(KeyError):
        load_game_profile("tennis")
    # non-strict degrades to the safe default, never to soccer's numbers
    assert load_game_profile("tennis", strict=False).key == "safe-default"
    # a canned but unmeasured type keeps its OWN vocabulary
    assert profile_for("tennis").key == "tennis"
    assert "racket" in profile_for("tennis").vocabulary
    assert profile_for("tennis").eval_set is None  # unmeasured
    # an unknown hint maps to the generic safe default (today's behaviour)
    assert profile_for("some-unknown-game").key == "safe-default"


def test_tennis_stays_unmeasured_until_a_rights_cleared_manifest_is_committed():
    """ADAAAA-7766: registration is tied to a real, rights-cleared manifest.

    Stage 1 of the tennis pass screened the open-licence corpora that carry
    match recordings and found no rights-cleared clip of >= 5 minutes of
    continuous match play, so `evals/tennis_val/VERDICT.md` records
    `not_captured` / `no rights-cleared broadcast sample`. Registering tennis in
    `PROFILES` without that manifest would invent the evidence the gate is
    missing, so this test keeps the door shut until the manifest exists; once it
    does, the registration assertions in the basketball test are the model.
    """
    manifest = os.path.join(_REPO_ROOT, "evals", "tennis_val", "label-manifest.json")
    if os.path.exists(manifest):
        pytest.skip("a tennis manifest is committed; the registration tests own that state")
    with pytest.raises(KeyError):
        load_game_profile("tennis")
    assert profile_for("tennis").eval_set is None
    assert profile_for("tennis").measured is False
    verdict = os.path.join(_REPO_ROOT, "evals", "tennis_val", "VERDICT.md")
    with open(verdict, encoding="utf-8") as fh:
        assert "not_captured" in fh.read()


def test_basketball_is_registered_and_measured_against_its_own_eval_set():
    """ADAAAA-7765: basketball resolves now, and it carries its own held-out set.

    The mechanical core of the issue: the strict `load_game_profile` KeyError
    for basketball is gone because the type has a real committed manifest.
    """
    prof = load_game_profile("basketball")
    assert prof.key == "basketball"
    assert prof is profile_for("NBA")  # registered beats the canned fallback
    assert prof.eval_set is not None and prof.measured is True
    assert prof.eval_set.manifest == "evals/basketball_val/label-manifest.json"
    # the eval label space is the scoring-window class that was actually
    # labelled, NOT the deployed per-frame detection roster
    assert prof.eval_set.vocabulary == ("score",)
    assert prof.vocabulary == ("basketball", "player", "hoop", "referee")
    # no measured geometry or tuning was claimed for the type
    assert prof.zone_model.is_no_zone
    assert prof.triggers.names() == (TRIGGER_AUDIO,)
    assert prof.audio_thresholds == AudioThresholds()
    # the score overlay is the type's corroboration seam
    assert isinstance(prof.corroboration_oracle, ScoreboardOcrOracle)
    # 3 live / 8 VOD caps hold, and the roster fits the live cap
    assert prof.tracking_roster.live_capacity == 3
    assert prof.tracking_roster.vod_capacity == 8
    assert len(prof.tracking_roster.labels) <= prof.tracking_roster.live_capacity
    # the reference states the coverage the set actually achieved (label revision 2)
    ref = prof.eval_set.reference
    assert ref["scoringEvents"] == 15 and ref["nonEventWindows"] == 13
    assert ref["detectionSlice"] is None  # no detection labels: detect_precision N/A
    # the measured audio run is recorded as data, including that it MISSED the
    # ceiling: the flag must never be read as "basketball is ready"
    run = ref["audioHarness"]
    assert run["events"] == 15 and run["candidates"] == 80
    assert run["recall"] == pytest.approx(4 / 15)
    assert run["fpRate"] == pytest.approx(74 / 80)
    assert run["fpCeiling"] == 0.10 and run["fpCeilingMet"] is False
    # the ceiling is missed even under a generous label tolerance (RESULTS.md §1a),
    # so the verdict is not an artefact of the 1 fps instant grid
    assert run["fpRate"] > 5 * run["fpCeiling"]



def test_basketball_eval_set_matches_the_committed_labels():
    """The registered numbers ARE the committed labels' numbers (ADAAAA-7765 rev 2).

    Guardrail for the drift class QA found on ADAAAA-7770: constants in code that
    disagree with `evals/basketball_val/*.json` after a label revision.
    """
    import json

    bb = os.path.join(_REPO_ROOT, "evals", "basketball_val")
    man = json.load(open(os.path.join(bb, "label-manifest.json")))
    labels = json.load(open(os.path.join(bb, "audio-labels.json")))

    events = [w for w in man["windows"] if w["ground_truth"] == "score"]
    negs = [w for w in man["windows"] if w["ground_truth"] == "no_score"]
    ev = BASKETBALL_PROFILE.eval_set
    assert ev is not None
    ref = ev.reference
    assert len(events) == ref["scoringEvents"]
    assert len(negs) == ref["nonEventWindows"]
    assert (sum(1 for w in negs if w["window_class"] == "live_play_no_score")
            == ref["livePlayNonEventWindows"])

    seg = man["video"]["segment"]["start_s"]
    instants = [w["instant"] - seg for w in events]
    # the audio corpus is exactly the manifest's instants, rebased onto the clip
    assert labels["classes"][0]["onsets"] == instants

    # each instant is the FIRST frame of the state it names, and the state
    # intervals tile the whole clip (so every second is classified once)
    states = man["coverage"]["state_intervals_clip_s"]
    for w in events:
        assert states[w["score_after"]][0] == w["instant"] - seg, w["id"]
    bounds = sorted(states.values())
    assert bounds[0][0] == 0
    assert bounds[-1][1] == man["coverage"]["clip_span_s"] - 1
    for (a1, b1), (a2, _b2) in zip(bounds, bounds[1:]):
        assert b1 + 1 == a2, (a1, b1, a2)

    # no non-event window may contain a scoring transition
    for w in negs:
        a, b = w["t_start"] - seg, w["t_end"] - seg
        assert not any(a <= t <= b for t in instants), w["id"]
        # its recorded score is the state that contains the window
        containing = [k for k, (s, e) in states.items() if s <= a and b <= e]
        assert containing == [w["score"]], w["id"]


def test_unmeasured_profile_has_no_zone_and_audio_only():
    prof = unmeasured_profile("tennis", ["tennis ball", "player", "racket", "net"])
    assert prof.zone_model.is_no_zone
    assert prof.triggers.names() == (TRIGGER_AUDIO,)
    assert prof.measured is False


def test_trigger_subset_rejects_unknown_triggers():
    with pytest.raises(ValueError):
        TriggerSubset.of("motion", "telepathy")
    assert TriggerSubset.of(*ALL_TRIGGERS).names() == ALL_TRIGGERS


# --- 2. soccer no-regression ----------------------------------------------


def test_soccer_profile_reproduces_todays_constants():
    """The default profile IS today's configuration, not an approximation."""
    assert SOCCER_PROFILE.vocabulary == tuple(florence._GAME_VOCABULARIES["soccer"])
    # GateConfig's shipped defaults (the values the gate has today)
    assert not SOCCER_PROFILE.audio_thresholds.differs_from(GateConfig())
    assert SOCCER_PROFILE.audio_thresholds.as_gate_kwargs() == {
        "burst_ratio": 1.3,
        "swell_ratio": 1.3,
        "burst_min_frames": 3,
        "swell_seconds": 2.5,
        "cooldown_s": 2.0,
        "max_latency_s": 5.0,
    }
    # today's firing set: ADAAAA-7108 removed the soccer motion/zone candidates,
    # so the shipped trigger subset is the audio path only.
    assert SOCCER_PROFILE.triggers.names() == (TRIGGER_AUDIO,)
    assert not SOCCER_PROFILE.has_frame_triggers()


def test_default_profile_reproduces_todays_firing_set_on_a_fixture():
    """The session's default-profile gate fires exactly where a bare
    GateConfig() gate fires on the same PCM fixture."""
    reference = AudioEnergyGate(GateConfig())
    expected = []
    for samples, ts in _audio_fixture():
        sig = reference.update(
            np.frombuffer(base64.b64decode(samples), dtype=np.int16).astype(np.float64), ts=ts
        )
        if sig is not None:
            expected.append((sig.kind, sig.ts))
    assert len(expected) == 2, expected  # the fixture's two roars

    state = _bound_session(DEFAULT_PROFILE)
    assert _audio_fires(state) == expected


def test_soccer_profile_is_bound_from_the_game_hint():
    state = SessionState(session_id="s-hint")
    state.game_hint = "FA Cup final"
    sync_game_profile(state)
    assert state.game_profile is SOCCER_PROFILE  # already the default: no change

    state.game_hint = "NBA"
    assert sync_game_profile(state) is True
    assert state.game_profile.key == "basketball"
    assert "hoop" in state.game_profile.vocabulary

    # unknown hint -> the generic closed roster, never soccer's
    state.game_hint = "some-unknown-game"
    sync_game_profile(state)
    assert state.game_profile.key == "safe-default"


def test_configure_binds_an_explicit_profile_and_unknown_never_wins():
    """Control `configure` binds the registered type; an unknown key is logged
    and dropped rather than silently substituting soccer."""
    state = SessionState(session_id="s-cfg")
    state.game_hint = "NBA"
    sync_game_profile(state)
    assert state.game_profile.key == "basketball"

    ack = handle_control(state, {"type": "configure", "gameProfile": "soccer"})
    assert ack["ok"] is True
    assert state.game_profile is SOCCER_PROFILE
    assert state.game_profile_explicit is True

    handle_control(state, {"type": "configure", "gameProfile": "tennis"})
    assert state.game_profile is SOCCER_PROFILE  # unregistered: ignored

    # an explicit choice is not reverted by a later hint sync
    state.game_hint = "NBA"
    assert sync_game_profile(state) is False
    assert state.game_profile is SOCCER_PROFILE


# --- 3. per-type audio thresholds ----------------------------------------


def test_non_default_audio_thresholds_change_the_firing_set():
    strict = SOCCER_PROFILE.with_audio_thresholds(
        burst_ratio=1.8, swell_ratio=1.8, burst_min_frames=5
    )
    state = _bound_session(strict)
    # the binding rebuilt the gate at the type's operating point
    assert state.audio_gate.cfg.burst_ratio == 1.8
    assert state.audio_gate.cfg.burst_min_frames == 5
    assert _audio_fires(state) == []


def test_two_profiles_score_the_same_audio_differently():
    """Thresholds are per type, not one global set: same PCM, two firing sets."""
    default_state = _bound_session(DEFAULT_PROFILE)
    strict_state = _bound_session(
        SOCCER_PROFILE.with_audio_thresholds(
            burst_ratio=1.8, swell_ratio=1.8, burst_min_frames=5
        )
    )
    assert len(_audio_fires(default_state)) == 2
    assert _audio_fires(strict_state) == []


def test_audio_trigger_is_routed_through_the_profile():
    """A profile that does not enable `audio` runs no gate and emits nothing."""
    no_audio = SOCCER_PROFILE.with_triggers(TriggerSubset.of(TRIGGER_MOTION))
    state = _bound_session(no_audio)
    assert _audio_fires(state) == []
    assert state.audio_gate.baseline is None  # the gate never advanced
    assert state.whistle_candidates == 0


# --- 4. the no-zone fallback ---------------------------------------------


def _no_zone_profile(*triggers) -> GameProfile:
    return GameProfile(
        key="no-zone-test",
        vocabulary=("player", "head"),
        zone_model=ZoneModel.no_zone(),
        corroboration_oracle=None,
        triggers=TriggerSubset.of(*triggers),
        audio_thresholds=AudioThresholds(),
        tracking_roster=TrackingRoster(labels=("player", "head")),
        eval_set=None,
    )


def test_no_zone_profile_disables_the_zone_trigger_without_raising():
    prof = _no_zone_profile(
        TRIGGER_MOTION, TRIGGER_AUDIO, TRIGGER_DETECTION_IN_ZONE, TRIGGER_BALL_VELOCITY
    )
    assert prof.zone_model.is_no_zone
    # auto-disabled by the profile itself, not by a caller-side branch
    assert not prof.allows(TRIGGER_DETECTION_IN_ZONE)
    assert prof.triggers.names() == (
        TRIGGER_MOTION,
        TRIGGER_AUDIO,
        TRIGGER_BALL_VELOCITY,
    )


def test_no_zone_profile_runs_the_perceive_pass_cleanly(monkeypatch):
    """A no-zone type starts the pass, reports observations, and never raises."""
    zone_calls = []
    monkeypatch.setattr(
        stage_a,
        "detection_in_zone_hits",
        lambda *a, **k: zone_calls.append((a, k)) or [],
    )
    prof = _no_zone_profile(TRIGGER_AUDIO, TRIGGER_DETECTION_IN_ZONE)
    state = _bound_session(prof)
    obs, cand = _run_frame(
        monkeypatch,
        state,
        [{"label": "player", "confidence": 1.0, "bbox": [0.70, 0.40, 0.80, 0.80]}],
    )
    assert obs["type"] == "observation"
    assert obs["objects"]
    assert cand is None
    assert zone_calls == []  # zone logic was never evaluated


# --- 5. trigger subset enforced ------------------------------------------


def _zone_model():
    # geometry that DOES contain the detection below: if zone logic ran, the
    # trigger would fire. The absence assertion is therefore meaningful.
    return ZoneModel(
        kind="goal-mouth",
        zones=(ZoneSpec(name="goal-mouth", normalized=(0.6, 0.3, 1.0, 0.9)),),
    )


def test_motion_audio_profile_never_evaluates_zone_logic(monkeypatch):
    zone_calls = []
    monkeypatch.setattr(
        stage_a,
        "detection_in_zone_hits",
        lambda *a, **k: zone_calls.append((a, k)) or [],
    )
    monkeypatch.setattr(
        stage_a,
        "_plan_zone_model",
        lambda *a, **k: zone_calls.append("plan-zones") or ZoneModel.no_zone(),
    )
    prof = GameProfile(
        key="motion-audio-test",
        vocabulary=("player", "head"),
        zone_model=_zone_model(),
        corroboration_oracle=None,
        triggers=TriggerSubset.of(TRIGGER_MOTION, TRIGGER_AUDIO),
        audio_thresholds=AudioThresholds(),
        tracking_roster=TrackingRoster(labels=("player", "head")),
        eval_set=None,
    )
    state = _bound_session(prof)
    obs, cand = _run_frame(
        monkeypatch,
        state,
        [{"label": "player", "confidence": 1.0, "bbox": [0.70, 0.40, 0.80, 0.80]}],
    )
    assert not prof.allows(TRIGGER_DETECTION_IN_ZONE)
    assert zone_calls == []  # absent, not merely harmless
    assert obs["type"] == "observation"
    assert cand is None


def test_zone_trigger_positive_control(monkeypatch):
    """Same frame/profile with the zone trigger ENABLED does fire — proving the
    absence assertion above is not vacuous."""
    prof = GameProfile(
        key="zone-test",
        vocabulary=("player", "head"),
        zone_model=_zone_model(),
        corroboration_oracle=None,
        triggers=TriggerSubset.of(TRIGGER_DETECTION_IN_ZONE),
        audio_thresholds=AudioThresholds(),
        tracking_roster=TrackingRoster(labels=("player", "head")),
        eval_set=None,
    )
    state = _bound_session(prof)
    obs, cand = _run_frame(
        monkeypatch,
        state,
        [{"label": "player", "confidence": 1.0, "bbox": [0.70, 0.40, 0.80, 0.80]}],
    )
    assert cand is not None and cand["trigger"] == TRIGGER_DETECTION_IN_ZONE
    assert obs["stageATriggers"][0]["hits"][0]["zone"] == "goal-mouth"


def test_motion_and_ball_velocity_sites_are_real(monkeypatch):
    from app.stage_a import BALL_VELOCITY_SURGE_RATIO, MOTION_MIN_STEP, motion_fire

    class _Track:
        def __init__(self, step):
            self.step_hist = [(1.0, step)]
            self.last_step_disp = step

    assert MOTION_MIN_STEP == IoUTracker.FAST_STEP
    assert motion_fire([_Track(MOTION_MIN_STEP + 0.01)]) is not None
    assert motion_fire([_Track(MOTION_MIN_STEP / 2)]) is None
    from app.stage_a import ball_velocity_fire

    assert ball_velocity_fire({"speedMps": 1.0}, [1.0, 1.0]) is None
    assert (
        ball_velocity_fire(
            {"speedMps": 1.0 * BALL_VELOCITY_SURGE_RATIO + 0.1}, [1.0, 1.0, 1.0]
        )
        is not None
    )


# --- 6. tracking caps intact ---------------------------------------------


def test_tracking_caps_are_3_live_8_vod_through_the_profile():
    from app import tracker as tracker_mod
    from app import tracking_plan as plan_mod

    roster = SOCCER_PROFILE.tracking_roster
    assert (roster.live_capacity, roster.vod_capacity) == (3, 8)
    assert roster.capacity_for_clip("") == 3
    assert roster.capacity_for_clip("/clips/job.webm") == 8
    assert mode_capacity("", SOCCER_PROFILE) == 3
    assert mode_capacity("/clips/job.webm", SOCCER_PROFILE) == 8
    # same charter numbers the rest of the repo enforces (schema ceiling = 8)
    assert (roster.live_capacity, roster.vod_capacity) == (
        tracker_mod.LIVE_MAX_TRACKS,
        tracker_mod.VOD_MAX_TRACKS,
    ) == (
        plan_mod.LIVE_MAX_TRACKS,
        plan_mod.VOD_MAX_TRACKS,
    )


def test_tracking_caps_are_ceilings_and_sessions_get_them():
    # the caps are a ceiling, never a data-driven knob
    with pytest.raises(ValueError):
        TrackingRoster(live_capacity=4, vod_capacity=8)
    with pytest.raises(ValueError):
        TrackingRoster(live_capacity=3, vod_capacity=9)

    reg = SessionRegistry(max_sessions=1)
    live = reg.get_or_create("sess-live", "", "")
    assert live.tracker.capacity == 3
    vod = reg.get_or_create("sess-vod", "", "/clips/job.webm")
    assert vod.tracker.capacity == 8


def test_profile_rebinding_moves_the_track_capacity():
    state = SessionState(session_id="s-cap")
    state.tracker = IoUTracker(capacity=3)
    # the session defaults to the reference profile, so this bind is a no-op
    assert apply_game_profile(state, SOCCER_PROFILE, explicit=True) is False
    assert state.tracker.capacity == 3
    state.clip_path = "/clips/job.webm"
    apply_game_profile(
        state,
        GameProfile(
            key="vod-test",
            vocabulary=(),
            zone_model=ZoneModel.no_zone(),
            corroboration_oracle=None,
            triggers=TriggerSubset.of(TRIGGER_AUDIO),
            audio_thresholds=AudioThresholds(),
            tracking_roster=TrackingRoster(live_capacity=3, vod_capacity=8),
            eval_set=None,
        ),
        explicit=True,
    )
    assert state.tracker.capacity == 8


# --- 7. harnesses read the profile --------------------------------------


def test_eval_harnesses_take_the_profile_not_soccer_constants():
    evals_dir = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "evals")
    )
    sys.path.insert(0, evals_dir)
    try:
        import detect_precision as dp
        import measure_audio_recall as mar
        import track_metrics as tm
    finally:
        sys.path.remove(evals_dir)

    # detection harness: label space comes from the profile's eval set
    assert dp.PROFILE.key == "soccer"
    assert SOCCER_PROFILE.eval_set is not None
    assert dp.DEFAULT_VOCAB == list(SOCCER_PROFILE.eval_set.vocabulary)

    # audio harness: the NEW operating point is the profile's thresholds
    cfg = mar.profile_gate_config(mar.load_profile("soccer"), 0.1)
    assert cfg.burst_ratio == SOCCER_PROFILE.audio_thresholds.burst_ratio
    assert cfg.cooldown_s == SOCCER_PROFILE.audio_thresholds.cooldown_s
    assert cfg.max_latency_s == SOCCER_PROFILE.audio_thresholds.max_latency_s

    # tracking harness: caps come from the profile roster
    assert tm.PROFILE is SOCCER_PROFILE
    assert tm.PROFILE.tracking_roster.capacity("live") == 3
    assert tm.PROFILE.tracking_roster.capacity("vod") == 8


# --- 8. american football (ADAAAA-7767, per-type step 2) ------------------


def test_american_football_is_registered_and_measured_against_its_own_eval_set():
    """ADAAAA-7767: the strict KeyError for american football is gone.

    The type carries a real committed manifest with 11 frame-verified scoring
    plays, declares the no-zone fallback, and both canonical spellings resolve
    to the SAME measured object (never to an unmeasured duplicate).
    """
    prof = load_game_profile("american football")
    assert prof.key == "american football"
    assert prof.measured is True
    assert prof.eval_set is not None
    assert prof.eval_set.manifest == "evals/american_football_val/label-manifest.json"
    # the eval label space is the scoring-window class that was labelled, NOT
    # the deployed per-frame detection roster
    assert prof.eval_set.vocabulary == ("score",)
    assert prof.vocabulary == ("football", "player", "referee")

    # the legacy `football` hint is the same measured profile, not a duplicate
    assert load_game_profile("football") is prof
    assert profile_for("football") is prof
    # league aliases resolve through canonical_sport to the same object
    assert profile_for("NFL") is prof
    assert profile_for("gridiron") is prof
    assert profile_for("college football") is prof
    # and the soccer roster is untouched by the football registration
    assert profile_for("Premier League") is SOCCER_PROFILE


def test_american_football_no_zone_drops_the_zone_trigger_at_construction():
    """`no-zone` is a declared property of the type, not a failure.

    American football has no canned scoring zone and an end-zone model is out of
    scope, so the profile declares `no-zone` and `__post_init__` drops the
    detection-in-zone trigger even if data asks for it.
    """
    prof = load_game_profile("american football")
    assert prof.zone_model.is_no_zone
    assert prof.zone_model.zones == ()
    assert prof.triggers.names() == (TRIGGER_MOTION, TRIGGER_AUDIO)
    assert prof.allows(TRIGGER_DETECTION_IN_ZONE) is False
    # data that asks for the zone trigger anyway is auto-disabled, not raised
    forced = prof.with_triggers(
        TriggerSubset.of(TRIGGER_MOTION, TRIGGER_AUDIO, TRIGGER_DETECTION_IN_ZONE)
    )
    assert forced.allows(TRIGGER_DETECTION_IN_ZONE) is False
    # no oracle is claimed: the measured clip's score bug was shown to disagree
    # with itself (14 at half time, 13 in the third quarter)
    assert prof.corroboration_oracle is None


def test_american_football_eval_set_matches_the_committed_labels_and_run():
    """The registered numbers ARE the committed labels' numbers (drift guard)."""
    import json

    here = os.path.dirname(os.path.abspath(__file__))
    af = os.path.normpath(os.path.join(here, "..", "..", "..", "evals", "american_football_val"))
    man = json.load(open(os.path.join(af, "label-manifest.json")))
    labels = json.load(open(os.path.join(af, "audio-labels.json")))

    events = [w for w in man["windows"] if w["ground_truth"] == "score"]
    negs = [w for w in man["windows"] if w["ground_truth"] == "no_score"]
    prof = load_game_profile("american football")
    ev = prof.eval_set
    assert ev is not None
    ref = ev.reference
    assert len(events) == ref["scoringPlays"] == 11
    assert len(negs) == ref["nonEventWindows"] == 14
    assert man["coverage"]["scoring_floor_met"] is True

    # the onsets in the audio corpus are the manifest's instants
    cls = [c for c in labels["classes"] if c["id"] == "score_roar"][0]
    assert sorted(cls["onsets"]) == sorted(w["instant"] for w in events)
    assert len(cls["negatives"]) == len(negs)

    # the measured run is recorded as data, including that it MISSED the ceiling
    run = ref["audioHarness"]
    assert run["events"] == 11 and run["candidates"] == 1979
    assert run["recall"] == pytest.approx(1.0)
    assert run["fpRate"] == pytest.approx(1950 / 1979, abs=1e-4)
    assert run["labelRevision"] == 2
    assert run["recallAtDefaultWindow"] == pytest.approx(10 / 11, abs=1e-4)
    assert run["fpCeiling"] == 0.10 and run["fpCeilingMet"] is False
    # and it misses under a generous label tolerance too, so the verdict is not
    # an artefact of the score-bug update lag
    assert run["fpRateAtGenerousWindow"] > 5 * run["fpCeiling"]
    # no detection slice was invented for the type
    assert ref["detectionSlice"] is None
    # the certification is recorded as data and names the issue that gave it, so
    # a stale "awaiting re-certification" can never outlive the verdict
    assert ref["qaCertification"] == "pass (ADAAAA-7785, label revision 2)"
    assert "fpCeilingMet false" in ref["qaVerdict"]
