import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useNavigate, useLocation, Link } from "react-router-dom";
import { Zap, LayoutDashboard, CreditCard, Settings as SettingsIcon, LogOut, BrainCircuit, ShieldAlert, Menu, X } from "lucide-react";
import { isAdminRole, useAuth } from "../lib/auth";
import { DevBanner } from "./DevBanner";

const nav: { to: string; label: string; icon: any; end?: boolean; adminOnly?: boolean }[] = [
  { to: "/app", label: "Highlights", icon: LayoutDashboard, end: true },
  { to: "/app/train", label: "Fine Tune", icon: BrainCircuit },
  { to: "/app/billing", label: "Billing", icon: CreditCard },
  { to: "/app/settings", label: "Settings", icon: SettingsIcon },
  // ADAAAA-7727: operator-only entry. Hidden from the nav for a customer — the
  // route itself is guarded too (AdminRoute -> redirect to /app).
  { to: "/app/admin", label: "Admin", icon: ShieldAlert, adminOnly: true },
];

function Logo() {
  return (
    <Link to="/" className="flex items-center gap-2 text-xl font-extrabold text-neon glow-text">
      <Zap className="h-6 w-6" /> highlights<span className="text-pink">.live</span>
    </Link>
  );
}

function NavLinks({ items }: { items: typeof nav }) {
  return (
    <nav className="flex flex-col gap-2">
      {items.map((n) => (
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
  );
}

function Account({ email, planLabel, tier, onSignOut }: { email?: string; planLabel: string; tier?: string; onSignOut: () => void }) {
  return (
    <div className="mt-auto flex flex-col gap-3">
      <div className="card card-accent p-3 text-sm">
        <div className="truncate text-slate-ink">{email}</div>
        <div className="mt-1 flex items-center justify-between">
          <span className="text-xs text-mut">plan</span>
          <span className={`text-xs font-bold ${tier === "pro" ? "text-green" : "text-yellow"}`}>{planLabel}</span>
        </div>
      </div>
      <button onClick={onSignOut} className="btn-neon btn-ghost flex items-center justify-center gap-2">
        <LogOut className="h-4 w-4" /> Sign out
      </button>
    </div>
  );
}

/**
 * App shell.
 *
 * ADAAAA-7886: below `md` the 240 px sidebar is not rendered inline — a page at
 * 360 px would otherwise have ~56 px of content left after the sidebar plus
 * `main`'s `p-8`. The nav becomes a drawer opened from a labelled top-bar
 * toggle, closed by its own button, the backdrop, Escape, or a route change.
 * At `md` and above the markup and geometry are the pre-7886 layout: the same
 * `<aside>` sits inline and no top bar is rendered.
 */
export function Shell() {
  const { user, billing, logout } = useAuth();
  const navTo = useNavigate();
  const location = useLocation();
  const admin = isAdminRole(user?.role);
  const visibleNav = nav.filter((n) => !n.adminOnly || admin);

  const planLabel = billing?.tier === "pro" && billing.status === "active" ? "PRO" : "STARTER";
  const [navOpen, setNavOpen] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  // A tapped nav link must not leave the drawer covering the page it opened.
  useEffect(() => {
    setNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!navOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setNavOpen(false);
    };
    window.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const signOut = () => {
    logout();
    navTo("/");
  };

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Phone top bar: only below `md`. The desktop shell has no top bar. */}
      <header className="flex items-center gap-2 border-b border-purple/30 bg-dusk/70 px-4 py-2 md:hidden" data-shell-topbar>
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={navOpen}
          aria-controls="shell-nav"
          onClick={() => setNavOpen(true)}
          className="btn-neon btn-ghost flex items-center justify-center p-2"
          data-shell-nav-toggle
        >
          <Menu className="h-5 w-5" aria-hidden />
        </button>
        <Logo />
      </header>

      <aside
        className="hidden w-60 shrink-0 flex-col gap-6 border-r border-purple/30 bg-dusk/70 p-5 md:flex"
        data-shell-sidebar
      >
        <Logo />
        <NavLinks items={visibleNav} />
        <Account email={user?.email} planLabel={planLabel} tier={billing?.tier} onSignOut={signOut} />
      </aside>

      {navOpen && (
        <div className="fixed inset-0 z-40 md:hidden" data-shell-drawer>
          <div className="absolute inset-0 bg-void/80" onClick={() => setNavOpen(false)} data-shell-drawer-backdrop />
          <aside
            id="shell-nav"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="relative flex h-full w-60 max-w-full flex-col gap-6 overflow-y-auto border-r border-purple/30 bg-dusk p-5"
            data-shell-drawer-panel
          >
            <div className="flex items-start justify-between gap-2">
              <Logo />
              <button
                type="button"
                ref={closeRef}
                aria-label="Close navigation"
                onClick={() => setNavOpen(false)}
                className="btn-neon btn-ghost flex items-center justify-center p-2"
                data-shell-nav-close
              >
                <X className="h-5 w-5" aria-hidden />
              </button>
            </div>
            <NavLinks items={visibleNav} />
            <Account email={user?.email} planLabel={planLabel} tier={billing?.tier} onSignOut={signOut} />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1 overflow-y-auto p-8">
        <DevBanner />
        <Outlet />
      </main>
    </div>
  );
}
