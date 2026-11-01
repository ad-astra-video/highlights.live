import { renderToString } from "react-dom/server";
import { describe, it, expect } from "vitest";
import React from "react";
import { FailureReasonChip } from "./JobDetail";

/** react-dom/server separates adjacent text nodes with `<!-- -->` markers. */
const text = (html: string) => html.replace(/<!--\s*-->/g, "");

// ADAAAA-7700 AC2: the job record carries a distinct failureReason and it renders
// on /app/jobs/:id. A media-node restart must show as "media session lost", never
// as the same bare `failed` the incident produced.
describe("FailureReasonChip (ADAAAA-7700)", () => {
  it("renders the attributed reason for a media-session loss", () => {
    const html = renderToString(<FailureReasonChip reason="media-session-lost" />);
    expect(text(html)).toContain("media session lost");
    expect(html).toContain('data-detail-failure-reason="media-session-lost"');
  });

  it("renders nothing for a clean job or a legacy row without attribution", () => {
    expect(renderToString(<FailureReasonChip reason={undefined} />)).toBe("");
    expect(renderToString(<FailureReasonChip reason={null} />)).toBe("");
  });

  it("keeps a user stop visually distinct from an infrastructure failure", () => {
    const stopped = renderToString(<FailureReasonChip reason="user-stop" />);
    const lost = renderToString(<FailureReasonChip reason="media-session-lost" />);
    expect(text(stopped)).toContain("stopped by user");
    expect(text(lost)).not.toContain("stopped by user");
  });
});
