// Payment refresh loop for a persistent perceive session (plan §4.2 step 4,
// §0.4). On-chain, a perceive session must be re-funded on every orchestrator
// payment interval or it is released (and SAM3 state is wiped). This loop is
// therefore as critical as the analyze loop: on a failed refresh we STOP the
// session rather than keep tracking it for free.
//
// Off the on-chain profile (no signer) the worker never calls this — it is
// dropped at the adapter boundary, so offchain tests are unaffected.

export interface PaymentRefresher {
  /** Begin the interval loop. Idempotent. */
  start(): void;
  /** Stop the loop. Safe to call multiple times. */
  stop(): void;
}

export interface PaymentRefresherOptions {
  /** Perform one refresh (e.g. LivepeerClient.refreshPerceivePayment). */
  refresh: () => Promise<unknown>;
  /** Interval between refreshes, in ms. */
  intervalMs: number;
  /**
   * Called when a refresh throws. If it returns/throws nothing further, the
   * loop stops and does NOT auto-resume (a failed payment release is fatal).
   * Default: rethrow (aborts the caller too).
   */
  onFailure?: (err: Error) => void;
  /** External abort (e.g. on stream end) — same as stop(). */
  signal?: AbortSignal;
}

export function createPaymentRefresher(opts: PaymentRefresherOptions): PaymentRefresher {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;

  const halt = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = async () => {
    try {
      await opts.refresh();
    } catch (err) {
      halt();
      stopped = true;
      const e = err instanceof Error ? err : new Error(String(err));
      // The worker MUST wire onFailure to stop the perceive session on a failed
      // payment (plan: releasing SAM3 for free is worse than stopping). Without
      // a handler we halt the loop but do NOT rethrow — an unhandled rejection
      // from a setInterval callback would crash the process.
      if (opts.onFailure) opts.onFailure(e);
    }
  };

  const start = () => {
    if (timer || stopped) return;
    // fire once immediately, then on the interval
    void tick();
    timer = setInterval(() => void tick(), Math.max(50, opts.intervalMs));
    if (opts.signal) {
      if (opts.signal.aborted) {
        stop();
        return;
      }
      opts.signal.addEventListener("abort", stop, { once: true });
    }
  };

  const stop = () => {
    stopped = true;
    halt();
    opts.signal?.removeEventListener("abort", stop);
  };

  return { start, stop };
}

/**
 * Convenience: persist the latest signerState right after a successful refresh.
 * Returns a refresh callback suitable for createPaymentRefresher.
 */
export function makeSignerStatePersister(
  refresh: () => Promise<{ signerState: unknown; persist: (s: unknown) => void }>
): () => Promise<unknown> {
  return async () => {
    const { signerState, persist } = await refresh();
    persist(signerState);
    return signerState;
  };
}
