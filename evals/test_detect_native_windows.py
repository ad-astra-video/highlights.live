"""CPU-only tests for the native-window slice producer (ADAAAA-7801).

Nothing here touches a GPU, the network or the real perceive app: the detector
is stubbed, the frame source is a synthetic rawvideo file, and the one HTTP test
runs against a local server that deliberately refuses byte ranges. The point is
to pin the three ways this producer can lie:

  - the byte-offset math (a mis-mapped window would measure the wrong minute),
  - the Range guard (a mirror that ignores `Range` must fail, not pull 21.8 GB),
  - the envelope guards and the `detectorModel` block (an over-budget run must
    not leave a slice, and a slice must carry the weights identity).
"""
import io
import json
import os
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np
import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import detect_native_windows as dnw  # noqa: E402

SRC_BYTES = 21812283016
SRC_DURATION = 8391.18


def test_byte_offset_is_proportional_and_lands_within_a_second():
    # Measured on the real item: t=1599 s -> 4,156,577,349 bytes, decoded chunk
    # start_time 1598.19 s. Allow the ~1 s the original measurement showed.
    got = dnw.byte_offset_for(1599, SRC_BYTES, SRC_DURATION)
    assert abs(got - 4156577349) / SRC_BYTES < 0.001
    back = got / SRC_BYTES * SRC_DURATION
    assert abs(back - 1599) <= 1.0


def test_byte_offset_clamps_and_rejects_empty_input():
    assert dnw.byte_offset_for(-50, SRC_BYTES, SRC_DURATION) == 0
    assert dnw.byte_offset_for(SRC_DURATION * 2, SRC_BYTES, SRC_DURATION) == SRC_BYTES
    with pytest.raises(SystemExit):
        dnw.byte_offset_for(10, 0, SRC_DURATION)


def test_plan_windows_counts_frames_at_the_analysis_cadence():
    ws = [dnw.parse_window("E01:1599:1620"), dnw.parse_window("E04:3741:3762")]
    assert dnw.plan_windows(ws, 1.0) == 42
    assert dnw.plan_windows(ws, 2.0) == 84


def test_parse_window_rejects_backwards_and_malformed():
    with pytest.raises(SystemExit):
        dnw.parse_window("E01:1620:1599")
    with pytest.raises(SystemExit):
        dnw.parse_window("E01:1599")


def test_read_raw_frames_round_trips_exact_bytes(tmp_path):
    w, h, n = 8, 6, 3
    data = np.arange(w * h * 3 * n, dtype=np.uint8).tobytes()
    p = tmp_path / "frames.rgb"
    p.write_bytes(data)
    frames = list(dnw.read_raw_frames(str(p), w, h))
    assert len(frames) == n
    assert frames[1].shape == (h, w, 3)
    assert frames[2].tobytes() == data[2 * w * h * 3:3 * w * h * 3]


def test_read_raw_frames_ignores_a_trailing_partial_frame(tmp_path):
    w, h = 4, 4
    p = tmp_path / "frames.rgb"
    p.write_bytes(b"\x00" * (w * h * 3 + 5))
    assert len(list(dnw.read_raw_frames(str(p), w, h))) == 1


def test_range_headers_reads_the_last_response():
    dump = (
        "HTTP/1.1 302 Found\r\nLocation: /x\r\n\r\n"
        "HTTP/1.1 206 Partial Content\r\n"
        f"Content-Range: bytes 500000000-500001023/{SRC_BYTES}\r\n\r\n"
    )
    p = os.path.join(os.path.dirname(__file__), "_tmp_headers.txt")
    with open(p, "w") as fh:
        fh.write(dump)
    try:
        status, cr = dnw._range_headers(p)
    finally:
        os.remove(p)
    assert status == "206"
    assert cr == f"bytes 500000000-500001023/{SRC_BYTES}"


class _RangeRefusingHandler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - http.server naming
        body = b"X" * 4096
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):  # silence the test server
        pass


def test_fetch_range_refuses_a_server_that_ignores_range(tmp_path):
    srv = HTTPServer(("127.0.0.1", 0), _RangeRefusingHandler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}/big.ts"
        with pytest.raises(SystemExit) as exc:
            dnw.fetch_range(url, 0, 1023, str(tmp_path / "chunk.ts"))
        assert "refused a byte range" in str(exc.value)
        assert not os.path.exists(str(tmp_path / "chunk.ts.headers"))
    finally:
        srv.shutdown()


class _RedirectingHandler(BaseHTTPRequestHandler):
    """302 to a sibling path that DOES honour Range - archive.org's shape."""

    def do_GET(self):  # noqa: N802 - http.server naming
        if self.path == "/big.ts":
            self.send_response(302)
            self.send_header("Location", "/node/big.ts")
            self.end_headers()
            return
        rng = self.headers.get("Range") or ""
        # bytes=a-b -> a 206 of exactly that slice
        a, b = rng.split("=")[1].split("-")
        start, end = int(a), int(b)
        body = bytes((i * 7) % 251 for i in range(start, end + 1))
        self.send_response(206)
        self.send_header("Content-Range", f"bytes {start}-{end}/21812283016")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_fetch_range_follows_a_redirect_to_a_range_honouring_node(tmp_path):
    # archive.org answers the download URL with 302; only the data node returns
    # 206. Following the redirect is what makes the producer work on this item.
    srv = HTTPServer(("127.0.0.1", 0), _RedirectingHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    dest = str(tmp_path / "chunk.ts")
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}/big.ts"
        got = dnw.fetch_range(url, 4096, 6143, dest)
        assert got["bytes"] == 2048
        with open(dest, "rb") as fh:
            body = fh.read()
        assert body == bytes((i * 7) % 251 for i in range(4096, 6144))
        assert not os.path.exists(dest + ".headers")
    finally:
        srv.shutdown()


class _WrongRangeHandler(BaseHTTPRequestHandler):
    """Answers 206 for a DIFFERENT window than the one requested."""

    def do_GET(self):  # noqa: N802
        body = b"X" * 1024
        self.send_response(206)
        self.send_header("Content-Range", f"bytes 0-1023/{SRC_BYTES}")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


def test_fetch_range_refuses_a_206_for_the_wrong_window(tmp_path):
    srv = HTTPServer(("127.0.0.1", 0), _WrongRangeHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{srv.server_address[1]}/big.ts"
        with pytest.raises(SystemExit) as exc:
            dnw.fetch_range(url, 500000000, 500001023, str(tmp_path / "chunk.ts"))
        assert "different range" in str(exc.value)
    finally:
        srv.shutdown()


# --- stage 2: stubbed detector, no torch, no perceive app -------------------


class _StubProfile:
    key = "american football"
    vocabulary = ["football", "player", "referee"]


class _StubDetector:
    device_label = "cpu"

    def __init__(self, *a, **k):
        self.calls = 0

    def load(self):
        pass

    def detect(self, img, vocabulary=None, roi_pass=False):
        self.calls += 1
        # 22 objects on the middle frame, 3 elsewhere: the cap question's shape.
        n = 22 if self.calls == 2 else 3
        return [{"label": "player", "bbox": [0.1, 0.1, 0.2, 0.2], "confidence": 0.5}] * n

    def weights_identity(self, digest=True):
        return {"source": "/runs/Florence-2-base-finetuned-ft6404gpu", "kind": "local_dir",
                "digest": [{"file": "model.safetensors", "sha256": "ab" * 32, "bytes": 926356836}]}


@pytest.fixture()
def stub_app(monkeypatch):
    app = types.ModuleType("app")
    gp = types.ModuleType("app.game_profile")
    gp.load_game_profile = lambda name: _StubProfile()
    fl = types.ModuleType("app.florence")
    fl.FlorenceDetector = _StubDetector
    monkeypatch.setitem(sys.modules, "app", app)
    monkeypatch.setitem(sys.modules, "app.game_profile", gp)
    monkeypatch.setitem(sys.modules, "app.florence", fl)
    return app


def _write_fetch_dir(root, windows, width=8, height=6):
    os.makedirs(root, exist_ok=True)
    idx = {"source": {"url": "https://archive.org/download/item/football.ts",
                      "bytes": SRC_BYTES, "duration_s": SRC_DURATION},
           "fps": 1.0, "width": width, "height": height, "preRollS": 25.0,
           "windows": []}
    for wid, n in windows:
        name = f"{wid}.rgb"
        with open(os.path.join(root, name), "wb") as fh:
            fh.write(b"\x10" * (width * height * 3 * n))
        idx["windows"].append({
            "id": wid, "t_start": 1599.0, "t_end": 1599.0 + n, "frames": n,
            "framesPath": name, "fetchedByteStart": 1, "fetchedByteEnd": 2,
            "fetchedBytes": 2, "fetchedSha256": "cd" * 32,
        })
    with open(os.path.join(root, "fetch-index.json"), "w") as fh:
        json.dump(idx, fh)
    return root


def _detect_args(root, out, max_frames=63, budget=2.0):
    return types.SimpleNamespace(fetch_dir=root, profile="american football", type_key=None,
                                 model=None, max_frames=max_frames,
                                 budget_gpu_minutes=budget, out=out)


def test_detect_writes_a_slice_with_detector_model_and_source(tmp_path, stub_app):
    root = _write_fetch_dir(str(tmp_path / "fetch"), [("E01", 3)])
    out = str(tmp_path / "slice.json")
    assert dnw.cmd_detect(_detect_args(root, out)) == 0
    doc = json.load(open(out))
    # Same schema the 480p producer writes, so existing scorers read it unchanged.
    for key in ("type", "profile", "vocabulary", "fps", "clip", "frames", "latency",
                "detector", "detectorModel", "envelope", "windows"):
        assert key in doc, key
    assert doc["frames"] == 3
    assert doc["detector"] == "cpu"
    assert doc["detectorModel"]["digest"][0]["sha256"] == "ab" * 32
    assert doc["source"]["url"].endswith("football.ts")
    assert doc["source"]["width"] == 8
    # Frame timestamps are window-relative, not global.
    assert [f["t"] for f in doc["windows"][0]["frames"]] == [1599.0, 1600.0, 1601.0]
    # The 22-object frame is visible from the artifact alone.
    assert doc["windows"][0]["objectsPerFrame"]["max"] == 22


def test_detect_aborts_before_writing_when_the_envelope_is_too_small(tmp_path, stub_app):
    root = _write_fetch_dir(str(tmp_path / "fetch"), [("E01", 3)])
    out = str(tmp_path / "slice.json")
    with pytest.raises(SystemExit) as exc:
        dnw.cmd_detect(_detect_args(root, out, max_frames=2))
    assert "exceeds the approved envelope" in str(exc.value)
    assert not os.path.exists(out)


def test_detect_aborts_mid_run_on_the_minute_envelope(tmp_path, stub_app):
    root = _write_fetch_dir(str(tmp_path / "fetch"), [("E01", 3)])
    out = str(tmp_path / "slice.json")
    with pytest.raises(SystemExit):
        dnw.cmd_detect(_detect_args(root, out, max_frames=63, budget=-1.0))
    assert not os.path.exists(out)
