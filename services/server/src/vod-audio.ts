// Stage-A VOD audio tap (ADAAAA-4954). The live path decodes the incoming
// stream's audio inside LiveIngest; a VOD `file` job has no LiveIngest, so this
// drives the SAME ffmpeg decode (`0:a:0` -> mono pcm_s16le 16 kHz raw on
// stdout) from a static file and yields ~100 ms chunks via the shared
// `chunkPcmBytes` helper. The chunks are POSTed to perceive `/audio` — the
// Stage-A noise-change gate (pure DSP, no GPU billed) — exactly like the live
// tap. Best-effort: missing/silent audio tracks yield nothing, never fatal.
import { spawn } from "node:child_process";
import { AUDIO_SAMPLE_RATE, AUDIO_CHUNK_S, chunkPcmBytes } from "./live";

export interface VodAudioChunk {
  seq: number;
  timestamp: number;
  samples: string;
}

/** Decode a static VOD file's audio track (0:a:0) to mono pcm_s16le 16 kHz and
 * yield ~100 ms base64 chunks for perceive /audio. Ends when the file's audio
 * runs out (or the process exits). Reuses the live tap's chunking + constants
 * so the wire contract is identical to the deployed live pass. */
export async function* extractVodAudioChunks(
  ffmpegPath: string,
  source: string
): AsyncGenerator<VodAudioChunk> {
  const proc = spawn(ffmpegPath, [
    "-hide_banner",
    "-loglevel", "error",
    "-i", source,
    "-map", "0:a:0?",
    "-ac", "1",
    "-ar", String(AUDIO_SAMPLE_RATE),
    "-c:a", "pcm_s16le",
    "-f", "s16le",
    "-",
  ]);
  proc.stderr.on("data", () => {
    /* swallow — audio tap is best-effort; errors never abort the video pass */
  });
  const chunkBytes = Math.round(AUDIO_SAMPLE_RATE * AUDIO_CHUNK_S) * 2;
  let buf = Buffer.alloc(0);
  let seq = 0;
  let baseTs = 0;
  try {
    for await (const data of proc.stdout as AsyncIterable<Buffer>) {
      buf = Buffer.concat([buf, data]);
      const done = chunkPcmBytes(buf, chunkBytes, AUDIO_CHUNK_S, seq, baseTs);
      if (done.length) {
        seq = done[done.length - 1].seq + 1;
        baseTs = done[done.length - 1].timestamp;
        buf = buf.subarray(done.length * chunkBytes);
        for (const c of done) yield c;
      }
    }
  } finally {
    // Reading to EOF is enough for a static file, but ensure the decoder is
    // reaped promptly (matches LiveIngest.stop()'s SIGKILL hygiene).
    proc.kill("SIGKILL");
  }
}
