// ADAAAA-8544 item 7 (spec rev 3 §7 on ADAAAA-8527): the customer-facing decide
// knob — the pure state -> request mapping for the LIVE start form.
//
// The form holds three pieces of local state (source, cadenceSec, rateCapInput)
// and three things follow from them: whether the control renders at all (live
// sources only), the POST /jobs body fields, and the printed estimate. All three
// are pure functions of that state, so they live here and are pinned by
// decideKnob.test.ts instead of being re-derived inline in the page — the page
// keeps only the markup and the setState calls.
//
// The numbers, the labels and the floor all come from `@highlights/events`
// (`decide-knob.ts`): the control must print the SAME strings the server stamps
// and the window audit grades, so nothing here retypes a label, a price or the
// 63 floor (ADAAAA-8427).
import {
  DECIDE_CADENCE_DEFAULT,
  DECIDE_RATE_FLOOR_PER_300S,
  decideCadenceLabel,
  decideEstimateLabel,
  decideRailForSource,
  formatUsdPerHour,
  isDecideCadence,
  type DecideCadenceSec,
} from "@highlights/events";

/** The label on the spend-cap toggle that clears a cap (`rateCapPer300s: null`). */
export const DECIDE_KNOB_UNCAPPED_LABEL = "Uncapped";

/** The resolved knob POST /jobs receives: the two fields, nothing else. */
export type DecideKnobSubmission =
  | { cadenceSec: DecideCadenceSec; rateCapPer300s: number | null }
  | { error: string };

/**
 * Which sources start a LIVE job and therefore own a decide knob. Mirrors the
 * page's `isLive = source !== "file"`: screen / browser / RTMP / file-sim run
 * the live observer (and pay per decide); a VOD upload runs the offline
 * pipeline, where the knob has no meaning and must NOT be sent.
 */
export function isDecideKnobLiveSource(source: string | undefined | null): boolean {
  return (source ?? "file") !== "file";
}

/**
 * Parse the spend-cap text input.
 *
 * Blank means "Uncapped" (the default, `rateCapPer300s: null`). Anything else
 * must be a WHOLE number of charged decides per 5 minutes of content and must
 * clear the coverage floor ratified in ADAAAA-8427 — below it the job would
 * skip windows the coverage pass requires, so the client refuses it here with
 * the same floor the server's 422 (`decide_rate_below_coverage_floor`) states,
 * rather than letting the user find out after the job has started spending.
 */
export function parseRateCapInput(
  raw: string | null | undefined
): { ok: true; rateCapPer300s: number | null } | { ok: false; error: string } {
  const text = (raw ?? "").trim();
  if (text === "") return { ok: true, rateCapPer300s: null };
  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      error:
        `Spend cap must be a whole number of decides per 5 minutes, or blank for ${DECIDE_KNOB_UNCAPPED_LABEL} ` +
        `(got “${text}”).`,
    };
  }
  const cap = Number(text);
  if (!Number.isSafeInteger(cap) || cap <= 0) {
    return { ok: false, error: `Spend cap must be a positive whole number, or blank for ${DECIDE_KNOB_UNCAPPED_LABEL}.` };
  }
  if (cap < DECIDE_RATE_FLOOR_PER_300S) {
    return {
      ok: false,
      error:
        `Spend cap must be at least ${DECIDE_RATE_FLOOR_PER_300S} decides per 5 minutes — ` +
        `${DECIDE_RATE_FLOOR_PER_300S} is the coverage floor (ADAAAA-8427), and a cap under it would ` +
        `skip windows the coverage pass requires.`,
    };
  }
  return { ok: true, rateCapPer300s: cap };
}

/**
 * The knob as submitted. Cadence 5 is the shipped default (CEO ruling, spec rev
 * 3 §7); 3 stays user-selectable. The picker only ever produces one of the two
 * offered values, so anything else resolves to the default rather than inventing
 * a third posture — the route still rejects a hand-crafted value with
 * `decide_cadence_invalid`.
 */
export function buildDecideKnobSubmission(input: {
  source: string;
  cadenceSec: number;
  rateCapInput: string;
}): DecideKnobSubmission {
  const cadenceSec: DecideCadenceSec = isDecideCadence(input.cadenceSec)
    ? (Number(input.cadenceSec) as DecideCadenceSec)
    : DECIDE_CADENCE_DEFAULT;
  const parsed = parseRateCapInput(input.rateCapInput);
  if (!parsed.ok) return { error: parsed.error };
  return { cadenceSec, rateCapPer300s: parsed.rateCapPer300s };
}

/**
 * The body fields to merge into `POST /jobs`.
 *
 * LIVE sources only: a VOD upload keeps the exact body it sends today, and a
 * refused knob sends nothing (the caller must surface `error` and not start the
 * job). Returning an empty object keeps the call site a plain spread.
 */
export function decideKnobRequestBody(input: {
  source: string;
  submission: DecideKnobSubmission;
}): { cadenceSec?: DecideCadenceSec; rateCapPer300s?: number | null } {
  if (!isDecideKnobLiveSource(input.source)) return {};
  if ("error" in input.submission) return {};
  return {
    cadenceSec: input.submission.cadenceSec,
    rateCapPer300s: input.submission.rateCapPer300s,
  };
}

/**
 * The estimate line printed beside the picker: the cents-rounded POINT beside
 * its measured band, e.g. `approx $2.00/h (measured band $1.86/h-$2.16/h)`.
 *
 * `decideEstimateLabel` always carries the band, so the control can never print
 * a bare point (spec §2: the browser rail varies ~16 % stream to stream). A
 * refused cap is priced as uncapped — the estimate never shows a price for a
 * posture the job cannot run in; the refusal itself renders as an error.
 */
export function decideKnobEstimateLabel(input: {
  source: string;
  cadenceSec: number;
  rateCapInput: string;
}): string {
  const parsed = parseRateCapInput(input.rateCapInput);
  return decideEstimateLabel({
    cadenceSec: input.cadenceSec,
    rateCapPer300s: parsed.ok ? parsed.rateCapPer300s : null,
    rail: decideRailForSource(input.source),
  });
}

/**
 * The visible option labels for the cadence picker, straight from the shipped
 * copy. The 5 s entry carries the latency trade in its OWN label (never a
 * tooltip) — spec §1: "a setting that trades latency for cost must carry the
 * trade in its label".
 */
export function decideKnobCadenceOptions(): Array<{ cadenceSec: DecideCadenceSec; label: string }> {
  return [3, 5].map((cadenceSec) => ({
    cadenceSec: cadenceSec as DecideCadenceSec,
    label: decideCadenceLabel(cadenceSec),
  }));
}

/**
 * The readout for a job that is ALREADY running (the monitor side of item 7):
 * the frozen stamp, not a re-estimate. `decideKnob` on the record is written once
 * at start, so the page states what the job actually runs (`resolvedSource`
 * included — `env` means the row predates the knob) instead of guessing from the
 * current form state.
 *
 * Format: `5 s cadence · uncapped · approx $2.01/h (measured band $1.86/h-$2.16/h) · est-v2`
 */
export function decideKnobReadout(stamp: {
  cadenceSec: number;
  rateCapPer300s: number | null;
  predictedUsdPerHour: number;
  predictedBandUsdPerHour: [number, number];
  estimateVersion: string;
  resolvedSource?: string;
}): string {
  const cap =
    stamp.rateCapPer300s === null || stamp.rateCapPer300s === undefined
      ? DECIDE_KNOB_UNCAPPED_LABEL.toLowerCase()
      : `cap ${stamp.rateCapPer300s} decides / 5 min`;
  const point = formatUsdPerHour(stamp.predictedUsdPerHour);
  const band = `${formatUsdPerHour(stamp.predictedBandUsdPerHour[0])}-${formatUsdPerHour(
    stamp.predictedBandUsdPerHour[1]
  )}`;
  const origin = stamp.resolvedSource === "env" ? " · deploy-time default" : "";
  return `${stamp.cadenceSec} s cadence · ${cap} · approx ${point} (measured band ${band}) · ${stamp.estimateVersion}${origin}`;
}
