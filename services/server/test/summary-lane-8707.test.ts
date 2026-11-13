// ADAAAA-8707 (spec ADAAAA-8665 rev 3): AC8 — the JOB-scoped distinct-opening
// guard on the caption body copy.
//
// The measured failing shape (build `b2912b6`): 6 of 8 accepted bodies in one
// job opened "The midfielder...", and 5 of 8 shared "drives forward". The pure
// opening-run/fact/role pieces are pinned in
// `packages/events/test/highlight-summary-8707.test.ts`; this file pins the lane
// behaviour the ticket names:
//   * two bodies that serve with the SAME 4-word opening must not both serve;
//   * the guard is JOB-scoped (two jobs may reuse an opening);
//   * a repeat drop never blanks the card — no `summary`, only the meter and the
//     candidate body as `summaryRaw`;
//   * a repeat drop is metered on the row AND rollable to the job record.
import { describe, expect, it } from "vitest";
import {
  SummaryLane,
  newSummaryJobState,
  runSummaryForRow,
  SUMMARY_LANE_PENDING_RING,
  type SummaryLaneStore,
} from "../src/summary-lane.js";
import { jobSummaryMeterFields } from "../src/api.js";
import { summaryOpeningRun, type SummaryEvidence } from "@highlights/events";

/**
 * The AC7 sample's evidence shape: a clock-anchored play with teams but NO role
 * noun and NO score change. `reason`/`caption` deliberately say "midfield" (a
 * position area), never "midfielder" (a role claim), so AC10 neutralises the
 * measured "The midfielder drives forward..." opening into "The move drives
 * forward..." — and the repeat guard sees the SERVED opening, which is what a
 * job actually ships.
 */
const evidence = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots in midfield",
  caption: "Ball shoots in midfield",
  postTitle: null,
  windowTs: 12,
  windowDurationS: 8,
  scoreTransition: null,
  matchContext: { teams: [{ name: "Northbridge" }, { name: "Riverside" }] },
  transcript: "",
  ...extra,
});

/** Two different bodies whose served form opens with the same four words.
 *  Rev 4 (ADAAAA-8735): each names the match context's team, because AC9 now
 *  credits `action` only off a NAMED attested actor; the opening collision is
 *  unchanged. */
// ADAAAA-8914 (AC14.1): the second sentence used to be "The crowd answers it
// before the restart." — an atmosphere clause the clause repair deletes, which
// took each body under the live floor before the opening guard could even run.
const SAME_OPENING_A =
  "The midfielder drives forward for Northbridge at 0:12 as the move builds through midfield. Northbridge keeps possession as the move builds on the left.";
const SAME_OPENING_B =
  "The midfielder drives forward for Northbridge at 0:12 and the move opens up on the left. Northbridge keeps possession as the move opens up.";
/** The SERVED form of `SAME_OPENING_A`: AC10 neutralises the unattested
 *  "the midfielder" subject, and the repeat guard compares served openings. */
const NEUTRALISED_A =
  "The move drives forward for Northbridge at 0:12 as the move builds through midfield. Northbridge keeps possession as the move builds on the left.";
/** A body that clears the gate with a DIFFERENT opening run. */
const DISTINCT_OPENING =
  "A low shot from the edge of the box is blocked by Northbridge at 0:12. Northbridge recycles the ball and switches play to the left.";

function stubStore() {
  const patches: { id: string; patch: Record<string, unknown> }[] = [];
  const store: SummaryLaneStore = {
    async patchHighlightSummary(id, patch) {
      patches.push({ id, patch });
      return {};
    },
  };
  return { store, patches };
}

function stubFetch(answers: (Response | Error)[]) {
  let i = 0;
  const seen: any[] = [];
  const fn = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    const next = answers[Math.min(i, answers.length - 1)];
    i++;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as unknown as typeof fetch;
  return { fn, seen, calls: () => i };
}

const ok = (summary: string) =>
  new Response(JSON.stringify({ summary }), { status: 200, headers: { "content-type": "application/json" } });

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.01,
  log: () => {},
  ...over,
});

describe("AC8 — the opening guard is per-row and JOB-scoped", () => {
  it("does not serve two bodies that open with the same four words", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_B)]);
    const run = cfg({ fetchImpl: f.fn });

    const first = await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h1", evidence: evidence() }, state);
    expect(first.outcome).toBe("stored");
    const servedOpening = summaryOpeningRun(String(patches[0].patch.summary));
    expect(servedOpening).toBe("the move drives forward");

    const second = await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h2", evidence: evidence() }, state);
    // The regeneration repeats the opening too: the second body is DROPPED.
    expect(second.outcome).toBe("dropped");
    expect(second.reason).toBe("repeat");
    expect(second.calls).toBe(2);
    expect(second.calls).toBeLessThanOrEqual(2);
    expect(patches[1].id).toBe("h2");
    expect(patches[1].patch.summary).toBeUndefined();
    expect(patches[1].patch.summaryGate).toBe("dropped:repeat");
    expect(patches[1].patch.summaryDroppedByReason).toEqual({ repeat: 1 });
    // Only ONE body in this job carries that opening.
    const openings = patches.map((p) => p.patch.summary).filter(Boolean).map((s) => summaryOpeningRun(String(s)));
    expect(openings).toEqual([servedOpening]);
  });

  it("asks the regeneration for a different opening (prompt first, gate as backstop)", async () => {
    const { store } = stubStore();
    const state = newSummaryJobState();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_B)]);
    const run = cfg({ fetchImpl: f.fn });
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h1", evidence: evidence() }, state);
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h2", evidence: evidence() }, state);
    // Call 1 (h1) has nothing to avoid; call 3 (h2's ONE regeneration) names the
    // opening already served in this job.
    expect(f.seen[0].prompt).not.toContain("already-served runs");
    expect(f.seen[2].prompt).toContain("already-served runs");
    expect(f.seen[2].prompt).toContain("'the move drives forward'");
  });

  it("serves a regeneration that lands on a different opening", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_B), ok(DISTINCT_OPENING)]);
    const run = cfg({ fetchImpl: f.fn });
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h1", evidence: evidence() }, state);
    const second = await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h2", evidence: evidence() }, state);
    expect(second.outcome).toBe("stored");
    expect(second.calls).toBe(2);
    expect(patches[1].patch.summary).toBe(DISTINCT_OPENING);
    expect(patches[1].patch.summaryGate).toBe("accepted");
    // Both openings now held by the job.
    expect([...state.servedOpenings].sort()).toEqual(["a low shot from", "the move drives forward"]);
  });

  it("is JOB-scoped: a different job may reuse the same opening", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_A)]);
    const run = cfg({ fetchImpl: f.fn });
    const jobOne = await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h1", evidence: evidence() }, newSummaryJobState());
    const jobTwo = await runSummaryForRow(store, run, { jobId: "j2", highlightId: "h2", evidence: evidence() }, newSummaryJobState());
    expect([jobOne.outcome, jobTwo.outcome]).toEqual(["stored", "stored"]);
    expect(patches.map((p) => p.patch.summary)).toEqual([NEUTRALISED_A, NEUTRALISED_A]);
  });

  it("keeps two LANES (one per job) independent — the scope is structural", async () => {
    const { store, patches } = stubStore();
    const laneA = new SummaryLane("j1", store, cfg({ fetchImpl: stubFetch([ok(SAME_OPENING_A)]).fn }));
    const laneB = new SummaryLane("j2", store, cfg({ fetchImpl: stubFetch([ok(SAME_OPENING_A)]).fn }));
    expect(laneA.enqueue({ jobId: "j1", highlightId: "h1", evidence: evidence() })).toBe(true);
    expect(laneB.enqueue({ jobId: "j2", highlightId: "h2", evidence: evidence() })).toBe(true);
    await laneA.idle();
    await laneB.idle();
    expect(laneA.snapshot()).toMatchObject({ summaryDropped: 0 });
    expect(laneB.snapshot()).toMatchObject({ summaryDropped: 0 });
    expect(patches.map((p) => p.patch.summary)).toEqual([NEUTRALISED_A, NEUTRALISED_A]);
  });
});

describe("AC8 — a repeat drop never blanks the card", () => {
  it("writes the meter and the candidate body, and touches no served field", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_B)]);
    const run = cfg({ fetchImpl: f.fn });
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h1", evidence: evidence() }, state);
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "h2", evidence: evidence() }, state);

    const drop = patches[1].patch;
    // The card keeps its headline/caption/verdict: the lane may only write the
    // six `summary*` fields, so nothing served is rewritten or removed.
    expect(drop.summary).toBeUndefined();
    for (const served of ["postTitle", "caption", "verdict", "status", "clipUri"]) {
      expect(drop).not.toHaveProperty(served);
    }
    // AC8's `not_captured` close: the regenerated/refused body is replayable at
    // $0 by QA, the same way ADAAAA-8687 stores a gate refusal.
    expect(drop.summaryRaw).toBe(SAME_OPENING_B);
    expect(drop.summaryCalls).toBe(2);
    expect(drop.summaryDropped).toBe(1);
  });
});

describe("AC8 — the repeat reason is readable on the row AND the job", () => {
  it("rolls up to the job-level meter fields when every body after the first repeats", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(SAME_OPENING_A), ok(SAME_OPENING_B), ok(SAME_OPENING_B)]);
    const lane = new SummaryLane("j1", store, cfg({ fetchImpl: f.fn }));
    for (const id of ["h1", "h2", "h3"]) {
      expect(lane.enqueue({ jobId: "j1", highlightId: id, evidence: evidence() })).toBe(true);
    }
    await lane.idle();

    // h1 serves; h2 and h3 are dropped for repetition, never silently.
    expect(patches[0].patch.summary).toBe(NEUTRALISED_A);
    for (const dropped of patches.slice(1)) {
      expect(dropped.patch.summary).toBeUndefined();
      expect(dropped.patch.summaryDroppedByReason).toEqual({ repeat: 1 });
    }
    expect(SUMMARY_LANE_PENDING_RING).toBeGreaterThanOrEqual(2);

    const meter = lane.snapshot();
    expect(meter.summaryCalls).toBe(5);
    expect(meter.summaryDropped).toBe(2);
    expect(meter.summaryDroppedByReason).toEqual({ repeat: 2 });
    // The job record publishes the same rollup, so "this job lost its bodies to
    // repetition" is a read, not a log grep.
    expect(jobSummaryMeterFields(meter)).toMatchObject({
      summaryCalls: 5,
      summaryDropped: 2,
      summaryDroppedByReason: { repeat: 2 },
    });
  });
});
