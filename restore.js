'use strict';
// "Restore from a backup": the screen unpacks the backup file in the browser and sends the database and each photo to the shop,
// which keeps them in a staging folder. Nothing in the live shop changes until the owner finishes; then the shop stops, and on its
// next start (Render restarts it by itself) applyPending() swaps the staged files in BEFORE the database is opened.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DAY = 24 * 3600e3;
const stagingDir = (dbFile) => path.join(path.dirname(dbFile), 'restore-staging');
const markerFile = (dbFile) => path.join(stagingDir(dbFile), 'ready.json');
const doneFile = (dbFile) => path.join(path.dirname(dbFile), 'restore-done.json');
const SAFE_NAME = /^[\w.-]{1,120}$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;

const sha256 = (file) => { const h = crypto.createHash('sha256'); const fd = fs.openSync(file, 'r'); try { const buf = Buffer.alloc(1 << 20); let n; while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { fs.closeSync(fd); } return h.digest('hex'); };
const copyThenReplace = (from, to) => { const tmp = to + '.restoring'; fs.copyFileSync(from, tmp); try { fs.chmodSync(tmp, 0o600); } catch { /* not supported here */ } fs.renameSync(tmp, to); };   // the old file is only replaced once the whole new copy is in place

// Runs at start-up, before the database is opened. Never leaves the shop without a database: on any problem the shop starts with what it had.
function applyPending({ dbFile, imagesDir, log = console }) {
  const marker = markerFile(dbFile);
  if (!fs.existsSync(marker)) return false;
  let info;
  try {
    info = JSON.parse(fs.readFileSync(marker, 'utf8'));
    const dir = stagingDir(dbFile);
    const staged = path.join(dir, 'outpost.db');
    if (fs.existsSync(staged)) {
      if (fs.statSync(staged).size !== info.db_bytes || sha256(staged) !== info.db_sha256) throw new Error('the staged database is incomplete');
    }
    for (const im of info.images || []) {
      const p = path.join(dir, 'images', im.name);
      if (!SAFE_NAME.test(im.name) || !fs.existsSync(p) || fs.statSync(p).size !== im.bytes) throw new Error('a staged photo is missing or incomplete: ' + im.name);
    }
    fs.mkdirSync(imagesDir, { recursive: true });
    for (const im of info.images || []) copyThenReplace(path.join(dir, 'images', im.name), path.join(imagesDir, im.name));
    if (fs.existsSync(staged)) {
      // Keep what the shop had, so a restore can be undone: the old database (with its journal, if it has one) is saved next to it.
      const alreadyIn = fs.existsSync(dbFile) && fs.statSync(dbFile).size === info.db_bytes && sha256(dbFile) === info.db_sha256;   // an earlier try got this far before stopping
      if (fs.existsSync(dbFile) && !alreadyIn) {
        const keep = dbFile + '.before-restore';
        for (const sfx of ['', '-wal', '-shm']) { try { fs.rmSync(keep + sfx, { force: true }); } catch { /* ignore */ } }
        for (const sfx of ['', '-wal', '-shm']) if (fs.existsSync(dbFile + sfx)) { fs.copyFileSync(dbFile + sfx, keep + sfx); try { fs.chmodSync(keep + sfx, 0o600); } catch { /* ignore */ } }
      }
      if (!alreadyIn) copyThenReplace(staged, dbFile);
      for (const sfx of ['-wal', '-shm']) { try { fs.rmSync(dbFile + sfx, { force: true }); } catch { /* ignore */ } }   // the old journal must never be applied to the new file
    }
    fs.writeFileSync(doneFile(dbFile), JSON.stringify({ at: Date.now(), products: info.products, orders: info.orders, photos: (info.images || []).length }));
    fs.rmSync(dir, { recursive: true, force: true });
    log.log(`Outpost: restored from a backup (${info.products} products, ${info.orders} orders, ${(info.images || []).length} photos). The previous database was saved as ${path.basename(dbFile)}.before-restore.`);
    return true;
  } catch (e) {
    log.error('Outpost: the restore could not be finished, so the shop is starting with its current data. ' + (e && e.message));
    try { fs.renameSync(marker, marker + '.failed'); } catch { /* ignore */ }   // do not try again on every start
    return false;
  }
}

// Old leftovers: a restore that was never finished, and the saved "before" copy after 30 days (it holds customer details).
function cleanStale(dbFile) {
  try {
    const dir = stagingDir(dbFile);
    if (fs.existsSync(dir) && Date.now() - fs.statSync(dir).mtimeMs > DAY) fs.rmSync(dir, { recursive: true, force: true });
    for (const sfx of ['', '-wal', '-shm']) { const f = dbFile + '.before-restore' + sfx; if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs > 30 * DAY) fs.rmSync(f, { force: true }); }
  } catch { /* housekeeping must never stop the shop */ }
}

// Looks inside a staged database without changing it. Returns the facts the screen shows, or throws a plain-words reason.
function inspectDatabase(Database, file, maxVersion) {
  let d;
  try {
    d = new Database(file, { readonly: true, fileMustExist: true });
    const header = fs.readFileSync(file).subarray(0, 16).toString('latin1');
    if (header !== 'SQLite format 3\0') throw new Error('not a database');
    if (d.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('damaged');
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of ['products', 'orders', 'order_items', 'settings']) if (!tables.has(t)) throw new Error('not an Outpost backup');
    const version = d.pragma('user_version', { simple: true });
    if (version > maxVersion) return { error: 'This backup was made by a newer version of Outpost than the one running here. Update your shop first, then try again.' };
    return { products: d.prepare('SELECT COUNT(*) c FROM products').get().c, orders: d.prepare('SELECT COUNT(*) c FROM orders').get().c };
  } catch (e) {
    return { error: 'That file is not an Outpost backup, or it is damaged. Nothing was changed.' };
  } finally { try { if (d) d.close(); } catch { /* ignore */ } }
}

module.exports = { applyPending, cleanStale, inspectDatabase, stagingDir, markerFile, doneFile, SAFE_NAME, IMAGE_EXT, sha256 };
