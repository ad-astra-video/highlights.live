import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Zap, Upload, MonitorPlay, Radio, Tv, Loader2, Square, Trash2 } from "lucide-react";
import { api, getToken, type Highlight, type Job, uploadVideo, VOD_MAX_UPLOAD_BYTES, formatBytes } from "../lib/api";
import { readSSE } from "../lib/sse";
import { isOverLimit, oversizedHelp } from "../lib/vodUpload";
import { useAuth } from "../lib/auth";
import {
  useProcessingJobs,
  isInFlight,
  jobProgressPct,
  deleteJob,
  formatJobTime,
  jobSpanLabel,
  sourceLabel,
  jobTitle,
} from "../lib/vodJobs";
import { LiveConsole } from "../components/LiveConsole";
import { FrameDebugger } from "../components/FrameDebugger";
import { BrowserCapture } from "../components/BrowserCapture";

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
  // upload cap (refreshed from /config; defaults to 4 GiB).
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
  // - `confirmDeleteJob` holds the job selected for deletion so the confirm
  //   dialog can render; null when no delete is pending.
  const [confirmDeleteJob, setConfirmDeleteJob] = useState<Job | null>(null);
  const [debugJob, setDebugJob] = useState<string | null>(null);

  const navigate = useNavigate();

  const isLive = source !== "file";

  async function refreshHighlights() {
    const r = await api<{ highlights: Highlight[] }>("/highlights");
    setHighlights(r.highlights);
  }
  useEffect(() => {
    refreshHighlights().catch(() => {});
    // Keep the client-side upload cap in sync with the server's
    // VOD_MAX_UPLOAD_BYTES so a pre-flight >cap rejection matches the 413.
    api<{ vodMaxUploadBytes?: number }>("/config")
      .then((c) => {
        if (c?.vodMaxUploadBytes && c.vodMaxUploadBytes > 0) setVodMax(c.vodMaxUploadBytes);
      })
      .catch(() => {});
  }, []);

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

  // Increment 3 T2 (ADAAAA-6871): open the full-screen detail for a job
  // (row/card click or its "Details" chip). ADAAAA-6888 (Inc 3-4): the plan/AC
  // require the tile click to open the full-screen detail at /app/jobs/:id
  // (which surfaces the LLM title and the per-highlight trigger), so we
  // navigate to that route instead of an inline panel.
  function openDetail(job: Job) {
    navigate(`/app/jobs/${job.id}`);
  }

  const sourceInputLabel = source === "screenshare" || source === "file" ? null
    : "RTMP / stream URL";

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
                acceptedCount={highlights.filter((h) => h.jobId === job.id && h.status !== "rejected").length}
                rejectedCount={highlights.filter((h) => h.jobId === job.id && h.status === "rejected").length}
                onOpen={() => openDetail(job)}
                onDelete={setConfirmDeleteJob}
              />
            ))}
          </div>
        </div>
      )}

      {debugJob && <FrameDebugger jobId={debugJob} />}

      {confirmDeleteJob && (
        <DeleteJobDialog job={confirmDeleteJob} onCancel={() => setConfirmDeleteJob(null)} onConfirm={confirmDelete} />
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


/**
 * Job tile (ADAAAA-6852 Inc 4): one tile per job on the /app surface. Shows the
 * source type, 8-char id, status chip, progress while in flight, and on done:
 * frames analyzed, decide calls, cost, highlight count + a thumbnail strip.
 * Clicking the tile opens the full-screen detail at /app/jobs/:id. A Delete
 * control sits in the corner (ADAAAA-6838) without navigating.
 */
function JobTile({ job, acceptedCount, rejectedCount, onOpen, onDelete }: {
  job: Job;
  acceptedCount: number;
  rejectedCount: number;
  onOpen: () => void;
  onDelete: (job: Job) => void;
}) {
  const inFlight = isInFlight(job.status);
  const span = jobSpanLabel(job);
  const title = jobTitle(job, acceptedCount);
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
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-base font-black text-ink" data-job-tile-title>{title}</div>
          <div className="mt-1 flex items-center gap-2">
            <span className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase ${statusChipClass(job.status)}`}>
              {job.status}
            </span>
            <span className="font-mono text-xs text-mut">{job.id.slice(0, 8)}</span>
          </div>
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
          <span data-job-tile-accepted>{acceptedCount} accepted</span>
          {rejectedCount > 0 && <span className="text-mut" data-job-tile-rejected>{rejectedCount} rejected</span>}
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
