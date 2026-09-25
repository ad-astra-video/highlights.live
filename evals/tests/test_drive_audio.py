"""Tests for the honest crowd-reaction audio proxy in evals/drive_inc8.py (INC-9
/ ADAAAA-4496).

The drive derives `evidence.reaction.crowdEnergy` from the clip's REAL audio — a
sudden loudness rise around the candidate is the proxy — so Gemma can weigh the
INC-4 people-reaction dimension the deployed live pipeline already feeds it. We
never feed ground-truth reaction labels as pipeline input.

These tests build synthetic clips with ffmpeg (quiet baseline -> loud burst) and
assert the proxy scores a real goal-like eruption as a burst while quiet
warm-up / trailing sections stay near zero.
"""
import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from drive_inc8 import crowd_energy_from_audio  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe required",
)


@pytest.fixture(scope="module")
def erupt_clip(tmp_path_factory):
    """7s clip: 3s quiet, 3s loud burst, 1s quiet."""
    d = tmp_path_factory.mktemp("audio")
    q3 = d / "q3.wav"
    l3 = d / "l3.wav"
    tail = d / "tail.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "anullsrc=r=16000:cl=mono", "-t", "3", "-af", "volume=0.01",
                    "-y", str(q3)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "sine=frequency=440:sample_rate=16000", "-t", "3",
                    "-af", "volume=0.9", "-y", str(l3)], check=True)
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                    "anullsrc=r=16000:cl=mono", "-t", "1", "-af", "volume=0.01",
                    "-y", str(tail)], check=True)
    lst = d / "list.txt"
    lst.write_text("\n".join(f"file '{p}'" for p in (q3, l3, tail)) + "\n")
    out = d / "erupt.wav"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "concat", "-safe", "0",
                    "-i", str(lst), "-c", "copy", "-y", str(out)], check=True)
    return str(out)


def test_goal_like_eruption_scores_burst(erupt_clip):
    # candidate at 3.0s: quiet baseline before, loud crowd erupts after.
    ce, kind = crowd_energy_from_audio(erupt_clip, 3.0)
    assert ce >= 0.55
    assert kind == "burst"


def test_quiet_warmup_scores_zero(erupt_clip):
    # candidate during quiet warm-up (no eruption) -> no reaction signal.
    ce, kind = crowd_energy_from_audio(erupt_clip, 1.0)
    assert ce < 0.18
    assert kind == ""


def test_trailing_quiet_after_eruption_scores_low(erupt_clip):
    # candidate after the eruption has died down -> no jump, no reaction.
    ce, kind = crowd_energy_from_audio(erupt_clip, 6.5)
    assert ce < 0.18
    assert kind == ""


def test_missing_clip_is_quiet():
    assert crowd_energy_from_audio("/no/such/clip.mp4", 1.0) == (0.0, "")
