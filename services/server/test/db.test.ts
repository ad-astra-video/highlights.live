import { describe, expect, it } from "vitest";
import { SqliteDb, type MediaSession } from "../src/db";

describe("media_sessions persistence (SqliteDb)", () => {
  it("round-trips and upserts media sessions by jobId", async () => {
    const db = new SqliteDb(":memory:");
    const now = new Date().toISOString();
    const ms: MediaSession = {
      jobId: "job-1",
      sessionId: "sess-1",
      streamId: "stream-1",
      wsUrl: "wss://media.example.com/stream/sess-1",
      mediaOrigin: "https://media.example.com",
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    expect(await db.getMediaSession("job-1")).toBeUndefined();

    await db.setMediaSession(ms);
    const got = await db.getMediaSession("job-1");
    expect(got).toEqual(ms);
    expect(got!.status).toBe("active");

    // Upsert replaces the session (e.g. a reroute re-provisions a fresh one).
    await db.setMediaSession({ ...ms, sessionId: "sess-2", wsUrl: "wss://media.example.com/stream/sess-2" });
    expect((await db.getMediaSession("job-1"))!.sessionId).toBe("sess-2");

    await db.clearMediaSession("job-1");
    expect(await db.getMediaSession("job-1")).toBeUndefined();

    await db.close();
  });
});
