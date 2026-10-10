const express = require('express');
const db = require('../db');
const auth = require('../auth');
const households = require('../households');
const { log } = require('../logger');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 6;

// What the front end needs to know about the logged-in user to decide where
// to send them: the inventory, the "waiting for approval" page, or the admin
// page.
function describeUser(session) {
  const household = session.householdId ? households.getHousehold(session.householdId) : null;
  return {
    username: session.username,
    status: session.status,
    isAdmin: session.isAdmin,
    household: household ? { id: household.id, name: household.name } : null,
  };
}

// POST /api/auth/check-code - body: { code }. Tells the signup form what an
// invite code means, so it can ask for a household name when the code
// creates a new household, or show which household it joins.
router.post('/check-code', (req, res) => {
  const found = households.lookupCode(req.body.code);
  if (!found) return res.status(404).json({ error: 'invite code not recognised' });
  if (found.type === 'join') return res.json({ type: 'join', householdName: found.household.name });
  res.json({ type: 'new_household' });
});

// POST /api/auth/signup - body: { username, password, code?, householdName? }
//   - code is a household's invite code: join that household.
//   - code is an unused new-household code (from the admin): create a
//     household named householdName and become its first member.
//   - no code: the account is created as pending, with no household and no
//     access to any data, until the admin approves it.
router.post('/signup', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const rawCode = (req.body.code || '').trim();

  if (!username) return res.status(400).json({ error: 'username is required' });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'that username is already taken' });

  const found = rawCode ? households.lookupCode(rawCode) : null;
  if (rawCode && !found) return res.status(400).json({ error: 'invite code not recognised' });
  const householdName = (req.body.householdName || '').trim();
  if (found && found.type === 'new_household' && !householdName) {
    return res.status(400).json({ error: 'household name is required for a new household' });
  }

  const passwordHash = auth.hashPassword(password);
  const insertUser = db.prepare(`
    INSERT INTO users (username, password_hash, household_id, status) VALUES (?, ?, ?, ?)
  `);

  let householdId = null;
  const userId = db.transaction(() => {
    if (!found) {
      return insertUser.run(username, passwordHash, null, 'pending').lastInsertRowid;
    }
    if (found.type === 'join') {
      householdId = found.household.id;
      return insertUser.run(username, passwordHash, householdId, 'active').lastInsertRowid;
    }
    householdId = households.createHousehold(householdName).id;
    const id = insertUser.run(username, passwordHash, householdId, 'active').lastInsertRowid;
    households.markNewHouseholdCodeUsed(found.code, id, householdId);
    return id;
  })();

  const token = auth.createSession(userId);
  auth.setSessionCookie(req, res, token);
  if (!found) {
    log(`SIGNUP PENDING "${username}" from ${req.ip} - waiting for admin approval`);
  } else if (found.type === 'join') {
    log(`SIGNUP "${username}" from ${req.ip} joined household ${householdId}`);
  } else {
    log(`SIGNUP "${username}" from ${req.ip} created household ${householdId} "${householdName}"`);
  }
  res.status(201).json(describeUser(auth.verifySessionToken(token)));
});

// POST /api/auth/login - body: { username, password }
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const user = db.prepare('SELECT id, username, password_hash, status FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    log(`LOGIN FAILED "${username}" from ${req.ip}`);
    return res.status(401).json({ error: 'invalid username or password' });
  }
  if (user.status === 'rejected') {
    log(`LOGIN REFUSED "${username}" from ${req.ip} - account was not approved`);
    return res.status(403).json({ error: 'this account was not approved' });
  }

  const token = auth.createSession(user.id);
  auth.setSessionCookie(req, res, token);
  log(`LOGIN "${username}" from ${req.ip}`);
  res.json(describeUser(auth.verifySessionToken(token)));
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  auth.destroySession(auth.getSessionTokenFromReq(req));
  auth.clearSessionCookie(res);
  res.status(204).end();
});

// GET /api/auth/me - current logged-in user, or 401 if not logged in
router.get('/me', (req, res) => {
  const session = auth.verifySessionToken(auth.getSessionTokenFromReq(req));
  if (!session) return res.status(401).json({ error: 'not logged in' });
  res.json(describeUser(session));
});

module.exports = router;
