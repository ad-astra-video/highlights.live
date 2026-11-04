// ADAAAA-7700 — failure attribution mapping (pure).
//
// The 22:16Z defect: a media-node recreate dropped the RTC session and the browser
// job landed as a bare `failed` with 0 frames, indistinguishable from "the pipeline
// never ran". These tests pin the mapping that fixes it: only a session that died
// WITH the node is a failure, and it carries a distinct reason + a next action.
import { describe, expect, it } from "vitest";
import {
  MEDIA_SESSION_LOST_MESSAGE,
  SERVER_RESTART_MESSAGE,
  classifyVodFailure,
  failureReasonFor,
  outcomeForMediaCloseReason,
  outcomeForStrandedJob,
} from "../src/job-failure";

describe("outcomeForMediaCloseReason (ADAAAA-7700)", () => {
  it("attributes a media-node restart as media-session-lost with an actionable message", () => {
    const o = outcomeForMediaCloseReason("media-node-restart");
    expect(o.status).toBe("failed");
    if (o.status !== "failed") return;
    expect(o.failureReason).toBe("media-session-lost");
    expect(o.error).toBe(MEDIA_SESSION_LOST_MESSAGE);
    // The message must name the cause AND the next action — not just "failed".
    expect(o.error).toMatch(/media node restarted/i);
    expect(o.error).toMatch(/click start to share again/i);
  });

  it("treats a user/client/control close as a normal end, not a failure", () => {
    for (const reason of ["client-closed", "control-close", "no-client-timeout", "payment-failure"]) {
      expect(outcomeForMediaCloseReason(reason).status).toBe("done");
    }
  });

  it("never invents a failure reason for an unknown close reason", () => {
    const o = outcomeForMediaCloseReason("something-new");
    expect(o.status).toBe("done");
  });

  it("keeps a user stop distinct from a media-session loss", () => {
    const stopped = outcomeForMediaCloseReason("control-close");
    const lost = outcomeForMediaCloseReason("media-node-restart");
    expect(stopped.status).not.toBe(lost.status);
    if (lost.status === "failed") expect(lost.failureReason).not.toBe("user-stop");
  });
});

describe("outcomeForStrandedJob (ADAAAA-7700 boot sweep)", () => {
  it("attributes a stranded browser share that held a media session as media-session-lost", () => {
    const o = outcomeForStrandedJob("browser", true);
    expect(o.status).toBe("failed");
    if (o.status !== "failed") return;
    expect(o.failureReason).toBe("media-session-lost");
    expect(o.error).toBe(MEDIA_SESSION_LOST_MESSAGE);
  });

  it("attributes a stranded browser share with no media session as a server restart", () => {
    const o = outcomeForStrandedJob("browser", false);
    expect(o.status).toBe("failed");
    if (o.status !== "failed") return;
    expect(o.failureReason).toBe("server-restart");
    expect(o.error).toBe(SERVER_RESTART_MESSAGE);
  });

  it("attributes a stranded live/VOD job as a server restart", () => {
    const o = outcomeForStrandedJob("rtmp", false);
    expect(o.status).toBe("failed");
    if (o.status !== "failed") return;
    expect(o.failureReason).toBe("server-restart");
  });
});

// ADAAAA-7906 (VOD resume, Increment 2): the failure classification table.
//
// `classifyVodFailure` is the SINGLE mapping from a thrown VOD pipeline error to
// `{ reason, resumable }`. A path left unclassified falls through to
// pipeline-error/non-resumable and silently disables the automatic retry for
// that incident class, so every row of plan §2.3 is pinned here.
describe("classifyVodFailure (ADAAAA-7906)", () => {
  const sessionLost = () => Object.assign(new Error("perceive session/runner lost (404)"), { name: "SessionLostError" });

  it("classifies a decide 5xx/timeout as decide-unavailable and resumable", () => {
    for (const msg of [
      "decide failed: HTTP 503",
      "decide failed: HTTP 500",
      "decide group failed: HTTP 502",
      "decide timed out after 30000ms",
    ]) {
      expect(classifyVodFailure(new Error(msg))).toEqual({ reason: "decide-unavailable", resumable: true });
    }
  });

  it("classifies an exhausted perceive re-reserve / runner recreate as perceive-session-lost and resumable", () => {
    expect(classifyVodFailure(sessionLost())).toEqual({ reason: "perceive-session-lost", resumable: true });
    const recreate = Object.assign(new Error("analyze interrupted (perceive-session-lost): perceive runner unavailable"), {
      name: "DeployRecreateInterruptedError",
    });
    expect(classifyVodFailure(recreate)).toEqual({ reason: "perceive-session-lost", resumable: true });
  });

  it("classifies capacity exhaustion (503 no capacity) as capacity-exhausted and resumable", () => {
    expect(classifyVodFailure(new Error("no capacity available for runner"))).toEqual({
      reason: "capacity-exhausted",
      resumable: true,
    });
    expect(classifyVodFailure(Object.assign(new Error("reserve failed"), { statusCode: 503 }))).toEqual({
      reason: "capacity-exhausted",
      resumable: true,
    });
  });

  it("classifies a control-plane restart as server-restart and resumable", () => {
    expect(classifyVodFailure(new Error("server restart mid-pass"))).toEqual({
      reason: "server-restart",
      resumable: true,
    });
  });

  it("classifies a corrupt/missing source or ffmpeg decode error as pipeline-error, NOT resumable", () => {
    for (const msg of [
      "ffmpeg exited with code 1: Invalid data found when processing input",
      "moov atom not found",
      "ENOENT: no such file or directory, open '/data/x.mp4'",
      "unsupported codec",
      "schema validation failed",
    ]) {
      expect(classifyVodFailure(new Error(msg))).toEqual({ reason: "pipeline-error", resumable: false });
    }
  });

  it("never retries an operator stop or an unexplained error", () => {
    expect(classifyVodFailure(Object.assign(new Error("job cancelled"), { name: "VodCancelledError" }))).toEqual({
      reason: "user-stop",
      resumable: false,
    });
    expect(classifyVodFailure(new Error("something nobody has seen before"))).toEqual({
      reason: "pipeline-error",
      resumable: false,
    });
  });
});

// ADAAAA-7918: the resume classifier is shared by the VOD and live paths, but its
// vocabulary is VOD-resume specific. `failureReason` is user-visible, so a
// live/browser failure keeps the attribution it had before the resume table
// existed instead of inheriting a resume class it can never act on.
describe("failureReasonFor (ADAAAA-7918 live attribution)", () => {
  it("keeps the pre-resume attribution on a live/browser row", () => {
    const decideDown = classifyVodFailure(new Error("decide failed: HTTP 503"));
    expect(decideDown.reason).toBe("decide-unavailable");
    expect(failureReasonFor("browser", decideDown)).toBe("pipeline-error");
    expect(failureReasonFor("rtmp", decideDown)).toBe("pipeline-error");
    expect(failureReasonFor("webrtc", decideDown)).toBe("pipeline-error");
    expect(failureReasonFor(undefined, decideDown)).toBe("pipeline-error");
  });

  it("uses the classified reason on an eligible VOD `file` job", () => {
    expect(failureReasonFor("file", classifyVodFailure(new Error("decide failed: HTTP 503")))).toBe("decide-unavailable");
    expect(
      failureReasonFor("file", classifyVodFailure(Object.assign(new Error("x"), { name: "SessionLostError" })))
    ).toBe("perceive-session-lost");
    expect(failureReasonFor("file", classifyVodFailure(new Error("ffmpeg exited with code 1")))).toBe("pipeline-error");
  });
});
