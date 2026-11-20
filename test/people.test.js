'use strict';
// Run with: npm test. People: tags, groups, notes, the profile, and sending an email to just one group.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, sleep, PASSWORD } = require('./helpers');

function fakeResend() {
  const state = { sent: [] };
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { state.sent.push(JSON.parse(b)); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: 'em_' + state.sent.length })); }); });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ state, url: 'http://127.0.0.1:' + srv.address().port, close: () => srv.close() })));
}
async function setup() {
  const fake = await fakeResend();
  const s = await startServer({ RESEND_API_KEY: 're_test', RESEND_API_URL: fake.url, OUTPOST_EMAIL_TICK_MS: '100', OUTPOST_EMAIL_PACE_MS: '0' });
  const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD });
  const t = { 'x-admin-token': data.token };
  const a = { post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), get: (u) => s.j('GET', u, undefined, t), del: (u) => s.j('DELETE', u, undefined, t) };
  const db = new Database(path.join(s.dir, 'outpost.db'));
  return { s, a, db, fake, stop: () => { db.close(); s.stop(); fake.close(); } };
}
const sub = (db, email) => db.prepare('INSERT INTO subscribers (email, source, created_at, consent_at) VALUES (?,?,?,?)').run(email, 'test', Date.now(), Date.now());
const order = (db, email, cents) => Number(db.prepare("INSERT INTO orders (channel, payment_method, status, total_cents, customer_email) VALUES ('online','card','paid',?,?)").run(cents, email).lastInsertRowid);
async function until(fn, ms = 6000) { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(60); } return false; }

test('people: one list of customers and subscribers, with groups that fill themselves in, tags, a private note and a profile', { timeout: 60000 }, async () => {
  const { s, a, db, stop } = await setup();
  try {
    assert.equal((await s.j('GET', '/api/admin/people')).status, 401, 'owner only');
    sub(db, 'maya@example.com'); sub(db, 'lurker@example.com'); order(db, 'maya@example.com', 3000); order(db, 'maya@example.com', 2000); order(db, 'one@example.com', 1000);
    const l = (await a.get('/api/admin/people')).data;
    const by = (e) => l.people.find((p) => p.email === e);
    assert.equal(by('maya@example.com').orders, 2); assert.equal(by('maya@example.com').email_status, 'subscribed');
    assert.equal(by('one@example.com').email_status, 'none', 'a buyer who never joined the list');
    assert.equal(by('lurker@example.com').orders, 0, 'a subscriber who never bought is still a person');
    assert.deepEqual([l.groups.everyone, l.groups.buyers, l.groups.repeat, l.groups.subscribed, l.groups.never_bought], [3, 2, 1, 2, 1]);
    // tags: created on the fly, case-insensitive, bulk add and remove
    assert.equal((await a.post('/api/admin/people/tag', { emails: [] , add: ['x'] })).status, 400, 'nobody picked');
    assert.equal((await a.post('/api/admin/people/tag', { emails: ['Maya@Example.com', 'lurker@example.com', 'not-an-email'], add: ['  Box   member '] })).status, 200);
    let tags = (await a.get('/api/admin/tags')).data; assert.deepEqual(tags.map((t) => [t.name, t.count]), [['Box member', 2]], 'spaces tidied, bad address ignored');
    await a.post('/api/admin/people/tag', { emails: ['maya@example.com'], add: ['box MEMBER', 'Allergy: nuts'] });
    tags = (await a.get('/api/admin/tags')).data; assert.equal(tags.length, 2, 'same name in another case is the same tag');
    assert.deepEqual((await a.get('/api/admin/people')).data.people.find((p) => p.email === 'maya@example.com').tags.map((t) => t.name), ['Allergy: nuts', 'Box member']);
    await a.post('/api/admin/people/tag', { emails: ['maya@example.com'], remove: ['Allergy: nuts'] });
    assert.equal((await a.get('/api/admin/people')).data.tags.find((t) => t.name === 'Allergy: nuts').count, 0);
    assert.equal((await a.put(`/api/admin/tags/${tags[0].id}`, { name: 'Box member' })).status, 409, 'no two tags with one name');
    // note and profile
    await a.put('/api/admin/people/note', { email: 'maya@example.com', note: 'Prefers pickup' });
    const pr = (await a.get('/api/admin/people/profile?email=maya@example.com')).data;
    assert.equal(pr.note, 'Prefers pickup'); assert.equal(pr.orders_list.length, 2); assert.equal(pr.spent_cents, 5000); assert.equal(pr.email_status, 'subscribed'); assert.ok(pr.tags.some((t) => t.name === 'Box member'));
    assert.equal((await a.get('/api/admin/people/profile?email=nope')).status, 400);
    assert.ok((await a.get('/api/admin/people')).data.people.find((p) => p.email === 'maya@example.com').has_note);
    // erasing a person removes their tags and note too
    assert.equal((await a.post('/api/admin/privacy/erase', { email: 'maya@example.com', force: true })).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM person_tags WHERE lower(email) = 'maya@example.com'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM person_notes WHERE lower(email) = 'maya@example.com'").get().n, 0);
  } finally { stop(); }
});

test('an email can go to just a tag or a group, never to someone outside it, and deleting a tag can not widen a waiting email', { timeout: 60000 }, async () => {
  const { s, a, db, fake, stop } = await setup();
  try {
    await a.put('/api/admin/email/settings', { from: 'Ash & Anchor <hello@example.com>', mail_address: 'Ash & Anchor, 1 Main St, Portland OR 97201', on: true, daily_cap: 100, reserve: 0 });
    for (const e of ['box1@example.com', 'box2@example.com', 'plain@example.com', 'buyer@example.com']) sub(db, e);
    order(db, 'buyer@example.com', 4000);
    await a.post('/api/admin/people/tag', { emails: ['box1@example.com', 'box2@example.com'], add: ['Box member'] });
    const tag = (await a.get('/api/admin/tags')).data[0];
    const opts = (await a.get('/api/admin/email/status')).data.audiences;
    const n = (f) => opts.find(f).sendable;
    assert.equal(n((o) => o.kind === 'all'), 4); assert.equal(n((o) => o.kind === 'tag'), 2); assert.equal(n((o) => o.group === 'buyers'), 1); assert.equal(n((o) => o.group === 'never_bought'), 3);
    const c = (await a.post('/api/admin/email/campaigns', { subject: 'Box news', body: 'Hello box people', audience: { kind: 'tag', tag: tag.id } })).data;
    assert.deepEqual(c.audience, { kind: 'tag', tag: tag.id });
    assert.equal((await a.post('/api/admin/email/campaigns', { subject: 'x', body: 'y', audience: { kind: 'tag', tag: 9999 } })).data.audience, null, 'an unknown tag is ignored, not guessed');
    // a waiting email aimed at the tag: deleting the tag is refused unless forced, and then the email goes back to a draft for everyone
    await a.post(`/api/admin/email/campaigns/${c.id}/schedule`, { scheduled_at: Date.now() + 5 * 86400e3 });
    const r1 = await a.del(`/api/admin/tags/${tag.id}`); assert.equal(r1.status, 409); assert.match(r1.data.error || r1.data.message || JSON.stringify(r1.data), /unsent email/);
    const r2 = await a.del(`/api/admin/tags/${tag.id}?force=1`); assert.equal(r2.status, 200); assert.equal(r2.data.emails_reset, 1);
    const after = (await a.get('/api/admin/email/campaigns')).data; const row = (after.campaigns || after).find((x) => x.id === c.id);
    assert.equal(row.status, 'draft', 'taken off the schedule'); assert.equal(row.audience, null);
    // send to the tag for real
    await a.post('/api/admin/people/tag', { emails: ['box1@example.com', 'box2@example.com'], add: ['Box member'] });
    const t2 = (await a.get('/api/admin/tags')).data[0];
    const c2 = (await a.post('/api/admin/email/campaigns', { subject: 'Box news', body: 'Hello box people', audience: { kind: 'tag', tag: t2.id } })).data;
    assert.equal((await a.post(`/api/admin/email/campaigns/${c2.id}/schedule`, { now: true })).status, 200);
    assert.ok(await until(() => fake.state.sent.length === 2));
    assert.deepEqual(fake.state.sent.map((m) => m.to[0] || m.to).flat().sort(), ['box1@example.com', 'box2@example.com']);
    // an empty group can not be scheduled
    const c3 = (await a.post('/api/admin/email/campaigns', { subject: 'Repeat', body: 'Hi', audience: { kind: 'group', group: 'repeat' } })).data;
    const r3 = await a.post(`/api/admin/email/campaigns/${c3.id}/schedule`, { now: true }); assert.equal(r3.status, 400);
  } finally { stop(); }
});
