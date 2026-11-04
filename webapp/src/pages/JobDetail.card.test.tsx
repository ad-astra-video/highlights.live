import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightActionRow } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-7881: the identified highlight card is customer copy. These tests pin
// the three defects the board reported — the ASR transcript rendered twice, the
// raw pipeline status enum printed as the card's only label, and the "N merged"
// badge standing in for a real indication — plus the new hierarchy: moment
// header, suggested caption, one-line post titles, actions, and the operator's
// pipeline internals behind ONE collapsed disclosure.
//
// ADAAAA-7893: ADAAAA-7881 had parked the review CONTROLS inside that
// operator-only disclosure, so a non-admin session rendered no review path at
// all even though `POST /highlights/:id/review` is ownership scoped. The badge
// stays gone (ADAAAA-7880); the controls are primary actions again, visible to
// every session.
//
// ADAAAA-7910: the two action rows merged into ONE (`data-detail-actions`) with
// three equal slots — Download / Copy Link / verdict. Accept is removed
// (`accepted` is the server default); slot 3 carries Reject, Undo reject or
// Approve so the restore path never disappears.

const TRANSCRIPT = "so the keeper claims it and the whistle goes";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: "/clips/h1.mp4",
    start: 359.2,
    end: 374.2,
    eventType: "SPORTING_EVENT",
    score: 88,
    outcome: "scoring_play",
    reason: "outcome=scoring_play accepted at score 88",
    status: "accepted",
    createdAt: "2026-11-03T00:00:00Z",
    trigger: { kind: "audio_burst", timestamp: 366.2, eventType: "SPORTING_EVENT" },
    ...over,
  };
}

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

const ROLES: { role: string; admin: boolean }[] = [
  { role: "operator (admin)", admin: true },
  { role: "customer", admin: false },
  { role: "operator on the rejected lane", admin: true },
];

describe("AC1 — the transcript and the audio state render exactly once (ADAAAA-7881)", () => {
  for (const { role, admin } of ROLES) {
    it(`${role}: one transcript node, one copy of the text`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ asrTranscript: TRANSCRIPT }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-asr")).toBe(1);
      expect(count(html, TRANSCRIPT)).toBe(1);
      expect(count(html, "data-detail-no-audio")).toBe(0);
    });

    it(`${role}: one no-audio note and no transcript node`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ hasAudio: false }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-no-audio")).toBe(1);
      expect(count(html, "No audio captured")).toBe(1);
      expect(count(html, "data-detail-asr")).toBe(0);
    });
  }

  it("keeps the stored transcript verbatim behind the low-emphasis disclosure", () => {
    const quoted = 'he says "that is a goal", then T+0 jump cut — unchanged';
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ asrTranscript: quoted }),
        onDecision: () => {},
        admin: false,
      })
    );
    expect(html).toContain("Transcript");
    expect(html).toContain("data-detail-asr");
    // Verbatim: the stored value is never trimmed or re-written.
    expect(html).toContain(quoted.replace(/"/g, "&quot;"));
  });
});

describe("AC2 — no internal badge, no raw status enum (ADAAAA-7881)", () => {
  for (const { role, admin } of ROLES) {
    it(`${role}: no merged badge and no bare status text`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ duplicateCount: 2, mergedIds: ["a", "b"] }),
          onDecision: () => {},
          admin,
        })
      );
      expect(html).not.toContain("data-detail-duplicate-count");
      expect(html).not.toContain("data-detail-status");
      expect(html).not.toContain(">accepted<");
      expect(html).not.toContain(">rejected<");
      expect(html).not.toContain("merged");
    });
  }

  it("the customer card HAS the review controls and no pipeline internals (ADAAAA-7893)", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ asrTranscript: TRANSCRIPT }),
        onDecision: () => {},
        admin: false,
      })
    );
    // ADAAAA-7910: Accept is gone; the verdict slot is still there for the
    // owner, without operator chrome.
    expect(count(html, "data-detail-actions")).toBe(1);
    expect(count(html, "data-detail-accept")).toBe(0);
    expect(count(html, "data-detail-reject")).toBe(1);
    for (const token of ["SPORTING_EVENT", "outcome=scoring_play", "Trigger:", "data-detail-pipeline", "Pipeline detail"]) {
      expect(html, `customer card must not contain ${token}`).not.toContain(token);
    }
  });

  it("the operator card keeps its internals inside ONE collapsed disclosure", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: true })
    );
    expect(count(html, "data-detail-pipeline")).toBe(1);
    expect(html).toContain("Pipeline detail");
    // Collapsed by default: the <details> carries no `open` attribute.
    expect(html).toMatch(/<details[^>]*data-detail-pipeline[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*data-detail-pipeline[^>]*\sopen/);
    // Every internal renders AFTER the disclosure opens — and the review
    // controls do NOT (ADAAAA-7893: they are primary actions, not internals).
    const at = html.indexOf("data-detail-pipeline");
    for (const token of ["SPORTING_EVENT", "outcome=scoring_play", "Trigger:"]) {
      expect(html.indexOf(token), `${token} should sit inside Pipeline detail`).toBeGreaterThan(at);
    }
    expect(html.indexOf("data-detail-actions")).toBeLessThan(at);
    expect(html.indexOf("data-detail-reject")).toBeLessThan(at);
  });

  it("a rejected card carries ONE inline recovery note, visible to every session (ADAAAA-7910)", () => {
    for (const admin of [true, false]) {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ status: "rejected" }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-rejected")).toBe(1);
      // ADAAAA-7915: plain recovery copy that names the control on the card.
      // No bare status token, so a customer session renders it unchanged.
      expect(html).toContain("Undo reject restores this clip within its recover window.");
      // Recovery guidance, not a badge: no bare status label anywhere.
      expect(html).not.toContain(">rejected<");
      expect(html).not.toContain(">accepted<");
      // It belongs to the action area, so it precedes the operator disclosure
      // (and the transcript) rather than hiding inside it.
      const note = html.indexOf("data-detail-rejected");
      if (admin) expect(note).toBeLessThan(html.indexOf("data-detail-pipeline"));
      if (html.includes("data-detail-asr")) expect(note).toBeLessThan(html.indexOf("data-detail-asr"));
    }
  });
});

describe("card hierarchy (ADAAAA-7881)", () => {
  it("leads with the moment range + duration chip", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: false })
    );
    expect(html).toContain("T+359s – T+374s");
    expect(html).toContain("data-detail-moment-range");
    expect(html).toContain("data-detail-duration");
    // react-dom/server separates adjacent text nodes with `<!-- -->`.
    expect(html.replace(/<!--\s*-->/g, "")).toContain(">15s<");
  });

  it("keeps the posting actions and the batch checkbox on a selectable card", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl(),
        onDecision: () => {},
        selectable: true,
        onToggleSelect: () => {},
        admin: false,
      })
    );
    expect(html).toContain("data-detail-download");
    expect(html).toContain("data-detail-copy-link");
    expect(html).toContain("data-detail-select-highlight");
    expect(html).toContain("Batch");
  });
});

/** The suite runs in the node env (no jsdom), so `renderToString` gives markup
 *  only. To exercise a real click handler we render the hook-free
 *  HighlightActionRow and walk the element tree it returns. */
function controlsOf(node: React.ReactNode, out: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
  if (Array.isArray(node)) {
    for (const child of node) controlsOf(child as React.ReactNode, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as React.ReactElement<any>;
  if (el.type === "button" || el.type === "a") out.push(el);
  if (el.props) controlsOf(el.props.children, out);
  return out;
}

function actionRow(
  highlight: JobDetailHighlight,
  onDecision: (h: JobDetailHighlight, status: "accepted" | "rejected") => void,
  extra: { pendingStatus?: "accepted" | "rejected" | null; exportLocked?: boolean } = {}
) {
  const controls = controlsOf(
    HighlightActionRow({
      highlight,
      downloadUrl: "/clips/h1.mp4?export=1",
      onCopy: () => {},
      onDecision,
      ...extra,
    })
  );
  return {
    download: controls.find((c) => "data-detail-download" in c.props)!,
    copy: controls.find((c) => "data-detail-copy-link" in c.props)!,
    verdict: controls.find(
      (c) => "data-detail-reject" in c.props || "data-detail-restore" in c.props || "data-detail-approve" in c.props
    )!,
  };
}

describe("ADAAAA-7910 — one action row, three slots, Accept gone", () => {
  for (const admin of [true, false]) {
    it(`admin=${admin}: exactly one row with three slots, zero Accept controls`, () => {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ asrTranscript: TRANSCRIPT }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-actions")).toBe(1);
      expect(count(html, 'data-detail-action="')).toBe(3);
      expect(count(html, "data-detail-accept")).toBe(0);
      expect(count(html, "data-detail-review")).toBe(0);
      // Order inside the row: Download -> Copy Link -> verdict.
      const row = html.slice(html.indexOf("data-detail-actions"), html.indexOf("data-detail-asr"));
      const order = ["data-detail-download", "data-detail-copy-link", "data-detail-reject"].map((m) =>
        row.indexOf(m)
      );
      expect(order.every((i) => i > -1)).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      // Above the transcript: primary actions, not a disclosure.
      expect(html.indexOf("data-detail-actions")).toBeLessThan(html.indexOf("data-detail-asr"));
    });
  }

  it("the verdict slot carries the review decision with the exact label strings", () => {
    const accepted = actionRow(hl({ status: "accepted" }), () => {});
    expect(accepted.verdict.props["data-detail-reject"]).toBe(true);
    expect(accepted.verdict.props["aria-label"]).toBe("Reject");

    const rejected = actionRow(hl({ status: "rejected" }), () => {});
    expect(rejected.verdict.props["data-detail-restore"]).toBe(true);
    expect(rejected.verdict.props["aria-label"]).toBe("Undo reject");

    const pending = actionRow(hl({ status: "pending" }), () => {});
    expect(pending.verdict.props["data-detail-approve"]).toBe(true);
    expect(pending.verdict.props["aria-label"]).toBe("Approve");
  });

  it("a verdict click calls onDecision with the state it moves the clip to", () => {
    const target = hl();
    const calls: Array<[string, string]> = [];
    const onDecision = (h: JobDetailHighlight, status: "accepted" | "rejected") => calls.push([h.id, status]);
    actionRow(target, onDecision).verdict.props.onClick();
    actionRow(hl({ status: "rejected" }), onDecision).verdict.props.onClick();
    actionRow(hl({ status: "pending" }), onDecision).verdict.props.onClick();
    expect(calls).toEqual([
      ["h1", "rejected"],
      ["h1", "accepted"],
      ["h1", "accepted"],
    ]);
  });

  it("disables the verdict slot only while its own request is in flight", () => {
    expect(actionRow(hl(), () => {}).verdict.props.disabled).toBe(false);
    // Reject in flight: the reject slot shows the spinner and blocks a double
    // submit. Restore/approve slots are unaffected because their target differs.
    expect(actionRow(hl(), () => {}, { pendingStatus: "rejected" }).verdict.props.disabled).toBe(true);
    expect(actionRow(hl({ status: "rejected" }), () => {}, { pendingStatus: "rejected" }).verdict.props.disabled).toBe(
      false
    );
  });

  it("locks Reject for an owner once the clip was exported (ADAAAA-7896 preserved)", () => {
    expect(actionRow(hl({ exportedAt: "2026-11-01T10:00:00Z" }), () => {}, { exportLocked: true }).verdict.props.disabled).toBe(true);
    // An already-rejected clip keeps its restore path even when exported.
    expect(
      actionRow(hl({ status: "rejected", exportedAt: "2026-11-01T10:00:00Z" }), () => {}, { exportLocked: true })
        .verdict.props.disabled
    ).toBe(false);
  });

  it("the Download slot is an anchor with the export URL and the copy slot exposes its state", () => {
    const row = actionRow(hl(), () => {});
    expect(row.download.type).toBe("a");
    expect(row.download.props.href).toBe("/clips/h1.mp4?export=1");
    expect(row.download.props["aria-label"]).toBe("Download");
    expect(row.copy.props["aria-label"]).toBe("Copy Link");
    expect(row.copy.props["data-copy-state"]).toBe("idle");
  });

  it("every slot carries a stable accessible name and a clipped label element", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: false })
    );
    for (const label of ['aria-label="Download"', 'aria-label="Copy Link"', 'aria-label="Reject"']) {
      expect(html).toContain(label);
    }
    expect(count(html, "data-detail-label")).toBe(3);
  });
});
