/**
 * Stable anonymous device id for guest scan quotas / Stripe top-ups (localStorage).
 */
(function (global) {
  var KEY = 'synclyst_anon_id_v1';

  function getOrCreate() {
    try {
      var x = localStorage.getItem(KEY);
      if (x && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x.trim())) {
        return x.trim();
      }
      if (global.crypto && typeof global.crypto.randomUUID === 'function') {
        x = global.crypto.randomUUID();
      } else {
        x = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = (Math.random() * 16) | 0;
          var v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      localStorage.setItem(KEY, x);
      return x;
    } catch (e) {
      return 'sess-' + String(Date.now()) + '-' + String(Math.random()).slice(2, 10);
    }
  }

  global.SyncLystAnon = { get: getOrCreate };
})(typeof window !== 'undefined' ? window : this);
