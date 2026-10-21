// Increment 3 T2 (ADAAAA-6871): shared decision-trail model + pure merge helpers
// for the Job detail panel. DOM-free, so these are unit-testable in node with
// the repo's existing vitest helper-test pattern (see jobTrail.test.ts). The
// trail is the bounded ordered array of candidate/highlight decisions the server
// persists on the job record (`job.candidates`, ADAAAA-6870 T1) plus live
// `candidate`/`highlight` SSE frames appended in flight.
import type { Job, JobDecision } from "./api";

/** One rendered decision-trail entry. `kind` distinguishes a candidate trigger
 * from a highlight verdict so the panel can style/annotate them differently. */
export interface TrailEntry {
  seq: number;
  ts: number;
  eventType: string;
  decision: string;
  highlightId?: string;
  kind: "candidate" | "highlight";
}

/** A `candidate` trigger record uses decision === "candidate"; anything else is
 * a highlight verdict (the server writes `highlight.outcome ?? status`). */
function isCandidateDecision(decision: string): boolean {
  return decision === "candidate";
}

/** Map a persisted job.candidates entry (JobDecision) to a TrailEntry. */
export function decisionToTrail(d: JobDecision): TrailEntry {
  return {
    seq: d.seq,
    ts: d.ts,
    eventType: d.eventType,
    decision: d.decision,
    highlightId: d.highlightId,
    kind: isCandidateDecision(d.decision) ? "candidate" : "highlight",
  };
}

/** Seed the panel's trail from a job's persisted `candidates` array (the
 * additive nullable field; absent on older/live records -> empty trail). */
export function trailFromJob(job: Job | undefined | null): TrailEntry[] {
  return (job?.candidates ?? []).map(decisionToTrail);
}

/** Map a raw SSE frame (name, data) to a TrailEntry, mirroring the server's
 * `recordTrailDecision` in services/server/src/api.ts: a `candidate` event ->
 * decision "candidate"; a `highlight` event -> decision
 * `highlight.outcome ?? highlight.status`, with the highlight id. Returns null
 * for unrelated frames (progress, observation, ready, ...), so callers can feed
 * every SSE frame through this filter and append only trail-relevant ones. */
export function trailFromEvent(name: string, data: any): TrailEntry | null {
  if (name === "candidate" && data?.candidate) {
    return {
      seq: typeof data.seq === "number" ? data.seq : 0,
      ts: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
      eventType: data.candidate.eventType ?? "candidate",
      decision: "candidate",
      kind: "candidate",
    };
  }
  if (name === "highlight" && data?.highlight) {
    const h = data.highlight;
    return {
      seq: typeof data.seq === "number" ? data.seq : 0,
      ts: typeof data.timestamp === "number" ? data.timestamp : Date.now(),
      eventType: h.eventType ?? "highlight",
      decision: h.outcome ?? h.status ?? "accepted",
      highlightId: h.id,
      kind: "highlight",
    };
  }
  return null;
}

/** Stable dedupe key so a re-emitted SSE event never double-appends. A candidate
 * and its highlight can share a frame seq, so the kind is part of the key. */
function keyOf(e: TrailEntry): string {
  return `${e.kind}:${e.seq}:${e.eventType}`;
}

/** Merge a batch of incoming trail entries into the current list: dedupe by
 * (kind, seq, eventType) — incoming (newer) wins on a duplicate — and sort
 * ascending by seq then ts, matching the order the server appends. The 15s poll
 * reconciles (re-seeds from `job.candidates`) so SSE only appends live frames
 * in front of a persisted snapshot. */
export function mergeTrail(current: TrailEntry[], incoming: TrailEntry[]): TrailEntry[] {
  const byKey = new Map<string, TrailEntry>();
  for (const e of current) byKey.set(keyOf(e), e);
  for (const e of incoming) byKey.set(keyOf(e), e); // incoming wins on a dup
  return [...byKey.values()].sort((a, b) => (a.seq !== b.seq ? a.seq - b.seq : a.ts - b.ts));
}

/** Reconcile the open panel's trail against the 15s poll's persisted snapshot
 * (`job.candidates`) without wiping live SSE-appended frames (ADAAAA-6893).
 *
 * A live in-flight job carries an EMPTY `job.candidates` — `persistDecision`
 * writes to the `job_candidates` table but does not populate `job.candidates` on
 * the job object — so re-seeding from an empty snapshot erased the SSE-streamed
 * "candidate"/"highlight" entries and dropped the trail back to "No decisions
 * yet". Two rules keep the live trail stable:
 *   - empty persisted snapshot -> keep the current (SSE-appended) trail as-is;
 *   - non-empty snapshot (the VOD `file` path) -> merge it over the current
 *     trail, deduping by (kind, seq, eventType), so persisted decisions and any
 *     not-yet-flushed SSE frames both survive.
 * The panel calls this from `refresh()` so the 15s poll reconciles instead of
 * replacing the trail. */
export function reconcileTrail(current: TrailEntry[], persisted: TrailEntry[]): TrailEntry[] {
  if (persisted.length === 0) return current;
  return mergeTrail(current, persisted);
}

/** True when a job's trail contains at least one candidate trigger (so the panel
 * can say "still analyzing — no candidates yet" for an empty in-flight trail). */
export function hasCandidateTrigger(trail: TrailEntry[]): boolean {
  return trail.some((e) => e.kind === "candidate");
}
