import { Navigate } from "react-router-dom";
import { useAuth } from "../contexts/AuthContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { SettingsRequestsTab } from "./Settings/components/SettingsRequestsTab";

// The admin Requests report as a page of its own, reached from the sidebar.
// The same report is also a Settings tab. Everyone else goes to Activity,
// where /requests has always led.
export default function RequestsPage() {
  useDocumentTitle("Requests");
  const { user } = useAuth();
  if (user && user.role !== "admin") return <Navigate to="/activity/queue" replace />;
  return <SettingsRequestsTab asPage />;
}
