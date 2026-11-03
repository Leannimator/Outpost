'use strict';
// Run with: npm test. Checks review items 22, 23, 24, 25, 34, 61 and 62 against a real running copy of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, PASSWORD } = require('./helpers');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) {
  const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD });
  const t = { 'x-admin-token': data.token };
  return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t) };
}
async function addProduct(a, body) { const r = await a.post('/api/admin/products', { name: 'Thing', price_cents: 1000, stock: 1, ...body }); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.id; }
const holdOrder = (dbh, pid, qty, email, ageMin = 1, extra = {}) => {
  const id = dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, customer_email, discount_code, created_at, public_token) VALUES ('online','card','pending',1000,1000,?,?,datetime('now', ?),?)")
    .run(email, extra.code || null, `-${ageMin} minutes`, 'tok' + Math.random()).lastInsertRowid;
  dbh.prepare('INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity, variant_id) VALUES (?,?,?,?,?,?)').run(id, pid, 'Thing', 1000, qty, extra.variant || null);
  return id;
};
const ADDR = { email: 'buyer@example.com', name: 'Pat Buyer', country: 'US', line1: '5 Elm St', line2: '', city: 'Portland', state: 'OR', zip: '97201' };
const quote = (s, items, extra = {}) => s.j('POST', '/api/quote', { items, ...extra });

test('item 22: stock that someone is paying for right now is held for them', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 1 });
    const dbh = open(s);
    assert.equal((await quote(s, [{ id: pid, qty: 1 }])).status, 200, 'free to buy when nobody is mid-checkout');
    holdOrder(dbh, pid, 1, 'first@example.com');
    const second = await quote(s, [{ id: pid, qty: 1 }]);
    assert.equal(second.status, 400); assert.match(second.data.error, /Someone else is checking out/);
    assert.equal((await quote(s, [{ id: pid, qty: 1 }], { address: { ...ADDR, email: 'FIRST@example.com' } })).status, 200, 'the same person coming back is not blocked by their own earlier try');
    dbh.prepare("UPDATE orders SET created_at=datetime('now','-3 hours')").run();
    assert.equal((await quote(s, [{ id: pid, qty: 1 }])).status, 200, 'a hold ends when the payment page would have expired');
    dbh.close();
  } finally { s.stop(); }
});

test('item 22: held stock is counted per option, and plenty of stock is not blocked', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 0, variants: [{ name: 'Small', stock: 1 }, { name: 'Large', stock: 5 }] });
    const vs = (await a.get('/api/admin/products')).data.find((p) => p.id === pid).variants;
    const small = vs.find((v) => v.name === 'Small'), large = vs.find((v) => v.name === 'Large');
    const dbh = open(s);
    holdOrder(dbh, pid, 1, 'x@example.com', 1, { variant: small.id });
    assert.equal((await quote(s, [{ id: pid, variant: small.id, qty: 1 }])).status, 400);
    assert.equal((await quote(s, [{ id: pid, variant: large.id, qty: 4 }])).status, 200, 'the other option is unaffected');
    holdOrder(dbh, pid, 4, 'y@example.com', 1, { variant: large.id });
    assert.equal((await quote(s, [{ id: pid, variant: large.id, qty: 1 }])).status, 200, 'held 4 of 5 leaves 1 for someone else');
    assert.equal((await quote(s, [{ id: pid, variant: large.id, qty: 2 }])).status, 400, 'but not 2');
    dbh.close();
  } finally { s.stop(); }
});

test('item 23: a limited-use code cannot be used by several checkouts at once', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 10 });
    assert.equal((await a.post('/api/admin/discounts', { code: 'ONCE', kind: 'percent', value: 10, max_uses: 1 })).status, 200);
    assert.equal((await quote(s, [{ id: pid, qty: 1 }], { code: 'ONCE' })).status, 200);
    const dbh = open(s);
    holdOrder(dbh, pid, 1, 'first@example.com', 1, { code: 'ONCE' });
    const r = await quote(s, [{ id: pid, qty: 1 }], { code: 'ONCE' });
    assert.equal(r.status, 400); assert.match(r.data.error, /being used by another checkout/);
    dbh.prepare("UPDATE discounts SET uses=1").run();
    assert.match((await quote(s, [{ id: pid, qty: 1 }], { code: 'ONCE' })).data.error, /fully used/);
    dbh.close();
  } finally { s.stop(); }
});

test('item 34: every refused code counts toward the guessing limit, including "needs a bigger order"', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 10, price_cents: 500 });
    assert.equal((await a.post('/api/admin/discounts', { code: 'BIGSPEND', kind: 'percent', value: 10, min_subtotal_cents: 100000 })).status, 200);
    const codes = [];
    for (let i = 0; i < 13; i++) codes.push((await quote(s, [{ id: pid, qty: 1 }], { code: 'BIGSPEND' })).status);
    assert.equal(codes.slice(0, 10).every((c) => c === 400), true, codes.join());
    assert.equal(codes[10], 429, codes.join());
  } finally { s.stop(); }
});

test('item 62: the price the shopper saw is the price they pay', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 10, price_cents: 1000 });
    const q = (await quote(s, [{ id: pid, qty: 1 }], { address: ADDR })).data;
    await a.put('/api/admin/products/' + pid, { name: 'Thing', price_cents: 1900, stock: 10 });
    const tk = await s.formToken();
    const body = (extra) => ({ items: [{ id: pid, qty: 1 }], address: ADDR, started: tk, website: '', ...extra });
    const stale = await s.j('POST', '/api/checkout', body({ expected_total_cents: q.total_cents }));
    assert.equal(stale.status, 409); assert.match(stale.data.error, /Prices changed/); assert.equal(stale.data.total_cents, 1900);
    const fresh = await s.j('POST', '/api/checkout', body({ expected_total_cents: 1900 }));
    assert.notEqual(fresh.status, 409, 'a matching total goes on to payment (here Stripe is not set up, so it stops there)');
  } finally { s.stop(); }
});

test('item 24: a receipt link cannot rewrite an address that is already on the order', async () => {
  const s = await startServer();
  try {
    const dbh = open(s);
    const mk = (shipping) => dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, customer_email, public_token, shipping_json) VALUES ('auction','card','paid',1000,1000,'b@example.com',?,?)")
      .run('rk' + Math.random().toString(36).slice(2, 10), shipping).lastInsertRowid;
    const withAddr = mk(JSON.stringify({ name: 'A', address: { line1: '1 Main', city: 'Portland', state: 'OR', postal_code: '97201', country: 'US' } }));
    const tokOf = (id) => dbh.prepare('SELECT public_token t FROM orders WHERE id=?').get(id).t;
    const post = (id, b) => s.j('POST', `/api/receipt/${id}/shipping?k=${tokOf(id)}`, b);
    const good = { name: 'Pat Buyer', line1: '5 Elm St', city: 'Albany', state: 'New York', postal_code: '12207', country: 'United States' };
    assert.equal((await post(withAddr, good)).status, 400, 'an order that has an address keeps it');
    const noAddr = mk(null);
    assert.equal((await post(noAddr, { ...good, state: 'ZZ' })).status, 400, 'junk state refused');
    assert.equal((await post(noAddr, { ...good, postal_code: 'abc' })).status, 400, 'junk ZIP refused');
    assert.equal((await post(noAddr, { ...good, country: 'Japan' })).status, 400, 'other countries refused');
    assert.equal((await post(noAddr, good)).status, 200, '"New York" and "United States" are understood');
    const saved = JSON.parse(dbh.prepare('SELECT shipping_json j FROM orders WHERE id=?').get(noAddr).j);
    assert.equal(saved.address.state, 'NY'); assert.equal(saved.address.country, 'US');
    assert.equal((await post(noAddr, { ...good, line1: '9 Other Rd' })).status, 400, 'and only once');
    dbh.close();
  } finally { s.stop(); }
});

test('item 25: a bidder cannot swap their address while in a running lot', async () => {
  const s = await startServer();
  try {
    const dbh = open(s);
    const addr = { email: 'b@example.com', name: 'B', country: 'US', line1: '1 Main', line2: '', city: 'Portland', state: 'OR', zip: '97201' };
    const bid = dbh.prepare("INSERT INTO bidders (name, email, token, created_at, address_json) VALUES ('B','b@example.com','btok',?,?)").run(Date.now(), JSON.stringify(addr)).lastInsertRowid;
    const aid = dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, created_at) VALUES ('Lot',100,100,0,?,0)").run(Date.now() + 3600e3).lastInsertRowid;
    dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,100,0)').run(aid, bid);
    const move = { address: { line1: '9 Far Rd', city: 'Albany', state: 'NY', zip: '12207', country: 'US' } };
    const h = { 'x-bidder-token': 'btok' };
    assert.equal((await s.j('POST', '/api/bidders/address', move, h)).status, 409);
    dbh.prepare("UPDATE auctions SET status='unsold'").run();
    assert.equal((await s.j('POST', '/api/bidders/address', move, h)).status, 200, 'free to update once nothing is running');
    dbh.close();
  } finally { s.stop(); }
});

test('item 61: saving an old edit form does not bring sold stock back', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 5 });
    const dbh = open(s);
    dbh.prepare('UPDATE products SET stock=4 WHERE id=?').run(pid);   // a sale happened while the form was open
    assert.equal((await a.put('/api/admin/products/' + pid, { name: 'Renamed', price_cents: 1000, stock: 5, stock_was: 5 })).status, 200);
    assert.equal(dbh.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock, 4, 'untouched stock field keeps the real number');
    assert.equal((await a.put('/api/admin/products/' + pid, { name: 'Renamed', price_cents: 1000, stock: 9, stock_was: 5 })).status, 409, 'a typed number on an out-of-date form is refused');
    assert.equal((await a.put('/api/admin/products/' + pid, { name: 'Renamed', price_cents: 1000, stock: 9, stock_was: 4 })).status, 200, 'a typed number on an up-to-date form is applied');
    assert.equal(dbh.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock, 9);
    dbh.close();
  } finally { s.stop(); }
});

test('item 61: the same protection for options', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 0, variants: [{ name: 'Small', stock: 5 }] });
    const v = (await a.get('/api/admin/products')).data.find((p) => p.id === pid).variants[0];
    const dbh = open(s);
    dbh.prepare('UPDATE variants SET stock=3 WHERE id=?').run(v.id);
    const save = (stock, was) => a.put('/api/admin/products/' + pid, { name: 'Thing', price_cents: 1000, variants: [{ id: v.id, name: 'Small', stock, stock_was: was }] });
    assert.equal((await save(5, 5)).status, 200);
    assert.equal(dbh.prepare('SELECT stock FROM variants WHERE id=?').get(v.id).stock, 3);
    assert.equal(dbh.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock, 3, 'the product total follows');
    assert.equal((await save(8, 5)).status, 409);
    dbh.close();
  } finally { s.stop(); }
});

test('item 22: if a payment still arrives for more than is left, the owner is told (the money is real, so the order stands)', async () => {
  const Stripe = require('stripe');
  const s = await startServer({ STRIPE_SECRET_KEY: 'sk_test_dummy', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
  try {
    const a = await admin(s);
    const pid = await addProduct(a, { stock: 1 });
    const dbh = open(s);
    const oid = holdOrder(dbh, pid, 1, 'late@example.com');
    dbh.prepare('UPDATE products SET stock=0 WHERE id=?').run(pid);   // sold at the register meanwhile
    dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(oid, 'cs_1');
    const payload = JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: { id: 'cs_1', mode: 'payment', payment_status: 'paid', metadata: { order_id: String(oid) }, customer_details: { email: 'late@example.com' } } } });
    const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
    const res = await fetch(s.base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
    assert.equal(res.status, 200);
    assert.equal(dbh.prepare('SELECT status FROM orders WHERE id=?').get(oid).status, 'paid');
    const ev = (await a.get('/api/admin/security')).data.recent.find((e) => e.kind === 'oversold');
    assert.ok(ev && ev.detail.includes(`order #${oid}`), JSON.stringify(ev));
    dbh.close();
  } finally { s.stop(); }
});
