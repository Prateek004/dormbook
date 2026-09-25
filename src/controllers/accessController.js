 'use strict';
/**
 * Staff sign-in with mobile number + MPIN (no password needed).
 *
 *  1. Owner adds a user (name + mobile). The server makes a 6-digit login code.
 *     The owner sees it on screen (and it is also sent by SMS when MSG91 is set up).
 *  2. Staff opens DormBook → "First time / Forgot MPIN" → mobile + code → sets a 4 or 6 digit MPIN.
 *  3. From then on: mobile + MPIN on the normal sign-in screen.
 *
 * Codes: 6 digits, stored as a bcrypt hash, one use, 5 wrong tries max, expire
 * (24 h when made by the owner, 15 min when the staff asks for one by SMS).
 */
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { writeAudit } = require('../middleware/auditLog');
const { randomDigits, mobile10, mpinProblem } = require('../util/security');
const sms = require('../services/smsService');
const { makeToken, publicUser, accountBlock } = require('./authController');

const CODE_TRIES = 5;
const OWNER_CODE_HOURS = 24;
const SELF_CODE_MINUTES = 15;
const STAFF_ROLES = ['manager', 'reception'];

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');

/** Make a new code for a user. Older unused codes for that user stop working. */
function issueLoginCode(db, user, { createdBy, purpose }) {
  const code = randomDigits(6);
  const now = Date.now();
  const expires = new Date(now + (purpose === 'self' ? SELF_CODE_MINUTES * 60000 : OWNER_CODE_HOURS * 3600000)).toISOString();
  db.transaction(() => {
    db.prepare("UPDATE login_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(new Date(now).toISOString(), user.id);
    db.prepare(`INSERT INTO login_codes (id, user_id, code_hash, purpose, attempts, expires_at, created_by, created_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?)`).run(uuidv4(), user.id, bcrypt.hashSync(code, 10), purpose, expires, createdBy || null, new Date(now).toISOString());
  })();
  return { code, expires_at: expires };
}

function findStaffByMobile(db, mobile) {
  const m = mobile10(mobile);
  if (!m) return null;
  return db.prepare(`SELECT * FROM users WHERE mobile = ? AND is_active = 1 AND role IN ('manager','reception')`).get(m) || null;
}

/** POST /api/v1/staff/:id/login-code — owner makes a code for a staff member (first sign-in or forgot MPIN). */
async function ownerLoginCode(req, res) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND property_id = ?').get(req.params.id, req.user.property_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (!STAFF_ROLES.includes(user.role)) return res.status(400).json({ error: 'Login codes are only for staff' });
  if (!user.is_active) return res.status(409).json({ error: 'This user is blocked. Unblock first.' });
  const out = issueLoginCode(db, user, { createdBy: req.user.id, purpose: 'owner' });
  const sms_sent = await sms.sendLoginCode(user.mobile, out.code);
  writeAudit({ propertyId: req.user.property_id, userId: req.user.id, action: 'LOGIN_CODE_CREATED', entityType: 'users',
    entityId: user.id, snapshot: { name: user.name, sms_sent }, ip: req.ip });
  return res.json({ ...out, sms_sent, name: user.name, mobile: user.mobile });
}

/** POST /api/v1/auth/staff/request-code {mobile} — staff asks for a code by SMS. Same answer whether or not the number exists. */
async function requestCode(req, res) {
  const answer = {
    ok: true, sms_enabled: sms.isConfigured(),
    message: sms.isConfigured()
      ? 'If this mobile is a staff login, a code was sent by SMS. No SMS in 2 minutes? Ask your owner for a login code.'
      : 'Ask your owner for a login code (Users & Access → Login code).',
  };
  if (!sms.isConfigured()) return res.json(answer);
  const db = getDb();
  const user = findStaffByMobile(db, str((req.body || {}).mobile));
  if (!user) return res.json(answer);
  // At most 3 SMS per hour per person (SMS costs money and can be abused).
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const recent = db.prepare("SELECT COUNT(*) n FROM login_codes WHERE user_id = ? AND purpose = 'self' AND created_at > ?").get(user.id, hourAgo).n;
  if (recent >= 3) return res.json(answer);
  const out = issueLoginCode(db, user, { createdBy: null, purpose: 'self' });
  await sms.sendLoginCode(user.mobile, out.code);
  return res.json(answer);
}

/** POST /api/v1/auth/staff/set-mpin {mobile, code, mpin} — check the code, save the MPIN, sign in. */
function setMpin(req, res) {
  const b = req.body || {};
  const code = str(b.code).replace(/\s/g, ''), mpin = str(b.mpin);
  if (!mobile10(b.mobile)) return res.status(400).json({ error: 'Type your 10-digit mobile number' });
  if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Login code is 6 digits' });
  const db = getDb();
  const user = findStaffByMobile(db, b.mobile);
  const wrong = () => res.status(400).json({ error: 'Code is wrong or has expired. Ask your owner for a new code.' });
  if (!user) { bcrypt.compareSync(code, '$2a$10$Y4fp0gScXHKUCkbIm5iO0OLbCAKXbXWHPThFMD88p1ozdkTbXyW2q'); return wrong(); }
  const row = db.prepare(`SELECT * FROM login_codes WHERE user_id = ? AND used_at IS NULL AND expires_at > ?
    ORDER BY created_at DESC LIMIT 1`).get(user.id, new Date().toISOString());
  if (!row || row.attempts >= CODE_TRIES) return wrong();
  if (!bcrypt.compareSync(code, row.code_hash)) {
    db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return wrong();
  }
  // Code is right. Check the MPIN only now, so a bad MPIN doesn't burn the code.
  const problem = mpinProblem(mpin, user.mobile);
  if (problem) return res.status(400).json({ error: problem, code: 'BAD_MPIN' });
  const blocked = accountBlock(db, user);
  if (blocked) return res.status(403).json({ error: blocked });

  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  db.transaction(() => {
    db.prepare('UPDATE login_codes SET used_at = ? WHERE id = ?').run(now, row.id);
    db.prepare(`UPDATE users SET mpin_hash = ?, mpin_set_at = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL,
      updated_at = datetime('now') WHERE id = ?`).run(bcrypt.hashSync(mpin, 10), now, now, user.id);
  })();
  writeAudit({ propertyId: user.property_id, userId: user.id, action: 'MPIN_SET', entityType: 'users', entityId: user.id,
    snapshot: { name: user.name }, ip: req.ip });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return res.json({ token: makeToken(fresh), user: publicUser(fresh) });
}

/** POST /api/v1/auth/change-mpin {current_mpin, new_mpin} — signed-in staff changes their MPIN. */
function changeMpin(req, res) {
  const b = req.body || {};
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !user.mpin_hash) return res.status(400).json({ error: 'You sign in with a password, not an MPIN' });
  let ok = false;
  try { ok = bcrypt.compareSync(str(b.current_mpin), user.mpin_hash); } catch (_) { ok = false; }
  if (!ok) return res.status(400).json({ error: 'Current MPIN is wrong' });   // 400, not 401: a typo must not sign you out
  const problem = mpinProblem(str(b.new_mpin), user.mobile);
  if (problem) return res.status(400).json({ error: problem });
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  db.prepare("UPDATE users SET mpin_hash = ?, mpin_set_at = ?, pwd_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(str(b.new_mpin), 10), now, now, user.id);
  writeAudit({ propertyId: user.property_id, userId: user.id, action: 'MPIN_CHANGED', entityType: 'users', entityId: user.id,
    snapshot: {}, ip: req.ip });
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
  return res.json({ ok: true, token: makeToken(fresh) });
}

module.exports = { issueLoginCode, ownerLoginCode, requestCode, setMpin, changeMpin };
