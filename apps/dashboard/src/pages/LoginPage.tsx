import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ApiError } from "../api";
import { GithubMark, Wordmark } from "../components/brand";

const inputClass =
  "w-full rounded-lg border border-border bg-muted/40 px-3.5 py-2.5 text-sm outline-none placeholder:text-muted-foreground/70 focus:border-primary/50 focus:ring-2 focus:ring-primary/20";

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(mode === "signin" ? "/auth/login" : "/auth/signup", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      navigate("/onboarding");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-ambient flex min-h-dvh items-center justify-center p-6">
      <div className="w-full max-w-md">
        <div className="mb-8 flex justify-center">
          <Wordmark />
        </div>

        <div className="rounded-2xl border border-border bg-card/40 p-8 shadow-2xl shadow-black/40 backdrop-blur">
          <h1 className="text-xl font-semibold tracking-tight">
            {mode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Sign in to watch your agent work."
              : "An agent that fixes issues, tests its own work, and opens the PR."}
          </p>

          <div className="mt-6 grid grid-cols-2 rounded-lg border border-border bg-card/40 p-1 text-sm">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setError(null);
                }}
                className={`rounded-md py-1.5 font-medium transition ${
                  mode === m ? "bg-muted text-foreground" : "text-muted-foreground hover:text-slate-200"
                }`}
              >
                {m === "signin" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="mt-6 space-y-3">
            <input
              type="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputClass}
            />
            <input
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              placeholder={mode === "signup" ? "Password (8+ characters)" : "Password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
            {error && (
              <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
                {error}
              </div>
            )}
            <button
              disabled={busy}
              className="w-full rounded-lg bg-primary py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? "One moment…" : mode === "signin" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-muted" />
            or
            <div className="h-px flex-1 bg-muted" />
          </div>

          <a
            href="/auth/github"
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-border bg-muted/40 py-2.5 text-sm font-medium transition hover:bg-accent"
          >
            <GithubMark /> Continue with GitHub
          </a>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Passwords are hashed with argon2id; sessions store only a token hash.
        </p>
      </div>
    </div>
  );
}
