import { useEffect, useState } from "react";
import { Zap, Upload, MonitorPlay, Radio, Tv, Loader2 } from "lucide-react";
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

export function Dashboard() {
  const [source, setSource] = useState("file");
  const [videoPath, setVideoPath] = useState("/data/test_vod.mp4");
  const [gameHint, setGameHint] = useState("Esports");
  const [lookFor, setLookFor] = useState("kills, clutches, high-momentum plays");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<any>(null);
  const [highlights, setHighlights] = useState<Highlight[]>([]);

  async function refreshHighlights() {
    const r = await api<{ highlights: Highlight[] }>("/highlights");
    setHighlights(r.highlights);
  }
  useEffect(() => {
    refreshHighlights().catch(() => {});
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    setJob(null);
    try {
      const r = await api<any>("/jobs", {
        body: { source, videoPath, gameHint, lookFor },
      });
      setJob(r.job);
    } catch (e: any) {
      setError(e.status === 402 ? `${e.message} — subscribe on Billing to continue.` : e.message);
    } finally {
      setBusy(false);
      refreshHighlights().catch(() => {});
    }
  }

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

        <label className="mb-2 block text-xs uppercase tracking-wide text-mut">Source path / URL</label>
        <input className="input-neon" value={videoPath} onChange={(e) => setVideoPath(e.target.value)} placeholder="/data/test_vod.mp4 or rtmp://…" />

        <label className="mb-2 mt-5 block text-xs uppercase tracking-wide text-mut">Sport / game</label>
        <div className="flex flex-wrap gap-2">
          {GAMES.map((g) => (
            <button key={g} data-active={gameHint === g} onClick={() => setGameHint(g)} className="chip chip-pink">
              {g}
            </button>
          ))}
        </div>

        <label className="mb-2 mt-5 block text-xs uppercase tracking-wide text-mut">What to look for</label>
        <input className="input-neon" value={lookFor} onChange={(e) => setLookFor(e.target.value)} />

        <button className="btn-neon mt-6" onClick={run} disabled={busy}>
          {busy ? <Loader2 className="mr-2 inline h-4 w-4 animate-spin" /> : <Zap className="mr-2 inline h-4 w-4" />}
          {busy ? "Analyzing…" : "Run detection"}
        </button>
        {error && <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
        {job && (
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
