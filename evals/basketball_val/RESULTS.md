# Basketball measurement results — ADAAAA-7765 (per-type step 2)

One bounded harness job was run per rule on the Livepeer box through the
sanctioned Komodo path. Every number below is either **measured** (with the
command, host and artifact path) or explicitly **not_captured** with its blocker.
No fixture number and no soccer number is carried over as a basketball result.

- box: `livepeer-ai-x99` (Komodo target), run directory `/home/brad/bb-eval-7765`
- branch: `feat/ad-7765-basketball-eval` off `origin/master` (3d27607)
- clip: `clips/bb_q1_1100_1950.mp4` — 850.000000 s, frame-accurate re-encode of
  source 1100-1950 s; source sha256 `480ed20…f74149` verified on the box
  (Commons, CC BY 3.0, TBF)
- labels: `evals/basketball_val/audio-labels.json` (14 onsets, 13 negatives),
  derived from `evals/basketball_val/label-manifest.json`

## 1. Audio trigger — measured

```
python3 evals/measure_audio_recall.py \
    --labels evals/basketball_val/audio-labels.json \
    --clip-root clips --profile basketball --json out/audio.json
```

| class | events | candidates | recall | candidate FP rate | onset→fire p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| `score_roar` | 14 | 80 | **0.43 (6/14)** | **0.88 (70/80)** | 0.20 s | **1.90 s** | 1.90 s |

Negative-window false triggers (13 verified non-event windows, 20 s each):

| negative set | windows | windows with ≥1 fire | window FP rate | fires |
|---|---|---|---|---|
| all | 13 | 8 | 0.62 | 19 |
| `live_play_no_score` (hard negatives) | 7 | **7** | **1.00** | 17 |
| `dead_ball` (stoppages) | 6 | 1 | 0.17 | 2 |

Trigger volume: 80 candidates / 14.17 min = **5.6 candidates per minute**;
threshold id `stageA/burst/1.3x/0.3s` (the profile's unchanged default).

Artifact: `/home/brad/bb-eval-7765/out/audio.json`, md5
`8c2991cb0cb2b90d4b51e16707ab1038`. A second identical run produced the same md5
(`out/audio_rerun.json`), so the job is deterministic for this clip.

### Reading

The corpus-wide audio defaults are **not a viable operating point for
basketball**. Two independent facts:

1. Candidate FP rate 0.88 — 70 of 80 candidates are not within ±3 s/−2 s of a
   scoring instant. Since `decide` runs on survivors, 5.6 candidates/min means
   the Gemma decision path would be invoked ~80 times per 14 min of play.
2. Every live-play negative window fired (7/7). The broadband burst gate is
   reacting to continuous arena noise (crowd, sneakers, PA), not to scoring
   events. Only dead-ball windows were quiet enough to stay below it.

Recall 0.43 at that FP rate also rules out "just make it more sensitive": the
gate is already over-firing, so the missing 8 of 14 events are not a threshold
that a single knob can recover without making FP worse. The honest conclusion is
that basketball needs a different trigger composition (or a corroboration gate)
before it is enabled for the type — which is explicitly out of scope here.

### Stated FP-rate ceiling for basketball (justified by the measurement)

The apples-to-apples reference on the same harness is soccer's reproducible
operating point at `stageA/burst/1.3x/0.3s`: recall 0.875, candidate FP rate
0.0952 (ADAAAA-7674). Basketball is judged against the same **candidate FP rate
ceiling of ≤ 0.10**, i.e. the type may not fire on more than one candidate in ten,
because that is the rate at which the survivor budget the loop was priced on
still holds.

Measured: **0.88 — 8.8× over the ceiling.** Secondary (no soccer benchmark
exists for it): trigger-window FP rate must be ≤ 0.20 on live-play negatives;
measured 1.00 (7/7). Both fail, so the ceiling is recorded as **not met**, and no
basketball deployment/UI enablement may follow from this pass.

The INC-9 36.7% noise-trigger FP figure is deliberately not used as a bar: it
predates ADAAAA-7108 and QA confirmed on ADAAAA-7755 that it is not reproducible
from HEAD.

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
onset→fire p95 1.90 s on the box, but that is not the inclusive live latency and
must not be quoted as one.

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
| clip length | ≥ 5 min real broadcast play | **850 s (14 min 10 s)** of Q1 play |
| scoring events | ≥ 8 verified | **14** (score-digit verified) |
| non-event windows | ≥ 10 verified | **13** (7 live-play, 6 dead-ball) |
| rights basis | owned/CC-BY/PD/partner | **CC BY 3.0** (TBF via Wikimedia Commons) |

One clip only. The clip span, not the whole 104-min match, is catalogued; that is
the coverage claimed here.
