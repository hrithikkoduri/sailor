/** Auth surface: session users + the login/signup/logout calls. */
import { api } from "@/utils/api-client";

export interface SessionUser {
  id: string;
  email: string | null;
  login: string | null;
  name: string | null;
  avatarUrl: string | null;
}

export const getMe = () => api<{ user: SessionUser }>("/auth/me");

export const login = (email: string, password: string) =>
  api<{ user: SessionUser }>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });

export const signup = (email: string, password: string) =>
  api<{ user: SessionUser }>("/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) });

export const logout = () => api<{ ok: boolean }>("/auth/logout", { method: "POST" });
