import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Sparkles, Wrench, RotateCcw, Check } from "lucide-react";
import { api, type Plan, type BillingStatus } from "../lib/api";
import { useAuth } from "../lib/auth";

export function Billing() {
  const { billing, refreshBilling } = useAuth();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [params, setParams] = useSearchParams();
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ plans: Plan[] }>("/billing/plans").then((r) => setPlans(r.plans)).catch(() => {});
  }, []);

  // Dev wireframe: "checkout completed" returned us here — simulate the webhook.
  useEffect(() => {
    if (params.get("wireframe") === "checkout=success") {
      setMsg("✓ Subscribed (wireframe) — welcome to Pro!");
      api("/dev/billing/activate", { body: {} }).then(refreshBilling).catch(() => {});
      setParams({}, { replace: true });
    }
  }, [params, refreshBilling, setParams]);

  const isPro = billing?.tier === "pro" && billing.status === "active";
  const used = billing?.usedHighlights ?? 0;
  const cap = billing?.freeHighlights ?? 0;
  const included = 25;
  const pct = isPro ? Math.min(100, Math.round((used / included) * 100)) : Math.min(100, Math.round((used / cap) * 100));

  async function subscribe() {
    setBusy(true);
    try {
      const r = await api<{ url: string }>("/billing/checkout", { body: { returnPath: "/app/billing" } });
      window.location.href = r.url; // wireframe: local URL w/ ?wireframe=checkout=success
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function manage() {
    const r = await api<{ url: string }>("/billing/portal", { body: { returnPath: "/app/billing" } });
    window.location.href = r.url;
  }

  async function wire(act: "activate" | "deactivate" | "reset") {
    await api(`/dev/billing/${act === "activate" ? "activate" : act === "deactivate" ? "deactivate" : "reset-usage"}`, { body: {} });
    setMsg(act === "activate" ? "Activated Pro (wireframe)" : act === "deactivate" ? "Canceled (wireframe)" : "Usage reset (wireframe)");
    await refreshBilling();
  }

  const currentTier = isPro ? plans.find((p) => p.id === "pro") : plans.find((p) => p.id === "free");

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-black">Billing &amp; plans</h1>
      <p className="mt-1 text-mut">Start free, subscribe to Pro, pay as you go for overage.</p>
      {msg && <div className="mt-4 rounded-xl border border-green/40 bg-green/10 px-4 py-2 text-sm text-green">{msg}</div>}

      {/* current plan meter */}
      <div className="card card-accent mt-6 grid gap-6 p-6 sm:grid-cols-2">
        <div>
          <div className="text-xs uppercase tracking-wide text-mut">Current plan</div>
          <div className="mt-1 flex items-center gap-3">
            <span className="text-3xl font-black text-neon glow-text">{currentTier?.name || (isPro ? "Pro" : "Starter")}</span>
            {isPro && (
              <span className="rounded-full border border-green/50 px-2 py-0.5 text-xs font-bold text-green">
                <Check className="mr-1 inline h-3 w-3" />
                active
              </span>
            )}
          </div>
          <div className="mt-3">
            <div className="flex justify-between text-xs text-mut">
              <span>
                {isPro ? "This period" : "Lifetime allowance"} · {used} / {isPro ? included : cap} highlights
              </span>
              <span>{Math.round((isPro ? used / Math.max(included, 1) : used / Math.max(cap, 1)) * 100)}%</span>
            </div>
            <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full rounded-full ${isPro ? "bg-green shadow-[0_0_10px_rgba(57,255,20,0.6)]" : "bg-yellow shadow-[0_0_10px_rgba(255,255,0,0.6)]"}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        </div>
        <div className="flex flex-col justify-center gap-3">
          {isPro ? (
            <button className="btn-neon btn-purple" onClick={manage} disabled={busy}>
              Manage subscription
            </button>
          ) : (
            <button className="btn-neon" onClick={subscribe} disabled={busy}>
              <Sparkles className="mr-2 inline h-4 w-4" /> Subscribe to Pro
            </button>
          )}
          <p className="text-xs text-mut">Pro includes 25 highlights/mo; overage billed pay-as-you-go. Cancel anytime.</p>
        </div>
      </div>

      {/* plan cards */}
      <div className="mt-6 grid gap-5 sm:grid-cols-2">
        {plans.map((p) => {
          const selected = (isPro && p.id === "pro") || (!isPro && p.id === "free");
          return (
            <div key={p.id} className={`card card-hover p-6 ${p.id === "pro" ? "card-accent" : ""}`}>
              <div className="flex items-center justify-between">
                <span className="text-lg font-black">{p.name}</span>
                {selected && <span className="text-xs uppercase text-green">current</span>}
              </div>
              <div className="mt-3 text-4xl font-black">
                ${(p.amount / 100).toFixed(0)}
                <span className="text-sm font-normal text-mut">/mo</span>
              </div>
              <ul className="mt-4 space-y-2 text-sm text-slate-ink">
                <li>• {p.includedHighlights} included highlight{p.includedHighlights === 1 ? "" : "s"} {p.id === "free" ? "(lifetime)" : "/month"}</li>
                <li>• {p.id === "free" ? "Pay-as-you-go blocked after allowance" : "Pay-as-you-go overage metered"}</li>
              </ul>
              {p.id === "free" || (
                <button className="btn-neon btn-pink mt-5 w-full" onClick={subscribe} disabled={busy}>
                  {isPro ? "Switch" : "Get Pro"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* dev wireframe controls */}
      <div className="mt-8 rounded-2xl border border-pink/40 bg-pink/5 p-5">
        <div className="flex items-center gap-2 font-bold text-pink">
          <Wrench className="h-4 w-4" /> Wireframe console <span className="text-xs font-normal">(dev only — simulates Stripe)</span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-neon" onClick={() => wire("activate")}>
            Simulate subscribe (Pro)
          </button>
          <button className="btn-neon btn-pink" onClick={() => wire("deactivate")}>
            Simulate cancel
          </button>
          <button className="btn-neon btn-purple" onClick={() => wire("reset")}>
            <RotateCcw className="mr-1 inline h-4 w-4" /> Reset usage
          </button>
        </div>
      </div>
    </div>
  );
}
