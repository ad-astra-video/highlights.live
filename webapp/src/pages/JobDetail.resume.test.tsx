import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { ResumeAction, ResumeTrail, type ResumeActionState } from "../components/ResumeTrail";
import { FailureReasonChip } from "./JobDetail";
import { canResume, readResume, resumePointLabel, resumeTrailText } from "../lib/resume";
import { failureReasonLabel } from "../lib/failureReason";

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers. */
const text = (html: string) => html.replace(/<!--\s*-->/g, "");

// ADAAAA-7907 AC8: a FAILED job on /app/jobs/:id shows the attributed reason AND
// a Resume action, and a resumed job shows the resume point and the attempt
// number. These tests pin the wording and the states without driving the page.

/** A checkpoint as the owner's route returns it (accumulators projected away). */
const RESUMED = {
  version: 1 as const,
  phase: "analyze" as const,
  analyze: { cursorTs: 900 },
  attempts: [
    { attempt: 1, startedAt: "2026-11-03T00:00:00Z", endedAt: "2026-11-03T00:02:00Z", failedAtPhase: "analyze", failureReason: "decide-unavailable" },
    { attempt: 2, startedAt: "2026-11-03T00:03:00Z" },
  ],
  totalAttempts: 2,
  maxAttempts: 3,
  resumedFromTs: 750,
};

const FAILED_JOB = {
  source: "file",
  status: "failed",
  failureReason: "decide-unavailable",
  resume: RESUMED,
};

describe("resume reading (ADAAAA-7907 AC8)", () => {
  it("formats the resume point as T+mm:ss (and T+h:mm:ss past an hour)", () => {
    expect(resumePointLabel(0)).toBeNull();
    expect(resumePointLabel(750)).toBe("T+12:30");
    expect(resumePointLabel(3930)).toBe("T+1:05:30");
  });

  it("renders 'resumed from <point> · attempt N of M' for a retried job", () => {
    expect(resumeTrailText(RESUMED)).toBe("Resumed from T+12:30 · attempt 2 of 3");
    const reading = readResume(RESUMED)!;
    expect(reading.resumed).toBe(true);
    expect(reading.point).toBe("T+12:30");
    expect(reading.attempt).toBe("attempt 2 of 3");
    expect(reading.retryArmed).toBe(false);
  });

  it("says the retry is scheduled while one is armed", () => {
    const armed = { ...RESUMED, nextAttemptAt: "2030-01-01T00:00:00.000Z" };
    expect(resumeTrailText(armed)).toContain("retry scheduled");
    expect(readResume(armed)!.retryArmed).toBe(true);
  });

  it("does not claim a resume for a first pass, and renders nothing without a checkpoint", () => {
    // Every VOD job writes a checkpoint from its first claim; only a retried one
    // has a resume point. A live cursor must never be read as a resume point.
    const firstPass = {
      version: 1 as const,
      phase: "analyze" as const,
      analyze: { cursorTs: 900 },
      attempts: [{ attempt: 1, startedAt: "t0" }],
      totalAttempts: 1,
    };
    expect(resumeTrailText(firstPass)).toBeNull();
    expect(readResume(firstPass)!.resumed).toBe(false);
    expect(resumeTrailText(undefined)).toBeNull();
    expect(readResume(null)).toBeNull();
  });

  it("drops the maximum when the record predates it (attempt number only)", () => {
    expect(resumeTrailText({ ...RESUMED, maxAttempts: undefined })).toBe("Resumed from T+12:30 · attempt 2");
  });
});

describe("ResumeTrail / ResumeAction rendering (ADAAAA-7907 AC8)", () => {
  it("renders the trail line with the point and the attempt number", () => {
    const html = renderToString(<ResumeTrail resume={RESUMED} />);
    expect(text(html)).toContain("Resumed from T+12:30");
    expect(text(html)).toContain("attempt 2 of 3");
    expect(html).toContain('data-detail-resume-point="T+12:30"');
    expect(html).toContain('data-detail-resume-attempt="attempt 2 of 3"');
  });

  it("renders nothing on a job that never resumed", () => {
    expect(renderToString(<ResumeTrail resume={undefined} />)).toBe("");
    expect(
      renderToString(
        <ResumeTrail resume={{ version: 1, phase: "analyze", attempts: [], totalAttempts: 1, analyze: { cursorTs: 40 } }} />,
      ),
    ).toBe("");
  });

  it("offers Resume on the failed state of a VOD job with a checkpoint", () => {
    const idle: ResumeActionState = { kind: "idle" };
    const html = renderToString(<ResumeAction job={FAILED_JOB} state={idle} onResume={() => {}} />);
    expect(text(html)).toContain("Resume");
    expect(html).toContain("data-detail-resume-button");
    expect(html).not.toContain("disabled");
  });

  it("does not offer Resume where the server would refuse (done / no checkpoint / live source)", () => {
    const idle: ResumeActionState = { kind: "idle" };
    expect(renderToString(<ResumeAction job={{ ...FAILED_JOB, status: "done" }} state={idle} onResume={() => {}} />)).toBe("");
    expect(renderToString(<ResumeAction job={{ ...FAILED_JOB, resume: undefined }} state={idle} onResume={() => {}} />)).toBe("");
    expect(renderToString(<ResumeAction job={{ ...FAILED_JOB, source: "browser" }} state={idle} onResume={() => {}} />)).toBe("");
    expect(canResume(FAILED_JOB)).toBe(true);
    expect(canResume({ ...FAILED_JOB, status: "done" })).toBe(false);
  });

  it("reports the queued and error states instead of a silent click", () => {
    const queued = renderToString(<ResumeAction job={FAILED_JOB} state={{ kind: "queued" }} onResume={() => {}} />);
    expect(text(queued)).toContain("Resume queued");
    expect(text(queued)).toContain("resumes from the last completed point");
    const failed = renderToString(
      <ResumeAction job={FAILED_JOB} state={{ kind: "error", message: "job is done; nothing to resume" }} onResume={() => {}} />,
    );
    expect(text(failed)).toContain("job is done; nothing to resume");
    expect(failed).toContain("data-detail-resume-error");
  });

  it("shows the attributed failure reason on the SAME failed state as the Resume action", () => {
    // AC8 grades the pair, not the button alone: the chip must name the reason
    // the resume path classified (a raw slug would be unreadable).
    expect(failureReasonLabel("decide-unavailable")).toBe("decide service unavailable");
    expect(failureReasonLabel("perceive-session-lost")).toBe("perceive session lost");
    expect(failureReasonLabel("capacity-exhausted")).toBe("GPU capacity exhausted");
    const chip = renderToString(<FailureReasonChip reason={FAILED_JOB.failureReason} />);
    expect(text(chip)).toContain("decide service unavailable");
    expect(chip).toContain('data-detail-failure-reason="decide-unavailable"');
  });
});
