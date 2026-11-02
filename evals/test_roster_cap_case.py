"""CPU-only tests for the roster cap case (ADAAAA-7801 AC2).

The deployed tracker is pure Python, so the cap answer is testable without a GPU,
a slice on disk, or the perceive app beyond `app.tracker`. The tests pin the two
numbers AC2 asks for: at 22 concurrent objects the 3-object live cap keeps 3 and
drops 19, the 8-object VOD cap keeps 8 and drops 14, and the 22-object case is
only reported as measured when such a frame exists in the slice.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import roster_cap_case as rcc  # noqa: E402


def _obj(label="player", x=0.1, y=0.1):
    # Spread the boxes so the tracker has distinct detections to place.
    return {"label": label, "bbox": [x, y, x + 0.05, y + 0.05], "score": 0.9}


def _slice(window_objects, fps=1.0):
    """`window_objects` = {window_id: [objects_per_frame, ...]}"""
    windows = []
    frames_total = 0
    for wid, per_frame in window_objects.items():
        frames = []
        for i, objs in enumerate(per_frame):
            frames.append({"t": 1599.0 + i, "objects": objs})
            frames_total += 1
        windows.append({"id": wid, "t_start": 1599.0, "t_end": 1620.0, "frames": frames})
    return {"profile": "american football", "fps": fps, "frames": frames_total,
            "detector": "cpu", "windows": windows, "detectorModel": {"source": "/runs/x"}}


def test_dense_frame_answers_the_cap_question_for_both_caps():
    dense = [_obj(x=0.01 * i, y=0.01 * i) for i in range(22)]
    doc = rcc.build_doc(_slice({"E01": [[_obj()], dense, [_obj()]]}), [3, 8])

    assert doc["has22ObjectFrame"] is True
    assert doc["densestFrameInSlice"]["detections"] == 22

    live = doc["caps"]["3"]["densestFrame"]
    assert live["kept"] == 3
    assert live["dropped"] == 19
    assert round(live["dropped"] / live["detections"], 4) == 0.8636

    vod = doc["caps"]["8"]["densestFrame"]
    assert vod["kept"] == 8
    assert vod["dropped"] == 14
    assert round(vod["dropped"] / vod["detections"], 4) == 0.6364


def test_cap_never_keeps_more_than_capacity_across_a_run():
    crowded = [_obj(x=0.01 * i, y=0.01 * i) for i in range(22)]
    doc = rcc.build_doc(_slice({"E01": [crowded] * 5}), [3, 8])
    assert doc["caps"]["3"]["maxKept"] == 3
    assert doc["caps"]["8"]["maxKept"] == 8
    assert doc["caps"]["3"]["framesAtCap"] == 5
    assert doc["caps"]["8"]["framesAtCap"] == 5


def test_at22_arithmetic_is_labelled_as_arithmetic_not_a_measurement():
    doc = rcc.build_doc(_slice({"E01": [[_obj()]]}), [3, 8])
    assert doc["has22ObjectFrame"] is False
    live = doc["caps"]["3"]["at22Objects"]
    assert (live["kept"], live["dropped"], live["droppedShare"]) == (3, 19, 0.8636)
    assert "not a measured frame" in live["basis"]
    vod = doc["caps"]["8"]["at22Objects"]
    assert (vod["kept"], vod["dropped"], vod["droppedShare"]) == (8, 14, 0.6364)


def test_stale_slots_are_not_counted_as_kept_detections():
    # Frame 1 has one detection, frame 2 has none: the track survives
    # lost_before_evict frames, so occupancy is 1 while NOTHING was carried in
    # frame 2. Counting occupancy as "kept" would credit a dropped box.
    doc = rcc.build_doc(_slice({"E01": [[_obj()], []]}), [3])
    run = doc["caps"]["3"]
    assert run["detections"] == 1
    assert run["keptTotal"] == 1
    assert run["droppedTotal"] == 0
    assert run["staleSlotsTotal"] == 1
    assert [f["staleSlots"] for f in run["perFrame"]] == [0, 1]


def test_empty_slice_reports_zeros_and_no_densest_frame():
    doc = rcc.build_doc(_slice({"E01": []}), [3])
    assert doc["densestFrameInSlice"] is None
    assert doc["has22ObjectFrame"] is False
    run = doc["caps"]["3"]
    assert run["detections"] == 0
    assert run["droppedTotal"] == 0
    assert run["droppedShare"] is None


def test_cli_writes_the_per_frame_document(tmp_path):
    dense = [_obj(x=0.01 * i, y=0.01 * i) for i in range(22)]
    src = tmp_path / "slice.json"
    src.write_text(json.dumps(_slice({"E01": [[_obj()], dense]})))
    out = tmp_path / "cap.json"
    assert rcc.main.__module__  # keep the import meaningful under pytest
    assert _run_main([str(src), "--caps", "3,8", "--json", str(out)]) == 0
    doc = json.loads(out.read_text())
    assert doc["caps"]["3"]["densestFrame"]["detections"] == 22
    assert doc["caps"]["8"]["densestFrame"]["kept"] == 8
    assert len(doc["caps"]["3"]["perFrame"]) == 2


def _run_main(argv):
    old = sys.argv
    sys.argv = ["roster_cap_case.py"] + argv
    try:
        return rcc.main()
    finally:
        sys.argv = old
