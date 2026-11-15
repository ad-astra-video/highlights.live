import { newSummaryJobState, runSummaryForRow } from "../services/server/src/summary-lane.js";
import { summaryOpeningRun } from "@highlights/events";
import { summarySentencesOf } from "@highlights/events";
const patches: any[] = [];
const store: any = { async patchHighlightSummary(id: string, patch: any) { patches.push({ id, patch }); return {}; } };
const evidence: any = {
  rail: "vod", verdict: "big_play", eventType: "BIG_PLAY", reason: "Goal confirmed by the frame dive.", caption: "BIG PLAY · 1:21",
  postTitle: "BIG PLAY · 1:21", windowTs: 81, windowDurationS: 8, scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: "aleador del Real Madrid y el balance para el Barça. La intenta por banda derecha.",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
};
const SERVED = "Manuel Ordoñez finds the back of the net for Real Madrid. This scoring play occurs at 0:24 into the clip. Carlos Javier is in the passage at 0:24 into the clip. The clip carries this sequence at 0:24 into the clip.";
const state = newSummaryJobState();
state.servedBodies.push({ highlightId: "s", windowTs: 24, windowDurationS: 8, clockToken: "0:24", body: SERVED, opening: summaryOpeningRun(SERVED) });
for (const s of summarySentencesOf(SERVED)) state.servedSentences.push(s);
state.servedOpenings.add(summaryOpeningRun(SERVED));
const body = "Real Madrid is in the passage at 1:21 into the clip. At 1:21 into the clip, the ball crosses the goal line. The clip carries this sequence at 1:21 into the clip. The window runs at 1:21 into the clip.";
const fn = (async (_u: string, init: any) => { return new Response(JSON.stringify({ summary: body }), { status: 200, headers: { "content-type": "application/json" } }) as any; }) as any;
async function main() {
const r = await runSummaryForRow(store, { decideUrl: "x", decideFee: 0.01, fetchImpl: fn, log: (l: string) => console.log("LOG", l) } as any, { jobId: "j", highlightId: "row-8d78c11f", evidence }, state);
console.log("result", r);
console.log("patch", JSON.stringify(patches.at(-1)?.patch, null, 1));

}
main();
