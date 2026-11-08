// ADAAAA-6851 Inc 3: pure, testable builders for the composite job-detail
// payload (GET /jobs/:id/detail). Kept out of api.ts so the section partition
// (no duplicate frame seq across sections) and decide-note attachment can be
// asserted directly in unit tests.
import type { JobCandidate, JobTrace, TrackObservation, WindowAnalysis, ConfirmRecord } from "@highlights/events";
import { deriveConfirmation, type WindowConfirmation } from "./confirmation-lane";
import type { StoredObservation } from "./store";

/** Fixed section length (s). Section index = floor(timestamp / SECTION_WINDOW). */
export const SECTION_WINDOW = 3;

export interface SectionFrame {
  seq: number;
  timestamp: number;
  uri: string;
  tracks: TrackObservation[];
}

export interface Section {
  index: number;
  startS: number;
  endS: number;
  frames: SectionFrame[];
  decideNotes: {
    seq: number;
    timestamp: number;
    eventType: string;
    score: number;
    outcome?: "scoring_play" | "near_miss" | "big_play" | "not_highlight";
    /** ADAAAA-8325 (Inc 2): footage phase from the decide verdict (absent =
     * unknown, never "live"). */
    phase?: "live" | "replay";
    nearMiss?: boolean;
    isHighlight: boolean;
    status: "accepted" | "suppressed" | "rejected";
    reason?: string;
    // ADAAAA-7156 Increment B: the per-window LLM analysis (prompt / dataItems /
    // media refs / full response) + the Stage-2 confirm record for this section's
    // decide note. Additive optional — absent on legacy notes without a capture.
    analysis?: WindowAnalysis;
    confirm?: ConfirmRecord;
    // ADAAAA-8287: which lane confirmed this window (see confirmation-lane.ts).
    // The row-level half (`lane` + `label` + the cited measurement) rides the
    // DEFAULT payload so a board reader can tell lane 1 from lane 2 without
    // opening the inspector; the inspector half (`flags` / `dive`) is stripped by
    // `stripWindowInspection()` exactly like `analysis` / `confirm`.
    confirmation?: WindowConfirmation;
  }[];
}

/**
 * On-disk frame inventory for a VOD job (ADAAAA-7624).
 *
 * Per-frame observations are a CAPPED durable window (store trims the oldest
 * rows past the job's cap), while the sampled JPEGs are complete on disk. A job
 * longer than the cap therefore loses the observation rows for its first
 * windows and those windows rendered `0 frames` even though the frame files
 * exist and serve 200. The inventory lets the section builder join every frame
 * back in: `frameCount` is the number of sampled frames (seq 0..frameCount-1)
 * and `sampleFps` derives a timestamp for a frame with no observation row.
 */
export interface FrameInventory {
  frameCount: number;
  sampleFps: number;
  /** ADAAAA-7734: the actual on-disk frame seqs when the directory is NOT a
   *  contiguous 0..n-1 series (the media/browser rail names each JPEG by its
   *  global seq and decimates the oldest past its storage cap). When present this
   *  list wins over `frameCount`: deleted frames must not be re-derived as tiles,
   *  and a surviving frame keeps its true seq. */
  frameSeqs?: number[];
}

/** Partition per-frame observations into fixed 3 s sections. A frame belongs to
 * exactly one section (index = floor(timestamp/3)), so no seq appears twice.
 *
 * ADAAAA-7624: when a frame `inventory` is supplied, every on-disk frame that
 * has no surviving observation row is added to its section (tracks `[]`,
 * timestamp derived from `sampleFps`) so a capped observation read can never
 * blank the first windows of a long job. The frame seq stays the partition key,
 * so the partition invariant (one seq, one section) still holds. */
export function buildSections(
  observations: StoredObservation[],
  candidates: JobCandidate[],
  jobId: string,
  inventory?: FrameInventory
): Section[] {
  const sections = new Map<number, Section>();
  const sectionOf = (ts: number): number => Math.floor(ts / SECTION_WINDOW);
  const getSection = (index: number): Section => {
    let s = sections.get(index);
    if (!s) {
      s = { index, startS: index * SECTION_WINDOW, endS: (index + 1) * SECTION_WINDOW, frames: [], decideNotes: [] };
      sections.set(index, s);
    }
    return s;
  };
  const seenSeq = new Set<number>();
  for (const o of observations) {
    // ADAAAA-7624: one frame seq must land in exactly one section even if a
    // duplicate observation row slips through (first row wins, like the DB read).
    if (seenSeq.has(o.seq)) continue;
    seenSeq.add(o.seq);
    const s = getSection(sectionOf(o.timestamp));
    s.frames.push({ seq: o.seq, timestamp: o.timestamp, uri: `/jobs/${jobId}/frames/${o.seq}`, tracks: o.tracks });
  }
  // ADAAAA-7624: restore the on-disk frames the capped observation window
  // dropped. A frame with no row keeps its seq-derived timestamp and an empty
  // track list — the tile renders the servable JPEG instead of "no frames".
  const frameCount = Math.max(0, Math.floor(inventory?.frameCount ?? 0));
  const fps = inventory && Number.isFinite(inventory.sampleFps) && inventory.sampleFps > 0 ? inventory.sampleFps : 1;
  // ADAAAA-7734: an explicit on-disk seq list wins over a contiguous count — the
  // media rail can leave gaps (oldest frames decimated past the storage cap), and
  // a gap must never be re-derived as a tile that 404s.
  const inventorySeqs = (inventory?.frameSeqs ?? []).filter((seq) => Number.isFinite(seq) && seq >= 0);
  if (inventorySeqs.length > 0) {
    for (const seq of inventorySeqs) {
      if (seenSeq.has(seq)) continue;
      const timestamp = seq / fps;
      const s = getSection(sectionOf(timestamp));
      s.frames.push({ seq, timestamp, uri: `/jobs/${jobId}/frames/${seq}`, tracks: [] });
    }
  } else if (frameCount > 0) {
    for (let seq = 0; seq < frameCount; seq++) {
      if (seenSeq.has(seq)) continue;
      const timestamp = seq / fps;
      const s = getSection(sectionOf(timestamp));
      s.frames.push({ seq, timestamp, uri: `/jobs/${jobId}/frames/${seq}`, tracks: [] });
    }
  }
  for (const c of candidates) {
    const s = getSection(sectionOf(c.timestamp));
    s.decideNotes.push({
      seq: c.seq,
      timestamp: c.timestamp,
      eventType: c.eventType,
      score: c.score,
      outcome: c.outcome,
      nearMiss: c.nearMiss,
      // ADAAAA-8325 (Inc 2): the footage phase from the stored candidate row, so
      // the per-window decide note shows live vs replay. Absent = unknown.
      ...(c.phase ? { phase: c.phase } : {}),
      isHighlight: c.isHighlight,
      status: c.status,
      reason: c.reason,
      // ADAAAA-7156 Increment B: attach the per-window analysis + Stage-2 confirm
      // record so the job-detail payload exposes exactly what the decide LLM was
      // fed + returned for this window. Absent on legacy candidates.
      analysis: c.analysis,
      confirm: c.confirm,
      // ADAAAA-8287: derive the acceptance lane from the stored row so the row
      // body can state it (a lane-1 accept leaves no confirm block, so the empty
      // panel used to be the only signal). Pure derivation over stored fields.
      confirmation: deriveConfirmation(c),
    });
  }
  const list = [...sections.values()].sort((a, b) => a.index - b.index);
  // Deterministic frame order inside a window (seq ascending) regardless of
  // whether a frame came from an observation row or the on-disk inventory.
  for (const s of list) s.frames.sort((a, b) => a.seq - b.seq);
  return list;
}

/** Aggregate tracked-object identities across a job, grouped by trackId. */
export function buildTraces(observations: StoredObservation[]): JobTrace[] {
  const byTrack = new Map<string, JobTrace>();
  for (const o of observations) {
    for (const t of o.tracks) {
      let tr = byTrack.get(t.trackId);
      if (!tr) {
        tr = { trackId: t.trackId, slot: t.slot, kind: t.kind, label: t.label, onScreen: 0, ontoFrames: 0, lostFrames: 0, selected: t.selected };
        byTrack.set(t.trackId, tr);
      }
      // A frame where the track is explicitly off-screen does not count onScreen.
      tr.onScreen += t.onScreen === false ? 0 : 1;
      tr.ontoFrames = (tr.ontoFrames ?? 0) + (t.ontoFrames ?? 0);
      tr.lostFrames = Math.max(tr.lostFrames ?? 0, t.lostFrames ?? 0);
      if (t.accuracy !== undefined) tr.accuracy = t.accuracy;
      if (t.selected) tr.selected = true;
      if (t.label) tr.label = t.label;
    }
  }
  return [...byTrack.values()].sort((a, b) => (a.trackId < b.trackId ? -1 : 1));
}

/** Capacity budget a job ran under (plan: traces count <= capacity). */
export function maxTracesForSource(source: string): number {
  return ["rtmp", "webrtc", "screenshare", "browser", "file-sim"].includes(source) ? 3 : 8;
}

/** ADAAAA-7285: point every analysis window that actually captured audio at a
 * real, servable per-window audio resource so the analysis-window player
 * (WindowAnalysis.tsx `audio.uri`) has something to play.
 *
 * The window is `[timestamp - preS, timestamp + postS]` around the decide-note
 * trigger (the decide default is `[-2s, +3s]` — DEFAULT_PRE_WINDOW_S /
 * DEFAULT_POST_WINDOW_S). The URI targets the on-demand extraction endpoint
 * (`/jobs/:jobId/windows/audio?start=..&end=..`), which re-extracts the window
 * from the job source recording via ffmpeg, so it works retroactively for
 * existing jobs whose source is still on disk.
 *
 * Windows whose audio channel reached the model as `none` (genuinely silent
 * source) keep `audio.uri` as persisted ("" / absent) — a silent window must
 * NOT get a bogus playable URI, and the UI shows the "No audio captured" badge
 * (ADAAAA-7248/7277 semantics preserved).
 *
 * Pure + additive: only analyze notes that carry a captured `analysis.audio`
 * are touched, and each rewritten analysis is a fresh object so the stored
 * JobCandidate is never mutated. */
export function attachWindowAudioUris(
  sections: Section[],
  jobId: string,
  windowPreS = DEFAULT_WINDOW_PRE_S,
  windowPostS = DEFAULT_WINDOW_POST_S
): Section[] {
  for (const s of sections) {
    for (const n of s.decideNotes) {
      const a = n.analysis;
      if (!a?.audio) continue;
      if (a.audio.path === "none") continue; // silent window — keep uri ""
      const start = Math.max(0, n.timestamp - windowPreS);
      const end = n.timestamp + windowPostS;
      n.analysis = {
        ...a,
        audio: {
          ...a.audio,
          uri: `/jobs/${jobId}/windows/audio?start=${start.toFixed(3)}&end=${end.toFixed(3)}`,
        },
      };
    }
  }
  return sections;
}

/**
 * ADAAAA-7838: strip the per-window LLM inspection payload from a section list.
 *
 * `GET /jobs/:id/detail` and `GET /jobs/:id/sections-delta` attach the per-window
 * capture (`analysis`: prompt / dataItems / media refs / response / audioSeries)
 * plus its Stage-2 `confirm` record to every decide note. On a long job that is
 * the bulk of the response, and the customer page renders it only when the owner
 * opts in (`?inspect=1`) — and then one window at a time through the lazy
 * `/jobs/:id/sections/:index/inspect` route. This returns a FRESH section list
 * with `analysis` and `confirm` omitted from every decide note: frames,
 * timestamps, note kind/status/reason, highlights, ladder, capture and maxTraces
 * are untouched, and the stored JobCandidate is never mutated.
 *
 * ADAAAA-8287: the note's derived `confirmation` keeps its row-level half
 * (`lane` / `label` / `measurement` / `detail`) — that sentence IS the row label
 * — while the inspector half (`flags` / `flagsSource` / `dive`) is dropped.
 */
export function stripWindowInspection(sections: Section[]): Section[] {
  return sections.map((s) => ({
    ...s,
    decideNotes: s.decideNotes.map((n) => {
      const out: Section["decideNotes"][number] = { ...n };
      delete out.analysis;
      delete out.confirm;
      // ADAAAA-8287: the row-level lane (lane + label + the cited measurement)
      // STAYS — it is the whole point of the row label. Only the inspector half
      // (the raw attestation flags + the dive verdict) is gated, exactly like
      // `analysis` / `confirm` above.
      if (out.confirmation) {
        out.confirmation = {
          lane: out.confirmation.lane,
          label: out.confirmation.label,
          measurement: out.confirmation.measurement,
          ...(out.confirmation.detail ? { detail: out.confirmation.detail } : {}),
        };
      }
      return out;
    }),
  }));
}

/** Decide window defaults, mirrored here (the read path has no live AnalyzerConfig
 * at hand). Keep in sync with analyzer.ts DEFAULT_PRE_WINDOW_S / POST_WINDOW_S. */
export const DEFAULT_WINDOW_PRE_S = 2;
export const DEFAULT_WINDOW_POST_S = 3;
