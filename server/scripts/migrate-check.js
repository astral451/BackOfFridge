#!/usr/bin/env node
// Dry run of the schema migrations against a copy of a real database.
//
//   node scripts/migrate-check.js <path/to/inventory.db> [--keep]
//
// The file you name is never opened for writing: it (and its -wal file, if
// there is one) is copied to a temporary folder, and the migrations run on
// that copy using exactly the code the server runs at startup. The script
// prints the schema version and row counts before and after (per household
// too, once households exist), whether every existing row in each table came
// through unchanged, and an integrity check. The copy is deleted afterwards
// unless --keep is given.
//
// Exit code: 0 if the migrations applied and the result passed the integrity
// check, 1 otherwise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { migrate, currentVersion, MIGRATIONS } = require('../src/migrate');

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const source = args.find((a) => !a.startsWith('--'));

if (!source) {
  console.error('Usage: node scripts/migrate-check.js <path/to/inventory.db> [--keep]');
  process.exit(1);
}
if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
  console.error(`Not a file: ${source}`);
  if (fs.existsSync('/.dockerenv')) {
    console.error('(Running inside Docker: use the path as mounted in the container, e.g. /backups/<timestamp>/inventory.db.)');
  }
  process.exit(1);
}

function fileHash(p) {
  return fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
}

const sourceFiles = [source, `${source}-wal`];
const hashesBefore = sourceFiles.map(fileHash);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bof-migrate-check-'));
const copy = path.join(workDir, 'inventory.db');
fs.copyFileSync(source, copy);
const walSize = fs.existsSync(`${source}-wal`) ? fs.statSync(`${source}-wal`).size : 0;
if (fs.existsSync(`${source}-wal`)) fs.copyFileSync(`${source}-wal`, `${copy}-wal`);

const db = new Database(copy);

function tables() {
  return db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
    ORDER BY name
  `).all().map((r) => r.name);
}

function columns(table) {
  return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
}

// A table's rows over the given columns, as a multiset of JSON strings, so a
// table rebuilt by a migration (new row order, new rowids) still matches if
// its contents are the same.
function rowSet(table, cols) {
  const list = cols.map((c) => `"${c}"`).join(', ');
  const counts = new Map();
  for (const row of db.prepare(`SELECT ${list} FROM "${table}"`).raw().all()) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

// How many of `prev`'s rows are missing from `now`.
function missingRows(prev, now) {
  let missing = 0;
  for (const [key, n] of prev) missing += Math.max(0, n - (now.get(key) || 0));
  return missing;
}

function snapshot() {
  const snap = { version: currentVersion(db), tables: {} };
  for (const t of tables()) {
    const cols = columns(t);
    snap.tables[t] = {
      columns: cols,
      count: db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n,
      rows: rowSet(t, cols),
    };
  }
  return snap;
}

// Row counts per household, for every table that has a household_id column.
// Empty until a migration adds households.
function householdBreakdown() {
  const names = {};
  if (tables().includes('households')) {
    for (const h of db.prepare('SELECT id, name FROM households').all()) names[h.id] = h.name;
  }
  const lines = [];
  for (const t of tables()) {
    if (!columns(t).includes('household_id')) continue;
    for (const r of db.prepare(`SELECT household_id AS h, COUNT(*) AS n FROM "${t}" GROUP BY household_id ORDER BY household_id`).all()) {
      const label = r.h === null ? '(no household)' : `#${r.h}${names[r.h] !== undefined ? ` "${names[r.h]}"` : ''}`;
      lines.push(`  ${t.padEnd(20)} ${label.padEnd(28)} ${String(r.n).padStart(7)}`);
    }
  }
  return lines;
}

function describeVersion(v) {
  return v === null ? 'unversioned (no schema_migrations table yet)' : `version ${v}`;
}

function printCounts(snap) {
  for (const [t, info] of Object.entries(snap.tables)) {
    console.log(`  ${t.padEnd(20)} ${String(info.count).padStart(7)}`);
  }
}

let ok = true;

console.log(`Checking: ${path.resolve(source)}`);
if (walSize > 0) {
  console.log(`  Note: found a non-empty ${path.basename(source)}-wal (${walSize} bytes) and copied it too.`);
  console.log('  If this is the live database of a running server, the copy may be mid-write;');
  console.log('  a backup taken by restart.sh (server stopped) is the reliable thing to check.');
}
console.log(`Working copy: ${copy}`);
console.log(`This code's migrations: ${MIGRATIONS.map((m) => `${m.version} ${m.name}`).join(', ')}`);
console.log('');

const before = snapshot();
console.log(`BEFORE: ${describeVersion(before.version)}`);
printCounts(before);
const hhBefore = householdBreakdown();
if (hhBefore.length) {
  console.log('  per household:');
  hhBefore.forEach((l) => console.log(l));
}
console.log('');

let result;
try {
  result = migrate(db, { log: (m) => console.log(`  ${m}`) });
} catch (err) {
  ok = false;
  console.log(`MIGRATION FAILED: ${err.message}`);
  console.log(`The copy was left at ${describeVersion(currentVersion(db))} (the failed migration rolled back).`);
}

if (result) {
  if (!result.applied.length) console.log('  Nothing to apply: already at the newest version.');
  console.log('');

  const after = snapshot();
  console.log(`AFTER: ${describeVersion(after.version)}`);
  for (const [t, info] of Object.entries(after.tables)) {
    const prev = before.tables[t];
    const delta = prev ? info.count - prev.count : null;
    const note = !prev ? '  (new table)' : delta ? `  (${delta > 0 ? '+' : ''}${delta})` : '';
    console.log(`  ${t.padEnd(20)} ${String(info.count).padStart(7)}${note}`);
  }
  const hhAfter = householdBreakdown();
  if (hhAfter.length) {
    console.log('  per household:');
    hhAfter.forEach((l) => console.log(l));
  }
  console.log('');

  // Did the rows that were already there come through unchanged? Compared
  // over the table's original columns only, so a new column (e.g.
  // household_id) doesn't count as a change to existing data.
  console.log('Existing data:');
  for (const [t, prev] of Object.entries(before.tables)) {
    const now = after.tables[t];
    if (!now) {
      console.log(`  ${t.padEnd(20)} TABLE REMOVED`);
      continue;
    }
    const removedCols = prev.columns.filter((c) => !now.columns.includes(c));
    if (removedCols.length) {
      console.log(`  ${t.padEnd(20)} COLUMNS REMOVED: ${removedCols.join(', ')}`);
      continue;
    }
    const added = now.columns.filter((c) => !prev.columns.includes(c));
    const missing = missingRows(prev.rows, rowSet(t, prev.columns));
    const extra = now.count - prev.count;
    let status = missing ? `${missing} EXISTING ROW(S) CHANGED OR REMOVED` : 'existing rows unchanged';
    if (!missing && extra) status += `, ${extra} row(s) added`;
    if (added.length) status += `; new columns: ${added.join(', ')}`;
    console.log(`  ${t.padEnd(20)} ${status}`);
  }
  console.log('');

  // Once households exist, every data row must belong to one, and so must
  // every active account other than the admin.
  if (after.tables.households) {
    console.log('Household checks:');
    for (const t of ['items', 'item_events', 'locations', 'tags']) {
      const n = db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE household_id IS NULL`).get().n;
      console.log(`  ${t.padEnd(20)} ${n ? `${n} ROW(S) WITH NO HOUSEHOLD` : 'all rows have a household'}`);
      if (n) ok = false;
    }
    const orphans = db.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE status = 'active' AND is_admin = 0 AND household_id IS NULL"
    ).get().n;
    console.log(`  ${'users'.padEnd(20)} ${orphans ? `${orphans} ACTIVE USER(S) WITH NO HOUSEHOLD` : 'every active user has a household'}`);
    if (orphans) ok = false;
    console.log('');
  }

  const integrity = db.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  const integrityOk = integrity.length === 1 && integrity[0] === 'ok';
  console.log(`Integrity check: ${integrityOk ? 'ok' : integrity.join('; ')}`);
  console.log(`Foreign key check: ${fk.length ? `${fk.length} problem(s)` : 'ok'}`);
  if (!integrityOk || fk.length) ok = false;
}

db.close();

const untouched = sourceFiles.map(fileHash).every((h, i) => h === hashesBefore[i]);
console.log(`Original file untouched: ${untouched ? 'yes' : 'NO'}`);
if (!untouched) ok = false;

if (keep) {
  console.log(`Migrated copy kept at: ${copy}`);
} else {
  fs.rmSync(workDir, { recursive: true, force: true });
}

console.log('');
console.log(ok ? 'RESULT: OK' : 'RESULT: PROBLEMS FOUND (see above)');
process.exit(ok ? 0 : 1);
