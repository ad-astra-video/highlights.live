# ADAAAA-8392 — stage B: 2-cell live eval scored, anchors not verifiable

**Verdict: FAIL (AC6). The lever is closed.** Frame scale 320x180 -> 768x432 at
budget 280 does not clear AC6 on the labels it was bought for, and the two
diagnostics that decide whether the result is interpretable both come back
negative:

| gate | result |
|---|---|
| Task 1 — 34 `cg-g-*` anchors frame-verified by an independent reader | **NOT VERIFIED** — reader unfit (2 protocols, neither clears both control bars) |
| Internal validity — carried 37 windows reproduce ADAAAA-8343 on the control cell | **FAILED** — the deployed decide build changed at 05:04Z, so the control cell is a different baseline |
| AC6 point estimate (no control TP lost, precision >= control, recall >= control) | **FAILED** at every reading: a control TP (`ks-g-0280`) is lost, and on the only frame-verified subset recall drops 7/15 -> 6/15 |

Everything below is `$0`: direct `/v1/chat/completions` to the deployed gemma
replica plus read-only container calls. No `POST /jobs`, no Livepeer spend, no
restart, no env change.

## 1. Corpus actually scored

90 windows x 2 cells = 180 rows, 0 transport errors.

| label class | windows | provenance |
|---|---|---|
| goal | 49 | 15 carried from ADAAAA-8343 (frame-verified, high confidence) + 34 new `cg-g-*` from a Chelsea 2024/25 all-goals compilation (audio-anchored, **frame verification failed — see §2**) |
| no_goal (`shot`) | 10 | carried |
| no_goal (`no_shot`) | 31 | 22 carried + 7 `ks-n2-*` + 12 `cg-n-*` build-ups |

Manifest `label-manifest-8371.json` sha256 `09468a9025dcebf01fbf6e29bbd203b8deb2ec23f7fc9b270922ff26ab4b1994`.
Clips: `kids-soccer.mp4` (778 s, sha256 `420c7e7d…c13e63`), `src_goals.webm`
(3,330 s, sha256 `3b864965…6d778`).

## 2. Task 1 — the 34 compilation goal anchors are NOT verified

Reader: `allenai/Molmo2-4B`, 4-bit NF4 (`bitsandbytes`), GPU1, greedy, 4.87 GiB
allocated / 6.11 GiB peak, 5.2 s load, ~1.0 s/frame. It never calls the deployed
gemma/decide replica. Frames read at `instant-2, instant, instant+2, instant+4`
(the 22 carried `ks-n-*` windows carry no `instant`, so four frames are spread
inside `[t_start, t_end]`). 360 frame reads for 90 windows in 378 s.

The reader answers a decomposed cue question (NET / CELEBRATION / GRAPHIC /
VERDICT) so every verdict is auditable. Two prompt protocols were tried on the
**control set only**; the frozen prompt of record is v1 and v2 is the recorded
second attempt.

| protocol | rule | positive control (bar >=12/15) | negative control (bar >=8/10 not-a-goal) | both bars |
|---|---|---|---|---|
| v1 permissive | any cue | **11/15** | 19/41 windows, first-10 **7/10** | no |
| v1 permissive | net or celebration | 10/15 | 10/41, first-10 **10/10** | no |
| v1 permissive | verdict line only | 11/15 | 19/41, first-10 7/10 | no |
| v1 permissive | celebration only | 8/15 | 7/41, first-10 10/10 | no |
| v2 strict | any cue | **3/15** | 2/41, first-10 9/10 | no |
| v2 strict | net or celebration | 2/15 | 1/41, first-10 10/10 | no |

The failure is bimodal, which is why no threshold tuning is defensible: v1's
permissive cue text lets a *persistent broadcast scoreboard / replay banner*
satisfy `GRAPHIC` (17 cue fires on no_goal windows), so it over-calls
(19/41 false goals) while still missing 4 of 15 real goals; v2's strict wording
suppresses the cue almost entirely (3/15 positives, 2/41 false goals) — a
degenerate "NO" reader. Best simultaneous result in any variant is 10/15
positives with a clean negative gate.

Per the ticket: **no verified manifest was written.** `cg-g-*` labels stay
audio-anchored hypotheses (`confidence: pending-frame-check`), the AC1 bar of
">=40 verified goal windows" is **not** demonstrated, and no window was dropped
or padded to manufacture a count. `reader-verification-8371.json` holds every
tally, the prompts, and the per-window cue record for all 34 anchors.

A next-attempt reader must be frame-grounded in a way this model is not
(scoreboard-digit diff inside each compilation segment; the manifest records that
tesseract returns digit noise on this footage) or a human/board contact-sheet
pass. Perceive is **not** usable: it generates the evidence the eval scores.

## 3. Internal validity — the control cell does not reproduce ADAAAA-8343

The carried 37 windows are byte-identical to the 8343 manifest, so their outcomes
must reproduce. They do not:

| set | ADAAAA-8343 | this run (control cell) |
|---|---|---|
| goal TP | `ks-g-0117, 0341, 0662, 0770` (4/15) | `ks-g-0117, 0280, 0341, 0413, 0662, 0678, 0705` (**7/15**) |
| no_goal FP | `ks-n-0162, 0312, 0402, 0622, 0696, 0760` (6/37) | **exactly the same six** |

Gained TPs: `ks-g-0280, 0413, 0678, 0705`. Lost TP: `ks-g-0770`.

Cause is attributable, not a harness defect — **the deployed decide build moved
under the eval**:

- 8343 ran on decide image `sha256:93f307e91c5ca9b0a3586b65a16ff106c2368262b3bec65027e9b3f3fcd38f03`
  (`/tmp/eval8343/cache/provenance.json`).
- This run ran on `sha256:1c416c3ce1d1eb20358629f6ad6a5ffd72af8cf5a90fd031b7d99a401bdcca6b`,
  built `2026-11-08T05:04:52Z`, container started `05:05:11Z` — after 8343's rows.
- `/srv/decide/app/gemma.py` md5 `3797ff73a476d620d5762d395a199f04` = the file at
  commit `e82c5ff` (`fix(decide,events,server)(ADAAAA-8356)`), not HEAD `3287af5`.
- Effect on the prompt: compact live system prompt **14,304 -> 15,301 chars**
  (+997) and **+230 prompt tokens** per call at the same 320x180 scale
  (12,420-12,530 -> 12,544-12,760). Evidence (`ctx_chars`) is byte-identical
  window by window, so this is prompt text, not evidence drift.

Consequence: the 8343 numbers cannot be used as this run's baseline, and the
control cell is a *stronger* baseline than 8343 was (recall 4/15 -> 7/15 with the
same 6 FPs). All deltas below are therefore computed **within this run**
(cell vs cell, same build, same evidence, only frame scale differs).

## 4. Scores

Rail `live`, budget 280 tok/img, 30 frames + the deployed wire's duplicated last
frame = 31 images. `goal predicted` = deployed `parse_decision` outcome
`scoring_play`. Guard = deployed `apply_goal_attestation_gate` +
`apply_contract_guard`, called exactly as the live rail does
(`eventType='SPORTING_EVENT'`, evidence = the window's own perceive evidence).

### 4a. All 49 labelled goal windows (34 of them unverified)

| cell | raw precision (95% Wilson) | raw recall (95% Wilson) | TP | FP | FN |
|---|---|---|---|---|---|
| `live_ctrl_280_320x180` | 0.6216 [0.4610, 0.7594] | 0.4694 [0.3370, 0.6062] | 23 | 14 | 26 |
| `live_280_768x432` | **0.7059** [0.5383, 0.8317] | **0.4898** [0.3558, 0.6253] | 24 | 10 | 25 |

Delta (match - control): precision **+0.0843** [-0.1327, +0.2883],
recall **+0.0204** [-0.1711, +0.2098] (Newcombe). McNemar exact over the
discordant goal windows (4 lost, 5 gained): **p = 1.0**.

Lost by the match cell: `cg-g-06, cg-g-07, cg-g-32, ks-g-0280`.
Gained by the match cell: `cg-g-00, cg-g-11, cg-g-20, cg-g-28, cg-g-33`.

320x180 FP (14): `cg-n-02, cg-n-03, cg-n-08, cg-n-12, cg-n-19, cg-n-20, cg-n-22,
cg-n-24, ks-n-0162, ks-n-0312, ks-n-0402, ks-n-0622, ks-n-0696, ks-n-0760`.
768x432 FP (10): `cg-n-02, cg-n-03, cg-n-20, cg-n-22, cg-n-24, ks-n-0312,
ks-n-0402, ks-n-0622, ks-n-0696, ks-n-0760` — the scale change clears 3
compilation build-up FPs and adds none.

### 4b. Frame-verified subset only (the 37 carried windows, 15 verified goals)

| cell | precision [95%] | recall [95%] | TP | FP | FN |
|---|---|---|---|---|---|
| `live_ctrl_280_320x180` | 0.5385 [0.2914, 0.7679] | **0.4667** [0.2481, 0.6988] | 7 | 6 | 8 |
| `live_280_768x432` | 0.5455 [0.2801, 0.7873] | **0.4000** [0.1982, 0.6425] | 6 | 5 | 9 |

Delta: precision +0.007 [-0.3438, +0.3527], recall **-0.0667**
[-0.3743, +0.2598]. Lost: `ks-g-0280`. Gained: none. McNemar is undefined in
substance here (1 discordant pair, p = 1.0).

### 4c. Post-guard, exactly the same numbers

The guard **changed nothing**: `apply_goal_attestation_gate` passes every row
(`attest_ok=True` on 180/180) and `apply_contract_guard` never rejected
(`not_an_accept 109`, `not_a_goal_accept 49`, `unverifiable_evidence 22`,
`contradictedBy` on 0 rows). Raw and guard-filtered precision/recall are
identical in every cell, so the AC6 comparison reads the same either way.

Guard build: `docker exec highlights-decide md5sum /srv/decide/app/gemma.py` ->
`3797ff73a476d620d5762d395a199f04`, decide image
`sha256:1c416c3ce1d1eb20358629f6ad6a5ffd72af8cf5a90fd031b7d99a401bdcca6b`.
ADAAAA-8370's non-attested-accept rejection (`apply_goal_attestation_gate`) **is
present in this build but is inert on the live path**, for two independent
reasons: the live candidate label is `SPORTING_EVENT` and `is_goal_accept()`
scopes the gate to goal events, and `DECIDE_CONFIRM_ENABLED=1` makes the gate
defer to the Stage-2 confirm dive instead of rejecting. So on this deployment the
deterministic filter that can act on the live accept is the ADAAAA-8120 contract
guard, and it fired zero times on these 180 rows — an un-attested accept still
counts as an accept.

### 4d. Power (a single-window flip is noise)

At the 8343 discordance rate (4/15 = 0.2667) the exact McNemar test has power
**0.343 at N = 49 goal windows** and **0.030 at N = 15**. 80% power at that
discordance needs **N = 126 goal windows**. The AC bar was >=40; a PASS there
would have proven the *interval* readable, not the lever useful. At the numbers
actually obtained, `p = 1.0` with 4 lost / 5 gained is a coin flip.

## 5. Latency and payload — latency-neutral on the serving path

| cell | prompt tokens (median, min-max) | prefill TTFT (median) | wall (median) | payload (median) |
|---|---|---|---|---|
| `live_ctrl_280_320x180` | 12,737 (12,389-12,760) | 6.254 s | 9.204 s | 0.427 MB |
| `live_280_768x432` | **12,737 (12,389-12,760)** | 6.312 s | 9.398 s | **1.495 MB** |

On the verified subset: 12,650 both cells, TTFT 6.207 -> 6.405 s, wall
9.132 -> 9.556 s, payload 0.446 -> 1.602 MB. Prompt tokens are identical at the
same budget (266/img at `max_soft_tokens=280`), so the extra resolution costs
**0 tokens**: the image-token count is the budget, and the payload grows 3.5-3.6x
(0.43 -> 1.50 MB per request).

**The change is latency-neutral on the serving path.** No prefill or wall shift
beyond noise; the per-request bytes on the wire do grow ~3.5x, which is a
bandwidth/storage cost, not a decode cost.

Repeating the 8343 warning: **frame scale is a quality lever, not a latency
lever**, and it moves in opposite directions per rail (the VOD rail's control is
640x360 and its match arm 1080x608). A PASS here — and there is no PASS — could
not be generalised to VOD.

## 6. Why FAIL, stated plainly

AC6 needs *no control TP lost* **and** precision >= control **and** recall >=
control over >=40 goal windows.

- On the labelled set: precision and recall are nominally up (+0.084 / +0.020),
  but the match cell **drops `ks-g-0280`**, a case the control cell catches, so
  the conjunctive condition fails. `p = 1.0`: nothing here is distinguishable
  from noise, and the precision gain is bought mostly on 3 compilation build-up
  FPs cleared by the larger frames (`cg-n-08`, `cg-n-12`, `cg-n-19`) that the unverified-corpus caveat makes soft.
- On the only frame-verified subset: recall **drops** 0.4667 -> 0.4000. That is
  the reading that would survive if the 34 compilation anchors were ever verified.
- AC1's >=40 *verified* goal windows is not met, because verification failed.

A 40-window PASS would in any case have been underpowered (0.455 at the 8343
discordance). The honest disposition is: **the lever is closed**, and a future
proposal must bring >=86 verified goal windows (126 for 80% at the discordance
now observed) and a reader that can actually arbitrate goal frames.

## 7. Artifacts and how to re-score independently

| artifact | sha256 |
|---|---|
| `rows.jsonl` (180 rows, 2 cells x 90 windows) | see issue comment (published after upload) |
| `score.json` (all 49 labelled goal windows) | published in the comment |
| `score_verified.json` (37 carried windows / 15 verified goals) | published in the comment |
| `reader-verification-8371.json` (both protocols, per-window cues) | published in the comment |
| `label-manifest-8371.json` (frozen input manifest) | `09468a9025dcebf01fbf6e29bbd203b8deb2ec23f7fc9b270922ff26ab4b1994` |

Re-score from the raw rows (no GPU, no model call):

```sh
python3 score8371.py --rows rows.jsonl --manifest label-manifest-8371.json \
    --evidence-cache cache/evidence/live --frames-cache cache/frames --json score.json
python3 score8371.py --rows rows.jsonl --manifest label-manifest-8371-carried37.json \
    --evidence-cache cache/evidence/live --frames-cache cache/frames --json score_verified.json
python3 check_control_8371.py --rows rows.jsonl --manifest label-manifest-8371.json
```

`check_control_8371.py` exits 1 on this run — that is the fidelity failure of §3,
reproduced from the artifacts.

## 8. What was not run, and why

- **The 34 `cg-g-*` anchor verification is not done** (reader unfit, §2). No
  verified manifest exists; no anchor was dropped or promoted.
- **No VOD rail.** Out of scope (2 live cells only).
- **The bogus `score8371.py` call in the inherited `/tmp/run8371.sh`** referred to
  a file that did not exist on the box; scoring was run explicitly with the
  script shipped here (log: `score.log`, `score_verified.log`).
- **No repo typecheck/build.** The commit under `evals/` is additive scripts +
  data; each script was byte-compiled and executed against the real artifacts, and
  the scoring scripts ran end to end on the box. No app code changed.
- **`git` sanity note:** the decide build moved mid-evaluation (05:04Z). Nothing
  in this ticket touched it; the drift is reported, not caused.

## 9. Scope honoured

No 768x432 adoption or deploy, no config/env change, no VOD frame scale, no
vision budget change, no model change, no `POST /jobs`, no Livepeer spend, no
restart. All reads on the box were read-only (`docker exec`, `docker inspect`,
`ffmpeg`, `/v1/chat/completions`).
