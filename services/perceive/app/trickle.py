"""Livepeer trickle rail for the perceive runner (plan §3.2/§3.5/§3.8).

One trickle rail per persistent perceive session. It opens the orchestrator's
channel set on the session's first proxied request, subscribes to the media
`video-in` channel, feeds every frame through the SAME `session.step()` used by
HTTP `/analyze` (one front door per frame, plan §3.5), and publishes the
resulting observation onto `events-out`. Control messages arriving on the
`control` channel are applied and acked.

The runner is the SUBSCRIBER of `video-in` and the PUBLISHER of `events-out`;
the worker/server is the reverse. This module only knows the channel contract —
it never imports app state, so it has no circular-import coupling and is fully
unit-testable against a broker (see app/hub.py, an in-process stand-in).

Channel contract (documented; the go-livepeer trickle broker is the real
backend, app/hub.py is the dev/offline stand-in per plan §3.10):

    OPEN    POST {control_url}/channels
                Livepeer-Session-Id / Livepeer-Session-Token headers
            -> 200 { "video_in": U, "events_out": U, "control": U }
    PUBLISH POST {U}/{seq}
                body = payload bytes (video-in: JPEG; events-out/control: JSON)
                X-Livepeer-Timestamp: <float seconds from stream start>
    SUB     GET  {U}/-1                     (long-poll live edge)
                X-Livepeer-Last-Seq: <last consumed>   (0 to start live)
            -> 200 body = payload, header X-Livepeer-Seq: <seq>
            -> 204/304 = nothing new yet (poll again)
    CLOSE   POST {control_url}/channels/close   (best-effort)

A frame carries its sequence in the URL and its wall-clock timestamp in the
`X-Livepeer-Timestamp` header (seconds from stream start); if absent the caller
derives it from the sequence using the session's sample rate.
"""
from __future__ import annotations

import asyncio
import base64
import json
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

import httpx

CHANNELS_OPEN = "/channels"
CHANNELS_CLOSE = "/channels/close"
SUB_LIVE_EDGE = "-1"

HDR_SESSION_ID = "Livepeer-Session-Id"
HDR_SESSION_TOKEN = "Livepeer-Session-Token"
HDR_SEQ = "X-Livepeer-Seq"
HDR_LAST_SEQ = "X-Livepeer-Last-Seq"
HDR_TIMESTAMP = "X-Livepeer-Timestamp"


class TrickleError(RuntimeError):
    pass


@dataclass
class TrickleEndpoints:
    video_in: str
    events_out: str
    control: str = ""


class TrickleRail:
    """A bidirectional client for one session's trickle channels.

    The HTTP transport is injectable (httpx.AsyncClient works both against the
    real go-livepeer broker over the network and against app/hub.py in-process
    via ASGITransport), so the same code path is unit-tested without a running
    orchestrator.
    """

    def __init__(
        self,
        *,
        control_url: str,
        session_id: str = "",
        token: str = "",
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.control_url = control_url.rstrip("/")
        self.session_id = session_id
        self.token = token
        self.endpoints: Optional[TrickleEndpoints] = None
        self._client = client
        self._own_client = client is None
        self._last_in_seq = 0

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0)
        return self._client

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        h = {HDR_SESSION_ID: self.session_id}
        if self.token:
            h[HDR_SESSION_TOKEN] = self.token
        if extra:
            h.update(extra)
        return h

    async def aclose(self) -> None:
        if self._own_client:
            await self.client.aclose()

    async def open(self) -> TrickleEndpoints:
        r = await self.client.post(
            f"{self.control_url}{CHANNELS_OPEN}", headers=self._headers()
        )
        if r.status_code != 200:
            raise TrickleError(
                f"channel open failed: HTTP {r.status_code}: {r.text[:200]}"
            )
        body = r.json()
        vi = body.get("video_in") or body.get("video-in")
        eo = body.get("events_out") or body.get("events-out")
        co = body.get("control") or ""
        if not vi or not eo:
            raise TrickleError(f"channel open missing video_in/events_out: {body}")
        self.endpoints = TrickleEndpoints(video_in=vi, events_out=eo, control=co)
        return self.endpoints

    async def publish(
        self,
        channel_url: str,
        seq: int,
        payload: bytes,
        *,
        content_type: str = "application/octet-stream",
        timestamp: Optional[float] = None,
    ) -> int:
        extra = {"Content-Type": content_type}
        if timestamp is not None:
            extra[HDR_TIMESTAMP] = f"{timestamp:.3f}"
        r = await self.client.post(
            f"{channel_url.rstrip('/')}/{seq}", content=payload, headers=self._headers(extra)
        )
        return r.status_code

    async def subscribe_next(
        self, channel_url: str, last_seq: int
    ) -> tuple[int, Optional[bytes], Optional[float]]:
        """Long-poll the live edge; returns (seq, payload, timestamp) or
        (last_seq, None, None) when nothing is newer (204/304) before the
        transport's timeout."""
        r = await self.client.get(
            f"{channel_url.rstrip('/')}/{SUB_LIVE_EDGE}",
            headers=self._headers({HDR_LAST_SEQ: str(last_seq)}),
        )
        if r.status_code in (204, 304):
            return last_seq, None, None
        seq_h = r.headers.get(HDR_SEQ)
        seq = int(seq_h) if seq_h else last_seq + 1
        ts = r.headers.get(HDR_TIMESTAMP)
        timestamp = float(ts) if ts else None
        return seq, r.content, timestamp


# on_frame(seq, image_b64, timestamp) -> observation dict (JSON-serializable);
# the rail publishes that observation onto events-out automatically.
OnFrame = Callable[[int, str, float], Awaitable[dict]]


class TrickleSession:
    """High-level driver tying a rail to a session's step function.

    Owns TWO background tasks sharing one rail: a media task that consumes
    video-in frames -> on_frame() -> publish events-out, and a control task
    that consumes control-channel messages -> on_control() -> ack on control.
    """

    def __init__(
        self,
        rail: TrickleRail,
        on_frame: OnFrame,
        on_control: Callable[[dict], dict],
    ) -> None:
        self.rail = rail
        self._on_frame = on_frame
        self._on_control = on_control
        self._tasks: list[asyncio.Task] = []
        self._closed = False

    def _on_task_done(self, task: asyncio.Task) -> None:
        if task.cancelled() or self._closed:
            return
        exc = task.exception()
        if exc is not None:
            asyncio.get_running_loop().call_exception_handler(
                {"message": "trickle task failed", "exception": exc, "task": task}
            )

    async def start(self) -> None:
        await self.rail.open()
        self._tasks = [asyncio.create_task(self._media_loop())]
        if self.rail.endpoints and self.rail.endpoints.control:
            self._tasks.append(asyncio.create_task(self._control_loop()))
        for t in self._tasks:
            t.add_done_callback(self._on_task_done)

    async def _media_loop(self) -> None:
        last = 0
        while not self._closed:
            seq, payload, ts = await self.rail.subscribe_next(
                self.rail.endpoints.video_in, last
            )
            if payload is None:
                continue
            last = seq
            image_b64 = base64.b64encode(payload).decode()
            timestamp = ts if ts is not None else 0.0
            try:
                obs = await self._on_frame(seq, image_b64, timestamp)
            except Exception:
                # one bad frame must not kill the live rail (plan risk §9)
                continue
            if obs:
                await self.rail.publish(
                    self.rail.endpoints.events_out,
                    seq,
                    json.dumps(obs).encode(),
                    content_type="application/json",
                    timestamp=timestamp,
                )

    async def _control_loop(self) -> None:
        last = 0
        while not self._closed:
            seq, payload, _ts = await self.rail.subscribe_next(
                self.rail.endpoints.control, last
            )
            if payload is None:
                continue
            last = seq
            try:
                msg = json.loads(payload.decode())
            except Exception:
                continue
            ack = self._on_control(msg)
            if ack and self.rail.endpoints.control:
                await self.rail.publish(
                    self.rail.endpoints.control,
                    seq,
                    json.dumps(ack).encode(),
                    content_type="application/json",
                )

    async def close(self) -> None:
        self._closed = True
        for t in self._tasks:
            t.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        await self.rail.aclose()
