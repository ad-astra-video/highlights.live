import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { HighlightCard } from "./JobDetail";
import type { JobDetailHighlight } from "../lib/jobDetail";
import {
  batchManifest,
  copyExportLink,
  exportUrl,
  markExportIntent,
  markExportIntentBatch,
  EXPORT_INTENT_MAX_IDS,
} from "../lib/highlightPost";

// ADAAAA-7896 — the webapp half of the export lock.
//
// AC5: copying a clip's link marks it (via `copy_link`) ONLY when the clipboard
//      write succeeded; a failed copy shares nothing and must not lock the clip.
// AC1/AC6 (webapp side): the Download anchor and the batch manifest carry the
//      server-minted EXPORT URL (token), never the plain playback URL.
//
// The node test env has no jsdom, so the click itself cannot be synthesised;
// these tests drive the exact functions the card's buttons call (`copyExportLink`
// + `markExportIntent*`) with `copyText`/`api` injected, plus assert the RENDERED
// Download anchor carries the export URL.

const EXPORT_URI = "https://app.test/clips/h1.mp4?x=payload.sig";
const PUBLIC_URI = "/clips/h1.mp4";

function hl(over: Partial<JobDetailHighlight> = {}): JobDetailHighlight {
  return {
    id: "h1",
    jobId: "j1",
    clipUri: PUBLIC_URI,
    exportUri: EXPORT_URI,
    start: 60,
    end: 80,
    eventType: "GOAL",
    score: 92,
    status: "accepted",
    createdAt: "2026-11-01T00:00:00Z",
    ...over,
  };
}

/** Records the intent POSTs the card makes, with the component's own wiring. */
function intentRecorder() {
  const posts: { path: string; body: any }[] = [];
  const post = (p: string, body: unknown) => {
    posts.push({ path: p, body });
    return Promise.resolve();
  };
  return { posts, post };
}

describe("export-aware posting (ADAAAA-7896)", () => {
  it("AC5: copy success -> exactly one export-intent POST with via copy_link", async () => {
    const { posts, post } = intentRecorder();
    const copied: string[] = [];
    const ok = await copyExportLink(hl(), {
      copy: async (text) => {
        copied.push(text);
        return true;
      },
      mark: (id) => markExportIntent(post, id, "copy_link"),
    });

    expect(ok).toBe(true);
    // The copied text IS the export URL, so a third-party open marks the same
    // state through the URL path.
    expect(copied).toEqual([EXPORT_URI]);
    expect(posts).toEqual([{ path: "/highlights/h1/export-intent", body: { via: "copy_link" } }]);
  });

  it("AC5: copy failure -> NO export-intent POST, no mark", async () => {
    const { posts, post } = intentRecorder();
    const ok = await copyExportLink(hl(), {
      copy: async () => false,
      mark: (id) => markExportIntent(post, id, "copy_link"),
    });

    expect(ok).toBe(false);
    expect(posts).toEqual([]);
  });

  it("the Download anchor carries the export URL, not the playback URL", () => {
    const html = renderToString(React.createElement(HighlightCard, { highlight: hl(), onDecision: () => {} }));
    expect(html).toContain("data-detail-download");
    expect(html).toContain(`href="${EXPORT_URI}"`);
    expect(html).not.toContain(`href="${PUBLIC_URI}"`);
    // Hooks + copy affordance preserved.
    expect(html).toContain("data-detail-copy-link");
    expect(html).toContain("Copy Link");
  });

  it("falls back to the playback URL when the server sends no exportUri", () => {
    const html = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ exportUri: undefined }), onDecision: () => {} })
    );
    expect(html).toContain(`href="${PUBLIC_URI}"`);
    expect(exportUrl(hl({ exportUri: undefined }))).toBe(PUBLIC_URI);
  });

  it("AC6: one bounded batch intent marks every selected clip (copy_urls / batch_zip)", async () => {
    const ids = ["b1", "b2", "b3", "b4", "b5"];
    const { posts, post } = intentRecorder();
    await markExportIntentBatch(post, ids, "copy_urls");
    expect(posts.length).toBe(1);
    expect(posts[0].path).toBe("/highlights/export-intent");
    expect(posts[0].body).toEqual({ ids, via: "copy_urls" });

    await markExportIntentBatch(post, ids, "batch_zip");
    expect(posts[1].body).toEqual({ ids, via: "batch_zip" });

    // Bounded: never more than 50 ids in one call.
    const many = Array.from({ length: 60 }, (_, i) => `c${i}`);
    await markExportIntentBatch(post, many, "copy_urls");
    expect(posts[2].body.ids.length).toBe(EXPORT_INTENT_MAX_IDS);
  });

  it("AC3 (UI): an owner's Reject is locked once the clip was exported; an operator keeps it", () => {
    const ownerHtml = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ exportedAt: "2026-11-01T10:00:00Z" }), onDecision: () => {}, admin: false })
    );
    expect(ownerHtml).toContain("data-detail-export-locked");
    expect(ownerHtml).toContain("can no longer be rejected");
    // The Reject control itself is disabled (attributeless hook preserved).
    expect(ownerHtml).toMatch(/data-export-locked="true"/);
    expect(ownerHtml).toMatch(/disabled[^>]*data-detail-reject|data-detail-reject[^>]*disabled/);

    const adminHtml = renderToString(
      React.createElement(HighlightCard, { highlight: hl({ exportedAt: "2026-11-01T10:00:00Z" }), onDecision: () => {}, admin: true })
    );
    expect(adminHtml).not.toContain("data-detail-export-locked");
    // Operator reject stays clickable: no lock marker on the control.
    expect(adminHtml).not.toContain('data-export-locked="true"');
  });

  it("AC6: the batch manifest carries the EXPORT URLs", () => {
    const items = ["b1", "b2", "b3", "b4", "b5"].map((id) => ({
      caption: `Moment ${id}`,
      url: exportUrl({ clipUri: `/clips/${id}.mp4`, exportUri: `https://app.test/clips/${id}.mp4?x=tok-${id}` }),
    }));
    const manifest = batchManifest(items);
    for (const id of ["b1", "b2", "b3", "b4", "b5"]) {
      expect(manifest).toContain(`https://app.test/clips/${id}.mp4?x=tok-${id}`);
    }
    expect(manifest).toContain("# Highlights batch — 5 clip(s)");
  });
});
