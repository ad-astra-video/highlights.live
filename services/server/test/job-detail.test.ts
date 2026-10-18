import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobCandidateSchema, type JobCandidate } from "@highlights/events";
import { SqliteDb } from "../src/db";
import { Store, type StoredObservation } from "../src/store";
import { buildSections, buildTraces, maxTracesForSource, SECTION_WINDOW } from "../src/job-detail";

// ADAAAA-6851 Inc 1-3: durable per-frame observations + per-candidate decide
// notes + composite job-detail builders (section partition / trace aggregation).

function obs(seq: number, timestamp: number, tracks: StoredObservation["tracks"] = []): StoredObservation {
  return { seq, timestamp, tracks };
}

function track(trackId: string, slot: number, extra: Partial<StoredObservation["tracks"][0]> = {}): StoredObservation["tracks"][0] {
  return { trackId, slot, bbox: [0, 0, 10, 10], kind: "player", lostFrames: 0, label: "player", ...extra };
}

function cand(over: Partial<Omit<JobCandidate, "jobId" | "createdAt">> & { timestamp: number }, jobId = "job-1"): JobCandidate {
  return JobCandidateSchema.parse({
    id: `c-${over.timestamp}`,
    jobId,
    seq: 0,
    eventType: "GOAL",
    score: 90,
    isHighlight: true,
    status: "accepted",
    createdAt: new Date().toISOString(),
    ...over,
  });
}

describe("buildSections (ADAAAA-6851 Inc 3)", () => {
  it("partitions frames into 3s sections with no duplicate seq across sections", () => {
    const observations = [
      obs(0, 0.2), // section 0
      obs(1, 2.9), // section 0
      obs(2, 3.0), // section 1 (boundary: exactly 3.0 -> section 1)
      obs(3, 8.5), // section 2
    ];
    const sections = buildSections(observations, [], "job-1");
    expect(sections.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(sections[0].frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(sections[1].frames.map((f) => f.seq)).toEqual([2]);
    expect(sections[2].frames.map((f) => f.seq)).toEqual([3]);
    // Every frame seq appears exactly once across all sections (partition invariant).
    const allSeqs = sections.flatMap((s) => s.frames.map((f) => f.seq));
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
    expect(allSeqs.sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    // Frame metadata (lazy image uri).
    expect(sections[0].frames[0].uri).toBe("/jobs/job-1/frames/0");
  });

  it("attaches a decide note to the section containing its trigger timestamp", () => {
    const observations = [obs(0, 0.2), obs(1, 2.9), obs(2, 3.0), obs(3, 8.5)];
    const candidates = [
      cand({ timestamp: 2.1, eventType: "GOAL", reason: "ball in net" }),
      cand({ timestamp: 8.6, eventType: "KILL", isHighlight: false, status: "rejected", outcome: "not_highlight" }),
    ];
    const sections = buildSections(observations, candidates, "job-1");
    expect(sections[0].decideNotes.map((n) => n.timestamp)).toEqual([2.1]);
    expect(sections[0].decideNotes[0].reason).toBe("ball in net");
    expect(sections[2].decideNotes.map((n) => n.timestamp)).toEqual([8.6]);
    expect(sections[2].decideNotes[0].status).toBe("rejected");
  });

  it("leaves frames metadata-only and preserves track boxes per frame", () => {
    const observations = [obs(0, 0.5, [track("t1", 0), track("t2", 1, { label: "ball", kind: "ball" })])];
    const sections = buildSections(observations, [], "job-1");
    expect(sections[0].frames[0].tracks).toHaveLength(2);
    expect(sections[0].frames[0].tracks[1].kind).toBe("ball");
    expect(sections[0].frames[0].tracks[0].bbox).toEqual([0, 0, 10, 10]);
  });
});

describe("buildTraces (ADAAAA-6851 Inc 3)", () => {
  it("groups tracks by trackId and folds onScreen/onto/lost/accuracy/selected", () => {
    const observations = [
      obs(0, 0.5, [track("t1", 0, { onScreen: true, ontoFrames: 1, lostFrames: 0, accuracy: 1, selected: true })]),
      obs(1, 1.5, [track("t1", 0, { onScreen: true, ontoFrames: 2, lostFrames: 0, accuracy: 1 })]),
      obs(2, 2.5, [track("t1", 0, { onScreen: false, ontoFrames: 0, lostFrames: 1, accuracy: 0.5 })]),
      obs(3, 4.5, [track("t2", 1, { label: "ball", kind: "ball", onScreen: true, ontoFrames: 1 })]),
    ];
    const traces = buildTraces(observations);
    expect(traces.map((t) => t.trackId)).toEqual(["t1", "t2"]);
    const t1 = traces[0];
    expect(t1.onScreen).toBe(2); // off-screen frame not counted
    expect(t1.ontoFrames).toBe(3);
    expect(t1.lostFrames).toBe(1); // max observed lostFrames
    expect(t1.accuracy).toBe(0.5); // last observed accuracy
    expect(t1.selected).toBe(true);
    const t2 = traces[1];
    expect(t2.onScreen).toBe(1);
    expect(t2.kind).toBe("ball");
  });
});

describe("maxTracesForSource", () => {
  it("caps live jobs at 3 and VOD at 8", () => {
    expect(maxTracesForSource("rtmp")).toBe(3);
    expect(maxTracesForSource("webrtc")).toBe(3);
    expect(maxTracesForSource("browser")).toBe(3);
    expect(maxTracesForSource("file-sim")).toBe(3);
    expect(maxTracesForSource("file")).toBe(8);
  });
});

describe("durable observations + candidates survive a restart (ADAAAA-6851 Inc 1/2)", () => {
  it("round-trips observations and candidates through a reopen of the DB file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hl-jd-"));
    const file = path.join(dir, "highlights.db");

    let db: SqliteDb = new SqliteDb(file);
    await db.migrate();
    let store = new Store(db);
    await store.load();
    const job = await store.createJob({ source: "file", sourceUrl: "/tmp/v.mp4", gameHint: "soccer" });
    await store.patchJob(job.id, { status: "done", framesAnalyzed: 3 });
    await store.recordObservation(job.id, obs(0, 0.2, [track("t1", 0)]));
    await store.recordObservation(job.id, obs(1, 3.1, [track("t1", 0), track("t2", 1)]));
    await store.recordJobCandidate(cand({ timestamp: 3.1, reason: "ball in net", score: 92 }, job.id));
    await db.close();

    // Simulated restart.
    db = new SqliteDb(file);
    await db.migrate();
    store = new Store(db);
    await store.load();

    expect(store.observationsForJob(job.id)).toHaveLength(2);
    expect(store.observationsForJob(job.id).map((o) => o.seq)).toEqual([0, 1]);
    expect(store.observationsForJob(job.id)[1].tracks).toHaveLength(2);
    const gotCands = store.candidatesForJob(job.id);
    expect(gotCands).toHaveLength(1);
    expect(gotCands[0].reason).toBe("ball in net");
    expect(gotCands[0].score).toBe(92);

    // The composite detail builders work off the restored data.
    const sections = buildSections(store.observationsForJob(job.id), gotCands, job.id);
    const allSeqs = sections.flatMap((s) => s.frames.map((f) => f.seq));
    expect(allSeqs.sort((a, b) => a - b)).toEqual([0, 1]);
    expect(new Set(allSeqs).size).toBe(allSeqs.length);
    expect(store.getJob(job.id)!.framesAnalyzed).toBe(3);

    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
