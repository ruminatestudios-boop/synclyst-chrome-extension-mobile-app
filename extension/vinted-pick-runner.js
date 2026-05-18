/**
 * Page-context script: Vinted’s “Suggested” row is wired to the **radio** (and often a `<label>`).
 * We pick the radio by row text first, then click label → row → radio + native `checked`.
 */
(function () {
  var jsonEl = document.getElementById("synclyst-vinted-pick-json");
  if (!jsonEl) return;
  var segments = [];
  var categoryStr = "";
  try {
    var o = JSON.parse(jsonEl.textContent || "{}");
    segments = Array.isArray(o.segments) ? o.segments : [];
    categoryStr = o.categoryStr != null ? String(o.categoryStr) : "";
  } catch (e) {
    return;
  }
  try {
    jsonEl.remove();
  } catch (e) {
    /* ignore */
  }

  function allDeep(sel, root) {
    var out = [];
    function scan(n) {
      if (!n || !n.querySelectorAll) return;
      try {
        n.querySelectorAll(sel).forEach(function (e) {
          out.push(e);
        });
      } catch (e) {
        /* ignore */
      }
      try {
        n.querySelectorAll("*").forEach(function (el) {
          if (el.shadowRoot) scan(el.shadowRoot);
        });
      } catch (e) {
        /* ignore */
      }
    }
    scan(root || document.documentElement || document.body);
    return out;
  }

  function pickDialog() {
    var roots = [];
    if (document.body) roots.push(document.body);
    if (document.documentElement) roots.push(document.documentElement);
    var best = null;
    var bestSc = 0;
    function scorePanel(el) {
      if (!el || !el.textContent) return 0;
      var t = String(el.textContent || "")
        .slice(0, 1600)
        .toLowerCase();
      var s = 0;
      if (t.indexOf("women") !== -1 && t.indexOf("men") !== -1) s += 42;
      else if (t.indexOf("women") !== -1 || t.indexOf("men") !== -1) s += 22;
      if (t.indexOf("kids") !== -1) s += 10;
      if (
        t.indexOf("find a category") !== -1 ||
        t.indexOf("search categories") !== -1 ||
        t.indexOf("search for a category") !== -1
      )
        s += 34;
      if (t.indexOf("suggested") !== -1 || t.indexOf("catalogue") !== -1 || t.indexOf("catalog sections") !== -1)
        s += 18;
      return s;
    }
    for (var ri = 0; ri < roots.length; ri++) {
      var list = allDeep('[role="dialog"],[aria-modal="true"]', roots[ri]);
      for (var i = 0; i < list.length; i++) {
        var el = list[i];
        var s = scorePanel(el);
        if (s > bestSc) {
          bestSc = s;
          best = el;
        }
      }
    }
    if (bestSc < 50) {
      var inputs = allDeep("input", document.body);
      for (var ii = 0; ii < inputs.length; ii++) {
        var inp = inputs[ii];
        if (!inp || inp.disabled) continue;
        var ty = String(inp.type || "").toLowerCase();
        if (ty === "hidden" || ty === "checkbox" || ty === "radio" || ty === "file") continue;
        var ph = String(inp.getAttribute("placeholder") || "").toLowerCase();
        if (!/\b(find a category|categor|search)\b/.test(ph) && ty !== "search") continue;
        var p = inp.parentElement;
        for (var d = 0; d < 22 && p; d++) {
          if (p === document.body || p === document.documentElement) break;
          var r;
          try {
            r = p.getBoundingClientRect();
          } catch (e) {
            p = p.parentElement;
            continue;
          }
          if (r.width < 44 || r.height < 44) {
            p = p.parentElement;
            continue;
          }
          var s2 = scorePanel(p);
          if (s2 > bestSc) {
            bestSc = s2;
            best = p;
          }
          p = p.parentElement;
        }
      }
    }
    return bestSc >= 10 ? best : null;
  }

  function rowTextForInput(inp) {
    var best = "";
    var cur = inp;
    for (var d = 0; d < 16 && cur; d++) {
      try {
        var t = String(cur.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (t.length > best.length && t.length < 520) best = t;
      } catch (e) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    return best.toLowerCase();
  }

  function scoreSuggestedRow(tl, last, catLow) {
    if (!tl) return 0;
    var s = 0;
    if (/print/.test(tl) && /t[\s-]*shirts?|t[\s-]*shirt|tee/.test(tl)) s += 95;
    if (/[>›»→|]/.test(tl)) s += 40;
    if (/suggested/.test(tl)) s += 12;
    if (last.length > 1 && tl.indexOf(last) !== -1) s += 55;
    if (catLow.length > 4) {
      var h = catLow.slice(0, 40);
      if (h && tl.indexOf(h) !== -1) s += 45;
    }
    return s;
  }

  function visibleRowForInput(inp) {
    var cur = inp.parentElement;
    for (var d = 0; d < 18 && cur; d++) {
      try {
        var r = cur.getBoundingClientRect();
        var t = String(cur.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        if (r.height >= 20 && r.width >= 68 && t.length >= 8 && t.length < 520) {
          var st = window.getComputedStyle(cur);
          if (st.display !== "none" && st.visibility !== "hidden") return cur;
        }
      } catch (e) {
        /* ignore */
      }
      cur = cur.parentElement;
    }
    return inp;
  }

  function fireClickAt(el, cx, cy) {
    function fire(Ctor, type, extra) {
      try {
        var o = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: cx,
          clientY: cy,
          view: window,
          button: 0,
        };
        if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) o[k] = extra[k];
        el.dispatchEvent(new Ctor(type, o));
      } catch (e) {
        /* ignore */
      }
    }
    try {
      fire(PointerEvent, "pointerdown", {
        buttons: 1,
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
      });
    } catch (e) {
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
    } catch (e) {
      /* ignore */
    }
    fire(MouseEvent, "mouseup", { buttons: 0 });
    fire(MouseEvent, "click", {});
    try {
      el.click();
    } catch (e) {
      /* ignore */
    }
  }

  function activateTarget(target, dlg) {
    if (!target) return;
    try {
      target.scrollIntoView({ block: "nearest", behavior: "auto" });
    } catch (e) {
      /* ignore */
    }
    var br = target.getBoundingClientRect();
    var cy = br.top + br.height / 2;
    var cxs = [br.right - 8, br.left + br.width * 0.55, br.left + br.width * 0.15];
    for (var i = 0; i < cxs.length; i++) {
      fireClickAt(target, Math.min(cxs[i], br.right - 2), cy);
    }
    for (var xi = 0; xi < cxs.length; xi++) {
      var stack;
      try {
        stack = document.elementsFromPoint(Math.min(cxs[xi], br.right - 2), cy);
      } catch (e) {
        continue;
      }
      if (!stack) continue;
      for (var si = 0; si < Math.min(12, stack.length); si++) {
        var hit = stack[si];
        if (!hit || !target.contains(hit)) continue;
        try {
          hit.click();
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  function setRadioChecked(inp) {
    try {
      var proto = Object.getPrototypeOf(inp);
      var d = Object.getOwnPropertyDescriptor(proto, "checked");
      if (d && d.set) d.set.call(inp, true);
      else inp.checked = true;
    } catch (e) {
      try {
        inp.checked = true;
      } catch (e2) {
        /* ignore */
      }
    }
    try {
      inp.dispatchEvent(new Event("input", { bubbles: true }));
      inp.dispatchEvent(new Event("change", { bubbles: true }));
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof HTMLInputElement !== "undefined" && HTMLInputElement.prototype.click) {
        HTMLInputElement.prototype.click.call(inp);
      } else {
        inp.click();
      }
    } catch (e) {
      /* ignore */
    }
  }

  try {
    var dlg = pickDialog();
    if (!dlg) return;

    var last = String((segments && segments[segments.length - 1]) || "")
      .trim()
      .toLowerCase();
    var catLow = String(categoryStr || "")
      .toLowerCase()
      .replace(/\s*[>›»→|]\s*/g, " ")
      .trim();

    var radios = allDeep('input[type="radio"]:not([disabled])', dlg);
    var bestInp = null;
    var bestSc = -1;
    for (var ri = 0; ri < radios.length; ri++) {
      var inp = radios[ri];
      if (!inp || inp.type !== "radio") continue;
      var tl = rowTextForInput(inp);
      var sc = scoreSuggestedRow(tl, last, catLow);
      if (sc > bestSc) {
        bestSc = sc;
        bestInp = inp;
      }
    }

    if (bestInp && bestSc >= 42) {
      var row = visibleRowForInput(bestInp);
      try {
        if (bestInp.labels && bestInp.labels.length) {
          bestInp.labels[0].click();
        }
      } catch (e) {
        /* ignore */
      }
      activateTarget(row, dlg);
      activateTarget(bestInp, dlg);
      setRadioChecked(bestInp);
      return;
    }

    /* Fallback: no confident radio — pick smallest row-like element with breadcrumb + print/t-shirt */
    var best = null;
    var bestRank = 1e30;
    var nodes = allDeep(
      'div,li,button,label,span,a,article,section,[role="button"],[role="option"],[role="radio"],[role="row"]',
      dlg
    );
    for (var j = 0; j < nodes.length; j++) {
      var el = nodes[j];
      var r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 12 || r.height > 280) continue;
      var st;
      try {
        st = window.getComputedStyle(el);
      } catch (e) {
        continue;
      }
      if (st.display === "none" || st.visibility === "hidden") continue;
      var txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length < 8 || txt.length > 500) continue;
      var tlow = txt.toLowerCase();
      var hit = /print/.test(tlow) && /t[\s-]*shirts?|tee/.test(tlow);
      if (!hit && /[>›»→|]/.test(txt) && last.length > 1 && tlow.indexOf(last) !== -1) hit = true;
      if (!hit) continue;
      var a = r.width * r.height;
      if (a > 700000) continue;
      var h = r.height;
      var rank = (h >= 14 && h <= 200 ? 0 : 1) * 1e15 + a;
      if (rank < bestRank) {
        bestRank = rank;
        best = el;
      }
    }
    if (!best) return;
    activateTarget(best, dlg);
    var inp2 = null;
    try {
      inp2 = best.querySelector('input[type="radio"]:not([disabled])');
    } catch (e) {
      /* ignore */
    }
    if (!inp2) {
      for (var rj = 0; rj < radios.length; rj++) {
        if (best.contains(radios[rj])) {
          inp2 = radios[rj];
          break;
        }
      }
    }
    if (inp2) setRadioChecked(inp2);
  } catch (e) {
    /* ignore */
  }
})();
