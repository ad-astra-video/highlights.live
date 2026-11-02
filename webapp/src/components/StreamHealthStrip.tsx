import { Activity } from "lucide-react";
import type { ChipView, Tone } from "../lib/streamHealth";

// Customer stream-health strip (ADAAAA-7726 Inc 2 / ADAAAA-7730).
//
// The ONE non-admin readout on the capture surface: five plain-language chips
// (Link, Quality, Bitrate, Detect, Clips). It renders values the browser already
// holds — no cost figure, no media-session identifiers, no decide/perceive/
// observe counters, no frame seq — so it is safe for a `role=user` session.
// Presentational only: `useStreamHealth` owns the sampling, `lib/streamHealth`
// owns the verdicts.

const TONE_CLASS: Record<Tone, string> = {
  ok: "text-green",
  warn: "text-yellow",
  bad: "text-red",
  muted: "text-mut",
};

export function StreamHealthStrip({ chips, className }: { chips: ChipView[]; className?: string }) {
  return (
    <div
      data-testid="stream-health-strip"
      aria-label="Stream health"
      className={`flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-mut/20 bg-black/60 px-3 py-2 font-mono text-xs text-slate-300${
        className ? ` ${className}` : ""
      }`}
    >
      <Activity className="h-3.5 w-3.5 shrink-0 text-neon" aria-hidden="true" />
      {chips.map((chip) => (
        <span key={chip.id} data-chip={chip.id} className="whitespace-nowrap">
          <span className="text-mut">{chip.label} </span>
          <span className={TONE_CLASS[chip.tone]}>{chip.value}</span>
          {chip.detail && <span className="text-mut"> {chip.detail}</span>}
        </span>
      ))}
    </div>
  );
}
