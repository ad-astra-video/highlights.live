// ADAAAA-7868 (AC-P8): the match-context resolver's evidence status must be
// readable from the STORED job record, not just from a server log line.
//
// These tests pin the read path end to end against a real Store + SQLite db and
// the real HTTP route:
// - E1 a seeded record returns the evidence beside `matchContext` from GET /jobs/:id
// - E2 a legacy record (no field) parses and omits it cleanly
// - E3 a rejected evidence field cannot take `matchContext` down
// - ADAAAA-7889 (AC2): the evidence explanation must be visible on the OWNING
//   user's GET /jobs/:id (that is the graded route for "an unknown result is
//   diagnosable from the record"), with only the perceive session handle
//   stripped (ADAAAA-7727 rule).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { JobSchema } from "@highlights/events";
import { buildTestApp, type TestApp } from "./helpers";
import type { MatchContext } from "../src/match-context";

const MATCH_CONTEXT: MatchContext = {
  sport: "soccer",
  teams: [
    {
      name: "Portugal",
      side: "home",
      kitColors: [{ primary: "red", secondary: "orange" }],
      confidence: 0.9,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" }],
    },
    {
      name: "Spain",
      side: "away",
      kitColors: [],
      confidence: 0.9,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 1 - 0 ESP" }],
    },
  ],
  inferredAt: "2026-11-03T15:00:00.000Z",
  resolverVersion: 1,
  ambiguous: false,
  trail: [{ at: "2026-11-03T15:00:00.000Z", progressPct: 50, names: [], action: ["kept Portugal at home"] }],
};

/** The status the shipped resolver returns for the ADAAAA-7866 replay job. */
const EVIDENCE = {
  scorebugOcrFrames: 1,
  commentaryChars: 2122,
  kitSamples: 252,
  kitSampleFrames: 224,
  kitSampleTracks: 17,
  scorebugSwatches: 134,
  sources: ["scorebug_ocr", "asr", "metadata"],
  kitClusterColors: ["white", "red"],
  kitColorsUnattributed: [],
  kitPriorUsed: ["away"],
  kitPriorMiss: [],
  kitPriorConflict: [],
  sessionId: "sess-7859",
  sessionEvidence: true,
  sport: "soccer",
  // ADAAAA-7889 (AC2): the per-channel breakdown that makes an `unknown`
  // diagnosable from GET /jobs/:id alone.
  channelOutcomes: {
    scorebug_ocr: { frames: 1, lines: 1, teamLines: 1, teams: [{ name: "Portugal", side: "home" }], rawLines: ["POR 1 - 0 ESP"] },
    asr: { chars: 2122, mentions: [{ name: "Spain", snippet: "Spain in white", start: 0, end: 15, kitColor: "white" }] },
    metadata: { candidates: [{ name: "Portugal", side: "home", field: "title", fuzzy: false }] },
    fold: {
      usableConfidence: 0.6,
      singleSourceCap: 0.55,
      home: { name: "Portugal", confidence: 0.9, sources: ["metadata", "scorebug_ocr"] },
      away: null,
    },
  },
};

describe("match-context evidence on the stored job record (ADAAAA-7868)", () => {
  let t: TestApp;
  let adminToken: string;
  let userToken: string;
  let seededId: string;
  let legacyId: string;

  async function login(email: string, password: string): Promise<string> {
    const r = await t.app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  beforeAll(async () => {
    t = await buildTestApp();
    const reg = await t.app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "matchctx@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    userToken = reg.json().token as string;
    const ownerId = (reg.json().user as { id: string }).id;
    adminToken = await login("admin@test.local", "adminpass");

    // Seeded exactly as the resolver writes it: ONE patchJob carrying the
    // context and its evidence together. No pipeline, no GPU, no ffmpeg.
    const seeded = await t.store.createJob({ ownerId, source: "file", gameHint: "soccer" });
    seededId = seeded.id;
    await t.store.patchJob(seededId, {
      status: "done",
      matchContext: MATCH_CONTEXT as any,
      matchContextEvidence: EVIDENCE as any,
    } as any);

    // A record written BEFORE this change: no `matchContext`, no evidence.
    const legacy = await t.store.createJob({ ownerId, source: "file" });
    legacyId = legacy.id;
    await t.store.patchJob(legacy.id, { status: "done" } as any);
  });

  afterAll(async () => {
    await t.app.close();
  });

  it("E1: GET /jobs/:id returns the evidence status beside matchContext", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/jobs/${seededId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const job = res.json().job;
    expect(job.matchContext.teams[0].name).toBe("Portugal");
    const ev = job.matchContextEvidence;
    expect(ev).toBeTruthy();
    // The fields the operator needs to answer "why has Spain no colour?".
    expect(ev.kitClusterColors).toEqual(["white", "red"]);
    expect(ev.kitColorsUnattributed).toEqual([]);
    expect(ev.kitPriorUsed).toEqual(["away"]);
    expect(ev.kitPriorMiss).toEqual([]);
    expect(ev.kitPriorConflict).toEqual([]);
    expect(ev.scorebugOcrFrames).toBe(1);
    expect(ev.kitSampleFrames).toBe(224);
    expect(ev.sessionId).toBe("sess-7859");
  });

  it("E1: the stored row survives a re-parse with the evidence intact (no silent strip)", async () => {
    const stored = t.store.getJob(seededId)!;
    expect(stored.matchContextEvidence).toEqual(EVIDENCE);
    // Same object the dataset/zod validator would see on a reload.
    const reparsed = JobSchema.parse(stored);
    expect(reparsed.matchContextEvidence).toEqual(EVIDENCE);
  });

  it("E2: a legacy record parses and omits the field cleanly", async () => {
    const stored = t.store.getJob(legacyId)!;
    expect(stored.matchContextEvidence).toBeUndefined();
    expect(
      JobSchema.parse({ id: "legacy", source: "file", status: "done", createdAt: "2026-11-01T00:00:00Z" })
        .matchContextEvidence
    ).toBeUndefined();
    const res = await t.app.inject({
      method: "GET",
      url: `/jobs/${legacyId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().job).not.toHaveProperty("matchContextEvidence");
    expect(res.json().job.matchContext).toBeUndefined();
  });

  it("E3: a rejected evidence field rejects nothing else — matchContext still persists", async () => {
    const job = await t.store.createJob({ ownerId: t.store.getJob(seededId)!.ownerId, source: "file" });
    // Stand-in for a resolver that returned a corrupted marker: the store's
    // JobSchema.parse rejects the whole patch …
    await expect(
      t.store.patchJob(job.id, {
        matchContext: MATCH_CONTEXT as any,
        matchContextEvidence: { scorebugOcrFrames: "many" } as any,
      } as any)
    ).rejects.toThrow();
    expect(t.store.getJob(job.id)!.matchContext).toBeUndefined();
    // … and the documented fallback (write the context alone) lands.
    await t.store.patchJob(job.id, { matchContext: MATCH_CONTEXT as any } as any);
    const after = t.store.getJob(job.id)!;
    expect(after.matchContext?.teams[0].name).toBe("Portugal");
    expect(after.matchContextEvidence).toBeUndefined();
  });

  it("exposes the evidence explanation to a non-admin but drops its session handle (ADAAAA-7889 AC2)", async () => {
    const res = await t.app.inject({
      method: "GET",
      url: `/jobs/${seededId}`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const job = res.json().job;
    // The customer's explainability view (teams + colours) stays …
    expect(job.matchContext.teams[1].side).toBe("away");
    // … and so does the per-channel breakdown AC2 requires on this route.
    expect(job.matchContextEvidence).toBeTruthy();
    expect(job.matchContextEvidence.channelOutcomes.scorebug_ocr.rawLines).toEqual(["POR 1 - 0 ESP"]);
    expect(job.matchContextEvidence.channelOutcomes.asr.mentions[0].snippet).toBe("Spain in white");
    expect(job.matchContextEvidence.channelOutcomes.fold.usableConfidence).toBe(0.6);
    // … while the live perceive session handle does not leak (ADAAAA-7727 rule).
    expect(job.matchContextEvidence).not.toHaveProperty("sessionId");
    expect(job.matchContextEvidence.kitPriorUsed).toEqual(["away"]);
  });
});
