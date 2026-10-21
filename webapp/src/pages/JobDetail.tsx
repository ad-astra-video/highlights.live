import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Play, Check, X, Loader2 } from "lucide-react";
import { api, getToken } from "../lib/api";
import { readSSE } from "../lib/sse";
import { VideoClip } from "../components/VideoClip";
import {
  fetchJobDetail,
  isJobInFlight,
  assertFramePartition,
  sectionLabel,
  triggerLabel,
  authFetchFrame,
  type JobDetail,
  type JobDetailHighlight,
  type FrameSection,
  type JobDetailFrame,
} from "../lib/jobDetail";
import {
  drawFrameWithBoxes,
  drawFrameFullBleed,
  coverTransform,
  orderGallerySeqs,
  collectFrameSeqs,
  type CoverTransform,
} from "../lib/frameDebugger";
import { jobTitle } from "../lib/vodJobs";
import { startDetailPoll } from "../lib/detailPoll";

// Inline thumbnail stays small (original 160x90) so the filmstrip doesn't
// crowd the page; box strokes are drawn at 2x backing for crispness. Labels
// are shown ONLY on the enlarged frame (board feedback on ADAAAA-6946).
const FRAME_W = 160;
const FRAME_H = 90;
const INLINE_FONT = 12; // CSS px in the enlarged view; inline draws boxes only
const INLINE_SCALE = 2;
/** SSE events that mean the detail payload changed and should be re-fetched. */
const REFRESH_EVENTS = ["observation", "candidate", "candidateBlocked", "highlight", "progress"];

interface FrameTileProps {
  frame: JobDetailFrame;
  token: string | null;
  selectMode: boolean;
  selected: boolean;
  onFrameClick: (seq: number) => void;
}

/** One frame with its perceive boxes + legible labels drawn on a canvas (lazy, auth-fetched). */
function FrameTile({ frame, token, selectMode, selected, onFrameClick }: FrameTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let url: string | null = null;
    authFetchFrame(frame.uri, token)
      .then((u) => {
        url = u;
        if (alive) setObjUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [frame.uri, token]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !objUrl) return;
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

interface SectionBlockProps {
  section: FrameSection;
  token: string | null;
  selectMode: boolean;
  selectedSeqs: Set<number>;
  onFrameClick: (seq: number) => void;
}

/** A 3 s section: frames filmstrip (with perceive boxes + labels) + decide-note banners. */
function SectionBlock({ section, token, selectMode, selectedSeqs, onFrameClick }: SectionBlockProps) {
  return (
    <section className="rounded-xl border border-purple/30 bg-black/30 p-3" data-frame-section data-section-index={section.index}>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-black uppercase tracking-wide text-neon">{sectionLabel(section)}</h4>
        <span className="text-xs text-mut">{section.frames.length} frame(s)</span>
      </div>
      {section.decideNotes.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          {section.decideNotes.map((n, i) => (
            <div
              key={i}
              className={`rounded-lg border px-3 py-2 text-xs ${
                n.status === "accepted"
                  ? "border-green/40 bg-green/10 text-green"
                  : n.status === "suppressed"
                  ? "border-yellow/40 bg-yellow/10 text-yellow"
                  : "border-mut/30 bg-mut/10 text-slate-ink"
              }`}
              data-decide-note
            >
              <span className="font-bold">Decide @ T+{n.timestamp.toFixed(1)}s</span>
              <span className="ml-1">— {n.eventType} · {Math.round(n.score)}{n.outcome ? ` · ${n.outcome}` : ""} · {n.status}</span>
              {n.reason && <div className="mt-0.5 text-mut">{n.reason}</div>}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {section.frames.length === 0 ? (
          <div className="text-xs text-mut">No frames in this section.</div>
        ) : (
          section.frames.map((f) => (
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
    </section>
  );
}

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
}

export function HighlightCard({ highlight: h, onDecision, pendingStatus = null }: HighlightCardProps) {
  const pending = pendingStatus !== null;
  const busyAccept = pendingStatus === "accepted";
  const busyReject = pendingStatus === "rejected";
  return (
    <div className="card card-hover overflow-hidden" data-detail-highlight>
      <VideoClip src={h.clipUri} label={h.eventType} error={h.clipError} />
      <div className="p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">
            {h.eventType || "EVENT"}
          </span>
          <span className={`text-xs font-bold ${h.status === "rejected" ? "text-red" : "text-ink"}`} data-detail-status>
            {h.status}
          </span>
        </div>
        <div className="mt-2 text-sm text-slate-ink">{h.reason || "No reason"}</div>
        <div className="mt-2 text-2xl font-black text-neon">{Math.round(h.score)}</div>
        <div className="text-xs text-mut">
          T+{Math.round(h.start)}s → T+{Math.round(h.end)}s
        </div>
        <div className="mt-1 rounded-lg border border-mut/30 bg-mut/10 px-2 py-1 text-xs text-mut" data-detail-trigger>
          Trigger: <span className="font-bold text-ink">{triggerLabel(h.trigger)}</span>
        </div>
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
        {h.status === "rejected" && (
          <div className="mt-2 rounded-lg border border-red/40 bg-red/10 px-2 py-1 text-xs text-red" data-detail-rejected>
            Rejected — the highlight leaves the accepted feed. Accept to restore within the recover window.
          </div>
        )}
      </div>
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
    if (!frame) return;
    authFetchFrame(frame.uri, token)
      .then((u) => {
        url = u;
        if (alive) setObjUrl(u);
      })
      .catch(() => {});
    return () => {
      alive = false;
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

/**
 * Full-screen Job detail (ADAAAA-6852 Inc 4). Route /app/jobs/:id. Covers the
 * start-new-job surface: header (job metadata), Highlights, Traces (with
 * capacity budget), and the 3 s-sectioned frame timeline with perceive overlays
 * + decide notes. Live-updates via /jobs/:id/events SSE (Inc 5) and tears the
 * subscription down on a terminal state so no SSE leaks after done/failed.
 */
export function JobDetail() {
  const { id = "" } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [terminal, setTerminal] = useState(false);
  const [loading, setLoading] = useState(true);
  // Which review action is in-flight for which highlight id (per-control loading).
  const [pendingReview, setPendingReview] = useState<{ id: string; status: "accepted" | "rejected" } | null>(null);
  // ADAAAA-7045 (Inc 2, follow-up to ADAAAA-7039): durable decide_audit rows for
  // this job (one per frame group), surfaced as the "Decide LLM audit" section.
  // Best-effort: a failed fetch just leaves the section empty.
  const [audits, setAudits] = useState<any[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  // Guards against overlapping detail fetches: the 5s poll and the SSE-debounced
  // refresh (and a user review re-fetch) can race, so `load` no-ops while a
  // request is already in flight. This prevents request stacking + out-of-order
  // detail overwrites and keeps the interval from piling up on a slow backend.
  const loadInFlightRef = useRef(false);
  const token = getToken();

  // ADAAAA-7045: re-fetch the decide_audit rows so an in-flight job shows them
  // grow as each frame group is decided, and a just-completed job shows all of
  // them on the next refresh. Best-effort (leaves the section empty on failure).
  const loadAudits = useCallback(async () => {
    try {
      const r = await api<{ audits: any[] }>(`/jobs/${id}/decide-audit`);
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
        setError(null);
        // Refresh the durable decide-audit rows alongside the detail payload.
        loadAudits();
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
    [id]
  );

  // Debounced re-fetch on SSE activity: keeps section/trace updates <= ~2s.
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => load(false), 300);
  }, [load]);

  useEffect(() => {
    aliveRef.current = true;
    setLoading(true);
    load(true);
    return () => {
      aliveRef.current = false;
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
    };
  }, [load]);

  // Live updates (Inc 5): subscribe to /jobs/:id/events, re-fetch detail on any
  // relevant event, and tear the subscription down once the job is terminal.
  useEffect(() => {
    if (terminal || !id) return;
    const ac = new AbortController();
    readSSE(`/jobs/${id}/events`, token, (name) => {
      if (REFRESH_EVENTS.includes(name)) scheduleRefresh();
    }, ac.signal).catch(() => {});
    return () => {
      ac.abort();
    };
  }, [id, token, terminal, scheduleRefresh]);

  // Realtime reconciling poll (ADAAAA-6984, AC-1/AC-2/AC-3/AC-5/AC-7). While the
  // job is still in flight, re-fetch its detail every VOD_DETAIL_POLL_MS (5 s)
  // to update status/progress/highlights/traces in place — no full reload. The
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
      onTick: () => load(false),
    });
    return () => poll.stop();
  }, [terminal, id, load]);

  // Aligned requirement: no duplicate frame across sections. Re-assert the
  // server partition on every render so a bug can never show a frame twice.
  const partition = useMemo(() => (detail ? assertFramePartition(detail.sections) : null), [detail]);
  const frameCount = useMemo(() => (detail ? detail.sections.reduce((n, s) => n + s.frames.length, 0) : 0), [detail]);
  const acceptedCount = useMemo(() => (detail ? detail.highlights.filter((h) => h.status !== "rejected").length : 0), [detail]);
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
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-mut">Source</div>
                <div>{sourceLabel(detail.job.source)}</div>
              </div>
              {detail.job.gameHint && (
                <div>
                  <div className="text-xs uppercase tracking-wide text-mut">Game</div>
                  <div>{detail.job.gameHint}</div>
                </div>
              )}
              <div>
                <div className="text-xs uppercase tracking-wide text-mut">Frames</div>
                <div>{detail.job.framesAnalyzed ?? frameCount}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-mut">Decide calls</div>
                <div>{detail.job.decideCalls ?? 0}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-mut">Cost</div>
                <div>${(detail.job.costUsd ?? 0).toFixed(2)}</div>
              </div>
              <div data-detail-partition>
                <div className="text-xs uppercase tracking-wide text-mut">Frames shown</div>
                <div className={partition && !partition.ok ? "font-bold text-red" : ""}>
                  {frameCount}
                  {partition && !partition.ok && <span className="ml-1 text-red">· overlap!</span>}
                </div>
              </div>
            </div>
            {/* ADAAAA-7111 (Increment D): the decide/gemma running video summary
                (story-so-far) — grows as the video progresses. Rendered only when
                the job produced one. */}
            {detail.job.runningSummary && (
              <div className="mt-4 rounded-lg bg-card px-3 py-2" data-detail-running-summary>
                <div className="text-xs uppercase tracking-wide text-mut">Running summary</div>
                <pre className="mt-1 whitespace-pre-wrap font-mono text-sm leading-relaxed text-ink">
                  {detail.job.runningSummary}
                </pre>
              </div>
            )}
            {detail.job.error && (
              <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-detail-error>
                {detail.job.error}
              </div>
            )}
          </div>

          {/* Highlights — accepted feed. Rejected clips move out of this feed
              into the Rejected presentation below (recoverable via Accept). */}
          <h3 className="mt-8 text-2xl font-black">Highlights</h3>
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
                />
              ))}
          </div>

          {/* Rejected presentation (ADAAAA-6953): rejected clips leave the
              accepted feed and appear here so the user can still recover
              (reject → accept within the window restores the clip). */}
          {detail.highlights.filter((h) => h.status === "rejected").length > 0 && (
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
                    />
                  ))}
              </div>
            </>
          )}

          {/* Traces */}
          <h3 className="mt-8 text-2xl font-black">Traces</h3>
          <div className="mt-3 overflow-x-auto rounded-xl border border-purple/30 bg-black/30 p-4">
            <div className="mb-2 text-xs text-mut">
              Tracked objects — capacity budget {detail.traces.length} / {detail.maxTraces}
            </div>
            {detail.traces.length === 0 ? (
              <div className="text-sm text-mut" data-detail-no-traces>No tracked objects for this job.</div>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-mut">
                    <th className="py-1 pr-4">Track</th>
                    <th className="py-1 pr-4">Label</th>
                    <th className="py-1 pr-4">On screen</th>
                    <th className="py-1 pr-4">Into</th>
                    <th className="py-1 pr-4">Lost</th>
                    <th className="py-1 pr-4">Accuracy</th>
                    <th className="py-1">Sel.</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.traces.map((tr) => (
                    <tr key={tr.trackId} className="border-t border-white/10" data-detail-trace>
                      <td className="py-1.5 pr-4 font-mono text-xs">{tr.trackId}</td>
                      <td className="py-1.5 pr-4">{tr.label || tr.kind || "—"}</td>
                      <td className="py-1.5 pr-4">{tr.onScreen}</td>
                      <td className="py-1.5 pr-4">{tr.ontoFrames ?? 0}</td>
                      <td className="py-1.5 pr-4">{tr.lostFrames ?? 0}</td>
                      <td className="py-1.5 pr-4">
                        {tr.accuracy !== undefined ? `${Math.round(tr.accuracy * 100)}%` : "—"}
                      </td>
                      <td className="py-1.5">{tr.selected ? <span className="text-yellow">●</span> : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Frames timeline */}
          <div className="mt-8 flex items-center gap-3">
            <h3 className="text-2xl font-black">Frames</h3>
            <span className="text-xs text-mut">click any frame to enlarge · {frameCount} frame(s)</span>
            <div className="ml-auto flex items-center gap-2">
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
          {frameCount === 0 ? (
            <div className="mt-3 text-mut" data-detail-no-frames>No frames for this job.</div>
          ) : (
            <div className="mt-3 flex flex-col gap-3" data-detail-frames>
              {detail.sections.map((s) => (
                <SectionBlock
                  key={s.index}
                  section={s}
                  token={token}
                  selectMode={selectMode}
                  selectedSeqs={new Set(multiSeqs)}
                  onFrameClick={onFrameClick}
                />
              ))}
            </div>
          )}

          {/* Decide LLM audit — ADAAAA-7045 (Inc 2, follow-up to ADAAAA-7039):
              durable decide_audit rows for this job (one per frame group). The
              Inc 2 UI originally added this to the dead `components/JobDetail`
              panel which the router never renders; move it onto this routed
              surface so it actually shows. */}
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
                  <li
                    key={a.id}
                    data-decide-audit-row
                    data-decide-audit-group={a.groupKey}
                    data-decide-audit-replayable={String(a.replayable)}
                    className="rounded-lg border border-mut/30 bg-mut/5 px-3 py-2 text-sm"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-mut">{a.groupKey}</span>
                      <span className="rounded-full border border-mut/30 px-2 py-0.5 text-xs uppercase text-mut">
                        {a.systemPromptVersion ? `sys v${a.systemPromptVersion}` : "sys"}
                      </span>
                      <span className="ml-auto text-xs text-mut">
                        {a.frameCount ?? 0} frames · {a.candidateCount ?? 0} candidate{Number(a.candidateCount) === 1 ? "" : "s"} · {a.replayable ? "replayable" : "not replayable"}
                      </span>
                    </div>
                    {a.rawReply && (
                      <div className="mt-1 truncate font-mono text-xs text-mut" data-decide-audit-reply>
                        reply: {a.rawReply}
                      </div>
                    )}
                    {Array.isArray(a.mediaHashes) && a.mediaHashes.length > 0 && (
                      <div className="mt-1 font-mono text-xs text-mut" data-decide-audit-media>
                        media: {a.mediaHashes.map((m: any) => `#${(m.sha256 || "").slice(0, 8)}`).join(" ")}
                      </div>
                    )}
                    {a.fallback && <div className="mt-1 text-xs text-red">fell back to rule</div>}
                  </li>
                ))}
              </ul>
            )}
          </div>
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
