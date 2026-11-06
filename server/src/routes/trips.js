const express = require('express');
const db = require('../db');
const store = require('../store');
const trips = require('../trips');
const { serialize } = require('./items');
const namematch = require('../namematch');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

// GET /api/trips?before=<time> - the Lists page: { active, planned,
// past, more }. Past trips come 20 at a time; `before` is the
// started_at of the last one shown, for "Show older trips".
router.get('/', (req, res) => {
  const before = typeof req.query.before === 'string' && req.query.before ? req.query.before : null;
  res.json(trips.overview(req.householdId, { before }));
});

// GET /api/trips/current - the household's current trip with its rows
// ({ trip: null } when there isn't one), and the shopping list ({ list }). The trip page re-reads this
// while it's open, so two people scanning see each other's items.
router.get('/current', (req, res) => {
  res.json({
    trip: trips.tripView(req.householdId, trips.activeTrip(req.householdId)),
    // The shopping list too, so pages can tell people when someone adds to it.
    list: trips.tripView(req.householdId, trips.plannedTrip(req.householdId)),
  });
});

// --- The shopping list ---------------------------------------------------

const USED_DAYS = 14;
const EXPIRING_DAYS = 3;

// A product's identity within a household: the barcode, else the name
// ignoring case and surrounding spaces (features.md, "Barcode as product
// identity").
function productKey(barcode, name) {
  return barcode ? barcode : 'name:' + String(name || '').trim().toLowerCase();
}

// "Things you might want" for the shopping list, in three groups. A
// product shows once, in the first group it fits, and not at all if it's
// already on the list.
// - used: used up or thrown out in the last 14 days, with none left.
// - low_stock: the items' own low-stock flag.
// - expiring: expiring in the next 3 days (or already past), so it can be
//   replaced before it goes.
function suggestions(householdId, listRows) {
  const taken = new Set();
  for (const r of listRows) {
    if (r.bought_at) continue;
    taken.add(productKey(null, r.name));
    if (r.barcode) taken.add(r.barcode);
  }
  const active = store.listItems(householdId, { status: 'active' }).map(serialize);
  const inStock = new Set();
  for (const it of active) {
    if (it.quantity > 0) {
      inStock.add(productKey(it.barcode, it.name));
      inStock.add(productKey(null, it.name));
    }
  }
  const seen = new Set();
  const fresh = (barcode, name) => {
    const keys = [productKey(barcode, name), productKey(null, name)];
    if (keys.some((k) => taken.has(k) || seen.has(k))) return false;
    keys.forEach((k) => seen.add(k));
    return true;
  };

  const usedRows = db.prepare(`
    SELECT e.item_name AS name, i.barcode, i.unit, e.event_type, MAX(e.created_at) AS at
    FROM item_events e
    LEFT JOIN items i ON i.id = e.item_id AND i.household_id = e.household_id
    WHERE e.household_id = ? AND e.event_type IN ('consumed', 'thrown_out')
      AND e.created_at >= datetime('now', ?)
    GROUP BY COALESCE(i.barcode, 'name:' || LOWER(TRIM(e.item_name)))
    ORDER BY at DESC
  `).all(householdId, `-${USED_DAYS} days`);
  const used = usedRows
    .filter((r) => !inStock.has(productKey(r.barcode, r.name)) && !inStock.has(productKey(null, r.name)))
    .filter((r) => fresh(r.barcode, r.name))
    .map((r) => ({ name: r.name, barcode: r.barcode || null, unit: r.unit || '', how: r.event_type, at: r.at }));

  const low = active
    .filter((it) => it.low_stock && fresh(it.barcode, it.name))
    .map((it) => ({
      name: it.name, barcode: it.barcode || null, unit: it.unit || '',
      quantity: it.quantity, tracking_mode: it.tracking_mode, fill_percent: it.fill_percent,
    }));

  const today = db.prepare("SELECT date('now', 'localtime') AS d, date('now', 'localtime', ?) AS soon").get(`+${EXPIRING_DAYS} days`);
  const expiring = active
    .filter((it) => it.expiration_date && it.expiration_date <= today.soon && fresh(it.barcode, it.name))
    .sort((a, b) => a.expiration_date.localeCompare(b.expiration_date))
    .map((it) => ({ name: it.name, barcode: it.barcode || null, unit: it.unit || '', expiration_date: it.expiration_date }));

  return { used, low_stock: low, expiring };
}

// GET /api/trips/list - the shopping list ({ list: null } before anything
// is on it) and the suggestions.
router.get('/list', (req, res) => {
  const list = trips.tripView(req.householdId, trips.plannedTrip(req.householdId));
  res.json({ list, suggestions: suggestions(req.householdId, list ? list.entries : []) });
});

// Quantity on a list row is optional: null means "some".
function readQuantity(raw) {
  if (raw === undefined || raw === null || raw === '') return { value: null };
  const n = Number(raw);
  return n > 0 ? { value: n } : { error: 'quantity must be a positive number' };
}

// POST /api/trips/list/entries - body { name, barcode?, quantity?, unit?,
// source? }. Starts the list if there isn't one. 200 with the existing row
// if that product is already on it.
router.post('/list/entries', requirePermission('items:write'), (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const qty = readQuantity(req.body.quantity);
  if (qty.error) return res.status(400).json({ error: qty.error });
  const { entry, added } = trips.addToList(req.householdId, {
    name,
    barcode: typeof req.body.barcode === 'string' && req.body.barcode ? req.body.barcode : null,
    quantity: qty.value,
    unit: typeof req.body.unit === 'string' ? req.body.unit.trim() : '',
    source: req.body.source,
  }, req.username);
  if (added) log(`LISTED "${name}" by ${req.username} (household ${req.householdId})`);
  res.status(added ? 201 : 200).json({ ...entry, added });
});

// POST /api/trips/:id/entries - body { name, quantity?, unit? }. Adds to
// that trip's still-to-get ("Forgot something?" from home) or to the list.
// 404 for a trip that's over.
router.post('/:id/entries', requirePermission('items:write'), (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required' });
  const qty = readQuantity(req.body.quantity);
  if (qty.error) return res.status(400).json({ error: qty.error });
  const result = trips.addToTrip(req.householdId, req.params.id, {
    name,
    barcode: typeof req.body.barcode === 'string' && req.body.barcode ? req.body.barcode : null,
    quantity: qty.value,
    unit: typeof req.body.unit === 'string' ? req.body.unit.trim() : '',
    source: 'manual',
  }, req.username);
  if (!result) return res.status(404).json({ error: 'That trip is over.' });
  if (result.added) log(`ADDED TO TRIP ${req.params.id} "${name}" by ${req.username} (household ${req.householdId})`);
  res.status(result.added ? 201 : 200).json({ ...result.entry, added: result.added });
});

// PATCH /api/trips/entries/:id - body { quantity, unit } on a list row.
router.patch('/entries/:id', requirePermission('items:write'), (req, res) => {
  const entry = trips.getEntry(req.householdId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  const qty = readQuantity(req.body.quantity);
  if (qty.error) return res.status(400).json({ error: qty.error });
  const unit = typeof req.body.unit === 'string' ? req.body.unit.trim() : entry.unit;
  res.json(trips.updateEntry(req.householdId, entry.id, { quantity: qty.value, unit }));
});

// DELETE /api/trips/entries/:id - take a row off the list (not once bought).
router.delete('/entries/:id', requirePermission('items:write'), (req, res) => {
  const entry = trips.getEntry(req.householdId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  if (!trips.removeEntry(req.householdId, entry.id)) return res.status(409).json({ error: 'already bought' });
  res.status(204).end();
});

// POST /api/trips/entries/:id/tick - body { ticked }. Tick a list row off
// by hand (got it, nothing to save), or untick one ticked by hand.
router.post('/entries/:id/tick', requirePermission('items:write'), (req, res) => {
  const entry = trips.getEntry(req.householdId, req.params.id);
  if (!entry) return res.status(404).json({ error: 'not found' });
  trips.setTicked(req.householdId, entry.id, req.body.ticked !== false);
  res.json(trips.getEntry(req.householdId, entry.id));
});

// GET /api/trips/:id - one trip (a past one, from the Lists page). Each
// row bought under a name the household doesn't use, but close to one it
// already did, carries `same_as`: that name, for "Same as your ...?".
router.get('/:id', (req, res) => {
  const trip = trips.getTrip(req.householdId, req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  const view = trips.tripView(req.householdId, trip);
  const names = store.allNames(req.householdId);
  for (const e of view.entries) {
    e.same_as = null;
    if (e.item_id == null || e.deleted || !e.bought_at) continue;
    const own = e.name.trim().toLowerCase();
    // Names in use before this was bought, other than its own.
    const candidates = names.filter((n) => n.name.trim().toLowerCase() !== own && n.first_at < e.bought_at);
    const best = namematch.bestMatches(e.name, null, candidates)[0];
    if (best) e.same_as = best.name;
  }
  res.json({ trip: view });
});

// POST /api/trips/:id/carry-over - "Put them on the shopping list": the
// trip's rows never got go onto the list (not twice). { added, already }.
router.post('/:id/carry-over', requirePermission('items:write'), (req, res) => {
  const trip = trips.getTrip(req.householdId, req.params.id);
  if (!trip) return res.status(404).json({ error: 'not found' });
  const missed = trips.tripView(req.householdId, trip).entries.filter((e) => !e.bought_at);
  let added = 0;
  for (const e of missed) {
    const r = trips.addToList(req.householdId, {
      name: e.name, barcode: e.barcode, quantity: e.quantity, unit: e.unit, source: 'manual',
    }, req.username);
    if (r.added) added += 1;
  }
  log(`CARRIED OVER ${added} from trip ${trip.id} to the shopping list by ${req.username} (household ${req.householdId})`);
  res.json({ added, already: missed.length - added });
});

// POST /api/trips/:id/start - "Start shopping" on the list.
router.post('/:id/start', requirePermission('items:write'), (req, res) => {
  const trip = trips.startShopping(req.householdId, req.params.id, req.username);
  if (!trip) return res.status(404).json({ error: 'no shopping list like that' });
  log(`TRIP STARTED ${trip.id} from the shopping list by ${req.username} (household ${req.householdId})`);
  res.json({ trip: trips.tripView(req.householdId, trip) });
});

// POST /api/trips/:id/end - "End trip". The items stay; the next save
// starts a new trip.
router.post('/:id/end', requirePermission('items:write'), (req, res) => {
  if (!trips.getTrip(req.householdId, req.params.id)) return res.status(404).json({ error: 'not found' });
  if (trips.endTrip(req.householdId, req.params.id)) {
    log(`TRIP ENDED ${req.params.id} by ${req.username} (household ${req.householdId})`);
  }
  res.status(204).end();
});

module.exports = router;
