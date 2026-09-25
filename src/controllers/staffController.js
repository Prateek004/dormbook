'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb }       = require('../db/connection');
const { writeAudit }  = require('../middleware/auditLog');
const { mobile10 } = require('../util/security');
const sms = require('../services/smsService');
const { issueLoginCode } = require('./accessController');
const { PERMISSIONS, ROLE_DEFAULTS, effectivePermissions, sanitizePermissions } = require('../middleware/permissions');

/** You can only hand out permissions you have yourself (no privilege escalation). */
function checkGrantable(req, perms) {
  if (!perms) return null;
  const mine = req.user.permissions || effectivePermissions(req.user);
  const extra = perms.filter((p) => !mine.includes(p));
  return extra.length ? `You cannot give permissions you don't have: ${extra.map((p) => PERMISSIONS[p]).join(', ')}` : null;
}

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

/** GET /api/v1/staff */
function listStaff(req, res) {
  const db = getDb();
  const staff = db.prepare(`
    SELECT * FROM users WHERE property_id = ? ORDER BY role, name
  `).all(req.user.property_id).map((u) => ({
    id: u.id, name: u.name, email: u.email, mobile: u.mobile, role: u.role, is_active: u.is_active, created_at: u.created_at,
    permissions: effectivePermissions(u), custom_permissions: !!u.permissions && u.role !== 'owner',
    has_mpin: !!u.mpin_hash,
    locked: !!(u.locked_until && u.locked_until > new Date().toISOString()),
  }));
  return res.json({ staff, all_permissions: PERMISSIONS, role_defaults: ROLE_DEFAULTS });
}

/** POST /api/v1/staff — password is optional: without one the user gets a login code and sets an MPIN. */
async function inviteStaff(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const accountId  = req.user.account_id;  // inherit from the inviting owner
  const { name, email, mobile, role, password } = req.body;
  const perms = req.body.permissions === undefined ? null : sanitizePermissions(req.body.permissions);
  const grantErr = checkGrantable(req, perms);
  if (grantErr) return res.status(403).json({ error: grantErr });

  if (!name || !mobile || !role) {
    return res.status(400).json({ error: 'name, mobile and role are required' });
  }
  if (typeof name !== 'string' || String(name).trim().length > 120) return res.status(400).json({ error: 'Name is too long' });
  const VALID_ROLES = ['manager', 'reception'];
  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
  }
  const hasPassword = password !== undefined && password !== null && password !== '';
  if (hasPassword && (String(password).length < 8 || String(password).length > 200)) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }
  const mobileClean = mobile10(mobile);
  if (!mobileClean) return res.status(400).json({ error: 'Type a 10-digit mobile number' });
  if (email && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 120)) {
    return res.status(400).json({ error: 'Email is not valid' });
  }

  // Check uniqueness for mobile (system-wide) and email (if provided)
  const existingMobile = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobileClean);
  if (existingMobile) return res.status(409).json({ error: 'Mobile number already registered' });

  if (email) {
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
    if (existing) return res.status(409).json({ error: 'Email already registered' });
  }

  const id  = uuidv4();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (id, account_id, property_id, name, email, mobile, password_hash, role, is_active, created_at, updated_at, permissions)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).run(
    id, accountId, propertyId, String(name).trim(),
    email ? String(email).toLowerCase().trim() : null,
    // No password → an unguessable one nobody knows; the user signs in with MPIN.
    mobileClean, bcrypt.hashSync(hasPassword ? String(password) : crypto.randomBytes(32).toString('hex'), BCRYPT_ROUNDS),
    role, now, now, perms ? JSON.stringify(perms) : null
  );

  writeAudit({
    propertyId, userId: req.user.id, action: 'STAFF_CREATED',
    entityType: 'users', entityId: id,
    snapshot: { name, role, mobile: mobileClean, permissions: perms },
    ip: req.ip,
  });

  let login_code = null;
  if (!hasPassword) {
    const created = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    login_code = issueLoginCode(db, created, { createdBy: req.user.id, purpose: 'owner' });
    login_code.sms_sent = await sms.sendLoginCode(mobileClean, login_code.code);
  }

  return res.status(201).json({
    id, name, email: email || null, mobile: mobileClean, role, is_active: 1,
    permissions: effectivePermissions({ role, permissions: perms ? JSON.stringify(perms) : null }),
    login_code,
  });
}

/** PATCH /api/v1/staff/:id */
function updateStaff(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const { name, role, is_active, new_password } = req.body;
  const resetPerms = req.body.permissions === null;           // null = back to role defaults
  const perms = req.body.permissions === undefined || resetPerms ? null : sanitizePermissions(req.body.permissions);
  const grantErr = checkGrantable(req, perms);
  if (grantErr) return res.status(403).json({ error: grantErr });

  const user = db.prepare('SELECT * FROM users WHERE id = ? AND property_id = ?').get(req.params.id, propertyId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (user.role === 'owner') return res.status(403).json({ error: 'Cannot modify owner account' });
  if (user.id === req.user.id && (perms || resetPerms)) return res.status(403).json({ error: 'You cannot change your own permissions' });
  if (new_password !== undefined && (String(new_password).length < 8 || String(new_password).length > 200)) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  const newName     = name     !== undefined ? String(name).trim()  : user.name;
  const newRole     = role     !== undefined ? role         : user.role;
  const newIsActive = is_active !== undefined ? (is_active ? 1 : 0) : user.is_active;

  if (role && !['manager', 'reception'].includes(newRole)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  db.prepare(`
    UPDATE users SET name=?, role=?, is_active=?, updated_at=datetime('now') WHERE id=?
  `).run(newName, newRole, newIsActive, req.params.id);
  if (perms || resetPerms) {
    db.prepare('UPDATE users SET permissions = ? WHERE id = ?').run(perms ? JSON.stringify(perms) : null, req.params.id);
  }
  if (new_password !== undefined) {
    // New password from the owner: that user's other sessions end.
    db.prepare('UPDATE users SET password_hash = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?')
      .run(bcrypt.hashSync(String(new_password), BCRYPT_ROUNDS), new Date().toISOString(), req.params.id);
  }
  if (req.body.unlock) db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(req.params.id);

  writeAudit({
    propertyId, userId: req.user.id, action: 'STAFF_UPDATED',
    entityType: 'users', entityId: req.params.id,
    snapshot: { from: { role: user.role, is_active: user.is_active, permissions: user.permissions },
      to: { role: newRole, is_active: newIsActive, permissions: perms, password_reset: new_password !== undefined } },
    ip: req.ip,
  });

  const updated = db.prepare('SELECT id, name, email, mobile, role, is_active, permissions FROM users WHERE id = ?').get(req.params.id);
  return res.json({ ...updated, permissions: effectivePermissions(updated) });
}

/** DELETE /api/v1/staff/:id — soft delete (set is_active=0) */
function deactivateStaff(req, res) {
  const db = getDb();
  const propertyId = req.user.property_id;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND property_id = ?').get(req.params.id, propertyId);
  if (!user) return res.status(404).json({ error: 'Staff member not found' });
  if (user.role === 'owner') return res.status(403).json({ error: 'Cannot deactivate owner account' });
  if (user.id === req.user.id) return res.status(403).json({ error: 'Cannot deactivate your own account' });

  // Blocked: signed out everywhere at once (is_active is checked on every request too).
  db.prepare("UPDATE users SET is_active=0, pwd_changed_at=?, updated_at=datetime('now') WHERE id=?").run(new Date().toISOString(), req.params.id);
  writeAudit({
    propertyId, userId: req.user.id, action: 'STAFF_DEACTIVATED',
    entityType: 'users', entityId: req.params.id,
    snapshot: { name: user.name, role: user.role },
    ip: req.ip,
  });
  return res.json({ message: 'Staff member deactivated' });
}

module.exports = { listStaff, inviteStaff, updateStaff, deactivateStaff };
