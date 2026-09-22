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
  /**
   * When true, a refresh failure logs via `onFailure` but the loop keeps
   * running and retries on the next cadence. Default false (a failed payment
   * release is fatal — the current tick halts the loop permanently).
   *
   * ADAAAA-3250: a live perceive session must be re-funded on every payment
   * interval or its signer-state `LastUpdate` goes stale and the NEXT payment
   * bills the ENTIRE backlog since the last successful payment in one batch.
   * go-livepeer's remote signer caps a live batch at 100 tickets
   * (`remote_signer.go` numTickets > 100 -> 400), so a session left unfunded
   * for ~an hour computes hundreds of tickets and its very next refresh is
   * rejected (HTTP 400 `numTickets 456 exceeds maximum of 100`), killing the
   * VOD job. The refresh loop must therefore be resilient: a transient/benign
   * failure (e.g. HTTP 482 "no new tickets needed" when reserved balance
   * already covers the minimum credit) must NOT strand the session. With
   * `retryOnFailure` the loop keeps the cadence and re-funds as soon as the
   * signer will accept it, keeping `LastUpdate` fresh so a real/long clip
   * never accumulates a >100-ticket backlog.
   */
  retryOnFailure?: boolean;
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
      const e = err instanceof Error ? err : new Error(String(err));
      if (opts.retryOnFailure) {
        // Keep the cadence: log and retry on the next interval so a benign /
        // transient failure never strands the session's payment state. A
        // permanently-stale state would bill the whole backlog in one batch on
        // the next successful refresh and be rejected (numTickets > 100).
        if (opts.onFailure) opts.onFailure(e);
        return;
      }
      halt();
      stopped = true;
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
