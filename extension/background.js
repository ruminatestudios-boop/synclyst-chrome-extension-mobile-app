/**
 * MV3 service worker: stable Snap-to-List session id + message relay.
 */
function genSessionId() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Prefer an open `/snap` or `/snap.html?...&s=` tab over stored id so the extension QR matches
 * the pairing page URL (Next.js embeds snap.html in an iframe; both must agree).
 */
function sessionIdFromSnapTabUrl(raw) {
  if (!raw || raw.indexOf("/snap") === -1) return null;
  try {
    const u = new URL(raw);
    const p = (u.pathname || "").replace(/\/$/, "");
    if (p !== "/snap" && p !== "/snap.html") return null;
    const s = (u.searchParams.get("s") || "").trim();
    return /^[a-f0-9]{12,32}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

function pickSessionIdFromOpenSnapTabs() {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (activeList) => {
        const a0 = activeList && activeList[0];
        const fromActive = a0 && sessionIdFromSnapTabUrl(a0.url || "");
        if (fromActive) {
          resolve(fromActive);
          return;
        }
        chrome.tabs.query({}, (tabs) => {
          try {
            for (const t of tabs || []) {
              const s = sessionIdFromSnapTabUrl(t.url || "");
              if (s) {
                resolve(s);
                return;
              }
            }
          } catch {
            /* ignore */
          }
          resolve(null);
        });
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Stable pairing id: prefer persisted storage so the QR / session don’t “flip” when another browser
 * tab has an old `/snap?s=` URL open. The id stays until the user taps “New pairing code”, clears
 * storage, or opens a different `/snap` link (snap-bridge.js syncs `s=` from that page).
 * New phone scans use the same id — `/api/snap-pair/push` upserts listing data for it.
 */
function ensureSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["snap_pair_session_id"], (o) => {
      const stored = o && o.snap_pair_session_id && /^[a-f0-9]{12,32}$/i.test(String(o.snap_pair_session_id))
        ? String(o.snap_pair_session_id)
        : "";
      if (stored) {
        resolve(stored);
        return;
      }
      pickSessionIdFromOpenSnapTabs().then((fromTab) => {
        if (fromTab) {
          chrome.storage.local.set({ snap_pair_session_id: fromTab }, () => resolve(fromTab));
          return;
        }
        const id = genSessionId();
        chrome.storage.local.set({ snap_pair_session_id: id }, () => resolve(id));
      });
    });
  });
}

chrome.runtime.onStartup.addListener(() => {
  ensureSessionId();
  void pollSessionForDesktopNotify();
});

/** Phone scans don't run snap-bridge on desktop — poll session so badge + popup signal when listing lands. */
const SYNCLYST_ORIGIN_DEFAULT = "https://app.synclyst.app";
const STORAGE_LAST_NOTIFIED_STAMP = "synclyst_last_notified_session_stamp";

function sessionRowHasListing(L) {
  if (!L || typeof L !== "object") return false;
  const t = L.title != null ? String(L.title).trim() : "";
  const d = L.description != null ? String(L.description).trim() : "";
  if (t || d) return true;
  if (L.price !== undefined && L.price !== null && String(L.price).trim() !== "") return true;
  const img = L.image_url != null ? String(L.image_url).trim() : "";
  if (img && (img.startsWith("data:") || img.startsWith("http") || img.startsWith("blob:"))) return true;
  return false;
}

async function pollSessionForDesktopNotify() {
  try {
    const sid = await ensureSessionId();
    if (!sid) return;
    const o = await chrome.storage.local.get(["synclyst_origin_auto", STORAGE_LAST_NOTIFIED_STAMP]);
    const base = String(o.synclyst_origin_auto || SYNCLYST_ORIGIN_DEFAULT).replace(/\/$/, "");
    const r = await fetch(`${base}/api/snap-pair/session/${encodeURIComponent(sid)}`);
    if (!r.ok) return;
    const j = await r.json();
    if (!j || j.empty || !j.listing || !sessionRowHasListing(j.listing)) return;
    const stamp =
      j.listing.updated_at != null && String(j.listing.updated_at).trim() !== ""
        ? String(j.listing.updated_at).trim()
        : "";
    if (!stamp || stamp === o[STORAGE_LAST_NOTIFIED_STAMP]) return;
    await chrome.storage.local.set({
      [STORAGE_LAST_NOTIFIED_STAMP]: stamp,
      synclyst_snap_listing_ready_at: Date.now(),
      synclyst_prefers_qr_home: false,
    });
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
      await chrome.action.setBadgeText({ text: "!" });
      await chrome.action.setTitle({ title: "SyncLyst® — scan ready: open to review" });
    } catch {
      /* ignore */
    }
  } catch {
    /* offline */
  }
}

try {
  chrome.alarms.create("synclyst_session_poll", { periodInMinutes: 0.5 });
} catch {
  /* ignore */
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === "synclyst_session_poll") {
    void pollSessionForDesktopNotify();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  ensureSessionId();
  void pollSessionForDesktopNotify();
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Serialized into the page with `world: "MAIN"` so it shares Vinted’s JS realm (React listeners, etc.).
 * Content scripts are isolated — clicks from there often never reach the app’s handlers.
 */
function vintedMainWorldPickFunc(segments, categoryStr) {
  try {
  function allDeep(sel, root) {
    const out = [];
    function scan(n) {
      if (!n || !n.querySelectorAll) return;
      try {
        n.querySelectorAll(sel).forEach((e) => out.push(e));
      } catch {
        /* ignore */
      }
      try {
        n.querySelectorAll("*").forEach((el) => {
          if (el.shadowRoot) scan(el.shadowRoot);
        });
      } catch {
        /* ignore */
      }
    }
    scan(root || document.documentElement || document.body);
    return out;
  }
  function pickDialog() {
    const roots = [];
    if (document.body) roots.push(document.body);
    if (document.documentElement) roots.push(document.documentElement);
    let best = null;
    let bestSc = 0;
    const scorePanel = (el) => {
      if (!(el instanceof HTMLElement)) return 0;
      const t = (el.textContent || "").slice(0, 1600).toLowerCase();
      let s = 0;
      if (t.includes("women") && t.includes("men")) s += 42;
      else if (t.includes("women") || t.includes("men")) s += 22;
      if (t.includes("kids")) s += 10;
      if (t.includes("find a category") || t.includes("search categories") || t.includes("search for a category"))
        s += 34;
      if (t.includes("suggested") || t.includes("catalogue") || t.includes("catalog sections")) s += 18;
      return s;
    };
    for (const root of roots) {
      for (const el of allDeep('[role="dialog"],[aria-modal="true"]', root)) {
        const s = scorePanel(el);
        if (s > bestSc) {
          bestSc = s;
          best = el;
        }
      }
    }
    if (bestSc < 50) {
      for (const inp of allDeep("input", document.body)) {
        if (!(inp instanceof HTMLInputElement)) continue;
        const ty = (inp.type || "").toLowerCase();
        if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file" || inp.disabled) continue;
        const ph = String(inp.getAttribute("placeholder") || "").toLowerCase();
        if (!/\b(find a category|categor|search)\b/.test(ph) && ty !== "search") continue;
        let p = inp.parentElement;
        for (let d = 0; d < 22 && p instanceof HTMLElement; d++) {
          if (p === document.body || p === document.documentElement) break;
          let r;
          try {
            r = p.getBoundingClientRect();
          } catch {
            p = p.parentElement;
            continue;
          }
          if (r.width < 44 || r.height < 44) {
            p = p.parentElement;
            continue;
          }
          const s = scorePanel(p);
          if (s > bestSc) {
            bestSc = s;
            best = p;
          }
          p = p.parentElement;
        }
      }
    }
    return bestSc >= 10 ? best : null;
  }
  const dlg = pickDialog();
  if (!dlg) return { ok: false, step: "dialog" };
  const last = String((segments && segments[segments.length - 1]) || "")
    .trim()
    .toLowerCase();
  const catLow = String(categoryStr || "")
    .toLowerCase()
    .replace(/\s*[>›»→|]\s*/g, " ")
    .trim();

  function rowTextForInput(inp) {
    let bestTxt = "";
    let cur = inp;
    for (let d = 0; d < 16 && cur; d++) {
      try {
        const t = String(cur.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (t.length > bestTxt.length && t.length < 520) bestTxt = t;
      } catch {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    return bestTxt.toLowerCase();
  }
  function scoreSuggestedRow(tl) {
    if (!tl) return 0;
    let s = 0;
    if (/print/.test(tl) && /t[\s-]*shirts?|t[\s-]*shirt|tee/.test(tl)) s += 95;
    if (/[>›»→|]/.test(tl)) s += 40;
    if (/suggested/.test(tl)) s += 12;
    if (last.length > 1 && tl.includes(last)) s += 55;
    if (catLow.length > 4) {
      const h = catLow.slice(0, 40);
      if (h && tl.includes(h)) s += 45;
    }
    return s;
  }
  function visibleRowForInput(inp) {
    let cur = inp.parentElement;
    for (let d = 0; d < 18 && cur; d++) {
      try {
        const r = cur.getBoundingClientRect();
        const t = String(cur.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (r.height >= 20 && r.width >= 68 && t.length >= 8 && t.length < 520) {
          const cs = window.getComputedStyle(cur);
          if (cs.display !== "none" && cs.visibility !== "hidden") return cur;
        }
      } catch {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    return inp;
  }
  function fireClickAt(el, cx, cy) {
    const fire = (Ctor, name, extra) => {
      try {
        const o = Object.assign(
          {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: cx,
            clientY: cy,
            view: window,
            button: 0,
          },
          extra || {}
        );
        el.dispatchEvent(new Ctor(name, o));
      } catch {
        /* ignore */
      }
    };
    try {
      fire(PointerEvent, "pointerdown", {
        buttons: 1,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      });
    } catch {
      /* ignore */
    }
    fire(MouseEvent, "mousedown", { buttons: 1 });
    try {
      fire(PointerEvent, "pointerup", {
        buttons: 0,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      });
    } catch {
      /* ignore */
    }
    fire(MouseEvent, "mouseup", { buttons: 0 });
    fire(MouseEvent, "click", {});
    try {
      el.click();
    } catch {
      /* ignore */
    }
  }
  function activateTarget(target) {
    if (!(target instanceof HTMLElement)) return;
    try {
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    } catch {
      /* ignore */
    }
    const br = target.getBoundingClientRect();
    const cy = br.top + br.height / 2;
    const cxs = [br.right - 8, br.left + br.width * 0.55, br.left + br.width * 0.15];
    for (const rawX of cxs) {
      const cx = Math.min(rawX, br.right - 2);
      fireClickAt(target, cx, cy);
      let stack;
      try {
        stack = document.elementsFromPoint(cx, cy);
      } catch {
        continue;
      }
      if (!stack) continue;
      for (const hitEl of stack.slice(0, 12)) {
        if (!(hitEl instanceof HTMLElement) || !target.contains(hitEl)) continue;
        try {
          hitEl.click();
        } catch {
          /* ignore */
        }
      }
    }
  }
  function setRadioChecked(inp) {
    try {
      const proto = Object.getPrototypeOf(inp);
      const d = Object.getOwnPropertyDescriptor(proto, "checked");
      if (d && d.set) d.set.call(inp, true);
      else inp.checked = true;
    } catch {
      try {
        inp.checked = true;
      } catch {
        /* ignore */
      }
    }
    try {
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch {
      /* ignore */
    }
    try {
      if (typeof HTMLInputElement !== "undefined" && HTMLInputElement.prototype.click) {
        HTMLInputElement.prototype.click.call(inp);
      } else {
        inp.click();
      }
    } catch {
      /* ignore */
    }
  }

  const radios = allDeep('input[type="radio"]:not([disabled])', dlg);
  let bestInp = null;
  let bestSc = -1;
  for (const inp of radios) {
    if (!(inp instanceof HTMLInputElement) || (inp.type || "").toLowerCase() !== "radio") continue;
    const tl = rowTextForInput(inp);
    const sc = scoreSuggestedRow(tl);
    if (sc > bestSc) {
      bestSc = sc;
      bestInp = inp;
    }
  }
  if (bestInp && bestSc >= 42) {
    const row = visibleRowForInput(bestInp);
    try {
      if (bestInp.labels && bestInp.labels.length) bestInp.labels[0].click();
    } catch {
      /* ignore */
    }
    activateTarget(row);
    activateTarget(bestInp);
    setRadioChecked(bestInp);
    return { ok: true, step: "radio_first" };
  }

  let best = null;
  let bestRank = 1e30;
  for (const el of allDeep(
    'div,li,button,label,span,a,article,section,[role="button"],[role="option"],[role="radio"],[role="row"]',
    dlg
  )) {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 12 || r.height > 280) continue;
    let st;
    try {
      st = window.getComputedStyle(el);
    } catch {
      continue;
    }
    if (st.display === "none" || st.visibility === "hidden") continue;
    const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
    if (txt.length < 8 || txt.length > 500) continue;
    const tlow = txt.toLowerCase();
    let hit = /print/.test(tlow) && /t[\s-]*shirts?|tee/.test(tlow);
    if (!hit && /[>›»→|]/.test(txt) && last.length > 1 && tlow.includes(last)) hit = true;
    if (!hit) continue;
    const a = r.width * r.height;
    if (a > 700000) continue;
    const h = r.height;
    const rank = (h >= 14 && h <= 200 ? 0 : 1) * 1e15 + a;
    if (rank < bestRank) {
      bestRank = rank;
      best = el;
    }
  }
  if (!best) return { ok: false, step: "row" };
  activateTarget(best);
  let inp2 = null;
  try {
    inp2 = best.querySelector('input[type="radio"]:not([disabled])');
  } catch {
    /* ignore */
  }
  if (!inp2) {
    for (const cand of radios) {
      if (cand instanceof HTMLInputElement && best.contains(cand)) {
        inp2 = cand;
        break;
      }
    }
  }
  if (inp2) setRadioChecked(inp2);
  return { ok: true, step: "fallback_row" };
  } catch (e) {
    return { ok: false, step: "throw", err: String(e && e.message ? e.message : e) };
  }
}

/** MAIN world: Vinted’s price field is React-controlled; isolated-world `fillField` may not update fiber state (£NaN). */
async function vintedMainWorldSetPriceFunc(priceStr) {
  try {
    const want = parseFloat(String(priceStr || "").trim().replace(/,/g, "."));
    if (!Number.isFinite(want) || want < 1) return { ok: false, step: "bad_num" };
    const strOut = String(Math.round(want * 100) / 100);

    function collectInputs(root) {
      const out = [];
      function go(n) {
        if (!n || !n.querySelectorAll) return;
        try {
          n.querySelectorAll("input").forEach((e) => out.push(e));
        } catch {
          /* ignore */
        }
        try {
          n.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) go(el.shadowRoot);
          });
        } catch {
          /* ignore */
        }
      }
      go(root || document.body);
      return out;
    }

    let best = null;
    let bestSc = 0;
    for (const inp of collectInputs(document.body)) {
      if (!(inp instanceof HTMLInputElement) || inp.disabled || inp.readOnly) continue;
      const ty = (inp.type || "").toLowerCase();
      if (ty === "checkbox" || ty === "radio" || ty === "file" || ty === "search") continue;
      const row = inp.closest("div,section,form,tr,article,li");
      const blob = row ? (row.textContent || "").slice(0, 220).toLowerCase() : "";
      let s = 0;
      if (/\bprice\b/.test(blob) && !/compare at|original|strike|shipping|postage/i.test(blob)) s += 88;
      const tid = (inp.getAttribute("data-testid") || "").toLowerCase();
      if (tid.includes("price")) s += 58;
      const nm = (inp.name || "").toLowerCase();
      const id = (inp.id || "").toLowerCase();
      if (nm.includes("price") || id.includes("price")) s += 52;
      const al = (inp.getAttribute("aria-label") || "").toLowerCase();
      if (al.includes("price") && !al.includes("compare")) s += 48;
      if (s > bestSc) {
        bestSc = s;
        best = inp;
      }
    }

    if (!(best instanceof HTMLInputElement) || bestSc < 32) return { ok: false, step: "no_input", bestSc };

    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    const setV = (v) => {
      if (desc && desc.set) desc.set.call(best, v);
      else best.value = v;
    };

    best.focus();
    try {
      best.click();
    } catch {
      /* ignore */
    }
    setV("");
    best.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    for (let i = 0; i < strOut.length; i++) {
      const ch = strOut[i];
      setV((best.value || "") + ch);
      try {
        best.dispatchEvent(
          new InputEvent("input", { bubbles: true, composed: true, data: ch, inputType: "insertText" })
        );
      } catch {
        best.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      }
    }
    best.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    try {
      best.dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
    } catch {
      /* ignore */
    }
    const immediate = String(best.value || "").trim().toLowerCase();
    /** Some Vinted builds re-render the field a tick later (debounced price-suggestion fetch); verify it sticks. */
    await new Promise((resolve) => setTimeout(resolve, 400));
    const after = String(best.value || "").trim().toLowerCase();
    const ok = after.length > 0 && !/nan|infinity|undefined/.test(after);
    if (!ok) {
      /** Value reverted after our edit — site re-rendered over us. Re-apply once more without the blur/refocus dance. */
      setV(strOut);
      best.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      best.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const final = String(best.value || "").trim().toLowerCase();
    const finalOk = final.length > 0 && !/nan|infinity|undefined/.test(final);
    return { ok: finalOk, step: "set", bestSc, immediate, after, final };
  } catch (e) {
    return { ok: false, step: "throw", err: String(e && e.message ? e.message : e) };
  }
}

/**
 * MAIN world: eBay’s DESCRIPTION Lexical surface often ignores isolated-world synthetic events.
 * Same pattern as `vintedMainWorldSetPriceFunc` — runs in the page realm as the site’s React.
 */
function ebayMainWorldSetDescriptionFunc(text) {
  try {
    const t = String(text || "").trim();
    if (!t) return { ok: false, step: "empty" };

    function allDeep(sel, root) {
      const out = [];
      function go(n) {
        if (!n || !n.querySelectorAll) return;
        try {
          n.querySelectorAll(sel).forEach((e) => out.push(e));
        } catch {
          /* ignore */
        }
        try {
          n.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) go(el.shadowRoot);
          });
        } catch {
          /* ignore */
        }
      }
      go(root || document.documentElement || document.body);
      return out;
    }

    function visibleEnough(el) {
      if (!(el instanceof HTMLElement)) return false;
      let st;
      try {
        st = window.getComputedStyle(el);
      } catch {
        return false;
      }
      if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") return false;
      const r = el.getBoundingClientRect();
      return r.width >= 72 && r.height >= 24;
    }

    function fillTa(ta) {
      if (!(ta instanceof HTMLTextAreaElement) || ta.readOnly) return false;
      try {
        const desc = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value");
        if (desc && desc.set) desc.set.call(ta, t);
        else ta.value = t;
        ta.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } catch {
        return false;
      }
      return String(ta.value || "").trim().length > 0;
    }

    function fillCe(el) {
      if (!(el instanceof HTMLElement) || !el.isContentEditable) return false;
      try {
        el.focus();
      } catch {
        /* ignore */
      }
      const doc = el.ownerDocument;
      const view = doc.defaultView || window;
      try {
        const rng = doc.createRange();
        rng.selectNodeContents(el);
        const sel = view.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(rng);
        }
      } catch {
        /* ignore */
      }
      try {
        doc.execCommand("insertText", false, t);
      } catch {
        /* ignore */
      }
      if ((el.textContent || "").trim().length > 8) return true;
      try {
        el.textContent = "";
        const p = doc.createElement("p");
        p.textContent = t;
        el.appendChild(p);
        el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertParagraph" }));
      } catch {
        /* ignore */
      }
      return (el.textContent || "").trim().length > 8;
    }

    const taSels = [
      "#editpane_description",
      'textarea[name="description"]',
      'textarea[aria-label*="description" i]',
      'textarea[placeholder*="detailed description" i]',
      'textarea[placeholder*="let AI" i]',
      'textarea[placeholder*="save time" i]',
    ];
    for (const s of taSels) {
      for (const ta of allDeep(s, document.documentElement)) {
        if (fillTa(ta)) return { ok: true, step: "textarea" };
      }
    }

    for (const btn of allDeep("button,[role='button'],a", document.body)) {
      if (!(btn instanceof HTMLElement)) continue;
      const lab = (btn.textContent || "").replace(/\s+/g, " ").trim();
      if (!/use\s+ai\s+description/i.test(lab)) continue;
      let walk = btn.parentElement;
      for (let d = 0; d < 22 && walk; d++) {
        let best = null;
        let area = 0;
        let ces = [];
        try {
          ces = walk.querySelectorAll('[contenteditable="true"]');
        } catch {
          ces = [];
        }
        ces.forEach((ce) => {
          if (!(ce instanceof HTMLElement) || !ce.isContentEditable) return;
          if (btn.contains(ce)) return;
          if (!visibleEnough(ce)) return;
          const ar = ce.getBoundingClientRect();
          const a = ar.width * ar.height;
          if (a > area) {
            area = a;
            best = ce;
          }
        });
        if (best && fillCe(best)) return { ok: true, step: "ce_near_ai" };
        walk = walk.parentElement;
      }
    }

    for (const h of allDeep("h1,h2,h3,h4,span,div", document.body)) {
      if (!(h instanceof HTMLElement)) continue;
      const head = (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 96);
      if (!/\bDESCRIPTION\b/i.test(head)) continue;
      const sec = h.closest("section,form,main,article,[role='region'],div") || h.parentElement;
      if (!sec) continue;
      let best = null;
      let area = 0;
      let nodes = [];
      try {
        nodes = sec.querySelectorAll('[contenteditable="true"]');
      } catch {
        nodes = [];
      }
      nodes.forEach((ce) => {
        if (!(ce instanceof HTMLElement) || !ce.isContentEditable) return;
        if (!visibleEnough(ce)) return;
        const ar = ce.getBoundingClientRect();
        if (ar.height < 32 || ar.width < 80) return;
        const a = ar.width * ar.height;
        if (a > area) {
          area = a;
          best = ce;
        }
      });
      if (best && fillCe(best)) return { ok: true, step: "ce_section" };
    }

    for (const ce of allDeep(
      '[data-lexical-editor] [contenteditable="true"],[data-lexical-editor="true"] [contenteditable="true"]',
      document.documentElement
    )) {
      if (!(ce instanceof HTMLElement) || !ce.isContentEditable) continue;
      if (!visibleEnough(ce)) continue;
      const ar = ce.getBoundingClientRect();
      if (ar.height < 32 || ar.width < 100) continue;
      if (fillCe(ce)) return { ok: true, step: "ce_lexical" };
    }

    return { ok: false, step: "no_match" };
  } catch (e) {
    return { ok: false, step: "throw", err: String(e && e.message ? e.message : e) };
  }
}

function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        chrome.tabs.onUpdated.removeListener(listener);
      } catch {
        /* ignore */
      }
      resolve();
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(finish, 25000);
  });
}

const FILL_MSG = (payload, platform, tabId) => ({
  type: "SYNCLYST_FILL",
  payload,
  platform,
  auto_save: true,
  fill_source_tab_id: tabId,
});

/** Extension messages must be structured-clone safe; complex listing_extra can break sendResponse. */
function safeCloneForMessage(obj) {
  if (obj == null) return obj;
  try {
    return JSON.parse(JSON.stringify(obj));
  } catch {
    return null;
  }
}

/** JSON.stringify drops `undefined` keys — Magic Fill would lose title/price. Deep-clone listing_extra safely. */
function cloneFillPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return { title: "", description: "", price: "", listing_extra: undefined, image_url: "" };
  }
  let extra = payload.listing_extra;
  if (extra && typeof extra === "object") {
    try {
      extra = JSON.parse(JSON.stringify(extra));
    } catch {
      /* keep reference */
    }
  }
  let priceStr = payload.price != null ? String(payload.price).trim() : "";
  if (/^nan$/i.test(priceStr) || (typeof payload.price === "number" && !Number.isFinite(payload.price))) {
    priceStr = "";
  }
  return {
    title: payload.title != null ? String(payload.title) : "",
    description: payload.description != null ? String(payload.description) : "",
    price: priceStr,
    listing_extra: extra,
    image_url: payload.image_url != null ? String(payload.image_url) : "",
    copy_seo_title: payload.copy_seo_title != null ? String(payload.copy_seo_title) : "",
    copy_description: payload.copy_description != null ? String(payload.copy_description) : "",
  };
}

function scheduleActivateTab(tabId, delayMs) {
  setTimeout(() => {
    try {
      chrome.tabs.update(tabId, { active: true });
    } catch {
      /* ignore */
    }
  }, delayMs);
}

/**
 * Tabs opened before the extension loaded never got declarative content scripts — sendMessage
 * fails with "Receiving end does not exist". Inject once (content-script guards duplicate listeners).
 */
async function sendFillMessage(tabId, fillMsg) {
  const trySend = () => chrome.tabs.sendMessage(tabId, fillMsg);
  try {
    return await trySend();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Receiving end does not exist|Could not establish connection/i.test(msg)) {
      throw e;
    }
    let allFrames = false;
    try {
      const tab = await chrome.tabs.get(tabId);
      const u = String(tab && tab.url ? tab.url : "");
      if (tab && (/vinted\./i.test(u) || /ebay\./i.test(u))) allFrames = true;
    } catch {
      /* ignore */
    }
    await chrome.scripting.executeScript({
      target: { tabId, allFrames },
      files: ["mapper.js", "content-script.js"],
    });
    /** Shopify /new can mount late; first send often races right after load or our inject. */
    for (let i = 0; i < 8; i++) {
      try {
        return await trySend();
      } catch (e2) {
        const m2 = e2 instanceof Error ? e2.message : String(e2);
        if (!/Receiving end does not exist|Could not establish connection/i.test(m2)) {
          throw e2;
        }
        await sleep(200 + i * 120);
      }
    }
    throw e;
  }
}

/**
 * Injected fill + retries + optional Shopify “open new product” redirect.
 * Used by popup Magic Fill (Fill & save).
 */
async function runMagicFillPipeline(tabId, payload, platform) {
  const fillMsg = FILL_MSG(cloneFillPayload(payload), platform, tabId);
  try {
    let response = await sendFillMessage(tabId, fillMsg);
    if (response == null) {
      let last = response;
      for (let attempt = 0; attempt < 8; attempt++) {
        await sleep(600 + attempt * 200);
        try {
          const r = await sendFillMessage(tabId, fillMsg);
          last = r ?? last;
          response = r;
          if (response != null) break;
        } catch {
          /* keep retrying */
        }
      }
      if (response == null) response = last;
    }
    if (
      response &&
      response.filled === 0 &&
      platform === "shopify" &&
      response.shopify_page === "list" &&
      response.new_product_url
    ) {
      await chrome.tabs.update(tabId, { url: response.new_product_url });
      await waitForTabComplete(tabId);
      await sleep(2200);
      let last = null;
      for (let attempt = 0; attempt < 22; attempt++) {
        try {
          const r = await sendFillMessage(tabId, fillMsg);
          last = r ?? last;
          response = r;
          if (r && r.filled > 0) break;
        } catch {
          /* SPA still mounting */
        }
        await sleep(780);
      }
      if (response == null) response = last;
    }
    try {
      const cloned = safeCloneForMessage(response);
      await chrome.storage.local.set({
        synclyst_last_magic_fill_at: Date.now(),
        synclyst_last_magic_fill_platform: platform,
        synclyst_last_magic_fill_result: cloned || {
          ok: false,
          filled: typeof response?.filled === "number" ? response.filled : 0,
          platform,
          error: "Magic Fill completed but the result could not be stored.",
        },
      });
    } catch {
      /* ignore */
    }
    scheduleActivateTab(tabId, 550);
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    try {
      await chrome.storage.local.set({
        synclyst_last_magic_fill_at: Date.now(),
        synclyst_last_magic_fill_platform: platform,
        synclyst_last_magic_fill_result: {
          ok: false,
          platform,
          error:
            err ||
            "Could not reach that page — open the correct listing editor, refresh the tab if needed, then try again.",
        },
      });
    } catch {
      /* ignore */
    }
    scheduleActivateTab(tabId, 550);
  }
}

/**
 * Runs Magic Fill without focusing the tab first. Popup closes when the user switches
 * tabs; doing fill work here keeps the chain alive (see SYNCLYST_RUN_MAGIC_FILL).
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SYNCLYST_GET_SESSION") {
    ensureSessionId()
      .then((id) => sendResponse({ sessionId: id }))
      .catch(() => {
        try {
          sendResponse({ sessionId: null, error: "session_unavailable" });
        } catch {
          /* port closed */
        }
      });
    return true;
  }
  if (message?.type === "SYNCLYST_NEW_SESSION") {
    const id = genSessionId();
    chrome.storage.local.set({ snap_pair_session_id: id }, () => {
      try {
        chrome.action.setBadgeText({ text: "" });
        chrome.action.setTitle({ title: chrome.runtime.getManifest()?.name || "SyncLyst" });
      } catch {
        /* ignore */
      }
      try {
        sendResponse({ ok: true, sessionId: id });
      } catch {
        /* port closed */
      }
    });
    return true;
  }
  if (message?.type === "SYNCLYST_PING") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
  if (message?.type === "SYNCLYST_SNAP_PAIR_COMPLETE") {
    const tabId = _sender.tab?.id;
    (async () => {
      let originAuto = null;
      try {
        const u = _sender && _sender.tab && _sender.tab.url;
        if (u && /^https?:\/\//i.test(String(u))) {
          originAuto = new URL(String(u)).origin;
        }
      } catch {
        /* ignore */
      }
      // If the snap page reported a session ID (e.g. generated fresh on /snap without ?s=),
      // update storage so the popup polls the correct session and shows the right product.
      const incomingSessionId =
        message && typeof message.sessionId === "string" && /^[a-f0-9]{12,32}$/i.test(message.sessionId.trim())
          ? message.sessionId.trim()
          : null;
      try {
        await chrome.storage.local.set({
          synclyst_prefers_qr_home: false,
          synclyst_snap_listing_ready_at: Date.now(),
          /** Popup polls `/api/snap-pair/session/:id` on this origin — must match the /snap page (e.g. 127.0.0.1:3000). */
          ...(originAuto ? { synclyst_origin_auto: originAuto } : {}),
          /** Sync session ID from the snap page so popup always polls the right session. */
          ...(incomingSessionId ? { snap_pair_session_id: incomingSessionId } : {}),
        });
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
        await chrome.action.setBadgeText({ text: "!" });
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.setTitle({ title: "SyncLyst® — step 2: choose platform" });
      } catch {
        /* ignore */
      }
      try {
        if (tabId != null) {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        }
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.openPopup();
      } catch {
        /* User gesture may be required — badge + title still guide the user. */
      }
    })();
    return false;
  }
  if (message?.type === "SYNCLYST_VINTED_MAIN_PICK_CATEGORY") {
    const tabId = message.tabId ?? _sender.tab?.id;
    if (tabId == null) {
      try {
        sendResponse({ ok: false, reason: "no_tab" });
      } catch {
        /* ignore */
      }
      return false;
    }
    const segments = Array.isArray(message.segments) ? message.segments : [];
    const categoryStr = message.categoryStr != null ? String(message.categoryStr) : "";
    (async () => {
      let lastErr = "";
      let lastResults = null;
      for (const allFrames of [false, true]) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames },
            world: "MAIN",
            func: vintedMainWorldPickFunc,
            args: [segments, categoryStr],
          });
          lastResults = results;
          const ok = (results || []).some((r) => r && r.result && r.result.ok);
          if (ok) {
            sendResponse({ ok, allFrames, results: (results || []).map((r) => r && r.result) });
            return;
          }
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      try {
        sendResponse({
          ok: false,
          error: lastErr || "vinted_pick_no_match",
          results: (lastResults || []).map((r) => r && r.result),
        });
      } catch {
        /* ignore */
      }
    })();
    return true;
  }
  if (message?.type === "SYNCLYST_VINTED_MAIN_SET_PRICE") {
    const tabId = message.tabId ?? _sender.tab?.id;
    if (tabId == null) {
      try {
        sendResponse({ ok: false, reason: "no_tab" });
      } catch {
        /* ignore */
      }
      return false;
    }
    const ps = message.priceStr != null ? String(message.priceStr) : "";
    (async () => {
      let lastErr = "";
      let lastResults = null;
      for (const allFrames of [false, true]) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames },
            world: "MAIN",
            func: vintedMainWorldSetPriceFunc,
            args: [ps],
          });
          lastResults = results;
          const ok = (results || []).some((r) => r && r.result && r.result.ok);
          if (ok) {
            sendResponse({ ok: true, allFrames, results: (results || []).map((r) => r && r.result) });
            return;
          }
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      try {
        sendResponse({
          ok: false,
          error: lastErr || "vinted_price_main_no_match",
          results: (lastResults || []).map((r) => r && r.result),
        });
      } catch {
        /* ignore */
      }
    })();
    return true;
  }
  if (message?.type === "SYNCLYST_EBAY_MAIN_SET_DESCRIPTION") {
    const tabId = message.tabId ?? _sender.tab?.id;
    if (tabId == null) {
      try {
        sendResponse({ ok: false, reason: "no_tab" });
      } catch {
        /* ignore */
      }
      return false;
    }
    const txt = message.text != null ? String(message.text) : "";
    (async () => {
      let lastErr = "";
      let lastResults = null;
      for (const allFrames of [false, true]) {
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames },
            world: "MAIN",
            func: ebayMainWorldSetDescriptionFunc,
            args: [txt.slice(0, 48000)],
          });
          lastResults = results;
          const ok = (results || []).some((r) => r && r.result && r.result.ok);
          if (ok) {
            sendResponse({ ok: true, allFrames, results: (results || []).map((r) => r && r.result) });
            return;
          }
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
        }
      }
      try {
        sendResponse({
          ok: false,
          error: lastErr || "ebay_desc_main_no_match",
          results: (lastResults || []).map((r) => r && r.result),
        });
      } catch {
        /* ignore */
      }
    })();
    return true;
  }
  if (message?.type === "SYNCLYST_RUN_MAGIC_FILL") {
    const { tabId, payload, platform } = message;
    try {
      sendResponse({ ok: true, async: true, platform, message: "Magic Fill started" });
    } catch {
      /* popup may have closed already */
    }
    runMagicFillPipeline(tabId, payload, platform);
    return true;
  }
  /** Full review page saved listing — bring user back to the extension for Fill & save. */
  if (message?.type === "SYNCLYST_REVIEW_SAVED") {
    const tabId = _sender.tab?.id;
    (async () => {
      try {
        await chrome.storage.local.set({
          synclyst_snap_listing_ready_at: Date.now(),
        });
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
        await chrome.action.setBadgeText({ text: "!" });
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.setTitle({
          title: "SyncLyst® — open extension, then Fill & save on Shopify",
        });
      } catch {
        /* ignore */
      }
      try {
        if (tabId != null) {
          const tab = await chrome.tabs.get(tabId);
          if (tab.windowId != null) {
            await chrome.windows.update(tab.windowId, { focused: true });
          }
        }
      } catch {
        /* ignore */
      }
      try {
        await chrome.action.openPopup();
      } catch {
        /* User gesture may be required — badge + title still guide the user. */
      }
    })();
    return false;
  }
  return false;
});
