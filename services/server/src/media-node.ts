// Media-node capacity/health + per-node Livepeer GPU cost attribution
// (ADAAAA-6869 Phase 4, accepted split ADAAAA-6714 rev 3).
//
// Post-split topology: the control plane (services/server) is the negotiator +
// DB, and the media node (services/media) is the stream terminus + Orchestrator
// payer for ONE perceived stream. This module turns the two live sources into
// the one readout the console renders:
//
//   1. the node's own capacity/health surface — `GET {MEDIA_SERVER_URL}/health`
//      (public, counts-only) and `GET /node` (bearer-gated, per-session leases),
//   2. the durable attribution — `media_sessions.node_id` + `job.costUsd`.
//
// Keeping the join pure (no fetch, no DB) is deliberate: the numbers the
// console shows are unit-testable without a live node, and the multi-node shape
// (`perNode[]`) exists now even though the fleet is a single node.
import type { Job } from "@highlights/events";
import type { MediaSession } from "./db";

/** `GET /health` payload from the media node (counts only, no identifiers). */
export interface MediaNodeHealth {
  status?: string;
  node?: { id?: string; role?: string; uptimeS?: number };
  capacity?: {
    maxSessions?: number;
    activeSessions?: number;
    availableSessions?: number;
    loadPct?: number;
    saturated?: boolean;
    provisionAttempts?: number;
    provisionFailures?: number;
    noCapacityFailures?: number;
  };
  leases?: { active?: number; grace?: number; awaitingClient?: number; paying?: number; total?: number };
  payment?: { onchain?: boolean; payingSessions?: number };
  cost?: { basis?: string; sessionsCompleted?: number; sessionSeconds?: number };
  /** Present only on the bearer-gated `GET /node` detail surface. */
  sessions?: MediaNodeSession[];
}

export interface MediaNodeSession {
  sessionId: string;
  jobId: string;
  transport: string;
  ageS: number;
  sockets: number;
  recording: boolean;
  paying: boolean;
  lease: { state: "active" | "grace" | "awaiting-client" | string; expiresInS: number | null };
}

export interface NodeCost {
  /** Node identity (falls back to the configured origin when the node is down). */
  nodeId: string;
  origin: string;
  /** Jobs attributed to this node that carry a recorded costUsd. */
  jobs: number;
  /** Sum of `job.costUsd` — the Livepeer inference spend attributed here. */
  costUsd: number;
  /** Sessions this node provisioned (from media_sessions), when reachable. */
  sessions: number;
}

export interface MediaNodeReport {
  generatedAt: string;
  reachable: boolean;
  origin: string;
  node: { id: string; role: string; uptimeS: number } | null;
  capacity: NonNullable<MediaNodeHealth["capacity"]> | null;
  leases: NonNullable<MediaNodeHealth["leases"]> | null;
  payment: NonNullable<MediaNodeHealth["payment"]> | null;
  /** Per-session lease rows; empty when the detail surface is not configured. */
  sessions: MediaNodeSession[];
  /** True when the node's bearer-gated `/node` detail was readable. */
  detailAvailable: boolean;
  /** Node-side session meter (completed sessions + session seconds carried). */
  meter: NonNullable<MediaNodeHealth["cost"]> | null;
  cost: {
    /** How the money figure is derived — printed verbatim in the console/docs. */
    attribution: string;
    /** Fleet total over the nodes in `perNode`. */
    total: { nodes: number; jobs: number; costUsd: number };
    /** One entry per node; a single entry until a fleet exists. */
    perNode: NodeCost[];
  };
}

const ORIGIN_UNKNOWN = "";

/** Round money to 4dp so the readout matches `job.costUsd` precision. */
function money(v: number): number {
  return Number(v.toFixed(4));
}

/**
 * Build the console readout from the node health payload(s) and the durable
 * attribution rows. `health` is null when the node did not answer; `detail` is
 * the `GET /node` payload (null when unconfigured, unreachable, or rejected).
 */
export function buildMediaNodeReport(opts: {
  origin: string;
  health: MediaNodeHealth | null;
  detail?: MediaNodeHealth | null;
  mediaSessions: MediaSession[];
  jobs: Job[];
  now?: Date;
}): MediaNodeReport {
  const origin = (opts.origin ?? "").replace(/\/+$/, "");
  const health = opts.health ?? null;
  const detail = opts.detail ?? null;
  const nodeId = health?.node?.id || detail?.node?.id || (origin ? derivedNodeId(origin) : "media-0");

  // --- per-node cost attribution -----------------------------------------
  // jobId -> nodeId from the durable media_sessions rows. Jobs without a row
  // (or rows written before node_id existed) group under `unattributed` so the
  // total never silently drops spend.
  const nodeOfJob = new Map<string, string>();
  const sessionsPerNode = new Map<string, number>();
  for (const s of opts.mediaSessions) {
    const n = s.nodeId || "unattributed";
    nodeOfJob.set(s.jobId, n);
    sessionsPerNode.set(n, (sessionsPerNode.get(n) ?? 0) + 1);
  }
  const byNode = new Map<string, NodeCost>();
  const ensure = (id: string): NodeCost => {
    let e = byNode.get(id);
    if (!e) {
      e = { nodeId: id, origin: id === nodeId ? origin : "", jobs: 0, costUsd: 0, sessions: 0 };
      byNode.set(id, e);
    }
    return e;
  };
  // Surface the node we just talked to even with zero jobs, so the console shows
  // "0 jobs / load" instead of an empty panel. When the node is DOWN there is
  // nothing live to surface — the DB-attributed node ids carry the report.
  if (health) ensure(nodeId);
  for (const [n, count] of sessionsPerNode) ensure(n).sessions = count;
  for (const job of opts.jobs) {
    const cost = typeof job.costUsd === "number" && Number.isFinite(job.costUsd) ? job.costUsd : null;
    if (cost === null) continue;
    const entry = ensure(nodeOfJob.get(job.id) ?? "unattributed");
    entry.jobs += 1;
    entry.costUsd += cost;
  }
  const perNode = [...byNode.values()]
    .map((n) => ({ ...n, costUsd: money(n.costUsd) }))
    .sort((a, b) => b.costUsd - a.costUsd || (a.nodeId < b.nodeId ? -1 : 1));

  const sessions = detail?.sessions ?? [];
  return {
    generatedAt: (opts.now ?? new Date()).toISOString(),
    reachable: !!health && (health.status ?? "ok") === "ok",
    origin: origin || ORIGIN_UNKNOWN,
    node: health?.node
      ? { id: nodeId, role: health.node.role ?? "media", uptimeS: health.node.uptimeS ?? 0 }
      : null,
    capacity: health?.capacity ?? null,
    leases: health?.leases ?? null,
    payment: health?.payment ?? null,
    sessions,
    detailAvailable: !!detail,
    meter: (detail ?? health)?.cost ?? null,
    cost: {
      attribution: "job.costUsd joined to media_sessions.node_id (the node that carried the job's stream)",
      total: {
        nodes: perNode.length,
        jobs: perNode.reduce((s, n) => s + n.jobs, 0),
        costUsd: money(perNode.reduce((s, n) => s + n.costUsd, 0)),
      },
      perNode,
    },
  };
}

/** Best-effort readable node id from an origin when the node itself is down
 * (e.g. `http://media:4070` -> `media`). Never invents a fleet id. */
function derivedNodeId(origin: string): string {
  try {
    const u = new URL(origin);
    return u.hostname || "media-0";
  } catch {
    return "media-0";
  }
}
