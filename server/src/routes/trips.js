const express = require('express');
const trips = require('../trips');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

// GET /api/trips/current - the household's current trip with its rows
// ({ trip: null } when there isn't one). The trip page re-reads this
// while it's open, so two people scanning see each other's items.
router.get('/current', (req, res) => {
  res.json({ trip: trips.tripView(req.householdId, trips.activeTrip(req.householdId)) });
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
