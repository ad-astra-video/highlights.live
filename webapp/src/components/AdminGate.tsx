import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { isAdminRole, useAuth } from "../lib/auth";

// ADAAAA-7727 (Inc 1 of ADAAAA-7726): the /app/admin route is an operator-only
// skeleton. A non-admin session that navigates to it is redirected to /app —
// the route itself must never render internal diagnostics to a customer, so the
// guard is structural (a route element) rather than a nav-only hide.
//
// `AdminGate` takes the role as a prop so the redirect is SSR-testable without a
// live auth context; `AdminRoute` is the thin context wrapper the router uses.
export function AdminGate({ role, children }: { role?: string | null; children: ReactNode }) {
  if (!isAdminRole(role)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export function AdminRoute({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  return <AdminGate role={user?.role}>{children}</AdminGate>;
}
