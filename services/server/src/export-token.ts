// ADAAAA-7896: export tokens for a highlight clip.
//
// The playback URL (`/clips/<file>.mp4`, public, no query) must never write
// export state: it is the `<video>` src, so a page view would mark every clip
// as "left the app". Export is a DISTINCT URL carrying a per-highlight token
// (`/clips/<file>.mp4?x=<token>`); fetching it marks the highlight then serves
// the exact same bytes.
//
// The token is an HMAC over `{ h: highlightId, u: mintingUserId }`, so:
//   - a token minted for clip A used on clip B fails (the payload's id must
//     equal the highlight the requested file belongs to);
//   - a tampered token fails the signature check;
//   - the marking route learns who minted the link (`exportedBy`) without the
//     anonymous fetch needing auth.
// Tokens are not expiring/revocable — that is explicitly out of scope for this
// ticket (see the parent ask's Out of scope section).
//
// ADAAAA-7901: the export secret is NOT the session secret. Signing export
// tokens with `cfg.jwtSecret` made an export token a sibling of a session
// credential — anyone holding the (documented) compose default could mint both.
// `resolveExportTokenSecret` therefore prefers a dedicated `EXPORT_TOKEN_SECRET`
// and otherwise HKDF-derives one from the session secret, so an export token
// can never be turned into a session and a leaked export secret cannot forge
// one. The signed body also carries a domain tag (`v`), so a payload minted by
// the old scheme (or with the raw jwt secret) is refused even if the bytes
// happen to parse.
import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/** Domain tag inside the signed body. Bumping it invalidates every previously
 * minted export URL (they are non-expiring, so a bump is a deliberate break). */
export const EXPORT_TOKEN_VERSION = "clip-export.v1";

/** HKDF info/salt strings for the derived export secret (single source of
 * truth, so the derivation is reproducible and reviewable). */
const EXPORT_SECRET_INFO = "clip-export";

export interface ExportTokenPayload {
  /** Domain tag — must equal EXPORT_TOKEN_VERSION. */
  v: string;
  /** Highlight id the token was minted for. */
  h: string;
  /** The user who was served the export URL (the marker's `exportedBy`). */
  u: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** Derive a dedicated export secret from the session secret via HKDF-SHA256.
 * Deterministic: the same jwt secret always yields the same export secret, so
 * a deploy that does not set `EXPORT_TOKEN_SECRET` keeps minting valid export
 * URLs (nothing to re-key). The two secrets are cryptographically separated —
 * the derived value cannot be used to sign a session, and the session secret
 * cannot verify (or mint) an export token directly. */
export function deriveExportTokenSecret(jwtSecret: string): string {
  const okm = hkdfSync(
    "sha256",
    Buffer.from(jwtSecret, "utf8"),
    Buffer.from("highlights.live", "utf8"),
    Buffer.from(EXPORT_SECRET_INFO, "utf8"),
    32
  );
  return Buffer.from(okm).toString("hex");
}

/** Resolve the export secret: explicit `EXPORT_TOKEN_SECRET` wins, else the
 * HKDF derivation from the session secret. An explicit value equal to the
 * session secret is refused in every environment — that re-creates the exact
 * coupling ADAAAA-7901 is about, and it is never what an operator means. */
export function resolveExportTokenSecret(
  explicit: string | undefined,
  jwtSecret: string,
  opts: { requireStrong?: boolean } = {}
): string {
  const value = (explicit ?? "").trim();
  if (!value) return deriveExportTokenSecret(jwtSecret);
  if (value === jwtSecret) {
    throw new Error(
      "EXPORT_TOKEN_SECRET must differ from JWT_SECRET: an export token signed with the session secret can be forged from the same literal a session can be forged from (ADAAAA-7901)."
    );
  }
  if (opts.requireStrong && value.length < 16) {
    throw new Error(
      `EXPORT_TOKEN_SECRET is too short (${value.length} chars) for this environment; use at least 16 characters of high-entropy secret (ADAAAA-7901).`
    );
  }
  return value;
}

function sign(secret: string, body: string): string {
  return base64url(createHmac("sha256", secret).update(body).digest());
}

/** Mint the opaque token for one highlight + minting user. */
export function mintExportToken(secret: string, highlightId: string, userId: string): string {
  const body = base64url(JSON.stringify({ v: EXPORT_TOKEN_VERSION, h: highlightId, u: userId }));
  return `${body}.${sign(secret, body)}`;
}

/** Verify a token's signature and shape; null when it is not ours. */
export function verifyExportToken(secret: string, token: string): ExportTokenPayload | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = sign(secret, body);
  // Constant-time compare on equal-length buffers; a length mismatch is a
  // refusal, not a throw (timingSafeEqual throws on differing lengths).
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as ExportTokenPayload;
    if (!parsed || typeof parsed.h !== "string" || typeof parsed.u !== "string") return null;
    // Domain tag: a body without it was minted by the pre-ADAAAA-7901 scheme
    // (raw session secret) and is refused even when the signature checks out.
    if (parsed.v !== EXPORT_TOKEN_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The export URL for a clip path: `/clips/<file>.mp4` + the token. */
export function exportUriFor(path: string, token: string): string {
  if (!path) return "";
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}x=${encodeURIComponent(token)}`;
}
