// ADAAAA-7921 — a perceive outage must not be reported as a deploy.
//
// Measured: `docker stop highlights-perceive` for 43 s made attempt 8 fail with
// `analyze interrupted (deploy-recreate): perceive runner unavailable after 5
// reserve attempts` and `failureReason perceive-session-lost`. Nothing was
// deployed; the text was inherited from the staged-deploy gate that first
// introduced the retry. The message must follow the reason `classifyVodFailure`
// assigns, so a runner stop says `perceive-session-lost` and a genuine control
// plane restart keeps its own wording.
import { describe, expect, it } from "vitest";

import { DeployRecreateInterruptedError, reservePerceiveWithRetry } from "../src/analyzer";
import { classifyVodFailure, describeInterruption } from "../src/job-failure";

describe("describeInterruption (ADAAAA-7921)", () => {
  it("a perceive outage names the perceived reason, never a deploy", () => {
    const message = describeInterruption(
      "perceive-session-lost",
      "perceive runner unavailable after 5 reserve attempts; job is retriable"
    );
    expect(message).toContain("perceive-session-lost");
    expect(message).not.toContain("deploy");
    // The retry table reads the typed name, which is how the thrown message
    // actually travels; the text is now coherent with that reason.
    expect(classifyVodFailure(Object.assign(new Error(message), { name: "SessionLostError" }))).toEqual({
      reason: "perceive-session-lost",
      resumable: true,
    });
  });

  it("a control-plane restart keeps its own wording", () => {
    const message = describeInterruption("server-restart", "control plane restarted mid-pass");
    expect(message).toContain("server-restart");
    expect(message).not.toContain("perceive");
    expect(classifyVodFailure(new Error(message))).toEqual({
      reason: "server-restart",
      resumable: true,
    });
  });
});

describe("reservePerceiveWithRetry exhaustion (ADAAAA-7921)", () => {
  it("throws a typed retriable perceive-session-lost message with no deploy attribution", async () => {
    const client = {
      reservePerceive: async () => {
        throw new Error("reserve perceive failed: HTTP 404 runner not found");
      },
    } as any;
    const err = await reservePerceiveWithRetry(client, { attempts: 3, baseMs: 1, maxMs: 4 }).then(
      () => null,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(DeployRecreateInterruptedError);
    expect(err?.message).toContain("analyze interrupted (perceive-session-lost)");
    expect(err?.message).toContain("after 3 reserve attempts");
    expect(err?.message).not.toContain("deploy-recreate");
    // The classifier (retry table) still reads the typed reason from the name.
    expect(classifyVodFailure(err)).toEqual({ reason: "perceive-session-lost", resumable: true });
  });
});
