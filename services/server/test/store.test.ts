import { describe, it, expect } from "vitest";
import { Store } from "../src/store";

describe("Store (in-memory)", () => {
  it("creates a queued job and patches status", async () => {
    const s = new Store();
    const j = await s.createJob({ source: "file", sourceUrl: "/tmp/v.mp4", gameHint: "valorant" });
    expect(j.status).toBe("queued");
    await s.patchJob(j.id, { status: "active" });
    expect(s.getJob(j.id)!.status).toBe("active");
  });

  it("adds + reviews highlights tied to a job", async () => {
    const s = new Store();
    const j = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    const h: any = {
      id: "h1",
      jobId: j.id,
      clipUri: "/clips/h1.mp4",
      start: 1,
      end: 5,
      status: "pending",
      score: 90,
      createdAt: new Date().toISOString(),
    };
    await s.addHighlight(h);
    expect(s.highlightsForJob(j.id)).toHaveLength(1);
    await s.reviewHighlight("h1", "accepted");
    expect(s.getHighlight("h1")!.status).toBe("accepted");
    expect(s.allHighlights()).toHaveLength(1);
  });
});
