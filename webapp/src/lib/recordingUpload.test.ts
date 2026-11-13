import { afterEach, describe, expect, it, vi } from "vitest";
import { RECORDING_MIME_HEADER, recordingChunkUrl, postRecordingChunk } from "./recordingUpload";

/** Count a Blob's bytes once (the mock uploader below keeps the body reference,
 *  so the test can prove the SAME blob travelled — no base64/JSON copy). */
function chunkOf(bytes: number): Blob {
  return new Blob([new Uint8Array(bytes)], { type: "video/webm;codecs=vp9,opus" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ADAAAA-8848 (F3): each chunk used to be read into a base64 data URL (a full
// string copy) and JSON-encoded (33% inflation) into an 8 MiB route, so a burst
// chunk became a multi-MB JS string with a ~3x transient peak. The chunk now
// travels as the raw Blob body.
describe("raw-binary recording chunk upload (ADAAAA-8848 F3)", () => {
  it("POSTs the chunk itself as an application/octet-stream body", async () => {
    const blob = chunkOf(4096);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true, bytes: blob.size }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await postRecordingChunk("job-1", blob, "video/webm;codecs=vp9,opus", "tok");

    expect(result.bytes).toBe(4096);
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    // Raw bytes, not a string: the transient for a chunk is the chunk.
    expect(init.body).toBe(blob);
    expect(typeof init.body).not.toBe("string");
    expect((init.body as Blob).size).toBe(blob.size);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/octet-stream");
    // MIME (which can contain a comma) rides the header and the query, so the
    // server never has to parse a base64 data URL to recover it.
    expect(headers[RECORDING_MIME_HEADER]).toBe("video/webm;codecs=vp9,opus");
    expect(headers.authorization).toBe("Bearer tok");
    expect(url).toBe(recordingChunkUrl("job-1", "video/webm;codecs=vp9,opus"));
    expect(url).toContain("mime=video%2Fwebm%3Bcodecs%3Dvp9%2Copus");
  });

  it("does not buffer a second copy for a large chunk", async () => {
    // 1 MB is the size a burst chunk reaches; assert the body identity, which is
    // what makes the per-chunk transient <= 1x chunk size.
    const blob = chunkOf(1024 * 1024);
    let body: unknown = null;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = init.body;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await postRecordingChunk("job-2", blob, "video/webm", null);
    expect(body).toBe(blob);
  });

  it("omits the authorization header when there is no token", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    await postRecordingChunk("job-3", chunkOf(8), "video/mp4", null);
    expect(headers.authorization).toBeUndefined();
  });

  it("throws a status-carrying error on a non-2xx (so the queue retries it)", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: "not a browser capture job" }), { status: 409 }));
    await expect(postRecordingChunk("job-4", chunkOf(8), "video/webm", "tok")).rejects.toMatchObject({
      message: "not a browser capture job",
      status: 409,
    });
  });
});
