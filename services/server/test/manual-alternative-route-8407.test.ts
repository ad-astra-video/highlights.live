// ADAAAA-8407 route contract: the manual attach/detach path, end to end on the
// wire. Grades AC1 (attach -> alternatives[] + pick persists), AC2 (no second
// highlight row, counts unchanged, lane restored on detach), AC3 (provenance in
// the stored row) and AC5 (scope 401/403 + an activity row per write) at $0.
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { buildTestApp } from "./helpers";

const JOB = "job-8407-manual";
const OTHER_JOB = "job-8407-other";

const GOAL = HighlightRecordSchema.parse({
  id: "hl-goal",
  jobId: JOB,
  clipUri: "/clips/goal.mp4",
  start: 152,
  end: 167,
  localizedTs: 159,
  eventType: "GOAL",
  score: 95,
  outcome: "scoring_play",
  status: "accepted",
  createdAt: "2026-11-07T00:00:00.000Z",
});
const REPLAY = HighlightRecordSchema.parse({
  id: "hl-replay",
  jobId: JOB,
  clipUri: "/clips/replay.mp4",
  start: 200,
  end: 215,
  localizedTs: 207,
  eventType: "BIG_PLAY",
  score: 60,
  outcome: "big_play",
  status: "pending",
  createdAt: "2026-11-07T00:00:00.000Z",
});
const REJECTED = HighlightRecordSchema.parse({
  id: "hl-rejected",
  jobId: JOB,
  clipUri: "/clips/rejected.mp4",
  start: 400,
  end: 415,
  localizedTs: 407,
  eventType: "BIG_PLAY",
  score: 50,
  outcome: "big_play",
  status: "rejected",
  createdAt: "2026-11-07T00:00:00.000Z",
});
const FOREIGN = HighlightRecordSchema.parse({
  id: "hl-foreign",
  jobId: OTHER_JOB,
  clipUri: "/clips/foreign.mp4",
  start: 100,
  end: 115,
  localizedTs: 107,
  eventType: "GOAL",
  score: 90,
  outcome: "scoring_play",
  status: "accepted",
  createdAt: "2026-11-07T00:00:00.000Z",
});

async function seed(app: any, ownerId?: string) {
  await app.store.createJob({ id: JOB, ownerId, source: "file" });
  await app.store.createJob({ id: OTHER_JOB, ownerId, source: "file" });
  for (const h of [GOAL, REPLAY, REJECTED, FOREIGN]) {
    await app.store.addHighlight({ ...h, ...(ownerId ? { ownerId } : {}) } as HighlightRecord);
  }
}

async function adminHeaders(app: any) {
  const login = await app.app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "admin@test.local", password: "adminpass" },
  });
  expect(login.statusCode).toBe(200);
  return { authorization: `Bearer ${login.json().token}` };
}

async function user(app: any, email: string) {
  const reg = await app.app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  return {
    id: (reg.json().user?.id ?? reg.json().user?.userId) as string,
    headers: { authorization: `Bearer ${reg.json().token}` },
  };
}

describe("ADAAAA-8407 manual alternative — attach / pick / detach", () => {
  it("attaches a same-job window, serves it as the pick, and detaches back to the pre-attach row", async () => {
    const app = await buildTestApp();
    await seed(app);
    const headers = await adminHeaders(app);

    // AC1: the candidates are the job's decided, un-attached, un-rejected windows.
    const list = await app.app.inject({
      method: "GET",
      url: `/highlights/${GOAL.id}/attach-candidates`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().candidates.map((c: any) => c.id)).toEqual([REPLAY.id]);

    // AC2 baseline: the notable lane carries the 207 s window as its own row.
    const before = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/detail`, headers });
    const beforeBody = before.json();
    expect(beforeBody.job.rawHighlights).toBe(3);
    expect(beforeBody.job.postableHighlights).toBe(1);
    expect(beforeBody.notableHighlights.map((h: any) => h.id)).toContain(REPLAY.id);

    // AC1/AC3: the attach.
    const attach = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/alternatives/attach`,
      headers,
      payload: { windowId: REPLAY.id },
    });
    expect(attach.statusCode).toBe(200);
    const attached = attach.json();
    expect(attached.ok).toBe(true);
    expect(attached.window.replayOf).toBe(GOAL.id);
    expect(attached.window.replayEvidence).toMatchObject({
      kind: "manual",
      matches: 0,
      compared: 0,
      gapS: 48,
    });
    expect(attached.window.replayEvidence.attachedBy).toBeTruthy();
    expect(attached.window.replayEvidence.attachedAt).toBeTruthy();
    // The moment row itself is untouched: same window, score, status, clip.
    expect(attached.highlight).toMatchObject({ id: GOAL.id, start: 152, end: 167, score: 95, status: "accepted" });

    // AC1/AC2: the moment's detail serves it in alternatives[] under replayOf,
    // the attached row leaves both highlight lanes, and no count moves.
    const after = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/detail`, headers });
    const afterBody = after.json();
    const goalCard = afterBody.highlights.find((h: any) => h.id === GOAL.id);
    expect(goalCard.alternatives.map((a: any) => a.id)).toContain(REPLAY.id);
    const alt = goalCard.alternatives.find((a: any) => a.id === REPLAY.id);
    expect(alt.replayOf).toBe(GOAL.id);
    expect(alt.replayEvidence.kind).toBe("manual");
    expect(afterBody.highlights.map((h: any) => h.id)).not.toContain(REPLAY.id);
    expect(afterBody.notableHighlights.map((h: any) => h.id)).not.toContain(REPLAY.id);
    expect(afterBody.job.rawHighlights).toBe(beforeBody.job.rawHighlights);
    expect(afterBody.job.postableHighlights).toBe(beforeBody.job.postableHighlights);

    // AC1: the existing clip-choice path picks the manual alternative.
    const pick = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/clip-choice`,
      headers,
      payload: { alternativeId: REPLAY.id },
    });
    expect(pick.statusCode).toBe(200);
    expect(pick.json().clipUri).toBe("/clips/replay.mp4");
    expect(pick.json().clipChoice.alternativeId).toBe(REPLAY.id);

    // AC2/AC3: detach clears the attach AND the pick (original clip restored).
    const detach = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/alternatives/detach`,
      headers,
      payload: { windowId: REPLAY.id },
    });
    expect(detach.statusCode).toBe(200);
    expect(detach.json().window.replayOf).toBeUndefined();
    expect(detach.json().window.replayEvidence).toBeUndefined();
    expect(detach.json().clearedClipChoice).toBe(true);
    expect(detach.json().highlight.clipChoice).toBeUndefined();

    const restored = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/detail`, headers });
    const restoredBody = restored.json();
    expect(restoredBody.notableHighlights.map((h: any) => h.id)).toContain(REPLAY.id);
    expect(restoredBody.highlights.find((h: any) => h.id === GOAL.id).alternatives).toBeUndefined();
    expect(restoredBody.job.rawHighlights).toBe(beforeBody.job.rawHighlights);
    expect(restoredBody.job.postableHighlights).toBe(beforeBody.job.postableHighlights);

    // AC5: both writes are durable activity rows on the job.
    const lifecycle = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/lifecycle`, headers });
    expect(lifecycle.statusCode).toBe(200);
    const kinds = lifecycle.json().events.map((e: any) => e.kind);
    expect(kinds).toContain("alternative_attached");
    expect(kinds).toContain("alternative_detached");
    const attachedRow = lifecycle.json().events.find((e: any) => e.kind === "alternative_attached");
    expect(JSON.parse(attachedRow.detail)).toMatchObject({ kind: "manual", momentId: GOAL.id, windowId: REPLAY.id });

    await app.app.close();
  });

  it("refuses a second attach of the same window (409) and a non-manual detach (422)", async () => {
    const app = await buildTestApp();
    await seed(app);
    const headers = await adminHeaders(app);
    const attach = () =>
      app.app.inject({
        method: "POST",
        url: `/highlights/${GOAL.id}/alternatives/attach`,
        headers,
        payload: { windowId: REPLAY.id },
      });
    expect((await attach()).statusCode).toBe(200);
    const again = await attach();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("window_already_attached");

    // An auto (detector) attach is not the operator's to undo.
    await app.store.markReplay(REPLAY.id, {
      replayOf: GOAL.id,
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    const detach = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/alternatives/detach`,
      headers,
      payload: { windowId: REPLAY.id },
    });
    expect(detach.statusCode).toBe(422);
    expect(detach.json().error).toBe("not_a_manual_attach");
    // The detector attach is still intact.
    expect(app.store.getHighlight(REPLAY.id)?.replayEvidence?.kind).toBe("footage_match");

    await app.app.close();
  });

  it("is company/owner scoped: 401 anonymous, 403 another owner's job", async () => {
    const app = await buildTestApp();
    const owner = await user(app, "owner-8407@example.com");
    await seed(app, owner.id);
    const stranger = await user(app, "stranger-8407@example.com");

    const anon = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/alternatives/attach`,
      payload: { windowId: REPLAY.id },
    });
    expect(anon.statusCode).toBe(401);

    for (const req of [
      { method: "GET" as const, url: `/highlights/${GOAL.id}/attach-candidates` },
      { method: "POST" as const, url: `/highlights/${GOAL.id}/alternatives/attach`, payload: { windowId: REPLAY.id } },
      { method: "POST" as const, url: `/highlights/${GOAL.id}/alternatives/detach`, payload: { windowId: REPLAY.id } },
    ]) {
      const res = await app.app.inject({ ...req, headers: stranger.headers });
      expect(res.statusCode).toBe(403);
    }
    // Nothing was written by the refused calls.
    expect(app.store.getHighlight(REPLAY.id)?.replayOf).toBeUndefined();

    // The owner may attach their own job's window.
    const own = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL.id}/alternatives/attach`,
      headers: owner.headers,
      payload: { windowId: REPLAY.id },
    });
    expect(own.statusCode).toBe(200);
    expect(own.json().window.replayEvidence.attachedBy).toBe(owner.id);

    await app.app.close();
  });
});
