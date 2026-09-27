"""Tests for the tracking-accuracy measurement harness (ADAAAA-5050)."""
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from track_label_manifest import build as build_manifest  # noqa: E402
from track_metrics import run_clip, ACCEPT_ID_PERSIST, ACCEPT_IOU  # noqa: E402


@pytest.fixture(scope="module")
def manifest():
    return build_manifest()


def _clip(manifest, cid):
    return next(c for c in manifest["clips"] if c["id"] == cid)


def test_live_cap_reaches_3_and_never_exceeds(manifest):
    m = run_clip(_clip(manifest, "soc-live-3"), drop_pct=0)
    assert m["maxConcurrent"] == 3 and m["cap"] == 3
    assert m["maxConcurrent"] <= m["cap"]


def test_vod_cap_reaches_8_and_never_exceeds(manifest):
    m = run_clip(_clip(manifest, "soc-vod-8"), drop_pct=0)
    assert m["maxConcurrent"] == 8 and m["cap"] == 8
    assert m["maxConcurrent"] <= m["cap"]


def test_id_persistence_meets_acceptance_at_dropout(manifest):
    # The tracker must keep identity across occlusion/dropout at/above the bar.
    for clip_id, drop in [("soc-live-3", 10), ("soc-vod-8", 10),
                          ("soc-live-1-occlude", 0)]:
        m = run_clip(_clip(manifest, clip_id), drop_pct=drop)
        assert m["idPersist"] is not None and m["idPersist"] >= ACCEPT_ID_PERSIST
        assert m["iou"] is not None and m["iou"] >= ACCEPT_IOU


def test_editing_target_obeys_mode_cap():
    # A VOD clip is bounded by the VOD cap; a live clip by the live cap.
    m = run_clip(_clip(build_manifest(), "soc-live-3"), drop_pct=0)
    assert m["cap"] == 3
    m = run_clip(_clip(build_manifest(), "soc-vod-8"), drop_pct=0)
    assert m["cap"] == 8
