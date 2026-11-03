// ADAAAA-7838: client-side lazy loads for the owner-facing window inspection.
//
// The Analysis rows become collapsed sections when the owner turns `See detail`
// on, and a row's body is fetched only when they click `Inspect` on THAT row
// (`GET /jobs/:id/sections/:index/inspect`). This module is the DOM-free cache
// the page holds in a ref, so the "one request per window, cached afterwards"
// contract is unit-testable in the node test environment (no jsdom needed).
import { fetchSectionInspect, type SectionInspect } from "./jobDetail";

export interface WindowInspectStore {
  /** A window already inspected this session (no request is issued for it). */
  get(index: number): SectionInspect | undefined;
  /**
   * Load one window's inspection detail. Resolves from the cache when this
   * window was already inspected, joins an in-flight request instead of issuing
   * a second one, and otherwise issues EXACTLY ONE request for this index.
   */
  load(index: number): Promise<SectionInspect>;
  /** Drop every cached window (toggle OFF parks the memory, toggle ON re-fetches). */
  clear(): void;
  /** How many windows are currently cached (test/QA hook). */
  size(): number;
}

/**
 * Build the per-job window-inspection store. `fetcher` is injectable so tests
 * assert the request contract without a network; the page passes the real
 * `fetchSectionInspect`.
 */
export function createWindowInspectStore(
  jobId: string,
  fetcher: (jobId: string, index: number) => Promise<SectionInspect> = fetchSectionInspect
): WindowInspectStore {
  const cache = new Map<number, SectionInspect>();
  const inFlight = new Map<number, Promise<SectionInspect>>();
  return {
    get(index: number) {
      return cache.get(index);
    },
    load(index: number) {
      const hit = cache.get(index);
      if (hit) return Promise.resolve(hit);
      const live = inFlight.get(index);
      if (live) return live;
      const p = fetcher(jobId, index)
        .then((data) => {
          cache.set(index, data);
          return data;
        })
        .finally(() => {
          inFlight.delete(index);
        });
      inFlight.set(index, p);
      return p;
    },
    clear() {
      cache.clear();
      inFlight.clear();
    },
    size() {
      return cache.size;
    },
  };
}
