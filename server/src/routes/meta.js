const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/locations - distinct locations already in use, for autocomplete
router.get('/locations', (req, res) => {
  const rows = db.prepare(`
    SELECT DISTINCT location FROM items WHERE location != '' ORDER BY location
  `).all();
  res.json(rows.map((r) => r.location));
});

// GET /api/stats - quick counts for a dashboard
router.get('/stats', (req, res) => {
  const active = db.prepare(`SELECT COUNT(*) AS c FROM items WHERE status='active'`).get().c;
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) AS c FROM items
    WHERE status='active' AND expiration_date IS NOT NULL AND date(expiration_date) <= date('now', '+3 days')
  `).get().c;
  const expired = db.prepare(`
    SELECT COUNT(*) AS c FROM items
    WHERE status='active' AND expiration_date IS NOT NULL AND date(expiration_date) < date('now')
  `).get().c;
  res.json({ active, expiringSoon, expired });
});

module.exports = router;
