// Thin fetch client. Base is relative -> same origin (dev: vite proxies to :3000).
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
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      body = await res.text();
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

// Multipart browser upload for the VOD "Upload / file" source. Uses
// XMLHttpRequest (not fetch) so upload progress is observable; rejects with an
// ApiError carrying `status` (e.g. 413 oversized, 415 non-video, 429/402) so
// the dashboard can surface a clear, non-silent message.
export function uploadVideo<T = any>({ file, gameHint, preferLabels, onProgress }: UploadVideoOptions): Promise<T> {
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
}
export interface Job {
  id: string;
  status: string;
  gameHint?: string;
  framesAnalyzed?: number;
}
