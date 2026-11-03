'use strict';
// Run with: npm test. Checks review items 16, 20 and 21 (password check at start-up, private screens not cached, HSTS).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Safe = require('../safe');
const { startServer, PASSWORD, sleep } = require('./helpers');

// Starts the app with exactly this environment and reports whether it stays up or stops (and what it said).
async function tryStart(env) {
  const port = 4900 + Math.floor(Math.random() * 500);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-start-'));
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { PATH: process.env.PATH, PORT: String(port), DATA_DIR: dir, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; proc.stdout.on('data', (d) => { out += d; }); proc.stderr.on('data', (d) => { out += d; });
  let up = false;
  for (let i = 0; i < 40 && !up && proc.exitCode === null; i++) { try { up = (await fetch(`http://127.0.0.1:${port}/api/settings`)).ok; } catch { /* not yet */ } if (!up) await sleep(100); }
  const exited = proc.exitCode !== null;
  proc.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  return { up, exited, code: proc.exitCode, out };
}

test('item 16: what counts as a weak admin password', () => {
  for (const p of ['', 'short', 'change-me', 'Password1', 'password123', 'aaaaaaaa', '12345678', 'abcdefgh', 'Password1!', 'qwertyuiop']) assert.equal(Safe.passwordProblem(p).level, 'hard', p);
  assert.equal(Safe.passwordProblem('ashandanchor1', ['ash']).level, 'hard');
  assert.equal(Safe.passwordProblem('Xk9!mPq2').level, 'soft');
  assert.equal(Safe.passwordProblem('correct-horse-battery'), null);
  assert.equal(Safe.passwordProblem(PASSWORD), null);
});

test('item 16: a weak password stops the app on a hosted site even when BASE_URL was left blank', { timeout: 30000 }, async () => {
  for (const pw of ['change-me', 'Password1', 'aaaaaaaa']) {
    const r = await tryStart({ RENDER: 'true', ADMIN_PASSWORD: pw });   // no BASE_URL at all, like a forgotten setting on Render
    assert.equal(r.up, false, pw); assert.equal(r.exited, true, pw); assert.notEqual(r.code, 0, pw);
    assert.match(r.out, /will not start/, pw);
  }
  const prod = await tryStart({ NODE_ENV: 'production', ADMIN_PASSWORD: 'Password1' });
  assert.equal(prod.up, false);
  const named = await tryStart({ BASE_URL: 'https://shop.example.com', ADMIN_PASSWORD: 'change-me' });
  assert.equal(named.up, false);
});

test('item 16: a strong password starts; a weak one is allowed only on your own computer; a short-but-not-silly one warns', { timeout: 30000 }, async () => {
  assert.equal((await tryStart({ RENDER: 'true', ADMIN_PASSWORD: PASSWORD })).up, true);
  const local = await tryStart({ ADMIN_PASSWORD: 'Password1' });   // BASE_URL unset and not hosted: your own computer
  assert.equal(local.up, true); assert.match(local.out, /easy to guess/);
  const soft = await tryStart({ RENDER: 'true', ADMIN_PASSWORD: 'Xk9!mPq2' });
  assert.equal(soft.up, true); assert.match(soft.out, /easy to guess/);
});

test('item 20: private owner screens are never cached; public ones are unaffected', async () => {
  const s = await startServer();
  try {
    const login = await s.j('POST', '/api/admin/login', { password: PASSWORD });
    const t = { 'x-admin-token': login.data.token };
    for (const [m, u, h] of [['GET', '/api/admin/status', t], ['GET', '/api/admin/status', {}], ['GET', '/api/admin/backup', t], ['POST', '/api/register/sale', t]]) {
      const res = await fetch(s.base + u, { method: m, headers: { 'content-type': 'application/json', ...h }, body: m === 'POST' ? '{}' : undefined });
      assert.equal(res.headers.get('cache-control'), 'no-store', `${m} ${u}`);
    }
    const pub = await fetch(s.base + '/api/settings');
    assert.notEqual(pub.headers.get('cache-control'), 'no-store');
  } finally { s.stop(); }
});

test('item 21: HSTS is sent for an https site for a year; subdomains only when switched on', async () => {
  const a = await startServer({ BASE_URL: 'https://shop.example.com' });
  try { assert.equal((await fetch(a.base + '/api/settings')).headers.get('strict-transport-security'), 'max-age=31536000'); } finally { a.stop(); }
  const b = await startServer({ BASE_URL: 'https://shop.example.com', HSTS_SUBDOMAINS: '1' });
  try { assert.equal((await fetch(b.base + '/api/settings')).headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains'); } finally { b.stop(); }
  const c = await startServer();
  try { assert.equal((await fetch(c.base + '/api/settings')).headers.get('strict-transport-security'), null, 'not sent for a local http site'); } finally { c.stop(); }
});

test('item 17 (code half): TRUST_PROXY=true is refused, so a faked address header no longer fakes who a visitor is', { timeout: 60000 }, async () => {
  const s = await startServer({ TRUST_PROXY: 'true' });
  try {
    let refusedAt = -1;
    for (let i = 0; i < 45 && refusedAt < 0; i++) {
      const r = await s.j('POST', '/api/bidders', { name: 'x', email: 'nope', started: await s.formToken() }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
      if (r.status === 429) refusedAt = i;
    }
    assert.ok(refusedAt > 20 && refusedAt <= 32, `all the faked addresses counted as one visitor; refused at try ${refusedAt}`);
  } finally { s.stop(); }
  const r = await tryStart({ TRUST_PROXY: 'true', ADMIN_PASSWORD: PASSWORD });
  assert.equal(r.up, true); assert.match(r.out, /TRUST_PROXY=true is not allowed/);
});
