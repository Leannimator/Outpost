'use strict';
// Run with: npm test. Checks review items 11 to 15, 18 and 19 (staff sign-in) against a real running copy of the app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Auth = require('../auth');
const Safe = require('../safe');
const { startServer, PASSWORD } = require('./helpers');

const login = (s, body = {}, headers = {}) => s.j('POST', '/api/admin/login', { password: PASSWORD, ...body }, headers);
const tok = (t) => ({ 'x-admin-token': t });
// A code for the current 30-second step plus an offset. Each use goes one step forward, because a code can only be used once.
const code = (secret, offset) => Auth.hotp(secret, Math.floor(Date.now() / 30000) + offset);

async function signInWithTwoStep(s) {
  const a = await login(s); assert.equal(a.status, 200);
  const st = await s.j('POST', '/api/admin/2fa/start', { password: PASSWORD }, tok(a.data.token));
  assert.equal(st.status, 200, JSON.stringify(st.data));
  const en = await s.j('POST', '/api/admin/2fa/enable', { password: PASSWORD, code: code(st.data.secret, -1) }, tok(a.data.token));
  assert.equal(en.status, 200, JSON.stringify(en.data));
  return { token: a.data.token, secret: st.data.secret };
}

test('item 18: password comparison does not depend on length', () => {
  assert.equal(Safe.safeEqual('abc', 'abc'), true);
  assert.equal(Safe.safeEqual('abc', 'abcd'), false);
  assert.equal(Safe.safeEqual('', 'x'), false);
  assert.equal(Safe.safeEqual('x'.repeat(5000), 'x'.repeat(5000)), true);
});

test('item 11: strangers\' failed guesses lock the page, but a known browser still gets in', async () => {
  const s = await startServer();
  try {
    const first = await login(s);
    assert.equal(first.status, 200);
    assert.ok(/^[0-9a-f]{64}$/.test(first.data.device_token), 'the first sign-in hands back a device token');
    for (let i = 0; i < 10; i++) assert.equal((await login(s, { password: 'wrong' + i })).status, 401);
    assert.equal((await login(s)).status, 429, 'a stranger without the device token is paused, even with the right password');
    const known = await login(s, {}, { 'x-device-token': first.data.device_token });
    assert.equal(known.status, 200, 'the owner\'s own browser is let through');
    assert.equal((await login(s, { password: 'wrong' }, { 'x-device-token': first.data.device_token })).status, 401, 'the password is still checked');
    assert.equal((await login(s, { password: 'wrong' }, { 'x-device-token': 'f'.repeat(64) })).status, 429, 'a made-up device token gets no pass');
  } finally { s.stop(); }
});

test('item 11: failures from many addresses cannot lock the owner\'s known browser out', async () => {
  const s = await startServer({ TRUST_PROXY: '1' });
  try {
    const first = await login(s, {}, { 'x-forwarded-for': '203.0.113.1' });
    for (let i = 0; i < 65; i++) await login(s, { password: 'bad' }, { 'x-forwarded-for': `198.51.100.${(i % 250) + 1}` });
    assert.equal((await login(s, {}, { 'x-forwarded-for': '192.0.2.77' })).status, 429, 'everyone else is paused by the overall ceiling');
    assert.equal((await login(s, {}, { 'x-forwarded-for': '192.0.2.77', 'x-device-token': first.data.device_token })).status, 200);
  } finally { s.stop(); }
});

test('item 12: junk tokens from one address cannot block a real session from that address', async () => {
  const s = await startServer();
  try {
    const { data } = await login(s);
    let blocked = false;
    for (let i = 0; i < 70; i++) if ((await s.j('GET', '/api/admin/status', undefined, tok('junk' + i))).status === 429) blocked = true;
    assert.equal(blocked, true, 'junk tokens are still limited');
    assert.equal((await s.j('GET', '/api/admin/status', undefined, tok(data.token))).status, 200, 'but the real session still works');
  } finally { s.stop(); }
});

test('item 13: signing out everywhere and two-step setup need the password', async () => {
  const s = await startServer();
  try {
    const { data } = await login(s);
    const t = tok(data.token);
    assert.equal((await s.j('POST', '/api/admin/2fa/start', {}, t)).status, 400);
    assert.equal((await s.j('POST', '/api/admin/2fa/start', { password: 'wrong' }, t)).status, 400);
    assert.equal((await s.j('POST', '/api/admin/2fa/enable', { code: '123456' }, t)).status, 400);
    assert.equal((await s.j('POST', '/api/admin/logout-all', {}, t)).status, 400);
    assert.equal((await s.j('GET', '/api/admin/status', undefined, t)).status, 200, 'a refused request changes nothing');
    assert.equal((await s.j('POST', '/api/admin/logout-all', { password: PASSWORD }, t)).status, 200);
    assert.equal((await s.j('GET', '/api/admin/status', undefined, t)).status, 401);
  } finally { s.stop(); }
});

test('items 13, 15 and 19: with two-step on, actions need a fresh code; a used code is refused; free password tests are over', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const { token, secret } = await signInWithTwoStep(s);
    const t = tok(token);
    // 13: password alone is not enough to sign out everywhere
    assert.equal((await s.j('POST', '/api/admin/logout-all', { password: PASSWORD }, t)).status, 400);
    // 15: the code used to turn two-step on cannot be used again to turn it off
    const used = code(secret, -1);
    assert.equal((await s.j('POST', '/api/admin/2fa/disable', { password: PASSWORD, code: used }, t)).status, 400, 'an already-used code is refused');
    assert.equal((await s.j('POST', '/api/admin/2fa/disable', { password: 'wrong', code: code(secret, 0) }, t)).status, 400);
    assert.equal((await s.j('GET', '/api/admin/status', undefined, t)).data.two_step, true, 'still on after refusals');
    assert.equal((await s.j('POST', '/api/admin/2fa/disable', { password: PASSWORD, code: code(secret, 1) }, t)).status, 200);
    assert.equal((await s.j('GET', '/api/admin/status', undefined, t)).data.two_step, false);
  } finally { s.stop(); }
  // 19: a right password with no code is counted
  const s2 = await startServer();
  try {
    await signInWithTwoStep(s2);
    const seen = [];
    for (let i = 0; i < 12; i++) seen.push((await login(s2)).status);
    assert.equal(seen[0], 200); assert.equal(seen.includes(429), true, seen.join());
  } finally { s2.stop(); }
});

test('item 14: changing the password signs every old session out', async () => {
  const s = await startServer();
  let again;
  try {
    const { data } = await login(s);
    assert.equal((await s.j('GET', '/api/admin/status', undefined, tok(data.token))).status, 200);
    s.stop(true);
    again = await startServer({ DATA_DIR: s.dir, ADMIN_PASSWORD: 'a-brand-new-Strong-pass-77!' });
    assert.equal((await again.j('GET', '/api/admin/status', undefined, tok(data.token))).status, 401, 'the old session no longer works');
    const fresh = await again.j('POST', '/api/admin/login', { password: 'a-brand-new-Strong-pass-77!' });
    assert.equal(fresh.status, 200);
    assert.equal((await again.j('GET', '/api/admin/status', undefined, tok(fresh.data.token))).status, 200, 'a new sign-in works');
    again.stop(true);
    const sameAgain = await startServer({ DATA_DIR: s.dir, ADMIN_PASSWORD: 'a-brand-new-Strong-pass-77!' });
    try { assert.equal((await sameAgain.j('GET', '/api/admin/status', undefined, tok(fresh.data.token))).status, 200, 'a restart with the same password keeps sessions'); }
    finally { sameAgain.stop(); }
  } finally { try { if (again) again.stop(); } catch { /* ignore */ } try { fs.rmSync(s.dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});
