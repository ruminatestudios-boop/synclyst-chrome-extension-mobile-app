/**
 * /snap — phone upload complete → notify service worker (popup badge).
 * /extension-review — listing saved → same UX: badge + try open popup so user runs Fill & save there.
 *
 * Session sync: `snap_pair_session_id` in storage drives the popup QR. When you **load** `/snap` or
 * `/snap.html` with `?s=`, we set storage to that id so the page matches the extension (bookmark /
 * shared link). The background worker no longer overwrites storage from random open tabs — the code
 * stays stable until you open a different snap link here or use “New pairing code”. Each new scan
 * still posts to the **same** session id (server upserts listing data).
 */
(function () {
  var path = (location.pathname || "").replace(/\/$/, "") || "/";
  /** Next.js `/snap` embeds `public/snap.html` in an iframe — sync both frames to storage. */
  var isSnap = path === "/snap" || path === "/snap.html";
  var isReview = path === "/extension-review" || path.indexOf("/extension-review") === 0;
  if (!isSnap && !isReview) return;

  if (isSnap) {
    try {
      var u = new URL(window.location.href);
      var fromUrl = (u.searchParams.get("s") || "").trim();
      if (/^[a-f0-9]{12,32}$/i.test(fromUrl)) {
        chrome.storage.local.get(["snap_pair_session_id"], function (o) {
          var cur = o && o.snap_pair_session_id ? String(o.snap_pair_session_id) : "";
          if (cur === fromUrl) return;
          chrome.storage.local.set({ snap_pair_session_id: fromUrl });
        });
      }
    } catch (_) {
      /* ignore */
    }
  }

  window.addEventListener(
    "message",
    function (event) {
      try {
        if (event.origin !== window.location.origin) return;
      } catch (_) {
        return;
      }
      var d = event.data;
      var src = d && d.source;
      // Support both the standalone /extension-review page and the /snap upload page.
      if (!d || (src !== "synclyst-extension-review" && src !== "synclyst-snap-page")) return;

      if (isSnap && d.type === "SYNCLYST_SNAP_PAIR_COMPLETE") {
        try {
          chrome.runtime.sendMessage({
            type: "SYNCLYST_SNAP_PAIR_COMPLETE",
            sessionId: typeof d.sessionId === "string" ? d.sessionId : "",
          });
        } catch (_) {
          /* no listener */
        }
        return;
      }

      if (isReview && d.type === "SYNCLYST_REVIEW_SAVED") {
        try {
          chrome.runtime.sendMessage({
            type: "SYNCLYST_REVIEW_SAVED",
            sessionId: typeof d.sessionId === "string" ? d.sessionId : "",
          });
        } catch (_) {
          /* no listener */
        }
      }
    },
    false
  );
})();
