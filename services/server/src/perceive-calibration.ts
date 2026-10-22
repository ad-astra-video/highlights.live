/**
 * ADAAAA-7152 (Gap 2): per-session pitch calibration the server carries on the
 * VOD / live job path and forwards to a perceive session via the `configure`
 * control message, so perceive emits a REAL `goalCrossed` / `ballOutcome`
 * attestation that the decide goal-attestation gate can fold into a
 * `scoring_play` accept — instead of an uncalibrated box silently judging no
 * goal channel at all (`goalCrossed:null, ballOutcome:null`).
 *
 * IMPORTANT (honesty constraint from ADAAAA-6485 / ADAAAA-7021): the server
 * NEVER invents a calibration. The values are sourced ONLY from explicit
 * per-camera config (the `PERCEIVE_CALIBRATION_JSON` env var, a map keyed by
 * camera id with a reserved `default` entry). When no calibration is configured
 * for the job's camera, `resolvePerceiveCalibration` returns `undefined` and the
 * server sends NO `configure` control — the perceive session stays uncalibrated
 * (no goal channel), which is the recall-safe baseline. Flipping the perceive
 * container's uncalibrated `PERCEIVE_GOAL_LINE` / `PERCEIVE_PITCH_HOMOGRAPHY`
 * env flags is NOT an acceptable substitute and is never done here.
 */

/** Goal-line plane spec in FIELD coordinates (mirrors the perceive
 * `GoalLineSpec` dataclass: `axis` is the field axis perpendicular to the goal
 * line, `position` the goal-line coordinate on that axis, `mouthMin`/`mouthMax`
 * the goal-mouth span on the cross axis). */
export interface PerceiveGoalLineConfig {
  axis: "x" | "y";
  position: number;
  mouthMin: number;
  mouthMax: number;
}

/** One camera's calibration: an optional row-major 3x3 image->field homography
 * and an optional goal-line spec. At least one must be present for the entry to
 * be usable. */
export interface PerceiveCalibration {
  homography?: number[][];
  goalLine?: PerceiveGoalLineConfig;
}

/** Per-camera calibration map. A reserved `default` entry applies to any camera
 * without an explicit entry. Keyed by camera id (e.g. `"stadium-north"`). */
export type PerceiveCalibrationMap = Record<string, PerceiveCalibration>;

function isNumberArray3(v: unknown): v is number[][] {
  return (
    Array.isArray(v) &&
    v.length === 3 &&
    v.every((row) => Array.isArray(row) && row.length === 3 && row.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}

/** Normalize one raw JSON value into a `PerceiveCalibration`, or `undefined` if
 * it carries neither a usable homography nor a usable goalLine. A malformed entry
 * is dropped (never fabricated, never fatal) so a bad camera entry cannot poison
 * the whole map. */
function normalizeCalibration(raw: unknown): PerceiveCalibration | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const out: PerceiveCalibration = {};
  if (isNumberArray3(o.homography)) out.homography = o.homography;
  if (o.goalLine && typeof o.goalLine === "object") {
    const g = o.goalLine as Record<string, unknown>;
    const axis = String(g.axis ?? "y").toLowerCase();
    const position = Number(g.position);
    const mouthMin = Number(g.mouthMin ?? g.mouth_min);
    const mouthMax = Number(g.mouthMax ?? g.mouth_max);
    if (
      (axis === "x" || axis === "y") &&
      Number.isFinite(position) &&
      Number.isFinite(mouthMin) &&
      Number.isFinite(mouthMax) &&
      mouthMin < mouthMax
    ) {
      out.goalLine = {
        axis: axis as "x" | "y",
        position,
        mouthMin,
        mouthMax,
      };
    }
  }
  return out.homography || out.goalLine ? out : undefined;
}

/**
 * Parse the `PERCEIVE_CALIBRATION_JSON` env value into a `PerceiveCalibrationMap`.
 *
 * Accepted shapes:
 *  - A map keyed by camera id, e.g.
 *      `{ "stadium-north": { "homography": [[...],[...],[...]], "goalLine": {...} }, "default": {...} }`
 *  - A bare single calibration object (has `homography` or `goalLine` at the top
 *    level) is treated as the `default` camera entry.
 *
 * Returns `undefined` when the env value is unset, unparseable, or contains no
 * valid calibration entry — so an unconfigured deployment behaves exactly as
 * before (no goal channel).
 */
export function parsePerceiveCalibration(raw: string | undefined): PerceiveCalibrationMap | undefined {
  if (!raw) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  // Bare calibration object (top-level has homography/goalLine) => the default.
  const bare = normalizeCalibration(o);
  if (bare && (isNumberArray3(o.homography) || (o.goalLine && typeof o.goalLine === "object"))) {
    return { default: bare };
  }
  const out: PerceiveCalibrationMap = {};
  for (const [key, entry] of Object.entries(o)) {
    const c = normalizeCalibration(entry);
    if (c) out[key] = c;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Resolve the calibration for a specific camera. `cameraId` picks an explicit
 * entry; an explicit entry always wins over the `default`. Returns `undefined`
 * when nothing is configured for the camera so the caller sends no `configure`
 * control (unchanged / recall-safe). */
export function resolvePerceiveCalibration(
  map: PerceiveCalibrationMap | undefined,
  cameraId?: string
): PerceiveCalibration | undefined {
  if (!map) return undefined;
  if (cameraId && map[cameraId]) return map[cameraId];
  return map["default"];
}
