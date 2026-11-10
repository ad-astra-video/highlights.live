// ADAAAA-8530 (AC3) — the served highlight row states WHICH lane confirmed its
// window, derived READ-SIDE by the SAME `deriveConfirmation()` the decide note
// uses, so a Highlights card and the decide note above it can never disagree
// about one window.
//
// Two seams are proved here:
//
//   DERIVATION  `confirmationForHighlightRow(row, candidate)` returns exactly the
//               decide-note projection ({lane, label}) for the same stored window,
//               and NOTHING else — the inspector half (`flags`, `dive`,
//               `measurement`, `detail`) never leaves the decide note. A row whose
//               lane cannot be derived returns `undefined` (absent), never an
//               invented lane.
//   PAYLOAD     `GET /jobs/:id/detail` attaches `confirmation` to each served row
//               of BOTH `highlights[]` and `notableHighlights[]` (additive,
//               optional), with the lane+label shape only. No stored write, no
//               re-decide: the fixture seeds rows the way the pipeline stores them.
import { describe, expect, it } from "vitest";
import { JobCandidateSchema, HighlightRecordSchema, type ConfirmRecord, type JobCandidate, type WindowAnalysis } from "@highlights/events";
import {
  confirmationForHighlightRow,
  deriveConfirmation,
  servedConfirmation,
  type WindowConfirmation,
} from "../src/confirmation-lane";
import { buildTestApp } from "./helpers";

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId: "job-1",
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: "2026-11-10T00:00:00.000Z",
    ...over,
  });
}

/** A stored per-window analysis whose Stage-1 verdict carries the measured
 *  criteria block (the decide layer's own rationale + cited attestation). */
function analysisWith(
  criteria: Partial<Record<"ballCrossedLineBetweenPosts" | "ballInNet" | "scoreboardChanged" | "crowdErupted", boolean | null>>
): WindowAnalysis {
  return {
    prompt: "You are a sports highlight judge",
    dataItems: [{ type: "scoreboard", label: "Scoreboard score change", value: "yes" }],
    frames: [],
    images: [],
    response: {
      isHighlight: true,
      score: 85,
      outcome: "scoring_play",
      evidenceAttested: ["scoreboard"],
      verdict: {
        criteria: {
          ballCrossedLineBetweenPosts: null,
          ballInNet: null,
          scoreboardChanged: null,
          crowdErupted: null,
          ...criteria,
        },
        hypothesis: "SPORTING_EVENT",
        independentlyObserved: null,
        contradictedBy: null,
      },
    },
  } as unknown as WindowAnalysis;
}

function dive(over: { goalConfirmed?: "confirmed_goal" | "near_miss" | "not_goal"; stage1Disagreed?: boolean } = {}): ConfirmRecord {
  return {
    request: {
      prompt: "You are a sports highlight CONFIRMATION judge",
      dataItems: [],
      frames: [],
      keyframes: [],
      trajectories: [],
      audioLevels: [],
    },
    decision: {
      enabled: true,
      goalConfirmed: over.goalConfirmed ?? "confirmed_goal",
      confidence: 1,
      reason: "ball in the net + scoreboard update",
      evidence: {
        ballInNet: true,
        audioErupted: true,
        scoreboardChanged: true,
        sustainedScoringMotion: true,
        ballTrajectoryCrossedLine: true,
      },
      stage1Disagreed: over.stage1Disagreed ?? false,
    },
  } as unknown as ConfirmRecord;
}

/** The four lanes, as the pipeline stores them. */
const MEASURED = cand({ timestamp: 10, analysis: analysisWith({ scoreboardChanged: true }) });
const DIVE = cand({ timestamp: 20, analysis: analysisWith({}), confirm: dive() });
const DISAGREED = cand({ timestamp: 30, analysis: analysisWith({}), confirm: dive({ goalConfirmed: "near_miss" }) });
const BARE = cand({ timestamp: 40 });

describe("AC3 — the highlight-row derivation IS the decide-note derivation", () => {
  const cases: Array<[string, JobCandidate, WindowConfirmation["lane"]]> = [
    ["measured attestation", MEASURED, "measured"],
    ["corroborated dive", DIVE, "dive"],
    ["disagreed dive", DISAGREED, "dive_disagreed"],
    ["accepted with no corroboration", BARE, "unconfirmed"],
  ];

  for (const [name, candidate, lane] of cases) {
    it(`matches field-for-field for a ${name} window`, () => {
      const note = deriveConfirmation(candidate);
      expect(note?.lane).toBe(lane);
      const served = confirmationForHighlightRow({ status: "accepted", trigger: candidate.trigger }, candidate);
      // Byte-equal projection: the card states exactly the note's lane + label.
      expect(served).toEqual({ lane: note!.lane, label: note!.label });
      // …and NOTHING from the inspector half rides along (the same gate
      // `stripWindowInspection()` applies to the decide note).
      expect(Object.keys(served ?? {}).sort()).toEqual(["label", "lane"]);
    });
  }

  it("servedConfirmation() strips the inspector half from a derived note", () => {
    const note = deriveConfirmation(DIVE)!;
    expect(note.flags).toBeDefined();
    expect(note.dive).toBeDefined();
    const served = servedConfirmation(note)!;
    expect(served).toEqual({ lane: "dive", label: note.label });
    expect(JSON.stringify(served)).not.toContain("corroborated");
  });

  it("a row whose lane cannot be derived stays ABSENT (never invented)", () => {
    // A non-accepted row with no dive: `deriveConfirmation` returns undefined, so
    // a legacy/rejected row never states a lane the pipeline did not derive.
    expect(confirmationForHighlightRow({ status: "rejected" })).toBeUndefined();
    expect(confirmationForHighlightRow({ status: "pending" as any })).toBeUndefined();
  });

  it("a legacy accepted row derives honestly from its own stored status", () => {
    // No candidate link, no trigger, no analysis: the honest derivation is
    // `unconfirmed` ("lane not recorded") — it never claims measured/dive.
    const served = confirmationForHighlightRow({ status: "accepted" });
    expect(served?.lane).toBe("unconfirmed");
    expect(served?.label.length).toBeGreaterThan(0);
  });
});

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

async function seed(t: any, ownerId: string, jobId: string, over: Record<string, unknown>) {
  const row = HighlightRecordSchema.parse({
    ownerId,
    jobId,
    clipUri: `/clips/${jobId}-${Math.round(Number(over.start ?? 0))}.mp4`,
    start: 0,
    end: Number(over.start ?? 0) + 15,
    eventType: "BIG_PLAY",
    score: 60,
    reason: "A player drives into the box and the keeper gathers the ball.",
    outcome: "big_play",
    status: "accepted",
    createdAt: "2026-11-10T00:00:00.000Z",
    ...over,
  });
  await t.store.addHighlight(row);
  return row.id as string;
}

describe("AC3 — GET /jobs/:id/detail carries the lane on EVERY served row", () => {
  it("serves confirmation on highlights[] and notableHighlights[], lane+label only", async () => {
    const t = await buildTestApp();
    try {
      // The counters AC4 pins are operator-only (`jobDetailForRole` filters them
      // for a customer session), so the census is read from the admin session.
      const adminLogin = await t.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "admin@test.local", password: "adminpass" },
      });
      expect(adminLogin.statusCode).toBe(200);
      const u = { token: adminLogin.json().token as string, id: adminLogin.json().user.id as string };
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);

      // A postable GOAL linked to its measured decide window…
      await t.store.recordJobCandidate({ ...MEASURED, jobId: job.id, ownerId: u.id });
      const goalId = await seed(t, u.id, job.id, {
        id: "hl-goal-measured",
        start: 10,
        eventType: "GOAL",
        outcome: "scoring_play",
        candidateId: MEASURED.id,
      });
      // …a LEGACY accepted row with no candidate link (lane not recorded)…
      const legacyId = await seed(t, u.id, job.id, {
        id: "hl-legacy",
        start: 100,
        eventType: "GOAL",
        outcome: "scoring_play",
      });
      // …and a notable (non-scoring) moment whose window is dive-corroborated.
      await t.store.recordJobCandidate({ ...DIVE, jobId: job.id, ownerId: u.id });
      const notableId = await seed(t, u.id, job.id, {
        id: "hl-notable-dive",
        start: 300,
        eventType: "BIG_PLAY",
        outcome: "big_play",
        candidateId: DIVE.id,
      });

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      const highlights = body.highlights as any[];
      const served = (id: string) => highlights.find((h) => h.id === id);
      expect(served(goalId)?.confirmation).toEqual({
        lane: "measured",
        label: deriveConfirmation(MEASURED)!.label,
      });
      // A legacy row is served, and its honest lane is `unconfirmed`.
      expect(served(legacyId)?.confirmation?.lane).toBe("unconfirmed");
      for (const row of highlights) {
        expect(Object.keys(row.confirmation).sort()).toEqual(["label", "lane"]);
      }

      const notable = (body.notableHighlights as any[]).find((m) => m.id === notableId);
      expect(notable, "the notable moment is served").toBeDefined();
      expect(notable.confirmation).toEqual({ lane: "dive", label: deriveConfirmation(DIVE)!.label });
      expect(Object.keys(notable.confirmation).sort()).toEqual(["label", "lane"]);
      expect(notable.siblingCount).toBe(1);

      // AC4 invariant surface: the counters still ride the payload untouched, and
      // the card census is the served lists (no row gained or lost a card).
      for (const key of ["rawHighlights", "postableHighlights"]) {
        expect(typeof body.job[key]).toBe("number");
      }
      expect(body.job.postableHighlights).toBe(highlights.length);
      // No row became postable or notable because a lane was attached.
      expect(body.job.rawHighlights).toBe(3);
    } finally {
      await t.app.close();
    }
  });
});
