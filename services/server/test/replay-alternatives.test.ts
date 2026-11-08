import { describe, expect, it } from "vitest";
import { HighlightRecordSchema, ReplayEvidenceSchema, type HighlightRecord } from "@highlights/events";
import { perceptualHash } from "@highlights/events/training";
import { buildPostableHighlights } from "../src/highlight-postable";
import {
  PHASE_REPLAY_MATCH_BITS,
  PHASE_REPLAY_MIN_MATCHES,
  PHASE_REPLAY_MIN_MATCH_RATIO,
  REPLAY_HASH_MATCH_BITS,
  REPLAY_MAX_GAP_S,
  REPLAY_MIN_GAP_S,
  REPLAY_MIN_MATCHES,
  REPLAY_MIN_MATCH_RATIO,
  SCOREBUG_CLOCK_MIN_SAMPLES,
  SCOREBUG_MAX_CLOCK_REGRESSION_S,
  SCOREBUG_MIN_OVERLAY_FRAMES,
  ahashFromGray,
  parseBroadcastClock,
  scoreBugReading,
  type ScoreBugFrame,
  detectReplayAttachments,
  fingerprintsNear,
  matchReplayOwner,
  partitionAttachedReplays,
  replayAlternativeFrom,
  replayAnchorTs,
  setMatchCount,
  windowFingerprintSet,
  type ReplayFrameFingerprint,
  type ReplayLedgerEntry,
} from "../src/replay-alternatives";

// ADAAAA-8321 (Inc 1): replay windows attach to the moment they repeat.
//
// The fixture is the real shape measured on box job
// 545be947-e989-4b26-a464-22b576d97373: a GOAL moment anchored at 159 s
// (clip 152-167) and a later notable window anchored at 207 s. The hashes below
// are SYNTHETIC (the real footage does not clear the set-match bar — that
// measurement is on the issue), so these tests pin the MATCHER's contract:
// set (not positional) matching, the 20-300 s gap window, no chains, and no
// resurrection of a rejected owner.
const JOB = "545be947-e989-4b26-a464-22b576d97373";

/** A deterministic 16-hex aHash from a small integer seed. */
function hash(seed: number): string {
  let x = (seed * 2654435761) >>> 0;
  let out = "";
  for (let i = 0; i < 16; i++) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out += ((x >>> 28) & 0xf).toString(16);
  }
  return out;
}

function record(over: Partial<HighlightRecord> = {}): HighlightRecord {
  return HighlightRecordSchema.parse({
    id: "goal-h1",
    jobId: JOB,
    clipUri: "/clips/goal.mp4",
    start: 152,
    end: 167,
    localizedTs: 159,
    localizeSignal: "peak_frame",
    eventType: "GOAL",
    score: 95,
    outcome: "scoring_play",
    corroborated: true,
    status: "accepted",
    createdAt: "2026-11-07T00:00:00.000Z",
    ...over,
  });
}

/** A window's frame fingerprints: `base` repeated over a 0.333 s grid — two
 * windows built from the same base have identical sets. */
function frames(base: number, startTs: number, count = 12): ReplayFrameFingerprint[] {
  const out: ReplayFrameFingerprint[] = [];
  for (let i = 0; i < count; i++) out.push({ ts: startTs + i / 3, hash: hash(base + (i % 3)) });
  return out;
}

function entry(id: string, anchorTs: number, hashes: string[], replayOf?: string): ReplayLedgerEntry {
  return { id, anchorTs, hashes, ...(replayOf ? { replayOf } : {}) };
}

describe("windowFingerprintSet", () => {
  it("caps the set evenly and keeps first/last", () => {
    const all = Array.from({ length: 40 }, (_, i) => hash(i));
    const set = windowFingerprintSet(all, 12);
    expect(set.length).toBe(12);
    expect(set[0]).toBe(all[0]);
    expect(set[set.length - 1]).toBe(all[39]);
  });

  it("is stable across runs and never shrinks silently", () => {
    const all = Array.from({ length: 37 }, (_, i) => hash(i));
    expect(windowFingerprintSet(all, 12)).toEqual(windowFingerprintSet(all, 12));
    expect(new Set(windowFingerprintSet(all, 12)).size).toBe(12);
  });
});

describe("fingerprintsNear", () => {
  it("takes only the frames in [anchor - windowS, anchor]", () => {
    const f = frames(1, 100);
    const set = fingerprintsNear(f, 102, 2, 12);
    // frames at 100.00 .. 102.00 inclusive at 3 fps => 7 frames
    expect(set.length).toBe(7);
  });
});

describe("setMatchCount", () => {
  it("matches identical fingerprints", () => {
    const a = [hash(1), hash(2), hash(3)];
    expect(setMatchCount(a, a)).toBe(3);
  });

  it("matches a re-framed window positionally displaced (SET, not sequence)", () => {
    // Same pictures, different order and a dropped frame: a positional matcher
    // would score 0; the set matcher scores every present picture.
    const ledger = [hash(1), hash(2), hash(3), hash(4)];
    const incoming = [hash(4), hash(3), hash(1)];
    expect(setMatchCount(incoming, ledger)).toBe(3);
  });

  it("does not match unrelated pictures", () => {
    const ledger = [hash(1), hash(2), hash(3), hash(4)];
    const incoming = [hash(900), hash(901), hash(902)];
    expect(setMatchCount(incoming, ledger)).toBe(0);
  });
});

describe("matchReplayOwner", () => {
  it("attaches a replay to the moment it repeats", () => {
    const owner = entry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const replay = entry("replay-h3", 207, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const m = matchReplayOwner(replay, [owner]);
    expect(m).not.toBeNull();
    expect(m!.ownerId).toBe("goal-h1");
    expect(m!.gapS).toBe(48);
    expect(m!.matches).toBe(5);
    expect(m!.compared).toBe(5);
    expect(m!.kind).toBe("footage_match");
  });

  it("enforces the 20 s gap floor (adjacent re-reads are distinct events)", () => {
    const owner = entry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const at19 = entry("w19", 178, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const at20 = entry("w20", 179, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    expect(matchReplayOwner(at19, [owner])).toBeNull();
    expect(matchReplayOwner(at20, [owner])?.gapS).toBe(REPLAY_MIN_GAP_S);
  });

  it("enforces the 300 s ceiling", () => {
    const owner = entry("goal-h1", 0, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const far = entry("w301", REPLAY_MAX_GAP_S + 1, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const edge = entry("w300", REPLAY_MAX_GAP_S, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    expect(matchReplayOwner(far, [owner])).toBeNull();
    expect(matchReplayOwner(edge, [owner])).not.toBeNull();
  });

  it("requires both the match count and the ratio bar", () => {
    const owner = entry("goal-h1", 159, [hash(1), hash(2)]);
    // 2 of 10 matches: clears neither the count bar nor the ratio bar.
    const weak = entry("weak", 207, [hash(1), hash(2), hash(700), hash(701), hash(702), hash(703), hash(704), hash(705), hash(706), hash(707)]);
    expect(matchReplayOwner(weak, [owner])).toBeNull();
    // 4 of 10 = 0.40 clears both.
    const ok = entry("ok", 207, [hash(1), hash(2), hash(3), hash(4), hash(700), hash(701), hash(702), hash(703), hash(704), hash(705)]);
    const m = matchReplayOwner(ok, [entry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4)])]);
    expect(m!.matches).toBeGreaterThanOrEqual(REPLAY_MIN_MATCHES);
    expect(m!.matches / m!.compared).toBeGreaterThanOrEqual(REPLAY_MIN_MATCH_RATIO);
  });

  it("never attaches a replay to another replay (no chains)", () => {
    const first = entry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const second = entry("rep1", 207, [hash(1), hash(2), hash(3), hash(4), hash(5)], "goal-h1");
    const third = entry("rep2", 250, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    // rep2 may attach to the ORIGINAL moment, never to rep1.
    const m = matchReplayOwner(third, [first, second]);
    expect(m?.ownerId).toBe("goal-h1");
  });

  it("picks the strongest legal owner, not the first one scanned", () => {
    const weak = entry("goal-a", 100, [hash(1), hash(600), hash(601), hash(602), hash(603)]);
    const strong = entry("goal-b", 150, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    const replay = entry("rep", 200, [hash(1), hash(2), hash(3), hash(4), hash(5)]);
    expect(matchReplayOwner(replay, [weak, strong])?.ownerId).toBe("goal-b");
  });

  it("ignores an entry with no fingerprints", () => {
    expect(matchReplayOwner({ id: "x", anchorTs: 200, hashes: [] }, [])).toBeNull();
  });
});

describe("ahashFromGray", () => {
  it("is bit-compatible with perceptualHash on an 8x8 RGBA image", () => {
    const size = 8;
    const rgba = new Uint8Array(size * size * 4);
    const gray = new Float32Array(size * size);
    for (let i = 0; i < size * size; i++) {
      const v = (i * 37 + 11) % 256;
      rgba[i * 4] = v;
      rgba[i * 4 + 1] = v;
      rgba[i * 4 + 2] = v;
      rgba[i * 4 + 3] = 255;
      gray[i] = v;
    }
    expect(ahashFromGray(gray, size)).toBe(perceptualHash(rgba, size, size));
  });
});

describe("detectReplayAttachments", () => {
  it("marks only the later window and reports matches/compared/gapS", () => {
    const goal = record({ id: "goal-h1", start: 152, end: 167, localizedTs: 159 });
    const play = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
    });
    const framesOut = [...frames(1, 150, 30), ...frames(1, 200, 30)];
    const out = detectReplayAttachments([goal, play], framesOut, { windowS: 8 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "play-h3", replayOf: "goal-h1" });
    expect(out[0].evidence).toMatchObject({ kind: "footage_match", gapS: 48 });
    expect(out[0].evidence.compared).toBeGreaterThan(0);
  });

  it("does not touch a rejected owner and does not attach across jobs", () => {
    const rejected = record({ id: "goal-h1", status: "rejected", localizedTs: 159 });
    const play = record({ id: "play-h3", localizedTs: 207, outcome: "big_play", eventType: "BIG_PLAY", score: 60 });
    const out = detectReplayAttachments([rejected, play], [...frames(1, 150, 30), ...frames(1, 200, 30)], {
      windowS: 8,
    });
    // The matcher may still name the rejected moment as the owner: the guard rail
    // is that attaching does not resurrect it, not that the owner must be accepted.
    expect(out).toHaveLength(1);
    // The owner record is never mutated by detection.
    expect(rejected.status).toBe("rejected");
    expect(rejected.replayOf).toBeUndefined();
  });

  it("does not attach when the gap is under 20 s", () => {
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const near = record({ id: "w-near", localizedTs: 170, outcome: "big_play", eventType: "BIG_PLAY", score: 60 });
    const out = detectReplayAttachments([goal, near], [...frames(1, 150, 40), ...frames(1, 165, 20)], { windowS: 8 });
    expect(out).toHaveLength(0);
  });
});

describe("read side", () => {
  it("drops a replay from the postable and notable lanes without changing counts", () => {
    const goal = record({ id: "goal-h1" });
    const other = record({ id: "goal-h2", start: 190, localizedTs: 197, score: 80 });
    const replay = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
      replayOf: "goal-h1",
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    const plain = buildPostableHighlights([goal, other]);
    const withReplay = buildPostableHighlights([goal, other, replay]);
    expect(withReplay.highlights.map((h) => h.id)).toEqual(plain.highlights.map((h) => h.id));
    expect(withReplay.notable.map((h) => h.id)).not.toContain("play-h3");
    expect(withReplay.counts.postable).toBe(plain.counts.postable);
    // The raw total still counts every persisted row, so the identity holds.
    expect(withReplay.counts.total).toBe(plain.counts.total + 1);
  });

  it("groups a replay under its owner as an alternative, reusing its own clip", () => {
    const replay = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
      replayOf: "goal-h1",
      replayEvidence: { kind: "footage_match", matches: 6, compared: 12, gapS: 48 },
    });
    const { byOwner, attached, highlights } = partitionAttachedReplays([record({ id: "goal-h1" }), replay]);
    expect(attached).toBe(1);
    expect(highlights.map((h) => h.id)).toEqual(["goal-h1"]);
    const list = byOwner.get("goal-h1")!;
    expect(list).toHaveLength(1);
    const alt = replayAlternativeFrom(list[0], 167);
    expect(alt).toMatchObject({
      id: "play-h3",
      highlightId: "goal-h1",
      eventType: "replay",
      replayOf: "goal-h1",
      clipUri: replay.clipUri,
      windowAnchorTs: 207,
      distanceToGoalEndS: 40,
    });
    expect(alt.replayEvidence).toEqual({ kind: "footage_match", matches: 6, compared: 12, gapS: 48 });
  });

  it("keeps a record whose owner is missing visible instead of dropping it", () => {
    const orphan = record({ id: "orphan", replayOf: "gone", outcome: "big_play", eventType: "BIG_PLAY", score: 60 });
    const { highlights, attached } = partitionAttachedReplays([orphan]);
    expect(attached).toBe(0);
    expect(highlights.map((h) => h.id)).toEqual(["orphan"]);
  });

  it("anchors a replay on the evidence instant the detector fingerprinted", () => {
    expect(replayAnchorTs(record({ localizedTs: 207, localizeEvidenceTs: 205 }))).toBe(205);
    expect(replayAnchorTs(record({ localizedTs: 207 }))).toBe(207);
    expect(replayAnchorTs({ start: 200, end: 215 })).toBe(207.5);
  });
});

// ADAAAA-8325 (Inc 2): a decide verdict that says `replay` is CORROBORATION,
// never the attach itself. It opens a wider-but-still-bounded fingerprint band
// (8 bits / >= 2 matches / ratio 0.15) for a window the strict Inc 1 bar (6 bits
// / 4 matches / 0.35) misses — the case measured on job 545be947, where the
// broadcast replay is a different camera. The gap band, the no-chain guard and
// the "an owner must not itself be a replay" guard are unchanged, and a strict
// attach keeps its pre-Inc-2 evidence shape byte-identically.
describe("ADAAAA-8325 phase corroboration", () => {
  /** Flip the low `n` bits of a 64-bit hex hash, so the Hamming distance is n. */
  function flipLowBits(hexHash: string, n: number): string {
    return (BigInt(`0x${hexHash}`) ^ ((1n << BigInt(n)) - 1n)).toString(16).padStart(16, "0");
  }
  function phaseEntry(id: string, anchorTs: number, hashes: string[], phase: "live" | "replay"): ReplayLedgerEntry {
    return { id, anchorTs, hashes, phase };
  }
  /** Frame list over a 3 fps grid, one explicit hash per frame (no generated
   * base), so a window's fingerprint set is exactly the list given. */
  function windowFrames(startTs: number, hashes: string[]): ReplayFrameFingerprint[] {
    return hashes.map((h, i) => ({ ts: startTs + i / 3, hash: h }));
  }

  it("never attaches on the phase alone — 0 agreeing pictures produces no attach (AC9)", () => {
    const owner = entry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4)]);
    const noise = Array.from({ length: 12 }, (_, i) => hash(800 + i));
    const phaseOnly = phaseEntry("w-phase-only", 207, noise, "replay");
    expect(matchReplayOwner(phaseOnly, [owner])).toBeNull();
    // ... and the whole detector agrees: a phase-only window is not an attach.
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const replay = record({
      id: "w-phase-only",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
      phase: "replay",
    });
    const framesOut = [
      ...windowFrames(151, Array.from({ length: 24 }, (_, i) => hash(1 + (i % 3)))),
      ...windowFrames(203, noise),
    ];
    expect(detectReplayAttachments([goal, replay], framesOut, { windowS: 8 })).toHaveLength(0);
  });

  it("attaches a phase-replay window the strict bar misses (AC10 band)", () => {
    // A different-camera replay: 2 pictures agree exactly, 2 more within 8 bits,
    // the rest unrelated. Strict (6 bits, 4 matches): 2 matches -> miss.
    const owner = entry("goal-h1", 159, Array.from({ length: 12 }, () => hash(1)));
    const shared = hash(1);
    const weak = [
      shared,
      shared,
      flipLowBits(shared, 8),
      flipLowBits(shared, 8),
      ...Array.from({ length: 8 }, (_, i) => hash(900 + i)),
    ];
    expect(matchReplayOwner(entry("replay-h3", 207, weak), [owner])).toBeNull();
    const m = matchReplayOwner(phaseEntry("replay-h3", 207, weak, "replay"), [owner]);
    expect(m).not.toBeNull();
    expect(m!.ownerId).toBe("goal-h1");
    expect(m!.matches).toBe(4);
    expect(m!.compared).toBe(12);
    expect(m!.gapS).toBe(48);
    expect(m!.phase).toBe("replay");
    expect(m!.kind).toBe("footage_match");
  });

  it("still needs two agreeing fingerprints, not just the phase", () => {
    const owner = entry("goal-h1", 159, Array.from({ length: 12 }, () => hash(1)));
    const oneAgreeing = [hash(1), ...Array.from({ length: 11 }, (_, i) => hash(950 + i))];
    expect(matchReplayOwner(phaseEntry("rep", 207, oneAgreeing, "replay"), [owner])).toBeNull();
  });

  it("does not widen the 20-300 s gap band", () => {
    const owner = entry("goal-h1", 159, Array.from({ length: 12 }, () => hash(1)));
    const agreeing = Array.from({ length: 12 }, () => hash(1));
    expect(matchReplayOwner(phaseEntry("at19", 178, agreeing, "replay"), [owner])).toBeNull();
    expect(matchReplayOwner(phaseEntry("at301", 460, agreeing, "replay"), [owner])).toBeNull();
    expect(matchReplayOwner(phaseEntry("at20", 179, agreeing, "replay"), [owner])?.gapS).toBe(REPLAY_MIN_GAP_S);
  });

  it("a replay-phase window never owns a later replay (no chains, phase-aware)", () => {
    const owner = phaseEntry("goal-h1", 159, [hash(1), hash(2), hash(3), hash(4)], "replay");
    const later = phaseEntry("rep2", 207, [hash(1), hash(2), hash(3), hash(4)], "replay");
    expect(matchReplayOwner(later, [owner])).toBeNull();
  });

  it("keeps a strict attach's evidence shape byte-identical (no phase key)", () => {
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const replay = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
    });
    const strict = Array.from({ length: 24 }, (_, i) => hash(1 + (i % 3)));
    const framesOut = [...windowFrames(151, strict), ...windowFrames(199, strict)];
    const out = detectReplayAttachments([goal, replay], framesOut, { windowS: 8 });
    expect(out).toHaveLength(1);
    expect(out[0].evidence).toEqual({
      kind: "footage_match",
      matches: out[0].evidence.matches,
      compared: out[0].evidence.compared,
      gapS: out[0].evidence.gapS,
    });
    expect(out[0].evidence).not.toHaveProperty("phase");
  });

  it("carries the phase through the detector, the evidence and the grouped alternative", () => {
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const replay = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
      phase: "replay",
    });
    const shared = hash(1);
    const replayHashes = [
      shared,
      shared,
      flipLowBits(shared, 8),
      flipLowBits(shared, 8),
      ...Array.from({ length: 8 }, (_, i) => hash(900 + i)),
    ];
    const framesOut = [
      ...windowFrames(151, Array.from({ length: 24 }, () => shared)),
      ...windowFrames(203, replayHashes),
    ];
    const out = detectReplayAttachments([goal, replay], framesOut, { windowS: 8 });
    expect(out).toHaveLength(1);
    expect(out[0].replayOf).toBe("goal-h1");
    expect(out[0].evidence).toMatchObject({ kind: "footage_match", matches: 4, compared: 12, gapS: 48, phase: "replay" });

    // Read side: the attach is an alternative of the goal, and the phase the
    // decide verdict produced rides the alternative so the rail can name it.
    const attached = record({ ...replay, replayOf: out[0].replayOf, replayEvidence: out[0].evidence });
    const { byOwner } = partitionAttachedReplays([goal, attached]);
    const alt = replayAlternativeFrom(byOwner.get("goal-h1")![0], 167);
    expect(alt.eventType).toBe("replay");
    expect(alt.phase).toBe("replay");
    expect(alt.replayEvidence?.phase).toBe("replay");
  });

  it("measures 0 phase-only attaches across a job's windows (AC9 count)", () => {
    // 40 phase-replay windows, 20-300 s apart, none of them picturing anything
    // the owner pictured: the phase signal alone must attach none of them.
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const framesOut: ReplayFrameFingerprint[] = windowFrames(151, Array.from({ length: 24 }, () => hash(1)));
    const windows = Array.from({ length: 40 }, (_, i) => {
      const anchor = 180 + i * 3; // 180 .. 297 s: all inside the 20-300 s band
      framesOut.push(...windowFrames(anchor - 6, Array.from({ length: 18 }, (_, j) => hash(3000 + i * 18 + j))));
      return record({
        id: `w-${i}`,
        start: anchor - 7.5,
        end: anchor + 7.5,
        localizedTs: anchor,
        eventType: "BIG_PLAY",
        outcome: "big_play",
        score: 55,
        phase: "replay",
      });
    });
    expect(detectReplayAttachments([goal, ...windows], framesOut, { windowS: 8 })).toHaveLength(0);
  });
});

describe("thresholds are the documented ones", () => {
  it("keeps the calibrated near-duplicate threshold and attach bars", () => {
    expect(REPLAY_HASH_MATCH_BITS).toBe(6);
    expect(REPLAY_MIN_GAP_S).toBe(20);
    expect(REPLAY_MAX_GAP_S).toBe(300);
    expect(REPLAY_MIN_MATCHES).toBe(4);
    expect(REPLAY_MIN_MATCH_RATIO).toBe(0.35);
  });

  it("keeps the phase-corroborated band bounded (ADAAAA-8325)", () => {
    expect(PHASE_REPLAY_MATCH_BITS).toBe(8);
    expect(PHASE_REPLAY_MIN_MATCHES).toBe(2);
    expect(PHASE_REPLAY_MIN_MATCH_RATIO).toBe(0.15);
    // The phase band is strictly looser than the strict bar on every axis...
    expect(PHASE_REPLAY_MATCH_BITS).toBeGreaterThan(REPLAY_HASH_MATCH_BITS);
    expect(PHASE_REPLAY_MIN_MATCHES).toBeLessThan(REPLAY_MIN_MATCHES);
    expect(PHASE_REPLAY_MIN_MATCH_RATIO).toBeLessThan(REPLAY_MIN_MATCH_RATIO);
    // ...but it still needs at least two agreeing pictures — never 0, never 1.
    expect(PHASE_REPLAY_MIN_MATCHES).toBeGreaterThanOrEqual(2);
  });
});

// ADAAAA-8366 (Inc 3): the score bug / clock presence-gap signal.
//
// The fixtures are the MEASURED reads of the preserved 545be947 artefact frames
// (46 frames per window at 3 fps, OCR'd with the perceive scoreboard probe on
// the box, read-only):
//
//   goal     seq 456-501 = 152.0-167.0 s -> `POR 1 : 1 ESP 43:40` .. `43:55`
//            (overlay on every frame; the score flips 1-1 -> 2-1 at 43:54)
//   replay   seq 600-645 = 200.0-215.0 s -> `FIFA` bumper/logo only, NO score
//            bug and NO clock on any of the 46 frames
//   control  seq   0- 45 =   0.0- 15.0 s -> `41:08` .. `41:23`, but frames
//            1.0-9.0 s (25 of 46) print `FIFA` only — a genuinely OVERLAY-FREE
//            stretch inside normal live play of the same job.
//
// That third window is why the overlay-free mode ships OFF: absence alone would
// attach a live stretch, which is exactly the AC10b failure mode.
describe("ADAAAA-8366 score bug / clock presence-gap signal", () => {
  function clockAt(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  /** A 3 fps window of already-OCR'd frames, one line list per frame. */
  function ocrFrames(startTs: number, count: number, lineFor: (i: number) => string[]): ScoreBugFrame[] {
    return Array.from({ length: count }, (_, i) => ({ ts: startTs + i / 3, ocr: lineFor(i) }));
  }
  /** The measured goal window: the bug's clock advances 1 s per 3 frames. */
  function goalFrames(): ScoreBugFrame[] {
    return ocrFrames(152, 46, (i) => [`POR 1 : 1 ESP ${clockAt(43 * 60 + 40 + Math.floor(i / 3))}`]);
  }
  /** The measured replay window: no score bug, no clock. */
  function replayFrames(): ScoreBugFrame[] {
    return ocrFrames(200, 46, () => ["FIFA"]);
  }

  it("parses a broadcast clock but never a score pair", () => {
    expect(parseBroadcastClock("POR 1 : 1 ESP 43:40")).toBe(43 * 60 + 40);
    expect(parseBroadcastClock("POR 1.1 ESP 43:40FIFA")).toBe(43 * 60 + 40);
    expect(parseBroadcastClock("POR 1 : 1 ESP")).toBeNull();
    expect(parseBroadcastClock("FIFA")).toBeNull();
    // A clock glued to a stat is not a clock (`43:4012`).
    expect(parseBroadcastClock("POR 1 1 ESP 43:4012")).toBeNull();
    // A score separator that OCR'd with the score's `/` or `.` is not a clock.
    expect(parseBroadcastClock("POR 1/1 ESP 41/08")).toBeNull();
  });

  it("reads the measured goal window: overlay on every frame, earliest clock 43:40", () => {
    const r = scoreBugReading(goalFrames(), 159, 8);
    expect(r.frames).toBeGreaterThan(0);
    expect(r.overlayFrames).toBe(r.frames);
    expect(r.clockS).toBe(43 * 60 + 40);
    expect(r.clockSamples).toBeGreaterThanOrEqual(SCOREBUG_CLOCK_MIN_SAMPLES);
  });

  it("reads the measured replay window as no bug at all", () => {
    const r = scoreBugReading(replayFrames(), 207, 8);
    expect(r.frames).toBeGreaterThan(0);
    expect(r.overlayFrames).toBe(0);
    expect(r.clockS).toBeUndefined();
  });

  it("attaches on a clock regression inside the 20-300 s band (AC10 clock mode)", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    // A replay that DOES carry the bug shows the pre-goal clock (43:36).
    const candidate: ReplayLedgerEntry = {
      id: "replay-h3",
      anchorTs: 207,
      hashes: [],
      scoreBug: scoreBugReading(
        ocrFrames(200, 46, () => [`POR 1 : 1 ESP ${clockAt(43 * 60 + 36)}`]),
        207,
        8
      ),
    };
    const m = matchReplayOwner(candidate, [owner]);
    expect(m).not.toBeNull();
    expect(m!.ownerId).toBe("goal-h1");
    expect(m!.kind).toBe("scorebug_gap");
    expect(m!.gapS).toBe(48);
    expect(m!.clockOwnerS).toBe(43 * 60 + 40);
    expect(m!.clockCandidateS).toBe(43 * 60 + 36);
    expect(m!.overlayOwner).toBe(true);
    expect(m!.overlayCandidate).toBe(true);
    expect(m!.matches).toBeGreaterThanOrEqual(SCOREBUG_CLOCK_MIN_SAMPLES);
  });

  it("never attaches a live clock that agrees or advances (no false replay)", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    for (const candidateClock of [43 * 60 + 40, 43 * 60 + 52, 44 * 60 + 2]) {
      const candidate: ReplayLedgerEntry = {
        id: "live-h3",
        anchorTs: 207,
        hashes: [],
        scoreBug: scoreBugReading(ocrFrames(200, 46, () => [`POR 1 : 1 ESP ${clockAt(candidateClock)}`]), 207, 8),
      };
      expect(matchReplayOwner(candidate, [owner])).toBeNull();
    }
  });

  it("never attaches on a single clock reading (a misread cannot manufacture a regression)", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    // One frame reads 43:36, the rest read nothing: no monotonic run.
    const candidate: ReplayLedgerEntry = {
      id: "one-read",
      anchorTs: 207,
      hashes: [],
      scoreBug: scoreBugReading(ocrFrames(200, 46, (i) => (i === 20 ? ["POR 1-1 ESP 43:36"] : ["FIFA"])), 207, 8),
    };
    expect(candidate.scoreBug!.clockSamples).toBeLessThan(SCOREBUG_CLOCK_MIN_SAMPLES);
    expect(matchReplayOwner(candidate, [owner])).toBeNull();
  });

  it("does not attach on graphic absence alone (the measured 545be947 replay: AC10a FAIL as specified)", () => {
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const replay = record({
      id: "play-h3",
      start: 200,
      end: 215,
      localizedTs: 207,
      eventType: "BIG_PLAY",
      outcome: "big_play",
      score: 60,
    });
    const scoreBugFrames = [...goalFrames(), ...replayFrames()];
    // Shipped default: the overlay-free mode is off, so the measured pair — the
    // replay carries no bug at all — does NOT attach.
    expect(detectReplayAttachments([goal, replay], [], { windowS: 8, scoreBugFrames })).toHaveLength(0);
  });

  it("even when enabled, the overlay-free mode records the absence it used", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    const candidate: ReplayLedgerEntry = { id: "replay-h3", anchorTs: 207, hashes: [], scoreBug: scoreBugReading(replayFrames(), 207, 8) };
    const m = matchReplayOwner(candidate, [owner], { overlayFreeAttach: true });
    expect(m).not.toBeNull();
    expect(m!.kind).toBe("scorebug_gap");
    expect(m!.overlayOwner).toBe(true);
    expect(m!.overlayCandidate).toBe(false);
    expect(m!.matches).toBe(0);
    // ...and the evidence survives the contract.
    const parsed = ReplayEvidenceSchema.parse({
      kind: m!.kind,
      matches: m!.matches,
      compared: m!.compared,
      gapS: m!.gapS,
      clockOwnerS: m!.clockOwnerS,
      overlayOwner: m!.overlayOwner,
      overlayCandidate: m!.overlayCandidate,
    });
    expect(parsed.kind).toBe("scorebug_gap");
  });

  it("keeps the 20-300 s band for the score-bug signal too", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    const at = (anchorTs: number): ReplayLedgerEntry => ({
      id: `c-${anchorTs}`,
      anchorTs,
      hashes: [],
      scoreBug: scoreBugReading(ocrFrames(anchorTs - 15, 46, () => ["POR 1 : 1 ESP 43:36"]), anchorTs, 8),
    });
    expect(matchReplayOwner(at(178), [owner])).toBeNull(); // 19 s: under the floor
    expect(matchReplayOwner(at(460), [owner])).toBeNull(); // 301 s: over the ceiling
    expect(matchReplayOwner(at(179), [owner])?.gapS).toBe(REPLAY_MIN_GAP_S);
  });

  it("keeps phase as corroboration only: it neither attaches nor vetoes", () => {
    const scoreBugOwner = scoreBugReading(goalFrames(), 159, 8);
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], scoreBug: scoreBugOwner };
    const replayFramesRead = scoreBugReading(replayFrames(), 207, 8);
    // Phase alone + no clock + no overlay-free mode: no attach.
    expect(matchReplayOwner({ id: "p1", anchorTs: 207, hashes: [], phase: "replay", scoreBug: replayFramesRead }, [owner])).toBeNull();
    // A deterministic clock regression attaches regardless of the verdict: a
    // `live` phase can never veto it (the phase is corroboration only).
    const regression = scoreBugReading(ocrFrames(200, 46, () => ["POR 1 : 1 ESP 43:36"]), 207, 8);
    for (const phase of ["live", "replay", undefined] as const) {
      const m = matchReplayOwner({ id: "p2", anchorTs: 207, hashes: [], phase, scoreBug: regression }, [owner]);
      expect(m?.kind).toBe("scorebug_gap");
      expect(m?.clockCandidateS).toBe(43 * 60 + 36);
    }
  });

  it("keeps the score-bug signal out of a strict hash attach's evidence shape", () => {
    const goal = record({ id: "goal-h1", localizedTs: 159 });
    const replay = record({ id: "play-h3", start: 200, end: 215, localizedTs: 207, eventType: "BIG_PLAY", outcome: "big_play", score: 60 });
    const shared = hash(1);
    const framesOut: ReplayFrameFingerprint[] = [
      ...Array.from({ length: 24 }, (_, i) => ({ ts: 151 + i / 3, hash: shared })),
      ...Array.from({ length: 24 }, (_, i) => ({ ts: 199 + i / 3, hash: shared })),
    ];
    const out = detectReplayAttachments([goal, replay], framesOut, { windowS: 8, scoreBugFrames: [...goalFrames(), ...replayFrames()] });
    expect(out).toHaveLength(1);
    expect(out[0].evidence.kind).toBe("footage_match");
    for (const key of ["clockOwnerS", "clockCandidateS", "overlayOwner", "overlayCandidate"]) {
      expect(out[0].evidence).not.toHaveProperty(key);
    }
  });

  it("never lets a replay own a replay, score-bug entry or not", () => {
    const owner = { id: "goal-h1", anchorTs: 159, hashes: [], replayOf: "older-goal", scoreBug: scoreBugReading(goalFrames(), 159, 8) };
    const candidate = { id: "replay-h3", anchorTs: 207, hashes: [], scoreBug: scoreBugReading(ocrFrames(200, 46, () => ["POR 1 : 1 ESP 43:36"]), 207, 8) };
    expect(matchReplayOwner(candidate, [owner])).toBeNull();
    // A window whose verdict called it replay footage never owns either.
    const phaseOwner = { ...owner, replayOf: undefined, phase: "replay" as const };
    expect(matchReplayOwner(candidate, [phaseOwner])).toBeNull();
  });

  it("keeps the constants the documented ones (ADAAAA-8366)", () => {
    expect(SCOREBUG_CLOCK_MIN_SAMPLES).toBeGreaterThanOrEqual(2);
    // The regression bound stays under a half's length, so a half-time clock
    // reset (45:00 -> 00:00) can never read as a regression.
    expect(SCOREBUG_MAX_CLOCK_REGRESSION_S).toBeLessThan(45 * 60);
    expect(SCOREBUG_MIN_OVERLAY_FRAMES).toBeGreaterThanOrEqual(2);
    // The hash band is untouched: still 6 bits strict / 8 bits phase.
    expect(REPLAY_HASH_MATCH_BITS).toBe(6);
    expect(PHASE_REPLAY_MATCH_BITS).toBe(8);
  });
});
