/**
 * Shared 402 / free-scan-limit modal (Chrome CTA + waitlist).
 * Loads on static pages next to Tailwind CDN; inserts markup on first open.
 */
(function (global) {
  var wired = false;
  var DEFAULT_CHROME =
    'https://chromewebstore.google.com/detail/SyncLyst:%20Listing%20autopilot%20for%20resellers/copjkijolfpmhjgiggafngmdeibnmfnm';

  function publishingBase() {
    var metaPub = document.querySelector('meta[name="synclyst-publishing-url"]');
    if (metaPub && metaPub.getAttribute('content')) {
      return metaPub.getAttribute('content').trim().replace(/\/$/, '');
    }
    var metaPubLegacy = document.querySelector('meta[name="auralink-publishing-url"]');
    if (metaPubLegacy && metaPubLegacy.getAttribute('content')) {
      return metaPubLegacy.getAttribute('content').trim().replace(/\/$/, '');
    }
    var host = window.location.hostname;
    var port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
    var isLocal = host === 'localhost' || host === '127.0.0.1';
    if (isLocal && (port === '3000' || port === '3001')) {
      return window.location.origin.replace(/\/$/, '') + '/__synclyst_publishing';
    }
    if (host === 'synclyst.app' || host === 'www.synclyst.app') {
      return 'https://synclyst-publishing-299567386855.us-central1.run.app';
    }
    return window.location.protocol + '//' + host + ':8001';
  }

  function ensureModal(opts) {
    if (document.getElementById('waitlist-quota-modal')) return;
    var fb = (opts && opts.footerBackHref) || '/scan';
    var fbLabel = (opts && opts.footerBackLabel) || 'Back to scan';
    var html =
      '<div id="waitlist-quota-modal" class="fixed inset-0 z-[200] hidden flex items-center justify-center p-4 bg-black/45" aria-hidden="true" role="dialog" aria-modal="true" aria-labelledby="waitlist-quota-title">' +
      '<div class="rounded-[14px] max-w-md w-full p-6 shadow-xl relative bg-white border border-[#e5e5e5]" style="border-radius:14px">' +
      '<button type="button" id="waitlist-quota-close" class="absolute top-3 right-3 text-zinc-400 hover:text-zinc-700 text-xl leading-none" aria-label="Close">×</button>' +
      '<h2 id="waitlist-quota-title" class="text-lg font-bold text-[#0a0a0a] pr-8 mb-2">Scan limit reached</h2>' +
      '<p id="waitlist-quota-message" class="text-sm text-[#525252] mb-3"></p>' +
      '<a id="waitlist-quota-chrome-btn" href="' +
      DEFAULT_CHROME +
      '" target="_blank" rel="noopener noreferrer" class="flex w-full items-center justify-center gap-2 rounded-xl bg-[#0a0a0a] px-4 py-3 mb-4 text-white text-sm font-semibold no-underline shadow-sm hover:bg-black">' +
      'Get SyncLyst for Chrome</a>' +
      '<p id="waitlist-quota-buy-status" class="hidden text-xs text-center mb-2"></p>' +
      '<p id="waitlist-quota-status" class="hidden text-xs mt-2"></p>' +
      '<div class="flex justify-center mt-1">' +
      '<a id="waitlist-quota-back" href="' +
      escapeAttr(fb) +
      '" class="text-sm text-zinc-500 hover:text-zinc-800 transition-colors">' +
      escapeHtml(fbLabel) +
      '</a></div></div></div>';
    document.body.insertAdjacentHTML('beforeend', html);
  }

  function escapeAttr(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function wireOnce() {
    if (wired) return;
    wired = true;
    document.addEventListener(
      'click',
      function (e) {
        var modalEl = document.getElementById('waitlist-quota-modal');
        if (!modalEl || modalEl.classList.contains('hidden')) return;
        if (e.target === modalEl) {
          window.location.href = '/landing.html#waitlist';
        }
      },
      false
    );
    document.body.addEventListener(
      'click',
      function (e) {
        if (e.target && e.target.id === 'waitlist-quota-close') {
          window.location.href = '/landing.html#waitlist';
        }
        if (e.target && e.target.id === 'waitlist-quota-submit') {
          submitWaitlist(e);
        }
        if (e.target && e.target.id === 'waitlist-quota-buy') {
          startGuestCheckout(e);
        }
      },
      false
    );
  }

  function startGuestCheckout(ev) {
    var statusEl = document.getElementById('waitlist-quota-buy-status');
    var anon =
      window.SyncLystAnon && typeof window.SyncLystAnon.get === 'function'
        ? window.SyncLystAnon.get()
        : '';
    function setBuyStatus(text, kind) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.remove('hidden');
      statusEl.style.color = kind === 'ok' ? '#166534' : '#991b1b';
    }
    if (!anon || anon.indexOf('sess-') === 0) {
      setBuyStatus('Enable cookies/storage for this site, then refresh, so we can apply credits to your device.', 'err');
      if (ev && ev.preventDefault) ev.preventDefault();
      return;
    }
    setBuyStatus('Opening secure checkout…', 'ok');
    var origin = window.location.origin;
    var successUrl = origin + '/scan?credits=success&session_id={CHECKOUT_SESSION_ID}';
    var cancelUrl = window.location.href.split('#')[0];
    fetch(origin + '/api/v1/billing/guest-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        anon_id: anon,
        success_url: successUrl,
        cancel_url: cancelUrl,
      }),
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { ok: r.ok, j: j };
        });
      })
      .then(function (x) {
        if (!x.ok || !x.j || !x.j.url) {
          var d = (x.j && x.j.detail) || 'Checkout unavailable. Add STRIPE_PRICE_SCAN_PACK on the server.';
          throw new Error(typeof d === 'string' ? d : JSON.stringify(d));
        }
        window.location.href = x.j.url;
      })
      .catch(function (err) {
        setBuyStatus((err && err.message) || 'Could not start checkout.', 'err');
      });
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  function submitWaitlist(ev) {
    var emailInput = document.getElementById('waitlist-quota-email');
    var submitBtn = document.getElementById('waitlist-quota-submit');
    var statusEl = document.getElementById('waitlist-quota-status');
    var modalRoot = document.getElementById('waitlist-quota-modal');
    if (!emailInput || !submitBtn) return;
    var email = (emailInput.value || '').trim();
    function setWlStatus(kind, text) {
      if (!statusEl) return;
      statusEl.textContent = text || '';
      statusEl.classList.remove('hidden');
      statusEl.style.color = kind === 'ok' ? '#166534' : kind === 'warn' ? '#92400e' : '#991b1b';
    }
    if (!email || email.indexOf('@') === -1) {
      setWlStatus('err', 'Enter a valid email.');
      return;
    }
    var source = (modalRoot && modalRoot.getAttribute('data-waitlist-source')) || 'synclyst-quota-402';
    submitBtn.disabled = true;
    setWlStatus('warn', 'Adding you to waitlist…');
    fetch(publishingBase() + '/auth/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, source: source }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('fail');
        setWlStatus('ok', 'You are on the waitlist. We will email you when paid plans open.');
      })
      .catch(function () {
        setWlStatus('err', 'Could not join right now. Try the homepage waitlist or try again.');
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
    if (ev && ev.preventDefault) ev.preventDefault();
  }

  function show(limit, quotaWindow, opts) {
    opts = opts || {};
    ensureModal(opts);
    wireOnce();

    var modalRoot = document.getElementById('waitlist-quota-modal');
    if (modalRoot) {
      modalRoot.setAttribute('data-waitlist-source', opts.waitlistSource || 'synclyst-quota-402');
    }

    var back = document.getElementById('waitlist-quota-back');
    if (back) {
      back.href = opts.footerBackHref || '/scan';
      back.textContent = opts.footerBackLabel || 'Back to scan';
    }

    var qw = String(quotaWindow || "lifetime").toLowerCase();
    var daily = qw === "daily";
    var monthly = qw === "monthly";
    var lifetime = qw === "lifetime" || (!daily && !monthly);
    var titleEl = document.getElementById('waitlist-quota-title');
    if (titleEl) {
      titleEl.textContent = lifetime
        ? 'Free scans used up'
        : daily
          ? 'Free scans used for today'
          : 'Monthly scan limit reached';
    }
    var n = typeof limit === 'number' && limit > 0 ? limit : 3;
    var msgEl = document.getElementById('waitlist-quota-message');
    var bonus = typeof opts.bonusCredits === 'number' ? opts.bonusCredits : null;
    if (msgEl) {
      var extra =
        bonus != null && bonus > 0
          ? ' You still have ' + bonus + ' purchased credit' + (bonus === 1 ? '' : 's') + ' — try again, or buy more below.'
          : '';
      var periodPhrase = lifetime
        ? ' (free trial — they don\u2019t reset)'
        : daily
          ? ' for today'
          : ' this month';
      msgEl.textContent =
        'You\u2019ve used all ' +
        n +
        ' free scan' +
        (n === 1 ? '' : 's') +
        periodPhrase +
        '.' +
        extra +
        ' Get SyncLyst for Chrome for full listing autopilot\u2014or buy credits below.';
    }
    var chromeBtn = document.getElementById('waitlist-quota-chrome-btn');
    if (chromeBtn) {
      var m = document.querySelector('meta[name="synclyst-chrome-extension-url"]');
      var u = m && m.getAttribute('content') ? m.getAttribute('content').trim() : '';
      chromeBtn.setAttribute('href', u || DEFAULT_CHROME);
    }

    var modal = document.getElementById('waitlist-quota-modal');
    if (modal) {
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      modal.setAttribute('aria-hidden', 'false');
    }
  }

  global.SyncLystQuotaModal = { show: show, publishingBase: publishingBase };
})(typeof window !== 'undefined' ? window : this);
