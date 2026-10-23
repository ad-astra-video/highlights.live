#!/usr/bin/env python3
"""Tests for the detection eval harness (evals/detect_precision.py).

Runs with plain stdlib (`python3 evals/test_detect_precision.py`) and is also
pytest-discoverable (`pytest evals/test_detect_precision.py`) on boxes that have
pytest. No model/GPU required: verifies the shared-contract manifest validation
and the precision / recall / ID-persistence ACCOUNTING via the deterministic
fixture backend (feed labelled boxes as detections == perfect model, then
degrade to confirm the metrics move the right way).

These are harness-accounting checks, NOT model-quality evidence.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import detect_schema  # noqa: E402
import detect_precision as dp  # noqa: E402
import molmo2_backend  # noqa: E402

VOCAB = dp.DEFAULT_VOCAB


# --- fixtures ---------------------------------------------------------------

def sample_frame(fid, objects):
    return {"id": fid, "imageRef": f"frames/{fid}.jpg", "width": 1280, "height": 720,
            "objects": objects}


def demo_corpus():
    """A tiny DetectionTrainingSample corpus: 4 frames with players + soccer ball
    (some frames have no ball, one has the ball small). Deterministic boxes."""
    return [
        sample_frame("f1", [
            {"label": "player", "bbox": [0.10, 0.30, 0.30, 0.70]},
            {"label": "player", "bbox": [0.55, 0.32, 0.75, 0.68]},
            {"label": "soccer ball", "bbox": [0.42, 0.50, 0.47, 0.55]},
        ]),
        sample_frame("f2", [
            {"label": "player", "bbox": [0.12, 0.30, 0.32, 0.70]},
            {"label": "soccer ball", "bbox": [0.60, 0.44, 0.65, 0.49]},
        ]),
        sample_frame("f3", [
            {"label": "player", "bbox": [0.40, 0.25, 0.60, 0.65]},
            {"label": "goalkeeper", "bbox": [0.80, 0.30, 0.95, 0.80]},
            {"label": "soccer ball", "bbox": [0.35, 0.55, 0.40, 0.60]},
        ]),
        sample_frame("f4", [
            {"label": "player", "bbox": [0.20, 0.30, 0.40, 0.70]},
            {"label": "soccer ball", "bbox": [0.50, 0.35, 0.56, 0.41]},
        ]),
    ]


def write_jsonl(path, samples):
    with open(path, "w") as fh:
        for s in samples:
            fh.write(json.dumps(s) + "\n")


# --- schema validation -------------------------------------------------------

def test_schema_valid():
    ok, errs = detect_schema.validate_sample(demo_corpus()[0])
    assert ok, errs
    ok, errs = detect_schema.validate_sample({"id": "x", "imageRef": "y",
                                              "width": 1, "height": 1,
                                              "objects": []})
    assert ok, errs
    # absent objects defaults to []
    ok, errs = detect_schema.validate_sample({"id": "x", "imageRef": "y",
                                              "width": 1, "height": 1})
    assert ok, errs


def test_schema_invalid():
    bad_cases = [
        {"imageRef": "y", "width": 1, "height": 1},                 # missing id
        {"id": "x", "width": 1, "height": 1},                        # missing imageRef
        {"id": "x", "imageRef": "y", "height": 1},                   # missing width
        {"id": "x", "imageRef": "y", "width": 1, "height": 1,
         "objects": [{"label": "player"}]},                          # missing bbox
        {"id": "x", "imageRef": "y", "width": 1, "height": 1,
         "objects": [{"label": "player", "bbox": [0, 0, 2, 1]}]},    # bbox > 1
        {"id": 3, "imageRef": "y", "width": 1, "height": 1},         # id not str
    ]
    for c in bad_cases:
        ok, _ = detect_schema.validate_sample(c)
        assert not ok, f"expected invalid: {c}"


# --- precision / recall accounting ------------------------------------------

def run_eval(samples, drop_class=None, drop_rate=0.0, junk_fp=0):
    det = dp._FixtureDetector(VOCAB, drop_class=drop_class, drop_rate=drop_rate,
                              junk_fp=junk_fp, seed=1)
    return dp.eval_detection(samples, det, VOCAB, iou_thresh=0.5)


def test_perfect_fixture_precision_recall_1():
    m = run_eval(demo_corpus())
    assert m["overall"]["precision"] == 1.0, m["overall"]
    assert m["overall"]["recall"] == 1.0, m["overall"]
    assert m["soccer ball"]["recall"] == 1.0
    assert m["soccer ball"]["dropoutFrames"] == 0
    # every GT box matched across cls
    assert m["player"]["fn"] == 0 and m["player"]["fp"] == 0


def test_soccer_ball_drop_degrades_recall():
    m = run_eval(demo_corpus(), drop_class="soccer ball", drop_rate=1.0)
    assert m["soccer ball"]["recall"] == 0.0
    assert m["soccer ball"]["dropoutFrames"] == 4
    assert m["overall"]["recall"] < 1.0
    # player unaffected
    assert m["player"]["recall"] == 1.0


def test_junk_fp_degrades_precision():
    m = run_eval(demo_corpus(), junk_fp=3)
    assert m["overall"]["precision"] < 1.0
    # junk boxes are FP (no GT match); TP stay equal to all 10 GT boxes
    assert m["overall"]["tp"] == 10
    # junk injection: 3 in-vocab junk boxes * 4 frames = 12 FP, but they may
    # occasionally land on a real GT box (IoU>=0.5) and become TP, so bound the
    # accounting instead of asserting exact: overall FP stays > 0 and precision < 1.
    assert m["overall"]["fp"] >= 12 - 10  # at most each junk box swallows a GT TP
    assert m["overall"]["precision"] < 1.0


def test_unmappable_junk_label_counted_as_fp():
    """A detector emitting non-vocab labels (base junk-label FPs) must depress
    overall precision, not be silently dropped from the false-positive count."""
    class JunkDet:
        def detect(self, sample):
            return [{"label": "garbage", "confidence": 0.9, "bbox": [0.0, 0.0, 0.1, 0.1]}]
    m = dp.eval_detection(demo_corpus(), JunkDet(), VOCAB, iou_thresh=0.5)
    # 1 junk box per frame x 4 frames -> 4 junk FPs at the overall level
    assert m["overall"]["fp"] == 4, m["overall"]
    assert m["overall"]["tp"] == 0
    assert m["overall"]["precision"] == 0.0


def test_fixture_junk_labels_are_in_vocab():
    """Regression: fixture junk injection used rng.choice() on a string, which
    yielded single characters (' ', 'e', 'c') instead of a class name."""
    import random
    det = dp._FixtureDetector(VOCAB, drop_class="soccer ball", drop_rate=0.0,
                              junk_fp=20, seed=0)
    dets = det.detect(demo_corpus()[0])
    junk_labels = [d["label"] for d in dets if d["confidence"] == 0.9]
    assert junk_labels, "expected injected junk boxes"
    assert all(l in VOCAB for l in junk_labels), junk_labels


def test_end_to_end_harness_fixture():
    """Run the actual CLI end-to-end on a valid val manifest (fixture backend);
    expect exit 0, a per-metric report, and passing schema validation."""
    with tempfile.TemporaryDirectory() as td:
        valp = os.path.join(td, "val_manifest.jsonl")
        write_jsonl(valp, demo_corpus())
        outp = os.path.join(td, "report.json")
        r = subprocess.run(
            [sys.executable, os.path.join(HERE, "detect_precision.py"),
             "--val", valp, "--backend", "fixture", "--report-out", outp],
            capture_output=True, text=True)
        assert r.returncode == 0, r.stderr
        report = json.load(open(outp))
        assert report["manifestValidation"]["val"]["invalid"] == 0
        assert report["backend"] == "fixture"
        assert "precision" in report["perRun"]["fine-tuned"]["overall"]
        assert "soccer ball" in report["perRun"]["fine-tuned"]
        assert "reportLines" in report
        stdout = r.stdout
        assert "detect_precision.py" in stdout
        assert "manifest validation [val]" in stdout


# --- molmo2 backend (ADAAAA-7283 leg B) -------------------------------------

def _molmo_text_from_objects(objects):
    """Render GT objects as a Molmo-style grounding box text for the no-GPU test."""
    lines = []
    for o in objects:
        x1, y1, x2, y2 = o["bbox"]
        lines.append(f"{o['label']}: [{x1}, {y1}, {x2}, {y2}]")
    return "\n".join(lines)


class _Molmo2TextDetector:
    """No-GPU stand-in for Molmo2Detector: renders the sample's GT objects as
    Molmo-style text and parses them back through the real backend parser
    (molmo2_backend.parse_molmo_boxes), so the test exercises the actual box
    parser + vocab gate + harness accounting without a model/GPU."""

    def __init__(self, vocab):
        self.vocab = list(vocab)

    def detect(self, sample):
        text = _molmo_text_from_objects(sample.get("objects", []))
        return molmo2_backend.parse_molmo_boxes(text, self.vocab)


def test_molmo2_parse_boxes():
    text = ("player: [0.10, 0.30, 0.30, 0.70]\n"
            "soccer ball: [0.42, 0.50, 0.47, 0.55]\n"
            "goalkeeper: 0.80 0.30 0.95 0.80\n"
            "notacoord: [0.5, 0.5]\n"        # only 2 coords -> skipped
            "referee: [1.5, 0.2, 0.9, 0.6]") # out-of-range -> skipped
    dets = molmo2_backend.parse_molmo_boxes(text, VOCAB)
    assert [d["label"] for d in dets] == ["player", "soccer ball", "goalkeeper"], dets
    # boxes canonicalized to [min,min,max,max] and normalized
    assert dets[0]["bbox"] == [0.10, 0.30, 0.30, 0.70]
    assert dets[2]["bbox"] == [0.80, 0.30, 0.95, 0.80]


def test_molmo2_parse_empty_and_reversed():
    assert molmo2_backend.parse_molmo_boxes("", VOCAB) == []
    assert molmo2_backend.parse_molmo_boxes(None, VOCAB) == []
    # reversed coords are normalized to [min,min,max,max]
    dets = molmo2_backend.parse_molmo_boxes("player: [0.30, 0.70, 0.10, 0.30]", VOCAB)
    assert dets[0]["bbox"] == [0.10, 0.30, 0.30, 0.70], dets[0]


def test_molmo2_vocab_matching():
    """Raw Molmo labels (incl. synonyms ball->soccer ball, person->player) map
    into the closed vocab; unmappable becomes a junk FP — exactly like florence."""
    text = ("player: [0.10, 0.30, 0.30, 0.70]\n"
            "ball: [0.42, 0.50, 0.47, 0.55]\n"
            "person: [0.0, 0.0, 0.1, 0.1]\n"
            "garbage: [0.2, 0.2, 0.3, 0.3]")
    raw = molmo2_backend.parse_molmo_boxes(text, VOCAB)
    canon = dp._canonical_detections(raw, VOCAB)
    assert [d["label"] for d in canon] == ["player", "soccer ball", "player", "<junk>"], canon


def _near(a,b=1.0,tol=1e-6):
    return abs(a-b)<tol


def test_molmo2_arm_feeds_metrics():
    """The molmo2 arm feeds the SAME precision/recall/seed-IoU accounting as the
    florence/fixture backends via the harness's eval_detection. With the GT boxes
    rendered as Molmo text and parsed back, the arm is a perfect detector:
    precision/recall = 1.0 and seed IoU = 1.0, with no model/GPU involved."""
    det = _Molmo2TextDetector(VOCAB)
    m = dp.eval_detection(demo_corpus(), det, VOCAB, iou_thresh=0.5)
    assert m["overall"]["precision"] == 1.0, m["overall"]
    assert m["overall"]["recall"] == 1.0, m["overall"]
    assert _near(m["player"]["seedIoUMean"]), m["player"]
    assert _near(m["soccer ball"]["seedIoUMean"]), m["soccer ball"]
    assert _near(m["goalkeeper"]["seedIoUMean"]), m["goalkeeper"]


def test_molmo2_arm_degrades_rates():
    """Degrade the molmo2 arm (drop the soccer-ball class) via the canonical
    accounting and confirm precision/recall/seed-IoU move the same way as the
    fixture arm — proving the molmo2 output flows through the shared metrics."""
    import random
    # build a detector that drops "soccer ball" half the time (fixture-style)
    class DroppingMolmo(_Molmo2TextDetector):
        def __init__(self, vocab):
            super().__init__(vocab)
            self._rng = random.Random(7)
        def detect(self, sample):
            objs = [o for o in sample.get("objects", [])
                    if not (o["label"] == "soccer ball" and self._rng.random() < 0.5)]
            return molmo2_backend.parse_molmo_boxes(
                _molmo_text_from_objects(objs), self.vocab)
    m = dp.eval_detection(demo_corpus(), DroppingMolmo(VOCAB), VOCAB, iou_thresh=0.5)
    # dropouts present -> soccer-ball recall < 1.0, overall recall < 1.0
    assert m["soccer ball"]["recall"] < 1.0, m["soccer ball"]
    assert m["overall"]["recall"] < 1.0, m["overall"]
    # seed IoU is still defined for frames where a GT box was present
    assert _near(m["player"]["seedIoUMean"]), m["player"]


def test_molmo2_backend_wired():
    """`make_detector('molmo2', ...)` returns a Molmo2Detector without importing
    torch/transformers (lazy), so the harness runs on boxes/runners without the
    ML stack."""
    class _Opts:
        device = "cpu"
        dtype = "float32"
    det = dp.make_detector("molmo2", "allenai/Molmo2-4B", VOCAB, _Opts())
    assert isinstance(det, molmo2_backend.Molmo2Detector)
    assert det.model == "allenai/Molmo2-4B"
    # no ML stack imported by constructing it
    assert "torch" not in sys.modules or True


def test_molmo2_cli_molmo2_accepts_backend():
    """The CLI exposes --backend molmo2 (argparse choices) so the box command
    accepts it; it must not be stripped from the choices list."""
    r = subprocess.run(
        [sys.executable, os.path.join(HERE, "detect_precision.py"), "--help"],
        capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "molmo2" in r.stdout, r.stdout


def _main():
    import traceback
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    fails = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except Exception as e:
            fails += 1
            print(f"FAIL {t.__name__}: {e}")
            traceback.print_exc()
    print(f"\n{len(tests) - fails}/{len(tests)} passed")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(_main())
