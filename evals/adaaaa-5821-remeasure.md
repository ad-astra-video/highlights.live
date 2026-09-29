# ADAAAA-5821 — decisive re-measurement: recommendation (a) is disproven on real data

Author: Developer (agent) · Date: 2026-09-29 · Context: follow-up to the INC-5
finding (ADAAAA-5821) that the notable-only gate lets negatives surface as GOAL.

## Headline

The finding's recommended fix — **"require reaction/crowd audio evidence for
GOAL-class candidates on the decide path"** — is **not implementable in the way
it is stated**, and implementing it literally would crater recall below the
accepted bar. The premise the recommendation rests on is a manifest
ground-truth label, **not** the evidence the decide gate actually receives.

## Data integrity correction

The finding states: *"negatives have `reaction.audioKind=""` / `crowdEnergy=0.0`,
while every true highlight phase is labeled `reaction.audio=true`."*

That `reaction.audio=true` for true phases comes from **`evals/label-manifest.json`
ground-truth labels, not from the decide input**. In the authoritative recorded
decide trace `evals/adaaaa5811-l2-decide-trace.jsonl` (fetched from livepeer-ai-x99,
md5 `3d1300f7c162777da3d93901494b657d`, 44 candidates / 12 clips), the `reaction`
block the gate saw has **`audioKind=""` and `crowdEnergy=0.0` for every row —
true AND false** (see the table below). The INC-5 eval drive sent no audio
reaction into decide.

| phase          | manifest GT `reaction.audio` | decide-trace `audioKind` | decide-trace `crowdEnergy` |
|----------------|------------------------------|--------------------------|----------------------------|
| goal (18)      | True                         | ""                       | 0.0                        |
| near_goal (5)  | True                         | ""                       | 0.0                        |
| off_target (8) | False                        | ""                       | 0.0                        |
| warm_up (7)    | False                        | ""                       | 0.0                        |
| lull (4)       | commentary                   | ""                       | 0.0                        |
| replay (2)     | False                        | ""                       | 0.0                        |

So on the recorded trace, **requiring audio reaction for GOAL rejects everything
(recall → 0%)**, because no candidate carries an audio signal. That is a trivial,
meaningless test of the idea — the trace was stripped of the very signal the
recommendation wants to gate on.

## Honest re-measure from real clip audio

The production pipeline derives `crowdEnergy`/`audioKind` from the clip's actual
audio (`buildReactionEvidence`: `candidate.audio.peakEnergy`/`kind`). The clips
that produced the trace are present on livepeer-ai-x99, so I re-derived the
**honest audio-reaction signal** from each clip around each candidate timestamp
(ffmpeg `volumedetect`, same `crowd_energy_from_audio` logic as `evals/drive_inc8.py`)
and re-gated. Result (44 candidates / 12 clips):

| rule (surface GOAL only if …)        | TP | FP | TN | FN | recall% | precision% | reject% |
|--------------------------------------|----|----|----|----|---------|------------|---------|
| current deployed gate                | 23 | 21 |  0 |  0 | 100.0   | 52.3       | 48      |
| audio reaction (`ce>0 or kind!=""`)  |  9 |  7 | 14 | 14 | **39.1**| 56.2       | 48      |
| audio OR ball-in-goal-mouth          | 16 | 10 | 11 |  7 | 69.6    | 61.5       | 48      |
| audio OR score ≥ 90                  | 19 | 20 |  1 |  4 | 82.6    | 48.7       | 48      |

Real audio **does not separate** the classes on this eval set: only 9/23 true rows
have an audio reaction, and 7/21 false rows ALSO have one. Requiring it collapses
recall to 39% — below the 85% accepted bar — and rejects 14 real highlights.

## Why neither the bar nor a gate predicate can fix this set

The labeled negatives are **signal-identical in-zone near-miss plays**: they are
emitted as `eventType=GOAL` with `gemma_score≈95` (upstream over-classification),
carry the same `humansInMotion` (always true in a soccer frame), and the audio
signal does not discriminate when honestly measured. No decide-layer predicate is
Pareto-better than the current operating point, and tuning the bar is flat
(high-value GOAL passes unconditionally). This confirms the already-committed
`evals/discernment-frontier-analysis.md` conclusion: **this is a signal/data
problem, not a decide-threshold bug.**

## Corrected scope for the actual fix

1. **Do NOT implement (a) as stated** (audio-reaction requirement for GOAL):
   not only is it unexplained by this data, applying it to the real signal
   destroys recall. The gate already covers the one scenario (bare trigger with
   zero corroboration) where it is genuinely effective.
2. **Root cause is upstream event classification**: off_target / warm_up /
   commentary_lull / replay are being emitted as `GOAL`. The unblock is a
   perceive-side **ball-outcome / scoring-event signal** (did the ball actually
   cross the line), which is the ADAAAA-5772 umbrella. Reclassifying negatives as
   ordinary-class alone would NOT reject them either (their gemma score 95 still
   clears the ordinary bar 60).
3. The decide gate, with current signals, **cannot** satisfy "no negative phase
   surfaces a highlight" on this eval set. That acceptance must either be
   re-scoped in the eval (negatives not emitted as GOAL) or gated on the
   ball-outcome signal once it exists.

## Repro

- `python3 evals/adaaaa-5821-remeasure.py` (on livepeer-ai-x99, where clips live)
- Trace: `evals/adaaaa5811-l2-decide-trace.jsonl`
