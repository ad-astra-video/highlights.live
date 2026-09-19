import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { useAuth } from "../lib/auth";

type Mode = "login" | "register" | "forgot";

export function AuthPage() {
  const { login, register, requestPasswordReset } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [needInvite, setNeedInvite] = useState(false);
  const [busy, setBusy] = useState(false);

  // Forgot-password flow state. The reset link is delivered by email (the
  // email-sender container); the API never returns a token inline, so the
  // forgot panel only sends the request and tells the user to check their inbox.
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNeedInvite(false);
    setBusy(true);
    try {
      if (mode === "login") return await login(email, password).then(() => nav("/app"));
      if (mode === "register") return await register(email, password, inviteCode || undefined).then(() => nav("/app"));
      // forgot: request a reset link (delivered by email)
      await requestPasswordReset(email);
      setForgotMsg("If an account exists for that email, we sent a reset link. Check your inbox.");
    } catch (err: any) {
      // 403 invite_required means the beta-gate closed registration: surface it
      // with an invite-code hint + a waitlist path.
      if (err?.status === 403) setNeedInvite(true);
      setError(err.message || "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-full place-items-center px-4">
      <div className="card w-full max-w-md p-8">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2 text-2xl font-extrabold text-neon glow-text">
          <Zap className="h-7 w-7" /> highlights<span className="text-pink">.live</span>
        </Link>

        {mode !== "forgot" ? (
          <>
            <div className="mb-6 grid grid-cols-2 gap-2">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setError(null);
                    setForgotMsg(null);
                  }}
                  data-active={mode === m}
                  className={`chip text-center ${mode === m ? "" : "chip-pink"}`}
                  style={{ borderColor: mode === m ? undefined : "rgba(255,16,240,0.5)" }}
                >
                  {m === "login" ? "Sign in" : "Create account"}
                </button>
              ))}
            </div>

            <form onSubmit={submit} className="flex flex-col gap-4">
              <input className="input-neon" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <input className="input-neon" type="password" required minLength={8} placeholder="Password (8+ chars)" value={password} onChange={(e) => setPassword(e.target.value)} />
              {mode === "register" && (
                <input
                  className="input-neon"
                  type="text"
                  placeholder="Invite code (if you have one)"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              )}
              {error && <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
              {needInvite && (
                <div className="rounded-lg border border-neon/40 bg-neon/10 px-3 py-2 text-sm text-neon">
                  This beta is invite-gated. Enter your invite code above, or{" "}
                  <Link to="/" className="underline">
                    join the waitlist
                  </Link>
                  — we'll email you an invite.
                </div>
              )}
              <button className="btn-neon" disabled={busy}>
                {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-mut">
              {mode === "login" ? "New here?" : "Already have an account?"}{" "}
              <button
                className="text-neon underline"
                onClick={() => {
                  setMode(mode === "login" ? "register" : "login");
                  setError(null);
                }}
              >
                {mode === "login" ? "Create one" : "Sign in"}
              </button>
            </p>
            {mode === "login" && (
              <p className="mt-2 text-center text-xs">
                <button
                  className="text-neon underline"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                    setForgotMsg(null);
                  }}
                >
                  Forgot password?
                </button>
              </p>
            )}
          </>
        ) : (
          <>
            <h2 className="mb-4 text-center text-lg font-bold text-neon">Reset your password</h2>

            <form onSubmit={submit} className="flex flex-col gap-4">
              <input className="input-neon" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              {forgotMsg && <div className="rounded-lg border border-neon/40 bg-neon/10 px-3 py-2 text-sm text-neon">{forgotMsg}</div>}
              {error && <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
              <button className="btn-neon" disabled={busy}>
                {busy ? "Please wait…" : "Send reset link"}
              </button>
            </form>

            <p className="mt-5 text-center text-xs text-mut">
              <button
                className="text-neon underline"
                onClick={() => {
                  setMode("login");
                  setError(null);
                  setForgotMsg(null);
                }}
              >
                Back to sign in
              </button>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
