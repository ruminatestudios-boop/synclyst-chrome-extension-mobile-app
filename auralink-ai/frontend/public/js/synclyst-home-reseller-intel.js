/**
 * When reseller scan completes, flow redirects to `/?intel=reseller`.
 * This hydrates shared handoff and shows reseller-results in a fullscreen iframe (URL stays on the homepage root).
 */
(function () {
  var INTEL_HANDOFF = 'auralink_reseller_intel_handoff';
  var RESULT_KEY = 'auralink_reseller_result';

  function primeHandoffFromParentSession() {
    try {
      var raw = sessionStorage.getItem(RESULT_KEY);
      if (!raw || !String(raw).trim()) return;
      localStorage.setItem(
        INTEL_HANDOFF,
        JSON.stringify({ raw: raw, exp: Date.now() + 10 * 60 * 1000 })
      );
    } catch (e) {}
  }

  function init() {
    var layer = document.getElementById('synclyst-home-intel-layer');
    var iframe = document.getElementById('synclyst-home-intel-iframe');
    if (!layer || !iframe) return;
    try {
      var u = new URL(window.location.href);
      if (u.searchParams.get('intel') !== 'reseller') return;
      u.searchParams.delete('intel');
      var clean = u.pathname + (u.searchParams.toString() ? '?' + u.searchParams.toString() : '') + u.hash;
      window.history.replaceState({}, '', clean || '/');
      primeHandoffFromParentSession();
      layer.classList.remove('hidden');
      layer.setAttribute('aria-hidden', 'false');
      document.body.style.overflow = 'hidden';
      iframe.src = '/reseller-results.html?embed=1&cb=' + Date.now();
    } catch (e2) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
