"""Livepeer trickle rail for the perceive runner (plan §3.2/§3.5/§3.8).

One trickle rail per persistent perceive session. It opens the orchestrator's
channel set on the session's first proxied request, subscribes to the media
`video-in` channel, feeds every frame through the SAME `session.step()` used by
HTTP `/analyze` (one front door per frame, plan §3.5), and publishes the
resulting observation onto `events-out`. Control messages arriving on the
`control` channel are applied and acked.

The runner is the SUBSCRIBER of `video-in` and the PUBLISHER of `events-out`;
the worker/server is the reverse. This module only knows the Livepeer channel
contract — it never imports app state, so it has no circular-import coupling.

CONTRACT — verified against go-livepeer's live-runner API + trickle protocol:

  OPEN (create session channels; runner-facing callback, auth by token)
    POST {Livepeer-Session-Control}/runner/{route}/session/{sid}/channels
      Livepeer-Session-Token: <token>
      body {"channels":[{"name":"video-in","mime_type":"application/octet-stream"},
                        {"name":"events-out","mime_type":"application/json"},
                        {"name":"control","mime_type":"application/json"}]}
    -> 200 channel descriptors (name -> url)

  PUBLISH (trickle protocol)
    POST {url}/{seq}   body = payload bytes; seq monotonic per channel

  SUBSCRIBE (live edge, then follow)
    GET {url}/-1     -> most recent publish, header `Lp-Trickle-Seq: <seq>`
    GET {url}/{seq}  -> specific segment; long-polls for the next one

A frame's wall-clock timestamp travels in the `Lp-Trickle-Timestamp` header
(seconds from stream start); if absent the caller derives it from the sequence
using the session's sample rate. The orchestrator serves self-signed TLS, so
the client's SSL verification is off by default (override via TRICKLE_VERIFY).

app/hub.py is an in-process broker implementing this SAME contract, used as the
offline dev stand-in (§3.10) and as the unit-test harness over httpx ASGITransport.
"""
from __future__ import annotations

import asyncio
import aiohttp
import base64
import json
import logging
import os
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

import httpx

SUB_LIVE_EDGE = "-1"

HDR_SESSION_ID = "Livepeer-Session-Id"
HDR_SESSION_TOKEN = "Livepeer-Session-Token"
HDR_ROUTE = "Livepeer-Runner-Route"
HDR_SEQ = "Lp-Trickle-Seq"
HDR_TIMESTAMP = "Lp-Trickle-Timestamp"
HDR_LATEST = "Lp-Trickle-Latest"


class TrickleError(RuntimeError):
    pass


def _default_verify() -> bool:
    return os.environ.get("TRICKLE_VERIFY", "0").lower() in ("1", "true", "yes")


@dataclass
class TrickleEndpoints:
    video_in: str
    events_out: str
    control: str = ""


def _extract_endpoints(descriptors) -> TrickleEndpoints:
    """Tolerate the several descriptor shapes go-livepeer could return:
    a list of {name,url,...}, a map name->url, or a nested {"channels": [...]}."""
    if isinstance(descriptors, dict):
        inner = descriptors.get("channels", descriptors)
    else:
        inner = descriptors
    name_to_url: dict[str, str] = {}
    if isinstance(inner, dict):
        for k, v in inner.items():
            if isinstance(v, dict):
                url = v.get("url") or v.get("publish_url") or v.get("subscribe_url")
                name_to_url[k] = url if url else str(v.get("name") or k)
            else:
                name_to_url[k] = str(v)
    elif isinstance(inner, list):
        for d in inner:
            if isinstance(d, dict) and d.get("name"):
                url = d.get("url") or d.get("publish_url") or d.get("subscribe_url")
                name_to_url[d["name"]] = url if url else d["name"]
    video_in = name_to_url.get("video-in") or name_to_url.get("video_in")
    events_out = name_to_url.get("events-out") or name_to_url.get("events_out")
    control = name_to_url.get("control", "")
    missing = [n for n, v in (("video-in", video_in), ("events-out", events_out)) if not v]
    if missing:
        raise TrickleError(f"channel descriptors missing {missing}: {descriptors}")
    return TrickleEndpoints(video_in=video_in, events_out=events_out, control=control or "")


class TrickleRail:
    """A bidirectional client for one session's trickle channels.

    The HTTP transport is injectable (httpx.AsyncClient works both against the
    real go-livepeer broker over the network and against app/hub.py in-process
    via ASGITransport), so the same code path is unit-tested without a running
    orchestrator (verification here happened against the live .6 orchestrator).
    """

    def __init__(
        self,
        *,
        control_url: str,
        session_id: str = "",
        route: str = "",
        token: str = "",
        verify: Optional[bool] = None,
        client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self.control_url = control_url.rstrip("/")
        self.session_id = session_id
        self.route = route
        self.token = token
        self.endpoints: Optional[TrickleEndpoints] = None
        self._client = client
        self._own_client = client is None
        self._verify = _default_verify() if verify is None else verify
        self._aio_session: Optional[aiohttp.ClientSession] = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=30.0, verify=self._verify)
        return self._client

    def _headers(self, extra: Optional[dict[str, str]] = None) -> dict[str, str]:
        h = {HDR_SESSION_ID: self.session_id}
        if self.token:
            h[HDR_SESSION_TOKEN] = self.token
        if self.route:
            h[HDR_ROUTE] = self.route
        if extra:
            h.update(extra)
        return h

    async def aclose(self) -> None:
        if self._own_client:
            await self.client.aclose()
        if self._aio_session is not None:
            await self._aio_session.close()

    def _channels_url(self) -> str:
        # The injected Livepeer-Session-Control header ALREADY includes the
        # runner/session base (…/runner/{route}/session/{sid}), so the create-
        # channels callback is just {control}/channels. (Verified against the
        # go-livepeer orchestrator on .6 — the old path resulted in a doubled
        # …/runner/{route}/session/{sid}/runner/{route}/session/{sid}/channels.)
        return f"{self.control_url}/channels"

    async def open(self) -> TrickleEndpoints:
        """Create the session's trickle channels on the orchestrator (auth by
        Livepeer-Session-Token) and parse the returned descriptor URLs."""
        body = {
            "channels": [
                {"name": "video-in", "mime_type": "application/octet-stream"},
                {"name": "events-out", "mime_type": "application/json"},
                {"name": "control", "mime_type": "application/json"},
            ]
        }
        url = self._channels_url()
        r = await self.client.post(url, json=body, headers=self._headers())
        if r.status_code != 200:
            raise TrickleError(
                f"channel open failed: HTTP {r.status_code} url={url} route={self.route!r} token={bool(self.token)}: {r.text[:300]}"
            )
        try:
            payload = r.json()
        except Exception:  # noqa: BLE001
            raise TrickleError(f"channel open bad json: {r.text[:300]}")
        self.endpoints = _extract_endpoints(payload)
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
        self, channel_url: str, seq: int, poll_timeout: float = 8.0
    ) -> tuple[Optional[int], Optional[bytes], Optional[float]]:
        """Subscribe to ONE trickle segment at `seq` (positive seq to follow,
        skipping the -1 live edge which only delivers on the NEXT publish).
        Returns (actual_seq, payload, timestamp), or (None, None, None) when
        the broker has no data at that index yet.

        go-livepeer holds a subscribe request OPEN when the segment doesn't
        exist yet (it never sends 404/470 promptly), so each attempt is bounded
        by a transport READ timeout — an empty channel yields None and the caller
        re-polls, picking up the segment once it's published.

        Transport: production uses aiohttp (pytrickle's client — httpx's pooled
        stream is unreliable across repeated long-polls against go-livepeer, it
        was verified live on .6). When an httpx client is injected (unit tests
        over the in-process ASGI hub, which aiohttp can't reach), fall back to
        httpx streaming so the same loop logic is exercised."""
        if self._client is None:
            return await self._subscribe_aiohttp(channel_url, seq, poll_timeout)
        return await self._subscribe_httpx(channel_url, seq, poll_timeout)

    async def _subscribe_httpx(
        self, channel_url: str, seq: int, poll_timeout: float
    ) -> tuple[Optional[int], Optional[bytes], Optional[float]]:
        url = f"{channel_url.rstrip('/')}/{seq}"
        headers = self._headers({"Connection": "close"})
        try:
            async with self.client.stream(
                "GET", url, headers=headers, timeout=httpx.Timeout(poll_timeout)
            ) as r:
                if r.status_code in (404, 470, 204, 304):
                    return None, None, None
                seq_h = r.headers.get(HDR_SEQ)
                actual = int(seq_h) if seq_h and seq_h.isdigit() else seq
                ts_h = r.headers.get(HDR_TIMESTAMP)
                timestamp = float(ts_h) if ts_h else None
                body = b""
                async for chunk in r.aiter_bytes():
                    body += chunk
                return actual, body, timestamp
        except (httpx.ReadError, httpx.ReadTimeout, httpx.ConnectError, httpx.StreamError):
            return None, None, None

    def _aio(self) -> aiohttp.ClientSession:
        if self._aio_session is None:
            self._aio_session = aiohttp.ClientSession(
                connector=aiohttp.TCPConnector(ssl=False)
            )
        return self._aio_session

    async def _subscribe_aiohttp(
        self, channel_url: str, seq: int, poll_timeout: float
    ) -> tuple[Optional[int], Optional[bytes], Optional[float]]:
        url = f"{channel_url.rstrip('/')}/{seq}"
        headers = self._headers({"Connection": "close"})
        timeout = aiohttp.ClientTimeout(total=poll_timeout, sock_read=poll_timeout)
        try:
            async with self._aio().get(url, headers=headers, timeout=timeout) as r:
                if r.status in (404, 470, 204, 304):
                    return None, None, None
                seq_h = r.headers.get(HDR_SEQ)
                actual = int(seq_h) if seq_h and seq_h.isdigit() else seq
                ts_h = r.headers.get(HDR_TIMESTAMP)
                timestamp = float(ts_h) if ts_h else None
                body = await r.content.read()
                return actual, body, timestamp
        except (asyncio.TimeoutError, aiohttp.ClientError):
            # empty channel (no segment at that index yet) — the caller re-polls
            return None, None, None


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
        # Frames are published at seq 1,2,...; go-livepeer's -1 live edge only
        # delivers on the NEXT publish (it never returns existing data), so we
        # follow specific seqs in order: GET /{seq} returns 200 once that frame
        # is published (else 404/470 -> re-poll).
        want = 1
        while not self._closed:
            out = await self.rail.subscribe_next(self.rail.endpoints.video_in, want)
            # go-livepeer answers a live-edge subscribe with 200 + an EMPTY
            # streaming body (fast-forward to live); only a non-empty body is a
            # real segment. Advancing on the empty one skips frames.
            if not out[1]:
                await asyncio.sleep(0.05)
                continue
            seq, payload, ts = out
            want = seq + 1
            image_b64 = base64.b64encode(payload).decode()
            timestamp = ts if ts is not None else 0.0
            try:
                obs = await self._on_frame(seq, image_b64, timestamp)
            except Exception as e:  # noqa: BLE001
                # one bad frame must not kill the live rail (plan risk §9)
                logging.getLogger("hl.trickle").warning("on_frame seq=%s failed: %r", seq, e)
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
        want = 1
        while not self._closed:
            seq, payload, _ts = await self.rail.subscribe_next(self.rail.endpoints.control, want)
            if not payload:
                await asyncio.sleep(0.05)
                continue
            want = seq + 1
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
