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
import {
  centerClipOnEvidence,
  cutClip,
  cutCenteredOnInstant,
  locateScoreboardFlip,
  type ClipCutResult,
} from "./ffmpeg";

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
  /** Content-clock instant the accept rested on. */
  evidenceTs: number;
  /** The analyzer's evidence JPEG for `evidenceTs`, or null when unavailable. */
  evidenceFramePath: string | null;
  /** Log prefix, e.g. `live-ingest:<jobId>`. */
  tag?: string;
  log?: (message: string) => void;
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
    const recut = await cutCenteredOnInstant(ffmpegPath, source, outPath, flip.fileTs, before, dur, {
      recutTolSec: CLIP_FLIP_RECUT_TOL_S,
      measureOffset: async (file) => {
        // Re-measure the flip INSIDE the delivered file: the input seek's
        // keyframe pre-roll can move the whole window, and the delivered offset
        // is the number ACC-2 grades.
        const again = await locateScoreboardFlip(ffmpegPath, file, evidenceFramePath, {
          anchorFileTs: before + 0.5,
          maxLookbackS: Math.min(dur, before + 1.5),
        }).catch(() => null);
        return again && Number.isFinite(again.firstTs) ? again.fileTs - again.firstTs : null;
      },
    });
    log(
      `[${tag}] score flip at recording ${flip.fileTs.toFixed(3)}s ` +
        `(${flip.digits} glyph(s), ${flip.changedPx} px, runner-up ` +
        `${flip.runnerUpTs == null ? "none" : flip.runnerUpTs.toFixed(2) + "s/" + flip.runnerUpPx + "px"}) ` +
        `vs evidence at ${Number(centered.fileTs).toFixed(3)}s (content ${evidenceTs.toFixed(3)}s): ` +
        `cut [${recut.cutStart.toFixed(3)}, ${(recut.cutStart + dur).toFixed(3)}], ${recut.recuts} recut(s), ` +
        `goal at ${recut.deliveredOffset == null ? "?" : recut.deliveredOffset.toFixed(3)}s of ${dur}s`
    );
    return {
      placement: {
        cutStart: recut.cutStart,
        dur: recut.dur,
        method: "score_flip",
        evidenceTs,
        fileTs: flip.fileTs,
        lagSec: evidenceTs - flip.fileTs,
        score: centered.score,
        runnerUp: centered.runnerUp,
        clamped: recut.clamped,
        deliveredOffsetSec: recut.deliveredOffset,
        flipPx: flip.changedPx,
        flipDigits: flip.digits,
        flipRunnerUpTs: flip.runnerUpTs,
      },
      cut: recut.cut,
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
