// Migration 001: the schema as it stood before versioning existed.
//
// This is the set of ad-hoc, guarded startup blocks that used to live in
// db.js, moved here unchanged. Every step checks before it acts, so:
//   - on a new, empty database it builds the whole schema;
//   - on a database already created by earlier code it changes nothing
//     (it just gets recorded as being at version 1);
//   - on an older database partway through those ad-hoc migrations, it
//     finishes them exactly as the old startup code would have.
module.exports = function baseline(db) {
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

  // Columns used to support undoing the last consume/throw-out.
  const existingColumns = db.prepare('PRAGMA table_info(items)').all().map((c) => c.name);
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
      name TEXT PRIMARY KEY COLLATE NOCASE
    );
  `);

  // Give an existing (pre-NOCASE) locations table case-insensitive
  // matching, so "Fridge" and "fridge" are treated as the same location
  // instead of silently becoming two managed locations. SQLite can't ALTER a
  // column's collation in place, so this recreates the table and copies rows
  // over - guarded to run only once by checking the stored table definition.
  const locationsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='locations'").get();
  if (locationsSql && !locationsSql.sql.includes('COLLATE NOCASE')) {
    db.exec(`
      CREATE TABLE locations_new (name TEXT PRIMARY KEY COLLATE NOCASE);
      INSERT OR IGNORE INTO locations_new (name) SELECT name FROM locations;
      DROP TABLE locations;
      ALTER TABLE locations_new RENAME TO locations;
    `);
  }

  // Backfill: any location already used by an existing item becomes a
  // managed location, so nothing already in use silently disappears from the
  // list.
  db.exec(`
    INSERT OR IGNORE INTO locations (name)
    SELECT DISTINCT location FROM items WHERE location != ''
  `);

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

  // Low-stock tracking. tracking_mode picks how an item signals low stock -
  // 'count' uses the existing numeric quantity against low_stock_threshold;
  // 'fill_level' uses fill_percent (0-100, set via a slider) against the
  // same threshold column, interpreted as a percentage.
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
  // features.md). Sessions are hand-rolled rather than using
  // express-session, matching this project's preference for small, direct
  // dependencies.
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

  // Attribute item_events to the user who caused them, so "who changed
  // this" is answerable.
  const eventColumns = db.prepare('PRAGMA table_info(item_events)').all().map((c) => c.name);
  if (!eventColumns.includes('username')) {
    db.exec('ALTER TABLE item_events ADD COLUMN username TEXT');
  }

  // Categorization ("tags" internally - the column is named `tag` to avoid
  // colliding with the existing `category` column, the unrelated
  // perishable/nonperishable enum). Mirrors the `locations` pattern: a
  // managed list, one value per item, case-insensitive.
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      name TEXT PRIMARY KEY COLLATE NOCASE
    );
  `);

  if (!existingColumns.includes('tag')) {
    db.exec("ALTER TABLE items ADD COLUMN tag TEXT NOT NULL DEFAULT ''");
  }

  // Backfill, same reasoning as locations: any tag already on an item
  // becomes a managed tag, so nothing already in use silently disappears.
  db.exec(`
    INSERT OR IGNORE INTO tags (name)
    SELECT DISTINCT tag FROM items WHERE tag != ''
  `);
};
