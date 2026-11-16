// ADAAAA-9124 — the LIVE deck bar is pinned as a MEASURED serve-yield, not a claim.
//
// `>= 10` servable refurbished bodies on one live leg could not be met on
// `kids300_7935.mp4` (a 300.05 s loop: 1188 stored rows, 1.5 % with measured
// authority, ZERO of 143 legs reaching 10 — the scorebug rewinds every pass, so the
// scoring lane refuses the later transitions and the promoted row has a clock and
// nothing else). `kidssoccer_54537ffa` (777.9 s, NON-looping, 20 distinct windows,
// 7 monotonic measured score transitions) measures 95 % authority and 11 servable
// bodies on the same writer. Rows/min is the same on both (1.54 vs 1.66): the bar is
// a CONTENT-AUTHORITY problem, which is why no prompt lever was shipped for it.
//
// This test holds that read so a future gate/writer change cannot quietly lower the
// fixture's yield under the rev-17 28.6 % band the ticket was filed against, and so
// the ship-bar (`served >= 10`) is asserted on committed bytes instead of a comment.
// Everything here is `$0`: stored rows only, no model call, no job, no DB write.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { censusFixture, servedYield, type StoredDump } from "../../../evals/adaaa_9124/census9124.js";

const readJson = <T>(relative: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")) as T;

/** The distinct-content fixture: a non-looping 12:58 clip with 20 stored rows. */
const fixtureDump = readJson<StoredDump>("../../../evals/adaaa_9124/live-deck-54537ffa.json");
/** Aggregate census of the looping fixture (1188 rows are not committed). */
const loopCensus = readJson<{
  legs: number;
  rows: number;
  authorityRows: number;
  storedServed: number;
  gateServed: number;
  yield: number;
  legsWithTenServable: number;
  maxServableInOneLeg: number;
}>("../../../evals/adaaa_9124/live-deck-kids300_7935.census.json");

const census = censusFixture(fixtureDump);

describe("ADAAAA-9124 — distinct-content fixture carries the deck bar", () => {
  it("the corpus is the 20-distinct-window fixture measured on one live leg", () => {
    expect(fixtureDump.rows).toHaveLength(20);
    expect(new Set(fixtureDump.rows.map((row) => row.jobId)).size).toBe(1);
    expect(new Set(fixtureDump.rows.map((row) => row.start)).size).toBe(20);
  });

  it("measured authority, not row count, is what the fixture adds (19/20 rows)", () => {
    expect(census.totals.auth).toBe(19);
    // A row whose authority is `none` has nothing legal to say; that class is the
    // whole of the loop's failure and must stay small on an eligible fixture.
    expect(census.totals.auth / census.totals.rows).toBeGreaterThan(0.9);
  });

  it("served/row beats the rev-17 28.6 % band, both as the leg ran and on replay", () => {
    // As the leg ran: 3 accepted + 5 neutralised (record.summaryGate).
    expect(census.totals.storedServed).toBe(8);
    expect(census.totals.storedServed / census.totals.rows).toBeCloseTo(0.4, 5);
    // On the gate replay over the same writer bytes: 11 of 20.
    expect(census.totals.served).toBe(11);
    expect(servedYield(census)).toBeCloseTo(0.55, 5);
    expect(servedYield(census)).toBeGreaterThan(0.286);
  });

  it("reaches the deck bar (>= 10 servable bodies) on the projection", () => {
    const bestLeg = Math.max(...census.legs.map((leg) => leg.served));
    expect(bestLeg).toBe(census.totals.served);
    expect(bestLeg).toBeGreaterThanOrEqual(10);
  });

  it("does not buy that yield with an unattested clause (AC14/8941 item 1 clause half)", () => {
    expect(census.totals.reasons["ac14-clause"] ?? 0).toBe(0);
    // The residual refusals are the product bars, not filler: AC8/AC14 repeats plus
    // the honest contract refusals. Prompt diversity for the repeats is ADAAAA-8928.
    expect(Object.keys(census.totals.reasons).sort()).toEqual([
      "goal-claim",
      "no-new-fact",
      "repeat:opening",
      "repeat:sentence",
      "too-few-facts",
      "unattested-sentence",
    ]);
  });

  it("the loop cannot carry the bar at any yield (the reason no lever was shipped)", () => {
    expect(loopCensus.legs).toBe(143);
    expect(loopCensus.legsWithTenServable).toBe(0);
    expect(loopCensus.maxServableInOneLeg).toBeLessThan(10);
    expect(loopCensus.authorityRows / loopCensus.rows).toBeLessThan(0.02);
    // Rows/min is comparable on both fixtures, so the gap is authority, not density.
    expect(loopCensus.yield).toBeLessThan(servedYield(census));
  });
});
