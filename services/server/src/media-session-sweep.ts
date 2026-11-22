// Backstop for the "media node NEVER returns" door (ADAAAA-8824).
//
// ADAAAA-8813 fixed the restart case ON the media node: `reconcileLostSessions()`
// drains its own ledger at boot and stops every orchestrator live-runner session
// it left behind. That fix only runs when the node boots. If the node is removed
// from the deploy, pulled, or its host dies, nothing drains the ledger, so the
// orchestrator keeps accounting each paid live-runner session every 5 s until the
// balance expires AND the capacity-1 perceive slot stays held.
//
// This module is the control-plane backstop: for every ACTIVE `media_sessions`
// row whose owning job is still in flight, ask the media node whether it
// actually serves that session id (`GET /node`, bearer `MEDIA_HEALTH_TOKEN`).
// A node that is unreachable at the transport level, or a 200 whose session list
// does not contain the id, means the session is detached — no node will ever
// release it — so stop it through the canonical orchestrator route
// (`POST /apps/highlights-perceive/session/{sid}/stop`, via
// `adapter.stopPerceive`).
//
// It is deliberately:
//   - GATED: inert unless BOTH `MEDIA_SERVER_URL` and `MEDIA_HEALTH_TOKEN` are
//     set. `GET /node` answers 404 "detail disabled" without the token, and a
//     404 must never be read as "no node serves this" — that would stop every
//     live session on a misconfigured box.
//   - CONSERVATIVE: only two answers are acted on — a transport failure
//     (connection refused / DNS / timeout) confirmed `probeAttempts` times in a
//     row, or a 200 whose session list positively lacks the id. Any other
//     answer (401 token mismatch, 5xx, unparseable body) is UNVERIFIED and
//     stops nothing: an operator mistake must not kill live paid sessions.
//   - BOUNDED: at most `maxRows` active rows are inspected per sweep.
//   - IDEMPOTENT: a confirmed stop settles the row `active` -> `closed` (row
//     kept, so the `node_id` -> `job.costUsd` attribution join survives — the
//     same shape `media-session-reconcile.ts` uses), so a re-run has no
//     candidate left. A stop that throws leaves the row active so the next tick
//     retries it; a repeat stop on an already-released session is a 404 no-op
//     on the orchestrator.
//   - LOGGED: the result carries the ids it released for the caller's summary.
import type { MediaSession } from "./db";
import { Store } from "./store";
import type { PerceiveSessionStopper } from "./perceive-ledger";
import type { Job } from "@highlights/events";

/** Upper bound on active rows inspected in one sweep (same sanity bound as the
 * boot reconcile — the table holds one row per job). */
export const MEDIA_SESSION_SWEEP_MAX_ROWS = 2000;

/** Default cadence of the periodic sweep. A detached session is a standing
 * Livepeer debit, so the tick is much tighter than the hourly housekeeping
 * sweeps; 60 s bounds the waste to ~12 paid ticks per detached session. */
export const MEDIA_SESSION_SWEEP_INTERVAL_MS = 60_000;

/** How many consecutive transport failures confirm "the node is unreachable".
 * One dropped packet must not kill every live session on the box; the node's
 * own boot reconcile releases its sessions anyway, so a short retry costs
 * nothing but a second. */
export const MEDIA_SESSION_SWEEP_PROBE_ATTEMPTS = 2;

/** Delay between unreachable-probe attempts. */
export const MEDIA_SESSION_SWEEP_PROBE_RETRY_MS = 1_000;

/** Per-probe HTTP timeout. A dead node must not stall the tick. */
export const MEDIA_SESSION_SWEEP_PROBE_TIMEOUT_MS = 2_000;

export interface MediaSessionSweepDb {
  listMediaSessions(): Promise<MediaSession[]>;
  closeMediaSession(jobId: string): Promise<boolean>;
}

/** The readable answer to "does the media node serve these sessions?". */
export type MediaNodeProbe =
  | { kind: "served"; nodeId: string | null; sessionIds: string[] }
  | { kind: "unreachable"; error: string }
  | { kind: "unverified"; reason: string; httpStatus?: number };

/**
 * Ask the media node for its per-session detail (`GET /node`).
 *
 * `served`     — HTTP 200 with a parseable `sessions[]` (ids may be empty).
 * `unreachable`— the transport failed: connection refused, DNS failure, reset,
 *                timeout. This is the "no node" door this ticket owns.
 * `unverified` — the node answered, but not with a session list we can trust
 *                (401 token mismatch, 404 detail disabled, 5xx, bad body).
 *                Callers must NOT treat this as "detached".
 */
export async function probeMediaNode(opts: {
  mediaServerUrl: string;
  mediaHealthToken?: string;
  timeoutMs?: number;
}): Promise<MediaNodeProbe> {
  const origin = opts.mediaServerUrl.replace(/\/+$/, "");
  if (!origin) return { kind: "unverified", reason: "MEDIA_SERVER_URL empty" };
  const headers: Record<string, string> = {};
  if (opts.mediaHealthToken) headers.authorization = `Bearer ${opts.mediaHealthToken}`;
  let res: Response;
  try {
    res = await fetch(`${origin}/node`, {
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? MEDIA_SESSION_SWEEP_PROBE_TIMEOUT_MS),
    });
  } catch (e: any) {
    // Transport-level failure only — this is the "node never returns" signal.
    return { kind: "unreachable", error: String(e?.message || e) };
  }
  if (res.status !== 200) {
    // 401 => our token is wrong, 404 => detail surface disabled, 5xx => the node
    // is up but degraded. None of these says the session is detached.
    return { kind: "unverified", reason: `GET /node HTTP ${res.status}`, httpStatus: res.status };
  }
  try {
    const body: any = await res.json();
    if (!Array.isArray(body?.sessions)) {
      return { kind: "unverified", reason: "GET /node body has no sessions[]" };
    }
    const sessionIds = body.sessions
      .map((s: any) => (typeof s?.sessionId === "string" ? s.sessionId : null))
      .filter((s: string | null): s is string => !!s);
    const nodeId = typeof body?.node?.id === "string" && body.node.id ? body.node.id : null;
    return { kind: "served", nodeId, sessionIds };
  } catch (e: any) {
    return { kind: "unverified", reason: `GET /node body unreadable: ${String(e?.message || e)}` };
  }
}

export interface MediaSessionSweepResult {
  /** False when the sweep is inert (config gate). */
  enabled: boolean;
  /** Why the sweep is inert, for the boot/tick log. */
  disabledReason?: string;
  /** Active rows inspected (bounded by `maxRows`). */
  scanned: number;
  /** Rows on a still-in-flight job — the only rows this sweep can act on. */
  candidates: number;
  /** Candidates the node positively serves (left alone). */
  served: number;
  /** Candidates owned by a DIFFERENT media node than the probed one (skipped). */
  otherNode: number;
  /** Candidates whose detached/served state could not be verified (left alone). */
  unverified: number;
  /** Sessions stopped because no media node serves them. */
  released: number;
  releasedSessionIds: string[];
  /** Stops that threw (row left active; the next tick retries). */
  failed: number;
  failedSessionIds: string[];
  /** What the probe concluded about the node. */
  node: "served" | "unreachable" | "unverified" | "not-probed";
}

/** Terminal-status check kept local so this module never imports the Store class
 * state (only the static helper) — mirrors `media-session-reconcile.ts`. */
function isInFlight(job: Pick<Job, "status"> | undefined): boolean {
  if (!job) return false;
  return !Store.isTerminalStatus(job.status);
}

/**
 * Sweep `media_sessions` rows whose owning job is still in flight and stop any
 * session the media node does not serve.
 *
 * Safety notes that the tests pin:
 *   - a node that serves the session is NEVER stopped (a running node is the
 *     authority on what it holds);
 *   - an unverified answer stops nothing;
 *   - a row whose `nodeId` names another node than the probed one is skipped
 *     (a fleet must not have node B's sessions killed by node A's list);
 *   - only a confirmed stop settles the row, so a failure is retried next tick.
 */
export async function sweepDetachedMediaSessions(opts: {
  db: MediaSessionSweepDb;
  /** In-memory job lookup (the Store after `load()`). */
  getJob: (jobId: string) => Pick<Job, "status"> | undefined;
  /** Media node base URL (`MEDIA_SERVER_URL`). Unset => inert. */
  mediaServerUrl?: string;
  /** Bearer for `GET /node` (`MEDIA_HEALTH_TOKEN`). Unset => inert. */
  mediaHealthToken?: string;
  /** Canonical orchestrator stop (the adapter's `stopPerceive`). */
  stopper: PerceiveSessionStopper;
  maxRows?: number;
  probeAttempts?: number;
  probeRetryDelayMs?: number;
  probeTimeoutMs?: number;
  /** Injectable probe (tests use the real one against a fake node). */
  probe?: typeof probeMediaNode;
}): Promise<MediaSessionSweepResult> {
  const base: MediaSessionSweepResult = {
    enabled: false,
    scanned: 0,
    candidates: 0,
    served: 0,
    otherNode: 0,
    unverified: 0,
    released: 0,
    releasedSessionIds: [],
    failed: 0,
    failedSessionIds: [],
    node: "not-probed",
  };
  if (!opts.mediaServerUrl) {
    return { ...base, disabledReason: "MEDIA_SERVER_URL unset" };
  }
  if (!opts.mediaHealthToken) {
    // `GET /node` is 404 without the token on the media node. Probing anyway
    // would turn an operator misconfiguration into "stop every live session".
    return {
      ...base,
      disabledReason: "MEDIA_HEALTH_TOKEN unset (GET /node detail surface disabled)",
    };
  }
  const maxRows = Math.max(0, opts.maxRows ?? MEDIA_SESSION_SWEEP_MAX_ROWS);
  let rows: MediaSession[] = [];
  try {
    rows = await opts.db.listMediaSessions();
  } catch {
    // No table / unreachable DB: nothing to sweep; never block the tick/boot.
    return { ...base, enabled: true, disabledReason: "media_sessions unreadable" };
  }
  const candidates = rows.filter((r) => r.status === "active" && isInFlight(opts.getJob(r.jobId))).slice(0, maxRows);
  const result: MediaSessionSweepResult = {
    ...base,
    enabled: true,
    scanned: Math.min(rows.filter((r) => r.status === "active").length, maxRows),
    candidates: candidates.length,
  };
  if (candidates.length === 0) return result;

  const probe = opts.probe ?? probeMediaNode;
  const attempts = Math.max(1, opts.probeAttempts ?? MEDIA_SESSION_SWEEP_PROBE_ATTEMPTS);
  let probed: MediaNodeProbe = { kind: "unverified", reason: "not probed" };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    probed = await probe({
      mediaServerUrl: opts.mediaServerUrl,
      mediaHealthToken: opts.mediaHealthToken,
      timeoutMs: opts.probeTimeoutMs,
    });
    if (probed.kind !== "unreachable") break;
    if (attempt < attempts) {
      const delay = Math.max(0, opts.probeRetryDelayMs ?? MEDIA_SESSION_SWEEP_PROBE_RETRY_MS);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }

  if (probed.kind === "unverified") {
    // The node answered, but we cannot tell served from detached. Leave every
    // candidate alone — this is the "do not kill a live stream on a credential
    // mistake" branch.
    result.node = "unverified";
    result.unverified = candidates.length;
    return result;
  }

  result.node = probed.kind;
  const servedIds = probed.kind === "served" ? new Set(probed.sessionIds) : null;
  const probedNodeId = probed.kind === "served" ? probed.nodeId : null;

  for (const row of candidates) {
    // Fleet guard: a row written by another node must not be judged by this
    // node's list. `nodeId` is null on rows written before ADAAAA-6869, so a
    // null row is judged against the probed node.
    if (probedNodeId && row.nodeId && row.nodeId !== probedNodeId) {
      result.otherNode++;
      continue;
    }
    if (servedIds && servedIds.has(row.sessionId)) {
      result.served++;
      continue;
    }
    // Detached: the node is unreachable (transport-confirmed) or positively does
    // not list this session. No node will ever release it, so release it here.
    try {
      await opts.stopper.stopPerceive(row.sessionId);
      result.released++;
      result.releasedSessionIds.push(row.sessionId);
      // Settle only after a confirmed stop: the row stays (attribution join) but
      // stops reading `active`, so a re-run has no candidate and the media
      // session reuse path can never hand out a session no node holds.
      try {
        await opts.db.closeMediaSession(row.jobId);
      } catch {
        /* bookkeeping only — the stop already landed */
      }
    } catch (e: any) {
      result.failed++;
      result.failedSessionIds.push(row.sessionId);
      // eslint-disable-next-line no-console
      console.error(
        `[media-session-sweep] stop ${row.sessionId} (job ${row.jobId}) failed:`,
        String(e?.message || e)
      );
    }
  }
  return result;
}
