// Migration 006: trips (features.md, "Trips: shared shopping trips and the
// shopping list").
//
// - trips: one shopping run, shared by the household. `status` is
//   'planned' (a shopping list that hasn't started), 'active' (the current
//   trip: saves go into it) or 'done'. The id is a random UUID, so a
//   household having several lists later changes nothing here.
//   last_activity_at is the last save; an active trip with none for 3
//   hours is ended the next time anyone looks.
// - trip_entries: one row per thing on a trip. A shopping-list row has no
//   item_id until it's bought; something bought that wasn't on the list
//   is created with item_id and bought_at set. item_id has no foreign key
//   because items are deleted outright, and the trip keeps its record
//   (name, barcode) of what was bought regardless.
//   source says where a list row came from: 'used', 'low_stock',
//   'expiring' or 'manual'; NULL for something bought off-list.

module.exports = function trips(db) {
  db.exec(`
    CREATE TABLE trips (
      id TEXT PRIMARY KEY,
      household_id INTEGER NOT NULL REFERENCES households(id),
      status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'done')),
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      last_activity_at TEXT,
      ended_at TEXT
    );
    CREATE INDEX idx_trips_household_status ON trips(household_id, status);

    CREATE TABLE trip_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id TEXT NOT NULL REFERENCES trips(id),
      household_id INTEGER NOT NULL REFERENCES households(id),
      name TEXT NOT NULL,
      barcode TEXT,
      quantity REAL,
      unit TEXT,
      source TEXT CHECK (source IN ('used', 'low_stock', 'expiring', 'manual')),
      item_id INTEGER,
      added_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      bought_at TEXT
    );
    CREATE INDEX idx_trip_entries_trip ON trip_entries(trip_id);
  `);
};
