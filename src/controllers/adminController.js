'use strict';

const { getDb } = require('../db/connection');

function adminStats(req, res) {
  const db = getDb();
  const now = new Date().toISOString();

  const total     = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n;
  const trial     = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='trial' AND suspended_at IS NULL AND trial_ends_at > ?").get(now).n;
  const active    = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='active' AND suspended_at IS NULL").get().n;
  const suspended = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE suspended_at IS NOT NULL').get().n;
  const expired   = db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE plan='trial' AND trial_ends_at <= ? AND suspended_at IS NULL").get(now).n;
  const residents = db.prepare("SELECT COUNT(*) AS n FROM residents WHERE status='active'").get().n;

  res.json({ total, trial, active, suspended, expired, residents });
}

function listAccounts(req, res) {
  const db = getDb();
  const accounts = db.prepare(`
    SELECT a.id, a.business_name, a.plan, a.trial_ends_at, a.suspended_at, a.suspension_reason,
           a.created_at,
           COUNT(DISTINCT p.id)  AS properties,
           COUNT(DISTINCT r.id)  AS residents,
           COUNT(DISTINCT u.id)  AS users,
           (SELECT o.name FROM users o WHERE o.account_id = a.id AND o.role = 'owner' ORDER BY o.created_at LIMIT 1) AS owner_name,
           (SELECT o.mobile FROM users o WHERE o.account_id = a.id AND o.role = 'owner' ORDER BY o.created_at LIMIT 1) AS owner_mobile
    FROM accounts a
    LEFT JOIN properties p ON p.account_id = a.id
    LEFT JOIN residents  r ON r.property_id = p.id AND r.status = 'active'
    LEFT JOIN users      u ON u.account_id  = a.id AND u.is_active = 1
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `).all();
  res.json(accounts);
}

function getAccount(req, res) {
  const db = getDb();
  const account = db.prepare(`
    SELECT a.*, COUNT(DISTINCT p.id) AS properties
    FROM accounts a
    LEFT JOIN properties p ON p.account_id = a.id
    WHERE a.id = ?
    GROUP BY a.id
  `).get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  res.json(account);
}

function suspendAccount(req, res) {
  const db = getDb();
  const { reason } = req.body;
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`
    UPDATE accounts SET suspended_at = datetime('now'), suspension_reason = ? WHERE id = ?
  `).run(reason || null, req.params.id);

  res.json({ ok: true });
}

function activateAccount(req, res) {
  const db = getDb();
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found' });

  db.prepare(`
    UPDATE accounts
    SET plan = 'trial',
        trial_ends_at = datetime('now', '+30 days'),
        suspended_at = NULL,
        suspension_reason = NULL
    WHERE id = ?
  `).run(req.params.id);

  res.json({ ok: true });
}

/**
 * POST /api/v1/admin/accounts/:id/reset-password  { new_password }
 * Superadmin resets the owner's password (there is no self-service reset
 * while WhatsApp OTP is switched off).
 */
function resetOwnerPassword(req, res) {
  const bcrypt = require('bcryptjs');
  const db = getDb();
  const pwd = req.body.new_password == null ? '' : String(req.body.new_password);
  if (pwd.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  const owner = db.prepare("SELECT id, name FROM users WHERE account_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(req.params.id);
  if (!owner) return res.status(404).json({ error: 'Owner not found for this account' });
  db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(bcrypt.hashSync(pwd, parseInt(process.env.BCRYPT_ROUNDS || '12', 10)), owner.id);
  res.json({ ok: true, message: `Password reset for ${owner.name}` });
}

module.exports = { adminStats, listAccounts, getAccount, suspendAccount, activateAccount, resetOwnerPassword };
