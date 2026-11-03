'use strict';
// Run with: npm test. Segment 9: data and privacy in the database (review items 38, 39, 40, 75-81).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const { startServer, PASSWORD, hashTok, sleep } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const ROOT = path.join(__dirname, '..');
const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) {
  const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD });
  const t = { 'x-admin-token': data.token };
  return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), del: (u) => s.j('DELETE', u, undefined, t), get: (u) => s.j('GET', u, undefined, t) };
}
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// Open db.js in a separate process (so a refusal to start can be observed) on a given database file.
const runDb = (file, code = "const d=require('./db.js');process.stdout.write(JSON.stringify({v:d.pragma('user_version',{simple:true})}))") =>
  spawnSync(process.execPath, ['-e', code], { cwd: ROOT, env: { PATH: process.env.PATH, DB_PATH: file }, encoding: 'utf8' });
const ymd = (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// A database as an older version left it: order_items.product_id NOT NULL, no variant/custom columns.
function legacyDb(file, { badRow = false } = {}) {
  const d = new Database(file);
  d.exec(`
    CREATE TABLE products (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, price_cents INTEGER NOT NULL, stock INTEGER NOT NULL DEFAULT 0, image_url TEXT, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL, payment_method TEXT NOT NULL, status TEXT NOT NULL, total_cents INTEGER NOT NULL,
      stripe_session_id TEXT, customer_email TEXT, shipping_json TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER NOT NULL REFERENCES products(id), name TEXT NOT NULL, unit_price_cents INTEGER NOT NULL, quantity INTEGER NOT NULL);
    INSERT INTO products (name, price_cents, stock) VALUES ('Mug', 1200, 5);
    INSERT INTO orders (channel, payment_method, status, total_cents) VALUES ('register','cash','paid',2400);
    INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (1, 1, 'Mug', 1200, ${badRow ? 0 : 2});
  `);
  d.close();
}

test('item 75: an old database upgrades cleanly on the FIRST start, keeping its data and making a safety copy', () => {
  const dir = tmp('outpost-mig-'); const file = path.join(dir, 'old.db');
  legacyDb(file);
  const r = runDb(file);
  assert.equal(r.status, 0, r.stderr);
  const d = new Database(file);
  const names = d.prepare('PRAGMA table_info(order_items)').all();
  assert.ok(names.some((c) => c.name === 'variant_id') && names.some((c) => c.name === 'custom_json') && names.some((c) => c.name === 'stock_taken'), 'the rebuilt table keeps every current column');
  assert.equal(names.find((c) => c.name === 'product_id').notnull, 0, 'auction lots (no product) are allowed');
  assert.deepEqual(d.prepare('SELECT name, quantity, unit_price_cents FROM order_items').all(), [{ name: 'Mug', quantity: 2, unit_price_cents: 1200 }]);
  d.close();
  assert.ok(fs.existsSync(file + '.before-update.bak'), 'a copy from before the update exists');
  assert.equal(fs.statSync(file + '.before-update.bak').mode & 0o077, 0, 'and only the owner can read it');
  assert.equal(runDb(file).status, 0, 'a second start is fine too');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('item 75: a failed upgrade changes NOTHING, says so in plain words, and does not print a stack trace', () => {
  const dir = tmp('outpost-mig-'); const file = path.join(dir, 'bad.db');
  legacyDb(file, { badRow: true });   // a row with quantity 0 cannot be copied into the table that requires quantity > 0
  const r = runDb(file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not update your database/);
  assert.match(r.stderr, /NOTHING in your database was changed/);
  assert.doesNotMatch(r.stderr, /\n\s+at .*\(.*:\d+:\d+\)/, 'no stack trace');
  const d = new Database(file);
  const names = d.prepare('PRAGMA table_info(order_items)').all();
  assert.equal(names.some((c) => c.name === 'variant_id'), false, 'not half-migrated: no new columns were left behind');
  assert.equal(names.find((c) => c.name === 'product_id').notnull, 1, 'the old table is still there');
  assert.equal(d.prepare('SELECT COUNT(*) c FROM order_items').get().c, 1, 'and so is its data');
  d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('item 76: a restart no longer rewrites real orders ($0 item + $5 shipping stays subtotal $0)', async () => {
  const s = await startServer();
  try {
    const dbh = open(s);
    dbh.prepare("INSERT INTO orders (channel, payment_method, status, subtotal_cents, tax_cents, shipping_cents, total_cents, public_token) VALUES ('online','card','paid',0,0,500,500,'t76')").run();
    dbh.close();
    s.stop(true);
    const s2 = await startServer({ DATA_DIR: s.dir });
    try {
      const d2 = open(s);   // (the second app uses the first one's folder)
      assert.equal(d2.prepare("SELECT subtotal_cents x FROM orders WHERE public_token='t76'").get().x, 0);
      d2.close();
    } finally { s2.stop(); }
  } finally { s.stop(); }
});

test('item 81: the database file is found next to the app, not wherever you started it from; private; saved with full safety', () => {
  const dir = tmp('outpost-path-'); const elsewhere = tmp('outpost-cwd-');
  fs.copyFileSync(path.join(ROOT, 'db.js'), path.join(dir, 'db.js'));
  const r = spawnSync(process.execPath, ['-e', `const d=require(${JSON.stringify(path.join(dir, 'db.js'))});process.stdout.write(JSON.stringify({file:d.file,sync:d.pragma('synchronous',{simple:true}),sd:d.pragma('secure_delete',{simple:true})}))`],
    { cwd: elsewhere, env: { PATH: process.env.PATH, NODE_PATH: path.join(ROOT, 'node_modules') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.file, path.join(dir, 'pos.db'));
  assert.ok(fs.existsSync(path.join(dir, 'pos.db')), 'created next to the app');
  assert.equal(fs.existsSync(path.join(elsewhere, 'pos.db')), false, 'and NOT in the folder it was started from');
  assert.equal(fs.statSync(path.join(dir, 'pos.db')).mode & 0o077, 0, 'only the owner can read the database');
  assert.equal(o.sync, 2, 'synchronous = FULL');
  assert.equal(o.sd, 1, 'removed rows are overwritten');
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('item 79: a removed subscriber\'s email does not stay behind in the database file', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    assert.equal((await a.put('/api/admin/settings', { mailing_list_on: true })).status, 200);
    const started = await s.formToken();
    const email = 'findme-' + crypto.randomBytes(4).toString('hex') + '@example.com';
    assert.equal((await s.j('POST', '/api/subscribe', { email, consent: true, started })).status, 200);
    const id = (await a.get('/api/admin/subscribers')).data[0].id;
    assert.equal((await a.del('/api/admin/subscribers/' + id)).status, 200);
    s.stop(true);   // the app is stopped hard; the file on disk is what a stolen disk or backup would hold
    const dbh = new Database(path.join(s.dir, 'outpost.db')); dbh.pragma('wal_checkpoint(TRUNCATE)'); dbh.close();
    assert.equal(fs.readFileSync(path.join(s.dir, 'outpost.db')).includes(Buffer.from(email)), false);
    fs.rmSync(s.dir, { recursive: true, force: true });
  } finally { s.stop(); }
});

test('item 39: signing up again cannot put an unsubscribed person back on the list; consent time is recorded; the owner can mark someone unsubscribed', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    await a.put('/api/admin/settings', { mailing_list_on: true });
    const started = await s.formToken();
    const sub = (email) => s.j('POST', '/api/subscribe', { email, consent: true, started });
    assert.equal((await sub('pat@example.com')).status, 200);
    let row = (await a.get('/api/admin/subscribers')).data[0];
    assert.equal(row.unsubscribed, 0); assert.ok(row.consent_at > 0, 'when the box was ticked is recorded');
    assert.equal((await a.put('/api/admin/subscribers/' + row.id, { unsubscribed: 'yes' })).status, 400, 'must be true or false');
    assert.equal((await a.put('/api/admin/subscribers/' + row.id, { unsubscribed: true })).status, 200);
    assert.equal((await a.put('/api/admin/subscribers/99999', { unsubscribed: true })).status, 404);
    assert.equal((await sub('PAT@example.com')).status, 200, 'the visitor sees no difference');
    row = (await a.get('/api/admin/subscribers')).data[0];
    assert.equal(row.unsubscribed, 1, 'still unsubscribed');
    const csv = (await fetch(s.base + '/api/admin/subscribers.csv', { headers: a.t }).then((r) => r.text()));
    assert.match(csv, /pat@example.com,.*,unsubscribed/);
    assert.equal((await a.put('/api/admin/subscribers/' + row.id, { unsubscribed: false })).status, 200);
    assert.equal((await a.get('/api/admin/subscribers')).data[0].unsubscribed, 0);
  } finally { s.stop(); }
});

test('item 80: impossible dates are refused (9999-99-99, Feb 30), real ones are fine', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const disc = (extra) => a.post('/api/admin/discounts', { code: 'D' + Math.random().toString(36).slice(2, 7).toUpperCase(), kind: 'percent', value: 10, ...extra });
    for (const bad of ['9999-99-99', '2026-02-30', '2026-13-01', '0000-00-00', '1999-01-01']) {
      assert.equal((await disc({ expires_on: bad })).status, 400, 'expiry ' + bad);
      assert.equal((await disc({ starts_on: bad })).status, 400, 'start ' + bad);
      assert.equal((await a.put('/api/admin/settings', { break_from: bad })).status, 400, 'pause from ' + bad);
    }
    assert.equal((await disc({ expires_on: '2027-02-28', starts_on: '2026-12-31' })).status, 200);
    assert.equal((await a.put('/api/admin/settings', { break_from: '2027-03-01', break_until: '2027-03-15' })).status, 200);
  } finally { s.stop(); }
});

test('item 80: only the US and Canada are accepted as a country (Japan used to be priced as the US)', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = (await a.post('/api/admin/products', { name: 'Thing', price_cents: 1000, stock: 5 })).data.id;
    const addr = { email: 'buyer@example.com', name: 'Pat', line1: '5 Elm St', line2: '', city: 'Portland', state: 'OR', zip: '97201' };
    const q = (country) => s.j('POST', '/api/quote', { items: [{ id: pid, qty: 1 }], address: { ...addr, country } });
    const jp = await q('JP');
    assert.equal(jp.status, 400); assert.match(jp.data.error, /US and Canada/);
    assert.equal((await q('Japan')).status, 400);
    assert.equal((await q('US')).status, 200);
    assert.equal((await q('United States')).status, 200);
  } finally { s.stop(); }
});

test('item 80: the shop timezone decides what "today" is for discount dates', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = (await a.post('/api/admin/products', { name: 'Thing', price_cents: 1000, stock: 5 })).data.id;
    const east = 'Pacific/Kiritimati', west = 'Pacific/Pago_Pago';   // 25 hours apart: their calendar days always differ
    assert.notEqual(ymd(east), ymd(west));
    assert.equal((await a.put('/api/admin/settings', { timezone: 'Mars/Olympus' })).status, 400);
    assert.equal((await a.post('/api/admin/discounts', { code: 'LASTDAY', kind: 'percent', value: 10, expires_on: ymd(west) })).status, 200);
    assert.equal((await a.post('/api/admin/discounts', { code: 'FIRSTDAY', kind: 'percent', value: 10, starts_on: ymd(east) })).status, 200);
    const q = (code) => s.j('POST', '/api/quote', { items: [{ id: pid, qty: 1 }], code });
    assert.equal((await a.put('/api/admin/settings', { timezone: east })).status, 200);
    assert.equal((await q('LASTDAY')).status, 400, 'it is already the next day where the shop is');
    assert.equal((await q('FIRSTDAY')).status, 200);
    assert.equal((await a.put('/api/admin/settings', { timezone: west })).status, 200);
    assert.equal((await q('LASTDAY')).status, 200, 'still the last day where the shop is');
    assert.equal((await q('FIRSTDAY')).status, 400, 'not started yet where the shop is');
    assert.equal((await s.j('GET', '/api/settings')).data.timezone, west);
  } finally { s.stop(); }
});

test('item 78: indexes exist, the order list never loses an old unshipped order, and the exports use few queries', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const dbh = open(s);
    for (const q of ['SELECT * FROM order_items WHERE order_id=1', "SELECT * FROM orders WHERE stripe_session_id='x'", "SELECT * FROM auctions WHERE pay_token='x'", "SELECT * FROM bidders WHERE email='x'", 'SELECT * FROM bids WHERE bidder_id=1'])
      assert.match(dbh.prepare('EXPLAIN QUERY PLAN ' + q).all().map((r) => r.detail).join(' '), /USING (COVERING )?INDEX/, q);
    const ins = dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, customer_email, fulfillment, public_token, shipping_json) VALUES ('online','card','paid',1000,?,?,?,?)");
    const item = dbh.prepare("INSERT INTO order_items (order_id, name, unit_price_cents, quantity) VALUES (?,?,?,?)");
    dbh.transaction(() => {
      for (let i = 1; i <= 250; i++) { const id = ins.run(`c${i % 5}@example.com`, i === 1 ? '' : 'shipped', 'tk' + i, JSON.stringify({ name: 'Cust ' + (i % 5) })).lastInsertRowid; item.run(id, 'Mug', 1000, 2); }
    })();
    const list = await a.get('/api/admin/orders');
    assert.equal(list.data.length, 201, 'newest 200 plus the one old order still waiting to ship');
    assert.ok(list.data.some((o) => o.id === 1), 'order #1 (unshipped) is reachable');
    const res = await fetch(s.base + '/api/admin/orders', { headers: a.t });
    assert.equal(res.headers.get('x-total-orders'), '250');
    const page2 = await a.get('/api/admin/orders?before=51&limit=10');
    assert.deepEqual(page2.data.map((o) => o.id), [50, 49, 48, 47, 46, 45, 44, 43, 42, 41]);
    const csv = await fetch(s.base + '/api/admin/orders.csv', { headers: a.t }).then((r) => r.text());
    assert.equal(csv.trim().split('\n').length, 251);
    assert.match(csv, /2x Mug/);
    const cust = (await a.get('/api/admin/customers')).data;
    assert.equal(cust.length, 5);
    assert.equal(cust[0].orders, 50); assert.equal(cust[0].spent_cents, 50000); assert.match(cust[0].name, /^Cust \d$/);
    // lots: an old open one stays on the list however many newer ones there are
    const lot = dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at) VALUES (?,?,?,?,?,?,?)");
    dbh.transaction(() => { lot.run('Old open', 100, 100, 0, Date.now() + 9e9, 'open', 0); for (let i = 0; i < 320; i++) lot.run('Lot ' + i, 100, 100, 0, Date.now() - 1e6, 'unsold', 0); })();
    const lots = (await a.get('/api/admin/auctions')).data;
    assert.equal(lots.length, 301);
    assert.ok(lots.some((l) => l.title === 'Old open'));
    dbh.close();
  } finally { s.stop(); }
});

test('item 77: a blank price or stock cell no longer wipes real data; a big import is accepted', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const pid = (await a.post('/api/admin/products', { name: 'Mug', price_cents: 1200, stock: 8 })).data.id;
    const imp = (rows) => a.post('/api/admin/products/import', { rows });
    let r = (await imp([{ name: 'Mug', price: '', stock: '' }])).data;
    assert.equal(r.updated, 1); assert.deepEqual(r.errors, []);
    let p = (await a.get('/api/admin/products')).data.find((x) => x.id === pid);
    assert.equal(p.price_cents, 1200); assert.equal(p.stock, 8, 'blank cells keep what is there');
    r = (await imp([{ name: 'Mug', price: '15.50' }])).data;   // a name,price-only file
    p = (await a.get('/api/admin/products')).data.find((x) => x.id === pid);
    assert.equal(p.price_cents, 1550); assert.equal(p.stock, 8, 'a missing stock column keeps the stock');
    r = (await imp([{ name: 'Fresh', price: '' }, { name: 'Fresh2', price: 'abc' }, { name: 'Fine', price: '$3.00', stock: '4' }])).data;
    assert.equal(r.created, 1);
    assert.deepEqual(r.errors.map((e) => [e.row, e.error]), [[1, 'Price is missing'], [2, 'Price is not a number (use 12 or 12.50)']]);
    const names = (await a.get('/api/admin/products')).data.map((x) => x.name);
    assert.ok(names.includes('Fine') && !names.includes('Fresh') && !names.includes('Fresh2'), 'no $0.00 product was created');
    // 600 rows is well over the normal 100 KB request limit
    const rows = Array.from({ length: 600 }, (_, i) => ({ name: 'Bulk ' + i, price: '2.00', stock: '1', description: 'x'.repeat(250) }));
    assert.ok(JSON.stringify({ rows }).length > 100 * 1024);
    r = await imp(rows);
    assert.equal(r.status, 200); assert.equal(r.data.created, 600);
    const huge = await imp(Array.from({ length: 1500 }, (_, i) => ({ name: 'H' + i, price: '1', description: 'y'.repeat(2500) })));
    assert.equal(huge.status, 413); assert.match(huge.data.error, /too large to import/, 'the message is about the import, not about images');
  } finally { s.stop(); }
});

test('item 81: the database itself refuses a made-up order status, a rating of 6, negative stock and a repeated SKU', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    await a.post('/api/admin/products', { name: 'A', price_cents: 100, stock: 1, sku: 'SKU-1' });
    const dbh = open(s);
    assert.throws(() => dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents) VALUES ('online','card','banana',1)").run(), /invalid order status/);
    const oid = dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents) VALUES ('online','card','paid',1)").run().lastInsertRowid;
    assert.throws(() => dbh.prepare("UPDATE orders SET status='whatever' WHERE id=?").run(oid), /invalid order status/);
    dbh.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(oid);
    assert.throws(() => dbh.prepare("INSERT INTO reviews (order_id, rating, name, created_at) VALUES (?,6,'x',0)").run(oid), /invalid rating/);
    assert.throws(() => dbh.prepare("INSERT INTO reviews (order_id, rating, name, created_at) VALUES (?,0,'x',0)").run(oid), /invalid rating/);
    assert.throws(() => dbh.prepare('UPDATE products SET stock = -1').run(), /stock cannot be negative/);
    assert.throws(() => dbh.prepare("INSERT INTO products (name, price_cents, stock, sku) VALUES ('B', 1, 1, 'sku-1')").run(), /UNIQUE/);
    dbh.close();
  } finally { s.stop(); }
});

test('item 81: photo storage has a ceiling, and photos nothing uses can be found and removed', async () => {
  const s = await startServer({ IMAGES_MAX_MB: '1' });
  try {
    const a = await admin(s);
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), crypto.randomBytes(600 * 1024)]);
    const up = () => fetch(s.base + '/api/admin/upload', { method: 'POST', headers: { ...a.t, 'content-type': 'image/png' }, body: png });
    const r1 = await up(); assert.equal(r1.status, 200); const url1 = (await r1.json()).url;
    const r2 = await up(); assert.equal(r2.status, 400); assert.match((await r2.json()).error, /photo storage is full \(1 MB\)/);
    // the first photo is not used by anything
    let c = (await a.post('/api/admin/images/cleanup', {})).data;
    assert.equal(c.unused, 1); assert.equal(c.deleted, false); assert.ok(fs.existsSync(path.join(s.dir, url1.replace('/images/', 'images/'))));
    // use it as a product photo: no longer unused
    await a.post('/api/admin/products', { name: 'P', price_cents: 100, stock: 1, image_url: url1, images: [url1] });
    c = (await a.post('/api/admin/images/cleanup', {})).data;
    assert.equal(c.unused, 0);
    await a.put('/api/admin/settings', { logo_url: '' });
    // remove the product's use of it, then delete
    const dbh = open(s); dbh.prepare("UPDATE products SET image_url=NULL, images='[]'").run(); dbh.close();
    c = (await a.post('/api/admin/images/cleanup', { delete: true })).data;
    assert.equal(c.unused, 1); assert.equal(c.deleted, true);
    assert.equal(fs.existsSync(path.join(s.dir, url1.replace('/images/', 'images/'))), false);
  } finally { s.stop(); }
});

test('item 38 (code): bidder sign-in tokens are stored hashed, old ones are hashed on upgrade, and sessions keep no address', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const started = await s.formToken();
    const r = await s.j('POST', '/api/bidders', { name: 'Bea', email: 'bea@example.com', address: { line1: '1 Main', city: 'Portland', state: 'OR', zip: '97201', country: 'US' }, started });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const dbh = open(s);
    assert.equal(dbh.prepare('SELECT token FROM bidders').get().token, hashTok(r.data.token), 'the stored value is the hash, never the token itself');
    assert.equal(dbh.prepare('SELECT ip FROM admin_sessions').get().ip, '', 'a session does not remember an address');
    assert.equal((await s.j('POST', '/api/bidders/address', { address: { line1: '1 Main', city: 'Portland', state: 'OR', zip: '97201', country: 'US' } }, { 'x-bidder-token': r.data.token })).status, 200, 'the real token still signs her in');
    assert.equal((await s.j('POST', '/api/bidders/address', { address: { line1: '1 Main', city: 'Portland', state: 'OR', zip: '97201', country: 'US' } }, { 'x-bidder-token': hashTok(r.data.token) })).status, 401, 'the stored hash is not itself a working token');
    // a database from before this release: plain token, old version number
    dbh.prepare("UPDATE bidders SET token='plain-old-token'").run(); dbh.pragma('user_version = 1'); dbh.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at, ip) VALUES ('h', 1, ?, '9.9.9.9')").run(Date.now() + 1e6);
    dbh.close();
    s.stop(true);
    const s2 = await startServer({ DATA_DIR: s.dir });
    try {
      const d2 = open(s);   // (the second app uses the first one's folder)
      assert.equal(d2.prepare('SELECT token FROM bidders').get().token, hashTok('plain-old-token'));
      assert.equal(d2.prepare("SELECT ip FROM admin_sessions WHERE token_hash='h'").get().ip, '');
      d2.close();
      assert.equal((await s2.j('POST', '/api/bidders/address', { address: { line1: '1 Main', city: 'Portland', state: 'OR', zip: '97201', country: 'US' } }, { 'x-bidder-token': 'plain-old-token' })).status, 200, 'her saved sign-in still works after the upgrade');
    } finally { s2.stop(); }
  } finally { s.stop(); }
});

test('item 79: "erase this person" blanks their name, email, address and card everywhere, keeps the sales records, and is careful', async () => {
  const fake = await startFakeStripe();
  const s = await startServer({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http' });
  try {
    const a = await admin(s);
    const dbh = open(s);
    const email = 'erase.me@example.com';
    const bid = dbh.prepare("INSERT INTO bidders (name, email, token, created_at, address_json, stripe_customer_id, stripe_payment_method, card_brand, card_last4, card_at) VALUES ('Erin Me',?,?,?,?,'cus_erase','pm_1','visa','4242',1)")
      .run(email, hashTok('e'), Date.now(), JSON.stringify({ line1: '1 Secret St' })).lastInsertRowid;
    const aid = dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at) VALUES ('Lot',100,100,0,?,'open',0)").run(Date.now() + 1e9).lastInsertRowid;
    const bidRow = dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,200,0)').run(aid, bid).lastInsertRowid;
    dbh.prepare('INSERT INTO watches (bidder_id, auction_id) VALUES (?,?)').run(bid, aid);
    const ord = (status, fulfillment, extra = '') => dbh.prepare(`INSERT INTO orders (channel, payment_method, status, total_cents, customer_email, shipping_json, fulfillment, public_token ${extra ? ', ' + extra.split('=')[0] : ''}) VALUES ('online','card',?,5000,?,?,?,? ${extra ? ', ' + extra.split('=')[1] : ''})`)
      .run(status, email, JSON.stringify({ name: 'Erin Me', address: { line1: '1 Secret St' } }), fulfillment, 'tk' + Math.random()).lastInsertRowid;
    const shipped = ord('paid', 'shipped'); const waiting = ord('paid', '');
    dbh.prepare("INSERT INTO reviews (order_id, rating, name, created_at) VALUES (?,5,'Erin M.',0)").run(shipped);
    await a.put('/api/admin/settings', { mailing_list_on: true });
    dbh.prepare("INSERT INTO subscribers (email, source, created_at) VALUES (?,?,?)").run(email, 'links', 1);
    const erase = (body) => a.post('/api/admin/privacy/erase', { email, ...body });

    assert.equal((await a.post('/api/admin/privacy/erase', { email: 'nope' })).status, 400);
    let r = await erase({});
    assert.equal(r.status, 409); assert.match(r.data.error, /bidding in a lot that is still open/);
    dbh.prepare('UPDATE bids SET voided=1 WHERE id=?').run(bidRow);
    r = await erase({});
    assert.equal(r.status, 409); assert.match(r.data.error, new RegExp('#' + waiting + ' is paid but not shipped'));
    assert.equal(dbh.prepare('SELECT customer_email e FROM orders WHERE id=?').get(shipped).e, email, 'nothing was changed by the refusals');
    dbh.prepare("UPDATE orders SET status='pending', charge_status='charging' WHERE id=?").run(waiting);
    assert.equal((await erase({ force: true })).status, 409, 'a payment in progress is never interrupted');
    dbh.prepare("UPDATE orders SET status='paid', charge_status='' WHERE id=?").run(waiting);

    r = await erase({ force: true });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.bidders, 1); assert.equal(r.data.orders, 2); assert.equal(r.data.subscribers, 1); assert.equal(r.data.stripe_customers_deleted, 1);
    assert.deepEqual(fake.st.deletedCustomers, ['cus_erase'], 'the saved-card customer is deleted at Stripe too');
    const b = dbh.prepare('SELECT * FROM bidders WHERE id=?').get(bid);
    assert.equal(b.name, 'Removed bidder'); assert.equal(b.email, `removed-${bid}@invalid`);
    for (const k of ['address_json', 'stripe_customer_id', 'stripe_payment_method', 'card_brand', 'card_last4', 'card_at']) assert.equal(b[k], null, k);
    assert.equal(dbh.prepare('SELECT COUNT(*) c FROM watches WHERE bidder_id=?').get(bid).c, 0);
    assert.equal(dbh.prepare('SELECT COUNT(*) c FROM bids WHERE bidder_id=?').get(bid).c, 1, 'the bid history stays, without a name');
    for (const id of [shipped, waiting]) { const o = dbh.prepare('SELECT * FROM orders WHERE id=?').get(id); assert.equal(o.customer_email, ''); assert.equal(o.shipping_json, null); assert.equal(o.total_cents, 5000, 'the sale itself is kept'); }
    assert.equal(dbh.prepare('SELECT name FROM reviews').get().name, 'Anonymous');
    assert.equal(dbh.prepare('SELECT COUNT(*) c FROM subscribers').get().c, 0);
    assert.equal((await a.get('/api/admin/customers')).data.some((c) => /erase\.me|removed-/.test(c.email)), false, 'they no longer appear in your customer list');
    const log = (await a.get('/api/admin/security')).data;
    assert.ok(JSON.stringify(log).includes('privacy_erase')); assert.equal(JSON.stringify(log).includes(email), false, 'the log does not name them');
    // nothing left in the file
    dbh.close(); s.stop(true);
    const d = new Database(path.join(s.dir, 'outpost.db')); d.pragma('wal_checkpoint(TRUNCATE)'); d.close();
    assert.equal(fs.readFileSync(path.join(s.dir, 'outpost.db')).includes(Buffer.from('1 Secret St')), false, 'their address is gone from the file itself');
    fs.rmSync(s.dir, { recursive: true, force: true });
  } finally { s.stop(); await fake.close(); }
});

test('item 79: old canceled auction orders lose the winner\'s email and address; expired sign-in records are removed', () => {
  const dir = tmp('outpost-hk2-');
  const r = spawnSync(process.execPath, ['-e', `
    const db = require('./db.js'); const { pruneAbandoned } = require('./housekeeping.js');
    const o = (ch, st, days) => db.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, customer_email, shipping_json, created_at) VALUES (?, 'card', ?, 100, 'w@example.com', '{\\"name\\":\\"W\\"}', datetime('now', ?))").run(ch, st, '-' + days + ' days').lastInsertRowid;
    const oldCanceled = o('auction', 'canceled', 100), recentCanceled = o('auction', 'canceled', 5), oldPaid = o('auction', 'paid', 100);
    db.prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES ('old', 1, 2), ('live', 1, ?)").run(Date.now() + 1e6);
    db.prepare("INSERT INTO trusted_devices (token_hash, created_at, expires_at) VALUES ('old', 1, 2), ('live', 1, ?)").run(Date.now() + 1e6);
    const res = pruneAbandoned(db);
    const email = (id) => db.prepare('SELECT customer_email e, shipping_json s FROM orders WHERE id=?').get(id);
    process.stdout.write(JSON.stringify({ res, a: email(oldCanceled), b: email(recentCanceled), c: email(oldPaid),
      sess: db.prepare('SELECT token_hash t FROM admin_sessions').all().map((x) => x.t), dev: db.prepare('SELECT token_hash t FROM trusted_devices').all().map((x) => x.t) }));
  `], { cwd: ROOT, env: { PATH: process.env.PATH, DB_PATH: path.join(dir, 'h.db') }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.equal(o.res.wiped, 1);
  assert.deepEqual(o.a, { e: '', s: null }); assert.equal(o.b.e, 'w@example.com', 'a recent one is kept'); assert.equal(o.c.e, 'w@example.com', 'a paid one is never touched');
  assert.deepEqual(o.sess, ['live']); assert.deepEqual(o.dev, ['live']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('item 40: .env.example exists, is not ignored by git, and covers the settings the app reads', () => {
  const ex = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
  for (const v of ['ADMIN_PASSWORD', 'BASE_URL', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'DATA_DIR', 'TRUST_PROXY', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET_KEY', 'TZ', 'CURRENCY', 'IMAGES_MAX_MB'])
    assert.match(ex, new RegExp('^#?\\s*' + v + '=', 'm'), v + ' is explained');
  assert.doesNotMatch(ex, /sk_(live|test)_[A-Za-z0-9]{8,}/, 'no real key is in the example');
  const ig = spawnSync('git', ['check-ignore', '.env.example'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ig.status, 1, '.env.example is NOT ignored (it is meant to be committed)');
  const ig2 = spawnSync('git', ['check-ignore', '.env'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(ig2.status, 0, '.env IS ignored');
});
