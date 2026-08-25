const express = require('express');
const db = require('../db');
const auth = require('../auth');
const { log } = require('../logger');

const router = express.Router();

const MIN_PASSWORD_LENGTH = 6;

// POST /api/auth/signup - body: { username, password }
router.post('/signup', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  if (!username) return res.status(400).json({ error: 'username is required' });
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return res.status(409).json({ error: 'that username is already taken' });

  const passwordHash = auth.hashPassword(password);
  const result = db.prepare(`
    INSERT INTO users (username, password_hash) VALUES (?, ?)
  `).run(username, passwordHash);

  const token = auth.createSession(result.lastInsertRowid);
  auth.setSessionCookie(req, res, token);
  log(`SIGNUP "${username}" from ${req.ip}`);
  res.status(201).json({ username });
});

// POST /api/auth/login - body: { username, password }
router.post('/login', (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';

  const user = db.prepare('SELECT id, username, password_hash FROM users WHERE username = ?').get(username);
  if (!user || !auth.verifyPassword(password, user.password_hash)) {
    log(`LOGIN FAILED "${username}" from ${req.ip}`);
    return res.status(401).json({ error: 'invalid username or password' });
  }

  const token = auth.createSession(user.id);
  auth.setSessionCookie(req, res, token);
  log(`LOGIN "${username}" from ${req.ip}`);
  res.json({ username: user.username });
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
  res.json({ username: session.username });
});

module.exports = router;
