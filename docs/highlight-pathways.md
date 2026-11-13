# Highlight identification pathways (the map)

Status: owned by the highlights.live Product Owner ([ADAAAA-8881](/ADAAAA/issues/ADAAAA-8881)).
This is the single map of every pathway by which a moment in a stream becomes an
**identified highlight / notable moment / big play** — from capture to the served
card. Read it before changing detection, gating, clip placement or the served row
shape.

Every change that adds, removes or re-orders one of these pathways must update
this file in the same commit. `pnpm check:pathways` (also run by `pnpm test` via
`services/server/test/highlight-pathways-map.test.ts`) fails when a cited path
disappears or when a machine-checked number below no longer matches the code, so
the map cannot silently drift.

Scope note: this map describes what the code does **today**. Where a pathway is
behind an env flag, the flag and its shipped default are stated. Posture flags are
listed in §7.

---

## 1. The vocabulary (what "identified" means)

Three different questions get conflated in conversation; keep them separate.

| Term | Meaning | Set at |
| --- | --- | --- |
| `outcome` | `scoring_play` \| `near_miss` \| `big_play` \| `not_highlight` — the decide verdict's own classification of the window | `services/decide/app/gemma.py:434` (prompt contract), mirrored by the deterministic rule path |
| `isHighlight` | the accept flag on a decide verdict; a `scoring_play` read still has to survive the server accept path before it is a row | `services/decide/app/__init__.py:806` (`/highlight`) |
| row status / lane | `accepted` \| `suppressed` \| `rejected`, plus per-row markers: provisional goal, confirmation lane, `replayOf`, `clipChoice` | `packages/events/src/index.ts:1909` (`HighlightRecordSchema`) |
| "postable" | the read-side gate that decides what the board may show. A stored row is **not** a highlight until it passes this | `services/server/src/highlight-postable.ts:265` |

Only `scoring_play` may be a board GOAL. `near_miss` (a shot that did not convert)
and `big_play` (save / hit / clutch denial / red card / counter) are **notable but
not scoring**: they are surfaced distinctly and can never be a GOAL. `not_highlight`
is nothing. The prompt rule is explicit (`services/decide/app/gemma.py:1946`), and
ADR ADAAAA-6598 exists because near-miss/big-play reads were once surfacing as
GOALs.

Three clocks are also distinct and must not be mixed: the **content/analysis**
clock a window is judged on, the **media-rail** clock `localizedTs` lives on, and
the **recording file** clock a clip is cut from (`docs/live-observe-lag.md`,
`services/server/src/clip-anchor.ts`).

---

## 2. Map at a glance

```
LIVE BROWSER SHARE              LIVE RTMP / FILE-SIM                 VOD FILE
browser WebRTC + opus           ffmpeg pull + audio tap              upload / URL
  -> media node (services/media)  -> LiveIngest (live.ts)               -> analyzeJob (analyzer.ts)
  -> POST /jobs/:id/observe       -> POST /analyze + /audio             -> POST /analyze + /audio
        |                              |                                    |
        +--------- STAGE A: trigger / signal layer (GPU-free) -------------+
          audio noise-change (burst | swell)   whistle (stage B, tonal)
          scoreboard OCR delta   ball / goal-line plane   tracks/motion
          ASR transcript         perceive timeline
                                    |
              window assembly: ~10 s span, <=30 frame ceiling,
              live rolling-past @5 s, VOD symmetric @3 s, 8 images/decide (live)
                                    |
                  decide  POST /highlight  (gemma 12B; rule fallback)
              outcome = scoring_play | near_miss | big_play | not_highlight
                                    |
                    decide-side gate ladder (S4.1)
                                    |
              server accept path: confirm dive / goal recall / LANE-1 scoring gate
                                    |
              HighlightRecord  +  clip (anchor -> placement -> cut)
                                    |
              read-side postable gate + served rows (detail | delta | feed)
```

---

## 3. Pathway catalogue

Each row is one pathway: what fires it, the module that owns it, what it changes,
and whether it is shipped on or opt-in.

| ID | Rail | Fires when | Owner module | Changes | Posture |
| --- | --- | --- | --- | --- | --- |
| L1 | live browser share | browser publishes WebRTC video+opus to the media node | `services/media/src/rtc.ts`, `services/server/src/media-rail.ts:484` | each observation + anchor JPEG feeds a `LiveObserver` | on when a browser share is provisioned |
| L2 | live RTMP / file-sim | server pulls a stream / loops a file | `services/server/src/live.ts` | frames + audio tap into `analyzeJob` | on |
| V1 | VOD | upload / URL job runs the detail-first pass | `services/server/src/analyzer.ts:11452` (`analyzeJob`) | frames + audio tap into the VOD pass | `OBSERVE_LOOP=1` (see S7) |
| A1 | both | audio energy change: burst (fast onset) or sustained swell | `services/perceive/app/audio_gate.py` → `POST /audio` | Stage-A candidate anchored at the onset | on |
| A2 | both | band-limited tonal whistle (2.4–3.4 kHz) | `services/perceive/app/audio_gate.py` (Stage-B) | whistle candidate / evidence; own verdict ledger | on |
| A3 | both | tracker peak displacement, detection-in-zone, ball-velocity surge | `services/perceive/app/stage_a.py` | profile-routed Stage-A sites | **inert for soccer** — no shipped profile enables motion/zone/ball-velocity |
| A4 | both | scorebug OCR reads a score change | `services/perceive/app/scoreboard.py`, `services/perceive/app/scoreboard_vision.py`; ROI pin `services/server/src/scoreboard-surface.ts` | `scoreBoardChanged` evidence | on |
| A5 | both | ball crosses the goal-line plane inside the mouth | `services/perceive/app/goal_plane.py`, `services/perceive/app/pitch_homography.py` | `goalCrossed` / `ballInNet` / `ballOutcome` | on when calibrated; absent = not captured, never fabricated |
| A6 | both | Florence-2 detections promoted to persistent tracks (SAM3) | `services/perceive/app/tracker.py`, `services/perceive/app/sam_tracker.py`, `services/perceive/app/ball_signal.py`; contract `docs/tracked-object.md` | tracks, motion, possession, tracking evidence | on, capped 3 live / 8 VOD |
| A7 | both | ASR transcribes the window's audio | `services/asr`; prefetch lane `services/server/src/asr-prefetch.ts` | transcript used as fallible evidence (and goal-call cue) | on |
| A8 | VOD (gated) | the Tier-2 predicate sees a real signal in a window | `services/server/src/observe-loop.ts:2091` (`escalatesToTier2`) | decides whether a window earns a billable decide | `OBSERVE_SIGNAL_GATE=1` |
| B1 | live | cadence tick of the live observer | `services/server/src/observe-loop.ts:785` (`LiveObserver`) | assembles the rolling past window, issues decide | `LIVE_OBSERVE_LOOP=1` |
| B2 | both | a Stage-A trigger fires | `services/server/src/audio-trigger.ts` (`TriggerWindowScheduler`) | schedules an anchored window at the trigger moment | on |
| B3 | VOD (detail-first) | cadence tick over the whole file | `services/server/src/observe-loop.ts` symmetric `assembleObserveWindow` | 3 s cadence, `decideWindowN` frame sequence | `OBSERVE_LOOP=1` |
| B4 | VOD (baseline) | a perceive candidate fires | `services/server/src/analyzer.ts` (candidate path, 3 s frame-group merge) | one merged `/highlight` review per group | default VOD baseline when `OBSERVE_LOOP` is off |
| C1 | both | un-attested goal-type accept | `services/decide/app/confirm.py` (`/confirm`), server lane `services/server/src/live-confirm-async.ts` | higher-fidelity dive: confirmed_goal / near_miss / not_goal | `DECIDE_CONFIRM_ENABLED=1`; live async lane `LIVE_CONFIRM_ASYNC` (default on) |
| C2 | live | celebration window follows an attack/shot window | `services/server/src/live-goal-recall.ts` | recall floor: a real goal whose crossing instant fell between 1 fps samples | on (live rail) |
| C3 | live | a GOAL accept without a measured attestation | server scoring lane (`services/server/src/analyzer.ts:7955`, LANE-1) | demote / hold the GOAL unless scoreboard- or frame-attested, no recap refusal | on (live rail) |
| C4 | live | demoted goal with a corroborating cue | `services/server/src/live-provisional-goal.ts:132` | stamps a **provisional** marker; the row stays `big_play` | on |
| C5 | live | a demoted window whose OCR has no post-goal read | `services/server/src/live-frame-reread.ts` | bounded re-read of frames already on disk (no decide, no GPU) | on |
| D1 | both | verdict + evidence are final for a window | decide-side gate ladder, S4.1 | accept / reject / score | on |
| D2 | both | an accepted row is cut | `services/server/src/clip-choice.ts`, `services/server/src/clip-placement.ts:96`, `services/server/src/clip-anchor.ts:284` | the delivered window, its served clip and its placement audit fields | on |
| D3 | both | rows are read for a surface | `services/server/src/highlight-postable.ts:304`, `services/server/src/served-highlight-rows.ts`, `services/server/src/job-detail.ts` | dedupe / collapse / postable list / one served row shape | on |
| D4 | both | a promoted row needs body copy | `services/server/src/summary-lane.ts`, `services/server/src/summary-ladder.ts` | one text-only summary inference, off the decide loop | on (metered) |

---

## 4. The ladders (order matters)

A moment is identified only if it walks the whole chain. Each stage can only
narrow the set — later gates never invent an identification the earlier stage did
not produce, with two named exceptions (`near_miss` reconciliation and the
provisional marker) that are marked below.

### 4.1 Decide-side ladder (inside `/highlight`)

Order as executed in `services/decide/app/__init__.py:806` (single) and
`_handle_group` (grouped):

1. **Read** — gemma 12B (`services/decide/app/gemma.py`) or the deterministic rule
   fallback (`services/decide/app/decider.py`). A model/transport failure falls
   back to the rule; the pipeline never dies on a model glitch.
2. **Ball-outcome gate** (`services/decide/app/gemma.py:793`) — a present, contradicting goal-line
   outcome rejects. Absence is **not** a rejection (ADAAAA-6543).
   **Exception:** a goal-bound shot that did not convert is reconciled to
   `near_miss` (`services/decide/app/gemma.py:1284`), never to `scoring_play`.
3. **Scoreboard force** (`scoreboard_forces_goal`) — a detected score change for a
   GOAL event forces an accept, but **never** overrides a model read that
   explicitly said `not_highlight` (ADAAAA-7533).
4. **Goal-attestation gate** (`services/decide/app/gemma.py:896`) — a GOAL claim without the required
   attestation is refused.
5. **Notable-only bar** (`services/decide/app/decider.py` `apply_gate`) — a bare trigger with no
   corroborating content is rejected; a candidate passes only when it is
   corroborated **and** (high-value event class OR score >= `DEFAULT_NOTABILITY_MIN`).
6. **Goal acceptance finalization** (`services/decide/app/gemma.py:1384`) — the single accept rule for
   goal-shaped verdicts.
7. **Contract guard** (`services/decide/app/gemma.py:1142`, last) — the served sentence may not claim
   more than the evidence attested.

### 4.2 Server accept ladder (`acceptVideoDecision`, `services/server/src/analyzer.ts:7659`)

1. **Confirm dive** — for an un-attested goal-shaped accept: inline
   (`confirmReconcile`), or off the accept path on the live async lane
   (`LIVE_CONFIRM_ASYNC`, default on). A dive that cannot corroborate downgrades a
   goal-shaped read to `near_miss`; the async lane never rewrites a published row.
2. **Live goal recall** (`services/server/src/live-goal-recall.ts`) — a celebration/reaction window
   that follows an attack-or-shot window becomes a recounted goal (the sub-second
   crossing fell between 1 fps samples).
3. **LANE-1 scoring gate** (`services/server/src/analyzer.ts:7955`) — a GOAL row must be
   `measuredGoalAttested` **and** carry a named authority (`scoreboard` or
   `frame`) **and** not be a recap refusal (`recapWindowRefusal`). Otherwise the
   row is held/demoted, not silently accepted.
4. **Provisional marker** (`services/server/src/live-provisional-goal.ts`) — on that demotion seam, a
   corroborating cue (ASR goal call, celebration description, crowd reaction)
   stamps the row provisional. The row stays `big_play`; the marker never changes
   the outcome.
5. **Transition dedupe / forward-only reads** — a transition whose post state is
   below a state the run already read cannot attest a new goal (ADAAAA-8564). The
   withdrawn "one transition = one goal per run" rule stays withdrawn: a second
   clip that repeats a progression is a different moment.
6. **Repeat-GOAL downgrade** (ADAAAA-7865) — a repeat GOAL accept on the same
   moment is stored as `big_play`.
7. **Cut + persist** — placement (below) then the record write; the row is
   published at decision time, not at stream end.

### 4.3 Clip ladder (placement, then cut)

1. **Placement** (`services/server/src/clip-placement.ts:96`) — one decision for **where** the window
   sits: a row that can name its goal instant is `goal_anchor`; a reaction cue with
   no goal instant is `celebration_tail` (`[cue - (window - tail), cue + tail]`,
   `CELEBRATION_TAIL_S`); a VOD row with no judged live window is
   `evidence_anchor`; goal containment may beat a leading cue
   (`goal_anchor_over_leading_cue`). Length is unchanged (>= 15 s floor,
   `services/server/src/config.ts:1320` `clipWindow`).
2. **Anchor** (`services/server/src/clip-anchor.ts:284`) — which frame of the recording the card is cut
   on: locate the accepted evidence picture (`frame_match`), else the scorebug
   flip (`score_flip`), else the content clock (`content_clock`). The chosen method
   and both instants are stored on the row, so the delivered offset is gradeable
   without re-reading pixels.
3. **Alternatives** (`services/server/src/clip-choice.ts`) — an operator may point the moment at an
   already-cut alternative (its replay, a celebration window). This is a pointer
   swap: the moment's own window, the summary ladder and the quota math are
   untouched.

### 4.4 Read-side ladder (what the board is allowed to show)

1. **Postable gate** (`services/server/src/highlight-postable.ts:265`) — drops rows whose own verdict
   text refutes the goal, `status: rejected` rows, and rows already refuted by
   their confirmation dive.
2. **Overlap collapse** (`collapseOverlappingWindows`, `combineClockMoments`) —
   overlapping windows become one moment; both totals (raw rows vs postable
   moments) are defined by `docs/clip-counting.md`.
3. **One served row shape** (`services/server/src/served-highlight-rows.ts`) — the composite
   `/jobs/:id/detail` read and the `/jobs/:id/sections-delta` stream call the same
   builders, so a delta refresh cannot degrade a card (ADAAAA-8854).
4. **Summary ladder** (`services/server/src/summary-ladder.ts`) — match summary → chapters → window
   narratives → decide audit, derived at read time from stored data only ($0).

---

## 5. VOD-only detail pathways

The VOD pass is detail-first; speed is secondary. These pathways exist to out-depth
the live pass rather than to change what counts as a highlight:

| Pathway | Owner | What it buys |
| --- | --- | --- |
| Symmetric window + 3 s cadence + `decideWindowN` sequence | `services/server/src/observe-loop.ts`, `services/server/src/config.ts` (`vodDecideWindowN`, default 24 > live 16) | gemma reasons across a longer frame sequence per trigger |
| Higher-FPS re-sample around a trigger | `services/server/src/config.ts` (`VOD_RESAMPLE_FPS` 8, `VOD_RESAMPLE_WINDOW_S` 3) | the ball-crossing instant lands inside the judged window |
| Full-file audio tap | `services/server/src/vod-audio.ts` | window-aligned audio on every window, same wire contract as live |
| Adaptive perceive cadence | `services/server/src/perceive-cadence.ts` | cuts per-frame perceive cost in cool regions, full-perceive around any Tier-2-escalated window (recall-safe by the same predicate) |
| Resume checkpoint | `services/server/src/vod-resume.ts` | a long VOD resumes without re-paying perceive for completed spans |
| Summary + chapters | `services/server/src/summary-lane.ts`, `services/server/src/summary-ladder.ts` | body copy and a drill-down ladder the live pass does not produce |

---

## 6. Cost map (Livepeer GPU)

Every pathway above is priced against the same runner economics; the map exists so
a sequencing decision can name which pathway's compute it spends.

| Unit | Price used by settlement | Anchor |
| --- | --- | --- |
| perceive persistent session | `PERCEIVE_PER_HOUR_USD` = $0.01/hr (flat hour) | `services/server/src/job-settlement.ts:26` |
| decide call (`/highlight`, `/plan`, `/title`) | `DECIDE_FEE` list price, default $0.01/call | `services/server/src/config.ts:1268` |
| summary inference | `SUMMARY_FEE`, clamped to 1.5x `DECIDE_FEE` | `services/server/src/job-settlement.ts:99` |
| confirm dive | a decide-priced call; the most expensive identification path, hence the async lane for live | `services/server/src/live-confirm-async.ts` |
| clip cut | CPU/FFmpeg, no GPU unit | `services/server/src/clip-anchor.ts` |

Live cost is bounded by four independent controls, none of which changes the
window span or the trigger:

- **admission** — at most one live job holds the decide slot when
  `LIVE_DECIDE_ADMISSION=1`; a second stream's decide is refused, not queued
  (`services/server/src/live-decide-admission.ts`)
- **rate cap** — charged decides per 300 s of content clock, resolved per job
  (`decideRateCapPer300s`); dropped windows are counted as
  `observeMetrics.throttleSkippedWindows`
- **image budget** — `LIVE_DECIDE_IMAGE_BUDGET` images/decide (8), never above the
  30-frame ceiling
- **lag budget** — a window more than `LIVE_OBSERVE_LAG_BUDGET_S` behind wall time
  is dropped, not decided late

---

## 7. Posture flags (shipped defaults)

| Flag | Default | Effect on this map |
| --- | --- | --- |
| `LIVE_OBSERVE_LOOP` | off (env `"1"` enables) | whether B1 (live observer) or the legacy candidate-gated live rail runs |
| `OBSERVE_LOOP` | off (env `"1"` enables) | whether B3 (VOD observer) or B4 (VOD candidate baseline) runs |
| `OBSERVE_SIGNAL_GATE` | off | whether A8 gates VOD decide calls |
| `LIVE_DECIDE_ADMISSION` | off | whether one live decide slot is enforced |
| `DECIDE_CONFIRM_ENABLED` | off on decide; server flags it per rail | C1 dive availability |
| `LIVE_CONFIRM_ASYNC` | on (`"0"` disables) | whether the live dive runs off the accept path |
| `DECIDE_NOTABILITY_MIN` | 60.0 | D1 step 5 separating bar |

---

## 8. Where each pathway is measured

| Metric | What it proves | Where it is written |
| --- | --- | --- |
| Stage-A onset → fire | the 1–5 s trigger lens (gate `max_latency_s` = 5 s) | audio gate response; `observeMetrics.triggerFires`, `triggerLatencyByFamily` |
| trigger → decide window | anchored-fire latency by family (stageA roar, stageB whistle) | `observeMetrics.triggerLatencyByFamily` |
| payload shape | `imagesPerDecide`, `imageBudgetApplied`, `spanSec`, `cadenceMs` per decide | `decide_audit` row |
| coverage / throttle | decided vs skipped windows (`decideCalls`, `throttleSkippedWindows`) | `observeMetrics` |
| trigger → delivered row | gate-3 AC (`deliveredLatency`) | `services/server/src/live-delivery.ts` |
| leg grade | delivered latency, accepted rows, GOAL rows on one live leg | `services/server/src/live-leg-grade.ts` |
| discernment | notability bar on the labeled set | `evals/decide_discernment.py` |
| tracking accuracy | labeled track manifest + harness | `evals/track_metrics.py`, `evals/track_label_manifest.py`, `docs/tracked-object.md` |
| trigger recall / FP | audio and motion recall on labeled fixtures | `evals/measure_audio_recall.py`, `evals/measure_motion_recall.py` |

The honest latency statement: the **trigger** is designed to fire inside the 1–5 s
lens (lead 1 s, coalesce 2.5 s, hard `max_latency_s` 5 s), but a **delivered row**
can sit up to the 30 s lag budget behind the live edge because one decide costs
several cadence periods on a saturated card. Do not restate the 1–5 s lens as
row-delivery latency.

---

## 9. Invariants (machine-checked)

The values below are asserted against the code by
`scripts/check-highlight-pathways.mjs`. If a change moves one, update this table in
the same commit or the check fails.

<!-- pathway-invariants:start -->
```json
{
  "invariants": [
    { "file": "services/server/src/observe-loop.ts", "symbol": "OBSERVE_CADENCE_S", "value": 3, "means": "VOD decide cadence, content seconds" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "LIVE_OBSERVE_CADENCE_S", "value": 5, "means": "live decide cadence default, content seconds" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "OBSERVE_WINDOW_S", "value": 10, "means": "VOD reference window, content seconds" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "OBSERVE_MAX_FRAMES", "value": 30, "means": "hard per-call frame ceiling" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "LIVE_OBSERVE_WINDOW_S", "value": 10, "means": "live rolling-past window, content seconds" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "LIVE_OBSERVE_MAX_FRAMES", "value": 30, "means": "live per-call frame ceiling" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "LIVE_DECIDE_IMAGE_BUDGET", "value": 8, "means": "images per live decide" },
    { "file": "services/server/src/observe-loop.ts", "symbol": "LIVE_OBSERVE_LAG_BUDGET_S", "value": 30, "means": "live stale-window drop budget, seconds" },
    { "file": "services/server/src/audio-trigger.ts", "symbol": "AUDIO_TRIGGER_LEAD_S", "value": 1.0, "means": "frames covering the onset wait before an anchored fire" },
    { "file": "services/server/src/audio-trigger.ts", "symbol": "AUDIO_TRIGGER_COALESCE_S", "value": 2.5, "means": "two onsets closer than this are one event, per family" },
    { "file": "services/perceive/app/audio_gate.py", "symbol": "max_latency_s", "value": 5.0, "means": "hard onset -> fire bound" },
    { "file": "services/perceive/app/audio_gate.py", "symbol": "cooldown_s", "value": 2.0, "means": "re-trigger suppression after a fire" },
    { "file": "services/perceive/app/audio_gate.py", "symbol": "burst_ratio", "value": 1.3, "means": "energy / baseline to count a burst frame" },
    { "file": "services/decide/app/decider.py", "symbol": "DEFAULT_NOTABILITY_MIN", "value": 60.0, "means": "notable-only bar on the ordinary class" },
    { "file": "packages/events/src/index.ts", "symbol": "MAX_TRACKS", "value": 8, "means": "schema track ceiling" },
    { "file": "packages/events/src/index.ts", "symbol": "LIVE_MAX_TRACKS", "value": 3, "means": "live tracked-object cap" },
    { "file": "packages/events/src/index.ts", "symbol": "VOD_MAX_TRACKS", "value": 8, "means": "VOD tracked-object cap" },
    { "file": "services/perceive/app/tracking_plan.py", "symbol": "LIVE_MAX_TRACKS", "value": 3, "means": "live tracked-object cap (runner)" },
    { "file": "services/perceive/app/tracking_plan.py", "symbol": "VOD_MAX_TRACKS", "value": 8, "means": "VOD tracked-object cap (runner)" },
    { "file": "services/server/src/clip-placement.ts", "symbol": "CELEBRATION_TAIL_S", "value": 2, "means": "tail kept after a reaction cue" },
    { "file": "services/server/src/live-goal-recall.ts", "symbol": "LIVE_GOAL_RECALL_LEAD_S", "value": 30, "means": "attack window a celebration may follow" },
    { "file": "services/server/src/job-settlement.ts", "symbol": "PERCEIVE_PER_HOUR_USD", "value": 0.01, "means": "perceive list price, $/hour" }
  ]
}
```
<!-- pathway-invariants:end -->

---

## 10. Keeping this map current

| Change you are making | Sections that must change |
| --- | --- |
| a new trigger / signal source, or a profile enabling a Stage-A site | S3 (A-rows), S9 if it adds a constant |
| window assembly, cadence, frame/image budget, lag or admission policy | S2 diagram, S3 (B-rows), S6, S9 |
| a new gate, or a re-order in either ladder | S4.1 / S4.2 in the executed order |
| clip placement, anchoring, alternatives | S4.3, S9 |
| postable / served row shape / dedupe / counting | S4.4, `docs/clip-counting.md` |
| a VOD-only detail pathway | S5 |
| a posture flag default | S7 |
| pricing or a new metered call | S6, S8 |

Commands:

```sh
pnpm check:pathways   # fast, no build, no GPU
pnpm test             # runs the same check as a vitest case
```

---

## 11. Known gaps (honest)

- **Row delivery latency is not inside the 1–5 s lens.** The lens is met at the
  trigger; delivery waits for a decide slot. This is a funded cost decision, not a
  bug, and it is the main tradeoff a sequencing proposal must state.
- **Soccer's Stage-A profile enables audio only.** Motion / zone / ball-velocity
  sites are routed and testable but inert for the shipped type
  (`services/perceive/app/stage_a.py`).
- **The live observer rails are opt-in by env.** A deployment that does not set
  `LIVE_OBSERVE_LOOP=1` runs the legacy candidate-gated live rail, so a QA leg must
  name its posture before its numbers are compared to another leg.
- **Two clip placement implementations exist.** `services/server/src/clip-anchor.ts` is the shared
  sequence; `cutBrowserHighlightClip` in `services/server/src/api.ts` still carries its own copy and
  the two must stay in step until it is migrated.
- **No HUD-parse oracle ships.** `corroboration_oracle` names the seam
  (`services/perceive/app/game_profile.py`) but the shipped soccer oracle is
  scoreboard OCR / audio-text, not a HUD parser.
