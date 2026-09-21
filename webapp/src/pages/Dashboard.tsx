import { useEffect, useState } from "react";
import { Zap, Upload, MonitorPlay, Radio, Tv, Loader2, Square, Check, X } from "lucide-react";
import { api, type Highlight, uploadVideo, VOD_MAX_UPLOAD_BYTES, formatBytes } from "../lib/api";
import { isOverLimit, oversizedHelp } from "../lib/vodUpload";
import { useAuth } from "../lib/auth";
import { LiveConsole } from "../components/LiveConsole";
import { FrameDebugger } from "../components/FrameDebugger";
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

export function Dashboard() {
  const { billing, refreshBilling } = useAuth();
  const [source, setSource] = useState("file");
  const [videoPath, setVideoPath] = useState("/data/test_vod.mp4");
  const [gameHint, setGameHint] = useState("Esports");
  const [lookFor, setLookFor] = useState(GAME_DEFAULTS.Esports);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
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
  const [debugJob, setDebugJob] = useState<string | null>(null);

  const isLive = source !== "file";

  async function refreshHighlights() {
    const r = await api<{ highlights: Highlight[] }>("/highlights");
    setHighlights(r.highlights);
  }
  async function review(id: string, status: "accepted" | "rejected") {
    try {
      await api(`/highlights/${id}/review`, { body: { status } });
      refreshHighlights().catch(() => {});
    } catch (e: any) {
      setError(e.message);
    }
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

  async function run() {
    setBusy(true);
    setError(null);
    setJob(null);
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
        setDebugJob(r.job.id);
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
            {liveJob && liveStatus !== "done" && liveStatus !== "failed" && <LiveConsole jobId={liveJob} />}
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
          <div className="mt-4 text-sm text-green">
            Job <span className="font-mono">{job.id.slice(0, 8)}</span> — <span className="uppercase">{job.status}</span>
          </div>
        )}
      </div>

      {debugJob && <FrameDebugger jobId={debugJob} />}

      <h2 className="mt-10 text-2xl font-black">Your highlights</h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {highlights.length === 0 && <div className="text-mut">Nothing yet — run a detection above.</div>}
        {highlights.map((h) => (
          <div key={h.id} className="card card-hover overflow-hidden">
            <VideoClip src={h.clipUri} label={h.eventType} />
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
                  onClick={() => review(h.id, "accepted")}
                >
                  <Check className="mr-1 inline h-4 w-4" /> Accept
                </button>
                <button
                  className="btn-neon btn-pink flex-1"
                  disabled={h.status === "rejected"}
                  onClick={() => review(h.id, "rejected")}
                >
                  <X className="mr-1 inline h-4 w-4" /> Reject
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
