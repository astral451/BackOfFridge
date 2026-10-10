// Tests for migration 002 (households). Run from server/: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { migrate, currentVersion, MIGRATIONS } = require('../src/migrate');

const UP_TO_1 = MIGRATIONS.slice(0, 1);

function tempDb(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'inventory.db');
  return { file, db: new Database(file) };
}

// A version-1 database with data in it, as the app had it before households.
function populatedV1(t) {
  const { file, db } = tempDb(t);
  migrate(db, { migrations: UP_TO_1 });
  db.exec(`
    INSERT INTO users (username, password_hash) VALUES ('alice', 'h1'), ('bob', 'h2');
    INSERT INTO sessions (token, user_id, expires_at) VALUES ('tok', 1, '2099-01-01');
    INSERT INTO locations (name) VALUES ('Fridge'), ('Pantry');
    INSERT INTO tags (name) VALUES ('Dairy');
    INSERT INTO items (name, location, tag, quantity) VALUES ('Milk', 'Fridge', 'Dairy', 2), ('Rice', 'Pantry', '', 1);
    INSERT INTO item_events (item_id, item_name, event_type, username) VALUES (1, 'Milk', 'purchased', 'alice'), (2, 'Rice', 'purchased', 'bob');
    DELETE FROM items WHERE id = 2;
  `);
  return { file, db };
}

test('existing data all moves into household #1, untouched', (t) => {
  const { db } = populatedV1(t);
  const itemsBefore = db.prepare('SELECT * FROM items ORDER BY id').all();
  const eventsBefore = db.prepare('SELECT * FROM item_events ORDER BY id').all();

  migrate(db);
  assert.strictEqual(currentVersion(db), 2);

  const households = db.prepare('SELECT id, name, invite_code FROM households').all();
  assert.strictEqual(households.length, 1);
  assert.strictEqual(households[0].id, 1);
  assert.strictEqual(households[0].name, 'Household 1');
  assert.match(households[0].invite_code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

  assert.deepStrictEqual(
    db.prepare('SELECT * FROM items ORDER BY id').all(),
    itemsBefore.map((r) => ({ ...r, household_id: 1 }))
  );
  // Including the event whose item was deleted.
  assert.deepStrictEqual(
    db.prepare('SELECT * FROM item_events ORDER BY id').all(),
    eventsBefore.map((r) => ({ ...r, household_id: 1 }))
  );
  assert.deepStrictEqual(db.prepare('SELECT household_id, name FROM locations ORDER BY name').all(),
    [{ household_id: 1, name: 'Fridge' }, { household_id: 1, name: 'Pantry' }]);
  assert.deepStrictEqual(db.prepare('SELECT household_id, name FROM tags').all(), [{ household_id: 1, name: 'Dairy' }]);
  assert.deepStrictEqual(
    db.prepare('SELECT username, household_id, status, is_admin, household_role FROM users ORDER BY id').all(),
    [
      { username: 'alice', household_id: 1, status: 'active', is_admin: 0, household_role: 'member' },
      { username: 'bob', household_id: 1, status: 'active', is_admin: 0, household_role: 'member' },
    ]
  );
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1, 'logins survive');
  assert.deepStrictEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});

test('a brand-new database gets no household', (t) => {
  const { db } = tempDb(t);
  migrate(db);
  assert.strictEqual(currentVersion(db), 2);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
});

test('two households can use the same location and tag names', (t) => {
  const { db } = populatedV1(t);
  migrate(db);
  db.prepare("INSERT INTO households (name, invite_code) VALUES ('Second', 'ZZZZZZZZ')").run();
  db.exec("INSERT INTO locations (household_id, name) VALUES (2, 'Pantry'), (2, 'fridge')");
  db.exec("INSERT INTO tags (household_id, name) VALUES (2, 'dairy')");
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM locations').get().n, 4);
  // Still case-insensitive within one household.
  assert.throws(() => db.exec("INSERT INTO locations (household_id, name) VALUES (1, 'PANTRY')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO tags (household_id, name) VALUES (2, 'DAIRY')"), /UNIQUE/);
});

test('items, events, locations and tags cannot be written without a household', (t) => {
  const { db } = populatedV1(t);
  migrate(db);
  assert.throws(() => db.exec("INSERT INTO items (name) VALUES ('Orphan')"), /items.household_id is required/);
  assert.throws(() => db.exec("INSERT INTO item_events (item_name, event_type) VALUES ('Orphan', 'purchased')"), /item_events.household_id is required/);
  assert.throws(() => db.exec("INSERT INTO locations (name) VALUES ('Garage')"), /NOT NULL/);
  assert.throws(() => db.exec("INSERT INTO tags (name) VALUES ('Snacks')"), /NOT NULL/);
  db.exec("INSERT INTO items (name, household_id) VALUES ('Fine', 1)");
});

test('an item or event cannot be moved to another household', (t) => {
  const { db } = populatedV1(t);
  migrate(db);
  db.prepare("INSERT INTO households (name, invite_code) VALUES ('Second', 'ZZZZZZZZ')").run();
  assert.throws(() => db.exec('UPDATE items SET household_id = 2 WHERE id = 1'), /cannot be changed/);
  assert.throws(() => db.exec('UPDATE item_events SET household_id = NULL WHERE id = 1'), /cannot be changed/);
  db.exec("UPDATE items SET name = 'Whole milk', household_id = 1 WHERE id = 1"); // unchanged is fine
});

test('new accounts default to pending, and status only takes known values', (t) => {
  const { db } = populatedV1(t);
  migrate(db);
  db.exec("INSERT INTO users (username, password_hash) VALUES ('newcomer', 'h3')");
  const row = db.prepare("SELECT status, household_id, is_admin FROM users WHERE username = 'newcomer'").get();
  assert.deepStrictEqual(row, { status: 'pending', household_id: null, is_admin: 0 });
  assert.throws(() => db.exec("UPDATE users SET status = 'superuser' WHERE username = 'newcomer'"), /CHECK/);
});

test('migrate-check reports every row landing in household #1', (t) => {
  const { file, db } = populatedV1(t);
  db.close();
  const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate-check.js'), file], { encoding: 'utf8' });
  assert.match(out, /BEFORE: version 1/);
  assert.match(out, /AFTER: version 2/);
  assert.match(out, /items\s+#1 "Household 1"\s+1\n/);
  assert.match(out, /item_events\s+#1 "Household 1"\s+2\n/);
  assert.match(out, /users\s+#1 "Household 1"\s+2\n/);
  assert.match(out, /every active user has a household/);
  assert.doesNotMatch(out, /CHANGED OR REMOVED|NO HOUSEHOLD/);
  assert.match(out, /RESULT: OK/);
});

// TEMPORARY, matching SERVER_MAX_VERSION in db.js: until the routes are
// scoped by household, the server itself must stop at version 1.
test('the server does not apply the households migration yet', (t) => {
  const { file, db } = populatedV1(t);
  db.close();
  execFileSync(process.execPath, ['-e', "require('./src/db')"], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DB_PATH: file, LOG_PATH: path.join(path.dirname(file), 'app.log') },
  });
  const reopened = new Database(file, { readonly: true });
  assert.strictEqual(currentVersion(reopened), 1);
  reopened.close();
});
