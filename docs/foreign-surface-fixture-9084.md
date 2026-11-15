# Foreign-surface fixture + QA delivered-teams lever (ADAAAA-9084)

Why this exists: the score-surface rule (`services/perceive/app/surface_identity.py`,
ADAAAA-8844) can only demote a score change on a surface it can show is a
**different** match. `contradicted` needs the kit channel outside the measured bar
**and** a printed name that does not match the job's teams. Every clip in
`/data/clips` that carries a score bug is the same broadcast — it prints
`RMA 1-1 BAR` with blue plates, `BAR` always maps to Barcelona, and the blue plate
sits inside the 0.44 bar — so exactly one channel always matches and the verdict
was `consistent` on every job (measured 2026-11-15: 8 identity rows, all
`consistent`, 0 demotions table-wide).

Two ways to capture a `contradicted` row: a foreign-surface clip (PIP composite),
or a job whose **delivered** teams are deliberately not the ones the bug prints.
This change ships the second one, plus a named fixture so the proving job is one
`source=file` submit.

## The lever: `POST /jobs` `qaMatchContextTeams`

```
POST /jobs
{
  "source": "file",
  "videoPath": "/data/clips/foreign_surface_qa9084.mp4",
  "gameHint": "soccer",
  "sampleFps": 3,
  "scoreboardRoi": [0, 0, 1, 0.25],
  "qaMatchContextTeams": [
    { "side": "home", "name": "Juventus", "kitColors": [{ "primary": "red" }] },
    { "side": "away", "name": "Liverpool", "kitColors": [{ "primary": "red" }] }
  ]
}
```

Contract (`services/server/src/qa-match-context.ts`):

- **Operator/QA only.** `role === "admin"` (the box QA path) or a user id named in
  `QA_MATCH_CONTEXT_OWNER_IDS`. Anyone else gets `403
  qa_match_context_not_authorized` — the delivered teams are the attribution a
  customer is captioned and metered on, so a normal user may never assert them. It
  is never silently dropped: a lever that quietly did nothing would produce a
  `consistent` row that reads like a rule failure.
- **Validated before any quota/compute gate.** Malformed input is `422
  invalid_qa_match_context_teams` and creates no job row (one or two sides,
  distinct `home`/`away`, a real name — not `unknown` — and at most two colour
  names per side).
- **VOD rail only.** A live/ingest source answers `422
  qa_match_context_live_unsupported`; the live writer re-resolves its own teams.
- **Delivered, not just stored.** The route seeds the job's `matchContext` from
  the lever (`resolverVersion: 0`, trail action
  `qa-override: delivered teams pinned by the QA lever (ADAAAA-9084)`, evidence
  source `qa_override`), so the very first `/analyze` carries the teams through
  `deliveredMatchContextTeams` (`analyzer.ts`), and the VOD match-context resolver
  is **skipped** for an armed job so its 0/25/50/90 % folds cannot overwrite the
  pin. The row also keeps `qaMatchContextTeams`, so the board can see why the job
  says what it says.
- **Inert by default.** Absent input leaves the request byte-identical and the
  record without either key.

## Fixture: `/data/clips/foreign_surface_qa9084.mp4`

| field | value |
|---|---|
| bytes | 52182616 |
| sha256 | `434fdda9faacc4899c1e24a2d6f6370f67dd7195a174117cd8a1f3ade4dd89fd` |
| source | byte-identical copy of `kids95_8483.mp4` |
| duration | 285 s, `source=file`, `gameHint=soccer` |
| printed bug | `RMA 1-1 BAR` → `RMA 2-1 BAR`; plates home `[81,61,98]` (purple), away `[97,105,163]` (blue) |
| GT sidecar | `/data/clips/foreign_surface_qa9084.gt.json` |

The byte-identical copy is deliberate: the clip's own accepted highlight rows
(jobs `ad4dfd77-12d9-4ee2-9d38-85eb1f0a31c2`, `c5dac977-e801-4511-b6fd-97dffffa5965`,
both `done` on the same bytes) carry the GT instants, and they transfer exactly:

| event | window (s) | localized goal (s) | celebration |
|---|---|---|---|
| goal | 17 → 32 | 24 | inside the window tail (anchor + 7 s clip offset) |
| goal | 20 → 35 | 27 | inside the window tail |
| goal | 77 → 92 | 84 | inside the window tail |
| big play | 74 → 89 | 81 | celebration/replay tail, not a goal |

## $0 measurement on the served perceive bytes

Run inside the served `highlights-perceive` container with the stored row's own
reading (`kits home [81,61,98] / away [97,105,163]`, `names ["RMA","BAR"]`) through
the shipped `derive_surface_identity` + `kit_prior_table("soccer")`:

| delivered teams | verdict | kitsDiffer | kitDistance (bar) | names |
|---|---|---|---|---|
| resolved control: `away=Barcelona blue` | `consistent` | false | 0.3539 (0.44) | matched `Barcelona` |
| lever: `home=Juventus red`, `away=Liverpool red` | **`contradicted`** | true | 0.4992 (0.43) | `RMA`, `BAR` unmatched |
| lever green/green | `contradicted` | true | 0.5394 (0.44) | unmatched |
| lever `home=Juventus white`, `away=Liverpool red` | `consistent` | false | 0.1091 (0.44) | unmatched |

The demotion note the armed job should persist:

```
score change on a contradicted score surface: ignored (kits Δ=0.50 > 0.43; printed names RMA, BAR unmatched)
```

Two facts that measurement pins:

- A **name-only** lever is not enough — `home=white` measures 0.1091, inside the
  bar, and the verdict stays `consistent`. The lever must deliver kit colours.
- The control arm on the same clip stays `consistent`, so a `contradicted` row
  cannot come from a disabled rule (ADAAAA-8961 D3-f).

## What this ticket does not do

No metered call is made here. The proving job (~$0.1246, `kids95` shape:
`decideCalls 33`, `summaryCalls 3`, `perceiveSessionS 304.5`) is [ADAAAA-8961]'s
funded pass; this ticket delivers the lever, the fixture and the served build so
that one submit captures D3-a/b/c/e.

[ADAAAA-8961]: /ADAAAA/issues/ADAAAA-8961
