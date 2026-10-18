/** The signed-in user, resolved once via /auth/me (redirects 401s to /login). */
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { getMe, type SessionUser } from "@/features/auth/api";
import { ApiError } from "@/utils/api-client";

export function useUser(): { user: SessionUser | null; loading: boolean } {
  const navigate = useNavigate();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getMe()
      .then((r) => setUser(r.user))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) navigate("/login");
      })
      .finally(() => setLoading(false));
  }, [navigate]);

  return { user, loading };
}
