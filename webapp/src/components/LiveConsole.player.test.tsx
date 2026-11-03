import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { LiveConsole } from "./LiveConsole";

// ADAAAA-7833: the jersey-number path exists in perceive but had no user-facing
// entry point. This SSR smoke proves the console renders the field (and the
// capacity note the issue asks for) without a browser. Effects do not run under
// renderToString, so no SSE/api call is attempted.
describe("LiveConsole player-by-jersey field", () => {
  it("renders the track-player input plus the slot-cost copy", () => {
    const html = renderToString(React.createElement(LiveConsole, { jobId: "job-1" }));
    expect(html).toContain("track a player by jersey number");
    expect(html).toContain("Track #");
    // AC-5: the seeded player consumes exactly one slot (3 live / 8 VOD).
    expect(html).toContain("3 on a live stream, 8 on a VOD");
    // Labelled as a one-shot cost, not per-frame inference.
    expect(html).toContain("no per-frame inference cost");
  });

  it("still renders the pre-existing label-intent control", () => {
    const html = renderToString(React.createElement(LiveConsole, { jobId: "job-1" }));
    expect(html).toContain("prefer labels");
  });
});
