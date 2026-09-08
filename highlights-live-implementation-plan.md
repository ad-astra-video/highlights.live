# highlights.live — Implementation Plan

Frontend · Server + remote signer · two GPU live-runners  
Scope: Florence-2 identify → SAM3 track (max 2) → temporal events → Gemma 4 12B decide → clip  
Transport: **go-livepeer live-runner**  
GPU: **perceive (GPU 0, persistent)** + **decide (GPU 1, single-shot)**  
Payments: **go-livepeer remote signer** beside the API, never on a GPU box  
Rule: ship an offline file pipeline before live streaming.

Docs: [live-runner.md](https://github.com/livepeer/go-livepeer/blob/master/doc/live-runner.md) · [remote-signer.md](https://github.com/livepeer/go-livepeer/blob/master/doc/remote-signer.md)

---

## 0. System split

Several processes, one contract. Keys and media never share a host.

| Surface | Owns | Does not own |
|---|---|---|
| **Perceive live-runner (GPU 0)** | Florence-2, SAM3 (2 slots), 1 fps + 8 fps confirm, trickle/WS/SSE for tracks | Gemma, ETH keys, DB, UI |
| **Decide live-runner (GPU 1)** | Gemma 4 12B Q4 `/highlight` | SAM3 state, ETH keys, DB, UI |
| **Transcoder** | FFmpeg CPU or NVENC sidecar | models, payments |
| **Server (API + worker)** | ingest, jobs, temporal engine, adapters, context, scoring, Postgres/Redis, clip records, **payment refresh loop** | model weights, keystore |
| **Remote signer** | ETH keystore, deposit/reserve, ticket signing, orchestrator discovery | frames, models, product UI |
| **Frontend** | operator console, review queue, public feed, overlays | model calls, FFmpeg, wallets |
| **Orchestrator(s)** | runner registry, session capacity, reverse proxy, ticket verify/redeem, trickle broker | our product logic |

Network:

```
Browser
   │
   ▼
highlights API :3000          Redis / Postgres / object storage
   │
   │  discover + sign tickets     ┌─ go-livepeer REMOTE SIGNER :7936
   │  (no ETH key on API)         │    -network arbitrum-one
   ├──────────────────────────────┘    keystore + deposit/reserve
   │
   │  reserve perceive session (pay)
   │  single-shot decide requests (pay)
   │  POST .../session/{id}/payment on interval
   ▼
public Orchestrator :8935
   │
   ├─ persist session ─► perceive runner :8080  GPU0  Florence+SAM3
   └─ single-shot     ─► decide runner   :8081  GPU1  Gemma Q4
```

Dev: call runners directly, `-network offchain`, no signer.  
Staging/prod: API talks only to orchestrator public URLs; signer holds the key; GPU boxes never see ETH.

---

## 0.1 Why live-runner, and the session rule

A live-runner is an ordinary HTTP app that go-livepeer reverse-proxies. It can speak HTTP, SSE, WebSocket, and trickle. The orchestrator does **not** manage the process; it only health-checks or accepts heartbeats and counts sessions.

**Hard rule: one persistent perceive session per stream. Decide is single-shot.**

- Perceive capacity is sessions, not sockets. Trickle + SSE + WebSocket on one stream still use **one** perceive slot.
- SAM3 slots, Florence warm state, and the 60s frame buffer are keyed by the **perceive** `Livepeer-Session-Id`.
- Never start a second perceive session because a second socket connected.
- Gemma does **not** live in that session. Each `/highlight` is a paid single-shot on `highlights-decide`.
- Stop perceive explicitly at stream end. Decide sessions die when the HTTP response finishes.

---

## 0.2 Communication routes (use all three, one session)

Do not pick a single pipe. Split by payload shape. All three share the same `session_id`.

| Route | Direction | Payload | Why this route |
|---|---|---|---|
| **Trickle** `video-in` | server → runner | JPEG/H264 frames, seq monotonic | Livepeer native media path; backpressure; `GET /channel/-1` live edge |
| **Trickle** `events-out` | runner → server | `FrameObservation` / `CandidateEvent` / track deltas | Same seq space as video; easy to align T with frame N |
| **Trickle** `control` | bidirectional | `preferLabels`, seed/evict slot, pause/resume sample rate | Official control channel next to media |
| **WebSocket** `/app/ws` | bidirectional | operator commands + acks | Interactive debugger, reclip, “lock slot 0 on this box” |
| **SSE** `/app/events` | runner → server/UI proxy | highlight decisions, lost-track, health | One-way, reconnect-friendly, no binary |
| **HTTP** `/app/analyze` (perceive) `/app/highlight` (decide) `/clip` (CPU) | request/response | VOD frames, Gemma, ffmpeg | RPC; highlight never shares the perceive process |

Mapping:

```
LIVE PATH
  segment buffer → trickle video-in (1 fps or keyframe)
                 → runner session
                 → trickle events-out + SSE decisions
                 → server temporal / persist
                 → WS only if an operator console is attached

VOD PATH
  same session reserved once
  HTTP POST perceive /app/analyze per frame
  HTTP POST decide /app/highlight   (separate runner, separate payment)
  HTTP POST /clip on CPU/NVENC
```

Headers the runner **must** read on every proxied call:

| Header | Use |
|---|---|
| `Livepeer-Session-Id` | Primary key for `StreamSession` |
| `Livepeer-Session-Token` | Auth for callbacks (create trickle channels, self-stop) |
| `Livepeer-Session-Control` | Base URL for `POST .../channels`, `POST .../proxy`, `POST .../stop` |
| `Livepeer-Runner-Route` | `highlights-perceive` or `highlights-decide` |

An unmodified passthrough can ignore them. This app cannot: SAM3 state lives behind the session id.

---

## 0.3 GPU split (two cards)

One GPU cannot hold a warm Florence-2 + SAM3 video session + Gemma 4 12B Q4 + encode headroom. The failure mode is not “a bit slow”; it is CUDA context fragmentation and a hard OOM the first time Gemma and SAM3 overlap.

### What actually costs VRAM

| Workload | Resident (plan for) | Duty cycle | Notes |
|---|---|---|---|
| Florence-2-large fp16 | 4–8 GB | every sampled frame | Weights are small; generate() spikes |
| SAM3 / 3.1 streaming, 2 tracks | 8–16 GB | every sampled frame | Memory bank, not the 848M weights, is the cost. Offline full-video reports 18–25 GB; streaming 2 slots is lower but not tiny |
| Gemma 4 12B Q4_0 + 1–4 stills | 10–16 GB | only on candidate events | Official Q4 weights ~6.7 GB; KV + mmproj + images add the rest |
| FFmpeg libx264 | CPU | on clip | No GPU required |
| FFmpeg NVENC/NVDEC | ~0.3–1 GB on the encode GPU | on clip | Separate silicon from CUDA cores; do not treat as a third model |

Florence + SAM3 on one 24 GB card is tight-but-workable. Add Gemma and you lose.

### Recommended topology

```
GPU 0  PERCEIVE          GPU 1  DECIDE
24 GB class              16–24 GB class
┌─────────────────┐      ┌─────────────────┐
│ Florence-2      │      │ Gemma 4 12B Q4  │
│ SAM3.1 (2 slots)│      │ llama-server    │
│ 1 fps + 8 fps   │      │                 │
│ confirm window  │      │ NVENC (optional)│
└────────┬────────┘      └────────┬────────┘
         │ persistent             │ single-shot
         ▼                        ▼
 live-runner                 live-runner
 highlights-perceive         highlights-decide
 capacity = streams          capacity = concurrent evals
```

Keep Florence and SAM3 on the **same** GPU. Every frame needs both, and SAM3 is seeded with Florence boxes. Splitting those two across the bus just copies the JPEG and features twice for no VRAM win — Florence is the cheap one.

Do **not** put FFmpeg on GPU 1 as a peer of Gemma. Encode with:

1. CPU `libx264 veryfast` for MVP, or
2. NVENC on GPU 1 only while Gemma is idle, or
3. NVENC on GPU 0 if perceive has headroom (it usually does at 1 fps)

NVENC does not need Gemma’s CUDA context. Binding decode/encode to “the Gemma GPU” is a convenience, not an architecture.

### Two live-runners, not one process with two devices

Match the hardware to live-runner modes:

| Runner | Mode | Why |
|---|---|---|
| `highlights-perceive` | **persistent** | SAM3 memory bank dies if the session dies |
| `highlights-decide` | **single-shot** | each Gemma call is stateless given `ContextSnapshot` |

Server flow:

1. Stream start → reserve **one** perceive session. That session lives for the whole VOD/live.
2. Candidate event → single-shot POST to decide runner (`/highlight`). No SAM3 state there.
3. If highlight → clip on CPU/NVENC. No third runner required.
4. Stream end → stop the perceive session only.

Capacity: perceive `capacity = number of concurrent streams on GPU 0` (start at 1). Decide `capacity = 1–2` concurrent Gemma jobs. A live stream does not consume a decide slot while it is only tracking.

### Why not the other splits

- **Florence on GPU 0, SAM3 on GPU 1.** Worst of both worlds. SAM3 still wants 8–16 GB, Florence is only a few GB, and you add PCIe latency on the hot path.
- **Everything on GPU 0, FFmpeg on GPU 1.** FFmpeg will not save you. Gemma vs SAM3 is the collision.
- **Three GPUs.** Wait until you run two live streams or raise `MAX_TRACKS`.
- **One 24 GB card.** Fallback only: time-slice. Unload or pause SAM3 step while Gemma runs, or run Gemma on CPU. Live 1 fps will hitch. Fine for the first VOD experiment, not for live-runner capacity > 0 while deciding.

### Hardware recipes

| Box | Put where |
|---|---|
| 2× 24 GB (4090 / 3090 / L4 24) | GPU0 perceive, GPU1 decide Q4 or Q5 |
| 24 GB + 16 GB | 24 → perceive, 16 → Gemma Q4 + short context |
| 1× 48 GB / A6000 | Still two **processes**, `CUDA_VISIBLE_DEVICES=0` and `=0` with MIG or just accept colocation only after you measure. Prefer two logical runners even on one physical card so CUDA allocators stay isolated |
| 1× 24 GB only | Mutex in the perceive runner; Gemma via llama.cpp on CPU or deferred queue. `capacity` for decide = 0 on that host |

Pin devices:

```
# perceive container
CUDA_VISIBLE_DEVICES=0

# decide container
CUDA_VISIBLE_DEVICES=1

# ffmpeg: default CPU, or -hwaccel cuda -hwaccel_device 1 when encoding
```

### Session mapping

Same product `streamId`, two Livepeer sessions at most:

```
streamId
  ├─ perceiveSessionId   persistent, SAM3 slots t0/t1
  └─ decideRequestId     ephemeral, one HighlightDecision
```

Do not open a decide session per frame. Do not put Gemma inside the perceive process “just to share the JPEG.” Copy the few stills (full frame + two track crops) over HTTP; that is cheaper than sharing a GPU.

### Measure before raising capacity

On GPU 0, while a session is alive:

```
nvidia-smi --query-gpu=index,memory.used,utilization.gpu --format=csv -l 2
```

Raise perceive `capacity` from 1 only if reserved VRAM after 60s of 1 fps + 2 tracks stays under ~70% of the card. Raise decide capacity only if two Gemma jobs with 4 images do not OOM.

---

## 0.4 Remote signer (runs with the server)

The API is a custom gateway. It must **not** hold an Ethereum keystore. `go-livepeer -remoteSigner` sits next to the API, signs tickets, discovers priced runners, and is the only process that talks to Arbitrum.

Remote signer cannot use `-network offchain`. Local VOD stays offchain and skips this whole section. Staging/prod on public orchestrators turns it on. The flag cannot be combined with `-gateway` or `-orchestrator`.

### Placement

```
server host (CPU, no GPU)
  highlights-api :3000
  highlights-worker
  postgres / redis
  livepeer-signer :7936     ← loopback only
       eth keystore on encrypted volume
       ARBITRUM_RPC
```

GPU hosts run only perceive/decide runners + their local orchestrator if you also supply compute. They do not get the keystore.

### Signer process

```bash
./livepeer \
  -remoteSigner \
  -remoteDiscovery \
  -network arbitrum-one \
  -httpAddr 127.0.0.1:7936 \
  -cliAddr 127.0.0.1:3935 \
  -ethUrl "$ARBITRUM_RPC" \
  -ethPassword /run/secrets/eth-password \
  -maxPricePerUnit "$MAX_WEI_PER_SEC" \
  -liveAICapReportInterval 25m
```

Fund deposit + reserve through the signer CLI (`livepeer_cli` against `:3935`). Orchestrators redeem winning tickets; the signer only creates them.

Auth between API and signer:

```
-remoteSignerHeaders 'Authorization:Bearer $SIGNER_GATEWAY_TOKEN'
```

Optional spend gate: API implements `POST /internal/livepeer/authorize` and the signer calls it via `-remoteSignerWebhookUrl` before `/generate-live-payment`. Reject or cap `maxPrice` per stream / tenant.

### What the server calls

`packages/livepeer-session` is the only client of both the signer and the orchestrator.

| Call | Where | When |
|---|---|---|
| `GET /discover-orchestrators?caps=highlights-live/perceive&caps=highlights-live/decide` | signer | job/stream start; cache ~1 min |
| `POST /sign-orchestrator-info` | signer | before first contact with an orch |
| `POST /apps/{route}/session` | orch | reserve perceive; on `402` retry with payment headers |
| `POST /generate-live-payment` | signer | reserve retry + refresh loop |
| `POST /apps/{route}/session/{id}/payment` | orch | every payment interval while perceive is alive |
| `POST .../app/highlight` | orch → decide | each candidate; attach a fresh payment (single-shot) |
| `POST .../session/{id}/stop` | orch | stream/job end |

`402 Payment Required` on reserve is expected on-chain. Treat it as part of the handshake, not an error.

Persist per stream:

```
streams.perceive_session_id
streams.orch_address
streams.signer_state        jsonb   /* opaque blob from generate-live-payment */
streams.payment_unit        /* seconds | 720p-pixel-seconds | fixed */
```

Worker payment loop (perceive only):

```
while session active:
  sleep orch.payment_interval
  { payment, segCreds, signerState } = signer.generateLivePayment(orchInfo, signerState)
  POST orch .../session/{id}/payment
    Livepeer-Payment: <payment>
    Livepeer-Segment: <segCreds>
  save signerState
  on failure: stop session, mark stream failed, do not keep SAM3 alive for free
```

Decide payments: one `generate-live-payment` per `/highlight`. If the decide runner prices `unit: fixed`, pay once and do not refresh.

Price policy: prefer perceive priced in `hour` → wei-per-second; prefer decide priced `fixed` per evaluation. Cap both with signer `-maxPricePerUnit` and the auth webhook.

### Discovery filter

Ask the signer only for our apps:

```
highlights-live/perceive
highlights-live/decide
```

If you run your own orchestrator, still discover through the signer so price and capability snapshots stay one code path. Fallback `-orchAddr` is fine for a pinned partner box.

### Security

- Signer HTTP bound to `127.0.0.1` or a private docker network. Never on the public NIC.
- Keystore volume not mounted on GPU or frontend machines.
- API never logs `Livepeer-Payment` bodies.
- If the signer is down, refuse new streams; do not fall back to an in-process key.
- Offchain compose profile omits the signer entirely.

---

## 1. Shared contracts first (Day 1–2)

Freeze JSON in `packages/events` before any UI or model wiring.

- `FrameObservation` including `tracks[]` (max 2)
- `CandidateEvent`
- `ContextSnapshot`
- `HighlightDecision`
- `TrackObservation` (`trackId`, `slot: 0|1`, bbox, kind, lostFrames)
- `RunnerSession` `{ sessionId, streamId, kind: "perceive"|"decide", orchAddress, signerState, gameHint, preferLabels, sampleFps }`
- `ControlMessage` discriminated union (see §3.4)
- `OutboundEvent` discriminated union (`observation` \| `candidate` \| `decision` \| `clip` \| `health`)

HTTP (always under the reserved session once live-runner is on):

```
POST /apps/highlights-perceive/session
ANY  /apps/highlights-perceive/session/{sid}/app/analyze
GET  /apps/highlights-perceive/session/{sid}/app/events      SSE
GET  /apps/highlights-perceive/session/{sid}/app/ws          WebSocket
POST /apps/highlights-perceive/session/{sid}/payment
POST /apps/highlights-perceive/session/{sid}/stop

ANY  /apps/highlights-decide/app/highlight                   single-shot
```

Direct runner (dev only): same paths without the `/apps/.../session/{id}` prefix, but still require `Livepeer-Session-Id` (or a local `X-Session-Id` stand-in).

Server public API (frontend):  
`POST /jobs` `GET /jobs/:id` `GET /highlights` `POST /highlights/:id/review`  
`POST /streams/:id/session` `GET /streams/:id/live`

Zod / JSON Schema in `packages/events`. No extra required fields without a version bump.

Acceptance: mocked runner + mocked worker produce one `highlights.json` the frontend can render.

---

## 2. Build order

```
P0  contracts + compose (api, postgres, redis, go-livepeer, runner)
P1  GPU: Florence HTTP /app/analyze on a folder of frames (fake session header)
P2  Server: temporal engine on fixture JSON
P3  GPU: SAM3 2-slot, keyed by session id
P4  Two runners behind orch: persistent perceive + stub decide
P5  Worker: analyze → events → stub Gemma → clip   *** GATE: Valorant VOD clips ***
P6  Real Gemma on GPU 1 single-shot
P7  Trickle video-in + events-out on the perceive session
P8  SSE + WebSocket control
P9  Frontend review + overlay
P10 Remote signer + 402 payment handshake + refresh loop
P11 Live segment buffer into trickle
P12 Public feed + operator live console
```

P5 still uses a reserved **perceive** session even for VOD. That is how SAM3 survives frame 1 → frame N. Gemma stays off that session.

---

## 3. GPU live-runners — step by step

Two containers, two cards, two apps. Private `runner_url`s. The orchestrator is the only public face.

| | Perceive | Decide |
|---|---|---|
| App | `highlights-live/perceive` | `highlights-live/decide` |
| Label | `highlights-perceive` | `highlights-decide` |
| Mode | `persistent` | `single-shot` |
| GPU | `CUDA_VISIBLE_DEVICES=0` | `CUDA_VISIBLE_DEVICES=1` |
| Capacity | concurrent streams (start 1) | concurrent Gemma evals (start 1) |
| Health 200 when | Florence loaded, CUDA visible | llama-server ready |

### 3.1 Process + registration

Static registration first. If both runners sit behind one orchestrator:

`runners.json`:

```json
{
  "runners": [
    {
      "label": "highlights-perceive",
      "routing": "label",
      "runner_url": "http://perceive:8080",
      "health_url": "/health",
      "app": "highlights-live/perceive",
      "version": "0.1.0",
      "metadata": "{\"maxTracks\":2,\"models\":\"florence-2-large,sam3.1\"}",
      "mode": "persistent",
      "capacity": 1,
      "proxy": true,
      "gpu": { "id": "0", "vram_mb": 24576 },
      "price_info": { "price": 2.00, "currency": "usd", "unit": "hour" }
    },
    {
      "label": "highlights-decide",
      "routing": "label",
      "runner_url": "http://decide:8081",
      "health_url": "/health",
      "app": "highlights-live/decide",
      "version": "0.1.0",
      "metadata": "{\"model\":\"gemma-4-12b-q4\"}",
      "mode": "single-shot",
      "capacity": 1,
      "proxy": true,
      "gpu": { "id": "1", "vram_mb": 24576 },
      "price_info": { "price": 0.01, "currency": "usd", "unit": "fixed" }
    }
  ]
}
```

Orchestrator, offchain lab:

```bash
./livepeer \
  -orchestrator \
  -network offchain \
  -serviceAddr http://127.0.0.1:8935 \
  -liveRunnerAddr http://go-livepeer:8935 \
  -liveRunnerConfig ./runners.json
```

On-chain partner orch uses the same file plus `-network arbitrum-one` and a funded orchestrator identity. Prices in `price_info` become the tickets the remote signer must cover.

Health: perceive `/health` is 200 when Florence is up — **not** when Gemma is idle. Decide `/health` is 200 when llama-server answers. Unhealthy runners are hidden and perceive sessions are released. Do not flap health because the other GPU is busy.

### 3.2 Session object on the runner

```python
class RunnerSession:
    session_id: str          # Livepeer-Session-Id
    stream_id: str           # our product id
    token: str               # Livepeer-Session-Token
    control_url: str         # Livepeer-Session-Control
    prefer_labels: list[str]
    sample_fps: float        # 1.0 continuous, 8.0 confirm
    tracks: Sam3Tracker      # MAX_TRACKS = 2
    frame_index: int
    last_frame_ts: float
    recent_frames: deque     # last 60s paths or bytes
    trickle: TrickleHandles | None
    ws_clients: set
    sse_subscribers: set
```

Lifecycle:

1. First proxied request or explicit `POST /app/session/open` sees a new `Livepeer-Session-Id` → create `RunnerSession`.
2. On that first request, runner calls  
   `POST {control}/runner/{id}/session/{sid}/channels`  
   to open `video-in`, `events-out`, `control`.
3. Every later HTTP/WS/SSE/trickle message on that id hits the same object.
4. Idle timeout (e.g. 60s no frames and no sockets) or `POST /app/session/close` → drop SAM3, delete channels, optional callback stop.
5. Orchestrator `released` on the O2R trickle channel is authoritative: destroy state even if our close handler missed.

### 3.3 Frame source

1. VOD: FFmpeg `fps=1` → HTTP `/app/analyze` or publish those JPEGs on `video-in`.
2. Live: server writes segment frames onto `video-in` with increasing seq.
3. Confirm window: runner internally extracts `T±15s` at 8 fps; does **not** open a second Livepeer session.

### 3.4 Control protocol (WS + trickle control)

Same JSON on both sockets so the operator UI and the worker share one schema.

```ts
type ControlMessage =
  | { type: "configure"; preferLabels: string[]; sampleFps: number; gameHint?: string }
  | { type: "seed"; slot?: 0 | 1; bbox: [number, number, number, number]; kind: TrackKind; label: string }
  | { type: "evict"; slot: 0 | 1 }
  | { type: "lock"; slot: 0 | 1 }      // refuse automatic eviction
  | { type: "analyze-still"; timestamp: number } // force Florence+SAM3 on last frame
  | { type: "confirm"; timestamp: number; pre: number; post: number }
  | { type: "clip"; start: number; end: number }
  | { type: "ping" };
```

Acks go back on WS and as SSE `health` / trickle `events-out` items. Trickle control is the live path; WS is the human path.

### 3.5 Florence + SAM3 (unchanged roles)

1. Florence `<OCR> <OD> <CAPTION>` per sampled frame.
2. Selector `MAX_TRACKS = 2`, IoU dedup, adapter `preferLabels`.
3. SAM3.1 multiplex, box-seeded from Florence, keyed by **session id**.
4. Drop a slot after 8 lost frames unless `lock` is set.
5. IoU stub if HF access is pending.

`/app/analyze` and trickle `video-in` must call the same `session.step(frame)` function.

### 3.6 Outbound events

`OutboundEvent` examples:

```json
{ "type": "observation", "sessionId": "...", "timestamp": 12.0, "tracks": [/* ≤2 */], "objects": [], "ocr": [] }
{ "type": "candidate", "sessionId": "...", "event": { "type": "KILL", "timestamp": 12.0 } }
{ "type": "decision", "sessionId": "...", "decision": { "isHighlight": true, "score": 78 } }
{ "type": "clip", "sessionId": "...", "clipUri": "...", "start": 3.0, "end": 18.0 }
{ "type": "health", "sessionId": "...", "vramMb": 18200, "slots": 2 }
```

Fan-out: write once internally, emit to trickle `events-out` **and** SSE. WS gets a copy only if an operator is connected.

### 3.7 Decide runner + clip

Decide container exposes only `POST /app/highlight`. It does not import SAM3 or Florence. Input is `ContextSnapshot` plus up to 4 JPEGs (full frame + two track crops). Output is `HighlightDecision` JSON.

Clip stays on the worker host (CPU libx264) or NVENC bound to GPU 1 only while decide is idle. Not a live-runner.

### 3.8 Trickle implementation notes

Use the orchestrator as the broker. After session start:

```
POST {Livepeer-Session-Control}/runner/{route}/session/{sid}/channels
Authorization / Livepeer-Session-Token: <token>
```

Then:

- Server **publishes** `POST {video-in}/{seq}` with image bytes.
- Runner **subscribes** `GET {video-in}/-1` (live edge) or `GET {video-in}/{seq}`.
- Runner **publishes** observations on `events-out`.
- Server **subscribes** `events-out` and feeds TemporalEngine.

Preconnect `seq+1` to hide inter-segment delay. Do not invent a second broker (no Redis streams for media).

Python: `pytrickle` is acceptable for the subscribe/publish loop. Do not wrap the whole product in `FrameProcessor` video-to-video unless you also want a preview overlay on `video-out`. Optional later: `video-out` = source frame with two track boxes burned in for the live console.

### 3.9 SSE + WebSocket implementation notes

- SSE: `GET /app/events`, `text/event-stream`, event name = `OutboundEvent.type`, data = JSON. Heartbeat comment every 15s. Last-Event-Id = last frame seq so reconnects resume.
- WS: `GET /app/ws`, one connection per operator. First message must bind to the existing session (header already injected by proxy). Reject a WS that tries to create a new session.

The orchestrator proxy already forwards streaming bodies and WS upgrades. Do not terminate WS at the API and re-open a different session on the runner.

### 3.10 Dev stand-in

If go-livepeer is down, runner accepts:

```
X-Session-Id: local-dev
X-Session-Token: dev
```

Same session map. This keeps P1–P3 unblocked.

---

## 4. Server — step by step

### 4.1 Skeleton

Unchanged packages. Add `packages/livepeer-session`:

- `discover({ caps })` → signer `GET /discover-orchestrators`
- `signOrchInfo(address)` → signer `POST /sign-orchestrator-info`
- `generatePayment(orchInfo, signerState)` → signer `POST /generate-live-payment`
- `reservePerceive({ orch, paymentHeaders })`
- `refreshPayment(sessionId)`
- `stop(sessionId)`
- `highlight(context, images)` → single-shot decide via orch
- `openChannels` / `publishFrame` / `subscribeEvents` on the perceive session

Talks to the **signer** and the **orchestrator public URL**. Never to `runner_url`. Never holds a keystore.

### 4.2 Offline job (still session-scoped)

```
POST /jobs { source: "file", path, gameHint }
```

Worker:

1. Insert `streams` row  
2. Discover perceive + decide via signer (or pinned offchain orch in lab)  
3. `reservePerceive()`; on `402`, `generatePayment` and retry  
4. Start payment refresh task  
5. Extract 1 fps; `POST .../perceive/.../app/analyze`  
6. TemporalEngine + adapters  
7. Each candidate: `highlight()` on decide (own payment)  
8. Maybe CPU `/clip`  
9. `stop()` perceive in `finally`; cancel payment loop

Acceptance: VOD produces json + clips, one perceive session id across frames, and (on-chain profile) at least one successful `/payment` refresh.

### 4.3 Live path

1. Ingest HLS/RTMP → 2–4s segments, last 60s on disk  
2. Discover + pay + reserve one **perceive** session when the stream goes live  
3. Sample 1 fps, publish to trickle `video-in`  
4. Subscribe `events-out` + SSE; persist observations/events  
5. On candidate: paid single-shot decide. If highlight at T, wait until buffer has T+15, then `confirm` on perceive + CPU clip  
6. On stream end: `stop()` perceive and halt payment refresh

Redis: `stream:{id}:session` = Livepeer session id, `stream:{id}:tracks` = current two slots for the UI.

### 4.4 Review API

Same as before. Live console reads `GET /streams/:id/live` which is a server-side SSE that already merged runner SSE + DB events. Browser never talks to go-livepeer directly in v1 (auth and payments stay server-side).

### 4.5 Tests

- Reserve → three `/analyze` → same `trackId`  
- Stop → next analyze with that id is 404/410  
- Capacity 1 → second perceive reserve is 503
- On-chain reserve without payment headers → 402, retry with signer tickets succeeds
- Payment refresh failure stops the session  
- Kill cluster still works when events arrive via trickle instead of HTTP

---

## 5. Frontend — step by step

Operator app first. It never opens trickle itself.

1. Jobs + upload (VOD uses hidden persistent session).
2. Review player, accept/reject.
3. Frame debugger: filmstrip + Florence boxes + two SAM3 boxes.
4. Live console: `<video>` of source, overlay from `GET /streams/:id/live` SSE, WS-style controls posted to `POST /streams/:id/control` which the server writes onto trickle `control` or runner WS.

Controls the UI may send: `preferLabels`, `seed`, `evict`, `lock`, `confirm`.

Public feed stays on accepted clips only.

---

## 6. Who builds what, in parallel

| Week | GPU | Server + signer | Frontend |
|---|---|---|---|
| 1 | Perceive: Florence `/app/analyze` + fake session header | Zod + mock orch `reserve/stop` | jobs shell |
| 2 | Perceive: SAM3 keyed by session id | TemporalEngine fixtures | filmstrip overlay |
| 3 | Two containers + `runners.json` (perceive persistent, decide stub) | VOD worker through perceive session | review player |
| 4 | Decide: real Gemma Q4 `/highlight` | wire decide single-shot; CPU clip | factor bars |
| 5 | Trickle video-in + events-out | publish/subscribe + payment loop **offchain skipped** | live event tail |
| 6 | SSE + WS control | **remote signer** + 402 handshake + refresh | seed/evict/lock |
| 7 | 60s live buffer | on-chain profile, spend webhook | live console |

Shared week-3 gate: Valorant VOD in, one persistent session, clips out, human review.

---

## 7. Concrete first commands

```bash
# GPU 0 perceive
CUDA_VISIBLE_DEVICES=0 uvicorn services.perceive.app:app --host 0.0.0.0 --port 8080

# GPU 1 decide
CUDA_VISIBLE_DEVICES=1 llama-server -m $GEMMA_Q4 --port 8088
CUDA_VISIBLE_DEVICES=1 uvicorn services.decide.app:app --host 0.0.0.0 --port 8081

# Orchestrator (lab)
./livepeer -orchestrator -network offchain \
  -serviceAddr http://127.0.0.1:8935 \
  -liveRunnerConfig ./runners.json

# Remote signer (prod / staging only; not offchain)
./livepeer -remoteSigner -remoteDiscovery \
  -network arbitrum-one \
  -httpAddr 127.0.0.1:7936 \
  -ethUrl $ARBITRUM_RPC \
  -ethPassword /run/secrets/eth-password

# Server
npm run dev:api
npm run dev:worker

npm run analyze -- ./videos/valorant.mp4
```

Reserve perceive by hand (offchain):

```bash
curl -X POST http://127.0.0.1:8935/apps/highlights-perceive/session
```

On-chain the same POST returns `402` until the worker attaches `Livepeer-Payment` + `Livepeer-Segment` from the signer.

---

## 8. Definition of done

**MVP**  
VOD through a reserved persistent **perceive** session → ≤2 stable tracks → single-shot **decide** → clips → operator review. Offchain, no signer.

**Live alpha**  
One live source, one perceive session, trickle + SSE, 60s buffer. Signer optional if the orch is still yours and offchain.

**Public beta**  
Accepted clips on a feed. Remote signer on, deposit funded, payment refresh keeps perceive alive, decide paid per eval. Still max 2 tracks.

---

## 9. Risks

- **Session ≠ socket.** Opening WS + SSE + trickle is one session. Creating a new session per socket resets SAM3. Encode this in the server reserve helper.
- **Unhealthy health checks release sessions.** `/health` must not fail just because Gemma is busy.
- **VRAM.** Florence + SAM3 + Gemma on 24 GB needs a mutex or two devices. Capacity stays 1 until that is measured.
- **Orchestrator hides runner_url.** Debug with `docker logs highlights-runner`; do not publish :8080.
- **Trickle seq gaps** stall the subscriber. Publisher must not skip seq; drop the frame instead.
- **SAM3 HF gate.** IoU stub behind the same session object.
- **Signer is on-chain only.** `-remoteSigner` + `-network offchain` is invalid. Lab profile omits the signer.
- **402 is the handshake.** A reserve without tickets is not a product error on mainnet.
- **Missed payment refresh releases the perceive session** and wipes SAM3. The refresh task is as critical as the analyze loop.
- **Keys off GPU hosts.** A compromised runner must not be able to drain the deposit.
- **Price units differ.** Perceive `hour` → refresh; decide `fixed` → pay once. Do not run the same refresh code on both.

---

## 10. This week

1. Freeze schemas including `ControlMessage` / `OutboundEvent` / `RunnerSession` (`kind: perceive|decide`).
2. Perceive runner: `/health`, `/app/analyze`, session map keyed by `Livepeer-Session-Id`.
3. Two-entry `runners.json` + local offchain orchestrator. Decide can stub `isHighlight`.
4. Server: reserve perceive → loop analyze → stop. No signer in the lab compose profile.
5. Frontend: filmstrip that draws `objects[]` and `tracks[]`.
6. Constant `MAX_TRACKS = 2` shared by selector, SAM3, and overlay.
7. Stub `packages/livepeer-session` with a `SignerClient` interface so the 402 path can be filled in week 6 without rewriting the worker.
