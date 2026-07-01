/**
 * SyncLyst content script: fills marketplace forms using mapper.js selectors.
 * Message: {
 *   type: "SYNCLYST_FILL",
 *   payload: { title, description, price },
 *   platform?: "shopify"|...,
 *   auto_save?: boolean  // default true — after fill, click Save / List / etc. when found
 * }
 */

function isVisible(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/**
 * Vinted category sheets often mount while `opacity:0` (enter animation). `isVisible` rejects the whole
 * subtree so we never find `[role=dialog]`, radios, or suggested rows.
 */
function vintedLayoutInteractable(el, minW = 2, minH = 2) {
  if (!el || !(el instanceof HTMLElement)) return false;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
  let style;
  try {
    style = view.getComputedStyle(el);
  } catch {
    return false;
  }
  if (style.display === "none" || style.visibility === "hidden") return false;
  const r = el.getBoundingClientRect();
  return r.width >= minW && r.height >= minH;
}

/** Query selector across the document and inside open shadow roots (Shopify Admin embeds controls in shadow DOM). */
function querySelectorAllDeep(selector, rootNode) {
  const found = [];
  function scan(root) {
    if (!root || !root.querySelectorAll) return;
    try {
      root.querySelectorAll(selector).forEach((el) => found.push(el));
    } catch {
      /* ignore */
    }
    try {
      root.querySelectorAll("*").forEach((el) => {
        if (el.shadowRoot) scan(el.shadowRoot);
      });
    } catch {
      /* ignore */
    }
  }
  scan(rootNode || document.documentElement || document.body);
  return found;
}

/**
 * Collect buttons / role=button from a document subtree and open shadow roots (Shopify Admin uses shadow DOM).
 * @param {Document|Element} [root] Defaults to main document.
 */
function collectActivatableControls(root) {
  const out = [];
  function scan(r) {
    if (!r || !r.querySelectorAll) return;
    r.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]').forEach((el) => {
      out.push(el);
    });
    r.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) scan(el.shadowRoot);
    });
  }
  const start =
    root == null
      ? document.documentElement || document.body
      : root.nodeType === Node.DOCUMENT_NODE
        ? root.documentElement || root.body
        : root;
  scan(start);
  return out;
}

function controlLabel(el) {
  const aria = el.getAttribute && el.getAttribute("aria-label");
  const txt = (el.textContent || "").trim().replace(/\s+/g, " ");
  if (aria && aria.trim()) return aria.trim().replace(/\s+/g, " ");
  return txt.slice(0, 120);
}

function saveLabelRegex(platform) {
  const p = (platform || "shopify").toLowerCase();
  if (p === "shopify") return /^(Save|Save as draft|Save product)$/i;
  if (p === "ebay") return /^(List it|Submit listing|Save for later|Save|Continue)$/i;
  if (p === "etsy") return /^(Save|Save and continue|Publish|Continue|Next)$/i;
  if (p === "vinted") return /^(Upload|Continue|Save|Next)$/i;
  if (p === "shopee") {
    return /^(Save and Publish|Save and Delist|Save|Next|Continue|Submit|ถัดไป|ต่อไป|Berikutnya|Lanjutkan)$/i;
  }
  /** "Post" is Depop's literal publish-live button — auto-save must never click it, only a real draft-save control. */
  if (p === "depop") return /^(Save as a draft|Save draft|Save)$/i;
  return /^(Save|Save as draft|Submit|Publish|Continue|List it)$/i;
}

function shouldSkipSaveLabel(label) {
  return /^(Discard|Cancel|Delete|Remove|Back|Close)$/i.test(label);
}

/** Save targets may be slightly transparent but still clickable in Polaris. */
function isSaveTargetProbablyClickable(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  if (style.pointerEvents === "none") return false;
  const r = el.getBoundingClientRect();
  return r.width >= 2 && r.height >= 2;
}

function pulseShopifyDirtySignals() {
  try {
    if (window.location.hostname !== "admin.shopify.com") return;
  } catch {
    return;
  }
  const bump = (el) => {
    try {
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      /* ignore */
    }
  };
  for (const rd of getShopifyRootDocuments()) {
    const rootEl = documentRootElement(rd);
    for (const el of querySelectorAllDeep(
      'input[name="title"], input[name="price"], textarea[name="description"]',
      rootEl
    )) {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        if ((el.value || "").trim()) bump(el);
      }
    }
    for (const el of querySelectorAllDeep("[contenteditable=\"true\"], .ql-editor", rootEl)) {
      if ((el.textContent || "").trim()) {
        try {
          el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        } catch {
          bump(el);
        }
      }
    }
  }
}

function trySubmitShopifyProductForm() {
  const selectors = [
    'input[name="title"]',
    'input[aria-label*="Title" i]',
    'input[id*="ProductTitle" i]',
    'input[id*="productTitle" i]',
  ];
  for (const rd of getShopifyRootDocuments()) {
    const rootEl = documentRootElement(rd);
    for (const sel of selectors) {
      for (const inp of querySelectorAllDeep(sel, rootEl)) {
        if (!(inp instanceof HTMLInputElement)) continue;
        if (!(inp.value || "").trim()) continue;
        const form = inp.closest("form");
        if (!form || typeof form.requestSubmit !== "function") continue;
        try {
          form.requestSubmit();
          return true;
        } catch {
          /* not a submittable form */
        }
      }
    }
  }
  return false;
}

function tryShopifySaveKeyboardChord(saveAttemptIndex) {
  if (saveAttemptIndex !== 2 && saveAttemptIndex !== 5 && saveAttemptIndex !== 9) return;
  try {
    const isMac = /Mac|iPhone|iPod|iPad/i.test(navigator.platform || "");
    const t = document.activeElement || document.body;
    t.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        code: "KeyS",
        ctrlKey: !isMac,
        metaKey: isMac,
        bubbles: true,
        cancelable: true,
      })
    );
  } catch {
    /* ignore */
  }
}

/**
 * Prefer primary / sticky save actions; avoid nav clutter.
 * @param {number} [saveAttemptIndex] 1-based attempt when auto-saving (Shopify keyboard retry).
 */
function tryClickSaveForPlatform(platform, saveAttemptIndex) {
  const attempt = saveAttemptIndex == null ? 1 : saveAttemptIndex;
  const p = (platform || "shopify").toLowerCase();
  if (p === "shopify") {
    tryShopifySaveKeyboardChord(attempt);

    const shopifySelectors = [
      'button[aria-label="Save"]',
      'button[aria-label="Save as draft"]',
      'button[aria-label^="Save" i]',
      'button[aria-label*="Save product" i]',
      'button[data-save-bar]',
      'button[data-testid*="save" i]',
      'a[role="button"][aria-label*="Save" i]',
    ];
    for (const sel of shopifySelectors) {
      const nodes = [];
      for (const rd of getShopifyRootDocuments()) {
        const rootEl = documentRootElement(rd);
        nodes.push(...querySelectorAllDeep(sel, rootEl));
      }
      for (const el of nodes) {
        if (!isSaveTargetProbablyClickable(el)) continue;
        const lab = controlLabel(el);
        if (lab && /discard|cancel|delete|remove from/i.test(lab)) continue;
        try {
          el.scrollIntoView({ block: "nearest", behavior: "auto" });
          el.focus();
          el.click();
          return true;
        } catch {
          /* try next */
        }
      }
    }

    const strictSave = /^(Save|Save as draft|Save product)(\s|$)/i;
    const shopifyControls = [];
    for (const rd of getShopifyRootDocuments()) {
      shopifyControls.push(...collectActivatableControls(rd));
    }
    for (const el of shopifyControls) {
      if (!isSaveTargetProbablyClickable(el)) continue;
      const label = controlLabel(el);
      if (!label || shouldSkipSaveLabel(label)) continue;
      if (!strictSave.test(label)) continue;
      try {
        el.scrollIntoView({ block: "nearest", behavior: "auto" });
        el.focus();
        el.click();
        return true;
      } catch {
        try {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          return true;
        } catch {
          /* next */
        }
      }
    }

    if (trySubmitShopifyProductForm()) {
      return true;
    }
  }

  /** Shopee add-product wizard: step 1 uses Next / Continue; step 2 uses Save and Publish — try Next first. */
  if (p === "shopee") {
    const nextRe =
      /^(Next|Continue|ถัดไป|ต่อไป|Berikutnya|Lanjutkan|Tiếp|下一步|繼續|Selanjutnya)$/i;
    const controls = collectActivatableControls();
    const nextCands = [];
    for (const el of controls) {
      if (!isVisible(el) || !isSaveTargetProbablyClickable(el)) continue;
      const label = controlLabel(el);
      if (!label || shouldSkipSaveLabel(label)) continue;
      if (!nextRe.test(label.trim())) continue;
      nextCands.push(el);
    }
    if (nextCands.length) {
      nextCands.sort((a, b) => {
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        return rb.bottom - ra.bottom;
      });
      const el = nextCands[0];
      try {
        el.scrollIntoView({ block: "nearest", behavior: "auto" });
        el.focus();
        el.click();
        return true;
      } catch {
        try {
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
          return true;
        } catch {
          /* fall through */
        }
      }
    }
  }

  const re = saveLabelRegex(platform);
  const controls = collectActivatableControls();
  const candidates = [];
  for (const el of controls) {
    if (!isVisible(el)) continue;
    const label = controlLabel(el);
    if (!label || shouldSkipSaveLabel(label)) continue;
    if (!re.test(label)) continue;
    candidates.push({ el, label });
  }
  if (candidates.length === 0) return false;

  const score = (item) => {
    let s = 0;
    const el = item.el;
    const cls = (el.className && String(el.className)) || "";
    if (/primary|Primary|emphasized|destructive/i.test(cls)) s += 3;
    if (el.getAttribute && el.getAttribute("variant") === "primary") s += 3;
    const r = el.getBoundingClientRect();
    if (r.top < window.innerHeight && r.bottom > 0) s += 1;
    if (r.top < 120) s += 2;
    if (r.bottom > window.innerHeight - 100) s += 2;
    return s;
  };

  candidates.sort((a, b) => score(b) - score(a));
  const best = candidates[0].el;
  try {
    best.scrollIntoView({ block: "nearest", behavior: "auto" });
  } catch {
    /* ignore */
  }
  try {
    best.focus();
    best.click();
  } catch {
    try {
      best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {
      return false;
    }
  }
  return true;
}

function scheduleAutoSave(platform, sendResponse, payload) {
  let attempts = 0;
  const maxAttempts = 10;
  const tick = () => {
    attempts += 1;
    if (attempts === 1 && (platform || "").toLowerCase() === "shopify") {
      pulseShopifyDirtySignals();
    }
    const saved = tryClickSaveForPlatform(platform, attempts);
    if (saved) {
      sendResponse({ ...payload, saved: true, save_attempts: attempts });
      return;
    }
    if (attempts >= maxAttempts) {
      sendResponse({ ...payload, saved: false, save_attempts: attempts });
      return;
    }
    setTimeout(tick, 380);
  };
  requestAnimationFrame(() => {
    const delay = (platform || "").toLowerCase() === "shopify" ? 750 : 400;
    setTimeout(tick, delay);
  });
}

function clearHtmlInputValue(el) {
  if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) return false;
  try {
    el.focus();
    const Proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const desc = Object.getOwnPropertyDescriptor(Proto.prototype, "value");
    if (desc && desc.set) desc.set.call(el, "");
    else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

/** EAN/UPC-style barcodes only — never short numbers that could be price fragments. */
function retailBarcodeLooksValid(val) {
  const s = String(val || "").trim();
  return /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(s);
}

/** Undo mistaken Magic Fill: price copied into GTIN / Barcode (numeric field). */
function shopifyClearGtinIfValueMatchesPrice(scan, rootEl) {
  const p = normalizeMarketplacePriceString(scan.price);
  if (!p) return 0;
  const variants = new Set([p, String(Number.parseFloat(p))].filter((x) => x && String(x).length > 0));
  let inputs;
  try {
    inputs = querySelectorAllDeep(
      'input[aria-label*="GTIN" i], input[aria-label*="Barcode" i], input[aria-label*="barcode" i], input[name="barcode"], input[id*="barcode" i], input[id*="gtin" i], input[id*="Gtin" i]',
      rootEl
    );
  } catch {
    return 0;
  }
  let n = 0;
  for (const el of inputs) {
    if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
    if (!isGtinBarcodeOrProductCodeInput(el)) continue;
    const v = String(el.value || "").trim();
    if (variants.has(v)) {
      if (clearHtmlInputValue(el)) n++;
    }
  }
  return n;
}

function fillField(el, value) {
  if (!el || value === undefined || value === null) return false;
  const str = String(value).trim();
  if (!str) return false;
  if (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    el.readOnly
  ) {
    try {
      el.readOnly = false;
    } catch {
      return false;
    }
  }

  const tag = el.tagName;
  if (tag === "SELECT" && el instanceof HTMLSelectElement) {
    el.focus();
    const opt = Array.from(el.options).find(
      (o) => o.value === str || o.textContent.trim() === str
    );
    if (opt) {
      el.value = opt.value;
    } else {
      el.value = str;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  /** Only INPUT/TEXTAREA expose the native `value` setter; using it on a DIV throws "Illegal invocation". */
  if (tag === "TEXTAREA" && el instanceof HTMLTextAreaElement) {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
    if (desc && desc.set) {
      desc.set.call(el, str);
    } else {
      el.value = str;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: str }));
    return true;
  }

  if (tag === "INPUT" && el instanceof HTMLInputElement) {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) {
      desc.set.call(el, str);
    } else {
      el.value = str;
    }
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: str,
        inputType: "insertText",
      })
    );
    try {
      el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      el.focus();
    } catch {
      /* ignore */
    }
    return true;
  }

  if (el.isContentEditable) {
    try {
      el.focus();
      el.textContent = str;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

function queryFirst(selectors, root) {
  const r = root || document;
  for (const sel of selectors) {
    try {
      const el = r.querySelector(sel);
      if (el) return el;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function documentRootElement(root) {
  const r = root || document;
  if (r.nodeType === Node.DOCUMENT_NODE) return r.documentElement;
  return r;
}

/** Same as queryFirst but searches open shadow roots (Shopify Admin product form). */
function queryFirstDeep(selectors, root) {
  const rootEl = documentRootElement(root);
  if (!rootEl) return null;
  for (const sel of selectors) {
    try {
      const found = querySelectorAllDeep(sel, rootEl);
      if (found.length) return found[0];
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Prefer visible, editable controls (Shopify often renders duplicate/hidden inputs). */
function queryFirstDeepVisible(selectors, root) {
  const rootEl = documentRootElement(root);
  if (!rootEl) return null;
  for (const sel of selectors) {
    try {
      const found = querySelectorAllDeep(sel, rootEl);
      for (const el of found) {
        if (!(el instanceof Element)) continue;
        if (!isVisible(el)) continue;
        if (el instanceof HTMLInputElement && el.readOnly) continue;
        if (el instanceof HTMLTextAreaElement && el.readOnly) continue;
        return el;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function collectSameOriginFrameDocuments(doc, out, depth) {
  if (depth > 12 || !doc || !doc.documentElement) return;
  out.push(doc);
  let iframes;
  try {
    iframes = doc.querySelectorAll("iframe");
  } catch {
    return;
  }
  iframes.forEach((iframe) => {
    try {
      const d = iframe.contentDocument;
      if (d) collectSameOriginFrameDocuments(d, out, depth + 1);
    } catch {
      /* cross-origin */
    }
  });
}

function getShopifyRootDocuments() {
  const roots = [];
  collectSameOriginFrameDocuments(document, roots, 0);
  return roots.length ? roots : [document];
}

/** eBay listing editor sometimes mounts in a same-origin iframe — search those roots too. */
function getEbayRootDocuments() {
  let host = "";
  try {
    host = String(window.location.hostname || "").toLowerCase();
  } catch {
    return [document];
  }
  if (!host.includes("ebay.")) return [document];
  const roots = [];
  collectSameOriginFrameDocuments(document, roots, 0);
  return roots.length ? roots : [document];
}

/** Shopee Seller Centre's "Add a New Product" form (description/price/weight/specification)
 * renders inside a same-origin Vue micro-frontend iframe, not the outer page document — every
 * field-matching function was failing simultaneously because it never looked inside that frame. */
function getShopeeRootDocuments() {
  const roots = [];
  collectSameOriginFrameDocuments(document, roots, 0);
  return roots.length ? roots : [document];
}

/**
 * Plain decimal string for marketplace price inputs (no currency symbol).
 * Avoids £NaN when SPAs parseFloat the value we set.
 */
function normalizeMarketplacePriceString(raw) {
  if (raw === undefined || raw === null) return "";
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return "";
    const rounded = Math.round(raw * 100) / 100;
    return String(rounded);
  }
  if (raw && typeof raw === "object") {
    try {
      const o = raw;
      const cand = o.amount ?? o.value ?? o.price ?? o.display;
      if (cand !== undefined && cand !== null && cand !== o) return normalizeMarketplacePriceString(cand);
    } catch {
      /* ignore */
    }
    return "";
  }
  let s = String(raw).trim();
  if (!s || /^nan$/i.test(s) || /^\[object\s/i.test(s)) return "";
  s = s.replace(/[£$€¥\u00a3\u20ac\s]/gi, "").trim();
  if (!s) return "";
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  let normalized = s.replace(/[^\d.,-]/g, "");
  if (!normalized) return "";
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, "").replace(",", ".");
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else if (lastComma >= 0 && lastDot < 0) {
    const parts = normalized.split(",");
    if (parts.length === 2 && parts[1].length <= 2) {
      normalized = `${parts[0].replace(/\D/g, "")}.${parts[1]}`;
    } else {
      normalized = normalized.replace(/,/g, "");
    }
  } else {
    normalized = normalized.replace(/,/g, "");
  }
  const num = parseFloat(normalized);
  if (!Number.isFinite(num) || num < 0) return "";
  const rounded = Math.round(num * 100) / 100;
  return String(rounded);
}

/**
 * Shopee wizard step 1: product name must be ≥ ~20 chars. If extraction put price into title ("100"),
 * or the title is numeric / too short, use description lines then pad to Shopee’s minimum.
 */
function shopeeTitleFallbackFromDescription(scan) {
  const d = String(scan.description || "").trim();
  if (!d) return "";
  const first = d.split(/[.!\n\r]/)[0]?.trim() || "";
  if (first.length >= 8) return first.slice(0, 200);
  const words = d.split(/\s+/).filter(Boolean);
  if (words.length >= 4) return words.slice(0, 45).join(" ").slice(0, 200);
  return "";
}

/**
 * Garbled OCR / bad extraction: e.g. "for authentic oa SENT LUB" — trailing shout-case tokens, junk fragments.
 * Prefer description-based title when true.
 */
function shopeeTitleLooksGarbledOrLowQuality(raw) {
  const t = String(raw || "").trim();
  if (!t) return true;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    const last = words[words.length - 1];
    const prev = words[words.length - 2];
    if (/^[A-Z]{2,8}$/.test(last) && /^[A-Z]{2,8}$/.test(prev) && t.length < 90) return true;
  }
  const capsTok = t.match(/\b[A-Z]{2,6}\b/g);
  if (capsTok && capsTok.length >= 3 && t.length < 100) return true;
  if (/\boa\b/i.test(t) && capsTok && capsTok.length >= 2) return true;
  return false;
}

/** True when title looks like a bare price / SKU number, not a product name. */
function shopeeTitleLooksLikePriceNotName(raw, scan) {
  const t = String(raw || "").trim();
  if (!t || t.length > 14) return false;
  const rNorm = normalizeMarketplacePriceString(t);
  const pNorm = normalizeMarketplacePriceString(scan.price);
  if (rNorm && pNorm && rNorm === pNorm) return true;
  if (rNorm && /^\d+[.,]?\d*$/.test(t.replace(/[^\d.,]/g, "")) && t.replace(/\D/g, "").length <= 6) {
    if (!pNorm || rNorm === pNorm) return true;
  }
  const digitsOnly = /^\d{1,6}([.,]\d{1,2})?$/.test(t.replace(/[\s£$€¥฿]/gi, ""));
  return digitsOnly;
}

function shopeePadTitleToMinLen(s, minLen) {
  let out = String(s || "").trim();
  if (out.length >= minLen) return out;
  const pad = " — new with tags, fast ship";
  while (out.length < minLen && out.length < 500) {
    out = (out + pad).trim();
  }
  return out.slice(0, 120);
}

function shopeeProductTitleForFill(scan) {
  let raw = String(scan.title ?? "").trim();
  const pNorm = normalizeMarketplacePriceString(scan.price);

  if (
    raw &&
    (shopeeTitleLooksLikePriceNotName(raw, scan) ||
      (pNorm && normalizeMarketplacePriceString(raw) === pNorm) ||
      shopeeTitleLooksGarbledOrLowQuality(raw))
  ) {
    const fb = shopeeTitleFallbackFromDescription(scan);
    if (fb) raw = fb;
  }

  if (raw.length < 20) {
    const fb = shopeeTitleFallbackFromDescription(scan);
    if (fb && fb.length > raw.length) {
      raw = fb.length >= 20 ? fb : `${raw} — ${fb}`.trim();
    }
    raw = shopeePadTitleToMinLen(raw, 20);
  }

  return raw.slice(0, 120);
}

/**
 * Popup / API often set `title` to the sale price while the real listing title lives in `copy_seo_title`
 * or Shopify extra. `??` does not replace a non-empty wrong title — pick the best string here.
 */
function resolveScanTitleFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  let t0 = "";
  const t1 = payload.title != null ? String(payload.title).trim() : "";
  const t2 = payload.copy_seo_title != null ? String(payload.copy_seo_title).trim() : "";
  let t3 = "";
  try {
    const le = payload.listing_extra;
    const sho =
      le && typeof le === "object" && le.shopee && typeof le.shopee === "object" ? le.shopee : null;
    if (sho && sho.display_title) t0 = String(sho.display_title).trim();
    const sh =
      le && typeof le === "object" && le.shopify && typeof le.shopify === "object" ? le.shopify : null;
    if (sh && sh.seo_page_title) t3 = String(sh.seo_page_title).trim();
  } catch {
    /* ignore */
  }
  const pNorm = normalizeMarketplacePriceString(payload.price);
  function isShortNumericPriceLike(s) {
    if (!s) return false;
    const n = normalizeMarketplacePriceString(s);
    if (n && pNorm && n === pNorm && s.length <= 14) return true;
    if (s.length <= 10 && /^\d{1,6}([.,]\d{1,2})?$/.test(s.replace(/[\s£$€¥฿]/gi, ""))) return true;
    return false;
  }
  if (t0) return t0;
  const ordered = [t1, t2, t3].filter(Boolean);
  const clean = ordered.find(
    (c) => !isShortNumericPriceLike(c) && !shopeeTitleLooksGarbledOrLowQuality(c)
  );
  if (clean) return clean;
  const nonPrice = ordered.find((c) => !isShortNumericPriceLike(c));
  if (nonPrice) return nonPrice;
  return t1 || t2 || t3 || "";
}

function resolveScanDescriptionFromPayload(payload) {
  if (!payload || typeof payload !== "object") return "";
  const d1 = payload.description != null ? String(payload.description).trim() : "";
  const d2 = payload.copy_description != null ? String(payload.copy_description).trim() : "";
  let best = d1.length >= d2.length ? d1 || d2 : d2 || d1;
  try {
    const le = payload.listing_extra;
    if (le && typeof le === "object") {
      const eb = le.ebay && typeof le.ebay === "object" ? le.ebay : null;
      const ebDesc = eb && eb.item_description != null ? String(eb.item_description).trim() : "";
      if (ebDesc.length > best.length) best = ebDesc;
      const sh = le.shopify && typeof le.shopify === "object" ? le.shopify : null;
      const shopDesc =
        sh && sh.body_html != null
          ? String(sh.body_html)
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim()
          : "";
      if (shopDesc.length > best.length) best = shopDesc;
    }
  } catch {
    /* ignore */
  }
  return best;
}

/**
 * Shopee React fields sometimes keep "100" after fillPriceLike or a wrong first match — force-correct the
 * scored product name input when its value still matches the price or is a bare number.
 */
function shopeeRefillProductNameIfStillPriceLike(scan, root) {
  const rootEl = documentRootElement(root);
  const titleFill = shopeeProductTitleForFill(scan);
  if (!titleFill || titleFill.length < 12) return 0;
  const inp = queryBestShopeeProductNameInput(rootEl);
  if (!(inp instanceof HTMLInputElement) || !isVisible(inp)) return 0;
  const v = (inp.value || "").trim();
  if (!v) return 0;
  if (v === titleFill) return 0;
  const vn = normalizeMarketplacePriceString(v);
  const pn = normalizeMarketplacePriceString(scan.price);
  const looksLikePriceOnly =
    (vn && pn && vn === pn && v.length <= 14) ||
    (v.length <= 8 && /^\d+([.,]\d{0,2})?$/.test(v.replace(/[^\d.,]/g, "")));
  const looksGarbled =
    shopeeTitleLooksGarbledOrLowQuality(v) && !shopeeTitleLooksGarbledOrLowQuality(titleFill);
  if (!looksLikePriceOnly && !looksGarbled && v.length >= 15) return 0;
  if (fillField(inp, titleFill)) return 1;
  return 0;
}

function fillPriceLike(value, root) {
  const normalized = normalizeMarketplacePriceString(value);
  if (!normalized) return false;

  const rootEl = documentRootElement(root);

  let smart = null;
  try {
    if ((window.location.hostname || "").toLowerCase().includes("vinted.")) {
      smart = queryBestVintedPriceInput(root);
    }
  } catch {
    /* ignore */
  }
  if (!smart) smart = queryBestShopifyPriceInput(root);
  if (smart && fillField(smart, normalized)) return true;

  const priceSelectors = [
    'input[name="price"]',
    'input[name*="[price]" i]',
    'input[id*="price" i]',
    'input[id*="Price" i]',
    'input[aria-label*="price" i]',
    'input[placeholder*="price" i]',
    'input[data-testid*="price" i]',
    "#price",
    "#listing-price",
    "#editpane_price",
    'input[inputmode="decimal"]',
    'input[type="number"]',
  ];

  for (const sel of priceSelectors) {
    try {
      const nodes = querySelectorAllDeep(sel, rootEl);
      for (const node of nodes) {
        if (!(node instanceof HTMLInputElement) || !isVisible(node)) continue;
        try {
          if (isGtinBarcodeOrProductCodeInput(node)) continue;
        } catch {
          /* ignore */
        }
        const al = shopifyControlAccessibleName(node).toLowerCase();
        if (al.includes("compare") && !/\bprice\b/.test(al)) continue;
        if (fillField(node, normalized)) {
          return true;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Last-resort Shopify: visible inputs whose labels suggest title / price when primary selectors miss (SPA delay). */
function shopifyGapFill(scan, root) {
  let extra = 0;
  const rootEl = documentRootElement(root);
  const title = (scan.title || "").trim();
  const desc = String(scan.description || "").trim();
  const priceRaw = scan.price != null ? String(scan.price).trim() : "";

  if (title) {
    const best = queryBestShopifyTitleInput(root);
    if (best && fillField(best, title)) {
      extra++;
    } else {
      const tried = querySelectorAllDeep(
        'input[aria-label="Title"], input[aria-label="Product title"], input[aria-label*="product title" i], input[id*="ProductTitle" i], input[placeholder*="sleeve" i], input[placeholder*="t-shirt" i]',
        rootEl
      );
      for (const el of tried) {
        if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
        if (fillField(el, title)) {
          extra++;
          break;
        }
      }
    }
  }

  if (desc) {
    const eds = querySelectorAllDeep(
      '[contenteditable="true"][role="textbox"], [contenteditable="true"].ProseMirror, .ql-editor[contenteditable="true"], .ProseMirror[contenteditable="true"]',
      rootEl
    );
    for (const el of eds) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || "").trim();
      if (text.length > 40) continue;
      try {
        el.focus();
        el.textContent = desc;
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
        extra++;
        break;
      } catch {
        /* ignore */
      }
    }
  }

  if (priceRaw) {
    const normalized = normalizeMarketplacePriceString(priceRaw);
    if (normalized) {
      const smart = queryBestShopifyPriceInput(root);
      if (smart && fillField(smart, normalized)) {
        extra++;
      } else {
        const priceNodes = querySelectorAllDeep(
          'input[aria-label*="price" i], input[name="price"], input[inputmode="decimal"], input[id*="Price" i]',
          rootEl
        );
        for (const el of priceNodes) {
          if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
          if (fillField(el, normalized)) {
            extra++;
            break;
          }
        }
      }
    }
  }

  return extra;
}

/**
 * Product editor sidebar: keep Status = Draft so merchants review before going live.
 * Handles native <select> synchronously; Polaris combobox uses delayed option pick (portal).
 */
function shopifySetProductStatusDraft(root) {
  const rootEl = documentRootElement(root);
  const selects = querySelectorAllDeep(
    'select[aria-label*="Status" i], select[name*="status" i], select[id*="Status" i], select[name="product[status]"]',
    rootEl
  );
  for (const sel of selects) {
    if (!(sel instanceof HTMLSelectElement) || !isVisible(sel) || sel.disabled) continue;
    let draftVal = null;
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      const blob = `${opt.text || ""} ${opt.value || ""}`;
      if (/draft/i.test(blob)) {
        draftVal = opt.value;
        break;
      }
    }
    if (draftVal == null) continue;
    if (sel.value === draftVal) return 0;
    sel.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value");
    if (desc && desc.set) {
      desc.set.call(sel, draftVal);
    } else {
      sel.value = draftVal;
    }
    sel.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return 1;
  }
  return 0;
}

/**
 * Attach the pairing scan image to Shopify’s product Media control when possible.
 *
 * Why this is best-effort: Admin is a React app; file inputs are often hidden; programmatic `files`
 * assignment can be ignored. Data URLs from the phone scan work most reliably. HTTPS URLs may fail
 * (CORS) unless the image is same-origin or allows cross-origin fetch.
 */
async function blobToProductFileFromImageUrl(url, nameStem = "synclyst-scan") {
  if (url.startsWith("data:")) {
    const r = await fetch(url);
    const blob = await r.blob();
    const t = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
    const ext = t.includes("png") ? "png" : t.includes("webp") ? "webp" : "jpg";
    return new File([blob], `${nameStem}.${ext}`, { type: t });
  }
  const r = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!r.ok) return null;
  const blob = await r.blob();
  const t = blob.type && blob.type.startsWith("image/") ? blob.type : "image/jpeg";
  const ext = t.includes("png") ? "png" : t.includes("webp") ? "webp" : "jpg";
  return new File([blob], `${nameStem}.${ext}`, { type: t });
}

/** Pairing scan hero: top-level image_url or first gallery entry. */
function resolveScanHeroImageUrl(scan) {
  let url = scan.image_url != null ? String(scan.image_url).trim() : "";
  if (!url) {
    try {
      const extra = scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : null;
      const media =
        extra && extra.media && typeof extra.media === "object" && !Array.isArray(extra.media) ? extra.media : null;
      const mu = media && Array.isArray(media.image_urls) ? media.image_urls : [];
      if (mu.length && typeof mu[0] === "string") url = mu[0].trim();
    } catch {
      /* ignore */
    }
  }
  if (!url) {
    try {
      const ex = scan.listing_extra && (scan.listing_extra.shopify || scan.listing_extra);
      const imgs = ex && Array.isArray(ex.additional_images) ? ex.additional_images : [];
      if (imgs.length && typeof imgs[0] === "string") url = imgs[0].trim();
    } catch {
      /* ignore */
    }
  }
  if (!url) {
    try {
      const dp =
        scan.listing_extra &&
        scan.listing_extra.depop &&
        typeof scan.listing_extra.depop === "object"
          ? scan.listing_extra.depop
          : null;
      const di = dp && Array.isArray(dp.additional_images) ? dp.additional_images : [];
      if (di.length && typeof di[0] === "string") url = di[0].trim();
    } catch {
      /* ignore */
    }
  }
  if (!url) {
    try {
      const vt =
        scan.listing_extra &&
        scan.listing_extra.vinted &&
        typeof scan.listing_extra.vinted === "object"
          ? scan.listing_extra.vinted
          : null;
      const vi = vt && Array.isArray(vt.additional_images) ? vt.additional_images : [];
      if (vi.length && typeof vi[0] === "string") url = vi[0].trim();
    } catch {
      /* ignore */
    }
  }
  if (!url) {
    try {
      const et =
        scan.listing_extra &&
        scan.listing_extra.etsy &&
        typeof scan.listing_extra.etsy === "object"
          ? scan.listing_extra.etsy
          : null;
      const ei = et && Array.isArray(et.additional_images) ? et.additional_images : [];
      if (ei.length && typeof ei[0] === "string") url = ei[0].trim();
    } catch {
      /* ignore */
    }
  }
  return url;
}

function resolveScanImageUrls(scan) {
  const urls = [];
  // `media.original_image_urls[0]` (full-res upload) and `media.image_urls[0]` / the hero
  // (resized for AI extraction) are the SAME physical photo at different resolutions — two
  // different base64 strings for one shot. Exact-string dedup below can't catch that, so treat
  // them as one logical photo here and prefer the full-res original when both exist.
  const hero = resolveScanHeroImageUrl(scan);
  let usedOriginalInsteadOfHero = false;
  try {
    const extra = scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : null;
    const media =
      extra && extra.media && typeof extra.media === "object" && !Array.isArray(extra.media) ? extra.media : null;
    // Only use the first original_image_url — the array accumulates across scans causing duplicates.
    const orig = media && Array.isArray(media.original_image_urls) ? media.original_image_urls.slice(0, 1) : [];
    const origClean = orig.length && typeof orig[0] === "string" ? orig[0].trim() : "";
    if (origClean) {
      urls.push(origClean);
      usedOriginalInsteadOfHero = true;
    }
  } catch {
    /* ignore */
  }
  if (hero && !usedOriginalInsteadOfHero && !urls.includes(hero)) urls.push(hero);
  try {
    const extra = scan.listing_extra || null;
    const ebay = extra && extra.ebay && typeof extra.ebay === "object" ? extra.ebay : null;
    const etsy = extra && extra.etsy && typeof extra.etsy === "object" ? extra.etsy : null;
    const shopify = extra && extra.shopify && typeof extra.shopify === "object" ? extra.shopify : null;
    const shopee = extra && extra.shopee && typeof extra.shopee === "object" ? extra.shopee : null;
    const depop = extra && extra.depop && typeof extra.depop === "object" ? extra.depop : null;
    const vinted = extra && extra.vinted && typeof extra.vinted === "object" ? extra.vinted : null;
    /** Prefer Shopify gallery when present so eBay/Etsy keys don’t steal the array on merged sessions. */
    const src =
      (shopify && shopify.additional_images) ||
      (ebay && ebay.additional_images) ||
      (etsy && etsy.additional_images) ||
      (shopee && shopee.additional_images) ||
      (depop && depop.additional_images) ||
      (vinted && vinted.additional_images) ||
      (extra && extra.additional_images);
    if (Array.isArray(src)) {
      for (const u of src) {
        if (typeof u !== "string") continue;
        const clean = u.trim();
        if (!clean) continue;
        if (!urls.includes(clean)) urls.push(clean);
      }
    }
  } catch {
    /* ignore */
  }
  return urls.filter((u) => typeof u === "string" && (u.startsWith("data:") || /^https?:\/\//i.test(u)));
}

function findShopifyProductMediaFileInput(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return null;
  }
  function score(inp) {
    if (!(inp instanceof HTMLInputElement) || inp.type !== "file" || inp.disabled) return -1;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    if (acc.includes("image")) return 12;
    if (!acc || acc === "*/*" || acc.includes("image/")) return 8;
    if (acc.includes("video") && !acc.includes("image")) return -1;
    if (acc.includes("spreadsheet") || acc.includes(".csv")) return -1;
    return 4;
  }
  let best = null;
  let bestS = -1;
  for (const inp of inputs) {
    const s = score(inp);
    if (s > bestS) {
      bestS = s;
      best = inp;
    }
  }
  return bestS >= 0 ? best : null;
}

function shopifyAttachProductMediaFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan).slice(0, 20);
  if (!urls.length) {
    console.warn("[SyncLyst] Shopify Media: resolveScanImageUrls() returned none");
    return;
  }

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const cacheKey = urls.join("\n");
  if (win.__synclystShopifyMediaAttachedKey === cacheKey) {
    console.log("[SyncLyst] Shopify Media: already attached this exact image set on this page — skipping (this is expected on a 2nd+ click without navigating away, not a bug)");
    return;
  }
  if (win.__synclystShopifyMediaAttachPromise) return;
  console.log("[SyncLyst] Shopify Media: attempting to attach", urls.length, "image(s)");

  win.__synclystShopifyMediaAttachPromise = (async () => {
    try {
      const files = [];
      for (let i = 0; i < urls.length; i++) {
        let file;
        try {
          file = await blobToProductFileFromImageUrl(urls[i], `synclyst-scan-${i}`);
        } catch {
          file = null;
        }
        if (file) files.push(file);
      }
      if (!files.length) return;

      /** One file per change event — Shopify Admin’s media uploader often handles multi-select, but sequential assignment is more reliable. */
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        let attached = false;
        for (let attempt = 0; attempt < 18; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 400));
          shopifyRevealMediaFileInput(rootEl);
          const target = findShopifyProductMediaFileInput(rootEl);
          if (!target) continue;
          try {
            const dt = new DataTransfer();
            dt.items.add(file);
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
            if (desc && desc.set) desc.set.call(target, dt.files);
            else target.files = dt.files;
            target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            pulseShopifyDirtySignals();
            attached = true;
            break;
          } catch {
            /* Admin may ignore synthetic file assignment */
          }
        }
        if (!attached) {
          console.warn("[SyncLyst] Shopify Media: never found the file input for image " + (fi + 1) + "/" + files.length + " after 18 attempts");
        }
        if (fi < files.length - 1) {
          await new Promise((r) => setTimeout(r, 450));
        }
      }
      console.log("[SyncLyst] Shopify Media: attach loop finished");
      win.__synclystShopifyMediaAttachedKey = cacheKey;
    } finally {
      win.__synclystShopifyMediaAttachPromise = null;
    }
  })();
}

function vintedRevealPhotoUpload(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label, span, a", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const blob = `${t} ${al}`;
      if (!/upload|add|photo|image|picture/i.test(blob)) continue;
      if (!/upload|add|\+/.test(blob) || !/photo|image|picture|pic/i.test(blob)) continue;
      if (/profile|avatar|banner|cover|verify|document|id card/i.test(blob)) continue;
      try {
        b.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findVintedPhotoFileInput(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return null;
  }
  let best = null;
  let bestS = -1;
  for (const inp of inputs) {
    if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    let s = 0;
    if (acc.includes("image")) s += 18;
    else if (!acc || acc === "*/*" || acc.includes("image/")) s += 10;
    if (acc.includes("video") && !acc.includes("image")) continue;
    if (acc.includes("pdf") && !acc.includes("image")) s -= 8;
    let ctx = inp.closest("form, section, [class*='upload'], [class*='photo'], [class*='media'], div");
    const ctxText = (ctx && (ctx.textContent || "")) || "";
    if (/sell|upload|item|listing|photo/i.test(ctxText.slice(0, 2500))) s += 8;
    if (/profile|avatar|message|chat/i.test(ctxText.slice(0, 400))) s -= 25;
    if (isVisible(inp)) s += 4;
    else s += 2;
    const nm = (inp.name || "").toLowerCase();
    const id = (inp.id || "").toLowerCase();
    if (/photo|image|picture|upload|item|listing/.test(`${nm} ${id}`)) s += 12;
    if (s > bestS) {
      bestS = s;
      best = inp;
    }
  }
  return bestS >= 8 ? best : null;
}

function vintedAttachProductPhotosFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan).slice(0, 10);
  if (!urls.length) return;

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const cacheKey = urls.join("\n");
  if (win.__synclystVintedMediaAttachedUrl === cacheKey) return;
  if (win.__synclystVintedMediaAttachPromise) return;

  win.__synclystVintedMediaAttachPromise = (async () => {
    try {
      const files = [];
      for (let i = 0; i < urls.length; i++) {
        let file;
        try {
          file = await blobToProductFileFromImageUrl(urls[i], `synclyst-scan-${i}`);
        } catch {
          file = null;
        }
        if (file) files.push(file);
      }
      if (!files.length) return;

      /** One file per change event — sequential assignment is more reliable for Vinted’s uploader. */
      for (let fi = 0; fi < files.length; fi++) {
        const file = files[fi];
        for (let attempt = 0; attempt < 22; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, 380));
          if (attempt % 3 === 1) vintedRevealPhotoUpload(rootEl);
          const target = findVintedPhotoFileInput(rootEl);
          if (!target) continue;
          try {
            const dt = new DataTransfer();
            dt.items.add(file);
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
            if (desc && desc.set) desc.set.call(target, dt.files);
            else target.files = dt.files;
            target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
            target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
            break;
          } catch {
            /* React may block until another tick */
          }
        }
        if (fi < files.length - 1) await new Promise((r) => setTimeout(r, 450));
      }
      win.__synclystVintedMediaAttachedUrl = cacheKey;
    } finally {
      // no-op
    }
    win.__synclystVintedMediaAttachPromise = null;
  })();
}

function scheduleVintedDeferredPhotoAttach(scan, root) {
  const rootEl = documentRootElement(root);
  [200, 900, 2000, 3800].forEach((ms) => {
    setTimeout(() => {
      try {
        vintedAttachProductPhotosFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

function ebayRevealPhotoUpload(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label, span, a, div", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const blob = `${t} ${al}`;
      if (!/upload|add|photo|image|picture|computer|browse/i.test(blob)) continue;
      if (/profile|avatar|banner|cover|verify|document|id card|message|chat/i.test(blob)) continue;
      // Avoid clicking random "add" buttons outside the listing form.
      const ctx = b.closest("form, section, [class*='photo'], [class*='upload'], [class*='image'], [class*='media'], div");
      const ctxText = (ctx && (ctx.textContent || "")) || "";
      if (ctxText && !/photo|photos|upload|picture|images|gallery|listing/i.test(ctxText.slice(0, 2000))) continue;
      try {
        b.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findEbayPhotoFileInputs(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return [];
  }
  const scored = [];
  for (const inp of inputs) {
    if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    if (acc.includes("video") && !acc.includes("image")) continue;
    let s = 0;
    if (acc.includes("image")) s += 18;
    else if (!acc || acc === "*/*" || acc.includes("image/")) s += 10;
    const nm = (inp.name || "").toLowerCase();
    const id = (inp.id || "").toLowerCase();
    if (/photo|photos|image|images|picture|upload|uploader|gallery/.test(`${nm} ${id}`)) s += 12;
    const ctx = inp.closest("form, section, [class*='photo'], [class*='upload'], [class*='image'], [class*='media'], div");
    const ctxText = (ctx && (ctx.textContent || "")) || "";
    if (/photos|photo|upload|add photos|pictures|images/i.test(ctxText.slice(0, 2500))) s += 10;
    if (/profile|avatar|message|chat/i.test(ctxText.slice(0, 600))) s -= 25;
    if (isVisible(inp)) s += 4;
    else s += 2;
    if (s >= 8) scored.push({ inp, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.inp);
}

function ebayAttachProductPhotosFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan);
  if (!urls.length) return;

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const sig = urls.join("|");
  if (win.__synclystEbayMediaAttachedSig === sig) return;
  if (win.__synclystEbayMediaAttachPromise) return;

  win.__synclystEbayMediaAttachPromise = (async () => {
    const files = [];
    for (let i = 0; i < Math.min(urls.length, 12); i++) {
      try {
        const f = await blobToProductFileFromImageUrl(urls[i]);
        if (f) files.push(f);
      } catch {
        /* ignore */
      }
    }
    if (!files.length) {
      win.__synclystEbayMediaAttachPromise = null;
      return;
    }

    for (let attempt = 0; attempt < 26; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 380));
      if (attempt % 3 === 1) ebayRevealPhotoUpload(rootEl);
      const targets = findEbayPhotoFileInputs(rootEl);
      const target = targets[0] || null;
      if (!target) continue;
      try {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (desc && desc.set) desc.set.call(target, dt.files);
        else target.files = dt.files;
        target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        win.__synclystEbayMediaAttachedSig = sig;
        break;
      } catch {
        /* ignore */
      }
    }
    win.__synclystEbayMediaAttachPromise = null;
  })();
}

function scheduleEbayDeferredPhotoAttach(scan, root) {
  const rootEl = documentRootElement(root);
  [250, 1000, 2200, 4200].forEach((ms) => {
    setTimeout(() => {
      try {
        ebayAttachProductPhotosFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

/** MAIN `executeScript` — eBay Lexical / React often ignore isolated-world DOM writes (same idea as Vinted price). */
function ebayFireMainWorldDescriptionThrottled(text) {
  const str = String(text || "").trim();
  if (!str) return;
  try {
    const win = typeof window !== "undefined" ? window : null;
    const now = Date.now();
    if (win) {
      if (win.__synclystEbayDescMainAt && now - win.__synclystEbayDescMainAt < 240) return;
      win.__synclystEbayDescMainAt = now;
    }
  } catch {
    /* ignore */
  }
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
  try {
    let tabId;
    try {
      const tid = globalThis.__synclystFillSourceTabId;
      if (typeof tid === "number" && Number.isFinite(tid)) tabId = tid;
    } catch {
      /* ignore */
    }
    chrome.runtime.sendMessage({
      type: "SYNCLYST_EBAY_MAIN_SET_DESCRIPTION",
      text: str.slice(0, 48000),
      tabId,
    });
  } catch {
    /* ignore */
  }
}

/** Lexical description often mounts after title/price; retry fill into hidden textarea + rich surface. */
function scheduleEbayDeferredDescriptionFill(descText, root) {
  const t = String(descText || "").trim();
  if (!t) return;
  const win = root && root.defaultView ? root.defaultView : typeof window !== "undefined" ? window : null;
  if (!win) return;
  const sig = `${t.length}:${t.slice(0, 64)}`;
  try {
    if (win.__synclystEbayDescDeferredPlanned === sig) return;
    win.__synclystEbayDescDeferredPlanned = sig;
  } catch {
    return;
  }
  [180, 520, 1200, 2600, 5200, 11000].forEach((ms) => {
    setTimeout(() => {
      try {
        ebayFillRichDescription(t, root);
        ebayFireMainWorldDescriptionThrottled(t);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

function depopRevealPhotoUpload(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label, span, a, div", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const blob = `${t} ${al}`;
      if (!/(add\s*a\s*photo|add\s*photos?|upload\s*photo)/i.test(blob)) continue;
      if (/profile|avatar|banner|verify|message|chat/i.test(blob)) continue;
      const ctx = b.closest("form, section, article, main, [class*='photo'], div");
      const ctxText = (ctx && (ctx.textContent || "")) || "";
      if (ctxText && !/photo|photos|jpeg|png|listing|sell|depop|draft|cover/i.test(ctxText.slice(0, 2500))) continue;
      try {
        b.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findDepopPhotoFileInputs(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return [];
  }
  const scored = [];
  for (const inp of inputs) {
    if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    if (acc.includes("video") && !acc.includes("image")) continue;
    let s = 0;
    if (acc.includes("image")) s += 18;
    else if (!acc || acc === "*/*" || acc.includes("image/")) s += 10;
    const nm = (inp.name || "").toLowerCase();
    const id = (inp.id || "").toLowerCase();
    if (/photo|photos|image|upload|picture|listing|product|media/.test(`${nm} ${id}`)) s += 12;
    const ctx = inp.closest("form, section, [class*='photo'], [class*='upload'], article, main, div");
    const ctxText = (ctx && (ctx.textContent || "")) || "";
    if (/photo|photos|add\s*a?\s*photo|jpeg|png|cover\s*photo|listing|sell|draft/i.test(ctxText.slice(0, 3500))) s += 10;
    if (/profile|avatar|message|chat/i.test(ctxText.slice(0, 500))) s -= 25;
    if (isVisible(inp)) s += 4;
    else s += 2;
    if (s >= 8) scored.push({ inp, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.inp);
}

function depopAttachProductPhotosFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan);
  if (!urls.length) return;

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const sig = urls.join("|");
  if (win.__synclystDepopMediaAttachedSig === sig) return;
  if (win.__synclystDepopMediaAttachPromise) return;

  win.__synclystDepopMediaAttachPromise = (async () => {
    const files = [];
    for (let i = 0; i < Math.min(urls.length, 8); i++) {
      try {
        const f = await blobToProductFileFromImageUrl(urls[i]);
        if (f) files.push(f);
      } catch {
        /* ignore */
      }
    }
    if (!files.length) {
      win.__synclystDepopMediaAttachPromise = null;
      return;
    }

    for (let attempt = 0; attempt < 26; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 380));
      if (attempt % 3 === 1) depopRevealPhotoUpload(rootEl);
      const targets = findDepopPhotoFileInputs(rootEl);
      const target = targets[0] || null;
      if (!target) continue;
      try {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (desc && desc.set) desc.set.call(target, dt.files);
        else target.files = dt.files;
        target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        // Some forms only clear a "Please insert at least one image" validation message on
        // blur, not on input/change alone — the photo can render successfully (preview comes
        // straight from the File object) while the stale error message lingers.
        target.dispatchEvent(new Event("blur", { bubbles: true }));
        win.__synclystDepopMediaAttachedSig = sig;
        break;
      } catch {
        /* ignore */
      }
    }
    win.__synclystDepopMediaAttachPromise = null;
  })();
}

function scheduleDepopDeferredPhotoAttach(scan, root) {
  const rootEl = documentRootElement(root);
  [250, 1000, 2200, 4200].forEach((ms) => {
    setTimeout(() => {
      try {
        depopAttachProductPhotosFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

/** Etsy “Photo and video” — drag-and-drop zone + Upload (listing editor). */
function etsyRevealPhotoUpload(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label, span, a, div", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const blob = `${t} ${al}`;
      if (!/(^|\s)\+\s*upload|upload|browse|add\s*photo|choose\s*file|drag\s*and\s*drop/i.test(blob)) continue;
      if (/profile|avatar|banner|message|chat|shop\s*icon|logo/i.test(blob)) continue;
      const ctx = b.closest("form, section, article, main, [class*='photo'], [class*='upload'], [class*='media'], div");
      const ctxText = (ctx && (ctx.textContent || "")) || "";
      if (
        ctxText &&
        !/photo|video|listing|drag|drop|jpeg|png|20\s*photo|add up to/i.test(ctxText.slice(0, 3200))
      ) {
        continue;
      }
      try {
        b.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findEtsyPhotoFileInputs(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return [];
  }
  const scored = [];
  for (const inp of inputs) {
    if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    if (acc.includes("video") && !acc.includes("image")) continue;
    let s = 0;
    if (acc.includes("image")) s += 18;
    else if (!acc || acc === "*/*" || acc.includes("image/")) s += 10;
    const nm = (inp.name || "").toLowerCase();
    const id = (inp.id || "").toLowerCase();
    if (/photo|photos|image|images|picture|upload|listing|media|attachment/.test(`${nm} ${id}`)) s += 12;
    const ctx = inp.closest("form, section, [class*='photo'], [class*='upload'], [class*='media'], article, main, div");
    const ctxText = (ctx && (ctx.textContent || "")) || "";
    if (/photo\s*and\s*video|add up to \d+|drag\s*and\s*drop|listing|jpeg|png|shop\s*manager/i.test(ctxText.slice(0, 4000))) {
      s += 12;
    }
    if (/profile|avatar|message|chat|banner/i.test(ctxText.slice(0, 500))) s -= 25;
    if (isVisible(inp)) s += 4;
    else s += 2;
    if (s >= 8) scored.push({ inp, s });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.inp);
}

function etsyAttachProductPhotosFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan);
  if (!urls.length) return;

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const sig = urls.join("|");
  if (win.__synclystEtsyMediaAttachedSig === sig) return;
  if (win.__synclystEtsyMediaAttachPromise) return;

  win.__synclystEtsyMediaAttachPromise = (async () => {
    const files = [];
    for (let i = 0; i < Math.min(urls.length, 20); i++) {
      try {
        const f = await blobToProductFileFromImageUrl(urls[i]);
        if (f) files.push(f);
      } catch {
        /* ignore */
      }
    }
    if (!files.length) {
      win.__synclystEtsyMediaAttachPromise = null;
      return;
    }

    for (let attempt = 0; attempt < 28; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400));
      if (attempt % 3 === 1) etsyRevealPhotoUpload(rootEl);
      const targets = findEtsyPhotoFileInputs(rootEl);
      const target = targets[0] || null;
      if (!target) continue;
      try {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (desc && desc.set) desc.set.call(target, dt.files);
        else target.files = dt.files;
        target.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        target.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        win.__synclystEtsyMediaAttachedSig = sig;
        break;
      } catch {
        /* React may ignore until visible */
      }
    }
    win.__synclystEtsyMediaAttachPromise = null;
  })();
}

function scheduleEtsyDeferredPhotoAttach(scan, root) {
  const rootEl = documentRootElement(root);
  [250, 1000, 2200, 4200, 6500].forEach((ms) => {
    setTimeout(() => {
      try {
        etsyAttachProductPhotosFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

/**
 * Shopee Seller Centre add product: separate "Product Images" (1:1 / 3:4) and "Promotion Image" (1:1).
 * Best-effort: hero → first product slot; same file → promotion when that section has its own input.
 */
function shopeeRevealPhotoUpload(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label, span, a, div", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const blob = `${t} ${al}`;
      if (!/add\s*image|upload|\+/.test(blob)) continue;
      if (/profile|avatar|banner|chat|message/i.test(blob)) continue;
      const ctx = b.closest("form, section, article, main, div");
      const ctxText = (ctx && (ctx.textContent || "")) || "";
      if (!/product\s*images?|promotion\s*image|shopee/i.test(ctxText.slice(0, 3500))) continue;
      try {
        b.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function classifyShopeeFileInput(inp) {
  const parts = [];
  let el = inp;
  for (let d = 0; d < 26 && el; d++) {
    parts.unshift(
      ((el.textContent || "") + " " + (el.getAttribute("aria-label") || "")).slice(0, 1400)
    );
    el = el.parentElement;
  }
  const big = parts.join(" ").toLowerCase();
  if (/promotion\s*image/.test(big)) return "promotion";
  if (/product\s*images?/.test(big)) return "product";
  return "unknown";
}

function findShopeeImageFileInputs(rootEl) {
  let inputs;
  try {
    inputs = querySelectorAllDeep('input[type="file"]', rootEl);
  } catch {
    return { product: [], promotion: [], any: [] };
  }
  const product = [];
  const promotion = [];
  const any = [];
  for (const inp of inputs) {
    if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
    const acc = (inp.getAttribute("accept") || "").toLowerCase();
    if (acc.includes("video") && !acc.includes("image")) continue;
    const role = classifyShopeeFileInput(inp);
    if (role === "promotion") promotion.push(inp);
    else if (role === "product") product.push(inp);
    else any.push(inp);
  }
  return { product, promotion, any };
}

function shopeeAttachProductPhotosFromScan(scan, root) {
  const rootEl = documentRootElement(root);
  const urls = resolveScanImageUrls(scan);
  if (!urls.length) return;

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return;
  const sig = urls.join("|");
  if (win.__synclystShopeeMediaAttachedSig === sig) return;
  if (win.__synclystShopeeMediaAttachPromise) return;

  win.__synclystShopeeMediaAttachPromise = (async () => {
    const heroFile = await blobToProductFileFromImageUrl(urls[0]).catch(() => null);
    if (!heroFile) {
      win.__synclystShopeeMediaAttachPromise = null;
      return;
    }
    const extraFiles = [];
    for (let i = 1; i < Math.min(urls.length, 9); i++) {
      try {
        const f = await blobToProductFileFromImageUrl(urls[i]);
        if (f) extraFiles.push(f);
      } catch {
        /* ignore */
      }
    }

    function assignToInput(inp, files) {
      if (!(inp instanceof HTMLInputElement) || !files.length) return false;
      try {
        const dt = new DataTransfer();
        const multi = inp.hasAttribute("multiple");
        const list = multi ? files : [files[0]];
        list.forEach((f) => dt.items.add(f));
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
        if (desc && desc.set) desc.set.call(inp, dt.files);
        else inp.files = dt.files;
        inp.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        return true;
      } catch {
        return false;
      }
    }

    for (let attempt = 0; attempt < 28; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 400));
      if (attempt % 3 === 1) shopeeRevealPhotoUpload(rootEl);
      const { product, promotion, any } = findShopeeImageFileInputs(rootEl);
      const productFiles = [heroFile, ...extraFiles].filter(Boolean);
      let ok = false;
      if (product.length > 1) {
        for (let i = 0; i < Math.min(product.length, productFiles.length); i++) {
          ok = assignToInput(product[i], [productFiles[i]]) || ok;
        }
      } else if (product.length === 1) {
        const one = product[0];
        const multi = one.hasAttribute("multiple");
        ok =
          assignToInput(one, multi ? productFiles.slice(0, 9) : [productFiles[0]]) || ok;
      } else if (any.length) {
        ok = assignToInput(any[0], productFiles.slice(0, 9)) || ok;
      }
      if (promotion.length) {
        ok = assignToInput(promotion[0], [heroFile]) || ok;
      }
      if (ok) {
        win.__synclystShopeeMediaAttachedSig = sig;
        break;
      }
    }
    win.__synclystShopeeMediaAttachPromise = null;
  })();
}

function scheduleShopeeDeferredPhotoAttach(scan, root) {
  const rootEl = documentRootElement(root);
  [280, 1100, 2400, 4500].forEach((ms) => {
    setTimeout(() => {
      try {
        shopeeAttachProductPhotosFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

function scheduleShopifyStatusComboboxDraft(rootEl) {
  try {
    if (window.location.hostname !== "admin.shopify.com") return;
  } catch {
    return;
  }
  const triggers = querySelectorAllDeep(
    'button[aria-label*="Status" i], [role="combobox"][aria-label*="Status" i], button[id*="status"][aria-haspopup="listbox"]',
    rootEl
  );
  for (const trig of triggers) {
    if (!(trig instanceof HTMLElement) || !isVisible(trig)) continue;
    const cur = (trig.textContent || "").replace(/\s+/g, " ").trim();
    if (/^draft$/i.test(cur) || /\bdraft\b/i.test(cur)) continue;
    function pickDraftOption() {
      const opts = document.querySelectorAll('[role="option"], [role="menuitem"], li[role="option"]');
      for (const op of opts) {
        if (!(op instanceof HTMLElement) || !isVisible(op)) continue;
        const t = (op.textContent || "").replace(/\s+/g, " ").trim();
        if (/^draft$/i.test(t) || /^brouillon$/i.test(t)) {
          try {
            op.click();
          } catch {
            /* ignore */
          }
          return;
        }
      }
    }
    try {
      trig.focus();
      trig.click();
    } catch {
      /* ignore */
    }
    [0, 60, 150, 320].forEach((ms) => {
      setTimeout(pickDraftOption, ms);
    });
    break;
  }
}

function grailedGetExtra(scan) {
  try {
    const ex = scan && scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : {};
    const g = ex.grailed && typeof ex.grailed === "object" ? ex.grailed : null;
    return g || null;
  } catch {
    return null;
  }
}

/** Returns "Menswear" | "Womenswear" for Grailed’s first-step department picker. */
function grailedInferDepartment(scan) {
  const g = grailedGetExtra(scan);
  if (g && g.department != null) {
    const raw = String(g.department).trim().toLowerCase();
    if (/women|ladies|female|dress|skirt|womenswear/.test(raw)) return "Womenswear";
    if (/men|male|menswear/.test(raw)) return "Menswear";
  }
  const blob = `${String(scan.title || "")} ${String(scan.description || "")}`.toLowerCase();
  if (
    /\b(women|women's|womens|lad(y|ies)|female|womenswear)\b/.test(blob) ||
    /\b(dress|skirt|bikini|lingerie|maternity|maxi dress|midi dress|minidress|heel|pumps?|handbag|tote bag|clutch|bralette)\b/.test(blob)
  ) {
    return "Womenswear";
  }
  if (/\b(men|men's|mens|male|menswear)\b/.test(blob)) return "Menswear";
  return "Menswear";
}

function grailedDepartmentLooksFilled(rootEl, want) {
  const w = String(want || "").trim();
  if (!w) return false;
  try {
    const nodes = querySelectorAllDeep('[role="combobox"], button, div[tabindex="0"]', rootEl);
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 140) continue;
      if (/please select|department\s*\/\s*category/i.test(t) && !new RegExp(`\\b${w}\\b`, "i").test(t)) continue;
      if (new RegExp(`\\b${w}\\b`, "i").test(t)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function grailedFindDepartmentCategoryTrigger(rootEl) {
  let best = null;
  let bestSc = -1;
  const bump = (el, sc) => {
    if (!(el instanceof HTMLElement) || !isVisible(el)) return;
    if (sc > bestSc) {
      bestSc = sc;
      best = el;
    }
  };
  try {
    const cand = querySelectorAllDeep(
      '[role="combobox"], button[aria-haspopup], [aria-haspopup="listbox"], input[readonly], input[placeholder*="Department" i], input[placeholder*="Category" i]',
      rootEl
    );
    for (const el of cand) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const al = shopifyControlAccessibleName(el).toLowerCase();
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const blob = `${al} ${ph} ${tx}`.slice(0, 220);
      let sc = 0;
      if (/department\s*\/\s*category/.test(blob)) sc += 120;
      if (ph.includes("department") && ph.includes("category")) sc += 90;
      if (al.includes("department") || al.includes("category")) sc += 55;
      if (/\bdepartment\b.*\bcategory\b|\bcategory\b.*\bdepartment\b/.test(blob)) sc += 70;
      if (el.getAttribute("role") === "combobox") sc += 12;
      bump(el, sc);
    }
    const labels = querySelectorAllDeep("label, span, p, div", rootEl);
    for (const lab of labels) {
      if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
      const lt = (lab.textContent || "").replace(/\s+/g, " ").trim();
      if (!/department\s*\/\s*category/i.test(lt) || lt.length > 80) continue;
      let row = lab.closest("div, section, li, tr, fieldset, form");
      for (let up = 0; up < 8 && row instanceof HTMLElement; up++) {
        const trig =
          row.querySelector('[role="combobox"]') ||
          row.querySelector('button[aria-haspopup]') ||
          row.querySelector('input[readonly]') ||
          row.querySelector("[aria-expanded]");
        if (trig instanceof HTMLElement && isVisible(trig)) {
          bump(trig, 95);
          break;
        }
        row = row.parentElement;
      }
    }
  } catch {
    /* ignore */
  }
  if (best && bestSc >= 48) return best;
  return null;
}

function grailedClickDepartmentMenuOption(wantLabel) {
  const want = String(wantLabel || "").trim();
  if (!want) return false;
  const wantLow = want.toLowerCase();
  try {
    const surfaces = Array.from(
      querySelectorAllDeep('[role="listbox"], [role="menu"], [data-popper-placement]', document.body)
    ).filter((el) => el instanceof HTMLElement && isVisible(el));
    surfaces.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
    const roots = surfaces.length ? surfaces : [document.body];
    const candidates = [];
    for (const root of roots) {
      const nodes = root.querySelectorAll('[role="option"], li, button, a, div');
      for (const o of nodes) {
        if (!(o instanceof HTMLElement) || !isVisible(o)) continue;
        const tx = (o.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 90) continue;
        const low = tx.toLowerCase();
        if (/^department$/i.test(tx)) continue;
        if (/please\s*select|department\s*\/\s*category/i.test(low)) continue;
        if (low === wantLow || new RegExp(`^${want}\\s*[>›]?\\s*$`, "i").test(tx) || new RegExp(`^${want}\\b`, "i").test(tx)) {
          candidates.push(o);
        }
      }
    }
    const leaves = shopeeSpecificationOptionLeaves(candidates);
    const pool = leaves.length ? leaves : candidates;
    for (const el of pool) {
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
      const low = tx.toLowerCase();
      if (low === wantLow || new RegExp(`^${want}\\s*[>›]?\\s*$`, "i").test(tx)) {
        try {
          el.scrollIntoView({ block: "nearest", behavior: "auto" });
          el.click();
        } catch {
          /* ignore */
        }
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Grailed “Department / Category” is required before the rest of the form — pick Menswear vs Womenswear once.
 */
function grailedDepartmentCategoryTick(scan, rootEl) {
  const win = rootEl.defaultView || window;
  const want = grailedInferDepartment(scan);
  const key = want;
  if (win.__synclystGrailedDeptKey !== key) {
    win.__synclystGrailedDept = null;
    win.__synclystGrailedDeptKey = key;
  }
  if (grailedDepartmentLooksFilled(rootEl, want)) {
    win.__synclystGrailedDept = { done: true };
    return 0;
  }
  if (win.__synclystGrailedDept && win.__synclystGrailedDept.done) return 0;

  if (!win.__synclystGrailedDept) win.__synclystGrailedDept = { phase: "open", t: 0 };
  const st = win.__synclystGrailedDept;

  if (st.phase === "open") {
    const trig = grailedFindDepartmentCategoryTrigger(rootEl);
    if (!trig) return 0;
    const shown = (trig.textContent || "").replace(/\s+/g, " ").trim();
    if (new RegExp(`\\b${want}\\b`, "i").test(shown) && !/department\s*\/\s*category/i.test(shown)) {
      st.done = true;
      return 0;
    }
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.click();
    } catch {
      return 0;
    }
    st.phase = "pick";
    st.t = Date.now();
    return 1;
  }
  if (st.phase === "pick") {
    if (Date.now() - st.t < 60) return 0;
    if (grailedClickDepartmentMenuOption(want)) {
      st.done = true;
      st.phase = "open";
      return 1;
    }
    if (Date.now() - st.t > 5500) {
      st.phase = "open";
      st.t = 0;
      st.done = true;
    }
    return 0;
  }
  return 0;
}

function fillGrailedListingExtraFields(scan, root) {
  let host = "";
  try {
    const doc = root && root.nodeType === Node.DOCUMENT_NODE ? root : root && root.ownerDocument;
    host = (doc && doc.location && doc.location.hostname) || window.location.hostname || "";
  } catch {
    host = "";
  }
  if (host && !host.includes("grailed.")) return 0;
  const rootEl = documentRootElement(root || document);
  return grailedDepartmentCategoryTick(scan, rootEl);
}

function fillScanIntoPage(platform, scan) {
  const shopify = (platform || "").toLowerCase() === "shopify";
  const vinted = (platform || "").toLowerCase() === "vinted";
  const ebay = (platform || "").toLowerCase() === "ebay";
  const etsy = (platform || "").toLowerCase() === "etsy";
  const shopee = (platform || "").toLowerCase() === "shopee";
  const depop = (platform || "").toLowerCase() === "depop";
  const grailed = (platform || "").toLowerCase() === "grailed";
  const roots = shopify
    ? getShopifyRootDocuments()
    : ebay
      ? getEbayRootDocuments()
      : shopee
        ? getShopeeRootDocuments()
        : [document];
  let total = 0;
  let statusSetViaSelect = false;
  for (const rd of roots) {
    let n = fillFromMapper(platform, scan, rd);
    if (vinted) n += fillVintedListingExtraFields(scan, rd);
    if (depop) n += fillDepopListingExtraFields(scan, rd);
    if (grailed) n += fillGrailedListingExtraFields(scan, rd);
    if (ebay) n += fillEbayListingExtraFields(scan, rd);
    if (ebay) n += ebayTryApplySuggestedItemSpecifics(rd);
    if (ebay) {
      const ed = ebayDescriptionForFill(scan);
      if (ed) scheduleEbayDeferredDescriptionFill(ed, rd);
    }
    if (etsy) n += fillEtsyListingExtraFields(scan, rd);
    if (shopify) n += fillShopifyListingExtraFields(scan, rd);
    if (shopify) shopifyAttachProductMediaFromScan(scan, rd);
    if (vinted) {
      const hero = resolveScanHeroImageUrl(scan);
      if (hero) {
        const w = rd.defaultView || (typeof window !== "undefined" ? window : null);
        if (w && w.__synclystVintedScheduledFor !== hero) {
          w.__synclystVintedScheduledFor = hero;
          try {
            scheduleVintedDeferredPhotoAttach(scan, rd);
          } catch {
            /* ignore */
          }
        }
        vintedAttachProductPhotosFromScan(scan, rd);
      }
    }
    if (ebay) {
      const hero = resolveScanHeroImageUrl(scan);
      if (hero) {
        const w = rd.defaultView || (typeof window !== "undefined" ? window : null);
        if (w && w.__synclystEbayScheduledFor !== hero) {
          w.__synclystEbayScheduledFor = hero;
          try {
            scheduleEbayDeferredPhotoAttach(scan, rd);
          } catch {
            /* ignore */
          }
        }
        ebayAttachProductPhotosFromScan(scan, rd);
      }
    }
    if (etsy) {
      const urls = resolveScanImageUrls(scan);
      if (urls.length) {
        const w = rd.defaultView || (typeof window !== "undefined" ? window : null);
        const sig = urls.join("|");
        if (w && w.__synclystEtsyScheduledFor !== sig) {
          w.__synclystEtsyScheduledFor = sig;
          try {
            scheduleEtsyDeferredPhotoAttach(scan, rd);
          } catch {
            /* ignore */
          }
        }
        etsyAttachProductPhotosFromScan(scan, rd);
      }
    }
    if (depop) {
      const urls = resolveScanImageUrls(scan);
      if (urls.length) {
        const w = rd.defaultView || (typeof window !== "undefined" ? window : null);
        const sig = urls.join("|");
        if (w && w.__synclystDepopScheduledFor !== sig) {
          w.__synclystDepopScheduledFor = sig;
          try {
            scheduleDepopDeferredPhotoAttach(scan, rd);
          } catch {
            /* ignore */
          }
        }
        depopAttachProductPhotosFromScan(scan, rd);
      }
    }
    if (shopee) {
      const hero = resolveScanHeroImageUrl(scan);
      if (hero) {
        const w = rd.defaultView || (typeof window !== "undefined" ? window : null);
        if (w && w.__synclystShopeeScheduledFor !== hero) {
          w.__synclystShopeeScheduledFor = hero;
          try {
            scheduleShopeeDeferredPhotoAttach(scan, rd);
          } catch {
            /* ignore */
          }
        }
        shopeeAttachProductPhotosFromScan(scan, rd);
      }
      n += fillShopeeListingExtraFields(scan, rd);
      n += shopeeRefillProductNameIfStillPriceLike(scan, rd);
    }
    if (shopify) n += shopifyGapFill(scan, rd);
    if (shopify) {
      const sn = shopifySetProductStatusDraft(rd);
      n += sn;
      if (sn > 0) statusSetViaSelect = true;
    }
    total += n;
  }
  if (shopify && !statusSetViaSelect) {
    scheduleShopifyStatusComboboxDraft(documentRootElement(roots[0] || document));
  }
  if (shopify) {
    try {
      scheduleShopifyDeferredExtraFields(scan, roots[0] || document);
    } catch {
      /* ignore */
    }
  }
  return total;
}

function runFillThenRespond(platform, scan, autoSave, sendResponse) {
  let attempts = 0;
  /** First tick where any field matched — Shopify often mounts title/price after description; keep retrying. */
  let firstFilledAttempt = 0;
  /** Best fill count across ticks (a later pass can legitimately report 0 if nothing new matched). */
  let maxFilled = 0;
  const p = (platform || "").toLowerCase();
  const heavySpa =
    p === "shopify" ||
    p === "shopee" ||
    p === "lazada" ||
    p === "grailed" ||
    p === "vinted" ||
    p === "ebay" ||
    p === "etsy" ||
    p === "depop";
  // Keep this bounded so the popup -> service worker message port
  // doesn't time out on slow Shopify Admin mounts.
  const maxAttempts = heavySpa
    ? p === "vinted" || p === "ebay"
      ? 32
      : p === "shopee"
        ? 52
        : p === "depop"
          ? 30
          : p === "etsy"
            ? 28
            : 40
    : 14;
  const intervalMs = heavySpa
    ? p === "vinted" || p === "ebay" || p === "etsy" || p === "shopee" || p === "depop"
      ? 360
      : 380
    : 280;
  /** Extra ticks after the first non-zero fill so late-mounted inputs (title, price, org) still run. */
  const shopifyExtraPassesAfterFirstFill = 5;
  const vintedExtraPassesAfterFirstFill = 12;
  /** eBay.ai “Suggested item specifics” often mounts a few seconds after title/photos — keep polling. */
  const ebayExtraPassesAfterFirstFill = 18;
  const shopeeExtraPassesAfterFirstFill = 36;
  const depopExtraPassesAfterFirstFill = 14;
  const etsyExtraPassesAfterFirstFill = 4;
  const tick = () => {
    attempts += 1;
    const filled = fillScanIntoPage(platform, scan);
    maxFilled = Math.max(maxFilled, filled);
    const base = attachShopifyContext({ ok: true, filled: maxFilled, platform }, platform);

    if (filled > 0 && !firstFilledAttempt) {
      firstFilledAttempt = attempts;
    }

    if (maxFilled > 0) {
      if (p === "shopify") {
        pulseShopifyDirtySignals();
      }
      const needMoreShopifyPasses =
        p === "shopify" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + shopifyExtraPassesAfterFirstFill;
      const needMoreVintedPasses =
        p === "vinted" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + vintedExtraPassesAfterFirstFill;
      const needMoreEbayPasses =
        p === "ebay" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + ebayExtraPassesAfterFirstFill;
      const needMoreShopeePasses =
        p === "shopee" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + shopeeExtraPassesAfterFirstFill;
      const needMoreDepopPasses =
        p === "depop" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + depopExtraPassesAfterFirstFill;
      const needMoreEtsyPasses =
        p === "etsy" && firstFilledAttempt > 0 && attempts < firstFilledAttempt + etsyExtraPassesAfterFirstFill;
      if (needMoreShopifyPasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (needMoreVintedPasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (needMoreEbayPasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (needMoreShopeePasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (needMoreDepopPasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (needMoreEtsyPasses && attempts < maxAttempts) {
        setTimeout(tick, intervalMs);
        return;
      }
      if (autoSave) scheduleAutoSave(platform, sendResponse, base);
      else sendResponse(base);
      return;
    }

    if (attempts === 1 && p === "shopify" && base.shopify_page === "list" && base.new_product_url) {
      sendResponse(base);
      return;
    }

    if (attempts < maxAttempts) {
      setTimeout(tick, intervalMs);
      return;
    }
    sendResponse(base);
  };
  tick();
}

/**
 * Shopify Admin: product list has no title/price inputs — only /products/new or /products/:id do.
 * Returns { kind, newProductUrl? } so the popup can open Add product and retry.
 */
function shopifyAdminPageContext() {
  try {
    const u = new URL(window.location.href);
    if (u.hostname !== "admin.shopify.com") return null;
    const path = (u.pathname || "").replace(/\/+$/, "") || "/";
    if (/\/products\/new$/i.test(path)) return { kind: "editor" };
    if (/\/products\/\d+$/i.test(path)) return { kind: "editor" };
    const m = path.match(/^\/store\/([^/]+)\/products$/);
    if (m) {
      return {
        kind: "list",
        newProductUrl: `${u.origin}/store/${m[1]}/products/new`,
      };
    }
    return { kind: "other" };
  } catch {
    return null;
  }
}

function attachShopifyContext(base, platform) {
  if ((platform || "").toLowerCase() !== "shopify") return base;
  const ctx = shopifyAdminPageContext();
  if (!ctx) return base;
  base.shopify_page = ctx.kind;
  if (ctx.newProductUrl) base.new_product_url = ctx.newProductUrl;
  return base;
}

/** Polaris TextField often wires labels via aria-labelledby (ids in the same document or shadow root). */
function deepGetElementByIdFrom(el, id) {
  const idStr = String(id || "").trim();
  if (!idStr || !el) return null;
  let cur = el;
  const seen = new Set();
  for (let hop = 0; hop < 16 && cur; hop++) {
    const root = cur.getRootNode && cur.getRootNode();
    if (!root || seen.has(root)) break;
    seen.add(root);
    try {
      if (root.getElementById) {
        const hit = root.getElementById(idStr);
        if (hit) return hit;
      }
    } catch {
      /* ignore */
    }
    cur = root instanceof ShadowRoot ? root.host : null;
  }
  try {
    return document.getElementById(idStr);
  } catch {
    return null;
  }
}

function shopifyAriaLabelledByText(el) {
  const raw = el.getAttribute && el.getAttribute("aria-labelledby");
  if (!raw || !el) return "";
  const ids = raw.trim().split(/\s+/).filter(Boolean);
  const bits = [];
  for (const id of ids) {
    const node = deepGetElementByIdFrom(el, id);
    if (node) bits.push(String(node.textContent || "").replace(/\s+/g, " ").trim());
  }
  return bits.join(" ").trim();
}

/** aria-label, then Polaris aria-labelledby, then placeholder (weakest). */
function shopifyControlAccessibleName(el) {
  if (!(el instanceof Element)) return "";
  const a = el.getAttribute("aria-label");
  if (a && a.trim()) return a.trim().replace(/\s+/g, " ");
  const by = shopifyAriaLabelledByText(el);
  if (by) return by.replace(/\s+/g, " ");
  const ph = el.getAttribute("placeholder");
  return ph && ph.trim() ? ph.trim() : "";
}

function scoreShopifyTitleInput(el) {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "search") return -Infinity;
  const al = shopifyControlAccessibleName(el).toLowerCase();
  if (/search|filter|orders|customer|navigation/.test(al) && !/title|product title/.test(al)) return -Infinity;
  if (/seo|search engine listing|meta title|google|search preview/i.test(al)) return -80;
  if (/\bpage title\b/i.test(al) && !/product/i.test(al)) return -85;
  let s = 0;
  if (al === "title") s += 120;
  else if (al.includes("product title")) s += 110;
  else if ((el.name || "") === "title") s += 100;
  else if (/producttitle|product-title/i.test(el.id || "")) s += 90;
  else if (al.includes("title") && !/\bpage title\b/.test(al)) s += 70;
  else if (/(short sleeve|t-shirt)/i.test(el.getAttribute("placeholder") || "")) s += 55;
  s += Math.min(el.getBoundingClientRect().width / 25, 35);
  return s;
}

function scoreShopifyPriceInput(el) {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "search") return -Infinity;
  const al = shopifyControlAccessibleName(el).toLowerCase();
  if (/search|filter|navigation|compare at|was|strike|cost per|unit cost/i.test(al) && !/^price$/i.test(al.trim()))
    return -Infinity;
  let s = 0;
  if (al === "price" || /^price\b/i.test(al)) s += 120;
  else if (/\bprice\b/i.test(al) && !/compare|unit/.test(al)) s += 95;
  else if ((el.name || "").toLowerCase() === "price") s += 90;
  else if (/price/i.test(el.id || "")) s += 75;
  else if ((el.inputMode || "") === "decimal" || (el.getAttribute("inputmode") || "") === "decimal") s += 25;
  s += Math.min(el.getBoundingClientRect().width / 40, 20);
  return s;
}

function queryBestShopifyTitleInput(root) {
  const rootEl = documentRootElement(root);
  const patterns = [
    'input[aria-label="Title"]',
    'input[aria-label="Product title"]',
    'input[name="title"]',
    'input[id*="ProductTitle" i]',
    'input[id*="productTitle" i]',
    'input[id*="ProductTitleField" i]',
    'input[data-testid*="title" i]',
  ];
  let best = null;
  let bestScore = -Infinity;
  for (const sel of patterns) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      const sc = scoreShopifyTitleInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  }
  if (bestScore <= 0) {
    try {
      const all = querySelectorAllDeep("input", rootEl);
      for (const el of all) {
        if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
        const sc = scoreShopifyTitleInput(el);
        if (sc > bestScore) {
          bestScore = sc;
          best = el;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return bestScore > 0 ? best : null;
}

const ETSY_TITLE_MAX_LEN = 140;

function titleHasTooManyCaps(title) {
  const s = String(title || "").trim();
  if (s.length < 12) return false;
  let letters = 0;
  let uppers = 0;
  for (const ch of s) {
    if (/[A-Za-z]/.test(ch)) {
      letters++;
      if (/[A-Z]/.test(ch)) uppers++;
    }
  }
  if (letters < 8) return false;
  return uppers / letters >= 0.45;
}

/**
 * Vinted (and some other marketplaces) warn on "too many capital letters".
 * This keeps short acronyms (<=4) and turns the rest into a readable Title Case-ish string.
 */
/** scan.title sometimes arrives as "brand model type — start of description run-on...";
 * cut it down to a real title instead of dumping the whole run-on string into the title field.
 * The backend can hard-truncate this mid-sentence before any punctuation exists, so a
 * punctuation-based cut alone misses it — when the title's tail is literally a verbatim
 * continuation of the item's own description, that's the real cut point, not a length guess. */
function trimListingTitleRunOn(title, maxLen, description) {
  const max = maxLen || 80;
  let t = String(title || "").replace(/\s+/g, " ").trim();
  if (!t) return t;

  const desc = String(description || "").replace(/\s+/g, " ").trim();
  if (desc.length >= 20) {
    const descPrefix = desc.slice(0, 24).toLowerCase();
    const idx = t.toLowerCase().indexOf(descPrefix);
    if (idx > 4) {
      t = t.slice(0, idx).trim();
      return t.replace(/[,;:\-–—]+$/, "").trim();
    }
  }

  // If there's an early sentence break and what's before it is still a reasonable title, cut there.
  const m = t.match(/^(.{8,}?)\s*[.!?;]+(?:\s|$)/);
  if (m && m[1].length <= max) {
    t = m[1].trim();
  } else if (t.length > max) {
    t = t.slice(0, max);
    const lastSpace = t.lastIndexOf(" ");
    if (lastSpace > max * 0.6) t = t.slice(0, lastSpace);
  }
  return t.replace(/[,;:\-–—]+$/, "").trim();
}

function normalizeTitleCaps(title) {
  const raw = String(title || "").replace(/\s+/g, " ").trim();
  if (!raw) return raw;
  if (!titleHasTooManyCaps(raw)) return raw;
  const small = new Set(["a", "an", "and", "as", "at", "but", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "vs", "with"]);
  const words = raw.split(" ");
  const out = words.map((w, idx) => {
    const token = w.trim();
    if (!token) return token;
    const bare = token.replace(/^[('"“‘]+|[)'"”’.,!?;:]+$/g, "");
    // Keep short acronyms and size codes.
    if (/^[A-Z0-9]{2,4}$/.test(bare)) return token;
    // Keep things like "2PAC", "A1", "G7".
    if (/^[0-9][A-Z]{2,5}$/.test(bare)) return token;
    const low = bare.toLowerCase();
    // Preserve intentional casing for brand-like camel words.
    if (/[a-z][A-Z]/.test(bare)) return token;
    const cap =
      idx !== 0 && small.has(low)
        ? low
        : low.length
          ? low[0].toUpperCase() + low.slice(1)
          : low;
    // Replace the bare portion inside token while keeping surrounding punctuation.
    return token.replace(bare, cap);
  });
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function scoreEtsyTitleInput(el) {
  const isInp = el instanceof HTMLInputElement;
  const isTa = el instanceof HTMLTextAreaElement;
  if ((!isInp && !isTa) || el.readOnly || el.disabled) return -Infinity;
  const ty = isInp ? (el.type || "").toLowerCase() : "";
  if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") return -Infinity;
  const al = (el.getAttribute("aria-label") || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const name = (el.name || "").toLowerCase();
  let s = 0;
  if (al === "title" || /^\s*title\s*\*/i.test(el.getAttribute("aria-label") || "")) s += 120;
  else if (/\btitle\b/.test(al) && !/seo|meta|tag\b|page title|shop name|material tag/i.test(al)) s += 88;
  if (name === "title" || /listingtitle|listing-title|listing_title/i.test(id)) s += 72;
  const ml = el.maxLength;
  if (ml > 0 && ml <= ETSY_TITLE_MAX_LEN + 1) s += 38;
  let cur = el;
  for (let d = 0; d < 14 && cur; d++) {
    const blob = `${cur.textContent || ""} ${cur.getAttribute("aria-label") || ""}`.slice(0, 2400).toLowerCase();
    if (/between 1 and 140|make sure your title is easy|clearly describes the items|\/140/i.test(blob)) s += 48;
    if (/material tag|seo title|search engine/i.test(blob)) s -= 45;
    cur = cur.parentElement;
  }
  if (/search shops|filter|navigation/i.test(al) && !/^title$/i.test(al.trim())) s -= 70;
  s += Math.min(el.getBoundingClientRect().width / 28, 30);
  return s;
}

function queryBestEtsyTitleInput(root) {
  const rootEl = documentRootElement(root);
  const patterns = [
    "#listing-title",
    'input[name="title"]',
    'textarea[name="title"]',
    'input[aria-label="Title"]',
    'textarea[aria-label="Title"]',
    'input[aria-label^="Title" i]',
    'textarea[aria-label^="Title" i]',
    'input[data-testid*="title" i]',
    'textarea[data-testid*="title" i]',
    'input[id*="ListingTitle" i]',
    'input[id*="listing-title" i]',
    'textarea[id*="ListingTitle" i]',
    'textarea[id*="listing-title" i]',
  ];
  let best = null;
  let bestScore = -Infinity;
  for (const sel of patterns) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) continue;
      if (!isVisible(el)) continue;
      const sc = scoreEtsyTitleInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  }
  if (bestScore <= 0) {
    try {
      const all = querySelectorAllDeep("input, textarea", rootEl);
      for (const el of all) {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) continue;
        if (!isVisible(el)) continue;
        const sc = scoreEtsyTitleInput(el);
        if (sc > bestScore) {
          bestScore = sc;
          best = el;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return bestScore > 0 ? best : null;
}

function etsyTitleForFill(scan) {
  try {
    const et = scan.listing_extra && scan.listing_extra.etsy;
    if (et && typeof et.title === "string" && et.title.trim()) {
      return normalizeTitleCaps(et.title.trim()).slice(0, ETSY_TITLE_MAX_LEN);
    }
  } catch {
    /* ignore */
  }
  const t = String(scan.title || "").trim();
  if (t) return normalizeTitleCaps(t).slice(0, ETSY_TITLE_MAX_LEN);
  // Last resort: derive from description so Etsy validation passes (1–140 chars).
  const d = String(scan.description || "").replace(/\s+/g, " ").trim();
  if (d) return normalizeTitleCaps(d).slice(0, ETSY_TITLE_MAX_LEN);
  return "Listing";
}

/** eBay “Complete your listing”: prefer vision `listing_extra.ebay.item_description`, then session / Shopify body. */
function ebayDescriptionForFill(scan) {
  try {
    const eb = scan.listing_extra && scan.listing_extra.ebay;
    if (eb && typeof eb.item_description === "string" && eb.item_description.trim()) {
      return eb.item_description.trim();
    }
  } catch {
    /* ignore */
  }
  const d0 = String(scan.description || "").trim();
  if (d0) return d0;
  try {
    const sh = scan.listing_extra && scan.listing_extra.shopify;
    if (sh && typeof sh === "object" && sh.body_html != null) {
      const plain = String(sh.body_html)
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (plain.length > 20) return plain;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * GTIN / Barcode / Product code rows (Shopify, Shopee, etc.) often use numeric inputs —
 * do not treat as sale price or fill price into them.
 */
function isGtinBarcodeOrProductCodeInput(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  let cur = el;
  for (let d = 0; d < 28 && cur; d++) {
    const section = `${(cur.textContent || "").slice(0, 2600)} ${cur.getAttribute?.("aria-label") || ""}`.toLowerCase();
    const head = section.slice(0, 1000);
    if (
      /\bgtin\b|\bbarcode\b|\bproduct code\b|item code|manufacturer code|\bupc\b|item without gtin|kode produk|mpn\b/i.test(
        section
      )
    ) {
      if (!/\bprice\b|compare at|your price|sale price|cost per|listing price|unit price|ราคา|harga|giá/i.test(head)) {
        return true;
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

function queryBestShopifyPriceInput(root, excludeEl) {
  const rootEl = documentRootElement(root);
  let best = null;
  let bestScore = -Infinity;
  try {
    const all = querySelectorAllDeep("input", rootEl);
    for (const el of all) {
      if (excludeEl && el === excludeEl) continue;
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      if (isGtinBarcodeOrProductCodeInput(el)) continue;
      const sc = scoreShopifyPriceInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestScore > 0 ? best : null;
}

/** Shopee: never reuse Shopify title heuristics — they can match the wrong text box. Prefer explicit “product name”. */
function scoreShopeeProductNameInput(el) {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "search" || ty === "file" || ty === "checkbox" || ty === "radio") return -Infinity;
  const al = shopifyControlAccessibleName(el).toLowerCase();
  const ph = (el.getAttribute("placeholder") || "").toLowerCase();
  const nm = (el.name || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const blob = `${al} ${ph} ${nm} ${id}`;
  if (/price|ราคา|harga|giá|peso|baht|stock|qty|quantity|weight|sku|gtin|barcode|discount|ship|fee/i.test(blob)) {
    return -Infinity;
  }
  if (/\bprice\b/.test(al) && !/name/.test(al)) return -Infinity;
  const im = (el.inputMode || el.getAttribute("inputmode") || "").toLowerCase();
  if ((im === "decimal" || im === "numeric") && !/product|name|title|ชื่อ|nama/i.test(blob)) return -Infinity;
  let s = 0;
  if (/product\s*name|ชื่อสินค้า|nama\s*produk|tên\s*sản\s*phẩm/i.test(blob)) s += 120;
  else if (al.includes("product") && /\bname\b/.test(al)) s += 110;
  else if (/\bproduct\s*name\b/.test(ph) || /\bชื่อสินค้า\b/.test(ph)) s += 105;
  else if (nm === "name" && !/user|file|shop/i.test(id)) s += 45;
  s += Math.min(el.getBoundingClientRect().width / 30, 26);
  return s;
}

function queryBestShopeeProductNameInput(root) {
  const rootEl = documentRootElement(root);
  const patterns = [
    'input[placeholder*="Product name" i]',
    'input[placeholder*="product name" i]',
    'input[placeholder*="Enter product name" i]',
    'input[aria-label*="product name" i]',
    'input[placeholder*="ชื่อสินค้า" i]',
    'input[aria-label*="ชื่อสินค้า" i]',
  ];
  let best = null;
  let bestScore = -Infinity;
  for (const sel of patterns) {
    try {
      const nodes = querySelectorAllDeep(sel, rootEl);
      for (const el of nodes) {
        if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
        const sc = scoreShopeeProductNameInput(el);
        if (sc > bestScore) {
          bestScore = sc;
          best = el;
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (bestScore >= 75) return best;
  try {
    const all = querySelectorAllDeep("input", rootEl);
    for (const el of all) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      const sc = scoreShopeeProductNameInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  } catch {
    return null;
  }
  return bestScore >= 55 ? best : null;
}

/** Next visible price input that is not the title field (Shopee often shares ambiguous selectors). */
function queryPriceDeepExcluding(root, platform, excludeEl) {
  if (!excludeEl) return null;
  const m =
    (typeof SYNCLYST_PLATFORM_MAPPERS !== "undefined" && SYNCLYST_PLATFORM_MAPPERS[platform]) ||
    SYNCLYST_PLATFORM_MAPPERS.shopify;
  const rootEl = documentRootElement(root);
  for (const sel of m.price) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (node === excludeEl) continue;
      if (node instanceof HTMLInputElement && isVisible(node) && !node.readOnly) return node;
    }
  }
  return null;
}

/** Vinted sell form: pick the main listing price, not promos / shipping / compare fields. */
/**
 * Vinted had no dedicated title finder and fell back to `queryBestShopifyTitleInput` — tuned
 * for Shopify's DOM, it could mismatch on Vinted's page and grab the price field instead,
 * filling the price into Title and leaving Price unfilled/NaN.
 */
function scoreVintedTitleInput(el) {
  if ((!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) || el.readOnly || el.disabled) {
    return -Infinity;
  }
  if (el instanceof HTMLInputElement) {
    const ty = (el.type || "").toLowerCase();
    if (ty === "hidden" || ty === "search" || ty === "checkbox" || ty === "radio" || ty === "file" || ty === "number") {
      return -Infinity;
    }
  }
  const al = shopifyControlAccessibleName(el).toLowerCase();
  const ph = (el.getAttribute("placeholder") || "").toLowerCase();
  const nm = (el.name || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const tid = (el.getAttribute("data-testid") || "").toLowerCase();
  const blob = `${al} ${ph} ${nm} ${id} ${tid}`;
  if (/price|amount|cost|£|\$|€|description|brand|size|condition|colou?r|material/i.test(blob)) {
    return -Infinity;
  }
  let s = 0;
  if (al === "title" || nm === "title") s += 120;
  else if (/\btitle\b/.test(blob)) s += 90;
  else if (/\bname\b/.test(blob) && !/brand/.test(blob)) s += 40;
  if ((el.getAttribute("maxlength") | 0) > 0 && (el.getAttribute("maxlength") | 0) <= 80) s += 10;
  return s;
}

function queryBestVintedTitleInput(root) {
  const rootEl = documentRootElement(root);
  let best = null;
  let bestScore = -Infinity;
  try {
    const all = querySelectorAllDeep("input, textarea", rootEl);
    for (const el of all) {
      if (!(isVisible(el) || vintedLayoutInteractable(el, 2, 2))) continue;
      const sc = scoreVintedTitleInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestScore > 0 ? best : null;
}

function scoreVintedPriceInput(el) {
  if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "search" || ty === "checkbox" || ty === "radio" || ty === "file") return -Infinity;
  const al = shopifyControlAccessibleName(el).toLowerCase();
  const ph = (el.getAttribute("placeholder") || "").toLowerCase();
  const nm = (el.name || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const tid = (el.getAttribute("data-testid") || "").toLowerCase();
  const blob = `${al} ${ph} ${nm} ${id} ${tid}`;
  if (
    /original|was|compare|strike|rrp|discount|coupon|promo|shipping|postage|bundle|fee|title|description|brand|size|condition|colou?r|material|measurement|length|width|height|chest|waist|inseam|sleeve/i.test(
      blob
    )
  ) {
    return -Infinity;
  }
  let s = 0;
  if (al === "price" || /^price\b/.test(al)) s += 120;
  else if (/\bprice\b/.test(al)) s += 92;
  if (nm === "price") s += 88;
  if (/price/.test(id) || /price/.test(tid)) s += 72;
  if ((el.inputMode || el.getAttribute("inputmode") || "") === "decimal") s += 38;
  if (ty === "number" || ty === "text") s += 12;
  s += Math.min(el.getBoundingClientRect().width / 48, 20);
  return s;
}

function queryBestVintedPriceInput(root) {
  const rootEl = documentRootElement(root);
  let best = null;
  let bestScore = -Infinity;
  try {
    const all = querySelectorAllDeep("input", rootEl);
    for (const el of all) {
      if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) continue;
      if (!(isVisible(el) || vintedLayoutInteractable(el, 2, 2))) continue;
      const sc = scoreVintedPriceInput(el);
      if (sc > bestScore) {
        bestScore = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestScore >= 50 ? best : null;
}

/** Last-resort when `scan.price` is empty but title/description mention a currency amount. */
function synclystExtractMoneyCandidateFromText(blob) {
  if (blob == null) return "";
  const s = String(blob).replace(/\s+/g, " ").trim();
  if (!s) return "";
  const hits = [];
  const patterns = [
    /£\s*([\d]{1,7}(?:[.,]\d{1,2})?)/gi,
    /\$\s*([\d]{1,7}(?:[.,]\d{1,2})?)/g,
    /€\s*([\d]{1,7}(?:[.,]\d{1,2})?)/g,
    /฿\s*([\d]{1,7}(?:[.,]\d{1,2})?)/gi,
    /\b(?:GBP|USD|EUR)\s*[:=]?\s*([\d]{1,7}(?:[.,]\d{1,2})?)\b/gi,
    /\bTHB\s*[:=]?\s*([\d]{1,7}(?:[.,]\d{1,2})?)\b/gi,
  ];
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(s)) !== null) {
      if (m[1]) hits.push(m[1]);
    }
  }
  for (const raw of hits) {
    const n = normalizeMarketplacePriceString(raw);
    if (!n) continue;
    const pn = parseFloat(n);
    if (Number.isFinite(pn) && pn >= 1) return n;
  }
  return "";
}

/** Price on payload, then Vinted / Shopify extras (Magic Fill often omits top-level `price`). */
function resolveVintedPriceStringForFill(scan) {
  if (!scan || typeof scan !== "object") return "";
  const tries = [scan.price, scan.price_value, scan.price_display, scan.unit_price];
  try {
    const le = scan.listing_extra;
    if (le && typeof le === "object") {
      const vt = le.vinted;
      if (vt && typeof vt === "object" && vt.price != null) tries.push(vt.price);
      const sh = le.shopify;
      if (sh && typeof sh === "object") {
        tries.push(sh.price);
        tries.push(sh.unit_price);
        tries.push(sh.compare_at_price);
        tries.push(sh.compareAtPrice);
      }
      const eb = le.ebay;
      if (eb && typeof eb === "object") {
        tries.push(eb.buy_it_now_price);
        tries.push(eb.starting_bid);
      }
      const et = le.etsy;
      if (et && typeof et === "object" && et.price != null) tries.push(et.price);
      const dp = le.depop;
      if (dp && typeof dp === "object" && dp.price != null) tries.push(dp.price);
    }
  } catch {
    /* ignore */
  }
  for (const t of tries) {
    const n = normalizeMarketplacePriceString(t);
    if (!n) continue;
    const pn = parseFloat(n);
    if (Number.isFinite(pn) && pn >= 1) return n;
  }
  const fromBlob = synclystExtractMoneyCandidateFromText(
    `${String(scan.title || "")} ${String(scan.description || "")}`.slice(0, 12000)
  );
  return fromBlob || "";
}

/** Stronger than `scoreVintedPriceInput` alone: Vinted often omits aria on the real field but keeps a “Price” row. */
function vintedScorePriceInputWithRow(el) {
  if (!(el instanceof HTMLInputElement)) return -Infinity;
  let sc = scoreVintedPriceInput(el);
  if (!Number.isFinite(sc)) sc = -Infinity;
  if (sc <= -1e8) return sc;
  const row = el.closest("div, section, li, fieldset, form, tr, article");
  if (row) {
    const head = (row.textContent || "").replace(/\s+/g, " ").slice(0, 160).toLowerCase();
    if (/\bprice\b/.test(head) && !/original|compare at|was price|strike|rrp|shipping|postage/i.test(head)) {
      sc += 78;
    }
  }
  const tid = (el.getAttribute("data-testid") || "").toLowerCase();
  if (tid.includes("price")) sc += 44;
  return sc;
}

/** Every plausible listing-price input, sorted best-first (row label + test id beat missing aria). */
function vintedCollectAllPriceInputCandidates(rootEl) {
  const map = new Map();
  try {
    for (const el of querySelectorAllDeep("input", rootEl)) {
      if (!(el instanceof HTMLInputElement) || el.readOnly || el.disabled) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "checkbox" || ty === "radio" || ty === "file") continue;
      if (ty === "search") continue;
      if (ty === "hidden") continue;
      const layoutOk = isVisible(el) || vintedLayoutInteractable(el, 2, 2);
      if (!layoutOk) continue;
      const sc = vintedScorePriceInputWithRow(el);
      if (sc < 18) continue;
      map.set(el, Math.max(map.get(el) || 0, sc));
    }
  } catch {
    /* ignore */
  }
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map((x) => x[0]);
}

function vintedListPriceInputCandidates(rootEl) {
  return vintedCollectAllPriceInputCandidates(rootEl).filter((el) => {
    const sc = vintedScorePriceInputWithRow(el);
    return sc >= 40;
  });
}

/**
 * Vinted’s listing price is React-controlled; a plain `value = "x"` can leave the UI at £NaN until the
 * native value setter + input events run in the right order.
 */
function vintedSetPriceInputReactFriendly(el, numericStr) {
  if (!(el instanceof HTMLInputElement)) return false;
  const str = String(numericStr || "").trim();
  if (!str) return false;
  const pn = parseFloat(str);
  if (!Number.isFinite(pn) || pn < 1) return false;
  try {
    el.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setVal = (v) => {
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
    };
    setVal(str);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        data: str,
        inputType: "insertFromPaste",
      })
    );
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    try {
      el.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return fillField(el, str);
  }
}

/** Some Vinted builds only commit price after per-keystroke `input` events (fiber tracks incremental diffs). */
function vintedTypePriceDigitsForReact(el, numericStr) {
  if (!(el instanceof HTMLInputElement)) return false;
  const str = String(numericStr || "").trim();
  const digits = str.replace(/[^\d.]/g, "");
  if (!digits || !Number.isFinite(parseFloat(digits))) return false;
  try {
    el.focus();
    try {
      el.click();
    } catch {
      /* ignore */
    }
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setVal = (v) => {
      if (desc && desc.set) desc.set.call(el, v);
      else el.value = v;
    };
    setVal("");
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    for (let i = 0; i < digits.length; i++) {
      const ch = digits[i];
      setVal((el.value || "") + ch);
      try {
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            composed: true,
            data: ch,
            inputType: "insertText",
          })
        );
      } catch {
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
    }
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

function vintedApplyPriceToInput(el, priceStr) {
  if (!(el instanceof HTMLInputElement)) return false;
  if (!vintedSetPriceInputReactFriendly(el, priceStr)) return false;
  const raw = String(el.value || "").trim().toLowerCase();
  if (!raw || /nan|infinity|undefined/.test(raw)) {
    vintedTypePriceDigitsForReact(el, priceStr);
  }
  return true;
}

/** Returns 1 if a price field was written or repaired. */
function vintedForceFillPriceFromScan(scan, root) {
  const priceStr = resolveVintedPriceStringForFill(scan);
  if (!priceStr) {
    console.warn("[SyncLyst] Vinted Price: resolveVintedPriceStringForFill() returned empty", {
      "scan.price": scan && scan.price,
    });
    return 0;
  }
  const want = parseFloat(priceStr);
  if (!Number.isFinite(want) || want < 1) {
    console.warn("[SyncLyst] Vinted Price: resolved value rejected (not finite or < 1)", priceStr);
    return 0;
  }

  const rootEl = documentRootElement(root);
  const candidates = vintedCollectAllPriceInputCandidates(rootEl);
  if (!candidates.length) {
    console.warn("[SyncLyst] Vinted Price: no candidate <input> scored >= 18 (resolved price was '" + priceStr + "')");
    return 0;
  }
  console.log("[SyncLyst] Vinted Price: resolved '" + priceStr + "', " + candidates.length + " candidate input(s)", candidates);

  const valueLooksOk = (el) => {
    const raw = String(el.value || "").trim().toLowerCase();
    if (!raw || /nan|infinity|undefined/.test(raw)) return false;
    const curNum = parseFloat(raw.replace(/[^0-9.-]/g, ""));
    return Number.isFinite(curNum) && Math.abs(curNum - want) <= 0.009;
  };

  /** If the top-scoring candidate already holds the right price (e.g. a repeat call), stop — never cascade into the next-best field. */
  const best = candidates[0];
  if (best instanceof HTMLInputElement && valueLooksOk(best)) {
    console.log("[SyncLyst] Vinted Price: best candidate already correct, leaving as-is", best);
    return 0;
  }
  if (!(best instanceof HTMLInputElement)) {
    console.warn("[SyncLyst] Vinted Price: best candidate is not an <input>", best);
    return 0;
  }
  const ok = vintedApplyPriceToInput(best, priceStr);
  console.log("[SyncLyst] Vinted Price: applied to best candidate, result value =", best.value, "ok =", ok, best);
  if (ok) {
    /** Vinted's React tree can re-render a tick later and stomp our value back to NaN — verify it actually stuck. */
    setTimeout(() => {
      console.log(
        "[SyncLyst] Vinted Price: 400ms later, value =",
        best.value,
        valueLooksOk(best) ? "(still correct)" : "(REVERTED)"
      );
    }, 400);
    return 1;
  }
  console.warn("[SyncLyst] Vinted Price: best candidate did not accept the value");
  return 0;
}

/** MAIN `executeScript` — same realm as Vinted’s React tree (content-script fills often never clear £NaN). */
function vintedFireMainWorldPriceThrottled(priceStr) {
  const str = String(priceStr || "").trim();
  if (!str) return;
  try {
    const win = typeof window !== "undefined" ? window : null;
    const t = Date.now();
    if (win) {
      if (win.__synclystVintedPriceMainAt && t - win.__synclystVintedPriceMainAt < 420) return;
      win.__synclystVintedPriceMainAt = t;
    }
  } catch {
    /* ignore */
  }
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
  try {
    let tabId;
    try {
      const tid = globalThis.__synclystFillSourceTabId;
      if (typeof tid === "number" && Number.isFinite(tid)) tabId = tid;
    } catch {
      /* ignore */
    }
    chrome.runtime.sendMessage({
      type: "SYNCLYST_VINTED_MAIN_SET_PRICE",
      priceStr: str.slice(0, 32),
      tabId,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Polaris labels Product organization → "Type" via aria-labelledby (not always "Product type").
 * Category uses a taxonomy combobox (often search / Browse) — needs scoring + deferred retries.
 */
function shopifyFillProductTypeField(rootEl, val) {
  const str = String(val || "").trim();
  if (!str) return false;
  const neg = /search engine|seo|page title|meta title|google|handle|url|slug|barcode|sku/i;
  let best = null;
  let bestSc = -1;
  try {
    const inputs = querySelectorAllDeep("input", rootEl);
    for (const el of inputs) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
      const nl = shopifyControlAccessibleName(el).toLowerCase();
      if (neg.test(nl)) continue;
      let sc = 0;
      if (nl === "type" || nl === "product type") sc += 130;
      else if (nl.includes("product type")) sc += 115;
      else if (/\btype\b/.test(nl) && !nl.includes("subtype") && !nl.includes("file")) sc += 70;
      const card = el.closest("section, [class*='Card'], div");
      if (card && /product organization/i.test((card.textContent || "").slice(0, 400))) sc += 45;
      if (el.closest('[role="combobox"]')) sc += 28;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  if (!best || bestSc < 55) {
    console.warn("[SyncLyst] Shopify Type field: no input match found (best score " + bestSc + "), trying <select>", best);
    return shopifyFillSelectByLabel(rootEl, /\btype\b/i, str, "Type field");
  }
  const ok = fillField(best, str);
  console.log("[SyncLyst] Shopify Type field: filled =", ok, "score =", bestSc, best);
  return ok;
}

function shopifyFillCategoryField(rootEl, raw, depth) {
  const d = depth || 0;
  if (d > 2) return false;
  const str = String(raw || "").trim();
  if (!str) return false;
  const searchBit = str.split(/[>›]/)[0].split(",")[0].trim().slice(0, 80);
  if (!searchBit) return false;
  /** Taxonomy popover often portals to document.body — widen search after Browse. */
  const huntRoot = d > 0 ? document.body : rootEl;
  let best = null;
  let bestSc = -1;
  try {
    const inputs = querySelectorAllDeep("input", huntRoot);
    for (const el of inputs) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "file") continue;
      const nl = shopifyControlAccessibleName(el).toLowerCase();
      let sc = 0;
      if (nl.includes("categor")) sc += 120;
      if (nl.includes("browse") || nl.includes("taxonomy")) sc += 90;
      if (ty === "search") sc += 35;
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      if (ph.includes("search") || ph.includes("categor")) sc += 40;
      const card = el.closest("section, [class*='Card'], div");
      if (card && /^[\s\S]{0,600}categor/i.test(card.textContent || "")) sc += 25;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  if (best && bestSc >= 45) {
    if (fillField(best, searchBit)) {
      console.log("[SyncLyst] Shopify Category field: typed '" + searchBit + "', score =", bestSc, best);
      try {
        setTimeout(() => {
          best.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "ArrowDown",
              code: "ArrowDown",
              keyCode: 40,
              bubbles: true,
              composed: true,
            })
          );
          best.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Enter",
              code: "Enter",
              keyCode: 13,
              bubbles: true,
              composed: true,
            })
          );
        }, 160);
      } catch {
        /* ignore */
      }
      return true;
    }
  }
  try {
    const buttons = querySelectorAllDeep("button, [role='button'], a", huntRoot);
    for (const b of buttons) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (t !== "browse" && !/^browse\b/i.test(t)) continue;
      const card = b.closest("section, [class*='Card'], div");
      if (card && /categor/i.test((card.textContent || "").slice(0, 500))) {
        b.click();
        setTimeout(() => {
          try {
            shopifyFillCategoryField(rootEl, raw, d + 1);
          } catch {
            /* ignore */
          }
        }, 400);
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  console.warn("[SyncLyst] Shopify Category field: no input/Browse button match found (depth " + d + ", best score " + bestSc + ")", best);
  return false;
}

function shopifyRevealMediaFileInput(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button'], label", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!/upload new|add files|select files/i.test(t)) continue;
      const box = b.closest("[class*='media'], [class*='Media'], section, div");
      if (box && /media|image|video|3d/i.test((box.textContent || "").slice(0, 220))) {
        b.click();
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shopifyClickAddVariantOptions(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, a, [role='button'], span[role='button']", rootEl);
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/add options like size or color/i.test(t) || /^\+?\s*add options/i.test(t)) {
        const card = el.closest("section, [class*='Card'], div");
        if (card && /variant/i.test((card.textContent || "").slice(0, 200))) {
          el.click();
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Late-mounted Product organization / Category / Variants / Media — retry after Polaris renders. */
function scheduleShopifyDeferredExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  const s = scan.listing_extra && (scan.listing_extra.shopify || scan.listing_extra);
  if (!s || typeof s !== "object") {
    [400, 1400].forEach((ms) => {
      setTimeout(() => {
        try {
          shopifyRevealMediaFileInput(rootEl);
          shopifyAttachProductMediaFromScan(scan, root);
        } catch {
          /* ignore */
        }
      }, ms);
    });
    return;
  }
  [450, 1200, 2400].forEach((ms) => {
    setTimeout(() => {
      try {
        shopifyRevealMediaFileInput(rootEl);
        if (s.product_type) shopifyFillProductTypeField(rootEl, s.product_type);
        if (s.category) shopifyFillCategoryField(rootEl, s.category);
        const sizes = Array.isArray(s.sizes) ? s.sizes.filter(Boolean) : [];
        const colors = Array.isArray(s.colors) ? s.colors.filter(Boolean) : [];
        if (sizes.length || colors.length) {
          shopifyClickAddVariantOptions(rootEl);
          shopifyFillVariantOptionValues(s, rootEl);
        }
        shopifyAttachProductMediaFromScan(scan, root);
      } catch {
        /* ignore */
      }
    }, ms);
  });
}

/** Lexical / React RTE: insert a text node + beforeinput/input (execCommand alone often no-ops). */
function insertPlainTextIntoContentEditable(el, text) {
  const t = String(text || "").trim();
  if (!t || !(el instanceof HTMLElement) || !el.isContentEditable) return false;
  const doc = el.ownerDocument || document;
  const view = doc.defaultView || window;

  const tryExecInsertAll = () => {
    try {
      el.focus();
      const sel = view.getSelection();
      if (sel && doc.createRange) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      return doc.execCommand("insertText", false, t);
    } catch {
      return false;
    }
  };

  /** eBay Lexical often wires to `document.execCommand("insertText")` — try before DOM surgery. */
  if (tryExecInsertAll() && (el.textContent || "").trim().length > 0) return true;

  try {
    el.focus();
    const range = doc.createRange();
    range.selectNodeContents(el);
    range.deleteContents();
    const tn = doc.createTextNode(t);
    range.insertNode(tn);
    range.setStartAfter(tn);
    range.collapse(true);
    const sel = view.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    el.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        composed: true,
        cancelable: false,
        inputType: "insertText",
        data: t,
      })
    );
    el.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: t })
    );
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if ((el.textContent || "").trim().length > 0) return true;
  } catch {
    /* fall through */
  }

  try {
    el.focus();
    if (doc.execCommand("insertText", false, t) && (el.textContent || "").trim().length > 0) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function shopifyFillHiddenDescriptionTextarea(text, root) {
  const t = String(text || "").trim();
  if (!t) return false;
  const rootEl = documentRootElement(root);
  const sels = [
    'textarea[name="description"]',
    'textarea[name="body"]',
    'textarea[id*="Description" i]',
    'textarea[id*="RichText" i]',
    'textarea[id*="ProductDescription" i]',
  ];
  for (const sel of sels) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLTextAreaElement)) continue;
      if (el.readOnly) continue;
      try {
        if (fillField(el, t)) return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/** eBay Lexical placeholder rows can fail `isVisible` (opacity / animation) while still accepting input. */
function ebayDescriptionInteractable(el) {
  if (!el || !(el instanceof HTMLElement) || !el.isContentEditable) return false;
  const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
  let style;
  try {
    style = view.getComputedStyle(el);
  } catch {
    return false;
  }
  if (style.display === "none" || style.visibility === "hidden" || style.pointerEvents === "none") return false;
  const r = el.getBoundingClientRect();
  if (r.width < 72 || r.height < 28) return false;
  const op = parseFloat(style.opacity);
  if (Number.isFinite(op) && op < 0.08) return false;
  return true;
}

function ebayFillHiddenDescriptionTextarea(text, root) {
  const t = String(text || "").trim();
  if (!t) return false;
  const rootEl = documentRootElement(root);
  const sels = [
    "#editpane_description",
    'textarea[name="description"]',
    'textarea[id*="description" i]',
    'textarea[id*="DESC" i]',
    'textarea[aria-label*="description" i]',
    'textarea[aria-label*="item description" i]',
    'textarea[placeholder*="detailed description" i]',
    'textarea[placeholder*="let AI" i]',
    'textarea[name="body"]',
  ];
  for (const sel of sels) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLTextAreaElement)) continue;
      if (el.readOnly) continue;
      try {
        if (fillField(el, t)) return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/**
 * Newer eBay listing UIs use Lexical under **DESCRIPTION** with a **Use AI description** chip below.
 * There may be no `#editpane_description` textarea — find the main `contenteditable` in that region.
 */
function ebayLocateDescriptionContentEditable(rootEl) {
  const ok = (ce) => {
    if (!(ce instanceof HTMLElement) || !ce.isContentEditable) return false;
    if (!(isVisible(ce) || vintedLayoutInteractable(ce) || ebayDescriptionInteractable(ce))) return false;
    const r = ce.getBoundingClientRect();
    return r.height >= 36 && r.width >= 80;
  };

  try {
    for (const btn of querySelectorAllDeep('button, [role="button"], a', rootEl)) {
      if (!(btn instanceof HTMLElement)) continue;
      const lab = (btn.textContent || "").replace(/\s+/g, " ").trim();
      if (!/use\s+ai\s+description/i.test(lab)) continue;
      let walk = btn.parentElement;
      for (let i = 0; i < 18 && walk; i++) {
        let best = null;
        let bestArea = 0;
        const ces = walk.querySelectorAll('[contenteditable="true"]');
        for (const ce of ces) {
          if (!(ce instanceof HTMLElement)) continue;
          if (btn.contains(ce)) continue;
          if (!ok(ce)) continue;
          const ar = ce.getBoundingClientRect();
          const area = ar.height * ar.width;
          if (area > bestArea) {
            bestArea = area;
            best = ce;
          }
        }
        if (best) return best;
        walk = walk.parentElement;
      }
    }
  } catch {
    /* ignore */
  }

  try {
    for (const sel of [
      '[data-lexical-editor="true"] [contenteditable="true"]',
      "[data-lexical-editor] [contenteditable=\"true\"]",
      '[contenteditable="true"][aria-label*="DESCRIPTION" i]',
      '[contenteditable="true"][aria-label*="Item description" i]',
      '[contenteditable="true"][aria-label*="item description" i]',
      '[role="textbox"][aria-label*="description" i]',
    ]) {
      const nodes = querySelectorAllDeep(sel, rootEl);
      for (const ce of nodes) {
        if (!(ce instanceof HTMLElement) || !ce.isContentEditable) continue;
        if (ok(ce)) return ce;
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

/**
 * eBay listing editor: textarea (#editpane_description / Lexical) and contenteditable description regions.
 * Kept separate from Shopify so we do not match the wrong rich editor on eBay.
 */
function ebayFillRichDescription(text, root) {
  const t = String(text || "").trim();
  if (!t) return false;
  const rootEl = documentRootElement(root);
  if (ebayFillHiddenDescriptionTextarea(t, root)) return true;
  const taSels = [
    "#editpane_description",
    'textarea[name="description"]',
    'textarea[aria-label*="description" i]',
    'textarea[aria-label*="item description" i]',
    'textarea[placeholder*="Write a detailed description" i]',
    'textarea[placeholder*="detailed description" i]',
    'textarea[placeholder*="save time" i]',
    'textarea[placeholder*="let AI" i]',
    'textarea[placeholder*="AI draft" i]',
    'textarea[placeholder*="draft it for you" i]',
  ];
  for (const sel of taSels) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLTextAreaElement) || el.readOnly) continue;
      try {
        if (fillField(el, t)) return true;
      } catch {
        /* next */
      }
    }
  }

  {
    const guess = ebayLocateDescriptionContentEditable(rootEl);
    if (guess) {
      if (insertPlainTextIntoContentEditable(guess, t)) return true;
      try {
        const inner = guess.querySelector('[contenteditable="true"]');
        if (inner instanceof HTMLElement && inner !== guess && insertPlainTextIntoContentEditable(inner, t)) return true;
      } catch {
        /* ignore */
      }
    }
  }

  try {
    const headings = querySelectorAllDeep("h1, h2, h3, h4, h5, h6, legend, span, p, div", rootEl);
    for (const h of headings) {
      if (!(h instanceof HTMLElement) || !isVisible(h)) continue;
      const tx = (h.textContent || "").replace(/\s+/g, " ").trim();
      const head = tx.slice(0, 72);
      if (!/\bDESCRIPTION\b/i.test(head)) continue;
      const sec = h.closest("section, article, form, [role='region'], main, div") || h.parentElement;
      if (!sec) continue;
      const blob = (sec.textContent || "").slice(0, 4000).toLowerCase();
      if (!/description|detailed|item/i.test(blob)) continue;
      const ta = sec.querySelector("textarea");
      if (ta instanceof HTMLTextAreaElement && !ta.readOnly && isVisible(ta)) {
        try {
          if (fillField(ta, t)) return true;
        } catch {
          /* next */
        }
      }
      const ces = sec.querySelectorAll('[contenteditable="true"]');
      for (const ce of ces) {
        if (!(ce instanceof HTMLElement) || !ce.isContentEditable) continue;
        if (!(isVisible(ce) || vintedLayoutInteractable(ce) || ebayDescriptionInteractable(ce))) continue;
        const r = ce.getBoundingClientRect();
        if (r.height < 40 || r.width < 80) continue;
        if (insertPlainTextIntoContentEditable(ce, t)) return true;
      }
    }
  } catch {
    /* ignore */
  }

  const seen = new Set();
  const candidates = [];
  function add(el) {
    if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
    if (seen.has(el)) return;
    seen.add(el);
    candidates.push(el);
  }

  const ceGroups = [
    '[aria-label*="DESCRIPTION" i][contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="description" i]',
    'div[contenteditable="true"][data-placeholder*="Write a detailed description" i]',
    'div[contenteditable="true"][data-placeholder*="detailed description of your item" i]',
    'div[contenteditable="true"][data-placeholder*="save time" i]',
    'div[contenteditable="true"][data-placeholder*="let AI" i]',
    'div[contenteditable="true"][data-placeholder*="AI" i]',
    '[role="textbox"][aria-label*="description" i][contenteditable="true"]',
    '[data-lexical-editor="true"] [contenteditable="true"]',
    '[data-lexical-editor] [contenteditable="true"]',
    'div[class*="ContentEditable" i][contenteditable="true"]',
  ];
  for (const sel of ceGroups) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    nodes.forEach(add);
  }

  try {
    querySelectorAllDeep(
      '[placeholder*="Write a detailed description" i], [placeholder*="AI draft" i], [placeholder*="let AI" i], [data-placeholder*="Write a detailed description" i], [data-placeholder*="AI draft" i], [data-placeholder*="let AI" i]',
      rootEl
    ).forEach((ph) => {
      if (!(ph instanceof HTMLElement)) return;
      const near =
        ph.closest('[contenteditable="true"]') ||
        ph.parentElement?.querySelector('[contenteditable="true"]');
      if (near instanceof HTMLElement) add(near);
    });
  } catch {
    /* ignore */
  }

  try {
    querySelectorAllDeep('[contenteditable="true"]', rootEl).forEach((el) => {
      if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
      if (!(isVisible(el) || vintedLayoutInteractable(el) || ebayDescriptionInteractable(el))) return;
      const r = el.getBoundingClientRect();
      if (r.height < 48 || r.width < 100) return;
      const ac = el.closest("[aria-label], [data-testid]");
      const lab = (
        el.getAttribute("aria-label") ||
        (ac && (ac.getAttribute("aria-label") || ac.getAttribute("data-testid") || "")) ||
        ""
      ).toLowerCase();
      if (!/description|item description|write a detailed/.test(lab)) return;
      if (/title|price|search|subtitle|feedback|shipping|return/i.test(lab)) return;
      add(el);
    });
  } catch {
    /* ignore */
  }

  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.height * rb.width - ra.height * ra.width;
  });

  for (const el of candidates) {
    if (!(isVisible(el) || vintedLayoutInteractable(el) || ebayDescriptionInteractable(el))) continue;
    if (insertPlainTextIntoContentEditable(el, t)) return true;
    try {
      el.focus();
      const doc = el.ownerDocument || document;
      doc.execCommand("selectAll", false, null);
      doc.execCommand("insertText", false, t);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt,
        })
      );
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      el.textContent = t;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      const esc = (s) =>
        String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      el.innerHTML = t
        .split(/\n/)
        .map((line) => `<p>${esc(line)}</p>`)
        .join("");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
  }
  ebayFireMainWorldDescriptionThrottled(t);
  return false;
}

/**
 * Polaris / Lexical: try hidden textarea first (sometimes syncs UI), then visible editors by size/label.
 */
function shopifyFillRichDescription(text, root) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (shopifyFillHiddenDescriptionTextarea(t, root)) return true;

  const rootEl = documentRootElement(root);
  const seen = new Set();
  const candidates = [];

  function add(el) {
    if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
    if (seen.has(el)) return;
    seen.add(el);
    candidates.push(el);
  }

  const selectorGroups = [
    '[aria-label="Description"] [contenteditable="true"]',
    '[aria-label*="product description" i] [contenteditable="true"]',
    '[aria-label*="Description" i][contenteditable="true"]',
    '[id*="Description" i][contenteditable="true"]',
    '[data-lexical-editor] [contenteditable="true"]',
    '[class*="RichTextEditor"] [contenteditable="true"]',
    '.ql-editor[contenteditable="true"]',
    '.ProseMirror[contenteditable="true"]',
  ];
  for (const sel of selectorGroups) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    nodes.forEach(add);
  }

  try {
    querySelectorAllDeep('[contenteditable="true"]', rootEl).forEach((el) => {
      if (!(el instanceof HTMLElement) || !el.isContentEditable) return;
      if (!isVisible(el)) return;
      const r = el.getBoundingClientRect();
      if (r.height < 52 || r.width < 100) return;
      const ac = el.closest("[aria-label]");
      const lab = ((el.getAttribute("aria-label") || "") + (ac ? ac.getAttribute("aria-label") || "" : "")).toLowerCase();
      if (/title|search engine|meta title|seo|page title|handle|url/i.test(lab)) return;
      add(el);
    });
  } catch {
    /* ignore */
  }

  candidates.sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return rb.height * rb.width - ra.height * ra.width;
  });

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    if (insertPlainTextIntoContentEditable(el, t)) return true;
    try {
      el.focus();
      document.execCommand("selectAll", false, null);
      document.execCommand("insertText", false, t);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", t);
      el.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          composed: true,
          clipboardData: dt,
        })
      );
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      el.textContent = t;
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: t }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
    try {
      const esc = (s) =>
        String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      el.innerHTML = t
        .split(/\n/)
        .map((line) => `<p>${esc(line)}</p>`)
        .join("");
      el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      if ((el.textContent || "").trim().length > 0) return true;
    } catch {
      /* next */
    }
  }
  return false;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Tags from extension-review / session: listing_extra.shopify.tags (comma-separated) or array.
 * Mirrors flow-3 / extension-review: same keywords as draft list.
 */
function collectShopifyTagsForFill(scan) {
  if (!scan || typeof scan !== "object") return [];
  const extra = scan.listing_extra;
  const shopify = extra && (extra.shopify || extra);
  let blob = "";
  if (shopify && typeof shopify.tags === "string") blob = shopify.tags;
  else if (Array.isArray(shopify && shopify.tags)) blob = shopify.tags.join(", ");
  if (!blob.trim() && Array.isArray(scan.tags)) blob = scan.tags.join(", ");
  if (!blob.trim()) return [];
  return blob
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 40);
}

function shopifyTagsContainerLikelyHasTag(container, tag) {
  if (!container || !tag) return false;
  const t = tag.trim();
  if (!t) return false;
  const lower = t.toLowerCase();
  try {
    const chips = container.querySelectorAll(
      'button[aria-label*="Remove" i], span[class*="Tag"], [data-tag], [class*="Tag__"]'
    );
    for (const c of chips) {
      const tx = (c.textContent || "").trim().replace(/\s+/g, " ");
      if (tx && tx.toLowerCase() === lower) return true;
    }
  } catch {
    /* ignore */
  }
  const all = (container.textContent || "").replace(/\s+/g, " ");
  const re = new RegExp(`(?:^|[,\\s])${escapeRegExp(t)}(?:$|[,\\s])`, "i");
  return re.test(all);
}

/** Tags section often shows only a "+ Add tags" button until clicked — no input exists until then. */
function shopifyRevealTagsInput(rootEl) {
  try {
    const nodes = querySelectorAllDeep("button, [role='button']", rootEl);
    for (const b of nodes) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!/^\+?\s*add tags?\b/.test(t)) continue;
      b.click();
      console.log("[SyncLyst] Shopify Tags: clicked '" + t + "' to reveal the input");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function findShopifyTagsInput(rootEl) {
  const selectors = [
    'input[aria-label*="Tag" i]',
    'input[placeholder*="tag" i]',
    'input[placeholder*="create tag" i]',
    'input[type="search"][placeholder*="tag" i]',
    'input[id*="Tags" i]',
    '[data-testid*="tags"] input',
    '[data-testid*="Tags"] input',
    'div[role="combobox"] input[aria-label*="tag" i]',
    'div[role="combobox"] input[placeholder*="tag" i]',
    'div[role="combobox"] input[type="search"]',
  ];
  for (const sel of selectors) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
      return el;
    }
  }
  try {
    const all = querySelectorAllDeep("input", rootEl);
    let best = null;
    let bestSc = 0;
    for (const el of all) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden") continue;
      // Include type="search" — Shopify tags uses <input type="search" placeholder="Search or create tags">
      const name = shopifyControlAccessibleName(el).toLowerCase();
      const placeholder = (el.placeholder || "").toLowerCase();
      let sc = 0;
      if (name.includes("tag") && !name.includes("percentage") && !name.includes("instagram")) sc += 85;
      if ((el.id && /tag/i.test(el.id)) || (el.name && /tag/i.test(el.name))) sc += 35;
      if (placeholder.includes("tag") || placeholder.includes("create tag")) sc += 60;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (bestSc >= 60) return best;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Polaris Tags combobox: one tag per Enter; multi-tag uses delayed steps so React can add chips.
 */
function shopifyFillTagsCombobox(scan, root) {
  const tags = collectShopifyTagsForFill(scan);
  if (!tags.length) {
    console.warn("[SyncLyst] Shopify Tags: collectShopifyTagsForFill() returned none — check listing_extra.shopify.tags", scan && scan.listing_extra);
    return 0;
  }
  const rootEl = documentRootElement(root);
  const input = findShopifyTagsInput(rootEl);
  if (!input) {
    // No input exists until the "+ Add tags" button is clicked to reveal it. Click it, then
    // retry finding the input a few times (React needs a moment to mount it) before giving up.
    const clicked = shopifyRevealTagsInput(rootEl);
    if (!clicked) {
      console.warn("[SyncLyst] Shopify Tags: no input field and no '+ Add tags' button found", tags);
      return 0;
    }
    let attempt = 0;
    const retry = () => {
      attempt++;
      const found = findShopifyTagsInput(rootEl);
      if (found) {
        console.log("[SyncLyst] Shopify Tags: input appeared after reveal click (attempt " + attempt + ")");
        shopifyApplyTagsToInput(found, tags);
        return;
      }
      if (attempt < 8) {
        setTimeout(retry, 250);
      } else {
        console.warn("[SyncLyst] Shopify Tags: input never appeared after clicking '+ Add tags'", tags);
      }
    };
    setTimeout(retry, 250);
    return 1;
  }
  console.log("[SyncLyst] Shopify Tags: found input, attempting to add", tags);
  shopifyApplyTagsToInput(input, tags);
  return 1;
}

function shopifyApplyTagsToInput(input, tags) {
  const container =
    input.closest('[role="combobox"]') ||
    input.closest("form") ||
    input.parentElement?.parentElement ||
    input.parentElement;
  let idx = 0;
  function applyOne(tag, done) {
    input.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, tag);
    else input.value = tag;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data: tag, inputType: "insertText" })
    );
    // Give React time to process the input event before pressing Enter
    setTimeout(() => {
      ["keydown", "keypress", "keyup"].forEach((type) => {
        input.dispatchEvent(
          new KeyboardEvent(type, {
            key: "Enter", code: "Enter", keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true,
          })
        );
      });
      // Also try comma as Shopify accepts comma-separated tags
      input.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: ",", code: "Comma", keyCode: 188, which: 188,
          bubbles: true, cancelable: true, composed: true,
        })
      );
      input.blur();
      if (done) setTimeout(done, 80);
    }, 120);
  }
  function step() {
    if (idx >= tags.length) return;
    const tag = tags[idx++];
    if (shopifyTagsContainerLikelyHasTag(container, tag)) {
      step();
      return;
    }
    applyOne(tag, idx < tags.length ? step : undefined);
  }
  step();
}

function collectShopifyCollectionsForFill(scan) {
  if (!scan || typeof scan !== "object") return [];
  const extra = scan.listing_extra;
  const shopify = extra && (extra.shopify || extra);
  let blob = "";
  if (shopify && typeof shopify.collections === "string") blob = shopify.collections;
  if (!blob.trim()) return [];
  return blob
    .split(/[,;\n]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 25);
}

function findShopifyCollectionsInput(rootEl) {
  const selectors = [
    'input[aria-label*="Collection" i]',
    'input[placeholder*="collection" i]',
    'input[id*="Collection" i]',
    '[data-testid*="collection"] input',
    'div[role="combobox"] input[aria-label*="collection" i]',
  ];
  for (const sel of selectors) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
      return el;
    }
  }
  return null;
}

function shopifyFillCollectionsCombobox(scan, root) {
  const tags = collectShopifyCollectionsForFill(scan);
  if (!tags.length) return 0;
  const rootEl = documentRootElement(root);
  const input = findShopifyCollectionsInput(rootEl);
  if (!input) return 0;
  const container =
    input.closest('[role="combobox"]') ||
    input.closest("form") ||
    input.parentElement?.parentElement ||
    input.parentElement;
  let idx = 0;
  function applyOne(tag) {
    input.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, tag);
    else input.value = tag;
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data: tag, inputType: "insertText" })
    );
    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
    input.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
        composed: true,
      })
    );
  }
  function step() {
    if (idx >= tags.length) return;
    const tag = tags[idx++];
    if (shopifyTagsContainerLikelyHasTag(container, tag)) {
      step();
      return;
    }
    applyOne(tag);
    if (idx < tags.length) setTimeout(step, 120);
  }
  step();
  return 1;
}

/**
 * Generic <select> fill by matching the select's accessible name against `nameRe`, then
 * matching `val` against its <option> values/text (exact match first, then case-insensitive
 * substring). Shopify's newer Admin renders Type/Vendor as real <select> elements (visible as
 * a chevron-style dropdown), which the input-only search in shopifyFillProductTypeField/the
 * Vendor tryOne() selectors never considered.
 */
function shopifyFillSelectByLabel(rootEl, nameRe, val, logLabel) {
  const str = String(val || "").trim();
  if (!str) return false;
  const strLower = str.toLowerCase();
  let nodes;
  try {
    nodes = querySelectorAllDeep("select", rootEl);
  } catch {
    return false;
  }
  for (const sel of nodes) {
    if (!(sel instanceof HTMLSelectElement) || !isVisible(sel) || sel.disabled) continue;
    const nl = shopifyControlAccessibleName(sel).toLowerCase();
    if (!nameRe.test(nl)) continue;
    const options = Array.from(sel.options || []);
    let opt = options.find((o) => String(o.value).trim().toLowerCase() === strLower || String(o.textContent || "").trim().toLowerCase() === strLower);
    if (!opt) {
      opt = options.find((o) => {
        const t = String(o.textContent || "").trim().toLowerCase();
        return t && (t.includes(strLower) || strLower.includes(t));
      });
    }
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      console.log("[SyncLyst] Shopify " + (logLabel || "select") + ": matched <select> option '" + opt.textContent.trim() + "' for value '" + str + "'");
      return true;
    }
    console.warn(
      "[SyncLyst] Shopify " + (logLabel || "select") + ": found <select> (name='" + nl + "') but no option matched '" + str + "'. Available options:",
      options.map((o) => o.textContent.trim())
    );
  }
  return false;
}

function tryShopifyWeightUnitSelect(rootEl, unit) {
  const u = String(unit || "")
    .trim()
    .toLowerCase();
  if (!u) return false;
  let nodes;
  try {
    nodes = querySelectorAllDeep(
      'select[name="weightUnit"], select[name*="weight" i][name*="unit" i], select[aria-label*="Weight unit" i], select[aria-label*="weight" i]',
      rootEl
    );
  } catch {
    return false;
  }
  for (const sel of nodes) {
    if (!(sel instanceof HTMLSelectElement) || !isVisible(sel)) continue;
    const opt = Array.from(sel.options).find(
      (o) =>
        String(o.value).toLowerCase() === u ||
        String(o.textContent || "")
          .trim()
          .toLowerCase() === u
    );
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    }
  }
  return false;
}

function fillShopifyMetafieldInputs(s, rootEl) {
  const mf = s.metafields;
  if (!mf || typeof mf !== "object" || Array.isArray(mf)) return 0;
  let n = 0;
  let cards;
  try {
    cards = querySelectorAllDeep("div, section, article", rootEl);
  } catch {
    return 0;
  }
  const metafieldCards = [];
  for (const card of cards) {
    const head = (card.textContent || "").slice(0, 500);
    if (!/metafield/i.test(head)) continue;
    metafieldCards.push(card);
  }
  if (!metafieldCards.length) return 0;

  for (const [label, val] of Object.entries(mf)) {
    const str = String(val || "").trim();
    if (!str) continue;
    const hint = label.trim().toLowerCase().slice(0, 40);
    if (!hint) continue;
    outer: for (const card of metafieldCards) {
      const inputs = card.querySelectorAll(
        'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea'
      );
      for (const el of inputs) {
        if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) continue;
        if (!isVisible(el) || el.readOnly) continue;
        if ((el.value || "").trim()) continue;
        const row = el.closest("div");
        const rowText = ((row && row.textContent) || "").toLowerCase();
        const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
        if (!rowText.includes(hint) && !al.includes(hint)) continue;
        if (fillField(el, str)) {
          n++;
          break outer;
        }
      }
    }
  }
  return n;
}

/**
 * Vinted category is a hierarchical picker (“Select a category” → Women → … → leaf), not a plain text field.
 * Progressive state lives on `window` so repeated fill ticks (SPA) can open once then click one level per pass.
 */
function vintedNormCat(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function vintedParseCategorySegments(raw) {
  const s = String(raw || "").trim();
  if (!s) return [];
  return s
    .split(/(?:\s*>\s*|\s*›\s*|\s*»\s*|\s*→\s*|\s*\|\s*)/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function vintedScoreSegmentToOption(segNorm, optNorm) {
  if (!segNorm || !optNorm) return 0;
  if (segNorm === optNorm) return 100;
  if (optNorm.startsWith(segNorm + " ") || optNorm === segNorm) return 98;
  if (optNorm.startsWith(segNorm)) return 90;
  if (segNorm.startsWith(optNorm) && optNorm.length >= 3) return 88;
  if (optNorm.includes(segNorm)) return 76;
  if (segNorm.includes(optNorm) && optNorm.length >= 4) return 66;
  const sw = new Set(segNorm.split(/\s+/).filter((x) => x.length > 2));
  const ow = new Set(optNorm.split(/\s+/).filter((x) => x.length > 2));
  let overlap = 0;
  for (const w of sw) {
    if (ow.has(w)) overlap += 1;
  }
  if (overlap >= 2 && sw.size <= 5) return 63;
  if (overlap === 1 && sw.size === 1) return 58;
  return 0;
}

/** Lines + breadcrumb crumbs for matching a segment to a Suggested row or catalogue item. */
function vintedOptionTextVariants(full) {
  const t = String(full || "").replace(/\s+/g, " ").trim();
  if (!t.length) return [];
  const out = [];
  const seen = new Set();
  const push = (s) => {
    const x = String(s || "").trim();
    if (!x || seen.has(x)) return;
    seen.add(x);
    out.push(x);
  };
  push(t);
  const lines = t.split(/\n/).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) push(line);
  if (/[>›»→|]/.test(t)) {
    const parts = t.split(/[>›»→|]+/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) push(p);
  }
  return out;
}

function vintedBestScoreForSegment(segNorm, fullText) {
  let best = 0;
  for (const variant of vintedOptionTextVariants(fullText)) {
    const sc = vintedScoreSegmentToOption(segNorm, vintedNormCat(variant));
    if (sc > best) best = sc;
  }
  return best;
}

/** Locate "Suggested" / "Catalogue sections" headings (Vinted EN) to prefer suggested rows. */
function vintedFindSuggestedCatalogueMarkers(dialog) {
  let suggested = null;
  let catalogue = null;
  try {
    for (const el of querySelectorAllDeep(
      "h1, h2, h3, h4, h5, h6, p, span, [role='heading'], label, div",
      dialog
    )) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 2, 2)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (raw.length > 72) continue;
      if (!suggested && /^\s*suggested\b/i.test(raw) && !/catalogue/i.test(raw)) suggested = el;
      if (!catalogue && /catalogue sections|catalog sections/i.test(raw)) catalogue = el;
      if (suggested && catalogue) break;
    }
  } catch {
    /* ignore */
  }
  return { suggested, catalogue };
}

function vintedIsInSuggestedSection(el, markers) {
  const { suggested, catalogue } = markers || {};
  if (!(el instanceof HTMLElement)) return false;
  try {
    if (suggested) {
      if (suggested.contains(el)) return true;
      const afterS = (suggested.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      if (!afterS) return false;
      if (catalogue) {
        return (el.compareDocumentPosition(catalogue) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }
      return true;
    }
  } catch {
    return false;
  }
  /** Marker not found (shadow DOM / i18n) — treat compact “Print t-shirts” + breadcrumb rows as Suggested. */
  const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
  if (tx.length > 260) return false;
  if (/\bprint\b.*t-?shirt|print\s+t-?shirts?/.test(tx) && /[>›»→|]/.test(tx)) return true;
  return false;
}

/** True when a Suggested row’s text includes the breadcrumb path (e.g. Men > … > T-shirts). */
function vintedSuggestedRowCompletesCategory(txt, segments) {
  const t = String(txt || "").replace(/\s+/g, " ").trim();
  if (!t || !segments || segments.length < 2) return false;
  if (!/[>›»→|]/.test(t) && !/\s>\s/.test(t)) return false;
  const blob = t.toLowerCase();
  let hit = 0;
  for (const seg of segments) {
    const n = vintedNormCat(seg);
    if (n.length < 2) continue;
    if (blob.includes(n)) hit++;
    else if (vintedBestScoreForSegment(n, t) >= 70) hit++;
  }
  const last = vintedNormCat(segments[segments.length - 1]);
  if (last.length > 1 && (blob.includes(last) || vintedBestScoreForSegment(last, t) >= 65)) hit++;
  return hit >= Math.min(segments.length, 5);
}

function vintedGetCategoryRowDisplayText(rootEl) {
  try {
    let best = "";
    let bestLen = 0;
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], div[tabindex="0"], span[tabindex="0"]',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const row = el.closest("div, li, section, fieldset");
      if (!row || !/\bcategory\b/i.test((row.textContent || "").slice(0, 220))) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || /^select a category$/i.test(t) || /^choose a category$/i.test(t)) continue;
      if (/^category$/i.test(t)) continue;
      if (t.length > bestLen && t.length < 160) {
        best = t;
        bestLen = t.length;
      }
    }
    return best;
  } catch {
    /* ignore */
  }
  return "";
}

function vintedDisplayedCategoryMatchesTarget(shown, targetRaw) {
  const disp = vintedNormCat(shown);
  const tgtFull = vintedNormCat(String(targetRaw || "").replace(/\s*[>›»→|]\s*/g, " > "));
  if (!disp || !tgtFull) return false;
  if (disp === tgtFull) return true;
  if (tgtFull.includes(disp) || disp.includes(tgtFull)) return true;
  const segs = vintedParseCategorySegments(targetRaw);
  if (!segs.length) return false;
  const last = vintedNormCat(segs[segs.length - 1]);
  if (last && (disp === last || disp.includes(last) || last.includes(disp))) return true;
  const dispCrumbs = disp.split(/\s*>\s*/).map((x) => x.trim()).filter(Boolean);
  for (const s of segs) {
    const n = vintedNormCat(s);
    if (n && dispCrumbs.some((c) => c === n || c.includes(n) || n.includes(c))) return true;
  }
  return false;
}

function vintedMaybeSubmitCategorySearch(searchInp, win) {
  if (!(searchInp instanceof HTMLInputElement) || !win) return;
  try {
    searchInp.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
    );
    searchInp.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true })
    );
  } catch {
    /* ignore */
  }
}

/** Text / structure score only — used for role=dialog surfaces and for anchored panels (no 80×60 layout gate). */
function vintedCatalogPickerPanelTextScore(el) {
  if (!(el instanceof HTMLElement)) return 0;
  const s = (el.textContent || "").slice(0, 1400);
  const sl = s.toLowerCase();
  if (/log in|sign up|cookie settings|newsletter/i.test(sl) && !/\bwomen\b|\bmen\b|\bkids\b/i.test(sl)) return 0;
  let sc = 0;
  if (/\bWomen\b/.test(s) && /\bMen\b/.test(s)) sc += 42;
  else if (/\bWomen\b/.test(s) || /\bMen\b/.test(s)) sc += 22;
  if (/\bKids\b/.test(s)) sc += 12;
  if (/\bDesigner\b/.test(s)) sc += 10;
  if (/search categories|find a category|type to search|search for a category/i.test(sl)) sc += 34;
  if (/\bsuggested\b/i.test(sl)) sc += 18;
  if (/catalogue sections|catalog sections/i.test(sl)) sc += 18;
  try {
    if (el.querySelector('[role="listbox"], [role="list"], [role="grid"] ul, ul li')) sc += 22;
  } catch {
    /* ignore */
  }
  return sc;
}

function vintedDialogLooksLikeCatalogPicker(el) {
  if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 80, 60)) return 0;
  return vintedCatalogPickerPanelTextScore(el);
}

function vintedAnchoredPickerSurfaceScore(el) {
  if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 44, 44)) return 0;
  return vintedCatalogPickerPanelTextScore(el);
}

/** Vinted’s category sheet is not always `[role=dialog]`; anchor from the “Find a category” search field. */
function vintedCatalogPickerSurfaceFromSearchInput(doc) {
  const d = doc && doc.body ? doc : typeof document !== "undefined" ? document : null;
  if (!d || !d.body) return null;
  let best = null;
  let bestSc = 0;
  try {
    let inputs = querySelectorAllDeep(
      'input[placeholder*="Find a category" i], input[placeholder*="find a category" i]',
      d.body
    );
    if (!inputs.length) {
      inputs = querySelectorAllDeep('input[type="search"], input[placeholder*="categor" i]', d.body);
    }
    for (const inp of inputs) {
      if (!(inp instanceof HTMLInputElement)) continue;
      const ty = (inp.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file" || inp.disabled) continue;
      const ph = (inp.getAttribute("placeholder") || "").toLowerCase();
      if (!/\b(find a category|categor|search)\b/.test(ph) && ty !== "search") continue;
      let p = inp.parentElement;
      for (let depth = 0; depth < 22 && p instanceof HTMLElement; depth++) {
        if (p === d.body || p === d.documentElement) break;
        const sc = vintedAnchoredPickerSurfaceScore(p);
        if (sc > bestSc) {
          bestSc = sc;
          best = p;
        }
        p = p.parentElement;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 26 ? best : null;
}

function vintedBodyLooksLikeCategoryPickerOpen(doc) {
  try {
    const d = doc && doc.body ? doc : typeof document !== "undefined" ? document : null;
    if (!d || !d.body) return false;
    const sl = (d.body.innerText || d.body.textContent || "").replace(/\s+/g, " ").slice(0, 4200).toLowerCase();
    const hasFind = /find a category|search categories|search for a category|type to search/i.test(sl);
    const hasSheetHint =
      /\bsuggested\b/i.test(sl) ||
      /catalogue sections|catalog sections/i.test(sl) ||
      ((/\bwomen\b.*\bmen\b|\bmen\b.*\bwomen\b/).test(sl) && /\bcategor/i.test(sl));
    return hasFind && hasSheetHint;
  } catch {
    return false;
  }
}

function vintedFindCategoryPickerSurface() {
  let best = null;
  let bestSc = 0;
  try {
    const seen = new Set();
    const roots = [];
    if (document.body) roots.push(document.body);
    if (document.documentElement) roots.push(document.documentElement);
    for (const root of roots) {
      for (const el of querySelectorAllDeep('[role="dialog"], [aria-modal="true"]', root)) {
        if (seen.has(el)) continue;
        seen.add(el);
        const sc = vintedDialogLooksLikeCatalogPicker(el);
        if (sc > bestSc) {
          bestSc = sc;
          best = el;
        }
      }
    }
    const anchored = vintedCatalogPickerSurfaceFromSearchInput(document);
    if (anchored) {
      const sc = vintedAnchoredPickerSurfaceScore(anchored);
      if (sc > bestSc) {
        bestSc = sc;
        best = anchored;
      }
    }
  } catch {
    /* ignore */
  }
  const relaxed = vintedBodyLooksLikeCategoryPickerOpen(typeof document !== "undefined" ? document : null);
  const threshold = relaxed ? 15 : 18;
  return bestSc >= threshold ? best : null;
}

function vintedFindCategoryTrigger(rootEl) {
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], [role="listbox"], div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      const t = rawT.toLowerCase();
      let sc = 0;
      if (t === "select a category" || /\bselect a category\b/i.test(rawT)) sc += 110;
      if (t === "choose a category" || /\bchoose a category\b/i.test(rawT)) sc += 110;
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (al.includes("category") && !al.includes("subcategory")) sc += 55;
      const dt = (el.getAttribute("data-testid") || "").toLowerCase();
      if (dt.includes("categor") && !dt.includes("subcategor")) sc += 48;
      const row = el.closest("div, li, section, fieldset, form");
      const rowHead = row ? (row.textContent || "").slice(0, 220) : "";
      if (row && /\bcategory\b/i.test(rowHead)) {
        sc += 45;
        if (
          rawT.length > 2 &&
          !/^select a category$/i.test(rawT) &&
          !/^choose a category$/i.test(rawT) &&
          !/^category$/i.test(rawT)
        ) {
          sc += 46;
        }
      }
      if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("aria-expanded") === "false") sc += 8;
      if (el.getAttribute("role") === "combobox") sc += 14;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 58 ? best : null;
}

function vintedFindBrandTrigger(rootEl) {
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], [role="listbox"], div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      const t = rawT.toLowerCase();
      let sc = 0;
      if (t === "select a brand" || /\bselect a brand\b/i.test(rawT)) sc += 110;
      if (/\bchoose a brand\b/i.test(rawT)) sc += 100;
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (/\bbrand\b/.test(al) && !/\bsubbrand\b/.test(al)) sc += 55;
      const dt = (el.getAttribute("data-testid") || "").toLowerCase();
      if (dt.includes("brand") && !dt.includes("subbrand")) sc += 48;
      const row = el.closest("div, li, section, fieldset, form");
      const rowHead = row ? (row.textContent || "").slice(0, 220) : "";
      if (row && /\bbrand\b/i.test(rowHead)) {
        sc += 45;
        if (/fill in brand|select a brand|choose a brand/i.test(rowHead)) sc += 28;
        if (rawT.length > 2 && !/^select a brand$/i.test(rawT) && !/^brand$/i.test(rawT)) sc += 38;
      }
      if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("aria-expanded") === "false") sc += 8;
      if (el.getAttribute("role") === "combobox") sc += 14;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 52 ? best : null;
}

/** Brand picker / list surface — avoid the “Find a category” sheet. */
function vintedFindBrandPickerSurface() {
  let best = null;
  let bestSc = 0;
  const noBrandBlob =
    /\bno\s*brand\b|\bwithout\s*brand\b|\bunbranded\b|\bgeen\s*merk\b|\bsans\s+marque\b|\bsin\s+marca\b|\bsem\s+marca\b|\bkeine\s+marke\b|\bbez\s+marki\b|\bbez\s+znacky\b|\bother\s+brands?\b/i;
  try {
    for (const el of querySelectorAllDeep('[role="dialog"], [aria-modal="true"], [role="listbox"]', document.body)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 1200).toLowerCase();
      if (/find a category|search categories|catalogue sections/i.test(tx) && !/\bbrand\b/.test(tx.slice(0, 400)))
        continue;
      let sc = 0;
      if (/\bbrand\b/.test(tx)) sc += 48;
      if (/search.*brand|brand.*search|type to find|find brands/i.test(tx)) sc += 32;
      if (/\bunbranded|no label|without label|other brands/i.test(tx)) sc += 18;
      if (noBrandBlob.test(tx)) sc += 52;
      try {
        let p = el;
        for (let d = 0; d < 12 && p instanceof HTMLElement; d++, p = p.parentElement) {
          const tid = (p.getAttribute("data-testid") || "").toLowerCase();
          if (/\bbrand\b/.test(tid) && !/\bsubbrand\b/.test(tid)) {
            sc += 40;
            break;
          }
        }
      } catch {
        /* ignore */
      }
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 30 ? best : null;
}

function vintedNormalizeBrandMatchToken(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[''’`]/g, "")
    .replace(/[^a-z0-9\s-]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function vintedFindBrandSearchInput(surface) {
  const roots = [];
  if (surface instanceof HTMLElement) roots.push(surface);
  if (document.body) roots.push(document.body);
  for (const root of roots) {
    try {
      for (const el of querySelectorAllDeep("input", root)) {
        if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
        const ty = (el.type || "").toLowerCase();
        if (ty === "hidden" || ty === "radio" || ty === "checkbox" || ty === "file") continue;
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const al = shopifyControlAccessibleName(el).toLowerCase();
        const blob = `${ph} ${al}`;
        if (/\bbrand\b/.test(blob) && /\bsearch|find|type\b/.test(blob)) return el;
        if (ty === "search" && /\bbrand\b/.test(blob)) return el;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function vintedClickMatchingBrandOption(want, surface, exactOnly) {
  const w = vintedNormalizeBrandMatchToken(want);
  if (!w || w.length < 2) return false;
  const scanRoot = surface instanceof HTMLElement ? surface : document.body;
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], li[role="option"], li, label, button[type="button"], div[role="button"], [data-testid*="brand" i]',
      scanRoot
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (raw.length < 2 || raw.length > 140) continue;
      const n = vintedNormalizeBrandMatchToken(raw);
      let sc = 0;
      if (n === w) sc = 200;
      else if (!exactOnly) {
        if (n.includes(w) || w.includes(n)) sc = 130;
        else if (w.split(/\s+/).filter((p) => p.length > 1).every((part) => n.includes(part))) sc = 85;
      }
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    const min = exactOnly ? 200 : 85;
    if (best && bestSc >= min) {
      try {
        const win = (best.ownerDocument && best.ownerDocument.defaultView) || window;
        best.scrollIntoView({ block: "nearest", behavior: "auto" });
        try {
          best.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: win, pointerId: 1 }));
          best.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: win, pointerId: 1 }));
        } catch {
          /* ignore */
        }
        best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
        best.click();
        best.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win }));
        best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedCloseActivePicker(kindHint) {
  try {
    // Try Escape first (many Vinted sheets close on Esc).
    try {
      const ae = document.activeElement;
      if (ae && ae.dispatchEvent) {
        ae.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
        ae.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      }
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    } catch {
      /* ignore */
    }
    const hint = String(kindHint || "").toLowerCase();
    const isColourHint = hint === "colour" || hint === "color" || /\bcolou?r/.test(hint);
    const isSizeHint = hint === "size";
    // Vinted uses different “sheet” implementations; not all are real ARIA dialogs.
    let dlg = null;
    if (isColourHint) {
      dlg = vintedFindColourPickerSurface();
    } else if (isSizeHint) {
      dlg = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface();
    }
    const dialogSelector =
      '[role="dialog"], [aria-modal="true"], [data-testid*="bottom" i], [data-testid*="sheet" i], .BottomSheet, .bottomSheet, .sheet' +
      (isColourHint || isSizeHint ? ', [role="listbox"]' : "");
    const dialogs = querySelectorAllDeep(dialogSelector, document.body);
    let best = null;
    let bestSc = 0;
    const colourWord = /\bcolou?rs?\b|\bcolors?\b/;
    for (const el of dialogs) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 1600).toLowerCase();
      let sc = 0;
      if (hint) {
        if (isColourHint) {
          if (colourWord.test(tx)) sc += 40;
        } else if (isSizeHint) {
          if (/\bsize\b/.test(tx) && !/\bparcel\b|\bpackage size\b|\bpostage\b/i.test(tx.slice(0, 520))) sc += 40;
        } else if (tx.includes(hint)) {
          sc += 40;
        }
      }
      if (/\bselect\b|\bchoose\b|\bsearch\b/.test(tx)) sc += 10;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (!dlg && best && (!isColourHint || bestSc >= 30)) dlg = best;
    if (!dlg) {
      if (isColourHint) {
        try {
          const t = vintedFindColourTrigger(document.body);
          if (t instanceof HTMLElement && t.getAttribute("aria-expanded") === "true") {
            t.scrollIntoView({ block: "nearest", behavior: "auto" });
            t.click();
            t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            return true;
          }
        } catch {
          /* ignore */
        }
      } else if (isSizeHint) {
        try {
          const t = vintedFindSizeTrigger(document.body);
          if (t instanceof HTMLElement && t.getAttribute("aria-expanded") === "true") {
            t.scrollIntoView({ block: "nearest", behavior: "auto" });
            t.click();
            t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
            return true;
          }
        } catch {
          /* ignore */
        }
      }
      return false;
    }
    // Prefer explicit confirmation buttons some sheets require.
    const btns = Array.from(dlg.querySelectorAll("button")).filter((b) => b instanceof HTMLElement);
    const byText = (re) =>
      btns.find((b) => re.test(((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase()));
    const doneBtn =
      byText(/\b(done|apply|save|confirm|continue)\b/) ||
      null;
    if (doneBtn instanceof HTMLElement && vintedLayoutInteractable(doneBtn, 4, 4)) {
      doneBtn.click();
      return true;
    }

    const closeBtn =
      dlg.querySelector('button[aria-label*="close" i], button[title*="close" i], button[data-testid*="close" i]') ||
      dlg.querySelector('button[aria-label*="back" i], button[title*="back" i], button[data-testid*="back" i]') ||
      null;
    if (closeBtn instanceof HTMLElement && vintedLayoutInteractable(closeBtn, 4, 4)) {
      closeBtn.click();
      return true;
    }

    // Some sheets use an icon-only button without labels. Prefer a small button near top-right.
    try {
      const btns2 = Array.from(dlg.querySelectorAll("button")).filter(
        (b) => b instanceof HTMLElement && vintedLayoutInteractable(b, 10, 10)
      );
      let bestIconBtn = null;
      let bestIconSc = 0;
      for (const b of btns2) {
        const t = ((b.textContent || "") + " " + (b.getAttribute("aria-label") || "")).trim().toLowerCase();
        if (t) continue; // icon-only
        const r = b.getBoundingClientRect();
        // top bar-ish + right-ish
        if (r.top < 140 && r.right > window.innerWidth - 120) {
          let sc = 10;
          if (b.querySelector("svg, path")) sc += 10;
          if (r.width <= 56 && r.height <= 56) sc += 6;
          if (sc > bestIconSc) {
            bestIconSc = sc;
            bestIconBtn = b;
          }
        }
      }
      if (bestIconBtn instanceof HTMLElement && bestIconSc >= 16) {
        bestIconBtn.click();
        return true;
      }
    } catch {
      /* ignore */
    }

    // Last resort: click outside the dialog (overlay/backdrop) to dismiss.
    try {
      const rect = dlg.getBoundingClientRect();
      const pts = [
        [Math.max(2, Math.min(window.innerWidth - 2, rect.left - 10)), Math.max(2, Math.min(window.innerHeight - 2, rect.top + 10))],
      ];
      if ((isColourHint || isSizeHint) && rect.top > 48) {
        pts.push([Math.floor(window.innerWidth / 2), Math.max(4, Math.floor(rect.top) - 28)]);
      }
      for (const [x, y] of pts) {
        document.elementFromPoint(x, y)?.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
        );
      }
      return true;
    } catch {
      /* ignore */
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedBrandMeansNoBrand(brandRaw) {
  const t = vintedNormalizeBrandMatchToken(brandRaw);
  if (!t) return true;
  if (t === "no brand" || t === "nobrand") return true;
  if (t === "unbranded" || t === "no label" || t === "without brand") return true;
  if (t === "unknown" || t === "none" || t === "n a" || t === "na" || t === "-" || t === "n/a") return true;
  if (t === "sans marque" || t === "sin marca" || t === "sem marca") return true;
  if (t === "geen merk" || t === "keine marke" || t === "bez marki" || t === "bez znacky") return true;
  return false;
}

function vintedBrandRowShowsRequiredError(rootEl) {
  try {
    const page = (rootEl && rootEl.textContent ? String(rootEl.textContent) : "").toLowerCase();
    if (page.includes("fill in brand to continue")) return true;
  } catch {
    /* ignore */
  }
  try {
    for (const el of querySelectorAllDeep('button, [role="button"], [role="combobox"], div, span, p', rootEl)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const row = el.closest("div, li, section, fieldset");
      if (!row || !/\bbrand\b/i.test((row.textContent || "").slice(0, 260))) continue;
      const rh = (row.textContent || "").slice(0, 900).toLowerCase();
      if (/fill in brand to continue|this field is required|please select|required/i.test(rh)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Vinted Brand is a combobox/sheet, not a plain text input — open, search, then pick a row.
 */
function vintedFillBrandDropdown(rootEl, brandRaw) {
  let want = brandRaw != null ? String(brandRaw).trim() : "";
  if (vintedBrandMeansNoBrand(want)) want = "";
  // If brand is missing but the field is required, pick "No brand" / "Unbranded" from the picker.
  // Caller may pass empty string; we treat that as "unknown brand".
  const neg = ["feedback", "search the help", "coupon", "promo"];
  // Note: typing is not enough for Vinted — must click an option from the picker to clear validation.
  if (want) {
    try {
      vintedFillByHints(rootEl, ["brand"], neg, want);
    } catch {
      /* ignore */
    }
  }

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return false;
  const trig = vintedFindBrandTrigger(rootEl);
  if (!trig) return false;
  try {
    trig.scrollIntoView({ block: "nearest", behavior: "auto" });
    trig.focus();
    trig.click();
    trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
  } catch {
    return false;
  }

  const tryPick = () => {
    let surface = vintedFindBrandPickerSurface();
    const inp = vintedFindBrandSearchInput(surface) || vintedFindBrandSearchInput(document.body);
    if (inp && want) fillField(inp, want);
    const clickRoot = surface || document.body;
    // Real brands must be an exact match from the list; otherwise pick "No brand".
    if (want && vintedClickMatchingBrandOption(want, clickRoot, true)) {
      setTimeout(() => vintedCloseActivePicker("brand"), 120);
      return true;
    }
    // If we typed an invalid brand (e.g. band name), clear search so fallback options appear.
    try {
      if (inp instanceof HTMLInputElement) fillField(inp, "");
    } catch {
      /* ignore */
    }
    for (const fb of [
      "No brand",
      "Unbranded",
      "No label",
      "Without brand",
      "Other",
      "Unknown",
      // Common locale variants (Latin script) — normalization handles accents reasonably.
      "Sans marque",
      "Sin marca",
      "Sem marca",
      "Keine Marke",
      "Geen merk",
      "Bez marki",
      "Bez značky",
    ]) {
      try {
        if (inp instanceof HTMLInputElement) fillField(inp, fb);
      } catch {
        /* ignore */
      }
      if (vintedClickMatchingBrandOption(fb, clickRoot, false)) {
        setTimeout(() => vintedCloseActivePicker("brand"), 120);
        return true;
      }
    }
    return false;
  };

  if (tryPick()) return true;
  [80, 200, 450].forEach((ms) => {
    setTimeout(tryPick, ms);
  });

  // If Brand is still required, show a one-click assist (trusted click) like Size.
  const showBrandAssist = () => {
    try {
      if (!vintedBrandRowShowsRequiredError(rootEl)) return;
      const surface = vintedFindBrandPickerSurface() || document.body;
      const inp = vintedFindBrandSearchInput(surface) || vintedFindBrandSearchInput(document.body);
      const wantLabel = want || "No brand";
      if (inp instanceof HTMLInputElement) {
        fillField(inp, wantLabel);
      }
      const re = want
        ? new RegExp(`\\b${String(want).toLowerCase().replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\b`, "i")
        : /\b(no\s*brand|without\s*brand|unbranded|no\s*label|other|unknown)\b/i;
      const host = vintedFindBestClickableOptionHostByText(surface, re) || null;
      if (host) {
        vintedAssistHighlightOnce(
          host,
          `Vinted needs a real click. Please click <b>${want ? want : "No brand"}</b> in the dropdown to clear the red error.`
        );
      } else {
        vintedShowAssistToast(
          `Vinted needs a real click. Please click <b>${want ? want : "No brand"}</b> in the dropdown to clear the red error.`,
          null
        );
      }
    } catch {
      /* ignore */
    }
  };
  [900, 2200, 4200].forEach((ms) => setTimeout(showBrandAssist, ms));
  return true;
}

function vintedResolveColourList(colsRaw) {
  if (colsRaw == null) return [];
  if (Array.isArray(colsRaw)) {
    return colsRaw
      .map((x) => String(x).trim())
      .filter(Boolean)
      .slice(0, 2);
  }
  const s = String(colsRaw).trim();
  if (!s) return [];
  const parts = s.split(/[,;/|]+/).map((x) => x.trim()).filter(Boolean);
  if (parts.length) return parts.slice(0, 2);
  return [s].slice(0, 2);
}

/**
 * Vinted requires at least one colour (often two). Vision sometimes omits `listing_extra.vinted.colours` —
 * fall back to Shopify colours, text heuristics, then safe defaults so validation never stays red.
 */
function resolveVintedColoursForFill(scan, v) {
  const raw = v.colours != null ? v.colours : v.colors != null ? v.colors : v.color;
  let list = vintedResolveColourList(raw);
  if (list.length) return list;
  try {
    const le = scan && typeof scan === "object" && scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : null;
    const sh = le && le.shopify && typeof le.shopify === "object" ? le.shopify : null;
    if (sh) {
      const c = sh.colors ?? sh.colours ?? sh.color;
      list = vintedResolveColourList(c);
      if (list.length) return list;
    }
  } catch {
    /* ignore */
  }
  try {
    const blob = `${String((scan && scan.title) || "")} ${String((scan && scan.description) || "")}`.toLowerCase();
    const pairs = [
      ["black", "Black"],
      ["navy", "Navy"],
      ["white", "White"],
      ["burgundy", "Burgundy"],
      ["beige", "Beige"],
      ["brown", "Brown"],
      ["cream", "Cream"],
      ["grey", "Grey"],
      ["gray", "Grey"],
      ["charcoal", "Grey"],
      ["red", "Red"],
      ["blue", "Blue"],
      ["green", "Green"],
      ["yellow", "Yellow"],
      ["pink", "Pink"],
      ["orange", "Orange"],
      ["purple", "Purple"],
      ["multicolour", "Multicolor"],
      ["multi-colour", "Multicolor"],
      ["multicolor", "Multicolor"],
    ];
    const found = [];
    for (const [needle, label] of pairs) {
      if (blob.includes(needle) && !found.some((x) => String(x).toLowerCase() === label.toLowerCase())) {
        found.push(label);
        if (found.length >= 2) break;
      }
    }
    if (found.length) return found;
  } catch {
    /* ignore */
  }
  return ["Black", "Grey"];
}

function vintedFindColourTrigger(rootEl) {
  // Vinted (2026) explicit colours dropdown input
  try {
    const direct =
      rootEl.querySelector &&
      rootEl.querySelector('input[data-testid*="colour"][data-testid*="dropdown-input" i], input[data-testid*="color"][data-testid*="dropdown-input" i]');
    if (direct instanceof HTMLElement && vintedLayoutInteractable(direct, 4, 4)) return direct;
  } catch {
    /* ignore */
  }
  try {
    for (const el of querySelectorAllDeep("input", rootEl)) {
      if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const al = shopifyControlAccessibleName(el).toLowerCase();
      const blob = `${ph} ${al}`;
      if (/\bselect up to 2 colou?rs?\b/i.test(ph) || /\bselect up to 2 colou?rs?\b/i.test(blob)) return el;
      if (/\bcolou?rs?\b/.test(blob) && /\bselect\b/.test(blob)) return el;
    }
  } catch {
    /* ignore */
  }
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], [role="listbox"], div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      const t = rawT.toLowerCase();
      let sc = 0;
      if (/\bselect up to 2 colou?rs?\b/i.test(rawT)) sc += 115;
      if (/\bselect colou?rs?\b/i.test(rawT)) sc += 100;
      if (/\bchoose colou?rs?\b/i.test(rawT)) sc += 98;
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (/\bcolou?r\b/.test(al) && !/\btext\b|\btitle\b|\bfont\b/.test(al)) sc += 52;
      const dt = (el.getAttribute("data-testid") || "").toLowerCase();
      if (/\bcolou?r\b/.test(dt)) sc += 48;
      const row = el.closest("div, li, section, fieldset, form");
      const rowHead = row ? (row.textContent || "").slice(0, 240) : "";
      if (row && /\bcolou?rs?\b/i.test(rowHead)) {
        sc += 46;
        if (/fill in colou|select.*colou|up to 2 colou/i.test(rowHead)) sc += 28;
        if (
          rawT.length > 2 &&
          !/^select up to 2 colou?rs?$/i.test(rawT) &&
          !/^colou?rs?$/i.test(rawT)
        ) {
          sc += 30;
        }
      }
      if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("aria-expanded") === "false") sc += 8;
      if (el.getAttribute("role") === "combobox") sc += 12;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 48 ? best : null;
}

/** Find the Colours row container (for chevron-style UIs). */
function vintedFindColoursRow(rootEl) {
  try {
    const nodes = querySelectorAllDeep("div, li, section, fieldset, form, article", rootEl);
    let best = null;
    let bestSc = 0;
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 18)) continue;
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx) continue;
      const head = tx.slice(0, 260).toLowerCase();
      if (!/\bcolou?rs?\b|\bcolors?\b/.test(head)) continue;
      if (!/select up to 2|select|choose|fill in colou|to continue|required/i.test(head)) continue;
      let sc = 0;
      if (/fill in colou|to continue|required/i.test(head)) sc += 80;
      if (/select up to 2/.test(head)) sc += 60;
      // Prefer tighter rows, not entire page
      sc += Math.max(0, 1200 - tx.length) / 40;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    return bestSc >= 40 ? best : null;
  } catch {
    return null;
  }
}

/** Click the Colours row trigger (chevron / row button), returning true if we likely opened something. */
function vintedClickColoursRowTrigger(rootEl) {
  const row = vintedFindColoursRow(rootEl);
  if (!row) return false;
  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  const clicky = (el) => {
    if (!(el instanceof HTMLElement)) return false;
    if (!vintedLayoutInteractable(el, 8, 8)) return false;
    try {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      el.focus();
    } catch {
      /* ignore */
    }
    try {
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win || window }));
    } catch {
      /* ignore */
    }
    try {
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win || window }));
      return true;
    } catch {
      return false;
    }
  };
  // Prefer explicit combobox/button inside row
  try {
    const inner = row.querySelector(
      'input, button, [role="button"], [role="combobox"], [aria-haspopup="listbox"], [aria-expanded]'
    );
    if (clicky(inner)) return true;
  } catch {
    /* ignore */
  }
  // Otherwise click the row itself
  return clicky(row);
}

function vintedFindColourPickerSurface() {
  let best = null;
  let bestSc = 0;
  const colourWord = /\bcolou?rs?\b|\bcolors?\b/;
  const colourSearchBlob = /search.*colou|colou.*search|pick.*colou|type to find|search.*color|color.*search/i;
  try {
    for (const el of querySelectorAllDeep('[role="dialog"], [aria-modal="true"], [role="listbox"]', document.body)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 1200).toLowerCase();
      if (
        /find a category|catalogue sections|search categories/i.test(tx) &&
        !colourWord.test(tx.slice(0, 500))
      ) {
        continue;
      }
      if (/\bbrand\b/.test(tx) && !colourWord.test(tx.slice(0, 400))) continue;
      let sc = 0;
      if (colourWord.test(tx)) sc += 52;
      if (colourSearchBlob.test(tx)) sc += 30;
      try {
        let p = el;
        for (let d = 0; d < 10 && p instanceof HTMLElement; d++, p = p.parentElement) {
          const tid = (p.getAttribute("data-testid") || "").toLowerCase();
          if (/\bcolou?r|\bcolors?\b/.test(tid)) {
            sc += 44;
            break;
          }
        }
      } catch {
        /* ignore */
      }
      try {
        const cbs = el.querySelectorAll("input[type='checkbox']");
        if (cbs.length >= 3 && cbs.length <= 80) {
          const labels = el.querySelectorAll("label");
          if (labels.length >= 3) {
            let short = 0;
            for (const lb of labels) {
              const L = ((lb.textContent || "").replace(/\s+/g, " ").trim().length || 99);
              if (L > 1 && L <= 28) short++;
            }
            if (short >= Math.min(labels.length, cbs.length) * 0.55) sc += 36;
          }
        }
      } catch {
        /* ignore */
      }
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 30 ? best : null;
}

function vintedFindColourSearchInput(surface) {
  const roots = [];
  if (surface instanceof HTMLElement) roots.push(surface);
  if (document.body) roots.push(document.body);
  for (const root of roots) {
    try {
      for (const el of querySelectorAllDeep("input", root)) {
        if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
        const ty = (el.type || "").toLowerCase();
        if (ty === "hidden" || ty === "radio" || ty === "checkbox" || ty === "file") continue;
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const al = shopifyControlAccessibleName(el).toLowerCase();
        const blob = `${ph} ${al}`;
        if (/\bcolou?r\b/.test(blob) && /\bsearch|find|type\b/.test(blob)) return el;
        if (ty === "search" && /\bcolou?r\b/.test(blob)) return el;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function vintedClickMatchingColourOption(want, surface) {
  const w = vintedNormalizeBrandMatchToken(want);
  if (!w || w.length < 2) return false;
  const wAlt =
    w === "grey"
      ? "gray"
      : w === "gray"
        ? "grey"
        : w === "multicolor"
          ? "multicolour"
          : "";
  const scanRoot = surface instanceof HTMLElement ? surface : document.body;
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], li[role="option"], button[type="button"], div[role="button"]',
      scanRoot
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (raw.length < 2 || raw.length > 80) continue;
      const n = vintedNormalizeBrandMatchToken(raw);
      let sc = 0;
      if (n === w || (wAlt && n === wAlt)) sc = 200;
      else if (n.includes(w) || w.includes(n) || (wAlt && (n.includes(wAlt) || wAlt.includes(n)))) sc = 130;
      else if (w.split(/\s+/).filter((p) => p.length > 1).every((part) => n.includes(part))) sc = 85;
      else if (n.startsWith(w) || w.startsWith(n)) sc = 72;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (best && bestSc >= 68) {
      try {
        best.scrollIntoView({ block: "nearest", behavior: "auto" });
        best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        best.click();
        best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Vinted “Colours”: combobox / sheet (“Select up to 2 colours”) — pick from list, up to two values.
 */
function vintedFillColoursDropdown(rootEl, colsRaw) {
  const colours = vintedResolveColourList(colsRaw);
  if (!colours.length) return false;
  // Vinted often requires selecting 2 colours. If we only have one, add a safe fallback.
  if (colours.length === 1) {
    const c0 = String(colours[0] || "").trim().toLowerCase();
    if (c0 && c0 !== "black") colours.push("Black");
    else colours.push("White");
  }
  // Clamp to 2 (Vinted limit).
  if (colours.length > 2) colours.splice(2);
  const neg = ["feedback", "search the help", "coupon", "promo", "description", "title"];
  const joined = colours.join(", ");
  // Avoid typing into the main Colours control; Vinted is React-controlled and typing can
  // leave the row red until an option click is committed.

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return false;

  const clickTrigger = (trig) => {
    if (!(trig instanceof HTMLElement)) return false;
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.focus();
      trig.click();
      trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      return true;
    } catch {
      return false;
    }
  };

  const pickColour = (want) => {
    const surface = vintedFindColourPickerSurface();
    const inp = vintedFindColourSearchInput(surface) || vintedFindColourSearchInput(document.body);
    if (inp) fillField(inp, want);
    const clickRoot = surface || document.body;
    if (vintedClickMatchingColourOption(want, clickRoot)) {
      // Some Vinted colour pickers are checkbox lists; ensure the checkbox/radio toggled.
      try {
        const dlg = vintedFindColourPickerSurface() || document.body;
        const nodes = querySelectorAllDeep("label, input[type='checkbox'], input[type='radio']", dlg);
        const wantLo = String(want || "").trim().toLowerCase();
        for (const n of nodes) {
          if (!(n instanceof HTMLElement)) continue;
          const tx = (n.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
          if (!tx || !tx.includes(wantLo)) continue;
          const cb = n.querySelector && n.querySelector("input[type='checkbox'], input[type='radio']");
          if (cb instanceof HTMLInputElement && !cb.disabled && !cb.checked) {
            n.click();
            break;
          }
        }
      } catch {
        /* ignore */
      }
      return true;
    }
    return !!inp;
  };

  let trig = vintedFindColourTrigger(rootEl);
  if (!trig && typeof document !== "undefined") trig = vintedFindColourTrigger(document.body);
  // Some Vinted builds use a row with a chevron, not a focusable input/button.
  if (!trig) {
    if (!vintedClickColoursRowTrigger(rootEl) && typeof document !== "undefined") {
      if (!vintedClickColoursRowTrigger(document.body)) return false;
    }
  } else {
    if (!clickTrigger(trig)) {
      if (!vintedClickColoursRowTrigger(rootEl) && typeof document !== "undefined") {
        if (!vintedClickColoursRowTrigger(document.body)) return false;
      }
    }
  }

  const c0 = colours[0];
  if (pickColour(c0)) {
    /* continue */
  } else {
    [80, 200, 450, 900, 1600].forEach((ms) => {
      setTimeout(() => pickColour(c0), ms);
    });
  }

  const c1 = colours[1];
  if (c1) {
    // Keep the same picker open; multi-select checkboxes usually live in the same surface.
    [120, 260, 520, 900, 1400, 2000].forEach((ms) => setTimeout(() => pickColour(c1), ms));
  }

  // After selecting colours, close/confirm the picker so Vinted commits the selection and clears validation.
  const closeColourUi = () => {
    vintedCloseActivePicker("colour");
    try {
      const t = vintedFindColourTrigger(rootEl);
      if (t instanceof HTMLElement && t.getAttribute("aria-expanded") === "true") {
        clickTrigger(t);
      }
    } catch {
      /* ignore */
    }
    // If we can find the controlled input, commit the joined value so React doesn't revert.
    try {
      const joinedVal = String(joined || "").trim();
      if (joinedVal) {
        const scope = rootEl || document.body;
        const inp =
          (scope.querySelector &&
            (scope.querySelector('input[data-testid*="colour"][data-testid*="dropdown-input" i]') ||
              scope.querySelector('input[data-testid*="color"][data-testid*="dropdown-input" i]') ||
              scope.querySelector('input[name*="colour" i]') ||
              scope.querySelector('input[id*="colour" i]') ||
              scope.querySelector('input[name*="color" i]') ||
              scope.querySelector('input[id*="color" i]'))) ||
          null;
        if (inp instanceof HTMLInputElement && !inp.disabled) {
          inp.focus();
          const v = joinedVal;
          const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
          if (desc && typeof desc.set === "function") desc.set.call(inp, v);
          else inp.value = v;
          inp.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
        }
      }
    } catch {
      /* ignore */
    }
  };
  [380, 700, 1100, 1700, 2400, 3200, 4200].forEach((ms) => setTimeout(closeColourUi, ms));

  return true;
}

function vintedSizeRowShowsRequiredError(rootEl) {
  try {
    const inp =
      rootEl.querySelector && rootEl.querySelector('input[data-testid="size-select-dropdown-input"]');
    if (inp instanceof HTMLElement) {
      let p = inp;
      for (let i = 0; i < 14 && p; i++, p = p.parentElement) {
        const tx = (p.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (tx.includes("fill in size to continue")) return true;
      }
      const inv = String(inp.getAttribute("aria-invalid") || "").toLowerCase();
      if (inv === "true") return true;
    }
  } catch {
    /* ignore */
  }
  // Some Vinted variants render the required helper text outside the input subtree.
  try {
    const page = (rootEl && rootEl.textContent ? String(rootEl.textContent) : "").toLowerCase();
    if (page.includes("fill in size to continue")) return true;
  } catch {
    /* ignore */
  }
  try {
    for (const el of querySelectorAllDeep('button, [role="button"], [role="combobox"], div, span, p', rootEl)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const row = el.closest("div, li, section, fieldset");
      if (!row || !/\bsize\b/i.test((row.textContent || "").slice(0, 220))) continue;
      const head = (row.textContent || "").slice(0, 420).toLowerCase();
      if (/\bparcel\b|\bpackage size\b|\bpostage\b|\bshipping package\b/i.test(head)) continue;
      const rh = (row.textContent || "").slice(0, 700).toLowerCase();
      if (/fill in size to continue|this field is required|please select|required/i.test(rh)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedSizeLooksLikeLetterSize(raw) {
  const low = String(raw || "").trim().toLowerCase();
  return /^(xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl|7xl|8xl)$/.test(low);
}

function vintedGetCurrentSizeValue(rootEl) {
  try {
    const inp =
      rootEl.querySelector &&
      (rootEl.querySelector('input[data-testid="size-select-dropdown-input"]') ||
        rootEl.querySelector('input[data-testid="size-select-dropdown-input"][name="size"]'));
    if (inp instanceof HTMLInputElement) return String(inp.value || "").trim();
  } catch {
    /* ignore */
  }
  try {
    const row = vintedFindSizeRow(rootEl);
    const tx = (row && row.textContent ? String(row.textContent) : "").replace(/\s+/g, " ").trim();
    // Heuristic: row is like "Size XS" or "Size One size"
    if (tx) {
      const m = tx.match(/\bsize\b\s*([A-Za-z0-9][A-Za-z0-9\s-]{0,24})/i);
      if (m && m[1]) return String(m[1]).trim();
    }
  } catch {
    /* ignore */
  }
  return "";
}

function vintedFindSizeTrigger(rootEl) {
  // Vinted (2026) explicit size dropdown input
  try {
    const direct = rootEl.querySelector && rootEl.querySelector('input[data-testid="size-select-dropdown-input"]');
    if (direct instanceof HTMLElement && vintedLayoutInteractable(direct, 4, 4)) return direct;
  } catch {
    /* ignore */
  }
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], [aria-haspopup="listbox"], div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      const t = rawT.toLowerCase();
      let sc = 0;
      if (/^select a size$/i.test(rawT) || /\bselect a size\b/i.test(rawT)) sc += 115;
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (/\bsize\b/.test(al) && !/\btext\b|\btitle\b/.test(al)) sc += 52;
      const row = el.closest("div, li, section, fieldset, form");
      const rowHead = row ? (row.textContent || "").slice(0, 260) : "";
      if (row && /\bsize\b/i.test(rowHead)) {
        sc += 46;
        if (/fill in size to continue|select.*size|required/i.test(rowHead.toLowerCase())) sc += 28;
        if (rawT.length > 1 && !/^size$/i.test(rawT) && !/^select a size$/i.test(rawT)) sc += 18;
      }
      if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("aria-expanded") === "false") sc += 8;
      if (el.getAttribute("role") === "combobox") sc += 12;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 48 ? best : null;
}

function vintedOpenSizePicker(rootEl) {
  const win = rootEl?.defaultView || window;
  const row = vintedFindSizeRow(rootEl) || null;
  const trig = (row && vintedFindSizeTrigger(row)) || vintedFindSizeTrigger(rootEl);
  const clickEl = (el) => {
    try {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) return false;
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      const r = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      const cx = r ? Math.round(r.left + r.width / 2) : 10;
      const cy = r ? Math.round(r.top + r.height / 2) : 10;
      try {
        el.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            view: win,
            pointerId: 1,
            clientX: cx,
            clientY: cy,
            buttons: 1,
            pointerType: "mouse",
          })
        );
        el.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            view: win,
            pointerId: 1,
            clientX: cx,
            clientY: cy,
            buttons: 0,
            pointerType: "mouse",
          })
        );
      } catch {
        /* ignore */
      }
      el.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, buttons: 1 })
      );
      el.click();
      el.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy, buttons: 0 })
      );
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win, clientX: cx, clientY: cy }));
      return true;
    } catch {
      return false;
    }
  };
  if (trig instanceof HTMLElement) {
    try {
      trig.focus();
    } catch {
      /* ignore */
    }
    if (clickEl(trig)) return true;
    // Keyboard open fallback (comboboxes often open on ArrowDown/Enter).
    try {
      trig.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", code: "ArrowDown", bubbles: true }));
      trig.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
    } catch {
      /* ignore */
    }
  }
  // Chevron / button in the same row is often the real opener.
  const scope = (row instanceof HTMLElement && row) || rootEl;
  try {
    const btns = querySelectorAllDeep(
      'button, [role="button"], [aria-haspopup="listbox"], [role="combobox"], div[tabindex="0"], span[tabindex="0"]',
      scope
    );
    for (const b of btns) {
      if (!(b instanceof HTMLElement) || !vintedLayoutInteractable(b, 4, 4)) continue;
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      const tid = (b.getAttribute("data-testid") || "").toLowerCase();
      const txt = (b.textContent || "").toLowerCase();
      if (/\bsize\b/.test(`${al} ${tid} ${txt}`) || b.getAttribute("aria-haspopup") === "listbox") {
        if (clickEl(b)) return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedFindSizeRow(rootEl) {
  try {
    const nodes = querySelectorAllDeep("div, li, section, fieldset", rootEl);
    let best = null;
    let bestLen = Infinity;
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 16)) continue;
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx) continue;
      const head = tx.slice(0, 260).toLowerCase();
      if (!/\bsize\b/.test(head)) continue;
      if (!/fill in size to continue|select a size|required/i.test(tx.toLowerCase())) continue;
      const len = tx.length;
      if (len < bestLen) {
        bestLen = len;
        best = el;
      }
    }
    return best;
  } catch {
    return null;
  }
}

function vintedFindActiveSizeDialog() {
  let best = null;
  let bestSc = 0;
  try {
    const dialogs = querySelectorAllDeep('[role="dialog"], [aria-modal="true"]', document.body);
    for (const el of dialogs) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 2000).toLowerCase();
      let sc = 0;
      if (/\bsize\b/.test(tx)) sc += 60;
      if (/select a size|choose a size|pick.*size/.test(tx)) sc += 30;
      if (/\bbrand\b/.test(tx)) sc -= 25;
      if (/\bcolou?r\b/.test(tx)) sc -= 25;
      if (/\bcondition\b/.test(tx)) sc -= 10;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 35 ? best : null;
}

function vintedClearTextInputReactFriendly(inp) {
  try {
    if (!(inp instanceof HTMLInputElement)) return false;
    if (inp.disabled) return false;
    inp.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && typeof desc.set === "function") desc.set.call(inp, "");
    else inp.value = "";
    try {
      inp.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true, inputType: "deleteContentBackward", data: "" })
      );
    } catch {
      inp.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    }
    inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

function vintedForceCommitSizeOneSize(rootEl) {
  try {
    const row = vintedFindSizeRow(rootEl);
    const trig = (row && vintedFindSizeTrigger(row)) || vintedFindSizeTrigger(rootEl);
    const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
    if (!trig || !win) return false;
    try {
      vintedOpenSizePicker(rootEl);
    } catch {
      /* ignore */
    }

    const oneSizeSyn =
      /\b(one\s*size|one[-\s]?size\s*f(?:its)?\s*all|os\b|unique\s*size|taille\s*unique|einheitsgr(o|ö)ße|talla\s*única|taglia\s*unica|u\b)\b/i;
    /** Default when no label size: try true one-size options before garment letters (user policy). */
    const fallbackSizes = [
      "One size",
      "ONE SIZE",
      "One Size",
      "OS",
      "Unisex one size",
      "One size fits all",
    ];

    let lastDlg = null;
    const pickInDialog = () => {
      const dlg = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface();
      lastDlg = dlg;
      const scope = dlg || document.body;
      const wantOrder = fallbackSizes.slice();
      const wantOneSize = wantOrder.find((x) => oneSizeSyn.test(String(x).toLowerCase())) || "One size";

      // Clear any previous search (often "XS") so "One size" remains selectable.
      try {
        const searchInp = vintedFindSizeSearchInput(scope) || vintedFindSizeSearchInput(document.body);
        if (searchInp instanceof HTMLInputElement) {
          vintedClearTextInputReactFriendly(searchInp);
          fillField(searchInp, "One size");
        }
      } catch {
        /* ignore */
      }

      // 0) Best path: click a visible "One size" host directly.
      try {
        const host0 = vintedFindBestClickableOptionHostByText(scope, oneSizeSyn);
        if (host0) {
          // Prefer clicking the right-side "radio circle" if present.
          let clickTarget = host0;
          try {
            const circ =
              host0.querySelector &&
              host0.querySelector('input[type="radio"], input[type="checkbox"], [role="radio"], [aria-checked], svg, span, div');
            if (circ instanceof HTMLElement && vintedLayoutInteractable(circ, 6, 6)) clickTarget = circ;
          } catch {
            /* ignore */
          }
          vintedHumanClick(clickTarget, win);
          return true;
        }
      } catch {
        /* ignore */
      }

      // 1) Best path: click a native radio for size (Vinted often hides it but keeps it in DOM).
      try {
        const radios = querySelectorAllDeep('input[type="radio"]', scope);
        const labelFor = new Map();
        for (const lab of scope.querySelectorAll("label")) {
          if (!(lab instanceof HTMLElement)) continue;
          const f = lab.getAttribute("for");
          if (f) labelFor.set(f, lab);
        }
        const scoreRadio = (inp) => {
          const id = inp.id || "";
          const val = String(inp.value || "").trim();
          const aria = String(inp.getAttribute("aria-label") || "").trim();
          const near =
            `${aria} ${val} ${inp.closest("label")?.textContent || ""} ${labelFor.get(id)?.textContent || ""}`
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          let best = -Infinity;
          for (let i = 0; i < wantOrder.length; i++) {
            const w = String(wantOrder[i]).trim().toLowerCase();
            if (!w) continue;
            let sc = 0;
            if (w === wantOneSize.toLowerCase() && oneSizeSyn.test(near)) sc = 200;
            else if (near === w) sc = 180;
            else if (near.includes(w) || w.includes(near)) sc = 120;
            if (sc > best) best = sc - i; // earlier wants win
          }
          return best;
        };
        let bestInp = null;
        let bestSc = -Infinity;
        for (const r of radios) {
          if (!(r instanceof HTMLInputElement)) continue;
          if (r.disabled) continue;
          const sc = scoreRadio(r);
          if (sc > bestSc) {
            bestSc = sc;
            bestInp = r;
          }
        }
        if (bestInp && bestSc >= 80) {
          const id = bestInp.id || "";
          const lab = (id && labelFor.get(id)) || bestInp.closest("label");
          const clickTarget = (lab instanceof HTMLElement && lab) || bestInp;
          try {
            clickTarget.scrollIntoView({ block: "nearest", behavior: "auto" });
            clickTarget.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
            clickTarget.click();
            clickTarget.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win }));
            clickTarget.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
            return true;
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }

      // 2) Fallback: click visible grid/list cells.
      const clickables = querySelectorAllDeep(
        // Vinted sometimes renders a size grid/table (cells are clickable) instead of a listbox.
        'button, [role="button"], [role="option"], [role="menuitem"], [role="gridcell"], li, label, td, th, div[tabindex="0"], span[tabindex="0"]',
        scope
      );
      const items = [];
      for (const el of clickables) {
        if (!(el instanceof HTMLElement)) continue;
        const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 80) continue;
        items.push({ el, tx, low: tx.toLowerCase() });
      }
      if (!items.length) return false;

      const resolveClickableTarget = (start) => {
        let cur = start;
        for (let up = 0; up < 7 && cur; up++) {
          if (
            cur instanceof HTMLElement &&
            (cur.tagName === "BUTTON" ||
              cur.getAttribute("role") === "button" ||
              cur.getAttribute("role") === "option" ||
              cur.getAttribute("role") === "menuitem" ||
              cur.hasAttribute("tabindex") ||
              vintedLayoutInteractable(cur, 4, 4))
          ) {
            return cur;
          }
          cur = cur.parentElement;
        }
        return start;
      };

      const clickText = (want) => {
        const wantLow = String(want || "").trim().toLowerCase();
        if (!wantLow) return false;
        for (const it of items) {
          if (it.low === wantLow || it.low.includes(wantLow) || wantLow.includes(it.low)) {
            try {
              const target = resolveClickableTarget(it.el);
              target.scrollIntoView({ block: "nearest", behavior: "auto" });
              target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
              target.click();
              target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win }));
              target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
              return true;
            } catch {
              /* ignore */
            }
          }
        }
        return false;
      };

      const commitControlledInput = (label) => {
        try {
          const inp =
            rootEl.querySelector &&
            rootEl.querySelector('input[data-testid="size-select-dropdown-input"]');
          if (!(inp instanceof HTMLInputElement) || inp.disabled) return;
          const v = String(label || "").trim();
          if (!v) return;
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (desc && typeof desc.set === "function") desc.set.call(inp, v);
            else inp.value = v;
          } catch {
            inp.value = v;
          }
          inp.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: v, inputType: "insertText" }));
          inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
          inp.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
        } catch {
          /* ignore */
        }
      };

      // Choose a sane fallback using what's actually present in the picker (prefer concrete size first).
      for (const fb of fallbackSizes) {
        if (clickText(fb)) {
          setTimeout(() => commitControlledInput(fb), 140);
          try {
            vintedClickSizeConfirmIfPresent(scope);
          } catch {
            /* ignore */
          }
          return true;
        }
      }
      // Last resort: only click something that actually matches one-size.
      try {
        const oneOpt = items.find((it) => it && typeof it.tx === "string" && oneSizeSyn.test(it.tx.toLowerCase()));
        if (oneOpt && oneOpt.el) {
          const target = resolveClickableTarget(oneOpt.el);
          target.scrollIntoView({ block: "nearest", behavior: "auto" });
          target.click();
          setTimeout(() => commitControlledInput(oneOpt.tx), 140);
          try {
            vintedClickSizeConfirmIfPresent(scope);
          } catch {
            /* ignore */
          }
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    };

    const tryPickLoop = () => {
      try {
        // Ensure picker is open (it may close/reopen on re-render).
        vintedOpenSizePicker(rootEl);
      } catch {
        /* ignore */
      }
      return pickInDialog();
    };

    if (tryPickLoop()) {
      setTimeout(() => {
        try {
          vintedClickSizeConfirmIfPresent(
            lastDlg || vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body
          );
        } catch {
          /* ignore */
        }
        vintedCloseActivePicker("size");
      }, 90);
      // If still required after commit, try again with a concrete size (M).
      setTimeout(() => {
        try {
          if (vintedSizeRowShowsRequiredError(rootEl)) {
            try {
              trig.click();
            } catch {
              /* ignore */
            }
            setTimeout(() => {
              pickInDialog();
              setTimeout(() => vintedCloseActivePicker("size"), 90);
            }, 160);
          }
        } catch {
          /* ignore */
        }
      }, 420);
      return true;
    }
    // Retry burst: dialogs/options often render after animation.
    [120, 260, 420, 700, 1100].forEach((ms) =>
      setTimeout(() => {
        try {
          if (tryPickLoop()) {
            try {
              const dlg2 = lastDlg || vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body;
              vintedClickSizeConfirmIfPresent(dlg2);
            } catch {
              /* ignore */
            }
          }
          setTimeout(() => vintedCloseActivePicker("size"), 90);
        } catch {
          /* ignore */
        }
      }, ms)
    );
    return true;
  } catch {
    return false;
  }
}

function vintedFindSizePickerSurface() {
  let best = null;
  let bestSc = 0;
  try {
    for (const el of querySelectorAllDeep('[role="dialog"], [aria-modal="true"], [role="listbox"]', document.body)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 1200).toLowerCase();
      if (/\bbrand\b/.test(tx) && !/\bsize\b/.test(tx.slice(0, 500))) continue;
      if (/\bcolou?r\b/.test(tx) && !/\bsize\b/.test(tx.slice(0, 500))) continue;
      let sc = 0;
      if (/\bsize\b/.test(tx)) sc += 52;
      if (/select a size|pick.*size|type to find|search/i.test(tx)) sc += 24;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 30 ? best : null;
}

function vintedFindSizeSearchInput(surface) {
  const roots = [];
  if (surface instanceof HTMLElement) roots.push(surface);
  if (document.body) roots.push(document.body);
  for (const root of roots) {
    try {
      for (const el of querySelectorAllDeep("input", root)) {
        if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
        const ty = (el.type || "").toLowerCase();
        if (ty === "hidden" || ty === "radio" || ty === "checkbox" || ty === "file") continue;
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const al = shopifyControlAccessibleName(el).toLowerCase();
        const blob = `${ph} ${al}`;
        if (/\bsize\b/.test(blob) && /\bsearch|find|type\b/.test(blob)) return el;
        if (ty === "search" && /\bsize\b/.test(blob)) return el;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function vintedClickMatchingSizeOption(want, surface) {
  const wantLo = String(want || "").trim().toLowerCase();
  if (!wantLo) return false;
  const wantTok = vintedNormalizeBrandMatchToken(wantLo);
  const scanRoot = surface instanceof HTMLElement ? surface : document.body;
  let best = null;
  let bestSc = 0;
  const win = scanRoot && scanRoot.ownerDocument ? scanRoot.ownerDocument.defaultView || window : window;

  const humanClick = (el) => vintedHumanClick(el, win);

  try {
    const nodes = querySelectorAllDeep(
      [
        // Common option nodes
        '[role="option"]',
        '[role="menuitem"]',
        'li[role="option"]',
        'button[type="button"]',
        'div[role="button"]',
        'label',
        'div[tabindex="0"]',
        // Hidden-but-real radios inside sheets
        'input[type="radio"]',
        // Fallback: list items sometimes carry the handler
        "li",
      ].join(", "),
      scanRoot
    );
    for (const el of nodes) {
      const isRadio = el instanceof HTMLInputElement && el.type === "radio";
      if (!isRadio) {
        if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      } else {
        // Radios may not be interactable, but their label is.
        if (el.disabled) continue;
      }
      const raw =
        (isRadio
          ? `${el.getAttribute("aria-label") || ""} ${el.value || ""} ${el.closest("label")?.textContent || ""}`
          : el.textContent || ""
        )
          .replace(/\s+/g, " ")
          .trim();
      if (raw.length < 1 || raw.length > 120) continue;
      const tx = raw.toLowerCase();
      if (/^colou|^material|^brand|^price|^condition/i.test(tx)) continue;
      const tok = vintedNormalizeBrandMatchToken(tx);
      let sc = 0;
      const oneSizeSyn =
        /\b(one\s*size|one[-\s]?size\s*f(?:its)?\s*all|os\b|unique\s*size|taille\s*unique|einheitsgr(o|ö)ße|talla\s*única|taglia\s*unica|u\b)\b/i;
      const wantIsOneSize = oneSizeSyn.test(wantLo) || wantLo === "os";
      if (wantIsOneSize && oneSizeSyn.test(tx)) sc = 240;
      else if (tx === wantLo) sc = 220;
      else if (tx.includes(wantLo) || wantLo.includes(tx)) sc = 155;
      else if (tok && wantTok && (tok === wantTok || tok.includes(wantTok) || wantTok.includes(tok))) sc = 120;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (best && bestSc >= 88) {
      // For radios, prefer clicking the associated label/container.
      if (best instanceof HTMLInputElement && best.type === "radio") {
        const lab = best.closest("label");
        if (lab instanceof HTMLElement && humanClick(lab)) return true;
        // Sometimes the clickable host is the parent row.
        const host = best.closest('[role="option"], li, div, button') || null;
        if (host instanceof HTMLElement && humanClick(host)) return true;
        return humanClick(best);
      }
      return humanClick(best);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedHumanClick(el, win) {
  try {
    if (!(el instanceof HTMLElement) && !(el instanceof HTMLInputElement)) return false;
    const target = el instanceof HTMLElement ? el : el;
    const w = win || (target.ownerDocument && target.ownerDocument.defaultView) || window;
    if (target instanceof HTMLElement) target.scrollIntoView({ block: "nearest", behavior: "auto" });
    const rect =
      target instanceof HTMLElement && typeof target.getBoundingClientRect === "function"
        ? target.getBoundingClientRect()
        : null;
    const cx = rect ? Math.round(rect.left + rect.width / 2) : 10;
    const cy = rect ? Math.round(rect.top + rect.height / 2) : 10;
    // Pointer events first (Vinted often binds onPointerDown).
    try {
      const peDown = new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        view: w,
        pointerId: 1,
        clientX: cx,
        clientY: cy,
        buttons: 1,
        pointerType: "mouse",
      });
      const peUp = new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        view: w,
        pointerId: 1,
        clientX: cx,
        clientY: cy,
        buttons: 0,
        pointerType: "mouse",
      });
      target.dispatchEvent(peDown);
      target.dispatchEvent(peUp);
    } catch {
      /* ignore */
    }
    // Mouse events + click.
    try {
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: w, clientX: cx, clientY: cy, buttons: 1 })
      );
    } catch {
      /* ignore */
    }
    try {
      target.click();
    } catch {
      /* ignore */
    }
    try {
      target.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: w, clientX: cx, clientY: cy, buttons: 0 })
      );
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: w, clientX: cx, clientY: cy }));
    } catch {
      /* ignore */
    }
    // If it's a radio input, set checked + dispatch change as well.
    try {
      if (el instanceof HTMLInputElement && el.type === "radio") {
        el.checked = true;
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      }
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

function vintedClickSizeOptionByTextInDialog(dialog, textRe) {
  const dlg = dialog instanceof HTMLElement ? dialog : document.body;
  const win = (dlg.ownerDocument && dlg.ownerDocument.defaultView) || window;
  try {
    const nodes = querySelectorAllDeep(
      'label, [role="option"], [role="menuitem"], [role="gridcell"], button, li, div[tabindex="0"], span[tabindex="0"], p, span, div',
      dlg
    );
    let best = null;
    let bestLen = Infinity;
    for (const n of nodes) {
      if (!(n instanceof HTMLElement) || !vintedLayoutInteractable(n, 4, 4)) continue;
      const tx = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx || tx.length > 120) continue;
      if (!textRe.test(tx.toLowerCase())) continue;
      // Prefer tighter nodes (closest to just the option text).
      if (tx.length < bestLen) {
        bestLen = tx.length;
        best = n;
      }
    }
    if (!best) return false;
    const host =
      best.closest('label, [role="option"], [role="menuitem"], [role="gridcell"], button, li, div[tabindex="0"], span[tabindex="0"]') ||
      best;
    return vintedHumanClick(host, win);
  } catch {
    return false;
  }
}

function vintedEnsureAssistStyles() {
  try {
    const id = "synclyst-vinted-assist-style";
    if (document.getElementById(id)) return;
    const st = document.createElement("style");
    st.id = id;
    st.textContent = `
      .synclyst-vinted-assist-outline {
        outline: 3px solid #ff3b30 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(255,59,48,0.15) !important;
        border-radius: 10px !important;
      }
      .synclyst-vinted-assist-toast {
        position: fixed !important;
        left: 50% !important;
        bottom: 18px !important;
        transform: translateX(-50%) !important;
        max-width: min(560px, calc(100vw - 32px)) !important;
        background: rgba(20,20,20,0.92) !important;
        color: #fff !important;
        padding: 12px 14px !important;
        border-radius: 14px !important;
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif !important;
        z-index: 2147483647 !important;
        box-shadow: 0 12px 34px rgba(0,0,0,0.35) !important;
      }
      .synclyst-vinted-assist-toast b { font-weight: 650 !important; }
      .synclyst-vinted-assist-toast button {
        margin-left: 10px !important;
        background: rgba(255,255,255,0.12) !important;
        color: #fff !important;
        border: 1px solid rgba(255,255,255,0.18) !important;
        border-radius: 10px !important;
        padding: 6px 9px !important;
        cursor: pointer !important;
      }
    `;
    document.documentElement.appendChild(st);
  } catch {
    /* ignore */
  }
}

function vintedShowAssistToast(message, onDismiss) {
  try {
    vintedEnsureAssistStyles();
    const existing = document.querySelector(".synclyst-vinted-assist-toast");
    if (existing && existing.parentElement) existing.parentElement.removeChild(existing);
    const el = document.createElement("div");
    el.className = "synclyst-vinted-assist-toast";
    el.innerHTML = `${message} <button type="button">Dismiss</button>`;
    const btn = el.querySelector("button");
    if (btn) {
      btn.addEventListener("click", () => {
        try {
          el.remove();
        } catch {
          /* ignore */
        }
        try {
          onDismiss && onDismiss();
        } catch {
          /* ignore */
        }
      });
    }
    document.body.appendChild(el);
    return el;
  } catch {
    return null;
  }
}

function vintedAssistHighlightOnce(targetEl, toastHtml) {
  try {
    if (!(targetEl instanceof HTMLElement)) return false;
    vintedEnsureAssistStyles();
    // Clear prior highlights.
    for (const prev of document.querySelectorAll(".synclyst-vinted-assist-outline")) {
      try {
        prev.classList.remove("synclyst-vinted-assist-outline");
      } catch {
        /* ignore */
      }
    }
    targetEl.classList.add("synclyst-vinted-assist-outline");
    try {
      targetEl.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      /* ignore */
    }
    const cleanup = () => {
      try {
        targetEl.classList.remove("synclyst-vinted-assist-outline");
      } catch {
        /* ignore */
      }
    };
    vintedShowAssistToast(
      toastHtml,
      () => {
        cleanup();
      }
    );
    // Auto cleanup after 20s.
    setTimeout(cleanup, 20000);
    return true;
  } catch {
    return false;
  }
}

function vintedFindBestClickableOptionHostByText(dialog, textRe) {
  const dlg = dialog instanceof HTMLElement ? dialog : document.body;
  try {
    const nodes = querySelectorAllDeep(
      'label, [role="option"], [role="menuitem"], [role="gridcell"], button, li, div[tabindex="0"], span[tabindex="0"], p, span, div',
      dlg
    );
    let best = null;
    let bestLen = Infinity;
    for (const n of nodes) {
      if (!(n instanceof HTMLElement) || !vintedLayoutInteractable(n, 4, 4)) continue;
      const tx = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx || tx.length > 140) continue;
      if (!textRe.test(tx.toLowerCase())) continue;
      if (tx.length < bestLen) {
        bestLen = tx.length;
        best = n;
      }
    }
    if (!best) return null;
    // Prefer the whole option row host; some Vinted builds only toggle selection when the row/circle is clicked.
    return (
      best.closest(
        'label, [role="option"], [role="menuitem"], [role="gridcell"], button, li, div[tabindex="0"], span[tabindex="0"], div'
      ) || best
    );
  } catch {
    return null;
  }
}

function vintedSizeIsOneSizeSelected(rootEl) {
  try {
    const inp =
      rootEl.querySelector &&
      (rootEl.querySelector('input[data-testid="size-select-dropdown-input"]') ||
        rootEl.querySelector('input[data-testid="size-select-dropdown-input"][name="size"]'));
    if (inp instanceof HTMLInputElement) {
      const v = String(inp.value || "").trim().toLowerCase();
      return /\bone\s*size\b|\bos\b|\bunique\s*size\b|\btaille\s*unique\b/.test(v);
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedClickSizeConfirmIfPresent(dialog) {
  try {
    for (const b of querySelectorAllDeep("button, [role='button']", dialog)) {
      if (!(b instanceof HTMLElement) || !vintedLayoutInteractable(b, 8, 8)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/^(done|apply|ok|save|select|confirm|continue|next)$/i.test(t) || /confirm|done|apply|save/i.test(al)) {
        b.click();
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedConditionOptionFirstLine(full) {
  return String(full || "")
    .replace(/\r\n/g, "\n")
    .split(/\n/)[0]
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Map Shopify / eBay / free-text condition strings to Vinted’s row titles (see “Select condition” sheet). */
function vintedMapConditionSynonymToVintedLabel(s) {
  const t = String(s).toLowerCase().replace(/[_/]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (
    /new with tags?|^nwt$|bnwt|tags attached|deadstock|brand new with tags?|new in box with tags?/.test(t) ||
    (/\bbrand new\b/.test(t) && /\btags?\b/.test(t))
  ) {
    return "New with tags";
  }
  if (
    /new without tags|bnwot|never worn|new never used|unused(?!.*tags)|brand new(?!.*tags)/.test(t) ||
    (/\bbrand new\b/.test(t) && !/\btags?\b/.test(t))
  ) {
    return "New without tags";
  }
  if (
    /very good|excellent|like new|mint( condition)?|pre-?owned[\s-]*(excellent|very)|used[\s-]*excellent|9\s*\/\s*10/.test(
      t
    )
  ) {
    return "Very good";
  }
  if (
    /^good$|^good |lightly used|light wear|pre-?owned[\s-]*good|used[\s-]*good|8\s*\/\s*10/.test(t) ||
    (/\bgood\b/.test(t) && !/very|material|original/i.test(t))
  ) {
    return "Good";
  }
  if (/satisfactory|fair|acceptable|decent|well worn|heavy wear|pre-?owned[\s-]*(fair|acceptable)/.test(t)) {
    return "Satisfactory";
  }
  const cap = String(s).trim();
  if (/^new with tags?$/i.test(cap)) return "New with tags";
  if (/^new without tags?$/i.test(cap)) return "New without tags";
  if (/^very good$/i.test(cap)) return "Very good";
  if (/^good$/i.test(cap)) return "Good";
  if (/^satisfactory$/i.test(cap)) return "Satisfactory";
  return cap;
}

function vintedResolveConditionForFill(scan, v) {
  let s = v && v.condition != null ? String(v.condition).trim() : "";
  try {
    const le = scan && scan.listing_extra;
    if (!s && le && typeof le === "object") {
      const sh = le.shopify;
      if (sh && typeof sh === "object" && sh.condition != null) s = String(sh.condition).trim();
      if (!s) {
        const eb = le.ebay;
        if (eb && typeof eb === "object" && eb.condition != null) s = String(eb.condition).trim();
      }
    }
  } catch {
    /* ignore */
  }
  const mapped = vintedMapConditionSynonymToVintedLabel(s);
  if (mapped) return mapped;
  const text = [scan && scan.title, scan && scan.description].filter(Boolean).join(" \n ").toLowerCase();
  if (text) {
    if (/\b(nwt|new with tags?|tags attached|bnwt)\b/i.test(text)) return "New with tags";
    if (/\b(never worn|new without tags|unused)\b/i.test(text) && /\bbrand new\b/i.test(text)) return "New without tags";
    if (/\b(excellent|mint|very good|like new)\b/i.test(text)) return "Very good";
    if (/\b(good condition|lightly used|light wear)\b/i.test(text)) return "Good";
    if (/\b(fair|well worn|heavy wear|major flaws?)\b/i.test(text)) return "Satisfactory";
  }
  // Default that clears validation for most categories.
  return "Good";
}

function vintedFindConditionTrigger(rootEl) {
  // Vinted (2026) explicit condition dropdown input (similar to size-select-dropdown-input).
  try {
    const direct =
      rootEl.querySelector &&
      rootEl.querySelector('input[data-testid*="condition"][data-testid*="dropdown-input" i]');
    if (direct instanceof HTMLElement && vintedLayoutInteractable(direct, 4, 4)) return direct;
  } catch {
    /* ignore */
  }
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], [role="listbox"], div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      let sc = 0;
      if (/\bselect condition\b/i.test(rawT)) sc += 115;
      if (/\bchoose condition\b/i.test(rawT)) sc += 100;
      const al = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`.toLowerCase();
      if (/\bcondition\b/.test(al) && !/\bsubcondition\b/.test(al)) sc += 52;
      const dt = (el.getAttribute("data-testid") || "").toLowerCase();
      if (/\bcondition\b/.test(dt)) sc += 48;
      const row = el.closest("div, li, section, fieldset, form");
      const rowHead = row ? (row.textContent || "").slice(0, 240) : "";
      if (row && /\bcondition\b/i.test(rowHead) && !/\bcategory\b/i.test(rowHead.slice(0, 48))) {
        sc += 46;
        if (/fill in condition|select condition|required/i.test(rowHead)) sc += 26;
        if (rawT.length > 2 && !/^select condition$/i.test(rawT) && !/^condition$/i.test(rawT)) sc += 28;
      }
      if (el.getAttribute("aria-haspopup") === "listbox" || el.getAttribute("aria-expanded") === "false") sc += 8;
      if (el.getAttribute("role") === "combobox") sc += 12;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 48 ? best : null;
}

function vintedFindConditionPickerSurface() {
  let best = null;
  let bestSc = 0;
  try {
    for (const el of querySelectorAllDeep('[role="dialog"], [aria-modal="true"], [role="listbox"]', document.body)) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 24, 24)) continue;
      const tx = (el.textContent || "").slice(0, 1700).toLowerCase();
      if (/find a category|catalogue sections|search categories/i.test(tx) && !/new with tags|without tags|very good/i.test(tx))
        continue;
      let sc = 0;
      if (/new with tags?/.test(tx) && (/without tags|very good|lightly used/i.test(tx) || /\bcondition\b/.test(tx)))
        sc += 58;
      if (/\bcondition\b/.test(tx)) sc += 32;
      if (/a brand-new|unused item with tags|slight imperfections/i.test(tx)) sc += 36;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 42 ? best : null;
}

function vintedFindConditionSearchInput(surface) {
  const roots = [];
  if (surface instanceof HTMLElement) roots.push(surface);
  if (document.body) roots.push(document.body);
  for (const root of roots) {
    try {
      for (const el of querySelectorAllDeep("input", root)) {
        if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
        const ty = (el.type || "").toLowerCase();
        if (ty === "hidden" || ty === "radio" || ty === "checkbox" || ty === "file") continue;
        const ph = (el.getAttribute("placeholder") || "").toLowerCase();
        const al = shopifyControlAccessibleName(el).toLowerCase();
        const blob = `${ph} ${al}`;
        if (/\bcondition\b/.test(blob) && /\bsearch|find|type\b/.test(blob)) return el;
        if (ty === "search" && /\bcondition\b/.test(blob)) return el;
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

function vintedClickMatchingConditionOption(want, surface) {
  const wantLo = String(want || "").trim().toLowerCase();
  if (!wantLo) return false;
  const wantTok = vintedNormalizeBrandMatchToken(wantLo);
  const scanRoot = surface instanceof HTMLElement ? surface : document.body;
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], li[role="option"], button[type="button"], div[role="button"], label, div[tabindex="0"]',
      scanRoot
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const full = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (full.length < 14 || full.length > 520) continue;
      const first = vintedConditionOptionFirstLine(el.textContent || "");
      if (/^colou|^material|^brand|^price|^size\b/i.test(first)) continue;
      const firstTok = vintedNormalizeBrandMatchToken(first);
      let sc = 0;
      if (first === wantLo) sc = 220;
      else if (first.includes(wantLo) || wantLo.includes(first)) sc = 165;
      else if (firstTok && (firstTok.includes(wantTok) || wantTok.includes(firstTok))) sc = 120;
      if (full.toLowerCase().includes(wantLo) && sc < 95) sc = 95;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (best && bestSc >= 88) {
      try {
        best.scrollIntoView({ block: "nearest", behavior: "auto" });
        best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        best.click();
        best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch {
        return false;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Vinted “Condition”: same pattern as Brand / Colours — “Select condition” then radio-style rows
 * (“New with tags”, “New without tags”, “Very good”, “Good”, “Satisfactory”, …).
 */
function vintedFillConditionDropdown(rootEl, condWant) {
  const want = String(condWant || "").trim();
  const wantUse = want || "Good";
  const neg = [
    "feedback",
    "search the help",
    "coupon",
    "promo",
    "description",
    "colour",
    "color",
    "material",
    "size",
    "brand",
    "title",
  ];
  // Typing alone can leave validation red; still continue into the picker.
  try {
    vintedFillByHints(rootEl, ["condition"], neg, wantUse);
  } catch {
    /* ignore */
  }

  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return false;
  const trig = vintedFindConditionTrigger(rootEl);
  if (!trig) return false;

  const clickTrigger = () => {
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.focus();
      trig.click();
      trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      return true;
    } catch {
      return false;
    }
  };

  const pick = () => {
    const surface = vintedFindConditionPickerSurface();
    const inp = vintedFindConditionSearchInput(surface) || vintedFindConditionSearchInput(document.body);
    if (inp) fillField(inp, wantUse);
    const clickRoot = surface || document.body;
    if (vintedClickMatchingConditionOption(wantUse, clickRoot)) {
      setTimeout(() => vintedCloseActivePicker("condition"), 120);
      return true;
    }
    return !!inp;
  };

  if (!clickTrigger()) return false;
  if (pick()) return true;
  [70, 200, 480].forEach((ms) => {
    setTimeout(pick, ms);
  });
  return true;
}

function vintedCategoryRowShowsRequiredError(rootEl) {
  try {
    for (const el of querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], div, span, p',
      rootEl
    )) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const row = el.closest("div, li, section, fieldset");
      if (!row || !/\bcategory\b/i.test((row.textContent || "").slice(0, 220))) continue;
      const rh = (row.textContent || "").slice(0, 600).toLowerCase();
      if (
        /this field is required|please select|required category|invalid category|select a category|choose a category/i.test(
          rh
        )
      ) {
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedCategorySurfaceShowsSelection(rootEl) {
  if (vintedFindCategoryPickerSurface()) return false;
  if (vintedCategoryRowShowsRequiredError(rootEl)) return false;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], div[tabindex="0"], span[tabindex="0"]',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      const row = el.closest("div, li, section, fieldset");
      if (!row || !/\bcategory\b/i.test((row.textContent || "").slice(0, 180))) continue;
      const rowHead = (row.textContent || "").slice(0, 320);
      if (/please select a category/i.test(rowHead)) return false;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t) continue;
      if (/^select a category$/i.test(t) || /^choose a category$/i.test(t)) return false;
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function vintedFindCategorySearchInput(dialog) {
  try {
    let fallback = null;
    for (const el of querySelectorAllDeep("input", dialog)) {
      if (!(el instanceof HTMLInputElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const al = shopifyControlAccessibleName(el).toLowerCase();
      if (
        ty === "search" ||
        /\bsearch\b/.test(ph) ||
        /\bsearch\b/.test(al) ||
        /\bfind a category\b/.test(ph) ||
        /\bfind a category\b/.test(al) ||
        /\bcategor(y|ies)\b/.test(ph) ||
        /\btype to search\b/.test(ph)
      ) {
        return el;
      }
      if (ty === "text" && !fallback && (/\bfind\b/.test(ph) || /\bcategor/.test(ph))) fallback = el;
    }
    return fallback;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Vinted (and similar UIs) keep the real `<input type="radio">` in the tree but style it with 0×0 or
 * opacity 0; `isVisible` rejects those nodes so we never score or click them.
 */
function vintedCategoryNativeRadioQueryable(el) {
  if (!(el instanceof HTMLInputElement)) return false;
  if ((el.type || "").toLowerCase() !== "radio" || el.disabled) return false;
  if (!el.isConnected) return false;
  try {
    const view = el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
    const style = view.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
  } catch {
    return false;
  }
  if (isVisible(el)) return true;
  let cur = el.parentElement;
  for (let d = 0; d < 16 && cur; d++) {
    if (cur instanceof HTMLElement && vintedLayoutInteractable(cur, 32, 16)) return true;
    cur = cur.parentElement;
  }
  return false;
}

/** Deepest visible ancestor that looks like a Vinted list row (clicks here toggle radios). */
function vintedCategoryRowForControl(ctrl) {
  if (!(ctrl instanceof HTMLElement)) return null;
  let cur = ctrl.parentElement;
  for (let d = 0; d < 22 && cur; d++) {
    if (!(cur instanceof HTMLElement) || !vintedLayoutInteractable(cur, 64, 22)) {
      cur = cur.parentElement;
      continue;
    }
    const r = cur.getBoundingClientRect();
    const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
    if (
      r.height >= 22 &&
      r.width >= 64 &&
      t.length >= 6 &&
      t.length < 620 &&
      !/^find a category$/i.test(t) &&
      !/^suggested$/i.test(t) &&
      !/^catalogue sections$/i.test(t) &&
      !/^catalog sections$/i.test(t)
    ) {
      return cur;
    }
    cur = cur.parentElement;
  }
  return null;
}

function vintedFindLabelForInputInDialog(inp, dialog) {
  if (!(inp instanceof HTMLInputElement) || !inp.id || !(dialog instanceof HTMLElement)) return null;
  try {
    for (const lab of querySelectorAllDeep(`label[for="${CSS.escape(inp.id)}"]`, dialog)) {
      if (lab instanceof HTMLElement && vintedLayoutInteractable(lab, 4, 4)) return lab;
    }
  } catch {
    /* ignore */
  }
  try {
    const lab = inp.closest("label");
    if (lab instanceof HTMLElement && vintedLayoutInteractable(lab, 4, 4)) return lab;
  } catch {
    /* ignore */
  }
  return null;
}

function vintedCategoryControlAppearsSelected(el) {
  if (el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "radio") return !!el.checked;
  try {
    if (el && el.getAttribute && el.getAttribute("role") === "radio") {
      return el.getAttribute("aria-checked") === "true";
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Click the visible list row (right / center / left) when the native radio ignores synthetic events. */
function vintedClickVisibleRowForCategoryRadio(radio, win) {
  if (!(radio instanceof HTMLElement)) return false;
  const w = win || window;
  const doc = w.document;
  const start = vintedCategoryRowForControl(radio) || radio.parentElement;
  let cur = start;
  for (let d = 0; d < 18 && cur; d++) {
    if (!(cur instanceof HTMLElement)) {
      cur = cur.parentElement;
      continue;
    }
    const r = cur.getBoundingClientRect();
    const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
    if (r.height >= 22 && r.width >= 64 && t.length >= 6 && t.length < 620 && vintedLayoutInteractable(cur, 64, 22)) {
      try {
        const cy = r.top + r.height / 2;
        const xFracs = [0.9, 0.75, 0.5, 0.2];
        for (const xf of xFracs) {
          const cx = Math.min(r.right - 2, Math.max(r.left + 2, r.left + r.width * xf));
          const hit = doc.elementFromPoint(cx, cy);
          if (hit && hit instanceof HTMLElement && typeof hit.dispatchEvent === "function") {
            try {
              hit.dispatchEvent(
                new PointerEvent("pointerdown", {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: w,
                  clientX: cx,
                  clientY: cy,
                  button: 0,
                  buttons: 1,
                  pointerId: 1,
                  pointerType: "mouse",
                  isPrimary: true,
                })
              );
            } catch {
              /* ignore */
            }
            hit.dispatchEvent(
              new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                composed: true,
                view: w,
                clientX: cx,
                clientY: cy,
              })
            );
            try {
              hit.dispatchEvent(
                new PointerEvent("pointerup", {
                  bubbles: true,
                  cancelable: true,
                  composed: true,
                  view: w,
                  clientX: cx,
                  clientY: cy,
                  button: 0,
                  buttons: 0,
                  pointerId: 1,
                  pointerType: "mouse",
                  isPrimary: true,
                })
              );
            } catch {
              /* ignore */
            }
            hit.dispatchEvent(
              new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
            );
            hit.click();
          }
        }
        cur.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, view: w }));
        cur.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, view: w }));
        cur.click();
        return true;
      } catch {
        /* ignore */
      }
    }
    cur = cur.parentElement;
  }
  return false;
}

/** Walk `elementsFromPoint` within the row so we hit the real interactive layer (not a full-screen transparent div). */
function vintedTryClickElementsFromPointOverRow(controlForState, win, explicitRow) {
  const row =
    explicitRow instanceof HTMLElement ? explicitRow : vintedCategoryRowForControl(controlForState);
  if (!(row instanceof HTMLElement)) return false;
  const w = win || window;
  const doc = w.document;
  const r = row.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return false;
  const cy = r.top + r.height / 2;
  const xs = [r.left + r.width * 0.9, r.left + r.width * 0.55, r.left + r.width * 0.18];
  for (const cx of xs) {
    let stack;
    try {
      stack = doc.elementsFromPoint(cx, cy);
    } catch {
      continue;
    }
    if (!stack || !stack.length) continue;
    for (const hit of stack.slice(0, 12)) {
      if (!(hit instanceof HTMLElement)) continue;
      if (!row.contains(hit)) continue;
      try {
        hit.dispatchEvent(
          new MouseEvent("mousedown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: w,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: 1,
          })
        );
        hit.dispatchEvent(
          new MouseEvent("mouseup", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: w,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: 0,
          })
        );
        hit.click();
      } catch {
        /* ignore */
      }
      if (vintedCategoryControlAppearsSelected(controlForState)) return true;
      try {
        const chk = row.querySelector("input[type=radio]:checked");
        if (chk) return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/** React-controlled radios often ignore `.checked = true`; use the native prototype setter then emit change. */
function vintedSetNativeRadioChecked(inp) {
  if (!(inp instanceof HTMLInputElement) || (inp.type || "").toLowerCase() !== "radio" || inp.disabled) return;
  try {
    const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(inp), "checked");
    if (desc && desc.set) desc.set.call(inp, true);
    else inp.checked = true;
  } catch {
    try {
      inp.checked = true;
    } catch {
      /* ignore */
    }
  }
  try {
    inp.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  } catch {
    /* ignore */
  }
  try {
    inp.dispatchEvent(
      new InputEvent("change", { bubbles: true, composed: true, inputType: "insertReplacementText" })
    );
  } catch {
    /* ignore */
  }
}

function vintedEnsureCategoryRadioSelected(radio, dialog, win) {
  if (!(radio instanceof HTMLElement)) return;
  if (vintedCategoryControlAppearsSelected(radio)) return;
  if (radio instanceof HTMLInputElement && dialog instanceof HTMLElement) {
    const lab = vintedFindLabelForInputInDialog(radio, dialog);
    if (lab) vintedActivateCategoryChoice(lab, win);
  }
  if (vintedCategoryControlAppearsSelected(radio)) return;
  vintedClickVisibleRowForCategoryRadio(radio, win);
  if (vintedCategoryControlAppearsSelected(radio)) return;
  vintedTryClickElementsFromPointOverRow(radio, win);
  if (vintedCategoryControlAppearsSelected(radio)) return;
  if (radio instanceof HTMLInputElement) {
    vintedSetNativeRadioChecked(radio);
  }
}

function vintedCategoryActivationTarget(el) {
  if (!(el instanceof HTMLElement)) return el;
  try {
    if (el.getAttribute("role") === "radio") return el;
    if (el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "radio" && vintedCategoryNativeRadioQueryable(el)) {
      const row = vintedCategoryRowForControl(el);
      return row || el;
    }
    const inRow = el.querySelectorAll && el.querySelectorAll('input[type="radio"]:not([disabled])');
    if (inRow && inRow.length === 1) {
      const inner = inRow[0];
      if (inner instanceof HTMLInputElement && vintedCategoryNativeRadioQueryable(inner)) {
        const row = vintedCategoryRowForControl(inner);
        return row || inner;
      }
    }
    const lab = el.closest("label");
    if (lab instanceof HTMLElement && vintedLayoutInteractable(lab, 4, 4)) return lab;
  } catch {
    /* ignore */
  }
  return el;
}

function vintedActivateCategoryChoice(el, win) {
  const target = vintedCategoryActivationTarget(el);
  if (!(target instanceof HTMLElement)) return;
  const w = win || window;
  try {
    target.scrollIntoView({ block: "nearest", behavior: "auto" });
    target.focus();
  } catch {
    /* ignore */
  }
  const fireKbActivate = () => {
    try {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: " ",
          code: "Space",
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: w,
        })
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: " ",
          code: "Space",
          keyCode: 32,
          which: 32,
          bubbles: true,
          cancelable: true,
          composed: true,
          view: w,
        })
      );
    } catch {
      /* ignore */
    }
  };
  if (target.getAttribute && target.getAttribute("role") === "radio") {
    try {
      const br = target.getBoundingClientRect();
      const cx = br.left + br.width / 2;
      const cy = br.top + br.height / 2;
      try {
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: w,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: 1,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        );
      } catch {
        /* ignore */
      }
      target.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
      );
      try {
        target.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            cancelable: true,
            composed: true,
            view: w,
            clientX: cx,
            clientY: cy,
            button: 0,
            buttons: 0,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          })
        );
      } catch {
        /* ignore */
      }
      target.dispatchEvent(
        new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
      );
      target.click();
      fireKbActivate();
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    const br = target.getBoundingClientRect();
    const cx = br.left + Math.min(br.width * 0.5, 140);
    const cy = br.top + br.height / 2;
    try {
      target.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: w,
          clientX: cx,
          clientY: cy,
          button: 0,
          buttons: 1,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        })
      );
    } catch {
      /* ignore */
    }
    target.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
    );
    try {
      target.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          composed: true,
          view: w,
          clientX: cx,
          clientY: cy,
          button: 0,
          buttons: 0,
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
        })
      );
    } catch {
      /* ignore */
    }
    target.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
    );
    target.click();
    target.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, view: w, clientX: cx, clientY: cy })
    );
    fireKbActivate();
  } catch {
    /* ignore */
  }
  if (target instanceof HTMLInputElement && target.type === "radio" && !target.checked) {
    try {
      target.click();
    } catch {
      /* ignore */
    }
  }
}

function vintedCategoryOptionCandidates(dialog) {
  const out = [];
  try {
    const nodes = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], [role="menuitemradio"], [role="row"], [role="listitem"], [role="gridcell"], li, button, a, label, div[tabindex="0"], div[tabindex="-1"], span[tabindex="0"], span[tabindex="-1"]',
      dialog
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 8, 8)) continue;
      if (el.tagName === "LI") {
        const inner = el.querySelector("button, a, [role='button']");
        if (inner && vintedLayoutInteractable(inner, 8, 8)) continue;
      }
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 1 || t.length > 300) continue;
      if (/^(back|close|cancel|done|apply|ok|save|skip|clear)$/i.test(t)) continue;
      if (/^select all$/i.test(t)) continue;
      out.push(el);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function vintedClickCategoryConfirmIfPresent(dialog) {
  try {
    for (const b of querySelectorAllDeep("button, [role='button']", dialog)) {
      if (!(b instanceof HTMLElement) || !vintedLayoutInteractable(b, 8, 8)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const al = (b.getAttribute("aria-label") || "").toLowerCase();
      if (/^(done|apply|ok|save|select)$/i.test(t) || /\bconfirm\b|\bchoose\b.*\bcategor/i.test(al)) {
        b.click();
        return true;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * @returns {boolean} true if category already set, or we performed an action (open / click / search) this tick.
 */
function vintedIsGenericCategoryLeaf(seg) {
  const s = vintedNormCat(seg);
  if (!s || s.length < 3) return true;
  return /\b(apparel|clothing|general|misc|other|default|uncategor|unspec|inventory|product|goods|items?)\b/.test(s);
}

/** When session only has Shopify-style “Apparel”, infer a Vinted catalogue path so the hierarchy can advance. */
function vintedGuessCategoryHierarchyFromScan(scan) {
  const t = [scan && scan.title, scan && scan.description].filter(Boolean).join(" \n ").toLowerCase();
  if (!t.trim()) return "";
  const isWomen = /\b(women|womens|woman|ladies|lady|female|girls?)\b/.test(t);
  const isMen = /\b(men|mens|male|guy|boys?)\b/.test(t);
  const isKids = /\b(kids?|child|children|youth|junior)\b/.test(t);
  const dept = isKids ? "Kids" : isWomen && !isMen ? "Women" : "Men";
  if (/\b(t-?shirt|tee|tshirt|tank\s*top)\b/.test(t) || /\b(band|graphic|logo|tour|print)\b.*\b(tee|shirt)\b/.test(t)) {
    return `${dept} > Clothing > Tops & t-shirts > T-shirts`;
  }
  if (/\b(hoodie|sweatshirt|jumper|sweater)\b/.test(t)) return `${dept} > Clothing > Hoodies & sweatshirts`;
  if (/\b(jean|denim)\b/.test(t)) return `${dept} > Clothing > Jeans`;
  if (/\b(shorts?)\b/.test(t)) return `${dept} > Clothing > Shorts`;
  if (/\b(skirt)\b/.test(t)) return `${dept} > Clothing > Skirts`;
  if (/\b(dress|dresses)\b/.test(t)) return `${dept} > Clothing > Dresses`;
  if (/\b(jacket|coat)\b/.test(t)) return `${dept} > Clothing > Jackets & coats`;
  if (/\b(shirt|blouse)\b/.test(t) && !/\bt-?shirt\b/.test(t)) return `${dept} > Clothing > Shirts & blouses`;
  return `${dept} > Clothing > Tops & t-shirts > T-shirts`;
}

function vintedResolveCategoryForFill(scan, v) {
  let cat = v && v.category != null ? String(v.category).trim() : "";
  if (!cat && scan && scan.listing_extra && typeof scan.listing_extra === "object") {
    const sh = scan.listing_extra.shopify;
    if (sh && typeof sh === "object") {
      cat = String(sh.category || sh.product_type || sh.category_suggested || "").trim();
    }
  }
  const segs = vintedParseCategorySegments(cat);
  if (segs.length === 1 && vintedIsGenericCategoryLeaf(segs[0]) && scan) {
    const guess = vintedGuessCategoryHierarchyFromScan(scan);
    if (guess) return guess;
  }
  if (!cat && scan) {
    const guess = vintedGuessCategoryHierarchyFromScan(scan);
    if (guess) return guess;
  }
  return cat;
}

/** Extra score for Suggested rows vs scan (e.g. “Print t-shirts” + band tee title). */
function vintedScanSuggestedCategoryBoost(scan, optionText) {
  if (!scan || !optionText) return 0;
  const t = [scan.title, scan.description].filter(Boolean).join(" \n ").toLowerCase();
  if (!t.trim()) return 0;
  const txt = String(optionText).replace(/\s+/g, " ").toLowerCase();
  let b = 0;
  if (/\bprint\b.*t-?shirt|t-?shirt.*\bprint\b/.test(txt) || /print\s+t-?shirts?/.test(txt)) {
    if (/\b(t-?shirt|tee|graphic|band|logo|print|tour)\b/.test(t)) b += 58;
  }
  if (/\bmen\b/.test(txt) && /\b(men|mens|male|guy|boys?)\b/.test(t)) b += 44;
  if (/\bwomen\b/.test(txt) && /\b(women|womens|ladies|female|girls?)\b/.test(t)) b += 44;
  if (/\bkids\b/.test(txt) && /\b(kids?|child|youth|junior)\b/.test(t)) b += 44;
  if (/[>›»→|]/.test(txt) && /\b(t-?shirt|tops?|clothing|jeans?|dress)\b/.test(t) && /\b(t-?shirt|tops?|jeans?|dress)\b/.test(txt))
    b += 22;
  return b;
}

function vintedCategoryLabelTextAroundRadio(radio) {
  if (!(radio instanceof HTMLElement)) return "";
  let best = "";
  let cur = radio;
  for (let d = 0; d < 12 && cur; d++) {
    const t = (cur.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > best.length && t.length <= 400 && t.length >= 4) best = t;
    cur = cur.parentElement;
  }
  return best;
}

/**
 * Select the same Suggested row a human would: find a compact box whose text is “Print t-shirts” + breadcrumb
 * (or matches the target path), then activate + set the native radio. Does not rely on scoring radios first.
 */
function vintedTrySelectSuggestedLeafRowDirect(dialog, scanOpt, st, win, categoryStr) {
  if (!(dialog instanceof HTMLElement) || !st || !Array.isArray(st.segments) || !st.segments.length) return false;
  const segments = st.segments;
  const lastSeg = vintedNormCat(segments[segments.length - 1] || "");
  const catBlob = vintedNormCat(String(categoryStr || ""));
  const scanBlob = scanOpt
    ? [scanOpt.title, scanOpt.description].filter(Boolean).join(" \n ").toLowerCase()
    : "";
  const candidates = [];
  try {
    const nodes = querySelectorAllDeep(
      'div, li, span, p, label, button, a, article, section, [role="button"], [role="option"], [role="radio"], [role="row"]',
      dialog
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 48, 20)) continue;
      const br = el.getBoundingClientRect();
      if (br.width < 52 || br.height < 18 || br.height > 200) continue;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length < 12 || txt.length > 420) continue;
      if (/^find a category$/i.test(txt) || /^suggested$/i.test(txt) || /^catalogue sections$/i.test(txt)) continue;
      if (!/[>›»→|]/.test(txt)) continue;
      const tl = txt.toLowerCase();
      let match = false;
      if (/\bprint\b/.test(tl) && /t[\s-]*shirts?|\btees?\b/.test(tl)) match = true;
      if (!match && lastSeg.length > 1 && (tl.includes(lastSeg) || vintedBestScoreForSegment(lastSeg, txt) >= 88)) {
        match = true;
      }
      if (!match && vintedSuggestedRowCompletesCategory(txt, segments)) match = true;
      if (!match && catBlob.length > 3 && tl.includes(catBlob.slice(0, Math.min(28, catBlob.length)))) match = true;
      if (!match && scanBlob && /\b(print|tee|graphic|band)\b/.test(scanBlob) && /\bt[\s-]*shirts?\b/.test(tl)) {
        match = true;
      }
      if (!match) continue;
      const area = br.width * br.height;
      if (area > 500000) continue;
      candidates.push({ el, area, h: br.height, txt });
    }
  } catch {
    return false;
  }
  if (!candidates.length) return false;
  const withRadio = candidates.filter((c) => {
    try {
      return querySelectorAllDeep('input[type="radio"]:not([disabled])', c.el).length > 0;
    } catch {
      return false;
    }
  });
  const pool = withRadio.length ? withRadio : candidates;
  pool.sort((a, b) => {
    const ha = a.h >= 20 && a.h <= 160 ? 0 : 1;
    const hb = b.h >= 20 && b.h <= 160 ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return a.area - b.area;
  });
  const pick = pool[0];
  vintedActivateCategoryChoice(pick.el, win);
  let rad = null;
  try {
    for (const inp of querySelectorAllDeep('input[type="radio"]:not([disabled])', pick.el)) {
      if (inp instanceof HTMLInputElement) {
        rad = inp;
        break;
      }
    }
  } catch {
    /* ignore */
  }
  if (rad) {
    vintedSetNativeRadioChecked(rad);
    vintedEnsureCategoryRadioSelected(rad, dialog, win);
  } else {
    vintedTryClickElementsFromPointOverRow(pick.el, win, pick.el);
  }
  const tail = pick.txt.toLowerCase();
  const done =
    vintedSuggestedRowCompletesCategory(pick.txt, segments) ||
    (/\bprint\b/.test(tail) && /t[\s-]*shirts?|\btees?\b/.test(tail) && /[>›»→|]/.test(pick.txt));
  if (done) st.idx = segments.length;
  else st.idx += 1;
  return true;
}

/**
 * Vinted commits category from **radio** rows (esp. Suggested). Row `div` clicks often don’t toggle the radio.
 * @returns {boolean} true if we clicked a plausible radio this tick.
 */
function vintedTrySelectBestCategoryRadio(dialog, scanOpt, st, win) {
  if (!(dialog instanceof HTMLElement) || !st || !Array.isArray(st.segments) || !st.segments.length) return false;
  const segments = st.segments;
  let bestRadio = null;
  let bestSc = -1;
  let bestLabel = "";
  const nodes = [];
  try {
    for (const r of querySelectorAllDeep('input[type="radio"]:not([disabled])', dialog)) {
      if (r instanceof HTMLInputElement && vintedCategoryNativeRadioQueryable(r)) nodes.push(r);
    }
    for (const r of querySelectorAllDeep('[role="radio"]', dialog)) {
      if (!(r instanceof HTMLElement) || !vintedLayoutInteractable(r, 8, 8) || nodes.includes(r)) continue;
      if (r.querySelector && r.querySelector('input[type="radio"]')) continue;
      nodes.push(r);
    }
  } catch {
    return false;
  }
  for (const node of nodes) {
    const radio = node instanceof HTMLInputElement ? node : null;
    const roleRadio = !radio && node instanceof HTMLElement ? node : null;
    const labelTxt = radio
      ? vintedCategoryLabelTextAroundRadio(radio)
      : (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
    if (labelTxt.length < 4) continue;
    let sc = 0;
    for (const seg of segments) {
      sc = Math.max(sc, vintedBestScoreForSegment(vintedNormCat(seg), labelTxt));
    }
    if (/[>›»→|]/.test(labelTxt)) sc += 28;
    sc += vintedScanSuggestedCategoryBoost(scanOpt, labelTxt);
    const low = labelTxt.toLowerCase();
    if ((/\bprint\b.*t-?shirt|print\s+t-?shirts?/.test(low) || /\bt-?shirt.*\bprint\b/.test(low)) && /[>›»→|]/.test(labelTxt)) {
      sc += 85;
    }
    if (vintedSuggestedRowCompletesCategory(labelTxt, segments)) sc += 95;
    if (sc > bestSc) {
      bestSc = sc;
      bestRadio = radio || roleRadio;
      bestLabel = labelTxt;
    }
  }
  const isPrintSuggestedRow =
    /[>›»→|]/.test(bestLabel) &&
    /\bprint\b.*t-?shirt|print\s+t-?shirts?|t-?shirt.*\bprint\b/i.test(bestLabel.toLowerCase());
  if (!bestRadio || (bestSc < 42 && !isPrintSuggestedRow)) return false;
  vintedActivateCategoryChoice(bestRadio, win);
  vintedEnsureCategoryRadioSelected(bestRadio, dialog, win);
  const done =
    bestSc >= 70 ||
    vintedSuggestedRowCompletesCategory(bestLabel, segments) ||
    isPrintSuggestedRow ||
    (/[>›»→|]/.test(bestLabel) &&
      /\b(print|graphic|band|logo|tour|t-?shirt|tees?)\b/i.test(bestLabel) &&
      /\b(men|women|kids)\b/i.test(bestLabel));
  if (done) {
    st.idx = segments.length;
  } else {
    st.idx += 1;
  }
  return true;
}

/**
 * When radios are in a closed shadow tree or clicks on inputs are ignored, match a visible “breadcrumb” row
 * (e.g. Print t-shirts + Men > … > T-shirts) and activate it like a user tap.
 */
function vintedTryClickSuggestedCategoryBreadcrumbRow(dialog, scanOpt, st, win) {
  if (!(dialog instanceof HTMLElement) || !st || !Array.isArray(st.segments) || !st.segments.length) return false;
  const segments = st.segments;
  const markers = vintedFindSuggestedCatalogueMarkers(dialog);
  let bestEl = null;
  let bestSc = -1;
  let bestTxt = "";
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="option"], [role="radio"], li, div[tabindex], span[tabindex], label, a, section, article',
      dialog
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 48, 16)) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 48 || box.height < 16) continue;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length < 10 || txt.length > 360) continue;
      if (!/[>›»→|]/.test(txt)) continue;
      if (/^find a category$/i.test(txt)) continue;
      let sc = 0;
      for (const seg of segments) {
        sc = Math.max(sc, vintedBestScoreForSegment(vintedNormCat(seg), txt));
      }
      if (/[>›»→|]/.test(txt)) sc += 28;
      sc += vintedScanSuggestedCategoryBoost(scanOpt, txt);
      const low = txt.toLowerCase();
      if ((/\bprint\b.*t-?shirt|print\s+t-?shirts?/.test(low) || /\bt-?shirt.*\bprint\b/.test(low)) && /[>›»→|]/.test(txt)) {
        sc += 85;
      }
      if (vintedSuggestedRowCompletesCategory(txt, segments)) sc += 95;
      if (vintedIsInSuggestedSection(el, markers)) {
        sc += 40;
        if (/[>›»→|]/.test(txt)) sc += 22;
      }
      if (sc > bestSc) {
        bestSc = sc;
        bestEl = el;
        bestTxt = txt;
      }
    }
  } catch {
    return false;
  }
  const isPrintSuggestedRow =
    !!bestTxt &&
    /[>›»→|]/.test(bestTxt) &&
    /\bprint\b.*t-?shirt|print\s+t-?shirts?|t-?shirt.*\bprint\b/i.test(bestTxt.toLowerCase());
  const completes = bestTxt && vintedSuggestedRowCompletesCategory(bestTxt, segments);
  if (!bestEl || (bestSc < 38 && !isPrintSuggestedRow && !completes)) return false;
  vintedActivateCategoryChoice(bestEl, win);
  const done =
    bestSc >= 70 ||
    !!completes ||
    isPrintSuggestedRow ||
    (/[>›»→|]/.test(bestTxt) &&
      /\b(print|graphic|band|logo|tour|t-?shirt|tees?)\b/i.test(bestTxt) &&
      /\b(men|women|kids)\b/i.test(bestTxt));
  if (done) {
    st.idx = segments.length;
  } else {
    st.idx += 1;
  }
  return true;
}

/**
 * Load a small script in the **page** JS realm (not the isolated content-script world) so Vinted’s
 * React handlers see the same events as a normal script on the site.
 */
function vintedInjectPageWorldCategoryPick(st, categoryStr) {
  const host = (typeof location !== "undefined" && location.hostname) || "";
  if (!/vinted\./i.test(host)) return;
  if (typeof document === "undefined") return;
  try {
    if (!chrome || !chrome.runtime || typeof chrome.runtime.getURL !== "function") return;
  } catch {
    return;
  }
  try {
    const payload = {
      segments: Array.isArray(st.segments) ? st.segments.slice() : [],
      categoryStr: String(categoryStr || "").slice(0, 500),
    };
    const jsonId = "synclyst-vinted-pick-json";
    try {
      document.getElementById(jsonId)?.remove();
    } catch {
      /* ignore */
    }
    const jsonEl = document.createElement("script");
    jsonEl.id = jsonId;
    jsonEl.type = "application/json";
    jsonEl.textContent = JSON.stringify(payload);
    const root = document.documentElement || document.head || document.body;
    root.appendChild(jsonEl);
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("vinted-pick-runner.js");
    s.async = true;
    s.onload = () => {
      try {
        s.remove();
      } catch {
        /* ignore */
      }
      try {
        document.getElementById(jsonId)?.remove();
      } catch {
        /* ignore */
      }
    };
    root.appendChild(s);
  } catch {
    /* ignore */
  }
}

/** Page-script inject + background MAIN `executeScript` (top frame only; avoids allFrames injection failures). */
function vintedFireMainWorldCategoryPickThrottled(st, categoryStr) {
  const t = Date.now();
  if (st.__vintedMainPickSentAt && t - st.__vintedMainPickSentAt < 480) return;
  st.__vintedMainPickSentAt = t;
  vintedInjectPageWorldCategoryPick(st, categoryStr);
  if (typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") return;
  try {
    let tabId;
    try {
      const tid = globalThis.__synclystFillSourceTabId;
      if (typeof tid === "number" && Number.isFinite(tid)) tabId = tid;
    } catch {
      /* ignore */
    }
    chrome.runtime.sendMessage({
      type: "SYNCLYST_VINTED_MAIN_PICK_CATEGORY",
      segments: Array.isArray(st.segments) ? st.segments.slice() : [],
      categoryStr: String(categoryStr || "").slice(0, 500),
      tabId,
    });
  } catch {
    /* ignore */
  }
}

function vintedFillCategoryHierarchy(rootEl, raw, scanOpt) {
  const str = String(raw || "").trim();
  if (!str) return false;
  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return false;

  const segments = vintedParseCategorySegments(str);
  if (!segments.length) return false;

  const key = str.slice(0, 400);
  if (!win.__synclystVintedCatProg || win.__synclystVintedCatProg.key !== key) {
    win.__synclystVintedCatProg = {
      key,
      segments,
      idx: 0,
      searchAttemptedFor: -1,
    };
  }
  const st = win.__synclystVintedCatProg;

  const doc = rootEl.ownerDocument || (typeof document !== "undefined" ? document : null);
  const sheetByText = doc ? vintedBodyLooksLikeCategoryPickerOpen(doc) : false;

  let dialog = vintedFindCategoryPickerSurface();

  if (!dialog && sheetByText && st.idx < st.segments.length) {
    vintedFireMainWorldCategoryPickThrottled(st, str);
  }

  if (!dialog) {
    if (vintedCategorySurfaceShowsSelection(rootEl)) {
      const shown = vintedGetCategoryRowDisplayText(rootEl);
      if (
        shown &&
        vintedDisplayedCategoryMatchesTarget(shown, str) &&
        !vintedCategoryRowShowsRequiredError(rootEl)
      ) {
        win.__synclystVintedCatProg = null;
        return true;
      }
      if (shown && !vintedDisplayedCategoryMatchesTarget(shown, str)) {
        st.idx = 0;
        st.searchAttemptedFor = -1;
      }
    }
    if (sheetByText) {
      /** Sheet is open but DOM role=dialog missed — MAIN/page pick already fired; do not reopen. */
      return true;
    }
    const trig = vintedFindCategoryTrigger(rootEl);
    if (!trig) return false;
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.focus();
      trig.click();
    } catch {
      try {
        trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      } catch {
        return false;
      }
    }
    return true;
  }

  dialog = vintedFindCategoryPickerSurface() || dialog;

  if (dialog instanceof HTMLElement && st.idx < st.segments.length) {
    vintedFireMainWorldCategoryPickThrottled(st, str);
  }

  if (st.idx >= st.segments.length) {
    vintedClickCategoryConfirmIfPresent(dialog);
    win.__synclystVintedCatProg = null;
    return true;
  }

  if (vintedTrySelectSuggestedLeafRowDirect(dialog, scanOpt, st, win, str)) {
    if (st.idx >= st.segments.length) {
      vintedClickCategoryConfirmIfPresent(dialog);
      win.__synclystVintedCatProg = null;
    }
    return true;
  }

  if (vintedTrySelectBestCategoryRadio(dialog, scanOpt, st, win)) {
    if (st.idx >= st.segments.length) {
      vintedClickCategoryConfirmIfPresent(dialog);
      win.__synclystVintedCatProg = null;
    }
    return true;
  }

  if (vintedTryClickSuggestedCategoryBreadcrumbRow(dialog, scanOpt, st, win)) {
    if (st.idx >= st.segments.length) {
      vintedClickCategoryConfirmIfPresent(dialog);
      win.__synclystVintedCatProg = null;
    }
    return true;
  }

  const seg = st.segments[st.idx];
  const segNorm = vintedNormCat(seg);
  const candidates = vintedCategoryOptionCandidates(dialog);
  const markers = vintedFindSuggestedCatalogueMarkers(dialog);
  let best = null;
  let bestSc = 0;
  for (const el of candidates) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    let sc = vintedBestScoreForSegment(segNorm, txt);
    if (vintedIsInSuggestedSection(el, markers)) {
      sc += 55;
      if (/[>›»→|]/.test(txt)) sc += 30;
      sc += vintedScanSuggestedCategoryBoost(scanOpt, txt);
    } else if (/[>›»→|]/.test(txt) && /\bprint\b.*t-?shirt|print\s+t-?shirts?/i.test(txt.toLowerCase())) {
      /** Suggested marker missing — still boost Vinted’s “Print t-shirts” + breadcrumb row. */
      sc += 68;
      sc += vintedScanSuggestedCategoryBoost(scanOpt, txt);
    }
    if (sc > bestSc) {
      bestSc = sc;
      best = el;
    }
  }

  const inSuggested = !!(best && vintedIsInSuggestedSection(best, markers));
  const threshold =
    st.searchAttemptedFor === st.idx ? 48 : inSuggested && bestSc >= 42 ? 42 : inSuggested ? 50 : 62;
  if (best && bestSc >= threshold) {
    const pickedText = (best.textContent || "").replace(/\s+/g, " ").trim();
    const pickedInSuggested = vintedIsInSuggestedSection(best, markers);
    vintedActivateCategoryChoice(best, win);
    if (
      pickedInSuggested &&
      (vintedSuggestedRowCompletesCategory(pickedText, st.segments) ||
        (/[>›»→|]/.test(pickedText) &&
          /\b(print|graphic|band|logo|tour|t-?shirt|tees?|tops?\s*&)\b/i.test(pickedText)))
    ) {
      st.idx = st.segments.length;
    } else {
      st.idx += 1;
    }
    if (st.idx >= st.segments.length) {
      vintedClickCategoryConfirmIfPresent(dialog);
      win.__synclystVintedCatProg = null;
    }
    return true;
  }

  const searchInp = vintedFindCategorySearchInput(dialog);
  if (searchInp && st.searchAttemptedFor !== st.idx) {
    fillField(searchInp, seg);
    vintedMaybeSubmitCategorySearch(searchInp, win);
    st.searchAttemptedFor = st.idx;
    return true;
  }

  return false;
}

/**
 * Vinted “Sell an item”: map listing_extra.vinted (or shopify fallback) to Category, Brand, Size,
 * Shoulder width / Length, Condition, Colours, Material — scored by accessible name / placeholder.
 */
function vintedScoreControl(el, hints, negatives) {
  if (!(el instanceof HTMLElement) || !isVisible(el)) return -Infinity;
  if (el instanceof HTMLInputElement) {
    const ty = (el.type || "").toLowerCase();
    if (ty === "hidden" || ty === "file" || ty === "checkbox" || ty === "radio" || ty === "submit") return -Infinity;
  }
  const al = shopifyControlAccessibleName(el).toLowerCase();
  const ph = (el.getAttribute("placeholder") || "").toLowerCase();
  const nm = (el.name || "").toLowerCase();
  const id = (el.id || "").toLowerCase();
  const blob = `${al} ${ph} ${nm} ${id}`;
  for (const neg of negatives) {
    if (new RegExp(neg, "i").test(blob)) return -Infinity;
  }
  let sc = 0;
  for (const h of hints) {
    if (blob.includes(h.toLowerCase())) sc += 42;
  }
  if (el.getAttribute("role") === "combobox" || el.closest('[role="combobox"]')) sc += 12;
  return sc;
}

function vintedFillByHints(rootEl, hints, negatives, val) {
  const str = val != null ? String(val).trim() : "";
  if (!str) return false;
  let best = null;
  let bestSc = -Infinity;
  try {
    const nodes = querySelectorAllDeep("input, textarea, select", rootEl);
    for (const el of nodes) {
      const sc = vintedScoreControl(el, hints, negatives);
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  if (!best || bestSc < 38) return false;
  return fillField(best, str);
}

/**
 * Vinted size dropdown: only use explicit listing data (vision `detected_sizes` → listing_extra, shopify/ebay size).
 * Do not infer from title/description text. If nothing is set, use "One size" so validation clears (EN locale).
 */
function vintedIsGenericOneSizeLabel(sizeRaw) {
  const t = String(sizeRaw || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!t) return false;
  return /^(one[-\s]?size(\s+f(its)?\s*all)?|einheitsgr(o|ö)(ss|ß)e|taille\s*unique|talla\s*única|taglia\s*unica|unique\s*size)$/.test(t);
}

function resolveVintedSizeForFill(scan, v) {
  const t = (x) => (x != null && String(x).trim() ? String(x).trim() : "");
  const blob = `${String(scan && scan.title ? scan.title : "")} ${String(scan && scan.description ? scan.description : "")}`
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const looksLikeLetterSize = (s) => {
    const low = String(s || "").trim().toLowerCase();
    return /^(xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl|7xl|8xl)$/.test(low);
  };
  const hasLabelEvidence = (sizeRaw) => {
    const s = String(sizeRaw || "").trim();
    if (!s) return false;
    if (vintedIsGenericOneSizeLabel(s)) return false;
    const low = s.toLowerCase();
    const esc = low.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // If the scan text doesn't contain the size at all, treat it as "not visible on label".
    // For ambiguous single-letter sizes, require common label context (e.g. "size m", "uk 10").
    if (low.length <= 3) {
      if (/^(xs|s|m|l|xl|2xl|3xl|xxl|xxxl)$/i.test(low)) {
        const ctx = new RegExp(`\\b(size|sz)\\s*[:#-]?\\s*${esc}\\b`, "i");
        if (ctx.test(blob)) return true;
        const alone = new RegExp(`\\b${esc}\\b`, "i");
        return alone.test(blob) && /\b(size|sz)\b/i.test(blob);
      }
      if (/^\d{1,3}$/.test(low)) {
        return new RegExp(`\\b(size|uk|us|eu|cm|mm)\\s*[:#-]?\\s*${esc}\\b`, "i").test(blob);
      }
    }
    // Less ambiguous strings (e.g. "W32 L34", "UK 10") can match directly.
    return blob.includes(low);
  };
  if (v && typeof v === "object") {
    const s0 = t(v.size);
    if (s0 && !vintedIsGenericOneSizeLabel(s0) && hasLabelEvidence(s0)) {
      if (looksLikeLetterSize(s0)) return "One size";
      return s0;
    }
    if (Array.isArray(v.sizes) && v.sizes.length) {
      const s1 = t(v.sizes[0]);
      if (s1 && !vintedIsGenericOneSizeLabel(s1) && hasLabelEvidence(s1)) {
        if (looksLikeLetterSize(s1)) return "One size";
        return s1;
      }
    }
  }
  try {
    const ex = scan && scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : {};
    const sh = ex.shopify && typeof ex.shopify === "object" ? ex.shopify : null;
    if (sh) {
      if (Array.isArray(sh.sizes) && sh.sizes.length) {
        const u = t(sh.sizes[0]);
        if (u && hasLabelEvidence(u)) return looksLikeLetterSize(u) ? "One size" : u;
      }
      const u2 = t(sh.size);
      if (u2 && hasLabelEvidence(u2)) return looksLikeLetterSize(u2) ? "One size" : u2;
    }
    const eb = ex.ebay && typeof ex.ebay === "object" ? ex.ebay : null;
    if (eb) {
      const u3 = t(eb.size);
      if (u3 && hasLabelEvidence(u3)) return looksLikeLetterSize(u3) ? "One size" : u3;
    }
    const vt2 = ex.vinted && typeof ex.vinted === "object" ? ex.vinted : null;
    if (vt2) {
      const u4 = t(vt2.size);
      if (u4 && hasLabelEvidence(u4)) return looksLikeLetterSize(u4) ? "One size" : u4;
      if (Array.isArray(vt2.sizes) && vt2.sizes.length) {
        const u5 = t(vt2.sizes[0]);
        if (u5 && hasLabelEvidence(u5)) return looksLikeLetterSize(u5) ? "One size" : u5;
      }
    }
  } catch {
    /* ignore */
  }
  return "One size";
}

/** Try primary size label, then common Vinted “single size” labels (locale variants). */
function vintedPickSizeWithFallbacks(rootEl, negatives, primary) {
  const raw = String(primary || "").trim();
  const rawLow = raw.toLowerCase();
  const looksLikeLetterSize = /^(xs|s|m|l|xl|xxl|2xl|3xl|4xl|5xl|6xl|7xl|8xl)$/i.test(rawLow);
  const effectivePrimary = looksLikeLetterSize ? "One size" : raw;
  const seen = new Set();
  const tries = [];
  const push = (x) => {
    const s = String(x || "").trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    tries.push(s);
  };
  // If extraction provided a letter size (XS/S/M/L/XL...), prefer "One size" variants so
  // Vinted doesn't stay red or revert back after we clear validation.
  if (!looksLikeLetterSize) push(raw);
  push("One size");
  push("One Size");
  push("ONE SIZE");
  push("OS");
  push("Unisex one size");
  push("One size fits all");
  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  const trig = vintedFindSizeTrigger(rootEl);
  const clickTrigger = () => {
    if (!win || !(trig instanceof HTMLElement)) return false;
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.focus();
      trig.click();
      trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      return true;
    } catch {
      return false;
    }
  };

  const forceSetSizeInputValue = (want, scopeEl) => {
    try {
      const scope = scopeEl || rootEl;
      const inp =
        scope.querySelector &&
        (scope.querySelector('input[data-testid="size-select-dropdown-input"]') ||
          scope.querySelector('input[data-testid="size-select-dropdown-input"][name="size"]'));
      if (!(inp instanceof HTMLInputElement) || inp.disabled) return false;
      const v = String(want || "").trim();
      if (!v) return false;
      inp.scrollIntoView({ block: "nearest", behavior: "auto" });
      inp.focus();
      // React-controlled inputs require using the native setter to update internal value tracking.
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
        if (desc && typeof desc.set === "function") desc.set.call(inp, v);
        else inp.value = v;
      } catch {
        inp.value = v;
      }
      inp.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: v, inputType: "insertText" }));
      inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      inp.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      return true;
    } catch {
      return false;
    }
  };

  const pick = (want, commitToInput = true) => {
    const surface = vintedFindSizePickerSurface();
    const inp = vintedFindSizeSearchInput(surface) || vintedFindSizeSearchInput(document.body);
    if (inp) fillField(inp, want);
    const clickRoot = surface || document.body;
    if (vintedClickMatchingSizeOption(want, clickRoot)) {
      setTimeout(() => vintedCloseActivePicker("size"), 120);
      // Some Vinted flows still require the controlled input to receive input/change.
      // When the field is required (red), only commit via `commitSizeSelection()` using the label that was clicked.
      if (commitToInput) setTimeout(() => forceSetSizeInputValue(want, surface || document.body), 160);
      return true;
    }
    return false;
  };

  /**
   * When Vinted keeps the size row red, it often means the dropdown requires clicking an option
   * (not just typing). If "One size" isn't present/accepted for the chosen category, click the
   * first reasonable option to clear validation.
   */
  const pickAnyVisibleSizeOption = (preferLabel) => {
    const prefer = String(preferLabel || "").trim().toLowerCase();
    try {
      const surface = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body;
      const win = (surface.ownerDocument && surface.ownerDocument.defaultView) || window;
      const opts = querySelectorAllDeep(
        'button, [role="option"], [role="menuitem"], [role="gridcell"], li, label, div[tabindex="0"], span[tabindex="0"]',
        surface
      );
      const usable = [];
      for (const el of opts) {
        if (!(el instanceof HTMLElement) || !vintedLayoutInteractable(el, 4, 4)) continue;
        const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 60) continue;
        const low = tx.toLowerCase();
        if (/select|choose|search|filter|size guide|help|cancel|close/i.test(low)) continue;
        usable.push({ el, tx, low });
      }
      if (!usable.length) return "";
      let best = usable[0];
      if (prefer) {
        const hit = usable.find((u) => u.low === prefer || u.low.includes(prefer) || prefer.includes(u.low));
        if (hit) best = hit;
      }
      const host =
        best.el.closest('label, [role="option"], [role="menuitem"], [role="gridcell"], button, li, div[tabindex="0"], span[tabindex="0"]') ||
        best.el;
      vintedHumanClick(host, win);
      return best.tx;
    } catch {
      return "";
    }
  };

  const commitSizeSelection = (wantLabel, typeToInput = true) => {
    const w = String(wantLabel || effectivePrimary || "One size").trim() || "One size";
    try {
      const dlg = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body;
      // If we only close/confirm first, Vinted often re-renders back to the previous value.
      // Commit the controlled value early, then confirm/close, then commit again.
      if (typeToInput) forceSetSizeInputValue(w, dlg);
      vintedClickSizeConfirmIfPresent(dlg);
      vintedCloseActivePicker("size");
    } catch {
      /* ignore */
    }
    try {
      if (typeToInput) forceSetSizeInputValue(w, dlg);
    } catch {
      /* ignore */
    }
    try {
      const t = vintedFindSizeTrigger(rootEl);
      if (t instanceof HTMLElement && t.getAttribute("aria-expanded") === "true") {
        t.click();
        t.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      }
    } catch {
      /* ignore */
    }
  };

  // If size is required (red), we must select from the list. Otherwise typing may be enough.
  const required = vintedSizeRowShowsRequiredError(rootEl);
  if (trig && required) {
    // If Vinted is still red, brute-force commit "One size" through the actual picker.
    if (!clickTrigger()) return false;
    const attemptPickLabel = () => {
      // In this "required" recovery mode we must NOT select letter sizes like XS/S/M.
      // Only try actual one-size labels first.
      const oneSizeTries = tries.filter((s) => oneSizeSyn.test(String(s || "").toLowerCase()));
      for (const s of oneSizeTries) {
        if (pick(s, false)) return s;
      }
      return "";
    };
    const triedLabels = new Set();
    const forceUntilValid = () => {
      try {
        if (!vintedSizeRowShowsRequiredError(rootEl)) return;
        try {
          vintedForceCommitSizeOneSize(rootEl);
        } catch {
          /* ignore */
        }
        vintedOpenSizePicker(rootEl);
        // Prefer explicit one-size to satisfy user policy.
        let picked = "";
        if (pick("One size", false)) picked = "One size";
        else picked = attemptPickLabel();
        if (!picked) {
          const dlg = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body;
          const oneSizeSyn =
            /\b(one\s*size|one[-\s]?size\s*f(?:its)?\s*all|os\b|unique\s*size|taille\s*unique|einheitsgr(o|ö)ße|talla\s*única|taglia\s*unica|u\b)\b/i;
          if (vintedClickSizeOptionByTextInDialog(dlg, oneSizeSyn)) picked = "One size";
        }
        if (!picked) {
          const cand = pickAnyVisibleSizeOption("One size");
          if (cand && oneSizeSyn.test(String(cand).toLowerCase())) picked = cand;
        }
        if (picked) triedLabels.add(String(picked).toLowerCase());
        // Commit by confirming/closing the picker; do not type into the input (Vinted requires a real option click).
        // But Vinted can later re-render and revert to the previous value (e.g. XS) unless the
        // controlled input value is also committed. Only do this for one-size labels.
        if (picked) commitSizeSelection(picked, true);

        // If still red after a short delay, try a different option next tick.
        setTimeout(() => {
          try {
            if (!vintedSizeRowShowsRequiredError(rootEl)) return;
            clickTrigger();
            const alt = pickAnyVisibleSizeOption("One size");
            const altLow = String(alt || "").toLowerCase();
            if (alt && oneSizeSyn.test(String(alt).toLowerCase()) && !triedLabels.has(altLow)) {
              triedLabels.add(altLow);
              commitSizeSelection(alt, true);
            }
          } catch {
            /* ignore */
          }
        }, 220);
      } catch {
        /* ignore */
      }
    };

    const firstPicked = attemptPickLabel();
    if (firstPicked) {
      [140, 320, 520].forEach((ms) => setTimeout(() => commitSizeSelection(firstPicked), ms));
    }
    // Give Vinted more time to validate and clear the red helper text.
    [0, 120, 260, 420, 700, 1100, 1600, 2400, 3200, 4200, 5200, 6500, 8000].forEach((ms) =>
      setTimeout(forceUntilValid, ms)
    );

    // If it STILL remains required, we likely can't synthesize the trusted gesture Vinted expects on this UI.
    // Make it one-click for the user: leave the picker open, pre-search "One size", and highlight the best option.
    const showOneClickAssist = () => {
      try {
        if (!vintedSizeRowShowsRequiredError(rootEl)) return;
        vintedOpenSizePicker(rootEl);
        const dlg = vintedFindActiveSizeDialog() || vintedFindSizePickerSurface() || document.body;
        const inp = vintedFindSizeSearchInput(dlg) || vintedFindSizeSearchInput(document.body);
        if (inp instanceof HTMLInputElement) {
          fillField(inp, "One size");
        }
        // Highlight matching option for an easy manual click.
        const oneSizeSyn =
          /\b(one\s*size|one[-\s]?size\s*f(?:its)?\s*all|os\b|unique\s*size|taille\s*unique|einheitsgr(o|ö)ße|talla\s*única|taglia\s*unica|u\b)\b/i;
        const host = vintedFindBestClickableOptionHostByText(dlg, oneSizeSyn) || null;
        if (host) {
          vintedAssistHighlightOnce(
            host,
            `Vinted needs a real click. Please click <b>One size</b> in the dropdown to clear the red error.`
          );
        } else {
          vintedShowAssistToast(
            `Vinted needs a real click. Please click <b>One size</b> in the dropdown to clear the red error.`,
            null
          );
        }
        // NOTE: we intentionally do NOT auto-close here so the user can click once to lock selection.
      } catch {
        /* ignore */
      }
    };
    // Show assist early (so you can act immediately), and re-show later in case the sheet animates in.
    [900, 2200, 4200].forEach((ms) => setTimeout(showOneClickAssist, ms));
    return true;
  }

  for (const s of tries) {
    if (vintedFillByHints(rootEl, ["size"], negatives, s)) return true;
  }
  // Last resort: force set the size input value to clear validation.
  if (forceSetSizeInputValue(effectivePrimary || "One size")) return true;
  return false;
}

function fillVintedListingExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  let n = 0;
  const priceFilled = vintedForceFillPriceFromScan(scan, root);
  n += priceFilled;
  /** Only fall back to the page-realm fill if the isolated-world attempt didn't land — avoids both racing the same field. */
  if (!priceFilled) {
    const pv0 = resolveVintedPriceStringForFill(scan);
    if (pv0) vintedFireMainWorldPriceThrottled(pv0);
  }
  const raw = scan.listing_extra;
  let v = null;
  if (raw && typeof raw === "object") {
    const vt = raw.vinted;
    if (vt && typeof vt === "object" && Object.keys(vt).length > 0) v = vt;
    else if (raw.shopify && typeof raw.shopify === "object") v = raw.shopify;
  }
  if (!v || typeof v !== "object") return 0;

  const negCommon = ["feedback", "search the help", "coupon", "promo"];
  const brandRaw =
    v.brand != null && String(v.brand).trim() ? v.brand : v.vendor != null ? String(v.vendor).trim() : "";
  const brandVal = vintedBrandMeansNoBrand(brandRaw) ? "" : String(brandRaw).trim();
  const negSize = [...negCommon, "parcel", "postage", "shipping"];
  const sizeVal = resolveVintedSizeForFill(scan, v);
  {
    const catResolved = vintedResolveCategoryForFill(scan, v);
    if (
      vintedFillCategoryHierarchy(rootEl, catResolved, scan) ||
      vintedFillByHints(rootEl, ["category"], [...negCommon, "parcel", "postage", "shipping"], catResolved)
    ) {
      n++;
    }
  }
  // Brand: if missing/unknown, pick "No brand" so the required field clears.
  if (brandVal) {
    if (vintedFillBrandDropdown(rootEl, brandVal)) n++;
  } else {
    try {
      if (vintedFillBrandDropdown(rootEl, "")) n++;
    } catch {
      /* ignore */
    }
  }
  if (sizeVal && vintedPickSizeWithFallbacks(rootEl, negSize, sizeVal)) n++;
  // Vinted sometimes shows "One size" but still keeps the field red until an option click is committed.
  // Ensure the required error is cleared by forcing a real picker selection.
  try {
    const ensureSizeCommitted = () => {
      try {
        const cur = vintedGetCurrentSizeValue(rootEl);
        const required = vintedSizeRowShowsRequiredError(rootEl);
        // If Vinted defaulted to XS/S/M/L… (or reverted), override to One size.
        if (!required && !vintedSizeLooksLikeLetterSize(cur)) return;
        vintedForceCommitSizeOneSize(rootEl);
      } catch {
        /* ignore */
      }
    };
    [0, 160, 320, 520, 900, 1400, 2200, 3200].forEach((ms) => setTimeout(ensureSizeCommitted, ms));
  } catch {
    /* ignore */
  }
  if (vintedFillByHints(rootEl, ["shoulder"], negCommon, v.shoulder_width_in)) n++;
  if (vintedFillByHints(rootEl, ["length"], [...negCommon, "description", "title", "shoulder"], v.length_in)) n++;
  {
    const condResolved = vintedResolveConditionForFill(scan, v);
    if (condResolved && vintedFillConditionDropdown(rootEl, condResolved)) n++;
  }
  if (vintedFillByHints(rootEl, ["material"], negCommon, v.material)) n++;
  {
    const colsResolved = resolveVintedColoursForFill(scan, v);
    if (colsResolved.length && vintedFillColoursDropdown(rootEl, colsResolved)) n++;
  }

  return n;
}

/**
 * eBay’s native “Suggested item specifics” (eBay.ai) card exposes checkboxes plus **Apply all**.
 * SyncLyst cannot write those fields directly; one click applies eBay’s suggestions into the form.
 * No-op when the card is missing or already handled for this tab (see `__synclystEbaySuggestedApplyDone`).
 */
function ebayTryApplySuggestedItemSpecifics(root) {
  const rootEl = documentRootElement(root);
  let win = window;
  try {
    win = rootEl.ownerDocument && rootEl.ownerDocument.defaultView ? rootEl.ownerDocument.defaultView : window;
  } catch {
    win = window;
  }
  try {
    if (win.__synclystEbaySuggestedApplyDone) return 0;
  } catch {
    return 0;
  }

  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const looksLikeApplyAll = (t) => /^apply all$/i.test(t) || /^apply\s+all\b/i.test(t);

  const hasSuggestedContext = (el) => {
    let p = el;
    let blob = "";
    for (let i = 0; i < 20 && p; i++) {
      blob += (p.textContent || "").slice(0, 600);
      p = p.parentElement;
    }
    const low = blob.toLowerCase();
    return (
      /suggested\s+item\s+specifics/.test(low) ||
      /quickly\s+add\s+item\s+specifics/.test(low) ||
      (/ebay\.ai/.test(low) && /item\s+specifics/.test(low))
    );
  };

  const tagRank = (el) => {
    if (!(el instanceof HTMLElement)) return 0;
    if (el.tagName === "BUTTON") return 40;
    if (el.getAttribute("role") === "button") return 35;
    if (el.tagName === "A") return 30;
    if (el.tagName === "SPAN") return 12;
    if (el.tagName === "DIV") return 8;
    return 5;
  };

  /** @type {HTMLElement[]} */
  const hits = [];
  const sels = ['button', 'a[href]', "a", '[role="button"]', "span", "div"];
  for (const sel of sels) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      const aria = norm(el.getAttribute("aria-label"));
      const t = norm(el.textContent);
      const byText = looksLikeApplyAll(t);
      const byAria = looksLikeApplyAll(aria);
      if (!byText && !byAria) continue;
      if (el.tagName === "SPAN" && t.length > 24 && !byAria) continue;
      if (el.tagName === "DIV" && !el.getAttribute("role") && el.tabIndex < 0 && !byAria) continue;
      if (!(isVisible(el) || vintedLayoutInteractable(el))) continue;
      if (!hasSuggestedContext(el)) continue;
      hits.push(el);
    }
  }

  if (!hits.length) return 0;

  hits.sort((a, b) => tagRank(b) - tagRank(a));
  const best = hits[0];

  try {
    best.scrollIntoView({ block: "center", behavior: "instant" });
  } catch {
    /* ignore */
  }

  try {
    if (typeof PointerEvent !== "undefined") {
      best.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: win }));
    } else {
      best.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
    }
    best.click();
    win.__synclystEbaySuggestedApplyDone = true;
    return 1;
  } catch {
    return 0;
  }
}

/**
 * eBay “Complete your listing”: item specifics, pricing, shipping — keyed like extension-review
 * `listing_extra.ebay` (and Shopify fallbacks merged in review when ebay block is empty).
 */
function fillEbayListingExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  const raw = scan.listing_extra;
  let e = null;
  if (raw && typeof raw === "object") {
    const eb = raw.ebay;
    if (eb && typeof eb === "object" && Object.keys(eb).length > 0) e = eb;
  }
  if (!e || typeof e !== "object") return 0;

  const neg = ["search", "feedback", "help", "coupon", "promo", "vehicle"];
  const negTitle = [...neg, "listing", "page", "meta", "seo", "subtitle"];
  let n = 0;

  const hint = (hints, negatives, val) => {
    const str = val != null ? String(val).trim() : "";
    if (!str) return false;
    return vintedFillByHints(rootEl, hints, negatives, str);
  };

  if (hint(["brand"], [...neg, "model number", "mpn"], e.brand)) n++;
  if (hint(["size"], [...neg, "parcel", "quantity", "lot", "sold"], e.size)) n++;
  {
    // eBay item specifics often require choosing a dropdown option (not just typing).
    // Prefer exact detected colors list when present; otherwise split the single color string.
    const rawColors =
      e.colors != null
        ? e.colors
        : e.colours != null
          ? e.colours
          : e.color != null
            ? e.color
            : "";
    const list = Array.isArray(rawColors)
      ? rawColors.map((c) => String(c).trim()).filter(Boolean)
      : String(rawColors || "")
          .split(/[,;/]/)
          .map((c) => c.trim())
          .filter(Boolean);
    const seen = new Set();
    const tries = [];
    const push = (x) => {
      const s = String(x || "").replace(/\s+/g, " ").trim();
      if (!s) return;
      const k = s.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      tries.push(s);
    };
    for (const c of list) push(c);
    // Common normalization for eBay labels.
    if (tries.length) {
      const c0 = tries[0].toLowerCase();
      if (c0 === "grey") push("Gray");
      if (c0 === "gray") push("Grey");
      if (c0 === "multi" || c0 === "multicolor" || c0 === "multi-color") push("Multicolor");
    }

    let did = false;
    for (const c of tries) {
      if (depopPickComboboxConfirmed(rootEl, ["color", "colour"], neg, c)) {
        did = true;
        break;
      }
    }
    if (!did) {
      // Fallback: typed fill for pages that use plain inputs.
      if (hint(["color", "colour"], neg, tries[0] || "")) did = true;
    }
    if (did) n++;
  }
  if (hint(["department"], neg, e.department)) n++;
  if (hint(["upc", "gtin"], neg, e.upc)) n++;
  if (hint(["type"], [...negTitle, "title"], e.item_type)) n++;
  if (hint(["theme"], neg, e.theme)) n++;
  if (hint(["sleeve"], neg, e.sleeve_length)) n++;
  if (hint(["character"], neg, e.character)) n++;
  if (hint(["pattern"], neg, e.pattern)) n++;
  if (hint(["condition"], [...neg, "description", "disclose", "flaw"], e.condition)) n++;

  // Listing format: always prefer Buy It Now (fixed price).
  {
    const fmtRaw = String(e.pricing_format || "").toLowerCase();
    const wantsBin = fmtRaw === "buy_it_now" || fmtRaw === "fixed" || fmtRaw === "fixed_price" || !fmtRaw;
    const tries = wantsBin
      ? ["Buy it now", "Buy It Now", "Fixed price", "Fixed Price"]
      : ["Auction", "auction"];
    let did = false;
    for (const lab of tries) {
      if (depopPickComboboxConfirmed(rootEl, ["format", "pricing format"], [...neg, "description", "subtitle"], lab)) {
        did = true;
        break;
      }
    }
    if (!did && wantsBin) {
      // Last resort: type into a plain input if the page doesn't use a combobox.
      if (hint(["format"], [...neg, "description"], "Buy it now")) did = true;
    }
    if (did) n++;
  }

  const catLine = [e.category_leaf, e.category_breadcrumb].filter(Boolean).join(" — ");
  if (catLine && hint(["category"], [...neg, "store", "motors"], catLine)) n++;

  if (hint(["quantity"], [...neg, "sold", "order", "available", "inventory"], e.quantity)) n++;

  if (e.shipping_method != null && String(e.shipping_method).trim()) {
    if (hint(["shipping"], neg, String(e.shipping_method).trim())) n++;
  }
  if (e.package_weight_lbs != null && String(e.package_weight_lbs).trim()) {
    if (hint(["lbs"], [...neg, "item weight", "product weight"], String(e.package_weight_lbs).trim())) n++;
  }
  if (e.package_weight_oz != null && String(e.package_weight_oz).trim()) {
    if (hint(["oz"], [...neg, "fluid", "volume"], String(e.package_weight_oz).trim())) n++;
  }
  const dimNeg = [...neg, "item", "screen"];
  if (e.package_length_in != null && String(e.package_length_in).trim()) {
    if (hint(["length"], dimNeg, String(e.package_length_in).trim())) n++;
  }
  if (e.package_width_in != null && String(e.package_width_in).trim()) {
    if (hint(["width"], dimNeg, String(e.package_width_in).trim())) n++;
  }
  if (e.package_height_in != null && String(e.package_height_in).trim()) {
    if (hint(["height"], dimNeg, String(e.package_height_in).trim())) n++;
  }
  if (e.domestic_cost_type != null && String(e.domestic_cost_type).trim()) {
    if (hint(["cost type", "shipping cost", "flat rate"], neg, String(e.domestic_cost_type).trim())) n++;
  }
  if (e.country_of_origin != null && String(e.country_of_origin).trim()) {
    if (hint(["country of origin", "origin"], neg, String(e.country_of_origin).trim())) n++;
  }

  const fmt = String(e.pricing_format || "").toLowerCase();
  const scanP = normalizeMarketplacePriceString(scan.price);
  let startVal = e.starting_bid != null ? String(e.starting_bid).trim() : "";
  let binVal = e.buy_it_now_price != null ? String(e.buy_it_now_price).trim() : "";
  if (!startVal && !binVal && scanP) {
    if (fmt === "buy_it_now") binVal = scanP;
    else startVal = scanP;
  }
  if (startVal && hint(["starting bid", "start bid"], ["buy it now", "reserve", "bin", "optional"], startVal)) {
    n++;
  }
  if (binVal && hint(["buy it now", "buy now"], ["starting", "reserve", "auction"], binVal)) n++;
  if (e.reserve_price != null && String(e.reserve_price).trim()) {
    if (hint(["reserve"], ["buy it", "starting"], String(e.reserve_price).trim())) n++;
  }

  const dur = e.auction_duration_days != null ? String(e.auction_duration_days).trim() : "";
  if (dur) {
    try {
      const selects = querySelectorAllDeep("select", rootEl);
      for (const sel of selects) {
        if (!(sel instanceof HTMLSelectElement) || !isVisible(sel)) continue;
        const ctx = `${sel.getAttribute("aria-label") || ""} ${sel.closest("div")?.textContent || ""}`.toLowerCase();
        if (!/duration|auction|days/i.test(ctx)) continue;
        const opt = Array.from(sel.options).find(
          (o) =>
            o.value === dur ||
            new RegExp(`^${dur}\\s*day`, "i").test((o.textContent || "").trim()) ||
            (o.textContent || "").includes(`${dur} day`)
        );
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          n++;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (e.require_immediate_payment) {
    try {
      for (const c of querySelectorAllDeep('input[type="checkbox"]', rootEl)) {
        if (!(c instanceof HTMLInputElement) || !isVisible(c)) continue;
        const lab = `${c.closest("label")?.textContent || ""} ${c.getAttribute("aria-label") || ""}`.toLowerCase();
        if (!/immediate payment|pay now|require payment/i.test(lab)) continue;
        if (!c.checked) {
          c.click();
          n++;
        }
        break;
      }
    } catch {
      /* ignore */
    }
  }

  return n;
}

const ETSY_TAG_MAX_COUNT = 13;
const ETSY_TAG_CHAR_MAX = 20;

function collectEtsyTagsForExtra(etsyExtra) {
  if (!etsyExtra || typeof etsyExtra !== "object") return [];
  const raw = etsyExtra.tags != null ? String(etsyExtra.tags) : "";
  if (!raw.trim()) return [];
  return raw
    .split(/[,;\n]+/)
    .map((t) => t.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((t) => (t.length > ETSY_TAG_CHAR_MAX ? t.slice(0, ETSY_TAG_CHAR_MAX) : t))
    .slice(0, ETSY_TAG_MAX_COUNT);
}

function findEtsyTagsInput(rootEl) {
  const selectors = [
    'input[aria-label*="Tag" i][type="text"]',
    'input[aria-label*="Tag" i][type="search"]',
    'input[placeholder*="tag" i]',
    'input[id*="tag" i]',
    'input[name*="tag" i]',
  ];
  for (const sel of selectors) {
    let nodes;
    try {
      nodes = querySelectorAllDeep(sel, rootEl);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden") continue;
      return el;
    }
  }
  try {
    const all = querySelectorAllDeep("input", rootEl);
    let best = null;
    let bestSc = 0;
    for (const el of all) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
      const near = el.closest("div");
      const ctx = `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""} ${near ? near.textContent.slice(0, 220) : ""}`.toLowerCase();
      let sc = 0;
      if (/\btags?\b/.test(ctx) && !/instagram|hashtag|material tag/i.test(ctx)) sc += 80;
      if ((el.id && /tag/i.test(el.id)) || (el.name && /tag/i.test(el.name))) sc += 35;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
    if (bestSc >= 80) return best;
  } catch {
    /* ignore */
  }
  return null;
}

function etsyTagsUiLikelyHasTag(container, tag) {
  const t = String(tag || "").trim().toLowerCase();
  if (!t) return false;
  try {
    const pills = container.querySelectorAll(
      'button[aria-label*="Remove" i], button[aria-label*="remove" i], [data-tag], [class*="Tag" i]'
    );
    for (const p of pills) {
      const tx = (p.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (tx === t) return true;
      if (tx.startsWith(t + " ") || tx.startsWith(t + "×") || tx.startsWith(t + "‹")) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function etsyFindTagAddButton(input) {
  if (!(input instanceof HTMLElement)) return null;
  let cur = input;
  for (let depth = 0; depth < 12 && cur; depth++) {
    const host = cur.parentElement;
    if (!host) break;
    try {
      for (const b of host.querySelectorAll("button, [role='button']")) {
        if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
        const lab = (b.textContent || "").trim().toLowerCase();
        if (lab === "add") return b;
      }
    } catch {
      /* ignore */
    }
    cur = host;
  }
  return null;
}

function etsyFireEnterOnInput(input) {
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
  input.dispatchEvent(
    new KeyboardEvent("keyup", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true,
    })
  );
}

/**
 * Etsy listing “Tags”: one chip per tag (Enter + optional Add), same pattern as shopifyFillTagsCombobox.
 * Comma-separated `listing_extra.etsy.tags` from extension-review / vision.
 */
function etsyFillTagsComboboxFromExtra(etsyExtra, rootEl) {
  const tags = collectEtsyTagsForExtra(etsyExtra);
  if (!tags.length) return 0;
  const input = findEtsyTagsInput(rootEl);
  if (!input) return 0;
  const container =
    input.closest("section") ||
    input.closest("fieldset") ||
    input.closest('[role="region"]') ||
    input.closest("form") ||
    input.parentElement?.parentElement ||
    input.parentElement;
  let idx = 0;
  function applyOne(tag) {
    input.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, tag);
    else input.value = tag;
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data: tag, inputType: "insertText" })
    );
    etsyFireEnterOnInput(input);
    /** Enter alone usually adds the tag and clears the input — only fall back to clicking the
     * "Add" button if that didn't happen, instead of firing both unconditionally (which could
     * submit the same tag twice and trip Etsy's "can't add the same tag more than once" check). */
    setTimeout(() => {
      if (container && etsyTagsUiLikelyHasTag(container, tag)) return;
      const stillTyped = String(input.value || "").trim().toLowerCase() === tag.toLowerCase();
      if (!stillTyped) return;
      const addBtn = etsyFindTagAddButton(input);
      if (addBtn) {
        try {
          addBtn.click();
        } catch {
          /* ignore */
        }
      }
    }, 120);
  }
  function step() {
    if (idx >= tags.length) return;
    const tag = tags[idx++];
    if (container && etsyTagsUiLikelyHasTag(container, tag)) {
      step();
      return;
    }
    applyOne(tag);
    if (idx < tags.length) setTimeout(step, 150);
  }
  step();
  return 1;
}

/**
 * Etsy listing editor: category search, tags, quantity, who made / what is it, renewal — keyed like extension-review
 * `listing_extra.etsy`.
 */
function fillEtsyListingExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  const raw = scan.listing_extra;
  let e = null;
  if (raw && typeof raw === "object") {
    const et = raw.etsy;
    if (et && typeof et === "object" && Object.keys(et).length > 0) e = et;
  }
  if (!e || typeof e !== "object") return 0;

  const neg = ["search the help", "feedback", "coupon", "promo", "newsletter"];
  let n = 0;

  function etsyClickRadioInSection(sectionRe, optionRe) {
    try {
      // Find a section-like container that includes the heading and radio options.
      let scope = null;
      let bestLen = Infinity;
      const containers = querySelectorAllDeep("section, fieldset, div", rootEl);
      for (const c of containers) {
        if (!(c instanceof HTMLElement) || !isVisible(c)) continue;
        if (!c.querySelector('input[type="radio"]')) continue;
        const t = (c.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 2000) continue;
        const head = t.slice(0, 260).toLowerCase();
        if (!sectionRe.test(head)) continue;
        // Prefer tighter containers (avoid entire page sections).
        if (t.length < bestLen) {
          bestLen = t.length;
          scope = c;
        }
      }
      if (!scope) return false;

      const labels = scope.querySelectorAll("label");
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        const optText = (lab.textContent || "").replace(/\s+/g, " ").trim();
        if (!optText) continue;
        if (!optionRe.test(optText.toLowerCase())) continue;
        const inp = lab.querySelector('input[type="radio"]');
        if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
        if (!inp.checked) {
          lab.click();
        }
        return true;
      }

      // Fallback: sometimes the clickable element is not a <label>.
      const radios = scope.querySelectorAll('input[type="radio"]');
      for (const inp of radios) {
        if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
        const txt =
          `${inp.getAttribute("aria-label") || ""} ${inp.closest("div, li, label")?.textContent || ""}`
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        if (!txt) continue;
        if (!optionRe.test(txt)) continue;
        if (!inp.checked) {
          inp.click();
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function etsySetCheckboxInSection(sectionRe, optionRe, checked) {
    try {
      let scope = null;
      let bestLen = Infinity;
      const containers = querySelectorAllDeep("section, fieldset, div", rootEl);
      for (const c of containers) {
        if (!(c instanceof HTMLElement) || !isVisible(c)) continue;
        if (!c.querySelector('input[type="checkbox"]')) continue;
        const t = (c.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 2800) continue;
        const head = t.slice(0, 420).toLowerCase();
        if (!sectionRe.test(head)) continue;
        if (t.length < bestLen) {
          bestLen = t.length;
          scope = c;
        }
      }
      if (!scope) return false;

      const labels = scope.querySelectorAll("label");
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        const optText = (lab.textContent || "").replace(/\s+/g, " ").trim();
        if (!optText) continue;
        if (!optionRe.test(optText.toLowerCase())) continue;
        const inp = lab.querySelector('input[type="checkbox"]');
        if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
        if (Boolean(inp.checked) !== Boolean(checked)) {
          lab.click();
        }
        return true;
      }

      // Fallback: click the checkbox itself.
      const boxes = scope.querySelectorAll('input[type="checkbox"]');
      for (const inp of boxes) {
        if (!(inp instanceof HTMLInputElement) || inp.disabled) continue;
        const txt =
          `${inp.getAttribute("aria-label") || ""} ${inp.closest("div, li, label")?.textContent || ""}`
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        if (!txt) continue;
        if (!optionRe.test(txt)) continue;
        if (Boolean(inp.checked) !== Boolean(checked)) {
          inp.click();
        }
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function etsyPickFirstVisibleListboxOption(preferRe) {
    try {
      const opts = querySelectorAllDeep(
        [
          '[role="listbox"] [role="option"]',
          '[role="menu"] [role="menuitem"]',
          'li[role="option"]',
          '[role="listbox"] li',
          '[role="listbox"] div',
          // Fallback for non-ARIA popovers (common in Etsy forms)
          'div[role="dialog"] button',
          'div[role="dialog"] [tabindex="0"]',
          'div[role="dialog"] li',
          'div[role="presentation"] button',
          '[data-testid*="popover" i] button',
          '[data-testid*="menu" i] button',
          'ul[aria-label] li',
        ].join(", "),
        document.body
      );
      const usable = [];
      for (const o of opts) {
        if (!(o instanceof HTMLElement) || !isVisible(o)) continue;
        const tx = (o.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 220) continue;
        if (/please select|select one|choose/i.test(tx.toLowerCase())) continue;
        usable.push({ el: o, tx });
      }
      if (!usable.length) return false;
      if (preferRe) {
        const pref = usable.find((u) => preferRe.test(u.tx.toLowerCase()));
        if (pref) {
          pref.el.click();
          return true;
        }
      }
      usable[0].el.click();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Etsy required: "Processing profile" (shipping/processing preset). If missing, Etsy blocks save with
   * "Processing_profile". Best-effort: open the combobox and select the first profile option.
   */
  function etsyEnsureProcessingProfileSelected() {
    try {
      const roots = querySelectorAllDeep("section, fieldset, div", rootEl);
      let scope = null;
      let bestLen = Infinity;
      for (const c of roots) {
        if (!(c instanceof HTMLElement) || !isVisible(c)) continue;
        const t = (c.textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 2400) continue;
        const low = t.toLowerCase();
        if (!/processing profile|processing time|shipping profile|dispatch/i.test(low)) continue;
        // Prefer containers that have a combobox/select.
        if (!c.querySelector("select") && !c.querySelector('[role="combobox"]') && !c.querySelector('[aria-haspopup="listbox"]')) {
          continue;
        }
        if (t.length < bestLen) {
          bestLen = t.length;
          scope = c;
        }
      }
      // If we couldn't find the scope by label text, fall back to the validation error ("Processing_profile")
      // and grab the nearest container that contains a combobox/select.
      if (!scope) {
        let errNode = null;
        try {
          const nodes = querySelectorAllDeep("a, div, p, span, li", rootEl);
          for (const n of nodes) {
            if (!(n instanceof HTMLElement) || !isVisible(n)) continue;
            const tx = (n.textContent || "").replace(/\s+/g, " ").trim();
            if (!tx || tx.length > 120) continue;
            if (/processing_profile/i.test(tx) || /processing profile/i.test(tx.toLowerCase())) {
              errNode = n;
              break;
            }
          }
        } catch {
          /* ignore */
        }
        let cur = errNode;
        for (let up = 0; up < 10 && cur; up++) {
          const host = cur instanceof HTMLElement ? cur : null;
          if (
            host &&
            (host.querySelector("select") ||
              host.querySelector('[role="combobox"]') ||
              host.querySelector('[aria-haspopup="listbox"]') ||
              host.querySelector('button[aria-haspopup="listbox"]') ||
              host.querySelector('input[aria-haspopup="listbox"]'))
          ) {
            scope = host;
            break;
          }
          cur = cur.parentElement;
        }
      }
      if (!scope) return false;

      // Native select path.
      for (const sel of scope.querySelectorAll("select")) {
        if (!(sel instanceof HTMLSelectElement) || !isVisible(sel) || sel.disabled) continue;
        if (sel.value && String(sel.value).trim()) return false; // already selected
        if (sel.options.length > 1) {
          sel.selectedIndex = 1;
          sel.dispatchEvent(new Event("input", { bubbles: true }));
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
      }

      // Combobox path.
      const trig =
        scope.querySelector('[role="combobox"]') ||
        scope.querySelector('[aria-haspopup="listbox"]') ||
        scope.querySelector('button[aria-haspopup="listbox"]') ||
        scope.querySelector('input[aria-haspopup="listbox"]') ||
        scope.querySelector('input[aria-expanded]') ||
        // Etsy often uses a button-like div for dropdowns
        scope.querySelector('button, [role="button"], div[tabindex="0"], span[tabindex="0"]') ||
        null;
      if (!(trig instanceof HTMLElement) || !isVisible(trig)) return false;

      // If it already shows a selection, skip.
      const shown = (trig.textContent || "").replace(/\s+/g, " ").trim();
      if (shown && !/processing|shipping|profile|select/i.test(shown.toLowerCase()) && shown.length >= 2) return false;

      trig.click();
      // Pick a non-empty option; prefer anything that looks like "Default" if present.
      return etsyPickFirstVisibleListboxOption(/\bdefault\b|standard|domestic|shipping/i);
    } catch {
      return false;
    }
  }

  function etsyPickBestVisibleCategoryOption() {
    const wantLeaf = String(e.category_leaf || "").trim();
    const wantCrumb = String(e.category_breadcrumb || "").trim();
    const wantAny = [wantCrumb, wantLeaf].filter(Boolean);
    if (!wantAny.length) return false;
    try {
      /** Tag/role guesses (li[role=option] etc.) don't match every Etsy build's dropdown markup —
       * the rows in this particular UI render as plain divs with no role/data-testid at all. Query
       * every element and rely on text-shape matching instead, same fix as Depop's pill-matching. */
      const allEls = querySelectorAllDeep("*", document.body);
      const opts = [];
      for (const el of allEls) {
        if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
        const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 260 || tx.length < 3) continue;
        const hasMatchingChild = Array.from(el.children).some(
          (c) => (c.textContent || "").replace(/\s+/g, " ").trim() === tx
        );
        if (hasMatchingChild) continue;
        opts.push(el);
      }
      function rowMightBeEtsyCategoryOption(low, tx, leafLow, crumbLow) {
        if (/[›>»▸‣◂◦]|→/.test(tx)) return true;
        if (leafLow.length >= 3 && low.includes(leafLow)) return true;
        if (crumbLow.length >= 5) {
          if (low.includes(crumbLow.slice(0, Math.min(96, crumbLow.length)))) return true;
          const parts = crumbLow
            .split(/\s*>\s*|\s*›\s*/)
            .map((p) => p.trim())
            .filter((p) => p.length >= 4);
          if (parts.some((p) => low.includes(p))) return true;
        }
        return false;
      }

      const usable = [];
      const leafLow = String(wantLeaf || "").toLowerCase();
      const crumbLow = String(wantCrumb || "").toLowerCase();
      for (const o of opts) {
        if (!(o instanceof HTMLElement) || !isVisible(o)) continue;
        const tx = (o.textContent || "").replace(/\s+/g, " ").trim();
        if (!tx || tx.length > 260 || tx.length < 3) continue;
        const low = tx.toLowerCase();
        if (/^(select|choose|search|loading|see more|show more)\b/i.test(low)) continue;
        if (/^\d+$/.test(tx.trim())) continue;
        if (!rowMightBeEtsyCategoryOption(low, tx, leafLow, crumbLow)) continue;
        usable.push({ el: o, tx, low });
      }
      if (!usable.length) return false;
      let best = usable[0];
      let bestS = -Infinity;
      for (const u of usable) {
        let s = 0;
        if (leafLow && (u.low === leafLow || u.low.includes(leafLow))) s += 80;
        if (crumbLow && (u.low === crumbLow || u.low.includes(crumbLow))) s += 95;
        // Prefer rows that show a breadcrumb trail.
        if (u.tx.includes("›") || u.tx.includes(">")) s += 8;
        // Prefer shorter/cleaner rows (less likely to be a sidebar blurb).
        s -= Math.min(12, Math.max(0, u.tx.length - 120) / 20);
        if (s > bestS) {
          bestS = s;
          best = u;
        }
      }
      if (bestS < 20) return false;
      const clickTarget = best.el.closest('button, [role="button"], a, li, [tabindex]') || best.el;
      try {
        clickTarget.scrollIntoView({ block: "nearest", behavior: "auto" });
      } catch {
        /* ignore */
      }
      clickTarget.click();
      return true;
    } catch {
      return false;
    }
  }

  const hint = (hints, negatives, val) => {
    const str = val != null ? String(val).trim() : "";
    if (!str) return false;
    return vintedFillByHints(rootEl, hints, negatives, str);
  };

  /** category_search/category_leaf/category_breadcrumb are often the same value from upstream
   * extraction — joining all three with spaces produced literal "Headphones Headphones Headphones"
   * in the search box. Just use the first non-empty one as the search term; the pick step below
   * separately matches against category_leaf/category_breadcrumb. */
  const catQ = [e.category_search, e.category_leaf, e.category_breadcrumb]
    .map((x) => (x != null ? String(x).trim() : ""))
    .find(Boolean) || "";
  if (catQ && hint(["find a category", "category"], [...neg, "shop section"], catQ)) {
    n++;
    // Etsy requires clicking a suggestion to "finalize" the category combobox.
    try {
      const tryPick = () => {
        try {
          etsyPickBestVisibleCategoryOption();
        } catch {
          /* ignore */
        }
      };
      [80, 220, 420, 800, 1400].forEach((ms) => setTimeout(tryPick, ms));
    } catch {
      /* ignore */
    }
  }

  // Processing profile: run early so save isn't blocked.
  if (etsyEnsureProcessingProfileSelected()) n++;

  if (e.tags != null && String(e.tags).trim()) {
    const tagFill = etsyFillTagsComboboxFromExtra(e, rootEl);
    if (tagFill) n += tagFill;
    else if (hint(["tag"], [...neg, "instagram", "title", "material tag"], String(e.tags).trim())) n++;
  }
  if (e.brand != null && String(e.brand).trim()) {
    if (hint(["brand"], neg, String(e.brand).trim())) n++;
  }
  if (e.materials_hint != null && String(e.materials_hint).trim()) {
    if (hint(["material"], [...neg, "description"], String(e.materials_hint).trim())) n++;
  }
  if (e.primary_color != null && String(e.primary_color).trim()) {
    if (hint(["primary colour", "primary color", "colour", "color"], neg, String(e.primary_color).trim())) n++;
  }
  if (e.size_scale != null && String(e.size_scale).trim()) {
    if (hint(["size", "scale"], [...neg, "resize", "photo size"], String(e.size_scale).trim())) n++;
  }
  if (e.quantity != null && String(e.quantity).trim()) {
    if (hint(["quantity", "stock"], [...neg, "renewal", "processing"], String(e.quantity).trim())) n++;
  }
  if (e.sku != null && String(e.sku).trim()) {
    if (hint(["sku"], [...neg, "gtin"], String(e.sku).trim())) n++;
  }

  const who = String(e.who_made || "").toLowerCase();
  const whoNorm = who || "i_did";
  if (whoNorm === "i_did" || whoNorm === "member" || whoNorm === "other") {
    try {
      const labels = querySelectorAllDeep("label", rootEl);
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        const t = (lab.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!/who made|who made it/i.test(t)) continue;
        const inp = lab.querySelector('input[type="radio"]');
        if (!(inp instanceof HTMLInputElement)) continue;
        const name = (inp.name || "").toLowerCase();
        const val = (inp.value || "").toLowerCase();
        if (whoNorm === "i_did" && (val === "i_did" || /i did|^me$/i.test(t))) {
          inp.click();
          n++;
          break;
        }
        if (whoNorm === "member" && (val.includes("member") || /member of my shop/i.test(lab.textContent || ""))) {
          inp.click();
          n++;
          break;
        }
        if (whoNorm === "other" && (val.includes("company") || /another company|person/i.test(lab.textContent || ""))) {
          inp.click();
          n++;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Etsy 2026 UI: "Who made it?" options are separate labels; click by visible text as fallback.
  if (whoNorm === "i_did") {
    if (etsyClickRadioInSection(/who made it\?/i, /\bi did\b/i)) n++;
  } else if (whoNorm === "member") {
    if (etsyClickRadioInSection(/who made it\?/i, /member of my shop/i)) n++;
  } else if (whoNorm === "other") {
    if (etsyClickRadioInSection(/who made it\?/i, /another company|person/i)) n++;
  }

  const what = String(e.what_is_it || "").toLowerCase();
  const whatNorm = what || "finished";
  if (whatNorm === "finished" || whatNorm === "supply") {
    try {
      const labels = querySelectorAllDeep("label", rootEl);
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        const t = (lab.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        if (!/what is it|type of item/i.test(t)) continue;
        const inp = lab.querySelector('input[type="radio"]');
        if (!(inp instanceof HTMLInputElement)) continue;
        if (whatNorm === "finished" && /finished product|a finished/i.test(lab.textContent || "")) {
          inp.click();
          n++;
          break;
        }
        if (whatNorm === "supply" && /supply|tool/i.test(lab.textContent || "")) {
          inp.click();
          n++;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }
  // Etsy 2026 UI: "What is it?" options are "A finished product" / "A supply or tool to make things".
  if (whatNorm === "finished") {
    if (etsyClickRadioInSection(/what is it\?/i, /finished product/i)) n++;
  } else if (whatNorm === "supply") {
    if (etsyClickRadioInSection(/what is it\?/i, /supply|tool/i)) n++;
  }

  /**
   * Etsy “How does your shop produce this item?” — prefer `listing_extra.etsy.how_produced`, else title/description heuristics.
   */
  try {
    const hp = String(e.how_produced || "").toLowerCase();
    const blob = `${String(scan.title || "")} ${String(scan.description || "")}`.toLowerCase();
    let produce = hp || "";
    if (!produce) {
      produce = "scratch";
      if (/\bcurated\b|\bgift\s*basket\b|\bset\s+of\b|\bpre[-\s]?made\b|\bvintage\b|\bpreloved\b|\bsecond\s*hand\b|\bused\b/.test(blob)) produce = "curated";
      else if (/\bassembled\b|\bkit\b|\bparts\b/i.test(blob)) produce = "assembled";
      else if (/\balter(ed)?\b|\bupcycle/i.test(blob)) produce = "altered";
      else if (/\bnatural\b|\braw\s+(material|wood|stone)\b/i.test(blob)) produce = "natural";
    }
    if (produce === "scratch") {
      if (etsyClickRadioInSection(/how does your shop produce this item\?/i, /made from scratch/i)) n++;
    } else if (produce === "assembled") {
      if (etsyClickRadioInSection(/how does your shop produce this item\?/i, /assembled from purchased/i)) n++;
    } else if (produce === "altered") {
      if (etsyClickRadioInSection(/how does your shop produce this item\?/i, /alters|altered/i)) n++;
    } else if (produce === "curated") {
      if (etsyClickRadioInSection(/how does your shop produce this item\?/i, /curated set of purchased goods/i)) n++;
    } else if (produce === "natural") {
      if (etsyClickRadioInSection(/how does your shop produce this item\?/i, /natural material/i)) n++;
    }
  } catch {
    /* ignore */
  }

  /**
   * Etsy “What tools are used to make this item?” — prefer `listing_extra.etsy.production_tools`, else description heuristics.
   */
  try {
    const tools = String(e.production_tools || "").toLowerCase();
    const blob = `${String(scan.title || "")} ${String(scan.description || "")}`.toLowerCase();
    const mentionsAi =
      tools === "ai" ||
      /\b(ai generated|ai generator|midjourney|dall[\s-]?e|chatgpt|stable diffusion|generative)\b/i.test(blob);
    const useComputer = tools === "computerised";
    const useNone = tools === "none";
    if (useNone) {
      if (etsySetCheckboxInSection(/what tools are used to make this item\?/i, /none.*don.?t use tools/i, true)) n++;
    } else if (mentionsAi) {
      if (etsySetCheckboxInSection(/what tools are used to make this item\?/i, /an ai generator/i, true)) n++;
    } else if (useComputer) {
      if (etsySetCheckboxInSection(/what tools are used to make this item\?/i, /computerised|computerized/i, true)) n++;
    } else {
      if (etsySetCheckboxInSection(/what tools are used to make this item\?/i, /handheld|hand-guided/i, true)) n++;
    }
  } catch {
    /* ignore */
  }

  const wmRaw = e.when_made != null ? String(e.when_made).trim() : "";
  const wm = wmRaw || "Made to order";
  if (wm) {
    let whenSet = false;
    try {
      const selects = querySelectorAllDeep("select", rootEl);
      for (const sel of selects) {
        if (!(sel instanceof HTMLSelectElement) || !isVisible(sel)) continue;
        const ctx = `${sel.getAttribute("aria-label") || ""} ${sel.closest("div")?.textContent || ""}`.toLowerCase();
        if (!/when was it made|made\?/i.test(ctx)) continue;
        const opt = Array.from(sel.options).find(
          (o) =>
            (o.textContent || "").toLowerCase().includes(wm.toLowerCase()) ||
            (o.value && wm.toLowerCase().includes((o.value || "").toLowerCase()))
        );
        if (opt) {
          sel.value = opt.value;
          sel.dispatchEvent(new Event("change", { bubbles: true }));
          n++;
          whenSet = true;
          break;
        }
      }
    } catch {
      /* ignore */
    }
    if (!whenSet) hint(["when was it made", "made"], neg, wm);
  }

  const it = String(e.item_type || "").toLowerCase();
  if (it === "digital" || it === "physical") {
    try {
      const labels = querySelectorAllDeep("label", rootEl);
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        const blob = (lab.textContent || "").toLowerCase();
        if (!/physical|digital/i.test(blob) || !/item|type/i.test(blob)) continue;
        const inp = lab.querySelector('input[type="radio"]');
        if (!(inp instanceof HTMLInputElement)) continue;
        if (it === "physical" && /physical|tangible/i.test(blob)) {
          inp.click();
          n++;
          break;
        }
        if (it === "digital" && /digital/i.test(blob)) {
          inp.click();
          n++;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  const ren = String(e.renewal || "").toLowerCase();
  if (ren === "automatic" || ren === "manual") {
    try {
      const labels = querySelectorAllDeep("label", rootEl);
      for (const lab of labels) {
        if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
        if (!/renewal|renew/i.test(lab.textContent || "")) continue;
        const inp = lab.querySelector('input[type="radio"]');
        if (!(inp instanceof HTMLInputElement)) continue;
        if (ren === "automatic" && /automatic/i.test(lab.textContent || "")) {
          inp.click();
          n++;
          break;
        }
        if (ren === "manual" && /manual/i.test(lab.textContent || "")) {
          inp.click();
          n++;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (e.shop_section != null && String(e.shop_section).trim()) {
    if (hint(["shop section"], [...neg, "section of this shop"], String(e.shop_section).trim())) n++;
  }

  if (e.domestic_global_pricing === true) {
    try {
      if (etsySetCheckboxInSection(/domestic.*global|different prices|buyer location/i, /different|domestic.*global/i, true))
        n++;
    } catch {
      /* ignore */
    }
  }

  if (e.feature_this_listing === true) {
    try {
      if (etsySetCheckboxInSection(/feature this listing/i, /feature/i, true)) n++;
    } catch {
      /* ignore */
    }
  }

  return n;
}

function shopeeGetExtra(scan) {
  const raw = scan.listing_extra;
  if (!raw || typeof raw !== "object") return null;
  const s = raw.shopee;
  return s && typeof s === "object" ? s : null;
}

function shopeeDeriveCategorySearchQuery(scan) {
  const ex = shopeeGetExtra(scan);
  if (ex && ex.category_search != null && String(ex.category_search).trim()) {
    return String(ex.category_search).trim().slice(0, 200);
  }
  if (ex && ex.category_hint != null && String(ex.category_hint).trim()) {
    return String(ex.category_hint).trim().slice(0, 200);
  }
  if (ex && ex.category_leaf != null && String(ex.category_leaf).trim()) {
    return String(ex.category_leaf).trim().slice(0, 200);
  }
  const title = String(
    typeof shopeeProductTitleForFill === "function" ? shopeeProductTitleForFill(scan) : scan.title || ""
  ).trim();
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "with",
    "new",
    "sale",
    "free",
    "pcs",
    "pc",
    "set",
    "of",
  ]);
  const words = title
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stop.has(w.toLowerCase()) && !/^\d+([.,]\d+)?$/.test(w));
  const q = words.slice(0, 8).join(" ");
  if (q.length >= 4) return q.slice(0, 120);
  const desc = String(scan.description || "")
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join(" ");
  if (desc.length >= 8) return desc.slice(0, 120);
  return "fashion clothing";
}

function shopeeCategoryAppearsFilled(rootEl) {
  if (shopeeFindCategoryPickerSurface(rootEl)) return false;
  try {
    for (const el of querySelectorAllDeep("div, section, form", rootEl)) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const block = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\bcategory\b/i.test(block.slice(0, 500))) continue;
      if (/please\s+set\s+category|please\s+select\s+category|ตั้งค่าหมวดหมู่/i.test(block)) continue;
      const hasCrumb = [">", "\u2192", "\u203a", "\u00bb"].some((ch) => block.includes(ch));
      if (hasCrumb && block.length >= 15 && block.length < 800) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shopeeDialogLooksLikeCategoryPicker(el) {
  if (!(el instanceof Element)) return 0;
  const t = (el.textContent || "").slice(0, 6000).toLowerCase();
  let sc = 0;
  if (/\bcategor(y|ies)\b/.test(t)) sc += 38;
  if (/\bsearch\b/.test(t)) sc += 12;
  return sc;
}

function shopeeFindCategoryPickerSurface(rootEl) {
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Drawer" i], [class*="drawer" i]',
      rootEl instanceof HTMLElement || (rootEl && rootEl.nodeType) ? rootEl : document.body
    );
    for (const el of nodes) {
      const sc = shopeeDialogLooksLikeCategoryPicker(el);
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 32 ? best : null;
}

function shopeeFindCategorySearchInput(dialog) {
  try {
    for (const el of querySelectorAllDeep("input", dialog)) {
      if (!(el instanceof HTMLInputElement) || !isVisible(el)) continue;
      const ty = (el.type || "").toLowerCase();
      if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const al = shopifyControlAccessibleName(el).toLowerCase();
      if (ty === "search" || /\bsearch\b/.test(ph) || /\bsearch\b/.test(al)) return el;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function shopeeCategoryOptionCandidates(dialog) {
  const out = [];
  try {
    const nodes = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], [role="row"], li, button, a, div[class*="tree" i] div',
      dialog
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length < 2 || t.length > 200) continue;
      if (/^(back|close|cancel|done|apply|ok|save|clear|reset)$/i.test(t)) continue;
      if (/^select all$/i.test(t)) continue;
      out.push(el);
    }
  } catch {
    /* ignore */
  }
  return out;
}

function shopeeScoreOptionToProduct(query, productTokens, optionText) {
  const o = optionText.toLowerCase();
  let sc = 0;
  const q = query.toLowerCase();
  if (q && o.includes(q.slice(0, Math.min(24, q.length)))) sc += 40;
  for (const tok of productTokens) {
    if (tok.length < 3) continue;
    if (o.includes(tok)) sc += 18;
  }
  if (/other|misc|general|ทั่วไป/i.test(o)) sc -= 25;
  return sc;
}

function shopeeFindCategoryTrigger(rootEl) {
  let best = null;
  let bestSc = 0;
  try {
    const nodes = querySelectorAllDeep(
      'button, [role="button"], [role="combobox"], svg, div[tabindex="0"], span[tabindex="0"], a',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const rawT = (el.textContent || "").replace(/\s+/g, " ").trim();
      const t = rawT.toLowerCase();
      let sc = 0;
      if (/please\s+set\s+category|please\s+select\s+category|set\s+category|add\s+category/i.test(rawT)) {
        sc += 130;
      }
      if (/หมวดหมู่|分类|分類|kategori/i.test(rawT)) sc += 55;
      const row = el.closest("div, li, section, form, tr");
      const rowHead = row ? (row.textContent || "").slice(0, 220) : "";
      if (/\bcategory\b/i.test(rowHead) && /please\s+set|select|choose|ตั้งค่า/i.test(rowHead)) sc += 70;
      if (el.tagName === "SVG" || el.closest("svg")) {
        const r2 = el.closest("div, button, span, a");
        if (r2 && /\bcategory\b/i.test((r2.closest("section, div, form")?.textContent || "").slice(0, 260))) {
          sc += 45;
        }
      }
      if (t.length > 100) sc -= 20;
      if (sc > bestSc) {
        bestSc = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestSc >= 85 ? best : null;
}

function shopeeTokenizeForCategory(scan) {
  const blob = `${shopeeDeriveCategorySearchQuery(scan)} ${String(scan.title || "")} ${String(scan.description || "").slice(0, 400)}`;
  let parts;
  try {
    parts = blob.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  } catch {
    parts = blob.toLowerCase().split(/[^a-z0-9]+/i);
  }
  return parts.filter((w) => w.length >= 3).slice(0, 40);
}

/**
 * Multi-tick category picker: search Shopee’s tree, pick best-matching leaf by token overlap with listing text.
 * @returns {boolean} true if category looks done or we advanced the picker this tick.
 */
function shopeeFillCategory(scan, rootEl) {
  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  if (!win) return false;

  const qFull = shopeeDeriveCategorySearchQuery(scan);
  const key = qFull.slice(0, 300);
  if (!key) return false;

  if (shopeeCategoryAppearsFilled(rootEl)) {
    try {
      win.__synclystShopeeCat = null;
    } catch {
      /* ignore */
    }
    return false;
  }

  if (!win.__synclystShopeeCat || win.__synclystShopeeCat.key !== key) {
    win.__synclystShopeeCat = {
      key,
      searchSubmitted: false,
      lastPickAt: 0,
    };
  }
  const st = win.__synclystShopeeCat;
  const productTokens = shopeeTokenizeForCategory(scan);
  const exCat = shopeeGetExtra(scan);
  const categoryNeedsUserConfirm = exCat && exCat.category_needs_confirmation === true;

  const dialog = shopeeFindCategoryPickerSurface(rootEl);

  if (!dialog) {
    const trig = shopeeFindCategoryTrigger(rootEl);
    if (!trig) return false;
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      trig.focus();
      trig.click();
    } catch {
      try {
        trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      } catch {
        return false;
      }
    }
    return true;
  }

  const searchInp = shopeeFindCategorySearchInput(dialog);
  if (searchInp && !st.searchSubmitted) {
    fillField(searchInp, qFull);
    st.searchSubmitted = true;
    return true;
  }

  if (categoryNeedsUserConfirm && st.searchSubmitted) {
    return true;
  }

  const candidates = shopeeCategoryOptionCandidates(dialog);
  let best = null;
  let bestSc = -1;
  for (const el of candidates) {
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    const sc = shopeeScoreOptionToProduct(qFull, productTokens, txt);
    if (sc > bestSc) {
      bestSc = sc;
      best = el;
    }
  }

  const threshold = st.searchSubmitted ? 28 : 40;
  if (best && bestSc >= threshold) {
    const now = Date.now();
    if (now - st.lastPickAt < 120) return true;
    st.lastPickAt = now;
    try {
      best.scrollIntoView({ block: "nearest", behavior: "auto" });
      best.focus();
      best.click();
    } catch {
      try {
        best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
      } catch {
        return true;
      }
    }
    return true;
  }

  try {
    for (const b of querySelectorAllDeep("button, [role='button']", dialog)) {
      if (!(b instanceof HTMLElement) || !isVisible(b)) continue;
      const t = (b.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (/^(done|apply|ok|confirm|save|select)$/i.test(t) || /\bconfirm\b/.test(t)) {
        b.click();
        win.__synclystShopeeCat = null;
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  return false;
}

function shopeeClickTabByLabel(rootEl, patterns) {
  const pats = Array.isArray(patterns) ? patterns : [patterns];
  try {
    const nodes = querySelectorAllDeep(
      '[role="tab"], button, a, div[tabindex="0"], span[tabindex="0"]',
      rootEl
    );
    for (const el of nodes) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (raw.length > 80) continue;
      const low = raw.toLowerCase();
      for (const p of pats) {
        if (typeof p === "string" && low.includes(p.toLowerCase())) {
          try {
            el.click();
            return true;
          } catch {
            /* ignore */
          }
        }
        if (p instanceof RegExp && p.test(raw)) {
          try {
            el.click();
            return true;
          } catch {
            /* ignore */
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shopeeCheckItemWithoutGtinIfPresent(rootEl) {
  try {
    for (const c of querySelectorAllDeep('input[type="checkbox"]', rootEl)) {
      if (!(c instanceof HTMLInputElement) || !isVisible(c)) continue;
      const lab = `${c.closest("label")?.textContent || ""} ${c.getAttribute("aria-label") || ""}`.toLowerCase();
      if (!/without\s+gtin|no\s+gtin|ไม่มี|tidak/i.test(lab)) continue;
      if (!c.checked) {
        c.click();
        return true;
      }
      return false;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shopeeEnableFirstShippingChannel(rootEl) {
  try {
    const neg = ["header", "footer", "search"];
    for (const row of querySelectorAllDeep("div, section, tr, li", rootEl)) {
      if (!(row instanceof HTMLElement) || !isVisible(row)) continue;
      const t = (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!/standard|delivery|shipping|ขนส่ง|ส่ง/i.test(t)) continue;
      if (!/shopee|supported|channel|ช่องทาง/i.test(t) && t.length < 30) continue;
      const toggles = row.querySelectorAll(
        'input[type="checkbox"], [role="switch"], [role="checkbox"], button[aria-pressed]'
      );
      for (const tg of toggles) {
        if (!(tg instanceof HTMLElement) || !isVisible(tg)) continue;
        if (tg instanceof HTMLInputElement && tg.type === "checkbox" && !tg.checked) {
          tg.click();
          return true;
        }
        const pressed = tg.getAttribute("aria-pressed");
        if (pressed === "false") {
          tg.click();
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function shopeeInputContextSnippet(inp) {
  if (!(inp instanceof HTMLElement)) return "";
  let p = inp;
  for (let i = 0; i < 14; i++) {
    if (!p) break;
    try {
      const t = (p.innerText || p.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length >= 12 && t.length <= 520) return t.toLowerCase();
    } catch {
      /* ignore */
    }
    p = p.parentElement;
  }
  return ((inp.innerText || inp.textContent || "") + "").toLowerCase();
}

function shopeeScoreSalesPriceInput(el) {
  if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "file" || ty === "checkbox" || ty === "radio") return -Infinity;
  const sn = shopeeInputContextSnippet(el);
  let s = 0;
  if (/\bprice\b/.test(sn) && (/\b฿\b|baht|đ|rp|peso|input/i.test(sn) || /\*/.test(sn))) s += 130;
  else if (/\bprice\b/.test(sn)) s += 85;
  try {
    const row = el.closest("div, section, li, fieldset, form, tr, article");
    if (row) {
      const head = (row.textContent || "").replace(/\s+/g, " ").slice(0, 220).toLowerCase();
      if (/\bprice\b/.test(head) && /\*/.test(head) && !/original|compare|strike|rrp|discount|coupon|promo|voucher/i.test(head)) {
        s += 95;
      } else if (/\bprice\b/.test(head) && !/original|compare|strike|rrp|discount|coupon|promo|voucher/i.test(head)) {
        s += 45;
      }
    }
  } catch {
    /* ignore */
  }
  // Avoid other numeric fields.
  if (/\bweight\b|\bkg\b|parcel|dimension|width|length|height|shipping fee|stock\b|variation/i.test(sn)) s -= 95;
  // Avoid promo / discount / compare-at price fields.
  if (/\b(original|was|compare|strike|rrp|discount|coupon|promo|promotion|voucher|bundle|fee)\b/i.test(sn)) s -= 120;
  if ((el.getAttribute("placeholder") || "").toLowerCase() === "input" && /\bprice\b/.test(sn)) s += 25;
  const im = (el.inputMode || el.getAttribute("inputmode") || "").toLowerCase();
  if (im === "decimal" || im === "numeric") s += 18;
  return s;
}

function shopeeScoreShippingWeightInput(el) {
  if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "file" || ty === "checkbox" || ty === "radio") return -Infinity;
  const sn = shopeeInputContextSnippet(el);
  let s = 0;
  if (/\bweight\b/.test(sn) && /\bkg\b/.test(sn)) s += 140;
  else if (/\bweight\b/.test(sn)) s += 95;
  if (/\bprice\b|\b฿\b|baht|stock\b|discount|variation|sales/i.test(sn)) s -= 100;
  if ((el.getAttribute("placeholder") || "").toLowerCase() === "input" && /\bweight\b/.test(sn) && /\bkg\b/.test(sn)) {
    s += 30;
  }
  const im = (el.inputMode || el.getAttribute("inputmode") || "").toLowerCase();
  if (im === "decimal" || im === "numeric") s += 12;
  return s;
}

/** Sales Information: * Stock (required; Shopee often defaults to 0). */
function shopeeScoreSalesStockInput(el) {
  if (!(el instanceof HTMLInputElement) || !isVisible(el) || el.readOnly || el.disabled) return -Infinity;
  const ty = (el.type || "").toLowerCase();
  if (ty === "hidden" || ty === "file" || ty === "checkbox" || ty === "radio") return -Infinity;
  const sn = shopeeInputContextSnippet(el);
  let s = 0;
  if (/\bstock\b/i.test(sn) && !/out\s+of\s+stock|inventory\s*value/i.test(sn)) s += 130;
  if (/\bprice\b|\b฿\b|baht|weight\b|\bkg\b|minimum|parcel/i.test(sn)) s -= 40;
  if ((el.getAttribute("placeholder") || "").toLowerCase() === "input" && /\bstock\b/i.test(sn)) s += 22;
  const im = (el.inputMode || el.getAttribute("inputmode") || "").toLowerCase();
  if (im === "numeric" || im === "decimal" || ty === "number") s += 14;
  return s;
}

function shopeeBestScoredInput(rootEl, scoreFn) {
  let best = null;
  let bestS = -Infinity;
  try {
    for (const el of querySelectorAllDeep("input", rootEl)) {
      if (!(el instanceof HTMLInputElement)) continue;
      const sc = scoreFn(el);
      if (sc > bestS) {
        bestS = sc;
        best = el;
      }
    }
  } catch {
    /* ignore */
  }
  return bestS >= 48 ? best : null;
}

function shopeeNormalizePriceCandidate(v) {
  try {
    if (v == null) return "";
    if (typeof v === "number" && isFinite(v) && v > 0) return normalizeMarketplacePriceString(String(v));
    const s = String(v).trim();
    if (!s) return "";
    // Shopee commonly shows Thai Baht, but scan.price can come from other sources too.
    // Keep only the first money-ish number (handles "฿ 1,299.00", "1,299", "1299", etc.).
    const cleaned = s.replace(/[^\d.,-]/g, " ").replace(/\s+/g, " ").trim();
    const m = cleaned.match(/-?\d[\d,]*([.]\d+)?/);
    return normalizeMarketplacePriceString(m ? m[0] : cleaned);
  } catch {
    return "";
  }
}

function shopeeResolvePriceStringForFill(scan) {
  const raw = scan && typeof scan === "object" ? scan : {};
  const ex = shopeeGetExtra(raw) || {};
  const shop = raw.listing_extra && typeof raw.listing_extra === "object" ? raw.listing_extra.shopify : null;
  const tries = [
    raw.price,
    raw.price_value,
    raw.price_display,
    raw.unit_price,
    ex.price,
    shop && typeof shop === "object" ? shop.price : null,
    shop && typeof shop === "object" ? shop.unit_price : null,
  ];
  const vals = [];
  for (const t of tries) {
    const s = shopeeNormalizePriceCandidate(t);
    if (!s) continue;
    const num = Number(String(s).replace(/[^\d.]/g, ""));
    if (!isFinite(num) || num <= 0) continue;
    // Ignore implausible extremes (often OCR garbage or IDs).
    if (num > 1000000) continue;
    vals.push({ s, num });
  }
  const fromBlob = synclystExtractMoneyCandidateFromText(
    `${String(raw.title || "")} ${String(raw.description || "")}`.slice(0, 12000)
  );
  const fromBlobNum = fromBlob ? Number(String(fromBlob).replace(/[^\d.]/g, "")) : 0;
  if (!vals.length) return fromBlob || "";
  // Prefer the *largest* non-trivial candidate (avoids picking "10" over "1299").
  const nonTrivial = vals.filter((v) => v.num >= 5);
  if (nonTrivial.length) {
    nonTrivial.sort((a, b) => b.num - a.num);
    // If text contains a larger price (common when structured signals are missing), prefer it.
    if (fromBlob && isFinite(fromBlobNum) && fromBlobNum >= nonTrivial[0].num) return fromBlob;
    return nonTrivial[0].s;
  }
  // Otherwise pick the largest tiny candidate.
  vals.sort((a, b) => b.num - a.num);
  if (fromBlob && isFinite(fromBlobNum) && fromBlobNum >= 5) return fromBlob;
  return vals[0].s;
}

function shopeeFillSalesPriceAndShippingWeight(scan, rootEl) {
  let n = 0;
  const priceStr = shopeeResolvePriceStringForFill(scan);
  console.log("[SyncLyst] Shopee Price/Weight: resolved priceStr =", priceStr);
  if (priceStr) {
    const pe = shopeeBestScoredInput(rootEl, shopeeScoreSalesPriceInput);
    console.log("[SyncLyst] Shopee Price: best-scored input found =", !!pe, pe);
    const shopeeForceCommitMoneyInput = (inp, want) => {
      if (!(inp instanceof HTMLInputElement) || !want) return false;
      const v = String(want).trim();
      if (!v) return false;
      try {
        inp.scrollIntoView({ block: "nearest", behavior: "auto" });
      } catch {
        /* ignore */
      }
      try {
        inp.focus();
      } catch {
        /* ignore */
      }
      // First attempt: our usual React-friendly setter/events.
      try {
        fillField(inp, v);
      } catch {
        /* ignore */
      }
      const readNum = () => {
        try {
          return Number(String(inp.value || "").replace(/[^\d.]/g, ""));
        } catch {
          return NaN;
        }
      };
      const wantNum = Number(String(v).replace(/[^\d.]/g, ""));
      const curNum0 = readNum();
      if (isFinite(wantNum) && isFinite(curNum0) && Math.abs(curNum0 - wantNum) < 1e-6 && wantNum > 0) return true;

      // Second attempt: simulate real typing (Shopee masks/validates on keystrokes).
      try {
        inp.focus();
        try {
          inp.setSelectionRange(0, String(inp.value || "").length);
        } catch {
          /* ignore */
        }
        try {
          document.execCommand("selectAll", false, null);
        } catch {
          /* ignore */
        }
        try {
          inp.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              composed: true,
              cancelable: true,
              data: v,
              inputType: "insertText",
            })
          );
        } catch {
          /* ignore */
        }
        try {
          document.execCommand("insertText", false, v);
        } catch {
          // Fallback to native setter when execCommand is blocked.
          try {
            const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
            if (desc && typeof desc.set === "function") desc.set.call(inp, v);
            else inp.value = v;
          } catch {
            inp.value = v;
          }
        }
        inp.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: v, inputType: "insertText" }));
        inp.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        inp.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      } catch {
        /* ignore */
      }
      const curNum1 = readNum();
      return isFinite(wantNum) && isFinite(curNum1) && Math.abs(curNum1 - wantNum) < 1e-6 && wantNum > 0;
    };

    if (pe) {
      const ok = shopeeForceCommitMoneyInput(pe, priceStr);
      console.log("[SyncLyst] Shopee Price: commit result =", ok, "value now =", pe.value);
      if (ok) n++;
    }
  }
  const ex = shopeeGetExtra(scan) || {};
  const wKg =
    ex.weight_kg != null && String(ex.weight_kg).trim()
      ? String(ex.weight_kg).trim()
      : ex.weight_g != null && String(ex.weight_g).trim()
        ? String(Number(ex.weight_g) / 1000)
        : "0.2";
  const we = shopeeBestScoredInput(rootEl, shopeeScoreShippingWeightInput);
  console.log("[SyncLyst] Shopee Weight: best-scored input found =", !!we, "want =", wKg, we);
  if (we) {
    const ok = fillField(we, wKg);
    console.log("[SyncLyst] Shopee Weight: fillField result =", ok, "value now =", we.value);
    if (ok) n++;
  }
  return n;
}

/**
 * Shopee spec rows are often multi-column: the label node can be separate from the combobox.
 * We search for a matching label-like node, then walk up ancestors until we find a container
 * that actually *contains* a dropdown trigger/select.
 */
function shopeeFindSmallestRowMatching(rootEl, regex) {
  const isTrigger = (el) => {
    if (!(el instanceof Element)) return false;
    const sel = el.querySelector && el.querySelector("select");
    if (sel instanceof HTMLSelectElement && isVisible(sel) && sel.options.length > 1) return true;
    const trig =
      (el.querySelector &&
        (el.querySelector('[role="combobox"]') ||
          el.querySelector('input[readonly]') ||
          el.querySelector('input[aria-haspopup]') ||
          el.querySelector('input[aria-expanded]') ||
          el.querySelector('input[placeholder*="please select" i]') ||
          el.querySelector('input[placeholder*="select" i]') ||
          el.querySelector("button[aria-haspopup]") ||
          el.querySelector('[aria-haspopup="listbox"]'))) ||
      null;
    return trig instanceof HTMLElement && isVisible(trig);
  };

  let best = null;
  let bestLen = Infinity;
  try {
    const candidates = querySelectorAllDeep("div, span, label, p, td, th, li, section", rootEl);
    for (const node of candidates) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const t = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 220) continue;
      if (!regex.test(t)) continue;

      let cur = node;
      for (let up = 0; up < 7 && cur; up++) {
        if (cur instanceof HTMLElement && isVisible(cur) && isTrigger(cur)) {
          const blob = (cur.textContent || "").replace(/\s+/g, " ").trim();
          const len = blob.length || 9999;
          if (len < bestLen) {
            bestLen = len;
            best = cur;
          }
          break;
        }
        cur = cur.parentElement;
      }
    }
    if (best) return best;

    // Fallback: old behavior (broader scan).
    for (const row of querySelectorAllDeep("div, tr, li, section, fieldset", rootEl)) {
      if (!(row instanceof HTMLElement) || !isVisible(row)) continue;
      if (!isTrigger(row)) continue;
      const t = (row.textContent || "").replace(/\s+/g, " ").trim();
      if (t.length > 500) continue;
      if (!regex.test(t.slice(0, 220))) continue;
      if (t.length < bestLen) {
        bestLen = t.length;
        best = row;
      }
    }
  } catch {
    /* ignore */
  }
  return best;
}

function shopeePickListOptionPrefer(preferred) {
  return shopeePickBestSpecificationOption(preferred, []);
}

/** Shopee nests options in wrappers; clicking the wrapper often does nothing — keep leaf rows only. */
function shopeeSpecificationOptionLeaves(candidates) {
  const arr = (candidates || []).filter((el) => el instanceof HTMLElement);
  return arr.filter((o) => !arr.some((p) => p !== o && o.contains(p)));
}

/**
 * Rank visible listbox options by preference string + keyword hints (title/description heuristics).
 */
function shopeePickBestSpecificationOption(pref, hintStrings) {
  const prefLow = pref != null ? String(pref).trim().toLowerCase() : "";
  const hints = [prefLow, ...(hintStrings || []).map((s) => String(s).toLowerCase().trim())].filter(
    Boolean
  );
  const surfaces = [];
  try {
    const raw = querySelectorAllDeep('[role="listbox"], [role="menu"]', document.body);
    for (const el of raw) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length < 2) continue;
      // Ignore giant page nav menus; dropdown listboxes are usually compact.
      if (t.length > 5000) continue;
      surfaces.push(el);
    }
  } catch {
    /* ignore */
  }
  // Prefer smaller surfaces first (open attribute dropdown vs. huge page menus).
  try {
    surfaces.sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.width * ra.height - rb.width * rb.height;
    });
  } catch {
    /* ignore */
  }
  const searchRoots = surfaces.length ? surfaces : [document.body];

  const usable = [];
  for (const root of searchRoots) {
    let opts = [];
    try {
      opts = Array.from(
        root.querySelectorAll(
          [
            '[role="option"]',
            '[role="menuitem"]',
            '[role="menuitemradio"]',
            "li[role=\"option\"]",
            // Shopee sometimes renders lists without ARIA roles.
            "li",
            "div",
          ].join(", ")
        )
      );
    } catch {
      opts = [];
    }
    for (const o of opts) {
      if (!(o instanceof HTMLElement) || !isVisible(o)) continue;
      const tx = (o.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx || tx.length > 180) continue;
      if (/please\s*select|^--|^เลือก|select\s*one/i.test(tx)) continue;
      // Shopee spec dropdown chrome (see Seller Centre “Sleeve Length” panel).
      if (/please\s*input\s*at\s*least/i.test(tx)) continue;
      if (/add\s*a\s*new\s*item|^\+/i.test(tx)) continue;
      usable.push(o);
    }
  }
  const leaves = shopeeSpecificationOptionLeaves(usable);
  const pickPool = leaves.length ? leaves : usable;
  if (!pickPool.length) return false;

  const findNoBrand = () =>
    pickPool.find((el) => {
      const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      return (
        tx === "no brand" ||
        tx.startsWith("no brand ") ||
        tx.includes("no brand") ||
        tx === "without brand" ||
        tx.startsWith("without brand ") ||
        tx.includes("without brand") ||
        tx.includes("ไม่มีแบรนด์") ||
        tx.includes("no-brand")
      );
    }) || null;

  function scoreOption(el) {
    const tx = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    let s = 0;
    for (const h of hints) {
      if (!h) continue;
      if (tx === h) s += 120;
      else if (tx.includes(h)) s += 70;
      else {
        for (const w of h.split(/\s+/)) {
          if (w.length > 2 && tx.includes(w)) s += 28;
        }
      }
    }
    if (/^other$|^others$|^misc|อื่น/i.test(tx) && hints.length && hints[0].length > 2) s -= 12;
    return s;
  }

  let best = pickPool[0];
  let bestS = scoreOption(best);
  for (let i = 1; i < pickPool.length; i++) {
    const sc = scoreOption(pickPool[i]);
    if (sc > bestS) {
      bestS = sc;
      best = pickPool[i];
    }
  }
  // If we have weak/no match confidence, prefer "No brand" when available.
  // This prevents accidentally selecting a random brand from a long list.
  const nb = findNoBrand();
  const looksBrandy =
    Boolean(prefLow && /brand|แบรนด์/i.test(prefLow)) || hints.some((h) => /brand|แบรนด์|unbrand|no brand/i.test(h));
  // Brand dropdowns are huge; short/partial brand strings can accidentally match random brands.
  // If we don't have a strong match, prefer "No brand" to clear required validation safely.
  const prefIsWeak =
    !prefLow ||
    prefLow.length < 3 ||
    /^(unknown|n\/a|na|none|null|generic|other|unbranded|no\s*brand|without\s*brand)$/.test(prefLow);
  const isStrongMatch = prefLow && (String(best.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === prefLow);
  const strongEnoughScore = bestS >= 95;
  if (nb && looksBrandy && (prefIsWeak || (!isStrongMatch && !strongEnoughScore))) {
    try {
      nb.click();
      return true;
    } catch {
      /* ignore */
    }
  }
  try {
    best.click();
    return true;
  } catch {
    return false;
  }
}

/**
 * Required + optional Specification rows — order matches typical Shopee apparel forms.
 * Uses listing_extra.shopee + title/description heuristics (no static marketplace crosswalk).
 */
function shopeeBuildSpecificationSteps(scan) {
  const ex = shopeeGetExtra(scan) || {};
  const shop =
    scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra.shopify : null;
  const blob = `${String(scan.title || "")} ${String(scan.description || "")}`.toLowerCase();

  const brandPref = (ex.brand != null && String(ex.brand)) || (shop && shop.vendor != null && String(shop.vendor)) || "";
  const brandHints = brandPref ? [] : ["unbranded", "no brand", "generic", "other", "ไม่มีแบรนด์"];

  const sleevePrefRaw = ex.sleeve_length != null ? String(ex.sleeve_length).trim() : "";
  /**
   * Sleeve length: prefer heuristic from listing text (t-shirt → short sleeves) and only treat a saved
   * preference as authoritative when it matches the heuristic. This prevents stale / wrong UI defaults
   * from forcing the wrong dropdown selection.
   */
  let sleeveHeuristic = "";
  if (/\btank\b|sleeveless\b/.test(blob)) sleeveHeuristic = "sleeveless";
  else if (/3\s*\/\s*4|three[\s-]*quarter|three-quarter|\b3q\b/.test(blob)) sleeveHeuristic = "threequarter";
  else if (/\blong[\s-]*sleeve\b/.test(blob)) sleeveHeuristic = "long";
  else if (/\bshort[\s-]*sleeve\b|\bt-?shirt\b|\bcrop\s*tee\b/.test(blob)) sleeveHeuristic = "short";
  else sleeveHeuristic = "short";

  const sleevePrefLow = sleevePrefRaw.toLowerCase();
  const prefMatchesHeuristic =
    !sleevePrefRaw
      ? false
      : sleeveHeuristic === "sleeveless"
        ? /sleeveless|tank/.test(sleevePrefLow)
        : sleeveHeuristic === "threequarter"
          ? /3\s*\/\s*4|three|quarter/.test(sleevePrefLow)
          : sleeveHeuristic === "long"
            ? /long/.test(sleevePrefLow)
            : /short/.test(sleevePrefLow);

  const sleevePref = prefMatchesHeuristic ? sleevePrefRaw : "";
  const sleeveHints = [];
  /** Shopee Seller Centre English apparel list (labels vary slightly by locale). */
  if (sleeveHeuristic === "sleeveless") {
    sleeveHints.push("sleeveless", "sleeve less", "tank");
  }
  if (sleeveHeuristic === "threequarter") {
    sleeveHints.push("3/4 sleeves", "3/4 sleeve", "3/4", "three quarter", "three-quarter");
  }
  if (sleeveHeuristic === "long") {
    sleeveHints.push("long sleeves", "long sleeve", "long");
  }
  if (sleeveHeuristic === "short") {
    sleeveHints.push("short sleeves", "short sleeve", "short", "t-shirt", "t shirt");
  }
  if (sleevePref) sleeveHints.push(sleevePref);

  const patternPref = ex.pattern != null ? String(ex.pattern) : "";
  const patternHints = [];
  if (patternPref) patternHints.push(patternPref);
  if (/\bstriped?\b|\bstripe(s)?\b/.test(blob)) patternHints.push("striped", "stripe");
  if (/\bplaid\b|\bcheck(ered)?\b|\bgingham\b/.test(blob)) patternHints.push("plaid", "check");
  if (/\bfloral?\b|\bflower\b/.test(blob)) patternHints.push("floral", "flower");
  if (/\bplain\b|\bsolid\b|\buni\b/.test(blob)) patternHints.push("plain", "solid");
  if (!patternHints.length) patternHints.push("plain", "solid");

  const genderPref = ex.gender != null ? String(ex.gender) : "";
  const genderHints = [];
  if (genderPref) genderHints.push(genderPref);
  if (/\b(women|women's|womens|lad(y|ies)|female)\b/.test(blob)) genderHints.push("women", "female", "ladies");
  if (/\b(men|men's|mens|male)\b/.test(blob)) genderHints.push("men", "male");
  if (/\bunisex\b/.test(blob)) genderHints.push("unisex");
  if (/\b(kids?|children|boys?|girls?|toddler)\b/.test(blob)) genderHints.push("kids", "boy", "girl");

  const materialPref = ex.material != null ? String(ex.material) : "";
  const materialHints = [];
  if (materialPref) materialHints.push(materialPref);
  if (/\bcotton\b/.test(blob)) materialHints.push("cotton");
  if (/\b(polyester|nylon|spandex|elastane|lycra)\b/.test(blob)) materialHints.push("polyester", "nylon", "spandex");
  if (/\bleather\b/.test(blob)) materialHints.push("leather");
  if (/\bwool\b/.test(blob)) materialHints.push("wool");
  if (/\bsilk\b/.test(blob)) materialHints.push("silk");
  if (!materialHints.length) materialHints.push("cotton", "polyester");

  const occasionHints = [];
  if (/\bcasual\b/.test(blob)) occasionHints.push("casual");
  if (/\b(formal|office|work)\b/.test(blob)) occasionHints.push("formal", "work");
  if (/\b(sport|gym|athletic|running)\b/.test(blob)) occasionHints.push("sports", "athletic");
  if (!occasionHints.length) occasionHints.push("casual");

  const styleHints = [];
  if (/\bcasual\b/.test(blob)) styleHints.push("casual", "basic");
  if (/\bstreet\b|\burban\b/.test(blob)) styleHints.push("street");
  if (/\bvintage\b/.test(blob)) styleHints.push("vintage");
  if (!styleHints.length) styleHints.push("casual", "basic");

  const seasonHints = [];
  if (/\b(summer|spring)\b/.test(blob)) seasonHints.push("summer", "spring");
  if (/\b(winter|autumn|fall)\b/.test(blob)) seasonHints.push("winter", "autumn");
  if (!seasonHints.length) seasonHints.push("all season", "summer");

  const necklineHints = [];
  if (/\b(v-?neck|v neck)\b/.test(blob)) necklineHints.push("v-neck", "v neck");
  if (/\b(crew|round)\s*neck\b/.test(blob)) necklineHints.push("crew", "round");
  if (/\b(off[\s-]?shoulder|boat\s*neck)\b/.test(blob)) necklineHints.push("boat", "off shoulder");
  if (!necklineHints.length) necklineHints.push("round", "crew");

  return [
    { re: /\*?\s*brand\b|แบรนด์/i, pref: brandPref, hints: brandHints },
    { re: /\*?\s*sleeve\s*length\b/i, pref: sleevePref, hints: sleeveHints },
    { re: /\*?\s*pattern\b/i, pref: patternPref, hints: patternHints },
    { re: /\*?\s*gender\b/i, pref: genderPref, hints: genderHints },
    { re: /\*?\s*material\b/i, pref: materialPref, hints: materialHints },
    { re: /\*?\s*occasion\b/i, pref: "", hints: occasionHints },
    { re: /\*?\s*style\b/i, pref: "", hints: styleHints },
    { re: /\*?\s*season\b/i, pref: "", hints: seasonHints },
    { re: /\*?\s*neckline\b/i, pref: "", hints: necklineHints },
    { re: /\*?\s*country\s*of\s*origin\b/i, pref: "", hints: ["thailand", "china", "vietnam", "usa", "japan"] },
  ];
}

/**
 * Specification tab: required + optional attributes. Runs every Magic Fill tick until all steps succeed
 * or are skipped (no row). Clicks Specification tab while work remains — not tied to tab rotation.
 */
function shopeeSpecificationDropdownsTick(scan, rootEl) {
  const pickerOpen = shopeeFindCategoryPickerSurface(rootEl);
  if (pickerOpen) {
    console.log("[SyncLyst] Shopee Specification: bailing out, category picker surface detected as open", pickerOpen);
    return 0;
  }
  const win = rootEl.defaultView || window;
  const steps = shopeeBuildSpecificationSteps(scan);
  console.log("[SyncLyst] Shopee Specification: built", steps.length, "step(s)", steps);
  const stepsKey = `${steps.length}|${String(scan.title || "").slice(0, 48)}|${String(scan.description || "").length}`;
  if (win.__synclystShopeeSpecKey !== stepsKey) {
    win.__synclystShopeeSpecDD = null;
    win.__synclystShopeeSpecFinished = false;
    win.__synclystShopeeSpecKey = stepsKey;
  }
  if (win.__synclystShopeeSpecFinished) {
    console.log("[SyncLyst] Shopee Specification: already marked finished, skipping");
    return 0;
  }

  shopeeClickTabByLabel(rootEl, [/specification/i, "specification", "สเปค", "ข้อมูลจำเพาะ"]);

  function shopeeFindOpenDropdownSearchInput(row) {
    const isUsable = (inp) => {
      if (!(inp instanceof HTMLInputElement)) return false;
      if (!isVisible(inp) || inp.disabled || inp.readOnly) return false;
      const ty = (inp.type || "").toLowerCase();
      if (ty === "hidden" || ty === "file" || ty === "checkbox" || ty === "radio") return false;
      const im = (inp.inputMode || inp.getAttribute("inputmode") || "").toLowerCase();
      if (im === "numeric" || im === "decimal") return false;
      const blob = `${inp.name || ""} ${inp.id || ""} ${inp.getAttribute("aria-label") || ""} ${inp.placeholder || ""}`
        .toLowerCase()
        .trim();
      if (/\bprice\b|\bstock\b|\bqty\b|\bweight\b|\bbarcode\b|\bgtin\b/.test(blob)) return false;
      return true;
    };

    try {
      if (row instanceof HTMLElement) {
        const local = row.querySelector(
          'input[placeholder*="input" i], input[placeholder*="least" i], input[type="search"], input[type="text"]'
        );
        if (isUsable(local)) return local;
      }
    } catch {
      /* ignore */
    }

    // Prefer inputs inside visible listbox/menu overlays (avoids picking unrelated page inputs).
    try {
      const lbs = querySelectorAllDeep('[role="listbox"], [role="menu"]', document.body);
      for (const lb of lbs) {
        if (!(lb instanceof HTMLElement) || !isVisible(lb)) continue;
        const inp = lb.querySelector(
          'input[placeholder*="input" i], input[placeholder*="least" i], input[type="search"], input[type="text"]'
        );
        if (isUsable(inp)) return inp;
      }
    } catch {
      /* ignore */
    }

    return null;
  }

  if (!win.__synclystShopeeSpecDD) {
    win.__synclystShopeeSpecDD = { i: 0, phase: "open", t: 0 };
  }
  const st = win.__synclystShopeeSpecDD;
  if (st.i >= steps.length) {
    win.__synclystShopeeSpecFinished = true;
    win.__synclystShopeeSpecDD = null;
    return 0;
  }
  const cur = steps[st.i];
  if (st.phase === "open") {
    const row = shopeeFindSmallestRowMatching(rootEl, cur.re);
    if (!row) {
      st.i++;
      return 0;
    }
    // Remember the active row for the pick phase (needed for Brand search inputs).
    st.row = row;
    let sel = row.querySelector("select");
    if (sel instanceof HTMLSelectElement && isVisible(sel) && sel.options.length > 1) {
      let bestJ = -1;
      let bestScore = -1;
      for (let j = 1; j < sel.options.length; j++) {
        const ot = (sel.options[j].textContent || "").trim().toLowerCase();
        if (!ot || /please\s*select|^--/.test(ot)) continue;
        const hints = [cur.pref, ...(cur.hints || [])].filter(Boolean).map((x) => String(x).toLowerCase());
        let sc = 0;
        for (const h of hints) {
          if (ot === h) sc += 100;
          else if (ot.includes(h)) sc += 60;
        }
        if (sc > bestScore) {
          bestScore = sc;
          bestJ = j;
        }
      }
      const pickJ = bestJ >= 1 ? bestJ : 1;
      const ot = (sel.options[pickJ].textContent || "").trim().toLowerCase();
      if (ot && !/please\s*select|^--/.test(ot)) {
        sel.selectedIndex = pickJ;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        st.i++;
        return 1;
      }
    }
    const trig =
      row.querySelector('[role="combobox"]') ||
      row.querySelector('input[readonly]') ||
      row.querySelector("button[aria-haspopup]") ||
      row.querySelector('[aria-haspopup="listbox"]');
    if (!trig || !isVisible(trig)) return 0;
    try {
      trig.scrollIntoView({ block: "nearest", behavior: "auto" });
      (trig instanceof HTMLElement ? trig : trig.parentElement)?.click();
    } catch {
      return 0;
    }
    st.phase = "pick";
    st.t = Date.now();
    return 1;
  }
  if (st.phase === "pick") {
    if (Date.now() - st.t < 40) return 0;
    const pref = cur.pref && String(cur.pref).trim() ? cur.pref : null;
    const hints = cur.hints || [];

    function shopeePickBrandExactOrNoBrand(prefRaw, row) {
      const want = prefRaw != null ? String(prefRaw).trim() : "";
      const wantLow = want.toLowerCase();
      const noBrandRe = /\b(no\s*brand|without\s*brand|unbranded|generic|other)\b|ไม่มีแบรนด์|ไร้แบรนด์/i;
      const win = (rootEl && rootEl.ownerDocument && rootEl.ownerDocument.defaultView) || window;

      const brandLooksSelected = () => {
        try {
          const r = row && row instanceof HTMLElement ? row : null;
          if (!r) return false;
          const inp =
            r.querySelector('input[readonly], input[aria-haspopup], input[aria-expanded], [role="combobox"] input') ||
            r.querySelector('input[type="text"]') ||
            null;
          if (inp instanceof HTMLInputElement) {
            const v = String(inp.value || "").replace(/\s+/g, " ").trim();
            if (v && !/please\s*select/i.test(v)) return true;
          }
          const t = (r.textContent || "").replace(/\s+/g, " ").trim();
          // If the row no longer shows placeholder, assume selection stuck.
          return t && !/please\s*select/i.test(t);
        } catch {
          return false;
        }
      };

      const forceCommitBrandValue = (label) => {
        try {
          const r = row && row instanceof HTMLElement ? row : null;
          if (!r) return false;
          const trig =
            r.querySelector('[role="combobox"] input') ||
            r.querySelector('input[readonly]') ||
            r.querySelector('input[aria-haspopup]') ||
            r.querySelector('input[aria-expanded]') ||
            r.querySelector('input[type="text"]');
          if (!(trig instanceof HTMLInputElement) || trig.disabled) return false;
          const v = String(label || "").replace(/\s+/g, " ").trim();
          if (!v) return false;
          // Many Shopee comboboxes are readonly but still validate based on value; fillField temporarily unsets readonly.
          fillField(trig, v);
          try {
            trig.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
          } catch {
            /* ignore */
          }
          return brandLooksSelected();
        } catch {
          return false;
        }
      };

      const openBrandDropdownIfClosed = () => {
        try {
          const r = row && row instanceof HTMLElement ? row : null;
          if (!r) return false;
          const trig =
            r.querySelector('[role="combobox"]') ||
            r.querySelector('input[readonly]') ||
            r.querySelector("button[aria-haspopup]") ||
            r.querySelector('[aria-haspopup="listbox"]') ||
            r.querySelector('div[tabindex="0"]');
          if (trig instanceof HTMLElement && isVisible(trig)) {
            trig.scrollIntoView({ block: "nearest", behavior: "auto" });
            trig.click();
            trig.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
            return true;
          }
        } catch {
          /* ignore */
        }
        return false;
      };

      const surfaces = [];
      try {
        const raw = querySelectorAllDeep('[role="listbox"], [role="menu"]', document.body);
        for (const el of raw) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
          const t = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!t || t.length < 2 || t.length > 7000) continue;
          surfaces.push(el);
        }
      } catch {
        /* ignore */
      }
      const roots = surfaces.length ? surfaces : [document.body];
      const opts = [];
      for (const r of roots) {
        let nodes = [];
        try {
          nodes = Array.from(
            r.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li[role="option"], li, div')
          );
        } catch {
          nodes = [];
        }
        for (const el of nodes) {
          if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
          const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!tx || tx.length > 180) continue;
          if (/please\s*select|^--|select\s*one|choose/i.test(tx)) continue;
          if (/please\s*input\s*at\s*least/i.test(tx)) continue;
          if (/add\s+a\s+new\s+item|^\+/i.test(tx)) continue;
          opts.push(el);
        }
      }
      const pickPool = (() => {
        const leaves = shopeeSpecificationOptionLeaves(opts);
        return leaves.length ? leaves : opts;
      })();

      const clickEl = (el) => {
        try {
          el.scrollIntoView({ block: "nearest", behavior: "auto" });
        } catch {
          /* ignore */
        }
        // Shopee overlays often mean `el` isn't the actual hit-tested target.
        // Prefer clicking the center point's real element.
        try {
          const r = el.getBoundingClientRect();
          const cx = Math.floor(r.left + r.width / 2);
          const cy = Math.floor(r.top + r.height / 2);
          const hit = (el.ownerDocument && el.ownerDocument.elementFromPoint && el.ownerDocument.elementFromPoint(cx, cy)) || null;
          if (hit instanceof HTMLElement) el = hit;
        } catch {
          /* ignore */
        }
        try {
          // Shopee sometimes binds on pointer events; send a full click sequence.
          try {
            el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: win, pointerType: "mouse" }));
            el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: win, pointerType: "mouse" }));
          } catch {
            /* ignore */
          }
          el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: win }));
          el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: win }));
          el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: win }));
          return true;
        } catch {
          try {
            el.click();
            return true;
          } catch {
            return false;
          }
        }
      };

      // 1) If Shopee shows the exact brand, pick it.
      if (wantLow) {
        const exact = pickPool.find((el) => (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase() === wantLow);
        if (exact && clickEl(exact)) return true;
      }

      // 2) Otherwise, always choose No brand / Unbranded to clear required validation.
      const nb =
        pickPool.find((el) => noBrandRe.test((el.textContent || "").replace(/\s+/g, " ").trim())) ||
        opts.find((el) => noBrandRe.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      if (nb) {
        openBrandDropdownIfClosed();
        if (clickEl(nb)) {
          if (brandLooksSelected()) return true;
          // If Shopee didn't commit the selection, force the combobox value.
          return forceCommitBrandValue("No brand");
        }
      }

      // 2b) If listbox roles are missing, click any visible element whose text contains "No brand".
      try {
        openBrandDropdownIfClosed();
        const candidates = querySelectorAllDeep("div, li, button, span, p", document.body);
        for (const el of candidates) {
          if (!(el instanceof HTMLElement)) continue;
          if (!(isVisible(el) || vintedLayoutInteractable(el, 6, 6))) continue;
          const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
          if (!tx || tx.length > 140) continue;
          if (!noBrandRe.test(tx)) continue;
          if (clickEl(el)) {
            if (brandLooksSelected()) return true;
            return forceCommitBrandValue("No brand");
          }
        }
      } catch {
        /* ignore */
      }

      // 3) If not visible, type "No brand" into the dropdown search, then try again.
      try {
        const search = shopeeFindOpenDropdownSearchInput(row);
        if (search) {
          const curVal = String(search.value || "").trim().toLowerCase();
          if (curVal !== "no brand") {
            fillField(search, "No brand");
            try {
              // Some Shopee comboboxes accept Enter to select the top option.
              search.dispatchEvent(
                new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, view: win })
              );
              search.dispatchEvent(
                new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true, view: win })
              );
            } catch {
              /* ignore */
            }
            // Give Shopee a moment to filter results.
            if (Date.now() - st.t < 260) return false;
          }
        }
      } catch {
        /* ignore */
      }

      const pickPool2 = shopeeSpecificationOptionLeaves(
        (() => {
          const arr = [];
          for (const r of roots) {
            let nodes = [];
            try {
              nodes = Array.from(
                r.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"], li[role="option"], li, div')
              );
            } catch {
              nodes = [];
            }
            for (const el of nodes) {
              if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
              const tx = (el.textContent || "").replace(/\s+/g, " ").trim();
              if (!tx || tx.length > 180) continue;
              if (/please\s*select|^--|select\s*one|choose/i.test(tx)) continue;
              if (/please\s*input\s*at\s*least/i.test(tx)) continue;
              if (/add\s+a\s+new\s+item|^\+/i.test(tx)) continue;
              arr.push(el);
            }
          }
          return arr;
        })()
      );
      const nb2 = pickPool2.find((el) => noBrandRe.test((el.textContent || "").replace(/\s+/g, " ").trim()));
      if (nb2) {
        openBrandDropdownIfClosed();
        if (clickEl(nb2)) {
          if (brandLooksSelected()) return true;
          return forceCommitBrandValue("No brand");
        }
      }

      return false;
    }

    // Shopee Brand combobox commonly requires typing >=2 characters. If we have a brand pref,
    // try to type it into the open dropdown search input once, then pick. If we can't match,
    // we fall back to "No brand" (handled inside shopeePickBestSpecificationOption).
    try {
      if (cur && cur.re && /\bbrand\b|แบรนด์/i.test(String(cur.re))) {
        const want = pref != null ? String(pref).trim() : "";
        if (want && want.length >= 2) {
          const row = st.row && st.row instanceof HTMLElement ? st.row : null;
          const search = shopeeFindOpenDropdownSearchInput(row);
          if (search && String(search.value || "").trim().toLowerCase() !== want.toLowerCase()) {
            // Use our React-friendly setter/events instead of raw .value assignment.
            fillField(search, want);
            // Give Shopee a moment to filter results.
            if (Date.now() - st.t < 220) return 0;
          }
        }
        // Deterministic brand behavior: only accept exact brand; otherwise choose No brand/Unbranded.
        const row = st.row && st.row instanceof HTMLElement ? st.row : null;
        if (shopeePickBrandExactOrNoBrand(pref, row)) {
          st.i++;
          st.phase = "open";
          st.row = null;
          return 1;
        }
        // Don't allow falling through to generic picker (which can pick random brands).
        return 0;
      }
    } catch {
      /* ignore */
    }

    /** Sleeve Length (and similar) dropdowns often show “Please input at least 1 character” — filter before pick. */
    try {
      if (cur && cur.re && /\bsleeve\s*length\b/i.test(String(cur.re))) {
        const row = st.row && st.row instanceof HTMLElement ? st.row : null;
        const ordered = hints
          .map((h) => String(h).trim())
          .filter((h) => h.length >= 1 && !/^t-?shirt$/i.test(h))
          .sort((a, b) => b.length - a.length);
        let want = ordered.find((h) => h.length >= 4) || ordered[0] || "short";
        if (want.length > 24) want = want.slice(0, 24);
        const search = shopeeFindOpenDropdownSearchInput(row);
        if (search && want.length >= 1) {
          const curVal = String(search.value || "").trim().toLowerCase();
          if (curVal !== want.toLowerCase()) {
            fillField(search, want);
            if (Date.now() - st.t < 240) return 0;
          }
        }
      }
    } catch {
      /* ignore */
    }

    if (shopeePickBestSpecificationOption(pref, hints)) {
      st.i++;
      st.phase = "open";
      st.row = null;
      return 1;
    }
    if (Date.now() - st.t > 4500) {
      st.phase = "open";
      st.t = 0;
      st.i++;
      st.row = null;
    }
    return 0;
  }
  return 0;
}

/** Placeholder / marketing copy — not a real template row. */
function shopeeOptionLooksLikeSizeChartPlaceholder(ot) {
  const t = (ot || "").trim().toLowerCase();
  if (!t) return true;
  if (/please\s*select|^--|^-\s*$/.test(t)) return true;
  if (/use the size chart|search exposure|will increase/.test(t)) return true;
  return false;
}

function shopeeSelectFirstRealSizeTemplateOption(sel) {
  if (!(sel instanceof HTMLSelectElement) || sel.options.length < 2) return false;
  const preferRe = /\bint\b|international|inter\s*nation|size\s*\(int\)|tops?/i;
  let bestIdx = -1;
  let bestScore = -Infinity;
  const score = (t) => {
    const s = String(t || "").trim();
    if (!s) return -Infinity;
    if (shopeeOptionLooksLikeSizeChartPlaceholder(s)) return -Infinity;
    let sc = 0;
    if (preferRe.test(s)) sc += 50;
    // Prefer templates that look like actual templates (not tips).
    if (/\btemplate\b/i.test(s)) sc += 8;
    if (/\b(size|chart)\b/i.test(s)) sc += 6;
    // Slightly prefer shorter names (less likely to be long help text).
    sc -= Math.min(12, Math.max(0, s.length - 30) / 8);
    return sc;
  };
  for (let i = 0; i < sel.options.length; i++) {
    const o = sel.options[i];
    const ot = (o.textContent || "").trim();
    const val = o.value;
    if (val === "" || val == null) continue;
    const sc = score(ot);
    if (sc > bestScore) {
      bestScore = sc;
      bestIdx = i;
    }
  }
  if (bestIdx >= 0) {
    const o = sel.options[bestIdx];
    const ot = (o.textContent || "").trim();
    if (!shopeeOptionLooksLikeSizeChartPlaceholder(ot)) {
      sel.focus();
      sel.selectedIndex = bestIdx;
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
  for (let i = 0; i < sel.options.length; i++) {
    const o = sel.options[i];
    const ot = (o.textContent || "").trim();
    if (shopeeOptionLooksLikeSizeChartPlaceholder(ot)) continue;
    const val = o.value;
    if (val === "" || val == null) continue;
    sel.focus();
    sel.selectedIndex = i;
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }
  return false;
}

function shopeeFindOpenDialogByText(rootEl, re) {
  try {
    const nodes = querySelectorAllDeep('div[role="dialog"], [role="dialog"], .ant-modal, .modal', rootEl);
    for (const n of nodes) {
      if (!(n instanceof HTMLElement) || !isVisible(n)) continue;
      const t = (n.textContent || "").replace(/\s+/g, " ").trim();
      if (!t || t.length > 9000) continue;
      if (re.test(t)) return n;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function shopeeFillSizeChartCreationModal(rootEl) {
  const dlg = shopeeFindOpenDialogByText(rootEl, /\badd\s*new\s*size\s*chart\b|\bsize\s*chart\s*name\b/i);
  if (!dlg) return false;
  let did = false;
  try {
    // Name field (required)
    const nameInput =
      dlg.querySelector('input[placeholder*="size chart name" i]') ||
      dlg.querySelector('input[aria-label*="size chart name" i]') ||
      dlg.querySelector('input[type="text"]');
    if (nameInput instanceof HTMLInputElement && isVisible(nameInput) && !nameInput.disabled) {
      const cur = String(nameInput.value || "").trim();
      if (!cur) {
        nameInput.focus();
        nameInput.value = "SyncLyst INT";
        nameInput.dispatchEvent(new Event("input", { bubbles: true }));
        nameInput.dispatchEvent(new Event("change", { bubbles: true }));
        did = true;
      }
    }

    // Ensure Size (INT) is checked (common requirement)
    const labels = Array.from(dlg.querySelectorAll("label"));
    for (const lab of labels) {
      const lt = (lab.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      if (!lt) continue;
      if (!/(size\s*\(int\)|\bint\b)/i.test(lt)) continue;
      const cb = lab.querySelector('input[type="checkbox"]');
      if (cb instanceof HTMLInputElement && !cb.disabled && !cb.checked) {
        lab.click();
        did = true;
      }
      break;
    }

    // Measurement unit dropdown: prefer cm if present.
    const unitSel = dlg.querySelector("select");
    if (unitSel instanceof HTMLSelectElement && isVisible(unitSel) && unitSel.options.length > 1) {
      let pick = -1;
      for (let i = 0; i < unitSel.options.length; i++) {
        const ot = (unitSel.options[i].textContent || "").trim().toLowerCase();
        if (ot === "cm" || ot.includes("cm")) {
          pick = i;
          break;
        }
      }
      if (pick >= 0 && unitSel.selectedIndex !== pick) {
        unitSel.selectedIndex = pick;
        unitSel.dispatchEvent(new Event("input", { bubbles: true }));
        unitSel.dispatchEvent(new Event("change", { bubbles: true }));
        did = true;
      }
    }

    // Fill at least one row in the table so Shopee accepts the template.
    // We do not try to be "accurate" here; we just unblock validation.
    const table = dlg.querySelector("table") || dlg.querySelector('[role="table"]');
    if (table instanceof HTMLElement) {
      const inputs = Array.from(table.querySelectorAll("input")).filter(
        (x) => x instanceof HTMLInputElement
      );
      for (const inp of inputs) {
        if (!(inp instanceof HTMLInputElement) || !isVisible(inp) || inp.disabled || inp.readOnly) continue;
        const v = String(inp.value || "").trim();
        if (v) continue;
        const ph = String(inp.getAttribute("placeholder") || "").toLowerCase();
        // Prefer a size token in the first column if it's text-like.
        const fill =
          /size/.test(ph) || inp.type === "text" ? "S" : "1";
        inp.focus();
        inp.value = fill;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        did = true;
        // Only need to seed a couple fields; Shopee often accepts minimal row.
        if (fill === "S") continue;
      }
    }

    // Click Save if present and form is populated.
    const buttons = Array.from(dlg.querySelectorAll("button")).filter((b) => b instanceof HTMLElement);
    const saveBtn = buttons.find((b) => /\bsave\b/i.test((b.textContent || "").trim()));
    if (saveBtn instanceof HTMLElement && isVisible(saveBtn)) {
      // Only click save if we did something or fields are already filled.
      if (did) {
        try {
          saveBtn.click();
          return true;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return did;
}

/**
 * Shopee requires a size chart for many categories — it cannot be “bypassed” for publish. We pick the first
 * real template (native select or combobox + listbox). Optional listing_extra.shopee.size_chart_pick_first === false skips.
 */
function shopeePickSizeChartTemplateIfRequired(rootEl) {
  try {
    // If the "Add New Size Chart" modal is open, fill it.
    if (shopeeFillSizeChartCreationModal(rootEl)) return true;

    shopeeClickTabByLabel(rootEl, [
      /sales\s*information/i,
      "sales information",
      "sales",
      "ข้อมูลการขาย",
    ]);
    const win = rootEl.defaultView || window;
    if (!win.__synclystShopeeSz) {
      win.__synclystShopeeSz = { phase: "open", t: 0 };
    }
    const st = win.__synclystShopeeSz;

    let scope = null;
    for (const sec of querySelectorAllDeep("div, section, form", rootEl)) {
      if (!(sec instanceof HTMLElement) || !isVisible(sec)) continue;
      const t = (sec.textContent || "").slice(0, 700);
      if (/\bsize\s*chart\b/i.test(t)) {
        scope = sec;
        break;
      }
    }
    if (!scope) {
      win.__synclystShopeeSz = null;
      return false;
    }

    for (const r of scope.querySelectorAll('input[type="radio"], [role="radio"]')) {
      if (!(r instanceof HTMLElement)) continue;
      const lab = `${r.closest("label")?.textContent || ""} ${r.getAttribute("aria-label") || ""}`.toLowerCase();
      if (!/\btemplate\b/.test(lab)) continue;
      if (r instanceof HTMLInputElement && !r.disabled) {
        if (!r.checked) {
          r.click();
          return true;
        }
        break;
      }
      if (r.getAttribute("role") === "radio" && r.getAttribute("aria-checked") === "false") {
        r.click();
        return true;
      }
    }

    for (const sel of scope.querySelectorAll("select")) {
      if (!(sel instanceof HTMLSelectElement) || !isVisible(sel)) continue;
      const near = (sel.closest("div, section")?.textContent || "").toLowerCase();
      if (!/size\s*chart|template/.test(near) && sel.options.length > 8) continue;
      if (shopeeSelectFirstRealSizeTemplateOption(sel)) {
        win.__synclystShopeeSz = null;
        return true;
      }
    }

    if (st.phase === "open") {
      const trig =
        Array.from(
          scope.querySelectorAll(
            [
              '[role="combobox"]',
              'input[readonly]',
              'input[aria-haspopup]',
              'input[aria-expanded]',
              'input[placeholder*="size chart" i]',
              'input[placeholder*="use the size chart" i]',
              'div[tabindex="0"]',
              '[aria-haspopup="listbox"]',
            ].join(", ")
          )
        ).find(
          (el) =>
            el instanceof HTMLElement &&
            isVisible(el) &&
            /size|chart|template|exposure/i.test(
              `${el.getAttribute("aria-label") || ""} ${el.getAttribute("placeholder") || ""}`
            )
        ) ||
        scope.querySelector('[role="combobox"]') ||
        scope.querySelector("input[readonly]") ||
        scope.querySelector('input[placeholder*="size chart" i]');
      if (trig instanceof HTMLElement && isVisible(trig)) {
        try {
          trig.scrollIntoView({ block: "nearest", behavior: "auto" });
          trig.click();
        } catch {
          /* ignore */
        }
        st.phase = "pick";
        st.t = Date.now();
        return true;
      }
    }
    if (st.phase === "pick") {
      if (Date.now() - st.t < 45) return false;
      const opts = querySelectorAllDeep(
        [
          '[role="listbox"] [role="option"]',
          '[role="menu"] [role="menuitem"]',
          'ul li[role="option"]',
          // Some Shopee regions render dropdown rows without ARIA roles.
          '[role="listbox"] li',
          '[role="listbox"] div',
          'ul[aria-label] li',
          'ul[class] li',
        ].join(", "),
        document.body
      );
      const scan = win.__synclystShopeeLastScan && typeof win.__synclystShopeeLastScan === "object" ? win.__synclystShopeeLastScan : {};
      const blob = `${String(scan.title || "")} ${String(scan.description || "")}`.toLowerCase();
      const ex = shopeeGetExtra(scan) || {};
      const sizeHint = `${String(ex.size_scale || "")} ${String(ex.size || "")} ${blob}`.toLowerCase();
      const wantsOneSize =
        /\bone\s*size\b|\bos\b|\bfree\s*size\b|\bfreesize\b|\buni\s*size\b|\bsize\s*free\b/.test(sizeHint) ||
        /\b(one\s*size|os)\b/i.test(String(scan.title || ""));

      const preferIntlRe = /\bint\b|international|inter\s*nation|size\s*\(int\)|tops?|s\s*\/\s*m\s*\/\s*l|\bxs\b|\bxl\b/i;
      const preferOneSizeRe = /\bone\s*size\b|\bfree\s*size\b|\bfreesize\b|\buni\s*size\b/i;
      let best = null;
      let bestScore = -Infinity;
      for (const o of opts) {
        if (!(o instanceof HTMLElement) || !isVisible(o)) continue;
        const tx = (o.textContent || "").replace(/\s+/g, " ").trim();
        if (shopeeOptionLooksLikeSizeChartPlaceholder(tx.toLowerCase())) continue;
        if (tx.length < 2 || tx.length > 200) continue;
        let sc = 0;
        if (wantsOneSize) {
          if (preferOneSizeRe.test(tx)) sc += 90;
          if (preferIntlRe.test(tx)) sc += 25;
        } else {
          if (preferIntlRe.test(tx)) sc += 75;
          if (preferOneSizeRe.test(tx)) sc += 15;
        }
        if (/\btemplate\b/i.test(tx)) sc += 10;
        if (/\b(size|chart)\b/i.test(tx)) sc += 6;
        sc -= Math.min(12, Math.max(0, tx.length - 30) / 10);
        if (sc > bestScore) {
          bestScore = sc;
          best = o;
        }
      }
      if (best) {
        try {
          best.click();
          win.__synclystShopeeSz = null;
          return true;
        } catch {
          /* ignore */
        }
      }
      if (Date.now() - st.t > 4000) {
        st.phase = "open";
        st.t = 0;
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function depopGetExtra(scan) {
  const raw = scan.listing_extra;
  if (!raw || typeof raw !== "object") return null;
  const d = raw.depop;
  return d && typeof d === "object" ? d : null;
}

/** Depop “Age” combobox labels (web, 2026). */
const DEPOP_AGE_OPTIONS = ["Modern", "00s", "90s", "80s", "70s", "60s", "50s", "Antique"];

/** Depop “Source” combobox labels (web, 2026). */
const DEPOP_SOURCE_OPTIONS = [
  "Vintage",
  "Preloved",
  "Reworked / Upcycled",
  "Custom",
  "Handmade",
  "Deadstock",
  "Designer",
  "Repaired",
];

/** Depop “Condition” combobox (Info section, web 2026). */
const DEPOP_CONDITION_OPTIONS = [
  "Brand new",
  "Like new",
  "Used - Excellent",
  "Used - Good",
  "Used - Fair",
];

function normalizeDepopSourceLabel(raw) {
  const s = raw != null ? String(raw).trim() : "";
  if (!s) return "";
  if (DEPOP_SOURCE_OPTIONS.includes(s)) return s;
  const lower = s.toLowerCase().replace(/\s+/g, " ");
  const oneWord = {
    vintage: "Vintage",
    preloved: "Preloved",
    custom: "Custom",
    handmade: "Handmade",
    deadstock: "Deadstock",
    designer: "Designer",
    repaired: "Repaired",
    upcycled: "Reworked / Upcycled",
    reworked: "Reworked / Upcycled",
  };
  if (oneWord[lower]) return oneWord[lower];
  if (lower.includes("reworked") || lower.includes("upcycled")) return "Reworked / Upcycled";
  if (lower === "pre-loved" || lower === "pre loved") return "Preloved";
  return "";
}

/** Title, description, and extras — same signals vision/AI usually fills. */
function depopGatherInferenceText(scan) {
  const chunks = [];
  const push = (x) => {
    if (x == null) return;
    const t = String(x).trim();
    if (t) chunks.push(t);
  };
  push(scan.title);
  push(scan.description);
  try {
    const ex = scan.listing_extra || {};
    const d = ex.depop && typeof ex.depop === "object" ? ex.depop : null;
    if (d) {
      push(d.condition);
      push(d.style);
      push(d.brand);
      push(d.category);
    }
    const vt = ex.vinted && typeof ex.vinted === "object" ? ex.vinted : null;
    if (vt) push(vt.condition);
    const sh = ex.shopify && typeof ex.shopify === "object" ? ex.shopify : null;
    if (sh) {
      push(sh.product_type);
      push(sh.tags);
    }
  } catch {
    /* ignore */
  }
  return chunks.join(" \n ");
}

/** Omits listing_extra.depop.condition so inference is driven by title/description and other platforms’ condition fields. */
function depopGatherConditionInferenceText(scan) {
  const chunks = [];
  const push = (x) => {
    if (x == null) return;
    const t = String(x).trim();
    if (t) chunks.push(t);
  };
  push(scan.title);
  push(scan.description);
  try {
    const ex = scan.listing_extra || {};
    const d = ex.depop && typeof ex.depop === "object" ? ex.depop : null;
    if (d) {
      push(d.style);
      push(d.brand);
      push(d.category);
    }
    const vt = ex.vinted && typeof ex.vinted === "object" ? ex.vinted : null;
    if (vt) push(vt.condition);
    const eb = ex.ebay && typeof ex.ebay === "object" ? ex.ebay : null;
    if (eb) push(eb.condition);
    const sh = ex.shopify && typeof ex.shopify === "object" ? ex.shopify : null;
    if (sh) {
      push(sh.product_type);
      push(sh.tags);
    }
  } catch {
    /* ignore */
  }
  return chunks.join(" \n ");
}

function normalizeDepopConditionLabel(raw) {
  const s = raw != null ? String(raw).trim() : "";
  if (!s) return "";
  if (DEPOP_CONDITION_OPTIONS.includes(s)) return s;
  const lower = s.toLowerCase().replace(/\s+/g, " ");
  /** Vision / UCP enums: new, like_new, good, fair, for_parts */
  const semanticKey = lower.replace(/_/g, " ").trim();
  const semantic = {
    new: "Brand new",
    "like new": "Like new",
    good: "Used - Good",
    fair: "Used - Fair",
    "for parts": "Used - Fair",
  };
  if (semantic[semanticKey]) return semantic[semanticKey];
  const exact = {
    "brand new": "Brand new",
    "like new": "Like new",
    "used - excellent": "Used - Excellent",
    "used excellent": "Used - Excellent",
    "used - good": "Used - Good",
    "used good": "Used - Good",
    "used - fair": "Used - Fair",
    "used fair": "Used - Fair",
    new: "Brand new",
    nwt: "Brand new",
    bnwt: "Brand new",
    deadstock: "Brand new",
    excellent: "Used - Excellent",
    good: "Used - Good",
    fair: "Used - Fair",
  };
  if (exact[lower]) return exact[lower];
  if (lower.includes("like new")) return "Like new";
  if (lower.includes("new with tags") || lower.includes("brand new")) return "Brand new";
  if (lower.includes("used - excellent") || lower.includes("used excellent")) return "Used - Excellent";
  if (lower.includes("used - good") || /^used good$/i.test(s.trim())) return "Used - Good";
  if (lower.includes("used - fair") || lower.includes("used fair")) return "Used - Fair";
  if (/\b(excellent|mint|great)\b/i.test(lower) && !/good|fair/.test(lower)) return "Used - Excellent";
  if (/\bvery\s+good\b/i.test(lower)) return "Used - Excellent";
  if (/\b(satisfactory|acceptable)\b/i.test(lower)) return "Used - Fair";
  return "";
}

function inferDepopConditionFromScan(scan) {
  const text = depopGatherConditionInferenceText(scan).toLowerCase();
  if (!text.trim()) return "Used - Good";

  if (
    /\b(bnwt|nwt\b|new with tags|brand new|deadstock|tags attached|unworn with tags|sealed in box)\b/i.test(text)
  ) {
    return "Brand new";
  }
  if (/\b(like new|worn once|worn twice|pristine|barely worn|as new)\b/i.test(text)) {
    return "Like new";
  }
  if (
    /\b(heavy wear|major flaw|holes?|ripped|torn|stains?|damaged|well worn|poor condition|significant wear)\b/i.test(
      text
    )
  ) {
    return "Used - Fair";
  }
  if (/used\s*-\s*excellent|used\s+excellent\b/i.test(text)) return "Used - Excellent";
  if (/used\s*-\s*good\b|used\s+good\b/i.test(text)) return "Used - Good";
  if (/used\s*-\s*fair|used\s+fair\b/i.test(text)) return "Used - Fair";

  if (/\b(excellent(\s+condition)?|mint(\s+condition)?|great condition|superb|minimal wear|9\s*\/\s*10)\b/i.test(text)) {
    return "Used - Excellent";
  }
  if (/\b(good(\s+condition)?|good used|light wear|lightly worn|8\s*\/\s*10|7\s*\/\s*10)\b/i.test(text)) {
    return "Used - Good";
  }
  if (/\b(fair(\s+condition)?|visible wear|6\s*\/\s*10|some flaws)\b/i.test(text)) {
    return "Used - Fair";
  }
  if (/\bpreloved\b|\bthrifted\b|\bsecond[\s-]?hand\b/i.test(text)) {
    return "Used - Good";
  }
  return "Used - Good";
}

function resolveDepopConditionForFill(scan, v) {
  const explicit = v && v.condition != null ? String(v.condition).trim() : "";
  if (explicit) {
    const norm = normalizeDepopConditionLabel(explicit);
    return norm || explicit;
  }
  return inferDepopConditionFromScan(scan);
}

/** Pull a garment size from title/description (care label / listing text). */
function inferDepopSizeFromScanBlob(scan) {
  const blob = [scan && scan.title, scan && scan.description].filter(Boolean).join(" \n ");
  if (!blob.trim()) return "";
  const t = blob.replace(/\s+/g, " ");
  const mUK = /\bUK\s*(\d{1,2}(?:\.\d)?)\b/i.exec(t);
  if (mUK) return `UK ${mUK[1]}`;
  const mEU = /\bEU\s*(\d{2,3})\b/i.exec(t);
  if (mEU) return `EU ${mEU[1]}`;
  const mUS = /\bUS\s*(\d{1,2}(?:\.\d)?)\b/i.exec(t);
  if (mUS) return `US ${mUS[1]}`;
  const mTag = /\bsize\s*[:#]?\s*([A-Z0-9]{1,6}(?:\s*\/\s*[A-Z0-9]{1,6})?)\b/i.exec(t);
  if (mTag) return mTag[1].trim();
  const mStd = /\b(XXXL|XXL|XL|XS|[SML]|2XL|3XL|4XL)\b/i.exec(t);
  if (mStd) {
    const u = mStd[1].toUpperCase();
    if (u === "S" || u === "M" || u === "L") return u;
    return mStd[1];
  }
  const mNum = /\b(?:waist|w)\s*[:\s]*(\d{2})\b/i.exec(t);
  if (mNum) return `W${mNum[1]}`;
  return "";
}

function resolveDepopSizeForFill(scan, v) {
  const explicit = v && v.size != null ? String(v.size).trim() : "";
  if (explicit) return explicit;
  try {
    const ex = scan.listing_extra || {};
    const sh = ex.shopify && typeof ex.shopify === "object" ? ex.shopify : null;
    if (sh) {
      if (Array.isArray(sh.sizes) && sh.sizes.length) {
        const s0 = String(sh.sizes[0] || "").trim();
        if (s0) return s0;
      }
      if (sh.size != null && String(sh.size).trim()) return String(sh.size).trim();
    }
    const eb = ex.ebay && typeof ex.ebay === "object" ? ex.ebay : null;
    if (eb && eb.size != null && String(eb.size).trim()) return String(eb.size).trim();
    const vt = ex.vinted && typeof ex.vinted === "object" ? ex.vinted : null;
    if (vt && vt.size != null && String(vt.size).trim()) return String(vt.size).trim();
  } catch {
    /* ignore */
  }
  const fromBlob = inferDepopSizeFromScanBlob(scan);
  if (fromBlob) return fromBlob;
  return "One size";
}

/**
 * Depop Size combobox: try primary (from scan/label), then common “single size” labels Depop uses.
 */
function depopPickSizeComboboxWithFallbacks(rootEl, negatives, primary) {
  const raw = String(primary || "").trim();
  const seen = new Set();
  const tries = [];
  const push = (x) => {
    const s = String(x || "").trim();
    if (!s || seen.has(s.toLowerCase())) return;
    seen.add(s.toLowerCase());
    tries.push(s);
  };
  push(raw);
  push("One size");
  push("One Size");
  push("ONE SIZE");
  push("OS");
  push("Unisex one size");
  push("One size fits all");
  push("Standard");
  const sizeTriggers = depopFindComboboxTriggersForHints(rootEl, ["size"], negatives);
  console.log(
    "[SyncLyst] Depop Size: will try in order",
    tries,
    "— " + sizeTriggers.length + " trigger(s) found",
    sizeTriggers
  );
  for (const s of tries) {
    const ok = depopPickComboboxConfirmed(rootEl, ["size"], negatives, s);
    console.log("[SyncLyst] Depop Size: tried '" + s + "', ok =", ok);
    if (ok) return true;
  }
  return false;
}

function yearToDepopAge(y) {
  if (y < 1800 || y > 2035) return null;
  if (y < 1950) return "Antique";
  if (y <= 1959) return "50s";
  if (y <= 1969) return "60s";
  if (y <= 1979) return "70s";
  if (y <= 1989) return "80s";
  if (y <= 1999) return "90s";
  if (y <= 2009) return "00s";
  return "Modern";
}

function normalizeDepopAgeLabel(raw) {
  const s = raw != null ? String(raw).trim() : "";
  if (!s) return "";
  if (DEPOP_AGE_OPTIONS.includes(s)) return s;
  const lower = s.toLowerCase().replace(/\s+/g, " ");
  const map = {
    modern: "Modern",
    "00s": "00s",
    "2000s": "00s",
    "2000's": "00s",
    noughties: "00s",
    "90s": "90s",
    "1990s": "90s",
    nineties: "90s",
    "80s": "80s",
    "1980s": "80s",
    eighties: "80s",
    "70s": "70s",
    "1970s": "70s",
    seventies: "70s",
    "60s": "60s",
    "1960s": "60s",
    sixties: "60s",
    "50s": "50s",
    "1950s": "50s",
    fifties: "50s",
    antique: "Antique",
    antiques: "Antique",
  };
  if (map[lower]) return map[lower];
  return "";
}

/**
 * Infer Depop Age (era) from scan text. Uses decades, Y2K, years (e.g. copyright), and “antique”.
 */
function inferDepopAgeFromScan(scan) {
  const text = depopGatherInferenceText(scan);
  if (!text.trim()) return "Modern";
  const t = text;

  if (/\by2k\b|y2k[-\s]?style|early 2000s|mid[-\s]?2000s/i.test(t)) return "00s";
  if (/\b2000s\b|'00s\b|\bthe\s+00s\b/i.test(t)) return "00s";
  if (/\b1990s?\b|'90s\b|\bnineties\b/i.test(t)) return "90s";
  if (/\b1980s?\b|'80s\b|\beighties\b/i.test(t)) return "80s";
  if (/\b1970s?\b|'70s\b|\bseventies\b/i.test(t)) return "70s";
  if (/\b1960s?\b|'60s\b|\bsixties\b|\bmod\s+60s\b/i.test(t)) return "60s";
  if (/\b1950s?\b|'50s\b|\bfifties\b/i.test(t)) return "50s";

  if (
    /\b(antique|antiques|victorian|edwardian|georgian|art\s+nouveau|19th\s+century|18th\s+century)\b/i.test(
      t
    )
  ) {
    return "Antique";
  }

  const yearMatch = t.match(/\b(18\d{2}|19\d{2}|20[0-2]\d)\b/g);
  if (yearMatch) {
    for (const ys of yearMatch) {
      const y = parseInt(ys, 10);
      const bucket = yearToDepopAge(y);
      if (bucket) return bucket;
    }
  }

  if (/\b(201\d|202\d)\s*(style|era)?\b/i.test(t) || /\bcontemporary\b|\bcurrent\s+season\b/i.test(t)) {
    return "Modern";
  }

  return "Modern";
}

function resolveDepopAgeForFill(scan, v) {
  const explicit = v && v.age != null ? String(v.age).trim() : "";
  if (explicit) {
    const norm = normalizeDepopAgeLabel(explicit);
    return norm || explicit;
  }
  return inferDepopAgeFromScan(scan);
}

/**
 * Infer Depop Source from scan text (title, description, condition, etc.). Vision/scan pipelines put
 * image-derived cues into those fields; we cannot analyze raw pixels in the content script.
 */
function inferDepopSourceFromScan(scan) {
  const text = depopGatherInferenceText(scan).toLowerCase();
  if (!text.trim()) return "Preloved";

  if (
    /\b(repaired|restitched|darned|hole(s)?\s+(patched|fixed)|resewn|zip\s*(replaced|fixed))\b/i.test(text)
  ) {
    return "Repaired";
  }
  if (
    /\b(deadstock|nwt\b|bnwt|new with tags|never worn|tags attached|unworn|with tags)\b/i.test(text)
  ) {
    return "Deadstock";
  }
  if (
    /\b(handmade|hand-made|hand knit|handknit|crochet|crocheted|hand sewn|crafted by|homemade)\b/i.test(
      text
    )
  ) {
    return "Handmade";
  }
  if (/\b(reworked|upcycled|up-cycled|repurposed from|altered from)\b/i.test(text)) {
    return "Reworked / Upcycled";
  }
  if (/\b(custom(\s+made)?|bespoke|made to order|mto\b|personalised|personalized)\b/i.test(text)) {
    return "Custom";
  }
  if (/\b(vintage|true vintage|retro|y2k\b)\b/i.test(text) || /(19|20)\d{2}s?\b/.test(text)) {
    return "Vintage";
  }
  if (
    /\b(designer|luxury|authentic\s+(gucci|prada|lv\b|louis|dior|chanel|balenciaga|fendi|burberry|ysl|celine))\b/i.test(
      text
    )
  ) {
    return "Designer";
  }
  if (
    /\b(preloved|pre-loved|second[\s-]?hand|thrifted|thrift find|gently used|used condition|good used|fair used)\b/i.test(
      text
    )
  ) {
    return "Preloved";
  }
  return "Preloved";
}

function resolveDepopSourceForFill(scan, v) {
  const explicit = v && v.source != null ? String(v.source).trim() : "";
  if (explicit) {
    const norm = normalizeDepopSourceLabel(explicit);
    return norm || explicit;
  }
  return inferDepopSourceFromScan(scan);
}

function depopNormalizeOptionTextForMatch(s) {
  return String(s || "")
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function depopOptionTextEquals(a, b) {
  return depopNormalizeOptionTextForMatch(a) === depopNormalizeOptionTextForMatch(b);
}

/** Dismiss open listboxes / combobox menus so the listing form is not left with a hanging overlay. */
function depopCloseDropdownUi(rootEl) {
  const doc = rootEl && rootEl.ownerDocument ? rootEl.ownerDocument : document;
  const win = doc.defaultView || window;
  function esc(target) {
    if (!(target instanceof HTMLElement)) return;
    try {
      target.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
      target.dispatchEvent(
        new KeyboardEvent("keyup", {
          key: "Escape",
          code: "Escape",
          keyCode: 27,
          which: 27,
          bubbles: true,
          cancelable: true,
          composed: true,
        })
      );
    } catch {
      /* ignore */
    }
  }
  try {
    esc(doc.body);
  } catch {
    /* ignore */
  }
  try {
    const ae = doc.activeElement;
    if (ae instanceof HTMLElement) {
      esc(ae);
      ae.blur();
    }
  } catch {
    /* ignore */
  }
  try {
    const expanded = querySelectorAllDeep(
      '[role="combobox"][aria-expanded="true"], [aria-haspopup="listbox"][aria-expanded="true"]',
      doc.documentElement
    );
    for (const el of expanded) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      esc(el);
      try {
        el.blur();
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const listboxes = querySelectorAllDeep('[role="listbox"]', doc.documentElement);
    for (const lb of listboxes) {
      if (!(lb instanceof HTMLElement) || !isVisible(lb)) continue;
      esc(lb);
    }
  } catch {
    /* ignore */
  }
  try {
    win.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Escape",
        code: "Escape",
        keyCode: 27,
        which: 27,
        bubbles: true,
        cancelable: true,
      })
    );
  } catch {
    /* ignore */
  }
}

/** Listbox tied to a combobox via aria-controls / aria-owns (incl. portaled popups). */
function depopListboxRootFromTrigger(trigger) {
  if (!(trigger instanceof HTMLElement)) return null;
  const doc = trigger.ownerDocument || document;
  const raw =
    trigger.getAttribute("aria-controls") || trigger.getAttribute("aria-owns") || "";
  for (const id of raw.split(/\s+/).filter(Boolean)) {
    try {
      const el = doc.getElementById(id);
      if (!el) continue;
      if (el.getAttribute("role") === "listbox") return el;
      const inner = el.querySelector && el.querySelector('[role="listbox"]');
      if (inner instanceof HTMLElement) return inner;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function depopGetComboboxTextInput(trigger) {
  if (trigger instanceof HTMLInputElement) return trigger.type === "hidden" ? null : trigger;
  if (!(trigger instanceof HTMLElement)) return null;
  const q = trigger.querySelector(
    'input[aria-autocomplete="list"], input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), input[type="text"], input[type="search"]'
  );
  return q instanceof HTMLInputElement ? q : null;
}

function depopTypeIntoComboboxIfEditable(trigger, value) {
  const str = String(value || "").trim();
  if (!str) return false;
  const input = depopGetComboboxTextInput(trigger);
  if (!(input instanceof HTMLInputElement) || input.type === "hidden") return false;
  try {
    input.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, str);
    else input.value = str;
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data: str, inputType: "insertText" })
    );
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

/** Clear typed filter text so Depop shows the full list again (needed before picking **Other** when the name isn’t in the catalog). */
function depopClearComboboxText(trigger) {
  const input = depopGetComboboxTextInput(trigger);
  if (!(input instanceof HTMLInputElement)) return false;
  try {
    input.focus();
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    if (desc && desc.set) desc.set.call(input, "");
    else input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return true;
  } catch {
    return false;
  }
}

/** Prefer options inside `container` (scoped listbox). Adds loose substring match for truncated labels. */
function depopClickMatchingOptionInContainer(want, container) {
  if (!(container instanceof HTMLElement)) return false;
  const wantNorm = depopNormalizeOptionTextForMatch(want);
  const wantStr = String(want).trim();
  let candidates;
  try {
    candidates = container.querySelectorAll('[role="option"], [role="menuitem"], li[role="option"]');
  } catch {
    return false;
  }
  const tryClick = (el) => {
    if (!(el instanceof HTMLElement) || !isVisible(el)) return false;
    try {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      return false;
    }
  };
  for (const el of candidates) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 160) continue;
    if (depopOptionTextEquals(raw, want) || raw === wantStr) {
      if (tryClick(el)) return true;
    }
  }
  if (wantNorm.length >= 2) {
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      const rn = depopNormalizeOptionTextForMatch(raw);
      if (!rn || raw.length > 96) continue;
      if (rn === wantNorm || rn.includes(wantNorm) || wantNorm.includes(rn)) {
        if (tryClick(el)) return true;
      }
    }
  }
  const stripAp = (x) => depopNormalizeOptionTextForMatch(x).replace(/[''′’`]/g, "");
  const wantLoose = stripAp(wantStr);
  if (wantLoose.length >= 2) {
    for (const el of candidates) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 160) continue;
      if (stripAp(raw) === wantLoose) {
        if (tryClick(el)) return true;
      }
    }
  }
  return false;
}

/**
 * Depop custom dropdowns: typing into the combobox shows the label but React may not commit until an
 * option is activated. Open the control first; pass `trigger` so we read aria-controls listbox + type to filter.
 */
function depopActivateListboxOption(want, triggerOpt) {
  const wantNorm = depopNormalizeOptionTextForMatch(want);
  if (!wantNorm) return false;

  if (triggerOpt instanceof HTMLElement) {
    depopTypeIntoComboboxIfEditable(triggerOpt, want);
    const lb0 = depopListboxRootFromTrigger(triggerOpt);
    if (lb0 && depopClickMatchingOptionInContainer(want, lb0)) return true;
    const lbSync = depopListboxRootFromTrigger(triggerOpt);
    if (lbSync && depopClickMatchingOptionInContainer(want, lbSync)) return true;
  }

  let opts;
  try {
    opts = querySelectorAllDeep(
      '[role="option"], [role="menuitem"], li[role="option"]',
      document.documentElement
    );
  } catch {
    return false;
  }
  /** This is a page-wide fallback search — without a proximity check it can match and click
   * unrelated text elsewhere on the page (e.g. a sidebar listing) that happens to share the
   * option's label, reporting false success while the real combobox stays empty. */
  const triggerRect =
    triggerOpt instanceof HTMLElement ? triggerOpt.getBoundingClientRect() : null;
  for (const el of opts) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (!raw || raw.length > 140) continue;
    const exact =
      depopOptionTextEquals(raw, want) ||
      raw === String(want).trim() ||
      depopNormalizeOptionTextForMatch(raw) === wantNorm ||
      (wantNorm.length >= 2 &&
        (depopNormalizeOptionTextForMatch(raw).includes(wantNorm) || wantNorm.includes(depopNormalizeOptionTextForMatch(raw))));
    if (!exact) continue;
    if (triggerRect) {
      const r = el.getBoundingClientRect();
      const dy = Math.abs(r.top - triggerRect.top);
      if (dy > 700) continue;
    }
    try {
      el.scrollIntoView({ block: "nearest", behavior: "auto" });
      el.focus();
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.click();
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      return true;
    } catch {
      /* ignore */
    }
  }
  return depopClickOptionInsideVisibleListbox(want);
}

/** Depop sometimes renders rows as divs without role=option until focused. */
function depopClickOptionInsideVisibleListbox(want) {
  const wantNorm = depopNormalizeOptionTextForMatch(want);
  if (!wantNorm) return false;
  let lbs;
  try {
    lbs = querySelectorAllDeep('[role="listbox"], [role="menu"]', document.documentElement);
  } catch {
    return false;
  }
  for (const lb of lbs) {
    if (!(lb instanceof HTMLElement) || !isVisible(lb)) continue;
    let rows;
    try {
      rows = lb.querySelectorAll(
        '[role="option"], li, button, a, div[tabindex="0"], div[role="presentation"], span'
      );
    } catch {
      continue;
    }
    for (const el of rows) {
      if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
      const raw = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!raw || raw.length > 100) continue;
      if (depopNormalizeOptionTextForMatch(raw) !== wantNorm && !depopOptionTextEquals(raw, want)) continue;
      if (el.querySelectorAll("*").length > 14) continue;
      try {
        el.scrollIntoView({ block: "nearest", behavior: "auto" });
        el.click();
        return true;
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

function depopHintToLabelRegex(hint) {
  const h = String(hint || "")
    .trim()
    .toLowerCase();
  /** Depop copy often prefixes labels (“Item condition”) — avoid `^…` anchors. */
  if (h === "category") return /\bcategory\b/i;
  if (h === "brand") return /\bbrand\b/i;
  if (h === "condition") return /\bcondition\b/i;
  if (h === "size") return /\bsize\b/i;
  /** Depop web copy uses “What kind of item is this?” — older rows may still say “Source”. */
  if (h === "source")
    return /(\bsource\b|what\s+kind\s+of\s+item(\s+is\s+this)?\??)/i;
  if (h === "age") return /\bage\b/i;
  return null;
}

/** Prefer controls beside Condition, “What kind of item is this?” / Source, or Age (Depop Info / Enhance rows). */
function depopFindComboboxByAdjacentLabel(rootEl, hints) {
  const primary = hints && hints[0];
  const re = depopHintToLabelRegex(primary);
  if (!re) return null;
  let labs;
  try {
    labs = querySelectorAllDeep("label, span, p, legend, h2, h3, div", rootEl);
  } catch {
    return null;
  }
  for (const lab of labs) {
    if (!(lab instanceof HTMLElement) || !isVisible(lab)) continue;
    const t = (lab.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length > 36 || t.length < 3) continue;
    if (!re.test(t)) continue;
    if (primary === "size") {
      const short = t.replace(/\s+/g, " ").trim();
      if (short.length > 18 || /please|insert|least|chart|resize|file|option|minimum|quantity/i.test(short)) continue;
    }
    let cur = lab;
    for (let d = 0; d < 10 && cur; d++) {
      const q = cur.querySelector(
        '[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete="list"], input[aria-expanded]'
      );
      if (q instanceof HTMLElement && isVisible(q)) return q;
      cur = cur.parentElement;
    }
    let sib = lab.nextElementSibling;
    for (let i = 0; i < 8 && sib; i++) {
      const direct =
        sib.matches &&
        (sib.matches('[role="combobox"]') ||
          sib.matches('[aria-haspopup="listbox"]') ||
          sib.matches("input[aria-expanded]"))
          ? sib
          : null;
      const inner =
        direct ||
        (sib.querySelector &&
          sib.querySelector(
            '[role="combobox"], [aria-haspopup="listbox"], input[aria-autocomplete="list"], input[aria-expanded]'
          ));
      if (inner instanceof HTMLElement && isVisible(inner)) return inner;
      sib = sib.nextElementSibling;
    }
  }
  return null;
}

function depopScoreDepopComboboxTrigger(el, hints, negatives, rootEl) {
  if (!(el instanceof HTMLElement) || !isVisible(el)) return -Infinity;
  const ty = (el.tagName || "").toLowerCase();
  if (ty === "input") {
    const inp = el;
    if (inp.type === "hidden") return -Infinity;
    /** Depop often uses `type="search"` for Category / Brand comboboxes — allow when the row matches `hints`. */
    if (inp.type === "search") {
      const row = el.closest('[class*="field" i], [class*="Field" i], li, section, form') || el.parentElement;
      const rowTxt = ((row && row.textContent) || "").slice(0, 520).toLowerCase();
      let rowMatchesHint = false;
      for (const h of hints || []) {
        const hl = String(h || "").toLowerCase();
        if (hl && rowTxt.includes(hl)) {
          rowMatchesHint = true;
          break;
        }
      }
      if (!rowMatchesHint) return -Infinity;
    }
  }
  const rect = el.getBoundingClientRect();
  if (rect.width < 14 || rect.height < 6) return -Infinity;
  const row =
    el.closest(
      '[class*="field" i], [class*="Field" i], [class*="row" i], [data-testid], li, section, div'
    ) || el.parentElement;
  const section =
    el.closest("main, form, section, article, [class*='sell'], [class*='listing']") || rootEl;
  const rowBlob = ((row && row.textContent) || "").slice(0, 900).toLowerCase();
  const secBlob = (section.textContent || "").slice(0, 2800).toLowerCase();
  /**
   * Use the **field row** for hint matching so one Info block doesn’t give every combobox the same
   * +54 for every label (e.g. Category control matching “condition” from the Condition row below).
   */
  const blob = rowBlob.replace(/\s+/g, " ").trim().length >= 6 ? rowBlob : secBlob;
  const head = (rowBlob.slice(0, 420) + " " + shopifyControlAccessibleName(el).toLowerCase()).toLowerCase();
  if (/search\s*depop|header|navigation|footer|cookie/i.test(head)) return -Infinity;
  const narrow = (
    shopifyControlAccessibleName(el) +
    " " +
    (el.id || "") +
    " " +
    ((row && row.textContent) || "").slice(0, 560)
  ).toLowerCase();
  let sc = 0;
  for (const neg of negatives) {
    try {
      if (new RegExp(neg, "i").test(narrow)) sc -= 22;
    } catch {
      /* ignore */
    }
  }
  for (const h of hints) {
    const hl = h.toLowerCase();
    try {
      if (new RegExp(`\\b${hl}\\b`).test(blob)) sc += 54;
      else if (blob.includes(hl)) sc += 26;
    } catch {
      if (blob.includes(hl)) sc += 26;
    }
    if (shopifyControlAccessibleName(el).toLowerCase().includes(hl)) sc += 30;
  }
  const role = el.getAttribute("role") || "";
  if (role === "combobox") sc += 16;
  if (el.getAttribute("aria-haspopup") === "listbox") sc += 14;
  if (el.getAttribute("aria-autocomplete") === "list") sc += 10;
  return sc;
}

function depopFindComboboxTriggersForHints(rootEl, hints, negatives) {
  const byLabel = depopFindComboboxByAdjacentLabel(rootEl, hints);
  let nodes;
  try {
    nodes = querySelectorAllDeep(
      '[role="combobox"], input[role="combobox"], [aria-haspopup="listbox"], button[aria-haspopup="listbox"], input[aria-autocomplete="list"], input[aria-expanded][aria-controls]',
      rootEl
    );
  } catch {
    return byLabel ? [byLabel] : [];
  }
  const scored = [];
  for (const el of nodes) {
    const sc = depopScoreDepopComboboxTrigger(el, hints, negatives, rootEl);
    if (sc >= 32) {
      const r = el.getBoundingClientRect();
      scored.push({ el, sc, top: r.top });
    }
  }
  scored.sort((a, b) => a.top - b.top || b.sc - a.sc);
  const ordered = scored.map((x) => x.el);
  if (byLabel && !ordered.includes(byLabel)) return [byLabel, ...ordered];
  if (byLabel && ordered.length && ordered[0] !== byLabel) return [byLabel, ...ordered.filter((e) => e !== byLabel)];
  return ordered.length ? ordered : byLabel ? [byLabel] : [];
}

function depopPickComboboxConfirmed(rootEl, hints, negatives, value) {
  const want = String(value || "").trim();
  if (!want) return false;
  const triggers = depopFindComboboxTriggersForHints(rootEl, hints, negatives);
  const trigger = triggers[0] || null;
  if (!trigger) return false;

  /** Callers like the per-tick fill loop (up to 30 ticks, every 360ms) invoke this on every tick
   * until it succeeds — without this guard, each failing call schedules its own full set of retry
   * timers below, so dozens of overlapping retry chains for the same hint pile up and can stall the
   * page enough to blow past the overall fill response timeout. One in-flight chain per hint+value. */
  const win = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  const inFlightKey = hints.join(",") + "::" + want;
  if (win) {
    if (!win.__synclystDepopComboInFlight) win.__synclystDepopComboInFlight = new Set();
    if (win.__synclystDepopComboInFlight.has(inFlightKey)) return false;
    win.__synclystDepopComboInFlight.add(inFlightKey);
    setTimeout(() => win.__synclystDepopComboInFlight.delete(inFlightKey), 4200);
  }

  try {
    trigger.scrollIntoView({ block: "nearest", behavior: "auto" });
    trigger.focus();
    trigger.click();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch {
    return false;
  }

  const sweepClose = () => depopCloseDropdownUi(rootEl);
  const wantNorm0 = depopNormalizeOptionTextForMatch(want);
  const triggerShowsValue = () => {
    const cur = String((trigger instanceof HTMLInputElement && trigger.value) || trigger.textContent || "").trim();
    const curNorm = depopNormalizeOptionTextForMatch(cur);
    return !!curNorm && !!wantNorm0 && (curNorm.includes(wantNorm0) || wantNorm0.includes(curNorm));
  };
  /** depopActivateListboxOption falling back to a page-wide search can report a click that
   * landed on unrelated text elsewhere — verify the trigger's own displayed value actually
   * changed before trusting "true", and retry once (reopen + reselect) if it didn't stick. */
  const verifyAndMaybeRetry = (label) => {
    setTimeout(() => {
      if (triggerShowsValue()) return;
      console.warn(
        "[SyncLyst] Depop combobox (" + label + "): reported success but trigger still shows '" +
          String((trigger instanceof HTMLInputElement && trigger.value) || trigger.textContent || "").trim() +
          "' — retrying"
      );
      try {
        trigger.scrollIntoView({ block: "nearest", behavior: "auto" });
        trigger.focus();
        trigger.click();
        trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        const ok = depopActivateListboxOption(want, trigger);
        if (ok) [90, 240, 450].forEach((ms) => setTimeout(sweepClose, ms));
      }, 80);
    }, 350);
  };
  let got = depopActivateListboxOption(want, trigger);
  if (got) {
    [90, 240, 450].forEach((ms) => setTimeout(sweepClose, ms));
    verifyAndMaybeRetry(hints.join(","));
    return true;
  }
  const delays = [40, 100, 220, 480, 900, 1600, 2400, 3200];
  delays.forEach((ms) => {
    setTimeout(() => {
      if (!got) got = depopActivateListboxOption(want, trigger);
      if (got) [120, 350].forEach((d) => setTimeout(sweepClose, d));
    }, ms);
  });
  [200, 550, 1100, 1780].forEach((ms) => setTimeout(sweepClose, ms));
  setTimeout(() => verifyAndMaybeRetry(hints.join(",")), 3600);
  /** Async retries may still succeed; caller uses repeated fill ticks. */
  return got;
}

/**
 * Depop Brand combobox: pick the list option that matches `brandRaw` when present; otherwise select **Other**
 * (Depop’s catch‑all when the brand isn’t in their catalog).
 */
function depopPickBrandOrOther(rootEl, negatives, brandRaw) {
  const want = String(brandRaw || "").trim();
  const neg = negatives;
  const triggers = depopFindComboboxTriggersForHints(rootEl, ["brand"], neg);
  const trigger = triggers[0] || null;
  if (!trigger) return false;

  try {
    trigger.scrollIntoView({ block: "nearest", behavior: "auto" });
    trigger.focus();
    trigger.click();
    trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  } catch {
    return false;
  }

  const sweepClose = () => depopCloseDropdownUi(rootEl);
  const tryLabel = (label) => {
    const x = String(label || "").trim();
    if (!x) return false;
    return depopActivateListboxOption(x, trigger);
  };
  const otherLabels = ["Other", "Others", "Unbranded", "No brand", "Without brand"];
  const reopenBrandCombobox = () => {
    depopClearComboboxText(trigger);
    try {
      trigger.focus();
      trigger.click();
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {
      /* ignore */
    }
  };
  const tryOtherSync = () => {
    for (const lab of otherLabels) {
      reopenBrandCombobox();
      if (tryLabel(lab)) return true;
    }
    return false;
  };

  if (want && tryLabel(want)) {
    [90, 240, 450].forEach((ms) => setTimeout(sweepClose, ms));
    return true;
  }
  if (!want && tryOtherSync()) {
    [90, 240, 450].forEach((ms) => setTimeout(sweepClose, ms));
    return true;
  }

  let picked = false;
  /** If the exact name isn’t in Depop’s catalog (e.g. band names), fall back to **Other** soon — not only after multi‑second delays. */
  const tryWantThenOther = () => {
    if (picked) return;
    if (want && tryLabel(want)) {
      picked = true;
      [120, 350].forEach((d) => setTimeout(sweepClose, d));
      return;
    }
    if (want && tryOtherSync()) {
      picked = true;
      [120, 350].forEach((d) => setTimeout(sweepClose, d));
    }
  };
  [120, 260, 420, 700, 1100, 1800, 2600, 3400].forEach((ms) => {
    setTimeout(tryWantThenOther, ms);
  });

  const fallbackMs = 900;
  setTimeout(() => {
    if (picked) return;
    try {
      trigger.focus();
      trigger.click();
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } catch {
      /* ignore */
    }
    if (want) {
      if (tryLabel(want)) picked = true;
      else if (tryOtherSync()) picked = true;
    } else if (tryOtherSync()) {
      picked = true;
    } else {
      for (const lab of otherLabels) {
        if (tryLabel(lab)) {
          picked = true;
          break;
        }
      }
    }
    [200, 550, 1100].forEach((d) => setTimeout(sweepClose, d));
  }, fallbackMs);

  [2100, 2800, 3600].forEach((ms) => setTimeout(sweepClose, ms));
  return false;
}

function resolveDepopCategoryHint(scan, v) {
  if (v && v.category != null && String(v.category).trim()) return String(v.category).trim();
  try {
    const ex = scan.listing_extra || {};
    const eb = ex.ebay && typeof ex.ebay === "object" ? ex.ebay : null;
    if (eb) {
      const line = [eb.category_leaf, eb.category_breadcrumb].filter(Boolean).join(" ").trim();
      if (line) return line.slice(0, 200);
    }
  } catch {
    /* ignore */
  }
  if (scan.title != null && String(scan.title).trim()) return String(scan.title).trim().slice(0, 200);
  return "";
}

function depopCategoryTokens(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[''’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(the|and|for|with|from)$/i.test(w));
}

function depopScoreSuggestedCategoryPill(pillText, hint, scan) {
  const raw = String(pillText || "")
    .replace(/^\+\s*/, "")
    .trim()
    .toLowerCase();
  if (!raw || !raw.includes("/")) return -1;
  const hintNorm = String(hint || "").toLowerCase();
  const title = String((scan && scan.title) || "").toLowerCase();
  const desc = String((scan && scan.description) || "").toLowerCase();
  const blob = `${hintNorm} ${title} ${desc}`;
  let sc = 0;
  const parts = raw.split(/\s*\/\s*/).map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const p = part.replace(/-/g, " ");
    if (p.length < 2) continue;
    if (hintNorm.includes(p) || blob.includes(p)) sc += 48;
    if (new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(hintNorm)) sc += 22;
  }
  const htoks = depopCategoryTokens(hint);
  const ptoks = depopCategoryTokens(raw.replace(/\//, " "));
  for (const h of htoks) {
    for (const p of ptoks) {
      if (h === p) sc += 40;
      else if (h.length > 3 && (p.includes(h) || h.includes(p))) sc += 28;
    }
  }
  for (const p of ptoks) {
    if (p.length > 2 && title.includes(p)) sc += 14;
  }
  if (/\bmen\b/.test(raw) && /\b(men|mens|male|guy|boys?)\b/.test(title)) sc += 36;
  if (/\bwomen\b/.test(raw) && /\b(women|womens|woman|ladies|lady|female|girls?)\b/.test(title)) sc += 36;
  if (/\b(unisex|all genders)\b/.test(raw) && /\b(unisex|gender\s*neutral)\b/.test(title)) sc += 30;
  return sc;
}

/** Shopify / generic taxonomy strings Depop will not accept as a committed category path. */
function depopCategoryHintIsBroadDepopUnfriendly(hint) {
  const s = String(hint || "")
    .toLowerCase()
    .trim();
  if (!s || s.length < 3) return true;
  return /\b(apparel|clothing|general|misc|other|default|uncategor|unspec|inventory|product|goods|items?)\b/.test(
    s
  );
}

/** Mismatched Shopify category guesses (e.g. "Digital Services" on a t-shirt scan) share no
 * tokens with the item's own title/description — treat those as untrustworthy rather than
 * typing them straight into Depop's combobox. */
function depopCategoryHintLooksMismatchedWithScan(hint, scan) {
  const htoks = depopCategoryTokens(hint);
  if (!htoks.length) return true;
  const blob = `${(scan && scan.title) || ""} ${(scan && scan.description) || ""}`.toLowerCase();
  const blobToks = new Set(depopCategoryTokens(blob));
  if (!blobToks.size) return false;
  return !htoks.some((t) => t.length > 2 && blobToks.has(t));
}

/** Rough Depop path `Dept / Leaf` when session only has broad Shopify categories. */
function depopGuessCategoryPathFromScan(scan) {
  const t = [scan && scan.title, scan && scan.description].filter(Boolean).join(" \n ").toLowerCase();
  if (!t.trim()) return "";
  const isWomen = /\b(women|womens|woman|ladies|lady|female|girls?)\b/.test(t);
  const isMen = /\b(men|mens|male|guy|boys?)\b/.test(t);
  const dept = isWomen && !isMen ? "Women" : "Men";
  if (/\b(t-?shirt|tee|tshirt|tank\s*top)\b/.test(t)) return `${dept} / T-shirts`;
  if (/\b(shirt|blouse|button)\b/.test(t) && !/\bt-?shirt\b/.test(t)) return `${dept} / Shirts`;
  if (/\b(jean|denim|trouser|pant)\b/.test(t)) return `${dept} / Jeans`;
  if (/\b(hoodie|sweatshirt|jumper|sweater|knitwear)\b/.test(t)) return `${dept} / Hoodies`;
  if (/\b(dress|dresses)\b/.test(t)) return `${dept} / Dresses`;
  if (/\b(shorts?)\b/.test(t)) return `${dept} / Shorts`;
  if (/\b(skirt)\b/.test(t)) return `${dept} / Skirts`;
  if (/\b(jacket|coat|outerwear)\b/.test(t)) return `${dept} / Jackets`;
  return isWomen ? "Women / T-shirts" : "Men / T-shirts";
}

/**
 * Depop Category: typing alone often leaves “This field is required” until a **Suggested** chip is chosen.
 */
/** Requiring "suggested" AND "categor" inside the same fixed-length text slice falsely rejects
 * real chips once a long description/hashtag block pushes the section header past that slice —
 * the pill-shape match (caller already filters to "X / Y" text) is specific enough on its own;
 * this only needs to rule out an unrelated "+ A / B" string appearing far from any "Suggested" label. */
function depopSuggestedCategoryContextOk(el, rootEl) {
  let p = el;
  for (let d = 0; d < 24 && p instanceof HTMLElement; d++) {
    const chunk = (p.textContent || "").replace(/\s+/g, " ").trim();
    if (chunk.length < 4000 && /suggested/i.test(chunk)) return true;
    p = p.parentElement;
  }
  const rootChunk = ((rootEl && rootEl.textContent) || "").replace(/\s+/g, " ").toLowerCase();
  return /suggested/.test(rootChunk);
}

function depopClickBestSuggestedCategoryPill(rootEl, scan, hint) {
  if (!hint || !String(hint).trim()) {
    console.warn("[SyncLyst] Depop Category: no hint passed to pill-matcher");
    return false;
  }
  let nodes;
  try {
    /** Tag/role guesses (button, [role=button], etc.) don't match every Depop build's pill markup —
     * match by text shape instead, then resolve the actual clickable ancestor. */
    nodes = querySelectorAllDeep("*", rootEl);
  } catch {
    return false;
  }
  let best = null;
  let bestSc = -1;
  let pillCandidatesSeen = 0;
  let contextRejected = 0;
  for (const el of nodes) {
    if (!(el instanceof HTMLElement) || !isVisible(el)) continue;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (t.length < 4 || t.length > 140) continue;
    // The leading "+" is usually a separate SVG/icon glyph, not part of textContent — don't require it as text.
    if (!/^\+?\s*\S[\w\s&'-]*\s\/\s[\w\s&'-]*\S$/.test(t)) continue;
    // Prefer the innermost element carrying this exact text (skip ancestor wrappers duplicating a child's text).
    const hasMatchingChild = Array.from(el.children).some(
      (c) => (c.textContent || "").replace(/\s+/g, " ").trim() === t
    );
    if (hasMatchingChild) continue;
    pillCandidatesSeen++;
    if (!depopSuggestedCategoryContextOk(el, rootEl)) {
      contextRejected++;
      continue;
    }
    const sc = depopScoreSuggestedCategoryPill(t, hint, scan);
    if (sc > bestSc) {
      bestSc = sc;
      best = el.closest('button, [role="button"], a, [tabindex]') || el;
    }
  }
  const minSc = depopCategoryHintIsBroadDepopUnfriendly(hint) ? 10 : 20;
  console.log(
    "[SyncLyst] Depop Category: hint='" + hint + "', " + pillCandidatesSeen + " pill-shaped node(s) seen, " +
      contextRejected + " rejected by context check, best='" + (best ? (best.textContent || "").trim() : "none") +
      "' score=" + bestSc + " (need >= " + minSc + ")"
  );
  if (!best || bestSc < minSc) return false;
  try {
    best.scrollIntoView({ block: "nearest", behavior: "auto" });
    best.focus();
    best.click();
    best.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    console.log("[SyncLyst] Depop Category: clicked pill", best);
    return true;
  } catch (e) {
    console.warn("[SyncLyst] Depop Category: click threw", e);
    return false;
  }
}

/**
 * Depop list form: category, brand, condition, enhance fields, shipping — from listing_extra.depop
 * (and shopify vendor/category as fallback).
 */
function fillDepopListingExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  let v = depopGetExtra(scan);
  if (!v || typeof v !== "object") {
    v = {};
    const raw = scan.listing_extra;
    if (raw && raw.shopify && typeof raw.shopify === "object") {
      const s = raw.shopify;
      v.category = s.category || s.product_type || s.category_suggested;
      v.brand = s.vendor;
      if (Array.isArray(s.sizes) && s.sizes.length) {
        const s0 = String(s.sizes[0] || "").trim();
        if (s0) v.size = s0;
      } else if (s.size != null && String(s.size).trim()) {
        v.size = String(s.size).trim();
      }
    }
  }
  if (!v || typeof v !== "object") return 0;
  const neg = ["search", "coupon", "promote", "boost", "fee", "twitter", "facebook"];
  const negShip = ["item", "list", "post", "price"];
  let n = 0;
  const fillWin = rootEl.defaultView || (typeof window !== "undefined" ? window : null);
  {
    const catHint = resolveDepopCategoryHint(scan, v);
    /** This whole function can run multiple times across the orchestrator's retry cycle — once
     * a category is confirmed picked, later calls must not clear/re-touch it (each call was
     * unconditionally clearing the combobox text first, wiping out a previous call's success). */
    const catAlreadyPicked = !!(fillWin && fillWin.__synclystDepopCategoryDone);
    if (catHint && !catAlreadyPicked) {
      const fillStr =
        v && v.category != null && String(v.category).trim()
          ? String(v.category).trim()
          : catHint;
      const catTriggers = depopFindComboboxTriggersForHints(rootEl, ["category"], neg);
      const catTrig = catTriggers[0] || null;
      if (catTrig instanceof HTMLElement) {
        depopClearComboboxText(catTrig);
        try {
          depopCloseDropdownUi(rootEl);
        } catch {
          /* ignore */
        }
      }
      const pathGuess = depopGuessCategoryPathFromScan(scan);
      const broad =
        depopCategoryHintIsBroadDepopUnfriendly(fillStr) ||
        depopCategoryHintLooksMismatchedWithScan(fillStr, scan);
      if (broad) {
        console.warn(
          "[SyncLyst] Depop Category: hint '" + fillStr + "' looks broad/mismatched with scan title, " +
            "falling back to title-derived guess '" + pathGuess + "'"
        );
      }
      /** A click() reporting "true" doesn't guarantee Depop actually committed the value — verify
       * the trigger's own displayed text changed before trusting it, same class of bug as Condition. */
      const verifyCategoryStuck = () => {
        const trig = (depopFindComboboxTriggersForHints(rootEl, ["category"], neg) || [])[0];
        const cur = String((trig && trig.value) || (trig && trig.textContent) || "").trim();
        const stuck = cur.length > 1 && !/required|select|choose/i.test(cur);
        console.log("[SyncLyst] Depop Category: verify — trigger shows '" + cur + "', stuck =", stuck);
        if (fillWin) fillWin.__synclystDepopCategoryDone = stuck;
        return stuck;
      };

      let pickedSuggested = false;
      const trySuggestedPill = () => {
        if (pickedSuggested || (fillWin && fillWin.__synclystDepopCategoryDone)) return;
        if (depopClickBestSuggestedCategoryPill(rootEl, scan, catHint)) pickedSuggested = true;
        else if (pathGuess && depopClickBestSuggestedCategoryPill(rootEl, scan, pathGuess)) pickedSuggested = true;
        if (pickedSuggested) setTimeout(verifyCategoryStuck, 250);
      };
      trySuggestedPill();
      /** This function runs on every fill tick (up to 30x, every 360ms) — without this guard,
       * every single tick scheduled its own fresh batch of retry timers + the 4200ms fallback
       * below, piling up dozens of overlapping full-page scans and stalling the page long enough
       * to blow past the fill response timeout. Schedule the retry wave at most once per page load. */
      if (fillWin && !fillWin.__synclystDepopCategoryRetryScheduled) {
        fillWin.__synclystDepopCategoryRetryScheduled = true;
        [120, 280, 520, 900, 1600, 2600, 4000].forEach((ms) => setTimeout(trySuggestedPill, ms));
        /** Only fall back to typing/combobox-confirm if the pill click hasn't already landed —
         * running this unconditionally was overwriting a just-successful pill pick. */
        setTimeout(() => {
          if (fillWin && fillWin.__synclystDepopCategoryDone) return;
          if (pickedSuggested) return;
          const ok =
            (!broad &&
              (depopPickComboboxConfirmed(rootEl, ["category"], neg, fillStr) ||
                vintedFillByHints(rootEl, ["category"], neg, fillStr))) ||
            (broad &&
              pathGuess &&
              (depopPickComboboxConfirmed(rootEl, ["category"], neg, pathGuess) ||
                vintedFillByHints(rootEl, ["category"], neg, pathGuess)));
          if (ok) setTimeout(verifyCategoryStuck, 250);
        }, 4200);
      }
    } else if (catAlreadyPicked) {
      console.log("[SyncLyst] Depop Category: already confirmed picked earlier, leaving untouched");
    }
  }
  {
    const bv = v.brand != null ? String(v.brand).trim() : "";
    if (depopPickBrandOrOther(rootEl, neg, bv)) n++;
    else if (bv && vintedFillByHints(rootEl, ["brand"], neg, bv)) n++;
  }
  {
    const condVal = resolveDepopConditionForFill(scan, v);
    const condNeg = [...neg, "insert at least", "please insert", "size chart"];
    const condAlreadyPicked = !!(fillWin && fillWin.__synclystDepopConditionDone);
    if (condAlreadyPicked) {
      console.log("[SyncLyst] Depop Condition: already confirmed picked earlier, leaving untouched");
    } else if (!condVal) {
      console.warn("[SyncLyst] Depop Condition: resolveDepopConditionForFill() returned empty", {
        "v.condition": v && v.condition,
      });
    } else {
      const triggers = depopFindComboboxTriggersForHints(rootEl, ["condition"], condNeg);
      console.log(
        "[SyncLyst] Depop Condition: want='" + condVal + "', " + triggers.length + " trigger(s) found",
        triggers
      );
      const confirmedPick = depopPickComboboxConfirmed(rootEl, ["condition"], condNeg, condVal);
      const ok = confirmedPick || vintedFillByHints(rootEl, ["condition"], condNeg, condVal);
      console.log("[SyncLyst] Depop Condition: pick result =", ok, "(confirmed combobox pick =", confirmedPick + ")");
      if (ok) {
        n++;
        /** vintedFillByHints just types text — it doesn't confirm Depop committed a real selected
         * option, so a "success" from that path alone must not permanently lock out future retries
         * (the field can still show empty/red even though typing "succeeded"). Only the confirmed
         * combobox pick, or a verified displayed value, earns the permanent done flag. */
        if (confirmedPick && fillWin) {
          fillWin.__synclystDepopConditionDone = true;
        } else if (fillWin) {
          setTimeout(() => {
            const trig = (depopFindComboboxTriggersForHints(rootEl, ["condition"], condNeg) || [])[0];
            const cur = String((trig && trig.value) || (trig && trig.textContent) || "").trim();
            const stuck = cur.length > 1 && !/required|select|choose/i.test(cur);
            console.log("[SyncLyst] Depop Condition: verify text-fill — trigger shows '" + cur + "', stuck =", stuck);
            fillWin.__synclystDepopConditionDone = stuck;
          }, 300);
        }
      }
    }
  }
  {
    const sizeVal = resolveDepopSizeForFill(scan, v);
    const negSize = [
      ...neg,
      "condition",
      "category",
      "brand",
      "quantity",
      "postage",
      "shipping",
      "color",
      "colour",
      "source",
      "age",
      "style",
    ];
    if (
      sizeVal &&
      (depopPickSizeComboboxWithFallbacks(rootEl, negSize, sizeVal) ||
        vintedFillByHints(rootEl, ["size"], negSize, sizeVal))
    ) {
      n++;
    }
  }
  if (v.color && vintedFillByHints(rootEl, ["color", "colour"], neg, String(v.color))) n++;
  {
    const sourceVal = resolveDepopSourceForFill(scan, v);
    if (
      sourceVal &&
      (depopPickComboboxConfirmed(rootEl, ["source", "what kind of item"], neg, sourceVal) ||
        vintedFillByHints(rootEl, ["source", "what kind of item"], neg, sourceVal))
    ) {
      n++;
    }
  }
  {
    const ageVal = resolveDepopAgeForFill(scan, v);
    if (
      ageVal &&
      (depopPickComboboxConfirmed(rootEl, ["age"], [...neg, "postage"], ageVal) ||
        vintedFillByHints(rootEl, ["age"], [...neg, "postage"], ageVal))
    ) {
      n++;
    }
  }
  if (v.style && vintedFillByHints(rootEl, ["style"], neg, String(v.style))) n++;
  // Depop Style is often multiple comboboxes/tags; try picking up to 3 values when comma-separated.
  try {
    const rawStyle = v && v.style != null ? String(v.style) : "";
    const parts = rawStyle
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (parts.length) {
      const styleNeg = [...neg, "source", "age", "brand", "category", "condition", "size"];
      for (const lab of parts) {
        if (
          depopPickComboboxConfirmed(rootEl, ["style"], styleNeg, lab) ||
          vintedFillByHints(rootEl, ["style"], styleNeg, lab)
        ) {
          n++;
        }
      }
    }
  } catch {
    /* ignore */
  }
  if (
    v.shipping_price &&
    vintedFillByHints(rootEl, ["shipping price"], negShip, String(v.shipping_price))
  ) {
    n++;
  }
  if (v.country && vintedFillByHints(rootEl, ["country"], neg, String(v.country))) n++;
  // Offer worldwide shipping checkbox (saved from review page as listing_extra.depop.offer_worldwide_shipping).
  try {
    const wantWw = v && v.offer_worldwide_shipping === true;
    const wantOff = v && v.offer_worldwide_shipping === false;
    if (wantWw || wantOff) {
      let toggled = false;
      for (const cb of querySelectorAllDeep('input[type="checkbox"]', rootEl)) {
        if (!(cb instanceof HTMLInputElement) || !isVisible(cb) || cb.disabled) continue;
        const lab = `${cb.closest("label")?.textContent || ""} ${cb.getAttribute("aria-label") || ""}`
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (!/worldwide\s+shipping|offer\s+worldwide/i.test(lab)) continue;
        if (wantWw && !cb.checked) {
          cb.click();
          toggled = true;
        } else if (wantOff && cb.checked) {
          cb.click();
          toggled = true;
        }
        break;
      }
      if (toggled) n++;
    }
  } catch {
    /* ignore */
  }
  try {
    [2200, 3800].forEach((ms) => setTimeout(() => depopCloseDropdownUi(rootEl), ms));
  } catch {
    /* ignore */
  }
  return n;
}

function fillShopeeListingExtraFields(scan, root) {
  const rootEl = documentRootElement(root);
  const ex = shopeeGetExtra(scan);
  const neg = ["search", "feedback", "coupon", "header", "nav", "help", "promo", "gtin", "barcode"];
  const negStock = [...neg, "sold", "order", "feedback"];
  let n = 0;
  const win = rootEl.defaultView || window;
  try {
    win.__synclystShopeeLastScan = scan;
  } catch {
    /* ignore */
  }

  try {
    win.__synclystShopeeTabTurn = (win.__synclystShopeeTabTurn || 0) + 1;
    const turn = win.__synclystShopeeTabTurn % 6;
    if (turn === 0) {
      shopeeClickTabByLabel(rootEl, [/basic\s*information/i, "basic information", "ข้อมูลพื้นฐาน"]);
    } else if (turn === 1) {
      shopeeClickTabByLabel(rootEl, [/specification/i, "specification", "สเปค", "ข้อมูลจำเพาะ"]);
    } else if (turn === 2) {
      shopeeClickTabByLabel(rootEl, [/^description$/i, "description", "รายละเอียด"]);
    } else if (turn === 3) {
      shopeeClickTabByLabel(rootEl, [/sales\s*information/i, "sales information", "ข้อมูลการขาย"]);
    } else if (turn === 4) {
      shopeeClickTabByLabel(rootEl, [/shipping/i, "การจัดส่ง"]);
    } else {
      shopeeClickTabByLabel(rootEl, [/others/i, "อื่น"]);
    }
  } catch {
    /* ignore */
  }

  if (shopeeFillCategory(scan, rootEl)) n++;

  n += shopeeFillSalesPriceAndShippingWeight(scan, rootEl);
  n += shopeeSpecificationDropdownsTick(scan, rootEl);

  const gtinDefault = ex && ex.item_without_gtin === false ? false : true;
  if (gtinDefault && shopeeCheckItemWithoutGtinIfPresent(rootEl)) n++;

  const stockVal =
    ex && ex.stock != null && String(ex.stock).trim()
      ? String(ex.stock).trim()
      : "1";
  const stockEl = shopeeBestScoredInput(rootEl, shopeeScoreSalesStockInput);
  if (stockEl && fillField(stockEl, stockVal)) n++;
  else if (vintedFillByHints(rootEl, ["stock"], negStock, stockVal)) n++;

  const minPurchase =
    ex && ex.min_purchase_qty != null && String(ex.min_purchase_qty).trim()
      ? String(ex.min_purchase_qty).trim()
      : "1";
  if (vintedFillByHints(rootEl, ["minimum", "min purchase", "min. purchase"], neg, minPurchase)) n++;

  const pw =
    ex && ex.parcel_width_cm != null && String(ex.parcel_width_cm).trim()
      ? String(ex.parcel_width_cm).trim()
      : "20";
  const pl =
    ex && ex.parcel_length_cm != null && String(ex.parcel_length_cm).trim()
      ? String(ex.parcel_length_cm).trim()
      : "25";
  const ph =
    ex && ex.parcel_height_cm != null && String(ex.parcel_height_cm).trim()
      ? String(ex.parcel_height_cm).trim()
      : "5";

  if (vintedFillByHints(rootEl, ["width"], [...neg, "screen", "shoulder", "length in"], pw)) n++;
  if (vintedFillByHints(rootEl, ["length"], [...neg, "description", "shoulder", "sleeve"], pl)) n++;
  if (vintedFillByHints(rootEl, ["height"], [...neg, "description"], ph)) n++;

  if (ex && ex.size_chart_pick_first === false) {
    /* skip */
  } else if (shopeePickSizeChartTemplateIfRequired(rootEl)) n++;

  if (shopeeEnableFirstShippingChannel(rootEl)) n++;

  return n;
}

/** Same optional fields as public/extension-review.html when listing_extra.shopify is set. */
function fillShopifyListingExtraFields(scan, root) {
  const raw = scan.listing_extra;
  const hasExtra = raw && typeof raw === "object";
  const s = hasExtra ? raw.shopify || raw : null;
  const rootEl = documentRootElement(root);
  let n = 0;

  n += shopifyFillTagsCombobox(scan, root);
  n += shopifyFillCollectionsCombobox(scan, root);
  n += shopifyClearGtinIfValueMatchesPrice(scan, rootEl);

  if (!hasExtra || !s || typeof s !== "object") return n;

  function tryOne(selectors, val) {
    const str = val != null ? String(val).trim() : "";
    if (!str) return false;
    const list = Array.isArray(selectors) ? selectors : [selectors];
    for (const sel of list) {
      let nodes;
      try {
        nodes = querySelectorAllDeep(sel, rootEl);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) continue;
        if (!isVisible(el) || el.readOnly) continue;
        if (fillField(el, str)) return true;
      }
    }
    return false;
  }

  const vendorFilled = tryOne(
    [
      'input[aria-label*="Vendor" i]',
      'input[name="vendor"]',
      'input[id*="vendor" i]',
      'input[id*="Vendor" i]',
      '[role="combobox"] input[aria-label*="Vendor" i]',
      'input[placeholder*="vendor" i]',
    ],
    s.vendor
  );
  if (vendorFilled) {
    n++;
  } else if (s.vendor) {
    console.warn("[SyncLyst] Shopify Vendor field: no input selector matched, trying <select> (value was '" + s.vendor + "')");
    if (shopifyFillSelectByLabel(rootEl, /vendor/i, s.vendor, "Vendor field")) n++;
  }
  if (s.product_type) {
    const pt =
      shopifyFillProductTypeField(rootEl, s.product_type) ||
      tryOne(
        [
          'input[aria-label*="Product type" i]',
          'input[aria-label*="product type" i]',
          'input[name="type"]',
          'input[id*="ProductType" i]',
          'input[id*="product-type" i]',
          '[role="combobox"] input[aria-label*="type" i]',
        ],
        s.product_type
      );
    if (pt) n++;
    else console.warn("[SyncLyst] Shopify Type field: all strategies failed (value was '" + s.product_type + "')");
  }
  if (
    tryOne(
      [
        'input[aria-label*="Search engine title" i]',
        'input[aria-label*="page title" i]',
        'input[id*="seo" i][id*="title" i]',
      ],
      s.seo_page_title
    )
  ) {
    n++;
  }
  if (
    tryOne(
      [
        'textarea[aria-label*="meta description" i]',
        'textarea[id*="seo" i]',
        'textarea[aria-label*="Meta description" i]',
      ],
      s.seo_meta_description
    )
  ) {
    n++;
  }
  if (tryOne(['input[aria-label*="Compare" i]', 'input[id*="compare" i]'], s.compare_at)) n++;

  if (
    tryOne(
      [
        'input[aria-label*="SKU" i]',
        'input[name="sku"]',
        'input[id*="sku" i]',
        'input[id*="Sku" i]',
      ],
      s.sku
    )
  ) {
    n++;
  }
  if (s.barcode && retailBarcodeLooksValid(s.barcode)) {
    if (
      tryOne(
        [
          'input[aria-label*="GTIN" i]',
          'input[aria-label*="Barcode" i]',
          'input[name="barcode"]',
          'input[id*="barcode" i]',
          'input[id*="gtin" i]',
        ],
        s.barcode
      )
    ) {
      n++;
    }
  }
  if (
    tryOne(
      [
        'input[aria-label*="Weight" i]',
        'input[name="weight"]',
        'input[id*="weight" i]',
        'input[placeholder*="weight" i]',
      ],
      s.weight
    )
  ) {
    n++;
  }
  if (tryShopifyWeightUnitSelect(rootEl, s.weight_unit)) n++;
  if (s.category) {
    const cat =
      shopifyFillCategoryField(rootEl, s.category, 0) ||
      tryOne(
        [
          'input[aria-label*="Category" i]',
          'input[placeholder*="category" i]',
          'input[id*="Category" i]',
          '[role="combobox"] input[aria-label*="ategory" i]',
        ],
        s.category
      );
    if (cat) n++;
    else console.warn("[SyncLyst] Shopify Category field: all strategies failed (value was '" + s.category + "')");
  }
  if (
    tryOne(
      [
        'input[aria-label*="Quantity" i]',
        'input[aria-label*="Inventory" i]',
        'input[aria-label*="Available" i]',
        'input[name*="quantity" i]',
        'input[id*="quantity" i]',
        'input[id*="inventory" i]',
      ],
      s.quantity
    )
  ) {
    n++;
  }

  n += fillShopifyMetafieldInputs(s, rootEl);
  n += shopifyFillVariantOptionValues(s, rootEl);
  return n;
}

/**
 * Best-effort: first option rows for Size / Color (full review variant lists).
 */
function shopifyFillVariantOptionValues(s, rootEl) {
  const sizes = Array.isArray(s.sizes) ? s.sizes.map((x) => String(x || "").trim()).filter(Boolean) : [];
  const colors = Array.isArray(s.colors) ? s.colors.map((x) => String(x || "").trim()).filter(Boolean) : [];
  if (!sizes.length && !colors.length) return 0;
  let remS = sizes.slice();
  let remC = colors.slice();
  let n = 0;
  try {
    let scope = null;
    const sections = querySelectorAllDeep("section, [class*='Card'], div", rootEl);
    for (const sec of sections) {
      const head = (sec.textContent || "").slice(0, 160);
      if (/^[\s\S]*\bvariants\b/i.test(head) && /add options|option name|variant/i.test(head.toLowerCase())) {
        scope = sec;
        break;
      }
    }
    const searchRoot = scope || rootEl;
    const rows = querySelectorAllDeep(
      'table tbody tr, [class*="variant"] tbody tr, [data-testid*="variant"] tr',
      searchRoot
    );
    for (const row of rows) {
      if (!(row instanceof HTMLElement) || !isVisible(row)) continue;
      const rowText = (row.textContent || "").toLowerCase();
      const inputs = row.querySelectorAll('input[type="text"], input:not([type]), textarea');
      for (const inp of inputs) {
        if (!(inp instanceof HTMLInputElement || inp instanceof HTMLTextAreaElement)) continue;
        if (!isVisible(inp) || inp.readOnly) continue;
        const lab = shopifyControlAccessibleName(inp).toLowerCase();
        const ph = (inp.getAttribute("placeholder") || "").toLowerCase();
        if (remS.length && (lab.includes("size") || ph.includes("size") || rowText.includes("size"))) {
          if (fillField(inp, remS[0])) {
            n++;
            remS.shift();
            break;
          }
        }
        if (remC.length && (lab.includes("color") || ph.includes("color") || rowText.includes("color"))) {
          if (fillField(inp, remC[0])) {
            n++;
            remC.shift();
            break;
          }
        }
      }
    }
    if (n === 0 && scope) {
      const optInputs = querySelectorAllDeep("input", searchRoot);
      for (const inp of optInputs) {
        if (!(inp instanceof HTMLInputElement) || !isVisible(inp)) continue;
        const lab = shopifyControlAccessibleName(inp).toLowerCase();
        const ph = (inp.getAttribute("placeholder") || "").toLowerCase();
        if (
          remS.length &&
          (lab.includes("option") && (lab.includes("value") || lab.includes("name"))) &&
          !lab.includes("price")
        ) {
          const blob = remS.length > 1 ? remS.join(", ") : remS[0];
          if (fillField(inp, blob)) {
            n++;
            break;
          }
        }
        if (ph.includes("separate") || ph.includes("comma")) {
          const blob = [...remS, ...remC].filter(Boolean).join(", ");
          if (blob && fillField(inp, blob)) {
            n++;
            break;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }
  return n;
}

function fillFromMapper(platform, scan, root) {
  const r = root || document;
  const m =
    (typeof SYNCLYST_PLATFORM_MAPPERS !== "undefined" &&
      SYNCLYST_PLATFORM_MAPPERS[platform]) ||
    SYNCLYST_PLATFORM_MAPPERS.shopify;
  let n = 0;
  const deep =
    platform === "shopify" ||
    platform === "shopee" ||
    platform === "lazada" ||
    platform === "grailed" ||
    platform === "vinted" ||
    platform === "ebay" ||
    platform === "depop" ||
    platform === "etsy";
  const rootEl = documentRootElement(r);

  let titleEl = null;
  if (deep) {
    if (platform === "shopee") {
      titleEl = queryBestShopeeProductNameInput(r);
    } else if (platform === "depop") {
      titleEl = null;
    } else if (platform === "etsy") {
      titleEl = queryBestEtsyTitleInput(r);
    } else if (platform === "vinted") {
      titleEl = queryBestVintedTitleInput(r);
    } else {
      titleEl = queryBestShopifyTitleInput(r);
    }
    if (!titleEl) {
      titleEl = queryFirstDeepVisible(m.title, r);
      if (!titleEl) titleEl = queryFirstDeep(m.title, r);
    }
  } else {
    titleEl = queryFirst(m.title, r);
    if (!titleEl) titleEl = queryFirstDeep(m.title, r);
  }
  const titleFill =
    platform === "shopee"
      ? shopeeProductTitleForFill(scan)
      : platform === "etsy"
        ? etsyTitleForFill(scan)
        : scan.title;
  const titleFillTrimmed = trimListingTitleRunOn(titleFill, 80, scan.description);
  const titleFillNorm = normalizeTitleCaps(titleFillTrimmed);
  if (titleEl && fillField(titleEl, titleFillNorm)) n++;

  /** Price before description on heavy SPAs so Lexical / RTE focus does not block price/title-like fields. */
  let priceStr =
    platform === "vinted"
      ? resolveVintedPriceStringForFill(scan)
      : normalizeMarketplacePriceString(scan.price);
  if (platform === "vinted" && priceStr) {
    const pn = parseFloat(priceStr);
    if (!Number.isFinite(pn) || pn < 1) priceStr = "";
  }
  if (deep) {
    if (platform === "vinted") {
      if (priceStr) {
        const priceFilled = vintedForceFillPriceFromScan(scan, r);
        n += priceFilled;
        if (!priceFilled) vintedFireMainWorldPriceThrottled(priceStr);
      }
    } else {
      let priceEl = null;
      priceEl = queryFirstDeepVisible(m.price, r);
      if (!priceEl) priceEl = queryFirstDeep(m.price, r);
      if (priceEl && titleEl && priceEl === titleEl) {
        priceEl = queryPriceDeepExcluding(r, platform, titleEl);
      }
      if ((platform === "shopee" || platform === "shopify") && priceEl && isGtinBarcodeOrProductCodeInput(priceEl)) {
        priceEl = queryPriceDeepExcluding(r, platform, priceEl);
      }
      if ((platform === "shopee" || platform === "shopify") && priceEl && isGtinBarcodeOrProductCodeInput(priceEl)) {
        priceEl = null;
      }
      if (priceEl && titleEl && priceEl === titleEl) {
        priceEl = null;
      }
      if (!priceEl) priceEl = queryBestShopifyPriceInput(r, titleEl);
      if (priceEl && priceStr && fillField(priceEl, priceStr)) n++;
      else if (priceStr) {
        const priceLikeSrc = scan.price;
        if (fillPriceLike(priceLikeSrc, r)) n++;
        else {
          const nodes = querySelectorAllDeep('input[name="price"], input[id*="price" i]', rootEl);
          for (const node of nodes) {
            if (
              node === titleEl ||
              !(node instanceof HTMLInputElement) ||
              !isVisible(node) ||
              node.readOnly
            ) {
              continue;
            }
            if ((platform === "shopee" || platform === "shopify") && isGtinBarcodeOrProductCodeInput(node)) continue;
            if (fillField(node, priceStr)) {
              n++;
              break;
            }
          }
        }
      }
    }
  }

  let descText = String(scan.description || "").trim();
  if (platform === "depop") {
    const ti = String(scan.title || "").trim();
    if (ti && descText) descText = `${ti}\n\n${descText}`;
    else if (ti && !descText) descText = ti;
  }
  if (platform === "ebay") {
    const ed = ebayDescriptionForFill(scan);
    if (ed) descText = ed;
  }
  let didRichDescription = false;
  if (deep && descText) {
    if (platform === "ebay") {
      didRichDescription = ebayFillRichDescription(descText, r);
    } else if (platform !== "shopee" && platform !== "depop" && platform !== "etsy") {
      didRichDescription = shopifyFillRichDescription(descText, r);
    }
    if (didRichDescription) n++;
  }

  let descEl = queryFirst(m.description, r);
  if (!descEl && deep) descEl = queryFirstDeepVisible(m.description, r);
  if (!descEl && deep) descEl = queryFirstDeep(m.description, r);
  if (!descEl && !deep) descEl = queryFirstDeep(m.description, r);
  if (platform === "shopee") {
    console.log(
      "[SyncLyst] Shopee Description: descEl found =",
      !!descEl,
      "descText length =",
      (descText || "").length,
      "didRichDescription =",
      didRichDescription,
      descEl
    );
  }
  if (descEl && descText && !didRichDescription) {
    if (descEl.isContentEditable) {
      descEl.focus();
      descEl.textContent = descText;
      descEl.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      n++;
    } else if (descEl.classList && descEl.classList.contains("ql-editor")) {
      descEl.textContent = descText;
      descEl.dispatchEvent(new Event("input", { bubbles: true }));
      n++;
    } else if (descEl.classList && descEl.classList.contains("ProseMirror")) {
      descEl.textContent = descText;
      descEl.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true }));
      n++;
    } else if (fillField(descEl, descText)) {
      n++;
    }
  }

  if (!deep) {
    const pStr = normalizeMarketplacePriceString(scan.price);
    let priceEl = queryFirst(m.price, r);
    if (!priceEl) priceEl = queryFirstDeep(m.price, r);
    if (priceEl && pStr && fillField(priceEl, pStr)) n++;
    else if (pStr) {
      if (fillPriceLike(scan.price, r)) n++;
    }
  }

  return n;
}

function showSynclystBanner(text) {
  if (!text) return;
  try {
    if (window.location.hostname !== "admin.shopify.com") return;
    const id = "synclyst-magic-fill-banner";
    document.getElementById(id)?.remove();
    const el = document.createElement("div");
    el.id = id;
    el.setAttribute("role", "status");
    el.textContent = text;
    el.style.cssText =
      "position:fixed;bottom:22px;left:50%;transform:translateX(-50%);z-index:2147483647;max-width:min(92vw,420px);padding:11px 15px;border-radius:10px;font:13px/1.45 system-ui,-apple-system,sans-serif;background:#18181b;color:#fafafa;box-shadow:0 6px 24px rgba(0,0,0,.28);pointer-events:none;";
    (document.body || document.documentElement).appendChild(el);
    setTimeout(() => {
      try {
        el.remove();
      } catch {
        /* ignore */
      }
    }, 14000);
  } catch {
    /* ignore */
  }
}

(function registerSynclystFillListener() {
  if (globalThis.__synclystFillListenerRegistered) return;
  globalThis.__synclystFillListenerRegistered = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "SYNCLYST_FILL" || !message.payload) {
    return false;
  }
  if (typeof message.fill_source_tab_id === "number" && Number.isFinite(message.fill_source_tab_id)) {
    try {
      globalThis.__synclystFillSourceTabId = message.fill_source_tab_id;
    } catch {
      /* ignore */
    }
  }
  const scan = {
    title: resolveScanTitleFromPayload(message.payload),
    description: resolveScanDescriptionFromPayload(message.payload),
    price: message.payload.price ?? message.payload.price_value,
    listing_extra: message.payload.listing_extra,
    image_url: message.payload.image_url,
  };
  try {
    const extra = scan.listing_extra && typeof scan.listing_extra === "object" ? scan.listing_extra : null;
    const media =
      extra && extra.media && typeof extra.media === "object" && !Array.isArray(extra.media) ? extra.media : null;
    const mu = media && Array.isArray(media.image_urls) ? media.image_urls : [];
    if (!scan.image_url && mu.length && typeof mu[0] === "string") {
      scan.image_url = mu[0];
    } else if (!scan.image_url) {
      const ex = scan.listing_extra && (scan.listing_extra.shopify || scan.listing_extra);
      const imgs = ex && Array.isArray(ex.additional_images) ? ex.additional_images : [];
      if (imgs.length && typeof imgs[0] === "string") scan.image_url = imgs[0];
    }
  } catch {
    /* ignore */
  }
  const platform =
    message.platform ||
    (typeof synclystDetectPlatformFromUrl === "function"
      ? synclystDetectPlatformFromUrl(window.location.href)
      : "shopify");
  const autoSave = message.auto_save !== false;
  const pFill = (platform || "").toLowerCase();
  if (pFill === "shopee") {
    /** Shopee's actual form lives in a cross-origin shopeemobile.com iframe, which now also gets
     * its own content-script instance (manifest all_frames). Chrome broadcasts SYNCLYST_FILL to
     * every frame in the tab, so without this guard the outer seller.shopee.* page and the iframe
     * would race to respond — whichever frame finishes first (almost always the empty outer page)
     * would win, silently discarding the iframe's real result. Only the iframe should answer. */
    let isOuterShopeePage = false;
    try {
      isOuterShopeePage = window.top === window && /seller\.shopee\.|banhang\.shopee\./i.test(window.location.hostname);
    } catch {
      isOuterShopeePage = false;
    }
    if (isOuterShopeePage) return false;
  }
  if (pFill === "ebay") {
    try {
      delete window.__synclystEbaySuggestedApplyDone;
      delete window.__synclystEbayDescDeferredPlanned;
      delete window.__synclystEbayDescMainAt;
    } catch {
      /* ignore */
    }
  }
  const fillWaitMs =
    // Shopee's own tick loop can run close to ~20s (52 attempts at up to 380ms apart) — 22s left
    // almost no headroom for normal page slowness, so it timed out even when the fill ultimately
    // succeeded. Give it the same longer window as the heaviest SPAs.
    pFill === "shopee"
      ? 28000
      : // Shopify admin is a heavy SPA; give it more time so we don't time out after
        // fields have been filled but Save/paste wiring isn't finished yet.
        pFill === "shopify" || pFill === "lazada" || pFill === "depop" || pFill === "ebay"
        ? 22000
        : 11000;
  const fillTimeoutMsg =
    pFill === "shopify"
      ? "Timed out waiting for the product page. Refresh the Shopify tab, wait for Add product to load, then try again."
      : pFill === "shopee"
        ? "Timed out waiting for Shopee Seller Centre. Open add product, wait for the form to finish loading, then try Magic Fill again."
        : pFill === "lazada"
          ? "Timed out waiting for Lazada Seller Center. Open add product, wait for the form to load, then try Magic Fill again."
          : pFill === "depop"
            ? "Timed out waiting for Depop. Open List an item, wait for the form to load, then try Magic Fill again."
            : "Timed out waiting for the listing page. Refresh the tab and try again.";

  let settled = false;
  const alarm = setTimeout(() => {
    if (settled) return;
    settled = true;
    try {
      sendResponse({
        ok: false,
        error: fillTimeoutMsg,
        filled: 0,
        platform,
        timed_out: true,
      });
    } catch {
      /* message channel already closed */
    }
  }, fillWaitMs);

  const finish = (payload) => {
    if (settled) return;
    settled = true;
    clearTimeout(alarm);
    try {
      if (window.location.hostname === "admin.shopify.com") {
        let line = "";
        if (payload.timed_out || payload.ok === false) {
          line = payload.error ? `SyncLyst: ${payload.error}` : "SyncLyst: Something went wrong — refresh this tab and try again.";
        } else if ((payload.filled || 0) > 0) {
          line = payload.saved
            ? `SyncLyst: Filled ${payload.filled} field(s) and tried Save.`
            : `SyncLyst: Filled ${payload.filled} field(s). Click Save if needed.`;
        } else if (payload.shopify_page === "list" && payload.new_product_url) {
          line = "SyncLyst: On product list — use Magic Fill again after Add product opens.";
        } else if (payload.shopify_page === "editor") {
          line = "SyncLyst: No fields found yet — wait for the page to finish loading, then try again.";
        } else {
          line = "SyncLyst: Open Add product or a product editor, then try Magic Fill again.";
        }
        showSynclystBanner(line);
      }
    } catch {
      /* ignore */
    }
    try {
      sendResponse(payload);
    } catch {
      /* popup closed or channel gone */
    }
  };

  try {
    if (!autoSave) {
      const filled = fillScanIntoPage(platform, scan);
      const base = attachShopifyContext({ ok: true, filled, platform }, platform);
      finish(base);
      return true;
    }

    runFillThenRespond(platform, scan, true, finish);
  } catch (e) {
    finish({
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      platform,
    });
  }
  return true;
});
})();
