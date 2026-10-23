const Database = require('better-sqlite3');
const crypto = require('crypto');

const fsx = require('fs');
const pathx = require('path');
// DATA_DIR keeps the database and uploaded photos together in one folder (handy for hosts with a single persistent disk).
const DATA_DIR = process.env.DATA_DIR ? pathx.resolve(process.env.DATA_DIR) : '';
if (DATA_DIR) fsx.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(process.env.DB_PATH || (DATA_DIR ? pathx.join(DATA_DIR, 'outpost.db') : 'pos.db'));
db.dataDir = DATA_DIR;
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // off while migrating; switched on at the bottom

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
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all();
const addCol = (t, name, def) => {
  if (!cols(t).some((c) => c.name === name)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${def}`);
};

addCol('products', 'description', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'category', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'tags', "TEXT NOT NULL DEFAULT ''");
addCol('products', 'images', "TEXT NOT NULL DEFAULT '[]'");
addCol('orders', 'subtotal_cents', 'INTEGER NOT NULL DEFAULT 0');
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
addCol('order_items', 'variant_id', 'INTEGER');
addCol('order_items', 'custom_json', 'TEXT');
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
db.exec("UPDATE orders SET charge_status='' WHERE charge_status='charging'");

// order_items.product_id used to be NOT NULL; auction lots have no product row.
const pid = cols('order_items').find((c) => c.name === 'product_id');
if (pid && pid.notnull === 1) {
  db.exec(`
    BEGIN;
    CREATE TABLE order_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id INTEGER REFERENCES products(id),
      name TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL,
      quantity INTEGER NOT NULL CHECK (quantity > 0)
    );
    INSERT INTO order_items_new (id, order_id, product_id, name, unit_price_cents, quantity)
      SELECT id, order_id, product_id, name, unit_price_cents, quantity FROM order_items;
    DROP TABLE order_items;
    ALTER TABLE order_items_new RENAME TO order_items;
    COMMIT;
  `);
}

// Backfills for rows that existed before the new columns
db.exec(`UPDATE products SET images = json_array(image_url)
         WHERE images = '[]' AND image_url IS NOT NULL AND image_url <> ''`);
db.exec(`UPDATE orders SET subtotal_cents = total_cents
         WHERE subtotal_cents = 0 AND tax_cents = 0 AND total_cents > 0`);
const needToken = db.prepare('SELECT id FROM orders WHERE public_token IS NULL').all();
const setToken = db.prepare('UPDATE orders SET public_token = ? WHERE id = ?');
for (const o of needToken) setToken.run(crypto.randomBytes(12).toString('hex'), o.id);

db.pragma('foreign_keys = ON');

module.exports = db;
