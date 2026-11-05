#!/usr/bin/env node
// Who's using the app: check before updating the server.
//
//   node scripts/activity.js
//
// With Docker: docker compose exec backoffridge node scripts/activity.js
//
// Prints who's online now (seen in the last 2 minutes, which includes an
// open, visible page's heartbeat) and when each person was last active.
// Exit code 0 when nobody is online, 3 when someone is; restart.sh uses
// that to ask before updating.
//
// Reads data/activity.json, which the running server keeps up to date
// (within about 5 seconds). It doesn't open the database.

const fs = require('fs');
const activity = require('../src/activity');

function ago(seconds) {
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

if (!fs.existsSync(activity.FILE)) {
  console.log('No activity recorded yet. The server writes it once someone uses the app.');
  process.exit(0);
}

const { online, people } = activity.summary();
const windowMinutes = activity.ONLINE_WINDOW_MS / 60000;

if (online.length) {
  console.log(`Online now (active in the last ${windowMinutes} minutes): `
    + online.map((p) => `${p.username} (${ago(p.secondsAgo)})`).join(', '));
} else {
  console.log(`Nobody online now (no activity in the last ${windowMinutes} minutes).`);
}

if (people.length) {
  console.log('Last activity:');
  const width = Math.max(...people.map((p) => p.username.length));
  for (const p of people) {
    const when = p.lastSeen.slice(0, 16).replace('T', ' ');
    console.log(`  ${p.username.padEnd(width)}  ${ago(p.secondsAgo).padEnd(12)} (${when} UTC)`);
  }
}

process.exit(online.length ? 3 : 0);
