/**
 * API client with optional Clerk auth.
 * Pass token from useAuth().getToken() for protected routes.
 */
/** Set NEXT_PUBLIC_API_URL on Vercel, or AURALINK_BACKEND_URL (mapped in next.config.ts). */
export const API_BASE = (process.env.NEXT_PUBLIC_API_URL || "").trim();

export async function apiFetch(
  path: string,
  options: RequestInit & { token?: string | null } = {}
): Promise<Response> {
  const { token, ...init } = options;
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const p = String(path || "");
  const isAbs = /^https?:\/\//i.test(p);
  const base = API_BASE.replace(/\/$/, "");
  const url = isAbs ? p : base ? `${base}${p}` : p;
  return fetch(url, { ...init, headers });
}
