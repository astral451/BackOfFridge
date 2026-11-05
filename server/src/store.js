// Household-scoped data access. Every function that reads or writes
// household data (items, item_events, locations, tags) takes the household
// id as its FIRST argument and refuses to run without a valid one, so a
// query that forgets the household fails loudly instead of reading or
// writing someone else's data. Routes get the id from the logged-in session
// (req.householdId), never from anything the client sends.
//
// See features.md, "Reference: multi-family data isolation design".

const db = require('./db');

function requireHousehold(householdId) {
  if (!Number.isInteger(householdId) || householdId <= 0) {
    throw new Error(`household id is required (got ${JSON.stringify(householdId)})`);
  }
  return householdId;
}

// --- Items ---------------------------------------------------------------

// filters: { status, location, category, tag, expiringWithinDays }
function listItems(householdId, filters = {}) {
  const clauses = ['household_id = @householdId'];
  const params = { householdId: requireHousehold(householdId) };

  if (filters.status) {
    clauses.push('status = @status');
    params.status = filters.status;
  }
  if (filters.location) {
    clauses.push('location = @location COLLATE NOCASE');
    params.location = filters.location;
  }
  if (filters.category) {
    clauses.push('category = @category');
    params.category = filters.category;
  }
  if (filters.tag) {
    clauses.push('tag = @tag COLLATE NOCASE');
    params.tag = filters.tag;
  }
  if (filters.expiringWithinDays !== undefined) {
    clauses.push("expiration_date IS NOT NULL AND date(expiration_date) <= date('now', @days)");
    params.days = `+${parseInt(filters.expiringWithinDays, 10) || 0} days`;
  }

  return db.prepare(`
    SELECT * FROM items WHERE ${clauses.join(' AND ')}
    ORDER BY expiration_date IS NULL, expiration_date ASC, created_at DESC
  `).all(params);
}

// The item, or undefined if it doesn't exist *in this household* - another
// household's item looks exactly like a missing one, so ids can't be probed.
function getItem(householdId, id) {
  return db.prepare('SELECT * FROM items WHERE id = ? AND household_id = ?').get(id, requireHousehold(householdId));
}

// purchased_quantity is the amount bought (migration 003). It's set here,
// from the starting quantity, and nothing else writes it - updateItem and
// the consume/undo functions below leave it alone.
function insertItem(householdId, fields) {
  const result = db.prepare(`
    INSERT INTO items (household_id, name, category, location, tag, quantity, purchased_quantity, unit,
      purchase_date, expiration_date, notes, tracking_mode, fill_percent, low_stock_threshold, barcode)
    VALUES (@household_id, @name, @category, @location, @tag, @quantity, @quantity, @unit,
      @purchase_date, @expiration_date, @notes, @tracking_mode, @fill_percent, @low_stock_threshold, @barcode)
  `).run({ barcode: null, ...fields, household_id: requireHousehold(householdId) });
  return getItem(householdId, result.lastInsertRowid);
}

// Writes the editable fields of `item` (a full row, already merged with the
// changes) back to the database.
function updateItem(householdId, item) {
  db.prepare(`
    UPDATE items SET name=@name, category=@category, location=@location, tag=@tag, quantity=@quantity,
      unit=@unit, purchase_date=@purchase_date, expiration_date=@expiration_date,
      status=@status, notes=@notes, tracking_mode=@tracking_mode, fill_percent=@fill_percent,
      low_stock_threshold=@low_stock_threshold, barcode=@barcode, updated_at=datetime('now')
    WHERE id=@id AND household_id=@household_id
  `).run({ barcode: null, ...item, household_id: requireHousehold(householdId) });
  return getItem(householdId, item.id);
}

// Sets the quantity/status (and, for fill-level items, the open unit's
// fill_percent) after a consume or throw-out, remembering the previous
// values for a one-level undo.
function updateItemQuantity(householdId, id, {
  quantity, status, fillPercent, prevStatus, prevQuantity, prevFillPercent, thrownOutDate,
}) {
  db.prepare(`
    UPDATE items SET
      quantity = @quantity,
      status = @status,
      fill_percent = @fill_percent,
      prev_status = @prev_status,
      prev_quantity = @prev_quantity,
      prev_fill_percent = @prev_fill_percent,
      thrown_out_date = @thrown_out_date,
      updated_at = datetime('now')
    WHERE id = @id AND household_id = @household_id
  `).run({
    id,
    household_id: requireHousehold(householdId),
    quantity,
    status,
    fill_percent: fillPercent === undefined ? null : fillPercent,
    prev_status: prevStatus,
    prev_quantity: prevQuantity,
    prev_fill_percent: prevFillPercent === undefined ? null : prevFillPercent,
    thrown_out_date: thrownOutDate,
  });
  return getItem(householdId, id);
}

// prev_fill_percent is NULL when there's no fill level to restore, in which
// case fill_percent is left as it is.
function undoItem(householdId, item) {
  db.prepare(`
    UPDATE items SET
      status = @prev_status,
      quantity = @prev_quantity,
      fill_percent = COALESCE(@prev_fill_percent, fill_percent),
      prev_status = NULL,
      prev_quantity = NULL,
      prev_fill_percent = NULL,
      thrown_out_date = CASE WHEN @prev_status = 'thrown_out' THEN thrown_out_date ELSE NULL END,
      updated_at = datetime('now')
    WHERE id = @id AND household_id = @household_id
  `).run({
    id: item.id,
    household_id: requireHousehold(householdId),
    prev_status: item.prev_status,
    prev_quantity: item.prev_quantity,
    prev_fill_percent: item.prev_fill_percent === undefined ? null : item.prev_fill_percent,
  });
  return getItem(householdId, item.id);
}

function deleteItem(householdId, id) {
  db.prepare('DELETE FROM items WHERE id = ? AND household_id = ?').run(id, requireHousehold(householdId));
}

function itemStats(householdId) {
  requireHousehold(householdId);
  const count = (extra) => db.prepare(`
    SELECT COUNT(*) AS c FROM items WHERE household_id = ? AND status = 'active' ${extra}
  `).get(householdId).c;
  return {
    active: count(''),
    expiringSoon: count("AND expiration_date IS NOT NULL AND date(expiration_date) <= date('now', '+3 days')"),
    expired: count("AND expiration_date IS NOT NULL AND date(expiration_date) < date('now')"),
  };
}

// --- Events --------------------------------------------------------------

// Append-only history (see migration 001). Each event carries its own
// household_id because events outlive deleted items.
function recordEvent(householdId, itemId, itemName, eventType, detail, username) {
  db.prepare(`
    INSERT INTO item_events (household_id, item_id, item_name, event_type, detail, username)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(requireHousehold(householdId), itemId, itemName, eventType, detail ? JSON.stringify(detail) : null, username || null);
}

function itemHistory(householdId, itemId) {
  return db.prepare(`
    SELECT event_type, detail, username, created_at FROM item_events
    WHERE item_id = ? AND household_id = ? ORDER BY created_at DESC, id DESC
  `).all(itemId, requireHousehold(householdId));
}

// --- Products (barcodes) ------------------------------------------------

// What this household knows about a barcode (migration 005), or undefined.
function getProduct(householdId, barcode) {
  return db.prepare('SELECT * FROM products WHERE household_id = ? AND barcode = ?')
    .get(requireHousehold(householdId), barcode);
}

// Caches an Open Food Facts result. Never overwrites a 'local' row: what
// the household chose for a product beats the public database.
function cacheProductLookup(householdId, barcode, { name, brand, package: pkg, image_url }) {
  db.prepare(`
    INSERT INTO products (household_id, barcode, name, brand, package, image_url, source)
    VALUES (@household_id, @barcode, @name, @brand, @package, @image_url, 'openfoodfacts')
    ON CONFLICT (household_id, barcode) DO NOTHING
  `).run({ household_id: requireHousehold(householdId), barcode, name, brand, package: pkg, image_url });
  return getProduct(householdId, barcode);
}

// Remembers a purchase made with a barcode: the name and choices on that
// item become what scanning the barcode pre-fills next time. Any cached
// brand/package/image is kept.
function rememberProduct(householdId, item) {
  db.prepare(`
    INSERT INTO products (household_id, barcode, name, category, location, tag, unit,
      purchase_quantity, tracking_mode, source)
    VALUES (@household_id, @barcode, @name, @category, @location, @tag, @unit,
      @purchase_quantity, @tracking_mode, 'local')
    ON CONFLICT (household_id, barcode) DO UPDATE SET
      name = excluded.name, category = excluded.category, location = excluded.location,
      tag = excluded.tag, unit = excluded.unit, purchase_quantity = excluded.purchase_quantity,
      tracking_mode = excluded.tracking_mode, source = 'local', updated_at = datetime('now')
  `).run({
    household_id: requireHousehold(householdId),
    barcode: item.barcode,
    name: item.name,
    category: item.category,
    location: item.location,
    tag: item.tag,
    unit: item.unit,
    purchase_quantity: item.purchased_quantity != null ? item.purchased_quantity : item.quantity,
    tracking_mode: item.tracking_mode,
  });
  return getProduct(householdId, item.barcode);
}

// Names this household has entered without a barcode (typed or dictated
// before scanning existed, or never scanned): one row per name, ignoring
// case, with how many items carry it and when it was last bought. Used to
// suggest "is this the same as your ...?" when a new barcode is scanned.
function unlinkedNames(householdId) {
  return db.prepare(`
    SELECT MAX(name) AS name, COUNT(*) AS count, MAX(purchase_date) AS last_bought
    FROM items
    WHERE household_id = ? AND barcode IS NULL AND TRIM(name) != ''
    GROUP BY LOWER(TRIM(name))
  `).all(requireHousehold(householdId));
}

// Links a barcode to items entered under `name` without one: every such
// item of this household (any status, so history counts too) gets the
// barcode, and the most recent one becomes the product this barcode
// pre-fills from now on. Returns { linked, product }, or null when no item
// has that name.
function linkBarcodeToName(householdId, barcode, name, username) {
  const hid = requireHousehold(householdId);
  const items = db.prepare(`
    SELECT * FROM items
    WHERE household_id = ? AND barcode IS NULL AND LOWER(TRIM(name)) = LOWER(TRIM(?))
    ORDER BY COALESCE(purchase_date, created_at) DESC, id DESC
  `).all(hid, name);
  if (!items.length) return null;
  const setBarcode = db.prepare('UPDATE items SET barcode = ? WHERE id = ? AND household_id = ?');
  db.transaction(() => {
    for (const item of items) {
      setBarcode.run(barcode, item.id, hid);
      recordEvent(hid, item.id, item.name, 'edited', { barcode }, username);
    }
    rememberProduct(hid, { ...items[0], barcode });
  })();
  return { linked: items.length, product: getProduct(hid, barcode) };
}

// --- Locations and tags --------------------------------------------------
// Both are managed lists with the same shape: (household_id, name), names
// case-insensitive within a household. `kind` picks the table and the
// matching items column; it's only ever one of these two constants, never
// client input.

const LISTS = {
  locations: { table: 'locations', column: 'location' },
  tags: { table: 'tags', column: 'tag' },
};

function listNames(householdId, kind) {
  const { table } = LISTS[kind];
  return db.prepare(`SELECT name FROM ${table} WHERE household_id = ? ORDER BY name`)
    .all(requireHousehold(householdId)).map((r) => r.name);
}

// Each name with how many of this household's items use it. Explicit
// COLLATE NOCASE: the items column has no declared collation, so without it
// the join would compare case-sensitively.
function listNamesWithCounts(householdId, kind) {
  const { table, column } = LISTS[kind];
  return db.prepare(`
    SELECT l.name AS name, COUNT(i.id) AS itemCount
    FROM ${table} l
    LEFT JOIN items i ON i.household_id = l.household_id AND i.${column} = l.name COLLATE NOCASE
    WHERE l.household_id = ?
    GROUP BY l.name
    ORDER BY l.name
  `).all(requireHousehold(householdId));
}

// Every location/tag an item is set to (on create or edit) becomes a managed
// one automatically, matching the "+ Add new location" flow in the purchase
// form.
function ensureName(householdId, kind, name) {
  const { table } = LISTS[kind];
  name = typeof name === 'string' ? name.trim() : name;
  if (name) {
    db.prepare(`INSERT OR IGNORE INTO ${table} (household_id, name) VALUES (?, ?)`).run(requireHousehold(householdId), name);
  }
}

function hasName(householdId, kind, name) {
  const { table } = LISTS[kind];
  return !!db.prepare(`SELECT 1 FROM ${table} WHERE household_id = ? AND name = ?`).get(requireHousehold(householdId), name);
}

function countItemsUsing(householdId, kind, name) {
  const { column } = LISTS[kind];
  return db.prepare(`SELECT COUNT(*) AS c FROM items WHERE household_id = ? AND ${column} = ? COLLATE NOCASE`)
    .get(requireHousehold(householdId), name).c;
}

function deleteName(householdId, kind, name) {
  const { table } = LISTS[kind];
  db.prepare(`DELETE FROM ${table} WHERE household_id = ? AND name = ?`).run(requireHousehold(householdId), name);
}

module.exports = {
  requireHousehold,
  listItems,
  getItem,
  insertItem,
  updateItem,
  updateItemQuantity,
  undoItem,
  deleteItem,
  getProduct,
  cacheProductLookup,
  rememberProduct,
  unlinkedNames,
  linkBarcodeToName,
  itemStats,
  recordEvent,
  itemHistory,
  listNames,
  listNamesWithCounts,
  ensureName,
  hasName,
  countItemsUsing,
  deleteName,
};
