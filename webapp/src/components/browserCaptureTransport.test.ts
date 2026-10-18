import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Source-level regression guard for the browser-capture transport (ADAAAA-6868
// Phase 3). The actual transport can't be exercised in the vitest node
// environment (no jsdom/WebRTC/MediaRecorder), so this asserts the code paths:
// the browser must never POST to the retired server /ingest or /recording rails
// and must stream recording chunks to the MEDIA SERVER over a dedicated WS.
const source = readFileSync(fileURLToPath(new URL("./BrowserCapture.tsx", import.meta.url)), "utf8");

describe("BrowserCapture transport (ADAAAA-6868 Phase 3)", () => {
  it("never POSTs to the retired server-side rails (/jobs/:id/ingest or /jobs/:id/recording)", () => {
    // Template-literal api() calls to the retired rails must not reappear.
    expect(source).not.toMatch(/\/jobs\/\$\{[^}]+\}\/ingest/);
    expect(source).not.toMatch(/\/jobs\/\$\{[^}]+\}\/recording/);
  });

  it("streams MediaRecorder chunks to the media server over a dedicated media WS", () => {
    expect(source).toMatch(/openMediaSocket\(/);
    // flushMediaChunks drains the queue over the dedicated media socket (wsRef)
    // with a {type:"media"} envelope — not over the analysis socket.
    const flushRegion = source.slice(
      source.indexOf("function flushMediaChunks"),
      source.indexOf("function sendMediaChunk")
    );
    expect(flushRegion).toMatch(/wsRef\.current/);
    expect(flushRegion).toMatch(/\{ type: ?["']media["']/);
    // The chunk enqueue path must not reference the analysis socket, so a
    // reconnect of the analysis socket can never drop recording bytes.
    const sendRegion = source.slice(
      source.indexOf("function sendMediaChunk"),
      source.indexOf("function sendMediaChunk") + 900
    );
    expect(sendRegion).not.toMatch(/analysisWsRef/);
  });

  it("opens the media socket in RTC mode too (so recording never rides the analysis socket)", () => {
    // In RTC mode the video rides WebRTC, but the recording socket is still
    // opened for MediaRecorder chunks.
    const rtcRegion = source.slice(
      source.indexOf("modeRef.current = \"rtc\""),
      source.indexOf("modeRef.current = \"ws\"")
    );
    expect(rtcRegion).toMatch(/openMediaSocket/);
  });
});
