// Admin-only routes: new-household codes, pending account approvals, and
// moving or removing household members. (Renaming a household is up to its members: see
// routes/household.js.) Mounted behind requireAdmin in index.js. The admin is
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

// Every household with its members. Households are created only by a
// new-household code or by approving a pending account into a new one, so
// there's no route here to create an empty one.
router.get('/households', (req, res) => {
  res.json(households.listHouseholds().map((h) => ({
    ...h,
    inviteCode: households.formatCode(h.inviteCode),
    members: households.householdMembers(h.id).map(({ id, username }) => ({ id, username })),
  })));
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

// A member of a household (status active, with a household).
function getMember(id) {
  return db.prepare(`
    SELECT id, username, household_id AS householdId FROM users
    WHERE id = ? AND status = 'active' AND household_id IS NOT NULL
  `).get(id);
}

// Someone moved or removed out of a household still knows its invite code,
// and could sign up again with it under a new name. So the household they
// left gets a new code; its remaining members see it on Settings.
function replaceCodeAfterLeaving(householdId) {
  households.regenerateInviteCode(householdId);
}

// POST /api/admin/users/:id/move - body: { householdId }. Moves a member to
// another household. Items stay with the household they were added to.
router.post('/users/:id/move', (req, res) => {
  const user = getMember(req.params.id);
  if (!user) return res.status(404).json({ error: 'no household member like that' });
  const target = households.getHousehold(req.body.householdId);
  if (!target) return res.status(400).json({ error: 'choose a household to move them to' });
  if (target.id === user.householdId) return res.status(400).json({ error: 'they are already in that household' });

  const from = households.getHousehold(user.householdId);
  db.transaction(() => {
    db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(target.id, user.id);
    replaceCodeAfterLeaving(from.id);
  })();
  log(`MOVED "${user.username}" from household ${from.id} "${from.name}" to ${target.id} "${target.name}" by admin ${req.username}; household ${from.id} invite code replaced`);
  res.json({ username: user.username, household: { id: target.id, name: target.name } });
});

// POST /api/admin/users/:id/remove - takes a member out of their household.
// The account goes back to waiting for approval: it can still log in but
// sees nothing, and shows up in the pending list again, where it can be
// approved into a household or rejected.
router.post('/users/:id/remove', (req, res) => {
  const user = getMember(req.params.id);
  if (!user) return res.status(404).json({ error: 'no household member like that' });

  const from = households.getHousehold(user.householdId);
  db.transaction(() => {
    db.prepare("UPDATE users SET household_id = NULL, status = 'pending' WHERE id = ?").run(user.id);
    replaceCodeAfterLeaving(from.id);
  })();
  log(`REMOVED "${user.username}" from household ${from.id} "${from.name}" by admin ${req.username} (now waiting for approval); invite code replaced`);
  res.status(204).end();
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
