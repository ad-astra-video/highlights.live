// Human labels for the machine-readable `job.failureReason` (ADAAAA-7700).
//
// The job record carries both the free-text `error` (what the server saw) and
// `failureReason` (why it ended, from a closed enum). The UI must show the reason
// as its own labelled chip so an operator can tell a media-node restart apart from
// a user stop at a glance — that distinction is what the 22:16Z incident lacked.

export type FailureReason = "media-session-lost" | "server-restart" | "user-stop" | "pipeline-error";

const LABELS: Record<FailureReason, string> = {
  "media-session-lost": "media session lost",
  "server-restart": "analyzer restart",
  "user-stop": "stopped by user",
  "pipeline-error": "pipeline error",
};

/** Short label for the chip; unknown/absent reasons render nothing. */
export function failureReasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return (LABELS as Record<string, string>)[reason] ?? String(reason);
}

/**
 * True when the reason means the run was cut short by the infrastructure rather
 * than by the operator — the case the console must narrate with a next action.
 */
export function isInfrastructureFailure(reason: string | null | undefined): boolean {
  return reason === "media-session-lost" || reason === "server-restart";
}
