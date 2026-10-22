import { useCallback, useEffect, useState } from "react";
import { KeyRound, Loader2, Plus, Trash2 } from "lucide-react";
import { Button } from "@/elements/button";
import { IconButton } from "@/elements/icon-button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/animate-ui/components/radix/dialog";
import { api } from "@/utils/api-client";
import type { SecretMetadata as SecretMeta } from "@sailor/contracts";

const when = (value: string | Date | null) =>
  value
    ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" })
    : "never";

/**
 * Secrets are write-only: the list shows metadata, never a value, and there is
 * no "reveal" affordance anywhere in the UI by design.
 */
export function SecretsSection() {
  const [secrets, setSecrets] = useState<SecretMeta[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [envVar, setEnvVar] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<{ secrets?: SecretMeta[] }>("/api/secrets");
      setSecrets(Array.isArray(data.secrets) ? data.secrets : []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Secrets could not be loaded.");
      setSecrets([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (busy || !name.trim() || !envVar.trim() || !value.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/secrets", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), envVar: envVar.trim(), value }),
      });
      setOpen(false);
      setName(""); setEnvVar(""); setValue("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The secret could not be stored.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setError("");
    try {
      await api(`/api/secrets/${id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The secret could not be deleted.");
    }
  };

  return (
    <div className="surface overflow-hidden">
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium"><KeyRound className="size-4 text-muted-foreground" />Account secrets</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Stored encrypted and write-only. The agent can only use a value through a command that
            declares it; the value never appears in the conversation, traces, or a pull request.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="shrink-0 gap-1.5"><Plus className="size-3.5" />Add secret</Button>
          </DialogTrigger>
          <DialogContent className="rounded-2xl sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add a secret</DialogTitle>
              <DialogDescription>
                You will never see this value again. To change it, add it again with the same name.
              </DialogDescription>
            </DialogHeader>
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void add(); }}>
              <label className="block text-xs font-medium" htmlFor="secret-name">Name the agent asks for</label>
              <input id="secret-name" required value={name} onChange={(e) => setName(e.target.value)}
                placeholder="daytona" pattern="[a-z][a-z0-9_-]*" maxLength={40}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm" />
              <label className="block text-xs font-medium" htmlFor="secret-env">Environment variable for the command</label>
              <input id="secret-env" required value={envVar} onChange={(e) => setEnvVar(e.target.value.toUpperCase())}
                placeholder="DAYTONA_API_KEY" pattern="[A-Z][A-Z0-9_]*" maxLength={64}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm" />
              <label className="block text-xs font-medium" htmlFor="secret-value">Value</label>
              <input id="secret-value" required type="password" autoComplete="new-password" value={value}
                onChange={(e) => setValue(e.target.value)} maxLength={8192}
                className="h-10 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm" />
              <div className="flex justify-end pt-1">
                <Button type="submit" disabled={busy || !name.trim() || !envVar.trim() || !value.trim()}>
                  {busy && <Loader2 className="size-4 animate-spin" />}Store secret
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {error && <p role="alert" className="border-b border-border px-5 py-3 text-sm text-destructive">{error}</p>}

      {secrets === null ? (
        <p className="px-5 py-6 text-xs text-muted-foreground">Loading secrets…</p>
      ) : secrets.length === 0 ? (
        <p className="px-5 py-8 text-xs text-muted-foreground">
          No secrets yet. Add one when an agent asks for a key it cannot get from the repository.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {secrets.map((secret) => (
            <li key={secret.id} className="flex items-center gap-3 px-5 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{secret.name}</p>
                <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {secret.envVar} · updated {when(secret.updatedAt)} · last used {when(secret.lastUsedAt)}
                </p>
              </div>
              <IconButton label={`Delete secret ${secret.name}`} onClick={() => void remove(secret.id)}
                className="text-muted-foreground hover:text-destructive">
                <Trash2 />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
