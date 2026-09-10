// Payment + lifecycle seam for the media server.
//
// (b) builds the transport handshake; payment is the (a) step. This module is
// the seam the (a) implementation fills in — it already wires the *teardown*
// contract so every stream-close path stops payment and releases the slot once
// the real refiller lands.
//
// Contract (shared with the server's createPaymentRefresher):
//   - A payment refresher starts when a stream is provisioned/open and is
//     stopped on ANY close (user stop, WS drop, payment-failure-when-on-chain).
//   - A FAILED refresh is FATAL: never keep the perceive runner tracking for
//     free — stop the session. So payment failure both ends the stream and
//     owes nothing afterward.
export interface StreamLifecycle {
  /** Start recurring platform payment for an open stream. Offchain: no-op. */
  startPayment(streamId: string): void;
  /** Stop paying. Safe to call many times. */
  stopPayment(streamId: string): void;
}

/** Offchain / (b) stub: payments are no-ops until the (a) signer-ticket rail. */
export function createLifecycle(_opts?: {
  payment?: { intervalMs?: number; refill?: (streamId: string) => Promise<unknown> };
}): StreamLifecycle {
  const timers = new Map<string, ReturnType<typeof setInterval>>();
  return {
    startPayment(streamId: string) {
      const opts = _opts?.payment;
      if (!opts || !opts.refill) return; // no signer config -> offchain, nothing to pay
      if (timers.has(streamId)) return;
      const tick = () => opts.refill!(streamId).catch(() => this.stopPayment(streamId));
      tick();
      timers.set(streamId, setInterval(tick, Math.max(50, opts.intervalMs ?? 5000)));
    },
    stopPayment(streamId: string) {
      const t = timers.get(streamId);
      if (t) {
        clearInterval(t);
        timers.delete(streamId);
      }
    },
  };
}
