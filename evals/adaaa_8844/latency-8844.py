"""ADAAAA-8844 AC2.4: the decide-path latency is unchanged (in-process A/B).

The identity pass lives in perceive and runs at most twice per session; on the
decide side the change adds one optional evidence FIELD, so the request is
byte-identical when no surface was measured and the rule does one string compare
when one was. This probe times the pure decider and the served endpoint both
ways so the claim is measured, not asserted.
"""
import json
import statistics
import sys
import time

sys.path.insert(0, "services/decide")

from fastapi.testclient import TestClient  # noqa: E402

from app import app  # noqa: E402
from app.decider import decide  # noqa: E402

client = TestClient(app)
N = 2000


def pct(xs, q):
    xs = sorted(xs)
    k = (len(xs) - 1) * q
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 4)


def timed(fn, n=N):
    xs = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        xs.append((time.perf_counter() - t0) * 1e6)  # microseconds
    return {"p50_us": pct(xs, 0.5), "p95_us": pct(xs, 0.95), "n": n}


def rule_path(identity):
    if identity is None:
        return lambda: decide("GOAL", track_count=0, max_velocity=0.0, score_board_changed=True)
    return lambda: decide(
        "GOAL", track_count=0, max_velocity=0.0, score_board_changed=True, surface_identity=identity
    )


def endpoint_path(identity):
    evidence = {"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0, "scoreBoardChanged": True}
    if identity is not None:
        evidence["scoreboardSurfaceIdentity"] = identity
    body = {"sessionId": "lat", "eventType": "GOAL", "timestamp": 1.0, "evidence": evidence}
    return lambda: client.post("/app/highlight", json=body)


def main():
    out = {
        "issue": "ADAAAA-8844",
        "ac": "AC2.4",
        "rule_decider": {
            "baseline_no_identity": timed(rule_path(None)),
            "identity_consistent": timed(rule_path("consistent")),
            "identity_absent": timed(rule_path("absent")),
            "identity_contradicted": timed(rule_path("contradicted")),
        },
        "served_endpoint": {
            "baseline_no_identity": timed(endpoint_path(None), 400),
            "identity_present": timed(endpoint_path("consistent"), 400),
        },
        "payload_bytes": {
            "no_identity": len(json.dumps({"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0, "scoreBoardChanged": True})),
            "with_identity": len(json.dumps({"trackCount": 0, "maxVelocity": 0.0, "ocrHits": 0,
                                             "scoreBoardChanged": True, "scoreboardSurfaceIdentity": "contradicted"})),
        },
    }
    print(json.dumps(out, indent=1))
    b = out["rule_decider"]["baseline_no_identity"]
    for k in ("identity_consistent", "identity_absent", "identity_contradicted"):
        d = out["rule_decider"][k]
        delta = d["p50_us"] - b["p50_us"]
        out.setdefault("deltas_us", {})[k] = {"p50": round(delta, 2), "p95": round(d["p95_us"] - b["p95_us"], 2)}
    print(json.dumps({"deltas_us": out["deltas_us"]}, indent=1))


if __name__ == "__main__":
    main()
