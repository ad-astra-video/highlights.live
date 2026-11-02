// ADAAAA-7722 AC3: live watch-minutes must be COUNTED, not assumed.
//
// The ADAAAA-7713 envelope priced its monthly ceiling against a
// continuous-attachment basis (1,440 min/day x 30.44 days = 43,833.6 min/month)
// because nothing on the box reported how much live footage the rails actually
// observed. This suite pins the measurement:
//
//   - per session: `job.liveWatchMinutes`, written at live completion from the
//     session clock the rail already bills on;
//   - month to date: `GET /admin/live-watch-minutes` (UTC month), aggregated from
//     the persisted job records — VOD compute time excluded, unmeasured sessions
//     reported instead of counted as 0.
import { describe, it, expect } from "vitest";
import {
  aggregateLiveWatchMinutes,
  isLiveWatchSession,
  liveWatchMinutesForJob,
  monthKeyUtc,
  sessionMonthUtc,
} from "../src/live-watch-minutes";
import { buildTestApp } from "./helpers";

describe("live watch-minutes per session (ADAAAA-7722 AC3)", () => {
  it("uses the persisted measurement, and falls back to the legacy session clock", () => {
    expect(liveWatchMinutesForJob({ source: "rtmp", liveWatchMinutes: 42.5 })).toBe(42.5);
    // A pre-ADAAAA-7722 live record: derive minutes from perceiveSessionS.
    expect(liveWatchMinutesForJob({ source: "file-sim", perceiveSessionS: 300 })).toBe(5);
    // No measurement at all is null — never a fabricated zero.
    expect(liveWatchMinutesForJob({ source: "rtmp" })).toBeNull();
  });

  it("never counts VOD compute time as watch time", () => {
    expect(isLiveWatchSession({ source: "file" })).toBe(false);
    expect(isLiveWatchSession({ source: "upload" })).toBe(false);
    expect(liveWatchMinutesForJob({ source: "file", liveWatchMinutes: 99 })).toBeNull();
    for (const source of ["rtmp", "webrtc", "screenshare", "browser", "file-sim"]) {
      expect(isLiveWatchSession({ source })).toBe(true);
    }
  });

  it("buckets a session by its START month in UTC", () => {
    expect(sessionMonthUtc({ startedAt: "2026-11-02T01:05:00.000Z", createdAt: "2026-10-31T23:00:00.000Z" })).toBe(
      "2026-11"
    );
    // No startedAt: fall back to the record's creation month.
    expect(sessionMonthUtc({ createdAt: "2026-10-31T23:00:00.000Z" })).toBe("2026-10");
    expect(sessionMonthUtc({})).toBeNull();
    expect(monthKeyUtc(Date.parse("2026-11-02T01:05:00.000Z"))).toBe("2026-11");
  });
});

describe("month-to-date aggregation (ADAAAA-7722 AC3)", () => {
  const jobs = [
    { id: "live-1", source: "file-sim", liveWatchMinutes: 5.25, startedAt: "2026-11-02T01:00:00.000Z" },
    { id: "live-2", source: "rtmp", liveWatchMinutes: 90, startedAt: "2026-11-02T02:00:00.000Z" },
    // Legacy live record measured through perceiveSessionS.
    { id: "live-legacy", source: "rtmp", perceiveSessionS: 120, startedAt: "2026-11-01T23:00:00.000Z" },
    // Unmeasured live record (no completion): reported, never counted as 0.
    { id: "live-unmeasured", source: "rtmp", startedAt: "2026-11-02T03:00:00.000Z" },
    // VOD job: compute time is not watch time.
    { id: "vod-1", source: "file", perceiveSessionS: 600, startedAt: "2026-11-02T04:00:00.000Z" },
    // Previous month: excluded from this month's total.
    { id: "live-oct", source: "rtmp", liveWatchMinutes: 1_000, startedAt: "2026-10-31T23:59:59.000Z" },
  ];

  it("sums only the measured live sessions in the requested UTC month", () => {
    const report = aggregateLiveWatchMinutes(jobs as any, "2026-11");
    expect(report.month).toBe("2026-11");
    expect(report.sessions).toBe(3);
    expect(report.liveWatchMinutes).toBeCloseTo(5.25 + 90 + 2, 3);
    expect(report.unmeasuredSessions).toBe(1);
    expect(report.perSession.map((s) => s.jobId)).toEqual(["live-legacy", "live-1", "live-2"]);
    // The VOD and the October session never appear.
    expect(report.perSession.some((s) => s.jobId === "vod-1" || s.jobId === "live-oct")).toBe(false);
  });

  it("is an honest zero for a month with no live sessions", () => {
    const report = aggregateLiveWatchMinutes(jobs as any, "2026-08");
    expect(report.liveWatchMinutes).toBe(0);
    expect(report.sessions).toBe(0);
  });
});

describe("GET /admin/live-watch-minutes (ADAAAA-7722 AC3)", () => {
  async function adminToken(app: any, cfg: any): Promise<string> {
    const r = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: cfg.adminEmail, password: cfg.adminPassword },
    });
    expect(r.statusCode).toBe(200);
    return r.json().token as string;
  }

  it("serves the month-to-date total and the per-session record", async () => {
    const { app, cfg, store } = await buildTestApp();
    const token = await adminToken(app, cfg);
    const headers = { authorization: `Bearer ${token}` };
    const month = monthKeyUtc();
    const startedAt = new Date().toISOString();

    const live = await store.createJob({ source: "file-sim" as any });
    await store.patchJob(live.id, { status: "done", startedAt, liveWatchMinutes: 7.5 });
    const vod = await store.createJob({ source: "file" });
    await store.patchJob(vod.id, { status: "done", startedAt, perceiveSessionS: 600 });

    // Per-session field on the session record itself.
    const one = await app.inject({ method: "GET", url: `/jobs/${live.id}`, headers });
    expect(one.statusCode).toBe(200);
    expect(one.json().job.liveWatchMinutes).toBe(7.5);

    const report = await app.inject({ method: "GET", url: `/admin/live-watch-minutes?month=${month}`, headers });
    expect(report.statusCode).toBe(200);
    const body = report.json();
    expect(body.month).toBe(month);
    expect(body.perSession.some((s: any) => s.jobId === live.id && s.minutes === 7.5)).toBe(true);
    expect(body.perSession.some((s: any) => s.jobId === vod.id)).toBe(false);
    expect(body.liveWatchMinutes).toBeGreaterThanOrEqual(7.5);

    const bad = await app.inject({ method: "GET", url: "/admin/live-watch-minutes?month=November", headers });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});
