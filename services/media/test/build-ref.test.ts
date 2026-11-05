import { describe, expect, it } from "vitest";
import { loadConfig, resolveBuildRef } from "../src/config";
import { sourceDigest } from "../src/source-digest";

// ADAAAA-8050: `restarts.buildRef` read "unknown" on a boot taken outside
// `./docker/deploy.sh`, because that wrapper was the only caller that exported
// the revision — so a node served code its own /health could not name. The
// resolver now falls back to the served-source digest (ADAAAA-8048), which is a
// property of the source rather than of the deploy path. These tests pin the
// resolution order and, critically, that the Dockerfile's old "unknown" build-arg
// default is treated as ABSENT rather than as an identity.

const served = (digest: string | null) => () => ({ digest, files: 1 });

describe("media buildRef resolution (ADAAAA-8050)", () => {
  const realDigest = sourceDigest().digest;
  const expectedShort = (realDigest ?? "").replace(/^sha256:/, "").slice(0, 12);

  it("keeps a deploy-injected revision as the reported build", () => {
    expect(resolveBuildRef({ BUILD_REF: "815769c" }, served(realDigest))).toEqual({
      buildRef: "815769c",
      buildRefSource: "env:BUILD_REF",
    });
    expect(resolveBuildRef({ MEDIA_BUILD_REF: "deadbee", BUILD_REF: "815769c" }, served(null))).toEqual({
      buildRef: "deadbee",
      buildRefSource: "env:MEDIA_BUILD_REF",
    });
  });

  it("does NOT treat the old 'unknown' build-arg default as a revision", () => {
    // This is the exact regression: the compose build arg defaulted to
    // "unknown", which the old `env.BUILD_REF || "unknown"` chain published
    // verbatim on a real, identifiable build.
    for (const placeholder of ["unknown", "UNKNOWN", "", "   "]) {
      expect(resolveBuildRef({ BUILD_REF: placeholder }, served(realDigest))).toMatchObject({
        buildRefSource: "served-source-digest",
      });
    }
    expect(realDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(resolveBuildRef({ BUILD_REF: "unknown" }, served(realDigest)).buildRef).toBe(`src-${expectedShort}`);
  });

  it("names an unstamped boot from the served-source digest, never 'unknown'", () => {
    const identity = resolveBuildRef({}, served(realDigest));
    expect(identity.buildRef).toBe(`src-${expectedShort}`);
    expect(identity.buildRefSource).toBe("served-source-digest");
    // The digest is the same one /health publishes, so the two agree.
    expect(identity.buildRef.slice(4)).toBe(expectedShort);
  });

  it("reports 'unknown' only when even the served source could not be read", () => {
    expect(resolveBuildRef({ BUILD_REF: "unknown" }, served(null))).toEqual({
      buildRef: "unknown",
      buildRefSource: "none",
    });
  });

  it("loadConfig wires the resolver against the tree it is running", () => {
    // In this worktree the module reads services/media/src, so the fallback is
    // a real digest — the same value /health reports as sourceDigest.
    const cfg = loadConfig({ BUILD_REF: "unknown" });
    expect(cfg.buildRefSource).toBe("served-source-digest");
    expect(cfg.buildRef).toBe(`src-${expectedShort}`);

    // A sanctioned deploy wins over the digest.
    expect(loadConfig({ BUILD_REF: "1a2288b" })).toMatchObject({
      buildRef: "1a2288b",
      buildRefSource: "env:BUILD_REF",
    });
  });
});
