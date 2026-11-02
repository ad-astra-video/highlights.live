import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import React from "react";
import { StreamHealthStrip } from "./StreamHealthStrip";
import { foldSample, healthChips, initialHealthState, rateLink, HEALTH_SAMPLE_MS } from "../lib/streamHealth";

// ADAAAA-7730 (Inc 2 of ADAAAA-7726). AC1 (shape) and AC5 (no leak) at the render
// layer: the strip renders at most five chips, and neither the component nor the
// logic behind it reads or prints any field Inc 1 removed from customer responses.

const live = healthChips({
  state: foldSample(initialHealthState(), { link: "good", quality: "good", bitrate: "good", freshness: "good" }),
  link: rateLink({ sharing: true, mode: "rtc", reconnectAttempt: 0 }),
  bitrate: { kbps: 2500, targetKbps: 3000, width: 1920, height: 1080, fps: 30 },
  freshnessMs: 800,
  activity: { clips: 3, detecting: true },
});

const degraded = healthChips({
  state: foldSample(initialHealthState(), { link: "poor", quality: "poor", bitrate: "poor", freshness: "poor" }),
  link: rateLink({ sharing: true, mode: "ingest", reconnectAttempt: 6 }),
  bitrate: { kbps: 300, targetKbps: 3000, width: 1280, height: 720, fps: 12 },
  freshnessMs: 30_000,
  activity: { clips: 0, detecting: false },
});

const chipCount = (html: string) => (html.match(/data-chip=/g) ?? []).length;

describe("StreamHealthStrip", () => {
  it("renders exactly the five spec chips, once each", () => {
    const html = renderToStaticMarkup(React.createElement(StreamHealthStrip, { chips: live }));
    expect(html).toContain('data-testid="stream-health-strip"');
    expect(chipCount(html)).toBe(5);
    for (const id of ["link", "quality", "bitrate", "freshness", "activity"]) {
      expect(html).toContain(`data-chip="${id}"`);
    }
    // Plain-language labels only.
    expect(html).toContain("Link");
    expect(html).toContain("Live");
    expect(html).toContain("2500 kbps");
    expect(html).toContain("0.8 s ago");
  });

  it("never renders more than five chips for any sample", () => {
    for (const chips of [live, degraded]) {
      expect(chipCount(renderToStaticMarkup(React.createElement(StreamHealthStrip, { chips })))).toBeLessThanOrEqual(5);
    }
  });

  it("carries no cost, session identifier, media URL or pipeline counter", () => {
    const html = renderToStaticMarkup(React.createElement(StreamHealthStrip, { chips: live })).toLowerCase();
    for (const forbidden of [
      "$",
      "cost",
      "mediasessionid",
      "mediaorigin",
      "wsurl",
      "decidecalls",
      "perceivesession",
      "observecalls",
      "stageametrics",
      "accuracy",
      "slot",
      "{\"",
    ]) {
      expect(html).not.toContain(forbidden);
    }
  });

  it("reports the poor verdicts in words, never as raw numbers alone", () => {
    const html = renderToStaticMarkup(React.createElement(StreamHealthStrip, { chips: degraded }));
    expect(html).toContain("Offline");
    expect(html).toContain("Poor");
    expect(html).toContain("30.0 s ago");
    expect(html).toContain("300 kbps");
  });
});

// Source scan: the strip path must not READ a removed field either. Comments are
// stripped first, so a comment that names a removed field (documenting the gate)
// is not a false positive — only executable code counts.
const here = __dirname;
const stripSources = ["components/StreamHealthStrip.tsx", "lib/streamHealth.ts", "lib/useStreamHealth.ts"];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("strip source reads nothing internal (AC5)", () => {
  for (const rel of stripSources) {
    it(`${rel} reads no field Inc 1 removed`, () => {
      const code = stripComments(readFileSync(join(here, "..", rel), "utf8"));
      for (const forbidden of [
        "costUsd",
        "decideCalls",
        "perceiveSession",
        "observeCalls",
        "observeMetrics",
        "vodObserveMetrics",
        "confirmMetrics",
        "stageAMetrics",
        "mediaSessionId",
        "mediaOrigin",
        "wsUrl",
        "accuracy",
      ]) {
        expect(code).not.toContain(forbidden);
      }
    });
  }

  it("does not print raw JSON or a currency amount", () => {
    const code = stripComments(readFileSync(join(here, "..", "components/StreamHealthStrip.tsx"), "utf8"));
    expect(code).not.toContain("JSON.stringify");
    expect(code).not.toContain("toFixed(2)");
  });

  // AC1: one 2 s loop, and the loop makes no network call of its own (the strip
  // reads getStats() + in-memory state; freshness/activity ride the job-events
  // SSE the capture panel already opens).
  it("samples on one 2 s interval and issues no request of its own", () => {
    const code = stripComments(readFileSync(join(here, "..", "lib/useStreamHealth.ts"), "utf8"));
    expect(HEALTH_SAMPLE_MS).toBe(2000);
    expect(code).toContain("setInterval");
    expect(code).toContain("HEALTH_SAMPLE_MS");
    expect((code.match(/setInterval/g) ?? []).length).toBe(1);
    for (const network of ["fetch(", "api(", "readSSE", "XMLHttpRequest", "EventSource"]) {
      expect(code).not.toContain(network);
    }
  });
});
