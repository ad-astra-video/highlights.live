import { useEffect, useRef, useState } from "react";
import { BrainCircuit, Loader2, Play, CheckCircle2, XCircle, Clock } from "lucide-react";
import { api } from "../lib/api";

// A tiny default manifest so an operator can fire the highlights-train runner
// from the dashboard without preparing a dataset first. Real training data
// (DetectionTrainingSample JSONL) is pasted in the textarea to override this.
const DEFAULT_MANIFEST = [
  { image: "/srv/frames/sample_a.png", labels: [{ label: "player", bbox: [0.1, 0.1, 0.46, 0.32] }] },
  { image: "/srv/frames/sample_b.png", labels: [{ label: "player", bbox: [0.2, 0.2, 0.7, 0.55] }] },
];

type Run = {
  id: string;
  status: string;
  result?: { checkpoint?: string; eval?: { eval?: string; reason?: string; precision?: number; recall?: number; f1?: number } };
  error?: string;
  epochs?: number;
  createdAt: string;
};

const STATUS_META: Record<string, { icon: typeof Clock; cls: string; label: string }> = {
  queued: { icon: Clock, cls: "text-yellow", label: "queued" },
  running: { icon: Loader2, cls: "text-neon", label: "running" },
  done: { icon: CheckCircle2, cls: "text-green", label: "done" },
  failed: { icon: XCircle, cls: "text-pink", label: "failed" },
};

export function Train() {
  const [manifest, setManifest] = useState(JSON.stringify(DEFAULT_MANIFEST, null, 2));
  const [epochs, setEpochs] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const pollRef = useRef<number | null>(null);

  const refreshRuns = async () => {
    const r = await api<{ runs: Run[] }>("/train");
    setRuns(r.runs);
    // Keep polling while any run is still active so completion appears live.
    const active = r.runs.some((x) => x.status === "queued" || x.status === "running");
    if (active && pollRef.current === null) {
      pollRef.current = window.setInterval(refreshRuns, 4000);
    } else if (!active && pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    refreshRuns();
    return () => {
      if (pollRef.current !== null) window.clearInterval(pollRef.current);
    };
  }, []);

  async function startTrain() {
    setBusy(true);
    setError(null);
    try {
      let parsed: unknown[] | string = manifest;
      try {
        parsed = JSON.parse(manifest);
      } catch {
        // fall through: treat the raw textarea as pre-serialized JSONL
      }
      const res = await api<{ run: Run }>("/train", {
        method: "POST",
        body: {
          manifest: parsed,
          epochs: Number(epochs) || undefined,
        },
      });
      await refreshRuns();
      void res;
    } catch (e: any) {
      setError(e?.message || "Failed to start fine-tune");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-12 w-12 place-items-center rounded-2xl border border-purple/30 bg-dusk text-purple">
          <BrainCircuit className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-ink">Fine-tune</h1>
          <p className="text-sm text-mut">Trigger the Florence-2 &lt;OD&gt; LoRA runner and track its checkpoint + eval deltas.</p>
        </div>
      </div>

      <section className="card card-accent mb-6 p-5">
        <label className="mb-1 block text-xs font-semibold text-mut">Training manifest (DetectionTrainingSample JSON)</label>
        <textarea
          value={manifest}
          onChange={(e) => setManifest(e.target.value)}
          spellCheck={false}
          rows={6}
          className="input-neon w-full resize-y font-mono text-xs"
        />
        <div className="mt-3 flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-mut">Epochs</label>
            <input
              type="number"
              min={1}
              value={epochs}
              onChange={(e) => setEpochs(e.target.value)}
              className="input-neon w-24"
            />
          </div>
          <button onClick={startTrain} disabled={busy} className="btn-purple btn-fill flex items-center gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            Start fine-tune
          </button>
          {error && <span className="text-sm text-pink">{error}</span>}
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-mut">Recent runs</h2>
        {runs.length === 0 ? (
          <div className="card p-5 text-sm text-mut">No fine-tune runs yet.</div>
        ) : (
          <ul className="flex flex-col gap-3">
            {runs.map((r) => {
              const meta = STATUS_META[r.status] ?? { icon: Clock, cls: "text-mut", label: r.status };
              const Icon = meta.icon;
              return (
                <li key={r.id} className="card p-4 text-sm">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-4 w-4 ${r.status === "running" ? "animate-spin" : ""} ${meta.cls}`} />
                      <span className={`font-semibold ${meta.cls}`}>{meta.label}</span>
                    </div>
                    <span className="font-mono text-xs text-mut">{r.id.slice(0, 8)}</span>
                  </div>
                  {r.error && <div className="text-pink">{r.error}</div>}
                  {r.status === "done" && r.result && (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <dt className="text-mut">checkpoint</dt>
                      <dd className="font-mono text-green">{r.result.checkpoint ?? "—"}</dd>
                      {r.result.eval && (
                        <>
                          <dt className="text-mut">eval</dt>
                          <dd>{r.result.eval.reason || r.result.eval.eval || "—"}</dd>
                          <dt className="text-mut">precision / recall / f1</dt>
                          <dd className="font-mono">
                            {r.result.eval.precision ?? "—"} / {r.result.eval.recall ?? "—"} / {r.result.eval.f1 ?? "—"}
                          </dd>
                        </>
                      )}
                    </dl>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
