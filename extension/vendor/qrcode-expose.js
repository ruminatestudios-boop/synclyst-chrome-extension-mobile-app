/**
 * Pin the Kazuhiko Arase factory on globalThis so popup code does not lose the
 * reference if another vendor script touches globals.
 */
(function () {
  var g = typeof globalThis !== "undefined" ? globalThis : window;
  var f = g.qrcode;
  if (typeof f === "function") {
    g.__SYNCLYST_QRCODE = f;
  }
})();
