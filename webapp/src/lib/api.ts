// Thin fetch client. Base is relative -> same origin (dev: vite proxies to :3000).
import { chunkRanges, VOD_SINGLE_SHOT_MAX } from "./vodUpload";

const TOKEN_KEY = "hl_token";

// Client-side mirror of the server's VOD_MAX_UPLOAD_BYTES (default 2 GB). The
// dashboard refreshes this from GET /config so a server-side override stays in
// sync; this constant is the pre-flight fallback used before that resolves.
export const VOD_MAX_UPLOAD_BYTES = 2147483648; // 2 GB

export function getToken(): string | null {
  return typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

export interface ApiError extends Error {
  status: number;
  body: any;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const token = opts.auth !== false ? getToken() : null;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    // Read the body exactly ONCE. A Response stream is consumed by the first
    // read (json()/text()/…); calling a second read throws
    // "Failed to execute 'text' on 'Response': body stream already read", which
    // would mask the real error (e.g. a Cloudflare HTML 5xx). Read text then
    // parse, so JSON error bodies still surface their `error` message.
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    // A 401 on a call that actually carried a token means the session is stale
    // or revoked. Clear it and send the user back to sign-in instead of
    // letting half the app render with a dead session. (Login/register call
    // with no token yet, so a failed credential attempt never redirects here.)
    if (res.status === 401 && token) {
      setToken(null);
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
        window.location.assign("/auth");
      }
    }
    const err = new Error(body?.error || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface UploadVideoOptions {
  file: File;
  gameHint: string;
  preferLabels?: string[];
  onProgress?: (fraction: number) => void;
}

/** Build an ApiError from a failed fetch Response, redirecting to sign-in on a
 * stale 401 (mirrors the inline handling in `api()`). */
async function httpError(res: Response, token: string | null): Promise<ApiError> {
  // Read the body once (see api()); a second read throws "body stream already
  // read" and would mask the real non-JSON error (e.g. a Cloudflare HTML page).
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  if (res.status === 401 && token) {
    setToken(null);
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
      window.location.assign("/auth");
    }
  }
  const err = new Error(body?.error || `HTTP ${res.status}`) as ApiError;
  err.status = res.status;
  err.body = body;
  return err;
}

// Multipart browser upload for the VOD "Upload / file" source. Uses
// XMLHttpRequest (not fetch) so upload progress is observable; rejects with an
// ApiError carrying `status` (e.g. 413 oversized, 415 non-video, 429/402) so
// the dashboard can surface a clear, non-silent message.
//
// ADAAAA-5714: the deployed app sits behind a Cloudflare tunnel that caps each
// proxied request body at ~100 MB, so a single upload larger than
// VOD_SINGLE_SHOT_MAX is sliced into chunks and reassembled server-side via the
// /jobs/upload/{init,chunk,complete} rail. Smaller files keep the one-request
// multipart path unchanged.
export function uploadVideo<T = any>({ file, gameHint, preferLabels, onProgress }: UploadVideoOptions): Promise<T> {
  if (file.size > VOD_SINGLE_SHOT_MAX) {
    return uploadVideoChunked<T>({ file, gameHint, preferLabels, onProgress });
  }
  return uploadVideoSingle<T>({ file, gameHint, preferLabels, onProgress });
}

function uploadVideoSingle<T = any>({ file, gameHint, preferLabels, onProgress }: UploadVideoOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/jobs/upload");
    const token = getToken();
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body as T);
        return;
      }
      // A 401 on a token-carrying call means a stale/revoked session.
      if (xhr.status === 401 && token) {
        setToken(null);
        if (typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
          window.location.assign("/auth");
        }
      }
      const err = new Error(body?.error || `HTTP ${xhr.status}`) as ApiError;
      err.status = xhr.status;
      err.body = body;
      reject(err);
    };
    xhr.onerror = () => {
      const err = new Error("Upload failed — check your connection and try again.") as ApiError;
      err.status = 0;
      reject(err);
    };
    xhr.ontimeout = () => {
      const err = new Error("Upload timed out — try again or paste a download URL instead.") as ApiError;
      err.status = 0;
      reject(err);
    };
    const fd = new FormData();
    fd.append("file", file, file.name);
    fd.append("gameHint", gameHint);
    if (preferLabels && preferLabels.length > 0) fd.append("preferLabels", JSON.stringify(preferLabels));
    xhr.send(fd);
  });
}

/** Upload a file in <chunkBytes parts (each well under the Cloudflare ~100 MB
 * edge cap) via the resumable /jobs/upload rail. Returns the same { job, … }
 * shape as the single-shot upload once the server has reassembled + run it. */
async function uploadVideoChunked<T = any>({ file, gameHint, preferLabels, onProgress }: UploadVideoOptions): Promise<T> {
  const token = getToken();
  const jsonHeaders: Record<string, string> = { "content-type": "application/json" };
  if (token) jsonHeaders["authorization"] = `Bearer ${token}`;

  const initRes = await fetch("/jobs/upload/init", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ filename: file.name, size: file.size, mime: file.type, gameHint, preferLabels }),
  });
  if (!initRes.ok) throw await httpError(initRes, token);
  const init: { uploadId: string; chunkBytes: number } = await initRes.json();

  const chunkBytes = init.chunkBytes && init.chunkBytes > 0 ? init.chunkBytes : file.size;
  const ranges = chunkRanges(file.size, chunkBytes);
  for (const { start, end } of ranges) {
    const sent = await postChunk(init.uploadId, file.slice(start, end), file.name, token);
    if (onProgress) onProgress(Math.min(1, (sent ?? end) / file.size));
  }

  const compRes = await fetch("/jobs/upload/complete", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ uploadId: init.uploadId, size: file.size }),
  });
  if (!compRes.ok) throw await httpError(compRes, token);
  // The server finalizes the file + creates the job and returns immediately
  // (running the analyze pipeline synchronously would outlast the edge request
  // timeout on a long VOD). Poll GET /jobs/:id to a terminal state so the
  // caller still gets the fully-processed job — same contract as single-shot.
  const submitted = (await compRes.json()) as any;
  const st = submitted?.job?.status;
  if (st === "done" || st === "failed" || st === "cancelled") return submitted as T;
  return (await pollJob<T>(submitted?.job?.id, token)) as T;
}

/** Poll a job until it reaches a terminal state. Timing out (rather than the
 * request blocking server-side) keeps the upload from tripping the edge
 * request timeout; a long VOD processes in the background and we return once
 * it's done, or throw a clear error if it failed. */
async function pollJob<T = any>(jobId: string, token: string | null): Promise<T> {
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const startedAt = Date.now();
  const timeoutMs = 45 * 60 * 1000; // same ballpark as the single-shot pipeline
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`/jobs/${jobId}`, { headers });
    if (!res.ok) throw await httpError(res, token);
    const data = (await res.json()) as any;
    const st = data?.job?.status;
    if (st === "done") return data as T;
    if (st === "failed") {
      const err = new Error("Upload finished but the video couldn't be analyzed — try again or paste a download URL instead.") as ApiError;
      err.status = 0;
      throw err;
    }
    if (st === "cancelled") {
      const err = new Error("Upload was cancelled.") as ApiError;
      err.status = 0;
      throw err;
    }
    // still active/queued -> keep polling
  }
  const err = new Error("Upload is still processing — check your highlights shortly.") as ApiError;
  err.status = 0;
  throw err;
}

/** POST one blob as a multipart `file` part to the session append endpoint; the
 * server replies with the cumulative bytes received. XHR (not fetch) so each
 * part's upload progress is observable and the request is streamed. */
function postChunk(uploadId: string, blob: Blob, name: string, token: string | null): Promise<number | undefined> {
  return new Promise<number | undefined>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/jobs/upload/${uploadId}/chunk`);
    if (token) xhr.setRequestHeader("authorization", `Bearer ${token}`);
    xhr.onload = () => {
      let body: any = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error body */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(body?.received);
        return;
      }
      if (xhr.status === 401 && token) {
        setToken(null);
        if (typeof window !== "undefined" && !window.location.pathname.startsWith("/auth")) {
          window.location.assign("/auth");
        }
      }
      const err = new Error(body?.error || `HTTP ${xhr.status}`) as ApiError;
      err.status = xhr.status;
      err.body = body;
      reject(err);
    };
    xhr.onerror = () => {
      const err = new Error("Upload failed — check your connection and try again.") as ApiError;
      err.status = 0;
      reject(err);
    };
    xhr.ontimeout = () => {
      const err = new Error("Upload timed out — try again or paste a download URL instead.") as ApiError;
      err.status = 0;
      reject(err);
    };
    const fd = new FormData();
    fd.append("file", blob, name);
    xhr.send(fd);
  });
}

// Download a run's LoRA artifact (ADAAAA-5323) over an authenticated fetch so
// the token stays in the Authorization header (never a query string), then
// verify the SHA-256 end-to-end on the client against the X-Checksum-Sha256 the
// server recorded at emit time — a user downloads exactly the bytes the runner
// produced, or the download fails loudly. Throws an ApiError on failure.
export async function downloadTrainArtifact(runId: string, filename: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`/train/${runId}/artifact`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* binary/empty */
    }
    if (res.status === 401 && token) setToken(null);
    const err = new Error(body?.error || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const expected = res.headers.get("X-Checksum-Sha256");
  const blob = await res.blob();
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected && hex !== expected) {
    throw new Error("Artifact checksum mismatch — download aborted.");
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || `lora-${runId}.safetensors`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return hex;
}

// Download a persisted dataset as a zip (ADAAAA-5397, Change 5) over an
// authenticated fetch so the token stays in the Authorization header. Saves it
// as <dataset id>.zip via a same-app object URL. Throws an ApiError on failure
// (403 plan gate, 404 none, 409 incomplete) so the UI can surface the reason.
export async function downloadDatasetZip(datasetId: string): Promise<void> {
  const token = getToken();
  const res = await fetch(`/training/dataset.zip?id=${encodeURIComponent(datasetId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* binary/empty */
    }
    if (res.status === 401 && token) setToken(null);
    const err = new Error(body?.error || `HTTP ${res.status}`) as ApiError;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dataset-${datasetId}.zip`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Human-readable size for the oversized-file message, e.g. "2 GB".
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  // Round cleanly when the value is a whole number (e.g. 2 GB, 5 MB), else one
  // decimal (1.5 MB).
  const rounded = Math.round(v);
  const str = v >= 10 || i === 0 || v === rounded ? String(rounded) : v.toFixed(1);
  return `${str} ${units[i]}`;
}

// --- types ---
export interface BillingStatus {
  tier: string;
  status: string;
  usedHighlights: number;
  freeHighlights: number;
  // Per-user per-calendar-month clip quota (entitlement ledger), surfaced so the
  // dashboard can show remaining quota without a submission.
  clipQuotaPeriod: string;
  clipQuotaLimit: number;
  clipQuotaUsed: number;
  clipQuotaRemaining: number;
}
export interface Plan {
  id: string;
  name: string;
  description: string;
  currency: string;
  amount: number; // cents
  includedHighlights: number;
}
export interface Highlight {
  id: string;
  clipUri: string;
  eventType?: string;
  score: number;
  reason?: string;
  status: string;
  start: number;
  end: number;
  createdAt: string;
  // When the clip entered `rejected` (soft-delete undo-grace start). Set on
  // reject, cleared on reject->accept; only rejected clips with a rejectedAt
  // aged >= the server's rejection TTL are ever hard-deleted. Exposed by the
  // backend (ADAAAA-5168) so the UI can show a recovery deadline.
  rejectedAt?: string;
}
export interface Job {
  id: string;
  status: string;
  gameHint?: string;
  framesAnalyzed?: number;
}
