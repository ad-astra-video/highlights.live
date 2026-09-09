// Live ingest: capture screen (gdigrab), pull an RTMP stream, or loop a local
// file as a synthetic live source — record the session to disk (seekable MPEG-TS)
// while sampling JPEG frames into the analyzer rail. Clips are cut from the
// session recording instead of a pre-existing file, so the existing analyzeJob
// pipeline runs unchanged over a live stream.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readdir, readFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { cutClip } from "./ffmpeg";
import type { ServerConfig } from "./config";

export type LiveKind = "screen" | "rtmp" | "file-sim";

export interface LiveSpec {
  kind: LiveKind;
  /** For rtmp: the rtmp:// URL to pull. For file-sim: a local video path. Screen: unused. */
  url?: string;
  /** Seconds to wait between emitted frames (1 / sampleFps). */
  sampleInterval: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class LiveIngest {
  running = false;
  stderrTail = "";
  private proc: ChildProcessWithoutNullStreams | null = null;
  private frameDir: string;
  private sessionTs: string;
  private sampleSec: number;

  private kind: LiveKind;
  private inputUrl: string | undefined;

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
      ...input,
      // sampled frames -> jpg rail
      "-map", "0:v:0",
      "-vf", `fps=${sampleFps},scale=320:180`,
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
    this.proc.on("exit", (code, sig) => {
      if (this.running) console.error(`[live:${this.jobId}] ffmpeg exited code=${code} sig=${sig}`);
      this.running = false;
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
        if (seen.has(f)) continue;
        seen.add(f);
        const b64 = (await readFile(path.join(this.frameDir, f))).toString("base64");
        yield { seq, timestamp: seq * this.sampleSec, imageB64: b64 };
        seq++;
      }
      await sleep(250);
    }
  }

  /** Cut a highlight clip from the session recording. */
  async cut(ts: number): Promise<{ clipId: string; clipUri: string }> {
    const { mkdir } = await import("node:fs/promises");
    const outDir = path.join(this.cfg.dataDir, "clips");
    await mkdir(outDir, { recursive: true });
    const name = `${this.jobId}-${Math.round(ts * 10)}`;
    const out = path.join(outDir, `${name}.mp4`);
    await cutClip(
      this.cfg.ffmpegPath,
      this.sessionTs,
      out,
      Math.max(0, ts - this.cfg.clipBeforeS),
      this.cfg.clipBeforeS + this.cfg.clipAfterS
    );
    return { clipId: name, clipUri: `/clips/${name}.mp4` };
  }
}
