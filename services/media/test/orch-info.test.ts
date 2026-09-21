
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getOrchestratorInfoB64,
  grpcTargetFromUrl,
  hexToBytes,
  signerInfoSig,
} from "../src/orch-info";

const PROTO = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "proto", "lp_rpc.proto");
const def = protoLoader.loadSync(PROTO, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const proto: any = grpc.loadPackageDefinition(def);

describe("hexToBytes", () => {
  it("strips 0x and decodes", () => {
    expect(Buffer.from(hexToBytes("0xdeadbeef")).toString("hex")).toBe("deadbeef");
  });
  it("rejects odd-length hex", () => {
    expect(() => hexToBytes("0xabc")).toThrow(/odd-length/);
  });
});

describe("grpcTargetFromUrl", () => {
  it("strips https scheme to host:port", () => {
    expect(grpcTargetFromUrl("https://orchestrator:8935")).toBe("orchestrator:8935");
  });
  it("defaults https port when omitted", () => {
    expect(grpcTargetFromUrl("https://orchestrator")).toBe("orchestrator:443");
  });
  it("passes a bare host:port through unchanged", () => {
    expect(grpcTargetFromUrl("127.0.0.1:1234")).toBe("127.0.0.1:1234");
  });
});

describe("signerInfoSig", () => {
  const origFetch = globalThis.fetch;
  afterAll(() => {
    globalThis.fetch = origFetch;
  });
  it("POSTs /sign-orchestrator-info and parses address/signature", async () => {
    globalThis.fetch = (async () =>
      ({
        status: 200,
        json: async () => ({ address: "0x1111", signature: "0x" + "ab".repeat(65) }),
      } as any)) as any;
    const r = await signerInfoSig("http://signer:7936");
    expect(r.address).toBe("0x1111");
    expect(r.signature.length).toBe(132);
  });
  it("throws on non-200", async () => {
    globalThis.fetch = (async () => ({ status: 500, text: async () => "boom" } as any)) as any;
    await expect(signerInfoSig("http://signer:7936")).rejects.toThrow(/HTTP 500/);
  });
});

describe("getOrchestratorInfoB64 (in-process gRPC GetOrchestrator)", () => {
  let server: grpc.Server;
  let port: number;
  let lastReq: any;

  beforeAll(async () => {
    server = new grpc.Server();
    server.addService(proto.net.Orchestrator.service, {
      GetOrchestrator: (call: any, callback: any) => {
        lastReq = call.request;
        // grpc-js serializes a plain object with the proto's field names.
        callback(null, {
          transcoder: "https://orchestrator:8935",
          address: Buffer.from("deadbeef", "hex"),
          price_info: { pricePerUnit: "1", pixelsPerUnit: "1" },
          nodes: ["https://orchestrator:8935"],
          auth_token: { session_id: "sess-abc", token: Buffer.from("tok", "hex"), expiration: "123" },
        });
      },
    });
    await new Promise<void>((resolve, reject) => {
      server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => {
        if (err) return reject(err);
        port = p;
        resolve();
      });
    });
    server.start();
  });

  afterAll(() => {
    server.forceShutdown();
  });

  it("returns base64 OrchestratorInfo that round-trips to the same fields", async () => {
    const { b64, sessionId } = await getOrchestratorInfoB64(
      { orchBase: `127.0.0.1:${port}` },
      { address: "0xdeadbeef", signature: "0x" + "ab".repeat(65) }
    );
    expect(typeof b64).toBe("string");
    expect(b64.length).toBeGreaterThan(0);
    // go-livepeer requires the live payment manifestID == AuthToken.SessionId.
    expect(sessionId).toBe("sess-abc");

    const responseDeserialize = proto.net.Orchestrator.service.GetOrchestrator.responseDeserialize;
    const decoded: any = responseDeserialize(Buffer.from(b64, "base64"));
    expect(decoded.transcoder).toBe("https://orchestrator:8935");
    expect(Buffer.from(decoded.address).toString("hex")).toBe("deadbeef");
    expect(decoded.nodes).toEqual(["https://orchestrator:8935"]);
    // price_info serialized as int64 (decoded as string via longs:String)
    expect(String(decoded.price_info.pricePerUnit)).toBe("1");
  });

  it("passes the request address+sig bytes to the orchestrator", async () => {
    await getOrchestratorInfoB64(
      { orchBase: `127.0.0.1:${port}` },
      { address: "0xdeadbeef", signature: "0x" + "cd".repeat(65) }
    );
    expect(Buffer.from(lastReq.address).toString("hex")).toBe("deadbeef");
    expect(Buffer.from(lastReq.sig).toString("hex")).toBe("cd".repeat(65));
    expect(lastReq.ignoreCapacityCheck).toBe(true);
  });
});