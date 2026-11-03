'use strict';
// Run with: npm test. Checks the "Your links" list on Settings: a name and an address per row, any number of rows, and old shops carried over.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, PASSWORD } = require('./helpers');

async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t) }; }
const pub = async (s) => (await s.j('GET', '/api/settings')).data;

test('your links: a name and an address per row, in order, cleaned up, and shown to shoppers', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    assert.deepEqual((await pub(s)).social_links, [], 'starts empty');
    const r = await a.put('/api/admin/settings', { social_links: [{ name: '  My etsy ', url: 'etsy.com/shop/ash' }, { name: '', url: '' }, { name: 'Website', url: 'https://ash-and-anchor.com' }] });
    assert.equal(r.status, 200);
    assert.deepEqual((await pub(s)).social_links, [{ name: 'My etsy', url: 'https://etsy.com/shop/ash' }, { name: 'Website', url: 'https://ash-and-anchor.com/' }], 'trimmed, https added, empty row dropped, order kept');
    assert.equal((await a.put('/api/admin/settings', { social_links: [{ name: 'X', url: '' }] })).status, 400, 'a name with no address is refused');
    assert.equal((await a.put('/api/admin/settings', { social_links: [{ name: '', url: 'https://a.co' }] })).status, 400, 'an address with no name is refused');
    assert.equal((await a.put('/api/admin/settings', { social_links: [{ name: 'Bad', url: 'javascript:alert(1)' }] })).status, 400, 'only web addresses');
    assert.equal((await a.put('/api/admin/settings', { social_links: 'nope' })).status, 400);
    assert.equal((await a.put('/api/admin/settings', { social_links: Array.from({ length: 31 }, (_, i) => ({ name: 'n' + i, url: 'https://a' + i + '.co' })) })).status, 400, 'at most 30');
    assert.equal((await pub(s)).social_links.length, 2, 'a refused save changes nothing');
    assert.equal((await a.put('/api/admin/settings', { social_links: [] })).status, 200);
    assert.deepEqual((await pub(s)).social_links, [], 'removing every row saves an empty list');
  } finally { s.stop(); }
});

test('your links: a shop that used the old fixed boxes keeps its links, and the contact email still works', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = new Database(path.join(s.dir, 'outpost.db'));
    dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('social_json', ?)").run(JSON.stringify({ instagram: 'https://www.instagram.com/ash.and.anchor', website: 'https://ash-and-anchor.com/', email: 'hi@shop.example' }));
    dbh.close();
    const a = await admin(s);
    const d = await pub(s);
    assert.deepEqual(d.social_links, [{ name: 'Website', url: 'https://ash-and-anchor.com/' }, { name: 'Instagram', url: 'https://www.instagram.com/ash.and.anchor' }], 'old boxes carried over, in the old order');
    assert.deepEqual(d.social, { email: 'hi@shop.example' }, 'the contact email is still there');
    // saving the contact email the old way must not wipe the carried-over links
    assert.equal((await a.put('/api/admin/settings', { social: { email: 'new@shop.example' } })).status, 200);
    const d2 = await pub(s);
    assert.equal(d2.social_links.length, 2); assert.equal(d2.social.email, 'new@shop.example');
    // removing a link sticks (the old box is not brought back)
    await a.put('/api/admin/settings', { social_links: [{ name: 'Website', url: 'https://ash-and-anchor.com/' }] });
    assert.deepEqual((await pub(s)).social_links.map((l) => l.name), ['Website']);
  } finally { s.stop(); }
});
