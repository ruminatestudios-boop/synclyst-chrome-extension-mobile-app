"use client";

import { useState, useEffect, useCallback } from "react";
import { useUser, useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import Link from "next/link";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ApiKey {
  id: string;
  label: string;
  key_prefix: string;
  plan: "free" | "starter" | "pro" | "enterprise";
  status: "active" | "suspended" | "revoked";
  calls_used_this_month: number;
  created_at: string;
  last_used_at: string | null;
}

interface DailyUsage {
  date: string;
  calls: number;
}

interface EndpointBreakdown {
  endpoint: string;
  calls: number;
  cost_usd: number;
}

interface UsageData {
  calls_used_this_month: number;
  calls_limit: number | null;
  plan: string;
  daily: DailyUsage[];
  by_endpoint: EndpointBreakdown[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PLAN_LIMITS: Record<string, number | null> = {
  free: 100,
  starter: 1000,
  pro: 10000,
  enterprise: null,
};

const PLAN_COLORS: Record<string, string> = {
  free: "text-white/50 bg-white/5",
  starter: "text-[#a78bfa] bg-[#6c2bd9]/20",
  pro: "text-[#c4b5fd] bg-[#7c3aed]/20",
  enterprise: "text-amber-300 bg-amber-900/20",
};

const PLAN_LABELS: Record<string, string> = {
  free: "Free",
  starter: "Starter",
  pro: "Pro",
  enterprise: "Enterprise",
};

const ENDPOINT_COLORS: Record<string, string> = {
  "/v1/extract": "bg-[#6c2bd9]",
  "/v1/market-value": "bg-[#7c3aed]",
  "/v1/classify": "bg-emerald-500",
  "/v1/value": "bg-amber-500",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function maskKey(prefix: string) {
  return `${prefix}${"•".repeat(32)}`;
}

function formatDate(iso: string | null) {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function formatNumber(n: number) {
  return n.toLocaleString("en-GB");
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function UsageBar({ used, limit }: { used: number; limit: number | null }) {
  const pct = limit ? Math.min((used / limit) * 100, 100) : 0;
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-[#6c2bd9]";

  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-white/50">{formatNumber(used)} calls used</span>
        <span className="text-white/30">{limit ? `of ${formatNumber(limit)}` : "Unlimited"}</span>
      </div>
      {limit && (
        <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-700 ${color}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function MiniBarChart({ daily }: { daily: DailyUsage[] }) {
  if (!daily.length) return null;
  const max = Math.max(...daily.map((d) => d.calls), 1);

  return (
    <div className="flex items-end gap-0.5 h-16 w-full">
      {daily.map((d, i) => {
        const pct = (d.calls / max) * 100;
        const isLast = i === daily.length - 1;
        return (
          <div key={d.date} className="flex-1 group relative flex flex-col justify-end">
            <div
              className={`rounded-sm transition-all duration-300 ${
                isLast ? "bg-[#6c2bd9]" : "bg-white/10 group-hover:bg-white/20"
              }`}
              style={{ height: `${Math.max(pct, 2)}%` }}
            />
            <div className="absolute -top-9 left-1/2 -translate-x-1/2 hidden group-hover:block z-10">
              <div
                className="rounded-xl px-2 py-1 text-xs text-white whitespace-nowrap shadow-xl"
                style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.14)" }}
              >
                {d.calls} calls
                <br />
                <span className="text-white/40">
                  {new Date(d.date).toLocaleDateString("en-GB", { month: "short", day: "numeric" })}
                </span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DeveloperDashboard() {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const router = useRouter();

  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKeyPlaintext, setNewKeyPlaintext] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [creatingTest, setCreatingTest] = useState(false);
  const [testKeyPlaintext, setTestKeyPlaintext] = useState<string | null>(null);

  const [revealedKeyId, setRevealedKeyId] = useState<string | null>(null);
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [subscribing, setSubscribing] = useState(false);

  // ── Fetch ───────────────────────────────────────────────────────────────────

  const fetchData = useCallback(async () => {
    try {
      const [keysRes, usageRes] = await Promise.all([
        fetch("/api/developers/keys"),
        fetch("/api/developers/usage"),
      ]);
      if (!keysRes.ok) throw new Error("Failed to load API keys");
      if (!usageRes.ok) throw new Error("Failed to load usage data");
      setKeys((await keysRes.json()).keys ?? []);
      setUsage(await usageRes.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isLoaded && !user) {
      router.push("/sign-in?redirect_url=/developers/dashboard");
      return;
    }
    if (isLoaded && user) fetchData();
  }, [isLoaded, user, fetchData, router]);

  // ── Actions ─────────────────────────────────────────────────────────────────

  const createKey = async () => {
    if (!newLabel.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/developers/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: newLabel.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Failed to create key");
      setNewKeyPlaintext(data.key);
      setShowCreate(false);
      setNewLabel("");
      fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  };

  const createTestKey = async () => {
    setCreatingTest(true);
    try {
      const res = await fetch("/api/developers/keys/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Sandbox test key" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? "Failed to create test key");
      setTestKeyPlaintext(data.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create test key");
    } finally {
      setCreatingTest(false);
    }
  };

  const deleteKey = async (id: string) => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/developers/keys/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.message ?? "Failed to revoke key");
      }
      setDeleteTargetId(null);
      fetchData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke key");
    } finally {
      setDeleting(false);
    }
  };

  const subscribe = async (plan: "starter" | "pro" | "enterprise") => {
    setSubscribing(true);
    try {
      const res = await fetch("/api/developers/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? "Failed to start checkout");
      if (data.checkout_url) window.location.href = data.checkout_url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start checkout");
    } finally {
      setSubscribing(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const primaryKey = keys.find((k) => k.status === "active");
  const currentPlan = primaryKey?.plan ?? "free";
  const planLimit = PLAN_LIMITS[currentPlan];

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (!isLoaded || loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: "#07050d" }}>
        <div className="text-center space-y-3">
          <div className="w-8 h-8 border-2 border-[#6c2bd9] border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-white/30 text-sm">Loading dashboard…</p>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const cardStyle = {
    background: "rgba(255,255,255,0.035)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: "20px",
  };

  const inputStyle = {
    background: "rgba(255,255,255,0.05)",
    border: "1px solid rgba(255,255,255,0.12)",
    borderRadius: "12px",
    color: "#fff",
    outline: "none",
  };

  return (
    <div className="min-h-screen text-white" style={{ background: "#07050d", fontFamily: "Inter, system-ui, sans-serif" }}>

      {/* Nav */}
      <nav
        className="sticky top-0 z-40 backdrop-blur-md"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.07)", background: "rgba(7,5,13,0.85)" }}
      >
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="font-bold text-white tracking-tight text-lg">
              SyncLyst<sup className="text-[10px] font-medium ml-0.5 opacity-60">®</sup>
            </Link>
            <div
              className="hidden sm:flex items-center gap-1 px-1 py-1"
              style={{ border: "1px solid rgba(255,255,255,0.12)", borderRadius: "28px" }}
            >
              <Link
                href="/developers"
                className="px-4 py-1 text-sm text-white/60 hover:text-white transition-colors rounded-full"
              >
                Docs
              </Link>
              <span
                className="px-4 py-1 text-sm text-white font-medium rounded-full"
                style={{ background: "rgba(255,255,255,0.1)" }}
              >
                Dashboard
              </span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-white/40 hidden sm:block">
              {user?.primaryEmailAddress?.emailAddress}
            </span>
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full ${PLAN_COLORS[currentPlan]}`}>
              {PLAN_LABELS[currentPlan]}
            </span>
          </div>
        </div>
      </nav>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-5">

        {/* Error banner */}
        {error && (
          <div
            className="flex items-start gap-3 px-4 py-3 rounded-2xl"
            style={{ background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)" }}
          >
            <svg className="w-5 h-5 text-red-400 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-red-300 flex-1">{error}</p>
            <button onClick={() => setError(null)} className="text-red-400 hover:text-red-200">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        {/* New key banner */}
        {newKeyPlaintext && (
          <div
            className="p-4 space-y-3 rounded-2xl"
            style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)" }}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-emerald-300">API key created — copy it now, it won&apos;t be shown again</p>
            </div>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              <code className="flex-1 text-sm font-mono text-emerald-300 break-all">{newKeyPlaintext}</code>
              <button onClick={() => copyToClipboard(newKeyPlaintext)} className="shrink-0 text-white/40 hover:text-white transition-colors">
                {copied
                  ? <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                }
              </button>
            </div>
            <button onClick={() => setNewKeyPlaintext(null)} className="text-xs text-white/30 hover:text-white/60 transition-colors">
              I&apos;ve saved my key, dismiss
            </button>
          </div>
        )}

        {/* Test key banner */}
        {testKeyPlaintext && (
          <div
            className="p-4 space-y-3 rounded-2xl"
            style={{ background: "rgba(108,43,217,0.12)", border: "1px solid rgba(108,43,217,0.3)" }}
          >
            <div className="flex items-center gap-2">
              <svg className="w-5 h-5 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm font-medium text-[#c4b5fd]">Sandbox key created — copy it now</p>
            </div>
            <div
              className="flex items-center gap-2 px-3 py-2 rounded-xl"
              style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.1)" }}
            >
              <code className="flex-1 text-sm font-mono text-[#a78bfa] break-all">{testKeyPlaintext}</code>
              <button onClick={() => copyToClipboard(testKeyPlaintext)} className="shrink-0 text-white/40 hover:text-white transition-colors">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
              </button>
            </div>
            <button onClick={() => setTestKeyPlaintext(null)} className="text-xs text-white/30 hover:text-white/60 transition-colors">Dismiss</button>
          </div>
        )}

        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-2">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Developer Dashboard</h1>
            <p className="text-white/40 text-sm mt-0.5">Manage your API keys and monitor usage</p>
          </div>
          <button
            onClick={() => setShowCreate(true)}
            disabled={keys.filter((k) => k.status === "active").length >= 3}
            className="inline-flex items-center gap-2 text-sm font-medium px-5 py-2.5 rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: "#6c2bd9" }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New API Key
          </button>
        </div>

        {/* Stats grid */}
        {usage && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Calls this month", value: formatNumber(usage.calls_used_this_month), sub: planLimit ? `of ${formatNumber(planLimit)}` : "unlimited" },
              { label: "Active keys", value: keys.filter((k) => k.status === "active").length.toString(), sub: "of 3 max" },
              { label: "Current plan", value: PLAN_LABELS[currentPlan], sub: currentPlan === "free" ? "Upgrade available" : currentPlan === "enterprise" ? "Unlimited calls" : `£${currentPlan === "starter" ? 19 : 49}/mo` },
              { label: "Endpoints", value: usage.by_endpoint.length.toString(), sub: "active this month" },
            ].map((stat) => (
              <div key={stat.label} className="px-4 py-3" style={cardStyle}>
                <p className="text-xs text-white/30 uppercase tracking-wide mb-1">{stat.label}</p>
                <p className="text-2xl font-bold text-white">{stat.value}</p>
                <p className="text-xs text-white/30 mt-0.5">{stat.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* API Keys */}
        <div style={cardStyle} className="overflow-hidden">
          <div
            className="px-5 py-4 flex items-center justify-between"
            style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
          >
            <h2 className="font-semibold text-sm">API Keys</h2>
            <Link href="/developers" className="text-xs text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">
              View docs →
            </Link>
          </div>

          {keys.length === 0 ? (
            <div className="px-5 py-10 text-center space-y-3">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center mx-auto"
                style={{ background: "rgba(108,43,217,0.15)" }}
              >
                <svg className="w-6 h-6 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                </svg>
              </div>
              <p className="text-white/50 text-sm">No API keys yet</p>
              <p className="text-white/25 text-xs">Create your first key to start making API calls</p>
              <button
                onClick={() => setShowCreate(true)}
                className="inline-flex items-center gap-1.5 text-sm text-[#a78bfa] hover:text-[#c4b5fd] transition-colors"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Create API key
              </button>
            </div>
          ) : (
            <div>
              {keys.map((key, i) => (
                <div
                  key={key.id}
                  className="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-3"
                  style={i < keys.length - 1 ? { borderBottom: "1px solid rgba(255,255,255,0.05)" } : {}}
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{key.label}</span>
                      <span
                        className="text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{
                          background: key.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(239,68,68,0.15)",
                          color: key.status === "active" ? "#6ee7b7" : "#fca5a5",
                        }}
                      >
                        {key.status}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${PLAN_COLORS[key.plan]}`}>
                        {PLAN_LABELS[key.plan]}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="text-xs font-mono text-white/30">
                        {revealedKeyId === key.id ? key.key_prefix + "…" : maskKey(key.key_prefix)}
                      </code>
                      {revealedKeyId !== key.id && (
                        <button onClick={() => setRevealedKeyId(key.id)} className="text-xs text-white/20 hover:text-white/50 transition-colors">
                          (reveal)
                        </button>
                      )}
                    </div>
                    <p className="text-xs text-white/25">
                      Created {formatDate(key.created_at)} · Last used {formatDate(key.last_used_at)} · {formatNumber(key.calls_used_this_month)} calls this month
                    </p>
                  </div>
                  {key.status === "active" && (
                    <button
                      onClick={() => setDeleteTargetId(key.id)}
                      className="shrink-0 text-xs text-white/30 hover:text-red-400 transition-colors px-3 py-1.5 rounded-full"
                      style={{ border: "1px solid rgba(255,255,255,0.08)" }}
                    >
                      Revoke
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Create form */}
          {showCreate && (
            <div
              className="px-5 py-4 space-y-3"
              style={{ borderTop: "1px solid rgba(255,255,255,0.06)", background: "rgba(108,43,217,0.06)" }}
            >
              <p className="text-sm font-medium">Create new API key</p>
              <div className="flex gap-2">
                <input
                  autoFocus
                  type="text"
                  placeholder="Label (e.g. Production)"
                  value={newLabel}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && createKey()}
                  className="flex-1 px-3 py-2 text-sm placeholder:text-white/25"
                  style={inputStyle}
                />
                <button
                  onClick={createKey}
                  disabled={creating || !newLabel.trim()}
                  className="text-sm font-medium px-5 py-2 rounded-full transition-all disabled:opacity-40"
                  style={{ background: "#6c2bd9" }}
                >
                  {creating ? "Creating…" : "Create"}
                </button>
                <button
                  onClick={() => { setShowCreate(false); setNewLabel(""); }}
                  className="text-sm px-3 py-2 rounded-full text-white/50 hover:text-white transition-colors"
                  style={{ border: "1px solid rgba(255,255,255,0.1)" }}
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-white/25">Your full key will be shown once. Max 3 active keys.</p>
            </div>
          )}
        </div>

        {/* Sandbox */}
        <div style={cardStyle} className="overflow-hidden">
          <div className="px-5 py-4 flex items-center gap-2" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <span
              className="text-xs font-medium px-2.5 py-0.5 rounded-full text-[#a78bfa]"
              style={{ background: "rgba(108,43,217,0.2)" }}
            >
              Sandbox
            </span>
            <h2 className="font-semibold text-sm">Test Keys</h2>
          </div>
          <div className="px-5 py-4 space-y-3">
            <p className="text-sm text-white/40">
              Use <code className="text-[#a78bfa] px-1.5 py-0.5 rounded-lg text-xs" style={{ background: "rgba(108,43,217,0.2)" }}>sk_test_</code> keys against{" "}
              <code className="text-[#a78bfa] px-1.5 py-0.5 rounded-lg text-xs" style={{ background: "rgba(108,43,217,0.2)" }}>/sandbox/v1/</code> for free — no AI calls, no billing.
            </p>
            <button
              onClick={createTestKey}
              disabled={creatingTest}
              className="inline-flex items-center gap-2 text-sm text-[#a78bfa] hover:text-[#c4b5fd] transition-colors px-4 py-2 rounded-full disabled:opacity-40"
              style={{ border: "1px solid rgba(108,43,217,0.3)" }}
            >
              {creatingTest
                ? <span className="w-4 h-4 border border-[#a78bfa] border-t-transparent rounded-full animate-spin" />
                : <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              }
              {creatingTest ? "Creating…" : "Create sandbox key"}
            </button>
          </div>
        </div>

        {/* Usage graph */}
        {usage && usage.daily.length > 0 && (
          <div style={cardStyle} className="overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-semibold text-sm">Usage — Last 30 Days</h2>
              <span className="text-xs text-white/30">{formatNumber(usage.calls_used_this_month)} total calls</span>
            </div>
            <div className="px-5 py-5 space-y-4">
              <UsageBar used={usage.calls_used_this_month} limit={planLimit} />
              <MiniBarChart daily={usage.daily} />
              {usage.daily.length > 0 && (
                <div className="flex justify-between text-xs text-white/20">
                  <span>{new Date(usage.daily[0].date).toLocaleDateString("en-GB", { month: "short", day: "numeric" })}</span>
                  <span>Today</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Endpoint breakdown */}
        {usage && usage.by_endpoint.length > 0 && (
          <div style={cardStyle} className="overflow-hidden">
            <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-semibold text-sm">Endpoint Breakdown</h2>
            </div>
            <div>
              {usage.by_endpoint.map((ep, i) => {
                const totalCalls = usage.by_endpoint.reduce((s, e) => s + e.calls, 0);
                const pct = totalCalls ? Math.round((ep.calls / totalCalls) * 100) : 0;
                const color = ENDPOINT_COLORS[ep.endpoint] ?? "bg-white/20";
                return (
                  <div
                    key={ep.endpoint}
                    className="px-5 py-3 flex items-center gap-4"
                    style={i < usage.by_endpoint.length - 1 ? { borderBottom: "1px solid rgba(255,255,255,0.04)" } : {}}
                  >
                    <div className={`w-2 h-2 rounded-full shrink-0 ${color}`} />
                    <code className="text-sm font-mono text-white/50 flex-1 min-w-0 truncate">{ep.endpoint}</code>
                    <div className="flex items-center gap-3 shrink-0">
                      <div className="hidden sm:flex items-center gap-1.5">
                        <div className="w-24 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.08)" }}>
                          <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs text-white/25 w-8 text-right">{pct}%</span>
                      </div>
                      <span className="text-sm text-white/60 w-20 text-right">{formatNumber(ep.calls)} calls</span>
                      <span className="text-xs text-white/25 w-16 text-right">${ep.cost_usd.toFixed(2)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Upgrade */}
        {currentPlan !== "enterprise" && (
          <div style={cardStyle} className="overflow-hidden">
            <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
              <h2 className="font-semibold text-sm">Upgrade Plan</h2>
            </div>
            <div className="p-5 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                { key: "starter" as const, name: "Starter", price: "£19", calls: "1,000 calls/month", rpm: "30 req/min", current: currentPlan === "starter" },
                { key: "pro" as const, name: "Pro", price: "£49", calls: "10,000 calls/month", rpm: "100 req/min", current: currentPlan === "pro" },
                { key: "enterprise" as const, name: "Enterprise", price: "Custom", calls: "Unlimited calls", rpm: "500 req/min", current: false },
              ].map((plan) => (
                <div
                  key={plan.key}
                  className="p-4 space-y-3 rounded-2xl"
                  style={{
                    background: plan.current ? "rgba(108,43,217,0.15)" : "rgba(255,255,255,0.03)",
                    border: plan.current ? "1px solid rgba(108,43,217,0.4)" : "1px solid rgba(255,255,255,0.07)",
                  }}
                >
                  <div className="flex items-baseline justify-between">
                    <span className="font-semibold">{plan.name}</span>
                    <span className="text-white/40 text-sm">{plan.price}/mo</span>
                  </div>
                  <ul className="space-y-1">
                    {[plan.calls, plan.rpm].map((item) => (
                      <li key={item} className="text-xs text-white/50 flex items-center gap-1.5">
                        <svg className="w-3 h-3 text-[#a78bfa]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        {item}
                      </li>
                    ))}
                  </ul>
                  {plan.current ? (
                    <span className="block text-center text-xs font-medium text-[#a78bfa] py-1.5">Current plan</span>
                  ) : (
                    <button
                      onClick={() => plan.key === "enterprise" ? window.open("mailto:hello@synclyst.app?subject=Enterprise API", "_blank") : subscribe(plan.key)}
                      disabled={subscribing}
                      className="w-full text-sm font-medium py-2 rounded-full transition-all disabled:opacity-40"
                      style={{ background: "#6c2bd9" }}
                    >
                      {subscribing ? "Redirecting…" : plan.key === "enterprise" ? "Contact us" : `Upgrade to ${plan.name}`}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="px-5 pb-4 text-xs text-white/20">
              Billed monthly via Stripe. Cancel anytime. Usage resets on the 1st of each month.
            </p>
          </div>
        )}

        {/* Quick reference */}
        <div style={cardStyle} className="overflow-hidden">
          <div className="px-5 py-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
            <h2 className="font-semibold text-sm">Quick Reference</h2>
          </div>
          <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-5 text-sm">
            <div className="space-y-2">
              <p className="text-xs text-white/25 uppercase tracking-wide">Base URLs</p>
              <div className="space-y-1.5">
                {[
                  { dot: "bg-emerald-500", url: "https://api.synclyst.app/v1/", label: "Production" },
                  { dot: "bg-[#6c2bd9]", url: "https://api.synclyst.app/sandbox/v1/", label: "Sandbox" },
                ].map((row) => (
                  <div key={row.label} className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${row.dot}`} />
                    <code className="text-xs font-mono text-white/50">{row.url}</code>
                    <span className="text-xs text-white/20">{row.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-white/25 uppercase tracking-wide">Auth header</p>
              <code
                className="block text-xs font-mono text-white/60 px-3 py-2 rounded-xl"
                style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.07)" }}
              >
                Authorization: Bearer sk_live_…
              </code>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-white/25 uppercase tracking-wide">Endpoints &amp; pricing</p>
              <div className="space-y-1">
                {[
                  { ep: "POST /v1/extract", cost: "$0.05" },
                  { ep: "GET /v1/market-value", cost: "$0.10" },
                  { ep: "POST /v1/classify", cost: "$0.02" },
                  { ep: "POST /v1/value", cost: "$0.03" },
                ].map((row) => (
                  <div key={row.ep} className="flex items-center justify-between">
                    <code className="text-xs font-mono text-white/40">{row.ep}</code>
                    <span className="text-xs text-white/25">{row.cost}/call</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <p className="text-xs text-white/25 uppercase tracking-wide">Resources</p>
              <div className="space-y-1">
                {[
                  { label: "API Documentation", href: "/developers" },
                  { label: "Error codes", href: "/developers#errors" },
                  { label: "Sandbox guide", href: "/developers#sandbox" },
                ].map((link) => (
                  <a key={link.label} href={link.href} className="flex items-center gap-1.5 text-xs text-[#a78bfa] hover:text-[#c4b5fd] transition-colors">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    {link.label}
                  </a>
                ))}
              </div>
            </div>
          </div>
        </div>

        <p className="text-center text-xs text-white/15 pb-4">
          Questions?{" "}
          <a href="mailto:hello@synclyst.app" className="text-white/30 hover:text-white/60 transition-colors">
            hello@synclyst.app
          </a>
        </p>
      </div>

      {/* Delete modal */}
      {deleteTargetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setDeleteTargetId(null)} />
          <div
            className="relative p-6 max-w-sm w-full shadow-2xl rounded-2xl"
            style={{ background: "#0f0b1a", border: "1px solid rgba(255,255,255,0.1)" }}
          >
            <h3 className="font-semibold text-lg mb-2">Revoke API key?</h3>
            <p className="text-white/40 text-sm mb-6">
              This key stops working immediately. Any applications using it will fail to authenticate. This cannot be undone.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => deleteKey(deleteTargetId)}
                disabled={deleting}
                className="flex-1 font-medium py-2.5 rounded-full transition-all disabled:opacity-40 text-sm"
                style={{ background: "rgba(239,68,68,0.8)" }}
              >
                {deleting ? "Revoking…" : "Yes, revoke"}
              </button>
              <button
                onClick={() => setDeleteTargetId(null)}
                disabled={deleting}
                className="flex-1 font-medium py-2.5 rounded-full text-sm text-white/70 transition-colors"
                style={{ border: "1px solid rgba(255,255,255,0.1)" }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
