/**
 * Mirrors synclyst.app localStorage (set on payment-success) into chrome.storage.local
 * so the extension popup can show the current plan without manual copy/paste.
 */
(function () {
  const K_TIER = "synclyst_tier";
  const K_RENEWAL = "synclyst_plan_renewal";
  let lastTier = null;
  let lastRenewal = null;

  function read() {
    try {
      return {
        tier: localStorage.getItem(K_TIER),
        renewal: localStorage.getItem(K_RENEWAL),
      };
    } catch {
      return { tier: null, renewal: null };
    }
  }

  function push() {
    const { tier, renewal } = read();
    if (tier === lastTier && renewal === lastRenewal) return;
    lastTier = tier;
    lastRenewal = renewal;
    const out = {};
    if (tier) out[K_TIER] = String(tier);
    if (renewal) out[K_RENEWAL] = String(renewal);
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
