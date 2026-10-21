import { lazy, Suspense } from "react";
import { Navigate, Route, Routes, useParams } from "react-router-dom";

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
const HomePage = lazy(() => import("@/features/workspace/home-page").then((m) => ({ default: m.HomePage })));
const NewThreadPage = lazy(() => import("@/features/workspace/home-page").then((m) => ({ default: m.NewThreadPage })));
const RepositoryWorkPage = lazy(() => import("@/features/workspace/repository-work-page").then((m) => ({ default: m.RepositoryWorkPage })));
const TracesPage = lazy(() => import("@/features/workspace/traces-page").then((m) => ({ default: m.TracesPage })));

function ThreadRoute() {
  const { id } = useParams();
  return <ThreadDetailPage key={id} />;
}

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
        <Route path="/threads/new" element={<NewThreadPage />} />
        <Route path="/threads/:id" element={<ThreadRoute />} />
        <Route path="/threads" element={<ThreadsPage />} />
        <Route path="/issues" element={<RepositoryWorkPage kind="issues" />} />
        <Route path="/pull-requests" element={<RepositoryWorkPage kind="prs" />} />
        <Route path="/traces" element={<TracesPage />} />
        <Route path="/" element={<HomePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
