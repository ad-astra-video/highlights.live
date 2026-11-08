// ADAAAA-8422 (N1) — the detail seam: ONE notable card per overlap chain, the
// cluster's other windows on its clip rail.
//
// Measured shape being fixed: live job b55c5781-7976-4777-905c-847a06f3d3a8 had
// 5 non-scoring windows and 0 accepted goals, so the notable lane shipped 5
// cards where the board expects 2 moments with 2 and 3 clip options. The
// projection is read-side only: every option is another STORED row's own
// already-cut clip, no row is mutated, and every counter is byte-equal.
import { describe, expect, it } from "vitest";
import { MAX_ALTERNATIVES_PER_HIGHLIGHT, HighlightRecordSchema } from "@highlights/events";
import { buildTestApp } from "./helpers";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

/** One persisted row. `start`-derived id/clip so a test can address a window. */
async function seed(
  t: any,
  jobId: string,
  start: number,
  over: Record<string, unknown> = {}
) {
  const id = `hl-${Math.round(start)}`;
  await t.store.addHighlight(
    HighlightRecordSchema.parse({
      id,
      jobId,
      clipUri: `/clips/${jobId}-${Math.round(start)}.mp4`,
      start,
      end: start + 15,
      eventType: "BIG_PLAY",
      score: 60,
      reason: "A player drives into the box and the keeper gathers the ball.",
      outcome: "big_play",
      status: "accepted",
      createdAt: "2026-11-08T14:20:09.000Z",
      ...over,
    })
  );
  return id;
}

describe("GET /jobs/:id/detail — notable moments (N1-AC1/AC2/AC3)", () => {
  it("renders one card per cluster and the siblings as that card's rail options", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "notable-moments-8422@test.local");
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);
      // The reported shape: windows 1-2 overlap (moment A), 3-4-5 overlap
      // (moment B), and the two groups do not touch.
      const ids = [] as string[];
      for (const start of [10, 18, 60, 68, 76]) ids.push(await seed(t, job.id, start));

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // AC1: 2 cards, not 5 — one per overlap chain, in time order.
      const moments = body.notableHighlights as any[];
      expect(moments.length).toBe(2);
      expect(moments.map((m) => m.siblingCount)).toEqual([2, 3]);
      expect(moments.map((m) => (m.siblingClips ?? []).length)).toEqual([1, 2]);
      expect(moments.map((m) => m.siblingClips ?? []).flat().length).toBe(3);
      // Every option is capped by the shipped rail contract.
      for (const m of moments) expect((m.siblingClips ?? []).length).toBeLessThanOrEqual(MAX_ALTERNATIVES_PER_HIGHLIGHT);

      // AC2: each option carries its OWN stored clip + its own export URL — no
      // re-encode, no new row, and the option is not pickable.
      const options = moments.flatMap((m) => m.siblingClips ?? []);
      expect(options.map((o: any) => o.clipUri)).toEqual([
        `/clips/${job.id}-18.mp4`,
        `/clips/${job.id}-68.mp4`,
        `/clips/${job.id}-76.mp4`,
      ]);
      for (const o of options) {
        expect(o.exportUri).toMatch(new RegExp(`^/clips/${job.id}-\\d+\\.mp4\\?x=`));
        expect(o.exportUri).not.toBe(o.clipUri);
        expect(o).not.toHaveProperty("alternativeId");
        expect(o).not.toHaveProperty("relation");
      }
      // The rail renders the moment's own clip first, then its siblings — so the
      // card's own export/download path is untouched.
      for (const m of moments) {
        expect(m.exportUri).toMatch(new RegExp(`^/clips/${job.id}-\\d+\\.mp4\\?x=`));
        expect(m.clipUri).toBe(`/clips/${job.id}-${Math.round(m.start)}.mp4`);
      }

      // AC3: no footage dropped — every persisted window is a moment's own clip
      // or one of its options.
      const delivered = moments.flatMap((m) => [m.id, ...(m.siblingClips ?? []).map((o: any) => o.id)]);
      expect(delivered.sort()).toEqual([...ids].sort());

      // AC3: every counter the payload carries is what the raw rows say — the
      // grouping is presentation only. 5 raw rows, 0 postable, nothing merged /
      // rejected / contradicting, no alternative clips, no replays.
      // (`highlightsFound` is the run's own stored monotonic counter, not a
      // projection of these rows, so a hand-seeded job legitimately reads 0
      // there; `notScoringHighlights` is not a JobSchema field — it is asserted
      // at the projection level in notable-moments-8422.test.ts, and here by the
      // notable lane's own membership below.)
      const j = body.job;
      expect(j.rawHighlights).toBe(5);
      expect(j.postableHighlights).toBe(0);
      expect(j.mergedHighlights).toBe(0);
      expect(body.replaysAttached ?? 0).toBe(0);
      expect(j.alternativeClipsDelivered ?? 0).toBe(0);
      expect(body.highlights).toEqual([]);
      expect(body.duplicateHighlights).toEqual([]);
      // The 5 not-scoring rows are ALL still delivered — as 2 moments' cards and
      // their options, never dropped and never double-counted.
      expect(moments.length + options.length).toBe(5);
    } finally {
      await t.app.close();
    }
  });

  it("a lone notable window keeps a single slide and no options (N1-AC2)", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "notable-moments-8422-b@test.local");
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);
      await seed(t, job.id, 10);
      // Touching windows are adjacent moments, not one moment.
      await seed(t, job.id, 25);

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const moments = res.json().notableHighlights as any[];
      expect(moments.length).toBe(2);
      expect(moments.every((m) => m.siblingCount === 1)).toBe(true);
      expect(moments.every((m) => !("siblingClips" in m) || (m.siblingClips ?? []).length === 0)).toBe(true);
    } finally {
      await t.app.close();
    }
  });

  it("a rejected row and an absorbed celebration are never options (N1-AC6)", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "notable-moments-8422-c@test.local");
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);
      // A confirmed GOAL plus a goal-shaped celebration over it: the ADAAAA-8199
      // absorb folds the celebration into the GOAL's duplicate lane.
      await seed(t, job.id, 10, {
        outcome: "scoring_play",
        eventType: "GOAL",
        score: 100,
        reason: "The ball clearly enters the net after a strike.",
      });
      await seed(t, job.id, 18, {
        eventType: "GOAL",
        provisionalGoal: { status: "provisional", cues: ["asr_goal_call"], declaredTs: 12, note: "ASR goal call in the window transcript" },
      });
      await seed(t, job.id, 60, { outcome: "near_miss", eventType: "NEAR_MISS" });
      await seed(t, job.id, 68, { outcome: "near_miss", eventType: "NEAR_MISS" });
      await seed(t, job.id, 76, { status: "rejected" });

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const body = res.json();
      const moments = body.notableHighlights as any[];
      const optionIds = moments.flatMap((m) => (m.siblingClips ?? []).map((o: any) => o.id));
      expect(optionIds).not.toContain(`hl-18`); // absorbed celebration
      expect(optionIds).not.toContain(`hl-76`); // rejected
      expect(optionIds).toEqual([`hl-68`]);
      expect(moments.map((m) => m.id)).toEqual([`hl-60`]);
      // The GOAL card and the duplicate lane are unchanged by this projection.
      expect((body.highlights as any[]).map((h) => h.id)).toEqual([`hl-10`]);
      expect((body.duplicateHighlights as any[]).map((h: any) => [h.id, h.duplicateOf])).toEqual([["hl-18", "hl-10"]]);
      // A rejected row is gone from every bucket (never an option, never a card).
      const everywhere = [...moments.map((m) => m.id), ...optionIds, ...body.duplicateHighlights.map((h: any) => h.id)];
      expect(everywhere).not.toContain(`hl-76`);
    } finally {
      await t.app.close();
    }
  });
});
