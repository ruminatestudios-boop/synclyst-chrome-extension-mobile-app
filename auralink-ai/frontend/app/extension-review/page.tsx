import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Review | SyncLyst®",
  description: "Review and save your scanned listing before Magic Fill.",
};

/**
 * Serves public/extension-review.html via iframe — same pattern as /snap → snap.html.
 * The beforeFiles rewrite in next.config.mjs is a fallback; this App Router page is primary.
 */
function buildSrc(searchParams: Record<string, string | string[] | undefined>) {
  const q = new URLSearchParams();
  for (const [key, val] of Object.entries(searchParams)) {
    if (val === undefined) continue;
    if (Array.isArray(val)) {
      val.forEach((v) => q.append(key, v));
    } else {
      q.set(key, val);
    }
  }
  const qs = q.toString();
  return `/extension-review.html${qs ? `?${qs}` : ""}`;
}

export default async function ExtensionReviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const src = buildSrc(sp);
  return (
    <iframe
      title="SyncLyst® — Review listing"
      src={src}
      style={{
        border: "none",
        display: "block",
        width: "100%",
        height: "100vh",
      }}
    />
  );
}
