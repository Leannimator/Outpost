'use strict';
// Run with: npm test. Checks "Restore from a backup": a real backup from one shop is restored onto another, nothing changes until the shop restarts,
// bad files are refused without changing anything, and a damaged restore can never leave the shop without its data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const Database = require('better-sqlite3');
const Restore = require('../restore');
const { startServer, PASSWORD, sleep } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'outpost-rs-'));
const open = (dir) => new Database(path.join(dir, 'outpost.db'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, get: (u) => s.j('GET', u, undefined, t), post: (u, b) => s.j('POST', u, b, t) }; }
const putRaw = async (s, a, url, body, type = 'application/octet-stream') => { const r = await fetch(s.base + url, { method: 'PUT', headers: { ...a.t, 'content-type': type }, body }); return { status: r.status, data: await r.json().catch(() => ({})) }; };
const untar = (gz) => {   // a small tar reader, written separately from the app's so the test does not just agree with itself
  const buf = zlib.gunzipSync(gz), out = new Map(); let o = 0;
  while (o + 512 <= buf.length) {
    const h = buf.subarray(o, o + 512); if (h.every((x) => x === 0)) break;
    const name = h.toString('utf8', 0, 100).replace(/\0.*$/s, ''), size = parseInt(h.toString('utf8', 124, 135), 8);
    out.set(name, buf.subarray(o + 512, o + 512 + size)); o += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
};
const exited = async (s, ms = 8000) => { for (let t = 0; t < ms; t += 100) { if (!s.alive()) return true; await sleep(100); } return false; };

async function makeBackup() {
  const A = await startServer();
  try {
    const dbh = open(A.dir);
    dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Frog print', 1800, 4, 1), ('Moth tee', 3000, 2, 1)").run();
    dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('store_name', 'Restored Shop')").run();
    dbh.close();
    const a = await admin(A);
    const up = await fetch(A.base + '/api/admin/upload', { method: 'POST', headers: { ...a.t, 'content-type': 'image/png' }, body: PNG });
    const imageName = (await up.json()).url.replace('/images/', '');
    const d2 = open(A.dir); d2.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('totp_secret', 'ABCDEFGH')").run(); d2.close();   // two-step is on: the backup must leave the secret out
    const r = await fetch(A.base + '/api/admin/backup', { headers: a.t });
    return { gz: Buffer.from(await r.arrayBuffer()), imageName };
  } finally { A.stop(); }
}
async function stage(s, a, files, id) {
  const db = await putRaw(s, a, `/api/admin/restore/${id}/db`, files.get('outpost.db'));
  assert.equal(db.status, 200, JSON.stringify(db.data));
  for (const [n, b] of files) if (n.startsWith('images/')) assert.equal((await putRaw(s, a, `/api/admin/restore/${id}/image/${n.slice(7)}`, b)).status, 200);
  return db.data;
}

test('restore: a real backup is restored onto another shop, and nothing changes until the shop restarts', { timeout: 120000 }, async () => {
  const { gz, imageName } = await makeBackup();
  const dirB = tmp();
  const B = await startServer({ DATA_DIR: dirB });
  let C;
  try {
    const dbh = open(dirB);
    dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Other thing', 500, 1, 1)").run();
    dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('store_name', 'Other Shop')").run();
    dbh.close();
    fs.writeFileSync(path.join(dirB, 'images', 'keepme.png'), PNG);
    const a = await admin(B);
    assert.equal((await fetch(B.base + '/api/admin/restore/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401, 'needs a sign-in');
    assert.equal((await a.post('/api/admin/restore/start', { password: 'wrong' })).status, 400, 'needs the right password');
    const start = (await a.post('/api/admin/restore/start', { password: PASSWORD })).data;
    assert.ok(start.id && start.have.some((h) => h.name === 'keepme.png'), 'it says which photos the shop already has');
    const files = untar(gz);
    assert.ok(files.has('outpost.db') && files.has('images/' + imageName));
    const info = await stage(B, a, files, start.id);
    assert.deepEqual(info, { products: 2, orders: 0 });
    // staged, not applied: the shop is still the old one
    assert.equal((await B.j('GET', '/api/settings')).data.store_name, 'Other Shop');
    const fin = (await a.post(`/api/admin/restore/${start.id}/finish`, {})).data;
    assert.equal(fin.ok, true); assert.equal(fin.products, 2);
    assert.ok(await exited(B), 'the shop stops after finishing, so it can start with the restored files');
    const live = open(dirB); assert.equal(live.prepare("SELECT value FROM settings WHERE key='store_name'").get().value, 'Other Shop', 'still the old data on disk until the restart'); live.close();
    // restart on the same folder
    C = await startServer({ DATA_DIR: dirB });
    assert.equal((await C.j('GET', '/api/settings')).data.store_name, 'Restored Shop');
    const a2 = await admin(C);
    const sec = (await a2.get('/api/admin/security')).data;
    assert.ok(sec.staff.some((e) => e.kind === 'admin_restore'), 'the restore is written in the log');
    assert.equal((await C.j('GET', '/api/admin/status', undefined, a2.t)).data.two_step, false, 'two-step sign-in is off after a restore');
    assert.equal((await fetch(C.base + '/images/' + imageName)).status, 200, 'the restored photo is served');
    assert.ok(fs.existsSync(path.join(dirB, 'images', 'keepme.png')), 'photos the shop already had are kept');
    assert.ok(!fs.existsSync(path.join(dirB, 'restore-staging')), 'the staging folder is cleaned up');
    assert.equal((await C.j('GET', '/api/admin/status', undefined, a.t)).status, 401, 'old sign-ins are gone (they were not in the backup)');
    C.stop(); C = null;
    const kept = new Database(path.join(dirB, 'outpost.db.before-restore'), { readonly: true });
    assert.equal(kept.prepare("SELECT value FROM settings WHERE key='store_name'").get().value, 'Other Shop', 'the previous database is saved, so a restore can be undone');
    kept.close();
    assert.equal(fs.statSync(path.join(dirB, 'outpost.db.before-restore')).mode & 0o077, 0, 'the saved copy is private');
  } finally { B.stop(); if (C) C.stop(); fs.rmSync(dirB, { recursive: true, force: true }); }
});

test('restore: wrong passwords, wrong files and unsafe photos are refused, and nothing in the live shop changes', { timeout: 120000 }, async () => {
  const { gz } = await makeBackup();
  const S = await startServer();
  try {
    const a = await admin(S);
    const live = () => S.j('GET', '/api/settings').then((r) => r.data.store_name);
    const before = await live();
    assert.equal((await a.post('/api/admin/restore/someid/finish', {})).status, 409, 'no restore is open');
    const { id } = (await a.post('/api/admin/restore/start', { password: PASSWORD })).data;
    assert.equal((await putRaw(S, a, '/api/admin/restore/wrongid/db', Buffer.from('x'))).status, 409, 'a wrong restore id is refused');
    assert.equal((await a.post(`/api/admin/restore/${id}/finish`, {})).status, 400, 'cannot finish before the database is sent');
    assert.equal((await putRaw(S, a, `/api/admin/restore/${id}/db`, Buffer.from('not a database at all'))).status, 400, 'junk is refused');
    const plain = new Database(path.join(tmp(), 'x.db')); plain.exec('CREATE TABLE t (a)'); const plainFile = plain.name; plain.close();
    assert.equal((await putRaw(S, a, `/api/admin/restore/${id}/db`, fs.readFileSync(plainFile))).status, 400, 'a database that is not Outpost\'s is refused');
    const newer = tmp(); const f = path.join(newer, 'o.db'); fs.writeFileSync(f, untar(gz).get('outpost.db')); const nd = new Database(f); nd.pragma('user_version = 99'); nd.close();
    const nr = await putRaw(S, a, `/api/admin/restore/${id}/db`, fs.readFileSync(f));
    assert.equal(nr.status, 400); assert.match(nr.data.error, /newer version/);
    assert.ok([400, 413].includes((await putRaw(S, a, `/api/admin/restore/${id}/db`, untar(gz).get('outpost.db'), 'application/json')).status), 'only a plain upload is accepted (the shop\'s JSON reader turns this one away first)');
    assert.equal((await a.post(`/api/admin/restore/${id}/finish`, {})).status, 400, 'still nothing staged');
    assert.equal((await putRaw(S, a, `/api/admin/restore/${id}/db`, untar(gz).get('outpost.db'))).status, 200, 'the real one is accepted');
    for (const [name, body, why] of [['..%2Fevil.png', PNG, 'a path trick'], ['notes.txt', PNG, 'not an image name'], ['a.png', Buffer.from('this is not an image at all'), 'not really an image'], ['bad.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'an SVG with a script'], ['.hidden.png', PNG, 'a hidden name']]) {
      const rr = await putRaw(S, a, `/api/admin/restore/${id}/image/${name}`, body); assert.equal(rr.status, 400, why + ' -> ' + JSON.stringify(rr.data));
    }
    assert.ok(fs.readdirSync(path.join(S.dir, 'restore-staging', 'images')).length === 0, 'none of the refused photos were kept');
    assert.equal((await a.get('/api/admin/status')).status, 200);
    assert.equal((await fetch(S.base + '/api/admin/restore/' + id, { method: 'DELETE', headers: a.t })).status, 200, 'cancelling works');
    assert.ok(!fs.existsSync(path.join(S.dir, 'restore-staging')), 'and clears the staging folder');
    assert.equal(await live(), before, 'the live shop never changed');
    assert.ok(S.alive(), 'and the shop kept running');
  } finally { S.stop(); }
});

test('restore: a damaged staging folder is ignored at start-up, and the shop keeps its data', { timeout: 120000 }, async () => {
  const { gz } = await makeBackup();
  const dir = tmp();
  const S = await startServer({ DATA_DIR: dir });
  let T;
  try {
    const dbh = open(dir); dbh.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('store_name', 'Keep Me')").run(); dbh.close();
    const a = await admin(S);
    const { id } = (await a.post('/api/admin/restore/start', { password: PASSWORD })).data;
    await stage(S, a, untar(gz), id);
    await a.post(`/api/admin/restore/${id}/finish`, {});
    assert.ok(await exited(S));
    fs.appendFileSync(path.join(dir, 'restore-staging', 'outpost.db'), 'damage');
    T = await startServer({ DATA_DIR: dir });
    assert.equal((await T.j('GET', '/api/settings')).data.store_name, 'Keep Me', 'the shop starts with the data it had');
    assert.ok(fs.existsSync(path.join(dir, 'restore-staging', 'ready.json.failed')), 'the bad restore is set aside, not retried on every start');
  } finally { S.stop(); if (T) T.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('restore: stopping part-way through the swap loses nothing, and finishing again is safe', () => {
  const dir = tmp(); const dbFile = path.join(dir, 'outpost.db'); const imagesDir = path.join(dir, 'images');
  const mk = (file, name) => { const d = new Database(file); d.exec('CREATE TABLE products (id INTEGER); CREATE TABLE orders (id INTEGER); CREATE TABLE order_items (id INTEGER); CREATE TABLE settings (key TEXT, value TEXT)'); d.prepare('INSERT INTO settings VALUES (?,?)').run('store_name', name); d.pragma('journal_mode = DELETE'); d.close(); };
  mk(dbFile, 'old');
  const st = Restore.stagingDir(dbFile); fs.mkdirSync(path.join(st, 'images'), { recursive: true });
  mk(path.join(st, 'outpost.db'), 'new'); fs.writeFileSync(path.join(st, 'images', 'p.png'), PNG);
  fs.writeFileSync(Restore.markerFile(dbFile), JSON.stringify({ db_bytes: fs.statSync(path.join(st, 'outpost.db')).size, db_sha256: Restore.sha256(path.join(st, 'outpost.db')), products: 0, orders: 0, images: [{ name: 'p.png', bytes: PNG.length }] }));
  const quiet = { log() {}, error() {} };
  // pretend an earlier try stopped after the new database was already in place and the saved copy made
  fs.copyFileSync(dbFile, dbFile + '.before-restore'); fs.copyFileSync(path.join(st, 'outpost.db'), dbFile);
  assert.equal(Restore.applyPending({ dbFile, imagesDir, log: quiet }), true);
  const read = (f) => { const d = new Database(f, { readonly: true }); const v = d.prepare("SELECT value FROM settings WHERE key='store_name'").get().value; d.close(); return v; };
  assert.equal(read(dbFile), 'new'); assert.equal(read(dbFile + '.before-restore'), 'old', 'the saved copy of the old shop is not overwritten by a second try');
  assert.ok(fs.existsSync(path.join(imagesDir, 'p.png'))); assert.ok(!fs.existsSync(st));
  assert.equal(Restore.applyPending({ dbFile, imagesDir, log: quiet }), false, 'nothing left to do');
  fs.rmSync(dir, { recursive: true, force: true });
});
