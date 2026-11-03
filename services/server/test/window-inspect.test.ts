import { describe, it, expect } from "vitest";
import { JobCandidateSchema, type JobCandidate } from "@highlights/events";
import { buildSections, stripWindowInspection } from "../src/job-detail";
import { buildTestApp } from "./helpers";

// ADAAAA-7838: owner-facing window inspection is LAZY and payload-gated.
//
// The composite `/jobs/:id/detail` payload used to carry the full per-window LLM
// capture (`analysis`: prompt / dataItems / media refs / response / audioSeries,
// plus the Stage-2 `confirm` record) on EVERY decide note. On a long job that is
// the bulk of the response, and a customer page rendered none of it. This pins
// the new contract:
//
//   - without `?inspect=1`: zero decide notes carry `analysis` or `confirm`, on
//     both `/detail` and `/sections-delta`, and the response is measurably
//     smaller;
//   - with `?inspect=1`: every per-window field that existed before is still
//     present (no field disappears when the flag is on);
//   - `GET /jobs/:id/sections/:index/inspect` returns ONE bucket's notes with
//     their full capture, so the page can load a single window;
//   - the flag is NOT an authorization mechanism: a non-owner keeps 403 on all
//     three routes with and without it.

const WINDOW_COUNT = 34; // > 30 windows, like the job the AC measures

/** A realistic decide-prompt length (the real capture is ~1-2 KB per window). */
const PROMPT = `You are a highlight judge. ${"Window evidence: ball in the net at 12.4s. ".repeat(28)}`;

function analysisFor(ts: number) {
  return {
    prompt: `${PROMPT}T+${ts.toFixed(1)}s`,
    dataItems: [
      { type: "candidate", label: "Candidate event type", value: "GOAL" },
      { type: "score", label: "Stage-1 score", value: 90 },
    ],
    frames: [{ seq: Math.floor(ts), uri: `/jobs/j/frames/${Math.floor(ts)}` }],
    images: [{ seq: Math.floor(ts) + 1, uri: `/jobs/j/frames/${Math.floor(ts) + 1}` }],
    audio: { path: "input_audio" as const, uri: "", sampleRate: 16000 },
    asr: { transcript: "and he scores!" },
    audioSeries: Array.from({ length: 12 }, (_, i) => ({ t: Math.max(0, ts - 2 + i * 0.4), energy: 0.2 + i * 0.05, baseline: 0.3 })),
    response: { isHighlight: true, score: 92, outcome: "scoring_play" as const, reasoning: "ball crossed the line" },
  };
}

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }, jobId: string): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId,
    seq: Math.floor(over.timestamp),
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: new Date().toISOString(),
    ...over,
  });
}

/** Seed one frame per bucket plus a decide note with a full capture per bucket. */
async function seed(store: any, jobId: string) {
  for (let i = 0; i < WINDOW_COUNT; i++) {
    const ts = i * 3 + 1.5;
    await store.recordObservation(jobId, { seq: i, timestamp: ts, tracks: [] });
    await store.recordJobCandidate(
      cand(
        {
          timestamp: ts,
          reason: "ball in net",
          analysis: analysisFor(ts),
          confirm: {
            request: { prompt: "You are a highlight CONFIRMATION judge...", dataItems: [], frames: [], keyframes: [], trajectories: [], audioLevels: [0.2, 0.8] },
            decision: { goalConfirmed: "confirmed_goal", confidence: 0.95, stage1Disagreed: false, outcome: "scoring_play" },
          },
        },
        jobId
      )
    );
  }
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

function bytesOf(res: any): number {
  return Buffer.byteLength(res.payload, "utf8");
}

/** Every decide note in a section list, flattened. */
function allNotes(body: any): any[] {
  return (body.sections ?? []).flatMap((s: any) => s.decideNotes ?? []);
}

function notesWithKey(body: any, key: "analysis" | "confirm"): any[] {
  return allNotes(body).filter((n: any) => Object.prototype.hasOwnProperty.call(n, key));
}

describe("stripWindowInspection (ADAAAA-7838)", () => {
  it("drops analysis + confirm from every note and keeps everything else", () => {
    const sections = buildSections(
      [{ seq: 0, timestamp: 1.5, tracks: [] } as any],
      [cand({ timestamp: 1.5, reason: "ball in net", analysis: analysisFor(1.5) as any }, "job-1")],
      "job-1"
    );
    const stripped = stripWindowInspection(sections);
    const note = stripped[0].decideNotes[0];
    expect(Object.prototype.hasOwnProperty.call(note, "analysis")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(note, "confirm")).toBe(false);
    // the identity of the window survives
    expect(note).toMatchObject({ timestamp: 1.5, eventType: "GOAL", score: 90, status: "accepted", reason: "ball in net" });
    expect(stripped[0].index).toBe(0);
    expect(stripped[0].frames.map((f) => f.seq)).toEqual([0]);
    // the input section list is untouched (fresh objects, stored rows safe)
    expect(sections[0].decideNotes[0].analysis).toBeTruthy();
  });
});

describe("GET /jobs/:id/detail payload gating (ADAAAA-7838 AC1/AC2)", () => {
  it("omits analysis/confirm without ?inspect=1 and shrinks the response", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "inspect-gate@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      const off = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth });
      expect(off.statusCode).toBe(200);
      const offBody = off.json();

      const on = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail?inspect=1`, headers: auth });
      expect(on.statusCode).toBe(200);
      const onBody = on.json();

      // AC1: ZERO notes carry the per-window capture without the flag.
      expect(notesWithKey(offBody, "analysis")).toEqual([]);
      expect(notesWithKey(offBody, "confirm")).toEqual([]);
      expect(allNotes(offBody).length).toBe(WINDOW_COUNT);
      // ...and the response is measurably smaller (measured well over 40% here).
      const offBytes = bytesOf(off);
      const onBytes = bytesOf(on);
      expect(onBytes).toBeGreaterThan(offBytes);
      expect(offBytes / onBytes).toBeLessThan(0.6);

      // Everything else about the payload is unchanged.
      expect(offBody.sections.map((s: any) => s.index)).toEqual(onBody.sections.map((s: any) => s.index));
      expect(offBody.sections.flatMap((s: any) => s.frames.map((f: any) => f.seq))).toEqual(
        onBody.sections.flatMap((s: any) => s.frames.map((f: any) => f.seq))
      );
      expect(offBody.highlights).toEqual(onBody.highlights);
      expect(offBody.maxTraces).toBe(onBody.maxTraces);
      expect(offBody.summaryLadder).toEqual(onBody.summaryLadder);
      // capture/liveProgress are derived from stored counters and carry a
      // read-time `updatedAt`, so compare their content, not the stamp.
      expect({ ...offBody.capture, updatedAt: undefined }).toEqual({ ...onBody.capture, updatedAt: undefined });
      expect({ ...offBody.liveProgress, updatedAt: undefined }).toEqual({ ...onBody.liveProgress, updatedAt: undefined });
      expect(offBody.sections[0].decideNotes[0]).toMatchObject({
        timestamp: 1.5,
        eventType: "GOAL",
        score: 90,
        status: "accepted",
        reason: "ball in net",
      });

      // AC2: with the flag on, every field that existed before still exists.
      expect(onBody.sections.length).toBe(offBody.sections.length);
      expect(notesWithKey(onBody, "analysis").length).toBe(WINDOW_COUNT);
      expect(notesWithKey(onBody, "confirm").length).toBe(WINDOW_COUNT);
      const first = onBody.sections[0].decideNotes[0];
      expect(first.analysis.prompt).toContain("You are a highlight judge.");
      expect(first.analysis.response).toMatchObject({ isHighlight: true, score: 92, outcome: "scoring_play" });
      expect(first.analysis.dataItems).toHaveLength(2);
      expect(first.analysis.frames).toHaveLength(1);
      expect(first.analysis.images).toHaveLength(1);
      expect(first.analysis.audioSeries).toHaveLength(12);
      expect(first.confirm.decision.goalConfirmed).toBe("confirmed_goal");
    } finally {
      await app.close();
    }
  });
});

describe("GET /jobs/:id/sections-delta payload gating (ADAAAA-7838 AC1)", () => {
  it("omits analysis/confirm without ?inspect=1 and keeps them with it", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "inspect-delta@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      const off = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=-1`, headers: auth });
      expect(off.statusCode).toBe(200);
      const offBody = off.json();
      const on = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=-1&inspect=1`, headers: auth });
      expect(on.statusCode).toBe(200);
      const onBody = on.json();

      expect(notesWithKey(offBody, "analysis")).toEqual([]);
      expect(notesWithKey(offBody, "confirm")).toEqual([]);
      expect(notesWithKey(onBody, "analysis").length).toBe(WINDOW_COUNT);
      expect(notesWithKey(onBody, "confirm").length).toBe(WINDOW_COUNT);
      expect(bytesOf(off)).toBeLessThan(bytesOf(on));
      // the window list itself is not trimmed by the flag
      expect(offBody.sections.map((s: any) => s.index)).toEqual(onBody.sections.map((s: any) => s.index));
      expect(offBody.maxIndex).toBe(onBody.maxIndex);
    } finally {
      await app.close();
    }
  });
});

describe("GET /jobs/:id/sections/:index/inspect (ADAAAA-7838 AC3)", () => {
  it("returns exactly one bucket's notes with their full capture", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "inspect-lazy@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      const one = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections/7/inspect`, headers: auth });
      expect(one.statusCode).toBe(200);
      const body = one.json();
      expect(body.jobId).toBe(job.id);
      expect(body.index).toBe(7);
      expect(body.startS).toBe(21);
      expect(body.endS).toBe(24);
      expect(body.decideNotes).toHaveLength(1);
      expect(body.decideNotes[0].timestamp).toBe(7 * 3 + 1.5);
      expect(body.decideNotes[0].analysis.prompt).toContain("You are a highlight judge.");
      expect(body.decideNotes[0].analysis.response.score).toBe(92);
      expect(body.decideNotes[0].analysis.audioSeries).toHaveLength(12);
      expect(body.decideNotes[0].confirm.decision.goalConfirmed).toBe("confirmed_goal");

      // A small fraction of the full internals payload — that is the point of
      // the lazy route.
      const full = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail?inspect=1`, headers: auth });
      expect(bytesOf(one) / bytesOf(full)).toBeLessThan(0.1);
    } finally {
      await app.close();
    }
  });

  it("404s an index with no section, 400s a non-integer, 404s an unknown job", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "inspect-lazy-404@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      const missing = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections/9999/inspect`, headers: auth });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toEqual({ error: "section not found" });

      const bad = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections/abc/inspect`, headers: auth });
      expect(bad.statusCode).toBe(400);

      const noJob = await app.inject({ method: "GET", url: `/jobs/does-not-exist/sections/0/inspect`, headers: auth });
      expect(noJob.statusCode).toBe(404);

      const anon = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections/0/inspect` });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("403s a non-owner (the lazy route is no side door)", async () => {
    const { app, store } = await buildTestApp();
    try {
      const owner = await register(app, "inspect-lazy-owner@test.local");
      const other = await register(app, "inspect-lazy-other@test.local");
      const job = await store.createJob({ ownerId: owner.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);

      const r = await app.inject({
        method: "GET",
        url: `/jobs/${job.id}/sections/0/inspect`,
        headers: { authorization: `Bearer ${other.token}` },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: "forbidden" });
    } finally {
      await app.close();
    }
  });
});

describe("inspect=1 is not an authorization mechanism (ADAAAA-7838 AC4)", () => {
  it("a non-owner gets 403 on all three routes with AND without the flag", async () => {
    const { app, store } = await buildTestApp();
    try {
      const owner = await register(app, "inspect-auth-owner@test.local");
      const other = await register(app, "inspect-auth-other@test.local");
      const job = await store.createJob({ ownerId: owner.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);

      const routes = [
        `/jobs/${job.id}/detail`,
        `/jobs/${job.id}/detail?inspect=1`,
        `/jobs/${job.id}/sections-delta?afterIndex=-1`,
        `/jobs/${job.id}/sections-delta?afterIndex=-1&inspect=1`,
        `/jobs/${job.id}/sections/0/inspect`,
      ];
      for (const url of routes) {
        const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${other.token}` } });
        expect(r.statusCode, url).toBe(403);
        expect(r.json()).toEqual({ error: "forbidden" });
      }

      // Positive control: the owner gets 200 on the same routes.
      for (const url of routes) {
        const r = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${owner.token}` } });
        expect(r.statusCode, url).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
