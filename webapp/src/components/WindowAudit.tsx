// ADAAAA-8425: the admin window audit readout on the job-detail page.
//
// This is the operator answer to "why were windows skipped while the GPUs read
// idle": the five causes side by side (stale / backpressure / admission /
// throttle / capacity-drop), `decideCalls`, the ADAAAA-7808 supply number, and
// the decide pool ceiling the job actually ran at (`effective / funded`).
//
// READ-ONLY: one GET of the stored record, no decide calls, no GPU. Rendered
// only for an admin session; a customer never mounts the fetch and the route
// itself answers 403, so no per-cause counter can leak into the customer view.
// The live chip is untouched and keeps showing only the supply count.
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { auditRenderable, capacityPair, type WindowAuditPayload } from "../lib/windowAudit";

/** Presentational block — SSR-testable, no fetch, no hooks. */
export function WindowAuditPanel({ audit }: { audit: WindowAuditPayload }) {
  if (!auditRenderable(audit)) return null;
  const pair = capacityPair(audit.decideCapacity);
  return (
    <section className="mt-4 rounded-lg border border-mut/30 bg-black/20 p-3" data-window-audit>
      <div className="text-xs font-bold uppercase tracking-wide text-mut">Skipped windows by cause</div>
      <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-5">
        {audit.causes.map((c) => (
          <div key={c.cause} data-window-audit-cause={c.cause} data-count={c.count}>
            <div className="text-xs uppercase tracking-wide text-mut">{c.label}</div>
            <div className="font-mono text-neon" data-window-audit-count>
              {c.count}
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-mut">
        <span>
          decide calls{" "}
          <span className="font-mono text-ink" data-window-audit-decide-calls>
            {audit.decideCalls ?? 0}
          </span>
        </span>
        <span>
          with a verdict{" "}
          <span className="font-mono text-ink" data-window-audit-decide-calls-completed>
            {audit.decideCallsCompleted ?? 0}
          </span>
        </span>
        <span>
          supply skipped{" "}
          <span className="font-mono text-ink" data-window-audit-supply-skipped>
            {audit.supplySkippedWindows ?? 0}
          </span>
        </span>
        <span>
          skipped, all causes{" "}
          <span className="font-mono text-ink" data-window-audit-skipped>
            {audit.skippedWindows ?? 0}
          </span>
        </span>
        <span>
          accounted windows{" "}
          <span className="font-mono text-ink" data-window-audit-accounted>
            {audit.accountedWindows ?? 0}
          </span>
        </span>
      </div>
      {pair && (
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-mut" data-window-audit-capacity>
          <span className="uppercase tracking-wide">Decide capacity</span>
          {/* AC3: the pool the job actually ran at, effective / funded. */}
          <span className="font-mono text-neon" data-window-audit-capacity-pair>
            {pair.text}
          </span>
          <span className="text-mut">effective / funded</span>
          <span data-window-audit-advertised>
            advertised <span className="font-mono text-ink">{audit.decideCapacity?.advertised ?? 0}</span>
          </span>
          <span data-window-audit-effective>
            effective <span className="font-mono text-ink">{pair.effective}</span>
          </span>
          <span data-window-audit-funded>
            funded <span className="font-mono text-ink">{pair.funded}</span>
          </span>
          {/* ADAAAA-8437: the safety cap, so a clamped advertisement is visible. */}
          {audit.decideCapacity?.cap !== undefined ? (
            <span data-window-audit-max-admission>
              cap <span className="font-mono text-ink">{audit.decideCapacity.cap}</span>
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}

/**
 * Admin-only readout. Fetches once per job when the session is an admin; a
 * failed or absent read renders nothing (never a fabricated zero split). The
 * record only carries the counters once the pass settles, so an in-flight job
 * simply shows no panel — the live chip owns that state.
 */
export function WindowAuditReadout({ jobId, admin }: { jobId: string; admin: boolean }) {
  const [audit, setAudit] = useState<WindowAuditPayload | null>(null);
  useEffect(() => {
    setAudit(null);
    if (!admin) return;
    let alive = true;
    api<WindowAuditPayload>(`/admin/jobs/${jobId}/window-audit`)
      .then((a) => {
        if (alive) setAudit(a);
      })
      .catch(() => {
        if (alive) setAudit(null);
      });
    return () => {
      alive = false;
    };
  }, [jobId, admin]);
  if (!admin) return null;
  return audit ? <WindowAuditPanel audit={audit} /> : null;
}
