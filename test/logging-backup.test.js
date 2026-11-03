'use strict';
// Run with: npm test. Checks review items 37, 41 to 47, 52 and 53 (security log, backup, error text, page rules, uploads, settings, test-only switches) against a real running copy of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const Database = require('better-sqlite3');
const Safe = require('../safe');
const AiShield = require('../ai-shield');
const Housekeeping = require('../housekeeping');
const { startServer, PASSWORD, sleep } = require('./helpers');
const { startFakeStripe } = require('./fakestripe');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t) }; }
const count = (dbh, where) => dbh.prepare(`SELECT COUNT(*) c FROM security_events WHERE ${where}`).get().c;
const envFor = (fake, more = {}) => ({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_API_HOST: '127.0.0.1', STRIPE_API_PORT: String(fake.port), STRIPE_API_PROTOCOL: 'http', ...more });

test('item 37: a flood of one kind of log entry cannot push out sign-in or money entries', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s);
    const ins = dbh.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)');
    ins.run(1, 'admin_login_failed', '1.1.1.1', 'old sign-in failure'); ins.run(2, 'oversold', '', 'old money event');
    dbh.transaction(() => { for (let i = 0; i < 1300; i++) ins.run(Date.now(), 'honeypot', '9.9.9.' + (i % 250), 'junk'); })();
    for (let i = 0; i < 30; i++) await s.j('POST', '/api/admin/login', { password: PASSWORD });   // 30 more sign-in entries: the log tidies itself every 25 entries
    assert.equal(count(dbh, "kind='honeypot'"), 1000, 'the noisy pile is capped');
    assert.equal(count(dbh, "kind='admin_login_failed' AND detail='old sign-in failure'"), 1, 'an old sign-in entry survives');
    assert.equal(count(dbh, "kind='oversold'"), 1, 'an old money entry survives');
    dbh.close();
  } finally { s.stop(); }
});

test('item 37: one visitor repeating the same trick is logged once, and a flood from many addresses is capped per minute', { timeout: 90000 }, async () => {
  const s = await startServer({ TRUST_PROXY: '1' });
  try {
    const a = await admin(s); await s.j('POST', '/api/admin/login', { password: 'wrong' });
    const dbh = open(s);
    await Promise.all(Array.from({ length: 300 }, (_, i) => s.j('POST', '/api/bidders', { website: 'x' }, { 'x-forwarded-for': `198.51.100.${(i % 200) + 1}` })));
    assert.ok(count(dbh, "kind='honeypot'") <= 61, 'honeypot rows: ' + count(dbh, "kind='honeypot'"));
    assert.ok(count(dbh, "kind='admin_login_failed'") >= 1, 'the sign-in failure is still there');
    assert.ok((await a.get('/api/admin/security')).data.recent.length > 0);
    dbh.close();
  } finally { s.stop(); }
});

test('item 52: emails in the security log are masked, and old entries are removed after 90 days', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const dbh = open(s);
    dbh.prepare("INSERT INTO blocks (kind, value, note, created_at) VALUES ('email','troll@example.com','',0)").run();
    const r = await s.j('POST', '/api/bidders', { name: 'x', email: 'troll@example.com', started: await s.formToken() });
    assert.equal(r.status, 403);
    const ev = dbh.prepare("SELECT detail FROM security_events WHERE kind='blocked_email'").get();
    assert.equal(ev.detail, 't***@example.com');
    dbh.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)').run(Date.now() - 100 * 24 * 3600e3, 'honeypot', '', 'ancient');
    dbh.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)').run(Date.now() - 10 * 24 * 3600e3, 'honeypot', '', 'recent');
    assert.equal(Housekeeping.pruneSecurityLog(dbh), 1);
    assert.equal(count(dbh, "detail='recent'"), 1);
    dbh.close();
  } finally { s.stop(); }
});

function untar(buf) {
  const files = {}; let off = 0;
  while (off + 512 <= buf.length && buf[off] !== 0) {
    const name = buf.toString('utf8', off, off + 100).replace(/\0.*$/, '');
    const size = parseInt(buf.toString('ascii', off + 124, off + 135), 8);
    files[name] = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

test('item 41: the backup leaves out the two-step secret, sessions and the security log, streams, and cleans up after itself', { timeout: 90000 }, async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-tmproot-'));
  const s = await startServer({ TMPDIR: tmpRoot });
  try {
    const a = await admin(s); const dbh = open(s);
    for (const [k, v] of [['totp_secret', 'SECRETSECRET'], ['totp_recovery', '["hash1"]'], ['store_name', 'My Shop']]) dbh.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)').run(k, v);
    dbh.prepare("INSERT INTO security_events (at, kind, ip, detail) VALUES (1,'honeypot','8.8.8.8','x')").run();
    const big = Buffer.alloc(3 * 1024 * 1024 + 123, 7);
    fs.mkdirSync(path.join(s.dir, 'images'), { recursive: true }); fs.writeFileSync(path.join(s.dir, 'images', 'big.png'), big);
    const res = await fetch(s.base + '/api/admin/backup', { headers: a.t });
    assert.equal(res.status, 200); assert.match(res.headers.get('content-disposition'), /outpost-backup-.*\.tar\.gz/); assert.equal(res.headers.get('cache-control'), 'no-store');
    const files = untar(zlib.gunzipSync(Buffer.from(await res.arrayBuffer())));
    assert.ok(files['outpost.db'] && files['images/big.png']);
    assert.ok(files['images/big.png'].equals(big), 'photos come through byte for byte');
    const copyPath = path.join(tmpRoot, 'copy.db'); fs.writeFileSync(copyPath, files['outpost.db']);
    const copy = new Database(copyPath, { readonly: true });
    assert.equal(copy.prepare("SELECT COUNT(*) c FROM settings WHERE key IN ('totp_secret','totp_recovery')").get().c, 0, 'no two-step secret or recovery codes');
    assert.equal(copy.prepare("SELECT value FROM settings WHERE key='store_name'").get().value, 'My Shop', 'the rest of the settings are there');
    for (const t of ['admin_sessions', 'trusted_devices', 'login_attempts', 'security_events']) assert.equal(copy.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c, 0, t + ' is empty in the copy');
    assert.ok(!Buffer.from(files['outpost.db']).includes('SECRETSECRET'), 'the secret is not even left behind in unused pages of the file');
    copy.close();
    assert.equal(dbh.prepare("SELECT value FROM settings WHERE key='totp_secret'").get().value, 'SECRETSECRET', 'the live database is untouched');
    assert.deepEqual(fs.readdirSync(tmpRoot).filter((f) => f.startsWith('outpost-bk-')), [], 'the temporary folder is removed');
    dbh.close();
  } finally { s.stop(); fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('item 42: a payment problem shows a visitor a plain message, and the owner Stripe\'s wording', { timeout: 60000 }, async () => {
  const fake = await startFakeStripe();
  const s = await startServer(envFor(fake));
  try {
    const a = await admin(s); const dbh = open(s);
    const pid = Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Thing',1000,5,1)").run().lastInsertRowid);
    fake.st.failSessions = true;
    const co = await s.j('POST', '/api/checkout', { items: [{ id: pid, qty: 1 }], address: { email: 'b@example.com', name: 'Pat', country: 'US', line1: '5 Elm', line2: '', city: 'Portland', state: 'OR', zip: '97201' }, started: await s.formToken(), website: '' });
    assert.equal(co.status, 502); assert.ok(!/sk_live|acct_|API Key/.test(JSON.stringify(co.data)), JSON.stringify(co.data));
    const oid = Number(dbh.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, subtotal_cents, public_token, stripe_payment_intent) VALUES ('online','card','paid',1000,1000,'tk','pi_x')").run().lastInsertRowid);
    fake.st.failRefund = true;
    const rf = await a.post(`/api/admin/orders/${oid}/refund`, { amount_cents: 1000 });
    assert.equal(rf.status, 400); assert.match(rf.data.error, /No such payment_intent/);
    dbh.close();
  } finally { s.stop(); fake.close(); }
});

test('item 43: the owner\'s app refuses inline scripts, and API answers carry a locked-down policy', async () => {
  const s = await startServer();
  try {
    const owner = (await fetch(s.base + '/')).headers.get('content-security-policy');
    assert.match(owner, /script-src 'self'(;|$)/); assert.ok(!/unsafe-inline[^;]*;\s*style/.test(owner.split('script-src')[1].split(';')[0]), 'no unsafe-inline for scripts');
    assert.match(owner, /frame-ancestors 'none'/);
    const shop = (await fetch(s.base + '/store.html')).headers.get('content-security-policy');
    assert.match(shop, /script-src 'self' 'unsafe-inline'/, 'shop pages still run their own inline scripts');
    assert.equal((await fetch(s.base + '/api/settings')).headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");
    for (const f of ['index.html', 'admin.html']) assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8')), f + ' has no inline script');
  } finally { s.stop(); }
});

test('item 44: SVGs with scripts are refused at upload; AI-crawler matching uses whole names; answers vary by User-Agent', async () => {
  assert.equal(Safe.svgProblem('<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>'), null);
  for (const bad of ['<svg><script>alert(1)</script></svg>', '<svg onload="x()"></svg>', '<svg><a href="javascript:x()"/></svg>', '<svg><foreignObject/></svg>', '<!DOCTYPE svg [<!ENTITY a "b">]><svg/>']) assert.ok(Safe.svgProblem(bad), bad);
  assert.ok(Safe.svgProblem('<svg>' + ' '.repeat(2e6) + '</svg>') === null, 'a big harmless file is checked quickly');
  assert.equal(AiShield.isAiAgent('Mozilla/5.0 (compatible; GPTBot/1.1; +https://openai.com/gptbot)'), true);
  assert.equal(AiShield.isAiAgent('GPTBot-x42'), true); assert.equal(AiShield.isAiAgent('Mozilla/5.0 YouBot/1.0'), true);
  assert.equal(AiShield.isAiAgent('Mozilla/5.0 (X11; Linux) mybrowser-xyoubotz/2.0'), false, 'letters that only happen to contain a crawler name do not count');
  assert.equal(AiShield.isAiAgent('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15'), false);
  const s = await startServer();
  try {
    const a = await admin(s);
    const up = (body) => fetch(s.base + '/api/admin/upload', { method: 'POST', headers: { ...a.t, 'content-type': 'image/svg+xml' }, body });
    assert.equal((await up('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle r="5"/></svg>')).status, 200);
    assert.equal((await up('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')).status, 400);
    assert.match((await fetch(s.base + '/api/settings')).headers.get('vary') || '', /User-Agent/i);
  } finally { s.stop(); }
});

test('item 45: stored settings are checked when saved (image addresses, email, links)', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const prod = (url) => a.post('/api/admin/products', { name: 'T', price_cents: 100, stock: 1, image_url: url });
    assert.equal((await prod('https://x.example/a.png"onerror="alert(1)')).status, 400, 'a quote mark in an image address');
    assert.equal((await prod('https://x.example/a.png')).status, 200);
    assert.equal((await a.put('/api/admin/settings', { social: { email: 'javascript:alert(1)//@b.co' } })).status, 400);
    assert.equal((await a.put('/api/admin/settings', { social: { email: 'me@shop.example' } })).status, 200);
    assert.equal((await a.put('/api/admin/settings', { policy: { contact_email: 'not an email' } })).status, 400);
    const r = await a.put('/api/admin/settings', { links: [{ kind: 'link', title: 'Mine', url: 'example.com/a b' }] });
    assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.links_all[0].url, 'https://example.com/a%20b', 'stored in cleaned-up form');
  } finally { s.stop(); }
});

test('item 47: testing-only switches are ignored when the shop is on the internet', { timeout: 90000 }, async () => {
  const fake = await startFakeStripe();
  let hits = 0;
  const cap = http.createServer((req, res) => { hits++; res.end('{"success":true}'); }); await new Promise((r) => cap.listen(0, '127.0.0.1', r));
  const s = await startServer(envFor(fake, { RENDER: '1', TURNSTILE_SECRET_KEY: 'sec', TURNSTILE_VERIFY_URL: `http://127.0.0.1:${cap.address().port}/verify` }));
  try {
    const dbh = open(s);
    const pid = Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Thing',1000,5,1)").run().lastInsertRowid);
    await s.j('POST', '/api/checkout', { items: [{ id: pid, qty: 1 }], address: { email: 'b@example.com', name: 'Pat', country: 'US', line1: '5 Elm', line2: '', city: 'Portland', state: 'OR', zip: '97201' }, started: await s.formToken(), website: '', captcha: 'tok' });
    assert.equal(fake.st.calls.length, 0, 'Stripe was not asked at the fake address (the key would have gone there)');
    assert.equal(hits, 0, 'the captcha secret was not sent to the override address');
    dbh.close();
  } finally { s.stop(); fake.close(); cap.close(); }
});

test('item 53: discount numbers must be numbers, not text', async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    assert.equal((await a.post('/api/admin/discounts', { code: 'TEN', kind: 'percent', value: '10' })).status, 400, '"10" as text');
    assert.equal((await a.post('/api/admin/discounts', { code: 'TEN', kind: 'percent', value: 10, max_uses: '5' })).status, 400);
    assert.equal((await a.post('/api/admin/discounts', { code: 'TEN', kind: 'percent', value: 10, min_subtotal_cents: '500' })).status, 400);
    assert.equal((await a.post('/api/admin/discounts', { code: 'TEN', kind: 'percent', value: 10, max_uses: 5, min_subtotal_cents: 500 })).status, 200);
    assert.equal((await a.post('/api/admin/discounts', { code: 'TWO', kind: 'percent', value: 10, max_uses: null })).status, 200);
  } finally { s.stop(); }
});
