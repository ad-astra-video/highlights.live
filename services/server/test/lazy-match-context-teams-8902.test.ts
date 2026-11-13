/**
 * ADAAAA-8902: the surface-identity team reference must be read per `/analyze`,
 * not frozen when the analyzer config is built.
 *
 * On the served build the identity pass never ran on any session: the resolver
 * lands `matchContext` seconds AFTER the job starts (job 796e202d: +4.6 s), and
 * the eager `calibration.matchContextTeams` merge captured `undefined` at config
 * build, so perceive's `_surface_identity_pass` returned immediately on every
 * frame (`if not teams: return None`) and nothing was ever emitted.
 *
 * These tests pin the delivery contract:
 *  - the reference arrives on the FIRST analyze that runs after the resolver
 *    lands, even though the config object was built before it existed;
 *  - a job with no resolved `matchContext` sends NO field at all, so the
 *    `/analyze` body stays byte-identical (AC6 posture, identity `absent`);
 *  - nothing invents a team, and a throwing reader is "no reference", never a
 *    failed pass.
 */
import { describe, expect, it } from "vitest";
import {
  analyzeJob,
  deliveredMatchContextTeams,
  shapeMatchContextTeams,
  type AnalyzerConfig,
  type PipelineClient,
} from "../src/analyzer";

/** The shape a served job's persisted `matchContext.teams` carries. */
const RESOLVED_TEAMS = [
  { side: "home", name: "Real Madrid", kitColors: [{ primary: "white" }], confidence: 0.9, evidence: [] },
  { side: "away", name: "Barcelona", kitColors: [], confidence: 0.85, evidence: [] },
];

function fakeClient(over: Partial<PipelineClient> = {}): PipelineClient {
  return {
    reservePerceive: async () => ({ sessionId: "sess-8902", appUrl: "", controlUrl: "" }),
    analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 } }),
    decide: async () => ({ isHighlight: false, score: 0, eventType: "GOAL" }),
    plan: async () => ({ planVersion: 1, category: "soccer", intent: "", source: "planner-fallback", maxTracks: 3, targets: [], reason: "test" }),
    stopPerceive: async () => {},
    postAudio: async () => ({ candidate: null, series: [] }),
    controlForward: async () => null,
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    confirm: async () => ({ enabled: false, goalConfirmed: null, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, eventType: "GOAL" } }),
    ...over,
  } as PipelineClient;
}

async function* frames(n: number) {
  for (let i = 0; i < n; i++) yield { seq: i, timestamp: i, imageB64: `img${i}` };
}

describe("deliveredMatchContextTeams (ADAAAA-8902)", () => {
  it("reads the job's LIVE reader, so teams that land later are delivered", () => {
    let ctx: { teams?: unknown } | undefined;
    const cfg = { getMatchContext: () => ctx, calibration: {} };
    // The config was assembled BEFORE the resolver ran: nothing to deliver.
    expect(deliveredMatchContextTeams(cfg)).toEqual([]);
    // Seconds later the resolver lands — the very next analyze carries it.
    ctx = { teams: RESOLVED_TEAMS };
    expect(deliveredMatchContextTeams(cfg)).toEqual([
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white" }] },
      { side: "away", name: "Barcelona", kitColors: [] },
    ]);
  });

  it("keeps the build-time calibration as the fallback, never a conflict", () => {
    const stale = [{ side: "home", name: "Stale", kitColors: [] }];
    const live = [{ side: "away", name: "Barcelona", kitColors: [] }];
    // No reader => the build-time copy is the only source.
    expect(deliveredMatchContextTeams({ calibration: { matchContextTeams: stale } })).toEqual(stale);
    // Reader yields nothing => same fallback (a resumed job keeps its reference).
    expect(
      deliveredMatchContextTeams({ getMatchContext: () => undefined, calibration: { matchContextTeams: stale } }),
    ).toEqual(stale);
    // Reader yields teams => the LIVE value wins over the frozen one.
    expect(
      deliveredMatchContextTeams({ getMatchContext: () => ({ teams: live }), calibration: { matchContextTeams: stale } }),
    ).toEqual(live);
  });

  it("treats a throwing reader as no reference (never a failed pass)", () => {
    const fallback = [{ side: "home", name: "Real Madrid", kitColors: [] }];
    expect(
      deliveredMatchContextTeams({
        getMatchContext: () => {
          throw new Error("store unavailable");
        },
        calibration: { matchContextTeams: fallback },
      }),
    ).toEqual(fallback);
  });

  it("sends nothing for an empty/unusable reference (byte-identical posture)", () => {
    expect(deliveredMatchContextTeams({})).toEqual([]);
    expect(deliveredMatchContextTeams({ getMatchContext: () => ({ teams: [] }) })).toEqual([]);
    expect(deliveredMatchContextTeams({ getMatchContext: () => ({ teams: undefined }) })).toEqual([]);
    expect(deliveredMatchContextTeams({ getMatchContext: () => ({}) })).toEqual([]);
  });

  it("shapes only home/away sides with a name or a kit colour", () => {
    const shaped = shapeMatchContextTeams([
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white", secondary: "gold" }] },
      { side: "away", name: "Barcelona", kitColors: [{ nonsense: true }, { primary: "red" }, { primary: "x" }, { primary: "y" }] },
      { side: "unknown", name: "Unattributed", kitColors: [{ primary: "green" }] },
      { side: "home", name: "", kitColors: [] },
      null,
    ]);
    expect(shaped).toEqual([
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white", secondary: "gold" }] },
      // capped at 2 usable colours, junk entries dropped
      { side: "away", name: "Barcelona", kitColors: [{ primary: "red" }, { primary: "x" }] },
    ]);
    // A `{teams}` wrapper is accepted too (the persisted record's own shape).
    expect(shapeMatchContextTeams({ teams: RESOLVED_TEAMS })).toHaveLength(2);
  });
});

describe("the live analyze loop delivers teams that resolve mid-session", () => {
  it("carries no matchContextTeams before the resolver lands, then carries it", async () => {
    // The job record starts with an EMPTY matchContext — exactly the served
    // state at config-build time. `matchContextId` is patched between frames.
    let ctx: { teams?: unknown } | undefined;
    const vocabs: any[] = [];
    const client = fakeClient({
      analyze: async (_sessionId: string, _frame: any, vocab: any) => {
        vocabs.push(vocab);
        // The resolver publishes its teams while the pass is running (+4.6 s on
        // the served job). Frame 0 sees nothing; frame 1 must see the teams.
        if (vocabs.length === 1) ctx = { teams: RESOLVED_TEAMS };
        return { observation: { tracks: [], seq: 0, timestamp: 0 } } as any;
      },
    });
    const cfg = {
      jobId: "job-8902",
      clipBeforeS: 4,
      clipAfterS: 4,
      gameHint: "soccer",
      getMatchContext: () => ctx,
    } as unknown as AnalyzerConfig;

    await analyzeJob(
      client,
      frames(2),
      async () => ({ clipId: "c", clipUri: "/c.mp4", hasAudio: true }),
      cfg,
    );

    expect(vocabs.length).toBeGreaterThanOrEqual(2);
    // Frame 0: no resolved reference yet => the field is ABSENT (byte-identical).
    expect("matchContextTeams" in vocabs[0]).toBe(false);
    // Frame 1: the reference resolved mid-session and is delivered on the very
    // next analyze — the defect was that it never was.
    expect(vocabs[1].matchContextTeams).toEqual([
      { side: "home", name: "Real Madrid", kitColors: [{ primary: "white" }] },
      { side: "away", name: "Barcelona", kitColors: [] },
    ]);
  });

  it("never adds the field on a job with no matchContext (all frames)", async () => {
    const vocabs: any[] = [];
    const client = fakeClient({
      analyze: async (_sessionId: string, _frame: any, vocab: any) => {
        vocabs.push(vocab);
        return { observation: { tracks: [], seq: 0, timestamp: 0 } } as any;
      },
    });
    await analyzeJob(
      client,
      frames(3),
      async () => ({ clipId: "c", clipUri: "/c.mp4", hasAudio: true }),
      { jobId: "job-8902-b", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer", getMatchContext: () => undefined } as unknown as AnalyzerConfig,
    );
    expect(vocabs.length).toBeGreaterThan(0);
    expect(vocabs.every((v) => !("matchContextTeams" in v))).toBe(true);
  });
});
