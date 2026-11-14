// ADAAAA-8969 (increment 2) — the repeat key's SCOPE, and the title lane's
// empty-candidate degrade.
//
// Defect 3 was measured on live leg `e4c2fe29-68fe-472c-91da-b96d1dd8ca93`
// (rev-8, `file-sim`, 19 promoted rows): `summaryGate: accepted` 3,
// `dropped:repeat` 16, so a 10-card deck could not be filled. The key that fired
// was the JOB-WIDE opening-run equality (all 16) — every promotion from the one
// decide prompt opens the same way.
//
// These tests pin the scoped key on the real fixture plus the degenerate shapes
// the scope must still refuse, and pin defect 4's write/gate pair.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gatePostTitleDetail, postTitleLabel, storedLabelTitle, type SummaryEvidence } from "@highlights/events";
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

describe("ADAAAA-8969 defect 3 — the repeat key is scoped to the same promotion", () => {
  it("serves >= 10 of the 19 stored rev-8 rows (the deck bar), vs 3 under the old key", () => {
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
      served.push({ ...servedOf(row), opening: verdict.openingRepeat ? null : null });
    }
    // The stored census is 3 servable / 16 repeat drops; the scoped key must clear
    // the 10-card bar on the same bytes.
    expect(served.length).toBeGreaterThanOrEqual(10);
    // The measured residual is ONE row: `1270bc8d` shares `18:00`'s clock token
    // with a nearer neighbour, so the scoped key still refuses it (the census in
    // `evals/adaaa_8969/replay8969.ts` prints the pair).
    expect(served.length).toBe(18);
    expect(drops).toEqual({ "same-clock": 1 });
    expect(FIXTURE.rows.filter((r) => r.postTitleGate === "absent")).toHaveLength(19);
  });

  it("refuses the same window even when the words differ (one card per moment)", () => {
    const a = {
      highlightId: "a",
      windowTs: 100,
      windowDurationS: 15,
      clockToken: "18:12",
      body: "Barcelona works the ball forward and the scoreboard moves to 2-1 at 18:12.",
      opening: "barcelona works the",
    };
    const evidence: SummaryEvidence = {
      rail: "live",
      verdict: "big_play",
      eventType: "BIG_PLAY",
      reason: null,
      caption: null,
      postTitle: null,
      windowTs: 104,
      windowDurationS: 15,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
      attestation: null,
      matchClock: { token: "18:12", seconds: 1092, legible: true },
    };
    const verdict = summaryRepeatKey(
      "A low drive from Barcelona is blocked at the edge of the box and recycled wide.",
      evidence,
      [a]
    );
    expect(verdict.key).toBe("same-window");
  });

  it("refuses the same clock token with near-identical text on a different window", () => {
    const a = {
      highlightId: "a",
      windowTs: 100,
      windowDurationS: 15,
      clockToken: "18:12",
      body: "Barcelona works the ball forward and the scoreboard moves to 2-1 at 18:12.",
      opening: "barcelona works the",
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
      matchClock: { token: "18:12", seconds: 1092, legible: true },
    };
    const verdict = summaryRepeatKey(
      "Barcelona works the ball forward and the scoreboard moves to 2-1 at 18:12 in this clip.",
      evidence,
      [a]
    );
    expect(verdict.key).toBe("same-clock");
  });

  it("refuses a near-identical body when no instant tells the two apart", () => {
    const body = "Barcelona maintains possession and works the ball forward during the build-up phase.";
    const a = { highlightId: "a", windowTs: null, windowDurationS: null, clockToken: null, body, opening: null };
    const evidence: SummaryEvidence = {
      rail: "live",
      verdict: "big_play",
      eventType: "BIG_PLAY",
      reason: null,
      caption: null,
      postTitle: null,
      windowTs: null,
      windowDurationS: null,
      scoreTransition: null,
      matchContext: null,
      transcript: null,
      attestation: null,
      matchClock: null,
    };
    expect(summaryRepeatKey(body, evidence, [a]).key).toBe("near-identical-body");
  });

  it("serves the same text on two DIFFERENT instants (a differing instant is evidence of a different promotion)", () => {
    const body = "Barcelona maintains possession and works the ball forward during the build-up phase.";
    const a = { highlightId: "a", windowTs: 100, windowDurationS: 15, clockToken: "18:12", body, opening: null };
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
    expect(summaryRepeatKey(body, evidence, [a]).key).toBeNull();
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
