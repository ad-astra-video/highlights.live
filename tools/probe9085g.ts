import { attestedEntityNames, attestedActorNames, summaryFactCandidates, attestedFactKinds } from "@highlights/events";
const ev: any = {
  rail: "vod", verdict: "big_play", eventType: "BIG_PLAY", reason: "Goal confirmed by the frame dive.", caption: "BIG PLAY · 1:21",
  postTitle: "BIG PLAY · 1:21", windowTs: 81, windowDurationS: 8, scoreTransition: null,
  matchContext: { sport: "soccer", teams: [{ name: "Real Madrid", side: "home" }] },
  transcript: "aleador del Real Madrid y el balance para el Barça. La intenta por banda derecha.",
  attestation: { ballOutcome: null, goalCrossed: false, scoreBoardChanged: false, goalConfirmed: "confirmed_goal" },
};
console.log("entity", attestedEntityNames(ev.transcript));
console.log("actors", attestedActorNames(ev));
console.log("kinds", attestedFactKinds(ev));
console.log("pool", summaryFactCandidates(ev).map(c => `${c.kinds}|${c.sentence}`));
