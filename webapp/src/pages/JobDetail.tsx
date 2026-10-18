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
import { jobTitle } from "../lib/vodJobs";

const FRAME_W = 160;
const FRAME_H = 90;
const PALETTE = ["#22d3ee", "#f472b6", "#a3e635", "#fbbf24", "#a78bfa", "#fb7185", "#38bdf8", "#fb923c"];
/** SSE events that mean the detail payload changed and should be re-fetched. */
const REFRESH_EVENTS = ["observation", "candidate", "candidateBlocked", "highlight", "progress"];

/** One frame with its perceive boxes drawn on a canvas (lazy, auth-fetched). */
function FrameTile({ frame, token }: { frame: JobDetailFrame; token: string | null }) {
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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, FRAME_W, FRAME_H);
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, FRAME_W, FRAME_H);
      frame.tracks.forEach((t, i) => {
        const [x1, y1, x2, y2] = t.bbox;
        const selected = !!t.selected;
        const color = selected ? "#fbbf24" : PALETTE[t.slot % PALETTE.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = selected ? 3 : 1.5;
        ctx.strokeRect(x1 * FRAME_W, y1 * FRAME_H, (x2 - x1) * FRAME_W, (y2 - y1) * FRAME_H);
      });
    };
    img.src = objUrl;
    return () => {
      img.onload = null;
    };
  }, [objUrl, frame]);

  return (
    <figure className="shrink-0" data-detail-frame>
      <canvas ref={canvasRef} width={FRAME_W} height={FRAME_H} className="rounded-lg border border-mut/30 bg-black" />
      <figcaption className="mt-0.5 text-center text-[10px] text-mut">
        T+{frame.timestamp.toFixed(1)}s<span className="ml-1 text-mut/70">·{frame.tracks.length} trk</span>
      </figcaption>
    </figure>
  );
}

/** A 3 s section: frames filmstrip (with perceive boxes) + decide-note banners. */
function SectionBlock({ section, token }: { section: FrameSection; token: string | null }) {
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
          section.frames.map((f) => <FrameTile key={f.seq} frame={f} token={token} />)
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
}

export function HighlightCard({ highlight: h, onDecision }: HighlightCardProps) {
  return (
    <div className="card card-hover overflow-hidden" data-detail-highlight>
      <VideoClip src={h.clipUri} label={h.eventType} error={h.clipError} />
      <div className="p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">
            {h.eventType || "EVENT"}
          </span>
          <span className="text-xs text-ink">{h.status}</span>
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
            disabled={h.status === "accepted"}
            onClick={() => onDecision(h, "accepted")}
            data-detail-accept
          >
            <Check className="mr-1 inline h-4 w-4" /> Accept
          </button>
          <button
            className="btn-neon btn-pink flex-1"
            disabled={h.status === "rejected"}
            onClick={() => onDecision(h, "rejected")}
            data-detail-reject
          >
            <X className="mr-1 inline h-4 w-4" /> Reject
          </button>
        </div>
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
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const token = getToken();

  const load = useCallback(
    async (initial = false) => {
      try {
        const d = await fetchJobDetail(id);
        if (!aliveRef.current) return;
        setDetail(d);
        setError(null);
        if (!isJobInFlight(d.job?.status)) setTerminal(true);
        else setTerminal(false);
      } catch (e: any) {
        if (!aliveRef.current) return;
        if (initial) setLoading(false);
        if (e?.status === 404) setError("Job not found — it may have been deleted.");
        else if (e?.status === 403) setError("You do not have access to this job.");
        else setError(e?.message || String(e));
      } finally {
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

  // Aligned requirement: no duplicate frame across sections. Re-assert the
  // server partition on every render so a bug can never show a frame twice.
  const partition = useMemo(() => (detail ? assertFramePartition(detail.sections) : null), [detail]);
  const frameCount = useMemo(() => (detail ? detail.sections.reduce((n, s) => n + s.frames.length, 0) : 0), [detail]);
  const acceptedCount = useMemo(() => (detail ? detail.highlights.filter((h) => h.status !== "rejected").length : 0), [detail]);
  const title = useMemo(() => (detail ? jobTitle(detail.job, acceptedCount) : ""), [detail, acceptedCount]);

  async function review(h: JobDetailHighlight, status: "accepted" | "rejected") {
    try {
      await api(`/highlights/${h.id}/review`, { body: { status } });
      // Reflect the review in the detail's highlight list without a full reload.
      setDetail((d) =>
        d
          ? {
              ...d,
              highlights: d.highlights.map((x) => (x.id === h.id ? { ...x, status } : x)),
            }
          : d
      );
    } catch (e: any) {
      setError(e?.message || String(e));
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
            {detail.job.error && (
              <div className="mt-3 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-detail-error>
                {detail.job.error}
              </div>
            )}
          </div>

          {/* Highlights */}
          <h3 className="mt-8 text-2xl font-black">Highlights</h3>
          <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {detail.highlights.length === 0 && <div className="text-mut" data-detail-no-highlights>No highlights for this job.</div>}
            {detail.highlights.map((h) => (
              <HighlightCard key={h.id} highlight={h} onDecision={review} />
            ))}
          </div>

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
          <h3 className="mt-8 text-2xl font-black">Frames</h3>
          {frameCount === 0 ? (
            <div className="mt-3 text-mut" data-detail-no-frames>No frames for this job.</div>
          ) : (
            <div className="mt-3 flex flex-col gap-3" data-detail-frames>
              {detail.sections.map((s) => (
                <SectionBlock key={s.index} section={s} token={token} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
