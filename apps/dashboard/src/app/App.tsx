import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "@/features/auth/login-page";
import { OnboardingPage } from "@/features/onboarding/onboarding-page";
import { SettingsPage } from "@/features/settings/settings-page";
import { ThreadsPage } from "@/features/threads/threads-page";
import { ThreadDetailPage } from "@/features/threads/thread-detail-page";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/onboarding" element={<OnboardingPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/threads/:id" element={<ThreadDetailPage />} />
      <Route path="/" element={<ThreadsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
