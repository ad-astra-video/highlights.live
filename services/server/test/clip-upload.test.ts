import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { buildClipHighlightRecord } from "../src/api";
import { buildTestApp } from "./helpers";

// ADAAAA-6741 G4: the decide runner uploads a built clip for a job; the server
// persists it as an accepted highlight that appears on the public feed. This
// unit-tests the pure record-builder (no multipart needed) and adds an
// integration test against the real multipart route.

describe("buildClipHighlightRecord (ADAAAA-6741 G4)", () => {
  it("clamps score to [0,100]", () => {
    const jobId = randomUUID();
    const low = buildClipHighlightRecord(jobId, "a", { score: -50 });
    const high = buildClipHighlightRecord(jobId, "b", { score: 250 });
    const ok = buildClipHighlightRecord(jobId, "c", { score: 42 });
    expect(low.score).toBe(0);
    expect(high.score).toBe(100);
    expect(ok.score).toBe(42);
  });

  it("defaults numeric fields to 0 and event type/reason to empty when metadata is absent", () => {
    const rec = buildClipHighlightRecord("j1", "clip1", undefined);
    expect(rec.start).toBe(0);
    expect(rec.end).toBe(0);
    expect(rec.eventType).toBe("");
    expect(rec.reason).toBe("");
    expect(rec.score).toBe(0);
  });

  it("marks the record accepted and derives clipUri from the clip id", () => {
    const rec = buildClipHighlightRecord("j2", "clipXYZ", { eventType: "GOAL", score: 80 });
    expect(rec.status).toBe("accepted");
    expect(rec.clipUri).toBe("/clips/clipXYZ.mp4");
    expect(rec.jobId).toBe("j2");
    expect(rec.id).toBe("clipXYZ");
    expect(typeof rec.createdAt).toBe("string");
  });

  it("preserves supplied metadata values and coerces nearMiss to boolean", () => {
    const rec = buildClipHighlightRecord("j3", "clip3", {
      eventType: "DUNK",
      score: 91,
      reason: "poster",
      start: 2,
      end: 5,
      outcome: "big_play",
      nearMiss: true,
    });
    expect(rec.eventType).toBe("DUNK");
    expect(rec.reason).toBe("poster");
    expect(rec.start).toBe(2);
    expect(rec.end).toBe(5);
    expect(rec.outcome).toBe("big_play");
    expect(rec.nearMiss).toBe(true);
  });

  it("omits an empty/unclassified outcome instead of failing schema validation", () => {
    // The decide runner may send outcome:"" (or an unclassified value). `outcome`
    // is a closed enum on HighlightRecordSchema, so an invalid value must be
    // omitted (optional) rather than persisted / 500 the upload.
    const empty = buildClipHighlightRecord("j4", "clip4", { outcome: "" });
    expect(empty.outcome).toBeUndefined();
    const bad = buildClipHighlightRecord("j4", "clip5", { outcome: "whatever" });
    expect(bad.outcome).toBeUndefined();
  });
});

describe("POST /jobs/:id/clips (ADAAAA-6741 G4)", () => {
  let app: any;
  let store: any;
  let cfg: any;

  beforeAll(async () => {
    const built = await buildTestApp();
    app = built.app;
    store = built.store;
    cfg = built.cfg;
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  function multipartBody(metaJson: string, clipBytes: Buffer): { body: Buffer; boundary: string } {
    const boundary = "----hl-test-" + randomUUID();
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="metadata"\r\n\r\n` +
      `${metaJson}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="clip"; filename="clip.mp4"\r\n` +
      `Content-Type: video/mp4\r\n\r\n`;
    const tail = `\r\n--${boundary}--\r\n`;
    const body = Buffer.concat([Buffer.from(head, "utf8"), clipBytes, Buffer.from(tail, "utf8")]);
    return { body, boundary };
  }

  it("404s when the job does not exist", async () => {
    const { body, boundary } = multipartBody("{}", Buffer.from("x"));
    const res = await app.inject({
      method: "POST",
      url: "/jobs/nope/clips",
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(404);
  });

  it("400s when there is no clip file part", async () => {
    const job = await store.createJob({ source: "file" });
    const boundary = "----hl-test-" + randomUUID();
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{}\r\n--${boundary}--\r\n`,
      "utf8"
    );
    const res = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/clips`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("400s when metadata is not valid JSON", async () => {
    const job = await store.createJob({ source: "file" });
    const { body, boundary } = multipartBody("{not-json", Buffer.from("x"));
    const res = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/clips`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
  });

  it("persists an accepted highlight and writes the clip file", async () => {
    const job = await store.createJob({ source: "file" });
    const meta = JSON.stringify({ eventType: "GOAL", score: 95, start: 1, end: 4, reason: "golazo", nearMiss: false });
    const { body, boundary } = multipartBody(meta, Buffer.from("fake-mp4-bytes"));
    const res = await app.inject({
      method: "POST",
      url: `/jobs/${job.id}/clips`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: body,
    });
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.ok).toBe(true);
    expect(json.clipUri).toBe(json.id ? `/clips/${json.id}.mp4` : undefined);

    const rec = store.getHighlight(json.id);
    expect(rec).toBeDefined();
    expect(rec.jobId).toBe(job.id);
    expect(rec.status).toBe("accepted");
    expect(rec.score).toBe(95);
    expect(rec.eventType).toBe("GOAL");
    expect(rec.clipUri).toBe(`/clips/${json.id}.mp4`);

    // It must show up on the public feed.
    const feed = await app.inject({ method: "GET", url: "/feed" });
    expect(feed.statusCode).toBe(200);
    const ids = feed.json().highlights.map((h: any) => h.id);
    expect(ids).toContain(json.id);

    // And the clip file must exist at the served path.
    const fs = await import("node:fs");
    const filePath = `${cfg.dataDir}/clips/${json.id}.mp4`;
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
