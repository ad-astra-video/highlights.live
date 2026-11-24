// ADAAAA-8407 AC6/AC4 — the NAMED CASE, replayed end to end at $0.
//
// AC6 asks for the board's real pair, not a synthetic one: on the preserved
// `545be947-e989-4b26-a464-22b576d97373` record shape, the 207 s replay window
// must attach to the 152 s goal BY HAND, be picked, and be cleared, with the
// goal count unchanged (3).
//
// The record shape here is taken from the preserved evidence on the box, not
// invented:
//   * ADAAAA-8322 work product `9fc6a2ca` (frame-hash distances) — the three
//     46-frame windows of this job at 3 fps: goal 152.0-167.0 s, replay
//     200.0-215.0 s, live control 0.0-15.0 s.
//   * ADAAAA-8366 Inc 3 evidence — the job's goal rows are anchored at 159 s
//     (window 152-167 s) and 171.4 s (window 164.4-179.4 s), the replay at
//     207 s (window 200-215 s), the live control at 7.5 s.
// The job's THIRD goal window is not in either preserved artifact, so it is a
// shape stand-in: AC6's invariant is the COUNT (3), and the two windows the
// artifacts do fix are the two that matter to the attach (owner + candidate).
//
// AC4 is measured here rather than assumed: each of the three operator writes
// is timed on the real route, and the run proves no perceive/decide reserve,
// no new clip cut, no new frame and no cost delta.
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { HighlightRecordSchema, type HighlightRecord } from "@highlights/events";
import { buildTestApp } from "./helpers";

const JOB = "545be947-e989-4b26-a464-22b576d97373";

function record(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    ownerId: "user-8407",
    jobId: JOB,
    clipUri: "/clips/x.mp4",
    start: 0,
    end: 15,
    localizedTs: 7.5,
    localizeSignal: "peak_frame",
    eventType: "BIG_PLAY",
    score: 70,
    outcome: "big_play",
    status: "accepted",
    createdAt: "2026-11-07T00:00:00.000Z",
    ...over,
  });
}

/** The named owner: the 152 s goal (preserved window 152-167 s, anchor 159 s). */
const GOAL_152 = record({
  id: "hl-545-goal-152",
  clipUri: "/clips/hl-545-goal-152.mp4",
  start: 152,
  end: 167,
  localizedTs: 159,
  eventType: "GOAL",
  score: 95,
  outcome: "scoring_play",
});
/** The job's second goal (preserved window 164.4-179.4 s, anchor 171.4 s). */
const GOAL_164 = record({
  id: "hl-545-goal-164",
  clipUri: "/clips/hl-545-goal-164.mp4",
  start: 164.4,
  end: 179.4,
  localizedTs: 171.4,
  eventType: "GOAL",
  score: 92,
  outcome: "scoring_play",
});
/** A non-overlapping stand-in goal. AC6's count is the invariant, and the
 * preserved pair (152-167 s / 164.4-179.4 s) overlaps by 2.6 s so the read side
 * merges it into one card (ADAAAA-7621 dedupe); the job's OTHER goal rows are
 * not in the preserved artifacts, so two shape stand-ins hold the served ladder
 * at AC6's three goals. */
const GOAL_640 = record({
  id: "hl-545-goal-640",
  clipUri: "/clips/hl-545-goal-640.mp4",
  start: 640,
  end: 655,
  localizedTs: 647,
  eventType: "GOAL",
  score: 90,
  outcome: "scoring_play",
});
/** Second count stand-in (same reason as GOAL_640). */
const GOAL_1000 = record({
  id: "hl-545-goal-1000",
  clipUri: "/clips/hl-545-goal-1000.mp4",
  start: 1000,
  end: 1015,
  localizedTs: 1007,
  eventType: "GOAL",
  score: 88,
  outcome: "scoring_play",
});
/** The cross-camera replay the board asked about (preserved window 200-215 s). */
const REPLAY_207 = record({
  id: "hl-545-replay-207",
  clipUri: "/clips/hl-545-replay-207.mp4",
  start: 200,
  end: 215,
  localizedTs: 207,
  score: 60,
});

async function seed(app: any) {
  await app.store.createJob({ id: JOB, source: "file" });
  for (const h of [GOAL_152, GOAL_164, GOAL_640, GOAL_1000, REPLAY_207]) {
    await app.store.addHighlight(h);
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

/** Everything AC4 says must NOT move: cut clips on disk, extracted frames, cost. */
function zeroCostSnapshot(app: any) {
  const clipsDir = path.join(app.cfg.dataDir, "clips");
  const framesDir = path.join(app.cfg.dataDir, "frames", JOB);
  return {
    clips: existsSync(clipsDir) ? readdirSync(clipsDir).sort() : [],
    frames: existsSync(framesDir) ? readdirSync(framesDir).sort() : [],
  };
}

async function detail(app: any, headers: any) {
  const res = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/detail`, headers });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe("ADAAAA-8407 AC6 — named case 545be947 replayed at $0", () => {
  it("attaches the preserved 207 s replay window to the 152 s goal, picks it, clears it; goal count stays 3", async () => {
    const app = await buildTestApp();
    await seed(app);
    const headers = await adminHeaders(app);
    const preAttachRow = app.store.getHighlight(REPLAY_207.id)!;
    const costBefore = zeroCostSnapshot(app);

    // ---- baseline: the job's served shape before any operator write ---------
    const before = await detail(app, headers);
    const goalsBefore = before.summaryLadder.matchSummary.goalCount;
    expect(goalsBefore).toBe(3);
    expect(before.replaysAttached).toBe(0);
    // The goal is a card; the replay window is its own notable row pre-attach.
    expect(before.highlights.map((h: any) => h.id)).toContain(GOAL_152.id);
    expect(before.notableHighlights.map((h: any) => h.id)).toContain(REPLAY_207.id);
    const rawBefore = before.job.rawHighlights;
    const postableBefore = before.job.postableHighlights;
    const jobCostBefore = before.job.costUsd;

    // ---- AC1: the picker offers the job's other decided windows -------------
    const list = await app.app.inject({
      method: "GET",
      url: `/highlights/${GOAL_152.id}/attach-candidates`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    const candidateIds = list.json().candidates.map((c: any) => c.id);
    expect(candidateIds).toContain(REPLAY_207.id);
    expect(candidateIds).not.toContain(GOAL_152.id);
    const replayCandidate = list.json().candidates.find((c: any) => c.id === REPLAY_207.id);
    expect(replayCandidate).toMatchObject({ start: 200, end: 215, anchorTs: 207 });

    // ---- AC1/AC3: the attach (timed, AC4) ----------------------------------
    const tAttach = performance.now();
    const attach = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/alternatives/attach`,
      headers,
      payload: { windowId: REPLAY_207.id },
    });
    const attachMs = performance.now() - tAttach;
    expect(attach.statusCode).toBe(200);
    const attached = attach.json();
    expect(attached.window.replayOf).toBe(GOAL_152.id);
    expect(attached.window.replayEvidence).toMatchObject({
      kind: "manual",
      matches: 0,
      compared: 0,
      gapS: 48,
    });
    expect(attached.window.replayEvidence.attachedBy).toBeTruthy();
    expect(typeof attached.window.replayEvidence.attachedAt).toBe("string");
    // The moment row the operator pointed at is untouched.
    expect(attached.highlight).toMatchObject({
      id: GOAL_152.id,
      start: 152,
      end: 167,
      score: 95,
      status: "accepted",
    });

    // ---- AC1/AC2: the served detail, then a RELOAD of it -------------------
    const afterAttach = await detail(app, headers);
    const goalCard = afterAttach.highlights.find((h: any) => h.id === GOAL_152.id);
    const alt = goalCard.alternatives.find((a: any) => a.id === REPLAY_207.id);
    expect(alt.replayOf).toBe(GOAL_152.id);
    expect(alt.replayEvidence.kind).toBe("manual");
    // AC2: a row acting as an alternative is not a highlight/notable row.
    expect(afterAttach.highlights.map((h: any) => h.id)).not.toContain(REPLAY_207.id);
    expect(afterAttach.notableHighlights.map((h: any) => h.id)).not.toContain(REPLAY_207.id);
    // AC2: counts and the goal ladder do not move.
    expect(afterAttach.summaryLadder.matchSummary.goalCount).toBe(3);
    expect(afterAttach.summaryLadder.matchSummary.text).toBe(before.summaryLadder.matchSummary.text);
    expect(afterAttach.job.rawHighlights).toBe(rawBefore);
    expect(afterAttach.job.postableHighlights).toBe(postableBefore);
    expect(afterAttach.replaysAttached).toBe(1);
    expect(afterAttach.job.costUsd).toBe(jobCostBefore);

    // ---- AC1: the pick (timed, AC4) uses the existing clip-choice path ------
    const tPick = performance.now();
    const pick = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/clip-choice`,
      headers,
      payload: { alternativeId: REPLAY_207.id },
    });
    const pickMs = performance.now() - tPick;
    expect(pick.statusCode).toBe(200);
    expect(pick.json().clipUri).toBe(REPLAY_207.clipUri);
    // The choice persists across a reload (a fresh detail read).
    const afterPick = await detail(app, headers);
    const pickedCard = afterPick.highlights.find((h: any) => h.id === GOAL_152.id);
    expect(pickedCard.clipChoice).toMatchObject({ alternativeId: REPLAY_207.id, clipUri: REPLAY_207.clipUri });
    expect(afterPick.summaryLadder.matchSummary.goalCount).toBe(3);

    // ---- AC1/AC2: clearing the pick restores the original clip --------------
    const clear = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/clip-choice`,
      headers,
      payload: {},
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().clipChoice).toBeNull();
    expect(clear.json().clipUri).toBe(GOAL_152.clipUri);

    // ---- AC2/AC3: the detach (timed, AC4) restores the pre-attach row -------
    const tDetach = performance.now();
    const detach = await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/alternatives/detach`,
      headers,
      payload: { windowId: REPLAY_207.id },
    });
    const detachMs = performance.now() - tDetach;
    expect(detach.statusCode).toBe(200);
    // Byte-identical to the row as it stood before the attach.
    expect(app.store.getHighlight(REPLAY_207.id)).toEqual(preAttachRow);

    const restored = await detail(app, headers);
    expect(restored.notableHighlights.map((h: any) => h.id)).toContain(REPLAY_207.id);
    expect(restored.highlights.find((h: any) => h.id === GOAL_152.id).alternatives).toBeUndefined();
    expect(restored.summaryLadder.matchSummary.goalCount).toBe(3);
    expect(restored.job.rawHighlights).toBe(rawBefore);
    expect(restored.job.postableHighlights).toBe(postableBefore);
    expect(restored.replaysAttached).toBe(0);

    // ---- AC5: both writes are durable job activity rows --------------------
    const lifecycle = await app.app.inject({ method: "GET", url: `/jobs/${JOB}/lifecycle`, headers });
    const events = lifecycle.json().events.filter((e: any) =>
      ["alternative_attached", "alternative_detached"].includes(e.kind)
    );
    expect(events.map((e: any) => e.kind).sort()).toEqual(["alternative_attached", "alternative_detached"]);
    for (const e of events) {
      expect(JSON.parse(e.detail)).toMatchObject({ kind: "manual", momentId: GOAL_152.id, windowId: REPLAY_207.id });
    }

    // ---- AC4: $0 — no perceive reserve, no new cut, no new frame, no cost --
    const costAfter = zeroCostSnapshot(app);
    expect(costAfter.clips).toEqual(costBefore.clips);
    expect(costAfter.frames).toEqual(costBefore.frames);
    expect(app.store.getHighlight(REPLAY_207.id)?.clipUri).toBe(REPLAY_207.clipUri);

    // AC4 bar: < 5 s per pick, measured (not assumed).
    console.log(
      `[AC4 545be947] attach ${attachMs.toFixed(1)} ms · pick ${pickMs.toFixed(1)} ms · detach ${detachMs.toFixed(1)} ms`
    );
    for (const ms of [attachMs, pickMs, detachMs]) expect(ms).toBeLessThan(5000);

    await app.app.close();
  });

  it("AC4: the writes touch no pipeline adapter at all (no perceive, no decide, no leg)", async () => {
    const adapter = (await import("./helpers")).fakePipeline();
    const app = await buildTestApp({}, { adapter });
    await seed(app);
    const headers = await adminHeaders(app);
    const callsBefore = JSON.stringify({
      reserve: adapter.reserveCount,
      stop: adapter.stopCount,
    });

    await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/alternatives/attach`,
      headers,
      payload: { windowId: REPLAY_207.id },
    });
    await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/clip-choice`,
      headers,
      payload: { alternativeId: REPLAY_207.id },
    });
    await app.app.inject({
      method: "POST",
      url: `/highlights/${GOAL_152.id}/alternatives/detach`,
      headers,
      payload: { windowId: REPLAY_207.id },
    });

    expect(JSON.stringify({ reserve: adapter.reserveCount, stop: adapter.stopCount })).toBe(callsBefore);
    expect(adapter.reserveCount).toBe(0);
    await app.app.close();
  });

  it("AC4: five attach/pick/clear/detach cycles stay far inside the 5 s bar (p50 + max)", async () => {
    const app = await buildTestApp();
    await seed(app);
    const headers = await adminHeaders(app);
    const op = async (url: string, payload: any) => {
      const t = performance.now();
      const res = await app.app.inject({ method: "POST", url, headers, payload });
      expect(res.statusCode).toBe(200);
      return performance.now() - t;
    };
    const attach: number[] = [];
    const pick: number[] = [];
    const detach: number[] = [];
    for (let i = 0; i < 5; i++) {
      attach.push(await op(`/highlights/${GOAL_152.id}/alternatives/attach`, { windowId: REPLAY_207.id }));
      pick.push(await op(`/highlights/${GOAL_152.id}/clip-choice`, { alternativeId: REPLAY_207.id }));
      await op(`/highlights/${GOAL_152.id}/clip-choice`, {});
      detach.push(await op(`/highlights/${GOAL_152.id}/alternatives/detach`, { windowId: REPLAY_207.id }));
    }
    const stat = (xs: number[]) => {
      const sorted = [...xs].sort((a, b) => a - b);
      return { p50: sorted[Math.floor(sorted.length / 2)], max: sorted[sorted.length - 1] };
    };
    const a = stat(attach);
    const p = stat(pick);
    const d = stat(detach);
    console.log(
      `[AC4 545be947 ×5] attach p50 ${a.p50.toFixed(1)} / max ${a.max.toFixed(1)} ms · ` +
        `pick p50 ${p.p50.toFixed(1)} / max ${p.max.toFixed(1)} ms · ` +
        `detach p50 ${d.p50.toFixed(1)} / max ${d.max.toFixed(1)} ms`
    );
    for (const ms of [a.max, p.max, d.max]) expect(ms).toBeLessThan(5000);
    // The job's stored shape is back to its pre-attach form after every cycle.
    expect(app.store.getHighlight(REPLAY_207.id)?.replayOf).toBeUndefined();
    expect(app.store.getHighlight(GOAL_152.id)?.clipChoice).toBeUndefined();
    await app.app.close();
  });
});
