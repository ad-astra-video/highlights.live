// Payment-refresh primitive for the media server (the payer).
//
// On-chain, a perceived live session must be re-funded on every orchestrator
// payment interval or it is released. The media server pays the whole time the
// stream is open and stops the moment it closes (WS drop, explicit stop, or a
// failed refresh). A FAILED refresh is fatal: we stop paying AND release the
// session rather than keep the runner working for free — so a pay failure is
// itself one of the ways a stream closes.
//
// Off the on-chain profile (no signer) refresh is a no-op and nothing starts —
// offchain lab boxes are unpaid.

export interface PaymentRefresher {
  /** Begin the interval loop. Idempotent. */
  start(): void;
  /** Stop the loop. Safe to call multiple times. */
  stop(): void;
}

export interface PaymentRefresherOptions {
  /** Perform one refresh (e.g. client.refreshPerceivePayment on the controlUrl). */
  refresh: () => Promise<unknown>;
  /** Interval between refreshes, in ms. */
  intervalMs: number;
  /**
   * Called when a refresh throws. The loop stops and does NOT auto-resume (a
   * failed payment release is fatal) — the caller wires this to close the
   * stream. Default: halt silently for offchain no-op refreshes.
   */
  onFailure?: (err: Error) => void;
  /** External abort (stream end) — same as stop(). */
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
      if (opts.onFailure) opts.onFailure(e);
    }
  };

  const start = () => {
    if (timer || stopped) return;
    void tick(); // fire once immediately, then on the interval
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
