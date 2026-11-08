// ADAAAA-8328 (Defect 2 of the ADAAAA-8319 QA FAIL of ADAAAA-8318) — a missing
// or gate-refused `postTitle` must NEVER take the announcer line with it.
//
// Two independent surfaces ship on a clip row:
//
//   postTitle  the card's COPY TARGET (optional; gated at the write seam, and
//              derived deterministically at read time when absent/refused)
//   caption    the announcer play-by-play DETAIL (optional; refused when the
//              window never measured what the model's line claims)
//
// The QA hypothesis was that a refused `postTitle` refused the WHOLE surface set
// and stored nothing. Measured on job `55a0eb33`: 45/45 decide replies carried no
// `postTitle` at all (the fleet never got the contract — Defect 1), yet the rows
// that stored no `caption` did so because the copy gate refused an UNMEASURED
// score claim, not because of the title. The same class exists on pre-fix builds
// (~half the rows in the 30 h before the leg), so this file pins BOTH facts:
//
//   1. `storedSurfaceFor` keeps `reason` / `caption` / `cardTitles` byte-for-byte
//      whether `postTitle` is absent, refused, or accepted (write seam).
//   2. `GET /jobs/:id/detail` serves a non-empty announcer detail on EVERY card,
//      degrading to the same fact-only `LABEL · m:ss` derivation the copy target
//      uses when the row stored no accepted copy — and it never rewrites the
//      stored row (read-time only, legacy rows stay untouched).
import { describe, expect, it } from "vitest";
import { buildTestApp } from "./helpers";
import { storedSurfaceFor, type DecisionResult } from "../src/analyzer.js";
import type { CaptionGroundingContext } from "@highlights/events";

const PROMPT = 'ocr="scoreboard 1-1" | Ordoñez is on the ball | Real Madrid counter';

function ctx(verdict: CaptionGroundingContext["verdict"], extra: Partial<CaptionGroundingContext> = {}) {
  return { verdict, promptText: PROMPT, place: "in the penalty area", ...extra } as CaptionGroundingContext;
}

function goal(over: Partial<DecisionResult> = {}): DecisionResult {
  return {
    isHighlight: true,
    score: 80,
    eventType: "GOAL",
    outcome: "scoring_play",
    reason: "Ordoñez scores the opener.",
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

/** Seed one accepted row. `postTitle`/`caption` are omitted on purpose: that is
 *  the "stored by a build whose decide worker never emitted the field" shape. */
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

describe("write seam — a title refusal never touches the copy fields", () => {
  const grounded = ctx("scoring_play", { corroborated: true });

  it("stores the caption/cardTitles/reason when the model produced NO title", () => {
    const surface = storedSurfaceFor(goal(), grounded);
    expect(surface.reason).toBe("Ordoñez scores the opener.");
    expect(surface.caption).toBe("Ordoñez scores the opener.");
    expect(surface.cardTitles).toEqual(["Ordoñez scores the opener."]);
    // The title is the ONLY surface this row is missing.
    expect(surface.postTitle).toBeUndefined();
  });

  it("keeps the copy byte-for-byte when the title is REFUSED by the shape bar", () => {
    const noTitle = storedSurfaceFor(goal(), grounded);
    // ADAAAA-8356: fixtures that the extractive repair can clear (a trailing
    // place phrase, a second clause, a clock prefix) are now ACCEPTED, so the
    // refusal arm uses titles no deletion can save: over-long with no trailing
    // place, too many words, and an unsourced name.
    for (const bad of [
      "Ordoñez scores the opener with the outside of his right boot and the bench rises", // > 70 chars
      "Ordoñez scores the opener after a long ball from the right side of the pitch", // > 10 words
      "Mbappé scores the opener", // unsourced name
    ]) {
      const refused = storedSurfaceFor(goal({ postTitle: bad }), grounded);
      expect(refused.postTitle).toBeUndefined();
      expect(refused.reason).toBe(noTitle.reason);
      expect(refused.caption).toBe(noTitle.caption);
      expect(refused.cardTitles).toEqual(noTitle.cardTitles);
      expect(refused.reason_raw).toBe(noTitle.reason_raw);
    }
  });

  it("keeps the copy when the title is refused by the GOAL grounding gate", () => {
    // A goal claim on a window whose verdict is not scoring_play.
    const play = storedSurfaceFor(
      { isHighlight: true, score: 61, eventType: "BIG_PLAY", outcome: "big_play", reason: "Ordoñez strikes early.", postTitle: "Ordoñez scores the opener" },
      ctx("big_play")
    );
    expect(play.postTitle).toBeUndefined();
    expect(play.caption).toBeTruthy();
    expect(play.cardTitles?.length).toBeGreaterThan(0);
  });

  it("stores the title beside the copy when it IS accepted (control)", () => {
    const surface = storedSurfaceFor(goal({ postTitle: "Ordoñez scores the opener" }), grounded);
    expect(surface.postTitle).toBe("Ordoñez scores the opener");
    expect(surface.caption).toBe("Ordoñez scores the opener.");
  });
});

describe("GET /jobs/:id/detail — the announcer detail never disappears", () => {
  it("serves a stored caption byte-for-byte beside a derived title (no stored postTitle)", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8328-a@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "GOAL",
        outcome: "scoring_play",
        start: 60,
        localizedTs: 72,
        caption: "Ordoñez scores the opener.",
      });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const row = (res.json().highlights as any[]).find((h) => h.id.startsWith("hl-"));
      expect(row.caption).toBe("Ordoñez scores the opener.");
      expect(row.postTitle).toBe("GOAL · 1:12");
    } finally {
      await t.app.close();
    }
  });

  // RED before this ticket: the row stored only `reason_raw`, so the card had no
  // "What happened" line at all (measured on job 55a0eb33, rows e79125ec /
  // ec7b3808 — the write seam refused an unmeasured score claim).
  it("serves a non-empty announcer detail on a row that stored NO copy at all", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8328-b@test.local");
      const job = await seedRow(t, {
        ownerId: u.id,
        eventType: "BIG_PLAY",
        outcome: "big_play",
        start: 64,
        localizedTs: 72,
        // no caption / cardTitles / reason — the refusal class
      });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const body = res.json();
      const row = [...(body.highlights as any[]), ...(body.notableHighlights as any[])].find((h) => h.id.startsWith("hl-"));
      expect(row).toBeTruthy();
      expect(typeof row.caption).toBe("string");
      expect(row.caption.trim().length).toBeGreaterThan(0);
      // ADAAAA-8411: the announcer line never degrades to the headline. A row
      // with NO stored copy at all now serves its own FACT sentence (its stored
      // verdict + window instant) instead of the title, so the card's "What
      // happened" line is never byte-identical to its headline.
      expect(row.caption).toBe("Big play at 1:12.");
      expect(row.caption).not.toBe(row.postTitle);
      // beside it, the deterministic copy target
      expect(row.postTitle).toBe("BIG PLAY · 1:12");
    } finally {
      await t.app.close();
    }
  });

  it("serves caption on 100% of cards on a job mixing refused and accepted copy", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "post-title-8328-c@test.local");
      const job = await seedRow(t, { ownerId: u.id, eventType: "GOAL", outcome: "scoring_play", start: 20, localizedTs: 32, caption: "Ordoñez scores the opener." });
      await seedRow(t, { ownerId: u.id, jobId: job.id, eventType: "BIG_PLAY", outcome: "big_play", start: 70, localizedTs: 82 });
      await seedRow(t, { ownerId: u.id, jobId: job.id, eventType: "GOAL", outcome: "scoring_play", start: 200, localizedTs: 212, caption: "Ordoñez doubles it.", postTitle: "Ordoñez doubles it" });
      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      const rows = [...(res.json().highlights as any[]), ...(res.json().notableHighlights as any[])];
      expect(rows.length).toBe(3);
      for (const h of rows) {
        expect(typeof h.caption).toBe("string");
        expect(h.caption.trim().length).toBeGreaterThan(0);
        expect(typeof h.postTitle).toBe("string");
        expect(h.postTitle.trim().length).toBeGreaterThan(0);
      }
      // AC5 — the served degrade is READ-TIME ONLY: no stored row gained a
      // caption or a postTitle, so legacy storage is untouched.
      const stored = t.store.highlightsForJob(job.id);
      expect(stored.filter((h: any) => h.postTitle !== undefined).length).toBe(1);
      expect(stored.filter((h: any) => h.caption !== undefined).length).toBe(2);
    } finally {
      await t.app.close();
    }
  });
});
