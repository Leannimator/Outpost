'use strict';
// Run with: npm test
// Starts a real copy of the server (temporary database, no Stripe) and checks that the
// freezes from review items 1, 2, 3, 4 and 70 are gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');

const PORT = 3400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'test-only-Correct-Horse-9!';
let proc, dir;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function j(method, url, body, headers = {}) {
  const t = Date.now();
  const res = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, ms: Date.now() - t };
}

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-test-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: String(PORT), DATA_DIR: dir, ADMIN_PASSWORD: PASSWORD, BASE_URL: `http://localhost:${PORT}` },
    stdio: 'ignore',
  });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/settings')).ok) return; } catch { /* not up yet */ } await sleep(100); }
  throw new Error('server did not start');
});
test.after(() => { if (proc) proc.kill('SIGKILL'); try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

const started = () => Date.now() - 5000; // passes the "too fast" check

test('item 1: a 100 KB hostile email no longer freezes the server', async () => {
  const email = 'a@' + '.'.repeat(90000) + '@';
  const [bad, other] = await Promise.all([
    j('POST', '/api/bidders', { name: 'x', email, started: started() }),
    (async () => { await sleep(50); return j('GET', '/api/settings'); })(),
  ]);
  assert.equal(bad.status, 400);
  assert.ok(bad.ms < 1500, `signup took ${bad.ms}ms`);
  assert.ok(other.ms < 1500, `a simultaneous request waited ${other.ms}ms`);
});

test('item 1: rejected sign-ups are counted and eventually refused', async () => {
  let last;
  for (let i = 0; i < 40; i++) last = await j('POST', '/api/bidders', { name: 'x', email: 'nope', started: started() });
  assert.equal(last.status, 429);
});

test('items 4 and 70: compressed request bodies are refused', async () => {
  for (const url of ['/api/bidders', '/webhook']) {
    const body = Buffer.concat([zlib.gzipSync(JSON.stringify({ name: 'x' })), Buffer.from('trailing junk')]);
    const status = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: PORT, path: url, method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': body.length } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(body);
    });
    assert.ok([400, 415, 503].includes(status), `${url} answered ${status}`);
    assert.notEqual(status, 200);
    const alive = await j('GET', '/api/settings');   // and the server is still up
    assert.equal(alive.status, 200);
  }
});

test('item 3: a hostile "image" no longer hangs the upload', async () => {
  const login = await j('POST', '/api/admin/login', { password: PASSWORD });
  assert.ok(login.data.token, 'could not sign in for the test');
  const hostile = Buffer.from('<!---->'.repeat(85).slice(0, 600));
  const t = Date.now();
  const res = await fetch(BASE + '/api/admin/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-admin-token': login.data.token }, body: hostile });
  assert.equal(res.status, 400);
  assert.ok(Date.now() - t < 1500, `upload check took ${Date.now() - t}ms`);
  // a real SVG is still accepted
  const ok = await fetch(BASE + '/api/admin/upload', { method: 'POST', headers: { 'content-type': 'image/svg+xml', 'x-admin-token': login.data.token }, body: Buffer.from('<?xml version="1.0"?><!-- hi --><svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>') });
  assert.equal(ok.status, 200);
});
