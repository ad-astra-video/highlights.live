import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Zap } from "lucide-react";
import { useAuth } from "../lib/auth";

/**
 * Password-reset landing page: reached from the emailed reset link
 * (`/reset?token=...`). The token lives in the URL (delivered by the
 * email-sender container) — it is never returned from the API inline.
 * The user sets a new password and the single-use token is redeemed.
 */
export function ResetPage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const { resetPassword } = useAuth();
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setError("This reset link is missing its token. Request a new one from the sign-in page.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await resetPassword(token, newPassword);
      setDone(true);
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

        <h2 className="mb-4 text-center text-lg font-bold text-neon">{done ? "Password updated" : "Reset your password"}</h2>

        {done ? (
          <p className="mb-4 text-center text-sm text-mut">
            Your password was updated.{" "}
            <Link to="/auth" className="text-neon underline">
              Sign in
            </Link>
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
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
        )}
      </div>
    </div>
  );
}
