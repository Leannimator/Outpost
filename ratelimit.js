'use strict';
// Tiny in-memory rate limiter. Memory is bounded three ways so strangers can't fill the server:
//  1. an entry disappears once its own time window has passed (sweep),
//  2. each entry holds a limited number of hits,
//  3. the whole table has a size cap, and the oldest entries go first.
function createLimiter({ maxKeys = 50000, maxPerKey = 10000, defaultWindow = 25 * 3600e3, now = Date.now } = {}) {
  const hits = new Map();   // key -> { ts: [times], win: longest window this key has been counted over (0 = not counted yet) }

  const count = (key, windowMs) => {
    const e = hits.get(key);
    if (!e) return 0;
    if (windowMs > e.win) e.win = windowMs;
    const t = now();
    e.ts = e.ts.filter((x) => t - x < windowMs);
    return e.ts.length;
  };

  const add = (key) => {
    let e = hits.get(key);
    if (!e) {
      if (hits.size >= maxKeys) {
        let n = Math.ceil(maxKeys / 10);
        for (const k of hits.keys()) { hits.delete(k); if (--n <= 0) break; }
      }
      e = { ts: [], win: 0 };
      hits.set(key, e);
    }
    e.ts.push(now());
    if (e.ts.length > maxPerKey) e.ts.splice(0, e.ts.length - maxPerKey);
  };

  const sweep = () => {
    const t = now();
    for (const [k, e] of hits) if (!e.ts.length || t - e.ts[e.ts.length - 1] > (e.win || defaultWindow)) hits.delete(k);
  };

  return { count, add, sweep, size: () => hits.size };
}

module.exports = { createLimiter };
