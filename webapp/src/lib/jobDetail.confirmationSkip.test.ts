import { describe, it, expect } from "vitest";
import { confirmationBadge, confirmationSkipText, type JobDetailHighlight } from "./jobDetail";

// ADAAAA-8721 (D3): a card with no dive badge now names WHY no Stage-2 dive ran,
// in operator language, from the server's derived `confirmation.skipReason`. The
// copy must never fire for a dive that ran (a verdict is its own answer) and must
// never invent a reason when the payload carries none.

function hl(confirmation?: JobDetailHighlight["confirmation"]): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 10,
    end: 25,
    eventType: "BIG_PLAY",
    score: 60,
    status: "accepted",
    createdAt: "2026-11-10T00:00:00Z",
    ...(confirmation ? { confirmation } : {}),
  };
}

describe("confirmationSkipText — every skip names its own case", () => {
  it("names the measured-attestation skip", () => {
    const text = confirmationSkipText(
      hl({ lane: "measured", label: "Confirmed by measured score change", skipReason: "measured_attestation" })
    );
    expect(text).toBe("No deep dive: this window already measured its own evidence");
  });

  it("names the not-goal-shaped skip", () => {
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x", skipReason: "not_goal_shaped" }))).toBe(
      "No deep dive: not goal-shaped"
    );
  });

  it("names the disabled lane", () => {
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x", skipReason: "dive_disabled" }))).toBe(
      "No deep dive: dive lane disabled"
    );
  });

  it("names a dropped dive's stored cause in words", () => {
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x", skipReason: "dropped:pool_busy" }))).toBe(
      "No deep dive: dropped (dive pool was busy)"
    );
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x", skipReason: "dropped:budget" }))).toBe(
      "No deep dive: dropped (dive budget was spent)"
    );
  });

  it("falls back to the readable cause for an unmapped drop reason, never to nothing", () => {
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x", skipReason: "dropped:weird_cause" }))).toBe(
      "No deep dive: dropped (weird cause)"
    );
  });

  it("says nothing when a dive ran (it has its own answer)", () => {
    expect(confirmationSkipText(hl({ lane: "dive", label: "Confirmed by deep dive (Stage-2)" }))).toBeNull();
    expect(confirmationSkipText(hl({ lane: "dive_disagreed", label: "dive did not corroborate" }))).toBeNull();
    expect(confirmationSkipText(hl({ lane: "dive_held", label: "held" }))).toBeNull();
  });

  it("says nothing when the payload carries no derived confirmation", () => {
    expect(confirmationSkipText(hl())).toBeNull();
    expect(confirmationSkipText(hl({ lane: "unconfirmed", label: "x" }))).toBeNull();
  });

  it("never changes the ONE badge (the reason is detail text, not badge copy)", () => {
    const row = hl({ lane: "unconfirmed", label: "x", skipReason: "dive_disabled" });
    expect(confirmationBadge(row)).toEqual({ lane: "unconfirmed", confirmed: false, text: "UNCONFIRMED" });
    expect(confirmationSkipText(row)).toContain("dive lane disabled");
  });
});
