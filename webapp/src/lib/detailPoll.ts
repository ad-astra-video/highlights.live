// Realtime VOD job-detail reconciling poll (ADAAAA-6984).
//
// The SSE channel on /jobs/:id/events is the fast path; this fixed-cadence
// interval is the reconciling fallback that re-fetches the open job's detail so
// a status transition or persisted result shows within one poll cycle even when
// an SSE event is missed or the socket drops. It is deliberately tiny and
// DOM-free so the timer lifecycle is unit-testable in the node vitest
// environment (no React, no jsdom) — see detailPoll.test.ts.
//
// AC-1: polls every VOD_DETAIL_POLL_MS and updates the detail in place.
// AC-2: one timer per open detail view; the caller's `stop()` (on unmount/close)
//        clears it so no interval leaks.
// AC-3: `shouldContinue()` returns false once the job is terminal, so the timer
//        self-stops on the next tick and no post-terminal fetch runs.
// AC-6: a failed onTick (network / 5xx) is swallowed by the caller and the next
//        tick retries — the controller never throws.
export const VOD_DETAIL_POLL_MS = 5_000;

export interface DetailPollController {
  /** Stop the timer; idempotent. Safe to call more than once. */
  stop(): void;
}

/**
 * Run `onTick` every `intervalMs` (default VOD_DETAIL_POLL_MS) while
 * `shouldContinue()` returns true. Each tick re-checks `shouldContinue()`
 * before running `onTick`, and clears itself on the first false (e.g. once the
 * job reaches a terminal state) so a done/failed job never keeps polling.
 */
export function startDetailPoll(opts: {
  intervalMs?: number;
  shouldContinue: () => boolean;
  onTick: () => void;
}): DetailPollController {
  const { intervalMs = VOD_DETAIL_POLL_MS, shouldContinue, onTick } = opts;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  function stop() {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
  }

  timer = setInterval(() => {
    // A tick that observes the "no longer continue" condition clears itself
    // instead of calling onTick, so a terminal job is never re-fetched.
    if (stopped) return;
    if (!shouldContinue()) {
      stop();
      return;
    }
    try {
      onTick();
    } catch {
      // A throwing onTick must not kill the timer; the caller handles errors.
      // The next tick retries.
    }
  }, intervalMs);

  return { stop };
}
