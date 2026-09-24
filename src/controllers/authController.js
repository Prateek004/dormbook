'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { insertAdaptive } = require('../util/dbcompat');
const { scheduleWhatsApp } = require('../services/whatsappService');

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const DUMMY_HASH    = '$2a$12$eLr2FWz7m3VbmJBbCzKQWOaOEDtB7lGS6cLUvp5Kx3kH1AHdmq0W6';

// Same secret for signing and verifying (previously login signed with a dev
// fallback while the middleware rejected it in production → every request 401).
const { getJwtSecret } = require('../middleware/auth');
const { effectivePermissions } = require('../middleware/permissions');

function makeToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, property: user.property_id, account: user.account_id },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
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
    permissions: effectivePermissions(user),   // what this user may do (drives the menu)
  };
}

/** POST /api/v1/auth/login */
function login(req, res) {
  const { email, mobile, password } = req.body;
  const identifier = (email || mobile || '').toString().toLowerCase().trim();
  if (!identifier || !password) {
    return res.status(400).json({ error: 'Login credential and password are required' });
  }

  let db;
  try { db = getDb(); } catch (err) {
    console.error('[AUTH] DB not ready:', err.message);
    return res.status(503).json({ error: 'Service temporarily unavailable' });
  }

  const user = db.prepare(
    'SELECT * FROM users WHERE (email = ? OR mobile = ?) AND is_active = 1'
  ).get(identifier, identifier);

  const hashToCheck = user ? user.password_hash : DUMMY_HASH;
  const valid = bcrypt.compareSync(password, hashToCheck);

  if (!user || !valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  // Superadmin bypasses all account/plan checks
  if (user.role !== 'superadmin' && user.account_id) {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(user.account_id);
    if (account) {
      if (account.suspended_at) {
        return res.status(403).json({ error: 'Account suspended. Contact support.' });
      }
      if (account.plan === 'trial' && account.trial_ends_at < new Date().toISOString()) {
        return res.status(403).json({ error: 'Trial expired. Contact support to continue.' });
      }
    }
  }

  return res.json({ token: makeToken(user), user: publicUser(user) });
}

/** POST /api/v1/auth/register — self-serve signup */
function register(req, res) {
  const { business_name, owner_name, mobile, email, password, pg_name, city } = req.body;

  if (!business_name || !owner_name || !mobile || !password) {
    return res.status(400).json({ error: 'business_name, owner_name, mobile, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }
  const mobileTrim = mobile.toString().replace(/\D/g, '');
  if (mobileTrim.length < 10) {
    return res.status(400).json({ error: 'Invalid mobile number' });
  }

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
        id: accountId, business_name: business_name.trim(), plan: 'trial', trial_ends_at: trialEnds,
        created_at: now, owner_name: owner_name.trim(), owner_mobile: mobileTrim,
        owner_email: email ? email.toLowerCase().trim() : null,
      });

      insertAdaptive(db, 'properties', {
        id: propertyId, account_id: accountId, name: (pg_name || business_name).trim(),
        city: (city || '').trim(), owner_id: userId, created_at: now,
      });

      db.prepare(`
        INSERT INTO users (id, account_id, property_id, name, email, mobile, role, password_hash, is_active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'owner', ?, 1, ?)
      `).run(userId, accountId, propertyId,
             owner_name.trim(),
             email ? email.toLowerCase().trim() : null,
             mobileTrim,
             hash, now);
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
  const mobileTrim = (req.body.mobile || '').toString().replace(/\D/g, '');

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE mobile = ? AND is_active = 1').get(mobileTrim);

  if (!user) {
    return res.json({ ok: true });
  }

  // Generate 6-digit OTP
  const otp     = String(Math.floor(100000 + Math.random() * 900000));
  const otpHash = bcrypt.hashSync(otp, 10); // fewer rounds — OTP is short-lived
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const id = uuidv4();

  // Invalidate old OTPs for this mobile
  db.prepare("DELETE FROM otp_store WHERE mobile = ?").run(mobileTrim);
  db.prepare(`
    INSERT INTO otp_store (id, mobile, otp_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(id, mobileTrim, otpHash, expiresAt);

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
  const { mobile, otp, new_password } = req.body;
  if (!mobile || !otp || !new_password) {
    return res.status(400).json({ error: 'mobile, otp, and new_password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const mobileTrim = mobile.toString().replace(/\D/g, '');
  const db = getDb();

  const record = db.prepare(
    'SELECT * FROM otp_store WHERE mobile = ? AND julianday(expires_at) > julianday(\'now\')'
  ).get(mobileTrim);

  if (!record || !bcrypt.compareSync(otp.toString(), record.otp_hash)) {
    return res.status(400).json({ error: 'Invalid or expired OTP' });
  }

  // OTP valid — update password and clear OTP
  const hash = bcrypt.hashSync(new_password, BCRYPT_ROUNDS);
  db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE mobile = ? AND is_active = 1")
      .run(hash, mobileTrim);
    db.prepare('DELETE FROM otp_store WHERE mobile = ?').run(mobileTrim);
  })();

  return res.json({ ok: true, message: 'Password reset successfully' });
}

/** POST /api/v1/auth/change-password */
function changePassword(req, res) {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Both current and new password are required' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }
  const db   = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(new_password, BCRYPT_ROUNDS), req.user.id);

  return res.json({ ok: true, message: 'Password changed successfully' });
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
};
