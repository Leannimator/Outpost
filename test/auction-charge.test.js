'use strict';
// Run with: npm test. Checks review items 26, 27, 55, 56, 57, 58 and 59 (auction charging) against a real running copy of the app
// talking to a pretend Stripe (test/fakestripe.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const { startServer, PASSWORD, sleep } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
const envFor = (fake) => ({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http' });
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(150); } }
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { post: (u, b) => s.j('POST', u, b, t), get: (u) => s.j('GET', u, undefined, t) }; }

// A lot that has been won: closed auction, winning bid, unpaid order with an address, and (optionally) a saved card.
function seedWin(dbh, { card = true, subtotal = 9500 } = {}) {
  const addr = { email: 'w@example.com', name: 'Win Ner', country: 'US', line1: '1 Main', line2: '', city: 'Portland', state: 'OR', zip: '97201' };
  const bidder = dbh.prepare("INSERT INTO bidders (name, email, token, created_at, address_json, stripe_customer_id, stripe_payment_method) VALUES ('Win Ner','w@example.com',?,?,?,?,?)")
    .run('bt' + Math.random(), Date.now(), JSON.stringify(addr), card ? 'cus_win' : null, card ? 'pm_1' : null).lastInsertRowid;
  const aid = dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at, pay_token) VALUES ('Lot',100,100,0,?,'closed',0,?)").run(Date.now() - 5000, 'pay' + Math.random().toString(36).slice(2)).lastInsertRowid;
  const bid = dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,?,0)').run(aid, bidder, subtotal).lastInsertRowid;
  const oid = dbh.prepare("INSERT INTO orders (channel, payment_method, status, subtotal_cents, tax_cents, total_cents, shipping_cents, auction_id, public_token, shipping_json, customer_email) VALUES ('auction','card','pending',?,0,?,0,?,?,?,'w@example.com')")
    .run(subtotal, subtotal, aid, 'rk' + Math.random().toString(36).slice(2, 10), JSON.stringify({ name: 'Win Ner', address: { line1: '1 Main', city: 'Portland', state: 'OR', postal_code: '97201', country: 'US' } })).lastInsertRowid;
  dbh.prepare("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?,NULL,'Lot (Lot 1)',?,1)").run(oid, subtotal);
  dbh.prepare('UPDATE auctions SET winner_bid_id=?, order_id=? WHERE id=?').run(bid, oid, aid);
  return { aid, oid, bidder, payToken: dbh.prepare('SELECT pay_token t FROM auctions WHERE id=?').get(aid).t };
}
const orderRow = (dbh, oid) => dbh.prepare('SELECT * FROM orders WHERE id=?').get(oid);
const webhook = async (s, type, object) => {
  const payload = JSON.stringify({ id: 'evt_' + Math.random(), object: 'event', type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  return fetch(s.base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
};

test('item 56: the app stopping right after the card was charged does not charge again or lose the payment', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  let s = await startServer(env), s2;
  try {
    const dbh = open(s); const w = seedWin(dbh);
    fake.st.delayIntentMs = 800;
    fake.st.onIntentCreated = () => s.proc.kill('SIGKILL');   // the charge exists at Stripe, the app dies before it hears back
    await waitFor(() => fake.st.intents.length === 1);
    await sleep(400); s.stop(true); fake.st.onIntentCreated = null; fake.st.delayIntentMs = 0;
    assert.equal(orderRow(dbh, w.oid).status, 'pending', 'the app never learned it was paid');
    s2 = await startServer({ ...env, DATA_DIR: s.dir });
    await waitFor(() => orderRow(dbh, w.oid).status === 'paid');
    const o = orderRow(dbh, w.oid);
    assert.equal(fake.st.intents.length, 1, 'only one charge in total');
    assert.equal(o.stripe_payment_intent, fake.st.intents[0].id); assert.equal(o.charge_status, 'paid'); assert.equal(o.charge_error, null);
    dbh.close();
  } finally { try { s2 && s2.stop(); } catch { /* */ } s.stop(); fake.close(); }
});

test('item 56: the app stopping before Stripe answered finishes the same charge once, with the same key', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  let s = await startServer(env), s2;
  try {
    const dbh = open(s); const w = seedWin(dbh);
    fake.st.hangIntent = true; fake.st.onIntentCreated = () => s.proc.kill('SIGKILL');
    await waitFor(() => fake.st.calls.includes('POST /v1/payment_intents')); await sleep(400); s.stop(true);
    assert.equal(fake.st.intents.length, 0);
    const mid = orderRow(dbh, w.oid); assert.equal(typeof mid.charge_attempt, 'string'); assert.ok(mid.charge_attempt.length > 0, 'the attempt was written down before Stripe was asked');
    fake.st.hangIntent = false; fake.st.onIntentCreated = null;
    s2 = await startServer({ ...env, DATA_DIR: s.dir });
    await waitFor(() => orderRow(dbh, w.oid).status === 'paid');
    assert.equal(fake.st.intents.length, 1);
    assert.equal(fake.st.intents[0].amount, orderRow(dbh, w.oid).total_cents, 'the same amount that was written down');
    assert.deepEqual([...fake.st.keys.keys()], [`outpost-lot-order-${w.oid}-${mid.charge_attempt}`], 'retried with the key that was written down');
    dbh.close();
  } finally { try { s2 && s2.stop(); } catch { /* */ } s.stop(); fake.close(); }
});

test('item 57: a problem marking the order paid after a good charge is not treated as a failed charge', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s); const w = seedWin(dbh); const a = await admin(s);
    dbh.exec("CREATE TRIGGER nopaid BEFORE UPDATE OF status ON orders WHEN NEW.status='paid' BEGIN SELECT RAISE(ABORT, 'disk full'); END;");
    await waitFor(() => orderRow(dbh, w.oid).charge_status === 'paid');
    let o = orderRow(dbh, w.oid);
    assert.equal(o.status, 'pending'); assert.equal(o.charge_error, null); assert.equal(o.stripe_payment_intent, fake.st.intents[0].id, 'the payment is on record');
    assert.equal((await a.post(`/api/admin/auctions/${w.aid}/next-bidder`, {})).status, 409, 'the lot cannot be moved on to a second bidder (and a second charge)');
    assert.equal((await fetch(s.base + '/pay/' + w.payToken)).status, 409, 'and the payment link will not make another payment page');
    dbh.exec('DROP TRIGGER nopaid');
    await waitFor(() => orderRow(dbh, w.oid).status === 'paid', 15000);
    assert.equal(fake.st.intents.length, 1, 'never charged twice');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 55: "cancel lot" is refused while the card is being charged', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s); const a = await admin(s);
    fake.st.delayIntentMs = 3000;
    const w = seedWin(dbh);
    await waitFor(() => orderRow(dbh, w.oid).charge_status === 'charging');
    const r = await a.post(`/api/admin/auctions/${w.aid}/cancel`, {});
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.equal(orderRow(dbh, w.oid).status, 'pending'); assert.equal(dbh.prepare('SELECT status FROM auctions WHERE id=?').get(w.aid).status, 'closed');
    await waitFor(() => orderRow(dbh, w.oid).status === 'paid');
    assert.equal((await a.post(`/api/admin/auctions/${w.aid}/cancel`, {})).status, 400, 'and once paid it cannot be canceled either');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 59: canceling closes EVERY payment page that was ever made for the order', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s); const a = await admin(s);
    const w = seedWin(dbh, { card: false });
    const mk = (id) => fake.st.sessions.set(id, { id, status: 'open', payment_status: 'unpaid', url: 'https://x/' + id, expires_at: Math.floor(Date.now() / 1000) + 3000 });
    for (const id of ['cs_old1', 'cs_old2', 'cs_new']) { mk(id); dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(w.oid, id); }
    dbh.prepare("UPDATE orders SET stripe_session_id='cs_new' WHERE id=?").run(w.oid);
    assert.equal((await a.post(`/api/admin/auctions/${w.aid}/next-bidder`, {})).status, 200);
    await waitFor(() => ['cs_old1', 'cs_old2', 'cs_new'].every((id) => fake.st.sessions.get(id).status === 'expired'));
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('items 27 and 58: the payment link never leaves two payable pages, and never starts a second payment', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s); const w = seedWin(dbh, { card: false });
    const visit = () => fetch(s.base + '/pay/' + w.payToken, { redirect: 'manual' });
    const first = await visit(); assert.equal(first.status, 303);
    const again = await visit(); assert.equal(again.headers.get('location'), first.headers.get('location'), 'a second visit gets the same open page');
    assert.equal(fake.st.sessions.size, 1);
    const [id1, cs1] = [...fake.st.sessions][0]; cs1.expires_at = Math.floor(Date.now() / 1000) + 120;   // nearly expired: a new one is made
    const third = await visit(); assert.equal(third.status, 303); assert.notEqual(third.headers.get('location'), first.headers.get('location'));
    assert.equal(fake.st.sessions.get(id1).status, 'expired', 'the old page was closed');
    assert.equal([...fake.st.sessions.values()].filter((c) => c.status === 'open').length, 1, 'exactly one payable page');
    // a page that was already paid: no new page
    const open1 = [...fake.st.sessions.values()].find((c) => c.status === 'open'); open1.status = 'complete'; open1.payment_status = 'paid';
    assert.equal((await visit()).status, 409);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 58: the automatic charge closes an open payment page first, and does not charge if that page was paid', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s);
    const w = seedWin(dbh, { card: false });
    assert.equal((await fetch(s.base + '/pay/' + w.payToken, { redirect: 'manual' })).status, 303);
    const [id, cs] = [...fake.st.sessions][0];
    dbh.prepare("UPDATE bidders SET stripe_customer_id='cus_win', stripe_payment_method='pm_1' WHERE id=?").run(w.bidder);   // the buyer adds a card: auto-charge starts
    await waitFor(() => orderRow(dbh, w.oid).status === 'paid');
    assert.equal(fake.st.sessions.get(id).status, 'expired', 'the open page was closed before charging');
    assert.equal(fake.st.intents.length, 1);
    // second lot: its page was already paid, so the card must not be charged as well
    const w2 = seedWin(dbh, { card: false });
    assert.equal((await fetch(s.base + '/pay/' + w2.payToken, { redirect: 'manual' })).status, 303);
    const paidPage = [...fake.st.sessions.values()].pop(); paidPage.status = 'complete'; paidPage.payment_status = 'paid';
    dbh.prepare("UPDATE bidders SET stripe_customer_id='cus_win', stripe_payment_method='pm_1' WHERE id=?").run(w2.bidder);
    await sleep(7000);
    assert.equal(fake.st.intents.length, 1, 'no second charge');
    assert.equal(orderRow(dbh, w2.oid).status, 'pending');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 27: a second, different payment on an already-paid order is written down for the owner', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s); const a = await admin(s);
    const w = seedWin(dbh, { card: false });
    dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(w.oid, 'cs_x');
    const done = (pi) => ({ id: 'cs_x', mode: 'payment', payment_status: 'paid', payment_intent: pi, metadata: { order_id: String(w.oid) } });
    assert.equal((await webhook(s, 'checkout.session.completed', done('pi_A'))).status, 200);
    assert.equal(orderRow(dbh, w.oid).status, 'paid');
    await webhook(s, 'checkout.session.completed', done('pi_A'));   // Stripe re-sending the same event: normal
    const ev = async () => (await a.get('/api/admin/security')).data.recent.filter((e) => e.kind === 'double_payment');
    assert.equal((await ev()).length, 0);
    await webhook(s, 'checkout.session.completed', done('pi_B'));
    const found = await ev(); assert.equal(found.length, 1); assert.match(found[0].detail, /pi_A and pi_B/);
    assert.equal(orderRow(dbh, w.oid).duplicate_payments, 'pi_B');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 26: a lot paid through its payment link is recorded with the amount that was really paid', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  const s = await startServer(env);
  try {
    const dbh = open(s);
    const w = seedWin(dbh, { card: false, subtotal: 9500 });
    dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(w.oid, 'cs_y');
    const paid = { id: 'cs_y', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_Z', amount_total: 10450, automatic_tax: { enabled: true }, total_details: { amount_tax: 950 }, metadata: { order_id: String(w.oid) } };
    assert.equal((await webhook(s, 'checkout.session.completed', paid)).status, 200);
    const o = orderRow(dbh, w.oid);
    assert.equal(o.status, 'paid'); assert.equal(o.total_cents, 10450); assert.equal(o.tax_cents, 950);
    // a canceled order is never rewritten by a late payment event
    const w2 = seedWin(dbh, { card: false, subtotal: 5000 });
    dbh.prepare("UPDATE orders SET status='canceled' WHERE id=?").run(w2.oid);
    dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(w2.oid, 'cs_z');
    await webhook(s, 'checkout.session.completed', { ...paid, id: 'cs_z', payment_intent: 'pi_Q', metadata: { order_id: String(w2.oid) } });
    assert.equal(orderRow(dbh, w2.oid).total_cents, 5000);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});
