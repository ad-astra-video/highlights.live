// ADAAAA-8647 clause 4 — a promoted DEAD-LANE row discloses the basis it was
// promoted on, on the served payload.
//
// `live-confirm-async.ts` promotes a dive-confirmed row past the ADAAAA-8239 hold
// when its window's score lane produced NO samples at all, and stamps
// `confirmAttestation.promotionBasis` + `confirmAttestation.scoreLane` so the
// promotion is gradable from the row alone (ADAAAA-8542). Both keys were written
// but NOT declared in `HighlightRecordSchema.confirmAttestation`, so the schema
// parse inside the one verdict-move writer (`store.updateHighlight`) stripped them
// on persist — no stored row and no page could report the basis, and a grader
// querying for it could only ever find nothing.
//
// The adoption patch is pinned in `live-confirm-dead-score-lane-8542.test.ts` and
// the schema round-trip in `highlight-postable.test.ts`. Neither covers the seam
// clause 4 actually asks about: a row that went through the WRITE path and is then
// served by `GET /jobs/:id/detail`. This test closes that seam end to end —
// provisional row → verdict-move patch → store → route → served card — so a future
// schema change that re-strips either key fails here instead of silently on a live
// job, and so a served card can name the basis a grader needs.
import { describe, expect, it } from "vitest";
import { HighlightRecordSchema } from "@highlights/events";
import { buildTestApp } from "./helpers";

const BASIS = "frame_attestation_over_unread_score_lane";
const LANE = { scoreReads: 0, preSamples: 0, postSamples: 0, need: 2 };

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

/** The PROVISIONAL row as the accept path stores it: a scoring GOAL accepted with
 *  no measured attestation and no dive verdict yet. */
function provisionalRow(ownerId: string, jobId: string, over: Record<string, unknown> = {}) {
  return HighlightRecordSchema.parse({
    ownerId,
    jobId,
    start: 210,
    end: 225,
    clipUri: `/clips/${jobId}-210.mp4`,
    eventType: "GOAL",
    score: 88,
    reason: "A striker finishes low past the keeper and the net moves.",
    outcome: "scoring_play",
    status: "accepted",
    createdAt: "2026-11-11T00:00:00.000Z",
    attestationUsed: {
      scoreBoardChanged: false,
      goalCrossed: false,
      ballOutcome: null,
      corroborated: false,
      goalConfirmed: null,
      scoreReads: 0,
      preSamples: 0,
      postSamples: 0,
      need: 2,
    },
    ...over,
  });
}

describe("ADAAAA-8647 clause 4 — a dead-lane promotion discloses its basis on the served card", () => {
  it("carries promotionBasis + scoreLane through the verdict-move writer into GET /jobs/:id/detail", async () => {
    const t = await buildTestApp();
    try {
      const adminLogin = await t.app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "admin@test.local", password: "adminpass" },
      });
      expect(adminLogin.statusCode).toBe(200);
      const u = { token: adminLogin.json().token as string, id: adminLogin.json().user.id as string };
      const job = await (t.store.createJob({ ownerId: u.id, source: "browser", gameHint: "soccer" } as any) as any);

      const id = "hl-promoted-dead-lane";
      await t.store.addHighlight(provisionalRow(u.id, job.id, { id }));

      // THE WRITE PATH: the same single verdict-move writer the async confirm lane
      // uses, with the patch shape `confirmDiveAdoption` returns for a dead lane.
      await t.store.patchHighlight(id, {
        outcome: "scoring_play",
        eventType: "GOAL",
        provisionalGoal: undefined,
        pendingConfirmDive: undefined,
        confirmAttestation: {
          goalConfirmed: "confirmed_goal",
          corroborated: true,
          corroborationSource: "frame_attestation",
          diveAt: "2026-11-11T00:00:12.000Z",
          diveLatencyMs: 12000,
          contextDegraded: [],
          promotionBasis: BASIS,
          scoreLane: LANE,
        },
      } as any);

      // The writer parses through the stored schema — before ADAAAA-8647 both
      // keys were stripped here, which is why no stored row could report them.
      const stored = t.store.highlightsForJob(job.id).find((h) => h.id === id) as any;
      expect(stored, "the row persisted").toBeDefined();
      expect(stored.confirmAttestation.promotionBasis).toBe(BASIS);
      expect(stored.confirmAttestation.scoreLane).toEqual(LANE);

      const res = await t.app.inject({
        method: "GET",
        url: `/jobs/${job.id}/detail`,
        headers: auth(u.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      // A promoted row is a POSTABLE card, so it is served on highlights[].
      const served = (body.highlights as any[]).find((h) => h.id === id);
      expect(served, "the promoted row is served as a card").toBeDefined();
      expect(served.outcome).toBe("scoring_play");
      expect(served.eventType).toBe("GOAL");
      // The promotion was carried by the dive, and the served lane says so.
      expect(served.confirmation?.lane).toBe("dive");
      // …and the basis it was promoted on survives the round-trip. This is the
      // assertion that was unreachable before the schema declared the keys.
      expect(served.confirmAttestation?.promotionBasis).toBe(BASIS);
      expect(served.confirmAttestation?.scoreLane).toEqual(LANE);
    } finally {
      await t.app.close();
    }
  });
});
