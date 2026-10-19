import { describe, it, expect } from "vitest";
import { deriveHighlightTrigger } from "../src/analyzer";

describe("per-highlight trigger metadata (ADAAAA-6798 Inc 2)", () => {
  it("deriveHighlightTrigger maps an audio burst candidate to audio_burst", () => {
    const t = deriveHighlightTrigger({ eventType: "GOAL", timestamp: 3.2, audio: { kind: "burst", peakEnergy: 0.8 } } as any);
    expect(t.kind).toBe("audio_burst");
    expect(t.timestamp).toBe(3.2);
    expect(t.eventType).toBe("GOAL");
    expect(t.audioKind).toBe("burst");
  });

  it("maps goal-line crossing + scoreboard change to corroborated", () => {
    const t = deriveHighlightTrigger({ eventType: "GOAL", timestamp: 5, goalCrossed: true, scoreBoardChanged: true } as any);
    expect(t.kind).toBe("corroborated");
    expect(t.goalCrossed).toBe(true);
    expect(t.scoreBoardChanged).toBe(true);
  });

  it("maps a ball-velocity signal to ball_signal", () => {
    const t = deriveHighlightTrigger({ eventType: "X", timestamp: 2, ballVelocity: { speedMps: 9 } } as any);
    expect(t.kind).toBe("ball_signal");
    expect(t.ballSpeedMps).toBe(9);
  });

  it("maps a candidate with no signal to motion", () => {
    const t = deriveHighlightTrigger({ eventType: "DUNK", timestamp: 1 } as any);
    expect(t.kind).toBe("motion");
  });
});
