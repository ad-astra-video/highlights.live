# Tennis stage-1 rights search — record and blocker (ADAAAA-7766)

Stage 1 of the tennis measurement pass needs a held-out clip that clears two
independent bars before any label work can start:

1. **Rights basis (hard gate).** Acceptable: footage we own or commissioned,
   CC-BY / public-domain, or partner-supplied with written permission. Not
   acceptable: ripped broadcast clips with no rights basis. CC BY-SA, CC BY-NC*
   and CC BY-ND* are not the basis this gate names.
2. **Coverage floor.** >= 300 s of continuous real match play carrying >= 12
   verified point-ending events, plus >= 10 verified non-event windows of
   comparable length, with ball positions labelable at full resolution.

This file records the search that went looking for such a clip on 2026-11-02 and
what it found. **Result: no candidate clears both bars. The verdict is
`not_captured`, blocker `no rights-cleared broadcast sample`.** See
[VERDICT.md](VERDICT.md) for the acceptance-criteria table.

No clip, frame, label, or fixture was substituted: a soccer clip, a synthetic
clip, or a `--backend fixture` number would all be fabricated tennis evidence,
which the issue forbids.

## Erratum after QA re-certification (ADAAAA-7775)

QA re-ran the scan and confirmed the verdict, and found one record defect that
this file now corrects:

- the long school matches are **CC BY-NC-ND 3.0** (`DoubleACS_GirlsTennis0217`,
  `DoubleACS_GirlsTennis0417`, `DoubleACS_BoysTennis0317`) and **CC BY-NC-ND
  4.0** (`mmuboystennisU3205152024`), not plain CC BY-NC. The rejection stands
  and is stronger — NoDerivatives also forbids the derived label work;
- `scan_rights_candidates.py` labelled every `/by-nc*` URL as `CC BY-NC`,
  hiding the ND half in `rights-candidates.json`. The classifier now
  distinguishes `CC BY-NC-ND`, `CC BY-NC-SA`, `CC BY-NC` and `CC BY-ND`, and
  the committed JSON was regenerated with it (counts below).

## Reproducing the search

```bash
python3 evals/tennis_val/scan_rights_candidates.py \
    --out evals/tennis_val/rights-candidates.json
# exit 0 = at least one candidate clears the automatic bars on metadata alone
# exit 7 = none does (today: exit 0 only because five rows clear licence+duration
#          and are killed on frame/content review below, not automatically)
```

The scanner screens the two open-licence corpora that actually carry match
recordings — Wikimedia Commons and the Internet Archive — with the queries
listed in `rights-candidates.json["queries"]`. It reads licence and duration
from `imageinfo` / item metadata, classifies the licence against the gate,
applies the 300 s floor, and filters out table tennis / video-game / "ao"
(Portuguese) noise by title. Candidates found by hand that a 100-hit capped
search ranks below the cut are pinned in the script so the record does not
depend on search ranking.

Snapshot (2026-11-02; re-run after QA's erratum on
[ADAAAA-7775](/ADAAAA/issues/ADAAAA-7775), commit on branch
`feat/ad-7766-tennis-rights-search`):

| measurement | value | QA-certified run (`b8648c2`) |
| --- | --- | --- |
| Commons titles screened | 279 | 282 |
| metadata rows screened (Commons + Internet Archive) | 357 | 360 |
| dropped as not tennis (table tennis, video game, press/`ao` noise) | 272 | 276 |
| tennis candidates retained | 85 | 84 |
| cleared licence + 300 s duration floor automatically | 5 | 4 |
| cleared licence + duration **and** verified as continuous match play | **0** | **0** |
| request errors recorded | 0 | 0 |

The two counts differ because both corpora drift between runs (three Commons
titles left the result set and one Internet Archive news item arrived); QA
re-ran the committed script and reproduced the same four qualifying rows with
identical durations, so the drift is in the non-qualifying tail. The fifth
qualifying row below is that new arrival and fails on content like the rest.

## What the five automatic hits actually are

All five clear the licence and duration bars on metadata and fail on content.
Verification is by the item's own file metadata plus frames read with
`vision_analyze` at 300 px (wide contact sheets time out; single downscaled
frames are reliable).

| candidate | duration | licence | why it is not the eval set |
| --- | --- | --- | --- |
| `alex-eala-at-the-asian-games-2026-tennis` (Internet Archive) | 5285.1 s | CC0 | A screen recording of a One Sports television broadcast, complete with commercial breaks and sponsor bumpers; the item description reads "Strictly No Copyright Infringement Intended". That is a ripped broadcast, which the gate excludes regardless of the CC0 tag on the upload. |
| `Mayor Mamdani Hosts Ribbon Cutting for Renovated Tennis Courts` (Commons) | 1575.0 s | CC BY 4.0 | A municipal press event about renovated courts, not match play. |
| `Daytona Beach Officer Uses Tennis Racket Against Burglary Suspect…` (Commons) | 942.1 s | Public domain | Police incident footage; the tennis racket is a weapon in a burglary call. |
| `snafuinfinitynews-now_012521-tennis-winn-brook` (Internet Archive) | 704.0 s | CC0 | A Belmont Media Center public-affairs segment: the item description is a Rec Commission meeting "on adding one or two more tennis courts in Winn Brook", and the frames at t≈57 s and t≈147 s are a studio host and a split-screen interview with `Belmont journal / NEWS NOW` lower-thirds. A meeting, not match play. |
| `Althea Gibson - Tennis Champion (USIA Film)` (Commons) | 658.8 s | Public domain | A narrated USIA documentary, not continuous match play: 16 mm black-and-white film intercutting match footage with a flower-presentation ceremony and social scenes (frames at t≈80 s show a fixed-camera court, t≈320 s and t≈480 s show the ceremony and a group in the stands). Its audio track is narration/score, not crowd-and-contact sound, so the audio labels this pass needs are not obtainable, and a 1950s ball at 1440x1080 is a handful of pixels — the full-resolution ball label the issue requires cannot be read from it. |

## The near-misses that matter

These are the longest genuine tennis items found. None clears both bars.

| candidate | duration | licence | why it falls short |
| --- | --- | --- | --- |
| `DoubleACS_GirlsTennis0217`, `DoubleACS_GirlsTennis0417`, `DoubleACS_BoysTennis0317` (Internet Archive) | 6704.6 s / 5803.5 s / 5073.3 s | CC BY-NC-ND 3.0 | Real, full-length school match recordings — the only >5 min continuous tennis match play found anywhere — but the licence is non-commercial **and** no-derivatives, which the gate does not accept and which would also forbid the derived label work this pass needs. |
| `mmuboystennisU3205152024` (Internet Archive) | 4417.7 s | CC BY-NC-ND 4.0 | Same: full varsity match, non-commercial and no-derivatives licence. |
| `Anna Kalinskaya Qualifying for Wimbledon 2019` (Commons) | 1769.6 s declared | CC BY-SA 4.0 | Own work by the uploader (a genuine rights basis) but (a) share-alike, not the gate's CC-BY, and (b) the file is broken: `ffprobe` reports stream `start_time=1558.1`, 5072 frames at ~23.98 fps, i.e. **211.5 s of actual content**, and the frames it does contain are the venue's seating area and spectators, not a court. |
| `Blaž Rola NCAAs 2013` (Commons) | 140.0 s | CC BY 3.0 | Real singles match play, 640x480 — under the 300 s floor and under the resolution needed for full-res ball labels. |
| `Final ATP Viña 2012 Berlocq - Monaco` (Commons) | 88.0 s | CC BY 3.0 | Real match play — under the floor. |
| `2018 Davis Cup Americas Zone - Uruguay vs Mexico` 01, 03–07 (Commons) | 7.0–27.0 s | CC BY-SA 4.0 | Real match play, but 7–27 s segments and share-alike. |
| Polygoon newsreels: `Nederland-Polen voor Davis Cup`, `Tenniswedstrijd Nederland-Zuid-Afrika`, `Tenniswedstrijd Holland-Frankrijk om de Daviscup`, `TENNIS NEDERLAND - JAPAN`, `TENNIS NEDERLAND - ZWITSERLAND` (Commons) | 73.0–131.1 s | Public domain | Newsreel cuts with title cards and voice-over, not continuous play; all under the floor. |
| `EVD-tenis-000…005` (Commons) | 242.8–563.2 s | CC BY-SA 2.5 co | Instructional stroke drill clips at 320x240, not match play, and share-alike. |
| `round-1-vs-almedin-2nd-match` (Internet Archive) | 49.5 s | CC0 | Own-work amateur recording — under the floor. |

The Korean "풀버전" match at 2857.9 s / CC BY 3.0 is **table tennis** (KTTL,
한국프로탁구리그), not tennis; it was screened out by title, not used.

## Verification commands for QA

```bash
# 1. re-run the scan (needs network; ~2 min; 0 errors expected)
python3 evals/tennis_val/scan_rights_candidates.py \
    --out /tmp/rights-candidates.json && echo scan-ok

# 2. the Kalinskaya file's real content length (211.5 s, not 1769.6 s)
curl -sS -A 'highlights-eval-labeller/1.0' -o /tmp/kal.webm \
  'https://upload.wikimedia.org/wikipedia/commons/0/00/Anna_Kalinskaya_Qualifying_for_Wimbledon_2019.webm'
ffprobe -v error -select_streams v -count_frames \
  -show_entries stream=start_time,nb_read_frames,avg_frame_rate -of json /tmp/kal.webm
# frames at t=5 s and t=60 s: venue seating area, no court, no ball

# 3. the licence that rejects the only full-length matches
curl -sS https://archive.org/metadata/DoubleACS_GirlsTennis0217 \
  | jq -r '.metadata.licenseurl'   # -> creativecommons.org/licenses/by-nc-nd/3.0/
curl -sS https://archive.org/metadata/mmuboystennisU3205152024 \
  | jq -r '.metadata.licenseurl'   # -> creativecommons.org/licenses/by-nc-nd/4.0/
```

## What would unblock stage 1

Any one of these, in order of cost:

1. A >= 5 min continuous rights-cleared clip (we own / commissioned / CC-BY /
   public domain / partner with written permission) with >= 12 point-ending
   events. This is the gate's own remedy and needs no policy change.
2. Partner-supplied footage with written permission — same bar, different
   sourcing.
3. A board decision to widen the rights gate. Note that widening to CC BY-SA
   does **not** unblock stage 1 today: the only long share-alike clip is venue
   footage, and the only long full matches are CC BY-NC-ND school recordings,
   which a widened CC BY-NC gate would still not cover and whose
   in-frame ball size at that camera angle has not been assessed. Widening would
   have to come with a licensed clip, not instead of one.

Until one of those lands, tennis stays `unmeasured`: no label manifest, no
`PROFILES["tennis"]` entry, and `load_game_profile("tennis")` keeps raising the
strict `KeyError` (guarded by
`services/perceive/tests/test_game_profile.py::test_tennis_stays_unmeasured_until_a_rights_cleared_manifest_is_committed`).
