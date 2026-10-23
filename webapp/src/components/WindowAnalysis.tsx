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
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ScanSearch, AudioLines, Captions, Boxes, Sparkles } from "lucide-react";
import {
  authFetchFrame,
  dataItemValueText,
  frameUriFor,
  goalConfirmedLabel,
  type AnalysisDataItem,
  type AnalysisMediaRef,
  type AudioSeriesPoint,
  type ConfirmRecord,
  type WindowAnalysis,
} from "../lib/jobDetail";
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

/** The structured `dataItems` list. */
function DataItemList({ items }: { items: AnalysisDataItem[] }) {
  if (items.length === 0) {
    return <div className="text-xs text-mut">No structured context items captured.</div>;
  }
  return (
    <ul className="mt-1" data-analysis-dataitems>
      {items.map((it, i) => (
        <DataItemRow key={i} item={it} />
      ))}
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

/** The full decide LLM response (score / outcome / reason + reasoning, verdict,
 *  attested evidence, audio context). Rendered read-only; unknown fields
 *  degrade to a safe JSON dump, never a crash. */
function ResponseBlock({ a }: { a: WindowAnalysis }) {
  const r = a.response;
  if (!r) {
    return <div className="mt-2 text-xs text-mut" data-response="none">No response captured for this window.</div>;
  }
  const verdict = r.verdict !== undefined && r.verdict !== null ? String(r.verdict) : "—";
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
          verdict: {verdict}
        </span>
        {r.eventType && <span className="text-xs text-mut">{r.eventType}</span>}
        {r.source && <span className="ml-auto font-mono text-[10px] text-mut">source: {r.source}</span>}
      </div>
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
                {e}
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
 *  transcript). Rendered only when audio/asr context was captured. */
function AudioAsrBlock({ a }: { a: WindowAnalysis }) {
  const hasAudio = !!a.audio;
  const hasAsr = !!a.asr;
  if (!hasAudio && !hasAsr) return null;
  return (
    <div className="mt-2 rounded-md border border-purple/30 bg-purple/5 p-3" data-audio-asr>
      <div className="mb-1 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-purple">
        {hasAudio ? <AudioLines className="h-3.5 w-3.5" /> : <Captions className="h-3.5 w-3.5" />}
        Audio / ASR context
      </div>
      {hasAudio && a.audio && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-ink">
          {a.audio.path && <span>channel: <span className="font-mono text-neon">{a.audio.path}</span></span>}
          {a.audio.sampleRate && <span>rate: <span className="font-mono text-neon">{a.audio.sampleRate} Hz</span></span>}
          {a.audio.uri && (
            <span className="truncate font-mono text-mut" title={a.audio.uri}>
              {a.audio.uri}
            </span>
          )}
        </div>
      )}
      {hasAsr && a.asr && (
        <div className="mt-1">
          {a.asr.transcript ? (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink" data-asr-transcript>
              {a.asr.transcript}
            </pre>
          ) : (
            <span className="text-xs text-mut">No transcript.</span>
          )}
          {a.asr.latencyS !== undefined && (
            <span className="ml-1 font-mono text-[10px] text-mut">({a.asr.latencyS.toFixed(2)}s ASR)</span>
          )}
        </div>
      )}
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

/** ADAAAA-7255: the energy-vs-baseline graph for a per-window analysis.
 * Time-aligned over the window's ``t`` (seconds), with the gate's per-chunk
 * ``energy`` (0..1) and rolling ambient ``baseline`` (0..1) overlaid as two
 * lines, and the candidate trigger onset marked with a vertical line where one
 * fired. Read-only; uses only theme tokens. Renders nothing when no points. */
function AudioEnergyGraph({ points, triggerTs }: { points: AudioSeriesPoint[]; triggerTs?: number }) {
  if (points.length === 0) return null;
  const W = 320;
  const H = 90;
  let xMin = Infinity;
  let xMax = -Infinity;
  for (const p of points) {
    xMin = Math.min(xMin, p.t);
    xMax = Math.max(xMax, p.t);
  }
  const xSpan = Math.max(1e-6, xMax - xMin);
  const X = (t: number) => ((t - xMin) / xSpan) * W;
  const Y = (v: number) => H - Math.max(0, Math.min(1, v)) * H;
  const energyPts = points.map((p) => `${X(p.t).toFixed(1)},${Y(p.energy).toFixed(1)}`).join(" ");
  const baselinePts = points.map((p) => `${X(p.t).toFixed(1)},${Y(p.baseline).toFixed(1)}`).join(" ");
  const inWindow = triggerTs !== undefined && triggerTs >= xMin && triggerTs <= xMax;
  const triggerX = inWindow ? X(triggerTs as number) : null;
  return (
    <div className="mt-2 rounded-md border border-mut/20 bg-black/30 p-3" data-audio-series-graph>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] uppercase tracking-wide text-mut">
        <span className="font-bold">Audio energy vs baseline</span>
        <span className="flex items-center gap-1 normal-case">
          <svg width="14" height="6" className="stroke-neon" viewBox="0 0 14 6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" strokeWidth="2" />
          </svg>
          energy
        </span>
        <span className="flex items-center gap-1 normal-case">
          <svg width="14" height="6" className="stroke-purple" viewBox="0 0 14 6" aria-hidden>
            <line x1="0" y1="3" x2="14" y2="3" strokeWidth="2" />
          </svg>
          baseline
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-24 w-full"
        preserveAspectRatio="none"
        role="img"
        aria-label="Audio energy vs baseline over the window"
      >
        {/* 0 / 1 reference lines */}
        <line x1="0" y1={H} x2={W} y2={H} className="stroke-mut/40" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <line x1="0" y1="0" x2={W} y2="0" className="stroke-mut/40" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <polyline
          points={baselinePts}
          fill="none"
          className="stroke-purple"
          strokeWidth="1.5"
          vectorEffect="non-scaling-stroke"
          data-audio-series-baseline
        />
        <polyline
          points={energyPts}
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
            y2={H}
            className="stroke-yellow"
            strokeWidth="2"
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
            data-audio-trigger
            data-trigger-ts={triggerTs}
          />
        )}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-mut">
        <span data-audio-x-start>{xMin.toFixed(1)}s</span>
        {inWindow && triggerX !== null && (
          <span className="text-yellow" data-audio-trigger-label>
            trigger @ T+{triggerTs?.toFixed(1)}s
          </span>
        )}
        <span data-audio-x-end>{xMax.toFixed(1)}s</span>
      </div>
    </div>
  );
}

export interface WindowAnalysisPanelProps {
  /** The per-window analysis payload (absent on legacy decide notes). */
  analysis?: WindowAnalysis;
  /** The Stage-2 confirm (deep dive) record, when the candidate was deeper-processed. */
  confirm?: ConfirmRecord;
  /** Job id, used to resolve lazy frame/image refs to their delivery URI. */
  jobId: string;
  /** ADAAAA-7255: the candidate trigger onset timestamp (seconds) to mark on
   * the audio energy-vs-baseline graph, when one fired. */
  triggerTs?: number;
}

/**
 * The per-window LLM inspection panel. Read-only over the job-detail API data.
 * Renders an explicit "not captured" state when `analysis` is absent (legacy)
 * rather than a blank.
 */
export function WindowAnalysisPanel({ analysis, confirm, jobId, triggerTs }: WindowAnalysisPanelProps) {
  if (!analysis) {
    return (
      <div
        className="mt-1 rounded-md border border-mut/25 bg-mut/5 px-3 py-2 text-xs text-mut"
        data-window-analysis="not-captured"
      >
        Analysis not captured for this window — this decide note predates per-window capture (legacy).
      </div>
    );
  }
  return (
    <div className="mt-1 rounded-md border border-neon/30 bg-black/30 p-3" data-window-analysis>
      {/* Prompt (verbatim, monospace) */}
      <div data-prompt>
        <span className="text-[10px] uppercase tracking-wide text-mut">Prompt (verbatim)</span>
        <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-mut/20 bg-black/40 p-2 font-mono text-[11px] leading-relaxed text-ink">
          {analysis.prompt}
        </pre>
      </div>

      {/* Structured context items */}
      <div className="mt-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-mut">
          <Boxes className="h-3.5 w-3.5" />
          Context items <span className="font-mono text-mut/70">({analysis.dataItems.length})</span>
        </div>
        <DataItemList items={analysis.dataItems} />
      </div>

      {/* Frame / image references */}
      <MediaRefRow label="Frames" refs={analysis.frames} jobId={jobId} />
      <MediaRefRow label="Images" refs={analysis.images} jobId={jobId} />

      {/* Audio / ASR block */}
      <AudioAsrBlock a={analysis} />

      {/* ADAAAA-7255: audio energy-vs-baseline graph (time-aligned to the window,
          trigger onset marked when one fired) */}
      {analysis.audioSeries && analysis.audioSeries.length > 0 && (
        <AudioEnergyGraph points={analysis.audioSeries} triggerTs={triggerTs} />
      )}

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
