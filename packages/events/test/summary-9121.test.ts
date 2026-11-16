// ADAAAA-9121 (writer round 3) — the substance-rotation lever.
//
// Measured `$0` on the rev-17 served block `80ac7b3` (job `1e0d7187`, 7 stored
// rows, all post-pin): 5 of the 5 `repeat-*` rows served nothing, because every
// card's second sentence was the SAME legal act-plus-purpose clause
// (`… completes a pass to maintain their offensive movement during the sequence.`
// on three cards, `… completes a pass to move the ball toward the opposing side of
// the pitch.` on two; cross-card similarity 1.000 with clock tokens masked). The
// AC14 prune deleted it, the remainder fell under the 18-word floor, and the row
// dropped `prune:gate` with `repairedWords` 15/15/0/0/0.
//
// This file pins the two prompt levers that fix the CAUSE rather than the shape:
// the banned substance SHAPES (a purpose clause is not a fact), and the job-scoped
// rotation of actor-and-act pairs, so card 2..n cannot re-spend card 1's pair.
// The second block replays the stored rows: the stored drafts reproduce the
// failure, and drafts that follow the rotation rule serve 7/7 under the same gate
// and the same AC14.3 bar.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildSummaryPrompt,
  gateSummaryDetail,
  sentenceSimilarity,
  summaryBand,
  summarySentencesOf,
  summarySpentActPairs,
  SUMMARY_SENTENCE_REPEAT_THRESHOLD,
  type SummaryEvidence,
} from "../src/index.js";
import { summaryEvidenceForRow } from "../../../services/server/src/summary-lane.js";

const bundle = JSON.parse(
  readFileSync(new URL("../../../evals/adaaa_9121/job-1e0d7187-rows.json", import.meta.url), "utf8")
) as { job: any; rows: any[] };

const evidenceFor = (row: any, rail: "live" | "vod" = "live"): SummaryEvidence =>
  summaryEvidenceForRow(
    {
      verdict: row.verdict ?? row.outcome,
      eventType: row.eventType,
      outcome: row.outcome,
      reason: row.reason_raw,
      caption: row.caption,
      postTitle: row.postTitle,
      trigger: row.trigger,
      start: row.start,
      end: row.end,
      matchClock: row.matchClock,
      attestationUsed: row.attestationUsed,
      goalConfirmed: row.confirmAttestation?.goalConfirmed ?? null,
      confirmAttestation: row.confirmAttestation,
      asrTranscript: row.asrTranscript,
      matchContext: bundle.job.matchContext,
    },
    rail
  );

const hid = (row: any) => String(row.id).slice(0, 8);

describe("ADAAAA-9121 — the prompt bans the substance shape, not only the frame", () => {
  const ACTOR_ROW = bundle.rows[0];

  it("carries the banned substance shapes, rendered with X and never filled in", () => {
    const prompt = buildSummaryPrompt(evidenceFor(ACTOR_ROW));
    expect(prompt).toContain("BANNED SUBSTANCE SHAPES");
    expect(prompt).toContain("'X completes a pass to move the ball toward the opposing side of the pitch'");
    expect(prompt).toContain("'X completes a pass to maintain their offensive movement during the sequence'");
    // AC14 copies a filled sentence, so the ban never renders one: no attested
    // actor may appear inside the banned-shape list.
    const banLine = prompt.split("\n").find((line) => line.includes("BANNED SUBSTANCE SHAPES")) ?? "";
    expect(banLine).not.toContain("Barcelona");
    expect(banLine).not.toContain("Real Madrid");
  });

  it("names the purpose tails as the bytes that make two cards one sentence", () => {
    const prompt = buildSummaryPrompt(evidenceFor(ACTOR_ROW));
    expect(prompt).toContain("Never append 'to move the ball toward the opposing side'");
    expect(prompt).toContain("'during the sequence'");
  });
});

describe("ADAAAA-9121 — the job's spent actor-and-act pairs rotate the substance", () => {
  it("extracts the pairs a served body spends, multiword verbs included", () => {
    const body =
      "Real Madrid wins the ball back at 0:12 into the clip. Barcelona completes a pass to maintain their offensive movement.";
    expect(summarySpentActPairs([body], ["Real Madrid", "Barcelona", "Portugal"])).toEqual([
      "Real Madrid + wins the ball back",
      "Barcelona + completes a pass",
    ]);
  });

  it("dedupes a pair used twice and ignores a sentence with no act verb", () => {
    const body =
      "Real Madrid tackles at 0:12 into the clip. Real Madrid tackles again at 0:20. The scoreboard moves from 1-1 to 2-1 at 0:30.";
    expect(summarySpentActPairs([body], ["Real Madrid"])).toEqual(["Real Madrid + tackles"]);
  });

  it("returns nothing when the evidence names no actor to anchor a pair", () => {
    expect(summarySpentActPairs(["Barcelona tackles at 0:12 into the clip."], [])).toEqual([]);
  });

  it("renders the spent pairs and the rotation rule on the FIRST pass", () => {
    const evidence = evidenceFor(bundle.rows[2]);
    const prompt = buildSummaryPrompt({ ...evidence, avoidActs: ["Real Madrid + drives forward", "Barcelona + completes a pass"] });
    expect(prompt).toContain("This job's served cards already spend these actor-and-act pairs: Real Madrid + drives forward; Barcelona + completes a pass.");
    expect(prompt).toContain("must NOT use any of them");
    expect(prompt).toContain("Vary each sentence's OPENING as well");
    // No retry directive was passed, so this is the first-pass contract.
    expect(prompt).not.toContain("RETRY:");
  });

  it("renders no spent-pair line when the job has served nothing yet", () => {
    const prompt = buildSummaryPrompt(evidenceFor(bundle.rows[0]));
    expect(prompt).not.toContain("already spend these actor-and-act pairs");
    // The rotation recipe itself still ships on the first card of a job.
    expect(prompt).toContain("Vary each sentence's OPENING as well");
  });
});

describe("ADAAAA-9121 — $0 replay of job 1e0d7187: the stored drafts fail, the rotation serves", () => {
  const band = summaryBand("live");
  const compliant = JSON.parse(
    readFileSync(new URL("../../../evals/adaaa_9121/compliant-drafts.json", import.meta.url), "utf8")
  ) as Record<string, string>;

  /** Replays the lane's ORDER: each body is gated with the job's served sentences
   *  as `avoidSentences`, then checked against the AC14.3 sentence bar. Mirrors
   *  `SummaryLane` without a model call, so the numbers are `$0`. */
  const replay = (drafts: Record<string, string>) => {
    const served: string[] = [];
    const servedBodies: { hid: string; sentences: string[] }[] = [];
    const out: { hid: string; served: boolean; words: number; violations: string[]; worst: number }[] = [];
    for (const row of bundle.rows) {
      const draft = drafts[hid(row)];
      if (!draft) continue;
      const decision = gateSummaryDetail(draft, evidenceFor(row), served.length > 0 ? { avoidSentences: served } : undefined);
      let worst = 0;
      for (const sentence of decision.summary ? summarySentencesOf(decision.summary) : []) {
        for (const other of served) worst = Math.max(worst, sentenceSimilarity(sentence, other));
      }
      const serves = Boolean(decision.summary) && worst < SUMMARY_SENTENCE_REPEAT_THRESHOLD;
      out.push({ hid: hid(row), served: serves, words: decision.words, violations: decision.violations, worst });
      if (serves && decision.summary) {
        const sentences = summarySentencesOf(decision.summary);
        served.push(...sentences);
        servedBodies.push({ hid: hid(row), sentences });
      }
    }
    return { rows: out, servedBodies };
  };

  it("reproduces the served block's defect: the stored drafts reuse ONE substance sentence at 1.000", () => {
    const drafts: Record<string, string> = {};
    for (const row of bundle.rows) drafts[hid(row)] = String(row.summaryRaw ?? row.summary ?? "").trim();

    // (a) the reuse that this ticket exists to stop is a property of the stored
    // bytes, not of any bar: the substance sentence is shared across cards.
    const sentences: string[] = [];
    for (const draft of Object.values(drafts)) sentences.push(...summarySentencesOf(draft));
    let shared = 0;
    for (let i = 0; i < sentences.length; i += 1) {
      for (let j = i + 1; j < sentences.length; j += 1) {
        if (sentenceSimilarity(sentences[i], sentences[j]) >= 1) shared += 1;
      }
    }
    expect(shared).toBeGreaterThanOrEqual(5);

    // (b) what the served block actually did: 2 of 7 rows served (QA's census).
    const servedOnBlock = bundle.rows.filter((row) => row.summaryGate && !String(row.summaryGate).startsWith("dropped"));
    expect(servedOnBlock.map(hid)).toEqual(["5f1ca385", "73cca424"]);
    const repeatRetry = bundle.rows.filter((row) => String(row.summaryRetryReason ?? "").startsWith("repeat-"));
    expect(repeatRetry).toHaveLength(5);
    for (const row of repeatRetry) expect(row.summary).toBeUndefined();

    // (c) replaying those same drafts through the CURRENT gate (which now carries
    // ADAAAA-8941's ball-progress bar as well as the AC14 prune) leaves the repeat
    // class dry: at most one of the five serves, and none of them serves its own
    // substance sentence.
    const result = replay(drafts);
    expect(result.rows.filter((row) => row.served).length).toBeLessThanOrEqual(1);
  });

  it("serves 7/7 when the writer rotates the pair and varies the opening, every body at or above the floor", () => {
    const result = replay(compliant);
    expect(result.rows.filter((row) => row.served)).toHaveLength(7);
    for (const row of result.rows) expect(row.words).toBeGreaterThanOrEqual(band.floorWords);
  });

  it("keeps every served sentence pair under the AC14.3 bar", () => {
    const result = replay(compliant);
    let worst = 0;
    for (let i = 0; i < result.servedBodies.length; i += 1) {
      for (let j = i + 1; j < result.servedBodies.length; j += 1) {
        for (const sentence of result.servedBodies[i].sentences) {
          for (const theirs of result.servedBodies[j].sentences) {
            worst = Math.max(worst, sentenceSimilarity(sentence, theirs));
          }
        }
      }
    }
    expect(worst).toBeLessThan(SUMMARY_SENTENCE_REPEAT_THRESHOLD);
  });

  it("uses a distinct actor-and-act pair per sentence, so the rotation state never runs dry", () => {
    const spent = new Set<string>();
    for (const row of bundle.rows) {
      const pairs = summarySpentActPairs([compliant[hid(row)]], ["Real Madrid", "Barcelona", "Portugal"]);
      expect(pairs).toHaveLength(2);
      for (const pair of pairs) expect(spent.has(pair)).toBe(false);
      for (const pair of pairs) spent.add(pair);
    }
    expect(spent.size).toBe(14);
  });
});
