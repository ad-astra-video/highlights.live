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
    reason?: string;
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
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
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
    // ADAAAA-8910: the CLAIM is never stored; the row's own non-asserting label is
    // (`BIG PLAY` for a big_play window), so the card still has a title.
    expect(surface.postTitle).toBe("BIG PLAY");
    expect(surface.postTitleGate).toBe("label:goal-claim");
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

  // ADAAAA-8356 SUPERSEDES the 8318 expectation: a trailing place phrase and a
  // colour beat are DELETED (extractive) and the remainder must still pass every
  // evidence gate, so the card keeps model copy instead of falling back. A title
  // the deletion cannot repair is still refused.
  it("repairs a place chain and a colour beat by deletion", () => {
    for (const bad of [
      "Ordoñez strikes in the penalty area",
      "Ordoñez strikes — the bench rises",
      "Ordoñez strikes from close range",
    ]) {
      expect(storedSurfaceFor(decision({ postTitle: bad }), ctx("big_play")).postTitle).toBe("Ordoñez strikes");
    }
  });

  it("refuses a title the deletion cannot repair", () => {
    for (const bad of [
      "Ordoñez strikes the ball with the outside of his right boot towards the far corner",
      "Mbappé strikes in the penalty area",
    ]) {
      expect(storedSurfaceFor(decision({ postTitle: bad }), ctx("big_play")).postTitle).toBeUndefined();
    }
  });

  it("stores the row's own non-asserting label when the model produced no title", () => {
    // ADAAAA-8969 (increment 2, defect 4): an empty candidate used to store
    // nothing and record `absent`, while the read projection served
    // `BIG PLAY · m:ss` for the same row. The seam now stores the label the
    // projection serves, so the row and the card agree.
    for (const empty of [undefined, "   "]) {
      const surface = storedSurfaceFor(decision({ postTitle: empty }), ctx("big_play"));
      expect(surface.postTitle).toBe("BIG PLAY");
      expect(surface.postTitleGate).toBe("label:empty");
    }
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

  // ADAAAA-8405 S4: the detail route mirrors the write seam. A row written
  // BEFORE the caption fix stores its gated announcer sentence as `reason` and
  // no `caption`; serving the title there is the `copyTargetFor` degrade the PO
  // bar exists to catch (measured 6 of 10 postable stored cards).
  it("serves a legacy row's own gated sentence as the caption, never the title", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8405-served-caption@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "GOAL",
        outcome: "scoring_play",
        start: 140,
        localizedTs: 158,
        postTitle: "David Saez scores",
        reason: "Ball shoots on the left.",
      });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const row = (res.json().highlights as any[]).find((h) => h.id.startsWith("hl-"));
      // S3 refuses the invented name, so the card title falls back...
      expect(row.postTitle).toBe("GOAL · 2:38");
      // ...while the announcer detail is the row's own gated sentence.
      expect(row.caption).toBe("Ball shoots on the left.");
      expect(row.caption).not.toBe(row.postTitle);
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
