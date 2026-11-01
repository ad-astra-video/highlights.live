// Pure formatting for the media-node strip (ADAAAA-6869 Phase 4, ADAAAA-7655).
//
// The strip is the operator's view of how loaded the media node is and what the
// node's sessions cost. It polls GET /media/node (control-plane join of the
// node's /health + the durable media_sessions.node_id -> jobs.costUsd
// attribution), so the shape below mirrors services/server/src/media-node.ts
// MediaNodeReport for only the fields the strip renders.
//
// Kept DOM-free so the formatting is unit-testable in the node test environment:
// the component is a thin renderer over nodeStripParts().

export interface MediaNodeStatus {
  reachable: boolean;
  node: { id: string; role?: string; uptimeS?: number } | null;
  capacity: {
    maxSessions: number;
    activeSessions: number;
    availableSessions?: number;
    loadPct: number;
    saturated: boolean;
  } | null;
  leases: { active: number; grace: number; awaitingClient: number; paying: number; total?: number } | null;
  payment: { onchain: boolean; payingSessions: number } | null;
  cost?: {
    total: { nodes: number; jobs: number; costUsd: number };
    perNode: { nodeId: string; jobs: number; costUsd: number; sessions?: number }[];
  };
}

export type StripTone = "ok" | "bad" | "warn" | "muted";

export interface StripPart {
  id: string;
  text: string;
  tone?: StripTone;
  /** Secondary attribution row (per-node spend), rendered dimmer than the totals. */
  detail?: boolean;
}

// Poll interval for the node readout. Cheap (one proxied GET) and slow enough
// that an idle console does not hammer the media node.
export const NODE_POLL_MS = 6000;

// Legacy rows carry no node id (they predate the attribution column), so the
// server groups them under this bucket. Spend is never dropped silently, and we
// render those rows last, after the nodes that actually served the sessions.
export const UNATTRIBUTED_NODE = "unattributed";

function money(usd: number): string {
  return `$${(Number.isFinite(usd) ? usd : 0).toFixed(2)}`;
}

// One token per spend attribution row, deterministic order: real nodes first
// (largest spend first), then the `unattributed` legacy bucket.
export function costRows(
  perNode: { nodeId: string; jobs: number; costUsd: number }[] | undefined
): StripPart[] {
  const rows = [...(perNode ?? [])];
  rows.sort((a, b) => {
    const legacy = Number(a.nodeId === UNATTRIBUTED_NODE) - Number(b.nodeId === UNATTRIBUTED_NODE);
    if (legacy !== 0) return legacy;
    if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd;
    return a.nodeId.localeCompare(b.nodeId);
  });
  return rows.map((row) => ({
    id: `spend-${row.nodeId}`,
    text: `${row.nodeId} ${money(row.costUsd)} / ${row.jobs} job(s)`,
    detail: true,
    tone: row.nodeId === UNATTRIBUTED_NODE ? "muted" : undefined,
  }));
}

export function nodeStripParts(status: MediaNodeStatus | null): StripPart[] {
  if (!status) return [{ id: "waiting", text: "waiting for node readout…", tone: "muted" }];

  const parts: StripPart[] = [
    {
      id: "node",
      text: `${status.node?.id ?? "media node"} ${status.reachable ? "healthy" : "unreachable"}`,
      tone: status.reachable ? "ok" : "bad",
    },
  ];

  if (status.capacity) {
    const { activeSessions, maxSessions, loadPct, saturated } = status.capacity;
    parts.push({ id: "load", text: `load ${activeSessions}/${maxSessions} sessions (${loadPct}%)` });
    if (saturated) parts.push({ id: "saturated", text: "saturated", tone: "warn" });
  }

  if (status.leases) {
    parts.push({
      id: "leases",
      text: `leases ${status.leases.active} active · ${status.leases.grace} grace · ${status.leases.awaitingClient} waiting`,
    });
  }

  if (status.payment) {
    parts.push({
      id: "paying",
      text: status.payment.onchain ? `${status.payment.payingSessions} paying` : "offchain",
      tone: status.payment.onchain ? undefined : "warn",
    });
  }

  if (status.cost?.total) {
    const { costUsd, jobs, nodes } = status.cost.total;
    parts.push({ id: "spend-total", text: `node spend ${money(costUsd)} over ${jobs} job(s) on ${nodes} node(s)` });
    parts.push(...costRows(status.cost.perNode));
  }

  return parts;
}
