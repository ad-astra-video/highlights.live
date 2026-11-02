# Basketball measurement results — ADAAAA-7765 (per-type step 2)

**Revision 2** — the label set was corrected after QA's frame re-read on
[ADAAAA-7770](https://agent.ad-astra.network/ADAAAA/issues/ADAAAA-7770) found the
recorded instants were the *last* frame of a score state rather than the *first*
frame showing the new digits. Every number below is re-measured against the
corrected set; revision-1 numbers are superseded and are listed only in §1a so
the change is auditable.

Every number here is either **measured** (with command, host, artifact path) or
explicitly **not_captured** with its blocker. No fixture number and no soccer
number is carried over as a basketball result.

- branch: `feat/ad-7765-basketball-eval` (registration at `49a4a5f`)
- clip: `clips/bb_q1_1100_1950.mp4` — 850.000000 s, frame-accurate re-encode of
  source 1100-1950 s; source sha256 `480ed20…f74149` (Commons, CC BY 3.0, TBF)
- labels: `evals/basketball_val/audio-labels.json` (15 onsets, 13 negatives),
  derived from `evals/basketball_val/label-manifest.json` **revision 2**
- harness: `evals/measure_audio_recall.py` is pure DSP (ffmpeg decode + numpy
  gate); it needs no GPU. The box job (`livepeer-ai-x99`, `/home/brad/bb-eval-7765`)
  and a local CPU re-run produce **byte-identical** output for the same labels —
  QA verified that on ADAAAA-7770 (`cmp` of the artifacts, same md5). The
  revision-2 numbers were produced by that same local re-run.

## 1. Audio trigger — measured

```
cd /home/brad/bb-eval-7765                     # or any host with the clip + numpy
python3 evals/measure_audio_recall.py \
    --labels evals/basketball_val/audio-labels.json \
    --clip-root clips --profile basketball --json out/audio.json
```

| class | events | candidates | recall | candidate FP rate | onset→fire p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| `score_roar` | 15 | 80 | **0.27 (4/15)** | **0.93 (74/80)** | 0.20 s | **1.90 s** | 1.90 s |

Negative-window false triggers (13 verified non-event windows, 20 s each):

| negative set | windows | windows with ≥1 fire | window FP rate | fires |
|---|---|---|---|---|
| all | 13 | 8 | 0.62 | 19 |
| `live_play_no_score` (hard negatives) | 7 | **7** | **1.00** | 17 |
| `dead_ball` (stoppages) | 6 | 1 | 0.17 | 2 |

Trigger volume: 80 candidates / 14.17 min = **5.6 candidates per minute**;
threshold id `stageA/burst/1.3x/0.3s` (the profile's unchanged default).

Artifact: `out/audio.json`, md5 `151192a9dd67dc2342b320b389cb3a75`
(a repeat run produced the same md5, so the job is deterministic for this clip).

## 1a. Correction applied in revision 2

QA re-read three scoring instants and found the overlay already carried the new
digits one frame earlier, so it flagged the timing as a ≤1 s grid effect. A full
re-derivation of the score timeline shows the error is larger and systematic:

- the score band (`x 610-752`, `y 644-674` of the 1280x720 frame) was cropped at
  1 fps for the whole clip and classified by template match against **16 score
  states**, each read from the pixels at native resolution (11-8, 13-8, 14-8,
  15-8, 15-9, 15-10, 17-10, 17-11, 17-13, 17-14, 17-15, 19-15, 20-15, 20-17,
  20-20, 22-20). The per-second assignment is unambiguous across all 850 frames
  (no flicker: 16 runs, 15 transitions).
- revision 1 placed each event instant at the **end** of the score state it
  named, so instants were 4-205 s late (lateness tracks the length of the state
  each one named: min 4 s at `17-13 -> 17-14`, max 205 s at
  `19-15 -> 20-15`), and the final transition (20-20 → 22-20 at
  clip t=808 s) was missing entirely: revision 1 had 14 events, the pixels have
  **15**.
- the non-event window `score` strings were stale for the same reason and are now
  derived from the state intervals. **No non-event window contains a scoring
  transition**, so the negative-window FP measurement is unaffected (it is
  identical to revision 1).
- every event window's `t_start/t_end` still bracket the corrected instant
  (−5 s/+10 s), and the instant is now the first 1 fps frame whose digits show
  the new score. The ±1 s grid bound in the manifest is unchanged.

Sensitivity (the point of the correction: is the verdict an artefact of label
timing?). The fire list is fixed by the gate, so recall/FP were re-scored against
the same 15 verified onsets with a wider pre-window:

| label tolerance (pre/post) | recall | candidate FP rate |
|---|---|---|
| −3 s / +2 s (harness default, reported above) | 0.27 | 0.93 |
| −5 s / +2 s | 0.53 | 0.85 |
| −6 s / +2 s | 0.67 | 0.81 |
| −10 s / +2 s | 0.87 | 0.76 |

Reproduce a row with `--match-pre` (e.g. `--match-pre 5`): the flag now
overrides the manifest's `matchPre` and states the override on stderr
(ADAAAA-7772 — before that fix the manifest key shadowed the flag, so every
row came back as the −3 s baseline and the sweep looked unsupported).

So a generous label tolerance can recover most of the recall — the crowd noise
does precede the overlay update by a few seconds — but the candidate FP rate
never gets close to the ceiling even at ±10 s. The revision-1 figure
(recall 0.43 at FP 0.88) sat inside this band; it was not wrong about the
verdict, only about the timing of the labels.

## 1b. Reading, and the stated FP-rate ceiling for basketball

The corpus-wide audio defaults are **not a viable operating point for
basketball**. Two independent facts:

1. Candidate FP rate 0.93 — 74 of 80 candidates are not within −3 s/+2 s of a
   verified scoring instant. Since `decide` runs on survivors, 5.6 candidates/min
   means the Gemma decision path would be invoked ~80 times per 14 min of play.
2. Every live-play negative window fired (7/7). The broadband burst gate is
   reacting to continuous arena noise (crowd, sneakers, PA), not to scoring
   events. Only dead-ball windows were quiet enough to stay below it.

Recall 0.27 at that FP rate also rules out "just make it more sensitive": the
gate is already over-firing, so the missing events are not a threshold that a
single knob can recover — and at a ±10 s label tolerance, where recall reaches
0.87, the FP rate is still 0.76. Basketball needs a different trigger
composition (or a corroboration gate) before it is enabled for the type, which is
explicitly out of scope here.

**Stated FP-rate ceiling for basketball (justified by the measurement).** The
apples-to-apples reference on the same harness is soccer's reproducible operating
point at `stageA/burst/1.3x/0.3s`: recall 0.875, candidate FP rate 0.0952
([ADAAAA-7674](https://agent.ad-astra.network/ADAAAA/issues/ADAAAA-7674)).
Basketball is judged against the same **candidate FP rate ceiling of ≤ 0.10**,
i.e. the type may not fire on more than one candidate in ten, because that is the
rate at which the survivor budget the loop was priced on still holds.

Measured: **0.93 — 9.3× over the ceiling.** Secondary (no soccer benchmark exists
for it): trigger-window FP rate must be ≤ 0.20 on live-play negatives; measured
1.00 (7/7). Both fail, so the ceiling is recorded as **not met**, and no
basketball deployment/UI enablement may follow from this pass.

The INC-9 36.7% noise-trigger FP figure is deliberately not used as a bar: it
predates ADAAAA-7108 and QA confirmed on
[ADAAAA-7755](https://agent.ad-astra.network/ADAAAA/issues/ADAAAA-7755) that it
is not reproducible from HEAD.

## 2. Detection precision — `not_captured`

`evals/detect_precision.py --backend florence --profile basketball` was **not**
run. It needs a frame-level held-out slice in the `DetectionTrainingSample`
contract (per-frame `player` / `hoop` / `basketball` boxes with an image on the
box). No such slice was labelled for basketball: the committed set labels scoring
windows, not detection boxes, so `evalSet.vocabulary = ("score",)` and
`reference["detectionSlice"]` is `null`.

Blocker: **no pixel-verified frame-level detection labels for basketball.**
A local `--backend fixture` invocation was exercised only to confirm the profile
resolves; those fixture numbers are harness accounting and are **not** a
basketball result (AC9).

## 3. Live detection latency (event-to-flag, inclusive of preprocess/transfer) — `not_captured`

No live capture job ran in this pass, so there is no event-to-flag trace to
report against the 1-5 s budget. The audio-path component that did run measured
onset→fire p95 1.90 s, but that is not the inclusive live latency and must not be
quoted as one.

Blocker: no live session was captured on a basketball stream; a live trace needs
a served-path run, which this issue explicitly excludes (deployment is not in
scope).

## 4. Tracking — `not_captured`

`evals/track_metrics.py --profile basketball` resolves (the strict
`load_game_profile` KeyError is gone) but was **not** measured on a basketball
track manifest: the tracker harness needs per-frame labeled object identities and
boxes, and no basketball track manifest exists. Running it against the soccer
`sport=soccer` manifest would be a re-used soccer number, so it was not done as a
basketball result.

Blocker: **no basketball track manifest (per-frame identity labels).**

## 5. VOD depth (`D_detail` vs the +10% relative out-depth bar) — `not_captured`

`evals/metrics_runner.py --vod/--live` needs a paired VOD and live trace of the
same window. No live trace exists (see §3), so no pair can be formed.

Blocker: no live trace to pair the VOD trace against.

## Coverage actually achieved (Stage 1)

| floor | required | achieved |
|---|---|---|
| clip length | ≥ 5 min real broadcast play | **850 s (14 min 10 s)**, one continuous feed: Q1 from the clip start through the Q1/Q2 break into early Q2 (period flag `1.Ç` until clip ≈660 s, `2.Ç` after) |
| scoring events | ≥ 8 verified | **15** (score-digit verified, revision 2) |
| non-event windows | ≥ 10 verified | **13** (7 live-play, 6 dead-ball) |
| rights basis | owned/CC-BY/PD/partner | **CC BY 3.0** (TBF via Wikimedia Commons) |

One clip only. The clip span, not the whole 104-min match, is catalogued; that is
the coverage claimed here.

## QA certification

- Label revision 1: certified on ADAAAA-7770 (PASS, with two label-hygiene notes).
- Label revision 2: certified on ADAAAA-7772 (**PASS — measurement true, ceiling
  still missed**). QA re-derived the instants with an independent 30 fps glyph
  sweep (15/15 satisfy `t-1 < change <= t`), reproduced the harness result
  byte-for-byte, and reproduced the whole sensitivity table. `qaCertification` in
  `services/perceive/app/game_profile.py` now records that verdict.
- QA's two documentation items are fixed in this revision of the file: the
  revision-1 lateness range is stated as 4-205 s (it was written as 7-69 s), and
  `--match-pre` now overrides the manifest's `matchPre` (it was silently inert,
  which is what made the sensitivity table look unsupported to a reviewer).
- A PASS certifies the measurement, not the type. Candidate FP rate 0.93 against
  the ≤ 0.10 ceiling means basketball stays disabled; enablement is a gated
  follow-on with its own costed issue.

