import { describe, expect, it, vi } from "vitest";
import { SAMPLE_HEIGHT, SAMPLE_WIDTH, createFrameSampler, createTickGate } from "./frameSampler";

/** A node-side stand-in for the canvas the sampler owns. */
function fakeCanvas() {
  const ctx = { drawImage: vi.fn() };
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ctx),
    toDataURL: vi.fn(() => "data:image/jpeg;base64,AAAA"),
  };
  return { canvas, ctx };
}

const video = { videoWidth: 1920, videoHeight: 1080 } as unknown as HTMLVideoElement;

// ADAAAA-8848 (F4): the fallback sampler created a NEW canvas + 2d context on
// every 1 s tick, and the ingest POSTs were fire-and-forget with no in-flight
// cap. One canvas/context per share, and one POST in flight.
describe("reused frame sampler (ADAAAA-8848 F4)", () => {
  it("creates exactly ONE canvas + context for 10 ticks and reuses it", () => {
    const { canvas, ctx } = fakeCanvas();
    const createCanvas = vi.fn(() => canvas as unknown as HTMLCanvasElement);
    const sampler = createFrameSampler({ createCanvas });

    for (let tick = 0; tick < 10; tick++) expect(sampler.capture(video)).toBe("AAAA");

    expect(createCanvas).toHaveBeenCalledTimes(1);
    expect(canvas.getContext).toHaveBeenCalledTimes(1);
    expect(ctx.drawImage).toHaveBeenCalledTimes(10);
    expect(canvas.width).toBe(SAMPLE_WIDTH);
    expect(canvas.height).toBe(SAMPLE_HEIGHT);
    expect(canvas.toDataURL).toHaveBeenLastCalledWith("image/jpeg", 0.6);
  });

  it("returns null while the source has no pixels yet (no draw, no allocation)", () => {
    const { canvas, ctx } = fakeCanvas();
    const sampler = createFrameSampler({ createCanvas: () => canvas as unknown as HTMLCanvasElement });
    expect(sampler.capture({ videoWidth: 0 } as unknown as HTMLVideoElement)).toBeNull();
    expect(ctx.drawImage).not.toHaveBeenCalled();
  });

  it("releases the backing store on dispose", () => {
    const { canvas } = fakeCanvas();
    const sampler = createFrameSampler({ createCanvas: () => canvas as unknown as HTMLCanvasElement });
    sampler.capture(video);
    sampler.dispose();
    expect(canvas.width).toBe(0);
    expect(canvas.height).toBe(0);
  });

  it("allows exactly one ingest POST in flight and SKIPS ticks while pending", () => {
    const gate = createTickGate();
    expect(gate.tryEnter()).toBe(true);
    expect(gate.inFlight).toBe(true);
    // Ten ticks while the first POST is pending must all be skipped.
    for (let tick = 0; tick < 10; tick++) expect(gate.tryEnter()).toBe(false);
    gate.leave();
    expect(gate.inFlight).toBe(false);
    expect(gate.tryEnter()).toBe(true);
  });
});
