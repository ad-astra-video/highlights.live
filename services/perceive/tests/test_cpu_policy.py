"""CPU runner policy: VOD-only and capped at 1 fps (no live-stream / >1fps on CPU)."""
import pytest

from app import florence


@pytest.fixture(autouse=True)
def _env():
    import os
    old = dict(os.environ)
    os.environ["PERCEIVE_MODE"] = "florence"
    yield
    os.environ.clear()
    os.environ.update(old)


def test_cpu_is_capped_at_1fps_and_vod_only(monkeypatch):
    monkeypatch.setenv("PERCEIVE_DEVICE", "cpu")
    monkeypatch.setattr(florence, "_measured_fps", 5.0)  # even if the card could do more
    cap = florence.capability()
    assert cap["max_fps"] <= 1.0
    assert cap["sample_interval_s"] >= 1.0
    assert cap["live"] is False
    assert cap["mode"] == "vod-only"


def test_gpu_allows_live_and_higher_fps(monkeypatch):
    monkeypatch.setenv("PERCEIVE_DEVICE", "cuda")
    monkeypatch.setattr(florence, "_measured_fps", 5.0)
    cap = florence.capability()
    assert cap["live"] is True
    assert cap["mode"] == "live+vod"
    assert cap["max_fps"] == 5.0


def test_device_is_cpu_flag(monkeypatch):
    monkeypatch.setenv("PERCEIVE_DEVICE", "cpu")
    assert florence.device_is_cpu() is True
    monkeypatch.setenv("PERCEIVE_DEVICE", "cuda")
    assert florence.device_is_cpu() is False
