import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { NODE_POLL_MS, nodeStripParts, type MediaNodeStatus, type StripTone } from "../lib/nodeStrip";

// Media-node capacity/health + per-node Livepeer spend (ADAAAA-6869 Phase 4).
// One strip, polled from GET /media/node. A failed poll keeps the last reading
// (or the "waiting" state) and never breaks the console.
//
// Shared by every live surface that can hold a media session: the RTMP/file live
// console and the client-side (browser screen share) capture panel. A
// browser-capture job holds the same capacity-1 media node, so it needs the same
// readout (ADAAAA-7655 gap 3).

const TONE_CLASS: Record<StripTone, string> = {
  ok: "text-green",
  bad: "text-red",
  warn: "text-yellow",
  muted: "text-mut",
};

export function MediaNodeStrip({ className }: { className?: string }) {
  const [node, setNode] = useState<MediaNodeStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api<MediaNodeStatus>("/media/node")
        .then((r) => !cancelled && setNode(r))
        .catch(() => !cancelled && setNode((prev) => prev));
    };
    load();
    const t = setInterval(load, NODE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const parts = nodeStripParts(node);

  return (
    <div
      data-testid="media-node-strip"
      className={`flex flex-wrap gap-x-4 gap-y-1 rounded-lg border border-mut/20 bg-black/60 px-3 py-2 font-mono text-xs text-slate-300${
        className ? ` ${className}` : ""
      }`}
    >
      {parts.map((part) => (
        <span
          key={part.id}
          data-part={part.id}
          className={`${part.detail ? "text-xs opacity-80" : ""}${part.tone ? ` ${TONE_CLASS[part.tone]}` : ""}`.trim()}
        >
          {part.text}
        </span>
      ))}
    </div>
  );
}
