#!/usr/bin/env -S ./node_modules/.bin/tsx
// ADAAAA-4885: $0 replay of the Stage-A trigger-quality measure over a STORED
// job's evidence — no recreate, no deploy, no job POST, no GPU.
//
// The deployed record predates the additive `realEventFires` /
// `spuriousNoiseFires` / `realEventFireRate` fields, so this replays the
// SHIPPED rule (the same StageAMetrics/StageAOutcomeLedger classes the server
// uses) over the persisted per-window decision trail:
//
//   fires    = candidate rows whose eventType is AUDIO_BURST (the window the
//              audio gate anchored), onsetTs taken as that window's tick
//   windows  = every stored decide window; live rail evidence span is
//              [ts - 10, ts] (LIVE_OBSERVE_WINDOW_S), accepted = isHighlight
//
// It prints the old `fpRate` (gemma reject rate) beside the replayed
// `realEventFireRate` for the same job, and labels the reconstruction so the
// number is never quoted as a raw live measurement.
//
// Usage:
//   tsx scripts/stage-a-trigger-quality-replay.ts <dump.json>
//
// Dump shape (produced by the SQL in the ADAAAA-4885 closing comment):
//   { "jobId": "...", "source": "rtmp", "stored": { ...stageAMetrics... },
//     "windows": [{ "ts": 117, "accepted": true, "eventType": "GOAL" }, ...] }
import { readFileSync } from "node:fs";
import {
  StageAMetrics,
  StageAOutcomeLedger,
  STAGE_A_CORROBORATION_SLACK_S,
  STAGE_A_CORROBORATION_HORIZON_S,
} from "../services/server/src/stage-a-metrics";
import { LIVE_OBSERVE_WINDOW_S } from "../services/server/src/observe-loop";

interface Dump {
  jobId: string;
  source?: string;
  stored?: Record<string, unknown>;
  windows: Array<{ ts: number; accepted: boolean; eventType?: string }>;
}

const path = process.argv[2];
if (!path) {
  console.error("usage: tsx scripts/stage-a-trigger-quality-replay.ts <dump.json>");
  process.exit(2);
}
const dump = JSON.parse(readFileSync(path, "utf8")) as Dump;
const windows = [...dump.windows].sort((a, b) => a.ts - b.ts);
if (windows.length === 0) {
  console.error("dump carries no decide windows — nothing to replay");
  process.exit(2);
}

// Fires: the audio gate anchored these windows. The stored tick is the window's
// own timestamp (the fire time), used as the onset proxy — the deployed record
// never persisted the gate's raw onset.
const fires = windows.filter((w) => w.eventType === "AUDIO_BURST").map((w) => w.ts);

const metrics = new StageAMetrics();
const ledger = new StageAOutcomeLedger(metrics);
let recorded = 0;
let nextFire = 0;
for (const w of windows) {
  // Record fires up to this window's tick before judging it, so the window can
  // judge its own anchored fire exactly like the live observer does.
  while (nextFire < fires.length && fires[nextFire] <= w.ts) {
    ledger.recordTrigger({ onsetTs: fires[nextFire], onsetLatencyS: 0 });
    recorded += 1;
    nextFire += 1;
  }
  ledger.judgeWindow(w.ts - LIVE_OBSERVE_WINDOW_S, w.ts, w.accepted);
}
ledger.finalize();

const replay = metrics.snapshot();
const stored = (dump.stored ?? {}) as Record<string, number | undefined>;
const oldFpRate = stored.fpRate;
const oldTotal = stored.totalCandidates;
const oldRejected = stored.rejected;

console.log(JSON.stringify({
  jobId: dump.jobId,
  source: dump.source ?? null,
  rule: {
    corroborationSlackS: STAGE_A_CORROBORATION_SLACK_S,
    corroborationHorizonS: STAGE_A_CORROBORATION_HORIZON_S,
    windowSpanS: LIVE_OBSERVE_WINDOW_S,
  },
  reconstruction: {
    windows: windows.length,
    fireWindows: fires.length,
    firesRecorded: recorded,
    note: "fires reconstructed from AUDIO_BURST candidate rows; onset proxied by the window tick",
  },
  stored: { totalCandidates: oldTotal, rejected: oldRejected, fpRate: oldFpRate },
  replayed: {
    totalCandidates: replay.totalCandidates,
    rejected: replay.rejected,
    fpRate: replay.fpRate,
    realEventFires: replay.realEventFires ?? null,
    spuriousNoiseFires: replay.spuriousNoiseFires ?? null,
    realEventFireRate: replay.realEventFireRate ?? null,
  },
}, null, 2));

console.log(
  `\n[${dump.source ?? "live"}:${dump.jobId}] stageA fpRate=${oldFpRate} ` +
    `(${oldRejected}/${oldTotal} rejected) -> realEventFireRate=${replay.realEventFireRate ?? "n/a"} ` +
    `(${replay.realEventFires ?? 0}/${(replay.realEventFires ?? 0) + (replay.spuriousNoiseFires ?? 0)} fires corroborated)`
);
