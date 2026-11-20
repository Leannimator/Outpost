/* Remembers which tracked link a shopper arrived by (the "?s=code" in the address) for this browser tab only.
   It is kept in the tab's own session storage, not a cookie, and goes nowhere until the shopper checks out, where the server
   checks it against the owner's link list. */
(function () {
  try {
    const q = new URLSearchParams(location.search).get('s');
    if (q && /^[a-z0-9][a-z0-9_-]{0,29}$/i.test(q)) sessionStorage.setItem('outpost-src', q);
  } catch (e) { /* storage blocked: the sale just counts as direct */ }
})();
window.outpostSource = function () { try { return sessionStorage.getItem('outpost-src') || ''; } catch (e) { return ''; } };
