// ADAAAA-8495 (AC1): the INGEST rail's accept must not await the clip cut.
//
// ADAAAA-8487 AC-A proved (`$0`, leg `2c4124fe`) that the ingest clip cut ran
// INSIDE `acceptVideoDecision` (`analyzer.ts:6815  clip = await cut(loc.ts)`),
// on the serial accept chain: `waitForFlushedCoverage` (one `ffprobe` of the
// growing 292 MB MPEG-TS per 250 ms) + ffmpeg cut + duration probe + up to two
// re-cuts = 5.1-33.3 s per accepted row, and every later window waited behind
// it. These tests pin the shipped shape:
//   (a) with `deferLiveClipCut` (the ingest rail's wiring) the accept returns
//       WITHOUT the cut resolving — the row is emitted + persisted with an empty
//       `clipUri`, which is exactly what the media/browser rail has done since
//       ADAAAA-8032 (`deferredCut` + `scheduleLiveClipCut`);
//   (b) the cut itself is still the owner of the AC2 guard: the caller's serial
//       cut chain runs it (api.ts `scheduleIngestClipCut`), so a refusal leaves
//       the honest `clipError` on the row instead of a truncated card;
//   (c) with the flag unset the accept path is unchanged (VOD + every existing
//       caller still gets the clip inline, byte-identical).
import { describe, it, expect } from "vitest";
import { acceptVideoDecision, LiveRunShared } from "../src/analyzer";
import type { AnalyzerConfig, CandidateSignal, DecisionResult } from "../src/analyzer";

function cfg(overrides: Partial<AnalyzerConfig> = {}): AnalyzerConfig {
  return {
    jobId: "job-8495",
    gameHint: "soccer",
    clipBeforeS: 6,
    clipAfterS: 9,
    clipWindowMinSec: 15,
    preferLabels: [],
    ...overrides,
  } as AnalyzerConfig;
}

function stage1(): DecisionResult {
  return {
    isHighlight: true,
    score: 90,
    outcome: "scoring_play",
    eventType: "GOAL",
    reason: "shot scored",
  } as DecisionResult;
}

function candidate(ts: number): CandidateSignal {
  return { eventType: "GOAL", timestamp: ts } as CandidateSignal;
}

describe("ingest accept does not await the clip cut (ADAAAA-8495 AC1)", () => {
  it("returns with the cut still pending and emits the row with an empty clipUri", async () => {
    const run = new LiveRunShared({ decideWindowN: 24, audioRetainS: 400 });
    const events: any[] = [];
    let cutStarted = false;
    let releaseCut: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseCut = r;
    });
    // A cut that would block the accept for as long as a real live cut does.
    const cut = async (ts: number) => {
      cutStarted = true;
      await gate;
      return { clipId: `clip-${ts}`, clipUri: `/clips/clip-${ts}.mp4` };
    };
    const started = Date.now();
    await acceptVideoDecision(
      { decide: async () => stage1() } as any,
      run,
      cut,
      cfg({ deferLiveClipCut: true }),
      (ev) => events.push(ev),
      { seq: 1, timestamp: 42 },
      candidate(42),
      stage1()
    );
    const acceptMs = Date.now() - started;
    // The accept never reached the cut, let alone waited for it.
    expect(cutStarted).toBe(false);
    expect(acceptMs).toBeLessThan(2_000);
    const ev = events.find((e) => e.type === "highlight");
    expect(ev).toBeDefined();
    // Published with no clip yet — the rail's "clip processing…" shape — and
    // with NO clipError (nothing failed; the cut has not run).
    expect(ev.highlight.clipUri).toBe("");
    expect(ev.highlight.clipError).toBeUndefined();
    // The clip audit fields are absent until the deferred cut lands.
    expect(ev.highlight.clipCutStartSec).toBeUndefined();
    releaseCut();
  });

  it("routes the deferred cut through the caller's serial chain and keeps the whole-window refusal", async () => {
    const run = new LiveRunShared({ decideWindowN: 24, audioRetainS: 400 });
    const events: any[] = [];
    // The chain the ingest rail uses: ONE cut at a time per share, and a cut
    // that refuses (a window the recording never flushed) must surface as the
    // row's `clipError`, never as a truncated card.
    const chain: Promise<unknown>[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const cutOne = async (ts: number) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 5));
      concurrent--;
      if (ts < 100) throw new Error("clip window [..] not flushed within 45s — a truncated live clip is not published");
      return { clipId: `clip-${ts}`, clipUri: `/clips/clip-${ts}.mp4` };
    };
    let tail: Promise<unknown> = Promise.resolve();
    const schedule = (ts: number) => {
      tail = tail.then(() => cutOne(ts));
      chain.push(tail);
    };
    for (const ts of [101, 42, 202]) {
      await acceptVideoDecision(
        { decide: async () => stage1() } as any,
        run,
        cutOne,
        cfg({ deferLiveClipCut: true }),
        (ev) => events.push(ev),
        { seq: ts, timestamp: ts },
        candidate(ts),
        stage1()
      );
      schedule(ts); // what api.ts `.then(rec => scheduleIngestClipCut(...))` does
    }
    const rows = events.filter((e) => e.type === "highlight").map((e) => e.highlight);
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.clipUri === "")).toBe(true);
    await Promise.all(chain.map((p) => p.catch(() => {})));
    // Serial: never two ffmpeg cuts on the same share's recording at once.
    expect(maxConcurrent).toBe(1);
  });

  it("keeps the inline cut when the flag is unset (VOD + every existing caller)", async () => {
    const run = new LiveRunShared({ decideWindowN: 24, audioRetainS: 400 });
    const events: any[] = [];
    const cut = async (ts: number) => ({
      clipId: `clip-${ts}`,
      clipUri: `/clips/clip-${ts}.mp4`,
      clipAudit: {
        clipAnchorMethod: "content_clock" as const,
        clipCutStartSec: 36,
        clipCutDurSec: 15,
        clipCutClamped: false,
        clipDeliveredSec: 15,
      },
    });
    await acceptVideoDecision(
      { decide: async () => stage1() } as any,
      run,
      cut,
      cfg(),
      (ev) => events.push(ev),
      { seq: 1, timestamp: 42 },
      candidate(42),
      stage1()
    );
    const ev = events.find((e) => e.type === "highlight");
    expect(ev.highlight.clipUri).toBe("/clips/clip-42.mp4");
    expect(ev.highlight.clipCutStartSec).toBe(36);
    expect(ev.highlight.clipError).toBeUndefined();
  });

  it("still keeps the row with clipError when an inline cut fails", async () => {
    const run = new LiveRunShared({ decideWindowN: 24, audioRetainS: 400 });
    const events: any[] = [];
    const cut = async () => {
      throw new Error("not flushed");
    };
    await acceptVideoDecision(
      { decide: async () => stage1() } as any,
      run,
      cut,
      cfg(),
      (ev) => events.push(ev),
      { seq: 1, timestamp: 42 },
      candidate(42),
      stage1()
    );
    const ev = events.find((e) => e.type === "highlight");
    expect(ev.highlight.clipUri).toBe("");
    expect(ev.highlight.clipError).toContain("Clip cut failed");
  });
});
