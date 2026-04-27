/**
 * Shown while the server resolves `searchParams` and streams the sign-in page.
 * Without this, users often see an empty card until the RSC + Clerk client hydrate.
 */
export default function SignInLoading() {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "clamp(1.25rem, 4vh, 2.5rem) clamp(1rem, 4vw, 2.5rem)",
        fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
        background: "#f0ebf9",
        color: "#111827",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        boxSizing: "border-box",
      }}
    >
      <div style={{ width: "100%", maxWidth: "min(28rem, calc(100vw - 2rem))" }}>
        <div style={{ textAlign: "center", marginBottom: "1rem" }}>
          <p
            style={{
              margin: 0,
              fontWeight: 800,
              letterSpacing: "-0.02em",
              lineHeight: 1.2,
            }}
          >
            SyncLyst
            <sup
              style={{
                fontSize: "0.55em",
                fontWeight: 400,
                opacity: 0.85,
                verticalAlign: "super",
              }}
            >
              ®
            </sup>
          </p>
          <p
            style={{
              margin: "0.15rem 0 0",
              color: "#6b7280",
              fontSize: "0.875rem",
              lineHeight: 1.35,
            }}
          >
            Your listing workflow on autopilot
          </p>
        </div>
        <div
          style={{
            borderRadius: 20,
            background: "#ffffff",
            boxShadow: "0 4px 36px rgba(15, 23, 42, 0.08)",
            padding: "clamp(1.15rem, 2.1vw, 1.7rem) clamp(1.05rem, 3vw, 1.6rem)",
            minHeight: 280,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 20,
            textAlign: "center",
          }}
        >
          <style>{`
            @keyframes synclyst-spin {
              to { transform: rotate(360deg); }
            }
            .synclyst-signin-load-ring {
              width: 40px; height: 40px; border-radius: 50%;
              border: 3px solid #e9d5ff;
              border-top-color: #6d28d9;
              animation: synclyst-spin 0.85s linear infinite;
            }
          `}</style>
          <div className="synclyst-signin-load-ring" aria-hidden role="status" aria-label="Loading" />
          <div>
            <p style={{ margin: "0 0 6px", fontSize: "0.9rem", fontWeight: 600, color: "#111827" }}>
              Please wait
            </p>
            <p style={{ margin: 0, fontSize: "0.875rem", color: "#6b7280", lineHeight: 1.45 }}>
              Preparing sign-in…
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
