import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db";
import { Store } from "../src/store";
import type { AnalysisEvent, AnalysisSessionTrace } from "@highlights/events";

describe("analysis-events + analysis-session-trace persistence (ADAAAA-6738 G1)", () => {
  const mkEvent = (jobId: string, ts: number, kind: AnalysisEvent["kind"]): AnalysisEvent => ({
    id: `${jobId}-e-${ts}`,
    jobId,
    streamId: "stream-1",
    sessionId: "sess-1",
    timestamp: ts,
    kind,
    data: { level: ts },
  });

  const mkTrace = (jobId: string, at: number): AnalysisSessionTrace => ({
    id: `${jobId}-t-${at}`,
    jobId,
    sessionId: "sess-1",
    at,
    tool: "get_audio_levels",
    window: { start: at, end: at + 3 },
    request: { tool: "get_audio_levels" },
    response: { level: 0.5 },
  });

  it("round-trips analysis events and traces on a fresh SQLite Db (baseline schema)", async () => {
    const db = new SqliteDb(":memory:");
    await db.appendAnalysisEvent(mkEvent("job-1", 1, "audio_energy"));
    await db.appendAnalysisEvent(mkEvent("job-1", 2, "tracked_objects"));

    const events = await db.listAnalysisEvents("job-1");
    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBe(1);
    expect(events[1].kind).toBe("tracked_objects");
    // No cross-job leakage.
    expect(await db.listAnalysisEvents("job-2")).toHaveLength(0);

    await db.appendAnalysisTrace(mkTrace("job-1", 1000));
    const traces = await db.listAnalysisTraces("job-1");
    expect(traces).toHaveLength(1);
    expect(traces[0].tool).toBe("get_audio_levels");
    expect(traces[0].request).toEqual({ tool: "get_audio_levels" });

    await db.close();
  });

  it("caps list results at the requested limit and honours purge", async () => {
    const db = new SqliteDb(":memory:");
    for (let i = 0; i < 5; i++) await db.appendAnalysisEvent(mkEvent("job-1", i, "audio_energy"));
    expect(await db.listAnalysisEvents("job-1", 3)).toHaveLength(3);
    expect(await db.listAnalysisEvents("job-1")).toHaveLength(5);

    // Purge everything before a recent cutoff removes the rows.
    await db.purgeAnalysisBefore(new Date(Date.now() + 60_000).toISOString());
    expect(await db.listAnalysisEvents("job-1")).toHaveLength(0);
    await db.close();
  });

  it("store write-throughs to the Db and reads back", async () => {
    const db = new SqliteDb(":memory:");
    const store = new Store(db);
    await store.persistAnalysisEvents([mkEvent("job-1", 1, "audio_energy"), mkEvent("job-1", 2, "detection")]);
    expect(await store.listAnalysisEvents("job-1")).toHaveLength(2);
    await store.appendAnalysisTrace(mkTrace("job-1", 1000));
    expect(await store.listAnalysisTraces("job-1")).toHaveLength(1);
    // A null-Db store is a safe no-op for writes/reads.
    const memStore = new Store(null);
    await memStore.persistAnalysisEvents([mkEvent("job-1", 3, "caption")]);
    expect(await memStore.listAnalysisEvents("job-1")).toHaveLength(0);
    await db.close();
  });
});
