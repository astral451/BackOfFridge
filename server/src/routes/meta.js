const express = require('express');
const store = require('../store');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

// Locations and tags are both managed lists with the same routes:
//   GET    /api/<kind>         names, for the purchase form/filter dropdowns
//   GET    /api/<kind>/detail  names with how many items use each, for the
//                              "manage" pages
//   POST   /api/<kind>         add one. Body: { name }
//   DELETE /api/<kind>/:name   remove one. Refused if any item (of any
//                              status) still uses it, so data is never
//                              silently orphaned.
// All scoped to the logged-in user's household.
function managedList(kind, label, permission) {
  const upper = label.toUpperCase();

  router.get(`/${kind}`, (req, res) => {
    res.json(store.listNames(req.householdId, kind));
  });

  router.get(`/${kind}/detail`, (req, res) => {
    res.json(store.listNamesWithCounts(req.householdId, kind));
  });

  router.post(`/${kind}`, requirePermission(permission), (req, res) => {
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    store.ensureName(req.householdId, kind, name);
    log(`${upper} ADDED "${name}" by ${req.username} (household ${req.householdId})`);
    res.status(201).json({ name });
  });

  router.delete(`/${kind}/:name`, requirePermission(permission), (req, res) => {
    const name = req.params.name;
    if (!store.hasName(req.householdId, kind, name)) return res.status(404).json({ error: 'not found' });

    const itemCount = store.countItemsUsing(req.householdId, kind, name);
    if (itemCount > 0) {
      return res.status(400).json({
        error: `${itemCount} item(s) still use "${name}". Move or delete them first.`,
      });
    }

    store.deleteName(req.householdId, kind, name);
    log(`${upper} DELETED "${name}" by ${req.username} (household ${req.householdId})`);
    res.status(204).end();
  });
}

managedList('locations', 'location', 'locations:write');
managedList('tags', 'tag', 'tags:write');

// GET /api/stats - quick counts for a dashboard
router.get('/stats', (req, res) => {
  res.json(store.itemStats(req.householdId));
});

module.exports = router;
