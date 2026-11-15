/**
 * ADAAAA-9084: the QA delivered-teams LEVER — a job field that sets the teams the
 * pipeline delivers for ONE job, so the delivered side is deliberately not the
 * side the score bug prints.
 *
 * Why this exists. The score-surface rule (ADAAAA-8844) can only DEMOTE a score
 * change on a surface it can show is a different match: `contradicted` needs the
 * kit channel outside the measured bar AND a printed name that does not match
 * the job's teams. Every clip in `/data/clips` that carries a score bug is the
 * same broadcast (`RMA 1-1 BAR`, blue plates), and `BAR` always maps to
 * Barcelona, so on the served corpus exactly one channel always matches and the
 * verdict is always `consistent` — measured 2026-11-15: 0 contradicted rows
 * table-wide, 0 demotions. A PROVING row therefore needs either a foreign clip
 * (PIP composite) or a job whose DELIVERED teams are not the ones the bug
 * prints. `POST /jobs` had no teams field at all and the only mid-analysis hint
 * is the source filename (`parse_metadata_hints`), which moved one side only
 * (job `925f114b`: home=Arsenal@0.15 via metadata, away stayed OCR-resolved).
 *
 * This module owns the three IO-free pieces:
 *
 *  1. `parseQaMatchContextTeams` — the validation gate for the submitted field.
 *     Absent input is `{ ok: true, teams: undefined }`, so a normal submit stays
 *     byte-identical.
 *  2. `qaMatchContextAuthorized` — the AUTHORITY gate. The delivered teams are
 *     the attribution a customer is metered and captioned on, so a normal user
 *     may never assert them: only an operator/QA (`role === "admin"`, the box
 *     QA path) or a user named in `QA_MATCH_CONTEXT_OWNER_IDS` may. An
 *     unauthorised submit is a 403, never a silent drop — a lever that silently
 *     does nothing is the exact failure this ticket was filed for.
 *  3. `qaMatchContextSeed` / `qaMatchContextArmed` — the seeded `matchContext`
 *     record (so the teams are delivered before the first `/analyze`, auditable
 *     on the job row, and survive the whole pass) and the predicate the VOD
 *     worker reads to SKIP the match-context resolver, which would otherwise
 *     overwrite the pinned reference at its 25/50/90 % re-checks.
 *
 * The lever is inert by default: no job carries `qaMatchContextTeams`, no
 * resolver is skipped, and every `/analyze` body / job record is unchanged.
 */
import { MatchContextSchema, type MatchContext, type MatchContextTeam } from "@highlights/events";

/** One delivered side, as submitted. `kitColors` are colour NAMES (`red`), the
 *  same vocabulary `MatchContextTeamSchema` carries and perceive's kit reference
 *  resolves (`name_reference_rgb`). */
export interface QaMatchContextTeamInput {
  side: "home" | "away";
  name: string;
  kitColors: { primary: string; secondary?: string }[];
}

export type QaMatchContextTeamsParseResult =
  | { ok: true; teams: MatchContextTeam[] | undefined }
  | { ok: false; message: string; code: string };

/** A team name is a reference, not a placeholder: `unknown` cannot pin anything. */
const MIN_NAME = 2;
const MAX_NAME = 60;
const MAX_KIT_COLOURS = 2;
const MAX_COLOUR_NAME = 20;

/** The provenance string stamped on every seeded team + trail entry. */
export const QA_MATCH_CONTEXT_SOURCE = "qa_override";
export const QA_MATCH_CONTEXT_ACTION = "qa-override: delivered teams pinned by the QA lever (ADAAAA-9084)";

function bad(message: string): QaMatchContextTeamsParseResult {
  return { ok: false, message, code: "invalid_qa_match_context_teams" };
}

/**
 * Validate a submitted `qaMatchContextTeams`.
 *
 * Contract: absent (`undefined`/`null`) is a valid "no lever". Present, it is an
 * array of ONE or TWO entries, one per side (`home`/`away`), each with a real
 * team name and zero to two kit colours named from the shipped kit vocabulary
 * shape (`{primary, secondary?}`). Anything else is a 422 at job create — a
 * malformed lever would otherwise deliver a half-pinned attribution and the
 * proving job would measure the parsing, not the rule.
 */
export function parseQaMatchContextTeams(input: unknown): QaMatchContextTeamsParseResult {
  if (input === undefined || input === null) return { ok: true, teams: undefined };
  if (!Array.isArray(input)) return bad("qaMatchContextTeams must be an array of {side, name, kitColors?}");
  if (input.length < 1 || input.length > 2) {
    return bad("qaMatchContextTeams must name one or two sides (home/away)");
  }
  const seen = new Set<string>();
  const teams: MatchContextTeam[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return bad("qaMatchContextTeams entries must be objects {side, name, kitColors?}");
    }
    const entry = raw as Partial<QaMatchContextTeamInput> & Record<string, unknown>;
    const side = entry.side;
    if (side !== "home" && side !== "away") {
      return bad("qaMatchContextTeams[].side must be \"home\" or \"away\"");
    }
    if (seen.has(side)) return bad(`qaMatchContextTeams names side "${side}" twice`);
    seen.add(side);
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    if (name.length < MIN_NAME || name.length > MAX_NAME) {
      return bad(`qaMatchContextTeams[].name must be a team name (${MIN_NAME}-${MAX_NAME} chars)`);
    }
    if (name.toLowerCase() === "unknown") {
      return bad("qaMatchContextTeams[].name cannot be \"unknown\" — a pin needs a real team");
    }
    const kitsRaw = entry.kitColors === undefined || entry.kitColors === null ? [] : entry.kitColors;
    if (!Array.isArray(kitsRaw) || kitsRaw.length > MAX_KIT_COLOURS) {
      return bad(`qaMatchContextTeams[].kitColors must be an array of at most ${MAX_KIT_COLOURS} colours`);
    }
    const kitColors: { primary: string; secondary?: string }[] = [];
    for (const kit of kitsRaw) {
      if (!kit || typeof kit !== "object" || Array.isArray(kit)) {
        return bad("qaMatchContextTeams[].kitColors entries must be {primary, secondary?}");
      }
      const k = kit as Record<string, unknown>;
      const primary = typeof k.primary === "string" ? k.primary.trim() : "";
      if (primary.length < 1 || primary.length > MAX_COLOUR_NAME) {
        return bad(`qaMatchContextTeams[].kitColors[].primary must be a colour name (1-${MAX_COLOUR_NAME} chars)`);
      }
      if (k.secondary !== undefined && k.secondary !== null) {
        if (typeof k.secondary !== "string" || !k.secondary.trim() || k.secondary.trim().length > MAX_COLOUR_NAME) {
          return bad(`qaMatchContextTeams[].kitColors[].secondary must be a colour name (1-${MAX_COLOUR_NAME} chars)`);
        }
        kitColors.push({ primary, secondary: k.secondary.trim() });
      } else {
        kitColors.push({ primary });
      }
    }
    teams.push({
      name,
      side,
      kitColors,
      // A lever is an assertion, not a measurement: it carries no confidence
      // ramp, and the evidence block is the ONLY thing that explains the value
      // to a later reader of the job row.
      confidence: 1,
      evidence: [{ source: QA_MATCH_CONTEXT_SOURCE, snippet: QA_MATCH_CONTEXT_ACTION }],
    });
  }
  return { ok: true, teams };
}

/**
 * Who may arm the lever: an operator/QA session (`role === "admin"` — the box QA
 * recipe logs in as the admin account) or a user id named in
 * `QA_MATCH_CONTEXT_OWNER_IDS` (comma-separated, the "comped owner" case). The
 * env list is additive; it never widens the admin path and an empty/unset list
 * grants nothing.
 */
export function qaMatchContextAuthorized(
  user: { id?: string; role?: string } | undefined | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!user) return false;
  if (user.role === "admin") return true;
  const id = String(user.id || "").trim();
  if (!id) return false;
  const allowed = String(env.QA_MATCH_CONTEXT_OWNER_IDS || "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  return allowed.includes(id);
}

/** Whether a stored job carries the QA lever (the VOD worker's skip predicate). */
export function qaMatchContextArmed(job: { qaMatchContextTeams?: unknown } | undefined | null): boolean {
  const teams = job?.qaMatchContextTeams;
  return Array.isArray(teams) && teams.length > 0;
}

/**
 * The `matchContext` block seeded at job create for an armed job.
 *
 * It is a real `MatchContextSchema` record (parsed here, so a malformed seed can
 * never reach the job store), `resolverVersion: 0` and an `ambiguous: false`
 * context whose trail names the lever — so the record explains itself and a
 * reader cannot mistake a QA pin for a resolved attribution. The resolver never
 * runs on an armed job (see `qaMatchContextArmed`), so this block is what
 * perceive is delivered on every `/analyze` for the whole pass.
 */
export function qaMatchContextSeed(
  teams: MatchContextTeam[],
  opts: { sport?: string; at?: string } = {}
): MatchContext {
  const at = opts.at ?? new Date().toISOString();
  return MatchContextSchema.parse({
    sport: opts.sport || "soccer",
    teams,
    inferredAt: at,
    resolverVersion: 0,
    ambiguous: false,
    trail: [
      {
        at,
        progressPct: 0,
        names: teams.map((t) => ({ side: t.side, name: t.name, confidence: t.confidence })),
        action: [QA_MATCH_CONTEXT_ACTION],
      },
    ],
  });
}
