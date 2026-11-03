import { useEffect, useRef, useState } from "react";
import { Radio, Send } from "lucide-react";
import { getToken, api } from "../lib/api";
import { readSSE } from "../lib/sse";
import { useIsAdmin } from "../lib/auth";
import { MediaNodeStrip } from "./MediaNodeStrip";
import {
  findPlayerTrack,
  gaveUpPlayerStatus,
  playerStatusFromAck,
  type PlayerControlResponse,
  type PlayerStatus,
} from "../lib/playerTrack";

interface FeedItem {
  key: number;
  kind: string;
  text: string;
}

// Live-console panel: streams perceive observations / candidates / highlights
// for a running job over the /jobs/:id/events SSE endpoint and lets the operator
// send preference/control intents to /jobs/:id/control.
export function LiveConsole({ jobId, onHighlight }: { jobId: string; onHighlight?: (h: any) => void }) {
  // ADAAAA-7727: the console stays a customer surface, but its raw pipeline
  // detail (frame seq, live track count, the media-node capacity/spend strip) is
  // operator diagnostics — those render only for an admin session.
  const admin = useIsAdmin();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [tracks, setTracks] = useState<number>(0);
  const [connected, setConnected] = useState(false);
  const [control, setControl] = useState("");
  const [playerNumber, setPlayerNumber] = useState("");
  const [playerStatus, setPlayerStatus] = useState<PlayerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(0);
  const feedRef = useRef<HTMLDivElement>(null);
  // Echo a line into the console feed from outside the SSE effect (the player
  // request runs in an event handler, not in the stream callback).
  const pushRef = useRef<((kind: string, text: string) => void) | null>(null);
  // Latest sampled-frame seq from the observation stream, plus the open player
  // request. perceive counts its retry window in SAMPLED FRAMES
  // (PLAYER_RETRY_WINDOW_FRAMES = 200), so the seq delta — not a made-up timer —
  // is what tells us the operator's request has actually been given up on.
  const lastSeqRef = useRef(0);
  const pendingPlayerRef = useRef<{ number: number; fromSeq: number; window: number } | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    const push = (kind: string, text: string) => {
      if (cancelled) return;
      setItems((prev) => [...prev.slice(-49), { key: keyRef.current++, kind, text }]);
    };
    pushRef.current = push;
    readSSE(`/jobs/${jobId}/events`, getToken(), (name, data) => {
      if (name === "ready") setConnected(true);
      else if (name === "observation") {
        setTracks(data.observation?.tracks?.length ?? 0);
        // ADAAAA-7727: frame seq + track count are frame/track debug — admin only.
        if (admin) push("observation", `seq ${data.seq} — ${data.observation?.tracks?.length ?? 0} track(s)`);
        onObservation(data);
      } else if (name === "candidate") {
        push("candidate", admin ? `⚡ candidate @T+${Math.round(data.timestamp)}s (${data.candidate?.eventType || "event"})` : `⚡ moment @T+${Math.round(data.timestamp)}s`);
      } else if (name === "highlight") {
        push("highlight", `🎬 highlight clipped: ${data.highlight?.eventType || "event"} score ${Math.round(data.highlight?.score ?? 0)}`);
        // Live feed surface (ADAAAA-5777): a highlight was just accepted and
        // persisted server-side at decision time — tell the parent to refresh
        // the highlights grid so it streams in continuously, not only at end.
        if (onHighlight) onHighlight(data.highlight);
      }
    }, ac.signal)
      .catch((e: any) => !cancelled && setError(String(e?.message || e)))
      .finally(() => !cancelled && setConnected(false));
    return () => {
      cancelled = true;
      pushRef.current = null;
      ac.abort();
    };
  }, [jobId, admin]);

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

  // Fold one observation event into the open player-by-jersey request. A track
  // labelled `player #N` means perceive's frame-bounded retry identified the
  // jersey and seeded the locked slot; a full retry window of sampled frames
  // with no such track means perceive gave up (it clears the pending request at
  // the window edge and seeds nothing). Both readings come from the stream, so
  // the UI never invents a timer.
  function onObservation(data: any) {
    const seq = Number(data?.seq ?? 0);
    if (Number.isFinite(seq)) lastSeqRef.current = seq;
    const pending = pendingPlayerRef.current;
    if (!pending) return;
    const hit = findPlayerTrack(data?.observation?.tracks, pending.number);
    if (hit) {
      pendingPlayerRef.current = null;
      const slot = typeof hit.slot === "number" ? ` (slot ${hit.slot})` : "";
      setPlayerStatus({ kind: "tracked", text: `player #${pending.number} tracked${slot} — following it now` });
      pushRef.current?.("highlight", `🎯 player #${pending.number} tracked${slot}`);
      return;
    }
    if (seq - pending.fromSeq >= pending.window) {
      pendingPlayerRef.current = null;
      const status = gaveUpPlayerStatus(pending.number, pending.window);
      setPlayerStatus(status);
      pushRef.current?.("control", status.text);
    }
  }

  // "Track player #N": the one control whose outcome the operator must see
  // (ADAAAA-7833). The server awaits perceive's ack and returns it, so an
  // unreadable jersey shows as a visible error + retry state, never as ok:true.
  async function trackPlayer() {
    const n = Number(playerNumber.trim());
    if (!Number.isInteger(n) || n < 0 || n > 99) {
      setError("jersey number must be a whole number 0-99");
      return;
    }
    setError(null);
    setPlayerStatus({ kind: "pending", text: `asking perceive to identify player #${n}…` });
    try {
      const r = await api<PlayerControlResponse>(`/jobs/${jobId}/control`, {
        body: { type: "track-player", args: { number: n } },
      });
      // Admin sessions see the raw ack JSON in the feed (operator diagnostics);
      // every session gets the plain-language line below it.
      if (admin) pushRef.current?.("control", `→ track-player #${n}: ${JSON.stringify(r?.ack ?? { ok: false, error: r?.error })}`);
      const { status, retryWindow } = playerStatusFromAck(n, r);
      setPlayerStatus(status);
      if (retryWindow !== null) {
        // The retry window is counted in SAMPLED FRAMES on the perceive side, so
        // remember where the seq counter stood when the request was registered.
        pendingPlayerRef.current = { number: n, fromSeq: lastSeqRef.current, window: retryWindow };
      } else {
        pendingPlayerRef.current = null;
        if (status.kind === "tracked") setPlayerNumber("");
      }
      pushRef.current?.(status.kind === "tracked" ? "highlight" : "control", status.kind === "tracked" ? `🎯 ${status.text}` : status.text);
    } catch (e: any) {
      const why = String(e?.message || e);
      setError(why);
      setPlayerStatus({ kind: "failed", text: `player #${n} request failed: ${why}` });
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
        <span className="text-xs text-mut">{admin ? `${tracks} track(s) now` : connected ? "live" : ""}</span>
      </div>

      {/* Media-node capacity/health + per-node Livepeer spend (ADAAAA-6869).
          ADAAAA-7727: media-server + spend internals — admin only. */}
      {admin && <MediaNodeStrip className="mb-3" />}

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

      {/* Track a player by jersey number (ADAAAA-7833). The capability has
          existed in the perceive pipeline since ADAAAA-7218; this is the
          user-facing path that reaches it. */}
      <div className="mt-3 flex gap-2">
        <input
          className="input-neon flex-1"
          type="number"
          min={0}
          max={99}
          inputMode="numeric"
          placeholder="track a player by jersey number, e.g. 9"
          value={playerNumber}
          onChange={(e) => setPlayerNumber(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && trackPlayer()}
        />
        <button className="btn-neon" onClick={trackPlayer} disabled={!playerNumber.trim()}>
          <Send className="mr-1 inline h-4 w-4" /> Track #
        </button>
      </div>
      <div className="mt-1 text-xs text-mut">
        One-shot identification + jersey OCR per request (no per-frame inference cost). The tracked
        player takes exactly one tracking slot — 3 on a live stream, 8 on a VOD. If the number is
        not readable yet, perceive keeps retrying on sampled frames for a bounded window and then
        gives up; ask again once the player is closer.
      </div>
      {playerStatus && (
        <div
          className={
            playerStatus.kind === "tracked"
              ? "mt-2 text-xs text-green"
              : playerStatus.kind === "pending"
                ? "mt-2 text-xs text-yellow"
                : "mt-2 text-xs text-red"
          }
        >
          {playerStatus.text}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-red">{error}</div>}
    </div>
  );
}
