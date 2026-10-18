import { useEffect, useState } from "react";
import { Zap, Upload, MonitorPlay, Radio, Tv, Loader2, Square, Check, X, ChevronDown, ChevronRight, Trash2, List, LayoutGrid, Plus } from "lucide-react";
import { api, getToken, type Highlight, type Job, uploadVideo, VOD_MAX_UPLOAD_BYTES, formatBytes } from "../lib/api";
import { readSSE } from "../lib/sse";
import { isOverLimit, oversizedHelp } from "../lib/vodUpload";
import { DEFAULT_REJECTED_CLIP_TTL_MS, isRecoverable, recoverLabel } from "../lib/rejected";
import { useAuth } from "../lib/auth";
import {
  useProcessingJobs,
  isInFlight,
  jobProgressPct,
  partitionJobs,
  groupHighlightsByJob,
  deleteJob,
  formatJobTime,
  jobSpanLabel,
  sourceLabel,
} from "../lib/vodJobs";
import { LiveConsole } from "../components/LiveConsole";
import { FrameDebugger } from "../components/FrameDebugger";
import { JobDetailPanel } from "../components/JobDetail";
import { BrowserCapture } from "../components/BrowserCapture";
import { VideoClip } from "../components/VideoClip";

const SOURCES = [
  { id: "file", label: "Upload / file", icon: Upload },
  { id: "screenshare", label: "Screen share", icon: MonitorPlay },
  { id: "rtmp", label: "RTMP stream", icon: Radio },
  { id: "webrtc", label: "WebRTC", icon: Tv },
];

const GAMES = [
  "FPS",
  "Battle Royale",
  "MOBA",
  "Football",
  "Basketball",
  "Soccer",
  "Esports",
  "General",
];

// Clicking a sport/game seeds the "what to look for" box with a tailored prompt
// (still user-editable). Mirrors what the detect stage should bias on.
const GAME_DEFAULTS: Record<string, string> = {
  FPS: "kills, headshots, clutches, defuses, aces",
  "Battle Royale": "eliminations, final circle, finish, revives, big plays",
  MOBA: "team fights, towers down, objectives, pentakills, ganks",
  Football: "touchdowns, big passes, sacks, interceptions, highlight runs",
  Basketball: "dunks, three-pointers, steals, fast breaks, buzzer beaters",
  Soccer: "goals, saves, red cards, near-misses, counter-attacks",
  Esports: "kills, clutches, high-momentum plays, multi-eliminations",
  General: "fast movement, collisions, dramatic action, notable plays",
};

export function Highlights() {
  const { billing, refreshBilling } = useAuth();
  // Increment 3 T2/6906: the VOD job grid opens the shared JobDetailPanel via
  // openDetail (setDetailJob) instead of the /app/jobs/:id full-page route, so
  // the I3-B live Decision trail is observable on the actual user path.
  // Async-VOD processing-jobs queue (ADAAAA-6760): fetched + polled + SSE-streamed
  // by the hook; the new "Processing jobs" section below renders its rows.
  const { jobs: processingJobs, refresh: refreshProcessingJobs, removeJob } = useProcessingJobs();
  const [source, setSource] = useState("file");
  const [videoPath, setVideoPath] = useState("/data/test_vod.mp4");
  const [gameHint, setGameHint] = useState("Esports");
  const [lookFor, setLookFor] = useState(GAME_DEFAULTS.Esports);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  // Async-VOD upload acceptance (ADAAAA-6760): set to the submitted job id right
  // after a file upload returns 202 { job, accepted: true }, so the card frees
  // immediately and the next line shows "Upload complete — processing started".
  const [acceptedUploadId, setAcceptedUploadId] = useState<string | null>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // VOD "Upload / file" source: the picked local file, whether the user chose
  // the "paste a URL" fallback instead, upload progress (0..1), and the server
  // upload cap (refreshed from /config; defaults to 2 GB).
  const [file, setFile] = useState<File | null>(null);
  const [useUrl, setUseUrl] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [vodMax, setVodMax] = useState<number>(VOD_MAX_UPLOAD_BYTES);
  // live ingest state
  const [liveJob, setLiveJob] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  // VOD feed surface (ADAAAA-6352): the running VOD job id we subscribe to over
  // SSE so each highlight accepted at decision time streams onto the highlights
  // grid as it is found, not only at job end. Set only for a VOD job that is
  // still processing (the synchronous path/URL + single-shot upload complete
  // within the POST, so it is left null there — the response refresh already
  // surfaced the full set).
  const [vodJobId, setVodJobId] = useState<string | null>(null);
  // Increment 2 (ADAAAA-6837):
  // - `flatHighlights` toggles "Your highlights" between the default per-job
  //   grouped view and the opt-in flat ("Show all") grid.
  // - `failedOpen` tracks whether the collapsed Failed section is expanded
  //   (default collapsed).
  // - `confirmDeleteJob` holds the job selected for deletion so the confirm
  //   dialog can render; null when no delete is pending.
  const [flatHighlights, setFlatHighlights] = useState(false);
  const [failedOpen, setFailedOpen] = useState(false);
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<Job | null>(null);
  const [debugJob, setDebugJob] = useState<string | null>(null);
  // Increment 3 T2 (ADAAAA-6871): the job whose detail panel is open. Any
  // job row/card opens the shared Job detail panel; the Delete control stops
  // propagation so deleting never opens it.
  const [detailJob, setDetailJob] = useState<Job | null>(null);
  // rejected-clips lifecycle (ADAAAA-5168/5204): the server's recovery TTL (for
  // "recover until" deadlines), whether the collapsed rejected section is open,
  // and a ticking `now` so relative deadlines stay accurate while the section
  // is visible (a rejected clip's recovery clock is real-time, not render-time).
  const [rejectedTtlMs, setRejectedTtlMs] = useState<number>(DEFAULT_REJECTED_CLIP_TTL_MS);
  const [rejectedOpen, setRejectedOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const isLive = source !== "file";

  async function refreshHighlights() {
    const r = await api<{ highlights: Highlight[] }>("/highlights");
    setHighlights(r.highlights);
  }
  async function review(id: string, status: "accepted" | "rejected") {
    try {
      await api(`/highlights/${id}/review`, { body: { status } });
      refreshHighlights().catch(() => {});
      // Accepting/rejecting changes which clips consume the clip-count quota, so
      // refresh the billing snapshot so the quota banner reflects accepted-only
      // immediately after a review (a rejected clip releases its slot).
      refreshBilling().catch(() => {});
    } catch (e: any) {
      setError(e.message);
    }
  }
  useEffect(() => {
    refreshHighlights().catch(() => {});
    // Keep the client-side upload cap in sync with the server's
    // VOD_MAX_UPLOAD_BYTES so a pre-flight >cap rejection matches the 413.
    api<{ vodMaxUploadBytes?: number; rejectedClipTtlMs?: number }>("/config")
      .then((c) => {
        if (c?.vodMaxUploadBytes && c.vodMaxUploadBytes > 0) setVodMax(c.vodMaxUploadBytes);
        if (c?.rejectedClipTtlMs && c.rejectedClipTtlMs > 0) setRejectedTtlMs(c.rejectedClipTtlMs);
      })
      .catch(() => {});
  }, []);

  // Tick the rejected-clip recovery clock while the section is expanded so the
  // relative "recover until" deadlines and the Recover affordance stay live.
  useEffect(() => {
    if (!rejectedOpen) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [rejectedOpen]);

  // Poll a running live job until it finishes.
  useEffect(() => {
    if (!liveJob) return;
    const iv = setInterval(async () => {
      try {
        const r = await api<any>(`/jobs/${liveJob}`);
        setLiveStatus(r.job?.status || "active");
        if (r.job?.status === "done" || r.job?.status === "failed") {
          clearInterval(iv);
          setDebugJob(liveJob);
          setLiveJob(null);
          setLiveStatus(null);
          refreshHighlights().catch(() => {});
        }
      } catch {
        /* transient */
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [liveJob]);

  // VOD feed surface streaming (ADAAAA-6352): while a VOD job is processing,
  // subscribe to /jobs/:id/events so each highlight the server accepts at
  // decision time is surfaced on the highlights grid as it is found (mirrors
  // the live LiveConsole stream). The server persists + bills the highlight at
  // decision time too, so GET /highlights returns it the moment it streams in.
  // Stop the subscription + do a final refresh once the job reaches a terminal
  // state. For the synchronous path/URL + single-shot upload this id is never
  // set (the job completes within the POST and its refresh already surfaced the
  // full set), so the subscription only runs for the async resumable upload.
  useEffect(() => {
    if (!vodJobId) return;
    const ac = new AbortController();
    let cancelled = false;
    readSSE(`/jobs/${vodJobId}/events`, getToken(), (name) => {
      if (name === "highlight" && !cancelled) refreshHighlights().catch(() => {});
    }, ac.signal).catch(() => {});
    const iv = setInterval(async () => {
      try {
        const r = await api<any>(`/jobs/${vodJobId}`);
        if (r.job?.status === "done" || r.job?.status === "failed") {
          clearInterval(iv);
          ac.abort();
          setVodJobId(null);
          refreshHighlights().catch(() => {});
        }
      } catch {
        /* transient */
      }
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(iv);
      ac.abort();
    };
  }, [vodJobId]);

  async function run() {
    setBusy(true);
    setError(null);
    setJob(null);
    setAcceptedUploadId(null);
    setVodJobId(null);
    // VOD "Upload / file" source with a local file chosen (not the URL
    // fallback): pre-check size client-side, then multipart upload with
    // progress; the server runs the same extractFrames -> analyzeJob -> clip
    // pipeline and returns the same { job, framesAnalyzed } shape as POST /jobs.
    if (source === "file" && !useUrl && file) {
      if (isOverLimit(file.size, vodMax)) {
        // Reject BEFORE sending — never upload an over-limit file.
        setError(oversizedHelp(vodMax));
        setBusy(false);
        return;
      }
      setUploadPct(0);
      try {
        const r = await uploadVideo<any>({
          file,
          gameHint,
          preferLabels: lookFor.split(",").map((s) => s.trim()).filter(Boolean),
          onProgress: (f) => setUploadPct(f),
        });
        setUploadPct(null);
        setJob(r.job);
        setAcceptedUploadId(r.job?.id ?? null);
        setDebugJob(r.job.id);
        // Async VOD (ADAAAA-6760): the upload resolves on the 202
        // { job, accepted: true } immediately, so the job is still processing —
        // subscribe to its SSE feed for live highlights and refresh the
        // Processing-jobs queue so the new row appears right away.
        if (isInFlight(r.job?.status)) setVodJobId(r.job.id);
        refreshProcessingJobs().catch(() => {});
        refreshBilling().catch(() => {});
      } catch (e: any) {
        setUploadPct(null);
        if (e.status === 429) {
          setError("Monthly clip quota used up — resets at the start of next month.");
          refreshBilling().catch(() => {});
        } else if (e.status === 402) {
          setError(`${e.message} — subscribe on Billing to continue.`);
        } else if (e.status === 413) {
          // Server-side hard cap tripped (shouldn't happen given the pre-check,
          // but guard it) — point at the URL fallback.
          setError(oversizedHelp(vodMax));
        } else {
          setError(e.message);
        }
      } finally {
        setBusy(false);
        refreshHighlights().catch(() => {});
      }
      return;
    }
    try {
      const r = await api<any>("/jobs", {
        body: {
          source,
          videoPath,
          gameHint,
          lookFor,
          preferLabels: lookFor.split(",").map((s) => s.trim()).filter(Boolean),
        },
      });
      if (isLive) {
        setLiveJob(r.job.id);
        setLiveStatus(r.status || "ingesting");
        setDebugJob(null);
      } else {
        setJob(r.job);
        setDebugJob(r.job.id);
        // VOD feed surface: subscribe to the job's SSE feed only while it is
        // still processing. POST /jobs now returns 202 { job, accepted: true }
        // immediately (ADAAAA-6760) and the pipeline runs in the background, so
        // a VOD job is still in flight here — mirror the upload path.
        if (isInFlight(r.job?.status)) setVodJobId(r.job.id);
        refreshProcessingJobs().catch(() => {});
      }
      // A submitted job may have (or will) consume quota — refresh the billing
      // snapshot so the remaining-quota banner stays accurate.
      refreshBilling().catch(() => {});
    } catch (e: any) {
      if (e.status === 429) {
        setError("Monthly clip quota used up — resets at the start of next month.");
      } else if (e.status === 402) {
        setError(`${e.message} — subscribe on Billing to continue.`);
      } else {
        setError(e.message);
      }
      // If the server rejected on quota, reflect the (now-exhausted) status.
      if (e.status === 429) refreshBilling().catch(() => {});
    } finally {
      setBusy(false);
      if (!isLive) refreshHighlights().catch(() => {});
    }
  }

  async function stopLive() {
    if (!liveJob) return;
    try {
      await api(`/jobs/${liveJob}/stop`, { body: {} });
    } catch (e: any) {
      setError(e.message);
    }
  }

  // Delete a job (ADAAAA-6837): call DELETE /jobs/:id, then drop the job from
  // the queue (client-side, immediately) and remove its highlights from the
  // feed (server cascades them). The server also releases any held perceive
  // slot and clears on-disk artifacts.
  async function confirmDelete(jobToDelete: Job) {
    try {
      await deleteJob(jobToDelete.id);
      removeJob(jobToDelete.id);
      setHighlights((prev) => prev.filter((h) => h.jobId !== jobToDelete.id));
      setConfirmDeleteJob(null);
      // Deleting may free clip-quota slots consumed by the job's highlights.
      refreshBilling().catch(() => {});
      refreshProcessingJobs().catch(() => {});
    } catch (e: any) {
      setError(`Delete failed: ${e.message}`);
      setConfirmDeleteJob(null);
    }
  }

  // Completed-card "View highlights" affordance: switch to the grouped view and
  // scroll to that job's highlight group.
  function viewJobHighlights(jobId: string) {
    setFlatHighlights(false);
    requestAnimationFrame(() => {
      document
        .querySelector(`[data-highlight-group="${CSS.escape(jobId)}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  // Increment 3 T2 (ADAAAA-6871): open the shared Job detail panel for a job
  // (row/card click or its "Details" chip).
  function openDetail(job: Job) {
    setDetailJob(job);
  }

  const sourceInputLabel = source === "screenshare" || source === "file" ? null
    : "RTMP / stream URL";

  // Increment 2 (ADAAAA-6837): split the queue into the three job surfaces and
  // precompute the grouped highlight feed for "Your highlights".
  const { inFlight: inFlightJobs, completed: completedJobs, failed: failedJobs } = partitionJobs(processingJobs);
  const groupedHighlights = groupHighlightsByJob(highlights, processingJobs);
  const nonRejectedCount = highlights.filter((h) => h.status !== "rejected").length;

  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-black">Clip something</h1>
          <p className="mt-1 text-mut">Choose a source, tell it the sport/game and what to look for.</p>
        </div>
        {billing && (
          <div
            data-quota
            className={`rounded-lg border px-4 py-2 text-sm ${
              billing.clipQuotaRemaining > 0
                ? "border-neon/40 bg-neon/10 text-neon"
                : "border-red/50 bg-red/10 font-bold text-red"
            }`}
          >
            {billing.clipQuotaRemaining > 0
              ? `${billing.clipQuotaUsed} / ${billing.clipQuotaLimit} clips this month (${billing.clipQuotaRemaining} left) · resets next month`
              : `Monthly quota used: ${billing.clipQuotaUsed} / ${billing.clipQuotaLimit} clips — resets at the start of next month`}
          </div>
        )}
      </div>

      <div className="card card-accent mt-6 p-6">
        {/* source */}
        <div className="mb-5 flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button key={s.id} data-active={source === s.id} onClick={() => setSource(s.id)} className="chip flex items-center gap-2">
              <s.icon className="h-4 w-4" /> {s.label}
            </button>
          ))}
        </div>

        {source === "file" && (
          <div className="mb-1 mt-5" data-vod-upload>
            {!useUrl ? (
              <>
                <label className="mb-2 block text-xs uppercase tracking-wide text-mut">
                  Upload a video file (mp4, mov, webm, mkv, mpegts)
                </label>
                <label className="input-neon inline-flex cursor-pointer items-center gap-2">
                  <Upload className="h-4 w-4" />
                  {file ? "Choose a different video" : "Choose a video file…"}
                  <input
                    type="file"
                    accept="video/*,.mp4,.m4v,.mov,.webm,.mkv,.ts,.mpeg,.mpg"
                    className="hidden"
                    data-testid="video-file-input"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setFile(f);
                      // Show the oversized help text as soon as the file is
                      // picked (still reachable to switch to a URL).
                      setError(f && isOverLimit(f.size, vodMax) ? oversizedHelp(vodMax) : null);
                    }}
                  />
                </label>
                {file && (
                  <div className="mt-2 text-sm text-mut" data-testid="selected-file">
                    {file.name} · {formatBytes(file.size)}
                    {isOverLimit(file.size, vodMax) && (
                      <span className="ml-2 text-red">— over the {formatBytes(vodMax)} upload limit</span>
                    )}
                  </div>
                )}
                <button type="button" className="chip mt-3" onClick={() => setUseUrl(true)}>
                  Paste a download URL instead
                </button>
              </>
            ) : (
              <>
                <label className="mb-2 block text-xs uppercase tracking-wide text-mut">Video URL / path</label>
                <input
                  className="input-neon"
                  value={videoPath}
                  onChange={(e) => setVideoPath(e.target.value)}
                  placeholder="https://example.com/game.mp4"
                />
                <button type="button" className="chip mt-3" onClick={() => setUseUrl(false)}>
                  Upload a file instead
                </button>
              </>
            )}
          </div>
        )}
        {sourceInputLabel && (
          <>
            <label className="mb-2 block text-xs uppercase tracking-wide text-mut">{sourceInputLabel}</label>
            <input
              className="input-neon"
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              placeholder="rtmp://host/app/stream"
            />
          </>
        )}

        <label className="mb-2 mt-5 block text-xs uppercase tracking-wide text-mut">Sport / game</label>
        <div className="flex flex-wrap gap-2">
          {GAMES.map((g) => (
            <button
              key={g}
              data-active={gameHint === g}
              onClick={() => {
                setGameHint(g);
                setLookFor(GAME_DEFAULTS[g] ?? lookFor);
              }}
              className="chip chip-pink"
            >
              {g}
            </button>
          ))}
        </div>

        <label className="mb-2 mt-5 block text-xs uppercase tracking-wide text-mut">What to look for</label>
        <input className="input-neon" value={lookFor} onChange={(e) => setLookFor(e.target.value)} />

        {source === "screenshare" ? (
          <BrowserCapture gameHint={gameHint} onDone={() => refreshHighlights().catch(() => {})} />
        ) : (
          <>
            {liveJob && (
              <div className="mt-6 flex flex-wrap items-center gap-3">
                <div className="text-sm">
                  Live ingesting — status <span className="font-mono uppercase text-yellow">{liveStatus || "…"}</span>
                </div>
                <button className="btn-neon btn-pink" onClick={stopLive} disabled={!liveJob}>
                  <Square className="mr-2 inline h-4 w-4" /> Stop detection
                </button>
              </div>
            )}
            {liveJob && liveStatus !== "done" && liveStatus !== "failed" && (
              <LiveConsole jobId={liveJob} onHighlight={() => refreshHighlights().catch(() => {})} />
            )}
            {!liveJob && (
              <>
                <button
                  className="btn-neon mt-6"
                  onClick={run}
                  disabled={busy || (source === "file" && !useUrl && !!file && isOverLimit(file.size, vodMax))}
                >
                  {busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Zap className="mr-2 inline h-4 w-4" />}
                  {busy
                    ? source === "file" && file && !useUrl
                      ? "Uploading…"
                      : "Starting…"
                    : isLive
                    ? "Start live detection"
                    : "Run detection"}
                </button>
                {uploadPct != null && (
                  <div className="mt-3 text-sm text-mut" data-testid="upload-progress">
                    Uploading… {Math.round(uploadPct * 100)}%
                  </div>
                )}
              </>
            )}
          </>
        )}
        {error && <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
        {job && !isLive && (
          <div className="mt-4 text-sm text-green" data-upload-processing>
            {acceptedUploadId ? (
              <>
                Upload complete — processing started for job <span className="font-mono">{job.id.slice(0, 8)}</span>
              </>
            ) : (
              <>
                Job <span className="font-mono">{job.id.slice(0, 8)}</span> — <span className="uppercase">{job.status}</span>
              </>
            )}
          </div>
        )}
      </div>

      {(processingJobs.length > 0) && (
        <div className="mt-8" data-job-grid>
          <h2 className="text-2xl font-black">Jobs</h2>
          <div className="mt-3 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {processingJobs.map((job) => (
              <JobTile
                key={job.id}
                job={job}
                highlightCount={highlights.filter((h) => h.jobId === job.id && h.status !== "rejected").length}
                onOpen={() => openDetail(job)}
                onDelete={setConfirmDeleteJob}
              />
            ))}
          </div>
        </div>
      )}

      {debugJob && <FrameDebugger jobId={debugJob} />}

      {/* Rejected clips live in a separate, collapsed section shown BELOW the
          accepted/published feed so the user can inspect them before the 24h
          TTL purge (ADAAAA-5163/5204 / ADAAAA-5261). While a clip is within its
          undo window we show a live "Recover until …" deadline + a Recover
          affordance; once past TTL (or hard-deleted by the sweep) the indicator
          and affordance disappear and the section reflects the API's current
          lifecycle. */}
      <RejectedSection
        highlights={highlights}
        now={now}
        ttlMs={rejectedTtlMs}
        open={rejectedOpen}
        onToggle={() => setRejectedOpen((o) => !o)}
        onRecover={(id) => review(id, "accepted")}
        onError={setError}
      />

      {confirmDeleteJob && (
        <DeleteJobDialog job={confirmDeleteJob} onCancel={() => setConfirmDeleteJob(null)} onConfirm={confirmDelete} />
      )}

      {detailJob && (
        <JobDetailPanel jobId={detailJob.id} initialJob={detailJob} onClose={() => setDetailJob(null)} />
      )}
    </div>
  );
}

/**
 * Async-VOD "Processing jobs" surface (ADAAAA-6760). One row per job from the
 * GET /jobs queue (sourced from useProcessingJobs): 8-char id, a status chip,
 * a progress bar + label while the job is queued/active, and terminal detail on
 * done rows (frames analyzed, cost, decide calls, highlight count + a Frame
 * debugger link) or a clear error line on failed rows.
 */
function statusChipClass(status: string): string {
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

/**
 * Increment 2 (ADAAAA-6837): shared highlight card used by both the grouped
 * and flat "Your highlights" views (clip player + accept/reject controls).
 */
function HighlightCard({ highlight, onReview }: { highlight: Highlight; onReview: (id: string, status: "accepted" | "rejected") => void }) {
  const h = highlight;
  return (
    <div className="card card-hover overflow-hidden" data-highlight-card>
      <VideoClip src={h.clipUri} label={h.eventType} error={h.clipError} />
      <div className="p-4">
        <div className="flex items-center justify-between">
          <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">{h.eventType || "EVENT"}</span>
          <span className={`text-xs ${h.status === "accepted" ? "text-green" : h.status === "rejected" ? "text-red" : "text-yellow"}`}>
            {h.status}
          </span>
        </div>
        <div className="mt-2 text-sm text-slate-ink">{h.reason || "No reason"}</div>
        <div className="mt-2 text-2xl font-black text-neon">{Math.round(h.score)}</div>
        <div className="text-xs text-mut">T+{Math.round(h.start)}s → T+{Math.round(h.end)}s</div>
        <div className="mt-3 flex gap-2">
          <button
            className="btn-neon flex-1"
            disabled={h.status === "accepted"}
            onClick={() => onReview(h.id, "accepted")}
          >
            <Check className="mr-1 inline h-4 w-4" /> Accept
          </button>
          <button
            className="btn-neon btn-pink flex-1"
            disabled={h.status === "rejected"}
            onClick={() => onReview(h.id, "rejected")}
          >
            <X className="mr-1 inline h-4 w-4" /> Reject
          </button>
        </div>
      </div>
    </div>
  );
}

/** Per-row/card Delete affordance (ADAAAA-6837). Stops click propagation so a
 * Delete click never bubbles into an enclosing openable row/card (ADAAAA-6871:
 * Delete must NOT open the Job detail panel). */
function DeleteButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="chip" onClick={(e) => { e.stopPropagation(); onClick(); }} data-job-delete>
      <Trash2 className="mr-1 inline h-4 w-4" /> Delete
    </button>
  );
}

/** In-flight "Processing jobs" surface (ADAAAA-6760): one row per queued/active
 * job (8-char id, status chip, source, progress bar + label) plus a Delete
 * control on each row (ADAAAA-6837). ADAAAA-6871: each row is clickable to open
 * the Job detail panel (with a "Details" chip); Delete stops propagation. */
function ProcessingJobs({ jobs, onDebug, onDelete, onOpenDetail }: { jobs: Job[]; onDebug: (id: string) => void; onDelete: (job: Job) => void; onOpenDetail: (job: Job) => void }) {
  return (
    <section data-processing-jobs>
      <h2 className="text-2xl font-black">Processing jobs</h2>
      <div className="mt-3 flex flex-col gap-3">
        {jobs.map((j) => (
          <div key={j.id} className="card cursor-pointer px-4 py-3 transition hover:border-neon/40" data-processing-job onClick={() => onOpenDetail(j)}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm text-ink">{j.id.slice(0, 8)}</span>
              <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChipClass(j.status)}`}>
                {j.status}
              </span>
              <span className="text-xs text-mut">{sourceLabel(j.source)}</span>
              <span className="text-xs text-mut">{j.progressLabel || "queued"}</span>
              <span className="ml-auto flex items-center gap-2">
                <button type="button" className="chip" onClick={() => onOpenDetail(j)} data-job-details>
                  Details
                </button>
                <DeleteButton onClick={() => onDelete(j)} />
              </span>
            </div>
            <div className="mt-2 flex items-center gap-2" data-job-progress>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-mut/20">
                <div className="h-full rounded-full bg-neon" style={{ width: `${jobProgressPct(j)}%` }} />
              </div>
              <span className="text-xs text-mut">{Math.round(jobProgressPct(j))}%</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Completed result cards (ADAAAA-6837). One card per `done` job: source label,
 * scheduled/completed times, span/duration, frames analyzed, decide calls, cost,
 * highlight count, a thumbnail strip from the job's clipUris, links to its
 * grouped highlights + Frame debugger, and a Delete control. ADAAAA-6871: the
 * card is clickable to open the Job detail panel (which embeds the frame
 * overlay for a done job); the Frame debugger / View highlights / Delete
 * controls keep their existing behavior and stop propagation so they never
 * trigger the panel-open card click. */
function CompletedJobs({ jobs, highlights, onDebug, onDelete, onViewHighlights, onOpenDetail }: {
  jobs: Job[];
  highlights: Highlight[];
  onDebug: (id: string) => void;
  onDelete: (job: Job) => void;
  onViewHighlights: (jobId: string) => void;
  onOpenDetail: (job: Job) => void;
}) {
  return (
    <section data-completed-jobs>
      <h2 className="text-2xl font-black">Completed</h2>
      <div className="mt-3 grid gap-5 sm:grid-cols-2">
        {jobs.map((job) => {
          const jobHighlights = highlights.filter((h) => h.jobId === job.id && h.status !== "rejected");
          const thumbnails = jobHighlights.map((h) => h.clipUri).filter(Boolean);
          const span = jobSpanLabel(job);
          const scheduled = formatJobTime(job.scheduledAt);
          const completed = formatJobTime(job.completedAt);
          return (
            <div key={job.id} className="card card-hover cursor-pointer p-4" data-completed-job onClick={() => onOpenDetail(job)}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-green/40 bg-green/10 px-2 py-0.5 text-xs font-bold uppercase text-green">done</span>
                  <span className="font-mono text-sm text-ink">{job.id.slice(0, 8)}</span>
                </div>
                <span className="text-xs text-mut">{sourceLabel(job.source)}</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mut" data-job-done-metrics>
                <span>{job.framesAnalyzed ?? 0} frames</span>
                <span>${(job.costUsd ?? 0).toFixed(2)}</span>
                <span>{job.decideCalls ?? 0} decide calls</span>
                <span>{jobHighlights.length} highlights</span>
                {span && <span data-job-span>{span}</span>}
              </div>
              {(scheduled || completed) && (
                <div className="mt-1 text-xs text-mut" data-job-times>
                  {scheduled && <span>Scheduled {scheduled}</span>}
                  {scheduled && completed && <span> · </span>}
                  {completed && <span>Completed {completed}</span>}
                </div>
              )}
              {thumbnails.length > 0 && (
                <div className="mt-3 flex gap-1 overflow-hidden" data-job-thumbnails>
                  {thumbnails.slice(0, 5).map((uri, i) => (
                    <img key={i} src={uri} alt="" className="h-14 w-24 flex-shrink-0 rounded object-cover" />
                  ))}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="chip" onClick={(e) => { e.stopPropagation(); onDebug(job.id); }} data-job-debug>
                  Frame debugger
                </button>
                {jobHighlights.length > 0 && (
                  <button type="button" className="chip" onClick={(e) => { e.stopPropagation(); onViewHighlights(job.id); }} data-job-view-highlights>
                    View highlights
                  </button>
                )}
                <button type="button" className="chip" onClick={() => onOpenDetail(job)} data-job-details>
                  Details
                </button>
                <span className="ml-auto" />
                <DeleteButton onClick={() => onDelete(job)} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** Failed jobs — a separate, collapsed (expandable) section (ADAAAA-6837).
 * Default collapsed; the header shows the failed count. Expand to see each
 * failed job's server error text. Each row has a Delete control. ADAAAA-6871:
 * each failed row is also clickable to open the Job detail panel (which shows
 * the error + persisted trail); Delete / Frame debugger stop propagation. */
function FailedJobs({ jobs, open, onToggle, onDebug, onDelete, onOpenDetail }: {
  jobs: Job[];
  open: boolean;
  onToggle: () => void;
  onDebug: (id: string) => void;
  onDelete: (job: Job) => void;
  onOpenDetail: (job: Job) => void;
}) {
  if (jobs.length === 0) return null;
  return (
    <section data-failed-section>
      <button
        type="button"
        onClick={onToggle}
        data-failed-section-toggle
        className="flex w-full items-center justify-between rounded-lg border border-red/40 bg-card/70 px-4 py-3 text-left transition hover:border-red/60 hover:bg-card"
      >
        <span className="flex items-center gap-2 text-lg font-black text-ink">
          {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          Failed
          <span className="rounded-full bg-ink/15 px-2 py-0.5 text-xs font-bold text-ink">{jobs.length}</span>
        </span>
        <span className="text-xs text-mut">Click to {open ? "collapse" : "expand"}</span>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-3">
          {jobs.map((job) => (
            <div key={job.id} className="card cursor-pointer px-4 py-3 transition hover:border-red/40" data-failed-job onClick={() => onOpenDetail(job)}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm text-ink">{job.id.slice(0, 8)}</span>
                <span className="rounded-full border border-red/40 bg-red/10 px-2 py-0.5 text-xs font-bold uppercase text-red">failed</span>
                <span className="text-xs text-mut">{sourceLabel(job.source)}</span>
                <span className="ml-auto flex gap-2">
                  <button type="button" className="chip" onClick={(e) => { e.stopPropagation(); onDebug(job.id); }} data-job-debug>
                    Frame debugger
                  </button>
                  <button type="button" className="chip" onClick={() => onOpenDetail(job)} data-job-details>
                    Details
                  </button>
                  <DeleteButton onClick={() => onDelete(job)} />
                </span>
              </div>
              <div className="mt-2 text-xs text-red" data-job-failed-line>
                {job.error?.trim() ? job.error : "Processing failed — check the video source and try again."}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Job tile (ADAAAA-6852 Inc 4): one tile per job on the /app surface. Shows the
 * source type, 8-char id, status chip, progress while in flight, and on done:
 * frames analyzed, decide calls, cost, highlight count + a thumbnail strip.
 * Clicking the tile opens the full-screen detail at /app/jobs/:id. A Delete
 * control sits in the corner (ADAAAA-6838) without navigating.
 */
function JobTile({ job, highlightCount, onOpen, onDelete }: {
  job: Job;
  highlightCount: number;
  onOpen: () => void;
  onDelete: (job: Job) => void;
}) {
  const inFlight = isInFlight(job.status);
  const span = jobSpanLabel(job);
  return (
    <div
      className="card card-hover cursor-pointer p-4"
      data-job-tile
      data-job-tile-id={job.id}
      data-job-tile-status={job.status}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChipClass(job.status)}`}>
            {job.status}
          </span>
          <span className="font-mono text-sm text-ink">{job.id.slice(0, 8)}</span>
        </div>
        <button
          type="button"
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(job);
          }}
          data-job-delete
        >
          <Trash2 className="mr-1 inline h-4 w-4" /> Delete
        </button>
      </div>
      <div className="mt-1 text-xs text-mut" data-job-tile-source>{sourceLabel(job.source)}</div>

      {inFlight ? (
        <div className="mt-3" data-job-progress>
          <div className="h-2 overflow-hidden rounded-full bg-mut/20">
            <div className="h-full rounded-full bg-neon" style={{ width: `${jobProgressPct(job)}%` }} />
          </div>
          <div className="mt-1 flex justify-between text-xs text-mut">
            <span>{job.progressLabel || job.status}</span>
            <span>{Math.round(jobProgressPct(job))}%</span>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mut" data-job-tile-metrics>
          <span>{job.framesAnalyzed ?? 0} frames</span>
          <span>${(job.costUsd ?? 0).toFixed(2)}</span>
          <span>{job.decideCalls ?? 0} decide</span>
          <span>{highlightCount} highlights</span>
          {span && <span data-job-span>{span}</span>}
        </div>
      )}

      <div className="mt-3 flex items-center justify-between">
        <span className="text-xs text-mut">{formatJobTime(job.completedAt || job.createdAt) || ""}</span>
        <button
          type="button"
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        >
          Open detail
        </button>
      </div>
    </div>
  );
}

/** Confirmation dialog before a destructive job delete (ADAAAA-6837). Alerts
 * the user that deleting the job also removes its highlights. */
function DeleteJobDialog({ job, onCancel, onConfirm }: { job: Job; onCancel: () => void; onConfirm: (job: Job) => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/60 p-4" data-delete-job-dialog>
      <div className="card w-full max-w-md p-6">
        <h3 className="flex items-center gap-2 text-lg font-black text-ink">
          <Trash2 className="h-5 w-5 text-red" /> Delete this job?
        </h3>
        <p className="mt-2 text-sm text-mut">
          This permanently deletes job <span className="font-mono">{job.id.slice(0, 8)}</span> and its highlights,
          including the clips they reference. This cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="chip" onClick={onCancel} data-delete-job-cancel>
            Cancel
          </button>
          <button type="button" className="btn-neon btn-pink" onClick={() => onConfirm(job)} data-delete-job-confirm>
            <Trash2 className="mr-1 inline h-4 w-4" /> Delete job
          </button>
        </div>
      </div>
    </div>
  );
}

/** Collapsed-by-default "Rejected" section on the highlight list. Rejected
 * clips render here (not in the published feed) with a live recovery deadline
 * while they are still within the undo window before the server's TTL purge. */
function RejectedSection({
  highlights,
  now,
  ttlMs,
  open,
  onToggle,
  onRecover,
  onError,
}: {
  highlights: Highlight[];
  now: number;
  ttlMs: number;
  open: boolean;
  onToggle: () => void;
  onRecover: (id: string) => void;
  onError: (msg: string) => void;
}) {
  const rejected = highlights.filter((h) => h.status === "rejected");
  if (rejected.length === 0) return null;

  return (
    <div className="mt-10">
      <button
        type="button"
        onClick={onToggle}
        data-rejected-section-toggle
        className="flex w-full items-center justify-between rounded-lg border border-purple/40 bg-card/70 px-4 py-3 text-left transition hover:border-neon/50 hover:bg-card"
      >
        <span className="flex items-center gap-2 text-lg font-black text-ink">
          {open ? <ChevronDown className="h-5 w-5" /> : <ChevronRight className="h-5 w-5" />}
          Rejected
          <span className="rounded-full bg-ink/15 px-2 py-0.5 text-xs font-bold text-ink">{rejected.length}</span>
        </span>
        <span className="text-xs text-mut">Recoverable until auto-deleted</span>
      </button>
      {open && (
        <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {rejected.map((h) => {
            const label = recoverLabel(h.rejectedAt, ttlMs, now);
            const recoverable = isRecoverable(h.rejectedAt, ttlMs, now);
            return (
              <div key={h.id} data-rejected-clip className="card card-hover overflow-hidden">
                <div className="relative">
                  <VideoClip src={h.clipUri} label={h.eventType} error={h.clipError} />
                  <span className="absolute right-2 top-2 rounded-full bg-void/80 px-2 py-0.5 text-xs font-bold text-ink">rejected</span>
                </div>
                <div className="p-4">
                  <div className="flex items-center justify-between">
                    <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">{h.eventType || "EVENT"}</span>
                    <span className="text-xs text-ink">{h.status}</span>
                  </div>
                  <div className="mt-2 text-sm text-slate-ink">{h.reason || "No reason"}</div>
                  <div className="mt-2 text-2xl font-black text-neon">{Math.round(h.score)}</div>
                  <div className="text-xs text-mut">T+{Math.round(h.start)}s → T+{Math.round(h.end)}s</div>
                  {recoverable && label ? (
                    <div data-recover-until className="mt-3 rounded-lg border border-yellow/40 bg-yellow/10 px-3 py-2 text-sm font-semibold text-yellow">
                      {label}
                      <span className="mt-0.5 block text-xs font-normal text-mut">Reject→Accept restores this clip before the deadline.</span>
                    </div>
                  ) : (
                    <div className="mt-3 rounded-lg border border-mut/30 bg-mut/10 px-3 py-2 text-sm text-mut">
                      Recovery window expired — this clip will be deleted.
                    </div>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      data-recover-button
                      className="btn-neon flex-1"
                      disabled={!recoverable}
                      onClick={() => {
                        try {
                          onRecover(h.id);
                        } catch (e: any) {
                          onError(e?.message || "Recover failed");
                        }
                      }}
                    >
                      <Check className="mr-1 inline h-4 w-4" /> Recover
                    </button>
                    <span className="flex-1" />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
