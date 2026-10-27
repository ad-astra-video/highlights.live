// Rolling-window executor for frame-image fetches (ADAAAA-7506).
//
// A VOD job with 100+ decide calls can render hundreds/thousands of frame
// tiles in the job-detail view. If every in-view tile fired its image fetch at
// once, the browser's per-tab fetch/decode budget is exhausted and the frame
// URLs start failing with ERR_INSUFFICIENT_RESOURCES. This bounds how many
// frame-image fetches are *in flight* at any moment (a rolling window) so the
// view never asks for all the frames at once.
//
// An optional AbortSignal cancels a *queued* call before it starts: once a
// frame tile scrolls back out of view its fetch slot is released and no bytes
// are downloaded for a frame that is no longer shown. (Cancelling an
// already-running fetch remains the caller's job via fetch's own signal.)
//
// The executor is pure and env-agnostic so it is unit-testable without a DOM
// or a real fetch.

export interface FrameFetchWindow {
  /**
   * Run `fn` once a slot is free, holding the slot for the whole call. If
   * `signal` aborts while the call is still *queued*, the call never starts and
   * the returned promise rejects with the signal reason.
   */
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function createFrameFetchWindow(maxInFlight: number): FrameFetchWindow {
  let active = 0;
  const waiters: Array<() => void> = [];

  function acquire(signal?: AbortSignal): Promise<void> {
    if (active < maxInFlight) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiters.indexOf(task);
        if (i >= 0) waiters.splice(i, 1);
        reject(abortReason(signal!));
      };
      // `task` itself is the queued unit (so `waiters.indexOf(task)` in
      // `onAbort` can find and remove it). It removes its own abort listener
      // when it finally runs, so a late abort after the call has started is
      // ignored and the slot is still released on completion.
      const task = () => {
        signal?.removeEventListener("abort", onAbort);
        active++;
        resolve();
      };
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.push(task);
    });
  }

  function release(): void {
    active--;
    waiters.shift()?.();
  }

  return {
    async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await acquire(signal);
      try {
        return await fn();
      } finally {
        release();
      }
    },
  };
}

/**
 * The job-detail frame-image window. A single shared window means every frame
 * fetch in the view (inline tiles + the enlarged gallery) shares the same
 * in-flight budget — the whole view never exceeds this many concurrent
 * fetches.
 */
const FRAME_FETCH_MAX_IN_FLIGHT = 4;

export const frameFetchWindow = createFrameFetchWindow(FRAME_FETCH_MAX_IN_FLIGHT);
