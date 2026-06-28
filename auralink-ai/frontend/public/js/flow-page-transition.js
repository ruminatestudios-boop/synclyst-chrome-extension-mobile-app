/**
 * SyncLyst static pages: main shell slides in top → bottom on load.
 * Chrome: cross-document View Transitions when <meta name="view-transition" content="same-origin"> is present.
 * Root: #synclyst-flow-shell or [data-synclyst-page-transition-root], else body > .max-w-md, else body.
 *
 * Canonical listing URLs (see next.config.ts rewrites): final step = /listing/published
 */
(function () {
  window.SYNCYLST_LISTING_PUBLISHED_URL = "/listing/published";
  /** Listing review after AI extraction (rewrites to flow-3.html). */
  window.SYNCYLST_LISTING_REVIEW_URL = "/review";
  /** Product scan camera/upload (rewrites to home.html). */
  window.SYNCYLST_SCAN_URL = "/scan";
  /** “Reading your product” / extraction progress (rewrites to flow-2.html). */
  window.SYNCYLST_READING_PRODUCT_URL = "/reading-product";
  /** Connect Shopify (rewrites to public/stores-connect-shopify.html). */
  window.SYNCYLST_CONNECT_STORE_URL = "/connect-store";
  var STORAGE_BACK = "synclyst_pt_back";

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function isNextAppRoute(pathname) {
    var p = pathname || "";
    return (
      /^\/dashboard(\/|$)/i.test(p) ||
      /^\/sign-in(\/|$)/i.test(p) ||
      /^\/sign-up(\/|$)/i.test(p) ||
      /^\/api\//i.test(p)
    );
  }

  function getRoot() {
    var byId = document.getElementById("synclyst-flow-shell");
    if (byId) return byId;
    var el = document.querySelector("[data-synclyst-page-transition-root]");
    if (el) return el;
    el = document.querySelector("body > div.max-w-md");
    if (el) return el;
    var first = document.body && document.body.firstElementChild;
    if (first && first.classList && first.classList.contains("min-h-screen")) return first;
    return document.body;
  }

  function runEnter() {
    if (document.documentElement.classList.contains("synclyst-scan-initial")) return;
    var root = getRoot();
    if (!root) return;
    if (reducedMotion()) return;
    var back = false;
    try {
      back = sessionStorage.getItem(STORAGE_BACK) === "1";
      sessionStorage.removeItem(STORAGE_BACK);
    } catch (e) {}
    root.classList.add("synclyst-pt-root");
    root.classList.add(back ? "synclyst-pt-enter-back" : "synclyst-pt-enter-fwd");
  }

  function shouldUseAnchorNav(targetAbs) {
    if (targetAbs.origin !== window.location.origin) return false;
    if (isNextAppRoute(targetAbs.pathname)) return false;
    return true;
  }

  /**
   * Prefer <a>.click() for same-origin static navigations so Chrome can run View Transitions.
   */
  function navigateImmediate(url, isBack) {
    if (!url) return;
    try {
      if (isBack) sessionStorage.setItem(STORAGE_BACK, "1");
      else sessionStorage.removeItem(STORAGE_BACK);
    } catch (e) {}

    var targetAbs;
    try {
      targetAbs = new URL(url, window.location.href);
    } catch (err) {
      window.location.href = url;
      return;
    }

    if (shouldUseAnchorNav(targetAbs) && document.body) {
      var a = document.createElement("a");
      a.href = targetAbs.href;
      a.setAttribute("aria-hidden", "true");
      a.style.cssText =
        "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;overflow:hidden;clip:rect(0,0,0,0);";
      document.body.appendChild(a);
      var start = window.location.href.split("#")[0];
      a.click();
      window.setTimeout(function () {
        try {
          a.remove();
        } catch (e) {}
        if (window.location.href.split("#")[0] === start) {
          window.location.assign(targetAbs.href);
        }
      }, 200);
      return;
    }

    window.location.href = url;
  }

  window.synclystPageNavigate = function (url) {
    navigateImmediate(url, false);
  };

  window.synclystPageNavigateBack = function (url) {
    navigateImmediate(url, true);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", runEnter);
  } else {
    runEnter();
  }

  window.addEventListener("pageshow", function (ev) {
    if (!ev.persisted) return;
    var r = getRoot();
    if (!r) return;
    r.classList.remove("synclyst-pt-enter-fwd", "synclyst-pt-enter-back");
  });
})();
