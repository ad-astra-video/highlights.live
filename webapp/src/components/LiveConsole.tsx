import { useEffect, useRef, useState } from "react";
import { Radio, Send } from "lucide-react";
import { getToken, api } from "../lib/api";
import { readSSE } from "../lib/sse";

interface FeedItem {
  key: number;
  kind: string;
  text: string;
}

// Live-console panel: streams perceive observations / candidates / highlights
// for a running job over the /jobs/:id/events SSE endpoint and lets the operator
// send preference/control intents to /jobs/:id/control.
export function LiveConsole({ jobId }: { jobId: string }) {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [tracks, setTracks] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const [control, setControl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const push = (kind: string, text: string) => {
      if (cancelled) return;
      setItems((prev) => [...prev.slice(-49), { key: keyRef.current++, kind, text }]);
    };
    readSSE(`/jobs/${jobId}/events`, getToken(), (name, data) => {
      if (name === "ready") setConnected(true);
      else if (name === "observation") {
        setTracks(data.observation?.tracks?.length ?? 0);
        push("observation", `seq ${data.seq} — ${data.observation?.tracks?.length ?? 0} track(s)`);
      } else if (name === "candidate") {
        push("candidate", `⚡ candidate @T+${Math.round(data.timestamp)}s (${data.candidate?.eventType || "event"})`);
      } else if (name === "highlight") {
        push("highlight", `🎬 highlight clipped: ${data.highlight?.eventType || "event"} score ${Math.round(data.highlight?.score ?? 0)}`);
      }
    }, ac.signal)
      .catch((e: any) => !cancelled && setError(String(e?.message || e)))
      .finally(() => !cancelled && setConnected(false));
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [jobId]);

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [items]);

  async function sendControl() {
    const type = control.trim();
    if (!type) return;
    try {
      await api(`/jobs/${jobId}/control`, {
        body: { type: "preferLabels", args: { labels: type.split(",").map((s) => s.trim()).filter(Boolean) } },
      });
      setControl("");
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="mt-6 rounded-2xl border border-neon/40 bg-black/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-neon">
          <Radio className={`h-4 w-4 ${connected ? "animate-pulse text-green" : "text-mut"}`} />
          Live console
          <span className="normal-case text-mut">— {connected ? "streaming" : "connecting…"}</span>
        </span>
        <span className="text-xs text-mut">{tracks} track(s) now</span>
      </div>

      <div
        ref={feedRef}
        className="h-40 overflow-y-auto rounded-lg border border-mut/20 bg-black/60 px-3 py-2 font-mono text-xs leading-relaxed"
      >
        {items.length === 0 && <div className="text-mut">Waiting for events…</div>}
        {items.map((it) => (
          <div key={it.key} className={it.kind === "highlight" ? "text-green" : it.kind === "candidate" ? "text-yellow" : "text-slate-300"}>
            {it.text}
          </div>
        ))}
      </div>

      <div className="mt-3 flex gap-2">
        <input
          className="input-neon flex-1"
          placeholder="prefer labels, e.g. headshot, clutch"
          value={control}
          onChange={(e) => setControl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendControl()}
        />
        <button className="btn-neon" onClick={sendControl} disabled={!control.trim()}>
          <Send className="mr-1 inline h-4 w-4" /> Send
        </button>
      </div>
      {error && <div className="mt-2 text-xs text-red">{error}</div>}
    </div>
  );
}
