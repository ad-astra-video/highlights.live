# Tennis measurement pass — verdict (ADAAAA-7766, per-type step 2)

**Verdict: `not_captured`.** Blocker: **`no rights-cleared broadcast sample`**.

Every acceptance criterion below is either `not_captured` with its named
blocker or `satisfied` with the artifact that proves it. Nothing in this file is
a fixture number, a synthetic number, or a soccer number presented as tennis.

## The one finding the CEO needs

**Zone-trigger viability for tennis given measured ball recall: `not_captured`.**
Ball recall was not measured because no rights-cleared clip exists to label, so
this pass neither clears nor kills the detection-in-zone trigger for tennis.
Tennis must not be described as "almost shipping-ready" on the strength of this
issue: the zone path is wired, but the ball-recall question that decides it is
still unanswered. This is an absence of evidence, not evidence of viability.

## Acceptance criteria

| # | criterion | outcome |
| --- | --- | --- |
| 1 | Committed, rights-cleared tennis eval set at `evals/tennis_val/`, coverage floors met or shortfall stated | **`not_captured`** — blocker `no rights-cleared broadcast sample`. Search record: `evals/tennis_val/RIGHTS-SEARCH.md`; machine-readable candidates: `evals/tennis_val/rights-candidates.json`; reproducible scan: `evals/tennis_val/scan_rights_candidates.py`. 85 tennis candidates screened, 5 cleared licence + 300 s on metadata, 0 survived content review as continuous match play. |
| 2 | `load_profile("tennis")` resolves; registered profile carries `evalSet` and a truthful `measured` flag | **Not met, deliberately.** Registering tennis with `evalSet=None` would be a `measured=False` profile dressed up as stage-1 progress, and registering it with a fabricated `evalSet` would invent the missing evidence. Tennis therefore stays out of `PROFILES`; `profile_for("tennis")` still returns the unmeasured profile (own vocabulary, `eval_set=None`, `measured=False`, audio trigger only, `no-zone`), and the strict `KeyError` is retained. Guardrail: `services/perceive/tests/test_game_profile.py::test_tennis_stays_unmeasured_until_a_rights_cleared_manifest_is_committed`, which also skips itself the moment a real manifest is committed. |
| 3 | `detect_precision.py --backend florence --profile tennis` per-class precision/recall with tennis-ball recall as its own line, plus artifact path | **`not_captured`** — no labelled frame-level slice (`evals/tennis_val/detect_val.jsonl` does not exist), and the harness refuses to run without a valid `--val` manifest. No `--backend fixture` run was performed, so no fixture number can be mistaken for a result. |
| 4 | `measure_audio_recall.py --profile tennis` per-class recall, trigger-window FP rate, onset p50/p95, stated FP ceiling | **`not_captured`** — no tennis audio labels and no clip root. The soccer reference (recall 0.875 / candidate FP 0.0952 at `stageA/burst/1.3x/0.3s`) and INC-9's 36.7% are untouched: neither is quoted as a tennis result, and no FP ceiling is asserted for tennis because there is no measurement to justify one. |
| 5 | Live detection latency p95 event-to-flag within the 1–5 s budget | **`not_captured`** — no GPU run. No bounded harness job was launched, so no box spend was incurred. |
| 6 | Tracking on a tennis track manifest: 3 live / 8 VOD caps, ID persistence and IoU, concurrency exercised | **`not_captured`** — no tennis track manifest exists. The soccer track manifest was not re-scored and is not presented as tennis, and no concurrency number is claimed. |
| 7 | Explicit verdict sentence on zone-trigger viability for tennis given measured ball recall | **`not_captured`** — stated in full under "The one finding the CEO needs" above. |
| 8 | VOD depth: paired `metrics_runner.py --vod/--live` `D_detail` against the +10% out-bar | **`not_captured`** — no traces could be captured without a clip and a run; reason named. |
| 9 | A QA re-certification child exists and its verdict is recorded | **Satisfied.** [ADAAAA-7775](/ADAAAA/issues/ADAAAA-7775) was created for Highlights.live Reviewer with this issue `blocked` on it, and it returned **PASS**: the blocker is confirmed, the scan reproduces (same four qualifying rows, identical durations), no substituted evidence exists in the repo, and the record's only defect was the licence label corrected in this commit. Its verdict is recorded on the child; this issue closes on it. |
| 10 | No synthetic, fixture-backed, or re-used-soccer number appears as a tennis result | **Satisfied.** This verdict contains no tennis number at all; the only numbers are candidate counts, durations and licences from the rights scan, and the soccer reference above is labelled as soccer and used only as an untouched reference. |

## What was actually run

```bash
python3 evals/tennis_val/scan_rights_candidates.py \
    --out evals/tennis_val/rights-candidates.json        # exit 0, 0 request errors
python3 -m pytest services/perceive/tests/test_game_profile.py -q
```

Re-run after QA's licence erratum (same commands, same exit code and error
count), which regenerated `rights-candidates.json` with the corrected
`CC BY-NC-ND` labels and surfaced one further CC0 candidate
(`snafuinfinitynews-now_012521-tennis-winn-brook`, 704 s) that frame review puts
at a public-affairs meeting about new courts. Verdict unchanged.

Nothing was deployed, no served path changed, `services/perceive/app/game_profile.py`
is untouched, and no GPU job was started.

## Why `not_captured` is the honest outcome, not a shortcut

The issue's stage 1 makes the rights basis a hard gate and names this exact
outcome for exactly this situation. The search was not a token gesture: it
screened 279 Wikimedia Commons titles and the Internet Archive's open-licence
tennis catalogue (357 metadata rows, 85 tennis candidates), pinned the
near-misses so the record survives search-ranking drift, and frame-verified the
candidates that cleared licence and duration on paper. Every one of them failed
on content: a broadcast screen recording, a municipal press event, police
bodycam footage, a public-affairs meeting about new courts, a narrated
documentary, venue footage inside a broken share-alike file — while the only
real full-length matches anywhere are CC BY-NC-ND school recordings that the gate
does not accept (and whose NoDerivatives term would also forbid the label work).

Nothing in that set is a substitute for a tennis match clip, and using any of it
would produce a ball-recall number that means nothing for broadcast tennis.

## Next action and owner

- **QA re-certification: done.** [ADAAAA-7775](/ADAAAA/issues/ADAAAA-7775)
  returned PASS — `not_captured` is correct and reproducible, and the only
  follow-up it handed back (the licence-label erratum) is fixed in this record.
- **This issue closes on that verdict.** Closing `not_captured` is a valid close
  and releases the chain: [ADAAAA-7767](/ADAAAA/issues/ADAAAA-7767) (american
  football) is blocked on this issue and resumes on that close.
- **If the board wants tennis measured**: the unblock is a rights-cleared
  clip (own/commissioned/CC-BY/PD/partner permission) of >= 5 min continuous
  match play with >= 12 point-ending events. See RIGHTS-SEARCH.md § "What would
  unblock stage 1". Widening the licence gate alone does not help today: there
  is no long share-alike match clip to widen it for, and the long CC BY-NC
  school matches are also NoDerivatives.
