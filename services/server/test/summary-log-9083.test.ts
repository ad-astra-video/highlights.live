// ADAAAA-9083 (AC15) — the VIDEO SUMMARY write seam.
//
// The board's read (ADAAAA-8665 comment `96560fed`, 2026-11-15T14:27:41Z) was made
// on the served VOD rail during a live VOD job: "The Video Summary ones all start
// with something like 'the scene opens'". That section renders the STORED
// `job.summaryLog` text, and the append seam never ran the stock-opener strip: the
// story ladder strips it on its READ path (`gateNarrative` -> `normalizeLog`), so
// the stored-and-served item kept the formula. These tests pin the write seam, on
// both rails, with the same closed list the per-row summary body uses.
import { describe, expect, it } from "vitest";
import { Store } from "../src/store";
import { appendSummaryEntry } from "../src/summary-log";

const SCENE_LEAD =
  "The scene opens on a ceremonial moment before the match, featuring a line of young children in the FC Barcelona kit.";
const CLIP_LEAD = "In this clip, a player in blue takes possession in the midfield.";
const CONCRETE =
  "Carlos Javier completes a pass to set up the scoring opportunity at 2:00 into the clip.";

/** The grounding prompt shape the live rail uses (corroborates the numbers/names
 *  a window line carries), so the grounding gate does not suppress the row before
 *  the frame strip runs. */
const PROMPT = "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR | No. 3 | ASR: (empty)";

describe("ADAAAA-9083 (AC15) — the Video Summary append seam strips the frame lead", () => {
  it("stores the stripped lead on the VOD rail", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, SCENE_LEAD, { windowTs: 10 });
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text).not.toMatch(/^the scene opens/i);
    expect(text.startsWith("A ceremonial moment before the match")).toBe(true);
    // Deletion only: the content survives byte-for-byte.
    expect(text.endsWith("in the FC Barcelona kit.")).toBe(true);
    // The rolling summary is model INPUT, not customer copy — unchanged.
    expect(s.getJob(job.id)!.runningSummary).toBe(SCENE_LEAD);
  });

  it("stores the stripped lead on the live rail too", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "rtmp", sourceUrl: "rtmp://x", gameHint: "soccer" });
    // Same input on the pre-fix seam stores the frame lead verbatim:
    //   before: "The clip shows the ball played wide to the right wing."
    //   after:  "The ball played wide to the right wing."
    await appendSummaryEntry(s, job.id, "[near_miss] The clip shows the ball played wide to the right wing.", {
      windowTs: 12,
      grounding: { verdict: "near_miss", promptText: PROMPT },
    });
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text).toBe("The ball played wide to the right wing.");
    expect(text).not.toMatch(/^the clip/i);
  });

  it("leaves a concrete lead byte-identical", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, CONCRETE, { windowTs: 24 });
    expect(s.getJob(job.id)!.summaryLog![0].text).toBe(CONCRETE);
  });

  it("keeps the scoreline gate and the frame strip on the same stored line", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(
      s,
      job.id,
      "The video begins with the scoreboard at 5-4 before Carlos Javier shoots at 0:24 into the clip.",
      { windowTs: 24 }
    );
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text).not.toMatch(/^the video begins/i);
    // An uncorroborated scoreline is still suppressed at the same seam.
    expect(text).not.toContain("5-4");
  });
});
