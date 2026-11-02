"""Tests for the detection-slice producer's weights provenance (ADAAAA-7801).

The gap: the committed american-football slice records `detector: "cuda:0"`,
which names a device and not a model, so QA could not check on a CPU host that
the artifact came from the weights the deployment serves. These tests pin the
fix in the PRODUCER (the certified artifact is not re-edited):

  - a local model dir is recorded with a per-weight-file sha256 that a CPU host
    can recompute from the same dir;
  - a hub model id is recorded as an id (plus the resolved commit when
    transformers sets one) and is never mistaken for a local dir;
  - the slice document carries that identity next to `detector`, so the artifact
    itself is checkable without the GPU that produced it.

No GPU, no ffmpeg, no torch: the identity is read from the detector's resolved
state, which is exactly what the slice records.
"""
import hashlib
import json
import os
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(REPO, "services", "perceive"))

from detect_slice_from_windows import build_slice_doc  # noqa: E402
from app.florence import FlorenceDetector  # noqa: E402
from app.provenance import detector_identity, weights_digest  # noqa: E402


def _model_dir(tmp_path, files=("model.safetensors", "config.json")):
    d = tmp_path / "Florence-2-base-finetuned-ft6404gpu"
    d.mkdir()
    for name in files:
        payload = ("weights:" + name).encode()
        (d / name).write_bytes(payload)
    return d


def test_local_model_dir_records_per_file_sha256(tmp_path, monkeypatch):
    model_dir = _model_dir(tmp_path)
    monkeypatch.setenv("FLORENCE_MODEL", str(model_dir))
    det = FlorenceDetector(model_path=str(model_dir))

    ident = det.weights_identity()

    assert ident["sourceKind"] == "local_dir"
    assert ident["modelPath"] == str(model_dir)
    assert ident["source"] == str(model_dir)
    # the raw env value is recorded verbatim so the run can be re-derived
    assert ident["envValue"] == str(model_dir)
    # only weight files are hashed; config.json is not a weight file
    assert [w["file"] for w in ident["weights"]] == ["model.safetensors"]
    expected = hashlib.sha256((model_dir / "model.safetensors").read_bytes()).hexdigest()
    assert ident["weights"][0]["sha256"] == expected
    assert ident["weights"][0]["bytes"] == (model_dir / "model.safetensors").stat().st_size


def test_recorded_digest_recomputes_on_cpu(tmp_path):
    """A CPU host holding a copy of the weights dir can verify the slice."""
    model_dir = _model_dir(tmp_path, files=("model-00001-of-00002.safetensors",))
    det = FlorenceDetector(model_path=str(model_dir))
    ident = det.weights_identity()

    # independent re-hash, as a reviewer on CPU would do
    recomputed = {
        w["file"]: hashlib.sha256((model_dir / w["file"]).read_bytes()).hexdigest()
        for w in ident["weights"]
    }
    assert recomputed == {w["file"]: w["sha256"] for w in ident["weights"]}

    # and a mutated copy is DETECTED rather than silently accepted
    (model_dir / "model-00001-of-00002.safetensors").write_bytes(b"tampered")
    assert weights_digest(str(model_dir))[0]["sha256"] != ident["weights"][0]["sha256"]


def test_hub_id_is_recorded_as_an_id_not_a_dir(monkeypatch):
    monkeypatch.setenv("FLORENCE_MODEL", "microsoft/Florence-2-base")
    det = FlorenceDetector()

    ident = det.weights_identity()

    assert ident["sourceKind"] == "hub_id"
    assert ident["source"] == "microsoft/Florence-2-base"
    assert ident["modelPath"] is None
    assert ident["hubCommit"] is None  # nothing loaded in this test
    assert ident["weights"] == []
    assert ident["envValue"] == "microsoft/Florence-2-base"


def test_env_resolved_source_wins_over_default(monkeypatch):
    """The deployed FLORENCE_MODEL is what the identity must name."""
    monkeypatch.setenv("FLORENCE_MODEL", "/runs/Florence-2-base-finetuned-ft6404gpu")
    det = FlorenceDetector()
    ident = det.weights_identity()
    assert ident["modelName"] == "/runs/Florence-2-base-finetuned-ft6404gpu"
    assert det.model_name != "microsoft/Florence-2-base"


def test_unset_env_is_recorded_as_null(monkeypatch):
    monkeypatch.delenv("FLORENCE_MODEL", raising=False)
    det = FlorenceDetector()
    ident = det.weights_identity()
    assert ident["envValue"] is None
    assert ident["modelName"] == "microsoft/Florence-2-base"


def test_identity_falls_back_to_hub_commit(tmp_path, monkeypatch):
    """When transformers resolved a hub revision, record it: it pins the weights."""
    det = FlorenceDetector()

    class _Cfg:
        _commit_hash = "9c9d5d1e0e1d4c8d"

    class _Model:
        config = _Cfg()

    det._model = _Model()
    ident = detector_identity(det, digest=False)
    assert ident["hubCommit"] == "9c9d5d1e0e1d4c8d"


def test_slice_document_carries_the_weights_identity(tmp_path, monkeypatch):
    model_dir = _model_dir(tmp_path)
    monkeypatch.setenv("FLORENCE_MODEL", str(model_dir))
    det = FlorenceDetector(model_path=str(model_dir))
    det.device_label = "cuda:0"

    doc = build_slice_doc(
        profile_key="american football",
        vocabulary=["football", "player", "referee"],
        fps=1.0,
        clip_name="af_belmont_vs_westford_092123.mp4",
        clip_sha256="ad12b10b",
        clip_bytes=817579377,
        label_manifest="evals/american_football_val/label-manifest.json",
        frames=1,
        latency={"meanMsPerFrame": 364.0},
        detector_label=det.device_label,
        detector_model=det.weights_identity(),
        envelope={"maxFrames": 1, "budgetGpuMinutes": 1.0},
        windows=[],
    )

    # round-trip through JSON: the artifact is the JSON file, not the dict
    written = json.loads(json.dumps(doc))
    assert written["detector"] == "cuda:0"
    assert written["detectorModel"]["sourceKind"] == "local_dir"
    assert written["detectorModel"]["source"] == str(model_dir)
    assert written["detectorModel"]["weights"][0]["file"] == "model.safetensors"
    expected = hashlib.sha256((model_dir / "model.safetensors").read_bytes()).hexdigest()
    assert written["detectorModel"]["weights"][0]["sha256"] == expected
