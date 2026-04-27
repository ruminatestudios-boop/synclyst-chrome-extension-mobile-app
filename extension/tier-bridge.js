/**
 * Mirrors synclyst.app localStorage (set on payment-success) into chrome.storage.local
 * so the extension popup can show the current plan without manual copy/paste.
 */
(function () {
  const K_TIER = "synclyst_tier";
  const K_RENEWAL = "synclyst_plan_renewal";
  const K_SIGNED_IN = "synclyst_signed_in";
  const K_EMAIL = "synclyst_email";
  const K_AUTH_AT = "synclyst_auth_at";
  let lastTier = null;
  let lastRenewal = null;
  let lastSignedIn = null;
  let lastEmail = null;
  let lastAuthAt = null;

  function read() {
    try {
      return {
        tier: localStorage.getItem(K_TIER),
        renewal: localStorage.getItem(K_RENEWAL),
        signedIn: localStorage.getItem(K_SIGNED_IN),
        email: localStorage.getItem(K_EMAIL),
        authAt: localStorage.getItem(K_AUTH_AT),
      };
    } catch {
      return { tier: null, renewal: null, signedIn: null, email: null, authAt: null };
    }
  }

  function push() {
    const { tier, renewal, signedIn, email, authAt } = read();
    if (
      tier === lastTier &&
      renewal === lastRenewal &&
      signedIn === lastSignedIn &&
      email === lastEmail &&
      authAt === lastAuthAt
    ) {
      return;
    }
    lastTier = tier;
    lastRenewal = renewal;
    lastSignedIn = signedIn;
    lastEmail = email;
    lastAuthAt = authAt;
    const out = {};
    if (tier) out[K_TIER] = String(tier);
    if (renewal) out[K_RENEWAL] = String(renewal);
    if (signedIn != null) out[K_SIGNED_IN] = String(signedIn);
    if (email) out[K_EMAIL] = String(email);
    if (authAt) out[K_AUTH_AT] = String(authAt);
    if (Object.keys(out).length === 0) return;
    try {
      chrome.storage.local.set(out);
    } catch {
      /* ignore */
    }
  }

  push();
  try {
    window.addEventListener("storage", push);
  } catch {
    /* ignore */
  }
  /** payment-success sets tier after async fetch — poll briefly. */
  let n = 0;
  const id = setInterval(() => {
    push();
    if (++n >= 40) clearInterval(id);
  }, 400);
})();
