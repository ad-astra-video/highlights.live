// ADAAAA-8168: ONE clip-placement decision, shared by the live rails.
//
// The browser (screen-share) rail already cuts where the goal actually sits in
// the FOOTAGE (`cutBrowserHighlightClip` in api.ts, ADAAAA-8152): locate the
// accepted evidence picture inside the recording, then locate the scorebug's
// own flip before it, then center the window on that instant and re-measure the
// delivered file. The ingest rail (`LiveIngest.cut`) used to bypass all of it
// and cut straight from the content clock, so its play sat wherever the clock
// said rather than at the goal instant — the ACC-2 shape ADAAAA-8152 fixed for
// browser shares.
//
// This module is that sequence, extracted so a second rail can reuse it
// verbatim instead of growing a third copy. It is deliberately PURE placement:
// no store, no billing, no decide/perceive call, no clip debit — callers own
// publishing. `cutBrowserHighlightClip` still carries its own copy of the
// sequence (it predates this module and owns the mid-share scheduling); the two
// must stay in step until it is migrated here.
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  centerClipOnEvidence,
  cutClip,
  cutCenteredOnInstant,
  firstPacketTs,
  locateImageInSource,
  locateScoreboardFlip,
  probeDuration,
  CLIP_EXACT_TRIM_PREROLL_S,
  type ClipCutResult,
} from "./ffmpeg";

const exec = promisify(execFile);

/** How the delivered file was placed. `score_flip` centers on the first
 * recording frame that shows the post-transition score (the instant ACC-2
 * grades); `frame_match` uses the accepted evidence picture when the scorebug
 * probe cannot resolve it; `content_clock` is the honest fallback. */
export type ClipAnchorMethod = "score_flip" | "frame_match" | "content_clock";

export interface ClipPlacement {
  /** Recording-file seconds the delivered window starts at. */
  cutStart: number;
  /** Delivered window length (seconds) — the >= 15 s floor applied. */
  dur: number;
  method: ClipAnchorMethod;
  /** Content-clock instant the anchor was taken from. */
  evidenceTs: number | null;
  /** Recording-file instant that carries the anchor. */
  fileTs: number | null;
  /** evidenceTs - fileTs: how late the content clock was against that anchor. */
  lagSec: number | null;
  score: number | null;
  runnerUp: number | null;
  clamped: boolean;
  /** Where the anchor picture actually sits in the DELIVERED file (measured,
   * not assumed) — `null` on the fallback path. */
  deliveredOffsetSec: number | null;
  /** The score-flip probe's audit numbers (glyph mass + count). */
  flipPx: number | null;
  flipDigits: number | null;
  flipRunnerUpTs: number | null;
}

/** The row fields that record HOW the delivered clip was placed (AC3). Same
 * shape `clipPlacementPatch` writes on the browser rail, so a grader reads one
 * contract for both rails. */
export interface ClipCutAudit {
  clipAnchorMethod: ClipAnchorMethod;
  clipAnchorFileTs?: number;
  clipAnchorEvidenceTs?: number;
  clipAnchorLagSec?: number;
  clipAnchorScore?: number;
  clipAnchorRunnerUp?: number;
  clipCutStartSec: number;
  clipCutDurSec: number;
  clipCutClamped: boolean;
  clipDeliveredSec?: number;
  clipAnchorDeliveredOffsetSec?: number;
  clipScoreFlipPx?: number;
  clipScoreFlipDigits?: number;
  clipScoreFlipRunnerUpTs?: number;
}

/** What a rail's `cut(ts)` hands back to the analyzer: the published artifact
 * plus the placement audit it must stamp on the row. */
export interface ClipCut {
  clipId: string;
  clipUri: string;
  clipAudit?: ClipCutAudit;
}

export function clipAuditFields(p: ClipPlacement, deliveredSec: number | null): ClipCutAudit {
  return {
    clipAnchorMethod: p.method,
    clipAnchorFileTs: p.fileTs ?? undefined,
    clipAnchorEvidenceTs: p.evidenceTs ?? undefined,
    clipAnchorLagSec: p.lagSec ?? undefined,
    clipAnchorScore: p.score ?? undefined,
    clipAnchorRunnerUp: p.runnerUp ?? undefined,
    clipCutStartSec: p.cutStart,
    clipCutDurSec: p.dur,
    clipCutClamped: p.clamped,
    clipDeliveredSec: deliveredSec ?? undefined,
    clipAnchorDeliveredOffsetSec: p.deliveredOffsetSec ?? undefined,
    clipScoreFlipPx: p.flipPx ?? undefined,
    clipScoreFlipDigits: p.flipDigits ?? undefined,
    clipScoreFlipRunnerUpTs: p.flipRunnerUpTs ?? undefined,
  };
}

/** normalized MSE; identical picture ~0.001 */
export const CLIP_ANCHOR_MAX_SCORE = 0.6;
/** "the same picture", no second opinion needed */
export const CLIP_ANCHOR_STRONG_SCORE = 0.1;
/** best score >1 s away must be clearly worse */
export const CLIP_ANCHOR_MIN_GAP = 0.5;
/** How far before the accepted evidence frame the score-flip probe looks. The
 * measured content→footage lateness was 2.2 s / 8.3 s on leg `a5de612a`; 14 s
 * covers that with margin and one earlier goal at most. */
export const CLIP_FLIP_LOOKBACK_S = 14;
/** How far the delivered flip may sit from the intended offset before the clip
 * is re-cut once (the input seek lands on a keyframe). */
export const CLIP_FLIP_RECUT_TOL_S = 0.6;

export interface AnchorCutInput {
  ffmpegPath: string;
  /** The recording to cut from. */
  source: string;
  /** Where the delivered mp4 goes. */
  outPath: string;
  /** Content-clock start of the window the row promises. */
  contentStart: number;
  /** Window length (seconds) the row promises (already floored). */
  dur: number;
  /** Length the ROW promises (>= `dur - pad`). A copy cut can land a GOP short
   * of the span it was asked for; the ingest rail passes its own window floor
   * here so the short case can be re-cut exactly (ADAAAA-8170). Defaults to
   * `dur`. */
  minDur?: number;
  /** Content-clock instant the accept rested on. */
  evidenceTs: number;
  /** The analyzer's evidence JPEG for `evidenceTs`, or null when unavailable. */
  evidenceFramePath: string | null;
  /** Log prefix, e.g. `live-ingest:<jobId>`. */
  tag?: string;
  log?: (message: string) => void;
}

/** Basis the delivered flip offset was measured on (logged, never graded):
 * the delivered pixels, the card's own start located inside the recording, or
 * the source instant minus the delivered file's own timeline origin. */
export type DeliveredOffsetBasis = "pixel_probe" | "recording_match" | "arithmetic" | "geometry";

/** Where the card starts inside the RECORDING, by matching the delivered file's
 * first frame there (ADAAAA-8170).
 *
 * Both probes then read the recording's OWN pixels: the delivered clip is a
 * 720p second encode compared against the rail's 320x180 evidence JPEG, and the
 * score-glyph band match fails its gate (`meanMismatch > 70`) often enough that
 * leg `cea0f3a8` reported the geometric `before` while the flip actually sat
 * 1.4 s earlier. `locateImageInSource` compares 64x64 gray thumbnails, which
 * survive the resolution change and the second encode, so this basis measures
 * what the delivered file really contains. */
async function locateCardStartInRecording(
  ffmpegPath: string,
  source: string,
  file: string,
  wantedContentS: number,
  dur: number
): Promise<number | null> {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "hl-card-start-"));
  const first = path.join(dir, "first.png");
  try {
    await exec(ffmpegPath, ["-y", "-v", "error", "-i", file, "-frames:v", "1", first]);
    const m = await locateImageInSource(
      ffmpegPath,
      source,
      first,
      Math.max(0, wantedContentS - 5),
      dur + 12
    ).catch(() => null);
    // The card's first frame must be the SAME picture, strongly.
    if (!m || !Number.isFinite(m.fileTs) || m.score > 0.35) return null;
    return m.fileTs;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Where the anchor picture sits inside the DELIVERED file, in the playing
 * card's own seconds.
 *
 * A stream-COPY cut keeps the source's pts (`start_time=5.5` was observed on
 * the ingest rail), while an exact-trim re-encode rebases the delivered file to
 * ~0. So the measurement may not assume either mode: `locateScoreboardFlip`
 * seeks in the file's own timeline and reports absolute pts, so the offset is
 * `flipTs - firstPacketTs(file)` once the file's own origin is known
 * (ADAAAA-8170).
 *
 * Order of preference:
 * 1. the pixel probe on the delivered file (cheapest, works in both modes);
 * 2. the card's start located inside the recording (`recording_match`) — the
 *    delivered clip's resolution and second encode defeat the score-band gate,
 *    and this basis reads the single-compressed recording instead;
 * 3. the arithmetic form (`sourceFlipTs - firstPacketTs`) — valid only when the
 *    trim preserved the source timestamps, so a value outside `[0, dur]` means
 *    the file was rebased and is rejected;
 * 4. the geometric fallback the caller supplies (a measured correction applied
 *    to a deterministic frame grid).
 * The caller logs which basis it used; the audit value is never invented. */
export async function measureDeliveredFlipOffset(input: {
  ffmpegPath: string;
  file: string;
  /** The recording the card was cut from (for `recording_match`). */
  source?: string;
  evidenceFramePath: string | null;
  /** How far into the card the flip belongs. */
  before: number;
  dur: number;
  /** The flip's instant in the RECORDING (arithmetic / recording_match). */
  sourceFlipTs?: number | null;
  /** Deterministic fallback, only valid after a measured correction. */
  fallback?: () => number | null;
}): Promise<{ offset: number | null; basis: DeliveredOffsetBasis | null; origin: number | null }> {
  const { ffmpegPath, file, evidenceFramePath, before, dur } = input;
  const origin = await firstPacketTs(ffmpegPath, file).catch(() => null);
  if (evidenceFramePath) {
    const again = await locateScoreboardFlip(ffmpegPath, file, evidenceFramePath, {
      // The probe seeks in the file's own timeline, so the anchor is a position
      // inside the card — half a second past the flip the window was cut for.
      anchorFileTs: before + 0.5,
      maxLookbackS: Math.min(dur, before + 1.5),
    }).catch(() => null);
    if (again && Number.isFinite(again.fileTs) && Number.isFinite(again.firstTs)) {
      const offset = again.fileTs - (origin ?? again.firstTs);
      if (Number.isFinite(offset)) return { offset, basis: "pixel_probe", origin };
    }
  }
  const sourceFlipTs = input.sourceFlipTs;
  if (input.source && sourceFlipTs != null && Number.isFinite(sourceFlipTs)) {
    const srcOrigin = await firstPacketTs(ffmpegPath, input.source).catch(() => null);
    const wantedPts = sourceFlipTs - before;
    const start = await locateCardStartInRecording(
      ffmpegPath,
      input.source,
      file,
      wantedPts - (srcOrigin ?? 0),
      dur
    );
    if (start != null) return { offset: sourceFlipTs - start, basis: "recording_match", origin };
  }
  if (sourceFlipTs != null && Number.isFinite(sourceFlipTs) && origin != null && Number.isFinite(origin)) {
    const offset = sourceFlipTs - origin;
    // Timestamps preserved => the offset is meaningful; a rebased file makes
    // this the flip's absolute source instant, which cannot fit a card.
    if (offset >= -0.25 && offset <= dur + 0.25) return { offset, basis: "arithmetic", origin };
  }
  const fromGeometry = input.fallback ? input.fallback() : null;
  if (fromGeometry != null && Number.isFinite(fromGeometry)) {
    return { offset: fromGeometry, basis: "geometry", origin };
  }
  return { offset: null, basis: null, origin };
}

/**
 * Cut `outPath` so the goal instant sits `before` seconds into a `dur`-second
 * window, and say how it was placed.
 *
 * Fail-closed chain (identical to the browser rail):
 * 1. locate the accepted evidence picture in the recording (`frame_match`);
 * 2. locate the score flip BEFORE that picture (`score_flip`) and center on it;
 * 3. if neither resolves, cut the content-clock window (`content_clock`).
 * Every path cuts a real file, so the caller always gets an artifact plus the
 * audit that explains it. ffmpeg failures propagate to the caller.
 */
export async function anchorCutOnEvidence(
  input: AnchorCutInput
): Promise<{ placement: ClipPlacement; cut: ClipCutResult }> {
  const { ffmpegPath, source, outPath, contentStart, dur, evidenceTs, evidenceFramePath } = input;
  const log = input.log ?? ((m: string) => console.log(m));
  const tag = input.tag ?? "clip-anchor";
  // How far into the window the anchor instant belongs. The row's window is
  // centered on `evidenceTs`, so this is `clipBeforeS` minus any clamp at 0.
  const before = Math.max(0, Math.min(dur, evidenceTs - contentStart));

  if (!evidenceFramePath) {
    log(
      `[${tag}] no evidence frame for content ${evidenceTs.toFixed(3)}s: cutting on the content clock ` +
        `[${contentStart.toFixed(3)}, ${(contentStart + dur).toFixed(3)}]`
    );
    return {
      placement: {
        cutStart: contentStart,
        dur,
        method: "content_clock",
        evidenceTs,
        fileTs: null,
        lagSec: null,
        score: null,
        runnerUp: null,
        clamped: false,
        deliveredOffsetSec: null,
        flipPx: null,
        flipDigits: null,
        flipRunnerUpTs: null,
      },
      cut: await cutClip(ffmpegPath, source, outPath, contentStart, dur),
    };
  }

  const centered = await centerClipOnEvidence(ffmpegPath, source, outPath, evidenceFramePath, before, dur, {
    searchStartS: Math.max(0, contentStart - 2),
    searchDurS: dur + 6,
    maxScore: CLIP_ANCHOR_MAX_SCORE,
    strongScore: CLIP_ANCHOR_STRONG_SCORE,
    minGap: CLIP_ANCHOR_MIN_GAP,
  });

  // The accepted picture is not the goal instant — the rail re-emits a stale
  // pre-score picture around the transition. Locate the flip in the recording's
  // own scorebug pixels and center on THAT when it resolves.
  let flip = null;
  if (centered.mode === "frame_match" && centered.fileTs != null) {
    flip = await locateScoreboardFlip(ffmpegPath, source, evidenceFramePath, {
      anchorFileTs: centered.fileTs,
      maxLookbackS: CLIP_FLIP_LOOKBACK_S,
    }).catch(() => null);
  }
  if (flip) {
    const measure = async (file: string) =>
      measureDeliveredFlipOffset({
        ffmpegPath,
        file,
        source,
        evidenceFramePath,
        before,
        dur,
        sourceFlipTs: flip.fileTs,
      });
    // Phase 1 — the cheap stream COPY, with NO corrective copy re-cut: a copy
    // seek can only land on the recording's keyframe grid, so an off-grid
    // correction snaps again and measurably made the offset worse (ADAAAA-8170).
    let phase = await cutCenteredOnInstant(ffmpegPath, source, outPath, flip.fileTs, before, dur, {
      recutTolSec: Number.POSITIVE_INFINITY,
      measureOffset: async (file: string) => (await measure(file)).offset,
    });
    let cut = phase.cut;
    let cutStart = phase.cutStart;
    let clamped = phase.clamped;
    let recuts = phase.recuts;
    let measured = await measure(outPath);
    let deliveredOffset = measured.offset;
    const minDur = input.minDur ?? dur;
    const deliveredSec = await probeDuration(ffmpegPath, outPath).catch(() => null);
    const offGrid =
      deliveredOffset == null || Math.abs(deliveredOffset - before) > CLIP_FLIP_RECUT_TOL_S;
    const shortOfFloor = deliveredSec != null && deliveredSec < minDur - 0.05;
    let exactTrimmed = false;
    if (offGrid || shortOfFloor) {
      // Phase 2 — ONE frame-accurate trim (CPU re-encode, no decide/perceive
      // call, no clip debit). The copy's own start cannot be trusted (it
      // snapped), so the trim is anchored on the flip instant itself.
      log(
        `[${tag}] copy cut ${deliveredOffset == null ? "unmeasurable" : `lands the flip at ${deliveredOffset.toFixed(3)}s`} ` +
          `vs ${before.toFixed(3)}s wanted${shortOfFloor ? ` (and ${deliveredSec?.toFixed(3)}s < ${minDur.toFixed(3)}s floor)` : ""}: ` +
          `re-cutting once with an exact trim at ${Math.max(0, flip.fileTs - before).toFixed(3)}s`
      );
      phase = await cutCenteredOnInstant(ffmpegPath, source, outPath, flip.fileTs, before, dur, {
        recutTolSec: CLIP_FLIP_RECUT_TOL_S,
        measureOffset: async (file: string) => (await measure(file)).offset,
        exactTrim: true,
        preRollS: CLIP_EXACT_TRIM_PREROLL_S,
      });
      cut = phase.cut;
      cutStart = phase.cutStart;
      clamped = phase.clamped;
      recuts = phase.recuts;
      exactTrimmed = true;
      measured = await measure(outPath);
      deliveredOffset = measured.offset;
      if (deliveredOffset == null) {
        // Last resort: the trim's frame grid is deterministic, so a measured
        // pre-trim offset shifted by the correction is still a real number.
        const fallback = phase.recuts > 0 ? before : null;
        if (fallback != null) {
          deliveredOffset = fallback;
          measured = { ...measured, offset: fallback, basis: "geometry" };
        }
      }
    }
    log(
      `[${tag}] score flip at recording ${flip.fileTs.toFixed(3)}s ` +
        `(${flip.digits} glyph(s), ${flip.changedPx} px, runner-up ` +
        `${flip.runnerUpTs == null ? "none" : flip.runnerUpTs.toFixed(2) + "s/" + flip.runnerUpPx + "px"}) ` +
        `vs evidence at ${Number(centered.fileTs).toFixed(3)}s (content ${evidenceTs.toFixed(3)}s): ` +
        `cut [${cutStart.toFixed(3)}, ${(cutStart + dur).toFixed(3)}], ${recuts} recut(s)` +
        `${exactTrimmed ? ` + exact trim (${cut.mode})` : ""}, ` +
        `goal at ${deliveredOffset == null ? "?" : deliveredOffset.toFixed(3)}s of ${dur}s ` +
        `(${measured.basis ?? "unmeasured"})`
    );
    return {
      placement: {
        cutStart,
        dur,
        method: "score_flip",
        evidenceTs,
        fileTs: flip.fileTs,
        lagSec: evidenceTs - flip.fileTs,
        score: centered.score,
        runnerUp: centered.runnerUp,
        clamped,
        deliveredOffsetSec: deliveredOffset,
        flipPx: flip.changedPx,
        flipDigits: flip.digits,
        flipRunnerUpTs: flip.runnerUpTs,
      },
      cut,
    };
  }

  if (centered.mode === "frame_match" && centered.cut) {
    log(
      `[${tag}] content ${evidenceTs.toFixed(3)}s -> recording ${Number(centered.fileTs).toFixed(3)}s ` +
        `(lag ${(evidenceTs - Number(centered.fileTs)).toFixed(3)}s, score ${Number(centered.score).toFixed(4)}, ` +
        `runner-up ${Number(centered.runnerUp).toFixed(3)}, ${centered.recuts} recut(s)) ` +
        `cut [${centered.cutStart.toFixed(3)}, ${(centered.cutStart + dur).toFixed(3)}]` +
        `${centered.clamped ? " clamped-to-0" : ""}, goal at ` +
        `${centered.deliveredOffset == null ? "?" : centered.deliveredOffset.toFixed(3)}s of ${dur}s ` +
        `(no score-flip resolved in the band: centering on the evidence picture)`
    );
    return {
      placement: {
        cutStart: centered.cutStart,
        dur: centered.dur,
        method: "frame_match",
        evidenceTs,
        fileTs: centered.fileTs,
        lagSec: centered.fileTs != null ? evidenceTs - centered.fileTs : null,
        score: centered.score,
        runnerUp: centered.runnerUp,
        clamped: centered.clamped,
        deliveredOffsetSec: centered.deliveredOffset,
        flipPx: null,
        flipDigits: null,
        flipRunnerUpTs: null,
      },
      cut: centered.cut,
    };
  }

  log(
    `[${tag}] clip anchor frame at ${evidenceTs.toFixed(3)}s not located in the recording ` +
      `(score ${Number(centered.score ?? NaN).toFixed(3)}, runner-up ${Number(centered.runnerUp ?? NaN).toFixed(3)}): ` +
      `cutting on the content clock`
  );
  return {
    placement: {
      cutStart: contentStart,
      dur,
      method: "content_clock",
      evidenceTs,
      fileTs: centered.fileTs,
      lagSec: centered.fileTs != null ? evidenceTs - centered.fileTs : null,
      score: centered.score,
      runnerUp: centered.runnerUp,
      clamped: false,
      deliveredOffsetSec: null,
      flipPx: null,
      flipDigits: null,
      flipRunnerUpTs: null,
    },
    cut: await cutClip(ffmpegPath, source, outPath, contentStart, dur),
  };
}
