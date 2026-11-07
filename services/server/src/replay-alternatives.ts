// ADAAAA-8321 (Inc 1): a replay window — footage that repeats a moment the same
// VOD job already decided — delivered as an ALTERNATIVE of that moment, never as
// a second highlight and never with new GPU work.
//
// The detector is a job-scoped fingerprint ledger: every decided moment keeps a
// small SET of perceptual hashes taken from frames the job already extracted.
// A later window whose set matches an earlier moment's set (with a 20-300 s gap)
// acquires `replayOf` = that moment. The match is a SET match (every fingerprint
// in the new window is compared against every fingerprint in the owner's set),
// never positional, so a re-framed, cropped or letterboxed repeat still counts.
//
// Guard rails (all enforced here, all unit-tested):
//   * a replay never attaches to another replay (single owner, no chains);
//   * attaching never writes the owner — its status/score/outcome are untouched;
//   * a replay is never postable (the read side filters `replayOf` rows), so a
//     rejected moment is never resurrected by an attach;
//   * the gap floor is 20 s (SHOOTOUT_KICK_DEDUP_S is 8 s: adjacent re-reads of
//     one incident and shootout kicks 13-18 s apart are DISTINCT events);
//   * audio can only corroborate, never be the sole signal — Inc 1 emits
//     `footage_match` only.
//
// Delivery reuses the ADAAAA-7984 alternative lane: the replay record already
// has its own clip (`clipUri`), so no second cut, no second quota debit and no
// second billing entry happens. The read side projects the marked record into a
// `HighlightAlternative` with `eventType: "replay"`.
import {
  HIGHLIGHT_ALTERNATIVE_RELATION,
  REPLAY_ALTERNATIVE_EVENT_TYPE,
  type HighlightAlternative,
  type HighlightRecord,
  type ReplayEvidence,
} from "@highlights/events";
import { phashHammingDistance } from "@highlights/events/training";

/** Floor/ceiling of the gap between a replay and the moment it repeats. The
 * floor is 20 s because `SHOOTOUT_KICK_DEDUP_S` (8 s) exists precisely because
 * adjacent re-reads of one incident, and shootout kicks, are 13-18 s apart and
 * are distinct events. */
export const REPLAY_MIN_GAP_S = 20;
export const REPLAY_MAX_GAP_S = 300;

/** Hamming distance at which two 8x8 aHash fingerprints count as the same
 * picture. 6 bits is the near-duplicate threshold the training splitter already
 * uses (`bucketNearDuplicates`), so the detector inherits a calibrated value
 * rather than inventing one. */
export const REPLAY_HASH_MATCH_BITS = 6;

/** Attach bar: at least this many of the new window's fingerprints must match,
 * AND at least this share of the compared set. Both are needed: a single lucky
 * frame is not a replay, and a sparse window with 2 matches must not look like
 * a strong one. */
export const REPLAY_MIN_MATCHES = 4;
export const REPLAY_MIN_MATCH_RATIO = 0.35;

/** Cap on the fingerprint set kept per moment — the "small fingerprint set" the
 * spec asks for. Evenly sampled across the window so the set is deterministic
 * and independent of the frame count. */
export const REPLAY_MAX_FINGERPRINTS = 12;

/** One frame's fingerprint on the job's content clock. */
export interface ReplayFrameFingerprint {
  /** Seconds from stream start (the analyzer's `sampleFps` grid). */
  ts: number;
  /** 8x8 aHash hex (perceptualHash). */
  hash: string;
}

/** One moment's ledger entry: the id it can own replays for, its anchor on the
 * content clock, and the small fingerprint set of the frames in its window. */
export interface ReplayLedgerEntry {
  id: string;
  anchorTs: number;
  hashes: string[];
  /** Set when this moment is ITSELF a replay — such an entry is never an owner
   * (no chains: replay of a replay). */
  replayOf?: string;
}

/** What the matcher measured. Mirrors `ReplayEvidence` plus the owner. */
export interface ReplayMatch {
  ownerId: string;
  ownerAnchorTs: number;
  matches: number;
  compared: number;
  gapS: number;
  kind: ReplayEvidence["kind"];
}

/** Evenly sample at most `max` fingerprints out of a window's frames, keeping
 * first/last so a window's edges still count. Order-stable and deduped, so the
 * set is identical on a re-run. */
export function windowFingerprintSet(hashes: readonly string[], max = REPLAY_MAX_FINGERPRINTS): string[] {
  const all = hashes.filter((h) => typeof h === "string" && h.length > 0);
  if (all.length <= max) return [...all];
  const out: string[] = [];
  const step = (all.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(all[Math.round(i * step)]);
  // Repeated pictures stay repeated: the set's size IS the `compared` denominator,
  // so deduping would make a static-camera window look smaller than it is.
  return out;
}

/** The frames in `[anchorTs - windowS, anchorTs]` — the material a decide call
 * had in memory when the moment was judged (the analyzer's rolling cache ends
 * at the decision instant). */
export function fingerprintsNear(
  frames: readonly ReplayFrameFingerprint[],
  anchorTs: number,
  windowS: number,
  max = REPLAY_MAX_FINGERPRINTS
): string[] {
  const hashes = frames
    .filter((f) => f.ts >= anchorTs - windowS && f.ts <= anchorTs)
    .sort((a, b) => a.ts - b.ts)
    .map((f) => f.hash);
  return windowFingerprintSet(hashes, max);
}

/** Count the fingerprints of `newHashes` that have a fingerprint in the owner's
 * set within `bits` Hamming distance. SET match, not positional: a re-framed
 * repeat still matches because every new fingerprint is compared to every
 * stored one. */
export function setMatchCount(
  newHashes: readonly string[],
  ownerHashes: readonly string[],
  bits = REPLAY_HASH_MATCH_BITS
): number {
  if (!newHashes.length || !ownerHashes.length) return 0;
  let matches = 0;
  for (const h of newHashes) {
    if (ownerHashes.some((o) => phashHammingDistance(h, o) <= bits)) matches += 1;
  }
  return matches;
}

/**
 * Decide which earlier moment (if any) a new window repeats.
 *
 * Order-independent: every ledger entry with a legal gap is scored, and the
 * strongest match wins (ratio first, then matches, then the smallest gap). A
 * replay never attaches to another replay, and the gap window is inclusive on
 * both ends. Returns null when nothing clears the bar.
 */
export function matchReplayOwner(
  newEntry: ReplayLedgerEntry,
  ledger: readonly ReplayLedgerEntry[],
  opts: {
    bits?: number;
    minMatches?: number;
    minRatio?: number;
    minGapS?: number;
    maxGapS?: number;
  } = {}
): ReplayMatch | null {
  const bits = opts.bits ?? REPLAY_HASH_MATCH_BITS;
  const minMatches = opts.minMatches ?? REPLAY_MIN_MATCHES;
  const minRatio = opts.minRatio ?? REPLAY_MIN_MATCH_RATIO;
  const minGap = opts.minGapS ?? REPLAY_MIN_GAP_S;
  const maxGap = opts.maxGapS ?? REPLAY_MAX_GAP_S;
  if (!newEntry.hashes.length) return null;

  let best: ReplayMatch | null = null;
  for (const owner of ledger) {
    if (owner.id === newEntry.id) continue;
    // No chains: a replay (or a moment already known to be one) never owns.
    if (owner.replayOf) continue;
    const gapS = newEntry.anchorTs - owner.anchorTs;
    if (gapS < minGap || gapS > maxGap) continue;
    const matches = setMatchCount(newEntry.hashes, owner.hashes, bits);
    const compared = newEntry.hashes.length;
    if (matches < minMatches) continue;
    const ratio = matches / compared;
    if (ratio < minRatio) continue;
    const candidate: ReplayMatch = {
      ownerId: owner.id,
      ownerAnchorTs: owner.anchorTs,
      matches,
      compared,
      gapS,
      kind: "footage_match",
    };
    if (
      !best ||
      ratio > best.matches / best.compared ||
      (ratio === best.matches / best.compared && matches > best.matches)
    ) {
      best = candidate;
    }
  }
  return best;
}

/** The stored records that are replays, grouped under the moment they repeat. */
export interface AttachedReplays {
  /** Records that are NOT replays (the ones a job may still show as cards). */
  highlights: HighlightRecord[];
  /** replayOf -> the replay records attached to it, anchor-ordered. */
  byOwner: Map<string, HighlightRecord[]>;
  /** How many replay records were attached. */
  attached: number;
}

/** Partition stored records into highlights and attached replays. Pure: no
 * record is mutated, and a record whose `replayOf` names no present record is
 * kept as a highlight rather than silently dropped. */
export function partitionAttachedReplays(records: readonly HighlightRecord[]): AttachedReplays {
  const ids = new Set(records.map((r) => r.id));
  const highlights: HighlightRecord[] = [];
  const byOwner = new Map<string, HighlightRecord[]>();
  let attached = 0;
  for (const r of records) {
    if (!r.replayOf || !ids.has(r.replayOf)) {
      highlights.push(r);
      continue;
    }
    const list = byOwner.get(r.replayOf) ?? [];
    list.push(r);
    byOwner.set(r.replayOf, list);
    attached += 1;
  }
  for (const list of byOwner.values()) list.sort((a, b) => a.start - b.start);
  return { highlights, byOwner, attached };
}

/** Project a stored replay record into the alternative lane (ADAAAA-7984's
 * shape), so the moment card can offer it beside the primary clip. The record's
 * own clip is reused — no second cut, no second debit. */
export function replayAlternativeFrom(record: HighlightRecord, ownerClipEndS?: number): HighlightAlternative {
  const anchor = replayAnchorTs(record);
  const outcome =
    record.outcome === "scoring_play"
      ? "scoring_play"
      : record.outcome === "near_miss"
        ? "near_miss"
        : "big_play";
  return {
    id: record.id,
    ownerId: record.ownerId,
    jobId: record.jobId,
    highlightId: record.replayOf as string,
    relation: HIGHLIGHT_ALTERNATIVE_RELATION,
    eventType: REPLAY_ALTERNATIVE_EVENT_TYPE,
    outcome,
    replayOf: record.replayOf,
    replayEvidence: record.replayEvidence,
    sourceHighlightId: record.id,
    windowAnchorTs: anchor,
    distanceToGoalEndS:
      ownerClipEndS === undefined ? 0 : Math.max(0, anchor - ownerClipEndS),
    score: record.score,
    start: record.start,
    end: record.end,
    clipId: record.id,
    clipUri: record.clipUri,
    dedupeKey: `replay:${record.id}`,
    reason: record.reason,
    createdAt: record.createdAt ?? new Date(0).toISOString(),
  };
}

/** The content-clock instant a replay record repeats: the same anchor the
 * detector fingerprinted the window at. */
export function replayAnchorTs(
  record: Pick<HighlightRecord, "localizeEvidenceTs" | "localizedTs" | "start" | "end">
): number {
  if (typeof record.localizeEvidenceTs === "number") return record.localizeEvidenceTs;
  if (typeof record.localizedTs === "number") return record.localizedTs;
  return (record.start + record.end) / 2;
}

/** Build the ledger entry for one decided moment from the job's fingerprints. */
export function ledgerEntryFor(
  record: Pick<HighlightRecord, "id" | "start" | "end" | "localizeEvidenceTs" | "localizedTs" | "replayOf">,
  frames: readonly ReplayFrameFingerprint[],
  windowS: number
): ReplayLedgerEntry {
  const anchorTs = replayAnchorTs(record);
  return {
    id: record.id,
    anchorTs,
    hashes: fingerprintsNear(frames, anchorTs, windowS),
    replayOf: record.replayOf,
  };
}

/** The delivery seam: mark stored records whose window repeats an earlier
 * moment. Only the REPLAY record is written (`replayOf` + evidence); the owner
 * is read, never written. Returns the ids attached this pass. */
export function detectReplayAttachments(
  records: readonly HighlightRecord[],
  frames: readonly ReplayFrameFingerprint[],
  opts: { windowS?: number } = {}
): { id: string; replayOf: string; evidence: ReplayEvidence }[] {
  const windowS = opts.windowS ?? 8;
  // Only real moments can own; a record that is already a replay is never a
  // ledger owner (guard rail: no chains) but IS a candidate to be attached
  // itself on a later pass — skip it, since it is already classified.
  const ordered = [...records]
    .filter((r) => !r.replayOf)
    .sort((a, b) => replayAnchorTs(a) - replayAnchorTs(b));
  const ledger: ReplayLedgerEntry[] = [];
  const out: { id: string; replayOf: string; evidence: ReplayEvidence }[] = [];
  for (const record of ordered) {
    const entry = ledgerEntryFor(record, frames, windowS);
    const match = matchReplayOwner(entry, ledger);
    if (match) {
      out.push({
        id: record.id,
        replayOf: match.ownerId,
        evidence: {
          kind: match.kind,
          matches: match.matches,
          compared: match.compared,
          gapS: Math.round(match.gapS * 1000) / 1000,
        },
      });
    }
    ledger.push({ ...entry, replayOf: match ? match.ownerId : undefined });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Frame fingerprints from the job's extracted frames (CPU only, no GPU)
// ---------------------------------------------------------------------------

/**
 * 8x8 average hash over a square gray vector, bit-compatible with
 * `perceptualHash` in `@highlights/events/training` for an 8x8 input: each cell
 * is one pixel, luma of a gray pixel is the pixel value, and the bit is
 * `cell >= mean`. Keeping it local lets the detector hash the raw gray frames
 * ffmpeg already produces (the shared helper expects RGBA input).
 */
export function ahashFromGray(vec: ArrayLike<number>, size = 8): string {
  const cells: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const y0 = Math.floor((y * size) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * size) / 8));
      const x0 = Math.floor((x * size) / 8);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * size) / 8));
      let sum = 0;
      let count = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          sum += Number(vec[yy * size + xx] ?? 0);
          count += 1;
        }
      }
      cells.push(count ? sum / count : 0);
    }
  }
  const mean = cells.reduce((a, b) => a + b, 0) / cells.length;
  let bits = "";
  for (const v of cells) bits += v >= mean ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

/** Fingerprint one job's extracted frames: `frame_%04d.jpg` at `sampleFps`, one
 * ffmpeg process, 8x8 gray. Frame N (1-based) sits at content instant
 * `(N - 1) / sampleFps`. Returns [] when the directory cannot be decoded. */
export async function jobFrameFingerprints(
  ffmpegPath: string,
  framesDir: string,
  sampleFps: number
): Promise<ReplayFrameFingerprint[]> {
  const { sampleFrameDirGray } = await import("./ffmpeg");
  const vecs = await sampleFrameDirGray(ffmpegPath, framesDir, "frame_%04d.jpg", 1, 8);
  if (!vecs) return [];
  const fps = sampleFps > 0 ? sampleFps : 1;
  return vecs.map((v, i) => ({ ts: i / fps, hash: ahashFromGray(v, 8) }));
}

/** The narrow store seam the attach needs. Kept structural so a test can drive
 * it with an in-memory store, matching the celebration delivery seam. */
export interface ReplayAttachStore {
  highlightsForJob(jobId: string): HighlightRecord[];
  markReplay(id: string, patch: { replayOf: string; replayEvidence: ReplayEvidence }): Promise<HighlightRecord>;
}

/**
 * Detect and persist replay attachments for one job, from the frames the VOD
 * pipeline already extracted. Writes ONLY the replay record (`replayOf` +
 * `replayEvidence`); the owner record is never touched, so its status, score
 * and outcome are unchanged, and no highlight row is inserted — no second
 * highlight, no second quota debit, no second billing entry.
 */
export async function attachReplayWindows(opts: {
  store: ReplayAttachStore;
  jobId: string;
  ffmpegPath: string;
  framesDir: string;
  sampleFps: number;
  /** Seconds of frames ending at a moment's anchor that form its set. Defaults
   * to the analyzer's decide window (24 frames at 3 fps = 8 s). */
  windowS?: number;
  log?: (line: string) => void;
}): Promise<{ attached: number; measured: ReplayEvidence[] }> {
  const frames = await jobFrameFingerprints(opts.ffmpegPath, opts.framesDir, opts.sampleFps);
  if (!frames.length) return { attached: 0, measured: [] };
  const records = opts.store.highlightsForJob(opts.jobId);
  const detections = detectReplayAttachments(records, frames, { windowS: opts.windowS });
  const measured: ReplayEvidence[] = [];
  for (const d of detections) {
    await opts.store.markReplay(d.id, { replayOf: d.replayOf, replayEvidence: d.evidence });
    measured.push(d.evidence);
    opts.log?.(
      `[replay:${opts.jobId}] ${d.id} -> ${d.replayOf} evidence=${JSON.stringify(d.evidence)}`
    );
  }
  return { attached: measured.length, measured };
}
