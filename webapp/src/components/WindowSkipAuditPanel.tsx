import type { WindowSkipAudit } from "../lib/jobDetail";

// ADAAAA-8425: the admin window-audit readout for ONE job — the five skip causes
// side by side with the decide count and the supply total the customer chip
// shows, plus the decide ceiling the run actually ran at (advertised vs
// effective).
//
// Why a separate panel instead of one number: ADAAAA-8418 asked "why are windows
// skipped while the decide cards read idle". Each cause is a DIFFERENT failure —
// stale (content late), backpressure (this stream's own queue full), admission
// (another live job held the box), throttle (the funded rate cap dropped it) and
// capacity-drop (the runner refused the decide: 503 no capacity) — and the last
// one is the failure that looks exactly like a lost window with an idle GPU.
// Reading them beside each other answers the question without a shell.
//
// Admin-only (ADAAAA-7727): every number here is an internal pipeline diagnostic.
// The customer projection never mounts this component, and the payload does not
// even carry `windowAudit` for a `role=user` caller.
export function WindowSkipAuditPanel({
  audit,
  admin,
}: {
  audit?: WindowSkipAudit;
  admin: boolean;
}) {
  if (!admin || !audit) return null;
  // A record with no observe snapshot has no measured counts at all: every tile
  // reads `n/a` rather than a fabricated `0` (a measured zero and "never
  // measured" are different answers, and only one of them explains a gap).
  const shown = (n: number) => (audit.observeRecorded ? String(n) : "n/a");
  const capacity = audit.decideCapacity;
  // The ceiling line is the ADAAAA-8292/8254 "6 slots served, 8 funded" answer:
  // `advertised` is what the runner fleet offered at job start, `effective` what
  // the gate admitted. Absent snapshot => say so, never invent a number.
  const ceiling = capacity
    ? `advertised ${capacity.advertised} · effective ${capacity.effective} · funded ${capacity.funded}`
    : "no capacity snapshot on this record";
  return (
    <div
      className="mt-3 rounded border border-mut/30 bg-dusk/60 px-3 py-2 text-xs text-slate-ink"
      data-window-audit
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-bold uppercase tracking-wide text-mut">Window audit</span>
        <span className="text-mut">
          {shown(audit.decideCalls)} decide · {shown(audit.skippedWindows)} supply skipped
        </span>
        {!audit.observeRecorded && (
          <span className="text-yellow" data-window-audit-unrecorded>
            no observe snapshot stored
          </span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        <span data-window-audit-stale>
          stale <span className="font-mono text-ink">{shown(audit.staleSkippedWindows)}</span>
        </span>
        <span data-window-audit-backpressure>
          backpressure <span className="font-mono text-ink">{shown(audit.backpressureSkippedWindows)}</span>
        </span>
        <span data-window-audit-admission>
          admission <span className="font-mono text-ink">{shown(audit.admissionSkippedWindows)}</span>
        </span>
        <span data-window-audit-throttle>
          throttle <span className="font-mono text-ink">{shown(audit.throttleSkippedWindows)}</span>
        </span>
        {/* The cause that reads as "GPU idle, window missing": the decide was
            issued and the runner refused it. Highlighted so it cannot be missed,
            and `n/a` (not 0) on a row written before the counter existed. */}
        <span
          data-window-audit-capacity
          className={audit.capacityDroppedWindows !== null && audit.capacityDroppedWindows > 0 ? "text-red" : undefined}
        >
          capacity-drop{" "}
          <span className="font-mono text-ink">
            {audit.capacityDroppedWindows === null ? "n/a" : shown(audit.capacityDroppedWindows)}
          </span>
        </span>
      </div>
      <div className="mt-1 text-mut" data-window-audit-ceiling>
        decide ceiling: <span className="font-mono text-ink">{ceiling}</span>
      </div>
    </div>
  );
}
