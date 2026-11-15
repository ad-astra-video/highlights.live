#!/usr/bin/env node
/**
 * ADAAAA-9101: enforce the "Public-document hygiene" rule from
 * docs/README.md over the WHOLE tracked tree, not just docs/.
 *
 * The repository is public, so a tracked file must not name a real endpoint:
 * a private IPv4 address, a real production/management host, or a
 * `user@real-host` address. This script is the guard behind that rule and runs
 * in the test job (`npm test` -> docs-hygiene.test.ts), so a new real endpoint
 * fails the build instead of being published.
 *
 * Rules
 *   1. private IPv4 (10/8, 172.16/12, 192.168/16) that is NOT written as a
 *      documented CIDR default (`10.0.0.0/8`, ...) and is not loopback;
 *   2. any `http(s)://host` whose host is not an allowlisted documentation /
 *      public-reference host;
 *   3. any `user@host` whose domain is not allowlisted.
 *
 * Usage
 *   node scripts/check-docs-hygiene.mjs           # scan the tracked tree
 *   node scripts/check-docs-hygiene.mjs --json    # machine-readable report
 *
 * Exit codes: 0 clean, 1 violations, 2 the scan itself failed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Documentation / public-reference host suffixes. Everything here is either a
 * reserved example domain, a loopback/invalid name, a public content source
 * cited by eval data, or a published product surface (the public repo, the
 * package registries, the placeholder Railway suffix). A real deployment host
 * never belongs on this list — put it in the box .env instead.
 */
export const ALLOWED_HOST_SUFFIXES = [
  // reserved / loopback / container-internal names
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "host.docker.internal",
  "docker.internal",
  "example.com",
  "example.org",
  "example.net",
  "example",
  "test",
  "invalid",
  "local", // mDNS / seeded dev admin (admin@highlights.local)
  // published product surfaces
  "github.com",
  "npmjs.org",
  "nodejs.org",
  "pypi.org",
  "python.org",
  "registry.npmjs.org",
  "vitest.dev",
  "railway.com",
  "railway.app",
  "railway.internal",
  "stripe.test",
  "x.dev",
  "test.dev",
  "highlights.live", // published product site + privacy@/support@/legal@ contacts
  // ADAAAA-9102 ruling R3: these two are PUBLIC edge origins, not secrets —
  // public DNS behind Cloudflare, already in Certificate Transparency, and in
  // users' address bars. Allowlisted (one-line reason each) so a later sweeper
  // does not re-file them; LAN addresses, internal hostnames, ssh targets and
  // operator home paths stay DENIED.
  "highlights-server.dpn.gg", // public server edge: CT-logged DNS, customer-facing origin
  "highlights-media.dpn.gg", // public media edge: CT-logged DNS, customer-facing media origin
  // public content sources cited by eval data
  "wikimedia.org",
  "wikipedia.org",
  "creativecommons.org",
  "voanews.com",
  "paulmillr.com",
  "pytorch.org",
  "archive.org",
  "youtube.com",
  "googlevideo.com",
  "nasa.gov",
  "jaxa.jp",
  "army.mil",
  "dvidshub.net",
  "flickr.com",
  "opencollective.com",
  "tidelift.com",
  "feross.org",
  "patreon.com",
  "w3.org",
  "googleapis.com",
  "gstatic.com",
  "cocodataset.org",
  "pexels.com",
  "videolan.org",
  "vimeo.com",
  "twitter.com",
  "facebook.com",
  "bing.com",
  "tutanota.com",
  "belmontmedia.org",
  "deportes.gov.co",
  "beeldengeluid.nl",
  "kl.nl",
  "openbeelden.nl",
  "hauts-de-seine.fr",
  "foxs.pt",
];

/** Private IPv4 literal that is not a documented CIDR default. */
const PRIVATE_IPV4 =
  /(?<![\d.])(?:(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])(?!\/\d{1,2}\b)/g;
/** URL host, keeping the scheme-relative form out (compose service names have no dot). */
const URL_HOST = /https?:\/\/([A-Za-z0-9_.\-]+)/g;
/** a user@host address */
const EMAIL = /\b[A-Za-z0-9_.+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/g;

export function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/**
 * Scan one text blob. `relPath` only labels the findings.
 * Returns [{ line, column, kind, value }].
 */
export function scanText(text, relPath = "<inline>") {
  const out = [];
  const lines = text.split("\n");
  const add = (index, column, kind, value) => {
    out.push({ file: relPath, line: index + 1, column, kind, value });
  };

  lines.forEach((line, index) => {
    for (const match of line.matchAll(PRIVATE_IPV4)) {
      add(index, (match.index ?? 0) + 1, "private-ipv4", match[0]);
    }
    for (const match of line.matchAll(URL_HOST)) {
      const host = match[1];
      // A host without a dot is a compose service name / bare token, not an endpoint.
      if (!host.includes(".")) continue;
      if (isAllowedHost(host)) continue;
      add(index, (match.index ?? 0) + 1, "endpoint-url", host);
    }
    for (const match of line.matchAll(EMAIL)) {
      const domain = match[1];
      if (isAllowedHost(domain)) continue;
      add(index, (match.index ?? 0) + 1, "endpoint-email", match[0]);
    }
  });
  return out;
}

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz",
  ".mp4", ".webm", ".mp3", ".wav", ".npy", ".npz", ".onnx", ".pt", ".bin", ".woff", ".woff2",
]);

function isBinary(path) {
  const dot = path.lastIndexOf(".");
  if (dot >= 0 && BINARY_EXTENSIONS.has(path.slice(dot).toLowerCase())) return true;
  const buf = readFileSync(path);
  return buf.subarray(0, 8000).includes(0);
}

export function scanRepo(root = fileURLToPath(new URL("..", import.meta.url))) {
  // --cached --others scans tracked files AND untracked-but-not-ignored ones, so
  // a new file carrying a real endpoint is caught before it is ever committed.
  const files = execFileSync("git", ["-C", root, "ls-files", "-z", "-c", "-o", "--exclude-standard"], {
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  const violations = [];
  let scanned = 0;
  for (const rel of files) {
    const abs = `${root}/${rel}`;
    try {
      if (!statSync(abs).isFile()) continue;
      if (isBinary(abs)) continue;
    } catch {
      continue;
    }
    scanned += 1;
    violations.push(...scanText(readFileSync(abs, "utf8"), rel));
  }
  return { scanned, files: files.length, violations };
}

function main() {
  const json = process.argv.includes("--json");
  let report;
  try {
    report = scanRepo();
  } catch (err) {
    console.error(`docs-hygiene: scan failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else if (report.violations.length === 0) {
    console.log(`docs-hygiene: clean (${report.scanned} tracked text files scanned)`);
  } else {
    for (const v of report.violations) {
      console.error(`${v.file}:${v.line}:${v.column}  ${v.kind}  ${v.value}`);
    }
    console.error(
      `\ndocs-hygiene: ${report.violations.length} violation(s) in ${report.scanned} files. ` +
        "The repository is public: replace the real endpoint with a placeholder (docs/README.md " +
        '"Public-document hygiene") and keep the value in the box .env.',
    );
  }
  process.exit(report.violations.length === 0 ? 0 : 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
