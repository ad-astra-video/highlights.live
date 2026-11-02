#!/usr/bin/env python3
"""Tests for the audio-recall harness window resolution (evals/measure_audio_recall.py).

Runs with plain stdlib (`python3 evals/test_measure_audio_recall.py`) and is also
pytest-discoverable. No clip, no ffmpeg, no gate: the only thing under test is the
precedence between an explicit CLI flag, the label manifest, and the default.

Context (ADAAAA-7772): QA re-scoring label-tolerance sensitivity passed
``--match-pre`` and got the baseline back, because the manifest key shadowed the
flag unconditionally. That made a real, measured sensitivity sweep look
unsupported, so the precedence is pinned here.
"""

from __future__ import annotations

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import measure_audio_recall as m  # noqa: E402


def test_defaults_apply_when_neither_flag_nor_manifest_set():
    assert m.resolve_match_windows(None, None, {}) == (3.0, 2.0)


def test_manifest_wins_over_the_default():
    manifest = {"matchPre": 5.0, "matchPost": 4.0}
    assert m.resolve_match_windows(None, None, manifest) == (5.0, 4.0)


def test_explicit_flag_wins_over_the_manifest():
    # The regression: before the fix this returned the manifest's 3.0.
    manifest = {"matchPre": 3.0, "matchPost": 2.0}
    assert m.resolve_match_windows(5.0, None, manifest) == (5.0, 2.0)
    assert m.resolve_match_windows(None, 6.0, manifest) == (3.0, 6.0)
    assert m.resolve_match_windows(10.0, 6.0, manifest) == (10.0, 6.0)


def test_explicit_flag_applies_with_no_manifest_value():
    assert m.resolve_match_windows(5.0, 4.0, {}) == (5.0, 4.0)


def test_zero_is_an_explicit_value_not_an_absent_one():
    # `--match-pre 0` must not fall through to the manifest/default.
    assert m.resolve_match_windows(0.0, 0.0, {"matchPre": 3.0, "matchPost": 2.0}) == (0.0, 0.0)


def main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
        except AssertionError as exc:  # pragma: no cover - stdlib runner path
            failures += 1
            print(f"FAIL {name}: {exc}")
        else:
            print(f"ok   {name}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
