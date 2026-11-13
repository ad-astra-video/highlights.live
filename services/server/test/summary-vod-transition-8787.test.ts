// ADAAAA-8787: the summary lane's FACT MENU must read the transition the row
// actually persists.
//
// Measured defect (rev-5 VOD re-grade, job `a200d2bd`, row `48fe4280`): the lane
// built `scoreTransition` from `row.deferredAttestation.scoreboardDelta` alone —
// a shape no persisted row carries — so the menu was `[clock, action]` and a
// promoted VOD row whose verbs register no `action` fact was refused
// `too-few-facts` on its one deterministic call. The VOD row stores its measured
// transition in `attestationUsed.transitionScore` (`{pre:[1,1],post:[2,1]}`) and
// a live deferred promotion stores `deferredAttestation.pre/post`.
//
// These tests pin, in order: the repaired VOD evidence, the pre-fix refusal it
// caused, every other disclosed transition source, the live path's precedence
// (no regression), and the two grounding bars that must NOT widen (score and
// clock) so a body can never earn a fact the row does not attest.
import { describe, expect, it } from "vitest";
import { summaryEvidenceForRow } from "../src/summary-lane.js";
import { attestedSummaryFactKinds, gateSummaryDetail } from "@highlights/events";

// The stored reply of job `a200d2bd` row `48fe4280` (44 words / 4 sentences),
// verbatim from `highlights.record->>'summaryRaw'` — the row the gate dropped.
const VOD_ROW_48FE4280_REPLY =
  "Real Madrid takes the lead in this intense match against Barcelona. The scoreboard updates from 1-1 to 2-1 at the 0:27 mark of the clip. A player in a white kit celebrates the successful scoring play. This goal shifts the momentum during the competition.";

// ADAAAA-8910: the same row's reply with the two clauses the row cannot attest
// removed — the scoreboard LINE instead of the scoring side, and no competition.
// Same facts (score + clock + the attested team's play), 51 words / 3 sentences.
const VOD_ROW_48FE4280_REPLY_REPAIRED =
  "The scoreboard updates from 1-1 to 2-1 at the 0:27 mark of the clip as Real Madrid works the ball through the middle. A player in a white kit celebrates the successful scoring play near the touchline. The restart comes quickly as both sides reset their shape for the next phase.";

// The job's folded `matchContext` (one resolved team, away = Barcelona).
const JOB_MATCH_CONTEXT = {
  sport: "soccer",
  teams: [{ name: "Barcelona", side: "away", kitColors: [], confidence: 0.85 }],
  ambiguous: false,
  resolverVersion: 1,
};

/** The stored row, shaped exactly as `highlights.record` persists it. */
const vodRow = (overrides: Record<string, unknown> = {}) => ({
  id: "48fe4280-b0c3-44b3-a909-fda77d5cc99e",
  status: "accepted",
  eventType: "GOAL",
  outcome: "scoring_play",
  verdict: null,
  start: 20,
  end: 35,
  trigger: { kind: "score_change", eventType: "SPORTING_EVENT", timestamp: 27, scoreBoardChanged: true },
  deferredAttestation: null,
  attestationUsed: {
    authority: "scoreboard",
    ballOutcome: null,
    goalCrossed: false,
    corroborated: false,
    goalConfirmed: null,
    transitionKey: "1-1>2-1",
    transitionScore: { pre: [1, 1], post: [2, 1] },
    scoreBoardChanged: true,
  },
  // The stored `reason` verbatim: it carries the row's own grounding context, so
  // its names ("Real Madrid") are attested exactly as the served gate saw them.
  reason:
    "The scoreboard changes from 1-1 to 2-1 at 18:06, and the ASR confirms 'Acaba de marcar el Real Madrid' while the frames show a player in a white kit (Real Madrid) celebrating.; scoreboard score change confirmed",
  caption: null,
  postTitle: null,
  asrTranscript: null,
  matchContext: JOB_MATCH_CONTEXT,
  ...overrides,
});

describe("ADAAAA-8787 — a VOD row's disclosed transition reaches the summary evidence", () => {
  it("maps attestationUsed.transitionScore to the evidence pair", () => {
    const ev = summaryEvidenceForRow(vodRow(), "vod");
    expect(ev.scoreTransition).toEqual({ from: "1-1", to: "2-1" });
    expect(ev.windowTs).toBe(27);
  });

  it("serves the disclosed transition in the fact menu (ADAAAA-8910 repairs the reply's two false clauses)", () => {
    const ev = summaryEvidenceForRow(vodRow(), "vod");
    // The measured fact shape from the ticket's own replay: score + clock. The
    // transition the row persists is what makes the score line a fact.
    expect(attestedSummaryFactKinds(VOD_ROW_48FE4280_REPLY, ev)).toEqual(["score", "clock"]);
    // ADAAAA-8910: the STORED reply also asserted the scoring side ("Real Madrid
    // takes the lead") and a competition the match context cannot carry, so it is
    // refused on truth grounds — with the same menu in front of it, the repaired
    // reply serves, which is what this ticket's transition fix was for.
    const stored = gateSummaryDetail(VOD_ROW_48FE4280_REPLY, ev);
    expect(stored.summary).toBeFalsy();
    expect(stored.violations).toEqual(["unattested-venue", "unattested-side"]);
    const decision = gateSummaryDetail(VOD_ROW_48FE4280_REPLY_REPAIRED, ev);
    expect(decision.violations).toEqual([]);
    expect(decision.gate).toBe("accepted");
    // VOD value bar: the served body is inside the 45-55 word target band.
    expect(decision.words).toBe(51);
    expect(decision.sentences).toBe(3);
  });

  it("is the fact menu that caused the drop: without the transition the same reply refuses", () => {
    // Pre-fix shape: neither disclosed transition source present.
    const bare = vodRow({ attestationUsed: { ...vodRow().attestationUsed, transitionScore: undefined, transitionKey: null } });
    const ev = summaryEvidenceForRow(bare, "vod");
    expect(ev.scoreTransition).toBeNull();
    const decision = gateSummaryDetail(VOD_ROW_48FE4280_REPLY, ev);
    // ADAAAA-8910 adds its truth bars to whatever else the body earns, so the
    // fact-density refusal is asserted directly rather than by gate-string equality.
    expect(decision.violations).toContain("too-few-facts");
    expect(attestedSummaryFactKinds(VOD_ROW_48FE4280_REPLY, ev)).toEqual(["clock"]);
  });
});

describe("ADAAAA-8787 — every disclosed transition source, most explicit first", () => {
  it("keeps the live rail's scoreboardDelta path (no regression, and it wins)", () => {
    const ev = summaryEvidenceForRow(
      {
        ...vodRow(),
        deferredAttestation: { deltaTs: 161, readAt: 165, windowLo: 150, windowHi: 160, scoreboardDelta: { from: "1-2", to: "2-2" } },
      },
      "live"
    );
    expect(ev.scoreTransition).toEqual({ from: "1-2", to: "2-2" });
  });

  it("reads the tuple pair a live deferred promotion actually persists", () => {
    const ev = summaryEvidenceForRow(
      {
        ...vodRow({ attestationUsed: undefined }),
        deferredAttestation: { deltaTs: 109, readAt: 115, windowLo: 90, windowHi: 100, pre: [1, 1], post: [2, 1] },
      },
      "live"
    );
    expect(ev.scoreTransition).toEqual({ from: "1-1", to: "2-1" });
  });

  it("prefers attestationUsed.transitionScore over the legacy key", () => {
    const ev = summaryEvidenceForRow(
      vodRow({ attestationUsed: { ...vodRow().attestationUsed, transitionScore: { pre: [2, 1], post: [2, 2] } } }),
      "vod"
    );
    expect(ev.scoreTransition).toEqual({ from: "2-1", to: "2-2" });
  });

  it("falls back to a legacy transitionKey only when no pair is stored", () => {
    const ev = summaryEvidenceForRow(
      vodRow({ attestationUsed: { ...vodRow().attestationUsed, transitionScore: undefined } }),
      "vod"
    );
    expect(ev.scoreTransition).toEqual({ from: "1-1", to: "2-1" });
  });

  it("invents nothing from a malformed pair", () => {
    for (const bad of [
      { pre: [1], post: [2, 1] },
      { pre: [1, 1], post: [2] },
      { pre: [-1, 1], post: [2, 1] },
      { pre: [1.5, 1], post: [2, 1] },
    ]) {
      const ev = summaryEvidenceForRow(
        vodRow({ attestationUsed: { ...vodRow().attestationUsed, transitionScore: bad, transitionKey: null } }),
        "vod"
      );
      expect(ev.scoreTransition).toBeNull();
    }
    expect(summaryEvidenceForRow(vodRow({ attestationUsed: undefined, deferredAttestation: null }), "vod").scoreTransition).toBeNull();
  });
});

describe("ADAAAA-8787 — the fix does not widen score or clock grounding", () => {
  it("never credits a score line the row does not attest", () => {
    const reply =
      "Real Madrid takes the lead in this intense match against Barcelona. The scoreboard reads 3-1 at the 0:27 mark of the clip. A player in a white kit celebrates the successful scoring play.";
    const ev = summaryEvidenceForRow(vodRow(), "vod");
    expect(attestedSummaryFactKinds(reply, ev)).not.toContain("score");
  });

  it("never credits a match clock outside the window anchor tolerance", () => {
    const reply =
      "Real Madrid takes the lead in this intense match against Barcelona. The scoreboard updates from 1-1 to 2-1 at the 18:06 mark of the match. A player in a white kit celebrates.";
    const ev = summaryEvidenceForRow(vodRow(), "vod");
    expect(attestedSummaryFactKinds(reply, ev)).not.toContain("clock");
  });
});
