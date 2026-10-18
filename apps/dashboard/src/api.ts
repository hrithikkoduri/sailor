/** Tiny typed fetch wrapper — same-origin (Vite proxies to :8787 in dev). */
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? `request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface SessionUser {
  id: string;
  email: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export interface OnboardingData {
  user: SessionUser;
  githubAppConfigured: boolean;
  installations: Array<{
    installationId: number;
    accountLogin: string;
    suspended: boolean;
    repos: Array<{ fullName: string; enabled: boolean; defaultBranch: string | null }>;
  }>;
}
