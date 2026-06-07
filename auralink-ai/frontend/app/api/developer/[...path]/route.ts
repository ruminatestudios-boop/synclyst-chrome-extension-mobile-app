import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

/** Dashboard plan quotas (matches DeveloperDashboardClient copy). */
const PLAN_LIMITS: Record<string, number> = {
  free: 50,
  starter: 10_000,
  pro: 50_000,
  enterprise: 999_999,
};

const PLAN_RANK: Record<string, number> = {
  free: 0,
  starter: 1,
  pro: 2,
  enterprise: 3,
};

function getBackendBaseUrl() {
  const raw =
    process.env.NEXT_PUBLIC_API_URL?.trim() ||
    process.env.AURALINK_BACKEND_URL?.trim() ||
    "http://localhost:8000";
  return raw.replace(/\/$/, "");
}

async function getClerkTokenSafe(getToken: (opts?: { template?: string }) => Promise<string | null>) {
  const template = process.env.CLERK_JWT_TEMPLATE?.trim();
  if (!template) return await getToken();
  try {
    return await getToken({ template });
  } catch {
    return await getToken();
  }
}

async function backendFetch(
  path: string,
  token: string,
  init?: RequestInit
): Promise<{ ok: boolean; status: number; data: unknown; raw: string }> {
  const url = `${getBackendBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    ...(init?.body ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers as Record<string, string> | undefined),
  };

  const res = await fetch(url, { ...init, headers, cache: "no-store" });
  const raw = await res.text();
  let data: unknown = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  return { ok: res.ok, status: res.status, data, raw };
}

function errorResponse(status: number, detail: string) {
  return NextResponse.json({ detail }, { status, headers: { "Content-Type": "application/json" } });
}

function highestPlan(plans: string[]): string {
  let best = "free";
  for (const p of plans) {
    const key = (p || "free").toLowerCase();
    if ((PLAN_RANK[key] ?? -1) > (PLAN_RANK[best] ?? -1)) best = key;
  }
  return best;
}

type BackendKey = {
  id: string;
  key_prefix?: string;
  label?: string;
  plan?: string;
  last_used_at?: string | null;
};

async function buildProfile(token: string, userId: string) {
  const [usageRes, keysRes] = await Promise.all([
    backendFetch("/v1/developers/keys/usage", token),
    backendFetch("/v1/developers/keys", token),
  ]);

  if (!usageRes.ok) {
    return errorResponse(usageRes.status, extractDetail(usageRes));
  }
  if (!keysRes.ok) {
    return errorResponse(keysRes.status, extractDetail(keysRes));
  }

  const usage = usageRes.data as {
    total_calls_this_month?: number;
    keys?: Array<{ plan?: string; calls_used?: number; calls_limit?: number | null }>;
  };
  const keys = (Array.isArray(keysRes.data) ? keysRes.data : []) as BackendKey[];

  const plan = highestPlan([
    ...keys.map((k) => k.plan || "free"),
    ...(usage.keys || []).map((k) => k.plan || "free"),
  ]);
  const callsLimit = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const callsUsed = Number(usage.total_calls_this_month ?? 0);

  return NextResponse.json({
    developer_id: userId,
    plan,
    usage: {
      calls_used: callsUsed,
      calls_limit: callsLimit,
      calls_remaining: Math.max(0, callsLimit - callsUsed),
      month_key: new Date().toISOString().slice(0, 7),
      billing_enabled: false,
    },
    keys_count: keys.length,
    keys_limit: 5,
    plan_limits: PLAN_LIMITS,
    use_case_pricing_gbp: {
      reseller: 0.1,
      real_estate: 0.15,
      insurance: 0.2,
      pawnbroker: 0.12,
      invoice: 0.08,
      restaurant: 0.05,
      generic: 0.1,
    },
  });
}

function extractDetail(res: { data: unknown; raw: string }): string {
  if (res.data && typeof res.data === "object" && res.data !== null && "detail" in res.data) {
    const d = (res.data as { detail?: unknown }).detail;
    if (typeof d === "string") return d;
  }
  return res.raw.slice(0, 800) || "Request failed";
}

async function handleRoute(req: Request, pathSegments: string[], token: string, userId: string) {
  const subpath = pathSegments.join("/");

  if (req.method === "GET" && subpath === "profile") {
    return buildProfile(token, userId);
  }

  if (subpath === "keys" || subpath.startsWith("keys/")) {
    if (req.method === "GET" && subpath === "keys") {
      const res = await backendFetch("/v1/developers/keys", token);
      if (!res.ok) return errorResponse(res.status, extractDetail(res));
      const keys = (Array.isArray(res.data) ? res.data : []) as BackendKey[];
      return NextResponse.json({
        keys: keys.map((k) => ({
          id: k.id,
          key_prefix: k.key_prefix,
          label: k.label,
          plan: k.plan,
          last_used_at: k.last_used_at,
        })),
      });
    }

    if (req.method === "POST" && subpath === "keys") {
      const body = await req.text();
      const res = await backendFetch("/v1/developers/keys", token, { method: "POST", body });
      if (!res.ok) return errorResponse(res.status, extractDetail(res));
      const created = res.data as { key?: string; id?: string };
      return NextResponse.json({
        api_key: created.key,
        id: created.id,
      });
    }

    const revokeMatch = subpath.match(/^keys\/([^/]+)$/);
    if (req.method === "DELETE" && revokeMatch) {
      const res = await backendFetch(`/v1/developers/keys/${revokeMatch[1]}`, token, {
        method: "DELETE",
      });
      if (!res.ok) return errorResponse(res.status, extractDetail(res));
      return NextResponse.json(res.data ?? { revoked: true });
    }
  }

  return errorResponse(404, "Not Found");
}

async function proxy(req: Request, pathSegments: string[]) {
  const { userId, getToken } = await auth();
  if (!userId) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const token = await getClerkTokenSafe(getToken);
  if (!token) return NextResponse.json({ error: "missing_token" }, { status: 401 });

  return handleRoute(req, pathSegments, token, userId);
}

type RouteCtx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function DELETE(req: Request, ctx: RouteCtx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
