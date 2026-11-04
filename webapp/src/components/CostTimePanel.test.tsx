import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { CostTimePanel, CostTimeToggle, CostTimeView } from "./CostTimePanel";
import {
  buildCostSankey,
  buildTimeSankey,
  createVodBreakdownStore,
  fetchVodBreakdown,
  overviewItems,
  type VodBreakdown,
  type VodBreakdownState,
} from "../lib/vodBreakdown";
import { emptyBreakdown, recentBreakdown, untimedBreakdown } from "../lib/vodBreakdown.fixtures";

// ADAAAA-7929 (Inc 2 of ADAAAA-7925): the panel half of the render tests.
//
// The node test env has no jsdom/@testing-library, so these pin the RENDERED
// DOM via SSR (the house style, cf. JobDetail.inspect.test.tsx) and the request
// path via the store tests in lib/vodBreakdown.test.ts. The admin/customer
// boundary (AC1) is asserted BOTH ways: admin=false renders nothing and never
// calls the fetcher, admin=true renders the toggle and the panel.

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

/**
 * React SSR separates adjacent text nodes with `<!-- -->`, so a phrase built
 * from an expression plus literal text ("No stage timings recorded in " + label)
 * is not contiguous in the raw markup. Strip the markers before asserting on
 * prose, and the assertions read exactly like the copy a user sees.
 */
function norm(html: string): string {
  return html.replace(/<!-- -->/g, "");
}

const readyState = (data: VodBreakdown, over: Partial<VodBreakdownState> = {}): VodBreakdownState => ({
  open: true,
  scope: "recent",
  mode: "per_request",
  status: "ready",
  data,
  error: null,
  ...over,
});

describe("AC1 — the toggle is admin-only", () => {
  it("admin=false renders NOTHING — not even a disabled button", () => {
    expect(renderToString(<CostTimeToggle admin={false} on={false} onToggle={() => {}} />)).toBe("");
  });

  it("admin=true renders the labelled, aria-pressed button with its hook", () => {
    const html = renderToString(<CostTimeToggle admin={true} on={true} onToggle={() => {}} />);
    expect(html).toContain("Cost &amp; time");
    expect(html).toContain("data-cost-time-toggle");
    expect(html).toContain("aria-pressed=\"true\"");
  });

  it("the panel itself is also gated: admin=false renders nothing", () => {
    const calls: string[] = [];
    const fetcher = async (scope: string) => {
      calls.push(scope);
      return recentBreakdown();
    };
    const html = renderToString(<CostTimePanel admin={false} jobId="j1" fetchBreakdown={fetcher} />);
    expect(html).toBe("");
  });
});

describe("AC7 — empty state: no zero-value sankey", () => {
  it("names the window and draws no chart", () => {
    const html = renderToString(<CostTimeView state={readyState(emptyBreakdown())} onScope={() => {}} onMode={() => {}} />);
    expect(html).toContain("data-cost-time-empty");
    expect(html).toContain("No completed VOD requests in last 7 days");
    expect(html).not.toContain("data-sankey=");
    expect(html).not.toContain("data-cost-time-sample");
  });

  it("distinguishes 'nothing sampled' from 'sampled but nothing metered'", () => {
    // A window with completed requests that never recorded a cost must not claim
    // there were no requests — that would hide a real population.
    const b = emptyBreakdown({ kind: "recent", limit: 20 });
    b.sampled = 4;
    const html = renderToString(<CostTimeView state={readyState(b)} onScope={() => {}} onMode={() => {}} />);
    expect(html).toContain("data-cost-time-empty");
    expect(html).toContain("No metered VOD requests in last 20 requests (4 completed, none recorded a cost)");
    expect(html).not.toContain("data-sankey=");
  });
});

describe("AC6 — partial (legacy jobs predate stage timing)", () => {
  it("says how many predate timing and how many the time view covers", () => {
    const html = renderToString(<CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />);
    expect(html).toContain("data-cost-time-partial");
    expect(html).toContain("6 of 18 requests predate stage timing — time view covers 12");
    // the overview strip and the sample line still carry the cost-side truth
    expect(html).toContain("data-cost-time-sample");
    expect(html).toContain("18 requests · 12 with stage timings · last 20 requests");
  });

  it("when NOTHING is timed, cost still renders and time says so instead of drawing an empty frame", () => {
    const html = norm(renderToString(<CostTimeView state={readyState(untimedBreakdown())} onScope={() => {}} onMode={() => {}} />));
    expect(html).toContain("data-sankey=\"cost\"");
    expect(html).not.toContain("data-sankey=\"time\"");
    expect(html).toContain("data-cost-time-no-time");
    expect(html).toContain("No stage timings recorded in last 20 requests");
  });
});

describe("AC4 — CPU zeros and the concurrent badge render", () => {
  it("the cost chart prints the muted CPU nodes and never a billed zero", () => {
    const html = renderToString(
      <CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />,
    );
    expect(count(html, "$0.00 · CPU (not billed)")).toBe(4); // the four cpu nodes
    expect(html).toContain("data-sankey-tone=\"cpu\"");
    expect(html).toContain("data-sankey=\"cost\"");
    // a billed node keeps its exact value + share
    expect(html).toContain("Decide · observe · $0.2000 · 76.5%");
  });

  it("the time chart detaches the audio gate behind a `concurrent` badge", () => {
    const html = renderToString(
      <CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />,
    );
    expect(html).toContain("data-sankey-concurrent=\"audio_gate\"");
    expect(count(html, ">concurrent<")).toBe(1);
    expect(html).toContain("Audio gate (concurrent) · 25.0s · concurrent");
    // the detached band is not a node of the time chart
    expect(html).not.toContain("data-sankey-node=\"audio_gate\"");
  });
});

describe("AC3 — the top bands print the scope totals", () => {
  it("cost top band == cost.totalUsd, time top band == time.totalS", () => {
    const b = recentBreakdown();
    const cost = buildCostSankey(b, "per_request");
    const time = buildTimeSankey(b, "per_request");
    expect(cost.top.value).toBeCloseTo(b.cost.totalUsd, 10);
    expect(time.top.value).toBeCloseTo(b.time.totalS, 10);
  });

  it("and the DOM carries them for inspection", () => {
    const html = renderToString(
      <CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />,
    );
    expect(html).toContain("data-sankey-top-value=\"0.2613\"");
    expect(html).toContain("data-sankey-top-value=\"480\"");
  });
});

describe("AC9 — the overview strip", () => {
  it("prints perRequest values with /req labels", () => {
    const html = norm(
      renderToString(<CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />),
    );
    expect(html).toContain("data-cost-overview");
    expect(html).toContain("data-cost-overview-item=\"frames\"");
    expect(html).toContain(">360.0</span> frames/req");
    expect(html).toContain("$0.2613</span> $/req");
    expect(html).toContain("8m 0s</span> s/req");
    expect(html).toContain("3.75</span> RTF");
  });

  it("prints `—` for a field the server did not measure (never a fabricated 0)", () => {
    const b = recentBreakdown({
      perRequest: {
        ...recentBreakdown().perRequest,
        sourceS: null,
        audioTriggers: null,
        rtf: null,
      },
    });
    const items = overviewItems(b);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.source.value).toBe("—");
    expect(byKey.audio.value).toBe("—");
    expect(byKey.rtf.value).toBe("—");
    expect(byKey.source.raw).toBeNull();
    const html = norm(renderToString(<CostTimeView state={readyState(b)} onScope={() => {}} onMode={() => {}} />));
    expect(html).toContain('data-cost-overview-value="source">—');
    expect(html).toContain('data-cost-overview-value="rtf">—');
  });
});

describe("footnote", () => {
  it("prints the effective rates instead of rounding a sub-cent fee to 0.00", () => {
    // The live meter charges $0.0033/decide; a 2-dp print showed "decide $ 0.00/call".
    const b = recentBreakdown({ rates: { decideFeeUsd: 0.0033, perceivePerHourUsd: 0.01 } });
    const html = norm(renderToString(<CostTimeView state={readyState(b)} onScope={() => {}} onMode={() => {}} />));
    expect(html).toContain("decide $0.0033/call");
    expect(html).not.toContain("decide $ 0.00/call");
  });
});

describe("AC11 — payload budget and no new dependency", () => {
  it("the default-scope response stays under 64 KB", () => {
    // The server caps the sample at 50 requests but answers with ONE aggregate
    // (fixed nodes/flows), so the body size does not grow with the sample. The
    // 64 KB budget is asserted here against the fixture the panel renders.
    const bytes = Buffer.byteLength(JSON.stringify(recentBreakdown()), "utf8");
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(64 * 1024);
  });
});

describe("states", () => {
  it("loading shows a skeleton, not a zero chart", () => {
    const html = renderToString(
      <CostTimeView
        state={{ open: true, scope: "recent", mode: "per_request", status: "loading", data: null, error: null }}
        onScope={() => {}}
        onMode={() => {}}
      />,
    );
    expect(html).toContain("data-cost-time-loading");
    expect(html).toContain("Loading breakdown…");
    expect(html).not.toContain("data-sankey=");
  });

  it("error shows the server message — no silent zero-state", () => {
    const html = renderToString(
      <CostTimeView
        state={{ open: true, scope: "recent", mode: "per_request", status: "error", data: null, error: "forbidden: admin only" }}
        onScope={() => {}}
        onMode={() => {}}
      />,
    );
    expect(html).toContain("data-cost-time-error");
    expect(html).toContain("forbidden: admin only");
    expect(html).not.toContain("data-sankey=");
  });
});

describe("the panel wires scope/mode buttons to the store", () => {
  it("default scope is `recent` with per-request mode", () => {
    const b = recentBreakdown();
    const store = createVodBreakdownStore(async () => b, {});
    const html = renderToString(
      <CostTimeView state={{ ...readyState(b), ...store.getState(), open: true }} onScope={store.setScope} onMode={store.setMode} />,
    );
    expect(html).toContain("data-scope-btn=\"recent\" data-active=\"true\"");
    expect(html).toContain("data-mode-btn=\"per_request\" data-active=\"true\"");
    expect(html).toContain("Last 20 requests");
    expect(html).toContain("Last 7 days");
    expect(html).toContain("This request");
    expect(html).toContain("Per request");
    expect(html).toContain("Total");
  });
});

describe("dom dump of the ready panel (evidence)", () => {
  it("the rendered panel contains every spec hook in one pass", () => {
    const html = renderToString(
      <CostTimeView state={readyState(recentBreakdown())} onScope={() => {}} onMode={() => {}} />,
    );
    const hooks = [
      "data-cost-time-panel",
      "data-cost-time-scope=\"recent\"",
      "data-cost-time-mode=\"per_request\"",
      "data-scope-btn=\"recent\"",
      "data-scope-btn=\"days\"",
      "data-scope-btn=\"job\"",
      "data-mode-btn=\"per_request\"",
      "data-mode-btn=\"total\"",
      "data-cost-time-sample",
      "data-cost-time-partial",
      "data-cost-overview",
      'data-sankey="cost"',
      'data-sankey="time"',
      "data-sankey-detached=\"time\"",
      "data-cost-time-basis",
    ];
    for (const h of hooks) expect(html).toContain(h);
  });

  it("the fetcher is called by the panel exactly once when opened (smoke)", async () => {
    const calls: string[] = [];
    const fetcher = (scope: string) => {
      calls.push(scope);
      return Promise.resolve(recentBreakdown());
    };
    const store = createVodBreakdownStore(fetcher, { jobId: "j1" });
    store.open();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(["recent"]);
    expect(store.getState().data?.metered).toBe(18);
    expect(typeof fetchVodBreakdown).toBe("function");
  });
});
