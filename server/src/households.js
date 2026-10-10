// Households, their invite codes, and the admin-issued new-household codes.
// Used by signup, the household and admin routes, and scripts/admin.js.

const crypto = require('crypto');
const db = require('./db');

// Same format as migration 002: 8 characters without look-alikes (no 0/O,
// 1/I/L), shown as XXXX-XXXX, stored without the dash.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

function normalizeCode(code) {
  return typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
}

function formatCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

// A code not already used by any household or new-household code, so one
// code can never mean two things at signup.
function generateCode() {
  for (;;) {
    const bytes = crypto.randomBytes(CODE_LENGTH);
    const code = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
    const taken = db.prepare(`
      SELECT 1 FROM households WHERE invite_code = ?
      UNION ALL SELECT 1 FROM new_household_codes WHERE code = ?
    `).get(code, code);
    if (!taken) return code;
  }
}

function cleanName(name) {
  return typeof name === 'string' ? name.trim().slice(0, 80) : '';
}

function getHousehold(id) {
  return db.prepare('SELECT id, name, invite_code AS inviteCode, created_at AS createdAt FROM households WHERE id = ?').get(id);
}

function listHouseholds() {
  return db.prepare(`
    SELECT h.id, h.name, h.invite_code AS inviteCode, h.created_at AS createdAt,
      (SELECT COUNT(*) FROM users u WHERE u.household_id = h.id AND u.status = 'active') AS memberCount,
      (SELECT COUNT(*) FROM items i WHERE i.household_id = h.id) AS itemCount
    FROM households h ORDER BY h.id
  `).all();
}

function createHousehold(name) {
  name = cleanName(name);
  if (!name) throw new Error('household name is required');
  const result = db.prepare('INSERT INTO households (name, invite_code) VALUES (?, ?)').run(name, generateCode());
  return getHousehold(result.lastInsertRowid);
}

function renameHousehold(id, name) {
  name = cleanName(name);
  if (!name) throw new Error('household name is required');
  db.prepare('UPDATE households SET name = ? WHERE id = ?').run(name, id);
  return getHousehold(id);
}

function regenerateInviteCode(id) {
  db.prepare('UPDATE households SET invite_code = ? WHERE id = ?').run(generateCode(), id);
  return getHousehold(id);
}

function householdMembers(id) {
  return db.prepare(`
    SELECT username, household_role AS role, created_at AS createdAt FROM users
    WHERE household_id = ? AND status = 'active' ORDER BY username
  `).all(id);
}

// What a code typed at signup means: joining an existing household, creating
// a new one (an unused admin-issued code), or nothing.
function lookupCode(rawCode) {
  const code = normalizeCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  const household = db.prepare('SELECT id, name FROM households WHERE invite_code = ?').get(code);
  if (household) return { type: 'join', code, household };
  const newCode = db.prepare('SELECT code FROM new_household_codes WHERE code = ? AND used_at IS NULL').get(code);
  if (newCode) return { type: 'new_household', code };
  return null;
}

function listNewHouseholdCodes() {
  return db.prepare(`
    SELECT c.code, c.note, c.created_at AS createdAt, c.used_at AS usedAt,
      u.username AS usedBy, h.name AS householdName
    FROM new_household_codes c
    LEFT JOIN users u ON u.id = c.used_by
    LEFT JOIN households h ON h.id = c.household_id
    ORDER BY c.used_at IS NOT NULL, c.created_at DESC
  `).all();
}

function createNewHouseholdCode(note, createdBy) {
  const code = generateCode();
  db.prepare('INSERT INTO new_household_codes (code, note, created_by) VALUES (?, ?, ?)')
    .run(code, typeof note === 'string' ? note.trim().slice(0, 200) : '', createdBy || null);
  return code;
}

// Only unused codes can be revoked; a used one is kept as a record of who
// created which household.
function revokeNewHouseholdCode(rawCode) {
  return db.prepare('DELETE FROM new_household_codes WHERE code = ? AND used_at IS NULL').run(normalizeCode(rawCode)).changes > 0;
}

function markNewHouseholdCodeUsed(code, userId, householdId) {
  db.prepare(`
    UPDATE new_household_codes SET used_at = datetime('now'), used_by = ?, household_id = ?
    WHERE code = ? AND used_at IS NULL
  `).run(userId, householdId, code);
}

module.exports = {
  CODE_LENGTH,
  normalizeCode,
  formatCode,
  getHousehold,
  listHouseholds,
  createHousehold,
  renameHousehold,
  regenerateInviteCode,
  householdMembers,
  lookupCode,
  listNewHouseholdCodes,
  createNewHouseholdCode,
  revokeNewHouseholdCode,
  markNewHouseholdCodeUsed,
};
