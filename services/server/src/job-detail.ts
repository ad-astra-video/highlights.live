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
