import { createHash } from "crypto";

const ANON_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isValidAnonUuid(value: string): boolean {
  return ANON_UUID_RE.test(String(value || "").trim());
}

/** Stable guest id when the browser cannot persist localStorage (private mode, etc.). */
export function anonIdFromSession(sessionId: string): string {
  const hash = createHash("sha256").update(`synclyst:snap-anon:${sessionId}`).digest("hex");
  const variant = ((parseInt(hash.slice(16, 18), 16) & 0x3) | 0x8).toString(16);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${variant}${hash.slice(18, 20)}-${hash.slice(20, 32)}`;
}

export function resolveVisionAnonId(request: Request, sessionId: string): string {
  const raw = (
    request.headers.get("x-synclyst-anon-id") ||
    request.headers.get("X-SyncLyst-Anon-Id") ||
    ""
  ).trim();
  if (raw && isValidAnonUuid(raw)) return raw;
  return anonIdFromSession(sessionId);
}
