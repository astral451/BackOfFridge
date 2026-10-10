// Tests for the schema migration runner and the dry-run check script.
// Run from server/: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { migrate, currentVersion, MIGRATIONS } = require('../src/migrate');

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'inventory.db');
  return { file, db: new Database(file) };
}

function schema(db) {
  return db.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
    ORDER BY type, name
  `).all();
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// The oldest schema the app has shipped with: items before the undo and
// low-stock columns, a case-sensitive locations table, no events, users or
// tags.
function createLegacySchema(db) {
  db.exec(`
    CREATE TABLE items (
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
    CREATE TABLE locations (name TEXT PRIMARY KEY);
    INSERT INTO locations (name) VALUES ('Fridge');
    INSERT INTO items (name, location, quantity) VALUES ('Milk', 'Fridge', 2), ('Rice', 'Pantry', 1);
  `);
}

test('a new database gets the full schema and is recorded at the latest version', (t) => {
  const { db } = tempDb(t);
  const result = migrate(db);
  assert.deepStrictEqual(result, {
    from: 0,
    to: MIGRATIONS.length,
    applied: MIGRATIONS.map(({ version, name }) => ({ version, name })),
  });
  assert.strictEqual(currentVersion(db), MIGRATIONS.length);
  for (const table of ['items', 'item_events', 'locations', 'tags', 'users', 'sessions']) {
    assert.ok(columns(db, table).length, `${table} exists`);
  }
});

test('running again applies nothing and changes nothing', (t) => {
  const { db } = tempDb(t);
  migrate(db);
  db.exec("INSERT INTO items (name, location) VALUES ('Milk', 'Fridge')");
  const before = schema(db);
  const rows = db.prepare('SELECT * FROM items').all();
  const result = migrate(db);
  assert.deepStrictEqual(result.applied, []);
  assert.deepStrictEqual(schema(db), before);
  assert.deepStrictEqual(db.prepare('SELECT * FROM items').all(), rows);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n, MIGRATIONS.length);
});

test('an existing unversioned database is brought up to date without losing data', (t) => {
  const { db } = tempDb(t);
  createLegacySchema(db);
  assert.strictEqual(currentVersion(db), null);

  migrate(db);

  assert.strictEqual(currentVersion(db), MIGRATIONS.length);
  for (const col of ['prev_status', 'prev_quantity', 'tracking_mode', 'fill_percent', 'low_stock_threshold', 'tag']) {
    assert.ok(columns(db, 'items').includes(col), `items.${col} added`);
  }
  assert.ok(columns(db, 'item_events').includes('username'));
  const locationsSql = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'locations'").get().sql;
  assert.match(locationsSql, /COLLATE NOCASE/);
  assert.deepStrictEqual(
    db.prepare('SELECT name, location, quantity FROM items ORDER BY id').all(),
    [{ name: 'Milk', location: 'Fridge', quantity: 2 }, { name: 'Rice', location: 'Pantry', quantity: 1 }]
  );
  // Pantry was only on an item; the backfill makes it a managed location.
  assert.deepStrictEqual(db.prepare('SELECT name FROM locations ORDER BY name').all().map((r) => r.name), ['Fridge', 'Pantry']);
});

test('a database newer than the code is refused and left untouched', (t) => {
  const { db } = tempDb(t);
  migrate(db);
  db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, 'from the future')").run(MIGRATIONS.length + 1);
  const before = schema(db);
  assert.throws(() => migrate(db), /Refusing to start/);
  assert.deepStrictEqual(schema(db), before);
  assert.strictEqual(currentVersion(db), MIGRATIONS.length + 1);
});

test('a migration that fails partway rolls back completely', (t) => {
  const { db } = tempDb(t);
  migrate(db);
  db.exec("INSERT INTO items (name) VALUES ('Milk')");
  const before = schema(db);

  const broken = {
    version: MIGRATIONS.length + 1,
    name: 'broken',
    up(d) {
      d.exec('ALTER TABLE items ADD COLUMN half_done TEXT');
      d.exec("UPDATE items SET name = 'changed'");
      d.exec('CREATE TABLE half_done (id INTEGER)');
      throw new Error('boom');
    },
  };
  assert.throws(() => migrate(db, { migrations: [...MIGRATIONS, broken] }), /boom/);

  assert.deepStrictEqual(schema(db), before);
  assert.strictEqual(db.prepare('SELECT name FROM items').get().name, 'Milk');
  assert.strictEqual(currentVersion(db), MIGRATIONS.length);
});

test('migrations must be numbered 1, 2, 3, ... with no gaps', (t) => {
  const { db } = tempDb(t);
  const gap = [...MIGRATIONS, { version: MIGRATIONS.length + 2, name: 'gap', up() {} }];
  assert.throws(() => migrate(db, { migrations: gap }), /out of order/);
});

test('migrate-check runs on a copy and never modifies the original', (t) => {
  const { file, db } = tempDb(t);
  createLegacySchema(db);
  db.close();
  const before = fs.readFileSync(file);

  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-check.js'), file], { encoding: 'utf8' });

  assert.match(out, /BEFORE: unversioned/);
  assert.match(out, new RegExp(`AFTER: version ${MIGRATIONS.length}`));
  assert.match(out, /items\s+existing rows unchanged; new columns:/);
  assert.match(out, /Original file untouched: yes/);
  assert.match(out, /RESULT: OK/);
  assert.ok(fs.readFileSync(file).equals(before), 'original file bytes unchanged');
  const reopened = new Database(file, { readonly: true });
  assert.strictEqual(currentVersion(reopened), null);
  reopened.close();
});
