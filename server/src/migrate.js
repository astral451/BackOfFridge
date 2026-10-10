// Schema-version tracking. Each migration in ./migrations has a version
// number and runs exactly once, in order, inside its own transaction - SQLite
// DDL is transactional, so a migration that throws partway through rolls back
// completely and leaves the database at the previous version. Applied
// versions are recorded in the schema_migrations table.
//
// Used both by the server at startup (db.js) and by scripts/migrate-check.js
// (the dry run against a copy of a backup), so the check exercises exactly
// the code the server will run.

const MIGRATIONS = require('./migrations');

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
}

// Versions must be 1, 2, 3, ... with no gaps or repeats, so "highest
// version" means "every migration up to it".
function validate(migrations) {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migration list out of order: expected version ${i + 1}, found ${m.version} (${m.name})`);
    }
    if (typeof m.up !== 'function') {
      throw new Error(`Migration ${m.version} (${m.name}) has no up() function`);
    }
  });
}

// The database's current version, read without changing anything: null if
// it has never been versioned (no schema_migrations table), else the highest
// applied version (0 if the table exists but is empty).
function currentVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  if (!table) return null;
  return db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
}

// Brings the database up to the newest migration. Returns
// { from, to, applied: [{version, name}] }. Throws, changing nothing, if the
// database is newer than this code (a downgrade).
function migrate(db, { migrations = MIGRATIONS, log = () => {} } = {}) {
  validate(migrations);
  const latest = migrations.length;

  ensureMigrationsTable(db);
  const appliedRows = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
  const from = appliedRows.length ? appliedRows[appliedRows.length - 1].version : 0;

  if (from > latest) {
    throw new Error(
      `Database schema is at version ${from}, but this code only knows migrations up to ${latest}. ` +
      'Refusing to start: running older code against a newer database could damage it. ' +
      'Deploy the newer code again, or restore a backup taken at a version this code knows.'
    );
  }

  const appliedVersions = new Set(appliedRows.map((r) => r.version));
  for (const row of appliedRows) {
    const known = migrations[row.version - 1];
    if (known && known.name !== row.name) {
      log(`WARNING schema migration ${row.version} was recorded as "${row.name}" but is now named "${known.name}"`);
    }
  }

  const record = db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)');
  const applied = [];
  for (const m of migrations) {
    if (appliedVersions.has(m.version)) continue;
    log(`Applying schema migration ${m.version} (${m.name})...`);
    db.transaction(() => {
      m.up(db);
      record.run(m.version, m.name);
    })();
    applied.push({ version: m.version, name: m.name });
    log(`Applied schema migration ${m.version} (${m.name})`);
  }

  return { from, to: latest, applied };
}

module.exports = { migrate, currentVersion, MIGRATIONS };
