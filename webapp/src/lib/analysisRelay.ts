// Relay helpers for the media-server analysis WS (ADAAAA-6746 G1b).
//
// The media server writes JSON analysis messages over the same /stream/:sid
// WebSocket it hands back as `media.wsUrl`. The webapp consumes them as:
//   {"type":"analysis","status":"state","state":{...},"at":<epochMs>}
//   {"type":"analysis","status":"event","event":{...}}
//   {"type":"analysis","status":"trace","trace":{...}}
// This module holds the small, framework-free pieces so the buffering/ batching
// logic is unit-testable and the component stays a dumb consumer.

/** Live analysis session state snapshot emitted by perceive (state message). */
export interface AnalysisSessionState {
  sessionId?: string;
  streamId?: string;
  startedTs?: number;
  lastTs?: number;
  audioSamples?: number;
  frameSnapshots?: number;
  captionLines?: number;
  active?: boolean;
  windowMaxSeconds?: number;
  tools?: string[];
}

/** One awareness analysis data sample / windowed tool result (event message). */
export interface AnalysisEvent {
  jobId?: string;
  sessionId?: string;
  streamId?: string;
  timestamp: number;
  kind: string;
  data: Record<string, unknown>;
}

/** A decide -> perceive request + result to persist (trace message). */
export interface AnalysisTrace {
  jobId?: string;
  sessionId?: string;
  streamId?: string;
  at: number;
  tool?: string;
  window?: Record<string, unknown>;
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  updated?: Record<string, unknown>;
}

/**
 * Buffer analysis events and flush them to a sink in capped batches. The sink
 * receives the batch to POST (as body {events:[...]}); pushes beyond the cap
 * flush immediately, otherwise the batch flushes on a timer. `stop()` clears
 * any pending timer/buffer (call on capture stop/unmount).
 */
export function makeAnalysisBatcher(
  post: (events: AnalysisEvent[]) => void,
  opts: { intervalMs?: number; maxBatch?: number } = {}
) {
  const intervalMs = opts.intervalMs ?? 2000;
  const maxBatch = opts.maxBatch ?? 200;
  let buf: AnalysisEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (buf.length === 0) return;
    // Cap, never exceed: hand off at most maxBatch, keep any overflow for the
    // next flush rather than dropping it.
    const batch = buf.splice(0, maxBatch);
    post(batch);
    if (buf.length > 0) {
      timer = setTimeout(flush, intervalMs);
    }
  };

  const push = (ev: AnalysisEvent) => {
    buf.push(ev);
    if (buf.length >= maxBatch) {
      flush();
    } else if (!timer) {
      timer = setTimeout(flush, intervalMs);
    }
  };

  const stop = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    buf = [];
  };

  const pending = () => buf.length;

  return { push, flush, stop, pending };
}
