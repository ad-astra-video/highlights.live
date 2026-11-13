// Live ingest: capture screen (gdigrab), pull an RTMP stream, or loop a local
// file as a synthetic live source — record the session to disk (seekable MPEG-TS)
// while sampling JPEG frames into the analyzer rail. Clips are cut from the
// session recording instead of a pre-existing file, so the existing analyzeJob
// pipeline runs unchanged over a live stream.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { probeDuration, probeFlushedDuration } from "./ffmpeg";
import { anchorCutOnEvidence, clipAuditFields, type ClipCut } from "./clip-anchor";
import type { ClipCutWindow } from "./clip-placement";
import { clipWindow } from "./config";
import type { ServerConfig } from "./config";

export type LiveKind = "screen" | "rtmp" | "file-sim";

/** ADAAAA-8168: mirror of the browser rail's flush guard (ADAAAA-8113/8061).
 * A live cut may only publish footage the recording FILE has actually written,
 * and it must publish the WHOLE window — a window cut while the recorder is
 * still short of `win.end` used to ship a sub-floor file. */
export const LIVE_CLIP_MAX_WAIT_MS = 45_000;
const LIVE_CLIP_POLL_MS = 250;
/** ADAAAA-8495: how often the flush wait may spend a DEMUX of the growing
 * recording to confirm the recorder's own muxed clock. The wait used to spawn
 * one `ffprobe` of the whole MPEG-TS every 250 ms (25,425 ms of the 51,737 ms
 * accept stage on leg 2c4124fe's 7 separable rows); the recorder now reports
 * its own flushed clock via `-progress`, and the demux is only a ONE-per-second
 * cross-check so a stalled/looping progress clock can never publish a short
 * file. */
const LIVE_CLIP_CONFIRM_MS = 1_000;
/** A stream-copy cut from this rail's MPEG-TS session lands on the source's
 * keyframes, so the delivered file comes back up to ~0.5 s SHORT of the window
 * it was asked for (measured 14.700 s for a 15.000 s request). The floor is a
 * hard ">= clipWindowMinSec" on the delivered file, so cut a touch past the
 * window and grade the delivered bytes against the window itself. */
const LIVE_CLIP_DUR_PAD_S = 0.7;


export interface LiveSpec {
  kind: LiveKind;
  /** For rtmp: the rtmp:// URL to pull. For file-sim: a local video path. Screen: unused. */
  url?: string;
  /** Seconds to wait between emitted frames (1 / sampleFps). */
  sampleInterval: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * ADAAAA-8495: the recorder's own WRITE WATERMARK.
 *
 * The recording ffmpeg runs with `-progress pipe:1`, so it reports the muxed
 * output clock (`out_time_us`, microseconds relative to the output start) on
 * stdout every ~0.5 s. That is a flushed-duration watermark available with NO
 * subprocess: the flush wait used to spawn one `ffprobe` demux of the whole
 * growing MPEG-TS every 250 ms, which was the dominant single bucket inside the
 * live accept stage (25,425 ms of 51,737 ms across the 7 separable rows of leg
 * 2c4124fe).
 *
 * `parseRecorderProgress` is pure: feed it the accumulated stream and it returns
 * the newest COMPLETE progress block's `out_time_us` (a `progress=` line closes
 * a block, so a half-written `out_time_us=` can never be read as a newer clock).
 * Returns null until a block completes.
 */
export function parseRecorderProgress(text: string): { outTimeSec: number | null; end: boolean; rest: string } {
  const cutoff = text.lastIndexOf("progress=");
  if (cutoff < 0) return { outTimeSec: null, end: false, rest: text };
  const completed = text.slice(0, cutoff);
  const end = /^progress=\s*end\b/m.test(text.slice(cutoff));
  let outTimeSec: number | null = null;
  // `out_time_us` is the microsecond field on every supported build; older
  // builds label the same microseconds `out_time_ms` (ffmpeg's long-standing
  // misnomer), so either carries the same value.
  const re = /^out_time_(?:us|ms)=(-?\d+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(completed)) !== null) {
    const us = Number(m[1]);
    if (Number.isFinite(us) && us >= 0) outTimeSec = us / 1e6;
  }
  if (outTimeSec == null) {
    const t = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)\s*$/m.exec(completed);
    if (t) outTimeSec = Number(t[1]) * 3600 + Number(t[2]) * 60 + Number(t[3]);
  }
  // Keep only the incomplete tail (a block still being written).
  const tailStart = cutoff;
  return { outTimeSec, end, rest: text.slice(tailStart) };
}

// Stage-A audio tap (INC-2 / ADAAAA-4325). The server decodes the stream's
// audio track to mono pcm_s16le and POSTs short chunks to perceive /audio so
// the noise-change gate can fire a *candidate* inside the live 1-5 s budget,
// independent of the 1 fps video /analyze. The gate normalizes RMS energy, so
// sample rate doesn't change the metric — 16 kHz keeps the tap cheap.
export const AUDIO_SAMPLE_RATE = 16_000;
export const AUDIO_CHUNK_S = 0.1; // 100 ms chunks -> 10 chunks/sec cadence

/** Split a raw int16-le mono PCM byte buffer into complete fixed-size chunks.
 * Pure + deterministic so it is directly unit-testable. Trailing bytes shorter
 * than one chunk are held back by the caller (buffered for the next read).
 * timestamp = baseTimestampSec + (chunkIndex + 1) * chunkSec (chunk end). */
export function chunkPcmBytes(
  bytes: Buffer,
  chunkBytes: number,
  chunkSec: number,
  baseSeq: number,
  baseTimestampSec: number
): { seq: number; timestamp: number; samples: string }[] {
  const out: { seq: number; timestamp: number; samples: string }[] = [];
  let offset = 0;
  while (offset + chunkBytes <= bytes.length) {
    const idx = out.length;
    const chunk = bytes.subarray(offset, offset + chunkBytes);
    out.push({
      seq: baseSeq + idx,
      timestamp: baseTimestampSec + (idx + 1) * chunkSec,
      samples: chunk.toString("base64"),
    });
    offset += chunkBytes;
  }
  return out;
}

export class LiveIngest {
  running = false;
  stderrTail = "";
  private proc: ChildProcessWithoutNullStreams | null = null;
  /** Second ffmpeg decoding `0:a:0` -> mono pcm_s16le raw to stdout (INC-2). */
  private audioProc: ChildProcessWithoutNullStreams | null = null;
  private frameDir: string;
  private sessionTs: string;
  private sampleSec: number;

  private kind: LiveKind;
  private inputUrl: string | undefined;
  /** ADAAAA-8495: the recorder's own flushed-duration watermark (seconds of
   *  muxed output), parsed from its `-progress` stream. Null until the first
   *  complete progress block lands. */
  private recorderFlushedSec: number | null = null;
  /** Unparsed tail of the `-progress` stream (a block still being written). */
  private progressBuf = "";
  /** Injectable for tests: the demux confirm of the recording FILE. */
  private probeFlushed = probeFlushedDuration;

  constructor(
    private cfg: ServerConfig,
    private jobId: string,
    spec: LiveSpec
  ) {
    this.kind = spec.kind;
    this.inputUrl = spec.url;
    this.sampleSec = spec.sampleInterval;
    const liveRoot = path.join(cfg.dataDir, "live", jobId);
    this.frameDir = path.join(liveRoot, "frames");
    this.sessionTs = path.join(liveRoot, "session.ts");
  }

  get sessionPath() {
    return this.sessionTs;
  }

  async start(): Promise<void> {
    await rm(path.dirname(this.sessionTs), { recursive: true, force: true });
    await mkdir(this.frameDir, { recursive: true });
    this.running = true;

    const input = this.inputArgs();
    const sampleFps = (1 / Math.max(0.1, this.sampleSec)).toFixed(3);
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      // ADAAAA-8495: the recorder reports its own muxed clock every ~0.5 s
      // (`out_time_us`), which is the flush watermark the live clip cut waits on
      // instead of demuxing the growing file per poll.
      "-progress", "pipe:1",
      ...input,
      // sampled frames -> jpg rail
      // ADAAAA-8377: the scale is a KNOB (`LIVE_FRAME_SCALE`, default 320:180),
      // not the literal this filter hardcoded. These JPEGs feed BOTH perceive
      // `/analyze` and the decide window, so the knob alone moves live to VOD
      // parity (640:360) without touching span, cadence or the image budget.
      "-map", "0:v:0",
      "-vf", `fps=${sampleFps},scale=${this.cfg.liveFrameScale}`,
      "-q:v", "3",
      path.join(this.frameDir, "frame_%06d.jpg"),
      // full session recording -> seekable MPEG-TS for clip cutting.
      // -flush_packets 1: low-bitrate live streams otherwise buffer in ffmpeg's
      // muxer and never touch disk before a SIGKILL, leaving a 0-byte file.
      "-flush_packets", "1",
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-c:a", "aac",
      "-f", "mpegts",
      this.sessionTs,
    ];

    this.proc = spawn(this.cfg.ffmpegPath, args);
    this.proc.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    // ADAAAA-8495: the muxer's own progress stream is the flush watermark (see
    // `parseRecorderProgress`). Cheap by construction: a string scan per chunk.
    this.proc.stdout.on("data", (d: Buffer) => this.noteRecorderProgress(d.toString()));
    this.proc.on("exit", (code, sig) => {
      if (this.running) console.error(`[live:${this.jobId}] ffmpeg exited code=${code} sig=${sig}`);
      this.running = false;
    });

    // Stage-A audio tap (INC-2): a SECOND ffmpeg decodes `0:a:0` (absent on
    // silent streams -> no-op) to mono pcm_s16le raw on stdout, which
    // audioChunks() batches into ~100 ms pieces for perceive /audio. Pure DSP
    // on the gate — no GPU billed. Never fatal: if the tap fails to start or
    // exits, the video /analyze pipeline just runs without audio candidates.
    const audioArgs = [
      "-hide_banner",
      "-loglevel", "error",
      ...input,
      "-map", "0:a:0?",
      "-ac", "1",
      "-ar", String(AUDIO_SAMPLE_RATE),
      "-c:a", "pcm_s16le",
      "-f", "s16le",
      "-",
    ];
    this.audioProc = spawn(this.cfg.ffmpegPath, audioArgs);
    this.audioProc.stderr.on("data", (d: Buffer) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
    });
    this.audioProc.on("exit", (code, sig) => {
      if (this.running && code && code !== 0)
        console.error(`[live:${this.jobId}] audio-tap ffmpeg exited code=${code} sig=${sig}`);
      this.audioProc = null;
    });

    // Give ffmpeg a beat to open the input before we start sampling.
    await sleep(800);
  }

  private inputArgs(): string[] {
    switch (this.kind) {
      case "screen":
        // Windows desktop grab. The server must run on a host with a display
        // (gdigrab has no input in headless/container hosts).
        return ["-f", "gdigrab", "-framerate", "10", "-offset_x", "0", "-offset_y", "0", "-i", "desktop"];
      case "rtmp":
        // Pull a stream that an encoder (OBS etc.) is pushing.
        return ["-rtbufsize", "64M", "-i", this.inputUrl || ""];
      case "file-sim":
        // Loop a local file at real-time rate as a synthetic live source.
        return ["-re", "-stream_loop", "-1", "-i", this.inputUrl || ""];
    }
  }

  /** ADAAAA-8495: fold a chunk of the recorder's `-progress` stream into the
   *  flush watermark. Only a COMPLETE block (closed by a `progress=` line) moves
   *  the watermark, so a half-written `out_time_us=` is never read as newer. */
  private noteRecorderProgress(chunk: string): void {
    this.progressBuf += chunk;
    const { outTimeSec, rest } = parseRecorderProgress(this.progressBuf);
    if (outTimeSec != null && (this.recorderFlushedSec == null || outTimeSec > this.recorderFlushedSec)) {
      this.recorderFlushedSec = outTimeSec;
    }
    // Keep only the incomplete tail of the current block (bounded so a garbage
    // stream cannot grow without limit).
    this.progressBuf = rest.length > 8192 ? rest.slice(-8192) : rest;
  }

  /** The newest flushed duration the RECORDER itself reported (seconds), or null
   *  before its first complete `-progress` block. */
  flushedSec(): number | null {
    return this.recorderFlushedSec;
  }

  async stop(): Promise<void> {
    this.running = false;
    const p = this.proc;
    if (!p) return;
    const exited = new Promise<void>((res) => {
      p.once("exit", () => res());
      p.once("error", () => res());
    });
    this.proc = null;
    p.kill("SIGKILL");
    // Wait for the process to actually exit so its file handles are released
    // (otherwise the next run can hit EBUSY unlinking the session file).
    await Promise.race([exited, sleep(2000)]);
    // Kill the audio tap too (if still running) so it doesn't leak a decoder.
    const ap = this.audioProc;
    this.audioProc = null;
    if (ap) {
      const aExited = new Promise<void>((res) => {
        ap.once("exit", () => res());
        ap.once("error", () => res());
      });
      ap.kill("SIGKILL");
      await Promise.race([aExited, sleep(500)]);
    }
  }

  /** Subscribe to frames as ffmpeg writes them; ends when stop() is called. */
  async *frames(): AsyncGenerator<{ seq: number; timestamp: number; imageB64: string }> {
    const seen = new Set<string>();
    let seq = 0;
    for (;;) {
      if (!this.running) break;
      let files: string[] = [];
      try {
        files = (await readdir(this.frameDir)).filter((f) => f.startsWith("frame_")).sort();
      } catch {
        /* dir not ready yet */
      }
      for (const f of files) {
        // ADAAAA-6556: if stop() was called while we were draining this batch
        // of already-captured frames, exit promptly so the analyzeJob() finally
        // can release the perceive session. Without this check a long-running
        // live job (N frames at 1fps → N × ~10 s GPU analyze calls) delays
        // slot release by minutes and the capacity-1 slot stays reserved with
        // its payment refiller still running (HTTP 480/482 spam).
        if (!this.running) break;
        if (seen.has(f)) continue;
        seen.add(f);
        const b64 = (await readFile(path.join(this.frameDir, f))).toString("base64");
        yield { seq, timestamp: seq * this.sampleSec, imageB64: b64 };
        seq++;
      }
      await sleep(250);
    }
  }

  /**
   * Yield ~100 ms mono int16 PCM chunks from the audio tap, each to POST to
   * perceive /audio (INC-2). Runs INDEPENDENTLY of frames(): the gate needs a
   * ~10 Hz cadence to fire inside the live 1-5 s budget while video samples at
   * ~1 fps. Ends when the tap process exits or stop() is called. Trailing
   * partial bytes are buffered and prepended to the next read.
   */
  async *audioChunks(): AsyncGenerator<{ seq: number; timestamp: number; samples: string }> {
    const p = this.audioProc;
    if (!p) return;
    const chunkBytes = Math.round(AUDIO_SAMPLE_RATE * AUDIO_CHUNK_S) * 2;
    let buf = Buffer.alloc(0);
    let seq = 0;
    let baseTs = 0;
    for await (const data of p.stdout as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, data]);
      const done = chunkPcmBytes(buf, chunkBytes, AUDIO_CHUNK_S, seq, baseTs);
      if (done.length) {
        seq = done[done.length - 1].seq + 1;
        baseTs = done[done.length - 1].timestamp;
        buf = buf.subarray(done.length * chunkBytes);
        for (const c of done) yield c;
      }
    }
  }

  /** Cut a highlight clip from the session recording.
   *
   * ADAAAA-7232: the window is centered on `ts` and guaranteed >=
   * `clipWindowMinSec` (floor 15 s).
   *
   * ADAAAA-8168: the delivered file is centered on the GOAL INSTANT IN THE
   * FOOTAGE — score flip, then the accepted evidence picture, then the content
   * clock (fail-closed), the same chain the browser rail uses (ADAAAA-8152) —
   * and it is only published once the recording has flushed the whole window.
   * Before this, the cut ran straight off the content clock on a recording that
   * was still growing, so play sat wherever the clock said and a window cut
   * near the live edge shipped a sub-floor file. Image probes are CPU-only: no
   * decide/perceive call and no extra clip debit either way. */
  async cut(
    ts: number,
    opts: {
      maxFlushWaitMs?: number;
      requireFullWindow?: boolean;
      window?: ClipCutWindow;
      anchorTs?: number;
      /** ADAAAA-8877: file-name suffix, so a RE-cut on a dive moment writes a
       *  sibling file instead of overwriting the delivered one (`cut` removes
       *  its own output on a truncated-window refusal). Absent = the historical
       *  `${jobId}-${round(ts*10)}` name, byte-identical for every caller. */
      outSuffix?: string;
    } = {}
  ): Promise<ClipCut> {
    const { mkdir } = await import("node:fs/promises");
    const outDir = path.join(this.cfg.dataDir, "clips");
    await mkdir(outDir, { recursive: true });
    const name = `${this.jobId}-${Math.round(ts * 10)}${opts.outSuffix ?? ""}`;
    const out = path.join(outDir, `${name}.mp4`);
    // ADAAAA-8714: the analyzer hands the PLACED window. A celebration-tail row
    // cuts `[cue - (window - tail), cue + tail]` — the whole judged window plus
    // the reaction — instead of re-centring on the cue here. Absent (measured
    // rows, VOD, any legacy caller) => the nominal centred window, unchanged.
    const win =
      opts.window ?? clipWindow(ts, this.cfg.clipBeforeS, this.cfg.clipAfterS, this.cfg.clipWindowMinSec ?? 15);
    // The length the ROW promises (the ACC grades >= clipWindowMinSec of it) vs
    // the length actually asked of ffmpeg (padded for seek/keyframe quantisation).
    const needDur = win.end - win.start;
    const cutDur = Math.max(needDur + LIVE_CLIP_DUR_PAD_S, this.cfg.clipWindowMinSec ?? 15);
    // At DECISION time the recorder is still writing, so a full window is
    // required (the stop-time case — nothing more will land — may publish the
    // short share honestly, exactly like the browser rail's requireFullWindow).
    const requireFull = opts.requireFullWindow ?? this.running;
    const deadline = Date.now() + (opts.maxFlushWaitMs ?? LIVE_CLIP_MAX_WAIT_MS);
    let coverage = await this.waitForFlushedCoverage(win.end, deadline);
    if (coverage.state === "timeout" && requireFull) {
      throw new Error(
        `clip window [${win.start.toFixed(3)}, ${win.end.toFixed(3)}] not flushed within ` +
          `${Math.round((opts.maxFlushWaitMs ?? LIVE_CLIP_MAX_WAIT_MS) / 1000)}s ` +
          `(recording holds ${coverage.fileDur == null ? "?" : coverage.fileDur.toFixed(3)}s) — ` +
          `a truncated live clip is not published`
      );
    }
    const evidenceFramePath = this.evidenceFramePath(opts.anchorTs ?? ts);
    // ADAAAA-8820 (D2): the deferred ingest cut anchors on the instant the Stage-2
    // dive named when the row carries one (`anchorTs`), falling back to the accept
    // anchor. The window itself is unchanged — the moment only moves which frame
    // inside it is centered, exactly like the browser rail.
    const anchorTs = Number.isFinite(opts.anchorTs as number) ? Number(opts.anchorTs) : ts;
    const cutNow = () =>
      anchorCutOnEvidence({
        ffmpegPath: this.cfg.ffmpegPath,
        source: this.sessionTs,
        outPath: out,
        contentStart: win.start,
        dur: cutDur,
        // The ROW promises `needDur`; a cut that lands shorter than that is
        // re-cut exactly instead of shipping a short card (ADAAAA-8170).
        minDur: needDur,
        evidenceTs: anchorTs,
        evidenceFramePath,
        tag: `live-ingest:${this.jobId}`,
        // ADAAAA-8714: on a celebration-tail row the cue IS the anchor — a score
        // flip found earlier would re-centre the card on the goal and push the
        // reaction off the end.
        cueTail: opts.window?.cueTail === true,
      });
    let result = await cutNow();
    let deliveredSec = await probeDuration(this.cfg.ffmpegPath, out).catch(() => null);
    // The content clock and the recording's own clock are independent, and the
    // anchor can move the window backwards into footage that is already there
    // or forwards past it. If the delivered file came up short while the
    // recorder is still writing, wait for the tail and re-cut once or twice
    // (bounded by the same deadline) instead of publishing the truncation.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (deliveredSec == null || deliveredSec >= needDur - 0.05) break;
      if (!this.running || Date.now() >= deadline) break;
      const more = await this.waitForFlushedCoverage(result.placement.cutStart + result.placement.dur, deadline);
      if (more.state !== "flushed") {
        coverage = more;
        break;
      }
      coverage = more;
      result = await cutNow();
      deliveredSec = await probeDuration(this.cfg.ffmpegPath, out).catch(() => null);
    }
    // AC2 guard: a LIVE cut must deliver the WHOLE window or not publish. The
    // old rail shipped 13.392 s / 13.817 s files for 15 s windows because the
    // window was cut before the recording held it; here that is a refusal, and
    // the analyzer keeps the row with `clipError` instead of losing the goal.
    // A FINISHED recording is the stop-time case: nothing more will ever land,
    // so the short share is honest — publish it (>= 0.5 s) and let the measured
    // `clipDeliveredSec` say what it is, exactly like the browser rail's
    // `requireFullWindow: false`. The tail of a stream-COPY cut is a few hundred
    // ms short of the span it was asked for (mp4 cannot resume a GOP it does not
    // have), which is why that case is not graded against the full window.
    const available = coverage.fileDur != null ? Math.max(0, coverage.fileDur - result.placement.cutStart) : null;
    const floor = requireFull ? needDur - 0.05 : 0.5;
    if (deliveredSec != null && deliveredSec < floor) {
      await rm(out, { force: true }).catch(() => {});
      throw new Error(
        `clip covers ${deliveredSec.toFixed(3)}s of the ${needDur.toFixed(3)}s window` +
          (available != null && available < needDur - 0.1
            ? ` (recording holds ${available.toFixed(3)}s from the cut start)`
            : "") +
          (requireFull ? " — a truncated live clip is not published" : "")
      );
    }
    if (!requireFull && deliveredSec != null && deliveredSec < needDur - 0.05) {
      console.log(
        `[live-clip:${this.jobId}] ${name}.mp4 short share: ${deliveredSec.toFixed(3)}s of the ` +
          `${needDur.toFixed(3)}s window (recording ended at ${coverage.fileDur == null ? "?" : coverage.fileDur.toFixed(3)}s)`
      );
    }
    const placement = result.placement;
    console.log(
      `[live-clip:${this.jobId}] ${name}.mp4 ${placement.method} cut ` +
        `[${placement.cutStart.toFixed(3)}, ${(placement.cutStart + placement.dur).toFixed(3)}] ` +
        `${deliveredSec == null ? "?" : deliveredSec.toFixed(3)}s delivered, goal at ` +
        `${placement.deliveredOffsetSec == null ? "?" : placement.deliveredOffsetSec.toFixed(3)}s ` +
        `(${result.cut.mode}, ${result.cut.bytes} B)`
    );
    return { clipId: name, clipUri: `/clips/${name}.mp4`, clipAudit: clipAuditFields(placement, deliveredSec) };
  }

  /** ADAAAA-8168: wait until the recording FILE holds `needFileSec` of flushed
   * footage — the browser rail's `waitForRecordingFlush` on this rail.
   *
   * ADAAAA-8495: the recorder's own `-progress` clock (`recorderFlushedSec`) is
   * the watermark, so the wait no longer spawns one `ffprobe` demux of the
   * growing MPEG-TS every 250 ms (25,425 ms of the 51,737 ms accept stage on the
   * 7 separable rows of leg 2c4124fe). The older demux probe is kept as a
   * ONE-per-second cross-check the first time the watermark claims coverage, and
   * as the fallback when the recorder reports no progress at all: a stalled
   * progress clock must never publish a short file. `LIVE_CLIP_MAX_WAIT_MS` and
   * the timeout refusal are unchanged. `ended` means the recorder is gone and
   * nothing more will ever land; `timeout` means the budget ran out with the
   * recorder still writing. */
  private async waitForFlushedCoverage(
    needFileSec: number,
    deadline: number
  ): Promise<{ state: "flushed" | "ended" | "timeout"; fileDur: number | null }> {
    let lastProbeAt = 0;
    for (;;) {
      const watermark = this.recorderFlushedSec;
      // ADAAAA-8495: the watermark is trusted once the FILE agrees — a single
      // demux confirm per second at most, never per poll.
      if (watermark != null && watermark + 0.05 >= needFileSec) {
        if (Date.now() - lastProbeAt < LIVE_CLIP_CONFIRM_MS) {
          // Already confirmed coverage and the file is still absorbing the tail;
          // keep waiting for the next watermark rather than re-demuxing.
          if (Date.now() >= deadline) return { state: "timeout", fileDur: watermark };
          await sleep(LIVE_CLIP_POLL_MS);
          continue;
        }
        lastProbeAt = Date.now();
        const fileDur = await this.probeFlushed(this.cfg.ffmpegPath, this.sessionTs).catch(() => null);
        // An unmeasurable file keeps the historical behaviour: proceed and let
        // the post-cut guard decide.
        if (fileDur == null || fileDur + 0.05 >= needFileSec) return { state: "flushed", fileDur: fileDur ?? watermark };
        if (!this.running) return { state: "ended", fileDur };
        if (Date.now() >= deadline) return { state: "timeout", fileDur };
        continue;
      }
      // No watermark yet (the first progress block can take ~0.5 s, and a
      // recorder that will not report one at all is measured on the file, at
      // most once per second).
      if (watermark == null && Date.now() - lastProbeAt >= LIVE_CLIP_CONFIRM_MS) {
        lastProbeAt = Date.now();
        const fileDur = await this.probeFlushed(this.cfg.ffmpegPath, this.sessionTs).catch(() => null);
        if (fileDur == null) return { state: "flushed", fileDur };
        if (fileDur + 0.05 >= needFileSec) return { state: "flushed", fileDur };
      }
      if (!this.running) return { state: "ended", fileDur: watermark };
      if (Date.now() >= deadline) return { state: "timeout", fileDur: watermark };
      await sleep(LIVE_CLIP_POLL_MS);
    }
  }

  /** The analyzer's evidence JPEG for the content instant `ts`. The rail samples
   * every `sampleSec` and `frames()` timestamps each sample as `seq *
   * sampleSec`, while the ffmpeg segmenter numbers files from 1 — so the frame
   * that carries `ts` is `round(ts / sampleSec) + 1`. Neighbours are tried
   * because the newest sample may still be mid-write when the accept lands. */
  evidenceFramePath(ts: number): string | null {
    const base = Math.round(ts / Math.max(0.05, this.sampleSec));
    for (const seq of [base + 1, base, base + 2]) {
      if (seq < 1) continue;
      const p = path.join(this.frameDir, `frame_${String(seq).padStart(6, "0")}.jpg`);
      if (existsSync(p)) return p;
    }
    return null;
  }
}

