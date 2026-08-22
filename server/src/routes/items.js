const express = require('express');
const db = require('../db');

const router = express.Router();

const VALID_STATUS = ['active', 'consumed', 'thrown_out'];
const VALID_CATEGORY = ['perishable', 'nonperishable'];

function serialize(row) {
  return row;
}

// GET /api/items?status=active&location=fridge&expiring_within_days=3
router.get('/', (req, res) => {
  const { status, location, category, expiring_within_days } = req.query;
  const clauses = [];
  const params = {};

  if (status) {
    clauses.push('status = @status');
    params.status = status;
  }
  if (location) {
    clauses.push('location = @location');
    params.location = location;
  }
  if (category) {
    clauses.push('category = @category');
    params.category = category;
  }
  if (expiring_within_days !== undefined) {
    clauses.push("expiration_date IS NOT NULL AND date(expiration_date) <= date('now', @days)");
    params.days = `+${parseInt(expiring_within_days, 10) || 0} days`;
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM items ${where} ORDER BY expiration_date IS NULL, expiration_date ASC, created_at DESC`).all(params);
  res.json(rows.map(serialize));
});

router.get('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(serialize(row));
});

// POST /api/items - log a purchase
router.post('/', (req, res) => {
  const {
    name,
    category = 'perishable',
    location = '',
    quantity = 1,
    unit = '',
    purchase_date = null,
    expiration_date = null,
    notes = '',
  } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!VALID_CATEGORY.includes(category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORY.join(', ')}` });
  }

  const result = db.prepare(`
    INSERT INTO items (name, category, location, quantity, unit, purchase_date, expiration_date, notes)
    VALUES (@name, @category, @location, @quantity, @unit, @purchase_date, @expiration_date, @notes)
  `).run({ name, category, location, quantity, unit, purchase_date, expiration_date, notes });

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(serialize(row));
});

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const fields = ['name', 'category', 'location', 'quantity', 'unit', 'purchase_date', 'expiration_date', 'status', 'notes'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  if (updates.status && !VALID_STATUS.includes(updates.status)) {
    return res.status(400).json({ error: `status must be one of ${VALID_STATUS.join(', ')}` });
  }
  if (updates.category && !VALID_CATEGORY.includes(updates.category)) {
    return res.status(400).json({ error: `category must be one of ${VALID_CATEGORY.join(', ')}` });
  }

  const merged = { ...existing, ...updates };
  db.prepare(`
    UPDATE items SET name=@name, category=@category, location=@location, quantity=@quantity,
      unit=@unit, purchase_date=@purchase_date, expiration_date=@expiration_date,
      status=@status, notes=@notes, updated_at=datetime('now')
    WHERE id=@id
  `).run(merged);

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(serialize(row));
});

// POST /api/items/:id/throw-out - log that an item was thrown out
router.post('/:id/throw-out', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  const thrown_out_date = req.body.thrown_out_date || new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE items SET status='thrown_out', thrown_out_date=@thrown_out_date, updated_at=datetime('now')
    WHERE id=@id
  `).run({ id: req.params.id, thrown_out_date });

  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(serialize(row));
});

// POST /api/items/:id/consume - log that an item was used up
router.post('/:id/consume', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

  db.prepare(`UPDATE items SET status='consumed', updated_at=datetime('now') WHERE id=?`).run(req.params.id);
  const row = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  res.json(serialize(row));
});

router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM items WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM items WHERE id = ?').run(req.params.id);
  res.status(204).end();
});

module.exports = router;
