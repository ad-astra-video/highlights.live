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
