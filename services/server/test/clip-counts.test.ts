// ADAAAA-7854: clip counting across surfaces. The user-facing clip count is the
// DEDUPED postable moment count derived server-side; the DB keeps every row.
//
// What this file proves (the ACs that need more than a pure-function test):
//  - GET /jobs carries the tile counts, and the tile count EQUALS the deduped
//    count on GET /jobs/:id/detail for the same job (asserted, not eyeballed).
//  - the persisted row count is unchanged by the counts existing (no deletes, no
//    backfill — `store`/DB still hold all 24 rows of d61e52f6).
//  - admin analytics returns the raw row total NEXT TO the deduped total, with a
//    raw basis label.
//  - the monthly clip quota debits once per POSTABLE MOMENT: two overlapping
//    accepted highlights for one job debit 1, while both rows persist.
import { describe, expect, it } from "vitest";
import type { HighlightRecord } from "@highlights/events";
import { persistLiveHighlight } from "../src/api";
import { quotaMomentCount } from "../src/highlight-postable";
import { Store } from "../src/store";
import { buildTestApp, testCfg } from "./helpers";
import { D61_JOB, d61Highlights } from "./fixtures/d61-highlights";

const BEARER = (token: string) => ({ authorization: `Bearer ${token}` });

async function register(app: any, email: string): Promise<{ token: string; userId: string }> {
  const reg = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email, password: "password123" },
  });
  expect(reg.statusCode).toBe(200);
  const token = reg.json().token as string;
  const me = await app.inject({ method: "GET", url: "/auth/me", headers: BEARER(token) });
  expect(me.statusCode).toBe(200);
  return { token, userId: me.json().user.id as string };
}

/** Seed a store with the 24 measured rows of VOD job d61e52f6. */
async function seedD61(store: Store, ownerId: string): Promise<void> {
  await store.createJob({ id: D61_JOB, ownerId, source: "file", gameHint: "soccer goal" });
  for (const h of d61Highlights()) await store.addHighlight({ ...h, ownerId });
}

describe("clip counts on the job payloads (ADAAAA-7854 AC1-AC3, AC7)", () => {
  it("tile count == detail deduped count, and every row is still persisted", async () => {
    const { app, store, db } = await buildTestApp({ BETA_GATE: "0" });
    const { token, userId } = await register(app, "counts@test.dev");
    await seedD61(store, userId);

    // AC1: the job list carries server-derived counts (no client re-derivation).
    const list = await app.inject({ method: "GET", url: "/jobs", headers: BEARER(token) });
    expect(list.statusCode).toBe(200);
    const tile = list.json().jobs.find((j: any) => j.id === D61_JOB);
    expect(tile).toBeTruthy();
    expect({
      rawHighlights: tile.rawHighlights,
      postableHighlights: tile.postableHighlights,
      mergedHighlights: tile.mergedHighlights,
    }).toEqual({ rawHighlights: 24, postableHighlights: 17, mergedHighlights: 4 });

    // AC3: the tile's accepted count EQUALS the deduped count the detail route
    // returns for the same job. This is the equality the tile renders, asserted.
    const detail = await app.inject({ method: "GET", url: `/jobs/${D61_JOB}/detail`, headers: BEARER(token) });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.job.postableHighlights).toBe(tile.postableHighlights);
    expect(body.job.mergedHighlights).toBe(tile.mergedHighlights);
    expect(body.highlights.length).toBe(tile.postableHighlights);
    expect(body.duplicateHighlights.length).toBe(tile.mergedHighlights);
    // d61e52f6 reads 17 accepted (deduped) and not the 24 raw rows.
    expect(body.highlights.length).toBe(17);

    // GET /jobs/:id carries the same counts (a single-job refresh can't drift).
    const one = await app.inject({ method: "GET", url: `/jobs/${D61_JOB}`, headers: BEARER(token) });
    expect(one.statusCode).toBe(200);
    expect(one.json().job.postableHighlights).toBe(17);
    expect(one.json().job.mergedHighlights).toBe(4);

    // AC7: persistence unchanged — every clip row is still there (24), and the
    // raw grid still lists all of them.
    expect(store.highlightsForJob(D61_JOB).length).toBe(24);
    expect(store.allHighlights().length).toBe(24);
    expect((await db.listHighlights()).length).toBe(24);
    const raw = await app.inject({ method: "GET", url: "/highlights", headers: BEARER(token) });
    expect(raw.statusCode).toBe(200);
    expect(raw.json().highlights.length).toBe(24);
  });

  it("admin analytics keeps the raw row total and adds the deduped total beside it (AC4)", async () => {
    const { app, store, cfg } = await buildTestApp({ BETA_GATE: "0" });
    const { userId } = await register(app, "counts-analytics@test.dev");
    await seedD61(store, userId);

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const adminToken = login.json().token as string;

    const res = await app.inject({ method: "GET", url: "/admin/analytics", headers: BEARER(adminToken) });
    expect(res.statusCode).toBe(200);
    const clips = res.json().clips;
    expect(clips.clipsTotal).toBe(24); // raw rows — DB tracking preserved
    expect(clips.clipsPostable).toBe(17); // deduped user-facing total
    // The labels are what stop a future admin surface reading clipsTotal as the
    // customer-facing count.
    expect(clips.clipsTotalBasis).toBe("raw_rows_includes_merged");
    expect(clips.clipsPostableBasis).toBe("deduped_postable_moments");
  });
});

describe("clip quota debits per postable moment (ADAAAA-7854 AC6)", () => {
  function rec(over: Partial<HighlightRecord> & { id: string }): HighlightRecord {
    return {
      jobId: "job-quota",
      clipUri: `/clips/${over.id}.mp4`,
      start: 100,
      end: 115,
      score: 90,
      status: "accepted",
      outcome: "scoring_play",
      createdAt: "2026-11-03T00:00:00.000Z",
      ...over,
    } as HighlightRecord;
  }

  async function harness() {
    const store = new Store(null);
    await store.createJob({ id: "job-quota", ownerId: "u1", source: "file" });
    const calls = { billed: 0, debited: 0 };
    const deps = {
      store,
      cfg: testCfg({ AUTO_PUBLISH_HIGHLIGHTS: "1" }),
      billing: { onHighlightCreated: async () => void calls.billed++ } as any,
      entitlements: {
        onClipGenerated: async () => void calls.debited++,
        onClipRejected: async () => void calls.debited--,
      } as any,
      db: { recordFunnelEvent: async () => {} } as any,
    };
    return { store, calls, deps };
  }

  it("two overlapping accepted highlights for one job debit exactly once (both rows persisted)", async () => {
    const { store, calls, deps } = await harness();
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q1", start: 100, end: 115, score: 90 }));
    // Second clip overlaps the first (104-119 vs 100-115): the same moment.
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q2", start: 104, end: 119, score: 95 }));

    expect(calls.debited).toBe(1);
    expect(calls.billed).toBe(1);
    // Persistence unchanged: the merged-away duplicate is still a row.
    expect(store.highlightsForJob("job-quota").map((h) => h.id).sort()).toEqual(["q1", "q2"]);
  });

  it("debits once when the STRONGER clip of an overlapping pair lands second", async () => {
    const { calls, deps } = await harness();
    // Weaker window first, then the better-scoring overlapping clip (which wins
    // the moment). Either arrival order must charge the moment once.
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q1", start: 100, end: 115, score: 70 }));
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q2", start: 104, end: 119, score: 98 }));
    expect(calls.debited).toBe(1);
  });

  it("two NON-overlapping clips are two moments and debit twice", async () => {
    const { calls, deps } = await harness();
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q1", start: 100, end: 115 }));
    await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec({ id: "q2", start: 200, end: 215 }));
    expect(calls.debited).toBe(2);
  });

  it("a non-goal clip still debits (quota meters generation, not postability)", async () => {
    const { store, calls, deps } = await harness();
    // `near_miss` is notable-but-not-a-goal: the postable LIST excludes it, but it
    // is still a generated clip the customer keeps, so the quota basis is
    // verdict-independent and this row debits one slot (unchanged behaviour).
    await persistLiveHighlight(
      deps,
      { id: "u1" } as any,
      {} as any,
      rec({ id: "q1", start: 100, end: 115, outcome: "near_miss" } as any)
    );
    expect(calls.debited).toBe(1);
    expect(store.highlightsForJob("job-quota").length).toBe(1);
    // A human REJECTION releases its slot and no longer counts as a moment, so a
    // later overlapping duplicate of the same footage is a new moment again.
    expect(quotaMomentCount(store.highlightsForJob("job-quota").map((h) => ({ ...h, status: "rejected" as const })))).toBe(0);
  });
});
