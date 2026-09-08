import { Link } from "react-router-dom";
import { Zap, Clapperboard, TrendingUp, CreditCard } from "lucide-react";
import { useAuth } from "../lib/auth";

export function Landing() {
  const { token } = useAuth();
  return (
    <div className="grid min-h-full place-items-center px-6">
      <div className="max-w-3xl text-center">
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
