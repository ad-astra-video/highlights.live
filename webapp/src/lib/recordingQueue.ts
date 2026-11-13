// A BOUNDED upload queue for MediaRecorder chunks (ADAAAA-8848 F2).
//
// The recorder emits a ~1 s chunk. Uploading each chunk down one serial promise
// chain with no cap made the tab's memory grow monotonically with share length:
// at 3 Mbps the recorder produces ~366 KB/s raw (~488 KB/s once base64-encoded)
// while a 1 Mbps uplink drains ~125 KB/s, so an hour-long share accumulated
// gigabytes and the tab OOM'd.
//
// The queue holds at most `limit` un-uploaded chunks (30 = 30 s at the 1 s
// recorder cadence). On overflow it drops the OLDEST chunk, counts the drop, and
// reports a recording gap — a truthful "this part of the share is missing" that
// the views render while the share is live. Memory then tracks a fixed buffer
// instead of the share's duration.

/** 30 chunks = 30 s of share at MediaRecorder's 1 s cadence. */
export const RECORDING_QUEUE_LIMIT = 30;

export interface RecordingChunk {
  blob: Blob;
  mime: string;
}

export interface RecordingGap {
  /** Chunks dropped so far this share (1 chunk ≈ 1 s of recording). */
  dropped: number;
  /** Bytes those dropped chunks held. */
  droppedBytes: number;
}

export interface BoundedRecordingQueueOptions {
  /** Uploads one chunk. Rejections are counted and do not stop the drain. */
  upload: (chunk: RecordingChunk) => Promise<void>;
  /** Called after every drop, so the owner can raise its gap notice. */
  onGap?: (gap: RecordingGap) => void;
  /** Un-uploaded chunks held before the oldest is dropped (default 30). */
  limit?: number;
}

/** The copy the views show once the queue had to drop recording. It names the
 *  real consequence (clips inside the gap are missing) instead of implying the
 *  recording is complete. */
export function recordingGapNotice(gap: RecordingGap): string {
  const seconds = Math.max(1, gap.dropped);
  const megabytes = (gap.droppedBytes / (1024 * 1024)).toFixed(1);
  return (
    `Recording gap — upload is slower than capture, so ${seconds} s of this share ` +
    `(~${megabytes} MB) could not be uploaded and was dropped. Any highlight inside ` +
    `that gap has no video. Clips before and after it are unaffected.`
  );
}

/** Serial, bounded upload queue. One chunk is in flight at a time, because the
 *  server APPENDS every chunk to one file: overlapping POSTs could reorder bytes
 *  and corrupt the container. */
export class BoundedRecordingQueue {
  private readonly limit: number;
  private readonly upload: (chunk: RecordingChunk) => Promise<void>;
  private readonly onGap?: (gap: RecordingGap) => void;
  private readonly buffered: RecordingChunk[] = [];
  private draining = false;
  /** The chunk currently in `upload()` — it is un-uploaded too, so it counts
   *  against the bound (30 un-uploaded chunks, not 29 + 1). */
  private inFlight = 0;
  private closed = false;
  private idle: Promise<void> = Promise.resolve();
  private resolveIdle: (() => void) | null = null;
  private dropped = 0;
  private droppedBytes = 0;
  private failed = 0;

  constructor(options: BoundedRecordingQueueOptions) {
    this.limit = Math.max(1, options.limit ?? RECORDING_QUEUE_LIMIT);
    this.upload = options.upload;
    this.onGap = options.onGap;
  }

  /** Un-uploaded chunks held, INCLUDING the one currently uploading (never
   *  exceeds `limit`). */
  get size(): number {
    return this.buffered.length + this.inFlight;
  }

  /** Chunks dropped because the queue was full. */
  get dropCount(): number {
    return this.dropped;
  }

  /** Uploads that rejected after the owner's own retries. */
  get failureCount(): number {
    return this.failed;
  }

  get gap(): RecordingGap {
    return { dropped: this.dropped, droppedBytes: this.droppedBytes };
  }

  /** Queue one chunk. Overflow drops the OLDEST chunk: the newest bytes keep
   *  flowing (so a clip near "now" still has video) and the gap is recorded in
   *  the timeline where it happened. */
  push(blob: Blob, mime: string): void {
    if (this.closed) return;
    while (this.size >= this.limit) {
      const droppedChunk = this.buffered.shift();
      if (!droppedChunk) break;
      this.dropped += 1;
      this.droppedBytes += droppedChunk.blob.size;
    }
    this.buffered.push({ blob, mime });
    if (this.dropped > 0 && this.onGap) this.onGap(this.gap);
    void this.drain();
  }

  /** Resolves once every chunk queued SO FAR has been uploaded (or failed).
   *  Finalize awaits this before `POST /stop`, so the clip cut sees the whole
   *  recording the server actually holds. */
  flush(): Promise<void> {
    if (this.buffered.length === 0 && !this.draining) return Promise.resolve();
    return this.idle;
  }

  /** Stop accepting chunks (a stopped share must not keep the queue alive). */
  close(): void {
    this.closed = true;
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    this.idle = new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
    void this.run();
  }

  private async run(): Promise<void> {
    while (this.buffered.length > 0) {
      const chunk = this.buffered.shift()!;
      this.inFlight = 1;
      try {
        await this.upload(chunk);
      } catch {
        this.failed += 1;
      } finally {
        this.inFlight = 0;
      }
    }
    this.draining = false;
    this.resolveIdle?.();
    this.resolveIdle = null;
  }
}
