'use strict';
// Run with: npm test. Email (Marketing step 4) against a fake Resend server: nothing real is ever sent.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, sleep, PASSWORD } = require('./helpers');
const mailer = require('../mailer');

function fakeResend() {
  const state = { sent: [], status: 200 };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      if (state.status === 200) { const body = JSON.parse(b); state.sent.push({ ...body, key: req.headers['idempotency-key'], auth: req.headers.authorization }); }
      res.writeHead(state.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.status === 200 ? { id: 'em_' + state.sent.length } : { message: 'fake failure ' + state.status }));
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ state, url: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() })));
}
const WHSEC = 'whsec_' + Buffer.from('test-webhook-secret-bytes').toString('base64');
async function setup(extra = {}) {
  const fake = await fakeResend();
  const s = await startServer({ RESEND_API_KEY: 're_test', RESEND_API_URL: fake.url, RESEND_WEBHOOK_SECRET: WHSEC, OUTPOST_EMAIL_TICK_MS: '100', OUTPOST_EMAIL_PACE_MS: '0', ...extra });
  const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD });
  const t = { 'x-admin-token': data.token };
  const a = { post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t), del: (u) => s.j('DELETE', u, undefined, t) };
  const db = new Database(path.join(s.dir, 'outpost.db'));
  const stop = () => { db.close(); s.stop(); fake.close(); };
  return { s, a, db, fake, stop };
}
const addSub = (db, email, o = {}) => db.prepare('INSERT INTO subscribers (email, source, created_at, unsubscribed, consent_at, confirmed_at, bounced) VALUES (?,?,?,?,?,?,?)').run(email, 'test', Date.now(), o.unsub ? 1 : 0, o.noConsent ? null : Date.now(), o.unconfirmed ? null : Date.now(), o.bounced ? 1 : 0);
const turnOn = (a, extra = {}) => a.put('/api/admin/email/settings', { from: 'Ash & Anchor <hello@example.com>', mail_address: 'Ash & Anchor, 1 Main St, Portland OR 97201', on: true, ...extra });
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(60); } return false; }
const send = async (a, subject, body) => { const c = (await a.post('/api/admin/email/campaigns', { subject, body })).data; const r = await a.post(`/api/admin/email/campaigns/${c.id}/schedule`, { now: true }); return { c, r }; };

test('mailer basics: plain text becomes safe HTML, and webhook signatures are checked', () => {
  const h = mailer.textToHtml('Hi <b>you</b>\nsecond line\n\nSee https://example.com/shop?a=1&b=2.');
  assert.ok(!h.includes('<b>') && h.includes('&lt;b&gt;'), 'tags are escaped');
  assert.ok(h.includes('<br>') && h.split('<p ').length === 3, 'line breaks and paragraphs');
  assert.ok(h.includes('<a href="https://example.com/shop?a=1&amp;b=2">') && h.includes('</a>.'), 'a link, without the trailing full stop');
  assert.ok(!mailer.textToHtml('javascript:alert(1) data:text/html,x').includes('<a '), 'only http(s) becomes a link');
  const m = mailer.compose({ body: 'Hello', shop: 'Ash & Anchor', address: '1 Main St', unsubUrl: 'https://x.test/unsubscribe?t=abc' });
  assert.match(m.text, /Unsubscribe: https:\/\/x\.test\/unsubscribe\?t=abc/); assert.match(m.text, /1 Main St/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  const body = '{"type":"email.bounced"}', id = 'msg_1', ts = String(Math.floor(Date.now() / 1000));
  const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(WHSEC.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
  assert.equal(mailer.verifyWebhook(body, { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, WHSEC), true);
  assert.equal(mailer.verifyWebhook(body + ' ', { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, WHSEC), false, 'a changed body fails');
  assert.equal(mailer.verifyWebhook(body, { 'svix-id': id, 'svix-timestamp': String(Number(ts) - 1000), 'svix-signature': sig }, WHSEC), false, 'an old message fails');
});

test('only people who agreed are emailed: no consent, unsubscribed and bounced are all skipped, and every message carries an unsubscribe link', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    assert.equal((await s.j('GET', '/api/admin/email/status')).status, 401, 'owner only');
    addSub(db, 'ok1@example.com'); addSub(db, 'ok2@example.com'); addSub(db, 'old@example.com', { noConsent: true }); addSub(db, 'gone@example.com', { unsub: true }); addSub(db, 'bounce@example.com', { bounced: true });
    const early = await a.post('/api/admin/email/campaigns', { subject: 'x', body: 'y' });
    assert.equal((await a.post(`/api/admin/email/campaigns/${early.data.id}/schedule`, { now: true })).status, 400, 'refused until email is switched on');
    assert.equal((await a.put('/api/admin/email/settings', { on: true })).status, 400, 'needs a from address and a mailing address first');
    assert.equal((await a.put('/api/admin/email/settings', { from: 'bad\r\nBcc: x@y.z' })).status, 400, 'no header tricks in the from address');
    assert.equal((await turnOn(a)).status, 200);
    const st = (await a.get('/api/admin/email/status')).data;
    assert.equal(st.ready, true); assert.equal(st.audience.sendable, 2); assert.equal(st.audience.no_consent, 1); assert.equal(st.audience.unsubscribed, 1); assert.equal(st.audience.bounced, 1);
    const { r } = await send(a, 'New tiles', 'Hello!\n\nVisit https://example.com/shop');
    assert.equal(r.status, 200);
    assert.ok(await until(() => fake.state.sent.length === 2), 'two emails go out');
    await sleep(400); assert.equal(fake.state.sent.length, 2, 'and only two');
    assert.deepEqual(fake.state.sent.map((m) => m.to[0]).sort(), ['ok1@example.com', 'ok2@example.com']);
    const m = fake.state.sent[0];
    assert.equal(m.from, 'Ash & Anchor <hello@example.com>'); assert.equal(m.auth, 'Bearer re_test'); assert.equal(m.subject, 'New tiles');
    assert.match(m.text, /Unsubscribe: http:\/\/localhost:\d+\/unsubscribe\?t=[\w-]{20,}/); assert.match(m.text, /1 Main St/);
    assert.match(m.headers['List-Unsubscribe'], /^<http:\/\/localhost:\d+\/unsubscribe\?t=/); assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.ok(await until(async () => (await a.get('/api/admin/email/campaigns')).data[0].status === 'done'));
    const c = (await a.get('/api/admin/email/campaigns')).data[0]; assert.equal(c.sent, 2); assert.equal(c.total, 2);
    assert.equal(db.prepare("SELECT marketing FROM email_daily").get().marketing, 2);
  } finally { stop(); }
});

test('the daily limit: receipts and confirmations keep a reserve, marketing sends the rest in daily batches', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    for (let i = 1; i <= 6; i++) addSub(db, `p${i}@example.com`);
    await turnOn(a, { daily_cap: 5, reserve: 2 });
    assert.equal((await a.get('/api/admin/email/status')).data.allowance_today, 3);
    const { r } = await send(a, 'Sale', 'Hi'); assert.equal(r.status, 200);
    assert.ok(await until(() => fake.state.sent.length === 3)); await sleep(500);
    assert.equal(fake.state.sent.length, 3, 'only the allowance goes out today');
    const c = (await a.get('/api/admin/email/campaigns')).data[0];
    assert.equal(c.status, 'sending'); assert.equal(c.sent, 3); assert.equal(c.pending, 3, 'the rest waits for tomorrow');
    assert.equal((await a.post('/api/admin/email/test', { to: 'me@example.com', subject: 'Hi', body: 'Test' })).status, 200, 'a test still goes through on the reserve');
    assert.equal(fake.state.sent.length, 4); assert.equal(fake.state.sent[3].subject, '[Test] Hi');
    // "tomorrow": clear today's marketing count, the next round sends the rest, still keeping the reserve.
    db.prepare('UPDATE email_daily SET marketing = 0').run();
    assert.ok(await until(() => fake.state.sent.length === 7), 'the remaining three go out the next day');
    assert.ok(await until(async () => (await a.get('/api/admin/email/campaigns')).data[0].status === 'done'));
  } finally { stop(); }
});

test('unsubscribe works from the link and from the one-click POST; unknown links answer the same; an unsubscribed person is skipped even mid-campaign', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup({ OUTPOST_EMAIL_PACE_MS: '0' });
  try {
    addSub(db, 'one@example.com'); addSub(db, 'two@example.com');
    await turnOn(a, { daily_cap: 100, reserve: 0 });
    const page = await fetch(s.base + '/unsubscribe?t=x'); assert.equal(page.status, 200);
    assert.equal((await s.j('POST', '/api/unsubscribe', { t: 'nope-not-a-token-at-all-xx' })).data.ok, true, 'unknown token: same answer');
    await send(a, 'Hello', 'Body'); assert.ok(await until(() => fake.state.sent.length === 2));
    const tok = fake.state.sent[0].headers['List-Unsubscribe'].match(/t=([\w-]+)/)[1];
    const who = fake.state.sent[0].to[0];
    const one = await fetch(s.base + '/unsubscribe?t=' + tok, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    assert.equal(one.status, 200);
    assert.equal(db.prepare('SELECT unsubscribed u FROM subscribers WHERE email = ?').get(who).u, 1, 'the one-click POST unsubscribes them');
    await send(a, 'Second', 'Again'); assert.ok(await until(async () => (await a.get('/api/admin/email/campaigns')).data[0].status === 'done'));
    assert.equal(fake.state.sent.filter((m) => m.to[0] === who).length, 1, 'never emailed again');
    const tok2 = fake.state.sent.find((m) => m.to[0] !== who).headers['List-Unsubscribe'].match(/t=([\w-]+)/)[1];
    assert.equal((await s.j('POST', '/api/unsubscribe', { t: tok2 })).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM subscribers WHERE unsubscribed = 1').get().n, 2);
  } finally { stop(); }
});

test('double opt-in: a new sign-up gets a confirmation email, is not emailed until they confirm, and an existing address is not emailed again', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    await turnOn(a, { double_optin: true });
    await a.put('/api/admin/settings', { mailing_list_on: true });
    const sub = async (email) => s.j('POST', '/api/subscribe', { email, consent: true, started: await s.formToken() });
    assert.equal((await sub('new@example.com')).status, 200);
    assert.ok(await until(() => fake.state.sent.length === 1), 'one confirmation email');
    assert.match(fake.state.sent[0].subject, /confirm/i); const link = fake.state.sent[0].text.match(/confirm-email\?t=([\w-]+)/);
    assert.ok(link, 'it contains the confirmation link');
    assert.equal((await a.get('/api/admin/email/status')).data.audience.sendable, 0, 'not on the sendable list yet');
    assert.equal((await a.get('/api/admin/email/status')).data.audience.unconfirmed, 1);
    await sub('new@example.com'); await sleep(400); assert.equal(fake.state.sent.length, 1, 'signing up again does not send another');
    assert.equal((await s.j('POST', '/api/confirm-email', { t: link[1] })).status, 200);
    assert.equal((await a.get('/api/admin/email/status')).data.audience.sendable, 1, 'now they count');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM email_daily WHERE transactional = 1").get().n, 1, 'the confirmation used the receipts-and-confirmations count');
    await s.j('POST', '/api/admin/login', { password: PASSWORD });
    const subs = (await a.get('/api/admin/subscribers')).data; assert.ok(subs[0].confirmed_at && 'bounced' in subs[0]);
  } finally { stop(); }
});

test('bounce and complaint reports from the provider switch people off, and only signed reports are believed', { timeout: 60000 }, async () => {
  const { s, a, db, stop } = await setup();
  try {
    addSub(db, 'bad@example.com'); addSub(db, 'angry@example.com'); addSub(db, 'soft@example.com');
    const post = (obj, secret = WHSEC, ts = String(Math.floor(Date.now() / 1000))) => {
      const body = JSON.stringify(obj), id = 'msg_' + Math.random();
      const sig = 'v1,' + crypto.createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${ts}.${body}`).digest('base64');
      return fetch(s.base + '/api/email/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig }, body });
    };
    assert.equal((await post({ type: 'email.bounced', data: { to: ['bad@example.com'], bounce: { type: 'Permanent' } } }, 'whsec_' + Buffer.from('wrong').toString('base64'))).status, 400, 'a wrongly signed report is refused');
    assert.equal(db.prepare("SELECT bounced b FROM subscribers WHERE email = 'bad@example.com'").get().b, 0);
    assert.equal((await post({ type: 'email.bounced', data: { to: ['bad@example.com'], bounce: { type: 'Permanent' } } })).status, 200);
    assert.equal((await post({ type: 'email.bounced', data: { to: ['soft@example.com'], bounce: { type: 'Transient' } } })).status, 200);
    assert.equal((await post({ type: 'email.complained', data: { to: ['angry@example.com'] } })).status, 200);
    const g = (e) => db.prepare('SELECT bounced b, unsubscribed u FROM subscribers WHERE email = ?').get(e);
    assert.equal(g('bad@example.com').b, 1, 'a hard bounce is suppressed'); assert.equal(g('soft@example.com').b, 0, 'a temporary bounce is not');
    assert.equal(g('angry@example.com').u, 1, 'a spam complaint unsubscribes');
    assert.equal((await fetch(s.base + '/api/email/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 400, 'unsigned is refused');
  } finally { stop(); }
});

test('provider trouble: a bad key stops the batch and tells the owner; a refused address is skipped; nothing is lost', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    addSub(db, 'a@example.com'); addSub(db, 'b@example.com');
    await turnOn(a, { daily_cap: 100, reserve: 0 });
    fake.state.status = 401;
    await send(a, 'Hi', 'Body');
    assert.ok(await until(async () => /verified|key/i.test((await a.get('/api/admin/email/status')).data.last_error)), 'the owner is told');
    let c = (await a.get('/api/admin/email/campaigns')).data[0]; assert.equal(c.pending, 2); assert.equal(c.status, 'sending', 'still waiting, nothing marked failed');
    fake.state.status = 200;
    assert.ok(await until(async () => (await a.get('/api/admin/email/campaigns')).data[0].status === 'done'), 'it resumes by itself once fixed');
    assert.equal(fake.state.sent.length, 2); assert.equal((await a.get('/api/admin/email/status')).data.last_error, '', 'and the warning clears');
    // a refused address (422) is skipped
    addSub(db, 'c@example.com'); fake.state.status = 422;
    await send(a, 'Again', 'Body');
    assert.ok(await until(async () => { const x = (await a.get('/api/admin/email/campaigns')).data[0]; return x.failed >= 1; }));
    fake.state.status = 200;
    // cancel: scheduled goes back to draft; sending becomes canceled; sending ones can't be deleted
    const d = (await a.post('/api/admin/email/campaigns', { subject: 'Later', body: 'x' })).data;
    await a.post(`/api/admin/email/campaigns/${d.id}/schedule`, { scheduled_at: Date.now() + 86400e3 });
    assert.equal((await a.post(`/api/admin/email/campaigns/${d.id}/cancel`, {})).data.status, 'draft');
    assert.equal((await a.put(`/api/admin/email/campaigns/${d.id}`, { subject: 'Edited' })).data.subject, 'Edited');
    assert.equal((await a.del(`/api/admin/email/campaigns/${d.id}`)).status, 200);
    assert.equal((await a.post('/api/admin/email/campaigns/999/cancel', {})).status, 404);
    assert.equal((await a.post('/api/admin/email/campaigns', { subject: 'x\r\nBcc: evil@x.com', body: 'y' })).data.subject, 'x Bcc: evil@x.com', 'no line breaks in a subject');
  } finally { stop(); }
});

test('the key never lands in the database or the status, and deleting a person removes them from past sends', { timeout: 60000 }, async () => {
  const { s, a, db, stop } = await setup();
  try {
    await turnOn(a);
    const all = JSON.stringify(db.prepare('SELECT * FROM settings').all());
    assert.ok(!all.includes('re_test') && !all.includes('whsec'), 'no secrets in the settings table');
    assert.ok(!JSON.stringify((await a.get('/api/admin/email/status')).data).includes('re_test'), 'nor in the status');
    assert.equal((await a.get('/api/admin/email/status')).data.key_present, true);
    const off = await startServer({ OUTPOST_EMAIL_TICK_MS: '100' });
    try { const t = (await off.j('POST', '/api/admin/login', { password: PASSWORD })).data.token; const st = (await off.j('GET', '/api/admin/email/status', undefined, { 'x-admin-token': t })).data; assert.equal(st.key_present, false); assert.equal(st.ready, false); assert.equal((await off.j('POST', '/api/email/webhook', {})).status, 503, 'no webhook secret: not listening'); } finally { off.stop(); }
  } finally { stop(); }
});

test('designed emails: buttons, photos and product cards are email-safe, links are cleaned, shop links carry the tracking code', () => {
  const d = mailer.cleanDesign({ template: 'feature', blocks: [
    { type: 'photo', url: '/images/a.jpg', alt: 'Blue frog tile', link: '/shop?p=3' },
    { type: 'heading', text: 'New <b>tiles</b>' }, { type: 'text', text: 'Hello\n\nhttps://example.com/x' },
    { type: 'button', label: 'Shop now', url: 'javascript:alert(1)' }, { type: 'button', label: 'Shop now', url: '/shop' }, { type: 'button', label: 'Other', url: 'https://other.example/p' },
    { type: 'photos', urls: ['/images/1.jpg', 'data:image/png;base64,AAAA', '/images/2.jpg', '/images/3.jpg', '/images/4.jpg'] },
    { type: 'product', product_id: 7, label: 'Buy it' }, { type: 'evil', text: 'x' }, { type: 'divider' }] });
  assert.equal(d.blocks.length, 9, 'unknown block types are dropped');
  assert.equal(d.blocks.filter((b) => b.type === 'button')[0].url, '', 'the javascript: button has no address');
  assert.deepEqual(d.blocks.find((b) => b.type === 'photos').urls, ['/images/1.jpg', '/images/2.jpg'], 'only 3 photos max and no data: addresses (the 4th and 5th are cut)');
  const r = mailer.renderDesign(d, { shop: 'Ash & Anchor', base: 'https://shop.test', logo: '/images/logo.png', theme: { button: '#f72d00' }, products: { 7: { name: 'Blue frog', price: '$25.00', image: '/images/p.jpg', url: '/shop?p=7' } }, linkCode: 'email', address: '1 Main St', unsubUrl: 'https://shop.test/unsubscribe?t=abc', subject: 'Hi' });
  assert.ok(!r.html.includes('javascript:') && !r.html.includes('<b>tiles') && r.html.includes('&lt;b&gt;tiles'), 'nothing unsafe gets through');
  assert.ok(r.html.includes('bgcolor="#f72d00"') && /<a href="https:\/\/shop\.test\/shop\?s=email"[^>]*>Shop now<\/a>/.test(r.html), 'a bulletproof button on a coloured cell with the tracked shop link');
  assert.ok(r.html.includes('href="https://other.example/p"') && !r.html.includes('other.example/p?s='), 'outside links are left alone');
  assert.ok(r.html.includes('alt="Blue frog tile"') && r.html.includes('src="https://shop.test/images/a.jpg"'), 'photos are absolute and have alt text');
  assert.ok(r.html.includes('Blue frog') && r.html.includes('$25.00') && r.html.includes('shop?p=7&amp;s=email') && r.html.includes('Buy it'), 'product card with price, link and button label');
  assert.ok(r.html.includes('max-width:600px') && r.html.includes('role="presentation"') && r.html.includes('Unsubscribe'), '600px table layout with a footer');
  assert.match(r.text, /Shop now: https:\/\/shop\.test\/shop\?s=email/); assert.match(r.text, /\[Blue frog tile\]/); assert.match(r.text, /Unsubscribe: https:\/\/shop\.test\/unsubscribe\?t=abc/);
  assert.equal(r.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(r.html, /color:#ffffff/, 'white text on the orange button (picked for contrast)');
});

test('a designed email is saved, previewed and sent with the shop theme, a product card and the tracked link; templates can be saved and removed', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    addSub(db, 'fan@example.com');
    await turnOn(a, { daily_cap: 100, reserve: 0 });
    const pid = Number(db.prepare("INSERT INTO products (name, price_cents, stock, active, image_url) VALUES ('Blue frog tile', 2500, 3, 1, '/images/frog.jpg')").run().lastInsertRowid);
    const link = (await a.post('/api/admin/marketing/links', { name: 'Email: December' })).data;
    const design = { template: 'banner', blocks: [{ type: 'heading', text: 'New tiles' }, { type: 'text', text: 'They are here.' }, { type: 'product', product_id: pid, label: 'Get it' }, { type: 'button', label: 'Shop now', url: '/shop' }] };
    const pv = (await a.post('/api/admin/email/preview', { subject: 'Hi', design, link_code: link.code })).data;
    assert.ok(pv.html.includes('Blue frog tile') && pv.html.includes('$25.00'));
    assert.ok(pv.html.includes('s=' + link.code) && pv.html.includes('Get it'), 'preview shows the real thing');
    assert.equal((await a.post('/api/admin/email/campaigns', { subject: 'x', design, link_code: 'nope' })).status, 400, 'an unknown tracked link is refused');
    const c = (await a.post('/api/admin/email/campaigns', { subject: 'New tiles', design, link_code: link.code })).data;
    assert.equal(c.design.blocks.length, 4); assert.equal(c.link_code, link.code); assert.match(c.body, /New tiles/);
    assert.equal((await a.put(`/api/admin/email/campaigns/${c.id}`, { design: { template: 'plain', blocks: [] } })).status, 200);
    assert.equal((await a.post(`/api/admin/email/campaigns/${c.id}/schedule`, { now: true })).status, 400, 'an empty design cannot be sent');
    await a.put(`/api/admin/email/campaigns/${c.id}`, { design });
    assert.equal((await a.post(`/api/admin/email/campaigns/${c.id}/schedule`, { now: true })).status, 200);
    assert.ok(await until(() => fake.state.sent.length === 1));
    const m = fake.state.sent[0];
    assert.ok(m.html.includes('Blue frog tile') && m.html.includes('/shop?p=' + pid) && m.html.includes('s=' + link.code), 'the product card and tracked links are in the sent email');
    assert.match(m.html, /unsubscribe\?t=[\w-]{20,}/); assert.match(m.text, /Shop now: http:\/\/localhost:\d+\/shop\?s=/); assert.match(m.text, /Blue frog tile \(\$25\.00\)/);
    assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    // templates
    assert.equal((await a.post('/api/admin/email/templates', { name: '', design })).status, 400);
    assert.equal((await a.post('/api/admin/email/templates', { name: 'Monthly', design: { template: 'plain', blocks: [] } })).status, 400, 'an empty design is not worth saving');
    const t = (await a.post('/api/admin/email/templates', { name: 'Monthly drop', design })).data;
    const list = (await a.get('/api/admin/email/templates')).data; assert.equal(list.length, 1); assert.equal(list[0].design.blocks[2].product_id, pid);
    assert.equal((await a.del('/api/admin/email/templates/' + t.id)).status, 200); assert.equal((await a.get('/api/admin/email/templates')).data.length, 0);
    assert.equal((await s.j('GET', '/api/admin/email/templates')).status, 401, 'owner only');
  } finally { stop(); }
});

test('a Collection block shows a shop line (live, newest first, sold-out and hidden left out, "Only N left") or hand-picked items, with a shop-the-collection button', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    addSub(db, 'fan@example.com'); await turnOn(a, { daily_cap: 100, reserve: 0 });
    const prod = (name, stock, active = 1) => Number(db.prepare('INSERT INTO products (name, price_cents, stock, active, image_url) VALUES (?,?,?,?,?)').run(name, 2500, stock, active, '/images/' + name.replace(/\W/g, '') + '.jpg').lastInsertRowid);
    const frog = prod('Frog tile', 10), owl = prod('Owl tile', 2), gone = prod('Sold out tile', 0), hid = prod('Hidden tile', 5, 0), other = prod('Not in line', 4);
    const line = Number(db.prepare("INSERT INTO lines (name, slug, active) VALUES ('Winter tiles', 'winter-tiles', 1)").run().lastInsertRowid);
    for (const p of [frog, owl, gone, hid]) db.prepare('INSERT INTO product_lines (product_id, line_id) VALUES (?,?)').run(p, line);
    const link = (await a.post('/api/admin/marketing/links', { name: 'Collection email' })).data;
    const mk = (blocks) => ({ template: 'collection', blocks });
    const prev = async (blocks) => (await a.post('/api/admin/email/preview', { subject: 'New', design: mk(blocks), link_code: link.code })).data.html;
    const html = await prev([{ type: 'collection', line_id: line, label: 'Shop the collection' }]);
    assert.ok(html.includes('Frog tile') && html.includes('Owl tile'), 'items in the line');
    assert.ok(!html.includes('Sold out tile') && !html.includes('Hidden tile') && !html.includes('Not in line'), 'sold-out, hidden and other items are left out');
    assert.ok(html.indexOf('Owl tile') < html.indexOf('Frog tile'), 'newest first');
    assert.ok(html.includes('Only 2 left') && !html.includes('Only 10 left'), 'real low stock only');
    assert.ok(html.includes('/shop?line=winter-tiles&amp;s=' + link.code) && html.includes('>Shop the collection</a>'), 'the button goes to the line, tracked');
    assert.ok(html.includes('/shop?p=' + frog + '&amp;s=' + link.code), 'each item links to its own page');
    const picked = await prev([{ type: 'collection', product_ids: [other, frog, gone], label: '' }]);
    assert.ok(picked.indexOf('Not in line') < picked.indexOf('Frog tile') && !picked.includes('Sold out tile'), 'hand-picked keep their order, sold-out dropped');
    assert.ok(!picked.includes('>Shop the collection<'), 'no button without a label');
    assert.ok(!(await prev([{ type: 'heading', text: 'Hi' }, { type: 'collection', line_id: 999 }])).includes('Frog tile'), 'an empty or missing line just shows nothing');
    const c = (await a.post('/api/admin/email/campaigns', { subject: 'Winter tiles', design: mk([{ type: 'heading', text: 'Winter tiles' }, { type: 'collection', line_id: line, label: 'See everything' }]), link_code: link.code })).data;
    db.prepare('UPDATE products SET stock = 0 WHERE id = ?').run(owl);   // sells out before the email goes
    assert.equal((await a.post(`/api/admin/email/campaigns/${c.id}/schedule`, { now: true })).status, 200);
    assert.ok(await until(() => fake.state.sent.length === 1));
    assert.ok(fake.state.sent[0].html.includes('Frog tile') && !fake.state.sent[0].html.includes('Owl tile'), 'what is sent reflects stock at send time');
    assert.match(fake.state.sent[0].text, /Frog tile \(\$25\.00\): http:\/\/localhost:\d+\/shop\?p=\d+&s=/); assert.match(fake.state.sent[0].text, /See everything: http:\/\/localhost:\d+\/shop\?line=winter-tiles/);
    assert.equal(mailer.cleanDesign({ blocks: [{ type: 'collection', product_ids: [1, 2, 3, 4, 5, 6, 7, 8], line_id: '3' }] }).blocks[0].product_ids.length, 6, 'at most six hand-picked');
  } finally { stop(); }
});

test('email text stays readable on the white card even when the shop theme uses light text', () => {
  const d = { template: 'banner', blocks: [{ type: 'heading', text: 'Hello' }, { type: 'text', text: 'Body' }] };
  const html = mailer.renderDesign(d, { shop: 'Shop', base: 'http://x.test', theme: { text: '#f5f5f5', heading: '#ffffff', link: '#fafafa' }, address: '', unsubUrl: 'http://x.test/u' }).html;
  assert.ok(!/color:#ffffff">Hello/i.test(html) && !/color:#f5f5f5/i.test(html), 'light theme colours are not used for text on white');
  assert.match(html, /<h1[^>]*color:#222222">Hello/, 'falls back to a dark colour');
  const dark = mailer.renderDesign(d, { shop: 'Shop', base: 'http://x.test', theme: { text: '#333333', heading: '#112244' }, address: '', unsubUrl: 'http://x.test/u' }).html;
  assert.match(dark, /<h1[^>]*color:#112244">Hello/, 'a readable theme colour is kept');
});

test('every designed email gets its own tracked link automatically; test sends count toward the daily total but come out of the receipts reserve', { timeout: 60000 }, async () => {
  const { s, a, fake, stop } = await setup();
  try {
    await a.put('/api/admin/email/settings', { from: 'Shop <hello@example.com>', mail_address: '1 Main St', on: true });
    const c = (await a.post('/api/admin/email/campaigns', { subject: 'Spring tiles', design: { template: 'plain', blocks: [{ type: 'heading', text: 'Hi' }] } })).data;
    assert.ok(c.link_code, 'a link was made without asking');
    const links = (await a.get('/api/admin/marketing/links')).data.links;
    assert.ok(links.some((l) => l.code === c.link_code && l.name === 'Email: Spring tiles'), 'named after the email');
    const c2 = (await a.put(`/api/admin/email/campaigns/${c.id}`, { subject: 'Spring tiles v2', design: { template: 'plain', blocks: [{ type: 'heading', text: 'Hi again' }] } })).data;
    assert.equal(c2.link_code, c.link_code, 'editing keeps the same link, no duplicates');
    const before = (await a.get('/api/admin/email/status')).data;
    await a.post('/api/admin/email/test', { to: 'me@example.com', subject: 'T', design: { template: 'plain', blocks: [{ type: 'heading', text: 'Hi' }] } });
    const after = (await a.get('/api/admin/email/status')).data;
    assert.equal(after.sent_today.transactional, before.sent_today.transactional + 1, 'a test counts toward today');
    assert.equal(after.allowance_today, before.allowance_today, 'but marketing room is unchanged while the reserve covers it');
  } finally { stop(); }
});

test('a Banner email can use its own header image in place of the logo, and it survives saving', () => {
  const ctx = { shop: 'Shop', base: 'http://x.test', logo: '/images/logo.png', address: '', unsubUrl: 'http://x.test/u' };
  const d = mailer.cleanDesign({ template: 'banner', header_url: '/images/hero.jpg', blocks: [{ type: 'heading', text: 'Hi' }] });
  assert.equal(d.header_url, '/images/hero.jpg', 'kept when saved');
  const html = mailer.renderDesign(d, ctx).html;
  assert.ok(html.includes('http://x.test/images/hero.jpg') && !html.includes('logo.png'), 'the header image replaces the logo');
  assert.ok(mailer.renderDesign({ template: 'banner', blocks: [] }, ctx).html.includes('logo.png'), 'no header image: the logo shows as before');
  assert.ok(!mailer.renderDesign({ template: 'plain', header_url: '/images/hero.jpg', blocks: [] }, ctx).html.includes('hero.jpg'), 'Plain has no header');
  assert.equal(mailer.cleanDesign({ template: 'banner', header_url: 'javascript:alert(1)', blocks: [] }).header_url, undefined, 'unsafe addresses are dropped');
});
