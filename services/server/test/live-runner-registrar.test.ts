// ADAAAA-8553 S1: decide registers ONE runner per container.
//
// The registry — not `decide-router` — owns decide readiness, capacity and
// failover: each container has a distinct RUNNER_ID, its own LITERAL capacity
// (4 on a 5090 worker, 2 on an x99 worker), `RUNNER_PROXY=0`, and `metadata`
// naming its tier and seqs. All five keep `app=highlights-live/decide` so the
// discovery capacity sum still matches on the leaf name.
//
// The parser is the real sidecar (`docker/live-runner-registrar.py
// --print-payload`), so these assertions describe byte-for-byte what the box
// sends to `POST /runners/heartbeat`.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoFile = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const registrar = repoFile("docker/live-runner-registrar.py");
const compose = readFileSync(repoFile("docker/docker-compose.yml"), "utf8");
const runScript = readFileSync(repoFile("docker/registrar-5090.sh"), "utf8");

const BASE_ENV = {
  RUNNER_APP: "highlights-live/decide",
  RUNNER_MODE: "single-shot",
  RUNNER_PROXY: "0",
  RUNNER_PRICE: "0.01",
  RUNNER_PRICE_UNIT: "fixed",
};

interface Runner {
  id: string;
  url: string;
  capacity: number;
  tier: "5090" | "x99-fallback";
  seqs: number;
}

// The registration set the ticket lands (plan §4).
const FIVE: Runner[] = [
  { id: "highlights-decide-5090-1", url: "http://192.168.1.151:8091", capacity: 4, tier: "5090", seqs: 4 },
  { id: "highlights-decide-5090-2", url: "http://192.168.1.151:8092", capacity: 4, tier: "5090", seqs: 4 },
  { id: "highlights-decide-5090-3", url: "http://192.168.1.151:8093", capacity: 4, tier: "5090", seqs: 4 },
  { id: "highlights-decide-x99", url: "http://decide:8081", capacity: 2, tier: "x99-fallback", seqs: 2 },
  { id: "highlights-decide-x99-b", url: "http://decide-b:8081", capacity: 2, tier: "x99-fallback", seqs: 2 },
];

function payloadFor(r: Runner): Record<string, any> {
  const out = execFileSync("python3", [registrar, "--print-payload"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...BASE_ENV,
      RUNNER_ID: r.id,
      RUNNER_URL: r.url,
      RUNNER_HEALTH_URL: "/health",
      RUNNER_CAPACITY: String(r.capacity),
      RUNNER_METADATA: JSON.stringify({
        model: "cyankiwi/gemma-4-12B-it-qat-AWQ-INT4",
        engine: "vllm",
        quantization: "compressed-tensors INT4",
        tier: r.tier,
        seqs: r.seqs,
      }),
    },
  });
  return JSON.parse(out);
}

function capacityFor(r: Runner): number {
  const out = execFileSync("python3", [registrar, "--print-capacity"], {
    encoding: "utf8",
    env: { ...process.env, ...BASE_ENV, RUNNER_ID: r.id, RUNNER_URL: r.url, RUNNER_CAPACITY: String(r.capacity) },
  });
  return Number(out.trim());
}

/** The `environment:` block of one compose service, as text. */
function serviceBlock(name: string): string {
  const lines = compose.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  expect(start, `compose service ${name} must exist`).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [a-zA-Z0-9_.-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

describe("per-container decide registrations (ADAAAA-8553 S1)", () => {
  it("registers all five containers with their own id, url, literal capacity and the shared app", () => {
    for (const r of FIVE) {
      const p = payloadFor(r);
      expect(p.runner_id, "each container needs a DISTINCT id").toBe(r.id);
      expect(p.runner_url).toBe(r.url);
      expect(p.capacity).toBe(r.capacity);
      // Discovery capacity summing matches on the leaf name; a runner-id-shaped
      // app would make `isDecideRunnerApp` miss it.
      expect(p.app).toBe("highlights-live/decide");
      expect(p.mode).toBe("single-shot");
      // Single-shot runners are called at /apps/{id}/app/...; the proxy
      // indirection buys nothing and would hide the id.
      expect("proxy" in p, "RUNNER_PROXY=0 must omit proxy").toBe(false);
      expect(p.price_info).toEqual({ price: 0.01, currency: "usd", unit: "fixed" });
    }
  });

  it("the five capacities sum to 16 (4/4/4/2/2)", () => {
    const caps = FIVE.map((r) => payloadFor(r).capacity);
    expect(caps).toEqual([4, 4, 4, 2, 2]);
    expect(caps.reduce((a, b) => a + b, 0)).toBe(16);
  });

  it("metadata carries tier + seqs for client ranking (S2)", () => {
    for (const r of FIVE) {
      const md = JSON.parse(payloadFor(r).metadata);
      expect(md.tier).toBe(r.tier);
      expect(md.seqs).toBe(r.seqs);
      // The engine metadata keeps its own maxConcurrency; it is not admission.
      expect(typeof md.model).toBe("string");
    }
    const tiers = FIVE.map((r) => JSON.parse(payloadFor(r).metadata).tier);
    expect(tiers).toEqual(["5090", "5090", "5090", "x99-fallback", "x99-fallback"]);
  });

  it("capacity is literal: --print-capacity answers the container's own number", () => {
    for (const r of FIVE) {
      expect(capacityFor(r)).toBe(r.capacity);
    }
  });

  it("retires RUNNER_CAPACITY=auto instead of deriving from the router pool", () => {
    // ADAAAA-8553 S1: the pool parser (and its decide-router.conf pin) is gone;
    // an old `auto` deployment must fail loudly, not publish a guessed ceiling.
    let status = 0;
    let stderr = "";
    try {
      execFileSync("python3", [registrar, "--print-capacity"], {
        encoding: "utf8",
        env: { ...process.env, RUNNER_CAPACITY: "auto" },
      });
    } catch (err: any) {
      status = err.status;
      stderr = String(err.stderr ?? "");
    }
    expect(status).not.toBe(0);
    expect(stderr).toMatch(/literal integer|auto pool derivation is retired/);
  });

  it("the x99 compose sidecars pin both registrations literally", () => {
    const x99 = serviceBlock("registrar-decide-x99");
    expect(x99).toContain("RUNNER_ID=highlights-decide-x99");
    expect(x99).toContain("RUNNER_URL=http://decide:8081");
    expect(x99).toContain("RUNNER_HEALTH_URL=/health");
    expect(x99).toContain("RUNNER_CAPACITY=2");
    expect(x99).toContain("RUNNER_PROXY=0");
    expect(x99).toContain('"tier": "x99-fallback"');

    const x99b = serviceBlock("registrar-decide-x99-b");
    expect(x99b).toContain("RUNNER_ID=highlights-decide-x99-b");
    expect(x99b).toContain("RUNNER_URL=http://decide-b:8081");
    expect(x99b).toContain("RUNNER_CAPACITY=2");
    expect(x99b).toContain("RUNNER_PROXY=0");

    // The aggregate sidecar is retired; nothing derives capacity from a pool.
    expect(compose).not.toMatch(/\n  registrar-decide:\n/);
    expect(compose).not.toContain("RUNNER_CAPACITY=auto");
    expect(compose).not.toContain("RUNNER_AUTO_CONF=");
  });

  it("the 5090 host script starts one registrar per worker with the S0-proven LAN addresses", () => {
    expect(runScript).toMatch(/for i in 1 2 3/);
    expect(runScript).toContain('RUNNER_ID="highlights-decide-5090-$i"');
    expect(runScript).toMatch(/port=\$\(\(8090 \+ i\)\)/);
    expect(runScript).toContain('RUNNER_URL="$runner_url"');
    expect(runScript).toContain('ORCH_URL=${ORCH_URL:-https://192.168.1.6:8935}');
    expect(runScript).toContain('WORKER_HOST=${WORKER_HOST:-192.168.1.151}');
    expect(runScript).toContain('CAPACITY=${RUNNER_CAPACITY_5090:-4}');
    expect(runScript).toContain('-e RUNNER_HEALTH_URL=/health');
    expect(runScript).toContain('"tier": "5090"');
    expect(runScript).toContain('"seqs": 4');
    // The secret is handed by NAME from the caller's environment and never
    // printed, so it cannot land in a command line or a log.
    expect(runScript).toMatch(/-e ORCH_SECRET \\/);
    // A warning may NAME the variable; no echo may EXPAND its value.
    expect(runScript).not.toMatch(/echo[^\n]*\$\{?ORCH_SECRET\b/);
  });
});

describe("per-container health and unregister (ADAAAA-8553 S1)", () => {
  it("an unhealthy container unregisters only its own id; a healthy peer keeps heartbeating", () => {
    // Two registrar instances = two containers. Each probes only its own
    // RUNNER_URL; when one dies, only that id is released.
    const harness = String.raw`
import importlib.util, json, sys

spec = importlib.util.spec_from_file_location("reg", sys.argv[1])
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

def cfg(rid, url, cap):
    return m.RunnerConfig({
        "RUNNER_ID": rid, "RUNNER_APP": "highlights-live/decide",
        "RUNNER_URL": url, "RUNNER_HEALTH_URL": "/health",
        "RUNNER_MODE": "single-shot", "RUNNER_CAPACITY": str(cap),
    })

a = m.Registrar(cfg("highlights-decide-5090-1", "http://192.168.1.151:8091", 4))
b = m.Registrar(cfg("highlights-decide-x99-b", "http://decide-b:8081", 2))
calls = []

def fake(method, path, auth, body=None):
    body = body or {}
    calls.append({"method": method, "path": path,
                  "runner_id": body.get("runner_id"),
                  "capacity": body.get("capacity"),
                  "status": body.get("status"),
                  "url": body.get("runner_url")})
    if path == "/runners/heartbeat":
        return 200, {"heartbeat_secret": "hb"}
    return 204, {}

for r in (a, b):
    r._request = fake

a.healthy = lambda: True
b.healthy = lambda: False
b.registered = True          # b was registered, then its container stopped answering
b.heartbeat_secret = "hb"

a.tick()   # healthy -> heartbeat
b.tick()   # unhealthy -> unregister ONLY b
a.tick()   # peer is untouched

print(json.dumps({
    "calls": calls,
    "healthA": a.cfg.health_target(),
    "healthB": b.cfg.health_target(),
    "registeredA": a.registered,
    "registeredB": b.registered,
}))
`;
    const out = execFileSync("python3", ["-c", harness, registrar], { encoding: "utf8" });
    const result = JSON.parse(out.trim().split("\n").pop()!);

    const unregisters = result.calls.filter((c: any) => c.method === "POST" && c.path.endsWith("/unregister"));
    // Exactly ONE unregister, for the dead container's id — never the peer's.
    expect(unregisters).toHaveLength(1);
    expect(unregisters[0].path).toBe("/runners/highlights-decide-x99-b/unregister");

    const heartbeats = result.calls.filter((c: any) => c.path === "/runners/heartbeat");
    expect(heartbeats).toHaveLength(2);
    for (const hb of heartbeats) {
      expect(hb.runner_id).toBe("highlights-decide-5090-1");
      expect(hb.capacity).toBe(4);
      expect(hb.status).toBe("ready");
      expect(hb.url).toBe("http://192.168.1.151:8091");
    }

    // Each registrar probes ITS OWN container, never a shared/router probe.
    expect(result.healthA).toBe("http://192.168.1.151:8091/health");
    expect(result.healthB).toBe("http://decide-b:8081/health");
    expect(result.healthA).not.toBe(result.healthB);
    expect(result.registeredA).toBe(true);
    expect(result.registeredB).toBe(false);
  });

  it("SIGTERM unregisters that runner's id (graceful shutdown releases only its sessions)", () => {
    // Real process, real HTTP: a fake orchestrator records the calls and a fake
    // worker answers /health. SIGTERM must POST .../unregister for THIS id.
    const harness = String.raw`
import http.server, json, os, signal, subprocess, sys, threading, time

class Registry(http.server.BaseHTTPRequestHandler):
    calls = []
    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self.rfile.read(n) if n else None
        Registry.calls.append(self.path)
        if self.path == "/runners/heartbeat":
            payload = json.dumps({
                "runner_id": "highlights-decide-5090-2",
                "heartbeat_interval": "5s",
                "heartbeat_ttl": "20s",
                "heartbeat_secret": "hb",
                "session_ids": [],
            }).encode()
            self.send_response(200)
        else:
            payload = b""
            self.send_response(204)
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
    def log_message(self, *args):
        pass

class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()
    def log_message(self, *args):
        pass

registry = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Registry)
health = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Health)
for srv in (registry, health):
    threading.Thread(target=srv.serve_forever, daemon=True).start()

env = dict(
    os.environ,
    ORCH_URL="http://127.0.0.1:%d" % registry.server_address[1],
    ORCH_SECRET="test-secret",
    RUNNER_ID="highlights-decide-5090-2",
    RUNNER_APP="highlights-live/decide",
    RUNNER_URL="http://127.0.0.1:%d" % health.server_address[1],
    RUNNER_HEALTH_URL="/health",
    RUNNER_MODE="single-shot",
    RUNNER_PROXY="0",
    RUNNER_CAPACITY="4",
    REGISTRAR_INTERVAL_S="0.2",
    REGISTRAR_LOG_PREFIX="[test]",
)
proc = subprocess.Popen([sys.executable, sys.argv[1]], env=env,
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT)

deadline = time.time() + 10
while time.time() < deadline and "/runners/heartbeat" not in Registry.calls:
    time.sleep(0.05)
proc.send_signal(signal.SIGTERM)
try:
    rc = proc.wait(timeout=10)
except subprocess.TimeoutExpired:
    proc.kill()
    rc = -9
output = proc.stdout.read().decode(errors="replace")
print(json.dumps({"calls": Registry.calls, "rc": rc, "output": output[-800:]}))
`;
    const out = execFileSync("python3", ["-c", harness, registrar], { encoding: "utf8", timeout: 30000 });
    const result = JSON.parse(out.trim().split("\n").pop()!);

    expect(result.calls[0]).toBe("/runners/heartbeat");
    expect(result.calls).toContain("/runners/highlights-decide-5090-2/unregister");
    // The unregister is for THIS runner only and the daemon exits cleanly.
    const unregisters = result.calls.filter((p: string) => p.endsWith("/unregister"));
    expect(unregisters).toEqual(["/runners/highlights-decide-5090-2/unregister"]);
    expect(result.rc).toBe(0);
  });
});

describe("five registrars against a registry (AC1/AC2 semantics, ADAAAA-8553 S1)", () => {
  it("lists 4/4/4/2/2 and isolates a stopped registrar to its own id", () => {
    // A fake go-livepeer registry implements the dynamic contract this ticket
    // relies on: upsert by runner_id, heartbeat_secret after the first
    // registration, unregister removes ONLY that id, and an entry expires TTL
    // seconds after its last heartbeat. Five real registrar processes run
    // against it, so AC1 (five ids, capacities 4/4/4/2/2, shared app) and the
    // registrar half of AC2 (stop one -> only that id disappears) are exercised
    // end to end without touching the box.
    const harness = String.raw`
import http.server, json, os, signal, subprocess, sys, threading, time

TTL = 2.0
INTERVAL = 0.2
lock = threading.Lock()
runners = {}
secrets = {}

class Registry(http.server.BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(n) if n else b""
        if self.path == "/runners/heartbeat":
            payload = json.loads(raw)
            rid = payload["runner_id"]
            auth = self.headers.get("authorization", "")
            with lock:
                new = rid not in runners
                if new and auth != "orch-secret":
                    return self._json(401, {"error": "bad registration auth"})
                if not new and auth not in ("orch-secret", secrets.get(rid)):
                    return self._json(401, {"error": "bad heartbeat auth"})
                runners[rid] = {"payload": payload, "expires": time.time() + TTL}
                if new:
                    secrets[rid] = "hb-" + rid
                secret = secrets[rid]
            return self._json(200, {
                "runner_id": rid, "heartbeat_interval": "0.2s",
                "heartbeat_ttl": "2s", "heartbeat_secret": secret,
                "session_ids": [],
            })
        if self.path.startswith("/runners/") and self.path.endswith("/unregister"):
            rid = self.path[len("/runners/"):-len("/unregister")]
            with lock:
                runners.pop(rid, None)
            self.send_response(204)
            self.send_header("content-length", "0")
            self.end_headers()
            return
        self._json(404, {"error": "not found"})

    def log_message(self, *args):
        pass

class Health(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("content-length", "0")
        self.end_headers()
    def log_message(self, *args):
        pass

def visible():
    now = time.time()
    with lock:
        return sorted(
            [rid, r["payload"]["capacity"], r["payload"]["app"],
             r["payload"]["status"], r["payload"]["runner_url"]]
            for rid, r in runners.items() if r["expires"] > now
        )

registry = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Registry)
threading.Thread(target=registry.serve_forever, daemon=True).start()

FIVE = [
    ("highlights-decide-5090-1", "http://192.168.1.151:8091", 4),
    ("highlights-decide-5090-2", "http://192.168.1.151:8092", 4),
    ("highlights-decide-5090-3", "http://192.168.1.151:8093", 4),
    ("highlights-decide-x99", "http://decide:8081", 2),
    ("highlights-decide-x99-b", "http://decide-b:8081", 2),
]

procs = {}
health_servers = {}
for rid, advertised_url, cap in FIVE:
    health = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Health)
    health_servers[rid] = health
    threading.Thread(target=health.serve_forever, daemon=True).start()
    env = dict(
        os.environ,
        ORCH_URL="http://127.0.0.1:%d" % registry.server_address[1],
        ORCH_SECRET="orch-secret",
        RUNNER_ID=rid,
        RUNNER_APP="highlights-live/decide",
        RUNNER_URL="http://127.0.0.1:%d" % health.server_address[1],
        RUNNER_HEALTH_URL="/health",
        RUNNER_MODE="single-shot",
        RUNNER_PROXY="0",
        RUNNER_CAPACITY=str(cap),
        RUNNER_METADATA=json.dumps({"tier": "5090" if cap == 4 else "x99-fallback", "seqs": cap}),
        REGISTRAR_INTERVAL_S=str(INTERVAL),
        REGISTRAR_LOG_PREFIX="[test]",
    )
    procs[rid] = subprocess.Popen([sys.executable, sys.argv[1]], env=env,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def wait_for(predicate, timeout=10.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False

ok = wait_for(lambda: len(visible()) == 5)
initial = visible()

# Stop ONE 5090 registrar gracefully: its unregister must remove only its id.
procs["highlights-decide-5090-2"].send_signal(signal.SIGTERM)
procs["highlights-decide-5090-2"].wait(timeout=10)
wait_for(lambda: all(row[0] != "highlights-decide-5090-2" for row in visible()))
after_term = visible()

# Kill a second registrar WITHOUT unregister: the registry's TTL must expire
# only that id, leaving the healthy peers visible.
procs["highlights-decide-5090-3"].kill()
procs["highlights-decide-5090-3"].wait(timeout=10)
wait_for(lambda: all(row[0] != "highlights-decide-5090-3" for row in visible()), timeout=8)
after_kill = visible()

for rid, proc in procs.items():
    if proc.poll() is None:
        proc.send_signal(signal.SIGTERM)
for proc in procs.values():
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()

print(json.dumps({"registeredOk": ok, "initial": initial,
                  "afterTerm": after_term, "afterKill": after_kill}))
`;
    const out = execFileSync("python3", ["-c", harness, registrar], {
      encoding: "utf8",
      timeout: 60000,
    });
    const result = JSON.parse(out.trim().split("\n").pop()!);

    // AC1: all five ids, capacity 4/4/4/2/2, app=highlights-live/decide.
    expect(result.registeredOk).toBe(true);
    expect(result.initial.map((r: any[]) => r[0])).toEqual(FIVE.map((r) => r.id));
    expect(result.initial.map((r: any[]) => r[1])).toEqual([4, 4, 4, 2, 2]);
    for (const row of result.initial) {
      expect(row[2]).toBe("highlights-live/decide");
      expect(row[3]).toBe("ready");
    }

    // AC2 (registrar half): graceful stop removes ONLY that id.
    expect(result.afterTerm.map((r: any[]) => r[0])).toEqual([
      "highlights-decide-5090-1",
      "highlights-decide-5090-3",
      "highlights-decide-x99",
      "highlights-decide-x99-b",
    ]);
    expect(result.afterTerm.every((r: any[]) => r[3] === "ready")).toBe(true);

    // Crash without unregister: TTL expiry removes ONLY that id; peers stay.
    expect(result.afterKill.map((r: any[]) => r[0])).toEqual([
      "highlights-decide-5090-1",
      "highlights-decide-x99",
      "highlights-decide-x99-b",
    ]);
    expect(result.afterKill.map((r: any[]) => r[1])).toEqual([4, 2, 2]);
  });
});

