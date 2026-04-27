"use client";

import { SignIn, useAuth } from "@clerk/nextjs";
import { useEffect, useState } from "react";
import { synclystClerkAppearance } from "@/lib/synclyst-clerk-appearance";

const clerkPublishableKey =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string"
    ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim()
    : "";

const STATUS_LINES = [
  "Connecting to secure sign-in…",
  "Preparing your session…",
  "Loading the sign-in form…",
];

const EMBED_OVERLAY_MS = 2800;

/** Inline styles + scoped keyframes so the loader is always visible (no Tailwind required). */
function SignInLoadingBlock() {
  const [line, setLine] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setLine((i) => (i + 1) % STATUS_LINES.length);
    }, 2200);
    return () => window.clearInterval(id);
  }, []);

  return (
    <>
      <style>{`
        @keyframes synclyst-spin {
          to { transform: rotate(360deg); }
        }
        .synclyst-signin-load-ring {
          width: 40px; height: 40px; border-radius: 50%;
          border: 3px solid #e9d5ff;
          border-top-color: #6d28d9;
          animation: synclyst-spin 0.85s linear infinite;
        }
      `}</style>
      <div
        style={{
          display: "flex",
          minHeight: 260,
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 20,
          padding: "32px 16px",
          textAlign: "center",
        }}
      >
        <div
          className="synclyst-signin-load-ring"
          aria-hidden
          role="status"
          aria-label="Loading"
        />
        <div>
          <p
            style={{
              margin: "0 0 6px",
              fontSize: "0.9rem",
              fontWeight: 600,
              color: "#111827",
            }}
          >
            Please wait
          </p>
          <p
            key={line}
            style={{ margin: 0, minHeight: "1.4em", fontSize: "0.875rem", color: "#6b7280" }}
          >
            {STATUS_LINES[line]}
          </p>
        </div>
      </div>
    </>
  );
}

export function SignInForm({
  forceRedirectUrl,
  signUpUrl,
}: {
  forceRedirectUrl: string;
  signUpUrl: string;
}) {
  const { isLoaded, isSignedIn } = useAuth();
  const [embedSettled, setEmbedSettled] = useState(false);

  useEffect(() => {
    if (!isLoaded) return;
    if (isSignedIn) {
      setEmbedSettled(true);
      return;
    }
    setEmbedSettled(false);
    const t = window.setTimeout(() => setEmbedSettled(true), EMBED_OVERLAY_MS);
    return () => window.clearTimeout(t);
  }, [isLoaded, isSignedIn]);

  if (!clerkPublishableKey) {
    return (
      <div style={{ maxWidth: "28rem", textAlign: "center", padding: "0 1rem" }}>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 600, color: "#18181b" }}>Sign in</h1>
        <p style={{ marginTop: 12, fontSize: "0.875rem", lineHeight: 1.6, color: "#52525b" }}>
          Clerk isn&apos;t configured. Add <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> and
          <code> CLERK_SECRET_KEY</code> to your environment, then restart the dev server.
        </p>
      </div>
    );
  }

  const embeddedAppearance = {
    ...synclystClerkAppearance,
    elements: {
      ...(synclystClerkAppearance.elements ?? {}),
      rootBox: "w-full",
      cardBox: "shadow-none border-0 bg-transparent p-0",
      card: "shadow-none border-0 rounded-none bg-transparent p-0",
      footer: "shadow-none border-0",
    },
  };

  const showLoader = !isLoaded || (!isSignedIn && !embedSettled);

  if (isLoaded && isSignedIn) {
    return (
      <>
        <style>{`@keyframes synclyst-spin { to { transform: rotate(360deg); } }`}</style>
        <div
          style={{
            display: "flex",
            minHeight: 200,
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            textAlign: "center",
            padding: "32px 16px",
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              border: "3px solid #e9d5ff",
              borderTopColor: "#6d28d9",
              animation: "synclyst-spin 0.85s linear infinite",
            }}
            aria-hidden
          />
          <p style={{ margin: 0, fontSize: "0.9rem", fontWeight: 600, color: "#18181b" }}>
            You&apos;re signed in
          </p>
          <p style={{ margin: 0, fontSize: "0.875rem", color: "#6b7280" }}>Redirecting you now…</p>
        </div>
      </>
    );
  }

  return (
    <div style={{ position: "relative", minHeight: 300 }}>
      {isLoaded && !isSignedIn ? (
        <SignIn
          forceRedirectUrl={forceRedirectUrl}
          afterSignInUrl={forceRedirectUrl}
          redirectUrl={forceRedirectUrl}
          signUpUrl={signUpUrl}
          appearance={embeddedAppearance}
        />
      ) : null}

      {showLoader ? (
        <div
          style={
            isLoaded
              ? {
                  position: "absolute",
                  inset: 0,
                  zIndex: 10,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "rgba(255,255,255,0.97)",
                  borderRadius: "inherit",
                }
              : { width: "100%" }
          }
        >
          <SignInLoadingBlock />
        </div>
      ) : null}
    </div>
  );
}
