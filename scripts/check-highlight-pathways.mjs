#!/usr/bin/env node
// ADAAAA-8881: keep docs/highlight-pathways.md honest.
//
// The map of highlight-identification pathways is only useful if it cannot rot.
// This check fails when:
//   1. a repo path the map cites no longer exists (rename / delete), or a cited
//      line number is beyond the file's current length;
//   2. a number in the map's machine-checked invariant block no longer matches
//      the constant in the source file it names.
//
// The failure text names the file, the symbol, the map's value and the code's
// value, so the fix is "update the map" or "update the table row" — never a
// silent pass. Run it with `pnpm check:pathways`; `pnpm test` runs it too
// (services/server/test/highlight-pathways-map.test.ts).
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAP = path.join(ROOT, "docs/highlight-pathways.md");
const START = "<!-- pathway-invariants:start -->";
const END = "<!-- pathway-invariants:end -->";
// Paths the map is allowed to cite. Anything else in backticks is prose
// (`POST /audio`, `pnpm test`) and is not checked.
const CITED_PREFIXES = ["services/", "packages/", "webapp/", "docs/", "scripts/", "evals/"];
const CITED_EXT = /\.(?:ts|tsx|mts|py|mjs|md|json)$/;

function fail(lines) {
  console.error("docs/highlight-pathways.md is STALE:");
  for (const l of lines) console.error("  - " + l);
  console.error(
    "\nFix the map (or the invariant table) in the same change that moved the code, then re-run `pnpm check:pathways`."
  );
  process.exit(1);
}

if (!existsSync(MAP)) fail(["the map file itself is missing"]);

const doc = readFileSync(MAP, "utf8");

// --- 1. invariant block ------------------------------------------------------
const startAt = doc.indexOf(START);
const endAt = doc.indexOf(END);
if (startAt === -1 || endAt === -1 || endAt < startAt) {
  fail([`the machine-checked block (${START} … ${END}) is missing or malformed`]);
}

let block;
try {
  block = JSON.parse(doc.slice(startAt + START.length, endAt).replace(/```json|```/g, "").trim());
} catch (err) {
  fail([`the invariant block is not valid JSON: ${err.message}`]);
}
if (!Array.isArray(block.invariants) || block.invariants.length === 0) {
  fail(["the invariant block carries no invariants"]);
}

const problems = [];
for (const inv of block.invariants) {
  const { file, symbol, value } = inv;
  if (!file || !symbol || value === undefined) {
    problems.push(`invariant entry is incomplete: ${JSON.stringify(inv)}`);
    continue;
  }
  const abs = path.join(ROOT, file);
  if (!existsSync(abs)) {
    problems.push(`${file}: cited by invariant \`${symbol}\` but the file does not exist`);
    continue;
  }
  const src = readFileSync(abs, "utf8");
  // Prefer the DECLARATION over a bare mention: comments in these files quote
  // historical values (`LIVE_OBSERVE_MAX_FRAMES=4` in a docblock), so an
  // any-match rule would grade the comment instead of the constant.
  const sym = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    // TS/JS: `export const X = 8` / `const X = 8 as const`
    new RegExp(`(?:export\\s+)?const\\s+${sym}\\s*(?::[^=]+)?=\\s*([0-9]+(?:\\.[0-9]+)?)`),
    // Python dataclass / annotated assignment: `x: float = 5.0`
    new RegExp(`^\\s*${sym}\\s*:\\s*[A-Za-z_][\\w.\\[\\]]*\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"),
    // Plain assignment, no type: `X = 60.0`
    new RegExp(`^\\s*${sym}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)`, "m"),
  ];
  let actualText;
  for (const re of patterns) {
    const hit = re.exec(src);
    if (hit) {
      actualText = hit[1];
      break;
    }
  }
  if (actualText === undefined) {
    problems.push(`${file}: invariant \`${symbol}\` = ${value} — declaration not found in the file (renamed or removed?)`);
    continue;
  }
  const actual = Number(actualText);
  const expected = Number(value);
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 1e-9) {
    problems.push(
      `${file}: \`${symbol}\` is ${actualText} in code but the map says ${value} — update the map (§9) or the invariant row`
    );
  }
}

// --- 2. cited paths + line bounds -------------------------------------------
const cited = new Set();
const citeRe = /`([A-Za-z0-9_./-]+?)(?::(\d+))?`/g;
for (const m of doc.matchAll(citeRe)) {
  const [, p, line] = m;
  if (!CITED_PREFIXES.some((prefix) => p.startsWith(prefix))) continue;
  if (!CITED_EXT.test(p)) continue;
  cited.add(`${p}${line ? ":" + line : ""}`);
}

for (const entry of cited) {
  const [p, line] = entry.split(":");
  const abs = path.join(ROOT, p);
  if (!existsSync(abs)) {
    problems.push(`${p}: cited as \`${entry}\` but the file does not exist`);
    continue;
  }
  if (line) {
    const total = readFileSync(abs, "utf8").split("\n").length;
    if (Number(line) > total) {
      problems.push(`${p}: map cites line ${line}, file has ${total} lines`);
    }
  }
}

// --- 3. named anchors -------------------------------------------------------
// The map writes `path:line` (`identifier`) when it points at a specific
// function/constant. Verify the identifier is actually at that line (±6), and
// report where it really lives so the anchor is a one-line fix.
const anchorRe = /`([A-Za-z0-9_./-]+?\.(?:ts|py|mjs)):(\d+)`\s*\(\s*`([^`]+)`\s*\)/g;
for (const m of doc.matchAll(anchorRe)) {
  const [, p, lineText, ident] = m;
  const abs = path.join(ROOT, p);
  if (!existsSync(abs)) continue; // already reported above
  const lines = readFileSync(abs, "utf8").split("\n");
  const at = Number(lineText);
  const window = lines.slice(Math.max(0, at - 7), at + 6).join("\n");
  if (window.includes(ident)) continue;
  const real = lines.findIndex((l) => l.includes(ident));
  problems.push(
    `${p}: map anchors \`${ident}\` at line ${at}, but it is ${real === -1 ? "not in the file" : `at line ${real + 1}`}`
  );
}

if (problems.length) fail(problems);

console.log(
  `ok: docs/highlight-pathways.md is consistent (${block.invariants.length} invariants, ${cited.size} cited paths)`
);
