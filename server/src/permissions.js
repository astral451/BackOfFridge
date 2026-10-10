// The one place that decides what a logged-in user may do. Every mutating
// route asks can(user, action) through requirePermission(); none of them
// check roles themselves. Today every active member of a household may do
// everything in it, but users.household_role exists so finer permissions
// later mean changing this file and the roles, not every route.

const ACTIONS = [
  'items:write',      // add, edit, consume, throw out, undo, delete items
  'locations:write',  // add/delete managed locations
  'tags:write',       // add/delete managed tags
  'household:invite', // see and regenerate the household's invite code
];

function isActiveMember(user) {
  return !!user && user.status === 'active' && Number.isInteger(user.householdId);
}

function can(user, action) {
  if (!ACTIONS.includes(action)) throw new Error(`unknown permission: ${action}`);
  // Every role currently has every household permission.
  return isActiveMember(user);
}

function requirePermission(action) {
  return (req, res, next) => {
    if (!can(req.user, action)) return res.status(403).json({ error: 'not allowed' });
    next();
  };
}

module.exports = { ACTIONS, can, isActiveMember, requirePermission };
