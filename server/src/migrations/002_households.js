// Migration 002: households. Several households share one deployment, each
// seeing only its own data (design: features.md, "Reference: multi-family
// data isolation design"; plan and decisions: agent_handoff_02.md).
//
// - New `households` table. Each household has an invite code that its
//   members share to let someone join it.
// - New `new_household_codes` table: codes the admin issues that let someone
//   sign up and create a new household.
// - `users` gains household_id (NULL for the admin and for pending
//   accounts), status ('pending' / 'active' / 'rejected'), is_admin and
//   household_role (everyone is 'member' for now).
// - `items` and `item_events` gain household_id. item_events carries its
//   own rather than relying on a join to items, because events outlive
//   deleted items.
// - `locations` and `tags` are rebuilt with a (household_id, name) key, so
//   two households can each have a "Pantry".
// - Everything that already exists - every item, event, location, tag and
//   user - moves into household #1, "Household 1" (renamed later from the
//   admin page). A brand-new, empty database gets no household.

// Invite codes: 8 characters from an alphabet without look-alikes (no 0/O,
// 1/I/L), so they're easy to read out and type on a phone. Shown to people
// as XXXX-XXXX; stored without the dash.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function inviteCode() {
  const bytes = require('crypto').randomBytes(8);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

module.exports = function households(db) {
  db.exec(`
    CREATE TABLE households (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE new_household_codes (
      code TEXT PRIMARY KEY,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      created_by INTEGER REFERENCES users(id),
      used_at TEXT,
      used_by INTEGER REFERENCES users(id),
      household_id INTEGER REFERENCES households(id)
    );
  `);

  const hasExistingData = ['items', 'item_events', 'locations', 'tags', 'users']
    .some((t) => db.prepare(`SELECT EXISTS (SELECT 1 FROM ${t}) AS e`).get().e);
  if (hasExistingData) {
    db.prepare("INSERT INTO households (id, name, invite_code) VALUES (1, 'Household 1', ?)").run(inviteCode());
  }

  // users. household_id stays nullable: the admin has no household, and a
  // pending account has none until it's approved. status defaults to
  // 'pending', so an insert that forgets it can't create an active account;
  // existing users are set to 'active' just below.
  db.exec(`
    ALTER TABLE users ADD COLUMN household_id INTEGER REFERENCES households(id);
    ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'rejected'));
    ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN household_role TEXT NOT NULL DEFAULT 'member';
    UPDATE users SET household_id = 1, status = 'active';
    CREATE INDEX idx_users_household ON users(household_id);
  `);

  // items and item_events. SQLite can't add a NOT NULL column without a
  // default, and a default household would be exactly the wrong thing (a
  // query that forgot the household would silently write into #1). Instead
  // of rebuilding these two big tables, triggers enforce the same thing: a
  // row can't be inserted without a household, or moved to another one.
  for (const table of ['items', 'item_events']) {
    db.exec(`
      ALTER TABLE ${table} ADD COLUMN household_id INTEGER REFERENCES households(id);
      UPDATE ${table} SET household_id = 1;
      CREATE INDEX idx_${table}_household ON ${table}(household_id);

      CREATE TRIGGER ${table}_household_required
      BEFORE INSERT ON ${table} WHEN NEW.household_id IS NULL
      BEGIN SELECT RAISE(ABORT, '${table}.household_id is required'); END;

      CREATE TRIGGER ${table}_household_fixed
      BEFORE UPDATE OF household_id ON ${table} WHEN NEW.household_id IS NOT OLD.household_id
      BEGIN SELECT RAISE(ABORT, '${table}.household_id cannot be changed'); END;
    `);
  }

  // locations and tags: the name alone was the primary key, so rebuild with
  // a composite key. Same recreate-and-copy approach as 001's NOCASE fix.
  for (const table of ['locations', 'tags']) {
    db.exec(`
      CREATE TABLE ${table}_new (
        household_id INTEGER NOT NULL REFERENCES households(id),
        name TEXT NOT NULL COLLATE NOCASE,
        PRIMARY KEY (household_id, name)
      );
      INSERT INTO ${table}_new (household_id, name) SELECT 1, name FROM ${table};
      DROP TABLE ${table};
      ALTER TABLE ${table}_new RENAME TO ${table};
    `);
  }
};
