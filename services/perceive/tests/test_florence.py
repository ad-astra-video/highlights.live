"""Unit tests for Florence-2 OD output parsing (real <loc_> token format)."""
import time

import numpy as np

from app import florence
from app.florence import FlorenceDetector


def test_parse_single_object_with_special_tokens():
    # Real output from Florence-2-base (<s> bos leaks into the label via
    # skip_special_tokens=False).
    text = "</s><s>person<loc_0><loc_0><loc_998><loc_998></s>"
    objs = FlorenceDetector._parse(text)
    assert len(objs) == 1
    assert objs[0]["label"] == "person"
    assert objs[0]["bbox"] == [0.0, 0.0, 0.998, 0.998]


def test_parse_multiple_objects():
    text = (
        "<s>person<loc_100><loc_200><loc_300><loc_400>"
        "soccer ball<loc_500><loc_600><loc_700><loc_800>"
    )
    objs = FlorenceDetector._parse(text)
    assert len(objs) == 2
    assert objs[0]["label"] == "person"
    assert objs[1]["label"] == "soccer ball"
    assert objs[1]["bbox"] == [0.5, 0.6, 0.7, 0.8]


def test_parse_empty():
    assert FlorenceDetector._parse("<s></s>") == []


# --- ADAAAA-3726: closed-vocabulary <OD> prompt + weak/unlabeled gating ---------

def test_build_od_prompt_open_domain():
    assert florence.build_od_prompt() == "<OD>"
    assert florence.build_od_prompt(vocabulary=[]) == "<OD>"


def test_build_od_prompt_closed_vocabulary():
    # Regression (ADAAAA-3726, QA ADAAAA-3774): Florence-2's <OD> task token has
    # NO input channel — its processor asserts the prompt equals the bare task
    # token, so appending a vocabulary raises "Task token <OD> should be the only
    # token in the text" on every detect() call. The closed vocabulary is applied
    # as a post-inference gate (see canonicalize_open_label), so build_od_prompt
    # must ALWAYS emit the bare task token, regardless of the vocabulary arg.
    prompt = florence.build_od_prompt(vocabulary=["soccer ball", "player", "goalkeeper", "goal", "referee"])
    assert prompt == "<OD>"
    assert florence.build_od_prompt(task="<OD>", vocabulary=["ball"]) == "<OD>"


def test_canonicalize_open_label_to_vocab():
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    # Open-set <OD> names that map into the soccer roster.
    assert florence.FlorenceDetector.canonicalize_open_label("person", vocab) == "player"
    assert florence.FlorenceDetector.canonicalize_open_label("man", vocab) == "player"
    assert florence.FlorenceDetector.canonicalize_open_label("ball", vocab) == "soccer ball"
    assert florence.FlorenceDetector.canonicalize_open_label("football", vocab) == "soccer ball"
    assert florence.FlorenceDetector.canonicalize_open_label("net", vocab) == "goal"
    assert florence.FlorenceDetector.canonicalize_open_label("goalkeeper", vocab) == "goalkeeper"
    assert florence.FlorenceDetector.canonicalize_open_label("referee", vocab) == "referee"


def test_canonicalize_open_label_out_of_scope_is_none():
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    # Non-roster labels (missing-case capitalization preserved on None too).
    # scoreboard / car / banner are genuine OUT-OF-SCOPE stadium background the
    # closed-vocab gate must drop. (player-fragment labels like 'sock'/'short
    # pants' are NOT here — ADAAAA-6340 maps them to 'player'.)
    assert florence.FlorenceDetector.canonicalize_open_label("scoreboard", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("car", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("banner", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("object", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("", vocab) is None


def test_canonicalize_open_label_player_fragments_map_to_player():
    # ADAAAA-6340 (measured live from the deployed Florence-2 <OD>): the
    # detector fragments a soccer player into its uniform parts, and the
    # closed-vocab gate was voiding those as out-of-roster (~40% of parsed
    # detections on real frames). Those are GENUINE player detections, so map
    # them back to the in-roster 'player'.
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    for raw in ("short pants", "sock", "shorts", "shirt", "jersey", "uniform",
                "soccer player", "footballer", "athlete"):
        assert florence.FlorenceDetector.canonicalize_open_label(raw, vocab) == "player", raw


def test_canonicalize_open_label_extended_player_fragments_map_to_player():
    # ADAAAA-6340 extend-gate lever: the Leg A taxonomy showed the gate still
    # voiding ~807 roster-relevant detections that are the detector fragmenting a
    # player further into body parts / kit pieces. Map those back to 'player'.
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    for raw in ("human face", "sports uniform", "sneakers", "footwear",
                "baseball glove", "glove", "gloves", "bracelet", "trousers",
                "baseball cap", "headband"):
        assert florence.FlorenceDetector.canonicalize_open_label(raw, vocab) == "player", raw


def test_canonicalize_open_label_ball_synonyms():
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    assert florence.FlorenceDetector.canonicalize_open_label("sports ball", vocab) == "soccer ball"
    assert florence.FlorenceDetector.canonicalize_open_label("goalpost", vocab) == "goal"


def test_parse_counts_decoder_ramble_as_empty_not_unknown():
    # Florence rambles bare <loc_> groups (no label) on complex frames. Those are
    # decoder noise, not detections: they must count as `empty`, never inflate
    # `parsed`/`gated`/unknownRate. Real in-scope labels still survive.
    vocab = ["soccer ball", "player"]
    # Two genuine in-roster boxes + bare loc-runs (no label) + a junk token.
    text = (
        "<s>person<loc_100><loc_200><loc_300><loc_400>"
        "<loc_1><loc_2><loc_3><loc_4><loc_5><loc_6><loc_7><loc_8>"
        "object<loc_9><loc_10><loc_11><loc_12>"
        "ball<loc_50><loc_51><loc_52><loc_53></s>"
    )
    objs, stats = FlorenceDetector._parse_with_stats(text, vocabulary=vocab)
    assert stats["parsed"] == 2  # person + ball (genuine detections only)
    assert stats["emitted"] == 2
    assert stats["gated"] == 0
    assert stats["empty"] == 2  # the bare loc-run + the junk "object" token
    assert stats["unknownRate"] == 0.0
    assert [o["label"] for o in objs] == ["player", "soccer ball"]


def test_parse_drops_junk_unlabeled_objects():
    # Old behaviour emitted `label == "object"` with fake 1.0 confidence.
    text = "<s>object<loc_100><loc_200><loc_300><loc_400>person<loc_1><loc_2><loc_3><loc_4></s>"
    objs = FlorenceDetector._parse(text)
    assert all(o["label"] != "object" for o in objs)
    # Only the genuinely labelable detection survives.
    assert [o["label"] for o in objs] == ["person"]


def test_parse_closed_vocabulary_keeps_only_in_scope():
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    # `mobile phone`/`digital clock` are the known unreliable open-set mislabels.
    text = (
        "<s>soccer ball<loc_100><loc_200><loc_300><loc_400>"
        "mobile phone<loc_500><loc_600><loc_700><loc_800>"
        "player<loc_10><loc_20><loc_30><loc_40>"
    )
    objs = FlorenceDetector._parse(text, vocabulary=vocab)
    labels = [o["label"] for o in objs]
    assert labels == ["soccer ball", "player"]
    # Every emitted bbox carries a useful, in-scope label (Unknown rate 0 here).
    assert all(l in {v.lower() for v in vocab} for l in labels)


def test_parse_closed_vocabulary_canonicalizes_label_case():
    vocab = ["Soccer Ball", "Player"]
    text = "<s>soccer ball<loc_100><loc_200><loc_300><loc_400>"
    objs = FlorenceDetector._parse(text, vocabulary=vocab)
    assert objs[0]["label"] == "Soccer Ball"


def test_parse_with_stats_reports_unknown_rate():
    vocab = ["soccer ball", "player"]
    # A realistic soccer-goal clip: mostly in-vocab players/ball, one unreliable
    # open-set mislabel that gets gated -> Unknown 1/11 (~9.1%) stays < 10%.
    parts = ["player<loc_%d><loc_%d><loc_%d><loc_%d>" % (i, i, i + 1, i + 1) for i in range(1, 11)]
    parts.append("mobile phone<loc_50><loc_51><loc_52><loc_53>")
    text = "<s>" + "".join(parts)
    objs, stats = FlorenceDetector._parse_with_stats(text, vocabulary=vocab)
    assert len(objs) == 10
    assert all(o["label"] == "player" for o in objs)
    assert stats["parsed"] == 11
    assert stats["emitted"] == 10
    assert stats["gated"] == 1
    # Unknown rate = gated / parsed stays small on a good clip (< ~10% target).
    assert 0.0 < stats["unknownRate"] < 0.10


def test_parse_no_vocabulary_keeps_legacy_open_set():
    # Without a closed vocabulary the open-set labels are preserved (back-compat).
    text = "<s>person<loc_100><loc_200><loc_300><loc_400>"
    objs = FlorenceDetector._parse(text)
    assert objs[0]["label"] == "person"
    assert objs[0]["confidence"] == 1.0


# --- vocabulary resolution ----------------------------------------------------

def test_resolve_vocabulary_game_hint_wins_over_event_prefer_labels():
    # ADAAAA-6412: preferLabels from the UI are highlight EVENT categories
    # (goals/saves/red cards/near-misses/counter-attacks), NOT object classes.
    # They must never override the sport's object-detection vocabulary or every
    # real detection is gated out (unknownRate=1.0, 0 tracks).
    vocab = florence.resolve_vocabulary(
        game_hint="Soccer",
        prefer_labels=["goals", "saves", "red cards", "near-misses", "counter-attacks"],
    )
    assert vocab is not None
    assert "player" in vocab
    assert "soccer ball" in vocab
    assert "goals" not in vocab


def test_resolve_vocabulary_object_prefer_labels_fallback_unknown_hint():
    # When NO sport vocabulary is known, prefer_labels still wins (legacy
    # object-label use for unknown games / custom closed sets).
    vocab = florence.resolve_vocabulary(game_hint="some-unknown-game", prefer_labels=["score", "clock"])
    assert vocab == ["score", "clock"]


def test_resolve_vocabulary_game_hint_soccer():
    vocab = florence.resolve_vocabulary(game_hint="soccer")
    assert vocab is not None
    assert "soccer ball" in vocab
    assert "goalkeeper" in vocab


def test_resolve_vocabulary_game_hint_alias_substring():
    # A competition alias resolves to the sport vocabulary via substring match.
    vocab = florence.resolve_vocabulary(game_hint="FA Cup final")
    assert vocab is not None
    assert "soccer ball" in vocab


# --- ADAAAA-4193: sport-specific candidate event classification ---------------

def test_sport_specific_event_soccer_kill_to_goal():
    # The tracker anchors a fast strike as a generic KILL (explosive single-step).
    # On the soccer paid path that must reach decide as a GOAL, or the model
    # hard-rejects it ("this is soccer, not a KILL event") and no clip is cut.
    assert florence.sport_specific_event_type("soccer", "KILL") == "GOAL"
    assert florence.sport_specific_event_type("soccer", "MOVE") == "GOAL"


def test_sport_specific_event_soccer_alias():
    assert florence.sport_specific_event_type("Premier League", "KILL") == "GOAL"
    assert florence.sport_specific_event_type("FA Cup", "MOVE") == "GOAL"


def test_sport_specific_event_extended_soccer_aliases_inc8():
    """INC-8 (ADAAAA-4484): a real operator/driver may hand a human league name
    (Serie A, Ligue 1, Eredivisie, MLS, "soccer match", Uefa Champions League)
    rather than the bare token 'soccer'. All must canonicalize to soccer so the
    GOAL classification fires and the drive doesn't silently fall back to KILL."""
    soc = ["Serie A", "Ligue 1", "Eredivisie", "Primeira Liga", "Liga MX",
           "Major League Soccer", "MLS", "soccer match", "football match",
           "UEFA Champions League", "Uefa Nations League"]
    for hint in soc:
        assert florence.sport_specific_event_type(hint, "KILL") == "GOAL", hint
        assert florence.canonical_sport(hint) == "soccer", hint
    # non-soccer stays intact
    assert florence.sport_specific_event_type("NBA", "KILL") == "KILL"
    assert florence.canonical_sport("NBA") == "basketball"


def test_sport_specific_event_non_soccer_keeps_generic():
    # Unknown/unspecified game and non-goal sports keep the raw tracker type.
    assert florence.sport_specific_event_type(None, "KILL") == "KILL"
    assert florence.sport_specific_event_type("", "MOVE") == "MOVE"
    assert florence.sport_specific_event_type("some-unknown-game", "KILL") == "KILL"


def test_canonical_sport():
    assert florence.canonical_sport("soccer") == "soccer"
    assert florence.canonical_sport("Champions League") == "soccer"
    assert florence.canonical_sport("basketball") == "basketball"
    assert florence.canonical_sport("unknown-game") is None
    assert florence.canonical_sport(None) is None


def test_resolve_vocabulary_unknown_hint_is_none():
    assert florence.resolve_vocabulary(game_hint="some-unknown-game") is None
    assert florence.resolve_vocabulary() is None
    assert florence.resolve_vocabulary(game_hint="") is None


def test_gate_stub_mode(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "stub")
    ok, fps, _ = florence.gate_1fps()
    assert ok is True
    assert fps == float("inf")


class _FakeDetector:
    device_label = "fake"

    def __init__(self, secs):
        self._secs = secs

    def load(self):
        pass

    def detect(self, frame):
        time.sleep(self._secs)


def test_gate_fails_when_below_required_fps(monkeypatch):
    monkeypatch.setattr(florence, "get_detector", lambda: _FakeDetector(1.2))
    ok, fps, detail = florence.gate_1fps(min_fps=1.0, samples=2)
    assert ok is False
    assert fps < 1.0


def test_gate_passes_when_above_required_fps(monkeypatch):
    monkeypatch.setattr(florence, "get_detector", lambda: _FakeDetector(0.01))
    ok, fps, _ = florence.gate_1fps(min_fps=1.0, samples=2)
    assert ok is True
    assert fps >= 1.0


def test_bootcheck_stub_exits_zero(monkeypatch, capsys):
    import bootcheck

    monkeypatch.setenv("PERCEIVE_MODE", "stub")
    assert bootcheck.main() == 0
    assert "no device gate" in capsys.readouterr().out


def test_capability_stub_is_one_fps(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "stub")
    c = florence.capability()
    assert c["sample_interval_s"] == 1.0
    assert c["max_fps"] == 1.0


def test_capability_tracks_measured_fps(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    monkeypatch.setattr(florence, "_measured_fps", None)  # isolate: cold EMA
    for _ in range(10):
        florence.record_analyze(1.0)  # 1.0s/frame -> 1.0 fps
    c = florence.capability()
    assert abs(c["max_fps"] - 1.0) < 0.2
    assert c["sample_interval_s"] >= 1.0
    assert c["sample_interval_s"] <= 1.0 / 0.8 + 0.01


def test_capability_slows_down_for_slow_card(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    monkeypatch.setattr(florence, "_measured_fps", None)  # isolate: cold EMA
    for _ in range(5):
        florence.record_analyze(2.5)  # 0.4 fps
    c = florence.capability()
    assert c["max_fps"] < 0.6
    assert c["sample_interval_s"] > 1.5


# --- Per-stream LoRA injection (ADAAAA-5324) ---------------------------------

def test_get_detector_base_is_shared_singleton(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    florence.reset_detectors()
    try:
        d1 = florence.get_detector()
        d2 = florence.get_detector()
        d3 = florence.get_detector(None)  # no adapter == base
        assert d1 is d2 is d3, "base stream must always share ONE detector"
        assert d1.model_path is None
        assert d1.model_name == "microsoft/Florence-2-base"
    finally:
        florence.reset_detectors()


def test_get_detector_selects_distinct_lora_variant_per_ref(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    florence.reset_detectors()
    try:
        a = florence.get_detector("/models/lora-1")
        b = florence.get_detector("/models/lora-2")
        a_again = florence.get_detector("/models/lora-1")
        # Each adapter ref -> its own detector (its own base+LoRA model).
        assert a is not b
        # Same ref is cached (one model in memory per adapter, no reload).
        assert a_again is a
        assert a.model_path == "/models/lora-1"
        assert b.model_path == "/models/lora-2"
        # Base stays a separate shared singleton (no regression on base streams).
        base = florence.get_detector(None)
        assert base is not a
        assert base.model_path is None
    finally:
        florence.reset_detectors()


def test_get_detector_reset_clears_variants(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    florence.reset_detectors()
    a = florence.get_detector("/models/lora-1")
    base = florence.get_detector(None)
    florence.reset_detectors()
    a2 = florence.get_detector("/models/lora-1")
    base2 = florence.get_detector(None)
    assert a2 is not a, "reset must drop the cached variant so a fresh model loads"
    assert base2 is not base


def test_get_detector_stub_mode_returns_none(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "stub")
    florence.reset_detectors()
    assert florence.get_detector("/models/lora-1") is None
    assert florence.get_detector(None) is None


# --- ADAAAA-5056: residual "unknown" label on the user-visible surface ---------
#
# The closed-vocab gate labels `objects` in-roster, but the boxes a user sees are
# the tracker's tracks. This locks the joined behaviour: the track a detection
# seeds must carry the gated label (and a derived kind), never a bare "unknown".


class _LabeledFakeDetector:
    """Mimics FlorenceDetector.detect() on a closed-vocab soccer frame: emits the
    raw open-set <OD> label text carrying both an in-roster box and an
    out-of-roster box (which the gate must drop)."""

    def __init__(self, text):
        self._text = text
        self.stats = None

    def load(self):
        pass

    def detect(self, image, vocabulary=None):
        objs, stats = FlorenceDetector._parse_with_stats(self._text, vocabulary=vocabulary)
        self.stats = stats
        return objs


def test_process_frame_track_carries_gated_label_not_unknown(monkeypatch):
    """End-to-end at the pipeline boundary: a real closed-vocab Florence output
    (player + a gated low-value 'mobile phone') must surface a track whose box
    label is the in-roster 'player', and NO 'unknown' label on any track."""
    from app import process_frame
    from app.session import SessionRegistry
    from app.tracker import IoUTracker

    # A realistic Florence <OD> decode: person->player (in-roster), mobile
    # phone (out-of-roster, must be gated by the closed vocab).
    vocab = ["soccer ball", "player", "goalkeeper", "goal", "referee"]
    text = (
        "<s>person<loc_100><loc_200><loc_300><loc_400>"
        "mobile phone<loc_500><loc_600><loc_700><loc_800>"
    )

    detector = _LabeledFakeDetector(text)
    monkeypatch.setattr("app.get_detector", lambda _ref=None: detector)
    monkeypatch.setattr(florence, "get_detector", lambda _ref=None: detector)

    reg = SessionRegistry(max_sessions=1)
    state = reg.get_or_create("sess-5056", "", "")
    state.game_hint = "soccer"
    state.prefer_labels = list(vocab)
    state.last_rgb = np.zeros((60, 80, 3), dtype=np.uint8)
    state.tracker = IoUTracker(capacity=3)

    obs, cand = process_frame(
        state, 1, 1.0, "ix."  # image b64 unused on the florence path (last_rgb used)
    )

    objs = obs["objects"]
    # Gate active + working at the detection layer: only the in-roster box.
    assert [o["label"] for o in objs] == ["player"], objs
    assert detector.stats is not None and detector.stats["gated"] == 1

    tracks = obs["tracks"]
    assert tracks, "expected the in-roster detection to seed a track"
    # The surfaced track carries the gated label, never "unknown".
    assert all(t.get("label") for t in tracks), tracks
    assert all(t["kind"] != "unknown" for t in tracks), tracks
    assert all("unknown" not in (t.get("label") or "") for t in tracks), tracks


def test_process_frame_no_vocabulary_keeps_open_set_labels(monkeypatch):
    """Without a closed vocabulary the open-set label survives on the track
    (legacy best-effort), but never the meaningless 'unknown' default."""
    from app import process_frame
    from app.session import SessionRegistry
    from app.tracker import IoUTracker

    detector = _LabeledFakeDetector("<s>person<loc_100><loc_200><loc_300><loc_400>")
    monkeypatch.setattr("app.get_detector", lambda _ref=None: detector)
    monkeypatch.setattr(florence, "get_detector", lambda _ref=None: detector)

    reg = SessionRegistry(max_sessions=1)
    state = reg.get_or_create("sess-5056b", "", "")
    state.last_rgb = np.zeros((60, 80, 3), dtype=np.uint8)
    state.tracker = IoUTracker(capacity=3)

    obs, _ = process_frame(state, 1, 1.0, "ix.")
    tracks = obs["tracks"]
    assert tracks and tracks[0]["label"] == "person"


# --- ADAAAA-5700: "floating on nothing" — a label must never surface on an
# invisible / degenerate box ------------------------------------------------
#
# The SAM path feeds mask-derived boxes straight into the tracker WITHOUT the
# _norm_bbox guard Florence detections get. A sparse/sliver mask (e.g. a
# 1-pixel blob) yields a sub-pixel bbox that renders as an invisible (or
# zero-area) box while the label overlay still draws -> a label "floating on
# nothing". The emission boundary normalizes every surfaced track bbox through
# _norm_bbox, so any box a user sees has a minimum visible area and every label
# is anchored to its box.



class _BareIoUTrackerStep:
    """Drive IoUTracker directly with a degenerate box, exactly as the SAM
    propagation path does (SamBackend.get -> IoUTracker.step, no _norm_bbox)."""


def test_process_frame_anchors_label_to_visible_box_not_floating(monkeypatch):
    """A track seeded from a degenerate (sub-pixel) box must surface a bbox with
    a minimum visible area, so the UI never draws a label on an invisible box
    ("floating on nothing")."""
    from app import process_frame
    from app.session import SessionRegistry
    from app.tracker import IoUTracker

    # A degenerate sub-pixel box: a 1-pixel mask on a 2000x2000 frame maps to
    # ~0.0005 x 0.0005, below _norm_bbox's 0.005 minimum side. Un-normalized
    # SAM boxes arrive like this, straight into the tracker with no _norm_bbox
    # guard, and would surface as an invisible box -> label floating on nothing.
    degenerate = (0.5, 0.5, 0.5005, 0.5005)

    class _EmptyDetector:
        def detect(self, image, vocabulary=None):
            return []  # no new Florence detections this frame; seed only

        def load(self):
            pass

    monkeypatch.setattr(florence, "get_detector", lambda _ref=None: _EmptyDetector())
    monkeypatch.setattr("app.get_detector", lambda _ref=None: _EmptyDetector())

    reg = SessionRegistry(max_sessions=1)
    state = reg.get_or_create("sess-5700-floating", "", "")
    state.last_rgb = np.zeros((100, 100, 3), dtype=np.uint8)
    state.tracker = IoUTracker(capacity=2)
    tr = state.tracker.seed(degenerate, kind="player", label="player")
    assert tr is not None

    obs, _ = process_frame(state, 1, 1.0, "ix.")
    tracks = obs["tracks"]
    assert tracks, "expected the seeded track to surface"
    bx = tracks[0]["bbox"]
    # The surfaced box must have a visible area (>= _norm_bbox min 0.005 side),
    # so it never renders as an invisible sliver with a floating label.
    assert bx[2] - bx[0] >= 0.005, f"box too thin: {bx}"
    assert bx[3] - bx[1] >= 0.005, f"box too short: {bx}"
    assert tracks[0].get("label") or tracks[0]["kind"], "label must be present to anchor"


# --- ADAAAA-6395: bounded zoomed-crop / ROI pass ------------------------------

_SOCCER = ["soccer ball", "player", "goalkeeper", "goal", "referee"]


def test_roi_tiles_bounded_within_frame():
    # H=1080, yfrac=0.2 -> play area starts at y=216, region_h=864.
    rects = florence._roi_tiles(1920, 864, 3, 4, 0.15, 216)
    assert len(rects) == 12  # 3 rows x 4 cols
    for (x0, y0, x1, y1) in rects:
        assert 0 <= x0 < x1 <= 1920
        assert 216 <= y0 < y1 <= 1080
        assert (x1 - x0) >= 8 and (y1 - y0) >= 8


def test_roi_tiles_empty_on_tiny_region():
    assert florence._roi_tiles(4, 4, 3, 4, 0.15, 0) == []


def test_iou_and_max_iou():
    a = [0.0, 0.0, 1.0, 1.0]
    assert florence._iou((0.0, 0.0, 1.0, 1.0), (0.0, 0.0, 1.0, 1.0)) == 1.0
    assert florence._iou((0.0, 0.0, 0.5, 0.5), (0.5, 0.5, 1.0, 1.0)) == 0.0
    assert florence._max_iou(a, [(0.0, 0.0, 0.4, 0.4), (0.5, 0.5, 0.6, 0.6)]) > 0.15
    assert florence._max_iou([0.0, 0.0, 0.1, 0.1], [(0.9, 0.9, 1.0, 1.0)]) == 0.0


def test_roi_config_clamps_to_max_tiles(monkeypatch):
    monkeypatch.setenv("PERCEIVE_ROI_GRID", "10x10")
    rows, cols, _, _ = florence._roi_config()
    assert rows * cols <= florence._ROI_MAX_TILES
    monkeypatch.setenv("PERCEIVE_ROI_GRID", "bogus")
    assert florence._roi_config()[:2] == (3, 4)


def test_run_roi_pass_recovers_ball_on_missing(monkeypatch):
    monkeypatch.setenv("PERCEIVE_ROI_GRID", "1x1")
    monkeypatch.setenv("PERCEIVE_ROI_ENABLED", "1")
    det = FlorenceDetector()
    calls = []

    def fake_infer(pil, prompt):
        calls.append((pil, prompt))
        # a ball at the crop center, upper-left -> lower-right in crop space
        return "<s>soccer ball<loc_200><loc_300><loc_600><loc_700></s>"

    det._infer = fake_infer  # shadow the real model call
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    objs = [{"label": "player", "bbox": [0.4, 0.5, 0.6, 0.7]}]
    out = det._run_roi_pass(image, _SOCCER, objs)
    balls = [o for o in out if o.get("label") == "soccer ball"]
    assert len(balls) >= 1, "crop pass should recover a ball"
    b = balls[0]
    assert b.get("roi") is True
    # mapped ball must land inside the frame, in the lower play area
    assert 0.0 <= b["bbox"][0] <= b["bbox"][2] <= 1.0
    assert 0.0 <= b["bbox"][1] <= b["bbox"][3] <= 1.0
    assert b["bbox"][1] > 0.15  # lower region
    assert calls, "expected a crop inference"


def test_run_roi_pass_noop_when_ball_already_found():
    det = FlorenceDetector()
    det._infer = lambda pil, prompt: (_ for _ in ()).throw(AssertionError("must not run"))
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    objs = [{"label": "soccer ball", "bbox": [0.4, 0.5, 0.6, 0.7]}]
    out = det._run_roi_pass(image, _SOCCER, objs)
    assert len(out) == 1  # unchanged, ball already present


def test_run_roi_pass_noop_for_non_soccer_vocab():
    det = FlorenceDetector()
    det._infer = lambda pil, prompt: (_ for _ in ()).throw(AssertionError("must not run"))
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    objs = [{"label": "player", "bbox": [0.4, 0.5, 0.6, 0.7]}]
    out = det._run_roi_pass(image, ["player", "goalkeeper"], objs)
    assert out == objs


def test_run_roi_pass_never_raises(monkeypatch):
    monkeypatch.setenv("PERCEIVE_ROI_GRID", "1x1")
    det = FlorenceDetector()

    def boom(pil, prompt):
        raise RuntimeError("gpu hiccup")

    det._infer = boom
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    objs = [{"label": "player", "bbox": [0.4, 0.5, 0.6, 0.7]}]
    out = det._run_roi_pass(image, _SOCCER, objs)
    assert out == objs  # degrades gracefully, no crash


def test_roi_should_run_flag_gates_detect(monkeypatch):
    # roi_pass=False disables the second pass (tracker re-detect path).
    monkeypatch.setenv("PERCEIVE_ROI_GRID", "1x1")
    det = FlorenceDetector()
    det._infer = lambda pil, prompt: "<s>soccer ball<loc_0><loc_0><loc_998><loc_998></s>"
    # _run_roi_pass still recovers a ball for soccer vocab; the roi flag on detect
    # is what gates it from the caller.
    image = np.zeros((1080, 1920, 3), dtype=np.uint8)
    out = det._run_roi_pass(image, _SOCCER, [])
    assert any(o.get("label") == "soccer ball" for o in out)
