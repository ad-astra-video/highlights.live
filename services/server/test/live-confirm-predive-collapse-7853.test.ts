// ADAAAA-7853: PRE-DIVE refusal of overlap-chain losers (`CONFIRM_PREDIVE_COLLAPSE`,
// default OFF).
//
// Every AC here is `$0` and replayable on stored rows: no GPU, no decide call, no
// deploy. The fixture is the measured reference job `d61e52f6` (24 persisted rows
// covering 18 unique windows by overlap alone, 6 merged away — see
// `docs/clip-counting.md`), shared with the postable-gate and clip-count tests so
// the numbers are asserted against ONE source of truth.
//
// AC1 identity  — the served `buildPostableHighlights(...).highlights` list is
//                 identical by id and field with the flag ON, `counts.merged`
//                 unchanged.
// AC2 cost      — dispatched dives drop 24 -> 18 (`prediveSkipped: 6`), so
//                 `diveCostUsd = 18 x decideFee`; the saving quoted at both prices.
// AC3 recall    — the accepted-goal set and the postable moment set are unchanged,
//                 and no accepted goal moves into `duplicates[]`.
// AC4 fallback  — a chain whose winner DEMOTES hands the dive to the next-best
//                 member in the SAME pass (fixture `d61-chain-demote-fallback`).
// AC5 boundaries— exactly-adjacent windows are not a chain, the notable lane is
//                 never pre-refused, and the clock lane is untouched.
// AC6 inertness — flag OFF => every dispatched dive and verdict identical to today.
import { describe, expect, it, vi } from "vitest";
import type { HighlightRecord } from "@highlights/events";
import { loadConfig } from "../src/config";
import { buildPostableHighlights } from "../src/highlight-postable";
import {
  ConfirmDiveBudget,
  type ConfirmDiveResult,
  type ConfirmDiveVerdict,
  confirmDiveKey,
  planDueConfirmDives,
  planPrediveCollapse,
  prediveWindowsOverlap,
  runDueConfirmDives,
  type PendingConfirmDive,
} from "../src/live-confirm-async";
import { D61_JOB, d61Highlights } from "./fixtures/d61-highlights";

/** The measured reference rows: 24 persisted clips, 18 unique windows, 6 merged. */
const D61_ROWS = d61Highlights();

/** One pending dive, derived from a stored row the way the live accept derives it
 *  (window = the judged clip window, goal event at the window anchor, ranking
 *  inputs copied from the row). */
function descriptorFor(row: HighlightRecord, over: Partial<PendingConfirmDive> = {}): PendingConfirmDive {
  return {
    highlightId: row.id,
    jobId: row.jobId,
    goalEventTs: row.start + 7,
    window: { lo: row.start, hi: row.end },
    stage1: { eventType: row.eventType, outcome: row.outcome, reason: row.reason },
    analysis: {},
    signals: {},
    queuedAt: row.start + 7,
    evidence: { provisional: true, scoreMeasured: true },
    score: row.score,
    corroborated: row.corroborated === true,
    ...over,
  };
}

/** The due dives for a row set, with the dive planner's own reuse window OFF so
 *  every stored window is one dispatch — the reference measurement ("24 clips
 *  paid 24 dives") rather than the live 12 s reuse suppression. */
function dueFor(rows: HighlightRecord[]): PendingConfirmDive[] {
  return planDueConfirmDives(rows.map((r) => descriptorFor(r)), { nowTs: 10_000, reuseWindowS: 0 });
}

function runState(pending: PendingConfirmDive[]) {
  const state = {
    attempted: new Set<string>(),
    dropped: [] as string[],
    prediveSkipped: 0,
    calls: 0,
    done: 0,
    entries: [...pending],
    confirmBudget: new ConfirmDiveBudget(),
    pendingConfirmDives() {
      return this.entries;
    },
    confirmDiveAttempted() {
      return this.attempted;
    },
    noteConfirmDiveAttempt(k: string) {
      this.attempted.add(k);
    },
    dropPendingConfirmDive(k: string) {
      this.entries = this.entries.filter((e) => confirmDiveKey(e) !== k);
    },
    noteConfirmDiveDropped(r: string) {
      this.dropped.push(r);
    },
    noteConfirmDiveDone() {
      this.done++;
      this.calls++;
    },
    noteConfirmDivePrediveSkipped() {
      this.prediveSkipped++;
    },
    confirmDiveCalls() {
      return this.calls;
    },
    confirmDiveCount() {
      return this.done;
    },
    confirmDiveDropped() {
      return this.dropped.length;
    },
  };
  return state;
}

/** A dive that always answers `confirmed_goal` — the arm every AC1/AC2/AC3/AC6
 *  number is measured on, so the two flag arms differ by the PLAN, not the model. */
const ALL_CONFIRMED = {
  framesInSpan: (lo: number, hi: number) => {
    const out: { seq: number; ts: number }[] = [];
    for (let t = Math.ceil(lo); t <= hi; t++) out.push({ seq: t, ts: t });
    return out;
  },
  loadFrame: async (seq: number) => `img-${seq}`,
  confirm: async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }),
  gameHint: "soccer",
};

/** Apply the verdict to the row set the way the in-place verdict writer does
 *  (attestation only — `outcome` / `score` / windows are never touched). */
function adoptApplying(rows: Map<string, HighlightRecord>, kinds: Record<string, string> = {}) {
  return async (entry: PendingConfirmDive, result: ConfirmDiveResult) => {
    const row = rows.get(entry.highlightId);
    const attestation = result.droppedReason
      ? { goalConfirmed: "dropped" as const, corroborated: false, dropReason: result.droppedReason }
      : {
          goalConfirmed: result.verdict?.goalConfirmed ?? "passthrough",
          corroborated: result.verdict?.corroborated === true,
        };
    if (row) rows.set(entry.highlightId, { ...row, confirmAttestation: attestation as HighlightRecord["confirmAttestation"] });
    if (result.droppedReason) return undefined;
    const kind = result.verdict?.goalConfirmed === "confirmed_goal" && result.verdict?.corroborated === true
      ? "promoted"
      : "refuted";
    kinds[entry.highlightId] = kind;
    return kind as "promoted" | "refuted";
  };
}

const pump = (state: ReturnType<typeof runState>, adopt: any, extra: Record<string, unknown> = {}) =>
  runDueConfirmDives({
    run: state as any,
    io: ALL_CONFIRMED as any,
    nowTs: 10_000,
    jobId: D61_JOB,
    reuseWindowS: 0,
    adopt,
    log: () => {},
    ...extra,
  });

describe("ADAAAA-7853 AC2 — the dive count and the fee it saves", () => {
  it("24 stored windows dispatch 20 dives (4 refused pre-dive) with the flag ON", async () => {
    const due = dueFor(D61_ROWS);
    expect(due).toHaveLength(24); // the reference measurement: one dive per window
    const state = runState(due);
    const out = await pump(state, adoptApplying(new Map(D61_ROWS.map((r) => [r.id, r]))), { prediveCollapse: true });
    expect(out.dives).toBe(20);
    expect(out.prediveSkipped).toBe(4);
    expect(out.refuted).toBe(0);
    // A skipped dive never reaches the model, so it is never a billed confirm call.
    expect(state.calls).toBe(20);
    expect(state.entries).toHaveLength(0);
    const dropped = state.dropped.filter((d) => d === "predive_collapsed");
    expect(dropped).toHaveLength(4);
  });

  it("the accepted-only population (the rejected row never dives) is 23 -> 19, the same 4 refused", async () => {
    const accepted = D61_ROWS.filter((r) => r.status !== "rejected");
    const due = dueFor(accepted);
    expect(due).toHaveLength(23);
    const state = runState(due);
    const out = await pump(state, adoptApplying(new Map(accepted.map((r) => [r.id, r]))), { prediveCollapse: true });
    expect(out.dives).toBe(19);
    expect(out.prediveSkipped).toBe(4);
  });

  it("diveCostUsd recomputes to dives x decideFee; the saving is 4 x decideFee at both prices", async () => {
    const due = dueFor(D61_ROWS);
    const state = runState(due);
    const out = await pump(state, adoptApplying(new Map(D61_ROWS.map((r) => [r.id, r]))), { prediveCollapse: true });
    // `diveAdmission.diveCostUsd = decideFee x divesBilled`, and `divesBilled` is
    // the confirm-call meter (`state.calls`), so the recompute is exact.
    const PRICES = [
      { label: "served measured $/decide", fee: 0.003314, cost: 0.06628, saving: 0.013256 },
      { label: "DECIDE_FEE default", fee: 0.01, cost: 0.2, saving: 0.04 },
    ];
    for (const p of PRICES) {
      expect(Number((p.fee * state.calls).toFixed(6))).toBe(p.cost);
      expect(Number((p.fee * out.prediveSkipped).toFixed(6))).toBe(p.saving);
      expect(state.calls).toBe(out.dives);
    }
  });

  it("the chain must not bridge a row the gate DROPS: hl-701 keeps its dive and its card", () => {
    // The PO's AC2 arithmetic ("24 -> 18, prediveSkipped 6") chains all 24 windows.
    // On the measured job the Stage-1-contradicting window `688.6` BRIDGES
    // `678.2` and `701.0`, and the read-time gate drops `688.6`, so `678.2` and
    // `701.0` ship as TWO cards. Chaining across the dropped row would deny
    // `701.0` its dive and change that card's fields — a false negative this plan
    // refuses to ship, so the shipped rule refuses 4 dives, not 6.
    const plan = planPrediveCollapse(dueFor(D61_ROWS));
    const postable = buildPostableHighlights(D61_ROWS);
    const served = new Set(postable.highlights.map((h) => h.id));
    expect(served.has("hl-701")).toBe(true);
    expect(plan.dive.map((d) => d.highlightId)).toContain("hl-701");
    expect(plan.skipped.map((s) => s.entry.highlightId)).not.toContain("hl-701");
    expect(plan.prediveSkipped).toBe(4);
    expect(plan.dive).toHaveLength(20);
  });
});

describe("ADAAAA-7853 AC1/AC3 — the served list does not move", () => {
  it("the pre-dive winner IS the postable owner of every chain, and no shipped row loses its dive", () => {
    const plan = planPrediveCollapse(dueFor(D61_ROWS));
    const postable = buildPostableHighlights(D61_ROWS);
    expect(postable.counts.merged).toBe(4); // the shipped postable gate's own number
    const served = new Set(postable.highlights.map((h) => h.id));
    const dived = new Set(plan.dive.map((d) => d.highlightId));
    // No card the page serves is denied its dive (AC1's field identity)...
    for (const id of served) expect(dived.has(id)).toBe(true);
    // ...and every window refused pre-dive is a duplicate the page does not serve.
    for (const s of plan.skipped) expect(served.has(s.entry.highlightId)).toBe(false);
    expect(plan.dive).toHaveLength(20);
    expect(plan.prediveSkipped).toBe(4);
  });

  it("flag ON vs OFF: identical highlights by id and field, counts.merged unchanged (AC1)", async () => {
    const runArm = async (flag: boolean) => {
      const rows = new Map(D61_ROWS.map((r) => [r.id, r]));
      const due = dueFor(D61_ROWS);
      const state = runState(due);
      const out = await pump(state, adoptApplying(rows), flag ? { prediveCollapse: true } : {});
      return { out, postable: buildPostableHighlights([...rows.values()]) };
    };
    const on = await runArm(true);
    const off = await runArm(false);
    expect(on.postable.highlights).toEqual(off.postable.highlights);
    expect(on.postable.counts.merged).toBe(off.postable.counts.merged);
    // AC3: same accepted-goal set, same postable moment set, nothing moved to the
    // duplicate lane.
    const goalIds = (p: typeof on.postable) => p.highlights.map((h) => h.id).sort();
    expect(goalIds(on.postable)).toEqual(goalIds(off.postable));
    const dupes = (p: typeof on.postable) => p.duplicates.map((h) => h.id).sort();
    expect(dupes(on.postable)).toEqual(dupes(off.postable));
    for (const id of goalIds(on.postable)) expect(dupes(on.postable)).not.toContain(id);
    // The served count is the same number a customer sees.
    expect(on.postable.counts.postable).toBe(off.postable.counts.postable);
  });
});

describe("ADAAAA-7853 AC4 — chained fallback (fixture: d61-chain-demote-fallback)", () => {
  // The measured 3-window chain of d61e52f6: 341.8/351.8 (score 95) and 359.2
  // (score 100) are one moment, so only 359.2 dives. Its dive DEMOTES it, and the
  // next-best member (351.8 — score 95, later than 341.8 so 341.8 is next) must
  // inherit the dive in the same pass.
  const CHAIN = D61_ROWS.filter((r) => [341.8, 351.8, 359.2].includes(r.start));

  it("a demoted winner hands the dive to the runner-up in the SAME pass", async () => {
    const due = dueFor(CHAIN);
    expect(due).toHaveLength(3);
    // Winner 359.2 demotes; every other window confirms.
    const confirm = vi.fn(async (req: { timestamp: number }) =>
      req.timestamp === 359.2 + 7
        ? ({ goalConfirmed: "near_miss" as const, corroborated: false } satisfies ConfirmDiveVerdict)
        : ({ goalConfirmed: "confirmed_goal" as const, corroborated: true } satisfies ConfirmDiveVerdict)
    );
    const rows = new Map(CHAIN.map((r) => [r.id, r]));
    const kinds: Record<string, string> = {};
    const adopted: string[] = [];
    const adopt = async (entry: PendingConfirmDive, result: ConfirmDiveResult) => {
      adopted.push(`${entry.highlightId}:${result.droppedReason ?? result.verdict?.goalConfirmed}`);
      return adoptApplying(rows, kinds)(entry, result);
    };
    const state = runState(due);
    const out = await runDueConfirmDives({
      run: state as any,
      io: { ...ALL_CONFIRMED, confirm } as any,
      nowTs: 10_000,
      jobId: D61_JOB,
      reuseWindowS: 0,
      prediveCollapse: true,
      adopt,
      log: () => {},
    });
    // Two model calls, one pass: the winner, then the inherited dive.
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(out.dives).toBe(2);
    expect(out.refuted).toBe(1);
    expect(kinds[`hl-${359.2}`]).toBe("refuted");
    expect(kinds[`hl-${341.8}`]).toBe("promoted"); // the runner-up INHERITED the dive
    // The remaining member is the only window refused pre-dive.
    expect(out.prediveSkipped).toBe(1);
    expect(adopted).toContain(`hl-${341.8}:confirmed_goal`);
    expect(adopted).toContain(`hl-${351.8}:predive_collapsed`);
    expect(state.entries).toHaveLength(0);
  });

  it("a CONFIRMED winner leaves the chain's losers refused (no wasted dive)", async () => {
    const due = dueFor(CHAIN);
    const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
    const state = runState(due);
    const out = await runDueConfirmDives({
      run: state as any,
      io: { ...ALL_CONFIRMED, confirm } as any,
      nowTs: 10_000,
      jobId: D61_JOB,
      reuseWindowS: 0,
      prediveCollapse: true,
      adopt: adoptApplying(new Map(CHAIN.map((r) => [r.id, r]))),
      log: () => {},
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(out.dives).toBe(1);
    expect(out.prediveSkipped).toBe(2);
  });
});

describe("ADAAAA-7853 AC5 — boundaries", () => {
  it("exactly-adjacent windows (a.hi == b.lo) are not a chain", () => {
    const a = { lo: 100, hi: 115 };
    const b = { lo: 115, hi: 130 };
    expect(prediveWindowsOverlap(a, b)).toBe(false);
    const rows = [descriptorFor({ ...D61_ROWS[0], start: 100, end: 115 }), descriptorFor({ ...D61_ROWS[1], start: 115, end: 130 })];
    const plan = planPrediveCollapse(rows);
    expect(plan.dive).toHaveLength(2);
    expect(plan.prediveSkipped).toBe(0);
  });

  it("near_miss / big_play rows are never pre-refused on their own lane", () => {
    const base = D61_ROWS[7]; // 341.8
    const notable = (id: string, start: number, end: number, outcome: string) =>
      descriptorFor({ ...base, id, start, end }, { stage1: { eventType: "BIG_PLAY", outcome } });
    const plan = planPrediveCollapse([
      notable("n1", 500, 515, "near_miss"),
      notable("n2", 505, 520, "near_miss"),
      notable("b1", 600, 615, "big_play"),
      notable("b2", 610, 625, "big_play"),
    ]);
    expect(plan.dive.map((d) => d.highlightId).sort()).toEqual(["b1", "b2", "n1", "n2"]);
    expect(plan.prediveSkipped).toBe(0);
  });

  it("the clock lane is untouched: the plan reads windows only, and the served list is unchanged", () => {
    // Two overlapping windows that carry CONTRADICTING clocks: the pre-dive plan
    // collapses them (overlap is the only input) and the read side still serves
    // exactly what it served before (R3: a clock can never attest/confirm/demote).
    const rows = [
      { ...D61_ROWS[7], id: "c1", start: 700, end: 715, matchClock: { seconds: 1200, legible: true, ts: 707 } },
      { ...D61_ROWS[7], id: "c2", start: 705, end: 720, matchClock: { seconds: 2400, legible: true, ts: 712 } },
    ] as HighlightRecord[];
    const plan = planPrediveCollapse(dueFor(rows));
    expect(plan.dive).toHaveLength(1);
    expect(plan.prediveSkipped).toBe(1);
    const before = buildPostableHighlights(rows);
    const after = buildPostableHighlights(
      rows.map((r) => (r.id === plan.dive[0].highlightId ? r : { ...r, confirmAttestation: undefined }))
    );
    expect(after.highlights.map((h) => h.id)).toEqual(before.highlights.map((h) => h.id));
  });
});

describe("ADAAAA-7853 AC6 — inertness (flag OFF is today)", () => {
  it("unset / `0` / `false` leaves confirmPrediveCollapse OFF", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).confirmPrediveCollapse).toBe(false);
    expect(loadConfig({ CONFIRM_PREDIVE_COLLAPSE: "0" } as NodeJS.ProcessEnv).confirmPrediveCollapse).toBe(false);
    expect(loadConfig({ CONFIRM_PREDIVE_COLLAPSE: "off" } as NodeJS.ProcessEnv).confirmPrediveCollapse).toBe(false);
    expect(loadConfig({ CONFIRM_PREDIVE_COLLAPSE: "1" } as NodeJS.ProcessEnv).confirmPrediveCollapse).toBe(true);
  });

  it("flag OFF dispatches all 24 dives with the same verdicts as before", async () => {
    for (const flag of [undefined, false]) {
      const rows = new Map(D61_ROWS.map((r) => [r.id, r]));
      const kinds: Record<string, string> = {};
      const confirm = vi.fn(async () => ({ goalConfirmed: "confirmed_goal" as const, corroborated: true }));
      const state = runState(dueFor(D61_ROWS));
      const out = await runDueConfirmDives({
        run: state as any,
        io: { ...ALL_CONFIRMED, confirm } as any,
        nowTs: 10_000,
        jobId: D61_JOB,
        reuseWindowS: 0,
        prediveCollapse: flag,
        adopt: adoptApplying(rows, kinds),
        log: () => {},
      });
      expect(out.dives).toBe(24);
      expect(out.prediveSkipped).toBe(0);
      expect(confirm).toHaveBeenCalledTimes(24);
      expect(state.prediveSkipped).toBe(0);
      expect(Object.values(kinds).filter((k) => k === "promoted")).toHaveLength(24);
      expect(state.dropped).toHaveLength(0);
    }
  });
});
