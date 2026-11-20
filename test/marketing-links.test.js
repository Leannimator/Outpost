'use strict';
// Run with: npm test. Checks the Marketing tab's first step: tracked links, daily visit counts (no addresses kept), the source saved on an order, and Sales by source.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, PASSWORD } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t) }; }
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };
const ADDR = { email: 'b@example.com', name: 'Pat', country: 'US', line1: '5 Elm', line2: '', city: 'Portland', state: 'OR', zip: '97201' };
const envFor = (fake) => ({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http' });

test('tracked links: made from a name, safe codes, no duplicates, archived not deleted, owner only', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    assert.equal((await s.j('GET', '/api/admin/marketing/links')).status, 401, 'owner only');
    assert.equal((await s.j('POST', '/api/admin/marketing/links', { name: 'x' })).status, 401, 'owner only');
    const a = await admin(s);
    const r = await a.post('/api/admin/marketing/links', { name: 'Instagram bio' });
    assert.equal(r.status, 200); assert.equal(r.data.code, 'instagram-bio'); assert.match(r.data.url, /\/shop\?s=instagram-bio$/);
    assert.equal((await a.post('/api/admin/marketing/links', { name: 'Instagram bio' })).data.code, 'instagram-bio-2', 'the same name gets a new code');
    assert.equal((await a.post('/api/admin/marketing/links', { name: 'Mine', code: 'instagram-bio' })).status, 409, 'a chosen code that is taken is refused');
    assert.equal((await a.post('/api/admin/marketing/links', { name: 'Bad', code: 'no spaces!' })).status, 400, 'only letters, numbers, dashes');
    assert.equal((await a.post('/api/admin/marketing/links', { name: '   ' })).status, 400, 'a name is required');
    assert.equal((await a.post('/api/admin/marketing/links', { name: 'Where', dest: '/evil' })).data.url.includes('/shop?s='), true, 'an unknown page falls back to the shop');
    const list = (await a.get('/api/admin/marketing/links')).data;
    assert.equal(list.links.length, 3);
    assert.equal((await a.put('/api/admin/marketing/links/' + r.data.id, { archived: true })).status, 200);
    assert.equal((await a.get('/api/admin/marketing/links')).data.links.find((l) => l.id === r.data.id).archived, 1, 'archived, still listed');
    const qr = await a.get('/api/admin/marketing/links/' + r.data.id + '/qr');
    assert.equal(qr.status, 200); assert.match(qr.data.qr, /^data:image\/png;base64,/);
  } finally { s.stop(); }
});

test('visits: counted once per page load per day, never stored with an address, bots and made-up codes ignored', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const l = (await a.post('/api/admin/marketing/links', { name: 'Market sign' })).data;
    const dbh = open(s);
    const cols = dbh.prepare("PRAGMA table_info(link_visits)").all().map((c) => c.name).sort();
    assert.deepEqual(cols, ['code', 'day', 'visits'], 'only a code, a day and a count are kept: no address, no cookie id');
    for (let i = 0; i < 3; i++) assert.equal((await s.j('GET', '/shop?s=' + l.code, undefined, BROWSER)).status, 200);
    await s.j('GET', '/shop?s=' + l.code.toUpperCase(), undefined, BROWSER);                 // capital letters count as the same link
    await s.j('GET', '/shop?s=' + l.code, undefined, { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' });
    await s.j('GET', '/shop?s=' + l.code, undefined, { 'user-agent': 'WhatsApp/2.23 link preview' });
    await s.j('GET', '/shop?s=nonsense', undefined, BROWSER);
    await s.j('GET', '/shop?s=' + encodeURIComponent("x'; DROP TABLE orders;--"), undefined, BROWSER);
    await s.j('GET', '/shop', undefined, BROWSER);
    await s.j('GET', '/api/settings?s=' + l.code, undefined, BROWSER);                          // only shop pages count
    const rows = dbh.prepare('SELECT code, visits FROM link_visits').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].code.toLowerCase(), l.code); assert.equal(rows[0].visits, 4, 'four real page loads: bots, previews, unknown codes and other routes do not count');
    assert.ok(dbh.prepare('SELECT COUNT(*) c FROM orders').get().c === 0 && dbh.prepare("SELECT name FROM sqlite_master WHERE name='orders'").get(), 'nothing got through to the database');
    const list = (await a.get('/api/admin/marketing/links')).data.links[0];
    assert.equal(list.visits_30, 4); assert.equal(list.visits_total, 4);
    dbh.close();
  } finally { s.stop(); }
});

test('a flood of visits from one visitor stops counting (it cannot swell the numbers)', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const l = (await a.post('/api/admin/marketing/links', { name: 'Flood' })).data;
    for (let i = 0; i < 130; i++) await s.j('GET', '/shop?s=' + l.code, undefined, BROWSER);
    assert.equal((await a.get('/api/admin/marketing/links')).data.links[0].visits_30, 120, 'at most 120 an hour from one visitor');
  } finally { s.stop(); }
});

test('an online order remembers its tracked link; made-up sources are dropped; Sales by source adds it up after refunds', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const a = await admin(s); const dbh = open(s);
    const l = (await a.post('/api/admin/marketing/links', { name: 'Launch email' })).data;
    const pid = Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Frog',2500,9,1)").run().lastInsertRowid);
    const co = await s.j('POST', '/api/checkout', { items: [{ id: pid, qty: 1 }], address: ADDR, started: await s.formToken(), website: '', source: l.code.toUpperCase() });
    assert.equal(co.status, 200, JSON.stringify(co.data));
    assert.equal(dbh.prepare('SELECT source FROM orders ORDER BY id DESC LIMIT 1').get().source, l.code, 'the canonical code is saved');
    const co2 = await s.j('POST', '/api/checkout', { items: [{ id: pid, qty: 1 }], address: ADDR, started: await s.formToken(), website: '', source: 'made-up' });
    assert.equal(co2.status, 200, JSON.stringify(co2.data));
    assert.equal(dbh.prepare('SELECT source FROM orders ORDER BY id DESC LIMIT 1').get().source, '', 'an unknown source is dropped, not stored');
    // Paid orders: one from the link (with a part refund), one direct, one still unpaid (must not count).
    const ins = dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, public_token, source, refunded_cents, created_at) VALUES ('online','card',?,?,?,?,?,?,datetime('now'))");
    ins.run('paid', 5000, 5000, 'tkA', l.code, 1000); ins.run('paid', 3000, 3000, 'tkB', '', 0); ins.run('pending', 9900, 9900, 'tkC', l.code, 0);
    ins.run('paid', 700, 700, 'tkD', l.code, 0);
    dbh.prepare("UPDATE orders SET created_at = datetime('now','-200 days') WHERE public_token = 'tkD'").run();   // too old for the 30 day view
    await s.j('GET', '/shop?s=' + l.code, undefined, BROWSER);
    const r = (await a.get('/api/admin/marketing/sources?days=30')).data;
    assert.equal(r.days, 30);
    assert.equal(r.rows.length, 1); assert.equal(r.rows[0].orders, 1); assert.equal(r.rows[0].revenue_cents, 4000, 'after the part refund');
    assert.equal(r.rows[0].visits, 1);
    assert.deepEqual(r.direct, { orders: 1, revenue_cents: 3000 });
    assert.equal(r.orders, 2); assert.equal(r.revenue_cents, 7000); assert.equal(r.visits, 1);
    assert.equal((await a.get('/api/admin/marketing/sources?days=999')).data.days, 30, 'an odd range falls back to 30 days');
    const all = (await a.get('/api/admin/marketing/links')).data.links[0];
    assert.equal(all.orders, 2, 'the links list counts every paid order from the link');
    assert.equal(all.revenue_cents, 4700);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});
