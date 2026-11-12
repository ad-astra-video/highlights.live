// ADAAAA-7700 — the media node's open-session ledger + boot reconcile.
//
// A media-node recreate drops every in-flight RTC session and nothing told the
// control plane: the browser job stayed `active` (or was reaped as a bare
// `failed` at server boot) with 0 frames. The ledger remembers which sessions this
// process held; the next boot reports each one as `media-node-restart`.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MediaServer } from "../src/server";
import type { ProvisionedSession } from "../src/orch";
import { drainOpenSessions, forgetOpenSession, loadOpenSessions, recordOpenSession } from "../src/sessions-ledger";

class StubOrch {
  n = 0;
  /** ADAAAA-8813: every orchestrator stop the boot reconcile issued. */
  stopCalls: Array<{ sessionId: string; controlUrl?: string; fallbackBase?: string }> = [];
  /** Set to a non-2xx-ish result to exercise the failure counter. */
  stopResult: { ok: boolean; status: number } = { ok: true, status: 200 };
  async provision(): Promise<ProvisionedSession> {
    this.n += 1;
    const sessionId = `sess-${this.n}`;
    return {
      sessionId,
      appUrl: "http://fake",
      controlUrl: `http://orch/control/${sessionId}`,
      videoIn: `http://orch/video-in/${sessionId}`,
      eventsOut: `http://orch/events-out/${sessionId}`,
      control: `http://orch/control/${sessionId}`,
    };
  }
  startPayment() {}
  stopPayment() {}
  isPaying() {
    return false;
  }
  payingCount() {
    return 0;
  }
  paysOnchain() {
    return false;
  }
  async publishFrame() {
    return 200;
  }
  async readObservation() {
    return null;
  }
  async releaseSession() {}
  async closeSession() {}
  async stopSession(sessionId: string, controlUrl?: string, fallbackBase?: string) {
    this.stopCalls.push({ sessionId, controlUrl, fallbackBase });
    return { ok: this.stopResult.ok, status: this.stopResult.status, target: controlUrl || fallbackBase || "" };
  }
}

const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpStateDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), "media-state-"));
  dirs.push(d);
  return d;
}

async function controlPlaneStub(): Promise<{ base: string; calls: any[]; close: () => Promise<void> }> {
  const calls: any[] = [];
  const srv: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      calls.push({ url: req.url, method: req.method, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return {
    base: `http://127.0.0.1:${(srv.address() as any).port}`,
    calls,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe("open-session ledger (ADAAAA-7700)", () => {
  it("records, refreshes and forgets one session per id", () => {
    const dir = tmpStateDir();
    recordOpenSession(dir, { sessionId: "s1", jobId: "job-a", transport: "none", everAttached: false });
    recordOpenSession(dir, { sessionId: "s2", jobId: "job-b", transport: "webrtc", everAttached: true });
    // Re-recording the same session (a client attached) must update, not duplicate.
    recordOpenSession(dir, { sessionId: "s1", jobId: "job-a", transport: "webrtc", everAttached: true });

    const rows = loadOpenSessions(dir);
    expect(rows.map((r) => r.sessionId).sort()).toEqual(["s1", "s2"]);
    expect(rows.find((r) => r.sessionId === "s1")).toMatchObject({ jobId: "job-a", transport: "webrtc", everAttached: true });

    forgetOpenSession(dir, "s1");
    expect(loadOpenSessions(dir).map((r) => r.sessionId)).toEqual(["s2"]);
  });

  it("drains exactly once", () => {
    const dir = tmpStateDir();
    recordOpenSession(dir, { sessionId: "s1", jobId: "job-a" });
    const first = drainOpenSessions(dir);
    expect(first.map((r) => r.sessionId)).toEqual(["s1"]);
    expect(drainOpenSessions(dir)).toHaveLength(0);
  });

  it("reads a missing/corrupt ledger as empty instead of throwing", () => {
    expect(loadOpenSessions(tmpStateDir())).toEqual([]);
  });

  it("a media server records the sessions it opens", async () => {
    const dir = tmpStateDir();
    const ms = new MediaServer({ orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir }, new StubOrch() as any);
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    const r = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-live" } });
    expect(r.statusCode).toBe(200);
    const sid = r.json().sessionId as string;
    expect(loadOpenSessions(dir)).toEqual([
      expect.objectContaining({ sessionId: sid, jobId: "job-live", everAttached: false }),
    ]);

    // A clean close forgets the session and reports it once to the control plane.
    const closed = await app.inject({ method: "POST", url: `/sessions/${sid}/close`, payload: {} });
    expect(closed.statusCode).toBe(200);
    expect(loadOpenSessions(dir)).toHaveLength(0);
  });
});

describe("boot reconcile of lost sessions (ADAAAA-7700)", () => {
  it("reports every leftover session as media-node-restart", async () => {
    const dir = tmpStateDir();
    const cp = await controlPlaneStub();
    cleanups.push(() => cp.close());
    // The previous boot's leftovers (as a restart would leave them).
    recordOpenSession(dir, { sessionId: "sess-a", jobId: "job-a", transport: "webrtc", everAttached: true });
    recordOpenSession(dir, { sessionId: "sess-b", jobId: "job-b", transport: "none", everAttached: false });

    const orch = new StubOrch();
    const ms = new MediaServer(
      { orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir, callbackBase: cp.base, nodeId: "media-0" },
      orch as any
    );
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    const r = await ms.reconcileLostSessions();
    expect(r).toEqual({ reported: 2, leftover: 2, released: 2, releaseFailed: 0 });
    const posts = cp.calls.filter((c) => c.url?.endsWith("/media/session-closed"));
    expect(posts.map((c) => c.body.jobId).sort()).toEqual(["job-a", "job-b"]);
    for (const p of posts) {
      expect(p.method).toBe("POST");
      expect(p.body.reason).toBe("media-node-restart");
      expect(p.body.nodeId).toBe("media-0");
    }
    // attached vs abandoned provision stays distinguishable on the caller
    expect(posts.find((c) => c.body.jobId === "job-a").body).toMatchObject({ neverAttached: false, transport: "webrtc" });
    expect(posts.find((c) => c.body.jobId === "job-b").body).toMatchObject({ neverAttached: true });

    // ADAAAA-8813: the orchestrator's paid live-runner session is released for
    // every leftover, keyed by session id (jobId is not part of the key).
    expect(orch.stopCalls.map((c) => c.sessionId).sort()).toEqual(["sess-a", "sess-b"]);
    expect(orch.stopCalls.every((c) => c.fallbackBase === "http://orch")).toBe(true);

    // Draining is exactly-once: a second boot has nothing left to report.
    expect(await ms.reconcileLostSessions()).toEqual({ reported: 0, leftover: 0, released: 0, releaseFailed: 0 });
    expect(orch.stopCalls).toHaveLength(2);

    // The node's own /health carries the evidence counter.
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.cost.sessionsLostReported).toBe(2);
    expect(health.cost.sessionsReleasedAtBoot).toBe(2);
    expect(health.cost.sessionsReleaseFailedAtBoot).toBe(0);
  });
});

// ADAAAA-8813 — a media restart must stop the ORCHESTRATOR's live-runner
// session, not just finalize the job record. The pre-fix reconcile skipped the
// whole body for a `jobId: ""` ledger row (`if (!this.opts.callbackBase ||
// !rec.jobId) continue;`) and never called the stop endpoint at all, so lost
// sessions kept `Accounted payment` and held the capacity-1 perceive slot until
// balance expiry. These cover the release path on its own.
describe("boot reconcile releases the orchestrator session (ADAAAA-8813)", () => {
  it("releases a session that carries no jobId, and does not depend on it", async () => {
    const dir = tmpStateDir();
    const cp = await controlPlaneStub();
    cleanups.push(() => cp.close());
    // A session provisioned straight on the node (`POST /sessions {}`) — the
    // shape of all four sessions leaked in the 2026-11-12 16:30Z incident.
    recordOpenSession(dir, { sessionId: "sess-nojob", jobId: "", transport: "webrtc", everAttached: true });

    const orch = new StubOrch();
    const ms = new MediaServer(
      { orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir, callbackBase: cp.base, nodeId: "media-0" },
      orch as any
    );
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    const r = await ms.reconcileLostSessions();
    // Nothing to report (no job), but the paid slot IS released.
    expect(r).toEqual({ reported: 0, leftover: 1, released: 1, releaseFailed: 0 });
    expect(orch.stopCalls).toEqual([
      { sessionId: "sess-nojob", controlUrl: "", fallbackBase: "http://orch" },
    ]);
    expect(cp.calls.filter((c) => c.url?.endsWith("/media/session-closed"))).toHaveLength(0);
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.cost.sessionsReleasedAtBoot).toBe(1);
  });

  it("stops on the session's own controlUrl when the ledger recorded one", async () => {
    const dir = tmpStateDir();
    const orch = new StubOrch();
    recordOpenSession(dir, {
      sessionId: "sess-ctl",
      jobId: "",
      controlUrl: "http://orch-discovered/apps/highlights-perceive/session/sess-ctl/control",
    });
    const ms = new MediaServer({ orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir }, orch as any);
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    await ms.reconcileLostSessions();
    expect(orch.stopCalls[0].controlUrl).toBe(
      "http://orch-discovered/apps/highlights-perceive/session/sess-ctl/control"
    );
  });

  it("records the controlUrl of every session it opens", async () => {
    const dir = tmpStateDir();
    const orch = new StubOrch();
    const ms = new MediaServer({ orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir }, orch as any);
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    const r = await app.inject({ method: "POST", url: "/sessions", payload: { jobId: "job-ctl" } });
    const sid = r.json().sessionId as string;
    expect(loadOpenSessions(dir)).toEqual([
      expect.objectContaining({ sessionId: sid, jobId: "job-ctl", controlUrl: `http://orch/control/${sid}` }),
    ]);
    // That persisted target is what the NEXT boot stops on.
    await ms.reconcileLostSessions();
    expect(orch.stopCalls).toEqual([
      { sessionId: sid, controlUrl: `http://orch/control/${sid}`, fallbackBase: "http://orch" },
    ]);
  });

  it("counts a failed release instead of silently dropping it", async () => {
    const dir = tmpStateDir();
    recordOpenSession(dir, { sessionId: "sess-fail", jobId: "" });
    const orch = new StubOrch();
    orch.stopResult = { ok: false, status: 0 }; // orchestrator unreachable
    const ms = new MediaServer({ orchBase: "http://orch", provisionNoClientMs: 0, stateDir: dir }, orch as any);
    const app: FastifyInstance = await ms.build();
    cleanups.push(() => app.close());

    expect(await ms.reconcileLostSessions()).toEqual({
      reported: 0,
      leftover: 1,
      released: 0,
      releaseFailed: 1,
    });
    const health = (await app.inject({ method: "GET", url: "/health" })).json();
    expect(health.cost.sessionsReleaseFailedAtBoot).toBe(1);
    expect(health.cost.sessionsReleasedAtBoot).toBe(0);
  });
});
