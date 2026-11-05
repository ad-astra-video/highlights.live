// ADAAAA-8087: end-to-end replay of the graded leg's row inventory.
//
// Rows are read back from the box `highlights` table for job 00edb27a (the
// ADAAAA-8079 gate-2 leg). The accept-time reason of R5/R6 was the identical
// model text QA recorded; the STORED surface text is rewritten by the caption
// gate, so it is not the pair key.
import { describe, expect, it } from "vitest";
import { LiveRunShared, celebrationReasonKey } from "../src/analyzer.js";

const SAME_REASON = "The ball shoots in midfield";

const GRADED_ROWS = [
  { ts: 100.82499980926514, type: "GOAL", start: 93.82499980926514, end: 108.82499980926514, reason: "" },
  { ts: 114.02499985694885, type: "BIG_PLAY", start: 107.02499985694885, end: 122.02499985694885, reason: "The commentator confirms the shot by Manuel Ordoñez." },
  { ts: 156.32499980926514, type: "GOAL", start: 149.32499980926514, end: 164.32499980926514, reason: "" },
  { ts: 161.58599996566772, type: "BIG_PLAY", start: 154.58599996566772, end: 169.58599996566772, reason: "The keeper is beaten, followed by a crowd eruption." },
  { ts: 184.28999996185303, type: "BIG_PLAY", start: 177.28999996185303, end: 192.28999996185303, reason: SAME_REASON },
  { ts: 187.48999977111816, type: "BIG_PLAY", start: 180.48999977111816, end: 195.48999977111816, reason: SAME_REASON },
];

describe("ADAAAA-8087 graded leg replay (job 00edb27a, 6 rows -> 4)", () => {
  it("drops exactly the R4-inside-R3 and R5/R6-pair surplus; R2 stays as its own moment", () => {
    const run = new LiveRunShared();
    const kept: string[] = [];
    const dropped: string[] = [];
    for (const [i, r] of GRADED_ROWS.entries()) {
      const id = `R${i + 1}`;
      if (r.type === "GOAL") {
        run.noteAcceptedGoalEvent({ highlightId: id, anchorTs: r.ts, start: r.start, end: r.end });
        kept.push(id);
        continue;
      }
      const dup = run.celebrationDuplicateEvent({
        anchorTs: r.ts,
        start: r.start,
        end: r.end,
        reason: r.reason,
        isCelebration: true,
      });
      if (dup) {
        dropped.push(`${id}->${dup.kind === "goal_clip" ? dup.goal.highlightId : dup.celebration.highlightId}`);
        continue;
      }
      run.noteAcceptedCelebrationEvent({
        highlightId: id,
        anchorTs: r.ts,
        start: r.start,
        end: r.end,
        reasonKey: celebrationReasonKey(r.reason),
      });
      kept.push(id);
    }
    // Pre-change baseline on the same fixture: 3. Graded leg: 6. The two
    // duplicate structures go; R2 (13.2 s past R1, outside the goal's clip) is
    // kept and named as a distinct, independently triggered moment.
    expect(kept).toEqual(["R1", "R2", "R3", "R5"]);
    expect(dropped).toEqual(["R4->R3", "R6->R5"]);
  });
});
