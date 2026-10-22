import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowUpRight, Monitor, Moon, Sun } from "lucide-react";
import { getGate, refreshRepos, type GateData } from "@/features/repos/api";
import { RepoPicker } from "@/features/repos/components/repo-picker";
import { SecretsSection } from "./secrets-section";
import { AppShell } from "@/features/shell/app-shell";
import { GithubMark } from "@/elements/brand";
import { Button } from "@/elements/button";
import { useTheme } from "@/app/theme-provider";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/animate-ui/components/radix/tabs";
import { ApiError } from "@/utils/api-client";

export function SettingsPage() {
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();
  const [data, setData] = useState<GateData | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    try {
      setData(await getGate());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate("/login");
      else setError("Settings could not be loaded.");
    }
  }, [navigate]);
  useEffect(() => {
    void load();
  }, [load]);
  return (
    <AppShell>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl px-5 py-9 md:px-10 md:py-12">
          <header className="mb-10">
            <p className="eyebrow mb-2">Make it yours</p>
            <h1 className="page-heading">Workspace settings</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your connections, repositories, and preferences.
            </p>
          </header>
          {error && (
            <p role="alert" className="mb-6 text-sm text-destructive">
              {error}
            </p>
          )}
          <SettingsSection
            title="Appearance"
            description="A comfortable space for focused work."
          >
            <div className="surface flex flex-wrap items-center justify-between gap-4 p-5">
              <div className="flex items-center gap-3">
                <Monitor className="size-4 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Interface theme</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Saved on this device.
                  </p>
                </div>
              </div>
              <Tabs
                value={theme}
                onValueChange={(t) => setTheme(t as "light" | "dark")}
              >
                <TabsList aria-label="Interface theme">
                  <TabsTrigger value="light" className="gap-2 px-3 text-xs">
                    <Sun className="size-3.5" />
                    Light
                  </TabsTrigger>
                  <TabsTrigger value="dark" className="gap-2 px-3 text-xs">
                    <Moon className="size-3.5" />
                    Dark
                  </TabsTrigger>
                </TabsList>
                <TabsContent value={theme} className="sr-only">
                  {theme} theme is selected.
                </TabsContent>
              </Tabs>
            </div>
          </SettingsSection>
          <SettingsSection
            title="GitHub connection"
            description="Access is scoped to your app installation."
          >
            <div className="surface p-5">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-9 items-center justify-center rounded-lg border border-border">
                  <GithubMark size={18} />
                </span>
                <div className="flex-1">
                  <h3 className="text-sm font-medium">GitHub App</h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {data?.installations.length
                      ? `Connected to ${data.installations.map((i) => i.accountLogin).join(", ")}`
                      : "Connect an account to start working on issues."}
                  </p>
                  {data && !data.githubAppConfigured && (
                    <p className="mt-2 text-xs text-warning">
                      The GitHub App needs to be configured on the server.
                    </p>
                  )}
                </div>
              </div>
              <div className="mt-4 border-t border-border pt-4">
                <Button variant="outline" size="sm" asChild>
                  <a href="/auth/install">
                    Manage connection
                    <ArrowUpRight className="size-3.5" />
                  </a>
                </Button>
              </div>
            </div>
          </SettingsSection>
          <SettingsSection
            title="Repositories"
            description="Choose where your agent can work."
          >
            <div className="surface p-5 sm:p-6">
              <h3 className="text-sm font-medium">Enabled repositories</h3>
              <p className="mt-1 mb-5 text-xs leading-relaxed text-muted-foreground">
                Only enabled repositories respond to the{" "}
                <code className="rounded bg-muted px-1 py-0.5">agent:fix</code>{" "}
                label. Turning one off prevents new webhook events from starting
                work.
              </p>
              {data ? (
                data.installations.length ? (
                  <RepoPicker data={data} onSaved={load} onRefresh={async () => {
                    await refreshRepos();
                    setData(await getGate());
                  }} />
                ) : (
                  <p className="py-4 text-sm text-muted-foreground">
                    Connect GitHub above to choose repositories.
                  </p>
                )
              ) : (
                <p className="py-4 text-sm text-muted-foreground">
                  Loading repositories…
                </p>
              )}
              <p className="mt-5 border-t border-border pt-4 text-xs leading-relaxed text-muted-foreground">
                Still missing a repository after refreshing?{" "}
                <a href="https://github.com/settings/installations" target="_blank" rel="noreferrer"
                  className="font-medium text-foreground underline underline-offset-4">Manage GitHub App access</a>{" "}
                and grant Sailor access to that repository, then refresh again. Only repositories your GitHub App installation can access will appear here.
              </p>
            </div>
          </SettingsSection>
          <SettingsSection
            title="Secrets"
            description="Keys the agent may use, stored encrypted and write-only."
          >
            <SecretsSection />
          </SettingsSection>
        </div>
      </div>
    </AppShell>
  );
}

function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-4">
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}
