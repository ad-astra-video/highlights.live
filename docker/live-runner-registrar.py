#!/usr/bin/env python3
"""Register a highlights.live runner with the go-livepeer orchestrator DYNAMICALLY.

ADAAAA-8281 follow-up (CEO comment 1fa36041): "all the runners need to go to
registering dynamically and drop the runners.json".

go-livepeer v0.9.2 already supports dynamic live-runner registration; the static
`-liveRunnerConfig` file is only one of two ways to populate the registry
(`ai/runner/live_runner.go`):

    POST <orch>/runners/heartbeat          authorization: <orchSecret>   (first registration)
    POST <orch>/runners/heartbeat          authorization: <heartbeatSecret>  (subsequent, TTL 20 s)
    POST <orch>/runners/<runner_id>/unregister  authorization: <heartbeatSecret>

A dynamic runner is therefore not described by a JSON file we maintain by hand:
the runner (this sidecar) describes ITSELF on every heartbeat. Two consequences
that matter for this box:

1. `capacity` is live. `RUNNER_CAPACITY=auto` derives it from the router's own
   upstream pool (`docker/decide-router.conf`), so the number the signer
   advertises IS the routed set — the pool membership is the single declared
   source AC2 asked for. Re-routing the pool and restarting this sidecar changes
   the advertised capacity with no orchestrator restart and no session drop.
2. `status` is reported, not probed. The registry probes only STATIC runners
   (`checkStaticRunnerHealth`); a dynamic runner's readiness is whatever the
   heartbeat says, and its entry expires after `heartbeat_ttl` (20 s) with no
   heartbeat. This sidecar therefore (a) heartbeats every interval, (b) reports
   `ready` only while the runner's own health endpoint answers, and (c)
   unregisters on an unhealthy runner so the registry releases its sessions in
   the same way a failed static health probe used to.

Modes (used by the test suite, so the config assertions run the real parser):
    python3 live-runner-registrar.py --print-payload    # one payload JSON, no network
    python3 live-runner-registrar.py --print-capacity   # resolved capacity integer
    python3 live-runner-registrar.py                    # daemon (container command)

Environment (all required unless noted):
    ORCH_URL              https://orchestrator:8935       go-livepeer rpc base URL
    ORCH_SECRET           orchestrator secret for first registration
    RUNNER_ID             e.g. highlights-decide         MUST match what the
                                                         server calls (`ROUTES`)
    RUNNER_APP            e.g. highlights-live/decide
    RUNNER_URL            http://decide-router:8081
    RUNNER_HEALTH_URL     /nginx-health  (relative joins onto RUNNER_URL)
    RUNNER_MODE           persistent | single-shot       (default persistent)
    RUNNER_PROXY         1|0                             (default 0)
    RUNNER_CAPACITY       integer | auto                 (default auto when
                                                         RUNNER_AUTO_CONF set)
    RUNNER_AUTO_CONF      nginx conf carrying the pool   (only for auto)
    RUNNER_AUTO_SEQS      concurrency per worker, default 2
    RUNNER_METADATA       JSON string, optional
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
import re
import signal
import ssl
import sys
import time
import urllib.error
import urllib.request
from typing import Mapping, Optional

SERVER_LINE = re.compile(r"^\s*server\s+(\S+)")


class RunnerCapacityUnavailable(RuntimeError):
    """The routed-set capacity could not be read completely this tick.

    Raised instead of publishing a short number: `decide-router.conf` is
    rewritten (git reset / deploy) while the registrar is running, and a read
    that lands mid-write sees a truncated pool block. Publishing that count
    would cap a session's decide admission below the routed set.
    """


UPSTREAM_START = re.compile(r"^\s*upstream\s+([A-Za-z0-9_]+)\s*\{")


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
        self.capacity_raw = env.get("RUNNER_CAPACITY", "auto")
        self.auto_conf = env.get("RUNNER_AUTO_CONF", "")
        self.auto_seqs = int(env.get("RUNNER_AUTO_SEQS", "2") or 2)
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
    @staticmethod
    def pool_capacity(conf_text: str, seqs: int, upstream: str = "decide_pool") -> Optional[int]:
        """Primary upstream count x per-worker concurrency, or None when the
        pool block could not be read completely.

        The PRIMARY servers are the balancing set; `backup` servers are failover
        only and must not be counted, otherwise a failover-only x99 pair would
        inflate the advertised ceiling the admission gate reads.

        A deploy rewrites `decide-router.conf`, and a read that lands mid-write
        sees a TRUNCATED file: `upstream` opened, two of three `server` lines
        present, no closing brace. Counting that file publishes `2 x seqs = 4`
        and the server latches it for the whole session (measured 2026-11-07
        15:46-16:00Z on the box: advertised flapped 6 -> 4 -> 6 across two
        deploy rewrites, capping one session at 4). Returning None makes the
        caller hold the last known capacity instead of publishing a short
        number; a conf that lacks the block entirely is equally unusable.
        """
        inside = False
        seen_block = False
        closed = False
        primaries = 0
        for line in conf_text.splitlines():
            start = UPSTREAM_START.match(line)
            if start:
                inside = start.group(1) == upstream
                seen_block = seen_block or inside
                continue
            if inside and line.strip() == "}":
                inside = False
                closed = True
                continue
            if not inside:
                continue
            m = SERVER_LINE.match(line)
            if not m:
                continue
            if re.search(r"\bbackup\b", line):
                continue
            primaries += 1
        if not seen_block or not closed:
            return None
        return max(1, primaries * seqs)

    def capacity(self) -> int:
        if self.capacity_raw != "auto":
            return int(self.capacity_raw)
        if not self.auto_conf:
            raise SystemExit(f"{self.prefix} RUNNER_CAPACITY=auto needs RUNNER_AUTO_CONF")
        try:
            with open(self.auto_conf, "r", encoding="utf-8") as fh:
                derived = self.pool_capacity(fh.read(), self.auto_seqs)
        except OSError as err:
            raise RunnerCapacityUnavailable(
                f"{self.prefix} cannot read {self.auto_conf}: {err}"
            ) from err
        if derived is None:
            raise RunnerCapacityUnavailable(
                f"{self.prefix} capacity read incomplete: no closed `decide_pool` "
                f"block in {self.auto_conf} (a deploy was rewriting it)"
            )
        return derived

    # --- payload --------------------------------------------------------
    def payload(self, capacity: Optional[int] = None) -> dict:
        p = {
            "runner_id": self.runner_id,
            "app": self.app,
            "runner_url": self.runner_url,
            "status": "ready",
            "mode": self.mode,
            "capacity": self.capacity() if capacity is None else capacity,
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
        if self.health_url.startswith("http://") or self.health_url.startswith("https://"):
            return self.health_url
        return self.runner_url.rstrip("/") + "/" + self.health_url.lstrip("/")


class Registrar:
    def __init__(self, cfg: RunnerConfig):
        self.cfg = cfg
        self.ssl_ctx = ssl._create_unverified_context()
        self.heartbeat_secret = ""
        self.registered = False
        self.last_capacity = None
        # True while a partial conf read is served with the last known capacity
        # (so the hold/recover lines print once per episode).
        self.holding_capacity = False

    # --- transport ------------------------------------------------------
    def _request(self, method: str, path: str, auth: str, body: dict | None = None):
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
            elif payload["capacity"] != self.last_capacity:
                print(
                    f"{self.cfg.prefix} capacity changed runner={self.cfg.runner_id} "
                    f"{self.last_capacity} -> {payload['capacity']}",
                    flush=True,
                )
            self.registered = True
            self.last_capacity = payload["capacity"]
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
        self.last_capacity = None

    def tick(self) -> None:
        if not self.healthy():
            if self.registered:
                # Mirror the static-path behaviour: an unhealthy runner must not
                # keep serving sessions, so drop the registration and let the
                # registry release them.
                self.unregister("unhealthy")
            return
        try:
            payload = self.cfg.payload()
        except RunnerCapacityUnavailable as err:
            # Hold the last number we published rather than shrinking the
            # advertised ceiling on a transient partial read. The heartbeat
            # MUST still go out: the registry expires a dynamic runner after
            # 20 s without one, which would release its sessions.
            if self.last_capacity is None:
                print(f"{self.cfg.prefix} capacity unavailable, heartbeat deferred: {err}", flush=True)
                return
            if not self.holding_capacity:
                print(
                    f"{self.cfg.prefix} capacity unavailable, holding "
                    f"{self.last_capacity}: {err}",
                    flush=True,
                )
                self.holding_capacity = True
            payload = self.cfg.payload(capacity=self.last_capacity)
        else:
            if self.holding_capacity:
                print(
                    f"{self.cfg.prefix} capacity readable again: {payload['capacity']}",
                    flush=True,
                )
                self.holding_capacity = False
        self.heartbeat(payload)

    def stop(self) -> None:
        if self.registered:
            self.unregister("shutdown")


def main() -> int:
    cfg = RunnerConfig(os.environ)
    if "--print-payload" in sys.argv:
        print(json.dumps(cfg.payload(), sort_keys=True))
        return 0
    if "--print-capacity" in sys.argv:
        try:
            print(cfg.capacity())
        except RunnerCapacityUnavailable as err:
            sys.stderr.write(f"{err}\n")
            return 3
        return 0

    for key in ("runner_id", "app", "runner_url"):
        if not getattr(cfg, key):
            sys.stderr.write(f"{cfg.prefix} missing required env for {key}\n")
            return 2
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
