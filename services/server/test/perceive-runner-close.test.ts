import { describe, it, expect, vi, afterEach } from "vitest";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import type { ServerConfig } from "../src/config";

// ADAAAA-7642: a stop must release the perceive session where it is actually
// held. The orchestrator's `/apps/<app>/session/<id>/stop` answers 204 but its
// close is NOT propagated to the self-hosted perceive runner, so the runner
// registry keeps the session + trickle alive and the box keeps burning GPU after
// a stop the API already reported as released. `OrchestratorAdapter.stopPerceive`
// must therefore also POST `<runner>/session/close` with `X-Session-Id`.

const SID = "9e7d782c";

function adapter(cfg: Partial<ServerConfig>): any {
  const a: any = new OrchestratorAdapter({
    orchestratorUrl: "http://orchestrator.invalid:8935",
    ...cfg,
  } as ServerConfig);
  a.client = { stopPerceive: vi.fn(async () => {}) };
  return a;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OrchestratorAdapter.stopPerceive release path (ADAAAA-7642)", () => {
  it("closes the perceive runner session in addition to the orchestrator stop", async () => {
    const calls: Array<{ url: string; init: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200 } as any;
    }));

    const a = adapter({ perceiveRunnerUrl: "http://perceive:8080" });
    await a.stopPerceive(SID);

    expect(a.client.stopPerceive).toHaveBeenCalledWith(SID);
    const close = calls.find((c) => c.url === "http://perceive:8080/session/close");
    expect(close).toBeTruthy();
    expect(close!.init.method).toBe("POST");
    expect(close!.init.headers["X-Session-Id"]).toBe(SID);
  });

  it("does not call the runner when no runner URL is configured (orchestrator mode unchanged)", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200 } as any;
    }));

    const a = adapter({});
    await a.stopPerceive(SID);

    expect(a.client.stopPerceive).toHaveBeenCalledWith(SID);
    expect(calls).toEqual([]);
  });

  it("still resolves when the runner close fails (best-effort release)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("ECONNREFUSED perceive:8080");
    }));

    const a = adapter({ perceiveRunnerUrl: "http://perceive:8080" });
    await expect(a.stopPerceive(SID)).resolves.toBeUndefined();
    expect(a.client.stopPerceive).toHaveBeenCalledWith(SID);
  });
});
