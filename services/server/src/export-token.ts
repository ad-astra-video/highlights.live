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
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ExportTokenPayload {
  /** Highlight id the token was minted for. */
  h: string;
  /** The user who was served the export URL (the marker's `exportedBy`). */
  u: string;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(secret: string, body: string): string {
  return base64url(createHmac("sha256", secret).update(body).digest());
}

/** Mint the opaque token for one highlight + minting user. */
export function mintExportToken(secret: string, highlightId: string, userId: string): string {
  const body = base64url(JSON.stringify({ h: highlightId, u: userId }));
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
