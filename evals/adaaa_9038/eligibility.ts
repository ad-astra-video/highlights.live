// ADAAAA-9038 $0 eligibility replay: does the confidence lift move the AC1/AC12
// row arithmetic? (It must NOT — the census's 0/27 vs 27/27 split is the
// matchContext hand-off, and `attestedFactKinds` reads NAMES, not confidence.)
//
// Rows: /tmp/hl9035/rows.json (27 promoted rows of the six stored live jobs).
// Contexts: replay9038.json (patched resolver at 1 and 2 frames) + served9038.json.
import { readFileSync } from "node:fs";
import { attestedFactKinds } from "../../packages/events/src/index.ts";

type Teams = Record<string, { name: string; confidence: number }>;
const rows = JSON.parse(readFileSync("/tmp/hl9035/rows.json", "utf8")) as any[];
const patched = JSON.parse(readFileSync("/tmp/paperclip-run-adaaaa-9038-d18401f8-e89-z2BIEB/replay9038.json", "utf8"));
const served = JSON.parse(readFileSync("/tmp/paperclip-run-adaaaa-9038-d18401f8-e89-z2BIEB/served9038.json", "utf8"));

const asContext = (teams: Teams) => ({
  sport: "soccer",
  teams: Object.entries(teams).map(([side, t]) => ({ name: t.name, side, confidence: t.confidence, kitColors: [], evidence: [] })),
});

let withStored = 0;
let withPatched2 = 0;
let withServed = 0;
for (const row of rows) {
  const job = row.job as string;
  const base = {
    verdict: row.outcome ?? null,
    eventType: row.eventType ?? null,
    windowTs: row.localizedTs ?? null,
    scoreTransition: { from: row.fromScore ?? "", to: row.toScore ?? "" },
  };
  const kinds = (mc: unknown) => attestedFactKinds({ ...base, matchContext: mc } as any);
  if (kinds(null).length >= 2) withStored += 1; // row bytes only: the census's 0/27
  if (kinds(asContext(served[job].served_1frame)).length >= 2) withServed += 1;
  if (kinds(asContext(patched.jobs[job].patched_2frames)).length >= 2) withPatched2 += 1;
}

console.log(JSON.stringify({
  rows: rows.length,
  eligible_row_bytes_only: withStored,
  eligible_with_served_context: withServed,
  eligible_with_patched_two_frame_context: withPatched2,
}, null, 2));
