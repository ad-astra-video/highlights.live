import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { useAuth } from "../lib/auth";

type Mode = "login" | "register" | "forgot";

export function AuthPage() {
  const { login, register, requestPasswordReset, resetPassword } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Forgot-password flow state. In the beta (no mailer yet) the server returns
  // a single-use resetToken inline for a real account; we surface it so the
  // loop can be completed and then discard it once used.
  const [forgotMsg, setForgotMsg] = useState<string | null>(null);
  const [resetToken, setResetToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetDone, setResetDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") return await login(email, password).then(() => nav("/app"));
      if (mode === "register") return await register(email, password).then(() => nav("/app"));
      // forgot: request a reset token
      const res = await requestPasswordReset(email);
      if (res.resetToken) {
        setResetToken(res.resetToken);
        setForgotMsg("Reset token issued (beta: no mailer yet, delivered inline).");
      } else {
        setForgotMsg("If an account exists for that email, a reset token was issued.");
      }
    } catch (err: any) {
      setError(err.message || "something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function submitReset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await resetPassword(resetToken!, newPassword);
      setResetDone(true);
      setResetToken(null);
    } catch (err: any) {
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
                    setResetDone(false);
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
              {error && <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
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
            <h2 className="mb-4 text-center text-lg font-bold text-neon">
              {resetToken ? "Set a new password" : resetDone ? "Password updated" : "Reset your password"}
            </h2>

            {resetDone ? (
              <p className="mb-4 text-center text-sm text-mut">
                Your password was updated.{" "}
                <button
                  className="text-neon underline"
                  onClick={() => {
                    setMode("login");
                    setPassword("");
                    setResetDone(false);
                  }}
                >
                  Sign in
                </button>
              </p>
            ) : resetToken ? (
              <form onSubmit={submitReset} className="flex flex-col gap-4">
                <input className="input-neon" readOnly value={resetToken} />
                <input
                  className="input-neon"
                  type="password"
                  required
                  minLength={8}
                  placeholder="New password (8+ chars)"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
                {error && <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
                <button className="btn-neon" disabled={busy}>
                  {busy ? "Please wait…" : "Update password"}
                </button>
              </form>
            ) : (
              <form onSubmit={submit} className="flex flex-col gap-4">
                <input className="input-neon" type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                {forgotMsg && <div className="rounded-lg border border-neon/40 bg-neon/10 px-3 py-2 text-sm text-neon">{forgotMsg}</div>}
                {error && <div className="rounded-lg border border-red/40 bg-red/10 px-3 py-2 text-sm text-red">{error}</div>}
                <button className="btn-neon" disabled={busy}>
                  {busy ? "Please wait…" : "Send reset link"}
                </button>
              </form>
            )}

            <p className="mt-5 text-center text-xs text-mut">
              <button
                className="text-neon underline"
                onClick={() => {
                  setMode("login");
                  setError(null);
                  setForgotMsg(null);
                  setResetToken(null);
                  setResetDone(false);
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
