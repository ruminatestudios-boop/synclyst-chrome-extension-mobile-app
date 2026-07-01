/**
 * Guest scan quota — fetch /api/v1/usage/guest and render remaining free scans.
 */
(function (global) {
  function apiBase(opts) {
    opts = opts || {};
    if (opts.apiBase) return String(opts.apiBase).replace(/\/$/, '');
    var meta = document.querySelector('meta[name="synclyst-backend-url"]');
    if (meta && meta.getAttribute('content')) {
      return meta.getAttribute('content').trim().replace(/\/$/, '');
    }
    return window.location.origin.replace(/\/$/, '');
  }

  function anonId(opts) {
    if (opts && opts.anonId) return opts.anonId;
    if (global.SyncLystAnon && typeof global.SyncLystAnon.get === 'function') {
      return global.SyncLystAnon.get();
    }
    return '';
  }

  function formatUsage(u) {
    if (!u) return null;
    var used = typeof u.scans_used === 'number' ? u.scans_used : 0;
    var limit = typeof u.scans_limit === 'number' ? u.scans_limit : 3;
    var remaining = Math.max(0, limit - used);
    var qw = u.quota_window ? String(u.quota_window).toLowerCase() : 'lifetime';
    var windowLabel =
      qw === 'lifetime' ? ' (lifetime free trial)' : qw === 'daily' ? ' today' : ' this month';
    var text =
      remaining > 0
        ? remaining + ' of ' + limit + ' free scan' + (limit === 1 ? '' : 's') + ' left' + windowLabel
        : 'No free scans left — upgrade or buy credits';
    return {
      used: used,
      limit: limit,
      remaining: remaining,
      quotaWindow: qw,
      text: text,
      canScan: u.can_scan !== false && remaining > 0,
    };
  }

  function fetchUsage(opts) {
    opts = opts || {};
    var base = apiBase(opts);
    var id = anonId(opts);
    if (!id) return Promise.resolve(null);
    var path = opts.path || '/api/v1/usage/guest';
    return fetch(base + path, {
      headers: { 'X-SyncLyst-Anon-Id': id },
      credentials: 'include',
    })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(formatUsage)
      .catch(function () {
        return null;
      });
  }

  function applyToElement(el, usage) {
    if (!el || !usage) return;
    el.textContent = usage.text;
    el.hidden = false;
    el.classList.remove('is-empty', 'is-low', 'is-none');
    if (usage.remaining === 0) el.classList.add('is-none');
    else if (usage.remaining <= 1) el.classList.add('is-low');
  }

  function refresh(el, opts) {
    if (!el) return Promise.resolve(null);
    return fetchUsage(opts).then(function (usage) {
      if (!usage) return null;
      applyToElement(el, usage);
      return usage;
    });
  }

  global.SyncLystScanQuota = {
    fetch: fetchUsage,
    refresh: refresh,
    format: formatUsage,
  };
})(typeof window !== 'undefined' ? window : this);
