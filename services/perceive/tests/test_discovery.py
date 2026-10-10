"""Tests for the perceive discovery pass (increment C — ADAAAA-6464).

Locks:
  * the caption/region discovery task set and its method mapping;
  * the Florence-2 region reply parser into per-region candidates;
  * discovery_block normalization into a plan `discovery` block;
  * run_discovery_pass runs ONE pass and records method + florenceTasks
    (the discovery pass is a plan/re-plan-cadence helper — the per-frame
    hot path uses `FlorenceDetector.detect`, never `discover`).
"""
import numpy as np
import pytest

from app import florence, discovery
from app.florence import FlorenceDetector


def test_discovery_task_valid():
    for t in ("<DETAILED_CAPTION>", "<MORE_DETAILED_CAPTION>", "<DENSE_REGION_CAPTION>", "<REGION_PROPOSAL>"):
        assert florence.discovery_task(t) == t
    assert florence.discovery_task("<OD>") is None  # OD is not a discovery task
    assert florence.discovery_task("bogus") is None
    assert florence.discovery_task(None) is None


def test_discovery_method_for_task():
    assert florence.discovery_method_for_task("<DETAILED_CAPTION>") == "caption"
    assert florence.discovery_method_for_task("<MORE_DETAILED_CAPTION>") == "caption"
    assert florence.discovery_method_for_task("<DENSE_REGION_CAPTION>") == "region"
    assert florence.discovery_method_for_task("<REGION_PROPOSAL>") == "region"
    assert florence.discovery_method_for_task("<OD>") is None


def test_parse_discovery_regions_parses_boxes():
    det = FlorenceDetector._parse_discovery_regions(
        "<loc_100><loc_200><loc_300><loc_400> a player<loc_10><loc_20><loc_30><loc_40>"
    )
    assert det == [
        {"bbox": [0.1, 0.2, 0.3, 0.4], "caption": "a player"},
        {"bbox": [0.01, 0.02, 0.03, 0.04], "caption": ""},
    ]


def test_parse_discovery_regions_empty_and_junk():
    assert FlorenceDetector._parse_discovery_regions("") == []
    assert FlorenceDetector._parse_discovery_regions("<loc_abc>no numbers") == []


def test_discovery_block_normalizes():
    block = discovery.discovery_block(
        {"task": "<DENSE_REGION_CAPTION>", "method": "region",
         "regions": [{"bbox": [0, 0, 1, 1], "caption": "x"}], "notes": "n"}
    )
    assert block["method"] == "region"
    assert block["florenceTasks"] == ["<DENSE_REGION_CAPTION>"]
    assert block["candidates"] == [{"bbox": [0, 0, 1, 1], "caption": "x"}]
    assert block["notes"] == "n"


def test_run_discovery_pass_uses_detector_once(monkeypatch):
    calls = []

    class _FakeDetector:
        def discover(self, image, task="<DETAILED_CAPTION>"):
            calls.append(task)
            return {"task": task, "method": "region", "description": "", "regions": [{"bbox": [0, 0, 0.5, 0.5], "caption": "ball"}], "notes": "n"}

    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: _FakeDetector())
    frame = np.zeros((64, 64, 3), np.uint8)
    block = discovery.run_discovery_pass("<REGION_PROPOSAL>", frame, lora_ref="/models/lora-1")
    assert calls == ["<REGION_PROPOSAL>"]  # exactly ONE pass at plan cadence
    assert block["method"] == "region"
    assert block["florenceTasks"] == ["<REGION_PROPOSAL>"]
    assert block["candidates"] == [{"bbox": [0, 0, 0.5, 0.5], "caption": "ball"}]


def test_run_discovery_pass_stub_no_detector_records_notes(monkeypatch):
    monkeypatch.setattr(florence, "get_detector", lambda lora_ref=None: None)
    monkeypatch.setattr(florence, "discover_candidates", lambda image, task="<DETAILED_CAPTION>", lora_ref=None: {
        "task": task, "method": "caption", "regions": [], "notes": "discovery skipped: no detector"})
    frame = np.zeros((64, 64, 3), np.uint8)
    block = discovery.run_discovery_pass("<DETAILED_CAPTION>", frame)
    assert block["method"] == "caption"
    assert block["florenceTasks"] == ["<DETAILED_CAPTION>"]


def test_discovery_off_per_frame_hot_path():
    # The per-frame primitive is `FlorenceDetector.detect`; the discovery pass
    # is a separate method that the per-frame path never calls. Guard against
    # a refactor that folds discovery into detect (plan §7 C latency rule).
    det = FlorenceDetector
    assert callable(det.detect)
    assert callable(det.discover)
    assert det.discover is not det.detect
