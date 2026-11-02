# Game-profile contract (per video type)

Status: implemented in ADAAAA-7754 (step 1 of the ADAAAA-7435 plan, §4 and §9).
Owner path: `services/perceive/app/game_profile.py` (contract + loader),
`services/perceive/app/stage_a.py` (profile-driven trigger sites).

## Why

The analysis loop's soccer assumptions used to be global: one closed vocabulary
map, one audio operating point, one tracking roster, one corroboration path. A
video type is now configured by **data** — a single `GameProfile` per type — so
adding a type is a profile plus a measurement pass, not a code fork.

Soccer stays the reference implementation. The default profile reproduces
today's behaviour exactly (same vocabulary, same audio thresholds, same 3 live /
8 VOD caps, same trigger subset), so nothing regresses.

## The seven fields

A profile carries exactly seven fields (no others are part of the contract):

| Field | Meaning |
|---|---|
| `vocabulary` | Closed detection vocabulary for the type. Empty tuple = "no type-specific roster" (the legacy hint/preferLabels/safe-default chain applies). |
| `zoneModel` | Scoring-structure geometry (`goal-mouth`, `hoop-key`, `net-service-box`, `plan-zones`) **or** the `no-zone` fallback. |
| `corroborationOracle` | Named per-type secondary-confirmation seam: `scoreboard-ocr`, `hud-parse`, `audio-text`. Soccer ships `scoreboard-ocr`. |
| `triggerSubset` | Which Stage-A triggers run: `motion`, `audio`, `detection-in-zone`, `ball-velocity`, each individually enabled per type. |
| `audioThresholds` | `burst_ratio`, `swell_ratio`, `burst_min_frames`, `swell_seconds`, `cooldown_s`, `max_latency_s`. |
| `trackingRoster` | Objects to track plus the mode capacities, with the 3 live / 8 VOD caps enforced. |
| `evalSet` | The real held-out labeled manifest the type was measured on (`None` = unmeasured). Carries the eval label space and the recorded reference numbers. |

Metadata that is not one of the seven: the profile's `key` (registry name) and
derived helpers (`measured` is `eval_set is not None`).

## Loader and resolution

```python
from app.game_profile import load_game_profile, profile_for, PROFILES

load_game_profile("soccer")     # the registered, measured profile
load_game_profile(None)         # the safe default (unmapped hint)
profile_for("Premier League")   # hint/plan category -> soccer profile
profile_for("NBA")              # canned but UNMEASURED: own vocabulary, defaults
profile_for("unknown-game")     # safe default
```

- Only registered types live in `PROFILES` (soccer today). Other types are
  registered by their own measurement issue (ADAAAA-7435 steps 2-5).
- `load_game_profile(<unregistered key>)` raises `KeyError`; it never
  substitutes soccer.
- A session binds its profile from the job's `gameHint` (or the plan category).
  An explicit registered key (`gameProfile` on `/app/analyze`, `gameProfile` in
  the control `configure` message) is authoritative and is never reverted by a
  later hint sync.

## `no-zone` fallback

`ZoneModel.no_zone()` declares that the type has **no scoring structure at all**
(american football, esports). The profile itself drops `detection-in-zone` from
its trigger subset in `GameProfile.__post_init__` — the caller does not need a
special branch, and the perceive pass starts cleanly rather than degrading or
raising. A profile that both declares `no-zone` and supplies zone boxes is a
programming error and raises at construction.

The zone trigger, when a type does enable it, consumes geometry from
`zoneModel.zones` or from the decide brain's `TrackingPlan` (`plan-zones`).
Perceive holds no hand-tuned scoring boxes.

## Trigger subset — enforced by absence

`services/perceive/app/stage_a.py::evaluate_stage_a` evaluates only the sites
the profile enables. A site that is not enabled is **never evaluated**: its
inputs are not consulted (no zone geometry is built, no motion history is read,
no ball speed is scored). The frame path additionally skips the whole Stage-A
block when the profile enables none of the frame triggers.

The audio trigger lives on its own ~10 Hz DSP path (`process_audio`): a profile
without `audio` runs neither the Stage-A noise-change gate nor the Stage-B
whistle gate and emits no audio candidate.

Shipped trigger subsets:

| Profile | Triggers |
|---|---|
| `soccer` | `audio` |
| `safe-default` | `audio` |
| canned but unmeasured (`basketball`, `tennis`, `american football`, `valorant`) | `audio` |

Soccer runs `audio` only because ADAAAA-7108 removed the GOAL/detection-in-zone
and tracker fast-movement candidate triggers from perceive; the profile records
that shipped state, and the default profile must not add candidates. Enabling
`motion`, `detection-in-zone` or `ball-velocity` for a type is a measured
decision (see the rule below), not a config flip.

Frame-site operating points are **structural**, not sport thresholds:
`motion` reuses `IoUTracker.FAST_STEP`; `ball-velocity` fires on a surge over the
ball's own recent speed window; `detection-in-zone` needs no threshold (a
detection inside a zone is the hit).

## Audio thresholds

`AudioThresholds()` defaults are exactly the shipped `GateConfig` values
(1.3 / 1.3 / 3 / 2.5 / 2.0 / 5.0), so the default profile reproduces today's
firing set. Binding a profile whose thresholds differ re-arms the session's gate
(its rolling baseline belongs to the old operating point). Binding identical
thresholds leaves the live gate untouched.

## Tracking caps

`TrackingRoster` enforces the charter ceilings: live capacity <= 3, VOD capacity
<= 8 (the schema ceiling stays 8), live <= VOD. The caps are a ceiling, not a
data-driven knob — a profile that asks for more raises at construction.
`session.mode_capacity(clip_path, profile)` returns the profile's capacity and
the session's tracker is instantiated at it.

## Corroboration oracle

`corroborationOracle` names what counts as secondary confirmation for the type.
`ScoreboardOcrOracle` is the soccer implementation and delegates to the existing
`ScoreboardTracker.changed` reading, so the confirmed behaviour is unchanged. A
type with no oracle (`None`) yields an explicit no-signal instead of inheriting
soccer's confirmation. `hud-parse` (esports) and `audio-text` are named seams
only; they belong to ADAAAA-7435 step 3+.

## The no-copy rule

**No soccer threshold, zone, or vocabulary may be copied to another type without
a measured held-out eval set.**

In code:

- `unmeasured_profile()` seeds a type with its OWN vocabulary and the
  corpus-wide defaults only — no zone geometry, `eval_set=None`;
- a profile with `eval_set is None` cannot claim `measured`, and the eval
  harnesses refuse to score an unmeasured profile (`--profile` of a type with no
  eval set is an error);
- `load_game_profile()` refuses an unregistered key rather than silently running
  soccer's numbers.

This mirrors §6 of the ADAAAA-7435 plan: every per-type verdict states measured
vs `not_captured`.

## Eval harnesses

The harnesses take the profile instead of hard-coded soccer constants:

```sh
# detection: label space = profile.evalSet.vocabulary
python3 evals/detect_precision.py --profile soccer --backend fixture ...

# audio: the NEW operating point = profile.audioThresholds
python3 evals/measure_audio_recall.py --profile soccer --labels evals/audio-labels.json --clip-root /data

# tracking: caps = profile.trackingRoster
python3 evals/track_metrics.py --profile soccer --drop 0
```

`evals/measure_audio_recall.py` still prints the legacy INC-2 budget as the OLD
run for comparison; that legacy set is a deliberate historical reference, not a
profile value.

## Tests

`services/perceive/tests/test_game_profile.py` covers: the seven fields, soccer
as the seeded default, the default profile reproducing today's firing set on a
PCM fixture, per-type thresholds changing that firing set, the `no-zone`
fallback starting the pass cleanly, the trigger subset asserted as **absence**
(with a positive control), the 3/8 caps, and the harnesses reading the profile.
