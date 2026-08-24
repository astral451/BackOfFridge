const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'perishable',
    location TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1,
    unit TEXT NOT NULL DEFAULT '',
    purchase_date TEXT,
    expiration_date TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    thrown_out_date TEXT,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
  CREATE INDEX IF NOT EXISTS idx_items_expiration ON items(expiration_date);
`);

// Migration: add columns used to support undoing the last consume/throw-out.
const existingColumns = db.prepare("PRAGMA table_info(items)").all().map((c) => c.name);
if (!existingColumns.includes('prev_status')) {
  db.exec('ALTER TABLE items ADD COLUMN prev_status TEXT');
}
if (!existingColumns.includes('prev_quantity')) {
  db.exec('ALTER TABLE items ADD COLUMN prev_quantity REAL');
}

// Locations are their own table so they can be managed (added/removed)
// independently of whatever items currently happen to reference them.
db.exec(`
  CREATE TABLE IF NOT EXISTS locations (
    name TEXT PRIMARY KEY
  );
`);

// Backfill: any location already used by an existing item becomes a managed
// location, so nothing already in use silently disappears from the list.
db.exec(`
  INSERT OR IGNORE INTO locations (name)
  SELECT DISTINCT location FROM items WHERE location != ''
`);

// Every location an item is set to (on create or edit) becomes a managed
// location automatically, matching the "+ Add new location" flow in the
// purchase form.
function ensureLocation(name) {
  if (name) {
    db.prepare('INSERT OR IGNORE INTO locations (name) VALUES (?)').run(name);
  }
}

module.exports = db;
module.exports.ensureLocation = ensureLocation;
