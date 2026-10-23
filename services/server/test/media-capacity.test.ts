import { describe, it, expect, vi, afterEach } from "vitest";
import { buildTestApp } from "./helpers";

// ADAAAA-7325: the capacity-1 perceive runner's SessionRegistry fills
// transiently, and reservePerceive surfaces it as
// "reserve perceive failed: HTTP 503 no capacity available for runner".
// The /jobs/:id/ingest and /jobs/:id/media routes must map that (transient,
// retryable) failure to HTTP 503 so the client can back off — NOT the
// catch-all 500 that was indistinguishable from a real server bug.
function saturatedAdapter(extra: any = {}) {
  return Object.assign(
    {
      async reservePerceive() {
        throw new Error("reserve perceive failed: HTTP 503 no capacity available for runner");
      },
      async analyze() {
        return { observation: { tracks: [], seq: 0, timestamp: 0 } };
      },
      async decide() {
        return { isHighlight: false, score: 0, eventType: "" };
      },
      async plan() {
        return {
          planVersion: 1,
          category: "soccer",
          intent: "",
          source: "planner-fallback",
          maxTracks: 3,
          targets: [{ label: "player", role: "player" }],
          reason: "test",
        };
      },
      async train() {
        return { run: "x", checkpoint: "/x" };
      },
      async stopPerceive() {},
    },
    extra
  );
}

async function register(app: any): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "cap@test.dev", password: "password123" },
  });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

async function createBrowserJob(app: any, token: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/jobs",
    headers: { authorization: `Bearer ${token}` },
    payload: { source: "browser", gameHint: "soccer" },
  });
  expect(r.statusCode).toBe(200);
  return r.json().job.id as string;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("POST /jobs/:id/ingest capacity-exhaustion mapping", () => {
  it("returns 503 (not 500) when reservePerceive hits no-capacity", async () => {
    const { app } = await buildTestApp({}, { adapter: saturatedAdapter() });
    const token = await register(app);
    const jobId = await createBrowserJob(app, token);
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body.error).toMatch(/no capacity available for runner/);
    await app.close();
  });

  it("returns 500 for a non-capacity reserve error", async () => {
    const adapter = saturatedAdapter({
      reservePerceive: async () => {
        throw new Error("orchestrator unreachable");
      },
    });
    const { app } = await buildTestApp({}, { adapter });
    const token = await register(app);
    const jobId = await createBrowserJob(app, token);
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/ingest`,
      headers: { authorization: `Bearer ${token}` },
      payload: { seq: 0, timestamp: 0, image: "aGVsbG8=" },
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toMatch(/orchestrator unreachable/);
    await app.close();
  });
});

describe("POST /jobs/:id/media capacity-exhaustion mapping", () => {
  it("returns 503 (not 500) when the media provision surfaces no-capacity", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          status: 500,
          text: async () =>
            "reserve perceive failed: HTTP 503 no capacity available for runner",
          json: async () => ({}),
        }) as any
    );
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: "http://media:4070" });
    const token = await register(app);
    const jobId = await createBrowserJob(app, token);
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(r.statusCode).toBe(503);
    const body = r.json();
    expect(body.error).toMatch(/no capacity available for runner/);
    await app.close();
  });

  it("returns 500 for a non-capacity media provision error", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        ({
          status: 500,
          text: async () => "media node exploded",
          json: async () => ({}),
        }) as any
    );
    const { app } = await buildTestApp({ MEDIA_SERVER_URL: "http://media:4070" });
    const token = await register(app);
    const jobId = await createBrowserJob(app, token);
    const r = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/media`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().error).toMatch(/media node exploded/);
    await app.close();
  });
});
