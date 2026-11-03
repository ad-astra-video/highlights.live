// The measured persisted highlight rows of VOD job d61e52f6 (ADAAAA-7620 review,
// re-measured by the ADAAAA-7653 QA run on the deployed box): 24 GOAL-typed clip
// rows covering 18 unique windows by overlap alone, 6 merged-away duplicates, 1
// rejected clip and 2 accepts whose own verdict text refutes the goal.
//
// Shared by the postable-gate tests and the clip-count tests (ADAAAA-7854) so the
// reference numbers (24 raw / 17 postable / 4 merged) are asserted against ONE
// fixture. Test-support only: no production code imports this file.
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";

export const D61_JOB = "d61e52f6-7569-4757-bffc-f56d03e10b6a";

export interface D61Window {
  start: number;
  end: number;
  score: number;
  status: "accepted" | "rejected" | "pending";
  goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal";
  reason?: string;
  corroborated?: boolean;
  corroborationSource?: "audio_text" | "scoreboard";
}

export const D61_WINDOWS: D61Window[] = [
  { start: 31.3, end: 46.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 69.5, end: 84.5, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 115.6, end: 130.6, score: 100, status: "accepted" },
  {
    start: 141.2,
    end: 156.2,
    score: 60,
    status: "accepted",
    goalConfirmed: "confirmed_goal",
    reason:
      "The ball is seen moving towards the goal but does not enter the net; it appears to be a shot that misses or is saved.; outcome=near_miss is not a scoring highlight; confirmation pass: goal confirmed (deep frame dive)",
  },
  { start: 171.1, end: 186.1, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 245.6, end: 260.6, score: 100, status: "rejected" },
  { start: 273.9, end: 288.9, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 341.8, end: 356.8, score: 95, status: "accepted" },
  { start: 351.8, end: 366.8, score: 95, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 359.2, end: 374.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 394.7, end: 409.7, score: 95, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 410.3, end: 425.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 457.7, end: 472.7, score: 85, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 565.8, end: 580.8, score: 100, status: "accepted" },
  { start: 579.4, end: 594.4, score: 100, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" },
  { start: 601.1, end: 616.1, score: 85, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 629.6, end: 644.6, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 660.2, end: 675.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 678.2, end: 693.2, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  {
    start: 688.6,
    end: 703.6,
    score: 60,
    status: "accepted",
    goalConfirmed: "confirmed_goal",
    reason:
      "The ball is clearly seen being kicked and moving towards the goal, but it does not enter the net; it appears to be a shot that misses or is saved.; outcome=near_miss is not a scoring highlight",
  },
  { start: 701.0, end: 716.0, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 717.3, end: 732.3, score: 100, status: "accepted", goalConfirmed: "confirmed_goal" },
  { start: 755.0, end: 770.0, score: 95, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true },
  { start: 765.1, end: 780.1, score: 95, status: "accepted", goalConfirmed: "confirmed_goal", corroborated: true },
];

/** Build one d61 highlight row, keeping `id` / `jobId` / clip URI derivable from
 * `start` so a test can address a specific window. */
export function d61Highlight(
  over: Partial<HighlightRecord> & { start: number },
  jobId: string = D61_JOB
): HighlightRecord {
  const { start, ...rest } = over;
  return HighlightRecordSchema.parse({
    id: `hl-${start}`,
    jobId,
    clipUri: `/clips/hl-${start}.mp4`,
    start,
    end: start + 15,
    eventType: "GOAL",
    score: 100,
    reason: "The ball clearly enters the net after a strike by the player in the blue jersey.",
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-10-31T14:30:00.000Z",
    ...rest,
  });
}

/** The 24 persisted rows of d61e52f6 as `HighlightRecord`s. */
export function d61Highlights(jobId: string = D61_JOB): HighlightRecord[] {
  return D61_WINDOWS.map((w) =>
    d61Highlight(
      {
        start: w.start,
        end: w.end,
        score: w.score,
        status: w.status,
        goalConfirmed: w.goalConfirmed,
        reason: w.reason,
        corroborated: w.corroborated,
        corroborationSource: w.corroborationSource,
      },
      jobId
    )
  );
}
