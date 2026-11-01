// ADAAAA-7672: the one-line ASR summary shown on a COLLAPSED decide-note banner.
//
// The per-window ASR transcript already ships in the payload
// (`analysis.asr.transcript` / `.latencyS`) and already renders — but only inside
// the expanded "Inspect window" panel (`AudioAsrBlock`). On the collapsed banner,
// which is the state an operator scans a job in, a reviewed window showed no ASR
// text at all, so a window the decide LLM handed real commentary to looked
// audio-less at a glance.
//
// This module is the single client-side place the "is this a usable
// transcript?" rule lives. It mirrors the decide-layer quality guard
// (services/decide/app/gemma.py::usable_transcript, ADAAAA-7665) so the badge
// can never advertise whisper's canonical silence hallucinations ("What?",
// "Thank you very much.", "Yes, yes, yes") as commentary, and stays silent for a
// window whose stored audio channel is `none` — matching the honest silent-window
// state the expanded block renders as "No audio captured" (ADAAAA-7248/7277).
import type { WindowAnalysis } from "./jobDetail";

/** Mirrors decide's MIN_TRANSCRIPT_WORDS (ADAAAA-7665). */
export const MIN_TRANSCRIPT_WORDS = 3;

/** Mirrors decide's ASR_HALLUCINATION_SET: the stock phrases whisper emits when
 *  it transcribes silence or a sub-second fragment. */
export const ASR_HALLUCINATION_SET = new Set([
  "",
  "what",
  "go",
  "oh",
  "bye",
  "you",
  "and",
  "okay",
  "ok",
  "yes",
  "no",
  "hmm",
  "mm",
  "ah",
  "uh",
  "thanks",
  "thank you",
  "thank you very much",
  "you know",
  "bye bye",
  "yes yes yes",
  "no no no",
  "please subscribe",
]);

/** Lowercase + strip punctuation + collapse whitespace, the same normalization
 *  decide applies before judging a transcript ("What?" -> "what"). */
function normalizeAsrText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return `transcript` when it reads like real commentary, else `""`.
 *
 * Usable means: not blank, not punctuation-only, at least
 * {@link MIN_TRANSCRIPT_WORDS} words, not one token repeated, and not one of
 * whisper's silence hallucinations. This is the client mirror of
 * `usable_transcript()` in the decide service; keep the two in sync.
 */
export function usableAsrTranscript(transcript?: string | null): string {
  const text = (transcript ?? "").trim();
  if (!text) return "";
  const normalized = normalizeAsrText(text);
  if (!normalized) return "";
  if (ASR_HALLUCINATION_SET.has(normalized)) return "";
  const words = normalized.split(" ");
  if (words.length < MIN_TRANSCRIPT_WORDS) return "";
  // "Yes, yes, yes, yes" — one token repeated is filler, not commentary.
  if (new Set(words).size === 1) return "";
  return text;
}

export interface AsrSummary {
  /** e.g. `ASR 0.76s` (or plain `ASR` when no latency was captured). */
  timing: string;
  /** The usable transcript, unquoted. */
  transcript: string;
}

/**
 * The collapsed-banner ASR summary for a window, or `null` when the window must
 * stay silent (no analysis, no usable transcript, or `audio.path = "none"`).
 */
export function asrSummary(analysis?: WindowAnalysis): AsrSummary | null {
  if (!analysis) return null;
  // A window the decide layer recorded as having no captured audio must stay
  // silent — the same rule the expanded block applies for its "No audio
  // captured" badge (ADAAAA-7248/7277).
  if (analysis.audio?.path === "none") return null;
  const transcript = usableAsrTranscript(analysis.asr?.transcript);
  if (!transcript) return null;
  const latency = analysis.asr?.latencyS;
  const timing =
    typeof latency === "number" && Number.isFinite(latency) ? `ASR ${latency.toFixed(2)}s` : "ASR";
  return { timing, transcript };
}

/** The summary as one line, e.g. `ASR 0.76s · "con un muy buen ambiente."`. */
export function asrSummaryLine(analysis?: WindowAnalysis): string | null {
  const summary = asrSummary(analysis);
  if (!summary) return null;
  return `${summary.timing} · "${summary.transcript}"`;
}
