"use client";

import { SignIn } from "@clerk/nextjs";
import { synclystClerkAppearance } from "@/lib/synclyst-clerk-appearance";

const clerkPublishableKey =
  typeof process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY === "string"
    ? process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY.trim()
    : "";
export function SignInForm({
  forceRedirectUrl,
  signUpUrl,
}: {
  forceRedirectUrl: string;
  signUpUrl: string;
}) {
  if (!clerkPublishableKey) {
    return (
      <div className="max-w-md text-center space-y-4 px-4">
        <h1 className="text-xl font-semibold text-zinc-900">Sign in</h1>
        <p className="text-sm text-zinc-600 leading-relaxed">
          Clerk isn&apos;t configured. Add{" "}
          <code className="text-xs bg-zinc-200/80 px-1.5 py-0.5 rounded">
            NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
          </code>{" "}
          (and{" "}
          <code className="text-xs bg-zinc-200/80 px-1.5 py-0.5 rounded">CLERK_SECRET_KEY</code>
          ) to your environment, then
          restart the dev server.
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
    <SignIn
      forceRedirectUrl={forceRedirectUrl}
      afterSignInUrl={forceRedirectUrl}
      redirectUrl={forceRedirectUrl}
      signUpUrl={signUpUrl}
      appearance={embeddedAppearance}
    />
  );
}
