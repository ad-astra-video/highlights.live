// ADAAAA-9101: the public-tree hygiene guard.
//
// docs/README.md "Public-document hygiene" is the rule: the repository is
// public, so no tracked file may name a real endpoint. This test runs that rule
// over the WHOLE tracked tree in the normal test job (`npm test`), so a new real
// host / LAN address / contact address fails the build instead of being
// published. The production values belong in the box docker/.env (untracked).
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
    ].join("\n");
    expect(scanText(text, "ok.txt")).toEqual([]);
  });
});
