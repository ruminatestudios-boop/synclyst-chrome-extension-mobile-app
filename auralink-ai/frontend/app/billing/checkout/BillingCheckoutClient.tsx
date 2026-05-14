"use client";

import { SignedIn, SignedOut, useAuth } from "@clerk/nextjs";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/api";
import { RedirectToAppSignUp } from "@/components/RedirectToAppSignUp";

const CLERK_JWT_TEMPLATE = process.env.NEXT_PUBLIC_CLERK_JWT_TEMPLATE?.trim();

const VALID_TIERS = new Set(["pro", "growth", "scale"]);

const publishableKey =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string"
    ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim()
    : "";

function BillingCheckoutInner() {
  const searchParams = useSearchParams();
  const tier = (searchParams?.get("tier") ?? "").toLowerCase();
  const { isLoaded, getToken, userId } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "redirecting" | "error">("idle");
  const startedRef = useRef(false);

  const redirectAfterSignIn = `/billing/checkout?tier=${encodeURIComponent(tier)}`;

  useEffect(() => {
    if (!VALID_TIERS.has(tier)) return;
    if (!isLoaded || !userId) return;
    if (startedRef.current) return;
    startedRef.current = true;
    setStatus("redirecting");

    (async () => {
      try {
        // Prefer the configured JWT template (for backend verification), but fall back
        // to the default token if the template doesn't exist in this Clerk project.
        let token: string | null = null;
        try {
          token = await getToken(CLERK_JWT_TEMPLATE ? { template: CLERK_JWT_TEMPLATE } : undefined);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (CLERK_JWT_TEMPLATE && /jwt template exists with name/i.test(msg)) {
            token = await getToken();
          } else {
            throw e;
          }
        }
        if (!token) {
          setError("Could not verify your session. Try signing in again.");
          setStatus("error");
          startedRef.current = false;
          return;
        }
        const origin = window.location.origin;
        const res = await apiFetch("/api/v1/billing/checkout-session", {
          method: "POST",
          token,
          body: JSON.stringify({
            tier,
            success_url: `${origin}/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${origin}/billing?tier=${encodeURIComponent(tier)}&canceled=1`,
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          setError(
            text.replace(/^\{.*\}$/, "") || `Checkout could not be started (${res.status}).`
          );
          setStatus("error");
          startedRef.current = false;
          return;
        }
        const body = (await res.json()) as { url?: string };
        if (typeof body.url === "string" && body.url) {
          window.location.href = body.url;
          return;
        }
        setError("Checkout did not return a payment URL. Check Stripe price configuration.");
        setStatus("error");
        startedRef.current = false;
      } catch (e) {
        setError(e instanceof Error ? e.message : "Checkout failed");
        setStatus("error");
        startedRef.current = false;
      }
    })();
  }, [isLoaded, userId, tier, getToken]);

  if (!VALID_TIERS.has(tier)) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          fontFamily: "Inter, system-ui, sans-serif",
          background: "#f8fafc",
        }}
      >
        <p style={{ color: "#52525b", marginBottom: "1rem", textAlign: "center" }}>
          Pick a paid plan from pricing to continue.
        </p>
        <Link href="/billing" style={{ fontWeight: 600, color: "#18181b" }}>
          Back to billing
        </Link>
      </div>
    );
  }

  if (!publishableKey) {
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "1.5rem",
          background: "#f8fafc",
        }}
      >
        <p style={{ color: "#52525b", marginBottom: "1rem", textAlign: "center", maxWidth: "24rem" }}>
          Sign-in and billing are not configured in this environment.
        </p>
        <Link href="/billing" style={{ fontWeight: 600, color: "#18181b" }}>
          Back to billing
        </Link>
      </div>
    );
  }

  return (
    <>
      <SignedOut>
        <RedirectToAppSignUp redirectUrl={redirectAfterSignIn} />
      </SignedOut>
      <SignedIn>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            fontFamily: "Inter, system-ui, sans-serif",
            background: "#f8fafc",
          }}
        >
          {status === "error" && error ? (
            <>
              <p
                style={{
                  color: "#991b1b",
                  marginBottom: "1rem",
                  maxWidth: "28rem",
                  textAlign: "center",
                  fontSize: "0.9375rem",
                  lineHeight: 1.5,
                }}
              >
                {error}
              </p>
              <Link href="/billing" style={{ fontWeight: 600, color: "#18181b" }}>
                Back to billing
              </Link>
            </>
          ) : (
            <p style={{ color: "#71717a", fontSize: "0.9375rem" }}>Redirecting to secure checkout…</p>
          )}
        </div>
      </SignedIn>
    </>
  );
}

export default function BillingCheckoutClient() {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#f8fafc",
            color: "#71717a",
            fontFamily: "Inter, system-ui, sans-serif",
          }}
        >
          Loading…
        </div>
      }
    >
      <BillingCheckoutInner />
    </Suspense>
  );
}
