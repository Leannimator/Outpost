'use strict';
// Run with: npm test. TRUST_PROXY=cloudflare: visitors keep their real address through Cloudflare, and nobody can fake one by
// skipping Cloudflare and writing their own header. Real running copy of the app (it connects from 127.0.0.1, the "front door").
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer, PASSWORD } = require('./helpers');
const { cloudflareTrust, CLOUDFLARE_RANGES } = require('../proxytrust');

async function seenAs(s, tok, xff) {
  const r = await fetch(s.base + '/api/admin/setup-check', { headers: { 'x-admin-token': tok, ...(xff ? { 'x-forwarded-for': xff } : {}) } });
  assert.equal(r.status, 200); return (await r.json()).ip_seen;
}

test('the trust rule: the front door always, then only Cloudflare or private addresses', () => {
  const t = cloudflareTrust();
  assert.equal(t('10.0.0.5', 0), true, 'the connection straight into the app is always believed');
  assert.equal(t('203.0.113.9', 0), true, 'even if the host uses an unusual address');
  assert.equal(t('172.71.1.1', 1), true, 'a Cloudflare address');
  assert.equal(t('2606:4700::1', 1), true, 'a Cloudflare IPv6 address');
  assert.equal(t('10.1.2.3', 1), true, 'a private address inside the host');
  assert.equal(t('8.8.8.8', 1), false, 'an ordinary visitor address');
  assert.equal(t('172.15.0.1', 1), false, '172.15 is public, only 172.16 to 172.31 is private');
  assert.ok(CLOUDFLARE_RANGES.length >= 20);
});

test('TRUST_PROXY=cloudflare finds the real visitor and ignores faked headers', { timeout: 60000 }, async () => {
  const s = await startServer({ TRUST_PROXY: 'cloudflare' });
  try {
    const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const tok = data.token;
    assert.equal(await seenAs(s, tok, '9.9.9.9'), '9.9.9.9', 'one proxy in front, as on Render without Cloudflare');
    assert.equal(await seenAs(s, tok, '9.9.9.9, 172.71.1.1'), '9.9.9.9', 'through Cloudflare: the visitor, not the Cloudflare server');
    assert.equal(await seenAs(s, tok, '1.2.3.4, 9.9.9.9, 172.71.1.1'), '9.9.9.9', 'a faked first entry is ignored through Cloudflare');
    // straight to the host, pretending to be behind Cloudflare: the host adds the real address on the right, and that one wins
    assert.equal(await seenAs(s, tok, '1.2.3.4, 172.71.1.1, 8.8.8.8'), '8.8.8.8', 'skipping Cloudflare cannot fake an address');
    assert.equal(await seenAs(s, tok, '1.2.3.4, 8.8.8.8'), '8.8.8.8', 'and a plain fake entry is ignored too');
    assert.ok(await seenAs(s, tok, ''), 'no header: the connection itself');
  } finally { s.stop(); }
});

test('the old way (a plain 2) WOULD be fooled, which is why it is not recommended', { timeout: 60000 }, async () => {
  const s = await startServer({ TRUST_PROXY: '2' });
  try {
    const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD });
    assert.equal(await seenAs(s, data.token, '1.2.3.4, 172.71.1.1, 8.8.8.8'), '172.71.1.1', 'a count of 2 believes the middle entry');
  } finally { s.stop(); }
});
