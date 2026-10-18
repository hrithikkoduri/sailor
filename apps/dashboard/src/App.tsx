import { Navigate, Route, Routes } from "react-router-dom";
import { LoginPage } from "./pages/LoginPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ThreadsPage } from "./pages/ThreadsPage";
import { ThreadDetailPage } from "./pages/ThreadDetailPage";

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
