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

// Append-only history of actions taken on items - purchases, consumes,
// throw-outs, edits, undos, fill-level changes - so trends over time
// (how often something's rebought, how much gets wasted, etc.) become
// answerable later. Distinct from the text log file (human-readable lines,
// not queryable) and from prev_status/prev_quantity (a single-slot memory
// for one-level undo, overwritten each time, not a history).
db.exec(`
  CREATE TABLE IF NOT EXISTS item_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER,
    item_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_item_events_name ON item_events(item_name);
  CREATE INDEX IF NOT EXISTS idx_item_events_item_id ON item_events(item_id);
  CREATE INDEX IF NOT EXISTS idx_item_events_created ON item_events(created_at);
`);

function recordEvent(itemId, itemName, eventType, detail, username) {
  db.prepare(`
    INSERT INTO item_events (item_id, item_name, event_type, detail, username)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemId, itemName, eventType, detail ? JSON.stringify(detail) : null, username || null);
}

// Migration: low-stock tracking. tracking_mode picks how an item signals
// low stock - 'count' uses the existing numeric quantity against
// low_stock_threshold; 'fill_level' uses fill_percent (0-100, set via a
// slider) against the same threshold column, interpreted as a percentage.
if (!existingColumns.includes('tracking_mode')) {
  db.exec("ALTER TABLE items ADD COLUMN tracking_mode TEXT NOT NULL DEFAULT 'count'");
}
if (!existingColumns.includes('fill_percent')) {
  db.exec('ALTER TABLE items ADD COLUMN fill_percent REAL');
}
if (!existingColumns.includes('low_stock_threshold')) {
  db.exec('ALTER TABLE items ADD COLUMN low_stock_threshold REAL');
}

// Per-user login (one shared inventory, not per-family isolation - see
// features.md for why that's deliberately out of scope here). Sessions are
// hand-rolled rather than using express-session, matching this project's
// existing preference for small, direct dependencies.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );
`);

// Migration: attribute item_events to the user who caused them, so "who
// changed this" is answerable (the motivating case: one family member
// reducing an item's quantity, another seeing that in the history instead
// of reducing it again).
const eventColumns = db.prepare("PRAGMA table_info(item_events)").all().map((c) => c.name);
if (!eventColumns.includes('username')) {
  db.exec('ALTER TABLE item_events ADD COLUMN username TEXT');
}

module.exports = db;
module.exports.ensureLocation = ensureLocation;
module.exports.recordEvent = recordEvent;
