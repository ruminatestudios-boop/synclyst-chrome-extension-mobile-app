/* eslint-disable react/no-danger */
"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";

const hasClerk =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string" &&
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim().length > 0;

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function readSearchParams() {
  const u = new URL(typeof window === "undefined" ? "https://synclyst.app/" : window.location.href);
  return {
    checkout: (u.searchParams.get("checkout") || "").trim(),
    tier: (u.searchParams.get("tier") || "").trim().toLowerCase(),
    sessionId: (u.searchParams.get("session_id") || "").trim(),
    billing: (u.searchParams.get("billing") || "").trim().toLowerCase(),
    signedOut: (u.searchParams.get("signed_out") || "").trim() === "1",
    auth: (u.searchParams.get("auth") || "").trim() === "1",
  };
}

function safeSetLocalStorage(k: string, v: string) {
  try {
    window.localStorage.setItem(k, v);
  } catch {
    /* ignore */
  }
}

function closeSoon() {
  let n = 0;
  const id = window.setInterval(() => {
    n += 1;
    try {
      window.close();
    } catch {
      /* ignore */
    }
    if (n >= 4) window.clearInterval(id);
  }, 350);
  return () => window.clearInterval(id);
}

/**
 * `user-summary` alone is unreliable right after Google OAuth: the client session can exist
 * before the server `auth()` sees the cookie, or the first request may run before `__session` is set.
 * Prefer Clerk’s client hooks, then retried fetches to `/api/clerk/user-summary`.
 */
function ExtensionReturnWithClerk() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  const { user, isLoaded: userLoaded } = useUser();
  const [msg, setMsg] = useState("Open the SyncLyst extension to continue.");
  const [blockAuth, setBlockAuth] = useState(true);

  const applySummary = useCallback((j: { signedIn?: boolean; email?: string }) => {
    const signedIn = !!(j && j.signedIn);
    const email = signedIn && typeof j.email === "string" ? String(j.email).trim() : "";
    safeSetLocalStorage("synclyst_signed_in", signedIn ? "1" : "0");
    safeSetLocalStorage("synclyst_auth_at", String(Date.now()));
    if (email) safeSetLocalStorage("synclyst_email", email);
  }, []);

  const applyClerkUser = useCallback(
    (u: NonNullable<ReturnType<typeof useUser>["user"]> | null | undefined) => {
      if (!u) return;
      safeSetLocalStorage("synclyst_signed_in", "1");
      safeSetLocalStorage("synclyst_auth_at", String(Date.now()));
      const em =
        u.primaryEmailAddress?.emailAddress ||
        (Array.isArray(u.emailAddresses) && u.emailAddresses[0]?.emailAddress) ||
        "";
      if (em) safeSetLocalStorage("synclyst_email", String(em).trim());
    },
    []
  );

  // Check-out / sign-out / billing: no Clerk session mirror
  useEffect(() => {
    const { checkout, tier, sessionId, billing, signedOut, auth: authP } = readSearchParams();

    if (signedOut) {
      safeSetLocalStorage("synclyst_signed_in", "0");
      safeSetLocalStorage("synclyst_email", "");
      safeSetLocalStorage("synclyst_auth_at", String(Date.now()));
      if (authP) {
        setMsg("Signed out. Open the SyncLyst extension to continue.");
      }
      return;
    }

    if (checkout === "1") {
      if (tier !== "pro" && tier !== "growth" && tier !== "scale") {
        setMsg("Invalid plan selected. You can close this tab and return to the extension popup.");
        return;
      }
      setMsg("Opening secure checkout…");
      fetch("/api/billing/checkout-direct", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tier,
          success_url: `${window.location.origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${window.location.origin}/extension-return?canceled=1&tier=${encodeURIComponent(tier)}`,
        }),
      })
        .then(async (r) => {
          if (r.status === 401) {
            const redirectUrl = `/extension-return?checkout=1&tier=${encodeURIComponent(tier)}`;
            window.location.href = `/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`;
            return null;
          }
          const j = await r.json().catch(() => null);
          if (!r.ok) {
            const detail = j && typeof (j as { detail?: string }).detail === "string" ? (j as { detail: string }).detail : "";
            throw new Error(detail || `checkout_error_${r.status}`);
          }
          return j;
        })
        .then((j) => {
          if (!j) return;
          const url = j && typeof (j as { url?: string }).url === "string" ? (j as { url: string }).url : "";
          if (!url) throw new Error("missing_checkout_url");
          window.location.href = url;
        })
        .catch(() => {
          setMsg("Could not start checkout. Please close this tab and try again from the extension.");
        });
      return;
    }

    if (billing === "success" && sessionId) {
      setMsg("Confirming your plan… you can close this tab.");
      fetch("/api/billing/confirm-direct", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
        credentials: "include",
      })
        .then((r) => r.json().catch(() => null))
        .then((j) => {
          const tr = j && typeof (j as { tier?: string }).tier === "string" ? (j as { tier: string }).tier : "";
          if (tr) {
            try {
              window.localStorage.setItem("synclyst_tier", tr);
            } catch {
              /* ignore */
            }
          }
          setMsg("Plan updated ✓ — open the SyncLyst extension to continue.");
        })
        .catch(() => {
          setMsg("Payment received ✓ — open the SyncLyst extension to continue.");
        });
      return;
    }

    setBlockAuth(false);
  }, []);

  // Mirror auth: wait for Clerk, then retried /api/clerk/user-summary
  useEffect(() => {
    if (blockAuth) return;
    const { auth: wantAuth, signedOut } = readSearchParams();
    if (signedOut) return;

    if (!isLoaded) {
      if (wantAuth) setMsg("Checking sign-in…");
      return;
    }

    if (isSignedIn && !user) {
      return;
    }

    if (isSignedIn && user && userLoaded) {
      applyClerkUser(user);
      if (wantAuth) {
        setMsg("Signed in ✓ — open the SyncLyst extension to continue.");
      }
      return;
    }

    if (isSignedIn && userId && !user) {
      return;
    }

    let cancel = false;
    const ac = new AbortController();

    const run = async () => {
      const minDelayBase = 900;
      const startedAt = Date.now();

      for (let i = 0; i < 14; i++) {
        if (cancel || ac.signal.aborted) return;
        if (i > 0) await wait(Math.min(400 + i * 180, 2200));
        if (cancel || ac.signal.aborted) return;
        try {
          const r = await fetch("/api/clerk/user-summary", {
            credentials: "include",
            cache: "no-store",
            signal: ac.signal,
          });
          const j = (await r.json().catch(() => ({}))) as { signedIn?: boolean; email?: string };
          if (j && j.signedIn) {
            applySummary(j);
            if (wantAuth) {
              setMsg("Signed in ✓ — open the SyncLyst extension to continue.");
            }
            return;
          }
        } catch {
          /* continue retries */
        }
      }

      if (cancel) return;
      if (isSignedIn && user) {
        applyClerkUser(user);
        if (wantAuth) {
          setMsg("Signed in ✓ — open the SyncLyst extension to continue.");
        }
        return;
      }
      if (wantAuth) {
        setMsg(
          "We couldn’t detect your sign-in in this tab yet. Wait a few seconds, refresh this page, " +
            "or open https://synclyst.app in a new tab. Make sure the address is synclyst.app (with a y)."
        );
      }
      const elapsed = Date.now() - startedAt;
      const minDelayMs = minDelayBase;
      const rest = Math.max(0, minDelayMs - elapsed);
      if (rest) await wait(rest);
    };

    void run();
    return () => {
      cancel = true;
      ac.abort();
    };
  }, [blockAuth, isLoaded, isSignedIn, user, userId, userLoaded, applyClerkUser, applySummary]);

  // After success, give tier-bridge.js time to read localStorage, then try closing the tab.
  useEffect(() => {
    if (blockAuth) return;
    const { auth: wantAuth, signedOut } = readSearchParams();
    if (signedOut) return;
    if (!wantAuth) return;
    if (!msg.startsWith("Signed in.")) return;
    let stopClose: (() => void) | undefined;
    const t = window.setTimeout(() => {
      stopClose = closeSoon();
    }, 900);
    return () => {
      window.clearTimeout(t);
      if (stopClose) stopClose();
    };
  }, [blockAuth, msg]);

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "24px 20px",
        fontFamily: "system-ui, sans-serif",
        background: "#f8fafc",
        color: "#0f172a",
        boxSizing: "border-box",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.125rem", margin: "0 0 8px" }}>SyncLyst®</h1>
      <p style={{ fontSize: "0.9rem", lineHeight: 1.5, margin: "0 0 14px", color: "#475569", maxWidth: 460 }}>
        {msg}
      </p>
      <p style={{ fontSize: "0.8125rem", color: "#64748b", margin: 0 }}>
        You can close this tab — click the SyncLyst icon in your browser toolbar to continue.
      </p>
    </main>
  );
}

/** Server-only + retries (no ClerkProvider / dev) */
function ExtensionReturnApiOnly() {
  const [msg, setMsg] = useState("Open the SyncLyst extension to continue.");

  useEffect(() => {
    const { signedOut, auth, checkout, tier, sessionId, billing } = readSearchParams();

    if (signedOut) {
      safeSetLocalStorage("synclyst_signed_in", "0");
      safeSetLocalStorage("synclyst_email", "");
      safeSetLocalStorage("synclyst_auth_at", String(Date.now()));
      if (auth) setMsg("Signed out. You can close this tab and return to the extension popup.");
      return;
    }

    if (checkout === "1") {
      setMsg("Clerk is not configured in this build; checkout must run on production.");
      return;
    }
    if (billing === "success" && sessionId) {
      setMsg("Confirming your plan…");
      return;
    }

    (async () => {
      for (let i = 0; i < 10; i++) {
        if (i > 0) await wait(300 * (i + 1));
        try {
          const r = await fetch("/api/clerk/user-summary", { credentials: "include", cache: "no-store" });
          const j = (await r.json().catch(() => ({}))) as { signedIn?: boolean; email?: string };
          const signedIn = !!(j && j.signedIn);
          const email = signedIn && j.email ? String(j.email).trim() : "";
          safeSetLocalStorage("synclyst_signed_in", signedIn ? "1" : "0");
          safeSetLocalStorage("synclyst_auth_at", String(Date.now()));
          if (email) safeSetLocalStorage("synclyst_email", email);
          if (auth) {
            setMsg(signedIn ? "Signed in ✓ — open the SyncLyst extension to continue." : "Signed out.");
          }
          if (signedIn) return;
        } catch {
          /* continue */
        }
      }
      if (auth) {
        setMsg("Couldn’t confirm sign-in. Add NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, or use https://synclyst.app (with a y).");
      }
    })();
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "24px 20px",
        fontFamily: "system-ui, sans-serif",
        background: "#f8fafc",
        color: "#0f172a",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h1 style={{ fontSize: "1.125rem" }}>Return to SyncLyst</h1>
      <p style={{ fontSize: "0.9rem", color: "#475569", maxWidth: 420 }}>{msg}</p>
    </main>
  );
}

export default function ExtensionReturnPage() {
  if (hasClerk) {
    return <ExtensionReturnWithClerk />;
  }
  return <ExtensionReturnApiOnly />;
}
