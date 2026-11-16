#!/usr/bin/env node
/**
 * ADAAAA-9101 / ADAAAA-9131: enforce the "Public-document hygiene" rule from
 * docs/README.md over the WHOLE tracked tree, not just docs/.
 *
 * The repository is public, so a tracked file must not name a real endpoint:
 * a private IPv4 address, a real production/management host (bare or in a URL),
 * a `user@<host>` address, the operator's home directory, an ssh target, or an
 * ssh port. This script is the guard behind that rule and runs in the test
 * job (`npm test` -> docs-hygiene.test.ts), so a new real endpoint fails the
 * build instead of being published.
 *
 * ADAAAA-9131: the guard previously only looked at hosts that were part of a
 * URL or an `user@host` address, so a BARE machine name was
 * invisible to it while its header claimed a "real production/management host"
 * was enforced. The denied classes in the ADAAAA-9102 ruling §4 are now
 * enforced as classes, not as a hand-kept list of literals (putting the real
 * literals in this public file would re-publish them):
 *
 *   1. private-ipv4      — 10/8, 172.16/12, 192.168/16 that is NOT written as a
 *                          documented CIDR default (`10.0.0.0/8`, ...);
 *   2. endpoint-url      — `http(s)://host` whose host is not allowlisted;
 *   3. endpoint-email    — `user@host` whose host (dotted OR bare) is not
 *                          allowlisted / a documented placeholder;
 *   4. internal-hostname — a bare token from a deploy-fleet hostname family
 *                          (see INTERNAL_HOSTNAME_FAMILIES), which has no scheme
 *                          and no `@` and so matches none of rules 1–3;
 *   5. operator-home-path — `/home/<account>` for a real operator account (the
 *                          documented placeholder is `/home/operator`);
 *   6. ssh-target        — a bare `ssh <alias>` target that is not allowlisted,
 *                          not a placeholder and not read from the environment;
 *   7. ssh-port          — a port number in a context that MAKES it a port
 *                          (`ssh -p N`, `--port=N`, an ssh_config `Port N`,
 *                          `ssh://<host>:N`, `user@<host>:N`). A bare number is not
 *                          flagged: recorded eval results contain timing
 *                          numbers that must stay replayable.
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

/**
 * Bare (single-label) host tokens that are documentation placeholders, not
 * endpoints. `docs/README.md` "Public-document hygiene" tells an author to write
 * `<GPU_BOX_HOST>` / `user@host`; this list is what makes the placeholder legal.
 */
export const ALLOWED_BARE_HOSTS = [
  "host", // `user@host` in prose and connection-string templates
  "your-host",
  "box", // `komodo <box>` in the helper's own usage text
  "gpu-box", // the komodo helper's local alias for the deploy box (documented placeholder)
  "decide-host",
  "operator", // the placeholder account in `/home/operator/...`
  "box-ssh-alias", // docs/DEPLOY.md placeholder for the ssh target
  "example",
  "localhost",
];

/**
 * Deploy-fleet hostname families. The fleet names its boxes by a prefix pair in
 * two families; a bare token from either family is a management host with no
 * scheme and no `@`, so rules 1–3 cannot see it. Expressed as families (and
 * assembled at runtime, below) so this public file does not re-publish a
 * specific machine name.
 */
const family = (...parts) => new RegExp(`^${parts.join("-")}(?:[-.][A-Za-z0-9]+)*$`, "i");
export const INTERNAL_HOSTNAME_FAMILIES = [
  family("ai", "server"), // GPU/decide box family
  family("livepeer", "ai"), // x99 box family
];

/** Real operator/service accounts whose home path may be documented. */
export const ALLOWED_HOME_ACCOUNTS = [
  "operator", // documented placeholder (`/home/operator/...`)
  "user",
  "runner",
  "node", // distroless/service accounts used by the container images
  "app",
  "paperclip", // the agent runtime's own sandbox home, not the deploy operator
  "nonroot",
];

/** Private IPv4 literal that is not a documented CIDR default. */
const PRIVATE_IPV4 =
  /(?<![\d.])(?:(?:192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?![\d.])(?!\/\d{1,2}\b)/g;
/** URL host, keeping the scheme-relative form out (compose service names have no dot). */
const URL_HOST = /https?:\/\/([A-Za-z0-9_.\-]+)/g;
/** a `user@host` address, dotted host */
const EMAIL = /\b[A-Za-z0-9_.+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})/g;
/** a `user@host` address with a BARE (single-label) host, e.g. `user@box-ssh-alias`. */
const EMAIL_BARE = /\b[A-Za-z][A-Za-z0-9_.+\-]*@([a-z][a-z0-9_\-]*)(?![.\w])/g;
/** a bare hostname-ish token (letters/digits/hyphens, at least one hyphen or digit). */
const BARE_HOSTNAME = /(?<![\w@$./<])([A-Za-z][A-Za-z0-9]*(?:-[A-Za-z0-9]+)+|[A-Za-z0-9]+x[0-9]+[A-Za-z0-9-]*)(?![\w.@/<])/g;
/** `/home/<account>` — a real operator home directory names the account. */
const HOME_PATH = /(?<![\w./<])\/home\/([A-Za-z0-9_.\-]+)/g;
/** `ssh [-o opt] [-p N] <target>` — a bare ssh alias, no dot. */
const SSH_TARGET = /\bssh(?:\s+-[A-Za-z][A-Za-z0-9-]*(?:[=\s]\S+)?)*\s+([A-Za-z0-9_][A-Za-z0-9_.\-]*)(?=[\s'";|&)]|$)/g;
/** port-in-a-port-context patterns; only applied to lines that are ssh-ish or are directives. */
const SSH_CONTEXT = /\b(?:ssh|scp|sftp|sshd)\b/i;
const PORT_CONTEXTS = [
  /(?:^|[\s`'"(])(?:-p|--port)[=\s]+(\d{1,5})(?![\d.])/g, // ssh -p <port>, --port=<port>
  /^\s*Port\s+(\d{1,5})\s*$/g, // ssh_config `Port <port>`
  /\bssh:\/\/[^\s/]+:(\d{1,5})/g, // ssh://<host>:<port>
  /\b[A-Za-z0-9_.+\-]+@[A-Za-z0-9.\-]+:(\d{1,5})(?![\d])/g, // user@<host>:<port>
];

export function isAllowedHost(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return ALLOWED_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

function isPlaceholderToken(token) {
  return token.startsWith("<") || token.includes("$") || token.startsWith("{");
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
    for (const match of line.matchAll(EMAIL_BARE)) {
      const host = match[1].toLowerCase();
      if (isAllowedHost(host) || ALLOWED_BARE_HOSTS.includes(host)) continue;
      // A bare host in `user@host` form is an ssh target, not an email address.
      // Hostname-shaped only (digit/hyphen): `dev@adastra` is an e-mail fixture
      // and `40@seq` is measurement prose, not a host.
      if (!/[-0-9]/.test(host)) continue;
      add(index, (match.index ?? 0) + 1, "endpoint-email", match[0]);
    }
    for (const match of line.matchAll(BARE_HOSTNAME)) {
      const token = match[1];
      if (isAllowedHost(token) || ALLOWED_BARE_HOSTS.includes(token.toLowerCase())) continue;
      if (!INTERNAL_HOSTNAME_FAMILIES.some((family) => family.test(token))) continue;
      add(index, (match.index ?? 0) + 1, "internal-hostname", token);
    }
    for (const match of line.matchAll(HOME_PATH)) {
      const account = match[1].toLowerCase();
      if (ALLOWED_HOME_ACCOUNTS.includes(account)) continue;
      add(index, (match.index ?? 0) + 1, "operator-home-path", match[0]);
    }
    for (const match of line.matchAll(SSH_TARGET)) {
      const target = match[1];
      if (target.includes(".") || isPlaceholderToken(target)) continue; // dotted host -> rule 2/3
      if (isAllowedHost(target) || ALLOWED_BARE_HOSTS.includes(target.toLowerCase())) continue;
      // Only hostname-shaped aliases: a bare word in prose ("ssh and docker
      // TCP are closed") must not read as an ssh target.
      if (!/[0-9-]/.test(target)) continue;
      add(index, (match.index ?? 0) + 1, "ssh-target", target);
    }
    // The port class needs a context that MAKES the number a port. A bare
    // number is a data value (eval timing, sha substring) and stays legal.
    const sshLine = SSH_CONTEXT.test(line);
    for (const pattern of PORT_CONTEXTS) {
      if (!sshLine && !/^\s*Port\s+\d/.test(line) && !/ssh:\/\//.test(pattern.source)) continue;
      for (const match of line.matchAll(pattern)) {
        add(index, (match.index ?? 0) + 1, "ssh-port", match[1]);
      }
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
