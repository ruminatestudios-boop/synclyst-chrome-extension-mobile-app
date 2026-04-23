"use client";

import dynamic from "next/dynamic";

const fallback = (
  <div
    style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "#f5f5f5",
      color: "#18181b",
      fontFamily:
        'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}
  >
    <p style={{ fontSize: "0.95rem", color: "#525252" }}>Signing you out...</p>
  </div>
);

// `useClerk()` throws during prerender if the Clerk provider is disabled by env.
// Render the client sign-out logic only on the client (no SSR) so builds don't fail.
const SignOutClient = dynamic(() => import("./SignOutClient"), {
  ssr: false,
  loading: () => fallback,
});

export default function SignOutPage() {
  return <SignOutClient />;
}
