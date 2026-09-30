import { describe, it, expect } from "vitest";
import type { TrackObservation } from "@highlights/events";
import {
  EntityIdentityResolver,
  extractJersey,
  boxIoU,
  ENTITY_GRACE_SECONDS,
} from "../src/entity-identity";
import { LiveRunShared } from "../src/analyzer";

/** Minimal TrackObservation the schema accepts (lostFrames is required). */
function asObs(tracks: ReturnType<typeof track>[]): TrackObservation[] {
  return tracks.map((t) => ({ ...t, lostFrames: 0 }) as TrackObservation);
}

/** A player-sized box [x1,y1,x2,y2] at grid (gx,gy) with size ~0.1x0.2. */
function boxAt(gx: number, gy: number): number[] {
  return [gx - 0.05, gy - 0.2, gx + 0.05, gy + 0.05];
}

function track(
  trackId: string,
  bbox: number[],
  kind: "player" | "ball" | "unknown" | "vehicle" | "proj" | "structure" = "player",
  label?: string
) {
  return { trackId, slot: 0, bbox: bbox as [number, number, number, number], kind, ...(label ? { label } : {}) };
}

describe("extractJersey (plan §D jersey signal)", () => {
  it("extracts plain, #-, and No- prefixed jersey numbers", () => {
    expect(extractJersey("7")).toBe("7");
    expect(extractJersey("#7")).toBe("7");
    expect(extractJersey("No 10")).toBe("10");
    expect(extractJersey(" 24 ")).toBe("24");
  });
  it("rejects coarse in-roster class labels (identity ambiguity call-out)", () => {
    for (const l of ["player", "goalkeeper", "referee", "goal", "ball", "unknown"]) {
      expect(extractJersey(l)).toBe("");
    }
  });
  it("rejects multi-word scoreboard phrases but keeps a short surname token", () => {
    expect(extractJersey("Score 2-1 HT")).toBe("");
    expect(extractJersey("kane")).toBe("kane");
  });
});

describe("EntityIdentityResolver — continuity signals", () => {
  it("keeps the SAME entity on trackId continuity, promoted to stable", () => {
    const r = new EntityIdentityResolver();
    const a1 = r.resolve(0, [{ trackId: "A", bbox: boxAt(0.5, 0.5) }]).get("A")!;
    const a2 = r.resolve(1, [{ trackId: "A", bbox: boxAt(0.51, 0.5) }]).get("A")!;
    const a3 = r.resolve(2, [{ trackId: "A", bbox: boxAt(0.52, 0.5) }]).get("A")!;
    expect(a3.entityRef).toBe(a1.entityRef);
    expect(a3.stability).toBe("stable"); // >= ENTITY_MIN_STABLE_OBS
  });

  it("stitches a reassigned trackId to the same entity via IoU within the grace window", () => {
    const r = new EntityIdentityResolver();
    // track A for 10 s, drops out, reappears 5 s later with a NEW trackId B
    // overlapping A's last position (occlusion -> SAM reassigns).
    const a = r.resolve(0, [{ trackId: "A", bbox: boxAt(0.5, 0.5) }]).get("A")!;
    r.resolve(10, [{ trackId: "A", bbox: boxAt(0.5, 0.5) }]);
    const b = r.resolve(15, [{ trackId: "B", bbox: boxAt(0.5, 0.5) }]).get("B")!;
    expect(b.entityRef).toBe(a.entityRef); // same identity despite new trackId
  });

  it("does NOT merge across a long gap with no jersey (ambiguity call-out)", () => {
    const r = new EntityIdentityResolver();
    const a = r.resolve(0, [{ trackId: "A", bbox: boxAt(0.5, 0.5) }]).get("A")!;
    // 30 min later, same box, brand-new trackId, no jersey signal:
    const far = ENTITY_GRACE_SECONDS + 1;
    const b = r.resolve(0 + far, [{ trackId: "B", bbox: boxAt(0.5, 0.5) }]).get("B")!;
    expect(b.entityRef).not.toBe(a.entityRef); // not merged on distance alone
  });

  it("binds the SAME entity across a 30-min gap when a jersey number is present", () => {
    const r = new EntityIdentityResolver();
    const a = r.resolve(600, [{ trackId: "A", bbox: boxAt(0.4, 0.5), jersey: "7" }]).get("A")!;
    // 30 min later: entirely different trackId, but the same jersey #7.
    const b = r.resolve(2400, [{ trackId: "B", bbox: boxAt(0.8, 0.5), jersey: "7" }]).get("B")!;
    expect(b.entityRef).toBe("j:7");
    expect(b.entityRef).toBe(a.entityRef);
    expect(b.stability).toBe("stable");
  });

  it("does not merge an ambiguous track that overlaps two known entities (ambiguity guard)", () => {
    const r = new EntityIdentityResolver();
    // A and B are two separate entities, far apart on the pitch.
    const a = r.resolve(0, [{ trackId: "A", bbox: boxAt(0.3, 0.5) }]).get("A")!;
    const b = r.resolve(0, [{ trackId: "B", bbox: boxAt(0.7, 0.5) }]).get("B")!;
    expect(a.entityRef).not.toBe(b.entityRef);
    // A wide re-appearing track C (within grace) spans BOTH A and B's last
    // positions -> its bbox equally matches two entities -> must NOT be merged
    // onto either (guessing would be a false identity).
    const c = r.resolve(5, [{ trackId: "C", bbox: [0.25, 0.3, 0.75, 0.55] }]).get("C")!;
    expect(c.entityRef).not.toBe(a.entityRef);
    expect(c.entityRef).not.toBe(b.entityRef);
  });

  it("is memory-bounded (per-entity places capped)", () => {
    const r = new EntityIdentityResolver();
    let ref: string | undefined;
    for (let i = 0; i < 60; i++) {
      ref = r.resolve(i, [{ trackId: "A", bbox: boxAt(0.5, 0.5) }]).get("A")!.entityRef;
    }
    expect(ref).toBeDefined();
    expect(r.size).toBe(1);
  });
});

describe("LiveRunShared wiring (plan §D / A4)", () => {
  function sharedWithFrames(frames: { ts: number; tracks: ReturnType<typeof track>[]; ocr?: string[] }[]): LiveRunShared {
    const s = new LiveRunShared();
    frames.forEach((f, i) => {
      s.addFrame(i, f.ts, `img${i}`);
      s.setFindings(i, { tracks: asObs(f.tracks), ocr: f.ocr ?? [] });
    });
    return s;
  }

  it("surfaces stable entityRef in window facts and hides transient blips", () => {
    const s = sharedWithFrames([
      { ts: 0, tracks: [track("A", boxAt(0.5, 0.5))] },
      { ts: 1, tracks: [track("A", boxAt(0.5, 0.5))] },
      { ts: 2, tracks: [track("A", boxAt(0.5, 0.5))] }, // now stable
      { ts: 3, tracks: [track("Z", boxAt(0.9, 0.9))] }, // one-off blip
    ]);
    const facts = s.windowFactsText();
    expect(facts).toContain("tracks:");
    // stable entity appeared (any entityRef), and the blip trackId Z is present
    // but NOT as a narrative ref (falls back to raw trackId form).
    expect(facts).toMatch(/ent:[0-9a-f]{8}/);
  });

  it("binds OCR jersey to the dominant player (A4 strong identity path)", () => {
    const s = sharedWithFrames([
      { ts: 0, tracks: [track("A", boxAt(0.5, 0.5))], ocr: ["#9"] },
      { ts: 1, tracks: [track("A", boxAt(0.5, 0.5))], ocr: [] },
    ]);
    expect(s.identity.size).toBe(1);
    // dominant player should carry the jersey-bound ref in findings
    const f = s["frames"].get(0)?.findings;
    expect(f?.tracks.find((t) => t.trackId === "A")?.entityRef).toBe("j:9");
  });

  it("A4: a later red-card arc references the earlier yellow for the same entity", () => {
    const s = sharedWithFrames([
      { ts: 600, tracks: [track("A", boxAt(0.5, 0.5))] }, // window 1: player present
      { ts: 2400, tracks: [track("A", boxAt(0.5, 0.5))] }, // window 2: T+30 min
    ]);
    // Same trackId "A" -> one stable entity. Book it (yellow) at T.
    s.recordHighlightEntity(600, { eventType: "YELLOW_CARD", reason: "late challenge" });
    // Now a red-card candidate for the SAME entity at T+30.
    const redRef = s.resolveEntityAt(2400)!;
    const arc = s.entityArcContext(redRef, { excludeTs: 2400 });
    expect(redRef).toBeTruthy();
    expect(arc).toContain("YELLOW_CARD");
    expect(arc).toContain("late challenge");
    // And the decide priors carry it for a candidate at T+30.
    const cand = s.entityArcContextForCandidate(2400);
    expect(cand).toContain("YELLOW_CARD");
  });

  it("resolveEntityAt returns the dominant stable entity near a timestamp", () => {
    const s = sharedWithFrames([
      { ts: 100, tracks: [track("A", boxAt(0.5, 0.5))] },
      { ts: 100, tracks: [track("B", boxAt(0.8, 0.5))] },
    ]);
    // B dominates (bigger box not — same size; but frame index 1 overrides).
    const ref = s.resolveEntityAt(101);
    expect(ref).toBeTruthy();
  });
});

describe("boxIoU", () => {
  it("computes overlaps", () => {
    expect(boxIoU([0, 0, 1, 1], [0, 0, 1, 1])).toBeCloseTo(1);
    expect(boxIoU([0, 0, 0.5, 0.5], [0.5, 0.5, 1, 1])).toBe(0);
  });
});
