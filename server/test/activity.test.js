// Update safety: who's online (activity tracking, the heartbeat,
// scripts/activity.js) and the maintenance switch restart.sh flips before
// stopping the server. Uses the full app, with sessions made directly.
// Run from server/: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-activity-'));
process.env.DB_PATH = path.join(dir, 'inventory.db');
process.env.LOG_PATH = path.join(dir, 'app.log');

const app = require('../src/index');
const db = require('../src/db');
const auth = require('../src/auth');
const activity = require('../src/activity');

let server;
let base;
let memberCookie;
let adminCookie;

before(async () => {
  db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Home', 'ABCDEFGH')").run();
  const member = db.prepare("INSERT INTO users (username, password_hash, household_id, status) VALUES ('sam', 'x', 1, 'active')").run();
  const admin = db.prepare("INSERT INTO users (username, password_hash, status, is_admin) VALUES ('root', 'x', 'active', 1)").run();
  memberCookie = `session_token=${auth.createSession(member.lastInsertRowid)}`;
  adminCookie = `session_token=${auth.createSession(admin.lastInsertRowid)}`;
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, url, cookie) {
  const res = await fetch(base + url, { method, headers: cookie ? { Cookie: cookie } : {} });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a signed-in request marks the user as online; signed-out ones count for nothing', async () => {
  await call('GET', '/api/items');
  assert.deepStrictEqual(activity.summary().people, []);

  await call('GET', '/api/items', memberCookie);
  const { online } = activity.summary();
  assert.deepStrictEqual(online.map((p) => p.username), ['sam']);
});

test('the heartbeat answers 204, counts as activity, and stays out of the log', async () => {
  const res = await call('POST', '/api/ping', adminCookie);
  assert.strictEqual(res.status, 204);
  assert.ok(activity.summary().online.some((p) => p.username === 'root'), 'the admin (no household) can ping too');

  await wait(50); // the log is appended asynchronously
  const logText = fs.readFileSync(process.env.LOG_PATH, 'utf8');
  assert.match(logText, /ACCESS GET \/api\/items .* as sam/);
  assert.doesNotMatch(logText, /\/api\/ping/);
});

test('"online" means seen in the last 2 minutes', () => {
  const now = Date.parse('2026-11-05T12:00:00Z');
  const { online, people } = activity.summarize({
    recent: '2026-11-05T11:59:30Z',
    edge: '2026-11-05T11:58:00Z',
    gone: '2026-11-05T11:57:59Z',
    old: '2026-11-04T09:00:00Z',
    junk: 'not a date',
  }, now);
  assert.deepStrictEqual(online.map((p) => p.username), ['recent', 'edge']);
  assert.deepStrictEqual(people.map((p) => [p.username, p.secondsAgo]),
    [['recent', 30], ['edge', 120], ['gone', 121], ['old', 97200]]);
});

test('activity is written next to the database: usernames and times only', () => {
  activity.flush();
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'activity.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(data).sort(), ['lastSeen', 'writtenAt']);
  assert.deepStrictEqual(Object.keys(data.lastSeen).sort(), ['root', 'sam']);
  assert.deepStrictEqual(activity.load(), data.lastSeen, 'and read back after a restart');
});

test('the admin sees who is online; members can\'t', async () => {
  const res = await call('GET', '/api/admin/activity', adminCookie);
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(res.body.online.map((p) => p.username).sort(), ['root', 'sam']);
  assert.strictEqual((await call('GET', '/api/admin/activity', memberCookie)).status, 403);
});

function runActivityScript(lastSeen) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-activity-cli-'));
  try {
    if (lastSeen) {
      fs.writeFileSync(path.join(scratch, 'activity.json'), JSON.stringify({ writtenAt: new Date().toISOString(), lastSeen }));
    }
    return spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'activity.js')], {
      env: { ...process.env, DB_PATH: path.join(scratch, 'inventory.db') },
      encoding: 'utf8',
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

test('scripts/activity.js exits 3 when someone is online, so restart.sh can ask', () => {
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();

  const busy = runActivityScript({ sam: ago(40), root: ago(3 * 3600) });
  assert.strictEqual(busy.status, 3, busy.stderr);
  assert.match(busy.stdout, /Online now .*: sam \(40 s ago\)/);
  assert.match(busy.stdout, /root\s+3 h ago/);

  const quiet = runActivityScript({ sam: ago(10 * 60) });
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.match(quiet.stdout, /Nobody online now/);
  assert.match(quiet.stdout, /sam\s+10 min ago/);

  const none = runActivityScript(null);
  assert.strictEqual(none.status, 0, none.stderr);
  assert.match(none.stdout, /No activity recorded yet/);
});

test('while data/MAINTENANCE exists, API calls get a "being updated" 503; pages still load', async () => {
  const flag = path.join(dir, 'MAINTENANCE');
  fs.writeFileSync(flag, '');
  try {
    for (const [method, url] of [['GET', '/api/items'], ['POST', '/api/ping'], ['GET', '/api/auth/me']]) {
      const res = await call(method, url, memberCookie);
      assert.strictEqual(res.status, 503, `${method} ${url}`);
      assert.deepStrictEqual(res.body, { error: 'The server is being updated.', maintenance: true });
    }
    const page = await fetch(base + '/index.html');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /<script src="connection.js"><\/script>/);
  } finally {
    fs.rmSync(flag);
  }
  assert.strictEqual((await call('GET', '/api/items', memberCookie)).status, 200);
});
