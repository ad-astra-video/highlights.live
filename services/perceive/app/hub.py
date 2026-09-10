"""In-process trickle broker + FastAPI channel server (plan §3.10 dev stand-in).

go-livepeer's orchestrator is the real trickle broker in staging/prod. For
offline development, round-trip integration tests, and CI, this module stands
in for it: it implements the SAME channel contract as app/trickle.py documents
(open -> subscribe -> publish -> close) over an in-process ASGI app, so the
perceive runner's trickle rail is exercised against a real HTTP broker without
a running orchestrator.

The hub is deliberately broker-shaped: channels are named per session, a
publisher writes (seq, payload) and a subscriber long-polls the live edge for
the next seq greater than the one it already consumed. The FastAPI app exposes
the documented endpoints:

    POST {control}/channels                     -> {video_in, events_out, control}
    POST {control}/channels/close               -> {closed: true}
    POST {channel}/{seq}                        -> publish   (200 {ok: seq})
    GET  {channel}/-1  [X-Livepeer-Last-Seq]    -> subscribe (200 + X-Livepeer-Seq; 204 when nothing new)
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from fastapi import APIRouter, FastAPI, Header, Request, Response

from .trickle import (
    HDR_LAST_SEQ,
    HDR_SESSION_ID,
    HDR_SEQ,
    HDR_TIMESTAMP,
    SUB_LIVE_EDGE,
)

SUBSCRIBE_POLL_S = 0.03  # hub polls for new data; real broker blocks on the socket


class Channel:
    def __init__(self, name: str) -> None:
        self.name = name
        self._latest: Optional[bytes] = None
        self._latest_seq = 0
        self._last_ts = 0.0

    @property
    def latest_seq(self) -> int:
        return self._latest_seq

    @property
    def latest(self) -> Optional[bytes]:
        return self._latest

    def publish(self, seq: int, payload: bytes, ts: float) -> None:
        self._latest = payload
        self._latest_seq = seq
        self._last_ts = ts

    async def subscribe(self, last_seq: int, timeout_s: float = 5.0) -> tuple[Optional[bytes], int, float]:
        """Return (payload, seq, ts) when a payload newer than last_seq lands,
        else (None, last_seq, 0.0) after the timeout."""
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._latest_seq > last_seq:
                return self._latest, self._latest_seq, self._last_ts
            await asyncio.sleep(SUBSCRIBE_POLL_S)
        return None, last_seq, 0.0


class TrickleHub:
    def __init__(self, max_channels: int = 64) -> None:
        self._channels: dict[str, Channel] = {}
        self.max_channels = max_channels
        self.sessions: dict[str, dict] = {}  # session_id -> opened channel names

    def channel(self, name: str) -> Channel:
        c = self._channels.get(name)
        if c is None:
            if len(self._channels) >= self.max_channels:
                # drop the oldest channel to bound growth
                oldest = next(iter(self._channels))
                self._channels.pop(oldest)
            c = Channel(name)
            self._channels[name] = c
        return c

    def endpoint(self, session_id: str, name: str) -> str:
        return f"/hub/{session_id}/{name}"

    def open_session(self, session_id: str) -> dict:
        names = [f"{session_id}/video-in", f"{session_id}/events-out", f"{session_id}/control"]
        self.sessions[session_id] = names
        return {
            "video_in": self.endpoint(session_id, "video-in"),
            "events_out": self.endpoint(session_id, "events-out"),
            "control": self.endpoint(session_id, "control"),
        }

    def close_session(self, session_id: str) -> bool:
        names = self.sessions.pop(session_id, [])
        for n in names:
            self._channels.pop(f"{session_id}/{n.split('/')[-1]}", None)
        return bool(names)


def make_hub_app(secret_token: str = "") -> FastAPI:
    hub = TrickleHub()
    router = APIRouter()

    def _authed(request: Request) -> bool:
        return not secret_token or request.headers.get("Livepeer-Session-Token") == secret_token

    @router.post("/channels")
    async def channels(request: Request):
        if not _authed(request):
            return Response(status_code=401)
        sid = request.headers.get(HDR_SESSION_ID) or "local-dev"
        return hub.open_session(sid)

    @router.post("/channels/close")
    async def channels_close(request: Request):
        if not _authed(request):
            return Response(status_code=401)
        sid = request.headers.get(HDR_SESSION_ID) or "local-dev"
        return {"closed": hub.close_session(sid)}

    @router.post("/hub/{session_id}/{name}/{seq}")
    async def publish(session_id: str, name: str, seq: int, request: Request):
        body = await request.body()
        ts = request.headers.get(HDR_TIMESTAMP)
        hub.channel(f"{session_id}/{name}").publish(seq, body, float(ts) if ts else 0.0)
        return {"ok": seq}

    @router.get("/hub/{session_id}/{name}/-1")
    async def subscribe(
        session_id: str,
        name: str,
        x_livepeer_last_seq: Optional[int] = Header(default=None),
    ):
        last = x_livepeer_last_seq if x_livepeer_last_seq is not None else 0
        payload, seq, ts = await hub.channel(f"{session_id}/{name}").subscribe(last)
        if payload is None:
            return Response(status_code=204)
        resp = Response(content=payload, media_type="application/octet-stream")
        resp.headers[HDR_SEQ] = str(seq)
        if ts:
            resp.headers[HDR_TIMESTAMP] = f"{ts:.3f}"
        return resp

    app = FastAPI(title="highlights-trickle-hub", version="0.1.0")
    app.include_router(router)
    app.state.hub = hub  # exposed for tests / admin
    return app
