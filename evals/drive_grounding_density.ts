// ADAAAA-6079 (PO-ruled, ONE bounded density experiment): higher-density /
// higher-resolution resample around GOAL candidates.
//
// The baseline rolling-window eval (drive_grounding_server.ts, baseline restore
// 32c5c6b) misses soc-goal-01/02: the 2 fps / 640:360 rolling window forwarded
// to decide() at a GOAL candidate's trigger timestamp holds only pre-goal frames,
// and even the full-timeline GOAL window (retired as net-negative) showed the
// model a blurry/time-missed sequence. This experiment tests whether the clips
// contain a MODELABLE net-crossing at all: for each clip we present the FULL
// clip timeline at higher fps AND native resolution to the same deployed decide
// service, so a brief crossing that a 2fps/640:360 sub-sample blurs or misses is
// actually visible to the model.
//
// This is the decisive vision verification the PO called for (item 5): feed
// full-res frames to the model. If goal-01/02 STILL return grounding.supports
// =false / score 0 at native density, that is strong evidence the clips lack a
// visible/modelable net-crossing -> PO then owns the label-correct/descope path
// on ADAAAA-6028 (no silent descope). Bounded: one fixed resample config, all
// 12 clips, same deployed decide/perceive services (no analyzer change).
import { applyGroundingGate, buildReactionEvidence } from "../services/server/src/analyzer.js";
import { DirectAdapter } from "../services/server/src/livepeer-adapter.js";
import { extractFrames } from "../services/server/src/ffmpeg.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

const FFMPEG = "/usr/bin/ffmpeg";
const PERCEIVE = "http://perceive:8080";
const DECIDE = "http://decide:8081";
// The ONE bounded density config (fixed compute): full clip at native res, higher
// fps than the 2fps baseline. 1280:720 is the source native resolution of both
// missed clips (verified via ffprobe). Window is the whole clip (short VOD).
const DENSITY_FPS = 6;
const DENSITY_SCALE = "1280:720";

async function main() {
  const manifest = JSON.parse(readFileSync("/app/evals/grounding-label-manifest.json", "utf-8"));
  const samples: any[] = manifest.samples;
  const trace: any[] = [];
  let tp = 0, fp = 0, fn = 0, totRej = 0;

  for (const s of samples) {
    const uuid = (s.source as string).split("/").pop();
    const videoPath = `/data/clips/${uuid}`;
    const clipId = `dense-${s.id}`;
    const frameDir = `/tmp/gdf/${clipId}`;
    if (!existsSync(videoPath)) {
      console.log(`MISSING ${s.id} ${videoPath}`);
      trace.push({ sampleId: s.id, missing: true });
      continue;
    }
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });

    const adapter = new DirectAdapter({ perceiveUrl: PERCEIVE, decideUrl: DECIDE } as any);
    await extractFrames(FFMPEG, videoPath, frameDir, DENSITY_FPS, DENSITY_SCALE);
    // Dense full-clip timeline (seq -> timestamp = seq / fps) at native res.
    const files = (await import("node:fs/promises").then((fs) => fs.readdir(frameDir)))
      .filter((f) => f.startsWith("frame_")).sort();
    const frames = files.map((f) => {
      const b64 = readFileSync(`${frameDir}/${f}`).toString("base64");
      return { role: "full", base64: b64 };
    });
    console.log(`CLIP ${s.id} frames=${frames.length} (${DENSITY_FPS}fps ${DENSITY_SCALE})`);

    // Present the whole dense clip to the same deployed decide service as a GOAL
    // candidate, mirroring the analyzer's detailDecideOpts frame usage. The
    // full clip holds the strike->net->celebration sequence at native density.
    const evidence = { eventType: "GOAL", trackCount: 0, maxVelocity: 0, ocrHits: 0, reaction: {} };
    const decision = await adapter.decide(
      evidence as any,
      { gameHint: "soccer", imageB64: frames[Math.floor(frames.length / 2)]?.base64, frames }
    );

    const gate = applyGroundingGate(decision as any, "GOAL");
    const surfacedGoal = decision.isHighlight && gate.accepted;
    const rej = gate.accepted ? 0 : 1;
    totRej += rej;
    const gtGoal = !!s.isGoal;
    if (gtGoal && surfacedGoal) tp++;
    else if (!gtGoal && surfacedGoal) fp++;
    else if (gtGoal && !surfacedGoal) fn++;

    trace.push({
      sampleId: s.id, isGoal: gtGoal, frames: frames.length, decision,
      grounding: decision.grounding, gateAccepted: gate.accepted, surfacedGoal,
      rejectReason: gate.accepted ? "" : gate.reason,
    });
    console.log(`DONE ${s.id} goal=${gtGoal} frames=${frames.length} isHighlight=${decision.isHighlight} score=${decision.score} grounding=${JSON.stringify(decision.grounding)} gateAccepted=${gate.accepted} surfacedGoal=${surfacedGoal} rej=${rej}`);
    writeFileSync("/app/evals/grounding-trace-density.json", JSON.stringify(trace, null, 2));
  }

  const denom = tp + fp;
  const precision = denom ? tp / denom : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  console.log("---G1/G2/G3 (clip-level, DENSITY full-clip resample)---");
  console.log(`TP=${tp} FP=${fp} FN=${fn}  G1 precision=${precision === null ? "n/a" : (precision * 100).toFixed(1) + "%"}  G2 recall=${recall === null ? "n/a" : (recall * 100).toFixed(1) + "%"}  G3 rejections=${totRej}`);
  console.log("WROTE /app/evals/grounding-trace-density.json");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
