// ADAAAA-9032 (rev-10 live grade, natural job `771f42de`, served `328bb3b`) —
// the AC5 defect the grade measured on 14 promoted rows:
//
//   "12 of 14 rows billed a 2nd `summaryCall` and every one of those 12 carries
//    `too-few-facts` — a deterministic refusal that §13.2 forbids retrying. Row
//    envelope 26 summaryCalls / 14 rows = 1.857 (bar <= 1.5)."
//
// All 12 are celebration rows (`eventType: BIG_PLAY`) whose attestation recorded
// NO measured outcome (`ballOutcome: null, goalCrossed: false,
// scoreBoardChanged: false`, `refusalReason: no_measured_authority`). Their menu
// is clock + action, but the `action` kind can only be relayed by an act nothing
// measured — the writer's only routes to it are the possession lexicon AC14
// deletes or a discrete act the box never saw. The retry is therefore futile by
// construction on this shape, and the rows end on ONE call each.
import { describe, expect, it } from "vitest";
import { runSummaryForRow, SummaryLane, type SummaryLaneStore } from "../src/summary-lane.js";
import { summaryRefusalIsRepairable, type SummaryEvidence } from "@highlights/events";

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

function stubFetch(summaries: string[]) {
  let i = 0;
  const seen: any[] = [];
  const fn = (async (_url: string, init: any) => {
    seen.push(JSON.parse(init.body));
    const summary = summaries[Math.min(i, summaries.length - 1)];
    i++;
    return new Response(JSON.stringify({ summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }) as unknown as Response;
  }) as unknown as typeof fetch;
  return { fn, seen, calls: () => i };
}

const cfg = (over: Record<string, unknown> = {}) => ({
  decideUrl: "http://decide.test",
  decideFee: 0.01,
  ...over,
});

const MATCH_CONTEXT = {
  sport: "soccer",
  teams: [
    { name: "Liverpool", side: "home", confidence: 0.5 },
    { name: "Chelsea", side: "away", confidence: 0.5 },
  ],
};

/** Row `01194e89` and its 11 siblings: celebration, no measured outcome. */
const celebrationEvidence = (): SummaryEvidence => ({
  rail: "live",
  verdict: "big_play",
  eventType: "BIG_PLAY",
  reason:
    "Chelsea scores a goal at t=0.0s | live scoring lane: the scorebug was never read in this span (scoreBoardChanged=false goalCrossed=false ballOutcome=none); audio/motion reaction is corroborating evidence only and cannot attest a score — delivered as a celebration, not a GOAL",
  caption: null,
  postTitle: "BIG PLAY · 4:10",
  windowTs: 249.558,
  windowDurationS: 15,
  scoreTransition: null,
  matchContext: MATCH_CONTEXT,
  transcript: null,
  adjacentScoreCue: null,
  matchClock: { token: "39:18", seconds: 2358, period: null, legible: true },
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false },
});

/** A row on the same job that DID measure the transition (the served `8cafc2a0`). */
const scoredEvidence = (): SummaryEvidence => ({
  ...celebrationEvidence(),
  verdict: "goal",
  eventType: "GOAL",
  windowTs: 464.44,
  scoreTransition: { from: "0-1", to: "1-1" },
});

/** The row's stored refused draft (`summaryRaw`), verbatim. */
const STORED_RAW =
  "Liverpool maintains their position during this sequence. At 4:09 into the clip, Chelsea attempts to move the ball forward as the two teams compete for space.";

describe("ADAAAA-9032 — a `too-few-facts` refusal the row cannot repair bills ONE call", () => {
  it("does not re-sample a celebration row that measured no outcome", async () => {
    const { store, patches } = stubStore();
    const { fn, calls } = stubFetch([STORED_RAW, STORED_RAW]);
    const result = await runSummaryForRow(store, cfg({ fetchImpl: fn }) as any, {
      jobId: "771f42de",
      highlightId: "01194e89",
      evidence: celebrationEvidence(),
    });
    expect(result.outcome).toBe("dropped");
    expect(result.calls).toBe(1);
    expect(calls()).toBe(1);
    const stored = patches.at(-1)?.patch as Record<string, unknown>;
    expect(stored.summary).toBeUndefined();
    expect(stored.summaryCalls).toBe(1);
    // The refusal is a `gate` refusal; the violation list rides the row.
    expect(stored.summaryGate).toBe("dropped:gate");
    expect(stored.summaryViolations).toContain("too-few-facts");
  });

  it("classifies the celebration shape as deterministic and the scored shape as relayable", () => {
    expect(summaryRefusalIsRepairable("too-few-facts", celebrationEvidence())).toBe(false);
    expect(summaryRefusalIsRepairable("too-few-facts", scoredEvidence())).toBe(true);
    // The measured population, counted: 14 promoted rows, 12 refused, 0 retried.
    const rows = Array.from({ length: 14 }, () => celebrationEvidence());
    expect(rows.filter((e) => !summaryRefusalIsRepairable("too-few-facts", e)).length).toBe(14);
  });

  it("keeps the job envelope at 1.0 calls/row over the 12 refused rows", async () => {
    const { store } = stubStore();
    const lane = new SummaryLane("771f42de", store, cfg({ fetchImpl: stubFetch([STORED_RAW]).fn }) as any);
    const ids = [
      "01194e89", "3e2f8d87", "976d40d1", "8ce0fde6", "d2f990f5", "52ad0844",
      "76597ef6", "019e21c5", "2ff40a71", "7a7bf87a", "c02885ed", "c8d1dd24",
    ];
    // The lane's pending ring is 8, so a live job drains in waves; keep each wave
    // inside the ring so this test measures the CALL decision, not the ring.
    for (const wave of [ids.slice(0, 8), ids.slice(8)]) {
      for (const highlightId of wave) {
        lane.enqueue({ jobId: "771f42de", highlightId, evidence: celebrationEvidence() } as any);
      }
      await lane.idle();
    }
    const meter = lane.snapshot();
    expect(meter.summaryCalls).toBe(12);
    expect(meter.summaryCalls / ids.length).toBe(1);
    expect(meter.summaryDropped).toBe(12);
    expect(meter.summaryDroppedByReason).toEqual({ gate: 12 });
  });
});
