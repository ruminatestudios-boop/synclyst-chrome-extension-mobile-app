import Link from "next/link";

export const metadata = {
  title: "Privacy Policy – SyncLyst",
  description: "Privacy Policy for SyncLyst. How we collect, use, and protect your information.",
};

export default function PrivacyPage() {
  return (
    <div className="legal-page-root">
      <header className="fixed top-0 left-0 right-0 z-50 bg-white/80 backdrop-blur-md border-b border-[#eaeaea]">
        <nav
          className="max-w-7xl mx-auto px-6 h-16 grid grid-cols-3 items-center relative"
          aria-label="Main"
        >
          {/* Keep side columns empty: logo is truly centered on desktop. */}
          <div aria-hidden="true" />
          <Link
            href="/landing.html"
            className="legal-logo-link inline-flex items-center justify-center justify-self-center no-underline leading-none py-0.5"
          >
            <span className="text-lg font-medium tracking-tight text-[#111]">
              Synclyst <sup className="text-[0.55em] font-normal opacity-90 relative -top-[0.15em]">®</sup>
            </span>
          </Link>
          <div aria-hidden="true" />
        </nav>
      </header>

      <main className="legal-main">
        <article className="legal-article legal-prose">
          <h1>Privacy Policy</h1>
          <p className="legal-updated">Last Updated: April 2026</p>

          <section>
            <h2>Introduction</h2>
            <p>
              SyncLyst AI (&quot;we&quot;, &quot;our&quot;, or &quot;us&quot;) operates the Synclyst application and
              Synclyst.app. This Privacy Policy explains how we collect, use, and protect your information when you use
              our service, including when you install or use SyncLyst as a Shopify merchant.
            </p>
          </section>

          <section>
            <h2>1. Information We Collect</h2>
            <ul>
              <li>
                <strong>Merchant Account Information:</strong> When you install the app via Shopify OAuth, we collect
                your name, email address, and shop domain to manage your account and billing.
              </li>
              <li>
                <strong>Product Data &amp; Photos:</strong> Images you upload to generate listings. These are processed
                by our AI and deleted from our servers within 24 hours.
              </li>
              <li>
                <strong>Usage Data:</strong> Information about scans performed, listings created, and features
                accessed to improve app performance.
              </li>
              <li>
                <strong>Payment:</strong> Billing is handled via Shopify&apos;s Billing API or a secure third-party
                processor. We do not store your credit card details.
              </li>
            </ul>
          </section>

          <section>
            <h2>2. How We Use Your Information</h2>
            <p>
              We use your data to provide core services: generating product listings from photos and syncing them to
              your connected platforms (Shopify, Etsy, eBay, etc.). We use anonymized, aggregated data to improve our
              AI models. We do not sell your personal data to third parties.
            </p>
          </section>

          <section>
            <h2>3. Shopify Mandatory Webhooks &amp; GDPR Compliance</h2>
            <p>
              Synclyst is fully compliant with Shopify&apos;s mandatory privacy requirements. We have implemented the
              following webhooks to protect your data:
            </p>
            <ul>
              <li>
                <strong>customers/data_request:</strong> Although Synclyst does not store customer personal data, we
                provide a structured response to any request from Shopify on behalf of a customer.
              </li>
              <li>
                <strong>customers/redact:</strong> We automatically fulfill requests to delete customer personal data if
                any were transiently processed.
              </li>
              <li>
                <strong>shop/redact:</strong> Within 48 hours of you uninstalling the app, we purge all shop-related data
                and access tokens from our database.
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Third-Party Integrations</h2>
            <p>
              When you connect SyncLyst to a third-party platform (e.g., eBay), you authorize us to access and write to
              that platform on your behalf. We only request the minimum permissions necessary. You can disconnect
              integrations at any time from your dashboard.
            </p>
          </section>

          <section>
            <h2>5. Data Security</h2>
            <p>
              We use industry-standard TLS/HTTPS encryption. Access to user data is restricted to authorized personnel
              only.
            </p>
          </section>

          <section>
            <h2>6. Your Rights (UK/EEA/US State Laws)</h2>
            <p>
              Under GDPR and evolving US state privacy laws (CCPA/Indiana/Kentucky/Rhode Island), you have the right to
              access, correct, or delete your data. To exercise these rights, contact us at:{" "}
              <a href="mailto:synclyst@gmail.com">synclyst@gmail.com</a>
            </p>
          </section>

          <section>
            <h2>7. Changes &amp; Contact</h2>
            <p>We may update this policy. Significant changes will be notified via email.</p>
            <p>
              Contact: <a href="mailto:synclyst@gmail.com">synclyst@gmail.com</a>
            </p>
          </section>
        </article>
      </main>
    </div>
  );
}
