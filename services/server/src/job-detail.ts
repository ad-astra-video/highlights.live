// ADAAAA-6851 Inc 3: pure, testable builders for the composite job-detail
// payload (GET /jobs/:id/detail). Kept out of api.ts so the section partition
// (no duplicate frame seq across sections) and decide-note attachment can be
// asserted directly in unit tests.
import type { JobCandidate, JobTrace, TrackObservation, WindowAnalysis, ConfirmRecord } from "@highlights/events";
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
    nearMiss?: boolean;
    isHighlight: boolean;
    status: "accepted" | "suppressed" | "rejected";
    reason?: string;
    // ADAAAA-7156 Increment B: the per-window LLM analysis (prompt / dataItems /
    // media refs / full response) + the Stage-2 confirm record for this section's
    // decide note. Additive optional — absent on legacy notes without a capture.
    analysis?: WindowAnalysis;
    confirm?: ConfirmRecord;
  }[];
}

/** Partition per-frame observations into fixed 3 s sections. A frame belongs to
 * exactly one section (index = floor(timestamp/3)), so no seq appears twice. */
export function buildSections(
  observations: StoredObservation[],
  candidates: JobCandidate[],
  jobId: string
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
  for (const o of observations) {
    const s = getSection(sectionOf(o.timestamp));
    s.frames.push({ seq: o.seq, timestamp: o.timestamp, uri: `/jobs/${jobId}/frames/${o.seq}`, tracks: o.tracks });
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
      isHighlight: c.isHighlight,
      status: c.status,
      reason: c.reason,
      // ADAAAA-7156 Increment B: attach the per-window analysis + Stage-2 confirm
      // record so the job-detail payload exposes exactly what the decide LLM was
      // fed + returned for this window. Absent on legacy candidates.
      analysis: c.analysis,
      confirm: c.confirm,
    });
  }
  return [...sections.values()].sort((a, b) => a.index - b.index);
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

/** Decide window defaults, mirrored here (the read path has no live AnalyzerConfig
 * at hand). Keep in sync with analyzer.ts DEFAULT_PRE_WINDOW_S / POST_WINDOW_S. */
export const DEFAULT_WINDOW_PRE_S = 2;
export const DEFAULT_WINDOW_POST_S = 3;
