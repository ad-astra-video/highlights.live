/**
 * Type surface for scripts/check-docs-hygiene.mjs (ADAAAA-9101). The guard is a
 * plain Node ESM script so `node scripts/check-docs-hygiene.mjs` works without a
 * build; the test job imports it through this declaration.
 */
export interface HygieneViolation {
  file: string;
  line: number;
  column: number;
  kind:
    | "private-ipv4"
    | "endpoint-url"
    | "endpoint-email"
    | "internal-hostname" // ADAAAA-9131: bare fleet hostname (no scheme, no @)
    | "operator-home-path"
    | "ssh-target"
    | "ssh-port";
  value: string;
}

export interface HygieneReport {
  scanned: number;
  files: number;
  violations: HygieneViolation[];
}

export const ALLOWED_HOST_SUFFIXES: string[];
export const ALLOWED_BARE_HOSTS: string[];
export const ALLOWED_HOME_ACCOUNTS: string[];
export const INTERNAL_HOSTNAME_FAMILIES: RegExp[];
export function isAllowedHost(host: string): boolean;
export function scanText(text: string, relPath?: string): HygieneViolation[];
export function scanRepo(root?: string): HygieneReport;
