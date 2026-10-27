// ADAAAA-7506: the rolling-fetch window that bounds in-flight frame-image
// fetches in the job-detail view. A VOD job with 100+ decide calls mounts
// hundreds/thousands of frame tiles; if every in-view tile fired its fetch at
// once, the browser's per-tab fetch/decode budget would be exhausted and frame
// URLs would fail with ERR_INSUFFICIENT_RESOURCES. These tests pin the two
// invariants the view depends on: concurrency is capped, and a queued call is
// cancelled (releasing no slot) when its tile scrolls out of view.
import { describe, it, expect } from "vitest";
import { createFrameFetchWindow, frameFetchWindow } from "./frameFetchWindow";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let queued microtasks (window acquire/release) settle. */
async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createFrameFetchWindow", () => {
  it("runs at most maxInFlight calls concurrently, then releases slots", async () => {
    const w = createFrameFetchWindow(2);
    const d1 = deferred<unknown>();
    const d2 = deferred<unknown>();
    const d3 = deferred<unknown>();
    const started: string[] = [];

    const p1 = w.run(async () => {
      started.push("a");
      return d1.promise;
    });
    const p2 = w.run(async () => {
      started.push("b");
      return d2.promise;
    });
    // Third call must NOT start until one of the first two finishes.
    const p3 = w.run(async () => {
      started.push("c");
      return d3.promise;
    });

    await tick();
    expect(started).toEqual(["a", "b"]);

    d1.resolve("A");
    await p1;
    await tick();
    expect(started).toEqual(["a", "b", "c"]);

    d2.resolve("B");
    await p2;
    d3.resolve("C");
    await p3;
  });

  it("runs a single call that finishes under the cap immediately", async () => {
    const w = createFrameFetchWindow(4);
    await expect(w.run(async () => "ok")).resolves.toBe("ok");
  });

  it("cancels a still-queued call when its signal aborts, freeing the slot", async () => {
    const w = createFrameFetchWindow(1);
    const d1 = deferred<unknown>();
    const ctrl = new AbortController();
    const p1 = w.run(async () => d1.promise);
    const p2 = w.run(async () => "cancelled", ctrl.signal); // queued behind p1

    ctrl.abort();
    await expect(p2).rejects.toThrow(/abort/i);

    d1.resolve("ok");
    await p1;

    // Window is still usable after the queued call was cancelled.
    await expect(w.run(async () => "done")).resolves.toBe("done");
  });

  it("ignores a late abort once the call has already started", async () => {
    const w = createFrameFetchWindow(1);
    const ctrl = new AbortController();
    const d = deferred<unknown>();
    const p = w.run(async () => d.promise, ctrl.signal);
    await tick(); // let it acquire a slot and start
    ctrl.abort();
    d.resolve("ok");
    await expect(p).resolves.toBe("ok");
  });
});

describe("frameFetchWindow singleton", () => {
  it("exposes a run() bound to a shared in-flight budget", () => {
    expect(typeof frameFetchWindow.run).toBe("function");
  });
});
