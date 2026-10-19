import { describe, it, expect } from "vitest";
import {
  assembleObserveWindow,
  buildObservePayload,
  type ObserveDecidePayload,
  type PerFrameSeed,
} from "../src/observe-loop";
import { applyObserveRecall } from "../src/analyzer";

/** Build a synthetic VOD frame timeline at `fps` over [0, durationS). */
function timeline(fps: number, durationS: number): { ts: number; imageB64: string }[] {
  const out: { ts: number; imageB64: string }[] = [];
  for (let i = 0; i < durationS * fps; i++) {
    const ts = i / fps;
    out.push({ ts, imageB64: `frame@${ts.toFixed(3)}` });
  }
  return out;
}

function basePayload(): ObserveDecidePayload {
  const win = assembleObserveWindow(timeline(2, 30), 15, { windowS: 10, maxFrames: 30, fps: 2 });
  return buildObservePayload(win, new Map(), []);
}

describe("applyObserveRecall (ADAAAA-7008 / ADAAAA-7012 server recall-wiring)", () => {
  it("folds freshly recalled perceive context into the payload (refresh)", async () => {
    const payload = basePayload();
    const received: number[] = [];
    const refreshed = await applyObserveRecall(payload, async (centerTs) => {
      received.push(centerTs);
      return { centerTs, seeds: [{ ts: 15, ocr: ["2 - 0"], objects: [{ label: "ball" }] }] };
    });
    expect(received).toEqual([payload.centerTs]); // recall targets the moment
    expect(refreshed).not.toBe(payload); // a NEW payload object after refresh
    const at15 = refreshed.seeds.find((s) => s.ts === 15);
    expect(at15?.ocr).toEqual(["2 - 0"]);
    expect(at15?.objects?.[0]?.label).toBe("ball");
    expect(refreshed.seeds.length).toBe(payload.frames.length); // aligned to frames
  });

  it("is a no-op (returns the SAME payload) when recall produced nothing new", async () => {
    const payload = basePayload();
    // empty seeds -> no new evidence -> no-op, never regresses the decision
    expect(await applyObserveRecall(payload, async () => ({ centerTs: payload.centerTs, seeds: [] }))).toBe(payload);
    // undefined recall result -> same no-op semantics
    expect(await applyObserveRecall(payload, async () => undefined)).toBe(payload);
  });
});
