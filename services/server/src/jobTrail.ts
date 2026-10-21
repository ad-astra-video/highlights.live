// ADAAAA-7135 (two-tier watch + notes + signal-gated escalation): the durable
// `job.candidates` decision trail records ONLY confirmed highlights.
//
// A raw `candidate` trigger is a Tier-1 watch *hypothesis*, not a confirmed
// scoring play. The perceive tracker labels the fast-strike MOVE/KILL primitive
// as GOAL via `sport_specific_event_type` on essentially every soccer frame, and
// the old `recordTrailDecision` persisted every such trigger as
// `{decision:"candidate"}` — which is what produced the 168-candidate / all-GOAL
// trail flood on the box (`jsonb_array_length(record->'candidates')=168`).
//
// The decide stage already discriminates confirmed scoring plays (`isHighlight`
// true only on real goal windows). So the flood is a recording problem: the
// durable trail must contain only *confirmed highlights*. Candidate triggers
// still fan out live over the SSE `baseHook` (the in-flight note stream) but are
// never written to the durable decision trail.
//
// This pure helper encodes the confirmed-only rule so the VOD recorder in
// `api.ts` and its tests stay in lock-step. Returns `null` for anything that is
// not a confirmed highlight (observations, raw candidate triggers, blocked).
import type { JobDecision } from "@highlights/events";
import type { AnalyzeEvent } from "./analyzer";

/** Map an analyze event to a durable trail entry iff it is a confirmed highlight.
 * `decision` is `highlight.outcome ?? highlight.status` (accepted / near_miss /
 * ...); a raw `candidate` trigger returns `null` and is never recorded. */
export function trailDecisionFromEvent(ev: AnalyzeEvent): JobDecision | null {
  if (ev.type !== "highlight" || !ev.highlight) return null;
  return {
    seq: ev.seq,
    ts: ev.timestamp,
    eventType: ev.highlight.eventType ?? "highlight",
    decision: ev.highlight.outcome ?? ev.highlight.status,
    highlightId: ev.highlight.id,
  };
}
