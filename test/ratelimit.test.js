'use strict';
// Run with: npm test. Checks the rate limiter's memory limits (review item 7).
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter } = require('../ratelimit');

const clock = () => { let t = 1_000_000; return { now: () => t, tick: (ms) => { t += ms; } }; };

test('counts hits inside the window and forgets old ones', () => {
  const c = clock(); const rl = createLimiter({ now: c.now });
  for (let i = 0; i < 5; i++) rl.add('a');
  assert.equal(rl.count('a', 60e3), 5);
  c.tick(61e3);
  assert.equal(rl.count('a', 60e3), 0);
  assert.equal(rl.count('never-seen', 60e3), 0);
  assert.equal(rl.size(), 1, 'asking about an unknown key must not create an entry');
});

test('the table cannot grow past its size cap (200,000 junk visitors)', () => {
  const rl = createLimiter({ maxKeys: 50000 });
  for (let i = 0; i < 200000; i++) rl.add('flood:' + i);
  assert.ok(rl.size() <= 50000, `size was ${rl.size()}`);
  rl.add('flood:newest'); assert.equal(rl.count('flood:newest', 60e3), 1);
});

test('a short-window entry is swept after its own window, not 25 hours', () => {
  const c = clock(); const rl = createLimiter({ now: c.now });
  rl.add('flood:1'); rl.count('flood:1', 60e3);   // counted over one minute
  rl.add('regday:1'); rl.count('regday:1', 24 * 3600e3);
  c.tick(5 * 60e3); rl.sweep();
  assert.equal(rl.size(), 1, 'the one-minute entry should be gone, the one-day entry kept');
  assert.equal(rl.count('regday:1', 24 * 3600e3), 1);
  c.tick(25 * 3600e3); rl.sweep();
  assert.equal(rl.size(), 0);
});

test('one entry cannot hold unlimited hits, and limits above the cap still work up to it', () => {
  const rl = createLimiter({ maxPerKey: 1000 });
  for (let i = 0; i < 5000; i++) rl.add('x');
  assert.equal(rl.count('x', 60e3), 1000);
});

test('never-counted entries are swept after the default window', () => {
  const c = clock(); const rl = createLimiter({ now: c.now });
  rl.add('only-added');
  c.tick(24 * 3600e3); rl.sweep(); assert.equal(rl.size(), 1);
  c.tick(2 * 3600e3); rl.sweep(); assert.equal(rl.size(), 0);
});
