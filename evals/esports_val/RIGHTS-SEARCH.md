# Rights search record — esports (ADAAAA-7768, stage 1 gate)

Stage 1 needs a held-out clip that clears **three** independent bars:

1. **rights basis** — footage we own or commissioned, CC-BY / public-domain, or
   partner-supplied with written permission (CC BY-SA / CC BY-NC* / CC BY-ND*
   and unlicensed broadcast uploads are *not* this gate's CC-BY);
2. **coverage** — ≥ 300 s of continuous real **competitive** play carrying
   ≥ 15 kill/objective events plus ≥ 10 comparable non-event windows;
3. **label-grade event clock** — a scoreboard, objective banner or kill feed that
   a person **can read at native resolution**, so an event instant can be marked
   from pixels to ±1 s. This bar is esports-specific: football/basketball had a
   score bug or score overlay to read, and esports is where the issue forbids
   substituting an automated HUD parse.

This file is the committed record of the search. Machine-readable candidates:
`rights-candidates.json`, reproducible with:

```
python3 evals/esports_val/scan_rights_candidates.py \
    --out evals/esports_val/rights-candidates.json
```

Last run: exit 0, **0 request errors**; 635 Commons titles + the Internet Archive
queries screened **851 metadata rows**, 696 dropped as not esports, **155 esports
candidates**, **8 qualifying** on licence + duration pending frame review. The
counts move a little between runs because both corpora's ranking drifts, so the
pinned candidates (not the counts) are what makes this record stable.

## What was screened

| corpus | query shape | rows |
|---|---|---|
| Wikimedia Commons | 13 searches (`esports`, `esports tournament`, `electronic sports`, `valorant`, `counter-strike`, `league of legends`, `dota`, `starcraft`, `overwatch`, `rocket league`, `multiplayer gameplay`, `deathmatch`, `intitle:esports`, each `filetype:video`) + 3 categories (`Videos of esports`, `Esports videos`, `Videos of video games`) | see `counts.commons_titles` |
| Internet Archive | 6 advanced-search queries over `mediatype:movies` with a creative-commons or public-domain `licenseurl` (esports, the named titles, `subject:esports`, `tournament AND gaming`, `creator:onfoss`, open-source-game titles) + 5 pinned identifiers | see `counts.metadata_rows_screened` |

A title/description scan cannot tell competitive play from a review, a trailer, a
military public-affairs feature or an unlicensed VOD re-upload, so relevance is
filtered explicitly (`esports_relevant`) and every surviving row is recorded
whether it qualifies or not, so the next reader does not re-screen it.

## What cleared rights + duration, and what happened on frames

### Used: the onFOSS 2023-09-23 tournament livestream (CC0)

`on-foss-2023-09-23-hypersomnia-and-stk-tournament-livestream` →
`sh_onfoss_20230923_tournament.mp4`

- **rights basis: CC0 1.0** (`https://creativecommons.org/publicdomain/zero/1.0/`),
  creator `onfoss`, uploader `gnudist@tutanota.com` — the event organiser
  publishing its own tournament stream. This is the cleanest basis available
  anywhere in the open corpora (a real dedication, not a third-party claim).
- content: 5950.549 s (99 min) of a live competitive event — a **Hypersomnia**
  (open-source 2D arena shooter) session the game's developer joined, then the
  **SuperTuxKart tournament** — moderated/commentated by `SporeTec`, with the
  onFOSS overlay, webcam and chat panel.
- file actually served: `…-240p.mp4`, **426x240**, h264 + aac 48 kHz stereo,
  435,639,290 bytes, sha256
  `3da355cc6ffc5e0fa5bbffa25c3025b165cee7bbddd3e96b8f0746a11801b264`.
- **what carries labels, and what does not:** the **SuperTuxKart tournament**
  half (t ≳ 4245 s) carries a native-resolution **race clock** (`MM:SS.mmm`
  readable at 1x), an official **event banner** (`Final lap!`,
  `You finished the race in rank N`) and a **lap counter** (`N/3`) — that half is
  labelled in `evals/supertuxkart_val/label-manifest.json` (15 objective events,
  13 non-event windows; see `evals/supertuxkart_val/RESULTS.md`). The earlier
  **Hypersomnia** half does **not** carry a label-grade event channel: at 426x240
  the HUD bands read empty at 6x beyond the `onFOSS` brand, and the left overlay
  (event schedule + chat) and the top-right webcam occupy where a HUD would sit,
  so no event instant is readable to ±1 s there. That half is **unlabelled** and
  is reported separately rather than scored.
- **erratum (revision 2, from QA on [ADAAAA-7793](/ADAAAA/issues/ADAAAA-7793)):**
  revision 1 described this as an *observer/spectator* capture quoting a banner
  *"You are a Spectator. Press 'Y' to change teams."* at t=300 s and t=1500 s. QA
  read those frames: the string is **not** there (only `onFOSS` and the schedule
  panel), and a 10 s sweep finds "spectator" only twice, both in chat lines
  (t≈5325, 5505). The quote is withdrawn; it was never the reason labels were
  missing, and the SuperTuxKart clock was.
- **No automated HUD parse was attempted**, because the issue forbids one:
  labels parsed from the HUD and then scored against the same parse is circular.
  The label pass reads text bands (clock / banner / lap counter) as a reader, and
  the audio gate that scores them never sees the HUD.
- the item's **1080p original is not served**: only a BitTorrent stub is listed
  (`…-1080p.torrent`) and the HTTP path for the 1080p file redirects to a **404**
  (verified). The 240p derivative is the whole obtainable file.

### The 720p corpus the licence gate excludes: Xonotic duels (CC BY-SA)

Three real competitive 1v1 duels, 1280x720, uploaded by the player who recorded
them:

| item | duration | licence |
|---|---|---|
| `xonotic-draena-vs-craven-downer` | 628 s | CC BY-SA 4.0 |
| `xonotic-draena-vs-craven-silentsiege` | 625 s | CC BY-SA 4.0 |
| `xonotic-draena-vs-craven-fuse` | 749 s | CC BY-SA 4.0 |

- `creator: Draena`, `licenseurl: http://creativecommons.org/licenses/by-sa/4.0/`
  — a public licence from the creator, i.e. a demonstrable rights basis, but
  **CC BY-SA is not the basis this gate names**. Football's scan made the same
  call (`needs_policy_decision`), so widening it is a **board policy decision**,
  not a Developer one. Recorded here rather than silently used.
- additionally, the frames reviewed from `xonotic-draena-vs-craven-downer`
  (t=30 s, t=300 s) show the streamer overlay, a match timer (`4:54`), health
  (`100`) and armour (`142`) — but **no visible frag counter** in the regions
  probed. So a licence widening alone does not yet buy a label clock; the HUD
  layout would need its own review pass.

### Rejected on coverage, not rights

- **`File:America's Army 2.5.0 - Multiplayer gameplay montage.webm`** (public
  domain, 501.8 s, 1080p) — a kill **compilation**: kills back to back and
  therefore no comparable non-event windows. Also a montage, not continuous
  competitive play.
- **`File:America's Army 2.8.5 Special Forces Multiplayer Long Weapons.webm`**
  (public domain, 817 s) — a weapon showcase capture, not a match; and no
  objective clock.
- **`File:Age of Empires IV- Multiplayer Match.webm`** (CC BY 3.0, 2634 s) — the
  one candidate this pass did **not** frame-review: it clears rights and
  duration on metadata and is the strongest remaining lead (a real RTS match).
  Whether its HUD gives a pixel-readable objective event (building/unit-loss
  banner, score panel) is unresolved. Named as the first item of the next pass
  rather than claimed.
- **60 s military public-affairs features** (`PACAF ESPORTS`, `Yokota Esports
  Tournament of Champions`, `Ramstein … Allied Forces Esports Invitational`,
  `374th FSS Esports and Tabletop Tournaments`) — public domain, but 60 s of
  venue/people b-roll below the 300 s floor, and not gameplay.
- **`File:Pixel by pixel- Army eSports` / `Soldiers Represent the U.S. Army in
  Esports`** (285.8 s) — profile/recruitment pieces about esports, not play, and
  below the floor.
- **Review/showcase captures** (`ChrisWere-*` OpenArena/Red Eclipse/Xonotic,
  0 A.D. gameplay preview, SuperTux gameplay) — licence-clean but single-player
  demonstrations with no competitive events to label.
- **`youtube-jWjrdz-lLdU` "Worlds 2024 - T1 vs BLG - Grand Final"** and the
  `…-lol-worlds-2020-…-full-game` items — marked CC BY / CC0 **by third-party
  uploaders** of a rights-holder's broadcast. The claim is not the rights
  holder's, so these are not a rights basis (the `cornhuskercollection` trap from
  the football search, in esports form).

## What would unblock a label-grade set

In priority order, and all of it is *evidence*, not permission:

1. **Frame-review `Age of Empires IV- Multiplayer Match`** (CC BY 3.0, 44 min,
   already clearing rights + duration) for a readable objective event channel.
2. **A board ruling on CC BY-SA** for eval use (Xonotic duels, 720p, real
   competitive matches) — with the share-alike recorded on any derived labels.
   This widens the corpus for every remaining type, not only esports.
3. **A rights-cleared broadcast with a scoreboard/kill feed at ≥ 720p** — the
   same shape that made basketball (CC BY 3.0 federation broadcast) and football
   (CC0 community-access broadcast) measurable. For esports the open corpora
   simply do not carry one today: the well-known tournament VODs are unlicensed
   re-uploads, and the licensed ones are not published under an open licence.
