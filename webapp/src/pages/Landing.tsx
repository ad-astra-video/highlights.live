import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Zap, Clapperboard, TrendingUp, CreditCard, Flame } from "lucide-react";
import { useAuth } from "../lib/auth";
import { api, type Highlight } from "../lib/api";

export function Landing() {
  const { token } = useAuth();
  const [feed, setFeed] = useState<Highlight[]>([]);
  const [feedLoaded, setFeedLoaded] = useState(false);

  useEffect(() => {
    api<{ highlights: Highlight[] }>("/feed", { auth: false })
      .then((r) => setFeed(r.highlights))
      .catch(() => setFeed([]))
      .finally(() => setFeedLoaded(true));
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-6 py-12">
      <div className="text-center">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neon/50 px-4 py-1.5 text-sm text-neon">
          <Zap className="h-4 w-4" /> AI highlight extraction for sports &amp; gaming
        </div>
        <h1 className="text-5xl font-black leading-tight tracking-tight sm:text-6xl">
          Catch the <span className="text-neon glow-text">moment</span>.<br />
          Skip the <span className="text-pink">slop</span>.
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-slate-ink">
          Feed it a VOD, screen share, RTMP or WebRTC stream. Tell it the sport or game and what to look
          for. It clips the kills, the goals, the clutches — cut and ready to share.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-4 text-left">
          <Feature icon={Clapperboard} color="text-neon" title="Track anything" sub="1fps perceive + event detector" />
          <Feature icon={TrendingUp} color="text-green" title="Pay as you go" sub="Pro subscription + metered usage" />
          <Feature icon={CreditCard} color="text-pink" title="Own your clips" sub="Review queue, then share" />
        </div>

        <div className="mt-10">
          {token ? (
            <Link to="/app" className="btn-neon inline-block text-lg">
              Open the console →
            </Link>
          ) : (
            <Link to="/auth" className="btn-neon inline-block text-lg">
              Start clipping →
            </Link>
          )}
        </div>
      </div>

      <h2 className="mt-14 flex items-center gap-2 text-2xl font-black">
        <Flame className="h-6 w-6 text-pink" /> Latest clips
      </h2>
      <p className="mb-5 text-sm text-mut">Operator-accepted highlights — nothing below the bar.</p>
      {feedLoaded && feed.length === 0 && (
        <div className="rounded-lg border border-mut/30 px-4 py-6 text-center text-mut">
          No clips published yet. Run a detection in the console and accept a highlight to see it here.
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {feed.map((h) => (
          <div key={h.id} className="card card-hover overflow-hidden">
            <video src={h.clipUri} controls playsInline className="aspect-video w-full bg-black" />
            <div className="p-4">
              <div className="flex items-center justify-between">
                <span className="rounded-full border border-pink/50 px-2 py-0.5 text-xs font-bold text-pink">
                  {h.eventType || "EVENT"}
                </span>
                <span className="text-xs text-mut">T+{Math.round(h.start)}s → T+{Math.round(h.end)}s</span>
              </div>
              <div className="mt-2 text-sm text-slate-ink">{h.reason || "No reason"}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Feature({ icon: Icon, color, title, sub }: { icon: any; color: string; title: string; sub: string }) {
  return (
    <div className="card w-56 p-5">
      <Icon className={`h-6 w-6 ${color}`} />
      <div className="mt-3 font-bold">{title}</div>
      <div className="mt-1 text-sm text-mut">{sub}</div>
    </div>
  );
}
