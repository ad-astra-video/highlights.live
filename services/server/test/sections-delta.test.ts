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

// ADAAAA-8854 (parent ADAAAA-8850): the sections-delta response REPLACES the open
// page's arrays wholesale (`JobDetail.mergeDelta`: `highlights`, `notableHighlights`
// and `duplicateHighlights`), so every row it ships must be the SAME served row
// the composite `/jobs/:id/detail` ships for that id. The delta used to rebuild
// the lists with `exportUri` alone, so:
//   - a stored row whose lane is `measured` / `dive` lost its `confirmation`
//     block on the first incremental refresh and its card fell back to
//     UNCONFIRMED (the reported symptom);
//   - `postTitle` / `caption` degraded to the raw stored row.
// The parity assertions below are per row id, so they also catch any FUTURE field
// added to only one of the two surfaces.
describe("GET /jobs/:id/sections-delta serves the composite row shape (ADAAAA-8854)", () => {
  /** One stored job holding a row in every lane a card badge can read. */
  async function seedLaneJob(app: any, store: any, email: string) {
    const u = await register(app, email);
    const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
    await seed(store, job.id);

    // lane 1 (`measured`): the accept gate read this window's own trigger signal.
    await store.recordJobCandidate(
      cand(
        {
          timestamp: 1,
          trigger: { kind: "goal_line", timestamp: 1, eventType: "GOAL", goalCrossed: true },
        },
        job.id
      )
    );
    await store.addHighlight({
      id: "h-measured",
      jobId: job.id,
      candidateId: "c-1",
      clipUri: "/clips/h-measured.mp4",
      start: 0,
      end: 5,
      score: 92,
      status: "accepted",
      eventType: "GOAL",
      outcome: "scoring_play",
      createdAt: new Date().toISOString(),
    } as any);

    // lane 2 (`dive`): the async Stage-2 lane writes its verdict onto the ROW.
    await store.recordJobCandidate(cand({ timestamp: 4 }, job.id));
    await store.addHighlight({
      id: "h-dive",
      jobId: job.id,
      candidateId: "c-4",
      confirmAttestation: {
        goalConfirmed: "confirmed_goal",
        corroborated: true,
        corroborationSource: "frame_attestation",
        diveAt: "2026-11-11T00:00:09.000Z",
        diveLatencyMs: 9000,
        contextDegraded: [],
      },
      clipUri: "/clips/h-dive.mp4",
      start: 20,
      end: 25,
      score: 90,
      status: "accepted",
      eventType: "GOAL",
      outcome: "scoring_play",
      createdAt: new Date().toISOString(),
    } as any);

    // A grouped celebration alternative on the dive card: the delta refreshes
    // the row wholesale too, so the card's clip rail must survive the merge.
    await store.addAlternative({
      id: "alt-h-dive",
      jobId: job.id,
      highlightId: "h-dive",
      relation: "alternative_of",
      eventType: "celebration",
      outcome: "big_play",
      windowAnchorTs: 27,
      distanceToGoalEndS: 2,
      score: 60,
      start: 26,
      end: 31,
      clipUri: "/clips/alt-h-dive.mp4",
      dedupeKey: "h-dive|27",
      createdAt: new Date().toISOString(),
    } as any);
    // notable lane: a near miss, still carded, still badge-bearing.
    await store.recordJobCandidate(
      cand(
        {
          timestamp: 7,
          eventType: "BIG_PLAY",
          outcome: "near_miss",
          trigger: { kind: "score_change", timestamp: 7, eventType: "BIG_PLAY", scoreBoardChanged: true },
        },
        job.id
      )
    );
    await store.addHighlight({
      id: "n-notable",
      jobId: job.id,
      candidateId: "c-7",
      clipUri: "/clips/n-notable.mp4",
      start: 40,
      end: 45,
      score: 70,
      status: "accepted",
      eventType: "BIG_PLAY",
      outcome: "near_miss",
      createdAt: new Date().toISOString(),
    } as any);

    // Two overlapping GOAL rows so the dedupe has a merged-away duplicate to
    // serve: the duplicate lane is merged into `prev` by the client too.
    for (const [id, start] of [
      ["h-ov-a", 60],
      ["h-ov-b", 61],
    ] as const) {
      await store.addHighlight({
        id,
        jobId: job.id,
        clipUri: `/clips/${id}.mp4`,
        start,
        end: start + 5,
        score: 80,
        status: "accepted",
        eventType: "GOAL",
        outcome: "scoring_play",
        createdAt: new Date().toISOString(),
      } as any);
    }
    return { u, job };
  }

  /** Per row id: the delta row must BE the composite row (byte-equal). */
  function assertRowParity(composite: any[], delta: any[], lane: string) {
    expect(delta.length, `${lane}: row count`).toBe(composite.length);
    const byId = new Map(delta.map((r: any) => [r.id, r]));
    for (const compositeRow of composite) {
      expect(byId.has(compositeRow.id), `${lane}: the delta serves row ${compositeRow.id}`).toBe(true);
      expect(byId.get(compositeRow.id), `${lane}: row ${compositeRow.id} is not degraded`).toEqual(compositeRow);
    }
  }

  it("AC1/AC2: every delta row equals the composite row (confirmation + copy)", async () => {
    const { app, store } = await buildTestApp();
    try {
      const { u, job } = await seedLaneJob(app, store, "delta-parity@test.local");
      const auth = { authorization: `Bearer ${u.token}` };

      const detail = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth });
      expect(detail.statusCode).toBe(200);
      const composite = detail.json();

      const deltaRes = await app.inject({
        method: "GET",
        url: `/jobs/${job.id}/sections-delta?afterIndex=-1`,
        headers: auth,
      });
      expect(deltaRes.statusCode).toBe(200);
      const delta = deltaRes.json();

      // AC1 / AC2: the two surfaces serve the SAME row for the same id.
      assertRowParity(composite.highlights ?? [], delta.highlights ?? [], "highlights");
      assertRowParity(composite.notableHighlights ?? [], delta.notableHighlights ?? [], "notableHighlights");
      assertRowParity(composite.duplicateHighlights ?? [], delta.duplicateHighlights ?? [], "duplicateHighlights");
      // Neither check is vacuous: all three lanes really carry rows.
      expect(delta.highlights.length).toBeGreaterThanOrEqual(2);
      expect(delta.notableHighlights.length).toBe(1);
      expect(delta.duplicateHighlights.length).toBe(1);

      // The badge itself, stated explicitly: lane 1 and lane 2 survive the delta.
      const measured = delta.highlights.find((h: any) => h.id === "h-measured");
      const compositeMeasured = composite.highlights.find((h: any) => h.id === "h-measured");
      expect(measured?.confirmation, "a `measured` row keeps a confirmation block on the delta").toBeDefined();
      expect(measured.confirmation.lane).toBe("measured");
      expect(measured.confirmation).toEqual(compositeMeasured.confirmation);

      const dive = delta.highlights.find((h: any) => h.id === "h-dive");
      expect(dive?.confirmation, "a `dive` row keeps a confirmation block on the delta").toBeDefined();
      expect(dive.confirmation.lane).toBe("dive");
      expect(dive.alternatives?.length, "the card's grouped clip rail survives the delta").toBe(1);

      const notable = delta.notableHighlights.find((h: any) => h.id === "n-notable");
      expect(notable?.confirmation, "the notable card states its lane too").toBeDefined();
      expect(notable.confirmation.lane).toBe("measured");

      // Secondary parity gap in the same pass: copy is served, never degraded.
      for (const row of [...delta.highlights, ...delta.notableHighlights]) {
        expect(typeof row.postTitle, `row ${row.id} carries a postTitle`).toBe("string");
        expect(row.postTitle.length).toBeGreaterThan(0);
        expect(typeof row.caption, `row ${row.id} carries a caption`).toBe("string");
        expect(row.exportUri, `row ${row.id} carries its export URL`).toBeTruthy();
      }
    } finally {
      await app.close();
    }
  });

  it("AC3: a promotion shows its NEW lane on the next delta refresh, with no full reload", async () => {
    const { app, store } = await buildTestApp();
    try {
      const u = await register(app, "delta-promotion@test.local");
      const job = await store.createJob({ ownerId: u.id, source: "file-sim", sourceUrl: "/data/x.mp4" } as any);
      await seed(store, job.id);
      const auth = { authorization: `Bearer ${u.token}` };
      const deltaUrl = `/jobs/${job.id}/sections-delta?afterIndex=-1`;

      // Two cards that are UNCONFIRMED at first: neither window has attestation
      // stored yet (one waits on its candidate row, one on the async dive). Their
      // windows do not overlap, so both stay postable cards (no dedupe).
      for (const [id, candidateId, start] of [
        ["h-deferred", "c-30", 0],
        ["h-adopted", "c-31", 10],
      ] as const) {
        await store.addHighlight({
          id,
          jobId: job.id,
          candidateId,
          clipUri: `/clips/${id}.mp4`,
          start,
          end: start + 5,
          score: 90,
          status: "accepted",
          eventType: "GOAL",
          outcome: "scoring_play",
          createdAt: new Date().toISOString(),
        } as any);
      }

      const first = await app.inject({ method: "GET", url: deltaUrl, headers: auth });
      expect(first.statusCode).toBe(200);
      const before = first.json();
      for (const id of ["h-deferred", "h-adopted"]) {
        const row = before.highlights.find((h: any) => h.id === id);
        expect(row, `row ${id} is served`).toBeTruthy();
        expect(row.confirmation?.lane, `row ${id} starts unconfirmed`).not.toBe("measured");
        expect(row.confirmation?.lane, `row ${id} starts unconfirmed`).not.toBe("dive");
      }

      // (a) deferred attestation: the window's candidate row lands AFTER the page
      // was already served. The delta re-derives from stored state, so the NEXT
      // refresh states lane 1 — no composite reload, nothing cached.
      await store.recordJobCandidate(
        cand(
          {
            id: "c-30",
            timestamp: 30,
            trigger: { kind: "goal_line", timestamp: 30, eventType: "GOAL", goalCrossed: true },
          },
          job.id
        )
      );
      // (b) dive adoption: the async Stage-2 lane writes its verdict onto the ROW
      // through the verdict-move writer (the same shape `confirmDiveAdoption`
      // returns). The next refresh states lane 2.
      await store.patchHighlight("h-adopted", {
        confirmAttestation: {
          goalConfirmed: "confirmed_goal",
          corroborated: true,
          corroborationSource: "frame_attestation",
          diveAt: "2026-11-11T00:00:10.000Z",
          diveLatencyMs: 10000,
          contextDegraded: [],
        },
      } as any);

      const second = await app.inject({ method: "GET", url: deltaUrl, headers: auth });
      expect(second.statusCode).toBe(200);
      const after = second.json();

      const deferred = after.highlights.find((h: any) => h.id === "h-deferred");
      expect(deferred.confirmation?.lane, "the deferred attestation is picked up by the delta").toBe("measured");
      expect(deferred.confirmation.label).toContain("goal line");

      const adopted = after.highlights.find((h: any) => h.id === "h-adopted");
      expect(adopted.confirmation?.lane, "the dive adoption is picked up by the delta").toBe("dive");
      expect(adopted.confirmation.label).toBe("Confirmed by deep dive (Stage-2)");

      // And the promoted rows still match the composite read exactly.
      const detail = await app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth });
      expect(detail.statusCode).toBe(200);
      assertRowParity(detail.json().highlights ?? [], after.highlights ?? [], "highlights");
    } finally {
      await app.close();
    }
  });
});
