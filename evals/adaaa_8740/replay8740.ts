// ADAAAA-8740 (§6.3): $0 replay of the EVENT-GROUP placement over a live job's
// STORED rows — the "leading celebration cue" defect, judged offline.
//
// Usage (from the repo root, with tsx available):
//   ./node_modules/.bin/tsx evals/adaaa_8740/replay8740.ts [rows.json]
//
// Without an argument it replays the graded leg's own pair (job
// `1b0a3221-e805-452e-a3f5-fdeb6693766e`, read read-only from the box's
// `highlights` table on 2026-11-12), which is the AC1 corpus.
//
// `rows.json` is a job's stored rows, one object per row, in `created_at` order:
//   { id, localizedTs, anchorReason, placementReason, start, end }
// Dump it from the box (read-only, no job, no GPU):
//
//   cat > /tmp/q.sql <<'SQL'
//   select json_build_object(
//     'id', id,
//     'localizedTs', (record::jsonb->>'localizedTs')::float,
//     'anchorReason', record::jsonb->>'localizeAnchorReason',
//     'placementReason', coalesce(record::jsonb->>'clipPlacementReason',''),
//     'start', (record::jsonb->>'start')::float,
//     'end', (record::jsonb->>'end')::float)
//   from highlights where job_id='<job>' order by created_at;
//   SQL
//   echo $(base64 -w0 /tmp/q.sql) | base64 -d | \
//     docker exec -i highlights-postgres psql -U highlights -d highlights -tA
//
// then join the lines into a JSON array. No model call, no GPU, no DB write:
// the replay judges the rows the build actually stored.
import { readFileSync } from "node:fs";
import {
  placeLiveClipWindow,
  placeLiveEventGroupClipWindows,
  type ClipEventGroupRow,
} from "../../services/server/src/clip-placement.js";
import { clipWindow } from "../../services/server/src/config.js";

interface StoredRow {
  id: string;
  localizedTs: number;
  anchorReason: string;
  placementReason?: string;
  start: number;
  end: number;
}

/** The graded leg's two rows, verbatim (psql, 2026-11-12). */
const LEG: StoredRow[] = [
  {
    id: "05d2815c-2a3d-4a61-a351-eaacd4944928",
    localizedTs: 96.5,
    anchorReason: "peak_audio_reaction",
    placementReason: "celebration_tail",
    start: 83.5,
    end: 98.5,
  },
  {
    id: "38512cc7-5456-45df-84f2-fd9f850823d2",
    localizedTs: 102.74300003051758,
    anchorReason: "measured_transition",
    placementReason: "goal_anchor",
    start: 95.74300003051758,
    end: 110.74300003051758,
  },
];

const D = 15; // the live rail's fixed length: 7 s before / 8 s after, >= 15 s floor
const f = (n: number) => n.toFixed(3);
const nominal = (ts: number) => clipWindow(ts, 7, 8, D);

function asGroupRow(r: StoredRow): ClipEventGroupRow {
  return {
    ...(r.id ? { id: r.id } : {}),
    localizedTs: r.localizedTs,
    anchorReason: r.anchorReason,
    ...(r.placementReason
      ? { placementReason: r.placementReason as Parameters<typeof placeLiveEventGroupClipWindows>[0]["rows"][number]["placementReason"] }
      : {}),
    card: { start: r.start, end: r.end },
  };
}

function main(): void {
  const arg = process.argv[2];
  const rows: StoredRow[] = arg ? (JSON.parse(readFileSync(arg, "utf8")) as StoredRow[]) : LEG;
  console.log(`ADAAAA-8740 replay: ${rows.length} stored row(s)${arg ? ` from ${arg}` : " (the graded leg)"}\n`);

  // --- PRE-FIX: each row placed on its own (the shipped row-local rule) -------
  console.log("== PRE-FIX (row-local placeLiveClipWindow) ==");
  const pre = rows.map((r) => ({
    row: r,
    placed: placeLiveClipWindow({
      localizedTs: r.localizedTs,
      anchorReason: r.anchorReason,
      window: nominal(r.localizedTs),
      live: true,
    }),
  }));
  for (const { row, placed } of pre) {
    console.log(
      `  ${row.anchorReason} @${f(row.localizedTs)}: card [${f(placed.start)}, ${f(placed.end)}] ` +
        `reason=${placed.reason} cueOffset=${f(placed.cueOffsetSec)}`
    );
  }
  const preGoal = pre.find((p) => /measured_transition|frame_attestation/.test(p.row.anchorReason));
  const preCue = pre.find((p) => !/measured_transition|frame_attestation/.test(p.row.anchorReason));
  console.log(`  cards emitted: ${pre.length}`);
  if (preGoal && preCue) {
    console.log(
      `  cue card ends ${f(preGoal.row.localizedTs - preCue.placed.end)} s before the goal instant ` +
        `${f(preGoal.row.localizedTs)} -> goal NOT on the cue card`
    );
  }

  // --- POST-FIX: ONE decision over the event group ----------------------------
  const delivered = rows.map(asGroupRow);
  const group = placeLiveEventGroupClipWindows({ rows: delivered, live: true });
  console.log("\n== POST-FIX (placeLiveEventGroupClipWindows, §6.3) ==");
  console.log(
    `  goalTs=${group.goalTs != null ? f(group.goalTs) : "null"} ` +
      `goalRowIndex=${group.goalRowIndex} cards=${group.cards.length} suppressed=${group.suppressed.length}`
  );
  for (const c of group.cards) {
    console.log(`  card [${f(c.start)}, ${f(c.end)}] reason=${c.reason} len=${f(c.end - c.start)}`);
  }
  for (const s of group.suppressed) {
    console.log(`  suppressed ${s.id ?? "(row)"} @${f(s.localizedTs)} reason=${s.reason}`);
  }
  if (group.goalTs != null && group.cards.length) {
    const card = group.cards[0];
    const inside = card.start <= group.goalTs && group.goalTs <= card.end;
    console.log(`  goal instant inside the emitted card: ${inside}`);
    console.log(`  pre-goal footage: ${f(group.goalTs - card.start)} s (AC1 floor >= 2.000 s)`);
  }

  // --- POST-FIX: each row ALONE (the no-regression shape, AC3) ----------------
  console.log("\n== POST-FIX, each row alone (AC3 no-regression) ==");
  for (const r of rows) {
    const solo = placeLiveEventGroupClipWindows({
      rows: [{ localizedTs: r.localizedTs, anchorReason: r.anchorReason, window: nominal(r.localizedTs) }],
      live: true,
    });
    const p = solo.rows[0].placed!;
    console.log(
      `  ${r.anchorReason} @${f(r.localizedTs)}: reason=${p.reason} card [${f(p.start)}, ${f(p.end)}] ` +
        `offset=${f(p.cueOffsetSec)}`
    );
  }

  // --- POST-FIX: the VOD posture is untouched --------------------------------
  const vod = placeLiveEventGroupClipWindows({ rows: delivered, live: false });
  console.log(`\n== VOD (live: false) == cards=${vod.cards.length} suppressed=${vod.suppressed.length} (byte-identical path)`);
}

main();
