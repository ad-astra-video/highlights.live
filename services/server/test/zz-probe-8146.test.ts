// ADAAAA-8146 READ-ONLY PROBE (not a landed test): replays the measured shape of
// live job 9a6b1d8f against the CURRENT master (build 8eb85a3) accept-path rules,
// to size the fix before any funded leg runs.
//
// Measured rows (box Postgres, job 9a6b1d8f-7204-44ea-addd-4e93ac0cac38):
//   e17aecb0  candidateTs 2.603  anchor 12.603  transition 1-1 -> 2-1  scoring_play
//   7f1091c8  candidateTs 38.730 anchor 48.730  transition 1-1 -> 2-1  scoring_play
//   081785e2  candidateTs 84.941 anchor 94.941  transition 1-1 -> 2-1  scoring_play
// All three: accepted, attestationUsed.scoreBoardChanged=true, corroborated=false.
import { describe, it } from "vitest";
import { LiveRunShared, findRepeatGoalEvent, type AcceptedGoalEvent } from "../src/analyzer";

const DELIVERED: AcceptedGoalEvent = {
  highlightId: "e17aecb0-f78b-4596-915c-0f07a2d0038e",
  anchorTs: 12.603,
  start: 7.603,
  end: 22.603,
  candidateTs: 2.603,
  transitionKey: "1-1>2-1",
  idempotencyKey: "job9a6b1d8f:hl:e17aecb0",
};

function run() {
  const s = new LiveRunShared();
  s.noteAcceptedGoalEvent(DELIVERED);
  return s;
}

describe("ADAAAA-8146 probe: current master vs the measured triple", () => {
  it("prints the current decision for each measured candidate", () => {
    const s = run();
    const r2 = s.goalBurstSuppression({ ts: 38.73, eventType: "GOAL", corroborated: false, transitionKey: "1-1>2-1" });
    const r3 = s.goalBurstSuppression({ ts: 84.941, eventType: "GOAL", corroborated: false, transitionKey: "1-1>2-1" });
    const distinct = s.goalBurstSuppression({ ts: 38.73, eventType: "GOAL", corroborated: false, transitionKey: "2-1>3-1" });
    const nullKey = s.goalBurstSuppression({ ts: 38.73, eventType: "GOAL", corroborated: false, transitionKey: null });
    const repeat = findRepeatGoalEvent([DELIVERED], {
      anchorTs: 48.73,
      start: 38.73,
      end: 53.73,
      isGoal: true,
      corroborationSource: null,
      scoreboardDeltaLegible: true,
      confirmEvidenceScoreboardChanged: null,
    });
    const out = {
      "reread@38.730s(same 1-1>2-1)": r2 ?? "NOT SUPPRESSED (would ship as GOAL #2)",
      "reread@84.941s(same 1-1>2-1)": r3 ?? "NOT SUPPRESSED (would ship as GOAL #3)",
      "distinct@38.730s(2-1>3-1)": distinct ?? "NOT SUPPRESSED (correct: distinct goal ships)",
      "nullKey@38.730s(shootout re-read)": nullKey ?? "NOT SUPPRESSED (today: 30 s window only)",
      "findRepeatGoalEvent@48.730s(legible delta)":
        repeat ?? "NO DOWNGRADE (7865 stands down: legible delta counts as independent evidence)",
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
  });
});
