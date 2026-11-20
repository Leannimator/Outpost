'use strict';
// Run with: npm test. Checks the Marketing tab's step 2 server side: gallery photos (a separate set), posts, the public Gallery, reordering, and "Ready to post".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { startServer, PASSWORD } = require('./helpers');

const open = (s) => new Database(path.join(s.dir, 'outpost.db'));
async function admin(s) { const { data } = await s.j('POST', '/api/admin/login', { password: PASSWORD }); const t = { 'x-admin-token': data.token }; return { t, post: (u, b) => s.j('POST', u, b, t), put: (u, b) => s.j('PUT', u, b, t), del: (u) => s.j('DELETE', u, undefined, t), get: (u) => s.j('GET', u, undefined, t) }; }
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function upload(s, a) { const r = await fetch(s.base + '/api/admin/upload', { method: 'POST', headers: { 'content-type': 'image/png', 'x-admin-token': a.t['x-admin-token'] }, body: PNG }); return (await r.json()).url; }
async function photo(s, a) { const url = await upload(s, a); const r = await a.post('/api/admin/marketing/photos', { url }); assert.equal(r.status, 200, JSON.stringify(r.data)); return url; }
const HOUR = 3600e3;

test('gallery photos are their own set: a post can only use registered gallery photos, never a product photo', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    assert.equal((await s.j('GET', '/api/admin/marketing/photos')).status, 401, 'owner only');
    const a = await admin(s);
    const productPhoto = await upload(s, a);                                   // uploaded but never registered as a gallery photo
    const g = await photo(s, a);
    assert.equal((await a.post('/api/admin/marketing/posts', { caption: 'x', photos: [productPhoto] })).status, 400, 'an unregistered (product) photo is refused');
    assert.equal((await a.post('/api/admin/marketing/posts', { caption: 'x', photos: ['/images/../../etc/passwd'] })).status, 400, 'odd addresses are refused');
    assert.equal((await a.post('/api/admin/marketing/photos', { url: '/images/nope.png' })).status, 404, 'a photo that is not on disk cannot be registered');
    assert.equal((await a.post('/api/admin/marketing/photos', { url: 'https://evil.example/x.png' })).status, 400, 'only your own photos');
    const ok = await a.post('/api/admin/marketing/posts', { caption: 'Hello', photos: [g] });
    assert.equal(ok.status, 200); assert.deepEqual(ok.data.photos, [g]);
    assert.equal((await a.del('/api/admin/marketing/photos/' + (await a.get('/api/admin/marketing/photos')).data[0].id)).status, 409, 'a photo in use cannot be deleted');
    // The unused-photo cleanup must never treat gallery photos as unused.
    const cl = await a.post('/api/admin/images/cleanup', { delete: true });
    assert.equal(cl.status, 200);
    assert.ok(fs.existsSync(path.join(s.dir, 'images', g.slice('/images/'.length))), 'a gallery photo survives the cleanup');
    assert.ok(!fs.existsSync(path.join(s.dir, 'images', productPhoto.slice('/images/'.length))), 'an unused, unregistered photo is cleaned up');
  } finally { s.stop(); }
});

test('posts: drafts need nothing, scheduling needs a time, a photo and a destination; limits and owner-only', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    assert.equal((await s.j('POST', '/api/admin/marketing/posts', { caption: 'x' })).status, 401);
    const a = await admin(s); const g = await photo(s, a);
    const d = await a.post('/api/admin/marketing/posts', { caption: 'A draft' });
    assert.equal(d.status, 200); assert.equal(d.data.status, 'draft'); assert.equal(d.data.scheduled_at, null);
    assert.equal((await a.put('/api/admin/marketing/posts/' + d.data.id, { status: 'scheduled' })).status, 400, 'no time yet');
    assert.equal((await a.put('/api/admin/marketing/posts/' + d.data.id, { status: 'scheduled', scheduled_at: Date.now() + HOUR })).status, 400, 'no photo yet');
    assert.equal((await a.put('/api/admin/marketing/posts/' + d.data.id, { status: 'scheduled', scheduled_at: Date.now() + HOUR, photos: [g], to_gallery: false })).status, 400, 'no destination');
    assert.equal((await a.put('/api/admin/marketing/posts/' + d.data.id, { status: 'scheduled', scheduled_at: 12, photos: [g] })).status, 400, 'a silly date');
    const sc = await a.put('/api/admin/marketing/posts/' + d.data.id, { status: 'scheduled', scheduled_at: Date.now() + HOUR, photos: [g] });
    assert.equal(sc.status, 200); assert.equal(sc.data.status, 'scheduled'); assert.equal(sc.data.to_gallery, true, 'the gallery is on by default');
    assert.equal((await a.post('/api/admin/marketing/posts', { caption: 'x'.repeat(2201) })).status, 400, 'caption limit');
    assert.equal((await a.post('/api/admin/marketing/posts', { photos: Array(11).fill(g) })).status, 400, 'ten photos at most');
    assert.equal((await a.post('/api/admin/marketing/posts', { link_code: 'nope' })).status, 400, 'an unknown tracked link');
    assert.equal((await a.post('/api/admin/marketing/posts', { product_id: 999 })).status, 400, 'an unknown product');
    const l = (await a.post('/api/admin/marketing/links', { name: 'Gallery post' })).data;
    const withLink = await a.post('/api/admin/marketing/posts', { caption: 'L', link_code: l.code.toUpperCase() });
    assert.equal(withLink.data.link_code, l.code, 'the canonical link code is saved');
    assert.equal((await a.del('/api/admin/marketing/posts/' + withLink.data.id)).status, 200);
    assert.equal((await a.del('/api/admin/marketing/posts/' + withLink.data.id)).status, 404);
    assert.equal((await a.put('/api/admin/marketing/posts/9999', { caption: 'x' })).status, 404);
  } finally { s.stop(); }
});

test('the public Gallery shows only posts whose time has come, switched on, not hidden, with a Shop this link', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s); const dbh = open(s); const g = await photo(s, a);
    assert.equal((await s.j('GET', '/api/gallery')).status, 404, 'off by default');
    assert.equal((await a.put('/api/admin/marketing/gallery', { on: true })).data.gallery_on, true);
    assert.equal((await s.j('GET', '/api/settings')).data.gallery_on, true, 'the shop pages learn it is on');
    const pid = Number(dbh.prepare("INSERT INTO products (name, price_cents, stock, active) VALUES ('Blue frog',2500,3,1)").run().lastInsertRowid);
    const mk = async (extra) => (await a.post('/api/admin/marketing/posts', { photos: [g], status: 'scheduled', ...extra })).data;
    const past = await mk({ caption: 'past', scheduled_at: Date.now() - HOUR, product_id: pid });
    await mk({ caption: 'future', scheduled_at: Date.now() + 24 * HOUR });
    const hid = await mk({ caption: 'hidden', scheduled_at: Date.now() - HOUR });
    await a.put('/api/admin/marketing/posts/' + hid.id, { hidden: true });
    await mk({ caption: 'ig only', scheduled_at: Date.now() - HOUR, to_gallery: false, to_instagram: true });
    await a.post('/api/admin/marketing/posts', { caption: 'draft', photos: [g] });
    const r = await s.j('GET', '/api/gallery');
    assert.equal(r.status, 200); assert.deepEqual(r.data.posts.map((p) => p.caption), ['past'], 'only the live, visible gallery post');
    assert.equal(r.data.posts[0].shop.name, 'Blue frog'); assert.match(r.data.posts[0].shop.url, /^\/shop\?p=\d+$/);
    assert.ok(!JSON.stringify(r.data).includes('hidden') && !('to_instagram' in r.data.posts[0]), 'nothing private leaks');
    dbh.prepare('UPDATE products SET active = 0 WHERE id = ?').run(pid);
    assert.equal((await s.j('GET', '/api/gallery')).data.posts[0].shop, null, 'no Shop this button for a product that is not for sale');
    assert.equal((await a.put('/api/admin/marketing/gallery', { on: false })).data.gallery_on, false);
    assert.equal((await s.j('GET', '/api/gallery')).status, 404, 'switched off again');
    void past; dbh.close();
  } finally { s.stop(); }
});

test('reordering and pinning: the owner\'s order is kept, pinned posts stay on top, bad orders are refused', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s); const g = await photo(s, a);
    await a.put('/api/admin/marketing/gallery', { on: true });
    const ids = [];
    for (const c of ['one', 'two', 'three']) ids.push((await a.post('/api/admin/marketing/posts', { caption: c, photos: [g], status: 'scheduled', scheduled_at: Date.now() - HOUR })).data.id);
    const names = async () => (await s.j('GET', '/api/gallery')).data.posts.map((p) => p.caption);
    assert.deepEqual(await names(), ['three', 'two', 'one'], 'newest first by default');
    assert.equal((await a.post('/api/admin/marketing/posts/order', { ids: [ids[0], ids[1], ids[2]] })).status, 200);
    assert.deepEqual(await names(), ['one', 'two', 'three'], 'the dragged order is kept');
    await a.put('/api/admin/marketing/posts/' + ids[2], { pinned: true });
    assert.deepEqual(await names(), ['three', 'one', 'two'], 'a pinned post stays on top');
    assert.equal((await a.post('/api/admin/marketing/posts/order', { ids: [ids[0], ids[0]] })).status, 400, 'duplicates refused');
    assert.equal((await a.post('/api/admin/marketing/posts/order', { ids: [ids[0], 999] })).status, 400, 'unknown posts refused');
    assert.equal((await a.post('/api/admin/marketing/posts/order', { ids: 'nope' })).status, 400);
    const n = (await a.post('/api/admin/marketing/posts', { caption: 'newest', photos: [g], status: 'scheduled', scheduled_at: Date.now() - HOUR })).data;
    assert.equal((await names())[1], 'newest', 'a new post goes to the top (under pinned ones)'); void n;
  } finally { s.stop(); }
});

test('Ready to post: due Instagram and Facebook posts, marking posted, and moving a post un-marks it', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s); const g = await photo(s, a);
    const l = (await a.post('/api/admin/marketing/links', { name: 'IG post' })).data;
    const mk = async (extra) => (await a.post('/api/admin/marketing/posts', { photos: [g], status: 'scheduled', ...extra })).data;
    const due = await mk({ caption: 'due', scheduled_at: Date.now() - HOUR, to_instagram: true, link_code: l.code });
    await mk({ caption: 'later', scheduled_at: Date.now() + 5 * HOUR, to_instagram: true });
    await mk({ caption: 'gallery only', scheduled_at: Date.now() - HOUR });
    await mk({ caption: 'facebook', scheduled_at: Date.now() - 2 * HOUR, to_facebook: true });
    let r = (await a.get('/api/admin/marketing/due')).data;
    assert.equal(r.count, 2); assert.deepEqual(r.due.map((p) => p.caption), ['facebook', 'due'], 'oldest first');
    assert.match(r.due[1].url, /\/shop\?s=/, 'the tracked link comes with it, ready to copy');
    assert.equal((await a.post('/api/admin/marketing/posts/' + due.id + '/posted', {})).status, 200);
    r = (await a.get('/api/admin/marketing/due')).data;
    assert.equal(r.count, 1); assert.deepEqual(r.done.map((p) => p.caption), ['due']);
    assert.equal((await a.post('/api/admin/marketing/posts/' + due.id + '/posted', { posted: false })).status, 200, 'it can be un-marked');
    assert.equal((await a.get('/api/admin/marketing/due')).data.count, 2);
    await a.post('/api/admin/marketing/posts/' + due.id + '/posted', {});
    await a.put('/api/admin/marketing/posts/' + due.id, { scheduled_at: Date.now() + 9 * HOUR });
    assert.equal((await a.get('/api/admin/marketing/due')).data.done.length, 0, 'moving a post to a later time clears "posted"');
    assert.equal((await a.post('/api/admin/marketing/posts/999/posted', {})).status, 404);
    assert.equal((await s.j('GET', '/api/admin/marketing/due')).status, 401, 'owner only');
  } finally { s.stop(); }
});

test('the Gallery page is served, counted as a visit for a tracked link, and the shop menu learns about it', { timeout: 60000 }, async () => {
  const s = await startServer();
  try {
    const a = await admin(s);
    const l = (await a.post('/api/admin/marketing/links', { name: 'Bio link', dest: '/gallery' })).data;
    const r = await fetch(s.base + '/gallery?s=' + l.code, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/120' } });
    assert.equal(r.status, 200); assert.match(await r.text(), /gal-grid|Gallery/);
    const dbh = open(s); const row = dbh.prepare('SELECT SUM(visits) v FROM link_visits WHERE code = ?').get(l.code); dbh.close();
    assert.equal(row.v, 1, 'one real page load of /gallery counted for the link');
    assert.equal((await s.j('GET', '/api/settings')).data.gallery_on, false);
  } finally { s.stop(); }
});
