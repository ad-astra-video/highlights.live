// ADAAAA-8941 (increment 1) — the `$0` replay of the rev-8 LIVE rail's 19 stored rows.
//
// Usage (from the repo root):
//   ./node_modules/.bin/tsx evals/adaaa_8941/replay8941.ts evals/adaaa_8941/live-rail-e4c2fe29.json
//   ./node_modules/.bin/tsx evals/adaaa_8941/replay8941.ts evals/adaaa_8941/live-rail-771f42de.json
//
// `live-rail-e4c2fe29.json` carries the 19 promoted rows of live job
// `e4c2fe29-68fe-472c-91da-b96d1dd8ca93` (`file-sim`, `/data/clips/kids300_7935.mp4`,
// 1200 s content, 379 decides) with the bytes the served build `sha256:603797d3…`
// (`0149022`) actually put on the card: the body, the row's own `matchClock`
// reading, its `attestation`, its caption/postTitle and the clip offset. No model
// call, no GPU, no DB write.
//
// `live-rail-771f42de.json` is the SECOND live reading: the 14 promoted rows of the
// natural customer job `771f42de-82eb-4357-8e0b-2121865f4608` on the fixed tree
// `328bb3b` (served image `sha256:0cb6fd79…`, `StartedAt` 10:08:31Z). It is the
// corpus that proved the first clock repair incomplete — the two bodies that leg
// served printed `4:16` / `as the clip progresses from 7:44` with no clip frame
// AFTER the stamp, so the offset survived to the card. A served row no longer keeps
// `summaryRaw`, so `body` is the served summary there and `servedSummary` repeats
// it for the census.
//
// Increment 1 grades the two defects this ticket fixes here:
//   Defect 1 (AC14.1/AC14.2) — no served body asserts a possession / ball-forward /
//     sustained-play clause that no attestation supports.
//   Defect 2 (AC14.4) — a served body's clock reference is the row's OWN
//     `matchClock.token`, never the offset into the clip.
// Defects 3 (repeat key) and 4 (`postTitle`) are increment 2 and are NOT graded
// here beyond being reported.
//
// Exit code 1 when an increment-1 AC fails, so the tool doubles as a `$0` guard.
import { readFileSync } from "node:fs";
import {
  gateSummaryDetail,
  serveAttestedMatchClock,
  summaryClockReport,
  summarySentenceFacts,
  unattestedAtmosphereClaims,
  type SummaryEvidence,
} from "../../packages/events/src/highlight-summary.js";

interface StoredRow {
  id: string;
  rail: SummaryEvidence["rail"];
  body: string | null;
  caption: string | null;
  postTitle: string | null;
  postTitleGate: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  scoreTransition: { from: string; to: string } | null;
  matchClock: { token?: string | null; seconds?: number | null; legible?: boolean | null } | null;
  verdict: string | null;
  eventType: string | null;
  attestation: {
    ballOutcome?: string | null;
    goalCrossed?: boolean | null;
    scoreBoardChanged?: boolean | null;
  } | null;
  storedSummaryGate: string | null;
  storedWords: number;
  /** ADAAAA-8941 (rev-17 reading): a body this ticket pinned as a REFUSAL. The
   *  corpus row is a served copy of a play claim the row's own evidence measured
   *  nothing of, so the gate must not serve it — the `$0` bite pass-bar item 4
   *  asks for on a live-rail filler body. */
  mustRefuse?: boolean;
  mustRefuseReason?: string;
}

interface StoredDump {
  jobId: string;
  source: string;
  matchContext: unknown;
  rows: StoredRow[];
}

const path = process.argv[2];
if (!path) {
  console.error("usage: replay8941.ts <live-rail-e4c2fe29.json>");
  process.exit(2);
}
const dump: StoredDump = JSON.parse(readFileSync(path, "utf8"));

const evidenceOf = (row: StoredRow): SummaryEvidence => ({
  rail: row.rail,
  verdict: row.verdict,
  eventType: row.eventType,
  reason: null,
  caption: row.caption,
  postTitle: row.postTitle,
  windowTs: row.windowTs,
  windowDurationS: row.windowDurationS,
  scoreTransition: row.scoreTransition,
  matchContext: dump.matchContext,
  transcript: null,
  attestation: row.attestation,
  matchClock: row.matchClock,
});

const failures: string[] = [];
const line = (s: string) => console.log(s);

const withBody = dump.rows.filter((row) => (row.body ?? "").trim().length > 0);
const storedAccepted = dump.rows.filter((row) => row.storedSummaryGate === "accepted");

line(`# ADAAAA-8941 increment-1 $0 replay — job ${dump.jobId} (${dump.source})`);
line(`rows=${dump.rows.length} bodies=${withBody.length} stored gate accepted=${storedAccepted.length}`);
line("");

let served = 0;
const violationsByReason = new Map<string, number>();
let offsetsReplaced = 0;

for (const row of withBody) {
  const evidence = evidenceOf(row);
  const body = row.body as string;
  const decision = gateSummaryDetail(body, evidence);
  const serving = serveAttestedMatchClock(body, evidence);

  if (decision.summary === null) {
    for (const v of decision.violations) violationsByReason.set(v, (violationsByReason.get(v) ?? 0) + 1);
  } else {
    served += 1;
  }

  line(`## ${row.id.slice(0, 8)} ${row.eventType} — stored gate=${row.storedSummaryGate}`);
  line(`   stored body: ${JSON.stringify(body)}`);
  line(
    `   attestation ballOutcome=${JSON.stringify(row.attestation?.ballOutcome ?? null)} ` +
      `matchClock.token=${JSON.stringify(row.matchClock?.token ?? null)} windowTs=${row.windowTs}`
  );
  const reports = summarySentenceFacts(body, evidence);
  line(`   sentences=${reports.length} claims=${JSON.stringify(reports.map((r) => r.claims))}`);
  line(
    `   clock swap: servedOffsets=${JSON.stringify(serving.served)} -> ` +
      `${JSON.stringify(serving.text)}`
  );
  if (serving.served.length > 0) offsetsReplaced += 1;
  line(`   gate now: ${decision.gate} | violations=${JSON.stringify(decision.violations)}`);
  if (decision.summary !== null) {
    const clock = summaryClockReport(decision.summary, evidence);
    line(
      `   AC14.4 served clock: tokens=${JSON.stringify(clock.tokens)} ` +
        `matchClock.token=${JSON.stringify(clock.matchClockToken)} servesMatchClock=${JSON.stringify(
          clock.servesMatchClock
        )}`
    );
  }
  line("");
}

// --- AC14.1 / AC14.2: no unattested clause or sentence on a SERVED body --------
const servedBodies = withBody
  .map((row) => ({ row, decision: gateSummaryDetail(row.body as string, evidenceOf(row)) }))
  .filter((entry) => entry.decision.summary !== null);

for (const { row, decision } of servedBodies) {
  const evidence = evidenceOf(row);
  const bad = summarySentenceFacts(decision.summary as string, evidence).filter(
    (report) => report.claims.length > 0 || report.facts.length === 0
  );
  if (bad.length > 0) {
    failures.push(
      `AC14.1/AC14.2 ${row.id}: served body carries ${JSON.stringify(bad.map((b) => b.claims))} / unattested sentences=${bad.length}`
    );
  }
  // AC14.1's clause half, on EVERY served body (not only a stored-`accepted` one).
  // The rev-17 reading is why: live job `1e0d7187` served two `neutralised`
  // bodies whose whole substance was a play claim the row measured nothing of
  // ("drives forward … to maintain their offensive position", "completes a pass
  // to maintain their offensive movement") and the sentence lens above read them
  // as fact-bearing (each carried the row's clock). The stored-verdict lens below
  // cannot see them either — `neutralised` is not `accepted`.
  const tactical = unattestedAtmosphereClaims(decision.summary as string, evidence);
  if (tactical.length > 0) {
    failures.push(
      `AC14.1 ${row.id}: served body carries an unattested play/atmosphere clause ${JSON.stringify(tactical)}`
    );
  }
}

// --- AC14.4: every served body's clock is the row's own token ------------------
for (const { row, decision } of servedBodies) {
  const evidence = evidenceOf(row);
  const clock = summaryClockReport(decision.summary as string, evidence);
  if (clock.matchClockToken === null) continue;
  if (clock.servesMatchClock !== true) {
    failures.push(
      `AC14.4 ${row.id}: served clock tokens=${JSON.stringify(clock.tokens)} != matchClock.token=${JSON.stringify(
        clock.matchClockToken
      )}`
    );
  }
}

// --- Pass-bar item 4: a corpus row pinned `mustRefuse` must NOT serve ----------
// The rev-17 reading (live job `1e0d7187`, served tree `80ac7b3`) served two
// `neutralised` bodies whose whole substance was a play claim the row measured
// nothing of. They are pinned here as refusals so the pre-fix code (which served
// both) fails this gate, and any future vocabulary regression that lets the same
// shape back onto the card fails it again. `$0`, no model call.
for (const row of dump.rows) {
  if (!row.mustRefuse) continue;
  const decision = gateSummaryDetail(row.body as string, evidenceOf(row));
  if (decision.summary !== null) {
    failures.push(
      `AC14.1 ${row.id}: pinned mustRefuse but the gate SERVES it (${JSON.stringify(decision.gate)}) — ${row.mustRefuseReason ?? ""}`
    );
  }
}

// --- Defect 1's bite: a stored-accepted FILLER body must not survive as stored --
// The rev-8 corpus (`live-rail-e4c2fe29.json`) stored `accepted` on three bodies
// whose whole substance was possession / ball-forward / sustained-play. Its lens
// was "a stored-accepted body must not serve", which is right for that corpus and
// wrong for a body that carries attested facts: `live-rail-771f42de.json`'s
// `8cafc2a0` was stored `accepted` with a score line and the row's own match clock,
// and serving it is correct. So the bar is the CLAUSE, not the stored verdict.
for (const row of storedAccepted) {
  const evidence = evidenceOf(row);
  const decision = gateSummaryDetail(row.body as string, evidence);
  if (decision.summary === null) continue;
  const claims = unattestedAtmosphereClaims(decision.summary as string, evidence);
  if (claims.length > 0) {
    failures.push(
      `AC14.1 ${row.id}: the stored-accepted body still serves with an unattested clause ${JSON.stringify(claims)}`
    );
  }
}

line("---");
line(`AC14.1/AC14.2 served bodies=${servedBodies.length} with an unattested clause=${failures.length}`);
line(
  `defect 1 (attested-fact gate): stored accepted=${storedAccepted.length} -> now served=${served}; ` +
    `refused by reason ${JSON.stringify(Object.fromEntries([...violationsByReason].sort()))}`
);
line(
  `defect 2 (match-clock token): bodies whose clip offset is replaced by the row's own token=${offsetsReplaced}`
);
const postTitleServed = dump.rows.filter((row) => row.postTitle !== null).length;
line(
  `increment 2 (not graded here): postTitle served=${postTitleServed}/${dump.rows.length} ` +
    `postTitleGate=${JSON.stringify([...new Set(dump.rows.map((row) => row.postTitleGate))])}`
);
line("");

if (failures.length > 0) {
  line(`RESULT: FAIL (${failures.length})`);
  for (const failure of failures) line(` - ${failure}`);
  process.exit(1);
}
line(
  "RESULT: PASS — every served body carries only attested facts, and every served clock is the row's own matchClock.token"
);
