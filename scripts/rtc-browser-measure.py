#!/usr/bin/env python3
"""Real-browser WebRTC ingest measurement for the highlights media node.

Why this exists
---------------
ADAAAA-7594 needs a **real browser** stream measured end to end, not a
hand-written werift peer (the werift driver adds its own tracks and never runs
Chrome's encoder, so it cannot prove what a browser really negotiates).

The shipped client path is `webapp/src/components/BrowserCapture.tsx`
`establishRtc()`. That component can only run inside the deployed SPA, and the
SPA's job creation (`POST /jobs`) needs an authenticated session. This harness
drives the *same* signalling sequence from a real Chromium page instead:

  POST /sessions                      (media node, no auth)
  navigator.mediaDevices.getDisplayMedia({video:true, audio:true})
  pc.addTransceiver(videoTrack, {direction:"sendonly"})
  pc.addTransceiver(audioTrack, {direction:"sendonly"})     # ADAAAA-7594 client half
  pc.createOffer() -> setLocalDescription()
  POST /sessions/:sid/rtc/offer       -> {answer, pcId}
  pc.setRemoteDescription(answer)
  trickle ICE -> POST /sessions/:sid/rtc/ice/:pcId
  ws  /stream/:sid                    -> {type:"observation", observation}

Everything after the track attach is byte-for-byte the sequence the component
performs (`BrowserCapture.tsx` establishRtc(), including the same public
`rtcOrigin` and the same `iceServers` returned by provisioning). The capture is
a real `getDisplayMedia` stream (fake-capture device flags only, so no screen
chooser prompt), so Chrome's own encoder negotiates the codec a browser really
picks (VP8 by default).

Reported counters
-----------------
- negotiated codec (from the local SDP rtpmap, i.e. what Chrome actually sent)
- outbound-rtp video: framesEncoded, packetsSent, bytesSent, keyFramesEncoded
- outbound-rtp audio: packetsSent, bytesSent (real opus from the browser)
- every observation relayed on the session socket, with arrival time, so a
  stall (frames arriving then silence while the encoder keeps running) is
  visible as a seq/timeline gap rather than a silent zero
- `ws` — the observer socket's lifecycle (opened/closed, close code+time, frame
  count, TEXT vs BINARY framing, first observation time). Read `obsCount`
  together with this: `obsCount` counts observations on THIS harness's own
  `wss://<media>/stream/<sid>` socket only. It is not a server relay metric, and
  0 does not mean the relay stalled (`obsSource`/`obsCountMeaning` say so in the
  JSON, and `relayVerdict` spells out which case a 0 is).
- `POST /sessions/:sid/close` at the end so no perceive slot is left reserved

Usage
-----
    pip install playwright && playwright install chromium
    python3 scripts/rtc-browser-measure.py --codec vp8 --duration 25
    python3 scripts/rtc-browser-measure.py --codec vp8 --duration 45 --job-id <browser-job-id> \\
        --json out.json           # job-bound: observations are also relayed to the control plane
    python3 scripts/rtc-browser-measure.py --codec h264 --duration 25 --json out.json

Requires a Chromium build that supports fake display capture (tested on
Chromium 156 / playwright 1.4x). Media-node logs (`[rtc] frame frames=`,
`[rtc] obs liveMs=`, `[rtc] audio audioPackets=`) are the box-side counterpart
and are read with `docker logs highlights-media`.

Observation frames (ADAAAA-7678, measured 2026-11-01 on image f679abc3)
---------------------------------------------------------------------
Observations ARE produced for a media-only (not job-bound) session: the perceive
runner answers every published frame, and the media log shows `[rtc] obs seq=1..N`
for a plain `POST /sessions`. What read as "zero observations" was this harness:
the relay frames arrived as **BINARY** frames (a browser hands those to
`onmessage` as a `Blob`, so `JSON.parse(e.data)` threw and the parse error was
swallowed). The harness now decodes Blob/ArrayBuffer, and the media server sends
TEXT frames (services/media/src/guarded-write.ts `sendText`), so `obsCount` is a
real relay count. Server-side attach is independently readable with
`GET /node` (`sessions[].sockets`) once `MEDIA_HEALTH_TOKEN` is set in the deploy
env (`docker/.env` on the box).
"""

from __future__ import annotations

import argparse
import http.server
import json
import socketserver
import sys
import threading
import time
import urllib.error
import urllib.request

PAGE = b"""<!doctype html><html><body style="margin:0;background:#123">
<h1 style="color:#fff;font:20px sans-serif">highlights rtc measure</h1>
</body></html>"""

# The media node sits behind Cloudflare, whose browser-integrity check rejects a
# bare urllib User-Agent with HTTP 403 `error code: 1010`. Provisioning and close
# are plain JSON calls, so a normal browser UA is enough to pass it.
UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"
)


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 20.0):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        url,
        data=data,
        method=method,
        headers={"content-type": "application/json", "user-agent": UA, "accept": "*/*"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode(errors="replace")


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.send_header("content-type", "text/html")
        self.send_header("content-length", str(len(PAGE)))
        self.end_headers()
        self.wfile.write(PAGE)

    def log_message(self, *_a):  # silence
        pass


def serve_local_page() -> tuple[socketserver.TCPServer, int]:
    srv = socketserver.TCPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, srv.server_address[1]


BROWSER_JS = r"""
async ({ base, sid, rtcOrigin, iceServers, codec, durationMs }) => {
  const out = {
    errors: [],
    codec,
    sdpVideoRtpmap: null,
    sdpAudioRtpmap: null,
    transceivers: [],
    hasVideoTrack: false,
    hasAudioTrack: false,
    video: { framesEncoded: 0, packetsSent: 0, bytesSent: 0, keyFramesEncoded: 0 },
    audio: { packetsSent: 0, bytesSent: 0 },
    observations: [],
    wsOpened: false,
    wsError: null,
    // ADAAAA-7678: the socket lifecycle is the discriminator between "the relay
    // wrote nothing" and "this socket never attached (or was destroyed at
    // upgrade)". A 0 without it was read as a stalled relay.
    ws: { opened: false, closed: false, closeCode: null, closeReason: null, openedAtMs: null, closedAtMs: null, firstObservationAtMs: null },
    connectionState: null,
    samples: [],
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    // ---- session socket: every observation publishAndObserve relays lands here
    let ws;
    try {
      ws = new WebSocket(`${base.replace(/^http/, "ws")}/stream/${sid}`);
      ws.onopen = () => {
        out.wsOpened = true;
        out.ws.opened = true;
        out.ws.openedAtMs = Math.round(performance.now());
      };
      ws.onerror = (e) => { out.wsError = String((e && e.message) || "ws error"); };
      ws.onclose = (e) => {
        out.ws.closed = true;
        out.ws.closeCode = e && typeof e.code === "number" ? e.code : null;
        out.ws.closeReason = e && e.reason ? String(e.reason) : null;
        out.ws.closedAtMs = Math.round(performance.now());
      };
      ws.onmessage = async (m) => {
        // ADAAAA-7678: count EVERY frame, and keep the first raw shape, so a 0
        // observation tally is distinguishable from "the server sent nothing".
        out.ws.messages = (out.ws.messages || 0) + 1;
        // A browser delivers a WS frame as a string (TEXT) or a Blob/ArrayBuffer
        // (BINARY). Decode both: before this, a binary frame threw inside
        // JSON.parse and was swallowed, so a healthy relay counted as 0.
        let text = null;
        if (typeof m.data === "string") {
          text = m.data;
        } else if (m.data instanceof Blob) {
          out.ws.nonTextFrames = (out.ws.nonTextFrames || 0) + 1;
          text = await m.data.text();
        } else if (m.data instanceof ArrayBuffer) {
          out.ws.nonTextFrames = (out.ws.nonTextFrames || 0) + 1;
          text = new TextDecoder().decode(m.data);
        }
        if (!out.ws.firstRaw) {
          out.ws.firstRaw = {
            dataType: Object.prototype.toString.call(m.data),
            size: typeof text === "string" ? text.length : null,
            decoded: text ? text.slice(0, 120) : null,
          };
        }
        if (text === null) return;
        try {
          const msg = JSON.parse(text);
          if (msg && msg.type === "observation") {
            if (out.ws.firstObservationAtMs === null) out.ws.firstObservationAtMs = Math.round(performance.now());
            const o = msg.observation || {};
            out.observations.push({
              seq: o.seq ?? null,
              atMs: Math.round(performance.now()),
              wall: Date.now(),
              keys: Object.keys(o).slice(0, 12),
              ts: o.timestamp ?? o.ts ?? null,
            });
          } else {
            out.ws.otherTypes = (out.ws.otherTypes || []).concat([msg && msg.type ? String(msg.type) : "?"]);
          }
        } catch (e) {
          out.ws.parseErrors = (out.ws.parseErrors || 0) + 1;
        }
      };
    } catch (e) {
      out.wsError = String(e && e.message || e);
    }

    // ---- real display capture (fake device => no chooser prompt)
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (e) {
      out.errors.push("getDisplayMedia(audio)->" + String(e && e.message || e));
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    }
    const vt = stream.getVideoTracks()[0];
    const at = stream.getAudioTracks()[0];
    out.hasVideoTrack = !!vt;
    out.hasAudioTrack = !!at;
    if (vt) {
      const st = vt.getSettings ? vt.getSettings() : {};
      out.videoSettings = { width: st.width, height: st.height, frameRate: st.frameRate, displaySurface: st.displaySurface };
    }

    // ---- BrowserCapture.establishRtc(): same peer, same transceivers
    const pc = new RTCPeerConnection(iceServers && iceServers.length ? { iceServers } : {});
    window.__pc = pc;
    if (vt) pc.addTransceiver(vt, { direction: "sendonly" });
    if (at) pc.addTransceiver(at, { direction: "sendonly" });

    if (codec === "h264" && vt) {
      const caps = RTCRtpReceiver.getCapabilities ? RTCRtpReceiver.getCapabilities("video") : null;
      const h264 = caps ? caps.codecs.filter((c) => /H264/i.test(c.mimeType)) : [];
      const tx = pc.getTransceivers().find((t) => t.sender && t.sender.track === vt);
      if (tx && tx.setCodecPreferences && h264.length) {
        try { tx.setCodecPreferences(h264); } catch (e) { out.errors.push("setCodecPreferences:" + String(e)); }
      } else {
        out.errors.push("h264 pref unavailable (caps=" + !!caps + " h264=" + h264.length + ")");
      }
    }

    let pcId = "";
    const pending = [];
    const sendCandidate = (c) => {
      if (!pcId) { pending.push(c); return; }
      fetch(`${rtcOrigin}/sessions/${sid}/rtc/ice/${pcId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidate: c }),
      }).catch(() => {});
    };
    pc.onicecandidate = (e) => { if (e.candidate) sendCandidate(e.candidate.toJSON()); };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const sdp = pc.localDescription.sdp;
    out.sdpVideoRtpmap = sdp.split("\n").filter((l) => l.startsWith("a=rtpmap:") && /VP8|VP9|H264/i.test(l));
    out.sdpAudioRtpmap = sdp.split("\n").filter((l) => l.startsWith("a=rtpmap:") && /opus/i.test(l));

    const ans = await fetch(`${rtcOrigin}/sessions/${sid}/rtc/offer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offer: pc.localDescription }),
    });
    if (!ans.ok) throw new Error("rtc signaling failed: HTTP " + ans.status);
    const { answer, pcId: id } = await ans.json();
    pcId = id;
    await pc.setRemoteDescription(answer);
    pending.forEach(sendCandidate);
    pending.length = 0;

    out.transceivers = pc.getTransceivers().map((t) => ({
      mid: t.mid,
      direction: t.direction,
      kind: t.receiver && t.receiver.track ? t.receiver.track.kind : null,
      sender: t.sender && t.sender.track ? t.sender.track.kind : null,
    }));

    // ---- sample getStats() while the stream runs
    const t0 = performance.now();
    while (performance.now() - t0 < durationMs) {
      await sleep(1000);
      const stats = await pc.getStats();
      let v = null, a = null;
      stats.forEach((r) => {
        if (r.type === "outbound-rtp" && r.kind === "video") v = r;
        if (r.type === "outbound-rtp" && r.kind === "audio") a = r;
      });
      if (v) {
        out.video.framesEncoded = v.framesEncoded || 0;
        out.video.packetsSent = v.packetsSent || 0;
        out.video.bytesSent = v.bytesSent || 0;
        out.video.keyFramesEncoded = v.keyFramesEncoded || 0;
      }
      if (a) {
        out.audio.packetsSent = a.packetsSent || 0;
        out.audio.bytesSent = a.bytesSent || 0;
      }
      out.connectionState = pc.connectionState;
      out.samples.push({
        tMs: Math.round(performance.now() - t0),
        framesEncoded: out.video.framesEncoded,
        packetsSent: out.video.packetsSent,
        opusPackets: out.audio.packetsSent,
        obs: out.observations.length,
        state: pc.connectionState,
      });
    }

    stream.getTracks().forEach((t) => t.stop());
    try { pc.close(); } catch { /* noop */ }
    try { if (ws) ws.close(); } catch { /* noop */ }
  } catch (e) {
    out.errors.push(String((e && e.message) || e));
  }
  return out;
}
"""


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--base", default="https://highlights-media.dpn.gg", help="media node origin")
    ap.add_argument("--codec", choices=["vp8", "h264"], default="vp8")
    ap.add_argument(
        "--job-id",
        help=(
            "bind the media session to an existing browser-capture job. Observations are "
            "only produced by the perceive runner for a job-bound session, so the "
            "frames>=3 + relayed-observation measurement needs this."
        ),
    )
    ap.add_argument("--duration", type=float, default=25.0, help="seconds to stream")
    ap.add_argument("--json", help="write the full result JSON here")
    ap.add_argument("--keep-open", action="store_true", help="do not close the media session")
    args = ap.parse_args()

    from playwright.sync_api import sync_playwright

    base = args.base.rstrip("/")
    status, prov = http_json("POST", f"{base}/sessions", {"jobId": args.job_id} if args.job_id else {})
    if status != 200 or not prov or not prov.get("sessionId"):
        print(f"PROVISION_FAIL status={status} body={prov}", file=sys.stderr)
        return 2
    sid = prov["sessionId"]
    rtc_origin = prov.get("rtcOrigin") or base
    ice = prov.get("iceServers") or []
    print(f"SESSION={sid} rtcOrigin={rtc_origin} iceServers={json.dumps(ice)} maxSessions={prov.get('maxSessions')}")

    srv, port = serve_local_page()
    result: dict = {}
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=True,
                args=[
                    "--use-fake-ui-for-media-stream",
                    "--use-fake-device-for-media-stream",
                    "--autoplay-policy=no-user-gesture-required",
                    "--window-size=1280,720",
                ],
            )
            page = browser.new_page(viewport={"width": 1280, "height": 720})
            page.goto(f"http://127.0.0.1:{port}/")
            result = page.evaluate(
                BROWSER_JS,
                {
                    "base": base,
                    "sid": sid,
                    "rtcOrigin": rtc_origin,
                    "iceServers": ice,
                    "codec": args.codec,
                    "durationMs": int(args.duration * 1000),
                },
            )
            browser.close()
    finally:
        srv.shutdown()
        if not args.keep_open:
            cstatus, _ = http_json("POST", f"{base}/sessions/{sid}/close", {})
            print(f"SESSION_CLOSE status={cstatus}")

    summary = {
        "media": base,
        "sessionId": sid,
        "codecRequested": args.codec,
        "durationSec": args.duration,
        "hasVideoTrack": result.get("hasVideoTrack"),
        "hasAudioTrack": result.get("hasAudioTrack"),
        "videoSettings": result.get("videoSettings"),
        "sdpVideoRtpmap": result.get("sdpVideoRtpmap"),
        "sdpAudioRtpmap": result.get("sdpAudioRtpmap"),
        "transceivers": result.get("transceivers"),
        "connectionState": result.get("connectionState"),
        "clientVideo": result.get("video"),
        "clientAudio": result.get("audio"),
        "observations": result.get("observations"),
        # ADAAAA-7678: obsCount is a CLIENT-side count of `{type:"observation"}`
        # frames this harness's own observer socket received on
        # `wss://<media>/stream/<sid>`. It is not a relay metric: the shipped SPA
        # does not open that socket on the RTC rail at all (it reads the control
        # plane's SSE `/jobs/:id/events`), so a 0 here says nothing about whether
        # the server relayed. Read it together with `ws` (did the socket attach
        # and stay open?) and the media log's `[rtc] obs seq=`.
        "obsCount": len(result.get("observations") or []),
        "obsSource": "observer socket only (wss /stream/:sid)",
        "obsCountMeaning": (
            "client-side count of observation messages received on this harness's own "
            "observer socket; 0 is NOT proof the server relay stopped (check ws.* and "
            "the media log '[rtc] obs seq=' before concluding anything about relay)"
        ),
        "ws": result.get("ws"),
        "samples": result.get("samples"),
        "wsOpened": result.get("wsOpened"),
        "wsError": result.get("wsError"),
        "errors": result.get("errors"),
    }

    # Make a 0 self-explaining instead of being read as a stalled relay.
    ws = summary.get("ws") or {}
    video_pkts = (summary.get("clientVideo") or {}).get("packetsSent") or 0
    if summary["obsCount"] == 0 and video_pkts > 0:
        if not ws.get("opened"):
            summary["relayVerdict"] = (
                "observer socket never opened -> this harness proves nothing about relay; "
                "server-side relay unknown (read the media log)"
            )
        elif ws.get("closed") and (ws.get("closedAtMs") or 0) < 2000:
            summary["relayVerdict"] = (
                f"observer socket attached then destroyed at {ws.get('closedAtMs')}ms "
                f"(close {ws.get('closeCode')}) -> the socket was NOT attached to the session "
                "(server-side divergence: check /stream/:sid attach for this sid)"
            )
        else:
            summary["relayVerdict"] = (
                "observer socket stayed open but received no observations -> relay wrote to "
                "no socket OR wrote elsewhere; compare the media log's [rtc] obs seq= set"
            )
    elif summary["obsCount"] > 0:
        seqs = [o.get("seq") for o in (result.get("observations") or [])]
        summary["relayVerdict"] = f"observer socket received {len(seqs)} observations, seq={seqs}"
    text = json.dumps(summary, indent=2)
    print(text)
    if args.json:
        with open(args.json, "w") as fh:
            fh.write(text + "\n")
    return 0 if not summary["errors"] else 1


if __name__ == "__main__":
    sys.exit(main())
