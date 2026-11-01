// ADAAAA-7624: honest per-job counters for the completed job record.
//
// Two defects motivated this module:
//
// 1. `candidatesTriggered` was incremented only from the legacy perceive
//    `candidate` events. Under the observe architecture (ADAAAA-7007/7008) the
//    cadence decide observer produces the candidates and emits only `highlight`
//    events, so a job that produced 24 accepted highlights persisted
//    `candidatesTriggered: 0`.
// 2. `stageAMetrics` was always the audio Stage-A snapshot, which is an
//    all-zero object when that gate judged nothing. A zero snapshot reads as a
//    measured 0% false-positive rate, so tiles showed `0 candidates` instead of
//    `n/a` for a pipeline stage that never ran.
//
// The module is pure (no IO) so both rules are unit-testable in isolation and
// the API routes stay the only place that touches the store.
import type { StageAMetricsSnapshot } from "@highlights/events";

/** Which trigger path produced a job's candidate count. */
export type CandidatePath = "observe" | "perceive_gate" | "none";

export interface JobCandidateCount {
  count: number;
  path: CandidatePath;
}

/**
 * Count the candidates the path that ACTUALLY RAN produced.
 *
 * `observeAccepted` is `vodObserveMetrics.accepted` when the cadence decide
 * observer ran (undefined otherwise); `rawCandidateEvents` is the legacy
 * perceive-candidate counter. The observer wins when present because it is the
 * path that produced the highlights; the raw counter is the fallback for the
 * legacy perceive-gate pipeline, and 0/none when neither path ran.
 */
export function candidateCountForJob(
  observeAccepted: number | undefined,
  rawCandidateEvents: number
): JobCandidateCount {
  if (observeAccepted !== undefined) {
    return { count: Math.max(0, Math.floor(observeAccepted)), path: "observe" };
  }
  if (rawCandidateEvents > 0) {
    return { count: Math.max(0, Math.floor(rawCandidateEvents)), path: "perceive_gate" };
  }
  return { count: 0, path: "none" };
}

/**
 * Count the candidates a LIVE job's observe pass produced (ADAAAA-7667).
 *
 * A live job records its observe decisions only as an aggregate
 * (`observeMetrics.accepted`): the live pass never writes the VOD decision trail
 * (`job.candidates`) nor a candidates counter, so such a record fell through the
 * VOD-only read-time projection to `0 / "none"` while the observe path had
 * accepted highlights, and the job-detail "Candidates" header read 0 next to a
 * non-zero Decide-calls header.
 *
 * Count rule (keeps the ADAAAA-7624 semantics — never re-count one play):
 * - The persisted highlight count is the deduped source of truth and wins when
 *   it is non-zero. Consecutive live windows overlap (~3 s cadence over a
 *   ~7.5 s window), so the same play CAN be accepted by two windows and inflate
 *   `observeMetrics.accepted`.
 * - When no highlight is persisted the accepted tally is the only evidence of
 *   what the pass produced, so it is the count. Live completion patches the
 *   counters before/while the highlight write lands and every pre-fix record
 *   carries `highlightsFound: 0`, so this is the common path.
 * - The path is `observe` whenever the observer ran, even when it accepted
 *   nothing (a measured 0 from the path that ran, never "no path ran").
 */
export function liveCandidateCountForJob(
  observeAccepted: number | undefined,
  persistedHighlights: number
): JobCandidateCount {
  const produced = Math.max(0, Math.floor(persistedHighlights));
  if (produced > 0) return { count: produced, path: "observe" };
  if (observeAccepted !== undefined) {
    return { count: Math.max(0, Math.floor(observeAccepted)), path: "observe" };
  }
  return { count: 0, path: "none" };
}

export interface JobStageAMetrics {
  /** Present only for a real measurement — never an all-zero snapshot. */
  stageAMetrics?: StageAMetricsSnapshot;
  /** `n/a` when the audio Stage-A gate judged no candidate (its counters must
   * render as "not measured", not as a measured zero). */
  stageAMetricsStatus: "measured" | "n/a";
}

/**
 * Persisted Stage-A counters for a completed job. Only a snapshot that judged
 * at least one candidate is a measurement; anything else is `n/a` and the
 * snapshot is omitted so no reader can mistake 0 for a measured 0% FP rate.
 */
export function stageAMetricsForJob(snapshot: StageAMetricsSnapshot): JobStageAMetrics {
  if (snapshot.totalCandidates > 0) {
    return { stageAMetrics: snapshot, stageAMetricsStatus: "measured" };
  }
  return { stageAMetricsStatus: "n/a" };
}

/** The subset of a stored job record the read-time projection needs. */
export interface CounterReadableJob {
  candidatePath?: CandidatePath;
  candidatesTriggered?: number;
  candidates?: readonly unknown[];
  highlightsFound?: number;
  vodObserveMetrics?: { accepted?: number };
  stageAMetrics?: StageAMetricsSnapshot;
  stageAMetricsStatus?: "measured" | "n/a";
  decideCalls?: number;
  /** Live observe-pass snapshot (ADAAAA-7011/7667). Present only on a live job. */
  observeMetrics?: { decideCalls?: number; accepted?: number };
}

/**
 * Honest counters for a job whose record was written BEFORE the completion-time
 * fix (ADAAAA-7624). Those records carry `candidatesTriggered: 0` from the
 * legacy perceive counter and no `candidatePath` / `stageAMetricsStatus`, so a
 * reader that only echoes stored fields still shows `0 candidates` and an
 * all-zero Stage-A row for a job that ran the observe cadence and judged no
 * audio candidate. Deriving at READ time keeps the historical record untouched
 * (no data backfill) while making the tile truthful, and it is a no-op for
 * records that already carry the fields.
 *
 * Count rule: the candidates the observe path actually produced are the
 * decision rows on the record (`job.candidates`), i.e. distinct highlights —
 * `vodObserveMetrics.accepted` is a per-window tally that re-counts the same
 * play across overlapping windows, so it is only a last-resort fallback and is
 * never the user-facing count.
 *
 * ADAAAA-7667: a LIVE record carries `observeMetrics` instead of
 * `vodObserveMetrics` (it never writes `job.candidates`), so it has its own
 * branch — see {@link liveCandidateCountForJob}.
 */
export function counterFieldsForJob(job: CounterReadableJob): Partial<CompletedCounterFields> {
  const out: Partial<CompletedCounterFields> = {};
  if (job.candidatePath === undefined) {
    const produced = Math.max(0, Math.floor(job.candidates?.length ?? 0));
    const stored = Math.max(0, Math.floor(job.candidatesTriggered ?? 0));
    if (job.vodObserveMetrics !== undefined) {
      out.candidatesTriggered = produced > 0 ? produced : Math.max(0, Math.floor(job.highlightsFound ?? 0));
      out.candidatePath = "observe";
    } else if (job.observeMetrics !== undefined) {
      // ADAAAA-7667: the live observe pass ran (it is the only path a live job
      // has). `highlightsFound` is the deduped persisted count; the accepted
      // tally is a per-window count that can re-count an overlapping play.
      const live = liveCandidateCountForJob(
        job.observeMetrics.accepted,
        Math.max(produced, Math.max(0, Math.floor(job.highlightsFound ?? 0)))
      );
      out.candidatesTriggered = live.count;
      out.candidatePath = live.path;
    } else if (stored > 0) {
      out.candidatesTriggered = stored;
      out.candidatePath = "perceive_gate";
    } else if (produced > 0) {
      // A decision trail without the legacy counter: only the observe cadence
      // records decisions (the legacy perceive path also incremented `stored`),
      // so an in-flight job mid-analyze reports its candidates, not a 0.
      out.candidatesTriggered = produced;
      out.candidatePath = "observe";
    } else {
      out.candidatesTriggered = 0;
      out.candidatePath = "none";
    }
  }
  if (job.stageAMetricsStatus === undefined) {
    const measured = (job.stageAMetrics?.totalCandidates ?? 0) > 0;
    out.stageAMetricsStatus = measured ? "measured" : "n/a";
    // Never hand a reader the all-zero snapshot as if it were a measurement.
    if (!measured) out.stageAMetrics = undefined;
  }
  // ADAAAA-7664: a live job records its decide invocations in
  // `observeMetrics.decideCalls` and (before this fix) never wrote the job-level
  // `decideCalls` field — so a live job with 17 real decides read
  // `decideCalls: null` and every header rendered `Decide calls 0`. Project the
  // observe count onto the field for records written before the fix; a record
  // that already carries `decideCalls` (the VOD path) is untouched.
  if (job.decideCalls === undefined) {
    const observed = job.observeMetrics?.decideCalls;
    if (observed !== undefined && observed !== null) {
      out.decideCalls = Math.max(0, Math.floor(observed));
    }
  }
  return out;
}

/** Counter fields persisted on a COMPLETED job record. Both completion paths
 * (VOD `file` and live) go through this, so a job that produced highlights via
 * the observe cadence is recorded as `candidatesTriggered: <observed>` with
 * `candidatePath: "observe"` and its Stage-A counters read n/a when the audio
 * gate never judged a candidate. */
export interface CompletedCounterFields extends JobStageAMetrics {
  candidatesTriggered: number;
  candidatePath: CandidatePath;
  /** ADAAAA-7664: decide invocations recorded for the job. */
  decideCalls?: number;
}

/**
 * The counter portion of the job-completion patch (ADAAAA-7624). `observeAccepted`
 * is the cadence observer's accepted-candidate count (undefined when the observe
 * path did not run); `rawCandidateEvents` is the legacy perceive candidate
 * counter used as the fallback.
 */
export function completedCounterFields(
  stageASnapshot: StageAMetricsSnapshot,
  observeAccepted: number | undefined,
  rawCandidateEvents: number
): CompletedCounterFields {
  const candidates = candidateCountForJob(observeAccepted, rawCandidateEvents);
  return {
    candidatesTriggered: candidates.count,
    candidatePath: candidates.path,
    ...stageAMetricsForJob(stageASnapshot),
  };
}

/**
 * The counter portion of the LIVE job-completion patch (ADAAAA-7667). Mirrors
 * {@link completedCounterFields} for the live pass, whose only candidate
 * evidence is `observeMetrics.accepted` (it writes no decision trail and no raw
 * event counter). `persistedHighlights` must be the store's deduped count for
 * the job (`store.highlightsForJob(job.id).length`) — not a local tally — so an
 * overlapping live window can never be counted twice.
 */
export function completedLiveCounterFields(
  stageASnapshot: StageAMetricsSnapshot,
  observeMetrics: { accepted?: number } | undefined,
  persistedHighlights: number
): CompletedCounterFields {
  const candidates = liveCandidateCountForJob(observeMetrics?.accepted, persistedHighlights);
  return {
    candidatesTriggered: candidates.count,
    candidatePath: candidates.path,
    ...stageAMetricsForJob(stageASnapshot),
  };
}
