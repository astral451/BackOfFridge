// Household isolation: two households with overlapping location and tag
// names, checked through the real HTTP API. Every household data endpoint
// must show each household only its own data, every :id route must 404 on
// the other household's ids (and leave them untouched), and pending accounts
// and the admin must get nothing.
//
// When you add a household data route, add it to the checks below.
//
// Run from server/: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-isolation-'));
process.env.DB_PATH = path.join(dir, 'inventory.db');
process.env.LOG_PATH = path.join(dir, 'app.log');

const app = require('../src/index');
const db = require('../src/db');

let server;
let base;

// A logged-in client: remembers its session cookie.
function client() {
  let cookie = '';
  async function call(method, url, body) {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
  return {
    get: (url) => call('GET', url),
    post: (url, body) => call('POST', url, body === undefined ? {} : body),
    patch: (url, body) => call('PATCH', url, body),
    del: (url) => call('DELETE', url),
  };
}

function runAdminScript(...args) {
  return execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'admin.js'), ...args], {
    env: process.env, encoding: 'utf8',
  });
}

const admin = client();
const alice = client(); // household A
const amy = client();   // joins household A with its invite code
const bob = client();   // household B
const pending = client();
const ids = { A: [], B: [] };
const households = {};

async function addItem(who, item) {
  const res = await who.post('/api/items', item);
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body;
}

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  // The admin login comes from the command line, as on the real server.
  const out = runAdminScript('create', 'root');
  const password = out.match(/password: (\S+)/)[1];
  assert.strictEqual((await admin.post('/api/auth/login', { username: 'root', password })).status, 200);

  // Two households, each started with an admin-issued code.
  for (const [who, name, household] of [[alice, 'alice', 'Alpha'], [bob, 'bob', 'Bravo']]) {
    const code = (await admin.post('/api/admin/codes', { note: name })).body.code;
    const res = await who.post('/api/auth/signup', { username: name, password: 'password1', code, householdName: household });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    households[household] = res.body.household.id;
  }

  // Amy joins Alpha using Alpha's invite code, as shown on Alice's Settings page.
  const aliceHousehold = await alice.get('/api/household');
  const joined = await amy.post('/api/auth/signup', { username: 'amy', password: 'password1', code: aliceHousehold.body.inviteCode });
  assert.strictEqual(joined.status, 201);
  assert.strictEqual(joined.body.household.id, households.Alpha);

  // No code: pending.
  assert.strictEqual((await pending.post('/api/auth/signup', { username: 'stranger', password: 'password1' })).status, 201);

  // Overlapping names in both households.
  for (const [who, key] of [[alice, 'A'], [bob, 'B']]) {
    await who.post('/api/locations', { name: 'Garage' });
    await who.post('/api/tags', { name: 'Spare' });
    for (const name of ['Milk', 'Rice', 'Coffee']) {
      const item = await addItem(who, { name, location: 'Pantry', tag: 'Dairy', quantity: 4, expiration_date: '2000-01-01' });
      ids[key].push(item.id);
    }
  }
  // An extra item in A, so the two households' counts differ.
  ids.A.push((await addItem(alice, { name: 'Eggs', location: 'Fridge', tag: 'Dairy', quantity: 12 })).id);
  // Garage and Spare are in use in A only; B has them as unused names.
  ids.A.push((await addItem(alice, { name: 'Tools', location: 'Garage', tag: 'Spare', quantity: 1 })).id);
  // History on one of A's items.
  await alice.post(`/api/items/${ids.A[0]}/consume`, { quantity: 1 });
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('each household lists only its own items', async () => {
  const a = await alice.get('/api/items');
  const b = await bob.get('/api/items');
  assert.deepStrictEqual(a.body.map((i) => i.id).sort(), [...ids.A].sort());
  assert.deepStrictEqual(b.body.map((i) => i.id).sort(), [...ids.B].sort());
  // Members of the same household see the same items.
  assert.deepStrictEqual((await amy.get('/api/items')).body.map((i) => i.id).sort(), [...ids.A].sort());
});

test('item filters stay inside the household', async () => {
  for (const query of ['?location=Pantry', '?tag=Dairy', '?status=active', '?category=perishable', '?expiring_within_days=3']) {
    const a = (await alice.get(`/api/items${query}`)).body;
    const b = (await bob.get(`/api/items${query}`)).body;
    assert.ok(a.every((i) => ids.A.includes(i.id)), `A ${query}`);
    assert.ok(b.every((i) => ids.B.includes(i.id)), `B ${query}`);
    assert.ok(b.length > 0, `B ${query} finds its own items`);
  }
});

test('locations, tags and stats are per household, with the same names in both', async () => {
  assert.deepStrictEqual((await alice.get('/api/locations')).body, ['Fridge', 'Garage', 'Pantry']);
  assert.deepStrictEqual((await bob.get('/api/locations')).body, ['Garage', 'Pantry']);
  assert.deepStrictEqual((await bob.get('/api/tags')).body, ['Dairy', 'Spare']);

  const aDetail = (await alice.get('/api/locations/detail')).body;
  const bDetail = (await bob.get('/api/locations/detail')).body;
  assert.strictEqual(aDetail.find((l) => l.name === 'Pantry').itemCount, 3);
  assert.strictEqual(bDetail.find((l) => l.name === 'Pantry').itemCount, 3);
  assert.strictEqual((await alice.get('/api/tags/detail')).body.find((t) => t.name === 'Dairy').itemCount, 4);
  assert.strictEqual((await bob.get('/api/tags/detail')).body.find((t) => t.name === 'Dairy').itemCount, 3);

  assert.deepStrictEqual((await alice.get('/api/stats')).body, { active: 5, expiringSoon: 3, expired: 3 });
  assert.deepStrictEqual((await bob.get('/api/stats')).body, { active: 3, expiringSoon: 3, expired: 3 });
});

test('deleting a location or tag only affects the own household', async () => {
  // Garage/Spare are used by an item in A, but not in B, so B can delete
  // its own (the in-use check counts only B's items) and A keeps its.
  assert.strictEqual((await bob.del('/api/locations/Garage')).status, 204);
  assert.strictEqual((await bob.del('/api/tags/Spare')).status, 204);
  assert.ok((await alice.get('/api/locations')).body.includes('Garage'));
  assert.ok((await alice.get('/api/tags')).body.includes('Spare'));
  // The in-use check counts only the own household's items: Fridge is used
  // in A but unknown in B.
  assert.strictEqual((await bob.del('/api/locations/Fridge')).status, 404);
  assert.strictEqual((await alice.del('/api/locations/Fridge')).status, 400);
  // Pantry is in use in B too, by B's own items.
  assert.strictEqual((await bob.del('/api/locations/Pantry')).status, 400);
});

test("every :id route 404s on another household's item and leaves it untouched", async () => {
  const target = ids.A[0];
  const before = (await alice.get(`/api/items/${target}`)).body;
  const historyBefore = (await alice.get(`/api/items/${target}/history`)).body;

  const attempts = [
    ['get', `/api/items/${target}`],
    ['get', `/api/items/${target}/history`],
    ['patch', `/api/items/${target}`, { name: 'Hijacked', quantity: 0 }],
    ['post', `/api/items/${target}/consume`, { quantity: 1 }],
    ['post', `/api/items/${target}/throw-out`, {}],
    ['post', `/api/items/${target}/undo`, {}],
    ['del', `/api/items/${target}`],
  ];
  for (const [method, url, body] of attempts) {
    const res = await bob[method](url, body);
    assert.strictEqual(res.status, 404, `${method.toUpperCase()} ${url} should 404 for another household`);
    assert.deepStrictEqual(res.body, { error: 'not found' }, 'indistinguishable from a missing id');
  }
  // Same answer as an id that doesn't exist at all.
  assert.deepStrictEqual((await bob.get('/api/items/999999')).body, { error: 'not found' });

  assert.deepStrictEqual((await alice.get(`/api/items/${target}`)).body, before);
  assert.deepStrictEqual((await alice.get(`/api/items/${target}/history`)).body, historyBefore);
});

test('a household id sent by the client is ignored', async () => {
  const sneaky = await alice.post(`/api/items?household_id=${households.Bravo}`, {
    name: 'Sneaky', location: 'Pantry', household_id: households.Bravo,
  });
  assert.strictEqual(sneaky.status, 201);
  assert.strictEqual(db.prepare('SELECT household_id FROM items WHERE id = ?').get(sneaky.body.id).household_id, households.Alpha);
  ids.A.push(sneaky.body.id);

  await alice.patch(`/api/items/${sneaky.body.id}`, { name: 'Still mine', household_id: households.Bravo });
  assert.strictEqual(db.prepare('SELECT household_id FROM items WHERE id = ?').get(sneaky.body.id).household_id, households.Alpha);

  const bList = (await bob.get(`/api/items?household_id=${households.Alpha}`)).body;
  assert.ok(bList.every((i) => ids.B.includes(i.id)));
});

test('every event is recorded in the household it happened in', () => {
  const wrong = db.prepare(`
    SELECT e.id FROM item_events e JOIN items i ON i.id = e.item_id WHERE e.household_id != i.household_id
  `).all();
  assert.deepStrictEqual(wrong, []);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM item_events WHERE household_id IS NULL').get().n, 0);
});

const HOUSEHOLD_ENDPOINTS = [
  ['get', '/api/items'],
  ['get', '/api/items/1'],
  ['get', '/api/items/1/history'],
  ['post', '/api/items', { name: 'X' }],
  ['patch', '/api/items/1', { name: 'X' }],
  ['post', '/api/items/1/consume', {}],
  ['post', '/api/items/1/throw-out', {}],
  ['post', '/api/items/1/undo', {}],
  ['del', '/api/items/1'],
  ['get', '/api/locations'],
  ['get', '/api/locations/detail'],
  ['post', '/api/locations', { name: 'X' }],
  ['del', '/api/locations/Pantry'],
  ['get', '/api/tags'],
  ['get', '/api/tags/detail'],
  ['post', '/api/tags', { name: 'X' }],
  ['del', '/api/tags/Dairy'],
  ['get', '/api/stats'],
  ['get', '/api/household'],
  ['post', '/api/household/invite-code', {}],
];

test('a pending account gets no household data', async () => {
  for (const [method, url, body] of HOUSEHOLD_ENDPOINTS) {
    const res = await pending[method](url, body);
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${url}`);
    assert.strictEqual(res.body.reason, 'pending');
  }
});

test('the admin account gets no household data', async () => {
  for (const [method, url, body] of HOUSEHOLD_ENDPOINTS) {
    const res = await admin[method](url, body);
    assert.strictEqual(res.status, 403, `${method.toUpperCase()} ${url}`);
    assert.strictEqual(res.body.reason, 'admin');
  }
});

test('household members cannot use admin routes', async () => {
  for (const [method, url, body] of [
    ['get', '/api/admin/summary'], ['get', '/api/admin/households'], ['post', '/api/admin/households', { name: 'X' }],
    ['patch', `/api/admin/households/${households.Alpha}`, { name: 'X' }], ['get', '/api/admin/codes'],
    ['post', '/api/admin/codes', {}], ['del', '/api/admin/codes/ABCDEFGH'], ['get', '/api/admin/pending'],
    ['post', '/api/admin/users/1/approve', { householdId: households.Alpha }], ['post', '/api/admin/users/1/reject'],
  ]) {
    assert.strictEqual((await alice[method](url, body)).status, 403, `${method.toUpperCase()} ${url}`);
  }
});

test('not logged in gets 401 everywhere', async () => {
  const anon = client();
  for (const [method, url, body] of HOUSEHOLD_ENDPOINTS) {
    assert.strictEqual((await anon[method](url, body)).status, 401, `${method.toUpperCase()} ${url}`);
  }
});

test('each household sees only its own invite code and members', async () => {
  const a = (await alice.get('/api/household')).body;
  const b = (await bob.get('/api/household')).body;
  assert.deepStrictEqual(a.members, ['alice', 'amy']);
  assert.deepStrictEqual(b.members, ['bob']);
  assert.notStrictEqual(a.inviteCode, b.inviteCode);

  // Regenerating: the old code stops working, members stay.
  const fresh = (await bob.post('/api/household/invite-code')).body;
  assert.notStrictEqual(fresh.inviteCode, b.inviteCode);
  assert.strictEqual((await client().post('/api/auth/check-code', { code: b.inviteCode })).status, 404);
  assert.deepStrictEqual(fresh.members, ['bob']);
});

test('a new-household code works once', async () => {
  const code = (await admin.post('/api/admin/codes', {})).body.code;
  assert.strictEqual((await client().post('/api/auth/signup', { username: 'c1', password: 'password1', code, householdName: 'Charlie' })).status, 201);
  const again = await client().post('/api/auth/signup', { username: 'c2', password: 'password1', code, householdName: 'Charlie 2' });
  assert.strictEqual(again.status, 400);
  assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM users WHERE username = 'c2'").get().n, 0);
});

test('approval lets a pending account in, to exactly one household', async () => {
  const id = db.prepare("SELECT id FROM users WHERE username = 'stranger'").get().id;
  assert.strictEqual((await admin.post(`/api/admin/users/${id}/approve`, { householdId: households.Bravo })).status, 200);
  const items = await pending.get('/api/items');
  assert.strictEqual(items.status, 200);
  assert.deepStrictEqual(items.body.map((i) => i.id).sort(), [...ids.B].sort());
});

test('a rejected account cannot log in', async () => {
  const late = client();
  await late.post('/api/auth/signup', { username: 'late', password: 'password1' });
  const id = db.prepare("SELECT id FROM users WHERE username = 'late'").get().id;
  assert.strictEqual((await admin.post(`/api/admin/users/${id}/reject`)).status, 204);
  assert.strictEqual((await late.get('/api/items')).status, 401, 'existing session ended');
  assert.strictEqual((await late.post('/api/auth/login', { username: 'late', password: 'password1' })).status, 403);
});

test('admin grant and revoke from the command line take effect immediately', async () => {
  runAdminScript('grant', 'bob');
  assert.strictEqual((await bob.get('/api/admin/summary')).status, 200);
  assert.strictEqual((await bob.get('/api/items')).status, 200, 'keeps their household');
  runAdminScript('revoke', 'bob');
  assert.strictEqual((await bob.get('/api/admin/summary')).status, 403);
});
