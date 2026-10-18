/** The app chrome: brand, signed-in user chip, sign out. */
import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useNavigate } from "react-router-dom";
import { api, ApiError, type SessionUser } from "../api";
import { Wordmark } from "./brand";

const navClass = ({ isActive }: { isActive: boolean }) =>
  `rounded-lg px-3 py-1.5 transition ${
    isActive ? "bg-white/10 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
  }`;

export function Shell({ children, max = "max-w-5xl" }: { children: ReactNode; max?: string }) {
  const navigate = useNavigate();
  const [user, setUser] = useState<SessionUser | null>(null);

  useEffect(() => {
    api<{ user: SessionUser }>("/auth/me")
      .then((r) => setUser(r.user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      });
  }, [navigate]);

  const logout = async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => undefined);
    navigate("/login");
  };

  return (
    <div className="bg-aura min-h-dvh">
      <header className={`mx-auto flex ${max} items-center justify-between px-6 py-5`}>
        <div className="flex items-center gap-6">
          <Wordmark />
          <nav className="flex items-center gap-1 text-sm">
            <NavLink to="/" end className={navClass}>
              Threads
            </NavLink>
            <NavLink to="/settings" className={navClass}>
              Settings
            </NavLink>
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {user && (
            <span className="flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] py-1 pl-1 pr-3 text-sm text-zinc-300">
              {user.avatarUrl ? (
                <img src={user.avatarUrl} alt="" className="h-6 w-6 rounded-full" />
              ) : (
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-indigo-500/30 text-[10px] font-semibold uppercase">
                  {(user.name ?? user.login ?? user.email ?? "?").slice(0, 1)}
                </span>
              )}
              {user.name ?? user.login ?? user.email}
            </span>
          )}
          <button onClick={logout} className="text-sm text-zinc-400 transition hover:text-zinc-200">
            Sign out
          </button>
        </div>
      </header>
      <main className={`mx-auto ${max} px-6 pb-20`}>{children}</main>
    </div>
  );
}
