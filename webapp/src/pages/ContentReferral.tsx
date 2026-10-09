import { Link } from "react-router-dom";
import { Zap, Film, Radio, Clapperboard, ArrowRight, Check } from "lucide-react";

// Content-referral explainer page (ADAAAA-6385 / ADAAAA-6384).
//
// Launch placement for the first content-referral leg, at /creators-2026
// (Product Owner option B, ADAAAA-6384). It is PUBLIC (no auth) so an external
// reader can learn what highlights.live does and be funnelled into the
// signup/waitlist flow. Every CTA carries the PO-approved UTM tag set with
// utm_source=content_referral so the ADAAAA-6368 funnel attributes this
// placement as its own acquisition channel:
//
//   utm_source   = content_referral   (first-class channel, preserved verbatim)
//   utm_medium   = page               (hosted explainer page placement)
//   utm_campaign = creators-2026
//   utm_content  = explainer
//
// The landing page (/auth + /waitlist) carries utm_source/utm_medium/
// utm_campaign/utm_content through to register + waitlist so per-placement CAC
// attribution survives the funnel (ADAAAA-6368, ADAAAA-6384).
const UTM = "utm_source=content_referral&utm_medium=page&utm_campaign=creators-2026&utm_content=explainer";

export function ContentReferral() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      {/* Top bar */}
      <header className="mb-16 flex items-center justify-between">
        <Link to="/" className="flex items-center gap-2 text-xl font-extrabold tracking-tight">
          <Zap className="h-6 w-6 text-neon" />
          <span>
            highlights<span className="text-neon glow-text">.live</span>
          </span>
        </Link>
        <Link to={`/?${UTM}`} className="btn-fill inline-flex items-center gap-1 text-sm">
          Try it free <ArrowRight className="h-4 w-4" />
        </Link>
      </header>

      {/* Hero */}
      <section className="text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neon/50 px-4 py-1.5 text-sm text-neon">
          <Zap className="h-4 w-4" /> AI highlight extraction for sports &amp; esports
        </div>
        <h1 className="mx-auto max-w-3xl text-4xl font-black leading-tight tracking-tight sm:text-6xl">
          Feed it your stream.{" "}
          <span className="text-neon glow-text">Get every highlight, cut in seconds.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg text-slate-ink">
          Point highlights.live at a VOD, screen share, RTMP or WebRTC stream. We detect the kills,
          goals and clutches and hand you clean, ready-to-share clips — live within seconds.
          No manual re-watch.
        </p>

        {/* Primary CTA */}
        <div className="mx-auto mt-8 max-w-xl">
          <Link to={`/?${UTM}`} className="btn-fill inline-flex items-center justify-center gap-2 text-lg">
            Try it free <ArrowRight className="h-5 w-5" />
          </Link>
          <p className="mt-3 text-xs text-mut">Free during beta — no card required.</p>
        </div>
      </section>

      {/* How it works */}
      <section className="mt-24">
        <h2 className="text-center text-2xl font-black sm:text-3xl">How it works</h2>
        <div className="mt-8 grid gap-5 sm:grid-cols-3">
          <Step n={1} icon={Film} title="Connect or upload a stream" sub="VOD file, screen share, RTMP or WebRTC — point us at where to watch." />
          <Step n={2} icon={Radio} title="We detect the moments" sub="Audio-change + video analysis find the kills, goals and clutches worth clipping." />
          <Step n={3} icon={Clapperboard} title="Clips land in your feed" sub="Cut and ready to share — live in seconds, deep detail from full VODs." />
        </div>
      </section>

      {/* Who it's for */}
      <section className="mt-24">
        <h2 className="text-center text-2xl font-black sm:text-3xl">Built for streamers, creators &amp; coaches</h2>
        <div className="mx-auto mt-8 grid max-w-4xl gap-5 sm:grid-cols-3">
          <div className="card p-6">
            <div className="text-sm font-bold tracking-wide text-pink">LIVE</div>
            <p className="mt-3 text-slate-ink">Clip a moment in 1–5 s while it's still happening — perfect for live watch-alongs and instant replays.</p>
          </div>
          <div className="card card-accent p-6">
            <div className="text-sm font-bold tracking-wide text-neon">VOD</div>
            <p className="mt-3 text-slate-ink">Deep detail across a whole game or match — no manual re-watch, no missed clutch.</p>
          </div>
          <div className="card p-6">
            <div className="text-sm font-bold tracking-wide text-purple">TEAMS</div>
            <p className="mt-3 text-slate-ink">Share-ready highlights for community, recap and coaching content workflows.</p>
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="mt-24 rounded-2xl border border-neon/40 bg-neon/5 p-8 text-center">
        <h2 className="text-2xl font-black sm:text-3xl">Clip the moment — free during beta.</h2>
        <p className="mx-auto mt-3 max-w-xl text-slate-ink">
          Join the waitlist or create your account and start turning streams into share-ready
          highlight clips in seconds.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link to={`/?${UTM}`} className="btn-fill inline-flex items-center gap-2 text-base">
            Try it free <ArrowRight className="h-5 w-5" />
          </Link>
          <Link to={`/auth?${UTM}`} className="btn-neon inline-flex items-center gap-2 text-base">
            Create account
          </Link>
        </div>
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
          Video you upload for highlight extraction is processed to generate your clips and
          retained for up to 30 days, then deleted unless you keep saved clips. See our{" "}
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
