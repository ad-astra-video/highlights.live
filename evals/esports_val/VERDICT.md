# Esports measurement pass — verdict (ADAAAA-7768, per-type step 2)

**Verdict: `not_captured`.** Blocker: **`rights-cleared sample found, but it carries
no label-grade pixel-readable event clock`** (`no pixel-readable event clock in
the only rights-cleared esports sample`).

This is *not* the tennis blocker (`no rights-cleared broadcast sample`): a
rights-cleared esports clip **was** found, obtained and frame-reviewed. It fails
later in stage 1 — the clip has no scoreboard or kill feed a reader can verify at
native resolution, so the >= 15 verified kill/objective events and >= 10 non-event
windows the gate requires cannot be produced honestly from it.

Every acceptance criterion below is either `not_captured` with its named blocker,
`satisfied` with the artifact that proves it, or **measured** with the command,
host and artifact path. Nothing here is a fixture number, a synthetic number, or
a soccer number presented as esports.

- branch: `feat/adaaa-7768-esports-eval`
- clip: `sh_onfoss_20230923_tournament.mp4` — 5950.549 s, 426x240, h264 + aac
  (48 kHz stereo), sha256 `3da355cc…801b264` (435,639,290 bytes), from Internet
  Archive `on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream`,
  **CC0 1.0**, creator/uploader `onfoss` (the event organiser publishing its own
  tournament stream). A box-side clip-root artifact, not committed to the repo.
- rights record: `evals/esports_val/RIGHTS-SEARCH.md` +
  `evals/esports_val/rights-candidates.json` (reproducible via
  `scan_rights_candidates.py`).
- **no** `label-manifest.json`, **no** `detect_val.jsonl`, **no** `audio-labels.json`:
  nothing was labelled, so nothing claims a recall or FP number.

## The one finding the CEO needs

**The audio-noise trigger is saturated on esports audio, measured without labels.**

On the rights-cleared CC0 tournament stream the shipped gate
(`stageA/burst/1.3x/0.3s`, the profile default) produces **1392 candidates over
5951 s = 14.0 candidates/minute — one candidate every 4.3 s** (median inter-fire
gap 3.4 s, p90 7.7 s, max 34.3 s), and **82.0 % of the stream's runtime sits
within ±2.5 s of a candidate**. The gate is essentially always firing on a real
esports audio bed (caster commentary + dense game SFX).

This is **trigger volume, not a false-positive rate** — no labels exist, so no FP
rate is claimed. But the volume alone bounds the ceiling arithmetic:
a candidate FP rate of ≤ 0.10 means at most 10 % of candidates may be non-events,
i.e. ≥ 12.6 *genuine* kill/objective events per minute sustained across the whole
stream. A kart-racing tournament or a duel produces O(0.2–2) events per minute,
so ≥ 86–98 % of those candidates cannot be events. **Conclusion, stated as an
arithmetic bound on measured volume: the audio-noise trigger does not transfer to
esports as an acceptable trigger, and no threshold change fixes a 14/min fire
rate that covers 82 % of the runtime.** Recall on esports events stays
`not_captured` (no labels), so this says the gate cannot *gate* esports, not that
it misses events.

That is the input the HUD-trigger question needs, and it points the same way
american football did: for a `no-zone` type, audio is not a usable trigger on a
continuous-commentary feed, so the HUD/kill-feed trigger and the motion path are
where the type's real trigger has to come from.

## Acceptance criteria

| # | criterion | outcome |
| --- | --- | --- |
| 1 | Committed, rights-cleared esports eval set with the title named, footage basis recorded, coverage floors met or shortfall stated | **`not_captured`** — blocker `no pixel-readable event clock in the only rights-cleared esports sample`. Rights basis **is** recorded (CC0 1.0, onFOSS organiser, sha256 in this file); the shortfall is the label gate: the only obtainable derivative is **426x240** and the stream is an **observer-mode** capture whose on-screen banner reads *"You are a Spectator. Press 'Y' to change teams."* at t=300 s and t=1500 s — frame review at t=300/900/1500/2700 s found no legible numeric scoreboard, no kill feed, and a chat/overlay panel occluding the HUD. At 240p a score digit is ~6 px tall, so no event instant can be read to the ±1 s the label method needs. Search record: `RIGHTS-SEARCH.md`; candidates: `rights-candidates.json`. **No label manifest, no synthetic clip, no soccer stand-in was substituted.** |
| 2 | `load_profile(<title key>)` resolves and declares `zoneModel: no-zone` with the zone trigger dropped | **Not met, deliberately** (same call tennis made). The footage is **SuperTuxKart (kart-racing tournament) + Hypersomnia (2D arena shooter)** — neither is Valorant — so `valorant` was **not** overloaded with a roster that does not describe the video. No esports key is registered: `load_game_profile("valorant")` still raises `KeyError`, `profile_for("valorant")` still returns the canned unmeasured profile (own vocabulary `player/agent/weapon/head`, `eval_set=None`, `measured=False`, `no-zone`). Guardrail: `services/perceive/tests/test_game_profile.py::test_esports_stays_unmeasured_until_a_rights_cleared_manifest_is_committed`, which skips itself the moment a real manifest is committed. |
| 3 | `detect_precision.py --backend florence --profile <title key>` per-class precision/recall + artifact path | **`not_captured`** — no profile key resolves and there is no `detect_val.jsonl` frame-level slice. No `--backend fixture` run was performed, so no fixture number can be mistaken for a result. |
| 4 | `measure_audio_recall.py --profile <title key>` recall, trigger-window FP rate, onset p50/p95, stated FP ceiling | **`not_captured` for recall/FP/onsets** (no labels). **Measured for trigger volume**: 1392 candidates / 5951 s = **14.0/min** via `evals/measure_audio_recall.py --volume-clip … --volume-gate stageA --sr 8000`, artifact `evals/esports_val/run/esports_audio_volume_onfoss.json`. A stated FP-rate ceiling for esports: **≤ 0.10**, the same ceiling soccer meets on the same harness (soccer reference recall 0.875 / candidate FP 0.0952 at `stageA/burst/1.3x/0.3s`, [ADAAAA-7674](/ADAAAA/issues/ADAAAA-7674)); measured volume makes that ceiling arithmetically unreachable at esports event rates (see above). INC-9's 36.7 % is **not** used — QA on [ADAAAA-7755](/ADAAAA/issues/ADAAAA-7755) confirmed it is not reproducible from HEAD. |
| 5 | Explicit finding on whether the audio-noise trigger transfers to esports given commentary + dense SFX, with the numbers | **Satisfied, for the gating question.** 14.0 candidates/min, one per 4.3 s, 82.0 % runtime coverage, on a commentary + SFX esports bed: the trigger does not transfer — it saturates. Recall stays `not_captured`. Full statement under "The one finding the CEO needs". |
| 6 | Live detection latency p95 event→flag within the 1–5 s budget | **`not_captured`** — no GPU run and no event set to time against. No bounded harness job was launched, so no box spend was incurred. |
| 7 | Tracking: 3 live / 8 VOD caps, ID persistence, IoU, roster caps exercised | **`not_captured`** — no esports track manifest exists. The soccer manifest was not re-scored and is not presented as esports, and no concurrency number is claimed. |
| 8 | VOD depth `D_detail` vs the +10 % bar | **`not_captured`** — no paired `--vod/--live` traces could be captured without a clip run. |
| 9 | A QA re-certification child exists and its verdict is recorded | **Pending this heartbeat's handoff** — child created for Highlights.live Reviewer and this issue set `blocked` on it; the verdict is recorded there when it lands (the tennis and football precedents: `not_captured` is a valid close and the QA verdict is the deliverable even when adverse). |
| 10 | No automated HUD parse touched the labels; no synthetic, fixture-backed or re-used-soccer number appears as an esports result | **Satisfied.** No labels exist, so no HUD parse could touch them; **no HUD parser was built**. The only esports numbers in this record are the trigger-volume measurement, the clip's own metadata (duration/resolution/sha256) and the rights-scan counts. The soccer reference is labelled as soccer and used only as an untouched reference. |

## What was actually run

```bash
# 1. rights scan (Commons + Internet Archive, open-licence corpora)
python3 evals/esports_val/scan_rights_candidates.py \
    --out evals/esports_val/rights-candidates.json

# 2. clip obtained (box-side clip-root artifact, not committed)
curl -sSL -o sh_onfoss_20230923_tournament.mp4 \
  "https://archive.org/download/on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream/onFOSS_%202023-09-23%20-%20Hypersomnia%20and%20STK-Tournament%20Livestream-240p.mp4"
ffprobe -v error -show_entries format=duration -show_entries stream=codec_type,width,height,sample_rate,channels \
    sh_onfoss_20230923_tournament.mp4     # 5950.549 s, 426x240, aac 48 kHz stereo
sha256sum sh_onfoss_20230923_tournament.mp4   # 3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264

# 3. label-free trigger volume (local CPU, pure DSP — no GPU, no box spend)
python3 evals/measure_audio_recall.py --volume-clip sh_onfoss_20230923_tournament.mp4 \
    --clip-root <clip dir> --volume-gate stageA --sr 8000 \
    --json evals/esports_val/run/esports_audio_volume_onfoss.json

# 4. the guardrail that keeps esports unregistered until a real manifest exists
cd services/perceive && python3 -m pytest tests/test_game_profile.py -q
```

Frame evidence is re-derivable by any reader (no frames are committed; the clip
is a box-side artifact):

```bash
# the native frame, and the spectator banner the label gate dies on
ffmpeg -ss 300  -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 frame_t300.png
ffmpeg -ss 1500 -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 frame_t1500.png
# the HUD bands probed for a scoreboard/kill feed (both empty of digits)
ffmpeg -ss 300 -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 \
    -vf 'crop=326:70:100:0,scale=1304:280:flags=neighbor' hud_top.png
ffmpeg -ss 300 -i sh_onfoss_20230923_tournament.mp4 -frames:v 1 \
    -vf 'crop=326:70:100:170,scale=1304:280:flags=neighbor' hud_bottom.png
```

Nothing was deployed, no served path changed (`7b384e3` remains landed and not
deployed), no GPU job was started, and no operator-UI flag was touched.

## Why `not_captured` is the honest outcome, not a shortcut

The rights gate was *passed*, which is why this verdict reads differently from
tennis. What failed is the label gate, and the issue makes the label method a hard
discipline: labels are read from pixels by a person, frame-cited, and never from an
automated HUD parse. On this clip there is no pixel channel that carries an event
instant. The usable alternatives all fail the same way:

- the item's **1080p original is not served** — the file only exists as a
  BitTorrent stub and the HTTP path redirects to a 404 (verified);
- the open-licence corpus does contain **720p competitive footage** — three
  *Xonotic duel* matches (1280x720, 628–749 s each, creator `Draena`, **CC BY-SA
  4.0**, `xonotic-draena-vs-craven-*`) — but (a) CC BY-SA is **not** the gate's
  CC-BY/PD basis and widening it is a **policy decision, not the Developer's**
  (the same call american football's scan recorded), and (b) the frames reviewed
  from those recordings show a stream overlay + health/armour/timer HUD with no
  visible frag counter, so a licence widening alone would not yet buy a label
  clock. Both facts are in `RIGHTS-SEARCH.md`.
- **America's Army 2.5.0 multiplayer montage** (501 s, public domain, 1080p) is a
  kill compilation: it has kills back to back and therefore **no comparable
  non-event windows** — rejected on coverage, not rights.
- every other "esports" hit in the open corpora is a 60 s military public-affairs
  feature, a review video, a trailer, or an unlicensed VOD re-upload (e.g. a
  "Worlds 2024 Grand Final" item whose CC BY claim was made by a third-party
  uploader, not the rights holder).

Nothing in that set is a substitute for a label-grade esports sample, and using
any of it would produce a recall number that means nothing for esports.

## Two things this pass deliberately did NOT do

1. **No HUD/kill-feed parser and no corroboration oracle.** The issue forbids
   building even a small HUD reader here, because labels parsed from the HUD and
   then scored against the same parse is circular. Nothing of the kind exists in
   this branch.
2. **No registration of `valorant`, and no invented roster.** `valorant` remains
   the canned FPS entry with its untouched vocabulary.

## Next action and owner

- **QA re-certification: handed off.** Child issue assigned to Highlights.live
  Reviewer carries the numbers, the commands to re-read, and the explicit
  instruction that `not_captured` is a valid verdict — with the one thing worth
  checking hardest: whether a later part of the stream contains a scoreboard that
  this pass's frame review missed. If QA finds one, stage 1 is not blocked on
  rights at all and the label pass becomes mechanical.
- **Owner of the unblock (Developer, next pass):** a label-grade esports sample,
  in one of two ways:
  1. a rights-cleared clip whose HUD a reader can verify at native resolution —
     a tournament broadcast with a scoreboard or kill feed at >= 720p, or
  2. a board decision on the licence gate (see below) plus a frame review of the
     720p Xonotic duels for a frag/score read.
- **Board decision item (not a Developer call):** the gate as written accepts
  CC-BY / public-domain only. **CC BY-SA 4.0** creator footage of real competitive
  matches *does* exist (the Xonotic duels). Accepting BY-SA for eval use (with the
  share-alike recorded on the derived labels) would widen the searchable corpus
  for every remaining type, not just esports. Until the board rules on it, the
  gate stands as written.
- **Do not enable the operator UI for esports**, and do not treat "audio+saturated"
  as "esports understood": the type has at most one measured property today, and
  it is a negative one.
