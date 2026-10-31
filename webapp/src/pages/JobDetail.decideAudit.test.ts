// ADAAAA-7625: the Decide LLM audit rows on the job page.
//
// User feedback on the job page: the audit rows "need a time stamp" and carried
// less detail than the per-window Inspect panels. Every field these assertions
// cover is already in `GET /jobs/:id/decide-audit`, so this is render-only. The
// contract asserted here:
//
// - every row leads with the in-video time decoded from its group key
//   (`g297` / `g297:confirm` -> `T+4:57`) plus the UTC wall clock from
//   `createdAt`, and an undecodable key renders `time not recorded` while still
//   showing the wall clock;
// - a non-null `verdicts` blob renders its chips (goal verdict, corroboration +
//   source, stage-1 disagreement);
// - a null `frameCount` / `candidateCount` renders `not recorded`, never a
//   fabricated `0` (the old `?? 0` read a confirm row as "0 frames");
// - `timings.elapsedMs` renders when recorded, and the prompt / raw reply /
//   media hashes / replayable flag stay behind a collapsed raw disclosure.
import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { DecideAuditRow } from "./JobDetail";
import {
  decideAuditElapsedLabel,
  decideAuditInVideoLabel,
  decideAuditVerdictChips,
  decideAuditWallClock,
  DECIDE_GROUP_WINDOW_S,
  type DecideAuditRecord,
} from "../lib/decideAudit";

const renderRow = (audit: Partial<DecideAuditRecord>) =>
  renderToString(
    React.createElement(DecideAuditRow, {
      audit: { id: "row-1", ...audit } as DecideAuditRecord,
    })
  );

/** A Stage-2 confirm row exactly as the server records it today: verdicts
 * present, every count / timing / prompt field null. */
function confirmRow(over: Partial<DecideAuditRecord> = {}): DecideAuditRecord {
  return {
    id: "job::g99:confirm",
    jobId: "job",
    sessionId: "job",
    groupKey: "g99:confirm",
    frameCount: null,
    candidateCount: null,
    systemPromptVersion: null,
    promptText: null,
    mediaHashes: [],
    rawReply: "no goal: ball never crossed the line",
    verdicts: {
      runConfirmationPass: true,
      goalConfirmed: "not_goal",
      corroborated: false,
      corroborationSource: null,
      stage1Disagreed: true,
    },
    timings: null,
    fallback: false,
    replayable: false,
    createdAt: "2026-10-31T16:43:07.312Z",
    ...over,
  };
}

describe("decide-audit time decoding (ADAAAA-7625)", () => {
  it("decodes the Stage-1 and Stage-2 group-key shapes to T+m:ss", () => {
    // decideGroupKey is `g${floor(ts/3)}`, so the key's number is the group
    // index, not the stream second: g99 -> 297 s -> T+4:57.
    expect(DECIDE_GROUP_WINDOW_S).toBe(3);
    expect(decideAuditInVideoLabel("g0")).toBe("T+0:00");
    expect(decideAuditInVideoLabel("g99")).toBe("T+4:57");
    expect(decideAuditInVideoLabel("g99:confirm")).toBe("T+4:57");
    expect(decideAuditInVideoLabel("g297:confirm")).toBe("T+14:51");
    expect(decideAuditInVideoLabel("g3600:confirm")).toBe("T+180:00");
  });

  it("renders `time not recorded` for a key it cannot decode", () => {
    for (const key of [null, undefined, "", "g", "job::g297", "g297:bogus suffix", "confirm"]) {
      expect(decideAuditInVideoLabel(key)).toBe("time not recorded");
    }
  });

  it("formats the wall clock for both stored createdAt shapes (UTC, stable)", () => {
    // ISO string — the Stage-2 confirm descriptor's shape.
    expect(decideAuditWallClock("2026-10-31T16:43:07.312Z")).toBe("2026-10-31 16:43:07 UTC");
    // Epoch seconds as stringified by the decide-service descriptor + ingest
    // (`String(round(time.time(), 3))`).
    expect(decideAuditWallClock("1793464987.312")).toBe("2026-10-31 16:43:07 UTC");
    // Epoch milliseconds.
    expect(decideAuditWallClock(1793464987312)).toBe("2026-10-31 16:43:07 UTC");
    expect(decideAuditWallClock(null)).toBe("time not recorded");
    expect(decideAuditWallClock("not a date")).toBe("time not recorded");
    // ADAAAA-7630: a short numeric value is not a timestamp. It used to be read
    // as epoch milliseconds and render a 1970 wall clock.
    expect(decideAuditWallClock("1234")).toBe("time not recorded");
    expect(decideAuditWallClock(1234)).toBe("time not recorded");
    expect(decideAuditWallClock(1e7)).toBe("time not recorded");
    // The epoch-seconds floor itself is still a real, renderable time.
    expect(decideAuditWallClock(1e8)).toBe("1973-03-03 09:46:40 UTC");
  });

  it("shows elapsed ms only when recorded", () => {
    expect(decideAuditElapsedLabel({ elapsedMs: 1234.56 })).toBe("1235 ms");
    expect(decideAuditElapsedLabel({ elapsedMs: 0 })).toBe("0 ms");
    expect(decideAuditElapsedLabel(null)).toBeNull();
    expect(decideAuditElapsedLabel({})).toBeNull();
  });

  it("builds chips for the confirm verdict shape and the Stage-1 outcome shape", () => {
    expect(decideAuditVerdictChips(null)).toEqual([]);
    const confirm = decideAuditVerdictChips(confirmRow().verdicts);
    expect(confirm.map((c) => c.label)).toEqual([
      "goal: not a goal",
      "not corroborated",
      "stage-1 disagreed",
    ]);
    expect(confirm.map((c) => c.tone)).toEqual(["bad", "muted", "warn"]);
    // corroboration source rides on the corroborated chip
    expect(
      decideAuditVerdictChips({ goalConfirmed: "confirmed_goal", corroborated: true, corroborationSource: "scoreboard" }).map(
        (c) => c.label
      )
    ).toEqual(["goal: confirmed goal", "corroborated · scoreboard"]);
    // Stage-1 parsed reply: no confirm keys, still a verdict chip.
    expect(decideAuditVerdictChips({ outcome: "near_miss" }).map((c) => c.label)).toEqual(["verdict: near_miss"]);
    // Unknown future shape: still at least one chip.
    expect(decideAuditVerdictChips({ wavelength: 3 }).map((c) => c.label)).toEqual(["verdict recorded"]);
  });
});

describe("DecideAuditRow (ADAAAA-7625)", () => {
  // AC5(a): a confirm row with verdicts renders time + verdict chips + the
  // `not recorded` counts, never a fabricated 0.
  it("AC5a: confirm row renders in-video time, wall clock, verdict chips and `not recorded`", () => {
    const html = renderRow(confirmRow());
    expect(html).toContain("data-decide-audit-row");
    expect(html).toContain("T+4:57");
    expect(html).toContain("2026-10-31 16:43:07 UTC");
    expect(html).toContain("data-decide-audit-verdict=\"goal\"");
    expect(html).toContain("goal: not a goal");
    expect(html).toContain("data-decide-audit-verdict=\"corroborated\"");
    expect(html).toContain("data-decide-audit-verdict=\"stage1-disagreed\"");
    expect(html).toContain("stage-1 disagreed");
    expect(html).toContain("frames not recorded");
    expect(html).toContain("candidates not recorded");
    // The old render's fabricated counts are gone.
    expect(html).not.toContain("0 frames");
    expect(html).not.toContain("0 candidates");
    // The raw group key is not the primary line any more: the summary line
    // (time -> counts) never contains it, only the raw disclosure does.
    const summary = html.slice(html.indexOf("data-decide-audit-summary"), html.indexOf("data-decide-audit-raw"));
    expect(summary.length).toBeGreaterThan(0);
    expect(summary).not.toContain("g99:confirm");
    expect(html.indexOf("group key: ")).toBeGreaterThan(html.indexOf("data-decide-audit-raw"));
  });

  // AC5(b): a recorded count renders as the real number.
  it("AC5b: a row with frameCount=5 renders `5 frames`", () => {
    const html = renderRow({ groupKey: "g99", frameCount: 5, candidateCount: 1, createdAt: "2026-10-31T16:43:07Z" });
    expect(html).toContain("5 frames");
    expect(html).toContain("1 candidate<");
    expect(html).not.toContain("not recorded");
  });

  // AC5(c): undecodable group key still carries the wall clock.
  it("AC5c: a row with no group key renders `time not recorded` plus the wall time", () => {
    const html = renderRow({ groupKey: null, createdAt: "2026-10-31T16:43:07Z", verdicts: null });
    expect(html).toContain("time not recorded");
    expect(html).toContain("2026-10-31 16:43:07 UTC");
    expect(html).toContain("frames not recorded");
    expect(html).toContain("candidates not recorded");
  });

  // ADAAAA-7630: an implausible numeric `createdAt` is not a timestamp, so the
  // wall clock reads `time not recorded` instead of 1970-01-01.
  it("renders `time not recorded` for an implausible numeric createdAt", () => {
    const html = renderRow({ groupKey: "g99:confirm", createdAt: "1234" });
    expect(html).toContain("time not recorded");
    expect(html).not.toContain("1970");
  });

  // AC2 over a batch: no row derives a count from a null field.
  it("AC2: no row renders a count it did not record (confirm-only job census)", () => {
    const rows = [
      confirmRow({ id: "a", groupKey: "g10:confirm" }),
      confirmRow({ id: "b", groupKey: "g11:confirm", verdicts: { goalConfirmed: "near_miss", corroborated: true, corroborationSource: "asr", stage1Disagreed: false } }),
      confirmRow({ id: "c", groupKey: "g12:confirm", verdicts: null }),
      confirmRow({ id: "d", groupKey: null, createdAt: null }),
    ];
    const html = rows.map((r) => renderRow(r)).join("\n");
    expect(html).not.toContain("0 candidates");
    expect(html).not.toContain("0 frames");
    // Every one of those rows rendered both clocks and the count line.
    expect((html.match(/data-decide-audit-time/g) ?? []).length).toBe(rows.length);
    expect((html.match(/data-decide-audit-wall/g) ?? []).length).toBe(rows.length);
    expect((html.match(/data-decide-audit-counts/g) ?? []).length).toBe(rows.length);
    // Only the verdict-less row lacks chips.
    expect((html.match(/data-decide-audit-verdict=/g) ?? []).length).toBeGreaterThan(0);
  });

  it("keeps prompt / reply / media / replayable behind the collapsed raw disclosure", () => {
    const html = renderRow(
      confirmRow({
        groupKey: "g99:confirm",
        promptText: "PASS 2 CONFIRM: did the ball cross the line?",
        mediaHashes: [{ type: "image", sha256: "abcdef1234567890" }],
        replayable: true,
        timings: { elapsedMs: 812 },
      })
    );
    const rawAt = html.indexOf("data-decide-audit-raw");
    expect(rawAt).toBeGreaterThan(-1);
    expect(html).toContain("data-decide-audit-raw-toggle");
    // Everything long lives after the raw toggle (collapsed by default).
    for (const fragment of ["data-decide-audit-prompt", "data-decide-audit-reply", "data-decide-audit-media", "#abcdef12"]) {
      expect(html.indexOf(fragment)).toBeGreaterThan(rawAt);
    }
    expect(html).toContain("replayable");
    expect(html).toContain("812 ms");
  });

  it("renders elapsed only when recorded and keeps the row single-line otherwise", () => {
    expect(renderRow(confirmRow())).not.toContain("data-decide-audit-elapsed");
    expect(renderRow(confirmRow({ timings: { elapsedMs: 640 } }))).toContain("640 ms");
  });

  it("flags a rule fallback", () => {
    const html = renderRow(confirmRow({ fallback: true }));
    expect(html).toContain("data-decide-audit-fallback");
    expect(html).toContain("fell back to rule");
  });
});
