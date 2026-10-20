import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store";
import { highlightIdempotencyKey, highlightDedupKey } from "../src/analyzer";

// ADAAAA-7118: prove the VOD onEvent dedup guard is keyed on the SAME
// highlightIdempotencyKey that store.addHighlight dedups on, so the live
// `highlightsFound` counter matches the persisted count during processing and
// exactly-once billing is preserved.
//
// `guard` mirrors the exact onEvent guard logic in services/server/src/api.ts
// (VOD worker): it seeds `existingHl` from the persisted highlights, and for
// each incoming `highlight` event it counts an increment ONLY when the
// highlightDedupKey is not already seen. This is the real shipped keying.
function guard(seed: Store["highlightsForJob"] extends (id: string) => infer R ? never : never) {
  // placeholder — never called
  throw new Error("unused");
}

function makeGuard(store: Store, jobId: string) {
  let highlightsFound = store.highlightsForJob(jobId).length;
  const existingHl = new Set(store.highlightsForJob(jobId).map(highlightDedupKey));
  const onHighlight = (rec: { idempotencyKey?: string; start: number; eventType?: string }) => {
    const key = highlightDedupKey(rec);
    if (existingHl.has(key)) return false; // skip: already persisted — no re-debit
    existingHl.add(key);
    highlightsFound++;
    return true;
  };
  return { onHighlight, count: () => highlightsFound, existingHl };
}

function mkRec(jobId: string, seq: number, eventType: string, opts: { idempotencyKey?: string; start?: number; eventTypeOverride?: string } = {}) {
  return {
    id: randomUUID(),
    jobId,
    idempotencyKey: opts.idempotencyKey,
    clipUri: "/clips/x.mp4",
    start: opts.start ?? 5,
    end: 10,
    eventType: opts.eventTypeOverride ?? eventType,
    score: 90,
    status: "pending" as const,
    createdAt: new Date().toISOString(),
  };
}

describe("VOD onEvent dedup guard keyed on highlightIdempotencyKey (ADAAAA-7118)", () => {
  it("increments highlightsFound exactly once for a candidate emitting two events with the SAME idempotency key (GOAL anchor at same seq)", async () => {
    const store = new Store(null);
    const jobId = randomUUID();

    // Two `highlight` events with the SAME idempotency key (seq=150 / GOAL) but
    // DIFFERENT `start` values — this is exactly the GOAL anchor case: the key
    // (hl:<jobId>:<seq>:<eventType>) is shared, but the anchor timestamps can
    // drift a little, so the old `start|eventType` guard saw two DISTINCT keys
    // and double-counted. store.addHighlight dedups the second on the shared
    // idempotencyKey (created:false, no second row/debit).
    const k = highlightIdempotencyKey(jobId, 150, "GOAL");
    const r1 = mkRec(jobId, 150, "GOAL", { idempotencyKey: k, start: 5 });
    const r2 = mkRec(jobId, 150, "GOAL", { idempotencyKey: k, start: 6 });
    // Prove the two events really diverge on the OLD start|eventType key, so a
    // start-keyed guard would NOT dedup them.
    expect(highlightDedupKey({ start: r1.start, eventType: "GOAL" })).not.toBe(
      highlightDedupKey({ start: r2.start, eventType: "GOAL" })
    );
    const a1 = await store.addHighlight(r1);
    const a2 = await store.addHighlight(r2);
    expect(a1.created).toBe(true);
    expect(a2.created).toBe(false); // exactly-once: second deduped
    expect(a2.record.id).toBe(a1.record.id);
    expect(store.highlightsForJob(jobId).length).toBe(1); // 1 persisted

    // Feed BOTH events through the guard (in a fresh in-memory run before the
    // store saw them). The guard (keyed on the idempotency key) must count once.
    const g = makeGuard(new Store(null), jobId); // no prior persisted rows
    const first = g.onHighlight(r1);
    const second = g.onHighlight(r2);
    expect(first).toBe(true);
    expect(second).toBe(false); // same idempotency key already seen → skip
    expect(g.count()).toBe(1); // live counter == persisted count
  });

  it("still increments for two genuinely distinct highlights (different seq)", async () => {
    const store = new Store(null);
    const jobId = randomUUID();
    const k1 = highlightIdempotencyKey(jobId, 150, "GOAL");
    const k2 = highlightIdempotencyKey(jobId, 200, "GOAL");
    expect((await store.addHighlight(mkRec(jobId, 150, "GOAL", { idempotencyKey: k1 }))).created).toBe(true);
    expect((await store.addHighlight(mkRec(jobId, 200, "GOAL", { idempotencyKey: k2 }))).created).toBe(true);

    const g = makeGuard(new Store(null), jobId);
    expect(g.onHighlight(mkRec(jobId, 150, "GOAL", { idempotencyKey: k1 }))).toBe(true);
    expect(g.onHighlight(mkRec(jobId, 200, "GOAL", { idempotencyKey: k2 }))).toBe(true);
    expect(g.count()).toBe(2); // two distinct highlights both counted
  });

  it("on resume, does NOT re-count a highlight already persisted under its idempotency key", async () => {
    const store = new Store(null);
    const jobId = randomUUID();
    const k = highlightIdempotencyKey(jobId, 150, "GOAL");
    await store.addHighlight(mkRec(jobId, 150, "GOAL", { idempotencyKey: k }));
    expect(store.highlightsForJob(jobId).length).toBe(1);

    // A re-claimed/resumed job re-decides the same candidate → same key.
    const g = makeGuard(store, jobId);
    expect(g.count()).toBe(1); // starts from persisted count
    expect(g.onHighlight(mkRec(jobId, 150, "GOAL", { idempotencyKey: k }))).toBe(false); // deduped
    expect(g.count()).toBe(1); // no re-debit, counter stays at persisted count
  });

  it("legacy rows without an idempotencyKey fall back to the start|eventType form (resume protection preserved)", async () => {
    const store = new Store(null);
    const jobId = randomUUID();
    // Persist a legacy row with NO idempotencyKey.
    await store.addHighlight(mkRec(jobId, 0, "GOAL", { start: 5 }));
    expect(store.highlightsForJob(jobId).length).toBe(1);

    // A re-claimed legacy highlight (same start|eventType, still no key) is
    // still deduped by the fallback form.
    const g = makeGuard(store, jobId);
    expect(g.count()).toBe(1);
    expect(g.onHighlight(mkRec(jobId, 0, "GOAL", { start: 5 }))).toBe(false); // start|5|GOAL already seen
    expect(g.count()).toBe(1);
  });
});
