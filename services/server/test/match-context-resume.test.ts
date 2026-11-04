// ADAAAA-7912: match-context evidence must survive a VOD resume.
//
// Measured on job ddf5c47f (deployed box, ADAAAA-7900 Leg A): a concurrent
// deploy recreated highlights-server + highlights-perceive and the auto-resumed
// attempt re-ran the evidence pass over the resumed tail only (cursorTs 81 of a
// 90 s clip). The final record published `channelOutcomes.scorebug_ocr
// {frames 0, lines 0, teamLines 0}`, `sources ["scorebug_ocr:not_captured",
// "asr","metadata"]` and `fold.away {Spain, 0.15, ["metadata"]}` with
// `ambiguous: false`, while the trail in the SAME record showed
// `away=Spain@0.65` at 25% and 50% before the recreate.
//
// These tests cover the server half: a resumed attempt seeds from the persisted
// record (matchContext + matchContextEvidence, the durable accumulator the
// resume checkpoint already leaves untouched) and may never publish less than
// the record knows; a below-floor attribution can never publish as
// unambiguous.
import { describe, expect, it } from "vitest";

import {
  DEFAULT_MATCH_CONTEXT_ASR_SECONDS,
  MATCH_CONTEXT_USABLE_CONFIDENCE,
  applyResumeCarryForward,
  carryForwardTrailEntry,
  createVodMatchContextResolver,
  guardMatchContextRegression,
  isResumedAttempt,
  mergeEvidenceSources,
  mergeMatchContextEvidence,
  type MatchContext,
} from "../src/match-context";
import type { MatchContextEvidence } from "@highlights/events";

const PRE_INTERRUPTION_CONTEXT: MatchContext = {
  sport: "soccer",
  teams: [
    {
      name: "Portugal",
      side: "home",
      kitColors: [{ primary: "red" }],
      confidence: 0.95,
      evidence: [
        { source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" },
        { source: "asr", snippet: "Portugal keep the ball" },
      ],
    },
    {
      name: "Spain",
      side: "away",
      kitColors: [{ primary: "white" }],
      confidence: 0.65,
      evidence: [
        { source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" },
        { source: "asr", snippet: "Spain in the white shirts" },
      ],
    },
  ],
  inferredAt: "2026-11-03T23:28:34.204Z",
  resolverVersion: 1,
  ambiguous: false,
  trail: [
    {
      at: "2026-11-03T23:26:09.908Z",
      progressPct: 25,
      names: [
        { side: "home", name: "Portugal", confidence: 0.95 },
        { side: "away", name: "Spain", confidence: 0.65 },
      ],
      action: ["no change"],
    },
    {
      at: "2026-11-03T23:28:34.204Z",
      progressPct: 50,
      names: [
        { side: "home", name: "Portugal", confidence: 0.95 },
        { side: "away", name: "Spain", confidence: 0.65 },
      ],
      action: ["no change"],
    },
  ],
};

/** Evidence the pre-interruption attempts paid for (24 scorebug OCR frames). */
const PRE_INTERRUPTION_EVIDENCE = {
  scorebugOcrFrames: 24,
  commentaryChars: 2122,
  kitSamples: 252,
  kitSampleFrames: 224,
  kitSampleTracks: 17,
  scorebugSwatches: 134,
  sources: ["scorebug_ocr", "asr", "metadata"],
  kitClusterColors: ["white", "red"],
  channelOutcomes: {
    scorebug_ocr: {
      frames: 24,
      lines: 48,
      teamLines: 24,
      teams: [
        { name: "Portugal", side: "home" },
        { name: "Spain", side: "away" },
      ],
      rawLines: ["POR 1 - 0 ESP"],
    },
    asr: {
      chars: 2122,
      mentions: [{ name: "Spain", snippet: "Spain in the white shirts", start: 1, end: 4, kitColor: "white" }],
    },
    metadata: {
      candidates: [{ name: "Portugal", side: "home", field: "title", fuzzy: false }],
    },
    fold: {
      usableConfidence: MATCH_CONTEXT_USABLE_CONFIDENCE,
      singleSourceCap: 0.55,
      home: { name: "Portugal", confidence: 0.95, sources: ["scorebug_ocr", "asr", "metadata"] },
      away: { name: "Spain", confidence: 0.65, sources: ["scorebug_ocr", "asr"] },
    },
  },
  sessionId: "sess-before-recreate",
  sessionEvidence: true,
  sport: "soccer",
} satisfies MatchContextEvidence;

/** What the resumed tail actually produced: no score graphic in 81 s -> 90 s. */
const RESUMED_TAIL_CONTEXT: MatchContext = {
  sport: "soccer",
  teams: [
    {
      name: "Portugal",
      side: "home",
      kitColors: [{ primary: "red" }],
      confidence: 0.95,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" }],
    },
    {
      name: "Spain",
      side: "away",
      kitColors: [],
      confidence: 0.15,
      evidence: [{ source: "metadata", snippet: "Spain" }],
    },
  ],
  inferredAt: "2026-11-03T23:39:43.778Z",
  resolverVersion: 1,
  ambiguous: false,
  trail: [
    ...PRE_INTERRUPTION_CONTEXT.trail,
    {
      at: "2026-11-03T23:39:43.778Z",
      progressPct: 0,
      names: [
        { side: "home", name: "Portugal", confidence: 0.95 },
        { side: "away", name: "Spain", confidence: 0.15 },
      ],
      action: ["no change"],
    },
  ],
};

const RESUMED_TAIL_EVIDENCE = {
  scorebugOcrFrames: 0,
  commentaryChars: 2122,
  sources: ["scorebug_ocr:not_captured", "asr", "metadata"],
  channelOutcomes: {
    scorebug_ocr: { frames: 0, lines: 0, teamLines: 0, teams: [], rawLines: [] },
    asr: {
      chars: 2122,
      mentions: [{ name: "Spain", snippet: "Spain in the white shirts", start: 1, end: 4, kitColor: "white" }],
    },
    metadata: {
      candidates: [{ name: "Spain", side: "away", field: "filename", fuzzy: false }],
    },
    fold: {
      usableConfidence: MATCH_CONTEXT_USABLE_CONFIDENCE,
      singleSourceCap: 0.55,
      home: null,
      away: { name: "Spain", confidence: 0.15, sources: ["metadata"] },
    },
  },
  sessionId: "sess-after-recreate",
  sessionEvidence: true,
  sport: "soccer",
} satisfies MatchContextEvidence;

function fakeStore(initial: Record<string, unknown>) {
  const jobs = new Map<string, any>([["job1", { id: "job1", status: "analyzing", ...initial }]]);
  const patches: any[] = [];
  return {
    patches,
    getJob: (id: string) => jobs.get(id),
    patchJob: async (id: string, patch: any) => {
      patches.push(patch);
      const next = { ...(jobs.get(id) ?? {}), ...patch };
      jobs.set(id, next);
      return next;
    },
  };
}

function deps(store: ReturnType<typeof fakeStore>, client: any) {
  return {
    jobId: "job1",
    videoPath: "/data/job1.mp4",
    sessionId: "sess-1",
    hints: { title: "Portugal vs Spain", gameHint: "soccer", filename: "job1.mp4" },
    cfg: {
      ffmpegPath: "/nonexistent/ffmpeg",
      asrUrl: "http://127.0.0.1:1",
      asrSeconds: DEFAULT_MATCH_CONTEXT_ASR_SECONDS,
      asrMaxBytes: 8 * 1024 * 1024,
    },
    client,
    getJob: store.getJob,
    patchJob: store.patchJob,
    log: () => {},
    probeCommentary: async () => ({ text: "Spain in the white shirts", seconds: 90, bytes: 1000 }),
  };
}

describe("isResumedAttempt", () => {
  it("is true only once the record shows a second attempt", () => {
    expect(isResumedAttempt(undefined)).toBe(false);
    expect(isResumedAttempt({ attempts: 1 } as any)).toBe(false);
    expect(isResumedAttempt({ attempts: 2 } as any)).toBe(true);
    expect(isResumedAttempt({ attempts: 0, resume: { totalAttempts: 3 } } as any)).toBe(true);
    expect(isResumedAttempt({ attempts: 0, resume: { resumedAt: "2026-11-03T23:29:28.118Z" } } as any)).toBe(true);
  });
});

describe("mergeEvidenceSources", () => {
  it("keeps a source captured by ANY attempt and drops the not_captured marker", () => {
    expect(
      mergeEvidenceSources(["scorebug_ocr", "asr", "metadata"], ["scorebug_ocr:not_captured", "asr", "metadata"])
    ).toEqual(["scorebug_ocr", "asr", "metadata"]);
    // Order follows the older pass; a marker only survives when neither pass captured it.
    expect(mergeEvidenceSources(["asr", "metadata"], ["asr:not_captured", "metadata", "kit:not_captured"])).toEqual([
      "asr",
      "metadata",
      "kit:not_captured",
    ]);
  });
});

describe("mergeMatchContextEvidence", () => {
  it("keeps the pre-interruption counters, provenance and strongest fold", () => {
    const merged = mergeMatchContextEvidence(
      PRE_INTERRUPTION_EVIDENCE as MatchContextEvidence,
      RESUMED_TAIL_EVIDENCE as MatchContextEvidence
    );
    // The resumed tail's zeroes never win.
    expect(merged.scorebugOcrFrames).toBe(24);
    expect(merged.kitSamples).toBe(252);
    expect(merged.sources).toEqual(["scorebug_ocr", "asr", "metadata"]);
    expect(merged.channelOutcomes?.scorebug_ocr?.frames).toBe(24);
    expect(merged.channelOutcomes?.scorebug_ocr?.lines).toBe(48);
    expect(merged.channelOutcomes?.scorebug_ocr?.teamLines).toBe(24);
    expect(merged.channelOutcomes?.scorebug_ocr?.teams).toEqual([
      { name: "Portugal", side: "home" },
      { name: "Spain", side: "away" },
    ]);
    expect(merged.channelOutcomes?.scorebug_ocr?.rawLines).toEqual(["POR 1 - 0 ESP"]);
    // Per-pass candidates are unioned, so the resumed pass's own read is kept too.
    expect(merged.channelOutcomes?.metadata?.candidates?.map((c) => `${c.name}:${c.field}`)).toEqual([
      "Portugal:title",
      "Spain:filename",
    ]);
    // The fold reports the strongest claim the JOB saw, matching the guarded teams.
    expect(merged.channelOutcomes?.fold?.away?.confidence).toBe(0.65);
    expect(merged.channelOutcomes?.fold?.home?.confidence).toBe(0.95);
    // Live-session fields follow the CURRENT pass.
    expect(merged.sessionId).toBe("sess-after-recreate");
  });

  it("returns the incoming status unchanged when the record has none", () => {
    expect(mergeMatchContextEvidence(undefined, RESUMED_TAIL_EVIDENCE as MatchContextEvidence)).toBe(
      RESUMED_TAIL_EVIDENCE
    );
  });
});

describe("guardMatchContextRegression", () => {
  it("keeps the stronger team per side (and its evidence) instead of lowering it", () => {
    const guarded = guardMatchContextRegression(PRE_INTERRUPTION_CONTEXT, RESUMED_TAIL_CONTEXT);
    const away = guarded.teams.find((t) => t.side === "away");
    expect(away?.name).toBe("Spain");
    expect(away?.confidence).toBe(0.65);
    // The pre-interruption evidence (scorebug_ocr) survives with the team.
    expect(away?.evidence.map((e) => e.source)).toEqual(["scorebug_ocr", "asr"]);
    expect(away?.kitColors).toEqual([{ primary: "white" }]);
    expect(guarded.ambiguous).toBe(false);
  });

  it("carries forward a side the thin pass dropped entirely", () => {
    const guarded = guardMatchContextRegression(PRE_INTERRUPTION_CONTEXT, {
      ...RESUMED_TAIL_CONTEXT,
      teams: RESUMED_TAIL_CONTEXT.teams.filter((t) => t.side === "home"),
    });
    expect(guarded.teams.map((t) => t.side)).toEqual(["home", "away"]);
    expect(guarded.teams.find((t) => t.side === "away")?.confidence).toBe(0.65);
  });

  it("forces ambiguous when a published attribution is below the usable floor", () => {
    const guarded = guardMatchContextRegression(undefined, RESUMED_TAIL_CONTEXT);
    const away = guarded.teams.find((t) => t.side === "away");
    expect(away?.confidence).toBe(0.15);
    expect(guarded.ambiguous).toBe(true);
  });

  it("does not invent ambiguity for a fully usable pair", () => {
    const guarded = guardMatchContextRegression(undefined, PRE_INTERRUPTION_CONTEXT);
    expect(guarded.ambiguous).toBe(false);
    expect(guarded.teams).toEqual(PRE_INTERRUPTION_CONTEXT.teams);
  });
});

describe("applyResumeCarryForward — the trail explains the guard (ADAAAA-7921)", () => {
  it("appends exactly one entry naming the kept team, its confidence and the rejected read", () => {
    const published = applyResumeCarryForward(PRE_INTERRUPTION_CONTEXT, RESUMED_TAIL_CONTEXT, 0);
    // Exactly ONE extra entry beyond the pass's own trail.
    expect(published.trail).toHaveLength(RESUMED_TAIL_CONTEXT.trail.length + 1);
    const entry = published.trail[published.trail.length - 1];
    expect(entry.progressPct).toBe(0);
    expect(entry.action).toEqual([
      "carry-forward: kept away Spain@0.65, pass read 0.15 below floor 0.60",
    ]);
    // The entry's names are the PUBLISHED attribution, never the rejected read.
    expect(entry.names).toEqual([
      { side: "home", name: "Portugal", confidence: 0.95 },
      { side: "away", name: "Spain", confidence: 0.65 },
    ]);
    // The guard's published teams still win.
    expect(published.teams.find((t) => t.side === "away")?.confidence).toBe(0.65);
  });

  it("names a restored side when the thin pass dropped it entirely", () => {
    const published = applyResumeCarryForward(
      PRE_INTERRUPTION_CONTEXT,
      { ...RESUMED_TAIL_CONTEXT, teams: RESUMED_TAIL_CONTEXT.teams.filter((t) => t.side === "home") },
      50
    );
    const entry = published.trail[published.trail.length - 1];
    expect(entry.action).toEqual(["carry-forward: restored away Spain@0.65, pass dropped the side"]);
    expect(entry.progressPct).toBe(50);
  });

  it("writes no entry when the pass read IS the published attribution", () => {
    // Previous record is WEAKER than the resumed pass, so the guard publishes
    // the pass's own read (and only forces `ambiguous` for the below-floor side).
    const weakerRecord: MatchContext = {
      ...PRE_INTERRUPTION_CONTEXT,
      teams: PRE_INTERRUPTION_CONTEXT.teams.map((t) => (t.side === "away" ? { ...t, confidence: 0.1 } : t)),
    };
    const guarded = guardMatchContextRegression(weakerRecord, RESUMED_TAIL_CONTEXT);
    expect(guarded.teams.find((t) => t.side === "away")?.confidence).toBe(0.15);
    expect(carryForwardTrailEntry(RESUMED_TAIL_CONTEXT, guarded, 0)).toBeNull();
    const published = applyResumeCarryForward(weakerRecord, RESUMED_TAIL_CONTEXT, 0);
    expect(published.trail).toHaveLength(RESUMED_TAIL_CONTEXT.trail.length);
  });

  it("bounds the trail at the resolver's cap", () => {
    const longTrail: MatchContext = {
      ...RESUMED_TAIL_CONTEXT,
      trail: Array.from({ length: 12 }, () => RESUMED_TAIL_CONTEXT.trail[0]),
    };
    const published = applyResumeCarryForward(PRE_INTERRUPTION_CONTEXT, longTrail, 0);
    expect(published.trail).toHaveLength(12);
    expect(published.trail[11].action[0]).toMatch(/^carry-forward: kept away Spain@0\.65/);
  });
});

describe("createVodMatchContextResolver — resume after a deploy recreate (ADAAAA-7912)", () => {
  it("keeps the pre-interruption confidence and channelOutcomes on the resumed record", async () => {
    const store = fakeStore({
      // The durable accumulator: attempts 1-3 persisted this before the recreate.
      attempts: 4,
      resume: {
        version: 1,
        phase: "analyze",
        attempts: [{ attempt: 3, startedAt: "2026-11-03T23:29:28.118Z", endedAt: "2026-11-03T23:39:11.256Z" }],
        totalAttempts: 4,
        resumedAt: "2026-11-03T23:39:41.316Z",
        resumedFromTs: 81,
        analyze: { cursorTs: 81 },
      },
      matchContext: PRE_INTERRUPTION_CONTEXT,
      matchContextEvidence: PRE_INTERRUPTION_EVIDENCE,
    });
    const client = {
      postMatchContext: async () => ({
        matchContext: RESUMED_TAIL_CONTEXT,
        evidenceStatus: RESUMED_TAIL_EVIDENCE,
      }),
    };
    const r = createVodMatchContextResolver(deps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();

    const final = store.getJob("job1");
    // AC: a resumed job's final matchContext keeps the pre-interruption confidence.
    expect(final.matchContext.teams.find((t: any) => t.side === "away")).toMatchObject({
      name: "Spain",
      confidence: 0.65,
    });
    expect(final.matchContext.teams.find((t: any) => t.side === "home")).toMatchObject({
      name: "Portugal",
      confidence: 0.95,
    });
    expect(final.matchContext.ambiguous).toBe(false);
    // AC: channelOutcomes is not reset to the resumed tail's zeroes.
    expect(final.matchContextEvidence.scorebugOcrFrames).toBe(24);
    expect(final.matchContextEvidence.sources).toEqual(["scorebug_ocr", "asr", "metadata"]);
    expect(final.matchContextEvidence.channelOutcomes.scorebug_ocr).toMatchObject({
      frames: 24,
      lines: 48,
      teamLines: 24,
    });
    // The context and its evidence land in the SAME patchJob (E1).
    expect(store.patches).toHaveLength(1);
    expect(store.patches[0].matchContextEvidence).toBeTruthy();

    // ADAAAA-7921: the persisted trail explains the carry-forward. A record
    // whose trail ends at the rejected 0.15 while its teams say 0.65 is now
    // impossible to construct.
    expect(final.matchContext.trail).toHaveLength(RESUMED_TAIL_CONTEXT.trail.length + 1);
    const last = final.matchContext.trail[final.matchContext.trail.length - 1];
    expect(last.action).toEqual([
      "carry-forward: kept away Spain@0.65, pass read 0.15 below floor 0.60",
    ]);
    const trailAway = last.names.find((n: any) => n.side === "away");
    expect(trailAway).toEqual({ side: "away", name: "Spain", confidence: 0.65 });
    expect(final.matchContext.teams.find((t: any) => t.side === "away").confidence).toBe(trailAway.confidence);
  });

  it("keeps the persisted evidence when the resumed pass returns no status (E2 on a resume)", async () => {
    const store = fakeStore({
      attempts: 2,
      resume: { version: 1, phase: "analyze", attempts: [], totalAttempts: 2, resumedAt: "2026-11-03T23:39:41.316Z" },
      matchContext: PRE_INTERRUPTION_CONTEXT,
      matchContextEvidence: PRE_INTERRUPTION_EVIDENCE,
    });
    const client = { postMatchContext: async () => ({ matchContext: RESUMED_TAIL_CONTEXT }) };
    const r = createVodMatchContextResolver(deps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();
    const final = store.getJob("job1");
    expect(final.matchContextEvidence).toEqual(PRE_INTERRUPTION_EVIDENCE);
    expect(final.matchContext.teams.find((t: any) => t.side === "away").confidence).toBe(0.65);
  });

  it("cannot publish a below-floor attribution as unambiguous", async () => {
    const store = fakeStore({ attempts: 1 });
    const client = {
      postMatchContext: async () => ({
        matchContext: { ...RESUMED_TAIL_CONTEXT, teams: [RESUMED_TAIL_CONTEXT.teams[1]] },
        evidenceStatus: RESUMED_TAIL_EVIDENCE,
      }),
    };
    const r = createVodMatchContextResolver(deps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();
    const final = store.getJob("job1");
    expect(final.matchContext.teams).toHaveLength(1);
    expect(final.matchContext.teams[0].confidence).toBeLessThan(MATCH_CONTEXT_USABLE_CONFIDENCE);
    expect(final.matchContext.ambiguous).toBe(true);
  });

  it("leaves a first attempt's context and evidence untouched", async () => {
    const store = fakeStore({ attempts: 1 });
    const client = {
      postMatchContext: async () => ({
        matchContext: PRE_INTERRUPTION_CONTEXT,
        evidenceStatus: { ...RESUMED_TAIL_EVIDENCE, scorebugOcrFrames: 24, sources: ["scorebug_ocr", "asr", "metadata"] },
      }),
    };
    const r = createVodMatchContextResolver(deps(store, client));
    r.begin();
    r.onProgress(0);
    await r.finish();
    const final = store.getJob("job1");
    expect(final.matchContext).toEqual(PRE_INTERRUPTION_CONTEXT);
    expect(final.matchContextEvidence.scorebugOcrFrames).toBe(24);
    expect(final.matchContextEvidence.channelOutcomes.metadata.candidates).toHaveLength(1);
  });
});
