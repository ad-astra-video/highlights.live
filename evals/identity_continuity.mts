#!/usr/bin/env -S node --import tsx
// ADAAAA-6032 (plan D) — entity identity continuity across windows (eval).
//
// Drives the REAL server resolver (EntityIdentityResolver + LiveRunShared) over
// a labeled multi-window manifest (evals/identity_manifest.json) and scores:
//
//   - continuity (tracking value): every occurrence of a ground-truth labeled
//     entity must resolve to ONE entityRef across windows (no fragmentation),
//     and distinct entities must never share an entityRef (no false merge).
//     Pass bar: continuity >= manifest.targetContinuity (default 0.95) with
//     zero false merges.
//   - A4 narrative arc: for a yellow@T -> red@T+30 arc, the red candidate's
//     prior context (entityArcContext) must reference the earlier yellow.
//
// This is the identity side of the "whole-picture" narrative (plan D / A4).
// Run from the repo root:
//   node --import tsx evals/identity_continuity.mts [manifest.json]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { LiveRunShared } from "../services/server/src/analyzer.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const defaultManifest = join(HERE, "identity_manifest.json");
const path = process.argv[2] ?? defaultManifest;
const manifest = JSON.parse(readFileSync(path, "utf8"));
const TARGET = manifest.targetContinuity ?? 0.95;

type TrackIn = { id: string; trackId: string; bbox: number[]; jersey?: string };
type EventIn = { ts: number; entity: string; eventType: string; reason?: string };
interface Arc {
  id: string;
  windows: { ts: number; tracks: TrackIn[]; ocr?: string[] }[];
  events?: EventIn[];
  sameRef?: string[][];
  distinctPairs?: [string, string][];
  arcEntity?: string;
  arcLaterTs?: number;
  arcEarlierEventType?: string;
}

interface ArcResult {
  id: string;
  continuity: number | null;
  falseMerge: number;
  refsByName: Record<string, string[]>;
  arcPass?: boolean;
  pass: boolean;
}

function runArc(arc: Arc): ArcResult {
  const s = new LiveRunShared();
  const refsByName: Record<string, string[]> = {};
  let seq = 0;
  for (const w of arc.windows) {
    const tracks = w.tracks.map((t) => ({
      trackId: t.trackId,
      slot: 0,
      bbox: t.bbox as [number, number, number, number],
      kind: "player" as const,
      ...(t.jersey ? { label: t.jersey } : {}),
    }));
    s.addFrame(seq, w.ts, `img${seq}`);
    s.setFindings(seq, { tracks: tracks as any, ocr: w.ocr ?? [] });
    // Map each ground-truth labeled entity to the ref(s) its track resolved to.
    for (let i = 0; i < w.tracks.length; i++) {
      const lab = w.tracks[i];
      const resolvedRef = s.identity.refOfTrack(tracks[i].trackId);
      (refsByName[lab.id] ??= []).push(resolvedRef ?? "");
    }
    seq++;
  }
  // Continuity: fraction of labeled entities whose occurrences all share one ref.
  const entities = Object.keys(refsByName);
  let continuous = 0;
  for (const name of entities) {
    const refs = new Set(refsByName[name].filter(Boolean));
    if (refs.size === 1) continuous++;
  }
  const continuity = entities.length ? continuous / entities.length : null;
  // False-merge: distinct labeled entities must never share an entityRef.
  const seenPair = new Set<string>();
  let falseMerge = 0;
  for (let i = 0; i < entities.length; i++) {
    for (let j = i + 1; j < entities.length; j++) {
      const a = new Set(refsByName[entities[i]]);
      const b = refsByName[entities[j]];
      if (b.some((x) => x && a.has(x))) falseMerge++;
      void seenPair.add(`${entities[i]}|${entities[j]}`);
    }
  }
  // A4 arc: record the earlier event on its entity, then check the later
  // candidate's prior context references it.
  let arcPass: boolean | undefined;
  if (arc.arcEntity && arc.arcLaterTs && arc.arcEarlierEventType) {
    for (const ev of arc.events ?? []) {
      // eventType + reason alternates are recorded onto the dominant entity at
      // that timestamp (the real highlight path).
      if (ev.ts === (arc.windows[0]?.ts ?? ev.ts) || true) {
        s.recordHighlightEntity(ev.ts, { eventType: ev.eventType, reason: ev.reason });
      }
    }
    const later = s.entityArcContextForCandidate(arc.arcLaterTs);
    arcPass = later.includes(arc.arcEarlierEventType);
  }
  return { id: arc.id, continuity, falseMerge, refsByName, arcPass, pass: false };
}

function main(): number {
  const arcs: Arc[] = manifest.arcs;
  console.log(`identity-continuity run  sport=${manifest.sport} target=${TARGET} arcs=${arcs.length}`);
  let overall = true;
  for (const arc of arcs) {
    const r = runArc(arc);
    const continuityOk = r.continuity === null ? true : r.continuity >= TARGET;
    const noFalseMerge = r.falseMerge === 0;
    const arcOk = r.arcPass === undefined ? true : r.arcPass;
    const pass = continuityOk && noFalseMerge && arcOk;
    overall = overall && pass;
    console.log(`  ${arc.id.padEnd(34)} continuity=${r.continuity?.toFixed(3) ?? "-"} `
      + `(bar ${TARGET}) falseMerge=${r.falseMerge} ${r.arcPass !== undefined ? `arc=${r.arcPass} ` : ""}-> ${pass ? "PASS" : "FAIL"}`);
    if (!pass) {
      console.log(`    refsByName=${JSON.stringify(r.refsByName)}`);
    }
  }
  console.log("OVERALL:", overall ? "PASS" : "FAIL");
  return overall ? 0 : 1;
}

process.exit(main());
