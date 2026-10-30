// Guarded socket / stream writes for the media server (ADAAAA-7591).
//
// Every write in this service targets a peer that can vanish at any moment:
// a browser WebSocket (reload, network drop), the stdin pipe of a short-lived
// ffmpeg decoder (closes the instant the process exits), and the per-session
// recording WriteStream. When such a write fails, libuv reports EPIPE /
// ECONNRESET ASYNCHRONOUSLY (node:internal/stream_base_commons WriteWrap), and
// node reacts by destroying the stream with that error and emitting `'error'`
// on it. With no `'error'` listener attached, the event is re-thrown as an
// unhandled 'error' and the whole node process terminates. Compose runs the
// media service with `restart: no`, so the container then stays DOWN and live
// ingest is dead until something restarts it — that is exactly what killed
// `highlights-media` twice on 2026-10-30 (04:08Z and 04:24:38Z):
//
//   Error: write EPIPE
//       at WriteWrap.onWriteComplete (node:internal/stream_base_commons:51:19)
//   Emitted 'error' event on Socket instance at: ...
//
// These helpers make the class impossible to re-introduce:
//   - `guardStream()` attaches ONE idempotent 'error' listener that logs a
//     warn carrying the session id and destroys the dead stream instead of
//     letting the event escape.
//   - `safeWrite()` / `safeEnd()` never touch an already-destroyed/ended
//     stream, and pass a write callback so a failing write is handled.
//
// Rule for this module: never call `.write()` / `.end()` on a socket, pipe or
// file stream outside these helpers.
import type { Readable, Writable } from "node:stream";

/** Any stream we take a peer error listener on (writes AND child stdio pipes,
 *  which are Readable on the stdout/stderr side). */
export type GuardedStream = Writable | Readable;

/** Marks a stream that already carries our guard listener (idempotent attach). */
const GUARDED = Symbol.for("highlights.media.guardedStream");

/** Streams we consider still usable: a destroyed/ended stream must be skipped
 *  (writing to it would only manufacture another EPIPE/ERR_STREAM_DESTROYED). */
function writable(stream: Writable | undefined | null): boolean {
  const s = stream as any;
  return !!s && s.destroyed !== true && s.writableEnded !== true && s.writable !== false;
}

/**
 * Attach the idempotent 'error' guard to a socket/pipe/file stream.
 *
 * @param label  log/telemetry label, always including the session id, e.g.
 *               `ws session=abc` or `rtc.ffmpeg.stdin session=abc`.
 * @param onError optional cleanup (e.g. drop the socket from the session).
 *                Its own failure is swallowed so a cleanup bug cannot mask the
 *                write failure or re-raise.
 */
export function guardStream(
  stream: GuardedStream | undefined | null,
  label: string,
  onError?: (err: NodeJS.ErrnoException) => void
): void {
  if (!stream) return;
  const marked = stream as GuardedStream & { [GUARDED]?: string };
  if (marked[GUARDED]) return;
  marked[GUARDED] = label;
  stream.on("error", (err: NodeJS.ErrnoException) => {
    // Warn (not throw): a closed peer ends THIS write/session, not the process.
    // eslint-disable-next-line no-console
    console.warn(`[media] write-failed ${label} code=${err?.code ?? "?"} err=${err?.message ?? err}`);
    try {
      onError?.(err);
    } catch {
      /* never let cleanup mask the write failure */
    }
    // The peer is gone; release the dead handle. Idempotent.
    try {
      stream.destroy();
    } catch {
      /* already gone */
    }
  });
}

/** True when `stream` still accepts writes (and has our guard attached). */
export function canWrite(stream: Writable | undefined | null): boolean {
  return writable(stream);
}

/**
 * Write to a possibly-closed stream without risking an unhandled 'error'.
 * Returns false when the write was skipped (stream already gone) or threw
 * synchronously. Errors delivered asynchronously land on the `guardStream`
 * listener (log + destroy), never as an unhandled event.
 */
export function safeWrite(
  stream: Writable | undefined | null,
  chunk: string | Buffer | Uint8Array,
  label: string,
  onError?: (err: NodeJS.ErrnoException) => void
): boolean {
  if (!stream) return false;
  // Guard first: the error may be delivered before any caller attaches one.
  guardStream(stream, label, onError);
  if (!writable(stream)) return false;
  try {
    stream.write(chunk as any, (err?: Error | null) => {
      if (err) {
        // Logged by the guard listener (which also destroys the stream); this
        // callback only keeps the error from becoming "unhandled".
        onError?.(err as NodeJS.ErrnoException);
      }
    });
    return true;
  } catch (err) {
    // Synchronous throw (ERR_STREAM_DESTROYED etc.) — same handling.
    // eslint-disable-next-line no-console
    console.warn(`[media] write-failed ${label} code=${(err as NodeJS.ErrnoException)?.code ?? "?"} err=${(err as Error)?.message ?? err}`);
    try {
      onError?.(err as NodeJS.ErrnoException);
    } catch {
      /* ignore */
    }
    try {
      stream.destroy();
    } catch {
      /* already gone */
    }
    return false;
  }
}

/** End a possibly-closed stream without risking an unhandled 'error'. */
export function safeEnd(stream: Writable | undefined | null, label: string, onError?: (err: NodeJS.ErrnoException) => void): boolean {
  if (!stream) return false;
  guardStream(stream, label, onError);
  if ((stream as any).destroyed === true || (stream as any).writableEnded === true) return false;
  try {
    stream.end(undefined, (err?: Error | null) => {
      if (err) onError?.(err as NodeJS.ErrnoException);
    });
    return true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[media] end-failed ${label} code=${(err as NodeJS.ErrnoException)?.code ?? "?"} err=${(err as Error)?.message ?? err}`);
    try {
      onError?.(err as NodeJS.ErrnoException);
    } catch {
      /* ignore */
    }
    try {
      stream.destroy();
    } catch {
      /* already gone */
    }
    return false;
  }
}
