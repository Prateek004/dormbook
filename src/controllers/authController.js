'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { insertAdaptive } = require('../util/dbcompat');
const { scheduleWhatsApp } = require('../services/whatsappService');
const sms = require('../services/smsService');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DUMMY_HASH    = '$2a$12$eLr2FWz7m3VbmJBbCzKQWOaOEDtB7lGS6cLUvp5Kx3kH1AHdmq0W6';

// Wrong tries before a 15-minute lock; after MPIN_WIPE_AT wrong tries in a row the MPIN
// stops working and the owner must give a new login code.
const LOCK_AFTER   = 5;
const LOCK_MINUTES = 15;
const MPIN_WIPE_AT = 10;
const OTP_MAX_TRIES = 5;

// Same secret for signing and verifying (previously login signed with a dev
// fallback while the middleware rejected it in production → every request 401).
const { getJwtSecret } = require('../middleware/auth');
const { effectivePermissions } = require('../middleware/permissions');

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, property: user.property_id, account: user.account_id },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h', algorithm: 'HS256' }
  );
}

function publicUser(user) {
  return {
    id:          user.id,
    name:        user.name,
    email:       user.email,
    mobile:      user.mobile,
    role:        user.role,
    property_id: user.property_id,
    account_id:  user.account_id,
    has_mpin:    !!user.mpin_hash,
    permissions: effectivePermissions(user),   // what this user may do (drives the menu)
  };
}

/** Why this user's business can't sign in right now (or null). Superadmin is never blocked. */
function accountBlock(db, user) {
  if (user.role === 'superadmin' || !user.account_id) return null;
  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
  if (!account) return null;
  if (account.suspended_at) return 'Account suspended. Contact support.';
  if (account.plan === 'trial' && account.trial_ends_at < new Date().toISOString()) return 'Trial expired. Contact support to continue.';
  return null;
}

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const minutesLeft = (iso) => Math.max(1, Math.ceil((Date.parse(iso) - Date.now()) / 60000));

/** Record a wrong password / MPIN. Locks for 15 minutes every 5 misses; wipes the MPIN at 10. */
function recordFailure(db, user) {
  const n = (user.failed_logins || 0) + 1;
  const lock = n % LOCK_AFTER === 0 ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
  db.prepare('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?').run(n, lock, user.id);
  if (n >= MPIN_WIPE_AT && user.mpin_hash) {
    db.prepare('UPDATE users SET mpin_hash = NULL WHERE id = ?').run(user.id);
    console.warn(`[AUTH] MPIN switched off after ${n} wrong tries for user ${user.id}`);
  }
  return lock;
}

/** POST /api/v1/auth/login — email or mobile + password, or mobile + MPIN (4/6 digits). */
function login(req, res) {
  const body = req.body || {};
  const identifier = str(body.email || body.mobile).toLowerCase().trim();
  const secret = str(body.password);
  if (!identifier || !secret) {
    return res.status(400).json({ error: 'Login credential and password are required' });
  }
  if (identifier.length > 120 || secret.length > 200) return res.status(400).json({ error: 'Invalid credentials' });

  let db;
  try { db = getDb(); } catch (err) {
    console.error('[AUTH] DB not ready:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  const digits = identifier.replace(/\D/g, '');
  const asMobile = /^[\d\s+()-]+$/.test(identifier) ? (digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits) : identifier;
  const user = db.prepare('SELECT * FROM users WHERE (email = ? OR mobile = ?) AND is_active = 1').get(identifier, asMobile);

  if (user && user.locked_until && user.locked_until > new Date().toISOString()) {
    return res.status(429).json({ error: `Too many wrong tries. Try again in ${minutesLeft(user.locked_until)} minutes.` });
  }

  // 4 or 6 digits = MPIN (passwords are at least 8 characters).
  const isMpin = !!(user && user.mpin_hash && /^(\d{4}|\d{6})$/.test(secret));
  const hashToCheck = user ? (isMpin ? user.mpin_hash : user.password_hash) : DUMMY_HASH;
  let valid = false;
  try { valid = bcrypt.compareSync(secret, hashToCheck); } catch (_) { valid = false; }

  if (!user || !valid) {
    if (user) {
      const lock = recordFailure(db, user);
      if (lock) return res.status(429).json({ error: `Too many wrong tries. Try again in ${LOCK_MINUTES} minutes.` });
    }
    return res.status(401).json({ error: /^\d{4,6}$/.test(secret) ? 'Wrong mobile number or MPIN' : 'Invalid credentials' });
  }

  const blocked = accountBlock(db, user);
  if (blocked) return res.status(403).json({ error: blocked });

  if (user.failed_logins || user.locked_until) {
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }
  return res.json({ token: makeToken(user), user: publicUser(user) });
}

/** POST /api/v1/auth/register — self-serve signup */
function register(req, res) {
  const b = req.body || {};
  const business_name = str(b.business_name).trim().slice(0, 120);
  const owner_name = str(b.owner_name).trim().slice(0, 120);
  const password = str(b.password);
  const email = str(b.email).toLowerCase().trim().slice(0, 120);
  const pg_name = str(b.pg_name).trim().slice(0, 120);
  const city = str(b.city).trim().slice(0, 60);

  if (!business_name || !owner_name || !b.mobile || !password) {
    return res.status(400).json({ error: 'business_name, owner_name, mobile, and password are required' });
  }
  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const mobileTrim = str(b.mobile).replace(/\D/g, '');
  if (mobileTrim.length < 10 || mobileTrim.length > 13) {
    return res.status(400).json({ error: 'Invalid mobile number' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Email is not valid' });

  const db = getDb();

  // Check mobile uniqueness
  const existing = db.prepare('SELECT id FROM users WHERE mobile = ?').get(mobileTrim);
  if (existing) {
    return res.status(409).json({ error: 'Mobile number already registered' });
  }

  const accountId  = uuidv4();
  const propertyId = uuidv4();
  const userId     = uuidv4();
  const now        = new Date().toISOString();
  const trialEnds  = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const hash       = bcrypt.hashSync(password, BCRYPT_ROUNDS);

  try {
    db.transaction(() => {
      // insertAdaptive: older databases have extra NOT NULL columns
      // (owner_name, owner_mobile, owner_id, city NOT NULL) — fill them when
      // present so signup works on every schema version.
      insertAdaptive(db, 'accounts', {
        id: accountId, business_name, plan: 'trial', trial_ends_at: trialEnds,
        created_at: now, owner_name, owner_mobile: mobileTrim,
        owner_email: email || null,
      });

      insertAdaptive(db, 'properties', {
        id: propertyId, account_id: accountId, name: pg_name || business_name,
        city, owner_id: userId, created_at: now,
      });

      db.prepare(`
        INSERT INTO users (id, account_id, property_id, name, email, mobile, role, password_hash, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, 1, ?)
      `).run(userId, accountId, propertyId, owner_name, email || null, mobileTrim, hash, now);
    })();
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Email or mobile already registered' });
    }
    console.error('[AUTH] register tx failed:', err.message);
    return res.status(500).json({ error: 'Registration failed — please try again' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  return res.status(201).json({ token: makeToken(user), user: publicUser(user) });
}

/** POST /api/v1/auth/forgot-password */
async function forgotPassword(req, res) {
  // Always returns 200 — prevents mobile enumeration
  const mobileTrim = str((req.body || {}).mobile).replace(/\D/g, '');
  if (!/^\d{10,13}$/.test(mobileTrim)) return res.json({ ok: true });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND is_active = 1').get(mobileTrim);

  if (!user) {
    return res.json({ ok: true });
  }

  // Generate 6-digit OTP (crypto-random)
  const otp     = String(crypto.randomInt(100000, 1000000));
  const otpHash = bcrypt.hashSync(otp, 10); // fewer rounds — OTP is short-lived
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const id = uuidv4();

  // Invalidate old OTPs for this mobile
  db.prepare("DELETE FROM otp_store WHERE mobile = ?").run(mobileTrim);
  db.prepare(`
    INSERT INTO otp_store (id, mobile, otp_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, mobileTrim, otpHash, expiresAt);

  // SMS when MSG91 is set up (non-blocking)
  sms.sendLoginCode(mobileTrim.slice(-10), otp).catch(() => {});
  // Send via WhatsApp (non-blocking)
  scheduleWhatsApp({
    propertyId:     user.property_id || null,
    residentId:     null,
    recipientMobile: mobileTrim,
    recipientType:  'user',
    eventType:      'otp_password_reset',
    templateData:   { name: user.name, otp },
  }).catch(err => console.error('[AUTH] forgot-password WhatsApp failed:', err.message));

  return res.json({ ok: true });
}

/** POST /api/v1/auth/reset-password */
function resetPassword(req, res) {
  const b = req.body || {};
  const mobile = str(b.mobile), otp = str(b.otp), new_password = str(b.new_password);
  if (!mobile || !otp || !new_password) {
    return res.status(400).json({ error: 'mobile, otp, and new_password are required' });
  }
  if (new_password.length < 8 || new_password.length > 200) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const mobileTrim = mobile.replace(/\D/g, '');
  const db = getDb();

  const record = db.prepare(
    'SELECT * FROM otp_store WHERE mobile = ? AND julianday(expires_at) > julianday(\'now\')'
  ).get(mobileTrim);

  if (!record || (record.attempts || 0) >= OTP_MAX_TRIES) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }
  if (!bcrypt.compareSync(otp, record.otp_hash)) {
    // 5 wrong guesses and this OTP is dead — stops guessing all 1,000,000 codes.
    db.prepare('UPDATE otp_store SET attempts = attempts + 1 WHERE id = ?').run(record.id);
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // OTP valid — update password, end old sessions, clear OTP and any lock
  const hash = bcrypt.hashSync(new_password, BCRYPT_ROUNDS);
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, failed_logins = 0, locked_until = NULL, updated_at = datetime('now') WHERE mobile = ? AND is_active = 1")
      .run(hash, now, mobileTrim);
    db.prepare('DELETE FROM otp_store WHERE mobile = ?').run(mobileTrim);
  })();

  return res.json({ ok: true, message: 'Password reset successfully' });
}

/** POST /api/v1/auth/change-password */
function changePassword(req, res) {
  const b = req.body || {};
  const current_password = str(b.current_password), new_password = str(b.new_password);
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (new_password.length < 8 || new_password.length > 200) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });   // 400, not 401: a typo must not sign you out
  }
  const now = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
  db.prepare("UPDATE users SET password_hash = ?, pwd_changed_at = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), now, req.user.id);

  // Other devices are signed out; this one gets a fresh token.
  const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  return res.json({ ok: true, message: 'Password changed successfully', token: makeToken(fresh) });
}

/** GET /api/v1/auth/me — return the currently authenticated user */
function me(req, res) {
  const db = getDb();
  const user = db.prepare(
    'SELECT * FROM users WHERE id = ?'
  ).get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: publicUser(user) });
}

module.exports = {
  login, register, forgotPassword, resetPassword, changePassword, me,
  makeToken, publicUser, accountBlock,
};
