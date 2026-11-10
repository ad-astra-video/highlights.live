#!/usr/bin/env python3
"""Register ONE highlights.live runner container with the go-livepeer orchestrator.

ADAAAA-8553 (S1): the decide fleet registers per CONTAINER, not as one
aggregate runner behind nginx. Each decide container gets its own registrar
sidecar with a distinct `RUNNER_ID`, its own health probe and its own
registration lifetime, so the registry — not the nginx router — owns decide
readiness, capacity and failover:

    highlights-decide-5090-1   http://192.168.1.151:8091  capacity 4  tier=5090
    highlights-decide-5090-2   http://192.168.1.151:8092  capacity 4  tier=5090
    highlights-decide-5090-3   http://192.168.1.151:8093  capacity 4  tier=5090
    highlights-decide-x99      http://decide:8081         capacity 2  tier=x99-fallback
    highlights-decide-x99-b    http://decide-b:8081       capacity 2  tier=x99-fallback

`RUNNER_CAPACITY` is therefore a LITERAL per-container number (4 on a 5090
worker, 2 on an x99 worker), not a derivation from `docker/decide-router.conf`.
The old `RUNNER_CAPACITY=auto` pool parser is retired: the observe/decide
admission sum still matches every registration on the shared
`app=highlights-live/decide` leaf, so five registrations advertise 4+4+4+2+2 =
16 slots with no router in the arithmetic. `decide-router` stays in compose as
a manual/debug path and the `DECIDE_URL` fallback.

go-livepeer v0.9.2 dynamic registration (`ai/runner/live_runner.go`):

    POST <orch>/runners/heartbeat          auth: registration secret   (first registration)
    POST <orch>/runners/heartbeat          auth: heartbeat secret      (every 5 s)
    POST <orch>/runners/<runner_id>/unregister  auth: heartbeat secret  (shutdown / unhealthy)

Two behaviours matter for a per-container fleet:

1. `capacity` is LITERAL and per container. It is the container's own
   `--max-num-seqs` (4 for each 5090 worker, 2 for each x99 worker), so the
   advertised ceiling moves only when that container is re-deployed — never
   because an unrelated router config was rewritten.
2. `status` is reported, not probed. The registry probes only STATIC runners
   (`checkStaticRunnerHealth`); a dynamic runner's readiness is whatever the
   heartbeat says, and its entry expires after `heartbeat_ttl` (20 s) with no
   heartbeat. This sidecar therefore (a) heartbeats every interval, (b) reports
   `ready` only while THAT container's `/health` answers, and (c) unregisters
   when it stops answering or on SIGTERM. Each process probes only its own
   `RUNNER_URL`; no process shares a health probe with another container, so
   one worker dying releases only that worker's sessions.

Modes (used by the test suite, so the config assertions run the real parser):
    python3 live-runner-registrar.py --print-payload    # one payload JSON, no network
    python3 live-runner-registrar.py --print-capacity   # literal capacity integer
    python3 live-runner-registrar.py                    # daemon (container command)

Environment (all required unless noted):
    ORCH_URL              https://orchestrator:8935       go-livepeer rpc base URL
                                                          (on the 5090 host:
                                                          https://192.168.1.6:8935)
    ORCH_SECRET           orchestrator secret for first registration
    RUNNER_ID             e.g. highlights-decide-5090-1   MUST be unique per
                                                          container; a client calls
                                                          `/apps/<id>/app/...`
    RUNNER_APP            e.g. highlights-live/decide
    RUNNER_URL            http://192.168.1.151:8091        THAT container, reachable
                                                          from the orchestrator
    RUNNER_HEALTH_URL     /health (relative joins onto RUNNER_URL)
    RUNNER_MODE           persistent | single-shot       (default persistent)
    RUNNER_PROXY          1|0                             (default 0; decide is 0)
    RUNNER_CAPACITY       literal integer slots           (required; 4 per 5090,
                                                          2 per x99 worker)
    RUNNER_METADATA       JSON string carrying tier + seqs (optional)
    RUNNER_VERSION        optional
    RUNNER_GPU_ID / RUNNER_GPU_NAME / RUNNER_GPU_VRAM_MB   optional
    RUNNER_PRICE / RUNNER_PRICE_CURRENCY / RUNNER_PRICE_UNIT   default 0.01/usd/hour
    RUNNER_HEALTHY_STATUS expected health status code, default 200
    REGISTRAR_INTERVAL_S  heartbeat period, default 5 (must stay below the 20 s TTL)
    REGISTRAR_LOG_PREFIX  log prefix, default [live-runner-registrar]

Stdlib only: the sidecar image is `python:3.12-alpine` and the orchestrator's
8935 endpoint is TLS with a self-signed cert, so every request skips
verification (same trust posture as the server's `mc` client and the signer).
"""
from __future__ import annotations

import json
import os
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Mapping, Optional


class RunnerConfig:
    def __init__(self, env: Mapping[str, str]):
        self.orch_url = env.get("ORCH_URL", "https://orchestrator:8935").rstrip("/")
        self.orch_secret = env.get("ORCH_SECRET", "")
        self.runner_id = env.get("RUNNER_ID", "")
        self.app = env.get("RUNNER_APP", "")
        self.runner_url = env.get("RUNNER_URL", "")
        self.health_url = env.get("RUNNER_HEALTH_URL", "/health")
        self.mode = env.get("RUNNER_MODE", "persistent")
        self.proxy = env.get("RUNNER_PROXY", "0") == "1"
        self.capacity_raw = env.get("RUNNER_CAPACITY", "")
        self.metadata = env.get("RUNNER_METADATA", "")
        self.version = env.get("RUNNER_VERSION", "")
        self.gpu_id = env.get("RUNNER_GPU_ID", "")
        self.gpu_name = env.get("RUNNER_GPU_NAME", "")
        self.gpu_vram_mb = int(env.get("RUNNER_GPU_VRAM_MB", "0") or 0)
        self.price = env.get("RUNNER_PRICE", "0.01")
        self.price_currency = env.get("RUNNER_PRICE_CURRENCY", "usd")
        self.price_unit = env.get("RUNNER_PRICE_UNIT", "hour")
        self.healthy_status = int(env.get("RUNNER_HEALTHY_STATUS", "200") or 200)
        self.interval = float(env.get("REGISTRAR_INTERVAL_S", "5") or 5)
        self.prefix = env.get("REGISTRAR_LOG_PREFIX", "[live-runner-registrar]")

    # --- capacity -------------------------------------------------------
    def capacity(self) -> int:
        """The container's OWN literal slot count.

        Per-container registration means capacity is declared by the container
        (its `--max-num-seqs`), never derived from a shared router config: a
        5090 worker advertises 4, an x99 worker 2. A missing/non-positive
        value is a configuration bug, not a transient read, so it fails loudly
        at startup instead of publishing a made-up ceiling.
        """
        if not self.capacity_raw:
            raise SystemExit(
                f"{self.prefix} RUNNER_CAPACITY is required (literal slots: "
                f"4 per 5090 worker, 2 per x99 worker)"
            )
        try:
            value = int(self.capacity_raw)
        except ValueError:
            raise SystemExit(
                f"{self.prefix} RUNNER_CAPACITY must be a literal integer, "
                f"got {self.capacity_raw!r} (the auto pool derivation is retired)"
            )
        if value <= 0:
            raise SystemExit(
                f"{self.prefix} RUNNER_CAPACITY must be > 0, got {value}"
            )
        return value

    # --- payload --------------------------------------------------------
    def payload(self) -> dict:
        p = {
            "runner_id": self.runner_id,
            "app": self.app,
            "runner_url": self.runner_url,
            "status": "ready",
            "mode": self.mode,
            "capacity": self.capacity(),
            "price_info": {
                "price": float(self.price),
                "currency": self.price_currency,
                "unit": self.price_unit,
            },
        }
        if self.proxy:
            p["proxy"] = True
        if self.metadata:
            p["metadata"] = self.metadata
        if self.version:
            p["version"] = self.version
        if self.gpu_id:
            p["gpu"] = {
                "id": self.gpu_id,
                "name": self.gpu_name,
                "vram_mb": self.gpu_vram_mb,
            }
        return p

    def health_target(self) -> str:
        """THIS container's health endpoint (never another container's)."""
        if self.health_url.startswith("http://") or self.health_url.startswith("https://"):
            return self.health_url
        return self.runner_url.rstrip("/") + "/" + self.health_url.lstrip("/")


class Registrar:
    def __init__(self, cfg: RunnerConfig):
        self.cfg = cfg
        self.ssl_ctx = ssl._create_unverified_context()
        self.heartbeat_secret = ""
        self.registered = False

    # --- transport ------------------------------------------------------
    def _request(self, method: str, path: str, auth: str, body: Optional[dict] = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.cfg.orch_url + path,
            data=data,
            method=method,
            headers={"Authorization": auth, "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=5, context=self.ssl_ctx) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else {})
        except urllib.error.HTTPError as err:
            raw = err.read()
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"error": raw.decode(errors="replace").strip()}
            return err.code, parsed
        except Exception as err:  # noqa: BLE001 - connection/TLS/timeout
            return 0, {"error": str(err)}

    def healthy(self) -> bool:
        req = urllib.request.Request(self.cfg.health_target(), method="GET")
        try:
            with urllib.request.urlopen(req, timeout=3, context=self.ssl_ctx) as resp:
                return resp.status == self.cfg.healthy_status
        except Exception:  # noqa: BLE001
            return False

    # --- protocol -------------------------------------------------------
    def heartbeat(self, payload: dict) -> bool:
        auth = self.heartbeat_secret or self.cfg.orch_secret
        status, body = self._request("POST", "/runners/heartbeat", auth, payload)
        if status in (401, 404) and self.heartbeat_secret:
            # The orchestrator restarted (registrations are in-memory) or the
            # entry expired; re-register with the registration secret.
            self.heartbeat_secret = ""
            status, body = self._request(
                "POST", "/runners/heartbeat", self.cfg.orch_secret, payload
            )
        if status == 200:
            secret = body.get("heartbeat_secret") or ""
            if secret:
                self.heartbeat_secret = secret
            if not self.registered:
                print(
                    f"{self.cfg.prefix} registered runner={self.cfg.runner_id} "
                    f"app={self.cfg.app} capacity={payload['capacity']} "
                    f"url={self.cfg.runner_url}",
                    flush=True,
                )
            self.registered = True
            return True
        print(
            f"{self.cfg.prefix} heartbeat failed runner={self.cfg.runner_id} "
            f"status={status or 'conn-error'} body={json.dumps(body)[:300]}",
            flush=True,
        )
        self.registered = False
        return False

    def unregister(self, reason: str) -> None:
        auth = self.heartbeat_secret or self.cfg.orch_secret
        status, body = self._request(
            "POST", f"/runners/{self.cfg.runner_id}/unregister", auth, None
        )
        print(
            f"{self.cfg.prefix} unregistered runner={self.cfg.runner_id} reason={reason} "
            f"status={status or 'conn-error'}",
            flush=True,
        )
        self.heartbeat_secret = ""
        self.registered = False

    def tick(self) -> None:
        if not self.healthy():
            if self.registered:
                # A per-container registrar owns exactly one registration: an
                # unhealthy container must not keep serving sessions, so drop
                # ONLY its id and let the registry release ONLY its sessions.
                self.unregister("unhealthy")
            return
        self.heartbeat(self.cfg.payload())

    def stop(self) -> None:
        if self.registered:
            self.unregister("shutdown")


def main() -> int:
    cfg = RunnerConfig(os.environ)
    if "--print-payload" in sys.argv:
        print(json.dumps(cfg.payload(), sort_keys=True))
        return 0
    if "--print-capacity" in sys.argv:
        print(cfg.capacity())
        return 0

    for key in ("runner_id", "app", "runner_url"):
        if not getattr(cfg, key):
            sys.stderr.write(f"{cfg.prefix} missing required env for {key}\n")
            return 2
    cfg.capacity()  # fail loudly before the first tick on a bad literal
    if not cfg.orch_secret:
        sys.stderr.write(f"{cfg.prefix} missing ORCH_SECRET (dynamic registration disabled)\n")
        return 2

    registrar = Registrar(cfg)

    def _handle(_sig, _frm):
        registrar.stop()
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle)
    signal.signal(signal.SIGINT, _handle)

    print(
        f"{cfg.prefix} starting runner={cfg.runner_id} orch={cfg.orch_url} "
        f"health={cfg.health_target()} interval={cfg.interval}s",
        flush=True,
    )
    while True:
        try:
            registrar.tick()
        except Exception as err:  # noqa: BLE001 - never die on one bad tick
            print(f"{cfg.prefix} tick error: {err}", flush=True)
        time.sleep(cfg.interval)


if __name__ == "__main__":
    sys.exit(main())
