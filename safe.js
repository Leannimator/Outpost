'use strict';
// Small, fast checks for text that strangers (or a tricked owner) can send us.
// Everything here runs in time proportional to the input size, and caps its input first,
// so a huge body can never freeze the server (review items 1, 2 and 3).

const EMAIL_MAX = 120;      // longest email we accept
const EMAIL_LOOKAT = 200;   // never even look at more than this many characters
const REVIEW_LOOKAT = 4000; // look at no more than this much review text before tidying it
const REVIEW_MAX = 1000;    // longest review we store

// Trim, lower-case and cap an email BEFORE any pattern check.
function cleanEmail(raw) {
  return String(raw == null ? '' : raw).slice(0, EMAIL_LOOKAT).trim().toLowerCase();
}

// True if the email looks right. Length is checked first, so the pattern only ever sees short text.
function validEmail(email) {
  if (typeof email !== 'string' || email.length === 0 || email.length > EMAIL_MAX) return false;
  // A first character of = + - | is refused: spreadsheets treat it as a formula when the list is exported.
  return /^[^@\s=+\-|][^@\s]*@[^@\s]+\.[^@\s]+$/.test(email);
}

// Tidy review text: cap the input first, then trim and squash trailing spaces before line breaks.
function cleanReviewBody(raw) {
  return String(raw == null ? '' : raw)
    .slice(0, REVIEW_LOOKAT)
    .trim()
    .replace(/\s+\n/g, '\n')
    .slice(0, REVIEW_MAX);
}

// True if the start of a file is an SVG image. Walks the text once, with no backtracking:
// optional <?xml ...?>, any number of <!-- comments -->, optional <!DOCTYPE ...>, then <svg.
function looksLikeSvg(head) {
  const text = String(head);
  const low = text.toLowerCase();
  const n = text.length;
  let i = 0;
  const skipSpace = () => { while (i < n && /\s/.test(text[i])) i++; };
  skipSpace();
  if (low.startsWith('<?xml', i)) {
    const end = text.indexOf('>', i);
    if (end < 0) return false;
    i = end + 1; skipSpace();
  }
  while (text.startsWith('<!--', i)) {
    const end = text.indexOf('-->', i + 4);
    if (end < 0) return false;
    i = end + 3; skipSpace();
  }
  if (low.startsWith('<!doctype', i)) {
    const end = text.indexOf('>', i);
    if (end < 0) return false;
    i = end + 1; skipSpace();
  }
  return low.startsWith('<svg', i) && i + 4 < n && /[\s>]/.test(text[i + 4]);
}

// The name a visitor is counted under for rate limits. IPv4 addresses are used as they are.
// An IPv6 visitor normally owns a whole /64 block (billions of addresses), so those are grouped
// by their first 64 bits. Otherwise one person could look like endless different visitors.
function ipGroup(ip) {
  const raw = String(ip == null ? '' : ip).split('%')[0].toLowerCase();
  if (!raw.includes(':') || raw.startsWith('::ffff:')) return raw;   // IPv4 (or IPv4 inside IPv6): keep as is
  const [head, tail] = raw.split('::');
  const h = head ? head.split(':') : [];
  let groups = h;
  if (raw.includes('::')) {
    const t = tail ? tail.split(':') : [];
    groups = [...h, ...Array(Math.max(8 - h.length - t.length, 0)).fill('0'), ...t];
  }
  return groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':') + '::/64';
}

// Compares two texts without revealing, through timing, how long the right one is (both are hashed to the same length first).
const crypto = require('node:crypto');
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest(), hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- admin password strength (review item 16) ----
// 'hard' problems stop the app starting when it is reachable from the internet; 'soft' ones only show a warning.
const COMMON = new Set(['password', 'passw0rd', 'pass', 'admin', 'administrator', 'root', 'welcome', 'letmein', 'changeme', 'change-me', 'change_me',
  'qwerty', 'qwertyuiop', 'abc', 'abcdef', 'abcdefgh', 'iloveyou', 'monkey', 'dragon', 'master', 'login', 'secret', 'test', 'testing', 'demo',
  'outpost', 'shop', 'store', 'default', 'letmein1', 'trustno1', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman',
  'ashandanchor', 'ash-and-anchor', 'ashanchor']);
function passwordProblem(pw, extraWords = []) {
  const p = String(pw == null ? '' : pw);
  if (!p) return { level: 'hard', why: 'missing' };
  if (p.length < 8) return { level: 'hard', why: 'shorter than 8 characters' };
  const lower = p.toLowerCase();
  const core = lower.replace(/[^a-z]+$/g, '').replace(/^[^a-z]+/g, '');   // "Password1!" -> "password"
  const words = [...COMMON, ...extraWords.map((w) => String(w).toLowerCase()).filter((w) => w.length >= 4)];
  if (COMMON.has(lower) || COMMON.has(core) || words.includes(lower) || words.includes(core)) return { level: 'hard', why: 'a very common password' };
  if (/^(.)\1+$/.test(p)) return { level: 'hard', why: 'one character repeated' };
  if (/^(0123456789|1234567890|12345678|123456789|987654321|87654321)\d*$/.test(p) || /^\d+$/.test(p) && new Set(p).size <= 3) return { level: 'hard', why: 'a simple number pattern' };
  if (p.length < 12) return { level: 'soft', why: 'shorter than 12 characters' };
  if (new Set(p).size < 5) return { level: 'soft', why: 'uses very few different characters' };
  return null;
}

// An uploaded SVG is only ever shown through an <img> tag, under a locked-down policy. As a second lock, SVGs that carry scripts or embedded
// content are refused at upload, so they would be harmless even if a proxy stripped the policy. Plain checks only (no backtracking patterns).
function svgProblem(text) {
  const t = String(text || '').toLowerCase();
  for (const bad of ['<script', 'javascript:', '<foreignobject', '<iframe', '<embed', '<object', '<!entity', 'data:text/html']) if (t.includes(bad)) return bad;
  if (/\son[a-z]+\s*=/.test(t)) return 'event handler';
  return null;
}


// A money amount typed by a person, as cents, or NaN when it isn't clearly an amount.
// Accepts: 12  12.5  12.50  $12.50  12,50 (a comma then 1-2 digits is a decimal comma)  1,250  1,250.50 (commas before groups of exactly 3 digits are thousands separators).
// Refuses everything else ("1e2", "1,2,3", "12.345", "abc", "-5"): it used to read "12,50" as $1,250 and "1e2" as $100.
function parseMoneyCents(input) {
  let t = String(input == null ? '' : input).trim().slice(0, 30).replace(/^\$\s*/, '');
  if (!t) return NaN;
  let m;
  if ((m = /^(\d{1,3}(?:,\d{3})+)(?:\.(\d{1,2}))?$/.exec(t))) return Number(m[1].replace(/,/g, '')) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  if ((m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(t))) return Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
  return NaN;
}

module.exports = { parseMoneyCents, svgProblem, passwordProblem, safeEqual, cleanEmail, validEmail, cleanReviewBody, looksLikeSvg, ipGroup, EMAIL_MAX, REVIEW_MAX };
