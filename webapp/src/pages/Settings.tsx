import { useState } from "react";
import { Link } from "react-router-dom";
import { User, SlidersHorizontal, CreditCard, Sparkles, Mail } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useSettings } from "../lib/settings";

const REASONING_OPTIONS = [
  {
    value: "none",
    label: "Off (recommended)",
    blurb: "Fastest — every decision returns immediately with no trade-off for the vast majority of clips.",
  },
  {
    value: "low",
    label: "Low",
    blurb: "A short reasoning pass before the answer. Slightly slower; handy for quick double-checks.",
  },
  {
    value: "medium",
    label: "Medium",
    blurb: "Balanced. For genuinely ambiguous moments where a little extra thought helps classify the play.",
  },
  {
    value: "high",
    label: "High",
    blurb: "A deep reasoning pass. Makes each response take noticeably longer but can be the difference on hard, detailed requests (e.g. a questionable referee call).",
  },
];

function AccountTab() {
  const { user, billing } = useAuth();
  const isPro = billing?.tier === "pro" && billing.status === "active";
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card card-accent p-6">
        <div className="text-xs uppercase tracking-wide text-mut">Account</div>
        <div className="mt-3 flex items-center gap-3">
          <div className="grid h-12 w-12 place-items-center rounded-full border border-neon/40 bg-neon/10 text-neon">
            <User className="h-6 w-6" />
          </div>
          <div>
            <div className="flex items-center gap-2 text-lg font-bold">
              <Mail className="h-4 w-4 text-mut" /> {user?.email}
            </div>
            <div className="text-sm text-mut">Signed in as <span className="text-slate-ink">{user?.role}</span></div>
          </div>
        </div>
      </div>

      <div className="card card-accent mt-4 p-6">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs uppercase tracking-wide text-mut">Plan</div>
            <div className="mt-1 text-2xl font-black text-neon">{isPro ? "Pro" : "Starter"}</div>
          </div>
          <span className={`rounded-full border px-2 py-0.5 text-xs font-bold ${isPro ? "border-green/50 text-green" : "border-yellow/50 text-yellow"}`}>
            {billing?.status || "active"}
          </span>
        </div>
        <p className="mt-3 text-sm text-mut">
          {isPro
            ? `Pro includes ${billing?.freeHighlights ?? 25} highlights per period; overage is billed pay-as-you-go.`
            : `Starter includes ${billing?.freeHighlights ?? 3} one-time highlights; add a plan to keep going.`}
        </p>
        <Link to="/app/billing" className="btn-neon mt-4 inline-flex items-center gap-2">
          <CreditCard className="h-4 w-4" /> {isPro ? "Manage billing" : "View plans"}
        </Link>
      </div>
    </div>
  );
}

function SettingsTab() {
  const { reasoningEffort, setReasoningEffort } = useSettings();
  const current = REASONING_OPTIONS.find((o) => o.value === reasoningEffort) ?? REASONING_OPTIONS[0];
  return (
    <div className="mx-auto max-w-2xl">
      <div className="card card-accent p-6">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wide text-mut">
          <SlidersHorizontal className="h-4 w-4" /> Decider reasoning
        </div>
        <p className="mt-2 text-sm text-slate-ink">
          How much the highlight-decider model "thinks" before giving an answer. Turning it on makes each
          decision take a little longer and uses more compute — but can be worth it for more detailed,
          ambiguous requests where a quick answer risks a wrong call.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <select
            className="rounded-lg border border-neon/40 bg-black/60 px-3 py-2 text-sm text-white"
            value={reasoningEffort}
            onChange={(e) => setReasoningEffort(e.target.value)}
          >
            {REASONING_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <span className="rounded-full border border-neon/40 px-2 py-0.5 text-xs font-bold text-neon">{current.value}</span>
        </div>
        <div className="mt-3 rounded-lg border border-white/10 bg-white/5 px-4 py-3 text-sm text-slate-ink">{current.blurb}</div>
      </div>
    </div>
  );
}

export function Settings() {
  const [tab, setTab] = useState<"account" | "settings">("account");
  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="text-3xl font-black">Settings</h1>
      <p className="mt-1 text-mut">Account information and how highlights are decided.</p>

      <div className="mt-6 flex gap-2 border-b border-white/10">
        <button
          data-active={tab === "account"}
          onClick={() => setTab("account")}
          className="chip flex items-center gap-2"
        >
          <User className="h-4 w-4" /> Account
        </button>
        <button
          data-active={tab === "settings"}
          onClick={() => setTab("settings")}
          className="chip flex items-center gap-2"
        >
          <SlidersHorizontal className="h-4 w-4" /> Settings
        </button>
      </div>

      <div className="mt-6">
        {tab === "account" ? <AccountTab /> : <SettingsTab />}
      </div>
    </div>
  );
}
