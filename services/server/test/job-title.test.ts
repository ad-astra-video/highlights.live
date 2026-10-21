import { describe, it, expect } from "vitest";
import { Store } from "../src/store";
import {
  applyJobTitle,
  fallbackJobTitle,
  requestJobTitle,
} from "../src/job-title";

describe("LLM job title (ADAAAA-6798 Inc 1)", () => {
  it("applies a deterministic fallback title when the decide service is unavailable", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await s.addHighlight({
      id: "h1", jobId: job.id, clipUri: "/c1.mp4", start: 1, end: 5,
      status: "accepted", score: 90, createdAt: new Date().toISOString(),
    } as any);
    // decideUrl unset => requestJobTitle short-circuits to null (decode down).
    await applyJobTitle(s, { decideUrl: undefined }, job.id);
    const titled = s.getJob(job.id)!;
    expect(typeof titled.title).toBe("string");
    expect(titled.title!.length).toBeGreaterThan(0);
    expect(titled.title).toMatch(/soccer · 1 highlight · \d{4}-\d{2}-\d{2}/);
    // GET /jobs path returns the title on the job record.
    expect(s.listJobsForOwner(undefined).map((j) => j.title)).toContain(titled.title);
  });

  it("makes exactly ONE /app/title call per completed job and uses the LLM title", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await s.addHighlight({
      id: "h1", jobId: job.id, clipUri: "/c1.mp4", start: 1, end: 5,
      status: "accepted", score: 90, reason: "a goal in the box", eventType: "GOAL",
      createdAt: new Date().toISOString(),
    } as any);
    const calls: any[] = [];
    const fetchImpl = (async (url: any, init: any) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ title: "Soccer — 3 goals, 1 near miss" }) };
    }) as any;
    await applyJobTitle(s, { decideUrl: "http://decide/" }, job.id, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://decide/app/title");
    expect(s.getJob(job.id)!.title).toBe("Soccer — 3 goals, 1 near miss");
  });

  it("does NOT re-call title when the job already has one (exactly one call total)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    await s.patchJob(job.id, { title: "already titled", status: "done" });
    const calls: any[] = [];
    const fetchImpl = (async () => {
      calls.push(1);
      return { ok: true, json: async () => ({ title: "X" }) };
    }) as any;
    await applyJobTitle(s, { decideUrl: "http://decide" }, job.id, fetchImpl);
    expect(calls).toHaveLength(0);
    expect(s.getJob(job.id)!.title).toBe("already titled");
  });

  it("requestJobTitle returns null on a non-2xx / unparseable decide response", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    const nonOk = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    expect(await requestJobTitle({ decideUrl: "http://decide" }, job, [], nonOk)).toBeNull();
    const badBody = (async () => ({ ok: true, json: async () => ({ foo: "bar" }) })) as any;
    expect(await requestJobTitle({ decideUrl: "http://decide" }, job, [], badBody)).toBeNull();
  });

  it("fallbackJobTitle uses source when no gameHint and counts non-rejected highlights", () => {
    const j = { source: "rtmp" } as any;
    const hl = [
      { status: "accepted" }, { status: "pending" }, { status: "rejected" }, { status: "accepted" },
    ] as any;
    expect(fallbackJobTitle(j, hl)).toMatch(/^rtmp · 3 highlights · \d{4}-\d{2}-\d{2}$/);
    expect(fallbackJobTitle({} as any, [])).toMatch(/^Highlight reel · 0 highlights · /);
  });
});
