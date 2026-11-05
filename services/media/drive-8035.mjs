// Media-rail replay driver used by the QA harness (ADAAAA-8035, fixed in ADAAAA-8051).
//
// Replays an IVF (VP8) plus an opus RTP audio stream into a provisioned media
// session over WebRTC and stops at SECONDS.
//
// ADAAAA-8051: the process must never outlive its replay. `pc.close()` does not
// release werift's ICE/DTLS timers, so falling off the end of the script left a
// parked node process (a few seconds of CPU, PPID = the original docker exec
// session) that kept holding the IVF and competed for the single media-session
// slot. Every exit path now funnels through shutdown() -> process.exit():
//   - the replay window ends (SECONDS),
//   - the media node drops our session (polled; session close / node restart),
//   - a hard watchdog fires EXIT_GRACE_MS after SECONDS,
//   - SIGTERM / SIGINT / SIGHUP from the QA launcher's trap.
import fs from "node:fs";
import dgram from "node:dgram";
import { spawn } from "node:child_process";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useVP8, useOPUS } from "werift";

const BASE = process.env.MEDIA_BASE || "http://localhost:4070";
const SID = process.env.SID || "";
const IVF = process.env.IVF || "";
const FPS = Number(process.env.FPS || 30);
const SECONDS = Number(process.env.SECONDS || 35);
const AUDIO_SRC = process.env.AUDIO_SRC || "";
const AUDIO_PORT = Number(process.env.AUDIO_PORT || 0);
const ORIGIN = "https://highlights-server.dpn.gg";
// Watchdog slack past SECONDS, and how often the session is polled for liveness.
const EXIT_GRACE_MS = Number(process.env.EXIT_GRACE_MS || 15000);
const SESSION_POLL_MS = Number(process.env.SESSION_POLL_MS || 3000);
const HEALTH_TOKEN = process.env.MEDIA_HEALTH_TOKEN || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pc = null;
let ff = null;
let asock = null;
let exiting = false;

function shutdown(code, why) {
  if (exiting) return;
  exiting = true;
  console.log(`DRIVE_EXIT reason=${why} pid=${process.pid} code=${code}`);
  try {
    if (ff && ff.exitCode === null) ff.kill("SIGKILL");
  } catch {}
  try {
    if (asock) asock.close();
  } catch {}
  try {
    if (pc) pc.close();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0, "sigterm"));
process.on("SIGINT", () => shutdown(0, "sigint"));
process.on("SIGHUP", () => shutdown(0, "sighup"));
process.on("uncaughtException", (e) => {
  console.log("DRIVE_UNCAUGHT " + ((e && e.stack) || e));
  shutdown(1, "uncaught-exception");
});
process.on("unhandledRejection", (e) => {
  console.log("DRIVE_UNHANDLED " + ((e && e.stack) || e));
  shutdown(1, "unhandled-rejection");
});

// Hard stop: SECONDS of replay plus EXIT_GRACE_MS of slack, then leave.
setTimeout(() => shutdown(0, "seconds-watchdog"), SECONDS * 1000 + EXIT_GRACE_MS);

function ivfFrames(p) {
  const raw = fs.readFileSync(p);
  if (raw.toString("ascii", 0, 4) !== "DKIF") throw new Error("not ivf " + p);
  const hdr = raw.readUInt16LE(6);
  const out = [];
  let off = hdr;
  while (off + 12 <= raw.length) {
    const size = raw.readUInt32LE(off);
    out.push(raw.subarray(off + 12, off + 12 + size));
    off += 12 + size;
  }
  return out;
}

async function postJson(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  let d;
  try { d = JSON.parse(t); } catch { d = t; }
  return { status: r.status, data: d };
}

// Is our session still registered on the media node?
// `/node` carries session ids but needs MEDIA_HEALTH_TOKEN (present inside the
// media container). Without it, fall back to the public `activeSessions` count
// (maxSessions 1, so 0 means nothing is live). `null` = unknown, never an exit.
async function sessionAlive() {
  const opts = { signal: AbortSignal.timeout(3000) };
  if (HEALTH_TOKEN) {
    const r = await fetch(BASE + "/node", { ...opts, headers: { authorization: `Bearer ${HEALTH_TOKEN}` } });
    if (r.ok) {
      const j = await r.json();
      if (Array.isArray(j.sessions)) return j.sessions.some((s) => s.sessionId === SID);
    }
  }
  const r2 = await fetch(BASE + "/health", opts);
  if (!r2.ok) return null;
  const j2 = await r2.json();
  const n = j2?.capacity?.activeSessions;
  return typeof n === "number" ? n > 0 : null;
}

let misses = 0;
function startSessionPoller() {
  const t = setInterval(async () => {
    let alive = null;
    try { alive = await sessionAlive(); } catch { alive = null; }
    if (alive === null) return;               // transient read error: do not exit
    if (alive) { misses = 0; return; }
    if (++misses < 2) return;                 // two consecutive misses = closed
    console.log("SESSION_GONE sid=" + SID);
    shutdown(0, "session-closed");
  }, SESSION_POLL_MS);
  t.unref?.();
}

const frames = ivfFrames(IVF);
console.log(`DRIVE start sid=${SID} frames=${frames.length} fps=${FPS} seconds=${SECONDS} audio=${AUDIO_SRC ? "yes" : "no"} pid=${process.pid}`);

pc = new RTCPeerConnection({ codecs: { video: [useVP8()], audio: [useOPUS()] } });
const vt = new MediaStreamTrack({ kind: "video" });
pc.addTransceiver(vt, { direction: "sendonly" });
let at = null;
if (AUDIO_SRC && AUDIO_PORT) {
  at = new MediaStreamTrack({ kind: "audio" });
  pc.addTransceiver(at, { direction: "sendonly" });
}

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
const off = await postJson(`/sessions/${SID}/rtc/offer`, { offer: { type: offer.type, sdp: offer.sdp } });
console.log(`OFFER status=${off.status}`);
if (off.status !== 200 || !off.data?.answer) {
  console.log("OFFER_FAIL " + JSON.stringify(off.data).slice(0, 400));
  shutdown(1, "offer-failed");
}
const ans = typeof off.data.answer === "string" ? { type: "answer", sdp: off.data.answer } : off.data.answer;
await pc.setRemoteDescription(ans);
for (let i = 0; i < 100 && pc.connectionState !== "connected"; i++) await sleep(100);
console.log(`CONN=${pc.connectionState}`);
if (pc.connectionState !== "connected") {
  console.log("CONN_FAIL");
  shutdown(1, "connect-failed");
}

const trs = pc.getTransceivers();
const vSender = trs.find((t) => t.sender && t.sender.track && t.sender.track.kind === "video")?.sender;
const aSender = trs.find((t) => t.sender && t.sender.track && t.sender.track.kind === "audio")?.sender;
for (const s of [vSender, aSender]) {
  if (s) { s.sequenceNumber = 0; s.timestamp = 0; s.seqOffset = 0; s.timestampOffset = 0; }
}
const vPay = vSender?.codec?.payloadType ?? 96;
const aPay = aSender?.codec?.payloadType ?? 111;
console.log(`CODEC video_pt=${vPay} audio_pt=${aPay} video_ssrc=${vSender?.ssrc} audio_ssrc=${aSender?.ssrc}`);

// Connected and registered: from here a dropped session ends the replay early.
startSessionPoller();

let asockStarted = false;
let apk = 0;
if (at && AUDIO_SRC && AUDIO_PORT) {
  asock = dgram.createSocket("udp4");
  let aclock = 0;
  let ats = 0;
  asock.on("message", (m) => {
    if (m.length < 13) return;
    apk++;
    at.writeRtp(new RtpPacket(new RtpHeader({
      payloadType: aPay,
      sequenceNumber: (aclock++) % 65536,
      timestamp: (ats += 960),
      ssrc: aSender?.ssrc ?? 2,
      marker: 1,
    }), Buffer.from(m.subarray(12))));
  });
  asock.bind(AUDIO_PORT, "127.0.0.1");
  asockStarted = true;
  await sleep(200);
  ff = spawn("ffmpeg", ["-re", "-hide_banner", "-loglevel", "error", "-i", AUDIO_SRC, "-vn", "-ac", "1", "-ar", "48000",
    "-c:a", "libopus", "-b:a", "48k", "-f", "rtp", "-payload_type", "96", `rtp://127.0.0.1:${AUDIO_PORT}`],
    { stdio: ["ignore", "ignore", "inherit"] });
  console.log("AUDIO_START port=" + AUDIO_PORT);
}

const t0 = Date.now();
let seq = 0;
let ts = 0;
let sent = 0;
const CHUNK = 1000;
const durMs = SECONDS * 1000;
while (Date.now() - t0 < durMs && !exiting) {
  const frame = frames[sent % frames.length];
  ts += Math.round(90000 / FPS);
  const n = Math.max(1, Math.ceil(frame.length / CHUNK));
  for (let i = 0; i < n; i++) {
    const part = frame.subarray(i * CHUNK, Math.min(frame.length, (i + 1) * CHUNK));
    const desc = i === 0 ? Buffer.from([0x10]) : Buffer.from([0x00]);
    vt.writeRtp(new RtpPacket(new RtpHeader({
      payloadType: vPay,
      sequenceNumber: seq++ % 65536,
      timestamp: ts,
      ssrc: vSender?.ssrc ?? 1,
      marker: i === n - 1 ? 1 : 0,
    }), Buffer.concat([desc, part])));
  }
  sent++;
  const wait = t0 + (sent * 1000) / FPS - Date.now();
  if (wait > 0) await sleep(wait);
  if (sent % (FPS * 5) === 0) {
    console.log(`PROGRESS frames_sent=${sent} elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s audio_pkts=${apk}`);
  }
}
console.log(`STREAM_DONE frames_sent=${sent} seconds=${((Date.now() - t0) / 1000).toFixed(2)} audio_pkts=${apk}`);
await sleep(2000);
if (ff) ff.kill("SIGKILL");
if (asock || asockStarted) asock.close();
await pc.close();
const cl = await postJson(`/sessions/${SID}/close`, {}).catch(() => ({ status: 0 }));
console.log("CLOSE status=" + cl.status);
console.log("DRIVE_DONE");
shutdown(0, "replay-complete");
