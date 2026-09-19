import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, getToken, setToken, type BillingStatus } from "./api";

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

interface AuthCtx {
  user: SessionUser | null;
  token: string | null;
  billing: BillingStatus | null;
  ready: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, inviteCode?: string) => Promise<void>;
  logout: () => void;
  refreshBilling: () => Promise<void>;
  /**
   * Start a password reset. Always resolves with `{ ok: true }` (no account
   * enumeration). The reset link is delivered by email (the email-sender
   * container), so no token is ever returned inline.
   */
  requestPasswordReset: (email: string) => Promise<{ ok: boolean }>;
  /** Redeem a reset token (from the emailed /reset link) with a new password. */
  resetPassword: (token: string, password: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setTok] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [ready, setReady] = useState(false);

  // On load, validate the stored token and hydrate the user. A 401 from
  // /auth/me clears the dead token (and the shared api client redirects to
  // /auth); otherwise we restore the session and refresh billing.
  useEffect(() => {
    const t = getToken();
    if (!t) {
      setReady(true);
      return;
    }
    setTok(t);
    Promise.allSettled([
      api<{ user: SessionUser }>("/auth/me").then((r) => {
        if (r?.user) setUser(r.user);
      }),
      api<BillingStatus>("/billing/status").then(setBilling),
    ]).finally(() => setReady(true));
  }, []);

  const refreshBilling = async () => {
    const b = await api<BillingStatus>("/billing/status");
    setBilling(b);
  };

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      token,
      billing,
      ready,
      async login(email, password) {
        const r = await api<{ token: string; user: SessionUser }>("/auth/login", { body: { email, password } });
        setToken(r.token);
        setTok(r.token);
        setUser(r.user);
        await refreshBilling().catch(() => {});
      },
      async register(email, password, inviteCode) {
        const r = await api<{ token: string; user: SessionUser }>("/auth/register", {
          body: inviteCode ? { email, password, inviteCode } : { email, password },
        });
        setToken(r.token);
        setTok(r.token);
        setUser(r.user);
        await refreshBilling().catch(() => {});
      },
      logout() {
        setToken(null);
        setTok(null);
        setUser(null);
        setBilling(null);
      },
      refreshBilling,
      requestPasswordReset: (email) => api<{ ok: boolean }>("/auth/forgot", { body: { email } }),
      resetPassword: (token, password) =>
        api<{ ok: boolean }>("/auth/reset", { body: { token, password } }).then(() => undefined),
    }),
    [user, token, billing, ready]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth outside <AuthProvider>");
  return ctx;
}
