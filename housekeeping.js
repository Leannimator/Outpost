'use strict';
// Tidy-up so strangers can't slowly fill your disk with junk rows (review item 8).
//  - Unpaid online checkouts older than 60 days are removed. Stripe payment pages expire after 35 minutes, so these are long dead.
//  - Sign-ups older than 90 days that never bid, never watched a lot and never saved a card are removed.
// Paid, refunded and auction orders, reviews and anyone with a bid, a watch or a saved card are never touched.
const ORDER_DAYS = 60, SIGNUP_DAYS = 90;

function pruneAbandoned(db, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  const orders = db.prepare(
    `DELETE FROM orders WHERE channel='online' AND status IN ('pending','canceled')
       AND created_at < datetime(?, 'unixepoch', '-${ORDER_DAYS} days')
       AND id NOT IN (SELECT order_id FROM reviews)`).run(nowSec).changes;
  const bidders = db.prepare(
    `DELETE FROM bidders WHERE created_at < ? AND stripe_customer_id IS NULL AND stripe_payment_method IS NULL
       AND id NOT IN (SELECT bidder_id FROM bids) AND id NOT IN (SELECT bidder_id FROM watches)`).run(nowMs - SIGNUP_DAYS * 24 * 3600e3).changes;
  return { orders, bidders };
}

// Security log entries (they hold visitors' addresses) are kept for 90 days.
const LOG_DAYS = 90;
function pruneSecurityLog(db, nowMs = Date.now()) {
  return db.prepare('DELETE FROM security_events WHERE at < ?').run(nowMs - LOG_DAYS * 24 * 3600e3).changes;
}

module.exports = { pruneAbandoned, pruneSecurityLog, ORDER_DAYS, SIGNUP_DAYS, LOG_DAYS };
