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


// ---- Designed emails -------------------------------------------------------------------------------------------------------------------
// Built the way email clients need: one 600px column, tables and inline styles, live text (so it reads with images off), alt text on every
// image, "bulletproof" buttons made from a coloured table cell (so they show even when images are blocked), and a text version.
const hexOk = (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
function readableOn(bg) {   // black or white text, whichever contrasts more
  const c = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return 1.05 / (L + 0.05) >= 3.5 ? '#ffffff' : '#111111';   // white (the usual look) unless it would be hard to read on this colour
}
const TEMPLATES = ['plain', 'banner', 'feature', 'story'];
const BLOCKS = ['heading', 'text', 'photo', 'photos', 'button', 'product', 'collection', 'divider'];

// Turns a design into { html, text }. ctx: { shop, base, logo, theme:{bg,text,heading,button,buttontext,accent,link}, products:{id:{name,price,image,url}}, linkCode, address, unsubUrl }
function renderDesign(design, ctx) {
  const t = ctx.theme || {};
  const accent = hexOk(t.button) ? t.button : hexOk(t.accent) ? t.accent : '#f72d00';
  const btnText = hexOk(t.buttontext) ? t.buttontext : readableOn(accent);
  const page = hexOk(t.bg) ? t.bg : '#f4ede0', ink = hexOk(t.text) ? t.text : '#222222', head = hexOk(t.heading) ? t.heading : ink, link = hexOk(t.link) ? t.link : accent;
  const card = '#ffffff';
  const abs = (u) => { u = String(u || ''); if (u.startsWith('/')) return ctx.base + u; return /^https?:\/\//i.test(u) ? u : ''; };
  const track = (u) => {
    u = abs(u); if (!u || !ctx.linkCode) return u;
    try { const x = new URL(u); if (x.origin === new URL(ctx.base).origin && !x.searchParams.has('s')) { x.searchParams.set('s', ctx.linkCode); return x.toString(); } } catch { /* leave as is */ }
    return u;
  };
  const font = 'Arial,Helvetica,sans-serif', serif = 'Georgia,"Times New Roman",serif';
  const pad = 'padding:0 32px';
  const h = [], tx = [];
  const button = (label, url) => `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:6px auto 22px"><tr><td align="center" bgcolor="${accent}" style="border-radius:8px;background:${accent}"><a href="${esc(url)}" target="_blank" style="display:inline-block;padding:14px 32px;font-family:${font};font-size:18px;line-height:22px;font-weight:bold;color:${btnText};text-decoration:none;border-radius:8px;min-width:140px;text-align:center">${esc(label)}</a></td></tr></table>`;
  const img = (u, alt, w, href) => { const tag = `<img src="${esc(u)}" alt="${esc(alt || '')}" width="${w}" style="display:block;width:100%;max-width:${w}px;height:auto;border:0;border-radius:8px">`; return href ? `<a href="${esc(href)}" target="_blank">${tag}</a>` : tag; };
  const row = (inner, extra = '') => `<tr><td style="${pad};${extra}">${inner}</td></tr>`;
  if (design.template !== 'plain') {
    const logo = ctx.logo ? abs(ctx.logo) : '';
    h.push(`<tr><td align="center" style="padding:26px 32px 18px;border-bottom:3px solid ${accent}">${logo ? `<img src="${esc(logo)}" alt="${esc(ctx.shop)}" height="48" style="display:block;height:48px;width:auto;border:0">` : `<span style="font-family:${serif};font-size:26px;font-weight:bold;color:${head}">${esc(ctx.shop)}</span>`}</td></tr>`);
    tx.push(ctx.shop.toUpperCase(), '');
  } else h.push('<tr><td style="height:24px;line-height:24px;font-size:0">&nbsp;</td></tr>');
  const blocks = (design.blocks || []);
  blocks.forEach((b, bi) => {
    if (b.type === 'heading' && b.text) { h.push(row(`<h1 style="margin:10px 0 12px;font-family:${serif};font-size:28px;line-height:34px;font-weight:bold;color:${head}">${esc(b.text)}</h1>`)); tx.push(b.text, ''); }
    else if (b.type === 'text' && b.text) { h.push(row(`<div style="font-family:${font};font-size:16px;line-height:25px;color:${ink}">${textToHtml(b.text).replace(/<p style="margin:0 0 14px">/g, '<p style="margin:0 0 16px">').replace(/<a href=/g, `<a style="color:${link}" href=`)}</div>`)); tx.push(b.text, ''); }
    else if (b.type === 'photo' && abs(b.url)) { const href = b.link ? track(b.link) : ''; h.push(row(`<div style="margin:4px 0 18px">${img(abs(b.url), b.alt, 536, href)}</div>`)); if (b.alt) tx.push(`[${b.alt}]`, ''); }
    else if (b.type === 'photos') { const us = (b.urls || []).map(abs).filter(Boolean).slice(0, 3); if (us.length) { const w = Math.floor(536 / us.length) - 6; h.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 18px"><tr>${us.map((u, i) => `<td width="${Math.floor(100 / us.length)}%" valign="top" style="padding:0 ${i < us.length - 1 ? 6 : 0}px 0 ${i ? 6 : 0}px">${img(u, (b.alts || [])[i] || '', w)}</td>`).join('')}</tr></table>`)); } }
    else if (b.type === 'button' && b.label && track(b.url)) { const u = track(b.url); h.push(row(button(b.label, u))); tx.push(`${b.label}: ${u}`, ''); }
    else if (b.type === 'product' && ctx.products && ctx.products[b.product_id]) {
      const p = ctx.products[b.product_id], u = track(p.url);
      h.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 20px;border:1px solid #e6dfd0;border-radius:10px"><tr>${p.image ? `<td width="40%" valign="top" style="padding:12px">${img(abs(p.image), p.name, 190, u)}</td>` : ''}<td valign="middle" style="padding:12px 16px 12px ${p.image ? 4 : 16}px"><div style="font-family:${serif};font-size:20px;line-height:26px;font-weight:bold;color:${head}">${esc(p.name)}</div><div style="font-family:${font};font-size:16px;color:${ink};margin:4px 0 12px">${esc(p.price)}</div><a href="${esc(u)}" target="_blank" style="display:inline-block;padding:10px 22px;font-family:${font};font-size:15px;font-weight:bold;color:${btnText};background:${accent};text-decoration:none;border-radius:8px">${esc(b.label || 'Shop now')}</a></td></tr></table>`));
      tx.push(`${p.name} (${p.price}): ${u}`, '');
    }
    else if (b.type === 'collection' && ctx.collections && ctx.collections[bi] && ctx.collections[bi].items.length) {
      const col = ctx.collections[bi], items = col.items, cells = [];
      for (let i = 0; i < items.length; i += 2) {
        const pair = items.slice(i, i + 2);
        cells.push(`<tr>${pair.map((p, k) => { const u = track(p.url); return `<td width="50%" valign="top" style="padding:0 ${k === 0 ? 8 : 0}px 18px ${k === 1 ? 8 : 0}px">${p.image ? img(abs(p.image), p.name, 260, u) : ''}<div style="font-family:${serif};font-size:17px;line-height:22px;font-weight:bold;color:${head};margin-top:8px"><a href="${esc(u)}" target="_blank" style="color:${head};text-decoration:none">${esc(p.name)}</a></div><div style="font-family:${font};font-size:15px;color:${ink}">${esc(p.price)}</div>${p.left ? `<div style="font-family:${font};font-size:13px;font-weight:bold;color:${accent}">Only ${p.left} left</div>` : ''}</td>`; }).join('')}${pair.length === 1 ? '<td width="50%"></td>' : ''}</tr>`);
      }
      h.push(row(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 4px">${cells.join('')}</table>`));
      const bu = track(col.shopUrl);
      if (b.label && bu) h.push(row(button(b.label, bu)));
      items.forEach((p) => tx.push(`${p.name} (${p.price})${p.left ? ` - only ${p.left} left` : ''}: ${track(p.url)}`));
      tx.push(''); if (b.label && bu) tx.push(`${b.label}: ${bu}`, '');
    }
    else if (b.type === 'divider') h.push(row(`<hr style="border:0;border-top:1px solid #e6dfd0;margin:8px 0 22px">`));
  });
  const foot = [`You are getting this because you signed up for emails from ${ctx.shop}.`, `Unsubscribe: ${ctx.unsubUrl}`, ctx.address].filter(Boolean).join('\n');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(ctx.subject || ctx.shop)}</title></head>
<body style="margin:0;padding:0;background:${page}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${page}"><tr><td align="center" style="padding:20px 10px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:${card};border-radius:12px">${h.join('')}
<tr><td style="padding:8px 32px 28px"><p style="margin:14px 0 0;padding-top:14px;border-top:1px solid #e6dfd0;font-family:${font};font-size:12px;line-height:18px;color:#6b6b6b">You are getting this because you signed up for emails from ${esc(ctx.shop)}.<br><a href="${esc(ctx.unsubUrl)}" style="color:#6b6b6b">Unsubscribe</a><br>${esc(ctx.address || '').replace(/\n/g, '<br>')}</p></td></tr></table></td></tr></table></body></html>`;
  const text = tx.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n\n--\n' + foot + '\n';
  return { html, text, headers: { 'List-Unsubscribe': `<${ctx.unsubUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } };
}

// Cleans a design coming from the browser: only known templates and block types, limited sizes, and addresses that are http(s) or this shop's own paths.
function cleanDesign(d) {
  if (!d || typeof d !== 'object') return null;
  const str = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').slice(0, n);
  const url = (v) => { v = String(v || '').trim().slice(0, 500); return v.startsWith('/') && !v.startsWith('//') ? v : /^https?:\/\/[^\s"'<>]+$/i.test(v) ? v : ''; };
  const out = { template: TEMPLATES.includes(d.template) ? d.template : 'plain', blocks: [] };
  for (const b of (Array.isArray(d.blocks) ? d.blocks : []).slice(0, 40)) {
    if (!b || !BLOCKS.includes(b.type)) continue;
    if (b.type === 'heading') out.blocks.push({ type: 'heading', text: str(b.text, 200) });
    else if (b.type === 'text') out.blocks.push({ type: 'text', text: str(b.text, 6000) });
    else if (b.type === 'photo') out.blocks.push({ type: 'photo', url: url(b.url), alt: str(b.alt, 150), link: url(b.link) });
    else if (b.type === 'photos') out.blocks.push({ type: 'photos', urls: (Array.isArray(b.urls) ? b.urls : []).slice(0, 3).map(url).filter(Boolean) });
    else if (b.type === 'button') out.blocks.push({ type: 'button', label: str(b.label, 40), url: url(b.url) });
    else if (b.type === 'product') out.blocks.push({ type: 'product', product_id: Number(b.product_id) || 0, label: str(b.label, 30) });
    else if (b.type === 'collection') out.blocks.push({ type: 'collection', line_id: Number(b.line_id) || 0, product_ids: (Array.isArray(b.product_ids) ? b.product_ids : []).slice(0, 6).map((n) => Number(n) || 0).filter(Boolean), label: str(b.label, 40) });
    else out.blocks.push({ type: 'divider' });
  }
  return out;
}

module.exports = { sendMail, compose, textToHtml, verifyWebhook, keyPresent, renderDesign, cleanDesign, TEMPLATES };
