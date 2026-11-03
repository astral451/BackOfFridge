// Fill level applies to the one open unit (features.md, "Quantity model",
// step 2): finishing it drops the quantity by one and starts the next unit
// at 100%, undo puts the old percentage back, and low stock waits for the
// last unit. Runs the real items routes behind a stub login.
// Run from server/: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-fill-'));
process.env.DB_PATH = path.join(dir, 'inventory.db');
process.env.LOG_PATH = path.join(dir, 'app.log');

const db = require('../src/db');
const itemsRouter = require('../src/routes/items');

let server;
let base;

before(async () => {
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Home', 'ABCDEFGH')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { status: 'active', householdId: 1 };
    req.householdId = 1;
    req.username = 'tester';
    next();
  });
  app.use('/api/items', itemsRouter);
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function milk(quantity, fill_percent) {
  const res = await call('POST', '/api/items', {
    name: 'Milk', unit: 'gal', quantity, tracking_mode: 'fill_level', fill_percent,
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

const pick = (r) => ({ status: r.status, quantity: r.quantity, fill_percent: r.fill_percent, low_stock: r.low_stock });

test('finishing the open jug of two leaves one full jug, not nothing', async () => {
  const item = await milk(2, 10);
  const res = await call('POST', `/api/items/${item.id}/consume`, { quantity: 1 });
  assert.deepStrictEqual(pick(res.body), { status: 'active', quantity: 1, fill_percent: 100, low_stock: false });
});

test('finishing the last jug consumes the item, as before', async () => {
  const item = await milk(1, 10);
  const res = await call('POST', `/api/items/${item.id}/consume`, { quantity: 1 });
  assert.deepStrictEqual(
    [res.body.status, res.body.quantity, res.body.fill_percent],
    ['consumed', 0, 10]
  );
});

test('throwing out the open jug also starts the next one full', async () => {
  const item = await milk(3, 60);
  const res = await call('POST', `/api/items/${item.id}/throw-out`, { quantity: 1 });
  assert.deepStrictEqual(pick(res.body), { status: 'active', quantity: 2, fill_percent: 100, low_stock: false });
});

test('consuming with no quantity still uses up everything', async () => {
  const item = await milk(2, 50);
  const res = await call('POST', `/api/items/${item.id}/consume`, {});
  assert.strictEqual(res.body.status, 'consumed');
  assert.strictEqual(res.body.quantity, 0);
});

test('undo brings back the jug and its old percentage', async () => {
  const item = await milk(2, 10);
  await call('POST', `/api/items/${item.id}/consume`, { quantity: 1 });
  const res = await call('POST', `/api/items/${item.id}/undo`);
  assert.deepStrictEqual(pick(res.body), { status: 'active', quantity: 2, fill_percent: 10, low_stock: false });
  assert.strictEqual(res.body.prev_fill_percent, null);

  const history = (await call('GET', `/api/items/${item.id}/history`)).body;
  const consumed = history.find((e) => e.event_type === 'consumed');
  assert.deepStrictEqual(consumed.detail, { quantity: 1, unit: 'gal', open_fill_percent: 10 });
  const undo = history.find((e) => e.event_type === 'undo');
  assert.strictEqual(undo.detail.restored_fill_percent, 10);
});

test('low stock only once the last unit is low', async () => {
  const two = await milk(2, 20);
  assert.strictEqual(two.low_stock, false, 'a full backup jug means not low');

  const one = await milk(1, 20);
  assert.strictEqual(one.low_stock, true);

  const res = await call('POST', `/api/items/${two.id}/consume`, { quantity: 1 });
  assert.strictEqual(res.body.low_stock, false, 'next jug is full');
  const lowered = await call('PATCH', `/api/items/${two.id}`, { fill_percent: 20 });
  assert.strictEqual(lowered.body.low_stock, true);
});

test('count items are unaffected: fill_percent stays null and undo works as before', async () => {
  const res = await call('POST', '/api/items', { name: 'Coke', quantity: 12, unit: 'cans' });
  const id = res.body.id;
  const consumed = await call('POST', `/api/items/${id}/consume`, { quantity: 1 });
  assert.deepStrictEqual(pick(consumed.body), { status: 'active', quantity: 11, fill_percent: null, low_stock: false });
  const undone = await call('POST', `/api/items/${id}/undo`);
  assert.deepStrictEqual(pick(undone.body), { status: 'active', quantity: 12, fill_percent: null, low_stock: false });
  assert.strictEqual(undone.body.purchased_quantity, 12);
});
