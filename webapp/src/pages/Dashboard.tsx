import { useEffect, useState } from "react";
import { Zap, Upload, MonitorPlay, Radio, Tv, Loader2, Square } from "lucide-react";
import { api, type Highlight } from "../lib/api";

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
  const [source, setSource] = useState("file");
  const [videoPath, setVideoPath] = useState("/data/test_vod.mp4");
  const [gameHint, setGameHint] = useState("Esports");
  const [lookFor, setLookFor] = useState(GAME_DEFAULTS.Esports);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  // live ingest state
  const [liveJob, setLiveJob] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);

  const isLive = source !== "file";

  async function refreshHighlights() {
    const r = await api<{ highlights: Highlight[] }>("/highlights");
    setHighlights(r.highlights);
  }
  useEffect(() => {
    refreshHighlights().catch(() => {});
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
    try {
      const r = await api<any>("/jobs", {
        body: {
          source,
          videoPath: isLive ? videoPath : videoPath,
          gameHint,
          lookFor,
          preferLabels: lookFor.split(",").map((s) => s.trim()).filter(Boolean),
        },
      });
      if (isLive) {
        setLiveJob(r.job.id);
        setLiveStatus(r.status || "ingesting");
      } else {
        setJob(r.job);
      }
    } catch (e: any) {
      setError(e.status === 402 ? `${e.message} — subscribe on Billing to continue.` : e.message);
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

  const sourceInputLabel = source === "screenshare" ? null
    : source === "rtmp" || source === "webrtc" ? "RTMP / stream URL"
    : "Source path / URL";

  return (
    <div className="mx-auto max-w-5xl">
      <h1 className="text-3xl font-black">Clip something</h1>
      <p className="mt-1 text-mut">Choose a source, tell it the sport/game and what to look for.</p>

      <div className="card card-accent mt-6 p-6">
        {/* source */}
        <div className="mb-5 flex flex-wrap gap-2">
          {SOURCES.map((s) => (
            <button key={s.id} data-active={source === s.id} onClick={() => setSource(s.id)} className="chip flex items-center gap-2">
              <s.icon className="h-4 w-4" /> {s.label}
            </button>
          ))}
        </div>

        {source === "screenshare" && (
          <div className="mb-4 rounded-lg border border-mut/30 bg-mut/5 px-3 py-2 text-sm text-mut">
            Screen capture runs on the server host (gdigrab) — this needs a display attached to the server.
          </div>
        )}
        {sourceInputLabel && (
          <>
            <label className="mb-2 block text-xs uppercase tracking-wide text-mut">{sourceInputLabel}</label>
            <input
              className="input-neon"
              value={videoPath}
              onChange={(e) => setVideoPath(e.target.value)}
              placeholder={
                source === "rtmp" || source === "webrtc" ? "rtmp://host/app/stream" : "/data/test_vod.mp4"
              }
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

        {liveJob ? (
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="text-sm">
              Live ingesting — status <span className="font-mono uppercase text-yellow">{liveStatus || "…"}</span>
            </div>
            <button className="btn-neon btn-pink" onClick={stopLive} disabled={!liveJob}>
              <Square className="mr-2 inline h-4 w-4" /> Stop detection
            </button>
          </div>
        ) : (
          <button className="btn-neon mt-6" onClick={run} disabled={busy}>
            {busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Zap className="mr-2 inline h-4 w-4" />}
            {busy ? "Starting…" : isLive ? "Start live detection" : "Run detection"}
          </button>
        )}
        {error && <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
        {job && !isLive && (
          <div className="mt-4 text-sm text-green">
            Job <span className="font-mono">{job.id.slice(0, 8)}</span> — <span className="uppercase">{job.status}</span>
          </div>
        )}
      </div>

      <h2 className="mt-10 text-2xl font-black">Your highlights</h2>
      <div className="mt-4 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {highlights.length === 0 && <div className="text-mut">Nothing yet — run a detection above.</div>}
        {highlights.map((h) => (
          <div key={h.id} className="card card-hover overflow-hidden">
            <video src={h.clipUri} controls className="aspect-video w-full bg-black" />
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
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
