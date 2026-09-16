import { Link } from "react-router-dom";

export function Footer() {
  return (
    <footer className="border-t border-mut/20 py-8">
      <div className="mx-auto max-w-5xl px-6">
        <p className="mb-3 text-xs text-mut">
          highlights.live — AI highlight clips from your sports &amp; esports streams.
          Public beta. Clips retained 30 days; no card required during beta.
        </p>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-mut">
          <Link to="/privacy" className="hover:text-neon">
            Privacy Policy
          </Link>
          <Link to="/terms" className="hover:text-neon">
            Terms of Service
          </Link>
          <Link to="/retention" className="hover:text-neon">
            Data Retention
          </Link>
          <span className="ml-auto text-xs">© 2026 Ad Astra Labs</span>
        </nav>
      </div>
    </footer>
  );
}
