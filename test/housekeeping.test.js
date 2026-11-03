'use strict';
// Run with: npm test. Checks the tidy-up of junk rows (review item 8) and that real records are never touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-hk-'));
process.env.DATA_DIR = dir;
const db = require('../db');
const { pruneAbandoned } = require('../housekeeping');
test.after(() => { try { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const addOrder = (channel, status, ageDays) => db.prepare(
  `INSERT INTO orders (channel, payment_method, status, total_cents, created_at) VALUES (?, 'card', ?, 1000, datetime('now', ?))`
).run(channel, status, `-${ageDays} days`).lastInsertRowid;
const addBidder = (ageDays, extra = {}) => db.prepare(
  'INSERT INTO bidders (name, email, token, created_at, stripe_customer_id) VALUES (?,?,?,?,?)'
).run('B', 'b@example.com', 't' + Math.random(), Date.now() - ageDays * 24 * 3600e3, extra.customer || null).lastInsertRowid;

test('removes only long-dead unpaid online checkouts', () => {
  const oldPending = addOrder('online', 'pending', 100), oldCanceled = addOrder('online', 'canceled', 100);
  const recentPending = addOrder('online', 'pending', 5), oldPaid = addOrder('online', 'paid', 100);
  const oldRefunded = addOrder('online', 'refunded', 100), oldAuction = addOrder('auction', 'pending', 100);
  const oldRegister = addOrder('register', 'canceled', 100);
  const withReview = addOrder('online', 'canceled', 100);
  db.prepare("INSERT INTO reviews (order_id, rating, name, created_at) VALUES (?,5,'x',?)").run(withReview, Date.now());
  const r = pruneAbandoned(db);
  assert.equal(r.orders, 2);
  const has = (id) => !!db.prepare('SELECT 1 FROM orders WHERE id=?').get(id);
  assert.equal(has(oldPending), false); assert.equal(has(oldCanceled), false);
  for (const id of [recentPending, oldPaid, oldRefunded, oldAuction, oldRegister, withReview]) assert.equal(has(id), true, `order ${id} must stay`);
});

test('removes only unused old sign-ups', () => {
  const unusedOld = addBidder(120), unusedRecent = addBidder(10), withCard = addBidder(120, { customer: 'cus_1' });
  const withBid = addBidder(120), withWatch = addBidder(120);
  const aid = db.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, created_at) VALUES ('t',100,100,0,1,0)").run().lastInsertRowid;
  db.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,100,0)').run(aid, withBid);
  db.prepare('INSERT INTO watches (bidder_id, auction_id) VALUES (?,?)').run(withWatch, aid);
  const r = pruneAbandoned(db);
  assert.equal(r.bidders, 1);
  const has = (id) => !!db.prepare('SELECT 1 FROM bidders WHERE id=?').get(id);
  assert.equal(has(unusedOld), false);
  for (const id of [unusedRecent, withCard, withBid, withWatch]) assert.equal(has(id), true, `bidder ${id} must stay`);
});

test('running it again changes nothing', () => {
  assert.deepEqual(pruneAbandoned(db), { orders: 0, bidders: 0 });
});
