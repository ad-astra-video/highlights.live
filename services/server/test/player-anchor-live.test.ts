import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp, fakePipeline } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ADAAAA-7847: on a LIVE rail the jersey-identify anchor sample must come from
// the full-resolution SESSION RECORDING (the live edge), never from
// `job.sourceUrl` — on an rtmp job that is the ingest URL and re-opening it
// would pull the stream a second time just to read one frame.
describe("live-rail jersey anchor sample (ADAAAA-7847)", () => {
  const tmp = mkdtempSync(path.join(tmpdir(), "hl-anchor-live-"));
  const liveSrc = path.join(tmp, "live.mp4");

  beforeAll(() => {
    execFileSync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=320x180:rate=10",
      "-pix_fmt", "yuv420p", liveSrc,
    ]);
  });
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("forwards a request-time anchor for a live job (local ingest file preferred over the re-encode)", async () => {
    const calls: any[] = [];
    const adapter: any = fakePipeline();
    adapter.controlForward = async (_sid: string, c: any) => {
      calls.push(c);
      return { type: "ack", ok: true, cmd: c.type, number: 11, slot: 1, trackId: "t", selected: true, bbox: [0.3, 0.3, 0.5, 0.6] };
    };
    const { app, cfg } = await buildTestApp({}, { adapter });
    const reg = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "anchorlive@test.dev", password: "password123" },
    });
    const token = reg.json().token as string;

    const jr = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { source: "file-sim", videoPath: liveSrc, gameHint: "soccer" },
    });
    expect(jr.statusCode).toBe(200);
    const jobId = jr.json().job.id as string;

    // The live ingest writes its full-resolution recording; the anchor sample
    // reads its tail. Wait for the recording to exist and hold frames.
    const sessionPath = path.join(cfg.dataDir, "live", jobId, "session.ts");
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (existsSync(sessionPath)) break;
      await sleep(200);
    }
    expect(existsSync(sessionPath)).toBe(true);
    await sleep(1200); // let the recording reach the live edge

    let body: any = null;
    const ctlDeadline = Date.now() + 20000;
    while (Date.now() < ctlDeadline) {
      const res = await app.inject({
        method: "POST",
        url: `/jobs/${jobId}/control`,
        headers: { authorization: `Bearer ${token}` },
        payload: { type: "track-player", args: { number: 11 } },
      });
      body = res.json();
      if (!String(body?.error ?? "").includes("no live perceive session")) break;
      await sleep(300);
    }

    expect(body.ok).toBe(true);
    expect(body.anchor).toBeTruthy();
    // Live edge: no VOD seek time; a LOCAL file-sim source is cleaner than the
    // recording, so the anchor is decoded from the ingest file.
    expect(body.anchor.origin).toBe("ingest-source");
    expect(body.anchor.atSec).toBeNull();
    expect(body.anchor.frames).toBeGreaterThan(0);
    // 320x180 fixture -> the default 1280:720 anchor scale is clamped, not upscaled.
    expect(body.anchor.scale).toBe("min(1280\\,iw):-2");

    // The frames rode along on the forward, and the forward never re-pulled the
    // ingest path (the recording is what was decoded).
    expect(calls).toHaveLength(1);
    expect(calls[0].anchorImages.length).toBe(body.anchor.frames);
    expect(calls[0].anchorOrigin).toBe("ingest-source");

    await app.inject({
      method: "POST",
      url: `/jobs/${jobId}/stop`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    await app.close();
  }, 40000);
});
