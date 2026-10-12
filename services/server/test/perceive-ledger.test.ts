import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filePerceiveSessionLedger, releaseOrphanedPerceiveSessions } from "../src/perceive-ledger";
import { OrchestratorAdapter } from "../src/livepeer-adapter";
import { loadConfig } from "../src/config";
import type { SignerClient, LivePayment } from "@highlights/livepeer-session";

// ADAAAA-6586: a highlights-server restart/deploy mid-VOD drops the in-memory
// payment refreshers, so a perceive session the orchestrator still holds stops
// being funded and is force-released with `insufficient balance`. The ledger
// persists funded session ids and the boot reconcile releases any the previous
// process left funded.

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "perceive-ledger-"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const ledgerPath = (dir: string) => join(dir, "perceive-sessions.json");

describe("filePerceiveSessionLedger", () => {
  it("round-trips register / list / unregister and survives a missing or corrupt file", async () => {
    const ledger = filePerceiveSessionLedger(ledgerPath(dir));

    // Missing file -> empty list.
    expect(await ledger.list()).toEqual([]);

    await ledger.register("sess-a");
    await ledger.register("sess-b");
    await ledger.register("sess-a"); // idempotent
    expect(await ledger.list()).toEqual(["sess-a", "sess-b"]);

    await ledger.unregister("sess-a");
    await ledger.unregister("nope"); // idempotent no-op
    expect(await ledger.list()).toEqual(["sess-b"]);

    // A corrupt file is tolerated (treated as empty), not thrown.
    await rm(ledgerPath(dir));
    await writeFile(ledgerPath(dir), "{not json", "utf8");
    expect(await ledger.list()).toEqual([]);
  });

  it("persists to disk so a fresh ledger instance (a restart) sees the funded ids", async () => {
    const first = filePerceiveSessionLedger(ledgerPath(dir));
    await first.register("sess-orphan");

    // Simulate a process restart: a brand-new ledger instance reads the file.
    const second = filePerceiveSessionLedger(ledgerPath(dir));
    expect(await second.list()).toEqual(["sess-orphan"]);
  });
});

describe("releaseOrphanedPerceiveSessions (boot reconcile)", () => {
  it("stops every listed session and reports released / failed", async () => {
    const ledger = filePerceiveSessionLedger(ledgerPath(dir));
    await ledger.register("sess-1");
    await ledger.register("sess-2");
    await ledger.register("sess-3");

    const stopped: string[] = [];
    const stopper = {
      stopPerceive: vi.fn(async (id: string) => {
        if (id === "sess-2") throw new Error("orchestrator unreachable");
        stopped.push(id);
      }),
    };

    const { released, failed } = await releaseOrphanedPerceiveSessions(stopper, ledger);

    expect(released.sort()).toEqual(["sess-1", "sess-3"]);
    expect(failed).toEqual(["sess-2"]);
    expect(stopper.stopPerceive).toHaveBeenCalledTimes(3);
  });

  it("no-ops when the ledger is empty", async () => {
    const ledger = filePerceiveSessionLedger(ledgerPath(dir));
    const stopper = { stopPerceive: vi.fn(async () => undefined) };
    const { released, failed } = await releaseOrphanedPerceiveSessions(stopper, ledger);
    expect(released).toEqual([]);
    expect(failed).toEqual([]);
    expect(stopper.stopPerceive).not.toHaveBeenCalled();
  });
});

// --- Adapter integration: funded perceive sessions are ledger-registered -----

/** In-memory double of the ledger to assert adapter calls without touching disk. */
function memoryLedger() {
  const set = new Set<string>();
  return {
    ids: set,
    ledger: {
      register: vi.fn(async (id: string) => void set.add(id)),
      unregister: vi.fn(async (id: string) => void set.delete(id)),
      list: async () => [...set],
    },
  };
}

const CHALLENGE = {
  payment_params: "b3JjaC1pbmZv",
  orchestrator: "http://orch",
  manifest_id: "sess-abc",
  payment_url: "http://orch/apps/highlights-perceive/session/sess-abc/payment",
};
const PAYER = "0x68d6FF3938Ff63d2df16567Cb8CA9772e14496F7";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function fakeFetch(opts: { paidReserve?: boolean } = {}) {
  let reserveCalls = 0;
  const log: Array<{ url: string; method: string }> = [];
  return {
    fn: vi.fn(async (input: any, init?: any) => {
      const url = String(input);
      log.push({ url, method: init?.method || "GET" });
      if (url.endsWith("/apps/highlights-perceive/session")) {
        reserveCalls++;
        if (reserveCalls === 1 && !opts.paidReserve) return jsonResponse(402, CHALLENGE);
        return jsonResponse(200, { session_id: "sess-pay", app_url: "http://orch/app", control_url: "http://orch/ctl" });
      }
      if (url.includes("/payment")) return jsonResponse(200, { ok: true });
      if (url.endsWith("/stop")) return new Response(null, { status: 204 });
      return jsonResponse(404, { error: "nf" });
    }),
    log,
  };
}

const fakeSigner: SignerClient = {
  async discover() {
    return [];
  },
  async signOrchInfo() {
    return {};
  },
  async generateLivePayment(orchInfoB64: string, prev: unknown, opts: any = {}): Promise<LivePayment> {
    return { payment: "ticket", segCreds: "creds", signerState: { State: "c3RhdGU=", Sig: "c2ln" } };
  },
};

function cfg(env: Record<string, string> = {}) {
  return loadConfig({ ORCHESTRATOR_URL: "http://orch", ...env });
}

describe("OrchestratorAdapter ledger wiring (ADAAAA-6586)", () => {
  it("registers a funded perceive session on reserve and unregisters it on stop", async () => {
    const { fn, log } = fakeFetch();
    vi.stubGlobal("fetch", fn);
    const { ledger, ids } = memoryLedger();

    const adapter = new OrchestratorAdapter(cfg(), { signer: fakeSigner, payerAddress: PAYER, ledger });
    const r = await adapter.reservePerceive();
    expect(r.sessionId).toBe("sess-pay");

    // The funded session was persisted to the ledger.
    expect(ledger.register).toHaveBeenCalledWith("sess-pay");
    expect(ids.has("sess-pay")).toBe(true);

    // On a normal stop the orchestrator confirmed the release -> ledger cleared.
    await adapter.stopPerceive(r.sessionId);
    expect(log.some((c) => c.url.endsWith(`/apps/highlights-perceive/session/${r.sessionId}/stop`))).toBe(true);
    expect(ledger.unregister).toHaveBeenCalledWith("sess-pay");
    expect(ids.has("sess-pay")).toBe(false);
  });

  it("stays offchain (no ledger writes) when there is no signer/payer", async () => {
    // The orchestrator accepts the first reserve (no 402) so the paid/on-chain
    // funding path (startPayment) never runs.
    const { fn } = fakeFetch({ paidReserve: true });
    vi.stubGlobal("fetch", fn);
    const { ledger, ids } = memoryLedger();

    // No signer/payer -> reserve succeeds unpaid, startPayment never runs.
    const adapter = new OrchestratorAdapter(cfg(), { ledger });
    await adapter.reservePerceive();
    expect(ids.size).toBe(0);
    expect(ledger.register).not.toHaveBeenCalled();
  });
});
