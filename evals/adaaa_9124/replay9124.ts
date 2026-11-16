/**
 * ADAAAA-9124 `$0` replay — the LIVE deck's serve-yield census, read from stored rows.
 *
 * The deck bar (`>= 10` servable refurbished bodies on one live leg) is a
 * serve-yield question, and a leg costs money. So the census that grades a fixture
 * and a lever runs HERE: over rows a served build already wrote, through the SAME
 * evidence mapper the lane uses (`summaryEvidenceForRow`) and the SAME gate
 * (`gateSummaryDetail`). No model call, no job, no billing, no DB write.
 *
 * The read itself lives in `census9124.ts` so CI can hold it as a regression gate
 * (`services/server/test/deck-yield-9124.test.ts`); this file is the CLI.
 *
 * Usage (from the repo root, on the box or in the served container):
 *
 *   ./node_modules/.bin/tsx evals/adaaa_9124/replay9124.ts \
 *     evals/adaaa_9124/live-deck-54537ffa.json [--json] [--min-yield 0.286]
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
 * tool doubles as a regression gate for the yield read. `--min-bodies` does the same
 * for the deck bar itself (served bodies on one leg, so a multi-leg corpus reads as
 * its best leg).
 */
import { readFileSync } from "node:fs";
import { censusFixture, servedYield, type StoredDump } from "./census9124.js";

const argv = process.argv.slice(2);
const path = argv.find((a) => !a.startsWith("--"));
if (!path) {
  console.error("usage: replay9124.ts <live-deck-*.json> [--json] [--min-yield 0.286] [--min-bodies 10]");
  process.exit(2);
}
const asJson = argv.includes("--json");
const numberArg = (flag: string): number | null => {
  const at = argv.indexOf(flag);
  if (at < 0) return null;
  const raw = Number(argv[at + 1]);
  if (!Number.isFinite(raw)) {
    console.error(`${flag} needs a number`);
    process.exit(2);
  }
  return raw;
};
const minYield = numberArg("--min-yield");
const minBodies = numberArg("--min-bodies");

const dump = JSON.parse(readFileSync(path, "utf8")) as StoredDump;
if (!Array.isArray(dump.rows)) {
  console.error(
    `${path} is not a stored-row corpus (no "rows" array). ` +
      `The *census.json files in this directory are aggregates; export a corpus with export_corpus_9124.py.`
  );
  process.exit(2);
}

const census = censusFixture(dump);
const { totals } = census;
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);
const bodyYield = (projected: number) => (maxLegServed() >= projected ? "met" : "not-met");
const maxLegServed = () => census.legs.reduce((max, leg) => Math.max(max, leg.served), 0);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        fixture: dump.sourceUrl,
        legs: census.legs,
        totals: {
          ...totals,
          yield: totals.rows === 0 ? null : totals.served / totals.rows,
          authYield: totals.auth === 0 ? null : totals.served / totals.auth,
        },
        detail: census.detail,
      },
      null,
      1
    )
  );
} else {
  console.log(`# ADAAAA-9124 $0 serve-yield replay — ${dump.sourceUrl}`);
  console.log(`rows=${dump.rows.length} legs=${census.legs.length}`);
  console.log("");
  console.log("leg          rows  auth  stored-served  served-now  yield   refused-reasons");
  for (const tally of census.legs) {
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
    `FIXTURE: rows=${totals.rows} auth=${totals.auth} (${pct(totals.auth, totals.rows)}) ` +
      `stored-served=${totals.storedServed} served-now=${totals.served} ` +
      `yield=${pct(totals.served, totals.rows)} auth-yield=${pct(totals.served, totals.auth)}`
  );
  console.log(`refusals by reason: ${JSON.stringify(Object.fromEntries(Object.entries(totals.reasons).sort()))}`);
  if (minBodies !== null) console.log(`deck bar: best leg served=${maxLegServed()} vs ${minBodies} => ${bodyYield(minBodies)}`);
}

if (minYield !== null) {
  const yieldNow = servedYield(census);
  if (yieldNow < minYield) {
    console.error(`FAIL: yield ${(yieldNow * 100).toFixed(1)}% < --min-yield ${(minYield * 100).toFixed(1)}%`);
    process.exit(1);
  }
}
if (minBodies !== null && maxLegServed() < minBodies) {
  console.error(`FAIL: best leg served ${maxLegServed()} < --min-bodies ${minBodies}`);
  process.exit(1);
}
