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
  LIVE_OBSERVE_WINDOW_S,
  OBSERVE_CADENCE_S,
  OBSERVE_CONTENT_FPS,
} from "./observe-loop";

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
}

/**
 * The boot lines for the live decide cell, in the order the server logs them.
 * One line per axis so a log grep names the axis it graded.
 */
export function liveDecideBootLines(cfg: LiveDecidePosture): string[] {
  const span = cfg.liveObserveWindowS ?? LIVE_OBSERVE_WINDOW_S;
  const cadenceMs = Math.round((cfg.liveObserveCadenceS ?? OBSERVE_CADENCE_S) * 1000);
  return [
    `[boot] live decide image budget: ${cfg.liveObserveMaxFrames} image(s)/decide ` +
      `(LIVE_OBSERVE_MAX_FRAMES, default ${LIVE_DECIDE_IMAGE_BUDGET}, ceiling ${LIVE_DECIDE_IMAGE_CEILING}, ` +
      `trigger-anchored selection)`,
    `[boot] live decide concurrency: ${cfg.liveObserveInFlight} decide(s) in flight ` +
      `(LIVE_OBSERVE_IN_FLIGHT, default ${LIVE_DECIDE_IN_FLIGHT_DEFAULT}, ceiling 4)`,
    `[boot] live decide window: ${span} s span / ${cadenceMs} ms cadence ` +
      `(LIVE_OBSERVE_WINDOW_S default ${LIVE_OBSERVE_WINDOW_S}, LIVE_OBSERVE_CADENCE_S default ` +
      `${OBSERVE_CADENCE_S} s, trailing window)`,
    // ADAAAA-8102: the CONTENT consume rate both live rails analyse at. Named
    // here for the same reason as the other three: `printenv` is not evidence,
    // the decide rows carry `contentFps` and the media rail publishes its
    // `perceive` stride block, and this line states what THIS process resolved.
    `[boot] live content consume: ${cfg.liveObserveContentFps ?? OBSERVE_CONTENT_FPS} fps ` +
      `(LIVE_OBSERVE_CONTENT_FPS, default ${OBSERVE_CONTENT_FPS}, both live rails; ` +
      `ingest sampleFps still governs persistence + clip cut)`,
  ];
}
