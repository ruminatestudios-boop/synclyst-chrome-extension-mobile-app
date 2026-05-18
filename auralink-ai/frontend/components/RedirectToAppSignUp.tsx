"use client";

import { useAuth } from "@clerk/nextjs";
import { useEffect } from "react";

/**
 * Sends signed-out users to our Next `/sign-up` page (not Clerk's hosted URL) so
 * `redirect_url` is preserved and new users are not dropped on `/sign-in` first
 * (which shows "Couldn't find your account" for unknown emails).
 */
export function RedirectToAppSignUp({ redirectUrl }: { redirectUrl: string }) {
  const { isLoaded } = useAuth();

  useEffect(() => {
    if (!isLoaded) return;
    const safe = redirectUrl.startsWith("/") && !redirectUrl.startsWith("//") ? redirectUrl : "/dashboard/home";
    const target = `/sign-up?redirect_url=${encodeURIComponent(safe)}`;
    if (typeof window !== "undefined") {
      window.location.replace(target);
    }
  }, [isLoaded, redirectUrl]);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1.5rem",
        fontFamily: "system-ui, sans-serif",
        color: "#52525b",
      }}
    >
      <p style={{ margin: 0 }}>Redirecting to create account…</p>
    </div>
  );
}
