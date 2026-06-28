import { redirect } from "next/navigation";

/**
 * Clerk redirects here after sign-in / sign-up.
 * Just forward to the main dashboard so users land on the right page.
 */
export default function DashboardHomePage() {
  redirect("/dashboard");
}
