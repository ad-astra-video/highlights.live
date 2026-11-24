// ADAAAA-8407: the manual "attach this window as an alternative" path.
//
// The named fixture is the board's real case shape (job 545be947): a GOAL
// moment anchored at 159 s (clip 152-167) and the 207 s replay window. No
// deterministic signal certifies that pair (measured on the box: different
// camera, `live` phase verdict, no score-bug regression), so the operator says
// it by hand. These tests pin the pure contract:
//
//   AC1  a same-job decided window becomes the moment's alternative;
//   AC2  no second highlight row, no second clip, the goal/notable lanes are
//        unchanged and a detach restores the pre-attach row;
//   AC3  provenance is `kind: "manual"` + the acting operator id and instant,
//        stored on the row so auto and manual attaches are distinguishable;
//   AC5  the eligibility/refusal surface the route scopes to the job owner.
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { buildPostableHighlights } from "../src/highlight-postable";
import { partitionAttachedReplays, replayAlternativeFrom } from "../src/replay-alternatives";
import {
  canManualDetach,
  detachClearsServedClip,
  isManualAttach,
  manualAttachCandidates,
  manualAttachEvidence,
  manualAttachPatch,
  manualAttachRefusal,
  manualDetachRecord,
} from "../src/manual-alternative";

const JOB = "545be947-e989-4b26-a464-22b576d97373";
const OTHER_JOB = "a0e60cc2-0000-4000-8000-000000000000";

function record(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    id: "goal-h1",
    ownerId: "user-1",
    jobId: JOB,
    clipUri: "/clips/goal.mp4",
    start: 152,
    end: 167,
    localizedTs: 159,
    localizeSignal: "peak_frame",
    eventType: "GOAL",
    score: 95,
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-11-07T00:00:00.000Z",
    ...over,
  });
}

/** The named case: the goal, the 207 s replay window, and a third decided
 * window the operator could also attach. */
const goal = record();
const replayWindow = record({
  id: "play-h3",
  clipUri: "/clips/replay.mp4",
  start: 200,
  end: 215,
  localizedTs: 207,
  eventType: "BIG_PLAY",
  score: 60,
  outcome: "big_play",
  status: "pending",
});
const thirdWindow = record({
  id: "play-h4",
  clipUri: "/clips/third.mp4",
  start: 300,
  end: 315,
  localizedTs: 307,
  eventType: "BIG_PLAY",
  score: 55,
  outcome: "big_play",
});
const rejectedWindow = record({
  id: "play-h5",
  clipUri: "/clips/rejected.mp4",
  start: 400,
  end: 415,
  localizedTs: 407,
  status: "rejected",
});
const otherJobWindow = record({ id: "play-x1", jobId: OTHER_JOB, clipUri: "/clips/other.mp4" });
const noClipWindow = record({ id: "play-h6", clipUri: "", start: 500, end: 515, localizedTs: 507 });

describe("AC1 manual attach — candidates", () => {
  it("offers the job's other decided windows, anchor-ordered", () => {
    const records = [goal, replayWindow, thirdWindow];
    expect(manualAttachCandidates(goal, records).map((c) => c.id)).toEqual(["play-h3", "play-h4"]);
    expect(manualAttachCandidates(goal, records)[0]).toMatchObject({
      id: "play-h3",
      start: 200,
      end: 215,
      anchorTs: 207,
      clipUri: "/clips/replay.mp4",
    });
  });

  it("never offers the moment itself, a replay, another job, a rejected row or a clipless row", () => {
    const attached = record({
      id: "play-h7",
      replayOf: goal.id,
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    const records = [goal, replayWindow, thirdWindow, attached, rejectedWindow, otherJobWindow, noClipWindow];
    const ids = manualAttachCandidates(goal, records).map((c) => c.id);
    expect(ids).not.toContain(goal.id);
    expect(ids).not.toContain("play-h7");
    expect(ids).not.toContain("play-x1");
    expect(ids).not.toContain("play-h5");
    expect(ids).not.toContain("play-h6");
    expect(ids).toEqual(["play-h3", "play-h4"]);
  });

  it("never offers a window that already OWNS an alternative (no chains)", () => {
    const child = record({ id: "play-h8", replayOf: "play-h3", start: 210, end: 225, localizedTs: 217 });
    const ids = manualAttachCandidates(goal, [goal, replayWindow, child]).map((c) => c.id);
    expect(ids).toEqual([]);
  });

  it("offers nothing when the moment is itself a replay (a replay never owns)", () => {
    const replayMoment = record({ id: "play-h3", replayOf: "goal-h1", start: 200, end: 215 });
    expect(manualAttachCandidates(replayMoment, [goal, replayWindow, thirdWindow])).toEqual([]);
  });
});

describe("AC1/AC3 manual attach — the stored write", () => {
  it("writes the Inc 1 contract on the window only: replayOf + manual evidence", () => {
    const patch = manualAttachPatch(goal, replayWindow, "agent-9d2416aa", "2026-11-24T12:00:00.000Z");
    expect(patch.replayOf).toBe(goal.id);
    expect(patch.replayEvidence).toEqual({
      kind: "manual",
      matches: 0,
      compared: 0,
      gapS: 48,
      attachedBy: "agent-9d2416aa",
      attachedAt: "2026-11-24T12:00:00.000Z",
    });
    // A manual attach is NOT a detection: no fingerprint comparison ran.
    expect(patch.replayEvidence.matches).toBe(0);
    expect(patch.replayEvidence.compared).toBe(0);
  });

  it("keeps auto and manual attaches distinguishable in the stored row", () => {
    const auto = record({
      id: "play-h9",
      replayOf: goal.id,
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    const manual = record({
      id: "play-h10",
      replayOf: goal.id,
      replayEvidence: manualAttachEvidence(goal, replayWindow, "agent-1", "2026-11-24T12:00:00.000Z"),
    });
    expect(isManualAttach(manual)).toBe(true);
    expect(isManualAttach(auto)).toBe(false);
  });

  it("accepts the named case and refuses every illegal target", () => {
    const records = [goal, replayWindow, thirdWindow, rejectedWindow, otherJobWindow, noClipWindow];
    expect(manualAttachRefusal(goal, replayWindow.id, records)).toBeNull();
    expect(manualAttachRefusal(goal, goal.id, records)).toBe("same_window");
    expect(manualAttachRefusal(goal, "nope", records)).toBe("window_not_found");
    expect(manualAttachRefusal(goal, otherJobWindow.id, records)).toBe("cross_job");
    expect(manualAttachRefusal(goal, rejectedWindow.id, records)).toBe("window_rejected");
    expect(manualAttachRefusal(goal, noClipWindow.id, records)).toBe("window_has_no_clip");
    const already = record({ id: "play-h11", replayOf: "goal-h0" });
    expect(manualAttachRefusal(goal, already.id, [...records, already])).toBe("window_already_attached");
    const replayMoment = record({ id: "play-r", replayOf: goal.id });
    expect(manualAttachRefusal(replayMoment, replayWindow.id, [goal, replayWindow, replayMoment])).toBe(
      "moment_is_replay"
    );
  });
});

describe("AC2 invariants — attach adds no highlight, no clip, no count", () => {
  it("moves the window into alternatives[] and leaves every highlight lane unchanged", () => {
    const before = buildPostableHighlights([goal, replayWindow, thirdWindow]);
    const attached = record({
      ...replayWindow,
      replayOf: goal.id,
      replayEvidence: manualAttachPatch(goal, replayWindow, "agent-1").replayEvidence,
    });
    const records = [goal, attached, thirdWindow];
    const after = buildPostableHighlights(records);
    // The highlight count is the SAME: an attach never inserts or removes a row.
    expect(after.highlights.length).toBe(before.highlights.length);
    expect(after.highlights.map((h) => h.id)).not.toContain(replayWindow.id);
    // The owner's own row is untouched — its window, score, outcome, status.
    const owner = after.highlights.find((h) => h.id === goal.id)!;
    expect(owner.start).toBe(152);
    expect(owner.end).toBe(167);
    expect(owner.score).toBe(95);
    expect(owner.status).toBe("accepted");
    // The attached window is projected into the moment's alternative lane.
    const parts = partitionAttachedReplays(records);
    expect(parts.attached).toBe(1);
    expect(parts.byOwner.get(goal.id)!.map((r) => r.id)).toEqual([replayWindow.id]);
    const alt = replayAlternativeFrom(attached, goal.end);
    expect(alt.highlightId).toBe(goal.id);
    expect(alt.replayOf).toBe(goal.id);
    expect(alt.clipUri).toBe("/clips/replay.mp4");
    expect(alt.replayEvidence?.kind).toBe("manual");
  });

  it("detach restores the pre-attach row byte-for-byte (and the lane)", () => {
    const attached = record({
      ...replayWindow,
      replayOf: goal.id,
      replayEvidence: manualAttachPatch(goal, replayWindow, "agent-1", "2026-11-24T12:00:00.000Z").replayEvidence,
    });
    const detached = manualDetachRecord(attached);
    expect(detached.replayOf).toBeUndefined();
    expect(detached.replayEvidence).toBeUndefined();
    // Every other field is exactly what it was before the attach.
    expect(detached).toEqual(replayWindow);
    expect(partitionAttachedReplays([goal, detached]).attached).toBe(0);
    const restored = buildPostableHighlights([goal, detached]);
    expect(restored.notableMoments.moments.map((m) => m.owner.id)).toContain(replayWindow.id);
  });

  it("detach is offered only for a manual attach", () => {
    const manual = record({
      id: "play-h12",
      replayOf: goal.id,
      replayEvidence: manualAttachEvidence(goal, replayWindow, "agent-1"),
    });
    const auto = record({
      id: "play-h13",
      replayOf: goal.id,
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    expect(canManualDetach(manual)).toBe(true);
    expect(canManualDetach(auto)).toBe(false);
    expect(canManualDetach(goal)).toBe(false);
  });

  it("clears the served clip only when the detached window was the pick", () => {
    const serving = record({
      clipChoice: { alternativeId: "play-h3", clipUri: "/clips/replay.mp4", start: 200, end: 215, chosenAt: "x" },
    });
    expect(detachClearsServedClip(serving, "play-h3")).toBe(true);
    expect(detachClearsServedClip(serving, "play-h4")).toBe(false);
    expect(detachClearsServedClip(goal, "play-h3")).toBe(false);
  });
});
