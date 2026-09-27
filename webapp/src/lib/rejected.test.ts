import { describe, it, expect } from "vitest";
import {
  DEFAULT_REJECTED_CLIP_TTL_MS,
  recoverUntil,
  isRecoverable,
  recoverLabel,
  formatRelativeRemaining,
} from "./rejected";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("rejected-clip recovery helpers (ADAAAA-5204)", () => {
  it("recoverUntil computes rejectedAt + ttl", () => {
    // epoch 2026-01-01T00:00:00Z
    const at = "2026-01-01T00:00:00.000Z";
    expect(recoverUntil(at, DAY)).toBe(Date.parse(at) + DAY);
  });

  it("recoverUntil returns null without rejectedAt / on bad input", () => {
    expect(recoverUntil(undefined, DAY)).toBeNull();
    expect(recoverUntil("not-a-date", DAY)).toBeNull();
  });

  it("isRecoverable only within the window (zero false recoverable claims after TTL)", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const base = Date.parse(at);
    // Freshly rejected -> recoverable.
    expect(isRecoverable(at, DAY, base + HOUR)).toBe(true);
    // Just before TTL -> recoverable.
    expect(isRecoverable(at, DAY, base + DAY - 1000)).toBe(true);
    // Exactly at / after TTL -> NOT recoverable, even though the server's sweep
    // may not have reclaimed the row yet (sweep runs hourly).
    expect(isRecoverable(at, DAY, base + DAY)).toBe(false);
    expect(isRecoverable(at, DAY, base + DAY + HOUR)).toBe(false);
    // No rejectedAt -> not recoverable.
    expect(isRecoverable(undefined, DAY, base)).toBe(false);
  });

  it("recoverLabel renders 'Recover until <relative>' within window, null after", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const base = Date.parse(at);
    const label = recoverLabel(at, DAY, base + HOUR);
    expect(label).toBeTruthy();
    expect(label).toContain("Recover until");
    expect(recoverLabel(at, DAY, base + DAY + 1000)).toBeNull();
    expect(recoverLabel(undefined, DAY, base)).toBeNull();
  });

  it("formatRelativeRemaining renders compact H/M/S strings", () => {
    expect(formatRelativeRemaining(DEFAULT_REJECTED_CLIP_TTL_MS - HOUR)).toContain("h");
    expect(formatRelativeRemaining(12 * 60 * 1000)).toContain("m");
    expect(formatRelativeRemaining(5000)).toContain("s");
    expect(formatRelativeRemaining(0)).toBe("less than a minute");
    expect(formatRelativeRemaining(-5)).toBe("less than a minute");
  });
});
