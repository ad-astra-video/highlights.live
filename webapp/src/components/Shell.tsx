import { NavLink, Outlet, useNavigate, Link } from "react-router-dom";
import { Zap, LayoutDashboard, CreditCard, LogOut } from "lucide-react";
import { useAuth } from "../lib/auth";
import { DevBanner } from "./DevBanner";

const nav = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/billing", label: "Billing", icon: CreditCard },
];

export function Shell() {
  const { user, billing, logout } = useAuth();
  const navTo = useNavigate();

  const planLabel = billing?.tier === "pro" && billing.status === "active" ? "PRO" : "STARTER";

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col gap-6 border-r border-purple/30 bg-dusk/70 p-5">
        <Link to="/" className="flex items-center gap-2 text-xl font-extrabold text-neon glow-text">
          <Zap className="h-6 w-6" /> highlights<span className="text-pink">.live</span>
        </Link>

        <nav className="flex flex-col gap-2">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-xl border px-4 py-3 transition ${
                  isActive ? "border-neon/60 bg-neon/10 text-neon" : "border-white/10 text-slate-ink hover:border-white/30"
                }`
              }
            >
              <n.icon className="h-4 w-4" /> {n.label}
            </NavLink>
          ))}
        </nav>

        <div className="mt-auto flex flex-col gap-3">
          <div className="card card-accent p-3 text-sm">
            <div className="truncate text-slate-ink">{user?.email}</div>
            <div className="mt-1 flex items-center justify-between">
              <span className="text-xs text-mut">plan</span>
              <span className={`text-xs font-bold ${billing?.tier === "pro" ? "text-green" : "text-yellow"}`}>{planLabel}</span>
            </div>
          </div>
          <button
            onClick={() => {
              logout();
              navTo("/");
            }}
            className="btn-neon btn-ghost flex items-center justify-center gap-2"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto p-8">
        <DevBanner />
        <Outlet />
      </main>
    </div>
  );
}
