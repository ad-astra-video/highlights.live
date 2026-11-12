// ADAAAA-8736: the browser rail's match-context fold posted at session "".
//
// Measured on the served build (`3aab6111…`, container 2026-11-12T03:01:13Z):
// 0/11 `browser` jobs carried a `matchContext` while 10/18 `rtmp` jobs carried
// one on the SAME build, so the writer, the perceive `/match-context` endpoint,
// the resolver and `store.patchJob` all work — only the browser rail lost its
// folds. Root cause, by field:
//
//   - the media-node share (`POST /jobs/:id/media`) puts the share's perceive
//     session on `bj.mediaSessionId` and never posts `/jobs/:id/ingest`, so
//     `bj.sessionId` stays unset, and a browser record persists no
//     `perceiveSessionId`;
//   - the writer read `bj.sessionId ?? job.perceiveSessionId ?? ""`, i.e. `""`,
//     and `postMatchContext("")` answers null -> the best-effort path wrote
//     nothing, silently.
//
// These tests pin the fixed resolution (field precedence, the browser media-rail
// shape end to end) and the wiring line in `api.ts`, so the next regression of
// this class shows up as a failing test rather than a missing record field.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  createLiveMatchContextWriter,
  liveMatchContextSession,
  type MatchContext,
} from "../src/match-context";

const team = (name: string, side: "home" | "away", confidence: number): MatchContext["teams"][number] => ({
  name,
  side,
  kitColors: [],
  confidence,
  evidence: [{ source: "scorebug_ocr", snippet: "RMA 1-1 BAR" }],
});

const context = (teams: MatchContext["teams"], progress = 0): MatchContext => ({
  sport: "soccer",
  teams,
  inferredAt: "2026-11-12T00:00:00.000Z",
  resolverVersion: 1,
  ambiguous: false,
  trail: [{ at: "2026-11-12T00:00:00.000Z", progressPct: progress, names: [], action: ["fold"] }],
});

function fakeStore(job: Record<string, unknown> = { id: "job-live", status: "active" }) {
  const jobs = new Map<string, any>([["job-live", job]]);
  const patches: any[] = [];
  return {
    patches,
    jobs,
    getJob: (id: string) => jobs.get(id),
    patchJob: async (id: string, patch: any) => {
      patches.push(patch);
      const next = { ...(jobs.get(id) ?? {}), ...patch };
      jobs.set(id, next);
      return next;
    },
  };
}

/** A fold client that records the session id + body of every call. */
function foldClient(answer: (body: any, call: number) => any) {
  const calls: { sessionId: string; body: any }[] = [];
  return {
    calls,
    postMatchContext: async (sessionId: string, body: Record<string, unknown>) => {
      calls.push({ sessionId, body });
      return answer(body, calls.length);
    },
  };
}

describe("liveMatchContextSession (ADAAAA-8736)", () => {
  it("reads the media-node share's session when the WS ingest session is unset", () => {
    // The measured browser shape: no `bj.sessionId`, no `perceiveSessionId`.
    expect(liveMatchContextSession({ mediaSessionId: "media-1" }, {})).toBe("media-1");
  });

  it("keeps the WS ingest rail's session first, so that rail is untouched", () => {
    expect(liveMatchContextSession({ sessionId: "sess-1", mediaSessionId: "media-1" })).toBe("sess-1");
    expect(liveMatchContextSession({ sessionId: "sess-1" })).toBe("sess-1");
  });

  it("falls back to the rtmp rail's persisted perceiveSessionId", () => {
    expect(liveMatchContextSession(undefined, { perceiveSessionId: "perceive-1" })).toBe("perceive-1");
    expect(liveMatchContextSession({}, { perceiveSessionId: "perceive-1" })).toBe("perceive-1");
  });

  it("is empty — never a fabricated id — when the share has no session yet", () => {
    expect(liveMatchContextSession({}, {})).toBe("");
    expect(liveMatchContextSession(undefined, undefined)).toBe("");
    expect(liveMatchContextSession({ sessionId: "", mediaSessionId: "" }, { perceiveSessionId: "" })).toBe("");
  });
});

describe("the live writer against the browser media-rail shape (ADAAAA-8736)", () => {
  it("posts every fold at the media session and persists the record", async () => {
    const store = fakeStore();
    const client = foldClient(() => ({
      matchContext: context([team("Real Madrid", "home", 0.5), team("Barcelona", "away", 0.5)], 0),
    }));
    // The exact shape `ensureMediaRail` serves a media-node browser share.
    const bj: { sessionId?: string; mediaSessionId?: string } = { mediaSessionId: "media-9" };
    const job: { perceiveSessionId?: string } = {};
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => liveMatchContextSession(bj, job),
      hints: { gameHint: "soccer" },
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    for (let t = 0; t <= 120; t += 3) writer.noteWindow({ centerTs: t, transcript: `call ${t}` });
    await writer.finish();
    expect(client.calls).toHaveLength(3); // checkpoints 0 / 60 / 120
    expect(client.calls.every((c) => c.sessionId === "media-9")).toBe(true);
    const published = store.getJob("job-live").matchContext as MatchContext;
    expect(published.teams.map((t) => `${t.side}:${t.name}`)).toEqual(["home:Real Madrid", "away:Barcelona"]);
    expect(store.patches).toHaveLength(3);
  });

  it("names a session-less fold in the log instead of dropping it silently", async () => {
    const store = fakeStore();
    const client = foldClient(() => ({ matchContext: context([team("Barcelona", "away", 0.5)]) }));
    const logs: string[] = [];
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => "",
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: (msg: string) => logs.push(msg),
    });
    writer.noteWindow({ centerTs: 0, transcript: "hello" });
    await writer.finish();
    expect(client.calls).toHaveLength(0);
    expect(store.patches).toHaveLength(0);
    expect(logs).toEqual([
      "[match-context:live:job-live] no perceive session at 0s — fold skipped (matchContext stays as stored)",
    ]);
  });

  it("recovers on the next checkpoint once the share provisions its session", async () => {
    const store = fakeStore();
    const client = foldClient(() => ({ matchContext: context([team("Real Madrid", "home", 0.5)]) }));
    let session = ""; // handshake not yet done when window 0 decides
    const writer = createLiveMatchContextWriter({
      jobId: "job-live",
      client: client as any,
      getSessionId: () => session,
      hints: {},
      getJob: store.getJob,
      patchJob: store.patchJob,
      log: () => {},
    });
    writer.noteWindow({ centerTs: 0, transcript: "early" });
    await writer.finish();
    expect(client.calls).toHaveLength(0);
    session = "media-9";
    writer.noteWindow({ centerTs: 60, transcript: "later" });
    await writer.finish();
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].sessionId).toBe("media-9");
    expect((store.getJob("job-live").matchContext as MatchContext).teams).toHaveLength(1);
  });
});

describe("the browser rail reads the rail's session fields (ADAAAA-8736)", () => {
  it("ensureMediaRail's writer resolves through liveMatchContextSession(bj, job)", () => {
    // The defect WAS the wiring expression, so a writer-only unit test cannot
    // catch a revert. Guard the served line itself.
    const src = readFileSync(new URL("../src/api.ts", import.meta.url), "utf8");
    const at = src.indexOf("async function ensureMediaRail(");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(at, at + 8000);
    expect(block).toMatch(/getSessionId: \(\) => liveMatchContextSession\(bj, job\)/);
    // The pre-fix expression (session "" on every browser share) must be gone.
    expect(block).not.toMatch(/getSessionId: \(\) => bj\.sessionId \?\?/);
  });
});
