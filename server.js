require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const Database = require('better-sqlite3');
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const Stripe = require('stripe');
const db = require('./db');
const AiShield = require('./ai-shield');
const Auth = require('./auth');
const Safe = require('./safe');
const { createLimiter } = require('./ratelimit');
const Housekeeping = require('./housekeeping');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const CURRENCY = (process.env.CURRENCY || 'usd').toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const IS_LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(BASE_URL);
// "On the internet" no longer depends on BASE_URL alone: a host like Render with BASE_URL left blank still counts.
const ON_INTERNET = !IS_LOCAL || !!process.env.RENDER || process.env.NODE_ENV === 'production';
// STRIPE_API_HOST/PORT/PROTOCOL and TURNSTILE_VERIFY_URL only exist so the automated tests can point at fake services. They are IGNORED on the internet,
// because set by mistake they would send the Stripe key (over plain http) or the captcha secret to the wrong place.
for (const v of ['STRIPE_API_HOST', 'STRIPE_API_PORT', 'STRIPE_API_PROTOCOL', 'TURNSTILE_VERIFY_URL']) {
  if (ON_INTERNET && process.env[v]) { console.warn(`WARNING: ${v} is a testing setting and is ignored here. Remove it from your environment.`); delete process.env[v]; }
}
const stripeOpts = process.env.STRIPE_API_HOST ? { host: process.env.STRIPE_API_HOST, port: process.env.STRIPE_API_PORT, protocol: process.env.STRIPE_API_PROTOCOL || 'http' } : {};
const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY, { timeout: 30000, ...stripeOpts }) : null;   // a call that gets no answer gives up after 30 seconds (the default is 80)

const SOFT_CLOSE_MS = 2 * 60 * 1000;       // a bid in the last 2 minutes extends the lot by 2 minutes
const MAX_BID_CENTS = 99999999;            // $999,999.99: the largest amount Stripe can charge in one go, so a bigger "bid" could never be collected
const SOFT_CLOSE_MAX = 30;                 // a lot can be pushed out by late bids at most this many times (about an hour), so two bidders can't keep it open forever
const MAX_AUCTION_MS = 90 * 24 * 3600 * 1000;

const PW_PROBLEM = Safe.passwordProblem(ADMIN_PASSWORD, [(() => { try { return new URL(BASE_URL).hostname.split('.')[0]; } catch { return ''; } })()]);
if (PW_PROBLEM && PW_PROBLEM.level === 'hard' && ON_INTERNET) {
  console.error(`\nOutpost will not start on the internet with this ADMIN_PASSWORD (${PW_PROBLEM.why}).\nSet ADMIN_PASSWORD to something long that only you know (12 or more characters is best), then start again.\n`);
  process.exit(1);
}
if (!ADMIN_PASSWORD) console.warn('WARNING: ADMIN_PASSWORD is not set; admin endpoints are locked.');
else if (PW_PROBLEM) console.warn(`NOTE: your ADMIN_PASSWORD is easy to guess (${PW_PROBLEM.why}). ${ON_INTERNET ? 'Please change it soon.' : 'That is fine on your own computer, but pick a strong one before putting Outpost online.'}`);
if (!stripe) console.warn('WARNING: STRIPE_SECRET_KEY is not set; card payments are disabled (cash still works).');

const app = express();
// Behind a proxy or host (Render, Fly, nginx...), set TRUST_PROXY=1 so each visitor keeps their own IP for rate limits.
if (!process.env.TRUST_PROXY && process.env.RENDER) process.env.TRUST_PROXY = '1'; // Render always sits behind a proxy; without this every visitor shares one IP
// TRUST_PROXY=true would believe whatever address a visitor writes in their request, which switches off every per-visitor limit. It is refused.
if (/^(true|yes|on)$/i.test(String(process.env.TRUST_PROXY || '').trim())) {
  console.warn(`WARNING: TRUST_PROXY=${process.env.TRUST_PROXY} is not allowed (it lets anyone fake their address). Ignoring it; use a number, such as 1, for how many proxies sit in front of the app.`);
  delete process.env.TRUST_PROXY;
  if (process.env.RENDER) process.env.TRUST_PROXY = '1';
}
if (process.env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(process.env.TRUST_PROXY) ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);
app.disable('x-powered-by');
const OWNER_PAGES = new Set(['/', '/index.html', '/admin.html']);
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Browsers will insist on HTTPS for this site for a year. Sent whenever the shop's address is https (a plain-http request just ignores it).
  // HSTS_SUBDOMAINS=1 adds every subdomain too; it is off because it can't be undone quickly if a subdomain only speaks http.
  if (req.secure || /^https:/i.test(BASE_URL)) res.set('Strict-Transport-Security', 'max-age=31536000' + (process.env.HSTS_SUBDOMAINS === '1' ? '; includeSubDomains' : ''));
  // The owner's screens carry private data (orders, customers, backups): never let a browser or proxy keep a copy.
  if (req.path.startsWith('/api/admin') || req.path.startsWith('/api/register')) { res.set('Cache-Control', 'no-store'); res.set('Pragma', 'no-cache'); }
  if (OWNER_PAGES.has(req.path)) {
    // The owner's app has no inline scripts, so it can refuse them all: even if a bad piece of text ever got into a screen, it could not run.
    res.set('Content-Security-Policy', [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "script-src 'self'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: blob: https:", "connect-src 'self'", "form-action 'self'",
    ].join('; '));
  } else if (req.path.startsWith('/api/')) {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  } else if (!req.path.startsWith('/images/')) {
    res.set('Content-Security-Policy', [
      "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'self'",
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' data: https:", "connect-src 'self' https://challenges.cloudflare.com", "frame-src https://challenges.cloudflare.com",
      "form-action 'self' https://checkout.stripe.com",
    ].join('; '));
  }
  next();
});
// Keeps AI crawlers out; Google, Bing and other search engines are never blocked (see ai-shield.js).
app.use(AiShield.aiShield({ enabled: () => aiShieldOn(), onBlock: (req, ua) => logSecurity('ai_crawler', req, ua) }));
const TURNSTILE_SITE = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';

// ---------- small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const rid = (n = 16) => crypto.randomBytes(n).toString('hex');
const money = (c) => '$' + (c / 100).toFixed(2);

const safeEqual = Safe.safeEqual;

// wrap async handlers: HttpError -> its status, Stripe errors -> 400 with message, anything else -> 500
const h = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...(e.extra || {}) });
    if (e && String(e.type || '').startsWith('Stripe')) {
      // Stripe's own wording can include details of the account. The owner sees it (it helps); a visitor gets a plain message.
      console.error('Stripe error:', e.type, e.message);
      const staff = req.path.startsWith('/api/admin') || req.path.startsWith('/api/register');
      return res.status(staff ? 400 : 502).json({ error: staff ? String(e.message).slice(0, 300) : 'We could not start the payment just now. Please try again in a moment.' });
    }
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
};

// Who a visitor is counted as in the limits below (IPv6 visitors are grouped by their /64 block).
const ipKey = (req) => Safe.ipGroup(req.ip);

// In-memory rate limiter (see ratelimit.js: its memory is capped, so strangers can't fill the server).
const RL = createLimiter();
const rlCount = RL.count, rlAdd = RL.add;
setInterval(RL.sweep, 60 * 1000).unref();

// ---------- protection against bots and abuse ----------
const DISPOSABLE = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org', 'trashmail.com', 'yopmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc', 'dispostable.com', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'burnermail.io', 'spamgourmet.com', 'tempail.com', 'moakt.com', 'mailnesia.com', 'tempr.email', 'discard.email', 'grr.la', 'inboxkitten.com', 'mail.tm', 'mailsac.com']);
const GENERIC_REJECT = "We couldn't process that. Please refresh the page and try again.";

// The security log is kept in three separate piles, so a flood of one kind can't push out the others: staff sign-in events (admin_*), money events,
// and everything else (the noisy ones). Noisy events from one address are written at most once per 20 seconds, and each noisy kind at most 60 a minute
// overall, so a flood costs a few database writes, not thousands. Email addresses are written masked (j***@example.com). Entries older than 90 days are removed hourly.
const SEC_MONEY = new Set(['oversold', 'double_payment', 'paid_after_cancel', 'payment_mismatch', 'refund_outside', 'dispute', 'charged_not_recorded', 'page_not_closed']);
const SEC_AUTH_SQL = "kind LIKE 'admin\\_%' ESCAPE '\\'";
const SEC_MONEY_SQL = `kind IN (${[...SEC_MONEY].map((k) => `'${k}'`).join(',')})`;
const SEC_PILES = [{ where: SEC_AUTH_SQL, keep: 500 }, { where: SEC_MONEY_SQL, keep: 500 }, { where: `NOT (${SEC_AUTH_SQL}) AND NOT (${SEC_MONEY_SQL})`, keep: 1000 }];
const secSeen = new Map(), secKind = new Map();
let secWrites = 0;
const maskEmails = (t) => String(t).replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***@$2');
function logSecurity(kind, req, detail = '') {
  try {
    const now = Date.now(), ip = (req && req.ip) || '';
    if (!kind.startsWith('admin_') && !SEC_MONEY.has(kind)) {
      const k1 = kind + '|' + ip;
      if (now - (secSeen.get(k1) || 0) < 20e3) return;
      const w = secKind.get(kind);
      if (w && now - w.t < 60e3 && w.n >= 60) return;
      secSeen.set(k1, now); if (secSeen.size > 5000) secSeen.clear();
      secKind.set(kind, w && now - w.t < 60e3 ? { t: w.t, n: w.n + 1 } : { t: now, n: 1 });
    }
    db.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)').run(now, kind, ip, maskEmails(String(detail).slice(0, 300)).slice(0, 200));
    if (++secWrites % 25 === 0) {
      for (const pile of SEC_PILES) {
        db.prepare(`DELETE FROM security_events WHERE ${pile.where} AND id <= COALESCE((SELECT id FROM security_events WHERE ${pile.where} ORDER BY id DESC LIMIT 1 OFFSET ?), -1)`).run(pile.keep);
      }
    }
  } catch { /* never let logging break a request */ }
}
const isBlocked = (kind, value) => !!value && !!db.prepare('SELECT 1 FROM blocks WHERE kind=? AND value=?').get(kind, String(value).toLowerCase());

async function verifyCaptcha(token, ip) {
  if (!TURNSTILE_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch(process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {   // the override is removed above when on the internet
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE_SECRET, response: String(token), remoteip: ip || '' }),
      signal: AbortSignal.timeout(5000),   // if Cloudflare doesn't answer in 5 seconds the check fails closed instead of hanging the request
    });
    const j = await r.json();
    return !!j.success;
  } catch { return false; }
}

// "Started" time for forms: the SERVER hands out a signed time when the page loads, so a bot can't just claim it has been there a while.
// A real form needs between 1.2 seconds and 7 days between loading the page and sending it.
const formSecret = () => { let k = getSetting('form_secret', ''); if (!k) { k = crypto.randomBytes(24).toString('hex'); setSetting('form_secret', k); } return k; };
const formSig = (ts) => crypto.createHmac('sha256', formSecret()).update('form:' + ts).digest('hex').slice(0, 32);
const newFormToken = () => { const ts = Date.now(); return `${ts}.${formSig(ts)}`; };
function formTokenOk(t) {
  if (typeof t !== 'string' || t.length > 80) return false;
  const [ts, sig] = t.split('.');
  if (!/^\d{10,15}$/.test(ts || '') || !sig || !safeEqual(sig, formSig(ts))) return false;
  const age = Date.now() - Number(ts);
  return age >= 1200 && age <= 7 * 24 * 3600e3;
}

// Checks shared by every public form that creates something (checkout, sign-up).
async function guardPublicForm(req, what) {
  if (isBlocked('ip', req.ip)) { logSecurity('blocked_ip', req, what); throw new HttpError(403, GENERIC_REJECT); }
  const b = req.body || {};
  if (b.website) { logSecurity('honeypot', req, what); throw new HttpError(400, GENERIC_REJECT); }
  if (!formTokenOk(b.started)) { logSecurity('too_fast', req, what); throw new HttpError(429, GENERIC_REJECT); }
  if (!(await verifyCaptcha(b.captcha, req.ip))) { logSecurity('captcha_failed', req, what); throw new HttpError(400, 'Please complete the human check and try again.'); }
}

// Overall request flood limit for the public API (staff screens are not counted).
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/register')) return next();
  if (rlCount('flood:' + ipKey(req), 60e3) >= 300) { logSecurity('flood', req); return res.status(429).json({ error: 'Too many requests. Please slow down.' }); }
  rlAdd('flood:' + ipKey(req));
  next();
});
app.get('/api/form-token', (req, res) => { res.set('Cache-Control', 'no-store'); res.json({ token: newFormToken() }); });

// ---------- staff sign-in: password (+ optional authenticator code) -> expiring session ----------
const SESSION_MS = 12 * 3600e3, DEVICE_MS = 30 * 24 * 3600e3;
const LOGIN_WINDOW = 15 * 60e3, LOGIN_PER_IP = 10, LOGIN_ALL = 60;
// A session is only good for the password it was opened with: change ADMIN_PASSWORD and every old session stops working.
const pwVersion = () => crypto.createHash('sha256').update('outpost-session:' + ADMIN_PASSWORD).digest('hex').slice(0, 32);
const deviceFor = (token) => token ? db.prepare('SELECT 1 FROM trusted_devices WHERE token_hash=? AND expires_at > ?').get(Auth.hashToken(token), Date.now()) : null;
// Strangers' failed guesses lock the sign-in page, but a browser the owner has signed in from before is let through
// (the password is still checked). The lock is per visitor, and across everyone as a ceiling on total guessing.
function loginLocked(req) {
  if (deviceFor(req.get('x-device-token'))) return false;
  const since = Date.now() - LOGIN_WINDOW;
  const mine = db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE at > ? AND ip = ?').get(since, ipKey(req)).c;
  const all = db.prepare('SELECT COUNT(*) c FROM login_attempts WHERE at > ?').get(since).c;
  return mine >= LOGIN_PER_IP || all >= LOGIN_ALL;
}
const countLoginAttempt = (req) => {
  db.prepare('INSERT INTO login_attempts (at, ip) VALUES (?,?)').run(Date.now(), ipKey(req));
  db.prepare('DELETE FROM login_attempts WHERE at < ?').run(Date.now() - 24 * 3600e3);
};
function loginFailed(req, why) {
  countLoginAttempt(req);
  logSecurity('admin_login_failed', req, why);
  if (loginLocked(req)) logSecurity('admin_lockout', req);
}
function startSession(req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM admin_sessions WHERE token_hash IN (SELECT token_hash FROM admin_sessions ORDER BY created_at DESC LIMIT -1 OFFSET 19)').run();
  db.prepare('INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip, pw_ver) VALUES (?,?,?,?,?)').run(Auth.hashToken(token), now, now + SESSION_MS, req.ip || '', pwVersion());
  return { token, expires_at: now + SESSION_MS };
}
// Remember this browser as the owner's (or keep the one it already has) and hand back its secret once.
function trustDevice(req) {
  const have = req.get('x-device-token');
  const now = Date.now();
  db.prepare('DELETE FROM trusted_devices WHERE expires_at < ?').run(now);
  if (deviceFor(have)) { db.prepare('UPDATE trusted_devices SET expires_at=? WHERE token_hash=?').run(now + DEVICE_MS, Auth.hashToken(have)); return have; }
  const t = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO trusted_devices (token_hash, created_at, expires_at) VALUES (?,?,?)').run(Auth.hashToken(t), now, now + DEVICE_MS);
  db.prepare('DELETE FROM trusted_devices WHERE token_hash IN (SELECT token_hash FROM trusted_devices ORDER BY created_at DESC LIMIT -1 OFFSET 19)').run();
  return t;
}
const sessionFor = (token) => token ? db.prepare('SELECT * FROM admin_sessions WHERE token_hash=? AND expires_at > ? AND pw_ver=?').get(Auth.hashToken(token), Date.now(), pwVersion()) : null;

function requireAdmin(req, res, next) {
  const token = req.get('x-admin-token') || '';
  // A valid session always gets through; only wrong tokens are counted and limited, so junk requests can't block the owner.
  if (ADMIN_PASSWORD && sessionFor(token)) return next();
  const key = 'adminfail:' + ipKey(req);
  if (rlCount(key, 10 * 60 * 1000) >= 60) return res.status(429).json({ error: 'Too many failed requests. Try again in a few minutes.' });
  if (token) rlAdd(key);
  res.status(401).json({ error: 'Unauthorized' });
}

// After a slow step (a call to Stripe, say) check the sign-in is still good, so a request that began before "sign out everywhere" can't go on to finish what it started.
const stillSignedIn = (req) => { if (!(ADMIN_PASSWORD && sessionFor(req.get('x-admin-token') || ''))) throw new HttpError(401, 'You were signed out. Please sign in again.'); };

// ---------- settings & tax ----------
const getSetting = (k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  return r ? r.value : d;
};
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(k, String(v));
const aiShieldOn = () => getSetting('block_ai', '1') !== '0';   // on unless the seller turns it off
const taxRate = () => {
  const n = parseFloat(getSetting('tax_rate', '0'));
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), 30) : 0;
};
const calcTax = (subtotal) => Math.round((subtotal * taxRate()) / 100);   // in-person (register) sales only
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
const reviewsOn = () => true; /* reviews are always on: verified buyers only, and hidden ones are counted publicly */
// ---------- shipping, tax by address, links, policies ----------
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const CA_PROVINCES = new Set('AB BC MB NB NL NS NT NU ON PE QC SK YT'.split(' '));
// For a buyer typing into a free text box: "Oregon" or "or" both become OR.
const STATE_NAMES = Object.fromEntries('alabama:AL;alaska:AK;arizona:AZ;arkansas:AR;california:CA;colorado:CO;connecticut:CT;delaware:DE;district of columbia:DC;florida:FL;georgia:GA;hawaii:HI;idaho:ID;illinois:IL;indiana:IN;iowa:IA;kansas:KS;kentucky:KY;louisiana:LA;maine:ME;maryland:MD;massachusetts:MA;michigan:MI;minnesota:MN;mississippi:MS;missouri:MO;montana:MT;nebraska:NE;nevada:NV;new hampshire:NH;new jersey:NJ;new mexico:NM;new york:NY;north carolina:NC;north dakota:ND;ohio:OH;oklahoma:OK;oregon:OR;pennsylvania:PA;rhode island:RI;south carolina:SC;south dakota:SD;tennessee:TN;texas:TX;utah:UT;vermont:VT;virginia:VA;washington:WA;west virginia:WV;wisconsin:WI;wyoming:WY;alberta:AB;british columbia:BC;manitoba:MB;new brunswick:NB;newfoundland and labrador:NL;newfoundland:NL;nova scotia:NS;northwest territories:NT;nunavut:NU;ontario:ON;prince edward island:PE;quebec:QC;québec:QC;saskatchewan:SK;yukon:YT'.split(';').map((x) => x.split(':')));
const normState = (v) => { const t = String(v || '').trim().replace(/\./g, '').toLowerCase(); return STATE_NAMES[t] || t.toUpperCase(); };
const normCountry = (v) => { const t = String(v || 'US').trim().replace(/\./g, '').toLowerCase(); return ['us', 'usa', 'united states', 'united states of america', 'america'].includes(t) ? 'US' : ['ca', 'canada'].includes(t) ? 'CA' : null; };
const codeList = (s) => String(s || '').toUpperCase().split(/[\s,]+/).filter(Boolean);
// Online sales tax is always worked out by Stripe Tax, from the buyer's address. The seller's own rate is for the register only.
const taxMode = () => 'stripe';
const shippingCfg = () => {
  try {
    const o = JSON.parse(getSetting('shipping_json', ''));
    if (o && typeof o === 'object' && Array.isArray(o.regions)) return { on: !!o.on, regions: o.regions, free_over_cents: Math.max(0, parseInt(o.free_over_cents, 10) || 0) };
  } catch { /* none saved */ }
  return { on: false, regions: [], free_over_cents: 0 };
};
// Online checkout asks for an address first whenever shipping or tax depends on where the buyer is.
const needsAddress = () => true;   // online checkout always asks for the address first, so Stripe can work out tax and shipping

function cleanAddress(a) {
  a = a && typeof a === 'object' ? a : {};
  const f = (k, n) => String(a[k] == null ? '' : a[k]).trim().slice(0, n);
  const country = a.country === 'CA' ? 'CA' : 'US';
  const out = { email: f('email', 200), name: f('name', 100), country, line1: f('line1', 120), line2: f('line2', 120), city: f('city', 80), state: f('state', 2).toUpperCase(), zip: f('zip', 10).toUpperCase() };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (!out.name) throw new HttpError(400, 'Please enter your name.');
  if (!out.line1 || !out.city) throw new HttpError(400, 'Please fill in your address and city.');
  if (!(country === 'CA' ? CA_PROVINCES : US_STATES).has(out.state)) throw new HttpError(400, 'Please choose your ' + (country === 'CA' ? 'province' : 'state') + '.');
  if (country === 'US' ? !/^\d{5}(-\d{4})?$/.test(out.zip) : !/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(out.zip)) throw new HttpError(400, 'That ' + (country === 'CA' ? 'postal code' : 'ZIP code') + ' doesn’t look right.');
  return out;
}
function shippingFor(addr, net) {
  const cfg = shippingCfg();
  if (!cfg.on) return { cents: 0, label: '' };
  const inList = (r) => codeList(r.states).includes(addr.state);
  const reg = cfg.regions.find((r) => r.country === addr.country && codeList(r.states).length && inList(r)) || cfg.regions.find((r) => r.country === addr.country && !codeList(r.states).length);
  if (!reg) throw new HttpError(400, 'Sorry, I don’t ship to ' + (addr.country === 'CA' ? 'Canada' : addr.state) + ' yet.');
  if (cfg.free_over_cents && net >= cfg.free_over_cents) return { cents: 0, label: '(free over $' + (cfg.free_over_cents / 100).toFixed(cfg.free_over_cents % 100 ? 2 : 0) + ')' };
  return { cents: reg.cents, label: '(' + reg.name + ')' };
}
function taxFor() { return { cents: 0, label: '' }; }   // Stripe works it out on the payment page
const linksAll = () => { try { const a = JSON.parse(getSetting('links_json', '[]')); return Array.isArray(a) ? a : []; } catch { return []; } };
const policyObj = () => {
  let o = {};
  try { const x = JSON.parse(getSetting('policy_json', '{}')); if (x && typeof x === 'object') o = x; } catch { /* none saved */ }
  // Where you ship comes from your Shipping regions, so it's only asked once.
  const sh = shippingCfg();
  if (sh.on && sh.regions.length) { const c = new Set(sh.regions.map((r) => r.country)); o = { ...o, ship_regions: c.has('US') && c.has('CA') ? 'usca' : c.has('US') ? 'us' : '' }; }
  return o;
};
const SHOP_PAGES = ['store.html', 'auction.html', 'about.html', 'reviews.html'];
function cleanLinks(inp) {
  if (!Array.isArray(inp) || inp.length > 40) throw new HttpError(400, 'Too many links');
  return inp.map((l) => {
    l = l && typeof l === 'object' ? l : {};
    const kind = ['link', 'event', 'shop'].includes(l.kind) ? l.kind : 'link';
    const title = String(l.title || '').trim().slice(0, 80);
    if (!title) throw new HttpError(400, 'Every link needs a title');
    let url = String(l.url || '').trim().slice(0, 500);
    if (kind === 'shop') { if (!SHOP_PAGES.includes(url)) url = 'store.html'; }
    else if (url) {
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      let u; try { u = new URL(url); } catch { throw new HttpError(400, 'That web address doesn’t look right: ' + url); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Web addresses must start with http or https');
      url = u.toString();   // stored in its cleaned-up form
    } else if (kind === 'link') throw new HttpError(400, 'Add a web address for “' + title + '”');
    return { kind, title, url, note: String(l.note || '').trim().slice(0, 100), date: kind === 'event' && DATE_RE.test(l.date || '') ? l.date : '', place: kind === 'event' ? String(l.place || '').trim().slice(0, 80) : '', hidden: !!l.hidden };
  });
}
function cleanPolicy(q) {
  q = q && typeof q === 'object' ? q : {};
  const t = (k, n) => String(q[k] || '').trim().slice(0, n);
  if (t('contact_email', 120) && !/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(t('contact_email', 120))) throw new HttpError(400, 'That contact email address doesn’t look right');
  return { contact_email: t('contact_email', 120), ship_regions: ['us', 'usca', 'world'].includes(q.ship_regions) ? q.ship_regions : '', ship_note: t('ship_note', 400), governing_law: t('governing_law', 80), privacy_extra: t('privacy_extra', 1500), terms_extra: t('terms_extra', 1500), privacy_custom: t('privacy_custom', 20000), terms_custom: t('terms_custom', 20000), privacy_own: !!q.privacy_own, terms_own: !!q.terms_own, updated: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) };
}
function cleanShipping(b) {
  b = b && typeof b === 'object' ? b : {};
  const regions = (Array.isArray(b.regions) ? b.regions : []).slice(0, 12).map((r, i) => {
    r = r && typeof r === 'object' ? r : {};
    const name = String(r.name || '').trim().slice(0, 40);
    if (!name) throw new HttpError(400, 'Every shipping region needs a name');
    const cents = Math.round(Number(r.cents));
    if (!(cents >= 0 && cents <= 100000)) throw new HttpError(400, 'Shipping for “' + name + '” should be between $0 and $1,000');
    const country = r.country === 'CA' ? 'CA' : 'US';
    const st = codeList(r.states);
    const valid = country === 'CA' ? CA_PROVINCES : US_STATES;
    if (st.some((x) => !valid.has(x))) throw new HttpError(400, 'Use two-letter ' + (country === 'CA' ? 'province' : 'state') + ' codes for “' + name + '”, like AK, HI');
    return { id: String(r.id || 'r' + i).slice(0, 20), name, country, states: st.join(', '), cents };
  });
  if (b.on && !regions.length) throw new HttpError(400, 'Add at least one shipping region, or turn shipping off');
  return { on: !!b.on, regions, free_over_cents: Math.max(0, Math.min(10000000, Math.round(Number(b.free_over_cents) || 0))) };
}
const bidCardOn = () => !!stripe && getSetting('bid_card_required', '1') === '1';   // on unless the seller turns it off
const handmadeText = () => getSetting('handmade_statement', '');
const SOCIALS = ['website', 'instagram', 'tiktok', 'facebook', 'youtube', 'pinterest', 'bluesky', 'threads', 'email'];
const socialLinks = () => { try { const o = JSON.parse(getSetting('social_json', '{}')); return o && typeof o === 'object' ? o : {}; } catch { return {}; } };
function cleanSocial(inp) {
  const out = {};
  if (!inp || typeof inp !== 'object') return out;
  for (const k of SOCIALS) {
    let v = String(inp[k] || '').trim().slice(0, 200);
    if (!v) continue;
    if (k === 'email') { if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v)) throw new HttpError(400, 'That email address doesn’t look right'); out[k] = v; continue; }
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
const validImageUrl = (u) => u == null || u === '' || (typeof u === 'string' && u.length <= 1000 && /^(\/images\/[\w.-]+|https?:\/\/[^\s"'<>\\`]+)$/.test(u));   // quotes and angle brackets are never part of a real photo address

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
    const sw = v.stock_was == null || v.stock_was === '' ? null : Number(v.stock_was);
    return { id, name, sku, price_cents: price, stock, stock_was: Number.isInteger(sw) && sw >= 0 ? sw : null };
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
// Every way a code can be refused is tagged, so wrong-code guessing is counted whichever message the guesser gets (review item 34).
const codeErr = (msg) => { const e = new HttpError(400, msg); e.codeProbe = true; return e; };
// Checkouts that have been started but not paid yet hold their stock and discount-code use for as long as the Stripe page lives (35 minutes, plus a margin).
const HOLD = "datetime('now','-40 minutes')";
const holdByOther = (email) => (email ? " AND lower(COALESCE(o.customer_email,'')) <> ?" : '');
function heldQty(productId, variantId, email) {
  const q = `SELECT COALESCE(SUM(oi.quantity),0) n FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.channel='online' AND o.status='pending' AND o.created_at > ${HOLD} AND oi.product_id=? AND ${variantId ? 'oi.variant_id=?' : 'oi.variant_id IS NULL'}${holdByOther(email)}`;
  return db.prepare(q).get(...[productId, ...(variantId ? [variantId] : []), ...(email ? [email] : [])]).n;
}
function heldCode(code, email) {
  return db.prepare(`SELECT COUNT(*) n FROM orders o WHERE o.channel='online' AND o.status='pending' AND o.created_at > ${HOLD} AND o.discount_code=?${holdByOther(email)}`).get(...[code, ...(email ? [email] : [])]).n;
}
function findDiscount(code, subtotal, opts = {}) {
  const c = String(code || '').trim().toUpperCase();
  if (!c) return null;
  const d = db.prepare('SELECT * FROM discounts WHERE code = ?').get(c);
  if (!d || !d.active) throw codeErr("That discount code isn't valid");
  if (d.starts_on && todayStr() < d.starts_on) throw codeErr(`That discount code starts on ${d.starts_on}`);
  if (d.expires_on && todayStr() > d.expires_on) throw codeErr('That discount code has expired');
  if (d.max_uses != null && d.uses >= d.max_uses) throw codeErr('That discount code has been fully used');
  if (d.max_uses != null && opts.hold && d.uses + heldCode(d.code, opts.holdEmail) >= d.max_uses) throw codeErr('That discount code is being used by another checkout right now. Please try again in a few minutes.');
  if (subtotal < d.min_subtotal_cents) throw codeErr(`That code needs a subtotal of at least ${'$' + (d.min_subtotal_cents / 100).toFixed(2)}`);
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
      if (opts.hold && v.stock - heldQty(p.id, v.id, opts.holdEmail) < qty) throw new HttpError(400, `Someone else is checking out with the last of "${p.name} (${v.name})" right now. Please try again in a few minutes.`);
      const unit = v.price_cents == null ? p.price_cents : v.price_cents;
      lines.push({ product_id: p.id, variant_id: v.id, name: `${p.name} (${v.name})`, unit_price_cents: unit, quantity: qty, custom });
      subtotal += unit * qty;
      continue;
    }
    if (p.stock < qty) throw new HttpError(400, `Not enough stock for "${p.name}" (have ${p.stock})`);
    if (opts.hold && p.stock - heldQty(p.id, null, opts.holdEmail) < qty) throw new HttpError(400, `Someone else is checking out with the last of "${p.name}" right now. Please try again in a few minutes.`);
    lines.push({ product_id: p.id, variant_id: null, name: p.name, unit_price_cents: p.price_cents, quantity: qty, custom });
    subtotal += p.price_cents * qty;
  }
  const disc = findDiscount(code, subtotal, opts);
  const discount = disc ? disc.amount : 0;
  const net = subtotal - discount;
  let tax = opts.online ? 0 : calcTax(net), shipping = 0, shipping_label = '', tax_label = '', address = null;
  if (opts.online && needsAddress()) {
    tax = 0;   // not known until we have an address
    if (opts.address) {
      address = cleanAddress(opts.address);
      const sh = shippingFor(address, net); shipping = sh.cents; shipping_label = sh.label;
      const tx = taxFor(address, net); tax = tx.cents; tax_label = tx.label;
    }
  }
  return { lines, subtotal, discount, discount_code: disc ? disc.code : null, tax, tax_label, shipping, shipping_label, address, total: net + shipping + tax };
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
    if (order.status === 'paid') {
      // The same payment arriving again (a webhook retry) is normal. A DIFFERENT payment means the buyer paid twice: write it down for the owner.
      if (extra.payment_intent && order.stripe_payment_intent && extra.payment_intent !== order.stripe_payment_intent && !String(order.duplicate_payments || '').includes(extra.payment_intent)) {
        db.prepare("UPDATE orders SET duplicate_payments = TRIM(duplicate_payments || ' ' || ?) WHERE id=?").run(extra.payment_intent, orderId);
        logSecurity('double_payment', null, `order #${orderId} was paid twice (${order.stripe_payment_intent} and ${extra.payment_intent}). Refund one in Stripe.`);
      }
      return;
    }
    if (order.status !== 'pending') {
      // Money arrived for an order that is no longer open (canceled while the buyer was still paying, or the payment was very late).
      // The order is left as it is, but the payment is written down on it and the owner is told, so the buyer is not left out of pocket.
      if (order.status === 'canceled' && extra.payment_intent && order.late_payment !== extra.payment_intent) {
        const cents = Number.isInteger(extra.amount_cents) ? extra.amount_cents : order.total_cents;
        db.prepare('UPDATE orders SET late_payment=?, late_paid_cents=?, stripe_payment_intent=COALESCE(stripe_payment_intent, ?) WHERE id=?').run(extra.payment_intent, cents, extra.payment_intent, orderId);
        logSecurity('paid_after_cancel', null, `order #${orderId} was canceled but ${money(cents)} was paid (${extra.payment_intent}). Refund it in Stripe, or ship the order yourself.`);
      } else console.warn(`Payment arrived for order #${orderId} which is "${order.status}" — check Stripe and refund if needed.`);
      return;
    }
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(orderId);
    const stockOf = (i) => i.variant_id ? (db.prepare('SELECT stock FROM variants WHERE id=?').get(i.variant_id) || {}).stock : i.product_id ? (db.prepare('SELECT stock FROM products WHERE id=?').get(i.product_id) || {}).stock : null;
    for (const i of items) {
      const have = stockOf(i);
      // Paid for more than is left (for example a register sale took the last one meanwhile): tell the owner.
      if (have != null && have < i.quantity) logSecurity('oversold', null, `order #${orderId}: ${i.name} x${i.quantity}, only ${have} left`);
      // Write down how many were REALLY taken out of stock, so a later refund puts back exactly that many (and not more than ever existed).
      const taken = have == null ? 0 : Math.min(have, i.quantity);
      db.prepare('UPDATE order_items SET stock_taken=? WHERE id=?').run(taken, i.id);
      if (i.variant_id) { db.prepare('UPDATE variants SET stock = MAX(stock - ?, 0) WHERE id = ?').run(i.quantity, i.variant_id); if (i.product_id) syncStock(i.product_id); }
      else if (i.product_id) db.prepare('UPDATE products SET stock = MAX(stock - ?, 0) WHERE id = ?').run(i.quantity, i.product_id);
    }
    db.prepare(
      `UPDATE orders SET status='paid', customer_email=COALESCE(?, customer_email),
       shipping_json=COALESCE(shipping_json, ?), stripe_payment_intent=COALESCE(?, stripe_payment_intent) WHERE id=?`
    ).run(extra.email || null, extra.shipping ? JSON.stringify(extra.shipping) : null, extra.payment_intent || null, orderId);
    if (order.discount_code) db.prepare('UPDATE discounts SET uses = uses + 1 WHERE code = ?').run(order.discount_code);
  })();
}

// Put an order's items back in stock: exactly the number that were taken out when it was paid (older orders: the full quantity). Only ever once.
function restockOrder(orderId) {
  db.transaction(() => {
    for (const i of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)) {
      const n = i.stock_taken == null ? i.quantity : i.stock_taken;
      if (n > 0) {
        if (i.variant_id) { db.prepare('UPDATE variants SET stock = stock + ? WHERE id = ?').run(n, i.variant_id); if (i.product_id) syncStock(i.product_id); }
        else if (i.product_id) db.prepare('UPDATE products SET stock = stock + ? WHERE id = ?').run(n, i.product_id);
      }
      db.prepare('UPDATE order_items SET stock_taken=0 WHERE id=?').run(i.id);
    }
    db.prepare('UPDATE orders SET restock_requested=2 WHERE id=?').run(orderId);
  })();
}

// Bring an order's refunded total up to `cents` (never down, never past the order total). When that makes it fully refunded, the items go back
// in stock if that was asked for on ANY of the refunds. Returns the order as it is afterwards.
function applyRefundedTotal(orderId, cents) {
  return db.transaction(() => {
    db.prepare("UPDATE orders SET refunded_cents = MAX(refunded_cents, MIN(?, total_cents)), status = CASE WHEN status='paid' AND MAX(refunded_cents, MIN(?, total_cents)) >= total_cents THEN 'refunded' ELSE status END, refund_intent_cents=0, refund_key='', refunded_at=datetime('now') WHERE id=?").run(cents, cents, orderId);
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (o && o.status === 'refunded' && o.restock_requested === 1) restockOrder(orderId);
    return db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  })();
}

// Is this "paid" checkout session really the payment for this order? It must be one of the pages made for the order, and must not be for LESS than the order costs
// (Stripe signs these messages, so this is a second lock, not the first). Paying more than expected (Stripe Tax added tax) is fine.
const mismatchLogged = new Set();
function checkPaidSession(orderId, s) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) return { ok: false, why: 'no such order' };
  const known = o.stripe_session_id === s.id || !!db.prepare('SELECT 1 FROM order_sessions WHERE order_id=? AND session_id=?').get(orderId, s.id);
  if (!known) return { ok: false, why: `payment page ${s.id} was not made for this order` };
  if (s.currency && String(s.currency).toLowerCase() !== CURRENCY) return { ok: false, why: `paid in ${String(s.currency).toUpperCase()}, not ${CURRENCY.toUpperCase()}` };
  // With Stripe Tax on the page, tax is added by Stripe, so the least it can be is the order without its tax.
  const least = s.automatic_tax && s.automatic_tax.enabled ? Math.max(o.total_cents - (o.tax_cents || 0), 0) : o.total_cents;
  if (Number.isInteger(s.amount_total) && s.amount_total < least) return { ok: false, why: `${money(s.amount_total)} was paid but the order is ${money(least)}` };
  if (s.payment_status === 'no_payment_required' && s.amount_total !== 0) return { ok: false, why: 'marked as needing no payment, but the amount is not zero' };
  return { ok: true };
}
// The one place a paid checkout session is turned into a paid order (used by the Stripe message and by the check on old unpaid orders).
function applyPaidSession(orderId, s) {
  const chk = checkPaidSession(orderId, s);
  if (!chk.ok) {
    const key = orderId + ':' + s.id;
    if (!mismatchLogged.has(key)) { mismatchLogged.add(key); logSecurity('payment_mismatch', null, `order #${orderId}: ${chk.why}. It was NOT marked paid. Look at ${typeof s.payment_intent === 'string' ? s.payment_intent : s.id} in Stripe.`); }
    return false;
  }
  const addr = s.shipping_details || s.collected_information?.shipping_details || null;
  const pi = typeof s.payment_intent === 'string' ? s.payment_intent : (s.payment_intent && s.payment_intent.id) || null;
  fulfillOrder(orderId, { email: s.customer_details?.email, shipping: addr, payment_intent: pi, amount_cents: Number.isInteger(s.amount_total) ? s.amount_total : undefined });
  if (s.automatic_tax && s.automatic_tax.enabled && s.total_details && Number.isInteger(s.amount_total)) {
    // Stripe Tax worked out the tax: record the real amounts on the order.
    // Online and auction orders (a lot paid through its payment link has no tax or shipping from Stripe worked in yet). Never rewrites a canceled order.
    db.prepare("UPDATE orders SET tax_cents=?, total_cents=? WHERE id=? AND channel IN ('online','auction') AND status='paid'").run(s.total_details.amount_tax || 0, s.amount_total, orderId);
  }
  return true;
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
  const autoTax = !!priced.address && taxMode() === 'stripe';
  if (autoTax) line_items.forEach((li) => { li.price_data.tax_behavior = 'exclusive'; });
  if (priced.shipping > 0) {
    line_items.push({
      quantity: 1,
      price_data: { currency: CURRENCY, unit_amount: priced.shipping, product_data: { name: 'Shipping', ...(autoTax ? { tax_code: 'txcd_92010001' } : {}) }, ...(autoTax ? { tax_behavior: 'exclusive' } : {}) },
    });
  }
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
    payment_method_types: ['card'],   // card only (Apple Pay and Google Pay are cards): these pay instantly, so no delayed-payment webhooks are needed
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
  if (priced.address) {
    const a = priced.address;
    const shipTo = { name: a.name, address: { line1: a.line1, line2: a.line2 || undefined, city: a.city, state: a.state, postal_code: a.zip, country: a.country } };
    if (autoTax) {
      // Stripe Tax needs to know where the buyer is: give it a customer that already has the address.
      const cust = await stripe.customers.create({ email: a.email, name: a.name, address: shipTo.address, shipping: shipTo }).catch((e) => { failOrder(); throw e; });
      params.customer = cust.id;
      params.automatic_tax = { enabled: true };
    } else {
      params.customer_email = a.email;
    }
  }
  let session;
  try {
    session = await stripe.checkout.sessions.create(params);
  } catch (err) {
    failOrder();
    throw err;
  }
  db.prepare('UPDATE orders SET stripe_session_id = ? WHERE id = ?').run(session.id, orderId);
  db.prepare('INSERT OR IGNORE INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,?)').run(orderId, session.id, Date.now());
  return session;
}

// Closes every Stripe payment page ever made for an order (not just the latest), so none can still be paid.
// Returns { paid: true } if one of them turns out to have been paid already. A page that refuses to close is logged for the owner.
async function closeOrderPages(orderId) {
  const out = { paid: false, failed: 0 };
  if (!stripe) return out;
  const ids = new Set(db.prepare('SELECT session_id FROM order_sessions WHERE order_id=?').all(orderId).map((r) => r.session_id));
  const last = db.prepare('SELECT stripe_session_id FROM orders WHERE id=?').get(orderId);
  if (last && last.stripe_session_id) ids.add(last.stripe_session_id);
  for (const id of ids) {
    try {
      const cs = await stripe.checkout.sessions.retrieve(id);
      if (cs.status === 'complete') { if (cs.payment_status === 'paid') out.paid = true; continue; }
      if (cs.status === 'open') await stripe.checkout.sessions.expire(id);
    } catch (e) {
      out.failed++;
      logSecurity('page_not_closed', null, `order #${orderId}: payment page ${id} could not be closed (${String((e && e.message) || e).slice(0, 80)}). Check it in Stripe.`);
    }
  }
  return out;
}

// Cancel a pending order and (best effort) expire its Stripe page so it can't be paid later.
function cancelPendingOrder(orderId) {
  const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!o || o.status !== 'pending') return false;
  db.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(orderId);
  if (stripe) closeOrderPages(orderId).catch((e) => console.error('closing payment pages:', e && e.message));
  return true;
}

// Unpaid online/register-card orders older than 2 hours are canceled so abandoned or fake ones don't pile up.
// But first Stripe is asked about each one: if the buyer actually paid (the message from Stripe was just late or lost) the order is marked paid instead of canceled,
// and every payment page is closed so it can't be paid afterwards. If Stripe can't be asked, the order is left alone and looked at again later.
const SWEEP_EVERY_MS = Math.max(1000, parseInt(process.env.SWEEP_EVERY_MS, 10) || 10 * 60 * 1000);   // only the automated tests change this
let sweepingOrders = false;
const sweepSkip = new Map();
async function sweepPendingOrders() {
  if (sweepingOrders) return;
  sweepingOrders = true;
  try {
    const rows = db.prepare("SELECT id FROM orders WHERE status='pending' AND channel IN ('online','register') AND created_at < datetime('now','-2 hours') ORDER BY id LIMIT 50").all();
    for (const r of rows) {
      if ((sweepSkip.get(r.id) || 0) > Date.now()) continue;
      const ids = new Set(db.prepare('SELECT session_id FROM order_sessions WHERE order_id=?').all(r.id).map((x) => x.session_id));
      const last = db.prepare('SELECT stripe_session_id FROM orders WHERE id=?').get(r.id);
      if (last && last.stripe_session_id) ids.add(last.stripe_session_id);
      if (!stripe || !ids.size) { db.prepare("UPDATE orders SET status='canceled' WHERE id=? AND status='pending'").run(r.id); continue; }
      let paid = null, unsure = false;
      for (const sid of ids) {
        try {
          const cs = await stripe.checkout.sessions.retrieve(sid);
          if (cs.status === 'complete' && (cs.payment_status === 'paid' || cs.payment_status === 'no_payment_required')) { paid = cs; break; }
          if (cs.status === 'open') await stripe.checkout.sessions.expire(sid);
        } catch (e) { unsure = true; }
      }
      if (paid) { if (!applyPaidSession(r.id, paid)) sweepSkip.set(r.id, Date.now() + 6 * 3600e3); continue; }
      if (unsure) { sweepSkip.set(r.id, Date.now() + 30 * 60e3); continue; }
      db.prepare("UPDATE orders SET status='canceled' WHERE id=? AND status='pending'").run(r.id);
    }
  } catch (e) { console.error('order sweep error:', e && e.message); }
  finally { sweepingOrders = false; }
}
setInterval(sweepPendingOrders, SWEEP_EVERY_MS).unref();

// Housekeeping (see housekeeping.js): shortly after start and then hourly, junk rows that strangers could pile up are removed.
const LIST_MAX = { subscribers: 25000, bidders: 20000 };   // hard ceilings; the shop owner can still remove entries
function runHousekeeping() {
  try {
    Housekeeping.pruneSecurityLog(db);
    const r = Housekeeping.pruneAbandoned(db);
    if (r.orders || r.bidders) console.log(`housekeeping: removed ${r.orders} abandoned checkouts and ${r.bidders} unused sign-ups`);
  } catch (e) { console.error('housekeeping error:', e && e.message); }
}
setTimeout(runHousekeeping, 30e3).unref();
setInterval(runHousekeeping, 3600e3).unref();

// ---------- Stripe webhook (raw body — must come BEFORE express.json) ----------
app.post('/webhook', express.raw({ type: 'application/json', inflate: false }), (req, res) => {
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
  } else if (event.type === 'checkout.session.completed' && orderId && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required')) {
    applyPaidSession(orderId, s);
  } else if (event.type === 'checkout.session.expired' && orderId) {
    // Auction orders stay pending: the winner can come back to the same payment link and start a fresh page.
    db.prepare(`UPDATE orders SET status='canceled' WHERE id=? AND status='pending' AND channel != 'auction'`).run(orderId);
  } else if (event.type === 'charge.refunded') {
    // A refund made in the Stripe dashboard (or finished after we lost track of it): bring Outpost's record in line.
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent && s.payment_intent.id;
    const o = pi && db.prepare('SELECT * FROM orders WHERE stripe_payment_intent=? OR late_payment=?').get(pi, pi);
    if (o && Number.isInteger(s.amount_refunded) && s.amount_refunded > o.refunded_cents) {
      const inFlight = o.refund_intent_cents > 0;   // a refund made from Outpost is being recorded right now: it will write its own result
      applyRefundedTotal(o.id, s.amount_refunded);
      if (!inFlight) logSecurity('refund_outside', null, `order #${o.id}: Stripe shows ${money(Math.min(s.amount_refunded, o.total_cents))} refunded in total. Outpost's record was updated.`);
    }
  } else if (event.type === 'charge.dispute.created') {
    const pi = typeof s.payment_intent === 'string' ? s.payment_intent : s.payment_intent && s.payment_intent.id;
    const o = pi && db.prepare('SELECT id FROM orders WHERE stripe_payment_intent=?').get(pi);
    logSecurity('dispute', null, `${o ? 'order #' + o.id : 'a payment'} (${pi || 'unknown'}) was disputed by the card holder. Respond in Stripe before the deadline.`);
  }
  res.json({ received: true });
});

app.use(express.json({ inflate: false }));   // compressed request bodies are refused: nothing here needs them
// robots.txt: search engines are welcome, AI crawlers are asked to stay away.
app.get('/robots.txt', (req, res) => {
  res.set('Cache-Control', 'public, max-age=3600');
  res.type('text/plain').send(AiShield.robotsTxt(aiShieldOn()));
});
// Short, shareable addresses: yourshop.com/links goes in your Instagram bio.
const CLEAN_PAGES = { '/links': 'links.html', '/privacy': 'privacy.html', '/terms': 'terms.html', '/about': 'about.html', '/shop': 'store.html' };
for (const [route, file] of Object.entries(CLEAN_PAGES)) app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'public', file)));
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
// Slows down anyone downloading photos in bulk. The shop page loads every product photo at once, so a single visit to a
// shop with 40 products is 40 requests; several people on one shared connection (craft fair wifi) add up fast. Hence the
// room above "10 a minute", which would block real shoppers. Lower it with IMAGE_LIMIT_PER_MIN if you want it stricter.
const IMAGE_LIMIT_PER_MIN = Math.max(20, parseInt(process.env.IMAGE_LIMIT_PER_MIN, 10) || 600);
app.use('/images', (req, res, next) => {
  const key = 'img:' + ipKey(req);   // always on (it used to run only with the AI shield), so bulk downloading is slowed either way
  if (rlCount(key, 60e3) >= IMAGE_LIMIT_PER_MIN) {
    if (rlCount('imglog:' + ipKey(req), 10 * 60e3) === 0) { rlAdd('imglog:' + ipKey(req)); logSecurity('image_flood', req); }   // log it once, not on every refused request
    return res.status(429).type('text/plain').send('Too many requests. Please slow down.');
  }
  rlAdd(key);
  next();
});
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
  if (Safe.looksLikeSvg(head)) return 'svg';
  return null;
}

app.post('/api/admin/upload', requireAdmin, express.raw({ type: 'image/*', limit: '8mb', inflate: false }), (req, res) => {
  const ext = sniffImage(req.body);
  if (!ext) return res.status(400).json({ error: 'That file is not a PNG, JPG, GIF, WebP or SVG image' });
  if (ext === 'svg' && Safe.svgProblem(req.body.toString('utf8'))) return res.status(400).json({ error: 'That SVG contains scripts or embedded content, which is not allowed. Re-export it as a plain SVG, or use a PNG.' });
  const name = rid(8) + '.' + ext;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), req.body);
  res.json({ url: '/images/' + name });
});

// ---------- public API: settings, products, checkout, receipts ----------
const settingsPayload = () => ({
  store_name: storeName(), tax_rate: taxRate(), online_tax_rate: 0, currency: CURRENCY,
  break_on: breakOn(), break_message: breakMessage(),
  break_manual: getSetting('break_on', '') === '1', break_from: getSetting('break_from', ''), break_until: getSetting('break_until', ''),
  low_stock: lowStock(), refund_policy: refundPolicy(), max_qty: maxQty(), captcha_site_key: TURNSTILE_SECRET ? TURNSTILE_SITE : '',
  handmade_statement: handmadeText(), about_text: getSetting('about_text', ''), social: socialLinks(), ship_days: shipDays(), reviews_on: reviewsOn(),
  bid_card_required: bidCardOn(), bid_card_manual: getSetting('bid_card_required', '1') === '1', stripe_ready: !!stripe, block_ai: aiShieldOn(),
  links: linksAll().filter((l) => !l.hidden).map(({ hidden, ...l }) => l), links_intro: getSetting('links_intro', ''), mailing_list_on: getSetting('mailing_list_on', '') === '1',
  policy: policyObj(), shipping: shippingCfg(), tax_mode: taxMode(), tax_home: getSetting('tax_home', ''), needs_address: needsAddress(),
  ...brandSettings(),
});
app.get('/api/settings', (req, res) => { res.json(settingsPayload()); });

app.get('/api/products', (req, res) => {
  const rows = db.prepare('SELECT * FROM products WHERE active=1 ORDER BY name').all();
  res.json(rows.map((p) => shapeProduct(p)));
});

// Price a cart (with an optional discount code) without creating anything.
function quoteWithCodeGuard(req) {
  if (req.body.code && rlCount('code:' + ipKey(req), 10 * 60e3) >= 10) { logSecurity('code_guessing', req); throw new HttpError(429, 'Too many code attempts. Try again in a few minutes.'); }
  const em = req.body.address && typeof req.body.address.email === 'string' ? req.body.address.email.trim().toLowerCase().slice(0, 200) : '';
  try { return priceCart(req.body.items, req.body.code, { limits: true, online: true, address: req.body.address, hold: true, holdEmail: em }); }
  catch (e) { if (req.body.code && e instanceof HttpError && e.codeProbe) rlAdd('code:' + ipKey(req)); throw e; }
}
app.post('/api/quote', h(async (req, res) => {
  const p = quoteWithCodeGuard(req);
  res.json({ subtotal_cents: p.subtotal, discount_cents: p.discount, discount_code: p.discount_code, tax_cents: p.tax, tax_label: p.tax_label, shipping_cents: p.shipping, shipping_label: p.shipping_label, total_cents: p.total });
}));

// Shared ceilings (everyone together). They only exist to protect Stripe and the database from a flood, so they sit well
// above any real shop's traffic: the per-visitor limits do the everyday work. Raise them with these settings if you ever need to.
const CHECKOUT_ALL_PER_HOUR = Math.max(150, parseInt(process.env.CHECKOUT_ALL_PER_HOUR, 10) || 600);
const SUBSCRIBE_ALL_PER_HOUR = Math.max(300, parseInt(process.env.SUBSCRIBE_ALL_PER_HOUR, 10) || 1000);

// Online checkout -> Stripe-hosted page (card data never touches your server)
app.post('/api/checkout', h(async (req, res) => {
  if (breakOn()) throw new HttpError(503, breakMessage());
  await guardPublicForm(req, 'checkout');
  if (rlCount('co1:' + ipKey(req), 60e3) >= 3 || rlCount('co2:' + ipKey(req), 3600e3) >= 12 || rlCount('coall', 3600e3) >= CHECKOUT_ALL_PER_HOUR) {
    logSecurity('checkout_rate', req); throw new HttpError(429, 'Too many checkout attempts. Please wait a few minutes and try again.');
  }
  if (needsAddress() && !req.body.address) throw new HttpError(400, 'Please enter your delivery address first.');
  const priced = quoteWithCodeGuard(req);
  // The price the shopper saw must be the price they pay: if anything changed since their quote, stop and let them look again.
  if (req.body.expected_total_cents != null && Number(req.body.expected_total_cents) !== priced.total) {
    throw Object.assign(new HttpError(409, 'Prices changed while you were shopping. Please check your order and try again.'), { extra: { total_cents: priced.total } });
  }
  rlAdd('co1:' + ipKey(req)); rlAdd('co2:' + ipKey(req)); rlAdd('coall');
  const orderId = createOrder('online', 'card', 'pending', priced);
  const a = priced.address;
  if (a) {
    // The address was entered in Outpost's own checkout and Stripe never asks again, so shipping and tax can't be changed on the payment page.
    db.prepare('UPDATE orders SET shipping_cents=?, shipping_json=?, customer_email=?, tax_state=? WHERE id=?').run(
      priced.shipping, JSON.stringify({ name: a.name, address: { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.zip, country: a.country } }), a.email, a.state, orderId);
  }
  if (priced.total === 0) {
    // Nothing to pay (a 100%-off code and no shipping): Stripe has nothing to charge, so the order is finished here instead of waiting for a payment that never comes.
    fulfillOrder(orderId, { email: a ? a.email : null });
    const tok = db.prepare('SELECT public_token t FROM orders WHERE id=?').get(orderId).t;
    return res.json({ url: `${BASE_URL}/thanks.html?order=${orderId}#k=${tok}` });
  }
  const session = await createStripeSession(orderId, priced, { collectShipping: !a });
  res.json({ url: session.url });
}));

// Needs the order's private receipt key: the order numbers are sequential, so without a key anyone could count through every order.
app.get('/api/order-status/:id', (req, res) => {
  const o = orderByToken(req.params.id, receiptKey(req));
  if (!o) return res.status(404).json({ error: 'Not found' });
  res.json({ id: o.id, status: o.status, total_cents: o.total_cents, fulfillment: o.fulfillment });
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
// The receipt key can travel in a header (kept out of web address logs) or, for older links, in the address.
const receiptKey = (req) => String(req.get('x-receipt-key') || req.query.k || '').slice(0, 100);
function orderByToken(id, k) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  return o && o.public_token && safeEqual(k || '', o.public_token) ? o : null;
}
app.post('/api/receipt/:id/review', h(async (req, res) => {
  const o = orderByToken(req.params.id, receiptKey(req));
  if (!o) throw new HttpError(404, 'Receipt not found');
  if (req.body.website) { logSecurity('honeypot', req, 'review'); throw new HttpError(400, GENERIC_REJECT); }
  if (isBlocked('ip', req.ip) || isBlocked('email', o.customer_email)) throw new HttpError(403, GENERIC_REJECT);
  if (rlCount('rev:' + ipKey(req), 3600e3) >= 6) throw new HttpError(429, 'Too many reviews from this connection. Try again later.');
  const st = reviewState(o);
  if (!st.reviews_on) throw new HttpError(400, 'Reviews are turned off for this shop');
  if (st.review_wait) throw new HttpError(400, 'You can review once your order has shipped. Check back then!');
  if (!st.can_review) throw new HttpError(400, st.review ? 'Reviews can only be edited for 14 days' : 'This order cannot be reviewed');
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new HttpError(400, 'Choose 1 to 5 stars');
  const body = Safe.cleanReviewBody(req.body.body);
  const items = db.prepare('SELECT name FROM order_items WHERE order_id=?').all(o.id).map((i) => i.name).join(', ').slice(0, 200);
  rlAdd('rev:' + ipKey(req));
  const now = Date.now();
  if (st.review) db.prepare('UPDATE reviews SET rating=?, body=?, edited_at=? WHERE order_id=?').run(rating, body, now, o.id);
  else db.prepare('INSERT INTO reviews (order_id, rating, body, name, items, created_at) VALUES (?,?,?,?,?,?)').run(o.id, rating, body, reviewerName(o), items, now);
  res.json({ ok: true, ...reviewState(o) });
}));

// Buyer adds a shipping address after an automatic charge (no Stripe page was shown, so nothing collected it).
app.post('/api/receipt/:id/shipping', h(async (req, res) => {
  const o = orderByToken(req.params.id, receiptKey(req));
  if (!o) throw new HttpError(404, 'Receipt not found');
  if (req.body.website) throw new HttpError(400, GENERIC_REJECT);
  if (rlCount('ship:' + ipKey(req), 3600e3) >= 10) throw new HttpError(429, 'Too many tries. Please wait a bit.');
  rlAdd('ship:' + ipKey(req));
  if (o.status !== 'paid') throw new HttpError(400, 'This order is not paid yet');
  if (['shipped', 'delivered'].includes(o.fulfillment)) throw new HttpError(400, 'This order has already shipped. Message the seller to change the address.');
  // Only for an order that has no address yet. Once one is on the order (typed at checkout, or added here once) it can't be rewritten from the receipt link,
  // because shipping and tax were already worked out for it. To change it, message the seller.
  let had = null; try { had = JSON.parse(o.shipping_json || 'null'); } catch { /* treat as none */ }
  if (had && had.address && had.address.line1) throw new HttpError(400, 'This order already has a delivery address. Message the seller if it needs to change.');
  const country = normCountry(req.body.country);
  if (!country) throw new HttpError(400, 'Outpost ships within the US and Canada. Message the seller if you are somewhere else.');
  const a = cleanAddress({ ...req.body, country, state: normState(req.body.state), zip: req.body.zip || req.body.postal_code, email: req.body.email || o.customer_email || 'receipt@example.invalid' });
  db.prepare('UPDATE orders SET shipping_json=?, tax_state=COALESCE(NULLIF(tax_state,\'\'), ?) WHERE id=?').run(JSON.stringify({ name: a.name, address: { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.zip, country: a.country } }), a.state, o.id);
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
  if (!o || !o.public_token || !safeEqual(receiptKey(req), o.public_token)) {
    return res.status(404).json({ error: 'Receipt not found' });
  }
  const items = db.prepare('SELECT name, unit_price_cents, quantity, custom_json FROM order_items WHERE order_id=?').all(o.id).map((i) => ({ name: i.name, unit_price_cents: i.unit_price_cents, quantity: i.quantity, custom: parseCustom(i) }));
  res.json({
    id: o.id, created_at: o.created_at, channel: o.channel, payment_method: o.payment_method,
    status: o.status, subtotal_cents: o.subtotal_cents, shipping_cents: o.shipping_cents || 0, tax_cents: o.tax_cents, total_cents: o.total_cents,
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


// ---------- staff sign-in routes ----------
app.post('/api/admin/login', h(async (req, res) => {
  if (!ADMIN_PASSWORD) throw new HttpError(401, 'Sign-in is switched off until ADMIN_PASSWORD is set.');
  if (loginLocked(req)) throw new HttpError(429, 'Too many tries. Sign-in is paused for about 15 minutes.');
  const b = req.body || {};
  if (!safeEqual(String(b.password || ''), ADMIN_PASSWORD)) { loginFailed(req, 'wrong password'); throw new HttpError(401, 'That password didn’t work'); }
  const secret = getSetting('totp_secret', '');
  if (secret) {
    const code = String(b.code || '').trim(), rec = String(b.recovery || '').trim();
    if (!code && !rec) { countLoginAttempt(req); return res.json({ need_code: true }); }   // a right password with no code still counts, so it can't be used to test passwords for free
    if (rec) {
      const list = JSON.parse(getSetting('totp_recovery', '') || '[]');
      const hash = Auth.hashRecovery(rec);
      const i = list.indexOf(hash);
      if (i < 0) { loginFailed(req, 'wrong recovery code'); throw new HttpError(401, 'That recovery code didn’t work'); }
      list.splice(i, 1); setSetting('totp_recovery', JSON.stringify(list));
      logSecurity('admin_recovery_used', req, `${list.length} left`);
    } else {
      const step = Auth.checkTotp(secret, code);
      if (step === null || step <= Number(getSetting('totp_last_step', '0'))) { loginFailed(req, 'wrong code'); throw new HttpError(401, 'That code didn’t work. Check the time on your phone, or wait for a new code.'); }
      setSetting('totp_last_step', String(step));
    }
  }
  // (failed attempts are no longer wiped by a success: otherwise the owner signing in would reset a stranger's count on a shared connection)
  logSecurity('admin_login', req);
  res.json({ ...startSession(req), device_token: trustDevice(req) });
}));
app.post('/api/admin/logout', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(Auth.hashToken(req.get('x-admin-token')));
  res.json({ ok: true });
});
// Sensitive actions (signing out everywhere, changing two-step sign-in) need the password again, and the current
// authenticator code if two-step is on, so a stolen session alone can't lock the owner out or take over.
const tfaGuard = (req) => { if (rlCount('tfa:' + ipKey(req), 10 * 60e3) >= 10) throw new HttpError(429, 'Too many tries. Wait a few minutes.'); };
function confirmOwner(req) {
  tfaGuard(req);
  const b = req.body || {};
  const fail = (msg, why) => { rlAdd('tfa:' + ipKey(req)); logSecurity('admin_confirm_failed', req, why); throw new HttpError(400, msg); };
  if (!ADMIN_PASSWORD || !safeEqual(String(b.password || ''), ADMIN_PASSWORD)) fail('Enter your password to do this.', 'wrong password');
  const secret = getSetting('totp_secret', '');
  if (secret) {
    const step = Auth.checkTotp(secret, b.code);
    if (step === null || step <= Number(getSetting('totp_last_step', '0'))) fail('Enter a new code from your authenticator app. If you just used one, wait for the next code.', 'wrong code');
    setSetting('totp_last_step', String(step));
  }
}
app.post('/api/admin/logout-all', requireAdmin, h(async (req, res) => {
  confirmOwner(req);
  db.prepare('DELETE FROM admin_sessions').run();
  db.prepare('DELETE FROM trusted_devices').run();
  logSecurity('admin_logout_all', req);
  res.json({ ok: true });
}));

// Two-step sign-in (authenticator app)
app.post('/api/admin/2fa/start', requireAdmin, h(async (req, res) => {
  if (getSetting('totp_secret', '')) throw new HttpError(400, 'Two-step sign-in is already on.');
  confirmOwner(req);
  const secret = Auth.newSecret();
  setSetting('totp_pending', secret);
  const url = Auth.otpauthUrl(secret, getSetting('store_name', 'Outpost') || 'Outpost', 'Outpost');
  res.json({ secret, qr: await QRCode.toDataURL(url, { width: 220, margin: 1 }) });
}));
app.post('/api/admin/2fa/enable', requireAdmin, h(async (req, res) => {
  if (getSetting('totp_secret', '')) throw new HttpError(400, 'Two-step sign-in is already on.');
  confirmOwner(req);
  const secret = getSetting('totp_pending', '');
  if (!secret) throw new HttpError(400, 'Start setup again.');
  const step = Auth.checkTotp(secret, (req.body || {}).code);
  if (step === null) { rlAdd('tfa:' + ipKey(req)); throw new HttpError(400, 'That code didn’t match. Check the 6 digits and try again.'); }
  const codes = Auth.newRecoveryCodes(8);
  setSetting('totp_secret', secret); setSetting('totp_pending', ''); setSetting('totp_last_step', String(step));
  setSetting('totp_recovery', JSON.stringify(codes.map(Auth.hashRecovery)));
  logSecurity('admin_2fa_on', req);
  res.json({ recovery_codes: codes });
}));
app.post('/api/admin/2fa/disable', requireAdmin, h(async (req, res) => {
  if (!getSetting('totp_secret', '')) return res.json({ ok: true });
  confirmOwner(req);   // password + a code that hasn't been used yet
  for (const k of ['totp_secret', 'totp_pending', 'totp_recovery', 'totp_last_step']) setSetting(k, '');
  logSecurity('admin_2fa_off', req);
  res.json({ ok: true });
}));

// ---------- admin API: status, settings, products, orders ----------
app.get('/api/admin/status', requireAdmin, (req, res) => {
  res.json({ stripe: !!stripe, webhook: !!process.env.STRIPE_WEBHOOK_SECRET, base_url: BASE_URL, two_step: !!getSetting('totp_secret', ''), recovery_left: getSetting('totp_secret', '') ? JSON.parse(getSetting('totp_recovery', '') || '[]').length : 0 });
});

// Is Stripe Tax switched on in the seller's Stripe account? Best effort: if Stripe can't say, we say "unknown".
let taxStatusCache = null;
app.get('/api/admin/tax-status', requireAdmin, h(async (req, res) => {
  if (!stripe) return res.json({ state: 'no_stripe' });
  if (taxStatusCache && Date.now() - taxStatusCache.t < 30e3) return res.json(taxStatusCache.v);
  let v;
  try { const st = await stripe.tax.settings.retrieve(); v = { state: st.status === 'active' ? 'active' : 'pending' }; } catch { v = { state: 'unknown' }; }
  taxStatusCache = { t: Date.now(), v };
  res.json(v);
}));

app.put('/api/admin/settings', requireAdmin, h(async (req, res) => {
  const { links, links_intro, mailing_list_on, policy, shipping, tax_home, tax_rate, store_name, break_on, break_message, theme, logo_url, mascot_url, sold_url, break_from, break_until, low_stock, refund_preset, refund_days, refund_text, max_qty, handmade_statement, about_text, social, ship_days, reviews_on, bid_card_required, block_ai } = req.body;
  if (links !== undefined) setSetting('links_json', JSON.stringify(cleanLinks(links)));
  if (links_intro !== undefined) setSetting('links_intro', String(links_intro).trim().slice(0, 200));
  if (mailing_list_on !== undefined) setSetting('mailing_list_on', mailing_list_on ? '1' : '');
  if (policy !== undefined) setSetting('policy_json', JSON.stringify(cleanPolicy(policy)));
  if (shipping !== undefined) setSetting('shipping_json', JSON.stringify(cleanShipping(shipping)));
  if (tax_home !== undefined) setSetting('tax_home', US_STATES.has(String(tax_home).toUpperCase()) ? String(tax_home).toUpperCase() : '');
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
  if (bid_card_required !== undefined) {
    if (bid_card_required && !stripe) throw new HttpError(400, 'Add your Stripe keys first. A card can only be saved through Stripe.');
    setSetting('bid_card_required', bid_card_required ? '1' : '');
  }
  if (block_ai !== undefined) setSetting('block_ai', block_ai ? '1' : '0');
  if (refund_text !== undefined) setSetting('refund_text', String(refund_text).trim().slice(0, 1500));
  if (break_on !== undefined) setSetting('break_on', break_on ? '1' : '');
  if (break_message !== undefined) setSetting('break_message', String(break_message).trim().slice(0, 200));
  res.json({ ok: true, ...settingsPayload(), links_all: linksAll() });
}));

app.get('/api/admin/links', requireAdmin, (req, res) => {
  res.json({ links: linksAll(), links_intro: getSetting('links_intro', ''), mailing_list_on: getSetting('mailing_list_on', '') === '1' });
});

// ---------- email list (download as CSV and import into your own email service; Outpost sends no email) ----------
const subscribeLimit = (req) => {
  if (isBlocked('ip', req.ip)) { logSecurity('blocked_ip', req, 'subscribe'); throw new HttpError(403, GENERIC_REJECT); }
  if (rlCount('sub1:' + ipKey(req), 3600e3) >= 8 || rlCount('suball', 3600e3) >= SUBSCRIBE_ALL_PER_HOUR) { logSecurity('subscribe_rate', req); throw new HttpError(429, 'Too many tries. Please wait a bit and try again.'); }
  rlAdd('sub1:' + ipKey(req)); rlAdd('suball');
};
app.post('/api/subscribe', h(async (req, res) => {
  if (getSetting('mailing_list_on', '') !== '1') throw new HttpError(404, 'The email list is not open right now.');
  if (req.body.website) return res.json({ ok: true });   // honeypot: pretend it worked
  if (!formTokenOk(req.body.started)) { logSecurity('too_fast', req, 'subscribe'); throw new HttpError(429, GENERIC_REJECT); }
  subscribeLimit(req);
  const email = Safe.cleanEmail(req.body.email);
  if (!Safe.validEmail(email)) throw new HttpError(400, 'Please enter a valid email address');
  if (req.body.consent !== true) throw new HttpError(400, 'Please tick the box so we know you want emails');
  if (db.prepare('SELECT COUNT(*) c FROM subscribers').get().c >= LIST_MAX.subscribers) { logSecurity('list_full', req, 'subscribers'); throw new HttpError(503, 'The email list is not taking sign-ups right now.'); }
  const source = String(req.body.source || 'links').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'links';
  db.prepare('INSERT INTO subscribers (email, source, created_at, unsubscribed) VALUES (?,?,?,0) ON CONFLICT(email) DO UPDATE SET unsubscribed=0').run(email, source, Date.now());
  res.json({ ok: true });
}));
app.get('/api/admin/subscribers', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT id, email, source, created_at, unsubscribed FROM subscribers ORDER BY created_at DESC, id DESC').all());
});
app.get('/api/admin/subscribers.csv', requireAdmin, (req, res) => {
  const q = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const rows = db.prepare('SELECT email, source, created_at, unsubscribed FROM subscribers ORDER BY created_at, id').all();
  const lines = ['email,joined,source,status'].concat(rows.map((r) => [q(r.email), new Date(r.created_at).toISOString().slice(0, 10), q(r.source), r.unsubscribed ? 'unsubscribed' : 'subscribed'].join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.send(lines.join('\n') + '\n');
});
app.delete('/api/admin/subscribers/:id', requireAdmin, (req, res) => {
  db.prepare('DELETE FROM subscribers WHERE id=?').run(Number(req.params.id) || 0);
  res.json({ ok: true });
});


// ---------- product lines (curated groups like "Frogs"; a product can be in several) ----------
const slugify = (t) => String(t || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'line';
function uniqueSlug(name, ownId = 0) {
  const base = slugify(name); let slug = base, i = 2;
  while (db.prepare('SELECT id FROM lines WHERE slug=? AND id<>?').get(slug, ownId)) slug = base + '-' + i++;
  return slug;
}
function lineIdsFor(productId) { return db.prepare('SELECT line_id FROM product_lines WHERE product_id=?').all(productId).map((r) => r.line_id); }
function cleanLineIds(ids) {
  if (!Array.isArray(ids)) throw new HttpError(400, 'Lines must be a list');
  const valid = new Set(db.prepare('SELECT id FROM lines').all().map((r) => r.id));
  return [...new Set(ids.map(Number).filter((i) => valid.has(i)))];
}
function saveProductLines(productId, ids) {
  db.prepare('DELETE FROM product_lines WHERE product_id=?').run(productId);
  const ins = db.prepare('INSERT INTO product_lines (product_id, line_id) VALUES (?,?)');
  for (const l of ids) ins.run(productId, l);
}
function shapeLine(l) {
  const ids = db.prepare('SELECT pl.product_id AS id FROM product_lines pl JOIN products p ON p.id=pl.product_id WHERE pl.line_id=? AND p.active=1 ORDER BY p.name').all(l.id).map((r) => r.id);
  let cover = l.image_url || '';
  if (!cover && ids.length) { const p = db.prepare('SELECT images, image_url FROM products WHERE id=?').get(ids[0]); cover = p ? p.image_url || '' : ''; }
  return { id: l.id, name: l.name, slug: l.slug, blurb: l.blurb, image_url: l.image_url, cover, active: l.active, count: ids.length, ids };
}
function cleanLine(b, base) {
  const n = { ...base };
  if ('name' in b) { n.name = String(b.name || '').trim().slice(0, 40); if (!n.name) throw new HttpError(400, 'Your line needs a name'); }
  if ('blurb' in b) n.blurb = String(b.blurb || '').trim().slice(0, 300);
  if ('image_url' in b) { const u = String(b.image_url || '').trim(); if (u && !/^\/images\/[\w.\-]+$/.test(u)) throw new HttpError(400, 'Pick a photo you uploaded'); n.image_url = u; }
  if ('active' in b) n.active = b.active ? 1 : 0;
  return n;
}

// Public: lines that are shown and have something for sale in them
app.get('/api/lines', (req, res) => {
  const rows = db.prepare('SELECT * FROM lines WHERE active=1 ORDER BY position, id').all().map(shapeLine).filter((l) => l.count > 0);
  res.json(rows.map(({ image_url, active, ...l }) => l));
});

app.get('/api/admin/lines', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM lines ORDER BY position, id').all().map((l) => { const r = db.prepare('SELECT product_id FROM product_lines WHERE line_id=?').all(l.id).map((x) => x.product_id); return { ...shapeLine(l), ids: r, count: r.length }; }));
});
app.post('/api/admin/lines', requireAdmin, h(async (req, res) => {
  const n = cleanLine(req.body, { name: '', blurb: '', image_url: '', active: 1 });
  if (db.prepare('SELECT COUNT(*) c FROM lines').get().c >= 30) throw new HttpError(400, 'That’s plenty of lines. Delete one you don’t use before adding another.');
  const pos = db.prepare('SELECT COALESCE(MAX(position),0)+1 p FROM lines').get().p;
  const r = db.prepare('INSERT INTO lines (name, slug, blurb, image_url, position, active) VALUES (?,?,?,?,?,?)').run(n.name, uniqueSlug(n.name), n.blurb, n.image_url, pos, n.active);
  const id = Number(r.lastInsertRowid);
  if ('product_ids' in req.body) setLineProducts(id, req.body.product_ids);
  res.json({ id });
}));
function setLineProducts(lineId, ids) {
  if (!Array.isArray(ids)) throw new HttpError(400, 'Products must be a list');
  const valid = new Set(db.prepare('SELECT id FROM products').all().map((r) => r.id));
  const keep = [...new Set(ids.map(Number).filter((i) => valid.has(i)))];
  db.transaction(() => {
    db.prepare('DELETE FROM product_lines WHERE line_id=?').run(lineId);
    const ins = db.prepare('INSERT INTO product_lines (product_id, line_id) VALUES (?,?)');
    for (const p of keep) ins.run(p, lineId);
  })();
}
app.put('/api/admin/lines/order', requireAdmin, h(async (req, res) => {
  if (!Array.isArray(req.body.ids)) throw new HttpError(400, 'Bad order');
  const up = db.prepare('UPDATE lines SET position=? WHERE id=?');
  db.transaction(() => req.body.ids.forEach((id, i) => up.run(i + 1, Number(id))))();
  res.json({ ok: true });
}));
app.put('/api/admin/lines/:id', requireAdmin, h(async (req, res) => {
  const l = db.prepare('SELECT * FROM lines WHERE id=?').get(req.params.id);
  if (!l) throw new HttpError(404, 'Not found');
  const n = cleanLine(req.body, l);
  const slug = n.name !== l.name ? uniqueSlug(n.name, l.id) : l.slug;
  db.prepare('UPDATE lines SET name=?, slug=?, blurb=?, image_url=?, active=? WHERE id=?').run(n.name, slug, n.blurb, n.image_url, n.active, l.id);
  if ('product_ids' in req.body) setLineProducts(l.id, req.body.product_ids);
  res.json({ ok: true });
}));
app.delete('/api/admin/lines/:id', requireAdmin, h(async (req, res) => {
  db.prepare('DELETE FROM lines WHERE id=?').run(req.params.id);
  res.json({ ok: true });
}));

app.get('/api/admin/products', requireAdmin, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY name').all().map((p) => shapeProduct(p, true)));
});

app.get('/api/admin/products/:id', requireAdmin, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json({ ...shapeProduct(p, true), line_ids: lineIdsFor(p.id) });
});

app.post('/api/admin/products', requireAdmin, h(async (req, res) => {
  const vs = 'variants' in req.body ? cleanVariants(req.body.variants) : [];
  if (vs.length) req.body.stock = vs.reduce((a, v) => a + v.stock, 0);
  const n = cleanProduct(req.body, NEW_PRODUCT);
  checkSkus(0, n.sku, vs);
  const lineIds = 'line_ids' in req.body ? cleanLineIds(req.body.line_ids) : null;
  const id = db.transaction(() => {
    const r = db.prepare(
      `INSERT INTO products (name, price_cents, stock, description, category, tags, images, image_url, active, badge, process, sku, option_label, custom_fields)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(n.name, n.price_cents, n.stock, n.description, n.category, n.tags, n.images, n.image_url, n.active, n.badge || '', n.process || '', n.sku || '', n.option_label || '', n.custom_fields || '[]');
    if (vs.length) saveVariants(Number(r.lastInsertRowid), vs);
    if (lineIds) saveProductLines(Number(r.lastInsertRowid), lineIds);
    return Number(r.lastInsertRowid);
  })();
  res.json({ id });
}));

app.put('/api/admin/products/:id', requireAdmin, h(async (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) throw new HttpError(404, 'Not found');
  const hasV = 'variants' in req.body;
  const vs = hasV ? cleanVariants(req.body.variants) : null;
  // The edit form remembers the stock it was opened with. If the number was left alone, the stock as it is NOW is kept (so a sale made
  // meanwhile is not undone by saving some other field); if it was changed but the stock has moved since, the save is refused (review item 61).
  const stale = (name, now, was, mine) => {
    if (was == null) return mine;
    if (mine === was) return now;
    if (now !== was) throw new HttpError(409, `The stock for "${name}" changed while you had this open (it is now ${now}). Reload the page and try again.`);
    return mine;
  };
  if (vs && vs.length) {
    const cur = new Map(db.prepare('SELECT id, stock FROM variants WHERE product_id=?').all(p.id).map((r) => [r.id, r.stock]));
    for (const v of vs) if (v.id && cur.has(v.id)) v.stock = stale(v.name, cur.get(v.id), v.stock_was, v.stock);
  }
  if (vs && vs.length) req.body.stock = vs.reduce((a, v) => a + v.stock, 0);
  else if (!hasV && activeVariants(p.id).length) req.body.stock = p.stock;
  else if (!activeVariants(p.id).length && 'stock_was' in req.body) {
    const sw = Number(req.body.stock_was), mine = Number(req.body.stock);
    if (Number.isInteger(sw) && Number.isInteger(mine)) req.body.stock = stale(p.name, p.stock, sw, mine);
  }
  const n = cleanProduct(req.body, p);
  checkSkus(p.id, n.sku, vs || []);
  const lineIds = 'line_ids' in req.body ? cleanLineIds(req.body.line_ids) : null;
  db.transaction(() => {
    db.prepare(
      `UPDATE products SET name=?, price_cents=?, stock=?, description=?, category=?, tags=?, images=?, image_url=?, active=?, badge=?, process=?, sku=?, option_label=?, custom_fields=?
       WHERE id=?`
    ).run(n.name, n.price_cents, n.stock, n.description, n.category, n.tags, n.images, n.image_url, n.active, n.badge || '', n.process || '', n.sku || '', n.option_label || '', n.custom_fields || '[]', p.id);
    if (hasV) saveVariants(p.id, vs);
    if (lineIds) saveProductLines(p.id, lineIds);
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
// The refund is written down as "intended" BEFORE Stripe is asked (guarded in the database, so two at once can't both pass), and Stripe is given a key that is the same
// for the same refund, so asking twice can't refund twice. If Outpost stops or Stripe doesn't answer, the next try first asks Stripe what really happened.
const refunding = new Set();
const stripeSaidNo = (e) => !!e && ['StripeCardError', 'StripeInvalidRequestError', 'StripePermissionError', 'StripeAuthenticationError', 'StripeIdempotencyError'].includes(e.type);
async function reconcileRefunds(o) {
  const list = await stripe.refunds.list({ payment_intent: o.stripe_payment_intent, limit: 100 });
  const total = (list.data || []).filter((r) => r.status !== 'failed' && r.status !== 'canceled').reduce((a, r) => a + (r.amount || 0), 0);
  return applyRefundedTotal(o.id, total);   // also clears the "refund started" note
}
app.post('/api/admin/orders/:id/refund', requireAdmin, h(async (req, res) => {
  const id = Number(req.params.id);
  if (refunding.has(id)) throw new HttpError(409, 'A refund for this order is already in progress');
  refunding.add(id);
  let claimed = false, keepNote = false;
  try {
    let o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'Not found');
    if (o.status !== 'paid') throw new HttpError(400, o.status === 'refunded' ? 'This order is already fully refunded' : 'Only paid orders can be refunded');
    const cardPay = o.payment_method === 'card' && !req.body.already_refunded;
    let pi = o.stripe_payment_intent;
    if (stripe && o.payment_method === 'card' && !pi && o.stripe_session_id && (cardPay || o.refund_intent_cents > 0)) {
      const sess = await stripe.checkout.sessions.retrieve(o.stripe_session_id);
      pi = typeof sess.payment_intent === 'string' ? sess.payment_intent : sess.payment_intent && sess.payment_intent.id;
      if (pi) db.prepare('UPDATE orders SET stripe_payment_intent=? WHERE id=?').run(pi, o.id);
    }
    if (o.refund_intent_cents > 0) {
      // A refund was started earlier and we never heard how it ended. Ask Stripe what really happened before doing anything else.
      const wanted = o.refund_intent_cents, before = o.refunded_cents;
      if (stripe && pi) await reconcileRefunds({ ...o, stripe_payment_intent: pi });
      else db.prepare("UPDATE orders SET refund_intent_cents=0, refund_key='' WHERE id=?").run(id);
      o = db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      // The refund that was started DID go through: it is now recorded, and asking for the same amount again means "that one", not a second refund.
      if (o.refunded_cents >= before + wanted && Number(req.body.amount_cents) === wanted) {
        return res.json({ ok: true, via_stripe: true, already_done: true, refunded_cents: o.refunded_cents, status: o.status === 'refunded' ? 'refunded' : 'paid', restocked: o.restock_requested === 2, restock_waiting: o.restock_requested === 1 });
      }
      if (o.status !== 'paid') throw new HttpError(400, 'An earlier refund of this order had gone through. It is now fully refunded.');
    }
    const left = o.total_cents - o.refunded_cents;
    if (req.body.amount_cents === undefined || req.body.amount_cents === null || req.body.amount_cents === '') throw new HttpError(400, 'Enter the amount to refund');
    const amount = Number(req.body.amount_cents);
    if (!Number.isInteger(amount) || amount < 1 || amount > left) throw new HttpError(400, `Refund must be between $0.01 and $${(left / 100).toFixed(2)}`);
    const note = String(req.body.note || '').trim().slice(0, 300);
    const key = `refund-${id}-${o.refunded_cents}-${amount}`;
    // The claim: only one refund can be started at a time, and never for more than what is left. Done in one database step.
    const got = db.prepare("UPDATE orders SET refund_intent_cents=?, refund_key=? WHERE id=? AND status='paid' AND refund_intent_cents=0 AND refunded_cents=? AND refunded_cents + ? <= total_cents").run(amount, key, id, o.refunded_cents, amount);
    if (!got.changes) throw new HttpError(409, 'This order changed while you were refunding it. Reload and try again.');
    claimed = true;
    let viaStripe = false;
    if (cardPay) {
      if (!stripe) throw new HttpError(503, 'Stripe is not connected. Refund it in your Stripe dashboard, then tick "I already refunded this elsewhere".');
      if (!pi) throw new HttpError(400, 'Could not find the Stripe payment for this order. Refund it in your Stripe dashboard, then tick "I already refunded this elsewhere".');
      stillSignedIn(req);   // signed out everywhere while we were looking things up? Then stop before any money moves
      try {
        await stripe.refunds.create({ payment_intent: pi, amount, metadata: { order_id: String(o.id) } }, { idempotencyKey: key });
      } catch (e) {
        if (stripeSaidNo(e)) throw e;   // Stripe clearly refused: nothing was refunded
        keepNote = true;                // no clear answer: the refund may have happened, so the note stays and the next try checks Stripe first
        throw new HttpError(502, 'Stripe did not answer, so the refund may or may not have gone through. Try again in a minute: Outpost checks Stripe first, so it cannot be refunded twice.');
      }
      viaStripe = true;
    }
    const newTotal = o.refunded_cents + amount;
    let after;
    db.transaction(() => {
      db.prepare("UPDATE orders SET refund_note=?, restock_requested=CASE WHEN ? AND restock_requested=0 THEN 1 ELSE restock_requested END WHERE id=?").run(note || null, req.body.restock ? 1 : 0, o.id);
      after = applyRefundedTotal(o.id, newTotal);
    })();
    claimed = false;
    res.json({ ok: true, via_stripe: viaStripe, refunded_cents: after.refunded_cents, status: after.status === 'refunded' ? 'refunded' : 'paid',
      restocked: after.restock_requested === 2, restock_waiting: after.restock_requested === 1 });
  } finally {
    if (claimed && !keepNote) { try { db.prepare("UPDATE orders SET refund_intent_cents=0, refund_key='' WHERE id=?").run(id); } catch { /* ignore */ } }
    refunding.delete(id);
  }
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
<div class="no-print note">To print this page or save it as a PDF, press Ctrl+P (Command+P on a Mac).</div>
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
// Streams a tar of the files one after another (nothing is read into memory whole).
async function* tarStream(entries) {
  const now = Math.floor(Date.now() / 1000);
  for (const f of entries) {
    const hd = Buffer.alloc(512);
    hd.write(f.name.slice(0, 99), 0, 'utf8');
    hd.write('0000600\0', 100); hd.write('0000000\0', 108); hd.write('0000000\0', 116);
    hd.write(f.size.toString(8).padStart(11, '0') + '\0', 124);
    hd.write(now.toString(8).padStart(11, '0') + '\0', 136);
    hd.write('        ', 148); hd.write('0', 156); hd.write('ustar\0', 257); hd.write('00', 263);
    let sum = 0; for (const b of hd) sum += b;
    hd.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    yield hd;
    let sent = 0;
    if (f.size > 0) for await (const chunk of fs.createReadStream(f.file, { start: 0, end: f.size - 1 })) { sent += chunk.length; yield chunk; }
    if (sent < f.size) yield Buffer.alloc(f.size - sent);   // the file got shorter while backing up: pad, so the archive stays valid
    yield Buffer.alloc((512 - (f.size % 512)) % 512);
  }
  yield Buffer.alloc(1024);
}

// The backup is a copy of the database plus the photos. The copy is cleaned first: it does NOT contain the two-step sign-in secret and recovery codes,
// signed-in sessions, sign-in attempts or the security log (which holds visitors' addresses). Restoring it therefore turns two-step sign-in off; turn it on again afterwards.
app.get('/api/admin/backup', requireAdmin, h(async (req, res) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-bk-'));   // a private folder (only this program can open it), removed whatever happens
  try {
    const tmp = path.join(dir, 'outpost.db');
    await db.backup(tmp);
    const copy = new Database(tmp);
    try {
      copy.exec(`DELETE FROM settings WHERE key IN ('totp_secret','totp_pending','totp_recovery','totp_last_step','form_secret');
        DELETE FROM admin_sessions; DELETE FROM trusted_devices; DELETE FROM login_attempts; DELETE FROM security_events; VACUUM;`);
    } finally { copy.close(); }
    const entries = [{ name: 'outpost.db', file: tmp, size: fs.statSync(tmp).size }];
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      if (/^[\w.-]+$/.test(f) && fs.statSync(p).isFile()) entries.push({ name: 'images/' + f, file: p, size: fs.statSync(p).size });
    }
    res.set({ 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="outpost-backup-${todayStr()}.tar.gz"` });
    try { await pipeline(Readable.from(tarStream(entries)), zlib.createGzip(), res); }
    catch (e) { console.error('backup stopped part-way:', e && e.message); res.destroy(); }   // headers are already sent: the download just ends
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
}));

app.get('/api/admin/security', requireAdmin, (req, res) => {
  const since = Date.now() - 24 * 3600e3;
  const counts = db.prepare('SELECT kind, COUNT(*) n FROM security_events WHERE at >= ? GROUP BY kind ORDER BY n DESC').all(since);
  const recent = db.prepare('SELECT at, kind, ip, detail FROM security_events ORDER BY id DESC LIMIT 25').all();
  const blocks = db.prepare('SELECT * FROM blocks ORDER BY id DESC').all();
  res.json({ last_24h: counts.reduce((a, c) => a + c.n, 0), counts, recent, blocks, captcha: !!TURNSTILE_SECRET, trust_proxy: !!process.env.TRUST_PROXY });
});
// What the "check your setup" list on the Security page needs. Nothing secret: the password is described, never shown.
app.get('/api/admin/setup-check', requireAdmin, (req, res) => {
  res.json({
    ip_seen: req.ip || '',
    trust_proxy: process.env.TRUST_PROXY || '',
    forwarded_for: String(req.get('x-forwarded-for') || '').slice(0, 300),
    cf_connecting_ip: String(req.get('cf-connecting-ip') || '').slice(0, 64),
    password: PW_PROBLEM ? { level: PW_PROBLEM.level, why: PW_PROBLEM.why } : null,
    base_url: BASE_URL, https: /^https:/i.test(BASE_URL), hosted: ON_INTERNET,
    captcha: !!TURNSTILE_SECRET, captcha_site: !!TURNSTILE_SITE,
    two_step: !!getSetting('totp_secret', ''),
    node: process.version,
    hsts_subdomains: process.env.HSTS_SUBDOMAINS === '1',
  });
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
  const value = b.value;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) throw new HttpError(400, 'Enter a discount amount');   // a number, not text like "10"
  if (b.min_subtotal_cents != null && b.min_subtotal_cents !== '' && typeof b.min_subtotal_cents !== 'number') throw new HttpError(400, 'Minimum must be a number');
  if (b.max_uses != null && b.max_uses !== '' && typeof b.max_uses !== 'number') throw new HttpError(400, 'Max uses must be a number');
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
  const q = (v) => { v = v == null ? '' : String(v); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };   // a leading = + - @ would run as a formula in Excel, so it gets a ' in front
  const rows = db.prepare("SELECT * FROM orders WHERE status IN ('paid','refunded') ORDER BY id").all();
  const lines = [['Order', 'Date', 'Channel', 'Payment', 'Status', 'Subtotal', 'Discount', 'Discount code', 'Shipping', 'Tax', 'Total', 'Refunded', 'Customer email', 'Fulfillment', 'Tracking', 'Items'].join(',')];
  for (const o of rows) {
    const items = db.prepare('SELECT name, quantity FROM order_items WHERE order_id=?').all(o.id).map((i) => `${i.quantity}x ${i.name}`).join('; ');
    const m = (c) => (c / 100).toFixed(2);
    lines.push([o.id, o.created_at, o.channel, o.payment_method, o.status, m(o.subtotal_cents), m(o.discount_cents), o.discount_code, m(o.shipping_cents || 0), m(o.tax_cents), m(o.total_cents), m(o.refunded_cents), o.customer_email, o.fulfillment, o.tracking_number, items].map(q).join(','));
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
    // Where the winner is decides shipping and tax. Without an address we charge neither (and don't auto-charge) rather than guess.
    let addr = null, shipping = 0, tax = 0;   // Stripe works it out from the winner's address
    if (needsAddress()) {
      const bd = db.prepare('SELECT address_json FROM bidders WHERE id=?').get(high.bidder_id);
      try { addr = bd && bd.address_json ? JSON.parse(bd.address_json) : null; } catch { addr = null; }
      if (addr) {
        try { shipping = shippingFor(addr, subtotal).cents; } catch { shipping = 0; }
        tax = taxFor(addr, subtotal).cents;   // 0 here when Stripe Tax is on: it's worked out when the card is charged
      }
    }
    const priced = {
      lines: [{ product_id: null, name: `${a.title} (Lot ${a.id})`, unit_price_cents: subtotal, quantity: 1 }],
      subtotal, tax, shipping, total: subtotal + shipping + tax,
    };
    const orderId = createOrder('auction', 'card', 'pending', priced, auctionId);
    if (addr) {
      db.prepare('UPDATE orders SET shipping_cents=?, shipping_json=?, customer_email=?, tax_state=? WHERE id=?').run(
        shipping, JSON.stringify({ name: addr.name, address: { line1: addr.line1, line2: addr.line2, city: addr.city, state: addr.state, postal_code: addr.zip, country: addr.country } }), addr.email, addr.state, orderId);
    }
    db.prepare("UPDATE auctions SET status='closed', winner_bid_id=?, order_id=?, pay_token=? WHERE id=?")
      .run(high.id, orderId, rid(16), auctionId);
  })();
}

const sweepFailedAt = new Map();   // auction id -> when settling it last threw, so one bad lot is retried gently
function sweepAuctions() {
  const due = db.prepare("SELECT id FROM auctions WHERE status='open' AND end_at <= ?").all(Date.now());
  for (const a of due) {
    if (Date.now() - (sweepFailedAt.get(a.id) || 0) < 60e3) continue;
    try { settleAuction(a.id); sweepFailedAt.delete(a.id); }
    catch (e) { sweepFailedAt.set(a.id, Date.now()); console.error(`could not close lot ${a.id}: ${e && e.message}`); }
  }
  if (due.length) setImmediate(autoChargeDue);
}
// Runs every 5 seconds. A problem in here is logged, never allowed to stop the shop.
setInterval(() => {
  try { sweepAuctions(); } catch (e) { console.error('auction sweep error:', e && e.message); }
  autoChargeDue().catch((e) => console.error('auto-charge error:', e && e.message));
}, 5000);

// Last-resort safety nets. A forgotten promise is logged and the shop keeps running; a truly
// unexpected crash is logged first (so the reason is in your Render logs) and then the app restarts.
process.on('unhandledRejection', (e) => console.error('unhandled promise rejection:', e && e.stack || e));
process.on('uncaughtException', (e) => { console.error('uncaught exception:', e && e.stack || e); process.exit(1); });

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
      out.you.charge = order.charge_status === 'recover' ? 'charging' : (order.charge_status || '');
      if (phase === 'paid') out.you.receipt_url = `${BASE_URL}/thanks.html?order=${order.id}#k=${order.public_token}`;
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
  // An older card page finished late must not replace a card saved from a newer one.
  if (bd.card_at && Number(s.created) * 1000 < bd.card_at) return null;
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
  if (rlCount('card:' + bidder.id, 10 * 60e3) >= 5 || rlCount('cardip:' + ipKey(req), 3600e3) >= 15) throw new HttpError(429, 'Too many tries. Please wait a few minutes.');
  rlAdd('card:' + bidder.id); rlAdd('cardip:' + ipKey(req));
  let cust = bidder.stripe_customer_id;
  if (!cust) {
    // Two taps of "Add card" at once make ONE Stripe customer (same key), and whichever is stored first is the one both use.
    const c = await stripe.customers.create({ email: bidder.email, name: bidder.name, metadata: { bidder_id: String(bidder.id) } }, { idempotencyKey: `outpost-bidder-customer-${bidder.id}` });
    db.prepare('UPDATE bidders SET stripe_customer_id=? WHERE id=? AND stripe_customer_id IS NULL').run(c.id, bidder.id);
    cust = db.prepare('SELECT stripe_customer_id c FROM bidders WHERE id=?').get(bidder.id).c;
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

// A bidder who joined before delivery addresses were needed adds theirs here.
app.post('/api/bidders/address', h(async (req, res) => {
  const bidder = bidderFromReq(req);
  if (!bidder) throw new HttpError(401, 'Please join first');
  if (rlCount('addr:' + bidder.id, 3600e3) >= 10) throw new HttpError(429, 'Too many tries. Please wait a bit.');
  rlAdd('addr:' + bidder.id);
  // Shipping for a win is worked out from this address, so it can't be swapped while the bidder is in a running lot or owes for a win.
  if (bidder.address_json) {
    const live = db.prepare("SELECT 1 FROM bids b JOIN auctions a ON a.id=b.auction_id WHERE b.bidder_id=? AND a.status='open' LIMIT 1").get(bidder.id);
    const owes = db.prepare("SELECT 1 FROM orders o JOIN auctions a ON a.id=o.auction_id JOIN bids b ON b.id=a.winner_bid_id WHERE b.bidder_id=? AND o.channel='auction' AND o.status='pending' LIMIT 1").get(bidder.id);
    if (live || owes) throw new HttpError(409, 'Your address is locked while you have a bid on a running lot or a win to pay for. Message the seller if it has to change.');
  }
  const addr = cleanAddress({ ...(req.body.address || {}), name: bidder.name, email: bidder.email });
  shippingFor(addr, 0);
  db.prepare('UPDATE bidders SET address_json=? WHERE id=?').run(JSON.stringify(addr), bidder.id);
  res.json({ ok: true });
}));

app.get('/card-saved', async (req, res) => {
  const lot = Number(req.query.lot) > 0 ? Number(req.query.lot) : '';
  let ok = false;
  // Each visit can cost a Stripe call, so each visitor gets a small allowance (a real card save needs one visit).
  if (rlCount('cardsaved:' + ipKey(req), 10 * 60e3) >= 20) return res.status(429).type('text/plain').send('Too many requests. Please wait a few minutes.');
  rlAdd('cardsaved:' + ipKey(req));
  try { ok = !!(stripe && req.query.session_id && (await saveCardFromSessionId(String(req.query.session_id)))); } catch (e) { console.error(e.message); }
  res.redirect(303, `/auction.html${lot ? '?lot=' + lot + '&' : '?'}card=${ok ? 'ok' : 'fail'}`);
});

function chargeError(e) {
  const code = e && (e.code || (e.raw && e.raw.code));
  if (code === 'authentication_required') return 'The bank wants the buyer to confirm this payment.';
  if (code === 'card_declined' || code === 'insufficient_funds' || code === 'expired_card') return 'The card was declined. (' + code.replace(/_/g, ' ') + ')';
  return String((e && e.message) || 'The charge did not go through').slice(0, 200);
}
// A charge counts as "in progress" while it is running, while it is being finished after a restart, and when the card WAS charged but the order has not been marked paid yet.
const chargeBusy = (o) => o.charge_status === 'charging' || o.charge_status === 'recover' || (o.charge_status === 'paid' && o.status === 'pending');
// A definite failure (declined card and so on) closes the attempt: any later try is a fresh one with its own key.
const markChargeFailed = (orderId, msg) => db.prepare("UPDATE orders SET charge_status='failed', charge_error=?, charge_attempt='' WHERE id=?").run(msg, orderId);

// The card was charged. Write that down FIRST (in one small step), then mark the order paid. If marking it paid fails, the charge
// stays recorded as taken, nothing is retried, and the next sweep finishes the job (review item 57).
function recordCharged(r, piId) {
  db.prepare("UPDATE orders SET stripe_payment_intent=?, charge_status='paid', charge_error=NULL, charge_attempt='' WHERE id=?").run(piId, r.id);
  try { fulfillOrder(r.id, { email: r.email, payment_intent: piId }); }
  catch (e) { console.error(`order #${r.id} was charged but could not be marked paid yet: ${e && e.message}`); logSecurity('charged_not_recorded', null, `order #${r.id} was charged (${piId}) but not yet marked paid. It will be retried.`); }
}
const AFTER_CHARGE_STATES = new Set(['succeeded', 'processing']);
// Look for a payment already made for this order (used after a restart, when we can't be sure whether the first try went through).
async function findIntentForOrder(customer, orderId, sinceMs) {
  const list = await stripe.paymentIntents.list({ customer, limit: 20, created: { gte: Math.max(0, Math.floor(sinceMs / 1000) - 120) } });
  return (list.data || []).find((p) => p.metadata && p.metadata.order_id === String(orderId) && AFTER_CHARGE_STATES.has(p.status)) || null;
}

let chargingNow = false;
const chargeWait = new Map();   // order id -> don't look at it again before this time (so a problem is retried gently, not every 5 seconds)
async function autoChargeDue() {
  if (!bidCardOn() || chargingNow) return;
  chargingNow = true;
  try {
    // Finish orders whose card was charged but which are not marked paid yet.
    for (const o of db.prepare("SELECT id, stripe_payment_intent pi, customer_email email FROM orders WHERE channel='auction' AND status='pending' AND charge_status='paid'").all()) {
      try { fulfillOrder(o.id, { email: o.email, payment_intent: o.pi }); } catch (e) { console.error(`order #${o.id}: still could not be marked paid: ${e && e.message}`); }
    }
    const needAddr = needsAddress() ? 1 : 0;
    const rows = db.prepare(`SELECT o.id, o.total_cents, o.subtotal_cents, o.shipping_cents, o.shipping_json, o.charge_status, o.charge_attempt, o.charge_amount, o.charge_calc, o.charge_started,
        a.id AS aid, a.title, bd.email, bd.stripe_customer_id AS cust, bd.stripe_payment_method AS pm
      FROM orders o JOIN auctions a ON a.order_id = o.id JOIN bids b ON b.id = a.winner_bid_id JOIN bidders bd ON bd.id = b.bidder_id
      WHERE o.channel='auction' AND o.status='pending' AND o.charge_status IN ('','recover') AND a.status='closed'
        AND (? = 0 OR o.shipping_json IS NOT NULL)
        AND bd.stripe_payment_method IS NOT NULL AND bd.stripe_customer_id IS NOT NULL`).all(needAddr);
    for (const r of rows) {
      if ((chargeWait.get(r.id) || 0) > Date.now()) continue;
      if (isBlocked('email', r.email)) { chargeWait.set(r.id, Date.now() + 3600e3); continue; }   // someone you blocked is never charged automatically
      if (!db.prepare("UPDATE orders SET charge_status='charging' WHERE id=? AND charge_status IN ('','recover') AND status='pending'").run(r.id).changes) continue;
      try {
        // A payment page for this order might be open (the buyer used the payment link): close them, and if one was paid, do not charge again.
        const pages = await closeOrderPages(r.id);
        if (pages.paid || pages.failed) { chargeWait.set(r.id, Date.now() + 60e3); db.prepare("UPDATE orders SET charge_status=? WHERE id=?").run(r.charge_attempt ? 'recover' : '', r.id); continue; }
        let amount, hooks, attempt = r.charge_attempt;
        if (r.charge_status === 'recover' && attempt) {
          // The app stopped in the middle of this charge. First see whether Stripe already took the money.
          const done = await findIntentForOrder(r.cust, r.id, r.charge_started || Date.now() - 24 * 3600e3);
          if (done) { recordCharged(r, done.id); continue; }
          amount = r.charge_amount;
          if (r.charge_calc) hooks = { inputs: { tax: { calculation: r.charge_calc } } };
        } else {
          amount = r.total_cents;
          let calcId = null;
          if (taxMode() === 'stripe' && r.shipping_json) {
            // Stripe Tax: ask Stripe what tax this address owes, then charge exactly that.
            const ad = (JSON.parse(r.shipping_json) || {}).address || {};
            const calc = await stripe.tax.calculations.create({
              currency: CURRENCY,
              line_items: [{ amount: r.subtotal_cents, reference: `lot-${r.aid}`, tax_behavior: 'exclusive' }],
              ...(r.shipping_cents > 0 ? { shipping_cost: { amount: r.shipping_cents, tax_behavior: 'exclusive' } } : {}),
              customer_details: { address: { line1: ad.line1, line2: ad.line2 || undefined, city: ad.city, state: ad.state, postal_code: ad.postal_code, country: ad.country }, address_source: 'shipping' },
            });
            amount = calc.amount_total; calcId = calc.id;
            hooks = { inputs: { tax: { calculation: calc.id } } };
            db.prepare('UPDATE orders SET tax_cents=?, total_cents=? WHERE id=?').run(calc.tax_amount_exclusive, amount, r.id);
          }
          attempt = rid(8);
          // Written down BEFORE Stripe is asked, so a restart can pick this exact attempt up again.
          db.prepare('UPDATE orders SET charge_attempt=?, charge_amount=?, charge_calc=?, charge_started=? WHERE id=?').run(attempt, amount, calcId, Date.now(), r.id);
        }
        const pi = await stripe.paymentIntents.create({
          amount, currency: CURRENCY, customer: r.cust, payment_method: r.pm, off_session: true, confirm: true,
          payment_method_types: ['card'], receipt_email: r.email, description: `${r.title} (Lot ${r.aid})`,
          metadata: { order_id: String(r.id), auction_id: String(r.aid) }, ...(hooks ? { hooks } : {}),
        }, { idempotencyKey: `outpost-lot-order-${r.id}-${attempt}` });
        if (pi.status === 'succeeded') recordCharged(r, pi.id);
        else markChargeFailed(r.id, 'The bank wants the buyer to confirm this payment.');
      } catch (e) {
        // Only a clear answer from Stripe (declined, refused...) counts as a failed charge. A network problem or crash while the
        // outcome is unknown stays "recover", so it is checked at Stripe next time instead of being charged or dropped blindly.
        const clear = e && (e.type === 'StripeCardError' || e.type === 'StripeInvalidRequestError' || e.type === 'StripePermissionError' || e.type === 'StripeAuthenticationError');
        if (clear || !r.charge_attempt && !db.prepare('SELECT charge_attempt a FROM orders WHERE id=?').get(r.id).a) markChargeFailed(r.id, chargeError(e));
        else { chargeWait.set(r.id, Date.now() + 30e3); db.prepare("UPDATE orders SET charge_status='recover' WHERE id=? AND charge_status='charging'").run(r.id); }
      }
    }
  } catch (e) { console.error('auto-charge error', e.message); }
  finally { chargingNow = false; }
}

// --- public ---
app.post('/api/bidders', h(async (req, res) => {
  await guardPublicForm(req, 'signup');
  if (rlCount('reg:' + ipKey(req), 3600e3) >= 5 || rlCount('regday:' + ipKey(req), 24 * 3600e3) >= 12) { logSecurity('signup_rate', req); throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.'); }
  // Rejected sign-ups are counted too (separately from successful ones), so junk can't be sent for free.
  if (rlCount('regbad:' + ipKey(req), 3600e3) >= 30) { logSecurity('signup_rate', req, 'many rejected'); throw new HttpError(429, 'Too many sign-ups from this connection. Try again later.'); }
  if (db.prepare('SELECT COUNT(*) c FROM bidders').get().c >= LIST_MAX.bidders) { logSecurity('list_full', req, 'bidders'); throw new HttpError(503, 'Bidder sign-ups are paused right now. Please try again later.'); }
  let name, email, addrJson = null;
  try {
    name = String(req.body.name || '').slice(0, 200).trim();
    email = Safe.cleanEmail(req.body.email);   // capped to 200 characters before any pattern check
    if (!name || name.length > 60) throw new HttpError(400, 'Please enter your name');
    if (!Safe.validEmail(email)) throw new HttpError(400, 'Please enter a valid email');
    if (DISPOSABLE.has(email.split('@')[1])) { logSecurity('disposable_email', req, email); throw new HttpError(400, 'Please use your real email address so the seller can reach you if you win.'); }
    if (isBlocked('email', email)) { logSecurity('blocked_email', req, email); throw new HttpError(403, GENERIC_REJECT); }
    if (db.prepare('SELECT COUNT(*) c FROM bidders WHERE lower(email)=?').get(email).c >= 5) { logSecurity('email_reuse', req, email); throw new HttpError(429, 'That email has been used to sign up too many times.'); }
    if (needsAddress()) {
      // Shipping and tax for a winning bid depend on where the item goes, so ask up front.
      if (!req.body.address) throw new HttpError(400, 'Please add your delivery address so the right shipping and tax can be worked out.');
      const addr = cleanAddress({ ...req.body.address, name, email });
      shippingFor(addr, 0);   // refuses addresses outside the regions you ship to
      addrJson = JSON.stringify(addr);
    }
  } catch (e) { rlAdd('regbad:' + ipKey(req)); throw e; }
  rlAdd('reg:' + ipKey(req)); rlAdd('regday:' + ipKey(req));
  const token = rid(24);
  db.prepare('INSERT INTO bidders (name, email, token, created_at, address_json) VALUES (?,?,?,?,?)').run(name, email, token, Date.now(), addrJson);
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
  if (needsAddress() && !bidder.address_json) {
    const e = new HttpError(428, 'Please add your delivery address to bid.'); e.extra = { need_address: true }; throw e;
  }
  if (rlCount('bidip:' + ipKey(req), 60e3) >= 90) { logSecurity('bid_rate', req); throw new HttpError(429, 'Slow down a little'); }
  rlAdd('bidip:' + ipKey(req));
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
    if (a.end_at - now <= SOFT_CLOSE_MS && a.extensions < SOFT_CLOSE_MAX) {
      db.prepare('UPDATE auctions SET end_at=?, extensions=extensions+1 WHERE id=?').run(now + SOFT_CLOSE_MS, a.id);
    }
  })();

  const a = db.prepare('SELECT * FROM auctions WHERE id=?').get(req.params.id);
  res.json(shapeAuction(a, { bidder }));
}));

// Winner's payment link: always valid until paid; starts a fresh Stripe page each visit.
app.get('/pay/:token', async (req, res) => {
  const text = (code, msg) => res.status(code).type('text/plain').send(msg);
  // Each visit can make Stripe calls, so limit it per visitor and per link.
  const tokKey = 'paytok:' + String(req.params.token).slice(0, 64);
  if (rlCount('pay:' + ipKey(req), 10 * 60e3) >= 30 || rlCount(tokKey, 10 * 60e3) >= 20) return text(429, 'Too many tries. Please wait a few minutes and try again.');
  rlAdd('pay:' + ipKey(req)); rlAdd(tokKey);
  try {
    const a = db.prepare('SELECT * FROM auctions WHERE pay_token=?').get(req.params.token);
    if (!a || !a.order_id) return text(404, 'This payment link is not valid.');
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(a.order_id);
    if (order.status === 'paid') return res.redirect(303, `/thanks.html?order=${order.id}#k=${order.public_token}`);
    if (order.status !== 'pending' || a.status !== 'closed') return text(410, 'This payment link is no longer active.');
    if (!stripe) return text(503, 'Card payments are not set up yet.');
    // The saved card is being charged right now: a second payment page would risk paying twice.
    if (chargeBusy(order)) return text(409, 'Your saved card is being charged right now. Please check back in a minute.');
    // If a payment page for this order is still open, send the buyer back to it instead of making another one.
    if (order.stripe_session_id) {
      try {
        const open = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
        if (open.status === 'open' && open.url && open.expires_at * 1000 > Date.now() + 10 * 60e3) return res.redirect(303, open.url);
      } catch { /* can't reuse it, so a new page is made below */ }
    }
    // Close any older payment pages for this order first, so only ever one can be paid (and say so if one already was).
    const closed = await closeOrderPages(order.id);
    if (closed.paid) return text(409, 'A payment for this order has just gone through. Please check back in a minute.');
    if (closed.failed) return text(503, 'Could not safely start a new payment page right now. Please try again in a few minutes.');
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
    const priced = {
      lines: items.map((i) => ({ name: i.name, unit_price_cents: i.unit_price_cents, quantity: i.quantity })),
      subtotal: order.subtotal_cents, tax: order.tax_cents, shipping: order.shipping_cents || 0, total: order.total_cents,
    };
    let haveAddr = false;
    if (order.shipping_json) {
      try {
        const sj = JSON.parse(order.shipping_json); const ad = sj.address || {};
        priced.address = { email: order.customer_email, name: sj.name, line1: ad.line1, line2: ad.line2, city: ad.city, state: ad.state, zip: ad.postal_code, country: ad.country };
        haveAddr = true;
        if (taxMode() === 'stripe') priced.tax = 0;   // Stripe works it out on its page
      } catch { /* fall through */ }
    }
    if (needsAddress() && !haveAddr) return text(409, 'The seller needs your delivery address before you can pay. Please contact the seller.');
    const session = await createStripeSession(order.id, priced, {
      collectShipping: !haveAddr, cancelUrl: `${BASE_URL}/auction.html?lot=${a.id}`, keepOnFail: true,
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
    const o = db.prepare('SELECT status, charge_status FROM orders WHERE id=?').get(a.order_id);
    if (o && o.status === 'paid') throw new HttpError(400, 'This lot has already been paid for');
    if (o && chargeBusy(o)) throw new HttpError(409, 'A card payment is being processed. Try again in a moment.');
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
  if (chargeBusy(order)) throw new HttpError(409, 'A card payment is being processed (or went through). Check Stripe and the order before moving on. Try again in a moment.');
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
