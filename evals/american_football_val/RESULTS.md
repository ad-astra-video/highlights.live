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
- Run artifacts are committed under `evals/american_football_val/run/` so the
  re-certification can diff instead of only re-running:
  `af_audio.json` (reported −6/+3 run, md5 `34c5baac…e904f`),
  `af_audio_default.json` (−3/+2, md5 `2ae7ff17…d9df0`),
  `af_audio_generous.json` (−10/+5, md5 `bb2369bb…64c26e`).

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

## 10. Certification of label revision 2 (QA [ADAAAA-7785](/ADAAAA/issues/ADAAAA-7785))

Re-certification returned **PASS on 5/5 clauses** (local CPU, no box job, no
claim of one). What it independently confirmed on head `b9e53ee`:

| clause | verdict |
|---|---|
| E09 bracket holds its transition | PASS - decoded 1,190 native 29.97 fps frames; Westford flips 19 -> 25 at pts 7400.7934 and reads 25 continuously to 7429.489; Belmont reads 14 in every frame. `instant 7401` is that flip rounded up, `bracket [7400,7402]` contains it. |
| only E09 moved | PASS - `git diff b991422 6b2a2d2` on the two label files is exactly two hunks (E09 + the ninth `score_roar` onset); 11 scoring entries and 14 non-event windows unchanged. |
| harness reproduces byte-identically | PASS - all three tolerance runs `cmp`-identical to the artifacts committed under `run/` (`34c5baac…e904f`, `2ae7ff17…d9df0`, `bb2369bb…64c26e`), not merely numerically equal. |
| drift guard and honesty | PASS - `pytest tests/test_game_profile.py -q` 27 passed; no fixture/synthetic/soccer number presented as football. |
| the finding is unchanged | PASS - recall 1.00 at candidate FP 0.9853 is a 9.85x miss of the 0.10 ceiling. |

So the measurement is certified and the type's `qaCertification` reads
`pass (ADAAAA-7785, label revision 2)` in `game_profile.py`, with
`qaVerdict: measurement true; fpCeilingMet false`. **Certified measurement is not
enablement**: american football stays disabled for the operator UI until the
motion number in section 9 exists and is itself certified.

## 11. Motion trigger — measured (ADAAAA-7788)

`motion_fire` was `not_captured` in section 1b. It is measured now, on the same
label manifest (label revision 2: the same 11 onsets and the same 14 non-event
windows the audio rule was scored on) and on the same sha256-verified clip.

### 11.1 The bounded job (what ran, what it cost)

| item | value |
|---|---|
| approved envelope | `<= 35 GPU-minutes`, 569 frames, one pass, no sweeps (CEO approval `77972ad0`) |
| windows decoded | 25 of 25 manifest windows (11 scoring 21-23 s, 14 non-event 24 s) = 569 s |
| frames | **569** at 1 fps (6.78% of the 8391 s clip; no whole-game pass) |
| host | `livepeer-ai-x99`, RTX 3090 Ti GPU 0, inside the deployed perceive image `adastravideo/highlights-live:perceive-7707` |
| detector | deployed `FLORENCE_MODEL=/runs/Florence-2-base-finetuned-ft6404gpu`, `cuda:0`, vocabulary `[football, player, referee]` |
| clip | `af_belmont_vs_westford_092123.mp4`, sha256 `ad12b10b…6df1aeb` re-verified on the box before decoding |
| measured latency | **364.0 ms/frame** mean, 212.7 s wall = **3.5 GPU-minutes** |
| repeat pass (determinism) | 569/569 frames produced **identical boxes and scores** (213.2 ms/frame, 3.1 GPU-min); the file md5 differs only in the `latency` block |
| total spend | **~6.6 of the approved 35 GPU-minutes** |

Runtime note (environment, not a harness change): the perceive image ships no
`ffmpeg`, so the window decoder is a static `ffmpeg 7.0.2` binary mounted
read-only at `/opt/ffbin` and prepended to `PATH` inside the container. The
harness itself is unmodified at commit `0c45064`.

```
python3 evals/detect_slice_from_windows.py \
    --labels evals/american_football_val/label-manifest.json \
    --clip-root /clips --profile "american football" --fps 1 \
    --max-frames 569 --budget-gpu-minutes 35 --out /out/af_detect_slice.json

python3 evals/measure_motion_recall.py \
    --slice /out/af_detect_slice.json \
    --labels evals/american_football_val/label-manifest.json \
    --profile "american football" --mode vod --json /out/af_motion_vod.json
```

### 11.2 The two triggers, side by side at the same label tolerance (-6 / +3 s)

| trigger | candidates | denominator | recall | candidate FP rate | candidate FP rate / 0.10 ceiling | non-event windows firing | onset p50 | p95 |
|---|---|---|---|---|---|---|---|---|
| `score_roar` (audio) | 1979 | whole clip (8391 s) | 1.00 (11/11) | **0.9853** (1950/1979) | 9.85x | **14/14** | +0.20 s | +0.50 s |
| `MOVE` (motion, cap 8) | 435 | the 25 manifest windows (569 s = 6.78% of the clip) | 1.00 (11/11) | **0.7931** (345/435) | 7.93x | **14/14** | -6.00 s | +3.00 s |

**The denominators differ and are not interchangeable.** Audio's 1979 candidates
come from decoding the whole clip; motion's 435 come from the 6.78% stratified
window sample the approved envelope bought. The artifact records that share
(`candidateSpace.stratifiedSample = 0.06781`) next to every number, and the
whole-clip motion pass (8391 frames, 14.7x this envelope) was **not** approved
and was not run.

Motion is scored at the harness default (-3/+2) and at both audio tolerances so
the pair is comparable at the same setting:

| motion label tolerance | recall | candidate FP rate | onset p50 | p95 |
|---|---|---|---|---|
| -3 / +2 (manifest default) | 0.91 (10/11) | 0.8644 (376/435) | -3.00 s | +2.00 s |
| **-6 / +3 (audio's headline)** | **1.00 (11/11)** | **0.7931 (345/435)** | -6.00 s | +3.00 s |
| -10 / +5 (audio's generous) | 1.00 (11/11) | 0.7195 (313/435) | -7.00 s | +3.00 s |

### 11.3 Why the motion recall is not a real detection of the event

`motion_fire` is on for **435 of 569 frames (76.4%)**, in every window
(per-window fires: 8-21 of 21-24 frames), and every one of the 14 non-event
windows fires (256 fires). The onset latency is at the **pre-window edge**
(-6.00 s p50), i.e. the rule is already firing when the window opens, so a
"hit" is whatever fire happens to sit inside the tolerance — not a fire caused
by the scoring play.

The cause is a cadence mismatch, and it is a property of the deployed
operating point rather than a defect in this harness: `MOTION_MIN_STEP = 0.15`
is a *per-step* displacement threshold tuned for live steps of ~0.2 s, while
this measurement steps at 1 fps (the deployed VOD detection cap). Over a 1 s
step a player running 10 m/s in a 50 m frame moves ~0.2 of frame width, so
0.15 is tripped by ordinary play. Peak single-step displacement was
**0.218-0.6975** in every VOD window, including every negative (the live cap-3
slice bottoms out slightly lower at 0.1855; the VOD rows are the ones behind the
numbers in 11.2). Wide-open thresholds are not a
tuning exercise this issue may take (threshold sweeps are out of scope), so the
number is reported as measured at the shipped operating point.

### 11.4 Tracking caps — 3 live / 8 VOD on this clip

`--mode` selects the profile's roster capacity; both were scored from the same
slice.

| mode | cap | frames at cap | detections dropped (`unkept`) | max concurrent tracks | objects/frame max |
|---|---|---|---|---|---|
| VOD | **8** | 129 / 569 (22.7%) | **0 of 1071** | 8 | 6 |
| live | **3** | 440 / 569 (77.3%) | **30 of 1071 (2.8%)** | 3 | 6 |

So at VOD the 8-object roster never drops a detection on this clip; at live the
3-object roster is saturated on 77% of frames and drops ~2.8% of detections,
which also degrades recall (the team-sport case the charter expects).

**The 22-player case is `not_captured`.** The deployed detector tops out at
**6 boxes/frame** on this clip at 854x480 (mean 1.9), so no 22-player frame
exists in this slice and "what the cap keeps on a 22-player frame" cannot be
answered from it. Stating a 22-player number here would require a
native-resolution window, which this envelope did not buy.

**ID persistence and IoU are `not_captured`.** `evals/track_metrics.py` needs a
ground-truth track manifest (per-frame identity labels); american football has
none, and feeding these detections back in as "labels" would score the tracker
against its own input — which the harness refuses to do by construction. The
blocker is named in section 11.6 and owned.

### 11.5 Verdict — which trigger carries american football

**Neither.** At the same label tolerance both rules recall the event set and both
miss the stated 0.10 candidate-FP ceiling by an order of magnitude: audio
**0.9853** (9.85x the ceiling, whole-clip denominator) and motion **0.7931**
(7.93x the ceiling, window-scoped denominator). No surviving subset meets 0.10,
and the detection-in-zone trigger does not exist for this type (`zoneModel:
no-zone`). Motion is the only trigger left and it is saturated, so:

- **american football stays disabled for the operator UI.**
- `measured` for the type remains a statement about the *labelled eval set and
  the audio run*; motion is now measured too but does not pass, and its QA
  re-certification landed PASS at `3aaaab1` (`qaCertificationMotion`, AC6).

One finding is worth carrying to the type's next operator decision: the motion
rule as deployed at 1 fps is effectively always-on for football, so its cost is
not "missed highlights" but Stage-B volume — a `MOVE` candidate on 76% of frames
means the expensive decide pass would run on nearly every second.

### 11.6 Artifacts

Committed under `evals/american_football_val/run/` (md5 as fetched from the box):

| artifact | md5 | what it is |
|---|---|---|
| `af_detect_slice.json` | `239fb30d69da86bd30d7b258e400f581` | the 569-frame florence detection slice (windows only) |
| `af_motion_vod.json` | `da5ab15ce08acb81e2c3d2b57d5bb625` | `motion_fire` scored, cap 8, -3/+2 |
| `af_motion_live.json` | `c45e21dd4a8c9d52a7516e679be38a66` | `motion_fire` scored, cap 3, -3/+2 |
| `af_motion_vod_m6_3.json` | `a064adce0016f0fe45ca114da692d9d4` | sensitivity row, -6/+3 |
| `af_motion_vod_m10_5.json` | `dcb2c647fe0d9af9dfdfc7174324a907` | sensitivity row, -10/+5 |

Re-scoring the committed slice is free (no GPU, no decode) and was checked to be
**byte-identical**: the second `measure_motion_recall.py` run over the same slice
produced md5 `da5ab15ce08acb81e2c3d2b57d5bb625` again.

### 11.7 Remaining work (named blockers, owners)

- **GT track slice for ID persistence and IoU (AC4).** Needs a per-frame
  identity-labelled manifest at native resolution (1280x720) over a bounded
  window; owner: Developer, separate costed job.
- **Whole-clip motion denominator.** Only needed if the window-scoped FP rate
  had landed near 0.10 — it landed at 0.79, so the revised proposal is not
  warranted for the ship/no-ship call.
- **QA re-certification of the motion numbers — DONE.** Child of this issue
  assigned to Highlights.live Reviewer ([ADAAAA-7797](/ADAAAA/issues/ADAAAA-7797));
  verdict **PASS on 7/7 clauses** at head `3aaaab1`. Recorded as
  `_AMERICAN_FOOTBALL_EVAL_REFERENCE["qaCertificationMotion"]`; certification is
  not enablement and the ceiling miss stands.
- **Provenance gap QA flagged (non-blocking).** The committed slice records only
  `detector: "cuda:0"`; the weights identity
  (`/runs/Florence-2-base-finetuned-ft6404gpu`) lives in 11.1 and the profile,
  not in the artifact, so it cannot be re-derived on CPU. A future slice run
  should write the model path into the slice document.
