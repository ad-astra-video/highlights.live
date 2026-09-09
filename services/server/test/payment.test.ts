import { describe, expect, it, vi } from "vitest";
import { createPaymentRefresher, makeSignerStatePersister } from "../src/payment";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createPaymentRefresher", () => {
  it("fires refresh on the interval and stops cleanly", async () => {
    const refresh = vi.fn(async () => {});
    const r = createPaymentRefresher({ refresh, intervalMs: 20 });
    r.start();
    await sleep(65); // ~3 ticks
    r.stop();
    const calls = refresh.mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(5);
  });

  it("stops and never resumes after a failed refresh (onFailure path)", async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("pay failed"));
    const onFailure = vi.fn();
    const r = createPaymentRefresher({ refresh, intervalMs: 20, onFailure });
    r.start();
    await sleep(60);
    r.stop();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0][0].message).toBe("pay failed");
    // after failure, further ticks must not run refresh again
    const after = refresh.mock.calls.length;
    await sleep(50);
    expect(refresh.mock.calls.length).toBe(after);
  });

  it("aborts via external signal", async () => {
    const ac = new AbortController();
    const refresh = vi.fn(async () => {});
    const r = createPaymentRefresher({ refresh, intervalMs: 20, signal: ac.signal });
    r.start();
    await sleep(45);
    ac.abort();
    const calls = refresh.mock.calls.length;
    await sleep(50);
    expect(refresh.mock.calls.length).toBe(calls);
  });

  it("halts without crashing when no onFailure is supplied", async () => {
    const refresh = vi.fn().mockRejectedValue(new Error("boom"));
    const r = createPaymentRefresher({ refresh, intervalMs: 20 });
    r.start();
    await sleep(40);
    // loop must halt after the failure: no further refresh calls
    const calls = refresh.mock.calls.length;
    await sleep(40);
    expect(refresh.mock.calls.length).toBe(calls);
    r.stop();
  });
});

describe("makeSignerStatePersister", () => {
  it("persists the latest signerState after each refresh", async () => {
    const persisted: unknown[] = [];
    const refresh = vi.fn(async () => ({
      signerState: { nonce: 7 },
      persist: (s: unknown) => persisted.push(s),
    }));
    const wrapped = makeSignerStatePersister(refresh);
    await wrapped();
    await wrapped();
    expect(persisted).toEqual([{ nonce: 7 }, { nonce: 7 }]);
  });
});
