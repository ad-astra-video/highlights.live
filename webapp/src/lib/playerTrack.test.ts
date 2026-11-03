import { describe, expect, it } from "vitest";
import { findPlayerTrack, gaveUpPlayerStatus, playerStatusFromAck } from "./playerTrack";

// ADAAAA-7833: the player-by-jersey request must never look successful when it
// was not. These are the ack -> operator-line mappings that the console renders.
describe("playerStatusFromAck", () => {
  it("reports a seeded selected slot on a successful identification", () => {
    const { status, retryWindow } = playerStatusFromAck(9, {
      ok: true,
      ack: { type: "ack", ok: true, cmd: "track-player", number: 9, slot: 2, trackId: "t2", selected: true },
    });
    expect(status.kind).toBe("tracked");
    expect(status.text).toBe("player #9 tracked (slot 2)");
    expect(retryWindow).toBeNull();
  });

  it("omits the slot suffix when perceive did not return one", () => {
    const { status } = playerStatusFromAck(7, { ok: true, ack: { ok: true, cmd: "track-player", number: 7 } });
    expect(status.text).toBe("player #7 tracked");
  });

  it("shows the retry state and the runner's real frame window (AC-2)", () => {
    const { status, retryWindow } = playerStatusFromAck(2, {
      ok: false,
      ack: {
        type: "ack",
        ok: false,
        cmd: "track-player",
        number: 2,
        retrying: true,
        retryWindowFrames: 200,
        retryStride: 1,
        retryAttempts: 200,
        error: "no player with number 2 identified on the anchor frame",
      },
    });
    expect(status.kind).toBe("pending");
    expect(status.text).toBe("no player with number 2 identified yet — retrying up to 200 sampled frames");
    expect(retryWindow).toBe(200);
  });

  it("falls back to the default window when the ack omits it", () => {
    const { status, retryWindow } = playerStatusFromAck(4, { ok: false, ack: { ok: false, retrying: true } });
    expect(retryWindow).toBe(200);
    expect(status.text).toContain("retrying up to 200 sampled frames");
  });

  it("surfaces a hard identification failure instead of a silent ok", () => {
    const { status, retryWindow } = playerStatusFromAck(3, {
      ok: false,
      ack: { ok: false, cmd: "track-player", error: "no frame sampled yet (anchor frame required)" },
    });
    expect(status.kind).toBe("failed");
    expect(status.text).toBe("player #3 not identified: no frame sampled yet (anchor frame required)");
    expect(retryWindow).toBeNull();
  });

  it("surfaces a server-level failure with no ack (no session / no ack / transport)", () => {
    const { status } = playerStatusFromAck(9, {
      ok: false,
      ack: null,
      error: "no live perceive session for this job yet — start the stream first",
    });
    expect(status.kind).toBe("failed");
    expect(status.text).toContain("no live perceive session");
  });

  it("never reports success for an empty response", () => {
    const { status } = playerStatusFromAck(9, null);
    expect(status.kind).toBe("failed");
    expect(status.text).toBe("player #9 not identified: identification failed");
  });
});

describe("gaveUpPlayerStatus", () => {
  it("names the frame budget and tells the operator what to do next", () => {
    const status = gaveUpPlayerStatus(9, 200);
    expect(status.kind).toBe("gaveup");
    expect(status.text).toContain("gave up on player #9 after 200 sampled frames");
    expect(status.text).toContain("Ask again once the player is closer");
  });
});

describe("findPlayerTrack", () => {
  it("finds the seeded `player #N` track returned by perceive's retry", () => {
    const tracks = [
      { label: "player", slot: 0 },
      { label: "player #9", slot: 2, selected: true },
    ];
    expect(findPlayerTrack(tracks, 9)).toMatchObject({ slot: 2 });
    expect(findPlayerTrack(tracks, 8)).toBeNull();
    expect(findPlayerTrack(undefined, 9)).toBeNull();
  });
});
