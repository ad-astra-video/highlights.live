// Source allow-list for the email-sender queue/status API (security hard gate,
// ADAAAA-2475). When configured, only requests whose source address matches an
// entry (exact IP or CIDR) may reach the API — applied in addition to the
// shared bearer token. Extreme care is taken to never treat public addresses
// as allowed by accident, and the list is compared against the raw client
// socket address, so it cannot be bypassed by header spoofing.

/** True when `ip` is covered by an entry in `allowlist` (exact IPs and CIDRs,
 * e.g. "10.0.0.0/8" or "127.0.0.1"). */
export function ipInAllowlist(ip: string, allowlist: string[]): boolean {
  const ipInt = ipToInt(ip);
  if (ipInt == null) return false;
  for (const entry of allowlist) {
    const parsed = parseCidr(entry);
    if (!parsed) continue;
    const mask = parsed.bits === 0 ? 0 : (0xffffffff << (32 - parsed.bits)) >>> 0;
    if ((ipInt & mask) === (parsed.net & mask)) return true;
  }
  return false;
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const o of parts) {
    const v = Number(o);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = ((n << 8) + v) >>> 0;
  }
  return n >>> 0;
}

function parseCidr(entry: string): { net: number; bits: number } | null {
  const [ipPart, bitsPart] = entry.trim().split("/");
  const net = ipToInt(ipPart);
  if (net == null) return null;
  const bits = bitsPart ? Number(bitsPart) : 32;
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  return { net, bits };
}
