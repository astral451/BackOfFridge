// Who has been using the app recently, so an update can wait for a quiet
// moment (see restart.sh and scripts/activity.js).
//
// Every signed-in API request counts. The pages also send a small heartbeat
// (POST /api/ping, from public/connection.js) every 60 s while they're open
// and visible, so an app that's open but idle still shows up. "Online" means
// seen in the last 2 minutes: long enough to cover a missed heartbeat, short
// enough that a phone that's been locked drops off soon after.
//
// Kept in memory and written to activity.json next to the database a few
// seconds after a change (and on shutdown), so it survives restarts and can
// be read from outside the running server. Only usernames and times are
// stored.

const fs = require('fs');
const path = require('path');

const ONLINE_WINDOW_MS = 2 * 60 * 1000;
const FLUSH_DELAY_MS = 5000;

const DATA_DIR = path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'inventory.db'));
const FILE = path.join(DATA_DIR, 'activity.json');

function load() {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return data && data.lastSeen && typeof data.lastSeen === 'object' ? data.lastSeen : {};
  } catch (e) {
    return {};
  }
}

const lastSeen = load(); // username -> ISO time
let flushTimer = null;

// Writes activity.json now. Written to a temp file and renamed, so a reader
// never sees half a file.
function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  const tmp = FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ writtenAt: new Date().toISOString(), lastSeen }, null, 2) + '\n');
    fs.renameSync(tmp, FILE);
  } catch (e) {
    // A convenience only: never break a request over it.
  }
}

function record(username, when = new Date()) {
  lastSeen[username] = when.toISOString();
  if (!flushTimer) {
    flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
    flushTimer.unref();
  }
}

// { online, people }: everyone ever seen, most recent first, each
// { username, lastSeen, secondsAgo }; online is the ones inside the window.
function summarize(map, now = Date.now()) {
  const people = Object.entries(map)
    .map(([username, t]) => ({ username, lastSeen: t, secondsAgo: Math.max(0, Math.round((now - Date.parse(t)) / 1000)) }))
    .filter((p) => !Number.isNaN(p.secondsAgo))
    .sort((a, b) => a.secondsAgo - b.secondsAgo);
  return { online: people.filter((p) => p.secondsAgo * 1000 <= ONLINE_WINDOW_MS), people };
}

function summary(now) {
  return summarize(lastSeen, now);
}

module.exports = { record, flush, summary, summarize, load, FILE, DATA_DIR, ONLINE_WINDOW_MS };
