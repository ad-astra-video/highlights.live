import { describe, it, expect, vi } from "vitest";
import { fetchJobDetail, fetchSectionInspect, fetchSectionsDelta } from "./jobDetail";
import { createWindowInspectStore } from "./windowInspect";

// ADAAAA-7838: the client side of the payload gate.
//
// - `fetchJobDetail` / `fetchSectionsDelta` carry `inspect=1` ONLY while the
//   owner's `See detail` toggle is on (AC5: OFF issues no internals request;
//   AC7/req 7: the live poll stops asking the moment the toggle goes off).
// - The per-window lazy read is ONE request for the clicked bucket (AC6), and an
//   already-inspected window is served from the session cache instead of being
//   requested again.
//
// The node test env has no jsdom/@testing-library, so the click itself is not
// simulated here; the store below IS the click handler's request path (the row's
// `Inspect` button calls `store.load(index)`), so the request contract is
// asserted against the same function the button drives.

vi.mock("./api", () => ({
  api: vi.fn(() => Promise.resolve({})),
  getToken: () => "tok",
}));

import { api } from "./api";

const mockedApi = api as unknown as ReturnType<typeof vi.fn>;

describe("inspect query-parameter fidelity (ADAAAA-7838 req 7)", () => {
  it("omits inspect=1 from the detail fetch while See detail is OFF", async () => {
    mockedApi.mockClear();
    await fetchJobDetail("job-1");
    expect(mockedApi).toHaveBeenCalledWith("/jobs/job-1/detail");
  });

  it("adds ?inspect=1 to the detail fetch while See detail is ON", async () => {
    mockedApi.mockClear();
    await fetchJobDetail("job-1", { inspect: true });
    expect(mockedApi).toHaveBeenCalledWith("/jobs/job-1/detail?inspect=1");
  });

  it("omits inspect=1 from the delta poll while OFF and adds it while ON", async () => {
    mockedApi.mockClear();
    await fetchSectionsDelta("job-1", 4);
    expect(mockedApi).toHaveBeenCalledWith("/jobs/job-1/sections-delta?afterIndex=4");
    await fetchSectionsDelta("job-1", 4, { inspect: true });
    expect(mockedApi).toHaveBeenCalledWith("/jobs/job-1/sections-delta?afterIndex=4&inspect=1");
  });

  it("targets the single-window inspect route with the row's bucket index", async () => {
    mockedApi.mockClear();
    await fetchSectionInspect("job-1", 12);
    expect(mockedApi).toHaveBeenCalledWith("/jobs/job-1/sections/12/inspect");
    expect(mockedApi).toHaveBeenCalledTimes(1);
  });
});

describe("createWindowInspectStore (ADAAAA-7838 AC6: one request per window)", () => {
  const data = (jobId: string, index: number) => ({
    jobId,
    index,
    startS: index * 3,
    endS: (index + 1) * 3,
    decideNotes: [],
  });

  it("issues exactly ONE request for the clicked window index", async () => {
    const fetcher = vi.fn(async (jobId: string, index: number) => data(jobId, index));
    const store = createWindowInspectStore("job-7", fetcher);
    const got = await store.load(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("job-7", 4);
    expect(got.index).toBe(4);
    // ...and no other row was requested on the way.
    expect(fetcher.mock.calls.map((c) => c[1])).toEqual([4]);
  });

  it("serves an already-inspected window from the cache (no second request)", async () => {
    const fetcher = vi.fn(async (jobId: string, index: number) => data(jobId, index));
    const store = createWindowInspectStore("job-7", fetcher);
    await store.load(4);
    await store.load(4);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(store.size()).toBe(1);
  });

  it("joins an in-flight load instead of stacking a second request", async () => {
    let release: (v: any) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const store = createWindowInspectStore("job-7", fetcher as any);
    const a = store.load(2);
    const b = store.load(2);
    expect(fetcher).toHaveBeenCalledTimes(1);
    release(data("job-7", 2));
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.index).toBe(2);
    expect(rb.index).toBe(2);
  });

  it("clear() parks the cached windows so a re-toggle does not balloon memory", async () => {
    const fetcher = vi.fn(async (jobId: string, index: number) => data(jobId, index));
    const store = createWindowInspectStore("job-7", fetcher);
    await store.load(1);
    await store.load(2);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.get(1)).toBeUndefined();
    // toggling back on re-fetches the window the owner opens again
    await store.load(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
