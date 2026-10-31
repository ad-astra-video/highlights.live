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

/** Counter fields persisted on a COMPLETED job record. Both completion paths
 * (VOD `file` and live) go through this, so a job that produced highlights via
 * the observe cadence is recorded as `candidatesTriggered: <observed>` with
 * `candidatePath: "observe"` and its Stage-A counters read n/a when the audio
 * gate never judged a candidate. */
export interface CompletedCounterFields extends JobStageAMetrics {
  candidatesTriggered: number;
  candidatePath: CandidatePath;
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
