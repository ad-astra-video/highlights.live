// ADAAAA-8820 (D2/AC2.3) — anchor accuracy on a LABELED fixture, against the
// same fixture's accept-anchor baseline.
//
// AC2.3 asks for: median |anchor error| <= 1.0 s and >= 80 % of confirmed goals
// within 2 s, measured against the accept-anchor baseline on the same fixture.
//
// What this harness measures, and what it deliberately does not ($0 leg): the
// ground truth and the accept anchor come from the labeled fixture (measured lag
// shapes from legs `357a927d` / `a5de612a`). The DIVE side is derived from the
// frame grid the live lane really sends — `buildPersistedConfirmContext` at the
// shipped cells (1 fps persisted frames, event ± lead/trail, maxFrames 12) — with
// a PERFECT dive (it names the frame nearest the truth). So this is the ceiling
// the contract can reach on that grid: if the grid itself cannot land inside 1 s,
// no model can, and the fix belongs in the frame cell rather than the prompt. The
// model's real accuracy is graded by QA on a funded leg.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildPersistedConfirmContext, diveReanchorDecision } from "../src/live-confirm-async";

const FIXTURE = path.join(__dirname, "fixtures", "live-goal-instants-8820.json");

interface LabeledGoal {
  id: string;
  truthTs: number;
  acceptTs: number;
}

function loadFixture(): LabeledGoal[] {
  const raw = JSON.parse(readFileSync(FIXTURE, "utf8")) as { goals: LabeledGoal[] };
  return raw.goals;
}

/** The persisted frames the live dive lane would load for this row: 1 fps across
 *  the dive window, exactly the density the rail writes. */
function persistedGrid(acceptTs: number): { seq: number; ts: number; base64: string }[] {
  const out: { seq: number; ts: number; base64: string }[] = [];
  for (let ts = Math.max(0, acceptTs - 5); ts <= acceptTs + 4 + 1e-9; ts += 1) {
    out.push({ seq: Math.round(ts), ts: Number(ts.toFixed(3)), base64: "x" });
  }
  return out;
}

/** A PERFECT dive on this grid: it names the sent frame nearest the true instant. */
function perfectDiveMoment(acceptTs: number, truthTs: number): number {
  const ctx = buildPersistedConfirmContext({ frames: persistedGrid(acceptTs), eventTs: acceptTs, maxFrames: 12 });
  const sent = ctx.frames.map((f) => Number(f.ts)).filter((t) => Number.isFinite(t));
  expect(sent.length).toBeGreaterThan(0);
  return sent.reduce((best, t) => (Math.abs(t - truthTs) < Math.abs(best - truthTs) ? t : best), sent[0]);
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

describe("AC2.3 — dive moment vs accept anchor on the labeled fixture", () => {
  const goals = loadFixture();

  it("has a real labeled population", () => {
    expect(goals.length).toBeGreaterThanOrEqual(10);
    for (const g of goals) {
      expect(Number.isFinite(g.truthTs)).toBe(true);
      expect(Number.isFinite(g.acceptTs)).toBe(true);
    }
  });

  it("beats the accept-anchor baseline and clears the AC2.3 bars", () => {
    const acceptErr: number[] = [];
    const diveErr: number[] = [];
    const drifts: number[] = [];
    const applyCount: number[] = [];
    for (const g of goals) {
      const momentTs = perfectDiveMoment(g.acceptTs, g.truthTs);
      acceptErr.push(Math.abs(g.acceptTs - g.truthTs));
      diveErr.push(Math.abs(momentTs - g.truthTs));
      drifts.push(Math.abs(momentTs - g.acceptTs));
      const gate = diveReanchorDecision({ goalConfirmed: "confirmed_goal", momentTs, acceptTs: g.acceptTs });
      applyCount.push(gate.apply ? 1 : 0);
    }
    const acceptMedian = median(acceptErr);
    const diveMedian = median(diveErr);
    const within2 = diveErr.filter((e) => e <= 2.0).length / diveErr.length;
    const applied = applyCount.reduce((a, b) => a + b, 0);
    console.log(
      `[AC2.3 fixture] n=${goals.length} accept median=${acceptMedian.toFixed(3)}s ` +
        `dive median=${diveMedian.toFixed(3)}s within2s=${(within2 * 100).toFixed(1)}% ` +
        `re-anchor applied on ${applied}/${goals.length} rows (drift p50=${median(drifts).toFixed(3)}s)`
    );
    // the bars the AC names
    expect(diveMedian).toBeLessThanOrEqual(1.0);
    expect(within2).toBeGreaterThanOrEqual(0.8);
    // and the improvement the AC is FOR: the dive must beat the accept baseline
    // on this fixture, not merely pass in absolute terms.
    expect(diveMedian).toBeLessThan(acceptMedian);
    expect(acceptMedian).toBeGreaterThan(1.0);
    // the re-anchor path is actually exercised (a fix that never fires would pass
    // the absolute bars while changing nothing)
    expect(applied).toBeGreaterThanOrEqual(Math.ceil(goals.length * 0.5));
  });
});
