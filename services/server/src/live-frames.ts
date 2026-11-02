// ADAAAA-7734: persist + serve the frames the media (screen-share / RTC) rail
// already analyzed.
//
// The media node decodes every relayed RTC frame to a JPEG (1 fps, maxWidth 480,
// `-q:v 5`) and POSTs it to `/jobs/:id/observe` as `frameB64`. Until this module
// the control plane used that JPEG for the in-memory decide window and THREW IT
// AWAY: `GET /jobs/:id/frames` 404'd ("no frames for job"), the customer job page
// rendered "Frames shown 0" with blank filmstrip tiles, and every media-rail
// decide note carried the placeholder `analysis.frames = [{seq:0, uri:""}]`.
//
// This module writes the SAME bytes (never a re-fetch, never a re-decode) to the
// job frame dir the frame routes serve, in a layout where the file's numeric
// suffix IS the frame seq, and records the matching observation row so
// `/observations` and the job-detail section builder see it.
//
// Layout + invariants:
//
// - Files are `frame_%06d.jpg` with suffix = the frame's GLOBAL seq (0-based,
//   dense, allocated once per relayed frame). The routes for a `browser` job
//   parse that suffix, so `GET /jobs/:id/frames/<seq>` always returns the exact
//   JPEG that was in the decide window whose note points at `<seq>` — even after
//   old frames were decimated away (a positional mapping would silently shift
//   every tile once the oldest frames are deleted).
// - Retention is bounded at {@link LIVE_FRAME_CAP} frames per job (1800 at the
//   media node's 1 fps sample rate = 30 min). Beyond the cap the OLDEST retained
//   frames are decimated (every other one), so the retained filmstrip keeps even
//   coverage across the share instead of losing a contiguous early block.
// - The write is QUEUED, never awaited on the observe callback: the media node's
//   `POST /jobs/:id/observe` must keep returning `{ok:true}` immediately (its
//   `observeMetrics.meanE2eMs` budget is ~8-9.6 s and must not grow).
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Retained frames per job: 1800 @ 1 fps = 30 min of share. A 480 px-wide JPEG
 *  at `-q:v 5` is ~30-60 KB, so the cap bounds one job at ~55-110 MB. */
export const LIVE_FRAME_CAP = 1800;

/** The frame file name for a seq. Zero-padded so a plain lexicographic sort IS
 *  the seq order (the routes sort by name). */
export function liveFrameFileName(seq: number): string {
  return `frame_${String(Math.max(0, Math.floor(seq))).padStart(6, "0")}.jpg`;
}

/** The seq encoded in a frame file name, or null when the name is not one of
 *  ours (`frame_<digits>.jpg`). */
export function parseLiveFrameSeq(file: string): number | null {
  const m = /^frame_(\d+)\.jpg$/.exec(file);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Which retained seqs to delete to get back under `cap`, oldest first.
 *
 * Decimation deletes every other frame starting at the OLDEST retained seq, so
 * the surviving timeline keeps even coverage (deleting a contiguous oldest block
 * would blank whole early windows, which is the very symptom this issue fixes).
 * A second pass falls back to consecutive oldest frames if the stride pass cannot
 * shed enough (only reachable if the cap shrinks far below what was retained).
 */
export function decimationVictims(seqs: number[], cap: number = LIVE_FRAME_CAP): number[] {
  const sorted = seqs.filter((s) => Number.isFinite(s)).sort((a, b) => a - b);
  let excess = sorted.length - Math.max(1, Math.floor(cap));
  if (excess <= 0) return [];
  const victims: number[] = [];
  for (let i = 0; i < sorted.length && excess > 0; i += 2) {
    victims.push(sorted[i]);
    excess--;
  }
  if (excess > 0) {
    const taken = new Set(victims);
    for (const s of sorted) {
      if (excess <= 0) break;
      if (taken.has(s)) continue;
      victims.push(s);
      excess--;
    }
  }
  return victims;
}

/** One relayed frame handed to the writer. `timestamp` is the rail's CONTENT
 *  clock (seconds from share start), which is what the section builder buckets
 *  into 3 s windows. */
export interface LiveFrameInput {
  seq: number;
  timestamp: number;
  frameB64: string;
  tracks: { trackId: string; label?: string; kind?: string; bbox?: number[] }[];
}

export interface LiveFrameWriterOptions {
  /** Server data dir (cfg.dataDir); frames land in `live/<jobId>/frames`. */
  dataDir: string;
  jobId: string;
  cap?: number;
  /** Durable observation-row sink (`store.recordObservation`). Best-effort: a
   *  failing sink never fails the frame write (and vice versa). */
  recordObservation?: (
    jobId: string,
    obs: { seq: number; timestamp: number; tracks: LiveFrameInput["tracks"] }
  ) => Promise<unknown> | unknown;
  /** Injected for tests. */
  log?: (line: string) => void;
}

/**
 * Serial, bounded queue that writes relayed frames to disk off the observe
 * callback's critical path.
 *
 * `enqueue()` is synchronous and non-blocking; the actual disk I/O runs on an
 * internal promise chain (one write at a time, so a burst of relayed frames
 * cannot open a thousand parallel handles). Errors are logged, never thrown into
 * the request.
 */
export class LiveFrameWriter {
  private readonly dir: string;
  private readonly cap: number;
  private readonly log: (line: string) => void;
  private chain: Promise<void> = Promise.resolve();
  /** Seqs currently retained on disk (ascending by write order). */
  private retained: number[] = [];
  /** Frames enqueued (== the relayed frame count the job reports). */
  private enqueued = 0;
  private written = 0;
  private decimated = 0;
  private failed = 0;
  private dirReady = false;

  constructor(private readonly opts: LiveFrameWriterOptions) {
    this.dir = path.join(opts.dataDir, "live", opts.jobId, "frames");
    this.cap = Math.max(1, Math.floor(opts.cap ?? LIVE_FRAME_CAP));
    this.log = opts.log ?? ((line) => console.error(line));
  }

  /** Frames handed to the writer (the rail's relayed-frame count). */
  count(): number {
    return this.enqueued;
  }

  /** Retained-seqs snapshot (newest last) — the read path's inventory. */
  retainedSeqs(): number[] {
    return [...this.retained];
  }

  stats(): { enqueued: number; written: number; decimated: number; failed: number } {
    return { enqueued: this.enqueued, written: this.written, decimated: this.decimated, failed: this.failed };
  }

  /** Queue one relayed frame. Returns immediately — never awaits disk I/O. */
  enqueue(frame: LiveFrameInput): void {
    if (!frame || !Number.isFinite(frame.seq) || typeof frame.frameB64 !== "string" || !frame.frameB64) return;
    this.enqueued++;
    const seq = Math.floor(frame.seq);
    const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
    const tracks = Array.isArray(frame.tracks) ? frame.tracks : [];
    const b64 = frame.frameB64;
    this.chain = this.chain
      .then(() => this.write(seq, timestamp, b64, tracks))
      .catch((e: any) => {
        this.failed++;
        this.log(`[live-frames:${this.opts.jobId}] frame ${seq} write failed: ${String(e?.message || e)}`);
      });
  }

  /** Await every queued write (completion / tests). */
  async drain(): Promise<void> {
    await this.chain.catch(() => {});
  }

  private async write(
    seq: number,
    timestamp: number,
    b64: string,
    tracks: LiveFrameInput["tracks"]
  ): Promise<void> {
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      this.failed++;
      return;
    }
    if (buf.length === 0) {
      this.failed++;
      return;
    }
    if (!this.dirReady) {
      await mkdir(this.dir, { recursive: true });
      this.dirReady = true;
    }
    await writeFile(path.join(this.dir, liveFrameFileName(seq)), buf);
    this.written++;
    this.retained.push(seq);
    // The observation row is what lets the section builder place the frame in a
    // 3 s window and overlay its tracks; the frame file is what the tile renders.
    if (this.opts.recordObservation) {
      try {
        await this.opts.recordObservation(this.opts.jobId, { seq, timestamp, tracks });
      } catch (e: any) {
        this.log(`[live-frames:${this.opts.jobId}] observation row for frame ${seq} failed: ${String(e?.message || e)}`);
      }
    }
    if (this.retained.length > this.cap) {
      const victims = decimationVictims(this.retained, this.cap);
      if (victims.length) {
        const drop = new Set(victims);
        for (const v of victims) {
          await rm(path.join(this.dir, liveFrameFileName(v)), { force: true }).catch(() => {});
        }
        this.retained = this.retained.filter((s) => !drop.has(s));
        this.decimated += victims.length;
      }
    }
  }
}
