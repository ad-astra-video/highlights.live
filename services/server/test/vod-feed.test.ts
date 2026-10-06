import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestApp } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(path.join(tmpdir(), "hl-vodfeed-"));
const videoPath = path.join(tmp, "vod.mp4");

beforeAll(() => {
  execFileSync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=320x180:rate=2",
    "-pix_fmt", "yuv420p", videoPath,
  ]);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function register(app: any, email: string, pw: string) {
  const r = await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: pw } });
  expect(r.statusCode).toBe(200);
  return r.json().token as string;
}

// A VOD "file" job runs synchronously through POST /jobs; the fake pipeline
// returns a candidate on the first /analyze and decides isHighlight=true, so
// exactly one highlight is produced per job.
describe("VOD decision-time publish + HTTP fallback (ADAAAA-6352)", () => {
  it("persists + bills + quota-debits each accepted highlight at decision time, and the HTTP full set is returned exactly once at the end", async () => {
    const { app, billing, store, db } = await buildTestApp();
    const token = await register(app, "vod@test.dev", "password123");

    // Spy on the billing service so we can assert the accepted highlight is
    // billed EXACTLY once (the old end-of-job batch loop is removed, so a
    // decision-time persist must be the only billing/debit site).
    let billed = 0;
    const origBilling = billing.onHighlightCreated.bind(billing);
    billing.onHighlightCreated = async (u: any, s: any) => {
      billed++;
      return origBilling(u, s);
    };

    const res = await app.inject({
      method: "POST",
      url: "/jobs",
      headers: { authorization: `Bearer ${token}` },
      payload: { videoPath, gameHint: "valorant" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.job.status).toBe("done");
    const userId = body.job.ownerId as string;

    // HTTP fallback: GET /jobs/:id returns the FULL highlight set once the job
    // finished (persisted at decision time, so it is present at end).
    const jobRes = await app.inject({
      method: "GET",
      url: `/jobs/${body.job.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(jobRes.statusCode).toBe(200);
    const jobHighlights = jobRes.json().highlights as any[];
    expect(jobHighlights.length).toBe(1);
    expect(jobHighlights[0].ownerId).toBe(userId);
    expect(jobHighlights[0].status).toBe("accepted");

    // /highlights (feed surface) shows exactly the one accepted highlight.
    const hl = (await app.inject({ method: "GET", url: "/highlights", headers: { authorization: `Bearer ${token}` } }))
      .json().highlights as any[];
    expect(hl.length).toBe(1);

    // The in-memory store holds exactly one highlight (no duplicate persist
    // from a leftover end-of-job loop would double the byJob list).
    expect(store.allHighlights().length).toBe(1);
    expect(store.highlightsForJob(body.job.id).length).toBe(1);

    // Billing + quota debit exactly once per accepted highlight — no
    // double-count between SSE stream and the final response.
    expect(billed).toBe(1);
    const period = new Date().toISOString().slice(0, 7);
    await sleep(50); // allow the fire-and-forget debit to settle
    expect(await db.getQuota(userId, period)).toBe(1);

    await app.close();
  });
});

// The SSE branch: a background (resumable upload) VOD job streams each accepted
// highlight over /jobs/:id/events as it is found, not only at job end. We open
// the SSE connection right after the job is dispatched and read a `highlight`
// event from the live stream.
describe("VOD SSE streaming (ADAAAA-6352)", () => {
  function chunkPart(file: Buffer, filename = "part.mp4") {
    const boundary = "----hlVodChunk" + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: video/mp4\r\n\r\n`,
      "utf8"
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
    return { payload: Buffer.concat([head, file, tail]), contentType: `multipart/form-data; boundary=${boundary}` };
  }

  it("emits a `highlight` SSE event before the VOD job finishes", async () => {
    const { app } = await buildTestApp({ VOD_CHUNK_BYTES: "4096" });
    const token = await register(app, "vod-sse@test.dev", "password123");
    const sent = readFileSync(videoPath);

    // init -> chunk -> complete (dispatches the pipeline in the background and
    // returns the job id immediately — the VOD path that supports concurrent
    // SSE during processing).
    const init = await app.inject({
      method: "POST",
      url: "/jobs/upload/init",
      headers: { authorization: `Bearer ${token}` },
      payload: { filename: "vod.mp4", size: sent.length, mime: "video/mp4", gameHint: "valorant" },
    });
    expect(init.statusCode).toBe(200);
    const { uploadId } = init.json();
    for (let s = 0; s < sent.length; s += 4096) {
      const { payload, contentType } = chunkPart(sent.subarray(s, s + 4096));
      const r = await app.inject({
        method: "POST",
        url: `/jobs/upload/${uploadId}/chunk`,
        headers: { authorization: `Bearer ${token}`, "content-type": contentType },
        payload,
      });
      expect(r.statusCode).toBe(200);
    }
    const done = await app.inject({
      method: "POST",
      url: "/jobs/upload/complete",
      headers: { authorization: `Bearer ${token}` },
      payload: { uploadId, size: sent.length },
    });
    expect(done.statusCode).toBe(200);
    const jobId = done.json().job.id as string;

    // Listen on a real port and read the SSE stream. The background job is
    // still running (extractFrames + analyze), so the highlight event is
    // delivered incrementally, not batched at end.
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address() as any;
    const base = `http://127.0.0.1:${addr.port}`;

    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), 15000);
    const events: { event: string; data: any }[] = [];
    let connClosed = false;
    try {
      const res = await fetch(`${base}/jobs/${jobId}/events`, {
        headers: { authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      expect(res.ok).toBe(true);
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: rd, value } = await reader.read();
        if (rd) {
          connClosed = true;
          break;
        }
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = "message";
          let data = "";
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          try {
            events.push({ event, data: JSON.parse(data) });
          } catch {
            /* malformed frame */
          }
        }
        if (events.some((e) => e.event === "highlight")) break;
      }
    } catch {
      /* aborted on timeout */
    } finally {
      clearTimeout(timeout);
      ac.abort();
      await app.close();
    }

    const highlights = events.filter((e) => e.event === "highlight");
    expect(highlights.length).toBeGreaterThanOrEqual(1);
    expect(highlights[0].data.highlight).toBeTruthy();
    expect(highlights[0].data.highlight.eventType).toBe("KILL");
    expect(highlights[0].data.highlight.status).toBe("pending"); // the rec as decided
  });
});
