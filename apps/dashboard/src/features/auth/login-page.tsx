import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowRight, Layers2, Loader2 } from "lucide-react";
import { login, signup } from "./api";
import { ApiError } from "@/utils/api-client";
import { GithubMark } from "@/elements/brand";
import { Button } from "@/elements/button";
import { Input } from "@/components/ui/input";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/animate-ui/components/radix/tabs";

export function LoginPage() {
  const navigate = useNavigate();
  const [mode, setMode] = useState("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="grid min-h-svh lg:grid-cols-[1fr_1.15fr]">
      <section className="relative hidden flex-col justify-between border-r border-border bg-sidebar p-12 lg:flex">
        <a
          href="/"
          className="flex items-center gap-2 text-lg font-semibold tracking-tight"
        >
          <Layers2 className="size-5" />
          harness.
        </a>
        <div className="max-w-md">
          <p className="eyebrow mb-6">More context. Less busywork.</p>
          <h1 className="text-[44px] leading-[1.15] font-medium tracking-[-.055em]">
            Good software starts
            <br />
            with a conversation.
          </h1>
          <p className="mt-6 max-w-sm text-base leading-relaxed text-muted-foreground">
            Turn issues into thoughtful fixes. Guide your agent, follow the
            work, and review every step.
          </p>
        </div>
        <p className="text-xs text-muted-foreground">
          Your repositories. Your direction. Every step visible.
        </p>
      </section>
      <section className="flex items-center justify-center p-6 py-16">
        <div className="w-full max-w-[360px]">
          <Layers2 className="mb-8 size-7 lg:hidden" />
          <h2 className="text-2xl font-medium tracking-[-.04em]">
            {mode === "signin" ? "Welcome back." : "Make room for better work."}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {mode === "signin"
              ? "Your workspace is right where you left it."
              : "Create your workspace. Connect your repositories."}
          </p>
          <Tabs
            value={mode}
            onValueChange={(value) => {
              setMode(value);
              setError("");
            }}
            className="mt-7"
          >
            <TabsList className="w-full" aria-label="Authentication method">
              <TabsTrigger value="signin" className="text-xs">
                Sign in
              </TabsTrigger>
              <TabsTrigger value="signup" className="text-xs">
                Create account
              </TabsTrigger>
            </TabsList>
            <TabsContent value={mode} className="sr-only">
              {mode === "signin" ? "Sign in" : "Create account"} using the form
              below.
            </TabsContent>
          </Tabs>
          <Button variant="outline" asChild className="mt-6 w-full">
            <a href="/auth/github">
              <GithubMark size={16} />
              Continue with GitHub
            </a>
          </Button>
          <div className="my-5 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or with email
            <span className="h-px flex-1 bg-border" />
          </div>
          <form
            className="space-y-4"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              setError("");
              try {
                await (mode === "signin" ? login : signup)(email, password);
                navigate("/onboarding");
              } catch (err) {
                setError(
                  err instanceof ApiError
                    ? err.message
                    : "Something went wrong. Please try again.",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <div>
              <label htmlFor="email" className="mb-2 block text-xs font-medium">
                Email address
              </label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
                className="h-10 rounded-lg bg-card text-sm shadow-none"
              />
            </div>
            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-xs font-medium"
              >
                Password
              </label>
              <Input
                id="password"
                type="password"
                autoComplete={
                  mode === "signin" ? "current-password" : "new-password"
                }
                minLength={8}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-describedby={error ? "login-error" : undefined}
                className="h-10 rounded-lg bg-card shadow-none"
              />
              {mode === "signup" && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  At least 8 characters.
                </p>
              )}
            </div>
            {error && (
              <p
                id="login-error"
                role="alert"
                className="text-xs text-destructive"
              >
                {error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <>
                  {mode === "signin"
                    ? "Sign in to your workspace"
                    : "Create workspace"}
                  <ArrowRight className="ml-auto size-4" />
                </>
              )}
            </Button>
          </form>
          <p className="mt-6 text-center text-[11px] text-muted-foreground">
            Secure sign-in. No GitHub tokens stored.
          </p>
        </div>
      </section>
    </main>
  );
}
