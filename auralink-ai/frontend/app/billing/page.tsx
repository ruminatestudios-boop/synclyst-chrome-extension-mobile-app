import { redirect } from "next/navigation";

type BillingTier = "pro" | "growth" | "scale";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const tierRaw = typeof sp.tier === "string" ? sp.tier : Array.isArray(sp.tier) ? sp.tier[0] : "";
  const canceledRaw =
    typeof sp.canceled === "string" ? sp.canceled : Array.isArray(sp.canceled) ? sp.canceled[0] : "";

  const tier = (tierRaw || "").toLowerCase();
  const canceled = canceledRaw === "1";

  const q = new URLSearchParams();
  q.set("pricing", "1");
  if (canceled) q.set("canceled", "1");
  if (tier === "pro" || tier === "growth" || tier === "scale") q.set("tier", tier satisfies BillingTier);

  redirect(`/dashboard?${q.toString()}`);
}
