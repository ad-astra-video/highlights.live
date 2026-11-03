// Match-context resolver orchestration for VOD jobs (ADAAAA-7855).
//
// The parent plan (ADAAAA-7849 §3) splits the work: the once-per-job resolver
// decides WHO is playing and which colour each team wears, persists it on the
// job (`matchContext`), and every later LLM call reads it instead of inventing a
// team ("German defender" on a Portugal vs Spain job).
//
// This module owns the SERVER half of the evidence pack:
//
// - Stage 0 metadata hints: the stored title / gameHint / source filename.
// - Stage 2 commentary probe: ONE bounded CPU transcribe per job (default first
//   90 s of the audio track, env-tunable, hard byte cap). The audio decode reuses
//   the VOD tap's ffmpeg form; the transcript goes through the same `/transcribe`
//   contract the decide path already uses. Never billed to the Livepeer GPU.
//
// Perceive owns the GPU-free half it already computes (ROI-gated scorebug OCR
// lines per anchor frame, torso kit samples, scoreboard kit swatches) and folds
// both halves through `POST /app/match-context` — the pure resolver lives in
// `services/perceive/app/match_context.py`, so the fold + monotonic guard are
// unit-tested in Python and this file only carries I/O.
//
// Budget discipline: at most THREE resolve calls per job (job start, >=25%,
// >=50%), no per-window inference, no gemma call. The re-checks exist so
// confidence can rise as evidence accumulates while the monotonic guard keeps an
// attributed team's name frozen (AC4).
import { spawn } from "node:child_process";
import {
  MatchContextEvidenceSchema,
  type Job,
  type MatchContextEvidence,
} from "@highlights/events";

/** One team attribution as persisted on the job record (plan §3 Stage 5). */
export interface MatchContextTeam {
  name: string;
  side: "home" | "away" | "unknown";
  kitColors: { primary: string; secondary?: string }[];
  confidence: number;
  evidence: { source: string; snippet: string }[];
}

/** The persisted `matchContext` contract (additive optional on JobSchema). */
export interface MatchContext {
  sport: string;
  teams: MatchContextTeam[];
  inferredAt: string;
  resolverVersion: number;
  ambiguous: boolean;
  /** AC4 audit: one bounded entry per resolver pass (start + 25% + 50%). */
  trail: {
    at: string;
    progressPct: number;
    names: { side?: string; name?: string; confidence?: number }[];
    action: string[];
  }[];
}

/**
 * The resolver's `evidenceStatus`, as persisted on the job record
 * (`matchContextEvidence`, ADAAAA-7868). The shape is OWNED by the contract
 * package — `MatchContextEvidenceSchema` in `packages/events` — so the server
 * and the stored record cannot drift apart; this alias keeps the historical
 * server-side name.
 */
export type MatchContextEvidenceStatus = MatchContextEvidence;

export interface MatchContextResolveResult {
  matchContext: MatchContext;
  evidenceStatus?: MatchContextEvidenceStatus;
}

/** Progress points at which the resolver re-reads the evidence (bounded). */
export const MATCH_CONTEXT_RECHECKS: readonly number[] = [0, 25, 50];
/** Default commentary probe length (plan §3 Stage 2: "first 90 s"). */
export const DEFAULT_MATCH_CONTEXT_ASR_SECONDS = 90;
/** Hard cap on the wav bytes we are willing to base64 + POST (≈ 8 MB ≈ 4 min). */
export const DEFAULT_MATCH_CONTEXT_ASR_MAX_BYTES = 8 * 1024 * 1024;
/** Concurrent resolves allowed in flight (the checkpoints are 3, but a long
 * job can fire them close together when frames land fast). */
const MAX_INFLIGHT_RESOLVES = 1;

export interface MatchContextResolverCfg {
  ffmpegPath: string;
  /** ASR service base url (POST {asrUrl}/transcribe). Unset => no ASR source. */
  asrUrl?: string;
  /** Commentary probe length in seconds (MATCH_CONTEXT_ASR_SECONDS). */
  asrSeconds: number;
  /** Hard byte cap on the decoded prefix (MATCH_CONTEXT_ASR_MAX_BYTES). */
  asrMaxBytes: number;
}

export interface MatchContextClient {
  /** Perceive fold call; optional so a FAKE/older client simply never resolves.
   * The shape is the loose JSON contract (the PipelineClient implementation
   * returns `Record<string, unknown>`); `JobSchema.parse` validates it on write. */
  postMatchContext?: (
    sessionId: string,
    payload: Record<string, unknown>
  ) => Promise<{ matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null>;
}

export interface MatchContextResolverDeps {
  jobId: string;
  videoPath: string;
  cfg: MatchContextResolverCfg;
  client: MatchContextClient;
  /** Perceive session id the evidence lives on (the pass's live session). */
  sessionId: string;
  hints: { title?: string; gameHint?: string; filename?: string };
  /** Job store write-through (patchJob parses through JobSchema). */
  getJob: (id: string) => Job | undefined;
  patchJob: (id: string, patch: Partial<Omit<Job, "id">>) => Promise<Job>;
  log?: (msg: string) => void;
  /** Test/QA seam: replace the ffmpeg+ASR probe (default = the real bounded
   * probe). One probe per resolver instance, shared by every checkpoint. */
  probeCommentary?: () => Promise<TranscriptProbe>;
}

export interface MatchContextResolver {
  /** Start the one bounded transcription probe (no await — runs with extraction). */
  begin(): void;
  /** Call from the frame loop; fires the bounded re-checks on threshold cross. */
  onProgress(pct: number): void;
  /** Await every fired resolve (never starts one on a possibly-closed session). */
  finish(): Promise<void>;
}

interface TranscriptProbe {
  text: string;
  seconds: number;
  bytes: number;
  error?: string;
}

/**
 * Decode a bounded prefix of the source's audio track to a 16 kHz mono WAV.
 *
 * Mirrors `vod-audio.ts` (`-map 0:a:0?`, mono, s16le) but stops at
 * `seconds`/`maxBytes`, because the commentary probe is deliberately flat per
 * job instead of proportional to runtime. Best-effort: a missing audio track or
 * a decode failure yields `b64: ""` and never throws.
 */
export function extractCommentaryWav(
  ffmpegPath: string,
  source: string,
  seconds: number,
  maxBytes: number
): Promise<{ b64: string; bytes: number; truncated: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      const buf = Buffer.concat(chunks);
      resolve({ b64: buf.length ? buf.toString("base64") : "", bytes: buf.length, truncated });
    };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source,
        "-map",
        "0:a:0?",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-t",
        String(Math.max(1, Math.floor(seconds))),
        "-f",
        "wav",
        "-",
      ]);
    } catch {
      resolve({ b64: "", bytes: 0, truncated: false });
      return;
    }
    proc.stdout?.on("data", (data: Buffer) => {
      if (bytes >= maxBytes) {
        truncated = true;
        proc.kill("SIGKILL");
        return;
      }
      const room = maxBytes - bytes;
      const slice = data.length > room ? data.subarray(0, room) : data;
      chunks.push(slice);
      bytes += slice.length;
      if (data.length > room) {
        truncated = true;
        proc.kill("SIGKILL");
      }
    });
    proc.stderr?.on("data", () => {
      /* swallowed — the probe is best-effort, errors never abort the job */
    });
    proc.on("error", () => done());
    proc.on("close", () => done());
  });
}

/**
 * One bounded CPU transcription (`POST {asrUrl}/transcribe`).
 *
 * Same contract as `services/decide/app/gemma.py::transcribe_audio`: the ASR
 * service answers 200 with `{text}` for any payload problem (never 5xx), so a
 * silent or undecodable prefix simply yields no commentary evidence. Returns
 * `{text: ""}` on any transport failure — the resolver then reports the ASR
 * source as `not_captured` instead of failing the job.
 */
export async function transcribeCommentary(
  asrUrl: string | undefined,
  wavB64: string,
  timeoutMs = 120_000
): Promise<{ text: string; error?: string }> {
  if (!asrUrl || !wavB64) return { text: "", error: asrUrl ? "no audio prefix" : "ASR_URL unset" };
  const url = `${asrUrl.replace(/\/$/, "")}/transcribe`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audio: wavB64, sample_rate: 16000, task: "transcribe" }),
      signal: ctl.signal,
    });
    if (!res.ok) return { text: "", error: `HTTP ${res.status}` };
    const body = (await res.json().catch(() => null)) as { text?: string } | null;
    return { text: String(body?.text || "").trim() };
  } catch (e: any) {
    return { text: "", error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/** True when the resolver is enabled for this deployment (MATCH_CONTEXT). */
export function matchContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env.MATCH_CONTEXT ?? "1").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

/**
 * Validate + copy a resolver `evidenceStatus` for persistence (ADAAAA-7868).
 *
 * Returns `{ value: undefined }` — and the caller writes no field — when the
 * pass produced no status at all (E2) or when the status fails validation.
 * A validation failure is reported through `error` so the resolver can log WHY
 * the markers were dropped while still persisting `matchContext` (E3); it is
 * never thrown, because the primary contract must survive a marker problem.
 *
 * Pure and IO-free: the same schema (`MatchContextEvidenceSchema` in
 * `packages/events`) validates the write here and on `JobSchema.parse`, so the
 * pre-check can never disagree with the store.
 */
export function toMatchContextEvidence(
  status: Record<string, unknown> | undefined | null
): { value?: MatchContextEvidence; error?: string } {
  if (!status || typeof status !== "object") return {};
  if (Object.keys(status).length === 0) return {};
  const parsed = MatchContextEvidenceSchema.safeParse(status);
  if (!parsed.success) {
    return { error: parsed.error.issues.map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  }
  return { value: parsed.data as MatchContextEvidence };
}

/**
 * Build the once-per-job VOD match-context resolver.
 *
 * Wiring (in `runVodJob`): `begin()` right after the perceive session is
 * reserved (the transcript probe costs CPU while frame extraction runs),
 * `onProgress(pct)` from the frame loop, `finish()` before the finalizing
 * transition. Every write is best-effort: a resolve failure leaves the job
 * without `matchContext` (which the sibling prompt-injection issue treats as
 * "no block", i.e. the current behaviour) and never fails the job.
 */
export function createVodMatchContextResolver(deps: MatchContextResolverDeps): MatchContextResolver {
  const log = deps.log ?? ((msg: string) => console.log(msg));
  let transcript: Promise<TranscriptProbe> | null = null;
  const fired = new Set<number>();
  const pending: Promise<void>[] = [];
  let inflight = 0;
  const queue: number[] = [];

  const probe = (): Promise<TranscriptProbe> => {
    if (transcript) return transcript;
    transcript = (async (): Promise<TranscriptProbe> => {
      if (deps.probeCommentary) return deps.probeCommentary();
      if (!deps.cfg.asrUrl) {
        log(`[match-context:${deps.jobId}] ASR_URL unset — commentary source not_captured`);
        return { text: "", seconds: 0, bytes: 0, error: "ASR_URL unset" };
      }
      const wav = await extractCommentaryWav(
        deps.cfg.ffmpegPath,
        deps.videoPath,
        deps.cfg.asrSeconds,
        deps.cfg.asrMaxBytes
      );
      if (!wav.b64) {
        log(`[match-context:${deps.jobId}] no audio prefix (silent or no track) — commentary not_captured`);
        return { text: "", seconds: 0, bytes: 0, error: "no audio prefix" };
      }
      const asr = await transcribeCommentary(deps.cfg.asrUrl, wav.b64);
      const seconds = wav.bytes > 44 ? (wav.bytes - 44) / (16000 * 2) : 0;
      log(
        `[match-context:${deps.jobId}] ASR prefix ${seconds.toFixed(1)}s (${(wav.bytes / 1024).toFixed(0)} KB` +
          `${wav.truncated ? ", truncated at cap" : ""}) -> ${asr.text.length} chars${asr.error ? ` (${asr.error})` : ""}`
      );
      return { text: asr.text, seconds, bytes: wav.bytes, error: asr.error };
    })();
    return transcript;
  };

  const resolveOnce = async (progressPct: number): Promise<void> => {
    if (!deps.client.postMatchContext) return;
    const job = deps.getJob(deps.jobId);
    const previous = job?.matchContext as MatchContext | undefined;
    const asr = await probe();
    let result: { matchContext: Record<string, unknown>; evidenceStatus?: Record<string, unknown> } | null = null;
    try {
      result = await deps.client.postMatchContext(deps.sessionId, {
        gameHint: deps.hints.gameHint || job?.gameHint || undefined,
        title: deps.hints.title || job?.title || undefined,
        filename: deps.hints.filename,
        transcript: asr.text || undefined,
        previous,
        progressPct,
      });
    } catch (e: any) {
      log(`[match-context:${deps.jobId}] resolve at ${progressPct}% failed: ${String(e?.message || e)}`);
      return;
    }
    const ctx = result?.matchContext as MatchContext | undefined;
    if (!ctx) return;
    // ADAAAA-7868 (AC-P8): persist the resolver's evidence status BESIDE the
    // context in the SAME patchJob, so a stored job explains its own kit
    // attribution (which clusters were seen, which sides stayed unattributed,
    // what the curated prior did) without a server-log read. It is a copy of
    // what the resolver already returned — nothing is recomputed here (E4), and
    // a pass that returned no status writes no field at all (E2).
    const evidence = toMatchContextEvidence(result?.evidenceStatus);
    if (evidence.error) {
      log(
        `[match-context:${deps.jobId}] evidence status rejected at ${progressPct}% (${evidence.error}) — ` +
          `persisting matchContext only`
      );
    }
    try {
      // JobSchema.parse in store.patchJob is the validator: a malformed context
      // is rejected there and the job keeps no matchContext (never a bad record).
      await deps.patchJob(
        deps.jobId,
        evidence.value
          ? { matchContext: ctx, matchContextEvidence: evidence.value }
          : { matchContext: ctx }
      );
      const status = result?.evidenceStatus;
      log(
        `[match-context:${deps.jobId}] persisted at ${progressPct}%: ` +
          ctx.teams.map((t) => `${t.side}=${t.name}@${t.confidence.toFixed(2)}`).join(" ") +
          ` ambiguous=${ctx.ambiguous} sources=${((status?.sources as string[] | undefined) ?? []).join(",")}`
      );
    } catch (e: any) {
      // E3 failure isolation: the evidence field must never take the primary
      // matchContext contract down. Retry ONCE with the context alone — the
      // evidence is an explainability marker, not the record's purpose.
      if (!evidence.value) {
        log(`[match-context:${deps.jobId}] persist failed: ${String(e?.message || e)}`);
        return;
      }
      log(
        `[match-context:${deps.jobId}] combined persist rejected (${String(e?.message || e)}) — ` +
          `retrying with matchContext only`
      );
      try {
        await deps.patchJob(deps.jobId, { matchContext: ctx });
      } catch (e2: any) {
        log(`[match-context:${deps.jobId}] persist failed: ${String(e2?.message || e2)}`);
      }
    }
  };

  const start = (checkpoint: number) => {
    if (fired.has(checkpoint)) return;
    fired.add(checkpoint);
    queue.push(checkpoint);
    pump();
  };

  const pump = () => {
    while (inflight < MAX_INFLIGHT_RESOLVES && queue.length) {
      const checkpoint = queue.shift() as number;
      inflight++;
      const p = resolveOnce(checkpoint)
        .catch(() => {})
        .finally(() => {
          inflight--;
          pump();
        });
      pending.push(p);
    }
  };

  return {
    begin() {
      // Fire the transcription probe immediately: it runs on CPU in parallel
      // with frame extraction, which is what keeps the wall-clock delta inside
      // the +3% budget.
      void probe();
    },
    onProgress(pct: number) {
      for (const checkpoint of MATCH_CONTEXT_RECHECKS) {
        if (pct >= checkpoint) start(checkpoint);
      }
    },
    async finish() {
      // Never starts a new resolve here: the perceive session may already be
      // closed by analyzeJob's finally, and a late call would answer with no
      // session evidence. The 50% checkpoint always fires inside the loop.
      // Drain the serialized queue as well: a checkpoint queued behind an
      // in-flight resolve is still launched by pump(), so awaiting only the
      // snapshot of `pending` would leave the final checkpoint unresolved.
      while (queue.length > 0 || inflight > 0) {
        await Promise.all(pending.slice());
      }
    },
  };
}
