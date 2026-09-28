// Browser persistence for the web dataset curation workflow (ADAAAA-5395 C2).
//
// The Fine Tune curation page holds a growing in-memory session: the ingested
// clip (source / window / fps), the extracted frames, each frame's accepted
// flag and its curated boxes / labels, the currently selected frame/box, and
// the seed JSON. So the user can START / STOP / RESUME without losing state
// (and reload never drops work), we persist that whole session to browser
// storage. The frame *metadata* is what we store — the pixels stay on the
// server (re-fetched from `imageRef`), so storage stays small and reload-safe.
//
// Pure + unit-testable without a browser: everything here takes / returns
// plain objects and JSON strings; the thin `localStorage` adapter at the
// bottom is the only thing that touches the platform.
import type { CurationBox, CurationFrame } from "./dataset";

export const SESSION_STORAGE_KEY = "hl_dataset_session_v1";
export const SESSION_VERSION = 1;

/** The subset of a frame we persist. `uri` is deliberately excluded: object
 * URLs / fetch paths are transient per-session and reconstructed from
 * `imageRef` on restore. */
export type PersistedFrame = Omit<CurationFrame, "uri">;

export interface DatasetSessionState {
  version: typeof SESSION_VERSION;
  savedAt: string;
  /** ingest params so Resume restores the same extraction inputs */
  ingest: {
    source: string;
    inSec: string;
    outSec: string;
    fps: string;
  };
  frames: PersistedFrame[];
  selIdx: number | null;
  selBox: string | null;
  label: string;
  seedJson: string;
}

export type DatasetSessionJson = string;

/** Drop the transient `uri` from a live frame so it can be persisted. */
export function frameToPersisted(f: CurationFrame): PersistedFrame {
  const { uri: _uri, ...rest } = f;
  return rest;
}

/** Re-attach the server frame fetch path from `imageRef` on restore (same
 * derivation the extract path uses: /training/frames/<imageRef>). */
export function frameFromPersisted(p: PersistedFrame): CurationFrame {
  return { ...p, uri: `/training/frames/${p.imageRef}` };
}

export interface BuildSessionArgs {
  ingest: DatasetSessionState["ingest"];
  frames: CurationFrame[];
  selIdx: number | null;
  selBox: string | null;
  label: string;
  seedJson: string;
}

/** Build a session snapshot from the live editor state. Exposed for the UI
 * to call on every mutation (debounced) and for tests. */
export function buildSession(args: BuildSessionArgs): DatasetSessionState {
  return {
    version: SESSION_VERSION,
    savedAt: new Date().toISOString(),
    ingest: args.ingest,
    frames: args.frames.map(frameToPersisted),
    selIdx: args.selIdx,
    selBox: args.selBox,
    label: args.label,
    seedJson: args.seedJson,
  };
}

/** Serialize a session snapshot to its JSON storage form. */
export function serializeSession(s: DatasetSessionState): DatasetSessionJson {
  return JSON.stringify(s);
}

/** Minimal shape guard so a stale/corrupt blob can never crash the editor. */
function isPersistedFrame(v: unknown): v is PersistedFrame {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.imageRef === "string" &&
    typeof o.width === "number" &&
    typeof o.height === "number" &&
    typeof o.phash === "string" &&
    typeof o.sourceSeq === "number" &&
    typeof o.accepted === "boolean" &&
    Array.isArray(o.boxes) &&
    (o.boxes as unknown[]).every(
      (b) =>
        typeof b === "object" &&
        b !== null &&
        typeof (b as CurationBox).id === "string" &&
        typeof (b as CurationBox).label === "string" &&
        Array.isArray((b as CurationBox).bbox) &&
        (b as CurationBox).bbox.length === 4
    )
  );
}

/** Parse + validate a stored session JSON back into a session snapshot.
 * Returns null for anything that does not round-trip cleanly (unknown
 * version, wrong shape, empty frames), so callers can safely fall back to a
 * fresh session. */
export function parseSession(json: DatasetSessionJson): DatasetSessionState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== SESSION_VERSION) return null;
  if (typeof o.ingest !== "object" || o.ingest === null) return null;
  const ing = o.ingest as Record<string, unknown>;
  if (
    typeof ing.source !== "string" ||
    typeof ing.inSec !== "string" ||
    typeof ing.outSec !== "string" ||
    typeof ing.fps !== "string"
  ) {
    return null;
  }
  if (!Array.isArray(o.frames) || !o.frames.every(isPersistedFrame)) return null;
  const selIdx = o.selIdx == null ? null : o.selIdx;
  if (selIdx !== null && (typeof selIdx !== "number" || !Number.isInteger(selIdx))) return null;
  const selBox = o.selBox == null ? null : o.selBox;
  if (selBox !== null && typeof selBox !== "string") return null;
  if (typeof o.label !== "string") return null;
  if (typeof o.seedJson !== "string") return null;
  return {
    version: SESSION_VERSION,
    savedAt: typeof o.savedAt === "string" ? o.savedAt : new Date().toISOString(),
    ingest: { source: ing.source, inSec: ing.inSec, outSec: ing.outSec, fps: ing.fps },
    frames: o.frames as PersistedFrame[],
    selIdx,
    selBox,
    label: o.label,
    seedJson: o.seedJson,
  };
}

/** Restore live CurationFrame[] (with reattached fetch uris) from a session. */
export function framesFromSession(s: DatasetSessionState): CurationFrame[] {
  return s.frames.map(frameFromPersisted);
}

// --- thin storage adapter (only platform touch in this module) -------------

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

/** Persist a session snapshot to browser storage. Returns false if storage is
 * unavailable (e.g. SSR / test env without a platform) — callers treat that
 * as non-fatal. */
export function saveSession(s: DatasetSessionState, storage: StorageLike | null = defaultStorage()): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SESSION_STORAGE_KEY, serializeSession(s));
    return true;
  } catch {
    return false;
  }
}

/** Load the persisted session (if any, and only if it parses cleanly). */
export function loadSession(storage: StorageLike | null = defaultStorage()): DatasetSessionState | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    return raw ? parseSession(raw) : null;
  } catch {
    return null;
  }
}

/** Drop any persisted session (used by "Start new"). */
export function clearSession(storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Does a persisted session currently exist in storage? */
export function hasSession(storage: StorageLike | null = defaultStorage()): boolean {
  return loadSession(storage) !== null;
}
