const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('./db');

const SESSION_COOKIE = 'session_token';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)
  `).run(token, userId, expiresAt);
  return token;
}

// Returns the user behind a valid, unexpired session token, else null:
// { userId, username, householdId, status, isAdmin, role }. householdId is
// null for the admin and for pending accounts. Read fresh on every request,
// so approving, rejecting or granting admin takes effect immediately.
function verifySessionToken(token) {
  if (!token) return null;
  const row = db.prepare(`
    SELECT s.user_id AS userId, s.expires_at AS expiresAt, u.username, u.household_id AS householdId,
      u.status, u.is_admin AS isAdmin, u.household_role AS role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?
  `).get(token);
  if (!row) return null;
  if (new Date(row.expiresAt) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return {
    userId: row.userId,
    username: row.username,
    householdId: row.householdId,
    status: row.status,
    isAdmin: row.isAdmin === 1,
    role: row.role,
  };
}

function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function destroySession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

function getSessionTokenFromReq(req) {
  return parseCookies(req)[SESSION_COOKIE];
}

// Secure flag: only set it when the connection is actually HTTPS - directly,
// or via X-Forwarded-Proto from a TLS-terminating proxy in front of the app
// (e.g. Cloudflare Tunnel). Requires app.set('trust proxy', 1) in index.js
// for req.secure to reflect the forwarded header correctly.
function setSessionCookie(req, res, token) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
}

module.exports = {
  hashPassword,
  verifyPassword,
  createSession,
  verifySessionToken,
  destroySession,
  destroyUserSessions,
  getSessionTokenFromReq,
  setSessionCookie,
  clearSessionCookie,
};
