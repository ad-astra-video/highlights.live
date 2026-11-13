// ADAAAA-8949 (Inc 4): the no-preview still's data lifecycle, measured.
//
// AC4.1 ("0 frame requests without a surface; exactly 1 frame request per detail
// poll with one") and AC4.7 ("<= 1 image fetch per poll") are REQUEST COUNTS, so
// they are counted here against a fake transport rather than asserted in prose.
// AC4.2's edge arithmetic and AC4.3's freshness are pure and are pinned with the
// actual numbers.
//
// Pure module, node env (this package deliberately has no jsdom).
import { describe, expect, it } from "vitest";
import {
  LiveStillSource,
  LIVE_FRAME_STALE_SEC,
  STILL_WAITING_TEXT,
  createLiveStillSource,
  formatContentStamp,
  formatFrameAge,
  frameAgeSeconds,
  frameErrorStatus,
  frameStillLabel,
  frameWallClockMs,
  isAuthRefusal,
  isFrameStale,
  latestLiveFrame,
  shouldPollStill,
  stillRefusalText,
  type LiveFrameRef,
} from "./liveFrameStill";
import { contentRect, overlayBox } from "./scoreboardOverlay";

const ROI: [number, number, number, number] = [0.1, 0.05, 0.6, 0.2];

/** A fake frame route + JPEG "fetcher" that records every call. */
function fakeTransport(lists: unknown[]) {
  const calls: string[] = [];
  let listed = 0;
  const transport = {
    async listFrames(jobId: string) {
      calls.push(`list:${jobId}`);
      const next = lists[Math.min(listed, lists.length - 1)];
      listed += 1;
      return next;
    },
    async fetchImage(uri: string) {
      calls.push(`image:${uri}`);
      return `blob:${uri}`;
    },
  };
  return { transport, calls };
}

const listOf = (rows: Array<{ seq: number; timestamp: number | null }>) => ({
  frames: rows.map((r) => ({ ...r, uri: `/jobs/job-1/frames/${r.seq}` })),
});

describe("latestLiveFrame — the newest extracted frame the route serves", () => {
  it("takes the max seq, not the last row (the decimation path drops seqs)", () => {
    const frame = latestLiveFrame(
      listOf([
        { seq: 3, timestamp: 6.2 },
        { seq: 41, timestamp: 82.4 },
        { seq: 12, timestamp: 24.1 },
      ]),
    );
    expect(frame).toEqual({ seq: 41, uri: "/jobs/job-1/frames/41", timestamp: 82.4 });
  });

  it("ignores a row with no usable seq and an empty payload", () => {
    expect(latestLiveFrame({ frames: [{ uri: "/x" }, { seq: 7, timestamp: 1, uri: "/f/7" }] })?.seq).toBe(7);
    expect(latestLiveFrame({ frames: [] })).toBeNull();
    expect(latestLiveFrame({})).toBeNull();
    expect(latestLiveFrame(null)).toBeNull();
  });

  it("keeps `timestamp: null` for a frame whose observation row is missing", () => {
    expect(latestLiveFrame({ frames: [{ seq: 2, uri: "/f/2", timestamp: null }] })?.timestamp).toBeNull();
  });
});

describe("freshness (AC4.3 — from the served values, never implied)", () => {
  const ANCHOR = Date.parse("2026-11-13T12:00:00Z");
  const NOW = ANCHOR + 42_000;

  it("places a content-relative stamp on the job's content-clock anchor", () => {
    const wall = frameWallClockMs(30.5, ANCHOR)!;
    expect(wall).toBe(ANCHOR + 30_500);
    expect(frameAgeSeconds(wall, NOW)).toBe(11); // 42 s - 30.5 s
  });

  it("uses an epoch-valued stamp as absolute wall clock (defensive unit guard)", () => {
    expect(frameWallClockMs(1_763_000_000, ANCHOR)).toBe(1_763_000_000_000);
    expect(frameAgeSeconds(1_763_000_000_000, 1_763_000_042_000)).toBe(42);
  });

  it("reports an unknown age when the anchor or the stamp is missing", () => {
    expect(frameWallClockMs(30, null)).toBeNull();
    expect(frameWallClockMs(null, ANCHOR)).toBeNull();
    expect(frameAgeSeconds(null, NOW)).toBeNull();
    expect(formatFrameAge(null)).toBe("age unknown");
  });

  it("clamps a frame that reads ahead of the wall clock at 0 s", () => {
    expect(frameAgeSeconds(ANCHOR + 60_000, NOW)).toBe(0);
  });

  it("stale is > 60 s, and an unknown age is stale (never 'fresh by default')", () => {
    expect(LIVE_FRAME_STALE_SEC).toBe(60);
    expect(isFrameStale(60)).toBe(false);
    expect(isFrameStale(61)).toBe(true);
    expect(isFrameStale(null)).toBe(true);
  });

  it("formats the age in seconds and the frame's own content stamp", () => {
    expect(formatFrameAge(12)).toBe("12s ago");
    expect(formatContentStamp(112.3)).toBe("T+01:52.3");
    expect(formatContentStamp(null)).toBe("T+?");
  });

  it("labels the caption with seq + stamp + age in one honest line", () => {
    const frame: LiveFrameRef = { seq: 412, uri: "/jobs/job-1/frames/412", timestamp: 112.3 };
    expect(frameStillLabel(frame, 8)).toBe("newest analyzed frame #412 · T+01:52.3 · 8s ago");
  });
});

describe("AC4.1 — inert without a scoreboardSurface block", () => {
  it("polls only on the no-preview stage AND only with a block", () => {
    const surface = { roi: ROI, source: "explicit", seqFirstSeen: 3, verified: true };
    expect(shouldPollStill("nopreview", surface)).toBe(true);
    // No block -> no source is ever built, so 0 frame requests (AC4.1).
    expect(shouldPollStill("nopreview", undefined)).toBe(false);
    expect(shouldPollStill("nopreview", null)).toBe(false);
    // The video stage keeps Inc 3's behaviour: no still, no frame fetch.
    expect(shouldPollStill("video", surface)).toBe(false);
    expect(shouldPollStill("stopped", surface)).toBe(false);
  });
});

describe("AC4.1 / AC4.7 — <= 1 image fetch per poll", () => {
  it("fetches the list once per poll and the JPEG only when the newest seq moves", async () => {
    const { transport, calls } = fakeTransport([
      listOf([{ seq: 10, timestamp: 20 }, { seq: 11, timestamp: 22 }]),
      listOf([{ seq: 10, timestamp: 20 }, { seq: 11, timestamp: 22 }]),
      listOf([{ seq: 11, timestamp: 22 }, { seq: 12, timestamp: 24 }]),
      listOf([{ seq: 11, timestamp: 22 }, { seq: 12, timestamp: 24 }]),
    ]);
    const source = createLiveStillSource(transport);

    const p1 = await source.poll("job-1");
    const p2 = await source.poll("job-1");
    const p3 = await source.poll("job-1");
    const p4 = await source.poll("job-1");

    expect(source.counts).toEqual({ listRequests: 4, imageRequests: 2 });
    expect(calls).toEqual([
      "list:job-1",
      "image:/jobs/job-1/frames/11",
      "list:job-1",
      "list:job-1",
      "image:/jobs/job-1/frames/12",
      "list:job-1",
    ]);
    // Same seq -> the SAME object URL is reused (no second fetch, no re-render churn).
    expect(p2.url).toBe(p1.url);
    expect(p4.url).toBe(p3.url);
    expect(p1.frame?.seq).toBe(11);
    expect(p3.frame?.seq).toBe(12);
  });

  it("makes 0 image requests while the job has no extracted frame yet", async () => {
    const { transport, calls } = fakeTransport([{ frames: [] }, { frames: [] }]);
    const source = createLiveStillSource(transport);
    await source.poll("job-1");
    await source.poll("job-1");
    expect(source.counts).toEqual({ listRequests: 2, imageRequests: 0 });
    expect(calls.filter((c) => c.startsWith("image:"))).toEqual([]);
  });

  it("keeps the last honest still when a JPEG fetch fails, and retries next poll", async () => {
    // seq 5 loads; seq 6 lands but its JPEG fetch fails; the NEXT poll retries 6.
    const lists = [
      listOf([{ seq: 5, timestamp: 10 }]),
      listOf([{ seq: 5, timestamp: 10 }, { seq: 6, timestamp: 12 }]),
      listOf([{ seq: 5, timestamp: 10 }, { seq: 6, timestamp: 12 }]),
    ];
    let listIdx = 0;
    let failSeq6 = true;
    const seen: string[] = [];
    const source = new LiveStillSource({
      async listFrames() {
        const next = lists[Math.min(listIdx, lists.length - 1)];
        listIdx += 1;
        return next;
      },
      async fetchImage(uri: string) {
        seen.push(uri);
        if (uri.endsWith("/6") && failSeq6) throw new Error("frame fetch failed: HTTP 500");
        return uri.endsWith("/6") ? "blob:six" : "blob:five";
      },
    });

    const first = await source.poll("job-1");
    expect(first.url).toBe("blob:five");
    expect(first.error).toBeNull();
    expect(first.state).toBe("ready");

    const bad = await source.poll("job-1");
    // The still stays on screen, and it keeps the provenance of the frame it
    // DEPICTS (5), not the seq that failed to load (6).
    expect(bad.state).toBe("ready");
    expect(bad.frame?.seq).toBe(5);
    expect(bad.newestSeq).toBe(6);
    expect(bad.url).toBe("blob:five");
    expect(bad.error).toContain("HTTP 500");

    failSeq6 = false;
    const retried = await source.poll("job-1");
    expect(retried.frame?.seq).toBe(6);
    expect(retried.url).toBe("blob:six");
    expect(retried.error).toBeNull();
    // The seq never advanced on the failure, so the retry re-fetched frame 6.
    expect(seen).toEqual([
      "/jobs/job-1/frames/5",
      "/jobs/job-1/frames/6",
      "/jobs/job-1/frames/6",
    ]);
    expect(source.counts).toEqual({ listRequests: 3, imageRequests: 3 });
  });

  it("reports a list failure without inventing a frame", async () => {
    const source = new LiveStillSource({
      async listFrames() {
        throw new Error("list failed: HTTP 502");
      },
      async fetchImage() {
        return "blob:never";
      },
    });
    const snap = await source.poll("job-1");
    expect(snap.frame).toBeNull();
    expect(snap.url).toBeNull();
    expect(snap.error).toContain("HTTP 502");
    // ADAAAA-8970: a read failure is a REFUSAL state, never "no frames yet".
    expect(snap.state).toBe("refused");
    expect(snap.refusal).toBe("transport");
  });

  it("reset() forgets the cached seq so a return to the stage re-fetches", async () => {
    const { transport } = fakeTransport([listOf([{ seq: 9, timestamp: 18 }])]);
    const source = createLiveStillSource(transport);
    await source.poll("job-1");
    source.reset();
    await source.poll("job-1");
    expect(source.counts).toEqual({ listRequests: 2, imageRequests: 2 });
  });
});

// ADAAAA-8970 (Inc 2): the degrade contract, measured against a fake transport.
// Each row of the ticket's matrix is a REQUEST COUNT + a state, so both are
// asserted from the source's own counters rather than described in prose.
describe("ADAAAA-8970 — the no-preview degrade matrix", () => {
  it("no surface: inert, so 0 frame requests (the hook never polls)", () => {
    // `shouldPollStill` is the only gate: no block -> no source -> no request.
    expect(shouldPollStill("nopreview", undefined)).toBe(false);
    expect(shouldPollStill("nopreview", null)).toBe(false);
    // And a source that is never polled has zero counters, by construction.
    const { transport, calls } = fakeTransport([listOf([{ seq: 4, timestamp: 8 }])]);
    const source = createLiveStillSource(transport);
    expect(source.counts).toEqual({ listRequests: 0, imageRequests: 0 });
    expect(calls).toEqual([]);
  });

  it("frames empty: waiting, 0 image requests, and at most 1 list per poll", async () => {
    const { transport } = fakeTransport([{ frames: [] }, { frames: [] }, { frames: [] }]);
    const source = createLiveStillSource(transport);
    const a = await source.poll("job-1");
    const b = await source.poll("job-1");
    const c = await source.poll("job-1");
    for (const snap of [a, b, c]) {
      expect(snap.state).toBe("waiting");
      expect(snap.frame).toBeNull();
      expect(snap.url).toBeNull();
      expect(snap.refusal).toBeNull();
    }
    expect(source.counts).toEqual({ listRequests: 3, imageRequests: 0 });
  });

  it("frames 404 (empty payload) is the same waiting state, not a failure", async () => {
    const { transport } = fakeTransport([null, { frames: [] }]);
    const source = createLiveStillSource(transport);
    expect((await source.poll("job-1")).state).toBe("waiting");
    expect((await source.poll("job-1")).state).toBe("waiting");
    expect(source.counts).toEqual({ listRequests: 2, imageRequests: 0 });
  });

  it("frame 401: refused/auth, one image attempt TOTAL, never a loop", async () => {
    const { transport, calls } = fakeTransport([
      listOf([{ seq: 6, timestamp: 12 }]),
      listOf([{ seq: 6, timestamp: 12 }]),
      listOf([{ seq: 6, timestamp: 12 }]),
    ]);
    const fetchImage = async (uri: string) => {
      calls.push(`image:${uri}`);
      throw new Error("frame fetch failed: HTTP 401");
    };
    const source = new LiveStillSource({ ...transport, fetchImage });

    const first = await source.poll("job-1");
    expect(first.state).toBe("refused");
    expect(first.refusal).toBe("auth");
    expect(first.url).toBeNull();
    expect(first.frame).toBeNull();
    expect(first.error).toContain("HTTP 401");

    const second = await source.poll("job-1");
    const third = await source.poll("job-1");
    expect(second.state).toBe("refused");
    expect(third.state).toBe("refused");
    // One attempt, not one per poll: the refusal is latched for this token.
    expect(source.counts).toEqual({ listRequests: 3, imageRequests: 1 });
    expect(calls.filter((c) => c.startsWith("image:"))).toHaveLength(1);
  });

  it("frame 403 on a NEW seq after a good frame drops the still instead of re-showing it", async () => {
    let listIdx = 0;
    const lists = [listOf([{ seq: 5, timestamp: 10 }]), listOf([{ seq: 5, timestamp: 10 }, { seq: 6, timestamp: 12 }])];
    const source = new LiveStillSource({
      async listFrames() {
        const next = lists[Math.min(listIdx, lists.length - 1)];
        listIdx += 1;
        return next;
      },
      async fetchImage(uri: string) {
        if (uri.endsWith("/6")) throw new Error("frame fetch failed: HTTP 403");
        return "blob:five";
      },
    });
    const good = await source.poll("job-1");
    expect(good.state).toBe("ready");
    expect(good.url).toBe("blob:five");

    const refused = await source.poll("job-1");
    // The client already dropped frame 6; it must NOT fall back to frame 5.
    expect(refused.state).toBe("refused");
    expect(refused.refusal).toBe("auth");
    expect(refused.url).toBeNull();
    expect(refused.frame).toBeNull();
    expect(source.counts).toEqual({ listRequests: 2, imageRequests: 2 });
  });

  it("a latched auth refusal does NOT retry a later seq; reset() allows one fresh attempt", async () => {
    let listIdx = 0;
    const lists = [
      listOf([{ seq: 7, timestamp: 14 }]),
      listOf([{ seq: 7, timestamp: 14 }, { seq: 8, timestamp: 16 }]),
      listOf([{ seq: 7, timestamp: 14 }, { seq: 8, timestamp: 16 }]),
    ];
    let attempts = 0;
    const source = new LiveStillSource({
      async listFrames() {
        const next = lists[Math.min(listIdx, lists.length - 1)];
        listIdx += 1;
        return next;
      },
      async fetchImage(uri: string) {
        attempts += 1;
        if (attempts === 1) throw new Error("frame fetch failed: HTTP 401");
        return `blob:${uri}`;
      },
    });
    expect((await source.poll("job-1")).state).toBe("refused");
    // seq 8 lands while the token is still refused: still no request.
    const later = await source.poll("job-1");
    expect(later.state).toBe("refused");
    expect(later.newestSeq).toBe(8);
    expect(attempts).toBe(1);

    // Re-entering the stage (new token / new job) clears the latch.
    source.reset();
    const recovered = await source.poll("job-1");
    expect(recovered.state).toBe("ready");
    expect(recovered.frame?.seq).toBe(8);
    expect(recovered.url).toBe("blob:/jobs/job-1/frames/8");
    expect(attempts).toBe(2);
    expect(source.counts).toEqual({ listRequests: 3, imageRequests: 2 });
  });

  it("a 4-minute-old frame: ready, 1 list + 1 image per poll, age 240 s, stale", async () => {
    const { transport } = fakeTransport([
      listOf([{ seq: 412, timestamp: 112.3 }]),
      listOf([{ seq: 412, timestamp: 112.3 }]),
    ]);
    const source = createLiveStillSource(transport);
    const anchor = Date.parse("2026-11-13T12:00:00Z");
    const nowMs = anchor + 112_300 + 240_000;
    const a = await source.poll("job-1");
    const b = await source.poll("job-1");
    for (const snap of [a, b]) {
      expect(snap.state).toBe("ready");
      expect(snap.frame?.seq).toBe(412);
      const age = frameAgeSeconds(frameWallClockMs(snap.frame!.timestamp, anchor), nowMs);
      expect(age).toBe(240);
      expect(formatFrameAge(age)).toBe("240s ago");
      expect(isFrameStale(age)).toBe(true);
    }
    // One list per poll; the JPEG is fetched once (same seq reused afterwards).
    expect(source.counts).toEqual({ listRequests: 2, imageRequests: 1 });
  });

  it("classifies the auth status from `status` or the thrown message", () => {
    const withStatus = Object.assign(new Error("nope"), { status: 403 });
    expect(frameErrorStatus(withStatus)).toBe(403);
    expect(frameErrorStatus(new Error("frame fetch failed: HTTP 401"))).toBe(401);
    expect(frameErrorStatus(new Error("boom"))).toBeNull();
    expect(isAuthRefusal(401)).toBe(true);
    expect(isAuthRefusal(403)).toBe(true);
    expect(isAuthRefusal(500)).toBe(false);
    expect(isAuthRefusal(null)).toBe(false);
  });

  it("names the two degrade states differently", () => {
    expect(STILL_WAITING_TEXT).toContain("No analyzed frame yet");
    const auth = stillRefusalText("auth", "frame fetch failed: HTTP 401");
    const transport = stillRefusalText("transport", "HTTP 502");
    expect(auth).toContain("could not be read");
    expect(auth).toContain("token was refused");
    expect(auth).toContain("Sign in again");
    expect(transport).toContain("could not be read (HTTP 502)");
    expect(auth).not.toBe(transport);
    expect(auth).not.toContain("No analyzed frame yet");
  });
});

// AC4.2 — the SAME Inc 3 mapper, proved on an <img> at the three stage aspects
// the ticket names. Expected numbers are written out by hand (not recomputed
// with the function under test) so the assertion is independent arithmetic.
describe("AC4.2 — box edges inside the rendered <img> content rect", () => {
  const BOX = (stageW: number, stageH: number, imgW: number, imgH: number) =>
    overlayBox(contentRect(stageW, stageH, imgW, imgH), ROI)!;

  it("16:9 frame in a 16:9 stage (768x432): bars are zero, box is roi x stage", () => {
    const rect = contentRect(768, 432, 640, 360)!;
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([0, 0, 768, 432]);
    const box = BOX(768, 432, 640, 360);
    // left 0.1*768, top 0.05*432, w 0.5*768, h 0.15*432
    expect(box.left).toBeCloseTo(76.8, 6);
    expect(box.top).toBeCloseTo(21.6, 6);
    expect(box.width).toBeCloseTo(384, 6);
    expect(box.height).toBeCloseTo(64.8, 6);
  });

  it("4:3 frame in a 16:9 stage (768x432): letterboxed 96 px per side, box follows the PICTURE", () => {
    const rect = contentRect(768, 432, 640, 480)!;
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([96, 0, 576, 432]);
    const box = BOX(768, 432, 640, 480);
    // left 96 + 0.1*576, top 0.05*432, w 0.5*576, h 0.15*432
    expect(box.left).toBeCloseTo(153.6, 6);
    expect(box.top).toBeCloseTo(21.6, 6);
    expect(box.width).toBeCloseTo(288, 6);
    expect(box.height).toBeCloseTo(64.8, 6);
    // The failure this guards: a container-percentage box would put the left edge
    // at 76.8 — one bar (76.8 px here) to the left of the score bug.
    const containerBox = { left: 0.1 * 768, top: 0.05 * 432 };
    expect(Math.abs(containerBox.left - box.left)).toBeCloseTo(76.8, 6);
    expect(Math.abs(containerBox.left - box.left)).toBeGreaterThan(2);
  });

  it("2.4:1 frame in a 16:9 stage (768x432): pillarboxed 55.8 px top/bottom", () => {
    const rect = contentRect(768, 432, 640, 267)!;
    expect(rect.x).toBe(0);
    expect(rect.y).toBeCloseTo(55.8, 6);
    expect(rect.width).toBe(768);
    expect(rect.height).toBeCloseTo(320.4, 6);
    const box = BOX(768, 432, 640, 267);
    // top 55.8 + 0.05*320.4 = 71.82; h 0.15*320.4 = 48.06
    expect(box.left).toBeCloseTo(76.8, 6);
    expect(box.top).toBeCloseTo(71.82, 6);
    expect(box.width).toBeCloseTo(384, 6);
    expect(box.height).toBeCloseTo(48.06, 6);
  });

  it("holds at a narrow stage width (480x270): the same frame, scaled uniformly", () => {
    const rect = contentRect(480, 270, 640, 480)!; // 4:3 -> 360x270, 60 px bars
    expect([rect.x, rect.y, rect.width, rect.height]).toEqual([60, 0, 360, 270]);
    const box = BOX(480, 270, 640, 480);
    expect(box.left).toBeCloseTo(96, 6); // 60 + 0.1*360
    expect(box.top).toBeCloseTo(13.5, 6); // 0.05*270
    expect(box.width).toBeCloseTo(180, 6); // 0.5*360
    expect(box.height).toBeCloseTo(40.5, 6); // 0.15*270
  });

  it("every edge above is inside the ±2 px budget against the hand numbers", () => {
    const cases: Array<[number, number, number, number, [number, number, number, number]]> = [
      [768, 432, 640, 360, [76.8, 21.6, 384, 64.8]],
      [768, 432, 640, 480, [153.6, 21.6, 288, 64.8]],
      [768, 432, 640, 267, [76.8, 71.82, 384, 48.06]],
      [480, 270, 640, 480, [96, 13.5, 180, 40.5]],
    ];
    for (const [sw, sh, iw, ih, [l, t, w, h]] of cases) {
      const box = BOX(sw, sh, iw, ih);
      expect(Math.abs(box.left - l)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.top - t)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.width - w)).toBeLessThanOrEqual(2);
      expect(Math.abs(box.height - h)).toBeLessThanOrEqual(2);
    }
  });
});
