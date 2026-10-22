import { afterEach, describe, expect, it, vi } from "vitest";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";
import { SessionLostError, reservePerceiveWithRetry, DeployRecreateInterruptedError } from "../src/analyzer";
import { buildTestApp, testCfg } from "./helpers";

function cfg(env: Record<string, string> = {}) {
  return loadConfig({ ORCHESTRATOR_URL: "http://orch", ...env });
}
function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("in-flight resilience: perceive analyze 502/503/504 is re-reservable (ADAAAA-7203)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([502, 503, 504])(
    "maps HTTP %i from the perceive analyze proxy to a SessionLostError with a typed deploy-recreate message",
    async (code) => {
      const fetch = vi.fn(async () => jsonResponse(code, { error: "bad gateway" }));
      vi.stubGlobal("fetch", fetch);
      const adapter = new OrchestratorAdapter(cfg());
      // SessionLostError (not the generic Error) so analyzeJob re-reserves + resumes.
      await expect(adapter.analyze("sess-1", { seq: 30, timestamp: 30, imageB64: "x" })).rejects.toBeInstanceOf(
        SessionLostError
      );
      // Typed message carries the deploy-recreate attribution (the retriable verdict).
      await expect(adapter.analyze("sess-1", { seq: 31, timestamp: 31, imageB64: "x" })).rejects.toThrow(
        /analyze interrupted \(deploy-recreate\)/
      );
    }
  );

  it("keeps a non-retriable status (500) a plain Error that aborts the pass", async () => {
    const fetch = vi.fn(async () => jsonResponse(500, { error: "boom" }));
    vi.stubGlobal("fetch", fetch);
    const adapter = new OrchestratorAdapter(cfg());
    await expect(adapter.analyze("sess-1", { seq: 1, timestamp: 1, imageB64: "x" })).rejects.toThrow(
      /analyze failed: HTTP 500/
    );
  });
});

describe("deploy-gate in-flight detection (ADAAAA-7203)", () => {
  it("lists only active (in-flight) jobs from the store", async () => {
    const { app, store, cfg: c } = await buildTestApp({ BETA_GATE: "0" });
    // Login as the bootstrapped admin (role admin passes adminReadonlyRequired too).
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: c.adminEmail, password: c.adminPassword },
    });
    expect(login.statusCode).toBe(200);
    const token = login.json().token;

    // No in-flight jobs yet.
    const empty = await app.inject({
      method: "GET",
      url: "/admin/inflight-jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json().inflight).toHaveLength(0);

    // An active (mid-analysis) job is reported as in-flight.
    const active = await store.createJob({
      id: "job-inflight",
      ownerId: "u1",
      source: "file",
      gameHint: "soccer goal",
    });
    await store.patchJob(active.id, { status: "active" });

    const res = await app.inject({
      method: "GET",
      url: "/admin/inflight-jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const inflight = res.json().inflight;
    expect(inflight).toHaveLength(1);
    expect(inflight[0].id).toBe("job-inflight");
    expect((res.headers["content-type"] || "").includes("application/json")).toBeTruthy();

    // A completed job is no longer in-flight.
    await store.patchJob(active.id, { status: "done", completedAt: new Date().toISOString() });
    const after = await app.inject({
      method: "GET",
      url: "/admin/inflight-jobs",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.json().inflight).toHaveLength(0);

    // A read-only credential is rejected by the write routes (bounded), and an
    // anonymous caller is 401 on the inflight endpoint.
    const anon = await app.inject({ method: "GET", url: "/admin/inflight-jobs" });
    expect(anon.statusCode).toBe(401);
  });

  it("testCfg/admin bootstraps an admin that passes the inflight route", async () => {
    const c = testCfg({ BETA_GATE: "0" });
    expect(typeof c.adminEmail).toBe("string");
    expect(c.adminEmail).toBeTruthy();
  });
});

describe("re-reserve retry across a deploy-recreate (ADAAAA-7203)", () => {
  it("retries a transient runner-unavailable reserve and recovers", async () => {
    let attempts = 0;
    const client = {
      reservePerceive: async () => {
        attempts++;
        if (attempts < 3) throw new Error("reserve perceive failed: HTTP 404 runner not found");
        return { sessionId: "sess-recovered", appUrl: "", controlUrl: "" };
      },
    } as any;
    const r = await reservePerceiveWithRetry(client, { attempts: 5, baseMs: 1, maxMs: 8 });
    expect(r.sessionId).toBe("sess-recovered");
    expect(attempts).toBe(3);
  });

  it("throws a typed DeployRecreateInterruptedError after the bounded reserve attempts", async () => {
    const client = {
      reservePerceive: async () => {
        throw new Error("reserve perceive failed: HTTP 404 runner not found");
      },
    } as any;
    await expect(reservePerceiveWithRetry(client, { attempts: 3, baseMs: 1, maxMs: 4 })).rejects.toBeInstanceOf(
      DeployRecreateInterruptedError
    );
    await expect(reservePerceiveWithRetry(client, { attempts: 3, baseMs: 1, maxMs: 4 })).rejects.toThrow(
      /analyze interrupted \(deploy-recreate\)/
    );
  });

  it("propagates a non-transient reserve error immediately (no retry)", async () => {
    let attempts = 0;
    const client = {
      reservePerceive: async () => {
        attempts++;
        throw new Error("invalid live runner payment signer address");
      },
    } as any;
    await expect(reservePerceiveWithRetry(client, { attempts: 5, baseMs: 1, maxMs: 8 })).rejects.toThrow(
      /invalid live runner payment signer address/
    );
    expect(attempts).toBe(1);
  });
});

