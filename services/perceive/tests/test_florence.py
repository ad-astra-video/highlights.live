"""Unit tests for Florence-2 OD output parsing (real <loc_> token format)."""
import time

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
    assert florence.FlorenceDetector.canonicalize_open_label("scoreboard", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("car", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("sock", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("object", vocab) is None
    assert florence.FlorenceDetector.canonicalize_open_label("", vocab) is None


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

def test_resolve_vocabulary_prefer_labels_wins_over_game_hint():
    vocab = florence.resolve_vocabulary(game_hint="soccer", prefer_labels=["score", "clock"])
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
    for _ in range(10):
        florence.record_analyze(1.0)  # 1.0s/frame -> 1.0 fps
    c = florence.capability()
    assert abs(c["max_fps"] - 1.0) < 0.2
    assert c["sample_interval_s"] >= 1.0
    assert c["sample_interval_s"] <= 1.0 / 0.8 + 0.01


def test_capability_slows_down_for_slow_card(monkeypatch):
    monkeypatch.setenv("PERCEIVE_MODE", "florence")
    for _ in range(5):
        florence.record_analyze(2.5)  # 0.4 fps
    c = florence.capability()
    assert c["max_fps"] < 0.6
    assert c["sample_interval_s"] > 1.5
