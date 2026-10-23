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

// Household data is read and written through store.js, which requires a
// household id for every query - not through this module directly.

module.exports = db;
