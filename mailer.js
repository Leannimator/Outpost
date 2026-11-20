'use strict';
// Email for Outpost. Free-first: it talks to Resend's HTTPS API (not SMTP) and the key lives only in the RESEND_API_KEY environment variable,
// never in the database or the backup. Nothing here runs unless the owner turns email on and the key is present.
const crypto = require('node:crypto');

const API = () => (process.env.RESEND_API_URL || 'https://api.resend.com').replace(/\/$/, '');
const keyPresent = () => !!process.env.RESEND_API_KEY;

// Sends one message. Never throws. Result: { ok, id } or { ok:false, kind, status, error } where kind is
//   'config' (bad key / domain not verified: stop and tell the owner), 'retry' (rate limit, outage, network: try again later),
//   'recipient' (this address was refused: skip it, never retry).
async function sendMail({ from, to, reply_to, subject, text, html, headers, idempotencyKey }) {
  if (!keyPresent()) return { ok: false, kind: 'config', status: 0, error: 'No RESEND_API_KEY is set' };
  const body = { from, to: [to], subject, text, html };
  if (reply_to) body.reply_to = reply_to;
  if (headers && Object.keys(headers).length) body.headers = headers;
  try {
    const res = await fetch(API() + '/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: d.id || '' };
    const msg = String(d.message || d.error || res.statusText || 'Send failed').slice(0, 300);
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'config', status: res.status, error: msg };
    if (res.status === 429 || res.status >= 500) return { ok: false, kind: 'retry', status: res.status, error: msg };
    return { ok: false, kind: 'recipient', status: res.status, error: msg };
  } catch (e) {
    return { ok: false, kind: 'retry', status: 0, error: 'Could not reach the email service' };
  }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Plain text in, simple HTML out: paragraphs on blank lines, line breaks inside them, http(s) links made clickable. Nothing else is allowed through.
function textToHtml(text) {
  const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => { const tail = (u.match(/[.,;:!?)]+$/) || [''])[0]; const url = tail ? u.slice(0, -tail.length) : u; return `<a href="${url}">${url}</a>${tail}`; });
  return String(text || '').replace(/\r\n?/g, '\n').trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${linkify(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// The finished message for one person: body + footer (why they are getting it, unsubscribe link, mailing address) + one-click headers.
function compose({ body, shop, address, unsubUrl }) {
  const foot = [`You are getting this because you signed up for emails from ${shop}.`, `Unsubscribe: ${unsubUrl}`, address].filter(Boolean).join('\n');
  const text = String(body || '').trim() + '\n\n--\n' + foot + '\n';
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222;max-width:560px;margin:0 auto;padding:16px">${textToHtml(body)}
<hr style="border:0;border-top:1px solid #ddd;margin:24px 0 12px"><p style="font-size:12px;color:#777;margin:0">You are getting this because you signed up for emails from ${esc(shop)}.<br><a href="${esc(unsubUrl)}">Unsubscribe</a><br>${esc(address || '').replace(/\n/g, '<br>')}</p></div>`;
  return { text, html, headers: { 'List-Unsubscribe': `<${unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

// Resend signs webhooks with Svix: HMAC-SHA256 of "<id>.<timestamp>.<raw body>" using the base64 part of the whsec_ secret.
function verifyWebhook(rawBody, h, secret, now = Date.now()) {
  if (!secret || !h['svix-id'] || !h['svix-timestamp'] || !h['svix-signature']) return false;
  const ts = Number(h['svix-timestamp']); if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return false;
  const key = Buffer.from(String(secret).replace(/^whsec_/, ''), 'base64');
  const want = crypto.createHmac('sha256', key).update(`${h['svix-id']}.${h['svix-timestamp']}.${rawBody}`).digest();
  return String(h['svix-signature']).split(' ').some((part) => {
    const [v, sig] = part.split(','); if (v !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64'); return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}

module.exports = { sendMail, compose, textToHtml, verifyWebhook, keyPresent };
