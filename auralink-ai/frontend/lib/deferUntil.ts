import { waitUntil } from "@vercel/functions";

/**
 * On Vercel, keeps the invocation alive until work finishes (Shopify webhook ~5s limit).
 * Locally, runs the task fire-and-forget.
 */
export function deferUntil(promise: Promise<unknown>): void {
  const p = promise.catch((e) => console.error("[deferUntil] task failed", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}
