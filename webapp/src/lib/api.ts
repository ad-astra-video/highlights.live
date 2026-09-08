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
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.auth !== false) {
    const t = getToken();
    if (t) headers["authorization"] = `Bearer ${t}`;
  }
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
