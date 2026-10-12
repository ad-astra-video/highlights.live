import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Durable ledger of ACTIVE (on-chain funded) perceive sessions.
 *
 * Why: `OrchestratorAdapter.payers` — the interval payment refreshers that keep
 * a perceive session funded — is an in-memory `Map` that lives only in the
 * process. When the `highlights-server` container is recreated mid-VOD (a
 * deploy/restart), that map is empty, so a perceive session the orchestrator
 * still holds stops being funded. go-livepeer keeps accounting the session
 * every 5s tick until balance < fee and force-releases it with
 * `insufficient balance` (ADAAAA-6586). The ledger persists the set of sessions
 * the process is currently funding so the server can, on boot, proactively stop
 * any that were orphaned by the restart instead of leaving the orchestrator to
 * bill-and-force-release them.
 *
 * Only on-chain funded sessions are registered (a session that has no running
 * payment refresher is never force-released, so it needs no release on boot).
 */
export interface PerceiveSessionLedger {
  /** Record that we are now funding `sessionId`. Idempotent. */
  register(sessionId: string): Promise<void>;
  /** Stop tracking `sessionId` (after a confirmed stop). Idempotent. */
  unregister(sessionId: string): Promise<void>;
  /** All sessions the last process left funded. */
  list(): Promise<string[]>;
}

/**
 * File-backed ledger: a JSON array of session ids in the server data dir, which
 * is a host-bind mount that survives container recreation. Read-tolerant of a
 * missing/corrupt file; written atomically (temp + rename) so a crash mid-write
 * cannot leave a truncated file.
 */
export function filePerceiveSessionLedger(filePath: string): PerceiveSessionLedger {
  const load = async (): Promise<string[]> => {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  const save = async (ids: string[]): Promise<void> => {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, JSON.stringify(ids), "utf8");
    await rename(tmp, filePath);
  };
  return {
    async register(sessionId) {
      const ids = await load();
      if (!ids.includes(sessionId)) await save([...ids, sessionId]);
    },
    async unregister(sessionId) {
      const ids = await load();
      const next = ids.filter((x) => x !== sessionId);
      if (next.length !== ids.length) await save(next);
    },
    async list() {
      return load();
    },
  };
}

/** Anything that can stop a perceive session (matches the adapter's signature). */
export interface PerceiveSessionStopper {
  stopPerceive(sessionId: string): Promise<void>;
}

/**
 * On boot, release every perceive session the previous process left funded. A
 * fresh server no longer runs their payment refreshers, so if left alone the
 * orchestrator accounts each to `insufficient balance` and force-releases it
 * (ADAAAA-6586). `stopPerceive` is idempotent on the orchestrator — a session
 * go-livepeer already released returns 404, which the adapter treats as success
 * — so releasing an already-gone session is safe. A release that fails (e.g.
 * the orchestrator is briefly unreachable) is logged and left in the ledger so
 * the next boot retries it.
 */
export async function releaseOrphanedPerceiveSessions(
  stopper: PerceiveSessionStopper,
  ledger: PerceiveSessionLedger
): Promise<{ released: string[]; failed: string[] }> {
  const ids = await ledger.list();
  const released: string[] = [];
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await stopper.stopPerceive(id);
      released.push(id);
    } catch (e) {
      failed.push(id);
      // eslint-disable-next-line no-console
      console.error(`[perceive-ledger] release orphaned perceive session ${id} failed:`, (e as Error)?.message || e);
    }
  }
  return { released, failed };
}
