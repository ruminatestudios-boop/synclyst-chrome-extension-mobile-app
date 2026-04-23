import type { Metadata } from "next";

/**
 * Fallback when middleware / rewrites do not map `/snap` → `public/snap.html` (some hosts).
 * Embeds the static pairing page so `https://synclyst.app/snap?s=…` always works.
 */
export const metadata: Metadata = {
  title: "Pair with desktop — SyncLyst®",
  description: "Upload a photo to pair with the SyncLyst® browser extension.",
};

function snapHtmlSrc(searchParams: Record<string, string | string[] | undefined>) {
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
  return `/snap.html${qs ? `?${qs}` : ""}`;
}

export default async function SnapPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const src = snapHtmlSrc(sp);
  return (
    <iframe
      title="Pair with desktop — SyncLyst®"
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
