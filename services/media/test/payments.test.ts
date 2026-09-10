import { describe, expect, it } from "vitest";
import { createPaymentRefresher } from "../src/payments";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("createPaymentRefresher (a) — pay while open, pay-failure is fatal", () => {
  it("starts on start() and stops on stop()", async () => {
    let calls = 0;
    const ref = createPaymentRefresher({
      refresh: async () => {
        calls++;
      },
      intervalMs: 10,
    });
    ref.start();
    await sleep(60);
    expect(calls).toBeGreaterThanOrEqual(2);
    ref.stop();
    const after = calls;
    await sleep(60);
    expect(calls).toBe(after); // stopped: no further refresh
  });

  it("halts the loop and notifies once on a failed refresh (no resume)", async () => {
    let calls = 0;
    const failures: Error[] = [];
    const ref = createPaymentRefresher({
      refresh: async () => {
        calls++;
        if (calls === 1) throw new Error("payment refresh failed");
      },
      intervalMs: 10,
      onFailure: (e) => failures.push(e),
    });
    ref.start();
    await sleep(80);
    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe("payment refresh failed");
    const at = calls;
    await sleep(60);
    expect(calls).toBe(at); // did not resume after the failure
    ref.stop();
  });
});
