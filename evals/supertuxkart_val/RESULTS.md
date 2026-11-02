# SuperTuxKart measurement results — ADAAAA-7768 (esports leg, per-type step 2)

Revision 2 — **supersedes `evals/esports_val/VERDICT.md` revision 1** (`1c0827f`).
Revision 1 reported `not_captured` on the blocker *"rights-cleared sample found,
but no label-grade pixel-readable event clock"*. QA re-certification on
[ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793) showed that reading was wrong in one
specific way: the frame review only covered the **Hypersomnia** half of the
stream (t≈300/900/1500/2700). The **SuperTuxKart** half (t≳4245) carries a race
clock, an official event banner and a lap counter that read at native 426x240
resolution. So the blocker was falsified, not the rights work: the follow-up was
a label pass on a named time range, not a new rights search. This document is
that label pass and its measurement.

Every number below is **measured** (command, host, artifact path) or explicitly
**not_captured** with its blocker. No fixture number, no synthetic number and no
soccer/football number is carried over as an esports result.

- branch: `feat/adaaa-7768-esports-eval`
- clip: `sh_onfoss_20230923_tournament.mp4` — 5950.549 s, 426x240, h264+aac
  (48 kHz stereo), sha256 `3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264`
  (435,639,290 bytes), Internet Archive
  `on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream`, **CC0 1.0**,
  creator onFOSS (the event organiser publishing its own tournament stream;
  uploader `gnudist@tutanota.com`). Box-side clip-root artifact, not committed.
- labels: `evals/supertuxkart_val/label-manifest.json` — **15 verified objective
  events** (5 race starts, 5 final laps, 5 race finishes) and **13 verified
  non-event windows**, all inside the SuperTuxKart half.
- audio corpus: `evals/supertuxkart_val/audio-labels.json`
- rights record: `evals/esports_val/RIGHTS-SEARCH.md` +
  `evals/esports_val/rights-candidates.json`
- profile: `services/perceive/app/game_profile.py` →
  `SUPERTUXKART_PROFILE`, registered under the key **`supertuxkart`**

## 1. The label pass — what the reader actually read

The clip is a single 99-minute livestream cut in two halves: a **Hypersomnia**
2D arena-shooter session, then the **SuperTuxKart** tournament (grand prix, five
races). Only the kart half has a label-grade event channel, and that is what is
labelled.

Reader method (`label_method` in the manifest): every frame of t=4380–5731 was
cropped to three native-pixel bands at 1 fps and read as text —

| band | crop (native) | read |
|---|---|---|
| race clock | `x 364-428, y 30-56` | `MM:SS.mmm` race timer |
| centre banner | `x 120-320, y 60-110` | `Final lap!`, `You finished the race in rank N` |
| grand-prix panel | `x 60-170, y 50-180` | `Grand prix progress: N/5` (macro clock, corroboration) |

A **race start** is the instant where `frame_time − clock_value` is constant
across a race's reads (five resets, five races). A **final lap** is the centre
banner, except race D whose banner the reader could not resolve — there the lap
counter's `2/3 → 3/3` transition brackets it. A **finish** is the
`You finished the race in rank N` banner, except race E where the clock stops and
the results overlay appears (bracket 2 s). Every instant ships with its bracket:

| race | start | final lap | finish | channel of the finish |
|---|---|---|---|---|
| A | 4429.67 | 4547 | 4596 | banner `rank 5` |
| B | 4764.05 | 4873 | 4974 | banner `rank 6` |
| C | 5126.00 | 5222 | 5251 | banner `rank 6` |
| D | 5341.81 | 5440 (`[5437,5440]`, lap counter) | 5490 | banner `rank 5` |
| E | 5544.85 | 5649 | 5698 (`[5697,5699]`, clock stop) | clock stop + results overlay |

Coverage: **833 s of competitive play** across five races of one grand prix (the
issue's floor is one clip of ≥ 5 minutes spanning ≥ 2 races), **15 objective
events** and **13 non-event windows** of 24 s each.

Two honesty notes that are part of the record, not footnotes:

1. **The floor depends on counting lap-level events.** Read narrowly — only race
   start and race finish are "objective events" — the set is **10 events** and
   misses the ≥ 15 floor. The set is 15 only because the final lap of each race
   is counted, and each of those is an official on-screen `Final lap!` banner (or,
   for one race, the lap counter crossing to the final lap). Both readings are
   recorded (`coverage.narrow_reading_events = 10`); the board can grade the
   narrow reading if it prefers, and that grade is a floor miss.
2. **Nothing here is parsed from a kill feed.** No HUD parser exists in the
   branch and none was written for this pass. The audio gate whose recall is
   scored below never reads the HUD, so label and score are independent — the
   circularity the issue forbids cannot occur. This is a **reader** pass (the
   same CPU OCR QA used on [ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793)), which is
   the mechanism a human reader uses, not an automated event parser.

## 2. Audio trigger — measured

```
python3 evals/measure_audio_recall.py \
    --labels evals/supertuxkart_val/audio-labels.json \
    --clip-root <dir holding sh_onfoss_20230923_tournament.mp4> \
    --profile supertuxkart --json evals/supertuxkart_val/run/stk_audio_recall.json
```

Host: **local CPU** (pure DSP — ffmpeg decode + numpy gate at the profile's
`stageA/burst/1.3x/0.3s` operating point). No GPU job was spent on a rule that
cannot use one. Artifact: `evals/supertuxkart_val/run/stk_audio_recall.json`.

| class | events | candidates (whole clip) | recall | candidate FP rate (whole clip) | onset→fire p50 | p95 | max |
|---|---|---|---|---|---|---|---|
| `objective_event` | 15 | **1392** | **0.80 (12/15)** | **0.9864 (1373/1392)** | 0.20 s | 0.40 s | 1.90 s |

The whole-clip FP rate mixes in the unlabelled Hypersomnia half, where a fire is
not a *certified* false positive. The honest denominators are the labelled
window, and there the same run gives:

| set | candidates | candidates/min | FP rate |
|---|---|---|---|
| labelled SuperTuxKart window (4380–5731 s, 1351 s) | **326** | **14.48** | **0.9417 (307/326)** |
| whole clip (propagated trigger volume, for comparability) | 1392 | 14.04 | 0.9864 |

Non-event windows (13 verified mid-race windows, 24 s each, clock running at both
ends and no labelled instant within ±10 s):

| negative set | windows | windows with ≥1 fire | window FP rate | fires |
|---|---|---|---|---|
| all | 13 | **13** | **1.00** | 75 |

The window class is deliberately narrow: the windows are verified **mid-race and
event-free** (clock monotonic through the window, no start/final-lap/finish
within ±10 s). Whether a given window is pack racing, a spin or a drift was not
frame-classified, so the class name says what was verified rather than guessing.

### 2a. Label-tolerance sensitivity

Three of the three misses sit 2.45–2.50 s **after** their instant, i.e. just
outside the harness default `+2 s` post window. Re-scoring the same fire list
against the same 15 verified instants with a wider window:

| label tolerance (pre/post) | recall | labelled-window FP rate |
|---|---|---|
| −3 s / +2 s (reported above, harness default) | 0.80 (12/15) | 0.9417 |
| −3 s / +3 s | 1.00 (15/15) | — |
| −6 s / +3 s | 1.00 (15/15) | **0.8957** |

Recall is timing-sensitive; **the FP rate is not** — a generous window buys
recall and leaves the gate firing on ~90 % of its own candidates.

## 3. The finding: the audio-noise trigger does not transfer to esports

**Measured, with the labels revision 1 already had none of:**

1. **Recall 1.00 at a candidate FP rate of 0.8957 (generous window) / 0.80 recall
   at 0.9417 (default window).** The gate finds every objective event *and* fires
   on ~9 of every 10 candidates that are not one.
2. **Trigger volume 14.5 candidates/minute inside the labelled window** — one
   candidate every 4.1 s, on a commentary + dense-SFX bed. For an FP ceiling of
   ≤ 0.10 to be reachable at that volume, the type would need ≥ 13 *genuine*
   objective events per minute sustained. Five kart races produce 15 events in
   833 s = **1.08 events/minute**. So ≥ 92 % of candidates cannot be events, and
   no threshold change fixes a fire rate that covers most of the runtime.
3. **Every non-event window fired (13/13, 75 fires).** The broadband burst gate is
   reacting to the caster commentary + engine/SFX bed, which never returns to a
   quiet baseline on an esports feed.

**Conclusion (AC 5): the audio-noise trigger does not transfer to esports.** This
is the same shape american football measured (recall 1.00 at FP 0.9853,
14.2 candidates/minute, [ADAAAA-7767](/ADAAAA/issues/ADAAAA-7767)) and it is the
input the HUD-trigger decision needs: for a `no-zone` type on a
continuous-commentary feed, the trigger has to come from **motion** and/or the
**HUD/kill-feed build**, not from audio. Audio remains useful as a *corroborator*
on a downstream candidate, not as a candidate generator.

**Stated FP-rate ceiling for this type (AC 4): a candidate FP rate of ≤ 0.10** —
the same ceiling soccer meets at `stageA/burst/1.3x/0.3s` (recall 0.875 / FP
0.0952, [ADAAAA-7674](/ADAAAA/issues/ADAAAA-7674), quoted as soccer only).
Measured: **0.9417 in-window (default window) / 0.8957 (generous) — missed by
~9×.** INC-9's 36.7 % is **not** used: QA on
[ADAAAA-7755](/ADAAAA/issues/ADAAAA-7755) confirmed it is not reproducible from
HEAD.

## 4. Acceptance criteria

| # | criterion | outcome |
| --- | --- | --- |
| 1 | Committed, rights-cleared eval set, title named, footage basis recorded, coverage floors met or shortfall stated | **Met** — `evals/supertuxkart_val/label-manifest.json` + `detect_val.jsonl`-class frame proof in the manifest, title **SuperTuxKart**, basis **CC0 1.0 / onFOSS / sha256 recorded**. 15 objective events and 13 non-event windows on 833 s across 5 races. Floors met at 15/13; the narrow (start+finish only) reading is 10 and is recorded as a possible floor miss. `detect_val.jsonl` (frame-level detection slice) is **not** committed — **`not_captured`, blocker `no frame-level detection labels for this type`**, named in `known_gaps`. |
| 2 | `load_profile(<title key>)` resolves, declares `zoneModel: no-zone`, zone trigger dropped at construction | **Met (AC2)** — `load_game_profile("supertuxkart")` resolves; `zone_model.is_no_zone`, `triggers == (motion, audio)` and `detection-in-zone` is dropped at construction. `valorant` is deliberately **not** overloaded: it keeps its canned FPS roster and its `KeyError`. Covered by 3 tests in `services/perceive/tests/test_game_profile.py` §9. |
| 3 | `detect_precision.py --backend florence --profile supertuxkart` per-class precision/recall + artifact | **`not_captured`** — no frame-level detection slice exists for this type, so there is no label space for the detector to be scored against, and no GPU run was launched. No `--backend fixture` run was performed anywhere in this pass. |
| 4 | `measure_audio_recall.py --profile supertuxkart` recall, trigger-window FP rate, onset p50/p95, stated FP ceiling | **Met** — recall 0.80 (12/15) at default window / 1.00 at −6/+3; labelled-window candidate FP rate 0.9417 (0.8957 generous); p50 0.20 s, p95 0.40 s, max 1.90 s; non-event window FP rate 1.00 (13/13). Artifact `evals/supertuxkart_val/run/stk_audio_recall.json`. Ceiling: **≤ 0.10**, missed ~9×. |
| 5 | Explicit finding on whether the audio trigger transfers to esports | **Met** — it does **not** transfer (section 3): recall 1.00 at FP 0.8957 and 14.5 candidates/min against 1.08 real events/min. Numerically identical shape to american football. |
| 6 | Live detection latency p95 event→flag within the 1–5 s budget | **`not_captured`** — no GPU run, no served path touched. The only latency measured here is the **audio** onset→fire p95 (0.40 s), which is a different quantity and is not reported as live e2e latency. |
| 7 | Tracking: 3 live / 8 VOD caps, ID persistence, IoU, roster caps exercised | **`not_captured`** — no esports track manifest (needs florence detections). Caps are declared and enforced by the profile (`live 3 / vod 8`, roster `("kart",)`), but no concurrency number is claimed. |
| 8 | VOD depth `D_detail` against the +10 % bar | **`not_captured`** — no paired `--vod/--live` traces could be captured without a clip run. |
| 9 | QA re-certification child exists and its verdict is recorded | **Met (AC9)** — two children, both `done` with recorded verdicts: [ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793) **FAILed** the superseded revision-1 blocker (its clause 2 is what falsified it and produced this revision), and [ADAAAA-7806](/ADAAAA/issues/ADAAAA-7806) **PASSed clauses 1, 2, 4, 5, 10** with clause 3 `not_captured` (out of scope there). Section 10 below. |
| 10 | No automated HUD parse touched the labels; no synthetic/fixture/re-used-soccer number as an esports result | **Met** — no HUD parser exists in the branch; labels come from a text reader over the race clock / banner / lap counter and each event names its channel; the audio gate is independent of the HUD, so there is no circularity. The soccer reference is labelled as soccer and used only as an untouched reference; INC-9's 36.7 % appears only as "not used". |

## 5. What was NOT done, and why

- **No HUD/kill-feed trigger, no corroboration oracle.** Both are gated
  follow-ons on this issue, and building a HUD parser here would let the same
  parse produce the labels and be scored by them.
- **No profile registration under `valorant`.** The footage is a kart racer; the
  canned FPS roster `player/agent/weapon/head` does not describe it.
- **No threshold tuning.** This pass records the corpus-wide default as the
  baseline; the saturation finding is about the trigger, not about a knob.
- **No deploy.** `7b384e3` remains landed and not deployed; no served path
  changed; no operator-UI flag touched; no GPU job started.

## 6. Reproduce

```bash
# 1. reader pass (CPU OCR over native-pixel bands; no HUD parser)
python3 build_stk_labels.py <scratch> <repo>        # emits the manifest + audio corpus

# 2. the measured audio run
python3 evals/measure_audio_recall.py \
    --labels evals/supertuxkart_val/audio-labels.json \
    --clip-root /tmp/esports-clips/root --profile supertuxkart \
    --json evals/supertuxkart_val/run/stk_audio_recall.json

# 3. label-tolerance sensitivity
python3 evals/measure_audio_recall.py --labels evals/supertuxkart_val/audio-labels.json \
    --clip-root /tmp/esports-clips/root --profile supertuxkart --match-pre 6 --match-post 3

# 4. the two guards
cd services/perceive && python3 -m pytest tests/test_game_profile.py -q   # 31 passed
```

Clip provenance check (any reader can re-derive the labels from the same
artifact):

```bash
sha256sum sh_onfoss_20230923_tournament.mp4   # 3da355cc…801b264
ffmpeg -ss 4490 -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 \
    -vf 'crop=64:26:364:30,scale=iw*4:ih*4:flags=lanczos' clock_4490.jpg
ffmpeg -ss 4875 -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 \
    -vf 'crop=200:50:120:60,scale=iw*6:ih*6:flags=lanczos' banner_4875.jpg
# clock_4490 -> 01:00.5 ; banner_4875 -> "Final lap!"
```

## 10. QA certification — PASS (ADAAAA-7806), and the one discrepancy it flagged

Re-certification child [ADAAAA-7806](/ADAAAA/issues/ADAAAA-7806), Highlights.live
Reviewer, verdict **PASS on clauses 1, 2, 4, 5, 10**; clause 3 `not_captured`
(that child's scope excluded it). Certified against branch
`feat/adaaa-7768-esports-eval` at `b6a90d2`.

What QA independently established:

- **Provenance re-derived** — sha256 `3da355cc…801b264`, 435,639,290 bytes,
  duration 5950.549 s, 426x240 h264 + aac 48 kHz stereo.
- **Independent pixel re-read** of the label set with its own OCR env (not the
  reader dump behind this pass): race-clock zeros, the `Final lap!` banner, the
  `finished the race in rank 6` banner, and the race-D `2/3 → 3/3` lap-counter
  crossing all confirmed. The ~0.3–0.5 s offset it measured is seek/frame
  alignment, not label drift.
- **Every number reproduced** in section 2 — recall 0.80 / 1.00, in-window FP
  0.9417 / 0.8957, whole-clip 0.9864, p50 0.20 s / p95 0.40 s / max 1.90 s,
  13/13 non-event windows firing, 14.48 candidates/min vs 1.08 real events/min —
  from a byte-identical fire list. Numbers it could not reproduce: **none**.
- **Clause 1 grading call:** graded on the **15-event** reading because the
  final-lap instants are themselves official on-screen reads. The narrow
  (start + finish only) reading is **10** and remains a stated floor miss
  (`coverage.narrow_reading_events = 10`) — the board can grade the narrow one.

Two non-blocking notes QA raised, both recorded rather than argued away:

1. `video.label_confidence_note` claims the default −3/+2 s window "covers every
   bracket in this file". It does not literally: B-start is bracketed
   `[4763.1, 4769]` (5.9 s) and C-start `[5125.0, 5130]` (5.0 s). The clock
   arithmetic still places both starts where labelled, so this is an overstated
   sentence, not a wrong instant.
2. `coverage.race_spans_s` sums race spans to 832.6 s while start→finish is
   ≈810 s (race D's span ends 5483 but its finish is 5490; race E's 5693 vs
   5698). The ≥ 5 min / ≥ 2 races floor is met either way.

**The discrepancy QA asked the Developer to fix, and the fix.** This record and
`eval_set.reference.qaVerdict` used to say `measured=True` only once the run *and*
QA's verdict both exist. The code never tested that: `GameProfile.measured`
returned True from `eval_set` presence alone, so it read True before any verdict
existed. Collapsing the two was the mistake — an eval set legitimately exists
before QA has read it. The contract now separates them:

- `GameProfile.measured` — a held-out labeled `eval_set` exists (measurement fact);
- `GameProfile.certified` — `eval_set.reference["qaCertification"]` records a
  **passing** QA verdict (review fact), also surfaced in `to_dict()`.

`SUPERTUXKART_PROFILE.eval_set.reference["qaCertification"]` now reads
`pass (ADAAAA-7806, label revision 1, 15-event reading)`, and
`services/perceive/tests/test_game_profile.py` pins that a `pending` / `fail` /
absent certification reads `certified == False` while `measured` stays True —
so neither fact can masquerade as the other again. 32 tests pass.

## Next action and owner

- **QA re-certification — landed.** [ADAAAA-7806](/ADAAAA/issues/ADAAAA-7806)
  returned **PASS on clauses 1, 2, 4, 5, 10** (clause 3 `not_captured` there),
  reproducing every number in section 2 and re-reading the pixel evidence
  independently. Section 10 records the verdict and the certification-vs-
  measurement fix. No further QA pass is needed for these clauses.
- **Owner of the next engineering step (Developer)**: the HUD/kill-feed trigger
  question is now answerable in the affirmative direction — audio does not gate
  this type. That build needs its own scoped, costed issue (CEO cost approval
  before any GPU spend), and its oracle must be validated against **these**
  labels, never against its own parse.
- **Do not enable the operator UI for esports.** The type has a measured negative
  on its trigger and no detection/tracking/latency measurement, so nothing here
  authorises enablement.
