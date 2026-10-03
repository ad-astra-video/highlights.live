# ADAAAA-6319 — Active audio-context path: deployed + re-measured

Follow-up to [ADAAAA-6315](/ADAAAA/issues/ADAAAA-6315). The integrated rework
(`feat/ad-6314-audio-context-asr` = 6312 normalized audio trigger + 6314
ASR->text audio context into the gemma decide) **and** the cheap ASR endpoint
are now deployed on the Livepeer GPU box (`livepeer-ai-x99`,
`highlights-server.dpn.gg`) via `origin/master` @ `a3828ea`, and the
previously-flagged acceptance criteria were re-measured **on the active path**.

## What was deployed / verified running

| Component | Verdict |
| --- | --- |
| `asr` service (faster-whisper `/transcribe`, CPU) | Up, healthy; ASR_DEVICE=cpu |
| `decide` container runs `transcribe_audio` | Confirmed in `/srv/decide/app/gemma.py` |
| `ASR_URL=http://asr:8082` in decide env | Confirmed |
| `LIVE_AUDIO_CONTEXT=1` in server env | Confirmed |
| `AUDIO_CONTEXT=1` (decide transcript injection on) | Confirmed (compose default) |
| `GEMMA_SEND_AUDIO` raw audio ingest | OFF (Path 2: audio delivered as ASR text) |

## Measured acceptance criteria (all on the deployed active path)

### Criterion 2 — Accepted-highlight relevance ("none relevant" fix): PASS
Direct contrast test through the live `decide`/`gemma` path (ASR transcript
injected). Non-relevant/mundane commentary is now **rejected**; matching
highlight commentary is **accepted**:

| audio (ASR transcript used) | eventType | isHighlight | score | reason (cites ASR) |
| --- | --- | --- | --- | --- |
| "The goalkeeper slowly rolls the ball to the defender and the play continues." | GOAL | **false** | 0 | "The audio commentary explicitly states the play continues after a goalkeeper roll, and there is no visual evidence of a goal being scored." |
| "The forward takes the shot and scores a magnificent goal." | GOAL | **true** | 95 | "The commentary explicitly confirms a magnificent goal was scored, corroborated by high crowd energy and visual celebration cues." |

Root cause fixed: the decide model reads the audio **text** (not just loudness),
so a loud-but-mundane window no longer surfaces as a relevant highlight.

### Criterion 4 — Full-pipeline live p50/p95 latency (within 1-5 s): PASS
Measured end-to-end through the deployed decide->gemma->ASR path (5 warm runs):

| leg | p50 | p95 | max |
| --- | --- | --- | --- |
| decide -> ASR -> gemma (single highlight) | **1.38 s** | **1.41 s** | 1.41 s |
| ASR /transcribe leg only | **0.70 s** | 0.71 s | 0.71 s |

Adding the previously-recorded audio-gate leg (p50 0.2 s from ADAAAA-6315)
gives a full live-path p50 of **~1.6 s**, well inside the 1-5 s budget.

### Criterion 5 — Per-highlight Livepeer GPU cost, audio-context (ASR) cost isolated
Cost model in code (`server/src/api.ts`: `costUsd = decideFee*decideCalls +
perceiveS/3600*PERCEIVE_PER_HOUR_USD`):

- **Per-highlight GPU cost = ${DECIDE_FEE:-0.01} per gemma decide call** (single
  shot) + `${PERCEIVE_PER_HOUR_USD=0.01}`/h perceive session share.
- **Audio-context does NOT add any per-highlight GPU cost**: it folds the ASR
  transcript into the **same single gemma decide shot** (still 1 decide call),
  so `decideCalls` and therefore GPU cost are unchanged.
- **ASR cost isolated = $0 (no Livepeer GPU charge).** The ASR service runs
  **CPU-only** (`ASR_DEVICE=cpu`, faster-whisper int8), never calls the Livepeer
  orchestrator/signer, and costs ~0.70 s of local CPU per clip (measured). The
  active path adds compute only on free local CPU, not on billed Livepeer GPU.

### Criterion 6 — Transcript accuracy (small sample): PASS
Three known-transcript English sports-commentary phrases synthesized, run
through the deployed `/transcribe`:

| sample | ASR text | WER |
| --- | --- | --- |
| "The forward takes the shot and scores a magnificent goal" | identical (+".") | ~0% |
| "What a save by the goalkeeper keeping the match alive" | identical (+".") | ~0% |
| "The crowd explodes as the team celebrates the late winner" | identical (+".") | ~0% |

Word-identical to ground truth (only a terminal period); ASR latency
0.69-0.74 s/clip. ASR auto-detects language (`language=None`) and transcribes
in the source language (no separate translation step) — the transcript is
delivered in the native commentary language so gemma grounds on the actual
commentary text.

## Caveats
- Server->decide live forwarding is enabled (`LIVE_AUDIO_CONTEXT=1`) but was not
  exercised on a real live stream in this run (no session was active at measure
  time); the decide endpoint and audio-context behavior were verified directly.
- Criterion 6 sample was English commentary; multilingual (non-English)
  transcript accuracy was not separately sampled this run (ASR supports it via
  language detection but it is not measured here).

## Evidence
Run by Developer (9d2416aa) 2026-10-03 against the deployed
`highlights-server.dpn.gg` stack. ASR/decide calls issued inside the `hl`
docker network; `audioContext` readouts confirmed `path=asr_text,
transcribed=true, asrRan=true`.
