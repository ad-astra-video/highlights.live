/**
 * Type surface for scripts/check-docs-hygiene.mjs (ADAAAA-9101). The guard is a
 * plain Node ESM script so `node scripts/check-docs-hygiene.mjs` works without a
 * build; the test job imports it through this declaration.
 */
export interface HygieneViolation {
  file: string;
  line: number;
  column: number;
  kind: "private-ipv4" | "endpoint-url" | "endpoint-email";
  value: string;
}

export interface HygieneReport {
  scanned: number;
  files: number;
  violations: HygieneViolation[];
}

export const ALLOWED_HOST_SUFFIXES: string[];
export function isAllowedHost(host: string): boolean;
export function scanText(text: string, relPath?: string): HygieneViolation[];
export function scanRepo(root?: string): HygieneReport;
