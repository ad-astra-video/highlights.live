import { useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { Zap } from "lucide-react";
import { useAuth } from "../lib/auth";

export function AuthPage() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password);
      nav("/app");
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

        <div className="mb-6 grid grid-cols-2 gap-2">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => {
                setMode(m);
                setError(null);
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
      </div>
    </div>
  );
}
