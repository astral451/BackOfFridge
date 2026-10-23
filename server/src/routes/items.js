const express = require('express');
const store = require('../store');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

const VALID_STATUS = ['active', 'consumed', 'thrown_out'];
const VALID_CATEGORY = ['perishable', 'nonperishable'];
const VALID_TRACKING_MODE = ['count', 'fill_level'];
const DEFAULT_LOW_STOCK_FILL_THRESHOLD = 25;

// Adds a computed `low_stock` flag: for fill_level items, fill_percent at or
// below the threshold (default 25%); for count items, quantity at or below
// the threshold, only when one's been explicitly set (there's no sensible
// universal default across totally different units).
function serialize(row) {
  let lowStock = false;
  if (row.tracking_mode === 'fill_level') {
    const threshold = row.low_stock_threshold != null ? row.low_stock_threshold : DEFAULT_LOW_STOCK_FILL_THRESHOLD;
    lowStock = row.fill_percent != null && row.fill_percent <= threshold;
  } else if (row.low_stock_threshold != null) {
    lowStock = row.quantity <= row.low_stock_threshold;
  }
  return { ...row, low_stock: lowStock };
}

// GET /api/items?status=active&location=fridge&tag=dairy&expiring_within_days=3
router.get('/', (req, res) => {
  const { status, location, category, tag, expiring_within_days } = req.query;
  const rows = store.listItems(req.householdId, {
    status, location, category, tag, expiringWithinDays: expiring_within_days,
  });
  res.json(rows.map(serialize));
});

router.get('/:id', (req, res) => {
  const row = store.getItem(req.householdId, req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(serialize(row));
});

// GET /api/items/:id/history - this item's recorded events, newest first
router.get('/:id/history', (req, res) => {
  const existing = store.getItem(req.householdId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const rows = store.itemHistory(req.householdId, existing.id);
  res.json(rows.map((r) => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null })));
});

// POST /api/items - log a purchase
// Free-text fields get leading/trailing whitespace stripped before they're
// stored - an accidental space before or after a name (easy to do on a
// phone keyboard, or left by dictation) otherwise makes " Orange Cream
// Bubly" a different item from "Orange Cream Bubly" in searches, sorting
// and purchase counts. Done here as well as in the browser so anything
// calling the API directly is covered too.
const TEXT_FIELDS = ['name', 'location', 'tag', 'unit', 'notes'];
function trimTextFields(obj) {
  for (const f of TEXT_FIELDS) {
    if (typeof obj[f] === 'string') obj[f] = obj[f].trim();
  }
  return obj;
}

router.post('/', requirePermission('items:write'), (req, res) => {
  const {
    name,
    category = 'perishable',
    location = '',
    tag = '',
    quantity = 1,
    unit = '',
    purchase_date = null,
    expiration_date = null,
    notes = '',
    tracking_mode = 'count',
    fill_percent = null,
    low_stock_threshold = null,
  } = trimTextFields({ ...req.body });

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!VALID_CATEGORY.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORY.join(', ')}` });
  }
  if (!VALID_TRACKING_MODE.includes(tracking_mode)) {
    return res.status(400).json({ error: `tracking_mode must be one of ${VALID_TRACKING_MODE.join(', ')}` });
  }
  if (fill_percent !== null && !(fill_percent >= 0 && fill_percent <= 100)) {
    return res.status(400).json({ error: 'fill_percent must be between 0 and 100' });
  }

  const row = store.insertItem(req.householdId, {
    name, category, location, tag, quantity, unit, purchase_date, expiration_date, notes, tracking_mode, fill_percent, low_stock_threshold,
  });
  store.ensureName(req.householdId, 'locations', location);
  store.ensureName(req.householdId, 'tags', tag);

  store.recordEvent(req.householdId, row.id, row.name, 'purchased', { quantity: row.quantity, unit: row.unit, location: row.location }, req.username);
  log(`PURCHASED "${row.name}" x${row.quantity}${row.unit ? ' ' + row.unit : ''} -> ${row.location || 'unspecified location'} by ${req.username}`);
  res.status(201).json(serialize(row));
});

router.patch('/:id', requirePermission('items:write'), (req, res) => {
  const existing = store.getItem(req.householdId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const fields = [
    'name', 'category', 'location', 'tag', 'quantity', 'unit', 'purchase_date', 'expiration_date',
    'status', 'notes', 'tracking_mode', 'fill_percent', 'low_stock_threshold',
  ];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  trimTextFields(updates);
  if (updates.name !== undefined && !updates.name) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (updates.status && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUS.join(', ')}` });
  }
  if (updates.category && !VALID_CATEGORY.includes(updates.category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORY.join(', ')}` });
  }
  if (updates.tracking_mode && !VALID_TRACKING_MODE.includes(updates.tracking_mode)) {
    return res.status(400).json({ error: `tracking_mode must be one of ${VALID_TRACKING_MODE.join(', ')}` });
  }
  if (updates.fill_percent != null && !(updates.fill_percent >= 0 && updates.fill_percent <= 100)) {
    return res.status(400).json({ error: 'fill_percent must be between 0 and 100' });
  }
  if (updates.quantity !== undefined && !(typeof updates.quantity === 'number' && updates.quantity >= 0)) {
    return res.status(400).json({ error: 'quantity must be a number, 0 or more' });
  }

  const row = store.updateItem(req.householdId, { ...existing, ...updates });
  if (updates.location) store.ensureName(req.householdId, 'locations', updates.location);
  if (updates.tag) store.ensureName(req.householdId, 'tags', updates.tag);

  const changedFields = Object.keys(updates);
  const onlyFillPercentChanged = changedFields.length === 1 && updates.fill_percent !== undefined;
  // `recount: true` marks a direct "this is how much is actually left" set
  // from the row's quick edit, as opposed to an ordinary edit or a +/- tap.
  // It's recorded as its own event type so usage analysis can tell an
  // explicit correction (catching the app up on consumption that happened
  // gradually) apart from consumption at that moment.
  const recountField = req.body.recount === true && changedFields.length === 1
    && ['quantity', 'fill_percent'].includes(changedFields[0]) ? changedFields[0] : null;
  const dateFields = ['purchase_date', 'expiration_date'];
  const onlyDatesChanged = changedFields.length > 0 && changedFields.every((f) => dateFields.includes(f));

  if (recountField) {
    store.recordEvent(req.householdId, existing.id, existing.name, 'recount', {
      field: recountField,
      from: existing[recountField],
      to: updates[recountField],
      unit: recountField === 'fill_percent' ? '%' : existing.unit,
    }, req.username);
  } else if (onlyFillPercentChanged) {
    store.recordEvent(req.householdId, existing.id, existing.name, 'fill_level_set', { from: existing.fill_percent, to: updates.fill_percent }, req.username);
  } else if (onlyDatesChanged) {
    // A date correction (e.g. fixing a wrong expiration) isn't a
    // consumption-pattern signal, so it's deliberately left out of
    // item_events - just noted in the plain text log.
    log(`DATES EDITED "${existing.name}" by ${req.username}: ` + changedFields.map((f) => `${f} ${existing[f] || '(none)'} -> ${updates[f] || '(none)'}`).join(', '));
  } else {
    store.recordEvent(req.householdId, existing.id, existing.name, 'edited', updates, req.username);
  }

  res.json(serialize(row));
});

// Reduce an active item's quantity by `amount` (or all of it if omitted/>=
// remaining), setting `status` once none is left. Remembers the prior
// status/quantity so a single /undo can reverse this call.
function reduceQuantity(householdId, id, status, amount, username, extra) {
  const existing = store.getItem(householdId, id);
  if (!existing) return null;

  const removed = amount === undefined || amount === null || amount >= existing.quantity
    ? existing.quantity
    : amount;
  const remaining = existing.quantity - removed;

  const row = store.updateItemQuantity(householdId, existing.id, {
    quantity: remaining,
    status: remaining > 0 ? 'active' : status,
    prevStatus: existing.status,
    prevQuantity: existing.quantity,
    thrownOutDate: remaining > 0 ? existing.thrown_out_date : (extra && extra.thrown_out_date) || null,
  });
  store.recordEvent(householdId, existing.id, existing.name, status, { quantity: removed, unit: existing.unit }, username);
  return row;
}

// POST /api/items/:id/throw-out - log that some or all of an item was thrown out.
// Body: { quantity? } - amount to remove; omit to throw out everything remaining.
router.post('/:id/throw-out', requirePermission('items:write'), (req, res) => {
  if (req.body.quantity !== undefined && !(req.body.quantity > 0)) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }
  const thrown_out_date = req.body.thrown_out_date || new Date().toISOString().slice(0, 10);
  const row = reduceQuantity(req.householdId, req.params.id, 'thrown_out', req.body.quantity, req.username, { thrown_out_date });
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(serialize(row));
});

// POST /api/items/:id/consume - log that some or all of an item was used up.
// Body: { quantity? } - amount to remove; omit to consume everything remaining.
router.post('/:id/consume', requirePermission('items:write'), (req, res) => {
  if (req.body.quantity !== undefined && !(req.body.quantity > 0)) {
    return res.status(400).json({ error: 'quantity must be a positive number' });
  }
  const row = reduceQuantity(req.householdId, req.params.id, 'consumed', req.body.quantity, req.username);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(serialize(row));
});

// POST /api/items/:id/undo - reverse the last consume/throw-out call on this item
router.post('/:id/undo', requirePermission('items:write'), (req, res) => {
  const existing = store.getItem(req.householdId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  if (existing.prev_status === null) {
    return res.status(400).json({ error: 'nothing to undo' });
  }

  const row = store.undoItem(req.householdId, existing);
  store.recordEvent(req.householdId, existing.id, existing.name, 'undo', { restored_status: existing.prev_status, restored_quantity: existing.prev_quantity }, req.username);
  res.json(serialize(row));
});

router.delete('/:id', requirePermission('items:write'), (req, res) => {
  const existing = store.getItem(req.householdId, req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  store.deleteItem(req.householdId, existing.id);
  store.recordEvent(req.householdId, existing.id, existing.name, 'deleted', null, req.username);
  res.status(204).end();
});

module.exports = router;
