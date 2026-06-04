import DeveloperDashboardClient from "./DeveloperDashboardClient";

export const metadata = {
  title: "API Dashboard – Synclyst",
  description: "Manage Synclyst API keys, usage, and billing.",
};

export default function DeveloperDashboardPage() {
  return <DeveloperDashboardClient />;
}
