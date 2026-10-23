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

def _box_center_points(bboxes):
    """Emit one Molmo2 object point per GT box, at its centre (scaled by 1000).

    Molmo2 emits ONE reference point per object instance, not box corners, so
    each GT box contributes a single `index x y` point at its centre.
    """
    def s(v):
        return int(round(v * 1000))
    tokens = []
    for i, bbox in enumerate(bboxes, start=1):
        x1, y1, x2, y2 = bbox
        cx, cy = (x1 + x2) / 2.0, (y1 + y2) / 2.0
        tokens.append("%d %d %d" % (i, s(cx), s(cy)))
    return " ".join(tokens)


def _points_utterance(bboxes):
    """Render GT boxes into a Molmo2 grounding `<points coords="..."/>` utterance."""
    return '<points coords="' + _box_center_points(bboxes) + '"/>'


class _Molmo2TextDetector:
    """No-GPU stand-in for Molmo2Detector: simulates the real per-class grounding
    queries by rendering each class' GT boxes as one object point per box and
    decoding them back through the REAL backend decoder (extract_image_points /
    points_to_boxes / parse_molmo_detection), so the test exercises the actual
    point decode + per-point box expansion + vocab gate + harness accounting with
    no model/GPU."""

    def __init__(self, vocab, box_size=molmo2_backend.DEFAULT_BOX_SIZE):
        self.vocab = list(vocab)
        self.box_size = box_size

    def detect(self, sample):
        by_cls = {}
        for o in sample.get("objects", []):
            by_cls.setdefault(o["label"], []).append(o["bbox"])
        dets = []
        for cls in self.vocab:
            text = _points_utterance(by_cls.get(cls, []))
            dets.extend(molmo2_backend.parse_molmo_detection(text, cls, box_size=self.box_size))
        return dets


def test_molmo2_extract_points():
    """Molmo2 grounding decode: `<points coords="..."/>` with coords scaled by
    1000 -> normalized [0,1] points; empty/malformed/out-of-range handled."""
    text = '<points coords="1 216 247 2 442 555 "/> trailing junk'
    pts = molmo2_backend.extract_image_points(text)
    assert pts == [(0.216, 0.247), (0.442, 0.555)], pts
    assert molmo2_backend.extract_image_points("") == []
    assert molmo2_backend.extract_image_points(None) == []
    # out-of-range token (y=1.5) rejected, in-range kept
    pts2 = molmo2_backend.extract_image_points('<points coords="1 999 500 2 200 1500"/>')
    assert pts2 == [(0.999, 0.5)], pts2


def test_molmo2_point_to_box_expansion():
    """Each decoded object point expands to ONE non-degenerate normalized box;
    points near the border clamp to [0,1]; points are never paired."""
    # three object points -> three boxes (one per object), NOT one box per pair
    text = '<points coords="1 216 247 2 442 555 3 640 400"/>'
    dets = molmo2_backend.parse_molmo_detection(text, "player")
    assert len(dets) == 3, dets
    for d in dets:
        bb = d["bbox"]
        assert all(0.0 <= v <= 1.0 for v in bb), bb
        assert bb[2] - bb[0] > 0 and bb[3] - bb[1] > 0, bb
    # a point pushed to the top-right border still clamps to [0,1]
    edge = molmo2_backend.points_to_boxes([(0.999, 0.001)], "goal")[0]["bbox"]
    assert abs(edge[0] - 0.949) < 1e-9 and edge[1] == 0.0 \
        and edge[2] == 1.0 and abs(edge[3] - 0.051) < 1e-9, edge
    # empty / malformed -> no crash, zero boxes
    assert molmo2_backend.parse_molmo_detection("", "player") == []
    assert molmo2_backend.parse_molmo_detection("no points here", "player") == []


def test_molmo2_vocab_matching():
    """Raw Molmo2 boxes (incl. synonyms ball->soccer ball, person->player) map
    into the closed vocab; unmappable becomes a junk FP — exactly like florence."""
    raw = [
        {"label": "player", "confidence": 1.0, "bbox": [0.1, 0.3, 0.3, 0.7]},
        {"label": "ball", "confidence": 1.0, "bbox": [0.42, 0.5, 0.47, 0.55]},
        {"label": "garbage", "confidence": 1.0, "bbox": [0.2, 0.2, 0.3, 0.3]},
    ]
    canon = dp._canonical_detections(raw, VOCAB)
    assert [d["label"] for d in canon] == ["player", "soccer ball", "<junk>"], canon


def test_molmo2_arm_feeds_metrics():
    """The molmo2 arm feeds the SAME precision/recall/seed-IoU accounting as the
    florence/fixture backends via the harness's eval_detection. Each class' GT
    objects are rendered as one Molmo2 object point and decoded back through the
    real decoder (extract_image_points + points_to_boxes), so the arm produces
    non-empty, closed-vocab, non-degenerate detections that flow into the shared
    metrics with no model/GPU involved."""
    det = _Molmo2TextDetector(VOCAB)
    m = dp.eval_detection(demo_corpus(), det, VOCAB, iou_thresh=0.5)
    # the arm produces detections, and the shared accounting yields defined metrics
    assert (m["overall"]["tp"] + m["overall"]["fp"]) > 0, m["overall"]
    assert m["overall"]["precision"] is not None, m["overall"]
    assert m["overall"]["recall"] is not None, m["overall"]
    # every GT class present in the corpus gets a defined seed-quality IoU
    for cls in ("player", "soccer ball", "goalkeeper"):
        assert m[cls]["seedIoUMean"] is not None, (cls, m[cls])


def test_molmo2_arm_degrades_rates():
    """Degrade the molmo2 arm (always drop the soccer-ball class) and confirm
    recall moves the same way as the fixture arm — proving the molmo2 output
    flows through the shared metrics accounting."""
    class DroppingMolmo(_Molmo2TextDetector):
        def detect(self, sample):
            objs = [o for o in sample.get("objects", [])
                    if o["label"] != "soccer ball"]
            by_cls = {}
            for o in objs:
                by_cls.setdefault(o["label"], []).append(o["bbox"])
            dets = []
            for cls in self.vocab:
                dets.extend(molmo2_backend.parse_molmo_detection(
                    _points_utterance(by_cls.get(cls, [])), cls, box_size=self.box_size))
            return dets
    m = dp.eval_detection(demo_corpus(), DroppingMolmo(VOCAB), VOCAB, iou_thresh=0.5)
    # soccer ball is never detected -> per-class recall 0, overall recall < 1
    assert m["soccer ball"]["recall"] == 0.0, m["soccer ball"]
    assert m["overall"]["recall"] < 1.0, m["overall"]
    # a class that is still detected keeps a defined seed-quality IoU
    assert m["player"]["seedIoUMean"] is not None, m["player"]


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
