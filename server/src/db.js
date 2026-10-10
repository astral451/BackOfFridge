const path = require('path');
const Database = require('better-sqlite3');
const { migrate } = require('./migrate');
const { log } = require('./logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Bring the schema up to date. Each migration in ./migrations runs once and
// is recorded in schema_migrations (see migrate.js). If the database is newer
// than this code knows about, refuse to start rather than risk damaging it.
try {
  const { from, to, applied } = migrate(db, { log });
  log(applied.length
    ? `Database schema migrated from version ${from} to ${to} (${DB_PATH})`
    : `Database schema at version ${to} (${DB_PATH})`);
} catch (err) {
  console.error(`FATAL ${err.message}`);
  process.exit(1);
}

// Every location an item is set to (on create or edit) becomes a managed
// location automatically, matching the "+ Add new location" flow in the
// purchase form.
function ensureLocation(name) {
  name = typeof name === 'string' ? name.trim() : name;
  if (name) {
    db.prepare('INSERT OR IGNORE INTO locations (name) VALUES (?)').run(name);
  }
}

function ensureTag(name) {
  name = typeof name === 'string' ? name.trim() : name;
  if (name) {
    db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
  }
}

function recordEvent(itemId, itemName, eventType, detail, username) {
  db.prepare(`
    INSERT INTO item_events (item_id, item_name, event_type, detail, username)
    VALUES (?, ?, ?, ?, ?)
  `).run(itemId, itemName, eventType, detail ? JSON.stringify(detail) : null, username || null);
}

module.exports = db;
module.exports.ensureLocation = ensureLocation;
module.exports.ensureTag = ensureTag;
module.exports.recordEvent = recordEvent;
