import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HighlightRecord } from "@highlights/events";
import { Store } from "../src/store";
import { persistLiveHighlight } from "../src/api";
import { testCfg, buildTestApp } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("persistLiveHighlight — decision-time persistence (ADAAAA-5777)", () => {
  function rec(overrides: Partial<HighlightRecord> = {}): HighlightRecord {
    return {
      id: "h1",
      jobId: "j1",
      clipUri: "/clips/x.mp4",
      start: 1,
      end: 2,
      score: 90,
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("writes the highlight through to the store (ownerId + autoPublish status) and bills/debits exactly once", async () => {
    const store = new Store(null);
    let billed = 0;
    let debited = 0;
    const deps = {
      store,
      cfg: testCfg({ AUTO_PUBLISH_HIGHLIGHTS: "1" }),
      billing: { onHighlightCreated: async () => void billed++ } as any,
      entitlements: { onClipGenerated: async () => void debited++ } as any,
      db: { recordFunnelEvent: async () => {} } as any,
    };
    const out = await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec());
    expect(out.ownerId).toBe("u1");
    expect(out.status).toBe("accepted");
    expect(store.getHighlight("h1")?.ownerId).toBe("u1");
    expect(store.getHighlight("h1")?.status).toBe("accepted");
    expect(store.allHighlights().length).toBe(1);
    // Billing + quota exactly once per accepted highlight.
    expect(billed).toBe(1);
    expect(debited).toBe(1);
  });

  it("keeps generated clips pending when auto-publish is off (not surfaced in the accepted feed)", async () => {
    const store = new Store(null);
    const deps = {
      store,
      cfg: testCfg({ AUTO_PUBLISH_HIGHLIGHTS: "0" }),
      billing: { onHighlightCreated: async () => {} } as any,
      entitlements: { onClipGenerated: async () => {} } as any,
      db: { recordFunnelEvent: async () => {} } as any,
    };
    const out = await persistLiveHighlight(deps, { id: "u1" } as any, {} as any, rec());
    expect(out.status).toBe("pending");
    expect(store.acceptedHighlights().length).toBe(0);
  });
});

describe("live highlight feed streaming end-to-end (ADAAAA-5777)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-livefeed-"));
  const liveSrc = path.join(tmp, "live.mp4");

  beforeAll(() => {
    // A short video that ffmpeg will LOOP at real-time rate as a synthetic live
    // source (file-sim), so the live job keeps streaming until explicitly
    // stopped — this is what makes the "visible before session end" assertion
    // deterministic.
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=10",
      "-pix_fmt", "yuv420p", liveSrc,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("persists + publishes each accepted highlight at decision time — visible in feed BEFORE the live session is stopped", async () => {
    const { app } = await buildTestApp();
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "lf@test.dev", password: "password123" },
    });
    expect(reg.statusCode).toBe(200);
    const token = reg.json().token as string;

    // Start a file-sim live job (loops the local file; stays active until stop).
    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file-sim", videoPath: liveSrc, gameHint: "Esports" },
    });
    expect(jr.statusCode).toBe(200);
    expect(jr.json().status).toBe("ingesting");
    const jobId = jr.json().job.id;

    // The fake pipeline decides `isHighlight` on the first candidate frame, so
    // runLiveJob's onEvent `highlight` hook should persist it at once. Poll
    // /highlights for the highlight while the job is STILL active (not stopped)
    // — the pre-fix code only persisted after ingest.stop() at session end.
    let found = 0;
    let jobStatus = "active";
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const hl = (
        await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })
      ).json().highlights;
      if (hl.length) {
        found = hl.length;
        break;
      }
      const job = (
        await app.inject({ method: "GET", url: `/jobs/${jobId}`, headers: { authorization: `Bearer ${token}` } })
      ).json();
      jobStatus = job.job?.status ?? "active";
      if (jobStatus === "done" || jobStatus === "failed") break;
      await sleep(300);
    }
    expect(found).toBeGreaterThan(0);

    // The accepted highlight is ALSO surfaced on the public /feed immediately.
    const feed = (await app.inject({ method: "GET", url: "/feed" })).json().highlights;
    expect(feed.some((h: any) => h.status === "accepted")).toBe(true);

    // Stop the live session; the highlight must remain, exactly once (no
    // double-persist or double-bill from the removed post-stop loop).
    const st = await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(st.statusCode).toBe(200);
    await sleep(500);
    const after = (
      await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } })
    ).json().highlights;
    expect(after.length).toBe(1);

    await app.close();
  });
});
