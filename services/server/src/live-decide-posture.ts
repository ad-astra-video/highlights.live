// ADAAAA-8065 (rev 7) Step 3: the boot posture readout names ALL FOUR values of
// the shipped cell — image budget, in-flight budget, window span, cadence.
//
// `printenv` is not evidence (the ADAAAA-8074 lesson: a value that only lives in
// the environment is not a value). The decide_audit rows carry
// `imagesPerDecide` / `imageBudgetApplied` / `spanSec` / `cadenceMs`, so this
// readout states which values THIS process resolved and a grade compares the two
// sets rather than trusting a container env dump.
//
// It is a pure function of the resolved config so the readout itself is testable
// and a fifth knob cannot be added without the line saying so.
import {
  LIVE_DECIDE_IMAGE_BUDGET,
  LIVE_DECIDE_IMAGE_CEILING,
  LIVE_OBSERVE_CADENCE_S,
  LIVE_OBSERVE_WINDOW_S,
  OBSERVE_CONTENT_FPS,
} from "./observe-loop";
import { LIVE_FRAME_SCALE_DEFAULT } from "./config";

/** Default in-flight budget (`LIVE_OBSERVE_IN_FLIGHT` unset). */
export const LIVE_DECIDE_IN_FLIGHT_DEFAULT = 4;

export interface LiveDecidePosture {
  liveObserveMaxFrames: number;
  liveObserveInFlight: number;
  liveObserveWindowS?: number;
  liveObserveCadenceS?: number;
  /** ADAAAA-8102: the CONTENT consume rate (`LIVE_OBSERVE_CONTENT_FPS`), undefined
   *  = the 2 fps default. */
  liveObserveContentFps?: number;
  /** ADAAAA-8108: the live decide ENRICHMENT arm (`LIVE_DECIDE_ENRICH`), undefined
   *  = the shipped `on`. */
  liveDecideEnrich?: "on" | "off" | "alternate";
  /** ADAAAA-8377: the LIVE rail's sampled-frame scale (`LIVE_FRAME_SCALE`,
   * resolved to today's 320:180 when unset). Undefined = the shipped default. */
  liveFrameScale?: string;
  /** ADAAAA-8395 (LFR-1 AC-5): the perceive runner's bounded ROI second pass
   * posture (`PERCEIVE_ROI_ENABLED`). Undefined = unset (reported as off). */
  perceiveRoiEnabled?: boolean;
  /** ADAAAA-8395: the ROI tile grid (`PERCEIVE_ROI_GRID`), reported only. */
  perceiveRoiGrid?: string;
}

/**
 * The boot lines for the live decide cell, in the order the server logs them.
 * One line per axis so a log grep names the axis it graded.
 */
export function liveDecideBootLines(cfg: LiveDecidePosture): string[] {
  const span = cfg.liveObserveWindowS ?? LIVE_OBSERVE_WINDOW_S;
  const cadenceMs = Math.round((cfg.liveObserveCadenceS ?? LIVE_OBSERVE_CADENCE_S) * 1000);
  return [
    `[boot] live decide image budget: ${cfg.liveObserveMaxFrames} image(s)/decide ` +
      `(LIVE_OBSERVE_MAX_FRAMES, default ${LIVE_DECIDE_IMAGE_BUDGET}, ceiling ${LIVE_DECIDE_IMAGE_CEILING}, ` +
      `trigger-anchored selection)`,
    // ADAAAA-8377 (LFR-1): the live rail's sampled-frame SCALE, beside the image
    // budget it multiplies with. `printenv` is not evidence, and the ON arm of
    // the frame-scale A/B must be readable at boot — this line states what THIS
    // process resolved, and every decide row carries the measured `imageW`/
    // `imageH` so the grade compares the two instead of trusting the env dump.
    `[boot] live frame scale: ${cfg.liveFrameScale ?? LIVE_FRAME_SCALE_DEFAULT} ` +
      `(LIVE_FRAME_SCALE, default ${LIVE_FRAME_SCALE_DEFAULT}, live rail JPEG -> perceive + decide)`,
    `[boot] live decide concurrency: ${cfg.liveObserveInFlight} decide(s) in flight ` +
      `(LIVE_OBSERVE_IN_FLIGHT, default ${LIVE_DECIDE_IN_FLIGHT_DEFAULT}, ceiling 4)`,
    `[boot] live decide window: ${span} s span / ${cadenceMs} ms cadence ` +
      `(LIVE_OBSERVE_WINDOW_S default ${LIVE_OBSERVE_WINDOW_S}, LIVE_OBSERVE_CADENCE_S default ` +
      `${LIVE_OBSERVE_CADENCE_S} s, trailing window)`,
    // ADAAAA-8102: the CONTENT consume rate both live rails analyse at. Named
    // here for the same reason as the other three: `printenv` is not evidence,
    // the decide rows carry `contentFps` and the media rail publishes its
    // `perceive` stride block, and this line states what THIS process resolved.
    `[boot] live content consume: ${cfg.liveObserveContentFps ?? OBSERVE_CONTENT_FPS} fps ` +
      `(LIVE_OBSERVE_CONTENT_FPS, default ${OBSERVE_CONTENT_FPS}, both live rails; ` +
      `ingest sampleFps still governs persistence + clip cut)`,
    // ADAAAA-8108 (AC-E3): the ENRICHMENT arm. A leg's ON/OFF split is graded off
    // `perceiveTimeline.enrichmentArm` on each decide row; this line states what
    // THIS process resolved for the arm, so a recreate that booted the wrong arm
    // is readable in the log instead of being inferred from latency.
    `[boot] live decide enrichment: ${cfg.liveDecideEnrich ?? "on"} ` +
      `(LIVE_DECIDE_ENRICH, default on; off/alternate are the AC-E3 measurement arms ` +
      `and alternate starts OFF)`,
    // ADAAAA-8395 (LFR-1 AC-5): the perceive ROI-pass posture, on the SAME
    // readout (no second readout). The pass is env-gated in the perceive runner;
    // this line states the value the shared docker/.env hands both containers,
    // and the MEASURED tell is `roiEnabled`/`roiPasses` on each observation plus
    // the job's `observeMetrics.perceive`. `off` is the shipped posture.
    `[boot] live perceive ROI pass: ${cfg.perceiveRoiEnabled ? "on" : "off"} ` +
      `(PERCEIVE_ROI_ENABLED, default off, grid ${cfg.perceiveRoiGrid ?? "3x4"}; ` +
      `perceive owns the gate, measured per frame as roiPasses/roiTiles)`,
  ];
}
