# Match-context prompt injection (`matchContext`)

Who is playing is resolved **once per job** by the resolver (perceive + the
server's bounded ASR prefix) and persisted on the job record as `matchContext`
(`packages/events` `MatchContextSchema`). Every LLM window inspection then *reads*
that stored record and renders one compact prompt block, so captions name the
real teams instead of inventing one (the "German defender" on a Portugal vs Spain
job).

Nothing here recomputes teams per window: the only new work per decide call is a
pure string render. There is **no extra inference call**.

## Contract

`POST /app/highlight` (and the grouped variant) accept an additive optional
`matchContext`:

```json
{
  "sport": "soccer",
  "ambiguous": false,
  "teams": [
    { "name": "Portugal", "side": "home", "confidence": 0.95,
      "kitColors": [{ "primary": "red", "secondary": "green" }] },
    { "name": "Spain", "side": "away", "confidence": 0.95,
      "kitColors": [{ "primary": "white", "secondary": "navy" }] }
  ]
}
```

`POST /app/title` accepts the same field (the one title call per job inherits it,
so titles/chapters stop inventing teams).

Server side, `buildObserveDecideRequest` reads it through
`AnalyzerConfig.getMatchContext` (mirrors `getRunningSummary`) — a storage read
injected in `services/server/src/api.ts`, never a resolver call. The browser-capture
direct decide path forwards the same stored value.

## Rendered block

Only rendered when the context carries a usable team name:

```
MATCH CONTEXT (inferred, authoritative for naming):
  home: Portugal — red shirts, green trim
  away: Spain — white shirts, navy trim
  Rule: name only the teams above. Never infer a team or nationality from kit colour, logo, language or appearance. If a side is unknown, say "the defender" — not a country.
```

The same rule is appended to the output contract so it also governs
`runningSummary` (the narrative field where the wrong nationality was invented).
Esports contexts switch the wording to side/agent colours and "the player".

Budget: block ≤ 480 chars, measured whole-window delta ~520 chars (~130 tokens)
on the board-cited job. Pinned by `services/decide/tests/test_match_context_prompt.py`.

## Guarantees

- **No context, no change.** Absent/unusable `matchContext` renders `""`. The
  prompt, the decide request payload, and the `/app/title` body are
  byte-identical to the pre-feature text (a sha256 of the prompt is pinned in the
  test, captured from the code before this change).
- **Never a 422.** A malformed context (teams as a string, a team with no name,
  an out-of-range confidence) is sanitised: unknown fields dropped, entries
  skipped, and a context with no usable team renders empty. Unknown fields on
  the wire are ignored (`extra="ignore"`).
- **Never guesses a side.** `side: "unknown"` is rendered as `side unknown`, and
  `ambiguous: true` adds an explicit "do not guess" line. The resolver's
  `"unknown"` team name is never forwarded.

## Attributions scan (AC2)

`services/decide/app/team_attribution_scan.py` flags team/nationality strings in
captions/narratives that the job's `matchContext` does not sanction:

```bash
cd services/decide
python -m app.team_attribution_scan \
  --match-context job-match-context.json \
  --text window-narratives.json        # JSON list, or {"texts": [...]}
# exit 1 on any hit; JSON report names index + token + team + offset
```

Sanctioned terms are the context's team names, their demonyms
("Portugal" → "Portuguese") and any word in the context's evidence snippets.
Everything else in the built-in country/demonym + club lexicon is a hit — e.g.
"The German defender clears" on a Portugal vs Spain job reports
`{"token": "German", "team": "Germany"}`.
