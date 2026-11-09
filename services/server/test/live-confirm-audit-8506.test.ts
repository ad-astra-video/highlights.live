// ADAAAA-8506 (AC2/AC6): the LIVE async dive must leave a Stage-2
// `decide_audit` row, not just a log line.
//
// Measured on the first armed live job `7d99d651`: the server logged
// "dive for goal @104.6s ... verdict=confirmed_goal corroborated=true" three
// times while `decide_audit` held 0 rows with a non-null `timestamp` and no
// `gNNN:confirm` group key. The inline `confirmReconcile` path emitted the
// descriptor; the async lane (`confirmDiveIoFor`) called `client.confirm` bare.
// A dive with no row cannot be graded (AC2) or costed (AC6).
import { describe, it, expect, vi } from "vitest";
import { confirmAuditDescriptor, decideGroupKey } from "../src/analyzer";
import { runConfirmDiveCall } from "../src/live-confirm-async";

const frames = [
  { role: "pre", base64: Buffer.from("pre-frame").toString("base64") },
  { role: "event", base64: Buffer.from("event-frame").toString("base64") },
  { role: "post", base64: Buffer.from("post-frame").toString("base64") },
];

const verdict = {
  goalConfirmed: "confirmed_goal" as const,
  corroborated: true,
  corroborationSource: "frame_attestation",
  scoreboardDelta: null,
  stage1Disagreed: false,
  reason: "ball in the net",
  analysis: { request: { prompt: "PROMPT-8506" }, response: {} },
};

function descriptorFor(jobId: string) {
  return (input: any) => confirmAuditDescriptor({ jobId }, input);
}

describe("async live dive emits the Stage-2 decide-audit row (ADAAAA-8506)", () => {
  it("emits a gNNN:confirm descriptor with the dive's own timestamp, frames and meter", async () => {
    let emitted: Record<string, any> | null = null;
    const out = await runConfirmDiveCall({
      jobId: "job-8506",
      req: { timestamp: 104.597, frames },
      confirm: async () => verdict,
      emit: (d) => {
        emitted = d as Record<string, any>;
      },
      buildDescriptor: descriptorFor("job-8506"),
      log: () => {},
    });

    // The verdict the pump adopts is untouched by the audit write.
    expect(out).toBe(verdict);
    expect(emitted).not.toBeNull();
    expect(emitted!.jobId).toBe("job-8506");
    expect(emitted!.groupKey).toBe(`${decideGroupKey(104.597)}:confirm`);
    expect(emitted!.timestamp).toBe(104.597);
    expect(emitted!.frameCount).toBe(3);
    expect(emitted!.candidateCount).toBe(1);
    expect(emitted!.verdicts).toMatchObject({
      runConfirmationPass: true,
      goalConfirmed: "confirmed_goal",
      corroborated: true,
      corroborationSource: "frame_attestation",
    });
    // Cost accounting (AC6) and replayability both ride the descriptor.
    expect(typeof emitted!.timings.elapsedMs).toBe("number");
    expect(emitted!.timings.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(emitted!.promptText).toBe("PROMPT-8506");
    expect(emitted!.mediaHashes.length).toBe(3);
  });

  it("measures the elapsed time around the paid call, not around the audit write", async () => {
    let emitted: Record<string, any> | null = null;
    await runConfirmDiveCall({
      req: { timestamp: 12, frames: [] },
      confirm: async () => {
        await new Promise((r) => setTimeout(r, 15));
        return verdict;
      },
      emit: (d) => {
        emitted = d as Record<string, any>;
      },
      buildDescriptor: descriptorFor("job-timing"),
      log: () => {},
    });
    expect(emitted!.timings.elapsedMs).toBeGreaterThanOrEqual(10);
  });

  it("a failing audit sink can only log — the verdict and the dive still land", async () => {
    const logged: string[] = [];
    const out = await runConfirmDiveCall({
      jobId: "job-broken-sink",
      req: { timestamp: 5, frames },
      confirm: async () => verdict,
      emit: () => {
        throw new Error("db down");
      },
      buildDescriptor: descriptorFor("job-broken-sink"),
      log: (line) => logged.push(line),
    });
    expect(out).toBe(verdict);
    expect(logged.join("\n")).toContain("ingest failed");
    expect(logged.join("\n")).toContain("db down");
  });

  it("a failed /confirm call emits nothing (fail closed, no fabricated row)", async () => {
    const emit = vi.fn();
    await expect(
      runConfirmDiveCall({
        jobId: "job-transport",
        req: { timestamp: 5, frames },
        confirm: async () => {
          throw new Error("timed out");
        },
        emit,
        buildDescriptor: descriptorFor("job-transport"),
        log: () => {},
      })
    ).rejects.toThrow(/timed out/);
    expect(emit).not.toHaveBeenCalled();
  });

  it("a non-Goal verdict (refutation) is still recorded with its stored reason", async () => {
    let emitted: Record<string, any> | null = null;
    await runConfirmDiveCall({
      req: { timestamp: 30, frames },
      confirm: async () => ({ ...verdict, goalConfirmed: "near_miss", corroborated: false, reason: "no ball in net" }),
      emit: (d) => {
        emitted = d as Record<string, any>;
      },
      buildDescriptor: descriptorFor("job-refute"),
      log: () => {},
    });
    expect(emitted!.verdicts.goalConfirmed).toBe("near_miss");
    expect(emitted!.rawReply).toBe("no ball in net");
  });
});
