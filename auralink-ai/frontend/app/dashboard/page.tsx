"use client";

import dynamic from "next/dynamic";
import { SignedIn, SignedOut } from "@clerk/nextjs";
import { RedirectToAppSignUp } from "@/components/RedirectToAppSignUp";

const clerkPublishableKey =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string"
    ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim()
    : "";

const DashboardGuest = dynamic(() => import("./DashboardGuest"), {
  loading: () => (
    <div style={{ minHeight: "100vh", padding: "2rem", fontFamily: "system-ui", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f8fafc", color: "#18181b" }}>
      <a href="/landing.html" style={{ marginBottom: "1rem", color: "#18181b" }}>← SyncLyst<sup style={{ fontSize: "0.5em", opacity: 0.8 }}>®</sup></a>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Dashboard</h1>
      <p style={{ color: "#71717a", marginTop: "0.5rem" }}>Loading…</p>
      <p style={{ marginTop: "1.5rem", fontSize: "0.875rem" }}>
        <a href="/dashboard" style={{ color: "#2563eb", fontWeight: 600 }}>Refresh</a>
        {" · "}
        <a href="/landing.html" style={{ color: "#2563eb", fontWeight: 600 }}>Home</a>
      </p>
    </div>
  ),
  ssr: false,
});

const DashboardClient = dynamic(() => import("./DashboardClient"), {
  loading: () => (
    <div style={{ minHeight: "100vh", padding: "2rem", fontFamily: "system-ui", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", background: "#f8fafc", color: "#18181b" }}>
      <a href="/landing.html" style={{ marginBottom: "1rem", color: "#18181b" }}>← SyncLyst<sup style={{ fontSize: "0.5em", opacity: 0.8 }}>®</sup></a>
      <h1 style={{ fontSize: "1.5rem", fontWeight: 700 }}>Dashboard</h1>
      <p style={{ color: "#71717a", marginTop: "0.5rem" }}>Loading…</p>
    </div>
  ),
  ssr: false,
});

export default function DashboardPage() {
  if (!clerkPublishableKey) {
    return <DashboardGuest />;
  }

  return (
    <>
      <SignedIn>
        <DashboardClient />
      </SignedIn>
      <SignedOut>
        <RedirectToAppSignUp redirectUrl="/dashboard/home" />
      </SignedOut>
    </>
  );
}
