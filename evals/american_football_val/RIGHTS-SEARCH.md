# Rights search record — american football (ADAAAA-7767, stage 1 gate)

Stage 1 needs a held-out clip that clears **two** independent bars:

1. **rights basis** — footage we own or commissioned, CC-BY / public-domain, or
   partner-supplied with written permission (CC BY-SA / CC BY-NC* / CC BY-ND*
   and unlicensed broadcast uploads are *not* this gate's CC-BY);
2. **coverage** — ≥ 300 s of continuous real game play carrying ≥ 6 scoring
   plays plus ≥ 10 comparable non-event windows.

This file is the committed record of the search. Machine-readable candidates:
`rights-candidates.json`, reproducible with:

```
python3 evals/american_football_val/scan_rights_candidates.py \
    --out evals/american_football_val/rights-candidates.json
```

Last run: exit 0, **0 request errors**.

## What was screened

| corpus | query shape | rows |
|---|---|---|
| Wikimedia Commons | 11 searches (`american football`, `college football`, `high school football`, `varsity football`, `NFL`, `NCAA`, `touchdown`, `gridiron`, `intitle:football`, each `filetype:video`) + 2 categories (`Videos of American football`, `American football videos`) | 459 titles |
| Internet Archive | 4 advanced-search queries over `mediatype:movies` with a creative-commons or public-domain `licenseurl` + 4 pinned identifiers | — |

Totals: **616 metadata rows screened**, 537 dropped as not american football
(association football / rugby / table football / game emulation dominate the
"football" corpus), **79 american-football candidates**, **21 clearing licence +
duration**, all of which were then frame-reviewed.

## What cleared both bars and was frame-reviewed

Six full-length **community-access broadcast recordings** of real games from
Belmont Media Center (Belmont MA), published CC0 / public-domain by the
producing station itself:

| item | duration | licence | content |
|---|---|---|---|
| `snafuinfinityfootball_090425-vs-waltham-4IA` | 9011 s | CC0 | Belmont vs Waltham, 2025 |
| **`snafuinfinityfootball_092123-vs-westford`** | **8391 s** | **CC0** | **Belmont vs Westford, 2023-09-21 — USED** |
| `snafuinfinityfootball_092521-vs-burlington` | 7264 s | Public domain | Belmont vs Burlington |
| `snafuinfinityfootball_092625-vs-lexington` | 7130 s | CC0 | Belmont vs Lexington |
| `snafuinfinityfootball_100121-vs-reading` | 6860 s | Public domain | Belmont vs Reading |
| `snafuinfinityfootball_vsWinchester_100518-CL19` | 6630 s | Public domain | Belmont vs Winchester, 2018 |

Also hand-reviewed and equivalent on rights: `ThanksgivingGame2013CL10`
(`https://archive.org/details/ThanksgivingGame2013CL10`), the Belmont/Worthington
Thanksgiving game, same producer, Public-domain mark; superseded by the CC0
854x480 upload above, which is a proper dedication rather than a PD mark.

## The clip used

`snafuinfinityfootball_092123-vs-westford` → `football_092123-vs-westford.mp4`

- 854x480 (the earlier Belmont upload was 640x360), h264 + aac, 8391.232 s,
  817,579,377 bytes, sha256 `ad12b10b804c5a8cd164e3a4bf32281ed18098bc03b9ee510fc9df87a6df1aeb`
- **rights basis: CC0 1.0** (`https://creativecommons.org/publicdomain/zero/1.0/`),
  creator *Belmont Media Center*, uploader `access@belmontmedia.org` — the
  producing rights holder publishing its own broadcast
- content: one continuous varsity game (Marauders vs Grey Ghosts) with
  **on-screen score bug** (score, period, clock), **commentators** (Todd
  Bloniarz, Aram Parnagian), crowd and PA audio — which is what makes it usable
  for the audio-trigger rule at all. A silent clip would have measured nothing.

## What was rejected, and why

- **FOX Sports college-football highlight reels** (`Northwestern vs. Michigan`,
  `Oregon vs. Washington St`; CC BY 3.0, 240 s and 273 s) — a clean licence but
  below the 300 s floor, and a highlight reel has no comparable non-event
  windows (it is scoring plays back to back). Rejected on coverage, not rights.
- **`cornhuskercollection_volume3`** (CC0 on paper, 5195 s) — the 1971
  "Game of the Century" as a 1986 *Instant Replay, Inc.* commercial VHS release.
  The CC0 claim was made by a third-party uploader, not the rights holder. Not
  accepted.
- **`HillCountryCowboysVHornefrogsRealGame`** (CC0, 3499 s, youth spring-league
  game) — acceptable rights, own-upload by the club; rejected on content after
  frame review: single fixed camera, no score bug, sparse scoring, and no
  broadcast audio bed to measure the gate against.
- **`varsity-football-live-2022`** (PD mark) — the item is a redirect page with a
  113 s placeholder file, not the game.
- **`UsdTorerosVs.*`, `rg381_*`, `NorthCountyStarsVs.*`, `St.AugustineSaints*`,
  `AO_04_00*`** — real full games, but CC BY-ND / CC BY-NC-ND. The
  NoDerivatives term would also forbid the derived label work, so these are not
  a widened-gate question, they are out.
- **Commons press conferences, presidential ceremonies, security briefings,
  halftime shows, Mars landings** — licence-clean and long, but not game play.
  They matched the `NFL` / `touchdown` queries and are recorded in
  `rights-candidates.json` so the next reader does not re-screen them.

## What would unblock a *better* set

A rights-cleared clip with a **reliable** score bug (or a score overlay from a
broadcast graphics package) would let the label set be derived mechanically
rather than by operator-entry reads. The clip used here has a manual score bug
that was observed disagreeing with itself at half time (see the manifest's
`video.bug_anomaly`). Rights-cleared football with machine-readable overlays is
the gap; it is not a licence-gate gap.
