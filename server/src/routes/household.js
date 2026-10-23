const express = require('express');
const households = require('../households');
const { requirePermission } = require('../permissions');
const { log } = require('../logger');

const router = express.Router();

function describe(household) {
  return {
    name: household.name,
    inviteCode: households.formatCode(household.inviteCode),
    members: households.householdMembers(household.id).map((m) => m.username),
  };
}

// GET /api/household - the logged-in user's household, its members, and
// the invite code to give someone so they can join it.
router.get('/', requirePermission('household:invite'), (req, res) => {
  res.json(describe(households.getHousehold(req.householdId)));
});

// POST /api/household/invite-code - replace the invite code, e.g. after
// sharing it with someone who has now joined. The old code stops working.
// Existing members are unaffected.
router.post('/invite-code', requirePermission('household:invite'), (req, res) => {
  const household = households.regenerateInviteCode(req.householdId);
  log(`INVITE CODE REGENERATED for household ${req.householdId} by ${req.username}`);
  res.json(describe(household));
});

// PATCH /api/household - body: { name }. Any member can rename their own
// household; the admin creates households but doesn't rename them.
router.patch('/', requirePermission('household:rename'), (req, res) => {
  const before = households.getHousehold(req.householdId);
  let household;
  try {
    household = households.renameHousehold(req.householdId, req.body.name);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  log(`HOUSEHOLD RENAMED ${req.householdId} "${before.name}" -> "${household.name}" by ${req.username}`);
  res.json(describe(household));
});

module.exports = router;
