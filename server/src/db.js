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

module.exports = db;
