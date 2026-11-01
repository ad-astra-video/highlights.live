"""Self-check for the dense crossing strip reader (ADAAAA-7693).

Runner-level tests: no network. The `strip` case runs real host ffmpeg on a tiny
synthetic clip when ffmpeg is available (that is the part an edit could silently
break — frame count, tile grid, sheet size guard), everything else is offline so
the AC-bar arithmetic and the read-verdict semantics stay pinned.

Why guard these: the strip read is only promotable if a "refuted" verdict means
the model *looked at the ball and said it did not cross*. If `verdict_of` starts
counting a blind "no" as a refutation, or `summarize` starts treating a split
repeat as reproducible, the harness would pass the bar on evidence that does not
exist — the exact failure mode RESULTS.md records for the single-frame probe.
"""
import importlib
import json
import pathlib
import shutil
import subprocess
import sys

import pytest

HERE = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

ncs = importlib.import_module("native_crossing_strip")


UPSTREAM = HERE / "results" / "shot_vs_goal_discrimination.json"


def test_committed_plan_has_the_8_goals_4_fps_and_12_controls():
    """The committed plan is the artifact the AC reads were taken from, so pin it:
    a silent edit to the candidate set would invalidate the recorded table."""
    plan = json.load(open(HERE / "results" / "native_crossing_strip_plan.json"))
    assert plan["counts"] == {"goal": 8, "shot_fp": 4, "control": 12}
    goals = [p for p in plan["plan"] if p["kind"] == "goal"]
    fps = [p for p in plan["plan"] if p["kind"] == "shot_fp"]
    controls = [p for p in plan["plan"] if p["kind"] == "control"]
    assert sorted(round(p["instant"], 1) for p in fps) == [178.1, 203.2, 358.8, 401.7]
    assert all(p["goal_label"] for p in goals)
    assert all(p["goal_label"] is None for p in fps)
    for c in controls:
        assert c["instant"] == pytest.approx(sum(c["window"]) / 2.0, abs=0.01)
    # the 277-284 goal window overlaps control ks-n-0282's instant, and that has
    # to stay visible so a "crossed" control read is not counted as a failure
    assert [c["id"] for c in controls if c["instant_in_goal_window"]] == ["ks-n-0282"]


@pytest.mark.skipif(not UPSTREAM.exists(),
                    reason="AC-4 artifact (ADAAAA-7687) not on this branch yet")
def test_plan_rebuilds_from_the_ac4_artifact():
    plan = ncs.build_plan(json.load(open(UPSTREAM)),
                          json.load(open(HERE / "label-manifest.json")))
    committed = json.load(open(HERE / "results" / "native_crossing_strip_plan.json"))
    assert plan["counts"] == committed["counts"]
    assert [p["id"] for p in plan["plan"]] == [p["id"] for p in committed["plan"]]


def test_session_frames_and_anchor_index():
    times = ncs.session_frames(177.6, 1.0, 30)
    assert len(times) == 30
    assert times[0] == pytest.approx(177.6, abs=1e-3)
    assert times[15] == pytest.approx(178.1, abs=1e-3)      # anchor instant
    assert ncs.sheet_geometry() == (1334, 650)


def test_sheet_geometry_is_under_the_measured_channel_limit():
    w, h = ncs.sheet_geometry()
    assert w * h / 1e6 <= ncs.MAX_SHEET_MPIX


def test_tile_box_is_row_major_and_full_grid():
    # 30 tiles in 6 cols x 5 rows, no overlap, last tile inside the sheet
    w, h = ncs.sheet_geometry()
    boxes = [ncs.tile_box(i) for i in range(ncs.COLS * ncs.ROWS)]
    assert boxes[0][0] == ncs.MARGIN and boxes[0][1] >= ncs.HEADER_H
    assert boxes[5][1] == boxes[0][1]                       # same row
    assert boxes[6][0] == boxes[0][0] and boxes[6][1] > boxes[0][1]
    assert boxes[-1][2] <= w and boxes[-1][3] <= h
    for a, b in zip(boxes, boxes[1:]):
        assert not (a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3])


def test_compose_sheet_outlines_the_anchor_tile(tmp_path):
    from PIL import Image
    paths = []
    for i in range(30):
        p = tmp_path / f"f_{i + 1:03d}.png"
        Image.new("RGB", (ncs.CELL_W, ncs.CELL_H), (30, 30, 30)).save(p)
        paths.append(str(p))
    sheet, meta = ncs.compose_sheet(paths, anchor_index=15, header="test")
    assert meta["anchor_tile"] == 16 and meta["megapixels"] <= ncs.MAX_SHEET_MPIX
    import numpy as np
    arr = np.array(sheet).astype(int)
    x0, y0, x1, _ = ncs.tile_box(15)
    top = arr[y0, x0:x1]
    assert ((top[:, 0] > 150) & (top[:, 1] < 90) & (top[:, 2] < 90)).sum() >= x1 - x0 - 2
    # a neighbouring tile is NOT outlined
    x0b, y0b, x1b, _ = ncs.tile_box(14)
    topb = arr[y0b, x0b:x1b]
    assert ((topb[:, 0] > 150) & (topb[:, 1] < 90) & (topb[:, 2] < 90)).sum() <= 2


def test_compose_sheet_refuses_an_oversized_sheet(tmp_path):
    from PIL import Image
    p = tmp_path / "f.png"
    Image.new("RGB", (ncs.CELL_W, ncs.CELL_H)).save(p)
    with pytest.raises(ValueError):
        ncs.compose_sheet([str(p)], anchor_index=0, header="x", limit_mpix=0.5)


def test_parse_reply_reads_the_terse_line():
    parsed = ncs.parse_reply("CROSS=no; BALL=yes; SCENE=shot_stopped; ANCHOR=14")
    assert parsed == {"cross": "no", "ball": "yes", "scene": "shot_stopped",
                      "anchor": "14"}
    assert ncs.parse_reply("no idea")["cross"] is None


def test_a_blind_no_is_not_a_refutation():
    # looked and said no -> refuted; did not see the ball -> unmeasured_ball
    assert ncs.verdict_of({"cross": "no", "ball": "yes"}) == "refuted"
    assert ncs.verdict_of({"cross": "no", "ball": "no"}) == "unmeasured_ball"
    assert ncs.verdict_of({"cross": "no", "ball": None}) == "unmeasured"
    assert ncs.verdict_of({"cross": "yes", "ball": "yes"}) == "crossed"
    # a transport failure is unmeasured even if a partial reply was parsed
    assert ncs.verdict_of({"cross": "no", "ball": "yes"}, err="timeout") == "unmeasured"
    assert ncs.verdict_of({}, err=None) == "unmeasured"


def _reads(verdicts_by_id, repeat=2):
    rows = []
    for rid, (kind, instant, verdicts) in verdicts_by_id.items():
        for i in range(repeat):
            rows.append({"id": rid, "kind": kind, "instant": instant,
                         "read_index": i, "raw": "", "parsed": {},
                         "verdict": verdicts[i], "err": None, "elapsed_s": 1.0})
    return rows


def _write(tmp_path, rows):
    p = tmp_path / "reads.jsonl"
    p.write_text("\n".join(json.dumps(r) for r in rows) + "\n")
    return str(p)


def _summarize(rows, tmp_path):
    out = tmp_path / "sum.json"
    ncs.summarize(type("A", (), {"reads": _write(tmp_path, rows),
                                 "json": str(out), "model": "m"})())
    return json.load(open(out))


def test_bar_met_only_when_every_read_agrees(tmp_path):
    rows = {}
    for i in range(8):
        rows[f"fa_goal_{i}"] = ("goal", 100.0 + i, ["crossed", "crossed"])
    for i in range(4):
        rows[f"fa_shotfp_{i}"] = ("shot_fp", 200.0 + i, ["refuted", "refuted"])
    for i in range(12):
        rows[f"ks-n-{i}"] = ("control", 300.0 + i, ["refuted", "refuted"])
    s = _summarize(_reads(rows), tmp_path)
    assert s["bar"] == {"fp_all_refuted_reproducible": True, "no_goal_refuted": True,
                        "goals_all_crossed": True, "met": True, "promotion_ready": True}


def test_split_read_is_not_reproducible(tmp_path):
    rows = {}
    for i in range(8):
        rows[f"fa_goal_{i}"] = ("goal", 100.0 + i, ["crossed", "crossed"])
    for i in range(4):
        rows[f"fa_shotfp_{i}"] = ("shot_fp", 200.0 + i,
                                  ["refuted", "refuted"] if i else ["refuted", "crossed"])
    for i in range(12):
        rows[f"ks-n-{i}"] = ("control", 300.0 + i, ["refuted", "refuted"])
    s = _summarize(_reads(rows), tmp_path)
    assert s["shot_fps"]["refuted_on_every_read"] == ["fa_shotfp_1", "fa_shotfp_2",
                                                      "fa_shotfp_3"]
    assert s["bar"]["met"] is False and s["bar"]["promotion_ready"] is False


def test_one_refuted_goal_fails_the_bar(tmp_path):
    rows = {}
    for i in range(8):
        rows[f"fa_goal_{i}"] = ("goal", 100.0 + i, ["crossed", "crossed"])
    rows["fa_goal_3"] = ("goal", 103.0, ["refuted", "refuted"])
    for i in range(4):
        rows[f"fa_shotfp_{i}"] = ("shot_fp", 200.0 + i, ["refuted", "refuted"])
    for i in range(12):
        rows[f"ks-n-{i}"] = ("control", 300.0 + i, ["refuted", "refuted"])
    s = _summarize(_reads(rows), tmp_path)
    assert s["bar"]["no_goal_refuted"] is False and s["bar"]["met"] is False


def test_unmeasured_goal_blocks_promotion_but_not_the_literal_bar(tmp_path):
    rows = {}
    for i in range(8):
        rows[f"fa_goal_{i}"] = ("goal", 100.0 + i, ["crossed", "crossed"])
    rows["fa_goal_5"] = ("goal", 105.0, ["unmeasured", "unmeasured"])
    for i in range(4):
        rows[f"fa_shotfp_{i}"] = ("shot_fp", 200.0 + i, ["refuted", "refuted"])
    for i in range(12):
        rows[f"ks-n-{i}"] = ("control", 300.0 + i, ["refuted", "refuted"])
    s = _summarize(_reads(rows), tmp_path)
    assert s["bar"]["met"] is True                     # literal AC bar
    assert s["bar"]["promotion_ready"] is False        # 7/8 goals read as crossed


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs host ffmpeg")
def test_strip_end_to_end_on_a_synthetic_clip(tmp_path):
    video = tmp_path / "synth.mp4"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=1280x720:rate=60:duration=4",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         str(video)], check=True)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"plan": [{"id": "c1", "kind": "goal", "instant": 2.0},
                                         {"id": "c2", "kind": "control", "instant": 3.5}]}))
    out = tmp_path / "sheets"
    ncs.strip(type("A", (), {"video": str(video), "plan": str(plan),
                             "out": str(out), "fps": 30, "span": 1.0,
                             "offsets": None, "cols": ncs.COLS, "rows": ncs.ROWS,
                             "cell_w": ncs.CELL_W, "cell_h": ncs.CELL_H,
                             "ffmpeg": "ffmpeg"})())
    manifest = json.load(open(out / "strip_manifest.json"))
    assert manifest["count"] == 2
    for s in manifest["sheets"]:
        assert s["frames"] == 30 and s["short_frames"] is False
        assert s["megapixels"] <= ncs.MAX_SHEET_MPIX
        assert (out / s["sheet"]).stat().st_size > 5000


def test_anchor_index_is_the_tile_nearest_the_instant():
    assert ncs.anchor_index_for(["-0.25", "-0.125", "0", "0.125"]) == 2
    assert ncs.anchor_index_for([0.0]) == 0
    assert ncs.anchor_index_for([-0.02, 0.05]) == 0


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="needs host ffmpeg")
def test_resolution_variant_sheets(tmp_path):
    """The offset mode has to build a smaller, higher-resolution sheet (the
    resolution control that separates 'cell too small' from 'no signal')."""
    video = tmp_path / "synth.mp4"
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
         "-i", "testsrc2=size=1280x720:rate=60:duration=4",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
         str(video)], check=True)
    plan = tmp_path / "plan.json"
    plan.write_text(json.dumps({"plan": [{"id": "c1", "kind": "goal", "instant": 2.0}]}))
    out = tmp_path / "v2"
    ncs.strip(type("A", (), {"video": str(video), "plan": str(plan),
                             "out": str(out), "fps": 30, "span": 1.0,
                             "offsets": "-0.25,-0.125,0,0.125", "cols": 4, "rows": 1,
                             "cell_w": 440, "cell_h": 248, "ffmpeg": "ffmpeg"})())
    s = json.load(open(out / "strip_manifest.json"))["sheets"][0]
    assert s["frames"] == 4 and s["anchor_tile"] == 3
    assert s["cell"] == [440, 248] and s["megapixels"] <= ncs.MAX_SHEET_MPIX
    assert s["megapixels"] > 0.4        # 2.2x the pixels per frame of the dense sheet
