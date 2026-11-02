import { useEffect, useState } from "react";
import { ShieldAlert, RefreshCw } from "lucide-react";
import { api, type Job } from "../lib/api";
import { FrameDebugger } from "../components/FrameDebugger";
import { MediaNodeStrip } from "../components/MediaNodeStrip";
import { formatJobTime, sourceLabel } from "../lib/vodJobs";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726) — operator skeleton for the internal
// diagnostics that used to render on the customer dashboard: the raw frame/track
// debugger, the raw per-job record (cost / decide / perceive / Stage-A) and the
// media-node/spend readout. The full admin console is Inc 3 and out of scope
// here; this page exists so those surfaces have an admin home.
//
// Access: mounted behind `AdminRoute` (/app/admin), invisible in the nav for a
// non-admin and redirecting a non-admin navigation to /app. The server is the
// real gate — a non-admin session cannot read the internal fields at all, so
// this page renders empty rather than leaking anything if it is ever reached.
export function Admin() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api<{ jobs: Job[] }>("/jobs?limit=200");
      setJobs(r.jobs ?? []);
      setError(null);
    } catch (e: any) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-3xl font-black">
            <ShieldAlert className="h-6 w-6 text-neon" /> Admin
          </h1>
          <p className="mt-1 text-mut">
            Operator-only diagnostics: raw job records, the frame/track debugger and media-node spend. Customer
            surfaces never render these.
          </p>
        </div>
        <button className="chip" onClick={() => refresh().catch(() => {})} disabled={loading} data-admin-refresh>
          <RefreshCw className="mr-1 inline h-4 w-4" /> Refresh
        </button>
      </div>

      <MediaNodeStrip className="mt-4" />

      {error && <div className="mt-4 rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}

      <h2 className="mt-8 text-2xl font-black">Jobs</h2>
      <p className="mt-1 text-sm text-mut">Raw job records — every field, including the internal counters.</p>
      {jobs.length === 0 && !loading && <div className="mt-3 text-sm text-mut">No jobs on this instance.</div>}
      {jobs.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs" data-admin-job-table>
            <thead className="text-mut">
              <tr>
                {["id", "source", "status", "frames", "cost", "decide", "perceive s", "stage-a", "created"].map((h) => (
                  <th key={h} className="px-2 py-1 font-bold uppercase tracking-wide">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="font-mono">
              {jobs.map((j) => (
                <tr
                  key={j.id}
                  data-admin-job-row={j.id}
                  data-selected={selected === j.id}
                  className={`cursor-pointer border-t border-mut/20 ${
                    selected === j.id ? "bg-neon/10 text-neon" : "text-slate-300 hover:bg-mut/10"
                  }`}
                  onClick={() => setSelected(j.id)}
                >
                  <td className="px-2 py-1">{j.id.slice(0, 8)}</td>
                  <td className="px-2 py-1">{sourceLabel(j.source)}</td>
                  <td className="px-2 py-1 uppercase">{j.status}</td>
                  <td className="px-2 py-1">{j.framesAnalyzed ?? 0}</td>
                  <td className="px-2 py-1">${(j.costUsd ?? 0).toFixed(4)}</td>
                  <td className="px-2 py-1">{j.decideCalls ?? 0}</td>
                  <td className="px-2 py-1">{j.perceiveSessionS ?? 0}</td>
                  <td className="px-2 py-1">
                    {j.stageAMetrics
                      ? `${Number((j.stageAMetrics as Record<string, unknown>).totalCandidates ?? 0)} judged`
                      : j.stageAMetricsStatus === "n/a"
                      ? "n/a"
                      : "—"}
                  </td>
                  <td className="px-2 py-1">{formatJobTime(j.createdAt) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <>
          <h2 className="mt-8 text-2xl font-black">
            Frame debugger <span className="font-mono text-sm text-mut">{selected.slice(0, 8)}</span>
          </h2>
          <FrameDebugger jobId={selected} />
        </>
      )}
    </div>
  );
}
