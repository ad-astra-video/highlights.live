// ADAAAA-6028 — faithful server-side grounding eval driver.
// Runs the REAL deployed-analyzer VOD pass (analyzeJob + Stage-A audio tap) over
// the labeled grounding clips, through the deployed decide/perceive services,
// capturing each raw decide decision (with grounding) and the server-side
// grounding-gate outcome. Produces /app/evals/grounding-trace.json consumed by
// grounding_eval.py.  (async main wrapper: /app/evals is CJS, no top-level await)
import { analyzeJob, decideOnCandidate, LiveRunShared } from "../services/server/src/analyzer.js";
import { DirectAdapter, buildAnalyzeFrames } from "../services/server/src/livepeer-adapter.js";
import { extractFrames } from "../services/server/src/ffmpeg.js";
import { extractVodAudioChunks } from "../services/server/src/vod-audio.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";

const FFMPEG = "/usr/bin/ffmpeg";
const PERCEIVE = "http://perceive:8080";
const DECIDE = "http://decide:8081";
const VOD_FPS = 2;
const VOD_SCALE = "640:360";
const WINDOW = 24;

async function main() {
  const manifest = JSON.parse(readFileSync("/app/evals/grounding-label-manifest.json", "utf-8"));
  const samples: any[] = manifest.samples;
  const trace: any[] = [];
  let tp = 0, fp = 0, fn = 0, totRej = 0;

  for (const s of samples) {
    const uuid = (s.source as string).split("/").pop();
    const videoPath = `/data/clips/${uuid}`;
    const clipId = `eval-${s.id}`;
    const frameDir = `/tmp/gef/${clipId}`;
    if (!existsSync(videoPath)) {
      console.log(`MISSING ${s.id} ${videoPath}`);
      trace.push({ sampleId: s.id, missing: true });
      continue;
    }
    rmSync(frameDir, { recursive: true, force: true });
    mkdirSync(frameDir, { recursive: true });

    const adapter = new DirectAdapter({ perceiveUrl: PERCEIVE, decideUrl: DECIDE } as any);
    const raw: any[] = [];
    const origDecide = adapter.decide.bind(adapter);
    (adapter as any).decide = async (evidence: any, opts?: any) => {
      const d = await origDecide(evidence, opts);
      raw.push({
        claimedEventType: evidence?.eventType,
        isHighlight: d.isHighlight,
        eventType: d.eventType,
        score: d.score,
        grounding: d.grounding,
        reason: d.reason,
      });
      return d;
    };

    await extractFrames(FFMPEG, videoPath, frameDir, VOD_FPS, VOD_SCALE);
    const cfg: any = {
      jobId: clipId, clipBeforeS: 2, clipAfterS: 2, gameHint: "soccer", preferLabels: [],
      sampleFps: VOD_FPS, frameScale: VOD_SCALE, decideWindowN: WINDOW, maxReReserves: 2,
    };
    const cut = async (_ts: number) => ({ clipId: `${clipId}-cut`, clipUri: `/clips/${clipId}-cut.mp4` });
    // ADAAAA-6079: mirror production VOD — preload the full clip timeline and
    // enable the GOAL forward-extending look-ahead window so a high-value
    // candidate's decide window reaches the net-crossing/celebration frames.
    const LOOKAHEAD = 24;
    const frames: any[] = [];
    for await (const f of buildAnalyzeFrames(frameDir, VOD_FPS)()) frames.push(f);
    const iter = (async function* () { for (const f of frames) yield f; })();
    const shared = new LiveRunShared({ decideWindowN: WINDOW, lookaheadN: LOOKAHEAD });
    shared.preloadTimeline(frames);
    const onEvent = () => {};
    const audioLoop = (async () => {
      for await (const chunk of extractVodAudioChunks(FFMPEG, videoPath)) {
        shared.addAudioChunk(chunk.timestamp, chunk.samples);
        try {
          const cand = await adapter.postAudio("local-dev", {
            seq: chunk.seq, timestamp: chunk.timestamp, samples: chunk.samples, streamId: clipId,
          });
          if (cand) {
            await decideOnCandidate(adapter, shared, cut, cfg, cand, onEvent, { seq: chunk.seq, timestamp: chunk.timestamp });
          }
        } catch { /* best-effort audio tap */ }
      }
    })();
    let outcome: any;
    try {
      outcome = await analyzeJob(adapter, iter, cut, cfg, onEvent, undefined, shared);
    } finally {
      await audioLoop;
    }

    const gtGoal = !!s.isGoal;
    const surfacedGoals = outcome.highlights.filter((h: any) => String(h.eventType || "").toUpperCase() === "GOAL");
    const anyAcceptedGoal = surfacedGoals.length > 0;
    const claimed = raw.filter((d: any) => d.isHighlight);

    let decision: any;
    if (anyAcceptedGoal) {
      decision = { isHighlight: true, eventType: "GOAL", grounding: { objects: ["track"], evidence: "surfaced", supports: true } };
    } else if (claimed.length > 0) {
      decision = { isHighlight: true, eventType: "GOAL", grounding: {} };
    } else {
      decision = { isHighlight: false, eventType: "NONE", grounding: {} };
    }

    const rej = outcome.groundingRejections || 0;
    totRej += rej;
    if (gtGoal && anyAcceptedGoal) tp++;
    else if (!gtGoal && anyAcceptedGoal) fp++;
    else if (gtGoal && !anyAcceptedGoal) fn++;

    trace.push({
      sampleId: s.id, isGoal: gtGoal, decision,
      claims: raw.length, claimedHighlights: claimed.length, groundingRejections: rej,
      framesAnalyzed: outcome.framesAnalyzed,
      highlights: outcome.highlights.map((h: any) => ({ eventType: h.eventType, score: h.score })),
      raw,
    });
    console.log(`DONE ${s.id} goal=${gtGoal} frames=${outcome.framesAnalyzed} claims=${claimed.length} rej=${rej} surfacedGoal=${anyAcceptedGoal} highlights=${outcome.highlights.length}`);
    writeFileSync("/app/evals/grounding-trace.json", JSON.stringify(trace, null, 2));
  } // for

  const denom = tp + fp;
  const precision = denom ? tp / denom : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  console.log("---G1/G2/G3 (clip-level, real pipeline outcome)---");
  console.log(`TP=${tp} FP=${fp} FN=${fn}  G1 precision=${precision === null ? "n/a" : (precision * 100).toFixed(1) + "%"}  G2 recall=${recall === null ? "n/a" : (recall * 100).toFixed(1) + "%"}  G3 rejections=${totRej}`);
  console.log("WROTE /app/evals/grounding-trace.json");
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
