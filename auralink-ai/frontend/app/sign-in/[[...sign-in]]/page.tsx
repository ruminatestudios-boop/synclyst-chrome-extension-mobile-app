import { SignInForm } from "./sign-in-form";

function safeRedirectPath(value: string | string[] | undefined): string {
  const v = Array.isArray(value) ? value[0] : value;
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//")) {
    return "/dashboard/home";
  }
  if (v === "/dashboard") {
    return "/dashboard/home";
  }
  return v;
}

type PageProps = {
  searchParams: Promise<{
    redirect_url?: string | string[];
    /** e.g. Chrome extension passes this alongside `redirect_url` for some OAuth clients */
    after_sign_in_url?: string | string[];
  }>;
};

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

export default async function SignInPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const redirect = safeRedirectPath(
    firstString(params.redirect_url) ?? firstString(params.after_sign_in_url)
  );
  const signUpUrl = `/sign-up?redirect_url=${encodeURIComponent(redirect)}&after_sign_up_url=${encodeURIComponent(redirect)}`;

  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "clamp(1.25rem, 4vh, 2.5rem) clamp(1rem, 4vw, 2.5rem)",
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        WebkitFontSmoothing: "antialiased",
        background: "#f0ebf9",
        color: "#111827",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <style>{`
        html, body { background: #f0ebf9 !important; }
      `}</style>
      <div style={{ width: "100%", maxWidth: "min(28rem, calc(100vw - 2rem))" }}>
        <div style={{ textAlign: "center", marginBottom: "1rem" }}>
          <p style={{ margin: 0, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1.2 }}>
            SyncLyst<sup style={{ fontSize: "0.55em", fontWeight: 400, opacity: 0.85, verticalAlign: "super" }}>®</sup>
          </p>
          <p style={{ margin: "0.15rem 0 0", color: "#6b7280", fontSize: "0.875rem", lineHeight: 1.35 }}>
            Your listing workflow on autopilot
          </p>
        </div>

        <div
          style={{
            borderRadius: 20,
            background: "#ffffff",
            boxShadow: "0 4px 36px rgba(15, 23, 42, 0.08)",
            padding: "clamp(1.15rem, 2.1vw, 1.7rem) clamp(1.05rem, 3vw, 1.6rem)",
          }}
        >
          <SignInForm forceRedirectUrl={redirect} signUpUrl={signUpUrl} />
        </div>
      </div>
    </div>
  );
}
