// ADAAAA-8776: a browser share can open its media session ON THE MEDIA NODE
// instead of through `POST /jobs/:id/media`.
//
// Measured on job `4cd84e86`: media-node session `16ee75dc` published 624 frames
// while `media_sessions` held 0 rows for the job, so `bj.mediaSessionId` stayed
// undefined, `liveMatchContextSession(bj, job)` resolved "" and the ADAAAA-8736
// fold logged "no perceive session at 0s/60s/120s — fold skipped" three times.
// `record.matchContext` stayed NULL and rev-4 had no attested team to name.
//
// These tests pin the adoption path that closes the hole:
//   - first sighting of a session id on a node callback binds the rail;
//   - a bound rail never moves (provisioned precedence, stale callbacks);
//   - the `media_sessions` row is registered once, never overwriting, and is
//     settled by the job's terminal transition;
//   - the route that sees the session first (`/jobs/:id/media/frames`) writes it;
//   - the match-context fold then posts at that session instead of "".
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

import {
  registerAdoptedMediaSession,
  shouldAdoptMediaSession,
} from "../src/media-session-adopt";
import type { MediaSession } from "../src/db";
import { createLiveMatchContextWriter, liveMatchContextSession, type MatchContext } from "../src/match-context";

const team = (name: string): MatchContext["teams"][number] => ({
  name,
  side: "home",
  kitColors: [],
  confidence: 0.8,
  evidence: [{ source: "scorebug_ocr", snippet: `${name} 1-0` }],
});

function memoryStore(seed?: MediaSession) {
  const rows = new Map<string, MediaSession>();
  if (seed) rows.set(seed.jobId, seed);
  return {
    rows,
    async getMediaSession(jobId: string) {
      return rows.get(jobId);
    },
    async setMediaSession(ms: MediaSession) {
      rows.set(ms.jobId, ms);
    },
  };
}

/** A media node that answers `GET /health` the way the real one does. */
async function fakeMediaNode(nodeId = "x99-media") {
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", node: { id: nodeId } }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("shouldAdoptMediaSession (ADAAAA-8776)", () => {
  it("adopts the node's session id when the rail holds none", () => {
    expect(shouldAdoptMediaSession(undefined, "16ee75dc-aaaa")).toBe(true);
    expect(shouldAdoptMediaSession("", "16ee75dc-aaaa")).toBe(true);
    expect(shouldAdoptMediaSession("  ", " 16ee75dc-aaaa ")).toBe(true);
  });

  it("never moves an already-bound rail — provisioned precedence and stale callbacks", () => {
    expect(shouldAdoptMediaSession("provisioned-1", "provisioned-1")).toBe(false);
    expect(shouldAdoptMediaSession("provisioned-1", "older-session")).toBe(false);
  });

  it("ignores a callback that names no session", () => {
    expect(shouldAdoptMediaSession(undefined, "")).toBe(false);
    expect(shouldAdoptMediaSession(undefined, undefined)).toBe(false);
    expect(shouldAdoptMediaSession(undefined, "   ")).toBe(false);
  });
});

describe("registerAdoptedMediaSession (ADAAAA-8776)", () => {
  it("registers the node's own session id, active, with the node identity", async () => {
    const node = await fakeMediaNode("x99-media");
    try {
      const store = memoryStore();
      const row = await registerAdoptedMediaSession({
        db: store,
        mediaServerUrl: node.origin,
        jobId: "job-adopt-1",
        sessionId: " 16ee75dc-1111 ",
      });
      expect(row).toBeTruthy();
      expect(row!.sessionId).toBe("16ee75dc-1111");
      expect(row!.status).toBe("active");
      expect(row!.nodeId).toBe("x99-media");
      expect(row!.mediaOrigin).toBe(node.origin);
      // No browser endpoint is known from a callback: the row must NOT be
      // reusable for a reconnect, and `provisionMedia` refuses a row without one.
      expect(row!.wsUrl).toBe("");
      expect(store.rows.get("job-adopt-1")).toEqual(row);
    } finally {
      await node.close();
    }
  });

  it("leaves a provisioned row untouched (first writer wins)", async () => {
    const at = "2026-11-12T05:00:00.000Z";
    const provisioned: MediaSession = {
      jobId: "job-adopt-2",
      sessionId: "provisioned-7777",
      streamId: "job-adopt-2",
      wsUrl: "wss://media.test/stream/provisioned-7777",
      mediaOrigin: "http://media:4070",
      nodeId: "media-0",
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    const store = memoryStore(provisioned);
    const row = await registerAdoptedMediaSession({
      db: store,
      mediaServerUrl: "http://127.0.0.1:1", // unreachable: must never be needed
      jobId: "job-adopt-2",
      sessionId: "some-later-session",
    });
    expect(row).toEqual(provisioned);
    expect(store.rows.get("job-adopt-2")).toEqual(provisioned);
  });

  it("still records the session when the media node does not answer /health", async () => {
    const store = memoryStore();
    const row = await registerAdoptedMediaSession({
      db: store,
      mediaServerUrl: "http://127.0.0.1:1", // nothing listening
      jobId: "job-adopt-3",
      sessionId: "16ee75dc-3333",
    });
    expect(row).toBeTruthy();
    expect(row!.sessionId).toBe("16ee75dc-3333");
    // Honest non-attribution: never invent a node id.
    expect(row!.nodeId).toBeNull();
    expect(row!.status).toBe("active");
  });

  it("is a no-op for a blank session id", async () => {
    const store = memoryStore();
    expect(
      await registerAdoptedMediaSession({ db: store, jobId: "job-adopt-4", sessionId: "  " })
    ).toBeNull();
    expect(store.rows.size).toBe(0);
  });
});

describe("the fold resolves the adopted session (ADAAAA-8776)", () => {
  it("a share-shaped rail (mediaSessionId only) posts the fold at that session, never ''", async () => {
    // The exact field shape `provisionMedia` never captured for job 4cd84e86:
    // no `sessionId` (that is the WS `/ingest` rail), no record
    // `perceiveSessionId` (browser records persist none) — only the media node's
    // session id, which the adoption path binds.
    const bj: { sessionId?: string; mediaSessionId?: string } = { mediaSessionId: "16ee75dc-1111" };
    expect(liveMatchContextSession(bj, {})).toBe("16ee75dc-1111");

    const posted: Array<{ sessionId: string; body: any }> = [];
    const logs: string[] = [];
    const writer = createLiveMatchContextWriter({
      jobId: "job-adopt-5",
      client: {
        postMatchContext: async (sessionId: string, body: any) => {
          posted.push({ sessionId, body });
          return { matchContext: { sport: "soccer", teams: [team("RMA")], inferredAt: "2026-11-12T00:00:00.000Z", resolverVersion: 1, ambiguous: false, trail: [] } };
        },
      } as any,
      getSessionId: () => liveMatchContextSession(bj, {}),
      hints: { gameHint: "soccer" },
      getJob: () => ({ matchContext: undefined }) as any,
      patchJob: async () => ({}) as any,
      log: (line: string) => logs.push(line),
    });
    writer.noteWindow({ centerTs: 0, transcript: "kick off" });
    await writer.finish();

    expect(posted).toHaveLength(1);
    expect(posted[0].sessionId).toBe("16ee75dc-1111");
    expect(logs.join("\n")).not.toContain("no perceive session");
  });

  it("keeps the ADAAAA-8736 skip line when no session was adopted", async () => {
    const logs: string[] = [];
    const writer = createLiveMatchContextWriter({
      jobId: "job-adopt-6",
      client: { postMatchContext: async () => null } as any,
      getSessionId: () => liveMatchContextSession({}, {}),
      hints: {},
      getJob: () => undefined,
      patchJob: async () => ({}) as any,
      log: (line: string) => logs.push(line),
    });
    writer.noteWindow({ centerTs: 0, transcript: "" });
    await writer.finish();
    expect(logs.join("\n")).toContain("no perceive session at 0s — fold skipped");
  });
});
