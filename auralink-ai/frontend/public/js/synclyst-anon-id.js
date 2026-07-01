/**
 * Stable anonymous device id for guest scan quotas / Stripe top-ups (localStorage).
 * Always returns a valid UUID — required by the vision API (X-SyncLyst-Anon-Id).
 */
(function (global) {
  var KEY = 'synclyst_anon_id_v1';
  var memoryFallback = null;

  var UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  function randomUuid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') {
      return global.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      var v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function getOrCreate() {
    if (memoryFallback && UUID_RE.test(memoryFallback)) {
      return memoryFallback;
    }
    try {
      var x = localStorage.getItem(KEY);
      if (x && UUID_RE.test(String(x).trim())) {
        memoryFallback = String(x).trim();
        return memoryFallback;
      }
      x = randomUuid();
      memoryFallback = x;
      try {
        localStorage.setItem(KEY, x);
      } catch (e2) {
        /* private mode / storage blocked — keep in memory for this page session */
      }
      return x;
    } catch (e) {
      if (!memoryFallback) memoryFallback = randomUuid();
      return memoryFallback;
    }
  }

  global.SyncLystAnon = { get: getOrCreate };
})(typeof window !== 'undefined' ? window : this);
