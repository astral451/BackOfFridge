// Shared shopping trips (migration 006, src/trips.js, routes/trips.js):
// saves with trip: true go into the household's one current trip, two
// people's saves land in the same one, an idle trip ends itself, and one
// household never sees another's trip.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-trips-'));
process.env.DB_PATH = path.join(dir, 'inventory.db');
process.env.LOG_PATH = path.join(dir, 'app.log');

let server;
let base;
let db;

before(async () => {
  db = require('../src/db');
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Home', 'ABCDEFGH'), (2, 'Other', 'HGFEDCBA')").run();
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    const h = Number(req.headers['x-test-household'] || 1);
    req.user = { status: 'active', householdId: h };
    req.householdId = h;
    req.username = req.headers['x-test-user'] || 'sam';
    next();
  });
  app.use('/api/items', require('../src/routes/items'));
  app.use('/api/trips', require('../src/routes/trips'));
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const buy = (name, extra = {}, headers = {}) => call('POST', '/api/items', { name, trip: true, ...extra }, headers);
const current = (headers) => call('GET', '/api/trips/current', undefined, headers);

test('no trip until something is saved into one', async () => {
  assert.deepStrictEqual((await current()).body, { trip: null });
  const plain = await call('POST', '/api/items', { name: 'Not on a trip' });
  assert.strictEqual(plain.status, 201);
  assert.strictEqual(plain.body.trip, undefined);
  assert.deepStrictEqual((await current()).body, { trip: null });
});

test('two people saving land in one shared trip, newest first', async () => {
  const a = await buy('Eggs', { quantity: 12, location: 'Fridge' });
  assert.strictEqual(a.status, 201);
  assert.match(a.body.trip.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.strictEqual(a.body.trip.count, 1);
  const b = await buy('Bread', {}, { 'x-test-user': 'alex' });
  assert.deepStrictEqual(b.body.trip, { id: a.body.trip.id, count: 2 });

  const trip = (await current()).body.trip;
  assert.strictEqual(trip.id, a.body.trip.id);
  assert.strictEqual(trip.status, 'active');
  assert.strictEqual(trip.count, 2);
  assert.deepStrictEqual(trip.entries.map((e) => [e.name, e.added_by]), [['Bread', 'alex'], ['Eggs', 'sam']]);
  assert.strictEqual(trip.entries[1].quantity, 12);
  assert.strictEqual(trip.entries[1].location, 'Fridge');
});

test('rows show the item as it is now, and deleted items stay listed', async () => {
  const trip = (await current()).body.trip;
  const eggs = trip.entries.find((e) => e.name === 'Eggs');
  const bread = trip.entries.find((e) => e.name === 'Bread');
  await call('PATCH', `/api/items/${eggs.item_id}`, { name: 'Large eggs' });
  await call('DELETE', `/api/items/${bread.item_id}`);
  const after = (await current()).body.trip.entries;
  assert.deepStrictEqual(after.map((e) => [e.name, e.deleted]), [['Bread', true], ['Large eggs', false]]);
});

test('another household sees none of it, and has its own trip', async () => {
  const other = { 'x-test-household': '2' };
  assert.deepStrictEqual((await current(other)).body, { trip: null });
  const mine = (await current()).body.trip;
  assert.strictEqual((await call('POST', `/api/trips/${mine.id}/end`, {}, other)).status, 404);
  const theirs = await buy('Milk', {}, other);
  assert.notStrictEqual(theirs.body.trip.id, mine.id);
  assert.strictEqual(theirs.body.trip.count, 1);
  assert.strictEqual((await current()).body.trip.count, 2);
});

test('End trip: the items stay, the next save starts a new trip', async () => {
  const before = (await current()).body.trip;
  assert.strictEqual((await call('POST', `/api/trips/${before.id}/end`)).status, 204);
  assert.deepStrictEqual((await current()).body, { trip: null });
  assert.strictEqual(db.prepare("SELECT status FROM trips WHERE id = ?").get(before.id).status, 'done');
  const next = await buy('Butter');
  assert.notStrictEqual(next.body.trip.id, before.id);
  assert.strictEqual(next.body.trip.count, 1);
  assert.ok(db.prepare("SELECT 1 FROM items WHERE name = 'Large eggs'").get());
});

test('a trip with no save for 3 hours ends by itself', async () => {
  const trip = (await current()).body.trip;
  db.prepare("UPDATE trips SET last_activity_at = datetime('now', '-3 hours', '-1 minute') WHERE id = ?").run(trip.id);
  assert.deepStrictEqual((await current()).body, { trip: null });
  const row = db.prepare('SELECT status, ended_at, last_activity_at FROM trips WHERE id = ?').get(trip.id);
  assert.strictEqual(row.status, 'done');
  assert.strictEqual(row.ended_at, row.last_activity_at);
  const next = await buy('Jam');
  assert.notStrictEqual(next.body.trip.id, trip.id);
});

test('a trip just under 3 hours idle is still current', async () => {
  const trip = (await current()).body.trip;
  db.prepare("UPDATE trips SET last_activity_at = datetime('now', '-2 hours', '-59 minutes') WHERE id = ?").run(trip.id);
  assert.strictEqual((await current()).body.trip.id, trip.id);
});
