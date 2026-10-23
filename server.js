require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CURRENCY = (process.env.CURRENCY || 'usd').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
// STRIPE_API_HOST/PORT/PROTOCOL only exist so the automated tests can point at a fake Stripe. Leave them unset.
const stripeOpts = process.env.STRIPE_API_HOST ? { host: process.env.STRIPE_API_HOST, port: process.env.STRIPE_API_PORT, protocol: process.env.STRIPE_API_PROTOCOL || 'http' } : {};
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, stripeOpts) : null;

const SOFT_CLOSE_MS = 2 * 60 * 1000;       // a bid in the last 2 minutes extends the lot by 2 minutes
const MAX_BID_CENTS = 100000000;           // $1,000,000 sanity cap
const MAX_AUCTION_MS = 90 * 24 * 3600 * 1000;

const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(BASE_URL);
const WEAK_PASSWORD = !ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8 || ['change-me', 'changeme', 'password', 'admin', '12345678'].includes(ADMIN_PASSWORD.toLowerCase());
if (WEAK_PASSWORD && !IS_LOCAL) {
  console.error('\nOutpost will not start on the internet with a missing or easy-to-guess ADMIN_PASSWORD.\nSet ADMIN_PASSWORD to something long that only you know (at least 8 characters), then start again.\n');
  process.exit(1);
}
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; admin endpoints are locked.');
else if (WEAK_PASSWORD) console.warn('NOTE: your ADMIN_PASSWORD is easy to guess. That is fine on your own computer, but pick a strong one before putting Outpost online.');
if (!stripe) console.warn('WARNING: STRIPE_SECRET_KEY is not set; card payments are disabled (cash still works).');

const app = express();
// Behind a proxy or host (Render, Fly, nginx...), set TRUST_PROXY=1 so each visitor keeps their own IP for rate limits.
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});
const TURNSTILE_SITE = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const money = (c) => '$' + (c / 100).toFixed(2);

function safeEqual(a, b) {
  const ab = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// wrap async handlers: HttpError -> its status, Stripe errors -> 400 with message, anything else -> 500
const h = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
    if (e && String(e.type || '').startsWith('Stripe')) return res.status(400).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

// tiny in-memory rate limiter
const hits = new Map();
const rlCount = (key, windowMs) => {
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
  hits.set(key, arr);
  return arr.length;
};
const rlAdd = (key) => { const a = hits.get(key) || []; a.push(Date.now()); hits.set(key, a); };
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 25 * 3600e3) hits.delete(k);
}, 10 * 60 * 1000).unref();

// ---------- protection against bots and abuse ----------
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc', 'dispostable.com', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'burnermail.io', 'spamgourmet.com', 'tempail.com', 'moakt.com', 'mailnesia.com', 'tempr.email', 'discard.email', 'grr.la', 'inboxkitten.com', 'mail.tm', 'mailsac.com']);
const GENERIC_REJECT = "We couldn't process that. Please refresh the page and try again.";

function logSecurity(kind, req, detail = '') {
  try {
    db.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)').run(Date.now(), kind, req.ip || '', String(detail).slice(0, 200));
    db.prepare('DELETE FROM security_events WHERE id <= (SELECT MAX(id) FROM security_events) - 1000').run();
  } catch { /* never let logging break a request */ }
}
const isBlocked = (kind, value) => !!value && !!db.prepare('SELECT 1 FROM blocks WHERE kind=? AND value=?').get(kind, String(value).toLowerCase());

async function verifyCaptcha(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch(process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token), remoteip: ip || '' }),
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}

// Checks shared by every public form that creates something (checkout, sign-up).
async function guardPublicForm(req, what) {
  if (isBlocked('ip', req.ip)) { logSecurity('blocked_ip', req, what); throw new HttpError(403, GENERIC_REJECT); }
  const b = req.body || {};
  if (b.website) { logSecurity('honeypot', req, what); throw new HttpError(400, GENERIC_REJECT); }
  const started = Number(b.started);
  if (!Number.isFinite(started) || Date.now() - started < 1200) { logSecurity('too_fast', req, what); throw new HttpError(429, GENERIC_REJECT); }
  if (!(await verifyCaptcha(b.captcha, req.ip))) { logSecurity('captcha_failed', req, what); throw new HttpError(400, 'Please complete the human check and try again.'); }
}

// Overall request flood limit for the public API (staff screens are not counted).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/register')) return next();
  if (rlCount('flood:' + req.ip, 60e3) >= 300) { logSecurity('flood', req); return res.status(429).json({ error: 'Too many requests. Please slow down.' }); }
  rlAdd('flood:' + req.ip);
  next();
});

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || '';
  const key = 'adminfail:' + req.ip;
  if (rlCount(key, 10 * 60 * 1000) >= 20) {
    return res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
  }
  if (ADMIN_PASSWORD && safeEqual(token, ADMIN_PASSWORD)) return next();
  if (token) rlAdd(key);
  res.status(401).json({ error: 'Unauthorized' });
}

// ---------- settings & tax ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, String(v));
const taxRate = () => {
  const n = parseFloat(getSetting('tax_rate', '0'));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 30) : 0;
};
const calcTax = (subtotal) => Math.round((subtotal * taxRate()) / 100);
const storeName = () => getSetting('store_name', 'Outpost');
const Theme = require('./public/theme.js');
const themeSettings = () => ({ bg: getSetting('theme_bg', ''), accent: getSetting('theme_accent', ''), button: getSetting('theme_button', ''), mode: getSetting('theme_mode', ''), textmode: getSetting('theme_textmode', ''), text: getSetting('theme_text', ''), heading: getSetting('theme_heading', ''), link: getSetting('theme_link', ''), buttontext: getSetting('theme_buttontext', '') });
const brandSettings = () => ({ theme: themeSettings(), logo_url: getSetting('logo_url', ''), mascot_url: getSetting('mascot_url', ''), sold_url: getSetting('sold_url', '') });
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Sales are paused when the switch is on, or when today is on/after the "pause from" date; they resume on the "back on" date.
const breakOn = () => {
  const from = getSetting('break_from', ''), until = getSetting('break_until', ''), today = todayStr();
  let on = getSetting('break_on', '') === '1';
  if (!on && from && today >= from) on = true;
  if (on && until && today >= until) on = false;
  return on;
};
const lowStock = () => { const n = parseInt(getSetting('low_stock', '3'), 10); return Number.isFinite(n) && n >= 0 ? n : 3; };
const REFUND_PRESETS = ['final', 'days', 'exchange', 'custom'];
function refundPolicy() {
  const preset = getSetting('refund_preset', '');
  const days = parseInt(getSetting('refund_days', '14'), 10) || 14;
  const custom = getSetting('refund_text', '');
  let text = '';
  if (preset === 'final') text = 'All sales are final. No refunds or exchanges.';
  else if (preset === 'days') text = `Refunds within ${days} days of delivery for items in their original condition. Message the seller to arrange a return.`;
  else if (preset === 'exchange') text = `Exchanges or store credit within ${days} days of delivery. No cash refunds.`;
  else if (preset === 'custom') text = custom;
  return { preset, days, custom, text };
}
const shipDays = () => { const n = parseInt(getSetting('ship_days', '0'), 10); return Number.isFinite(n) && n >= 0 ? n : 0; };
const reviewsOn = () => getSetting('reviews_on', '1') === '1';
const bidCardOn = () => !!stripe && getSetting('bid_card_required', '') === '1';
const handmadeText = () => getSetting('handmade_statement', '');
const SOCIALS = ['website', 'instagram', 'tiktok', 'facebook', 'youtube', 'pinterest', 'bluesky', 'threads', 'email'];
const socialLinks = () => { try { const o = JSON.parse(getSetting('social_json', '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
function cleanSocial(inp) {
  const out = {};
  if (!inp || typeof inp !== 'object') return out;
  for (const k of SOCIALS) {
    let v = String(inp[k] || '').trim().slice(0, 200);
    if (!v) continue;
    if (k === 'email') { if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(v)) throw new HttpError(400, 'That email address doesn’t look right'); out[k] = v; continue; }
    if (!/^[a-z][a-z0-9+.-]*:/i.test(v)) v = 'https://' + v.replace(/^\/+/, '');
    let u; try { u = new URL(v); } catch { throw new HttpError(400, `The ${k} link doesn’t look right. Paste the full address from your browser.`); }
    if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw new HttpError(400, `The ${k} link must be a web address starting with https://`);
    out[k] = u.toString();
  }
  return out;
}
const breakMessage = () => getSetting('break_message', '') || 'Back soon! You can still look around in the meantime.';

// ---------- products ----------
// Only allow image URLs we host ourselves or plain http(s) links.
const BADGES = ['', 'new', 'last_chance', 'discontinued', 'staff_pick'];
const validImageUrl = (u) => u == null || u === '' || /^(\/images\/[\w.-]+|https?:\/\/\S+)$/.test(u);

const activeVariants = (pid) => db.prepare('SELECT * FROM variants WHERE product_id=? AND active=1 ORDER BY position, id').all(pid);
// A product with options keeps its own stock number equal to the total of its options, so every other screen keeps working.
function syncStock(pid) {
  const vs = activeVariants(pid);
  if (vs.length) db.prepare('UPDATE products SET stock=? WHERE id=?').run(vs.reduce((a, v) => a + v.stock, 0), pid);
}
const parseFields = (p) => { try { const a = JSON.parse(p.custom_fields || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
const parseCustom = (i) => { try { const a = JSON.parse(i.custom_json || 'null'); return Array.isArray(a) ? a : []; } catch { return []; } };
function shapeProduct(p, admin = false) {
  let images = [];
  try { images = JSON.parse(p.images || '[]'); } catch { /* ignore */ }
  if (!images.length && p.image_url) images = [p.image_url];
  return {
    id: p.id,
    name: p.name,
    price_cents: p.price_cents,
    stock: p.stock,
    description: p.description || '',
    category: p.category || '',
    tags: p.tags ? p.tags.split(',').filter(Boolean) : [],
    images,
    image_url: images[0] || null,
    active: p.active,
    badge: p.badge || '',
    process: p.process || '',
    option_label: p.option_label || '',
    custom_fields: parseFields(p),
    ...(admin ? { sku: p.sku || '' } : {}),
    variants: activeVariants(p.id).map((v) => ({
      id: v.id, name: v.name, stock: v.stock,
      price_cents: v.price_cents == null ? p.price_cents : v.price_cents,
      own_price: v.price_cents != null,
      ...(admin ? { sku: v.sku || '' } : {}),
    })),
  };
}

function cleanVariants(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'Options must be a list');
  if (raw.length > 40) throw new HttpError(400, 'Up to 40 options per product');
  const seen = new Set(), seenSku = new Set();
  return raw.map((v, i) => {
    const name = String((v && v.name) || '').trim().slice(0, 60);
    if (!name) throw new HttpError(400, `Option ${i + 1} needs a name (like "Small" or "8 x 10")`);
    if (seen.has(name.toLowerCase())) throw new HttpError(400, `You have two options named "${name}"`);
    seen.add(name.toLowerCase());
    const sku = String(v.sku || '').trim().slice(0, 40);
    if (sku) { if (seenSku.has(sku.toLowerCase())) throw new HttpError(400, `SKU "${sku}" is used twice on this product`); seenSku.add(sku.toLowerCase()); }
    let price = null;
    if (v.price_cents !== null && v.price_cents !== undefined && v.price_cents !== '') {
      price = Number(v.price_cents);
      if (!Number.isInteger(price) || price < 0 || price > MAX_BID_CENTS) throw new HttpError(400, `"${name}" has an invalid price`);
    }
    const stock = Number(v.stock === '' || v.stock == null ? 0 : v.stock);
    if (!Number.isInteger(stock) || stock < 0 || stock > 1000000) throw new HttpError(400, `Stock for "${name}" must be a whole number, 0 or more`);
    const id = Number.isInteger(Number(v.id)) && Number(v.id) > 0 ? Number(v.id) : null;
    return { id, name, sku, price_cents: price, stock };
  });
}

// SKUs must be unique across products and options so a barcode scan finds exactly one thing.
function checkSkus(pid, productSku, vs) {
  const all = [];
  if (productSku) all.push(productSku);
  for (const v of vs || []) if (v.sku) all.push(v.sku);
  const lowerSeen = new Set();
  for (const k of all) { if (lowerSeen.has(k.toLowerCase())) throw new HttpError(400, `SKU "${k}" is used more than once on this product`); lowerSeen.add(k.toLowerCase()); }
  for (const k of all) {
    const p = db.prepare('SELECT name FROM products WHERE lower(sku)=lower(?) AND id<>?').get(k, pid || 0);
    if (p) throw new HttpError(400, `SKU "${k}" is already used by "${p.name}"`);
    const keep = (vs || []).filter((v) => v.id).map((v) => v.id);
    const v = db.prepare(`SELECT v.name, p.name pname FROM variants v JOIN products p ON p.id=v.product_id WHERE lower(v.sku)=lower(?) AND v.active=1 AND v.product_id<>? `).get(k, pid || 0);
    if (v) throw new HttpError(400, `SKU "${k}" is already used by "${v.pname} (${v.name})"`);
    void keep;
  }
}

function saveVariants(pid, vs) {
  const existing = db.prepare('SELECT id FROM variants WHERE product_id=?').all(pid).map((r) => r.id);
  const keep = new Set();
  vs.forEach((v, i) => {
    if (v.id && existing.includes(v.id)) {
      db.prepare('UPDATE variants SET name=?, sku=?, price_cents=?, stock=?, position=?, active=1 WHERE id=?').run(v.name, v.sku, v.price_cents, v.stock, i, v.id);
      keep.add(v.id);
    } else {
      const r = db.prepare('INSERT INTO variants (product_id, name, sku, price_cents, stock, position) VALUES (?,?,?,?,?,?)').run(pid, v.name, v.sku, v.price_cents, v.stock, i);
      keep.add(Number(r.lastInsertRowid));
    }
  });
  for (const id of existing) {
    if (keep.has(id)) continue;
    const used = db.prepare('SELECT 1 FROM order_items WHERE variant_id=? LIMIT 1').get(id);
    if (used) db.prepare('UPDATE variants SET active=0 WHERE id=?').run(id); else db.prepare('DELETE FROM variants WHERE id=?').run(id);
  }
  syncStock(pid);
}

function cleanProduct(b, base) {
  const n = { ...base };
  if ('name' in b) n.name = String(b.name || '').trim();
  if ('price_cents' in b) n.price_cents = b.price_cents;
  if ('stock' in b) n.stock = b.stock;
  if ('description' in b) n.description = String(b.description || '').slice(0, 2000);
  if ('category' in b) n.category = String(b.category || '').trim().slice(0, 40);
  if ('active' in b) n.active = b.active ? 1 : 0;
  if ('process' in b) n.process = String(b.process || '').trim().slice(0, 600);
  if ('sku' in b) n.sku = String(b.sku || '').trim().slice(0, 40);
  if ('option_label' in b) n.option_label = String(b.option_label || '').trim().slice(0, 24);
  if ('custom_fields' in b) {
    if (!Array.isArray(b.custom_fields) || b.custom_fields.length > 3) throw new HttpError(400, 'Up to 3 questions for the buyer');
    const seen = new Set();
    n.custom_fields = JSON.stringify(b.custom_fields.map((f, i) => {
      const label = String((f && f.label) || '').trim().slice(0, 40);
      if (!label) throw new HttpError(400, `Question ${i + 1} for the buyer needs a label (like "Name to engrave")`);
      if (seen.has(label.toLowerCase())) throw new HttpError(400, `You have two questions called "${label}"`);
      seen.add(label.toLowerCase());
      return { label, required: !!f.required };
    }));
  }
  if ('badge' in b) {
    const bd = String(b.badge || '');
    if (!BADGES.includes(bd)) throw new HttpError(400, 'Unknown tag');
    n.badge = bd;
  }
  if ('tags' in b) {
    if (!Array.isArray(b.tags)) throw new HttpError(400, 'Tags must be a list');
    n.tags = [...new Set(b.tags.map((t) => String(t).replace(/,/g, ' ').trim().slice(0, 24)).filter(Boolean))]
      .slice(0, 12).join(',');
  }
  if ('images' in b) {
    if (!Array.isArray(b.images) || b.images.length > 8 ||
        !b.images.every((u) => typeof u === 'string' && u && validImageUrl(u))) {
      throw new HttpError(400, 'Invalid images');
    }
    n.images = JSON.stringify(b.images);
    n.image_url = b.images[0] || null;
  } else if ('image_url' in b) {
    if (!validImageUrl(b.image_url)) throw new HttpError(400, 'Invalid image URL');
    n.image_url = b.image_url || null;
    n.images = JSON.stringify(b.image_url ? [b.image_url] : []);
  }
  if (!n.name || n.name.length > 120) throw new HttpError(400, 'Please enter a product name');
  if (!Number.isInteger(n.price_cents) || n.price_cents < 0 || n.price_cents > MAX_BID_CENTS) {
    throw new HttpError(400, 'Please enter a valid price');
  }
  if (!Number.isInteger(n.stock) || n.stock < 0 || n.stock > 1000000) {
    throw new HttpError(400, 'Stock must be a whole number, 0 or more');
  }
  return n;
}

const NEW_PRODUCT = {
  name: '', price_cents: null, stock: 0, description: '', category: '', tags: '',
  images: '[]', image_url: null, active: 1, badge: '', process: '', sku: '', option_label: '', custom_fields: '[]',
};

// ---------- cart / orders ----------
function findDiscount(code, subtotal) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const d = db.prepare('SELECT * FROM discounts WHERE code = ?').get(c);
  if (!d || !d.active) throw new HttpError(400, "That discount code isn't valid");
  if (d.starts_on && todayStr() < d.starts_on) throw new HttpError(400, `That discount code starts on ${d.starts_on}`);
  if (d.expires_on && todayStr() > d.expires_on) throw new HttpError(400, 'That discount code has expired');
  if (d.max_uses != null && d.uses >= d.max_uses) throw new HttpError(400, 'That discount code has been fully used');
  if (subtotal < d.min_subtotal_cents) throw new HttpError(400, `That code needs a subtotal of at least ${'$' + (d.min_subtotal_cents / 100).toFixed(2)}`);
  const amount = d.kind === 'percent' ? Math.round((subtotal * d.value) / 100) : Math.min(d.value, subtotal);
  return { code: d.code, amount };
}

const maxQty = () => { const n = parseInt(getSetting('max_qty', '10'), 10); return Number.isFinite(n) && n >= 0 ? n : 10; };
// opts.limits: apply the shop's per-order limits (public checkout only; staff at the register are exempt)
function priceCart(rawItems, code, opts = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0) throw new HttpError(400, 'Cart is empty');
  if (rawItems.length > 60) throw new HttpError(400, 'Too many items in one order');
  // merge repeated lines so the same product can't be split to dodge the stock check or the limit
  const merged = new Map();
  for (const it of rawItems) {
    const qty = Number(it.qty), id = Number(it.id), vid = it.variant == null || it.variant === '' ? 0 : Number(it.variant);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999 || !Number.isInteger(id) || !Number.isInteger(vid)) throw new HttpError(400, 'Invalid quantity');
    const cv = Array.isArray(it.custom) ? it.custom.slice(0, 3).map((x) => String(x == null ? '' : x).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200)) : [];
    const key = id + ':' + vid + ':' + JSON.stringify(cv);
    const prev = merged.get(key);
    merged.set(key, { id, vid, cv, qty: (prev ? prev.qty : 0) + qty });
  }
  const items = [...merged.values()].map((m) => ({ id: m.id, variant: m.vid, custom: m.cv, qty: m.qty }));
  const lim = opts.limits ? maxQty() : 0;
  const lines = [];
  let subtotal = 0;
  const get = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  for (const it of items) {
    const qty = it.qty;
    if (lim && qty > lim) throw new HttpError(400, `Limit of ${lim} per item per order. Message the seller if you need more.`);
    const p = get.get(Number(it.id));
    if (!p) throw new HttpError(400, 'Product not found');
    const fields = parseFields(p);
    const custom = [];
    fields.forEach((f, i) => {
      const val = (it.custom && it.custom[i]) || '';
      if (f.required && !val) throw new HttpError(400, `Please fill in "${f.label}" for "${p.name}"`);
      if (val) custom.push({ label: f.label, value: val });
    });
    const vs = activeVariants(p.id);
    if (vs.length) {
      if (!it.variant) throw new HttpError(400, `Please choose an option for "${p.name}"`);
      const v = vs.find((x) => x.id === it.variant);
      if (!v) throw new HttpError(400, `That option of "${p.name}" is no longer available`);
      if (v.stock < qty) throw new HttpError(400, `Not enough stock for "${p.name} (${v.name})" (have ${v.stock})`);
      const unit = v.price_cents == null ? p.price_cents : v.price_cents;
      lines.push({ product_id: p.id, variant_id: v.id, name: `${p.name} (${v.name})`, unit_price_cents: unit, quantity: qty, custom });
      subtotal += unit * qty;
      continue;
    }
    if (p.stock < qty) throw new HttpError(400, `Not enough stock for "${p.name}" (have ${p.stock})`);
    lines.push({ product_id: p.id, variant_id: null, name: p.name, unit_price_cents: p.price_cents, quantity: qty, custom });
    subtotal += p.price_cents * qty;
  }
  const disc = findDiscount(code, subtotal);
  const discount = disc ? disc.amount : 0;
  const tax = calcTax(subtotal - discount);
  return { lines, subtotal, discount, discount_code: disc ? disc.code : null, tax, total: subtotal - discount + tax };
}

const insertOrder = db.prepare(
  `INSERT INTO orders (channel, payment_method, status, subtotal_cents, tax_cents, total_cents, auction_id, public_token, discount_cents, discount_code, policy_text)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertItem = db.prepare(
  `INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity, variant_id, custom_json) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

function createOrder(channel, method, status, priced, auctionId = null) {
  return db.transaction(() => {
    const { lastInsertRowid } = insertOrder.run(
      channel, method, status, priced.subtotal, priced.tax, priced.total, auctionId, rid(12), priced.discount || 0, priced.discount_code || null, refundPolicy().text
    );
    for (const l of priced.lines) {
      insertItem.run(lastInsertRowid, l.product_id, l.name, l.unit_price_cents, l.quantity, l.variant_id || null, l.custom && l.custom.length ? JSON.stringify(l.custom) : null);
    }
    return Number(lastInsertRowid);
  })();
}

// Mark paid + decrement stock, exactly once (idempotent for webhook retries).
function fulfillOrder(orderId, extra = {}) {
  db.transaction(() => {
    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) return;
    if (order.status === 'paid') return;
    if (order.status !== 'pending') {
      console.warn(`Payment arrived for order #${orderId} which is "${order.status}" — check Stripe and refund if needed.`);
      return;
    }
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    const dec = db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?');
    const decV = db.prepare('UPDATE variants SET stock = MAX(stock - ?, 0) WHERE id = ?');
    for (const i of items) {
      if (i.variant_id) { decV.run(i.quantity, i.variant_id); if (i.product_id) syncStock(i.product_id); }
      else if (i.product_id) dec.run(i.quantity, i.product_id);
    }
    db.prepare(
      `UPDATE orders SET status='paid', customer_email=COALESCE(?, customer_email),
       shipping_json=COALESCE(?, shipping_json), stripe_payment_intent=COALESCE(?, stripe_payment_intent) WHERE id=?`
    ).run(extra.email || null, extra.shipping ? JSON.stringify(extra.shipping) : null, extra.payment_intent || null, orderId);
    if (order.discount_code) db.prepare('UPDATE discounts SET uses = uses + 1 WHERE code = ?').run(order.discount_code);
  })();
}

async function createStripeSession(orderId, priced, { collectShipping = false, cancelUrl, keepOnFail = false } = {}) {
  const order = db.prepare('SELECT public_token FROM orders WHERE id = ?').get(orderId);
  const failOrder = () => {
    if (!keepOnFail) db.prepare("UPDATE orders SET status='canceled' WHERE id=? AND status='pending'").run(orderId);
  };
  if (!stripe) { failOrder(); throw new HttpError(503, 'Card payments are not set up yet'); }

  const line_items = priced.lines.map((l) => ({
    quantity: l.quantity,
    price_data: { currency: CURRENCY, unit_amount: l.unit_price_cents, product_data: { name: l.name, ...(l.custom && l.custom.length ? { description: l.custom.map((c) => `${c.label}: ${c.value}`).join('; ').slice(0, 480) } : {}) } },
  }));
  if (priced.tax > 0) {
    line_items.push({
      quantity: 1,
      price_data: { currency: CURRENCY, unit_amount: priced.tax, product_data: { name: 'Sales tax' } },
    });
  }
  let discounts;
  if (priced.discount > 0) {
    const coupon = await stripe.coupons.create({ amount_off: priced.discount, currency: CURRENCY, duration: 'once', name: priced.discount_code || 'Discount' }).catch((e) => { failOrder(); throw e; });
    discounts = [{ coupon: coupon.id }];
  }
  const params = {
    mode: 'payment',
    line_items,
    metadata: { order_id: String(orderId) },
    client_reference_id: String(orderId),
    success_url: `${BASE_URL}/thanks.html?order=${orderId}&k=${order.public_token}`,
    cancel_url: cancelUrl || `${BASE_URL}/store.html`,
    // Stripe needs 30 min to 24 h from creation; pad so network delay can't push us under 30.
    expires_at: Math.floor(Date.now() / 1000) + 35 * 60,
  };
  if (discounts) params.discounts = discounts;
  if (collectShipping) params.shipping_address_collection = { allowed_countries: ['US', 'CA'] };
  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    failOrder();
    throw err;
  }
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
  return session;
}

// Cancel a pending order and (best effort) expire its Stripe page so it can't be paid later.
function cancelPendingOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'pending') return false;
  db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(orderId);
  if (stripe && o.stripe_session_id) stripe.checkout.sessions.expire(o.stripe_session_id).catch(() => {});
  return true;
}

// Unpaid online/register-card orders older than 2 hours are canceled so abandoned or fake ones don't pile up.
setInterval(() => {
  try {
    db.prepare("UPDATE orders SET status='canceled' WHERE status='pending' AND channel IN ('online','register') AND created_at < datetime('now','-2 hours')").run();
  } catch { /* ignore */ }
}, 10 * 60 * 1000).unref();

// ---------- Stripe webhook (raw body — must come BEFORE express.json) ----------
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).end();
  let event;
  try {
    event = stripe.webhooks.constructEvent(
      req.body, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature failed:', err.message);
    return res.status(400).send('Bad signature');
  }
  const s = event.data.object;
  const orderId = Number(s.metadata && s.metadata.order_id);
  if (event.type === 'checkout.session.completed' && s.mode === 'setup') {
    saveCardFromSessionId(s.id).catch((e) => console.error('card save failed', e.message));
  } else if (event.type === 'checkout.session.completed' && orderId && s.payment_status === 'paid') {
    const addr = s.shipping_details || s.collected_information?.shipping_details || null;
    fulfillOrder(orderId, { email: s.customer_details?.email, shipping: addr, payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null });
  } else if (event.type === 'checkout.session.expired' && orderId) {
    // Auction orders stay pending: the winner can come back to the same payment link and start a fresh page.
    db.prepare(`UPDATE orders SET status='canceled' WHERE id=? AND status='pending' AND channel != 'auction'`).run(orderId);
  }
  res.json({ received: true });
});

app.use(express.json());
app.get('/theme.css', (req, res) => {
  res.set('Content-Type', 'text/css; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.send(Theme.css(themeSettings()));
});
const IMG_HEADERS = (res) => {
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  res.set('X-Content-Type-Options', 'nosniff');
};
fs.mkdirSync(path.join(db.dataDir || __dirname, db.dataDir ? 'images' : path.join('public', 'images')), { recursive: true });
app.use('/images', express.static(db.dataDir ? path.join(db.dataDir, 'images') : path.join(__dirname, 'public', 'images'), { setHeaders: IMG_HEADERS }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    // Uploaded images are only ever shown in <img> tags. If someone opens an uploaded SVG directly, it must not run anything.
    if (file.includes(path.sep + 'images' + path.sep)) {
      res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.set('X-Content-Type-Options', 'nosniff');
    }
  },
}));

// ---------- image uploads ----------
const UPLOAD_DIR = db.dataDir ? path.join(db.dataDir, 'images') : path.join(__dirname, 'public', 'images');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Identify the real image type from the file's first bytes (never trust the filename or header).
// SVG is allowed so you can use your own artwork. It is only ever displayed through <img> tags and is served with a locked-down policy.
function sniffImage(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  const head = b.toString('utf8', 0, Math.min(b.length, 600)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

app.post('/api/admin/upload', requireAdmin, express.raw({ type: 'image/*', limit: '8mb' }), (req, res) => {
  const ext = sniffImage(req.body);
  if (!ext) return res.status(400).json({ error: 'That file is not a PNG, JPG, GIF, WebP or SVG image' });
  const name = rid(8) + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: '/images/' + name });
});

// ---------- public API: settings, products, checkout, receipts ----------
const settingsPayload = () => ({
  store_name: storeName(), tax_rate: taxRate(), currency: CURRENCY,
  break_on: breakOn(), break_message: breakMessage(),
  break_manual: getSetting('break_on', '') === '1', break_from: getSetting('break_from', ''), break_until: getSetting('break_until', ''),
  low_stock: lowStock(), refund_policy: refundPolicy(), max_qty: maxQty(), captcha_site_key: TURNSTILE_SECRET ? TURNSTILE_SITE : '',
  handmade_statement: handmadeText(), about_text: getSetting('about_text', ''), social: socialLinks(), ship_days: shipDays(), reviews_on: reviewsOn(),
  bid_card_required: bidCardOn(), bid_card_manual: getSetting('bid_card_required', '') === '1', stripe_ready: !!stripe,
  ...brandSettings(),
});
app.get('/api/settings', (req, res) => { res.json(settingsPayload()); });

app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.json(rows.map((p) => shapeProduct(p)));
});

// Price a cart (with an optional discount code) without creating anything.
function quoteWithCodeGuard(req) {
  if (req.body.code && rlCount('code:' + req.ip, 10 * 60e3) >= 10) { logSecurity('code_guessing', req); throw new HttpError(429, 'Too many code attempts. Try again in a few minutes.'); }
  try { return priceCart(req.body.items, req.body.code, { limits: true }); }
  catch (e) { if (req.body.code && e instanceof HttpError && /discount code/.test(e.message)) rlAdd('code:' + req.ip); throw e; }
}
app.post('/api/quote', h(async (req, res) => {
  const p = quoteWithCodeGuard(req);
  res.json({ subtotal_cents: p.subtotal, discount_cents: p.discount, discount_code: p.discount_code, tax_cents: p.tax, total_cents: p.total });
}));

// Online checkout -> Stripe-hosted page (card data never touches your server)
app.post('/api/checkout', h(async (req, res) => {
  if (breakOn()) throw new HttpError(503, breakMessage());
  await guardPublicForm(req, 'checkout');
  if (rlCount('co1:' + req.ip, 60e3) >= 3 || rlCount('co2:' + req.ip, 3600e3) >= 12 || rlCount('coall', 3600e3) >= 150) {
    logSecurity('checkout_rate', req); throw new HttpError(429, 'Too many checkout attempts. Please wait a few minutes and try again.');
  }
  const priced = quoteWithCodeGuard(req);
  rlAdd('co1:' + req.ip); rlAdd('co2:' + req.ip); rlAdd('coall');
  const orderId = createOrder('online', 'card', 'pending', priced);
  const session = await createStripeSession(orderId, priced, { collectShipping: true });
  res.json({ url: session.url });
}));

app.get('/api/order-status/:id', (req, res) => {
  const o = db.prepare('SELECT id,status,total_cents,fulfillment FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(o);
});

// ---------- verified reviews ----------
// Only someone holding a paid order's private receipt link can review it, once per order.
const orderAgeDays = (o) => (Date.now() - Date.parse(String(o.created_at).replace(' ', 'T') + 'Z')) / 864e5;
function reviewState(o) {
  const r = db.prepare('SELECT * FROM reviews WHERE order_id=?').get(o.id);
  let can = false, wait = false;
  if (reviewsOn() && o.status === 'paid') {
    if (['online', 'auction'].includes(o.channel) && !['shipped', 'delivered'].includes(o.fulfillment || '') && orderAgeDays(o) < 10) wait = true;
    else can = true;
  }
  return {
    reviews_on: reviewsOn(), can_review: can && (!r || Date.now() - r.created_at < 14 * 864e5), review_wait: wait,
    review: r ? { rating: r.rating, body: r.body, created_at: r.created_at, reply: r.reply, hidden: !!r.hidden } : null,
  };
}
function reviewerName(o) {
  let n = '';
  try { n = (JSON.parse(o.shipping_json || 'null') || {}).name || ''; } catch { /* ignore */ }
  if (!n && o.channel === 'auction' && o.auction_id) {
    const r = db.prepare('SELECT bd.name FROM auctions a JOIN bids b ON b.id=a.winner_bid_id JOIN bidders bd ON bd.id=b.bidder_id WHERE a.id=?').get(o.auction_id);
    n = r ? r.name : '';
  }
  return n ? maskName(n) : 'Verified buyer';
}
function orderByToken(id, k) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  return o && o.public_token && safeEqual(k || '', o.public_token) ? o : null;
}
app.post('/api/receipt/:id/review', h(async (req, res) => {
  const o = orderByToken(req.params.id, req.query.k);
  if (!o) throw new HttpError(404, 'Receipt not found');
  if (req.body.website) { logSecurity('honeypot', req, 'review'); throw new HttpError(400, GENERIC_REJECT); }
  if (isBlocked('ip', req.ip) || isBlocked('email', o.customer_email)) throw new HttpError(403, GENERIC_REJECT);
  if (rlCount('rev:' + req.ip, 3600e3) >= 6) throw new HttpError(429, 'Too many reviews from this connection. Try again later.');
  const st = reviewState(o);
  if (!st.reviews_on) throw new HttpError(400, 'Reviews are turned off for this shop');
  if (st.review_wait) throw new HttpError(400, 'You can review once your order has shipped. Check back then!');
  if (!st.can_review) throw new HttpError(400, st.review ? 'Reviews can only be edited for 14 days' : 'This order cannot be reviewed');
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Choose 1 to 5 stars');
  const body = String(req.body.body || '').trim().replace(/\s+\n/g, '\n').slice(0, 1000);
  const items = db.prepare('SELECT name FROM order_items WHERE order_id=?').all(o.id).map((i) => i.name).join(', ').slice(0, 200);
  rlAdd('rev:' + req.ip);
  const now = Date.now();
  if (st.review) db.prepare('UPDATE reviews SET rating=?, body=?, edited_at=? WHERE order_id=?').run(rating, body, now, o.id);
  else db.prepare('INSERT INTO reviews (order_id, rating, body, name, items, created_at) VALUES (?,?,?,?,?,?)').run(o.id, rating, body, reviewerName(o), items, now);
  res.json({ ok: true, ...reviewState(o) });
}));

// Buyer adds a shipping address after an automatic charge (no Stripe page was shown, so nothing collected it).
app.post('/api/receipt/:id/shipping', h(async (req, res) => {
  const o = orderByToken(req.params.id, req.query.k);
  if (!o) throw new HttpError(404, 'Receipt not found');
  if (req.body.website) throw new HttpError(400, GENERIC_REJECT);
  if (rlCount('ship:' + req.ip, 3600e3) >= 10) throw new HttpError(429, 'Too many tries. Please wait a bit.');
  rlAdd('ship:' + req.ip);
  if (o.status !== 'paid') throw new HttpError(400, 'This order is not paid yet');
  if (['shipped', 'delivered'].includes(o.fulfillment)) throw new HttpError(400, 'This order has already shipped. Message the seller to change the address.');
  const f = (k, n) => String(req.body[k] || '').trim().slice(0, n);
  const a = { name: f('name', 80), line1: f('line1', 100), line2: f('line2', 100), city: f('city', 60), state: f('state', 40), postal_code: f('postal_code', 20), country: f('country', 40) || 'US' };
  if (!a.name || !a.line1 || !a.city || !a.postal_code) throw new HttpError(400, 'Please fill in your name, street address, city and ZIP / postal code');
  db.prepare('UPDATE orders SET shipping_json=? WHERE id=?').run(JSON.stringify({ name: a.name, address: { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code, country: a.country } }), o.id);
  res.json({ ok: true });
}));

app.get('/api/reviews', (req, res) => {
  if (!reviewsOn()) return res.json({ on: false, count: 0, avg: 0, hidden_count: 0, reviews: [] });
  const rows = db.prepare('SELECT * FROM reviews WHERE hidden=0 ORDER BY created_at DESC LIMIT 100').all();
  const agg = db.prepare('SELECT COUNT(*) c, AVG(rating) a FROM reviews WHERE hidden=0').get();
  const hidden = db.prepare('SELECT COUNT(*) c FROM reviews WHERE hidden=1').get().c;
  res.json({
    on: true, count: agg.c, avg: agg.c ? Math.round(agg.a * 10) / 10 : 0, hidden_count: hidden,
    reviews: rows.map((r) => ({ id: r.id, rating: r.rating, body: r.body, name: r.name, items: r.items, created_at: r.created_at, reply: r.reply, reply_at: r.reply_at, verified: true })),
  });
});

app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  res.json(db.prepare(`SELECT r.*, o.customer_email FROM reviews r JOIN orders o ON o.id = r.order_id ORDER BY r.created_at DESC LIMIT 300`).all());
});
app.put('/api/admin/reviews/:id/reply', requireAdmin, h(async (req, res) => {
  const r = db.prepare('SELECT id FROM reviews WHERE id=?').get(req.params.id);
  if (!r) throw new HttpError(404, 'Not found');
  const text = String(req.body.reply || '').trim().slice(0, 800);
  db.prepare('UPDATE reviews SET reply=?, reply_at=? WHERE id=?').run(text, text ? Date.now() : null, r.id);
  res.json({ ok: true });
}));
// A seller can hide a review (for abuse, not for being critical), but shoppers are told how many are hidden.
app.put('/api/admin/reviews/:id/hide', requireAdmin, h(async (req, res) => {
  const r = db.prepare('SELECT id FROM reviews WHERE id=?').get(req.params.id);
  if (!r) throw new HttpError(404, 'Not found');
  const hide = !!req.body.hidden, note = String(req.body.note || '').trim().slice(0, 200);
  if (hide && !note) throw new HttpError(400, 'Add a short reason (for your own records) before hiding a review');
  db.prepare('UPDATE reviews SET hidden=?, hidden_note=? WHERE id=?').run(hide ? 1 : 0, hide ? note : '', r.id);
  res.json({ ok: true });
}));

// Customer-facing receipt: needs the order's secret token, shows no email/address.
app.get('/api/receipt/:id', (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o || !o.public_token || !safeEqual(req.query.k || '', o.public_token)) {
    return res.status(404).json({ error: 'Receipt not found' });
  }
  const items = db.prepare('SELECT name, unit_price_cents, quantity, custom_json FROM order_items WHERE order_id=?').all(o.id).map((i) => ({ name: i.name, unit_price_cents: i.unit_price_cents, quantity: i.quantity, custom: parseCustom(i) }));
  res.json({
    id: o.id, created_at: o.created_at, channel: o.channel, payment_method: o.payment_method,
    status: o.status, subtotal_cents: o.subtotal_cents, tax_cents: o.tax_cents, total_cents: o.total_cents,
    tax_rate: o.subtotal_cents - o.discount_cents > 0 ? (o.tax_cents / (o.subtotal_cents - o.discount_cents)) * 100 : 0,
    discount_cents: o.discount_cents, discount_code: o.discount_code,
    fulfillment: o.fulfillment, tracking_number: o.tracking_number, carrier: o.carrier, shipped_at: o.shipped_at,
    refunded_cents: o.refunded_cents, refund_policy: o.policy_text || refundPolicy().text,
    ...reviewState(o), needs_shipping: o.status === 'paid' && o.channel !== 'register' && !o.shipping_json,
    items, store_name: storeName(),
  });
});

// ---------- register (admin only) ----------
app.post('/api/register/sale', requireAdmin, h(async (req, res) => {
  const method = req.body.method;
  if (!['cash', 'card', 'other'].includes(method)) throw new HttpError(400, 'method must be cash, card or other');
  const priced = priceCart(req.body.items, req.body.code);
  const base = { subtotal_cents: priced.subtotal, discount_cents: priced.discount, tax_cents: priced.tax, total_cents: priced.total };
  if (method === 'cash' || method === 'other') {
    const orderId = createOrder('register', method, 'pending', priced);
    fulfillOrder(orderId);
    const o = db.prepare('SELECT public_token FROM orders WHERE id=?').get(orderId);
    return res.json({ orderId, status: 'paid', ...base, public_token: o.public_token });
  }
  const orderId = createOrder('register', 'card', 'pending', priced);
  const session = await createStripeSession(orderId, priced, { collectShipping: false });
  const qr = await QRCode.toDataURL(session.url, { width: 320, margin: 1 });
  res.json({ orderId, status: 'pending', ...base, url: session.url, qr });
}));

// ---------- admin API: status, settings, products, orders ----------
app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.json({ stripe: !!stripe, webhook: !!process.env.STRIPE_WEBHOOK_SECRET, base_url: BASE_URL });
});

app.put('/api/admin/settings', requireAdmin, h(async (req, res) => {
  const { tax_rate, store_name, break_on, break_message, theme, logo_url, mascot_url, sold_url, break_from, break_until, low_stock, refund_preset, refund_days, refund_text, max_qty, handmade_statement, about_text, social, ship_days, reviews_on, bid_card_required } = req.body;
  if (tax_rate !== undefined) {
    const n = Number(tax_rate);
    if (!Number.isFinite(n) || n < 0 || n > 30) throw new HttpError(400, 'Tax rate must be between 0 and 30');
    setSetting('tax_rate', Math.round(n * 1000) / 1000);
  }
  if (store_name !== undefined) {
    const s = String(store_name).trim().slice(0, 60);
    if (!s) throw new HttpError(400, 'Store name cannot be empty');
    setSetting('store_name', s);
  }
  if (theme !== undefined) {
    const t = theme || {};
    const mode = String(t.mode || '').trim();
    if (mode && !Theme.MODES.includes(mode)) throw new HttpError(400, 'Appearance must be light, dark or auto');
    setSetting('theme_mode', mode);
    const clean = {};
    for (const k of ['bg', 'accent', 'button', 'text', 'heading', 'link', 'buttontext']) {
      const v = String(t[k] || '').trim();
      if (v && !Theme.HEX.test(v)) throw new HttpError(400, 'Colors must look like #aabbcc');
      clean[k] = v;
    }
    const tm = String(t.textmode || '').trim();
    if (!Theme.TEXTMODES.includes(tm)) throw new HttpError(400, 'Text colors must be default, one color, or each');
    clean.textmode = tm;
    const tc = Theme.textColors(clean), pageBg = clean.bg || Theme.PALETTES[0].bg;
    const need = (c, against, what) => { if (c && Theme.contrast(c, against) < 3) throw new HttpError(400, `${what} is too close to the background color to read. Pick a darker or lighter one.`); };
    need(tc.body, pageBg, 'Your text color'); need(tc.heading, pageBg, 'Your heading color'); need(tc.link, pageBg, 'Your link color');
    if (clean.button && !Theme.buttonOk(clean.button, tc.buttontext)) throw new HttpError(400, tc.buttontext ? 'The button text color is too close to the button color to read. Pick a different one.' : 'Pick a darker button color so the white button text stays readable');
    if (!clean.button && tc.buttontext && Theme.contrast(tc.buttontext, Theme.PALETTES[0].button) < 3) throw new HttpError(400, 'The button text color is too close to the button color to read. Pick a different one.');
    for (const [k, v] of Object.entries(clean)) setSetting('theme_' + k, v);
  }
  for (const [key, val] of [['logo_url', logo_url], ['mascot_url', mascot_url], ['sold_url', sold_url]]) {
    if (val === undefined) continue;
    if (!validImageUrl(val)) throw new HttpError(400, 'That image link is not valid');
    setSetting(key, val || '');
  }
  for (const [key, val] of [['break_from', break_from], ['break_until', break_until]]) {
    if (val === undefined) continue;
    const v = String(val || '').trim();
    if (v && !DATE_RE.test(v)) throw new HttpError(400, 'Dates must look like 2026-11-30');
    setSetting(key, v);
  }
  if (low_stock !== undefined) {
    const n = Number(low_stock);
    if (!Number.isInteger(n) || n < 0 || n > 1000) throw new HttpError(400, 'Low-stock warning must be a whole number');
    setSetting('low_stock', n);
  }
  if (max_qty !== undefined) {
    const n = Number(max_qty);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw new HttpError(400, 'Limit per item must be a whole number (0 means no limit)');
    setSetting('max_qty', n);
  }
  if (refund_preset !== undefined) {
    if (refund_preset && !REFUND_PRESETS.includes(refund_preset)) throw new HttpError(400, 'Unknown refund policy');
    setSetting('refund_preset', refund_preset || '');
  }
  if (refund_days !== undefined) {
    const n = Number(refund_days);
    if (!Number.isInteger(n) || n < 1 || n > 365) throw new HttpError(400, 'Refund window must be 1 to 365 days');
    setSetting('refund_days', n);
  }
  if (handmade_statement !== undefined) setSetting('handmade_statement', String(handmade_statement).trim().slice(0, 600));
  if (about_text !== undefined) setSetting('about_text', String(about_text).trim().slice(0, 2000));
  if (social !== undefined) setSetting('social_json', JSON.stringify(cleanSocial(social)));
  if (ship_days !== undefined) {
    const n = Number(ship_days);
    if (!Number.isInteger(n) || n < 0 || n > 90) throw new HttpError(400, 'Shipping time must be 0 to 90 days (0 turns it off)');
    setSetting('ship_days', n);
  }
  if (reviews_on !== undefined) setSetting('reviews_on', reviews_on ? '1' : '0');
  if (bid_card_required !== undefined) {
    if (bid_card_required && !stripe) throw new HttpError(400, 'Add your Stripe keys first. A card can only be saved through Stripe.');
    setSetting('bid_card_required', bid_card_required ? '1' : '');
  }
  if (refund_text !== undefined) setSetting('refund_text', String(refund_text).trim().slice(0, 1500));
  if (break_on !== undefined) setSetting('break_on', break_on ? '1' : '');
  if (break_message !== undefined) setSetting('break_message', String(break_message).trim().slice(0, 200));
  res.json({ ok: true, ...settingsPayload() });
}));

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY name').all().map((p) => shapeProduct(p, true)));
});

app.get('/api/admin/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(shapeProduct(p, true));
});

app.post('/api/admin/products', requireAdmin, h(async (req, res) => {
  const vs = 'variants' in req.body ? cleanVariants(req.body.variants) : [];
  if (vs.length) req.body.stock = vs.reduce((a, v) => a + v.stock, 0);
  const n = cleanProduct(req.body, NEW_PRODUCT);
  checkSkus(0, n.sku, vs);
  const id = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO products (name, price_cents, stock, description, category, tags, images, image_url, active, badge, process, sku, option_label, custom_fields)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(n.name, n.price_cents, n.stock, n.description, n.category, n.tags, n.images, n.image_url, n.active, n.badge || '', n.process || '', n.sku || '', n.option_label || '', n.custom_fields || '[]');
    if (vs.length) saveVariants(Number(r.lastInsertRowid), vs);
    return Number(r.lastInsertRowid);
  })();
  res.json({ id });
}));

app.put('/api/admin/products/:id', requireAdmin, h(async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Not found');
  const hasV = 'variants' in req.body;
  const vs = hasV ? cleanVariants(req.body.variants) : null;
  if (vs && vs.length) req.body.stock = vs.reduce((a, v) => a + v.stock, 0);
  else if (!hasV && activeVariants(p.id).length) req.body.stock = p.stock;
  const n = cleanProduct(req.body, p);
  checkSkus(p.id, n.sku, vs || []);
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET name=?, price_cents=?, stock=?, description=?, category=?, tags=?, images=?, image_url=?, active=?, badge=?, process=?, sku=?, option_label=?, custom_fields=?
       WHERE id=?`
    ).run(n.name, n.price_cents, n.stock, n.description, n.category, n.tags, n.images, n.image_url, n.active, n.badge || '', n.process || '', n.sku || '', n.option_label || '', n.custom_fields || '[]', p.id);
    if (hasV) saveVariants(p.id, vs);
  })();
  res.json({ ok: true });
}));

const isLate = (o) => shipDays() > 0 && o.status === 'paid' && ['online', 'auction'].includes(o.channel) && ['', 'packed'].includes(o.fulfillment || '') && orderAgeDays(o) > shipDays();
function shapeOrder(o) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  const rv = db.prepare('SELECT rating FROM reviews WHERE order_id=?').get(o.id);
  return { ...o, items: items.map((i) => ({ ...i, custom: parseCustom(i) })), late: isLate(o), review_rating: rv ? rv.rating : null };
}

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all().map(shapeOrder));
});

app.get('/api/admin/orders/:id', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json(shapeOrder(o));
});

app.post('/api/admin/orders/:id/cancel', requireAdmin, h(async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) throw new HttpError(404, 'Not found');
  if (o.channel === 'auction') throw new HttpError(400, 'Cancel auction orders from the Auctions page');
  if (!cancelPendingOrder(o.id)) throw new HttpError(400, 'Only unpaid orders can be canceled');
  res.json({ ok: true });
}));

const FULFILLMENT = ['', 'packed', 'shipped', 'delivered'];
app.put('/api/admin/orders/:id/fulfillment', requireAdmin, h(async (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) throw new HttpError(404, 'Not found');
  if (!['paid', 'refunded'].includes(o.status)) throw new HttpError(400, 'Only paid orders can be shipped');
  const status = String(req.body.status || '');
  if (!FULFILLMENT.includes(status)) throw new HttpError(400, 'Unknown status');
  const tracking = String(req.body.tracking_number || '').trim().slice(0, 80);
  const carrier = String(req.body.carrier || '').trim().slice(0, 40);
  db.prepare("UPDATE orders SET fulfillment=?, tracking_number=?, carrier=?, shipped_at=CASE WHEN ?='shipped' AND shipped_at IS NULL THEN datetime('now') ELSE shipped_at END WHERE id=?")
    .run(status, tracking || null, carrier || null, status, o.id);
  res.json({ ok: true });
}));

// Refunds. Card orders are refunded through Stripe; cash/other (or "I already did it in Stripe") are just recorded.
const refunding = new Set();
app.post('/api/admin/orders/:id/refund', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (refunding.has(id)) throw new HttpError(409, 'A refund for this order is already in progress');
  refunding.add(id);
  try {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'Not found');
    if (o.status !== 'paid') throw new HttpError(400, o.status === 'refunded' ? 'This order is already fully refunded' : 'Only paid orders can be refunded');
    const left = o.total_cents - o.refunded_cents;
    const amount = req.body.amount_cents === undefined || req.body.amount_cents === null ? left : Number(req.body.amount_cents);
    if (!Number.isInteger(amount) || amount < 1 || amount > left) throw new HttpError(400, `Refund must be between $0.01 and $${(left / 100).toFixed(2)}`);
    const note = String(req.body.note || '').trim().slice(0, 300);
    let viaStripe = false;
    if (o.payment_method === 'card' && !req.body.already_refunded) {
      if (!stripe) throw new HttpError(503, 'Stripe is not connected. Refund it in your Stripe dashboard, then tick "I already refunded this elsewhere".');
      let pi = o.stripe_payment_intent;
      if (!pi && o.stripe_session_id) {
        const sess = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
        pi = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent && sess.payment_intent.id;
        if (pi) db.prepare('UPDATE orders SET stripe_payment_intent=? WHERE id=?').run(pi, o.id);
      }
      if (!pi) throw new HttpError(400, 'Could not find the Stripe payment for this order. Refund it in your Stripe dashboard, then tick "I already refunded this elsewhere".');
      await stripe.refunds.create({ payment_intent: pi, amount, metadata: { order_id: String(o.id) } });
      viaStripe = true;
    }
    const full = amount === left;
    db.transaction(() => {
      db.prepare("UPDATE orders SET refunded_cents = refunded_cents + ?, status = CASE WHEN refunded_cents + ? >= total_cents THEN 'refunded' ELSE status END, refund_note = ?, refunded_at = datetime('now') WHERE id = ?")
        .run(amount, amount, note || null, o.id);
      if (full && o.refunded_cents === 0 && req.body.restock) {
        const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
        const inc = db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?');
        const incV = db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ?');
        for (const i of items) {
          if (i.variant_id) { incV.run(i.quantity, i.variant_id); if (i.product_id) syncStock(i.product_id); }
          else if (i.product_id) inc.run(i.quantity, i.product_id);
        }
      }
    })();
    res.json({ ok: true, via_stripe: viaStripe, refunded_cents: o.refunded_cents + amount, status: full ? 'refunded' : 'paid' });
  } finally { refunding.delete(id); }
}));

// ----- protection: blocklist + recent blocked attempts -----
// One printable page with everything that helps answer a chargeback.
const escH = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
app.get('/api/admin/orders/:id/evidence', requireAdmin, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id);
  let ship = null; try { ship = JSON.parse(o.shipping_json || 'null'); } catch { /* ignore */ }
  const addr = ship ? [ship.name, ship.address && ship.address.line1, ship.address && ship.address.line2, ship.address && ship.address.city, ship.address && ship.address.state, ship.address && ship.address.postal_code, ship.address && ship.address.country].filter(Boolean).join(', ') : '';
  const when = (v) => (v ? new Date(String(v).replace(' ', 'T') + 'Z').toUTCString() : '');
  let bids = [], bidder = null;
  if (o.channel === 'auction' && o.auction_id) {
    const a = db.prepare('SELECT winner_bid_id FROM auctions WHERE id=?').get(o.auction_id);
    const wb = a && a.winner_bid_id ? db.prepare('SELECT bidder_id FROM bids WHERE id=?').get(a.winner_bid_id) : null;
    if (wb) {
      bidder = db.prepare('SELECT * FROM bidders WHERE id=?').get(wb.bidder_id);
      bids = db.prepare('SELECT amount_cents, created_at FROM bids WHERE auction_id=? AND bidder_id=? AND voided=0 ORDER BY id').all(o.auction_id, wb.bidder_id);
    }
  }
  const money2 = (c) => '$' + (c / 100).toFixed(2);
  const row = (k, v) => (v ? `<tr><th>${escH(k)}</th><td>${v}</td></tr>` : '');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Order #${o.id} evidence</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:30px auto;padding:0 18px;color:#222}h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:24px 0 6px;border-bottom:1px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%}th{text-align:left;vertical-align:top;width:210px;color:#555;font-weight:600;padding:4px 10px 4px 0}td{padding:4px 0}.note{background:#f4f1ea;padding:10px 14px;border-radius:8px;margin:14px 0}.no-print button{font:inherit;padding:8px 16px;margin:0 0 10px}@media print{.no-print{display:none}}</style></head><body>
<div class="no-print"><button onclick="window.print()">Print or save as PDF</button></div>
<h1>${escH(storeName())}: order #${o.id}</h1><div>Evidence summary generated ${escH(new Date().toUTCString())}</div>
<div class="note"><b>How to use this.</b> If a buyer disputes the charge, open the dispute in your Stripe dashboard (Payments → Disputes), choose “Submit evidence”, and upload this page as a PDF. Add the carrier's tracking page if you have it. Answer calmly and stick to the facts here.</div>
<h2>The order</h2><table>
${row('Order number', '#' + o.id)}${row('Placed (UTC)', escH(when(o.created_at)))}${row('Sold through', escH(o.channel))}${row('Payment', escH(o.payment_method) + (o.stripe_payment_intent ? ' (Stripe payment ' + escH(o.stripe_payment_intent) + ')' : ''))}
${row('Items', items.map((i) => `${i.quantity} × ${escH(i.name)} at ${money2(i.unit_price_cents)}${parseCustom(i).map((c) => `<br><i>${escH(c.label)}: ${escH(c.value)}</i>`).join('')}`).join('<br>'))}
${row('Subtotal', money2(o.subtotal_cents))}${row('Discount', o.discount_cents ? money2(o.discount_cents) + (o.discount_code ? ' (code ' + escH(o.discount_code) + ')' : '') : '')}${row('Tax', money2(o.tax_cents))}${row('Total charged', '<b>' + money2(o.total_cents) + '</b>')}
${row('Refunded', o.refunded_cents ? money2(o.refunded_cents) + (o.refund_note ? ' (' + escH(o.refund_note) + ')' : '') : '')}</table>
<h2>The buyer</h2><table>${row('Email', escH(o.customer_email))}${row('Shipping address', escH(addr))}${row('Receipt link the buyer was given', escH(BASE_URL + '/receipt.html?order=' + o.id + '&k=' + o.public_token))}</table>
<h2>Delivery</h2><table>${row('Status', escH(o.fulfillment || 'not marked shipped'))}${row('Shipped (UTC)', escH(when(o.shipped_at)))}${row('Carrier', escH(o.carrier))}${row('Tracking number', escH(o.tracking_number))}</table>
<h2>What the buyer agreed to</h2><table>${row('Refund policy shown at purchase', escH(o.policy_text || '(none was set)'))}${row('Seller statement', escH(handmadeText()))}</table>
${bidder ? `<h2>Auction history for this buyer</h2><table>${row('Bidder', escH(bidder.name) + ' · ' + escH(bidder.email))}${row('Signed up (UTC)', escH(new Date(bidder.created_at).toUTCString()))}${row('Card saved to bid', bidder.card_at ? escH((bidder.card_brand || 'card') + ' ending ' + (bidder.card_last4 || '')) + ' on ' + escH(new Date(bidder.card_at).toUTCString()) + '<br>Consent shown: “' + escH(cardConsent()) + '”' : '')}
${row('Their bids', bids.map((b) => money2(b.amount_cents) + ' at ' + escH(new Date(b.created_at).toUTCString())).join('<br>'))}${row('Charge result', escH(o.charge_status === 'paid' ? 'Winning bid charged automatically to the saved card' : o.charge_status === 'failed' ? 'Automatic charge failed: ' + (o.charge_error || '') : ''))}</table>` : ''}
</body></html>`;
  res.type('html').send(html);
});

// ---------- backup: database + uploaded photos in one .tar.gz ----------
function makeTar(files) {
  const blocks = [];
  for (const f of files) {
    const h = Buffer.alloc(512);
    h.write(f.name.slice(0, 99), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(f.data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148); h.write('0', 156); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, f.data, Buffer.alloc((512 - (f.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}
app.get('/api/admin/backup', requireAdmin, h(async (req, res) => {
  const tmp = path.join(os.tmpdir(), `outpost-${rid(4)}.db`);
  await db.backup(tmp);
  const files = [{ name: 'outpost.db', data: fs.readFileSync(tmp) }];
  fs.unlinkSync(tmp);
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    const p = path.join(UPLOAD_DIR, f);
    if (/^[\w.-]+$/.test(f) && fs.statSync(p).isFile()) files.push({ name: 'images/' + f, data: fs.readFileSync(p) });
  }
  res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="outpost-backup-${todayStr()}.tar.gz"` });
  res.send(zlib.gzipSync(makeTar(files)));
}));

app.get('/api/admin/security', requireAdmin, (req, res) => {
  const since = Date.now() - 24 * 3600e3;
  const counts = db.prepare('SELECT kind, COUNT(*) n FROM security_events WHERE at >= ? GROUP BY kind ORDER BY n DESC').all(since);
  const recent = db.prepare('SELECT at, kind, ip, detail FROM security_events ORDER BY id DESC LIMIT 25').all();
  const blocks = db.prepare('SELECT * FROM blocks ORDER BY id DESC').all();
  res.json({ last_24h: counts.reduce((a, c) => a + c.n, 0), counts, recent, blocks, captcha: !!TURNSTILE_SECRET, trust_proxy: !!process.env.TRUST_PROXY });
});
app.post('/api/admin/blocks', requireAdmin, h(async (req, res) => {
  const kind = req.body.kind;
  const value = String(req.body.value || '').trim().toLowerCase();
  if (!['email', 'ip'].includes(kind) || !value || value.length > 120) throw new HttpError(400, 'Enter an email address or IP address to block');
  const note = String(req.body.note || '').trim().slice(0, 120);
  db.prepare('INSERT OR IGNORE INTO blocks (kind, value, note, created_at) VALUES (?,?,?,?)').run(kind, value, note, Date.now());
  let voided = 0;
  if (kind === 'email') {
    // their bids on lots that are still open come off the board right away
    voided = db.prepare(`UPDATE bids SET voided = 1 WHERE voided = 0
      AND bidder_id IN (SELECT id FROM bidders WHERE lower(email) = ?)
      AND auction_id IN (SELECT id FROM auctions WHERE status = 'open')`).run(value).changes;
  }
  res.json({ ok: true, voided_bids: voided });
}));
app.delete('/api/admin/blocks/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM blocks WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ----- discount codes -----
function cleanDiscount(b) {
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24);
  if (code.length < 3) throw new HttpError(400, 'Codes need at least 3 letters or numbers');
  if (!['percent', 'amount'].includes(b.kind)) throw new HttpError(400, 'Choose percent or dollar amount');
  const value = Number(b.value);
  if (!Number.isInteger(value) || value < 1) throw new HttpError(400, 'Enter a discount amount');
  if (b.kind === 'percent' && value > 100) throw new HttpError(400, 'Percent must be 100 or less');
  if (b.kind === 'amount' && value > MAX_BID_CENTS) throw new HttpError(400, 'That discount is too large');
  const min = Number(b.min_subtotal_cents || 0);
  if (!Number.isInteger(min) || min < 0) throw new HttpError(400, 'Minimum must be 0 or more');
  let max = null;
  if (b.max_uses !== null && b.max_uses !== undefined && b.max_uses !== '') {
    max = Number(b.max_uses);
    if (!Number.isInteger(max) || max < 1) throw new HttpError(400, 'Max uses must be 1 or more');
  }
  const exp = b.expires_on ? String(b.expires_on) : null;
  if (exp && !DATE_RE.test(exp)) throw new HttpError(400, 'Expiry must look like 2026-11-30');
  const start = b.starts_on ? String(b.starts_on) : null;
  if (start && !DATE_RE.test(start)) throw new HttpError(400, 'Start date must look like 2026-11-30');
  if (start && exp && start > exp) throw new HttpError(400, 'The start date has to come before the end date');
  return { code, kind: b.kind, value, min, max, exp, start, active: b.active === false || b.active === 0 ? 0 : 1 };
}
app.get('/api/admin/discounts', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM discounts ORDER BY id DESC').all());
});
app.post('/api/admin/discounts', requireAdmin, h(async (req, res) => {
  const d = cleanDiscount(req.body);
  if (db.prepare('SELECT 1 FROM discounts WHERE code=?').get(d.code)) throw new HttpError(400, 'You already have a code with that name');
  const r = db.prepare('INSERT INTO discounts (code, kind, value, min_subtotal_cents, max_uses, expires_on, starts_on, active) VALUES (?,?,?,?,?,?,?,?)')
    .run(d.code, d.kind, d.value, d.min, d.max, d.exp, d.start, d.active);
  res.json({ id: Number(r.lastInsertRowid) });
}));
app.put('/api/admin/discounts/:id', requireAdmin, h(async (req, res) => {
  const cur = db.prepare('SELECT * FROM discounts WHERE id=?').get(req.params.id);
  if (!cur) throw new HttpError(404, 'Not found');
  const d = cleanDiscount({ ...cur, min_subtotal_cents: cur.min_subtotal_cents, max_uses: cur.max_uses, expires_on: cur.expires_on, ...req.body, code: cur.code });
  db.prepare('UPDATE discounts SET kind=?, value=?, min_subtotal_cents=?, max_uses=?, expires_on=?, starts_on=?, active=? WHERE id=?')
    .run(d.kind, d.value, d.min, d.max, d.exp, d.start, d.active, cur.id);
  res.json({ ok: true });
}));
app.delete('/api/admin/discounts/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM discounts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ----- reports & customers -----
const NET = "(total_cents - refunded_cents)";
app.get('/api/admin/reports', requireAdmin, (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
  const range = `date(created_at,'localtime') >= date('now','localtime','-${days - 1} day')`;
  const paid = "status IN ('paid','refunded')";
  const sum = (where) => db.prepare(`SELECT COALESCE(SUM(${NET}),0) net, COUNT(*) n FROM orders WHERE ${paid} AND ${where}`).get();
  const today = sum("date(created_at,'localtime') = date('now','localtime')");
  const week = sum("date(created_at,'localtime') >= date('now','localtime','-6 day')");
  const period = sum(range);
  const refunds = db.prepare(`SELECT COALESCE(SUM(refunded_cents),0) c FROM orders WHERE ${paid} AND ${range}`).get().c;
  const rows = db.prepare(`SELECT date(created_at,'localtime') d, COALESCE(SUM(${NET}),0) net, COUNT(*) n FROM orders WHERE ${paid} AND ${range} GROUP BY d`).all();
  const byDay = new Map(rows.map((r) => [r.d, r]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = byDay.get(k);
    series.push({ date: k, net_cents: r ? r.net : 0, orders: r ? r.n : 0 });
  }
  const channels = db.prepare(`SELECT channel, COALESCE(SUM(${NET}),0) net, COUNT(*) n FROM orders WHERE ${paid} AND ${range} GROUP BY channel ORDER BY net DESC`).all();
  const top = db.prepare(`SELECT oi.name, SUM(oi.quantity) qty, SUM(oi.quantity * oi.unit_price_cents) cents
    FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.status IN ('paid','refunded') AND date(o.created_at,'localtime') >= date('now','localtime','-${days - 1} day')
    GROUP BY oi.name ORDER BY qty DESC, cents DESC LIMIT 8`).all();
  const lowP = db.prepare('SELECT id, name, stock FROM products WHERE active=1 AND stock <= ? AND NOT EXISTS (SELECT 1 FROM variants v WHERE v.product_id = products.id AND v.active = 1)').all(lowStock());
  const lowV = db.prepare('SELECT p.id id, p.name || \' (\' || v.name || \')\' name, v.stock stock FROM variants v JOIN products p ON p.id = v.product_id WHERE p.active=1 AND v.active=1 AND v.stock <= ?').all(lowStock());
  const low = [...lowP, ...lowV].sort((a, b) => a.stock - b.stock || a.name.localeCompare(b.name)).slice(0, 20);
  const toShip = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='paid' AND channel IN ('online','auction') AND fulfillment IN ('','packed')").get().c;
  const late = db.prepare("SELECT * FROM orders WHERE status='paid' AND channel IN ('online','auction') AND fulfillment IN ('','packed')").all().filter(isLate).map((o) => o.id);
  const awaiting = db.prepare("SELECT COUNT(*) c FROM orders WHERE status='pending' AND channel='auction'").get().c;
  const ending = db.prepare("SELECT id, title, end_at FROM auctions WHERE status='open' AND start_at <= ? AND end_at <= ? ORDER BY end_at").all(Date.now(), Date.now() + 24 * 3600e3);
  res.json({ days, today, week, period, refunds, series, channels, top, low, low_threshold: lowStock(), attention: { to_ship: toShip, late: late.length, late_ids: late.slice(0, 10), awaiting_payment: awaiting, ending_soon: ending } });
});

app.get('/api/admin/customers', requireAdmin, (req, res) => {
  const map = new Map();
  const get = (email) => { if (!map.has(email)) map.set(email, { email, name: '', orders: 0, spent_cents: 0, last_order: null, bids: 0, won: 0 }); return map.get(email); };
  for (const o of db.prepare("SELECT customer_email, shipping_json, total_cents, refunded_cents, created_at FROM orders WHERE status IN ('paid','refunded') AND customer_email IS NOT NULL AND customer_email <> ''").all()) {
    const c = get(o.customer_email.toLowerCase());
    c.orders += 1; c.spent_cents += o.total_cents - o.refunded_cents;
    if (!c.last_order || o.created_at > c.last_order) c.last_order = o.created_at;
    try { const n = JSON.parse(o.shipping_json || 'null'); if (n && n.name && !c.name) c.name = n.name; } catch { /* ignore */ }
  }
  for (const b of db.prepare(`SELECT bd.email, bd.name, COUNT(bi.id) bids FROM bidders bd JOIN bids bi ON bi.bidder_id = bd.id AND bi.voided = 0 GROUP BY bd.id`).all()) {
    const c = get(b.email.toLowerCase()); c.bids += b.bids; if (!c.name) c.name = b.name;
  }
  for (const w of db.prepare(`SELECT bd.email FROM auctions a JOIN bids bi ON bi.id = a.winner_bid_id JOIN bidders bd ON bd.id = bi.bidder_id WHERE a.status = 'closed'`).all()) {
    get(w.email.toLowerCase()).won += 1;
  }
  res.json([...map.values()].sort((a, b) => b.spent_cents - a.spent_cents || a.email.localeCompare(b.email)));
});

app.get('/api/admin/orders.csv', requireAdmin, (req, res) => {
  const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = db.prepare("SELECT * FROM orders WHERE status IN ('paid','refunded') ORDER BY id").all();
  const lines = [['Order', 'Date', 'Channel', 'Payment', 'Status', 'Subtotal', 'Discount', 'Discount code', 'Tax', 'Total', 'Refunded', 'Customer email', 'Fulfillment', 'Tracking', 'Items'].join(',')];
  for (const o of rows) {
    const items = db.prepare('SELECT name, quantity FROM order_items WHERE order_id=?').all(o.id).map((i) => `${i.quantity}x ${i.name}`).join('; ');
    const m = (c) => (c / 100).toFixed(2);
    lines.push([o.id, o.created_at, o.channel, o.payment_method, o.status, m(o.subtotal_cents), m(o.discount_cents), o.discount_code, m(o.tax_cents), m(o.total_cents), m(o.refunded_cents), o.customer_email, o.fulfillment, o.tracking_number, items].map(q).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});

// ----- bulk edit + CSV import -----
app.post('/api/admin/products/bulk', requireAdmin, h(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length || ids.length > 500) throw new HttpError(400, 'Pick at least one product');
  const set = req.body.set || {};
  let skipped = 0;
  const out = db.transaction(() => {
    let n = 0;
    for (const id of ids) {
      const p = db.prepare('SELECT * FROM products WHERE id=?').get(id);
      if (!p) continue;
      const patch = {};
      for (const k of ['category', 'badge', 'active']) if (k in set) patch[k] = set[k];
      const hasOpts = activeVariants(id).length > 0;
      if ('stock_add' in set) { const v = Number(set.stock_add); if (!Number.isInteger(v)) throw new HttpError(400, 'Stock change must be a whole number'); if (hasOpts) skipped++; else patch.stock = Math.max(p.stock + v, 0); }
      if ('price_percent' in set) { const v = Number(set.price_percent); if (!Number.isFinite(v) || v < -90 || v > 500) throw new HttpError(400, 'Price change must be between -90% and 500%'); patch.price_cents = Math.round(p.price_cents * (1 + v / 100)); }
      const c = cleanProduct(patch, p);
      db.prepare('UPDATE products SET price_cents=?, stock=?, category=?, active=?, badge=? WHERE id=?').run(c.price_cents, c.stock, c.category, c.active, c.badge || '', id);
      if ('price_percent' in set) { const v = Number(set.price_percent); db.prepare('UPDATE variants SET price_cents = ROUND(price_cents * ?) WHERE product_id=? AND price_cents IS NOT NULL').run(1 + v / 100, id); }
      n++;
    }
    return n;
  })();
  res.json({ ok: true, updated: out, skipped_stock: skipped });
}));

app.post('/api/admin/products/import', requireAdmin, h(async (req, res) => {
  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  if (!rows.length) throw new HttpError(400, 'No rows to import');
  if (rows.length > 2000) throw new HttpError(400, 'Import up to 2000 rows at a time');
  const result = { created: 0, updated: 0, errors: [] };
  const find = db.prepare('SELECT * FROM products WHERE lower(name) = lower(?)');
  db.transaction(() => {
    rows.forEach((r, i) => {
      try {
        const price = Math.round(Number(String(r.price ?? '').replace(/[$,\s]/g, '')) * 100);
        if (!Number.isFinite(price)) throw new HttpError(400, 'Price is missing or not a number');
        const body = { name: r.name, price_cents: price, stock: r.stock === '' || r.stock == null ? 0 : Number(r.stock) };
        if (r.category !== undefined) body.category = r.category;
        if (r.description !== undefined) body.description = r.description;
        if (r.tags !== undefined) body.tags = String(r.tags).split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
        if (r.badge !== undefined) body.badge = String(r.badge).trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (r.sku !== undefined) body.sku = r.sku;
        const existing = find.get(String(r.name || '').trim());
        // options: "Small:5:25.00;Large:3:30.00"  (name:stock:optional price)
        let vs = null;
        if (r.variants !== undefined && String(r.variants).trim()) {
          const old = existing ? activeVariants(existing.id) : [];
          vs = cleanVariants(String(r.variants).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
            const [nm, st, pr] = part.split(':').map((x) => x.trim());
            const o = old.find((x) => x.name.toLowerCase() === String(nm || '').toLowerCase());
            const pc = pr ? Math.round(Number(pr.replace(/[$,]/g, '')) * 100) : null;
            if (pr && !Number.isFinite(pc)) throw new HttpError(400, `Option "${nm}" has a price that isn't a number`);
            return { id: o ? o.id : null, name: nm, stock: st === undefined || st === '' ? 0 : Number(st), price_cents: pc, sku: o ? o.sku : '' };
          }));
          body.stock = vs.reduce((a, v) => a + v.stock, 0);
        }
        const n = cleanProduct(body, existing || NEW_PRODUCT);
        checkSkus(existing ? existing.id : 0, n.sku, vs || []);
        if (existing) {
          db.prepare('UPDATE products SET price_cents=?, stock=?, description=?, category=?, tags=?, badge=?, sku=? WHERE id=?')
            .run(n.price_cents, n.stock, n.description, n.category, n.tags, n.badge || '', n.sku || '', existing.id);
          if (vs) saveVariants(existing.id, vs);
          result.updated++;
        } else {
          const ins = db.prepare(`INSERT INTO products (name, price_cents, stock, description, category, tags, images, image_url, active, badge, sku) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
            .run(n.name, n.price_cents, n.stock, n.description, n.category, n.tags, n.images, n.image_url, n.active, n.badge || '', n.sku || '');
          if (vs) saveVariants(Number(ins.lastInsertRowid), vs);
          result.created++;
        }
      } catch (e) {
        result.errors.push({ row: i + 1, error: e.message || 'Invalid row' });
      }
    });
  })();
  res.json(result);
}));

// =====================================================================
//                              AUCTIONS
// =====================================================================
const maskName = (n) => {
  const p = String(n).trim().split(/\s+/);
  return p.length > 1 ? `${p[0]} ${p[p.length - 1][0].toUpperCase()}.` : p[0];
};

const highBid = (auctionId) => db.prepare(
  `SELECT b.*, bd.name AS bidder_name, bd.email AS bidder_email
   FROM bids b JOIN bidders bd ON bd.id = b.bidder_id
   WHERE b.auction_id = ? AND b.voided = 0
   ORDER BY b.amount_cents DESC, b.id ASC LIMIT 1`
).get(auctionId);

// Decide the winner of an auction and create their (unpaid) order. Safe to call again after voiding a bid.
function settleAuction(auctionId) {
  db.transaction(() => {
    const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(auctionId);
    const high = highBid(auctionId);
    if (!high) {
      db.prepare("UPDATE auctions SET status='unsold', winner_bid_id=NULL, order_id=NULL, pay_token=NULL WHERE id=?").run(auctionId);
      return;
    }
    const subtotal = high.amount_cents;
    const tax = calcTax(subtotal);
    const priced = {
      lines: [{ product_id: null, name: `${a.title} (Lot ${a.id})`, unit_price_cents: subtotal, quantity: 1 }],
      subtotal, tax, total: subtotal + tax,
    };
    const orderId = createOrder('auction', 'card', 'pending', priced, auctionId);
    db.prepare("UPDATE auctions SET status='closed', winner_bid_id=?, order_id=?, pay_token=? WHERE id=?")
      .run(high.id, orderId, rid(16), auctionId);
  })();
}

function sweepAuctions() {
  const due = db.prepare("SELECT id FROM auctions WHERE status='open' AND end_at <= ?").all(Date.now());
  for (const a of due) settleAuction(a.id);
  if (due.length) setImmediate(autoChargeDue);
}
setInterval(() => { sweepAuctions(); autoChargeDue(); }, 5000);

function shapeAuction(a, { admin = false, bidder = null } = {}) {
  const now = Date.now();
  const high = highBid(a.id);
  const count = db.prepare('SELECT COUNT(*) c FROM bids WHERE auction_id=? AND voided=0').get(a.id).c;
  const order = a.order_id ? db.prepare('SELECT id,status,public_token,total_cents,charge_status,charge_error FROM orders WHERE id=?').get(a.order_id) : null;

  let phase;
  if (a.status === 'canceled') phase = 'canceled';
  else if (a.status === 'unsold') phase = 'unsold';
  else if (a.status === 'closed') phase = order && order.status === 'paid' ? 'paid' : 'sold';
  else phase = now < a.start_at ? 'scheduled' : 'live';

  const out = {
    id: a.id, title: a.title, description: a.description, image_url: a.image_url,
    starting_bid_cents: a.starting_bid_cents, increment_cents: a.increment_cents,
    start_at: a.start_at, end_at: a.end_at, phase, serverNow: now, bid_count: count,
    current_bid_cents: high ? high.amount_cents : null,
    high_bidder: high ? maskName(high.bidder_name) : null,
    next_min_bid_cents: high ? high.amount_cents + a.increment_cents : a.starting_bid_cents,
  };
  if ((phase === 'sold' || phase === 'paid') && high) {
    out.winner = maskName(high.bidder_name);
    out.final_bid_cents = high.amount_cents;
  }

  const bidRows = db.prepare(
    `SELECT b.id, b.amount_cents, b.voided, b.created_at, b.bidder_id, bd.name, bd.email
     FROM bids b JOIN bidders bd ON bd.id = b.bidder_id
     WHERE b.auction_id = ? ${admin ? '' : 'AND b.voided = 0'}
     ORDER BY b.id DESC ${admin ? '' : 'LIMIT 20'}`
  ).all(a.id);
  out.bids = bidRows.map((b) => admin
    ? { id: b.id, amount_cents: b.amount_cents, voided: b.voided, created_at: b.created_at, name: b.name, email: b.email }
    : { amount_cents: b.amount_cents, created_at: b.created_at, name: maskName(b.name), color: b.bidder_id % 6 });

  if (bidder) {
    const isHigh = !!high && high.bidder_id === bidder.id;
    const mine = db.prepare('SELECT COUNT(*) c FROM bids WHERE auction_id=? AND bidder_id=? AND voided=0').get(a.id, bidder.id).c;
    const top = db.prepare('SELECT MAX(amount_cents) m FROM bids WHERE auction_id=? AND bidder_id=? AND voided=0').get(a.id, bidder.id).m;
    const watching = !!db.prepare('SELECT 1 FROM watches WHERE bidder_id=? AND auction_id=?').get(bidder.id, a.id);
    out.you = { name: bidder.name, is_high: isHigh, has_bid: mine > 0, my_bid_cents: top || null, watching, has_card: !!bidder.stripe_payment_method, card_last4: bidder.card_last4 || null, card_brand: bidder.card_brand || null };
    if (isHigh && order && (phase === 'sold' || phase === 'paid')) {
      out.you.charge = order.charge_status || '';
      if (phase === 'paid') out.you.receipt_url = `${BASE_URL}/thanks.html?order=${order.id}&k=${order.public_token}`;
    }
    if (phase === 'sold' && isHigh) out.pay_url = `${BASE_URL}/pay/${a.pay_token}`;
  }
  if (admin) {
    if (phase === 'sold') out.pay_url = `${BASE_URL}/pay/${a.pay_token}`;
    if (high && (phase === 'sold' || phase === 'paid')) out.winner_full = { name: high.bidder_name, email: high.bidder_email };
    if (order) out.order = order;
  }
  return out;
}

const bidderFromReq = (req) => {
  const t = req.get('x-bidder-token');
  return t ? db.prepare('SELECT * FROM bidders WHERE token=?').get(t) : null;
};

// ---------- card on file for bidders (optional) ----------
// A bidder saves a card with Stripe (nothing is charged). When they win, we charge it once for the winning bid.
const cardConsent = () => `If you win a lot you bid on, ${storeName()} may charge this card once for your winning bid plus any sales tax. You are not charged now.`;

async function saveCardFromSessionId(sessionId) {
  const s = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['setup_intent.payment_method'] });
  if (s.mode !== 'setup' || s.status !== 'complete') return null;
  const bd = db.prepare('SELECT * FROM bidders WHERE id=?').get(Number(s.metadata && s.metadata.bidder_id));
  const cust = typeof s.customer === 'string' ? s.customer : s.customer && s.customer.id;
  if (!bd || !bd.stripe_customer_id || cust !== bd.stripe_customer_id) return null;
  const si = s.setup_intent;
  if (!si || typeof si === 'string' || si.status !== 'succeeded') return null;
  const pm = si.payment_method;
  const pmId = typeof pm === 'string' ? pm : pm && pm.id;
  if (!pmId) return null;
  const card = pm && pm.card ? pm.card : {};
  db.prepare('UPDATE bidders SET stripe_payment_method=?, card_brand=?, card_last4=?, card_at=? WHERE id=?').run(pmId, card.brand || null, card.last4 || null, Date.now(), bd.id);
  return bd.id;
}

app.post('/api/bidders/card', h(async (req, res) => {
  const bidder = bidderFromReq(req);
  if (!bidder) throw new HttpError(401, 'Please join first');
  if (!bidCardOn()) throw new HttpError(400, 'This shop does not need a card to bid');
  if (isBlocked('email', bidder.email) || isBlocked('ip', req.ip)) throw new HttpError(403, GENERIC_REJECT);
  if (rlCount('card:' + bidder.id, 10 * 60e3) >= 5 || rlCount('cardip:' + req.ip, 3600e3) >= 15) throw new HttpError(429, 'Too many tries. Please wait a few minutes.');
  rlAdd('card:' + bidder.id); rlAdd('cardip:' + req.ip);
  let cust = bidder.stripe_customer_id;
  if (!cust) {
    const c = await stripe.customers.create({ email: bidder.email, name: bidder.name, metadata: { bidder_id: String(bidder.id) } });
    cust = c.id;
    db.prepare('UPDATE bidders SET stripe_customer_id=? WHERE id=?').run(cust, bidder.id);
  }
  const lot = Number(req.body.lot) > 0 ? Number(req.body.lot) : '';
  const session = await stripe.checkout.sessions.create({
    mode: 'setup', currency: CURRENCY, customer: cust, payment_method_types: ['card'],
    metadata: { bidder_id: String(bidder.id), kind: 'bid_card' },
    custom_text: { submit: { message: cardConsent() } },
    success_url: `${BASE_URL}/card-saved?session_id={CHECKOUT_SESSION_ID}&lot=${lot}`,
    cancel_url: `${BASE_URL}/auction.html${lot ? '?lot=' + lot : ''}`,
  });
  res.json({ url: session.url });
}));

app.get('/card-saved', async (req, res) => {
  const lot = Number(req.query.lot) > 0 ? Number(req.query.lot) : '';
  let ok = false;
  try { ok = !!(stripe && req.query.session_id && (await saveCardFromSessionId(String(req.query.session_id)))); } catch (e) { console.error(e.message); }
  res.redirect(303, `/auction.html${lot ? '?lot=' + lot + '&' : '?'}card=${ok ? 'ok' : 'fail'}`);
});

function chargeError(e) {
  const code = e && (e.code || (e.raw && e.raw.code));
  if (code === 'authentication_required') return 'The bank wants the buyer to confirm this payment.';
  if (code === 'card_declined' || code === 'insufficient_funds' || code === 'expired_card') return 'The card was declined. (' + code.replace(/_/g, ' ') + ')';
  return String((e && e.message) || 'The charge did not go through').slice(0, 200);
}
const markChargeFailed = (orderId, msg) => db.prepare("UPDATE orders SET charge_status='failed', charge_error=? WHERE id=?").run(msg, orderId);

let chargingNow = false;
async function autoChargeDue() {
  if (!bidCardOn() || chargingNow) return;
  chargingNow = true;
  try {
    const rows = db.prepare(`SELECT o.id, o.total_cents, a.id AS aid, a.title, bd.email, bd.stripe_customer_id AS cust, bd.stripe_payment_method AS pm
      FROM orders o JOIN auctions a ON a.order_id = o.id JOIN bids b ON b.id = a.winner_bid_id JOIN bidders bd ON bd.id = b.bidder_id
      WHERE o.channel='auction' AND o.status='pending' AND o.charge_status='' AND a.status='closed'
        AND bd.stripe_payment_method IS NOT NULL AND bd.stripe_customer_id IS NOT NULL`).all();
    for (const r of rows) {
      if (!db.prepare("UPDATE orders SET charge_status='charging' WHERE id=? AND charge_status='' AND status='pending'").run(r.id).changes) continue;
      try {
        const pi = await stripe.paymentIntents.create({
          amount: r.total_cents, currency: CURRENCY, customer: r.cust, payment_method: r.pm, off_session: true, confirm: true,
          payment_method_types: ['card'], receipt_email: r.email, description: `${r.title} (Lot ${r.aid})`,
          metadata: { order_id: String(r.id), auction_id: String(r.aid) },
        }, { idempotencyKey: `outpost-lot-order-${r.id}` });
        if (pi.status === 'succeeded') {
          fulfillOrder(r.id, { email: r.email, payment_intent: pi.id });
          db.prepare("UPDATE orders SET charge_status='paid', charge_error=NULL WHERE id=?").run(r.id);
        } else markChargeFailed(r.id, 'The bank wants the buyer to confirm this payment.');
      } catch (e) { markChargeFailed(r.id, chargeError(e)); }
    }
  } catch (e) { console.error('auto-charge error', e.message); }
  finally { chargingNow = false; }
}

// --- public ---
app.post('/api/bidders', h(async (req, res) => {
  await guardPublicForm(req, 'signup');
  if (rlCount('reg:' + req.ip, 3600e3) >= 5 || rlCount('regday:' + req.ip, 24 * 3600e3) >= 12) { logSecurity('signup_rate', req); throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.'); }
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!name || name.length > 60) throw new HttpError(400, 'Please enter your name');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 120) throw new HttpError(400, 'Please enter a valid email');
  if (DISPOSABLE.has(email.split('@')[1])) { logSecurity('disposable_email', req, email); throw new HttpError(400, 'Please use your real email address so the seller can reach you if you win.'); }
  if (isBlocked('email', email)) { logSecurity('blocked_email', req, email); throw new HttpError(403, GENERIC_REJECT); }
  if (db.prepare('SELECT COUNT(*) c FROM bidders WHERE lower(email)=?').get(email).c >= 5) { logSecurity('email_reuse', req, email); throw new HttpError(429, 'That email has been used to sign up too many times.'); }
  rlAdd('reg:' + req.ip); rlAdd('regday:' + req.ip);
  const token = rid(24);
  db.prepare('INSERT INTO bidders (name, email, token, created_at) VALUES (?,?,?,?)').run(name, email, token, Date.now());
  res.json({ token, name });
}));

app.get('/api/auctions', (req, res) => {
  sweepAuctions();
  const bidder = bidderFromReq(req);
  const recent = Date.now() - 3 * 24 * 3600 * 1000;
  const rows = db.prepare(
    `SELECT * FROM auctions
     WHERE status='open' OR (status IN ('closed','unsold') AND end_at > ?)
     ORDER BY (status='open') DESC, end_at ASC`
  ).all(recent);
  res.json(rows.map((a) => {
    const s = shapeAuction(a, { bidder });
    delete s.bids;
    return s;
  }));
});

app.get('/api/auctions/:id', (req, res) => {
  sweepAuctions();
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  if (!a || a.status === 'canceled') return res.status(404).json({ error: 'Lot not found' });
  res.json(shapeAuction(a, { bidder: bidderFromReq(req) }));
});

app.post('/api/auctions/:id/watch', h(async (req, res) => {
  const bidder = bidderFromReq(req);
  if (!bidder) throw new HttpError(401, 'Join to watch this lot');
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  if (!a || a.status === 'canceled') throw new HttpError(404, 'Lot not found');
  const has = db.prepare('SELECT 1 FROM watches WHERE bidder_id=? AND auction_id=?').get(bidder.id, a.id);
  if (has) db.prepare('DELETE FROM watches WHERE bidder_id=? AND auction_id=?').run(bidder.id, a.id);
  else db.prepare('INSERT INTO watches (bidder_id, auction_id) VALUES (?,?)').run(bidder.id, a.id);
  res.json({ watching: !has });
}));

app.post('/api/auctions/:id/bids', h(async (req, res) => {
  const bidder = bidderFromReq(req);
  if (!bidder) throw new HttpError(401, 'Please sign up to bid');
  if (isBlocked('email', bidder.email) || isBlocked('ip', req.ip)) { logSecurity('blocked_bid', req, bidder.email); throw new HttpError(403, GENERIC_REJECT); }
  if (bidCardOn() && !bidder.stripe_payment_method) {
    const e = new HttpError(402, 'Add a card to bid. You are only charged if you win.'); e.extra = { need_card: true }; throw e;
  }
  if (rlCount('bidip:' + req.ip, 60e3) >= 90) { logSecurity('bid_rate', req); throw new HttpError(429, 'Slow down a little'); }
  rlAdd('bidip:' + req.ip);
  if (rlCount('bid:' + bidder.id, 60e3) >= 30) throw new HttpError(429, 'Slow down a little');
  rlAdd('bid:' + bidder.id);
  const amount = req.body.amount_cents;
  if (!Number.isInteger(amount) || amount < 1 || amount > MAX_BID_CENTS) throw new HttpError(400, 'Enter a valid bid amount');

  db.transaction(() => {
    const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
    const now = Date.now();
    if (!a) throw new HttpError(404, 'Lot not found');
    if (a.status !== 'open' || now >= a.end_at) throw new HttpError(400, 'Bidding has closed for this lot');
    if (now < a.start_at) throw new HttpError(400, 'Bidding has not opened yet');
    const high = highBid(a.id);
    const min = high ? high.amount_cents + a.increment_cents : a.starting_bid_cents;
    if (amount < min) throw new HttpError(400, `The minimum bid is ${money(min)}`);
    if (high && high.bidder_id === bidder.id) throw new HttpError(400, 'You already have the highest bid');
    db.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,?,?)')
      .run(a.id, bidder.id, amount, now);
    // soft close: a late bid pushes the end out so nobody can snipe at the last second
    if (a.end_at - now <= SOFT_CLOSE_MS) {
      db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(now + SOFT_CLOSE_MS, a.id);
    }
  })();

  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  res.json(shapeAuction(a, { bidder }));
}));

// Winner's payment link: always valid until paid; starts a fresh Stripe page each visit.
app.get('/pay/:token', async (req, res) => {
  const text = (code, msg) => res.status(code).type('text/plain').send(msg);
  try {
    const a = db.prepare('SELECT * FROM auctions WHERE pay_token=?').get(req.params.token);
    if (!a || !a.order_id) return text(404, 'This payment link is not valid.');
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(a.order_id);
    if (order.status === 'paid') return res.redirect(303, `/thanks.html?order=${order.id}&k=${order.public_token}`);
    if (order.status !== 'pending' || a.status !== 'closed') return text(410, 'This payment link is no longer active.');
    if (!stripe) return text(503, 'Card payments are not set up yet.');
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    const priced = {
      lines: items.map((i) => ({ name: i.name, unit_price_cents: i.unit_price_cents, quantity: i.quantity })),
      subtotal: order.subtotal_cents, tax: order.tax_cents, total: order.total_cents,
    };
    const session = await createStripeSession(order.id, priced, {
      collectShipping: true, cancelUrl: `${BASE_URL}/auction.html?lot=${a.id}`, keepOnFail: true,
    });
    res.redirect(303, session.url);
  } catch (e) {
    console.error(e);
    text(500, 'Could not start the payment page. Please try again in a moment.');
  }
});

// --- admin ---
app.get('/api/admin/auctions', requireAdmin, (req, res) => {
  sweepAuctions();
  res.json(db.prepare('SELECT * FROM auctions ORDER BY id DESC').all().map((a) => shapeAuction(a, { admin: true })));
});

app.post('/api/admin/auctions', requireAdmin, h(async (req, res) => {
  const b = req.body;
  const title = String(b.title || '').trim();
  const now = Date.now();
  if (!title || title.length > 120) throw new HttpError(400, 'Please enter a title');
  if (!validImageUrl(b.image_url)) throw new HttpError(400, 'Invalid image');
  if (!Number.isInteger(b.starting_bid_cents) || b.starting_bid_cents < 1 || b.starting_bid_cents > MAX_BID_CENTS) {
    throw new HttpError(400, 'Please enter a starting bid');
  }
  if (!Number.isInteger(b.increment_cents) || b.increment_cents < 1 || b.increment_cents > MAX_BID_CENTS) {
    throw new HttpError(400, 'Please choose a bid increment');
  }
  const start = Number.isInteger(b.start_at) && b.start_at > now ? b.start_at : now;
  if (!Number.isInteger(b.end_at) || b.end_at < start + 60e3) throw new HttpError(400, 'The end time must be at least a minute after the start');
  if (b.end_at - start > MAX_AUCTION_MS) throw new HttpError(400, 'Auctions can run for up to 90 days');
  const r = db.prepare(
    `INSERT INTO auctions (title, description, image_url, starting_bid_cents, increment_cents, start_at, end_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(title, String(b.description || '').slice(0, 2000), b.image_url || null, b.starting_bid_cents, b.increment_cents, start, b.end_at, now);
  res.json({ id: Number(r.lastInsertRowid) });
}));

app.post('/api/admin/auctions/:id/end', requireAdmin, h(async (req, res) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  if (!a) throw new HttpError(404, 'Not found');
  if (a.status !== 'open') throw new HttpError(400, 'This lot is not open');
  if (Date.now() < a.start_at) throw new HttpError(400, 'This lot has not started. Cancel it instead.');
  db.prepare('UPDATE auctions SET end_at=? WHERE id=?').run(Date.now(), a.id);
  settleAuction(a.id);
  setImmediate(autoChargeDue);
  res.json({ ok: true });
}));

app.post('/api/admin/auctions/:id/cancel', requireAdmin, h(async (req, res) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  if (!a) throw new HttpError(404, 'Not found');
  if (a.status === 'canceled') return res.json({ ok: true });
  if (a.order_id) {
    const o = db.prepare('SELECT status FROM orders WHERE id=?').get(a.order_id);
    if (o && o.status === 'paid') throw new HttpError(400, 'This lot has already been paid for');
    if (o && o.charge_status === 'charging') throw new HttpError(409, 'A card payment is being processed. Try again in a moment.');
    cancelPendingOrder(a.order_id);
  }
  db.prepare("UPDATE auctions SET status='canceled', pay_token=NULL WHERE id=?").run(a.id);
  res.json({ ok: true });
}));

// Winner didn't pay? Drop their bid and offer the lot to the next-highest bidder.
app.post('/api/admin/auctions/:id/next-bidder', requireAdmin, h(async (req, res) => {
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  if (!a) throw new HttpError(404, 'Not found');
  const order = a.order_id ? db.prepare('SELECT * FROM orders WHERE id=?').get(a.order_id) : null;
  if (a.status !== 'closed' || !order || order.status !== 'pending') {
    throw new HttpError(400, 'Only a sold, unpaid lot can move to the next bidder');
  }
  if (order.charge_status === 'charging') throw new HttpError(409, 'A card payment is being processed. Try again in a moment.');
  cancelPendingOrder(order.id);
  db.prepare('UPDATE bids SET voided=1 WHERE id=?').run(a.winner_bid_id);
  settleAuction(a.id);
  setImmediate(autoChargeDue);
  res.json({ ok: true });
}));

app.post('/api/admin/bids/:id/void', requireAdmin, h(async (req, res) => {
  const b = db.prepare('SELECT * FROM bids WHERE id=?').get(req.params.id);
  if (!b) throw new HttpError(404, 'Not found');
  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(b.auction_id);
  if (a.status !== 'open') throw new HttpError(400, 'Bids can only be removed while the lot is open');
  db.prepare('UPDATE bids SET voided=1 WHERE id=?').run(b.id);
  res.json({ ok: true });
}));

// JSON error responses (e.g. an upload over 8 MB) instead of an HTML error page
app.use((err, req, res, next) => {
  const status = err.status || 500;
  res.status(status).json({ error: status === 413 ? 'Image is too large (8 MB max)' : 'Server error' });
});

app.listen(PORT, () => console.log(`Outpost running at ${BASE_URL}`));
