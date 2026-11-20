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
