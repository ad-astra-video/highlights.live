// ADAAAA-7929 (Inc 2 of ADAAAA-7925): the CLIENT half of the VOD cost & time
// breakdown. The spec (`/ADAAAA/issues/ADAAAA-7925#document-spec`, §4.2/§5) is
// the binding contract: Inc 1 owns the route `GET /api/admin/vod-breakdown` and
// the response shape below, and this module must not renegotiate it.
//
// Everything here is PURE except `fetchVodBreakdown` — the store, the sample /
// partial / empty copy, the overview strip and the sankey GEOMETRY are all
// plain functions so a test can assert link widths and conservation instead of
// eyeballing a chart. The component (`components/CostTimePanel.tsx`) only
// paints what this module returns.
//
// Two invariants are load-bearing and are asserted in vodBreakdown.test.ts:
//
//   1. Conservation. Every parent's children sum to the parent within
//      $0.0001 / 1 s. A sankey that does not conserve is a lie dressed as a
//      picture, so the geometry is derived from the values, never hand-placed.
//   2. Denominators never mix. Cost shares divide by the BILLED cost (CPU
//      stages carry `cpu: true` and $0 — they are annotated, never billed into
//      the 100%), time shares divide by `time.totalS`, which excludes the
//      concurrent audio gate.

import { api } from "./api";

/** The three scopes the panel offers, in display order. `recent` is the default. */
export type VodBreakdownScopeKind = "recent" | "days" | "job";

/** `Last 20 requests` / `Last 7 days` / `This request`. */
export type VodBreakdownMode = "per_request" | "total";

export const VOD_BREAKDOWN_DEFAULT_LIMIT = 20;
export const VOD_BREAKDOWN_DEFAULT_DAYS = 7;

export interface VodBreakdownScope {
  kind: VodBreakdownScopeKind;
  limit?: number;
  days?: number;
  jobId?: string;
  from?: string;
  to?: string;
}

export interface VodBreakdownCostNode {
  key: string;
  label: string;
  usd: number;
  /** Server-side share; recomputed locally so the chart cannot disagree with
   * its own denominator (see `costBilledTotal`). */
  share?: number;
  /** CPU-only stage: $0.00, rendered muted, never in the cost denominator. */
  cpu: boolean;
}

export interface VodBreakdownTimeNode {
  key: string;
  label: string;
  s: number;
  share?: number;
}

/** A band that runs beside the time chart instead of inside it (the Stage-A
 * audio gate overlaps analyze, so adding it would double-count the total). */
export interface VodBreakdownConcurrentNode {
  key: string;
  label: string;
  s: number;
}

export interface VodBreakdownFlow {
  source: string;
  target: string;
  usd?: number;
  s?: number;
}

/** `null` is the server's way of saying "no job in the sample recorded this"
 * (`sourceS` / `audioTriggers` / `confirmCalls` / `rtf` / `perVideoHourCostUsd`
 * are nullable in `services/server/src/vod-breakdown.ts`) — it is printed as
 * `—`, never coerced to `0`, because a fabricated zero would read as a
 * measurement. */
export interface VodBreakdownPerRequest {
  costUsd: number;
  wallClockS: number;
  sourceS: number | null;
  frames: number;
  audioTriggers: number | null;
  decideCalls: number;
  confirmCalls: number | null;
  clips: number;
  rtf: number | null;
  perVideoHourCostUsd: number | null;
}

export interface VodBreakdown {
  scope: VodBreakdownScope;
  sampled: number;
  metered: number;
  timed: number;
  rates: { decideFeeUsd: number; perceivePerHourUsd: number };
  perRequest: VodBreakdownPerRequest;
  cost: { totalUsd: number; nodes: VodBreakdownCostNode[]; flows: VodBreakdownFlow[] };
  time: {
    totalS: number;
    nodes: VodBreakdownTimeNode[];
    concurrent?: VodBreakdownConcurrentNode[];
    flows: VodBreakdownFlow[];
  };
  excluded: { noCost: number; noStageTimings: number; live: number };
}

/** Query params the panel sends for a scope. One place builds them, so the
 * store's fetch key and the request can never drift. */
export function vodBreakdownQuery(
  kind: VodBreakdownScopeKind,
  opts: { jobId?: string; limit?: number; days?: number } = {},
): string {
  if (kind === "days") {
    const days = opts.days ?? VOD_BREAKDOWN_DEFAULT_DAYS;
    return `?scope=days&days=${days}`;
  }
  if (kind === "job") {
    if (!opts.jobId) throw new Error("scope=job needs a jobId");
    return `?scope=job&jobId=${encodeURIComponent(opts.jobId)}`;
  }
  const limit = opts.limit ?? VOD_BREAKDOWN_DEFAULT_LIMIT;
  return `?scope=recent&limit=${limit}`;
}

/** `GET /api/admin/vod-breakdown` — admin-only on the server (403 for a
 * customer session, never a trimmed 200), so the panel only ever mounts behind
 * the `admin` gate. */
export async function fetchVodBreakdown(
  kind: VodBreakdownScopeKind,
  opts: { jobId?: string; limit?: number; days?: number } = {},
): Promise<VodBreakdown> {
  return api<VodBreakdown>(`/api/admin/vod-breakdown${vodBreakdownQuery(kind, opts)}`);
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The window the numbers cover, as the sample line names it — the empty state
 * reuses exactly this string so "no requests in <window>" is never anonymous. */
export function scopeWindowLabel(b: Pick<VodBreakdown, "scope">): string {
  const scope = b.scope || { kind: "recent" as VodBreakdownScopeKind };
  if (scope.kind === "days") return `last ${plural(scope.days ?? VOD_BREAKDOWN_DEFAULT_DAYS, "day")}`;
  if (scope.kind === "job") return "this request";
  return `last ${plural(scope.limit ?? VOD_BREAKDOWN_DEFAULT_LIMIT, "request")}`;
}

/** `18 requests · 12 with stage timings · last 20 requests`. */
export function sampleLine(b: Pick<VodBreakdown, "sampled" | "timed" | "scope">): string {
  return `${plural(b.sampled, "request")} · ${b.timed} with stage timings · ${scopeWindowLabel(b)}`;
}

/** `6 of 18 requests predate stage timing — time view covers 12`, or null when
 * the sample is fully instrumented. Legacy jobs predate `stageTimings`, so they
 * are counted here and excluded from the time chart — never fabricated. */
export function partialNote(b: Pick<VodBreakdown, "sampled" | "timed">): string | null {
  const missing = b.sampled - b.timed;
  if (missing <= 0) return null;
  return `${missing} of ${b.sampled} requests predate stage timing — time view covers ${b.timed}`;
}

/** True when the window holds no metered VOD request at all. AC7: an explicit
 * empty state naming the window, and NO zero-value sankey. */
export function isEmptyBreakdown(b: VodBreakdown): boolean {
  return b.metered <= 0 && !(b.cost.nodes || []).some((n) => n.usd > 0);
}

export function emptyStateLine(b: Pick<VodBreakdown, "scope" | "sampled">): string {
  // AC7's copy names the window. When requests WERE sampled but none recorded a
  // cost, "no completed VOD requests" would be false — say what is actually
  // true instead of hiding the population behind the empty state.
  const sampled = Number.isFinite(b.sampled) ? b.sampled : 0;
  if (sampled > 0) {
    return `No metered VOD requests in ${scopeWindowLabel(b)} (${sampled} completed, none recorded a cost)`;
  }
  return `No completed VOD requests in ${scopeWindowLabel(b)}`;
}

/** Sum of the BILLED cost nodes. CPU stages (`cpu: true`) are $0 and stay out of
 * the denominator, so the 100% statement stays true; `cost.totalUsd` is the
 * meter's own total and is what the top band prints. */
export function costBilledTotal(b: Pick<VodBreakdown, "cost">): number {
  return (b.cost.nodes || []).reduce((sum, n) => sum + (n.cpu ? 0 : n.usd || 0), 0);
}

/** Sum of the time nodes — the denominator for time shares. The concurrent
 * audio gate is NOT in `time.nodes`, so it can never inflate this total. */
export function timeTotalFromNodes(b: Pick<VodBreakdown, "time">): number {
  return (b.time.nodes || []).reduce((sum, n) => sum + (n.s || 0), 0);
}

/** Per-request → total multiplier. `Per request` is the default because the ask
 * is phrased in averages; `Total` is what an operator reconciles against the
 * month. Cost scales by the metered sample, time by the timed sample — the
 * denominators are different on purpose (they are different populations). */
export function modeFactor(mode: VodBreakdownMode, b: Pick<VodBreakdown, "metered" | "timed">): number {
  if (mode === "per_request") return 1;
  return Math.max(0, b.metered || 0);
}

export function modeFactorForTime(mode: VodBreakdownMode, b: Pick<VodBreakdown, "timed">): number {
  if (mode === "per_request") return 1;
  return Math.max(0, b.timed || 0);
}

/** Money: 4 decimals under $1 (the meter records fractions of a cent), 2 above.
 * Exactly `$0.00` for a CPU stage — a zero that is a fact, not a rounded loss. */
export function formatUsd(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  if (n === 0) return "$0.00";
  return Math.abs(n) < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

/** Seconds as `12.5s`, `0.045s` under 10 s (the server records 2 dp and a real
 * VOD run has sub-100 ms stages — `0.0s · 1.9%` would be a lie about where the
 * time went), or `3m 20s` past a minute. */
export function formatSeconds(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  if (Math.abs(n) < 10) return `${n.toFixed(2)}s`;
  if (Math.abs(n) < 60) return `${n.toFixed(1)}s`;
  const m = Math.floor(n / 60);
  const s = Math.round(n - m * 60);
  return `${m}m ${s}s`;
}

export function formatShare(share: number): string {
  const pct = (Number.isFinite(share) ? share : 0) * 100;
  return `${pct.toFixed(1)}%`;
}

// --- sankey geometry --------------------------------------------------------

export type SankeyUnit = "usd" | "s";
export type SankeyTone = "metered" | "cpu" | "concurrent";

export interface SankeyNodeInput {
  key: string;
  label: string;
  value: number;
  /** Cost stages that are CPU-only: $0.00, muted, out of the denominator. */
  cpu?: boolean;
  /** The detached audio band (time chart only). */
  concurrent?: boolean;
}

export interface SankeyBand {
  key: string;
  /** `Perceive GPU session · $0.0013 · 0.5%` (or `… · 35.0s · 7.3%`). */
  label: string;
  /** Bare label without the value/share suffix (for the `<title>` tooltip). */
  title: string;
  value: number;
  share: number;
  tone: SankeyTone;
  y: number;
  height: number;
}

export interface SankeyLink {
  key: string;
  source: string;
  target: string;
  value: number;
  share: number;
  /** Band thickness in plot units — the width a test asserts, not eyeballs. */
  width: number;
  /** Closed cubic band path (`M … L … C … L … C … Z`). */
  d: string;
  title: string;
}

export interface SankeyGeometry {
  unit: SankeyUnit;
  width: number;
  plotHeight: number;
  sourceX: number;
  sourceWidth: number;
  nodeX: number;
  nodeWidth: number;
  /** The 100% band. `value` equals the scope total (`cost.totalUsd` /
   * `time.totalS`) in per-request mode, and that times the sample in total mode. */
  top: {
    key: string;
    label: string;
    value: number;
    share: number;
    y: number;
    height: number;
  };
  nodes: SankeyBand[];
  links: SankeyLink[];
  /** Concurrent bands: drawn beside the chart with a badge, never summed. */
  detached: SankeyBand[];
}

const SANKEY_WIDTH = 640;
const SANKEY_ROW = 30;
const SANKEY_GAP = 6;
const SANKEY_NODE_WIDTH = 10;
const SANKEY_SOURCE_WIDTH = 8;

function bandValueLabel(unit: SankeyUnit, value: number): string {
  return unit === "usd" ? formatUsd(value) : formatSeconds(value);
}

/**
 * Build one sankey. Pure: same input → same numbers, so `CostTimePanel` has no
 * layout maths of its own.
 *
 * - `total` is the parent value (the 100%). Shares divide by it.
 * - `factor` multiplies values and the total for the total/per-request toggle,
 *   so shares stay identical in both modes (the picture is the same, only the
 *   printed numbers change).
 * - Links are derived one-per-node from the source band, with a thickness equal
 *   to `share × usable`, which is what makes "flows sum to the parent" a
 *   property of the geometry rather than a claim in a comment.
 */
export function buildSankey({
  nodes,
  total,
  unit,
  factor = 1,
  mode = "per_request",
}: {
  nodes: SankeyNodeInput[];
  total: number;
  unit: SankeyUnit;
  factor?: number;
  mode?: VodBreakdownMode;
}): SankeyGeometry {
  const f = mode === "per_request" ? 1 : Math.max(0, factor);
  const scaledTotal = (Number.isFinite(total) ? total : 0) * f;
  const ranked = nodes.filter((n) => !n.concurrent);
  const detachedInputs = nodes.filter((n) => n.concurrent);
  const rowCount = Math.max(1, ranked.length);
  const usable = Math.max(1, rowCount * SANKEY_ROW - (rowCount + 1) * SANKEY_GAP);
  const plotHeight = rowCount * SANKEY_ROW;

  const denominator = scaledTotal > 0 ? scaledTotal : 0;
  let cursor = SANKEY_GAP;

  const bands: SankeyBand[] = ranked.map((n) => {
    const value = (Number.isFinite(n.value) ? n.value : 0) * f;
    const share = n.cpu || denominator === 0 ? 0 : value / denominator;
    const height = n.cpu ? 0 : share * usable;
    const y = cursor;
    cursor += height + SANKEY_GAP;
    const title = n.label;
    const label = n.cpu
      ? `${title} · $0.00 · CPU (not billed)`
      : `${title} · ${bandValueLabel(unit, value)} · ${formatShare(share)}`;
    return {
      key: n.key,
      label,
      title,
      value,
      share,
      tone: n.cpu ? "cpu" : "metered",
      y,
      height,
    };
  });

  const links: SankeyLink[] = bands
    .filter((b) => b.tone !== "cpu" && b.height > 0)
    .map((b) => {
      const x0 = SANKEY_SOURCE_WIDTH;
      const x1 = SANKEY_WIDTH - SANKEY_NODE_WIDTH;
      const mid = x0 + (x1 - x0) / 2;
      const y0Top = b.y;
      const y0Bottom = b.y + b.height;
      const y1Top = b.y;
      const y1Bottom = b.y + b.height;
      const d =
        `M ${x0} ${y0Top} L ${x0} ${y0Bottom} ` +
        `C ${mid} ${y0Bottom}, ${mid} ${y1Bottom}, ${x1} ${y1Bottom} ` +
        `L ${x1} ${y1Top} ` +
        `C ${mid} ${y1Top}, ${mid} ${y0Top}, ${x0} ${y0Top} Z`;
      return {
        key: `total->${b.key}`,
        source: "total",
        target: b.key,
        value: b.value,
        share: b.share,
        width: b.height,
        d,
        title: `${b.title} · ${bandValueLabel(unit, b.value)} · ${formatShare(b.share)}`,
      };
    });

  const detached: SankeyBand[] = detachedInputs.map((n, i) => {
    const value = (Number.isFinite(n.value) ? n.value : 0) * f;
    return {
      key: n.key,
      label: `${n.label} · ${bandValueLabel(unit, value)} · concurrent`,
      title: n.label,
      value,
      share: 0,
      tone: "concurrent" as SankeyTone,
      y: i * SANKEY_ROW,
      height: 0,
    };
  });

  return {
    unit,
    width: SANKEY_WIDTH,
    plotHeight,
    sourceX: 0,
    sourceWidth: SANKEY_SOURCE_WIDTH,
    nodeX: SANKEY_WIDTH - SANKEY_NODE_WIDTH,
    nodeWidth: SANKEY_NODE_WIDTH,
    top: {
      key: "total",
      label: `${mode === "total" ? "Total" : "Per request"} · ${bandValueLabel(unit, scaledTotal)} · 100%`,
      value: scaledTotal,
      share: 1,
      y: 0,
      height: plotHeight,
    },
    nodes: bands,
    links,
    detached,
  };
}

/** The cost chart: shares divide by the billed total, CPU stages annotated at
 * $0.00. `top.value` is `cost.totalUsd × factor` — AC3 compares it directly. */
export function buildCostSankey(b: VodBreakdown, mode: VodBreakdownMode): SankeyGeometry {
  return buildSankey({
    nodes: (b.cost.nodes || []).map((n) => ({
      key: n.key,
      label: n.label,
      value: n.usd,
      cpu: n.cpu,
    })),
    total: b.cost.totalUsd,
    unit: "usd",
    factor: modeFactor(mode, b),
    mode,
  });
}

/** The time chart: shares divide by `time.totalS`; the concurrent audio gate is
 * detached, so it is never added to the total. */
export function buildTimeSankey(b: VodBreakdown, mode: VodBreakdownMode): SankeyGeometry {
  const nodes: SankeyNodeInput[] = (b.time.nodes || []).map((n) => ({
    key: n.key,
    label: n.label,
    value: n.s,
  }));
  for (const c of b.time.concurrent || []) {
    nodes.push({ key: c.key, label: c.label, value: c.s, concurrent: true });
  }
  return buildSankey({
    nodes,
    total: b.time.totalS,
    unit: "s",
    factor: modeFactorForTime(mode, b),
    mode,
  });
}

// --- overview strip ---------------------------------------------------------

export interface VodBreakdownOverviewItem {
  key: string;
  /** Always ends in `/req` (except RTF, which is a ratio by definition). */
  label: string;
  /** Printed value, e.g. `360.0`; `—` when the server recorded nothing. */
  value: string;
  /** The `perRequest` field it came from — AC9 asserts value === raw (`null`
   * when the field is unmeasured, which must print `—`). */
  raw: number | null;
}

/** `—` for an unmeasured field: a dash says "not recorded", `0.0` would say
 * "measured zero" and the two are very different claims. */
function orDash(v: number | null, fmt: (n: number) => string): string {
  return v == null || !Number.isFinite(v) ? "—" : fmt(v);
}

/** AC9: the strip is `perRequest` verbatim, each number labelled `/req`. It is
 * per-request by definition, so the mode toggle never touches it. */
export function overviewItems(b: VodBreakdown): VodBreakdownOverviewItem[] {
  const p = b.perRequest;
  return [
    { key: "source", label: "source min/req", value: orDash(p.sourceS, (n) => (n / 60).toFixed(1)), raw: p.sourceS },
    { key: "frames", label: "frames/req", value: p.frames.toFixed(1), raw: p.frames },
    {
      key: "audio",
      label: "audio triggers/req",
      value: orDash(p.audioTriggers, (n) => n.toFixed(1)),
      raw: p.audioTriggers ?? null,
    },
    { key: "decide", label: "decide calls/req", value: p.decideCalls.toFixed(1), raw: p.decideCalls },
    { key: "clips", label: "clips/req", value: p.clips.toFixed(1), raw: p.clips },
    { key: "cost", label: "$/req", value: formatUsd(p.costUsd), raw: p.costUsd },
    { key: "seconds", label: "s/req", value: formatSeconds(p.wallClockS), raw: p.wallClockS },
    { key: "rtf", label: "RTF", value: orDash(p.rtf, (n) => n.toFixed(2)), raw: p.rtf ?? null },
  ];
}

// --- store ------------------------------------------------------------------

export interface VodBreakdownState {
  open: boolean;
  scope: VodBreakdownScopeKind;
  mode: VodBreakdownMode;
  status: "idle" | "loading" | "ready" | "error";
  data: VodBreakdown | null;
  error: string | null;
}

export type VodBreakdownFetcher = (
  scope: VodBreakdownScopeKind,
  opts: { jobId?: string },
) => Promise<VodBreakdown>;

export interface VodBreakdownStore {
  getState(): VodBreakdownState;
  subscribe(listener: () => void): () => void;
  open(): void;
  close(): void;
  setScope(scope: VodBreakdownScopeKind): void;
  setMode(mode: VodBreakdownMode): void;
  /** Number of requests issued so far — the AC2 evidence counter. */
  fetchCount(): number;
}

const INITIAL_STATE: VodBreakdownState = {
  open: false,
  scope: "recent",
  mode: "per_request",
  status: "idle",
  data: null,
  error: null,
};

/**
 * The panel's whole data lifecycle, as a plain object so it is testable without
 * a DOM.
 *
 * Contract (spec §5, AC2): fetch ONCE on open and ONCE per scope change. There
 * is no polling, no SSE subscription and no refetch on a mode change — the mode
 * toggle only rescales numbers the client already holds. Responses are applied
 * only when they belong to the latest request, so a slow `days` answer can
 * never overwrite a newer `recent` one.
 */
export function createVodBreakdownStore(
  fetcher: VodBreakdownFetcher,
  opts: { jobId?: string } = {},
): VodBreakdownStore {
  let state: VodBreakdownState = { ...INITIAL_STATE };
  const listeners = new Set<() => void>();
  let fetchCount = 0;
  let seq = 0;

  const emit = () => {
    for (const l of listeners) l();
  };
  const set = (patch: Partial<VodBreakdownState>) => {
    state = { ...state, ...patch };
    emit();
  };

  const load = () => {
    const requestSeq = ++seq;
    fetchCount += 1;
    set({ status: "loading", error: null });
    fetcher(state.scope, opts)
      .then((data) => {
        if (requestSeq !== seq) return;
        set({ status: "ready", data, error: null });
      })
      .catch((err: any) => {
        if (requestSeq !== seq) return;
        // No silent zero-state: the server's message is what the panel shows.
        set({ status: "error", data: null, error: String(err?.message || err) });
      });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open() {
      if (state.open) return;
      set({ open: true });
      load();
    },
    close() {
      if (!state.open) return;
      seq += 1; // drop an in-flight answer for a panel the user closed
      set({ open: false, status: "idle", data: null, error: null });
    },
    setScope(scope) {
      if (scope === state.scope) return;
      set({ scope });
      if (state.open) load();
    },
    setMode(mode) {
      if (mode === state.mode) return;
      set({ mode }); // no fetch: the data is mode-independent
    },
    fetchCount: () => fetchCount,
  };
}

export const SCOPE_LABELS: Record<VodBreakdownScopeKind, string> = {
  recent: `Last ${VOD_BREAKDOWN_DEFAULT_LIMIT} requests`,
  days: `Last ${VOD_BREAKDOWN_DEFAULT_DAYS} days`,
  job: "This request",
};

export const MODE_LABELS: Record<VodBreakdownMode, string> = {
  per_request: "Per request",
  total: "Total",
};
