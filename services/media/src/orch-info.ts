
// GetOrchestratorInfo provider for the on-chain paid path.
//
// go-livepeer REQUIRES the orchestrator's `net.OrchestratorInfo` (base64
// protobuf) as the `orchestrator` field of every `/generate-live-payment`
// call. That info CANNOT be fabricated by the payer — it is the orchestrator's
// signed ticket params + price info — so the media server (as broadcaster /
// payer) must fetch it from the orchestrator directly:
//
//   1. Ask the remote signer for the broadcast auth material:
//      POST /sign-orchestrator-info  -> { address, signature }
//   2. Call the orchestrator's gRPC `GetOrchestrator` (net.Orchestrator
//      service) with { address, sig, ignoreCapacityCheck }.
//   3. Serialize the returned `net.OrchestratorInfo` back to protobuf and
//      base64-encode it — that exact string goes in `orchestrator`.
//
// The `lp_rpc.proto` (vendored from go-livepeer v0.9.2) is loaded at runtime
// via @grpc/proto-loader; the result is cached by MediaOrchestrator.
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

export interface InfoSigResponse {
  /** Broadcaster ETH address, hex `0x…`. */
  address: string;
  /** Broadcaster signature over the address, hex `0x…`. */
  signature: string;
}

export interface OrchInfoProviderOptions {
  /** Remote signer base URL (e.g. `http://signer:7936`). */
  signerUrl: string;
  /** Orchestrator gRPC host (e.g. `https://orchestrator:8935`). */
  orchBase: string;
  /** PEM of the orchestrator's self-signed cert to trust for the gRPC TLS. */
  caCertPem?: string;
}

const PROTO_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "proto",
  "lp_rpc.proto"
);

let _proto: any = null;
/** Load the vendored go-livepeer net.proto once. */
function loadProto(): any {
  if (_proto) return _proto;
  const def = protoLoader.loadSync(PROTO_PATH, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  _proto = grpc.loadPackageDefinition(def) as any;
  return _proto;
}

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error(`odd-length hex string: ${h}`);
  return Buffer.from(h, "hex");
}

/**
 * Ask the remote signer for the GetOrchestratorInfo auth material
 * (address + signature). Matches go-livepeer `server.GetOrchInfoSig`.
 */
export async function signerInfoSig(
  signerUrl: string,
  timeoutMs = 15_000
): Promise<InfoSigResponse> {
  const res = await fetch(new URL("/sign-orchestrator-info", signerUrl).toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status !== 200) {
    throw new Error(`sign-orchestrator-info failed: HTTP ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as InfoSigResponse;
  if (!body?.address || !body?.signature) {
    throw new Error(`sign-orchestrator-info missing address/signature: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Call the orchestrator's gRPC GetOrchestrator and return the base64 protobuf
 * of `net.OrchestratorInfo` — exactly the string go-livepeer wants in the
 * `orchestrator` field of `/generate-live-payment`.
 */
/**
 * Reduce a gRPC endpoint URL (e.g. `https://orchestrator:8935`) to the bare
 * `host:port` target grpc-js expects. grpc-js treats a string with a URL scheme
 * as a DNS-style resolved address and fails `Name resolution failed for target
 * dns:https://…`, so the scheme must be stripped before constructing the client.
 */
export function grpcTargetFromUrl(url: string): string {
  // Already a bare host:port (no scheme) — pass through unchanged.
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) {
    return url;
  }
  const parsed = new URL(url);
  const host = parsed.hostname;
  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  return `${host}:${port}`;
}

export interface OrchInfoResult {
  /** base64 protobuf of net.OrchestratorInfo — the `orchestrator` field value. */
  b64: string;
  /**
   * The orchestrator's AuthToken.SessionId. go-livepeer REQUIRES the live
   * payment's `manifestID` to equal this, otherwise the orchestrator returns
   * `403 mismatched manifest and auth token`. The payer must thread it into
   * the `/generate-live-payment` request as `manifestID`.
   */
  sessionId: string;
  /**
   * The orchestrator's announced session payment interval (ms), when it
   * publishes one (e.g. from a discoverable `price_info`/config channel).
   * The payer drives its refresh cadence from this so it never under-fills
   * between the orchestrator's charge windows. When absent, the payer falls
   * back to its configured `paymentIntervalMs` (default 10s).
   */
  paymentIntervalMs?: number;
}

export async function getOrchestratorInfoB64(
  opts: Pick<OrchInfoProviderOptions, "orchBase" | "caCertPem">,
  sig: InfoSigResponse
): Promise<OrchInfoResult> {
  const proto = loadProto();
  const target = grpcTargetFromUrl(opts.orchBase);
  // TLS when we have a CA (https orchestrator); otherwise insecure (offchain/dev).
  const useTls = opts.orchBase.startsWith("https");
  const creds = useTls
    ? (opts.caCertPem
        ? grpc.credentials.createSsl(Buffer.from(opts.caCertPem), undefined, undefined, {
            checkServerIdentity: () => undefined,
          })
        : grpc.credentials.createSsl())
    : grpc.credentials.createInsecure();

  const client = new proto.net.Orchestrator(target, creds);
  try {
    const info = await new Promise<any>((resolve, reject) => {
      client.GetOrchestrator(
        {
          address: hexToBytes(sig.address),
          sig: hexToBytes(sig.signature),
          ignoreCapacityCheck: true,
        },
        (err: grpc.ServiceError | null, res: any) =>
          err ? reject(err) : resolve(res)
      );
    });
    if (!info) throw new Error("GetOrchestrator returned empty OrchestratorInfo");
    // Use grpc-js's own response serializer for the GetOrchestrator method — it
    // emits the exact `net.OrchestratorInfo` wire format the orchestrator sent
    // (decode -> re-encode is byte-identical for protobuf), which is what
    // go-livepeer requires in the `orchestrator` field of /generate-live-payment.
    const responseSerialize =
      proto.net.Orchestrator.service.GetOrchestrator.responseSerialize;
    const bytes = responseSerialize(info);
    // keepCase:true -> proto field names preserved (auth_token / session_id).
    const sessionId = info?.auth_token?.session_id ?? "";
    return { b64: Buffer.from(bytes).toString("base64"), sessionId };
  } finally {
    client.close();
  }
}

/**
 * Build the `orchInfoB64Provider` the media orchestrator resolves on a 402.
 * Caches the orchestrator info after the first successful fetch (it does not
 * change until the ticket params expire, at which point the orchestrator will
 * reject and the session is torn down — a fresh fetch happens on retry).
 */
export type OrchInfoProvider = (force?: boolean) => Promise<OrchInfoResult>;

export function createOrchInfoProvider(
  opts: OrchInfoProviderOptions
): OrchInfoProvider {
  let cached: OrchInfoResult | null = null;
  return async (force = false): Promise<OrchInfoResult> => {
    if (cached && !force) return cached;
    const sig = await signerInfoSig(opts.signerUrl);
    const result = await getOrchestratorInfoB64(opts, sig);
    cached = result;
    return result;
  };
}

/** @deprecated alias kept for callers that only need the base64. */
export function createOrchInfoB64Provider(
  opts: OrchInfoProviderOptions
): () => Promise<string> {
  const provider = createOrchInfoProvider(opts);
  return async () => (await provider()).b64;
}

/** Optional helper for tests/config to read a CA PEM from a path. */
export function readCaPem(pathLike: string | undefined): string | undefined {
  if (!pathLike) return undefined;
  return readFileSync(pathLike, "utf8");
}