const express = require('express');
const db = require('../db');
const { log } = require('../logger');

const router = express.Router();

// GET /api/locations - managed location names, for the purchase form/filter dropdowns
router.get('/locations', (req, res) => {
  const rows = db.prepare('SELECT name FROM locations ORDER BY name').all();
  res.json(rows.map((r) => r.name));
});

// GET /api/locations/detail - locations with how many items currently reference
// each one, for the "manage locations" page
router.get('/locations/detail', (req, res) => {
  // Explicit COLLATE NOCASE: i.location (items table) has no declared
  // collation, so without this the join would use its default BINARY
  // comparison instead of inheriting locations.name's NOCASE.
  const rows = db.prepare(`
    SELECT l.name AS name, COUNT(i.id) AS itemCount
    FROM locations l
    LEFT JOIN items i ON i.location = l.name COLLATE NOCASE
    GROUP BY l.name
    ORDER BY l.name
  `).all();
  res.json(rows);
});

// POST /api/locations - add a new managed location. Body: { name }
router.post('/locations', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  db.ensureLocation(name);
  log(`LOCATION ADDED "${name}"`);
  res.status(201).json({ name });
});

// DELETE /api/locations/:name - remove a managed location. Refuses if any
// item (of any status) still references it, so data is never silently
// orphaned.
router.delete('/locations/:name', (req, res) => {
  const name = req.params.name;
  const existing = db.prepare('SELECT name FROM locations WHERE name = ?').get(name);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const itemCount = db.prepare('SELECT COUNT(*) AS c FROM items WHERE location = ? COLLATE NOCASE').get(name).c;
  if (itemCount > 0) {
    return res.status(400).json({
      error: `${itemCount} item(s) still use "${name}". Move or delete them first.`,
    });
  }

  db.prepare('DELETE FROM locations WHERE name = ?').run(name);
  log(`LOCATION DELETED "${name}"`);
  res.status(204).end();
});

// GET /api/tags - managed tag/category names, for the purchase form/filter dropdowns
router.get('/tags', (req, res) => {
  const rows = db.prepare('SELECT name FROM tags ORDER BY name').all();
  res.json(rows.map((r) => r.name));
});

// GET /api/tags/detail - tags with how many items currently reference each
// one, for the "manage tags" page
router.get('/tags/detail', (req, res) => {
  const rows = db.prepare(`
    SELECT t.name AS name, COUNT(i.id) AS itemCount
    FROM tags t
    LEFT JOIN items i ON i.tag = t.name COLLATE NOCASE
    GROUP BY t.name
    ORDER BY t.name
  `).all();
  res.json(rows);
});

// POST /api/tags - add a new managed tag. Body: { name }
router.post('/tags', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  db.ensureTag(name);
  log(`TAG ADDED "${name}"`);
  res.status(201).json({ name });
});

// DELETE /api/tags/:name - remove a managed tag. Refuses if any item still
// references it, so data is never silently orphaned.
router.delete('/tags/:name', (req, res) => {
  const name = req.params.name;
  const existing = db.prepare('SELECT name FROM tags WHERE name = ?').get(name);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const itemCount = db.prepare('SELECT COUNT(*) AS c FROM items WHERE tag = ? COLLATE NOCASE').get(name).c;
  if (itemCount > 0) {
    return res.status(400).json({
      error: `${itemCount} item(s) still use "${name}". Move or delete them first.`,
    });
  }

  db.prepare('DELETE FROM tags WHERE name = ?').run(name);
  log(`TAG DELETED "${name}"`);
  res.status(204).end();
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
