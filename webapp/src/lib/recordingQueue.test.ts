import { describe, expect, it } from "vitest";
import {
  BoundedRecordingQueue,
  RECORDING_QUEUE_LIMIT,
  recordingGapNotice,
  type RecordingChunk,
  type RecordingGap,
} from "./recordingQueue";

/** A Blob-like chunk of a known size (node has Blob, but the queue only reads
 *  `.size`, so a tiny stand-in keeps the test independent of real encoder
 *  output). */
function chunk(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)]);
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// ADAAAA-8848 (F2): the un-uploaded recording queue had no cap, so a client on a
// 1 Mbps uplink accumulated ~107 MB at 5 min and ~1 GB at 45 min — the likely
// OOM. The queue must hold at most 30 chunks, drop the OLDEST on overflow, count
// the drop, and surface a truthful "recording gap" notice.
describe("bounded recording queue (ADAAAA-8848 F2)", () => {
  it("buffers at most 30 chunks and drops the oldest, counting every drop", async () => {
    // A STALLED uploader: while `stalled` is true every upload waits forever, so
    // nothing drains and the buffer is forced to its bound.
    let stalled = true;
    const waiting: Array<() => void> = [];
    const gaps: RecordingGap[] = [];
    const queue = new BoundedRecordingQueue({
      upload: () =>
        stalled
          ? new Promise<void>((resolve) => {
              waiting.push(resolve);
            })
          : Promise.resolve(),
      onGap: (gap) => gaps.push(gap),
    });
    expect(RECORDING_QUEUE_LIMIT).toBe(30);

    for (let i = 0; i < 120; i++) queue.push(chunk(1000), "video/webm");
    expect(queue.size).toBe(30);
    expect(queue.dropCount).toBe(90);
    expect(queue.gap.droppedBytes).toBe(90_000);
    expect(queue.size + queue.dropCount).toBe(120);
    // The notice is raised (and stays current) once chunks are dropped.
    expect(gaps.length).toBeGreaterThan(0);
    expect(gaps.at(-1)).toEqual({ dropped: 90, droppedBytes: 90_000 });
    expect(recordingGapNotice(gaps.at(-1)!)).toMatch(/Recording gap/);
    expect(recordingGapNotice(gaps.at(-1)!)).toMatch(/90 s/);

    stalled = false;
    for (const resolve of waiting) resolve();
    await queue.flush();
    expect(queue.size).toBe(0);
  });

  it("keeps the NEWEST chunks (a clip near 'now' still has video)", async () => {
    const uploaded: number[] = [];
    const queue = new BoundedRecordingQueue({
      limit: 3,
      upload: async (c: RecordingChunk) => {
        uploaded.push(c.blob.size);
      },
    });
    // The uploader is async, so pushes 0..5 race the drain; flush after to make
    // the ordering assertion deterministic on whatever was accepted.
    for (let i = 0; i < 6; i++) queue.push(chunk(i + 1), "video/webm");
    await queue.flush();
    // Chunk 1 was in flight when the rest were pushed; the newest two survive
    // behind it (itself + 5,6 = the 3 un-uploaded chunks the bound allows).
    expect(uploaded).toEqual([1, 5, 6]);
    expect(queue.dropCount).toBe(3);
  });

  it("uploads serially in push order (the server appends to ONE file)", async () => {
    const order: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = new BoundedRecordingQueue({
      upload: async (c) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        order.push(c.blob.size);
        inFlight -= 1;
      },
    });
    for (let i = 0; i < 5; i++) queue.push(chunk(i + 1), "video/webm");
    await queue.flush();
    expect(maxInFlight).toBe(1);
    expect(order).toEqual([1, 2, 3, 4, 5]);
  });

  it("counts a rejected upload and keeps draining the rest", async () => {
    let calls = 0;
    const queue = new BoundedRecordingQueue({
      upload: async () => {
        calls += 1;
        if (calls === 2) throw new Error("HTTP 502");
      },
    });
    for (let i = 0; i < 3; i++) queue.push(chunk(10), "video/webm");
    await queue.flush();
    expect(calls).toBe(3);
    expect(queue.failureCount).toBe(1);
    expect(queue.dropCount).toBe(0);
  });

  it("accepts no further chunks once closed (a stopped share must not grow)", async () => {
    const queue = new BoundedRecordingQueue({ upload: async () => {} });
    queue.close();
    queue.push(chunk(10), "video/webm");
    expect(queue.size).toBe(0);
  });

  it("states the real consequence in the gap notice, with the dropped bytes", () => {
    const notice = recordingGapNotice({ dropped: 12, droppedBytes: 6 * 1024 * 1024 });
    expect(notice).toContain("12 s");
    expect(notice).toContain("6.0 MB");
    expect(notice).toContain("no video");
  });
});
