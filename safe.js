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
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
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

module.exports = { cleanEmail, validEmail, cleanReviewBody, looksLikeSvg, ipGroup, EMAIL_MAX, REVIEW_MAX };
