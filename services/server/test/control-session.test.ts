import { describe, expect, it } from "vitest";
import { resolveControlSessionId } from "../src/api";

// ADAAAA-7833: a mid-stream control intent must reach the session that is
// actually running. `job.perceiveSessionId` is only persisted when a pass
// finishes, so it is EMPTY exactly when the operator sends the request — the
// live/VOD slot map and the browser rail are the rails that hold it.
describe("resolveControlSessionId", () => {
  it("prefers the browser-capture rail's session", () => {
    expect(
      resolveControlSessionId({
        jobId: "j1",
        browserSessions: new Map([["j1", { sessionId: "browser-sess" }]]),
        liveSlots: new Map([["j1", { current: { sessionId: "live-sess" } }]]),
        job: { perceiveSessionId: "persisted-sess" },
      })
    ).toBe("browser-sess");
  });

  it("finds the CURRENT live/VOD session while the pass is still running", () => {
    expect(
      resolveControlSessionId({
        jobId: "j1",
        browserSessions: new Map(),
        liveSlots: new Map([["j1", { current: { sessionId: "live-sess" } }]]),
        // mid-stream: the persisted field is not written yet
        job: {},
      })
    ).toBe("live-sess");
  });

  it("follows a re-reserved slot (the slot is mutated in place)", () => {
    const slot: { current?: { sessionId: string } } = { current: { sessionId: "s1" } };
    const liveSlots = new Map([["j1", slot]]);
    const args = { jobId: "j1", browserSessions: new Map(), liveSlots, job: {} };
    expect(resolveControlSessionId(args)).toBe("s1");
    slot.current = { sessionId: "s2" }; // analyzeJob re-reserved a fresh session
    expect(resolveControlSessionId(args)).toBe("s2");
  });

  it("falls back to the persisted session of a finished job", () => {
    expect(
      resolveControlSessionId({
        jobId: "j1",
        browserSessions: new Map(),
        liveSlots: new Map(),
        job: { perceiveSessionId: "persisted-sess" },
      })
    ).toBe("persisted-sess");
  });

  it("returns undefined when nothing holds a session (the route then fails loudly)", () => {
    expect(
      resolveControlSessionId({ jobId: "j1", browserSessions: new Map(), liveSlots: new Map(), job: null })
    ).toBeUndefined();
  });
});
