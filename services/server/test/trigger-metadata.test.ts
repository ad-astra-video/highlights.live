import { describe, it, expect } from "vitest";
import {
  LiveRunShared,
  decideOnCandidate,
  deriveHighlightTrigger,
  type PipelineClient,
} from "../src/analyzer";

function client(decide: PipelineClient["decide"]): PipelineClient {
  return { decide } as any;
}
const baseCfg: any = { jobId: "j", clipBeforeS: 4, clipAfterS: 4, gameHint: "soccer" };

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

  it("an accepted highlight carries candidateId + trigger matching its candidate (0 drift)", async () => {
    const d = client(async () => ({ isHighlight: true, score: 80, eventType: "GOAL" }));
    const shared = new LiveRunShared();
    shared.addFrame(3, 3, "img3");
    const events: any[] = [];
    const notes: any[] = [];
    const cfg = { ...baseCfg, onDecision: (c: any) => notes.push(c) };
    await decideOnCandidate(
      d, shared, async () => ({ clipId: "c", clipUri: "u" }), cfg,
      { eventType: "AUDIO", timestamp: 3, seq: 3, audio: { kind: "burst", ts: 3, firedAt: 3, onsetLatencyS: 0.2, peakEnergy: 0.9, baselineEnergy: 0.1 } },
      (ev) => events.push(ev), { seq: 3, timestamp: 3 }
    );
    expect(shared.highlights).toHaveLength(1);
    const h = shared.highlights[0];
    expect(h.candidateId).toBeTruthy();
    expect(h.trigger?.kind).toBe("audio_burst");
    expect(h.trigger?.timestamp).toBe(3);
    // The persisted JobCandidate carries the SAME trigger + candidateId (0 drift).
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(h.candidateId);
    expect(notes[0].trigger).toEqual(h.trigger);
  });

  it("a rejected candidate persists a note with its trigger and creates no highlight", async () => {
    const d = client(async () => ({ isHighlight: false, score: 20 }));
    const shared = new LiveRunShared();
    shared.addFrame(1, 1, "img1");
    const notes: any[] = [];
    const cfg = { ...baseCfg, onDecision: (c: any) => notes.push(c) };
    await decideOnCandidate(
      d, shared, async () => ({ clipId: "c", clipUri: "u" }), cfg,
      { eventType: "KILL", timestamp: 1, seq: 1, scoreBoardChanged: true },
      undefined, { seq: 1, timestamp: 1 }
    );
    expect(shared.highlights).toHaveLength(0);
    expect(notes).toHaveLength(1);
    expect(notes[0].status).toBe("rejected");
    expect(notes[0].trigger?.kind).toBe("score_change");
    expect(notes[0].trigger?.timestamp).toBe(1);
  });
});
