import { Routes, Route, Navigate } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Shell } from "./components/Shell";
import { Landing } from "./pages/Landing";
import { AuthPage } from "./pages/AuthPage";
import { ResetPage } from "./pages/ResetPage";
import { Highlights } from "./pages/Highlights";
import { Dataset } from "./pages/Dataset";
import { Billing } from "./pages/Billing";
import { Settings } from "./pages/Settings";
import { Train } from "./pages/Train";
import { FineTune } from "./pages/FineTune";
import { Legal } from "./pages/Legal";
import { ContentReferral } from "./pages/ContentReferral";

function Protected({ children }: { children: React.ReactNode }) {
  const { token, ready } = useAuth();
  if (!ready) return <div className="grid h-full place-items-center text-mut">tuning the signal…</div>;
  if (!token) return <Navigate to="/auth" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/referral" element={<Navigate to="/creators-2026" replace />} />
      <Route path="/creators-2026" element={<ContentReferral />} />
      <Route path="/privacy" element={<Legal kind="privacy" />} />
      <Route path="/terms" element={<Legal kind="terms" />} />
      <Route path="/retention" element={<Legal kind="retention" />} />
      <Route
        path="/app"
        element={
          <Protected>
            <Shell />
          </Protected>
        }
      >
        <Route index element={<Highlights />} />
        <Route path="train" element={<Train />}>
          <Route index element={<FineTune />} />
          <Route path="dataset" element={<Dataset />} />
        </Route>
        <Route path="billing" element={<Billing />} />
        <Route path="settings" element={<Settings />} />
        <Route path="dataset" element={<Navigate to="/app/train/dataset" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
