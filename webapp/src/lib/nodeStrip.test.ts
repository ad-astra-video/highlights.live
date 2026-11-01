import { describe, expect, it } from "vitest";
import { costRows, nodeStripParts, NODE_POLL_MS, type MediaNodeStatus } from "./nodeStrip";

// ADAAAA-7655: the live console strip must render BOTH the saturated flag and
// the cost.perNode[] attribution rows (acceptance items 2 and 4 on ADAAAA-7654).
// This is the pure formatting behind the strip, so the exact text the operator
// sees is asserted here without a DOM.

function report(over: Partial<MediaNodeStatus> = {}): MediaNodeStatus {
  return {
    reachable: true,
    node: { id: "media-0", role: "media", uptimeS: 412 },
    capacity: { maxSessions: 1, activeSessions: 0, availableSessions: 1, loadPct: 0, saturated: false },
    leases: { active: 0, grace: 0, awaitingClient: 0, paying: 0, total: 0 },
    payment: { onchain: true, payingSessions: 0 },
    cost: {
      total: { nodes: 2, jobs: 84, costUsd: 26.6462 },
      perNode: [
        { nodeId: "unattributed", jobs: 84, costUsd: 26.6462, sessions: 4 },
        { nodeId: "media-0", jobs: 0, costUsd: 0, sessions: 0 },
      ],
    },
    ...over,
  };
}

function part(status: MediaNodeStatus | null, id: string) {
  return nodeStripParts(status).find((p) => p.id === id);
}

describe("nodeStripParts — capacity/health", () => {
  it("names the node and marks it healthy", () => {
    const node = part(report(), "node")!;
    expect(node.text).toBe("media-0 healthy");
    expect(node.tone).toBe("ok");
  });

  it("renders load as n/max sessions (pct)", () => {
    expect(part(report(), "load")!.text).toBe("load 0/1 sessions (0%)");
  });

  it("renders the saturated badge only when capacity is exhausted", () => {
    const idle = report();
    expect(part(idle, "saturated")).toBeUndefined();

    const full = report({
      capacity: { maxSessions: 1, activeSessions: 1, availableSessions: 0, loadPct: 100, saturated: true },
    });
    const badge = part(full, "saturated")!;
    expect(badge.text).toBe("saturated");
    expect(badge.tone).toBe("warn");
    expect(part(full, "load")!.text).toBe("load 1/1 sessions (100%)");
  });

  it("renders the lease split and paying count", () => {
    const full = report({
      capacity: { maxSessions: 1, activeSessions: 1, availableSessions: 0, loadPct: 100, saturated: true },
      leases: { active: 1, grace: 0, awaitingClient: 0, paying: 1, total: 1 },
      payment: { onchain: true, payingSessions: 1 },
    });
    expect(part(full, "leases")!.text).toBe("leases 1 active · 0 grace · 0 waiting");
    expect(part(full, "paying")!.text).toBe("1 paying");
  });

  it("still reports spend when the node is unreachable (attribution is DB-derived)", () => {
    const down = report({ reachable: false, node: { id: "media-0" }, capacity: null, leases: null, payment: null });
    const node = part(down, "node")!;
    expect(node.text).toBe("media-0 unreachable");
    expect(node.tone).toBe("bad");
    expect(part(down, "spend-total")).toBeDefined();
    expect(part(down, "spend-unattributed")).toBeDefined();
  });

  it("renders a waiting token before the first poll resolves", () => {
    const parts = nodeStripParts(null);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ id: "waiting", text: "waiting for node readout…", tone: "muted" });
  });
});

describe("nodeStripParts — per-node cost attribution", () => {
  it("renders every cost.perNode[] row, totals plus one row per node", () => {
    const parts = nodeStripParts(report());
    expect(part(report(), "spend-total")!.text).toBe("node spend $26.65 over 84 job(s) on 2 node(s)");

    const rows = parts.filter((p) => p.id.startsWith("spend-") && p.id !== "spend-total");
    expect(rows.map((r) => r.id)).toEqual(["spend-media-0", "spend-unattributed"]);
    expect(rows.map((r) => r.text)).toEqual(["media-0 $0.00 / 0 job(s)", "unattributed $26.65 / 84 job(s)"]);
    expect(rows.every((r) => r.detail)).toBe(true);
  });

  it("puts the unattributed legacy bucket last even when it holds all the spend", () => {
    const ids = costRows([
      { nodeId: "unattributed", jobs: 84, costUsd: 26.6462 },
      { nodeId: "media-1", jobs: 2, costUsd: 0.5 },
      { nodeId: "media-0", jobs: 9, costUsd: 4.21 },
    ]).map((r) => r.id);
    expect(ids).toEqual(["spend-media-0", "spend-media-1", "spend-unattributed"]);
  });

  it("formats money to cents and degrades a missing/odd value to $0.00", () => {
    const rows = costRows([{ nodeId: "media-0", jobs: 1, costUsd: Number.NaN }]);
    expect(rows[0].text).toBe("media-0 $0.00 / 1 job(s)");
    expect(costRows(undefined)).toEqual([]);
  });

  it("publishes a 6 s poll cadence", () => {
    expect(NODE_POLL_MS).toBe(6000);
  });
});
