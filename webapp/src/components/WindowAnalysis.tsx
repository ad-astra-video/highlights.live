// ADAAAA-7157 Increment C — the expandable per-window LLM inspection panel.
//
// A decide note on the job-detail frames timeline is an opaque one-liner
// ("Decide @ T+12.4s — GOAL · 88 · accepted"). This panel is what an operator
// opens to see EXACTLY what the decide LLM was handed for that window and what
// it returned:
//   • the verbatim user prompt (monospace),
//   • each structured context item (from `dataItems`),
//   • the frame / image references actually shown,
//   • the audio / ASR context block,
//   • the full LLM response (score / outcome / reason + reasoning, the verdict
//     tri-state, the attested evidence, the audio context), and
//   • — when the candidate went to the Stage-2 deep frame dive — the "Confirm
//     (deep dive)" sub-panel: the confirm request context + its ConfirmDecision
//     (goalConfirmed + confidence + evidence + stage1Disagreed + reconciled
//     outcome).
//
// It is READ-ONLY over data the job-detail API already produces (Incr B); it
// adds no inference, no writes, and never touches downstream highlight
// decisions. Styling uses only the Tailwind theme tokens defined in
// webapp/src/index.css (`@theme`) — no raw color/px outside that layer.
//
// Legacy decide notes that predate the capture carry no `analysis` block; those
// render an explicit "not captured" state rather than a blank panel.
import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ScanSearch, AudioLines, Captions, Boxes, Sparkles } from "lucide-react";
import {
  authFetchFrame,
  dataItemValueText,
  frameUriFor,
  goalConfirmedLabel,
  parseAudioLevelCurve,
  verdictCriterionText,
  verdictText,
  type AnalysisDataItem,
  type AnalysisMediaRef,
  type AudioLevelCurve,
  type AudioSeriesPoint,
  type ConfirmRecord,
  type WindowAnalysis,
  type WindowConfirmation,
} from "../lib/jobDetail";
import {
  audioDp2,
  audioLevelCrossStep,
  audioLevelDomain,
  audioLevelReadout,
  nearestAudioLevelIndex,
} from "../lib/audioLevel";
import { getToken } from "../lib/api";

// Small thumbnail for a lazy media ref. The decide layer may leave `uri` empty
// (bytes not resolved at the decide layer); `frameUriFor` falls back to the
// canonical /jobs/:id/frames/:seq delivery so the thumb still renders. The
// frame bytes need the Authorization header, so we auth-fetch a blob object URL
// (client-only) — SSR renders the placeholder + the reference chip, which is
// the testable contract.
function RefThumb({ mediaRef, jobId, alt }: { mediaRef: AnalysisMediaRef; jobId: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let created: string | null = null;
    authFetchFrame(frameUriFor(mediaRef, jobId), getToken())
      .then((u) => {
        created = u;
        if (alive) setUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [mediaRef, jobId]);

  return (
    <figure className="w-24 shrink-0">
      <div className="flex h-14 w-24 items-center justify-center overflow-hidden rounded-md border border-mut/30 bg-black/40">
        {url ? (
          <img src={url} alt={alt} className="h-full w-full object-cover" />
        ) : (
          <span className="text-[10px] text-mut">…</span>
        )}
      </div>
      <figcaption className="mt-0.5 truncate font-mono text-[10px] text-mut" title={frameUriFor(mediaRef, jobId)}>
        #{mediaRef.seq}
      </figcaption>
    </figure>
  );
}

/** A list of lazy media refs rendered as thumbnails + the canonical uri chip. */
function MediaRefRow({ label, refs, jobId }: { label: string; refs: AnalysisMediaRef[]; jobId: string }) {
  if (refs.length === 0) return null;
  return (
    <div data-refs={label} className="mt-2">
      <div className="mb-1 text-xs font-bold uppercase tracking-wide text-mut">
        {label} <span className="font-mono text-mut/70">({refs.length})</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {refs.map((r, i) => (
          <RefThumb key={`${r.seq}-${i}`} mediaRef={r} jobId={jobId} alt={`${label} ${r.seq}`} />
        ))}
      </div>
    </div>
  );
}

/** One structured context item: type · label · value (monospace value). */
function DataItemRow({ item }: { item: AnalysisDataItem }) {
  return (
    <li className="flex items-baseline gap-2 border-t border-mut/15 py-1 text-xs" data-data-item={item.type}>
      <span className="w-24 shrink-0 truncate font-mono text-mut" title={item.type}>
        {item.type}
      </span>
      <span className="min-w-0 flex-1 truncate text-slate-ink" title={item.label}>
        {item.label}
      </span>
      <span className="shrink-0 font-mono text-neon">{dataItemValueText(item.value)}</span>
    </li>
  );
}

/** One point drawn on the audio-level graph: the stream time (seconds, or the
 *  sample index for a prompt-curve-only window), the level, and — when the
 *  window carries the gate series — the rolling baseline. */
interface LevelPoint {
  t: number;
  value: number;
  baseline?: number;
}

const GRAPH_W = 320;
const GRAPH_H = 96;

/** The drawn series for a window: the bounded gate series when captured (it
 *  carries stream time + baseline), else the sample curve parsed out of the
 *  `audio_level` prompt line. */
function levelPoints(series?: AudioSeriesPoint[], curve?: AudioLevelCurve | null): LevelPoint[] {
  if (series && series.length >= 2) {
    return series
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.energy))
      .map((p) => ({
        t: p.t,
        value: p.energy,
        baseline: Number.isFinite(p.baseline) ? p.baseline : undefined,
      }));
  }
  if (curve) return curve.values.map((v, i) => ({ t: i, value: v }));
  return [];
}

/** ADAAAA-7932: the sound-levels graph for the `audio_level` field.
 *
 *  Y axis is RELATIVE to the window's own levels (min..max of what was drawn,
 *  padded), not a fixed 0..1, so a quiet window's shape is still readable.
 *  Mean and peak levels are drawn as labelled reference lines. Hovering inside
 *  the plot draws a white cross hair (vertical + horizontal) and prints the
 *  actual sample time/index and level at that position. Read-only; theme tokens
 *  only. */
function AudioLevelGraph({
  points,
  mean,
  peak,
  triggerTs,
  timeAxis,
}: {
  points: LevelPoint[];
  mean: number;
  peak: number;
  triggerTs?: number;
  timeAxis: boolean;
}) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  // Keyboard cross position (AC7): moved by Left/Right arrows, cleared on hover.
  const [keyIdx, setKeyIdx] = useState<number | null>(null);
  if (points.length < 2) return null;

  let tMin = Infinity;
  let tMax = -Infinity;
  for (const p of points) {
    tMin = Math.min(tMin, p.t);
    tMax = Math.max(tMax, p.t);
  }
  const tSpan = Math.max(1e-6, tMax - tMin);
  // Window-relative Y axis (AC2): `[min(0, minE), maxE]` over the drawn levels,
  // `[0, max(1e-3, peak)]` when the window is flat. A baseline that sits outside
  // that band clamps to the axis edge — the axis describes the energy.
  const [yLo, yHi] = audioLevelDomain(points.map((p) => p.value));
  const ySpan = Math.max(1e-6, yHi - yLo);

  const X = (t: number) => ((t - tMin) / tSpan) * GRAPH_W;
  const Y = (v: number) => GRAPH_H - ((Math.min(yHi, Math.max(yLo, v)) - yLo) / ySpan) * GRAPH_H;
  const valuePts = points.map((p) => `${X(p.t).toFixed(1)},${Y(p.value).toFixed(1)}`).join(" ");
  const hasBaseline = points.some((p) => p.baseline !== undefined);
  const baselinePts = hasBaseline
    ? points.map((p) => `${X(p.t).toFixed(1)},${Y(p.baseline ?? p.value).toFixed(1)}`).join(" ")
    : "";
  const inWindow = triggerTs !== undefined && triggerTs >= tMin && triggerTs <= tMax;
  const triggerX = inWindow ? X(triggerTs as number) : null;
  // Mean / peak describe the drawn levels, so they sit inside the axis band; Y
  // clamps defensively for a caller-supplied level outside it.
  const meanY = Y(mean);
  const peakY = Y(peak);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const x = Math.min(GRAPH_W, Math.max(0, ((e.clientX - r.left) / r.width) * GRAPH_W));
    const y = Math.min(GRAPH_H, Math.max(0, ((e.clientY - r.top) / r.height) * GRAPH_H));
    setKeyIdx(null);
    setHover({ x, y });
  }

  // Arrow keys step the white cross across the samples while the graph has
  // focus (AC7); `audioLevelCrossStep` owns the enter-at-edge + clamp rules.
  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const dir = e.key === "ArrowLeft" ? -1 : 1;
    setHover(null);
    setKeyIdx(audioLevelCrossStep(keyIdx ?? crossIdx, dir, points.length));
  }

  // Nearest drawn point to the cursor's x (hover) or to the arrow-key position:
  // the value the readout reports and the point the white cross snaps to.
  const xs = points.map((p) => X(p.t));
  const crossIdx = hover ? nearestAudioLevelIndex(xs, hover.x) : keyIdx;
  const nearest = crossIdx !== null ? points[crossIdx] : null;
  const crossX = hover ? hover.x : nearest ? X(nearest.t) : null;
  const readout = nearest
    ? audioLevelReadout({
        index: crossIdx as number,
        count: points.length,
        t: timeAxis ? nearest.t : undefined,
        energy: nearest.value,
        baseline: nearest.baseline,
      })
    : null;

  return (
    <div className="mt-1 rounded-md border border-mut/20 bg-black/30 p-2" data-audio-level-graph data-audio-series-graph>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-mut">
        <span className="font-bold">Sound levels</span>
        <span className="flex items-center gap-1 normal-case">
          <svg width="14" height="6" className="stroke-neon" viewBox="0 0 14 6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" strokeWidth="2" />
          </svg>
          level
        </span>
        {hasBaseline && (
          <span className="flex items-center gap-1 normal-case">
            <svg width="14" height="6" className="stroke-purple" viewBox="0 0 14 6" aria-hidden>
              <line x1="0" y1="3" x2="14" y2="3" strokeWidth="2" />
            </svg>
            baseline
          </span>
        )}
        <span className="flex items-center gap-1 normal-case">
          <svg width="14" height="6" className="stroke-yellow" viewBox="0 0 14 6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" strokeWidth="1" strokeDasharray="3 2" />
          </svg>
          peak
        </span>
        <span className="flex items-center gap-1 normal-case">
          <svg width="14" height="6" className="stroke-pink" viewBox="0 0 14 6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" strokeWidth="1" strokeDasharray="3 2" />
          </svg>
          mean
        </span>
        {readout && (
          <span className="ml-auto font-mono text-[10px] normal-case text-ink" data-audio-level-readout={readout}>
            {readout}
          </span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
        className="h-24 w-full cursor-crosshair"
        preserveAspectRatio="none"
        role="img"
        tabIndex={0}
        aria-label={`Sound levels over the window: ${points.length} points, window-relative axis ${audioDp2(
          yLo
        )} to ${audioDp2(yHi)}, mean ${audioDp2(mean)}, peak ${audioDp2(peak)}${
          readout ? `, readout ${readout}` : ""
        }. Left/Right arrows step the cross line.`}
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null);
          setKeyIdx(null);
        }}
        onKeyDown={onKeyDown}
        data-audio-level-plot
      >
        {/* Window-relative Y axis ticks: top, middle, bottom of the drawn range */}
        {[yHi, yLo + ySpan / 2, yLo].map((v, i) => (
          <text
            key={i}
            x={2}
            y={16 + i * ((GRAPH_H - 18) / 2)}
            className="fill-mut font-mono text-[10px]"
            data-audio-level-axis
          >
            {v.toFixed(2)}
          </text>
        ))}
        {/* Mean + peak reference lines (labelled, dashed) */}
        <line
          x1="0"
          y1={meanY}
          x2={GRAPH_W}
          y2={meanY}
          className="stroke-pink"
          strokeWidth="1"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          data-audio-level-mean
          data-audio-level-mean-value={mean.toFixed(2)}
        >
          <title>{`mean ${mean.toFixed(2)}`}</title>
        </line>
        <line
          x1="0"
          y1={peakY}
          x2={GRAPH_W}
          y2={peakY}
          className="stroke-yellow"
          strokeWidth="1"
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          data-audio-level-peak
          data-audio-level-peak-value={peak.toFixed(2)}
        >
          <title>{`peak ${peak.toFixed(2)}`}</title>
        </line>
        {hasBaseline && (
          <polyline
            points={baselinePts}
            fill="none"
            className="stroke-purple"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
            data-audio-series-baseline
          />
        )}
        <polyline
          points={valuePts}
          fill="none"
          className="stroke-neon"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          data-audio-series-energy
        />
        {triggerX !== null && (
          <line
            x1={triggerX}
            y1="0"
            x2={triggerX}
            y2={GRAPH_H}
            className="stroke-yellow"
            strokeWidth="2"
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
            data-audio-trigger
            data-trigger-ts={triggerTs}
          />
        )}
        {/* Hover/keyboard: white cross line at the nearest sample (vertical) plus
            a horizontal marker, so the actual values are readable. */}
        {crossX !== null && nearest && (
          <g data-audio-level-crosshair data-crosshair-value={nearest.value.toFixed(2)} data-crosshair-index={nearest.t}>
            <line
              x1={crossX}
              y1="0"
              x2={crossX}
              y2={GRAPH_H}
              className="stroke-ink"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              data-audio-level-cross
              data-audio-crosshair-v
            />
            <line
              x1="0"
              y1={hover ? hover.y : Y(nearest.value)}
              x2={GRAPH_W}
              y2={hover ? hover.y : Y(nearest.value)}
              className="stroke-ink"
              strokeWidth="1"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
              data-audio-crosshair-h
            />
            <circle cx={X(nearest.t)} cy={Y(nearest.value)} r="2.5" className="fill-ink" />
          </g>
        )}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-mut">
        <span data-audio-x-start>{timeAxis ? `${tMin.toFixed(1)}s` : `#0`}</span>
        <span className="text-mut/80" data-audio-level-keyline>
          peak <span className="text-yellow">{peak.toFixed(2)}</span> · mean{" "}
          <span className="text-pink">{mean.toFixed(2)}</span>
        </span>
        {inWindow && triggerX !== null && (
          <span className="text-yellow" data-audio-trigger-label>
            trigger @ T+{triggerTs?.toFixed(1)}s
          </span>
        )}
        <span data-audio-x-end>{timeAxis ? `${tMax.toFixed(1)}s` : `#${Math.round(tMax)}`}</span>
      </div>
    </div>
  );
}

/** ADAAAA-7932: the `audio_level` context item, rendered as a graph by default
 *  with the raw text the model was sent behind a Graph / Raw toggle. Falls back
 *  to the plain text row when the value holds no usable series. */
export function AudioLevelField({
  item,
  series,
  triggerTs,
  defaultView = "graph",
}: {
  item: AnalysisDataItem;
  series?: AudioSeriesPoint[];
  triggerTs?: number;
  defaultView?: "graph" | "raw";
}) {
  const [view, setView] = useState<"graph" | "raw">(defaultView);
  const curve = parseAudioLevelCurve(item.value);
  const points = levelPoints(series, curve);
  const raw = dataItemValueText(item.value);
  if (points.length < 2) return <DataItemRow item={item} />;
  const timeAxis = !!series && series.length >= 2;
  const values = points.map((p) => p.value);
  // AC3: the reference lines describe the DRAWN series, not the prompt-declared
  // stats. The raw line's `peak=`/`mean=` are computed over the whole
  // pre-downsample evidence, so using them draws the peak line one 2-dp step
  // below the axis peak the graph actually plots (ADAAAA-7951 QA note).
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...values);

  return (
    <li className="border-t border-mut/15 py-1" data-data-item={item.type} data-audio-level-field data-audio-level-view={view}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="w-24 shrink-0 truncate font-mono text-mut" title={item.type}>
          {item.type}
        </span>
        <span className="min-w-0 flex-1 truncate text-slate-ink" title={item.label}>
          {item.label}
        </span>
        <span className="shrink-0 flex items-center gap-1" role="group" aria-label="audio level view">
          <button
            type="button"
            onClick={() => setView("graph")}
            aria-pressed={view === "graph"}
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              view === "graph" ? "border-neon/50 bg-neon/10 text-neon" : "border-mut/30 text-mut"
            }`}
            data-audio-level-toggle="graph"
          >
            Graph
          </button>
          <button
            type="button"
            onClick={() => setView("raw")}
            aria-pressed={view === "raw"}
            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
              view === "raw" ? "border-neon/50 bg-neon/10 text-neon" : "border-mut/30 text-mut"
            }`}
            data-audio-level-toggle="raw"
          >
            Raw
          </button>
        </span>
      </div>
      {view === "raw" ? (
        <pre
          className="mt-1 overflow-x-auto whitespace-pre-wrap rounded border border-mut/20 bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-ink"
          data-audio-level-raw
        >
          {raw}
        </pre>
      ) : (
        <AudioLevelGraph points={points} mean={mean} peak={peak} triggerTs={triggerTs} timeAxis={timeAxis} />
      )}
    </li>
  );
}

/** The structured `dataItems` list. The `audio_level` item is the sound-levels
 *  visual (ADAAAA-7932); every other item stays a one-line text row. */
function DataItemList({
  items,
  series,
  triggerTs,
}: {
  items: AnalysisDataItem[];
  series?: AudioSeriesPoint[];
  triggerTs?: number;
}) {
  if (items.length === 0) {
    return <div className="text-xs text-mut">No structured context items captured.</div>;
  }
  return (
    <ul className="mt-1" data-analysis-dataitems>
      {items.map((it, i) =>
        it.type === "audio_level" ? (
          <AudioLevelField key={i} item={it} series={series} triggerTs={triggerTs} />
        ) : (
          <DataItemRow key={i} item={it} />
        )
      )}
    </ul>
  );
}

/** A small labelled key/value chip row. */
function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-wide text-mut">{label}</span>
      <span className={mono ? "font-mono text-sm text-ink" : "text-sm text-slate-ink"}>{children}</span>
    </div>
  );
}

/** The four goal criteria the decide layer asks the model to verify (I1). */
const VERDICT_CRITERIA: { key: string; label: string }[] = [
  { key: "ballCrossedLineBetweenPosts", label: "ball crossed line between posts" },
  { key: "ballInNet", label: "ball in net" },
  { key: "scoreboardChanged", label: "scoreboard changed" },
  { key: "crowdErupted", label: "crowd erupted" },
];

/** True when a wire verdict is the I1 rationale OBJECT (not a legacy scalar). */
function isRationaleVerdict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * ADAAAA-8187: the I1 `Verdict` rationale is an OBJECT on the wire
 * (`{hypothesis, independentlyObserved, criteria, contradictedBy}` — decide
 * `services/decide/app/__init__.py`), even though the contract keeps `verdict`
 * opaque on purpose. Flattening it with `String()` printed "[object Object]"
 * and lost the whole rationale, so render one row per field instead: absent
 * fields read "—", and each criterion reads seen / not seen / unverifiable
 * (wire `null` is "unverifiable" per the `VerdictCriteria` docstring).
 */
function VerdictDetail({ verdict }: { verdict: Record<string, unknown> }) {
  if (Object.keys(verdict).length === 0) {
    return (
      <div className="mt-1 rounded-md border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut" data-response-verdict-detail>
        —
      </div>
    );
  }
  const criteria = verdict.criteria;
  const criteriaObject =
    typeof criteria === "object" && criteria !== null && !Array.isArray(criteria)
      ? (criteria as Record<string, unknown>)
      : null;
  const criteriaText = criteriaObject
    ? VERDICT_CRITERIA.map(
        ({ key, label }) => `${label}: ${verdictCriterionText(criteriaObject[key])}`
      ).join(" · ")
    : verdictText(criteria);
  return (
    <div
      className="mt-1 grid gap-x-4 gap-y-2 rounded-md border border-mut/30 bg-mut/10 p-2 sm:grid-cols-2"
      data-response-verdict-detail
    >
      <Field label="Hypothesis">{verdictText(verdict.hypothesis)}</Field>
      <Field label="Independently observed">{verdictText(verdict.independentlyObserved)}</Field>
      <Field label="Criteria">{criteriaText}</Field>
      <Field label="Contradicted by">{verdictText(verdict.contradictedBy)}</Field>
    </div>
  );
}

/** The full decide LLM response (score / outcome / reason + reasoning, verdict,
 *  attested evidence, audio context). Rendered read-only; unknown fields
 *  degrade to a safe formatted dump, never a crash. */
function ResponseBlock({ a }: { a: WindowAnalysis }) {
  const r = a.response;
  if (!r) {
    return <div className="mt-2 text-xs text-mut" data-response="none">No response captured for this window.</div>;
  }
  // ADAAAA-8187: `verdict` may be the I1 rationale OBJECT. Keep the chip a short
  // marker and render the rationale rows below it; a legacy scalar keeps its
  // exact wording ("verdict: confirmed_goal", "verdict: —").
  const verdictObject = isRationaleVerdict(r.verdict) ? r.verdict : null;
  const verdictLabel = verdictObject ? "rationale" : verdictText(r.verdict);
  const audioCtx = r.audioContext !== undefined && r.audioContext !== null ? JSON.stringify(r.audioContext) : null;
  return (
    <div className="mt-2 rounded-md border border-neon/30 bg-neon/5 p-3" data-response>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {r.score !== undefined && (
          <span className="text-lg font-black text-neon" data-response-score>
            {Math.round(r.score)}
          </span>
        )}
        {r.outcome && (
          <span className="rounded-full border border-neon/40 px-2 py-0.5 text-xs font-bold uppercase text-neon">
            {r.outcome}
          </span>
        )}
        {r.isHighlight !== undefined && (
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${r.isHighlight ? "border-green/40 bg-green/10 text-green" : "border-mut/30 bg-mut/10 text-mut"}`}>
            {r.isHighlight ? "highlight" : "not a highlight"}
          </span>
        )}
        <span className="rounded-full border border-purple/40 px-2 py-0.5 text-xs font-bold text-purple" data-response-verdict>
          {`verdict: ${verdictLabel}`}
        </span>
        {r.eventType && <span className="text-xs text-mut">{r.eventType}</span>}
        {r.source && <span className="ml-auto font-mono text-[10px] text-mut">source: {r.source}</span>}
      </div>
      {verdictObject && <VerdictDetail verdict={verdictObject} />}
      {r.reason && <div className="mb-1 text-sm text-slate-ink" data-response-reason>{r.reason}</div>}
      {r.reasoning && (
        <div className="mb-1" data-response-reasoning>
          <span className="text-[10px] uppercase tracking-wide text-mut">Reasoning</span>
          <pre className="mt-0.5 whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink">{r.reasoning}</pre>
        </div>
      )}
      {Array.isArray(r.evidenceAttested) && r.evidenceAttested.length > 0 && (
        <div className="mt-1" data-response-evidence>
          <span className="text-[10px] uppercase tracking-wide text-mut">Evidence attested</span>
          <ul className="mt-0.5 flex flex-wrap gap-1">
            {r.evidenceAttested.map((e, i) => (
              <li key={i} className="rounded-full border border-mut/30 bg-mut/10 px-2 py-0.5 font-mono text-[11px] text-slate-ink">
                {verdictText(e)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {audioCtx && (
        <div className="mt-1" data-response-audio-context>
          <span className="text-[10px] uppercase tracking-wide text-mut">Audio context</span>
          <pre className="mt-0.5 overflow-x-auto whitespace-pre font-mono text-[11px] text-mut">{audioCtx}</pre>
        </div>
      )}
    </div>
  );
}

/** The audio / ASR context block (which channel reached the model + the ASR
 *  transcript). Rendered only when audio/asr context was captured.
 *
 *  ADAAAA-7277: two behaviours:
 *  • when the window carries a servable audio URI (`audio.uri`), render a real
 *    playable `<audio controls>` element so the operator can hear the window.
 *  • when the window's audio channel is `none` (a genuinely silent source),
 *    render the explicit "No audio captured" badge (matching the highlight-card
 *    wording from ADAAAA-7248) instead of a blank box.
 *  The ASR transcript text is always rendered when present. */
function AudioAsrBlock({ a }: { a: WindowAnalysis }) {
  const audio = a.audio;
  const asr = a.asr;
  const hasAudio = !!audio;
  const hasAsr = !!asr;
  if (!hasAudio && !hasAsr) return null;
  // A window whose audio channel reached the model as `none` had no audio
  // captured (silent source) → explicit badge, never a silent empty box.
  const isSilent = audio?.path === "none";
  const hasPlayable = !!(audio && audio.uri);
  return (
    <div className="mt-2 rounded-md border border-purple/30 bg-purple/5 p-3" data-audio-asr>
      <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-purple">
        {hasAudio ? <AudioLines className="h-3.5 w-3.5" /> : <Captions className="h-3.5 w-3.5" />}
        Audio / ASR context
      </div>
      {hasAudio && audio && (
        <>
          {isSilent ? (
            <div
              className="inline-flex items-center gap-1 rounded-full border border-mut/40 bg-mut/10 px-2 py-0.5 text-xs font-bold text-mut"
              data-window-no-audio
            >
              No audio captured
            </div>
          ) : (
            <>
              {hasPlayable && (
                <audio
                  controls
                  preload="metadata"
                  src={audio.uri}
                  className="mt-1 h-9 w-full"
                  data-window-audio-player
                >
                  Your browser does not support audio playback.
                </audio>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-ink">
                {audio.path && <span>channel: <span className="font-mono text-neon">{audio.path}</span></span>}
                {audio.sampleRate && <span>rate: <span className="font-mono text-neon">{audio.sampleRate} Hz</span></span>}
                {audio.uri && (
                  <span className="truncate font-mono text-mut" title={audio.uri}>
                    {audio.uri}
                  </span>
                )}
              </div>
            </>
          )}
        </>
      )}
      {hasAsr && asr && (
        <div className="mt-1">
          {asr.transcript ? (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink" data-asr-transcript>
              {asr.transcript}
            </pre>
          ) : (
            <span className="text-xs text-mut">No transcript.</span>
          )}
          {asr.latencyS !== undefined && (
            <span className="ml-1 font-mono text-[10px] text-mut">({asr.latencyS.toFixed(2)}s ASR)</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ADAAAA-8287: the window's confirmation lane, at the top of the inspector.
 *
 * Two lanes confirm a VOD highlight and only the Stage-2 dive leaves a confirm
 * panel, so the inspector is where the raw attestation behind a lane-1 accept
 * becomes readable: the four stored goal criteria (the decide verdict's own
 * `criteria` block, or the dive's evidence when that is where the flags live)
 * plus the dive verdict for the SAME row. Read-only over the stored capture —
 * a lane-1 row shows "no deep dive ran (measured attestation)", which is the
 * designed behaviour (`shouldRunConfirm()` skips the dive for an attested goal),
 * not a missing record.
 */
function attestationFlagText(v: boolean | null | undefined): "seen" | "not seen" | "unverifiable" | "—" {
  if (v === true) return "seen";
  if (v === false) return "not seen";
  if (v === null) return "unverifiable";
  return "—";
}

const ATTESTATION_FLAGS: { key: keyof NonNullable<WindowConfirmation["flags"]>; label: string }[] = [
  { key: "ballCrossedLineBetweenPosts", label: "ball crossed line between posts" },
  { key: "ballInNet", label: "ball in net" },
  { key: "scoreboardChanged", label: "scoreboard changed" },
  { key: "crowdErupted", label: "crowd erupted" },
];

function ConfirmationBlock({ confirmation }: { confirmation: WindowConfirmation }) {
  const flags = confirmation.flags;
  const dive = confirmation.dive;
  return (
    <div className="mb-2 rounded-md border border-mut/30 bg-mut/10 p-2 text-xs" data-confirmation-block={confirmation.lane}>
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-wide text-mut">Confirmation lane</span>
        <span className="font-bold text-slate-ink" data-confirmation-label>
          {confirmation.label}
        </span>
      </div>
      {flags ? (
        <div className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2" data-confirm-attestation data-flags-source={confirmation.flagsSource ?? "none"}>
          {ATTESTATION_FLAGS.map(({ key, label }) => {
            const value = flags[key];
            return (
              <div key={key} className="flex items-baseline gap-1" data-attestation-flag={key} data-attestation-value={attestationFlagText(value)}>
                <span className="text-mut">{label}</span>
                <span
                  className={`font-mono text-[10px] uppercase ${
                    value === true ? "text-green" : value === false ? "text-yellow" : "text-mut"
                  }`}
                >
                  {attestationFlagText(value)}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-1 text-mut" data-confirm-attestation="absent">
          No stored attestation flags for this window.
        </div>
      )}
      <div className="mt-1 flex items-baseline gap-1" data-dive-verdict={dive ? (dive.corroborated ? "corroborated" : "not-corroborated") : "none"}>
        <span className="text-mut">deep dive</span>
        {dive ? (
          <span className="min-w-0 flex-1 text-slate-ink">
            {goalConfirmedLabel(dive.goalConfirmed)}
            {dive.confidence !== null ? ` · confidence ${Math.round(dive.confidence * 100)}%` : ""}
            {dive.stage1Disagreed !== null ? ` · stage-1 disagreed: ${dive.stage1Disagreed ? "yes" : "no"}` : ""}
            {dive.outcome ? ` · outcome ${dive.outcome}` : ""}
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-mut">no deep dive ran (measured attestation)</span>
        )}
      </div>
    </div>
  );
}

/** The Stage-2 confirm (deep frame dive) sub-panel: the confirm request context
 *  + its ConfirmDecision. Rendered only when the candidate went to deeper
 *  processing (a `confirm` record exists). */
export function ConfirmSubPanel({ confirm, jobId, defaultOpen = false }: { confirm: ConfirmRecord; jobId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const req = confirm.request;
  const d = confirm.decision;
  const confidence = d.confidence !== undefined ? `${Math.round(d.confidence * 100)}%` : "—";
  return (
    <div className="mt-2 rounded-md border border-pink/40 bg-pink/5" data-confirm-panel>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-bold uppercase tracking-wide text-pink"
        data-confirm-toggle
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Confirm (deep dive)
        <span className="ml-auto rounded-full border border-pink/40 px-2 py-0.5 font-mono text-[10px] normal-case">
          {goalConfirmedLabel(d.goalConfirmed)}
        </span>
      </button>
      {open && (
        <div className="border-t border-pink/20 px-3 py-2" data-confirm-body>
          {/* Confirm request context */}
          <div className="text-[10px] uppercase tracking-wide text-mut">Confirm request context</div>
          {req.prompt && (
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-mut/20 bg-black/30 p-2 font-mono text-[11px] leading-relaxed text-slate-ink" data-confirm-prompt>
              {req.prompt}
            </pre>
          )}
          <div className="mt-2">
            <DataItemList items={req.dataItems} />
          </div>
          <MediaRefRow label="Frames" refs={req.frames} jobId={jobId} />
          <MediaRefRow label="Keyframes" refs={req.keyframes} jobId={jobId} />
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
            <Field label="Trajectories" mono>{req.trajectories.length}</Field>
            <Field label="Optical flow mag.">{req.opticalFlowMagnitude ?? "—"}</Field>
            <Field label="Audio levels">{req.audioLevels.length}</Field>
          </div>
          {req.transcript && (
            <div className="mt-2">
              <span className="text-[10px] uppercase tracking-wide text-mut">Transcript</span>
              <pre className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-slate-ink">{req.transcript}</pre>
            </div>
          )}

          {/* ConfirmDecision */}
          <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-wide text-mut">
            <Sparkles className="h-3 w-3 text-pink" />
            Confirm decision
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4" data-confirm-decision>
            <Field label="Goal confirmed">
              <span
                className={
                  d.goalConfirmed === "confirmed_goal"
                    ? "font-bold text-green"
                    : d.goalConfirmed === "not_goal"
                    ? "font-bold text-red"
                    : "font-bold text-yellow"
                }
              >
                {goalConfirmedLabel(d.goalConfirmed)}
              </span>
            </Field>
            <Field label="Confidence" mono>{confidence}</Field>
            <Field label="Stage-1 disagreed">
              <span className={d.stage1Disagreed ? "font-bold text-yellow" : "text-mut"}>{d.stage1Disagreed ? "yes" : "no"}</span>
            </Field>
            <Field label="Reconciled outcome">{d.outcome ?? "—"}</Field>
          </div>
          {d.reason && <div className="mt-1 text-sm text-slate-ink" data-confirm-reason>{d.reason}</div>}
          {d.evidence !== undefined && d.evidence !== null && (
            <div className="mt-1">
              <span className="text-[10px] uppercase tracking-wide text-mut">Evidence</span>
              <pre className="mt-0.5 overflow-x-auto whitespace-pre font-mono text-[11px] text-mut">{JSON.stringify(d.evidence)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** ADAAAA-7255 / ADAAAA-7932: the window's gate series when the panel has no
 *  `audio_level` context item to host it (older captures). Rendered just under
 *  the context items — the graph now lives at the `audio_level` field, so this
 *  only keeps a series-bearing window from losing its plot. */
function AudioSeriesBlock({ series, triggerTs }: { series: AudioSeriesPoint[]; triggerTs?: number }) {
  const points = levelPoints(series, null);
  if (points.length < 2) return null;
  const values = points.map((p) => p.value);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const peak = Math.max(...values);
  return (
    <div data-audio-level-fallback>
      <AudioLevelGraph points={points} mean={mean} peak={peak} triggerTs={triggerTs} timeAxis />
    </div>
  );
}

/**
 * ADAAAA-8338: the per-window verbatim prompt, collapsed by default.
 *
 * The context items and the response are what an operator actually reads, so
 * the prompt starts as one compact toggle row and expands on demand. Mirrors
 * `ConfirmSubPanel`'s toggle shape (same chevrons, same `aria-expanded`
 * contract); the body id comes from `useId()` so two panels on one page never
 * collide and SSR stays deterministic. Presentation-only — the prompt string is
 * the same capture, just not in the DOM until opened.
 */
export function PromptBlock({ prompt, defaultOpen = false }: { prompt: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = useId();
  return (
    <div data-prompt>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 text-left text-[10px] uppercase tracking-wide text-mut"
        data-prompt-toggle
        aria-expanded={open}
        aria-controls={bodyId}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Prompt (verbatim)
      </button>
      {open && (
        <div id={bodyId} data-prompt-body>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-mut/20 bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-ink">
            {prompt}
          </pre>
        </div>
      )}
    </div>
  );
}

export interface WindowAnalysisPanelProps {
  /** The per-window analysis payload (absent on legacy decide notes). */
  analysis?: WindowAnalysis;
  /** The Stage-2 confirm (deep dive) record, when the candidate was deeper-processed. */
  confirm?: ConfirmRecord;
  /** ADAAAA-8287: the derived acceptance lane for this row (lane + label, plus
   * the inspector half — the stored attestation flags and the dive verdict). */
  confirmation?: WindowConfirmation;
  /** Job id, used to resolve lazy frame/image refs to their delivery URI. */
  jobId: string;
  /** ADAAAA-7255: the candidate trigger onset timestamp (seconds) to mark on
   * the audio energy-vs-baseline graph, when one fired. */
  triggerTs?: number;
  /** ADAAAA-8338: start the verbatim prompt expanded. Default false — the
   * prompt is one collapsed toggle row until the operator opens it. */
  promptDefaultOpen?: boolean;
}

/**
 * The per-window LLM inspection panel. Read-only over the job-detail API data.
 * Renders an explicit "not captured" state when `analysis` is absent (legacy)
 * rather than a blank.
 */
export function WindowAnalysisPanel({
  analysis,
  confirm,
  confirmation,
  jobId,
  triggerTs,
  promptDefaultOpen = false,
}: WindowAnalysisPanelProps) {
  if (!analysis) {
    return (
      <div
        className="mt-1 rounded-md border border-mut/25 bg-mut/5 px-3 py-2 text-xs text-mut"
        data-window-analysis="not-captured"
      >
        {/* ADAAAA-8287: the lane + its stored flags are derived from the ROW,
            not from the capture, so a legacy window still states its lane here
            even though its prompt/response was never captured. */}
        {confirmation && <ConfirmationBlock confirmation={confirmation} />}
        Analysis not captured for this window — this decide note predates per-window capture (legacy).
      </div>
    );
  }
  return (
    <div className="mt-1 rounded-md border border-neon/30 bg-black/30 p-3" data-window-analysis>
      {/* ADAAAA-8287: which lane confirmed the row, with the raw attestation. */}
      {confirmation && <ConfirmationBlock confirmation={confirmation} />}
      {/* Prompt (verbatim, monospace) — collapsed by default (ADAAAA-8338) */}
      <PromptBlock prompt={analysis.prompt} defaultOpen={promptDefaultOpen} />

      {/* Structured context items */}
      <div className="mt-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-mut">
          <Boxes className="h-3.5 w-3.5" />
          Context items <span className="font-mono text-mut/70">({analysis.dataItems.length})</span>
        </div>
        <DataItemList items={analysis.dataItems} series={analysis.audioSeries} triggerTs={triggerTs} />
        {!analysis.dataItems.some((it) => it.type === "audio_level") && analysis.audioSeries && (
          <AudioSeriesBlock series={analysis.audioSeries} triggerTs={triggerTs} />
        )}
      </div>

      {/* Frame / image references */}
      <MediaRefRow label="Frames" refs={analysis.frames} jobId={jobId} />
      <MediaRefRow label="Images" refs={analysis.images} jobId={jobId} />

      {/* Audio / ASR block */}
      <AudioAsrBlock a={analysis} />

      {/* Full LLM response */}
      <div>
        <div className="mt-2 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-mut">
          <ScanSearch className="h-3.5 w-3.5" />
          LLM response
        </div>
        <ResponseBlock a={analysis} />
      </div>

      {/* Stage-2 confirm (deep dive) sub-panel */}
      {confirm && <ConfirmSubPanel confirm={confirm} jobId={jobId} />}
    </div>
  );
}
