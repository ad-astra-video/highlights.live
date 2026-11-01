// ADAAAA-7623: the summary LADDER, rung 1 + 2 rendered above the flat
// per-window Video Summary log. The server derives it at read time from STORED
// rows only (`services/server/src/summary-ladder.ts`), so this component is
// pure presentation over `detail.summaryLadder` — no LLM call, no GPU second.
//
// The drill-down is: match summary -> chapter -> that chapter's window
// narratives -> the Analysis window for the same instant (the existing
// frame/decide-audit panels, reached via `ladderSectionIndex`).
//
// Legacy jobs (no ladder, or no stored summary log) render nothing here; the
// page is unchanged for them.
import { useState } from "react";
import { ChevronDown, ChevronRight, Target } from "lucide-react";
import {
  chapterKindLabel,
  ladderClock,
  ladderSectionIndex,
  type SummaryChapter,
  type SummaryLadder,
} from "../lib/jobDetail";

/** Colour-coded chapter kinds so a goal cluster is spot-able at a glance. */
const KIND_TONE: Record<SummaryChapter["kind"], string> = {
  "goal-cluster": "border-neon/50 bg-neon/10 text-neon",
  "build-up": "border-purple/40 text-purple",
  "lull": "border-mut/30 text-mut",
  phase: "border-mut/30 text-slate-ink",
};

/**
 * One chapter row. Collapsed it carries rung 2 (kind + time range + goal count
 * + one-line rollup); expanded it carries rung 3 (every window narrative the
 * chapter covers, in time order) with a jump into the Analysis window that
 * holds the frames + decide audit for that instant.
 */
function ChapterRow({
  chapter,
  onJump,
}: {
  chapter: SummaryChapter;
  onJump?: (sectionIndex: number, windowTs: number) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-lg border border-neon/20 bg-black/30" data-detail-ladder-chapter data-chapter-index={chapter.index} data-chapter-kind={chapter.kind}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-detail-ladder-chapter-toggle
      >
        <span className="shrink-0 text-mut">{open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${KIND_TONE[chapter.kind]}`} data-detail-ladder-kind>
          {chapterKindLabel(chapter.kind)}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-mut" data-detail-ladder-range>
          {ladderClock(chapter.startS)}–{ladderClock(chapter.endS)}
        </span>
        {chapter.goalCount > 0 && (
          <span className="shrink-0 rounded-full border border-neon/40 px-2 py-0.5 text-[10px] font-bold text-neon" data-detail-ladder-chapter-goals>
            {chapter.goalCount} goal{chapter.goalCount === 1 ? "" : "s"}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-slate-ink" data-detail-ladder-chapter-summary>
          {chapter.title || chapter.summary}
        </span>
        <span className="shrink-0 font-mono text-[10px] text-mut" data-detail-ladder-windows>
          {chapter.entries.length} window{chapter.entries.length === 1 ? "" : "s"}
        </span>
      </button>
      {open && (
        <div className="border-t border-neon/20 px-3 py-2" data-detail-ladder-chapter-body>
          {chapter.summary && (
            <p className="mb-2 text-xs text-slate-ink" data-detail-ladder-chapter-rollup>
              {chapter.summary}
            </p>
          )}
          {chapter.goals.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-1.5" data-detail-ladder-chapter-goaltimes>
              {chapter.goals.map((g) => (
                <span
                  key={g.index}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${g.verified ? "border-neon/40 text-neon" : "border-mut/40 text-mut"}`}
                  data-detail-ladder-goal={g.index}
                  data-goal-verified={g.verified ? "true" : "false"}
                >
                  <Target className="h-3 w-3" />#{g.index} {ladderClock(g.ts)}
                  {!g.verified && <span className="font-normal">(uncorroborated)</span>}
                </span>
              ))}
            </div>
          )}
          <ol className="flex flex-col gap-1.5" data-detail-ladder-entries>
            {chapter.entries.map((e) => (
              <li key={e.seq} className="flex items-start gap-2 text-xs" data-detail-ladder-entry data-seq={e.seq}>
                <span className="shrink-0 font-mono text-[11px] text-mut" data-detail-ladder-entry-ts>
                  T+{e.windowTs}s
                </span>
                <span className="min-w-0 flex-1 text-slate-ink">{e.text}</span>
                {onJump && (
                  <button
                    type="button"
                    onClick={() => onJump(ladderSectionIndex(e.windowTs), e.windowTs)}
                    className="shrink-0 rounded border border-purple/40 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-purple hover:border-neon hover:text-neon"
                    data-detail-ladder-jump
                  >
                    Frames
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </li>
  );
}

/**
 * Rung 1 (match summary) + rung 2 (chapter outline). The fact gate runs
 * server-side, so the rollup text here already carries no uncorroborated score
 * string and the goal timeline is index-based (goal #1..#N in time order); the
 * refused strings are surfaced only as an audit count.
 */
export function SummaryLadderView({
  ladder,
  onJump,
}: {
  ladder?: SummaryLadder;
  onJump?: (sectionIndex: number, windowTs: number) => void;
}) {
  const [showRollup, setShowRollup] = useState(true);
  const chapters = ladder?.chapters ?? [];
  if (!ladder || chapters.length === 0) return null;
  const ms = ladder.matchSummary;
  const refused = ms.refusedScoreClaims ?? [];
  return (
    <div className="mt-4 rounded-lg border border-neon/30 bg-card" data-detail-ladder>
      <button
        type="button"
        onClick={() => setShowRollup((v) => !v)}
        aria-expanded={showRollup}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        data-detail-ladder-toggle
      >
        <span className="shrink-0 text-mut">{showRollup ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</span>
        <span className="text-xs uppercase tracking-wide text-neon">Match Summary</span>
        <span className="ml-auto flex items-center gap-1.5">
          <span className="rounded-full border border-neon/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-mut" data-detail-ladder-chapter-count>
            {ms.chapterCount || chapters.length} chapters
          </span>
          <span className="rounded-full border border-neon/30 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-mut" data-detail-ladder-goal-count>
            {ms.goalCount} goal{ms.goalCount === 1 ? "" : "s"}
          </span>
        </span>
      </button>
      {showRollup && (
        <div className="border-t border-neon/20 px-3 py-2" data-detail-ladder-body>
          <p className="whitespace-pre-line text-xs leading-relaxed text-slate-ink" data-detail-ladder-match-summary>
            {ms.text}
          </p>
          {ms.verifiedGoalCount < ms.goalCount && (
            <p className="mt-1 text-[11px] text-mut" data-detail-ladder-goal-caveat>
              {ms.goalCount - ms.verifiedGoalCount} of {ms.goalCount} accepted goals are not corroborated by frames — counted, never asserted as scored.
            </p>
          )}
          {refused.length > 0 && (
            <p className="mt-1 text-[11px] text-mut" data-detail-ladder-refused>
              Score strings refused by the fact gate: {refused.join(", ")}
            </p>
          )}
        </div>
      )}
      <ol className="flex flex-col gap-1.5 border-t border-neon/20 px-3 py-2" data-detail-ladder-chapters>
        {chapters.map((c) => (
          <ChapterRow key={c.index} chapter={c} onJump={onJump} />
        ))}
      </ol>
    </div>
  );
}
