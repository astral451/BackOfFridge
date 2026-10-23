#!/usr/bin/env node
// Admin account management, from the server's command line only. Shell
// access to the server is the proof of ownership: there's no web route that
// grants admin and no admin password in any env file.
//
//   node scripts/admin.js create <username>          new dedicated admin login (no household)
//   node scripts/admin.js grant <username>           make an existing login an admin
//   node scripts/admin.js revoke <username>          remove admin from a login
//   node scripts/admin.js reset-password <username>  new password for any login
//   node scripts/admin.js list                       admins, and pending accounts
//
// With Docker: docker compose exec backoffridge node scripts/admin.js <command> ...
//
// Passwords are generated and printed once; there's nothing to type, so
// nothing ends up in shell history.

const crypto = require('crypto');
const db = require('../src/db');
const auth = require('../src/auth');

const [command, username] = process.argv.slice(2);

function usage() {
  console.error('Usage: node scripts/admin.js create|grant|revoke|reset-password <username>');
  console.error('       node scripts/admin.js list');
  process.exit(1);
}

function generatePassword() {
  // 15 random bytes -> 20 base64url characters
  return crypto.randomBytes(15).toString('base64url');
}

function findUser(name) {
  const user = db.prepare(`
    SELECT id, username, household_id AS householdId, status, is_admin AS isAdmin FROM users WHERE username = ?
  `).get(name);
  if (!user) {
    console.error(`No login named "${name}".`);
    process.exit(1);
  }
  return user;
}

function printPassword(name, password) {
  console.log('');
  console.log(`  username: ${name}`);
  console.log(`  password: ${password}`);
  console.log('');
  console.log('This is the only time the password is shown. Store it somewhere safe.');
}

if (!command) usage();

switch (command) {
  case 'create': {
    if (!username) usage();
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      console.error(`A login named "${username}" already exists. Use "grant" to make it an admin.`);
      process.exit(1);
    }
    const password = generatePassword();
    db.prepare(`
      INSERT INTO users (username, password_hash, household_id, status, is_admin) VALUES (?, ?, NULL, 'active', 1)
    `).run(username, auth.hashPassword(password));
    console.log(`Created admin login "${username}". It has no household: it can only use the admin page.`);
    printPassword(username, password);
    break;
  }

  case 'grant': {
    if (!username) usage();
    const user = findUser(username);
    if (user.isAdmin) {
      console.log(`"${username}" is already an admin.`);
      break;
    }
    db.prepare("UPDATE users SET is_admin = 1, status = 'active' WHERE id = ?").run(user.id);
    console.log(`"${username}" is now an admin.`);
    if (user.householdId) {
      console.log(`Note: it stays a member of household ${user.householdId} too. For everyday use, a separate`);
      console.log('admin login ("create") is safer than giving admin to a household login.');
    }
    break;
  }

  case 'revoke': {
    if (!username) usage();
    const user = findUser(username);
    if (!user.isAdmin) {
      console.log(`"${username}" is not an admin.`);
      break;
    }
    db.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').run(user.id);
    console.log(`"${username}" is no longer an admin (effective immediately).`);
    if (!user.householdId) {
      console.log('It has no household either, so it can no longer do anything after logging in.');
    }
    break;
  }

  case 'reset-password': {
    if (!username) usage();
    const user = findUser(username);
    const password = generatePassword();
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(password), user.id);
    auth.destroyUserSessions(user.id);
    console.log(`New password set for "${username}"; it has been logged out everywhere.`);
    printPassword(username, password);
    break;
  }

  case 'list': {
    const admins = db.prepare(`
      SELECT u.username, u.household_id AS householdId, h.name AS householdName
      FROM users u LEFT JOIN households h ON h.id = u.household_id
      WHERE u.is_admin = 1 ORDER BY u.username
    `).all();
    console.log(admins.length ? 'Admins:' : 'No admins yet. Create one with: node scripts/admin.js create <username>');
    for (const a of admins) {
      console.log(`  ${a.username}${a.householdId ? `  (also a member of household ${a.householdId} "${a.householdName}")` : ''}`);
    }
    const pending = db.prepare("SELECT username, created_at AS createdAt FROM users WHERE status = 'pending' ORDER BY created_at").all();
    if (pending.length) {
      console.log(`Pending accounts waiting for approval: ${pending.length}`);
      for (const p of pending) console.log(`  ${p.username}  (signed up ${p.createdAt} UTC)`);
    }
    break;
  }

  default:
    usage();
}
