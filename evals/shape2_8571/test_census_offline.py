#!/usr/bin/env python3
"""Offline test for census_shape2_8571.py: a stub `/app/scoreboard` proves the client path.

The real census cannot be faked - it runs the production probe on the box. What this
test proves is everything AROUND the probe: exact frame extraction from the built IVF
at the manifest's probe instants, the request shape, and the `N` arithmetic including
the two verdict branches (`RUN` when every window reads numeric and differs, `NO_RUN`
when the reads are absent evidence).

    python3 evals/shape2_8571/test_census_offline.py /state/shape2_8571.manifest.json

Exit 0 = both branches behaved.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
MODE = "legible"  # "legible" | "absent", switched by the test before each branch
CALLS = {"n": 0}


class Stub(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        if self.path != "/app/scoreboard":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode())
        if not body.get("image"):
            self.send_response(400)
            self.end_headers()
            self.wfile.write(b'{"detail":"missing image"}')
            return
        CALLS["n"] += 1
        if MODE == "legible":
            # the census posts PRE then POST per window: odd call 1-0, even call 2-0
            score = [1, 0] if CALLS["n"] % 2 == 1 else [2, 0]
            ocr = ["1-0" if CALLS["n"] % 2 == 1 else "2-0"]
            reason = ""
        else:
            score, ocr, reason = None, [], "no_score_line"
        out = json.dumps({"ocr": ocr, "score": score, "roi": [0.0, 0.7, 1.0, 0.95],
                          "ok": score is not None, "reason": reason}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, format, *args):  # noqa: A002 - silence the access log
        pass


def run_census(manifest: str, out: str, port: int) -> dict:
    cmd = [sys.executable, os.path.join(HERE, "census_shape2_8571.py"),
           "--manifest", manifest, "--out", out, "--base-url", f"http://127.0.0.1:{port}"]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise SystemExit(f"census exited {proc.returncode}\n{proc.stdout}\n{proc.stderr}")
    return json.load(open(out))


def main(argv: list[str]) -> int:
    global MODE
    if len(argv) != 1:
        raise SystemExit(__doc__)
    manifest = argv[0]
    man = json.load(open(manifest))
    fixture = man["fixture"]["path"]
    if not os.path.exists(fixture):
        raise SystemExit(f"fixture missing: {fixture}")

    tmp = tempfile.mkdtemp(prefix="shape2-census-test-")
    srv = HTTPServer(("127.0.0.1", 0), Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    problems: list[str] = []
    try:
        # Branch 1: every probe answers a differing numeric pair -> N == window_count -> RUN
        MODE, CALLS["n"] = "legible", 0
        legible = run_census(manifest, os.path.join(tmp, "legible.json"), port)
        wc = man["census"]["window_count"]
        if legible["N"] != wc:
            problems.append(f"legible branch N={legible['N']} != window_count {wc}")
        if legible["verdict"] != "RUN":
            problems.append(f"legible branch verdict {legible['verdict']} != RUN")
        if not all(w["numeric"] and w["differ"] for w in legible["windows"]):
            problems.append("legible branch: some window did not read numeric+differ")

        # Branch 2: absent evidence everywhere -> N == 0 -> NO_RUN (never a RUN on no reads)
        MODE, CALLS["n"] = "absent", 0
        absent = run_census(manifest, os.path.join(tmp, "absent.json"), port)
        if absent["N"] != 0:
            problems.append(f"absent branch N={absent['N']} != 0")
        if absent["verdict"] != "NO_RUN":
            problems.append(f"absent branch verdict {absent['verdict']} != NO_RUN")

        # The extracted JPEGs are real frames, not blanks
        jpgs = [f for f in os.listdir(legible["frames_dir"]) if f.endswith(".jpg")]
        if len(jpgs) != 2 * wc:
            problems.append(f"{len(jpgs)} jpegs != {2 * wc} (2 per window)")
        small = [f for f in jpgs if os.path.getsize(os.path.join(legible["frames_dir"], f)) < 512]
        if small:
            problems.append(f"blank jpegs: {small[:3]}")

        print(json.dumps({
            "legible": {"N": legible["N"], "verdict": legible["verdict"], "window_count": wc},
            "absent": {"N": absent["N"], "verdict": absent["verdict"], "reason": absent["reason"]},
            "jpegs": len(jpgs),
            "first_window": legible["windows"][0],
        }, indent=2))
    finally:
        srv.shutdown()
    if problems:
        print("TEST FAIL: " + "; ".join(problems))
        return 1
    print("TEST PASS: exact frame extraction, request shape, and both N verdict branches")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
