/* API origin: from repo root run `npm run extension:manifest` (store) or `npm run extension:manifest:dev` (local) — see extension/build-manifest.mjs. */
/* Store build: default host is synclyst.app (HTTPS). Prod CSP blocks loopback; use dev manifest for Next on port 3000. */
/* Dev build: default 127.0.0.1:3000. Override: chrome.storage.local key synclyst_origin, or open /snap on that host. */
function defaultSynclystOriginFromManifest() {
  try {
    const man = chrome.runtime.getManifest();
    const chunks = [...(man.host_permissions || [])];
    for (const cs of man.content_scripts || []) {
      for (const x of cs.matches || []) chunks.push(x);
    }
    const blob = chunks.join("\n");
    const devish =
      blob.includes("localhost") ||
      blob.includes("127.0.0.1") ||
      blob.includes("http://*/*");
    return devish ? "http://127.0.0.1:3000" : "https://synclyst.app";
  } catch {
    return "https://synclyst.app";
  }
}
const SYNCLYST_ORIGIN_DEFAULT = defaultSynclystOriginFromManifest();
const SYNCLYST_ORIGIN_LIVE = "https://synclyst.app";

/** When set (e.g. from /local-test), overrides automatic discovery. */
const STORAGE_ORIGIN_MANUAL = "synclyst_origin";

/** Last working auto origin (LAN or 127.0.0.1); cleared if it stops responding. */
const STORAGE_ORIGIN_AUTO = "synclyst_origin_auto";

/** Resolved after storage read — all fetches use this. */
let SYNCLYST_ORIGIN = SYNCLYST_ORIGIN_DEFAULT;

function getBillingOrigin() {
  // Billing + Clerk auth should always run on HTTPS to avoid cookie/session failures on LAN HTTP.
  return SYNCLYST_ORIGIN_LIVE.replace(/\/$/, "");
}

/**
 * Extension popups will stay blank forever if fetch() never settles (e.g. stalled TCP to a LAN IP).
 */
async function fetchWithTimeout(url, init = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(id);
  }
}

async function validateSnapPairOrigin(origin) {
  const base = String(origin || "").replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) return false;
  try {
    const r = await fetchWithTimeout(`${base}/api/snap-pair/config`, { cache: "no-store" }, 2200);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * If the user has SyncLyst open (e.g. `/snap?s=...` or `/extension-review?...`), prefer that same origin.
 * This avoids "extracted on snap page, empty in popup" when local dev uses in-memory sessions and the
 * popup falls back to a different reachable origin (cached LAN / live).
 */
async function pickOriginFromOpenSynclystTab() {
  const tryUrl = (raw) => {
    if (!raw) return null;
    try {
      const u = new URL(String(raw));
      const p = (u.pathname || "").replace(/\/$/, "");
      const okPath =
        p === "/snap" ||
        p === "/snap.html" ||
        p === "/extension-review" ||
        p.startsWith("/extension-review/");
      if (!okPath) return null;
      if (!/^https?:\/\//i.test(u.origin)) return null;
      return u.origin;
    } catch {
      return null;
    }
  };
  return new Promise((resolve) => {
    try {
      // All windows: `/snap` is often in another window while the user lists from Shopify/eBay.
      chrome.tabs.query({}, (tabs) => {
        try {
          const list = tabs || [];
          // Prefer the focused window’s active tab when it is snap/review (one active tab per window; pick first match).
          const active = list.find((t) => t && t.active);
          const fromActive = tryUrl(active && active.url);
          if (fromActive) return resolve(fromActive);
          for (const t of list) {
            const o = tryUrl(t && t.url);
            if (o) return resolve(o);
          }
        } catch {
          /* ignore */
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** WebRTC host candidates → IPv4 addresses (same machine as the extension). */
function gatherLanIPv4Candidates(maxMs) {
  return new Promise((resolve) => {
    const found = new Set();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      try {
        pc && pc.close();
      } catch {
        /* ignore */
      }
      resolve([...found]);
    };
    const t = setTimeout(done, maxMs);
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: [] });
      pc.createDataChannel("synclyst");
      pc
        .createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => {
          clearTimeout(t);
          done();
        });
      pc.onicecandidate = (e) => {
        if (!e || !e.candidate) return;
        const c = e.candidate.candidate || "";
        const parts = c.split(" ");
        for (const p of parts) {
          if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(p) && !p.startsWith("127.")) {
            found.add(p);
          }
        }
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") {
          clearTimeout(t);
          done();
        }
      };
    } catch {
      clearTimeout(t);
      done();
    }
  });
}

function lanIpSortKey(ip) {
  const p = String(ip).split(".").map((x) => parseInt(x, 10));
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return 99;
  if (p[0] === 192 && p[1] === 168) return 0;
  if (p[0] === 10) return 1;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return 2;
  return 3;
}

/**
 * Prefer a validated SyncLyst `/snap` (or review) tab origin when present — this is what makes local
 * phone→desktop E2E reliable even if `synclyst_origin` was previously set to production.
 * Next: manual `synclyst_origin` (if any), then a validated auto cache, then discovery
 * (127.0.0.1/localhost, then LAN for phone), else SYNCLYST_ORIGIN_DEFAULT.
 */
async function resolveSynclystOrigin() {
  const o = await storageGet([STORAGE_ORIGIN_MANUAL, STORAGE_ORIGIN_AUTO]);
  const manual = o[STORAGE_ORIGIN_MANUAL] != null ? String(o[STORAGE_ORIGIN_MANUAL]).trim() : "";
  const manualBase = manual && /^https?:\/\//i.test(manual) ? manual.replace(/\/$/, "") : "";

  // If SyncLyst is open in a tab, prefer that exact origin (especially for local /snap E2E).
  // A stale manual `synclyst_origin` pointing at production is a common footgun: it will make the
  // extension poll https://synclyst.app while the phone /snap page writes to local Next, so the modal
  // never populates. In that case, override + clear the manual key.
  const tabOrigin = await pickOriginFromOpenSynclystTab();
  if (tabOrigin) {
    const ok = await validateSnapPairOrigin(tabOrigin);
    if (ok) {
      const t = tabOrigin.replace(/\/$/, "");
      const isLocal =
        t.startsWith("http://127.0.0.1:") || t.startsWith("http://localhost:") || t.startsWith("http://[::1]:");
      if (manualBase) {
        const manualIsLocal =
          manualBase.startsWith("http://127.0.0.1:") ||
          manualBase.startsWith("http://localhost:") ||
          manualBase.startsWith("http://[::1]:");
        const manualIsLive = manualBase === SYNCLYST_ORIGIN_LIVE;
        // Phone snap on local Next + stale manual to prod (or any mismatch) → prefer the tab.
        if (manualBase !== t && (isLocal !== manualIsLocal)) {
          try {
            chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
              /* ignore */
            });
          } catch {
            /* ignore */
          }
        } else if (isLocal && manualIsLive) {
          // Open tab is local, manual points at production → always prefer local for dev flows.
          try {
            chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
              /* ignore */
            });
          } catch {
            /* ignore */
          }
        } else {
          // Manual matches reality — keep it.
        }
      }
      try {
        chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: t });
      } catch {
        /* ignore */
      }
      if (!manualBase || manualBase === t) {
        // manual absent or already aligned
        return t;
      }
      // If we didn't clear `manual` above, respect it.
      if (manualBase) {
        const mOk = await validateSnapPairOrigin(manualBase);
        if (mOk) return manualBase;
        try {
          chrome.storage.local.remove([STORAGE_ORIGIN_MANUAL], () => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
        return t;
      }
    }
  }

  if (manual && /^https?:\/\//i.test(manual)) {
    return manual.replace(/\/$/, "");
  }

  const cached = o[STORAGE_ORIGIN_AUTO] != null ? String(o[STORAGE_ORIGIN_AUTO]).trim() : "";
  if (cached && /^https?:\/\//i.test(cached)) {
    const base = cached.replace(/\/$/, "");
    if (await validateSnapPairOrigin(base)) {
      return base;
    }
    chrome.storage.local.remove([STORAGE_ORIGIN_AUTO]);
  }

  const ports = [3000, 3001, 3002];
  const localHosts = ["127.0.0.1", "localhost"];
  let portFound = null;
  let originLocal = null;
  for (const port of ports) {
    for (const host of localHosts) {
      const origin = `http://${host}:${port}`;
      if (await validateSnapPairOrigin(origin)) {
        portFound = port;
        originLocal = origin;
        break;
      }
    }
    if (portFound) break;
  }

  if (!portFound || !originLocal) {
    if (await validateSnapPairOrigin(SYNCLYST_ORIGIN_LIVE)) {
      const live = SYNCLYST_ORIGIN_LIVE.replace(/\/$/, "");
      try {
        chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: live });
      } catch {
        /* ignore */
      }
      return live;
    }
    return SYNCLYST_ORIGIN_DEFAULT;
  }

  const candidates = await gatherLanIPv4Candidates(900);
  candidates.sort((a, b) => lanIpSortKey(a) - lanIpSortKey(b) || String(a).localeCompare(String(b)));

  for (const ip of candidates) {
    const origin = `http://${ip}:${portFound}`;
    if (await validateSnapPairOrigin(origin)) {
      const clean = origin.replace(/\/$/, "");
      chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: clean });
      return clean;
    }
  }

  const fallback = originLocal.replace(/\/$/, "");
  chrome.storage.local.set({ [STORAGE_ORIGIN_AUTO]: fallback });
  return fallback;
}

let lastPayload = null;
/** Set in init after pairing session id is resolved (full-page review URL). */
let snapPairSessionId = null;
/** After first listing load; further updates with the same image preserve step 2 platform selection. */
let listingHydrated = false;
let lastAppliedImageUrl = null;
let pollTimer = null;
let realtimeChannel = null;
let supabaseClient = null;
/** When true, user chose “home” (QR screen); listing updates still apply in the background. */
let qrHomeActive = false;
/** Last `updated_at` (or stable fallback) we applied — avoids duplicate auto-advance + detects new scans. */
let lastAppliedListingStamp = null;
/** One-shot: skip auto-advance when re-applying an existing listing while restoring QR home from storage. */
/** When true, we just received a "new scan/upload" signal and are waiting for listing content. */
let extractionPending = false;
let extractionStartedAtMs = 0;
let extractionTickerId = null;

function fmtElapsedSeconds(startMs) {
  if (!startMs) return "0s";
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  return `${s}s`;
}

function elapsedSeconds(startMs) {
  if (!startMs) return 0;
  return Math.max(0, Math.floor((Date.now() - startMs) / 1000));
}

function extractionStepIndexFromStage(stage) {
  const s = String(stage || "").toLowerCase();
  if (!s) return 1;
  if (s.includes("upload received")) return 1;
  if (s.includes("processing image") || s.includes("checking status") || s.includes("reconnecting")) return 2;
  if (s.includes("waiting for extraction")) return 3;
  if (s.includes("finalizing")) return 4;
  if (s.includes("waiting for upload")) return 1;
  if (s.includes("extracting")) return 2;
  return 2;
}

function updateExtractionProgressUI(stage, secs) {
  const stepIdx = extractionStepIndexFromStage(stage);
  const metaEl = document.getElementById("review-loading-meta");
  if (metaEl) metaEl.textContent = `Step ${stepIdx}/4 · ${secs}s`;

  const stepEls = [
    { id: "extract-step-upload", idx: 1 },
    { id: "extract-step-process", idx: 2 },
    { id: "extract-step-draft", idx: 3 },
    { id: "extract-step-finalize", idx: 4 },
  ];
  for (const it of stepEls) {
    const el = document.getElementById(it.id);
    if (!el) continue;
    el.classList.toggle("is-done", it.idx < stepIdx);
  }

  const etaEl = document.getElementById("review-loading-eta");
  if (etaEl) {
    // Heuristic ETA: assume 55s typical, clamp.
    const assumedTotal = 55;
    const remaining = Math.max(6, Math.min(75, assumedTotal - secs));
    const remainingSteps =
      stepIdx >= 4
        ? "Finalizing…"
        : stepIdx === 3
          ? "What’s left: estimating price, finalizing."
          : stepIdx === 2
            ? "What’s left: drafting details, estimating price, finalizing."
            : "What’s left: processing image, drafting details, estimating price, finalizing.";
    etaEl.textContent = `${remainingSteps} ~${remaining}s left.`;
  }
}

function setReviewLoadingText(text) {
  const loadText = document.getElementById("review-loading-text");
  if (!loadText) return;
  loadText.textContent = String(text || "").trim();
}

function stopExtractionTicker() {
  if (extractionTickerId) {
    clearInterval(extractionTickerId);
    extractionTickerId = null;
  }
  extractionStartedAtMs = 0;
}

function startExtractionTicker(stage) {
  extractionStartedAtMs = Date.now();
  const st = String(stage || "Extracting your listing").trim() || "Extracting your listing";
  const render = () => {
    const secs = elapsedSeconds(extractionStartedAtMs);
    setReviewLoadingText(st);
    updateExtractionProgressUI(st, secs);
  };
  render();
  if (extractionTickerId) clearInterval(extractionTickerId);
  extractionTickerId = setInterval(render, 300);
}

function updateExtractionStage(stage) {
  if (!extractionPending) return;
  const st = String(stage || "").trim();
  if (!st) return;
  const secs = elapsedSeconds(extractionStartedAtMs);
  setReviewLoadingText(st);
  updateExtractionProgressUI(st, secs);
}

function refreshLoadedSubstate() {
  const waiting = document.getElementById("loaded-waiting");
  const main = document.getElementById("loaded-main");
  if (!waiting || !main) return;
  const hasListing = listingHydrated && sessionListingHasContent(lastPayload);
  // Only show the waiting screen when there is no listing and we're NOT actively extracting.
  const showWaiting = !hasListing && !extractionPending;
  waiting.classList.toggle("hidden", !showWaiting);
  main.classList.toggle("hidden", showWaiting);
}

/** Persisted in chrome.storage.local — survives popup close / Magic Fill / new scans. */
const STORAGE_LAST_PLATFORM = "synclyst_last_platform";
const STORAGE_PREFERS_QR_HOME = "synclyst_prefers_qr_home";
const STORAGE_SNAP_LISTING_READY_AT = "synclyst_snap_listing_ready_at";
const STORAGE_DRAFT_LIBRARY = "synclyst_draft_library_v1";
const STORAGE_DRAFT_LIBRARY_CLEARED_AT = "synclyst_draft_library_cleared_at_v1";
// Treat `synclyst_snap_listing_ready_at` as a short-lived "extraction in progress" signal.
// If it’s stale (e.g. user uploaded hours ago), don’t show “Extracting…” on every popup open.
const SNAP_LISTING_READY_MAX_AGE_MS = 2 * 60 * 1000;
const DRAFT_LIBRARY_MAX_ITEMS = 50;
const DRAFT_LIBRARY_THUMB_SIZE = 44;
/** Narrow popup: keep draft titles short so the library row doesn’t clip awkwardly. */
const LIBRARY_UI_TITLE_MAX_CHARS = 32;

function safeTrimStr(v) {
  return typeof v === "string" ? v.trim() : "";
}

function truncateLibraryTitle(s) {
  const t = safeTrimStr(s);
  if (!t) return "";
  const max = LIBRARY_UI_TITLE_MAX_CHARS;
  if (t.length <= max) return t;
  return `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

function fmtShortTime(ms) {
  if (!ms) return "";
  try {
    const d = new Date(ms);
    return d.toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

async function tryMakeThumbnailDataUrl(srcUrl) {
  const src = safeTrimStr(srcUrl);
  if (!src) return "";
  // Avoid creating thumbnails from remote URLs without CORS (canvas would be tainted).
  const looksRemote = /^https?:\/\//i.test(src);
  const looksInline = src.startsWith("data:") || src.startsWith("blob:");
  if (!looksInline && looksRemote) return "";

  return await new Promise((resolve) => {
    try {
      const img = new Image();
      // For inline data URLs this is unnecessary; for remote it only helps if server sends CORS.
      try {
        img.crossOrigin = "anonymous";
      } catch {
        /* ignore */
      }
      img.onload = () => {
        try {
          const w = img.naturalWidth || img.width || 0;
          const h = img.naturalHeight || img.height || 0;
          if (!w || !h) return resolve("");
          const size = DRAFT_LIBRARY_THUMB_SIZE;
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d");
          if (!ctx) return resolve("");
          // Cover crop (center)
          const scale = Math.max(size / w, size / h);
          const dw = Math.ceil(w * scale);
          const dh = Math.ceil(h * scale);
          const dx = Math.floor((size - dw) / 2);
          const dy = Math.floor((size - dh) / 2);
          ctx.drawImage(img, dx, dy, dw, dh);
          let out = "";
          try {
            out = canvas.toDataURL("image/jpeg", 0.72);
          } catch {
            out = "";
          }
          resolve(typeof out === "string" ? out : "");
        } catch {
          resolve("");
        }
      };
      img.onerror = () => resolve("");
      img.src = src;
    } catch {
      resolve("");
    }
  });
}

function readDraftLibrary() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_DRAFT_LIBRARY], (o) => {
        const raw = o && o[STORAGE_DRAFT_LIBRARY];
        const list = Array.isArray(raw) ? raw : [];
        resolve(list.filter((x) => x && typeof x === "object" && typeof x.sessionId === "string"));
      });
    } catch {
      resolve([]);
    }
  });
}

function readDraftLibraryClearedAt() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_DRAFT_LIBRARY_CLEARED_AT], (o) => {
        const raw = o && o[STORAGE_DRAFT_LIBRARY_CLEARED_AT];
        const n = typeof raw === "number" ? raw : Number(raw);
        resolve(Number.isFinite(n) ? n : 0);
      });
    } catch {
      resolve(0);
    }
  });
}

function writeDraftLibrary(list) {
  const safe = Array.isArray(list) ? list : [];
  try {
    chrome.storage.local.set({ [STORAGE_DRAFT_LIBRARY]: safe.slice(0, DRAFT_LIBRARY_MAX_ITEMS) });
  } catch {
    /* ignore */
  }
}

function updateLibraryBarUI(list) {
  const items = Array.isArray(list) ? list : [];
  const bar = document.getElementById("library-bar");
  if (bar) bar.classList.toggle("hidden", !items.length);
  if (!items.length) return;
  const countEl = document.getElementById("library-bar-count");
  if (countEl) countEl.textContent = String(items.length || 0);
  const subEl = document.getElementById("library-bar-sub");
  if (subEl) {
    const t0 = safeTrimStr(items[0] && items[0].title);
    const shown = t0 ? truncateLibraryTitle(t0) : "";
    subEl.textContent = shown || "Open a draft to post again";
    subEl.title = t0.length > LIBRARY_UI_TITLE_MAX_CHARS ? t0 : "";
  }

  const thumbEl = document.getElementById("library-bar-thumb");
  const fallbackEl = document.getElementById("library-bar-fallback");
  const thumbUrl = safeTrimStr(items[0] && items[0].imageUrl);
  if (thumbEl && thumbEl.tagName === "IMG") {
    const showThumb = !!thumbUrl;
    thumbEl.classList.toggle("hidden", !showThumb);
    if (showThumb) thumbEl.src = thumbUrl;
  }
  if (fallbackEl) fallbackEl.classList.toggle("hidden", !!thumbUrl);
}

function renderDraftLibraryOverlayUI(list) {
  const wrap = document.getElementById("library-overlay-list");
  const empty = document.getElementById("library-overlay-empty");
  const clearBtn = document.getElementById("btn-library-clear-overlay");
  if (!wrap) return;
  const items = Array.isArray(list) ? list : [];
  wrap.innerHTML = "";
  const has = items.length > 0;
  if (empty) empty.classList.toggle("hidden", has);
  if (clearBtn) clearBtn.classList.toggle("hidden", !has);
  for (const it of items.slice(0, DRAFT_LIBRARY_MAX_ITEMS)) {
    if (!it || typeof it !== "object") continue;
    const sid = safeTrimStr(it.sessionId);
    if (!sid) continue;

    const row = document.createElement("div");
    row.className = "settings-library-item";

    const meta = document.createElement("div");
    meta.className = "settings-library-item-meta";

    const thumbUrl = safeTrimStr(it.imageUrl);
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "settings-library-thumb";
      img.alt = "";
      img.decoding = "async";
      img.src = thumbUrl;
      meta.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "settings-library-thumb settings-library-thumb--placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.textContent = "—";
      meta.appendChild(ph);
    }

    const lines = document.createElement("div");
    lines.className = "settings-library-lines";
    const name = document.createElement("p");
    name.className = "settings-library-name";
    const rawName = safeTrimStr(it.title) || "Untitled draft";
    name.textContent = truncateLibraryTitle(rawName);
    if (rawName.length > LIBRARY_UI_TITLE_MAX_CHARS) name.title = rawName;
    const sub = document.createElement("p");
    sub.className = "settings-library-sub";
    const t = fmtShortTime(typeof it.updatedAtMs === "number" ? it.updatedAtMs : 0);
    sub.textContent = `${t || "—"} · ${sid}`;
    lines.appendChild(name);
    lines.appendChild(sub);
    meta.appendChild(lines);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "settings-library-open";
    openBtn.textContent = "Open";
    const cachedRow = (it.cachedRow && typeof it.cachedRow === "object") ? it.cachedRow : null;
    openBtn.addEventListener("click", (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {
        /* ignore */
      }
      openLibrarySession(sid, cachedRow);
    });

    row.appendChild(meta);
    row.appendChild(openBtn);
    row.addEventListener("click", () => openLibrarySession(sid, cachedRow));
    wrap.appendChild(row);
  }
}

async function upsertDraftLibraryItem(item) {
  const sid = safeTrimStr(item && item.sessionId);
  if (!sid) return;
  const clearedAt = await readDraftLibraryClearedAt();
  const itemMs =
    typeof item && item && typeof item.updatedAtMs === "number" && Number.isFinite(item.updatedAtMs)
      ? item.updatedAtMs
      : 0;
  // If the user just cleared drafts, don't immediately re-add the current/stale row on the next poll.
  // Only allow drafts newer than the clear action.
  if (clearedAt && itemMs && itemMs <= clearedAt) return;
  const next = {
    sessionId: sid,
    title: safeTrimStr(item && item.title) || "Untitled draft",
    updatedAtMs: typeof item.updatedAtMs === "number" && Number.isFinite(item.updatedAtMs) ? item.updatedAtMs : Date.now(),
    stamp: safeTrimStr(item && item.stamp),
    imageUrl: safeTrimStr(item && item.imageUrl),
    // Store full listing row so Open restores instantly from cache (no server round-trip).
    cachedRow: (item && item.cachedRow != null) ? item.cachedRow : undefined,
  };
  const list = await readDraftLibrary();
  const out = [next];
  // Deduplicate by sessionId — one entry per session, latest version wins.
  // Each phone scan produces a new session ID (synced via background.js SNAP_PAIR_COMPLETE),
  // so one scan = one entry. Older entries with the same session are replaced.
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const s0 = safeTrimStr(it.sessionId);
    if (!s0) continue;
    // Drop any older entry for the same session — `next` (at index 0) is already the latest.
    if (s0.toLowerCase() === sid.toLowerCase()) continue;
    out.push(it);
    if (out.length >= DRAFT_LIBRARY_MAX_ITEMS) break;
  }
  writeDraftLibrary(out);
  try {
    renderDraftLibraryUI(out);
    renderDraftLibraryOverlayUI(out);
    updateLibraryBarUI(out);
  } catch {
    /* ignore */
  }
}

function clearDraftLibrary() {
  try {
    const clearedAt = Date.now();
    chrome.storage.local.set({ [STORAGE_DRAFT_LIBRARY_CLEARED_AT]: clearedAt }, () => {
      /* ignore */
    });
    chrome.storage.local.remove([STORAGE_DRAFT_LIBRARY], () => {
      try {
        renderDraftLibraryUI([]);
        renderDraftLibraryOverlayUI([]);
        updateLibraryBarUI([]);
      } catch {
        /* ignore */
      }
    });
  } catch {
    try {
      renderDraftLibraryUI([]);
      renderDraftLibraryOverlayUI([]);
      updateLibraryBarUI([]);
    } catch {
      /* ignore */
    }
  }
}

function openLibrarySession(sessionId, cachedRow) {
  const sid = safeTrimStr(sessionId);
  if (!sid) return;

  // If we have cached listing data, restore instantly without a reload or server fetch.
  if (cachedRow && typeof cachedRow === "object") {
    try {
      chrome.storage.local.set({ snap_pair_session_id: sid, [STORAGE_PREFERS_QR_HOME]: false });
      snapPairSessionId = sid;
      // Pre-load the cached listing BEFORE continueToListing() so refreshLoadedSubstate()
      // sees a hydrated listing and goes straight to the listing screen (not the QR/waiting screen).
      lastPayload = cachedRow;
      listingHydrated = true;
      lastAppliedListingStamp = null;
      lastAppliedImageUrl = null;
      // Close the library overlay if open.
      try {
        const overlay = document.getElementById("library-overlay");
        if (overlay) overlay.classList.add("hidden");
      } catch { /* ignore */ }
      continueToListing();
      applyListing(cachedRow);
      return;
    } catch {
      /* fall through to reload if anything fails */
    }
  }

  // Fallback: reload and fetch from server.
  try {
    chrome.storage.local.set({ snap_pair_session_id: sid, [STORAGE_PREFERS_QR_HOME]: false }, () => {
      window.location.reload();
    });
  } catch {
    window.location.reload();
  }
}

function renderDraftLibraryUI(list) {
  const wrap = document.getElementById("library-list");
  const empty = document.getElementById("library-empty");
  const clearBtn = document.getElementById("btn-library-clear");
  if (!wrap) return;
  const items = Array.isArray(list) ? list : [];
  wrap.innerHTML = "";
  const has = items.length > 0;
  if (empty) empty.classList.toggle("hidden", has);
  if (clearBtn) clearBtn.classList.toggle("hidden", !has);
  for (const it of items.slice(0, DRAFT_LIBRARY_MAX_ITEMS)) {
    if (!it || typeof it !== "object") continue;
    const sid = safeTrimStr(it.sessionId);
    if (!sid) continue;
    const row = document.createElement("div");
    row.className = "settings-library-item";

    const meta = document.createElement("div");
    meta.className = "settings-library-item-meta";

    const thumbUrl = safeTrimStr(it.imageUrl);
    if (thumbUrl) {
      const img = document.createElement("img");
      img.className = "settings-library-thumb";
      img.alt = "";
      img.decoding = "async";
      img.src = thumbUrl;
      meta.appendChild(img);
    } else {
      const ph = document.createElement("div");
      ph.className = "settings-library-thumb settings-library-thumb--placeholder";
      ph.setAttribute("aria-hidden", "true");
      ph.textContent = "—";
      meta.appendChild(ph);
    }

    const lines = document.createElement("div");
    lines.className = "settings-library-lines";
    const name = document.createElement("p");
    name.className = "settings-library-name";
    const rawName = safeTrimStr(it.title) || "Untitled draft";
    name.textContent = truncateLibraryTitle(rawName);
    if (rawName.length > LIBRARY_UI_TITLE_MAX_CHARS) name.title = rawName;
    const sub = document.createElement("p");
    sub.className = "settings-library-sub";
    const t = fmtShortTime(typeof it.updatedAtMs === "number" ? it.updatedAtMs : 0);
    sub.textContent = `${t || "—"} · ${sid}`;
    lines.appendChild(name);
    lines.appendChild(sub);
    meta.appendChild(lines);

    const openBtn = document.createElement("button");
    openBtn.type = "button";
    openBtn.className = "settings-library-open";
    openBtn.textContent = "Open";
    const cachedRowNonOverlay = (it.cachedRow && typeof it.cachedRow === "object") ? it.cachedRow : null;
    openBtn.addEventListener("click", (e) => {
      try {
        e.preventDefault();
        e.stopPropagation();
      } catch {
        /* ignore */
      }
      openLibrarySession(sid, cachedRowNonOverlay);
    });

    row.appendChild(meta);
    row.appendChild(openBtn);
    row.addEventListener("click", () => openLibrarySession(sid, cachedRowNonOverlay));
    wrap.appendChild(row);
  }
}

let libraryOverlayWired = false;
function wireLibraryOverlay() {
  if (libraryOverlayWired) return;
  libraryOverlayWired = true;
  const overlay = document.getElementById("library-overlay");
  const openBtn = document.getElementById("btn-open-library");
  const closeBtn = document.getElementById("btn-library-close");
  const clearBtn = document.getElementById("btn-library-clear-overlay");

  const open = () => {
    void readDraftLibrary().then((list) => {
      renderDraftLibraryOverlayUI(list);
      updateLibraryBarUI(list);
      overlay?.classList.remove("hidden");
    });
  };
  const close = () => {
    overlay?.classList.add("hidden");
  };

  openBtn?.addEventListener("click", (e) => {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    open();
  });
  closeBtn?.addEventListener("click", (e) => {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    close();
  });
  clearBtn?.addEventListener("click", (e) => {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    clearDraftLibrary();
    close();
    showToast("Drafts cleared.", "success", 1400);
  });
}

/** Same keys as auralink-ai/frontend/public/payment-success.html → tier-bridge.js → chrome.storage.local */
const STORAGE_SYNC_TIER = "synclyst_tier";
const STORAGE_PLAN_RENEWAL = "synclyst_plan_renewal";
/** Last tapped plan row in Settings → Payments (selection highlight + billing deep link). */
const STORAGE_PREF_BILLING_TIER = "synclyst_pref_billing_tier";
/** Signed-in status for billing UI (derived from synclyst.app Clerk cookies). */
let billingSignedIn = null;
let billingEmail = "";

/** tier-bridge.js mirrors these from synclyst.app localStorage into chrome.storage.local. */
const STORAGE_BILLING_SIGNED_IN = "synclyst_signed_in";
const STORAGE_BILLING_EMAIL = "synclyst_email";
const STORAGE_BILLING_AUTH_AT = "synclyst_auth_at";

function readBillingAuthFromStorage() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([STORAGE_BILLING_SIGNED_IN, STORAGE_BILLING_EMAIL, STORAGE_BILLING_AUTH_AT], (o) => {
        const raw = o && o[STORAGE_BILLING_SIGNED_IN] != null ? String(o[STORAGE_BILLING_SIGNED_IN]) : "";
        const signedIn = raw === "1" || raw.toLowerCase() === "true";
        const email = o && typeof o[STORAGE_BILLING_EMAIL] === "string" ? String(o[STORAGE_BILLING_EMAIL]).trim() : "";
        const authAtRaw = o && o[STORAGE_BILLING_AUTH_AT] != null ? String(o[STORAGE_BILLING_AUTH_AT]) : "";
        const authAt = authAtRaw && /^\d+$/.test(authAtRaw) ? Number(authAtRaw) : 0;
        resolve({ signedIn, email, authAt });
      });
    } catch {
      resolve({ signedIn: false, email: "", authAt: 0 });
    }
  });
}

// ---- Settings diagnostics (for support + debugging) ----
let diagLastConfig = { configured: null };
let diagLastPoll = { atMs: 0, status: null, ok: null, error: "" };

function fmtDiagTime(ms) {
  if (!ms) return "";
  try {
    const d = new Date(ms);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
}

function refreshSettingsDiagnosticsUI() {
  try {
    const originEl = document.getElementById("diag-origin");
    const originSrcEl = document.getElementById("diag-origin-src");
    const sessionEl = document.getElementById("diag-session");
    const viewEl = document.getElementById("diag-view");
    const platformEl = document.getElementById("diag-platform");
    const versionEl = document.getElementById("diag-version");
    const configEl = document.getElementById("diag-config");
    const billEl = document.getElementById("diag-billing");
    const rtEl = document.getElementById("diag-realtime");
    const exEl = document.getElementById("diag-extraction");
    const stampEl = document.getElementById("diag-stamp");
    const fieldsEl = document.getElementById("diag-fields");
    const draftsEl = document.getElementById("diag-drafts");
    const pollEl = document.getElementById("diag-poll");
    if (originEl) originEl.textContent = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "") || "—";
    if (originSrcEl) {
      chrome.storage.local.get([STORAGE_ORIGIN_MANUAL, STORAGE_ORIGIN_AUTO], (o) => {
        const manual = o && o[STORAGE_ORIGIN_MANUAL] != null ? String(o[STORAGE_ORIGIN_MANUAL]).trim() : "";
        const auto = o && o[STORAGE_ORIGIN_AUTO] != null ? String(o[STORAGE_ORIGIN_AUTO]).trim() : "";
        originSrcEl.textContent = manual ? "manual" : auto ? "auto" : "default";
      });
    }
    if (sessionEl) sessionEl.textContent = snapPairSessionId ? String(snapPairSessionId) : "—";
    if (viewEl) viewEl.textContent = qrHomeActive ? "QR home" : "Listing";
    if (platformEl) platformEl.textContent = getSelectedPlatform() ? String(getSelectedPlatform()) : "—";
    if (versionEl) {
      try {
        const man = typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest() : null;
        versionEl.textContent = man && man.version ? String(man.version) : "—";
      } catch {
        versionEl.textContent = "—";
      }
    }
    if (configEl) {
      const c = diagLastConfig && typeof diagLastConfig.configured === "boolean" ? diagLastConfig.configured : null;
      configEl.textContent = c === null ? "—" : c ? "configured ✅" : "not configured ❌";
    }
    if (billEl) {
      if (billingSignedIn === null) billEl.textContent = "checking…";
      else billEl.textContent = billingSignedIn ? `signed in${billingEmail ? ` · ${billingEmail}` : ""}` : "signed out";
    }
    if (rtEl) rtEl.textContent = supabaseClient && realtimeChannel ? "connected ✅" : "off";
    if (exEl) {
      if (extractionPending) exEl.textContent = `in progress · ${fmtElapsedSeconds(extractionStartedAtMs)}`;
      else exEl.textContent = "idle";
    }
    if (stampEl) stampEl.textContent = lastAppliedListingStamp ? String(lastAppliedListingStamp).slice(0, 26) : "—";
    if (fieldsEl) {
      const p = lastPayload && typeof lastPayload === "object" ? lastPayload : null;
      if (!p) fieldsEl.textContent = "—";
      else {
        const hasT = !!(p.title && String(p.title).trim());
        const hasD = !!(p.description && String(p.description).trim());
        const hasP = !!(p.price && String(p.price).trim());
        const hasI = !!(p.image_url && String(p.image_url).trim());
        fieldsEl.textContent = `${hasT ? "T" : "—"} ${hasD ? "D" : "—"} ${hasP ? "£" : "—"} ${hasI ? "IMG" : "—"}`;
      }
    }
    if (draftsEl) {
      void readDraftLibrary().then((list) => {
        draftsEl.textContent = Array.isArray(list) ? String(list.length) : "0";
      });
    }
    if (pollEl) {
      if (!diagLastPoll.atMs) {
        pollEl.textContent = "—";
      } else {
        const t = fmtDiagTime(diagLastPoll.atMs);
        const s = diagLastPoll.status != null ? `HTTP ${diagLastPoll.status}` : diagLastPoll.ok ? "OK" : "ERR";
        const extra = diagLastPoll.error ? ` · ${String(diagLastPoll.error).slice(0, 40)}` : "";
        pollEl.textContent = `${t} · ${s}${extra}`;
      }
    }
  } catch {
    /* ignore */
  }
}

async function copySettingsDiagnostics() {
  try {
    const origin = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    const sid = snapPairSessionId ? String(snapPairSessionId) : "";
    const view = qrHomeActive ? "qr_home" : "listing";
    const platform = getSelectedPlatform() ? String(getSelectedPlatform()) : "";
    const rt = supabaseClient && realtimeChannel ? "connected" : "off";
    const extracting = extractionPending ? `in_progress_${fmtElapsedSeconds(extractionStartedAtMs)}` : "idle";
    const stamp = lastAppliedListingStamp ? String(lastAppliedListingStamp).slice(0, 60) : "";
    const man = (() => {
      try {
        return typeof chrome.runtime.getManifest === "function" ? chrome.runtime.getManifest() : null;
      } catch {
        return null;
      }
    })();
    const version = man && man.version ? String(man.version) : "";
    const bill =
      billingSignedIn === null ? "checking" : billingSignedIn ? `signed_in${billingEmail ? `_${billingEmail}` : ""}` : "signed_out";
    const fields = (() => {
      const p = lastPayload && typeof lastPayload === "object" ? lastPayload : null;
      if (!p) return "";
      const hasT = !!(p.title && String(p.title).trim());
      const hasD = !!(p.description && String(p.description).trim());
      const hasP = !!(p.price && String(p.price).trim());
      const hasI = !!(p.image_url && String(p.image_url).trim());
      return `${hasT ? "T" : "-"}${hasD ? "D" : "-"}${hasP ? "P" : "-"}${hasI ? "I" : "-"}`;
    })();
    const originSrc = await storageGet([STORAGE_ORIGIN_MANUAL, STORAGE_ORIGIN_AUTO]).then((o) => {
      const manual = o && o[STORAGE_ORIGIN_MANUAL] != null ? String(o[STORAGE_ORIGIN_MANUAL]).trim() : "";
      const auto = o && o[STORAGE_ORIGIN_AUTO] != null ? String(o[STORAGE_ORIGIN_AUTO]).trim() : "";
      return manual ? "manual" : auto ? "auto" : "default";
    });
    const drafts = await readDraftLibrary().then((l) => (Array.isArray(l) ? String(l.length) : "0"));
    const cfg =
      diagLastConfig && typeof diagLastConfig.configured === "boolean"
        ? String(diagLastConfig.configured)
        : "unknown";
    const pollT = diagLastPoll.atMs ? fmtDiagTime(diagLastPoll.atMs) : "—";
    const pollS = diagLastPoll.status != null ? String(diagLastPoll.status) : diagLastPoll.ok ? "ok" : "error";
    const pollE = diagLastPoll.error ? String(diagLastPoll.error).slice(0, 120) : "";
    const text = [
      "SyncLyst diagnostics",
      `origin=${origin || "—"}`,
      `origin_source=${originSrc || "—"}`,
      `session_id=${sid || "—"}`,
      `view=${view || "—"}`,
      `platform=${platform || "—"}`,
      `extension_version=${version || "—"}`,
      `snap_pair_configured=${cfg}`,
      `billing=${bill || "—"}`,
      `realtime=${rt || "—"}`,
      `extraction=${extracting || "—"}`,
      `listing_stamp=${stamp || "—"}`,
      `listing_fields=${fields || "—"}`,
      `drafts=${drafts || "—"}`,
      `last_poll=${pollT} (${pollS})${pollE ? ` ${pollE}` : ""}`,
    ].join("\n");
    await navigator.clipboard.writeText(text);
    setBillingMsg("Copied diagnostics.");
    setTimeout(() => setBillingMsg(""), 1400);
  } catch {
    setBillingMsg("Couldn’t copy diagnostics.");
    setTimeout(() => setBillingMsg(""), 1600);
  }
}

function setBillingMsg(text) {
  const el = document.getElementById("settings-billing-msg");
  if (!el) return;
  const msg = String(text || "").trim();
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (o) => resolve(o || {}));
  });
}

function normalizeBillingTier(raw) {
  const t = raw != null ? String(raw).trim().toLowerCase() : "";
  return t === "pro" || t === "growth" || t === "scale" || t === "starter" ? t : "starter";
}

function billingTierLabel(tier) {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

function refreshSettingsTierDisplay() {
  try {
    chrome.storage.local.get(
      [STORAGE_SYNC_TIER, STORAGE_PLAN_RENEWAL, STORAGE_PREF_BILLING_TIER],
      (o) => {
        const current = normalizeBillingTier(o && o[STORAGE_SYNC_TIER]);
        const strong = document.getElementById("settings-current-tier");
        const hint = document.getElementById("settings-tier-hint");
        if (strong) strong.textContent = billingTierLabel(current);
        if (hint) {
          const renewal = o && o[STORAGE_PLAN_RENEWAL] != null ? String(o[STORAGE_PLAN_RENEWAL]).trim() : "";
          hint.textContent = renewal ? ` · Renews ~${renewal}` : "";
        }
        const prefRaw = o && o[STORAGE_PREF_BILLING_TIER];
        const pref =
          prefRaw != null && String(prefRaw).trim() !== "" ? normalizeBillingTier(prefRaw) : current;
        document.querySelectorAll("#settings-plan-grid .settings-plan-row[data-billing-tier]").forEach((el) => {
          const t = String(el.dataset.billingTier).toLowerCase();
          el.classList.toggle("is-selected", t === pref);
          el.classList.toggle("is-current", t === current);
          el.setAttribute("aria-checked", t === pref ? "true" : "false");

          // Current plan button should never be clickable.
          const btn = el.querySelector && el.querySelector(".settings-plan-open[data-billing-tier]");
          if (btn) {
            if (t === current) {
              btn.disabled = true;
              btn.classList.add("is-disabled");
              btn.setAttribute("aria-disabled", "true");
              btn.textContent = "Current";
            } else if (t === "starter") {
              // Starter is the only non-paid tier; keep its CTA copy.
              btn.disabled = false;
              btn.classList.remove("is-disabled");
              btn.removeAttribute("aria-disabled");
              btn.textContent = "Free signup";
            } else {
              // Paid tier buttons are handled by refreshSettingsBillingAuthUI (sign-in gating / upgrade copy).
              btn.disabled = false;
              btn.removeAttribute("aria-disabled");
            }
          }
        });
      }
    );
  } catch {
    /* ignore */
  }
}

function setPrefBillingTier(tier) {
  const t = normalizeBillingTier(tier);
  try {
    chrome.storage.local.set({ [STORAGE_PREF_BILLING_TIER]: t }, () => refreshSettingsTierDisplay());
  } catch {
    refreshSettingsTierDisplay();
  }
}

async function fetchBillingAuthSummary() {
  try {
    const base = getBillingOrigin();
    const r = await fetchWithTimeout(
      `${base}/api/clerk/user-summary`,
      { credentials: "include", cache: "no-store" },
      7000
    );
    if (!r.ok) return { signedIn: false };
    const j = await r.json().catch(() => ({}));
    return j && typeof j === "object" ? j : { signedIn: false };
  } catch {
    return { signedIn: false };
  }
}

function refreshSettingsBillingAuthUI() {
  const authCard = document.getElementById("settings-auth");
  const title = document.getElementById("settings-auth-title");
  const sub = document.getElementById("settings-auth-sub");
  const pill = document.getElementById("settings-auth-pill");
  const btn = document.getElementById("btn-settings-signin");
  const signed = !!billingSignedIn;
  if (authCard) authCard.classList.remove("hidden");
  if (pill) {
    pill.textContent =
      billingSignedIn === null
        ? "Checking sign-in…"
        : signed
          ? `Signed in${billingEmail ? ` · ${billingEmail}` : ""}`
          : "Signed out";
  }
  if (title) {
    title.textContent =
      billingSignedIn === null ? "Checking sign-in…" : signed ? "Signed in" : "Sign in to upgrade";
  }
  if (sub) {
    sub.textContent = signed
      ? "You can upgrade in one click."
      : "Your plan is linked to your SyncLyst account. Sign in once, then upgrade in one click.";
  }
  if (btn) {
    btn.textContent = signed ? "Log out" : "Sign in";
  }
  if (btn) btn.disabled = false;

  const planGrid = document.getElementById("settings-plan-grid");
  if (planGrid) {
    planGrid.classList.toggle("is-locked", billingSignedIn === false);
  }

  // Disable paid upgrade buttons until signed in.
  document.querySelectorAll(".settings-plan-open[data-billing-tier]").forEach((el) => {
    const tier = String(el.dataset.billingTier || "").toLowerCase();
    const isPaid = tier === "pro" || tier === "growth" || tier === "scale";
    if (!isPaid) return;
    const b = el;
    if (signed) {
      b.disabled = false;
      b.classList.remove("is-disabled");
      b.textContent = "Upgrade";
    } else {
      b.disabled = true;
      b.classList.add("is-disabled");
      b.textContent = "Sign in to upgrade";
    }
  });
}

async function refreshSettingsBillingAuthState() {
  // Show the auth card immediately while we check cookies.
  billingSignedIn = null;
  billingEmail = "";
  refreshSettingsBillingAuthUI();
  setBillingMsg("");
  const [net, stored] = await Promise.all([fetchBillingAuthSummary(), readBillingAuthFromStorage()]);
  const netSigned = !!(net && net.signedIn);
  const storedFresh = !!(stored && stored.authAt && Date.now() - stored.authAt < 10 * 60 * 1000);

  billingSignedIn = netSigned || (!!stored && stored.signedIn && storedFresh);
  billingEmail =
    (netSigned && typeof net.email === "string" ? String(net.email).trim() : "") ||
    (billingSignedIn && stored && stored.email ? String(stored.email).trim() : "");

  refreshSettingsBillingAuthUI();
  if (!netSigned && billingSignedIn) {
    setBillingMsg("Signed in via synclyst.app. If it doesn’t update, open the Sign in tab once and come back.");
  }
}

async function startStripeCheckoutFromPopup(tier) {
  const t = String(tier || "").toLowerCase();
  if (t !== "pro" && t !== "growth" && t !== "scale") return;
  try {
    setBillingMsg("Opening secure checkout…");
    const base = getBillingOrigin();
    if (!base) return;
    const origin = base;
    const r = await fetchWithTimeout(
      `${base}/api/billing/checkout-direct`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          tier: t,
          success_url: `${origin}/extension-return?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${origin}/extension-return?canceled=1&tier=${encodeURIComponent(t)}`,
        }),
      },
      20000
    );
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 401) {
        billingSignedIn = false;
        billingEmail = "";
        refreshSettingsBillingAuthUI();
        setBillingMsg("You’re signed out. Click “Sign in”, then try again.");
        return;
      }
      if (r.status === 404 || r.status === 405) {
        // Most common in production when the latest Next deploy isn't live yet.
        setBillingMsg("Billing update not live yet. Redeploy synclyst.app, then try again.");
        return;
      }
      const detail = body && typeof body.detail === "string" ? body.detail : "";
      setBillingMsg(detail ? `Could not start checkout. ${detail}` : "Could not start checkout. Try again.");
      return;
    }
    const url = body && typeof body.url === "string" ? body.url : "";
    if (!url) {
      setBillingMsg("Checkout did not return a Stripe URL. Try again.");
      return;
    }
    chrome.tabs.create({ url });
  } catch {
    setBillingMsg("Network error starting checkout. Try again.");
  }
}

function openAutostartCheckoutTabForTier(tier) {
  const t = String(tier || "").toLowerCase();
  if (t !== "pro" && t !== "growth" && t !== "scale") return;
  try {
    const base = getBillingOrigin();
    if (!base) return;
    // Avoid extension cookie issues by using a first-party redirect endpoint.
    chrome.tabs.create({ url: `${base}/api/billing/checkout-redirect?tier=${encodeURIComponent(t)}` });
  } catch {
    /* ignore */
  }
}

function openBillingTabForTier(tier) {
  const t = String(tier).toLowerCase();
  let url;
  try {
    const base = getBillingOrigin();
    if (!base) return;
    if (t === "starter") {
      // Use extension-friendly redirect targets (never dashboard).
      url = `${base}/sign-up?redirect_url=${encodeURIComponent("/extension-return?auth=1")}&after_sign_up_url=${encodeURIComponent("/extension-return?auth=1")}`;
    } else if (t === "pro" || t === "growth" || t === "scale") {
      // After signing in, send users to a lightweight "back to extension" page (not dashboard).
      url = `${base}/sign-in?redirect_url=${encodeURIComponent("/extension-return?auth=1")}&after_sign_in_url=${encodeURIComponent("/extension-return?auth=1")}`;
    } else {
      return;
    }
  } catch {
    return;
  }
  try {
    chrome.tabs.create({ url });
  } catch {
    /* ignore */
  }
}

function legalPathForKind(kind) {
  const k = String(kind || "").toLowerCase();
  if (k === "terms") return "/terms";
  if (k === "privacy") return "/privacy";
  return null;
}

function openLegalDocExternal(kind) {
  const path = legalPathForKind(kind);
  if (!path) return;
  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) return;
    chrome.tabs.create({ url: `${base}${path}` });
  } catch {
    /* ignore */
  }
}

/** Stuck-together plain text (e.g. one innerText blob) → rough paragraphs. */
function fallbackFormatLegalWall(txt) {
  let s = String(txt || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!s) return "";
  // "PolicyLast" / "2026SyncLyst" style boundaries
  s = s.replace(/([a-z\d\)])([A-Z][a-z])/g, "$1\n\n$2");
  s = s.replace(/([.!?])(\d+\.\s+)/g, "$1\n\n$2");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Prefer structured text from the page DOM (headings, paragraphs, list items).
 * Flat innerText on <main> often collapses Next/Tailwind pages into one wall of text.
 */
function extractFormattedLegalTextFromDoc(doc) {
  const root =
    doc.querySelector("main") || doc.querySelector("[role='main']") || doc.querySelector("article") || doc.body;
  if (!root) return "";

  const nodes = Array.from(root.querySelectorAll("h1, h2, h3, h4, p, li"));

  function skipFooterLink(el) {
    if (!el || el.tagName !== "P") return false;
    const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    return t.startsWith("←") || t.includes("back to home") || t.includes("back to synclyst");
  }

  function oneLine(el) {
    return (el.textContent || "").replace(/\s+/g, " ").trim();
  }

  const out = [];
  let i = 0;
  while (i < nodes.length) {
    const el = nodes[i];
    if (skipFooterLink(el)) {
      i += 1;
      continue;
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "li") {
      while (i < nodes.length && nodes[i].tagName.toLowerCase() === "li") {
        if (!skipFooterLink(nodes[i])) {
          const t = oneLine(nodes[i]);
          if (t) out.push(`• ${t}`);
        }
        i += 1;
      }
      out.push("");
      continue;
    }
    const t = oneLine(el);
    if (t) {
      if (tag === "h1") out.push(t, "");
      else if (tag === "h2" || tag === "h3" || tag === "h4") out.push(t, "");
      else out.push(t, "");
    }
    i += 1;
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n").trim();
}

async function loadLegalDocIntoModal(kind) {
  const path = legalPathForKind(kind);
  if (!path) return;

  const overlay = document.getElementById("settings-overlay");
  const titleEl = document.getElementById("settings-title");
  const mainScroll = document.getElementById("settings-scroll");
  const legalScroll = document.getElementById("legal-scroll");
  const loadingEl = document.getElementById("legal-loading");
  const textEl = document.getElementById("legal-text");
  const openExternalBtn = document.getElementById("btn-legal-open-external");

  const label = kind === "privacy" ? "Privacy Policy" : "Terms & Conditions";
  if (titleEl) titleEl.textContent = label;
  mainScroll?.classList.add("hidden");
  legalScroll?.classList.remove("hidden");
  overlay?.classList.remove("hidden");

  if (loadingEl) loadingEl.textContent = "Loading…";
  loadingEl?.classList.remove("hidden");
  textEl?.classList.add("hidden");
  if (textEl) textEl.textContent = "";
  openExternalBtn?.classList.remove("hidden");

  if (openExternalBtn) {
    openExternalBtn.onclick = () => openLegalDocExternal(kind);
  }

  try {
    const base = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
    if (!base) throw new Error("Missing origin");
    const url = `${base}${path}`;
    const r = await fetchWithTimeout(url, { cache: "no-store" }, 9000);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();

    let extracted = "";
    try {
      const doc = new DOMParser().parseFromString(String(html), "text/html");
      extracted = extractFormattedLegalTextFromDoc(doc);
      if (!extracted) {
        const preferred =
          doc.querySelector("main") ||
          doc.querySelector("[role='main']") ||
          doc.querySelector("article") ||
          doc.body;
        const wall = preferred ? String(preferred.innerText || "").trim() : "";
        extracted = wall ? fallbackFormatLegalWall(wall) : "";
      }
    } catch {
      extracted = "";
    }

    if (!extracted) {
      extracted = "Couldn’t extract readable text in the popup. Use “Open in browser”.";
    }

    if (textEl) textEl.textContent = extracted;
    textEl?.classList.remove("hidden");
    loadingEl?.classList.add("hidden");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (loadingEl) loadingEl.textContent = `Couldn’t load right now (${msg}). Use “Open in browser”.`;
    if (textEl) textEl.textContent = "";
    textEl?.classList.add("hidden");
    openExternalBtn?.classList.remove("hidden");
  }
}

function closeLegalDocModalIfOpen() {
  const legalScroll = document.getElementById("legal-scroll");
  const mainScroll = document.getElementById("settings-scroll");
  const titleEl = document.getElementById("settings-title");
  if (!legalScroll || legalScroll.classList.contains("hidden")) return false;
  legalScroll.classList.add("hidden");
  mainScroll?.classList.remove("hidden");
  if (titleEl) titleEl.textContent = "Settings";
  return true;
}

let billingSettingsWired = false;
function wireBillingSettings() {
  if (billingSettingsWired) return;
  billingSettingsWired = true;
  refreshSettingsTierDisplay();

  function collapseOtherPlanDetails(exceptTier) {
    try {
      document
        .querySelectorAll("#settings-plan-grid .settings-plan-row.is-expanded[data-billing-tier]")
        .forEach((el) => {
          const t = String(el.dataset.billingTier || "").toLowerCase();
          if (exceptTier && t === exceptTier) return;
          el.classList.remove("is-expanded");
          el.setAttribute("aria-expanded", "false");
        });
    } catch {
      /* ignore */
    }
  }

  function togglePlanDetails(rowEl) {
    if (!rowEl) return;
    const tier = String(rowEl.dataset.billingTier || "").toLowerCase();
    const next = !rowEl.classList.contains("is-expanded");
    collapseOtherPlanDetails(next ? tier : "");
    rowEl.classList.toggle("is-expanded", next);
    rowEl.setAttribute("aria-expanded", next ? "true" : "false");
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (
      !changes[STORAGE_SYNC_TIER] &&
      !changes[STORAGE_PLAN_RENEWAL] &&
      !changes[STORAGE_PREF_BILLING_TIER]
    ) {
      return;
    }
    refreshSettingsTierDisplay();
  });

  const overlay = document.getElementById("settings-overlay");
  document.getElementById("btn-open-settings")?.addEventListener("click", () => {
    refreshSettingsTierDisplay();
    refreshSettingsBillingAuthState();
    setBillingMsg("");
    refreshSettingsDiagnosticsUI();
    overlay?.classList.remove("hidden");
  });
  document.getElementById("btn-settings-close")?.addEventListener("click", () => {
    if (closeLegalDocModalIfOpen()) return;
    overlay?.classList.add("hidden");
  });

  document.getElementById("btn-open-terms")?.addEventListener("click", () => loadLegalDocIntoModal("terms"));
  document.getElementById("btn-open-privacy")?.addEventListener("click", () => loadLegalDocIntoModal("privacy"));

  const planGrid = document.getElementById("settings-plan-grid");
  planGrid?.addEventListener("click", (e) => {
    const locked = billingSignedIn === false;
    const openBtn = e.target && e.target.closest && e.target.closest(".settings-plan-open[data-billing-tier]");
    if (openBtn && openBtn.dataset.billingTier) {
      e.stopPropagation();
      if (locked) return;
      const tier = String(openBtn.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      if (tier === "pro" || tier === "growth" || tier === "scale") {
        // Extensions frequently can't send Clerk cookies cross-origin.
        // Open a first-party tab that autostarts Stripe Checkout instead.
        openAutostartCheckoutTabForTier(tier);
      } else {
        openBillingTabForTier(tier);
      }
      return;
    }
    const row = e.target && e.target.closest && e.target.closest(".settings-plan-row[data-billing-tier]");
    if (row && row.dataset.billingTier) {
      const tier = String(row.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      // Row click expands/collapses details (CTA button handles checkout / sign-in).
      togglePlanDetails(row);
    }
  });

  planGrid?.addEventListener("keydown", (e) => {
    const locked = billingSignedIn === false;
    const row = e.target && e.target.closest && e.target.closest(".settings-plan-row[data-billing-tier]");
    if (!row || (e.target && e.target.closest && e.target.closest(".settings-plan-open"))) return;
    const rows = Array.from(
      document.querySelectorAll("#settings-plan-grid .settings-plan-row[data-billing-tier]")
    );
    const i = rows.indexOf(row);
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const tier = String(row.dataset.billingTier).toLowerCase();
      setPrefBillingTier(tier);
      // Expand/collapse on keyboard. CTA still required to upgrade; signed-out can still read details.
      togglePlanDetails(row);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = e.key === "ArrowDown" ? rows[i + 1] : rows[i - 1];
      if (next) {
        next.focus();
        setPrefBillingTier(String(next.dataset.billingTier).toLowerCase());
        // Keep details readable while navigating (do not auto-open checkout).
        if (!locked) {
          /* noop */
        }
      }
    }
  });

  document.getElementById("btn-settings-signin")?.addEventListener("click", async () => {
    setBillingMsg("");
    const btn = document.getElementById("btn-settings-signin");
    if (btn) btn.disabled = true;
    try {
      // Refresh first so we don't use stale signed-in state.
      await refreshSettingsBillingAuthState();
    } catch {
      /* ignore */
    }
    try {
      const base = getBillingOrigin();
      if (!base) return;
      // Only sign out when we are definitely signed in.
      if (billingSignedIn === true) {
        chrome.tabs.create({
          url: `${base}/sign-out?redirect_url=${encodeURIComponent("/extension-return?signed_out=1")}`,
        });
        return;
      }
      // Otherwise always go to Clerk sign-in.
      chrome.tabs.create({
        url: `${base}/sign-in?redirect_url=${encodeURIComponent("/extension-return?auth=1")}&after_sign_in_url=${encodeURIComponent("/extension-return?auth=1")}`,
      });
    } catch {
      openBillingTabForTier("pro");
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById("btn-copy-diagnostics")?.addEventListener("click", () => {
    void copySettingsDiagnostics();
  });
}

/** Bold primary step index (`2.`, `3.`, …) inside `.label-step`; remainder keeps muted styling. */
function setLabelStepHtml(el, text) {
  if (!el) return;
  const s = String(text || "").trim();
  const m = s.match(/^(\d+\.)\s*(.*)$/);
  if (m) {
    el.innerHTML = `<span class="label-step-num">${m[1]}</span> ${m[2]}`;
  } else {
    el.textContent = s;
  }
}

/** Per-platform copy for the review step (labels + hints). */
const PLATFORM_REVIEW_TEMPLATES = {
  shopify: {
    stepLabel: "3. Review content for Shopify",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Shopify instantly.",
    title: "Product title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Shopify Admin",
  },
  ebay: {
    stepLabel: "3. Review content for eBay",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in eBay instantly.",
    title: "Title",
    description: "Item description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "eBay listing",
  },
  etsy: {
    stepLabel: "3. Review content for Etsy",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Etsy instantly.",
    title: "Listing title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Etsy listing editor",
  },
  shopee: {
    stepLabel: "3. Review content for Shopee",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Shopee instantly.",
    title: "Product name",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Shopee Seller Centre",
  },
  depop: {
    stepLabel: "3. Review content for Depop",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Depop instantly.",
    title: "Title",
    description: "Description",
    price: "Item price",
    pricePlaceholder: "0.00",
    tabHint: "Depop listing",
  },
  vinted: {
    stepLabel: "3. Review content for Vinted",
    sub: "Double-check the key fields here. Magic Fill uses them to create your product in Vinted instantly.",
    title: "Title",
    description: "Description",
    price: "Price",
    pricePlaceholder: "0.00",
    tabHint: "Vinted upload",
  },
};

/** Prefer these URL patterns when the active tab is not the marketplace (Magic Fill). */
const PLATFORM_TAB_URLS = {
  shopify: ["https://admin.shopify.com/*"],
  ebay: ["https://*.ebay.com/*", "https://ebay.com/*", "http://*.ebay.com/*"],
  etsy: ["https://*.etsy.com/*", "http://*.etsy.com/*"],
  depop: ["https://www.depop.com/*", "https://depop.com/*"],
  vinted: [
    "https://www.vinted.com/*",
    "https://www.vinted.co.uk/*",
    "https://www.vinted.de/*",
    "https://www.vinted.fr/*",
    "https://www.vinted.nl/*",
    "https://www.vinted.es/*",
    "https://www.vinted.it/*",
    "https://www.vinted.pl/*",
    "https://www.vinted.be/*",
    "https://www.vinted.at/*",
    "https://www.vinted.pt/*",
  ],
  shopee: [
    "https://seller.shopee.sg/*",
    "https://seller.shopee.co.id/*",
    "https://seller.shopee.co.th/*",
    "https://seller.shopee.com.my/*",
    "https://seller.shopee.ph/*",
    "https://seller.shopee.tw/*",
    "https://seller.shopee.vn/*",
    "https://seller.shopee.com.br/*",
    "https://banhang.shopee.vn/*",
  ],
};

function templateForPlatform(id) {
  return PLATFORM_REVIEW_TEMPLATES[id] || PLATFORM_REVIEW_TEMPLATES.shopify;
}

function applyPlatformReviewTemplate(id) {
  const t = templateForPlatform(id);
  const stepEl = document.getElementById("review-step-label");
  const subEl = document.getElementById("review-template-sub");
  const lt = document.getElementById("label-review-title");
  const ld = document.getElementById("label-review-description");
  const lp = document.getElementById("label-review-price-text");
  const priceInput = document.getElementById("review-price");
  const hintEl = document.getElementById("magic-tab-hint");
  const postHintEl = document.getElementById("magic-post-hint");
  if (stepEl) setLabelStepHtml(stepEl, t.stepLabel);
  if (subEl) subEl.textContent = t.sub;
  if (lt) lt.textContent = t.title;
  if (ld) ld.textContent = t.description;
  if (lp) lp.textContent = t.price;
  if (priceInput) priceInput.placeholder = t.pricePlaceholder;
  if (hintEl) hintEl.textContent = t.tabHint;
  const readyHintEl = document.getElementById("platform-ready-hint");
  if (readyHintEl) {
    const surface = t.tabHint || "your marketplace";
    readyHintEl.innerHTML =
      `Open <strong>${surface}</strong> in a browser tab and go to the product or listing page you’ll publish from.`;
  }
  if (postHintEl) {
    const safeHint = t.tabHint || "listing";
    postHintEl.innerHTML =
      `Keep your <strong id="magic-tab-hint">${safeHint}</strong> open. ` +
      `Start from <strong>Products</strong> list; we’ll add, fill form, and save.`;
  }
}

/** Re-apply last marketplace selection from storage (new phone scan keeps Shopify, etc.). */
const ALLOWED_PLATFORMS = new Set(["shopify", "ebay", "etsy", "shopee", "depop", "vinted"]);

function normalizeLegacyPlatformId(p) {
  if (!p) return p;
  if (ALLOWED_PLATFORMS.has(p)) return p;
  if (p === "poshmark") return "etsy";
  /** Grailed hidden from chooser for now; map stored value to a supported platform. */
  if (p === "grailed" || p === "amazon" || p === "tiktok_shop") return "shopify";
  return "shopify";
}

function restorePlatformFromStorage() {
  chrome.storage.local.get([STORAGE_LAST_PLATFORM], (o) => {
    let p = o && o[STORAGE_LAST_PLATFORM];
    const norm = normalizeLegacyPlatformId(p);
    if (norm !== p) {
      chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: norm });
      p = norm;
    }
    if (p && PLATFORM_REVIEW_TEMPLATES[p]) {
      setSelectedPlatform(p);
    }
  });
}

function urlMatchesPlatform(url, platform) {
  if (!url || !platform) return false;
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    switch (platform) {
      case "shopify":
        return h === "admin.shopify.com";
      case "ebay":
        return h.includes("ebay.");
      case "etsy":
        return h.includes("etsy.");
      case "shopee":
        return (h.startsWith("seller.") && h.includes("shopee.")) || h.includes("banhang.shopee");
      case "depop":
        return h.includes("depop.");
      case "vinted":
        return h.includes("vinted.");
      default:
        return false;
    }
  } catch {
    return false;
  }
}

async function findListingTab(platform) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.id && urlMatchesPlatform(active.url, platform)) {
    return active;
  }
  const patterns = PLATFORM_TAB_URLS[platform];
  if (patterns && patterns.length) {
    for (const urlPattern of patterns) {
      const found = await chrome.tabs.query({ url: urlPattern, currentWindow: true });
      if (found[0]?.id) {
        return found[0];
      }
    }
  }
  const all = await chrome.tabs.query({ currentWindow: true });
  const match = all.find((tab) => urlMatchesPlatform(tab.url, platform));
  if (match?.id) return match;
  return active && active.id ? active : null;
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (!el) return;
  const msg = (text || "").trim();
  el.textContent = msg;
  if (!msg) {
    el.removeAttribute("data-kind");
    return;
  }
  const lc = msg.toLowerCase();
  let kind = "info";
  if (
    lc.includes("could not") ||
    lc.includes("couldn’t") ||
    lc.includes("error") ||
    lc.includes("failed") ||
    lc.includes("offline")
  ) {
    kind = "error";
  } else if (
    lc.includes("choose") ||
    lc.includes("open a") ||
    lc.includes("add a title") ||
    lc.includes("try again") ||
    lc.includes("wait") ||
    lc.includes("still running")
  ) {
    kind = "warn";
  } else if (lc.startsWith("done") || lc.includes("filled") || lc.includes("copied")) {
    kind = "success";
  }
  el.setAttribute("data-kind", kind);
}

let toastTimer = null;
function showToast(text, kind = "success", ms = 1500) {
  const el = document.getElementById("toast");
  if (!el) return;
  const msg = String(text || "").trim();
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
  if (!msg) {
    el.textContent = "";
    el.classList.add("hidden");
    el.removeAttribute("data-kind");
    return;
  }
  el.textContent = msg;
  el.classList.remove("hidden");
  if (kind) el.setAttribute("data-kind", String(kind));
  toastTimer = setTimeout(() => {
    try {
      el.textContent = "";
      el.classList.add("hidden");
      el.removeAttribute("data-kind");
    } catch {
      /* ignore */
    }
  }, Math.max(450, Number(ms) || 0));
}

const PAIR_COPY_HINT_DEFAULT = "";

async function copySnapPairUrl() {
  const code = snapPairSessionId;
  if (!code) return;
  const hintEl = document.getElementById("pair-copy-hint");
  try {
    await navigator.clipboard.writeText(code);
    if (hintEl) hintEl.textContent = "Code copied!";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 1600);
  } catch {
    if (hintEl) hintEl.textContent = "Couldn’t copy — select the code";
    setTimeout(() => {
      if (hintEl) hintEl.textContent = PAIR_COPY_HINT_DEFAULT;
    }, 2400);
  }
}

/** Avoid opening many tabs when the user double-clicks the CTA; also ignore duplicate creates in the same burst. */
let __openSnapPairLinkLastMs = 0;

function openSnapPairLink(pairUrl) {
  const u = String(pairUrl || "").trim();
  if (!u) return;
  const now = Date.now();
  if (now - __openSnapPairLinkLastMs < 600) return;
  __openSnapPairLinkLastMs = now;
  try {
    chrome.tabs.create({ url: u });
  } catch {
    /* ignore */
  }
}

/**
 * Popup init is async (session, origin, QR, poll, Supabase…). Listeners were previously registered
 * at the *end* of init, so rapid clicks on “Upload from Computer” did nothing until loading finished.
 * Wire snap / copy CTAs as soon as we have session + origin (see init()).
 */
let snapPairCtaWired = false;
function wireSnapPairCtaButtons() {
  if (snapPairCtaWired) return;
  snapPairCtaWired = true;
  const beginNewUploadFlow = () => {
    try {
      // Reset local UI so the user understands we're waiting for a *new* scan.
      listingHydrated = false;
      lastPayload = null;
      lastAppliedListingStamp = null;
      lastAppliedImageUrl = null;
      setReviewLoadingState(true, "Waiting for upload");
      continueToListing();
      // If the user takes a while to upload, this still keeps polling for a bit.
      burstPollUntilListing(snapPairSessionId, {
        stepMs: 350,
        maxAttempts: 240,
        onTimeoutMessage: "Still waiting — upload a photo, then reopen this popup.",
      });
    } catch {
      /* ignore */
    }
  };
  const onOpen = (e) => {
    e.preventDefault();
    beginNewUploadFlow();
    openSnapPairLink(getCurrentPairUrl());
  };
  const onCopy = (e) => {
    e.preventDefault();
    void copySnapPairUrl();
  };
  document.getElementById("btn-open-snap-on-this-computer")?.addEventListener("click", onOpen);
  document.getElementById("btn-copy-snap-link")?.addEventListener("click", onCopy);
  // Same actions on the "loaded" (step 2+) screen so users can start a fresh scan without refreshing.
  document.getElementById("btn-upload-new-photo")?.addEventListener("click", onOpen);
}

function getCurrentPairUrl() {
  const sid = snapPairSessionId;
  if (!sid) return "";
  const base = String(SYNCLYST_ORIGIN || SYNCLYST_ORIGIN_DEFAULT).replace(/\/$/, "");
  return `${base}/snap?s=${encodeURIComponent(sid)}`;
}

/**
 * Direct /snap link for the session (used by “Copy link”, desktop, etc.).
 */
function getPhonePairUrlDirect() {
  const sid = snapPairSessionId;
  if (!sid) return "";
  const resolved = String(SYNCLYST_ORIGIN || "").replace(/\/$/, "");
  const isLoopback =
    /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(resolved) ||
    /^https?:\/\/\[::1\](:\d+)?\/?$/i.test(resolved);
  const isPublicHttps = /^https:\/\//i.test(resolved) && !isLoopback;
  const isLanHttp = /^http:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?\/?$/i.test(
    resolved
  );
  if (isPublicHttps || isLanHttp) {
    return `${resolved}/snap?s=${encodeURIComponent(sid)}`;
  }
  return `${SYNCLYST_ORIGIN_LIVE}/snap?s=${encodeURIComponent(sid)}`;
}

function base64UrlEncodeUtf8(str) {
  if (typeof TextEncoder !== "undefined") {
    const bytes = new TextEncoder().encode(String(str));
    let bin = "";
    for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  return btoa(String(str)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * URL encoded in the phone QR. iOS often only offers to *copy* raw http:// (LAN) links from the Camera
 * app, not “Open in Safari”. Use a trustable https:// page on synclyst.app that redirects to the real
 * /snap link (q.html#base64). Full https targets (Vercel, production) are encoded as-is.
 */
function getPhoneQrUrl() {
  const direct = getPhonePairUrlDirect();
  if (!direct) return "";
  if (/^https:\/\//i.test(direct)) return direct;
  if (!/^http:\/\//i.test(direct)) return direct;
  const live = SYNCLYST_ORIGIN_LIVE.replace(/\/$/, "");
  return `${live}/q.html#${base64UrlEncodeUtf8(direct)}`;
}

const QR_CTA_INJECT_STYLE =
  "display:block;width:100%;box-sizing:border-box;margin-top:12px;padding:10px 14px;min-height:44px;" +
  "font-size:13px;font-weight:600;line-height:1.2;color:#fff;background:#111827;border:1px solid #0f172a;" +
  "border-radius:12px;cursor:pointer;font-family:inherit;";

/**
 * A stale "Load unpacked" copy may still serve an old popup.html (QR → session only). Recreate the current controls in DOM.
 * Prefer appending the CTA *inside* `.qr-card` (same as current markup) so it stays inside the visible dashed box.
 */
function appendQrOrDividerDom(qr) {
  const hint = qr.querySelector(".qr-hint");
  if (!hint || qr.querySelector(".qr-or-divider")) return;
  const div = document.createElement("div");
  div.className = "qr-or-divider";
  div.setAttribute("role", "separator");
  div.setAttribute("aria-label", "Option 2");
  div.innerHTML =
    '<span class="qr-or-divider__line" aria-hidden="true"></span><span class="qr-or-divider__text">or</span><span class="qr-or-divider__line" aria-hidden="true"></span>';
  hint.insertAdjacentElement("afterend", div);
}

/** Stale markup: QR hint immediately followed by desktop button — insert “or” divider between. */
function patchQrOrDividerIfStale(qr) {
  const hint = qr.querySelector(".qr-hint");
  const btn = document.getElementById("btn-open-snap-on-this-computer");
  if (!hint || !btn || qr.querySelector(".qr-or-divider")) return;
  if (hint.nextElementSibling === btn) appendQrOrDividerDom(qr);
}

function ensurePairingStepControls() {
  const root = document.getElementById("state-empty");
  const qr = root && root.querySelector(".qr-card");
  if (!root || !qr) return;

  // Keep QR instructions consistent even if a stale popup.html is loaded.
  try {
    const hintEl = qr.querySelector(".qr-hint");
    if (hintEl) {
      hintEl.textContent = "Scan QR, upload from PC or Phone.";
    }
  } catch {
    /* ignore */
  }

  if (!document.getElementById("btn-open-snap-on-this-computer")) {
    appendQrOrDividerDom(qr);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-magic qr-snap-cta";
    b.id = "btn-open-snap-on-this-computer";
    b.textContent = "Upload from Computer";
    b.style.cssText = QR_CTA_INJECT_STYLE;
    const anchor = qr.querySelector(".qr-or-divider") || qr.querySelector(".qr-hint");
    if (anchor) {
      anchor.insertAdjacentElement("afterend", b);
    } else {
      qr.appendChild(b);
    }
  }

  patchQrOrDividerIfStale(qr);

  // In current UI `btn-copy-snap-link` is the whole session card; older UIs may still need a button.
  if (!document.getElementById("btn-copy-snap-link")) {
    const snap = document.createElement("button");
    snap.type = "button";
    snap.className = "btn-ghost";
    snap.id = "btn-copy-snap-link";
    snap.textContent = "Copy session code";
    const anchor = document.getElementById("btn-new-pairing-session");
    if (anchor && anchor.parentNode === root) {
      root.insertBefore(snap, anchor);
    } else {
      root.appendChild(snap);
    }
  }
}

function setLiveLabel(text) {
  const el = document.getElementById("live-label");
  if (el) el.textContent = text;
  const wrap = document.getElementById("live-status");
  if (!wrap) return;
  wrap.classList.toggle("is-error", text === "Error");
}

function genSessionIdLocal() {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionIdFromSnapLikeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(String(raw));
    const p = (u.pathname || "").replace(/\/$/, "");
    const okPath =
      p === "/snap" ||
      p === "/snap.html" ||
      p === "/extension-review" ||
      p.startsWith("/extension-review/");
    if (!okPath) return null;
    const s = (u.searchParams.get("s") || "").trim();
    return /^[a-f0-9]{12,32}$/i.test(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * All windows — pairing often lives in a different window than the seller tab where the popup is opened.
 * If `storedId` is set, prefer a tab whose `?s=` matches (avoids a stale /snap background tab overriding the phone/QR id).
 */
function pickSessionIdFromOpenSynclystTab(storedId) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.query({}, (tabs) => {
        try {
          const list = (tabs || []).filter((t) => t && t.url);
          const found = [];
          for (const t of list) {
            const s = sessionIdFromSnapLikeUrl(t.url);
            if (s) found.push({ s, active: !!t.active });
          }
          if (!found.length) return resolve(null);
          const sid = storedId && /^[a-f0-9]{12,32}$/i.test(String(storedId)) ? String(storedId) : "";
          if (sid) {
            const m = found.find((x) => x.s && x.s.toLowerCase() === sid.toLowerCase());
            if (m) return resolve(m.s);
            // Persisted id (QR / phone) wins over a leftover /snap tab with a different ?s=.
            return resolve(null);
          }
          const act = found.find((x) => x.active);
          if (act) return resolve(act.s);
          return resolve(found[0].s);
        } catch {
          /* ignore */
        }
        resolve(null);
      });
    } catch {
      resolve(null);
    }
  });
}

/**
 * Prefer background worker; fall back to storage in-popup (MV3 SW can miss first message).
 */
function getSessionId() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["snap_pair_session_id"], (o) => {
      const stored = o && o.snap_pair_session_id && /^[a-f0-9]{12,32}$/i.test(String(o.snap_pair_session_id))
        ? String(o.snap_pair_session_id)
        : "";
      pickSessionIdFromOpenSynclystTab(stored)
        .then((fromTab) => {
          if (fromTab) {
            if (!stored || fromTab.toLowerCase() !== stored.toLowerCase()) {
              try {
                chrome.storage.local.set({ snap_pair_session_id: fromTab });
              } catch {
                /* ignore */
              }
            }
            resolve(fromTab);
            return true;
          }
          return false;
        })
        .then((done) => {
          if (done) return;
          if (stored) {
            resolve(stored);
            return;
          }
          chrome.runtime.sendMessage({ type: "SYNCLYST_GET_SESSION" }, (r) => {
            if (chrome.runtime.lastError) {
              /* fall through */
            } else if (r && r.sessionId && /^[a-f0-9]{12,32}$/i.test(r.sessionId)) {
              resolve(r.sessionId);
              return;
            }
            chrome.storage.local.get(["snap_pair_session_id"], (o2) => {
              const existing = o2 && o2.snap_pair_session_id;
              if (existing && /^[a-f0-9]{12,32}$/i.test(String(existing))) {
                resolve(String(existing));
                return;
              }
              const id = genSessionIdLocal();
              chrome.storage.local.set({ snap_pair_session_id: id }, () => resolve(id));
            });
          });
        });
    });
  });
}

function getQrEncodeFactory() {
  const g = typeof globalThis !== "undefined" ? globalThis : window;
  if (typeof g.__SYNCLYST_QRCODE === "function") return g.__SYNCLYST_QRCODE;
  if (typeof g.qrcode === "function") return g.qrcode;
  return null;
}

function revokePrevQrObjectUrl(imgEl) {
  const prev = imgEl && imgEl.dataset && imgEl.dataset.synclystQrBlob;
  if (prev) {
    try {
      URL.revokeObjectURL(prev);
    } catch {
      /* ignore */
    }
    delete imgEl.dataset.synclystQrBlob;
  }
}

/**
 * Generate QR locally (no third-party services).
 * Prefer GIF data URL (most reliable in MV3 popups), then SVG blob URL fallback.
 */
async function setQrSrc(imgEl, pairUrl) {
  const u = String(pairUrl || "").trim();
  if (!imgEl || !u) return;
  revokePrevQrObjectUrl(imgEl);
  const loader = document.getElementById("qr-loader");
  loader?.classList.remove("hidden");
  const emptyState = document.getElementById("state-empty");
  emptyState?.classList.add("is-qr-loading");
  try {
    imgEl.classList.add("is-loading");
  } catch {
    /* ignore */
  }

  const applyBlobSrc = (blob) => {
    const u = URL.createObjectURL(blob);
    imgEl.dataset.synclystQrBlob = u;
    imgEl.src = u;
  };

  const mk = getQrEncodeFactory();
  if (typeof mk === "function") {
    for (let type = 1; type <= 40; type += 1) {
      try {
        const qr = mk(type, "M");
        qr.addData(u);
        qr.make();
        /** GIF data URL first: most reliable in MV3 popups. */
        const tag = qr.createImgTag(4, 8);
        const mGif = tag && String(tag).match(/src="([^"]+)"/);
        if (mGif && mGif[1]) {
          imgEl.removeAttribute("data-synclyst-qr-blob");
          imgEl.src = mGif[1];
          loader?.classList.add("hidden");
          imgEl.classList.remove("is-loading");
          emptyState?.classList.remove("is-qr-loading");
          return;
        }
        const svg = qr.createSvgTag(4, 8);
        if (svg && String(svg).indexOf("<svg") !== -1) {
          const blob = new Blob([String(svg)], { type: "image/svg+xml;charset=utf-8" });
          applyBlobSrc(blob);
          loader?.classList.add("hidden");
          imgEl.classList.remove("is-loading");
          emptyState?.classList.remove("is-qr-loading");
          return;
        }
      } catch {
        /* try larger symbol version */
      }
    }
  }

  // If the vendor QR library fails to load for any reason, keep the popup usable.
  imgEl.removeAttribute("data-synclyst-qr-blob");
  imgEl.src = "";
  // Keep loader visible so the QR area doesn't look broken.
}

async function registerSession(sessionId) {
  try {
    await fetchWithTimeout(
      `${SYNCLYST_ORIGIN}/api/snap-pair/session`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      },
      6000
    );
  } catch {
    /* offline */
  }
}

async function fetchConfig() {
  try {
    const r = await fetchWithTimeout(`${SYNCLYST_ORIGIN}/api/snap-pair/config`, {}, 6000);
    const j = await r.json();
    diagLastConfig = j && typeof j === "object" ? j : { configured: false };
    refreshSettingsDiagnosticsUI();
    return j;
  } catch {
    diagLastConfig = { configured: false };
    refreshSettingsDiagnosticsUI();
    return { configured: false };
  }
}

let _sessionPollCount = 0;
async function pollSession(sessionId) {
  /** Stale `SYNCLYST_ORIGIN` (e.g. synclyst.app) while /snap is on 127.0.0.1:3000 makes polls return empty forever. */
  _sessionPollCount += 1;
  if (_sessionPollCount === 1 || _sessionPollCount % 3 === 0) {
    try {
      SYNCLYST_ORIGIN = await resolveSynclystOrigin();
    } catch {
      /* ignore */
    }
  }
  try {
    if (extractionPending) updateExtractionStage("Checking status");
    const r = await fetchWithTimeout(
      `${SYNCLYST_ORIGIN}/api/snap-pair/session/${encodeURIComponent(sessionId)}`,
      {},
      30000
    );
    diagLastPoll = { atMs: Date.now(), status: r && typeof r.status === "number" ? r.status : null, ok: !!(r && r.ok), error: "" };
    refreshSettingsDiagnosticsUI();
    if (!r || !r.ok) {
      if (extractionPending) updateExtractionStage("Waiting for extraction");
      return { error: true, status: r && r.status };
    }
    const j = await r.json();
    if (extractionPending) {
      if (j && j.empty) updateExtractionStage("Waiting for upload");
      else if (j && j.listing && !sessionListingHasContent(j.listing)) updateExtractionStage("Processing image");
      else updateExtractionStage("Finalizing");
    }
    return j;
  } catch {
    diagLastPoll = { atMs: Date.now(), status: null, ok: false, error: "fetch_failed" };
    refreshSettingsDiagnosticsUI();
    if (extractionPending) updateExtractionStage("Reconnecting");
    return { error: true };
  }
}

/**
 * Phone upload sets storage before vision + push finish; a single poll often returns { empty: true }.
 * Poll in quick succession until the session row has listing content (or we give up).
 */
let snapBurstGen = 0;
function burstPollUntilListing(sessionId, opts) {
  const stepMs = opts && opts.stepMs != null ? opts.stepMs : 350;
  const maxAttempts = opts && opts.maxAttempts != null ? opts.maxAttempts : 220;
  const onTimeoutMessage = opts && typeof opts.onTimeoutMessage === "string" ? opts.onTimeoutMessage : "";
  const my = ++snapBurstGen;
  let attempt = 0;
  async function step() {
    if (my !== snapBurstGen) return;
    if (attempt++ >= maxAttempts) {
      if (onTimeoutMessage) {
        try {
          setReviewLoadingState(false, onTimeoutMessage);
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (extractionPending && attempt === 1) updateExtractionStage("Upload received");
    const j = await pollSession(sessionId);
    if (my !== snapBurstGen) return;
    if (j && !j.empty && j.listing && sessionListingHasContent(j.listing)) {
      applyListing(j.listing);
      return;
    }
    setTimeout(step, stepMs);
  }
  step();
}

function updateContinueListingButton() {
  const cont = document.getElementById("btn-continue-listing");
  if (!cont) return;
  const show = qrHomeActive && listingHydrated && sessionListingHasContent(lastPayload);
  cont.classList.toggle("hidden", !show);
}

function updatePairingHeaderLabel(mode) {
  const el = document.getElementById("pairing-header-step-label");
  if (!el) return;
  if (mode === "qr") {
    setLabelStepHtml(el, "1. Scan to pair phone");
    el.classList.remove("hidden");
  } else {
    /* Listing: `#state-empty` (which contains this label) is hidden — clear for consistency. */
    el.textContent = "";
    el.classList.add("hidden");
  }
}

function showQrHomeView() {
  qrHomeActive = true;
  chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: true });
  const empty = document.getElementById("state-empty");
  const loaded = document.getElementById("state-loaded");
  if (empty) empty.classList.remove("hidden");
  if (loaded) loaded.classList.add("hidden");
  const st = document.getElementById("status");
  if (st) st.textContent = "";
  updatePairingHeaderLabel("qr");
  updateContinueListingButton();
}

let brandHomeWired = false;
function wireBrandHome() {
  if (brandHomeWired) return;
  brandHomeWired = true;
  const btn = document.getElementById("btn-brand-home");
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    try {
      e.preventDefault();
      e.stopPropagation();
    } catch {
      /* ignore */
    }
    // If Settings (or legal sub-view) is open, close it first so the QR screen is visible.
    try {
      closeLegalDocModalIfOpen();
    } catch {
      /* ignore */
    }
    try {
      document.getElementById("settings-overlay")?.classList.add("hidden");
    } catch {
      /* ignore */
    }
    showQrHomeView();
  });
}

function setReviewLoadingState(on, msg) {
  extractionPending = !!on;
  // Ensure the right-hand "review" modal stays visible while we wait.
  try {
    document.getElementById("post-platform-panel")?.classList.remove("hidden");
  } catch {
    /* ignore */
  }
  const loadWrap = document.getElementById("review-loading");
  if (loadWrap) loadWrap.classList.toggle("hidden", !on);
  if (on) {
    const m = typeof msg === "string" && msg.trim() ? msg.trim() : "Extracting your listing";
    startExtractionTicker(m.replace(/[.…]+$/g, ""));
  } else {
    stopExtractionTicker();
    if (typeof msg === "string" && msg.trim()) setReviewLoadingText(msg.trim());
  }
  const titleEl = document.getElementById("review-title");
  const descEl = document.getElementById("review-description");
  const priceEl = document.getElementById("review-price");
  if (titleEl) {
    titleEl.value = on ? "" : titleEl.value;
    titleEl.disabled = !!on;
    if (on) titleEl.placeholder = "Waiting for your scan…";
  }
  if (descEl) {
    descEl.value = on ? "" : descEl.value;
    descEl.disabled = !!on;
  }
  if (priceEl) {
    priceEl.value = on ? "" : priceEl.value;
    priceEl.disabled = !!on;
  }
  const thumb = document.getElementById("preview-thumb");
  if (thumb) {
    thumb.style.display = on ? "none" : thumb.style.display;
    if (on) thumb.removeAttribute("src");
  }
  const extra = document.getElementById("review-extra-images");
  if (extra) {
    extra.innerHTML = "";
    extra.classList.add("hidden");
  }
  const cont = document.getElementById("btn-continue-listing");
  if (cont) cont.classList.add("hidden");
  updateFullReviewButton();
  // Avoid showing the gray status banner while extracting — use the purple banner instead.
  if (on) setStatus("");
  else if (typeof msg === "string") setStatus(msg);
  refreshLoadedSubstate();
}

function continueToListing() {
  qrHomeActive = false;
  chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: false });
  try {
    chrome.action.setBadgeText({ text: "" });
    chrome.action.setTitle({ title: chrome.runtime.getManifest()?.name || "SyncLyst" });
  } catch {
    /* ignore */
  }
  const empty = document.getElementById("state-empty");
  const loaded = document.getElementById("state-loaded");
  if (empty) empty.classList.add("hidden");
  if (loaded) loaded.classList.remove("hidden");
  const cont = document.getElementById("btn-continue-listing");
  if (cont) cont.classList.add("hidden");
  updatePairingHeaderLabel("listing");
  updateMagicLabel();
  updateFullReviewButton();
  refreshLoadedSubstate();
}

/** Supabase / JSON may return numeric price — always stringify for inputs and Magic Fill. */
function formatListingPrice(v) {
  if (v === undefined || v === null || v === "") return "";
  return String(v);
}

const DEFAULT_ESTIMATED_PRICE = "0.00";

function pickStr(v) {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

/**
 * Session listing is worth showing in step 3 when any core field exists.
 * Do not require `title` — vision often returns image + description first, or title only after a follow-up write.
 */
function sessionListingHasContent(L) {
  if (!L || typeof L !== "object") return false;
  if (pickStr(L.title)) return true;
  if (pickStr(L.description)) return true;
  if (L.price !== undefined && L.price !== null && String(L.price).trim() !== "") return true;
  const img = L.image_url != null ? String(L.image_url).trim() : "";
  const looksLikeRawBase64 = (s) => {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    if (t.length < 256) return false;
    if (t.indexOf("data:") === 0 || t.indexOf("http") === 0 || t.indexOf("blob:") === 0) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(t);
  };
  if (img && (img.startsWith("data:") || img.startsWith("http") || img.startsWith("blob:") || looksLikeRawBase64(img)))
    return true;
  try {
    const le = L.listing_extra;
    const urls =
      le &&
      le.media &&
      Array.isArray(le.media.image_urls) &&
      le.media.image_urls.filter(function (u) {
        return (
          typeof u === "string" &&
          (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0 || looksLikeRawBase64(u))
        );
      });
    if (urls && urls.length) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function pickFirstListingImageUrl(row) {
  if (!row || typeof row !== "object") return "";
  var top = row.image_url != null ? String(row.image_url).trim() : "";
  const looksLikeRawBase64 = (s) => {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    // Heuristic: large, no scheme/prefix, base64 alphabet only (avoid false positives on short strings).
    if (t.length < 256) return false;
    if (t.indexOf("data:") === 0 || t.indexOf("http") === 0 || t.indexOf("blob:") === 0) return false;
    return /^[A-Za-z0-9+/=\s]+$/.test(t);
  };
  if (top && (top.indexOf("data:") === 0 || top.indexOf("http") === 0 || top.indexOf("blob:") === 0)) return top;
  if (looksLikeRawBase64(top)) return `data:image/jpeg;base64,${top.replace(/\s+/g, "")}`;
  try {
    var le = row.listing_extra;
    var urls = le && le.media && Array.isArray(le.media.image_urls) ? le.media.image_urls : [];
    for (var i = 0; i < urls.length; i++) {
      var u = urls[i];
      if (
        typeof u === "string" &&
        (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0)
      )
        return u.trim();
      if (typeof u === "string" && looksLikeRawBase64(u)) return `data:image/jpeg;base64,${u.trim().replace(/\s+/g, "")}`;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Category may live under listing_extra.shopify or top-level listing_extra (legacy / merges).
 * An empty `shopify: {}` is truthy — do not use `ex.shopify || ex` alone.
 */
/**
 * Vision / push often put long copy in `listing_extra.ebay.item_description` (or Shopify `body_html`)
 * while `row.description` is still empty — Magic Fill and the review textarea must use the longest source.
 */
function resolveListingDescription(row) {
  if (!row || typeof row !== "object") return "";
  const parts = [];
  const push = (s) => {
    const t = String(s == null ? "" : s).trim();
    if (t) parts.push(t);
  };
  push(row.description);
  try {
    const le = row.listing_extra;
    if (le && typeof le === "object") {
      const eb = le.ebay && typeof le.ebay === "object" ? le.ebay : null;
      if (eb) push(eb.item_description);
      const sh = le.shopify && typeof le.shopify === "object" ? le.shopify : null;
      if (sh && sh.body_html != null) {
        push(
          String(sh.body_html)
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        );
      }
    }
  } catch {
    /* ignore */
  }
  if (!parts.length) return "";
  return parts.reduce(function (a, b) {
    return b.length > a.length ? b : a;
  }, "");
}

function pickCategoryFromListing(row) {
  const ex = row && row.listing_extra;
  if (!ex || typeof ex !== "object") return "";
  const shop = ex.shopify && typeof ex.shopify === "object" && !Array.isArray(ex.shopify) ? ex.shopify : null;
  const fromShop =
    pickStr(shop && shop.category) ||
    pickStr(shop && shop.category_suggested) ||
    pickStr(shop && shop.product_type);
  if (fromShop) return fromShop;
  return (
    pickStr(ex.category) ||
    pickStr(ex.category_suggested) ||
    pickStr(ex.product_type) ||
    ""
  );
}

function renderExtraImagesStrip(row) {
  const wrap = document.getElementById("review-extra-images");
  if (!wrap) return;
  wrap.innerHTML = "";
  wrap.classList.add("hidden");
  const ex = row && row.listing_extra;
  if (!ex || typeof ex !== "object") return;
  const shop = ex.shopify && typeof ex.shopify === "object" && !Array.isArray(ex.shopify) ? ex.shopify : null;
  const s = shop || ex;
  const raw = s && s.additional_images;
  if (!Array.isArray(raw) || !raw.length) return;
  const urls = raw.filter(function (u) {
    return (
      typeof u === "string" &&
      (u.indexOf("data:") === 0 || u.indexOf("http") === 0 || u.indexOf("blob:") === 0)
    );
  });
  if (!urls.length) return;
  for (let i = 0; i < Math.min(urls.length, 6); i++) {
    const im = document.createElement("img");
    im.width = 40;
    im.height = 40;
    im.alt = "";
    im.src = urls[i];
    wrap.appendChild(im);
  }
  wrap.classList.remove("hidden");
}

function syncPayloadFromReviewFields() {
  const t = document.getElementById("review-title");
  const d = document.getElementById("review-description");
  const p = document.getElementById("review-price");
  if (!t || !d || !p) return;
  const keepExtra = lastPayload && lastPayload.listing_extra != null ? lastPayload.listing_extra : undefined;
  const keepImg = lastPayload && lastPayload.image_url != null ? lastPayload.image_url : undefined;
  lastPayload = {
    title: (t.value || "").trim(),
    description: (d.value || "").trim(),
    price: (p.value || "").trim(),
    ...(keepExtra !== undefined ? { listing_extra: keepExtra } : {}),
    ...(keepImg !== undefined ? { image_url: keepImg } : {}),
  };
}

/**
 * Later polls can return rows with image/price but blank title/description (partial writes / races).
 * If we already showed copy, keep it until the server sends non-blank replacements (user edits stay in sync via input listeners).
 * IMPORTANT: only merge within the same scan (same updated_at stamp). If the stamp has changed,
 * this is a new product scan — do NOT carry old description/title across to the new product.
 */
function mergeListingCoreFromLastPayload(row) {
  if (!listingHydrated || !lastPayload) return row;
  // If the server row has a newer stamp than what we last applied, it's a fresh scan — don't merge stale fields.
  const rowStamp = row.updated_at != null ? String(row.updated_at).trim() : "";
  const prevStamp = lastAppliedListingStamp != null ? String(lastAppliedListingStamp).trim() : "";
  if (rowStamp && prevStamp && rowStamp !== prevStamp) return row;
  const out = { ...row };
  if (!pickStr(out.title) && pickStr(lastPayload.title)) out.title = lastPayload.title;
  const rowDesc = out.description != null ? String(out.description).trim() : "";
  const prevDesc = lastPayload.description != null ? String(lastPayload.description).trim() : "";
  if (!rowDesc && prevDesc) out.description = lastPayload.description;
  const rowPrice = formatListingPrice(out.price);
  if (!rowPrice.trim() && lastPayload.price != null && String(lastPayload.price).trim() !== "") {
    out.price = lastPayload.price;
  }
  return out;
}

function applyListing(row) {
  if (!sessionListingHasContent(row)) return;
  // We have real listing content; clear any "waiting for scan" UI.
  if (extractionPending) {
    extractionPending = false;
    const loadWrap = document.getElementById("review-loading");
    if (loadWrap) loadWrap.classList.add("hidden");
    stopExtractionTicker();
    const t = document.getElementById("review-title");
    const d = document.getElementById("review-description");
    const p = document.getElementById("review-price");
    if (t) t.disabled = false;
    if (d) d.disabled = false;
    if (p) p.disabled = false;
    setStatus("");
    // Clear the one-shot "listing ready" signal so we don't show stale extracting state later.
    try {
      chrome.storage.local.remove([STORAGE_SNAP_LISTING_READY_AT], () => {
        /* ignore */
      });
    } catch {
      /* ignore */
    }
  }
  row = mergeListingCoreFromLastPayload(row);
  const stamp =
    row.updated_at != null && String(row.updated_at).trim() !== ""
      ? String(row.updated_at)
      : `fallback:${snapPairSessionId || ""}:${pickStr(row.title)}\t${(row.description || "").length}`;
  const rawPriceStr = formatListingPrice(row.price);
  const priceStr = rawPriceStr && rawPriceStr.trim() ? rawPriceStr : DEFAULT_ESTIMATED_PRICE;
  const coercedImg = pickFirstListingImageUrl(row);
  const resolvedDesc = resolveListingDescription(row);
  lastPayload = {
    title: row.title == null ? "" : String(row.title).trim(),
    description: resolvedDesc,
    price: priceStr,
    ...(coercedImg ? { image_url: coercedImg } : {}),
    ...(row.listing_extra != null ? { listing_extra: row.listing_extra } : {}),
  };

  // Save to Settings → Library (saved scans & drafts) so the user can reopen and post again later.
  try {
    const sid = snapPairSessionId;
    if (sid) {
      const rawStamp =
        row.updated_at != null && String(row.updated_at).trim() !== ""
          ? String(row.updated_at).trim()
          : `fallback:${sid}:${pickStr(row.title)}\t${resolvedDesc.length}`;
      let ms = Date.now();
      try {
        const parsed = Date.parse(String(row.updated_at || ""));
        if (Number.isFinite(parsed)) ms = parsed;
      } catch {
        /* ignore */
      }
      void (async () => {
        const thumb = await tryMakeThumbnailDataUrl(coercedImg);
        void upsertDraftLibraryItem({
          sessionId: String(sid),
          title: row.title == null ? "" : String(row.title).trim(),
          updatedAtMs: ms,
          stamp: rawStamp,
          imageUrl: thumb,
          // Cache the full listing row so Open is instant (no server fetch needed).
          cachedRow: lastPayload,
        });
      })();
    }
  } catch {
    /* ignore */
  }
  const thumb = document.getElementById("preview-thumb");
  const showThumb = !!coercedImg;
  if (showThumb) {
    thumb.style.display = "";
    thumb.src = coercedImg;
  } else {
    thumb.style.display = "none";
  }
  const titleEl = document.getElementById("review-title");
  const descEl = document.getElementById("review-description");
  const priceEl = document.getElementById("review-price");
  if (titleEl) titleEl.value = row.title == null ? "" : String(row.title).trim();
  if (descEl) descEl.value = resolvedDesc;
  if (priceEl) priceEl.value = priceStr;
  const catRow = document.getElementById("review-category-row");
  const catInput = document.getElementById("review-category");
  const cat = pickCategoryFromListing(row);
  if (catRow && catInput) {
    catInput.value = cat;
    catRow.classList.toggle("hidden", !cat);
  }
  renderExtraImagesStrip(row);
  /**
   * Leave the QR (step 1) shell whenever we have listing data. Previously we only called
   * `continueToListing()` when `qrHomeActive && isNewer && !suppress` — a stale stamp or
   * "suppress first apply" could leave the user on the QR view forever even with a filled row.
   * DOM is the source of truth: if the empty state is still visible, or the QR-home flag is on, advance.
   */
  const stateEmptyEl = document.getElementById("state-empty");
  const qrPanelVisible = stateEmptyEl && !stateEmptyEl.classList.contains("hidden");
  // If the user explicitly chose the QR home (logo tap), do NOT auto-switch them back to listing.
  // Keep QR visible and just update the "Continue" button state.
  if (qrHomeActive) {
    showQrHomeView();
  } else if (qrPanelVisible) {
    continueToListing();
  } else {
    stateEmptyEl?.classList.add("hidden");
    document.getElementById("state-loaded")?.classList.remove("hidden");
    chrome.storage.local.set({ [STORAGE_PREFERS_QR_HOME]: false });
    updatePairingHeaderLabel("listing");
  }

  const newImg = coercedImg || "";
  const imgChanged =
    listingHydrated &&
    newImg &&
    lastAppliedImageUrl != null &&
    String(lastAppliedImageUrl) !== newImg;
  lastAppliedImageUrl = newImg || lastAppliedImageUrl;

  if (!listingHydrated) {
    listingHydrated = true;
    restorePlatformFromStorage();
  } else if (imgChanged) {
    restorePlatformFromStorage();
  } else {
    updateMagicLabel();
    updateFullReviewButton();
  }

  /** Keep polling forever when Realtime is off — no timeout; new scans keep updating the popup. */
  lastAppliedListingStamp = stamp;
  updateContinueListingButton();
  refreshLoadedSubstate();
}

function getSelectedPlatform() {
  const t = document.querySelector(".platform-tile.selected");
  return (t && t.dataset && t.dataset.platform) || null;
}

function updateFullReviewButton() {
  const btn = document.getElementById("btn-open-full-review");
  if (!btn) return;
  btn.disabled = !getSelectedPlatform();
}

function openFullReviewInBrowser() {
  const platform = getSelectedPlatform();
  if (!platform || !snapPairSessionId) {
    setStatus("Choose a marketplace in step 2 first.");
    return;
  }
  // Always open extension-review on app.synclyst.app — it's live there and served correctly.
  const reviewBase = "https://app.synclyst.app";
  const u = new URL("/extension-review", reviewBase);
  u.searchParams.set("s", snapPairSessionId);
  u.searchParams.set("platform", platform);
  chrome.tabs.create({ url: u.toString() });
}

function setSelectedPlatform(id) {
  document.querySelectorAll(".platform-tile:not(.platform-tile--coming-soon)").forEach((btn) => {
    const on = btn.dataset.platform === id;
    btn.classList.toggle("selected", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  });
  applyPlatformReviewTemplate(id);
  document.getElementById("post-platform-panel")?.classList.remove("hidden");
  updateMagicLabel();
  updateFullReviewButton();
  try {
    chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: id });
  } catch {
    /* ignore */
  }
}

function updateMagicLabel() {
  const label = document.getElementById("magic-platform-label");
  if (!label) return;
  const id = getSelectedPlatform();
  if (!id) {
    label.textContent = "—";
    return;
  }
  const nameEl = document.querySelector(`.platform-tile[data-platform="${id}"] .platform-name`);
  const name = nameEl ? nameEl.textContent.trim() : id;
  label.textContent = name;
}

function mergeShopifyListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const srcRoot = sessionListing.listing_extra;
  const src = srcRoot.shopify || srcRoot;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.shopify) merged.listing_extra.shopify = {};
  const dest = merged.listing_extra.shopify;

  const keys = [
    "tags",
    "vendor",
    "product_type",
    "seo_page_title",
    "seo_meta_description",
    "compare_at",
    "sku",
    "barcode",
    "quantity",
    "weight",
    "weight_unit",
    "category",
    "category_suggested",
    "collections",
    "unit_price",
    "charge_tax",
    "sizes",
    "colors",
    "additional_images",
  ];
  /** Non-empty session fields win (full review / API save is authoritative). */
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }

  const sMeta = src.metafields;
  if (sMeta && typeof sMeta === "object" && !Array.isArray(sMeta)) {
    const dMeta =
      dest.metafields && typeof dest.metafields === "object" && !Array.isArray(dest.metafields) ? dest.metafields : {};
    const mergedMeta = { ...dMeta };
    for (const [mk, mv] of Object.entries(sMeta)) {
      if (mv != null && (typeof mv !== "string" || mv.trim() !== "")) mergedMeta[mk] = mv;
    }
    dest.metafields = mergedMeta;
  }
}

/** Shopee Seller Centre: persist native category_id/path when user or API resolves them (vision only sends hints). */
function mergeShopeeListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.shopee;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.shopee) merged.listing_extra.shopee = {};
  const dest = merged.listing_extra.shopee;
  const keys = [
    "category_id",
    "category_path",
    "category_hint",
    "category_search",
    "category_source",
    "category_needs_confirmation",
    "category_confidence",
    "barcode",
    "display_title",
    "brand",
    "sleeve_length",
    "pattern",
    "gender",
    "material",
    "occasion",
    "stock",
    "weight_kg",
    "parcel_width_cm",
    "parcel_length_cm",
    "parcel_height_cm",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeVintedListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.vinted;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.vinted) merged.listing_extra.vinted = {};
  const dest = merged.listing_extra.vinted;
  const keys = [
    "category",
    "brand",
    "size",
    "shoulder_width_in",
    "length_in",
    "condition",
    "material",
    "colours",
    "colors",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeEbayListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.ebay;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.ebay) merged.listing_extra.ebay = {};
  const dest = merged.listing_extra.ebay;
  const keys = [
    "item_description",
    "category_leaf",
    "category_breadcrumb",
    "brand",
    "size",
    "color",
    "department",
    "upc",
    "item_type",
    "condition",
    "quantity",
    "auction_duration_days",
    "pricing_format",
    "starting_bid",
    "buy_it_now_price",
    "reserve_price",
    "shipping_method",
    "package_weight_lbs",
    "package_weight_oz",
    "package_length_in",
    "package_width_in",
    "package_height_in",
    "domestic_cost_type",
    "country_of_origin",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeEtsyListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.etsy;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.etsy) merged.listing_extra.etsy = {};
  const dest = merged.listing_extra.etsy;
  const keys = [
    "title",
    "category_search",
    "category_leaf",
    "category_breadcrumb",
    "item_type",
    "when_made",
    "tags",
    "brand",
    "materials_hint",
    "quantity",
    "sku",
    "who_made",
    "what_is_it",
    "renewal",
    "shop_section",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeDepopListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.depop;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.depop) merged.listing_extra.depop = {};
  const dest = merged.listing_extra.depop;
  const keys = [
    "category",
    "brand",
    "condition",
    "color",
    "source",
    "age",
    "style",
    "shipping_price",
    "country",
    "offer_worldwide_shipping",
    "additional_images",
  ];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    if (Array.isArray(sv) && sv.length === 0) continue;
    dest[k] = sv;
  }
}

function mergeGrailedListingExtraFromSession(merged, sessionListing) {
  if (!sessionListing || !sessionListing.listing_extra || typeof sessionListing.listing_extra !== "object") return;
  const src = sessionListing.listing_extra.grailed;
  if (!src || typeof src !== "object") return;
  if (!merged.listing_extra) merged.listing_extra = {};
  if (!merged.listing_extra.grailed) merged.listing_extra.grailed = {};
  const dest = merged.listing_extra.grailed;
  const keys = ["department"];
  for (const k of keys) {
    const sv = src[k];
    if (sv == null) continue;
    if (typeof sv === "string" && sv.trim() === "") continue;
    dest[k] = sv;
  }
}

function setMagicFillLoading(loading) {
  const btn = document.getElementById("magic-fill");
  if (!btn) return;
  btn.classList.toggle("is-loading", loading);
  btn.setAttribute("aria-busy", loading ? "true" : "false");
  btn.disabled = loading;
  try {
    const plat = (document.getElementById("magic-platform-label")?.textContent || "").trim() || "marketplace";
    btn.setAttribute("aria-label", loading ? `Filling listing in ${plat}, please wait` : `Fill listing in ${plat}`);
  } catch {
    /* ignore */
  }
}

async function runMagicFill() {
  const fillStartedAt = Date.now();
  setMagicFillLoading(true);
  // Immediate feedback: button spinner + status line.
  setStatus("Filling…");
  try {
    syncPayloadFromReviewFields();
    const platform = getSelectedPlatform();
    if (!platform) {
      setStatus("Choose a platform in step 2 first.");
      return;
    }
    if (!lastPayload || !lastPayload.title) {
      setStatus("Add a title to continue — or scan with your phone to import a listing.");
      return;
    }
    const platformName =
      (document.getElementById("magic-platform-label")?.textContent || "").trim() || platform;
    setStatus(`Filling in ${platformName}…`);
    /** Same canonical session as “Open full review in browser” — merge so empty popup fields still get API data. */
    let merged = {
      title: lastPayload.title,
      description: lastPayload.description,
      price: lastPayload.price,
      listing_extra: lastPayload.listing_extra,
      image_url: lastPayload.image_url,
    };
    try {
      const j = await pollSession(snapPairSessionId);
      if (j && !j.empty && j.listing) {
        const L = j.listing;
        const sesT = L.title != null ? String(L.title).trim() : "";
        const sesD = L.description != null ? String(L.description).trim() : "";
        const popD = (merged.description || "").trim();
        /** Full review save → session is source of truth over stale popup fields. */
        if (sesT) merged.title = sesT;
        merged.description = sesD || popD;
        if (L.price != null && String(L.price).trim() !== "") {
          merged.price =
            typeof L.price === "number" && Number.isFinite(L.price)
              ? String(L.price)
              : String(L.price).trim();
        }
        if (L.image_url != null && String(L.image_url).trim() !== "") {
          merged.image_url = String(L.image_url).trim();
        }
        if (L.listing_extra != null) {
          if (!merged.listing_extra) merged.listing_extra = {};
          mergeShopifyListingExtraFromSession(merged, L);
          mergeShopeeListingExtraFromSession(merged, L);
          mergeVintedListingExtraFromSession(merged, L);
          mergeEbayListingExtraFromSession(merged, L);
          mergeEtsyListingExtraFromSession(merged, L);
          mergeDepopListingExtraFromSession(merged, L);
          mergeGrailedListingExtraFromSession(merged, L);
        }
      }
    } catch {
      /* offline */
    }
    merged.description = resolveListingDescription(merged);
    const t = templateForPlatform(platform);
    const tab = await findListingTab(platform);
    if (!tab?.id) {
      setStatus("Open a listing tab for this marketplace, then try again.");
      return;
    }
    /** Fill runs in the service worker. Use callback form so we always see chrome.runtime.lastError. */
    const response = await new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          {
            type: "SYNCLYST_RUN_MAGIC_FILL",
            tabId: tab.id,
            payload: merged,
            platform,
          },
          (r) => {
            const err = chrome.runtime.lastError;
            if (err) {
              resolve({ ok: false, error: err.message || String(err) });
              return;
            }
            resolve(r);
          }
        );
      } catch (e) {
        resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    });
    if (!response || response.ok === false) {
      setStatus(
        (response && (response.error || response.message)) ||
          "Could not complete Magic Fill."
      );
      return;
    }
    if (response && response.async) {
      setStatus(
        platform === "shopify"
          ? "Running Magic Fill in your Shopify tab… (watch for the SyncLyst banner)."
          : "Filling your listing tab… spinner stops when Magic Fill finishes."
      );
      /** eBay (and similar) run deferred description / extras after the main tick loop — poll long enough. */
      const pollMs = platform === "ebay" ? 1000 : 900;
      const pollIters = platform === "ebay" ? 28 : 12;
      for (let i = 0; i < pollIters; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        const o = await storageGet([
          "synclyst_last_magic_fill_at",
          "synclyst_last_magic_fill_platform",
          "synclyst_last_magic_fill_result",
        ]);
        const res = o && o.synclyst_last_magic_fill_result;
        if (res && res.platform === platform && typeof o.synclyst_last_magic_fill_at === "number") {
          if (o.synclyst_last_magic_fill_at < fillStartedAt) continue;
          if (res.ok === false) {
            setStatus(
              res.error ||
                (platform === "shopify"
                  ? "Magic Fill failed. Refresh the Shopify tab and try again."
                  : "Magic Fill failed. Refresh the listing tab and try again.")
            );
          } else if (typeof res.filled === "number") {
            setStatus(
              res.saved
                ? `Done — filled ${res.filled} field(s) and tried Save.`
                : `Filled ${res.filled} field(s). Click Save if needed.`
            );
          } else {
            setStatus(platform === "shopify" ? "Magic Fill finished. Check your Shopify tab." : "Magic Fill finished. Check your listing tab.");
          }
          return;
        }
      }
      setStatus(
        platform === "shopify"
          ? "Still running… if Shopify is slow, refresh the tab and try again."
          : "Still running… if the listing tab is slow, wait a few seconds and check the form, then try again."
      );
      return;
    }

    const hint = t.tabHint || platform;

    if (response.filled === 0) {
      if (platform === "shopify" && response.shopify_page === "editor") {
        setStatus(
          "On Add product, but no fields were found. Refresh the Shopify tab, wait for the form to load, then try again."
        );
        return;
      }
      setStatus(
        `No fields filled on this page. Open the product or listing editor (${hint}), refresh the tab, then try again.`
      );
      return;
    }
    if (response.saved) {
      if (platform === "shopify") {
        setStatus(
          `Filled ${response.filled} field(s) and triggered Save. In Products, check All and Draft (new products are often draft). If nothing new appears, look for red errors on the page and click Save manually.`
        );
      } else {
        setStatus(
          `Done — filled ${response.filled} field(s) and triggered Save. Check your ${hint} listing list.`
        );
      }
      return;
    }
    if (platform === "shopify") {
      setStatus(
        `Filled ${response.filled} field(s) but could not trigger Save automatically. In the Shopify tab, fix any red errors, enter a valid price if the form requires it, then click Save or Save as draft.`
      );
    } else {
      setStatus(
        `Filled ${response.filled} field(s). Save wasn’t clicked automatically — click Save (or List item) in the ${hint} tab.`
      );
    }
  } finally {
    setMagicFillLoading(false);
  }
}

function cleanupRealtime() {
  try {
    if (realtimeChannel && supabaseClient) {
      supabaseClient.removeChannel(realtimeChannel);
    }
  } catch {
    /* ignore */
  }
  realtimeChannel = null;
  supabaseClient = null;
}

window.addEventListener("beforeunload", () => {
  if (pollTimer) clearInterval(pollTimer);
  cleanupRealtime();
  const qrImg = document.getElementById("qr-img");
  if (qrImg) revokePrevQrObjectUrl(qrImg);
});

(async function init() {
  try {
    // Boot: show only a simple spinner while we resolve session/origin/QR.
    const bootLoader = document.getElementById("boot-loader");
    bootLoader?.classList.remove("hidden");

    chrome.action.setBadgeText({ text: "" });
    const name = chrome.runtime.getManifest && chrome.runtime.getManifest().name;
    chrome.action.setTitle({ title: name || "SyncLyst" });
  } catch {
    /* ignore */
  }

  // Wire this immediately so the logo always works, even before async init finishes.
  try {
    wireBrandHome();
  } catch {
    /* ignore */
  }

  try {
    wireBillingSettings();
    wireLibraryOverlay();
    const sessionId = await getSessionId();
    snapPairSessionId = sessionId;
    if (!sessionId) {
      setLiveLabel("Error");
      return;
    }
    setLiveLabel("Live");

    /**
     * Resolve origin *before* drawing the phone QR. The first-paint `http://127.0.0.1:3000/...` URL is
     * not openable on a phone (loopback = the device itself) and iOS / Android often only offer
     * "copy" for that payload instead of "open in browser". `resolveSynclystOrigin` finds https://
     * synclyst.app, localhost/LAN:port the phone can reach, etc.
     */
    try {
      SYNCLYST_ORIGIN = await resolveSynclystOrigin();
    } catch {
      SYNCLYST_ORIGIN = SYNCLYST_ORIGIN_DEFAULT;
    }

    ensurePairingStepControls();
    wireSnapPairCtaButtons();
    void readDraftLibrary().then((list) => updateLibraryBarUI(list));
    const codeEl0 = document.getElementById("pair-session-code");
    if (codeEl0) codeEl0.textContent = sessionId;
    const pairUrlForQr = getPhoneQrUrl();
    const qrEl = document.getElementById("qr-img");
    if (qrEl && pairUrlForQr) {
      await setQrSrc(qrEl, pairUrlForQr);
    }
    try {
      document.getElementById("boot-loader")?.classList.add("hidden");
    } catch {
      /* ignore */
    }

    await registerSession(sessionId);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const sidCh = changes.snap_pair_session_id;
      if (sidCh && sidCh.newValue != null) {
        const next = String(sidCh.newValue).trim();
        if (/^[a-f0-9]{12,32}$/i.test(next) && next !== snapPairSessionId) {
          /** /snap?s=… updated storage (e.g. new tab or bookmark) — reload so QR + poll match the session. */
          window.location.reload();
          return;
        }
      }
      if (!changes[STORAGE_SNAP_LISTING_READY_AT]) return;
      const nv = changes[STORAGE_SNAP_LISTING_READY_AT].newValue;
      if (nv == null) return;
      const ts = typeof nv === "number" ? nv : Number(nv);
      if (!Number.isFinite(ts) || Date.now() - ts > SNAP_LISTING_READY_MAX_AGE_MS) {
        try {
          chrome.storage.local.remove([STORAGE_SNAP_LISTING_READY_AT], () => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
        return;
      }
      void (async () => {
        try {
          SYNCLYST_ORIGIN = await resolveSynclystOrigin();
        } catch {
          /* ignore */
        }
        // A new scan/upload finished on the phone; don't show stale or blank fields—wait until the session has content.
        listingHydrated = false;
        lastPayload = null;
        lastAppliedListingStamp = null;
        lastAppliedImageUrl = null;
        setReviewLoadingState(true, "Extracting your listing…");
        continueToListing();
        burstPollUntilListing(snapPairSessionId);
      })();
    });

    /** If /snap iframe fired complete before this listener attached (cold openPopup), still jump to step 2. */
    try {
      chrome.storage.local.get([STORAGE_SNAP_LISTING_READY_AT], (o) => {
        const ts0 = o && o[STORAGE_SNAP_LISTING_READY_AT];
        /** No max age — pairing / upload can finish while the user is away; still jump to listing when they open the popup. */
        const ts = typeof ts0 === "number" ? ts0 : Number(ts0);
        if (!Number.isFinite(ts)) return;
        if (Date.now() - ts > SNAP_LISTING_READY_MAX_AGE_MS) {
          try {
            chrome.storage.local.remove([STORAGE_SNAP_LISTING_READY_AT], () => {
              /* ignore */
            });
          } catch {
            /* ignore */
          }
          return;
        }
        void (async () => {
          try {
            SYNCLYST_ORIGIN = await resolveSynclystOrigin();
          } catch {
            /* ignore */
          }
          setReviewLoadingState(true, "Extracting your listing…");
          continueToListing();
          burstPollUntilListing(snapPairSessionId);
        })();
      });
    } catch {
      /* ignore */
    }

    const uiPrefs = await storageGet([STORAGE_LAST_PLATFORM, STORAGE_PREFERS_QR_HOME]);

    const cfg = await fetchConfig();
    const g = typeof window !== "undefined" ? window : {};
    const createClient =
      (g.supabase && g.supabase.createClient) ||
      (g.supabase && g.supabase.default && g.supabase.default.createClient);

    if (cfg.configured && cfg.supabaseUrl && cfg.supabaseAnonKey && createClient) {
      setLiveLabel("Live");
      supabaseClient = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
      realtimeChannel = supabaseClient
        .channel(`snap_pair_${sessionId}`)
        .on(
          "postgres_changes",
          {
            event: "*",
            schema: "public",
            table: "snap_pair_sessions",
            filter: `session_id=eq.${sessionId}`,
          },
          () => {
            /** Realtime can fire before the row is readable; burst mirrors phone-upload path. */
            burstPollUntilListing(snapPairSessionId, { stepMs: 300, maxAttempts: 20 });
          }
        )
        .subscribe();
    } else {
      setLiveLabel("Live");
    }

    /** HTTP poll always: Realtime can miss (RLS, publication, flaky channel) — same path as dev-memory. */
    pollTimer = setInterval(async () => {
      const j = await pollSession(sessionId);
      if (j && !j.empty && j.listing && sessionListingHasContent(j.listing)) applyListing(j.listing);
    }, 800);

    const initial = await pollSession(sessionId);
    if (initial && !initial.empty && initial.listing && sessionListingHasContent(initial.listing)) {
      applyListing(initial.listing);
    }
    refreshLoadedSubstate();

    let savedPlatform = normalizeLegacyPlatformId(uiPrefs[STORAGE_LAST_PLATFORM]);
    if (savedPlatform !== uiPrefs[STORAGE_LAST_PLATFORM]) {
      chrome.storage.local.set({ [STORAGE_LAST_PLATFORM]: savedPlatform });
    }
    if (savedPlatform && PLATFORM_REVIEW_TEMPLATES[savedPlatform]) {
      setSelectedPlatform(savedPlatform);
    }

    document.getElementById("platform-grid")?.addEventListener("click", (e) => {
      const btn = e.target && e.target.closest && e.target.closest(".platform-tile");
      if (!btn || !btn.dataset.platform) return;
      if (btn.disabled || btn.classList.contains("platform-tile--coming-soon")) return;
      if (!ALLOWED_PLATFORMS.has(String(btn.dataset.platform).toLowerCase())) return;
      setSelectedPlatform(btn.dataset.platform);
    });

    document.getElementById("magic-fill")?.addEventListener("click", runMagicFill);
    document.getElementById("btn-open-full-review")?.addEventListener("click", openFullReviewInBrowser);
    // (wired early in init)
    document.getElementById("btn-continue-listing")?.addEventListener("click", continueToListing);
    document.getElementById("btn-waiting-back-to-qr")?.addEventListener("click", showQrHomeView);
    updateFullReviewButton();

    ["review-title", "review-description", "review-price"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", () => syncPayloadFromReviewFields());
    });

    document.getElementById("btn-new-pairing-session")?.addEventListener("click", () => {
      setStatus("");
      chrome.runtime.sendMessage({ type: "SYNCLYST_NEW_SESSION" }, (r) => {
        if (chrome.runtime.lastError || !r || !r.ok) {
          setStatus("Could not create a new pairing code. Try again.");
          return;
        }
        window.location.reload();
      });
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const el = document.getElementById("boot-error");
    if (el) {
      el.textContent =
        "Could not finish loading (" +
        msg +
        "). Reload the extension on chrome://extensions. For local dev, run npm run dev in auralink-ai/frontend.";
      el.classList.remove("hidden");
    }
    setLiveLabel("Error");
    console.error("[SyncLyst popup]", e);
  }
})();
