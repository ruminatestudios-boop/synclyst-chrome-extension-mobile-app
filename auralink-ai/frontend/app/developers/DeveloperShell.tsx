"use client";

import Link from "next/link";
import { UserButton, useAuth } from "@clerk/nextjs";
import styles from "./developers.module.css";

const MARKETING = "https://synclyst.app";

type Props = {
  children: React.ReactNode;
  wide?: boolean;
  active?: "docs" | "dashboard";
};

export default function DeveloperShell({ children, wide, active = "docs" }: Props) {
  const { isSignedIn } = useAuth();

  return (
    <div className={styles.page}>
      <div className={styles.wrap}>
        <header className={styles.nav}>
          <div className={styles.navInner}>
            <div className={styles.navLeft}>
              <nav className={styles.navLinks} aria-label="Marketing">
                <a className={styles.navLink} href={`${MARKETING}/#integrations`}>
                  Integrations
                </a>
                <a className={styles.navLink} href={`${MARKETING}/#stack`}>
                  Full Stack
                </a>
                <a className={styles.navLink} href={`${MARKETING}/#pricing`}>
                  Pricing
                </a>
              </nav>
            </div>

            <Link href={MARKETING} className={styles.brand}>
              SyncLyst<sup>®</sup>
            </Link>

            <div className={styles.navRight}>
              <Link
                href="/developers"
                className={`${styles.navLink} ${active === "docs" ? styles.navLinkActive : ""}`}
              >
                Docs
              </Link>
              <Link
                href="/developers/dashboard"
                className={`${styles.navLink} ${active === "dashboard" ? styles.navLinkActive : ""}`}
              >
                Dashboard
              </Link>
              {isSignedIn ? (
                <UserButton afterSignOutUrl="/developers" />
              ) : (
                <Link href="/sign-in?redirect_url=/developers/dashboard" className={styles.btnNav}>
                  Sign in
                </Link>
              )}
            </div>
          </div>
        </header>

        <main className={`${styles.main} ${wide ? styles.mainWide : ""}`}>{children}</main>

        <footer className={styles.footer}>
          <span>© SyncLyst · </span>
          <a href={`${MARKETING}/`}>synclyst.app</a>
          <span> · </span>
          <a href="mailto:synclyst@gmail.com">synclyst@gmail.com</a>
        </footer>
      </div>
    </div>
  );
}
