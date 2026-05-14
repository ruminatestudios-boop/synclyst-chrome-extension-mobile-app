"use client";

import { SignIn } from "@clerk/nextjs";

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

  return (
    <>
      <p className="mb-3 text-center text-xs text-zinc-500 max-w-sm mx-auto">
        New to SyncLyst?{" "}
        <a href={signUpUrl} className="font-semibold text-zinc-800 underline">
          Create an account
        </a>{" "}
        first. Sign-in below is for returning users.
      </p>
      <SignIn forceRedirectUrl={forceRedirectUrl} signUpUrl={signUpUrl} />
    </>
  );
}
