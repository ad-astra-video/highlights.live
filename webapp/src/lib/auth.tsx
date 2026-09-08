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
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
  refreshBilling: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [token, setTok] = useState<string | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [ready, setReady] = useState(false);

  // On load, if we hold a token we optimistically believe it; refresh billing.
  useEffect(() => {
    if (getToken()) {
      setTok(getToken());
      api<BillingStatus>("/billing/status")
        .then(setBilling)
        .catch(() => {})
        .finally(() => setReady(true));
    } else {
      setReady(true);
    }
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
      async register(email, password) {
        const r = await api<{ token: string; user: SessionUser }>("/auth/register", { body: { email, password } });
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
