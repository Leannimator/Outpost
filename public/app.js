/* Outpost — staff app (register, products, auctions, orders, settings) */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dollars = (c) => (c / 100).toFixed(2);
  // Strict: 12  12.5  $12.50  12,50 (decimal comma)  1,250  1,250.50 are understood; "1e2", "1,2,3", "12.345" and words are NaN. (Same rules as the server.)
  const toCents = (input) => {
    const t = String(input == null ? '' : input).trim().slice(0, 30).replace(/^\$\s*/, '');
    let m;
    if (!t) return NaN;
    if ((m = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(t))) return Number(m[1].replace(/,/g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    if ((m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(t))) return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    return NaN;
  };
  const fmtDate = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const pad = (n) => String(n).padStart(2, '0');
  const toLocalInput = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const countdown = (ms) => {
    if (ms <= 0) return 'Ended';
    const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return d > 0 ? `${d}d ${h}h ${m}m` : `${pad(h)}:${pad(m)}:${pad(s % 60)}`;
  };

  // storage that never throws (private windows, previews)
  const mem = {};
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return mem[k] || null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { mem[k] = v; } },
    del(k) { try { sessionStorage.removeItem(k); } catch { delete mem[k]; } },
  };
  // Remembers this browser as the owner's, so strangers' failed guesses can't lock the owner out of it (kept longer than a tab).
  const device = {
    get() { try { return localStorage.getItem('outpost_device') || ''; } catch { return ''; } },
    set(v) { try { localStorage.setItem('outpost_device', v); } catch { /* not remembered */ } },
  };

  const ICONS = {
    sell: '<path d="M6 7h12l-1 12H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    auctions: '<path d="M13 4l7 7-3 3-7-7z"/><path d="M10 7L5 12l3 3 5-5"/><path d="M4 20h9"/><path d="M8 15l-3 3"/>',
    shop: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M5 12v8h14v-8"/>',
    products: '<path d="M4 8l8-4 8 4v8l-8 4-8-4V8z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
    orders: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h4"/>',
    marketing: '<path d="M4 10v4h3l7 4V6L7 10H4z"/><path d="M17 9a4 4 0 0 1 0 6"/>',
    security: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"/><path d="M9 12l2 2 4-4"/>',
    settings: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2" fill="var(--cream-2)"/><circle cx="15" cy="12" r="2" fill="var(--cream-2)"/><circle cx="8" cy="17" r="2" fill="var(--cream-2)"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
    customers: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3.5 3-5 5.5-5s5 1.5 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.7.6 2.6 2 2.9 4.5"/>',
    reports: '<path d="M5 20V10M10 20V5M15 20v-8M20 20V8"/>',
    links: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    reviews: '<path d="M12 4l2.4 5 5.4.7-4 3.7 1 5.4L12 16.2 7.2 18.8l1-5.4-4-3.7 5.4-.7L12 4z"/>',
  };
  const BADGES = [['', 'No tag'], ['new', 'New'], ['last_chance', 'Last chance'], ['discontinued', 'Discontinued'], ['staff_pick', 'Staff pick']];
  const badgeLabel = (k) => (BADGES.find((b) => b[0] === k) || [0, ''])[1];
  async function download(path, name) {
    const r = await fetch(path, { headers: { 'x-admin-token': token } });
    if (!r.ok) throw new Error('Download failed');
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  ICONS.people = ICONS.customers;
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

  let token = store.get('outpost_token') || '';
  let settings = { store_name: 'Outpost', tax_rate: 0, break_on: false, break_message: '', theme: {}, logo_url: '', mascot_url: '', sold_url: '' };
  const DEFAULT_AWAY = 'Back soon! You can still look around in the meantime.';
  let appReady = false;
  let cleanups = [];
  const onLeave = (fn) => cleanups.push(fn);

  // Each screen load gets a number. An answer that arrives after you have moved to another screen is thrown away (it used to paint the OLD
  // screen's heading or fail on a page that was gone: "Cannot set properties of null").
  let routeSeq = 0;
  const NEVER = new Promise(() => {});
  async function api(path, opts = {}) {
    const mine = routeSeq, had = token;
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-admin-token': token, ...(opts.headers || {}) } });
    const d = await r.json().catch(() => ({}));
    // Signed out (or the session ran out) while a screen was refreshing itself in the background: stop everything and show the sign-in page once.
    if (r.status === 401 && had && token === had) { store.del('outpost_token'); token = ''; cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } }); cleanups = []; loginScreen('Please sign in again'); return NEVER; }
    if (mine !== routeSeq) return NEVER;
    if (!r.ok) { const e = new Error(d.error || 'Request failed'); e.status = r.status; throw e; }
    return d;
  }
  const post = (p, b) => api(p, { method: 'POST', body: JSON.stringify(b || {}) });
  const put = (p, b) => api(p, { method: 'PUT', body: JSON.stringify(b || {}) });

  async function uploadImage(file) {
    const r = await fetch('/api/admin/upload', {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'x-admin-token': token },
      body: file,
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || 'Upload failed');
    return d.url;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2400);
  }

  function openModal(html, { wide = false } = {}) {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal"${wide ? ' style="max-width:540px"' : ''}>${html}</div>`;
    document.body.appendChild(back);
    return { el: back.firstElementChild, close: () => back.remove() };
  }

  // A small yes/no box in the same style, for things that can't be undone or that would throw work away.
  function confirmBox({ title, body, yes = 'Yes', no = 'Cancel', danger = false }) {
    return new Promise((resolve) => {
      const cm = openModal(`<h2 style="font-size:22px;margin-bottom:8px">${esc(title)}</h2><p class="muted" style="margin:0 0 14px;line-height:1.45">${body}</p>
        <div class="row" style="gap:10px;justify-content:center"><button class="btn" data-n>${esc(no)}</button><button class="btn btn-primary" data-y${danger ? ' style="background:var(--bad,#b42318)"' : ''}>${esc(yes)}</button></div>`);
      cm.el.setAttribute('role', 'alertdialog'); cm.el.setAttribute('aria-modal', 'true');
      const end = (v) => { document.removeEventListener('keydown', onKey); cm.close(); resolve(v); };
      const onKey = (ev) => { if (ev.key === 'Escape') end(false); };
      document.addEventListener('keydown', onKey);
      cm.el.querySelector('[data-n]').onclick = () => end(false); cm.el.querySelector('[data-y]').onclick = () => end(true);
      cm.el.querySelector(danger ? '[data-n]' : '[data-y]').focus();
    });
  }
  // Ask for a short piece of text in a box that matches the app (instead of the browser's own pop-up).
  function askText({ title, label, placeholder = '', yes = 'Save' }) {
    return new Promise((resolve) => {
      const cm = openModal(`<h2 style="font-size:22px;margin-bottom:8px">${esc(title)}</h2><label class="field" style="text-align:left"><span class="label">${esc(label)}</span><input class="input" data-v maxlength="60" placeholder="${esc(placeholder)}"></label>
        <div class="row" style="gap:10px;justify-content:center;margin-top:10px"><button class="btn" data-n>Cancel</button><button class="btn btn-primary" data-y>${esc(yes)}</button></div>`);
      const inp = cm.el.querySelector('[data-v]'); inp.focus();
      const end = (v) => { document.removeEventListener('keydown', onKey); cm.close(); resolve(v); };
      const onKey = (ev) => { if (ev.key === 'Escape') end(null); };
      document.addEventListener('keydown', onKey);
      inp.onkeydown = (ev) => { if (ev.key === 'Enter') end(inp.value.trim() || null); };
      cm.el.querySelector('[data-n]').onclick = () => end(null); cm.el.querySelector('[data-y]').onclick = () => end(inp.value.trim() || null);
    });
  }
  // When the browser won't copy for us: show the text ready to select, in a box that matches the app.
  function copyBox(title, text) {
    const cm = openModal(`<h2 style="font-size:22px;margin-bottom:8px">${esc(title)}</h2><input class="input" data-v readonly value="${esc(text)}" style="margin-bottom:12px"><div class="row" style="justify-content:center"><button class="btn btn-primary" data-x>Done</button></div>`);
    const inp = cm.el.querySelector('[data-v]'); inp.focus(); inp.select(); cm.el.querySelector('[data-x]').onclick = cm.close;
  }
  // Close button for an editor: nothing happens silently to unsaved work.
  const guardClose = (m, isDirty) => async () => {
    if (!isDirty()) return m.close();
    if (await confirmBox({ title: 'Close without saving?', body: 'You have changes that haven’t been saved. They’ll be lost.', yes: 'Discard changes', no: 'Keep editing', danger: true })) m.close();
  };

  const pic = (url, name, cls = 'thumb') => url
    ? `<img class="${cls}" src="${esc(url)}" alt="">`
    : `<div class="${cls} ph">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;

  const view = () => $('#view');

  // ---------- login ----------
  function loginScreen(msg) {
    appReady = false;
    let pending = null; // password, once it has been accepted and a code is needed
    const shell = (inner) => `
      <div class="login-wrap"><div class="login-col"><div class="login card">
        <span class="wordmark" data-brand="name">Outpost</span>${inner}
      </div>
      <div class="login-shop"><div>Looking to shop?</div><a class="btn btn-block" href="/shop">Take me to the shop →</a></div></div></div>`;
    const finish = (d) => { token = d.token; store.set('outpost_token', token); if (d.device_token) device.set(d.device_token); init(); };
    function passwordStep(m) {
      pending = null;
      document.body.innerHTML = shell(`
        <p class="muted">Sign in to your shop</p>
        <input class="input" id="pw" type="password" placeholder="Password" autocomplete="current-password">
        <button class="btn btn-primary btn-block mt" id="go">Sign in</button>
        <div id="lerr">${m ? `<div class="msg err">${esc(m)}</div>` : ''}</div>
        <p class="hint">You stay signed in for 12 hours, or until you sign out. Too many wrong tries pauses sign-in for 15 minutes.</p>`);
      paintBrand();
      const go = async () => {
        const password = $('#pw').value;
        $('#go').disabled = true;
        try {
          const d = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': device.get() }, body: JSON.stringify({ password }) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; });
          if (d.need_code) { pending = password; return codeStep(); }
          finish(d);
        } catch (e) { $('#lerr').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#go').disabled = false; }
      };
      $('#go').onclick = go;
      $('#pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      $('#pw').focus();
    }
    function codeStep(recovery, m) {
      document.body.innerHTML = shell(`
        <p class="muted">${recovery ? 'Enter one of your recovery codes' : 'Enter the 6-digit code from your authenticator app'}</p>
        <input class="input" id="cd" ${recovery ? 'placeholder="xxxx-xxxx" autocomplete="off"' : 'inputmode="numeric" maxlength="7" placeholder="123456" autocomplete="one-time-code"'} style="text-align:center;font-size:20px;letter-spacing:.1em">
        <button class="btn btn-primary btn-block mt" id="go">Confirm</button>
        <div id="lerr">${m ? `<div class="msg err">${esc(m)}</div>` : ''}</div>
        <p class="hint" style="text-align:center">${recovery ? '<button class="link-btn" id="swap">Use my authenticator app instead</button>' : 'Lost your phone? <button class="link-btn" id="swap">Use a recovery code</button>'}</p>
        <p class="hint" style="text-align:center"><button class="link-btn" id="again">← Start over</button></p>`);
      paintBrand();
      const go = async () => {
        const v = $('#cd').value; $('#go').disabled = true;
        try {
          const d = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-device-token': device.get() }, body: JSON.stringify({ password: pending, [recovery ? 'recovery' : 'code']: v }) }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) { const e = new Error(j.error || 'Something went wrong'); e.status = r.status; throw e; } return j; });
          finish(d);
        } catch (e) { if (e.status === 429) return passwordStep(e.message); codeStep(recovery, e.message); }
      };
      $('#go').onclick = go;
      $('#cd').onkeydown = (e) => { if (e.key === 'Enter') go(); };
      $('#swap').onclick = () => codeStep(!recovery);
      $('#again').onclick = () => passwordStep();
      $('#cd').focus();
    }
    passwordStep(msg);
  }

  // ---------- shell + router ----------
  const NAV = [['sell', 'In person', '#/sell'], ['auctions', 'Auctions', '#/auctions'], ['products', 'Products', '#/products'], ['orders', 'Orders', '#/orders'], ['people', 'People', '#/people'], ['marketing', 'Marketing', '#/marketing'], ['links', 'Link page', '#/links'], ['reports', 'Reports', '#/reports'], ['settings', 'Settings', '#/settings'], ['security', 'Security', '#/security']];
  const NAV_HEADS = { sell: 'Sell', people: 'People', marketing: 'Marketing', links: 'Shop & site' };

  function paintResting() { const el = document.getElementById('resting'); if (el) el.hidden = !settings.break_on; }
  function paintBrand() { if (window.OutpostBrand) OutpostBrand.apply(settings); paintResting(); }

  function shell() {
    document.body.innerHTML = `
      <div class="app">
        <aside class="side">
          <a class="wordmark" href="#/sell" data-brand="name">Outpost</a>
          <nav class="nav">${NAV.map(([k, label, href]) => `${NAV_HEADS[k] ? `<div class="nav-h">${NAV_HEADS[k]}</div>` : ''}<a href="${href}" data-k="${k}">${icon(k)}<span>${label}</span></a>`).join('')}<a class="ext" href="store.html" target="_blank" rel="noopener" title="Opens your shop the way shoppers see it">${icon('shop')}<span>View shop</span></a></nav>
          <div class="side-foot">
            <a class="resting-pill" id="resting" href="#/settings" hidden>Online shop is resting</a>
            <img class="side-art" data-brand="mascot" alt="" hidden>
            <button class="btn btn-ghost btn-sm btn-block" id="signout">Sign out</button>
          </div>
        </aside>
        <main class="main" id="view"></main>
      </div>`;
    $('#signout').onclick = async () => { try { await post('/api/admin/logout'); } catch { /* already signed out */ } store.del('outpost_token'); token = ''; loginScreen(); };
    paintBrand();
    appReady = true;
  }

  const routes = [
    [/^#\/sell$/, viewSell, 'sell'], [/^#\/products$/, viewProducts, 'products'],
    [/^#\/products\/(new|\d+)$/, viewEditor, 'products'], [/^#\/lines$/, viewLines, 'products'], [/^#\/auctions$/, viewAuctions, 'auctions'],
    [/^#\/auctions\/new$/, viewNewAuction, 'auctions'], [/^#\/orders$/, viewOrders, 'orders'],
    [/^#\/people(?:\/(customers|email|reviews))?$/, viewPeople, 'people'], [/^#\/reports$/, viewReports, 'reports'], [/^#\/links$/, viewLinks, 'links'],
    [/^#\/marketing(?:\/(calendar|gallery|ready|email|links|sources))?$/, viewMarketing, 'marketing'], [/^#\/settings$/, viewSettings, 'settings'], [/^#\/security$/, viewSecurity, 'security'],
  ];

  async function route() {
    if (!appReady) return;
    paintBrand();
    routeSeq++;
    cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
    cleanups = [];
    const h = location.hash || '#/sell';
    const moved = { '#/customers': '#/people', '#/reviews': '#/people/reviews' };
    if (moved[h]) { location.replace(moved[h]); return; }
    for (const [re, fn, key] of routes) {
      const m = h.match(re);
      if (!m) continue;
      document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.k === key));
      try { await fn(m); }
      catch (e) {
        if (e.status === 401) { store.del('outpost_token'); token = ''; return loginScreen('Please sign in again'); }
        view().innerHTML = `<div class="msg err">${esc(e.message)}</div>`;
      }
      return;
    }
    location.hash = '#/sell';
  }

  // =====================================================================
  // SELL
  // =====================================================================
  async function viewSell() {
    const all = await api('/api/admin/products');
    const items = all.filter((p) => p.active);
    const cart = new Map();   // key "id" or "id:variantId" -> quantity
    let q = '', cat = 'All';
    const keyOf = (id, vid, cv) => id + ':' + (vid || 0) + (cv && cv.some(Boolean) ? ':' + encodeURIComponent(JSON.stringify(cv)) : '');
    const look = (key) => {
      const parts = String(key).split(':'), id = Number(parts[0]), vid = Number(parts[1] || 0);
      let cv = []; try { if (parts[2]) cv = JSON.parse(decodeURIComponent(parts[2])); } catch {}
      const p = items.find((x) => x.id === id), v = vid && p ? p.variants.find((x) => x.id === vid) : null;
      return { p, v, id, vid: vid || 0, cv, price: v ? v.price_cents : p.price_cents, name: v ? `${p.name} (${v.name})` : p.name, stock: v ? v.stock : p.stock };
    };
    const priceText = (p) => { if (!p.variants.length) return fmt(p.price_cents); const ps = p.variants.map((v) => v.price_cents); const lo = Math.min(...ps); return Math.max(...ps) > lo ? 'From ' + fmt(lo) : fmt(lo); };
    const cats = ['All', ...new Set(items.map((p) => p.category).filter(Boolean))];
    const rate = Number(settings.tax_rate) || 0;
    let code = '', quote = null, qseq = 0;

    view().innerHTML = `
      <div class="topbar"><h1>In-person sales</h1><div class="spacer"></div><div class="muted small" id="clock"></div></div>
      <p class="muted small" style="margin-top:-6px;margin-bottom:14px">For markets, events and anyone standing in front of you. No shipping here. Online orders come through your shop and show up in Orders.</p>
      <div class="sell">
        <div>
          <div class="search">${icon('search')}<input class="input" id="q" placeholder="Search, or scan a barcode / type a SKU and press Enter" autocomplete="off"></div>
          <div class="chips" id="cats"></div>
          <div class="pgrid" id="grid"></div>
        </div>
        <div class="cart">
          <div class="cart-head"><h2 id="ctitle">Cart</h2><div class="spacer"></div><button class="link-btn" id="clear">Clear</button></div>
          <div class="cart-items" id="citems"></div>
          <div class="coderow" id="codebox" hidden><input class="input" id="code" placeholder="Discount code" autocomplete="off" maxlength="40"><button class="btn btn-sm" id="apply" type="button">Apply</button></div>
          <div class="small" id="codemsg" style="min-height:4px;margin-bottom:6px"></div>
          <div id="sums"></div>
          <div class="pay-grid">
            <button class="btn btn-primary" id="card">Card</button>
            <button class="btn" id="cash">Cash</button>
            <button class="btn" id="other">Other</button>
          </div>
          <div id="sellmsg"></div>
        </div>
      </div>`;

    const clock = () => { const el = $('#clock'); if (el) el.textContent = new Date().toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    clock(); const ct = setInterval(clock, 30000); onLeave(() => clearInterval(ct));

    function paintCats() {
      $('#cats').innerHTML = cats.length > 1 ? cats.map((c) => `<button class="chip${c === cat ? ' on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('') : '';
    }
    function paintGrid() {
      const needle = q.trim().toLowerCase();
      const list = items.filter((p) => (cat === 'All' || p.category === cat) &&
        (!needle || [p.name, p.category, p.description, p.tags.join(' '), p.sku, ...p.variants.map((v) => v.name + ' ' + v.sku)].join(' ').toLowerCase().includes(needle)));
      $('#grid').innerHTML = list.map((p) => `
        <button class="pcard${p.stock < 1 ? ' is-sold' : ''}" data-id="${p.id}" ${p.stock < 1 ? 'disabled' : ''}>
          <div class="picwrap">${pic(p.image_url, p.name, 'pic')}${p.stock < 1 ? '<span class="ptag ptag-sold">Sold out</span>' : p.badge ? `<span class="ptag ptag-seller">${esc(badgeLabel(p.badge))}</span>` : p.stock <= (Number(settings.low_stock) || 0) ? `<span class="ptag ptag-low">Only ${p.stock} left</span>` : ''}</div>
          <div class="nm">${esc(p.name)}</div><div class="pr">${priceText(p)}</div>
          <div class="st">${p.stock < 1 ? 'Sold out' : `${p.stock} in stock${p.variants.length ? ` · ${p.variants.length} options` : ''}`}</div>
        </button>`).join('') || `<div class="empty" style="grid-column:1/-1">${items.length ? 'No matches' : 'No products yet. Add some on the Products page.'}</div>`;
    }
    const totals = () => {
      if (quote) return { sub: quote.subtotal_cents, disc: quote.discount_cents, tax: quote.tax_cents, total: quote.total_cents };
      let sub = 0;
      for (const [k, n] of cart) sub += look(k).price * n;
      const tax = Math.round((sub * rate) / 100);
      return { sub, disc: 0, tax, total: sub + tax };
    };
    const cartItems = () => [...cart].map(([k, qty]) => { const l = look(k); return { id: l.id, variant: l.vid || undefined, custom: l.cv.length ? l.cv : undefined, qty }; });
    async function refreshQuote() {
      if (!cart.size) { quote = null; return paintSums(); }
      const my = ++qseq;
      try {
        const r = await fetch('/api/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: cartItems(), code }) });
        const d = await r.json();
        if (my !== qseq) return;
        if (!r.ok) { quote = null; $('#codemsg').innerHTML = `<span class="err-text">${esc(d.error || 'That code did not work')}</span>`; code = ''; }
        else { quote = d; $('#codemsg').innerHTML = d.discount_cents ? `<span class="ok-text">Code ${esc(d.discount_code)} applied</span>` : ''; }
      } catch { quote = null; }
      paintSums();
    }
    function paintSums() {
      const t = totals();
      $('#sums').innerHTML = `<div class="sum"><span>Subtotal</span><span>${fmt(t.sub)}</span></div>` +
        (t.disc ? `<div class="sum disc"><span>Discount</span><span>−${fmt(t.disc)}</span></div>` : '') +
        (rate > 0 ? `<div class="sum"><span>Tax (${rate}%)</span><span>${fmt(t.tax)}</span></div>` : '') +
        `<div class="sum total"><span>Total</span><span>${fmt(t.total)}</span></div>`;
    }
    function paintCart() {
      const count = [...cart.values()].reduce((a, b) => a + b, 0);
      $('#ctitle').textContent = `Cart (${count})`;
      $('#citems').innerHTML = cart.size ? [...cart].map(([k, n]) => {
        const l = look(k), p = l.p;
        return `<div class="citem">${pic(p.image_url, p.name)}
          <div><div class="nm">${esc(p.name)}</div>${l.v ? `<div class="small"><b>${esc(l.v.name)}</b></div>` : ''}${(p.custom_fields || []).map((f, i) => l.cv[i] ? `<div class="small muted">${esc(f.label)}: ${esc(l.cv[i])}</div>` : '').join('')}<div class="muted small">${fmt(l.price)}</div>
            <div class="stepper"><button data-d="${k}" aria-label="Fewer">−</button><span>${n}</span><button data-u="${k}" aria-label="More">+</button></div></div>
          <div><b>${fmt(l.price * n)}</b></div></div>`;
      }).join('') : '<div class="empty">Tap items to add them</div>';
      $('#codebox').hidden = !cart.size;
      paintSums(); refreshQuote();
      ['card', 'cash', 'other'].forEach((k) => { $('#' + k).disabled = !cart.size; });
    }
    const add = (key) => {
      const l = look(key);
      const n = (cart.get(key) || 0) + 1;
      if (n <= l.stock) { cart.set(key, n); paintCart(); }
    };
    // products with options ask which one first
    function pickOption(p) {
      const lab = (p.option_label || 'option').toLowerCase(), cf = p.custom_fields || [];
      const m = openModal(`<h2>${esc(p.name)}</h2>${p.variants.length ? `<p class="muted small">Choose ${/^[aeiou]/.test(lab) ? 'an' : 'a'} ${esc(lab)}</p>
        <div class="optlist">${p.variants.map((v) => `<button class="optrow" data-v="${v.id}" ${v.stock < 1 ? 'disabled' : ''}><span class="on">${esc(v.name)}</span><span class="op">${fmt(v.price_cents)}</span><span class="os muted small">${v.stock < 1 ? 'Sold out' : v.stock + ' in stock'}</span></button>`).join('')}</div>` : ''}
        ${cf.length ? `<div class="custq">${cf.map((f, i) => `<label class="small" for="cf${i}"><b>${esc(f.label)}</b>${f.required ? '' : ' <span class="muted">(optional)</span>'}</label><input class="input" id="cf${i}" maxlength="200" autocomplete="off">`).join('')}</div>` : ''}
        ${p.variants.length ? '' : '<button class="btn btn-primary btn-block mt" id="oadd">Add to cart</button>'}
        <button class="btn btn-ghost btn-block mt" id="ocancel">Close</button>`);
      $('#ocancel', m.el).onclick = m.close;
      const answers = () => cf.map((f, i) => ($('#cf' + i, m.el).value || '').trim());
      const finish = (vid) => {
        const cv = answers(), miss = cf.findIndex((f, i) => f.required && !cv[i]);
        if (miss >= 0) { toast(`Please fill in “${cf[miss].label}”`); $('#cf' + miss, m.el).focus(); return; }
        add(keyOf(p.id, vid, cv)); m.close();
      };
      if (!p.variants.length) $('#oadd', m.el).onclick = () => finish(0);
      m.el.onclick = (e) => { const b = e.target.closest('[data-v]'); if (b && !b.disabled) finish(Number(b.dataset.v)); };
    }
    const addProduct = (p) => (p.variants.length || (p.custom_fields || []).length ? pickOption(p) : add(keyOf(p.id, 0)));

    $('#q').oninput = (e) => { q = e.target.value; paintGrid(); };
    // a barcode scanner types the code and presses Enter: an exact SKU match goes straight to the cart
    $('#q').onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      const t = q.trim().toLowerCase(); if (!t) return;
      for (const p of items) {
        if (p.sku && p.sku.toLowerCase() === t) { addProduct(p); q = ''; $('#q').value = ''; paintGrid(); return; }
        const v = p.variants.find((x) => x.sku && x.sku.toLowerCase() === t);
        if (v) { if (v.stock > 0) add(keyOf(p.id, v.id)); else toast('That option is sold out'); q = ''; $('#q').value = ''; paintGrid(); return; }
      }
    };
    $('#cats').onclick = (e) => { const b = e.target.closest('[data-c]'); if (b) { cat = b.dataset.c; paintCats(); paintGrid(); } };
    $('#grid').onclick = (e) => { const b = e.target.closest('.pcard'); if (b && !b.disabled) addProduct(items.find((x) => x.id === Number(b.dataset.id))); };
    $('#citems').onclick = (e) => {
      const d = e.target.closest('[data-d]'), u = e.target.closest('[data-u]');
      if (d) { const k = d.dataset.d, n = cart.get(k) - 1; n < 1 ? cart.delete(k) : cart.set(k, n); paintCart(); }
      if (u) add(u.dataset.u);
    };
    $('#clear').onclick = () => { cart.clear(); code = ''; $('#code').value = ''; $('#codemsg').innerHTML = ''; paintCart(); };
    $('#apply').onclick = () => { code = $('#code').value.trim(); if (!code) $('#codemsg').innerHTML = ''; refreshQuote(); };
    $('#code').onkeydown = (e) => { if (e.key === 'Enter') $('#apply').click(); };

    const body = (method) => ({ items: cartItems(), method, code });
    const flash = (m) => { $('#sellmsg').innerHTML = `<div class="msg err">${esc(m)}</div>`; };
    $('#sellmsg').innerHTML = '';

    let selling = false;
    const lockSell = (on) => {
      selling = on;
      for (const id of ['cash', 'other', 'card']) { const b = $('#' + id); if (!b) continue; if (on) { b.dataset.label = b.textContent; b.textContent = 'Saving…'; } else if (b.dataset.label) { b.textContent = b.dataset.label; delete b.dataset.label; } b.disabled = on; }
    };
    for (const method of ['cash', 'other']) {
      $('#' + method).onclick = async () => {
        if (selling) return; lockSell(true);
        try { const r = await post('/api/register/sale', body(method)); saleComplete({ id: r.orderId, public_token: r.public_token, total_cents: r.total_cents }); }
        catch (e) { flash(e.message); }
        lockSell(false);
      };
    }
    $('#card').onclick = async () => {
      if (selling) return; lockSell(true);
      try {
        const r = await post('/api/register/sale', body('card'));
        let timer;
        const m = openModal(`<h2>Scan to pay ${fmt(r.total_cents)}</h2>
          <p class="muted small">The customer scans this with their phone camera</p>
          <img src="${r.qr}" width="260" height="260" alt="QR code to pay">
          <p><a href="${esc(r.url)}" target="_blank" rel="noopener">Or open the payment page</a></p>
          <p class="muted small" id="wait">Waiting for payment…</p>
          <button class="btn btn-ghost btn-block" id="mcancel">Cancel</button>`);
        const stop = () => clearInterval(timer);
        onLeave(stop);
        $('#mcancel', m.el).onclick = async () => { stop(); m.close(); try { await post(`/api/admin/orders/${r.orderId}/cancel`); } catch { /* ignore */ } };
        timer = setInterval(async () => {
          try {
            const s = await api('/api/admin/orders/' + r.orderId);
            if (s.status === 'paid') { stop(); m.close(); saleComplete(await api('/api/admin/orders/' + r.orderId)); }
            else if (s.status === 'canceled') { stop(); const w = $('#wait', m.el); if (w) w.textContent = 'That payment page expired. Cancel and try again.'; }
          } catch { /* keep polling */ }
        }, 2000);
      } catch (e) { flash(e.message); }
      lockSell(false);
    };

    function saleComplete(order) {
      cart.clear(); code = ''; quote = null; $('#code').value = ''; $('#codemsg').innerHTML = ''; paintCart();
      const m = openModal(`
        <div class="done">
          <img class="art" data-brand="sold" alt="" hidden>
          <h2>That's a wrap!</h2>
          <p class="muted">Payment complete. Thanks for supporting independent artists!</p>
          <p><b style="font-size:22px">${fmt(order.total_cents)}</b></p>
          <div class="row"><button class="btn btn-dark" id="newsale">New Sale</button>
            <a class="btn" id="rcpt" target="_blank" rel="noopener" href="/receipt.html?order=${order.id}#k=${esc(order.public_token)}">View Receipt</a></div>
        </div>`, { wide: true });
      if (window.OutpostBrand) OutpostBrand.apply(settings);
      $('#newsale', m.el).onclick = () => { m.close(); route(); };
    }

    paintCats(); paintGrid(); paintCart();
  }

  // =====================================================================
  // PRODUCTS
  // =====================================================================
  // --- tiny CSV reader/writer (handles quotes, commas, newlines) ---
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim() !== '')) rows.push(row); row = []; }
      else cell += c;
    }
    row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row);
    return rows;
  }
  const csvCell = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v) && !/^-?\d+(\.\d+)?$/.test(v)) v = "'" + v; return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  async function viewProducts() {
    let list = await api('/api/admin/products');
    const picked = new Set();
    const low = () => Number(settings.low_stock) || 0;
    view().innerHTML = `
      <div class="topbar"><h1>Products</h1><div class="spacer"></div>
        <a class="btn" href="#/lines">Product lines</a><button class="btn" id="imp">Import CSV</button><button class="btn" id="exp">Export CSV</button>
        <a class="btn btn-primary" href="#/products/new">+ New product</a></div>
      <div id="pmsg"></div>
      <div class="search">${icon('search')}<input class="input" id="pq" placeholder="Search products…"></div>
      <div class="bulkbar card" id="bulk" hidden></div>
      <div class="card tbl-scroll"><table><thead><tr><th><input type="checkbox" id="all" aria-label="Select all"></th><th></th><th>Name</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody id="rows"></tbody></table></div>
      <input type="file" id="csvfile" accept=".csv,text/csv" hidden>`;
    const shown = () => {
      const n = $('#pq').value.trim().toLowerCase();
      return list.filter((p) => !n || [p.name, p.category, p.tags.join(' '), p.sku, ...p.variants.map((v) => v.name + ' ' + v.sku)].join(' ').toLowerCase().includes(n));
    };
    const paintBulk = () => {
      const b = $('#bulk'); b.hidden = !picked.size;
      if (!picked.size) return;
      b.innerHTML = `<b>${picked.size} selected</b>
        <select class="input" id="bk-what"><option value="">Change…</option><option value="category">Category</option><option value="badge">Tag</option><option value="active">Visibility</option><option value="stock_add">Stock (add or remove)</option><option value="price_percent">Price (% change)</option></select>
        <span id="bk-val"></span><button class="btn btn-sm btn-dark" id="bk-go" disabled>Apply</button><button class="btn btn-sm btn-ghost" id="bk-clear">Clear</button>`;
      const val = $('#bk-val');
      $('#bk-what').onchange = (e) => {
        const w = e.target.value;
        val.innerHTML = w === 'category' ? '<input class="input" id="bk-v" placeholder="Prints">'
          : w === 'badge' ? `<select class="input" id="bk-v">${BADGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>`
          : w === 'active' ? '<select class="input" id="bk-v"><option value="1">For sale</option><option value="0">Hidden</option></select>'
          : w === 'stock_add' ? '<input class="input" id="bk-v" inputmode="numeric" placeholder="+5 or -2">'
          : w === 'price_percent' ? '<input class="input" id="bk-v" inputmode="decimal" placeholder="-10 for 10% off, 5 for 5% more">' : '';
        $('#bk-go').disabled = !w;
      };
      $('#bk-clear').onclick = () => { picked.clear(); paint(); };
      $('#bk-go').onclick = async () => {
        const w = $('#bk-what').value, v = $('#bk-v').value;
        const set = {};
        if (w === 'active') set.active = v === '1';
        else if (w === 'stock_add' || w === 'price_percent') { if (v.trim() === '' || !Number.isFinite(Number(v))) return ($('#pmsg').innerHTML = '<div class="msg err">Enter a number</div>'); set[w] = Number(v); if (w === 'stock_add' && !Number.isInteger(set[w])) return ($('#pmsg').innerHTML = '<div class="msg err">Stock change must be a whole number, like +5 or -2</div>'); }
        else set[w] = v;
        if (w === 'price_percent' && !(await confirmBox({ title: 'Change prices?', body: `This changes the price of ${picked.size} product${picked.size === 1 ? '' : 's'} by ${esc(v)}%.`, yes: 'Change prices' }))) return;
        const go = $('#bk-go'); if (go.disabled && go.dataset.busy) return; go.disabled = true; go.dataset.busy = '1';
        try { const r = await post('/api/admin/products/bulk', { ids: [...picked], set }); toast(r.skipped_stock ? `Updated ${r.updated}. ${r.skipped_stock} with options were skipped for stock (edit those one by one).` : `Updated ${r.updated}`); picked.clear(); list = await api('/api/admin/products'); $('#pmsg').innerHTML = ''; paint(); }
        catch (e) { $('#pmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; if ($('#bk-go')) { $('#bk-go').disabled = false; delete $('#bk-go').dataset.busy; } }
      };
    };
    const paint = () => {
      const rows = shown();
      $('#rows').innerHTML = rows.map((p) => `<tr>
        <td><input type="checkbox" data-pick="${p.id}" ${picked.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(p.name)}"></td>
        <td>${pic(p.image_url, p.name)}</td><td><b>${esc(p.name)}</b>${p.sku ? `<div class="muted small">${esc(p.sku)}</div>` : ''}${p.variants.length ? `<div class="muted small">${p.variants.length} option${p.variants.length === 1 ? '' : 's'}: ${esc(p.variants.slice(0, 4).map((v) => v.name).join(', '))}${p.variants.length > 4 ? '…' : ''}</div>` : ''}${p.badge ? `<br><span class="badge b-info">${esc(badgeLabel(p.badge))}</span>` : ''}</td><td>${esc(p.category) || '<span class="muted">—</span>'}</td>
        <td>${p.variants.length && Math.max(...p.variants.map((v) => v.price_cents)) > Math.min(...p.variants.map((v) => v.price_cents)) ? 'From ' + fmt(Math.min(...p.variants.map((v) => v.price_cents))) : fmt(p.variants.length ? p.variants[0].price_cents : p.price_cents)}</td>
        <td>${p.stock < 1 ? '<span class="badge b-canceled">Sold out</span>' : p.stock <= low() ? `${p.stock} <span class="badge b-pending">Low</span>` : p.stock}</td>
        <td>${p.active ? '<span class="badge b-live">For sale</span>' : '<span class="badge">Hidden</span>'}</td>
        <td><a class="btn btn-sm" href="#/products/${p.id}">Edit</a></td></tr>`).join('') ||
        `<tr><td colspan="8" class="empty">${list.length ? 'No matches' : 'No products yet. Click “New product” to add your first, or import a CSV.'}</td></tr>`;
      $('#all').checked = rows.length > 0 && rows.every((p) => picked.has(p.id));
      paintBulk();
    };
    $('#rows').onchange = (e) => { const c = e.target.closest('[data-pick]'); if (!c) return; const id = Number(c.dataset.pick); c.checked ? picked.add(id) : picked.delete(id); paint(); };
    $('#all').onchange = (e) => { shown().forEach((p) => (e.target.checked ? picked.add(p.id) : picked.delete(p.id))); paint(); };
    $('#exp').onclick = () => {
      const lines = [['name', 'price', 'stock', 'category', 'description', 'tags', 'badge', 'sku', 'variants'].join(',')];
      list.forEach((p) => lines.push([p.name, dollars(p.price_cents), p.stock, p.category, p.description, p.tags.join('; '), p.badge, p.sku || '', p.variants.map((v) => [v.name, v.stock, v.own_price ? dollars(v.price_cents) : ''].join(':').replace(/:+$/, '')).join(';')].map(csvCell).join(',')));
      const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/csv' }));
      const l = document.createElement('a'); l.href = url; l.download = 'outpost-products.csv'; document.body.appendChild(l); l.click(); l.remove();
    };
    $('#imp').onclick = () => {
      const m = openModal(`<h2>Import products</h2>
        <p class="muted small">Choose a CSV file with a header row. Columns: <b>name</b> and <b>price</b> are required; <b>stock</b>, <b>category</b>, <b>description</b>, <b>tags</b> (separate with ;) and <b>badge</b> (new, last chance, discontinued, staff pick), <b>sku</b> and <b>variants</b> are optional. Options go in one cell like <b>Small:5;Medium:3:32.50;Large:0</b> (name, stock, and an optional price, separated by colons, options separated by semicolons). Products with the same name are updated instead of duplicated. Photos are added afterwards.</p>
        <p><a href="#" id="tpl">Download a template</a></p>
        <button class="btn btn-primary btn-block" id="pickcsv">Choose CSV file</button>
        <div id="imsg"></div><button class="btn btn-ghost btn-block mt" id="icancel">Close</button>`, { wide: true });
      $('#icancel', m.el).onclick = m.close;
      $('#tpl', m.el).onclick = (e) => { e.preventDefault(); const url = URL.createObjectURL(new Blob(['name,price,stock,category,description,tags,badge,sku,variants\nMountain print,18.00,12,Prints,"Two color riso, 8x10",riso; mountains,new,MTN-01,\nTee,30.00,,Merch,Hand-printed,,,TEE,Small:5;Medium:3:32.50;Large:0\n'], { type: 'text/csv' })); const l = document.createElement('a'); l.href = url; l.download = 'outpost-products-template.csv'; document.body.appendChild(l); l.click(); l.remove(); };
      $('#pickcsv', m.el).onclick = () => $('#csvfile').click();
      $('#csvfile').onchange = async () => {
        const f = $('#csvfile').files[0]; $('#csvfile').value = ''; if (!f) return;
        try {
          const rows = parseCsv(await f.text());
          if (rows.length < 2) throw new Error('That file has no rows under the header.');
          const head = rows[0].map((h) => h.trim().toLowerCase());
          if (!head.includes('name') || !head.includes('price')) throw new Error('The first row needs “name” and “price” columns.');
          const data = rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()])));
          const prev = await post('/api/admin/products/import', { rows: data, dry_run: true });
          const nNew = prev.plan.filter((x) => x.action === 'new').length, nChg = prev.plan.filter((x) => x.action === 'change').length, nBad = prev.errors.length;
          const stat = (n, label, bg, fg) => `<div style="flex:1;min-width:130px;background:${bg};border-radius:10px;padding:12px"><div style="font-size:24px;font-weight:700;color:${fg}">${n}</div><div class="small" style="color:${fg}">${label}</div></div>`;
          const cell = (before, after, f) => (before == null ? f(after) : before === after ? `${f(after)} <span class="muted">(unchanged)</span>` : `${f(before)} → <b>${f(after)}</b>`);
          const planRows = prev.plan.slice(0, 50).map((x) => `<tr><td>${esc(x.name)}</td><td>${x.action === 'new' ? '<b>New</b>' : '<b>Changes</b>'}</td><td>${cell(x.price_before, x.price_after, fmt)}</td><td>${cell(x.stock_before, x.stock_after, String)}</td></tr>`).join('');
          const badRows = prev.errors.slice(0, 50).map((x) => `<tr style="background:#fff5f4"><td>Row ${x.row + 1}: ${esc((data[x.row - 1] || {}).name || '')}</td><td><b>Skipped</b></td><td colspan="2">${esc(x.error)}</td></tr>`).join('');
          const total = nNew + nChg;
          $('#imsg', m.el).innerHTML = `<h3 style="margin:14px 0 8px">Check your import before it’s saved</h3>
            <div class="row" style="flex-wrap:wrap;gap:10px">${stat(nNew, 'new products', '#e3f1ec', '#1d4a3d')}${stat(nChg, 'existing, will change', '#e8eef9', '#1e3a8a')}${stat(nBad, 'rows with problems (skipped)', '#fbe3df', '#7a271a')}</div>
            <div style="max-height:260px;overflow:auto;margin-top:10px"><table class="tbl"><thead><tr><th>Product</th><th>What happens</th><th>Price</th><th>Stock</th></tr></thead><tbody>${planRows}${badRows}</tbody></table></div>
            ${prev.plan.length > 50 || nBad > 50 ? '<div class="small muted">Only the first 50 of each list are shown here. Everything is still imported.</div>' : ''}
            <p class="small muted">A blank price or stock cell keeps what the product has now. Nothing is saved until you press Import.</p>
            <div class="row"><button class="btn btn-primary" id="igo" ${total ? '' : 'disabled'}>Import ${total} product${total === 1 ? '' : 's'}</button><button class="btn btn-ghost" id="ino">Cancel</button></div>`;
          $('#ino', m.el).onclick = () => { $('#imsg', m.el).innerHTML = ''; };
          $('#igo', m.el).onclick = async () => {
            const go = $('#igo', m.el); if (go.disabled) return; go.disabled = true;
            try {
              const res = await post('/api/admin/products/import', { rows: data });
              list = await api('/api/admin/products'); paint();
              $('#imsg', m.el).innerHTML = `<div class="msg">Added ${res.created}, updated ${res.updated}.</div>` + (res.errors.length ? `<div class="msg err">${res.errors.slice(0, 6).map((x) => `Row ${x.row + 1}: ${esc(x.error)}`).join('<br>')}${res.errors.length > 6 ? `<br>and ${res.errors.length - 6} more` : ''}</div>` : '');
            } catch (e) { go.disabled = false; $('#imsg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
          };
        } catch (e) { $('#imsg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
    };
    $('#pq').oninput = paint; paint();
  }

  async function viewEditor(m) {
    const isNew = m[1] === 'new';
    const [existing, all, allLines] = await Promise.all([isNew ? null : api('/api/admin/products/' + m[1]), api('/api/admin/products'), api('/api/admin/lines')]);
    const cats = [...new Set(all.map((p) => p.category).filter(Boolean))];
    const s = existing
      ? { name: existing.name, price: dollars(existing.price_cents), category: existing.category, description: existing.description, active: !!existing.active, badge: existing.badge || '', process: existing.process || '', sku: existing.sku || '', option_label: existing.option_label || '', custom_fields: (existing.custom_fields || []).map((f) => ({ label: f.label, required: !!f.required })), variants: existing.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku || '', price: v.own_price ? dollars(v.price_cents) : '', stock: String(v.stock), stock_was: v.stock })), stock: String(existing.stock), stock_was: existing.stock, tags: [...existing.tags], images: [...existing.images], line_ids: [...(existing.line_ids || [])] }
      : { name: '', price: '', category: '', description: '', active: true, badge: '', process: '', sku: '', option_label: '', custom_fields: [], variants: [], stock: '1', tags: [], images: [], line_ids: [] };

    view().innerHTML = `
      <div class="topbar"><button class="crumb" id="back">← Back</button><div class="spacer"></div>
        <h1 style="font-size:26px">Product Details</h1><div class="spacer"></div>
        <button class="btn btn-dark" id="save">Save</button></div>
      <div id="emsg"></div>
      <div class="editor">
        <div><div id="imgs"></div><input type="file" id="file" hidden multiple accept="image/png,image/jpeg,image/gif,image/webp"></div>
        <div>
          <label class="field"><span class="label">Name</span><input class="input" id="name" value="${esc(s.name)}"></label>
          <div class="grid2">
            <label class="field"><span class="label">Price</span><input class="input" id="price" inputmode="decimal" placeholder="12.50" value="${esc(s.price)}"></label>
            <label class="field"><span class="label">Category</span><input class="input" id="category" list="catlist" placeholder="Prints, Ceramics…" value="${esc(s.category)}">
              <datalist id="catlist">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
          </div>
          <label class="field"><span class="label">SKU (optional)</span><input class="input" id="sku" maxlength="40" placeholder="Your own code or barcode number" value="${esc(s.sku)}">
            <div class="hint">Handy if you number your work or use a barcode scanner at the register. Must be different for every product and option.</div></label>
          <label class="field"><span class="label">Description</span><textarea class="input" id="desc" placeholder="Two color risograph print on recycled paper, 8×10”">${esc(s.description)}</textarea></label>
          <div class="grid2">
            <label class="field"><span class="label">Inventory</span><select class="input" id="active">
              <option value="1"${s.active ? ' selected' : ''}>In stock / for sale</option><option value="0"${s.active ? '' : ' selected'}>Hidden (not for sale)</option></select></label>
            <label class="field"><span class="label">Quantity</span><input class="input" id="stock" inputmode="numeric" value="${esc(s.stock)}"><div class="hint" id="stockhint" hidden>Added up from your options below.</div></label>
          </div>
          <div class="field"><span class="label">Options (sizes, colors…)</span>
            <div class="hint" style="margin:0 0 8px">Only if this comes in different versions, like 5×7 and 8×10, or S, M and L. Each option has its own stock. Price: leave it blank to use the product price, or type a different one (like a bigger size). Leave this whole section empty for a single item.</div>
            <label class="field" style="margin:0 0 10px"><span class="label small">What do you call them?</span><input class="input" id="optlabel" maxlength="24" placeholder="Size, Color, Frame…" value="${esc(s.option_label)}"><div class="hint">Shoppers will see “Choose a size”. Leave blank for “Choose an option”.</div></label>
            <div id="vars"></div><button class="btn btn-sm" id="addvar" type="button">+ Add an option</button></div>
          <div class="field"><span class="label">Questions for the buyer (optional)</span>
            <div class="hint" style="margin:0 0 8px">A box the shopper types into, like “Name to engrave” or “Message for the card”. Their answer shows on the order and the packing info. Up to 3.</div>
            <div id="cfs"></div><button class="btn btn-sm" id="addcf" type="button">+ Add a question</button></div>
          <label class="field"><span class="label">How it’s made (optional)</span><textarea class="input" id="proc" rows="2" maxlength="600" placeholder="Hand-carved linoleum block, printed on a tabletop press with oil-based ink">${esc(s.process)}</textarea>
            <div class="hint">Shown to shoppers on the product’s Details page. Photos of your process make a great extra picture.</div></label>
          <label class="field"><span class="label">Shop label</span><select class="input" id="badge">${BADGES.map(([k, l]) => `<option value="${k}"${s.badge === k ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <div class="hint">A small label on the photo in your shop. “Sold out” and “Only a few left” appear on their own.</div></label>
          <div class="field"><span class="label">Product lines</span><div class="chips" id="linechips"></div>
            <div class="hint">${allLines.length ? 'Groups shoppers can browse, like “Frogs” or “Gift sets”. Tap to add or remove. You can pick more than one.' : 'Lines are curated groups shoppers can browse, like “Frogs” or “Gift sets”. <a href="#/lines">Make your first line</a>.'}</div></div>
          <div class="field"><span class="label">Tags</span><div class="chips" id="tags"></div></div>
        </div>
      </div>`;

    function paintCfs() {
      $('#cfs').innerHTML = s.custom_fields.map((f, i) => `<div class="cfrow" data-i="${i}"><input class="input" data-f="label" maxlength="40" placeholder="Name to engrave" value="${esc(f.label)}" aria-label="Question"><label class="small"><input type="checkbox" data-f="required"${f.required ? ' checked' : ''}> Required</label><button class="btn btn-sm btn-ghost" data-rm="${i}" type="button" aria-label="Remove question">✕</button></div>`).join('');
      $('#addcf').hidden = s.custom_fields.length >= 3;
    }
    $('#optlabel').oninput = (e) => { s.option_label = e.target.value; const h = $('#vhl'); if (h) h.textContent = s.option_label || 'Option'; document.querySelectorAll('.vl').forEach((x, i) => { if (i % 4 === 0) x.textContent = (s.option_label || 'Option') + ' name'; }); };
    $('#addcf').onclick = () => { s.custom_fields.push({ label: '', required: false }); paintCfs(); const r = document.querySelectorAll('.cfrow'); r[r.length - 1].querySelector('input').focus(); };
    $('#cfs').oninput = (e) => { const r = e.target.closest('.cfrow'); if (!r) return; const f = s.custom_fields[Number(r.dataset.i)]; f[e.target.dataset.f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value; };
    $('#cfs').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { s.custom_fields.splice(Number(b.dataset.rm), 1); paintCfs(); } };
    function paintVars() {
      const vs = s.variants;
      $('#vars').innerHTML = vs.length ? `<div class="varhead"><span id="vhl">${esc(s.option_label || 'Option')}</span><span>SKU (optional)</span><span>Price</span><span>In stock</span><span></span></div>` + vs.map((v, i) => `<div class="varrow" data-i="${i}">
        <label class="vf"><span class="vl">${esc(s.option_label || 'Option')} name</span><input class="input" data-f="name" placeholder="e.g. Small" value="${esc(v.name)}" aria-label="Option name"></label>
        <label class="vf"><span class="vl">SKU (optional)</span><input class="input" data-f="sku" placeholder="code" value="${esc(v.sku)}" aria-label="SKU"></label>
        <label class="vf"><span class="vl">Price ($)</span><input class="input" data-f="price" inputmode="decimal" placeholder="same" value="${esc(v.price)}" aria-label="Price (blank means the same as the product price)"></label>
        <label class="vf"><span class="vl">How many in stock</span><input class="input" data-f="stock" inputmode="numeric" value="${esc(v.stock)}" aria-label="Stock"></label>
        <button class="x" data-rm="${i}" type="button" aria-label="Remove option"><span class="xm">Remove this option</span><span class="xd">×</span></button></div>`).join('') : '';
      const has = vs.length > 0;
      $('#stock').disabled = has; $('#stockhint').hidden = !has;
      if (has) $('#stock').value = String(vs.reduce((a, v) => a + (parseInt(v.stock, 10) || 0), 0));
    }
    $('#addvar').onclick = () => {
      if (s.variants.length >= 40) return;
      const first = !s.variants.length;
      s.variants.push({ id: null, name: '', sku: '', price: '', stock: first ? ($('#stock').value || '0') : '0' });
      paintVars(); const rows = document.querySelectorAll('.varrow'); rows[rows.length - 1].querySelector('input').focus();
    };
    $('#vars').oninput = (e) => { const r = e.target.closest('.varrow'); if (!r || !e.target.dataset.f) return; s.variants[Number(r.dataset.i)][e.target.dataset.f] = e.target.value; if (e.target.dataset.f === 'stock') $('#stock').value = String(s.variants.reduce((a, v) => a + (parseInt(v.stock, 10) || 0), 0)); };
    $('#vars').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (b) { s.variants.splice(Number(b.dataset.rm), 1); paintVars(); } };

    function paintImgs() {
      const imgs = s.images;
      $('#imgs').innerHTML = (imgs.length ? `<img class="bigpic" src="${esc(imgs[0])}" alt="">` : `<div class="dropbox" id="drop">+ Add a photo</div>`) +
        `<div class="thumbs">${imgs.map((u, i) => `<div class="t${i === 0 ? ' on' : ''}" data-i="${i}" title="${i === 0 ? 'Main photo' : 'Click to make main photo'}"><img src="${esc(u)}" alt=""><button class="x" data-x="${i}" aria-label="Remove">×</button></div>`).join('')}
          ${imgs.length < 8 ? '<div class="add" id="addimg" title="Add photo">+</div>' : ''}</div>`;
    }
    function paintTags() {
      $('#tags').innerHTML = s.tags.map((t, i) => `<span class="chip tag">${esc(t)} <button class="link-btn" data-t="${i}" aria-label="Remove tag">×</button></span>`).join('') +
        '<input class="input" id="newtag" placeholder="+ add tag" style="width:130px;padding:6px 10px">';
      const inp = $('#newtag');
      const commit = () => { const v = inp.value.replace(/,/g, ' ').trim(); if (v && s.tags.length < 12 && !s.tags.includes(v)) { s.tags.push(v); paintTags(); $('#newtag').focus(); } else inp.value = ''; };
      inp.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); } };
      inp.onblur = () => { if (inp.value.trim()) commit(); };
    }
    function paintLineChips() {
      $('#linechips').innerHTML = allLines.map((l) => { const on = s.line_ids.includes(l.id); return `<button type="button" class="chip${on ? ' on' : ''}" data-ln="${l.id}">${on ? '✓ ' : ''}${esc(l.name)}</button>`; }).join('');
    }
    $('#linechips').onclick = (e) => { const b = e.target.closest('[data-ln]'); if (!b) return; const id = Number(b.dataset.ln); s.line_ids = s.line_ids.includes(id) ? s.line_ids.filter((x) => x !== id) : [...s.line_ids, id]; paintLineChips(); };
    $('#tags').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { s.tags.splice(Number(b.dataset.t), 1); paintTags(); } };
    $('#imgs').onclick = (e) => {
      const x = e.target.closest('[data-x]');
      if (x) { s.images.splice(Number(x.dataset.x), 1); return paintImgs(); }
      const t = e.target.closest('.t');
      if (t) { const [u] = s.images.splice(Number(t.dataset.i), 1); s.images.unshift(u); return paintImgs(); }
      if (e.target.closest('#addimg, #drop')) $('#file').click();
    };
    $('#file').onchange = async () => {
      const files = [...$('#file').files];
      $('#file').value = '';
      for (const f of files) {
        if (s.images.length >= 8) break;
        try { s.images.push(await uploadImage(f)); paintImgs(); }
        catch (e) { $('#emsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      }
    };
    $('#back').onclick = () => { location.hash = '#/products'; };
    $('#save').onclick = async () => {
      const price_cents = toCents($('#price').value);
      const stock = parseInt($('#stock').value, 10);
      if (!$('#name').value.trim()) return ($('#emsg').innerHTML = '<div class="msg err">Please enter a name</div>');
      if (!Number.isInteger(price_cents) || price_cents < 0) return ($('#emsg').innerHTML = '<div class="msg err">Enter a price like 12 or 12.50.</div>');
      if (!Number.isInteger(stock) || stock < 0) return ($('#emsg').innerHTML = '<div class="msg err">Quantity must be a whole number</div>');
      for (const [i, v] of s.variants.entries()) {
        if (!v.name.trim()) return ($('#emsg').innerHTML = `<div class="msg err">Option ${i + 1} needs a name</div>`);
        if (v.price.trim() !== '' && !(toCents(v.price) >= 0)) return ($('#emsg').innerHTML = `<div class="msg err">“${esc(v.name)}” has a price that isn’t a number</div>`);
        if (!/^\d*$/.test(String(v.stock).trim())) return ($('#emsg').innerHTML = `<div class="msg err">Stock for “${esc(v.name)}” must be a whole number</div>`);
      }
      for (const [i, f] of s.custom_fields.entries()) if (!f.label.trim()) return ($('#emsg').innerHTML = `<div class="msg err">Question ${i + 1} for the buyer needs a label, like “Name to engrave”</div>`);
      const variants = s.variants.map((v) => ({ id: v.id || undefined, name: v.name.trim(), sku: v.sku.trim(), price_cents: v.price.trim() === '' ? null : toCents(v.price), stock: parseInt(v.stock, 10) || 0, stock_was: v.stock_was }));
      const payload = { name: $('#name').value.trim(), price_cents, stock, stock_was: isNew ? undefined : s.stock_was, sku: $('#sku').value.trim(), option_label: $('#optlabel').value.trim(), custom_fields: s.custom_fields.map((f) => ({ label: f.label.trim(), required: !!f.required })), variants, description: $('#desc').value, category: $('#category').value.trim(), badge: $('#badge').value, process: $('#proc').value, tags: s.tags, images: s.images, line_ids: s.line_ids, active: $('#active').value === '1' };
      $('#save').disabled = true;
      try { isNew ? await post('/api/admin/products', payload) : await put('/api/admin/products/' + m[1], payload); toast('Saved'); location.hash = '#/products'; }
      catch (e) { $('#emsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#save').disabled = false; }
    };
    paintImgs(); paintTags(); paintVars(); paintCfs(); paintLineChips();
  }

  // =====================================================================
  // PRODUCT LINES
  // =====================================================================
  async function viewLines() {
    let [lines, products] = await Promise.all([api('/api/admin/lines'), api('/api/admin/products')]);
    let editing = null; // null = none, 0 = new, id = existing
    let draft = null;
    view().innerHTML = `<div class="topbar"><button class="crumb" id="back">← Products</button><div class="spacer"></div><h1 style="font-size:26px">Product lines</h1><div class="spacer"></div><button class="btn btn-primary" id="newline">+ New line</button></div>
      <p class="muted small" style="margin:0 0 14px">Curated groups shoppers can browse, like “Frogs” or “Gift sets”. A product can be in as many lines as you like. Lines don’t replace categories: a category says what something is, a line says what it goes with.</p>
      <div id="lmsg"></div><div id="llist" style="display:grid;gap:10px"></div><div id="ledit"></div>`;
    $('#back').onclick = () => { location.hash = '#/products'; };
    const base = (settings.base_url || location.origin).replace(/\/$/, '');
    function paintList() {
      $('#llist').innerHTML = lines.length ? lines.map((l, i) => `<div class="card line-row" data-id="${l.id}">
        ${l.cover ? `<img class="thumb" src="${esc(l.cover)}" alt="">` : '<div class="thumb"></div>'}
        <div style="flex:1 1 200px;min-width:0"><div style="font-weight:600;font-size:16px">${esc(l.name)}</div><div class="muted small">${l.count} item${l.count === 1 ? '' : 's'} · ${esc(base)}/shop?line=${esc(l.slug)}</div></div>
        <span class="badge ${l.active ? 'b-paid' : ''}">${l.active ? 'Shown' : 'Hidden'}</span>
        <button class="btn btn-sm btn-ghost" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn btn-sm btn-ghost" data-dn="${i}" ${i === lines.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
        <button class="btn btn-sm" data-edit="${l.id}">Edit</button></div>`).join('') : '<div class="card empty">No lines yet. Make one, like “Frogs”, then tick the products that belong in it.</div>';
    }
    function paintEdit() {
      if (editing === null) { $('#ledit').innerHTML = ''; return; }
      const d = draft;
      $('#ledit').innerHTML = `<div class="card" style="margin-top:14px"><h2 style="font-size:22px;margin-bottom:12px">${editing ? 'Editing: ' + esc(d.name || 'line') : 'New line'}</h2>
        <div class="grid2" style="align-items:start"><div>
          <label class="field"><span class="label">Name</span><input class="input" id="ln" maxlength="40" placeholder="Frogs" value="${esc(d.name)}"></label>
          <label class="field"><span class="label">Short blurb (optional)</span><textarea class="input" id="lb" rows="3" maxlength="300" placeholder="Every frog I’ve ever glazed, printed or doodled.">${esc(d.blurb)}</textarea></label>
          <div class="field"><span class="label">Cover photo</span>
            <div class="row" style="flex-wrap:wrap;gap:8px">${d.image_url ? `<img class="thumb" style="width:56px;height:56px;border-radius:10px;object-fit:cover" src="${esc(d.image_url)}" alt="">` : ''}<button class="btn btn-sm" id="lpic" type="button">${d.image_url ? 'Change photo' : 'Upload a photo'}</button>${d.image_url ? '<button class="btn btn-sm btn-ghost" id="lpicx" type="button">Use a product photo</button>' : ''}</div>
            <input type="file" id="lfile" hidden accept="image/png,image/jpeg,image/gif,image/webp">
            <div class="hint">Leave this alone and the first product’s photo is used.</div></div>
          <label class="check"><input type="checkbox" id="la" ${d.active ? 'checked' : ''}> <span>Show this line in my shop</span></label>
          <div class="hint">A line only appears once it has something for sale in it.</div>
        </div><div>
          <span class="label">Products in this line (<span id="lcount">${d.product_ids.length}</span>)</span>
          <div class="search" style="margin-bottom:8px">${icon('search')}<input class="input" id="lq" placeholder="Search products…"></div>
          <div class="line-pick" id="lpick"></div>
        </div></div>
        <div class="row" style="margin-top:14px;gap:10px"><button class="btn btn-primary" id="lsave">Save line</button><button class="btn btn-ghost" id="lcancel">Cancel</button><div class="spacer"></div>${editing ? '<button class="btn btn-ghost" id="ldel">Delete line</button>' : ''}</div></div>`;
      const paintPick = () => {
        const n = $('#lq').value.trim().toLowerCase();
        $('#lpick').innerHTML = products.filter((p) => !n || (p.name + ' ' + p.category).toLowerCase().includes(n)).map((p) => `<label><input type="checkbox" data-p="${p.id}" ${d.product_ids.includes(p.id) ? 'checked' : ''}> <span>${esc(p.name)}${p.active ? '' : ' <span class="muted small">(hidden)</span>'}</span></label>`).join('') || '<div class="muted small">No matches</div>';
      };
      paintPick();
      $('#lq').oninput = paintPick;
      $('#lpick').onchange = (e) => { const c = e.target.closest('[data-p]'); if (!c) return; const id = Number(c.dataset.p); d.product_ids = c.checked ? [...new Set([...d.product_ids, id])] : d.product_ids.filter((x) => x !== id); $('#lcount').textContent = d.product_ids.length; };
      const keep = () => { d.name = $('#ln').value; d.blurb = $('#lb').value; d.active = $('#la').checked; };
      $('#lpic').onclick = () => $('#lfile').click();
      $('#lfile').onchange = async () => { const f = $('#lfile').files[0]; if (!f) return; keep(); try { d.image_url = await uploadImage(f); paintEdit(); } catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; } };
      if ($('#lpicx')) $('#lpicx').onclick = () => { keep(); d.image_url = ''; paintEdit(); };
      $('#lcancel').onclick = () => { editing = null; draft = null; paintEdit(); };
      if ($('#ldel')) $('#ldel').onclick = async () => {
        if (!(await confirmBox({ title: 'Delete this line?', body: 'The products stay in your shop. Only the group goes away.', yes: 'Delete', danger: true }))) return;
        try { await api('/api/admin/lines/' + editing, { method: 'DELETE' }); editing = null; draft = null; lines = await api('/api/admin/lines'); paintList(); paintEdit(); toast('Deleted'); } catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
      };
      $('#lsave').onclick = async () => {
        keep();
        if (!d.name.trim()) return ($('#lmsg').innerHTML = '<div class="msg err">Your line needs a name</div>');
        const body = { name: d.name, blurb: d.blurb, image_url: d.image_url, active: d.active, product_ids: d.product_ids };
        $('#lsave').disabled = true;
        try { editing ? await put('/api/admin/lines/' + editing, body) : await post('/api/admin/lines', body); editing = null; draft = null; lines = await api('/api/admin/lines'); $('#lmsg').innerHTML = ''; paintList(); paintEdit(); toast('Saved'); }
        catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; $('#lsave').disabled = false; }
      };
    }
    const open = (id) => {
      const l = lines.find((x) => x.id === id);
      editing = id; draft = l ? { name: l.name, blurb: l.blurb, image_url: l.image_url, active: !!l.active, product_ids: [...l.ids] } : { name: '', blurb: '', image_url: '', active: true, product_ids: [] };
      $('#lmsg').innerHTML = ''; paintEdit(); $('#ledit').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    };
    $('#newline').onclick = () => open(0);
    $('#llist').onclick = async (e) => {
      const ed = e.target.closest('[data-edit]'); if (ed) return open(Number(ed.dataset.edit));
      const up = e.target.closest('[data-up]'), dn = e.target.closest('[data-dn]');
      const i = up ? Number(up.dataset.up) : dn ? Number(dn.dataset.dn) : -1; if (i < 0) return;
      const j = up ? i - 1 : i + 1; [lines[i], lines[j]] = [lines[j], lines[i]]; paintList();
      try { await put('/api/admin/lines/order', { ids: lines.map((l) => l.id) }); } catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
    paintList();
  }

  // =====================================================================
  // AUCTIONS
  // =====================================================================
  const PHASE = { live: ['Live', 'b-live'], scheduled: ['Scheduled', 'b-sched'], sold: ['Awaiting payment', 'b-pending'], paid: ['Paid', 'b-paid'], unsold: ['Unsold', 'b-unsold'], canceled: ['Canceled', 'b-canceled'] };

  async function viewAuctions() {
    const open = new Set();
    let offset = 0, list = [];
    view().innerHTML = `
      <div class="topbar"><h1>Auctions</h1><div class="spacer"></div>
        <a class="btn" href="/auction.html" target="_blank" rel="noopener">Public auction page</a>
        <a class="btn btn-primary" href="#/auctions/new">+ New auction</a></div>
      <div id="amsg"></div><div id="lots"></div>`;

    function lotHtml(a) {
      const [label, cls] = PHASE[a.phase];
      let line = '';
      if (a.phase === 'live') line = `${a.current_bid_cents != null ? `Current bid <b>${fmt(a.current_bid_cents)}</b> · ` : `Starts at ${fmt(a.starting_bid_cents)} · `}${a.bid_count} bid${a.bid_count === 1 ? '' : 's'} · ends in <b data-end="${a.end_at}">${countdown(a.end_at - (Date.now() + offset))}</b>`;
      else if (a.phase === 'scheduled') line = `Starts ${fmtDate(a.start_at)} · opening bid ${fmt(a.starting_bid_cents)}`;
      else if (a.phase === 'sold') line = `Sold for <b>${fmt(a.final_bid_cents)}</b> to <b>${esc(a.winner_full.name)}</b> (${esc(a.winner_full.email)}) · total with tax ${fmt(a.order.total_cents)}`;
      else if (a.phase === 'paid') line = `Paid by <b>${esc(a.winner_full.name)}</b> · ${fmt(a.order.total_cents)}`;
      else if (a.phase === 'unsold') line = 'No bids. This lot did not sell.';
      else line = 'Canceled';
      if (a.order && a.order.charge_status === 'paid') line += ' · <span class="ok-text">Card charged automatically</span>';
      if (a.order && a.order.charge_status === 'failed') line += `<div class="warnline">Automatic charge didn’t go through: ${esc(a.order.charge_error || 'declined')}. Copy the payment link and send it to the winner.</div>`;
      const act = [];
      if (a.phase === 'live') act.push(`<a class="btn btn-sm" target="_blank" rel="noopener" href="/auction.html?lot=${a.id}">Live screen</a>`, `<button class="btn btn-sm" data-act="end" data-id="${a.id}">End now</button>`);
      if (a.phase === 'sold') act.push(`<button class="btn btn-sm btn-primary" data-act="copy" data-id="${a.id}">Copy payment link</button>`, `<a class="btn btn-sm" href="${esc(mailto(a))}">Email winner</a>`, `<button class="btn btn-sm" data-act="next" data-id="${a.id}">Didn't pay → next bidder</button>`);
      if (a.phase === 'paid') act.push(`<a class="btn btn-sm" target="_blank" rel="noopener" href="/receipt.html?order=${a.order.id}#k=${esc(a.order.public_token)}">Receipt</a>`);
      if (['live', 'scheduled', 'sold'].includes(a.phase)) act.push(`<button class="btn btn-sm btn-danger" data-act="cancel" data-id="${a.id}">Cancel lot</button>`);
      if (a.bids.length) act.push(`<button class="btn btn-sm btn-ghost" data-act="bids" data-id="${a.id}">Bids (${a.bids.filter((b) => !b.voided).length})</button>`);
      const bids = open.has(a.id) ? `<div class="bidlist">${a.bids.map((b) => `<div class="b${b.voided ? ' void' : ''}"><b>${fmt(b.amount_cents)}</b><span>${esc(b.name)}</span><span class="muted">${esc(b.email)}</span><span class="muted small">${fmtDate(b.created_at)}</span><span class="spacer"></span><button class="link-btn" data-act="block" data-email="${esc(b.email)}">Block</button> ${!b.voided && a.phase !== 'sold' && a.phase !== 'paid' && a.phase !== 'unsold' && a.phase !== 'canceled' ? `<button class="link-btn" data-act="void" data-id="${b.id}">Remove bid</button>` : ''}</div>`).join('')}</div>` : '';
      return `<div class="card lot" style="display:grid">${pic(a.image_url, a.title)}
        <div style="min-width:0"><div class="lot-head muted small"><span>Lot ${a.id}</span><span class="badge ${cls}">${label}</span></div><h3>${esc(a.title)}</h3><div class="small">${line}</div></div>
        <div class="lot-actions">${act.join('')}</div>${bids}</div>`;
    }
    const mailto = (a) => {
      const subject = `You won Lot ${a.id}: ${a.title}`;
      const text = `Hi ${a.winner_full.name.split(' ')[0]},\n\nCongratulations! Your winning bid on "${a.title}" was ${fmt(a.final_bid_cents)}. Total with tax: ${fmt(a.order.total_cents)}.\n\nYou can pay securely here:\n${a.pay_url}\n\nThank you!`;
      return `mailto:${encodeURIComponent(a.winner_full.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    };
    const paint = () => { $('#lots').innerHTML = list.length ? list.map(lotHtml).join('') : '<div class="card empty">No auctions yet. Click “New auction” to list your first lot.</div>'; };
    async function load() { list = await api('/api/admin/auctions'); offset = list.length ? list[0].serverNow - Date.now() : 0; paint(); }

    $('#lots').onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const id = Number(b.dataset.id), a = list.find((x) => x.id === id), act = b.dataset.act;
      try {
        if (act === 'block') {
          const em = b.dataset.email;
          if (!(await confirmBox({ title: `Block ${em}?`, body: 'They won’t be able to bid or check out, and their bids on open lots come off the board.', yes: 'Block', danger: true }))) return;
          await post('/api/admin/blocks', { kind: 'email', value: em, note: 'Blocked from a bid list' }); toast('Blocked'); return load();
        }
        if (act === 'bids') { open.has(id) ? open.delete(id) : open.add(id); return paint(); }
        if (act === 'copy') {
          try { await navigator.clipboard.writeText(a.pay_url); toast('Payment link copied'); } catch { copyBox('Copy this payment link', a.pay_url); }
          return;
        }
        if (act === 'end' && (await confirmBox({ title: 'End this lot now?', body: 'The highest bidder wins.', yes: 'End lot', no: 'Keep it open' }))) await post(`/api/admin/auctions/${id}/end`);
        else if (act === 'cancel' && (await confirmBox({ title: 'Cancel this lot?', body: 'Bidders will no longer see it.', yes: 'Cancel lot', no: 'Keep lot', danger: true }))) await post(`/api/admin/auctions/${id}/cancel`);
        else if (act === 'next' && a.winner_full && (await confirmBox({ title: 'Offer to the next bidder?', body: `This removes ${esc(a.winner_full.name)}’s bid (${fmt(a.final_bid_cents)}) and offers the lot to the next-highest bidder.`, yes: 'Remove bid and offer', danger: true }))) await post(`/api/admin/auctions/${id}/next-bidder`, { expected_bid_id: a.winner_bid_id });
        else if (act === 'void' && (await confirmBox({ title: 'Remove this bid?', body: 'It comes off the board.', yes: 'Remove bid', danger: true }))) await post(`/api/admin/bids/${id}/void`);
        else return;
        await load();
      } catch (err) { $('#amsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };

    await load();
    const tick = setInterval(() => document.querySelectorAll('[data-end]').forEach((el) => { el.textContent = countdown(Number(el.dataset.end) - (Date.now() + offset)); }), 1000);
    const refresh = setInterval(() => load().catch(() => {}), 5000);
    onLeave(() => { clearInterval(tick); clearInterval(refresh); });
  }

  async function viewNewAuction() {
    const now = Date.now();
    const s = { image: '', title: '', description: '', start: '50.00', inc: '1000', later: false, startAt: toLocalInput(now + 3600e3), endAt: toLocalInput(now + 24 * 3600e3) };
    view().innerHTML = `
      <div class="topbar"><button class="crumb" id="back">← Back</button><div class="spacer"></div>
        <h1 style="font-size:26px">Create Auction</h1><div class="spacer"></div>
        <button class="btn btn-dark" id="go">Start Auction</button></div>
      <div id="emsg"></div>
      <div class="editor">
        <div><div id="img"></div><input type="file" id="file" hidden accept="image/png,image/jpeg,image/gif,image/webp">
          <button class="btn btn-block mt" id="pick">Change Image</button></div>
        <div>
          <label class="field"><span class="label">Title</span><input class="input" id="title" placeholder="Mountain Evening"></label>
          <label class="field"><span class="label">Description</span><textarea class="input" id="desc" placeholder="Original painting, 12 × 16 in. Acrylic on panel."></textarea></label>
          <div class="grid2">
            <label class="field"><span class="label">Starting Bid</span><input class="input" id="start" inputmode="decimal" value="50.00"></label>
            <label class="field"><span class="label">Bid Increments</span><select class="input" id="inc">
              ${[100, 500, 1000, 2500, 5000, 10000].map((c) => `<option value="${c}"${c === 1000 ? ' selected' : ''}>${fmt(c).replace('.00', '')}</option>`).join('')}</select></label>
          </div>
          <div class="field"><span class="label">Opens</span>
            <div class="chips"><button class="chip on" data-when="now">Right away</button><button class="chip" data-when="later">Pick a time</button></div>
            <input class="input mt" type="datetime-local" id="startAt" value="${s.startAt}" hidden></div>
          <div class="field"><span class="label">Closes</span>
            <input class="input" type="datetime-local" id="endAt" value="${s.endAt}">
            <div class="chips mt"><button class="chip" data-d="1">1 day</button><button class="chip" data-d="3">3 days</button><button class="chip" data-d="7">7 days</button></div>
            <div class="hint">A bid in the last 2 minutes extends the lot by 2 minutes, so nobody gets sniped.</div></div>
          <div class="preview" id="preview"></div>
        </div>
      </div>`;
    const paintImg = () => { $('#img').innerHTML = s.image ? `<img class="bigpic" src="${esc(s.image)}" alt="">` : '<div class="dropbox" id="drop">+ Add a photo of the piece</div>'; $('#pick').textContent = s.image ? 'Change Image' : 'Choose Image'; };
    const paintPreview = () => {
      const c = toCents($('#start').value);
      $('#preview').innerHTML = `${pic(s.image, $('#title').value || 'L')}<div><div class="muted small">Preview · Lot (new)</div><b>${esc($('#title').value || 'Untitled lot')}</b><div class="small">Starting bid ${Number.isFinite(c) ? fmt(c) : '—'}</div></div>`;
    };
    const pickFile = () => $('#file').click();
    $('#pick').onclick = pickFile;
    $('#img').onclick = (e) => { if (e.target.closest('#drop')) pickFile(); };
    $('#file').onchange = async () => {
      const f = $('#file').files[0]; $('#file').value = ''; if (!f) return;
      try { s.image = await uploadImage(f); paintImg(); paintPreview(); } catch (e) { $('#emsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    ['title', 'start'].forEach((id) => { $('#' + id).oninput = paintPreview; });
    view().querySelectorAll('[data-when]').forEach((b) => (b.onclick = () => {
      s.later = b.dataset.when === 'later';
      view().querySelectorAll('[data-when]').forEach((x) => x.classList.toggle('on', x === b));
      $('#startAt').hidden = !s.later;
    }));
    view().querySelectorAll('[data-d]').forEach((b) => (b.onclick = () => {
      const from = s.later ? new Date($('#startAt').value).getTime() || Date.now() : Date.now();
      $('#endAt').value = toLocalInput(from + Number(b.dataset.d) * 86400e3);
    }));
    $('#back').onclick = () => { location.hash = '#/auctions'; };
    $('#go').onclick = async () => {
      const starting = toCents($('#start').value);
      const end = new Date($('#endAt').value).getTime();
      const startMs = s.later ? new Date($('#startAt').value).getTime() : undefined;
      const err = (m) => ($('#emsg').innerHTML = `<div class="msg err">${esc(m)}</div>`);
      if (!$('#title').value.trim()) return err('Please give the lot a title');
      if (!Number.isInteger(starting) || starting < 1) return err('Please enter a starting bid like 50.00');
      if (!Number.isFinite(end)) return err('Please choose when the auction closes');
      $('#go').disabled = true;
      try {
        await post('/api/admin/auctions', { title: $('#title').value.trim(), description: $('#desc').value, image_url: s.image || null, starting_bid_cents: starting, increment_cents: Number($('#inc').value), start_at: startMs, end_at: end });
        toast('Auction started'); location.hash = '#/auctions';
      } catch (e) { err(e.message); $('#go').disabled = false; }
    };
    paintImg(); paintPreview();
  }

  // =====================================================================
  // ORDERS
  // =====================================================================
  const FUL = { '': 'Not shipped', packed: 'Packed', shipped: 'Shipped', delivered: 'Delivered' };
  const needsShipping = (o) => o.status === 'paid' && ['online', 'auction'].includes(o.channel) && ['', 'packed'].includes(o.fulfillment || '');
  async function viewOrders() {
    let orders = await api('/api/admin/orders');
    let older = [];            // orders loaded with "Load older orders"; kept when the list refreshes
    let noMore = false;
    const merge = (a, b) => { const m = new Map(); for (const o of [...a, ...b]) m.set(o.id, o); return [...m.values()].sort((x, y) => y.id - x.id); };
    orders = merge(orders, []);
    noMore = orders.length < 200;   // fewer than a full page: there is nothing older
    let filter = 'all';
    view().innerHTML = `<div class="topbar"><h1>Orders</h1><div class="spacer"></div><button class="btn" id="ocsv">Export CSV</button></div><div id="omsg"></div>
      <div class="chips" id="ofil"></div>
      <div class="card tbl-scroll"><table><thead><tr><th>#</th><th>When</th><th>Where</th><th>Paid by</th><th>Status</th><th>Total</th><th>Items</th><th>Customer</th><th></th></tr></thead><tbody id="orows"></tbody></table></div>
      <div id="omore" class="center" style="margin-top:14px"></div>`;
    const stat = { paid: 'b-paid', pending: 'b-pending', canceled: 'b-canceled', refunded: 'b-canceled' };
    const where = { register: 'Register', online: 'Online', auction: 'Auction' };
    const ship = (o) => { try { const s = JSON.parse(o.shipping_json || 'null'); if (!s) return ''; const a = s.address || {}; return [s.name, a.line1, a.line2, a.city, a.state, a.postal_code, a.country].filter(Boolean).join(', '); } catch { return ''; } };
    const toShipN = () => orders.filter(needsShipping).length;
    const paintFil = () => { $('#ofil').innerHTML = [['all', 'All orders'], ['ship', `To ship (${toShipN()})`], ['pending', 'Unpaid']].map(([k, l]) => `<button class="chip${filter === k ? ' on' : ''}" data-f="${k}">${l}</button>`).join(''); };
    const paint = () => {
      paintFil();
      const rows = orders.filter((o) => filter === 'all' || (filter === 'ship' ? needsShipping(o) : o.status === 'pending'));
      $('#orows').innerHTML = rows.map((o) => `<tr>
        <td>${o.id}</td><td class="small">${esc(new Date(o.created_at.replace(' ', 'T') + 'Z').toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td>
        <td>${where[o.channel] || esc(o.channel)}</td><td>${esc(o.payment_method)}</td>
        <td><span class="badge ${stat[o.status] || ''}">${esc(o.status)}</span>${lateOpen(o) ? `<br><span class="badge b-pending" style="background:#ffd88a;color:#4a3000;font-weight:700">Paid after cancel</span><br><span class="small">${fmt(o.late_paid_cents || o.total_cents)} arrived after you canceled this order.</span>` : o.late_resolved === 'refunded' ? '<br><span class="small muted">Late payment refunded</span>' : o.late_resolved === 'accepted' ? '<br><span class="small muted">Late payment kept</span>' : ''}${o.refunded_cents > 0 && o.status !== 'refunded' ? `<br><span class="badge b-pending">Part refunded</span>` : ''}${o.late ? `<br><span class="badge b-out">Running late</span>` : ''}${o.review_rating ? `<br><span class="small" title="Verified review">${'★'.repeat(o.review_rating)}</span>` : ''}${['online', 'auction'].includes(o.channel) && ['paid', 'refunded'].includes(o.status) && o.fulfillment ? `<br><span class="badge b-info">${FUL[o.fulfillment]}</span>` : ''}</td>
        <td><b>${fmt(o.total_cents)}</b>${o.refunded_cents > 0 ? `<br><span class="small muted">−${fmt(o.refunded_cents)} refunded</span>` : ''}</td>
        <td class="small">${o.items.map((i) => `${i.quantity}× ${esc(i.name)}${(i.custom || []).map((c) => `<br><b>${esc(c.label)}:</b> ${esc(c.value)}`).join('')}`).join('<br>')}</td>
        <td class="small">${esc(o.customer_email || '')}${ship(o) ? `<br><span class="muted">${esc(ship(o))}</span>` : ''}</td>
        <td>${lateOpen(o) ? `<button class="btn btn-sm btn-primary" data-lrefund="${o.id}">Refund ${fmt(o.late_paid_cents || o.total_cents)}</button> <button class="btn btn-sm" data-laccept="${o.id}">Ship it instead</button>` : ''}${['paid', 'refunded'].includes(o.status) ? `<button class="btn btn-sm" data-manage="${o.id}">Manage</button>` : ''}
            ${o.status === 'pending' && o.channel !== 'auction' ? `<button class="btn btn-sm btn-danger" data-cancel="${o.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No orders here.</td></tr>';
    };
    const lateOpen = (o) => o.status === 'canceled' && o.late_payment && (o.late_resolved === '' || o.late_resolved === 'refunding');
    const paintMore = () => { $('#omore').innerHTML = noMore ? `<div class="small muted">That’s every order.</div>` : `<button class="btn" id="oolder">Load older orders</button><div class="small muted" style="margin-top:8px">Showing the newest orders and every order still waiting to ship, however old.</div>`; if ($('#oolder')) $('#oolder').onclick = loadOlder; };
    const loadOlder = async () => {
      $('#oolder').disabled = true;
      try {
        const lowest = Math.min(...orders.map((o) => o.id));
        const page = await api('/api/admin/orders?limit=200&before=' + lowest);
        if (page.length < 200) noMore = true;
        older = merge(older, page); orders = merge(orders, page); paint(); paintMore();
      } catch (e) { $('#omsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#oolder').disabled = false; }
    };
    const reload = async () => { orders = merge(await api('/api/admin/orders'), older); paint(); };
    $('#ofil').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; paint(); } };
    $('#ocsv').onclick = () => download('/api/admin/orders.csv', 'outpost-orders.csv').catch((e) => toast(e.message));
    $('#orows').onclick = async (e) => {
      const lr = e.target.closest('[data-lrefund]'), la = e.target.closest('[data-laccept]');
      if (lr || la) {
        const o = orders.find((x) => x.id === Number((lr || la).dataset.lrefund || (lr || la).dataset.laccept));
        const cents = o.late_paid_cents || o.total_cents;
        const sure = lr ? (await confirmBox({ title: `Refund ${fmt(cents)}?`, body: `The money for order #${o.id} goes back to the buyer through Stripe.`, yes: 'Refund', danger: true })) : (await confirmBox({ title: 'Keep the payment?', body: `Order #${o.id} is reopened as paid. It counts as a sale and you ship it.`, yes: 'Reopen as paid' }));
        if (!sure) return;
        (lr || la).disabled = true;
        try { await post(`/api/admin/orders/${o.id}/${lr ? 'late-refund' : 'accept-late'}`); toast(lr ? 'Refunded' : 'Order reopened as paid'); await reload(); }
        catch (err) { $('#omsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; (lr || la).disabled = false; }
        return;
      }
      const mg = e.target.closest('[data-manage]');
      if (mg) return manageOrder(orders.find((o) => o.id === Number(mg.dataset.manage)), reload);
      const b = e.target.closest('[data-cancel]'); if (!b || !(await confirmBox({ title: 'Cancel this unpaid order?', body: 'The buyer won’t be able to pay for it.', yes: 'Cancel order', no: 'Keep order', danger: true }))) return;
      try { await post(`/api/admin/orders/${b.dataset.cancel}/cancel`); await reload(); }
      catch (err) { $('#omsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
    paint(); paintMore();
  }

  function manageOrder(o, done) {
    const left = o.total_cents - (o.refunded_cents || 0);
    const physical = ['online', 'auction'].includes(o.channel);
    const first = (o.customer_email ? (o.customer_email.split('@')[0]) : 'there');
    let shipName = ''; try { shipName = (JSON.parse(o.shipping_json || 'null') || {}).name || ''; } catch { /* ignore */ }
    const hi = (shipName || first).split(' ')[0];
    const mail = (subject, text) => `mailto:${encodeURIComponent(o.customer_email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
    const m = openModal(`<div style="text-align:left">
      <h2>Order #${o.id}</h2>
      <div class="muted small" style="margin-bottom:10px">${o.items.map((i) => `${i.quantity}× ${esc(i.name)}${(i.custom || []).length ? ' [' + i.custom.map((c) => esc(c.label) + ': ' + esc(c.value)).join('; ') + ']' : ''}`).join(', ')} · ${fmt(o.total_cents)}${o.discount_cents ? ` (code ${esc(o.discount_code || '')} took off ${fmt(o.discount_cents)})` : ''}</div>
      ${physical ? `<div class="mgbox"><div class="label">Shipping</div>
        <div class="seg" id="ful">${['', 'packed', 'shipped', 'delivered'].map((k) => `<button type="button" data-k="${k}" class="${(o.fulfillment || '') === k ? 'on' : ''}">${FUL[k]}</button>`).join('')}</div>
        <div class="grid2 mt"><label class="field"><span class="label">Carrier</span><input class="input" id="car" placeholder="USPS" value="${esc(o.carrier || '')}"></label>
          <label class="field"><span class="label">Tracking number</span><input class="input" id="trk" value="${esc(o.tracking_number || '')}"></label></div>
        <div class="row" style="flex-wrap:wrap"><button class="btn btn-primary btn-sm" id="fsave">Save shipping</button>
          ${o.customer_email ? '<a class="btn btn-sm" id="fmail" href="#">Email buyer…</a>' : '<span class="muted small">No buyer email on this order.</span>'}</div>
        <div class="hint">“Email buyer” opens a ready-written message in your email app. Marketing emails to your list are sent from <a href="#/marketing/email">Marketing → Email</a>.</div>
        <div id="fmsg"></div></div>` : ''}
      <div class="mgbox"><div class="label">Refund</div>
        ${o.refunded_cents > 0 ? `<div class="small" style="margin-bottom:8px">Already refunded ${fmt(o.refunded_cents)}${o.refund_note ? ` · “${esc(o.refund_note)}”` : ''}.</div>` : ''}
        ${left > 0 && o.status === 'paid' ? `<div class="grid2"><label class="field"><span class="label">Amount (up to ${fmt(left)})</span><input class="input" id="ramt" inputmode="decimal" value="${dollars(left)}"></label>
          <label class="field"><span class="label">Note (optional)</span><input class="input" id="rnote" maxlength="300" placeholder="Damaged in the mail"></label></div>
          <label class="check"><input type="checkbox" id="rstock"> <span>Put the items back in stock</span></label>
          ${o.payment_method === 'card' ? '<label class="check"><input type="checkbox" id="ralready"> <span>I already refunded this in Stripe</span></label>' : '<div class="hint">This was a cash/other sale, so Outpost records the refund and you hand the money back yourself.</div>'}
          <button class="btn btn-danger" id="rgo">Refund</button>` : '<div class="muted small">Nothing left to refund.</div>'}
        <div id="rmsg"></div></div>
      <a class="btn btn-ghost btn-block mt" target="_blank" rel="noopener" href="/receipt.html?order=${o.id}#k=${esc(o.public_token || '')}">Open receipt</a>
      <button class="btn btn-ghost btn-block mt" id="evid">Dispute evidence page</button>
      <div class="hint center">If a buyer disputes the charge, this one page has the receipt, tracking, policy and timestamps to send to Stripe.</div>
      <button class="btn btn-ghost btn-block mt" id="mclose">Close</button></div>`, { wide: true });
    const q = (s) => $(s, m.el);
    q('#mclose').onclick = m.close;
    q('#evid').onclick = async () => {
      try {
        const r = await fetch(`/api/admin/orders/${o.id}/evidence`, { headers: { 'x-admin-token': token } });
        if (!r.ok) throw new Error('Could not build the page');
        const url = URL.createObjectURL(new Blob([await r.text()], { type: 'text/html' }));
        window.open(url, '_blank', 'noopener');
      } catch (e) { toast(e.message); }
    };
    let ful = o.fulfillment || '';
    if (physical) {
      q('#ful').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; ful = b.dataset.k; m.el.querySelectorAll('#ful button').forEach((x) => x.classList.toggle('on', x === b)); };
      q('#fsave').onclick = async () => {
        try { await put(`/api/admin/orders/${o.id}/fulfillment`, { status: ful, carrier: q('#car').value, tracking_number: q('#trk').value }); o.fulfillment = ful; o.carrier = q('#car').value; o.tracking_number = q('#trk').value; q('#fmsg').innerHTML = '<div class="msg">Saved.</div>'; done(); }
        catch (e) { q('#fmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      if (o.customer_email) q('#fmail').onclick = (e) => {
        e.preventDefault();
        const trk = q('#trk').value.trim(), car = q('#car').value.trim();
        const link = `${location.origin}/receipt.html?order=${o.id}#k=${o.public_token}`;
        const msg = ful === 'shipped' ? [`Your order #${o.id} has shipped`, `Hi ${hi},\n\nGood news, your order is on its way!${trk ? `\n\n${car ? car + ' ' : ''}tracking: ${trk}` : ''}\n\nYour receipt: ${link}\n\nThank you for supporting independent artists!`]
          : ful === 'delivered' ? [`Your order #${o.id} was delivered`, `Hi ${hi},\n\nYour order should have arrived. If anything isn’t right, just reply to this email.\n\nThank you!`]
          : [`About your order #${o.id}`, `Hi ${hi},\n\nThanks for your order #${o.id}.\n\nYour receipt: ${link}\n\n`];
        location.href = mail(msg[0], msg[1]);
      };
    }
    if (q('#rgo')) q('#rgo').onclick = async () => {
      const cents = toCents(q('#ramt').value);
      if (!Number.isInteger(cents) || cents < 1 || cents > left) return (q('#rmsg').innerHTML = `<div class="msg err">Enter an amount between $0.01 and ${fmt(left)}</div>`);
      const already = q('#ralready') ? q('#ralready').checked : false;
      if (!(await confirmBox({ title: `Refund ${fmt(cents)}?`, body: `Order #${o.id}.${o.payment_method === 'card' && !already ? ' This sends the money back to the buyer’s card through Stripe.' : ''}`, yes: 'Refund', danger: true }))) return;
      q('#rgo').disabled = true;
      try { const rr = await post(`/api/admin/orders/${o.id}/refund`, { amount_cents: cents, note: q('#rnote').value, restock: q('#rstock').checked, already_refunded: already }); toast(rr && rr.restock_waiting ? 'Refund recorded. The items go back in stock once the order is fully refunded.' : 'Refund recorded'); m.close(); done(); }
      catch (e) { q('#rmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; q('#rgo').disabled = false; }
    };
  }

  // =====================================================================
  // CUSTOMERS
  // =====================================================================
  // =====================================================================
  // PEOPLE (customers, bidders and email subscribers in one place; tags; a profile for each person)
  // =====================================================================
  const PEOPLE_TABS = [['customers', 'Customers'], ['email', 'Email list'], ['reviews', 'Reviews']];
  const emailBadge = (st) => ({ subscribed: '<span class="badge b-paid">Subscribed</span>', unsubscribed: '<span class="badge b-canceled">Unsubscribed</span>', bounced: '<span class="badge b-canceled">Bounced</span>', no_consent: '<span class="badge">No consent on file</span>', unconfirmed: '<span class="badge b-pending">Waiting to confirm</span>' })[st] || '';
  const dateShort = (v) => (v ? new Date(typeof v === 'number' ? v : v.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
  const pstate = { filter: { kind: 'everyone' }, q: '', sel: new Set() };   // kept while you move between tabs
  const EMAIL_GROUPS = ['buyers', 'repeat', 'bidders', 'never_bought'];
  const audienceFor = (f) => (f.kind === 'tag' ? { kind: 'tag', tag: f.id } : f.kind === 'group' && EMAIL_GROUPS.includes(f.key) ? { kind: 'group', group: f.key } : null);

  async function viewPeople() {
    const m = location.hash.match(/^#\/people(?:\/(customers|email|reviews))?$/); const tab = (m && m[1]) || 'customers';
    view().innerHTML = `<div class="topbar"><h1>People</h1></div><div class="seg" id="ptabs" role="tablist">${PEOPLE_TABS.map(([k, l]) => `<button data-t="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</div><div id="pbody" style="margin-top:8px"></div>`;
    document.querySelectorAll('#ptabs button').forEach((b) => { b.onclick = () => { location.hash = '#/people' + (b.dataset.t === 'customers' ? '' : '/' + b.dataset.t); }; });
    const host = $('#pbody');
    if (tab === 'email') await peopleEmail(host); else if (tab === 'reviews') await viewReviews(host); else await peopleCustomers(host);
  }

  async function peopleCustomers(host) {
    let d = await api('/api/admin/people');
    const matches = (p) => {
      const f = pstate.filter;
      if (f.kind === 'tag' && !p.tags.some((t) => t.id === f.id)) return false;
      if (f.kind === 'group') {
        if (f.key === 'buyers' && !(p.orders > 0)) return false; if (f.key === 'repeat' && !(p.orders > 1)) return false; if (f.key === 'bidders' && !(p.bids > 0)) return false;
        if (f.key === 'subscribed' && p.email_status !== 'subscribed') return false; if (f.key === 'never_bought' && !(p.email_status === 'subscribed' && p.orders === 0)) return false;
      }
      const n = pstate.q.trim().toLowerCase(); return !n || (p.name + ' ' + p.email + ' ' + p.tags.map((t) => t.name).join(' ')).toLowerCase().includes(n);
    };
    const GROUPS_UI = [['everyone', 'Everyone'], ['buyers', 'Bought'], ['repeat', 'Repeat buyers'], ['bidders', 'Bidders'], ['subscribed', 'On the email list'], ['never_bought', 'Subscribed, never bought']];
    host.innerHTML = `<div id="pmsg"></div><div class="row wrap" id="pchips" style="gap:8px;margin-bottom:10px"></div>
      <div class="row wrap" style="gap:8px;margin-bottom:10px"><div class="search" style="flex:1;min-width:220px;margin:0">${icon('search')}<input class="input" id="pq" placeholder="Search by name, email or tag…" value="${esc(pstate.q)}"></div><button class="btn" id="ptags">Manage tags</button></div>
      <div id="pbar"></div><div class="card tbl-scroll" style="padding:0"><table><thead><tr><th style="width:34px"><input type="checkbox" id="pall" aria-label="Select everyone shown"></th><th>Person</th><th>Tags</th><th>Orders</th><th>Spent</th><th>Last order</th><th>Email list</th></tr></thead><tbody id="prows"></tbody></table></div>
      <p class="hint">Built from paid orders, auction bids and your email list. Groups fill themselves in; tags are yours. Click a name to see everything about that person. Nothing is shared with anyone.</p>`;
    const paintChips = () => {
      const f = pstate.filter; const isOn = (k, id) => (k === 'tag' ? f.kind === 'tag' && f.id === id : f.kind === (k === 'everyone' ? 'everyone' : 'group') && (k === 'everyone' || f.key === k));
      $('#pchips').innerHTML = GROUPS_UI.map(([k, l]) => `<button class="chip${isOn(k) ? ' on' : ''}" data-g="${k}">${l} · ${d.groups[k]}</button>`).join('') + d.tags.map((t) => `<button class="chip${isOn('tag', t.id) ? ' on' : ''}" data-tag="${t.id}">${esc(t.name)} · ${t.count}</button>`).join('')
        + (audienceFor(f) ? ` <button class="btn btn-sm btn-primary" id="pmail">Write an email to this group</button>` : '');
    };
    const paintRows = () => {
      const rows = d.people.filter(matches), shown = rows.slice(0, 200);
      $('#prows').innerHTML = shown.map((p) => `<tr><td><input type="checkbox" data-sel="${esc(p.email)}" ${pstate.sel.has(p.email) ? 'checked' : ''} aria-label="Select ${esc(p.email)}"></td>
        <td><button class="plink" data-open="${esc(p.email)}">${esc(p.name || p.email)}</button>${p.name ? `<br><span class="small muted">${esc(p.email)}</span>` : ''}</td>
        <td>${p.tags.map((t) => `<span class="chip tag">${esc(t.name)}</span>`).join(' ')}${p.has_note ? ' <span class="small muted" title="Has a private note">✎ note</span>' : ''}</td>
        <td>${p.orders}</td><td><b>${fmt(p.spent_cents)}</b></td><td class="small">${dateShort(p.last_order)}</td><td>${emailBadge(p.email_status)}</td></tr>`).join('')
        || `<tr><td colspan="7" class="empty">${d.people.length ? 'No one matches.' : 'No one yet. People appear here when they order, bid, or join your email list.'}</td></tr>`;
      $('#pall').checked = shown.length > 0 && shown.every((p) => pstate.sel.has(p.email));
      $('#pbar').innerHTML = (rows.length > 200 ? `<div class="small muted" style="margin:0 0 6px">Showing the first 200 of ${rows.length}. Search or pick a group to narrow it down.</div>` : '')
        + (pstate.sel.size ? `<div class="card" style="margin-bottom:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--cream-2)"><b>${pstate.sel.size} selected</b><button class="btn btn-sm" id="padd">Add tag…</button><button class="btn btn-sm" id="prem">Remove tag…</button><button class="btn btn-sm btn-ghost" id="pclr">Clear</button></div>` : '');
      const bind = (id, fn) => { if ($(id)) $(id).onclick = fn; };
      bind('#padd', () => tagModal([...pstate.sel], 'add', reload)); bind('#prem', () => tagModal([...pstate.sel], 'remove', reload)); bind('#pclr', () => { pstate.sel.clear(); paintRows(); });
    };
    const reload = async () => { d = await api('/api/admin/people'); const f = pstate.filter; if (f.kind === 'tag' && !d.tags.some((t) => t.id === f.id)) pstate.filter = { kind: 'everyone' }; paintChips(); paintRows(); };
    $('#pchips').onclick = (e) => {
      const g = e.target.closest('[data-g]'), t = e.target.closest('[data-tag]');
      if (g) pstate.filter = g.dataset.g === 'everyone' ? { kind: 'everyone' } : { kind: 'group', key: g.dataset.g };
      else if (t) pstate.filter = { kind: 'tag', id: Number(t.dataset.tag) };
      else if (e.target.closest('#pmail')) { mk.openNew = { audience: audienceFor(pstate.filter) }; location.hash = '#/marketing/email'; return; }
      else return;
      paintChips(); paintRows();
    };
    $('#pq').oninput = (e) => { pstate.q = e.target.value; paintRows(); };
    $('#ptags').onclick = () => tagsModal(reload);
    $('#pall').onchange = (e) => { d.people.filter(matches).slice(0, 200).forEach((p) => { if (e.target.checked) pstate.sel.add(p.email); else pstate.sel.delete(p.email); }); paintRows(); };
    $('#prows').onclick = (e) => {
      const o = e.target.closest('[data-open]'); if (o) return openProfile(o.dataset.open, reload);
    };
    $('#prows').onchange = (e) => { const c = e.target.closest('[data-sel]'); if (!c) return; if (c.checked) pstate.sel.add(c.dataset.sel); else pstate.sel.delete(c.dataset.sel); paintRows(); };
    paintChips(); paintRows();
  }

  // Add or remove tags for the people picked.
  async function tagModal(emails, mode, done) {
    const tags = await api('/api/admin/tags'); const chosen = new Set();
    const m = openModal(`<div style="text-align:left"><h2 style="font-size:22px;margin-bottom:6px">${mode === 'add' ? 'Add a tag' : 'Remove a tag'}</h2><p class="muted small" style="margin:0 0 10px">For ${emails.length} ${emails.length === 1 ? 'person' : 'people'}. Tags are your own labels, like “Box member” or “Commission client”.</p>
      <div class="row wrap" id="tg-chips" style="gap:6px;margin-bottom:10px">${tags.map((t) => `<button class="chip" data-tg="${esc(t.name)}">${esc(t.name)} · ${t.count}</button>`).join('') || '<span class="muted small">No tags yet.</span>'}</div>
      ${mode === 'add' ? '<label class="field"><span class="label">Or make a new tag</span><input class="input" id="tg-new" maxlength="40" placeholder="Box member"></label>' : ''}
      <div id="tg-msg"></div><div class="row" style="gap:8px;justify-content:flex-end;margin-top:12px"><button class="btn" data-n>Cancel</button><button class="btn btn-primary" data-y>${mode === 'add' ? 'Add' : 'Remove'}</button></div></div>`);
    m.el.querySelectorAll('[data-tg]').forEach((b) => { b.onclick = () => { const n = b.dataset.tg; if (chosen.has(n)) chosen.delete(n); else chosen.add(n); b.classList.toggle('on', chosen.has(n)); }; });
    m.el.querySelector('[data-n]').onclick = m.close;
    m.el.querySelector('[data-y]').onclick = async () => {
      const names = [...chosen]; const nw = $('#tg-new', m.el); if (nw && nw.value.trim()) names.push(nw.value.trim());
      if (!names.length) { $('#tg-msg', m.el).innerHTML = '<div class="msg err">Pick a tag first.</div>'; return; }
      try { await post('/api/admin/people/tag', { emails, [mode === 'add' ? 'add' : 'remove']: names }); m.close(); toast(mode === 'add' ? 'Tag added' : 'Tag removed'); await done(); }
      catch (e) { $('#tg-msg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
  }

  // Rename or delete tags.
  async function tagsModal(done) {
    const m = openModal('<div id="tgm" style="text-align:left"></div>', { wide: true }); m.el.style.maxWidth = '560px';
    const paint = async () => {
      const tags = await api('/api/admin/tags');
      $('#tgm', m.el).innerHTML = `<h2 style="font-size:22px;margin-bottom:6px">Your tags</h2><p class="muted small" style="margin:0 0 10px">Rename a tag and everyone who has it keeps it. Deleting only removes the label, never the people.</p>
        ${tags.map((t) => `<div class="row" style="gap:8px;margin-bottom:6px"><input class="input" value="${esc(t.name)}" maxlength="40" data-rn="${t.id}" style="flex:1"><span class="small muted" style="min-width:70px">${t.count} ${t.count === 1 ? 'person' : 'people'}</span><button class="btn btn-sm" data-sv="${t.id}">Save</button><button class="btn btn-sm btn-ghost" data-dl="${t.id}" data-nm="${esc(t.name)}">Delete</button></div>`).join('') || '<div class="empty">No tags yet. Add one from the list: tick a few people, then “Add tag…”.</div>'}
        <div id="tgmsg"></div><div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-x>Done</button></div>`;
      m.el.querySelector('[data-x]').onclick = () => { m.close(); done(); };
      m.el.querySelectorAll('[data-sv]').forEach((b) => { b.onclick = async () => { try { await put('/api/admin/tags/' + b.dataset.sv, { name: m.el.querySelector(`[data-rn="${b.dataset.sv}"]`).value }); toast('Renamed'); paint(); } catch (e) { $('#tgmsg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; } }; });
      m.el.querySelectorAll('[data-dl]').forEach((b) => { b.onclick = async () => {
        if (!(await confirmBox({ title: `Delete “${b.dataset.nm}”?`, body: 'The tag is removed from everyone who has it. The people stay.', yes: 'Delete tag', danger: true }))) return;
        try { await api('/api/admin/tags/' + b.dataset.dl, { method: 'DELETE' }); toast('Deleted'); paint(); }
        catch (e) {
          if (e.status !== 409) { $('#tgmsg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
          if (await confirmBox({ title: 'An email is waiting for this tag', body: esc(e.message) + ' If you delete it, those emails go back to drafts for everyone, and nothing is sent until you schedule them again.', yes: 'Delete and make them drafts', danger: true })) { try { await api('/api/admin/tags/' + b.dataset.dl + '?force=1', { method: 'DELETE' }); toast('Deleted'); paint(); } catch (e2) { $('#tgmsg', m.el).innerHTML = `<div class="msg err">${esc(e2.message)}</div>`; } }
        }
      }; });
    };
    paint();
  }

  // One person: everything in one place.
  async function openProfile(email, changed) {
    let p; try { p = await api('/api/admin/people/profile?email=' + encodeURIComponent(email)); } catch (e) { toast(e.message); return; }
    const allTags = await api('/api/admin/tags').catch(() => []);
    const m = openModal('<div id="pf"></div>', { wide: true }); m.el.style.maxWidth = '760px'; m.el.style.textAlign = 'left';
    let note0 = p.note; const dirty = () => { const n = $('#pf-note', m.el); return !!n && n.value !== note0; };
    const stat = (l, v) => `<div class="card" style="padding:10px 14px;min-width:90px"><div class="small muted">${l}</div><b>${v}</b></div>`;
    const refresh = async () => { p = await api('/api/admin/people/profile?email=' + encodeURIComponent(email)); note0 = p.note; paint(); changed(); };
    function paint() {
      $('#pf', m.el).innerHTML = `<div class="row" style="align-items:flex-start;gap:10px"><div style="flex:1"><h2 style="font-size:24px;margin:0">${esc(p.name || p.email)}</h2><div class="small muted">${esc(p.email)} ${emailBadge(p.email_status)}${p.subscribed_at ? ` · joined the list ${esc(dateShort(p.subscribed_at))}${p.source ? ' from ' + esc(p.source) : ''}` : ''}</div></div><button class="btn btn-sm" data-close>Close</button></div>
        <div class="row wrap" style="gap:8px;margin:12px 0">${stat('Orders', p.orders)}${stat('Spent', fmt(p.spent_cents))}${stat('Bids', p.bids)}${stat('Auctions won', p.won)}${stat('Last order', dateShort(p.last_order))}</div>
        <div class="label">Tags</div><div class="row wrap" style="gap:6px;margin-bottom:6px">${p.tags.map((t) => `<span class="chip tag">${esc(t.name)} <button class="mk-tx" data-untag="${esc(t.name)}" aria-label="Remove tag ${esc(t.name)}" style="width:22px;height:22px">×</button></span>`).join('') || '<span class="muted small">No tags yet.</span>'}</div>
        <div class="row" style="gap:6px;margin-bottom:12px"><input class="input" id="pf-tag" list="pf-tags" maxlength="40" placeholder="Add a tag" style="max-width:240px"><datalist id="pf-tags">${allTags.map((t) => `<option value="${esc(t.name)}">`).join('')}</datalist><button class="btn btn-sm" id="pf-addtag">Add</button></div>
        <label class="field"><span class="label">Private note <span class="small muted">only you can see this</span></span><textarea class="input" id="pf-note" rows="3" maxlength="2000" placeholder="Likes pickup. Allergic to nuts. Asked about a custom order.">${esc(p.note)}</textarea></label>
        <div class="row" style="gap:8px;margin-bottom:12px"><button class="btn btn-sm" id="pf-savenote">Save note</button><span id="pf-msg" class="small muted"></span></div>
        ${p.orders_list.length ? `<div class="label">Orders</div><div class="tbl-scroll" style="max-height:200px;overflow:auto;margin-bottom:12px"><table><tbody>${p.orders_list.map((o) => `<tr><td>#${o.id}</td><td class="small">${dateShort(o.created_at)}</td><td class="small">${esc(o.items.join(', '))}</td><td><b>${fmt(o.total_cents - (o.refunded_cents || 0))}</b>${o.status === 'refunded' ? ' <span class="badge">Refunded</span>' : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${p.emails.length ? `<div class="label">Emails you sent them</div><div class="small" style="margin-bottom:12px">${p.emails.map((x) => `${esc(x.subject)} <span class="muted">· ${x.status}</span>`).join('<br>')}</div>` : ''}
        <div class="row wrap" style="gap:8px;justify-content:flex-end"><a class="btn" href="mailto:${esc(encodeURIComponent(p.email).replace(/%40/g, '@'))}">Email from my mail app</a><button class="btn btn-ghost" id="pf-block">Block…</button></div>`;
      m.el.querySelector('[data-close]').onclick = guardClose(m, dirty);
      m.el.querySelectorAll('[data-untag]').forEach((b) => { b.onclick = async () => { try { await post('/api/admin/people/tag', { emails: [p.email], remove: [b.dataset.untag] }); await refresh(); } catch (e) { toast(e.message); } }; });
      const addTag = async () => { const v = $('#pf-tag', m.el).value.trim(); if (!v) return; try { await post('/api/admin/people/tag', { emails: [p.email], add: [v] }); await refresh(); } catch (e) { $('#pf-msg', m.el).textContent = e.message; } };
      $('#pf-addtag', m.el).onclick = addTag; $('#pf-tag', m.el).onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } };
      $('#pf-savenote', m.el).onclick = async () => { try { await put('/api/admin/people/note', { email: p.email, note: $('#pf-note', m.el).value }); note0 = $('#pf-note', m.el).value; $('#pf-msg', m.el).textContent = 'Saved'; changed(); } catch (e) { $('#pf-msg', m.el).textContent = e.message; } };
      $('#pf-block', m.el).onclick = async () => {
        if (!(await confirmBox({ title: `Block ${p.email}?`, body: 'They won’t be able to check out or bid, and any bids they have on open lots come off the board.', yes: 'Block', danger: true }))) return;
        try { await post('/api/admin/blocks', { kind: 'email', value: p.email, note: 'Blocked from People' }); toast('Blocked'); } catch (e) { toast(e.message); }
      };
    }
    paint();
  }

  async function peopleEmail(host) {
    const [list, subs] = await Promise.all([api('/api/admin/customers'), api('/api/admin/subscribers')]);
    host.innerHTML = `<div class="row" style="justify-content:flex-end;margin-bottom:8px"><button class="btn" id="erasebtn" style="color:var(--bad,#b42318);border-color:currentColor">Erase a person…</button></div><div id="cmsg"></div><div id="erasebox"></div>
      <div class="card" id="elist" style="margin-bottom:18px"><div class="row" style="flex-wrap:wrap;gap:10px;align-items:center"><div><h2 style="font-size:20px;margin:0">Email list</h2><div class="small muted"><b>${subs.filter((x) => !x.unsubscribed).length}</b> subscribed${subs.some((x) => x.unsubscribed) ? ` · ${subs.filter((x) => x.unsubscribed).length} unsubscribed` : ''}. Only people who ticked the box on your links page.</div></div><span class="spacer"></span><button class="btn btn-primary" id="edl" ${subs.length ? '' : 'disabled'}>Download CSV</button></div>
        ${subs.length ? `<div class="tbl-scroll" style="margin-top:12px"><table><thead><tr><th>Email</th><th>Joined</th><th>From</th><th>Status</th><th></th></tr></thead><tbody id="erows">${subs.slice(0, 50).map((x) => `<tr><td>${esc(x.email)}</td><td class="small">${esc(new Date(x.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</td><td class="small">${esc(x.source || '')}</td><td>${x.unsubscribed ? '<span class="badge b-canceled">Unsubscribed</span>' : x.bounced ? '<span class="badge b-canceled">Bounced</span>' : !x.consent_at ? '<span class="badge">No consent on file</span>' : !x.confirmed_at ? '<span class="badge b-pending">Waiting to confirm</span>' : '<span class="badge b-paid">Subscribed</span>'}</td><td><button class="btn btn-sm" data-eun="${x.id}" data-to="${x.unsubscribed ? 0 : 1}">${x.unsubscribed ? 'Put back on list' : 'Mark unsubscribed'}</button> <button class="btn btn-sm btn-ghost" data-esub="${x.id}">Remove</button></td></tr>`).join('')}</tbody></table>${subs.length > 50 ? `<div class="small muted" style="margin-top:6px">Showing the latest 50. The CSV has everyone.</div>` : ''}</div>` : '<p class="muted small" style="margin:10px 0 0">No signups yet. Turn on the signup box under Links.</p>'}
        <div class="hint">The CSV (email, joined, source, status) opens in any spreadsheet and imports into Mailchimp, Buttondown, Kit, Klaviyo and most other email services. Write and send emails to this list in <a href="#/marketing/email">Marketing → Email</a>. Only people who agreed, haven’t unsubscribed or bounced (and confirmed, if you ask for that) are ever emailed.</div></div>`;
    // --- erase a person (delete-my-information requests) ---
    $('#erasebtn').onclick = () => {
      $('#erasebox').innerHTML = `<div class="card" style="margin-bottom:18px"><h2 style="font-size:20px;margin:0 0 6px">Erase a person’s information</h2>
        <p class="muted small" style="margin:0 0 10px">For when someone asks you to remove their information. Enter the email address they used.</p>
        <label class="field"><span class="label">Their email address</span><input class="input" id="eremail" type="email" inputmode="email" autocomplete="off"></label>
        <div id="erwhat"></div><div id="erwarn"></div>
        <div class="row mt" style="gap:10px"><button class="btn btn-primary" id="ergo" style="background:var(--bad,#b42318)">Erase this person</button><button class="btn btn-ghost" id="ercancel">Cancel</button></div><div id="ermsg"></div></div>`;
      const what = () => {
        const em = $('#eremail').value.trim().toLowerCase();
        const c = list.find((x) => x.email === em);
        $('#erwhat').innerHTML = em ? `<div class="msg" style="margin-top:10px"><b>What will happen</b><ul class="small" style="margin:6px 0 0 18px;padding:0;line-height:1.6">
          <li>Their name, email, address, saved card and bidder sign-in are blanked.</li>
          <li>${c ? c.orders + ' order' + (c.orders === 1 ? '' : 's') : 'Any orders'} keep their amounts and dates but lose the email and address.</li>
          <li>Their bids stay in the lot history, shown as “Removed bidder”.</li>
          <li>They’re taken off the email list. A saved card is deleted at Stripe.</li></ul>
          <div class="small muted" style="margin-top:6px">Stripe keeps its own record of payments. If they asked for that to go too, remove it in your Stripe dashboard.</div></div>` : '';
      };
      $('#eremail').oninput = what;
      $('#ercancel').onclick = () => { $('#erasebox').innerHTML = ''; };
      let force = false;
      $('#ergo').onclick = async () => {
        const em = $('#eremail').value.trim();
        if (!em) return ($('#ermsg').innerHTML = '<div class="msg err">Enter an email address.</div>');
        if (force && $('#erforce') && !$('#erforce').checked) return ($('#ermsg').innerHTML = '<div class="msg err">Tick the box to erase anyway, or ship the order first.</div>');
        const c0 = list.find((x) => x.email === em.toLowerCase());
        const sure = await new Promise((resolve) => {
          const cm = openModal(`<h2 style="font-size:22px;margin-bottom:8px">Erase this person?</h2>
            <p style="margin:0 0 6px"><b>${esc(em)}</b>${c0 && c0.name ? ' (' + esc(c0.name) + ')' : ''}</p>
            <p class="muted small" style="margin:0 0 14px">Their name, address and email are removed from your orders, bidder records and email list, and a saved card is deleted at Stripe. <b>This can’t be undone.</b></p>
            <div class="row" style="gap:10px;justify-content:center"><button class="btn" id="er-no">Cancel</button><button class="btn btn-primary" id="er-yes" style="background:var(--bad,#b42318)">Yes, erase</button></div>`);
          cm.el.setAttribute('role', 'alertdialog'); cm.el.setAttribute('aria-modal', 'true');
          $('#er-no', cm.el).focus();
          const end = (v) => { document.removeEventListener('keydown', onKey); cm.close(); resolve(v); };
          const onKey = (ev) => { if (ev.key === 'Escape') end(false); };
          document.addEventListener('keydown', onKey);
          $('#er-no', cm.el).onclick = () => end(false); $('#er-yes', cm.el).onclick = () => end(true);
        });
        if (!sure) return;
        $('#ergo').disabled = true; $('#ermsg').innerHTML = '';
        try {
          const r = await post('/api/admin/privacy/erase', { email: em, ...(force ? { force: true } : {}) });
          const done = `<div class="msg"><b>Done.</b> ${r.bidders} bidder record${r.bidders === 1 ? '' : 's'}, ${r.orders} order${r.orders === 1 ? '' : 's'} and ${r.subscribers} email list entr${r.subscribers === 1 ? 'y' : 'ies'} erased. ${esc(r.note || '')}${r.stripe_customers_failed ? ' <b>A saved-card customer could not be deleted at Stripe; remove it in your Stripe dashboard.</b>' : ''}</div>`;
          await peopleEmail(host); $('#cmsg').innerHTML = done;
        } catch (err) {
          $('#ergo').disabled = false;
          if (/paid but not shipped/.test(err.message)) {
            force = true;
            $('#erwarn').innerHTML = `<div class="msg err" style="margin-top:10px;background:#fff8e6;color:#5c3d00;border-color:#f1d9a8">${esc(err.message)}</div><label class="check" style="margin-top:8px"><input type="checkbox" id="erforce"> <span>Erase anyway, even though an order isn’t shipped</span></label>`;
          } else $('#ermsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`;
        }
      };
    };
    if ($('#edl')) $('#edl').onclick = () => download('/api/admin/subscribers.csv', 'email-list.csv').catch((e) => { $('#cmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
    if ($('#erows')) $('#erows').onclick = async (e) => {
      const un = e.target.closest('[data-eun]');
      if (un) {
        try { await put('/api/admin/subscribers/' + un.dataset.eun, { unsubscribed: un.dataset.to === '1' }); toast(un.dataset.to === '1' ? 'Marked unsubscribed' : 'Back on the list'); peopleEmail(host); }
        catch (err) { $('#cmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
        return;
      }
      const b = e.target.closest('[data-esub]'); if (!b) return;
      if (!(await confirmBox({ title: 'Remove this email?', body: 'It comes off your email list for good. They can sign up again.', yes: 'Remove', danger: true }))) return;
      try { await api('/api/admin/subscribers/' + b.dataset.esub, { method: 'DELETE' }); toast('Removed'); peopleEmail(host); }
      catch (err) { $('#cmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
  }



  // =====================================================================
  // LINKS (link-in-bio page)
  // =====================================================================
  const SHOP_PAGES = [['store.html', 'My shop'], ['auction.html', 'Auctions'], ['about.html', 'About page'], ['reviews.html', 'Reviews']];
  // =====================================================================
  // MARKETING (tracked links, sales by source)
  // =====================================================================
  async function viewMarketing(m) {
    const tab = (m && m[1]) || 'calendar';
    const seq = routeSeq;
    mk.loaded = false;
    view().innerHTML = `
      <div class="topbar"><h1>Marketing</h1></div>
      <div class="seg" id="mktabs">
        ${[['calendar', 'Calendar'], ['gallery', 'Gallery'], ['ready', 'Ready to post'], ['email', 'Email'], ['links', 'Tracked links'], ['sources', 'Sales by link']].map(([k, l]) => `<button data-t="${k}" class="${tab === k ? 'on' : ''}">${l}${k === 'ready' ? '<span class="nav-badge"></span>' : ''}</button>`).join('')}
      </div>
      <div id="mkbody" style="margin-top:12px"></div>`;
    document.querySelectorAll('#mktabs button').forEach((b) => { b.onclick = () => { location.hash = '#/marketing/' + b.dataset.t; }; });
    mkBadge();
    try {
      if (tab === 'sources') return await mktSources(seq);
      if (tab === 'links') return await mktLinks(seq);
      if (tab === 'gallery') return await mktGallery(seq);
      if (tab === 'ready') return await mktReady(seq);
      if (tab === 'email') return await mktEmail(seq);
      return await mktCalendar(seq);
    } catch (e) { if (seq === routeSeq) $('#mkbody').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
  }

  // ---- Marketing: calendar, gallery, post editor, ready to post (all times shown in the shop's timezone) ----
  const mk = { lines: [], tz: '', cal: 'week', day: '', posts: [], photos: [], links: [], products: [], on: false, loaded: false };
  const pad2 = (n) => String(n).padStart(2, '0');
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function zparts(ms) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: mk.tz || undefined, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const o = {}; f.formatToParts(new Date(ms)).forEach((p) => { o[p.type] = Number(p.value); });
    return { y: o.year, m: o.month, d: o.day, h: o.hour % 24, mi: o.minute };
  }
  const dayKey = (p) => `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
  const keyOf = (ms) => dayKey(zparts(ms));
  const keyParts = (k) => { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; };
  const addDays = (k, n) => { const { y, m, d } = keyParts(k); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`; };
  const dowOf = (k) => { const { y, m, d } = keyParts(k); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  function zoned(k, h, mi) {   // a wall-clock time in the shop timezone -> UTC ms
    const { y, m, d } = keyParts(k); const guess = Date.UTC(y, m - 1, d, h, mi);
    const off = (t) => { const p = zparts(t); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - t; };
    let t = guess - off(guess); t = guess - off(t); return t;
  }
  const hr12 = (h) => (h % 12 || 12) + (h < 12 ? ' AM' : ' PM');
  const clock = (ms) => { const p = zparts(ms); return (p.h % 12 || 12) + ':' + pad2(p.mi) + (p.h < 12 ? ' AM' : ' PM'); };
  const dayLabel = (k) => { const { m, d } = keyParts(k); return DOW[dowOf(k)] + ' ' + MON[m - 1].slice(0, 3) + ' ' + d; };
  const postThumb = (p) => p.photos[0] ? `<img src="${esc(p.photos[0])}" alt="">` : '<span class="mk-nophoto">No photo</span>';

  async function mkLoad() {
    const [pp, ph, ln, set, prods, lns] = await Promise.all([api('/api/admin/marketing/posts'), api('/api/admin/marketing/photos'), api('/api/admin/marketing/links'), fetch('/api/settings').then((r) => r.json()), fetch('/api/products').then((r) => r.json()).catch(() => []), fetch('/api/lines').then((r) => r.json()).catch(() => [])]);
    mk.posts = pp.posts; mk.on = !!pp.gallery_on; mk.photos = ph; mk.links = ln.links.filter((l) => !l.archived); mk.products = prods; mk.lines = lns; mk.tz = set.timezone || '';
    if (!mk.day) mk.day = keyOf(Date.now());
    mk.loaded = true;
  }
  async function mkBadge() {
    try { const d = await api('/api/admin/marketing/due'); const a = document.querySelector('.nav a[data-k="marketing"]'); if (!a) return d.count; let b = a.querySelector('.nav-badge'); if (d.count) { if (!b) { b = document.createElement('span'); b.className = 'nav-badge'; a.appendChild(b); } b.textContent = d.count; } else if (b) b.remove(); const t = document.querySelector('#mktabs [data-t="ready"] .nav-badge'); if (t) t.textContent = d.count || ''; return d.count; } catch { return 0; }
  }

  // Calendar ------------------------------------------------------------
  function postChip(p) {
    const st = p.status === 'draft' ? 'draft' : (p.posted_at ? 'posted' : '');
    return `<button class="mk-chip ${st}" draggable="${p.status === 'scheduled' ? 'true' : 'false'}" data-post="${p.id}" title="${esc(p.caption.slice(0, 80))}">${postThumb(p)}<span>${p.scheduled_at ? clock(p.scheduled_at) : 'Draft'}</span></button>`;
  }
  async function mktCalendar(seq) {
    if (!mk.loaded) await mkLoad(); if (seq !== routeSeq) return;
    const body = $('#mkbody');
    const sched = mk.posts.filter((p) => p.status === 'scheduled' && p.scheduled_at);
    const drafts = mk.posts.filter((p) => p.status === 'draft');
    const today = keyOf(Date.now());
    let head = '', grid = '';
    if (mk.cal === 'week') {
      const start = addDays(mk.day, -dowOf(mk.day)); const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i));
      head = `${dayLabel(days[0])} – ${dayLabel(days[6])}`;
      const byCell = {}; sched.forEach((p) => { const z = zparts(p.scheduled_at); (byCell[dayKey(z) + '|' + z.h] ||= []).push(p); });
      grid = `<div class="mk-week"><div class="mk-corner"></div>${days.map((d) => `<div class="mk-dh${d === today ? ' today' : ''}">${dayLabel(d)}</div>`).join('')}` +
        Array.from({ length: 24 }, (_, h) => h).filter((h) => h >= 6 || (byCell && days.some((d) => byCell[d + '|' + h]))).map((h) => `<div class="mk-hr">${hr12(h)}</div>${days.map((d) => `<div class="mk-cell${d === today ? ' today' : ''}" data-day="${d}" data-hour="${h}">${(byCell[d + '|' + h] || []).sort((a, b) => a.scheduled_at - b.scheduled_at).map(postChip).join('')}</div>`).join('')}`).join('') + '</div>';
    } else if (mk.cal === 'month') {
      const { y, m } = keyParts(mk.day); const first = `${y}-${pad2(m)}-01`; const start = addDays(first, -dowOf(first));
      head = MON[m - 1] + ' ' + y;
      const byDay = {}; sched.forEach((p) => { (byDay[keyOf(p.scheduled_at)] ||= []).push(p); });
      const cells = []; for (let i = 0; i < 42; i++) { const d = addDays(start, i); if (i >= 35 && keyParts(d).m !== m) break; cells.push(d); }
      grid = `<div class="mk-month">${DOW.map((x) => `<div class="mk-dh">${x}</div>`).join('')}${cells.map((d) => `<div class="mk-mcell${keyParts(d).m !== m ? ' other' : ''}${d === today ? ' today' : ''}" data-day="${d}" data-hour="10"><div class="mk-dn">${keyParts(d).d}</div>${(byDay[d] || []).sort((a, b) => a.scheduled_at - b.scheduled_at).map(postChip).join('')}</div>`).join('')}</div>`;
    } else {
      head = 'All scheduled posts';
      grid = sched.length ? `<div class="card" style="padding:0">${[...sched].sort((a, b) => a.scheduled_at - b.scheduled_at).map((p) => `<div class="mk-listrow" data-post="${p.id}"><div class="mk-lthumb">${postThumb(p)}</div><div style="flex:1;min-width:0"><b>${esc(dayLabel(keyOf(p.scheduled_at)))} · ${clock(p.scheduled_at)}</b><div class="small muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.caption) || 'No caption'}</div></div><span class="small muted">${[p.to_gallery && 'Gallery', p.to_instagram && 'Instagram', p.to_facebook && 'Facebook'].filter(Boolean).join(', ')}</span></div>`).join('')}</div>` : '<div class="card"><div class="empty">Nothing scheduled yet. Choose “New post” to start.</div></div>';
    }
    body.innerHTML = `<div class="row wrap" style="gap:8px;margin-bottom:10px;align-items:center">
        <div class="seg" id="calmode">${['week', 'month', 'list'].map((v) => `<button data-v="${v}" class="${mk.cal === v ? 'on' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
        ${mk.cal !== 'list' ? `<button class="btn btn-sm" id="calprev" aria-label="Previous">‹</button><button class="btn btn-sm" id="caltoday">Today</button><button class="btn btn-sm" id="calnext" aria-label="Next">›</button>` : ''}
        <b style="flex:1">${esc(head)}</b><span class="small muted">Times in ${esc(mk.tz || 'your computer’s time zone')}</span>
        <button class="btn" id="bulkadd">Bulk add</button><button class="btn btn-primary" id="newpost">New post</button></div>
      ${grid}
      ${drafts.length ? `<div class="card" style="margin-top:12px"><h2 style="font-size:20px;margin-bottom:6px">Drafts</h2><div class="mk-drafts">${drafts.map((p) => `<button class="mk-draft" data-post="${p.id}">${postThumb(p)}<span>${esc(p.caption.slice(0, 40)) || 'Untitled'}</span></button>`).join('')}</div></div>` : ''}
      <p class="hint" style="margin-top:8px">Click an empty time slot to add a post there. Drag a post to move it. Posts for the Gallery appear on your public page when their time arrives. Instagram and Facebook posts show up in “Ready to post” for you to post by hand.</p>`;
    document.querySelectorAll('#calmode button').forEach((b) => { b.onclick = () => { mk.cal = b.dataset.v; mktCalendar(routeSeq); }; });
    const step = (n) => { mk.day = mk.cal === 'month' ? (() => { const { y, m } = keyParts(mk.day); const t = new Date(Date.UTC(y, m - 1 + n, 1)); return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-01`; })() : addDays(mk.day, 7 * n); mktCalendar(routeSeq); };
    if ($('#calprev')) { $('#calprev').onclick = () => step(-1); $('#calnext').onclick = () => step(1); $('#caltoday').onclick = () => { mk.day = keyOf(Date.now()); mktCalendar(routeSeq); }; }
    $('#newpost').onclick = () => mkEditor(null, {});
    $('#bulkadd').onclick = () => mkBulk();
    body.onclick = (e) => {
      const c = e.target.closest('[data-post]'); if (c) { return mkEditor(mk.posts.find((p) => p.id === Number(c.dataset.post))); }
      const cell = e.target.closest('[data-day]'); if (cell) mkEditor(null, { at: zoned(cell.dataset.day, Number(cell.dataset.hour), 0) });
    };
    let dragId = 0;
    body.ondragstart = (e) => { const c = e.target.closest('[data-post]'); if (c && c.draggable) { dragId = Number(c.dataset.post); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(dragId)); } };
    body.ondragover = (e) => { if (dragId && e.target.closest('[data-day]')) e.preventDefault(); };
    body.ondrop = async (e) => {
      const cell = e.target.closest('[data-day]'); if (!cell || !dragId) return; e.preventDefault();
      const p = mk.posts.find((x) => x.id === dragId); dragId = 0; if (!p) return;
      const old = zparts(p.scheduled_at); const at = cell.dataset.hour && mk.cal === 'week' ? zoned(cell.dataset.day, Number(cell.dataset.hour), old.mi) : zoned(cell.dataset.day, old.h, old.mi);
      try { await put('/api/admin/marketing/posts/' + p.id, { scheduled_at: at }); await mkLoad(); toast('Moved to ' + dayLabel(keyOf(at)) + ' ' + clock(at)); mktCalendar(routeSeq); mkBadge(); } catch (er) { toast(er.message); }
    };
  }

  // Post editor ------------------------------------------------------------
  async function jpegFrom(file, max = 1600) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height)); const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not read that photo'))), 'image/jpeg', 0.86));
  }
  function mkEditor(existing, preset = {}) {
    const isNew = !existing;
    const s = existing ? { caption: existing.caption, photos: [...existing.photos], link_code: existing.link_code || '', product_id: existing.product_id || 0, scheduled_at: existing.scheduled_at, to_gallery: existing.to_gallery, to_instagram: existing.to_instagram, to_facebook: existing.to_facebook }
      : { caption: '', photos: [], link_code: '', product_id: 0, scheduled_at: preset.at || null, to_gallery: true, to_instagram: false, to_facebook: false };
    let ratio = '4/5', pick = false;
    let snap0 = null; const snapOf = () => JSON.stringify(s) + '|' + (q0('#edcap') ? q0('#edcap').value : s.caption); const q0 = (x) => document.querySelector('.modal #edbody ' + x) || null;
    const m = openModal('<div id="edbody"></div>', { wide: true });
    m.el.style.maxWidth = '860px'; m.el.style.textAlign = 'left';
    const dateVal = () => (s.scheduled_at ? keyOf(s.scheduled_at) : ''); const timeVal = () => (s.scheduled_at ? (() => { const p = zparts(s.scheduled_at); return pad2(p.h) + ':' + pad2(p.mi); })() : '');
    function paint() {
      $('#edbody', m.el).innerHTML = `<div class="mk-ed">
        <div class="mk-prev"><div class="seg" id="edratio">${[['4/5', '4:5'], ['1/1', 'Square'], ['1.91/1', 'Wide']].map(([v, l]) => `<button data-v="${v}" class="${ratio === v ? 'on' : ''}">${l}</button>`).join('')}</div>
          <div class="mk-phone"><div class="mk-img" style="aspect-ratio:${ratio}">${s.photos[0] ? `<img src="${esc(s.photos[0])}" alt="">` : '<span class="muted">Choose a photo</span>'}</div><div class="mk-pcap">${esc(s.caption.slice(0, 125)) || '<span class="muted">Your caption shows here</span>'}</div></div>
          <p class="hint">Preview only. Instagram may crop slightly differently.</p></div>
        <div class="mk-form">
          <div class="label">Photos <span class="small muted">(${s.photos.length} of 10)</span></div>
          <div class="mk-strip">${s.photos.map((u, i) => `<div class="mk-sp"><img src="${esc(u)}" alt=""><div class="mk-spb">${i > 0 ? `<button data-l="${i}" title="Move left">‹</button>` : ''}<button data-x="${i}" title="Remove">×</button>${i < s.photos.length - 1 ? `<button data-r="${i}" title="Move right">›</button>` : ''}</div></div>`).join('')}</div>
          <div class="row wrap" style="gap:6px;margin:6px 0"><button class="btn btn-sm" id="edpick">${pick ? 'Hide gallery photos' : 'Choose from gallery photos'}</button><label class="btn btn-sm" style="cursor:pointer">Upload new<input type="file" id="edup" accept="image/*" multiple hidden></label></div>
          ${pick ? `<div class="mk-pickgrid">${mk.photos.length ? mk.photos.map((ph) => `<button class="mk-pk${s.photos.includes(ph.url) ? ' on' : ''}" data-u="${esc(ph.url)}"><img src="${esc(ph.url)}" alt=""></button>`).join('') : '<span class="muted small">No gallery photos yet. Upload one.</span>'}</div>` : ''}
          <label class="field"><span class="label">Caption <span class="small muted" id="edcount">${s.caption.length}/2200</span></span><textarea class="input" id="edcap" rows="5" maxlength="2200">${esc(s.caption)}</textarea></label>
          <div class="row wrap" style="gap:8px"><label class="field" style="flex:1;min-width:140px"><span class="label">Date</span><input type="date" class="input" id="eddate" value="${dateVal()}"></label><label class="field" style="flex:1;min-width:120px"><span class="label">Time</span><input type="time" class="input" id="edtime" value="${timeVal()}"></label></div>
          <div class="row wrap" style="gap:8px"><label class="field" style="flex:1;min-width:150px"><span class="label">Tracked link</span><select class="input" id="edlink"><option value="">None</option>${mk.links.map((l) => `<option value="${esc(l.code)}"${l.code === s.link_code ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select></label>
            <label class="field" style="flex:1;min-width:150px"><span class="label">Shop this product</span><select class="input" id="edprod"><option value="0">None</option>${mk.products.map((p) => `<option value="${p.id}"${p.id === s.product_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label></div>
          <div class="label">Where it goes</div>
          <div class="row wrap" style="gap:12px;margin-bottom:8px">${[['to_gallery', 'Gallery'], ['to_instagram', 'Instagram'], ['to_facebook', 'Facebook']].map(([k, l]) => `<label class="row" style="gap:6px"><input type="checkbox" data-d="${k}" ${s[k] ? 'checked' : ''}> ${l}</label>`).join('')}</div>
          <div id="edmsg"></div>
          <div class="row wrap" style="gap:8px;justify-content:flex-end"><button class="btn" data-close>Cancel</button>${isNew ? '' : '<button class="btn btn-danger" id="eddel">Delete</button>'}<button class="btn" id="eddraft">Save as draft</button><button class="btn btn-primary" id="edsched">Schedule</button></div>
        </div></div>`;
      const q = (x) => $(x, m.el);
      q('#edratio').onclick = (e) => { const b = e.target.closest('button'); if (b) { ratio = b.dataset.v; paint(); } };
      q('#edpick').onclick = () => { pick = !pick; sync(); paint(); };
      q('#edcap').oninput = (e) => { q('#edcount').textContent = e.target.value.length + '/2200'; const c = q('.mk-pcap'); if (c) c.textContent = e.target.value.slice(0, 125) || 'Your caption shows here'; };
      q('.mk-strip').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; sync(); const d = b.dataset; if (d.x !== undefined) s.photos.splice(Number(d.x), 1); else if (d.l !== undefined) { const i = Number(d.l); [s.photos[i - 1], s.photos[i]] = [s.photos[i], s.photos[i - 1]]; } else if (d.r !== undefined) { const i = Number(d.r); [s.photos[i + 1], s.photos[i]] = [s.photos[i], s.photos[i + 1]]; } paint(); };
      const pg = q('.mk-pickgrid'); if (pg) pg.onclick = (e) => { const b = e.target.closest('.mk-pk'); if (!b) return; sync(); const u = b.dataset.u; const i = s.photos.indexOf(u); if (i >= 0) s.photos.splice(i, 1); else if (s.photos.length < 10) s.photos.push(u); paint(); };
      q('#edup').onchange = async (e) => {
        const files = [...e.target.files]; if (!files.length) return; sync(); q('#edmsg').innerHTML = '<div class="msg">Uploading…</div>';
        try {
          for (const f of files) {
            if (s.photos.length >= 10) break;
            const url = await uploadImage(await jpegFrom(f)); await post('/api/admin/marketing/photos', { url }); s.photos.push(url);
          }
          mk.photos = await api('/api/admin/marketing/photos'); paint();
        } catch (er) { q('#edmsg').innerHTML = `<div class="msg err">${esc(er.message || 'That photo could not be added')}</div>`; }
      };
      if (snap0 === null) snap0 = snapOf();
      q('[data-close]').onclick = guardClose(m, () => snapOf() !== snap0);
      q('#eddraft').onclick = () => save('draft'); q('#edsched').onclick = () => save('scheduled');
      if (q('#eddel')) q('#eddel').onclick = async () => { if (!(await confirmBox({ title: 'Delete this post?', body: 'Its photos stay in your gallery photos.', yes: 'Delete', danger: true }))) return; try { await api('/api/admin/marketing/posts/' + existing.id, { method: 'DELETE' }); m.close(); await refresh(); } catch (er) { toast(er.message); } };
    }
    function sync() {
      const q = (x) => $(x, m.el); if (!q('#edcap')) return;
      s.caption = q('#edcap').value; s.link_code = q('#edlink').value; s.product_id = Number(q('#edprod').value);
      m.el.querySelectorAll('[data-d]').forEach((c) => { s[c.dataset.d] = c.checked; });
      const d = q('#eddate').value, t = q('#edtime').value; s.scheduled_at = d && t ? zoned(d, Number(t.slice(0, 2)), Number(t.slice(3, 5))) : (d ? zoned(d, 10, 0) : null);
    }
    async function save(status) {
      sync();
      const body = { caption: s.caption, photos: s.photos, link_code: s.link_code || null, product_id: s.product_id || null, scheduled_at: s.scheduled_at, status, to_gallery: s.to_gallery, to_instagram: s.to_instagram, to_facebook: s.to_facebook };
      if (status === 'scheduled' && !s.scheduled_at) return ($('#edmsg', m.el).innerHTML = '<div class="msg err">Pick a date and time to schedule it.</div>');
      try { if (isNew) await post('/api/admin/marketing/posts', body); else await put('/api/admin/marketing/posts/' + existing.id, body); m.close(); toast(status === 'draft' ? 'Draft saved' : 'Scheduled'); await refresh(); }
      catch (er) { $('#edmsg', m.el).innerHTML = `<div class="msg err">${esc(er.message)}</div>`; }
    }
    paint();
  }
  async function refresh() { await mkLoad(); const t = ($('#mktabs .on') || {}).dataset; const tab = (t && t.t) || 'calendar'; ({ calendar: mktCalendar, gallery: mktGallery, ready: mktReady, email: mktEmail })[tab]?.(routeSeq); mkBadge(); }

  // Gallery (curate) ------------------------------------------------------------
  async function mktGallery(seq) {
    if (!mk.loaded) await mkLoad(); if (seq !== routeSeq) return;
    const now = Date.now(); const list = mk.posts;
    const badges = (p) => [p.pinned && 'Pinned', p.status === 'draft' && 'Draft', p.status === 'scheduled' && p.scheduled_at > now && 'Scheduled', p.hidden && 'Hidden', !p.to_gallery && 'Not in gallery'].filter(Boolean);
    $('#mkbody').innerHTML = `<div class="row wrap" style="gap:10px;margin-bottom:10px;align-items:center">
        <label class="row" style="gap:6px"><input type="checkbox" id="galon" ${mk.on ? 'checked' : ''}> <b>Show the Gallery on my shop</b></label>
        ${mk.on ? '<a class="btn btn-sm" href="/gallery" target="_blank" rel="noopener">View public page</a>' : ''}
        <span style="flex:1"></span><button class="btn btn-primary" id="newpost">New post</button></div>
      ${mk.on ? '' : '<p class="hint">The Gallery is off, so visitors cannot see it yet. Turn it on when you have a few posts ready.</p>'}
      ${list.length ? `<div class="mk-ggrid" id="gg">${list.map((p) => `<div class="mk-gt" draggable="true" data-id="${p.id}"><button class="mk-gimg" data-post="${p.id}">${postThumb(p)}${p.photos.length > 1 ? `<span class="mk-multi">${p.photos.length}</span>` : ''}</button><div class="mk-gb">${badges(p).map((b) => `<span class="badge">${b}</span>`).join('')}</div><div class="mk-ga"><button class="btn btn-sm" data-pin="${p.id}">${p.pinned ? 'Unpin' : 'Pin'}</button><button class="btn btn-sm" data-hide="${p.id}">${p.hidden ? 'Show' : 'Hide'}</button></div></div>`).join('')}</div><p class="hint" style="margin-top:8px">Drag a tile to change the order. Pinned posts stay at the top.</p>`
        : '<div class="card"><div class="empty">No posts yet. Choose “New post” to add your first.</div></div>'}`;
    $('#newpost').onclick = () => mkEditor(null, {});
    $('#galon').onchange = async (e) => { try { await put('/api/admin/marketing/gallery', { on: e.target.checked }); mk.on = e.target.checked; mktGallery(routeSeq); } catch (er) { toast(er.message); e.target.checked = !e.target.checked; } };
    const gg = $('#gg'); if (!gg) return;
    gg.onclick = async (e) => {
      const pin = e.target.closest('[data-pin]'), hide = e.target.closest('[data-hide]'), open = e.target.closest('[data-post]');
      try {
        if (pin) { const p = mk.posts.find((x) => x.id === Number(pin.dataset.pin)); await put('/api/admin/marketing/posts/' + p.id, { pinned: !p.pinned }); await mkLoad(); mktGallery(routeSeq); }
        else if (hide) { const p = mk.posts.find((x) => x.id === Number(hide.dataset.hide)); await put('/api/admin/marketing/posts/' + p.id, { hidden: !p.hidden }); await mkLoad(); mktGallery(routeSeq); }
        else if (open) mkEditor(mk.posts.find((x) => x.id === Number(open.dataset.post)));
      } catch (er) { toast(er.message); }
    };
    let drag = 0;
    gg.ondragstart = (e) => { const t = e.target.closest('.mk-gt'); if (t) { drag = Number(t.dataset.id); e.dataTransfer.setData('text/plain', String(drag)); } };
    gg.ondragover = (e) => { if (drag) e.preventDefault(); };
    gg.ondrop = async (e) => {
      const t = e.target.closest('.mk-gt'); if (!t || !drag) return; e.preventDefault();
      const ids = mk.posts.map((p) => p.id).filter((i) => i !== drag); ids.splice(ids.indexOf(Number(t.dataset.id)), 0, drag); drag = 0;
      try { await post('/api/admin/marketing/posts/order', { ids }); await mkLoad(); mktGallery(routeSeq); } catch (er) { toast(er.message); }
    };
  }

  // Bulk add: paste from a spreadsheet (or open a CSV), check every row, attach photos by file name, then create the posts ------
  function parseTable(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n').replace(/^﻿/, '');
    const delim = t.split('\n', 1)[0].includes('\t') ? '\t' : ',';
    const rows = []; let row = [], cell = '', q = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (q) { if (c === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
      else if (c === '"' && cell === '') q = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else cell += c;
    }
    row.push(cell); if (row.some((x) => x.trim()) || rows.length === 0) rows.push(row);
    return rows.filter((r) => r.some((x) => x.trim()));
  }
  function parseDate(v) {
    v = String(v || '').trim(); let m;
    if ((m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    if ((m = v.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/))) { const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : keyParts(keyOf(Date.now())).y; return `${y}-${pad2(m[1])}-${pad2(m[2])}`; }
    return '';
  }
  function parseTime(v) {
    v = String(v || '').trim().toLowerCase(); if (!v) return { h: 10, mi: 0 };
    const m = v.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/); if (!m) return null;
    let h = Number(m[1]); const mi = Number(m[2] || 0); if (m[3] === 'pm' && h < 12) h += 12; if (m[3] === 'am' && h === 12) h = 0;
    return h > 23 || mi > 59 ? null : { h, mi };
  }
  function mkBulk() {
    const files = new Map();   // lower-case file name -> uploaded gallery photo address
    let rows = [];
    const m = openModal('<div id="bkbody"></div>', { wide: true });
    m.el.style.maxWidth = '980px'; m.el.style.textAlign = 'left';
    const HEAD = ['date', 'time', 'caption', 'photo', 'link', 'product', 'where'];
    const stem = (n) => n.toLowerCase().replace(/\.[a-z0-9]+$/, '');
    function check(cells) {
      const g = (i) => String(cells[i] || '').trim(); const bad = [];
      const day = parseDate(g(0)); const tm = parseTime(g(1)); let at = null;
      if (!day || !tm) bad.push('Bad date or time'); else { at = zoned(day, tm.h, tm.mi); if (at < Date.now() - 60000) bad.push('In the past'); }
      const names = g(3).split(/[;|]/).map((x) => x.trim()).filter(Boolean); const photos = []; const missing = [];
      names.forEach((n) => { const u = files.get(n.toLowerCase()) || files.get(stem(n)); if (u) photos.push(u); else missing.push(n); });
      if (!names.length) bad.push('No photo'); else if (missing.length) bad.push('Photo not added: ' + missing.join(', '));
      let link_code = null; if (g(4)) { const l = mk.links.find((x) => x.name.toLowerCase() === g(4).toLowerCase() || x.code === g(4).toLowerCase()); if (l) link_code = l.code; else bad.push('Unknown link'); }
      let product_id = null; if (g(5)) { const p = mk.products.find((x) => x.name.toLowerCase() === g(5).toLowerCase()); if (p) product_id = p.id; else bad.push('Unknown product'); }
      const w = g(6).toLowerCase(); const to_instagram = /insta|\big\b/.test(w), to_facebook = /face|\bfb\b/.test(w); const to_gallery = w ? /gall/.test(w) || !(to_instagram || to_facebook) : true;
      if (g(2).length > 2200) bad.push('Caption too long');
      return { caption: g(2), photos, link_code, product_id, scheduled_at: at, to_gallery, to_instagram, to_facebook, bad, raw: [g(0), g(1), g(2), g(3)] };
    }
    function load(text) {
      let t = parseTable(text); if (!t.length) { rows = []; return; }
      const first = t[0].map((x) => x.trim().toLowerCase());
      if (first.includes('caption') || first.includes('date')) { const idx = HEAD.map((h) => { const i = first.findIndex((x) => x === h || (h === 'photo' && /photo|image/.test(x)) || (h === 'where' && /where|dest/.test(x))); return i; }); t = t.slice(1); rows = t.map((r) => check(idx.map((i) => (i >= 0 ? r[i] : '')))); }
      else rows = t.map((r) => check(r));
    }
    function paint(msg) {
      const ready = rows.filter((r) => !r.bad.length).length, problems = rows.length - ready;
      $('#bkbody', m.el).innerHTML = `<h2 style="font-size:22px;margin-bottom:4px">Bulk add posts</h2>
        <p class="hint">Copy rows from Google Sheets or Excel and paste them below, or open a CSV file. Columns in this order: <b>date, time, caption, photo file name, link, product, where</b>. “Where” can be Gallery, Instagram, Facebook (or a mix). Link and product are optional and match by name.</p>
        <div class="row wrap" style="gap:6px;margin-bottom:6px"><label class="btn btn-sm" style="cursor:pointer">Open a CSV file<input type="file" id="bkcsv" accept=".csv,.tsv,.txt,text/csv" hidden></label><a href="#" class="small" id="bktpl">Download a template</a></div>
        <textarea class="input" id="bktext" rows="5" placeholder="2026-12-01&#9;10:00 AM&#9;New tiles are up!&#9;frog1.jpg&#9;Instagram bio&#9;Blue frog tile&#9;Gallery, Instagram">${esc($('#bktext', m.el) ? $('#bktext', m.el).value : (m._text || ''))}</textarea>
        <div class="row wrap" style="gap:6px;margin:8px 0;align-items:center"><button class="btn btn-sm btn-primary" id="bkcheck">Check rows</button><label class="btn btn-sm" style="cursor:pointer">Add photos<input type="file" id="bkphotos" accept="image/*" multiple hidden></label><span class="small muted">${new Set(files.values()).size} photo${new Set(files.values()).size === 1 ? '' : 's'} added. Photos match the file names in your sheet.</span></div>
        <div id="bkmsg">${msg || ''}</div>
        ${rows.length ? `<div class="card" style="overflow-x:auto;padding:0"><table><thead><tr><th>#</th><th>When</th><th>Caption</th><th>Photo</th><th>Status</th></tr></thead><tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td class="small">${esc(r.raw[0])} ${esc(r.raw[1])}</td><td class="small" style="max-width:280px">${esc(r.caption.slice(0, 80))}</td><td class="small">${esc(r.raw[3])}</td><td>${r.bad.length ? r.bad.map((b) => `<span class="badge b-pending">${esc(b)}</span>`).join(' ') : '<span class="badge b-paid">Ready</span>'}</td></tr>`).join('')}</tbody></table></div>
        <div class="row wrap" style="gap:10px;margin-top:10px;align-items:center;justify-content:flex-end"><span class="small muted">${ready} ready${problems ? `, ${problems} need attention` : ''}</span>${problems ? '<label class="row small" style="gap:6px"><input type="checkbox" id="bkdr" checked> Save the others as drafts</label>' : ''}<button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="bkgo" ${ready || problems ? '' : 'disabled'}>${ready ? `Schedule ${ready} post${ready === 1 ? '' : 's'}` : 'Save as drafts'}</button></div>` : '<div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" data-close>Close</button></div>'}`;
      const q = (x) => $(x, m.el);
      m.el.querySelectorAll('[data-close]').forEach((b) => { b.onclick = guardClose(m, () => files.size > 0); });
      q('#bkcheck').onclick = () => { m._text = q('#bktext').value; load(m._text); paint(); };
      q('#bkcsv').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; m._text = await f.text(); load(m._text); paint(); };
      q('#bktpl').onclick = (e) => { e.preventDefault(); const url = URL.createObjectURL(new Blob(['date,time,caption,photo,link,product,where\n2026-12-01,10:00 AM,"New tiles are up!",frog1.jpg,,,Gallery\n2026-12-03,2:30 PM,"Studio shelf this morning",shelf.jpg,,,"Gallery, Instagram"\n'], { type: 'text/csv' })); const l = document.createElement('a'); l.href = url; l.download = 'outpost-posts-template.csv'; document.body.appendChild(l); l.click(); l.remove(); };
      q('#bkphotos').onchange = async (e) => {
        const list = [...e.target.files]; if (!list.length) return; let n = 0;
        for (const f of list) {
          try { paint(`<div class="msg">Adding photo ${++n} of ${list.length}…</div>`); const url = await uploadImage(await jpegFrom(f)); await post('/api/admin/marketing/photos', { url }); files.set(f.name.toLowerCase(), url); files.set(stem(f.name), url); }
          catch (er) { paint(`<div class="msg err">${esc(f.name)}: ${esc(er.message)}</div>`); return; }
        }
        m._text = q('#bktext') ? q('#bktext').value : m._text; load(m._text); paint(`<div class="msg ok">${list.length} photo${list.length === 1 ? '' : 's'} added.</div>`);
      };
      if (q('#bkgo')) q('#bkgo').onclick = async () => {
        const asDrafts = q('#bkdr') ? q('#bkdr').checked : false; let made = 0, drafts = 0, failed = 0; q('#bkgo').disabled = true;
        for (const r of rows) {
          const ok = !r.bad.length; if (!ok && !asDrafts) continue;
          const body = { caption: r.caption.slice(0, 2200), photos: r.photos, link_code: r.link_code, product_id: r.product_id, scheduled_at: r.scheduled_at, status: ok ? 'scheduled' : 'draft', to_gallery: r.to_gallery, to_instagram: r.to_instagram, to_facebook: r.to_facebook };
          try { await post('/api/admin/marketing/posts', body); ok ? made++ : drafts++; } catch { failed++; }
        }
        m.close(); toast(`${made} scheduled${drafts ? `, ${drafts} saved as drafts` : ''}${failed ? `, ${failed} failed` : ''}`); await refresh();
      };
    }
    paint();
  }

  // Email tab ------------------------------------------------------------
  const mailBadge = { draft: ['Draft', ''], scheduled: ['Scheduled', 'b-pending'], sending: ['Sending', 'b-info'], done: ['Done', 'b-paid'], canceled: ['Stopped', ''] };
  async function mktEmail(seq) {
    if (!mk.loaded) await mkLoad();
    const [st, list] = await Promise.all([api('/api/admin/email/status'), api('/api/admin/email/campaigns')]); if (seq !== routeSeq) return;
    const a = st.audience, left = st.allowance_today;
    const row = (c) => {
      const pct = c.total ? Math.round(100 * c.sent / c.total) : 0;
      const sub = c.status === 'scheduled' ? `Goes out ${dayLabel(keyOf(c.scheduled_at))} · ${clock(c.scheduled_at)}` : c.status === 'sending' ? `Sent ${c.sent} of ${c.total}${c.pending ? '. The rest goes out in the next daily batch.' : ''}` : c.status === 'done' ? `Sent to ${c.sent} ${c.sent === 1 ? 'person' : 'people'} on ${dayLabel(keyOf(c.finished_at || c.created_at))}${c.failed ? ` · ${c.failed} could not be sent` : ''}` : c.status === 'canceled' ? `Stopped after ${c.sent} of ${c.total}` : 'Not scheduled yet';
      const aTo = c.audience && st.audiences.find((o) => (c.audience.kind === 'tag' ? o.kind === 'tag' && o.tag === c.audience.tag : o.group === c.audience.group)); const subTxt = sub + (aTo ? ` · to ${aTo.label}` : '');
      return `<div class="mk-mrow" data-mail="${c.id}"><div style="flex:1;min-width:200px"><b>${esc(c.subject) || 'No subject yet'}</b><div class="small muted">${esc(subTxt)}</div>${c.status === 'sending' ? `<div class="mk-bar"><i style="width:${pct}%"></i></div>` : ''}</div><span class="badge ${mailBadge[c.status][1]}">${mailBadge[c.status][0]}</span></div>`;
    };
    $('#mkbody').innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="row wrap" style="gap:10px;align-items:center;justify-content:space-between">
          <div><h2 style="font-size:22px;margin:0">${st.ready ? 'Email is on' : st.key_present ? 'Email is off' : 'Email isn’t set up yet'}</h2>
            <p class="hint" style="margin:2px 0 0">${st.ready ? 'Sending from ' + esc(st.from) : st.key_present ? 'Turn it on in Email settings when you’re ready.' : 'It needs a free Resend account and one key. Nothing is sent until then. The steps are in Email settings.'}</p></div>
          <button class="btn" id="mailset">Email settings</button></div>
        ${st.ready ? `<div class="row wrap" style="gap:10px;margin-top:12px">
          <div class="mk-stat"><div class="small muted">Can be emailed</div><b>${a.sendable}</b></div>
          <div class="mk-stat"><div class="small muted">Sent today</div><b>${st.sent_today.transactional + st.sent_today.marketing}</b><span class="small muted"> of ${st.daily_cap}</span></div>
          <div class="mk-stat"><div class="small muted">Left for marketing today</div><b>${left}</b></div></div>
          <p class="hint" style="margin-top:8px">Not counted: ${a.unsubscribed} unsubscribed${a.bounced ? `, ${a.bounced} bounced` : ''}${a.unconfirmed ? `, ${a.unconfirmed} waiting to confirm` : ''}${a.no_consent ? `, ${a.no_consent} who never agreed to emails` : ''}. ${st.reserve} of the daily limit is kept back for confirmations and receipts.</p>` : ''}
        ${st.last_error ? `<div class="msg err" style="margin-top:10px">${esc(st.last_error)}</div>` : ''}
      </div>
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:6px"><h2 style="font-size:22px;margin:0">Your emails</h2><button class="btn btn-primary" id="mailnew">New email</button></div>
        ${list.length ? list.map(row).join('') : '<div class="empty">No emails yet. Write one to everyone who signed up on your shop, and Outpost handles the unsubscribe link and the sending limits.</div>'}
      </div>`;
    $('#mailnew').onclick = () => mkMail(null, st);
    if (mk.openNew) mkMail(null, st);
    $('#mailset').onclick = () => mkMailSettings(st);
    $('#mkbody').onclick = (e) => { const r = e.target.closest('[data-mail]'); if (r) mkMail(list.find((c) => c.id === Number(r.dataset.mail)), st); };
  }
  function mkMailSettings(st) {
    const m = openModal('<div id="msbody"></div>', { wide: true }); m.el.style.maxWidth = '620px'; m.el.style.textAlign = 'left';
    $('#msbody', m.el).innerHTML = `<h2 style="font-size:22px;margin-bottom:4px">Email settings</h2>
      ${st.key_present ? '<p class="hint"><span class="badge b-paid">Key found</span> The Resend key is saved in Render, not in Outpost.</p>' : '<div class="msg" style="text-align:left"><b>One-time setup, all free</b><br>1. Make a free account at resend.com and add your shop’s domain.<br>2. Add the records it shows you (and a DMARC record) in Cloudflare DNS, set to “DNS only”.<br>3. In Render, add an environment variable named <code>RESEND_API_KEY</code> with your key, then restart.<br>4. Optional: add a webhook to <code>/api/email/webhook</code> and save its secret as <code>RESEND_WEBHOOK_SECRET</code>, so bounces and spam complaints switch people off automatically.</div>'}
      <label class="field"><span class="label">From</span><input class="input" id="ms-from" value="${esc(st.from)}" placeholder="Ash &amp; Anchor &lt;hello@your-domain.com&gt;"></label>
      <label class="field"><span class="label">Replies go to <span class="small muted">(optional)</span></span><input class="input" id="ms-reply" value="${esc(st.reply_to)}" placeholder="you@example.com"></label>
      <label class="field"><span class="label">Mailing address for the footer</span><textarea class="input" id="ms-addr" rows="2" placeholder="Ash &amp; Anchor, 1 Main St, Portland OR 97201">${esc(st.mail_address)}</textarea><span class="hint">Email law requires a real mailing address in every marketing email. A P.O. box works.</span></label>
      <div class="row wrap" style="gap:10px"><label class="field" style="flex:1;min-width:150px"><span class="label">Daily sending limit</span><input class="input" id="ms-cap" type="number" min="1" value="${st.daily_cap}"><span class="hint">The free plan allows 100 a day.</span></label>
        <label class="field" style="flex:1;min-width:150px"><span class="label">Kept back for receipts</span><input class="input" id="ms-res" type="number" min="0" value="${st.reserve}"><span class="hint">Marketing never uses these.</span></label></div>
      <label class="row" style="gap:8px;margin:6px 0"><input type="checkbox" id="ms-doi" ${st.double_optin ? 'checked' : ''}> <span><b>Ask new subscribers to confirm</b><br><span class="small muted">They get one email with a confirm link and only receive marketing after clicking it. Recommended.</span></span></label>
      <label class="row" style="gap:8px;margin:6px 0 10px"><input type="checkbox" id="ms-on" ${st.on ? 'checked' : ''}> <span><b>Email is on</b></span></label>
      <div id="msmsg"></div>
      <div class="row wrap" style="gap:8px;justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn btn-primary" id="mssave">Save</button></div>`;
    m.el.querySelector('[data-close]').onclick = m.close;
    $('#mssave', m.el).onclick = async () => {
      const q = (x) => $(x, m.el);
      try { await put('/api/admin/email/settings', { from: q('#ms-from').value, reply_to: q('#ms-reply').value, mail_address: q('#ms-addr').value, daily_cap: q('#ms-cap').value, reserve: q('#ms-res').value, double_optin: q('#ms-doi').checked, on: q('#ms-on').checked }); m.close(); toast('Saved'); mktEmail(routeSeq); }
      catch (e) { q('#msmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
  }
  const PRESETS = [
    ['plain', 'Plain', 'A simple letter', () => ({ template: 'plain', blocks: [{ type: 'text', text: '' }] })],
    ['banner', 'Banner', 'Your name on top, then a message and a button', () => ({ template: 'banner', blocks: [{ type: 'heading', text: '' }, { type: 'text', text: '' }, { type: 'button', label: 'Shop now', url: '/shop' }] })],
    ['feature', 'Feature', 'One big photo, a headline and a button', () => ({ template: 'feature', blocks: [{ type: 'photo', url: '', alt: '' }, { type: 'heading', text: '' }, { type: 'text', text: '' }, { type: 'button', label: 'Shop now', url: '/shop' }] })],
    ['collection', 'Collection', 'Announce several items at once, with a shop-the-collection button', () => ({ template: 'collection', blocks: [{ type: 'photo', url: '', alt: '', link: '' }, { type: 'heading', text: '' }, { type: 'text', text: '' }, { type: 'button', label: 'Shop the collection', url: '/shop' }, { type: 'collection', line_id: 0, product_ids: [], label: 'See everything' }] })],
    ['story', 'Story', 'A row of photos with a short note', () => ({ template: 'story', blocks: [{ type: 'heading', text: '' }, { type: 'photos', urls: ['', ''] }, { type: 'text', text: '' }, { type: 'button', label: 'See what’s new', url: '/gallery' }] })],
  ];
  const BLOCK_NAMES = { heading: 'Heading', text: 'Text', photo: 'Photo', photos: 'Photo row', button: 'Button', product: 'Product', collection: 'Collection', divider: 'Divider' };
  function mkMail(c, st) {
    const isNew = !c; const m = openModal('<div id="mebody"></div>', { wide: true }); m.el.style.textAlign = 'left';
    const locked = c && !['draft', 'scheduled'].includes(c.status);
    const at = c && c.scheduled_at ? c.scheduled_at : null;
    let design = c && c.design ? JSON.parse(JSON.stringify(c.design)) : (c && c.body ? { template: 'plain', blocks: [{ type: 'text', text: c.body }] } : null);
    let link = c ? c.link_code || '' : ''; let pick = null, templates = []; let subject = c ? c.subject : '';
    const optKey = (o) => (o.kind === 'all' ? 'all' : o.kind === 'tag' ? 'tag:' + o.tag : 'group:' + o.group);
    const audKey = (a) => (!a ? 'all' : a.kind === 'tag' ? 'tag:' + a.tag : 'group:' + a.group);
    let aud = c ? (c.audience || null) : ((mk.openNew && mk.openNew.audience) || null); if (!c) mk.openNew = null;
    if (aud && !st.audiences.some((o) => optKey(o) === audKey(aud))) aud = null;   // a tag that no longer exists
    const audOpt = () => st.audiences.find((o) => optKey(o) === audKey(aud)) || st.audiences[0];
    const audCount = () => audOpt().sendable;
    const snapOf = () => JSON.stringify([subject, design, link, aud]); const snap0 = snapOf();
    const q = (x) => $(x, m.el);
    const clean = () => ({ template: design.template, blocks: design.blocks.map((b) => ({ ...b })) });
    let tm = 0;
    const prev = () => { clearTimeout(tm); tm = setTimeout(async () => { if (!design || !q('#me-prev')) return; try { const d = await post('/api/admin/email/preview', { subject: q('#me-sub') ? q('#me-sub').value : '', design: clean(), link_code: link }); q('#me-prev').srcdoc = d.html; } catch { /* preview only */ } }, 250); };
    const siteLinks = () => [['/shop', 'My shop'], ['/gallery', 'Gallery'], ...mk.lines.map((l) => ['/shop?line=' + l.slug, 'Collection: ' + l.name]), ...mk.products.slice(0, 40).map((p) => ['/shop?p=' + p.id, p.name])];
    function blockHtml(b, i) {
      const n = design.blocks.length, ctl = locked ? '' : `<div class="mk-bctl">${i > 0 ? `<button data-up="${i}" title="Move up">↑</button>` : ''}${i < n - 1 ? `<button data-dn="${i}" title="Move down">↓</button>` : ''}<button data-rm="${i}" title="Remove">×</button></div>`;
      const thumb = (u, slot) => `<button class="mk-bthumb" data-pick="${i}:${slot}">${u ? `<img src="${esc(u)}" alt="">` : '<span>Choose photo</span>'}</button>`;
      let body = '';
      if (b.type === 'heading') body = `<input class="input" data-f="${i}:text" maxlength="200" value="${esc(b.text)}" placeholder="Headline">`;
      else if (b.type === 'text') body = `<textarea class="input" data-f="${i}:text" rows="4" placeholder="Write your message. A blank line starts a new paragraph.">${esc(b.text)}</textarea>`;
      else if (b.type === 'photo') body = `<div class="row wrap" style="gap:10px;align-items:flex-start">${thumb(b.url, 0)}<div style="flex:1;min-width:180px"><input class="input" data-f="${i}:alt" maxlength="150" value="${esc(b.alt || '')}" placeholder="Describe the photo (shown if images are off)"><select class="input" data-f="${i}:link" style="margin-top:6px"><option value="">Photo doesn’t link anywhere</option>${siteLinks().map(([u, l]) => `<option value="${esc(u)}"${b.link === u ? ' selected' : ''}>Links to: ${esc(l)}</option>`).join('')}</select></div></div>`;
      else if (b.type === 'photos') body = `<div class="row wrap" style="gap:8px">${(b.urls || []).map((u, k) => thumb(u, k)).join('')}${(b.urls || []).length < 3 ? `<button class="btn btn-sm" data-addph="${i}">+ Photo</button>` : ''}${(b.urls || []).length > 1 ? `<button class="btn btn-sm" data-rmph="${i}">− Photo</button>` : ''}</div>`;
      else if (b.type === 'button') body = `<div class="row wrap" style="gap:8px"><input class="input" data-f="${i}:label" maxlength="40" value="${esc(b.label)}" placeholder="Shop now" style="flex:1;min-width:130px"><select class="input" data-f="${i}:url" style="flex:2;min-width:180px">${siteLinks().map(([u, l]) => `<option value="${esc(u)}"${b.url === u ? ' selected' : ''}>${esc(l)}</option>`).join('')}${b.url && !siteLinks().some(([u]) => u === b.url) ? `<option value="${esc(b.url)}" selected>${esc(b.url.slice(0, 50))}</option>` : ''}</select></div><div class="small muted" style="margin-top:4px">Short and active works best: “Shop now”, “See the new tiles”.</div>`;
      else if (b.type === 'product') body = `<div class="row wrap" style="gap:8px"><select class="input" data-f="${i}:product_id" style="flex:2;min-width:180px"><option value="0">Choose a product…</option>${mk.products.map((p) => `<option value="${p.id}"${p.id === b.product_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select><input class="input" data-f="${i}:label" maxlength="30" value="${esc(b.label || '')}" placeholder="Shop now" style="flex:1;min-width:110px"></div><div class="small muted" style="margin-top:4px">Shows the photo, name and current price, with a button.</div>`;
      else if (b.type === 'collection') { const byLine = !!b.line_id || !(b.product_ids || []).length && mk.lines.length > 0 && b.mode !== 'pick'; body = `<div class="seg" style="margin-bottom:8px"><button data-cmode="${i}:line" class="${byLine ? 'on' : ''}">A product line</button><button data-cmode="${i}:pick" class="${byLine ? '' : 'on'}">Hand-picked</button></div>${byLine ? `<select class="input" data-f="${i}:line_id"><option value="0">Choose a line…</option>${mk.lines.map((l) => `<option value="${l.id}"${l.id === b.line_id ? ' selected' : ''}>${esc(l.name)} (${l.count})</option>`).join('')}</select><div class="small muted" style="margin-top:4px">Shows what’s in the line when the email goes out, up to 6 items. Sold-out items are left out.</div>` : `<div class="mk-cpick">${mk.products.map((p) => `<label class="row" style="gap:6px"><input type="checkbox" data-cprod="${i}:${p.id}" ${(b.product_ids || []).includes(p.id) ? 'checked' : ''}> ${esc(p.name)}</label>`).join('') || '<span class="muted small">No products yet.</span>'}</div><div class="small muted" style="margin-top:4px">Pick up to 6. They appear in the order you tick them.</div>`}<input class="input" data-f="${i}:label" maxlength="40" value="${esc(b.label || '')}" placeholder="Button under the grid (optional)" style="margin-top:8px">`; }
      else body = '<div class="small muted">A thin line between sections.</div>';
      const grid = pick && pick.i === i ? `<div class="mk-pickgrid" style="margin-top:8px">${mk.photos.map((ph) => `<button class="mk-pk" data-set="${esc(ph.url)}"><img src="${esc(ph.url)}" alt=""></button>`).join('')}<label class="mk-pk" style="display:flex;align-items:center;justify-content:center;cursor:pointer;font-size:12px;text-align:center">Upload new<input type="file" accept="image/*" data-up-new hidden></label></div>` : '';
      return `<div class="mk-block"><div class="mk-bh"><b>${BLOCK_NAMES[b.type]}</b>${ctl}</div>${body}${grid}</div>`;
    }
    const MODS = [['heading', 'Aa', 'Headline'], ['text', '¶', 'Paragraph'], ['photo', '▣', 'One big photo'], ['photos', '▦', 'Row of photos'], ['button', '▭', 'Shop now button'], ['product', '◫', 'One product'], ['collection', '⊞', 'Several products'], ['divider', '—', 'A thin line']];
    let pvOn = true, pvWide = false, endNext = false;
    try { const sv = JSON.parse(localStorage.getItem('outpost_mail_pv') || 'null'); if (sv) { pvOn = sv.on !== false; pvWide = !!sv.wide; } else pvOn = window.innerWidth >= 1100; } catch { pvOn = window.innerWidth >= 1100; }
    const savePv = () => { try { localStorage.setItem('outpost_mail_pv', JSON.stringify({ on: pvOn, wide: pvWide })); } catch { /* light convenience only */ } };
    m.el.classList.add('me-modal'); m.el.style.maxWidth = 'min(1440px, 97vw)';
    function paint() {
      const dis = locked ? 'disabled' : '';
      const oldBuild = q('.me-build'), keepTop = oldBuild ? oldBuild.scrollTop : 0, oldPal = q('.me-pal'), palTop = oldPal ? oldPal.scrollTop : 0;
      const top = `<div class="me-top"><h2>${isNew ? 'New email' : locked ? 'Email' : 'Edit email'}</h2>
        <label class="me-sub"><span class="label">Subject</span><input class="input" id="me-sub" maxlength="150" value="${esc(subject)}" ${dis}></label>
        ${design ? `<div class="me-tools"><div class="seg" role="group" aria-label="Preview"><button id="me-pv" class="${pvOn ? 'on' : ''}" aria-pressed="${pvOn}">Preview</button>${pvOn ? `<button id="me-pw" title="Make the preview wider">${pvWide ? 'Narrow' : 'Wide'}</button>` : ''}</div></div>` : ''}<button class="btn btn-sm" data-close>Close</button></div>`;
      if (!design) {
        $('#mebody', m.el).innerHTML = `${top}<div class="me-start">${aud ? `<div class="msg" style="margin-bottom:10px">This email is set to go to <b>${esc(audOpt().label)}</b> (${audCount()}). You can change that before you schedule.</div>` : ''}<div class="label">Start from</div><div class="mk-presets">${PRESETS.map(([k, n, d]) => `<button class="mk-preset" data-preset="${k}"><i class="mk-pv mk-pv-${k}"></i><b>${n}</b><span class="small muted">${d}</span></button>`).join('')}</div>${templates.length ? `<div class="label" style="margin-top:10px">Your templates</div><div class="row wrap" style="gap:6px">${templates.map((t) => `<span class="mk-tchip"><button class="btn btn-sm" data-tpl="${t.id}">${esc(t.name)}</button><button class="mk-tx" data-tdel="${t.id}" title="Delete template" aria-label="Delete template ${esc(t.name)}">×</button></span>`).join('')}</div>` : ''}<div id="memsg" style="margin-top:6px"></div></div>`;
        wire(); return;
      }
      const cols = [locked ? '' : '176px', 'minmax(0,1fr)', pvOn ? (pvWide ? '680px' : '410px') : ''].filter(Boolean).join(' ');
      const pal = locked ? '' : `<aside class="me-pal" aria-label="Add a module"><div class="label">Header</div><div class="seg" id="me-hdr" style="margin:0 0 12px"><button data-h="plain" class="${design.template === 'plain' ? 'on' : ''}">Plain</button><button data-h="banner" class="${design.template !== 'plain' ? 'on' : ''}">Banner</button></div>
        <div class="label">Add a module</div>${MODS.map(([t, g, d]) => `<button class="me-mod" data-add="${t}"><i>${g}</i><span><b>${BLOCK_NAMES[t]}</b><small>${d}</small></span></button>`).join('')}</aside>`;
      const build = `<section class="me-build">${design.blocks.map(blockHtml).join('') || '<div class="empty">Add a module from the left to begin.</div>'}
        <div class="card" style="margin:10px 0 0"><label class="field" style="margin:0"><span class="label">Count sales from this email</span><select class="input" id="me-link" ${dis}><option value="">Don’t track</option>${mk.links.map((l) => `<option value="${esc(l.code)}"${l.code === link ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}</select><span class="hint">Shop links in the email get this tracked link, so Sales by link shows what the email earned. Make one in Tracked links.</span></label>
          ${locked ? '' : `<div class="row wrap" style="gap:6px;align-items:center;margin-top:10px"><input class="input" id="me-to" type="email" placeholder="you@example.com" style="max-width:220px"><button class="btn btn-sm" id="me-test">Send me a test</button><button class="btn btn-sm" id="me-tpl">Save as template</button></div>`}</div></section>`;
      const pv = pvOn ? `<section class="me-pvp" aria-label="Email preview"><iframe id="me-prev" sandbox="" title="Email preview"></iframe></section>` : '';
      $('#mebody', m.el).innerHTML = `${top}<div class="me-grid" style="grid-template-columns:${cols}">${pal}${build}${pv}</div>
        <div id="memsg" class="me-msg"></div>
        <div class="me-foot"><div class="me-aud"><label class="small muted" for="me-aud">Send to</label> <select class="input" id="me-aud" style="width:auto;margin:0 6px 0 4px" ${dis}>${st.audiences.map((o) => `<option value="${optKey(o)}"${optKey(o) === audKey(aud) ? ' selected' : ''}>${esc(o.label)} (${o.sendable})</option>`).join('')}</select>
            ${audCount() ? `<b>${audCount()}</b> ${audCount() === 1 ? 'person' : 'people'} will get this. <span class="muted small">Up to ${st.allowance_today} go out today, the rest in daily batches, so receipts always go first.</span>` : '<span class="small" style="color:var(--bad,#b42318)"><b>Nobody</b> in this group can be emailed yet, so it can’t be scheduled.</span>'}</div>
          ${locked ? '' : `<div class="row wrap" style="gap:6px;align-items:center"><select class="input" id="me-when" style="width:auto"><option value="at">Send on a date and time</option><option value="now">Send as soon as possible</option></select><input class="input" type="date" id="me-date" value="${at ? keyOf(at) : ''}" style="width:auto"><input class="input" type="time" id="me-time" value="${at ? (() => { const p = zparts(at); return pad2(p.h) + ':' + pad2(p.mi); })() : '10:00'}" style="width:auto"><span class="small muted">${esc(mk.tz || 'your computer’s time zone')}</span></div>`}
          <div class="row wrap" style="gap:8px;margin-left:auto">${c && c.status === 'scheduled' ? '<button class="btn" id="me-unsched">Unschedule</button>' : ''}${c && c.status === 'sending' ? '<button class="btn btn-danger" id="me-stop">Stop sending</button>' : ''}${c && c.status !== 'sending' ? '<button class="btn btn-danger" id="me-del">Delete</button>' : ''}${locked ? '' : `<button class="btn" id="me-save">Save draft</button><button class="btn btn-primary" id="me-go" ${audCount() ? '' : 'disabled'}>Schedule</button>`}</div></div>`;
      const nb = q('.me-build'); if (nb) nb.scrollTop = endNext ? nb.scrollHeight : keepTop; endNext = false; const np = q('.me-pal'); if (np) np.scrollTop = palTop;
      wire(); prev();
    }
    const msg = (h) => { q('#memsg').innerHTML = h; };
    const keep = () => { if (q('#me-sub')) subject = q('#me-sub').value; if (!design) return; m.el.querySelectorAll('[data-f]').forEach((el) => { const [i, f] = el.dataset.f.split(':'); const b = design.blocks[Number(i)]; if (b) b[f] = (f === 'product_id' || f === 'line_id') ? Number(el.value) : el.value; }); if (q('#me-link')) link = q('#me-link').value; };
    function wire() {
      m.el.querySelector('[data-close]').onclick = guardClose(m, () => { keep(); return !locked && snapOf() !== snap0; });
      if (q('#me-aud')) q('#me-aud').onchange = () => { keep(); const o = st.audiences.find((x) => optKey(x) === q('#me-aud').value); aud = !o || o.kind === 'all' ? null : o.kind === 'tag' ? { kind: 'tag', tag: o.tag } : { kind: 'group', group: o.group }; paint(); };
      if (q('#me-when')) q('#me-when').onchange = () => { if (q('#me-go')) q('#me-go').textContent = q('#me-when').value === 'now' ? 'Send now' : 'Schedule'; };
      if (q('#me-pv')) q('#me-pv').onclick = () => { keep(); pvOn = !pvOn; savePv(); paint(); };
      if (q('#me-pw')) q('#me-pw').onclick = () => { keep(); pvWide = !pvWide; savePv(); paint(); };
      if (q('#me-sub')) q('#me-sub').oninput = () => { subject = q('#me-sub').value; prev(); };
      m.el.querySelectorAll('[data-preset]').forEach((b) => { b.onclick = () => { keep(); design = PRESETS.find((p) => p[0] === b.dataset.preset)[3](); paint(); }; });
      m.el.querySelectorAll('[data-tpl]').forEach((b) => { b.onclick = () => { keep(); design = JSON.parse(JSON.stringify(templates.find((t) => t.id === Number(b.dataset.tpl)).design)); paint(); }; });
      m.el.querySelectorAll('[data-tdel]').forEach((b) => { b.onclick = async () => { if (!(await confirmBox({ title: 'Delete this template?', body: 'Emails you already made from it are not affected.', yes: 'Delete', danger: true }))) return; await api('/api/admin/email/templates/' + b.dataset.tdel, { method: 'DELETE' }); templates = templates.filter((t) => t.id !== Number(b.dataset.tdel)); paint(); }; });
      if (!design) return;
      m.el.querySelectorAll('[data-f]').forEach((el) => { el.oninput = el.onchange = () => { keep(); if (el.tagName === 'SELECT' && el.dataset.f.endsWith(':product_id')) { /* repaint not needed */ } prev(); }; });
      if (q('#me-link')) q('#me-link').onchange = () => { keep(); prev(); };
      
      m.el.querySelectorAll('#me-hdr button').forEach((b) => { b.onclick = () => { keep(); design.template = b.dataset.h; paint(); }; });
      m.el.querySelectorAll('[data-cmode]').forEach((b) => { b.onclick = () => { keep(); const [i, mode] = b.dataset.cmode.split(':'); const bl = design.blocks[Number(i)]; bl.mode = mode; if (mode === 'line') bl.product_ids = []; else bl.line_id = 0; paint(); }; });
      m.el.querySelectorAll('[data-cprod]').forEach((el) => { el.onchange = () => { keep(); const [i, id] = el.dataset.cprod.split(':').map(Number); const bl = design.blocks[i]; bl.mode = 'pick'; bl.product_ids = bl.product_ids || []; const at = bl.product_ids.indexOf(id); if (el.checked) { if (at < 0) { if (bl.product_ids.length >= 6) { el.checked = false; return msg('<div class="msg err">Six items at most keeps the email short.</div>'); } bl.product_ids.push(id); } } else if (at >= 0) bl.product_ids.splice(at, 1); prev(); }; });
      m.el.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => { keep(); const t = b.dataset.add; design.blocks.push(t === 'heading' || t === 'text' ? { type: t, text: '' } : t === 'photo' ? { type: t, url: '', alt: '', link: '' } : t === 'photos' ? { type: t, urls: ['', ''] } : t === 'button' ? { type: t, label: 'Shop now', url: '/shop' } : t === 'product' ? { type: t, product_id: 0, label: '' } : t === 'collection' ? { type: t, line_id: 0, product_ids: [], label: 'See everything' } : { type: 'divider' }); paint(); }; });
      m.el.querySelectorAll('[data-add]').forEach((b) => { const o = b.onclick; b.onclick = () => { endNext = true; o(); }; });
      const mv = (i, d) => { keep(); const j = i + d; [design.blocks[i], design.blocks[j]] = [design.blocks[j], design.blocks[i]]; pick = null; paint(); };
      m.el.querySelectorAll('[data-up]').forEach((b) => { b.onclick = () => mv(Number(b.dataset.up), -1); });
      m.el.querySelectorAll('[data-dn]').forEach((b) => { b.onclick = () => mv(Number(b.dataset.dn), 1); });
      m.el.querySelectorAll('[data-rm]').forEach((b) => { b.onclick = () => { keep(); design.blocks.splice(Number(b.dataset.rm), 1); pick = null; paint(); }; });
      m.el.querySelectorAll('[data-addph]').forEach((b) => { b.onclick = () => { keep(); design.blocks[Number(b.dataset.addph)].urls.push(''); paint(); }; });
      m.el.querySelectorAll('[data-rmph]').forEach((b) => { b.onclick = () => { keep(); design.blocks[Number(b.dataset.rmph)].urls.pop(); paint(); }; });
      m.el.querySelectorAll('[data-pick]').forEach((b) => { b.onclick = () => { keep(); const [i, slot] = b.dataset.pick.split(':').map(Number); pick = pick && pick.i === i && pick.slot === slot ? null : { i, slot }; paint(); }; });
      const setPhoto = (url) => { const b = design.blocks[pick.i]; if (b.type === 'photo') b.url = url; else b.urls[pick.slot] = url; pick = null; paint(); };
      m.el.querySelectorAll('[data-set]').forEach((b) => { b.onclick = () => { keep(); setPhoto(b.dataset.set); }; });
      const up = m.el.querySelector('[data-up-new]'); if (up) up.onchange = async (e) => { const f = e.target.files[0]; if (!f) return; keep(); try { msg('<div class="msg">Uploading…</div>'); const url = await uploadImage(await jpegFrom(f)); await post('/api/admin/marketing/photos', { url }); mk.photos = await api('/api/admin/marketing/photos'); setPhoto(url); } catch (er) { msg(`<div class="msg err">${esc(er.message)}</div>`); } };
      const done = (t) => { m.close(); toast(t); mktEmail(routeSeq); };
      const saveDraft = async () => { keep(); const b = { subject: q('#me-sub').value, design: clean(), link_code: link, audience: aud }; c = c ? await put('/api/admin/email/campaigns/' + c.id, b) : await post('/api/admin/email/campaigns', b); return c; };
      if (q('#me-save')) q('#me-save').onclick = async () => { try { await saveDraft(); done('Draft saved'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
      if (q('#me-go')) q('#me-go').onclick = async () => {
        try {
          const when = q('#me-when').value; let body = { now: true };
          if (when === 'at') { const d = q('#me-date').value, t = q('#me-time').value; if (!d || !t) return msg('<div class="msg err">Pick a date and time, or choose “As soon as possible”.</div>'); body = { scheduled_at: zoned(d, Number(t.slice(0, 2)), Number(t.slice(3, 5))) }; }
          keep(); const n = audCount();
          const late = body.scheduled_at && body.scheduled_at < Date.now();
          const goes = body.now || late ? 'right away' : 'on ' + esc(dayLabel(keyOf(body.scheduled_at))) + ' at ' + esc(clock(body.scheduled_at));
          if (!(await confirmBox({ title: body.now || late ? 'Send this email now?' : 'Schedule this email?', body: `“${esc(subject || 'No subject')}” will go to <b>${n}</b> ${n === 1 ? 'person' : 'people'} (${esc(audOpt().label)}) ${goes}.${late && !body.now ? ' That time has already passed.' : ''} Once it starts sending, it can be stopped but not taken back.`, yes: body.now || late ? 'Send now' : 'Schedule', no: 'Not yet' }))) return;
          q('#me-go').disabled = true;
          await saveDraft(); await post(`/api/admin/email/campaigns/${c.id}/schedule`, body); done(when === 'now' || late ? 'Sending started' : 'Scheduled');
        } catch (e) { if (q('#me-go')) q('#me-go').disabled = false; msg(`<div class="msg err">${esc(e.message)}</div>`); }
      };
      if (q('#me-test')) q('#me-test').onclick = async () => { try { keep(); msg('<div class="msg">Sending…</div>'); await post('/api/admin/email/test', { to: q('#me-to').value, subject: q('#me-sub').value, design: clean(), link_code: link }); msg('<div class="msg ok">Test sent. Check your inbox.</div>'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
      if (q('#me-tpl')) q('#me-tpl').onclick = async () => { const name = await askText({ title: 'Save as a template', label: 'Name this template', placeholder: 'Monthly newsletter', yes: 'Save template' }); if (!name) return; try { keep(); const t = await post('/api/admin/email/templates', { name, design: clean() }); templates.unshift(t); msg('<div class="msg ok">Saved. You’ll find it under “Your templates” on a new email.</div>'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
      if (q('#me-unsched')) q('#me-unsched').onclick = async () => { try { await post(`/api/admin/email/campaigns/${c.id}/cancel`, {}); done('Back to a draft'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
      if (q('#me-stop')) q('#me-stop').onclick = async () => { if (!(await confirmBox({ title: 'Stop sending?', body: 'People who already got it keep it. Nobody else will.', yes: 'Stop sending', no: 'Keep sending', danger: true }))) return; try { await post(`/api/admin/email/campaigns/${c.id}/cancel`, {}); done('Stopped'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
      if (q('#me-del')) q('#me-del').onclick = async () => { if (!(await confirmBox({ title: 'Delete this email?', body: 'This can’t be undone.', yes: 'Delete', danger: true }))) return; try { await api('/api/admin/email/campaigns/' + c.id, { method: 'DELETE' }); done('Deleted'); } catch (e) { msg(`<div class="msg err">${esc(e.message)}</div>`); } };
    }
    api('/api/admin/email/templates').then((t) => { templates = t; if (!design) paint(); }).catch(() => {});
    paint();
  }

  // Ready to post ------------------------------------------------------------
  async function mktReady(seq) {
    if (!mk.loaded) await mkLoad();
    const d = await api('/api/admin/marketing/due'); if (seq !== routeSeq) return;
    const card = (p, done) => `<div class="card mk-ready"><div class="mk-lthumb big">${postThumb(p)}</div><div style="flex:1;min-width:200px"><div class="small muted">${esc(dayLabel(keyOf(p.scheduled_at)))} · ${clock(p.scheduled_at)} · ${[p.to_instagram && 'Instagram', p.to_facebook && 'Facebook'].filter(Boolean).join(' + ')}</div><p style="margin:4px 0;white-space:pre-wrap;overflow-wrap:anywhere">${esc(p.caption) || '<span class="muted">No caption</span>'}</p>${p.url ? `<div class="small"><code>${esc(p.url)}</code></div>` : ''}
      <div class="row wrap" style="gap:6px;margin-top:8px">${done ? `<button class="btn btn-sm" data-undo="${p.id}">Undo</button>` : `<button class="btn btn-sm" data-copy="${p.id}">Copy caption and link</button>${p.photos.map((u, i) => `<a class="btn btn-sm" href="${esc(u)}" download>Download photo${p.photos.length > 1 ? ' ' + (i + 1) : ''}</a>`).join('')}<button class="btn btn-sm btn-primary" data-done="${p.id}">Mark as posted</button>`}</div></div></div>`;
    $('#mkbody').innerHTML = `${d.due.length ? d.due.map((p) => card(p, false)).join('') : '<div class="card"><div class="empty">Nothing waiting. Instagram and Facebook posts appear here when their time comes.</div></div>'}
      ${d.done.length ? `<h2 style="font-size:20px;margin:14px 0 6px">Posted in the last 7 days</h2>${d.done.map((p) => card(p, true)).join('')}` : ''}`;
    const all = [...d.due, ...d.done];
    $('#mkbody').onclick = async (e) => {
      const c = e.target.closest('[data-copy]'), dn = e.target.closest('[data-done]'), un = e.target.closest('[data-undo]');
      try {
        if (c) { const p = all.find((x) => x.id === Number(c.dataset.copy)); await navigator.clipboard.writeText(p.caption + (p.url ? '\n\n' + p.url : '')); toast('Copied'); }
        else if (dn) { await post('/api/admin/marketing/posts/' + dn.dataset.done + '/posted', {}); toast('Marked as posted'); await mkLoad(); mktReady(routeSeq); mkBadge(); }
        else if (un) { await post('/api/admin/marketing/posts/' + un.dataset.undo + '/posted', { posted: false }); await mkLoad(); mktReady(routeSeq); mkBadge(); }
      } catch (er) { toast(er.message); }
    };
  }

  async function mktLinks(seq) {
    const body = $('#mkbody');
    const d = await api('/api/admin/marketing/links');
    if (seq !== routeSeq) return;
    const dests = d.dests;
    const rowHtml = (l) => `<tr${l.archived ? ' style="opacity:.55"' : ''}>
      <td><b>${esc(l.name)}</b>${l.archived ? ' <span class="small muted">(archived)</span>' : ''}<div class="small muted">${esc(dests[l.dest] || 'Shop')}</div></td>
      <td class="small" style="word-break:break-all"><code>${esc(l.dest + '?s=' + l.code)}</code></td>
      <td>${l.visits_30}<div class="small muted">${l.visits_total} all time</div></td>
      <td>${l.orders}<div class="small muted">${fmt(l.revenue_cents)}</div></td>
      <td><div class="row wrap" style="gap:4px;justify-content:flex-end"><button class="btn btn-sm" data-copy="${l.id}">Copy</button><button class="btn btn-sm" data-qr="${l.id}">QR</button><button class="btn btn-sm" data-arc="${l.id}">${l.archived ? 'Restore' : 'Archive'}</button></div></td></tr>`;
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <h2 style="font-size:22px;margin-bottom:6px">New tracked link</h2>
        <p class="hint">Put a link like this in an Instagram bio, a post, an email, or on a sign at a market. Outpost counts the visits and the sales that follow. It counts per day only: no cookies, and no visitor addresses are kept.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
          <input class="input" id="lname" placeholder="Instagram bio" maxlength="60" style="flex:1;min-width:180px">
          <select class="input" id="ldest" style="width:auto">${Object.entries(dests).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select>
          <button class="btn btn-primary" id="ladd">Add link</button>
        </div>
        <div id="lmsg"></div>
      </div>
      <div class="card" style="overflow-x:auto">${d.links.length ? `<table><thead><tr><th>Name</th><th>Address</th><th>Visits (30 days)</th><th>Orders</th><th></th></tr></thead><tbody>${d.links.map(rowHtml).join('')}</tbody></table>`
        : '<div class="empty">No tracked links yet. Make one above, then use it wherever you share your shop.</div>'}</div>
      <p class="hint" style="margin-top:8px">Orders and sales count paid online orders that came through the link. Someone who visits on one device and buys on another counts as direct.</p>`;
    $('#ladd').onclick = async () => {
      const name = $('#lname').value.trim();
      if (!name) { $('#lmsg').innerHTML = '<div class="msg err">Give the link a name first.</div>'; return; }
      $('#ladd').disabled = true;
      try { await post('/api/admin/marketing/links', { name, dest: $('#ldest').value }); toast('Link added'); await mktLinks(seq); }
      catch (e) { $('#lmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#ladd').disabled = false; }
    };
    body.querySelectorAll('[data-copy]').forEach((b) => { b.onclick = async () => {
      const l = d.links.find((x) => x.id === Number(b.dataset.copy));
      try { await navigator.clipboard.writeText(l.url); toast('Copied'); } catch { copyBox('Copy this address', l.url); }
    }; });
    body.querySelectorAll('[data-arc]').forEach((b) => { b.onclick = async () => {
      const l = d.links.find((x) => x.id === Number(b.dataset.arc));
      try { await put('/api/admin/marketing/links/' + l.id, { archived: !l.archived }); await mktLinks(seq); } catch (e) { toast(e.message); }
    }; });
    body.querySelectorAll('[data-qr]').forEach((b) => { b.onclick = async () => {
      const l = d.links.find((x) => x.id === Number(b.dataset.qr));
      try {
        const r = await api('/api/admin/marketing/links/' + l.id + '/qr');
        const mdl = openModal(`<h2 style="font-size:22px;margin-bottom:8px">${esc(l.name)}</h2><div class="center"><img src="${esc(r.qr)}" alt="QR code for ${esc(l.name)}" style="width:240px;height:240px"></div><p class="hint center" style="word-break:break-all">${esc(r.url)}</p><p class="hint center">Right-click the code to save it, or print this page.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>`);
        mdl.el.querySelector('[data-close]').onclick = mdl.close;
      } catch (e) { toast(e.message); }
    }; });
  }

  async function mktSources(seq) {
    const body = $('#mkbody');
    let days = Number(store.get('outpost_mk_days') || 30) || 30;
    const paint = async () => {
      const d = await api('/api/admin/marketing/sources?days=' + days);
      if (seq !== routeSeq) return;
      const max = Math.max(1, ...d.rows.map((r) => r.revenue_cents), d.direct.revenue_cents);
      const bar = (c, grey) => `<span style="background:var(--cream-2);border-radius:6px;height:12px;display:block"><span style="display:block;height:12px;border-radius:6px;width:${Math.round((c / max) * 100)}%;background:${grey ? '#c9c2b3' : 'var(--forest)'}"></span></span>`;
      body.innerHTML = `
        <div class="row" style="margin-bottom:12px"><h2 style="font-size:22px">Sales by link</h2><div class="spacer"></div>
          <select class="input" id="dsel" style="width:auto">${[7, 30, 90].map((n) => `<option value="${n}"${n === d.days ? ' selected' : ''}>Last ${n} days</option>`).join('')}</select></div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px">
          <div class="card"><div class="small muted">Visits</div><div style="font-size:24px;font-weight:600">${d.visits}</div></div>
          <div class="card"><div class="small muted">Online orders</div><div style="font-size:24px;font-weight:600">${d.orders}</div></div>
          <div class="card"><div class="small muted">Sales</div><div style="font-size:24px;font-weight:600">${fmt(d.revenue_cents)}</div></div>
        </div>
        <div class="card">${d.rows.length || d.direct.orders ? `
          ${d.rows.map((r) => `<div style="display:grid;grid-template-columns:minmax(0,150px) 1fr 140px;gap:10px;align-items:center;margin-bottom:10px"><span>${esc(r.name)}<div class="small muted">${r.visits} visit${r.visits === 1 ? '' : 's'}</div></span>${bar(r.revenue_cents)}<span style="text-align:right">${fmt(r.revenue_cents)}<div class="small muted">${r.orders} order${r.orders === 1 ? '' : 's'}</div></span></div>`).join('')}
          <div style="display:grid;grid-template-columns:minmax(0,150px) 1fr 140px;gap:10px;align-items:center"><span>Direct or unknown<div class="small muted">no tracked link</div></span>${bar(d.direct.revenue_cents, true)}<span style="text-align:right">${fmt(d.direct.revenue_cents)}<div class="small muted">${d.direct.orders} order${d.direct.orders === 1 ? '' : 's'}</div></span></div>`
          : '<div class="empty">Nothing to show yet. Make a tracked link, share it, and the visits and sales will appear here.</div>'}</div>
        <p class="hint" style="margin-top:8px">Paid online orders only, after refunds. In-person and auction sales are not included here.</p>`;
      $('#dsel').onchange = (e) => { days = Number(e.target.value); try { store.set('outpost_mk_days', String(days)); } catch { /* ignore */ } paint(); };
    };
    await paint();
  }

  async function viewLinks() {
    const [cur, st] = await Promise.all([api('/api/admin/links'), api('/api/admin/status')]);
    let list = (cur.links || []).map((l) => ({ ...l }));
    let uid = 1; list.forEach((l) => { l._k = uid++; });
    const strip = (arr) => JSON.stringify((arr || []).map(({ _k, ...l }) => l));
    let baseline = strip(cur.links), saving = false;
    const base = (st.base_url || location.origin).replace(/\/$/, '');
    view().innerHTML = `<div class="topbar"><h1>Link page</h1><button class="btn btn-primary" id="lsave">Save</button></div><div id="lmsg"></div>
      <div class="settings-col"><div style="display:grid;gap:18px;min-width:0">
        <div class="card"><h2 style="font-size:22px;margin-bottom:6px">Your links page</h2>
          <p class="muted small" style="margin:0 0 10px">One page to put in your Instagram bio (or anywhere else) that points people to your shop, events, classes, anything.</p>
          <div class="row" style="flex-wrap:wrap;gap:8px"><input class="input" id="lurl" readonly value="${esc(base + '/links')}" style="flex:1;min-width:200px"><button class="btn" id="lcopy">Copy</button><a class="btn btn-ghost" href="links.html" target="_blank" rel="noopener">Open ↗</a></div>
          <label class="field" style="margin-top:14px"><span class="label">Short line under your name (optional)</span><input class="input" id="lintro" maxlength="160" placeholder="Linocut prints, ceramics and weekend workshops in Portland" value="${esc(cur.links_intro || '')}"></label>
          <label class="check"><input type="checkbox" id="lmail" ${cur.mailing_list_on ? 'checked' : ''}> <span>Show an email signup box on this page</span></label><div class="hint" style="margin:2px 0 8px 26px">This only collects sign-ups. Writing and sending emails is in <a href="#/marketing/email">Marketing → Email</a>.</div>
          <div class="hint">People who sign up are saved under Customers → Email list, and you can download them to use in any email service.</div></div>
        <div class="card"><h2 style="font-size:22px;margin-bottom:6px">Buttons and events</h2>
          <div id="llist"></div>
          <div class="row mt" style="flex-wrap:wrap;gap:8px"><button class="btn" data-add="link">+ Add a link</button><button class="btn" data-add="event">+ Add an event</button><button class="btn" data-add="shop">+ Add a page from my shop</button></div>
          <div class="hint">Links show as big buttons in the order below. Events show under “Coming up” with the nearest date first, and disappear on their own after the date has passed.</div></div>
      </div></div>`;
    const kindLabel = { link: 'Link', event: 'Event', shop: 'Shop page' };
    const paint = () => {
      $('#llist').innerHTML = list.length ? list.map((l, i) => `<div class="lcard" data-k="${l._k}" style="border:1px solid var(--line);border-radius:14px;padding:12px;margin-top:10px;background:var(--cream-2)">
        <div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><span class="badge b-live">${kindLabel[l.kind] || 'Link'}</span>${l.hidden ? '<span class="badge b-canceled">Hidden</span>' : ''}<span class="spacer"></span>
          <button class="btn btn-sm btn-ghost" data-mv="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button><button class="btn btn-sm btn-ghost" data-mv="1" ${i === list.length - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
          <button class="btn btn-sm btn-ghost" data-hide>${l.hidden ? 'Show' : 'Hide'}</button><button class="btn btn-sm btn-ghost" data-del>Delete</button></div>
        <label class="field" style="margin:10px 0 0"><span class="label small">${l.kind === 'event' ? 'Event name' : 'Button text'}</span><input class="input" data-f="title" maxlength="80" placeholder="${l.kind === 'event' ? 'Craft fair at Pier 6' : 'Spring pottery class'}" value="${esc(l.title)}"></label>
        ${l.kind === 'shop' ? `<label class="field" style="margin:10px 0 0"><span class="label small">Goes to</span><select class="input" data-f="url">${SHOP_PAGES.map(([u, n]) => `<option value="${u}"${l.url === u ? ' selected' : ''}>${n}</option>`).join('')}</select></label>`
          : `<label class="field" style="margin:10px 0 0"><span class="label small">${l.kind === 'event' ? 'Web address for tickets or details (optional)' : 'Web address'}</span><input class="input" data-f="url" inputmode="url" autocomplete="off" placeholder="https://" value="${esc(l.url)}"></label>`}
        ${l.kind === 'event' ? `<div class="grid2" style="margin-top:10px"><label class="field" style="margin:0"><span class="label small">Date</span><input class="input" type="date" data-f="date" value="${esc(l.date || '')}"></label><label class="field" style="margin:0"><span class="label small">Where</span><input class="input" data-f="place" maxlength="80" placeholder="Seattle Center" value="${esc(l.place || '')}"></label></div>` : ''}
        <label class="field" style="margin:10px 0 0"><span class="label small">Small note under it (optional)</span><input class="input" data-f="note" maxlength="100" placeholder="${l.kind === 'event' ? '10am to 4pm, booth 12' : 'Starts March 4, 6 spots left'}" value="${esc(l.note || '')}"></label></div>`).join('') : '<p class="muted" style="margin:10px 0 0">Nothing here yet. Add your first link below.</p>';
    };
    paint();
    const find = (el) => list.find((l) => l._k === Number(el.closest('[data-k]').dataset.k));
    $('#llist').oninput = (e) => { const f = e.target.dataset.f; if (f) find(e.target)[f] = e.target.value; };
    $('#llist').onclick = (e) => {
      const card = e.target.closest('[data-k]'); if (!card) return;
      const l = find(e.target), i = list.indexOf(l);
      if (e.target.closest('[data-del]')) { list.splice(i, 1); paint(); }
      else if (e.target.closest('[data-hide]')) { l.hidden = !l.hidden; paint(); }
      else if (e.target.closest('[data-mv]')) { const j = i + Number(e.target.closest('[data-mv]').dataset.mv); if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; paint(); } }
    };
    document.querySelectorAll('[data-add]').forEach((b) => { b.onclick = () => { const kind = b.dataset.add; list.push({ _k: uid++, kind, title: '', url: kind === 'shop' ? 'store.html' : '', note: '', date: '', place: '', hidden: false }); paint(); const t = document.querySelector('.lcard:last-child [data-f="title"]'); if (t) t.focus(); }; });
    $('#lcopy').onclick = async () => { try { await navigator.clipboard.writeText($('#lurl').value); toast('Address copied'); } catch { $('#lurl').select(); } };
    $('#lsave').onclick = async () => {
      if (saving) return; saving = true;
      try {
        // If the links were changed somewhere else (another tab or device) since this page opened, ask before overwriting them.
        const fresh = await api('/api/admin/links');
        if (strip(fresh.links) !== baseline && !(await confirmBox({ title: 'Your links changed somewhere else', body: 'They were changed in another tab or device since you opened this page. Save anyway and replace those changes?', yes: 'Save and replace', no: 'Go back', danger: true }))) { saving = false; return; }
        const clean = list.map(({ _k, ...l }) => l);
        const r = await put('/api/admin/settings', { links: clean, links_intro: $('#lintro').value, mailing_list_on: $('#lmail').checked });
        settings = { ...settings, links: r.links, links_intro: r.links_intro, mailing_list_on: r.mailing_list_on };
        list = (r.links_all || []).map((l) => ({ ...l, _k: uid++ })); baseline = strip(list); paint();
        $('#lmsg').innerHTML = '<div class="msg">Saved. Your links page is up to date.</div>'; window.scrollTo(0, 0);
      } catch (e) { $('#lmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; window.scrollTo(0, 0); }
      saving = false;
    };
  }

  // =====================================================================
  // REVIEWS
  // =====================================================================
  async function viewReviews(host) {
    let list = await api('/api/admin/reviews');
    (host || view()).innerHTML = `${host ? '' : '<div class="topbar"><h1>Reviews</h1></div>'}<div id="rvmsg"></div><div id="rvlist"></div>
      <p class="hint">Every review here comes from a real paid order, and buyers can’t be impersonated. You can reply to any review. You can hide abusive or untrue ones, but shoppers are told how many are hidden, so hiding a fair critical review would cost you trust. Hide only what really breaks the rules.</p>`;
    const stars = (n) => `<span class="stars" aria-label="${n} out of 5">${'★'.repeat(n)}<span class="off">${'★'.repeat(5 - n)}</span></span>`;
    const paint = () => {
      $('#rvlist').innerHTML = list.length ? list.map((r) => `<div class="card rv${r.hidden ? ' is-hidden' : ''}" data-id="${r.id}">
        <div class="rvhead">${stars(r.rating)} <b>${esc(r.name)}</b> <span class="badge b-live">Verified purchase</span>${r.hidden ? ' <span class="badge b-canceled">Hidden</span>' : ''}<span class="spacer"></span><span class="small muted">Order #${r.order_id} · ${esc(new Date(r.created_at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }))}</span></div>
        ${r.items ? `<div class="small muted">${esc(r.items)}</div>` : ''}
        ${r.body ? `<p style="margin:8px 0">${esc(r.body)}</p>` : ''}
        ${r.reply ? `<div class="rvreply"><b>Your reply</b><br>${esc(r.reply)}</div>` : ''}
        ${r.hidden && r.hidden_note ? `<div class="small muted">Why you hid it: ${esc(r.hidden_note)}</div>` : ''}
        <div class="row mt" style="flex-wrap:wrap"><button class="btn btn-sm" data-reply="${r.id}">${r.reply ? 'Edit reply' : 'Reply'}</button>
          <button class="btn btn-sm btn-ghost" data-hide="${r.id}">${r.hidden ? 'Show again' : 'Hide'}</button></div></div>`).join('') : '<div class="card empty">No reviews yet. Buyers can review once their order ships, from the link on their receipt.</div>';
    };
    const reload = async () => { list = await api('/api/admin/reviews'); paint(); };
    $('#rvlist').onclick = async (e) => {
      const rp = e.target.closest('[data-reply]'), hd = e.target.closest('[data-hide]');
      try {
        if (rp) {
          const r = list.find((x) => x.id === Number(rp.dataset.reply));
          const m = openModal(`<div style="text-align:left"><h2>Reply</h2><p class="muted small">Replies show publicly under the review. Be kind and brief.</p>
            <textarea class="input" id="rtxt" rows="4" maxlength="800">${esc(r.reply)}</textarea>
            <div id="rerr"></div><button class="btn btn-primary btn-block mt" id="rgo2">Post reply</button><button class="btn btn-ghost btn-block mt" id="rno">Cancel</button></div>`);
          $('#rno', m.el).onclick = m.close;
          $('#rgo2', m.el).onclick = async () => { try { await put(`/api/admin/reviews/${r.id}/reply`, { reply: $('#rtxt', m.el).value }); m.close(); await reload(); } catch (err) { $('#rerr', m.el).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; } };
        } else if (hd) {
          const r = list.find((x) => x.id === Number(hd.dataset.hide));
          if (r.hidden) { await put(`/api/admin/reviews/${r.id}/hide`, { hidden: false }); return reload(); }
          const m = openModal(`<div style="text-align:left"><h2>Hide this review?</h2><p class="muted small">Only for abuse, spam, or things that aren’t true. Shoppers will see a note in your shop that a review was hidden by the seller. Write a short reason for your own records.</p>
            <input class="input" id="hnote" maxlength="200" placeholder="Contains personal information about me">
            <div id="herr"></div><button class="btn btn-danger btn-block mt" id="hgo">Hide review</button><button class="btn btn-ghost btn-block mt" id="hno">Cancel</button></div>`);
          $('#hno', m.el).onclick = m.close;
          $('#hgo', m.el).onclick = async () => { try { await put(`/api/admin/reviews/${r.id}/hide`, { hidden: true, note: $('#hnote', m.el).value }); m.close(); await reload(); } catch (err) { $('#herr', m.el).innerHTML = `<div class="msg err">${esc(err.message)}</div>`; } };
        }
      } catch (err) { $('#rvmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
    paint();
  }

  // =====================================================================
  // REPORTS
  // =====================================================================
  async function viewReports() {
    let days = 30;
    view().innerHTML = `<div class="topbar"><h1>Reports</h1><div class="spacer"></div><div class="seg" id="rng">${[7, 30, 90].map((d) => `<button type="button" data-d="${d}" class="${d === days ? 'on' : ''}">${d} days</button>`).join('')}</div></div><div id="rbody"></div>`;
    async function load() {
      const r = await api('/api/admin/reports?days=' + days);
      const att = r.attention;
      const chan = { register: 'Register', online: 'Online', auction: 'Auction' };
      const max = Math.max(1, ...r.series.map((s) => s.net_cents));
      const W = 720, H = 180, pad = 4, bw = (W - pad * 2) / r.series.length;
      const bars = r.series.map((s, i) => {
        const h = Math.round((s.net_cents / max) * (H - 22));
        const lbl = new Date(s.date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' });
        return `<rect x="${(pad + i * bw + bw * 0.12).toFixed(1)}" y="${H - 18 - h}" width="${Math.max(bw * 0.76, 1.5).toFixed(1)}" height="${Math.max(h, s.net_cents ? 2 : 0)}" rx="2" fill="var(--forest)" opacity=".85"><title>${lbl}: ${fmt(s.net_cents)} · ${s.orders} order${s.orders === 1 ? '' : 's'}</title></rect>`;
      }).join('');
      const tick = (i) => `<text x="${(pad + i * bw + bw / 2).toFixed(1)}" y="${H - 3}" text-anchor="middle" font-size="10" fill="var(--muted)">${new Date(r.series[i].date + 'T12:00:00').toLocaleDateString([], { month: 'short', day: 'numeric' })}</text>`;
      const ticks = [0, Math.floor(r.series.length / 2), r.series.length - 1].map(tick).join('');
      const attn = [];
      if (att.to_ship) attn.push(`<a class="attn" href="#/orders"><b>${att.to_ship}</b> order${att.to_ship === 1 ? '' : 's'} to ship</a>`);
      if (att.late) attn.push(`<a class="attn" href="#/orders"><b>${att.late}</b> order${att.late === 1 ? ' is' : 's are'} past your shipping time</a>`);
      if (att.awaiting_payment) attn.push(`<a class="attn" href="#/auctions"><b>${att.awaiting_payment}</b> auction win${att.awaiting_payment === 1 ? '' : 's'} waiting for payment</a>`);
      att.ending_soon.forEach((x) => attn.push(`<a class="attn" href="#/auctions"><b>${esc(x.title)}</b> ends ${esc(fmtDate(x.end_at))}</a>`));
      $('#rbody').innerHTML = `
        <div class="tiles">
          <div class="card tile"><div class="muted small">Today</div><div class="big">${fmt(r.today.net)}</div><div class="small muted">${r.today.n} order${r.today.n === 1 ? '' : 's'}</div></div>
          <div class="card tile"><div class="muted small">Last 7 days</div><div class="big">${fmt(r.week.net)}</div><div class="small muted">${r.week.n} order${r.week.n === 1 ? '' : 's'}</div></div>
          <div class="card tile"><div class="muted small">Last ${r.days} days</div><div class="big">${fmt(r.period.net)}</div><div class="small muted">${r.period.n} order${r.period.n === 1 ? '' : 's'}${r.refunds ? ` · ${fmt(r.refunds)} refunded` : ''}</div></div>
        </div>
        <div class="card" style="margin-top:14px"><h2 style="font-size:20px;margin-bottom:6px">Needs your attention</h2>
          ${attn.length ? `<div class="attns">${attn.join('')}</div>` : '<div class="muted small">All caught up.</div>'}</div>
        <div class="card" style="margin-top:14px"><h2 style="font-size:20px;margin-bottom:8px">Sales per day</h2>
          <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sales per day" style="width:100%;height:auto">${bars}<line x1="${pad}" x2="${W - pad}" y1="${H - 18}" y2="${H - 18}" stroke="var(--line)"/>${ticks}</svg>
          <div class="hint">Sales are after refunds and include tax. Hover a bar to see the day.</div></div>
        <div class="grid2" style="margin-top:14px;align-items:start">
          <div class="card"><h2 style="font-size:20px;margin-bottom:8px">Sales by channel</h2>
            ${r.channels.length ? r.channels.map((c) => `<div class="sum"><span>${chan[c.channel] || esc(c.channel)} <span class="muted small">· ${c.n} order${c.n === 1 ? '' : 's'}</span></span><b>${fmt(c.net)}</b></div>`).join('') : '<div class="muted small">No sales in this period.</div>'}</div>
          <div class="card"><h2 style="font-size:20px;margin-bottom:8px">Best sellers</h2>
            ${r.top.length ? r.top.map((t) => `<div class="sum"><span>${esc(t.name)} <span class="muted small">· ${t.qty} sold</span></span><b>${fmt(t.cents)}</b></div>`).join('') : '<div class="muted small">No sales in this period.</div>'}</div>
        </div>
        <div class="card" style="margin-top:14px"><h2 style="font-size:20px;margin-bottom:8px">Running low <span class="muted small" style="font-weight:400">(${r.low_threshold} or fewer in stock)</span></h2>
          ${r.low.length ? r.low.map((p) => `<div class="sum"><a href="#/products/${p.id}">${esc(p.name)}</a><b>${p.stock < 1 ? 'Sold out' : p.stock + ' left'}</b></div>`).join('') : '<div class="muted small">Nothing is running low.</div>'}</div>
        <div class="row mt"><button class="btn" id="rcsv">Download all orders (CSV)</button></div>`;
      $('#rcsv').onclick = () => download('/api/admin/orders.csv', 'outpost-orders.csv').catch((e) => toast(e.message));
    }
    $('#rng').onclick = (e) => { const b = e.target.closest('[data-d]'); if (!b) return; days = Number(b.dataset.d); $('#rng').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); load(); };
    await load();
  }

  // =====================================================================
  // SETTINGS
  // =====================================================================
  // ---------- branding (colors + graphics) ----------
  let draft = null;
  const GFX = [['logo', 'Logo', 'Replaces your shop name at the top. Wide images work best.'], ['mascot', 'Mascot', 'Sits at the bottom of the left column in the app and the shop.'], ['sold', '"Sold" graphic', 'Shown after a sale and on the thank-you page.']];
  const PAL = () => OutpostBrand.PALETTES;
  const curTheme = () => ({ ...PAL()[0], ...Object.fromEntries(Object.entries(draft.theme || {}).filter(([, v]) => v)), mode: (draft.theme && draft.theme.mode) || 'light' });
  function lookCard() {
    draft = { theme: { ...(settings.theme || {}) }, logo_url: settings.logo_url || '', mascot_url: settings.mascot_url || '', sold_url: settings.sold_url || '' };
    const t = curTheme();
    return `<div class="card" id="lookcard"><h2 style="font-size:22px;margin-bottom:14px">Your look</h2>
      <div class="label">Appearance</div>
      <div class="seg" id="modes">${[['light', 'Light'], ['dark', 'Dark'], ['auto', 'Match visitor\u2019s device']].map(([m, l]) => `<button type="button" data-m="${m}" class="${t.mode === m ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="hint" style="margin-bottom:16px">Dark builds a night version from your colors.</div>
      <div class="label">Color palette</div>
      <div class="pals" id="pals">${PAL().map((p, i) => `<button type="button" class="pal" data-i="${i}"><span class="sw"><i style="background:${p.bg}"></i><i style="background:${p.accent}"></i><i style="background:${p.button}"></i></span><em>${p.name}</em></button>`).join('')}</div>
      <div class="label" style="margin-top:6px">Custom colors</div>
      <div class="hint" style="margin:0 0 8px">Not a fan of the presets? Pick your own. Tapping a preset above fills these in.</div>
      <div class="colors">
        <label><span class="label">Background</span><input type="color" id="c-bg" value="${t.bg}"></label>
        <label><span class="label">Highlights</span><input type="color" id="c-accent" value="${t.accent}"></label>
        <label><span class="label">Buttons</span><input type="color" id="c-button" value="${t.button}"></label>
      </div>
      <div class="hint" id="btnhint">Buttons use white text unless you choose a button text color below, so pick a darker button color.</div>
      <div class="label" style="margin-top:18px">Text colors</div>
      <div class="seg" id="tmodes">${[['', 'Standard'], ['same', 'One color for all text'], ['each', 'Choose each']].map(([m, l]) => `<button type="button" data-tm="${m}" class="${(t.textmode || '') === m ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div id="tcolors"></div>
      <div class="hint">Text colors apply to the light look. In dark mode Outpost picks readable text on its own. Colors that are hard to read against your background can’t be saved.</div>
      <div class="label" style="margin-top:18px">Your graphics</div>
      <div id="gfx">${GFX.map(([k, name, hint]) => `<div class="gfx" data-k="${k}"><div class="gthumb" id="gt-${k}"></div>
        <div class="ginfo"><b>${name}</b><div class="hint">${hint}</div></div>
        <div class="gbtns"><label class="btn btn-sm">Upload<input type="file" accept="image/*" hidden data-up="${k}"></label><button type="button" class="btn btn-sm btn-ghost" data-rm="${k}">Remove</button></div></div>`).join('')}</div>
      <div class="hint">PNG, JPG, WebP, GIF or SVG, up to 8 MB.</div>
      <div class="row mt" style="flex-wrap:wrap"><button class="btn btn-primary" id="lsave">Save look</button><button class="btn btn-ghost" id="lreset" type="button">Back to Outpost colors</button></div>
      <div id="lmsg"></div></div>`;
  }
  const TXT_DEFAULT = { text: '#232b28', heading: '#232b28', link: '#f72d00', buttontext: '#ffffff' };
  const TXT_LABEL = { text: 'Regular text', heading: 'Headings', link: 'Links', buttontext: 'Button text' };
  function paintText() {
    const t = curTheme(), m = t.textmode || '';
    const keys = m === 'same' ? ['text'] : m === 'each' ? ['text', 'heading', 'link', 'buttontext'] : [];
    $('#tcolors').innerHTML = keys.length ? `<div class="colors" style="margin-top:8px">${keys.map((k) => `<label><span class="label">${m === 'same' ? 'All text' : TXT_LABEL[k]}</span><input type="color" id="t-${k}" data-tk="${k}" value="${t[k] || (k === 'link' ? t.button : TXT_DEFAULT[k])}"></label>`).join('')}</div>` : '';
    $('#btnhint').textContent = !m ? 'Buttons use white text unless you choose a button text color below, so pick a darker button color.' : 'Make sure your button text color stands out against your button color.';
  }
  function textProblem() {
    const t = curTheme(), tc = OutpostBrand.textColors(t), bg = t.bg;
    const chk = (c, name) => (c && OutpostBrand.contrast(c, bg) < 3 ? `${name} is too close to the background color to read.` : '');
    return chk(tc.body, 'Your text color') || chk(tc.heading, 'Your heading color') || chk(tc.link, 'Your link color') ||
      (tc.buttontext && !OutpostBrand.buttonOk(t.button, tc.buttontext) ? (t.textmode === 'same' ? 'With one color for all text, the words on your buttons are that color too, and it’s too close to your button color to read. Pick a color that stands out on your buttons, or choose “Choose each”.' : 'The button text color is too close to the button color to read.') : '');
  }
  function previewDraft() { if (window.OutpostBrand) OutpostBrand.apply({ ...settings, ...draft }); }
  function paintGfx() {
    GFX.forEach(([k]) => {
      const u = draft[k + '_url'];
      $('#gt-' + k).innerHTML = u ? `<img src="${esc(u)}" alt="">` : '<span class="muted small">None</span>';
    });
  }
  function wireLook() {
    paintGfx(); paintText();
    const setInputs = () => { const t = curTheme(); $('#c-bg').value = t.bg; $('#c-accent').value = t.accent; $('#c-button').value = t.button; };
    $('#pals').onclick = (e) => { const b = e.target.closest('[data-i]'); if (!b) return; const p = PAL()[Number(b.dataset.i)]; draft.theme = { ...draft.theme, bg: p.bg, accent: p.accent, button: p.button, mode: curTheme().mode }; setInputs(); paintText(); $('#lmsg').innerHTML = ''; previewDraft(); };
    ['bg', 'accent', 'button'].forEach((k) => {
      $('#c-' + k).oninput = (e) => {
        const v = e.target.value;
        if (k === 'button' && !OutpostBrand.buttonOk(v, OutpostBrand.textColors(curTheme()).buttontext)) { $('#lmsg').innerHTML = '<div class="msg err">That button color is too light for white text. Pick a darker one.</div>'; return; }
        $('#lmsg').innerHTML = ''; draft.theme = { ...curTheme(), [k]: v }; previewDraft();
      };
    });
    $('#modes').onclick = (e) => { const b = e.target.closest('[data-m]'); if (!b) return; draft.theme = { ...draft.theme, mode: b.dataset.m }; document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x === b)); previewDraft(); };
    $('#tmodes').onclick = (e) => { const b = e.target.closest('[data-tm]'); if (!b) return; const ct = curTheme(), nm = b.dataset.tm; draft.theme = { ...ct, textmode: nm, ...(nm ? { text: ct.text || TXT_DEFAULT.text } : {}), ...(nm === 'each' ? { heading: ct.heading || TXT_DEFAULT.heading, link: ct.link || ct.button, buttontext: ct.buttontext || TXT_DEFAULT.buttontext } : {}) }; document.querySelectorAll('#tmodes button').forEach((x) => x.classList.toggle('on', x === b)); paintText(); const pr = textProblem(); $('#lmsg').innerHTML = pr ? `<div class="msg err">${esc(pr)}</div>` : ''; previewDraft(); };
    $('#tcolors').oninput = (e) => { const k = e.target.dataset.tk; if (!k) return; draft.theme = { ...curTheme(), [k]: e.target.value }; const pr = textProblem(); $('#lmsg').innerHTML = pr ? `<div class="msg err">${esc(pr)}</div>` : ''; previewDraft(); };
    $('#lreset').onclick = () => { draft.theme = { mode: curTheme().mode }; setInputs(); paintText(); $('#lmsg').innerHTML = ''; previewDraft(); };
    $('#gfx').onchange = async (e) => {
      const inp = e.target.closest('[data-up]'); if (!inp || !inp.files[0]) return;
      try { draft[inp.dataset.up + '_url'] = await uploadImage(inp.files[0]); paintGfx(); previewDraft(); $('#lmsg').innerHTML = ''; }
      catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
      inp.value = '';
    };
    $('#gfx').onclick = (e) => { const b = e.target.closest('[data-rm]'); if (!b) return; draft[b.dataset.rm + '_url'] = ''; paintGfx(); previewDraft(); };
    $('#lsave').onclick = async () => {
      try {
        const t = curTheme(); const pr = textProblem(); if (pr) return ($('#lmsg').innerHTML = `<div class="msg err">${esc(pr)} Pick another color before saving.</div>`);
        if (!t.textmode) { delete t.text; delete t.heading; delete t.link; delete t.buttontext; } else if (t.textmode === 'same') { delete t.heading; delete t.link; delete t.buttontext; }
        const isDefault = !t.textmode && ['bg', 'accent', 'button'].every((k) => t[k].toLowerCase() === PAL()[0][k]);
        const r = await put('/api/admin/settings', { theme: isDefault ? { mode: t.mode } : t, logo_url: draft.logo_url, mascot_url: draft.mascot_url, sold_url: draft.sold_url });
        settings = { ...settings, theme: r.theme, logo_url: r.logo_url, mascot_url: r.mascot_url, sold_url: r.sold_url };
        paintBrand(); $('#lmsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (err) { $('#lmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
  }

  const EVENT_LABELS = { oversold: 'Paid for more than was in stock', honeypot: 'Hidden-field trap tripped', too_fast: 'Submitted too fast', captcha_failed: 'Failed the human check', checkout_rate: 'Too many checkouts', signup_rate: 'Too many sign-ups', bid_rate: 'Too many bids', blocked_email: 'Blocked email tried to join', blocked_ip: 'Blocked address tried to visit', blocked_bid: 'Blocked person tried to bid', flood: 'Traffic flood', ai_crawler: 'AI crawler turned away', image_flood: 'Too many photo downloads', disposable_email: 'Throwaway email', email_reuse: 'Same email used under many names', code_guessing: 'Guessing discount codes', admin_login: 'Staff signed in', admin_restore: 'Shop restored from a backup', admin_restore_started: 'Restore from a backup started', admin_login_failed: 'Failed staff sign-in', admin_lockout: 'Sign-in paused after too many tries', admin_recovery_used: 'Recovery code used to sign in', admin_logout_all: 'Signed out everywhere', admin_2fa_on: 'Two-step sign-in turned on', admin_2fa_off: 'Two-step sign-in turned off' };
  const evLabel = (k) => EVENT_LABELS[k] || String(k).replace(/_/g, ' ');

  // State base sales-tax rates (Tax Foundation, 2026). Local add-ons aren't included, so the field stays editable.
  const STATE_TAX = {AL:['Alabama',4],AK:['Alaska',0],AZ:['Arizona',5.6],AR:['Arkansas',6.5],CA:['California',7.25],CO:['Colorado',2.9],CT:['Connecticut',6.35],DE:['Delaware',0],DC:['District of Columbia',6],FL:['Florida',6],GA:['Georgia',4],HI:['Hawaii',4],ID:['Idaho',6],IL:['Illinois',6.25],IN:['Indiana',7],IA:['Iowa',6],KS:['Kansas',6.5],KY:['Kentucky',6],LA:['Louisiana',5],ME:['Maine',5.5],MD:['Maryland',6],MA:['Massachusetts',6.25],MI:['Michigan',6],MN:['Minnesota',6.88],MS:['Mississippi',7],MO:['Missouri',4.23],MT:['Montana',0],NE:['Nebraska',5.5],NV:['Nevada',6.85],NH:['New Hampshire',0],NJ:['New Jersey',6.63],NM:['New Mexico',4.88],NY:['New York',4],NC:['North Carolina',4.75],ND:['North Dakota',5],OH:['Ohio',5.75],OK:['Oklahoma',4.5],OR:['Oregon',0],PA:['Pennsylvania',6],RI:['Rhode Island',7],SC:['South Carolina',6],SD:['South Dakota',4.2],TN:['Tennessee',7],TX:['Texas',6.25],UT:['Utah',6.1],VT:['Vermont',6],VA:['Virginia',5.3],WA:['Washington',6.5],WV:['West Virginia',6],WI:['Wisconsin',5],WY:['Wyoming',4]};

  const MY_TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } })();
  const TZ_LIST = (() => { try { return Intl.supportedValuesOf('timeZone'); } catch { return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'America/Toronto', 'America/Vancouver']; } })();
  const mb = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0);
  async function viewSettings() {
    const [st, cur, discounts] = await Promise.all([api('/api/admin/status'), fetch('/api/settings').then((r) => r.json()), api('/api/admin/discounts')]);
    settings = cur;
    const base = st.base_url;
    const rp = cur.refund_policy || { preset: '', days: 14, custom: '', text: '' };
    let pol = cur.policy || {};
    let soc = cur.social || {};
    let ship = JSON.parse(JSON.stringify(cur.shipping || { on: false, regions: [], free_over_cents: 0 }));
    const card = (title, inner) => `<div class="card"><h2 style="font-size:22px;margin-bottom:14px">${title}</h2>${inner}</div>`;
    view().innerHTML = `
      <div class="topbar"><h1>Settings</h1></div>
      <div class="msg" style="margin-bottom:14px">Looking for email? Sending emails and the sender address are in <a href="#/marketing/email">Marketing → Email</a>. Your email list is under <a href="#/people/email">People → Email list</a>, and the signup box on your Link page is in <a href="#/links">Link page</a>.</div>
      <div class="settings-col">
        <div style="display:grid;gap:18px;min-width:0">
          <h2 class="sgroup">Your shop</h2>
          ${card('Basics', `
            <label class="field"><span class="label">Shop name</span><input class="input" id="sname" value="${esc(cur.store_name)}"></label>
            <label class="field"><span class="label">Contact email</span><input class="input" id="smail" type="email" inputmode="email" placeholder="hello@yourshop.com" value="${esc(pol.contact_email || (cur.social || {}).email || '')}"><div class="hint">Customers use this to reach you. It appears on your About, Privacy and Terms pages.</div></label>
            <label class="check"><input type="checkbox" id="sbreak" ${cur.break_manual ? 'checked' : ''}> <span><b>Pause sales</b> while I’m away</span></label>
            <label class="field" style="margin-top:10px"><span class="label">Message for visitors</span><textarea class="input" id="sbmsg" rows="2" maxlength="200" placeholder="${esc(DEFAULT_AWAY)}">${esc(cur.break_message === DEFAULT_AWAY ? '' : cur.break_message)}</textarea></label>
            <details class="more"><summary>Schedule it for certain dates</summary>
              <div class="grid2" style="margin-top:10px">
                <label class="field"><span class="label">Pause starts</span><input class="input" type="date" id="sfrom" value="${esc(cur.break_from || '')}"></label>
                <label class="field"><span class="label">Back on</span><input class="input" type="date" id="suntil" value="${esc(cur.break_until || '')}"></label>
              </div></details>
            <div class="hint">While paused, visitors can look around but can’t check out. Your register still works, and auctions already running keep going.</div>
            <button class="btn btn-primary mt" id="ssave">Save</button><div id="smsg"></div>`)}
          ${card('Shop timezone', `
            <p class="muted small" style="margin:0 0 10px">Discount start and last days, “pause sales” dates and the daily sales reports change over at midnight in this timezone. Without one they follow the server’s clock, which is usually several hours off.</p>
            <label class="field"><span class="label">Timezone</span><input class="input" id="tzin" list="tzlist" autocomplete="off" placeholder="${esc(MY_TZ || 'America/Los_Angeles')}" value="${esc(cur.timezone || '')}"><datalist id="tzlist">${TZ_LIST.map((z) => `<option value="${esc(z)}">`).join('')}</datalist></label>
            <div class="hint" id="tznow"></div>
            <div class="row mt" style="gap:10px;flex-wrap:wrap"><button class="btn btn-primary" id="tzsave">Save</button>${MY_TZ ? `<button class="btn btn-ghost" type="button" id="tzmine">Use my browser’s timezone (${esc(MY_TZ)})</button>` : ''}</div><div id="tzmsg"></div>`)}
          ${card('Photos', `
            <div id="phbody" class="muted small">Checking your photos…</div>`)}
          ${lookCard()}
          ${card('About your shop', `
            <label class="field"><span class="label">Tell shoppers about yourself and your shop</span><textarea class="input" id="about" rows="6" maxlength="2000" placeholder="Hi, I’m Sam. I make linocut prints and ceramics in a small studio in Portland…">${esc(cur.about_text || '')}</textarea>
              <div class="hint">Shown on your About page. Use a blank line to start a new paragraph.</div></label>
            <label class="field"><span class="label">Your “made by hand” promise</span><textarea class="input" id="hand" rows="3" maxlength="600" placeholder="Everything in this shop is designed and made by me, by hand, in my studio. I never use AI-generated images or print-on-demand.">${esc(cur.handmade_statement || '')}</textarea>
              <div class="hint">Shown at the bottom of your shop. Leave it blank to show nothing.</div></label>
            <div class="label" style="margin-top:6px">Your links (all optional)</div>
            <div class="hint" style="margin:0 0 8px">Add any link you like. Give it a name, then paste the full address from your browser.</div>
            <div id="llist"></div>
            <button class="btn btn-sm" id="ladd" type="button" style="margin-top:4px">+ Add link</button>
            <button class="btn btn-primary mt" id="asave">Save</button><div id="amsg"></div>`)}
          <h2 class="sgroup">Selling</h2>
          ${card('Sales tax: in person', `
            <p class="muted small" style="margin:0 0 12px">Used at the register, for markets and events. Charged on every in-person sale.</p>
            <label class="field"><span class="label">Where are you selling?</span><select class="input" id="shome"><option value="">Choose a state to fill in its rate…</option>${Object.entries(STATE_TAX).map(([c, [n]]) => `<option value="${c}"${cur.tax_home === c ? ' selected' : ''}>${n}</option>`).join('')}</select></label>
            <label class="field"><span class="label">Tax rate (%)</span><input class="input" id="srate" inputmode="decimal" value="${esc(cur.tax_rate)}"><div class="hint" id="srhint">Picking a state fills in its base rate. Your city or county may add a bit more, so check a receipt from your area and adjust it. Heading to an event in another state? Change this before you go. Use 0 for none.</div></label>
            <button class="btn btn-primary mt" id="taxsave">Save</button><div id="taxmsg"></div>`)}
          ${card('Sales tax: online orders', `
            <p style="margin:0 0 10px">For orders from your shop and auctions, <b>Stripe works out the tax</b> from each buyer’s address and adds it at checkout. You don’t set a rate.</p>
            <div id="taxflag" class="msg err" style="margin:0 0 10px"><b>You need to turn on Stripe Tax.</b> It’s off until you switch it on. Until then, online checkout will show an error and nobody can buy.<span id="taxflagmore"></span></div>
            <p class="small" style="margin:0 0 6px"><b>To turn it on:</b> in your Stripe dashboard open <b>Tax</b>, press <b>Get started</b>, add your business address, and add the states you’re registered to collect tax in.</p>
            <div class="hint">Stripe charges about 0.5% per sale where you’re registered, and nothing elsewhere. Not sure where you need to register? Ask an accountant.</div>`)}
          ${card('Shipping', `
            <label class="check"><input type="checkbox" id="shon" ${ship.on ? 'checked' : ''}> <span>Charge for shipping online</span></label>
            <p class="muted small" style="margin:6px 0 12px">Buyers enter their address in the checkout, and the shipping fee for their region is added. A buyer outside every region below can’t check out.</p>
            <div id="shiprows"></div>
            <div class="row" style="flex-wrap:wrap;gap:8px;margin:8px 0 14px"><span class="muted small" style="align-self:center">Add:</span>
              <button class="btn btn-ghost" type="button" data-addreg="US">United States</button>
              <button class="btn btn-ghost" type="button" data-addreg="AKHI">Alaska &amp; Hawaii</button>
              <button class="btn btn-ghost" type="button" data-addreg="CA">Canada</button>
              <button class="btn btn-ghost" type="button" data-addreg="custom">Other region</button></div>
            <label class="field"><span class="label">Free shipping when the order is over (optional)</span><input class="input" id="shfree" inputmode="decimal" placeholder="75.00" value="${ship.free_over_cents ? (ship.free_over_cents / 100).toFixed(2) : ''}"><div class="hint">Leave blank for no free shipping. Counted after any discount code.</div></label>
            <label class="field"><span class="label">I usually ship within (days)</span><input class="input" id="shipd" inputmode="numeric" value="${esc(cur.ship_days || 0)}"><div class="hint">Shown to buyers. Orders still unshipped after this long are flagged for you. 0 turns it off.</div></label>
            <div class="row mt" style="flex-wrap:wrap;gap:8px"><button class="btn btn-primary" id="shsave">Save</button></div><div id="shmsg"></div>`)}
          ${card('Refunds', `
            <label class="field"><span class="label">What is your policy?</span><select class="input" id="rpre">
              ${[['', 'Not set (nothing shown)'], ['final', 'All sales final'], ['days', 'Refunds within a number of days'], ['exchange', 'Exchanges or store credit only'], ['custom', 'Write my own']].map(([k, l]) => `<option value="${k}"${rp.preset === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field" id="rdaysw"><span class="label">Number of days</span><input class="input" id="rdays" inputmode="numeric" value="${esc(rp.days)}"></label>
            <label class="field" id="rtextw"><span class="label">Your policy, in your words</span><textarea class="input" id="rtext" rows="3" maxlength="500">${esc(rp.custom)}</textarea></label>
            <div class="hint">Shown to buyers at checkout and on their receipt. Buyers are never charged a fee by Outpost. You do refunds yourself from Orders → Manage.</div>
            <div class="msg" id="rprev" style="margin-top:8px"></div>
            <button class="btn btn-primary mt" id="rsave">Save policy</button><div id="rmsg"></div>`)}
          ${card('Stock and order limits', `
            <div class="grid2">
              <label class="field"><span class="label">Low-stock alert at</span><input class="input" id="slow" inputmode="numeric" value="${esc(cur.low_stock)}"><div class="hint">Shows “Low” on Products and Reports.</div></label>
              <label class="field"><span class="label">Max per item, per order</span><input class="input" id="sqty" inputmode="numeric" value="${esc(cur.max_qty)}"><div class="hint">Stops bulk buying. 0 means no limit.</div></label>
            </div>
            <button class="btn btn-primary mt" id="stsave">Save</button><div id="stmsg"></div>`)}
          ${card('Discount codes', `
            <div id="dlist"></div>
            <div class="label" style="margin-top:14px">New code</div>
            <div class="grid2">
              <label class="field"><span class="label">Code</span><input class="input" id="dcode" placeholder="WELCOME10" maxlength="24"></label>
              <label class="field"><span class="label">Type</span><select class="input" id="dkind"><option value="percent">Percent off</option><option value="amount">Dollars off</option></select></label>
              <label class="field"><span class="label" id="dvl">Percent</span><input class="input" id="dval" inputmode="decimal" placeholder="10"></label>
              <label class="field"><span class="label">Minimum spend (optional)</span><input class="input" id="dmin" inputmode="decimal" placeholder="25.00"></label>
              <label class="field"><span class="label">Total times it can be used (optional)</span><input class="input" id="dmax" inputmode="numeric"></label>
              <label class="field"><span class="label">Times each customer can use it <span class="badge b-live">New</span></span><input class="input" id="dper" inputmode="numeric" placeholder="1"><span class="small muted">Counted by email address. Leave empty for no limit.</span></label>
              <label class="field"><span class="label">Starts (optional)</span><input class="input" type="date" id="dstart"></label>
              <label class="field"><span class="label">Last day (optional)</span><input class="input" type="date" id="dexp"></label>
            </div>
            <button class="btn btn-primary" id="dadd">Add code</button><div id="dmsg"></div>`)}
          ${card('Bidding', `
            <label class="check"><input type="checkbox" id="bcard" ${cur.bid_card_manual ? 'checked' : ''} ${cur.stripe_ready ? '' : 'disabled'}> <span>Require a card to bid, and charge the winner automatically</span></label>
            <div class="hint">${cur.stripe_ready ? 'Bidders save a card with Stripe before their first bid. Nothing is charged unless they win. When a lot ends, the winning bid (plus tax) is charged once. If a charge fails, you’ll see why and can send the usual payment link. Winners then add their shipping address from their receipt.' : 'This needs your Stripe keys first, because cards are saved by Stripe. See the setup guide.'}</div>
            <button class="btn btn-primary mt" id="bsave" ${cur.stripe_ready ? '' : 'disabled'}>Save</button><div id="bmsg2"></div>`)}
          <h2 class="sgroup">Legal pages</h2>
          ${card('Privacy and Terms', `
            <p class="muted small" style="margin:0 0 12px">Outpost writes both pages for you from your other settings, at <b>${esc(base)}/privacy.html</b> and <b>${esc(base)}/terms.html</b>. Stripe asks for these two addresses. Nothing to fill in unless you want to change something.</p>
            <div class="msg" style="margin:0 0 10px">Plain-language starting points, not legal advice. Give them a read, and change anything that doesn’t match how you run your shop.</div>
            <details class="more"><summary>Add a few touches to Outpost’s version</summary>
              <label class="field" style="margin-top:10px"><span class="label">Which state or country’s laws apply?</span><input class="input" id="plaw" maxlength="80" placeholder="Washington State, USA" value="${esc(pol.governing_law || '')}"></label>
              <label class="field"><span class="label">Extra shipping notes</span><textarea class="input" id="pship" rows="2" maxlength="400" placeholder="Tracking is emailed once your order is on its way.">${esc(pol.ship_note || '')}</textarea></label>
              <label class="field"><span class="label">Extra for your Privacy Policy</span><textarea class="input" id="ppriv" rows="3" maxlength="1500">${esc(pol.privacy_extra || '')}</textarea></label>
              <label class="field"><span class="label">Extra for your Terms</span><textarea class="input" id="pterm" rows="3" maxlength="1500" placeholder="Custom orders, commissions, workshop cancellations…">${esc(pol.terms_extra || '')}</textarea></label>
            </details>
            ${[['privacy', 'Privacy Policy'], ['terms', 'Terms of Service']].map(([k, label]) => `<details class="more" id="own-${k}"${pol[k + '_own'] ? ' open' : ''}><summary>Write your own ${label}</summary>
              <label class="check" style="margin-top:10px"><input type="checkbox" id="${k}own" ${pol[k + '_own'] ? 'checked' : ''}> <span>Show my text instead of Outpost’s</span></label>
              <textarea class="input" id="${k}custom" rows="14" maxlength="20000" style="margin-top:8px" placeholder="Write your ${label} here…">${esc(pol[k + '_custom'] || '')}</textarea>
              <div class="hint">Leave a blank line between paragraphs. Start a line with <b>##</b> for a heading, or with <b>-</b> for a bullet. Your text replaces the whole page, so the touches above aren’t used while this is on.</div>
              <button class="btn btn-ghost mt" type="button" data-startfrom="${k}">Start from Outpost’s version</button></details>`).join('')}
            <div class="row mt" style="flex-wrap:wrap;gap:8px"><button class="btn btn-primary" id="polsave">Save</button><a class="btn btn-ghost" href="privacy.html" target="_blank" rel="noopener">View privacy ↗</a><a class="btn btn-ghost" href="terms.html" target="_blank" rel="noopener">View terms ↗</a></div><div id="polmsg"></div>`)}
        </div>
        <div style="display:grid;gap:18px;min-width:0">
          ${card('Keep AI crawlers out', `
            <label class="check"><input type="checkbox" id="aishield" ${cur.block_ai ? 'checked' : ''}> <span>Turn away AI crawlers and slow down bulk photo downloads</span></label>
            <div class="hint">Your photos and writing are asked to stay out of AI training, and known AI crawlers are blocked even if they ignore the request. <b>Google, Bing, DuckDuckGo, Pinterest and link previews are never blocked</b>, so your shop can still be found in search. The tradeoff: AI assistants like ChatGPT and Perplexity won’t be able to show or link your shop either. A crawler that pretends to be an ordinary browser can’t be spotted from here. The guide shows how to add Cloudflare’s free bot controls for that.</div>
            <button class="btn btn-primary mt" id="aisave">Save</button><div id="aimsg"></div>`)}
          ${card('Back up your shop', `
            <p class="small">Downloads one file with all your products, orders, reviews and photos. Do this every week or two and keep it somewhere safe, like your computer or a cloud drive.</p>
            <button class="btn btn-primary" id="bkup">Download backup</button><div id="bkmsg"></div>
            <p class="hint" style="margin-top:12px">Need to go back to an earlier backup? <button class="linkbtn" type="button" id="rsopen">Restore from a backup</button></p>
            <div id="rspanel" class="rspanel" hidden></div>`)}
          <div class="card"><h2 style="font-size:22px;margin-bottom:14px">Status</h2>
          <p>Card payments: ${st.stripe ? '<span class="badge b-paid">Connected to Stripe</span>' : '<span class="badge b-pending">Not set up yet</span>'}</p>
          <p>Payment confirmations (webhook): ${st.webhook ? '<span class="badge b-paid">Ready</span>' : '<span class="badge b-pending">Not set up yet</span>'}</p>
          <h3 style="font-size:18px;margin:18px 0 8px">Share these links</h3>
          <p class="small">Shop: <a href="/store.html" target="_blank" rel="noopener">${esc(base)}/store.html</a><br>Auctions: <a href="/auction.html" target="_blank" rel="noopener">${esc(base)}/auction.html</a></p>
          <p class="hint">When you put Outpost online, set BASE_URL in your .env to your real web address so links and payment links work for customers.</p></div>
        </div>
      </div>`;
    wireLook();
    $('#shome').onchange = () => { const t = STATE_TAX[$('#shome').value]; if (t) { $('#srate').value = t[1]; $('#srhint').textContent = t[0] + '’s base rate is ' + t[1] + '%. Your city or county may add a bit more, so check a receipt from your area and adjust it.'; } };
    // Is Stripe Tax on? Best effort. If Stripe can't tell us, the warning stays up.
    api('/api/admin/tax-status').then((t) => {
      const f = $('#taxflag'); if (!f) return;
      if (t.state === 'active') { f.className = 'msg'; f.innerHTML = '<b>Stripe Tax is on.</b> Online orders get the right tax automatically.'; }
      else if (t.state === 'pending') $('#taxflagmore').textContent = ' Stripe says it isn’t finished setting up yet.';
    }).catch(() => {});

    // --- shop name, contact email, pause ---
    $('#ssave').onclick = async () => {
      try {
        const email = $('#smail').value.trim();
        // Take the current saved values first, so a change made in another tab isn't reverted by this Save (it used to resend the old copy).
        const fresh = await fetch('/api/settings').then((x) => x.json()); pol = fresh.policy || {}; soc = fresh.social || {};
        const r = await put('/api/admin/settings', { store_name: $('#sname').value, break_on: $('#sbreak').checked, break_message: $('#sbmsg').value, break_from: $('#sfrom').value, break_until: $('#suntil').value,
          ...(email !== (pol.contact_email || '') ? { policy: { ...pol, contact_email: email } } : {}), social: { ...soc, email } });
        settings = { ...settings, ...r }; if (r.policy) pol = r.policy; if (r.social) soc = r.social;
        paintBrand();
        $('#smsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#smsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // --- timezone ---
    const paintTz = () => {
      const z = $('#tzin').value.trim() || MY_TZ;
      let t = '';
      try { t = new Date().toLocaleString([], { timeZone: z, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch { t = ''; }
      $('#tznow').innerHTML = t ? `Shop time right now: <b>${esc(t)}</b>` : '<span style="color:var(--bad,#b42318)">That timezone isn’t one I know. Pick one from the list.</span>';
    };
    $('#tzin').oninput = paintTz; paintTz();
    if ($('#tzmine')) $('#tzmine').onclick = () => { $('#tzin').value = MY_TZ; paintTz(); };
    $('#tzsave').onclick = async () => {
      try { const r = await put('/api/admin/settings', { timezone: $('#tzin').value.trim() }); settings = { ...settings, ...r }; $('#tzmsg').innerHTML = '<div class="msg">Saved. Dates and reports now follow this timezone.</div>'; }
      catch (e) { $('#tzmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    // --- photos ---
    const paintPhotos = async () => {
      const box = $('#phbody');
      try {
        const u = await post('/api/admin/images/cleanup', {});
        const pct = Math.min(100, Math.round((u.used_bytes / u.limit_bytes) * 100));
        box.className = '';
        box.innerHTML = `<div>${mb(u.used_bytes)} MB used of ${mb(u.limit_bytes)} MB</div>
          <div style="height:10px;border-radius:5px;background:var(--line,#e5e7eb);margin:8px 0"><div style="width:${pct}%;height:10px;border-radius:5px;background:var(--accent,#2f5d50)"></div></div>
          ${u.unused ? `<p class="small" style="margin:0 0 10px">${u.unused} photo${u.unused === 1 ? ' isn’t' : 's aren’t'} used by any product, lot, product line or setting (${mb(u.bytes)} MB).</p><button class="btn" id="phclean">Clean up unused photos…</button><div id="phconfirm"></div>` : '<p class="small muted" style="margin:0">Every photo is in use.</p>'}<div id="phmsg"></div>`;
        if (u.unused) $('#phclean').onclick = () => {
          $('#phconfirm').innerHTML = `<div class="msg err" style="margin-top:10px"><b>Delete ${u.unused} unused photo${u.unused === 1 ? '' : 's'} and free ${mb(u.bytes)} MB?</b><div class="small" style="margin:6px 0 10px">This can’t be undone. Photos that a product, lot or setting uses are never touched.</div><div class="row" style="gap:10px"><button class="btn btn-primary" id="phdel">Delete ${u.unused} photo${u.unused === 1 ? '' : 's'}</button><button class="btn btn-ghost" id="phno">Cancel</button></div></div>`;
          $('#phno').onclick = () => { $('#phconfirm').innerHTML = ''; };
          $('#phdel').onclick = async () => { $('#phdel').disabled = true; try { await post('/api/admin/images/cleanup', { delete: true }); toast('Photos removed'); paintPhotos(); } catch (e) { $('#phmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; } };
        };
      } catch (e) { box.innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    paintPhotos();

    // --- sales tax ---
    $('#taxsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { tax_rate: $('#srate').value, tax_home: $('#shome').value });
        settings = { ...settings, ...r };
        $('#taxmsg').innerHTML = '<div class="msg">Saved. The register now charges ' + esc($('#srate').value || '0') + '%.</div>';
      } catch (e) { $('#taxmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    // --- stock ---
    $('#stsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { low_stock: $('#slow').value, max_qty: $('#sqty').value });
        settings = { ...settings, ...r }; $('#stmsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#stmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // Your links: one row per link, a name and an address. Remove or add as many as you like.
    const lrow = (n, u) => `<div class="lrow"><label class="field" style="margin:0"><span class="label small">Name</span><input class="input lname" maxlength="40" autocomplete="off" placeholder="Website" value="${esc(n)}"></label><label class="field lkf" style="margin:0"><span class="label small">Link</span><input class="input lurl" inputmode="url" autocomplete="off" placeholder="https://" value="${esc(u)}"></label><button class="btn btn-sm lx" type="button" aria-label="Remove this link">Remove</button></div>`;
    const paintLinks = (list) => { $('#llist').innerHTML = list.map((l) => lrow(l.name, l.url)).join(''); };
    paintLinks(cur.social_links || []);
    $('#llist').onclick = (e) => { const x = e.target.closest('.lx'); if (x) x.closest('.lrow').remove(); };
    $('#ladd').onclick = () => { $('#llist').insertAdjacentHTML('beforeend', lrow('', '')); const rows = document.querySelectorAll('#llist .lname'); rows[rows.length - 1].focus(); };
    $('#asave').onclick = async () => {
      const social_links = [...document.querySelectorAll('#llist .lrow')].map((r) => ({ name: $('.lname', r).value, url: $('.lurl', r).value }));
      try {
        const r = await put('/api/admin/settings', { about_text: $('#about').value, handmade_statement: $('#hand').value, social_links });
        settings = { ...settings, ...r }; $('#amsg').innerHTML = '<div class="msg">Saved. Your About page is in the shop menu.</div>';
        paintLinks(r.social_links || []);
      } catch (e) { $('#amsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // --- shipping ---
    const SHIP_PRESET = { US: { name: 'United States', country: 'US', states: '' }, AKHI: { name: 'Alaska & Hawaii', country: 'US', states: 'AK, HI' }, CA: { name: 'Canada', country: 'CA', states: '' }, custom: { name: '', country: 'US', states: '' } };
    const paintShip = () => {
      $('#shiprows').innerHTML = ship.regions.length ? ship.regions.map((r, i) => `<div class="card" style="padding:12px;margin-bottom:8px;box-shadow:none" data-i="${i}">
        <div class="grid2">
          <label class="field"><span class="label">Region name</span><input class="input" data-f="name" maxlength="40" value="${esc(r.name)}"></label>
          <label class="field"><span class="label">Price ($)</span><input class="input" data-f="price" inputmode="decimal" value="${(r.cents / 100).toFixed(2)}"></label>
          <label class="field"><span class="label">Country</span><select class="input" data-f="country"><option value="US"${r.country === 'US' ? ' selected' : ''}>United States</option><option value="CA"${r.country === 'CA' ? ' selected' : ''}>Canada</option></select></label>
          <label class="field"><span class="label">Only these states (optional)</span><input class="input" data-f="states" maxlength="80" placeholder="e.g. AK, HI" value="${esc(r.states)}"></label>
        </div>
        <button class="link-btn" type="button" data-del="${i}">Remove this region</button></div>`).join('') : '<p class="muted small">No regions yet. Add one below.</p>';
      $('#shiprows').querySelectorAll('[data-f]').forEach((el) => { el.oninput = el.onchange = () => { const r = ship.regions[Number(el.closest('[data-i]').dataset.i)]; const f = el.dataset.f; if (f === 'price') r.cents = Number.isNaN(toCents(el.value)) ? 0 : toCents(el.value); else r[f] = el.value; }; });
      $('#shiprows').querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { ship.regions.splice(Number(b.dataset.del), 1); paintShip(); }; });
    };
    document.querySelectorAll('[data-addreg]').forEach((b) => { b.onclick = () => { const p = SHIP_PRESET[b.dataset.addreg]; ship.regions.push({ id: 'n' + Date.now(), ...p, cents: p.country === 'CA' ? 1200 : p.states ? 900 : 500 }); paintShip(); }; });
    paintShip();
    $('#shsave').onclick = async () => {
      try {
        const fr = $('#shfree').value.trim(); const free = fr === '' ? 0 : toCents(fr);
        if (Number.isNaN(free) || free < 0) throw new Error('Free-shipping amount should be a number like 75.00');
        const r = await put('/api/admin/settings', { shipping: { on: $('#shon').checked, regions: ship.regions, free_over_cents: free }, ship_days: $('#shipd').value });
        settings = { ...settings, ...r }; if (r.shipping) { ship = JSON.parse(JSON.stringify(r.shipping)); paintShip(); }
        $('#shmsg').innerHTML = '<div class="msg">Saved. Checkout now uses these shipping prices.</div>';
      } catch (e) { $('#shmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // Fill the box with Outpost's own wording as plain text, so you can edit it instead of starting from nothing.
    const legalText = (k) => {
      const d = document.createElement('div'); d.innerHTML = window.OutpostLegal[k]({ ...settings, store_name: settings.store_name }, { ...pol, [k + '_own']: false });
      const out = [];
      d.childNodes.forEach((n) => {
        if (n.tagName === 'H1' || (n.tagName === 'P' && n.classList.contains('muted'))) return;
        if (n.tagName === 'H2') out.push('## ' + n.textContent.trim());
        else if (n.tagName === 'UL') out.push([...n.children].map((li) => '- ' + li.textContent.trim()).join('\n'));
        else if (n.textContent.trim()) out.push(n.textContent.trim());
      });
      return out.join('\n\n');
    };
    document.querySelectorAll('[data-startfrom]').forEach((b) => { b.onclick = async () => { const k = b.dataset.startfrom, box = $('#' + k + 'custom'); if (box.value.trim() && !(await confirmBox({ title: 'Replace what you’ve written?', body: 'Outpost’s version takes its place.', yes: 'Replace', no: 'Keep mine', danger: true }))) return; box.value = legalText(k); }; });
    $('#polsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { policy: { ...pol, ship_note: $('#pship').value, governing_law: $('#plaw').value, privacy_extra: $('#ppriv').value, terms_extra: $('#pterm').value, privacy_custom: $('#privacycustom').value, terms_custom: $('#termscustom').value, privacy_own: $('#privacyown').checked, terms_own: $('#termsown').checked } });
        settings = { ...settings, ...r }; if (r.policy) pol = r.policy; $('#polmsg').innerHTML = '<div class="msg">Saved. Your Privacy and Terms pages are up to date.</div>';
      } catch (e) { $('#polmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    $('#bsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { bid_card_required: $('#bcard').checked });
        settings = { ...settings, ...r }; $('#bmsg2').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#bmsg2').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#aisave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { block_ai: $('#aishield').checked });
        settings = { ...settings, ...r }; $('#aimsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#aimsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#bkup').onclick = async () => {
      try { await download('/api/admin/backup', 'outpost-backup-' + new Date().toISOString().slice(0, 10) + '.tar.gz'); $('#bkmsg').innerHTML = '<div class="msg">Backup downloaded. Check your Downloads folder.</div>'; }
      catch (e) { $('#bkmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // --- restore from a backup: the file is unpacked right here in the browser and sent to the shop in small pieces ---
    const rsMsg = (cls, html) => `<div class="${cls}">${html}</div>`;
    const readTar = async (file, onEntry) => {   // reads a .tar.gz one piece at a time; onEntry(name, size, header, readData) is called for every file inside
      const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      let chunks = [], have = 0;
      const fill = async (n) => { while (have < n) { const { done, value } = await reader.read(); if (done) return false; chunks.push(value); have += value.length; } return true; };
      const take = async (n) => { if (!(await fill(n))) throw new Error('short'); const out = new Uint8Array(n); let o = 0; while (o < n) { const c = chunks[0]; const k = Math.min(c.length, n - o); out.set(c.subarray(0, k), o); o += k; if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k); } have -= n; return out; };
      const skip = async (n) => { while (n > 0) { if (!chunks.length && !(await fill(1))) throw new Error('short'); const c = chunks[0]; const k = Math.min(c.length, n); if (k === c.length) chunks.shift(); else chunks[0] = c.subarray(k); have -= k; n -= k; } };
      const txt = (b, a, z) => new TextDecoder().decode(b.subarray(a, z)).replace(/\0.*$/s, '').trim();
      for (;;) {
        if (!(await fill(512))) break;
        const h = await take(512);
        if (h.every((x) => x === 0)) break;
        const name = txt(h, 0, 100), size = parseInt(txt(h, 124, 136), 8), type = String.fromCharCode(h[156] || 48), mtime = parseInt(txt(h, 136, 148), 8);
        if (!name || !Number.isFinite(size)) throw new Error('bad header');
        const pad = (512 - (size % 512)) % 512;
        let used = false;
        if (type === '0') await onEntry(name, size, mtime, async () => { used = true; return take(size); });
        if (!used) await skip(size);
        await skip(pad);
      }
      reader.cancel().catch(() => {});
    };
    const scanBackup = async (file) => {
      let db = null, photos = 0, bytes = 0;
      try { await readTar(file, async (name, size, mtime) => { if (name === 'outpost.db') db = { size, mtime }; else if (/^images\/[\w.-]+$/.test(name)) { photos++; bytes += size; } }); } catch { return null; }
      return db ? { made: db.mtime * 1000, photos, bytes } : null;
    };
    const rawPut = async (path, body) => {
      const r = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream', 'x-admin-token': token }, body });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'The upload failed. Nothing was changed.');
      return d;
    };
    let rsFile = null, rsInfo = null, rsBusy = false;
    const rsPanel = () => $('#rspanel');
    const rsPick = (msg) => {
      rsPanel().innerHTML = `<p><b>Restore from a backup</b></p>
        <div class="msg warn"><b>This replaces everything in your shop</b> (products, orders, photos, settings) with what is in the backup. Anything added since the backup was made is lost, so check Stripe for any payments since then. Download a fresh backup first if you are not sure.</div>
        ${msg || ''}
        <label class="field"><span class="label">Backup file</span><input class="input" type="file" id="rsfile" accept=".gz,.tgz,.tar.gz,application/gzip"></label>
        <button class="btn btn-primary" disabled>Restore</button>`;
      $('#rsfile').onchange = async () => {
        const f = $('#rsfile').files[0]; if (!f) return;
        rsPanel().querySelector('button').textContent = 'Reading the file…';
        const info = await scanBackup(f);
        if (!info) return rsPick(rsMsg('msg err', '<b>That file is not an Outpost backup.</b> Choose the .tar.gz file you downloaded from Back up your shop. Nothing was changed.'));
        rsFile = f; rsInfo = info; rsConfirm();
      };
    };
    const rsConfirm = (msg) => {
      const when = rsInfo.made ? new Date(rsInfo.made).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown date';
      rsPanel().innerHTML = `<p><b>Restore from a backup</b></p>
        <div class="msg warn"><b>This replaces everything in your shop</b> (products, orders, photos, settings) with what is in the backup. Anything added since the backup was made is lost, so check Stripe for any payments since then.</div>
        <div class="rsfile"><b>${esc(rsFile.name)}</b><span class="hint">${mb(rsFile.size)} MB · made ${esc(when)} · ${rsInfo.photos} photo${rsInfo.photos === 1 ? '' : 's'}</span></div>
        ${msg || ''}
        <label class="field"><span class="label">Your password</span><input class="input" type="password" id="rspw" autocomplete="current-password"></label>
        ${st.two_step ? '<label class="field"><span class="label">Code from your authenticator app</span><input class="input" id="rscode" inputmode="numeric" maxlength="7" autocomplete="one-time-code"></label>' : ''}
        <label class="field"><span class="label">Type RESTORE to confirm</span><input class="input" id="rstype" autocomplete="off"></label>
        <div class="row"><button class="btn btn-primary" id="rsgo" disabled>Restore</button><button class="btn" id="rsagain" type="button">Choose a different file</button></div>`;
      const ready = () => { $('#rsgo').disabled = !($('#rspw').value && $('#rstype').value.trim() === 'RESTORE'); };
      $('#rspw').oninput = ready; $('#rstype').oninput = ready;
      $('#rsagain').onclick = () => rsPick();
      $('#rsgo').onclick = rsRun;
    };
    const rsProgress = (text, pct) => { rsPanel().innerHTML = `<p><b>Restoring…</b></p><div class="rsbar"><i style="width:${Math.max(2, Math.min(100, pct))}%"></i></div><p class="hint">${esc(text)} Please keep this page open.</p>`; };
    const rsRun = async () => {
      if (rsBusy) return; rsBusy = true;
      const pw = $('#rspw').value, code = $('#rscode') ? $('#rscode').value : '';
      let id = '';
      try {
        rsProgress('Checking your password.', 3);
        const start = await post('/api/admin/restore/start', { password: pw, code });
        id = start.id;
        const have = new Map(start.have.map((x) => [x.name, x.bytes]));
        let sent = 0, step = 0; const total = rsInfo.photos;
        rsProgress('Sending your database.', 8);
        await readTar(rsFile, async (name, size, mtime, data) => {
          if (name === 'outpost.db') {
            const d = await rawPut(`/api/admin/restore/${id}/db`, await data());
            rsProgress(`Found ${d.products} product${d.products === 1 ? '' : 's'} and ${d.orders} order${d.orders === 1 ? '' : 's'}. Sending photos.`, 12);
          } else if (/^images\/[\w.-]+$/.test(name)) {
            const n = name.slice(7);
            if (have.get(n) !== size) await rawPut(`/api/admin/restore/${id}/image/${encodeURIComponent(n)}`, await data());
            step++; if (step % 3 === 0 || step === total) rsProgress(`Photos ${step} of ${total}.`, 12 + (step / Math.max(1, total)) * 80);
          }
        });
        rsProgress('Finishing. Your shop is about to restart.', 96);
        const fin = await post(`/api/admin/restore/${id}/finish`, {});
        rsDone(fin);
      } catch (e) {
        rsBusy = false;
        if (id) { try { await api('/api/admin/restore/' + id, { method: 'DELETE' }); } catch { /* it clears itself */ } }
        rsConfirm(rsMsg('msg err', esc(e.message) + ' Nothing was changed.'));
      }
    };
    const rsDone = (fin) => {
      rsPanel().innerHTML = rsMsg('msg', `<b>Restored.</b> ${fin.products} product${fin.products === 1 ? '' : 's'} and ${fin.orders} order${fin.orders === 1 ? '' : 's'} are back. ${fin.hosted ? 'Your shop is restarting now, so this page will ask you to sign in again in about a minute.' : 'Outpost has stopped to finish the restore. Start it again, then sign in.'} Two-step sign-in is off after a restore. Turn it back on in Security.`);
      if (!fin.hosted) return;
      const wait = async () => { for (let i = 0; i < 90; i++) { await new Promise((r) => setTimeout(r, 2000)); try { const r = await fetch('/api/settings'); if (r.ok && i > 1) return location.reload(); } catch { /* still restarting */ } } };
      wait();
    };
    $('#rsopen').onclick = () => { const p = rsPanel(); if (!p.hidden) { p.hidden = true; return; } p.hidden = false; rsPick(); };

    // --- refund policy ---
    const rpText = () => {
      const p = $('#rpre').value, d = parseInt($('#rdays').value, 10) || 14;
      return p === 'final' ? 'All sales are final. No refunds or exchanges.'
        : p === 'days' ? `Refunds within ${d} days of delivery for items in their original condition. Message the seller to arrange a return.`
        : p === 'exchange' ? `Exchanges or store credit within ${d} days of delivery. No cash refunds.`
        : p === 'custom' ? $('#rtext').value.trim() : '';
    };
    const rpPaint = () => {
      const p = $('#rpre').value;
      $('#rdaysw').hidden = !(p === 'days' || p === 'exchange'); $('#rtextw').hidden = p !== 'custom';
      const t = rpText(); $('#rprev').hidden = !t; $('#rprev').textContent = t ? 'Buyers will see: ' + t : '';
    };
    ['rpre', 'rdays', 'rtext'].forEach((id) => { $('#' + id).oninput = rpPaint; });
    rpPaint();
    $('#rsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { refund_preset: $('#rpre').value, refund_days: $('#rdays').value, refund_text: $('#rtext').value });
        settings = { ...settings, refund_policy: r.refund_policy };
        $('#rmsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#rmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // --- discount codes ---
    let dlist = discounts;
    const dPaint = () => {
      $('#dlist').innerHTML = dlist.length ? dlist.map((d) => {
        const off = d.kind === 'percent' ? `${d.value}% off` : `${fmt(d.value)} off`;
        const bits = [d.min_subtotal_cents ? `over ${fmt(d.min_subtotal_cents)}` : '', d.max_uses ? `${d.uses}/${d.max_uses} used` : `${d.uses} used`, d.max_per_customer ? `${d.max_per_customer} per customer` : '', d.starts_on ? `starts ${d.starts_on}` : '', d.expires_on ? `ends ${d.expires_on}` : ''].filter(Boolean).join(' · ');
        return `<div class="drow"><div><b>${esc(d.code)}</b> <span class="badge ${d.active ? 'b-live' : ''}">${d.active ? 'On' : 'Off'}</span><div class="small muted">${off}${bits ? ' · ' + bits : ''}</div></div>
          <div class="row"><button class="btn btn-sm" data-dt="${d.id}">${d.active ? 'Turn off' : 'Turn on'}</button><button class="btn btn-sm btn-danger" data-dx="${d.id}">Delete</button></div></div>`;
      }).join('') : '<div class="muted small">No codes yet. Make one below, like WELCOME10 for 10% off.</div>';
    };
    dPaint();
    $('#dkind').onchange = () => { $('#dvl').textContent = $('#dkind').value === 'percent' ? 'Percent' : 'Dollars off'; $('#dval').placeholder = $('#dkind').value === 'percent' ? '10' : '5.00'; };
    $('#dadd').onclick = async () => {
      try {
        const kind = $('#dkind').value;
        const value = kind === 'percent' ? Number($('#dval').value) : toCents($('#dval').value);
        const min = $('#dmin').value.trim() ? toCents($('#dmin').value) : 0;
        await post('/api/admin/discounts', { code: $('#dcode').value, kind, value, min_subtotal_cents: min, max_uses: $('#dmax').value.trim() ? Number($('#dmax').value.trim()) : null, max_per_customer: $('#dper').value.trim() ? Number($('#dper').value.trim()) : null, starts_on: $('#dstart').value || null, expires_on: $('#dexp').value || null });
        dlist = await api('/api/admin/discounts'); dPaint();
        ['dcode', 'dval', 'dmin', 'dmax', 'dper', 'dstart', 'dexp'].forEach((id) => { $('#' + id).value = ''; });
        $('#dmsg').innerHTML = '<div class="msg">Code added.</div>';
      } catch (e) { $('#dmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#dlist').onclick = async (e) => {
      const t = e.target.closest('[data-dt]'), x = e.target.closest('[data-dx]');
      try {
        if (t) { const d = dlist.find((y) => y.id === Number(t.dataset.dt)); await put('/api/admin/discounts/' + d.id, { active: !d.active }); }
        else if (x && (await confirmBox({ title: 'Delete this code?', body: 'Shoppers can no longer use it.', yes: 'Delete', danger: true }))) await api('/api/admin/discounts/' + x.dataset.dx, { method: 'DELETE' });
        else return;
        dlist = await api('/api/admin/discounts'); dPaint();
      } catch (err) { $('#dmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };


  }

  // =====================================================================
  // SECURITY
  // =====================================================================
  async function viewSecurity() {
    const [st, sec, chk] = await Promise.all([api('/api/admin/status'), api('/api/admin/security'), api('/api/admin/setup-check')]);
    const card = (title, inner) => `<div class="card"><h2 style="font-size:22px;margin-bottom:14px">${title}</h2>${inner}</div>`;
    view().innerHTML = `
      <div class="topbar"><h1>Security</h1></div>
      <div class="settings-col">
        <div style="display:grid;gap:18px;min-width:0">
          <h2 class="sgroup">Your sign-in</h2>
          ${card('Two-step sign-in', `<div id="tfabox"></div><div style="border-top:1px solid var(--line);margin-top:16px;padding-top:14px" class="row" id="sabox"></div>`)}
          ${card('Check your setup', '<div id="setup"></div>')}
        </div>
        <div style="display:grid;gap:18px;min-width:0">
          <h2 class="sgroup">Protection</h2>
          ${card('Protection from bots and scammers', `
            <div id="prot"></div>
            <h3 style="font-size:18px;margin:18px 0 6px">Blocked people</h3>
            <div class="row" style="flex-wrap:wrap"><select class="input" id="bkind" style="width:auto"><option value="email">Email</option><option value="ip">IP address</option></select>
              <input class="input" id="bval" placeholder="someone@example.com" style="flex:1;min-width:160px"><button class="btn" id="badd">Block</button></div>
            <div id="blist" style="margin-top:8px"></div><div id="bmsg"></div>
            <h3 style="font-size:18px;margin:18px 0 6px">Recent blocked attempts</h3>
            <div class="row" id="evf" style="flex-wrap:wrap;gap:6px;margin-bottom:6px">
              <button class="btn btn-sm" data-g="all">All</button><button class="btn btn-sm" data-g="bots">Bots and scammers</button><button class="btn btn-sm" data-g="money">Payment problems</button></div>
            <div id="sevents"></div>
            <div class="row" style="margin-top:10px;flex-wrap:wrap"><button class="btn btn-sm" id="evmore" hidden>Show 25 more</button><button class="btn btn-sm" id="evcsv">Download log (CSV)</button></div>
            <p class="hint" id="evfoot"></p>`)}
          ${card('Staff sign-ins', `<div id="staffev"></div><p class="hint">Your own sign-ins and any failed tries. They are kept apart from the blocked attempts so they never look like attacks.</p>`)}
        </div>
      </div>`;
    // ---- check your setup ----
    const okRow = (t, d) => `<div class="prow"><span class="pdot ok"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
    const warnRow = (t, d) => `<div class="prow"><span class="pdot warn"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
    const isPrivateIp = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|fc|fd|fe80)/i.test(ip) || ip === '';
    const nodeMajor = Number(String(chk.node).replace(/^v/, '').split('.')[0]) || 0;
    const proxyRow = (() => {
      const seen = esc(chk.ip_seen || 'unknown'), tp = chk.trust_proxy;
      if (chk.cf_connecting_ip && chk.cf_connecting_ip !== chk.ip_seen) return warnRow('Visitor addresses may be wrong', `You are connecting through Cloudflare. Your real address is ${esc(chk.cf_connecting_ip)} but Outpost sees ${seen}. The proxy setting needs a small change. Tell Claude and we will check it together.`);
      if (chk.hosted && !tp) return warnRow('Visitor addresses are not set up', `Outpost sees ${seen}. Behind a host like Render every visitor would look like the same one, so limits would hit everyone at once. Set TRUST_PROXY (a number such as 1).`);
      if (chk.hosted && isPrivateIp(chk.ip_seen)) return warnRow('Visitor addresses look wrong', `Outpost sees ${seen}, which is a private address and not yours. Tell Claude and we will check the proxy setting together.`);
      if (!chk.hosted) return okRow('Visitor addresses', `Outpost sees you as ${seen}. Running on your own computer, nothing to set.`);
      return okRow('Visitor addresses', `Outpost sees you as ${seen} (proxy setting: ${esc(tp)}). If that is your own address, it is right.`);
    })();
    $('#setup').innerHTML =
      proxyRow +
      (!chk.password ? okRow('Password', 'Long enough and not a common one.') : chk.password.level === 'hard' ? warnRow('Password is weak', `Your password is ${esc(chk.password.why)}. Change ADMIN_PASSWORD in your hosting settings to something long and private.`) : warnRow('Password could be stronger', `Your password is ${esc(chk.password.why)}. Twelve or more characters is best.`)) +
      (chk.https ? okRow('Web address', `${esc(chk.base_url)} is https, and browsers are told to always use the secure version.`) : warnRow('Web address is not https', `BASE_URL is ${esc(chk.base_url)}. ${chk.hosted ? 'For a live shop set BASE_URL to your https address.' : 'Fine on your own computer.'}`)) +
      (chk.captcha ? okRow('Human check (captcha)', 'On. It is the strongest protection against bots filling your lists and checkouts.') : warnRow('Human check (captcha) is off', 'It is free and is the real protection against bots filling your email list and checkouts. See “Turn on the human check” in the README.')) +
      (chk.two_step ? okRow('Two-step sign-in', 'On.') : warnRow('Two-step sign-in is off', 'Turn it on above so a stolen password alone can’t get in.')) +
      (nodeMajor >= 22 ? okRow('Node version', `${esc(chk.node)}.`) : warnRow('Node version is old', `Running ${esc(chk.node)}. This app is tested on version 22 or newer.`));
    // ---- two-step sign-in ----
    let tfaOn = !!st.two_step, tfaLeft = st.recovery_left || 0, pw0 = '';
    const paintTfa = (extra = '') => {
      paintSign();
      $('#tfabox').innerHTML = tfaOn
        ? `<p class="small" style="margin:0 0 10px">Two-step sign-in is <b>on</b>. After your password you type a code from your phone. You have <b>${tfaLeft}</b> recovery code${tfaLeft === 1 ? '' : 's'} left.</p>${extra}
           <details><summary class="small" style="cursor:pointer">Turn it off</summary><div style="margin-top:10px"><label class="field"><span class="label">Password</span><input class="input" id="tfpw" type="password" autocomplete="current-password"></label><label class="field"><span class="label">Current 6-digit code</span><input class="input" id="tfcd" inputmode="numeric" maxlength="7"></label><button class="btn btn-sm" id="tfoff">Turn off two-step sign-in</button><div id="tfmsg"></div></div></details>`
        : `<p class="small" style="margin:0 0 10px">After your password, you’ll type a 6-digit code from an app on your phone (Google Authenticator, Authy, 1Password…). Even if someone learns your password, they can’t get in without your phone. It works offline and needs no account.</p>${extra}<label class="field"><span class="label">Your password</span><input class="input" id="tfpw0" type="password" autocomplete="current-password"></label><button class="btn btn-primary" id="tfstart">Set up two-step sign-in</button><div id="tfmsg"></div>`;
      if ($('#tfstart')) $('#tfstart').onclick = async () => {
        try {
          pw0 = $('#tfpw0').value; const d = await post('/api/admin/2fa/start', { password: pw0 });
          $('#tfabox').innerHTML = `<div class="row" style="align-items:flex-start;flex-wrap:wrap;gap:18px"><img src="${esc(d.qr)}" alt="Scan this with your authenticator app" width="150" height="150" style="border-radius:12px;background:#fff">
            <div style="flex:1 1 240px"><div class="label">1. Scan the picture with your authenticator app</div><div class="hint" style="margin:0 0 12px">Can’t scan? Type this key instead: <b style="font-family:ui-monospace,monospace">${esc(d.secret.replace(/(.{4})/g, '$1 ').trim())}</b></div>
            <label class="field" style="margin:0"><span class="label">2. Type the code it shows</span><div class="row"><input class="input" id="tfcode" inputmode="numeric" maxlength="7" placeholder="123456"><button class="btn btn-primary" id="tfon">Turn on</button></div></label><div id="tfmsg"></div></div></div>`;
          $('#tfon').onclick = async () => {
            try {
              const r = await post('/api/admin/2fa/enable', { password: pw0, code: $('#tfcode').value }); pw0 = '';
              tfaOn = true; tfaLeft = r.recovery_codes.length;
              paintTfa(`<div class="msg" style="margin-bottom:12px"><b>Save your recovery codes now.</b> They’re the only way in if you lose your phone, and they’re shown just once. Each works one time.</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px;margin-bottom:12px">${r.recovery_codes.map((c) => `<div class="input" style="text-align:center;font-family:ui-monospace,monospace">${esc(c)}</div>`).join('')}</div>
                <div class="row" style="gap:8px;margin-bottom:14px"><button class="btn btn-sm" id="rccopy">Copy</button><button class="btn btn-sm" id="rcdl">Download</button></div>`);
              const text = r.recovery_codes.join('\n');
              $('#rccopy').onclick = async () => { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy. Use Download instead.'); } };
              $('#rcdl').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`Outpost recovery codes. Each works once.\n\n${text}\n`], { type: 'text/plain' })); a.download = 'outpost-recovery-codes.txt'; a.click(); URL.revokeObjectURL(a.href); };
            } catch (e) { $('#tfmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
          };
        } catch (e) { $('#tfmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
      if ($('#tfoff')) $('#tfoff').onclick = async () => {
        try { await post('/api/admin/2fa/disable', { password: $('#tfpw').value, code: $('#tfcd').value }); tfaOn = false; paintTfa('<div class="msg">Two-step sign-in is off.</div>'); }
        catch (e) { $('#tfmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
    };
    // ---- sign out everywhere (asks for your password, and a fresh code if two-step is on) ----
    const paintSign = () => {
      $('#sabox').innerHTML = `<div style="flex:1"><b>Sign out everywhere</b><div class="hint">Ends every sign-in on every device, including this one. Type your password${tfaOn ? ' and a new code from your phone' : ''} to confirm.</div>
        <div class="row" style="flex-wrap:wrap;margin-top:8px"><input class="input" id="sapw" type="password" placeholder="Your password" autocomplete="current-password" style="flex:1;min-width:150px">${tfaOn ? '<input class="input" id="sacd" inputmode="numeric" maxlength="7" placeholder="6-digit code" style="width:130px">' : ''}<button class="btn btn-sm" id="signall">Sign out everywhere</button></div><div id="samsg"></div></div>`;
      $('#signall').onclick = async () => {
        try { await post('/api/admin/logout-all', { password: $('#sapw').value, code: tfaOn ? $('#sacd').value : undefined }); }
        catch (e) { $('#samsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; return; }
        store.del('outpost_token'); token = ''; loginScreen('Signed out everywhere');
      };
    };
    paintTfa();
    // --- protection ---
    let sdata = sec;
    // Blocked attempts: newest first, 25 more at a time, filtered by kind. Staff sign-ins sit in their own box.
    const evState = { group: 'all', list: sec.attempts || [], more: (sec.attempts || []).length >= 25, busy: false };
    const evRow = (ev) => `<div class="ev"><b>${esc(evLabel(ev.kind))}</b><span class="small muted">${esc(new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${ev.ip ? ' · ' + esc(ev.ip) : ''}</span>${ev.detail ? `<div class="small muted">${esc(String(ev.detail).slice(0, 120))}</div>` : ''}</div>`;
    const evPaint = () => {
      $('#sevents').innerHTML = evState.list.length ? `<div class="evs">${evState.list.map(evRow).join('')}</div>` : '<div class="muted small">Nothing suspicious so far.</div>';
      $('#evmore').hidden = !evState.more;
      document.querySelectorAll('#evf [data-g]').forEach((b) => b.classList.toggle('btn-primary', b.dataset.g === evState.group));
      $('#evfoot').textContent = `Showing ${evState.list.length}. Entries are kept up to 90 days. The download has everything, staff sign-ins included.`;
      $('#staffev').innerHTML = (sdata.staff || []).length ? `<div class="evs">${sdata.staff.map(evRow).join('')}</div>` : '<div class="muted small">No sign-ins yet.</div>';
    };
    const evLoad = async (group, more) => {
      if (evState.busy) return; evState.busy = true;
      try {
        const last = more && evState.list.length ? evState.list[evState.list.length - 1].id : 0;
        const d = await api('/api/admin/security/events?group=' + encodeURIComponent(group) + (last ? '&before=' + last : ''));
        evState.group = group; evState.list = more ? evState.list.concat(d.events) : d.events; evState.more = d.more;
        evPaint();
      } catch (err) { $('#bmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
      finally { evState.busy = false; }
    };
    const sPaint = () => {
      const on = (t, d) => `<div class="prow"><span class="pdot ok"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
      const off = (t, d) => `<div class="prow"><span class="pdot warn"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
      $('#prot').innerHTML =
        on('Hidden-field trap and speed check', 'Bots that fill in invisible fields or submit in under a couple of seconds are turned away.') +
        on('Rate limits', 'Each visitor can only try checkout, sign-up and bidding so many times per minute and hour, and the whole shop has a daily ceiling.') +
        on('Throwaway email blocking', 'Sign-ups from disposable email services are refused.') +
        (Number(settings.max_qty) > 0 ? on('Order size limit', `No more than ${settings.max_qty} of one item per order. Unpaid orders never hold your stock.`) : off('Order size limit is off', 'Set “Max per item, per order” in Your shop to stop bulk buying.')) +
        `<p class="small" style="margin-top:10px"><b>${sdata.last_24h}</b> suspicious attempt${sdata.last_24h === 1 ? '' : 's'} turned away in the last 24 hours.</p>
         <p class="hint">Also turn on Radar in your Stripe dashboard (Settings → Radar). It screens stolen cards for you.</p>`;
      $('#blist').innerHTML = sdata.blocks.length ? sdata.blocks.map((b) => `<div class="drow"><div><b>${esc(b.value)}</b> <span class="badge">${b.kind === 'ip' ? 'IP' : 'Email'}</span>${b.note ? `<div class="small muted">${esc(b.note)}</div>` : ''}</div><button class="btn btn-sm" data-bx="${b.id}">Unblock</button></div>`).join('') : '<div class="muted small">Nobody is blocked.</div>';
      evPaint();
    };
    sPaint();
    document.querySelectorAll('#evf [data-g]').forEach((b) => { b.onclick = () => evLoad(b.dataset.g, false); });
    $('#evmore').onclick = () => evLoad(evState.group, true);
    $('#evcsv').onclick = () => download('/api/admin/security/log.csv', 'outpost-security-log.csv').catch((e) => { $('#bmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; });
    $('#bkind').onchange = () => { $('#bval').placeholder = $('#bkind').value === 'ip' ? '203.0.113.7' : 'someone@example.com'; };
    $('#badd').onclick = async () => {
      try { await post('/api/admin/blocks', { kind: $('#bkind').value, value: $('#bval').value }); $('#bval').value = ''; sdata = await api('/api/admin/security'); sPaint(); $('#bmsg').innerHTML = ''; }
      catch (e) { $('#bmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#blist').onclick = async (e) => {
      const b = e.target.closest('[data-bx]'); if (!b) return;
      try { await api('/api/admin/blocks/' + b.dataset.bx, { method: 'DELETE' }); sdata = await api('/api/admin/security'); sPaint(); } catch (err) { $('#bmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
  }

  // ---------- boot ----------
  async function init() {
    try { settings = await (await fetch('/api/settings')).json(); } catch { /* use defaults */ }
    if (!token) return loginScreen();
    try { await api('/api/admin/status'); }
    catch (e) { store.del('outpost_token'); token = ''; return loginScreen(e.status === 401 ? '' : e.message); }
    shell();
    route();
  }
  window.addEventListener('hashchange', route);
  init();
})();

// phones: tables turn into stacked cards, so each cell needs its column name
new MutationObserver(() => {
  document.querySelectorAll('.tbl-scroll table').forEach((t) => {
    const heads = [...t.querySelectorAll('thead th')].map((h) => h.textContent.trim());
    t.querySelectorAll('tbody tr').forEach((r) => r.querySelectorAll('td').forEach((td, i) => { if (heads[i] && td.dataset.label !== heads[i]) td.dataset.label = heads[i]; }));
  });
}).observe(document.body, { childList: true, subtree: true });
