"""In-process trickle broker + FastAPI channel server (plan §3.10 dev stand-in),
implementing the SAME contract as the go-livepeer live-runner orchestrator the
rail is verified against on .6.

Endpoints (mirror go-livepeer live-runner callbacks + trickle protocol):

    POST   /runner/{route}/session/{sid}/channels       body {"channels":[{name,mime_type},...]}
                                                          -> {"channels":[{name,url,mime_type},...]}  (descriptors, idempotent)
    DELETE /runner/{route}/session/{sid}/channels       body {"channels":[name,...]} -> {"channels":[name,...]}
    POST   {channel_url}/{seq}                          publish (body = payload bytes)
    GET    {channel_url}/-1                             subscribe live edge -> Lp-Trickle-Seq header; 404 if none
    GET    {channel_url}/{seq}                          subscribe specific segment (long-poll for next)

The publisher writes (seq, payload, ts); a subscriber long-polls for the next
seq greater than the one it already consumed. Runs over httpx ASGITransport in
tests (real HTTP semantics, no sockets) — the offchain dev stand-in per §3.10.
"""
from __future__ import annotations

import asyncio
import time
from typing import Optional

from fastapi import APIRouter, FastAPI, Header, Request, Response

from .trickle import HDR_SEQ, HDR_TIMESTAMP, SUB_LIVE_EDGE

SUBSCRIBE_POLL_S = 0.03  # hub polls for new data; real broker blocks on the socket


class Channel:
    def __init__(self, name: str) -> None:
        self.name = name
        self._latest: Optional[bytes] = None
        self._latest_seq = 0
        self._last_ts = 0.0

    def publish(self, seq: int, payload: bytes, ts: float) -> None:
        self._latest = payload
        self._latest_seq = seq
        self._last_ts = ts

    async def subscribe_at(self, seq_target: int, timeout_s: float = 5.0) -> tuple[Optional[bytes], int, float]:
        """-1 = live edge (latest if any, else none). Positive seq = wait until
        a publish with seq >= seq_target lands (the rail follows seq+1)."""
        if seq_target == -1:
            if self._latest is None or self._latest_seq == 0:
                return None, 0, 0.0
            return self._latest, self._latest_seq, self._last_ts
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            if self._latest_seq >= seq_target:
                return self._latest, self._latest_seq, self._last_ts
            await asyncio.sleep(SUBSCRIBE_POLL_S)
        return None, seq_target, 0.0


class TrickleHub:
    def __init__(self, max_channels: int = 64) -> None:
        self._channels: dict[str, Channel] = {}
        self.max_channels = max_channels
        self.sessions: dict[str, dict] = {}  # route/sid -> {name: url}

    def channel(self, name: str) -> Channel:
        c = self._channels.get(name)
        if c is None:
            if len(self._channels) >= self.max_channels:
                self._channels.pop(next(iter(self._channels)))
            c = Channel(name)
            self._channels[name] = c
        return c

    def endpoint(self, sid: str, name: str) -> str:
        return f"/hub/{sid}/{name}"

    def open_session(self, sid: str, names: list[str]) -> dict:
        urls = {n: self.endpoint(sid, n) for n in names}
        self.sessions[sid] = urls
        return {"channels": [{"name": n, "url": u, "mime_type": "application/octet-stream"} for n, u in urls.items()]}

    def close_session(self, route: str, sid: str) -> bool:
        urls = self.sessions.pop(sid, {})
        for u in urls.values():
            self._channels.pop(u.rstrip("/").split("/")[-1], None)
        return bool(urls)


def make_hub_app(secret_token: str = "") -> FastAPI:
    hub = TrickleHub()
    router = APIRouter()

    def _authed(request: Request) -> bool:
        return not secret_token or request.headers.get("Livepeer-Session-Token") == secret_token

    @router.post("/runner/{route}/session/{sid}/channels")
    async def channels_create(route: str, sid: str, request: Request):
        if not _authed(request):
            return Response(status_code=401)
        body = await request.json()
        names = [c.get("name") for c in body.get("channels", []) if c.get("name")]
        return hub.open_session(sid, names)

    @router.delete("/runner/{route}/session/{sid}/channels")
    async def channels_delete(route: str, sid: str, request: Request):
        if not _authed(request):
            return Response(status_code=401)
        body = await request.json()
        names = body.get("channels", [])
        urls = hub.sessions.pop(sid, {})
        for n in names:
            hub._channels.pop(urls.get(n, "").rstrip("/").split("/")[-1], None) if n in urls else None
        return {"channels": names}

    @router.post("/hub/{sid}/{name}/{seq}")
    async def publish(sid: str, name: str, seq: int, request: Request):
        body = await request.body()
        ts = request.headers.get(HDR_TIMESTAMP)
        hub.channel(f"{sid}/{name}").publish(seq, body, float(ts) if ts else 0.0)
        return {"ok": seq}

    @router.get("/hub/{sid}/{name}/{seq}")
    async def subscribe_seq(sid: str, name: str, seq: int):
        payload, seq2, ts = await hub.channel(f"{sid}/{name}").subscribe_at(seq)
        if payload is None:
            return Response(status_code=404)
        resp = Response(content=payload, media_type="application/octet-stream")
        resp.headers[HDR_SEQ] = str(seq2)
        if ts:
            resp.headers[HDR_TIMESTAMP] = f"{ts:.3f}"
        return resp

    app = FastAPI(title="highlights-trickle-hub", version="0.1.0")
    app.include_router(router)
    app.state.hub = hub  # exposed for tests / admin
    return app
