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
