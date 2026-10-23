/* Outpost — staff app (register, products, auctions, orders, settings) */
(() => {
  'use strict';

  // ---------- helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const dollars = (c) => (c / 100).toFixed(2);
  const toCents = (s) => { const n = parseFloat(String(s).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
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

  const ICONS = {
    sell: '<path d="M6 7h12l-1 12H7L6 7z"/><path d="M9 7a3 3 0 0 1 6 0"/>',
    auctions: '<path d="M13 4l7 7-3 3-7-7z"/><path d="M10 7L5 12l3 3 5-5"/><path d="M4 20h9"/><path d="M8 15l-3 3"/>',
    shop: '<path d="M4 9l1.5-5h13L20 9"/><path d="M4 9a2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0 2.5 2.5 0 0 0 5 0"/><path d="M5 12v8h14v-8"/>',
    products: '<path d="M4 8l8-4 8 4v8l-8 4-8-4V8z"/><path d="M4 8l8 4 8-4M12 12v8"/>',
    orders: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V4h6v1M9 11h6M9 15h4"/>',
    settings: '<path d="M5 7h14M5 12h14M5 17h14"/><circle cx="9" cy="7" r="2" fill="var(--cream-2)"/><circle cx="15" cy="12" r="2" fill="var(--cream-2)"/><circle cx="8" cy="17" r="2" fill="var(--cream-2)"/>',
    search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
    customers: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19c.5-3.5 3-5 5.5-5s5 1.5 5.5 5"/><path d="M16 5.5a3 3 0 0 1 0 5.5M18 14.5c1.7.6 2.6 2 2.9 4.5"/>',
    reports: '<path d="M5 20V10M10 20V5M15 20v-8M20 20V8"/>',
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
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[n]}</svg>`;

  let token = store.get('outpost_token') || '';
  let settings = { store_name: 'Outpost', tax_rate: 0, break_on: false, break_message: '', theme: {}, logo_url: '', mascot_url: '', sold_url: '' };
  const DEFAULT_AWAY = 'Back soon! You can still look around in the meantime.';
  let appReady = false;
  let cleanups = [];
  const onLeave = (fn) => cleanups.push(fn);

  async function api(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'x-admin-token': token, ...(opts.headers || {}) } });
    const d = await r.json().catch(() => ({}));
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

  const pic = (url, name, cls = 'thumb') => url
    ? `<img class="${cls}" src="${esc(url)}" alt="">`
    : `<div class="${cls} ph">${esc((name || '?').trim().charAt(0).toUpperCase())}</div>`;

  const view = () => $('#view');

  // ---------- login ----------
  function loginScreen(msg) {
    appReady = false;
    document.body.innerHTML = `
      <div class="login-wrap"><div class="login card">
        <span class="wordmark" data-brand="name">Outpost</span>
        <p class="muted">Sign in to your shop</p>
        <input class="input" id="pw" type="password" placeholder="Password" autocomplete="current-password">
        <button class="btn btn-primary btn-block mt" id="go">Sign in</button>
        <div id="lerr">${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}</div>
      </div></div>`;
    paintBrand();
    const go = async () => {
      token = $('#pw').value;
      try { await api('/api/admin/status'); store.set('outpost_token', token); init(); }
      catch (e) { token = ''; $('#lerr').innerHTML = `<div class="msg err">${esc(e.status === 401 ? "That password didn't work" : e.message)}</div>`; }
    };
    $('#go').onclick = go;
    $('#pw').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    $('#pw').focus();
  }

  // ---------- shell + router ----------
  const NAV = [['sell', 'Sell', '#/sell'], ['auctions', 'Auctions', '#/auctions'], ['products', 'Products', '#/products'], ['orders', 'Orders', '#/orders'], ['customers', 'Customers', '#/customers'], ['reviews', 'Reviews', '#/reviews'], ['reports', 'Reports', '#/reports'], ['settings', 'Settings', '#/settings']];

  function paintResting() { const el = document.getElementById('resting'); if (el) el.hidden = !settings.break_on; }
  function paintBrand() { if (window.OutpostBrand) OutpostBrand.apply(settings); paintResting(); }

  function shell() {
    document.body.innerHTML = `
      <div class="app">
        <aside class="side">
          <a class="wordmark" href="#/sell" data-brand="name">Outpost</a>
          <nav class="nav">${NAV.map(([k, label, href]) => `<a href="${href}" data-k="${k}">${icon(k)}<span>${label}</span></a>`).join('')}<a class="ext" href="store.html" target="_blank" rel="noopener" title="Opens your shop the way shoppers see it">${icon('shop')}<span>View shop</span></a></nav>
          <div class="side-foot">
            <a class="resting-pill" id="resting" href="#/settings" hidden>Online shop is resting</a>
            <img class="side-art" data-brand="mascot" alt="" hidden>
            <button class="btn btn-ghost btn-sm btn-block" id="signout">Sign out</button>
          </div>
        </aside>
        <main class="main" id="view"></main>
      </div>`;
    $('#signout').onclick = () => { store.del('outpost_token'); token = ''; loginScreen(); };
    paintBrand();
    appReady = true;
  }

  const routes = [
    [/^#\/sell$/, viewSell, 'sell'], [/^#\/products$/, viewProducts, 'products'],
    [/^#\/products\/(new|\d+)$/, viewEditor, 'products'], [/^#\/auctions$/, viewAuctions, 'auctions'],
    [/^#\/auctions\/new$/, viewNewAuction, 'auctions'], [/^#\/orders$/, viewOrders, 'orders'],
    [/^#\/customers$/, viewCustomers, 'customers'], [/^#\/reports$/, viewReports, 'reports'], [/^#\/reviews$/, viewReviews, 'reviews'],
    [/^#\/settings$/, viewSettings, 'settings'],
  ];

  async function route() {
    if (!appReady) return;
    paintBrand();
    cleanups.forEach((f) => { try { f(); } catch { /* ignore */ } });
    cleanups = [];
    const h = location.hash || '#/sell';
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
      <div class="topbar"><h1>Sell</h1><div class="spacer"></div><div class="muted small" id="clock"></div></div>
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

    for (const method of ['cash', 'other']) {
      $('#' + method).onclick = async () => {
        try { const r = await post('/api/register/sale', body(method)); saleComplete({ id: r.orderId, public_token: r.public_token, total_cents: r.total_cents }); }
        catch (e) { flash(e.message); }
      };
    }
    $('#card').onclick = async () => {
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
            const s = await (await fetch('/api/order-status/' + r.orderId)).json();
            if (s.status === 'paid') { stop(); m.close(); saleComplete(await api('/api/admin/orders/' + r.orderId)); }
            else if (s.status === 'canceled') { stop(); const w = $('#wait', m.el); if (w) w.textContent = 'That payment page expired. Cancel and try again.'; }
          } catch { /* keep polling */ }
        }, 2000);
      } catch (e) { flash(e.message); }
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
            <a class="btn" id="rcpt" target="_blank" rel="noopener" href="/receipt.html?order=${order.id}&k=${esc(order.public_token)}">View Receipt</a></div>
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
  const csvCell = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };

  async function viewProducts() {
    let list = await api('/api/admin/products');
    const picked = new Set();
    const low = () => Number(settings.low_stock) || 0;
    view().innerHTML = `
      <div class="topbar"><h1>Products</h1><div class="spacer"></div>
        <button class="btn" id="imp">Import CSV</button><button class="btn" id="exp">Export CSV</button>
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
        else if (w === 'stock_add' || w === 'price_percent') { if (v.trim() === '' || !Number.isFinite(Number(v))) return ($('#pmsg').innerHTML = '<div class="msg err">Enter a number</div>'); set[w] = Number(v); }
        else set[w] = v;
        if (w === 'price_percent' && !confirm(`Change the price of ${picked.size} product${picked.size === 1 ? '' : 's'} by ${v}%?`)) return;
        try { const r = await post('/api/admin/products/bulk', { ids: [...picked], set }); toast(r.skipped_stock ? `Updated ${r.updated}. ${r.skipped_stock} with options were skipped for stock (edit those one by one).` : `Updated ${r.updated}`); picked.clear(); list = await api('/api/admin/products'); $('#pmsg').innerHTML = ''; paint(); }
        catch (e) { $('#pmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
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
          const res = await post('/api/admin/products/import', { rows: data });
          list = await api('/api/admin/products'); paint();
          $('#imsg', m.el).innerHTML = `<div class="msg">Added ${res.created}, updated ${res.updated}.</div>` + (res.errors.length ? `<div class="msg err">${res.errors.slice(0, 6).map((x) => `Row ${x.row + 1}: ${esc(x.error)}`).join('<br>')}${res.errors.length > 6 ? `<br>and ${res.errors.length - 6} more` : ''}</div>` : '');
        } catch (e) { $('#imsg', m.el).innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
      };
    };
    $('#pq').oninput = paint; paint();
  }

  async function viewEditor(m) {
    const isNew = m[1] === 'new';
    const [existing, all] = await Promise.all([isNew ? null : api('/api/admin/products/' + m[1]), api('/api/admin/products')]);
    const cats = [...new Set(all.map((p) => p.category).filter(Boolean))];
    const s = existing
      ? { name: existing.name, price: dollars(existing.price_cents), category: existing.category, description: existing.description, active: !!existing.active, badge: existing.badge || '', process: existing.process || '', sku: existing.sku || '', option_label: existing.option_label || '', custom_fields: (existing.custom_fields || []).map((f) => ({ label: f.label, required: !!f.required })), variants: existing.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku || '', price: v.own_price ? dollars(v.price_cents) : '', stock: String(v.stock) })), stock: String(existing.stock), tags: [...existing.tags], images: [...existing.images] }
      : { name: '', price: '', category: '', description: '', active: true, badge: '', process: '', sku: '', option_label: '', custom_fields: [], variants: [], stock: '1', tags: [], images: [] };

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
      if (!Number.isInteger(price_cents) || price_cents < 0) return ($('#emsg').innerHTML = '<div class="msg err">Please enter a price like 12.50</div>');
      if (!Number.isInteger(stock) || stock < 0) return ($('#emsg').innerHTML = '<div class="msg err">Quantity must be a whole number</div>');
      for (const [i, v] of s.variants.entries()) {
        if (!v.name.trim()) return ($('#emsg').innerHTML = `<div class="msg err">Option ${i + 1} needs a name</div>`);
        if (v.price.trim() !== '' && !(toCents(v.price) >= 0)) return ($('#emsg').innerHTML = `<div class="msg err">“${esc(v.name)}” has a price that isn’t a number</div>`);
        if (!/^\d*$/.test(String(v.stock).trim())) return ($('#emsg').innerHTML = `<div class="msg err">Stock for “${esc(v.name)}” must be a whole number</div>`);
      }
      for (const [i, f] of s.custom_fields.entries()) if (!f.label.trim()) return ($('#emsg').innerHTML = `<div class="msg err">Question ${i + 1} for the buyer needs a label, like “Name to engrave”</div>`);
      const variants = s.variants.map((v) => ({ id: v.id || undefined, name: v.name.trim(), sku: v.sku.trim(), price_cents: v.price.trim() === '' ? null : toCents(v.price), stock: parseInt(v.stock, 10) || 0 }));
      const payload = { name: $('#name').value.trim(), price_cents, stock, sku: $('#sku').value.trim(), option_label: $('#optlabel').value.trim(), custom_fields: s.custom_fields.map((f) => ({ label: f.label.trim(), required: !!f.required })), variants, description: $('#desc').value, category: $('#category').value.trim(), badge: $('#badge').value, process: $('#proc').value, tags: s.tags, images: s.images, active: $('#active').value === '1' };
      $('#save').disabled = true;
      try { isNew ? await post('/api/admin/products', payload) : await put('/api/admin/products/' + m[1], payload); toast('Saved'); location.hash = '#/products'; }
      catch (e) { $('#emsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; $('#save').disabled = false; }
    };
    paintImgs(); paintTags(); paintVars(); paintCfs();
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
      if (a.phase === 'paid') act.push(`<a class="btn btn-sm" target="_blank" rel="noopener" href="/receipt.html?order=${a.order.id}&k=${esc(a.order.public_token)}">Receipt</a>`);
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
          if (!confirm(`Block ${em}? They won’t be able to bid or check out, and their bids on open lots come off the board.`)) return;
          await post('/api/admin/blocks', { kind: 'email', value: em, note: 'Blocked from a bid list' }); toast('Blocked'); return load();
        }
        if (act === 'bids') { open.has(id) ? open.delete(id) : open.add(id); return paint(); }
        if (act === 'copy') {
          try { await navigator.clipboard.writeText(a.pay_url); toast('Payment link copied'); } catch { prompt('Copy this payment link:', a.pay_url); }
          return;
        }
        if (act === 'end' && confirm('End this lot now? The highest bidder wins.')) await post(`/api/admin/auctions/${id}/end`);
        else if (act === 'cancel' && confirm('Cancel this lot? Bidders will no longer see it.')) await post(`/api/admin/auctions/${id}/cancel`);
        else if (act === 'next' && confirm(`Remove ${a.winner_full.name}'s bid and offer this lot to the next-highest bidder?`)) await post(`/api/admin/auctions/${id}/next-bidder`);
        else if (act === 'void' && confirm('Remove this bid?')) await post(`/api/admin/bids/${id}/void`);
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
    let filter = 'all';
    view().innerHTML = `<div class="topbar"><h1>Orders</h1><div class="spacer"></div><button class="btn" id="ocsv">Export CSV</button></div><div id="omsg"></div>
      <div class="chips" id="ofil"></div>
      <div class="card tbl-scroll"><table><thead><tr><th>#</th><th>When</th><th>Where</th><th>Paid by</th><th>Status</th><th>Total</th><th>Items</th><th>Customer</th><th></th></tr></thead><tbody id="orows"></tbody></table></div>`;
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
        <td><span class="badge ${stat[o.status] || ''}">${esc(o.status)}</span>${o.refunded_cents > 0 && o.status !== 'refunded' ? `<br><span class="badge b-pending">Part refunded</span>` : ''}${o.late ? `<br><span class="badge b-out">Running late</span>` : ''}${o.review_rating ? `<br><span class="small" title="Verified review">${'★'.repeat(o.review_rating)}</span>` : ''}${['online', 'auction'].includes(o.channel) && ['paid', 'refunded'].includes(o.status) && o.fulfillment ? `<br><span class="badge b-info">${FUL[o.fulfillment]}</span>` : ''}</td>
        <td><b>${fmt(o.total_cents)}</b>${o.refunded_cents > 0 ? `<br><span class="small muted">−${fmt(o.refunded_cents)} refunded</span>` : ''}</td>
        <td class="small">${o.items.map((i) => `${i.quantity}× ${esc(i.name)}${(i.custom || []).map((c) => `<br><b>${esc(c.label)}:</b> ${esc(c.value)}`).join('')}`).join('<br>')}</td>
        <td class="small">${esc(o.customer_email || '')}${ship(o) ? `<br><span class="muted">${esc(ship(o))}</span>` : ''}</td>
        <td>${['paid', 'refunded'].includes(o.status) ? `<button class="btn btn-sm" data-manage="${o.id}">Manage</button>` : ''}
            ${o.status === 'pending' && o.channel !== 'auction' ? `<button class="btn btn-sm btn-danger" data-cancel="${o.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="9" class="empty">No orders here.</td></tr>';
    };
    const reload = async () => { orders = await api('/api/admin/orders'); paint(); };
    $('#ofil').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { filter = b.dataset.f; paint(); } };
    $('#ocsv').onclick = () => download('/api/admin/orders.csv', 'outpost-orders.csv').catch((e) => toast(e.message));
    $('#orows').onclick = async (e) => {
      const mg = e.target.closest('[data-manage]');
      if (mg) return manageOrder(orders.find((o) => o.id === Number(mg.dataset.manage)), reload);
      const b = e.target.closest('[data-cancel]'); if (!b || !confirm('Cancel this unpaid order?')) return;
      try { await post(`/api/admin/orders/${b.dataset.cancel}/cancel`); await reload(); }
      catch (err) { $('#omsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
    paint();
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
        <div class="hint">Outpost doesn’t send emails by itself. “Email buyer” opens a ready-written message in your email app.</div>
        <div id="fmsg"></div></div>` : ''}
      <div class="mgbox"><div class="label">Refund</div>
        ${o.refunded_cents > 0 ? `<div class="small" style="margin-bottom:8px">Already refunded ${fmt(o.refunded_cents)}${o.refund_note ? ` · “${esc(o.refund_note)}”` : ''}.</div>` : ''}
        ${left > 0 && o.status === 'paid' ? `<div class="grid2"><label class="field"><span class="label">Amount (up to ${fmt(left)})</span><input class="input" id="ramt" inputmode="decimal" value="${dollars(left)}"></label>
          <label class="field"><span class="label">Note (optional)</span><input class="input" id="rnote" maxlength="300" placeholder="Damaged in the mail"></label></div>
          <label class="check"><input type="checkbox" id="rstock"> <span>Put the items back in stock</span></label>
          ${o.payment_method === 'card' ? '<label class="check"><input type="checkbox" id="ralready"> <span>I already refunded this in Stripe</span></label>' : '<div class="hint">This was a cash/other sale, so Outpost records the refund and you hand the money back yourself.</div>'}
          <button class="btn btn-danger" id="rgo">Refund</button>` : '<div class="muted small">Nothing left to refund.</div>'}
        <div id="rmsg"></div></div>
      <a class="btn btn-ghost btn-block mt" target="_blank" rel="noopener" href="/receipt.html?order=${o.id}&k=${esc(o.public_token || '')}">Open receipt</a>
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
        window.open(url, '_blank');
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
        const link = `${location.origin}/receipt.html?order=${o.id}&k=${o.public_token}`;
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
      if (!confirm(`Refund ${fmt(cents)} on order #${o.id}?${o.payment_method === 'card' && !already ? ' This sends the money back to the buyer’s card through Stripe.' : ''}`)) return;
      q('#rgo').disabled = true;
      try { await post(`/api/admin/orders/${o.id}/refund`, { amount_cents: cents, note: q('#rnote').value, restock: q('#rstock').checked, already_refunded: already }); toast('Refund recorded'); m.close(); done(); }
      catch (e) { q('#rmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; q('#rgo').disabled = false; }
    };
  }

  // =====================================================================
  // CUSTOMERS
  // =====================================================================
  async function viewCustomers() {
    const list = await api('/api/admin/customers');
    view().innerHTML = `<div class="topbar"><h1>Customers</h1></div><div id="cmsg"></div>
      <div class="search">${icon('search')}<input class="input" id="cq" placeholder="Search by name or email…"></div>
      <div class="card tbl-scroll"><table><thead><tr><th>Customer</th><th>Orders</th><th>Spent</th><th>Bids</th><th>Won</th><th>Last order</th><th></th></tr></thead><tbody id="crows"></tbody></table></div>
      <p class="hint">Built from your paid orders and auction bidders. Nothing is shared with anyone.</p>`;
    const paint = () => {
      const n = $('#cq').value.trim().toLowerCase();
      const rows = list.filter((c) => !n || (c.name + ' ' + c.email).toLowerCase().includes(n));
      $('#crows').innerHTML = rows.map((c) => `<tr><td><b>${esc(c.name || '—')}</b><br><span class="small muted">${esc(c.email)}</span></td>
        <td>${c.orders}</td><td><b>${fmt(c.spent_cents)}</b></td><td>${c.bids}</td><td>${c.won}</td>
        <td class="small">${c.last_order ? esc(new Date(c.last_order.replace(' ', 'T') + 'Z').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })) : '—'}</td>
        <td><a class="btn btn-sm" href="mailto:${esc(c.email)}">Email</a> <button class="btn btn-sm btn-ghost" data-block="${esc(c.email)}">Block</button></td></tr>`).join('') ||
        `<tr><td colspan="7" class="empty">${list.length ? 'No matches' : 'No customers yet.'}</td></tr>`;
    };
    $('#cq').oninput = paint;
    $('#crows').onclick = async (e) => {
      const b = e.target.closest('[data-block]'); if (!b) return;
      if (!confirm(`Block ${b.dataset.block}? They won’t be able to check out or bid, and any bids they have on open lots come off the board.`)) return;
      try { await post('/api/admin/blocks', { kind: 'email', value: b.dataset.block, note: 'Blocked from Customers' }); toast('Blocked'); }
      catch (err) { $('#cmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };
    paint();
  }

  // =====================================================================
  // REVIEWS
  // =====================================================================
  async function viewReviews() {
    let list = await api('/api/admin/reviews');
    view().innerHTML = `<div class="topbar"><h1>Reviews</h1></div><div id="rvmsg"></div><div id="rvlist"></div>
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
          const m = openModal(`<div style="text-align:left"><h2>Hide this review?</h2><p class="muted small">Only for abuse, spam, or things that aren’t true. Shoppers will see “${'1'} review hidden by the seller” in your shop. Write a short reason for your own records.</p>
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
          <div class="card"><h2 style="font-size:20px;margin-bottom:8px">Where sales come from</h2>
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

  const EVENT_LABELS = { honeypot: 'Hidden-field trap tripped', too_fast: 'Submitted too fast', captcha_failed: 'Failed the human check', checkout_rate: 'Too many checkouts', signup_rate: 'Too many sign-ups', bid_rate: 'Too many bids', blocked_email: 'Blocked email tried to join', blocked_ip: 'Blocked address tried to visit', blocked_bid: 'Blocked person tried to bid', flood: 'Traffic flood', disposable_email: 'Throwaway email', email_reuse: 'Same email used under many names', code_guessing: 'Guessing discount codes' };
  const evLabel = (k) => EVENT_LABELS[k] || String(k).replace(/_/g, ' ');

  async function viewSettings() {
    const [st, cur, discounts, sec] = await Promise.all([api('/api/admin/status'), fetch('/api/settings').then((r) => r.json()), api('/api/admin/discounts'), api('/api/admin/security')]);
    settings = cur;
    const base = st.base_url;
    const rp = cur.refund_policy || { preset: '', days: 14, custom: '', text: '' };
    const card = (title, inner) => `<div class="card"><h2 style="font-size:22px;margin-bottom:14px">${title}</h2>${inner}</div>`;
    view().innerHTML = `
      <div class="topbar"><h1>Settings</h1></div>
      <div class="settings-col">
        <div style="display:grid;gap:18px;min-width:0">
          ${card('Your shop', `
            <label class="field"><span class="label">Shop name (shown on receipts)</span><input class="input" id="sname" value="${esc(cur.store_name)}"></label>
            <label class="field"><span class="label">Sales tax rate (%)</span><input class="input" id="srate" inputmode="decimal" value="${esc(cur.tax_rate)}">
              <div class="hint">Added to register sales, online orders and auction wins. Use 0 for no tax. Check your local rules.</div></label>
            <div class="grid2">
              <label class="field"><span class="label">Low-stock alert at</span><input class="input" id="slow" inputmode="numeric" value="${esc(cur.low_stock)}"><div class="hint">Shows “Low” on Products and Reports.</div></label>
              <label class="field"><span class="label">Max per item, per order</span><input class="input" id="sqty" inputmode="numeric" value="${esc(cur.max_qty)}"><div class="hint">Stops bulk buying. 0 means no limit.</div></label>
            </div>
            <h3 style="font-size:18px;margin:18px 0 4px">Away from the outpost</h3>
            <label class="check"><input type="checkbox" id="sbreak" ${cur.break_manual ? 'checked' : ''}> <span>Pause sales</span></label>
            <label class="field" style="margin-top:10px"><span class="label">Message for visitors</span><textarea class="input" id="sbmsg" rows="2" maxlength="200" placeholder="${esc(DEFAULT_AWAY)}">${esc(cur.break_message === DEFAULT_AWAY ? '' : cur.break_message)}</textarea></label>
            <div class="grid2">
              <label class="field"><span class="label">Pause starts (optional)</span><input class="input" type="date" id="sfrom" value="${esc(cur.break_from || '')}"></label>
              <label class="field"><span class="label">Back on (optional)</span><input class="input" type="date" id="suntil" value="${esc(cur.break_until || '')}"></label>
            </div>
            <div class="hint">While sales are paused, visitors can look around but can't check out. Fill in dates to schedule it, and your “back on” date shows in the shop. Your register still works, and auctions already running keep going.</div>
            <button class="btn btn-primary mt" id="ssave">Save settings</button><div id="smsg"></div>`)}
          ${card('About your shop', `
            <label class="field"><span class="label">Tell shoppers about yourself and your shop</span><textarea class="input" id="about" rows="6" maxlength="2000" placeholder="Hi, I’m Sam. I make linocut prints and ceramics in a small studio in Portland…">${esc(cur.about_text || '')}</textarea>
              <div class="hint">Shown on an “About” page in your shop’s menu. Leave blank and no About page appears. Use a blank line to start a new paragraph.</div></label>
            <div class="label" style="margin-top:6px">Your links (all optional)</div>
            <div class="hint" style="margin:0 0 8px">Paste the full address from your browser, like https://instagram.com/yourname. Leave any you don’t use empty.</div>
            <div class="sgrid">${[['website', 'Website'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook'], ['youtube', 'YouTube'], ['pinterest', 'Pinterest'], ['bluesky', 'Bluesky'], ['threads', 'Threads'], ['email', 'Public email']].map(([k, l]) => `<label class="field" style="margin:0"><span class="label small">${l}</span><input class="input" data-soc="${k}" ${k === 'email' ? 'type="email"' : 'inputmode="url"'} autocomplete="off" placeholder="${k === 'email' ? 'hello@yourshop.com' : 'https://'}" value="${esc((cur.social || {})[k] || '')}"></label>`).join('')}</div>
            <button class="btn btn-primary mt" id="asave">Save</button><div id="amsg"></div>`)}
          ${card('Trust and reviews', `
            <label class="field"><span class="label">Your “made by hand” statement</span><textarea class="input" id="hand" rows="3" maxlength="600" placeholder="Everything in this shop is designed and made by me, by hand, in my studio. I never use AI-generated images or print-on-demand.">${esc(cur.handmade_statement || '')}</textarea>
              <div class="hint">Shown at the bottom of your shop. It’s your public promise to buyers. Leave it blank to show nothing.</div></label>
            <label class="field"><span class="label">I usually ship within (days)</span><input class="input" id="shipd" inputmode="numeric" value="${esc(cur.ship_days || 0)}">
              <div class="hint">Shown to buyers. Orders still unshipped after this many days are flagged for you. 0 turns it off.</div></label>
            <label class="check"><input type="checkbox" id="revon" ${cur.reviews_on ? 'checked' : ''}> <span>Let verified buyers leave reviews</span></label>
            <div class="hint">Only people with a real paid order can review, once per order, with a “Verified purchase” label. You can reply to any review and hide abusive ones. Shoppers see how many are hidden.</div>
            <button class="btn btn-primary mt" id="tsave">Save</button><div id="tmsg"></div>`)}
          ${card('Refund policy', `
            <label class="field"><span class="label">What is your policy?</span><select class="input" id="rpre">
              ${[['', 'Not set (nothing shown)'], ['final', 'All sales final'], ['days', 'Refunds within a number of days'], ['exchange', 'Exchanges or store credit only'], ['custom', 'Write my own']].map(([k, l]) => `<option value="${k}"${rp.preset === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field" id="rdaysw"><span class="label">Number of days</span><input class="input" id="rdays" inputmode="numeric" value="${esc(rp.days)}"></label>
            <label class="field" id="rtextw"><span class="label">Your policy, in your words</span><textarea class="input" id="rtext" rows="3" maxlength="500">${esc(rp.custom)}</textarea></label>
            <div class="hint">Shown to buyers at checkout and on their receipt. Buyers are never charged a fee by Outpost. You do refunds yourself from Orders → Manage.</div>
            <div class="msg" id="rprev" style="margin-top:8px"></div>
            <button class="btn btn-primary mt" id="rsave">Save policy</button><div id="rmsg"></div>`)}
          ${card('Discount codes', `
            <div id="dlist"></div>
            <div class="label" style="margin-top:14px">New code</div>
            <div class="grid2">
              <label class="field"><span class="label">Code</span><input class="input" id="dcode" placeholder="WELCOME10" maxlength="24"></label>
              <label class="field"><span class="label">Type</span><select class="input" id="dkind"><option value="percent">Percent off</option><option value="amount">Dollars off</option></select></label>
              <label class="field"><span class="label" id="dvl">Percent</span><input class="input" id="dval" inputmode="decimal" placeholder="10"></label>
              <label class="field"><span class="label">Minimum spend (optional)</span><input class="input" id="dmin" inputmode="decimal" placeholder="25.00"></label>
              <label class="field"><span class="label">Max uses (optional)</span><input class="input" id="dmax" inputmode="numeric"></label>
              <label class="field"><span class="label">Starts (optional)</span><input class="input" type="date" id="dstart"></label>
              <label class="field"><span class="label">Last day (optional)</span><input class="input" type="date" id="dexp"></label>
            </div>
            <button class="btn btn-primary" id="dadd">Add code</button><div id="dmsg"></div>`)}
          ${card('Bidding', `
            <label class="check"><input type="checkbox" id="bcard" ${cur.bid_card_manual ? 'checked' : ''} ${cur.stripe_ready ? '' : 'disabled'}> <span>Require a card to bid, and charge the winner automatically</span></label>
            <div class="hint">${cur.stripe_ready ? 'Bidders save a card with Stripe before their first bid. Nothing is charged unless they win. When a lot ends, the winning bid (plus tax) is charged once. If a charge fails, you’ll see why and can send the usual payment link. Winners then add their shipping address from their receipt.' : 'This needs your Stripe keys first, because cards are saved by Stripe. See the setup guide.'}</div>
            <button class="btn btn-primary mt" id="bsave" ${cur.stripe_ready ? '' : 'disabled'}>Save</button><div id="bmsg2"></div>`)}
        </div>
        <div style="display:grid;gap:18px;min-width:0">${lookCard()}
          ${card('Protection from bots and scammers', `
            <div id="prot"></div>
            <h3 style="font-size:18px;margin:18px 0 6px">Blocked people</h3>
            <div class="row" style="flex-wrap:wrap"><select class="input" id="bkind" style="width:auto"><option value="email">Email</option><option value="ip">IP address</option></select>
              <input class="input" id="bval" placeholder="someone@example.com" style="flex:1;min-width:160px"><button class="btn" id="badd">Block</button></div>
            <div id="blist" style="margin-top:8px"></div><div id="bmsg"></div>
            <h3 style="font-size:18px;margin:18px 0 6px">Recent blocked attempts</h3>
            <div id="sevents"></div>`)}
          ${card('Back up your shop', `
            <p class="small">Downloads one file with all your products, orders, reviews and photos. Do this every week or two and keep it somewhere safe, like your computer or a cloud drive.</p>
            <button class="btn btn-primary" id="bkup">Download backup</button><div id="bkmsg"></div>
            <p class="hint">To restore, follow “Restoring a backup” in the guide.</p>`)}
          <div class="card"><h2 style="font-size:22px;margin-bottom:14px">Status</h2>
          <p>Card payments: ${st.stripe ? '<span class="badge b-paid">Connected to Stripe</span>' : '<span class="badge b-pending">Not set up yet</span>'}</p>
          <p>Payment confirmations (webhook): ${st.webhook ? '<span class="badge b-paid">Ready</span>' : '<span class="badge b-pending">Not set up yet</span>'}</p>
          <h3 style="font-size:18px;margin:18px 0 8px">Share these links</h3>
          <p class="small">Shop: <a href="/store.html" target="_blank" rel="noopener">${esc(base)}/store.html</a><br>Auctions: <a href="/auction.html" target="_blank" rel="noopener">${esc(base)}/auction.html</a></p>
          <p class="hint">When you put Outpost online, set BASE_URL in your .env to your real web address so links and payment links work for customers.</p></div>
        </div>
      </div>`;
    wireLook();

    // --- shop + pause ---
    $('#ssave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { store_name: $('#sname').value, tax_rate: $('#srate').value, break_on: $('#sbreak').checked, break_message: $('#sbmsg').value,
          break_from: $('#sfrom').value, break_until: $('#suntil').value, low_stock: $('#slow').value, max_qty: $('#sqty').value });
        settings = { ...settings, ...r };
        paintBrand();
        $('#smsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#smsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    $('#asave').onclick = async () => {
      const social = {}; document.querySelectorAll('[data-soc]').forEach((i) => { social[i.dataset.soc] = i.value.trim(); });
      try {
        const r = await put('/api/admin/settings', { about_text: $('#about').value, social });
        settings = { ...settings, ...r }; $('#amsg').innerHTML = '<div class="msg">Saved. Your About page is in the shop menu.</div>';
        document.querySelectorAll('[data-soc]').forEach((i) => { i.value = (r.social || {})[i.dataset.soc] || ''; });
      } catch (e) { $('#amsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

    // --- trust & reviews ---
    $('#tsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { handmade_statement: $('#hand').value, ship_days: $('#shipd').value, reviews_on: $('#revon').checked });
        settings = { ...settings, ...r }; $('#tmsg').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#tmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#bsave').onclick = async () => {
      try {
        const r = await put('/api/admin/settings', { bid_card_required: $('#bcard').checked });
        settings = { ...settings, ...r }; $('#bmsg2').innerHTML = '<div class="msg">Saved.</div>';
      } catch (e) { $('#bmsg2').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#bkup').onclick = async () => {
      try { await download('/api/admin/backup', 'outpost-backup-' + new Date().toISOString().slice(0, 10) + '.tar.gz'); $('#bkmsg').innerHTML = '<div class="msg">Backup downloaded. Check your Downloads folder.</div>'; }
      catch (e) { $('#bkmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };

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
        const bits = [d.min_subtotal_cents ? `over ${fmt(d.min_subtotal_cents)}` : '', d.max_uses ? `${d.uses}/${d.max_uses} used` : `${d.uses} used`, d.starts_on ? `starts ${d.starts_on}` : '', d.expires_on ? `ends ${d.expires_on}` : ''].filter(Boolean).join(' · ');
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
        await post('/api/admin/discounts', { code: $('#dcode').value, kind, value, min_subtotal_cents: min, max_uses: $('#dmax').value.trim() || null, starts_on: $('#dstart').value || null, expires_on: $('#dexp').value || null });
        dlist = await api('/api/admin/discounts'); dPaint();
        ['dcode', 'dval', 'dmin', 'dmax', 'dstart', 'dexp'].forEach((id) => { $('#' + id).value = ''; });
        $('#dmsg').innerHTML = '<div class="msg">Code added.</div>';
      } catch (e) { $('#dmsg').innerHTML = `<div class="msg err">${esc(e.message)}</div>`; }
    };
    $('#dlist').onclick = async (e) => {
      const t = e.target.closest('[data-dt]'), x = e.target.closest('[data-dx]');
      try {
        if (t) { const d = dlist.find((y) => y.id === Number(t.dataset.dt)); await put('/api/admin/discounts/' + d.id, { active: !d.active }); }
        else if (x && confirm('Delete this code?')) await api('/api/admin/discounts/' + x.dataset.dx, { method: 'DELETE' });
        else return;
        dlist = await api('/api/admin/discounts'); dPaint();
      } catch (err) { $('#dmsg').innerHTML = `<div class="msg err">${esc(err.message)}</div>`; }
    };

    // --- protection ---
    let sdata = sec;
    const sPaint = () => {
      const on = (t, d) => `<div class="prow"><span class="pdot ok"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
      const off = (t, d) => `<div class="prow"><span class="pdot warn"></span><div><b>${t}</b><div class="small muted">${d}</div></div></div>`;
      $('#prot').innerHTML =
        on('Hidden-field trap and speed check', 'Bots that fill in invisible fields or submit in under a couple of seconds are turned away.') +
        on('Rate limits', 'Each visitor can only try checkout, sign-up and bidding so many times per minute and hour, and the whole shop has a daily ceiling.') +
        on('Throwaway email blocking', 'Sign-ups from disposable email services are refused.') +
        (Number(settings.max_qty) > 0 ? on('Order size limit', `No more than ${settings.max_qty} of one item per order. Unpaid orders never hold your stock.`) : off('Order size limit is off', 'Set “Max per item, per order” in Your shop to stop bulk buying.')) +
        (sdata.captcha ? on('Human check (Cloudflare Turnstile)', 'Visitors pass a quick invisible check before checking out or joining to bid.') : off('Human check is not turned on', 'It is free and the strongest protection. See “Turn on the human check” in the README (two keys in your .env file).')) +
        (sdata.trust_proxy ? on('Real visitor addresses', 'Outpost can tell visitors apart behind your host.') : off('Visitor addresses', 'When you put Outpost online behind a host like Render or Fly, set TRUST_PROXY=1 in .env so limits work per person and not for everyone at once.')) +
        `<p class="small" style="margin-top:10px"><b>${sdata.last_24h}</b> suspicious attempt${sdata.last_24h === 1 ? '' : 's'} turned away in the last 24 hours.</p>
         <p class="hint">Also turn on Radar in your Stripe dashboard (Settings → Radar). It screens stolen cards for you.</p>`;
      $('#blist').innerHTML = sdata.blocks.length ? sdata.blocks.map((b) => `<div class="drow"><div><b>${esc(b.value)}</b> <span class="badge">${b.kind === 'ip' ? 'IP' : 'Email'}</span>${b.note ? `<div class="small muted">${esc(b.note)}</div>` : ''}</div><button class="btn btn-sm" data-bx="${b.id}">Unblock</button></div>`).join('') : '<div class="muted small">Nobody is blocked.</div>';
      $('#sevents').innerHTML = sdata.recent.length ? `<div class="evs">${sdata.recent.slice(0, 10).map((ev) => `<div class="ev"><b>${esc(evLabel(ev.kind))}</b><span class="small muted">${esc(new Date(ev.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}${ev.ip ? ' · ' + esc(ev.ip) : ''}</span>${ev.detail ? `<div class="small muted">${esc(String(ev.detail).slice(0, 120))}</div>` : ''}</div>`).join('')}</div>` : '<div class="muted small">Nothing suspicious so far.</div>';
    };
    sPaint();
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
