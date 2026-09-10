"""Trickle rail integration tests.

Run the runner-side rail against the in-process broker (app/hub.py) over
httpx ASGITransport — real HTTP semantics, no sockets, no orchestrator. The hub
implements the SAME channel contract as the go-livepeer live-runner orchestrator
the rail is verified against on .6 (POST /runner/{route}/session/{sid}/channels
to create channels, Lp-Trickle-Seq live-edge subscribe), so these tests exercise
the exact wire API.

In production the SAME rail talks to the go-livepeer broker over the network;
only the transport differs (httpx.AsyncClient vs the ASGI one used here).
"""
import asyncio
import json

import httpx
import pytest

from app.hub import make_hub_app
from app.trickle import TrickleError, TrickleRail, TrickleSession

BASE = "http://hub"
ROUTE = "highlights-perceive"


def _clients(hub_app, token="t"):
    transport = httpx.ASGITransport(app=hub_app)
    hub_client = httpx.AsyncClient(transport=transport, base_url=BASE, timeout=10.0)
    rail_client = httpx.AsyncClient(transport=transport, base_url=BASE, timeout=10.0)
    return hub_client, rail_client


def _rail(rail_client, session_id="s1", token="t", route=ROUTE):
    # In production the injected Livepeer-Session-Control ALREADY includes the
    # runner/session base, so the channels callback is {control}/channels —
    # mirror that here so the rail exercises the exact real URL shape.
    control_url = f"{BASE}/runner/{route}/session/{session_id}"
    return TrickleRail(
        control_url=control_url,
        session_id=session_id,
        token=token,
        route=route,
        client=rail_client,
    )


class _Recorder:
    """Records what the session step was asked to process (and lets the test
    assert the front-door invariant: one session.step() per trickle frame)."""

    def __init__(self):
        self.frames = []  # (seq, image_b64, timestamp)
        self.controls = []

    async def on_frame(self, seq, image_b64, timestamp):
        self.frames.append((seq, image_b64, timestamp))
        return {
            "type": "observation",
            "sessionId": "s1",
            "seq": seq,
            "timestamp": timestamp,
            "tracks": [],
            "objects": [],
            "ocr": [],
        }

    def on_control(self, msg):
        self.controls.append(msg)
        return {"type": "ack", "ok": True, "cmd": msg.get("type")}


JPEG = b"\xff\xd8\xff\xe0fake-jpeg-bytes"


async def _wait_for(pred, timeout=2.0):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if pred():
            return
        await asyncio.sleep(0.02)
    raise AssertionError("condition not met in time")


def test_open_creates_channels_via_runner_callback():
    async def main():
        hub_app = make_hub_app(secret_token="t")
        _, rail_client = _clients(hub_app)
        rail = _rail(rail_client)
        ep = await rail.open()
        assert ep.video_in.endswith("/video-in")
        assert ep.events_out.endswith("/events-out")
        assert ep.control.endswith("/control")
        # The hub (like go-livepeer) records the created channels under the sid.
        assert "s1" in hub_app.state.hub.sessions
        await rail_client.aclose()

    asyncio.run(main())


def test_wrong_token_raises_on_open():
    async def main():
        hub_app = make_hub_app(secret_token="t")
        _, rail_client = _clients(hub_app)
        rail = _rail(rail_client, token="whoops")
        with pytest.raises(TrickleError):
            await rail.open()
        await rail_client.aclose()

    asyncio.run(main())


def test_frame_flows_video_in_to_events_out():
    async def main():
        hub_app = make_hub_app(secret_token="t")
        hub_client, rail_client = _clients(hub_app)
        rec = _Recorder()
        sess = TrickleSession(_rail(rail_client), on_frame=rec.on_frame, on_control=rec.on_control)
        await sess.start()
        ep = sess.rail.endpoints

        # Worker publishes a frame on video-in (seq 1, ts 12.5).
        await hub_client.post(
            f"{ep.video_in}/1",
            content=JPEG,
            headers={"Lp-Trickle-Timestamp": "12.500"},
        )
        await _wait_for(lambda: len(rec.frames) == 1)
        assert rec.frames[0][0] == 1
        assert rec.frames[0][2] == 12.5  # timestamp flowed through

        # The runner published the observation onto events-out (live edge).
        ev = await hub_client.get(f"{ep.events_out}/-1")
        assert ev.status_code == 200
        assert int(ev.headers["Lp-Trickle-Seq"]) == 1
        obs = json.loads(ev.content)
        assert obs["type"] == "observation"
        assert obs["seq"] == 1

        # A second frame advances the live edge (monotonic, no dup replay).
        await hub_client.post(f"{ep.video_in}/2", content=JPEG + b"\x02")
        await _wait_for(lambda: len(rec.frames) == 2)
        ev2 = await hub_client.get(f"{ep.events_out}/-1")
        assert ev2.status_code == 200
        assert int(ev2.headers["Lp-Trickle-Seq"]) == 2

        await sess.close()
        await hub_client.aclose()

    asyncio.run(main())


def test_control_round_trip_ack():
    async def main():
        hub_app = make_hub_app(secret_token="t")
        hub_client, rail_client = _clients(hub_app)
        rec = _Recorder()
        sess = TrickleSession(_rail(rail_client), on_frame=rec.on_frame, on_control=rec.on_control)
        await sess.start()
        ep = sess.rail.endpoints

        # Worker sends a control message (e.g. configure) on the control channel.
        await hub_client.post(
            f"{ep.control}/1",
            content=json.dumps({"type": "configure", "preferLabels": ["score"]}).encode(),
            headers={"Content-Type": "application/json"},
        )
        await _wait_for(lambda: len(rec.controls) == 1)
        assert rec.controls[0]["type"] == "configure"

        # Runner published an ack back on the control channel.
        ack = await hub_client.get(f"{ep.control}/-1")
        assert ack.status_code == 200
        body = json.loads(ack.content)
        assert body["ok"] is True and body["cmd"] == "configure"

        await sess.close()
        await hub_client.aclose()

    asyncio.run(main())
