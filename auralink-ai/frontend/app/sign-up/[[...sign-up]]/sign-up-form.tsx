"use client";

import Link from "next/link";
import { SignUp } from "@clerk/nextjs";
import { synclystClerkAppearance } from "@/lib/synclyst-clerk-appearance";

const clerkPublishableKey =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string"
    ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim()
    : "";
const hideSocialAuth = process.env.NODE_ENV !== "production";

export function SignUpForm({
  forceRedirectUrl,
  signInUrl,
}: {
  forceRedirectUrl: string;
  signInUrl: string;
}) {
  if (!clerkPublishableKey) {
    return (
      <div className="max-w-md text-center space-y-4 px-4">
        <h1 className="text-xl font-semibold text-zinc-900">Create account</h1>
        <p className="text-sm text-zinc-600 leading-relaxed">
          Clerk isn&apos;t configured locally. Add{" "}
          <code className="text-xs bg-zinc-200/80 px-1.5 py-0.5 rounded">
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
          </code>{" "}
          to{" "}
          <code className="text-xs bg-zinc-200/80 px-1.5 py-0.5 rounded">.env.local</code>, then
          restart the dev server.
        </p>
        <Link
          href="/dashboard/home"
          className="inline-block bg-zinc-900 text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          Continue to dashboard (dev)
        </Link>
        <p className="text-sm">
          <Link href={signInUrl} className="text-zinc-700 underline hover:text-zinc-900">
            Sign in
          </Link>
        </p>
      </div>
    );
  }

  const embeddedAppearance = {
    ...synclystClerkAppearance,
    elements: {
      ...(synclystClerkAppearance.elements ?? {}),
      rootBox: "w-full",
      cardBox: "shadow-none border-0 bg-transparent p-0",
      card: "shadow-none border-0 rounded-none bg-transparent p-0",
      footer: "shadow-none border-0",
    },
  };

  return (
    <SignUp
      forceRedirectUrl={forceRedirectUrl}
      afterSignUpUrl={forceRedirectUrl}
      redirectUrl={forceRedirectUrl}
      signInUrl={signInUrl}
      appearance={
        hideSocialAuth
          ? {
              ...embeddedAppearance,
              elements: {
                ...(embeddedAppearance.elements ?? {}),
                socialButtonsBlockButton: "hidden",
                dividerRow: "hidden",
              },
            }
          : embeddedAppearance
      }
    />
  );
}
