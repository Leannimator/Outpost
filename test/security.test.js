'use strict';
// Run with: npm test. The shop is the front door and the owner's sign-in is at /login.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');

test('the shop is the front door: / shows the shop, the owner sign-in lives at /login and is kept out of search', async () => {
  const s = await startServer();
  try {
    const home = await fetch(s.base + '/'); const html = await home.text();
    assert.equal(home.status, 200); assert.ok(html.includes('id="sn"') && !html.includes('app.js'), 'the shop page, not the owner app');
    for (const p of ['/login', '/admin']) {
      const r = await fetch(s.base + p); const t = await r.text();
      assert.equal(r.status, 200); assert.ok(t.includes('app.js'), p + ' serves the owner app');
      assert.match(r.headers.get('x-robots-tag') || '', /noindex/);
      assert.match(r.headers.get('content-security-policy'), /script-src 'self'(;|$)/);
    }
    assert.ok(!/noindex/.test(home.headers.get('x-robots-tag') || ''), 'the shop itself can be found in search');
  } finally { s.stop(); }
});
