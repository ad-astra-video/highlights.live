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
// ADAAAA-8366 (Inc 3): reuse the score parser the attestation path already owns
// rather than growing a second one — the score-bug read only needs to know
// whether an OCR line carries a score pair.
import { parseOcrScoreLine } from "./analyzer";

/** Floor/ceiling of the gap between a replay and the moment it repeats. The
 * floor is 20 s because `SHOOTOUT_KICK_DEDUP_S` (8 s) exists precisely because
 * adjacent re-reads of one incident, and shootout kicks, are 13-18 s apart and
 * are distinct events. */
export const REPLAY_MIN_GAP_S = 20;
export const REPLAY_MAX_GAP_S = 300;

/** Hamming distance at which two 8x8 aHash fingerprints count as the same
 * picture. 6 bits is the near-duplicate threshold the training splitter already
 * uses (`bucketNearDuplicates`), so the detector inherits a calibrated value
 * rather than inventing one.
 *
 * MEASURED LIMIT (job 545be947, 2026-11-07; numbers in the ADAAAA-8321 evidence
 * work product). Two frames 1/3 s apart in the SAME window differ by a median of
 * 16 bits on this hash (goal window 16, replay window 22, 0-15 s control 21), so
 * 6 bits is far below the frame-to-frame noise floor: the bar fires only on
 * near-identical pictures. That is deliberate — precision first — and it is also
 * why the real broadcast replay (behind-the-net camera at 207 s vs side-on at
 * 159 s) measures 0 matches at every threshold up to 16 bits and needs 20+ bits
 * to produce even 4/22, which no ratio bar accepts. Do NOT loosen these
 * constants to chase a missed attach: the recall for a re-framed broadcast
 * replay has to come from a decide-level `phase` verdict (ADAAAA-8325), not from
 * a bigger hash budget here. */
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

/**
 * ADAAAA-8325 (Inc 2): the RELAXED band a `phase: "replay"` verdict opens for
 * the deterministic set match — and the ONLY thing the phase signal may do.
 *
 * A broadcast replay is shot from a different camera, so the strict bar above
 * (4 matches at 6 bits / 0.35) misses it: measured on job 545be947 the true
 * replay->goal pair scores BELOW the unrelated-pair median at every threshold
 * (see ADAAAA-8321's falsifier). A window whose decide verdict says it is
 * replay footage is therefore allowed a weaker agreement — but still a bounded
 * one, so the phase is corroboration and NEVER the attach on its own:
 *
 *   * at least `PHASE_REPLAY_MIN_MATCHES` fingerprints must match (a phase-only
 *     window with no agreeing picture produces no attach — unit-tested);
 *   * at least `PHASE_REPLAY_MIN_MATCH_RATIO` of the compared set must match;
 *   * the distance band widens from 6 to 8 bits of 64 (still a near-duplicate
 *     picture, never a loose "same scene" match);
 *   * gap 20-300 s and the no-chain / owner-phase guards are unchanged.
 */
export const PHASE_REPLAY_MATCH_BITS = 8;
export const PHASE_REPLAY_MIN_MATCHES = 2;
export const PHASE_REPLAY_MIN_MATCH_RATIO = 0.15;

// ---------------------------------------------------------------------------
// ADAAAA-8366 (Inc 3): score bug / clock presence-gap signal
// ---------------------------------------------------------------------------
//
// The measured problem Inc 1/2 could not solve: the 207 s replay is shot from a
// DIFFERENT broadcast camera (behind the net vs side-on), so no hash band that
// keeps AC2 precision admits it, and the decide `phase` verdict read it `live`.
// The one measured difference between the two windows is the score bug/clock:
// the 152 s goal frames carry `POR 1 : 1 ESP 43:40` (43:40 -> 43:55 across the
// window), the 207 s replay frames carry no overlay at all.
//
// This signal reads the SAME OCR the decide pass already produced for those
// anchor frames (perceive's per-frame `ocr` lines — persisted on the job's
// observation rows so it is available at finalize; no new inference call, no
// new decode pass, no extra frames, CPU only).
//
// Two attach modes, both inside the unchanged 20-300 s band:
//
//   1. CLOCK REGRESSION (`clockS` on both anchors). A broadcast match clock only
//      moves forward, so a LATER window showing an EARLIER clock than an earlier
//      window is footage of an earlier instant — i.e. a replay/insert. This is
//      the deterministic mode and it attaches on its own: it needs a clock
//      stable on >= 2 frames on BOTH anchors (one misread can never attach) and
//      a regression bounded by `SCOREBUG_MAX_CLOCK_REGRESSION_S`, which is under
//      a half's length so a legitimate half-time clock reset (45:00 -> 00:00,
//      a 45-minute jump) can never read as a regression.
//
//   2. OVERLAY-FREE CANDIDATE. Absence alone is NEVER sufficient (plan §9: a
//      hard "no graphic => replay" rule would open the band on operator-cropped,
//      wide-shot and multi-camera windows). The path exists but is gated OFF by
//      `overlayFreeAttach`; it may only be enabled for a caller whose
//      overlay-free precision set has measured 0 false attaches (AC10b). The
//      shipped default keeps it off, so an overlay-free non-replay window cannot
//      attach.
//
// The `phase` verdict stays corroboration-only: it can never attach here, and it
// can never suppress a clock regression either (the signal is deterministic).

/** Frames read per anchor window. Bounded: the OCR lines are already stored, so
 * reading more only costs array work. Matches the decide window's frame count
 * lander (`REPLAY_MAX_FINGERPRINTS`). */
export const SCOREBUG_MAX_FRAMES = 12;

/** A clock counts as read only when the same window yields at least this many
 * monotonic readings (see `scoreBugReading`). One misread minute (`41:40` for
 * `43:40`) breaks the monotonic run, so it can never manufacture a regression. */
export const SCOREBUG_CLOCK_MIN_SAMPLES = 2;

/** Largest per-frame clock step a monotonic run may take. At 1 fps sampling a
 * broadcast clock advances ~1 s per frame; a bigger step is a misread or a cut,
 * so the run stops there rather than stitching two different clocks together. */
export const SCOREBUG_MAX_CLOCK_STEP_S = 10;

/** Bounds the regression (owner clock - candidate clock). A replay repeats a
 * moment seconds-to-minutes earlier; a jump this large or larger is a clock
 * reset (half-time 45:00 -> 00:00) or an OCR drift, never a replay. */
export const SCOREBUG_MAX_CLOCK_REGRESSION_S = 180;

/** The owner must carry the bug on at least this many frames for a presence gap
 * to be measured at all (a single OCR hit is noise, not a score bug). */
export const SCOREBUG_MIN_OVERLAY_FRAMES = 2;

/** One already-OCR'd frame on the job's content clock. `ocr` is the perceive
 * per-frame OCR line list the decide pass consumed; empty means the frame
 * printed nothing (no overlay text). */
export interface ScoreBugFrame {
  ts: number;
  ocr: readonly string[];
}

/** What one anchor window's frames say about the score bug. */
export interface ScoreBugReading {
  /** Frames sampled in `[anchorTs - windowS, anchorTs]`. */
  frames: number;
  /** Frames that printed score-bug text (a clock or a score pair). */
  overlayFrames: number;
  /** The stable broadcast clock (seconds into the match), when read. */
  clockS?: number;
  /** Frames that produced that stable clock value. */
  clockSamples: number;
  /** Frames that printed any parseable clock (stable or not). */
  clockReads: number;
}

/** Parse a broadcast clock (`43:40`, `1:02:03` -> mm:ss only) out of one OCR
 * line. Deliberately narrow: two-digit seconds, a colon, and no digits/colons
 * on either side, so a score pair (`POR 1 : 1 ESP`) and a glued stat
 * (`43:4012`) never parse as a clock. */
export function parseBroadcastClock(line: string): number | null {
  const m = /(?:^|[^\d:])(\d{1,3}):([0-5]\d)(?![\d:])/.exec(String(line ?? ""));
  if (!m) return null;
  const minutes = Number(m[1]);
  const seconds = Number(m[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) return null;
  // A match clock never exceeds 3 digits of minutes; reject a timestamp that
  // carries hours (`1:02:03` would otherwise parse as 1:02).
  if (minutes > 180) return null;
  return minutes * 60 + seconds;
}

/** A score pair in the OCR line (`POR 1-1 ESP`, `1 : 1`). Reuses the score
 * parser the attestation path already owns — no second score parser here. */
function hasScorePair(line: string): boolean {
  return parseOcrScoreLine([String(line ?? "")]) !== null;
}

/**
 * Read one anchor window's score bug / clock from frames the decide pass already
 * OCR'd. Frames are the ones in `[anchorTs - windowS, anchorTs]`, evenly capped
 * at `maxFrames` so the read is deterministic and independent of the frame rate.
 */
export function scoreBugReading(
  frames: readonly ScoreBugFrame[],
  anchorTs: number,
  windowS: number,
  maxFrames = SCOREBUG_MAX_FRAMES
): ScoreBugReading {
  const inWindow = frames
    .filter((f) => Number.isFinite(f.ts) && f.ts >= anchorTs - windowS && f.ts <= anchorTs)
    .sort((a, b) => a.ts - b.ts);
  const sampled = windowFingerprintSet(
    inWindow.map((_, i) => String(i)),
    Math.max(1, maxFrames)
  ).map((i) => inWindow[Number(i)]);
  const reading: ScoreBugReading = { frames: sampled.length, overlayFrames: 0, clockSamples: 0, clockReads: 0 };
  if (!sampled.length) return reading;
  // A broadcast clock ADVANCES, so the read is the longest monotonic
  // (non-decreasing, <= SCOREBUG_MAX_CLOCK_STEP_S per frame) run of parsed
  // clocks in the window. A misread minute breaks the run, which is what keeps
  // one bad OCR frame from standing as a window's clock.
  const clocks: number[] = [];
  for (const frame of sampled) {
    const lines = (frame.ocr ?? []).filter((l) => typeof l === "string" && l.trim());
    let overlay = false;
    let frameClock: number | null = null;
    for (const line of lines) {
      const clock = parseBroadcastClock(line);
      if (clock !== null) {
        overlay = true;
        reading.clockReads += 1;
        if (frameClock === null) frameClock = clock;
      }
      if (hasScorePair(line)) overlay = true;
    }
    if (overlay) reading.overlayFrames += 1;
    if (frameClock !== null) clocks.push(frameClock);
  }
  let runStart = 0;
  let bestStart = 0;
  let bestLen = 0;
  for (let i = 1; i <= clocks.length; i++) {
    const continues =
      i < clocks.length && clocks[i] >= clocks[i - 1] && clocks[i] - clocks[i - 1] <= SCOREBUG_MAX_CLOCK_STEP_S;
    if (!continues) {
      const len = i - runStart;
      if (len > bestLen) {
        bestLen = len;
        bestStart = runStart;
      }
      runStart = i;
    }
  }
  if (bestLen >= SCOREBUG_CLOCK_MIN_SAMPLES) {
    // The window's clock is the EARLIEST reading of the run: the instant the
    // window opens on, which is what a replay repeats.
    reading.clockS = clocks[bestStart];
    reading.clockSamples = bestLen;
  }
  return reading;
}

/** ADAAAA-8366: the score-bug attach a candidate/owner pair supports, or null.
 * `overlayFreeAttach` enables the second mode only on a caller whose overlay-free
 * precision set has cleared (AC10b); the shipped default is off. */
export function scoreBugMatch(
  candidate: ScoreBugReading | undefined,
  owner: ScoreBugReading | undefined,
  opts: { overlayFreeAttach?: boolean } = {}
): Omit<ReplayMatch, "ownerId" | "ownerAnchorTs" | "gapS"> | null {
  if (!candidate || !owner) return null;
  const ownerHasBug = owner.overlayFrames >= SCOREBUG_MIN_OVERLAY_FRAMES;
  // No bug on the owner = no presence gap to measure (and no clock to regress).
  if (!ownerHasBug) return null;
  // 1. Clock regression — the deterministic mode.
  if (owner.clockS !== undefined && candidate.clockS !== undefined) {
    const regression = owner.clockS - candidate.clockS;
    if (regression > 0 && regression <= SCOREBUG_MAX_CLOCK_REGRESSION_S) {
      return {
        matches: candidate.clockSamples,
        compared: candidate.frames,
        kind: "scorebug_gap",
        clockOwnerS: owner.clockS,
        clockCandidateS: candidate.clockS,
        overlayOwner: true,
        overlayCandidate: true,
      };
    }
    // A clock that agrees or advances is LIVE footage of this instant: never a
    // replay, even when the phase verdict says otherwise.
    return null;
  }
  // 2. Overlay-free candidate — absence alone is never evidence. Gated off
  // unless the overlay-free precision set cleared for this caller.
  if (candidate.overlayFrames === 0 && candidate.frames > 0 && opts.overlayFreeAttach === true) {
    return {
      matches: 0,
      compared: candidate.frames,
      kind: "scorebug_gap",
      clockOwnerS: owner.clockS,
      overlayOwner: true,
      overlayCandidate: false,
    };
  }
  return null;
}

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
  /** ADAAAA-8325 (Inc 2): the decide verdict's footage phase for this moment's
   * window. `replay` opens the relaxed corroboration band for an attach and
   * makes the entry ineligible to OWN (a replay never owns a replay); absent or
   * `live` keeps the strict Inc 1 bar. */
  phase?: "live" | "replay";
  /** ADAAAA-8366 (Inc 3): the score-bug/clock read of this window's anchor
   * frames, from OCR the decide pass already produced. */
  scoreBug?: ScoreBugReading;
}

/** What the matcher measured. Mirrors `ReplayEvidence` plus the owner. */
export interface ReplayMatch {
  ownerId: string;
  ownerAnchorTs: number;
  matches: number;
  compared: number;
  gapS: number;
  kind: ReplayEvidence["kind"];
  /** ADAAAA-8325: set to `replay` when the attach needed the phase-corroborated
   * relaxed band (the strict Inc 1 bar was missed). Absent on a strict attach. */
  phase?: "replay";
  /** ADAAAA-8366 (Inc 3): the score bug/clock readings the attach used. Absent
   * on a hash attach (whose evidence shape stays byte-identical). */
  clockOwnerS?: number;
  clockCandidateS?: number;
  overlayOwner?: boolean;
  overlayCandidate?: boolean;
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
    /** ADAAAA-8366: enable the overlay-free (graphic absence) attach mode. Off
     * by default — absence alone is never evidence until a caller's overlay-free
     * precision set has measured 0 false attaches (AC10b). */
    overlayFreeAttach?: boolean;
  } = {}
): ReplayMatch | null {
  // ADAAAA-8325 (Inc 2): a `replay` verdict relaxes the DETERMINISTIC band; it
  // never replaces it. With no agreeing fingerprint the counts below still fail,
  // so a phase-only window produces no attach (unit-tested).
  const phaseRelaxed = newEntry.phase === "replay";
  const bits = opts.bits ?? (phaseRelaxed ? PHASE_REPLAY_MATCH_BITS : REPLAY_HASH_MATCH_BITS);
  const minMatches = opts.minMatches ?? (phaseRelaxed ? PHASE_REPLAY_MIN_MATCHES : REPLAY_MIN_MATCHES);
  const minRatio = opts.minRatio ?? (phaseRelaxed ? PHASE_REPLAY_MIN_MATCH_RATIO : REPLAY_MIN_MATCH_RATIO);
  const minGap = opts.minGapS ?? REPLAY_MIN_GAP_S;
  const maxGap = opts.maxGapS ?? REPLAY_MAX_GAP_S;
  if (!newEntry.hashes.length && !newEntry.scoreBug) return null;

  let best: ReplayMatch | null = null;
  for (const owner of ledger) {
    if (owner.id === newEntry.id) continue;
    // No chains: a replay (or a moment already known to be one) never owns.
    if (owner.replayOf) continue;
    // ADAAAA-8325: a window its own verdict called replay footage never owns a
    // later replay — the owner must be live action (or an unjudged older row).
    if (owner.phase === "replay") continue;
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
      // Only the phase band records the phase provenance; a strict attach keeps
      // its pre-Inc-2 shape byte-identically.
      ...(phaseRelaxed ? { phase: "replay" as const } : {}),
    };
    if (
      !best ||
      ratio > best.matches / best.compared ||
      (ratio === best.matches / best.compared && matches > best.matches)
    ) {
      best = candidate;
    }
  }
  // ADAAAA-8366 (Inc 3): the score bug / clock presence-gap signal. It is
  // independent of the hashes (the cross-camera replay scores 0 at every usable
  // bit band), so it is evaluated only when no hash attach cleared — a strict
  // or phase attach keeps its evidence shape byte-identically.
  if (!best) {
    let bestBug: ReplayMatch | null = null;
    for (const owner of ledger) {
      if (owner.id === newEntry.id) continue;
      if (owner.replayOf) continue;
      if (owner.phase === "replay") continue;
      const gapS = newEntry.anchorTs - owner.anchorTs;
      if (gapS < minGap || gapS > maxGap) continue;
      const bug = scoreBugMatch(newEntry.scoreBug, owner.scoreBug, opts);
      if (!bug) continue;
      const candidate: ReplayMatch = { ownerId: owner.id, ownerAnchorTs: owner.anchorTs, gapS, ...bug };
      // A clock regression is the stronger evidence (a broadcast clock cannot
      // run backwards); a graphic absence is weaker, so it only wins when it is
      // the only mode available. Within a mode the tighter gap wins.
      const candRegression = candidate.clockCandidateS !== undefined;
      const bestRegression = bestBug?.clockCandidateS !== undefined;
      const stronger =
        !bestBug ||
        (candRegression && !bestRegression) ||
        (candRegression === bestRegression && candidate.gapS < bestBug.gapS);
      if (stronger) bestBug = candidate;
    }
    best = bestBug;
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
    // ADAAAA-8325 (Inc 2): the alternative's own footage phase, so the rail can
    // name the provenance ("Replay @ 207 s · phase") the attach used.
    ...(record.phase ? { phase: record.phase } : {}),
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
  record: Pick<HighlightRecord, "id" | "start" | "end" | "localizeEvidenceTs" | "localizedTs" | "replayOf" | "phase">,
  frames: readonly ReplayFrameFingerprint[],
  windowS: number
): ReplayLedgerEntry {
  const anchorTs = replayAnchorTs(record);
  return {
    id: record.id,
    anchorTs,
    hashes: fingerprintsNear(frames, anchorTs, windowS),
    replayOf: record.replayOf,
    // ADAAAA-8325 (Inc 2): the decided window's footage phase rides the ledger
    // so the matcher can open the corroboration band — and refuse to let a
    // replay window own a later replay.
    ...(record.phase ? { phase: record.phase } : {}),
  };
}

/** The delivery seam: mark stored records whose window repeats an earlier
 * moment. Only the REPLAY record is written (`replayOf` + evidence); the owner
 * is read, never written. Returns the ids attached this pass. */
export function detectReplayAttachments(
  records: readonly HighlightRecord[],
  frames: readonly ReplayFrameFingerprint[],
  opts: {
    windowS?: number;
    /** ADAAAA-8366: the per-frame OCR lines the decide pass already produced for
     * this job (`store.observationsForJob`), on the content clock. Omitted =>
     * the score-bug signal is inert and the Inc 1/2 detectors run unchanged. */
    scoreBugFrames?: readonly ScoreBugFrame[];
    /** ADAAAA-8366: enable the overlay-free attach mode; off unless the caller
     * has cleared the overlay-free precision set (AC10b). */
    overlayFreeAttach?: boolean;
  } = {}
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
    // ADAAAA-8366 (Inc 3): read the score bug / clock off the OCR the decide
    // pass already ran for this window's anchor frames. Readings only; no
    // inference, no decode, no extra frames.
    if (opts.scoreBugFrames?.length) {
      entry.scoreBug = scoreBugReading(opts.scoreBugFrames, entry.anchorTs, windowS);
    }
    const match = matchReplayOwner(entry, ledger, { overlayFreeAttach: opts.overlayFreeAttach });
    if (match) {
      out.push({
        id: record.id,
        replayOf: match.ownerId,
        evidence: {
          kind: match.kind,
          matches: match.matches,
          compared: match.compared,
          gapS: Math.round(match.gapS * 1000) / 1000,
          // ADAAAA-8325 (Inc 2): record the corroboration that produced the
          // attach — only present when the phase band carried it.
          ...(match.phase ? { phase: match.phase } : {}),
          // ADAAAA-8366 (Inc 3): the clock/bug readings behind a scorebug attach
          // — absent on hash attaches, whose shape stays byte-identical.
          ...(match.clockOwnerS !== undefined ? { clockOwnerS: match.clockOwnerS } : {}),
          ...(match.clockCandidateS !== undefined ? { clockCandidateS: match.clockCandidateS } : {}),
          ...(match.overlayOwner !== undefined ? { overlayOwner: match.overlayOwner } : {}),
          ...(match.overlayCandidate !== undefined ? { overlayCandidate: match.overlayCandidate } : {}),
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
  /** ADAAAA-8366 (Inc 3): the job's per-frame OCR lines, on the content clock —
   * the same OCR the decide pass consumed (`store.observationsForJob`). Omitted
   * or empty => the score-bug signal stays inert. */
  ocrFrames?: readonly ScoreBugFrame[];
  /** ADAAAA-8366: enable the overlay-free attach mode (off until the caller's
   * overlay-free precision set clears AC10b). */
  overlayFreeAttach?: boolean;
  log?: (line: string) => void;
}): Promise<{ attached: number; measured: ReplayEvidence[] }> {
  // ADAAAA-8366 (Inc 3): the score-bug signal is OCR-only, so a job whose frames
  // have already been cleaned can STILL attach on a clock regression. Only the
  // fingerprint-only path needs the frame dir.
  const frames = await jobFrameFingerprints(opts.ffmpegPath, opts.framesDir, opts.sampleFps);
  if (!frames.length && !opts.ocrFrames?.length) return { attached: 0, measured: [] };
  const records = opts.store.highlightsForJob(opts.jobId);
  const detections = detectReplayAttachments(records, frames, {
    windowS: opts.windowS,
    scoreBugFrames: opts.ocrFrames,
    overlayFreeAttach: opts.overlayFreeAttach,
  });
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
