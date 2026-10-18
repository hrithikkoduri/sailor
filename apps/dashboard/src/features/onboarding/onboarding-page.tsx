import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Check, GitBranch, ShieldCheck } from "lucide-react";
import { getGate, type GateData } from "@/features/repos/api";
import { RepoPicker } from "@/features/repos/components/repo-picker";
import { logout } from "@/features/auth/api";
import { GithubMark, Wordmark } from "@/elements/brand";
import { Button } from "@/elements/button";
import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { ApiError } from "@/utils/api-client";

export function OnboardingPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<GateData | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await getGate());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Setup could not be loaded.");
    }
  }, [navigate]);
  useEffect(() => {
    void load();
  }, [load]);
  const step = !data?.installations.length ? 0 : saved ? 2 : 1;
  return (
    <div className="min-h-svh">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Wordmark />
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void logout().then(() => navigate("/login"))}
        >
          Sign out
        </Button>
      </header>
      <main className="mx-auto w-full max-w-[640px] px-6 py-10 md:py-16">
        <ol
          className="mb-10 flex items-center gap-2"
          aria-label="Setup progress"
        >
          {["Connect", "Choose repositories", "Ready"].map((label, i) => (
            <li
              key={label}
              className="flex flex-1 items-center gap-2"
              aria-current={step === i ? "step" : undefined}
            >
              <span
                className={`flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] ${i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
              >
                {i < step ? <Check className="size-3" /> : i + 1}
              </span>
              <span className="text-[11px] text-muted-foreground">{label}</span>
              {i < 2 && (
                <span className="hidden h-px flex-1 bg-border sm:block" />
              )}
            </li>
          ))}
        </ol>
        {error && (
          <p role="alert" className="mb-4 text-sm text-destructive">
            {error}
          </p>
        )}
        {!data ? (
          <p className="text-sm text-muted-foreground">Loading setup…</p>
        ) : step === 0 ? (
          <>
            <p className="eyebrow mb-3">A thoughtful start</p>
            <h1 className="page-heading">Bring your repositories along.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Install the Sailor GitHub App to give your agent a place to work.
              You stay in control of which repositories it can access.
            </p>
            <div className="surface mt-8 p-6">
              <div className="mb-5 flex items-center gap-3">
                <GithubMark size={22} />
                <h2 className="font-medium">Connect with GitHub</h2>
              </div>
              <div className="mb-6 space-y-4 text-sm text-muted-foreground">
                <p className="flex items-start gap-3">
                  <GitBranch className="mt-0.5 size-4 shrink-0" />
                  Select repositories during installation, then enable them
                  here.
                </p>
                <p className="flex items-start gap-3">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0" />
                  The agent opens pull requests. You review and merge them.
                </p>
              </div>
              {data.githubAppConfigured ? (
                <Button asChild className="w-full">
                  <a href="/auth/install">
                    Install GitHub App
                    <ArrowRight className="ml-auto size-4" />
                  </a>
                </Button>
              ) : (
                <p className="text-xs text-warning">
                  Configure the GitHub App on the server to enable installation.
                </p>
              )}
            </div>
          </>
        ) : step === 1 ? (
          <>
            <p className="eyebrow mb-3">Set the boundaries</p>
            <h1 className="page-heading">Where should we work?</h1>
            <p className="mt-3 mb-7 text-sm leading-relaxed text-muted-foreground">
              Only enabled repositories can start agent runs. Change this at any
              time in Settings.
            </p>
            <div className="surface p-5 sm:p-6">
              <RepoPicker
                data={data}
                requireSelection
                saveLabel="Save and continue"
                onSaved={() => setSaved(true)}
              />
              {data.installations.some((i) =>
                i.repos.some((r) => r.enabled),
              ) && (
                <Button
                  variant="ghost"
                  className="mt-3 w-full"
                  onClick={() => setSaved(true)}
                >
                  Continue with current selection
                  <ArrowRight className="size-3.5" />
                </Button>
              )}
            </div>
            <Button variant="link" asChild className="mt-3 text-xs">
              <a href="/auth/install">Install on another account</a>
            </Button>
          </>
        ) : (
          <>
            <span className="mb-6 flex size-12 items-center justify-center rounded-full border border-border bg-card">
              <Check className="size-5" />
            </span>
            <p className="eyebrow mb-3">All set</p>
            <h1 className="page-heading">Your next fix is a label away.</h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              Add this label to an issue in an enabled repository. Sailor will
              pick it up, work through the fix, and open a pull request.
            </p>
            <div className="surface mt-6 flex items-center justify-between px-5 py-4">
              <code className="font-mono text-sm">agent:fix</code>
              <CopyButton
                content="agent:fix"
                variant="ghost"
                size="sm"
                aria-label="Copy trigger label"
              />
            </div>
            <Button asChild className="mt-7">
              <Link to="/">
                Open your workspace
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </>
        )}
      </main>
    </div>
  );
}
