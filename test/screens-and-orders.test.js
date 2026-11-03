'use strict';
// Run with: npm test. Segment 10: typing money, per-customer codes, late payments, the next-bidder double click,
// the import preview, the orders list and broken requests. Real running copy of the app, pretend Stripe.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const Safe = require('../safe');
const { startServer, PASSWORD } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
const envFor = (fake) => ({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http' });
async function admin(s) {
  const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token };
  return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t) };
}

test('money typing: 12,50 is $12.50, 1,250 is $1,250, and unclear text is refused', () => {
  const ok = { '12': 1200, '12.5': 1250, '$12.50': 1250, '12,50': 1250, '1,250': 125000, '1,250.50': 125050, ' 75 ': 7500, '0.99': 99 };
  for (const [t, c] of Object.entries(ok)) assert.equal(Safe.parseMoneyCents(t), c, t);
  for (const bad of ['1e2', '1,2,3', '', 'abc', '12.505', '-5', '12 50', '1,25,0', '0x10', 'Infinity', '12..5']) assert.ok(Number.isNaN(Safe.parseMoneyCents(bad)), 'refused: ' + bad);
});

test('item: a code can be limited to N uses per customer (counted by email, paid orders only)', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s); const a = await admin(s);
    const pid = (await a.post('/api/admin/products', { name: 'Mug', price_cents: 2000, stock: 9 })).data.id;
    assert.equal((await a.post('/api/admin/discounts', { code: 'ONCE', kind: 'percent', value: 10, max_per_customer: 'one' })).status, 400, 'text is not a number');
    assert.equal((await a.post('/api/admin/discounts', { code: 'ONCE', kind: 'percent', value: 10, max_per_customer: 0 })).status, 400, 'zero would block everyone');
    assert.equal((await a.post('/api/admin/discounts', { code: 'ONCE', kind: 'percent', value: 10, max_per_customer: 1 })).status, 200);
    const list = (await a.get('/api/admin/discounts')).data;
    assert.equal(list.find((d) => d.code === 'ONCE').max_per_customer, 1);
    const q = (email) => s.j('POST', '/api/quote', { items: [{ id: pid, qty: 1 }], code: 'ONCE', address: { email, name: 'P', country: 'US', line1: '1 A', city: 'Portland', state: 'OR', zip: '97201' } });
    assert.equal((await q('pat@example.com')).status, 200, 'first time is fine');
    dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, customer_email, discount_code, public_token) VALUES ('online','card','pending',1800,2000,'pat@example.com','ONCE','t1')").run();
    assert.equal((await q('pat@example.com')).status, 200, 'an unpaid try does not count');
    dbh.prepare("UPDATE orders SET status='paid' WHERE public_token='t1'").run();
    const again = await q('PAT@example.com');
    assert.equal(again.status, 400); assert.match(again.data.error, /already used this code/, 'upper case does not dodge it');
    assert.equal((await q('sam@example.com')).status, 200, 'someone else can still use it');
    dbh.close();
  } finally { s.stop(); }
});

test('item: "didn\'t pay, next bidder" refuses a stale click instead of removing the next winner too', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const bidder = (n) => Number(dbh.prepare("INSERT INTO bidders (name, email, token, created_at) VALUES (?,?,?,?)").run('B' + n, `b${n}@example.com`, 'tk' + n + Math.random(), Date.now()).lastInsertRowid);
    const b1 = bidder(1), b2 = bidder(2);
    const aid = Number(dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at, pay_token) VALUES ('Lot',100,100,0,?,'closed',0,'ptk')").run(Date.now() - 5000).lastInsertRowid);
    const bid1 = Number(dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,?,2)').run(aid, b1, 5000).lastInsertRowid);
    const bid2 = Number(dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,?,1)').run(aid, b2, 4000).lastInsertRowid);
    const oid = Number(dbh.prepare("INSERT INTO orders (channel, payment_method, status, subtotal_cents, tax_cents, total_cents, shipping_cents, auction_id, public_token, customer_email) VALUES ('auction','card','pending',5000,0,5000,0,?,'rk1','b1@example.com')").run(aid).lastInsertRowid);
    dbh.prepare('UPDATE auctions SET winner_bid_id=?, order_id=? WHERE id=?').run(bid1, oid, aid);
    const shown = (await a.get('/api/admin/auctions')).data.find((x) => x.id === aid);
    assert.equal(shown.winner_bid_id, bid1, 'the screen is told which bid it is showing');
    assert.equal((await a.post(`/api/admin/auctions/${aid}/next-bidder`, { expected_bid_id: bid2 })).status, 409, 'wrong bid: refused, nothing changed');
    assert.equal(dbh.prepare('SELECT voided FROM bids WHERE id=?').get(bid1).voided, 0);
    const ok = await a.post(`/api/admin/auctions/${aid}/next-bidder`, { expected_bid_id: bid1 });
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    assert.equal(dbh.prepare('SELECT voided FROM bids WHERE id=?').get(bid1).voided, 1);
    // the same click arriving again (double tap) now names a bid that is no longer the winner
    const dup = await a.post(`/api/admin/auctions/${aid}/next-bidder`, { expected_bid_id: bid1 });
    assert.ok([400, 409].includes(dup.status), 'second click refused: ' + dup.status);
    assert.equal(dbh.prepare('SELECT voided FROM bids WHERE id=?').get(bid2).voided, 0, 'the next bidder was not removed too');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('items: money that arrives after a cancel can be refunded once, or kept and the order reopened', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const pid = Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Thing',1000,5,1)").run().lastInsertRowid);
    const late = (pi, cents = 1000) => {
      const id = Number(dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, customer_email, public_token, late_payment, late_paid_cents) VALUES ('online','card','canceled',1000,1000,'b@example.com',?,?,?)").run('lt' + Math.random(), pi, cents).lastInsertRowid);
      dbh.prepare("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?,?,'Thing',1000,1)").run(id, pid);
      return id;
    };
    const o1 = late('pi_a');
    const r1 = await a.post(`/api/admin/orders/${o1}/late-refund`, {});
    assert.equal(r1.status, 200, JSON.stringify(r1.data)); assert.equal(r1.data.refunded_cents, 1000);
    assert.equal(fake.st.refunds.length, 1);
    assert.equal(dbh.prepare('SELECT late_resolved r FROM orders WHERE id=?').get(o1).r, 'refunded');
    assert.equal((await a.post(`/api/admin/orders/${o1}/late-refund`, {})).status, 400, 'asking again never refunds twice');
    assert.equal(fake.st.refunds.length, 1);
    assert.equal((await a.post(`/api/admin/orders/${o1}/accept-late`, {})).status, 400, 'a refunded payment cannot be kept');

    const o2 = late('pi_b');
    const k = await a.post(`/api/admin/orders/${o2}/accept-late`, {});
    assert.equal(k.status, 200, JSON.stringify(k.data));
    const row = dbh.prepare('SELECT status, late_resolved FROM orders WHERE id=?').get(o2);
    assert.equal(row.status, 'paid'); assert.equal(row.late_resolved, 'accepted');
    assert.equal(dbh.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock, 4, 'the item was taken out of stock');
    assert.equal((await a.post(`/api/admin/orders/${o2}/late-refund`, {})).status, 400, 'a kept payment cannot also be refunded');

    const o3 = late('pi_c', 400);   // less than the order total arrived
    assert.equal((await a.post(`/api/admin/orders/${o3}/accept-late`, {})).status, 400, 'not enough money to reopen the order');
    assert.equal((await a.post('/api/admin/orders/999999/late-refund', {})).status, 404);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item: the import preview shows what would happen and saves nothing', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = (await a.post('/api/admin/products', { name: 'Widget', price_cents: 1050, stock: 8 })).data.id;
    const rows = [{ name: 'Widget', price: '12.00', stock: '' }, { name: 'Blue mug', price: '24', stock: '6' }, { name: 'Candle', price: '' }, { name: 'Print', price: '1e2' }, { name: 'Tea', price: '12,50', stock: '3' }];
    const r = (await a.post('/api/admin/products/import', { rows, dry_run: true })).data;
    assert.equal(r.dry_run, true);
    assert.deepEqual(r.plan.map((x) => [x.name, x.action, x.price_before, x.price_after, x.stock_before, x.stock_after]),
      [['Widget', 'change', 1050, 1200, 8, 8], ['Blue mug', 'new', null, 2400, null, 6], ['Tea', 'new', null, 1250, null, 3]]);
    assert.deepEqual(r.errors.map((e) => e.row), [3, 4]);
    const names = (await a.get('/api/admin/products')).data;
    assert.equal(names.length, 1, 'nothing was saved by the preview');
    assert.equal(names.find((x) => x.id === pid).price_cents, 1050);
    const real = (await a.post('/api/admin/products/import', { rows })).data;
    assert.equal(real.created, 2); assert.equal(real.updated, 1);
    const after = (await a.get('/api/admin/products')).data;
    assert.equal(after.find((x) => x.name === 'Tea').price_cents, 1250, '12,50 is $12.50, not $1,250');
  } finally { s.stop(); }
});

test('item: the orders list shows the newest, plus anything still waiting to ship, and can load older ones', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s); const a = await admin(s);
    const ins = dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, fulfillment, public_token) VALUES ('online','card',?,100,100,?,?)");
    const ids = [];
    ids.push(Number(ins.run('paid', 'packed', 'o0').lastInsertRowid));   // very old, still waiting to ship
    for (let i = 1; i <= 8; i++) ids.push(Number(ins.run('paid', 'shipped', 'o' + i).lastInsertRowid));
    const res = await s.j('GET', '/api/admin/orders?limit=3', undefined, a.t);
    const got = res.data.map((o) => o.id);
    assert.ok(got.includes(ids[0]), 'the unshipped old order is always there');
    assert.deepEqual(got.filter((x) => x !== ids[0]), ids.slice(-3).reverse());
    const raw = await fetch(s.base + '/api/admin/orders?limit=3', { headers: a.t });
    assert.equal(raw.headers.get('x-total-orders'), '9', 'the screen can say "Showing 4 of 9"');
    const older = (await s.j('GET', `/api/admin/orders?limit=3&before=${ids[6]}`, undefined, a.t)).data.map((o) => o.id);
    assert.deepEqual(older, [ids[5], ids[4], ids[3]]);
    dbh.close();
  } finally { s.stop(); }
});

test('item 50: a broken request body is a 400, not a server error', { timeout: 30000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const r = await fetch(s.base + '/api/admin/discounts', { method: 'POST', headers: { 'content-type': 'application/json', ...a.t }, body: '{"code": ' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /could not be read/);
  } finally { s.stop(); }
});

test('item: settings with the wrong kind of value are refused, not stored', { timeout: 30000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    // a list like ["#aabbcc"] used to be read as the text "#aabbcc" and accepted
    for (const bad of [{ mode: ['dark'], textmode: '' }, { bg: ['#aabbcc'], textmode: '' }, { textmode: ['same'] }]) {
      const r = await a.put('/api/admin/settings', { theme: bad });
      assert.equal(r.status, 400, JSON.stringify(bad) + ' -> ' + r.status + ' ' + JSON.stringify(r.data));
    }
    const good = await a.put('/api/admin/settings', { theme: { mode: 'dark', textmode: '' } }); assert.equal(good.status, 200, 'real values still work: ' + JSON.stringify(good.data));
    assert.equal((await a.get('/api/admin/status')).status, 200, 'the app is still fine afterwards');
  } finally { s.stop(); }
});
