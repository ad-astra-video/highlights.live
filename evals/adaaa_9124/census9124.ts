/**
 * ADAAAA-9124 — the LIVE deck's serve-yield census, as a FUNCTION.
 *
 * `replay9124.ts` is the CLI that prints this census over a stored-row corpus;
 * this module is the same read without the CLI, so a test can hold the fixture's
 * yield as a regression gate in CI (`services/server/test/deck-yield-9124.test.ts`)
 * instead of a number a human has to re-check. Nothing here calls a model, a job,
 * or the DB: it reads rows a served build already wrote and re-judges their bytes
 * through the SAME evidence mapper (`summaryEvidenceForRow`) and gate
 * (`gateSummaryDetail`) the lane uses.
 */
import {
  gateSummaryDetail,
  serveAttestedMatchClock,
  summaryOpeningRun,
  summarySentenceFacts,
  unattestedAtmosphereClaims,
} from "../../packages/events/src/highlight-summary.js";
import { summaryEvidenceForRow, summaryRepeatKey, newSummaryJobState } from "../../services/server/src/summary-lane.js";

export interface StoredRow {
  jobId: string;
  id: string;
  body: string | null;
  servedSummary: string | null;
  rawSummary: string | null;
  eventType?: string | null;
  outcome?: string | null;
  reason?: string | null;
  caption?: string | null;
  postTitle?: string | null;
  postTitleGate?: string | null;
  trigger?: { timestamp?: number; durationS?: number } | null;
  start?: number;
  end?: number;
  matchClock?: {
    token?: string | null;
    seconds?: number | null;
    period?: string | null;
    legible?: boolean | null;
  } | null;
  deferredAttestation?: unknown;
  attestationUsed?: unknown;
  goalConfirmed?: string | null;
  confirmAttestation?: { goalConfirmed?: string | null } | null;
  asrTranscript?: string | null;
  storedSummaryGate?: string | null;
  summaryViolations?: string[] | null;
  attestationAuthority?: string | null;
}

export interface StoredDump {
  jobId: string;
  source: string;
  sourceUrl: string;
  matchContext?: unknown;
  fixture?: { legs: number; rows: number; legIds: string[]; costUsdByLeg: Record<string, string> };
  matchContextByLeg?: Record<string, unknown>;
  rows: StoredRow[];
}

export interface LegTally {
  jobId: string;
  rows: number;
  auth: number;
  served: number;
  storedServed: number;
  refused: number;
  refusedReasons: Record<string, number>;
}

export interface ServedDetail {
  jobId: string;
  id: string;
  served: boolean;
  violations: string[];
  body: string;
}

export interface CensusTotals {
  rows: number;
  auth: number;
  served: number;
  storedServed: number;
  refused: number;
  reasons: Record<string, number>;
}

export interface Census {
  legs: LegTally[];
  totals: CensusTotals;
  detail: ServedDetail[];
}

/**
 * Grade one stored-row corpus. `rows` is the deck's denominator (what promotion
 * actually made); `served` is what the gate serves on the bytes stored (a dropped
 * row's `summaryRaw` draft is graded, because a lever moves drafts, not drops).
 */
export function censusFixture(dump: StoredDump): Census {
  /** The surface a leg reads: its own context when it differs from the fixture's
   *  anchor, else the anchor stored once on the corpus. */
  const contextByLeg: Record<string, unknown> = dump.matchContextByLeg ?? {};
  const anchorContext: unknown = dump.matchContext ?? null;
  const contextFor = (jobId: string): unknown => contextByLeg[jobId] ?? anchorContext;

  const evidenceOf = (row: StoredRow) =>
    summaryEvidenceForRow(
      {
        verdict: null,
        outcome: row.outcome ?? null,
        eventType: row.eventType ?? null,
        reason: row.reason ?? null,
        caption: row.caption ?? null,
        postTitle: row.postTitle ?? null,
        trigger: row.trigger ?? null,
        start: row.start,
        end: row.end,
        matchClock: row.matchClock ?? null,
        deferredAttestation: row.deferredAttestation as any,
        attestationUsed: row.attestationUsed as any,
        goalConfirmed: row.goalConfirmed ?? null,
        confirmAttestation: row.confirmAttestation ?? null,
        asrTranscript: row.asrTranscript ?? null,
        matchContext: contextFor(row.jobId),
      },
      "live"
    );

  const byJob = new Map<string, LegTally>();
  const totals: CensusTotals = { rows: 0, auth: 0, served: 0, storedServed: 0, refused: 0, reasons: {} };
  const detail: ServedDetail[] = [];

  for (const jobId of [...new Set(dump.rows.map((r) => r.jobId))]) {
    const legRows = dump.rows.filter((r) => r.jobId === jobId);
    const tally: LegTally = {
      jobId,
      rows: legRows.length,
      auth: 0,
      served: 0,
      storedServed: 0,
      refused: 0,
      refusedReasons: {},
    };
    // AC8's repeat key is per JOB: a body that repeats an opening/sentence already
    // served on this leg is not a distinct card, so it must not count as one.
    const state = newSummaryJobState();

    for (const row of legRows) {
      const authority = row.attestationAuthority ?? null;
      if (authority !== null && authority !== "none") tally.auth += 1;
      if (row.servedSummary) tally.storedServed += 1;
      if (!row.body) continue;

      const evidence = evidenceOf(row);
      const decision = gateSummaryDetail(row.body, evidence);
      if (decision.summary === null) {
        tally.refused += 1;
        for (const v of decision.violations) {
          tally.refusedReasons[v] = (tally.refusedReasons[v] ?? 0) + 1;
          totals.reasons[v] = (totals.reasons[v] ?? 0) + 1;
        }
        detail.push({ jobId, id: row.id, served: false, violations: decision.violations, body: row.body });
        continue;
      }

      const clocked = serveAttestedMatchClock(decision.summary, evidence);
      const repeat = summaryRepeatKey(clocked.text, evidence, state.servedBodies);
      if (repeat.key !== null) {
        tally.refused += 1;
        tally.refusedReasons[`repeat:${repeat.key}`] = (tally.refusedReasons[`repeat:${repeat.key}`] ?? 0) + 1;
        totals.reasons[`repeat:${repeat.key}`] = (totals.reasons[`repeat:${repeat.key}`] ?? 0) + 1;
        detail.push({ jobId, id: row.id, served: false, violations: [`repeat:${repeat.key}`], body: clocked.text });
        continue;
      }
      // AC14 self-check: a served body that carries an unattested clause would
      // inflate this yield read, so the replay refuses to count one. Same lens the
      // 8941 corpus gate uses (`unattestedAtmosphereClaims`) plus the sentence lens.
      const clauseViolations = [
        ...unattestedAtmosphereClaims(clocked.text, evidence),
        ...summarySentenceFacts(clocked.text, evidence)
          .filter((report) => report.claims.length > 0)
          .map((report) => report.sentence),
      ];
      if (clauseViolations.length > 0) {
        tally.refused += 1;
        tally.refusedReasons["ac14-clause"] = (tally.refusedReasons["ac14-clause"] ?? 0) + 1;
        totals.reasons["ac14-clause"] = (totals.reasons["ac14-clause"] ?? 0) + 1;
        detail.push({ jobId, id: row.id, served: false, violations: ["ac14-clause"], body: clocked.text });
        continue;
      }
      state.servedBodies.push({
        highlightId: row.id,
        windowTs: evidence.windowTs ?? null,
        windowDurationS: evidence.windowDurationS ?? null,
        clockToken: (row.matchClock?.token ?? null) as string | null,
        body: clocked.text,
        opening: summaryOpeningRun(clocked.text),
      });
      tally.served += 1;
      detail.push({ jobId, id: row.id, served: true, violations: [], body: clocked.text });
    }

    totals.rows += tally.rows;
    totals.auth += tally.auth;
    totals.served += tally.served;
    totals.storedServed += tally.storedServed;
    totals.refused += tally.refused;
    byJob.set(jobId, tally);
  }

  return { legs: [...byJob.values()], totals, detail };
}

/** served / rows — the fraction the deck bar multiplies. */
export const servedYield = (c: Census): number => (c.totals.rows === 0 ? 0 : c.totals.served / c.totals.rows);
