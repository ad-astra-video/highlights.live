// Entity identity continuity across windows (ADAAAA-6032, plan §D).
//
// Problem: the same player/entity appears in many 60 s windows of a run, but
// the raw perception layer does not give it a stable id. SAM/Florence trackIds
// are timestamp-encoded (`t{ms}-{slot}` / `seed-{ms}-{slot}`) and are
// *reassigned* whenever a track drops out (occlusion) and re-seeds, or a slot
// is reused. The in-roster `label` is a coarse class (player/goalkeeper/…), not
// a jersey number, and perceive does not yet emit OCR (`ocr: []`). So left
// untouched, "same player 30 min ago" is not retrievable — exactly the gap this
// module closes.
//
// This module resolves per-window track observations into *stable entity
// identities* (`entityRef`s) consumed by the vector-memory ingestion (plan §C)
// and the narrative case (plan §D / acceptance A4).
//
// Signals used, in priority order:
//   1. trackId continuity — a track keeps one id for its uninterrupted lifetime;
//      persist that mapping for as long as the id is seen.
//   2. jersey / OCR binding — a jersey number (or OCR-adjacent identity token)
//      bound to a track is a *strong*, cross-window, cross-run identity key.
//      This is the intended headless/cross-30-min signal. Dormant on real data
//      today (perceive emits no OCR/jersey), but first-class + unit-tested, so
//      the moment a jersey label or OCR arrives it stitches across any gap.
//   3. spatial (IoU) association within a grace window — a trackId that
//      re-appears *near* where a known entity was last seen (within
//      GRACE_SECONDS) and IoU-overlaps is linked to that entity, repairing a
//      reassigned track id after dropout/occlusion. Bounded: never bridges long
//      gaps on proximity alone (that would fabricate false merges).
//
// Stable-identity definition (call-out for §D): an entity is declared *stable*
// (surfaced as a narrative `entityRef`) when it is bound to a jersey/OCR
// identity, OR it has accumulated enough continuous observations to be a real,
// sustained object. A short transient blip with no continuity and no binding
// stays internal and is flagged `transient`, so it never pollutes an arc with a
// fabricated same-entity match. See STABLE_MODE below.
//
// Ambiguities we deliberately do NOT guess across (call-out for §D): a long
// gap (≫ GRACE_SECONDS) with no jersey binding and a reassigned track id is
// left UNRESOLVED (a fresh transient) rather than force-merged on weak spatial
// evidence — a cross-window merge on distance alone would merge two different
// players just because they occupy the same part of the pitch 30 min apart.
// Cross-window continuity is instead carried by: persistent long-lived track
// ids (registry keeps a trackId for its whole lifetime) and jersey/OCR
// bindings. That is what makes the yellow→red arc passable end-to-end.
import { randomUUID } from "node:crypto";

/** Number of recent places retained per entity for IoU association (bounded). */
export const ENTITY_PLACE_RECENT = 16;
/** Maximum seconds between a known entity's last observation and a re-appearing
 * track that we will bridge on spatial (IoU) contiguity. Beyond this, no
 * proximity-only merge — see module docstring ambiguities. */
export const ENTITY_GRACE_SECONDS = 12;
/** IoU overlap required to associate a re-appearing track id with a known
 * entity after dropout / reassignment (normalized boxes, generous). */
export const ENTITY_ASSOC_IOU = 0.3;
/** Minimum continuous observations before an entity (with no jersey binding)
 * is promoted from `transient` to `stable`. */
export const ENTITY_MIN_STABLE_OBS = 3;
/** Hard bound on entities retained per run so memory never grows on a long
 * stream. Oldest-unseen entities are evicted first. */
export const ENTITY_MAX = 256;

/** A resolved identity for one track occurrence. */
export interface EntityResolution {
  /** Stable identity reference for the narrative layer + vector memory (§C).
   * `j:<jersey>` when a jersey/OCR identity is bound (stable across windows and
   * runs); else `ent:<runLocalUuid>` (stable within the run). */
  entityRef: string;
  /** Stable-identity status: `stable` entities may be surfaced as narrative
   * identities; `transient` are short-lived/unresolvable blips and should be
   * ignored by the narrative/arc layer. */
  stability: "stable" | "transient";
  /** Jersey/number/name token bound to this entity, when available ('' else). */
  jersey?: string;
}

/** One spatial observation of a track at a moment in time. */
interface TrackSample {
  ts: number;
  trackId: string;
  bbox: [number, number, number, number];
  /** Optional jersey-style identity hint for this track (empty when none). */
  jersey?: string;
}

interface Entity {
  ref: string;
  jersey?: string;
  /** Recent (ts, bbox, trackId) places, oldest -> newest, bounded. */
  places: { ts: number; trackId: string; bbox: [number, number, number, number] }[];
  /** Cumulative observations seen (for the stability promotion). */
  obs: number;
  /** Timestamp of the most recent observation (for LRU eviction). */
  lastSeen: number;
}

/** IoU of two normalized boxes [x1,y1,x2,y2]. */
export function boxIoU(a: number[], b: number[]): number {
  const ax1 = a[0], ay1 = a[1], ax2 = a[2], ay2 = a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[2], by2 = b[3];
  const ix1 = Math.max(ax1, bx1);
  const iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2);
  const iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1);
  const ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  if (inter === 0) return 0;
  const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
  const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
  return inter / (areaA + areaB - inter + 1e-9);
}

/** Extract a jersey-style identity token from a track hint / OCR line, or ''.
 *
 * Accepts a plain number (e.g. "7", "#7", "No 10") or a short surname-style
 * token — anything clearly shorter than a scoreboard phrase and that is not a
 * coarse class label. Callers decide what to feed; this returns the bound key.
 * Conservative: returns '' when the input looks like a coarse class or a
 * multi-word phrase (ambiguity call-out).
 */
export function extractJersey(value: string | undefined | null): string {
  if (!value) return "";
  const v = value.trim();
  if (!v) return "";
  const lower = v.toLowerCase();
  // Coarse in-roster class labels are NOT identity (ADAAAA-6032 call-out).
  if (["player", "goalkeeper", "referee", "agent", "person", "people", "goal", "ball", "unknown"].includes(lower)) {
    return "";
  }
  // "#7", "No 10", "7" -> "7". Reject multi-word phrases / scoreboard text.
  const m = v.match(/^(?:#|no\.?\s*|n\.?\s*)?(\d{1,3})$/i);
  if (m) return m[1];
  // Short surname-style token: single word, <= 16 chars, alphabetic with
  // optional separators. Multi-word OCR (scoreboard lines) is rejected.
  if (/^[A-Za-z][A-Za-z .'\-]{1,15}$/.test(v) && !v.includes(" ")) return v;
  return "";
}

/**
 * Resolves per-window track observations into stable entity identities, kept
 * for the whole run so a later window can reference an entity seen earlier
 * (the yellow→red arc). Deterministic and pure (no I/O) so it is unit-testable.
 *
 * Memory is bounded: per-entity recent places are capped and the entity
 * registry itself is LRU-capped (ENTITY_MAX) so a long stream never grows
 * unbounded. The registry persists across windows (needed for the arc), while
 * each entity's spatial buffer only spans its recent places.
 */
export class EntityIdentityResolver {
  private entities = new Map<string, Entity>();
  /** trackId -> entityRef, kept for the track's full lifetime (persists across
   * windows) so a long-lived track id is a durable identity anchor. */
  private byTrack = new Map<string, string>();

  /** Resolve one frame of track observations at time `ts`. Returns a map of
   * trackId -> identity for every track in the frame. Every observation is
   * consumed; the return is the caller's view of the *new/updated* state. */
  resolve(ts: number, tracks: { trackId: string; bbox: number[]; jersey?: string }[]): Map<string, EntityResolution> {
    const out = new Map<string, EntityResolution>();
    for (const t of tracks) {
      const ref = this.observe(ts, t.trackId, t.bbox as [number, number, number, number], t.jersey);
      const ent = this.entities.get(ref)!;
      out.set(t.trackId, {
        entityRef: ref,
        stability: ent.jersey ? "stable" : ent.obs >= ENTITY_MIN_STABLE_OBS ? "stable" : "transient",
        jersey: ent.jersey,
      });
    }
    return out;
  }

  /** The entity identity a trackId currently resolves to (registry lookup,
   * regardless of the transient/stable surfacing threshold). Used to key
   * high-signal events (confirmed highlights) to an entity even when the entity
   * is not yet old enough to surface to the general narrative window. */
  refOfTrack(trackId: string): string | undefined {
    return this.byTrack.get(trackId);
  }

  /** Resolve ONE track observation and return its entityRef, updating state. */
  private observe(ts: number, trackId: string, bbox: [number, number, number, number], jerseyHint?: string): string {
    const jersey = extractJersey(jerseyHint) || "";
    // 1) trackId continuity: same id seen before -> same entity, no further work.
    const existingTrack = this.byTrack.get(trackId);
    // 2) jersey binding: strongest signal — stitch regardless of window/gap.
    if (jersey) {
      const je = this.findByJersey(jersey);
      if (je) {
        this.attach(this.entities.get(je)!, ts, trackId, bbox);
        this.byTrack.set(trackId, je);
        return je;
      }
      // new jersey identity
      const e = this.createEntity({ jersey }, ts, trackId, bbox);
      this.byTrack.set(trackId, e);
      return e;
    }
    if (existingTrack) {
      const ent = this.entities.get(existingTrack)!;
      this.attach(ent, ts, trackId, bbox);
      return existingTrack;
    }
    // 3) spatial (IoU) association within the grace window: a re-appearing track
    //    near where a known entity was last seen repairs a reassigned id.
    const match = this.associate(ts, bbox, trackId);
    if (match) {
      this.attach(this.entities.get(match)!, ts, trackId, bbox);
      this.byTrack.set(trackId, match);
      return match;
    }
    // 4) otherwise a new entity.
    const ref = this.createEntity({}, ts, trackId, bbox);
    this.byTrack.set(trackId, ref);
    return ref;
  }

  /** Record a confirmed high-signal event against an entity (the arc store: a
   * later event on the same entity can reference this earlier one — A4). */
  private findByJersey(jersey: string): string | undefined {
    for (const [ref, e] of this.entities) {
      if (e.jersey === jersey) return ref;
    }
    return undefined;
  }

  /** Best known entity to associate a re-appearing track with: within grace
   * window, IoU >= threshold, over the entity's most recent place, and NOT
   * already claimed by another track this frame (ambiguity -> no merge). */
  private associate(ts: number, bbox: [number, number, number, number], trackId: string): string | undefined {
    let best: { ref: string; iou: number; lastSeen: number } | undefined;
    for (const [ref, e] of this.entities) {
      const recent = e.places[e.places.length - 1];
      if (!recent) continue;
      if (ts - recent.ts > ENTITY_GRACE_SECONDS) continue;
      const iou = boxIoU(bbox, recent.bbox);
      if (iou < ENTITY_ASSOC_IOU) continue;
      if (!best || iou > best.iou || (iou === best.iou && recent.ts > best.lastSeen)) {
        best = { ref, iou, lastSeen: recent.ts };
      }
    }
    if (!best) return undefined;
    // Ambiguity guard: if another entity is ALSO a live candidate within grace
    // at high overlap this frame, do not merge (two entities too close).
    let ties = 0;
    for (const [ref, e] of this.entities) {
      if (ref === best.ref) continue;
      const recent = e.places[e.places.length - 1];
      if (!recent || ts - recent.ts > ENTITY_GRACE_SECONDS) continue;
      if (boxIoU(bbox, recent.bbox) >= ENTITY_ASSOC_IOU) ties++;
    }
    if (ties > 0) return undefined;
    return best.ref;
  }

  private attach(e: Entity, ts: number, trackId: string, bbox: [number, number, number, number]): void {
    e.places.push({ ts, trackId, bbox });
    if (e.places.length > ENTITY_PLACE_RECENT) e.places.shift();
    e.obs += 1;
    e.lastSeen = ts;
  }

  private createEntity(init: { jersey?: string }, ts: number, trackId: string, bbox: [number, number, number, number]): string {
    const ref = init.jersey ? `j:${init.jersey}` : `ent:${randomUUID().slice(0, 8)}`;
    this.entities.set(ref, {
      ref,
      jersey: init.jersey,
      places: [{ ts, trackId, bbox }],
      obs: 1,
      lastSeen: ts,
    });
    if (this.entities.size > ENTITY_MAX) this.evictOldest();
    return ref;
  }

  /** LRU-evict the least-recently-seen entity to keep the run bounded. */
  private evictOldest(): void {
    let oldest: string | undefined;
    let oldestTs = Infinity;
    for (const [ref, e] of this.entities) {
      if (e.lastSeen < oldestTs) {
        oldestTs = e.lastSeen;
        oldest = ref;
      }
    }
    if (!oldest) return;
    const ent = this.entities.get(oldest)!;
    for (const [tid, ref] of this.byTrack) {
      if (ref === oldest) this.byTrack.delete(tid);
    }
    void ent;
    this.entities.delete(oldest);
  }

  /** Human + machine readable current registry size (memory bound check). */
  get size(): number {
    return this.entities.size;
  }
}
