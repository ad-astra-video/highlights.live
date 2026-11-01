// ADAAAA-7672: the collapsed-banner ASR summary.
//
// Contract: a window shows exactly one line of ASR when `analysis.asr.transcript`
// is a usable transcript, and NOTHING when it is empty or whisper filler — the
// client mirror of the decide-layer quality guard (ADAAAA-7665) so a silent
// window never advertises hallucinated "commentary".
import { describe, it, expect } from "vitest";
import {
  ASR_HALLUCINATION_SET,
  MIN_TRANSCRIPT_WORDS,
  asrSummary,
  asrSummaryLine,
  usableAsrTranscript,
} from "./windowAsr";
import type { WindowAnalysis } from "./jobDetail";

function windowWithAsr(transcript?: string, latencyS?: number, path: "asr_text" | "input_audio" | "none" = "asr_text"): WindowAnalysis {
  return {
    prompt: "",
    dataItems: [],
    frames: [],
    images: [],
    audio: { path },
    asr: { transcript, latencyS },
  };
}

describe("usableAsrTranscript (ADAAAA-7665 quality guard mirrored client-side)", () => {
  it("keeps a real commentary sentence verbatim", () => {
    expect(usableAsrTranscript("con un muy buen ambiente.")).toBe("con un muy buen ambiente.");
    expect(usableAsrTranscript("No, municipal de Corellán, empieza ya a rodar el balón.")).toBe(
      "No, municipal de Corellán, empieza ya a rodar el balón."
    );
  });

  it("treats every whisper silence hallucination as empty", () => {
    for (const filler of ["What?", "Go!", "Oh", "Bye.", "You", "Okay.", "And", "Thank you very much.", ". . . . . . ."]) {
      expect(usableAsrTranscript(filler), filler).toBe("");
    }
    // the guard set itself is the contract, not an ad-hoc list in the component
    expect(ASR_HALLUCINATION_SET.has("thank you very much")).toBe(true);
  });

  it("drops transcripts shorter than the minimum word count", () => {
    expect(MIN_TRANSCRIPT_WORDS).toBe(3);
    expect(usableAsrTranscript("Yes please")).toBe("");
    expect(usableAsrTranscript("よ")).toBe("");
    expect(usableAsrTranscript("a b c")).toBe("a b c");
  });

  it("drops one token repeated (filler, not commentary)", () => {
    expect(usableAsrTranscript("Yes, yes, yes, yes")).toBe("");
  });

  it("returns empty for blank / missing / punctuation-only input", () => {
    expect(usableAsrTranscript("")).toBe("");
    expect(usableAsrTranscript("   ")).toBe("");
    expect(usableAsrTranscript(undefined)).toBe("");
    expect(usableAsrTranscript(null)).toBe("");
    expect(usableAsrTranscript("？！ ...")).toBe("");
  });
});

describe("asrSummary (collapsed banner line)", () => {
  it("formats latency + quoted transcript exactly as the collapsed badge reads", () => {
    const summary = asrSummary(windowWithAsr("con un muy buen ambiente.", 0.76));
    expect(summary).toEqual({ timing: "ASR 0.76s", transcript: "con un muy buen ambiente." });
    expect(asrSummaryLine(windowWithAsr("con un muy buen ambiente.", 0.76))).toBe(
      'ASR 0.76s · "con un muy buen ambiente."'
    );
  });

  it("omits the timing when no latency was captured", () => {
    expect(asrSummary(windowWithAsr("gol de messi ahora mismo"))).toEqual({
      timing: "ASR",
      transcript: "gol de messi ahora mismo",
    });
  });

  it("renders nothing when the transcript is empty or unusable", () => {
    expect(asrSummary(windowWithAsr("", 0.76))).toBeNull();
    expect(asrSummary(windowWithAsr(undefined, 0.76))).toBeNull();
    expect(asrSummary(windowWithAsr("What?", 0.4))).toBeNull();
    expect(asrSummary(windowWithAsr("Thank you very much.", 2.96))).toBeNull();
  });

  it("renders nothing for a window whose audio channel is none", () => {
    expect(asrSummary(windowWithAsr("con un muy buen ambiente.", 0.76, "none"))).toBeNull();
  });

  it("renders nothing when the window has no analysis block at all (legacy)", () => {
    expect(asrSummary(undefined)).toBeNull();
    expect(asrSummaryLine(undefined)).toBeNull();
    expect(asrSummary({ prompt: "", dataItems: [], frames: [], images: [] })).toBeNull();
  });
});
