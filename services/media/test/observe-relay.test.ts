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
      // This test publishes its six frames up front on purpose; the default
      // window is deliberately small (see DEFAULT_OBSERVE_MAX_IN_FLIGHT), so ask
      // for a window that admits them all.
      maxInFlight: 8,
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

  it("bounds the backlog by abandoning the oldest frame, never by skipping a publish", async () => {
    // Dense publishing is a contract: go-livepeer's video-in trickle is ordered,
    // so a seq the node does not publish leaves a HOLE the runner's serial
    // subscriber blocks on forever (session 0251b715: idx 4/5 never posted, 3
    // observations in 300 s). The queue cap abandons the oldest undelivered
    // frames instead, counted and logged.
    const logs: string[] = [];
    const relay = new ObservationRelay({
      read: async () => null, // the runner produces nothing at all
      emit: () => {},
      deadlineMs: 60_000,
      pollIntervalMs: 50,
      maxQueued: 4,
      log: (l) => logs.push(l),
    });
    const accepted: boolean[] = [];
    for (let seq = 1; seq <= 7; seq++) {
      const ok = relay.reserve();
      accepted.push(ok);
      if (ok) relay.commit(frame(seq));
    }
    expect(accepted).toEqual([true, true, true, true, true, true, true]);
    const s = relay.stats();
    expect(s.published).toBe(7); // every decoded frame reached video-in
    expect(s.refused).toBe(0); // ... and none was skipped at the publish site
    expect(s.inFlight).toBeLessThanOrEqual(4);
    expect(s.expired).toBe(3);
    expect(logs.some((l) => l.includes("obs-dropped seq="))).toBe(true);
    relay.close();
  });

  it("keeps a bounded backlog by default (half the lag budget)", async () => {
    // 45 queued frames at a 30 s deadline / 3 fps: memory is bounded even when the
    // runner produces nothing, and every excess frame is counted as expired.
    const relay = new ObservationRelay({ read: async () => null, emit: () => {}, deadlineMs: 30_000, pollIntervalMs: 50 });
    for (let seq = 1; seq <= 60; seq++) {
      expect(relay.reserve()).toBe(true);
      relay.commit(frame(seq));
    }
    const s = relay.stats();
    expect(s.published).toBe(60);
    expect(s.refused).toBe(0);
    expect(s.inFlight).toBeLessThanOrEqual(45);
    expect(s.expired).toBe(60 - s.inFlight);
    relay.close();
  });

  it("cannot be stalled by a read that never settles", async () => {
    // go-livepeer's trickle GET can hang on a seq the live edge will not serve.
    // On session `376fae8f` that stalled the whole queue for 295 s
    // (`obs-expired seq=13 waitedMs=295789`); a bounded read must instead time out
    // and let the deadline abandon the frame, then deliver the next one.
    const hung = new Set<number>([1]);
    const delivered: number[] = [];
    let reads = 0;
    const relay = new ObservationRelay({
      read: (seq) => {
        reads++;
        if (hung.has(seq)) return new Promise<any>(() => {}); // never settles
        return Promise.resolve({ seq });
      },
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 1_000,
      pollIntervalMs: 20,
      readTimeoutMs: 60,
      maxInFlight: 4,
    });
    const t0 = Date.now();
    relay.reserve();
    relay.commit(frame(1));
    relay.reserve();
    relay.commit(frame(2));
    const until = Date.now() + 4_000;
    while (relay.stats().inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    // seq 1 is abandoned (its later neighbour answering proves the hole); seq 2 is
    // delivered. Either way the loop never blocks on the hung read.
    expect(delivered).toEqual([2]);
    expect(relay.stats()).toMatchObject({ published: 2, delivered: 1, skipped: 1, expired: 0 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    // ... and the loop advanced past it (head read, ahead probe, then seq 2)
    // instead of blocking on the hung read.
    expect(reads).toBeGreaterThanOrEqual(3);
    relay.close();
  });

  it("admits every frame so the published seq stream stays dense", () => {
    const relay = new ObservationRelay({ read: async () => null, emit: () => {}, maxQueued: 4, deadlineMs: 60_000 });
    for (let i = 0; i < 20; i++) expect(relay.reserve()).toBe(true);
    relay.abort(); // abort() stays a no-op on the reservation count
    expect(relay.reserve()).toBe(true);
    relay.close();
    expect(relay.reserve()).toBe(false); // a closed session admits nothing
    expect(relay.stats().refused).toBe(0);
  });

  it("expires a frame whose read hangs when no later frame answers", async () => {
    // A runner that has stopped entirely: every read hangs, nothing ahead answers.
    // The frame must be abandoned at its deadline — counted and logged — instead of
    // wedging the relay for the rest of the session.
    const logs: string[] = [];
    const relay = new ObservationRelay({
      read: () => new Promise<any>(() => {}),
      emit: () => {
        throw new Error("must not emit");
      },
      deadlineMs: 1_000,
      pollIntervalMs: 20,
      readTimeoutMs: 60,
      log: (l) => logs.push(l),
    });
    const t0 = Date.now();
    relay.reserve();
    relay.commit(frame(9));
    const until = Date.now() + 4_000;
    while (relay.stats().inFlight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(relay.stats()).toMatchObject({ published: 1, delivered: 0, expired: 1, skipped: 0 });
    expect(Date.now() - t0).toBeLessThan(3_000);
    expect(logs.some((l) => l.includes("obs-expired seq=9"))).toBe(true);
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

// ADAAAA-8004: the reader has the same stale-index failure as the runner.
// go-livepeer's live edge keeps a short segment window, so `GET events-out/{seq}`
// answers 404 forever once the reader is more than that window behind: measured
// on session `3c6c8920` (build b0ff88b, 395 decoded frames, runner keeping up at
// 3 fps) the relay read `idx=262` against `next=332` and delivered 9
// observations. The push path tails the live edge instead and pairs each
// observation with the frame it carries.
describe("ObservationRelay push path (ADAAAA-8004 edge retention)", () => {
  /** A live edge that hands out `script` in order, then nothing. */
  function edgeScript(obs: any[]) {
    const queue = [...obs];
    return async () => queue.shift() ?? null;
  }

  it("tails the live edge, pairs by obs.seq and counts the frames the runner skipped", async () => {
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: async () => null, // index reads are never used on the push path
      readHead: edgeScript([{ seq: 3, tracks: [] }]),
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 5,
      maxQueued: 10,
    });
    for (let seq = 1; seq <= 4; seq++) relay.commit(frame(seq));
    await relay.flush(300);
    // 1 and 2 were fast-forwarded past by the runner (counted, not expired);
    // 3 was delivered and 4 stayed queued waiting for its own observation.
    expect(delivered).toEqual([3]);
    expect(relay.stats()).toMatchObject({ published: 4, delivered: 1, skipped: 2, expired: 0 });
    relay.close();
  });

  it("never delivers the same live-edge observation twice", async () => {
    const delivered: number[] = [];
    const relay = new ObservationRelay({
      read: async () => null,
      // A live edge that re-serves the same seq before moving on (hub semantics).
      readHead: edgeScript([{ seq: 2 }, { seq: 2 }, { seq: 5 }]),
      emit: (_o, f) => delivered.push(f.seq),
      deadlineMs: 30_000,
      pollIntervalMs: 5,
      maxQueued: 10,
    });
    relay.commit(frame(2));
    relay.commit(frame(5));
    await relay.flush(300);
    expect(delivered).toEqual([2, 5]);
    expect(relay.stats().skipped).toBe(0);
    relay.close();
  });
});
