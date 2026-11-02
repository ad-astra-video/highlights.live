import { describe, it, expect } from "vitest";
import { JobCandidateSchema, type JobCandidate } from "@highlights/events";
import { buildTestApp } from "./helpers";

// ADAAAA-7742: GET /jobs/:id/sections-delta is the read path an OPEN live
// job-detail page uses to append the analysis windows it does not hold yet,
// instead of re-fetching the whole composite `/jobs/:id/detail` payload (which
// grows with every 3 s window). It must:
//   - return only sections whose bucket index is greater than ?afterIndex,
//   - keep the owner-or-admin scoping of the detail route (403 cross-owner),
//   - reject a malformed afterIndex (400),
//   - carry the small mutable companions (postable highlights, summary ladder)
//     so highlights/summary keep streaming with the windows.

async function register(app: any, email: string) {
  const r = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "pw-at-least-8" },
  });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }, jobId: string): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId,
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: new Date().toISOString(),
    ...over,
  });
}

/** Seed one frame observation per 3 s bucket: buckets 0..3. */
async function seed(store: any, jobId: string) {
  for (const [seq, ts] of [
    [0, 0.5],
    [1, 3.5],
    [2, 6.5],
    [3, 9.5],
  ] as const) {
    await store.recordObservation(jobId, { seq, timestamp: ts, tracks: [] });
  }
}

describe("GET /jobs/:id/sections-delta (ADAAAA-7742)", () => {
  it("returns only the sections after afterIndex, and the whole list for -1", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "delta-owner@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      const all = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=-1`, headers: auth });
      expect(all.statusCode).toBe(200);
      const allBody = all.json();
      expect(allBody.sections.map((s: any) => s.index)).toEqual([0, 1, 2, 3]);
      expect(allBody.maxIndex).toBe(3);
      expect(allBody.sectionCount).toBe(4);
      expect(allBody.jobId).toBe(job.id);

      const tail = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=1`, headers: auth });
      expect(tail.statusCode).toBe(200);
      const tailBody = tail.json();
      expect(tailBody.sections.map((s: any) => s.index)).toEqual([2, 3]);
      expect(tailBody.maxIndex).toBe(3);
      // The accumulated payload is NOT re-sent: fewer buckets on the wire.
      expect(tailBody.sections.length).toBeLessThan(allBody.sections.length);

      const caughtUp = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=3`, headers: auth });
      expect(caughtUp.statusCode).toBe(200);
      expect(caughtUp.json().sections).toEqual([]);
      expect(caughtUp.json().maxIndex).toBe(3);
    } finally {
      await app.close();
    }
  });

  it("attaches a decide note to its bucket so a re-requested tail bucket carries it", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "delta-note@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      await store.recordJobCandidate(cand({ timestamp: 6.6, reason: "ball in net" }, job.id));
      const auth = { authorization: `Bearer ${u.token}` };

      // The client re-requests from (newest - 1) so a note persisted into the
      // tail bucket still shows up.
      const r = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=1`, headers: auth });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      const bucket2 = body.sections.find((s: any) => s.index === 2);
      expect(bucket2).toBeTruthy();
      expect(bucket2.decideNotes.map((n: any) => n.reason)).toEqual(["ball in net"]);

      // A note that landed in a bucket the client already holds is NOT re-sent
      // when the client asks past it — the composite fetch stays the recovery path.
      const past = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=2`, headers: auth });
      expect(past.json().sections.every((s: any) => s.index > 2)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("carries the postable highlights and the summary ladder", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "delta-companions@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      await store.addHighlight({
        id: "h1",
        jobId: job.id,
        clipUri: `/clips/h1.mp4`,
        start: 6,
        end: 11,
        score: 88,
        status: "accepted",
        eventType: "GOAL",
        outcome: "scoring_play",
        createdAt: new Date().toISOString(),
      } as any);
      const auth = { authorization: `Bearer ${u.token}` };

      const r = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=2`, headers: auth });
      expect(r.statusCode).toBe(200);
      const body = r.json();
      expect(Array.isArray(body.highlights)).toBe(true);
      expect(body.highlights.map((h: any) => h.id)).toEqual(["h1"]);
      expect(body.job.id).toBe(job.id);
      expect(body.maxTraces).toBe(3); // live capacity budget
      expect(body.summaryLadder).toBeTruthy();
    } finally {
      await app.close();
    }
  });

  it("403s a cross-owner request, exactly like /jobs/:id/detail", async () => {
    const { app, store } = await buildTestApp();
    try {
      const owner = await register(app, "delta-co-owner@test.local");
      const other = await register(app, "delta-co-other@test.local");
      const job = await store.createJob({ ownerId: owner.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);

      const asOwner = await app.inject({
        method: "GET",
        url: `/jobs/${job.id}/sections-delta?afterIndex=-1`,
        headers: { authorization: `Bearer ${owner.token}` },
      });
      expect(asOwner.statusCode).toBe(200);

      const asOther = await app.inject({
        method: "GET",
        url: `/jobs/${job.id}/sections-delta?afterIndex=-1`,
        headers: { authorization: `Bearer ${other.token}` },
      });
      expect(asOther.statusCode).toBe(403);
      expect(asOther.json()).toEqual({ error: "forbidden" });

      // Same for an anonymous caller: the route is auth-gated like the detail one.
      const anon = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=-1` });
      expect(anon.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("400s a malformed afterIndex and 404s an unknown job", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "delta-bad@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };

      for (const bad of ["abc", "-2", "1.5"]) {
        const r = await app.inject({ method: "GET", url: `/jobs/${job.id}/sections-delta?afterIndex=${bad}`, headers: auth });
        expect(r.statusCode).toBe(400);
      }

      const missing = await app.inject({
        method: "GET",
        url: `/jobs/does-not-exist/sections-delta?afterIndex=-1`,
        headers: auth,
      });
      expect(missing.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
