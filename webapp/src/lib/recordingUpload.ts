// Raw-binary upload for one MediaRecorder chunk (ADAAAA-8848 F3).
//
// The old hot path read each chunk into a base64 data URL (a full string copy),
// then JSON-encoded it (33% inflation) into an 8 MiB route: a burst chunk became
// a multi-MB JS string with a ~3x transient peak. The same bytes now travel as
// an `application/octet-stream` Blob body — no copy, no inflation — with the
// recorder's MIME in the query (and a mirror header for older proxies).

/** Header mirror of the chunk MIME. */
export const RECORDING_MIME_HEADER = "x-recording-mime";

/** URL the chunk is POSTed to. `mime` keys the recording file's extension on
 *  the server (`video/mp4` -> .mp4, everything else -> .webm). */
export function recordingChunkUrl(jobId: string, mime: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/recording?mime=${encodeURIComponent(mime)}`;
}

/** POST one chunk as raw bytes. The Blob is passed straight to `fetch` — the
 *  per-chunk transient is the chunk itself, not a base64/JSON copy of it. */
export async function postRecordingChunk(
  jobId: string,
  blob: Blob,
  mime: string,
  token: string | null,
): Promise<{ bytes: number }> {
  const headers: Record<string, string> = {
    "content-type": "application/octet-stream",
    [RECORDING_MIME_HEADER]: mime,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(recordingChunkUrl(jobId, mime), {
    method: "POST",
    headers,
    body: blob,
  });
  if (!res.ok) {
    // Read the body once (see api()): a response stream is consumed by the
    // first read, and a second read throws over the real error.
    const text = await res.text().catch(() => "");
    let message = `HTTP ${res.status}`;
    try {
      message = JSON.parse(text)?.error || message;
    } catch {
      /* non-JSON error body */
    }
    const err = new Error(message) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const body = (await res.json().catch(() => null)) as { bytes?: number } | null;
  return { bytes: body?.bytes ?? blob.size };
}
