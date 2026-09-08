"""Container boot gate: refuse to start (and thus refuse to register) when the
configured Florence-2 device cannot sustain the required throughput.

Exits 0 when PERCEIVE_MODE=stub or the device passes the fps gate; exits 1
otherwise so the live-runner process never boots and never registers with the
orchestrator.

Env:
  PERCEIVE_MODE      stub (default) | florence
  PERCEIVE_MIN_FPS   minimum frames/second to pass (default 1.0)
"""
import os
import sys

from app.florence import gate_1fps


def main() -> int:
    mode = os.environ.get("PERCEIVE_MODE", "stub")
    if mode != "florence":
        print("[bootcheck] PERCEIVE_MODE=stub — no device gate; OK", flush=True)
        return 0
    try:
        min_fps = float(os.environ.get("PERCEIVE_MIN_FPS", "1.0"))
    except ValueError:
        min_fps = 1.0
    print(f"[bootcheck] running device 1fps gate (min {min_fps:.2f} fps)...", flush=True)
    ok, fps, detail = gate_1fps(min_fps=min_fps)
    print(f"[bootcheck] {detail}  [{'PASS' if ok else 'FAIL'}]", flush=True)
    if not ok:
        print("[bootcheck] cannot sustain the required fps — NOT registering worker", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
