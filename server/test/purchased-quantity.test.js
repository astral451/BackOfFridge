// Tests for purchased_quantity (migration 003, features.md "Quantity model"
// step 1): the backfill for existing items, and that only creating an item
// sets it. Run from server/: npm test
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { migrate, currentVersion, MIGRATIONS } = require('../src/migrate');

const UP_TO_2 = MIGRATIONS.slice(0, 2);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-purchased-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('existing items get purchased_quantity from their earliest purchase event, else their current quantity', () => {
  const db = new Database(path.join(dir, 'backfill.db'));
  migrate(db, { migrations: UP_TO_2 });
  db.exec(`
    INSERT INTO households (id, name, invite_code) VALUES (1, 'Household 1', 'ABCDEFGH');
    INSERT INTO items (household_id, name, quantity) VALUES
      (1, 'Coke', 3), (1, 'Rice', 2), (1, 'Milk', 1), (1, 'Eggs', 4), (1, 'Bread', 1);
    INSERT INTO item_events (household_id, item_id, item_name, event_type, detail) VALUES
      (1, 1, 'Coke', 'purchased', '{"quantity":12,"unit":"cans"}'),
      (1, 1, 'Coke', 'consumed', '{"quantity":9}'),
      (1, 3, 'Milk', 'purchased', NULL),
      (1, 4, 'Eggs', 'purchased', '{"quantity":18}'),
      (1, 4, 'Eggs', 'purchased', '{"quantity":6}'),
      (1, 5, 'Bread', 'purchased', 'not json');
  `);

  migrate(db);
  assert.strictEqual(currentVersion(db), MIGRATIONS.length);
  assert.deepStrictEqual(db.prepare('SELECT name, quantity, purchased_quantity FROM items ORDER BY id').all(), [
    { name: 'Coke', quantity: 3, purchased_quantity: 12 },  // bought 12, 3 left
    { name: 'Rice', quantity: 2, purchased_quantity: 2 },   // no event: best guess
    { name: 'Milk', quantity: 1, purchased_quantity: 1 },   // event without a quantity
    { name: 'Eggs', quantity: 4, purchased_quantity: 18 },  // earliest event counts
    { name: 'Bread', quantity: 1, purchased_quantity: 1 },  // unreadable detail
  ]);
  db.close();
});

test('only creating an item sets purchased_quantity; consume, undo and edits leave it alone', () => {
  process.env.DB_PATH = path.join(dir, 'app.db');
  process.env.LOG_PATH = path.join(dir, 'app.log');
  const db = require('../src/db');
  const store = require('../src/store');
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Home', 'ABCDEFGH')").run();

  const item = store.insertItem(1, {
    name: 'Coke', category: 'nonperishable', location: '', tag: '', quantity: 12, unit: 'cans',
    purchase_date: null, expiration_date: null, notes: '', tracking_mode: 'count', fill_percent: null,
    low_stock_threshold: null,
  });
  assert.strictEqual(item.purchased_quantity, 12);

  let row = store.updateItemQuantity(1, item.id, {
    quantity: 9, status: 'active', prevStatus: 'active', prevQuantity: 12, thrownOutDate: null,
  });
  assert.deepStrictEqual([row.quantity, row.purchased_quantity], [9, 12]);

  row = store.undoItem(1, row);
  assert.deepStrictEqual([row.quantity, row.purchased_quantity], [12, 12]);

  row = store.updateItem(1, { ...row, quantity: 5 });
  assert.deepStrictEqual([row.quantity, row.purchased_quantity], [5, 12]);
});
