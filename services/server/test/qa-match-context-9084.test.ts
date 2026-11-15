/**
 * ADAAAA-9084: the QA DELIVERED-TEAMS lever.
 *
 * The score-surface rule (`contradicted`) needs the kit channel outside the
 * measured bar AND a printed name that does not match the job's teams. Every
 * served clip prints `RMA 1-1 BAR` with blue plates, so on the served corpus one
 * channel always matches and the verdict is always `consistent` (measured
 * 2026-11-15: 0 contradicted rows table-wide). The lever sets the teams ONE job
 * delivers, so a `source=file` job can carry a deliberately foreign reference
 * without a PIP composite clip.
 *
 * These tests pin the properties that make the lever safe and GRADEABLE:
 *  - absent input is a no-op: no key on the record, request byte-identical
 *    (the "inert unless asked for" contract);
 *  - only an operator/QA may arm it, and an unauthorised ask is a 403 (never a
 *    silent drop — a lever that does nothing is the failure this ticket fixed);
 *  - a malformed lever is a 422 BEFORE the quota gate and creates no job row;
 *  - an armed job's teams reach `/analyze` through the job's live reader, and
 *    the VOD resolver is skipped so its 25/50/90 % folds cannot overwrite them.
 */
import { describe, it, expect } from "vitest";
import { MatchContextSchema } from "@highlights/events";
import { buildTestApp } from "./helpers";
import { deliveredMatchContextTeams } from "../src/analyzer";
import {
  parseQaMatchContextTeams,
  qaMatchContextArmed,
  qaMatchContextAuthorized,
  qaMatchContextSeed,
  QA_MATCH_CONTEXT_ACTION,
  QA_MATCH_CONTEXT_SOURCE,
} from "../src/qa-match-context";

/** The proving shape: delivered teams that print neither on the served bug
 *  (`RMA`/`BAR`) nor wear a colour inside either plate's bar. */
const FOREIGN_TEAMS = [
  { side: "home", name: "Juventus", kitColors: [{ primary: "red" }] },
  { side: "away", name: "Liverpool", kitColors: [{ primary: "red" }, { primary: "white" }] },
];

async function registerUser(app: any, email: string): Promise<string> {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "password123" } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function adminToken(app: any, cfg: any): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: cfg.adminEmail, password: cfg.adminPassword },
  });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

describe("parseQaMatchContextTeams — the submitted field", () => {
  it("absent is a valid no-lever (the inert default)", () => {
    expect(parseQaMatchContextTeams(undefined)).toEqual({ ok: true, teams: undefined });
    expect(parseQaMatchContextTeams(null)).toEqual({ ok: true, teams: undefined });
  });

  it("shapes one or two sides as full MatchContextTeam records", () => {
    const one = parseQaMatchContextTeams([{ side: "away", name: "Liverpool", kitColors: [{ primary: "red" }] }]);
    expect(one.ok).toBe(true);
    const teams = (one as any).teams;
    expect(teams).toHaveLength(1);
    expect(teams[0]).toEqual({
      side: "away",
      name: "Liverpool",
      kitColors: [{ primary: "red" }],
      // A pin is an assertion: confidence 1 and the lever as its only evidence.
      confidence: 1,
      evidence: [{ source: QA_MATCH_CONTEXT_SOURCE, snippet: QA_MATCH_CONTEXT_ACTION }],
    });
    // The team record must satisfy the shared contract the job row is parsed by.
    expect(MatchContextSchema.parse(qaMatchContextSeed(teams)).teams).toEqual(teams);

    const two = parseQaMatchContextTeams(FOREIGN_TEAMS);
    expect(two.ok).toBe(true);
    expect((two as any).teams.map((t: any) => t.side)).toEqual(["home", "away"]);
    expect((two as any).teams[1].kitColors).toEqual([{ primary: "red" }, { primary: "white" }]);
  });

  it("rejects every malformed shape with `invalid_qa_match_context_teams`", () => {
    const bads: unknown[] = [
      "nope",
      {},
      [],
      [{ side: "middle", name: "X FC" }],
      [{ side: "home", name: "X FC" }, { side: "home", name: "Y FC" }],
      [{ side: "home", name: "" }],
      [{ side: "home", name: "  " }],
      [{ side: "home", name: "unknown" }],
      [{ side: "home", name: "X FC" }, { side: "away", name: "Y FC" }, { side: "home", name: "Z FC" }],
      [{ side: "home", name: "X FC", kitColors: "red" }],
      [{ side: "home", name: "X FC", kitColors: [{ primary: "" }] }],
      [{ side: "home", name: "X FC", kitColors: [{ primary: "red" }, { primary: "blue" }, { primary: "green" }] }],
      [{ side: "home", name: "X FC", kitColors: [{ primary: "red", secondary: 7 }] }],
      ["home"],
    ];
    for (const bad of bads) {
      const r = parseQaMatchContextTeams(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect((r as any).code).toBe("invalid_qa_match_context_teams");
    }
  });
});

describe("qaMatchContextAuthorized — who may assert the delivered teams", () => {
  it("admits the operator/QA session and the named owner only", () => {
    expect(qaMatchContextAuthorized({ id: "u1", role: "admin" }, {})).toBe(true);
    expect(qaMatchContextAuthorized({ id: "u1", role: "user" }, {})).toBe(false);
    expect(qaMatchContextAuthorized(undefined, {})).toBe(false);
    expect(qaMatchContextAuthorized({ id: "u2", role: "user" }, { QA_MATCH_CONTEXT_OWNER_IDS: "u1, u2" })).toBe(true);
    expect(qaMatchContextAuthorized({ id: "u3", role: "user" }, { QA_MATCH_CONTEXT_OWNER_IDS: "u1,u2" })).toBe(false);
    // an empty list grants nothing
    expect(qaMatchContextAuthorized({ id: "u1", role: "user" }, { QA_MATCH_CONTEXT_OWNER_IDS: " , " })).toBe(false);
  });
});

describe("qaMatchContextSeed — the record perceive is delivered from", () => {
  it("is a valid matchContext that names the lever and reads as a pin, not a resolve", () => {
    const { ok, teams } = parseQaMatchContextTeams(FOREIGN_TEAMS) as any;
    expect(ok).toBe(true);
    const seed = qaMatchContextSeed(teams, { sport: "soccer", at: "2026-11-15T15:00:00.000Z" });
    expect(MatchContextSchema.parse(seed)).toEqual(seed);
    expect(seed.resolverVersion).toBe(0);
    expect(seed.ambiguous).toBe(false);
    expect(seed.inferredAt).toBe("2026-11-15T15:00:00.000Z");
    expect(seed.trail[0].action).toEqual([QA_MATCH_CONTEXT_ACTION]);
    expect(seed.teams.map((t) => `${t.side}=${t.name}`)).toEqual(["home=Juventus", "away=Liverpool"]);
  });

  it("is what every `/analyze` delivers (the shipped reader path)", () => {
    const { teams } = parseQaMatchContextTeams(FOREIGN_TEAMS) as any;
    const seed = qaMatchContextSeed(teams, { at: "2026-11-15T15:00:00.000Z" });
    expect(deliveredMatchContextTeams({ getMatchContext: () => seed, calibration: {} })).toEqual([
      { side: "home", name: "Juventus", kitColors: [{ primary: "red" }] },
      { side: "away", name: "Liverpool", kitColors: [{ primary: "red" }, { primary: "white" }] },
    ]);
  });

  it("qaMatchContextArmed is the VOD worker's skip predicate", () => {
    expect(qaMatchContextArmed(undefined)).toBe(false);
    expect(qaMatchContextArmed({})).toBe(false);
    expect(qaMatchContextArmed({ qaMatchContextTeams: [] })).toBe(false);
    expect(qaMatchContextArmed({ qaMatchContextTeams: [{ side: "home", name: "X FC" }] })).toBe(true);
  });
});

describe("POST /jobs — the lever at the real route", () => {
  it("a normal user cannot arm it (403, no job row)", async () => {
    const { app, store } = await buildTestApp();
    const token = await registerUser(app, "lever-user@test.dev");
    const before = store.listAllJobs().length;
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: "/data/clips/foreign_surface_qa9084.mp4", gameHint: "soccer", qaMatchContextTeams: FOREIGN_TEAMS },
    });
    expect(r.statusCode).toBe(403);
    expect(r.json().code).toBe("qa_match_context_not_authorized");
    expect(store.listAllJobs().length).toBe(before);
    await app.close();
  });

  it("a malformed lever is a 422 and creates no job row", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const before = store.listAllJobs().length;
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: "/x.mp4", gameHint: "soccer", qaMatchContextTeams: [{ side: "bench", name: "X FC" }] },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("invalid_qa_match_context_teams");
    expect(store.listAllJobs().length).toBe(before);
    await app.close();
  });

  it("an armed VOD job carries the pin on the row, the seeded matchContext and the lever on the API", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        source: "file",
        videoPath: "/data/clips/foreign_surface_qa9084.mp4",
        gameHint: "soccer",
        scoreboardRoi: [0, 0, 1, 0.25],
        qaMatchContextTeams: FOREIGN_TEAMS,
      },
    });
    expect(r.statusCode).toBe(202);
    const jobId = r.json().job.id;

    const stored = store.getJob(jobId) as any;
    expect(stored.qaMatchContextTeams.map((t: any) => `${t.side}=${t.name}`)).toEqual(["home=Juventus", "away=Liverpool"]);
    expect(stored.qaMatchContextTeams[0].evidence[0].source).toBe(QA_MATCH_CONTEXT_SOURCE);
    expect(stored.matchContext.resolverVersion).toBe(0);
    expect(stored.matchContext.teams.map((t: any) => `${t.side}=${t.name}`)).toEqual(["home=Juventus", "away=Liverpool"]);
    expect(stored.matchContext.trail[0].action).toEqual([QA_MATCH_CONTEXT_ACTION]);
    // The board reads the same pin back off the job API.
    const got = await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } });
    expect(got.statusCode).toBe(200);
    expect(got.json().job.qaMatchContextTeams.map((t: any) => t.name)).toEqual(["Juventus", "Liverpool"]);
    expect(got.json().job.matchContext.teams.map((t: any) => t.name)).toEqual(["Juventus", "Liverpool"]);
    await app.close();
  });

  it("an unarmed submit carries neither key (inert default)", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file", videoPath: "/data/clips/foreign_surface_qa9084.mp4", gameHint: "soccer" },
    });
    expect(r.statusCode).toBe(202);
    const stored = store.getJob(r.json().job.id) as any;
    expect(Object.prototype.hasOwnProperty.call(stored, "qaMatchContextTeams")).toBe(false);
    // No seeded context: the resolver (or nothing) owns the teams, as before.
    expect(stored.matchContext).toBeUndefined();
    await app.close();
  });

  it("refuses the lever on a live rail (the live writer re-resolves teams)", async () => {
    const { app, cfg } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const r = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "rtmp", videoPath: "rtmp://example/live", gameHint: "soccer", qaMatchContextTeams: FOREIGN_TEAMS },
    });
    expect(r.statusCode).toBe(422);
    expect(r.json().code).toBe("qa_match_context_live_unsupported");
    await app.close();
  });

  it("is validated + authorized BEFORE the quota/subscription gate", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const routeAt = src.indexOf('"/jobs",');
    expect(routeAt).toBeGreaterThan(0);
    const handler = src.slice(routeAt, routeAt + 12_000);
    const parseAt = handler.indexOf("const qaTeamsInput = parseQaMatchContextTeams(req.body?.qaMatchContextTeams);");
    const authAt = handler.indexOf("if (qaMatchContextTeams && !qaMatchContextAuthorized(user)) {");
    const subAt = handler.indexOf("const sub = await db.getSubscription(user.id);");
    expect(parseAt).toBeGreaterThan(0);
    expect(authAt).toBeGreaterThan(0);
    expect(subAt).toBeGreaterThan(0);
    expect(parseAt).toBeLessThan(subAt);
    expect(authAt).toBeLessThan(subAt);
    // and the VOD worker skips the resolver for an armed job
    const armAt = src.indexOf("const qaArmed = qaMatchContextArmed(store.getJob(jobId));");
    expect(armAt).toBeGreaterThan(0);
    expect(src.slice(armAt, armAt + 2000)).toContain("!qaArmed && matchContextEnabled()");
  });
});
