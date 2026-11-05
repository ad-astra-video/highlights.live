// ADAAAA-7237: append-only per-pass summary time log (the "Video Summary"
// section data). Covers:
//   (a) `summaryDelta` — incremental per-pass content derived from the rolling
//       running-summary delta (no duplicate of already-captured lines);
//   (b) `appendSummaryEntry` — append-only (never overwrite/drop/reorder),
//       monotonic sequence + timestamp, persists the bounded running summary too.
//
// (ADAAAA-7501: the end-of-video compiled "Overall Summary" was removed, so the
//   `fallbackOverallSummary` / `requestOverallSummary` / `applyOverallSummary`
//   tests below are gone with the generation path they covered.)
import { describe, it, expect } from "vitest";
import { Store } from "../src/store";
import {
  summaryDelta,
  nextSummarySeq,
  appendSummaryEntry,
  normalizeWindowTs,
  summaryLineKey,
  unduplicatedSummaryLines,
} from "../src/summary-log";

describe("summaryDelta (ADAAAA-7237)", () => {
  it("returns the incremented lines added this pass (not already in the prior)", () => {
    expect(summaryDelta("first event", "first event\nsecond event")).toBe("second event");
  });

  it("returns the whole summary on the first pass (no prior)", () => {
    expect(summaryDelta(undefined, "a goal at 120s")).toBe("a goal at 120s");
    expect(summaryDelta("", "a goal at 120s")).toBe("a goal at 120s");
  });

  it("does not re-log lines already present (no duplicate entries)", () => {
    expect(summaryDelta("a\nb", "a\nb\nc")).toBe("c");
  });

  it("returns '' when nothing new was added in this pass", () => {
    expect(summaryDelta("same", "same")).toBe("");
  });
});

describe("nextSummarySeq / appendSummaryEntry (ADAAAA-7237)", () => {
  it("nextSummarySeq is 1 on an empty log and strictly increasing afterward", () => {
    expect(nextSummarySeq(undefined)).toBe(1);
    expect(nextSummarySeq([])).toBe(1);
    expect(nextSummarySeq([{ seq: 1, ts: "t", text: "a" }, { seq: 2, ts: "t", text: "b" }])).toBe(3);
  });

  it("appends entries monotonically and NEVER overwrites or reorders a prior entry", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "first window", { windowTs: 10 });
    await appendSummaryEntry(s, job.id, "first window\nsecond window", { windowTs: 20 });
    await appendSummaryEntry(s, job.id, "first window\nsecond window\nthird window", { windowTs: 30 });
    const j = s.getJob(job.id)!;
    expect(j.summaryLog).toHaveLength(3);
    expect(j.summaryLog!.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(j.summaryLog!.map((e) => e.windowTs)).toEqual([10, 20, 30]);
    // Text captures the incremental per-pass content, not a re-log of priors.
    expect(j.summaryLog![0].text).toBe("first window");
    expect(j.summaryLog![1].text).toBe("second window");
    expect(j.summaryLog![2].text).toBe("third window");
    // The bounded rolling summary is still persisted alongside the log.
    expect(j.runningSummary).toBe("first window\nsecond window\nthird window");
    // Every entry carries a monotonic sequence + timestamp.
    for (const e of j.summaryLog!) {
      expect(typeof e.ts).toBe("string");
      expect(e.seq).toBeGreaterThan(0);
    }
  });

  it("persists the log through the DB-backed store (durable, reconstructible)", async () => {
    // Use the in-memory Store which mirrors the job record; the DB path writes
    // the same Job record via saveJob. We assert the record round-trips.
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    await appendSummaryEntry(s, job.id, "a");
    await appendSummaryEntry(s, job.id, "a\nb");
    const j = s.getJob(job.id)!;
    expect(j.summaryLog!.map((e) => e.text)).toEqual(["a", "b"]);
    expect(s.listJobsForOwner(undefined).find((x) => x.id === job.id)?.summaryLog).toHaveLength(2);
  });
});

// ADAAAA-7711 (supersedes the ADAAAA-7710 rounding): the observe cadence
// reports a FLOAT window centre whenever a window boundary is not a whole
// second. That entry used to be rejected by the persisted integer contract,
// which threw away the whole patch (entry AND the bounded runningSummary) for
// that pass. The fix relaxes the contract to a finite float and keeps the
// honest timestamp; only non-finite input is dropped. Cover below uses a 14 s
// clip — a duration that is NOT a multiple of the window size — because the
// whole-second fixtures above never exercise the fractional case.
describe("normalizeWindowTs (ADAAAA-7711)", () => {
  it("keeps a fractional window centre verbatim (no silent rounding)", () => {
    expect(normalizeWindowTs(11.666666666666666)).toBe(11.666666666666666);
    expect(normalizeWindowTs(4.666666666666667)).toBe(4.666666666666667);
    expect(normalizeWindowTs(0.4)).toBe(0.4);
  });

  it("passes an already-integral timestamp through unchanged", () => {
    expect(normalizeWindowTs(0)).toBe(0);
    expect(normalizeWindowTs(12)).toBe(12);
    expect(normalizeWindowTs(120)).toBe(120);
  });

  it("drops non-finite / non-numeric timestamps instead of failing the entry", () => {
    expect(normalizeWindowTs(undefined)).toBeUndefined();
    expect(normalizeWindowTs(null)).toBeUndefined();
    expect(normalizeWindowTs(Number.NaN)).toBeUndefined();
    expect(normalizeWindowTs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(normalizeWindowTs(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(normalizeWindowTs("11.6" as unknown as number)).toBeUndefined();
  });
});

describe("appendSummaryEntry fractional windowTs (ADAAAA-7711)", () => {
  it("persists an entry whose windowTs is a fractional float (no dropped patch)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/reallive_goal.mp4", gameHint: "soccer" });
    // Pre-fix this rejected the whole patch: JobSchema -> summaryLog[0].windowTs
    // expected integer, received float. The value is lifted verbatim from the
    // live container log for job acb3c5b8 (`decide @11.666666666666666s`).
    await expect(
      appendSummaryEntry(s, job.id, "Kickoff, ball played into midfield.", {
        windowTs: 11.666666666666666,
      })
    ).resolves.toBeDefined();
    const j = s.getJob(job.id)!;
    expect(j.summaryLog).toHaveLength(1);
    expect(j.summaryLog![0].windowTs).toBe(11.666666666666666);
    expect(j.runningSummary).toBe("Kickoff, ball played into midfield.");
  });

  it("persists every entry for a 14 s clip whose last window centre is fractional", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/clip-14s.mp4", gameHint: "soccer" });
    // Window centres the observe cadence produces for a 14 s clip at the VOD
    // cadence — the 5th tap is the one that used to drop the whole persist.
    const centers = [0, 4.666666666666667, 7, 9.333333333333334, 11.666666666666666];
    const summaries = [
      "Kickoff.",
      "Kickoff.\nBall into midfield.",
      "Kickoff.\nBall into midfield.\nShot wide.",
      "Kickoff.\nBall into midfield.\nShot wide.\nCorner won.",
      "Kickoff.\nBall into midfield.\nShot wide.\nCorner won.\nHeader cleared.",
    ];
    for (let i = 0; i < centers.length; i += 1) {
      // Every append must round-trip; a rejected patch would throw here.
      await appendSummaryEntry(s, job.id, summaries[i], { windowTs: centers[i] });
    }
    const j = s.getJob(job.id)!;
    // No pass is dropped: the fractional-boundary pass persisted its entry.
    expect(j.summaryLog).toHaveLength(centers.length);
    expect(j.summaryLog!.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    // The honest fractional window is preserved end to end.
    expect(j.summaryLog!.map((e) => e.windowTs)).toEqual(centers);
    // The fractional pass also persisted the bounded running summary (the old
    // behaviour lost this too, because the whole patchJob write was rejected).
    expect(j.runningSummary).toBe(summaries[summaries.length - 1]);
    expect(j.summaryLog![4].text).toBe("Header cleared.");
  });

  it("keeps the entry when the window timestamp is unusable (never loses the summary)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/clip.mp4" });
    await appendSummaryEntry(s, job.id, "a goal at 120s", { windowTs: Number.NaN });
    await appendSummaryEntry(s, job.id, "a goal at 120s\nsecond window", {});
    const j = s.getJob(job.id)!;
    expect(j.summaryLog).toHaveLength(2);
    // Unusable metadata degrades to "no windowTs"; the content still lands.
    expect(j.summaryLog![0].windowTs).toBeUndefined();
    expect(j.summaryLog![0].text).toBe("a goal at 120s");
    expect(j.summaryLog![1].text).toBe("second window");
    expect(j.runningSummary).toBe("a goal at 120s\nsecond window");
  });
});


// ADAAAA-7948 (Inc 3): the caption grounding gate at the summary-log seam.
// Every FAST caption crosses it before it becomes a Video Summary item; the VOD
// path supplies no grounding context and must stay byte-identical (AC8).
describe("appendSummaryEntry caption grounding (ADAAAA-7948)", () => {
  const PROMPT =
    "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR | No. 3 | ASR: (empty)";

  it("rewrites a goal claim whose window verdict is near_miss", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Marta scores a goal from the box.", {
      windowTs: 69,
      grounding: { verdict: "near_miss", promptText: PROMPT },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text).not.toMatch(/\bscores?\b|\bgoal\b/i);
    expect(entry.text.length).toBeLessThanOrEqual("Marta scores a goal from the box.".length);
  });

  it("replaces a name the window's prompt_text cannot corroborate", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Real Madrid press high in midfield through Manuel Ordoñez.", {
      windowTs: 70,
      grounding: { verdict: "big_play", promptText: PROMPT },
    });
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text).not.toContain("Real Madrid");
    expect(text).not.toContain("Ordoñez");
  });

  it("strips internal tokens from the entry (incl. the seeded-caption shape)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    await appendSummaryEntry(s, job.id, "[near_miss] No. 9 dribbles in the box", {
      windowTs: 71,
      grounding: { verdict: "near_miss", promptText: PROMPT },
    });
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text).toBe("No. 9 dribbles in the box.");
  });

  it("passes a REAL goal verdict's lead through byte-identical", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    const line = "No. 9 scores at the near post — the net ripples.";
    await appendSummaryEntry(s, job.id, line, {
      windowTs: 72,
      grounding: { verdict: "scoring_play", promptText: PROMPT, eventType: "GOAL" },
    });
    // ADAAAA-7965 (contract v5 §3.1, R18): the LEAD passes byte-identical; the
    // model's appended clause does not, because a forwarded clause is what QA v4
    // measured as contradicted by its own frames.
    // ADAAAA-8043 (contract v7 §3.5): the write seam closes the sentence, so the
    // stored row carries its terminal period and the page never adds one.
    expect(s.getJob(job.id)!.summaryLog![0].text).toBe("No. 9 scores at the near post.");
  });

  it("leaves the VOD path BYTE-IDENTICAL (no grounding context supplied)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/vod.mp4" });
    const line = "Real Madrid scores a goal in the 88th minute.";
    await appendSummaryEntry(s, job.id, line, { windowTs: 88 });
    expect(s.getJob(job.id)!.summaryLog![0].text).toBe(line);
  });

  it("grounds only the persisted log text — the rolling runningSummary stays model input", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4" });
    const line = "[near_miss] Marta scores a goal in the box.";
    await appendSummaryEntry(s, job.id, line, {
      windowTs: 73,
      grounding: { verdict: "near_miss", promptText: PROMPT },
    });
    const j = s.getJob(job.id)!;
    expect(j.summaryLog![0].text).not.toBe(line);
    expect(j.runningSummary).toBe(line);
  });
});

// ADAAAA-7956 (contract v3 rule 2): the append-only story log must not accumulate
// duplicate rows. On the measured v2.5 level (job a988e52b) 22 distinct lines
// filled 67 rows — "Player in blue moves ball in center circle." landed 5 times
// in a row — because the model re-narrates a passage it already covered. The
// guard is at this seam: a line the job has already emitted is not appended
// again, while the bounded running summary keeps advancing (it is model input).
describe("appendSummaryEntry duplicate lines (ADAAAA-7956 rule 2)", () => {
  const GROUNDING = { verdict: "not_highlight", promptText: "Match context: RMA 1-1 BAR" };

  // ADAAAA-7962 (contract v4 §3.7) raises the write-seam cap from "never twice"
  // to "at most twice per job", the SAME rule the page applies — so the stored
  // set is the page set instead of the page silently hiding a stored row.
  // ADAAAA-7995: the write seam stores ONE row per beat. The v4 cap of 2 shipped
  // repeated stored sentences (6,7,6,5,2 byte-equal pairs on five fresh jobs).
  it("keeps a line ONCE and drops every later occurrence", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    for (const windowTs of [0, 3, 6]) {
      await appendSummaryEntry(s, job.id, "Player in blue moves ball in center circle.", {
        windowTs,
        grounding: GROUNDING,
      });
    }
    const log = s.getJob(job.id)!.summaryLog!;
    expect(log).toHaveLength(1);
    expect(log.map((e) => e.seq)).toEqual([1]);
  });

  it("treats a trailing full stop / case / spacing difference as the same line", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Player in blue moves ball in center circle.", {
      windowTs: 0,
      grounding: GROUNDING,
    });
    await appendSummaryEntry(s, job.id, "  player in blue moves ball in center circle  ", {
      windowTs: 3,
      grounding: GROUNDING,
    });
    // ADAAAA-7995: one row per beat, so the cosmetic repeat is dropped and the
    // third identical line is dropped too.
    await appendSummaryEntry(s, job.id, "Player in blue moves ball in center circle.", {
      windowTs: 6,
      grounding: GROUNDING,
    });
    expect(s.getJob(job.id)!.summaryLog).toHaveLength(1);
  });

  it("still advances the bounded running summary on a skipped duplicate", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Player in blue moves ball in center circle.", {
      windowTs: 0,
      grounding: GROUNDING,
    });
    await appendSummaryEntry(s, job.id, "Player in blue moves ball in center circle.", {
      windowTs: 3,
      grounding: GROUNDING,
    });
    // The model's story-so-far is model input, never customer copy: it moves on.
    expect(s.getJob(job.id)!.runningSummary).toBe("Player in blue moves ball in center circle.");
  });

  it("appends one row per new line of a multi-line pass and skips only the repeats", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Kickoff taken at center circle.\nPlayer in blue dribbles in the box.", {
      windowTs: 0,
      grounding: GROUNDING,
    });
    await appendSummaryEntry(
      s,
      job.id,
      "Kickoff taken at center circle.\nPlayer in blue dribbles in the box.\nKeeper clears at the near post.",
      { windowTs: 3, grounding: GROUNDING }
    );
    const log = s.getJob(job.id)!.summaryLog!;
    // ADAAAA-7961: a Video Summary row renders ONE line. The pass's new lines are
    // separate rows (v1-v5 joined them into one entry, so the page showed two
    // sentences inside a single 15 s row), and only the repeat is skipped.
    expect(log.map((e) => e.text)).toEqual([
      "Kickoff taken at center circle.",
      "Player in blue dribbles in the box.",
      "Keeper clears at the near post.",
    ]);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keeps appending distinct lines (seq stays monotonic)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    for (const [i, line] of [
      "Player in blue dribbles in center circle.",
      "Player in white stands in center circle.",
      "No. 3 drives into the box.",
    ].entries()) {
      await appendSummaryEntry(s, job.id, line, { windowTs: i * 3, grounding: GROUNDING });
    }
    const log = s.getJob(job.id)!.summaryLog!;
    expect(log).toHaveLength(3);
    expect(log.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("leaves the VOD path byte-identical: no grounding => no de-dup (AC8)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/vod.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "A long VOD line about the same passage.", { windowTs: 10 });
    await appendSummaryEntry(s, job.id, "A long VOD line about the same passage.", { windowTs: 20 });
    expect(s.getJob(job.id)!.summaryLog).toHaveLength(2);
  });
});

describe("summary de-dup helpers (ADAAAA-7956)", () => {
  it("summaryLineKey folds only cosmetic differences", () => {
    expect(summaryLineKey("Player in blue moves ball.")).toBe(
      summaryLineKey("  player in blue moves ball  ")
    );
    expect(summaryLineKey("Player in blue moves ball.")).not.toBe(
      summaryLineKey("Player in white moves ball.")
    );
  });

  it("unduplicatedSummaryLines drops only the lines the log already carries", () => {
    const log = [
      { seq: 1, ts: "t", text: "Player in blue dribbles." },
      { seq: 2, ts: "t", text: "Keeper clears at the near post." },
    ];
    expect(unduplicatedSummaryLines("Player in blue dribbles.\nShot wide at the far post.", log)).toBe(
      "Shot wide at the far post."
    );
    expect(unduplicatedSummaryLines("Player in blue dribbles.", log)).toBe("");
    expect(unduplicatedSummaryLines("Brand new line.", undefined)).toBe("Brand new line.");
  });
});

// ADAAAA-7962 (contract v4 §3.1/§3.5/§3.7): the WRITE seam is the only gate.
// Graded on the delivered set (level dcaa93c5, ADAAAA-7959): the stored
// `summaryLog` carried 27 rows / 10 goal claims / 9 colour clauses while the page
// showed 26 rows / 0 claims / 0 colour. These tests pin the seam that closes it.
describe("write-seam parity (ADAAAA-7962, contract v4)", () => {
  const PROMPT = "Match context: RMA 1-1 BAR";

  it("stores NO goal claim on an uncorroborated goal window (R13, AC4b)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "No. 10 strikes the ball into the net — goal", {
      windowTs: 117,
      grounding: { verdict: "scoring_play", promptText: PROMPT, corroborated: false, place: "from the box" },
    });
    const text = s.getJob(job.id)!.summaryLog![0].text;
    expect(text.toLowerCase()).not.toContain("net");
    expect(text.toLowerCase()).not.toContain("goal");
  });

  it("keeps the claim on a CORROBORATED goal (no v3 regression)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    const line = "No. 10 strikes the ball into the net — goal";
    await appendSummaryEntry(s, job.id, line, {
      windowTs: 117,
      grounding: { verdict: "scoring_play", promptText: PROMPT, corroborated: true, place: "from the box" },
    });
    // R18: the claim survives byte-identical; an appended tag is not a beat.
    // ADAAAA-8043 (v7 §3.5): the write seam closes the sentence, so the stored
    // row is a whole sentence and the page adds no punctuation.
    expect(s.getJob(job.id)!.summaryLog![0].text).toBe("No. 10 strikes the ball into the net from the box.");
  });

  it("records the model's ungated line in exactly one audit-only field", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    const raw = "Saez strikes the ball into the net — crowd erupts. GOAL 22:15";
    await appendSummaryEntry(s, job.id, raw, {
      windowTs: 177,
      grounding: { verdict: "not_highlight", promptText: "saez", place: "in the box" },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text_raw).toBe(raw);
    expect(entry.text).not.toBe(raw);
    expect(entry.text.toLowerCase()).not.toContain("net");
    expect(entry.verdict).toBe("not_highlight");
  });

  it("does not write a text_raw field when the gate changed nothing", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "Player in blue dribbles in midfield.", {
      windowTs: 9,
      grounding: { verdict: "not_highlight", promptText: PROMPT },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text_raw).toBeUndefined();
    expect(entry.text).toBe("Player in blue dribbles in midfield.");
  });

  it("allows a quiet-row beat up to 40% of the delivered quiet set (ADAAAA-8043 v7 §3.1)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    // ADAAAA-7965 (contract v5 §3.1, R18): the beat is DERIVED from the measured
    // audio-noise signal, so the fixture is a signal, not a model clause.
    const grounding = {
      verdict: "not_highlight" as const,
      promptText: PROMPT,
      place: "in center circle",
      colourSignal: { signal: "audio_noise" as const, ratio: 5, sustained: 0.2, peak: 0.4, peakT: 12, frameTs: 12, frameSeq: 36 },
    };
    // Eight quiet rows with a measurable beat: the budget allows the first
    // ceil(0.4 * n) of them, so a quiet-heavy job loses the clause on later rows
    // instead of breaking the 40% rule silently.
    const lines = Array.from({ length: 8 }, (_v, i) => `Player ${i} moves ball in center circle.`);
    for (const [i, line] of lines.entries()) {
      await appendSummaryEntry(s, job.id, line, { windowTs: i * 3, grounding });
    }
    const log = s.getJob(job.id)!.summaryLog!;
    const withColour = log.filter((e) => (e.text ?? "").includes("noise lifts, then settles"));
    expect(log).toHaveLength(8);
    // ADAAAA-8043 (contract v7 §3.1) supersedes the v6 blanket ban: a quiet row
    // MAY carry the derived beat, on at most 40% of the delivered quiet set
    // (floor(0.4 * 8) = 3). The v6 rule measured 0 beats against 13 eligible
    // windows, so coverage was 0% by construction.
    expect(withColour).toHaveLength(3);
    expect(withColour.length / log.length).toBeLessThanOrEqual(0.4);
    for (const e of withColour) {
      // The lead is still inside the 8-word budget: AC5 measures before the dash.
      expect((e.text.split(/\s+[—–]\s+/)[0] ?? "").split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(8);
    }
    for (const e of log) {
      if (!withColour.includes(e)) expect(e.colour).toBeUndefined();
    }
    for (const e of withColour) expect(e.colour?.signal).toBe("audio_noise");
    // The measured-beat STORAGE path is unchanged on a LOUD row.
    await appendSummaryEntry(s, job.id, "No. 4 strikes the ball wide", {
      windowTs: 24,
      grounding: { ...grounding, verdict: "near_miss" },
    });
    const loud = s.getJob(job.id)!.summaryLog!.at(-1)!;
    expect(loud.text).toContain("noise lifts, then settles");
    expect(loud.colour?.signal).toBe("audio_noise");
    expect(typeof loud.colour?.frameTs).toBe("number");
  });

  it("drops a colour beat with no measured signal on the row's window", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "No. 6 shoots — crowd energy rises", {
      windowTs: 159,
      grounding: { verdict: "not_highlight", promptText: PROMPT, place: "in midfield" },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text).not.toContain("crowd energy rises");
    expect(entry.colour).toBeUndefined();
  });
});

// ADAAAA-8053 (contract v8 §3b.3): the colour derivation must be OBSERVABLE per
// row. QA v7 measured 0/4 eligible rows with a beat on `93fae4a` while the
// Developer's level measured 6/6 — with no recorded reason, nobody could tell a
// non-firing derivation from a gate refusal. Every stored caption row now carries
// the decision, readable from the DB/API without reopening code.
describe("per-row colour trace (ADAAAA-8053 v8 §3b.3)", () => {
  const PROMPT = "Match context: RMA 1-1 BAR | scorebug OCR: RMA 1-1 BAR";
  const SIGNAL = {
    signal: "audio_noise" as const,
    ratio: 5,
    sustained: 0.2,
    peak: 0.4,
    peakT: 12,
    frameTs: 12,
    frameSeq: 36,
  };

  it("records `beat` with the signal that produced it when the derivation fires", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    // A LOUD row: the 40% quiet share does not apply, so the derived beat ships.
    await appendSummaryEntry(s, job.id, "A player dribbles in the center circle.", {
      windowTs: 12,
      grounding: { verdict: "big_play", promptText: PROMPT, place: "in the center circle", colourSignal: SIGNAL },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.text).toContain("noise lifts, then settles");
    expect(entry.colourTrace).toMatchObject({
      windowTs: 12,
      verdict: "big_play",
      signalPresent: true,
      clause: "beat",
      beat: "noise lifts, then settles",
    });
    expect(entry.colourTrace?.signal?.ratio).toBe(5);
  });

  it("records `derivation-not-reached` plus the seam's own reason when there is no signal", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "A player dribbles in the center circle.", {
      windowTs: 15,
      grounding: {
        verdict: "not_highlight",
        promptText: PROMPT,
        place: "in the center circle",
        colourSignal: null,
        colourSignalReason: "insufficient-taps",
      },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.colour).toBeUndefined();
    expect(entry.colourTrace).toMatchObject({
      signalPresent: false,
      clause: "derivation-not-reached",
      signalReason: "insufficient-taps",
    });
    expect(entry.colourTrace?.beat).toBeUndefined();
  });

  it("records `wording-filter` with the sub-reason when a real signal cannot become a beat", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "A player dribbles in the center circle.", {
      windowTs: 18,
      grounding: {
        verdict: "not_highlight",
        promptText: PROMPT,
        place: "in the center circle",
        colourSignal: { ...SIGNAL, ratio: 1.2 },
      },
    });
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.colourTrace).toMatchObject({
      signalPresent: true,
      clause: "wording-filter",
      reason: "ratio-floor",
    });
  });

  it("records `quiet-cap` on a row whose beat the 40% share removed", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    const grounding = {
      verdict: "not_highlight" as const,
      promptText: PROMPT,
      place: "in center circle",
      colourSignal: SIGNAL,
    };
    const lines = Array.from({ length: 6 }, (_v, i) => `Player ${i} moves ball in center circle.`);
    for (const [i, line] of lines.entries()) {
      await appendSummaryEntry(s, job.id, line, { windowTs: i * 3, grounding });
    }
    const log = s.getJob(job.id)!.summaryLog!;
    const capped = log.filter((e) => !(e.text ?? "").includes("noise lifts, then settles"));
    expect(capped.length).toBeGreaterThan(0);
    for (const e of capped) {
      // The row still carries the derivation's verdict: a beat WAS derived, the
      // share refused it. That is a different fact from "no signal at all".
      expect(e.colourTrace?.clause).toBe("quiet-cap");
      expect(e.colourTrace?.signalPresent).toBe(true);
      expect(e.colourTrace?.beat).toBeUndefined();
    }
    // Every row carries a trace, so eligibility and delivery are both readable.
    for (const e of log) expect(e.colourTrace).toBeDefined();
  });

  it("writes no trace on the VOD path (no grounding => byte-identical, AC8)", async () => {
    const s = new Store();
    const job = await s.createJob({ source: "file", sourceUrl: "/v.mp4", gameHint: "soccer" });
    await appendSummaryEntry(s, job.id, "A player dribbles in the center circle.");
    const entry = s.getJob(job.id)!.summaryLog![0];
    expect(entry.colourTrace).toBeUndefined();
    expect(entry.text).toBe("A player dribbles in the center circle.");
  });
});
