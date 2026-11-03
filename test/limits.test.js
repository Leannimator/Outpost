'use strict';
// Run with: npm test. Checks review items 5 to 10 against a real running copy of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, sleep } = require('./helpers');

const started = (s) => s.formToken();   // a signed start time that passes the "too fast" form check
const statuses = async (srv, method, url, n, body) => { const out = []; for (let i = 0; i < n; i++) out.push((await srv.j(method, url, body)).status); return out; };

test('item 5: /card-saved is rate limited (it used to call Stripe on every visit)', async () => {
  const s = await startServer();
  try {
    const codes = await statuses(s, 'GET', '/card-saved?session_id=cs_test_x', 25);
    assert.equal(codes.slice(0, 20).every((c) => c === 303), true, codes.join());
    assert.equal(codes[20], 429, codes.join());
  } finally { s.stop(); }
});

test('item 5: /pay/:token is rate limited per link and per visitor', async () => {
  const s = await startServer();
  try {
    const same = await statuses(s, 'GET', '/pay/doesnotexist', 22);
    assert.equal(same[19], 404); assert.equal(same[20], 429, 'the 21st visit to one link should be refused');
  } finally { s.stop(); }
  const s2 = await startServer();
  try {
    let refusedAt = -1;
    for (let i = 0; i < 40 && refusedAt < 0; i++) if ((await s2.j('GET', '/pay/tok' + i)).status === 429) refusedAt = i;
    assert.ok(refusedAt >= 25 && refusedAt <= 31, `a visitor trying many links was refused at try ${refusedAt}`);
  } finally { s2.stop(); }
});

test('item 5: /images is rate limited even when the AI shield is switched off', async () => {
  const s = await startServer({ IMAGE_LIMIT_PER_MIN: '20' });
  try {
    const dbh = new Database(path.join(s.dir, 'outpost.db'));
    dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('block_ai','0')").run(); dbh.close();
    const codes = await statuses(s, 'GET', '/images/none.png', 25);
    assert.ok(codes.includes(429), codes.join());
    assert.equal(codes[0], 404);
  } finally { s.stop(); }
});

test('items 6 and 7: one IPv6 visitor cannot look like many (grouped by /64)', async () => {
  const s = await startServer({ TRUST_PROXY: '1' });
  try {
    let refusedAt = -1;
    for (let i = 0; i < 45 && refusedAt < 0; i++) {
      const r = await s.j('POST', '/api/bidders', { name: 'x', email: 'nope', started: await started(s) }, { 'x-forwarded-for': `2001:db8:1:1::${i + 1}` });
      if (r.status === 429) refusedAt = i;
    }
    assert.ok(refusedAt > 20 && refusedAt <= 32, `refused at try ${refusedAt}`);
    const other = await s.j('POST', '/api/bidders', { name: 'x', email: 'nope', started: await started(s) }, { 'x-forwarded-for': '2001:db8:2:2::1' });
    assert.equal(other.status, 400, 'a different /64 block is a different visitor');
  } finally { s.stop(); }
});

test('item 8: the email list and bidder list have hard size caps', async () => {
  const s = await startServer();
  try {
    const dbh = new Database(path.join(s.dir, 'outpost.db'));
    dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('mailing_list_on','1')").run();
    dbh.transaction(() => {
      const sub = dbh.prepare('INSERT INTO subscribers (email, source, created_at) VALUES (?,?,?)');
      for (let i = 0; i < 25000; i++) sub.run(`u${i}@example.com`, 'links', 1);
      const bid = dbh.prepare('INSERT INTO bidders (name, email, token, created_at) VALUES (?,?,?,?)');
      for (let i = 0; i < 20000; i++) bid.run('n', `b${i}@example.com`, 'tok' + i, Date.now());
    })();
    dbh.close();
    const sub = await s.j('POST', '/api/subscribe', { email: 'new@example.com', consent: true, started: await s.formToken() });
    assert.equal(sub.status, 503);
    const bidder = await s.j('POST', '/api/bidders', { name: 'New Person', email: 'new@example.com', started: await started(s) });
    assert.equal(bidder.status, 503);
  } finally { s.stop(); }
});

test('item 9: a lot that cannot be closed no longer crashes the app', { timeout: 40000 }, async () => {
  const s = await startServer();
  try {
    const dbh = new Database(path.join(s.dir, 'outpost.db'));
    const bidder = dbh.prepare("INSERT INTO bidders (name, email, token, created_at) VALUES ('B','b@example.com','tk',?)").run(Date.now()).lastInsertRowid;
    const aid = dbh.prepare("INSERT INTO auctions (title, starting_bid_cents, increment_cents, start_at, end_at, created_at) VALUES ('Boom',100,100,0,?,0)").run(Date.now() - 1000).lastInsertRowid;
    dbh.prepare('INSERT INTO bids (auction_id, bidder_id, amount_cents, created_at) VALUES (?,?,100,0)').run(aid, bidder);
    dbh.exec("CREATE TRIGGER boom BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'simulated disk problem'); END;");
    dbh.close();
    await sleep(12000);   // the 5-second timer runs at least twice
    assert.equal(s.alive(), true, 'the app must still be running');
    assert.equal((await s.j('GET', '/api/settings')).status, 200);
  } finally { s.stop(); }
});

test('item 10: a captcha check that never answers gives up instead of hanging', { timeout: 30000 }, async () => {
  const hang = net.createServer(() => { /* accept the connection and never reply */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  const s = await startServer({ TURNSTILE_SECRET_KEY: 'test-secret', TURNSTILE_VERIFY_URL: `http://127.0.0.1:${hang.address().port}/verify` });
  try {
    const t = Date.now();
    const r = await s.j('POST', '/api/bidders', { name: 'x', email: 'a@example.com', started: await started(s), captcha: 'token' });
    assert.equal(r.status, 400);
    assert.ok(Date.now() - t < 9000, `took ${Date.now() - t}ms`);
  } finally { s.stop(); hang.close(); }
});
