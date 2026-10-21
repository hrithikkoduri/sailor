/**
 * The repo gate's API — which repositories may trigger the agent.
 * `enabled` flags are the same ones every webhook checks server-side.
 */
import { api } from "@/utils/api-client";

export interface GateRepo {
  fullName: string;
  enabled: boolean;
  defaultBranch: string | null;
}

export interface GateInstallation {
  installationId: number;
  accountLogin: string;
  suspended: boolean;
  repos: GateRepo[];
}

export interface GateData {
  user: {
    id: string;
    email: string | null;
    login: string | null;
    name: string | null;
    avatarUrl: string | null;
  };
  githubAppConfigured: boolean;
  installations: GateInstallation[];
}

export const getGate = () => api<GateData>("/api/onboarding");
export const refreshRepos = () => api<{ ok: boolean; repositories: number; installations: number }>(
  "/api/onboarding/repos/refresh", { method: "POST" },
);

/** Replaces the enabled set for one installation (server-side: one transaction). */
export const saveRepos = (installationId: number, enabled: string[]) =>
  api<{ ok: boolean; enabled: number }>("/api/onboarding/repos", {
    method: "POST",
    body: JSON.stringify({ installationId, enabled }),
  });
