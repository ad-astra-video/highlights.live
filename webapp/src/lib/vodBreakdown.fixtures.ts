// Test fixtures for the VOD cost & time breakdown (ADAAAA-7929).
//
// These mirror the response shape in the spec §4.2 VERBATIM (`sampled 18 /
// metered 18 / timed 12`, the seven cost nodes with four CPU-only, six time
// nodes that sum to `totalS`, one detached concurrent audio band). They are the
// only input to the panel's render tests until Inc 1 (`GET
// /api/admin/vod-breakdown`, ADAAAA-7928) is deployed — so if the server ever
// changes shape, these must move first and the tests will point at the drift.
import type { VodBreakdown, VodBreakdownFlow } from "./vodBreakdown";

function flowsFor(nodes: Array<{ key: string; usd?: number; s?: number }>): VodBreakdownFlow[] {
  return nodes.map((n) => ({
    source: "total",
    target: n.key,
    ...(n.usd !== undefined ? { usd: n.usd } : {}),
    ...(n.s !== undefined ? { s: n.s } : {}),
  }));
}

const COST_NODES = [
  { key: "perceive_gpu", label: "Perceive GPU session", usd: 0.0013, share: 0.005, cpu: false },
  { key: "decide_observe", label: "Decide · observe", usd: 0.2, share: 0.765, cpu: false },
  { key: "decide_confirm", label: "Decide · confirm", usd: 0.06, share: 0.23, cpu: false },
  { key: "cpu_extract", label: "Extract frames", usd: 0, share: 0, cpu: true },
  { key: "cpu_audio", label: "Audio gate", usd: 0, share: 0, cpu: true },
  { key: "cpu_clip", label: "Clip encode", usd: 0, share: 0, cpu: true },
  { key: "cpu_finalize", label: "Finalize", usd: 0, share: 0, cpu: true },
];

const TIME_NODES = [
  { key: "capacity_wait", label: "GPU capacity wait", s: 35, share: 0.073 },
  { key: "extract", label: "Extract frames", s: 130, share: 0.271 },
  { key: "analyze_net", label: "Analyze (perceive + decide)", s: 160, share: 0.333 },
  { key: "clip_encode", label: "Clip encode", s: 40, share: 0.083 },
  { key: "preroll", label: "Preroll", s: 20, share: 0.042 },
  { key: "finalize", label: "Finalize", s: 95, share: 0.198 },
];

/** The spec's `recent / limit 20` answer: 18 sampled, 12 timed (6 legacy). */
export function recentBreakdown(over: Partial<VodBreakdown> = {}): VodBreakdown {
  return {
    scope: { kind: "recent", limit: 20, from: "2026-10-28T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" },
    sampled: 18,
    metered: 18,
    timed: 12,
    rates: { decideFeeUsd: 0.01, perceivePerHourUsd: 0.01 },
    perRequest: {
      costUsd: 0.2613,
      wallClockS: 480,
      sourceS: 128,
      frames: 360,
      audioTriggers: 9,
      decideCalls: 26,
      confirmCalls: 6,
      clips: 3.6,
      rtf: 3.75,
      perVideoHourCostUsd: 7.35,
    },
    cost: { totalUsd: 0.2613, nodes: COST_NODES, flows: flowsFor(COST_NODES) },
    time: {
      totalS: 480,
      nodes: TIME_NODES,
      concurrent: [{ key: "audio_gate", label: "Audio gate (concurrent)", s: 25 }],
      flows: flowsFor(TIME_NODES),
    },
    excluded: { noCost: 2, noStageTimings: 6, live: 31 },
    ...over,
  };
}

/** Every job in the window predates `stageTimings` — cost works, time has no
 * sample at all (AC6 taken to its limit). */
export function untimedBreakdown(): VodBreakdown {
  return recentBreakdown({
    timed: 0,
    time: { totalS: 0, nodes: [], concurrent: [], flows: [] },
    excluded: { noCost: 2, noStageTimings: 18, live: 31 },
  });
}

/** Nothing metered in the window: the AC7 empty state, no zero-value sankey. */
export function emptyBreakdown(scope: VodBreakdown["scope"] = { kind: "days", days: 7 }): VodBreakdown {
  return recentBreakdown({
    scope,
    sampled: 0,
    metered: 0,
    timed: 0,
    perRequest: {
      costUsd: 0,
      wallClockS: 0,
      sourceS: 0,
      frames: 0,
      audioTriggers: 0,
      decideCalls: 0,
      confirmCalls: 0,
      clips: 0,
      rtf: 0,
      perVideoHourCostUsd: 0,
    },
    cost: {
      totalUsd: 0,
      nodes: COST_NODES.map((n) => ({ ...n, usd: 0, share: 0 })),
      flows: [],
    },
    time: { totalS: 0, nodes: [], concurrent: [], flows: [] },
    excluded: { noCost: 0, noStageTimings: 0, live: 0 },
  });
}
