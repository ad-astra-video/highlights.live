/**
 * ADAAAA-9083 `$0` stored-row replay (AC15): every SERVED Video Summary body the
 * instance DB already carries, read back through the served lane's own contract
 * functions. No model call, no DB write, no GPU, no meter.
 *
 * What it reports:
 *   - n, split by the job's `source` (file / file-sim / browser are the VOD rail);
 *   - how many served bodies OPEN ON THE FRAME (the AC15 bar before this build);
 *   - the opener each one used, so the census is not a single number;
 *   - the POST-STRIP body, its word delta, and whether it still serves after the
 *     lead deletion (the strip is deletion-only, so a body that serves must not
 *     lose a fact);
 *   - the AC15 bar AFTER the strip (must be 0).
 *
 * Run: npx tsx tools/replay-9083.ts /tmp/hl9083-dump.json
 */
import { readFileSync } from "node:fs";
import {
  frameOpenerOf,
  gateSummaryDetail,
  hasFrameOpener,
  stripFrameOpener,
  summaryWordCount,
  type SummaryEvidence,
} from "@highlights/events";
import { summaryEvidenceForRow } from "../services/server/src/summary-lane.js";

interface DumpRow {
  jobId: string;
  jobSource: string;
  rail: string | null;
  matchContext: unknown;
  outcome?: string | null;
  verdict?: string | null;
  eventType?: string | null;
  reason?: string | null;
  caption?: string | null;
  postTitle?: string | null;
  start?: number | null;
  end?: number | null;
  trigger?: { timestamp?: number; durationS?: number } | null;
  matchClock?: { token?: string; seconds?: number; period?: string | null; legible?: boolean } | null;
  attestationUsed?: unknown;
  asrTranscript?: string | null;
  summary: string;
  summaryGate?: string | null;
  summaryCalls?: number | null;
  summaryRetryReason?: string | null;
}

const raw = JSON.parse(readFileSync(process.argv[2] ?? "/tmp/hl9083-dump.json", "utf8")) as (DumpRow | LogItem)[];

/** The Video Summary surface dump: `job.summaryLog` items (`{job, source, seq, text}`). */
interface LogItem {
  job: string;
  source: string;
  seq: number;
  text: string;
}

const isLogDump = (rows: (DumpRow | LogItem)[]): rows is LogItem[] =>
  rows.length > 0 && typeof (rows[0] as LogItem).text === "string";

if (isLogDump(raw)) {
  // The "Video Summary" section renders the STORED `summaryLog` item, so the AC15
  // bar has to be graded on that text too. The append seam now strips the lead by
  // deletion (`services/server/src/summary-log.ts`), so the post-strip value is
  // what a re-run would store.
  const byJob: Record<string, number> = {};
  let open = 0;
  const openers: Record<string, number> = {};
  let kept = 0;
  const lines: string[] = [];
  for (const item of raw) {
    byJob[item.job] = (byJob[item.job] ?? 0) + 1;
    const opener = frameOpenerOf(item.text);
    if (opener === null) {
      kept += 1;
      continue;
    }
    open += 1;
    openers[opener.toLowerCase()] = (openers[opener.toLowerCase()] ?? 0) + 1;
    const strip = stripFrameOpener(item.text);
    const after = strip.text;
    if (hasFrameOpener(after)) kept += 1;
    lines.push(
      [
        `job=${item.job} source=${item.source} seq=${item.seq}`,
        `  opener=${JSON.stringify(opener)}`,
        `  before(${summaryWordCount(item.text)}w)=${JSON.stringify(item.text)}`,
        `  after (${summaryWordCount(after)}w)=${JSON.stringify(after)}`,
      ].join("\n")
    );
  }
  console.log(`n=${raw.length} stored Video Summary items`);
  for (const [job, count] of Object.entries(byJob).sort()) console.log(`  job=${job}: ${count}`);
  console.log(`openedOnFrame=${open} (${((100 * open) / raw.length).toFixed(1)}%)`);
  console.log(`postStripOpeners=` + JSON.stringify(openers));
  console.log(`afterStripStillOnFrame=${kept}`);
  console.log("");
  for (const line of lines) console.log(line);
  process.exit(0);
}

const rows = raw as DumpRow[];

/** The lane's rail for a job: every VOD source (file / file-sim / browser) runs
 *  the VOD band; an rtmp/webrtc source is the live rail. */
const railOf = (row: DumpRow): "live" | "vod" =>
  row.jobSource === "rtmp" || row.jobSource === "webrtc" ? "live" : "vod";

const evidenceOf = (row: DumpRow): SummaryEvidence => {
  const evidence = summaryEvidenceForRow(
    {
      ...(row as any),
      trigger: row.trigger ?? null,
      matchClock: row.matchClock ?? null,
      attestationUsed: row.attestationUsed ?? null,
      asrTranscript: row.asrTranscript ?? null,
    },
    railOf(row),
    null
  );
  evidence.matchContext = row.matchContext ?? null;
  return evidence;
};

const bySource: Record<string, number> = {};
let openOnFrame = 0;
let stillOpenAfterStrip = 0;
let lostFacts = 0;
const openers: Record<string, number> = {};
const lines: string[] = [];

for (const row of rows) {
  bySource[row.jobSource] = (bySource[row.jobSource] ?? 0) + 1;
  const before = row.summary;
  const opener = frameOpenerOf(before);
  const strip = stripFrameOpener(before);
  const after = strip.text;
  const beforeWords = summaryWordCount(before);
  const afterWords = summaryWordCount(after);
  const evidence = evidenceOf(row);
  if (hasFrameOpener(after)) stillOpenAfterStrip += 1;
  if (opener !== null) {
    openOnFrame += 1;
    openers[opener.toLowerCase()] = (openers[opener.toLowerCase()] ?? 0) + 1;
    // Post-strip: does the deletion-only repair still carry the facts the row
    // served (i.e. does the gate still serve it)? A body that drops after the
    // strip is a DEPTH consequence, which AC4 names `filler` — report it, do not
    // hide it.
    const decided = gateSummaryDetail(after, evidence);
    if (decided.summary === null) lostFacts += 1;
    lines.push(
      [
        `job=${row.jobId.slice(0, 8)} source=${row.jobSource} gate=${row.summaryGate ?? "?"} calls=${row.summaryCalls ?? "?"}`,
        `  opener=${JSON.stringify(opener)}`,
        `  before(${beforeWords}w)=${JSON.stringify(before)}`,
        `  after (${afterWords}w)=${JSON.stringify(after)}`,
        `  words=${beforeWords}->${afterWords} recheck=${decided.summary === null ? `refused:${decided.violations.join(",")}` : decided.gate}`,
      ].join("\n")
    );
  }
}

console.log(`n=${rows.length} served bodies`);
for (const [source, count] of Object.entries(bySource).sort()) console.log(`  source=${source}: ${count}`);
console.log(`openedOnFrame=${openOnFrame} (${((100 * openOnFrame) / rows.length).toFixed(1)}%)`);
console.log(`postStripOpeners=` + JSON.stringify(openers));
console.log(`afterStripStillOnFrame=${stillOpenAfterStrip}`);
console.log(`postStripRefused=${lostFacts} (depth consequences of the lead deletion, AC4 names them filler)`);
console.log("");
for (const line of lines) console.log(line);
