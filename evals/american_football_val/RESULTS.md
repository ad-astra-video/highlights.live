# American football measurement results — ADAAAA-7767 (per-type step 2)

Every number here is either **measured** (command, host, artifact path) or
explicitly **not_captured** with its blocker. No fixture number, no synthetic
number, and no soccer/basketball number is carried over as an american-football
result.

- branch: `feat/adaaa-7767-american-football-eval`
- clip: `af_belmont_vs_westford_092123.mp4` — 8391.232 s, 854x480, h264+aac,
  sha256 `ad12b10b…6df1aeb` (Internet Archive
  `snafuinfinityfootball_092123-vs-westford`, **CC0 1.0**, producer/uploader
  Belmont Media Center). One continuous community-access broadcast of one
  varsity game (Belmont HS Marauders vs Westford, 2023-09-21) with commentary,
  crowd and PA audio. The clip is a box-side clip-root artifact, not committed
  to the repo (817,579,377 bytes).
- labels: `evals/american_football_val/label-manifest.json` — **11 verified
  scoring plays**, **14 score-stable non-event windows**, read from the pixels
  only (the broadcast score bug at 1 fps, bracketed to a stated instant).
- rights record: `evals/american_football_val/RIGHTS-SEARCH.md` +
  `rights-candidates.json` (reproducible via `scan_rights_candidates.py`).

## 1. Audio trigger — measured

```
python3 evals/measure_audio_recall.py \
    --labels evals/american_football_val/audio-labels.json \
    --clip-root <dir holding af_belmont_vs_westford_092123.mp4> \
    --profile "american football" --json out/af_audio.json
```

The harness resolves each class's `clip` name against `--clip-root`, so the
archived download `football_092123-vs-westford.mp4` must be present (or
symlinked) under the manifest's name, `af_belmont_vs_westford_092123.mp4`; a
plain copy under the archive filename dies on a missing clip.

Pure DSP (ffmpeg decode + numpy gate): no GPU is involved, and the box-side and
local CPU runs are byte-identical for the same labels (basketball verified that
on [ADAAAA-7770](/ADAAAA/issues/ADAAAA-7770)). This pass therefore measured on
local CPU over the same clip and did not spend a GPU job on a rule that cannot
use one.

| class | events | candidates | recall | candidate FP rate | onset→fire p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| `score_roar` | 11 | **1979** | **1.00 (11/11)** | **0.9853 (1950/1979)** | 0.20 s | 0.50 s | 1.90 s |

Trigger volume: 1979 candidates / 139.9 min = **14.2 candidates per minute**
(threshold id `stageA/burst/1.3x/0.3s` — the profile's unchanged default).

Non-event windows (14 verified score-stable windows, 24 s each):

| negative set | windows | windows with ≥1 fire | window FP rate | fires |
|---|---|---|---|---|
| all | 14 | **14** | **1.00** | 87 |
| `score_stable_no_score` | 13 | 13 | **1.00** | 79 |
| `score_stable_no_score_end_of_game` | 1 | 1 | 1.00 | 8 |

Window content classes are deliberately NOT claimed: the windows are verified
**score-stable** (the score bug shows no transition across the window at 1 fps),
which is the property the FP rate needs. Whether a given window is a huddle, a
replay or live play was not frame-classified in this pass, so the class names
say what was actually verified rather than guessing.

Artifact: `out/af_audio.json`, md5 `34c5baacb62b160c1b9f094de45e904f`
(label revision 2 — see §8 for the E09 correction and the re-run that re-pinned it).

### 1a. Label-tolerance sensitivity

The score bug is updated by the host operator a few seconds after the play, so
the instant is the bug update, not the snap. Re-scoring the same fire list
against the same 11 verified onsets with a wider match window:

| label tolerance (pre/post) | recall | candidate FP rate |
|---|---|---|
| −3 s / +2 s (harness default) | 0.91 (10/11) | 0.9919 |
| −6 s / +3 s (reported above, chosen for the operator lag) | **1.00** | **0.9853** |
| −10 s / +5 s | 1.00 | 0.9778 |

Recall is timing-sensitive; **the FP rate is not**. A generous window buys
recall but leaves the gate firing on essentially everything.

## 1b. Reading, and the stated FP-rate ceiling for american football

The corpus-wide audio defaults are **not a viable operating point for american
football**, and the failure is the one the issue predicted:

1. **Candidate FP rate 0.99.** 1950 of 1979 candidates are not within −6 s/+3 s
   of a verified scoring play. `decide` runs on survivors, so 14 candidates per
   minute means the Gemma decision path would be invoked ~2000 times per game.
2. **Every non-event window fired (14/14), including all 13 live-play windows.**
   The broadband burst gate is reacting to the sustained crowd/commentary bed
   that never returns to a quiet baseline on a football feed. This is exactly
   the "continuous crowd noise" risk the issue names for this type.
3. Recall is already 1.00 at the gate's unchanged defaults, so the problem is
   not sensitivity — there is no threshold that both keeps this recall and gets
   near the ceiling.

**Stated FP-rate ceiling for american football (justified by this measurement):
a candidate FP rate of ≤ 0.10, the same ceiling the soccer reference meets.**
Measured: **0.9853 — missed by ~10x**. The apples-to-apples reference on the
same harness is soccer at recall 0.875 / candidate FP 0.0952 at
`stageA/burst/1.3x/0.3s` ([ADAAAA-7674](/ADAAAA/issues/ADAAAA-7674)). INC-9's
36.7% is **not** used: QA on [ADAAAA-7755](/ADAAAA/issues/ADAAAA-7755) confirmed
it is not reproducible from HEAD.

## 2. Which trigger carries this type — the finding the CEO needs

**Audio alone does not carry american football.** Measured: recall 1.00 at a
candidate FP rate of 0.9853 and 14.2 candidates/minute on a rights-cleared full
game. That is a ~10x miss of the stated ceiling, and widening the label window
±10 s moves the FP rate to only 0.9778, so no label-timing artefact explains it.

**Motion alone: `not_captured`.** The motion trigger
(`services/perceive/app/stage_a.py::motion_fire`, `MOTION_MIN_STEP = 0.15`
normalized peak single-step displacement) runs off `IoUTracker` track steps,
which need florence detections. This pass produced no frame-level detection
slice, so there is no track manifest and no track-step stream to score the
motion path against. Reporting a frame-difference proxy as the motion trigger's
recall would be a different measurement wearing the trigger's name, so it is
not reported.

**Therefore: the type is not shippable on measured evidence.** Audio is measured
and unusable; motion — the only remaining trigger for a `no-zone` type — is
unmeasured. The decisive next measurement is a bounded box job that produces
florence detections + track steps on this clip so `motion_fire` recall and
trigger volume can be scored against the same 11 onsets and 14 windows. That is
a follow-on, not part of this pass, and it must not be reported as done until it
runs.

The inert `detection-in-zone` trigger is **not** reported as a defect: with
`zoneModel: no-zone` it is dropped at construction by contract (see §4).

## 3. The score bug is not an oracle

The bug displayed **Westford 14** for the whole of half time (first read at
t=3800) and **13** in every third-quarter read. The +2 entry at t≈3796 was
corrected by the operator before the third quarter. Recorded rather than
silently repaired, because it bears directly on the gated corroboration-oracle
follow-on: **scoreboard OCR is not a trustworthy corroboration seam on
community-access football** as it stands. The profile therefore registers
`corroboration_oracle=None`.

## 4. Profile registration — measured

`services/perceive/app/game_profile.py`:

- `AMERICAN_FOOTBALL_PROFILE` registered under **`american football`** and, as
  the *same object*, under **`football`**, so the legacy hint can never resolve
  to an unmeasured duplicate.
- `zoneModel: no-zone`; the detection-in-zone trigger is dropped at
  construction (`GameProfile.__post_init__`), and forcing it back in via
  `with_triggers(...)` is still auto-disabled (tested).
- trigger subset: `motion` + `audio`; audio thresholds are the corpus-wide
  defaults, recorded as the measured baseline (untuned).
- `evalSet` = the committed manifest; `evalSet.vocabulary = ("score",)` (the
  scoring-window class that was labelled — *not* the deployed detection roster,
  matching the basketball precedent).
- deployed per-frame vocabulary unchanged (`football`, `player`, `referee`), so
  registration cannot change what the detector looks for.
- tracking roster caps hold: 3 live / 8 VOD.

Verified:

```
cd services/perceive && python3 -m pytest tests/test_game_profile.py -q
# 27 passed
```

including three new tests: registration + both-spellings identity, no-zone
construction behaviour, and a drift guard that the registered numbers equal the
committed labels' numbers.

## 5. Detection, tracking, latency, VOD depth — `not_captured`

| rule | command | verdict |
|---|---|---|
| detection precision/recall | `evals/detect_precision.py --backend florence --profile "american football"` | **`not_captured`** — blocker: `no frame-level detection slice`. `detect_val.jsonl` cannot be produced from window labels; it needs per-frame object boxes, which this pass did not annotate. The harness correctly refuses to run without `--val`, and no `--backend fixture` run was made, so no fixture number can be mistaken for a result. |
| tracking 3 live / 8 VOD, ID persistence, IoU | `evals/track_metrics.py <af track manifest> --profile "american football" --drop 0` | **`not_captured`** — blocker: `no american-football track manifest`. The soccer manifest was not re-scored and is not presented as football. |
| live latency p95 event→flag (1–5 s budget) | bounded box job | **`not_captured`** — blocker: `no GPU run`. No box job was started, so no spend was incurred. Note the 22-player frames are the interesting case for the 3-object live cap; that question stays open until the tracker pass runs. |
| VOD depth `D_detail` vs +10% bar | `evals/metrics_runner.py --vod/--live` | **`not_captured`** — no paired traces could be captured without a clip run. |

## 6. Rights basis (hard gate)

`CC0 1.0`, producer and uploader both Belmont Media Center (community-access
station publishing its own broadcast). The scan (`rights-candidates.json`)
screened 616 metadata rows, kept 79 american-football candidates and found 21
clearing licence + duration; the Belmont games are the only ones that are also
continuous game play with a real audio bed. Full record and the rejected
candidates are in `RIGHTS-SEARCH.md`.

Two rights-relevant rejections worth naming: the FOX Sports college-football
"highlights" uploads on Commons are CC BY 3.0 but are 240-272 s reels (below the
5-minute floor and carrying no comparable non-event windows), and the
`cornhuskercollection_volume3` CC0 item is a 1986 commercial Instant Replay Inc.
VHS release whose CC0 claim was made by a third-party uploader, not the rights
holder.

## 7. What was actually run

```
python3 evals/american_football_val/scan_rights_candidates.py \
    --out evals/american_football_val/rights-candidates.json      # exit 0, 0 errors
python3 evals/measure_audio_recall.py --labels evals/american_football_val/audio-labels.json \
    --clip-root <clip dir> --profile "american football" --json out/af_audio.json
python3 evals/measure_audio_recall.py ... --match-pre 3 --match-post 2   # sensitivity row
python3 evals/measure_audio_recall.py ... --match-pre 10 --match-post 5  # sensitivity row
cd services/perceive && python3 -m pytest tests/test_game_profile.py -q  # 27 passed
```

Nothing was deployed, no served path changed, and no GPU job was started.

## 8. Label revision 2 — the E09 correction (QA [ADAAAA-7784](/ADAAAA/issues/ADAAAA-7784))

QA re-certification returned **FAIL on exactly one clause** and reproduced
everything else byte-identically: the **E09** scoring bracket contained no score
transition. E09 was recorded at `instant 7412`, `bracket [7405,7420]`; the score
bug actually flips `14-19 → 14-25` at **t=7401**, four seconds before that
bracket opened. The bracket looked derived from the play rather than the pixels.

Re-verified independently for this correction (native 1 fps frames of the
score-bug band at t=7395/7398/7400/7401/7402/7404/7406/7410/7412/7420/7425):
Belmont stays 14 throughout; Westford reads **19 at 7395/7398/7400** and **25
from 7401 onward**, unchanged through 7425. Transition = **7401**, bracket
`[7400,7402]`, play window `[7391,7412]`.

What changed in revision 2 and what did not:

- `label-manifest.json` E09: `instant 7412 → 7401`, `bracket [7405,7420] →
  [7400,7402]`, `t_start/t_end 7402/7423 → 7391/7412`, evidence rewritten to the
  frames actually read; `confidence_s 8 → 1`. No other label touched.
- `audio-labels.json` `score_roar` onset `7412 → 7401` (onsets follow the
  manifest by contract; the drift-guard test enforces it).
- Re-ran the harness on the same clip (`sha256 ad12b10b…6df1aeb`) at all three
  tolerances. Candidate count is unchanged at **1979**; the fire list is
  identical, so recall, FP rate and p50/p95 keep their substance:

| tolerance | recall | candidate FP rate |
|---|---|---|
| −3 s/+2 s | 0.91 (10/11) | 0.9919 |
| −6 s/+3 s | **1.00 (11/11)** | **0.9853 (1950/1979)** |
| −10 s/+5 s | 1.00 (11/11) | 0.9778 |

  p50 0.20 s / p95 0.50 s / max 1.90 s unchanged; all 14 non-event windows still
  fire (87 fires). New artifact md5
  `34c5baacb62b160c1b9f094de45e904f` (was `06ffc8ba…`).
- **The finding does not move**: audio recall 1.00 at candidate FP 0.9853, ~10x
  the 0.10 ceiling, and motion still `not_captured`. The label fix shifts the FP
  count by one candidate (1951 → 1950) and nothing else.

## 9. Remaining work, and who owns it

- **Motion/tracker pass (the decisive number).** Bounded box job on
  `livepeer-ai-x99`: florence detections on this clip → track steps →
  `motion_fire` recall/volume against the same 11 onsets and 14 windows, plus
  `track_metrics.py` for the 3 live / 8 VOD caps. Owner: Developer, as a
  costed follow-on.
- **Detection slice.** Label a bounded frame-level box slice (player/referee/
  football) so `detect_precision.py --backend florence` has a label space.
  Owner: Developer.
- **Do not enable the operator UI for american football** until the motion
  number exists and QA certifies it.
