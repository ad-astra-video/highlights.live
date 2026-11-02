import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Play, Check, X, Loader2, ChevronDown, ChevronRight, VolumeX, Search, Download, Link2 } from "lucide-react";
import { api, getToken } from "../lib/api";
import { readSSE } from "../lib/sse";
import { VideoClip } from "../components/VideoClip";
import { JobDetailMetrics } from "../components/JobMetrics";
import { useIsAdmin } from "../lib/auth";
import { WindowAnalysisPanel } from "../components/WindowAnalysis";
import { SummaryLadderView } from "../components/SummaryLadder";
import { batchManifest, clipFileName, clipUrl, copyText, saveBlob, seedCaption, type BatchItem } from "../lib/highlightPost";
import { buildZip, type ZipFile } from "../lib/zip";
import { asrSummary, asrSummaryLine } from "../lib/windowAsr";
import {
  fetchJobDetail,
  fetchSectionsDelta,
  mergeSections,
  SECTION_WINDOW_S,
  focusAnalysisWindow,
  isJobInFlight,
  assertFramePartition,
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
  type SectionsDelta,
  type JobDetailFrame,
  type DecideNote,
  type NoteKind,
  type SummaryLogEntry,
  type LiveProgress,
  summaryEntryTimestamp,
} from "../lib/jobDetail";
import { LiveProgressChip } from "../components/LiveProgressChip";
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
 *  Increment C). Read-only over the job-detail API data. */
function DecideNoteBanner({ note, jobId }: { note: DecideNote; jobId: string }) {
  const [open, setOpen] = useState(false);
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
  defaultOpen = false,
}: {
  entries?: SummaryLogEntry[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const log = entries ?? [];
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
 * One identified/accepted highlight on the per-job detail surface. Renders the
 * clip player (VideoClip) so the highlight shows its video, plus the metadata
 * and Accept/Reject review controls. Extracted from the JobDetail card so the
 * highlight card (and its clip-player mount) is independently testable.
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
  /** ADAAAA-7622: cards in the accepted (postable) feed can join a batch. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (h: JobDetailHighlight) => void;
  /** Operator session? The customer card (ADAAAA-7737) is the clip, its time
   *  range, the posting caption and Download / Copy link — no event taxonomy,
   *  no score, no trigger, no outcome reason and no review controls. Defaults
   *  to the operator surface for direct component renders; the page always
   *  passes the session role. */
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
}: HighlightCardProps) {
  const pending = pendingStatus !== null;
  const busyAccept = pendingStatus === "accepted";
  const busyReject = pendingStatus === "rejected";
  // ADAAAA-7622: one click must yield either a file or a clipboard URL, with
  // no DevTools in the happy path. `download` on a same-origin anchor saves
  // the clip; the copy button reports its own state so a blocked clipboard is
  // visible instead of silently doing nothing.
  const [copied, setCopied] = useState<"idle" | "copied" | "failed">("idle");
  const url = clipUrl(h.clipUri);
  async function copyLink() {
    const ok = await copyText(url);
    setCopied(ok ? "copied" : "failed");
    setTimeout(() => setCopied("idle"), 1800);
  }
  return (
    <div className="card card-hover overflow-hidden" data-detail-highlight>
      <VideoClip src={h.clipUri} label={admin ? h.eventType : undefined} error={h.clipError} />
      <div className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1">
            {/* ADAAAA-7737: the event taxonomy (SPORTING_EVENT / NEAR_MISS / …)
                and the review status are pipeline internals — admin only. */}
            {admin && (
              <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">
                {h.eventType || "EVENT"}
              </span>
            )}
            {/* ADAAAA-7621: overlap dedupe is invisible without this — the
                winning clip stands in for every overlapping clip folded into
                it, so the card states how many moments it absorbed. The folded
                clips themselves are listed once, below the gallery. */}
            {(h.duplicateCount ?? 0) > 0 && (
              <span
                className="rounded-full border border-yellow/50 bg-yellow/10 px-2 py-0.5 text-xs font-bold text-yellow"
                data-detail-duplicate-count={h.duplicateCount}
                title={`${h.duplicateCount} overlapping clip(s) merged into this moment`}
              >
                {h.duplicateCount} merged
              </span>
            )}
          </span>
          {selectable && onToggleSelect && (
            <label className="flex cursor-pointer items-center gap-1 text-xs text-mut" data-detail-select-label>
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
          <span className={`text-xs font-bold ${h.status === "rejected" ? "text-red" : "text-ink"}`} data-detail-status>
            {h.status}
          </span>
        </div>
        {/* ADAAAA-7737: the outcome reason is decide-layer copy ("outcome=…",
            class taxonomy, scores) — admin only. */}
        {admin && <div className="mt-2 text-sm text-slate-ink">{h.reason || "No reason"}</div>}
        {/* ADAAAA-7248: honest audio state + ASR corroboration on the card. A
            clip cut from an audio-less source (screen/window share) shows an
            explicit label instead of silently implying sound; an ASR
            transcript (when computed) is rendered for textual corroboration. */}
        {h.hasAudio === false && (
          <div
            className="mt-2 inline-flex items-center gap-1 rounded-full border border-mut/40 bg-mut/10 px-2 py-0.5 text-xs font-bold text-mut"
            data-detail-no-audio
          >
            No audio captured
          </div>
        )}
        {h.asrTranscript && (
          <div className="mt-2 rounded-lg border border-neon/30 bg-mut/10 px-2 py-1 text-xs text-ink" data-detail-asr>
            <span className="text-neon">ASR:</span> {h.asrTranscript}
          </div>
        )}
        {admin && <div className="mt-2 text-2xl font-black text-neon">{Math.round(h.score)}</div>}
        <div className="text-xs text-mut">
          T+{Math.round(h.start)}s → T+{Math.round(h.end)}s
        </div>
        {/* ADAAAA-7737: the trigger label names the internal detector and the
            event class — admin only. */}
        {admin && (
          <div className="mt-1 rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut" data-detail-trigger>
            Trigger: <span className="font-bold text-ink">{triggerLabel(h.trigger)}</span>
          </div>
        )}
        {/* ADAAAA-7622: editable posting caption, seeded by the page from the
            summary-log narrative for this clip's window with the event type and
            timestamp prefilled. The edit is what the batch export ships. */}
        <label className="mt-3 block">
          <span className="text-xs uppercase tracking-wide text-mut">Caption</span>
          <textarea
            className="mt-1 w-full resize-y rounded-lg border border-neon/30 bg-dusk px-2 py-1 text-xs text-ink"
            rows={3}
            value={caption}
            onChange={(e) => onCaptionChange?.(h, e.target.value)}
            data-detail-caption
          />
        </label>
        {/* ADAAAA-7622: Download + Copy link. The clip URL is public, so the
            copied link plays in a fresh private window with no login. */}
        <div className="mt-2 flex gap-2">
          {h.clipUri ? (
            <a
              className="btn-neon flex-1 px-2 py-1 text-center text-xs"
              href={url}
              download={clipFileName(h)}
              data-detail-download
            >
              <Download className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Download
            </a>
          ) : (
            <button className="btn-neon flex-1 px-2 py-1 text-xs" disabled data-detail-download>
              <Download className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Download
            </button>
          )}
          <button
            className="btn-neon flex-1 px-2 py-1 text-xs"
            onClick={copyLink}
            disabled={!h.clipUri}
            data-detail-copy-link
            data-copy-state={copied}
          >
            {copied === "copied" ? (
              <>
                <Check className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Copied
              </>
            ) : copied === "failed" ? (
              "Copy failed"
            ) : (
              <>
                <Link2 className="mr-1 inline h-3.5 w-3.5" aria-hidden /> Copy link
              </>
            )}
          </button>
        </div>
        {/* ADAAAA-7248: surface audio state explicitly — a silent clip (e.g. a
            screen/window share, or an audio-less upload) reads as "no audio
            captured" rather than silently implying sound; when an ASR transcript
            is available for corroboration it is shown too. */}
        {h.hasAudio === false && (
          <div
            className="mt-1 rounded-lg border border-yellow/40 bg-yellow/10 px-2 py-1 text-xs text-yellow"
            data-detail-no-audio
          >
            <VolumeX className="mr-1 inline h-3 w-3" aria-hidden /> No audio captured — the source had
            no audio track (e.g. a screen/window share). Sound is unavailable for this clip.
          </div>
        )}
        {h.asrTranscript && (
          <div
            className="mt-1 rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut"
            data-detail-asr
          >
            ASR transcript: <span className="text-slate-ink">{h.asrTranscript}</span>
          </div>
        )}
        <div className="mt-3 flex gap-2">
          <button
            className="btn-neon flex-1"
            disabled={h.status === "accepted" || pending}
            onClick={() => onDecision(h, "accepted")}
            data-detail-accept
          >
            {busyAccept ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : <Check className="mr-1 inline h-4 w-4" />}
            {busyAccept ? "Accepting…" : "Accept"}
          </button>
          <button
            className="btn-neon btn-pink flex-1"
            disabled={h.status === "rejected" || pending}
            onClick={() => onDecision(h, "rejected")}
            data-detail-reject
          >
            {busyReject ? <Loader2 className="mr-1 inline h-4 w-4 animate-spin" /> : <X className="mr-1 inline h-4 w-4" />}
            {busyReject ? "Rejecting…" : "Reject"}
          </button>
        </div>
        {/* ADAAAA-7737: the recover-from-reject copy is an operator workflow
            ("Rejected — …") and a customer never reaches the rejected lane. */}
        {admin && h.status === "rejected" && (
          <div className="mt-2 rounded-lg border border-red/40 bg-red/10 px-2 py-1 text-xs text-red" data-detail-rejected>
            Rejected — the highlight leaves the accepted feed. Accept to restore within the recover window.
          </div>
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
 */
export function CustomerAnalysisSection({ sections }: { sections: FrameSection[] }) {
  return (
    <>
      <h3 className="text-2xl font-black">Analysis</h3>
      {sections.length === 0 ? (
        <div className="mt-3 text-mut" data-analysis-empty>No analysis windows for this job.</div>
      ) : (
        <div className="mt-3 flex flex-col gap-2" data-analysis-windows>
          {sections.map((s) => (
            <CustomerAnalysisWindow key={s.index} section={s} />
          ))}
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
  // Which review action is in-flight for which highlight id (per-control loading).
  const [pendingReview, setPendingReview] = useState<{ id: string; status: "accepted" | "rejected" } | null>(null);
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

  const load = useCallback(
    async (initial = false) => {
      if (loadInFlightRef.current) return;
      loadInFlightRef.current = true;
      try {
        const d = await fetchJobDetail(id);
        if (!aliveRef.current) return;
        setDetail(d);
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
    [id, admin]
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
            if (aliveRef.current && r?.liveProgress) setLiveProgress(r.liveProgress);
          })
          // Best-effort: a failed light read keeps the last honest reading.
          .catch(() => {});
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
      const d = await fetchSectionsDelta(id, after);
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
  }, [id, admin, load, mergeDelta, loadAudits]);

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
  const acceptedCount = useMemo(() => (detail ? detail.highlights.filter((h) => h.status !== "rejected").length : 0), [detail]);
  // ADAAAA-7622: the postable list is the accepted feed (rejected clips are
  // excluded server-side semantics too) — batch export only ever covers this.
  const postableHighlights = useMemo(
    () => (detail ? detail.highlights.filter((h) => h.status !== "rejected") : []),
    [detail]
  );
  const selectedHighlights = useMemo(
    () => postableHighlights.filter((h) => selectedIds.includes(h.id)),
    [postableHighlights, selectedIds]
  );
  const captionOf = useCallback(
    (h: JobDetailHighlight) => captions[h.id] ?? seedCaption(h, detail?.job.summaryLog),
    [captions, detail]
  );
  const title = useMemo(() => (detail ? jobTitle(detail.job, acceptedCount) : ""), [detail, acceptedCount]);

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
      // Re-fetch the authoritative payload so the server-persisted status wins
      // over any concurrent SSE-triggered refresh that could have read a stale
      // pre-review snapshot — this is what makes the reject/accept state change
      // stick and never appear to "do nothing".
      try {
        const fresh = await fetchJobDetail(id);
        if (aliveRef.current) {
          setDetail(fresh);
          setError(null);
        }
      } catch {
        /* keep the optimistic local update; the next refresh reconciles */
      }
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
    for (const h of selectedHighlights) {
      const url = clipUrl(h.clipUri);
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
    const items: BatchItem[] = selectedHighlights.map((h) => ({ caption: captionOf(h), url: clipUrl(h.clipUri) }));
    const ok = await copyText(batchManifest(items));
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
              {isJobInFlight(detail.job.status) && <LiveProgressChip progress={liveProgress} />}
              {/* ADAAAA-7700: WHY the job failed, as its own attributed chip. */}
              <FailureReasonChip reason={detail.job.failureReason} />
            </div>
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
            <VideoSummary entries={detail.job.summaryLog} />
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

          {/* Rejected presentation (ADAAAA-6953): rejected clips leave the
              accepted feed and appear here so the user can still recover
              (reject → accept within the window restores the clip).
              ADAAAA-7737: the reject path is an operator workflow — its cards
              carry the decide outcome code and the "Rejected —" recovery copy,
              so a customer session never renders the section. */}
          {admin && detail.highlights.filter((h) => h.status === "rejected").length > 0 && (
            <>
              <h3 className="mt-8 text-2xl font-black" data-detail-rejected-heading>
                Rejected
              </h3>
              <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {detail.highlights
                  .filter((h) => h.status === "rejected")
                  .map((h) => (
                    <HighlightCard
                      key={h.id}
                      highlight={h}
                      onDecision={review}
                      pendingStatus={pendingReview?.id === h.id ? pendingReview.status : null}
                      admin={admin}
                    />
                  ))}
              </div>
            </>
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
            {visibleSections.length === 0 ? (
              <div className="mt-3 text-mut" data-analysis-empty>No Analysis windows match.</div>
            ) : (
              <div className="mt-3 flex flex-col gap-3" data-analysis-windows>
                {visibleSections.map((s) => (
                  <AnalysisWindow
                    key={s.index}
                    section={s}
                    token={token}
                    jobId={id}
                    selectMode={selectMode}
                    selectedSeqs={new Set(multiSeqs)}
                    onFrameClick={onFrameClick}
                    admin={admin}
                  />
                ))}
              </div>
            )}
              </>
            ) : (
              <CustomerAnalysisSection sections={detail.sections} />
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
