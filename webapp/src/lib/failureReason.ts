// Human labels for the machine-readable `job.failureReason` (ADAAAA-7700).
//
// The job record carries both the free-text `error` (what the server saw) and
// `failureReason` (why it ended, from a closed enum). The UI must show the reason
// as its own labelled chip so an operator can tell a media-node restart apart from
// a user stop at a glance — that distinction is what the 22:16Z incident lacked.
//
// ADAAAA-7907: the four reasons the resume path classifies (ADAAAA-7906) are
// labelled here too. They are the FAILED states that offer Resume, so an
// unlabelled slug would be exactly the chip a resumed job shows.

export type FailureReason =
  | "media-session-lost"
  | "server-restart"
  | "user-stop"
  | "pipeline-error"
  // ADAAAA-7906 (VOD resume): the classified, retriable failures.
  | "decide-unavailable"
  | "perceive-session-lost"
  | "capacity-exhausted";

const LABELS: Record<FailureReason, string> = {
  "media-session-lost": "media session lost",
  "server-restart": "analyzer restart",
  "user-stop": "stopped by user",
  "pipeline-error": "pipeline error",
  "decide-unavailable": "decide service unavailable",
  "perceive-session-lost": "perceive session lost",
  "capacity-exhausted": "GPU capacity exhausted",
};

/** Short label for the chip; unknown/absent reasons render nothing. */
export function failureReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return (LABELS as Record<string, string>)[reason] ?? String(reason);
}

/**
 * True when the reason means the run was cut short by the infrastructure rather
 * than by the operator — the case the console must narrate with a next action.
 *
 * ADAAAA-7907: the resume-classified failures are infrastructure too — the pass
 * died on the GPU/decide side, not because the user did anything.
 */
export function isInfrastructureFailure(reason: string | null | undefined): boolean {
  return (
    reason === "media-session-lost" ||
    reason === "server-restart" ||
    reason === "decide-unavailable" ||
    reason === "perceive-session-lost" ||
    reason === "capacity-exhausted"
  );
}
