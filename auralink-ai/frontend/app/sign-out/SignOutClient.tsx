"use client";

import { useEffect, useMemo } from "react";
import { useClerk } from "@clerk/nextjs";
import { useSearchParams } from "next/navigation";

function safeRedirectPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/landing.html";
  }
  return value;
}

export default function SignOutClient() {
  const { signOut } = useClerk();
  const searchParams = useSearchParams();
  const redirectUrl = useMemo(
    () => safeRedirectPath(searchParams?.get("redirect_url") ?? null),
    [searchParams]
  );

  useEffect(() => {
    try {
      sessionStorage.removeItem("auralink_jwt");
      localStorage.removeItem("auralink_jwt");
    } catch {}

    signOut({ redirectUrl }).catch(() => {
      window.location.href = redirectUrl;
    });
  }, [redirectUrl, signOut]);

  return (
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
}
