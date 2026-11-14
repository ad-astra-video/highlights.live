/**
 * ADAAAA-8965 (D4-live, increment 1) — $0 replay of the stored LIVE rows.
 *
 * Zero decide calls, zero GPU, zero deploy. It imports the pure trigger + card
 * derivation from the worktree given on the command line, so the SAME fixture is
 * replayed against the census baseline build (before) and the served tip
 * (after):
 *
 *   tsx replay8965c.ts <worktree> <fixture.json> <label>
 *
 * Fields printed per row: dive(before -> after), lane(before -> after),
 * confirmAttestation present, confirmationSkipReason present. Plus the job's
 * diveAdmission counters and the ticket's three bars.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [wt, fixturePath, label] = process.argv.slice(2);
if (!wt || !fixturePath) {
  console.error("usage: replay8965c.ts <worktree> <fixture.json> [label]");
  process.exit(2);
}
const analyzer = await import(pathToFileURL(`${wt}/services/server/src/analyzer.ts`).href);
const lane = await import(pathToFileURL(`${wt}/services/server/src/confirmation-lane.ts`).href);
const { shouldRunConfirm, candidateHasMeasuredAttestation } = analyzer;
const { confirmationForHighlightRow } = lane;

type Row = {
  job: string;
  id: string;
  status: string;
  eventType?: string;
  outcome?: string;
  trigger?: { kind?: string; eventType?: string; timestamp?: number; scoreBoardChanged?: boolean; goalCrossed?: boolean; ballOutcome?: string };
  attestationUsed?: { scoreBoardChanged?: boolean | null; goalCrossed?: boolean | null; ballOutcome?: string | null; goalConfirmed?: string | null } | null;
  confirmAttestation?: Record<string, unknown> | null;
  provisionalGoal?: { held?: boolean; refuted?: boolean } | null;
  candidate?: Record<string, unknown> | null;
};
type Job = {
  diveAdmission?: Record<string, number> | null;
  confirmCalls?: string | number | null;
  confirmDiveCount?: string | number | null;
  confirmDropped?: string | number | null;
  confirmDroppedByReason?: Record<string, number> | null;
  rowAccounting?: { servedCards?: number; persistedRows?: number; acceptedWindows?: number; demotedCelebrations?: number } | null;
};
const fx = JSON.parse(readFileSync(fixturePath, "utf8")) as { jobs: Record<string, Job>; rows: Row[] };

/** The live rail posture: observe loop armed, no VOD decide window. */
const CLIVE = { confirmEnabled: true, liveObserveLoop: true } as never;

const candidateOf = (r: Row) => {
  const a = r.attestationUsed ?? {};
  return {
    eventType: r.eventType ?? "GOAL",
    timestamp: r.trigger?.timestamp ?? 0,
    ballOutcome: a.ballOutcome ?? undefined,
    goalCrossed: a.goalCrossed ?? undefined,
    scoreBoardChanged: a.scoreBoardChanged ?? undefined,
  };
};
const stage1Of = (r: Row) => ({ isHighlight: r.status === "accepted", eventType: r.eventType ?? "GOAL", outcome: r.outcome } as never);

/** Trigger predicate: does the stored row look measured to `shouldRunConfirm`? */
const measuredByTrigger = (r: Row) => candidateHasMeasuredAttestation(candidateOf(r) as never) === true;
/** Row predicate (D4's population): the ROW carries a measured attestation. */
const measuredByRow = (r: Row) => {
  const a = r.attestationUsed ?? {};
  return a.scoreBoardChanged === true || a.goalCrossed === true || /^goal$/i.test(a.ballOutcome ?? "");
};

const card = (r: Row, attestation: unknown = r.confirmAttestation) =>
  confirmationForHighlightRow(
    {
      status: (r.status ?? "accepted") as never,
      trigger: r.trigger as never,
      provisionalGoal: r.provisionalGoal as never,
      confirmAttestation: attestation as never,
    },
    (r.candidate ?? { status: r.status, trigger: r.trigger, analysis: undefined }) as never,
    { confirmEnabled: true }
  );

/** Verdicts a real dive can return, for the guard-invariance sweep. */
const VERDICTS = [
  { goalConfirmed: "confirmed_goal", corroborated: true },
  { goalConfirmed: "near_miss", corroborated: false },
  { goalConfirmed: "not_goal", corroborated: false },
] as const;

const adopted = (r: Row, verdict: { goalConfirmed: string; corroborated: boolean }) => ({
  ...verdict,
  diveAt: "2026-11-14T00:00:00.000Z",
  diveLatencyMs: 0,
  contextDegraded: [],
  momentTs: r.trigger?.timestamp ?? 0,
  ...(measuredByRow(r) ? { laneKeptByMeasurement: true } : {}),
});

const out: Record<string, unknown>[] = [];
const guardFails: string[] = [];
for (const r of fx.rows) {
  const cand = candidateOf(r);
  const s1 = stage1Of(r);
  const beforeDive = shouldRunConfirm(CLIVE, cand as never, s1);
  // The served tip's trigger over the same stored row. In the baseline worktree
  // this is the pre-change predicate; in the served worktree the post-change one.
  const afterDive = beforeDive; // same call; the WORKTREE is what differs
  const before = card(r, r.confirmAttestation);
  const hadVerdict = Boolean(r.confirmAttestation);
  // AFTER: the dive the served trigger dispatches. A row with no stored verdict
  // gets the D4 adoption shape; a row whose verdict is already stored keeps it
  // (one verdict move per row, never rewritten).
  const afterAttestation = hadVerdict ? r.confirmAttestation : afterDive ? adopted(r, VERDICTS[0]) : null;
  const after = card(r, afterAttestation);
  // Guard-invariance: on a measured row, EVERY verdict must keep lane measured
  // and claim no skip.
  let guardOk: boolean | null = null;
  if (measuredByRow(r) && afterDive && !hadVerdict) {
    guardOk = VERDICTS.every((v) => {
      const c = card(r, adopted(r, v));
      return c?.lane === "measured" && !(c as { skipReason?: string }).skipReason;
    });
    if (!guardOk) guardFails.push(r.id.slice(0, 8));
  }
  out.push({
    job: r.job,
    id: r.id.slice(0, 8),
    kind: r.eventType,
    measTrigger: measuredByTrigger(r),
    measRow: measuredByRow(r),
    diveBefore: beforeDive,
    diveAfter: afterDive,
    laneBefore: before?.lane ?? null,
    laneAfter: after?.lane ?? null,
    skipBefore: (before as { skipReason?: string })?.skipReason ?? null,
    skipAfter: (after as { skipReason?: string })?.skipReason ?? null,
    verdictBefore: hadVerdict,
    verdictAfter: Boolean(afterAttestation),
    guardVerdicts: guardOk,
    // ADAAAA-8965 precision guard, verbatim from the ticket: on a measured row the
    // dive "may add the moment only" and "may not move the lane off measured. Any
    // lane DIFF on a measured row is a regression, not a pass." The regression
    // test is therefore a DIFF, not an absolute lane value — a pre-D4 row whose
    // dive already demoted it keeps reading `dive_disagreed` (D3 precedence, AC2,
    // byte-identical for rows without `laneKeptByMeasurement`) and that lane is
    // not this change's doing. Both fields are reported so the lens stays visible.
    laneDiff: before?.lane !== after?.lane,
    laneNotMeasured: measuredByRow(r) && after?.lane !== "measured",
    newlyDivedMeasuredArm:
      measuredByRow(r) && afterDive && !hadVerdict
        ? after?.lane === "measured" && !(after as { skipReason?: string }).skipReason
        : null,
  });
}

const jobs: Record<string, unknown> = {};
for (const [id, j] of Object.entries(fx.jobs)) {
  const rs = out.filter((r) => r.job === id);
  const promoted = rs.length;
  const storedDispatched = j.diveAdmission?.dispatched ?? null;
  const drops = j.confirmDroppedByReason ? Object.values(j.confirmDroppedByReason).reduce((a, b) => a + b, 0) : null;
  jobs[id] = {
    promoted,
    servedCards: j.rowAccounting?.servedCards ?? null,
    storedDispatched,
    storedDivesBilled: j.diveAdmission?.divesBilled ?? null,
    storedDiveCostUsd: j.diveAdmission?.diveCostUsd ?? null,
    storedConfirmCalls: j.confirmCalls,
    storedConfirmDiveCount: j.confirmDiveCount,
    storedDrops: drops,
    predictedDispatchedAfter: rs.filter((r) => r.diveAfter === true).length,
    undivedBefore: rs.filter((r) => !r.verdictBefore).length,
    undivedAfter: rs.filter((r) => !r.verdictAfter).length,
  };
}

const bars = [
  {
    name: "AC4.1 (live) served cards with neither confirmAttestation nor confirmationSkipReason = 0",
    pass: out.every((r) => r.verdictAfter === true || Boolean(r.skipAfter)),
    detail: `${out.filter((r) => !r.verdictAfter && !r.skipAfter).length} silent of ${out.length}`,
  },
  {
    name: "AC4.2 (live) measured rows with no confirmAttestation = 0",
    pass: out.filter((r) => r.measRow && !r.verdictAfter).length === 0,
    detail: `${out.filter((r) => r.measRow && !r.verdictAfter).length} of ${out.filter((r) => r.measRow).length} measured rows`,
  },
  {
    name: "AC4.2 (live) measured rows whose lane DIFFS before→after = 0",
    pass: out.filter((r) => r.measRow && r.laneDiff).length === 0,
    detail:
      out
        .filter((r) => r.measRow && r.laneDiff)
        .map((r) => `${r.id}:${r.laneBefore}→${r.laneAfter}`)
        .join(", ") || `0 of ${out.filter((r) => r.measRow).length} measured rows`,
  },
  {
    name: "AC4.2 (live) every newly dived measured row keeps lane `measured` and claims no skip",
    pass: out.filter((r) => r.newlyDivedMeasuredArm === false).length === 0,
    detail: `${out.filter((r) => r.newlyDivedMeasuredArm !== null).length} newly dived measured rows, fails: ${
      out.filter((r) => r.newlyDivedMeasuredArm === false).map((r) => r.id).join(",") || "0"
    }`,
  },
  {
    name: "LENS (not loosened) pre-existing measured rows already off `measured` — reported, not counted as a diff",
    pass: true,
    detail:
      out
        .filter((r) => r.laneNotMeasured)
        .map((r) => `${r.id}:${r.laneAfter} (verdictBefore=${r.verdictBefore}, laneDiff=${r.laneDiff})`)
        .join(", ") || "0",
  },
  {
    name: "guard invariance: every dive verdict keeps a measured lane and claims no skip",
    pass: guardFails.length === 0,
    detail: `${out.filter((r) => r.guardVerdicts !== null).length} guarded rows × 3 verdicts, fails: ${guardFails.join(",") || "0"}`,
  },
  {
    name: "AC4.3 diveAdmission.dispatched >= promoted - named exemptions",
    pass: Object.values(jobs).every((j) => (j as { predictedDispatchedAfter: number; promoted: number }).predictedDispatchedAfter >= (j as { promoted: number }).promoted),
    detail: Object.entries(jobs).map(([k, v]) => `${k}: ${(v as { predictedDispatchedAfter: number }).predictedDispatchedAfter}/${(v as { promoted: number }).promoted}`).join(", "),
  },
  {
    name: "AC4.3 every drop names a cause",
    pass: Object.values(jobs).every((j) => (j as { storedDrops: number | null }).storedDrops === 0),
    detail: Object.entries(jobs).map(([k, v]) => `${k}: ${(v as { storedDrops: number | null }).storedDrops}`).join(", "),
  },
];

console.log(`### ${label ?? wt} (${wt})`);
console.log(JSON.stringify({ rows: out, jobs, bars }, null, 1));
console.log("\nrow      job       kind      measT measR dive  lane(b→a)                       skip(b→a)                                  verdict(b→a) guard");
for (const r of out) {
  console.log(
    [
      r.id.padEnd(8),
      r.job.padEnd(9),
      String(r.kind).padEnd(9),
      String(r.measTrigger)[0],
      String(r.measRow)[0],
      `${String(r.diveBefore)[0]}→${String(r.diveAfter)[0]}`.padEnd(5),
      `${r.laneBefore ?? "none"}→${r.laneAfter ?? "none"}`.padEnd(30),
      `${r.skipBefore ?? "-"}→${r.skipAfter ?? "-"}`.padEnd(41),
      `${String(r.verdictBefore)[0]}→${String(r.verdictAfter)[0]}`.padEnd(12),
      r.guardVerdicts === null ? "-" : String(r.guardVerdicts),
    ].join(" ")
  );
}
console.log("\njob       promoted served storedDispatch billed costUsd confCalls undived(b→a)");
for (const [id, j] of Object.entries(jobs)) {
  const v = j as Record<string, number | null>;
  console.log(`${id.padEnd(9)} ${String(v.promoted).padEnd(8)} ${String(v.servedCards).padEnd(6)} ${String(v.storedDispatched).padEnd(14)} ${String(v.storedDivesBilled).padEnd(6)} ${String(v.storedDiveCostUsd).padEnd(7)} ${String(v.storedConfirmCalls).padEnd(9)} ${v.undivedBefore}→${v.undivedAfter}`);
}
console.log("\nBARS");
for (const b of bars) console.log(`${b.pass ? "PASS" : "FAIL"}  ${b.name}  (${b.detail})`);
