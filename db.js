const Database = require('better-sqlite3');
const crypto = require('crypto');

const fsx = require('fs');
const pathx = require('path');
// DATA_DIR keeps the database and uploaded photos together in one folder (handy for hosts with a single persistent disk).
const DATA_DIR = process.env.DATA_DIR ? pathx.resolve(process.env.DATA_DIR) : '';
if (DATA_DIR) fsx.mkdirSync(DATA_DIR, { recursive: true });
// The database file is found the same way no matter which folder the app is started from (it used to be relative to the
// current folder, so starting from elsewhere opened an empty shop and made a new file there; review item 81).
const DB_FILE = process.env.DB_PATH ? pathx.resolve(process.env.DB_PATH) : (DATA_DIR ? pathx.join(DATA_DIR, 'outpost.db') : pathx.join(__dirname, 'pos.db'));
const db = new Database(DB_FILE);
db.dataDir = DATA_DIR;
db.file = DB_FILE;
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');     // a power cut can no longer lose the last few saved sales (it was NORMAL)
db.pragma('secure_delete = ON');     // removed rows (a deleted subscriber, an anonymised customer) are overwritten, not left in the file
// Only the app's own user may read the database, its journal files and any backup made next to it.
const lockFiles = () => { for (const f of [DB_FILE, DB_FILE + '-wal', DB_FILE + '-shm']) { try { fsx.chmodSync(f, 0o600); } catch { /* not there, or not supported here */ } } };
lockFiles();
db.pragma('foreign_keys = OFF'); // off while migrating; switched on at the bottom

const hadTables = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orders'").get();   // false on a brand-new database

// ---------- current schema (fresh installs) ----------
db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0,
  image_url TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,            -- 'register' | 'online' | 'auction'
  payment_method TEXT NOT NULL,     -- 'cash' | 'card' | 'other'
  status TEXT NOT NULL,             -- 'pending' | 'paid' | 'canceled'
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  stripe_session_id TEXT,
  customer_email TEXT,
  shipping_json TEXT,
  auction_id INTEGER,
  public_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id),   -- NULL for auction lots
  name TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  image_url TEXT,
  starting_bid_cents INTEGER NOT NULL,
  increment_cents INTEGER NOT NULL,
  start_at INTEGER NOT NULL,        -- epoch ms
  end_at INTEGER NOT NULL,          -- epoch ms
  status TEXT NOT NULL DEFAULT 'open',   -- 'open' | 'closed' | 'unsold' | 'canceled'
  winner_bid_id INTEGER,
  order_id INTEGER,
  pay_token TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bidders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS bids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  bidder_id INTEGER NOT NULL REFERENCES bidders(id),
  amount_cents INTEGER NOT NULL,
  voided INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_auction ON bids (auction_id, amount_cents);

CREATE TABLE IF NOT EXISTS discounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,                 -- 'percent' | 'amount'
  value INTEGER NOT NULL,             -- percent (1-100) or cents
  min_subtotal_cents INTEGER NOT NULL DEFAULT 0,
  max_uses INTEGER,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_on TEXT,                    -- YYYY-MM-DD, last day the code works
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                 -- 'email' | 'ip'
  value TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);

-- Devices the owner has signed in from before. A device that proves it (long secret kept in that browser) is not
-- locked out by strangers' failed guesses. Only a hash is stored here.
CREATE TABLE IF NOT EXISTS trusted_devices (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_login_at ON login_attempts (at);

CREATE TABLE IF NOT EXISTS security_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ip TEXT,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sec_at ON security_events (at);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  rating INTEGER NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  items TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  reply TEXT NOT NULL DEFAULT '',
  reply_at INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  hidden_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  blurb TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS product_lines (
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  line_id INTEGER NOT NULL REFERENCES lines(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, line_id)
);

CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  price_cents INTEGER,               -- NULL = same price as the product
  stock INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_variants_product ON variants (product_id);

CREATE TABLE IF NOT EXISTS watches (
  bidder_id INTEGER NOT NULL REFERENCES bidders(id),
  auction_id INTEGER NOT NULL REFERENCES auctions(id),
  PRIMARY KEY (bidder_id, auction_id)
);
`);

// ---------- migrations (databases created by earlier versions) ----------
// Everything below runs in ONE transaction: if any step fails nothing is changed (it used to leave a half-updated database that
// crashed on every start; review item 75). PRAGMA user_version says which round of changes a database has had.
const SCHEMA_VERSION = 2;
const startVersion = db.pragma('user_version', { simple: true });
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all();
const addCol = (t, name, def) => {
  if (cols(t).some((c) => c.name === name)) return false;
  db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${def}`);
  return true;
};

// order_items.product_id used to be NOT NULL (auction lots have no product row). Rebuilding the table is the risky step, so a copy of
// the whole database is made first (next to it, same private permissions) and the table is rebuilt with every column it has now.
const needsRebuild = hadTables && (() => { const c = cols('order_items').find((x) => x.name === 'product_id'); return !!(c && c.notnull === 1); })();
if (needsRebuild) {
  const copy = DB_FILE + '.before-update.bak';
  try { fsx.rmSync(copy, { force: true }); db.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`); try { fsx.chmodSync(copy, 0o600); } catch { /* ignore */ } console.log('Outpost: a copy of your database was saved as ' + copy + ' before updating it. Delete it once the shop looks right (it holds customer details).'); }
  catch (e) { console.error('Outpost: could not make a safety copy before updating (' + (e && e.message) + '). Continuing is not safe; stopping.'); process.exit(1); }
}

try {
  db.exec('BEGIN IMMEDIATE');
  if (needsRebuild) {
    const old = cols('order_items').map((c) => c.name);
    db.exec(`
      CREATE TABLE order_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id),
        name TEXT NOT NULL,
        unit_price_cents INTEGER NOT NULL,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        variant_id INTEGER,
        custom_json TEXT,
        stock_taken INTEGER
      )`);
    const keep = ['id', 'order_id', 'product_id', 'name', 'unit_price_cents', 'quantity', 'variant_id', 'custom_json', 'stock_taken'].filter((c) => old.includes(c));
    db.exec(`INSERT INTO order_items_new (${keep.join(',')}) SELECT ${keep.join(',')} FROM order_items`);
    db.exec('DROP TABLE order_items; ALTER TABLE order_items_new RENAME TO order_items;');
  }
  addCol('order_items', 'variant_id', 'INTEGER');
  addCol('order_items', 'custom_json', 'TEXT');

addCol('admin_sessions', 'pw_ver', "TEXT NOT NULL DEFAULT ''");   // which password the session was opened with
addCol('products', 'description', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'category', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'tags', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'images', "TEXT NOT NULL DEFAULT '[]'");
const subtotalIsNew = addCol('orders', 'subtotal_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'tax_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'auction_id', 'INTEGER');
addCol('orders', 'public_token', 'TEXT');
addCol('products', 'badge', "TEXT NOT NULL DEFAULT ''");
addCol('orders', 'discount_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'discount_code', 'TEXT');
addCol('orders', 'stripe_payment_intent', 'TEXT');
addCol('orders', 'fulfillment', "TEXT NOT NULL DEFAULT ''");
addCol('orders', 'tracking_number', 'TEXT');
addCol('orders', 'carrier', 'TEXT');
addCol('orders', 'shipped_at', 'TEXT');
addCol('orders', 'refunded_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'refund_note', 'TEXT');
addCol('orders', 'refunded_at', 'TEXT');
addCol('orders', 'policy_text', "TEXT NOT NULL DEFAULT ''");
addCol('orders', 'charge_status', "TEXT NOT NULL DEFAULT ''");   // auto-charge of an auction win: '' | charging | paid | failed
addCol('orders', 'charge_error', 'TEXT');
addCol('products', 'process', "TEXT NOT NULL DEFAULT ''");
addCol('discounts', 'starts_on', 'TEXT');
addCol('products', 'sku', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'option_label', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'custom_fields', "TEXT NOT NULL DEFAULT '[]'");
addCol('orders', 'shipping_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'tax_state', "TEXT NOT NULL DEFAULT ''");
db.exec(`CREATE TABLE IF NOT EXISTS subscribers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  source TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  unsubscribed INTEGER NOT NULL DEFAULT 0
)`);
addCol('bidders', 'address_json', 'TEXT');
addCol('bidders', 'stripe_customer_id', 'TEXT');
addCol('bidders', 'stripe_payment_method', 'TEXT');
addCol('bidders', 'card_brand', 'TEXT');
addCol('bidders', 'card_last4', 'TEXT');
addCol('bidders', 'card_at', 'INTEGER');
// Details of an automatic charge are written down BEFORE Stripe is asked, so a restart in the middle can be finished safely:
// the same attempt is looked up at Stripe (and re-sent with the same key and amount) instead of being started over.
addCol('orders', 'charge_attempt', "TEXT NOT NULL DEFAULT ''");
addCol('orders', 'charge_amount', 'INTEGER');
addCol('orders', 'charge_calc', 'TEXT');
addCol('orders', 'charge_started', 'INTEGER');
addCol('orders', 'duplicate_payments', "TEXT NOT NULL DEFAULT ''");   // payment ids of any extra payments on an order that was already paid
// A charge that was in progress when the app stopped: if nothing had reached Stripe yet it just starts again, otherwise it is "recover" (checked at Stripe first).
db.exec("UPDATE orders SET charge_status = CASE WHEN charge_attempt = '' THEN '' ELSE 'recover' END WHERE charge_status = 'charging'");
// Every Stripe payment page ever made for an order, so all of them can be closed when the order is canceled or paid another way.
db.exec(`CREATE TABLE IF NOT EXISTS order_sessions (
  order_id INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (order_id, session_id)
)`);

// Refunds: the intent is written down BEFORE Stripe is asked, so a crash in between can be sorted out afterwards (review items 64, 69).
addCol('orders', 'refund_intent_cents', 'INTEGER NOT NULL DEFAULT 0');
addCol('orders', 'refund_key', "TEXT NOT NULL DEFAULT ''");
addCol('orders', 'restock_requested', 'INTEGER NOT NULL DEFAULT 0');   // "put the items back" was ticked on a part refund: done when the order is fully refunded
addCol('orders', 'late_payment', "TEXT NOT NULL DEFAULT ''");          // payment id of money that arrived AFTER the order was canceled
addCol('orders', 'late_paid_cents', 'INTEGER');
addCol('auctions', 'extensions', 'INTEGER NOT NULL DEFAULT 0');        // how many times late bids pushed the end out

addCol('order_items', 'stock_taken', 'INTEGER');                       // how many were really taken out of stock when it was paid (NULL on older orders)

// Backfills for rows that existed before the new columns
db.exec(`UPDATE products SET images = json_array(image_url)
         WHERE images = '[]' AND image_url IS NOT NULL AND image_url <> ''`);
// Only for orders that existed before the subtotal column did. (It used to run on EVERY start and rewrote real orders,
// e.g. a $0 item with $5 shipping became subtotal $5; review item 76.)
if (subtotalIsNew) db.exec(`UPDATE orders SET subtotal_cents = total_cents WHERE subtotal_cents = 0 AND tax_cents = 0 AND total_cents > 0`);
const needToken = db.prepare('SELECT id FROM orders WHERE public_token IS NULL').all();
const setToken = db.prepare('UPDATE orders SET public_token = ? WHERE id = ?');
for (const o of needToken) setToken.run(crypto.randomBytes(12).toString('hex'), o.id);

  // ----- round 2 (this release): privacy, indexes, checks -----
  addCol('subscribers', 'consent_at', 'INTEGER');                      // when the box was ticked (older rows: NULL)
  if (startVersion < 2) {
    // Bidder tokens are stored as a hash from now on (a leaked database or backup no longer holds working sign-ins).
    const hashTok = db.prepare('UPDATE bidders SET token = ? WHERE id = ?');
    for (const b of db.prepare('SELECT id, token FROM bidders').all()) hashTok.run(crypto.createHash('sha256').update(String(b.token)).digest('hex'), b.id);
    db.exec("UPDATE admin_sessions SET ip = ''");                       // sessions no longer remember an address
  }

  // Indexes: without these the order export and the customers list scanned whole tables once per order (review item 78).
  for (const sql of [
    'CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status, created_at)',
    'CREATE INDEX IF NOT EXISTS idx_orders_session ON orders (stripe_session_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_intent ON orders (stripe_payment_intent)',
    'CREATE INDEX IF NOT EXISTS idx_orders_auction ON orders (auction_id)',
    'CREATE INDEX IF NOT EXISTS idx_orders_email ON orders (customer_email)',
    'CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions (status, end_at)',
    'CREATE INDEX IF NOT EXISTS idx_auctions_pay ON auctions (pay_token)',
    'CREATE INDEX IF NOT EXISTS idx_bidders_email ON bidders (email)',
    'CREATE INDEX IF NOT EXISTS idx_bids_bidder ON bids (bidder_id)',
    'CREATE INDEX IF NOT EXISTS idx_watches_auction ON watches (auction_id)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_by_order ON order_sessions (session_id)',
  ]) { try { db.exec(sql); } catch (e) { console.warn('Outpost: skipped a speed-up index (' + e.message + '). Everything still works.'); } }
  // Rules the database itself now enforces (a bug or a typo can no longer store these): order status, review rating, stock never below zero.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_orders_status_ins BEFORE INSERT ON orders WHEN NEW.status NOT IN ('pending','paid','canceled','refunded')
      BEGIN SELECT RAISE(ABORT, 'invalid order status'); END;
    CREATE TRIGGER IF NOT EXISTS trg_orders_status_upd BEFORE UPDATE OF status ON orders WHEN NEW.status NOT IN ('pending','paid','canceled','refunded')
      BEGIN SELECT RAISE(ABORT, 'invalid order status'); END;
    CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_ins BEFORE INSERT ON reviews WHEN NEW.rating NOT BETWEEN 1 AND 5
      BEGIN SELECT RAISE(ABORT, 'invalid rating'); END;
    CREATE TRIGGER IF NOT EXISTS trg_reviews_rating_upd BEFORE UPDATE OF rating ON reviews WHEN NEW.rating NOT BETWEEN 1 AND 5
      BEGIN SELECT RAISE(ABORT, 'invalid rating'); END;
    CREATE TRIGGER IF NOT EXISTS trg_products_stock_ins BEFORE INSERT ON products WHEN NEW.stock < 0
      BEGIN SELECT RAISE(ABORT, 'stock cannot be negative'); END;
    CREATE TRIGGER IF NOT EXISTS trg_products_stock_upd BEFORE UPDATE OF stock ON products WHEN NEW.stock < 0
      BEGIN SELECT RAISE(ABORT, 'stock cannot be negative'); END;
    CREATE TRIGGER IF NOT EXISTS trg_variants_stock_ins BEFORE INSERT ON variants WHEN NEW.stock < 0
      BEGIN SELECT RAISE(ABORT, 'stock cannot be negative'); END;
    CREATE TRIGGER IF NOT EXISTS trg_variants_stock_upd BEFORE UPDATE OF stock ON variants WHEN NEW.stock < 0
      BEGIN SELECT RAISE(ABORT, 'stock cannot be negative'); END;
  `);
  // Unique values. If an older shop already holds duplicates the index is skipped (and said so) rather than refusing to start.
  for (const [name, sql] of [
    ['ux_orders_token', 'CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_token ON orders (public_token)'],
    ['ux_products_sku', "CREATE UNIQUE INDEX IF NOT EXISTS ux_products_sku ON products (lower(sku)) WHERE sku <> ''"],
  ]) { try { db.exec(sql); } catch (e) { console.warn(`Outpost: could not add the "${name}" safeguard because existing data has duplicates (${e.message}). Everything still works; fix the duplicates to turn it on.`); } }

  db.pragma('user_version = ' + SCHEMA_VERSION);
  db.exec('COMMIT');
} catch (e) {
  try { db.exec('ROLLBACK'); } catch { /* nothing was open */ }
  console.error('\nOutpost could not update your database to the new version, so it did not start. NOTHING in your database was changed.\n' +
    'Reason: ' + (e && e.message) + '\n' +
    (needsRebuild ? 'A copy of the database from before the update is at ' + DB_FILE + '.before-update.bak\n' : '') +
    'Please keep this message and ask for help; do not delete your database file.\n');
  process.exit(1);
}
lockFiles();
// One-time cleanup when an existing shop first gets the overwrite-on-delete setting: rewrite the file so earlier deletions are gone from it too.
if (hadTables && startVersion < 2) { try { db.exec('VACUUM'); lockFiles(); } catch (e) { console.warn('Outpost: could not compact the database (' + (e && e.message) + '). Not a problem; it will work as it is.'); } }

db.pragma('foreign_keys = ON');

module.exports = db;
