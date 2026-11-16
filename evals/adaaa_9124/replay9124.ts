/**
 * ADAAAA-9124 `$0` replay — the LIVE deck's serve-yield census, read from stored rows.
 *
 * The deck bar (`>= 10` servable refurbished bodies on one live leg) is a
 * serve-yield question, and a leg costs money. So the census that grades a fixture
 * and a lever runs HERE: over rows a served build already wrote, through the SAME
 * evidence mapper the lane uses (`summaryEvidenceForRow`) and the SAME gate
 * (`gateSummaryDetail`). No model call, no job, no billing, no DB write.
 *
 * Usage (from the repo root, on the box or in the served container):
 *
 *   ./node_modules/.bin/tsx evals/adaaa_9124/replay9124.ts \
 *     evals/adaaa_9124/live-deck-kids95_8483.json [--json] [--min-yield 0.286]
 *
 * It prints, per leg and for the whole fixture:
 *   rows        stored rows (the deck's denominator — what promotion actually made)
 *   auth        rows whose `attestationUsed.authority` is frame/scoreboard (the
 *               only rows with something legal to say; `none` rows are the rev-17
 *               class that measured nothing)
 *   served      rows the gate SERVES on the bytes stored (stored `summary`, else
 *               the writer's `summaryRaw` draft — a dropped row's draft is what a
 *               lever moves, so it must be graded, not skipped)
 *   yield       served / rows — the fraction the deck bar has to multiply by
 *   auth-yield  served / auth — the fraction once rows with no measured authority
 *               are excluded from the denominator (AC3's second option)
 *
 * Exit 1 when `--min-yield` is given and the fixture's yield is under it, so the
 * tool doubles as a regression gate for the yield read.
 */
import { readFileSync } from "node:fs";
import {
  gateSummaryDetail,
  serveAttestedMatchClock,
  summaryOpeningRun,
  summarySentenceFacts,
  unattestedAtmosphereClaims,
} from "../../packages/events/src/highlight-summary.js";
import {
  summaryEvidenceForRow,
  summaryRepeatKey,
  newSummaryJobState,
} from "../../services/server/src/summary-lane.js";

interface StoredRow {
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
  matchClock?: { token?: string | null; seconds?: number | null; period?: string | null; legible?: boolean | null } | null;
  deferredAttestation?: unknown;
  attestationUsed?: unknown;
  goalConfirmed?: string | null;
  confirmAttestation?: { goalConfirmed?: string | null } | null;
  asrTranscript?: string | null;
  storedSummaryGate?: string | null;
  summaryViolations?: string[] | null;
  attestationAuthority?: string | null;
}

interface StoredDump {
  jobId: string;
  source: string;
  sourceUrl: string;
  matchContext?: unknown;
  fixture?: { legs: number; rows: number; legIds: string[]; costUsdByLeg: Record<string, string> };
  matchContextByLeg?: Record<string, unknown>;
  rows: StoredRow[];
}

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("usage: replay9124.ts <live-deck-*.json> [--json] [--min-yield 0.286]");
  process.exit(2);
}
const asJson = argv.includes("--json");
const minYieldArg = argv.indexOf("--min-yield");
const minYield = minYieldArg >= 0 ? Number(argv[minYieldArg + 1]) : null;
if (minYield !== null && !Number.isFinite(minYield)) {
  console.error("--min-yield needs a number");
  process.exit(2);
}

const dump: StoredDump = JSON.parse(readFileSync(path, "utf8"));
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

interface LegTally {
  jobId: string;
  rows: number;
  auth: number;
  served: number;
  storedServed: number;
  refused: number;
  refusedReasons: Record<string, number>;
}

const byJob = new Map<string, LegTally>();
const fixture = { rows: 0, auth: 0, served: 0, storedServed: 0, refused: 0, reasons: {} as Record<string, number> };
const detail: any[] = [];

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
        fixture.reasons[v] = (fixture.reasons[v] ?? 0) + 1;
      }
      detail.push({ jobId, id: row.id, served: false, violations: decision.violations, body: row.body });
      continue;
    }

    const clocked = serveAttestedMatchClock(decision.summary, evidence);
    const repeat = summaryRepeatKey(clocked.text, evidence, state.servedBodies);
    if (repeat.key !== null) {
      tally.refused += 1;
      tally.refusedReasons[`repeat:${repeat.key}`] = (tally.refusedReasons[`repeat:${repeat.key}`] ?? 0) + 1;
      fixture.reasons[`repeat:${repeat.key}`] = (fixture.reasons[`repeat:${repeat.key}`] ?? 0) + 1;
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
      fixture.reasons["ac14-clause"] = (fixture.reasons["ac14-clause"] ?? 0) + 1;
      detail.push({ jobId, id: row.id, served: false, violations: ["ac14-clause"], body: clocked.text });
      continue;
    }
    state.servedBodies.push({
      highlightId: row.id,
      windowTs: evidence.windowTs,
      windowDurationS: evidence.windowDurationS,
      clockToken: (row.matchClock?.token ?? null) as string | null,
      body: clocked.text,
      opening: summaryOpeningRun(clocked.text),
    });
    tally.served += 1;
    detail.push({ jobId, id: row.id, served: true, violations: [], body: clocked.text });
  }

  fixture.rows += tally.rows;
  fixture.auth += tally.auth;
  fixture.served += tally.served;
  fixture.storedServed += tally.storedServed;
  fixture.refused += tally.refused;
  byJob.set(jobId, tally);
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        fixture: dump.sourceUrl,
        legs: [...byJob.values()],
        totals: {
          ...fixture,
          yield: fixture.rows === 0 ? null : fixture.served / fixture.rows,
          authYield: fixture.auth === 0 ? null : fixture.served / fixture.auth,
        },
        detail,
      },
      null,
      1
    )
  );
} else {
  console.log(`# ADAAAA-9124 $0 serve-yield replay — ${dump.sourceUrl}`);
  console.log(`rows=${dump.rows.length} legs=${byJob.size}`);
  console.log("");
  console.log("leg          rows  auth  stored-served  served-now  yield   refused-reasons");
  for (const tally of byJob.values()) {
    const reasons = Object.entries(tally.refusedReasons)
      .sort()
      .map(([k, v]) => `${k}=${v}`)
      .join(",");
    console.log(
      `${tally.jobId.slice(0, 8)}     ${String(tally.rows).padStart(4)}  ${String(tally.auth).padStart(4)}  ` +
        `${String(tally.storedServed).padStart(13)}  ${String(tally.served).padStart(10)}  ` +
        `${pct(tally.served, tally.rows).padStart(7)}  ${reasons}`
    );
  }
  console.log("");
  console.log(
    `FIXTURE: rows=${fixture.rows} auth=${fixture.auth} (${pct(fixture.auth, fixture.rows)}) ` +
      `stored-served=${fixture.storedServed} served-now=${fixture.served} ` +
      `yield=${pct(fixture.served, fixture.rows)} auth-yield=${pct(fixture.served, fixture.auth)}`
  );
  console.log(`refusals by reason: ${JSON.stringify(Object.fromEntries(Object.entries(fixture.reasons).sort()))}`);
}

if (minYield !== null) {
  const yieldNow = fixture.rows === 0 ? 0 : fixture.served / fixture.rows;
  if (yieldNow < minYield) {
    console.error(`FAIL: yield ${(yieldNow * 100).toFixed(1)}% < --min-yield ${(minYield * 100).toFixed(1)}%`);
    process.exit(1);
  }
}
