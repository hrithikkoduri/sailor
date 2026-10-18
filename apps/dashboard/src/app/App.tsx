import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

const LoginPage = lazy(() =>
  import("@/features/auth/login-page").then((m) => ({ default: m.LoginPage })),
);
const OnboardingPage = lazy(() =>
  import("@/features/onboarding/onboarding-page").then((m) => ({
    default: m.OnboardingPage,
  })),
);
const SettingsPage = lazy(() =>
  import("@/features/settings/settings-page").then((m) => ({
    default: m.SettingsPage,
  })),
);
const ThreadsPage = lazy(() =>
  import("@/features/threads/threads-page").then((m) => ({
    default: m.ThreadsPage,
  })),
);
const ThreadDetailPage = lazy(() =>
  import("@/features/threads/thread-detail-page").then((m) => ({
    default: m.ThreadDetailPage,
  })),
);

export default function App() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
          Loading workspace…
        </div>
      }
    >
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/threads/:id" element={<ThreadDetailPage />} />
        <Route path="/" element={<ThreadsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
