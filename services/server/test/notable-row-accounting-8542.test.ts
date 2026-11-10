// ADAAAA-8549 (AC3 of ADAAAA-8542): a delivered row with NO page
// representation — settled on the read model itself, and closed by the row
// identity.
//
// MEASURED SHAPE (browser job 50b7aed6, deleted since): FOUR rows in
// `observeMetrics.deliveredLatency.rows`, page served `highlights=[]`,
// `notableHighlights=3`, `notScoringHighlights=4`. Row
// `eccc4e25-8d1e-4fda-86b9-b3de34eba3a5` (ts 233.670, dive-confirmed goal) was in
// NEITHER top-level array, so it read as a dropped row.
//
// The starts below are the job's own accepted candidates, recovered from
// `deleted_jobs.candidates` (312 rows, `counts: {accepted: 4, highlights: 4}`) —
// the job row itself is cascade-deleted, so this fixture IS the delivered row
// set, 15 s windows included (the measured live window shape).
//
// Verdict: a counting artifact, not a drop. Rows at 182.632 and 233.670 are
// 51.038 s apart as starts but only 36.038 s apart as ANCHOR GAP
// (`start - running max end`), which is under NOTABLE_MOMENT_GAP_S, so they are
// ONE notable moment: 3 cards cover 4 rows and the 4th id rides the second
// card's `siblingClips`. Counting cards (or scanning only `highlights[]` +
// `notableHighlights[]`) under-reports by one — which is exactly what
// `accountHighlightRows` now states explicitly.
//
// The rest of the file pins the paths that CAN hide a row (rail-cap overflow, a
// non-notable outcome, a replay whose owner is not served) plus the row identity
// the payload must keep closed.
import { describe, expect, it } from "vitest";
import {
  MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT,
  NOTABLE_MOMENT_GAP_S,
  HighlightRecordSchema,
} from "@highlights/events";
import { accountHighlightRows, buildPostableHighlights } from "../src/highlight-postable.js";
import { buildTestApp } from "./helpers";

/** One persisted row, 15 s window at `start` (the measured live shape). */
function hl(jobId: string, start: number, over: Record<string, unknown> = {}) {
  return HighlightRecordSchema.parse({
    id: `hl-${Math.round(start)}`,
    jobId,
    clipUri: `/clips/${jobId}-${Math.round(start)}.mp4`,
    start,
    end: start + 15,
    eventType: "BIG_PLAY",
    score: 85,
    reason: "A player drives into the box and the keeper gathers the ball.",
    outcome: "big_play",
    status: "accepted",
    createdAt: "2026-11-10T03:20:00.000Z",
    ...over,
  });
}

/** The EXACT four delivered starts of job 50b7aed6
 * (`deleted_jobs.candidates`, status=accepted). */
const DELIVERED_STARTS = [83.411, 182.632, 233.67, 616.063];

describe("ADAAAA-8549 AC3 fixture — the four delivered rows of 50b7aed6", () => {
  const list = DELIVERED_STARTS.map((s) => hl("50b7aed6", s));
  const out = buildPostableHighlights(list);
  const accounting = accountHighlightRows(list, out);

  it("serves 3 notable cards covering 4 rows (the measured page shape)", () => {
    expect(out.highlights).toEqual([]);
    expect(out.counts.postable).toBe(0);
    expect(out.counts.notScoring).toBe(4);
    expect(out.notableMoments.moments.length).toBe(3);
    expect(out.notableMoments.optionsSuppressed).toBe(0);
    // Card 2 owns the 182.632 window and carries the 233.670 window as its option.
    const [, second] = out.notableMoments.moments;
    expect(second.owner.id).toBe("hl-183");
    expect(second.options.map((o) => o.id)).toEqual(["hl-234"]);
    expect(second.memberCount).toBe(2);
  });

  it("the 'missing' row is a sibling_clip — every delivered id is reachable", () => {
    // hl-234 is the AC3 row's window: absent from `highlights` and from the
    // notable OWNER list, present as the second card's rail option.
    expect(accounting.served.map((r) => [r.id, r.representation])).toEqual(
      expect.arrayContaining([["hl-234", "sibling_clip"]])
    );
    expect(accounting.served.length).toBe(4);
    expect(accounting.unrepresented).toEqual([]);
    // The gap arithmetic that makes it one moment, not two.
    expect(233.67 - (182.632 + 15)).toBeLessThan(NOTABLE_MOMENT_GAP_S);
  });

  it("counts close: 4 raw rows - 0 postable = 4 not-scoring, 0 replays", () => {
    const { counts } = out;
    expect(counts.total - counts.postable).toBe(
      counts.merged + counts.rejected + counts.notScoring + counts.contradicting + counts.replay
    );
    expect(counts.replay).toBe(0);
  });
});

describe("ADAAAA-8549 — the drop paths that CAN hide a row are disclosed", () => {
  it("a 4-window moment serves 1 card + 3 rail options: all four ids covered", () => {
    // Same moment (anchor gap), exactly at the rail cap: no row is hidden.
    const starts = [100, 110, 120, 130];
    const list = starts.map((s) => hl("rail-job", s));
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    expect(out.notableMoments.moments.length).toBe(1);
    expect(out.notableMoments.moments[0].memberCount).toBe(4);
    expect(out.notableMoments.optionsSuppressed).toBe(0);
    expect(accounting.served.length).toBe(4);
    expect(accounting.served.filter((r) => r.representation === "sibling_clip").length).toBe(
      MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT
    );
    expect(accounting.unrepresented).toEqual([]);
  });

  it("a 5-row moment overflows the rail cap: the overflow is named, not dropped", () => {
    const starts = [100, 110, 120, 130, 140];
    const list = starts.map((s) => hl("cap-job", s));
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    expect(out.notableMoments.moments.length).toBe(1);
    expect(out.notableMoments.moments[0].memberCount).toBe(5);
    expect(out.notableMoments.optionsSuppressed).toBe(5 - 1 - MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT);
    // 1 owner + 3 options shown; the 5th row is disclosed with its reason.
    expect(accounting.served.length).toBe(1 + MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT);
    expect(accounting.unrepresented).toEqual([
      { id: "hl-140", reason: "notable_option_over_rail_cap" },
    ]);
    expect(accounting.served.length + accounting.unrepresented.length).toBe(list.length);
  });

  it("a non-notable non-scoring outcome is counted but disclosed as not_scoring", () => {
    const list = [
      hl("not-highlight-job", 10, { outcome: "not_highlight", eventType: "AUDIO_BURST" }),
      hl("not-highlight-job", 200),
    ];
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    // It IS in the not-scoring count (that count is a gate count, not a lane).
    expect(out.counts.notScoring).toBe(2);
    expect(accounting.served).toEqual([{ id: "hl-200", representation: "notable_card" }]);
    expect(accounting.unrepresented).toEqual([{ id: "hl-10", reason: "not_scoring" }]);
  });

  it("a footage-less row is still reachable (no clip is not the same as no row)", () => {
    const list = [
      // No clip at all (`clipUri: ""` and no clipError): nothing to play, and
      // still a persisted row that must stay reachable.
      hl("footage-less", 100, { clipUri: "" }),
      hl("footage-less", 112),
    ];
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    expect(out.notableMoments.moments.length).toBe(1);
    // The row WITH footage owns the card, the footage-less one is its option —
    // served either way, never disclosed as unrepresented.
    expect(accounting.served.map((r) => [r.id, r.representation])).toEqual(
      expect.arrayContaining([
        ["hl-112", "notable_card"],
        ["hl-100", "sibling_clip"],
      ])
    );
    expect(accounting.unrepresented).toEqual([]);
  });

  it("rejected and contradicting rows are disclosed with their own reasons", () => {
    const list = [
      hl("gate-job", 10, { status: "rejected" }),
      hl("gate-job", 20, {
        outcome: "scoring_play",
        eventType: "GOAL",
        reason: "The striker's shot does not enter the net.",
      }),
      hl("gate-job", 30),
    ];
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    expect(out.counts.rejected).toBe(1);
    expect(out.counts.contradicting).toBe(1);
    expect(accounting.unrepresented).toEqual([
      { id: "hl-10", reason: "rejected" },
      { id: "hl-20", reason: "contradicting" },
    ]);
    expect(accounting.served).toEqual([{ id: "hl-30", representation: "notable_card" }]);
  });

  it("a replay under a served owner is an alternative; under an unserved owner it is named", () => {
    const list = [
      hl("replay-job", 10), // the moment the replay repeats
      hl("replay-job", 60, { replayOf: "hl-10" }),
      hl("replay-job", 210, { replayOf: "hl-211" }), // owner does not exist
    ];
    const out = buildPostableHighlights(list);
    const accounting = accountHighlightRows(list, out);
    expect(out.counts.replay).toBe(2);
    expect(accounting.served.map((r) => [r.id, r.representation])).toEqual(
      expect.arrayContaining([
        ["hl-10", "notable_card"],
        ["hl-60", "replay_alternative"],
      ])
    );
    expect(accounting.unrepresented).toEqual([{ id: "hl-210", reason: "replay_owner_missing" }]);
    // The row identity stays closed BECAUSE the replay rows have their own
    // bucket: without `replay`, `raw - postable` would be short by two here.
    const { counts } = out;
    expect(counts.total - counts.postable).toBe(
      counts.merged + counts.rejected + counts.notScoring + counts.contradicting + counts.replay
    );
    // Without the replay bucket the identity would be short by exactly the two
    // replay rows — that is the regression this pins.
    expect(
      counts.total - counts.postable - (counts.merged + counts.rejected + counts.notScoring + counts.contradicting)
    ).toBe(2);
    expect(counts.replay).toBe(2);
  });

  it("fail-closed: a row in no lane and no known rule answers 'unaccounted', never a guess", () => {
    // A non-postable scoring_play row that the projection did not serve and that
    // does NOT contradict itself matches no drop rule. The old reason defaulted
    // it to `contradicting` (a cause it cannot know); the fail-closed value says
    // so plainly, so a new drop path can never hide behind a plausible label.
    const orphan = hl("orphan-job", 300, { outcome: "scoring_play", eventType: "GOAL", score: 90 });
    const empty = {
      highlights: [],
      duplicates: [],
      notableMoments: { moments: [], optionsSuppressed: 0 },
    };
    const accounting = accountHighlightRows([orphan], empty);
    expect(accounting.unrepresented).toEqual([{ id: "hl-300", reason: "unaccounted" }]);
    expect(accounting.served).toEqual([]);
    // And the shipped projection never produces it on any fixture above.
    for (const starts of [DELIVERED_STARTS, [100, 110, 120, 130, 140]]) {
      const list = starts.map((s) => hl("audit-job", s));
      const out = buildPostableHighlights(list);
      expect(accountHighlightRows(list, out).unrepresented.map((r) => r.reason)).not.toContain(
        "unaccounted"
      );
    }
  });
});

describe("ADAAAA-8549 — the detail payload states the accounting and closes the counts", () => {
  function auth(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  async function register(app: any, email: string) {
    const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
    expect(r.statusCode).toBe(200);
    return { token: r.json().token as string, id: r.json().user.id as string };
  }

  async function seed(t: any, jobId: string, start: number, over: Record<string, unknown> = {}) {
    const rec = hl(jobId, start, over);
    await t.store.addHighlight(rec);
    return rec.id;
  }

  it("serves rowAccounting and every persisted row id from the same pass as the lanes", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "row-accounting-8549@test.local");
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);
      // The AC3 geometry: 3 cards, 4 rows, the 4th on a rail.
      const ids = [];
      for (const start of DELIVERED_STARTS) ids.push(await seed(t, job.id, start));
      // Plus two rows that genuinely have no lane: a not_highlight read and a
      // replay whose owner is not served.
      ids.push(await seed(t, job.id, 700, { outcome: "not_highlight", eventType: "AUDIO_BURST" }));
      ids.push(await seed(t, job.id, 900, { replayOf: "hl-does-not-exist" }));

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.notableHighlights.length).toBe(3);
      const ra = body.rowAccounting;
      expect(ra).toBeTruthy();
      const accounted = [...ra.served.map((r: any) => r.id), ...ra.unrepresented.map((r: any) => r.id)].sort();
      expect(accounted).toEqual([...ids].sort());
      // The AC3 row is served as an option, not disclosed.
      expect(ra.served.find((r: any) => r.id === "hl-234")).toEqual({
        id: "hl-234",
        representation: "sibling_clip",
      });
      expect(ra.unrepresented.map((r: any) => [r.id, r.reason])).toEqual(
        expect.arrayContaining([
          ["hl-700", "not_scoring"],
          ["hl-900", "replay_owner_missing"],
        ])
      );
      // Counts close ON THE WIRE: the payload now carries the drop buckets the
      // schema used to strip.
      expect(body.job.rawHighlights - body.job.postableHighlights).toBe(
        body.job.mergedHighlights +
          body.job.rejectedHighlights +
          body.job.notScoringHighlights +
          body.job.contradictingHighlights +
          body.job.replayHighlights
      );
      expect(body.job.replayHighlights).toBe(1);
    } finally {
      await t.app.close();
    }
  });
});
