// ADAAAA-8099 — QA evidence durability for the server's lane logs.
//
// `docker logs highlights-server` is a window, not a record. A compose recreate
// (`docker compose up -d [--force-recreate] server`) removes the old container,
// and the json-file log belongs to that container's directory, so every deploy
// deletes the lines QA grades: `[ingest-gap:<job>]`, `ready mid-share` and
// `[summary:<job>] stored ... avoid={...}`. ADAAAA-8057 / ADAAAA-8058 were both
// voided that way — the pipeline was correct, the evidence was gone.
//
// The durable surface is a file under the server's own dataDir, which compose
// bind-mounts from the host (`./data:/data`), so it outlives the container:
//
//     ${DATA_DIR}/logs/server.log            (default /data/logs/server.log)
//
// This module tees process.stdout/stderr into that file. `docker logs` keeps
// working and keeps its exact ordering/backpressure behaviour (the original
// write is called with the original arguments); the file is the superset that
// survives a recreate.
//
// Retention is bounded, not time-based: server.log plus `maxFiles` rotated
// segments, each capped at `maxBytes`, so the ceiling is
// (maxFiles + 1) * maxBytes (default 5 * 25 MiB = 125 MiB). Rotation happens at
// the START of a write that would exceed the cap, so a line is never split
// across files and nothing is lost at the boundary.
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

/** Per-file cap for the durable server log (25 MiB). */
export const SERVER_LOG_MAX_BYTES = 25 * 1024 * 1024;
/** Rotated segments kept beside `server.log` (.1 .. .4). */
export const SERVER_LOG_MAX_FILES = 4;

/** The path the server writes, derived from the same DATA_DIR the compose
 *  service sets. No new env is required: a dev boot without DATA_DIR writes to
 *  `data/logs/server.log`, exactly like the rest of dataDir. */
export function serverLogFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.DATA_DIR ?? "data", "logs", "server.log");
}

type WriteFn = (chunk: unknown, ...rest: unknown[]) => unknown;

export interface LogFileTeeOptions {
  file: string;
  maxBytes?: number;
  maxFiles?: number;
  /** Sinks to tee; defaults to process.stdout / process.stderr. */
  out?: { write: WriteFn };
  err?: { write: WriteFn };
}

export interface LogFileTee {
  file: string;
  /** Number of rotations performed this lifetime (0 for a fresh short boot). */
  rotations: number;
  /** Bytes appended to the current segment. */
  bytesWritten: number;
  /** Failed appends; after 5 the file sink disables itself and stdout is
   *  untouched (a log file problem must never affect serving). */
  writeErrors: number;
  close(): void;
}

function asBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (Buffer.isBuffer(chunk)) return chunk;
  return Buffer.from(String(chunk), "utf8");
}

/** Tee stdout+stderr into a rotating file. Idempotent per call; the caller owns
 *  the returned handle. Never throws on the write path. */
export function installLogFileTee(opts: LogFileTeeOptions): LogFileTee {
  const maxBytes = opts.maxBytes ?? SERVER_LOG_MAX_BYTES;
  const maxFiles = opts.maxFiles ?? SERVER_LOG_MAX_FILES;
  const out = opts.out ?? process.stdout;
  const err = opts.err ?? process.stderr;

  let fd: number | null = null;
  let bytes = 0;
  let rotations = 0;
  let writeErrors = 0;
  let closed = false;

  // A bad/unwritable log path must never stop the server from booting: degrade
  // to stdout-only and let the counters say so.
  try {
    mkdirSync(dirname(opts.file), { recursive: true });
    fd = openSync(opts.file, "a");
    bytes = existsSync(opts.file) ? statSync(opts.file).size : 0;
  } catch {
    writeErrors += 1;
    fd = null;
  }

  const rotate = () => {
    if (fd === null) return;
    closeSync(fd);
    try {
      const oldest = `${opts.file}.${maxFiles}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = `${opts.file}.${i}`;
        if (existsSync(from)) renameSync(from, `${opts.file}.${i + 1}`);
      }
      if (existsSync(opts.file)) renameSync(opts.file, `${opts.file}.1`);
    } finally {
      fd = openSync(opts.file, "a");
      bytes = 0;
      rotations += 1;
    }
  };

  const append = (chunk: unknown) => {
    if (closed || fd === null || writeErrors >= 5) return;
    const buf = asBuffer(chunk);
    try {
      if (bytes + buf.length > maxBytes) rotate();
      if (fd !== null) writeSync(fd, buf);
      bytes += buf.length;
    } catch {
      writeErrors += 1;
    }
  };

  const originalOut = (out.write as WriteFn).bind(out);
  const originalErr = (err.write as WriteFn).bind(err);
  out.write = ((chunk: unknown, ...rest: unknown[]) => {
    append(chunk);
    return originalOut(chunk, ...rest);
  }) as WriteFn;
  err.write = ((chunk: unknown, ...rest: unknown[]) => {
    append(chunk);
    return originalErr(chunk, ...rest);
  }) as WriteFn;

  return {
    file: opts.file,
    get rotations() {
      return rotations;
    },
    get bytesWritten() {
      return bytes;
    },
    get writeErrors() {
      return writeErrors;
    },
    close() {
      if (closed) return;
      closed = true;
      out.write = originalOut as WriteFn;
      err.write = originalErr as WriteFn;
      try {
        closeSync(fd as number);
      } catch {
        /* already gone */
      }
    },
  };
}
