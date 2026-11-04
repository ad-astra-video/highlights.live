import { useEffect, useRef, useSyncExternalStore } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import {
  buildCostSankey,
  buildTimeSankey,
  createVodBreakdownStore,
  emptyStateLine,
  fetchVodBreakdown,
  isEmptyBreakdown,
  MODE_LABELS,
  overviewItems,
  partialNote,
  sampleLine,
  SCOPE_LABELS,
  scopeWindowLabel,
  type SankeyGeometry,
  type VodBreakdown,
  type VodBreakdownFetcher,
  type VodBreakdownMode,
  type VodBreakdownScopeKind,
  type VodBreakdownState,
} from "../lib/vodBreakdown";

// ADAAAA-7929 (Inc 2 of ADAAAA-7925): `Cost & time` — the operator-facing
// sankey panel for where a VOD request's dollars and seconds go.
//
// Two surfaces, one gate:
//
//   `CostTimeToggle`  — the button, mounted ONLY inside the admin Analysis
//                       toolbar, immediately left of `See detail`. Same shape
//                       and classes as `SeeDetailToggle` (JobDetail.tsx) so the
//                       row stays visually uniform.
//   `CostTimePanel`   — the panel, mounted below the sticky toolbar while the
//                       toggle is ON.
//
// ADAAAA-7727 is why the gate is here and in the page: cost, decide calls and
// perceive seconds are admin-gated internals, and the route itself answers 403
// to a customer session. A non-admin render must produce NO toggle and NO
// request, so both components take `admin` and return null when it is false.
//
// Everything numeric comes from `lib/vodBreakdown.ts` (pure + unit-tested);
// this file is paint only. No chart library, no new dependency: hand-rolled
// inline SVG in the house style of `StreamHealthStrip` / `SummaryLadder`.

/** Themes by node tone — tokens only (`index.css` `@theme`). */
const BAND_TONE: Record<"metered" | "cpu" | "concurrent", { rect: string; text: string }> = {
  metered: { rect: "fill-neon/25", text: "fill-neon" },
  cpu: { rect: "fill-mut/15", text: "fill-mut" },
  concurrent: { rect: "fill-purple/25", text: "fill-purple" },
};

/**
 * The `Cost & time` toggle. `admin=false` renders nothing at all — not a
 * disabled button — because the existence of the control is itself internal
 * information.
 */
export function CostTimeToggle({
  admin,
  on,
  onToggle,
  disabled = false,
}: {
  admin: boolean;
  on: boolean;
  onToggle?: () => void;
  disabled?: boolean;
}) {
  if (!admin) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled || !onToggle}
      aria-pressed={on}
      data-cost-time-toggle
      data-active={on ? "true" : undefined}
      className={`rounded border px-2 py-1 text-xs font-bold uppercase tracking-wide ${
        on ? "border-neon/60 bg-neon/10 text-neon" : "border-mut/40 text-mut hover:border-neon hover:text-neon"
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      Cost &amp; time
    </button>
  );
}

/**
 * One sankey. The top band is the 100% (its printed value is the scope total);
 * each child band's thickness is `share × usable`, so the picture conserves by
 * construction. A `<title>` on every band carries the same string the label
 * prints, so hover never tells a different story from the label.
 */
export function SankeyChart({
  kind,
  geometry,
  title,
}: {
  kind: "cost" | "time";
  geometry: SankeyGeometry;
  title: string;
}) {
  const height = geometry.plotHeight + 4;
  return (
    <div className="rounded-lg border border-neon/20 bg-black/30 p-3" data-sankey-card={kind}>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-xs font-bold uppercase tracking-wide text-neon" data-sankey-heading={kind}>
          {title}
        </span>
        <span className="text-xs text-mut" data-sankey-top={kind}>
          {geometry.top.label}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${geometry.width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`${title} sankey`}
        data-sankey={kind}
        data-sankey-top-value={geometry.top.value}
      >
        {/* The 100% band: the whole column, so "in" equals everything that
            leaves it. */}
        <rect
          x={geometry.sourceX}
          y={0}
          width={geometry.sourceWidth}
          height={geometry.plotHeight}
          className="fill-neon/40"
        >
          <title>{geometry.top.label}</title>
        </rect>
        {geometry.links.map((l) => (
          <path key={l.key} d={l.d} className="fill-neon/15" data-sankey-link={l.target}>
            <title>{l.title}</title>
          </path>
        ))}
        {geometry.nodes.map((n) => {
          const tone = BAND_TONE[n.tone] || BAND_TONE.metered;
          return (
            <g key={n.key} data-sankey-node={n.key} data-sankey-tone={n.tone}>
              {n.height > 0 && (
                <rect
                  x={geometry.nodeX}
                  y={n.y}
                  width={geometry.nodeWidth}
                  height={n.height}
                  className={tone.rect}
                />
              )}
              <text
                x={geometry.nodeX - 6}
                y={n.y + Math.max(n.height, 0) / 2 + 4}
                textAnchor="end"
                className={`text-xs ${tone.text}`}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      {/* Concurrent work: drawn beside the chart with a badge, never summed into
          the total above (spec D7). */}
      {geometry.detached.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2" data-sankey-detached={kind}>
          {geometry.detached.map((d) => (
            <span
              key={d.key}
              className="inline-flex items-center gap-1 rounded-full border border-purple/40 px-2 py-0.5 text-xs text-purple"
              data-sankey-concurrent={d.key}
            >
              <span className="rounded-full bg-purple/20 px-1 text-xs font-bold uppercase tracking-wide">
                concurrent
              </span>
              {d.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** The overview strip (AC9): `perRequest` verbatim, every number labelled
 * `/req`. Rendered even in the partial state — the overview is a cost-side read,
 * and cost stays valid for legacy jobs. */
function OverviewStrip({ data }: { data: VodBreakdown }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs" data-cost-overview>
      {overviewItems(data).map((item) => (
        <span key={item.key} className="text-mut" data-cost-overview-item={item.key}>
          <span className="font-mono text-ink" data-cost-overview-value={item.key}>
            {item.value}
          </span>{" "}
          {item.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Pure view: the whole panel for ONE state. Kept separate from `CostTimePanel`
 * so the loading / empty / partial / error states can be pinned by an SSR test
 * (this package has no jsdom), and so a screenshot-grade DOM dump exists for
 * every edge case without needing a live box.
 */
export function CostTimeView({
  state,
  onScope,
  onMode,
  onClose,
}: {
  state: VodBreakdownState;
  onScope: (scope: VodBreakdownScopeKind) => void;
  onMode: (mode: VodBreakdownMode) => void;
  onClose?: () => void;
}) {
  const data = state.data;
  const windowLabel = data ? scopeWindowLabel(data) : SCOPE_LABELS[state.scope].toLowerCase();
  return (
    <section
      className="mt-3 rounded-lg border border-neon/40 bg-card/60 p-4"
      data-cost-time-panel
      data-cost-time-state={state.status}
      data-cost-time-scope={state.scope}
      data-cost-time-mode={state.mode}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold uppercase tracking-wide text-neon">Cost &amp; time</span>
        <div className="flex items-center gap-1" data-cost-time-scopes>
          {(Object.keys(SCOPE_LABELS) as VodBreakdownScopeKind[]).map((scope) => {
            const active = state.scope === scope;
            return (
              <button
                key={scope}
                type="button"
                onClick={() => onScope(scope)}
                data-scope-btn={scope}
                data-active={active ? "true" : undefined}
                aria-pressed={active}
                className={`rounded-full border px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
                  active ? "border-neon/60 bg-neon/10 text-neon" : "border-mut/30 text-mut hover:border-neon hover:text-neon"
                }`}
              >
                {SCOPE_LABELS[scope]}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1" data-cost-time-modes>
          {(Object.keys(MODE_LABELS) as VodBreakdownMode[]).map((mode) => {
            const active = state.mode === mode;
            return (
              <button
                key={mode}
                type="button"
                onClick={() => onMode(mode)}
                data-mode-btn={mode}
                data-active={active ? "true" : undefined}
                aria-pressed={active}
                className={`rounded border px-2 py-0.5 text-xs font-bold uppercase tracking-wide ${
                  active ? "border-purple/60 bg-purple/10 text-purple" : "border-mut/30 text-mut hover:border-purple hover:text-purple"
                }`}
              >
                {MODE_LABELS[mode]}
              </button>
            );
          })}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded border border-mut/40 px-2 py-0.5 text-xs text-mut hover:border-neon hover:text-neon"
            data-cost-time-close
          >
            Close
          </button>
        )}
      </div>

      {state.status === "loading" || state.status === "idle" ? (
        <div className="mt-3 flex items-center gap-2 text-sm text-mut" data-cost-time-loading>
          <Loader2 className="h-4 w-4 animate-spin" /> Loading breakdown…
        </div>
      ) : state.status === "error" ? (
        // The server's message, not a zero-state: a 403/500 must be visible.
        <div className="mt-3 rounded border border-red/40 bg-red/10 px-3 py-2 text-sm text-red" data-cost-time-error>
          <span className="mr-2 inline-flex items-center gap-1 font-bold uppercase tracking-wide">
            <AlertTriangle className="h-4 w-4" /> Breakdown unavailable
          </span>
          {state.error || "unknown error"}
        </div>
      ) : !data ? (
        <div className="mt-3 text-sm text-mut" data-cost-time-error>
          Breakdown unavailable: no payload returned.
        </div>
      ) : isEmptyBreakdown(data) ? (
        // AC7: name the window, and draw NO zero-value sankey.
        <div className="mt-3 text-sm text-mut" data-cost-time-empty>
          {emptyStateLine(data)}
        </div>
      ) : (
        <>
          <div className="mt-2 text-xs text-mut" data-cost-time-sample>
            {sampleLine(data)}
          </div>
          {partialNote(data) && (
            <div className="mt-1 text-xs text-yellow" data-cost-time-partial>
              {partialNote(data)}
            </div>
          )}
          <div className="mt-3">
            <OverviewStrip data={data} />
          </div>
          <div className="mt-3 flex flex-col gap-3">
            <SankeyChart kind="cost" geometry={buildCostSankey(data, state.mode)} title="Cost" />
            {data.time.nodes && data.time.nodes.length > 0 ? (
              <SankeyChart kind="time" geometry={buildTimeSankey(data, state.mode)} title="Time" />
            ) : (
              // Every request in the window predates stage timing — say so
              // instead of drawing an empty frame.
              <div className="text-xs text-mut" data-cost-time-no-time>
                No stage timings recorded in {scopeWindowLabel(data)} — the time view needs instrumented
                requests.
              </div>
            )}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-mut" data-cost-time-footnote>
            <span data-cost-time-basis>
              basis: list meter (decide $ {data.rates.decideFeeUsd.toFixed(2)}/call · perceive $
              {data.rates.perceivePerHourUsd.toFixed(2)}/hr) — not COGS
            </span>
            <span data-cost-time-denominators>
              cost n={data.metered} · time n={data.timed}
            </span>
            <span data-cost-time-excluded>
              excluded: {data.excluded.noCost} no cost · {data.excluded.noStageTimings} no stage timings
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The stateful panel: owns one store (fetch on open + on scope change only, per
 * `createVodBreakdownStore`), and paints `CostTimeView`.
 *
 * `fetchBreakdown` is injectable for tests; production always passes the module's
 * `fetchVodBreakdown`, whose identity is stable, so the store is not re-created
 * on a parent render.
 */
export function CostTimePanel({
  admin,
  jobId,
  fetchBreakdown = fetchVodBreakdown,
  onClose,
}: {
  admin: boolean;
  jobId?: string;
  fetchBreakdown?: VodBreakdownFetcher;
  onClose?: () => void;
}) {
  const storeRef = useRef<ReturnType<typeof createVodBreakdownStore> | null>(null);
  if (!storeRef.current) storeRef.current = createVodBreakdownStore(fetchBreakdown, { jobId });
  const store = storeRef.current;
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);

  useEffect(() => {
    if (!admin) return;
    store.open();
    return () => store.close();
  }, [store, admin]);

  if (!admin) return null;
  return <CostTimeView state={state} onScope={store.setScope} onMode={store.setMode} onClose={onClose} />;
}
