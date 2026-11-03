// Player-by-jersey request outcomes (ADAAAA-7833).
//
// The perceive pipeline has accepted `track-player` since ADAAAA-7218, but until
// this change nothing user-facing reached it: the server forwarded only the
// find-and-track controls and `.catch()`-swallowed the rest, so a request with an
// unreadable jersey number returned `ok:true` and forwarded nothing. The server
// now awaits perceive's ack for the player intents and returns it; this module
// turns that ack into the one line the operator reads, and it is pure so the
// mapping is testable without a browser.

/** perceive's `/app/control` ack for `track-player` / `track-player-by-number`. */
export interface PlayerAck {
  type?: string;
  cmd?: string;
  ok?: boolean;
  error?: string;
  retrying?: boolean;
  retryWindowFrames?: number;
  retryStride?: number;
  retryAttempts?: number;
  number?: number;
  slot?: number;
  trackId?: string;
  selected?: boolean;
  bbox?: number[];
}

/** `POST /jobs/:id/control` response for a player intent. */
export interface PlayerControlResponse {
  ok?: boolean;
  error?: string;
  ack?: PlayerAck | null;
}

export interface PlayerStatus {
  kind: "tracked" | "pending" | "failed" | "gaveup";
  text: string;
}

/** perceive's default retry window (PLAYER_RETRY_WINDOW_FRAMES in
 * services/perceive/app/__init__.py). Only a fallback: the ack carries the
 * runner's real value, which is what the operator message quotes. */
export const PLAYER_RETRY_WINDOW_FRAMES = 200;

const slotSuffix = (slot: unknown) => (typeof slot === "number" ? ` (slot ${slot})` : "");

/**
 * Map a control response to the status line the console renders.
 *
 * - seeded (`ack.ok`)            -> "player #N tracked (slot S)"
 * - not identified, retrying     -> "no player with number N identified yet —
 *                                   retrying up to W sampled frames"
 * - hard failure / no ack        -> the identify error, so it is never silent
 *
 * `retryWindow` is non-null only for the retrying case; the caller opens the
 * frame-bounded pending state with it.
 */
export function playerStatusFromAck(
  number: number,
  res: PlayerControlResponse | null | undefined
): { status: PlayerStatus; retryWindow: number | null } {
  const ack = res?.ack;
  if (ack?.ok) {
    return {
      status: { kind: "tracked", text: `player #${number} tracked${slotSuffix(ack.slot)}` },
      retryWindow: null,
    };
  }
  if (ack?.retrying) {
    const window = ack.retryWindowFrames ?? PLAYER_RETRY_WINDOW_FRAMES;
    return {
      status: {
        kind: "pending",
        text: `no player with number ${number} identified yet — retrying up to ${window} sampled frames`,
      },
      retryWindow: window,
    };
  }
  // Hard failure, or the server could not forward at all (no session / no ack /
  // transport error). Either way the operator must see why.
  const why = ack?.error || res?.error || "identification failed";
  return { status: { kind: "failed", text: `player #${number} not identified: ${why}` }, retryWindow: null };
}

/** The give-up line once the sampled-frame retry window has run out with no
 * `player #N` track in the observation stream. */
export function gaveUpPlayerStatus(number: number, frames: number): PlayerStatus {
  return {
    kind: "gaveup",
    text: `gave up on player #${number} after ${frames} sampled frames — the jersey never became legible. Ask again once the player is closer or the number is readable.`,
  };
}

/** True when this observation carries the seeded `player #N` track (perceive
 * labels the seeded box `player #N`), i.e. the retry identified the jersey. */
export function findPlayerTrack(tracks: any[] | undefined | null, number: number): { slot?: number } | null {
  const label = `player #${number}`;
  const hit = (tracks || []).find((t: any) => t?.label === label);
  return hit || null;
}
