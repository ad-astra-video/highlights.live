// ADAAAA-6742 G5 "Live watcher-first": a small typed HTTP client for the
// decide runner's watcher / depth-router / deep-investigation / clip-stash
// endpoints (services/decide/app/__init__.py). The server's LIVE job path
// drives these instead of the legacy per-frame candidate + server-side cut()
// loop when `liveWatcherFirst` is enabled.
//
// This is deliberately a dedicated, self-contained client (it is NOT folded
// into PipelineClient) so the legacy per-frame candidate loop is untouched
// byte-for-byte: the flag-off live path never constructs or calls it.
//
// Transport: plain `fetch` (Node 18+ global) against `<decideUrl>/app/*` —
// the same base the DirectAdapter uses for its decide calls (the decide app
// mounts the same router at root and under `/app`). No new runtime dep.

export interface WatcherStartReq {
  sessionId: string;
  streamId: string;
  /** When set (with TRACE_BASE on decide), the watcher POSTs each decide->
   * perceive tool call/result to the server's analysis-session trace route. */
  traceJobId?: string;
  config?: Record<string, unknown>;
}

export interface WatcherIngestReq {
  ts: number;
  seq: number;
  players?: unknown[];
  objects?: unknown[];
  caption?: string;
  audioPeak?: number;
  audioBaseline?: number;
}

export interface WatcherStepReq {
  tickTs: number;
}

export interface DeepInvestigateReq {
  flagTs: number;
}

export interface StashStartReq {
  sessionId: string;
  streamId: string;
  jobId: string;
  config?: Record<string, unknown>;
}

export interface StashIngestReq {
  ts: number;
  seq: number;
  /** base64 JPEG frame. */
  jpeg: string;
  /** base64 audio segment (optional). */
  audio?: string;
  audioMime?: string;
}

/** Accepts an arbitrary decide response; only the pieces the server needs are
 * read. Responses are opaque so decide can evolve without a server change. */
export type WatcherStepResponse = any;

/** The subset of the decide watcher/stash surface the live path drives. */
export interface DecideWatcherClient {
  watcherStart(req: WatcherStartReq): Promise<any>;
  watcherIngest(req: WatcherIngestReq): Promise<any>;
  watcherStep(req: WatcherStepReq): Promise<WatcherStepResponse>;
  watcherStep2(req: WatcherStepReq): Promise<WatcherStepResponse>;
  deepInvestigate(req: DeepInvestigateReq): Promise<any>;
  stashStart(req: StashStartReq): Promise<any>;
  stashIngest(req: StashIngestReq): Promise<any>;
}

interface HttpOpts {
  /** Injectable fetch (for tests); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

/** HTTP implementation POSTing JSON to `<base>/app/<endpoint>`. A non-2xx
 * throws (a watcher drive failure is NOT silently swallowed — it surfaces to
 * the live loop, but the caller may wrap best-effort). */
export class HttpDecideWatcherClient implements DecideWatcherClient {
  private fetchFn: typeof fetch;
  constructor(private base: string, opts?: HttpOpts) {
    this.fetchFn = opts?.fetchFn ?? globalThis.fetch.bind(globalThis);
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.fetchFn(`${this.base}/app${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`decide ${path} failed: HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  watcherStart(req: WatcherStartReq): Promise<any> {
    return this.post("/watcher/start", {
      sessionId: req.sessionId,
      streamId: req.streamId,
      traceJobId: req.traceJobId ?? "",
      config: req.config ?? {},
    });
  }
  watcherIngest(req: WatcherIngestReq): Promise<any> {
    return this.post("/watcher/ingest", {
      ts: req.ts,
      seq: req.seq,
      players: req.players ?? [],
      objects: req.objects ?? [],
      caption: req.caption ?? "",
      audioPeak: req.audioPeak ?? 0.0,
      audioBaseline: req.audioBaseline ?? 0.0,
    });
  }
  watcherStep(req: WatcherStepReq): Promise<WatcherStepResponse> {
    return this.post("/watcher/step", { tickTs: req.tickTs });
  }
  watcherStep2(req: WatcherStepReq): Promise<WatcherStepResponse> {
    return this.post("/watcher/step2", { tickTs: req.tickTs });
  }
  deepInvestigate(req: DeepInvestigateReq): Promise<any> {
    return this.post("/deep/investigate", { flagTs: req.flagTs });
  }
  stashStart(req: StashStartReq): Promise<any> {
    return this.post("/stash/start", {
      sessionId: req.sessionId,
      streamId: req.streamId,
      jobId: req.jobId,
      config: req.config ?? {},
    });
  }
  stashIngest(req: StashIngestReq): Promise<any> {
    return this.post("/stash/ingest", {
      ts: req.ts,
      seq: req.seq,
      jpeg: req.jpeg,
      audio: req.audio ?? "",
      audioMime: req.audioMime ?? "",
    });
  }
}

/** Build a decide watcher client for the live watcher-first path, or null
 * when no decide base is configured (on-chain / orchestrator mode without a
 * direct DECIDE_URL). A null is a SAFE no-op — callers fall back to the
 * legacy loop rather than fail a live job. */
export function makeDecideWatcherClient(
  cfg: { decideUrl?: string },
  opts?: HttpOpts
): DecideWatcherClient | null {
  if (!cfg.decideUrl) return null;
  return new HttpDecideWatcherClient(cfg.decideUrl, opts);
}
