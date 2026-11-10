// ADAAAA-8542 (AC3): a delivered row must never be silently absent from the page.
//
// The gate measured row `eccc4e25` "in neither highlights nor notableHighlights"
// on job 50b7aed6 (4 delivered rows, 3 notable cards). A notable moment is ONE
// card whose other windows ride `siblingClips[]` (ADAAAA-8443), so membership in
// "notableHighlights" is owners AND their options — the ADAAAA-8447 counting
// lesson. Rather than leave that reconstruction to each grader, the projection
// now accounts for every persisted row: `served` (with the surface that leads to
// it) or `unrepresented` (with the reason). Silence is no longer possible.
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema } from "@highlights/events";
import { buildPostableHighlights } from "../src/highlight-postable.js";
import { buildTestApp } from "./helpers";

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

async function register(app: any, email: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: "pw-at-least-8" } });
  expect(r.statusCode).toBe(200);
  return { token: r.json().token as string, id: r.json().user.id as string };
}

function row(id: string, jobId: string, start: number, over: Record<string, unknown> = {}) {
  return HighlightRecordSchema.parse({
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
    createdAt: "2026-11-10T04:00:00.000Z",
    ...over,
  });
}

async function seed(t: any, jobId: string, start: number, over: Record<string, unknown> = {}) {
  const id = `hl-${String(Math.round(start))}`;
  await t.store.addHighlight(row(id, jobId, start, over));
  return id;
}

describe("buildPostableHighlights — row accounting (AC3)", () => {
  const jobId = "job-accounting";

  it("accounts a 4-row notable job that serves 3 cards: every row is reachable", () => {
    // The gate's shape: 4 delivered notable rows served as 3 cards. Two lone
    // windows (182.632 is the first dive-confirmed goal start) and one moment of
    // two windows (616.063 + 620.0 are within the 40 s anchor gap), so the
    // fourth row is a sibling clip — the row the gate called "lost".
    const starts = [182.632, 250.0, 616.063, 620.0];
    const list = starts.map((s) => row(`hl-${Math.round(s)}`, jobId, s));
    const out = buildPostableHighlights(list);

    expect(out.notableMoments.moments.length).toBe(3);
    // The row QA called lost is a sibling clip of the 616 moment — reachable.
    const ids = starts.map((s) => `hl-${Math.round(s)}`);
    expect(out.rowAccounting.unrepresented).toEqual([]);
    expect(out.rowAccounting.served.map((s) => s.id).sort()).toEqual([...ids].sort());
    expect(out.rowAccounting.served.find((s) => s.id === ids[3])).toEqual({
      id: ids[3],
      representation: "sibling_clip",
    });
    expect(out.rowAccounting.served.find((s) => s.id === ids[2])).toEqual({
      id: ids[2],
      representation: "notable_card",
    });
  });

  it("names a row capped off the notable rail instead of dropping it silently", () => {
    // Five windows of ONE moment: owner + 3 rail options; the fifth is beyond
    // `MAX_NOTABLE_ALTERNATIVES_PER_HIGHLIGHT` and has no page representation.
    const starts = [10, 18, 22, 26, 30];
    const list = starts.map((s) => row(`hl-${Math.round(s)}`, jobId, s));
    const out = buildPostableHighlights(list);

    expect(out.notableMoments.moments.length).toBe(1);
    expect(out.notableMoments.moments[0].optionsSuppressed).toBe(1);
    expect(out.rowAccounting.served.length).toBe(4);
    expect(out.rowAccounting.unrepresented.length).toBe(1);
    expect(out.rowAccounting.unrepresented[0].reason).toBe("notable_option_over_rail_cap");
    // No row is ever in two buckets and none is missing from both.
    const all = [...out.rowAccounting.served.map((s) => s.id), ...out.rowAccounting.unrepresented.map((s) => s.id)];
    expect(all.sort()).toEqual(starts.map((s) => `hl-${Math.round(s)}`).sort());
  });

  it("names every gate drop with its reason (never silent)", () => {
    const list = [
      row("hl-goal", jobId, 10, { outcome: "scoring_play", eventType: "GOAL", score: 100, reason: "The ball enters the net." }),
      row("hl-nothl", jobId, 60, { outcome: "not_highlight", eventType: "HIGHLIGHT" }),
      row("hl-near", jobId, 120, { outcome: "near_miss", eventType: "NEAR_MISS" }),
      row("hl-rejected", jobId, 200, { status: "rejected" }),
      row("hl-contra", jobId, 300, { outcome: "scoring_play", eventType: "GOAL", reason: "The ball does not enter the net." }),
    ];
    const out = buildPostableHighlights(list);

    expect(out.rowAccounting.served).toEqual([
      { id: "hl-goal", representation: "card" },
      { id: "hl-near", representation: "notable_card" },
    ]);
    expect(out.rowAccounting.unrepresented).toEqual([
      { id: "hl-contra", reason: "contradicting" },
      { id: "hl-nothl", reason: "not_scoring" },
      { id: "hl-rejected", reason: "rejected" },
    ]);
  });

  it("discloses a deduped row instead of claiming it is served as a card", () => {
    // Two overlapping scoring rows collapse to ONE moment; the loser is still
    // delivered (its clip exists) but has no card of its own — disclosed.
    const list = [
      row("hl-a", jobId, 10, { outcome: "scoring_play", eventType: "GOAL", score: 100, reason: "The ball enters the net." }),
      row("hl-b", jobId, 14, { outcome: "scoring_play", eventType: "GOAL", score: 80, reason: "The ball enters the net." }),
    ];
    const out = buildPostableHighlights(list);
    expect(out.rowAccounting.served).toEqual([{ id: "hl-a", representation: "card" }]);
    expect(out.rowAccounting.unrepresented).toEqual([{ id: "hl-b", reason: "merged_duplicate" }]);
    // ...and the duplicate lane still carries it (nothing lost, nothing doubled).
    expect(out.duplicates.map((d) => d.id)).toEqual(["hl-b"]);
  });

  it("accounts a replay as its owner's alternative, and a missing owner as a gap", () => {
    const list = [
      row("hl-owner", jobId, 100, { outcome: "scoring_play", eventType: "GOAL", reason: "The ball enters the net." }),
      row("hl-replay", jobId, 110, { replayOf: "hl-owner", replayEvidence: { kind: "footage_match", matches: 9, compared: 9, gapS: 10 } }),
      row("hl-orphan", jobId, 400, { replayOf: "hl-gone" }),
    ];
    const out = buildPostableHighlights(list);

    expect(out.rowAccounting.served).toEqual([
      { id: "hl-owner", representation: "card" },
      { id: "hl-replay", representation: "replay_alternative" },
    ]);
    expect(out.rowAccounting.unrepresented).toEqual([{ id: "hl-orphan", reason: "replay_owner_missing" }]);
  });
});

describe("GET /jobs/:id/detail — row accounting is served (AC3)", () => {
  it("the payload states the served set, so no grader has to reconstruct the grouping", async () => {
    const t = await buildTestApp();
    try {
      const u = await register(t.app, "row-accounting-8542@test.local");
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);
      const starts = [182.632, 250.0, 616.063, 620.0];
      const ids: string[] = [];
      for (const s of starts) ids.push(await seed(t, job.id, s));

      const res = await t.app.inject({ method: "GET", url: `/jobs/${job.id}/detail`, headers: auth(u.token) });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // Three cards (the anchor-gap partition), four rows served.
      const cards = body.notableHighlights as any[];
      expect(cards.length).toBe(3);
      const fromCards = cards.flatMap((m) => [m.id, ...(m.siblingClips ?? []).map((o: any) => o.id)]);
      expect(fromCards.sort()).toEqual([...ids].sort());

      // The accounting says exactly that, and nothing is unrepresented.
      expect(body.rowAccounting).toBeTruthy();
      expect(body.rowAccounting.unrepresented).toEqual([]);
      expect(body.rowAccounting.served.map((s: any) => s.id).sort()).toEqual([...ids].sort());
      // A delivered row ids ⊆ served ids — the gradable AC3 identity.
      const servedIds = new Set(body.rowAccounting.served.map((s: any) => s.id));
      expect(ids.every((id) => servedIds.has(id))).toBe(true);

      // The delta read carries the same accounting (an appended refresh cannot
      // hide a row the composite read served).
      const delta = await t.app.inject({
        method: "GET",
        url: `/jobs/${job.id}/sections-delta?afterIndex=-1`,
        headers: auth(u.token),
      });
      expect(delta.statusCode).toBe(200);
      expect(delta.json().rowAccounting).toEqual(body.rowAccounting);
    } finally {
      await t.app.close();
    }
  });
});
