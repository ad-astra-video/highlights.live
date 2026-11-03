import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard, HighlightReviewActions } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";

// ADAAAA-7881: the identified highlight card is customer copy. These tests pin
// the three defects the board reported — the ASR transcript rendered twice, the
// raw pipeline status enum printed as the card's only label, and the "N merged"
// badge standing in for a real indication — plus the new hierarchy: moment
// header, suggested caption, one-line post titles, actions, and the operator's
// pipeline internals behind ONE collapsed disclosure.
//
// ADAAAA-7893: ADAAAA-7881 had parked the Accept/Reject CONTROLS inside that
// operator-only disclosure, so a non-admin session rendered no review path at
// all even though `POST /highlights/:id/review` is ownership scoped. The badge
// stays gone (ADAAAA-7880); the controls are primary actions again, visible to
// every session. The tests below are the inverted ones.

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
    // Inverted from ADAAAA-7881: the owner may review the clip, so the controls
    // must be reachable without operator chrome.
    expect(count(html, "data-detail-accept")).toBe(1);
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
    expect(html.indexOf("data-detail-accept")).toBeLessThan(at);
    expect(html.indexOf("data-detail-reject")).toBeLessThan(at);
  });

  it("a rejected card carries ONE inline recovery note, visible to every session (ADAAAA-7893)", () => {
    for (const admin of [true, false]) {
      const html = renderToString(
        React.createElement(HighlightCard, {
          highlight: hl({ status: "rejected" }),
          onDecision: () => {},
          admin,
        })
      );
      expect(count(html, "data-detail-rejected")).toBe(1);
      expect(html).toContain("Rejected — hidden from the public feed. Accept restores it within the recover window.");
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
 *  HighlightReviewActions component and walk the element tree it returns. */
function buttonsOf(node: React.ReactNode, out: React.ReactElement<any>[] = []): React.ReactElement<any>[] {
  if (Array.isArray(node)) {
    for (const child of node) buttonsOf(child as React.ReactNode, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  const el = node as React.ReactElement<any>;
  if (el.type === "button") out.push(el);
  if (el.props) buttonsOf(el.props.children, out);
  return out;
}

function reviewButtons(
  highlight: JobDetailHighlight,
  onDecision: (h: JobDetailHighlight, status: "accepted" | "rejected") => void
) {
  const tree = HighlightReviewActions({ highlight, onDecision });
  const buttons = buttonsOf(tree);
  return {
    accept: buttons.find((b) => "data-detail-accept" in b.props)!,
    reject: buttons.find((b) => "data-detail-reject" in b.props)!,
  };
}

describe("ADAAAA-7893 — Accept/Reject are owner-facing primary actions", () => {
  const CUSTOMER = { onDecision: () => {}, admin: false } as const;

  it("AC1: the non-admin card carries exactly one accept and one reject, both BEFORE the transcript", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ asrTranscript: TRANSCRIPT }), ...CUSTOMER })
    );
    expect(count(html, "data-detail-accept")).toBe(1);
    expect(count(html, "data-detail-reject")).toBe(1);
    const accept = html.indexOf("data-detail-accept");
    const reject = html.indexOf("data-detail-reject");
    const asr = html.indexOf("data-detail-asr");
    expect(asr).toBeGreaterThan(-1);
    expect(accept).toBeGreaterThan(-1);
    expect(reject).toBeGreaterThan(-1);
    expect(accept, "accept must precede the transcript (primary actions, not a disclosure)").toBeLessThan(asr);
    expect(reject, "reject must precede the transcript (primary actions, not a disclosure)").toBeLessThan(asr);
  });

  it("AC2: the non-admin card carries zero pipeline internals and zero status badge", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ asrTranscript: TRANSCRIPT }), ...CUSTOMER })
    );
    const counts = {
      "data-detail-pipeline": count(html, "data-detail-pipeline"),
      "Pipeline detail": count(html, "Pipeline detail"),
      SPORTING_EVENT: count(html, "SPORTING_EVENT"),
      "outcome=": count(html, "outcome="),
      "Trigger:": count(html, "Trigger:"),
      "data-detail-status": count(html, "data-detail-status"),
      ">accepted<": count(html, ">accepted<"),
      ">rejected<": count(html, ">rejected<"),
    };
    expect(counts).toEqual({
      "data-detail-pipeline": 0,
      "Pipeline detail": 0,
      SPORTING_EVENT: 0,
      "outcome=": 0,
      "Trigger:": 0,
      "data-detail-status": 0,
      ">accepted<": 0,
      ">rejected<": 0,
    });
  });

  it("AC3: the admin card keeps exactly one collapsed disclosure AFTER the controls", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {}, admin: true })
    );
    expect(count(html, "data-detail-pipeline")).toBe(1);
    expect(html).toMatch(/<details[^>]*data-detail-pipeline[^>]*>/);
    expect(html).not.toMatch(/<details[^>]*data-detail-pipeline[^>]*\sopen/);
    expect(html.indexOf("data-detail-accept")).toBeLessThan(html.indexOf("data-detail-pipeline"));
    expect(html.indexOf("data-detail-reject")).toBeLessThan(html.indexOf("data-detail-pipeline"));
    for (const token of ["SPORTING_EVENT", "Trigger:", "outcome=scoring_play"]) {
      expect(html.indexOf(token)).toBeGreaterThan(html.indexOf("data-detail-pipeline"));
    }
    // Score is the disclosure's 2xl numeral.
    expect(html).toContain("text-2xl font-black text-neon");
  });

  it("AC4: an accept/reject click calls onDecision for a non-admin session", () => {
    const target = hl();
    const calls: Array<[string, string]> = [];
    const onDecision = (h: JobDetailHighlight, status: "accepted" | "rejected") => calls.push([h.id, status]);
    // The non-admin card renders these same controls (AC1); the handler is
    // invoked on the element the card returns.
    const { accept, reject } = reviewButtons(target, onDecision);
    accept.props.onClick();
    reject.props.onClick();
    expect(calls).toEqual([
      ["h1", "accepted"],
      ["h1", "rejected"],
    ]);
  });

  it("AC4: each control is disabled when the card status already equals that decision", () => {
    const onDecision = () => {};
    const accepted = reviewButtons(hl({ status: "accepted" }), onDecision);
    expect(accepted.accept.props.disabled).toBe(true);
    expect(accepted.accept.props["aria-pressed"]).toBe(true);
    expect(accepted.reject.props.disabled).toBe(false);
    expect(accepted.reject.props["aria-pressed"]).toBe(false);

    const rejected = reviewButtons(hl({ status: "rejected" }), onDecision);
    expect(rejected.reject.props.disabled).toBe(true);
    expect(rejected.reject.props["aria-pressed"]).toBe(true);
    expect(rejected.accept.props.disabled).toBe(false);
    expect(rejected.accept.props["aria-pressed"]).toBe(false);

    // Both stay enabled on a status neither decision matches.
    const neutral = reviewButtons(hl({ status: "suppressed" }), onDecision);
    expect(neutral.accept.props.disabled).toBe(false);
    expect(neutral.reject.props.disabled).toBe(false);
  });

  it("AC4: the same disabled/aria state is what the rendered card emits", () => {
    const html = renderToString(
      React.createElement(HighlightCard, {
        highlight: hl({ status: "rejected" }),
        onDecision: () => {},
        admin: false,
      })
    );
    const accept = html.slice(html.indexOf("<button"), html.indexOf("data-detail-accept"));
    const reject = html.slice(html.indexOf("<button", html.indexOf("data-detail-accept")), html.indexOf("data-detail-reject"));
    expect(accept).not.toContain("disabled");
    expect(accept).toContain('aria-pressed="false"');
    expect(reject).toContain("disabled");
    expect(reject).toContain('aria-pressed="true"');
  });
});
