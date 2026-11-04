import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Play, Check, X, Undo2, Loader2, ChevronDown, ChevronRight, VolumeX, Search, Download, Link2 } from "lucide-react";
import { api, getToken } from "../lib/api";
import { readSSE } from "../lib/sse";
import { VideoClip } from "../components/VideoClip";
import { JobDetailMetrics } from "../components/JobMetrics";
import { useIsAdmin } from "../lib/auth";
import { WindowAnalysisPanel } from "../components/WindowAnalysis";
import { CostTimePanel, CostTimeToggle } from "../components/CostTimePanel";
import { SummaryLadderView } from "../components/SummaryLadder";
import { batchManifest, captionFromTitle, clipFileName, copyExportLink, copyText, exportUrl, markExportIntent, markExportIntentBatch, momentRangeLabel, postTitles, saveBlob, suggestCaption, type BatchItem } from "../lib/highlightPost";
import { buildZip, type ZipFile } from "../lib/zip";
import { groundSummaryItems } from "@highlights/events";
import { asrSummary, asrSummaryLine } from "../lib/windowAsr";
import {
  fetchJobDetail,
  fetchJobHighlights,
  applyReviewToRawRows,
  rejectedStripRows,
  fetchSectionInspect,
  fetchSectionsDelta,
  mergeSections,
  SECTION_WINDOW_S,
  focusAnalysisWindow,
  isJobInFlight,
  assertFramePartition,
  mergedGroupsByWindow,
  mergedMomentGroups,
  triggerLabel,
  authFetchFrame,
  sectionKinds,
  sectionSummaryText,
  sectionMatches,
  noteKindLabel,
  NOTE_KINDS,
  type JobDetail,
  type JobDetailHighlight,
  type FrameSection,
  type SectionInspect,
  type SectionsDelta,
  type JobDetailFrame,
  type DecideNote,
  type NoteKind,
  type SummaryLogEntry,
  type LiveProgress,
  type LiveCapture,
  summaryEntryTimestamp,
  type MergedMomentGroup,
} from "../lib/jobDetail";
import { createWindowInspectStore } from "../lib/windowInspect";
import { LiveProgressChip } from "../components/LiveProgressChip";
import { ResumeAction, ResumeTrail, type ResumeActionState } from "../components/ResumeTrail";
import { CaptureNotice } from "../components/CaptureNotice";
import {
  LIVE_READ_HEALTH_FRESH,
  liveProgressFailureNotice,
  nextLiveReadHealth,
  type LiveReadHealth,
} from "../lib/liveProgress";
import {
  drawFrameWithBoxes,
  drawFrameFullBleed,
  coverTransform,
  orderGallerySeqs,
  collectFrameSeqs,
  type CoverTransform,
} from "../lib/frameDebugger";
import {
  decideAuditCountLabel,
  decideAuditElapsedLabel,
  decideAuditInVideoLabel,
  decideAuditMediaRefs,
  decideAuditVerdictChips,
  decideAuditWallClock,
  type DecideAuditChipTone,
  type DecideAuditRecord,
} from "../lib/decideAudit";
import { jobTitle } from "../lib/vodJobs";
import { failureReasonLabel } from "../lib/failureReason";
import { customerWindowRange, customerWindowStatus, customerWindowStatusKey } from "../lib/customerDetail";
import { startDetailPoll } from "../lib/detailPoll";
import { frameFetchWindow } from "../lib/frameFetchWindow";

// Inline thumbnail stays small (original 160x90) so the filmstrip doesn't
// crowd the page; box strokes are drawn at 2x backing for crispness. Labels
// are shown ONLY on the enlarged frame (board feedback on ADAAAA-6946).
const FRAME_W = 160;
const FRAME_H = 90;
const INLINE_FONT = 12; // CSS px in the enlarged view; inline draws boxes only
const INLINE_SCALE = 2;
/** SSE events that mean the detail payload changed and should be re-fetched. */
const REFRESH_EVENTS = ["observation", "candidate", "candidateBlocked", "highlight", "progress"];
/** ADAAAA-7742: floor between two incremental section fetches. The debounce
 * coalesces the per-frame SSE burst; the floor keeps a long live job at a
 * bounded request rate (~20-25 tiny fetches/min) while still surfacing a window
 * within 2 s of the decide note that produced it. */
const DELTA_MIN_INTERVAL_MS = 1_000;
/** ADAAAA-7742: how long the SSE channel may stay silent before the page fires
 * an incremental refresh on its own. A live run emits an observation per sampled
 * frame, but that cadence can drop below 1/s when the box is contended — without
 * this idle trigger a new window would wait for the next event (measured 4 s on
 * the deployed box), so the page reconciles the delta at most ~1 s late. */
const DELTA_IDLE_MS = 1_200;
/** ADAAAA-7742: how long the SSE channel may stay silent before the 5 s
 * reconciling poll falls back to a full composite re-fetch — the recovery path
 * for a missed event or a dropped socket. */
const SSE_QUIET_MS = 10_000;

interface FrameTileProps {
  frame: JobDetailFrame;
  token: string | null;
  selectMode: boolean;
  selected: boolean;
  onFrameClick: (seq: number) => void;
}

/**
 * One frame with its perceive boxes + legible labels drawn on a canvas.
 *
 * Every tile fetches + draws its frame image on mount, serialized through the
 * shared `frameFetchWindow` (ADAAAA-7506) so a job that mounts thousands of
 * tiles never has more than a bounded number of frame-image fetches in flight
 * at once — guarding the ERR_INSUFFICIENT_RESOURCES break seen when a VOD job
 * with 100+ decide calls eager-loaded every frame concurrently.
 *
 * The previous ADAAAA-7471/7482 code gated the fetch on the tile being "near
 * the viewport", driven by IntersectionObserver + scroll callbacks. Those are
 * NOT dispatched in every browser context (notably automated/CDP verification
 * browsers), so `inView` never flipped true and no frame was ever fetched or
 * drawn — frames were served but the filmstrip rendered blank tiles
 * (ADAAAA-7529). Fetching on mount restores rendering in every environment;
 * the bounded window keeps memory + network safe, and the object URL is
 * revoked when the tile unmounts.
 */
function FrameTile({ frame, token, selectMode, selected, onFrameClick }: FrameTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLButtonElement>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);

  // Fetch the frame image on mount (and if the uri/token changes), holding the
  // object URL until unmount. The AbortController lets an unmounted tile drop a
  // still-queued fetch and free its frameFetchWindow slot.
  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    const ctrl = new AbortController();
    frameFetchWindow
      .run(() => authFetchFrame(frame.uri, token), ctrl.signal)
      .then((u) => {
        url = u;
        if (alive) setObjUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [frame.uri, token]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (!objUrl) return;
    const img = new Image();
    img.onload = () => {
      if (canvasRef.current !== canvas) return;
      drawFrameWithBoxes(canvas, img, frame.tracks, FRAME_W, FRAME_H, INLINE_FONT, INLINE_SCALE, false);
    };
    img.src = objUrl;
    return () => {
      img.onload = null;
    };
  }, [objUrl, frame]);

  return (
    <button
      ref={wrapRef}
      type="button"
      data-detail-frame
      data-selected-multi={selectMode && selected ? "true" : undefined}
      data-select-mode={selectMode ? "true" : undefined}
      onClick={() => onFrameClick(frame.seq)}
      title={selectMode ? (selected ? "Deselect frame" : "Select frame") : `Enlarge frame (T+${frame.timestamp.toFixed(1)}s)`}
      className={`shrink-0 rounded-lg border-2 transition ${
        selectMode && selected ? "border-neon" : "border-transparent hover:border-mut/40"
      }`}
    >
      <canvas ref={canvasRef} width={FRAME_W * INLINE_SCALE} height={FRAME_H * INLINE_SCALE} style={{ width: FRAME_W, height: FRAME_H }} className="block rounded-lg border border-mut/30 bg-black" />
      <figcaption className="mt-0.5 text-center text-[10px] text-mut">
        T+{frame.timestamp.toFixed(1)}s<span className="ml-1 text-mut/70">·{frame.tracks.length} trk</span>
      </figcaption>
    </button>
  );
}

/** One expandable decide-note banner: the one-line summary plus an "Inspect
 *  window" toggle that opens the per-window LLM inspection panel (ADAAAA-7157
 *  Increment C). Read-only over the job-detail API data.
 *
 *  ADAAAA-7838: `defaultOpen` lets the owner-facing lazy window body render the
 *  captured prompt/response straight away — the owner already opted into detail
 *  by clicking `Inspect` on the row, so one click there must not need a second
 *  click on the banner. The admin surface keeps the collapsed default. */
function DecideNoteBanner({ note, jobId, defaultOpen = false }: { note: DecideNote; jobId: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // ADAAAA-7672: surface the window's ASR transcript on the COLLAPSED banner.
  // The transcript already rendered inside the expanded inspection panel, but a
  // collapsed window — the state the board scans a job in — showed no ASR text at
  // all, so a window the decide LLM fed real commentary looked audio-less. The
  // line is omitted entirely when the transcript is empty/unusable or the window
  // had no captured audio, so a silent window stays silent.
  const asr = asrSummary(note.analysis);
  const asrLine = asrSummaryLine(note.analysis);
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs ${
        note.status === "accepted"
          ? "border-green/40 bg-green/10 text-green"
          : note.status === "suppressed"
          ? "border-yellow/40 bg-yellow/10 text-yellow"
          : "border-mut/30 bg-mut/10 text-slate-ink"
      }`}
      data-decide-note
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 text-left"
        data-decide-note-toggle
        aria-expanded={open}
      >
        <span className="shrink-0">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        <span className="font-bold">Decide @ T+{note.timestamp.toFixed(1)}s</span>
        <span className="ml-1">— {note.eventType} · {Math.round(note.score)}{note.outcome ? ` · ${note.outcome}` : ""} · {note.status}</span>
        <span className="ml-auto rounded border border-mut/30 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-mut" data-inspect-label>
          Inspect window
        </span>
      </button>
      {note.reason && <div className="mt-0.5 text-mut">{note.reason}</div>}
      {asr && (
        <div
          className="mt-0.5 flex min-w-0 items-baseline gap-1 text-[11px]"
          data-window-asr-summary
          data-asr-timing={asr.timing}
          title={asrLine ?? undefined}
        >
          <span className="shrink-0 font-bold uppercase tracking-wide text-purple">{asr.timing}</span>
          <span className="min-w-0 flex-1 truncate text-slate-ink">{`"${asr.transcript}"`}</span>
        </div>
      )}
      {open && <WindowAnalysisPanel analysis={note.analysis} confirm={note.confirm} jobId={jobId} triggerTs={note.timestamp} />}
    </div>
  );
}

/**
 * ADAAAA-7274: the three Analysis window types' accent classes (token-only).
 * `highlight` → green, `suppressed` → yellow (gated off but logged),
 * `not_highlight` → muted grey. Used by both the collapsed summary chips and
 * the filter chips so the type is spot-able at a glance in either place.
 */
const KIND_TONE: Record<NoteKind, string> = {
  highlight: "border-green/40 bg-green/10 text-green",
  suppressed: "border-yellow/40 bg-yellow/10 text-yellow",
  not_highlight: "border-mut/40 bg-mut/10 text-mut",
};

/**
 * Stable identity for one decide-call listing (ADAAAA-7471). A "decide call" is
 * anchored by the timestamp/event the LLM inspected — the banner reads
 * "Decide @ T+Ns — <event>". Dedup by this key so a candidate row persisted more
 * than once (e.g. a transient double-write on an in-flight job, or a re-decide)
 * can never render as a duplicate entry. Distinct calls carry distinct
 * timestamps, so legitimate calls are never collapsed.
 */
function decideNoteKey(n: DecideNote): string {
  return `${n.timestamp.toFixed(3)}|${n.eventType}|${n.status}`;
}

/**
 * Return the decide notes for a section with each decide call appearing exactly
 * once (ADAAAA-7471), preserving order. Dedup keyed by decide-call identity so
 * a candidate row persisted more than once (in-flight transient double-write /
 * re-decide) can never surface as a duplicate listing.
 */
function dedupeDecideNotes(notes: DecideNote[]): DecideNote[] {
  const seen = new Set<string>();
  const out: DecideNote[] = [];
  for (const n of notes) {
    const k = decideNoteKey(n);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(n);
  }
  return out;
}

/**
 * Return the section's frames with each seq rendered exactly once (ADAAAA-7471),
 * preserving order. A frame belongs to exactly one section (server partition);
 * this guards the filmstrip against a payload that repeats a seq.
 */
function dedupeFrames(frames: JobDetailFrame[]): JobDetailFrame[] {
  const seen = new Set<number>();
  const out: JobDetailFrame[] = [];
  for (const f of frames) {
    if (seen.has(f.seq)) continue;
    seen.add(f.seq);
    out.push(f);
  }
  return out;
}


interface AnalysisWindowProps {
  section: FrameSection;
  token: string | null;
  jobId: string;
  selectMode: boolean;
  selectedSeqs: Set<number>;
  onFrameClick: (seq: number) => void;
  /** Initial collapse state (default expanded). SSR/test hook; the toggle
   *  switches it client-side. */
  defaultOpen?: boolean;
  /** Operator session? A non-admin window is the customer projection
   *  (ADAAAA-7737): time range + plain-language status only, no decide
   *  attribution and no filmstrip. Defaults to the operator surface for direct
   *  component renders; the page always passes the session role. */
  admin?: boolean;
}

/**
 * ADAAAA-7881: one posted moment as a connected block in the Analysis window
 * list. The windows the dedupe folded into the same moment render inside one
 * left-rail group with a `One moment · N clips` label and an accessible name
 * (`Windows T+341s–T+375s are one highlight`), replacing the card's removed
 * "N merged" badge.
 */
export function MergedMomentGroupBlock({
  group,
  children,
}: {
  group: MergedMomentGroup;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border-l-4 border-yellow/50 pl-2"
      data-merged-moment-group={group.momentId}
      data-merged-moment-clips={group.clipCount}
      role="group"
      aria-label={group.ariaLabel}
    >
      <div className="text-[11px] font-bold uppercase tracking-wide text-yellow" data-merged-moment-label>
        {group.label}
      </div>
      {children}
    </div>
  );
}

/**
 * ADAAAA-7881: the Analysis window list, aware of merged moments. Consecutive
 * member windows render inside one `MergedMomentGroupBlock` (so the rail joins
 * them); a member whose siblings are not adjacent keeps the rail in the list
 * gutter without overlapping the unrelated rows between them. A job with no
 * duplicates (`groups` empty) renders exactly as before.
 */
export function AnalysisWindowList({
  sections,
  groups,
  renderWindow,
}: {
  sections: FrameSection[];
  groups?: MergedMomentGroup[];
  renderWindow: (section: FrameSection) => React.ReactNode;
}) {
  const byIndex = mergedGroupsByWindow(groups ?? []);
  const blocks: React.ReactNode[] = [];
  let i = 0;
  while (i < sections.length) {
    const section = sections[i];
    const group = byIndex.get(section.index);
    if (!group) {
      blocks.push(<div key={section.index}>{renderWindow(section)}</div>);
      i += 1;
      continue;
    }
    // Start the group block only at the group's first member window; a member
    // whose first sibling was filtered out still gets the rail, just no label.
    const startsGroup = group.memberIndexes[0] === section.index;
    const run: FrameSection[] = [section];
    let j = i + 1;
    while (j < sections.length && byIndex.get(sections[j].index) === group) {
      run.push(sections[j]);
      j += 1;
    }
    const rows = run.map((member) => (
      <div key={member.index} className="min-w-0" data-merged-moment-window={group.momentId}>
        {renderWindow(member)}
      </div>
    ));
    blocks.push(
      startsGroup ? (
        <MergedMomentGroupBlock key={`group-${group.momentId}`} group={group}>
          {rows}
        </MergedMomentGroupBlock>
      ) : (
        <div
          key={`rail-${group.momentId}-${section.index}`}
          className="flex min-w-0 flex-col gap-2 border-l-4 border-yellow/50 pl-2"
          data-merged-moment-window={group.momentId}
        >
          {rows}
        </div>
      )
    );
    i = j;
  }
  return <>{blocks}</>;
}

/**
 * Customer projection of one Analysis window (ADAAAA-7737). A finished job's
 * window is a TIME RANGE plus "Highlight detected" / "Checked — no highlight".
 * It carries no decide label, no event taxonomy, no score, no outcome code and
 * no per-frame track counts; the same payload still feeds every admin surface
 * on the same job id, so this is a render-boundary projection, not a filter.
 */
export function CustomerAnalysisWindow({ section }: { section: FrameSection }) {
  const status = customerWindowStatus(section);
  const key = customerWindowStatusKey(status);
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${key === "highlight" ? KIND_TONE.highlight : KIND_TONE.not_highlight}`}
      data-analysis-window
      data-section-index={section.index}
      data-analysis-window-status={key}
    >
      <span className="font-mono text-xs text-ink" data-analysis-window-range>
        {customerWindowRange(section)}
      </span>
      <span className="ml-auto rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" data-analysis-window-status-label>
        {status}
      </span>
    </div>
  );
}

/**
 * ADAAAA-7838: per-window lazy inspection state for the owner-facing surface.
 * `loaded` carries the window's captured detail (fetched once, cached for the
 * session); a row that was never clicked has no entry at all.
 */
export interface WindowInspectState {
  status: "loading" | "loaded" | "error";
  data?: SectionInspect;
  error?: string;
}

/**
 * ADAAAA-7838: the `See detail` toggle, floated right in the Analysis heading
 * row. Default OFF — the owner opts into window internals; a non-owner session
 * never reaches this component (the API gates it with 403).
 */
export function SeeDetailToggle({
  on,
  onToggle,
  disabled = false,
}: {
  on: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || !onToggle}
      aria-pressed={on}
      data-see-detail-toggle
      data-active={on ? "true" : undefined}
      className={`rounded border px-2 py-1 text-[11px] font-bold uppercase tracking-wide ${
        on
          ? "border-neon/60 bg-neon/10 text-neon"
          : "border-mut/40 text-mut hover:border-neon hover:text-neon"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      See detail
    </button>
  );
}

/**
 * ADAAAA-7838: one Analysis window as a COLLAPSED SECTION on the owner-facing
 * surface (`See detail` ON). The header keeps today's row (time range + plain
 * status) and adds a chevron plus an `Inspect` button next to the timestamp; the
 * body is fetched ONLY when that row's `Inspect` is clicked, then shows the
 * decide banner, the captured prompt/response inspection, the frame filmstrip
 * and the audio-energy graph for that window alone.
 */
export function CustomerInspectWindow({
  section,
  jobId,
  token = null,
  inspection,
  onInspect,
  onFrameClick,
}: {
  section: FrameSection;
  jobId: string;
  token?: string | null;
  inspection?: WindowInspectState;
  onInspect: (index: number) => void;
  onFrameClick?: (seq: number) => void;
}) {
  // Collapsed by default; a row whose window is already loaded/being opened by
  // the `Inspect` click renders open (that click sets this same state).
  const [open, setOpen] = useState(Boolean(inspection?.data));
  const status = customerWindowStatus(section);
  const key = customerWindowStatusKey(status);
  const notes = inspection?.data ? dedupeDecideNotes(inspection.data.decideNotes) : [];
  const loading = inspection?.status === "loading";
  return (
    <section
      className={`rounded-lg border ${key === "highlight" ? "border-green/40 bg-green/10" : "border-mut/30 bg-mut/10"}`}
      data-analysis-window
      data-section-index={section.index}
      data-analysis-window-status={key}
      data-inspect-window
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex min-w-0 items-center gap-2 text-left"
          data-analysis-window-toggle
        >
          <span className="shrink-0 text-mut">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
          <span className="font-mono text-xs text-ink" data-analysis-window-range>
            {customerWindowRange(section)}
          </span>
        </button>
        {/* ADAAAA-7838: the per-window lazy read — one request for THIS bucket,
            only when the owner clicks it. */}
        <button
          type="button"
          onClick={() => {
            setOpen(true);
            onInspect(section.index);
          }}
          data-inspect-window-button
          data-section-index={section.index}
          className="shrink-0 rounded border border-neon/60 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-neon hover:bg-neon/10"
        >
          {loading ? "Loading…" : "Inspect"}
        </button>
        <span className="ml-auto shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide" data-analysis-window-status-label>
          {status}
        </span>
      </div>
      {open && (
        <div className="border-t border-mut/20 p-3" data-inspect-window-body>
          {inspection?.status === "error" ? (
            <div className="text-xs text-red" data-inspect-window-error>
              {inspection.error || "Could not load this window."}
            </div>
          ) : loading ? (
            <div className="text-xs text-mut" data-inspect-window-loading>
              Loading window detail…
            </div>
          ) : !inspection?.data ? (
            <div className="text-xs text-mut" data-inspect-window-idle>
              Click Inspect to load this window&apos;s captured detail.
            </div>
          ) : (
            <>
              {notes.length > 0 && (
                <div className="mb-2 flex flex-col gap-1">
                  {notes.map((n, i) => (
                    <DecideNoteBanner key={n.timestamp + "-" + i} note={n} jobId={jobId} defaultOpen />
                  ))}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5" data-inspect-window-frames>
                {section.frames.length === 0 ? (
                  <div className="text-xs text-mut">No frames in this section.</div>
                ) : (
                  dedupeFrames(section.frames).map((f) => (
                    <FrameTile
                      key={f.seq}
                      frame={f}
                      token={token}
                      selectMode={false}
                      selected={false}
                      onFrameClick={onFrameClick ?? (() => {})}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}

/**
 * A collapsible Analysis time window (frame section). Collapsed it shows ONLY
 * the summary text plus the color-coded window-type chips (highlight /
 * suppressed / not highlight) so the type stays spot-able at a glance without
 * expanding. Expanded it shows the decide-note banners + frame filmstrip.
 *
 * ADAAAA-7737: for a `role=user` session the whole expanded body (decide
 * banners, per-frame track counts) renders nothing — see CustomerAnalysisWindow.
 */
export function AnalysisWindow({ section, token, jobId, selectMode, selectedSeqs, onFrameClick, defaultOpen = true, admin = true }: AnalysisWindowProps) {
  const [open, setOpen] = useState(defaultOpen);
  if (!admin) return <CustomerAnalysisWindow section={section} />;
  const kinds = sectionKinds(section);
  return (
    <section className="rounded-xl border border-purple/30 bg-black/30" data-analysis-window data-section-index={section.index}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-analysis-window-toggle
      >
        <span className="shrink-0 text-mut">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        {kinds.map((k) => (
          <span
            key={k}
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${KIND_TONE[k]}`}
            data-analysis-kind={k}
          >
            {noteKindLabel(k)}
          </span>
        ))}
        <span className="min-w-0 flex-1 truncate text-xs text-slate-ink" data-analysis-summary>
          {sectionSummaryText(section)}
        </span>
      </button>
      {open && (
        <div className="border-t border-purple/20 p-3" data-analysis-window-body>
          {dedupeDecideNotes(section.decideNotes).length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              {dedupeDecideNotes(section.decideNotes).map((n, i) => (
                <DecideNoteBanner key={n.timestamp + "-" + i} note={n} jobId={jobId} />
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {section.frames.length === 0 ? (
              <div className="text-xs text-mut">No frames in this section.</div>
            ) : (
              dedupeFrames(section.frames).map((f) => (
                <FrameTile
                  key={f.seq}
                  frame={f}
                  token={token}
                  selectMode={selectMode}
                  selected={selectedSeqs.has(f.seq)}
                  onFrameClick={onFrameClick}
                />
              ))
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * ADAAAA-7466: the append-only per-pass summary time log (`job.summaryLog`),
 * rendered as a collapsible section titled **Video Summary**, **collapsed by
 * default** (header visible, body hidden until expanded). Each entry shows its
 * timestamp (`windowTs ?? ts`) and text; the log grows as the video processes
 * (append-only, never drops the oldest entry). A legacy/predate job with no
 * log renders a graceful "No summary yet" state rather than an error.
 * `defaultOpen` is an SSR/test hook (default collapsed). Replaces the removed
 * running action notes surface.
 */
export function VideoSummary({
  entries,
  highlights,
  fastRail = false,
  defaultOpen = false,
}: {
  entries?: SummaryLogEntry[];
  /** ADAAAA-7958: the accepted highlights, so an item that asserts a goal is
   *  checked against that window's corroboration before it is shown. */
  highlights?: JobDetailHighlight[];
  /** ADAAAA-7958: fast rail only (`file` = long-form VOD, graded unchanged). */
  fastRail?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  // ADAAAA-7958 (contract v3 §3.4 + §3.6): the emitted items, not the stored
  // ones — a goal claim on a window the pipeline never corroborated is rewritten
  // to the non-goal beat, and an identical line is kept at most twice per job.
  const log = useMemo(
    () => groundSummaryItems(entries ?? [], { highlights, fastRail }),
    [entries, highlights, fastRail]
  );
  return (
    <div className="mt-4 rounded-lg border border-neon/30 bg-card" data-detail-video-summary>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-detail-video-summary-toggle
      >
        <span className="shrink-0 text-mut">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        <span className="text-xs uppercase tracking-wide text-neon">Video Summary</span>
        {log.length > 0 && (
          <span className="ml-auto rounded-full border border-neon/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-mut" data-detail-video-summary-count>
            {log.length}
          </span>
        )}
      </button>
      {open && (
        <div className="border-t border-neon/20 px-3 py-2" data-detail-video-summary-body>
          {log.length === 0 ? (
            <div className="text-sm text-mut" data-detail-video-summary-empty>
              No summary yet
            </div>
          ) : (
            <ol className="flex flex-col gap-1.5" data-detail-video-summary-log>
              {log.map((e, i) => (
                <li key={e.seq ?? i} className="text-xs" data-detail-video-summary-entry>
                  <span className="font-mono text-mut">{summaryEntryTimestamp(e)}</span>
                  <span className="text-slate-ink"> {e.text}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * ADAAAA-7700: the failure attribution chip. `failed` alone said nothing at
 * 22:16Z — a media-node restart (`media session lost`) must read differently from
 * a user stop, and the reason must be visible on /app/jobs/:id. Exported so the
 * rendering is pinned by a test without driving the whole page.
 */
export function FailureReasonChip({ reason }: { reason?: string | null }) {
  const label = failureReasonLabel(reason);
  if (!label || !reason) return null;
  return (
    <span
      className="rounded-full border border-red/40 bg-red/10 px-2 py-0.5 text-xs font-bold uppercase text-red"
      data-detail-failure-reason={reason}
      title={`failureReason: ${reason}`}
    >
      reason: {label}
    </span>
  );
}

/**
 * ADAAAA-7741: how far behind live the customer's feed is — see
 * components/LiveProgressChip.tsx (kept in its own module so both chip states
 * are pinned by a render test).
 */

function statusChip(status: string): string {
  switch (status) {
    case "queued":
      return "border-mut/40 bg-mut/10 text-mut";
    case "active":
    case "extracting":
    case "analyzing":
    case "finalizing":
      // ADAAAA-6989: VOD processing stages are in-flight; render like `active`.
      return "border-neon/40 bg-neon/10 text-neon";
    case "done":
      return "border-green/40 bg-green/10 text-green";
    case "failed":
      return "border-red/40 bg-red/10 text-red";
    default:
      return "border-mut/40 bg-mut/10 text-mut";
  }
}

function sourceLabel(source: string | undefined): string {
  const map: Record<string, string> = {
    file: "File",
    rtmp: "RTMP",
    webrtc: "WebRTC",
    screenshare: "Screen share",
    browser: "Browser",
    "file-sim": "File (sim)",
  };
  return (source && map[source]) || source || "Unknown";
}

/**
 * ADAAAA-7910 (increment 2): the card's ONE action row — three equal slots,
 * icon-only at rest, the hovered/focused slot grows and reveals its label.
 * Layout and motion live in `index.css` under `[data-detail-actions]`, so the
 * geometry is measurable and the reduced-motion / coarse-pointer branches are
 * one media query each.
 *
 * Slot 3 is stateful because removing Accept must not delete the restore path
 * the server supports (`POST /highlights/:id/review {status:"accepted"}`):
 *   accepted -> Reject (X, pink)      rejected -> Undo reject (Undo2, green)
 *   pending  -> Approve (Check, green)  [only reachable with auto-publish off]
 *
 * Kept hook-free on purpose: the node test env renders this suite through
 * `renderToString` (no jsdom), so a test can call this component directly and
 * invoke the real `onClick` handler it returns.
 */
export function verdictAction(status: string): {
  marker: "data-detail-reject" | "data-detail-restore" | "data-detail-approve";
  label: "Reject" | "Undo reject" | "Approve";
  next: "accepted" | "rejected";
  tone: "pink" | "green";
} {
  if (status === "rejected") {
    return { marker: "data-detail-restore", label: "Undo reject", next: "accepted", tone: "green" };
  }
  // ADAAAA-7910: a non-auto-publish box stores `pending` (services/server
  // config.autoPublishHighlights), so those cards get an explicit Approve slot
  // instead of being stranded with no accept control.
  if (status === "pending") {
    return { marker: "data-detail-approve", label: "Approve", next: "accepted", tone: "green" };
  }
  return { marker: "data-detail-reject", label: "Reject", next: "rejected", tone: "pink" };
}

export function HighlightActionRow({
  highlight: h,
  downloadUrl,
  copied = "idle",
  onCopy,
  onDecision,
  pendingStatus = null,
  exportLocked = false,
}: {
  highlight: JobDetailHighlight;
  /** ADAAAA-7896: the server-minted export URL (not the public clip URI). */
  downloadUrl: string;
  copied?: "idle" | "copied" | "failed";
  onCopy: () => void;
  onDecision: (h: JobDetailHighlight, status: "accepted" | "rejected") => void;
  pendingStatus?: "accepted" | "rejected" | null;
  /** ADAAAA-7896: the clip already left the app (downloaded / link copied), so
   * an owner can no longer reject it. The SERVER is authoritative (409
   * `clip_exported`); this only makes the lock visible before the click. */
  exportLocked?: boolean;
}) {
  const verdict = verdictAction(h.status);
  const busyVerdict = pendingStatus === verdict.next;
  const copyLabel = copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy Link";
  const copyTitle = exportLocked
    ? undefined
    : copied === "copied"
      ? "Copied"
      : copied === "failed"
        ? "Copy failed"
        : undefined;
  return (
    <div className="mt-3" data-detail-actions>
      {/* 1 — Download. The clip URL is public, so the saved file needs no login. */}
      {h.clipUri ? (
        <a
          className="detail-action"
          href={downloadUrl}
          download={clipFileName(h)}
          aria-label="Download"
          data-detail-download
          data-detail-action
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden />
          <span className="detail-action-label" data-detail-label>
            Download
          </span>
        </a>
      ) : (
        <button
          type="button"
          className="detail-action"
          disabled
          aria-label="Download"
          data-detail-download
          data-detail-action
        >
          <Download className="h-4 w-4 shrink-0" aria-hidden />
          <span className="detail-action-label" data-detail-label>
            Download
          </span>
        </button>
      )}
      {/* 2 — Copy Link. Copies the export URL; success flips to Copied (~2 s). */}
      <button
        type="button"
        className="detail-action"
        onClick={onCopy}
        disabled={!h.clipUri}
        aria-label={copyLabel}
        title={copyTitle}
        data-detail-copy-link
        data-detail-action
        data-copy-state={copied}
      >
        {copied === "copied" ? (
          <Check className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Link2 className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="detail-action-label" data-detail-label>
          {copyLabel}
        </span>
      </button>
      {/* 3 — the non-default verdict: Reject / Undo reject / Approve. */}
      <button
        type="button"
        className={`detail-action${verdict.tone === "pink" ? " detail-action-pink" : " detail-action-green"}`}
        disabled={busyVerdict || (verdict.next === "rejected" && exportLocked)}
        aria-label={verdict.label}
        title={
          verdict.next === "rejected" && exportLocked
            ? "This clip was already downloaded or its link copied, so it can no longer be rejected"
            : undefined
        }
        onClick={() => onDecision(h, verdict.next)}
        data-detail-action
        {...{ [verdict.marker]: true }}
        data-export-locked={verdict.next === "rejected" && exportLocked ? "true" : undefined}
      >
        {busyVerdict ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
        ) : verdict.marker === "data-detail-reject" ? (
          <X className="h-4 w-4 shrink-0" aria-hidden />
        ) : verdict.marker === "data-detail-restore" ? (
          <Undo2 className="h-4 w-4 shrink-0" aria-hidden />
        ) : (
          <Check className="h-4 w-4 shrink-0" aria-hidden />
        )}
        <span className="detail-action-label" data-detail-label>
          {verdict.label}
        </span>
      </button>
    </div>
  );
}

/**
 * One identified/accepted highlight on the per-job detail surface. Renders the
 * clip player (VideoClip) so the highlight shows its video, plus the metadata
 * and the single action row (HighlightActionRow: Download / Copy Link /
 * verdict — ADAAAA-7910).
 * Extracted from the JobDetail card so the highlight card (and its clip-player
 * mount) is independently testable.
 * ADAAAA-6948: the per-job card previously imported VideoClip but never rendered
 * it, so identified highlights showed no video.
 */
export interface HighlightCardProps {
  highlight: JobDetailHighlight;
  onDecision: (h: JobDetailHighlight, status: "accepted" | "rejected") => void;
  /** Which review action is currently in-flight for this card (drives the
   * per-control loading state; disables both controls while pending). */
  pendingStatus?: "accepted" | "rejected" | null;
  /** ADAAAA-7622: the current caption for this clip. Edited inline on the
   * card; the page owns the value so the batch export ships the edit. */
  caption?: string;
  onCaptionChange?: (h: JobDetailHighlight, value: string) => void;
  /** ADAAAA-7881: the job's summary log, used to derive the suggested caption
   *  and the one-line post titles for this clip's window. */
  summaryLog?: SummaryLogEntry[];
  /** ADAAAA-7622: cards in the accepted (postable) feed can join a batch. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (h: JobDetailHighlight) => void;
  /** Operator session? The customer card (ADAAAA-7737) is the clip, its time
   *  range, the posting caption, Download / Copy link and the owner-facing
   *  Accept/Reject review controls (ADAAAA-7893) — no event taxonomy, no score,
   *  no trigger and no outcome reason. Defaults to the operator surface for
   *  direct component renders; the page always passes the session role. */
  admin?: boolean;
}

export function HighlightCard({
  highlight: h,
  onDecision,
  pendingStatus = null,
  caption = "",
  onCaptionChange,
  selectable = false,
  selected = false,
  onToggleSelect,
  admin = true,
  summaryLog,
}: HighlightCardProps) {
  // ADAAAA-7622: one click must yield either a file or a clipboard URL, with
  // no DevTools in the happy path. `download` on a same-origin anchor saves
  // the clip; the copy button reports its own state so a blocked clipboard is
  // visible instead of silently doing nothing.
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  // ADAAAA-7881: per-title copy feedback (`Use as caption` has its own path).
  const [titleCopy, setTitleCopy] = useState<{ title: string; ok: boolean } | null>(null);
  // ADAAAA-7881: the page owns the caption (the batch export ships the edit),
  // but a card rendered without one (the rejected lane, component tests) still
  // shows and edits the deterministic suggestion instead of an empty box.
  const [localCaption, setLocalCaption] = useState<string | null>(null);
  // ADAAAA-7896: download/copy use the server-minted export URL so the fetch
  // marks the clip; playback (VideoClip) keeps the public `clipUri`.
  const url = exportUrl(h);
  const titles = postTitles(h, summaryLog);
  const shownCaption = localCaption ?? (caption || suggestCaption(h, summaryLog));
  const durationS = Math.max(0, Math.round(h.end - h.start));
  function setCaption(value: string) {
    setLocalCaption(value);
    onCaptionChange?.(h, value);
  }
  async function copyLink() {
    // ADAAAA-7896: the copied text is the EXPORT url (two URL classes), and the
    // clip is marked exported only when the clipboard write actually succeeded.
    const ok = await copyExportLink(h, {
      mark: (id) => markExportIntent((p, body) => api(p, { body }), id, "copy_link"),
    });
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied("idle"), 1800);
  }
  async function copyTitle(title: string) {
    const ok = await copyText(title);
    setTitleCopy({ title, ok });
    setTimeout(() => setTitleCopy(null), 1800);
  }
  return (
    <div className="card card-hover min-w-0 overflow-hidden" data-detail-highlight>
      <VideoClip src={h.clipUri} label={admin ? h.eventType : undefined} error={h.clipError} />
      {/* ADAAAA-7881: the audio state describes the CLIP, so it sits with the
          clip — once, quiet, and never duplicated below the metadata. */}
      {h.hasAudio === false && (
        <div className="flex items-center gap-1 px-4 pt-2 text-xs text-mut" data-detail-no-audio>
          <VolumeX className="h-3 w-3" aria-hidden /> No audio captured — this clip has no audio track.
        </div>
      )}
      <div className="min-w-0 p-4">
        {/* ADAAAA-7881: the moment is the card's dominant identifier; the raw
            pipeline enum and the review status are gone from every role. */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm font-bold text-ink" data-detail-moment-range>
            {momentRangeLabel(h.start, h.end)}
          </span>
          <span
            className="rounded-full border border-mut/40 bg-mut/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-mut"
            data-detail-duration
          >
            {durationS}s
          </span>
          {selectable && onToggleSelect && (
            <label className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-mut" data-detail-select-label>
              <input
                type="checkbox"
                className="h-4 w-4 accent-neon"
                checked={selected}
                onChange={() => onToggleSelect(h)}
                data-detail-select-highlight
              />
              Batch
            </label>
          )}
        </div>
        {/* ADAAAA-7881: suggested caption — one social-ready sentence, seeded
            deterministically from the summary-log window and editable here. */}
        <label className="mt-3 block">
          <span className="text-xs uppercase tracking-wide text-mut">Suggested caption</span>
          <textarea
            className="mt-1 w-full resize-y rounded-lg border border-neon/30 bg-dusk px-2 py-1 text-xs text-ink"
            rows={3}
            value={shownCaption}
            onChange={(e) => setCaption(e.target.value)}
            data-detail-caption
          />
        </label>
        {/* ADAAAA-7881: one-line post titles. Each chip copies its own text; the
            secondary affordance applies it as the caption. */}
        {titles.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5" data-detail-titles>
            {titles.map((title) => (
              <span
                key={title}
                className="flex max-w-full min-w-0 items-center gap-1 rounded-full border border-neon/40 bg-neon/10 px-2 py-0.5"
              >
                <button
                  type="button"
                  onClick={() => copyTitle(title)}
                  title={titleCopy?.title === title ? (titleCopy.ok ? "Copied" : "Copy failed") : "Copy title"}
                  className="min-w-0 truncate text-left text-xs text-ink"
                  data-detail-title
                >
                  {titleCopy?.title === title && titleCopy.ok ? "Copied" : title}
                </button>
                <button
                  type="button"
                  onClick={() => setCaption(captionFromTitle(title))}
                  aria-label={`Use "${title}" as caption`}
                  className="shrink-0 text-[10px] font-bold uppercase tracking-wide text-neon"
                  data-detail-title-use-caption
                >
                  Use as caption
                </button>
              </span>
            ))}
          </div>
        )}
        {/* ADAAAA-7910: ONE action row — Download / Copy Link / verdict, three
            equal slots, icon-only at rest; hover or keyboard focus grows the
            slot and reveals its label (coarse pointer / ≤ 640 px shows all
            three labels, because hover does not exist on touch). Accept is
            gone: `accepted` is the server default, and the restore path lives
            in slot 3 (Undo reject / Approve), outside `Pipeline detail`. */}
        <HighlightActionRow
          highlight={h}
          downloadUrl={url}
          copied={copied}
          onCopy={copyLink}
          onDecision={onDecision}
          pendingStatus={pendingStatus}
          // ADAAAA-7896: an owner loses Reject once the clip was exported; an
          // operator keeps it (they download clips to inspect them).
          exportLocked={!!h.exportedAt && !admin}
        />
        {/* ADAAAA-7896: why Reject is unavailable — the clip already left the app. */}
        {!!h.exportedAt && !admin && h.status !== "rejected" && (
          <div className="mt-1 text-xs text-mut" data-detail-export-locked>
            Downloaded — this clip can no longer be rejected.
          </div>
        )}
        {/* One small inline note, visible to every session. Recovery guidance,
            not a badge — it never prints a bare `accepted` / `rejected` label
            (ADAAAA-7915: a customer session renders this too). */}
        {h.status === "rejected" && (
          <div className="mt-1 text-xs text-red" data-detail-rejected>
            Undo reject restores this clip within its recover window.
          </div>
        )}
        {/* ADAAAA-7881: the transcript is low-emphasis and rendered ONCE, verbatim
            behind a disclosure (the stored value is never truncated). */}
        {h.asrTranscript && (
          <details className="mt-3 rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut" data-detail-asr>
            <summary className="cursor-pointer text-xs text-mut">Transcript</summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-slate-ink">{h.asrTranscript}</p>
          </details>
        )}
        {/* ADAAAA-7881: operator pipeline internals — event type, score, trigger
            and outcome reason — live in ONE collapsed disclosure so the
            customer-facing hierarchy stays intact. ADAAAA-7893: the review
            controls are NOT internals and no longer live here. */}
        {admin && (
          <details className="mt-3 rounded-lg border border-purple/30 bg-black/30 px-2 py-1" data-detail-pipeline>
            <summary className="cursor-pointer text-[11px] font-bold uppercase tracking-wide text-mut">
              Pipeline detail
            </summary>
            <div className="mt-2 flex flex-col gap-1 text-xs">
              <span className="w-fit rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">
                {h.eventType || "EVENT"}
              </span>
              <div className="text-2xl font-black text-neon">{Math.round(h.score)}</div>
              <div className="rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut" data-detail-trigger>
                Trigger: <span className="font-bold text-ink">{triggerLabel(h.trigger)}</span>
              </div>
              <div className="text-sm text-slate-ink">{h.reason || "No reason"}</div>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

/**
 * Compact row list for the lanes ADAAAA-7621 put beside the postable gallery:
 * `duplicateHighlights` (overlapping clips the dedupe folded into a kept
 * moment) and `notableHighlights` (non-scoring near_miss / big_play clips the
 * precision gate keeps out of the postable list). Rows are deliberately
 * text-only — a second grid of playable cards would re-present merged footage
 * as if it were its own highlight, which is the bug this ticket closed.
 */
export function SecondaryHighlightLane({
  title,
  note,
  highlights,
  tone = "mut",
  lane,
  admin = true,
}: {
  title: string;
  note: string;
  highlights: JobDetailHighlight[];
  tone?: "mut" | "yellow";
  /** `data-detail-lane` value so tests/QA can target the lane. */
  lane: "merged" | "notable";
  /** Operator session? A customer row (ADAAAA-7737) is the time range only —
   *  no score, no event taxonomy, no outcome code, no reason. */
  admin?: boolean;
}) {
  if (highlights.length === 0) return null;
  return (
    <div className="mt-6" data-detail-lane={lane}>
      <h4 className={`text-sm font-bold ${tone === "yellow" ? "text-yellow" : "text-mut"}`}>{title}</h4>
      <div className="mt-1 text-xs text-mut">{note}</div>
      <ul className="mt-2 space-y-1">
        {highlights.map((h) => (
          <li
            key={h.id}
            className="rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut"
            data-detail-lane-row={lane}
          >
            <span className="font-bold text-ink">
              T+{Math.round(h.start)}s → T+{Math.round(h.end)}s
            </span>
            {admin && <span className="ml-2">
              · score {Math.round(h.score)}
            </span>}
            {admin && h.eventType && <span className="ml-2">· {h.eventType}</span>}
            {admin && h.outcome && <span className="ml-2">· outcome {h.outcome}</span>}
            {admin && lane === "merged" && h.duplicateOf && (
              <span className="ml-2">· merged into {h.duplicateOf.slice(0, 8)}</span>
            )}
            {admin && h.reason && <div className="mt-0.5 text-slate-ink">{h.reason}</div>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Enlarged lightbox: renders a single frame or a prev/next gallery across a
 * selected set of frames, drawing the SAME renderer as the inline tile so
 * boxes/labels/palette/selection highlight are identical (A4). Clicking a box
 * in the enlarged view issues find-and-track via /jobs/:id/control.
 */
function EnlargeGallery({
  gallery,
  galIndex,
  framesBySeq,
  token,
  onClose,
  onPrev,
  onNext,
  onBoxTrack,
}: {
  gallery: number[];
  galIndex: number;
  framesBySeq: Map<number, JobDetailFrame>;
  token: string | null;
  onClose: () => void;
  onPrev: () => void;
  onNext: () => void;
  onBoxTrack: (frame: JobDetailFrame, t: NonNullable<JobDetailFrame["tracks"]>[number]) => void;
}) {
  const seq = gallery[galIndex];
  const frame = framesBySeq.get(seq);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // ADAAAA-6978: the cover-crop transform currently applied to the enlarged
  // canvas, so a click on a detection box over the full-bleed image hit-tests in
  // the same (cropped) coordinate space the image was drawn in.
  const enlCoverRef = useRef<CoverTransform | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  // Bumped on window resize while the lightbox is open so the enlarged canvas
  // re-draws at the new viewport dimensions.
  const [enlTick, setEnlTick] = useState(0);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    const ctrl = new AbortController();
    if (!frame) return;
    // Run through the shared rolling window (ADAAAA-7506) so the enlarged
    // gallery fetch shares the same bounded in-flight budget as the inline
    // tiles; closing the lightbox aborts a still-queued fetch.
    frameFetchWindow
      .run(() => authFetchFrame(frame.uri, token), ctrl.signal)
      .then((u) => {
        url = u;
        if (alive) setObjUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      ctrl.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [frame, token]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !objUrl || !frame) return;
    const img = new Image();
    img.onload = () => {
      if (canvasRef.current !== canvas) return;
      // ADAAAA-6978: draw the enlarged frame with object-fit:cover semantics so
      // it fills the entire modal area edge-to-edge (no letterbox bars), with
      // detection boxes + labels positioned relative to the covered image.
      const vw = canvas.clientWidth || window.innerWidth;
      const vh = canvas.clientHeight || window.innerHeight;
      const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));
      canvas.width = vw * dpr;
      canvas.height = vh * dpr;
      // Scale the label with the viewport so it stays legible on a full-screen
      // enlarged frame (roughly proportional to the smaller dimension).
      const fontPx = Math.max(20, Math.min(34, Math.round(Math.min(vw, vh) / 32)));
      const imgW = img.naturalWidth || img.width || vw;
      const imgH = img.naturalHeight || img.height || vh;
      enlCoverRef.current = coverTransform(imgW, imgH, vw, vh);
      drawFrameFullBleed(canvas, img, frame.tracks, vw, vh, fontPx, dpr);
    };
    img.src = objUrl;
    return () => {
      img.onload = null;
    };
  }, [objUrl, frame, enlTick]);

  // Re-draw the enlarged frame on window resize so it keeps filling the full
  // viewport instead of stretching the old backing store.
  useEffect(() => {
    const onResize = () => setEnlTick((t) => t + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function onCanvasClick(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!frame) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    let nx = (e.clientX - rect.left) / rect.width;
    let ny = (e.clientY - rect.top) / rect.height;
    // Inverse-map the click from canvas px into image-normalized space so the
    // box hit-test matches the full-bleed (cover-cropped) image.
    const cover = enlCoverRef.current;
    if (cover) {
      nx = (e.clientX - rect.left - cover.dx) / (cover.imgW * cover.scale);
      ny = (e.clientY - rect.top - cover.dy) / (cover.imgH * cover.scale);
    }
    const hit = frame.tracks.find((t) => {
      const [x1, y1, x2, y2] = t.bbox;
      return nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2;
    });
    if (hit) onBoxTrack(frame, hit);
    else onClose();
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/90" data-enlarge-overlay>
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-crosshair"
        onClick={onCanvasClick}
      />
      {/* Top control bar overlays the full-bleed image so the frame fills the
          whole modal area edge-to-edge (ADAAAA-6978). */}
      <div className="absolute inset-x-0 top-0 z-10 flex items-center gap-3 bg-gradient-to-b from-black/80 to-transparent px-4 py-3 text-sm text-mut">
        <span>
          seq {seq} — {(frame?.tracks.length ?? 0)} track(s) {gallery.length > 1 ? `(${galIndex + 1}/${gallery.length})` : ""}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {gallery.length > 1 && (
            <>
              <button type="button" data-gallery-prev="true" onClick={onPrev} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-neon">‹ prev</button>
              <button type="button" data-gallery-next="true" onClick={onNext} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-neon">next ›</button>
            </>
          )}
          <button type="button" data-gallery-close="true" onClick={onClose} className="rounded border border-mut/40 px-2 py-1 text-mut hover:text-red">✕ close</button>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-10 text-center text-[11px] text-mut/80">
        click a box in the enlarged view to follow that object · click empty area to close
      </div>
    </div>
  );
}

/** Verdict-chip tone -> theme-token classes (webapp/src/index.css `@theme`).
 * Token-only: no raw colors, no arbitrary color values. */
const CHIP_TONE_CLASS: Record<DecideAuditChipTone, string> = {
  ok: "border-green/50 text-green",
  warn: "border-yellow/50 text-yellow",
  bad: "border-red/50 text-red",
  muted: "border-mut/30 text-mut",
};

/**
 * One Decide LLM audit row (ADAAAA-7625).
 *
 * The row is a durable `decide_audit` record. Before this the section printed
 * the raw frame-group key and `frameCount ?? 0` counts, so a confirm row (which
 * records neither counts nor timings) read `0 frames · 0 candidates` and gave no
 * hint when in the video it happened. The summary line now leads with the two
 * clocks — in-video time decoded from the group key (`g297` / `g297:confirm` ->
 * `T+4:57`) and the UTC wall clock from `createdAt` — then the verdict chips,
 * the recorded counts (or `not recorded`, never a fabricated 0), and elapsed ms
 * when recorded. The prompt text, raw reply, media hashes and raw group key sit
 * in a collapsed <details> so the row still occupies one line.
 */
export function DecideAuditRow({ audit: a }: { audit: DecideAuditRecord }) {
  const inVideo = decideAuditInVideoLabel(a.groupKey);
  const wallClock = decideAuditWallClock(a.createdAt);
  const chips = decideAuditVerdictChips(a.verdicts);
  const elapsed = decideAuditElapsedLabel(a.timings);
  const media = decideAuditMediaRefs(a.mediaHashes);
  return (
    <li
      data-decide-audit-row
      data-decide-audit-group={a.groupKey ?? ""}
      data-decide-audit-replayable={String(!!a.replayable)}
      className="rounded-lg border border-mut/30 bg-mut/5 px-3 py-2 text-sm"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1" data-decide-audit-summary>
        <span className="font-mono text-xs font-bold text-ink" data-decide-audit-time>
          {inVideo}
        </span>
        <span className="font-mono text-xs text-mut" data-decide-audit-wall>
          {wallClock}
        </span>
        <span className="rounded-full border border-mut/30 px-2 py-0.5 text-xs uppercase text-mut">
          {a.systemPromptVersion ? `sys v${a.systemPromptVersion}` : "sys"}
        </span>
        {chips.map((c) => (
          <span
            key={c.key}
            data-decide-audit-verdict={c.key}
            className={`rounded-full border px-2 py-0.5 text-xs ${CHIP_TONE_CLASS[c.tone]}`}
          >
            {c.label}
          </span>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-x-2 text-xs text-mut" data-decide-audit-counts>
          <span data-decide-audit-frames>{decideAuditCountLabel(a.frameCount, "frame")}</span>
          <span aria-hidden="true">·</span>
          <span data-decide-audit-candidates>{decideAuditCountLabel(a.candidateCount, "candidate")}</span>
          {elapsed && (
            <>
              <span aria-hidden="true">·</span>
              <span data-decide-audit-elapsed>{elapsed}</span>
            </>
          )}
        </span>
      </div>
      {a.fallback && (
        <div className="mt-1 text-xs text-red" data-decide-audit-fallback>
          fell back to rule
        </div>
      )}
      <details className="mt-1" data-decide-audit-raw>
        <summary className="cursor-pointer text-xs text-mut" data-decide-audit-raw-toggle>
          raw request / reply
        </summary>
        <div className="mt-1 flex flex-col gap-1 font-mono text-xs text-mut">
          <div data-decide-audit-group-key>
            group key: {a.groupKey ?? "none"} · {a.replayable ? "replayable" : "not replayable"}
          </div>
          {a.promptText && (
            <pre className="whitespace-pre-wrap break-words" data-decide-audit-prompt>
              {a.promptText}
            </pre>
          )}
          {a.rawReply && (
            <div className="whitespace-pre-wrap break-words" data-decide-audit-reply>
              reply: {a.rawReply}
            </div>
          )}
          {media.length > 0 && <div data-decide-audit-media>media: {media.join(" ")}</div>}
        </div>
      </details>
    </li>
  );
}

/**
 * Customer Analysis section (ADAAAA-7737): a finished job's windows as time
 * ranges with a plain-language status. No filter chips (their values are the
 * internal `not_highlight` taxonomy), no search over decide text, no
 * select/enlarge frame controls, no filmstrip. The admin block below keeps all
 * of it on the same job id.
 *
 * ADAAAA-7838: the header row carries the owner's `See detail` toggle (default
 * OFF, floated right of the `Analysis` heading). OFF renders today's rows
 * untouched; ON turns each row into a collapsed section whose body is fetched
 * per window through the `Inspect` button (`inspections` is the page's cache).
 */
export function CustomerAnalysisSection({
  sections,
  capture,
  inspect = false,
  onToggleInspect,
  inspections = {},
  onInspect,
  jobId = "",
  token = null,
  onFrameClick,
  mergedGroups,
}: {
  sections: FrameSection[];
  capture?: LiveCapture;
  inspect?: boolean;
  onToggleInspect?: () => void;
  inspections?: Record<number, WindowInspectState>;
  onInspect?: (index: number) => void;
  jobId?: string;
  token?: string | null;
  onFrameClick?: (seq: number) => void;
  /** ADAAAA-7881: merged-moment groups, so the folded windows join visibly. */
  mergedGroups?: MergedMomentGroup[];
}) {
  // A job whose windows were decided but none confirmed still needs the cause
  // ABOVE the list — the board's share rendered 133 analysed windows and zero
  // highlights, which reads as "windows processed but nothing found" only if it
  // is said out loud.
  const noticeAbove = capture?.state === "capturing" || capture?.state === "no_highlights";
  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-analysis-header>
        <h3 className="text-2xl font-black">Analysis</h3>
        <span className="ml-auto">
          <SeeDetailToggle on={inspect} onToggle={onToggleInspect} />
        </span>
      </div>
      {noticeAbove && <CaptureNotice capture={capture} />}
      {sections.length === 0 ? (
        <div className="mt-3" data-analysis-empty>
          {/* ADAAAA-7750: the empty list gets a cause. A healthy share inside the
              first-window budget, a dead capture surface and a run whose windows
              were all judged "not a highlight" must never read the same. */}
          {!noticeAbove && <CaptureNotice capture={capture} />}
          <div className="text-mut">No analysis windows yet.</div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2" data-analysis-windows>
          <AnalysisWindowList
            sections={sections}
            groups={mergedGroups}
            renderWindow={(s) =>
              inspect ? (
                <CustomerInspectWindow
                  section={s}
                  jobId={jobId}
                  token={token}
                  inspection={inspections[s.index]}
                  onInspect={onInspect ?? (() => {})}
                  onFrameClick={onFrameClick}
                />
              ) : (
                <CustomerAnalysisWindow section={s} />
              )
            }
          />
        </div>
      )}
    </>
  );
}

/**
 * Full-screen Job detail (ADAAAA-6852 Inc 4). Route /app/jobs/:id. Covers the
 * start-new-job surface: header (job metadata), Highlights, and the 3
 * s-sectioned frame timeline with perceive overlays + decide notes. (The former
 * standalone Traces table was removed per ADAAAA-7236; the tracking decision
 * signal survives through track overlays in the frame debugger + highlight
 * notes.) Live-updates via /jobs/:id/events SSE (Inc 5) and tears the
 * subscription down on a terminal state so no SSE leaks after done/failed.
 */
export function JobDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // ADAAAA-7727: internal pipeline readouts (decide/candidates/Stage-A/cost)
  // render only for an admin session.
  const admin = useIsAdmin();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [loading, setLoading] = useState(true);
  // ADAAAA-7838: owner-facing window inspection. OFF (the customer default) is
  // the shipped surface: rows are time range + plain status, and the page's own
  // asks carry NO `inspect=1`, so the payload ships no per-window internals. ON
  // adds `?inspect=1` to the detail fetch + the delta poll and turns each row
  // into a collapsed section that loads exactly ONE window on its `Inspect`
  // click. Admin keeps today's full panel, so the toggle defaults ON there.
  // `windowInspectRef` is the session cache (one request per window, cleared
  // when the toggle goes off so a re-toggle cannot balloon memory).
  const [inspect, setInspectState] = useState<boolean>(admin);
  // ADAAAA-7929: `Cost & time` starts CLOSED (the panel fetches on open, never
  // on page load), and it only ever exists on the admin surface.
  const [costTimeOpen, setCostTimeOpen] = useState(false);
  const inspectTouchedRef = useRef(false);
  const [inspections, setInspections] = useState<Record<number, WindowInspectState>>({});
  const windowInspectRef = useRef(createWindowInspectStore(id, fetchSectionInspect));
  // Which review action is in-flight for which highlight id (per-control loading).
  const [pendingReview, setPendingReview] = useState<{ id: string; status: "accepted" | "rejected" } | null>(null);
  // ADAAAA-7915 (increment 3): the RAW audit rows of this job (GET /jobs/:id,
  // owner-or-admin scoped). `detail.highlights` is the POSTABLE projection and
  // drops every rejected row, so a rejected clip had no surface to render on and
  // "Undo reject" was unreachable. `rawHighlights` is the source of the hidden
  // clip strip below the accepted grid; it is a read-only fetch, survives a
  // reload (the initial load re-reads it) and carries no operator internals.
  const [rawHighlights, setRawHighlights] = useState<JobDetailHighlight[]>([]);
  // ADAAAA-7622: posting workflow. Captions are page-owned so an inline edit
  // survives the 5 s detail poll (which replaces `detail`) and is what the
  // batch export ships; the batch selection covers the accepted feed only, so
  // the export mirrors the postable list rather than raw candidates.
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchState, setBatchState] = useState<{ kind: "idle" | "working" | "done" | "error"; message: string }>({
    kind: "idle",
    message: "",
  });
  // ADAAAA-7045 (Inc 2, follow-up to ADAAAA-7039): durable decide_audit rows for
  // this job (one per frame group), surfaced as the "Decide LLM audit" section.
  // Best-effort: a failed fetch just leaves the section empty.
  const [audits, setAudits] = useState<DecideAuditRecord[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  // Guards against overlapping detail fetches: the 5s poll and the SSE-debounced
  // refresh (and a user review re-fetch) can race, so `load` no-ops while a
  // request is already in flight. This prevents request stacking + out-of-order
  // detail overwrites and keeps the interval from piling up on a slow backend.
  const loadInFlightRef = useRef(false);
  // ADAAAA-7742: incremental section streaming. `lastSectionIndexRef` is the
  // highest 3 s bucket already merged into `detail`, `deltaAfterRef` is the
  // lowest `afterIndex` a queued event asked for (a decide note attaches to the
  // bucket that holds its trigger timestamp, which can trail the newest bucket),
  // and `lastEventAtRef` tells the reconciling poll whether the SSE channel is
  // still live. `lastDeltaAtRef` enforces the DELTA_MIN_INTERVAL_MS floor.
  const lastSectionIndexRef = useRef(-1);
  const deltaAfterRef = useRef<number | null>(null);
  const deltaInFlightRef = useRef(false);
  const lastDeltaAtRef = useRef(0);
  const lastEventAtRef = useRef(0);
  const token = getToken();

  // ADAAAA-7838: an admin session keeps today's full Analysis panel, so the
  // `See detail` toggle defaults ON for admin — but only until the admin
  // touches it themselves (their choice wins from then on).
  useEffect(() => {
    if (!inspectTouchedRef.current) setInspectState(admin);
  }, [admin]);

  // ADAAAA-7838: the per-window cache is per job. A different job id gets a
  // fresh store and no stale inspected windows.
  useEffect(() => {
    windowInspectRef.current = createWindowInspectStore(id, fetchSectionInspect);
    setInspections({});
  }, [id]);

  // ADAAAA-7045: re-fetch the decide_audit rows so an in-flight job shows them
  // grow as each frame group is decided, and a just-completed job shows all of
  // them on the next refresh. Best-effort (leaves the section empty on failure).
  const loadAudits = useCallback(async () => {
    try {
      const r = await api<{ audits: DecideAuditRecord[] }>(`/jobs/${id}/decide-audit`);
      if (aliveRef.current) setAudits(r.audits ?? []);
    } catch {
      /* best-effort */
    }
  }, [id]);

  // ADAAAA-7915 (increment 3): re-read the RAW rows so a rejected clip — which
  // the postable detail payload never carries — is still on the page. This is
  // the reload-durable half of the restore path: a freshly loaded page calls it,
  // and the 5 s reconciling poll keeps it honest. Best-effort: a failed read
  // keeps the last known rows instead of blanking the strip.
  const loadRawHighlights = useCallback(async () => {
    try {
      const rows = await fetchJobHighlights(id);
      if (aliveRef.current) setRawHighlights(rows);
    } catch {
      /* best-effort: keep the rows already rendered */
    }
  }, [id]);

  const load = useCallback(
    async (initial = false) => {
      if (loadInFlightRef.current) return;
      loadInFlightRef.current = true;
      try {
        const d = await fetchJobDetail(id, { inspect });
        if (!aliveRef.current) return;
        setDetail(d);
        // ADAAAA-7915: the hidden clip strip reads the raw audit rows, not the
        // postable projection, so a rejected clip survives a reload.
        loadRawHighlights();
        // ADAAAA-7742: record how far the composite payload reaches so the live
        // delta path knows which bucket to continue after.
        lastSectionIndexRef.current = d.sections.length ? d.sections[d.sections.length - 1].index : -1;
        setError(null);
        // Refresh the durable decide-audit rows alongside the detail payload.
        // ADAAAA-7727: the audit rows are admin-only, so a customer session
        // never fetches them.
        if (admin) loadAudits();
        if (!isJobInFlight(d.job?.status)) setTerminal(true);
        else setTerminal(false);
      } catch (e: any) {
        if (!aliveRef.current) return;
        if (initial) setLoading(false);
        if (e?.status === 404) setError("Job not found — it may have been deleted.");
        else if (e?.status === 403) setError("You do not have access to this job.");
        else setError(e?.message || String(e));
      } finally {
        loadInFlightRef.current = false;
        if (aliveRef.current && initial) setLoading(false);
      }
    },
    [id, admin, inspect, loadRawHighlights]
  );

  // ADAAAA-7741: the customer's processing-lag chip gets its own 5 s refresh,
  // on the LIGHT job payload (GET /jobs/:id — ~7 KB of job metadata).
  //
  // The composite detail fetch rebuilds every frame section and can outlast the
  // 5 s poll, and a single slow request holds `loadInFlightRef` so every tick
  // after it is dropped — which left the chip showing one stale lag number for
  // tens of seconds. This poll only refreshes the projection, so the number (and
  // the skipped-window count) moves every poll cycle while the job is live. The
  // composite refresh and the SSE-driven deltas keep feeding it too: the effect
  // below always keeps the NEWER of the two readings.
  const [liveProgress, setLiveProgress] = useState<LiveProgress | undefined>();
  // ADAAAA-7759: health of that light read. A failed read keeps the last honest
  // number (by design), but the chip must say when the reading has gone stale —
  // QA saw one source of failed reads hold a 36 s number for ~21 s while the
  // pipeline kept moving, which reads as a silent freeze. `staleSec` is folded
  // from every light-read outcome; the banner below appears once the failure is
  // persistent (3 consecutive misses = 15 s).
  const [lightHealth, setLightHealth] = useState<LiveReadHealth>(LIVE_READ_HEALTH_FRESH);
  // ADAAAA-7907 (Inc 3): the Resume action on the FAILED state. The POST only
  // re-arms the durable worker (202 / 200 alreadyQueued), so the page reports
  // "queued" and re-reads the job — the pass then resumes server-side.
  const [resumeState, setResumeState] = useState<ResumeActionState>({ kind: "idle" });
  const resumeJob = useCallback(async () => {
    if (!id) return;
    setResumeState({ kind: "working" });
    try {
      const r = await api<{ alreadyQueued?: boolean }>(`/jobs/${id}/resume`, { method: "POST" });
      // Idempotent answer: a retry was already armed, so nothing changed — show
      // the button in its resting state rather than a second "queued" note.
      setResumeState(r?.alreadyQueued ? { kind: "idle" } : { kind: "queued" });
      // The row is non-terminal again: keep the poll/SSE channel alive.
      setTerminal(false);
      await load(false);
    } catch (e: any) {
      const message =
        e?.status === 403
          ? "You do not have access to resume this job."
          : e?.status === 409
            ? e?.message || "This job cannot be resumed."
            : e?.message || String(e);
      setResumeState({ kind: "error", message });
    }
  }, [id, load]);
  useEffect(() => {
    const lp = detail?.liveProgress;
    if (!lp) return;
    setLiveProgress((cur: LiveProgress | undefined) =>
      !cur || Date.parse(lp.updatedAt) >= Date.parse(cur.updatedAt) ? lp : cur,
    );
  }, [detail]);
  useEffect(() => {
    if (terminal || !id) return;
    const poll = startDetailPoll({
      shouldContinue: () => aliveRef.current,
      onTick: () => {
        api<{ liveProgress?: LiveProgress }>(`/jobs/${id}`)
          .then((r) => {
            if (!aliveRef.current) return;
            setLightHealth((h: LiveReadHealth) => nextLiveReadHealth(h, { ok: true, at: Date.now() }));
            if (r?.liveProgress) setLiveProgress(r.liveProgress);
          })
          // Best-effort: a failed light read keeps the last honest reading, and
          // ADAAAA-7759 makes that failure stated (stale chip + banner) rather
          // than silent. A 400 here is an edge/client rejection (the route
          // itself has no 400 path), so it is reported with its HTTP status.
          .catch((e: any) => {
            if (!aliveRef.current) return;
            const reason = e?.status ? `HTTP ${e.status}` : String(e?.message || "network error");
            setLightHealth((h: LiveReadHealth) =>
              nextLiveReadHealth(h, { ok: false, at: Date.now(), error: reason }),
            );
          });
      },
    });
    return () => poll.stop();
  }, [terminal, id]);

  // ADAAAA-7742: merge one sections-delta into the open view. New buckets are
  // appended, a re-sent tail bucket replaces its stale copy (so a decide note
  // that landed into it shows), and the small companions the same page renders
  // (job status/summary, postable highlights, ladder) are refreshed from the
  // same response — the accumulated composite payload is never re-sent.
  const mergeDelta = useCallback((d: SectionsDelta) => {
    setDetail((prev: JobDetail | null) => {
      if (!prev) return prev;
      return {
        ...prev,
        job: d.job ?? prev.job,
        highlights: d.highlights ?? prev.highlights,
        notableHighlights: d.notableHighlights ?? prev.notableHighlights,
        duplicateHighlights: d.duplicateHighlights ?? prev.duplicateHighlights,
        maxTraces: d.maxTraces ?? prev.maxTraces,
        summaryLadder: d.summaryLadder ?? prev.summaryLadder,
        sections: mergeSections(prev.sections, d.sections),
      };
    });
    lastSectionIndexRef.current = Math.max(lastSectionIndexRef.current, d.maxIndex);
    const status = d.job?.status;
    if (!status || isJobInFlight(status)) setTerminal(false);
    else setTerminal(true);
  }, []);

  // ADAAAA-7742: fetch the windows this page does not hold yet. The newest
  // known bucket is always re-requested (afterIndex = last - 1) so a decide note
  // persisted into it is picked up, and an event that named an earlier bucket
  // (a note whose trigger trails the newest bucket) widens that further.
  const loadDelta = useCallback(async () => {
    if (deltaInFlightRef.current) return;
    // Respect the floor even when the call comes from the idle trigger (the
    // debounced path already waits it out); the queued afterIndex survives so the
    // next tick still fetches from the right bucket.
    if (Date.now() - lastDeltaAtRef.current < DELTA_MIN_INTERVAL_MS) return;
    const last = lastSectionIndexRef.current;
    if (last < 0) return; // no baseline yet — the initial full load owns it
    const tail = Math.max(-1, last - 1);
    const queued = deltaAfterRef.current;
    const after = queued === null ? tail : Math.min(tail, queued);
    deltaAfterRef.current = null;
    deltaInFlightRef.current = true;
    lastDeltaAtRef.current = Date.now();
    try {
      const d = await fetchSectionsDelta(id, after, { inspect });
      if (!aliveRef.current) return;
      mergeDelta(d);
      // A window that produced a decided frame group also produced a decide
      // audit row; refresh the (admin-only) audit list only when something
      // actually changed.
      if (admin && d.sections.length) loadAudits();
    } catch {
      // A failed delta must never stall the page: fall back to the composite
      // fetch, which is also the recovery path after a dropped SSE socket.
      if (aliveRef.current) await load(false);
    } finally {
      deltaInFlightRef.current = false;
    }
  }, [id, admin, inspect, load, mergeDelta, loadAudits]);

  // Debounced + throttled incremental refresh on SSE activity: keeps a window's
  // section on screen within ~2 s of its decide note landing, at a bounded
  // request rate instead of one heavy composite fetch per event.
  const scheduleRefresh = useCallback(
    (afterIndex?: number) => {
      if (typeof afterIndex === "number") {
        deltaAfterRef.current = deltaAfterRef.current === null ? afterIndex : Math.min(deltaAfterRef.current, afterIndex);
      }
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      const wait = Math.max(300, DELTA_MIN_INTERVAL_MS - (Date.now() - lastDeltaAtRef.current));
      refreshTimer.current = setTimeout(() => {
        if (aliveRef.current) loadDelta();
      }, wait);
    },
    [loadDelta]
  );

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    load(true);
    return () => {
      aliveRef.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [load]);

  // Live updates (Inc 5): subscribe to /jobs/:id/events and stream the new
  // analysis windows in (ADAAAA-7742), then tear the subscription down once the
  // job is terminal.
  useEffect(() => {
    if (terminal || !id) return;
    const ac = new AbortController();
    readSSE(`/jobs/${id}/events`, token, (name: string, data: any) => {
      lastEventAtRef.current = Date.now();
      if (!REFRESH_EVENTS.includes(name)) return;
      const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
      if (name === "observation") {
        // A frame inside a bucket we already render cannot change the partition,
        // so only a bucket boundary is worth a request.
        if (ts === null || ts < 0) return;
        const idx = Math.floor(ts / SECTION_WINDOW_S);
        if (idx > lastSectionIndexRef.current) scheduleRefresh(Math.max(-1, idx - 1));
        return;
      }
      // A decide note / highlight attaches to the bucket that holds its trigger
      // timestamp, which can trail the newest bucket — ask from that bucket so
      // the note lands as soon as it is persisted.
      if (ts !== null && ts >= 0) scheduleRefresh(Math.max(-1, Math.floor(ts / SECTION_WINDOW_S) - 1));
      else scheduleRefresh();
    }, ac.signal).catch(() => {});
    return () => {
      ac.abort();
    };
  }, [id, token, terminal, scheduleRefresh]);

  // Realtime reconciling poll (ADAAAA-6984, AC-1/AC-2/AC-3/AC-5/AC-7). While the
  // job is still in flight, re-fetch its detail every VOD_DETAIL_POLL_MS (5 s)
  // to update status/progress/highlights in place — no full reload. The
  // SSE channel above remains the fast path; this interval guarantees a server
  // status transition shows within one poll cycle even if an SSE event is
  // missed or the socket drops. One timer per open detail view: it is torn down
  // on unmount/close (cleanup) and on a terminal state (the effect re-runs with
  // `terminal` true and returns early), so no interval leaks and no post-close
  // polls run (AC-2). `load` keeps the current view on a transient failure and
  // the next tick retries (AC-6); a terminal state fetched after errors still
  // renders and stops the poll (AC-3).
  useEffect(() => {
    if (terminal || !id) return;
    const poll = startDetailPoll({
      // Keep polling only while mounted and still in flight. The effect also
      // re-runs (and clears the timer) on `terminal`, so a done/failed job stops
      // polling at the next reconciliation.
      shouldContinue: () => aliveRef.current,
      // ADAAAA-7742: the SSE channel now carries the window/section deltas, so
      // the composite re-fetch is the RECOVERY net — it only runs when the
      // channel has been silent for SSE_QUIET_MS (a dropped socket or a missed
      // event). That is what keeps a long live job from re-downloading the whole
      // accumulated payload every 5 s.
      onTick: () => {
        if (Date.now() - lastEventAtRef.current < SSE_QUIET_MS) return;
        load(false);
      },
    });
    return () => poll.stop();
  }, [terminal, id, load]);

  // ADAAAA-7742: idle trigger for the incremental path. The SSE channel is the
  // fast path, but its event cadence follows the sampled frame rate; when the box
  // is contended that drops below one event per second and a freshly persisted
  // window would sit unfetched (measured 4 s). While the channel is believed
  // live, reconcile the delta on a 1 s silence so a new window still renders
  // within 2 s. When the channel goes quiet for SSE_QUIET_MS the composite
  // recovery poll above takes over instead.
  useEffect(() => {
    if (terminal || !id) return;
    const timer = setInterval(() => {
      if (!aliveRef.current) return;
      const quietMs = Date.now() - lastEventAtRef.current;
      if (quietMs < DELTA_IDLE_MS || quietMs > SSE_QUIET_MS) return;
      loadDelta();
    }, 500);
    return () => clearInterval(timer);
  }, [terminal, id, loadDelta]);

  // ADAAAA-7623: detail-on-demand hop from a ladder window narrative into the
  // Analysis window that covers the same instant (same 3 s bucket, so it holds
  // that window's frames + decide-note audit). Client-only DOM scroll; the
  // window opens on its own toggle as it always has.
  const jumpToAnalysisWindow = useCallback((sectionIndex: number) => {
    if (typeof document === "undefined") return;
    focusAnalysisWindow(document, sectionIndex);
  }, []);

  // Aligned requirement: no duplicate frame across sections. Re-assert the
  // server partition on every render so a bug can never show a frame twice.
  const partition = useMemo(() => (detail ? assertFramePartition(detail.sections) : null), [detail]);
  const frameCount = useMemo(() => (detail ? detail.sections.reduce((n, s) => n + s.frames.length, 0) : 0), [detail]);
  // ADAAAA-7854: the accepted count comes from the server-derived dedupe
  // (`job.postableHighlights` on the composite detail payload), the SAME value
  // the Highlights-page tile reads from GET /jobs. `detail.highlights` is already
  // the postable list, so the fallback cannot inflate the count either.
  const acceptedCount = useMemo(
    () => (detail ? (detail.job.postableHighlights ?? detail.highlights.length) : 0),
    [detail]
  );
  // ADAAAA-7622: the postable list is the accepted feed (rejected clips are
  // excluded server-side semantics too) — batch export only ever covers this.
  const postableHighlights = useMemo(
    () => (detail ? detail.highlights.filter((h) => h.status !== "rejected") : []),
    [detail]
  );
  // ADAAAA-7915 (increment 3): the clips the viewer rejected. `detail.highlights`
  // can never hold one (the postable projection drops them), so the strip reads
  // the raw audit rows and excludes anything the accepted feed already shows.
  const hiddenHighlights = useMemo(
    () => rejectedStripRows(rawHighlights, detail?.highlights),
    [rawHighlights, detail]
  );
  const selectedHighlights = useMemo(
    () => postableHighlights.filter((h) => selectedIds.includes(h.id)),
    [postableHighlights, selectedIds]
  );
  const captionOf = useCallback(
    (h: JobDetailHighlight) => captions[h.id] ?? suggestCaption(h, detail?.job.summaryLog),
    [captions, detail]
  );
  // ADAAAA-7881: merged-moment groups for the Analysis window list — derived
  // client-side from the payload this page already holds (no extra request).
  const mergedGroups = useMemo(
    () => mergedMomentGroups(detail?.highlights, detail?.duplicateHighlights, detail?.sections),
    [detail]
  );
  const title = useMemo(() => (detail ? jobTitle(detail.job, acceptedCount) : ""), [detail, acceptedCount]);
  // ADAAAA-7759: the stated-failure banner for a persistent failed lag read.
  const lagFailureNotice = liveProgressFailureNotice(lightHealth);

  // ADAAAA-6943/6946: click-to-enlarge + multi-select enlarge. `framesBySeq`
  // maps a frame seq to its full frame for the enlarged lightbox; `gallery` is
  // the ordered set of seqs currently enlarged (single = [seq], multi = ordered
  // selected set through the filmstrip order helper).
  const framesBySeq = useMemo(() => {
    const m = new Map<number, JobDetailFrame>();
    detail?.sections.forEach((s) => s.frames.forEach((f) => m.set(f.seq, f)));
    return m;
  }, [detail]);
  const selectableSeqs = useMemo(() => (detail ? collectFrameSeqs(detail.sections) : []), [detail]);

  const [selectMode, setSelectMode] = useState(false);
  const [multiSeqs, setMultiSeqs] = useState<number[]>([]);
  const [gallery, setGallery] = useState<number[] | null>(null);
  const [galIndex, setGalIndex] = useState(0);

  // ADAAAA-7274: Analysis section filter (by window type) + text search. An
  // empty `analysisFilter` means "all types"; the two controls combine so the
  // visible window list is the intersection of both.
  const [analysisFilter, setAnalysisFilter] = useState<NoteKind[]>([]);
  const [analysisQuery, setAnalysisQuery] = useState("");
  const visibleSections = useMemo(
    () => (detail ? detail.sections.filter((s) => sectionMatches(s, analysisFilter, analysisQuery)) : []),
    [detail, analysisFilter, analysisQuery]
  );

  function toggleKind(kind: NoteKind) {
    setAnalysisFilter((cur) => (cur.includes(kind) ? cur.filter((k) => k !== kind) : [...cur, kind]));
  }

  // ADAAAA-7838: `See detail` toggle. Flipping it changes the page's OWN reads
  // (`load` and `loadDelta` depend on `inspect`), so turning it on starts
  // requesting `?inspect=1` and turning it off makes the next poll omit it.
  // OFF also parks the per-window cache: the session never keeps inspected
  // windows around after the owner closed the door.
  function toggleInspect() {
    inspectTouchedRef.current = true;
    setInspectState((cur) => {
      const next = !cur;
      if (!next) {
        windowInspectRef.current.clear();
        setInspections({});
      }
      return next;
    });
  }

  // ADAAAA-7838: load exactly ONE window's inspection detail (the row's
  // `Inspect` button). The store serves a cached window without a request and
  // joins an in-flight one, so a double click can never stack requests.
  const inspectWindow = useCallback(
    async (index: number) => {
      if (inspections[index]?.status === "loaded") return;
      setInspections((m) => ({ ...m, [index]: { status: "loading" } }));
      try {
        const data = await windowInspectRef.current.load(index);
        if (!aliveRef.current) return;
        setInspections((m) => ({ ...m, [index]: { status: "loaded", data } }));
      } catch (e: any) {
        if (!aliveRef.current) return;
        setInspections((m) => ({
          ...m,
          [index]: { status: "error", error: String(e?.message || e) },
        }));
      }
    },
    [inspections]
  );

  function openSingle(seq: number) {
    setGallery([seq]);
    setGalIndex(0);
  }
  function openMulti() {
    const ordered = orderGallerySeqs(selectableSeqs, multiSeqs);
    if (ordered.length === 0) return;
    setGallery(ordered);
    setGalIndex(0);
    setSelectMode(false);
    setMultiSeqs([]);
  }
  function toggleSelectMode() {
    setSelectMode((v) => !v);
    setMultiSeqs([]);
  }
  function toggleMulti(seq: number) {
    setMultiSeqs((prev) => (prev.includes(seq) ? prev.filter((s) => s !== seq) : [...prev, seq]));
  }
  function onFrameClick(seq: number) {
    if (selectMode) toggleMulti(seq);
    else openSingle(seq);
  }
  function shiftGallery(dir: number) {
    if (!gallery || gallery.length <= 1) return;
    const next = (galIndex + dir + gallery.length) % gallery.length;
    setGalIndex(next);
  }

  async function trackBox(frame: JobDetailFrame, t: NonNullable<JobDetailFrame["tracks"]>[number]) {
    try {
      await api(`/jobs/${id}/control`, {
        body: { type: "track", args: { bbox: t.bbox, label: t.label?.trim() || t.kind, slot: t.slot } },
      });
    } catch (e: any) {
      setError(`find-and-track: ${String(e?.message || e)}`);
    }
  }

  async function review(h: JobDetailHighlight, status: "accepted" | "rejected") {
    // Guard against double-submit while a review is already in-flight for this card.
    if (pendingReview) return;
    setPendingReview({ id: h.id, status });
    try {
      await api(`/highlights/${h.id}/review`, { body: { status } });
      // Reflect the review in the detail's highlight list without a full reload.
      // A rejected highlight flips to `rejected` and leaves the accepted feed on
      // the next render (see the accepted/rejected split below); an accepted
      // highlight moves into the accepted feed.
      setDetail((d) =>
        d
          ? {
              ...d,
              highlights: d.highlights.map((x) => (x.id === h.id ? { ...x, status } : x)),
            }
          : d
      );
      // ADAAAA-7915: the raw-row cache moves on the same tick, so the hidden
      // clip strip lists the clip within 1 s of the reject (and drops it on
      // undo) even before the authoritative re-read below lands.
      setRawHighlights((rows) => applyReviewToRawRows(rows, h, status));
      // Re-fetch the authoritative payload so the server-persisted status wins
      // over any concurrent SSE-triggered refresh that could have read a stale
      // pre-review snapshot — this is what makes the reject/accept state change
      // stick and never appear to "do nothing".
      try {
        const fresh = await fetchJobDetail(id, { inspect });
        if (aliveRef.current) {
          setDetail(fresh);
          setError(null);
        }
      } catch {
        /* keep the optimistic local update; the next refresh reconciles */
      }
      // ADAAAA-7915: reconcile the raw rows too — the strip must stop listing a
      // restored clip (and a rejected clip must appear) from server truth.
      loadRawHighlights();
    } catch (e: any) {
      // Surface validation/API failures explicitly — no silent no-op.
      setError(e?.message || String(e));
    } finally {
      if (aliveRef.current) setPendingReview(null);
    }
  }

  function toggleSelectHighlight(h: JobDetailHighlight) {
    setSelectedIds((prev) => (prev.includes(h.id) ? prev.filter((x) => x !== h.id) : [...prev, h.id]));
  }

  function setHighlightCaption(h: JobDetailHighlight, value: string) {
    setCaptions((prev) => ({ ...prev, [h.id]: value }));
  }

  /**
   * Batch export (ADAAAA-7622): N selected highlights -> ONE .zip containing
   * every clip plus `captions.txt`, so a 5-clip social batch needs no DevTools
   * and no per-clip download loop. A clip whose bytes cannot be fetched still
   * contributes its caption + public URL to the manifest, so the export is
   * never silently short: the user gets a usable URL for it either way.
   */
  async function exportBatch() {
    if (selectedHighlights.length === 0 || batchState.kind === "working") return;
    const jobId = detail?.job.id || id;
    setBatchState({ kind: "working", message: `Preparing ${selectedHighlights.length} clip(s)…` });
    const files: ZipFile[] = [];
    const items: BatchItem[] = [];
    // ADAAAA-7896: ONE bounded intent call marks the whole selection as
    // `batch_zip` before any fetch, so every archived clip is stamped even
    // though the individual fetches carry no per-clip via. Best-effort: a
    // failed intent must not cost the user their archive.
    try {
      await markExportIntentBatch(
        (p, body) => api(p, { body }),
        selectedHighlights.map((h) => h.id),
        "batch_zip"
      );
    } catch {
      /* the zip still ships; the fetch path re-attempts the same marking */
    }
    for (const h of selectedHighlights) {
      const url = exportUrl(h);
      const caption = captionOf(h);
      let failure: string | undefined;
      if (!h.clipUri) {
        failure = "no clip was produced for this highlight";
      } else {
        try {
          const res = await fetch(url);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.length === 0) throw new Error("empty clip file");
          files.push({ name: clipFileName(h), data: bytes });
        } catch (e: any) {
          failure = String(e?.message || e);
        }
      }
      items.push({ caption, url, error: failure });
    }
    // Always ship the manifest: it is the deliverable when a fetch failed and
    // the posting sheet when every clip made it into the archive.
    files.push({ name: "captions.txt", data: new TextEncoder().encode(batchManifest(items)) });
    const clipCount = files.length - 1;
    saveBlob(buildZip(files), `highlights-${jobId}-${clipCount}clips.zip`);
    const failed = items.filter((i) => i.error).length;
    setBatchState({
      kind: failed ? "error" : "done",
      message: failed
        ? `${clipCount} clip(s) + captions.txt downloaded — ${failed} clip(s) could not be fetched, their URL is in captions.txt`
        : `${clipCount} clip(s) + captions.txt downloaded`,
    });
  }

  /** Copy the batch manifest (captions + public URLs) to the clipboard. */
  async function copyBatchManifest() {
    if (selectedHighlights.length === 0) return;
    // ADAAAA-7896: the manifest carries the EXPORT URLs, and one bounded batch
    // intent marks all of them `copy_urls` — but only once the clipboard write
    // actually succeeded (a failed copy shares nothing).
    const items: BatchItem[] = selectedHighlights.map((h) => ({ caption: captionOf(h), url: exportUrl(h) }));
    const ok = await copyText(batchManifest(items));
    if (ok) {
      try {
        await markExportIntentBatch(
          (p, body) => api(p, { body }),
          selectedHighlights.map((h) => h.id),
          "copy_urls"
        );
      } catch {
        /* the copy succeeded; marking is audited but not user-visible */
      }
    }
    setBatchState({
      kind: ok ? "done" : "error",
      message: ok
        ? `${selectedHighlights.length} caption(s) + URL(s) copied`
        : "clipboard write failed — use Download .zip instead",
    });
  }

  // Streamed acceptance state → the task must not be left as `loading` forever.
  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-mut">
        <Loader2 className="h-5 w-5 animate-spin" /> Loading job…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl" data-job-detail>
      <div className="mb-4 flex items-center gap-3">
        <button
          type="button"
          className="chip flex items-center gap-1"
          onClick={() => navigate("/app")}
          data-detail-back
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>
        <Link to="/app" className="text-xs text-mut">
          All jobs
        </Link>
        {detail && (
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChip(detail.job.status)}`}>
            {detail.job.status}
          </span>
        )}
      </div>

      {error && <div className="mb-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}

      {!detail ? (
        <div className="text-mut">Nothing to show.</div>
      ) : (
        <>
          {/* Header: job metadata */}
          <div className="card card-accent p-5">
            <div className="flex flex-wrap items-center gap-3" data-detail-title>
              <h2 className="text-xl font-black text-ink">{title}</h2>
              <span className="font-mono text-sm text-mut">{detail.job.id.slice(0, 8)}</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChip(detail.job.status)}`}>
                {detail.job.status}
              </span>
              {/* ADAAAA-7741: how far behind live the newest decided window is,
                  refreshed by its own 5 s light job poll (see the poll effect).
                  In-flight only — a terminal job's completion state is the status
                  chip above, so a frozen lag number is never left on screen. */}
              {isJobInFlight(detail.job.status) && (
                <LiveProgressChip progress={liveProgress} staleSec={lightHealth.staleSec} />
              )}
              {/* ADAAAA-7700: WHY the job failed, as its own attributed chip. */}
              <FailureReasonChip reason={detail.job.failureReason} />
              {/* ADAAAA-7907 (AC8): "resumed from T+12:30 · attempt 2 of 3" on a
                  retried pass, and the Resume action on the failed state. The
                  action is only offered where the route accepts it (VOD file
                  job, failed, checkpoint present). */}
              <ResumeTrail resume={detail.job.resume} />
              <ResumeAction job={detail.job} state={resumeState} onResume={resumeJob} />
            </div>
            {/* ADAAAA-7759: once the light lag read has failed 3 consecutive
                times (15 s) the failure is stated on the same banner pattern as
                the rest of the page, so a stale chip never reads as a live one
                while the pipeline keeps moving. Cleared by the next good read. */}
            {isJobInFlight(detail.job.status) && lagFailureNotice && (
              <div
                className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red"
                data-live-progress-error
              >
                {lagFailureNotice}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              {/* ADAAAA-7727: Source/Game/Frames are customer-facing; the
                  decide/candidates/Stage-A/cost/partition readouts inside the
                  component are internal diagnostics — admin only. */}
              <JobDetailMetrics job={detail.job} frameCount={frameCount} partition={partition} admin={admin} />
            </div>
            {/* ADAAAA-7623: the summary ladder — match rollup + chapters over
                the stored summary log, above the flat log itself. Absent on
                legacy jobs (component renders nothing). */}
            <SummaryLadderView ladder={detail.summaryLadder} onJump={admin ? jumpToAnalysisWindow : undefined} />
            {/* ADAAAA-7466: the append-only per-pass summary time log, shown as
                a collapsible "Video Summary" section (collapsed by default).
                Replaces the removed running action notes. */}
            <VideoSummary
              entries={detail.job.summaryLog}
              highlights={detail.highlights}
              fastRail={detail.job.source !== "file"}
            />
            {detail.job.error && (
              <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-detail-error>
                {detail.job.error}
              </div>
            )}
          </div>

          {/* Highlights — accepted feed. Rejected clips move out of this feed
              into the Rejected presentation below (recoverable via Accept). */}
          <h3 className="mt-8 text-2xl font-black">Highlights</h3>
          {/* ADAAAA-7622: batch export bar. Selection + export live on the
              accepted feed so a 5-clip social batch is one action: tick the
              clips, Download .zip (clips + captions.txt) or Copy URLs. */}
          {postableHighlights.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-purple/40 bg-mut/10 px-3 py-2" data-detail-batch>
              <span className="text-xs font-bold text-mut" data-detail-batch-count>
                {selectedHighlights.length} of {postableHighlights.length} selected
              </span>
              <button
                className="btn-neon px-2 py-1 text-xs"
                onClick={() => setSelectedIds(selectedHighlights.length === postableHighlights.length ? [] : postableHighlights.map((h) => h.id))}
                data-detail-batch-toggle-all
              >
                {selectedHighlights.length === postableHighlights.length ? "Clear" : "Select all"}
              </button>
              <button
                className="btn-neon btn-purple px-2 py-1 text-xs"
                onClick={exportBatch}
                disabled={selectedHighlights.length === 0 || batchState.kind === "working"}
                data-detail-batch-export
              >
                {batchState.kind === "working" ? (
                  <Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : (
                  <Download className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                )}
                {batchState.kind === "working" ? "Preparing…" : `Download .zip (${selectedHighlights.length})`}
              </button>
              <button
                className="btn-neon px-2 py-1 text-xs"
                onClick={copyBatchManifest}
                disabled={selectedHighlights.length === 0}
                data-detail-batch-copy
              >
                <Link2 className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Copy URLs
              </button>
              {batchState.message && (
                <span
                  className={`text-xs ${batchState.kind === "error" ? "text-yellow" : "text-mut"}`}
                  data-detail-batch-status
                  data-batch-kind={batchState.kind}
                >
                  {batchState.message}
                </span>
              )}
            </div>
          )}
          <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {detail.highlights.filter((h) => h.status !== "rejected").length === 0 && (
              <div className="text-mut" data-detail-no-highlights>No accepted highlights for this job.</div>
            )}
            {detail.highlights
              .filter((h) => h.status !== "rejected")
              .map((h) => (
                <HighlightCard
                  key={h.id}
                  highlight={h}
                  onDecision={review}
                  pendingStatus={pendingReview?.id === h.id ? pendingReview.status : null}
                  caption={captionOf(h)}
                  onCaptionChange={setHighlightCaption}
                  summaryLog={detail.job.summaryLog}
                  selectable
                  selected={selectedIds.includes(h.id)}
                  onToggleSelect={toggleSelectHighlight}
                  admin={admin}
                />
              ))}
          </div>

          {/* ADAAAA-7621: the two lanes the dedupe/precision gate moved out of
              the postable gallery. Merged clips are listed once here (their
              footage lives in the moment they were folded into) and notable
              non-scoring clips are visible but never presented as goals. */}
          <SecondaryHighlightLane
            lane="merged"
            title="Merged into a highlight"
            note="Overlapping clips folded into the moment above so the same footage is not posted twice."
            highlights={detail.duplicateHighlights ?? []}
            admin={admin}
          />
          <SecondaryHighlightLane
            lane="notable"
            title="Notable — not a goal"
            note="Non-scoring plays (near miss / big play). They stay off the postable goal list."
            tone="yellow"
            highlights={detail.notableHighlights ?? []}
            admin={admin}
          />

          {/* ADAAAA-7915 (increment 3): the clips this viewer rejected stay on
              the page here, so slot 3 can undo the reject. `detail.highlights`
              is the POSTABLE projection and never carries a rejected row; these
              come from the raw audit rows on GET /jobs/:id, so the strip is
              reload-durable. Copy is plain customer prose — no decide outcome
              code, no score, no reason, no bare status token — and the section
              renders for both roles (a customer must be able to undo a
              misclick; an operator keeps the Pipeline detail inside each card). */}
          {hiddenHighlights.length > 0 && (
            <section className="mt-6" data-detail-hidden-strip>
              <h3 className="text-sm font-bold text-mut" data-detail-hidden-heading>
                Hidden from the public feed
              </h3>
              <div className="mt-1 text-xs text-mut">
                Undo reject puts a clip back in the feed within its recover window.
              </div>
              <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3" data-detail-hidden-grid>
                {hiddenHighlights.map((h) => (
                  <HighlightCard
                    key={h.id}
                    highlight={h}
                    onDecision={review}
                    pendingStatus={pendingReview?.id === h.id ? pendingReview.status : null}
                    caption={captionOf(h)}
                    onCaptionChange={setHighlightCaption}
                    summaryLog={detail.job.summaryLog}
                    admin={admin}
                  />
                ))}
              </div>
            </section>
          )}

          {/* Analysis timeline (ADAAAA-7274): the Frames detail section is
              renamed to Analysis — collapsible time windows (collapsed shows
              only the color-coded type summary), a sticky top bar (filter +
              search + select/enlarge), a type filter, and a text search. */}
          <div className="mt-8" data-analysis-section>
            {/* ADAAAA-7737: the operator Analysis (filter chips, search,
                select/enlarge, filmstrip, decide banners) is an admin surface.
                A customer session gets the time-range + plain-status projection
                of the same payload; the data itself is never trimmed. */}
            {admin ? (
              <>
            {/* ADAAAA-7619: `-top-8` is NOT a typo and must not be "cleaned up"
                back to `top-0`. The scroll container is Shell's
                `<main class="flex-1 overflow-y-auto p-8">`, so the scrollport
                is inset by p-8 (2rem) and a `top-0` sticky child parks 32px
                below the window top. `-top-8` cancels that padding so the bar
                sticks flush at the window top. The `-mx-8 px-8` bleed matches
                the same 2rem so the stuck bar spans the full content area
                edge-to-edge (no see-through strips beside it). */}
            <div className="sticky -top-8 z-20 -mx-8 border-b border-purple/30 bg-dusk/95 px-8 py-3 backdrop-blur" data-analysis-toolbar>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <h3 className="text-2xl font-black">Analysis</h3>
                <span className="text-xs text-mut">
                  {frameCount} frame(s) · {visibleSections.length} window(s) shown
                </span>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {/* ADAAAA-7929: the VOD cost & time breakdown, immediately
                      left of `See detail` and inside the `admin ?` branch only.
                      The owner-facing toolbar never mounts it (cost / decide /
                      perceive are admin-gated internals, ADAAAA-7727). */}
                  <CostTimeToggle
                    admin={admin}
                    on={costTimeOpen}
                    onToggle={() => setCostTimeOpen((v) => !v)}
                  />
                  {/* ADAAAA-7838: the same owner-facing toggle on the admin
                      surface; admin defaults ON so the full panel is unchanged,
                      and OFF falls back to the plain time-range/status rows. */}
                  <SeeDetailToggle on={inspect} onToggle={toggleInspect} />
                  {/* Filter by window type */}
                  <div className="flex items-center gap-1" data-analysis-filter>
                    {NOTE_KINDS.map((k) => {
                      const active = analysisFilter.includes(k);
                      return (
                        <button
                          key={k}
                          type="button"
                          onClick={() => toggleKind(k)}
                          data-analysis-filter-chip={k}
                          data-active={active ? "true" : undefined}
                          className={`rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                            active ? KIND_TONE[k] : "border-mut/30 text-mut hover:border-neon hover:text-neon"
                          }`}
                        >
                          {noteKindLabel(k)}
                        </button>
                      );
                    })}
                  </div>
                  {/* Search by summary/transcript text */}
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-mut" />
                    <input
                      value={analysisQuery}
                      onChange={(e) => setAnalysisQuery(e.target.value)}
                      placeholder="Search analysis…"
                      data-analysis-search
                      className="w-40 rounded border border-mut/30 bg-black/40 py-1 pl-7 pr-2 text-xs text-ink outline-none placeholder:text-mut/60 focus:border-neon"
                    />
                  </div>
                  {/* Existing select / enlarge controls (unchanged behavior) */}
                  <button
                    type="button"
                    data-select-mode={selectMode ? "true" : undefined}
                    onClick={toggleSelectMode}
                    className="rounded border border-mut/40 px-2 py-1 text-[11px] text-mut hover:border-neon hover:text-neon"
                  >
                    {selectMode ? "Cancel select" : "Select"}
                  </button>
                  {selectMode && (
                    <button
                      type="button"
                      data-enlarge-multi={multiSeqs.length >= 2 ? "true" : undefined}
                      disabled={multiSeqs.length < 2}
                      onClick={openMulti}
                      className="rounded border border-neon/60 px-2 py-1 text-[11px] text-neon disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Enlarge ({multiSeqs.length})
                    </button>
                  )}
                </div>
              </div>
            </div>
            {/* ADAAAA-7929: the breakdown panel sits BELOW the sticky toolbar
                (it is not part of the stuck row) and is admin-only. */}
            {costTimeOpen && (
              <CostTimePanel admin={admin} jobId={detail.job.id} onClose={() => setCostTimeOpen(false)} />
            )}
            {visibleSections.length === 0 ? (
              <div className="mt-3 text-mut" data-analysis-empty>No Analysis windows match.</div>
            ) : (
              <div className="mt-3 flex flex-col gap-3" data-analysis-windows>
                <AnalysisWindowList
                  sections={visibleSections}
                  groups={mergedGroups}
                  renderWindow={(s) =>
                    inspect ? (
                      <AnalysisWindow
                        section={s}
                        token={token}
                        jobId={id}
                        selectMode={selectMode}
                        selectedSeqs={new Set(multiSeqs)}
                        onFrameClick={onFrameClick}
                        admin={admin}
                      />
                    ) : (
                      <CustomerAnalysisWindow section={s} />
                    )
                  }
                />
              </div>
            )}
              </>
            ) : (
              <CustomerAnalysisSection
                sections={detail.sections}
                capture={detail.capture}
                inspect={inspect}
                onToggleInspect={toggleInspect}
                inspections={inspections}
                onInspect={inspectWindow}
                jobId={id}
                token={token}
                onFrameClick={openSingle}
                mergedGroups={mergedGroups}
              />
            )}
          </div>

          {/* Decide LLM audit — ADAAAA-7045 (Inc 2, follow-up to ADAAAA-7039):
              durable decide_audit rows for this job (one per frame group). The
              Inc 2 UI originally added this to the dead `components/JobDetail`
              panel which the router never renders; move it onto this routed
              surface so it actually shows.
              ADAAAA-7727: raw decide prompts / media hashes / verdicts are
              pipeline internals — admin only, and a customer session never
              fetches them (loadAudits is admin-gated too). */}
          {admin && (
            <div className="mt-8" data-decide-audit-section>
              <div className="mb-2 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-mut">
                <span className="h-3 w-3 rounded-full bg-mut/40" />
                Decide LLM audit
                <span className="rounded-full bg-ink/15 px-2 py-0.5 text-xs font-bold text-ink" data-decide-audit-count>{audits.length}</span>
              </div>
              {audits.length === 0 ? (
                <div className="text-sm text-mut" data-decide-audit-empty>No decide LLM audit recorded for this job.</div>
              ) : (
                <ul className="flex flex-col gap-2" data-decide-audit-list>
                  {audits.map((a) => (
                    <DecideAuditRow key={a.id} audit={a} />
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {gallery !== null && gallery.length > 0 && (
        <EnlargeGallery
          gallery={gallery}
          galIndex={galIndex}
          framesBySeq={framesBySeq}
          token={token}
          onClose={() => setGallery(null)}
          onPrev={() => shiftGallery(-1)}
          onNext={() => shiftGallery(1)}
          onBoxTrack={trackBox}
        />
      )}
    </div>
  );
}
