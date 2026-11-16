// ADAAAA-9101 / ADAAAA-9131: the public-tree hygiene guard.
//
// docs/README.md "Public-document hygiene" is the rule: the repository is
// public, so no tracked file may name a real endpoint. This test runs that rule
// over the WHOLE tracked tree in the normal test job (`npm test`), so a new real
// host / LAN address / contact address fails the build instead of being
// published. The production values belong in the box docker/.env (untracked).
//
// ADAAAA-9131: the guard used to see only hosts that were part of a URL or a
// `user@host` address, so a BARE fleet machine name stayed invisible while the
// script's header claimed a management host was enforced. The cases below pin
// each denied class from the ADAAAA-9102 ruling §4, including the exact shape
// that leaked, so the next regression is a red test instead of a green guard.
import { describe, it, expect } from "vitest";
import { scanRepo, scanText } from "../../../scripts/check-docs-hygiene.mjs";

describe("public-tree hygiene guard (ADAAAA-9101)", () => {
  it("the tracked tree names no real endpoint", () => {
    const report = scanRepo();
    const findings = report.violations.map((v) => `${v.file}:${v.line} ${v.kind} ${v.value}`);
    // Print the whole list on failure: one line per finding is the fix list.
    expect(findings).toEqual([]);
    expect(report.scanned).toBeGreaterThan(500);
  });

  it("flags a new private address, production host and contact address", () => {
    // The guard scans THIS file too, so the fixture endpoints are assembled at
    // runtime instead of being written as literals in the public tree.
    const ip = "192.168." + "7.9";
    const prodHost = "prod-box" + ".dpn" + ".gg";
    const contact = "ops" + "@ad-astra" + ".network";
    const text = [`ORCH_URL=https://${ip}:8935`, `EDGE_URL=https://${prodHost}`, `mail ${contact}`].join("\n");
    const found = scanText(text, "fixture.txt").map((v) => `${v.kind} ${v.value}`);
    expect(found).toContain(`private-ipv4 ${ip}`);
    expect(found).toContain(`endpoint-url ${prodHost}`);
    expect(found).toContain(`endpoint-email ${contact}`);
  });

  it("allows the documented exceptions", () => {
    const text = [
      "EMAIL_ALLOW_IPS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.1",
      "PUBLIC_URL=https://app.example.com",
      "MEDIA_URL=http://media:4070",
      "admin@highlights.local",
      "https://github.com/ad-astra-video/highlights.live",
      // ADAAAA-9102 ruling R3: the two public edge origins are allowlisted with a
      // documented reason (CT-logged, customer-facing), while LAN/ssh/home stay denied.
      "PUBLIC_BASE_URL=https://highlights-server.dpn.gg",
      "MEDIA_PUBLIC_BASE_URL=https://highlights-media.dpn.gg",
      // Documented placeholders and service names, not endpoints.
      "--cyc-box-cmd 'python3 .../komodo.py <DECIDE_BOX>'",
      "--box-cmd 'python3 .../komodo.py gpu-box'",
      "--driver-cmd 'cd /home/operator/highlights.live && sh docker/qa-drive-8035.sh'",
      "postgres://user:***@host:5432/dbname",
    ].join("\n");
    expect(scanText(text, "ok.txt")).toEqual([]);
  });
});

describe("denied classes from ruling §4 (ADAAAA-9131)", () => {
  it("flags a BARE fleet hostname with no scheme and no @", () => {
    // The regression that shipped: `evals/funded_leg/README.md` carried the bare
    // 5090 box name in a `--cyc-box-cmd` example. No `http://`, no `user@`, so
    // the three old rules could not see it.
    const box = "ai-" + "server-" + "fixture-1";
    const other = "livepeer-" + "ai-" + "fixture-x";
    const text = [
      `--cyc-box-cmd 'python3 .../komodo.py ${box}'`,
      `the three workers on ${other} are PRIMARY`,
    ].join("\n");
    const found = scanText(text, "fixture.txt").map((v) => `${v.kind} ${v.value}`);
    expect(found).toContain(`internal-hostname ${box}`);
    expect(found).toContain(`internal-hostname ${other}`);
  });

  it("flags the operator home path but not the documented placeholder", () => {
    const account = "opera" + "tor7";
    const found = scanText(`cd /home/${account}/highlights.live && sh docker/x.sh`, "fixture.txt").map(
      (v) => `${v.kind} ${v.value}`,
    );
    expect(found).toContain(`operator-home-path /home/${account}`);
    expect(scanText("cd /home/operator/highlights.live", "ok.txt")).toEqual([]);
  });

  it("flags a bare ssh alias and an ssh port in a port context", () => {
    const alias = "qa-" + "box" + "7";
    const port = "12" + "22";
    const text = [
      `ssh ${alias} 'docker ps'`,
      `ssh -p ${port} ${alias}`,
      `scp --port=${port} /tmp/a ${alias}:/tmp/`,
      `Host ${alias}\n  Port ${port}\n  User deploy`,
    ].join("\n");
    const found = scanText(text, "fixture.txt").map((v) => `${v.kind} ${v.value}`);
    expect(found).toContain(`ssh-target ${alias}`);
    expect(found.filter((f) => f === `ssh-port ${port}`).length).toBeGreaterThanOrEqual(3);
  });

  it("does not flag a bare number, a tier label or a data field as a port", () => {
    // Recorded eval results carry timing numbers that must stay replayable
    // (ruling §7.3) and the decide fleet names its tiers after the hardware.
    const text = [
      `"t": 1222.0,`,
      `RUNNER_METADATA='{"tier": "5090", "seqs": 4}'`,
      `RUNNER_ID=highlights-decide-5090-1`,
      `uvicorn app:app --host 0.0.0.0 --port 8080`,
      `pool is proxied by decide-pool-8183 to the workers`,
      `host, which is not reachable from x99 (ssh and docker TCP are closed)`,
      `read allowance must not run out 18 % into the clip (measured 40@seq 55)`,
      `email: "dev@adastra", role: "admin_readonly"`,
    ].join("\n");
    expect(scanText(text, "ok.txt")).toEqual([]);
  });
});

describe("a fleet host inside a URL, dotless and dotted (ADAAAA-9134)", () => {
  it("flags a dotless fleet host used as a URL host, with and without a port", () => {
    // The gap: rule 2 skipped EVERY dotless host as a compose service name, so
    // `http://<family>:8000/v1` was invisible, and rule 4 could not match a
    // token preceded by `/`. Both forms must be a finding, not a service name.
    const box = "ai-" + "server-" + "fixture-2";
    const other = "livepeer-" + "ai" + "-fixture-y";
    const text = [`curl -s http://${box}:8000/v1/models`, `MEDIA_URL=http://${other}/live`].join("\n");
    const found = scanText(text, "fixture.txt").map((v) => `${v.kind} ${v.value}`);
    expect(found).toContain(`internal-hostname ${box}`);
    expect(found).toContain(`internal-hostname ${other}`);
  });

  it("reports the whole token for a dotted fleet host, not a truncated prefix", () => {
    // The old lookahead rejected a following `.`, so the family match backtracked
    // to the shorter prefix and a fixer was pointed at a token that is not a host.
    const box = "ai-" + "server-" + "fixture-3";
    const fqdn = `${box}.internal`;
    expect(scanText(`worker on ${fqdn}`, "fixture.txt").map((v) => `${v.kind} ${v.value}`)).toEqual([
      `internal-hostname ${fqdn}`,
    ]);
  });

  it("keeps the compose-service exemption and the documented exceptions", () => {
    const text = [
      "MEDIA_URL=http://media:4070",
      "RUNNER_URL=http://decide-router:8081",
      "ORCH_URL=http://fallback-orch",
      "DB_URL=http://db:5432",
      "API_URL=http://server:3000",
      "postgres://user:***@host:5432/dbname",
      "PUBLIC_URL=https://app.example.com",
    ].join("\n");
    expect(scanText(text, "ok.txt")).toEqual([]);
  });
});
