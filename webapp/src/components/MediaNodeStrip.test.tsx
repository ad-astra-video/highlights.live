import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { MediaNodeStrip } from "./MediaNodeStrip";

// The strip is shared by the RTMP live console and the browser-capture panel
// (ADAAAA-7655 gap 3). This SSR smoke proves it renders standalone — without a
// resolved poll it must show the waiting state, never crash or go blank.
describe("MediaNodeStrip", () => {
  it("renders the strip shell with a waiting token before the first poll", () => {
    const html = renderToString(React.createElement(MediaNodeStrip));
    expect(html).toContain('data-testid="media-node-strip"');
    expect(html).toContain("waiting for node readout…");
  });
});
