'use strict';
// Run with: npm test. Checks the Security tab log: staff sign-ins apart from blocked attempts, paging, filters, and the CSV download.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, PASSWORD } = require('./helpers');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, get: (u) => s.j('GET', u, undefined, t) }; }

test('security log: staff sign-ins are kept apart from blocked attempts', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const dbh = open(s);
    dbh.prepare("INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)").run(Date.now(), 'honeypot', '9.9.9.9', 'trap');
    const d = (await a.get('/api/admin/security')).data;
    assert.ok(d.staff.length >= 1 && d.staff.every((e) => e.kind.startsWith('admin_')), 'staff box has only staff entries');
    assert.ok(d.attempts.length >= 1 && d.attempts.every((e) => !e.kind.startsWith('admin_')), 'blocked box has no staff entries');
    assert.ok(d.attempts.some((e) => e.kind === 'honeypot'));
    assert.ok(d.attempts[0].id, 'rows carry an id for paging');
    dbh.close();
  } finally { s.stop(); }
});

test('security log: Show more pages 25 at a time without repeats, and the filters pick the right kinds', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const dbh = open(s);
    const ins = dbh.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)');
    dbh.transaction(() => { for (let i = 0; i < 60; i++) ins.run(1000 + i, 'honeypot', '9.9.9.9', 'n' + i); for (let i = 0; i < 3; i++) ins.run(2000 + i, 'oversold', '', 'm' + i); })();
    const p1 = (await a.get('/api/admin/security/events?group=bots')).data;
    assert.equal(p1.events.length, 25); assert.equal(p1.more, true);
    const p2 = (await a.get('/api/admin/security/events?group=bots&before=' + p1.events[24].id)).data;
    const p3 = (await a.get('/api/admin/security/events?group=bots&before=' + p2.events[24].id)).data;
    assert.equal(p2.events.length, 25); assert.equal(p3.events.length, 10); assert.equal(p3.more, false);
    const ids = [...p1.events, ...p2.events, ...p3.events].map((e) => e.id);
    assert.equal(new Set(ids).size, 60, 'no repeats and nothing missing');
    assert.ok(ids.every((v, i) => i === 0 || v < ids[i - 1]), 'newest first');
    const money = (await a.get('/api/admin/security/events?group=money')).data;
    assert.deepEqual(money.events.map((e) => e.kind), ['oversold', 'oversold', 'oversold']);
    const all = (await a.get('/api/admin/security/events?group=all')).data;
    assert.ok(all.events.every((e) => !e.kind.startsWith('admin_')), '"All" leaves out staff sign-ins');
    const staff = (await a.get('/api/admin/security/events?group=staff')).data;
    assert.ok(staff.events.length >= 1 && staff.events.every((e) => e.kind.startsWith('admin_')));
    assert.equal((await a.get('/api/admin/security/events?group=nope')).status, 400);
    dbh.close();
  } finally { s.stop(); }
});

test('security log: the CSV has every entry, guards spreadsheet formulas, and needs a sign-in', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const dbh = open(s);
    const ins = dbh.prepare('INSERT INTO security_events (at, kind, ip, detail) VALUES (?,?,?,?)');
    dbh.transaction(() => { for (let i = 0; i < 40; i++) ins.run(1000 + i, 'honeypot', '9.9.9.9', 'n' + i); })();
    ins.run(5000, 'code_guessing', '8.8.8.8', '=HYPERLINK("http://x","hi"), more');
    const r = await fetch(s.base + '/api/admin/security/log.csv', { headers: a.t });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="outpost-security-log-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await r.text();
    const lines = text.trim().split('\n');
    assert.equal(lines[0], 'when (UTC),group,what,address,details');
    assert.ok(lines.length - 1 >= 41, 'every entry is in the file, not just the newest 25');
    assert.ok(lines.some((l) => l.includes(`"'=HYPERLINK(""http://x"",""hi""), more"`)), 'a formula in the details is defused and quoted');
    assert.ok(lines.some((l) => /,staff,admin_login,/.test(l)), 'sign-ins are in the file, marked as staff');
    assert.equal((await fetch(s.base + '/api/admin/security/log.csv')).status, 401);
    dbh.close();
  } finally { s.stop(); }
});
