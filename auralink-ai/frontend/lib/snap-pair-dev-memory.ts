/**
 * In-memory snap pair rows for local dev when Supabase env is unset.
 * Only active when NODE_ENV === "development" — never in production builds.
 */

export type SnapPairRow = {
  session_id: string;
  title: string;
  description: string;
  price: string;
  image_url: string | null;
  /** Shopify full review and future platform-specific fields (JSON object). */
  listing_extra: Record<string, unknown> | null;
  updated_at: string;
};

const store = new Map<string, SnapPairRow>();

export function snapPairDevMemoryActive(): boolean {
  return process.env.NODE_ENV === "development";
}

export function devRegisterSession(sessionId: string) {
  if (!store.has(sessionId)) {
    store.set(sessionId, {
      session_id: sessionId,
      title: "",
      description: "",
      price: "",
      image_url: null,
      listing_extra: {},
      updated_at: new Date().toISOString(),
    });
  }
}

export function devUpsert(row: SnapPairRow) {
  store.set(row.session_id, { ...row, updated_at: new Date().toISOString() });
}

export function devGet(sessionId: string): SnapPairRow | undefined {
  return store.get(sessionId);
}
