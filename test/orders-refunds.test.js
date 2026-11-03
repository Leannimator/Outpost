'use strict';
// Run with: npm test. Checks review items 28 to 33, 35, 36 and 63 to 69 (refunds, late payments, card saving, forms) against a real running copy of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const Stripe = require('stripe');
const Safe = require('../safe');
const { startServer, PASSWORD, sleep } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
const envFor = (fake, more = {}) => ({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http', ...more });
async function waitFor(fn, ms = 20000) { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timed out waiting'); await sleep(150); } }
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, post: (u, b) => s.j('POST', u, b, t), get: (u) => s.j('GET', u, undefined, t) }; }
const webhook = async (s, type, object) => {
  const payload = JSON.stringify({ id: 'evt_' + Math.random(), object: 'event', type, data: { object } });
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_test' });
  return fetch(s.base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': header }, body: payload });
};
const events = async (a, kind) => (await a.get('/api/admin/security')).data.recent.filter((e) => e.kind === kind);
const orderRow = (dbh, id) => dbh.prepare('SELECT * FROM orders WHERE id=?').get(id);
const stock = (dbh, pid) => dbh.prepare('SELECT stock FROM products WHERE id=?').get(pid).stock;
const ADDR = { email: 'buyer@example.com', name: 'Pat Buyer', country: 'US', line1: '5 Elm St', line2: '', city: 'Portland', state: 'OR', zip: '97201' };

function addProductDb(dbh, stockN = 5, price = 1000) {
  return Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Thing', ?, ?, 1)").run(price, stockN).lastInsertRowid);
}
// An online card order. `ago` is how long ago it was started; `sessions` are the Stripe pages made for it.
function addOrder(dbh, { pid, qty = 1, total = 1000, status = 'pending', ago = '-1 minutes', sessions = [], pi = null, refunded = 0, email = 'b@example.com' } = {}) {
  const id = Number(dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, customer_email, created_at, public_token, stripe_session_id, stripe_payment_intent, refunded_cents) VALUES ('online','card',?,?,?,?,datetime('now', ?),?,?,?,?)")
    .run(status, total, total, email, ago, 'tok' + Math.random().toString(36).slice(2, 12), sessions[0] || null, pi, refunded).lastInsertRowid);
  if (pid) dbh.prepare("INSERT INTO order_items (order_id, product_id, name, unit_price_cents, quantity) VALUES (?,?,'Thing',?,?)").run(id, pid, Math.round(total / qty), qty);
  for (const sid of sessions) dbh.prepare('INSERT INTO order_sessions (order_id, session_id, created_at) VALUES (?,?,0)').run(id, sid);
  return id;
}
const paidSession = (id, over = {}) => ({ id, object: 'checkout.session', mode: 'payment', status: 'complete', payment_status: 'paid', currency: 'usd', amount_total: 1000, payment_intent: 'pi_' + id, ...over });

test('items 28 and 65: an old unpaid order is only canceled after Stripe says it was NOT paid', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake, { SWEEP_EVERY_MS: '1500' }));
  try {
    const dbh = open(s);
    const pid = addProductDb(dbh, 5);
    fake.st.sessions.set('cs_paid', paidSession('cs_paid'));
    fake.st.sessions.set('cs_open', { id: 'cs_open', status: 'open', payment_status: 'unpaid' });
    const paid = addOrder(dbh, { pid, ago: '-3 hours', sessions: ['cs_paid'] });
    const unpaid = addOrder(dbh, { pid, ago: '-3 hours', sessions: ['cs_open'] });
    const unknown = addOrder(dbh, { pid, ago: '-3 hours', sessions: ['cs_missing'] });   // Stripe cannot say: leave it alone
    const nopage = addOrder(dbh, { pid, ago: '-3 hours' });
    await waitFor(() => orderRow(dbh, unpaid).status === 'canceled');
    assert.equal(orderRow(dbh, paid).status, 'paid', 'it was paid, the message was just late');
    assert.equal(orderRow(dbh, paid).stripe_payment_intent, 'pi_cs_paid'); assert.equal(stock(dbh, pid), 4, 'stock taken once');
    assert.equal(fake.st.sessions.get('cs_open').status, 'expired', 'its payment page was closed');
    assert.equal(orderRow(dbh, nopage).status, 'canceled', 'no payment page was ever made');
    assert.equal(orderRow(dbh, unknown).status, 'pending', 'Stripe could not be asked about it, so it was not canceled');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 28: money that arrives for a canceled order is written on it and the owner is told', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const id = addOrder(dbh, { status: 'canceled', sessions: ['cs_late'] });
    const ev = paidSession('cs_late', { metadata: { order_id: String(id) }, payment_intent: 'pi_late' });
    assert.equal((await webhook(s, 'checkout.session.completed', ev)).status, 200);
    await webhook(s, 'checkout.session.completed', ev);   // Stripe sending it again
    const o = orderRow(dbh, id);
    assert.equal(o.status, 'canceled'); assert.equal(o.late_payment, 'pi_late'); assert.equal(o.late_paid_cents, 1000);
    const found = await events(a, 'paid_after_cancel');
    assert.equal(found.length, 1, 'told once, not on every repeat'); assert.match(found[0].detail, /order #\d+ was canceled but \$10\.00 was paid/);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('items 33 and 35: a "paid" message must match the order (right page, not for less, right currency)', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const send = (id, cs) => webhook(s, 'checkout.session.completed', { ...paidSession(cs.id, cs), metadata: { order_id: String(id) } });
    const low = addOrder(dbh, { sessions: ['cs_low'], total: 2000 });
    await send(low, { id: 'cs_low', amount_total: 1 });
    assert.equal(orderRow(dbh, low).status, 'pending', 'paid message for 1 cent on a $20 order is refused');
    const other = addOrder(dbh, { sessions: ['cs_mine'], total: 2000 });
    await send(other, { id: 'cs_someone_elses', amount_total: 2000 });
    assert.equal(orderRow(dbh, other).status, 'pending', 'a payment page that is not this order\'s is refused');
    const cur = addOrder(dbh, { sessions: ['cs_eur'], total: 2000 });
    await send(cur, { id: 'cs_eur', amount_total: 2000, currency: 'eur' });
    assert.equal(orderRow(dbh, cur).status, 'pending');
    assert.equal((await events(a, 'payment_mismatch')).length, 3, 'each refusal is written in the security log');
    const good = addOrder(dbh, { sessions: ['cs_good'], total: 2000 });
    await send(good, { id: 'cs_good', amount_total: 2000 });
    assert.equal(orderRow(dbh, good).status, 'paid');
    const over = addOrder(dbh, { sessions: ['cs_tax'], total: 2000 });
    await send(over, { id: 'cs_tax', amount_total: 2180, automatic_tax: { enabled: true }, total_details: { amount_tax: 180 } });
    assert.equal(orderRow(dbh, over).status, 'paid'); assert.equal(orderRow(dbh, over).total_cents, 2180, 'Stripe Tax adding tax is fine');
    const free = addOrder(dbh, { sessions: ['cs_free'], total: 0 });
    await send(free, { id: 'cs_free', amount_total: 0, payment_status: 'no_payment_required' });
    assert.equal(orderRow(dbh, free).status, 'paid', 'a 100%-off checkout that needed no payment still completes');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 33: refunds and disputes made in Stripe show up in Outpost', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const id = addOrder(dbh, { status: 'paid', total: 2000, pi: 'pi_R' });
    await webhook(s, 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_R', amount_refunded: 500 });
    let o = orderRow(dbh, id); assert.equal(o.refunded_cents, 500); assert.equal(o.status, 'paid');
    await webhook(s, 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_R', amount_refunded: 500 });   // repeat: nothing changes
    assert.equal(orderRow(dbh, id).refunded_cents, 500);
    await webhook(s, 'charge.refunded', { id: 'ch_1', payment_intent: 'pi_R', amount_refunded: 2000 });
    o = orderRow(dbh, id); assert.equal(o.refunded_cents, 2000); assert.equal(o.status, 'refunded');
    assert.equal((await events(a, 'refund_outside')).length, 2);
    await webhook(s, 'charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_R' });
    assert.match((await events(a, 'dispute'))[0].detail, new RegExp(`order #${id}`));
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 63: putting items back in stock gives back only what was taken, and works for part refunds too', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    // one item left, two people paid for it: only one unit was ever taken out of stock
    const one = addProductDb(dbh, 1);
    const A = addOrder(dbh, { pid: one, sessions: ['cs_A'] }), B = addOrder(dbh, { pid: one, sessions: ['cs_B'] });
    for (const [id, cs] of [[A, 'cs_A'], [B, 'cs_B']]) await webhook(s, 'checkout.session.completed', { ...paidSession(cs), metadata: { order_id: String(id) } });
    assert.equal(stock(dbh, one), 0);
    for (const id of [A, B]) assert.equal((await a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 1000, restock: true, already_refunded: true })).status, 200);
    assert.equal(stock(dbh, one), 1, 'one item existed, so one comes back (it used to say 2)');
    // a part refund with the box ticked: the items go back when the order is fully refunded
    const many = addProductDb(dbh, 5);
    const C = addOrder(dbh, { pid: many, qty: 2, total: 1000, sessions: ['cs_C'] });
    await webhook(s, 'checkout.session.completed', { ...paidSession('cs_C'), metadata: { order_id: String(C) } });
    assert.equal(stock(dbh, many), 3);
    const part = (await a.post(`/api/admin/orders/${C}/refund`, { amount_cents: 400, restock: true, already_refunded: true })).data;
    assert.equal(part.restock_waiting, true); assert.equal(stock(dbh, many), 3);
    const rest = (await a.post(`/api/admin/orders/${C}/refund`, { amount_cents: 600, already_refunded: true })).data;
    assert.equal(rest.status, 'refunded'); assert.equal(rest.restocked, true); assert.equal(stock(dbh, many), 5);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('items 64 and 69: a refund is written down first and sent with a fixed key; a crash cannot make it twice', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe(); const env = envFor(fake);
  let s = await startServer(env), s2;
  try {
    const dbh = open(s); let a = await admin(s);
    const id = addOrder(dbh, { status: 'paid', total: 2000, pi: 'pi_C' });
    // the app stops right after Stripe made the refund, before it heard back
    fake.st.refundDelayMs = 1500; fake.st.onRefundCreated = () => s.proc.kill('SIGKILL');
    await a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 400 }).catch(() => {});
    await sleep(300); s.stop(true); fake.st.onRefundCreated = null; fake.st.refundDelayMs = 0;
    assert.equal(fake.st.refunds.length, 1);
    let o = orderRow(dbh, id); assert.equal(o.refunded_cents, 0, 'Outpost never learned it'); assert.equal(o.refund_intent_cents, 400, 'but it had written the refund down first');
    s2 = await startServer({ ...env, DATA_DIR: s.dir }); a = await admin(s2);
    const retry = await a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 400 });
    assert.equal(retry.status, 200, JSON.stringify(retry.data)); assert.equal(retry.data.already_done, true);
    o = orderRow(dbh, id); assert.equal(o.refunded_cents, 400); assert.equal(o.refund_intent_cents, 0);
    assert.equal(fake.st.refunds.length, 1, 'still one refund at Stripe');
    // the app stops before Stripe made anything: the retry makes it once, with the key that was fixed from the start
    const id2 = addOrder(dbh, { status: 'paid', total: 2000, pi: 'pi_D' });
    fake.st.hangRefund = true; fake.st.onRefundCreated = () => s2.proc.kill('SIGKILL');
    await a.post(`/api/admin/orders/${id2}/refund`, { amount_cents: 700 }).catch(() => {});
    await sleep(300); s2.stop(true); fake.st.hangRefund = false; fake.st.onRefundCreated = null;
    const s3 = await startServer({ ...env, DATA_DIR: s.dir }); const a3 = await admin(s3);
    try {
      assert.equal((await a3.post(`/api/admin/orders/${id2}/refund`, { amount_cents: 700 })).status, 200);
      assert.equal(fake.st.refunds.length, 2); assert.equal(orderRow(dbh, id2).refunded_cents, 700);
      assert.ok(fake.st.keys.has(`refund-${id2}-0-700`), 'the key is the same for the same refund');
    } finally { s3.stop(); }
    dbh.close();
  } finally { try { s2 && s2.stop(); } catch { /* */ } s.stop(); fake.close(); }
});

test('item 69: two refunds at once, an over-refund, and a missing amount', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    const id = addOrder(dbh, { status: 'paid', total: 2000, pi: 'pi_E' });
    fake.st.refundDelayMs = 1200;
    const [r1, r2] = await Promise.all([a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 2000 }), a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 2000 })]);
    assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
    assert.equal(fake.st.refunds.length, 1); assert.equal(orderRow(dbh, id).status, 'refunded');
    const id2 = addOrder(dbh, { status: 'paid', total: 2000, pi: 'pi_F' });
    assert.equal((await a.post(`/api/admin/orders/${id2}/refund`, { amount_cents: 2001 })).status, 400, 'more than the order');
    assert.equal((await a.post(`/api/admin/orders/${id2}/refund`, {})).status, 400, 'no amount no longer means "everything"');
    assert.equal(fake.st.refunds.length, 1);
    // a database claim left over from a crash that Stripe never saw does not block a later refund
    dbh.prepare("UPDATE orders SET refund_intent_cents=500, refund_key='x' WHERE id=?").run(id2);
    assert.equal((await a.post(`/api/admin/orders/${id2}/refund`, { amount_cents: 500 })).status, 200);
    assert.equal(orderRow(dbh, id2).refunded_cents, 500); assert.equal(fake.st.refunds.length, 2);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 68: a refund that began before "sign out everywhere" does not go on to move money', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const a = await admin(s);
    fake.st.sessions.set('cs_p', paidSession('cs_p', { payment_intent: 'pi_P' }));
    const id = addOrder(dbh, { status: 'paid', total: 2000, sessions: ['cs_p'] });   // payment id not stored yet: Outpost has to look it up at Stripe first
    fake.st.sessionDelayMs = 1500;
    const pending = a.post(`/api/admin/orders/${id}/refund`, { amount_cents: 2000 });
    await sleep(400);
    assert.equal((await s.j('POST', '/api/admin/logout-all', { password: PASSWORD }, a.t)).status, 200);
    const r = await pending;
    assert.equal(r.status, 401, JSON.stringify(r.data));
    assert.equal(fake.st.refunds.length, 0, 'no money moved');
    const o = orderRow(dbh, id); assert.equal(o.status, 'paid'); assert.equal(o.refund_intent_cents, 0, 'nothing left half-done');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

function addBidder(dbh, over = {}) {
  const addr = JSON.stringify({ email: 'z@example.com', name: 'Zed', country: 'US', line1: '1 Main', line2: '', city: 'Portland', state: 'OR', zip: '97201' });
  const token = 'bt' + Math.random().toString(36).slice(2, 12);
  const id = Number(dbh.prepare('INSERT INTO bidders (name, email, token, created_at, address_json, stripe_customer_id, stripe_payment_method, card_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(over.name || 'Zed', over.email || ('z' + Math.random().toString(36).slice(2, 8) + '@example.com'), token, Date.now(), addr, over.cust || null, over.pm || null, over.card_at || null).lastInsertRowid);
  return { id, token };
}

test('item 66: tapping "Add card" twice makes one Stripe customer, not two', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s); const b = addBidder(dbh);
    const go = () => s.j('POST', '/api/bidders/card', {}, { 'x-bidder-token': b.token });
    const [x, y] = await Promise.all([go(), go()]);
    assert.equal(x.status, 200, JSON.stringify(x.data)); assert.equal(y.status, 200, JSON.stringify(y.data));
    assert.equal(fake.st.customers.length, 1);
    assert.equal(dbh.prepare('SELECT stripe_customer_id c FROM bidders WHERE id=?').get(b.id).c, fake.st.customers[0].id);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 67: an older card page finishing late does not replace a newer card', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s);
    const b = addBidder(dbh, { cust: 'cus_b', pm: 'pm_new', card_at: Date.now() });
    const setup = (id, created, pm) => fake.st.sessions.set(id, { id, object: 'checkout.session', mode: 'setup', status: 'complete', customer: 'cus_b', created, metadata: { bidder_id: String(b.id) }, setup_intent: { status: 'succeeded', payment_method: { id: pm, card: { brand: 'visa', last4: '4242' } } } });
    setup('cs_old', Math.floor(Date.now() / 1000) - 3600, 'pm_old');
    const old = await fetch(s.base + '/card-saved?session_id=cs_old', { redirect: 'manual' });
    assert.match(old.headers.get('location'), /card=fail/);
    assert.equal(dbh.prepare('SELECT stripe_payment_method p FROM bidders WHERE id=?').get(b.id).p, 'pm_new');
    setup('cs_next', Math.floor(Date.now() / 1000) + 5, 'pm_next');
    const next = await fetch(s.base + '/card-saved?session_id=cs_next', { redirect: 'manual' });
    assert.match(next.headers.get('location'), /card=ok/);
    assert.equal(dbh.prepare('SELECT stripe_payment_method p FROM bidders WHERE id=?').get(b.id).p, 'pm_next');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 29: an order\'s status needs its private receipt key', async () => {
  const s = await startServer();
  try {
    const dbh = open(s); const id = addOrder(dbh, { status: 'paid' }); const tok = orderRow(dbh, id).public_token; dbh.close();
    assert.equal((await s.j('GET', `/api/order-status/${id}`)).status, 404, 'counting through order numbers no longer works');
    assert.equal((await s.j('GET', `/api/order-status/${id}`, undefined, { 'x-receipt-key': 'wrong' })).status, 404);
    const ok = await s.j('GET', `/api/order-status/${id}`, undefined, { 'x-receipt-key': tok });
    assert.equal(ok.status, 200); assert.equal(ok.data.status, 'paid');
    assert.equal((await s.j('GET', `/api/order-status/${id}?k=${tok}`)).status, 200, 'older links still work');
    assert.equal((await s.j('GET', `/api/receipt/${id}`, undefined, { 'x-receipt-key': tok })).status, 200, 'the receipt takes the key in a header too');
  } finally { s.stop(); }
});

test('item 30: spreadsheet formulas in the orders export are defused, and such emails are refused', async () => {
  assert.equal(Safe.validEmail("=cmd|'/c calc'!A0@x.co"), false);
  assert.equal(Safe.validEmail('+1@x.co'), false); assert.equal(Safe.validEmail('|x@x.co'), false);
  assert.equal(Safe.validEmail('a+b@x.co'), true); assert.equal(Safe.validEmail('a=b@x.co'), true);
  const s = await startServer();
  try {
    const dbh = open(s); const a = await admin(s);
    addOrder(dbh, { status: 'paid', email: "=cmd|'/c calc'!A0@x.co" }); dbh.close();
    const csv = (await s.j('GET', '/api/admin/orders.csv', undefined, a.t)).data;
    assert.ok(csv.includes("'=cmd"), 'the cell starts with a quote mark so it stays text'); assert.ok(!/,=cmd/.test(csv));
  } finally { s.stop(); }
});

test('item 31: a bid above what Stripe can charge is refused, and late bids can only extend a lot so many times', { timeout: 90000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s); const A = addBidder(dbh), B = addBidder(dbh);
    const aid = Number(dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at, pay_token) VALUES ('Lot',100,100,0,?,'open',0,'p1')").run(Date.now() + 60e3).lastInsertRowid);
    const bid = (t, cents) => s.j('POST', `/api/auctions/${aid}/bids`, { amount_cents: cents }, { 'x-bidder-token': t });
    assert.equal((await bid(A.token, 100000000)).status, 400, 'over $999,999.99');
    let end;
    for (let i = 1; i <= 34; i++) {
      const r = await bid(i % 2 ? A.token : B.token, i * 100); assert.equal(r.status, 200, `bid ${i}: ${JSON.stringify(r.data)}`);
      if (i === 30) end = dbh.prepare('SELECT end_at e FROM auctions WHERE id=?').get(aid).e;
    }
    const a = dbh.prepare('SELECT end_at e, extensions x FROM auctions WHERE id=?').get(aid);
    assert.equal(a.x, 30); assert.equal(a.e, end, 'after 30 extensions the end time stops moving');
    dbh.close();
  } finally { s.stop(); }
});

test('item 32: forms need a start time that the server signed', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s); dbh.prepare("INSERT INTO settings (key, value) VALUES ('mailing_list_on','1')").run(); dbh.close();
    const post = (started) => s.j('POST', '/api/bidders', { name: 'x', email: 'nope', started });
    assert.equal((await post(Date.now() - 5000)).status, 429, 'a number the browser made up');
    assert.equal((await post('1700000000000.deadbeef')).status, 429, 'a forged token');
    const fresh = (await s.j('GET', '/api/form-token')).data.token;
    assert.equal((await post(fresh)).status, 429, 'sent at once: too fast');
    assert.equal((await post(await s.formToken())).status, 400, 'a real one passes the check (the email is what it fails on)');
    const sub = (started) => s.j('POST', '/api/subscribe', { email: 'ok@example.com', consent: true, started });
    assert.equal((await sub(undefined)).status, 429, 'the sign-up form needs it too');
    assert.equal((await sub(await s.formToken())).status, 200);
  } finally { s.stop(); }
});

test('item 35: a checkout that comes to $0 finishes without Stripe', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s); const dbh = open(s);
    const pid = addProductDb(dbh, 3, 1000);
    assert.equal((await a.post('/api/admin/discounts', { code: 'FREE100', kind: 'percent', value: 100 })).status, 200);
    const r = await s.j('POST', '/api/checkout', { items: [{ id: pid, qty: 1 }], address: ADDR, code: 'FREE100', started: await s.formToken(), website: '' });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.match(r.data.url, /\/thanks\.html\?order=\d+#k=[0-9a-f]+$/);
    const o = dbh.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 1').get();
    assert.equal(o.status, 'paid'); assert.equal(o.total_cents, 0); assert.equal(stock(dbh, pid), 2);
    dbh.close();
  } finally { s.stop(); }
});

test('item 36: our own receipt links keep the key after the # (never sent to the server)', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s);
    const aid = Number(dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at, pay_token) VALUES ('Lot',100,100,0,1,'closed',0,'paytok1')").run().lastInsertRowid);
    const oid = addOrder(dbh, { status: 'paid' }); dbh.prepare("UPDATE orders SET channel='auction', auction_id=? WHERE id=?").run(aid, oid); dbh.prepare('UPDATE auctions SET order_id=? WHERE id=?').run(oid, aid);
    const r = await fetch(s.base + '/pay/paytok1', { redirect: 'manual' });
    const loc = r.headers.get('location');
    assert.match(loc, new RegExp(`^/thanks\\.html\\?order=${oid}#k=`)); assert.ok(!loc.includes('?k=') && !loc.includes('&k='));
    for (const f of ['thanks.html', 'receipt.html']) assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8').includes('x-receipt-key'), f + ' sends the key in a header');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 69: someone you blocked is not charged automatically', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const dbh = open(s);
    const b = addBidder(dbh, { email: 'blocked@example.com', cust: 'cus_w', pm: 'pm_1' });
    dbh.prepare("INSERT INTO blocks (kind, value, note, created_at) VALUES ('email','blocked@example.com','',0)").run();
    const aid = Number(dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, status, created_at, pay_token) VALUES ('Lot',100,100,0,?,'closed',0,'pt2')").run(Date.now() - 5000).lastInsertRowid);
    const bidId = Number(dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,5000,0)').run(aid, b.id).lastInsertRowid);
    const oid = addOrder(dbh, { total: 5000 });
    dbh.prepare("UPDATE orders SET channel='auction', auction_id=?, shipping_json=? WHERE id=?").run(aid, JSON.stringify({ name: 'Z', address: { line1: '1 Main', city: 'Portland', state: 'OR', postal_code: '97201', country: 'US' } }), oid);
    dbh.prepare('UPDATE auctions SET winner_bid_id=?, order_id=? WHERE id=?').run(bidId, oid, aid);
    await sleep(8000);
    assert.equal(fake.st.intents.length, 0, 'not charged'); assert.equal(orderRow(dbh, oid).status, 'pending');
    dbh.close();
  } finally { s.stop(); fake.close(); }
});
