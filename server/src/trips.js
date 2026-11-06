// Shopping trips, shared by a household (migration 006; design in
// features.md, "Trips: shared shopping trips and the shopping list").
// Every function takes the household id and only ever touches that
// household's rows, like store.js.

const crypto = require('crypto');
const db = require('./db');

// An active trip with no save for this long is over.
const IDLE_HOURS = 3;

function requireHousehold(householdId) {
  if (!Number.isInteger(householdId)) throw new Error('household id required');
  return householdId;
}

// Ends the household's active trip if it's gone quiet. Called before
// anything reads or adds to the current trip, so "3 hours idle" needs no
// timer.
function endIdleTrips(householdId) {
  db.prepare(`
    UPDATE trips SET status = 'done', ended_at = last_activity_at
    WHERE household_id = ? AND status = 'active'
      AND last_activity_at < datetime('now', ?)
  `).run(requireHousehold(householdId), `-${IDLE_HOURS} hours`);
}

function getTrip(householdId, id) {
  return db.prepare('SELECT * FROM trips WHERE id = ? AND household_id = ?').get(id, requireHousehold(householdId)) || null;
}

function activeTrip(householdId) {
  endIdleTrips(householdId);
  return db.prepare(`
    SELECT * FROM trips WHERE household_id = ? AND status = 'active'
    ORDER BY started_at DESC LIMIT 1
  `).get(requireHousehold(householdId)) || null;
}

function startTrip(householdId, username) {
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO trips (id, household_id, status, created_by, started_at, last_activity_at)
    VALUES (?, ?, 'active', ?, datetime('now'), datetime('now'))
  `).run(id, requireHousehold(householdId), username || null);
  return getTrip(householdId, id);
}

// Adds a just-saved item to the household's current trip, starting one if
// there isn't one. Both people's phones save into the same trip.
// Returns { id, count }.
// If the item is on the trip's list (same barcode, or same name ignoring
// case and spaces), that row is ticked off instead: it gets the item and
// the time, and keeps the name it was listed under.
// Returns { id, count, ticked } - ticked is the list row's name, if any.
const recordBought = db.transaction((householdId, item, username) => {
  const trip = activeTrip(householdId) || startTrip(householdId, username);
  const listed = findListed(trip.id, item);
  if (listed) {
    db.prepare(`
      UPDATE trip_entries SET item_id = ?, bought_at = datetime('now'), added_by = COALESCE(?, added_by)
      WHERE id = ?
    `).run(item.id, username || null, listed.id);
  } else {
    db.prepare(`
      INSERT INTO trip_entries (trip_id, household_id, name, barcode, quantity, unit, item_id, added_by, bought_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(trip.id, householdId, item.name, item.barcode || null, item.quantity, item.unit || '', item.id, username || null);
  }
  db.prepare("UPDATE trips SET last_activity_at = datetime('now') WHERE id = ?").run(trip.id);
  return { id: trip.id, count: boughtCount(trip.id), todo: todoCount(trip.id), ticked: listed ? listed.name : null };
});

// List rows on the trip not got yet.
function todoCount(tripId) {
  return db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE trip_id = ? AND bought_at IS NULL').get(tripId).n;
}

// The oldest unticked row on the trip that is this product.
function findListed(tripId, item) {
  return db.prepare(`
    SELECT * FROM trip_entries
    WHERE trip_id = ? AND bought_at IS NULL
      AND ((barcode IS NOT NULL AND barcode = ?) OR LOWER(TRIM(name)) = LOWER(TRIM(?)))
    ORDER BY id LIMIT 1
  `).get(tripId, item.barcode || null, item.name) || null;
}

// How many items this trip has saved (rows ticked off by hand without
// saving anything don't count).
function boughtCount(tripId) {
  return db.prepare('SELECT COUNT(*) AS n FROM trip_entries WHERE trip_id = ? AND item_id IS NOT NULL').get(tripId).n;
}

// A trip and its rows for the trip page. Bought rows come newest first,
// showing the item as it is now (renamed, moved, used up...), or the
// trip's own record if the item has since been deleted.
function tripView(householdId, trip) {
  if (!trip) return null;
  const entries = db.prepare(`
    SELECT e.id, e.name AS entry_name, e.barcode AS entry_barcode, e.quantity AS entry_quantity,
      e.unit AS entry_unit, e.source, e.item_id, e.added_by, e.created_at, e.bought_at,
      i.id AS current_id, i.name, i.quantity, i.unit, i.location, i.expiration_date, i.status, i.barcode
    FROM trip_entries e
    LEFT JOIN items i ON i.id = e.item_id AND i.household_id = e.household_id
    WHERE e.trip_id = ? AND e.household_id = ?
    ORDER BY e.bought_at IS NULL DESC, e.bought_at DESC, e.created_at DESC, e.id DESC
  `).all(trip.id, requireHousehold(householdId)).map((r) => ({
    id: r.id,
    item_id: r.item_id,
    deleted: r.item_id != null && r.current_id == null,
    name: r.current_id != null ? r.name : r.entry_name,
    barcode: r.current_id != null ? r.barcode : r.entry_barcode,
    quantity: r.current_id != null ? r.quantity : r.entry_quantity,
    unit: r.current_id != null ? r.unit : r.entry_unit,
    location: r.current_id != null ? r.location : null,
    expiration_date: r.current_id != null ? r.expiration_date : null,
    status: r.current_id != null ? r.status : null,
    source: r.source,
    added_by: r.added_by,
    created_at: r.created_at,
    bought_at: r.bought_at,
  }));
  return {
    id: trip.id,
    status: trip.status,
    created_at: trip.created_at,
    started_at: trip.started_at,
    ended_at: trip.ended_at,
    count: entries.filter((e) => e.item_id != null).length,
    entries,
  };
}

function endTrip(householdId, id) {
  const result = db.prepare(`
    UPDATE trips SET status = 'done', ended_at = datetime('now')
    WHERE id = ? AND household_id = ? AND status = 'active'
  `).run(id, requireHousehold(householdId));
  return result.changes > 0;
}

// --- The shopping list: a 'planned' trip --------------------------------
// One list per household for now (the UUID leaves room for more).

function plannedTrip(householdId) {
  return db.prepare(`
    SELECT * FROM trips WHERE household_id = ? AND status = 'planned'
    ORDER BY created_at DESC LIMIT 1
  `).get(requireHousehold(householdId)) || null;
}

function getEntry(householdId, id) {
  return db.prepare('SELECT * FROM trip_entries WHERE id = ? AND household_id = ?').get(id, requireHousehold(householdId)) || null;
}

const SOURCES = ['used', 'low_stock', 'expiring', 'manual'];

// Adds a row to the household's shopping list, starting the list if
// there isn't one. The same product already on it (barcode, or name
// ignoring case) isn't added twice; that row is returned instead.
// Returns { entry, added }.
const addToList = db.transaction((householdId, { name, barcode = null, quantity = null, unit = '', source = 'manual' }, username) => {
  let trip = plannedTrip(householdId);
  if (!trip) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO trips (id, household_id, status, created_by) VALUES (?, ?, 'planned', ?)")
      .run(id, householdId, username || null);
    trip = getTrip(householdId, id);
  }
  const existing = findListed(trip.id, { name, barcode });
  if (existing) return { entry: existing, added: false };
  const result = db.prepare(`
    INSERT INTO trip_entries (trip_id, household_id, name, barcode, quantity, unit, source, added_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(trip.id, householdId, name, barcode, quantity, unit || '', SOURCES.includes(source) ? source : 'manual', username || null);
  return { entry: getEntry(householdId, result.lastInsertRowid), added: true };
});

// Quantity and unit on a list row (null quantity: "some").
function updateEntry(householdId, id, { quantity, unit }) {
  db.prepare('UPDATE trip_entries SET quantity = ?, unit = ? WHERE id = ? AND household_id = ?')
    .run(quantity, unit || '', id, requireHousehold(householdId));
  return getEntry(householdId, id);
}

// Takes a row off the list. Only rows not yet bought.
function removeEntry(householdId, id) {
  return db.prepare('DELETE FROM trip_entries WHERE id = ? AND household_id = ? AND bought_at IS NULL')
    .run(id, requireHousehold(householdId)).changes > 0;
}

// Ticks a list row off by hand (got it, nothing saved), or unticks one
// that was ticked by hand.
function setTicked(householdId, id, ticked) {
  const sql = ticked
    ? "UPDATE trip_entries SET bought_at = datetime('now') WHERE id = ? AND household_id = ? AND item_id IS NULL AND bought_at IS NULL"
    : 'UPDATE trip_entries SET bought_at = NULL WHERE id = ? AND household_id = ? AND item_id IS NULL AND bought_at IS NOT NULL';
  return db.prepare(sql).run(id, requireHousehold(householdId)).changes > 0;
}

// "Start shopping": the list becomes the current trip. If a trip is
// already going (someone started saving first), the list's rows join it
// and the list is used up, so there's still one current trip.
// Returns the active trip.
const startShopping = db.transaction((householdId, listId, username) => {
  const list = getTrip(householdId, listId);
  if (!list || list.status !== 'planned') return null;
  const active = activeTrip(householdId);
  if (active) {
    db.prepare('UPDATE trip_entries SET trip_id = ? WHERE trip_id = ?').run(active.id, list.id);
    db.prepare('DELETE FROM trips WHERE id = ?').run(list.id);
    db.prepare("UPDATE trips SET last_activity_at = datetime('now') WHERE id = ?").run(active.id);
    return getTrip(householdId, active.id);
  }
  db.prepare(`
    UPDATE trips SET status = 'active', started_at = datetime('now'), last_activity_at = datetime('now')
    WHERE id = ?
  `).run(list.id);
  return getTrip(householdId, list.id);
});

module.exports = {
  IDLE_HOURS, activeTrip, getTrip, recordBought, tripView, endTrip,
  plannedTrip, getEntry, addToList, updateEntry, removeEntry, setTicked, startShopping,
};
