/**
 * ADAAAA-8835 (Inc 1): the typed score-bug box on the job form, and the copy the
 * job page uses for the read-only `scoreboardSurface` block.
 *
 * The pin is a NORMALIZED box `[x0, y0, x1, y1]` (0..1 of the frame), so it is
 * resolution independent — the same numbers hold for a 640x360 browser share and
 * a 1920x1080 VOD. Inc 1 is a typed box only: click-to-draw on a preview frame
 * is a separate UX increment.
 *
 * Keep the accepted/rejected shapes in step with the server's
 * `parseScoreboardRoi` (services/server/src/scoreboard-surface.ts): exactly four
 * finite numbers in 0..1 ordered `[x0, y0, x1, y1]` with non-zero width/height.
 */

export type ScoreboardRoi = [number, number, number, number];

export interface ScoreboardSurfaceIdentity {
  verdict: "consistent" | "contradicted" | "absent";
  kitDistance?: number | null;
  threshold?: number;
  namesMatched?: string[];
  names?: string[];
}

export interface ScoreboardSurface {
  roi: ScoreboardRoi;
  source: "explicit" | "discovery" | "default_top_band";
  seqFirstSeen: number;
  verified: boolean;
  /** ADAAAA-8844 (Inc 2): whether this surface can be shown to be this match's. */
  identity?: ScoreboardSurfaceIdentity;
  /** ADAAAA-8844: why a score change on this surface was ignored. */
  demotion?: string;
}

/**
 * ADAAAA-8844 (Inc 2): the identity verdict in one short phrase.
 *
 * `contradicted` is the only verdict that demotes a score change, so it names the
 * measurement (`kits Δ` vs the bar) rather than just the word — the board has to
 * be able to tell a foreign surface from an unreadable one.
 */
export function describeSurfaceIdentity(
  identity: ScoreboardSurfaceIdentity | undefined
): string {
  if (!identity) return "";
  if (identity.verdict === "contradicted") {
    const d = identity.kitDistance;
    const bar = identity.threshold;
    const measured =
      typeof d === "number" && typeof bar === "number"
        ? ` (kits Δ=${d.toFixed(2)} > ${bar})`
        : "";
    return `different match${measured}`;
  }
  if (identity.verdict === "consistent") return "this match";
  return "unreadable surface";
}

export type ScoreboardRoiParse =
  | { ok: true; roi: ScoreboardRoi | undefined }
  | { ok: false; message: string };

const BOX_REJECT = "Enter four normalized numbers 0..1 as x0,y0,x1,y1 (e.g. 0,0,0.55,0.18).";

/**
 * Parse the form's typed box. An empty string means "no pin" (`roi: undefined`)
 * and leaves the pipeline on today's auto-detect behaviour. A malformed box is
 * rejected client-side with a readable message rather than sent for a server 422.
 */
export function parseScoreboardRoiInput(raw: string): ScoreboardRoiParse {
  const text = String(raw ?? "").trim();
  if (!text) return { ok: true, roi: undefined };
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  if (parts.length !== 4) return { ok: false, message: BOX_REJECT };
  const vals = parts.map((p) => Number(p));
  if (vals.some((v) => !Number.isFinite(v))) return { ok: false, message: BOX_REJECT };
  const [x0, y0, x1, y1] = vals as ScoreboardRoi;
  if (vals.some((v) => v < 0 || v > 1)) {
    return { ok: false, message: "Score bug box values must be normalized 0..1." };
  }
  if (!(x0 < x1) || !(y0 < y1)) {
    return { ok: false, message: "Score bug box must satisfy x0 < x1 and y0 < y1." };
  }
  return { ok: true, roi: [x0, y0, x1, y1] };
}

/** `0,0,0.55,0.18` for display/edit. */
export function formatScoreboardRoi(roi: readonly number[] | undefined): string {
  if (!roi || roi.length !== 4) return "";
  return roi.map((v) => Number(Number(v).toFixed(4))).join(",");
}

/** Human label for a provenance class (the job page's chip). */
export function scoreboardSourceLabel(source: ScoreboardSurface["source"] | undefined): string {
  switch (source) {
    case "explicit":
      return "pinned";
    case "discovery":
      return "auto-detected";
    case "default_top_band":
      return "default prior";
    default:
      return "not recorded";
  }
}

/**
 * One-line, honest description of the surface block for the job page.
 *
 * `seqFirstSeen < 0` means the pin was declared at job create and no frame has
 * reported the crop yet — stated as "declared", never as an observation.
 */
export function describeScoreboardSurface(surface: ScoreboardSurface | undefined): string {
  if (!surface) return "not recorded";
  const box = formatScoreboardRoi(surface.roi);
  const where =
    surface.seqFirstSeen >= 0 ? `first seen at frame ${surface.seqFirstSeen}` : "declared — no frame yet";
  const read = surface.verified ? "score read" : "score not read yet";
  const identity = describeSurfaceIdentity(surface.identity);
  const tail = identity ? ` · surface: ${identity}` : "";
  return `${box} · ${scoreboardSourceLabel(surface.source)} · ${where} · ${read}${tail}`;
}
