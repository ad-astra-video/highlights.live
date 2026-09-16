// Thin fetch client. Base is relative -> same origin (dev: vite proxies to :3000).
const TOKEN_KEY = "hl_token";

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

// --- types ---
export interface BillingStatus {
  tier: string;
  status: string;
  usedHighlights: number;
  freeHighlights: number;
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
