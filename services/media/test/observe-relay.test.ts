// ADAAAA-7990 (delivery follow-up): the observation relay must DELIVER, not drop.
//
// Deployed evidence this pins: on the funded 3 fps build the media node polled
// `events-out/{seq}` ten times at 250 ms and then silently discarded the frame.
// Because the perceive runner steps frames on one serial loop, it falls ~0.5 s
// behind per frame, so from seq ~5 on every observation was thrown away: job
// `8cb6e0a5` (40 s) delivered 4 observations = 0.10 obs/s and job `750b6cd0`
// (300 s, 851 decoded frames) delivered 2. These tests fail on the old inline
// poll-and-drop path and pass on the ordered relay.
import { describe, expect, it } from "vitest";
import { ObservationRelay, type ObservationFrame } from "../src/observe-relay";

/** A runner that only produces `seq`'s observation `lagMs` after it was
 *  published — the shape of the serial perceive loop. */
function slowRunner(lagMs: number) {
  const publishedAt = new Map<number, number>();
  return {
    publishedAt,
    publish(seq: number, at = Date.now()) {
      publishedAt.set(seq, at);
    },
    async read(seq: number) {
      const at = publishedAt.get(seq);
      if (at === undefined) return null;
      if (Date.now() - at < lagMs) return null;
      return { seq, tracks: [] };
    },
  };
}

const frame = (seq: number): ObservationFrame => ({ seq, ts: seq, jpeg: Buffer.from([seq]) });

describe("ObservationRelay (ADAAAA-7990 delivery)", () => {
  it("delivers every frame in publish order when the runner lags the cadence", async () => {
    // 6 frames at a 3 fps cadence (330 ms apart), runner 500 ms/frame: the
    // backlog grows past 0.5 s immediately, and by seq 5 the old 2.5 s inline
    // poll had already given up.
    const runner = slowRunner(500);
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: (seq) => runner.read(seq),
      emit: (_obs, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 20,
      sampleFps: 3,
    });

    const started = Date.now();
    for (let seq = 1; seq <= 6; seq++) {
      expect(relay.reserve()).toBe(true);
      runner.publish(seq);
      relay.commit(frame(seq));
      // publish cadence is faster than the runner: that is the whole point
      await new Promise((r) => setTimeout(r, 60));
    }
    // The runner needs ~6 * 500 ms from the first publish to drain all six.
    const until = Date.now() + 6_000;
    while (delivered.length < 6 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(delivered).toEqual([1, 2, 3, 4, 5, 6]);
    const s = relay.stats();
    expect(s.delivered).toBe(6);
    expect(s.expired).toBe(0);
    expect(s.refused).toBe(0);
    expect(s.published).toBe(6);
    // Each frame is genuinely late (the runner is slower than the cadence), yet
    // it is still delivered — a drop would be the old regression.
    expect(s.maxLagMs).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeGreaterThan(0);
    relay.close();
  });

  it("counts an abandoned frame instead of dropping it silently", async () => {
    // A runner that never produces an observation (crashed step / bad seq).
    const logs: string[] = [];
    const relay = new ObservationRelay({
      read: async () => null,
      emit: () => {
        throw new Error("must not emit");
      },
      deadlineMs: 1_000, // 1 s deadline keeps the test fast
      pollIntervalMs: 20,
      maxInFlight: 4,
      log: (l) => logs.push(l),
    });
    expect(relay.reserve()).toBe(true);
    relay.commit(frame(42));
    const until = Date.now() + 4_000;
    while (relay.stats().expired === 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const s = relay.stats();
    expect(s.published).toBe(1);
    expect(s.delivered).toBe(0);
    expect(s.expired).toBe(1);
    expect(s.inFlight).toBe(0);
    // ... and it is in the log, attributable by seq.
    expect(logs.some((l) => l.includes("obs-expired seq=42"))).toBe(true);
    relay.close();
  });

  it("abandons a fast-forwarded seq in one tick instead of waiting out the deadline", async () => {
    // go-livepeer's live edge SKIPS a gap: the runner never produces seq 2's
    // observation, but seq 3's exists. A relay that waited the full deadline on
    // the hole would cost 30 s per gap and stall everything behind it.
    const seenAt = new Map<number, number>([[1, Date.now()], [3, Date.now()]]);
    const delivered: number[] = [];
    const logs: string[] = [];
    const relay = new ObservationRelay({
      read: async (seq) => (seenAt.has(seq) ? { seq } : null),
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 20,
      log: (l) => logs.push(l),
    });
    const t0 = Date.now();
    for (const seq of [1, 2, 3]) {
      relay.reserve();
      relay.commit(frame(seq));
    }
    const until = Date.now() + 3_000;
    while (relay.stats().inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
    expect(delivered).toEqual([1, 3]);
    const s = relay.stats();
    expect(s.skipped).toBe(1);
    expect(s.expired).toBe(0);
    // The hole costs one poll tick, not the 30 s deadline.
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(logs.some((l) => l.includes("obs-skipped seq=2"))).toBe(true);
    relay.close();
  });

  it("refuses to publish past the in-flight window (bounded lag, no unbounded queue)", async () => {
    // maxInFlight floor is 4; nothing is ever delivered, so the window fills and
    // further frames are refused rather than published and queued forever.
    const relay = new ObservationRelay({
      read: async () => null,
      emit: () => {},
      deadlineMs: 60_000,
      pollIntervalMs: 50,
      maxInFlight: 4,
    });
    const accepted: boolean[] = [];
    for (let seq = 1; seq <= 7; seq++) {
      const ok = relay.reserve();
      accepted.push(ok);
      if (ok) relay.commit(frame(seq));
    }
    expect(accepted).toEqual([true, true, true, true, false, false, false]);
    const s = relay.stats();
    expect(s.published).toBe(4);
    expect(s.refused).toBe(3);
    expect(s.inFlight).toBe(4); // bounded by the window, not by the stream length
    relay.close();
  });

  it("derives the in-flight window from the deadline and the sampling cadence", async () => {
    // Half the lag budget's worth of frames: 30 s * 3 fps * 0.5 = 45 frames.
    const relay = new ObservationRelay({
      read: async () => null,
      emit: () => {},
      deadlineMs: 30_000,
      sampleFps: 3,
      pollIntervalMs: 50,
    });
    let accepted = 0;
    for (let seq = 1; seq <= 60; seq++) {
      if (relay.reserve()) {
        accepted++;
        relay.commit(frame(seq));
      }
    }
    expect(accepted).toBe(45);
    expect(relay.stats()).toMatchObject({ published: 45, refused: 15, inFlight: 45 });
    relay.close();
  });

  it("abort() returns a reserved slot when the publish itself fails", () => {
    const relay = new ObservationRelay({ read: async () => null, emit: () => {}, maxInFlight: 4, deadlineMs: 60_000 });
    expect(relay.reserve()).toBe(true);
    expect(relay.reserve()).toBe(true);
    relay.abort();
    // 1 in-flight slot left: three more reservations fit before the window fills.
    expect(relay.reserve()).toBe(true);
    expect(relay.reserve()).toBe(true);
    expect(relay.reserve()).toBe(true);
    expect(relay.reserve()).toBe(false);
    expect(relay.stats().refused).toBe(1);
    relay.close();
  });

  it("never wedges when the broker holds a seq open (bounded read + tail probe)", async () => {
    // go-livepeer HOLDS a subscribe request open for a seq that will never be
    // published. The pre-fix loop awaited that read forever: on the deployed
    // 300 s share seq 13 waited 295 s, only 12 observations were delivered, and
    // everything behind the hole was stalled. The read is bounded per tick now,
    // and a tail probe abandons the hole as soon as the runner proves it moved on.
    const observed = new Set([1, 5]);
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      // Mirrors orch.readObservation's abort: resolves null after the bound.
      read: (seq, timeoutMs) =>
        new Promise((r) => setTimeout(() => r(observed.has(seq) ? { seq } : null), timeoutMs)),
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 20,
      log: () => {},
    });
    const t0 = Date.now();
    for (const seq of [1, 2, 3, 4, 5]) {
      relay.reserve();
      relay.commit(frame(seq));
    }
    const until = Date.now() + 3_000;
    while (relay.stats().inFlight > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(delivered).toEqual([1, 5]);
    expect(relay.stats()).toMatchObject({ delivered: 2, skipped: 3, expired: 0 });
    // One poll tick per abandoned seq, not a 30 s deadline per hole.
    expect(Date.now() - t0).toBeLessThan(1_500);
    relay.close();
  });

  it("collapses a whole fast-forward gap in one tick", async () => {
    // The runner jumped from seq 1 to seq 10: seqs 2-9 will never carry an
    // observation. Probing the queue TAIL (not just the next frame) abandons all
    // eight in one tick instead of costing a deadline each.
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: async (seq, timeoutMs) => {
        await new Promise((r) => setTimeout(r, Math.min(timeoutMs, 5)));
        return seq === 1 || seq === 10 ? { seq } : null;
      },
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 20,
      log: () => {},
    });
    for (let seq = 1; seq <= 10; seq++) {
      relay.reserve();
      relay.commit(frame(seq));
    }
    const until = Date.now() + 3_000;
    while (relay.stats().inFlight > 0 && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(delivered).toEqual([1, 10]);
    expect(relay.stats()).toMatchObject({ delivered: 2, skipped: 8, expired: 0 });
    relay.close();
  });

  it("flush() drains a queued backlog (teardown relay of the tail)", async () => {
    const runner = slowRunner(30);
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: (seq) => runner.read(seq),
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 10_000,
      pollIntervalMs: 10,
    });
    for (let seq = 1; seq <= 3; seq++) {
      relay.reserve();
      runner.publish(seq);
      relay.commit(frame(seq));
    }
    await relay.flush(3_000);
    expect(delivered).toEqual([1, 2, 3]);
    relay.close();
  });
});
