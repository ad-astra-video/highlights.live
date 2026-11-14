// ADAAAA-8735 (spec ADAAAA-8665 rev 4): the two AC8/AC9 defects QA-F2 measured,
// pinned at the LANE seam — the surface that actually serves or drops a body.
//
// AC8: on `9891ff33` two bodies differed ONLY by their leading clock, so the
// rev-3 opening run ("at 3 23 the" vs "at 3 57 the") never collided and the
// job-scoped regenerate-once-then-drop guard never fired. With the rev-4
// normaliser both runs are "the ball shoots on", so the second body is
// regenerated once and then dropped `repeat`.
//
// AC9: a row with no matchContext and no transcript (the browser live rail) has
// only the clock available; a body that names no team/player must refuse
// `too-few-facts` instead of earning `clock + action` off the word "Ball".
import { describe, expect, it } from "vitest";
import { newSummaryJobState, runSummaryForRow, type SummaryLaneStore } from "../src/summary-lane.js";
import { summaryOpeningRun, type SummaryEvidence } from "@highlights/events";

/** The browser live rail's evidence: no persisted matchContext, no transcript —
 *  the measured `9891ff33` shape. */
const liveNoNames = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason: "Ball shoots on the right.",
  caption: "Ball shoots on the right.",
  postTitle: null,
  windowTs: 203,
  windowDurationS: 8,
  scoreTransition: null,
  matchContext: null,
  transcript: null,
  ...extra,
});

/** A row whose matchContext names the team the body names. */
const teamContext = (extra: Partial<SummaryEvidence> = {}): SummaryEvidence =>
  liveNoNames({ matchContext: { teams: [{ name: "Northbridge" }, { name: "Riverside" }] }, transcript: "", ...extra });

/** Two bodies, identical prose, differing ONLY by the leading clock — the
 *  decisive pair from `9891ff33` (`be041aaf` / `8b444000`, Jaccard 0.9091). */
// ADAAAA-8914 (AC14.1): the second sentence used to be "This action occurs during
// the match as the play develops toward the wing." — a sentence with no attested
// fact, deleted by the clause repair (which took the body under the live floor
// before the opening guard could run). The opening collision under test is
// unchanged: both bodies still start "northbridge shoot on".
const CLOCK_A =
  "At 3:23, Northbridge shoot on the right side of the field. Northbridge keeps possession as the play develops toward the wing.";
const CLOCK_B =
  "At 3:57, Northbridge shoot on the right side of the field. Northbridge keeps possession as the play develops toward the wing.";
/** A body that clears the gate with a DIFFERENT opening run. */
const DISTINCT =
  "A low drive from Northbridge is blocked at 3:30 at the edge of the box. Northbridge recycles the ball and switches play to the left.";
/** The rev-3 served body the ticket names: clock plus a bare verb, no actor. */
const BARE_VERB =
  "At 2:53, the ball shoots on the left side of the field. This action occurs during the match as the play develops toward the wing.";

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

describe("AC8 rev 4 — two bodies differing only by the leading clock", () => {
  it("does not serve the second one: regenerate once, then drop `repeat`", async () => {
    const { store, patches } = stubStore();
    const state = newSummaryJobState();
    const f = stubFetch([ok(CLOCK_A), ok(CLOCK_B)]);
    const run = cfg({ fetchImpl: f.fn });

    const first = await runSummaryForRow(store, run, { jobId: "9891ff33", highlightId: "be041aaf", evidence: teamContext() }, state);
    expect(first.outcome).toBe("stored");
    expect(summaryOpeningRun(String(patches[0].patch.summary))).toBe("northbridge shoot on the");

    const second = await runSummaryForRow(store, run, { jobId: "9891ff33", highlightId: "8b444000", evidence: teamContext() }, state);
    expect(second.outcome).toBe("dropped");
    expect(second.reason).toBe("repeat");
    expect(second.calls).toBe(2);

    expect(patches[1].id).toBe("8b444000");
    expect(patches[1].patch.summary).toBeUndefined();
    expect(patches[1].patch.summaryGate).toBe("dropped:repeat");
    expect(patches[1].patch.summaryDroppedByReason).toEqual({ repeat: 1 });
    expect(patches[1].patch.summaryRaw).toBe(CLOCK_B);
    // Only ONE body in the job carries that opening.
    const served = patches.map((p) => p.patch.summary).filter(Boolean).map(String);
    expect(served).toEqual([CLOCK_A]);
    expect([...state.servedOpenings]).toEqual(["northbridge shoot on the"]);
  });

  it("asks the regeneration to avoid the clock-stripped opening", async () => {
    const { store } = stubStore();
    const f = stubFetch([ok(CLOCK_A), ok(CLOCK_B)]);
    const run = cfg({ fetchImpl: f.fn });
    const state = newSummaryJobState();
    await runSummaryForRow(store, run, { jobId: "9891ff33", highlightId: "h1", evidence: teamContext() }, state);
    await runSummaryForRow(store, run, { jobId: "9891ff33", highlightId: "h2", evidence: teamContext() }, state);
    expect(f.seen[0].prompt).not.toContain("already-served runs");
    expect(f.seen[2].prompt).toContain("already-served runs");
    expect(f.seen[2].prompt).toContain("'northbridge shoot on the'");
  });

  it("keeps one card per instant: a differently-worded body on the SAME window drops", async () => {
    // ADAAAA-8969 (increment 2, defect 3): the scoped key reads the INSTANT, so a
    // different window serves whatever the opening run is. The same pair of bodies
    // on one window is still one moment (the drop test above).
    const { store, patches } = stubStore();
    const f = stubFetch([ok(CLOCK_A), ok(CLOCK_B), ok(DISTINCT)]);
    const run = cfg({ fetchImpl: f.fn });
    const state = newSummaryJobState();
    await runSummaryForRow(store, run, { jobId: "j1", highlightId: "be041aaf", evidence: teamContext() }, state);
    const second = await runSummaryForRow(
      store,
      run,
      {
        jobId: "j1",
        highlightId: "8b444000",
        // A different window AND this row's own attested clock (`3:57`), so the
        // gate credits the body's clock and the scoped key sees a different moment.
        evidence: teamContext({
          windowTs: 240,
          windowDurationS: 8,
          matchClock: { token: "3:57", seconds: 237, period: null, legible: true },
        }),
      },
      state
    );
    expect(second.outcome).toBe("stored");
    expect(second.calls).toBe(1);
    expect(String(patches[1].patch.summary)).toContain("Northbridge shoot on the right");
    expect(patches[1].patch.summaryGate).toBe("accepted");
    expect([...state.servedOpenings]).toEqual(["northbridge shoot on the"]);
  });
});

describe("AC9 rev 4 — action needs a named attested actor at the lane seam", () => {
  it("drops the rev-3 bare-verb body as too-few-facts, keeping the reply as evidence", async () => {
    const { store, patches } = stubStore();
    const f = stubFetch([ok(BARE_VERB)]);
    const run = cfg({ fetchImpl: f.fn });
    const result = await runSummaryForRow(
      store,
      run,
      { jobId: "9891ff33", highlightId: "a0f9f311", evidence: liveNoNames({ windowTs: 173 }) },
      newSummaryJobState()
    );
    expect(result.outcome).toBe("dropped");
    expect(result.reason).toBe("gate");
    // ADAAAA-8773: `too-few-facts` is deterministic, so the row ends on ONE call
    // (the pre-8773 lane spent two and billed 2.0x DECIDE_FEE).
    expect(result.calls).toBe(1);
    expect(patches[0].patch.summary).toBeUndefined();
    expect(patches[0].patch.summaryGate).toBe("dropped:gate");
    expect(patches[0].patch.summaryRaw).toBe(BARE_VERB);
    expect(patches[0].patch.summaryDroppedByReason).toEqual({ gate: 1 });
    expect(patches[0].patch.summaryCalls).toBe(1);
  });

  it("stores the same body when it NAMES the attested team", async () => {
    const { store, patches } = stubStore();
    // ADAAAA-8914: the second sentence now carries the team's play (the old one,
    // "This action occurs during the match as the play develops toward the wing.",
    // asserts nothing and is deleted by the clause repair).
    const body =
      "At 3:23, Northbridge shoot on the right side of the field. Northbridge keeps possession as the play develops toward the wing.";
    const f = stubFetch([ok(body)]);
    const run = cfg({ fetchImpl: f.fn });
    const result = await runSummaryForRow(
      store,
      run,
      { jobId: "j1", highlightId: "h1", evidence: teamContext() },
      newSummaryJobState()
    );
    expect(result.outcome).toBe("stored");
    expect(result.calls).toBe(1);
    expect(patches[0].patch.summary).toBe(body);
    expect(patches[0].patch.summaryGate).toBe("accepted");
  });
});
