// Open-session ledger for the media node (ADAAAA-7700).
//
// The lifecycle ledger (./lifecycle.ts) says THAT the process restarted and why.
// This one says WHICH browser sessions died with it. Without it a recreate /
// crash takes the RTC session down and NOTHING tells the control plane: the
// browser job sat `active` (or was reaped as a bare `failed` at server boot) with
// zero frames, which is indistinguishable from "the pipeline never ran".
//
// Shape: one small JSON array rewritten on every session open/teardown. The
// media node is capacity-1 (a handful of sessions at most) so a rewrite is cheap
// and a torn write can only lose the recovery hint, never a session.
//
// On boot the node drains the file (read + clear) and POSTs
// `POST {CALLBACK_URL}/jobs/{jobId}/media/session-closed` with
// `reason: "media-node-restart"` for every leftover session, which the control
// plane turns into `status: failed, failureReason: media-session-lost`.
//
// Persistence dir is `MEDIA_STATE_DIR` (the `media-state` volume in compose), so
// the leftover list survives the recreate that creates it in the first place.

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type OpenSessionRecord = {
  /** perceive session id on the orchestrator (the id the control plane knows) */
  sessionId: string;
  /** browser job the session was carrying ("" when provisioned without one) */
  jobId: string;
  /** wall clock of the session open (ms) */
  startedAt: number;
  /** transport the client used, when a client ever attached */
  transport: "webrtc" | "ws" | "none";
  /** true once any client (RTC peer or WS socket) attached to the session */
  everAttached: boolean;
};

const OPEN_FILE = "highlights-media-open-sessions.json";

export function openSessionsPath(dir: string = process.env.MEDIA_STATE_DIR || os.tmpdir()): string {
  return path.join(dir, OPEN_FILE);
}

/** Read the leftover sessions; a missing/corrupt file reads as "none". */
export function loadOpenSessions(dir?: string): OpenSessionRecord[] {
  try {
    const raw = JSON.parse(readFileSync(openSessionsPath(dir), "utf8"));
    const arr = Array.isArray(raw) ? raw : raw?.sessions;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((s: any) => s && typeof s.sessionId === "string")
      .map((s: any) => ({
        sessionId: s.sessionId,
        jobId: typeof s.jobId === "string" ? s.jobId : "",
        startedAt: typeof s.startedAt === "number" ? s.startedAt : 0,
        transport: s.transport === "webrtc" || s.transport === "ws" ? s.transport : "none",
        everAttached: !!s.everAttached,
      }));
  } catch {
    return [];
  }
}

/** Replace the file atomically (write temp + rename) so a crash mid-write can
 *  never leave a half-parsed leftover list behind. */
function writeOpenSessions(dir: string | undefined, sessions: OpenSessionRecord[]): void {
  const target = openSessionsPath(dir);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, target);
  } catch {
    /* best-effort: losing the hint degrades to the pre-7700 behaviour */
  }
}

/** Record (or refresh) one open session. Called on every session open/adopt. */
export function recordOpenSession(
  dir: string | undefined,
  rec: Omit<OpenSessionRecord, "startedAt" | "transport" | "everAttached"> & {
    startedAt?: number;
    transport?: OpenSessionRecord["transport"];
    everAttached?: boolean;
  }
): void {
  const sessions = loadOpenSessions(dir).filter((s) => s.sessionId !== rec.sessionId);
  sessions.push({
    sessionId: rec.sessionId,
    jobId: rec.jobId ?? "",
    startedAt: rec.startedAt ?? Date.now(),
    transport: rec.transport ?? "none",
    everAttached: !!rec.everAttached,
  });
  writeOpenSessions(dir, sessions);
}

/** Forget a session that ended cleanly (its close was already reported). */
export function forgetOpenSession(dir: string | undefined, sessionId: string): void {
  const sessions = loadOpenSessions(dir);
  const next = sessions.filter((s) => s.sessionId !== sessionId);
  if (next.length !== sessions.length) writeOpenSessions(dir, next);
}

/** Read the leftovers and CLEAR the file: the caller is the boot reconcile, so
 *  a session must be reported exactly once. */
export function drainOpenSessions(dir?: string): OpenSessionRecord[] {
  const sessions = loadOpenSessions(dir);
  if (sessions.length) writeOpenSessions(dir, []);
  return sessions;
}
