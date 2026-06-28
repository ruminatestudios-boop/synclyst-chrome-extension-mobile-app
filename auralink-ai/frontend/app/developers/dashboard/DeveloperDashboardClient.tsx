"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { useCallback, useEffect, useState } from "react";
import DeveloperShell from "../DeveloperShell";
import styles from "../developers.module.css";

type ApiKey = {
  id: string;
  key_prefix?: string;
  label?: string;
  plan?: string;
  last_used_at?: string | null;
};

type Profile = {
  developer_id: string;
  plan: string;
  usage: {
    calls_used: number;
    calls_limit: number;
    calls_remaining: number;
    month_key: string;
    billing_enabled?: boolean;
  };
  keys_count: number;
  keys_limit: number;
  plan_limits: Record<string, number>;
  use_case_pricing_gbp?: Record<string, number>;
};

const API_PLANS = [
  { id: "free", name: "Free", calls: 50, price: "£0" },
  { id: "starter", name: "Starter", calls: 10_000, price: "£99/mo" },
  { id: "pro", name: "Pro", calls: 50_000, price: "£299/mo" },
];

async function devFetch(path: string, init?: RequestInit) {
  const res = await fetch(`/api/developer/${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { detail?: string; error?: string };
      const raw = body.detail || body.error || "";
      if (raw.startsWith("{")) {
        const inner = JSON.parse(raw) as { detail?: string };
        msg = inner.detail || raw;
      } else if (raw) {
        msg = raw;
      }
    } catch {
      /* keep default */
    }
    throw new Error(msg);
  }
  return res.json();
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return parseApiErrorText(err.message);
  return "Something went wrong";
}

function formatMonthKey(key?: string): string | null {
  if (!key || !/^\d{4}-\d{2}$/.test(key)) return null;
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function formatLastUsed(iso: string | null | undefined): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return null;
  }
}

function parseApiErrorText(raw: string): string {
  const marker = "Stripe error: ";
  if (raw.includes(marker)) {
    try {
      const jsonStart = raw.indexOf("{");
      if (jsonStart >= 0) {
        const parsed = JSON.parse(raw.slice(jsonStart)) as { error?: { message?: string } };
        if (parsed.error?.message) return parsed.error.message;
      }
    } catch {
      /* keep raw */
    }
  }
  return raw;
}

export default function DeveloperDashboardClient() {
  const { getToken, isSignedIn } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [checkoutPlan, setCheckoutPlan] = useState<string | null>(null);
  const [billingLoading, setBillingLoading] = useState(false);
  const [keyCopied, setKeyCopied] = useState(false);
  const [billingNotice, setBillingNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    if (!isSignedIn) {
      setLoading(false);
      return;
    }
    try {
      const [profileData, keysData] = await Promise.all([
        devFetch("profile") as Promise<Profile>,
        devFetch("keys") as Promise<{ keys?: ApiKey[] }>,
      ]);
      setProfile(profileData);
      setKeys(keysData.keys || []);
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (isSignedIn) load();
    else setLoading(false);
  }, [isSignedIn, load]);

  useEffect(() => {
    if (!isSignedIn || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const billing = (params.get("billing") || "").toLowerCase();
    const sessionId = params.get("session_id") || "";
    if (billing !== "success" || !sessionId) return;

    (async () => {
      try {
        const res = await fetch("/api/billing/confirm-direct", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        if (res.ok) {
          setBillingNotice("Billing confirmed. Your plan is now active.");
          await load();
        } else {
          setBillingNotice("Payment received. Your plan will update shortly.");
        }
      } catch {
        setBillingNotice("Payment received. Your plan will update shortly.");
      } finally {
        const cleaned = new URL(window.location.href);
        cleaned.searchParams.delete("billing");
        cleaned.searchParams.delete("session_id");
        window.history.replaceState({}, "", cleaned.toString());
      }
    })();
  }, [isSignedIn, load]);

  async function copyNewKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      setError("Could not copy to clipboard. Select the key and copy manually.");
    }
  }

  async function createKey() {
    setCreating(true);
    setError(null);
    setNewKey(null);
    setKeyCopied(false);
    try {
      const data = (await devFetch("keys", {
        method: "POST",
        body: JSON.stringify({ label: "Default" }),
      })) as { api_key?: string };
      setNewKey(data.api_key || null);
      await load();
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCreating(false);
    }
  }

  async function revokeKey(id: string) {
    if (!confirm("Revoke this API key? Apps using it will stop working immediately.")) return;
    try {
      await devFetch(`keys/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  async function enablePayAsYouGo() {
    setBillingLoading(true);
    setError(null);
    try {
      const token = await getToken();
      const origin = window.location.origin;
      const res = await fetch("/api/billing/api-usage-setup", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          success_url: `${origin}/developers/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/developers/dashboard?billing=cancel`,
        }),
      });
      const data = (await res.json()) as { url?: string; detail?: string; error?: string };
      if (!res.ok) throw new Error(data.detail || data.error || "Billing setup failed");
      if (data.url) window.location.href = data.url;
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setBillingLoading(false);
    }
  }

  async function upgrade(plan: "starter" | "pro") {
    setCheckoutPlan(plan);
    setError(null);
    setBillingNotice(null);
    try {
      const origin = window.location.origin;
      const res = await fetch("/api/billing/api-checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          plan,
          success_url: `${origin}/developers/dashboard?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/developers/dashboard?billing=cancel`,
        }),
      });
      const data = (await res.json()) as { url?: string; detail?: string; error?: string };
      if (!res.ok) throw new Error(parseApiErrorText(data.detail || data.error || "Checkout failed"));
      if (data.url) window.location.href = data.url;
      else throw new Error("Checkout did not return a payment URL.");
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setCheckoutPlan(null);
    }
  }

  if (!isSignedIn) {
    return (
      <DeveloperShell active="dashboard">
        <div className={styles.hero}>
          <span className={styles.eyebrow}>Developer API</span>
          <h1 className={styles.heroTitle}>Your API dashboard</h1>
          <p className={styles.heroSub}>Sign in to create keys, track usage, and manage billing.</p>
        </div>
        <div className={`${styles.card} ${styles.signInCard}`}>
          <p className={styles.cardSub}>Use the same SyncLyst account as the Chrome extension and mobile app.</p>
          <Link href="/sign-in?redirect_url=/developers/dashboard" className={styles.btnPrimary}>
            Sign in to continue
          </Link>
        </div>
      </DeveloperShell>
    );
  }

  if (loading) {
    return (
      <DeveloperShell active="dashboard">
        <div className={styles.loading}>
          <div className={styles.spinner} aria-hidden />
          <p>Loading your dashboard…</p>
        </div>
      </DeveloperShell>
    );
  }

  const callsUsed = profile?.usage.calls_used ?? 0;
  const callsLimit = profile?.usage.calls_limit ?? 50;
  const callsRemaining = profile?.usage.calls_remaining ?? Math.max(0, callsLimit - callsUsed);
  const usagePct = profile ? Math.min(100, Math.round((callsUsed / callsLimit) * 100)) : 0;
  const monthLabel = formatMonthKey(profile?.usage.month_key);

  return (
    <DeveloperShell active="dashboard">
      <div className={`${styles.hero} ${styles.heroCompact}`}>
        <span className={styles.eyebrow}>Developer API</span>
        <h1 className={styles.heroTitle}>Dashboard</h1>
        <p className={styles.heroSub}>
          Manage API keys, monitor usage, and enable pay-as-you-go billing for Zapier and custom integrations.
        </p>
        <div className={styles.quickLinks}>
          <Link href="/developers" className={styles.quickLink}>
            API documentation
          </Link>
          <a href="mailto:synclyst@gmail.com" className={styles.quickLink}>
            Get support
          </a>
        </div>
      </div>

      {(error || billingNotice) && (
        <div className={styles.alertStack}>
          {error && <div className={`${styles.notice} ${styles.noticeErr}`}>{error}</div>}
          {billingNotice && <div className={`${styles.notice} ${styles.noticeOk}`}>{billingNotice}</div>}
        </div>
      )}

      <div className={styles.dashboardStack}>
        <section className={`${styles.card} ${styles.cardFeatured}`}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardHeaderTitle}>Usage this month</h2>
              {monthLabel && <p className={styles.cardHeaderSub}>{monthLabel}</p>}
            </div>
            <span className={styles.planBadge}>{profile?.plan || "free"} plan</span>
          </div>

          <div className={styles.usageGrid}>
            <div className={`${styles.usageStat} ${styles.usageStatHighlight}`}>
              <span className={styles.usageStatLabel}>Used</span>
              <span className={styles.usageStatValue}>{callsUsed}</span>
            </div>
            <div className={styles.usageStat}>
              <span className={styles.usageStatLabel}>Remaining</span>
              <span className={styles.usageStatValue}>{callsRemaining}</span>
            </div>
            <div className={styles.usageStat}>
              <span className={styles.usageStatLabel}>Limit</span>
              <span className={`${styles.usageStatValue} ${styles.usageStatValueSm}`}>
                {callsLimit.toLocaleString()}
              </span>
            </div>
          </div>

          <div className={styles.progressWrap}>
            <div className={styles.progressMeta}>
              <span className={styles.progressMetaLabel}>Monthly quota</span>
              <span className={styles.progressMetaPct}>{usagePct}%</span>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-valuenow={usagePct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`API usage ${usagePct}%`}
            >
              <div className={styles.progressFill} style={{ width: `${usagePct}%` }} />
            </div>
          </div>

          <p className={styles.cardFootnote}>
            {profile?.usage.billing_enabled
              ? "Billing active — each call is metered to your card (~£0.10/call, varies by use case)."
              : "50 free calls/month included. Add a card when you need more — pay only for what you use."}
          </p>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardHeaderTitle}>Pay per API call</h2>
              <p className={styles.cardHeaderSub}>Metered billing after your free tier</p>
            </div>
          </div>
          <p className={styles.cardSub} style={{ marginTop: 0 }}>
            Enable metered billing to keep calling the API from Zapier, scripts, or your backend without interruption.
          </p>
          {profile?.usage.billing_enabled ? (
            <div className={styles.billingActive}>
              <span className={styles.billingActiveDot} aria-hidden />
              Payment method on file — you&apos;re good to go.
            </div>
          ) : (
            <button
              type="button"
              onClick={enablePayAsYouGo}
              disabled={billingLoading}
              className={`${styles.btnPrimary} ${styles.btnPrimaryLg}`}
            >
              {billingLoading ? "Redirecting to Stripe…" : "Enable pay-as-you-go billing"}
            </button>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.sectionHead}>
            <div>
              <h2 className={styles.cardHeaderTitle} style={{ margin: 0 }}>
                API keys
              </h2>
              <p className={styles.cardHeaderSub}>
                {profile?.keys_count ?? 0} of {profile?.keys_limit ?? 5} active
              </p>
            </div>
            <button
              type="button"
              onClick={createKey}
              disabled={creating || (profile?.keys_count ?? 0) >= (profile?.keys_limit ?? 5)}
              className={styles.btnPrimary}
            >
              {creating ? "Creating…" : "Create key"}
            </button>
          </div>
          {newKey && (
            <div className={styles.keyReveal}>
              <strong>Copy your new API key now — it won&apos;t be shown again.</strong>
              <button
                type="button"
                className={`${styles.keyCopyCode} ${keyCopied ? styles.keyCopyCodeDone : ""}`}
                onClick={copyNewKey}
                title="Click to copy"
              >
                <code>{newKey}</code>
                <span className={styles.keyCopyHint}>{keyCopied ? "Copied!" : "Click to copy"}</span>
              </button>
            </div>
          )}
          {keys.length === 0 ? (
            <div className={styles.emptyKeys}>
              <span className={styles.emptyKeysIcon} aria-hidden>
                sk
              </span>
              <p className={styles.emptyKeysTitle}>No API keys yet</p>
              <p className={styles.emptyKeysSub}>
                Create a key to start calling <code>/v1/extract</code> and other endpoints from your server or Zapier.
              </p>
            </div>
          ) : (
            <ul className={styles.keyList}>
              {keys.map((k) => {
                const lastUsed = formatLastUsed(k.last_used_at);
                return (
                  <li key={k.id} className={styles.keyItem}>
                    <div>
                      <p className={styles.keyPrefix}>{k.key_prefix || "sk_live_…"}…</p>
                      <p className={styles.keyMeta}>
                        {k.label || "API key"}
                        {lastUsed ? ` · Last used ${lastUsed}` : ""}
                      </p>
                    </div>
                    <button type="button" onClick={() => revokeKey(k.id)} className={styles.btnDanger}>
                      Revoke
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className={styles.card}>
          <div className={styles.cardHeader}>
            <div>
              <h2 className={styles.cardHeaderTitle}>Upgrade plan</h2>
              <p className={styles.cardHeaderSub}>Higher monthly volume for production workloads</p>
            </div>
          </div>
          <div className={styles.plansGrid}>
            {API_PLANS.map((p) => {
              const isCurrent = p.id === "free" ? (profile?.plan || "free") === "free" : profile?.plan === p.id;
              const isPopular = p.id === "starter";
              return (
                <div
                  key={p.id}
                  className={`${styles.planCard} ${isCurrent ? styles.planCardCurrent : ""} ${isPopular ? styles.planCardPopular : ""}`}
                >
                  {isPopular && !isCurrent && <span className={styles.planRibbon}>Popular</span>}
                  <p className={styles.planName}>{p.name}</p>
                  <p className={styles.planCalls}>{p.calls.toLocaleString()} calls/mo</p>
                  <p className={styles.planPrice}>{p.price}</p>
                  <div className={styles.planFoot}>
                    {p.id === "free" ? (
                      <span className={styles.planStatus}>{isCurrent ? "Current default" : "Included"}</span>
                    ) : isCurrent ? (
                      <span className={styles.planStatus}>Current plan</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => upgrade(p.id as "starter" | "pro")}
                        disabled={checkoutPlan === p.id}
                        className={styles.planLink}
                      >
                        {checkoutPlan === p.id ? "Redirecting…" : "Upgrade"}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <p className={styles.footnote}>
            Enterprise volume?{" "}
            <a href="mailto:synclyst@gmail.com" style={{ color: "#6b7280", fontWeight: 600 }}>
              Contact us
            </a>
          </p>
        </section>
      </div>
    </DeveloperShell>
  );
}
