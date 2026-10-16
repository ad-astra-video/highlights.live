import { describe, it, expect, vi } from "vitest";
import { TrackingPlanController, type PipelineClient } from "../src/analyzer";

function mkClient(over: Partial<PipelineClient> = {}): { client: PipelineClient; calls: string[] } {
  const calls: string[] = [];
  const base: PipelineClient = {
    reservePerceive: async () => ({ sessionId: "s", appUrl: "", controlUrl: "" }),
    analyze: async () => ({ observation: { tracks: [], seq: 0, timestamp: 0 } }),
    decide: async () => ({ isHighlight: false, score: 0 }),
    plan: async (req) => {
      calls.push(`plan:${req.mode}`);
      return { planVersion: 1, category: "soccer", intent: "", source: "planner", maxTracks: req.mode === "vod" ? 8 : 3, targets: [{ label: "player", role: "player" }] } as any;
    },
    postAudio: async () => null,
    controlForward: async () => {},
    train: async () => ({ run: "x", checkpoint: "/runs/x/model.safetensors" }),
    stopPerceive: async () => {},
    confirm: async () => ({ enabled: false, goalConfirmed: null, confidence: 0, reason: "", evidence: {}, stage1Disagreed: false, decision: { isHighlight: false, score: 0, eventType: "KILL" } }),
    ...over,
  };
  return { client: base, calls };
}

describe("TrackingPlanController (increment D — ADAAAA-6467)", () => {
  it("warmUp fires EXACTLY ONE planner call (never a second on repeat)", async () => {
    const { client, calls } = mkClient();
    const c = new TrackingPlanController({ planMode: "live" });
    await c.warmUp(client, "img0");
    await c.warmUp(client, "img1"); // guarded: warmup already true
    expect(calls).toEqual(["plan:live"]);
    expect(c.active?.maxTracks).toBe(3);
    // The delivered plan (per-frame /analyze) is scoped to the active roster.
    expect(c.delivery()).toMatchObject({ maxTracks: 3 });
  });

  it("clamps maxTracks to the mode cap (3 live / 8 VOD) even if the plan over-requests", async () => {
    const { client } = mkClient({
      plan: async (req: any) => ({
        planVersion: 1, category: "soccer", intent: "",
        source: "planner", maxTracks: req.mode === "vod" ? 99 : 99,
        targets: [{ label: "player", role: "player" }],
      }) as any,
    });
    const live = new TrackingPlanController({ planMode: "live" });
    await live.warmUp(client, "img");
    expect(live.active?.maxTracks).toBe(3);

    const vod = new TrackingPlanController({ planMode: "vod" });
    await vod.warmUp(client, "img");
    expect(vod.active?.maxTracks).toBe(8);
  });

  it("keeps the previous plan when the planner returns an empty/untrackable roster (narrow-only, no widen)", async () => {
    // First plan is valid.
    const { client } = mkClient({
      plan: async (req: any) =>
        req.imageB64 === "good"
          ? ({ planVersion: 1, category: "soccer", intent: "", source: "planner", maxTracks: 3, targets: [{ label: "player", role: "player" }] } as any)
          : ({ planVersion: 1, category: "soccer", intent: "", source: "planner", maxTracks: 3, targets: [] } as any),
    });
    const c = new TrackingPlanController({ planMode: "live" });
    await c.warmUp(client, "good");
    expect(c.active?.targets?.length).toBe(1);
    // A re-check returning an empty roster must NOT wipe the active plan.
    await c.onCandidate(client, "bad");
    expect(c.active?.targets?.length).toBe(1);
  });

  it("degrades to a safe-default fallback (empty roster, no prior plan) and delivers it", async () => {
    const { client } = mkClient({
      plan: async () => ({ planVersion: 1, category: "", intent: "", source: "planner-fallback", maxTracks: 3, targets: [], reason: "planner unavailable" }) as any,
    });
    const c = new TrackingPlanController({ planMode: "live" });
    await c.warmUp(client, "img");
    // Empty-roster fallback with no prior plan is a valid degrade-to-canned signal.
    expect(c.active?.source).toBe("planner-fallback");
  });

  it("never throws when the planner call fails — keeps the last good plan", async () => {
    const { client } = mkClient({
      plan: async () => {
        throw new Error("planner unreachable");
      },
    });
    const c = new TrackingPlanController({ planMode: "live" });
    // Failure on warm-up yields no plan (safe-default interim), never a throw.
    await expect(c.warmUp(client, "img")).resolves.toBe(null);
    expect(c.delivery()).toBe(null);
  });

  it("applies a plan produced by the out-of-band re-check cadence", async () => {
    const { client } = mkClient({
      plan: async () => ({ planVersion: 1, category: "basketball", intent: "", source: "planner", maxTracks: 3, targets: [{ label: "player", role: "player" }] }) as any,
    });
    const c = new TrackingPlanController({ recheckIntervalSeconds: 1, planMode: "live" });
    let sample = () => "img-recheck";
    // Use fake timers to advance the cadence deterministically.
    vi.useFakeTimers();
    c.startRecheck(client, sample);
    await vi.advanceTimersByTimeAsync(1100);
    vi.runOnlyPendingTimers();
    expect(c.active?.category).toBe("basketball");
    c.stop();
    vi.useRealTimers();
  });

  it("stop() clears the re-check timer (no out-of-life planner calls)", async () => {
    const { client } = mkClient({
      plan: async () => ({ planVersion: 1, category: "soccer", intent: "", source: "planner", maxTracks: 3, targets: [{ label: "player", role: "player" }] }) as any,
    });
    const c = new TrackingPlanController({ recheckIntervalSeconds: 1, planMode: "live" });
    vi.useFakeTimers();
    c.startRecheck(client, () => "img");
    c.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(c.active).toBe(null);
    c.stop();
    vi.useRealTimers();
  });
});
