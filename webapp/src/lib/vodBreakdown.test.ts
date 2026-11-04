import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { recentBreakdown, emptyBreakdown, untimedBreakdown } from "./vodBreakdown.fixtures";
import {
  buildCostSankey,
  buildTimeSankey,
  costBilledTotal,
  createVodBreakdownStore,
  emptyStateLine,
  fetchVodBreakdown,
  formatSeconds,
  formatShare,
  formatUsd,
  hasTimeSample,
  isEmptyBreakdown,
  modeFactor,
  modeFactorForTime,
  overviewItems,
  partialNote,
  sampleLine,
  scopeWindowLabel,
  timeTotalFromNodes,
  VOD_BREAKDOWN_PATH,
  vodBreakdownQuery,
  type VodBreakdown,
} from "./vodBreakdown";

// ADAAAA-7929 (Inc 2 of ADAAAA-7925), the numbers half.
//
// AC3 conservation, AC4 CPU/concurrent handling, AC6 legacy exclusion, AC7
// empty state, AC9 overview strip and AC2's "refetch exactly once" are all
// asserted here against the spec §4.2 fixture — the chart geometry is derived
// from these values, so a passing suite means the pandas in the picture are the
// pandas in the payload, not hand-placed rectangles.

const close = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps;

/** Settle the store's promise chain (no DOM, so no effects — the store IS the
 * lifecycle and is driven directly). */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("vodBreakdown request shape", () => {
  it("builds one query per scope, with the spec defaults", () => {
    expect(vodBreakdownQuery("recent")).toBe("?scope=recent&limit=20");
    expect(vodBreakdownQuery("days")).toBe("?scope=days&days=7");
    expect(vodBreakdownQuery("job", { jobId: "abc123" })).toBe("?scope=job&jobId=abc123");
  });

  it("refuses scope=job without a jobId instead of guessing one", () => {
    expect(() => vodBreakdownQuery("job")).toThrow(/jobId/);
  });

  it("hits the admin aggregate route and nothing else", async () => {
    // fetch is not available here; assert the URL contract through the fetch call
    // shape instead of a network round trip.
    const calls: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response(JSON.stringify(recentBreakdown()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as any;
    try {
      const b = await fetchVodBreakdown("recent");
      expect(b.sampled).toBe(18);
      expect(calls).toEqual(["/admin/vod-breakdown?scope=recent&limit=20"]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("pins the client path to the route the server actually registers", () => {
    // This app mounts every route at the SERVER ROOT; `/api/...` is not an
    // alias (verified live: `/api/admin/vod-breakdown` → 404, `/admin/...` → 200).
    // A prefixed client path would have shipped a panel that always errored, so
    // the client constant is checked against the server source.
    const serverApi = readFileSync(resolve(__dirname, "../../../services/server/src/api.ts"), "utf8");
    expect(VOD_BREAKDOWN_PATH).toBe("/admin/vod-breakdown");
    expect(serverApi).toContain(`"${VOD_BREAKDOWN_PATH}"`);
    expect(serverApi).not.toContain("/api/admin/vod-breakdown");
    expect(VOD_BREAKDOWN_PATH.startsWith("/api/")).toBe(false);
  });
});

describe("AC2 — sample line and window", () => {
  it("names the window and the sample", () => {
    const b = recentBreakdown();
    expect(scopeWindowLabel(b)).toBe("last 20 requests");
    expect(sampleLine(b)).toBe("18 requests · 12 with stage timings · last 20 requests");
  });

  it("singularises n=1 (This request) and names days", () => {
    const one = recentBreakdown({ scope: { kind: "job", jobId: "j1" }, sampled: 1, timed: 1 });
    expect(scopeWindowLabel(one)).toBe("this request");
    expect(sampleLine(one)).toBe("1 request · 1 with stage timings · this request");
    const days = recentBreakdown({ scope: { kind: "days", days: 7 } });
    expect(scopeWindowLabel(days)).toBe("last 7 days");
  });
});

describe("AC6 — legacy jobs are excluded from time, not fabricated", () => {
  it("counts the untimed remainder in the footnote", () => {
    expect(partialNote(recentBreakdown())).toBe("6 of 18 requests predate stage timing — time view covers 12");
  });

  it("is silent when every request is instrumented", () => {
    expect(partialNote(recentBreakdown({ timed: 18, excluded: { noCost: 0, noStageTimings: 0, live: 0 } }))).toBeNull();
  });

  it("keeps cost intact while time is empty", () => {
    const b = untimedBreakdown();
    expect(costBilledTotal(b)).toBeCloseTo(0.2613, 6);
    expect(b.timed).toBe(0);
    expect(partialNote(b)).toBe("18 of 18 requests predate stage timing — time view covers 0");
  });

  it("does not draw a time chart from the server's zeroed nodes", () => {
    // The live build (20 sampled / 0 timed) returned six time nodes at 0 s each
    // and the panel drew "Per request · 0.00s · 100%" — hasTimeSample must say
    // no for that shape, and yes for a real sample.
    const untimed = untimedBreakdown();
    expect(untimed.time.nodes).toHaveLength(6); // the server always sends them
    expect(untimed.time.nodes.every((n) => n.s === 0)).toBe(true);
    expect(hasTimeSample(untimed)).toBe(false);
    expect(hasTimeSample(recentBreakdown())).toBe(true);
    // a timed sample whose nodes are all zero is still not a chart
    expect(hasTimeSample({ timed: 3, time: { totalS: 0, nodes: [], flows: [] } })).toBe(false);
  });
});

describe("AC7 — empty window", () => {
  it("is empty and names the window it searched", () => {
    const b = emptyBreakdown();
    expect(isEmptyBreakdown(b)).toBe(true);
    expect(emptyStateLine(b)).toBe("No completed VOD requests in last 7 days");
  });

  it("is not empty when any cost node is non-zero", () => {
    expect(isEmptyBreakdown(recentBreakdown())).toBe(false);
  });
});

describe("AC3 — conservation (the 100% statement is true)", () => {
  it("cost top band equals cost.totalUsd and every flow sums to it", () => {
    const b = recentBreakdown();
    const g = buildCostSankey(b, "per_request");
    expect(g.top.value).toBeCloseTo(b.cost.totalUsd, 10);

    const flowSum = b.cost.flows.reduce((s, f) => s + (f.usd || 0), 0);
    expect(close(flowSum, b.cost.totalUsd, 0.0001)).toBe(true);

    // every flow agrees with its node (no invented bandwidth)
    for (const node of b.cost.nodes) {
      const flow = b.cost.flows.find((f) => f.target === node.key);
      expect(flow).toBeDefined();
      expect(close(flow!.usd || 0, node.usd, 0.0001)).toBe(true);
    }
  });

  it("time top band equals time.totalS and every flow sums to it", () => {
    const b = recentBreakdown();
    const g = buildTimeSankey(b, "per_request");
    expect(g.top.value).toBeCloseTo(b.time.totalS, 10);
    const flowSum = b.time.flows.reduce((s, f) => s + (f.s || 0), 0);
    expect(close(flowSum, b.time.totalS, 1)).toBe(true);
    expect(close(timeTotalFromNodes(b), b.time.totalS, 1)).toBe(true);
  });

  it("link widths are the shares, and the billed links fill the plot", () => {
    const g = buildCostSankey(recentBreakdown(), "per_request");
    // documented geometry: rowCount × 30 - (rowCount + 1) × 6 for 7 nodes
    const usable = 7 * 30 - 8 * 6; // 162
    expect(g.plotHeight).toBe(210);
    for (const l of g.links) {
      expect(close(l.width, l.share * usable, 1e-6)).toBe(true);
    }
    // shares of the billed nodes sum to 100%, so the bands fill the plot exactly
    const bandSum = g.links.reduce((s, l) => s + l.width, 0);
    expect(close(bandSum, usable, 1e-6)).toBe(true);
  });

  it("bands are stacked downward without overlap and stay inside the plot", () => {
    const g = buildTimeSankey(recentBreakdown(), "per_request");
    let cursor = 0;
    for (const n of g.nodes) {
      expect(n.y).toBeGreaterThanOrEqual(cursor);
      cursor = n.y + n.height;
      expect(n.y + n.height).toBeLessThanOrEqual(g.plotHeight + 0.001);
    }
  });
});

describe("AC4 — CPU stages and the concurrent audio gate", () => {
  it("prints CPU stages as $0.00 (not billed) and keeps them out of the denominator", () => {
    const b = recentBreakdown();
    const g = buildCostSankey(b, "per_request");
    const cpu = g.nodes.filter((n) => n.tone === "cpu");
    expect(cpu).toHaveLength(4);
    for (const n of cpu) {
      expect(n.label).toContain("$0.00 · CPU (not billed)");
      expect(n.share).toBe(0);
      expect(n.height).toBe(0);
      expect(g.links.some((l) => l.target === n.key)).toBe(false);
    }
    // denominator excludes CPU: billed total equals cost.totalUsd
    expect(costBilledTotal(b)).toBeCloseTo(b.cost.totalUsd, 6);
  });

  it("never adds the concurrent audio band to the time total", () => {
    const b = recentBreakdown();
    const g = buildTimeSankey(b, "per_request");
    const audio = b.time.concurrent![0];
    // the total is the measured partition only
    expect(g.top.value).toBeCloseTo(b.time.totalS, 10);
    expect(g.top.value).toBe(480);
    expect(g.nodes.some((n) => n.key === audio.key)).toBe(false);
    expect(g.links.some((l) => l.target === audio.key)).toBe(false);
    expect(g.nodes.reduce((s, n) => s + n.value, 0) + audio.s).toBe(505); // proof of exclusion
    const detached = g.detached.find((d) => d.key === audio.key)!;
    // ADAAAA-7939 D2: the badge chip is the only concurrency marker; the
    // parenthetical and the `· concurrent` tail are gone.
    expect(detached.label).toBe("Audio gate · 25.0s");
    expect(detached.title).toBe("Audio gate");
    expect(detached.share).toBe(0);
    expect(detached.tone).toBe("concurrent");
  });
});

describe("mode toggle", () => {
  it("scales cost by the metered sample and time by the timed sample", () => {
    const b = recentBreakdown();
    expect(modeFactor("per_request", b)).toBe(1);
    expect(modeFactor("total", b)).toBe(18);
    expect(modeFactorForTime("total", b)).toBe(12);

    const cost = buildCostSankey(b, "total");
    expect(cost.top.value).toBeCloseTo(0.2613 * 18, 6);
    const time = buildTimeSankey(b, "total");
    expect(time.top.value).toBeCloseTo(480 * 12, 6);
    // shares are mode-independent: the picture does not move
    const per = buildCostSankey(b, "per_request");
    per.nodes.forEach((n, i) => expect(close(cost.nodes[i].share, n.share, 1e-9)).toBe(true));
  });

  it("labels the top band with the mode", () => {
    const b = recentBreakdown();
    expect(buildCostSankey(b, "per_request").top.label).toBe("Per request · $0.2613 · 100%");
    expect(buildCostSankey(b, "total").top.label).toBe("Total · $4.70 · 100%");
  });
});

describe("AC9 — overview strip is perRequest, verbatim", () => {
  it("maps each label to its perRequest field with a /req label", () => {
    const b = recentBreakdown();
    const items = overviewItems(b);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(items.map((i) => i.label)).toEqual([
      "source min/req",
      "frames/req",
      "audio triggers/req",
      "decide calls/req",
      "clips/req",
      "$/req",
      "/req",
      "RTF",
    ]);
    expect(byKey.frames.raw).toBe(b.perRequest.frames);
    expect(byKey.audio.raw).toBe(b.perRequest.audioTriggers);
    expect(byKey.decide.raw).toBe(b.perRequest.decideCalls);
    expect(byKey.clips.raw).toBe(b.perRequest.clips);
    expect(byKey.cost.raw).toBe(b.perRequest.costUsd);
    expect(byKey.seconds.raw).toBe(b.perRequest.wallClockS);
    expect(byKey.rtf.raw).toBe(b.perRequest.rtf);
    expect(byKey.source.raw).toBe(b.perRequest.sourceS);
    // printed values are the same numbers, formatted
    expect(byKey.frames.value).toBe("360.0");
    expect(byKey.cost.value).toBe("$0.2613");
    expect(byKey.seconds.value).toBe("8m 0s");
    expect(byKey.source.value).toBe("2.1");
    expect(byKey.rtf.value).toBe("3.75");
    for (const i of items) if (i.key !== "rtf") expect(i.label.endsWith("/req")).toBe(true);
  });
});

describe("ADAAAA-7939 — P3 copy fixes (D1 seconds unit, D2 badge word)", () => {
  it("AC1: `—` for seconds when nothing in the window is timed", () => {
    const sec = overviewItems(untimedBreakdown()).find((i) => i.key === "seconds")!;
    expect(sec.value).toBe("—");
    expect(sec.label).toBe("/req");
    // the number itself is untouched — only the copy changes
    expect(sec.raw).toBe(0);
    expect(`${sec.value} ${sec.label}`).toBe("— /req");
    expect(`${sec.value} ${sec.label}`).not.toContain("0.00");
  });

  it("AC1: one unit and one /req when the payload has timed requests", () => {
    const timed = overviewItems(recentBreakdown()).find((i) => i.key === "seconds")!;
    expect(`${timed.value} ${timed.label}`).toBe("8m 0s /req");
    const b = recentBreakdown({ perRequest: { ...recentBreakdown().perRequest, wallClockS: 150 } });
    const sec = overviewItems(b).find((i) => i.key === "seconds")!;
    expect(`${sec.value} ${sec.label}`).toBe("2m 30s /req");
    // the defect the QA read caught: a unit on the value AND on the label
    expect(`${sec.value} ${sec.label}`).not.toMatch(/s\/req$/);
  });

  it("AC3: no numeric value moved for the fixed fixture", () => {
    const b = recentBreakdown();
    const cost = buildCostSankey(b, "per_request");
    const time = buildTimeSankey(b, "per_request");
    expect(cost.top.value).toBe(0.2613);
    expect(cost.nodes.map((n) => n.value)).toEqual([0.0013, 0.2, 0.06, 0, 0, 0, 0]);
    expect(cost.nodes.map((n) => n.label)).toEqual([
      "Perceive GPU session · $0.0013 · 0.5%",
      "Decide · observe · $0.2000 · 76.5%",
      "Decide · confirm · $0.0600 · 23.0%",
      "Extract frames · $0.00 · CPU (not billed)",
      "Audio gate · $0.00 · CPU (not billed)",
      "Clip encode · $0.00 · CPU (not billed)",
      "Finalize · $0.00 · CPU (not billed)",
    ]);
    expect(time.top.value).toBe(480);
    expect(time.nodes.map((n) => n.value)).toEqual([35, 130, 160, 40, 20, 95]);
    expect(time.nodes.map((n) => n.label)).toEqual([
      "GPU capacity wait · 35.0s · 7.3%",
      "Extract frames · 2m 10s · 27.1%",
      "Analyze (perceive + decide) · 2m 40s · 33.3%",
      "Clip encode · 40.0s · 8.3%",
      "Preroll · 20.0s · 4.2%",
      "Finalize · 1m 35s · 19.8%",
    ]);
    // the badge stays detached and out of the total
    expect(time.detached.map((d) => d.value)).toEqual([25]);
    expect(time.nodes.reduce((s, n) => s + n.value, 0)).toBe(480);
  });
});

describe("formatting", () => {
  it("money keeps cents under a dollar and prints $0.00 for a CPU stage", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.0013)).toBe("$0.0013");
    expect(formatUsd(0.2)).toBe("$0.2000");
    expect(formatUsd(12.5)).toBe("$12.50");
  });
  it("seconds roll over at a minute", () => {
    expect(formatSeconds(12.54)).toBe("12.5s");
    expect(formatSeconds(480)).toBe("8m 0s");
    // sub-10 s stages keep 2 dp: a 45 ms analyze_net must not print "0.0s"
    // beside a non-zero share (services/server/src/vod-breakdown.ts rounds to 2 dp)
    expect(formatSeconds(0.046)).toBe("0.05s");
    expect(formatSeconds(0.12)).toBe("0.12s");
  });
  it("shares are one decimal percent", () => {
    expect(formatShare(0.765)).toBe("76.5%");
    expect(formatShare(1)).toBe("100.0%");
  });
});

describe("AC2 — the store fetches on open and on scope change only", () => {
  function countingFetcher(payload: VodBreakdown) {
    const calls: Array<{ scope: string; jobId?: string }> = [];
    const fetcher = async (scope: any, opts: any) => {
      calls.push({ scope, jobId: opts?.jobId });
      return scope === "days" ? { ...payload, scope: { kind: "days" as const, days: 7 } } : payload;
    };
    return { fetcher, calls };
  }

  it("does not fetch until opened, then fetches exactly once", async () => {
    const { fetcher, calls } = countingFetcher(recentBreakdown());
    const store = createVodBreakdownStore(fetcher, { jobId: "j1" });
    expect(store.fetchCount()).toBe(0);
    store.open();
    expect(store.fetchCount()).toBe(1);
    await flush();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().data?.sampled).toBe(18);
    expect(calls).toEqual([{ scope: "recent", jobId: "j1" }]);
  });

  it("refetches EXACTLY once per scope change and never on a mode change", async () => {
    const { fetcher, calls } = countingFetcher(recentBreakdown());
    const store = createVodBreakdownStore(fetcher, { jobId: "j1" });
    store.open();
    await flush();
    expect(store.fetchCount()).toBe(1);

    store.setScope("days");
    expect(store.fetchCount()).toBe(2);
    await flush();
    expect(store.getState().data?.scope.kind).toBe("days");

    store.setScope("days"); // no-op: same scope
    expect(store.fetchCount()).toBe(2);

    store.setMode("total"); // rescale only
    expect(store.fetchCount()).toBe(2);
    expect(store.getState().mode).toBe("total");

    store.setScope("recent");
    expect(store.fetchCount()).toBe(3);
    await flush();
    expect(calls.map((c) => c.scope)).toEqual(["recent", "days", "recent"]);
  });

  it("drops a late answer for a superseded scope", async () => {
    const resolvers: Array<(b: VodBreakdown) => void> = [];
    const fetcher = (_scope: any) => new Promise<VodBreakdown>((r) => resolvers.push(r));
    const store = createVodBreakdownStore(fetcher, { jobId: "j1" });
    store.open();
    store.setScope("days");
    expect(store.fetchCount()).toBe(2);
    // the days answer lands first, then the stale recent one must be ignored
    resolvers[1]({ ...recentBreakdown(), scope: { kind: "days", days: 7 }, sampled: 7 });
    await flush();
    resolvers[0](recentBreakdown());
    await flush();
    expect(store.getState().data?.sampled).toBe(7);
    expect(store.getState().scope).toBe("days");
  });

  it("surfaces the server message instead of a zero-state", async () => {
    const fetcher = async () => {
      throw new Error("forbidden: admin only");
    };
    const store = createVodBreakdownStore(fetcher, {});
    store.open();
    await flush();
    expect(store.getState().status).toBe("error");
    expect(store.getState().error).toBe("forbidden: admin only");
    expect(store.getState().data).toBeNull();
  });

  it("clears a closed panel without issuing another request", async () => {
    const { fetcher } = countingFetcher(recentBreakdown());
    const store = createVodBreakdownStore(fetcher, {});
    store.open();
    await flush();
    store.close();
    expect(store.fetchCount()).toBe(1);
    expect(store.getState().open).toBe(false);
    expect(store.getState().data).toBeNull();
  });
});

describe("AC11 — the payload is small", () => {
  it("a default-scope fixture serialises far under 64 KB", () => {
    const bytes = JSON.stringify(recentBreakdown()).length;
    expect(bytes).toBeLessThan(64 * 1024);
    // 7 cost nodes + 6 time nodes + 1 concurrent + perRequest: ~2 KB.
    expect(bytes).toBeLessThan(4096);
  });
});
