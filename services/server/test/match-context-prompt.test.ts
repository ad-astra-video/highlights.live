// ADAAAA-7856: wire the job's persisted match context (teams + kit colours,
// resolved once per job by ADAAAA-7855) into every decide request and the title
// call. This file proves the three things a board reviewer cannot take on trust:
//
//  1. the assembly layer forwards the STORED context (a persistence read, never
//     a per-window resolver or GPU call);
//  2. absent / unusable context adds NO key to the request — the payload is
//     byte-identical to the pre-feature one (AC6), and junk degrades instead of
//     breaking the send path;
//  3. the send path (OrchestratorAdapter, the deployed live rail) and the
//     `/app/title` call actually carry it.
import { describe, it, expect } from "vitest";
import {
  buildObserveDecideRequest,
  toDecideMatchContext,
  LiveRunShared,
  type DecideMatchContext,
} from "../src/analyzer";
import { buildLiveAnalyzerConfig } from "../src/api";
import { loadConfig } from "../src/config";
import { fallbackJobTitle, requestJobTitle } from "../src/job-title";
import type { ObserveDecidePayload } from "../src/observe-loop";
import type { Job, MatchContext } from "@highlights/events";

const STORED: MatchContext = {
  sport: "soccer",
  ambiguous: false,
  inferredAt: "2026-11-03T14:21:27.000Z",
  resolverVersion: 1,
  teams: [
    {
      name: "Portugal",
      side: "home",
      kitColors: [{ primary: "red", secondary: "green" }],
      confidence: 0.95,
      evidence: [{ source: "scorebug_ocr", snippet: "POR 0 - 0 ESP" }],
    },
    {
      name: "Spain",
      side: "away",
      kitColors: [{ primary: "white" }],
      confidence: 0.95,
      evidence: [{ source: "asr", snippet: "Spain in the white shirts" }],
    },
  ],
  trail: [{ at: "2026-11-03T14:21:27.000Z", progressPct: 0, names: [], action: ["no change"] }],
};

const WIRE: DecideMatchContext = {
  sport: "soccer",
  teams: [
    { name: "Portugal", side: "home", kitColors: [{ primary: "red", secondary: "green" }], confidence: 0.95 },
    { name: "Spain", side: "away", kitColors: [{ primary: "white" }], confidence: 0.95 },
  ],
  ambiguous: false,
};

function payload(): ObserveDecidePayload {
  return { centerTs: 1.0, frames: [{ ts: 1.0, imageB64: "f10" }], seeds: [], biasHints: [], capped: false, droppedCount: 0 };
}

function cfgWith(getMatchContext?: () => unknown) {
  const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
  return {
    ...buildLiveAnalyzerConfig({
      cfg,
      job: { id: "job-7856", gameHint: "soccer" },
      clipWindow: { clipBeforeS: 4, clipAfterS: 4, clipWindowMinSec: 12 },
      getMatchContext,
    }),
  };
}

describe("toDecideMatchContext (ADAAAA-7856)", () => {
  it("projects the stored context onto the decide wire shape", () => {
    expect(toDecideMatchContext(STORED)).toEqual(WIRE);
  });

  it("drops the resolver audit fields the prompt never uses", () => {
    const out = toDecideMatchContext(STORED)!;
    expect(out).not.toHaveProperty("trail");
    expect(out).not.toHaveProperty("inferredAt");
    expect(out).not.toHaveProperty("resolverVersion");
    expect((out.teams[0] as any).evidence).toBeUndefined();
  });

  it("returns undefined for anything unusable (so no key is sent)", () => {
    expect(toDecideMatchContext(undefined)).toBeUndefined();
    expect(toDecideMatchContext(null)).toBeUndefined();
    expect(toDecideMatchContext("Portugal vs Spain")).toBeUndefined();
    expect(toDecideMatchContext({ teams: [] })).toBeUndefined();
    expect(toDecideMatchContext({ teams: "nope" })).toBeUndefined();
  });

  it("never forwards the resolver's 'unknown' marker as a team name", () => {
    expect(
      toDecideMatchContext({ sport: "soccer", teams: [{ name: "unknown", side: "home", confidence: 0 }] })
    ).toBeUndefined();
    const partly = toDecideMatchContext({
      sport: "soccer",
      teams: [{ name: "unknown", side: "home" }, { name: "Portugal", side: "away", confidence: 0.9 }],
    })!;
    expect(partly.teams.map((t) => t.name)).toEqual(["Portugal"]);
  });

  it("clips junk fields instead of throwing", () => {
    const out = toDecideMatchContext({
      sport: 42,
      ambiguous: "yes",
      teams: [
        { name: 42, side: "home" },
        { name: "Portugal", side: "HOME ", kitColors: "red", confidence: 7.5 },
        { name: "Spain", side: "home", kitColors: [{ primary: "white", secondary: 42 }], confidence: -1 },
      ],
    })!;
    expect(out.sport).toBe("");
    expect(out.ambiguous).toBe(false);
    expect(out.teams).toEqual([
      { name: "Portugal", side: "home", kitColors: [], confidence: 1 },
      // second "home" is a duplicate side: skipped, so "away" is not invented
    ]);
  });
});

describe("buildObserveDecideRequest forwards the returned context (ADAAAA-7856)", () => {
  it("carries the stored matchContext on the decide request", () => {
    const { opts } = buildObserveDecideRequest(cfgWith(() => STORED), new LiveRunShared(), payload());
    expect(opts!.matchContext).toEqual(WIRE);
  });

  it("omits the key entirely when the job has no stored context (AC6)", () => {
    const withGetter = buildObserveDecideRequest(cfgWith(() => undefined), new LiveRunShared(), payload());
    const withoutGetter = buildObserveDecideRequest(cfgWith(), new LiveRunShared(), payload());
    expect(withGetter.opts!.matchContext).toBeUndefined();
    expect(withoutGetter.opts!.matchContext).toBeUndefined();
    // the request built for a resolver-less job is byte-identical to today's
    expect(JSON.stringify(withGetter.opts)).toBe(JSON.stringify(withoutGetter.opts));
  });

  it("degrades junk to no key rather than a malformed request", () => {
    const { opts } = buildObserveDecideRequest(
      cfgWith(() => ({ teams: [{ name: 42 }], sport: null })),
      new LiveRunShared(),
      payload()
    );
    expect(opts!.matchContext).toBeUndefined();
    expect(JSON.stringify(opts)).not.toContain("matchContext");
  });

  it("reads the context ONCE per window from the injector (no resolver call)", () => {
    let reads = 0;
    const { opts } = buildObserveDecideRequest(
      cfgWith(() => {
        reads += 1;
        return STORED;
      }),
      new LiveRunShared(),
      payload()
    );
    expect(reads).toBe(1);
    expect(opts!.matchContext).toBeTruthy();
  });
});

describe("the deployed send path carries it (ADAAAA-7856)", () => {
  it("OrchestratorAdapter.decide forwards matchContext only when present", async () => {
    const { OrchestratorAdapter } = await import("../src/livepeer-adapter");
    const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
    const adapter = new OrchestratorAdapter(cfg);
    const captured: Record<string, any>[] = [];
    (adapter as any).client = {
      decide: async (_app: string, p: Record<string, any>) => {
        captured.push(p);
        return { status: 200, data: { isHighlight: false, score: 0, outcome: "not_highlight" } };
      },
    };
    await adapter.decide(
      { eventType: "GOAL", trackCount: 1, maxVelocity: 0, ocrHits: 0 },
      { jobId: "j1", groupKey: "g0", frames: [], matchContext: WIRE }
    );
    await adapter.decide(
      { eventType: "GOAL", trackCount: 1, maxVelocity: 0, ocrHits: 0 },
      { jobId: "j1", groupKey: "g0", frames: [] }
    );
    expect(captured[0].matchContext).toEqual(WIRE);
    expect("matchContext" in captured[1]).toBe(false);
  });

  it("OrchestratorAdapter.decideGroup forwards it too", async () => {
    const { OrchestratorAdapter } = await import("../src/livepeer-adapter");
    const cfg = loadConfig({ PERCEIVE_URL: "http://p", DECIDE_URL: "http://d" });
    const adapter = new OrchestratorAdapter(cfg);
    const captured: Record<string, any>[] = [];
    (adapter as any).client = {
      decide: async (_app: string, p: Record<string, any>) => {
        captured.push(p);
        return { status: 200, data: { verdicts: [] } };
      },
    };
    await adapter.decideGroup!({
      jobId: "j1",
      groupKey: "g0",
      candidates: [{ eventType: "GOAL", timestamp: 3, evidence: { trackCount: 1, maxVelocity: 0, ocrHits: 0 } }],
      frames: [],
      matchContext: WIRE,
    } as any);
    expect(captured[0].matchContext).toEqual(WIRE);
  });
});

describe("the title call inherits the same context (ADAAAA-7856 Stage 7)", () => {
  const job = { id: "j1", gameHint: "soccer", matchContext: STORED } as Pick<Job, "id" | "gameHint" | "matchContext">;

  it("sends matchContext to /app/title", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ title: "Portugal 1-0 Spain" }) };
    }) as any;
    const title = await requestJobTitle({ decideUrl: "http://decide" }, job, [], fetchImpl);
    expect(title).toBe("Portugal 1-0 Spain");
    expect(bodies[0].matchContext).toEqual(STORED);
    expect(bodies).toHaveLength(1); // still exactly ONE title call
  });

  it("omits the key for a job without context (byte-identical title request)", async () => {
    const bodies: any[] = [];
    const fetchImpl = (async (_url: any, init: any) => {
      bodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ title: "Reel" }) };
    }) as any;
    await requestJobTitle({ decideUrl: "http://decide" }, { id: "j2", gameHint: "soccer" }, [], fetchImpl);
    expect("matchContext" in bodies[0]).toBe(false);
  });

  it("fallback title is unchanged for resolver-less jobs", () => {
    expect(fallbackJobTitle({ gameHint: "soccer", source: "file" }, [])).toMatch(/^soccer · 0 highlights/);
  });
});
