// Admin-only routes: households, new-household codes, and pending account
// approvals. Mounted behind requireAdmin in index.js. The admin is
// system-wide and has no household of its own, so none of this touches
// items, locations or tags.

const express = require('express');
const db = require('../db');
const auth = require('../auth');
const households = require('../households');
const { log } = require('../logger');

const router = express.Router();

function pendingUsers() {
  return db.prepare(`
    SELECT id, username, created_at AS createdAt FROM users
    WHERE status = 'pending' ORDER BY created_at, id
  `).all();
}

// GET /api/admin/summary - counts for the admin page's header
router.get('/summary', (req, res) => {
  res.json({
    pendingCount: pendingUsers().length,
    householdCount: db.prepare('SELECT COUNT(*) AS n FROM households').get().n,
  });
});

// --- Households ----------------------------------------------------------

router.get('/households', (req, res) => {
  res.json(households.listHouseholds().map((h) => ({ ...h, inviteCode: households.formatCode(h.inviteCode) })));
});

// POST /api/admin/households - body: { name }
router.post('/households', (req, res) => {
  try {
    const h = households.createHousehold(req.body.name);
    log(`HOUSEHOLD CREATED ${h.id} "${h.name}" by admin ${req.username}`);
    res.status(201).json({ ...h, inviteCode: households.formatCode(h.inviteCode) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/admin/households/:id - body: { name }
router.patch('/households/:id', (req, res) => {
  const before = households.getHousehold(req.params.id);
  if (!before) return res.status(404).json({ error: 'not found' });
  try {
    const h = households.renameHousehold(before.id, req.body.name);
    log(`HOUSEHOLD RENAMED ${h.id} "${before.name}" -> "${h.name}" by admin ${req.username}`);
    res.json({ ...h, inviteCode: households.formatCode(h.inviteCode) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- New-household codes -------------------------------------------------

router.get('/codes', (req, res) => {
  res.json(households.listNewHouseholdCodes().map((c) => ({ ...c, code: households.formatCode(c.code) })));
});

// POST /api/admin/codes - body: { note? } (who it's for, as a reminder)
router.post('/codes', (req, res) => {
  const code = households.createNewHouseholdCode(req.body.note, req.userId);
  log(`NEW-HOUSEHOLD CODE ISSUED by admin ${req.username}`);
  res.status(201).json({ code: households.formatCode(code) });
});

// DELETE /api/admin/codes/:code - revoke an unused code
router.delete('/codes/:code', (req, res) => {
  if (!households.revokeNewHouseholdCode(req.params.code)) return res.status(404).json({ error: 'no unused code like that' });
  log(`NEW-HOUSEHOLD CODE REVOKED by admin ${req.username}`);
  res.status(204).end();
});

// --- Pending accounts ----------------------------------------------------

router.get('/pending', (req, res) => {
  res.json(pendingUsers());
});

function getPending(id) {
  return db.prepare("SELECT id, username FROM users WHERE id = ? AND status = 'pending'").get(id);
}

// POST /api/admin/users/:id/approve - body: { householdId } to add them to an
// existing household, or { newHouseholdName } to create one for them.
router.post('/users/:id/approve', (req, res) => {
  const user = getPending(req.params.id);
  if (!user) return res.status(404).json({ error: 'no pending account like that' });

  const newName = (req.body.newHouseholdName || '').trim();
  let household;
  if (newName) {
    household = db.transaction(() => {
      const h = households.createHousehold(newName);
      db.prepare("UPDATE users SET status = 'active', household_id = ? WHERE id = ?").run(h.id, user.id);
      return h;
    })();
  } else {
    household = households.getHousehold(req.body.householdId);
    if (!household) return res.status(400).json({ error: 'choose a household, or name a new one' });
    db.prepare("UPDATE users SET status = 'active', household_id = ? WHERE id = ?").run(household.id, user.id);
  }

  log(`APPROVED "${user.username}" into household ${household.id} "${household.name}" by admin ${req.username}`);
  res.json({ username: user.username, household: { id: household.id, name: household.name } });
});

// POST /api/admin/users/:id/reject - the account can no longer log in. It's
// kept (not deleted) so the username can't simply be signed up again.
router.post('/users/:id/reject', (req, res) => {
  const user = getPending(req.params.id);
  if (!user) return res.status(404).json({ error: 'no pending account like that' });
  db.prepare("UPDATE users SET status = 'rejected' WHERE id = ?").run(user.id);
  auth.destroyUserSessions(user.id);
  log(`REJECTED "${user.username}" by admin ${req.username}`);
  res.status(204).end();
});

module.exports = router;
