/* API origin: from repo root run `npm run extension:manifest` (store) or `npm run extension:manifest:dev` (local) — see extension/build-manifest.mjs. */
/* Store build: default host is synclyst.app (HTTPS). Prod CSP blocks loopback; use dev manifest for Next on port 3000. */
/* Dev build: default 127.0.0.1:3000. Override: chrome.storage.local key synclyst_origin, or open /snap on that host. */
function defaultSynclystOriginFromManifest() {
  try {
    const man = chrome.runtime.getManifest();
    const chunks = [...(man.host_permissions || [])];
    for (const cs of man.content_scripts || []) {
      for (const x of cs.matches || []) chunks.push(x);
    }
    const blob = chunks.join("\n");
    const devish =
      blob.includes("localhost") ||
      blob.includes("127.0.0.1") ||
      blob.includes("http://*/*");
    return devish ? "http://127.0.0.1:3000" : "https://synclyst.app";
  } catch {
    return "https://synclyst.app";
  }
}
const SYNCLYST_ORIGIN_DEFAULT = defaultSynclystOriginFromManifest();
const SYNCLYST_ORIGIN_LIVE = "https://synclyst.app";

/** When set (e.g. from /local-test), overrides automatic discovery. */
const STORAGE_ORIGIN_MANUAL = "synclyst_origin";

/** Last working auto origin (LAN or 127.0.0.1); cleared if it stops responding. */
const STORAGE_ORIGIN_AUTO = "synclyst_origin_auto";

/** Resolved after storage read — all fetches use this. */
let SYNCLYST_ORIGIN = SYNCLYST_ORIGIN_DEFAULT;

/**
 * Extension popups will stay blank forever if fetch() never settles (e.g. stalled TCP to a LAN IP).
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function validateSnapPairOrigin(origin) {
  const base = String(origin || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return false;
  try {
    const r = await fetchWithTimeout(`${base}/api/snap-pair/config`, { cache: "no-store" }, 2200);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * If the user has SyncLyst open (e.g. `/snap?s=...` or `/extension-review?...`), prefer that same origin.
 * This avoids "extracted on snap page, empty in popup" when local dev uses in-memory sessions and the
 * popup falls back to a different reachable origin (cached LAN / live).
 */
async function pickOriginFromOpenSynclystTab() {
  const tryUrl = (raw) => {
    if (!raw) return null;
    try {
      const u = new URL(String(raw));
      const p = (u.pathname || "").replace(/\/$/, "");
      const okPath =
        p === "/snap" ||
        p === "/snap.html" ||
        p === "/extension-review" ||
        p.startsWith("/extension-review/");
      if (!okPath) return null;
      if (!/^https?:\/\//i.test(u.origin)) return null;
      return u.origin;
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    try {
      // All windows: `/snap` is often in another window while the user lists from Shopify/eBay.
      chrome.tabs.query({}, (tabs) => {
        try {
          const list = tabs || [];
          // Prefer the focused window’s active tab when it is snap/review (one active tab per window; pick first match).
          const active = list.find((t) => t && t.active);
          const fromActive = tryUrl(active && active.url);
          if (fromActive) return resolve(fromActive);
          for (const t of list) {
            const o = tryUrl(t && t.url);
            if (o) return resolve(o);
          }
        } catch {
          /* ignore */
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** WebRTC host candidates → IPv4 addresses (same machine as the extension). */
function gatherLanIPv4Candidates(maxMs) {
  return new Promise((resolve) => {
    const found = new Set();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        pc && pc.close();
      } catch {
        /* ignore */
      }
      resolve([...found]);
    };
    const t = setTimeout(done, maxMs);
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("synclyst");
      pc
        .createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => {
          clearTimeout(t);
          done();
        });
      pc.onicecandidate = (e) => {
        if (!e || !e.candidate) return;
        const c = e.candidate.candidate || "";
        const parts = c.split(" ");
        for (const p of parts) {
          if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(p) && !p.startsWith("127.")) {
            found.add(p);
          }
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          done();
        }
      };
    } catch {
      clearTimeout(t);
      done();
    }
  });
}

function lanIpSortKey(ip) {
  const p = String(ip).split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return 99;
  if (p[0] === 192 && p[1] === 168) return 0;
  if (p[0] === 10) return 1;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 2;
  return 3;
}

/**
 * Prefer a validated SyncLyst `/snap` (or review) tab origin when present — this is what makes local
 * phone→desktop E2E reliable even if `synclyst_origin` was previously set to production.
 * Next: manual `synclyst_origin` (if any), then a validated auto cache, then discovery
 * (127.0.0.1/localhost, then LAN for phone), else SYNCLYST_ORIGIN_DEFAULT.
 */
async function resolveSynclystOrigin() {
  const o = await storageGet([STORAGE_ORIGIN_MANUAL, STORAGE_ORIGIN_AUTO]);
  const manual = o[STORAGE_ORIGIN_MANUAL] != null ? String(o[STORAGE_ORIGIN_MANUAL]).trim() : "";
  const manualBase = manual && /^https?:\/\//i.test(manual) ? manual.replace(/\/$/, "") : "";

  // If SyncLyst is open in a tab, prefer that exact origin (especially for local /snap E2E).
  // A stale manual `synclyst_origin` pointing at production is a common footgun: it will make the
  // extension poll https://synclyst.app while the phone /snap page writes to local Next, so the modal
  // never populates. In that case, override + clear the manual key.
  const tabOrigin = await pickOriginFromOpenSynclystTab();
  if (tabOrigin) {
    const ok = await validateSnapPairOrigin(tabOrigin);
    if (ok) {
      const t = tabOrigin.replace(/\/$/, "");
      const isLocal =
        t.startsWith("http://127.0.0.1:") || t.startsWith("http://localhost:") || t.startsWith("http://[::1]:");
      if (manualBase) {
        const manualIsLocal =
          manualBase.startsWith("http://127.0.0.1:") ||
          manualBase.startsWith("http://localhost:") ||
          manualBase.startsWith("http://[::1]:");
        const manualIsLive = manualBase === SYNCLYST_ORIGIN_LIVE;
        // Phone snap on local Next + stale manual to prod (or any mismatch) → prefer the tab.
        if (manualBase !== t && (isLocal !== manualIsLocal)) {
          try {
            chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
              /* ignore */
            });
          } catch {
            /* ignore */
          }
        } else if (isLocal && manualIsLive) {
          // Open tab is local, manual points at production → always prefer local for dev flows.
          try {
            chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
              /* ignore */
            });
          } catch {
            /* ignore */
          }
        } else {
          // Manual matches reality — keep it.
        }
      }
      try {
        chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: t });
      } catch {
        /* ignore */
      }
      if (!manualBase || manualBase === t) {
        // manual absent or already aligned
        return t;
      }
      // If we didn't clear `manual` above, respect it.
      if (manualBase) {
        const mOk = await validateSnapPairOrigin(manualBase);
        if (mOk) return manualBase;
        try {
          chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
        return t;
      }
    }
  }

  if (manual && /^https?:\/\//i.test(manual)) {
    return manual.replace(/\/$/, "");
  }

  const cached = o[STORAGE_ORIGIN_AUTO] != null ? String(o[STORAGE_ORIGIN_AUTO]).trim() : "";
  if (cached && /^https?:\/\//i.test(cached)) {
    const base = cached.replace(/\/$/, "");
    if (await validateSnapPairOrigin(base)) {
      return base;
    }
    chrome.storage.local.remove([STORAGE_ORIGIN_AUTO]);
  }

  const ports = [3000, 3001, 3002];
  const localHosts = ["127.0.0.1", "localhost"];
  let portFound = null;
  let originLocal = null;
  for (const port of ports) {
    for (const host of localHosts) {
      const origin = `http://${host}:${port}`;
      if (await validateSnapPairOrigin(origin)) {
        portFound = port;
        originLocal = origin;
        break;
      }
    }
    if (portFound) break;
  }

  if (!portFound || !originLocal) {
    if (await validateSnapPairOrigin(SYNCLYST_ORIGIN_LIVE)) {
      const live = SYNCLYST_ORIGIN_LIVE.replace(/\/$/, "");
      try {
        chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: live });
      } catch {
        /* ignore */
      }
      return live;
    }
    return SYNCLYST_ORIGIN_DEFAULT;
  }

  const candidates = await gatherLanIPv4Candidates(900);
  candidates.sort((a, b) => lanIpSortKey(a) - lanIpSortKey(b) || String(a).localeCompare(String(b)));

  for (const ip of candidates) {
    const origin = `http://${ip}:${portFound}`;
    if (await validateSnapPairOrigin(origin)) {
      const clean = origin.replace(/\/$/, "");
      chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: clean });
      return clean;
    }
  }

  const fallback = originLocal.replace(/\/$/, "");
  chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: fallback });
  return fallback;
}

let lastPayload = null;
/** Set in init after pairing session id is resolved (full-page review URL). */
let snapPairSessionId = null;
/** After first listing load; further updates with the same image preserve step 2 platform selection. */
let listingHydrated = false;
let lastAppliedImageUrl = null;
let pollTimer = null;
let realtimeChannel = null;
let supabaseClient = null;
/** When true, user chose “home” (QR screen); listing updates still apply in the background. */
let qrHomeActive = false;
/** Last `updated_at` (or stable fallback) we applied — avoids duplicate auto-advance + detects new scans. */
let lastAppliedListingStamp = null;
/** One-shot: skip auto-advance when re-applying an existing listing while restoring QR home from storage. */
/** When true, we just received a "new scan/upload" signal and are waiting for listing content. */
let extractionPending = false;

function refreshLoadedSubstate() {
  const waiting = document.getElementById("loaded-waiting");
  const main = document.getElementById("loaded-main");
  if (!waiting || !main) return;
  const hasListing = listingHydrated && sessionListingHasContent(lastPayload);
  // Only show the waiting screen when there is no listing and we're NOT actively extracting.
  const showWaiting = !hasListing && !extractionPending;
  waiting.classList.toggle("hidden", !showWaiting);
  main.classList.toggle("hidden", showWaiting);
}

/** Persisted in chrome.storage.local — survives popup close / Magic Fill / new scans. */
const STORAGE_LAST_PLATFORM = "synclyst_last_platform";
const STORAGE_PREFERS_QR_HOME = "synclyst_prefers_qr_home";
const STORAGE_SNAP_LISTING_READY_AT = "synclyst_snap_listing_ready_at";

/** Same keys as auralink-ai/frontend/public/payment-success.html → tier-bridge.js → chrome.storage.local */
const STORAGE_SYNC_TIER = "synclyst_tier";
const STORAGE_PLAN_RENEWAL = "synclyst_plan_renewal";
/** Last tapped plan row in Settings → Payments (selection highlight + billing deep link). */
const STORAGE_PREF_BILLING_TIER = "synclyst_pref_billing_tier";
/** Signed-in status for billing UI (derived from synclyst.app Clerk cookies). */
let billingSignedIn = null;
let billingEmail = "";

function setBillingMsg(text) {
  const el = document.getElementById("settings-billing-msg");
  if (!el) return;
  const msg = String(text || "").trim();
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (o) => resolve(o || {}));
  });
}

function normalizeBillingTier(raw) {
  const t = raw != null ? String(raw).trim().toLowerCase() : "";
  return t === "pro" || t === "growth" || t === "scale" || t === "starter" ? t : "starter";
}

function billingTierLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function refreshSettingsTierDisplay() {
  try {
    chrome.storage.local.get(
      [STORAGE_SYNC_TIER, STORAGE_PLAN_RENEWAL, STORAGE_PREF_BILLING_TIER],
      (o) => {
        const current = normalizeBillingTier(o && o[STORAGE_SYNC_TIER]);
        const strong = document.getElementById("settings-current-tier");
        const hint = document.getElementById("settings-tier-hint");
        if (strong) strong.textContent = billingTierLabel(current);
        if (hint) {
          const renewal = o && o[STORAGE_PLAN_RENEWAL] != null ? String(o[STORAGE_PLAN_RENEWAL]).trim() : "";
          hint.textContent = renewal ? ` · Renews ~${renewal}` : "";
        }
        const prefRaw = o && o[STORAGE_PREF_BILLING_TIER];
        const pref =
          prefRaw != null && String(prefRaw).trim() !== "" ? normalizeBillingTier(prefRaw) : current;
        document.querySelectorAll("#settings-plan-grid .settings-plan-row[data-billing-tier]").forEach((el) => {
          const t = String(el.dataset.billingTier).toLowerCase();
          el.classList.toggle("is-selected", t === pref);
          el.classList.toggle("is-current", t === current);
          el.setAttribute("aria-checked", t === pref ? "true" : "false");

          // Current plan button should never be clickable.
          const btn = el.querySelector && el.querySelector(".settings-plan-open[data-billing-tier]");
          if (btn) {
            if (t === current) {
              btn.disabled = true;
              btn.classList.add("is-disabled");
              btn.setAttribute("aria-disabled", "true");
              btn.textContent = "Current";
            } else if (t === "starter") {
              // Starter is the only non-paid tier; keep its CTA copy.
              btn.disabled = false;
              btn.classList.remove("is-disabled");
              btn.removeAttribute("aria-disabled");
              btn.textContent = "Free signup";
            } else {
              // Paid tier buttons are handled by refreshSettingsBillingAuthUI (sign-in gating / upgrade copy).
              btn.disabled = false;
              btn.removeAttribute("aria-disabled");
            }
          }
        });
      }
    );
  } catch {
    /* ignore */
  }
}

function setPrefBillingTier(tier) {
  const t = normalizeBillingTier(tier);
  try {
    chrome.storage.local.set({ [STORAGE_PREF_BILLING_TIER]: t }, () => refreshSettingsTierDisplay());
  } catch {
    refreshSettingsTierDisplay();
  }
}

async function fetchBillingAuthSummary() {
  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return { signedIn: false };
    const r = await fetchWithTimeout(`${base}/api/clerk/user-summary`, { credentials: "include", cache: "no-store" }, 7000);
    if (!r.ok) return { signedIn: false };
    const j = await r.json().catch(() => ({}));
    return j && typeof j === "object" ? j : { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}

function refreshSettingsBillingAuthUI() {
  const authCard = document.getElementById("settings-auth");
  const title = document.getElementById("settings-auth-title");
  const sub = document.getElementById("settings-auth-sub");
  const pill = document.getElementById("settings-auth-pill");
  const btn = document.getElementById("btn-settings-signin");
  const signed = !!billingSignedIn;
  if (authCard) authCard.classList.remove("hidden");
  if (pill) {
    pill.textContent =
      billingSignedIn === null
        ? "Checking sign-in…"
        : signed
          ? `Signed in${billingEmail ? ` · ${billingEmail}` : ""}`
          : "Signed out";
  }
  if (title) {
    title.textContent =
      billingSignedIn === null ? "Checking sign-in…" : signed ? "Signed in" : "Sign in to upgrade";
  }
  if (sub) {
    sub.textContent = signed
      ? "You can upgrade in one click."
      : "Your plan is linked to your SyncLyst account. Sign in once, then upgrade in one click.";
  }
  if (btn) {
    btn.textContent = signed ? "Log out" : "Sign in";
  }
  if (btn) btn.disabled = false;

  // Disable paid upgrade buttons until signed in; show copy inline on the button.
  document.querySelectorAll(".settings-plan-open[data-billing-tier]").forEach((el) => {
    const tier = String(el.dataset.billingTier || "").toLowerCase();
    const isPaid = tier === "pro" || tier === "growth" || tier === "scale";
    if (!isPaid) return;
    const b = el;
    if (signed) {
      b.disabled = false;
      b.classList.remove("is-disabled");
      b.textContent = "Upgrade";
    } else {
      // Keep it clickable so users can sign in from the same button.
      b.disabled = false;
      b.classList.add("is-disabled");
      b.textContent = "Sign in to upgrade";
    }
  });
}

async function refreshSettingsBillingAuthState() {
  // Show the auth card immediately while we check cookies.
  billingSignedIn = null;
  billingEmail = "";
  refreshSettingsBillingAuthUI();
  setBillingMsg("");
  const j = await fetchBillingAuthSummary();
  billingSignedIn = !!(j && j.signedIn);
  billingEmail = billingSignedIn && typeof j.email === "string" ? String(j.email).trim() : "";
  refreshSettingsBillingAuthUI();
}

async function startStripeCheckoutFromPopup(tier) {
  const t = String(tier || "").toLowerCase();
  if (t !== "pro" && t !== "growth" && t !== "scale") return;
  try {
    setBillingMsg("Opening secure checkout…");
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return;
    const origin = base;
    const r = await fetchWithTimeout(
      `${base}/api/billing/checkout-direct`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          tier: t,
          success_url: `${origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/extension-return?canceled=1&tier=${encodeURIComponent(t)}`,
        }),
      },
      20000
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) {
        billingSignedIn = false;
        billingEmail = "";
        refreshSettingsBillingAuthUI();
        setBillingMsg("You’re signed out. Click “Sign in”, then try again.");
        return;
      }
      if (r.status === 404 || r.status === 405) {
        // Most common in production when the latest Next deploy isn't live yet.
        setBillingMsg("Billing update not live yet. Redeploy synclyst.app, then try again.");
        return;
      }
      const detail = body && typeof body.detail === "string" ? body.detail : "";
      setBillingMsg(detail ? `Could not start checkout. ${detail}` : "Could not start checkout. Try again.");
      return;
    }
    const url = body && typeof body.url === "string" ? body.url : "";
    if (!url) {
      setBillingMsg("Checkout did not return a Stripe URL. Try again.");
      return;
    }
    chrome.tabs.create({ url });
  } catch {
    setBillingMsg("Network error starting checkout. Try again.");
  }
}

function openAutostartCheckoutTabForTier(tier) {
  const t = String(tier || "").toLowerCase();
  if (t !== "pro" && t !== "growth" && t !== "scale") return;
  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return;
    // Avoid extension cookie issues by using a first-party redirect endpoint.
    chrome.tabs.create({ url: `${base}/api/billing/checkout-redirect?tier=${encodeURIComponent(t)}` });
  } catch {
    /* ignore */
  }
}

function openBillingTabForTier(tier) {
  const t = String(tier).toLowerCase();
  let url;
  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return;
    if (t === "starter") {
      // Use extension-friendly redirect targets (never dashboard).
      url = `${base}/sign-up?redirect_url=${encodeURIComponent("/extension-return")}&after_sign_up_url=${encodeURIComponent("/extension-return")}`;
    } else if (t === "pro" || t === "growth" || t === "scale") {
      // After signing in, send users to a lightweight "back to extension" page (not dashboard).
      url = `${base}/sign-in?redirect_url=${encodeURIComponent("/extension-return")}&after_sign_in_url=${encodeURIComponent("/extension-return")}`;
    } else {
      return;
    }
  } catch {
    return;
  }
  try {
    chrome.tabs.create({ url });
  } catch {
    /* ignore */
  }
}

function legalPathForKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "terms") return "/terms";
  if (k === "privacy") return "/privacy";
  return null;
}

function openLegalDocExternal(kind) {
  const path = legalPathForKind(kind);
  if (!path) return;
  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return;
    chrome.tabs.create({ url: `${base}${path}` });
  } catch {
    /* ignore */
  }
}

/** Stuck-together plain text (e.g. one innerText blob) → rough paragraphs. */
function fallbackFormatLegalWall(txt) {
  let s = String(txt || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!s) return "";
  // "PolicyLast" / "2026SyncLyst" style boundaries
  s = s.replace(/([a-z\d\)])([A-Z][a-z])/g, "$1\n\n$2");
  s = s.replace(/([.!?])(\d+\.\s+)/g, "$1\n\n$2");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Prefer structured text from the page DOM (headings, paragraphs, list items).
 * Flat innerText on <main> often collapses Next/Tailwind pages into one wall of text.
 */
function extractFormattedLegalTextFromDoc(doc) {
  const root =
    doc.querySelector("main") || doc.querySelector("[role='main']") || doc.querySelector("article") || doc.body;
  if (!root) return "";

  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, h4, p, li"));

  function skipFooterLink(el) {
    if (!el || el.tagName !== "P") return false;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return t.startsWith("←") || t.includes("back to home") || t.includes("back to synclyst");
  }

  function oneLine(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  const out = [];
  let i = 0;
  while (i < nodes.length) {
    const el = nodes[i];
    if (skipFooterLink(el)) {
      i += 1;
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "li") {
      while (i < nodes.length && nodes[i].tagName.toLowerCase() === "li") {
        if (!skipFooterLink(nodes[i])) {
          const t = oneLine(nodes[i]);
          if (t) out.push(`• ${t}`);
        }
        i += 1;
      }
      out.push("");
      continue;
    }
    const t = oneLine(el);
    if (t) {
      if (tag === "h1") out.push(t, "");
      else if (tag === "h2" || tag === "h3" || tag === "h4") out.push(t, "");
      else out.push(t, "");
    }
    i += 1;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n").trim();
}

async function loadLegalDocIntoModal(kind) {
  const path = legalPathForKind(kind);
  if (!path) return;

  const overlay = document.getElementById("settings-overlay");
  const titleEl = document.getElementById("settings-title");
  const mainScroll = document.getElementById("settings-scroll");
  const legalScroll = document.getElementById("legal-scroll");
  const loadingEl = document.getElementById("legal-loading");
  const textEl = document.getElementById("legal-text");
  const openExternalBtn = document.getElementById("btn-legal-open-external");

  const label = kind === "privacy" ? "Privacy Policy" : "Terms & Conditions";
  if (titleEl) titleEl.textContent = label;
  mainScroll?.classList.add("hidden");
  legalScroll?.classList.remove("hidden");
  overlay?.classList.remove("hidden");

  if (loadingEl) loadingEl.textContent = "Loading…";
  loadingEl?.classList.remove("hidden");
  textEl?.classList.add("hidden");
  if (textEl) textEl.textContent = "";
  openExternalBtn?.classList.remove("hidden");

  if (openExternalBtn) {
    openExternalBtn.onclick = () => openLegalDocExternal(kind);
  }

  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) throw new Error("Missing origin");
    const url = `${base}${path}`;
    const r = await fetchWithTimeout(url, { cache: "no-store" }, 9000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    let extracted = "";
    try {
      const doc = new DOMParser().parseFromString(String(html), "text/html");
      extracted = extractFormattedLegalTextFromDoc(doc);
      if (!extracted) {
        const preferred =
          doc.querySelector("main") ||
          doc.querySelector("[role='main']") ||
          doc.querySelector("article") ||
          doc.body;
        const wall = preferred ? String(preferred.innerText || "").trim() : "";
        extracted = wall ? fallbackFormatLegalWall(wall) : "";
      }
    } catch {
      extracted = "";
    }

    if (!extracted) {
      extracted = "Couldn’t extract readable text in the popup. Use “Open in browser”.";
    }

    if (textEl) textEl.textContent = extracted;
    textEl?.classList.remove("hidden");
    loadingEl?.classList.add("hidden");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (loadingEl) loadingEl.textContent = `Couldn’t load right now (${msg}). Use “Open in browser”.`;
    if (textEl) textEl.textContent = "";
    textEl?.classList.add("hidden");
    openExternalBtn?.classList.remove("hidden");
  }
}

function closeLegalDocModalIfOpen() {
  const legalScroll = document.getElementById("legal-scroll");
  const mainScroll = document.getElementById("settings-scroll");
  const titleEl = document.getElementById("settings-title");
  if (!legalScroll || legalScroll.classList.contains("hidden")) return false;
  legalScroll.classList.add("hidden");
  mainScroll?.classList.remove("hidden");
  if (titleEl) titleEl.textContent = "Settings";
  return true;
}

let billingSettingsWired = false;
function wireBillingSettings() {
  if (billingSettingsWired) return;
  billingSettingsWired = true;
  refreshSettingsTierDisplay();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      !changes[STORAGE_SYNC_TIER] &&
      !changes[STORAGE_PLAN_RENEWAL] &&
      !changes[STORAGE_PREF_BILLING_TIER]
    ) {
      return;
    }
    refreshSettingsTierDisplay();
  });

  const overlay = document.getElementById("settings-overlay");
  document.getElementById("btn-open-settings")?.addEventListener("click", () => {
    refreshSettingsTierDisplay();
    refreshSettingsBillingAuthState();
    setBillingMsg("");
    overlay?.classList.remove("hidden");
  });
  document.getElementById("btn-settings-close")?.addEventListener("click", () => {
    if (closeLegalDocModalIfOpen()) return;
    overlay?.classList.add("hidden");
  });

  document.getElementById("btn-open-terms")?.addEventListener("click", () => loadLegalDocIntoModal("terms"));
  document.getElementById("btn-open-privacy")?.addEventListener("click", () => loadLegalDocIntoModal("privacy"));

  try {
    const man = typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest() : null;
    const verEl = document.getElementById("settings-extension-version");
    if (verEl && man && man.version) verEl.textContent = `Extension version ${man.version}`;
  } catch {
    /* ignore */
  }

  const planGrid = document.getElementById("settings-plan-grid");
  planGrid?.addEventListener("click", (e) => {
    const openBtn = e.target && e.target.closest && e.target.closest(".settings-plan-open[data-billing-tier]");
    if (openBtn && openBtn.dataset.billingTier) {
      e.stopPropagation();
      const tier = String(openBtn.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      if (tier === "pro" || tier === "growth" || tier === "scale") {
        // Extensions frequently can't send Clerk cookies cross-origin.
        // Open a first-party tab that autostarts Stripe Checkout instead.
        openAutostartCheckoutTabForTier(tier);
      } else {
        openBillingTabForTier(tier);
      }
      return;
    }
    const row = e.target && e.target.closest && e.target.closest(".settings-plan-row[data-billing-tier]");
    if (row && row.dataset.billingTier) {
      const tier = String(row.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      // Clicking anywhere on a tier row should behave like clicking its CTA.
      // If it's the current plan, do nothing.
      if (row.classList.contains("is-current")) return;
      if (tier === "pro" || tier === "growth" || tier === "scale") {
        openAutostartCheckoutTabForTier(tier);
      } else if (tier === "starter") {
        openBillingTabForTier(tier);
      }
    }
  });

  planGrid?.addEventListener("keydown", (e) => {
    const row = e.target && e.target.closest && e.target.closest(".settings-plan-row[data-billing-tier]");
    if (!row || (e.target && e.target.closest && e.target.closest(".settings-plan-open"))) return;
    const rows = Array.from(
      document.querySelectorAll("#settings-plan-grid .settings-plan-row[data-billing-tier]")
    );
    const i = rows.indexOf(row);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const tier = String(row.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      if (row.classList.contains("is-current")) return;
      if (tier === "pro" || tier === "growth" || tier === "scale") {
        openAutostartCheckoutTabForTier(tier);
      } else if (tier === "starter") {
        openBillingTabForTier(tier);
      }
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? rows[i + 1] : rows[i - 1];
      if (next) {
        next.focus();
        setPrefBillingTier(String(next.dataset.billingTier).toLowerCase());
      }
    }
  });

  document.getElementById("btn-settings-signin")?.addEventListener("click", () => {
    setBillingMsg("");
    try {
      const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
      if (!base) return;
      if (billingSignedIn) {
        chrome.tabs.create({ url: `${base}/sign-out?redirect_url=${encodeURIComponent("/sign-in")}` });
      } else {
        chrome.tabs.create({
          url: `${base}/sign-in?redirect_url=${encodeURIComponent("/extension-return")}&after_sign_in_url=${encodeURIComponent("/extension-return")}`,
        });
      }
    } catch {
      openBillingTabForTier("pro");
    }
  });
}

/** Per-platform copy for the review step (labels + hints). */
const PLATFORM_REVIEW_TEMPLATES = {
  shopify: {
    stepLabel: "3. Review for Shopify",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Shopify instantly.",
    title: "Product title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Shopify Admin",
  },
  ebay: {
    stepLabel: "3. Review for eBay",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in eBay instantly.",
    title: "Title",
    description: "Item description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "eBay listing",
  },
  etsy: {
    stepLabel: "3. Review for Etsy",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Etsy instantly.",
    title: "Listing title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Etsy listing editor",
  },
  shopee: {
    stepLabel: "3. Review for Shopee",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Shopee instantly.",
    title: "Product name",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Shopee Seller Centre",
  },
  depop: {
    stepLabel: "3. Confirm your listing",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Depop instantly.",
    title: "Title",
    description: "Description",
    price: "Item price",
    pricePlaceholder: "0.00",
    tabHint: "Depop listing",
  },
  vinted: {
    stepLabel: "3. Review for Vinted",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Vinted instantly.",
    title: "Title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Vinted upload",
  },
};

/** Prefer these URL patterns when the active tab is not the marketplace (Magic Fill). */
const PLATFORM_TAB_URLS = {
  shopify: ["https://admin.shopify.com/*"],
  ebay: ["https://*.ebay.com/*", "https://ebay.com/*", "http://*.ebay.com/*"],
  etsy: ["https://*.etsy.com/*", "http://*.etsy.com/*"],
  depop: ["https://www.depop.com/*", "https://depop.com/*"],
  vinted: [
    "https://www.vinted.com/*",
    "https://www.vinted.co.uk/*",
    "https://www.vinted.de/*",
    "https://www.vinted.fr/*",
    "https://www.vinted.nl/*",
    "https://www.vinted.es/*",
    "https://www.vinted.it/*",
    "https://www.vinted.pl/*",
    "https://www.vinted.be/*",
    "https://www.vinted.at/*",
    "https://www.vinted.pt/*",
  ],
  shopee: [
    "https://seller.shopee.sg/*",
    "https://seller.shopee.co.id/*",
    "https://seller.shopee.co.th/*",
    "https://seller.shopee.com.my/*",
    "https://seller.shopee.ph/*",
    "https://seller.shopee.tw/*",
    "https://seller.shopee.vn/*",
    "https://seller.shopee.com.br/*",
    "https://banhang.shopee.vn/*",
  ],
};

function templateForPlatform(id) {
  return PLATFORM_REVIEW_TEMPLATES[id] || PLATFORM_REVIEW_TEMPLATES.shopify;
}

function applyPlatformReviewTemplate(id) {
  const t = templateForPlatform(id);
  const stepEl = document.getElementById("review-step-label");
  const subEl = document.getElementById("review-template-sub");
  const lt = document.getElementById("label-review-title");
  const ld = document.getElementById("label-review-description");
  const lp = document.getElementById("label-review-price-text");
  const priceInput = document.getElementById("review-price");
  const hintEl = document.getElementById("magic-tab-hint");
  const postHintEl = document.getElementById("magic-post-hint");
  if (stepEl) stepEl.textContent = t.stepLabel;
  if (subEl) subEl.textContent = t.sub;
  if (lt) lt.textContent = t.title;
  if (ld) ld.textContent = t.description;
  if (lp) lp.textContent = t.price;
  if (priceInput) priceInput.placeholder = t.pricePlaceholder;
  if (hintEl) hintEl.textContent = t.tabHint;
  if (postHintEl) {
    const safeHint = t.tabHint || "listing";
    postHintEl.innerHTML =
      `Keep your <strong id="magic-tab-hint">${safeHint}</strong> open. ` +
      `Start from <strong>Products</strong> list; we’ll add, fill form, and save.`;
  }
}

/** Re-apply last marketplace selection from storage (new phone scan keeps Shopify, etc.). */
const ALLOWED_PLATFORMS = new Set(["shopify", "ebay", "etsy", "shopee", "depop", "vinted"]);

function normalizeLegacyPlatformId(p) {
  if (!p) return p;
  if (ALLOWED_PLATFORMS.has(p)) return p;
  if (p === "poshmark") return "etsy";
  /** Grailed hidden from chooser for now; map stored value to a supported platform. */
  if (p === "grailed" || p === "amazon" || p === "tiktok_shop") return "shopify";
  return "shopify";
}

function restorePlatformFromStorage() {
  chrome.storage.local.get([STORAGE_LAST_PLATFORM], (o) => {
    let p = o && o[STORAGE_LAST_PLATFORM];
    const norm = normalizeLegacyPlatformId(p);
    if (norm !== p) {
      chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: norm });
      p = norm;
    }
    if (p && PLATFORM_REVIEW_TEMPLATES[p]) {
      setSelectedPlatform(p);
    }
  });
}

function urlMatchesPlatform(url, platform) {
  if (!url || !platform) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    switch (platform) {
      case "shopify":
        return h === "admin.shopify.com";
      case "ebay":
        return h.includes("ebay.");
      case "etsy":
        return h.includes("etsy.");
      case "shopee":
        return (h.startsWith("seller.") && h.includes("shopee.")) || h.includes("banhang.shopee");
      case "depop":
        return h.includes("depop.");
      case "vinted":
        return h.includes("vinted.");
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function findListingTab(platform) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && urlMatchesPlatform(active.url, platform)) {
    return active;
  }
  const patterns = PLATFORM_TAB_URLS[platform];
  if (patterns && patterns.length) {
    for (const urlPattern of patterns) {
      const found = await chrome.tabs.query({ url: urlPattern, currentWindow: true });
      if (found[0]?.id) {
        return found[0];
      }
    }
  }
  const all = await chrome.tabs.query({ currentWindow: true });
  const match = all.find((tab) => urlMatchesPlatform(tab.url, platform));
  if (match?.id) return match;
  return active && active.id ? active : null;
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (!el) return;
  const msg = (text || "").trim();
  el.textContent = msg;
  if (!msg) {
    el.removeAttribute("data-kind");
    return;
  }
  const lc = msg.toLowerCase();
  let kind = "info";
  if (
    lc.includes("could not") ||
    lc.includes("couldn’t") ||
    lc.includes("error") ||
    lc.includes("failed") ||
    lc.includes("offline")
  ) {
    kind = "error";
  } else if (
    lc.includes("choose") ||
    lc.includes("open a") ||
    lc.includes("add a title") ||
    lc.includes("try again") ||
    lc.includes("wait") ||
    lc.includes("still running")
  ) {
    kind = "warn";
  } else if (lc.startsWith("done") || lc.includes("filled") || lc.includes("copied")) {
    kind = "success";
  }
  el.setAttribute("data-kind", kind);
}

const PAIR_COPY_HINT_DEFAULT = "";

async function copySnapPairUrl() {
  const code = snapPairSessionId;
  if (!code) return;
  const hintEl = document.getElementById("pair-copy-hint");
  try {
    await navigator.clipboard.writeText(code);
    if (hintEl) hintEl.textContent = "Copied!";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 1600);
  } catch {
    if (hintEl) hintEl.textContent = "Couldn’t copy — select the code";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 2400);
  }
}

async function copySnapPairLink(pairUrl) {
  const u = String(pairUrl || "").trim();
  if (!u) return;
  const hintEl = document.getElementById("pair-copy-hint");
  try {
    await navigator.clipboard.writeText(u);
    if (hintEl) hintEl.textContent = "Link copied!";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 1600);
  } catch {
    if (hintEl) hintEl.textContent = "Couldn’t copy link";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 2400);
  }
}

function openSnapPairLink(pairUrl) {
  const u = String(pairUrl || "").trim();
  if (!u) return;
  try {
    chrome.tabs.create({ url: u });
  } catch {
    /* ignore */
  }
}

function getCurrentPairUrl() {
  const sid = snapPairSessionId;
  if (!sid) return "";
  const base = String(SYNCLYST_ORIGIN || SYNCLYST_ORIGIN_DEFAULT).replace(/\/$/, "");
  return `${base}/snap?s=${encodeURIComponent(sid)}`;
}

/**
 * Direct /snap link for the session (used by “Copy link”, desktop, etc.).
 */
function getPhonePairUrlDirect() {
  const sid = snapPairSessionId;
  if (!sid) return "";
  const resolved = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
  const isLoopback =
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(resolved) ||
    /^https?:\/\/\[::1\](:\d+)?\/?$/i.test(resolved);
  const isPublicHttps = /^https:\/\//i.test(resolved) && !isLoopback;
  const isLanHttp = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?\/?$/i.test(
    resolved
  );
  if (isPublicHttps || isLanHttp) {
    return `${resolved}/snap?s=${encodeURIComponent(sid)}`;
  }
  return `${SYNCLYST_ORIGIN_LIVE}/snap?s=${encodeURIComponent(sid)}`;
}

function base64UrlEncodeUtf8(str) {
  if (typeof TextEncoder !== "undefined") {
    const bytes = new TextEncoder().encode(String(str));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return btoa(String(str)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * URL encoded in the phone QR. iOS often only offers to *copy* raw http:// (LAN) links from the Camera
 * app, not “Open in Safari”. Use a trustable https:// page on synclyst.app that redirects to the real
 * /snap link (q.html#base64). Full https targets (Vercel, production) are encoded as-is.
 */
function getPhoneQrUrl() {
  const direct = getPhonePairUrlDirect();
  if (!direct) return "";
  if (/^https:\/\//i.test(direct)) return direct;
  if (!/^http:\/\//i.test(direct)) return direct;
  const live = SYNCLYST_ORIGIN_LIVE.replace(/\/$/, "");
  return `${live}/q.html#${base64UrlEncodeUtf8(direct)}`;
}

const QR_CTA_INJECT_STYLE =
  "display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:10px 14px;min-height:44px;" +
  "font-size:13px;font-weight:600;line-height:1.2;color:#fff;background:#111827;border:1px solid #0f172a;" +
  "border-radius:12px;cursor:pointer;font-family:inherit;";

/**
 * A stale "Load unpacked" copy may still serve an old popup.html (QR → session only). Recreate the current controls in DOM.
 * Prefer appending the CTA *inside* `.qr-card` (same as current markup) so it stays inside the visible dashed box.
 */
function ensurePairingStepControls() {
  const root = document.getElementById("state-empty");
  const qr = root && root.querySelector(".qr-card");
  if (!root || !qr) return;

  if (!document.getElementById("btn-open-snap-on-this-computer")) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-magic qr-snap-cta";
    b.id = "btn-open-snap-on-this-computer";
    b.textContent = "Use this computer to upload";
    b.style.cssText = QR_CTA_INJECT_STYLE;
    const hint = qr.querySelector(".qr-hint");
    if (hint) {
      hint.insertAdjacentElement("afterend", b);
    } else {
      qr.appendChild(b);
    }

    const h = document.createElement("p");
    h.className = "qr-desktop-hint";
    h.style.marginTop = "8px";
    h.textContent = "Opens the Snap page on your phone for this session.";
    b.insertAdjacentElement("afterend", h);
  } else if (!root.querySelector(".qr-desktop-hint")) {
    const b = document.getElementById("btn-open-snap-on-this-computer");
    if (b) {
      const h = document.createElement("p");
      h.className = "qr-desktop-hint";
      h.style.marginTop = "8px";
      h.textContent = "Opens the Snap page on your phone for this session.";
      b.insertAdjacentElement("afterend", h);
    }
  }

  // In current UI `btn-copy-snap-link` is the whole session card; older UIs may still need a button.
  if (!document.getElementById("btn-copy-snap-link")) {
    const snap = document.createElement("button");
    snap.type = "button";
    snap.className = "btn-ghost";
    snap.id = "btn-copy-snap-link";
    snap.textContent = "Copy upload link";
    const anchor = document.getElementById("btn-new-pairing-session");
    if (anchor && anchor.parentNode === root) {
      root.insertBefore(snap, anchor);
    } else {
      root.appendChild(snap);
    }
  }
}

function setLiveLabel(text) {
  const el = document.getElementById("live-label");
  if (el) el.textContent = text;
  const wrap = document.getElementById("live-status");
  if (!wrap) return;
  wrap.classList.toggle("is-error", text === "Error");
}

function genSessionIdLocal() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionIdFromSnapLikeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    const p = (u.pathname || "").replace(/\/$/, "");
    const okPath =
      p === "/snap" ||
      p === "/snap.html" ||
      p === "/extension-review" ||
      p.startsWith("/extension-review/");
    if (!okPath) return null;
    const s = (u.searchParams.get("s") || "").trim();
    return /^[a-f0-9]{12,32}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * All windows — pairing often lives in a different window than the seller tab where the popup is opened.
 * If `storedId` is set, prefer a tab whose `?s=` matches (avoids a stale /snap background tab overriding the phone/QR id).
 */
function pickSessionIdFromOpenSynclystTab(storedId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (tabs) => {
        try {
          const list = (tabs || []).filter((t) => t && t.url);
          const found = [];
          for (const t of list) {
            const s = sessionIdFromSnapLikeUrl(t.url);
            if (s) found.push({ s, active: !!t.active });
          }
          if (!found.length) return resolve(null);
          const sid = storedId && /^[a-f0-9]{12,32}$/i.test(String(storedId)) ? String(storedId) : "";
          if (sid) {
            const m = found.find((x) => x.s && x.s.toLowerCase() === sid.toLowerCase());
            if (m) return resolve(m.s);
            // Persisted id (QR / phone) wins over a leftover /snap tab with a different ?s=.
            return resolve(null);
          }
          const act = found.find((x) => x.active);
          if (act) return resolve(act.s);
          return resolve(found[0].s);
        } catch {
          /* ignore */
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Prefer background worker; fall back to storage in-popup (MV3 SW can miss first message).
 */
function getSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["snap_pair_session_id"], (o) => {
      const stored = o && o.snap_pair_session_id && /^[a-f0-9]{12,32}$/i.test(String(o.snap_pair_session_id))
        ? String(o.snap_pair_session_id)
        : "";
      pickSessionIdFromOpenSynclystTab(stored)
        .then((fromTab) => {
          if (fromTab) {
            if (!stored || fromTab.toLowerCase() !== stored.toLowerCase()) {
              try {
                chrome.storage.local.set({ snap_pair_session_id: fromTab });
              } catch {
                /* ignore */
              }
            }
            resolve(fromTab);
            return true;
          }
          return false;
        })
        .then((done) => {
          if (done) return;
          if (stored) {
            resolve(stored);
            return;
          }
          chrome.runtime.sendMessage({ type: "SYNCLYST_GET_SESSION" }, (r) => {
            if (chrome.runtime.lastError) {
              /* fall through */
            } else if (r && r.sessionId && /^[a-f0-9]{12,32}$/i.test(r.sessionId)) {
              resolve(r.sessionId);
              return;
            }
            chrome.storage.local.get(["snap_pair_session_id"], (o2) => {
              const existing = o2 && o2.snap_pair_session_id;
              if (existing && /^[a-f0-9]{12,32}$/i.test(String(existing))) {
                resolve(String(existing));
                return;
              }
              const id = genSessionIdLocal();
              chrome.storage.local.set({ snap_pair_session_id: id }, () => resolve(id));
            });
          });
        });
    });
  });
}

function getQrEncodeFactory() {
  const g = typeof globalThis !== "undefined" ? globalThis : window;
  if (typeof g.__SYNCLYST_QRCODE === "function") return g.__SYNCLYST_QRCODE;
  if (typeof g.qrcode === "function") return g.qrcode;
  return null;
}

function revokePrevQrObjectUrl(imgEl) {
  const prev = imgEl && imgEl.dataset && imgEl.dataset.synclystQrBlob;
  if (prev) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* ignore */
    }
    delete imgEl.dataset.synclystQrBlob;
  }
}

/**
 * Generate QR locally (no third-party services).
 * Prefer GIF data URL (most reliable in MV3 popups), then SVG blob URL fallback.
 */
async function setQrSrc(imgEl, pairUrl) {
  const u = String(pairUrl || "").trim();
  if (!imgEl || !u) return;
  revokePrevQrObjectUrl(imgEl);

  const applyBlobSrc = (blob) => {
    const u = URL.createObjectURL(blob);
    imgEl.dataset.synclystQrBlob = u;
    imgEl.src = u;
  };

  const mk = getQrEncodeFactory();
  if (typeof mk === "function") {
    for (let type = 1; type <= 40; type += 1) {
      try {
        const qr = mk(type, "M");
        qr.addData(u);
        qr.make();
        /** GIF data URL first: most reliable in MV3 popups. */
        const tag = qr.createImgTag(4, 8);
        const mGif = tag && String(tag).match(/src="([^"]+)"/);
        if (mGif && mGif[1]) {
          imgEl.removeAttribute("data-synclyst-qr-blob");
          imgEl.src = mGif[1];
          return;
        }
        const svg = qr.createSvgTag(4, 8);
        if (svg && String(svg).indexOf("<svg") !== -1) {
          const blob = new Blob([String(svg)], { type: "image/svg+xml;charset=utf-8" });
          applyBlobSrc(blob);
          return;
        }
      } catch {
        /* try larger symbol version */
      }
    }
  }

  // If the vendor QR library fails to load for any reason, keep the popup usable.
  imgEl.removeAttribute("data-synclyst-qr-blob");
  imgEl.src = "";
}

async function registerSession(sessionId) {
  try {
    await fetchWithTimeout(
      `${SYNCLYST_ORIGIN}/api/snap-pair/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      },
      6000
    );
  } catch {
    /* offline */
  }
}

async function fetchConfig() {
  try {
    const r = await fetchWithTimeout(`${SYNCLYST_ORIGIN}/api/snap-pair/config`, {}, 6000);
    return await r.json();
  } catch {
    return { configured: false };
  }
}

let _sessionPollCount = 0;
async function pollSession(sessionId) {
  /** Stale `SYNCLYST_ORIGIN` (e.g. synclyst.app) while /snap is on 127.0.0.1:3000 makes polls return empty forever. */
  _sessionPollCount += 1;
  if (_sessionPollCount === 1 || _sessionPollCount % 3 === 0) {
    try {
      SYNCLYST_ORIGIN = await resolveSynclystOrigin();
    } catch {
      /* ignore */
    }
  }
  try {
    const r = await fetchWithTimeout(
      `${SYNCLYST_ORIGIN}/api/snap-pair/session/${encodeURIComponent(sessionId)}`,
      {},
      30000
    );
    if (!r || !r.ok) {
      return { error: true, status: r && r.status };
    }
    return await r.json();
  } catch {
    return { error: true };
  }
}

/**
 * Phone upload sets storage before vision + push finish; a single poll often returns { empty: true }.
 * Poll in quick succession until the session row has listing content (or we give up).
 */
let snapBurstGen = 0;
function burstPollUntilListing(sessionId, opts) {
  const stepMs = opts && opts.stepMs != null ? opts.stepMs : 350;
  const maxAttempts = opts && opts.maxAttempts != null ? opts.maxAttempts : 220;
  const my = ++snapBurstGen;
  let attempt = 0;
  async function step() {
    if (my !== snapBurstGen) return;
    if (attempt++ >= maxAttempts) return;
    const j = await pollSession(sessionId);
    if (my !== snapBurstGen) return;
    if (j && !j.empty && j.listing && sessionListingHasContent(j.listing)) {
      applyListing(j.listing);
      return;
    }
    setTimeout(step, stepMs);
  }
  step();
}

function updateContinueListingButton() {
  const cont = document.getElementById("btn-continue-listing");
  if (!cont) return;
  const show = qrHomeActive && listingHydrated && sessionListingHasContent(lastPayload);
  cont.classList.toggle("hidden", !show);
}

function updatePairingHeaderLabel(mode) {
  const el = document.getElementById("pairing-header-step-label");
  if (!el) return;
  if (mode === "qr") {
    el.textContent = "1. Scan to pair phone";
  } else {
    el.textContent = "2. Choose platform";
  }
}

function showQrHomeView() {
  qrHomeActive = true;
  chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: true });
  const empty = document.getElementById("state-empty");
  const loaded = document.getElementById("state-loaded");
  if (empty) empty.classList.remove("hidden");
  if (loaded) loaded.classList.add("hidden");
  const st = document.getElementById("status");
  if (st) st.textContent = "";
  updatePairingHeaderLabel("qr");
  updateContinueListingButton();
}

function setReviewLoadingState(on, msg) {
  extractionPending = !!on;
  // Ensure the right-hand "review" modal stays visible while we wait.
  try {
    document.getElementById("post-platform-panel")?.classList.remove("hidden");
  } catch {
    /* ignore */
  }
  const loadWrap = document.getElementById("review-loading");
  const loadText = document.getElementById("review-loading-text");
  if (loadWrap) loadWrap.classList.toggle("hidden", !on);
  if (loadText && typeof msg === "string" && msg.trim()) loadText.textContent = msg.trim();
  const titleEl = document.getElementById("review-title");
  const descEl = document.getElementById("review-description");
  const priceEl = document.getElementById("review-price");
  if (titleEl) {
    titleEl.value = on ? "" : titleEl.value;
    titleEl.disabled = !!on;
    if (on) titleEl.placeholder = "Waiting for your scan…";
  }
  if (descEl) {
    descEl.value = on ? "" : descEl.value;
    descEl.disabled = !!on;
  }
  if (priceEl) {
    priceEl.value = on ? "" : priceEl.value;
    priceEl.disabled = !!on;
  }
  const thumb = document.getElementById("preview-thumb");
  if (thumb) {
    thumb.style.display = on ? "none" : thumb.style.display;
    if (on) thumb.removeAttribute("src");
  }
  const extra = document.getElementById("review-extra-images");
  if (extra) {
    extra.innerHTML = "";
    extra.classList.add("hidden");
  }
  const cont = document.getElementById("btn-continue-listing");
  if (cont) cont.classList.add("hidden");
  updateFullReviewButton();
  if (typeof msg === "string") setStatus(msg);
  try {
    const cta = document.getElementById("btn-open-snap-desktop");
    if (cta) cta.classList.toggle("hidden", !on);
  } catch {
    /* ignore */
  }
  refreshLoadedSubstate();
}

function continueToListing() {
  qrHomeActive = false;
  chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: false });
  try {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: chrome.runtime.getManifest()?.name || "SyncLyst" });
  } catch {
    /* ignore */
  }
  const empty = document.getElementById("state-empty");
  const loaded = document.getElementById("state-loaded");
  if (empty) empty.classList.add("hidden");
  if (loaded) loaded.classList.remove("hidden");
  const cont = document.getElementById("btn-continue-listing");
  if (cont) cont.classList.add("hidden");
  updatePairingHeaderLabel("listing");
  updateMagicLabel();
  updateFullReviewButton();
  refreshLoadedSubstate();
}

/** Supabase / JSON may return numeric price — always stringify for inputs and Magic Fill. */
function formatListingPrice(v) {
  if (v === undefined || v === null || v === "") return "";
  return String(v);
}

function pickStr(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * Session listing is worth showing in step 3 when any core field exists.
 * Do not require `title` — vision often returns image + description first, or title only after a follow-up write.
 */
function sessionListingHasContent(L) {
  if (!L || typeof L !== "object") return false;
  if (pickStr(L.title)) return true;
  if (pickStr(L.description)) return true;
  if (L.price !== undefined && L.price !== null && String(L.price).trim() !== "") return true;
  const img = L.image_url != null ? String(L.image_url).trim() : "";
  const looksLikeRawBase64 = (s) => {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 256) return false;
    if (t.indexOf("data:") === 0 || t.indexOf("http") === 0 || t.indexOf("blob:") === 0) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(t);
  };
  if (img && (img.startsWith("data:") || img.startsWith("http") || img.startsWith("blob:") || looksLikeRawBase64(img)))
    return true;
  try {
    const le = L.listing_extra;
    const urls =
      le &&
      le.media &&
      Array.isArray(le.media.image_urls) &&
      le.media.image_urls.filter(function (u) {
        return (
          typeof u === "string" &&
          (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0 || looksLikeRawBase64(u))
        );
      });
    if (urls && urls.length) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function pickFirstListingImageUrl(row) {
  if (!row || typeof row !== "object") return "";
  var top = row.image_url != null ? String(row.image_url).trim() : "";
  const looksLikeRawBase64 = (s) => {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    // Heuristic: large, no scheme/prefix, base64 alphabet only (avoid false positives on short strings).
    if (t.length < 256) return false;
    if (t.indexOf("data:") === 0 || t.indexOf("http") === 0 || t.indexOf("blob:") === 0) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(t);
  };
  if (top && (top.indexOf("data:") === 0 || top.indexOf("http") === 0 || top.indexOf("blob:") === 0)) return top;
  if (looksLikeRawBase64(top)) return `data:image/jpeg;base64,${top.replace(/\s+/g, "")}`;
  try {
    var le = row.listing_extra;
    var urls = le && le.media && Array.isArray(le.media.image_urls) ? le.media.image_urls : [];
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (
        typeof u === "string" &&
        (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0)
      )
        return u.trim();
      if (typeof u === "string" && looksLikeRawBase64(u)) return `data:image/jpeg;base64,${u.trim().replace(/\s+/g, "")}`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Category may live under listing_extra.shopify or top-level listing_extra (legacy / merges).
 * An empty `shopify: {}` is truthy — do not use `ex.shopify || ex` alone.
 */
/**
 * Vision / push often put long copy in `listing_extra.ebay.item_description` (or Shopify `body_html`)
 * while `row.description` is still empty — Magic Fill and the review textarea must use the longest source.
 */
function resolveListingDescription(row) {
  if (!row || typeof row !== "object") return "";
  const parts = [];
  const push = (s) => {
    const t = String(s == null ? "" : s).trim();
    if (t) parts.push(t);
  };
  push(row.description);
  try {
    const le = row.listing_extra;
    if (le && typeof le === "object") {
      const eb = le.ebay && typeof le.ebay === "object" ? le.ebay : null;
      if (eb) push(eb.item_description);
      const sh = le.shopify && typeof le.shopify === "object" ? le.shopify : null;
      if (sh && sh.body_html != null) {
        push(
          String(sh.body_html)
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        );
      }
    }
  } catch {
    /* ignore */
  }
  if (!parts.length) return "";
  return parts.reduce(function (a, b) {
    return b.length > a.length ? b : a;
  }, "");
}

function pickCategoryFromListing(row) {
  const ex = row && row.listing_extra;
  if (!ex || typeof ex !== "object") return "";
  const shop = ex.shopify && typeof ex.shopify === "object" && !Array.isArray(ex.shopify) ? ex.shopify : null;
  const fromShop =
    pickStr(shop && shop.category) ||
    pickStr(shop && shop.category_suggested) ||
    pickStr(shop && shop.product_type);
  if (fromShop) return fromShop;
  return (
    pickStr(ex.category) ||
    pickStr(ex.category_suggested) ||
    pickStr(ex.product_type) ||
    ""
  );
}

function renderExtraImagesStrip(row) {
  const wrap = document.getElementById("review-extra-images");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.classList.add("hidden");
  const ex = row && row.listing_extra;
  if (!ex || typeof ex !== "object") return;
  const shop = ex.shopify && typeof ex.shopify === "object" && !Array.isArray(ex.shopify) ? ex.shopify : null;
  const s = shop || ex;
  const raw = s && s.additional_images;
  if (!Array.isArray(raw) || !raw.length) return;
  const urls = raw.filter(function (u) {
    return (
      typeof u === "string" &&
      (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0)
    );
  });
  if (!urls.length) return;
  for (let i = 0; i < Math.min(urls.length, 6); i++) {
    const im = document.createElement("img");
    im.width = 40;
    im.height = 40;
    im.alt = "";
    im.src = urls[i];
    wrap.appendChild(im);
  }
  wrap.classList.remove("hidden");
}

function syncPayloadFromReviewFields() {
  const t = document.getElementById("review-title");
  const d = document.getElementById("review-description");
  const p = document.getElementById("review-price");
  if (!t || !d || !p) return;
  const keepExtra = lastPayload && lastPayload.listing_extra != null ? lastPayload.listing_extra : undefined;
  const keepImg = lastPayload && lastPayload.image_url != null ? lastPayload.image_url : undefined;
  lastPayload = {
    title: (t.value || "").trim(),
    description: (d.value || "").trim(),
    price: (p.value || "").trim(),
    ...(keepExtra !== undefined ? { listing_extra: keepExtra } : {}),
    ...(keepImg !== undefined ? { image_url: keepImg } : {}),
  };
}

/**
 * Later polls can return rows with image/price but blank title/description (partial writes / races).
 * If we already showed copy, keep it until the server sends non-blank replacements (user edits stay in sync via input listeners).
 */
function mergeListingCoreFromLastPayload(row) {
  if (!listingHydrated || !lastPayload) return row;
  const out = { ...row };
  if (!pickStr(out.title) && pickStr(lastPayload.title)) out.title = lastPayload.title;
  const rowDesc = out.description != null ? String(out.description).trim() : "";
  const prevDesc = lastPayload.description != null ? String(lastPayload.description).trim() : "";
  if (!rowDesc && prevDesc) out.description = lastPayload.description;
  const rowPrice = formatListingPrice(out.price);
  if (!rowPrice.trim() && lastPayload.price != null && String(lastPayload.price).trim() !== "") {
    out.price = lastPayload.price;
  }
  return out;
}

function applyListing(row) {
  if (!sessionListingHasContent(row)) return;
  // We have real listing content; clear any "waiting for scan" UI.
  if (extractionPending) {
    extractionPending = false;
    const loadWrap = document.getElementById("review-loading");
    if (loadWrap) loadWrap.classList.add("hidden");
    const t = document.getElementById("review-title");
    const d = document.getElementById("review-description");
    const p = document.getElementById("review-price");
    if (t) t.disabled = false;
    if (d) d.disabled = false;
    if (p) p.disabled = false;
    setStatus("");
  }
  row = mergeListingCoreFromLastPayload(row);
  const stamp =
    row.updated_at != null && String(row.updated_at).trim() !== ""
      ? String(row.updated_at)
      : `fallback:${snapPairSessionId || ""}:${pickStr(row.title)}\t${(row.description || "").length}`;
  const priceStr = formatListingPrice(row.price);
  const coercedImg = pickFirstListingImageUrl(row);
  const resolvedDesc = resolveListingDescription(row);
  lastPayload = {
    title: row.title == null ? "" : String(row.title).trim(),
    description: resolvedDesc,
    price: priceStr,
    ...(coercedImg ? { image_url: coercedImg } : {}),
    ...(row.listing_extra != null ? { listing_extra: row.listing_extra } : {}),
  };
  const thumb = document.getElementById("preview-thumb");
  const showThumb = !!coercedImg;
  if (showThumb) {
    thumb.style.display = "";
    thumb.src = coercedImg;
  } else {
    thumb.style.display = "none";
  }
  const titleEl = document.getElementById("review-title");
  const descEl = document.getElementById("review-description");
  const priceEl = document.getElementById("review-price");
  if (titleEl) titleEl.value = row.title == null ? "" : String(row.title).trim();
  if (descEl) descEl.value = resolvedDesc;
  if (priceEl) priceEl.value = priceStr;
  const catRow = document.getElementById("review-category-row");
  const catInput = document.getElementById("review-category");
  const cat = pickCategoryFromListing(row);
  if (catRow && catInput) {
    catInput.value = cat;
    catRow.classList.toggle("hidden", !cat);
  }
  renderExtraImagesStrip(row);
  /**
   * Leave the QR (step 1) shell whenever we have listing data. Previously we only called
   * `continueToListing()` when `qrHomeActive && isNewer && !suppress` — a stale stamp or
   * "suppress first apply" could leave the user on the QR view forever even with a filled row.
   * DOM is the source of truth: if the empty state is still visible, or the QR-home flag is on, advance.
   */
  const stateEmptyEl = document.getElementById("state-empty");
  const qrPanelVisible = stateEmptyEl && !stateEmptyEl.classList.contains("hidden");
  if (qrPanelVisible || qrHomeActive) {
    continueToListing();
  } else {
    stateEmptyEl?.classList.add("hidden");
    document.getElementById("state-loaded")?.classList.remove("hidden");
    chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: false });
  }

  const newImg = coercedImg || "";
  const imgChanged =
    listingHydrated &&
    newImg &&
    lastAppliedImageUrl != null &&
    String(lastAppliedImageUrl) !== newImg;
  lastAppliedImageUrl = newImg || lastAppliedImageUrl;

  if (!listingHydrated) {
    listingHydrated = true;
    restorePlatformFromStorage();
  } else if (imgChanged) {
    restorePlatformFromStorage();
  } else {
    updateMagicLabel();
    updateFullReviewButton();
  }

  /** Keep polling forever when Realtime is off — no timeout; new scans keep updating the popup. */
  lastAppliedListingStamp = stamp;
  updateContinueListingButton();
  refreshLoadedSubstate();
}

function getSelectedPlatform() {
  const t = document.querySelector(".platform-tile.selected");
  return (t && t.dataset && t.dataset.platform) || null;
}

function updateFullReviewButton() {
  const btn = document.getElementById("btn-open-full-review");
  if (!btn) return;
  btn.disabled = !getSelectedPlatform();
}

function openFullReviewInBrowser() {
  const platform = getSelectedPlatform();
  if (!platform || !snapPairSessionId) {
    setStatus("Choose a marketplace in step 2 first.");
    return;
  }
  const u = new URL("/extension-review", SYNCLYST_ORIGIN);
  u.searchParams.set("s", snapPairSessionId);
  u.searchParams.set("platform", platform);
  chrome.tabs.create({ url: u.toString() });
}

function setSelectedPlatform(id) {
  document.querySelectorAll(".platform-tile:not(.platform-tile--coming-soon)").forEach((btn) => {
    const on = btn.dataset.platform === id;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  applyPlatformReviewTemplate(id);
  document.getElementById("post-platform-panel")?.classList.remove("hidden");
  updateMagicLabel();
  updateFullReviewButton();
  try {
    chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: id });
  } catch {
    /* ignore */
  }
}

function updateMagicLabel() {
  const label = document.getElementById("magic-platform-label");
  if (!label) return;
  const id = getSelectedPlatform();
  if (!id) {
    label.textContent = "—";
    return;
  }
  const nameEl = document.querySelector(`.platform-tile[data-platform="${id}"] .platform-name`);
  const name = nameEl ? nameEl.textContent.trim() : id;
  label.textContent = name;
}

function mergeShopifyListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const srcRoot = sessionListing.listing_extra;
  const src = srcRoot.shopify || srcRoot;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.shopify) merged.listing_extra.shopify = {};
  const dest = merged.listing_extra.shopify;

  const keys = [
    "tags",
    "vendor",
    "product_type",
    "seo_page_title",
    "seo_meta_description",
    "compare_at",
    "sku",
    "barcode",
    "quantity",
    "weight",
    "weight_unit",
    "category",
    "category_suggested",
    "collections",
    "unit_price",
    "charge_tax",
    "sizes",
    "colors",
    "additional_images",
  ];
  /** Non-empty session fields win (full review / API save is authoritative). */
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }

  const sMeta = src.metafields;
  if (sMeta && typeof sMeta === "object" && !Array.isArray(sMeta)) {
    const dMeta =
      dest.metafields && typeof dest.metafields === "object" && !Array.isArray(dest.metafields) ? dest.metafields : {};
    const mergedMeta = { ...dMeta };
    for (const [mk, mv] of Object.entries(sMeta)) {
      if (mv != null && (typeof mv !== "string" || mv.trim() !== "")) mergedMeta[mk] = mv;
    }
    dest.metafields = mergedMeta;
  }
}

/** Shopee Seller Centre: persist native category_id/path when user or API resolves them (vision only sends hints). */
function mergeShopeeListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.shopee;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.shopee) merged.listing_extra.shopee = {};
  const dest = merged.listing_extra.shopee;
  const keys = [
    "category_id",
    "category_path",
    "category_hint",
    "category_search",
    "category_source",
    "category_needs_confirmation",
    "category_confidence",
    "barcode",
    "display_title",
    "brand",
    "sleeve_length",
    "pattern",
    "gender",
    "material",
    "occasion",
    "stock",
    "weight_kg",
    "parcel_width_cm",
    "parcel_length_cm",
    "parcel_height_cm",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeVintedListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.vinted;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.vinted) merged.listing_extra.vinted = {};
  const dest = merged.listing_extra.vinted;
  const keys = [
    "category",
    "brand",
    "size",
    "shoulder_width_in",
    "length_in",
    "condition",
    "material",
    "colours",
    "colors",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeEbayListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.ebay;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.ebay) merged.listing_extra.ebay = {};
  const dest = merged.listing_extra.ebay;
  const keys = [
    "item_description",
    "category_leaf",
    "category_breadcrumb",
    "brand",
    "size",
    "color",
    "department",
    "upc",
    "item_type",
    "condition",
    "quantity",
    "auction_duration_days",
    "pricing_format",
    "starting_bid",
    "buy_it_now_price",
    "reserve_price",
    "shipping_method",
    "package_weight_lbs",
    "package_weight_oz",
    "package_length_in",
    "package_width_in",
    "package_height_in",
    "domestic_cost_type",
    "country_of_origin",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeEtsyListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.etsy;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.etsy) merged.listing_extra.etsy = {};
  const dest = merged.listing_extra.etsy;
  const keys = [
    "title",
    "category_search",
    "category_leaf",
    "category_breadcrumb",
    "item_type",
    "when_made",
    "tags",
    "brand",
    "materials_hint",
    "quantity",
    "sku",
    "who_made",
    "what_is_it",
    "renewal",
    "shop_section",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeDepopListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.depop;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.depop) merged.listing_extra.depop = {};
  const dest = merged.listing_extra.depop;
  const keys = [
    "category",
    "brand",
    "condition",
    "color",
    "source",
    "age",
    "style",
    "shipping_price",
    "country",
    "offer_worldwide_shipping",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeGrailedListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.grailed;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.grailed) merged.listing_extra.grailed = {};
  const dest = merged.listing_extra.grailed;
  const keys = ["department"];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    dest[k] = sv;
  }
}

function setMagicFillLoading(loading) {
  const btn = document.getElementById("magic-fill");
  if (!btn) return;
  btn.classList.toggle("is-loading", loading);
  btn.setAttribute("aria-busy", loading ? "true" : "false");
  btn.disabled = loading;
  try {
    const plat = (document.getElementById("magic-platform-label")?.textContent || "").trim() || "marketplace";
    btn.setAttribute("aria-label", loading ? `Filling listing in ${plat}, please wait` : `Fill listing in ${plat}`);
  } catch {
    /* ignore */
  }
}

async function runMagicFill() {
  const fillStartedAt = Date.now();
  setMagicFillLoading(true);
  // Immediate feedback: button spinner + status line.
  setStatus("Filling…");
  try {
    syncPayloadFromReviewFields();
    const platform = getSelectedPlatform();
    if (!platform) {
      setStatus("Choose a platform in step 2 first.");
      return;
    }
    if (!lastPayload || !lastPayload.title) {
      setStatus("Add a title to continue — or scan with your phone to import a listing.");
      return;
    }
    const platformName =
      (document.getElementById("magic-platform-label")?.textContent || "").trim() || platform;
    setStatus(`Filling in ${platformName}…`);
    /** Same canonical session as “Open full review in browser” — merge so empty popup fields still get API data. */
    let merged = {
      title: lastPayload.title,
      description: lastPayload.description,
      price: lastPayload.price,
      listing_extra: lastPayload.listing_extra,
      image_url: lastPayload.image_url,
    };
    try {
      const j = await pollSession(snapPairSessionId);
      if (j && !j.empty && j.listing) {
        const L = j.listing;
        const sesT = L.title != null ? String(L.title).trim() : "";
        const sesD = L.description != null ? String(L.description).trim() : "";
        const popD = (merged.description || "").trim();
        /** Full review save → session is source of truth over stale popup fields. */
        if (sesT) merged.title = sesT;
        merged.description = sesD || popD;
        if (L.price != null && String(L.price).trim() !== "") {
          merged.price =
            typeof L.price === "number" && Number.isFinite(L.price)
              ? String(L.price)
              : String(L.price).trim();
        }
        if (L.image_url != null && String(L.image_url).trim() !== "") {
          merged.image_url = String(L.image_url).trim();
        }
        if (L.listing_extra != null) {
          if (!merged.listing_extra) merged.listing_extra = {};
          mergeShopifyListingExtraFromSession(merged, L);
          mergeShopeeListingExtraFromSession(merged, L);
          mergeVintedListingExtraFromSession(merged, L);
          mergeEbayListingExtraFromSession(merged, L);
          mergeEtsyListingExtraFromSession(merged, L);
          mergeDepopListingExtraFromSession(merged, L);
          mergeGrailedListingExtraFromSession(merged, L);
        }
      }
    } catch {
      /* offline */
    }
    merged.description = resolveListingDescription(merged);
    const t = templateForPlatform(platform);
    const tab = await findListingTab(platform);
    if (!tab?.id) {
      setStatus("Open a listing tab for this marketplace, then try again.");
      return;
    }
    /** Fill runs in the service worker. Use callback form so we always see chrome.runtime.lastError. */
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "SYNCLYST_RUN_MAGIC_FILL",
            tabId: tab.id,
            payload: merged,
            platform,
          },
          (r) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({ ok: false, error: err.message || String(err) });
              return;
            }
            resolve(r);
          }
        );
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    if (!response || response.ok === false) {
      setStatus(
        (response && (response.error || response.message)) ||
          "Could not complete Magic Fill."
      );
      return;
    }
    if (response && response.async) {
      setStatus(
        platform === "shopify"
          ? "Running Magic Fill in your Shopify tab… (watch for the SyncLyst banner)."
          : "Filling your listing tab… spinner stops when Magic Fill finishes."
      );
      /** eBay (and similar) run deferred description / extras after the main tick loop — poll long enough. */
      const pollMs = platform === "ebay" ? 1000 : 900;
      const pollIters = platform === "ebay" ? 28 : 12;
      for (let i = 0; i < pollIters; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        const o = await storageGet([
          "synclyst_last_magic_fill_at",
          "synclyst_last_magic_fill_platform",
          "synclyst_last_magic_fill_result",
        ]);
        const res = o && o.synclyst_last_magic_fill_result;
        if (res && res.platform === platform && typeof o.synclyst_last_magic_fill_at === "number") {
          if (o.synclyst_last_magic_fill_at < fillStartedAt) continue;
          if (res.ok === false) {
            setStatus(
              res.error ||
                (platform === "shopify"
                  ? "Magic Fill failed. Refresh the Shopify tab and try again."
                  : "Magic Fill failed. Refresh the listing tab and try again.")
            );
          } else if (typeof res.filled === "number") {
            setStatus(
              res.saved
                ? `Done — filled ${res.filled} field(s) and tried Save.`
                : `Filled ${res.filled} field(s). Click Save if needed.`
            );
          } else {
            setStatus(platform === "shopify" ? "Magic Fill finished. Check your Shopify tab." : "Magic Fill finished. Check your listing tab.");
          }
          return;
        }
      }
      setStatus(
        platform === "shopify"
          ? "Still running… if Shopify is slow, refresh the tab and try again."
          : "Still running… if the listing tab is slow, wait a few seconds and check the form, then try again."
      );
      return;
    }

    const hint = t.tabHint || platform;

    if (response.filled === 0) {
      if (platform === "shopify" && response.shopify_page === "editor") {
        setStatus(
          "On Add product, but no fields were found. Refresh the Shopify tab, wait for the form to load, then try again."
        );
        return;
      }
      setStatus(
        `No fields filled on this page. Open the product or listing editor (${hint}), refresh the tab, then try again.`
      );
      return;
    }
    if (response.saved) {
      if (platform === "shopify") {
        setStatus(
          `Filled ${response.filled} field(s) and triggered Save. In Products, check All and Draft (new products are often draft). If nothing new appears, look for red errors on the page and click Save manually.`
        );
      } else {
        setStatus(
          `Done — filled ${response.filled} field(s) and triggered Save. Check your ${hint} listing list.`
        );
      }
      return;
    }
    if (platform === "shopify") {
      setStatus(
        `Filled ${response.filled} field(s) but could not trigger Save automatically. In the Shopify tab, fix any red errors, enter a valid price if the form requires it, then click Save or Save as draft.`
      );
    } else {
      setStatus(
        `Filled ${response.filled} field(s). Save wasn’t clicked automatically — click Save (or List item) in the ${hint} tab.`
      );
    }
  } finally {
    setMagicFillLoading(false);
  }
}

function cleanupRealtime() {
  try {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
    }
  } catch {
    /* ignore */
  }
  realtimeChannel = null;
  supabaseClient = null;
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
  cleanupRealtime();
  const qrImg = document.getElementById("qr-img");
  if (qrImg) revokePrevQrObjectUrl(qrImg);
});

(async function init() {
  try {
    chrome.action.setBadgeText({ text: "" });
    const name = chrome.runtime.getManifest && chrome.runtime.getManifest().name;
    chrome.action.setTitle({ title: name || "SyncLyst" });
  } catch {
    /* ignore */
  }

  try {
    wireBillingSettings();
    const sessionId = await getSessionId();
    snapPairSessionId = sessionId;
    if (!sessionId) {
      setLiveLabel("Error");
      return;
    }
    setLiveLabel("Live");

    /**
     * Resolve origin *before* drawing the phone QR. The first-paint `http://127.0.0.1:3000/...` URL is
     * not openable on a phone (loopback = the device itself) and iOS / Android often only offer
     * "copy" for that payload instead of "open in browser". `resolveSynclystOrigin` finds https://
     * synclyst.app, localhost/LAN:port the phone can reach, etc.
     */
    try {
      SYNCLYST_ORIGIN = await resolveSynclystOrigin();
    } catch {
      SYNCLYST_ORIGIN = SYNCLYST_ORIGIN_DEFAULT;
    }

    ensurePairingStepControls();
    const codeEl0 = document.getElementById("pair-session-code");
    if (codeEl0) codeEl0.textContent = sessionId;
    const pairUrlForQr = getPhoneQrUrl();
    const qrEl = document.getElementById("qr-img");
    if (qrEl && pairUrlForQr) {
      await setQrSrc(qrEl, pairUrlForQr);
    }

    await registerSession(sessionId);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const sidCh = changes.snap_pair_session_id;
      if (sidCh && sidCh.newValue != null) {
        const next = String(sidCh.newValue).trim();
        if (/^[a-f0-9]{12,32}$/i.test(next) && next !== snapPairSessionId) {
          /** /snap?s=… updated storage (e.g. new tab or bookmark) — reload so QR + poll match the session. */
          window.location.reload();
          return;
        }
      }
      if (!changes[STORAGE_SNAP_LISTING_READY_AT]) return;
      const nv = changes[STORAGE_SNAP_LISTING_READY_AT].newValue;
      if (nv == null) return;
      void (async () => {
        try {
          SYNCLYST_ORIGIN = await resolveSynclystOrigin();
        } catch {
          /* ignore */
        }
        // A new scan/upload finished on the phone; don't show stale or blank fields—wait until the session has content.
        listingHydrated = false;
        lastPayload = null;
        lastAppliedListingStamp = null;
        lastAppliedImageUrl = null;
        setReviewLoadingState(true, "Extracting your listing…");
        continueToListing();
        burstPollUntilListing(snapPairSessionId);
      })();
    });

    /** If /snap iframe fired complete before this listener attached (cold openPopup), still jump to step 2. */
    try {
      chrome.storage.local.get([STORAGE_SNAP_LISTING_READY_AT], (o) => {
        const ts = o && o[STORAGE_SNAP_LISTING_READY_AT];
        /** No max age — pairing / upload can finish while the user is away; still jump to listing when they open the popup. */
        if (ts == null || typeof ts !== "number") return;
        void (async () => {
          try {
            SYNCLYST_ORIGIN = await resolveSynclystOrigin();
          } catch {
            /* ignore */
          }
          setReviewLoadingState(true, "Extracting your listing…");
          continueToListing();
          burstPollUntilListing(snapPairSessionId);
        })();
      });
    } catch {
      /* ignore */
    }

    const uiPrefs = await storageGet([STORAGE_LAST_PLATFORM, STORAGE_PREFERS_QR_HOME]);

    const cfg = await fetchConfig();
    const g = typeof window !== "undefined" ? window : {};
    const createClient =
      (g.supabase && g.supabase.createClient) ||
      (g.supabase && g.supabase.default && g.supabase.default.createClient);

    if (cfg.configured && cfg.supabaseUrl && cfg.supabaseAnonKey && createClient) {
      setLiveLabel("Live");
      supabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      realtimeChannel = supabaseClient
        .channel(`snap_pair_${sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "snap_pair_sessions",
            filter: `session_id=eq.${sessionId}`,
          },
          () => {
            /** Realtime can fire before the row is readable; burst mirrors phone-upload path. */
            burstPollUntilListing(snapPairSessionId, { stepMs: 300, maxAttempts: 20 });
          }
        )
        .subscribe();
    } else {
      setLiveLabel("Live");
    }

    /** HTTP poll always: Realtime can miss (RLS, publication, flaky channel) — same path as dev-memory. */
    pollTimer = setInterval(async () => {
      const j = await pollSession(sessionId);
      if (j && !j.empty && j.listing && sessionListingHasContent(j.listing)) applyListing(j.listing);
    }, 800);

    const initial = await pollSession(sessionId);
    if (initial && !initial.empty && initial.listing && sessionListingHasContent(initial.listing)) {
      applyListing(initial.listing);
    }
    refreshLoadedSubstate();

    let savedPlatform = normalizeLegacyPlatformId(uiPrefs[STORAGE_LAST_PLATFORM]);
    if (savedPlatform !== uiPrefs[STORAGE_LAST_PLATFORM]) {
      chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: savedPlatform });
    }
    if (savedPlatform && PLATFORM_REVIEW_TEMPLATES[savedPlatform]) {
      setSelectedPlatform(savedPlatform);
    }

    document.getElementById("platform-grid")?.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".platform-tile");
      if (!btn || !btn.dataset.platform) return;
      if (btn.disabled || btn.classList.contains("platform-tile--coming-soon")) return;
      if (!ALLOWED_PLATFORMS.has(String(btn.dataset.platform).toLowerCase())) return;
      setSelectedPlatform(btn.dataset.platform);
    });

    document.getElementById("magic-fill")?.addEventListener("click", runMagicFill);
    document.getElementById("btn-open-full-review")?.addEventListener("click", openFullReviewInBrowser);
    document.getElementById("btn-brand-home")?.addEventListener("click", showQrHomeView);
    document.getElementById("btn-continue-listing")?.addEventListener("click", continueToListing);
    document.getElementById("btn-waiting-back-to-qr")?.addEventListener("click", showQrHomeView);
    updateFullReviewButton();

    ["review-title", "review-description", "review-price"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", () => syncPayloadFromReviewFields());
    });

    document
      .getElementById("btn-open-snap-on-this-computer")
      ?.addEventListener("click", () => openSnapPairLink(getCurrentPairUrl()));
    document
      .getElementById("btn-copy-snap-link")
      ?.addEventListener("click", () => copySnapPairLink(getCurrentPairUrl()));
    document
      .getElementById("btn-open-snap-desktop")
      ?.addEventListener("click", () => openSnapPairLink(getCurrentPairUrl()));

    document.getElementById("btn-new-pairing-session")?.addEventListener("click", () => {
      setStatus("");
      chrome.runtime.sendMessage({ type: "SYNCLYST_NEW_SESSION" }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) {
          setStatus("Could not create a new pairing code. Try again.");
          return;
        }
        window.location.reload();
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const el = document.getElementById("boot-error");
    if (el) {
      el.textContent =
        "Could not finish loading (" +
        msg +
        "). Reload the extension on chrome://extensions. For local dev, run npm run dev in auralink-ai/frontend.";
      el.classList.remove("hidden");
    }
    setLiveLabel("Error");
    console.error("[SyncLyst popup]", e);
  }
})();
