// ADAAAA-8941 (defect 3, integration repair) — the repeat key's CONTRACT scope,
// and ADAAAA-8969 defect 4's title-lane write/gate pair.
//
// Defect 3 was measured on live leg `e4c2fe29-68fe-472c-91da-b96d1dd8ca93`
// (rev-8, `file-sim`, 19 promoted rows): `summaryGate: accepted` 3,
// `dropped:repeat` 16, so a 10-card deck could not be filled. The key that fired
// was the JOB-WIDE opening-run equality (all 16) — every promotion from the one
// decide prompt opens the same way.
//
// ADAAAA-8969 increment 2 briefly exempted rows on different windows from the
// key. Spec rev 16 grades AC8 (shared normalized 4-word opening) and AC14
// (shared sentence at >= 0.80) on the served copy within one job with no instant
// exception, so the exemption was a bar change: these tests pin the contract
// reading, including that the stored rows honestly reproduce 3 served / 16
// `repeat` drops. The deck shortfall is upstream body diversity (ADAAAA-8928).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  gatePostTitleDetail,
  postTitleLabel,
  storedLabelTitle,
  summaryOpeningRun,
  type SummaryEvidence,
} from "@highlights/events";
import { summaryRepeatKey, type SummaryServedBody } from "../src/summary-lane.js";

interface FixtureRow {
  id: string;
  rail: SummaryEvidence["rail"];
  body: string | null;
  raw: string | null;
  windowTs: number | null;
  windowDurationS: number | null;
  scoreTransition: { from: string; to: string } | null;
  matchClock: { token?: string | null } | null;
  verdict: string | null;
  eventType: string | null;
  attestation: { ballOutcome?: string | null; goalCrossed?: boolean | null; scoreBoardChanged?: boolean | null } | null;
  postTitle: string | null;
  postTitleGate: string | null;
}

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../evals/adaaa_8969/live-rail-e4c2fe29.json", import.meta.url)), "utf8")
) as { jobId: string; matchContext: unknown; rows: FixtureRow[] };

const evidenceOf = (row: FixtureRow): SummaryEvidence => ({
  rail: row.rail,
  verdict: row.verdict,
  eventType: row.eventType,
  reason: null,
  caption: null,
  postTitle: row.postTitle,
  windowTs: row.windowTs,
  windowDurationS: row.windowDurationS,
  scoreTransition: row.scoreTransition,
  matchContext: FIXTURE.matchContext,
  transcript: null,
  attestation: row.attestation,
  matchClock: row.matchClock,
});

const bodyOf = (row: FixtureRow): string => (row.body ?? row.raw ?? "").trim();

function servedOf(row: FixtureRow): SummaryServedBody {
  return {
    highlightId: row.id,
    windowTs: row.windowTs,
    windowDurationS: row.windowDurationS,
    clockToken: row.matchClock?.token ?? null,
    body: bodyOf(row),
    opening: null,
  };
}

describe("ADAAAA-8941 defect 3 — the repeat key keeps AC8/AC14 on the job scope", () => {
  it("reproduces the stored census: 3 servable / 16 `repeat` drops on the 19 stored rows", () => {
    // The contract reading of defect 3: the rev-8 key was NOT over-broad. All 19
    // stored bodies come from one decide template, and AC8 (shared 4-word opening)
    // plus AC14 (shared sentence at >= 0.80) are copy bars with no instant
    // exception — so the deck shortfall on these bytes is upstream body diversity,
    // not a missing exception here. 3 served / 16 repeat is the honest number.
    const rows = [...FIXTURE.rows].sort((a, b) => (a.windowTs ?? 0) - (b.windowTs ?? 0));
    const served: SummaryServedBody[] = [];
    const drops: Record<string, number> = {};
    for (const row of rows) {
      const body = bodyOf(row);
      if (!body) continue;
      const verdict = summaryRepeatKey(body, evidenceOf(row), served);
      if (verdict.key !== null) {
        drops[verdict.key] = (drops[verdict.key] ?? 0) + 1;
        continue;
      }
      served.push({ ...servedOf(row), opening: summaryOpeningRun(body) });
    }
    expect(drops).toEqual({ opening: 16 });
    expect(served.length).toBe(3);
  });

  it("refuses a shared opening on a DIFFERENT window (AC8 has no instant exception)", () => {
    const a: SummaryServedBody = {
      highlightId: "a",
      windowTs: 100,
      windowDurationS: 15,
      clockToken: "18:12",
      body: "Barcelona works the ball forward and the scoreboard moves to 2-1 at 18:12.",
      opening: "barcelona works the ball",
    };
    const evidence: SummaryEvidence = {
      rail: "live",
      verdict: "big_play",
      eventType: "BIG_PLAY",
      reason: null,
      caption: null,
      postTitle: null,
      windowTs: 400,
      windowDurationS: 15,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
      attestation: null,
      matchClock: { token: "22:19", seconds: 1339, legible: true },
    };
    const verdict = summaryRepeatKey(
      "Barcelona works the ball wide and the scoreboard moves to 2-1 at 22:19.",
      evidence,
      [a]
    );
    expect(verdict.key).toBe("opening");
    // The instant evidence is still reported for the census.
    expect(verdict.windowOverlapS).toBe(300);
  });

  it("refuses a shared sentence at >= 0.80 on a DIFFERENT window (AC14 template detector)", () => {
    const a: SummaryServedBody = {
      highlightId: "a",
      windowTs: 100,
      windowDurationS: 15,
      clockToken: "18:12",
      body: "Barcelona finds the equaliser at 18:12. The move builds through midfield for Northbridge.",
      opening: "barcelona finds the",
    };
    const evidence: SummaryEvidence = {
      rail: "live",
      verdict: "big_play",
      eventType: "BIG_PLAY",
      reason: null,
      caption: null,
      postTitle: null,
      windowTs: 400,
      windowDurationS: 15,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
      attestation: null,
      matchClock: { token: "22:19", seconds: 1339, legible: true },
    };
    const verdict = summaryRepeatKey(
      "A low drive is blocked at 22:19. The move builds through midfield for Northbridge.",
      evidence,
      [a]
    );
    expect(verdict.key).toBe("sentence");
    expect(verdict.openingRepeat).toBe(false);
    expect(verdict.sentence?.similarity).toBeGreaterThanOrEqual(0.8);
  });

  it("serves a body whose opening run and sentences are both distinct", () => {
    const a: SummaryServedBody = {
      highlightId: "a",
      windowTs: 100,
      windowDurationS: 15,
      clockToken: "18:12",
      body: "Barcelona finds the equaliser at 18:12. Northbridge clears the second ball wide.",
      opening: "barcelona finds the",
    };
    const evidence: SummaryEvidence = {
      rail: "live",
      verdict: "big_play",
      eventType: "BIG_PLAY",
      reason: null,
      caption: null,
      postTitle: null,
      windowTs: 400,
      windowDurationS: 15,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
      attestation: null,
      matchClock: { token: "22:19", seconds: 1339, legible: true },
    };
    const verdict = summaryRepeatKey(
      "A low drive from Riverside is blocked at 22:19. Riverside recycles the ball to the left.",
      evidence,
      [a]
    );
    expect(verdict.key).toBeNull();
  });
});

describe("ADAAAA-8969 defect 4 — an empty title candidate degrades to the row's label", () => {
  it("names the cause and stores the non-asserting label the read projection serves", () => {
    const rows = FIXTURE.rows;
    const used: string[] = [];
    let served = 0;
    for (const row of rows) {
      const decision = gatePostTitleDetail(row.postTitle, undefined, {
        label: postTitleLabel(row.eventType, row.verdict),
      });
      expect(decision.gate).toBe("label:empty");
      const composed = storedLabelTitle({ label: decision.title as string, windowTs: row.windowTs ?? 0, used });
      expect(composed.title).not.toBeNull();
      used.push(composed.title as string);
      served += 1;
    }
    expect(served).toBe(rows.length);
    expect(used.every((title) => /·\s*\d{1,3}:\d{2}$/.test(title))).toBe(true);
  });

  it("still reports `absent` when the caller has no label for the row", () => {
    expect(gatePostTitleDetail(null, undefined)).toEqual({ title: null, gate: "absent", violations: ["empty"] });
  });
});
