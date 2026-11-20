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

// When the shop has switched its Gallery on, add it to the shop menu on every public page.
(function () {
  const add = () => {
    const nav = document.querySelector('.shop-brand nav');
    if (!nav || nav.querySelector('a[href="/gallery"]')) return;
    fetch('/api/settings').then((r) => r.json()).then((s) => {
      if (!s || !s.gallery_on || nav.querySelector('a[href="/gallery"]')) return;
      const a = document.createElement('a');
      a.href = '/gallery';
      if (/^\/gallery/.test(location.pathname)) { a.className = 'on'; nav.querySelectorAll('a.on').forEach((x) => x.classList.remove('on')); }
      a.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M5 17l4.5-4.5 3 3 2.5-2.5 4 4"/></svg><span>Gallery</span>';
      nav.appendChild(a);
    }).catch(() => {});
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', add); else add();
})();
