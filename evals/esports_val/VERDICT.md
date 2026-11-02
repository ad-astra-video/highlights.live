# Esports leg — verdict record (ADAAAA-7768, per-type step 2)

**Revision 2 (supersedes revision 1).** Revision 1 (`1c0827f`) closed this type `not_captured` on the
blocker *"rights-cleared sample found, but no label-grade pixel-readable event
clock"*. QA re-certification on [ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793) FAILed
that blocker: the frame review behind it only covered the **Hypersomnia** half of
the stream, and the **SuperTuxKart** half carries a native-resolution race clock,
an official event banner and a lap counter. The rights work stands; the blocker
does not.

What revision 2 changes, in one line each:

- the blocker sentence is **withdrawn** — it is falsified, not merely softened;
- the label pass revision 1 said was impossible **has been done** (15 objective
  events, 13 non-event windows, 5 races, 833 s of competitive play);
- the esports leg is **registered** under its own title key `supertuxkart`
  (never under `valorant`);
- the audio trigger has a **measured** recall/FP verdict instead of an arithmetic
  bound on volume;
- the spectator-banner provenance quote is dropped — the string is not in the clip
  at t=300 s or t=1500 s (QA read the frame; only `onFOSS` and the schedule panel
  are there), and the uploader is `gnudist@tutanota.com` (creator onFOSS), which
  `RIGHTS-SEARCH.md` had right and this file had abbreviated to "creator/uploader
  onfoss".

**The measurement record for this type is
[`evals/supertuxkart_val/RESULTS.md`](../supertuxkart_val/RESULTS.md)**, with
labels in `evals/supertuxkart_val/label-manifest.json` and the run artifact in
`evals/supertuxkart_val/run/stk_audio_recall.json`.

## Verdict in one paragraph

**Measured, and negative on the trigger.** On a rights-cleared CC0 tournament
stream (onFOSS 2023-09-23, SuperTuxKart grand prix, 426x240, sha256 `3da355cc…801b264`),
the shipped audio gate (`stageA/burst/1.3x/0.3s`) reaches **recall 1.00 at a
candidate FP rate of 0.8957** (−6 s/+3 s label window; **0.80 recall at 0.9417**
at the harness default −3 s/+2 s) against **15 human-read objective events**,
and fires in **13 of 13** verified non-event windows. Trigger volume is **14.5
candidates/minute** inside the labelled window against **1.08 real objective
events/minute**. The audio-noise trigger **does not transfer to esports**; the
type's trigger has to come from motion and/or the HUD/kill-feed build.

Four acceptance criteria stay **`not_captured`**, each with its named blocker:

| criterion | blocker |
| --- | --- |
| detect precision/recall (`--backend florence`) | `no frame-level detection labels for this type` (no box slice was labelled, no GPU run) |
| live detection latency p95 | `no GPU run; no served path touched` |
| tracking (3 live / 8 VOD, ID persistence, IoU) | `no esports track manifest` (needs florence detections) |
| VOD depth `D_detail` | `no paired --vod/--live traces without a clip run` |

`not_captured` remains the right label for those four and is **not** a claim that
the type is unmeasured: the audio rule is measured, and its answer is "no".

## What revision 1 got right and keeps

- **The rights basis is real and the gate passed**: CC0 1.0, onFOSS publishing its
  own tournament stream, clip sha256 and byte count recorded, 1080p original still
  a BitTorrent stub with the HTTP path returning 404. The rights search,
  candidate scan and the CC BY-SA policy question live in
  `evals/esports_val/RIGHTS-SEARCH.md` and `rights-candidates.json`
  (`needs_policy_decision`, unchanged — still a board call, still not used).
- **No substitution**: no synthetic clip, no fixture backend, no soccer number
  wearing an esports label, no `--backend fixture` run.
- **No HUD parser and no oracle** were built, then or now. Labels come from a
  text reader over the race clock, the event banner and the lap counter; the audio
  gate never reads the HUD, so the measurement is not circular.
- **`valorant` was not overloaded** with a roster that does not describe the
  video. It still raises `KeyError` from `load_game_profile` and keeps its canned
  `player/agent/weapon/head` vocabulary.

## Disposition

- Child [ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793) — re-certification of revision
  1 — is `done` with its **FAIL** verdict, which is what produced this revision.
- The revision-2 re-certification child [ADAAAA-7806](/ADAAAA/issues/ADAAAA-7806)
  is `done` with verdict **PASS on clauses 1, 2, 4, 5, 10**; clause 3 stays
  `not_captured` (out of scope for that child, not a FAIL). QA reproduced every
  number in this record and found none it could not reproduce, and independently
  re-read the pixel evidence (clock/banner/lap-counter bands decoded with its own
  OCR env) for the label set. Certified at branch `b6a90d2`.
- **Measurement vs certification are now separate facts in code.** This record
  and `eval_set.reference` previously said `measured=True` only once the run *and*
  QA's verdict exist, but `GameProfile.measured` tested only for an eval set:
  QA flagged the overload on ADAAAA-7806. The contract now exposes
  `GameProfile.certified` (True only when `qaCertification` records a passing
  verdict) beside `measured` (the eval set exists), and `qaCertification` reads
  `pass (ADAAAA-7806, label revision 1, 15-event reading)`.
- **Nothing here enables the type.** Esports is certified for the clauses that
  were measured and still `not_captured` for detection, live latency, tracking
  and VOD depth; the audio trigger measured negative, so the operator UI stays off
  for this type.

## Next action and owner

- **Developer, next engineering step:** the HUD/kill-feed trigger is now
  justified by measurement rather than assumed — audio does not gate this type.
  That is a new build with its own scoped, costed issue and CEO cost approval
  before any GPU spend; its oracle must be validated against **these** labels,
  never against its own parse.
- **Board item that is still open:** whether the slide-accepting licence gate
  should admit CC BY-SA 4.0 footage (unchanged from revision 1, still not used).
