/**
 * ADAAAA-8835 (Inc 1): per-job score-bug PIN + the board-visible provenance of
 * the score surface the pipeline actually cropped.
 *
 * The score-bug region used to be a single PROCESS-GLOBAL env box
 * (`PERCEIVE_SCOREBOARD_ROI`) or a region the session auto-located once and
 * cached for the whole source. A live stream can carry a PIP of another game
 * with its own score bug inside that band, so the scoreboard OCR read the
 * foreign bug and a score change there cut a clip (parent ADAAAA-8833).
 *
 * This module owns the two IO-free pieces of the fix:
 *
 *  1. `parseScoreboardRoi` — the validation gate for the pin an operator submits
 *     on job create (`POST /jobs` / `POST /jobs/upload`). Absent input is
 *     `{ ok: true, roi: undefined }` so an unpinned submit stays byte-identical.
 *  2. `nextScoreboardSurface` / `declaredScoreboardSurface` — the provenance
 *     block (`{roi, source, seqFirstSeen, verified}`) that is read back on the
 *     job API and job page. It is derived from what perceive reports for the
 *     crop it actually took, so it is a measurement, never an inference.
 *
 * Truthfulness rules (AC6):
 *  - `source` is MAPPED from perceive's own `scoreboard_roi_source`; the server
 *    never labels a pin as `discovery` and never invents a box.
 *  - `seqFirstSeen` is the observation seq at which the reported box/source first
 *    appeared. `-1` means "declared at job create, no observation yet".
 *  - `verified` is monotonic per box: it latches true the first time that box's
 *    crop produced a parseable score, and resets to false when the box changes.
 */

import type { ScoreboardSurfaceIdentity as EventsScoreboardSurfaceIdentity } from "@highlights/events";

export type ScoreboardRoiBox = [number, number, number, number];

/** The three provenance classes the board exposes (ADAAAA-8835 AC6). */
export type ScoreboardSurfaceSource = "explicit" | "discovery" | "default_top_band";

/**
 * ADAAAA-8844 (Inc 2): whether the surface the crop read can be shown to be THIS
 * match's surface. Computed in perceive from the crop it already took (kit
 * swatches + the printed team tokens) against the job's `matchContext`, and
 * folded here so the job page, the decide request and the accept lane all read
 * ONE verdict.
 */
export type ScoreboardSurfaceIdentityVerdict = "consistent" | "contradicted" | "absent";

/** The stored shape is the SHARED contract (`ScoreboardSurfaceIdentitySchema` in
 * @highlights/events), so the job record, the job API and the webapp cannot drift
 * from what this module writes. */
export type ScoreboardSurfaceIdentity = EventsScoreboardSurfaceIdentity;

export interface ScoreboardSurfaceBlock {
  roi: ScoreboardRoiBox;
  source: ScoreboardSurfaceSource;
  seqFirstSeen: number;
  verified: boolean;
  /** ADAAAA-8844: the surface-identity verdict for this box, once measured. */
  identity?: ScoreboardSurfaceIdentity;
  /** ADAAAA-8844: the most recent named demotion on this surface (scope item 5),
   * so the board can see WHY a window's score change was not accepted. */
  demotion?: string;
}

export type ScoreboardSurfaceParseResult =
  | { ok: true; roi: ScoreboardRoiBox | undefined }
  | { ok: false; message: string; code: string };

const ROI_TOLERANCE = 1e-6;

/**
 * Validate a submitted `scoreboardRoi`.
 *
 * Contract: exactly four finite numbers in 0..1 ordered `[x0, y0, x1, y1]` with
 * a non-zero width and height. Absent (`undefined`/`null`) is a valid "no pin".
 * A malformed value is a 422 at job create — silently dropping it would scope
 * the OCR onto whatever the session discovered, which is exactly the defect the
 * pin exists to remove.
 */
export function parseScoreboardRoi(input: unknown): ScoreboardSurfaceParseResult {
  if (input === undefined || input === null) return { ok: true, roi: undefined };
  const bad = (message: string): ScoreboardSurfaceParseResult => ({
    ok: false,
    message,
    code: "invalid_scoreboard_roi",
  });
  if (!Array.isArray(input) || input.length !== 4) {
    return bad("scoreboardRoi must be [x0, y0, x1, y1] (four normalized numbers 0..1)");
  }
  const vals = input.map((v) => (typeof v === "number" ? v : Number.NaN));
  if (vals.some((v) => !Number.isFinite(v))) {
    return bad("scoreboardRoi must contain four finite numbers");
  }
  const [x0, y0, x1, y1] = vals as ScoreboardRoiBox;
  if (vals.some((v) => v < 0 || v > 1)) {
    return bad("scoreboardRoi values must be normalized 0..1");
  }
  if (!(x0 < x1) || !(y0 < y1)) {
    return bad("scoreboardRoi must satisfy x0 < x1 and y0 < y1");
  }
  return { ok: true, roi: [x0, y0, x1, y1] };
}

/**
 * Map perceive's raw `scoreboard_roi_source` onto the three board classes.
 *
 * Perceive distinguishes many internal sources (locator/discovery, temporal
 * selector, the crop that parsed a score, the proven incumbent, the bottom-centre
 * repair prior, ...). The board only needs to answer "did the operator pin this,
 * did we guess it from the picture, or is it the shipped prior?" — the `roi` in
 * the same block stays authoritative about the actual box.
 */
export function mapScoreboardRoiSource(raw: string | null | undefined): ScoreboardSurfaceSource {
  const s = String(raw || "").trim();
  if (s === "explicit") return "explicit";
  // Built-in documented priors: the top band (`ScoreboardRoi.from_env()` default,
  // also used on a discovery miss) and the bottom-centre repair/fallback prior.
  if (s === "default_top_band" || s === "default_top_band_miss" || s === "abandoned_bottom_prior") {
    return "default_top_band";
  }
  // Everything else perceive can report (discovery, selector, learned_crop,
  // incumbent_proven_box, restored_proven_box, vision, discovery_rejected,
  // bottom_prior_repair) is a region the session located/adopted from the
  // picture, i.e. discovery. An unknown/empty source is treated the same way: it
  // was NOT an operator pin, so it must never read as `explicit`.
  return "discovery";
}

function sameRoi(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (!a || !b || a.length !== 4 || b.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    if (!(Math.abs(Number(a[i]) - Number(b[i])) <= ROI_TOLERANCE)) return false;
  }
  return true;
}

function sameStringList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  return aa.every((v, i) => v === bb[i]);
}

function sameKitRecord(
  a: Record<string, number[]> | undefined,
  b: Record<string, number[]> | undefined
): boolean {
  const aa = Object.entries(a ?? {});
  const bb = Object.entries(b ?? {});
  if (aa.length !== bb.length) return false;
  for (const [side, colour] of aa) {
    const other = (b ?? {})[side];
    if (!other || other.length !== colour.length) return false;
    if (!colour.every((v, i) => Number(v) === Number(other[i]))) return false;
  }
  return true;
}

/**
 * ADAAAA-8935: whether two identity blocks describe the SAME measurement.
 *
 * `seqFirstSeen` is deliberately EXCLUDED: it is the marker of when the verdict
 * was first measured, not part of the measurement, so re-reporting the same
 * verdict on a later frame must not read as a change (that would turn one
 * measured surface into a per-frame write).
 */
export function sameSurfaceIdentity(
  a: ScoreboardSurfaceIdentity | undefined,
  b: ScoreboardSurfaceIdentity | undefined
): boolean {
  if (!a || !b) return a === b;
  return (
    a.verdict === b.verdict &&
    (a.kitDistance ?? null) === (b.kitDistance ?? null) &&
    (a.threshold ?? null) === (b.threshold ?? null) &&
    Boolean(a.kitsPresent) === Boolean(b.kitsPresent) &&
    Boolean(a.kitsDiffer) === Boolean(b.kitsDiffer) &&
    (a.kitReference ?? null) === (b.kitReference ?? null) &&
    Boolean(a.namesMatch) === Boolean(b.namesMatch) &&
    sameStringList(a.namesMatched, b.namesMatched) &&
    sameStringList(a.names, b.names) &&
    sameKitRecord(a.kits, b.kits)
  );
}

/**
 * ADAAAA-8935: the change guard for the whole block.
 *
 * It used to compare only `source`/`seqFirstSeen`/`verified`/`roi`, so an
 * observation that reported a VERDICT on an already-persisted box folded to a
 * block that compared equal: the writer returned early, `patchJob` never ran,
 * and the identity was dropped forever (`jobs.record->'scoreboardSurface' ? 'identity'`
 * was 0 across the whole table). Identity and the named demotion are part of the
 * block's own state, so they belong in this comparison.
 */
export function sameScoreboardSurface(a: ScoreboardSurfaceBlock | undefined, b: ScoreboardSurfaceBlock | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.source === b.source &&
    a.seqFirstSeen === b.seqFirstSeen &&
    a.verified === b.verified &&
    sameRoi(a.roi, b.roi) &&
    sameSurfaceIdentity(a.identity, b.identity) &&
    (a.demotion ?? "") === (b.demotion ?? "")
  );
}

/** The block a pinned job carries from CREATION, before any frame runs.
 * `seqFirstSeen: -1` is the declared-not-yet-observed marker; the first
 * observation of the pin upgrades it to that frame's seq. */
export function declaredScoreboardSurface(pin: ScoreboardRoiBox): ScoreboardSurfaceBlock {
  return { roi: [...pin] as ScoreboardRoiBox, source: "explicit", seqFirstSeen: -1, verified: false };
}

/** The additive fields perceive reports per observation (all optional, so an
 * older runner makes them absent — never zero/fabricated). */
export interface ReportedScoreboardSurface {
  seq?: number;
  scoreboardRoi?: unknown;
  scoreboardRoiSource?: unknown;
  scoreboardRoiVerified?: unknown;
  /** ADAAAA-8844: the surface-identity verdict, published on the one-off pass. */
  scoreboardSurfaceIdentity?: unknown;
  /** ADAAAA-8844: the named demotion when a score change on this surface was
   * ignored (scope item 5). */
  scoreboardSurfaceDemoted?: unknown;
}

const IDENTITY_VERDICTS: ReadonlySet<string> = new Set(["consistent", "contradicted", "absent"]);
const DEMOTION_MAX_CHARS = 240;

/** Coerce one reported identity into the stored shape (never throws, never guesses:
 * an unrecognised verdict is absent, which keeps today's behaviour). */
export function normalizeSurfaceIdentity(raw: unknown): ScoreboardSurfaceIdentity | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const verdict = String(r.verdict || "");
  if (!IDENTITY_VERDICTS.has(verdict)) return undefined;
  const num = (v: unknown, fallback = 0): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const list = (v: unknown, cap: number): string[] =>
    Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, cap).map((x) => String(x).slice(0, 40)) : [];
  const kits: Record<string, number[]> = {};
  if (r.kits && typeof r.kits === "object") {
    for (const [side, colour] of Object.entries(r.kits as Record<string, unknown>)) {
      if (side !== "home" && side !== "away") continue;
      if (!Array.isArray(colour) || colour.length !== 3) continue;
      const rgb = colour.map((c) => (typeof c === "number" && Number.isFinite(c) ? Math.round(c) : NaN));
      if (rgb.some((c) => Number.isNaN(c))) continue;
      kits[side] = rgb as number[];
    }
  }
  const reference = r.kitReference === "observed" || r.kitReference === "prior" ? r.kitReference : undefined;
  return {
    verdict: verdict as ScoreboardSurfaceIdentityVerdict,
    kitDistance: typeof r.kitDistance === "number" && Number.isFinite(r.kitDistance) ? Number(r.kitDistance) : null,
    threshold: num(r.threshold),
    kitsPresent: r.kitsPresent === true,
    kitsDiffer: r.kitsDiffer === true,
    // ADAAAA-8908: the reference the distance was measured against. Omitted (not
    // guessed) when an older runner does not report it.
    ...(reference ? { kitReference: reference } : {}),
    namesMatch: r.namesMatch === true,
    namesMatched: list(r.namesMatched, 4),
    names: list(r.names, 8),
    kits,
  };
}

/**
 * Whether a score change measured on this surface may ATTEST a goal (ADAAAA-8844).
 *
 * `contradicted` is the only verdict that demotes: the kits sit outside the
 * measured bar AND the printed names do not match this match, so the surface is
 * demonstrably a different one. `absent` is NOT contradiction — an unreadable
 * surface keeps today's behaviour (AC2.3), because demoting what we cannot read
 * would spend recall on nothing.
 */
export function scoreboardSurfaceAttests(block: ScoreboardSurfaceBlock | undefined): boolean {
  return block?.identity?.verdict !== "contradicted";
}

/** The named demotion for a contradicted surface (scope item 5). */
export function scoreboardSurfaceDemotionNote(identity: ScoreboardSurfaceIdentity | undefined): string {
  if (!identity || identity.verdict !== "contradicted") return "";
  const d = identity.kitDistance;
  const kit =
    d === null || d === undefined
      ? "kits differ"
      : `kits Δ=${d.toFixed(2)} > ${identity.threshold ?? "the measured bar"}`;
  const matched = identity.namesMatched ?? [];
  const printed = identity.names ?? [];
  const names = matched.length ? matched.join(", ") : printed.join(", ");
  return `score change on a contradicted score surface: ignored (${kit}; printed names ${names || "none"} unmatched)`;
}

/**
 * ADAAAA-8935: fold a reported identity onto the block's existing one.
 *
 * The marker `seqFirstSeen` on the identity is "the frame this verdict was first
 * measured at". Re-reporting the SAME measurement on a later frame keeps that
 * marker (so the block compares unchanged and costs no write); a genuinely new
 * measurement gets this frame's seq.
 */
function foldSurfaceIdentity(
  prev: ScoreboardSurfaceIdentity | undefined,
  reported: ScoreboardSurfaceIdentity,
  seq: number
): ScoreboardSurfaceIdentity {
  if (prev && sameSurfaceIdentity(prev, reported)) {
    return { ...reported, seqFirstSeen: prev.seqFirstSeen ?? seq };
  }
  return { ...reported, seqFirstSeen: seq };
}

/**
 * Fold one observation's reported crop into the job's provenance block.
 *
 * Returns `undefined` when the observation carries no reported box (old runner /
 * frame with no OCR pass), so the caller leaves the record untouched. The caller
 * persists only when the returned block differs from the stored one
 * (`sameScoreboardSurface`), so this costs no per-frame write.
 */
export function nextScoreboardSurface(
  prev: ScoreboardSurfaceBlock | undefined,
  obs: ReportedScoreboardSurface
): ScoreboardSurfaceBlock | undefined {
  const parsed = parseScoreboardRoi(obs.scoreboardRoi);
  if (!parsed.ok || !parsed.roi) return undefined;
  const roi = parsed.roi;
  const source = mapScoreboardRoiSource(
    typeof obs.scoreboardRoiSource === "string" ? obs.scoreboardRoiSource : undefined
  );
  const observedVerified = obs.scoreboardRoiVerified === true;
  const seq = typeof obs.seq === "number" && Number.isFinite(obs.seq) ? Math.trunc(obs.seq) : -1;
  // ADAAAA-8844: identity and the demotion note ride the same observation. The
  // verdict is a property of the SURFACE, so it is sticky while the box is; a new
  // box starts without one (it has not been measured yet).
  const reportedIdentity = normalizeSurfaceIdentity(obs.scoreboardSurfaceIdentity);
  const demotion =
    typeof obs.scoreboardSurfaceDemoted === "string" && obs.scoreboardSurfaceDemoted.trim()
      ? obs.scoreboardSurfaceDemoted.trim().slice(0, DEMOTION_MAX_CHARS)
      : undefined;
  const sameSurface = Boolean(prev && prev.source === source && sameRoi(prev.roi, roi));

  if (prev && sameSurface) {
    // Same surface: latch `verified`, and fill in the declared-not-yet-observed
    // marker the first time an observation actually reports this pin.
    return {
      roi: prev.roi,
      source: prev.source,
      seqFirstSeen: prev.seqFirstSeen < 0 ? seq : prev.seqFirstSeen,
      verified: prev.verified || observedVerified,
      ...(reportedIdentity
        ? { identity: foldSurfaceIdentity(prev.identity, reportedIdentity, seq) }
        : prev.identity
          ? { identity: prev.identity }
          : {}),
      ...(demotion ? { demotion } : prev.demotion ? { demotion: prev.demotion } : {}),
    };
  }
  // New box (or new provenance): a new surface starts its own seq + verification,
  // and its identity must be measured before it can attest anything.
  return {
    roi,
    source,
    seqFirstSeen: seq,
    verified: observedVerified,
    ...(reportedIdentity ? { identity: { ...reportedIdentity, seqFirstSeen: seq } } : {}),
    ...(demotion ? { demotion } : {}),
  };
}

/** ADAAAA-8844: fold an observation that carried ONLY a demotion (no reported box
 * — a pinned session reports one every frame, an unpinned one may not) so the
 * job page still names why a window's score change was ignored. Returns
 * `undefined` when there is nothing to change. */
export function withSurfaceDemotion(
  prev: ScoreboardSurfaceBlock | undefined,
  note: unknown
): ScoreboardSurfaceBlock | undefined {
  const text = typeof note === "string" ? note.trim().slice(0, DEMOTION_MAX_CHARS) : "";
  if (!prev || !text) return undefined;
  if (prev.demotion === text) return undefined;
  return { ...prev, demotion: text };
}
