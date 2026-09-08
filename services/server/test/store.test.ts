import { describe, it, expect } from "vitest";
import { Store } from "../src/store";

describe("Store", () => {
  it("creates a queued job and patches status", () => {
    const s = new Store();
    const j = s.createJob({ source: "file", sourceUrl: "/tmp/v.mp4", gameHint: "valorant" });
    expect(j.status).toBe("queued");
    s.patchJob(j.id, { status: "active" });
    expect(s.getJob(j.id)!.status).toBe("active");
  });

  it("adds + reviews highlights tied to a job", () => {
    const s = new Store();
    const j = s.createJob({ source: "file", sourceUrl: "/v.mp4" });
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
    s.addHighlight(h);
    expect(s.highlightsForJob(j.id)).toHaveLength(1);
    s.reviewHighlight("h1", "accepted");
    expect(s.getHighlight("h1")!.status).toBe("accepted");
    expect(s.allHighlights()).toHaveLength(1);
  });
});
