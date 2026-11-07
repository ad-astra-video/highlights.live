import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightActionRow } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";
import { clipFileName, clipUrl } from "../lib/highlightPost";

// ADAAAA-7622: the highlight card used to offer no posting path at all. These
// tests pin the posting actions — Download, Copy Link and the editable caption
// — plus the batch-selection checkbox the page wires to its multi-select export.
// ADAAAA-7910 (increment 2) migrated them: Download / Copy Link / verdict now
// live in ONE row of three equal slots (`data-detail-actions`), Accept is gone
// (accepted is the server default), and the restore path moved into slot 3 as
// "Undo reject" (rejected cards) / "Approve" (pending cards).
// Behaviour that needs a DOM/clipboard (the actual save and copy) is verified
// separately on the deployed page; here we assert the controls render with the
// public, token-free URL and that each slot carries a stable accessible name.

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 60,
    end: 80,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-10-18T00:00:00Z",
    ...over,
  };
}

function html(over: Partial<JobDetailHighlight> = {}): string {
  return renderToString(React.createElement(HighlightCard, { highlight: hl(over), onDecision: () => {} }));
}

/** Count non-overlapping occurrences of a marker. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Slice the markup of a single slot, so icon/label assertions stay local. */
function slot(haystack: string, marker: string): string {
  const at = haystack.indexOf(marker);
  expect(at, `${marker} must render`).toBeGreaterThan(-1);
  const start = haystack.lastIndexOf("<", at);
  const ends = ["</button>", "</a>"]
    .map((close) => haystack.indexOf(close, start))
    .filter((i) => i > -1);
  return haystack.slice(start, Math.min(...ends) + 1);
}

describe("highlight posting actions (ADAAAA-7622, ADAAAA-7910)", () => {
  it("renders exactly ONE action row with three slots in order: Download, Copy Link, verdict", () => {
    const html_ = html();
    expect(count(html_, "data-detail-actions")).toBe(1);
    const row = html_.slice(html_.indexOf("data-detail-actions"), html_.indexOf("data-detail-asr"));
    const order = ["data-detail-download", "data-detail-copy-link", "data-detail-reject"].map((m) =>
      row.indexOf(m)
    );
    expect(order.every((i) => i > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Three slots, each flagged for the CSS grid/expansion rules.
    expect(count(html_, 'data-detail-action="')).toBe(3);
    // Accept is gone for every role: accepted is the server default and the
    // restore path lives in slot 3.
    expect(count(html_, "data-detail-accept")).toBe(0);
    for (const admin of [true, false]) {
      const card = renderToString(
        React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin })
      );
      expect(count(card, "data-detail-accept"), `admin=${admin}`).toBe(0);
    }
  });

  it("renders a Download slot carrying the clip URL, a filename and an aria-label", () => {
    const html_ = html();
    expect(html_).toContain(`href="${clipUrl("/clips/h1.mp4")}"`);
    expect(html_).toContain(`download="${clipFileName(hl())}"`);
    expect(html_).toContain('aria-label="Download"');
    // The public clip path — no auth token in the copied/downloaded link.
    expect(html_).not.toContain("token=");
  });

  it("renders a Copy Link slot spelled with a capital L and its copy state hook", () => {
    const html_ = html();
    expect(html_).toContain("data-detail-copy-link");
    expect(html_).toContain("Copy Link");
    expect(html_).not.toContain("Copy link");
    expect(html_).toContain('aria-label="Copy Link"');
    expect(html_).toContain('data-copy-state="idle"');
  });

  it("renders icon-only slots at rest: one <svg> each, label element clipped", () => {
    const html_ = html();
    for (const marker of ["data-detail-download", "data-detail-copy-link", "data-detail-reject"]) {
      const markup = slot(html_, marker);
      expect(markup.match(/<svg/g)?.length ?? 0, `${marker} renders one icon`).toBe(1);
      expect(markup, `${marker} keeps a clipped label element`).toContain("data-detail-label");
    }
  });

  it("slot 3 is stateful: Reject / Undo reject / Approve (ADAAAA-7910)", () => {
    const accepted = html({ status: "accepted" });
    expect(accepted).toContain("data-detail-reject");
    expect(accepted).toContain(">Reject<");

    const rejected = html({ status: "rejected" });
    expect(rejected).toContain("data-detail-restore");
    expect(rejected).toContain("Undo reject");
    expect(rejected).not.toContain("data-detail-reject=");
    expect(rejected).not.toContain("data-detail-approve");

    // A non-auto-publish box stores `pending`: never strand the clip without an
    // accept control (AC9).
    const pending = html({ status: "pending" });
    expect(pending).toContain("data-detail-approve");
    expect(pending).toContain("Approve");
    expect(pending).toContain('aria-label="Approve"');
  });

  it("routes each verdict slot to the right review decision (AC8/AC9)", () => {
    const calls: Array<[string, string]> = [];
    const onDecision = (h: JobDetailHighlight, status: "accepted" | "rejected") =>
      calls.push([h.id, status]);
    const walk = (node: React.ReactNode, out: React.ReactElement<any>[] = []) => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child as React.ReactNode, out);
        return out;
      }
      if (!node || typeof node !== "object") return out;
      const el = node as React.ReactElement<any>;
      if (el.type === "button" || el.type === "a") out.push(el);
      if (el.props) walk(el.props.children, out);
      return out;
    };
    const render = (status: string) =>
      walk(
        HighlightActionRow({
          highlight: hl({ status }),
          downloadUrl: clipUrl("/clips/h1.mp4"),
          onCopy: () => {},
          onDecision,
        })
      );

    render("accepted")
      .find((b) => "data-detail-reject" in b.props)!
      .props.onClick();
    render("rejected")
      .find((b) => "data-detail-restore" in b.props)!
      .props.onClick();
    render("pending")
      .find((b) => "data-detail-approve" in b.props)!
      .props.onClick();

    expect(calls).toEqual([
      ["h1", "rejected"],
      ["h1", "accepted"],
      ["h1", "accepted"],
    ]);
  });

  it("makes the post title the copy target and keeps the announcer line as detail (ADAAAA-8318)", () => {
    const announcer = "Argentina scores from close range.";
    const html_ = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ localizedTs: 69 }),
        onDecision: () => {},
        onCaptionChange: () => {},
        summaryLog: [{ seq: 1, ts: "2026-10-18T00:00:00Z", windowTs: 68, text: announcer }],
      })
    );
    expect(html_).toContain("data-detail-caption");
    expect(html_).toContain("Suggested caption");
    // The copy target is the deterministic post title (no stored title on this
    // fixture), NOT the announcer sentence and NOT a `T+` prefix.
    const box = html_.slice(html_.indexOf("data-detail-copy-target"), html_.indexOf("</textarea>"));
    expect(box).toContain("GOAL · 1:09");
    expect(box).not.toContain(announcer);
    expect(html_).not.toContain("GOAL · T+");
    // The announcer line is still reachable on the card, as collapsed detail.
    expect(html_).toContain("data-detail-announcer");
    expect(html_).toContain("What happened");
    expect(html_).toContain(announcer);
  });

  it("serves a stored postTitle as the copy target byte-for-byte (ADAAAA-8318)", () => {
    const html_ = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ localizedTs: 69, postTitle: "Ordonez opens the scoring" }),
        onDecision: () => {},
        onCaptionChange: () => {},
      })
    );
    expect(html_).toContain("Ordonez opens the scoring");
    expect(html_).not.toContain("GOAL · 1:09");
  });

  it("renders 2-3 one-line post titles with a `Use as caption` affordance (ADAAAA-7881)", () => {
    const html_ = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ localizedTs: 69, reason: "The striker finishes from close range." }),
        onDecision: () => {},
        onCaptionChange: () => {},
        summaryLog: [{ seq: 1, ts: "2026-10-18T00:00:00Z", windowTs: 68, text: "Argentina breaks the deadlock." }],
      })
    );
    expect(html_).toContain("data-detail-titles");
    const titles = html_.match(/data-detail-title="/g) ?? [];
    expect(titles.length).toBeGreaterThanOrEqual(2);
    expect(titles.length).toBeLessThanOrEqual(3);
    // ADAAAA-8318: an option is the served string verbatim (no read-time trim),
    // so the accessible name carries its own terminal punctuation.
    expect(html_).toContain('aria-label="Use &quot;Argentina breaks the deadlock.&quot; as caption"');
    expect(html_).toContain("Use as caption");
  });

  it("offers the batch checkbox only on selectable (postable) cards", () => {
    const plain = html();
    expect(plain).not.toContain("data-detail-select-highlight");

    const selectable = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        onToggleSelect: () => {},
      })
    );
    expect(selectable).toContain("data-detail-select-highlight");
    expect(selectable).toContain("Batch");
  });

  it("reflects the selected state in the batch checkbox", () => {
    const html_ = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        selected: true,
        onToggleSelect: () => {},
      })
    );
    expect(html_).toMatch(/data-detail-select-highlight[^>]*checked/);
  });

  it("disables Download/Copy Link when the highlight produced no clip", () => {
    const html_ = html({ clipUri: "" });
    expect(html_).not.toContain("<a");
    expect(html_).toMatch(/data-detail-download[^>]*disabled|disabled[^>]*data-detail-download/);
    expect(html_).toMatch(/data-detail-copy-link[^>]*disabled|disabled[^>]*data-detail-copy-link/);
    // The verdict slot stays usable: a clip-less highlight can still be
    // rejected / restored.
    expect(html_).not.toMatch(/data-detail-reject[^>]*disabled|disabled[^>]*data-detail-reject/);
  });
});
