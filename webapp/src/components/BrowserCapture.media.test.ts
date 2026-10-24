import { describe, expect, it } from "vitest";
import { isTransientMediaError } from "./BrowserCapture";

// ADAAAA-7335: the screen share must NOT silently fall back to the HTTP
// /ingest rail on a transient /jobs/:id/media failure. The classifier tells a
// retryable capacity/busy failure (HTTP 503 `no capacity available for runner`,
// when the perceive runner's SessionRegistry is at capacity) apart from the
// genuine "no media-server rail" case and other real errors, so openMedia backs
// off + surfaces instead of degrading.
describe("isTransientMediaError (ADAAAA-7335)", () => {
  it("returns true for HTTP 503 no-capacity (the perceive capacity signal)", () => {
    const err: any = new Error("media provision failed: HTTP 503 no capacity available for runner");
    err.status = 503;
    expect(isTransientMediaError(err)).toBe(true);
  });

  it("returns true for a 503 ApiError even when the message does not mention capacity", () => {
    const err: any = new Error("HTTP 503");
    err.status = 503;
    expect(isTransientMediaError(err)).toBe(true);
  });

  it("returns true for a gateway 502/504 (transient network-level)", () => {
    const c502: any = new Error("Bad Gateway");
    c502.status = 502;
    const c504: any = new Error("Gateway Timeout");
    c504.status = 504;
    expect(isTransientMediaError(c502)).toBe(true);
    expect(isTransientMediaError(c504)).toBe(true);
  });

  it("returns false for HTTP 200 (a real rail was returned — not an error path)", () => {
    const ok: any = new Error("ok");
    ok.status = 200;
    // A classify of a successful response should be false (it is not a failure).
    expect(isTransientMediaError(ok)).toBe(false);
  });

  it("returns false for real, non-transient errors (404 / 403 / 409 / 400)", () => {
    for (const status of [404, 403, 409, 400, 422]) {
      const err: any = new Error(`HTTP ${status}`);
      err.status = status;
      expect(isTransientMediaError(err)).toBe(false);
    }
  });

  it("returns false for a non-capacity 500 (a real server bug — surface it)", () => {
    const err: any = new Error("internal server error");
    err.status = 500;
    expect(isTransientMediaError(err)).toBe(false);
  });

  it("classifies a raw non-ApiError value without a status (no throw)", () => {
    expect(isTransientMediaError("no capacity available for runner")).toBe(true);
    expect(isTransientMediaError(new Error("boom"))).toBe(false);
  });
});
