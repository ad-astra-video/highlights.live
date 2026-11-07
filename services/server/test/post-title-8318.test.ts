// ADAAAA-8318 (ADAAAA-8302 Option 2) — the post-title contract on the server.
//
// The clip card's COPY TARGET is `postTitle`, not the announcer line. Two seams
// are proved here:
//
//   WRITE  `storedSurfaceFor` gates the model's title (shape bar + the v9
//          grounding gate) and stores it beside the caption. A refusal stores
//          NOTHING — never a half-gated claim.
//   READ   `GET /jobs/:id/detail` serves a `postTitle` on EVERY clip row: the
//          stored value byte-for-byte while it satisfies the shape bar, else the
//          deterministic `LABEL · m:ss [· subject]` title built from stored facts
//          only (no model call, no invented name, never empty).
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers";
import { storedSurfaceFor, type DecisionResult } from "../src/analyzer.js";
import type { CaptionGroundingContext } from "@highlights/events";

const PROMPT = 'ocr="scoreboard 1-1" | Ordoñez is on the ball | Real Madrid counter';

function ctx(verdict: CaptionGroundingContext["verdict"], extra: Partial<CaptionGroundingContext> = {}) {
  return { verdict, promptText: PROMPT, place: "in the penalty area", ...extra } as CaptionGroundingContext;
}

function decision(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    isHighlight: true,
    score: 80,
    eventType: "BIG_PLAY",
    outcome: "big_play",
    reason: "Ordoñez strikes early.",
    ...over,
  };
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function seedRow(
  t: any,
  opts: {
    ownerId: string;
    eventType: string;
    outcome: "scoring_play" | "big_play" | "near_miss";
    start: number;
    localizedTs?: number;
    postTitle?: string;
    caption?: string;
    jobId?: string;
  }
) {
  const job = opts.jobId
    ? { id: opts.jobId }
    : await t.store.createJob({ ownerId: opts.ownerId, source: "browser", gameHint: "soccer" } as any);
  await t.store.addHighlight({
    id: `hl-${opts.start}-${opts.eventType}`,
    ownerId: opts.ownerId,
    jobId: job.id,
    clipUri: `/clips/hl-${opts.start}.mp4`,
    start: opts.start,
    end: opts.start + 15,
    ...(opts.localizedTs !== undefined ? { localizedTs: opts.localizedTs } : {}),
    eventType: opts.eventType,
    outcome: opts.outcome,
    score: 80,
    status: "accepted",
    ...(opts.postTitle !== undefined ? { postTitle: opts.postTitle } : {}),
    ...(opts.caption !== undefined ? { caption: opts.caption } : {}),
    createdAt: new Date().toISOString(),
  } as any);
  return job;
}

describe("write seam — storedSurfaceFor gates the post title", () => {
  it("stores a grounded, shape-clean title beside the caption", () => {
    const surface = storedSurfaceFor(decision({ postTitle: "Ordoñez strikes early" }), ctx("big_play"));
    expect(surface.postTitle).toBe("Ordoñez strikes early");
  });

  it("charges no goal claim to a non-scoring window", () => {
    const surface = storedSurfaceFor(decision({ postTitle: "Ordoñez scores the opener" }), ctx("big_play"));
    expect(surface.postTitle).toBeUndefined();
  });

  it("keeps a goal claim on a confirmed goal", () => {
    const surface = storedSurfaceFor(
      decision({
        eventType: "GOAL",
        outcome: "scoring_play",
        reason: "Ordoñez scores the opener.",
        postTitle: "Ordoñez scores the opener",
      }),
      ctx("scoring_play", { corroborated: true })
    );
    expect(surface.postTitle).toBe("Ordoñez scores the opener");
  });

  it("refuses a place chain, a colour beat and an over-long title", () => {
    for (const bad of [
      "Ordoñez strikes in the penalty area",
      "Ordoñez strikes — the bench rises",
      "Ordoñez strikes from close range after a long ball into the channel",
    ]) {
      expect(storedSurfaceFor(decision({ postTitle: bad }), ctx("big_play")).postTitle).toBeUndefined();
    }
  });

  it("stores nothing when the model produced no title (legacy / VOD rail)", () => {
    expect(storedSurfaceFor(decision(), ctx("big_play")).postTitle).toBeUndefined();
    expect(storedSurfaceFor(decision({ postTitle: "   " }), ctx("big_play")).postTitle).toBeUndefined();
  });
});

describe("GET /jobs/:id/detail — every card carries a copy target (AC5)", () => {
  it("serves a stored title byte-for-byte and derives one for a legacy row", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8318@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "GOAL",
        outcome: "scoring_play",
        start: 60,
        localizedTs: 72,
        postTitle: "Ordoñez strikes early",
        caption: "Ordoñez strikes early — the bench rises.",
      });
      await seedRow(t, {
        ownerId: u.id,
        jobId: job.id,
        eventType: "GOAL",
        outcome: "scoring_play",
        start: 4,
        localizedTs: 261,
      });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const rows = body.highlights as any[];
      const stored = rows.find((h) => h.postTitle === "Ordoñez strikes early");
      expect(stored).toBeTruthy();
      // the announcer caption is UNCHANGED beside it
      expect(stored.caption).toBe("Ordoñez strikes early — the bench rises.");
      // the second row (no stored title) derives one deterministically
      const derived = rows.find((h) => h.id !== stored.id);
      expect(derived.postTitle).toBe("GOAL · 4:21");
    } finally {
      await t.app.close();
    }
  });

  it("falls back deterministically for a stored title that breaks the shape bar", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8318-b@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "BIG_PLAY",
        outcome: "big_play",
        start: 100,
        localizedTs: 109,
        postTitle: "The winger breaks on the right",
      });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const notable = (res.json().notableHighlights as any[]).find((h) => h.id.startsWith("hl-"));
      expect(notable.postTitle).toBe("BIG PLAY · 1:49");
    } finally {
      await t.app.close();
    }
  });

  it("appends a team only when the row's own copy names one from matchContext", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8318-c@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "GOAL",
        outcome: "scoring_play",
        start: 60,
        localizedTs: 72,
        caption: "Real Madrid double their lead.",
      });
      await t.store.patchJob(job.id, {
        matchContext: {
          sport: "soccer",
          teams: [
            { name: "Real Madrid", side: "home", kitColors: [], confidence: 0.9, evidence: [] },
            { name: "Barcelona", side: "away", kitColors: [], confidence: 0.9, evidence: [] },
          ],
          inferredAt: new Date().toISOString(),
          resolverVersion: 1,
          ambiguous: false,
          trail: [],
        },
      } as any);
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const row = (res.json().highlights as any[]).find((h) => h.id.startsWith("hl-"));
      expect(row.postTitle).toBe("GOAL · 1:12 · Real Madrid");
      expect(row.postTitle.length).toBeLessThanOrEqual(40);
    } finally {
      await t.app.close();
    }
  });

  it("serves a non-empty title on 100% of rows of a legacy job (never empty / never T+)", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8318-d@test.local");
      const job = await seedRow(t, { ownerId: u.id, eventType: "GOAL", outcome: "scoring_play", start: 10 });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const rows = [...(res.json().highlights as any[]), ...(res.json().notableHighlights as any[])];
      expect(rows.length).toBeGreaterThan(0);
      for (const h of rows) {
        expect(typeof h.postTitle).toBe("string");
        expect(h.postTitle.trim().length).toBeGreaterThan(0);
        expect(h.postTitle).not.toContain("T+");
      }
    } finally {
      await t.app.close();
    }
  });
});
