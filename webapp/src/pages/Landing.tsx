import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Zap, Radio, Film, Clapperboard, ArrowRight, Check, Loader2 } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api } from "../lib/api";

// Public-beta landing page. Non-invited visitors see marketing copy + the
// waitlist capture only — never the product surface. Invited (logged-in)
// visitors get a link into the console.
//
// Copy per the public-beta spec (ADAAAA-24 plan §3–§5): headline ladder,
// how-it-works (3 steps), live-vs-VOD toggle, pricing block, trust placeholder,
// and a footer with ops links + the data-retention note for uploaded video.

export function Landing() {
  const { token } = useAuth();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const value = email.trim();
    if (!value) {
      setStatus("error");
      setError("Enter your email to join the beta.");
      return;
    }
    setStatus("submitting");
    setError(null);
    try {
      // No auth: waitlist capture is open to any visitor. The server dedupes by
      // email (normalized lowercase), so re-submitting is idempotent — the same
      // confirmation is shown either way, per spec §6.
      await api("/waitlist", { auth: false, body: { email: value } });
      setStatus("done");
    } catch (err: any) {
      setStatus("error");
      setError(err?.body?.error || err?.message || "Something went wrong. Try again.");
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Top bar */}
      <header className="mb-16 flex items-center justify-between">
        <div className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <Zap className="h-6 w-6 text-neon" />
          <span>
            highlights<span className="text-neon glow-text">.live</span>
          </span>
        </div>
        {token ? (
          <Link to="/app" className="btn-fill inline-flex items-center gap-1 text-sm">
            Open the console <ArrowRight className="h-4 w-4" />
          </Link>
        ) : (
          <Link to="/auth" className="text-sm text-slate-ink hover:text-ink">
            Sign in
          </Link>
        )}
      </header>

      {/* Hero */}
      <section className="text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neon/50 px-4 py-1.5 text-sm text-neon">
          <Zap className="h-4 w-4" /> AI highlight extraction for sports &amp; esports
        </div>
        <h1 className="mx-auto max-w-3xl text-4xl font-black leading-tight tracking-tight sm:text-6xl">
          AI highlight clips from your sports &amp; esports streams —{" "}
          <span className="text-neon glow-text">live within seconds.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-ink">
          Tell us where to watch. We find every moment worth clipping, live or from VOD — no more
          manual re-watch.
        </p>

        {/* Primary CTA: waitlist capture (single CTA = "Join the beta") */}
        <div className="mx-auto mt-8 max-w-xl">
          {token ? (
            <Link to="/app" className="btn-fill inline-flex items-center gap-2 text-lg">
              Open the console <ArrowRight className="h-5 w-5" />
            </Link>
          ) : status === "done" ? (
            <div className="rounded-xl border border-green/50 bg-green/10 px-6 py-5 text-green">
              <div className="flex items-center justify-center gap-2 font-bold">
                <Check className="h-5 w-5" /> You're on the list. We'll email your invite.
              </div>
              <p className="mt-1 text-sm text-ink/80">
                No card required during beta. We'll reach out when your invite is ready.
              </p>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                aria-label="Email address"
                className="input-neon flex-1"
                disabled={status === "submitting"}
              />
              <button type="submit" className="btn-fill inline-flex items-center justify-center gap-2 text-base" disabled={status === "submitting"}>
                {status === "submitting" ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" /> Joining…
                  </>
                ) : (
                  <>
                    Join the beta <ArrowRight className="h-5 w-5" />
                  </>
                )}
              </button>
            </form>
          )}
          {status === "error" && error && (
            <p className="mt-3 text-sm text-red" role="alert">
              {error}
            </p>
          )}
          {status !== "done" && !token && (
            <p className="mt-3 text-xs text-mut">Join the waitlist — free during beta.</p>
          )}
        </div>
      </section>

      {/* How it works (3 steps) */}
      <section className="mt-24">
        <h2 className="text-center text-2xl font-black sm:text-3xl">How it works</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <Step n={1} icon={Film} title="Connect or upload a stream" sub="VOD file, screen share, RTMP or WebRTC — point us at where to watch." />
          <Step n={2} icon={Radio} title="We detect the moments" sub="Audio-change + video analysis find the kills, goals and clutches worth clipping." />
          <Step n={3} icon={Clapperboard} title="Clips land in your feed" sub="Cut and ready to share — live in seconds, deep detail from full VODs." />
        </div>
      </section>

      {/* Live vs VOD */}
      <section className="mt-24">
        <h2 className="text-center text-2xl font-black sm:text-3xl">Live or VOD — your moments, your way</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-2">
          <div className="card card-accent p-6">
            <div className="flex items-center gap-2 text-xl font-bold text-neon">
              <Radio className="h-5 w-5" /> Live
            </div>
            <p className="mt-3 text-slate-ink">The moment, clipped in 1–5 s — while it's still happening.</p>
          </div>
          <div className="card card-accent p-6">
            <div className="flex items-center gap-2 text-xl font-bold text-pink">
              <Film className="h-5 w-5" /> VOD
            </div>
            <p className="mt-3 text-slate-ink">Deep detail across the whole game — no manual re-watch.</p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section className="mt-24">
        <h2 className="text-center text-2xl font-black sm:text-3xl">Beta pricing</h2>
        <p className="mt-2 text-center text-slate-ink">No card required during beta.</p>
        <div className="mx-auto mt-8 grid max-w-3xl gap-5 sm:grid-cols-2">
          <div className="card p-6">
            <div className="text-sm font-bold tracking-wide text-neon">FREE (BETA)</div>
            <div className="mt-2 text-3xl font-black">$0</div>
            <ul className="mt-4 space-y-2 text-sm text-slate-ink">
              <li><Check className="mr-2 inline h-4 w-4 text-green" />10 highlight clips / month</li>
              <li><Check className="mr-2 inline h-4 w-4 text-green" />Invite-gated access</li>
              <li><Check className="mr-2 inline h-4 w-4 text-green" />30-day clip retention</li>
              <li><Check className="mr-2 inline h-4 w-4 text-green" />highlights.live watermark</li>
            </ul>
          </div>
          <div className="card card-accent p-6">
            <div className="text-sm font-bold tracking-wide text-pink">PRO</div>
            <div className="mt-2 text-3xl font-black">$19<span className="text-base font-semibold text-mut">/mo</span></div>
            <p className="mt-1 text-xs text-mut">Coming at GA — not sold during beta.</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-ink">
              <li><Check className="mr-2 inline h-4 w-4 text-green" />100 clips / month</li>
              <li><Check className="mr-2 inline h-4 w-4 text-green" />No watermark</li>
              <li><Check className="mr-2 inline h-4 w-4 text-green" />Priority VOD + object tracking</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Trust placeholder */}
      <section className="mt-24 text-center">
        <p className="mx-auto max-w-xl text-lg italic text-slate-ink">
          "Join creators already cutting clips hands-free."
        </p>
        <p className="mt-2 text-sm text-mut">More proof coming with the beta cohort.</p>
      </section>

      {/* Footer */}
      <footer className="mt-24 border-t border-mut/30 pt-6 pb-2 text-sm text-mut">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-neon" />
            <span className="font-semibold text-slate-ink">highlights.live</span>
            <span>© {new Date().getFullYear()}</span>
          </div>
          <nav className="flex flex-wrap items-center gap-4">
            <Link to="/privacy" className="hover:text-ink">Privacy</Link>
            <Link to="/terms" className="hover:text-ink">Terms</Link>
            <Link to="/retention" className="hover:text-ink">Data retention</Link>
          </nav>
        </div>
        <p className="mt-3 max-w-3xl text-xs leading-relaxed">
          Data retention: video you upload for highlight extraction is processed to generate your
          clips and retained for up to 30 days, then deleted unless you keep saved clips. See our{" "}
          <Link to="/privacy" className="underline hover:text-ink">Privacy policy</Link> for details.
        </p>
      </footer>
    </div>
  );
}

function Step({ n, icon: Icon, title, sub }: { n: number; icon: any; title: string; sub: string }) {
  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 text-neon">
        <span className="flex h-7 w-7 items-center justify-center rounded-full border border-neon/50 text-sm font-bold">
          {n}
        </span>
        <Icon className="h-5 w-5" />
      </div>
      <div className="mt-3 font-bold">{title}</div>
      <div className="mt-1 text-sm text-mut">{sub}</div>
    </div>
  );
}
