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
  assert.deepStrictEqual(b.body.trip, { id: a.body.trip.id, count: 2, todo: 0, ticked: null });

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

// --- The shopping list (household 3, from a clean slate) ---------------

const H3 = { 'x-test-household': '3' };
const list = () => call('GET', '/api/trips/list', undefined, H3);
const addToList = (body) => call('POST', '/api/trips/list/entries', body, H3);
const names = (rows) => rows.map((r) => r.name);

test('suggestions: used up, low stock and expiring, each product once', async () => {
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (3, 'Third', 'JKMNPQRS')").run();
  const item = async (body) => (await call('POST', '/api/items', body, H3)).body;
  const soon = db.prepare("SELECT date('now', 'localtime', '+2 days') AS d").get().d;
  const later = db.prepare("SELECT date('now', 'localtime', '+30 days') AS d").get().d;

  const coffee = await item({ name: 'Coffee', quantity: 1 });
  await call('POST', `/api/items/${coffee.id}/consume`, {}, H3);                 // used up
  const tea = await item({ name: 'Tea', quantity: 1 });
  await call('POST', `/api/items/${tea.id}/consume`, {}, H3);
  await item({ name: 'tea ', quantity: 2 });                                    // ...but more in stock
  const old = await item({ name: 'Old cheese', quantity: 1 });
  await call('POST', `/api/items/${old.id}/throw-out`, {}, H3);                 // thrown out counts
  await item({ name: 'Rice', quantity: 1, low_stock_threshold: 2 });            // low stock
  await item({ name: 'Yogurt', quantity: 4, expiration_date: soon });           // expiring
  await item({ name: 'Butter', quantity: 1, low_stock_threshold: 1, expiration_date: soon }); // both: low stock wins
  await item({ name: 'Flour', quantity: 5, expiration_date: later });           // nothing

  const { list: l, suggestions: s } = (await list()).body;
  assert.strictEqual(l, null);
  assert.deepStrictEqual(names(s.used).sort(), ['Coffee', 'Old cheese']);
  assert.deepStrictEqual(names(s.low_stock).sort(), ['Butter', 'Rice']);
  assert.deepStrictEqual(names(s.expiring), ['Yogurt']);
  assert.strictEqual(s.used.find((x) => x.name === 'Old cheese').how, 'thrown_out');
});

test('adding to the list: starts it, no duplicates, and leaves the suggestions', async () => {
  const a = await addToList({ name: 'Coffee', source: 'used' });
  assert.strictEqual(a.status, 201);
  assert.strictEqual(a.body.quantity, null);
  const again = await addToList({ name: ' coffee ' });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.body.id, a.body.id);
  assert.strictEqual(a.body.added, true);
  assert.strictEqual(again.body.added, false);
  const eggs = await addToList({ name: 'Eggs', quantity: 12 });
  assert.strictEqual(eggs.body.quantity, 12);
  assert.strictEqual((await addToList({ name: 'X', quantity: -1 })).status, 400);
  assert.strictEqual((await addToList({ name: '' })).status, 400);

  const { list: l, suggestions: s } = (await list()).body;
  assert.strictEqual(l.status, 'planned');
  assert.deepStrictEqual(names(l.entries), ['Eggs', 'Coffee']);
  assert.ok(!names(s.used).includes('Coffee'));
  // The list isn't a trip yet.
  assert.deepStrictEqual((await current(H3)).body, { trip: null });
});

test('list rows: change the quantity, remove one', async () => {
  const eggs = (await list()).body.list.entries.find((e) => e.name === 'Eggs');
  const changed = await call('PATCH', `/api/trips/entries/${eggs.id}`, { quantity: 6, unit: 'large' }, H3);
  assert.strictEqual(changed.body.quantity, 6);
  assert.strictEqual(changed.body.unit, 'large');
  const cleared = await call('PATCH', `/api/trips/entries/${eggs.id}`, { quantity: null }, H3);
  assert.strictEqual(cleared.body.quantity, null);
  const tmp = (await addToList({ name: 'Temp' })).body;
  assert.strictEqual((await call('DELETE', `/api/trips/entries/${tmp.id}`, undefined, H3)).status, 204);
  assert.ok(!names((await list()).body.list.entries).includes('Temp'));
  // Another household can't touch them.
  assert.strictEqual((await call('PATCH', `/api/trips/entries/${eggs.id}`, { quantity: 1 })).status, 404);
  assert.strictEqual((await call('DELETE', `/api/trips/entries/${eggs.id}`)).status, 404);
});

test('Start shopping: the list becomes the trip, and saves tick it off', async () => {
  await addToList({ name: 'Cereal', barcode: '0041192100147' });
  await addToList({ name: 'Bananas' });
  const l = (await list()).body.list;
  assert.strictEqual((await call('POST', `/api/trips/${l.id}/start`)).status, 404); // not this household's
  const started = await call('POST', `/api/trips/${l.id}/start`, {}, H3);
  assert.strictEqual(started.status, 200);
  assert.strictEqual(started.body.trip.id, l.id);
  assert.strictEqual(started.body.trip.status, 'active');
  assert.strictEqual((await list()).body.list, null);

  // Same name, different case: ticks Coffee. Barcode: ticks Cereal though
  // the scanned name differs. Something not listed: a new row.
  const c = await buy('COFFEE', {}, H3);
  assert.deepStrictEqual(c.body.trip, { id: l.id, count: 1, todo: 3, ticked: 'Coffee' });
  const w = await buy('Frosted Mini Wheats', { barcode: '0041192100147' }, H3);
  assert.strictEqual(w.body.trip.ticked, 'Cereal');
  const j = await buy('Jam', {}, H3);
  assert.strictEqual(j.body.trip.ticked, null);
  assert.strictEqual(j.body.trip.count, 3);

  // Bananas ticked by hand: on the trip, but not a saved item.
  const trip = (await current(H3)).body.trip;
  const bananas = trip.entries.find((e) => e.name === 'Bananas');
  const ticked = await call('POST', `/api/trips/entries/${bananas.id}/tick`, { ticked: true }, H3);
  assert.ok(ticked.body.bought_at);
  const after = (await current(H3)).body.trip;
  assert.strictEqual(after.count, 3);
  const still = after.entries.filter((e) => !e.bought_at);
  assert.deepStrictEqual(names(still), ['Eggs']);
  const coffeeRow = after.entries.find((e) => e.source === 'used');
  assert.strictEqual(coffeeRow.name, 'COFFEE'); // shown as the item now
  // Bought rows can't be removed; a hand tick can be undone.
  assert.strictEqual((await call('DELETE', `/api/trips/entries/${coffeeRow.id}`, undefined, H3)).status, 409);
  await call('POST', `/api/trips/entries/${bananas.id}/tick`, { ticked: false }, H3);
  assert.deepStrictEqual(names((await current(H3)).body.trip.entries.filter((e) => !e.bought_at)).sort(), ['Bananas', 'Eggs']);
});

test('Start shopping while a trip is already going joins the list to it', async () => {
  const going = (await current(H3)).body.trip;
  await addToList({ name: 'Bread' });
  const l = (await list()).body.list;
  assert.notStrictEqual(l.id, going.id);
  const started = await call('POST', `/api/trips/${l.id}/start`, {}, H3);
  assert.strictEqual(started.body.trip.id, going.id);
  assert.ok(names(started.body.trip.entries).includes('Bread'));
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM trips WHERE id = ?').get(l.id).n, 0);
  assert.strictEqual((await list()).body.list, null);
});
