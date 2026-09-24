'use strict';

const jwt    = require('jsonwebtoken');
const { getDb } = require('../db/connection');

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.startsWith('CHANGE_ME')) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET is not configured');
    }
    return 'change_this_secret_dev_only_32chars!';
  }
  return s;
}

// Rank: superadmin > owner > manager > reception
const ROLE_RANK = { superadmin: 4, owner: 3, manager: 2, reception: 1 };

function authenticate(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, getJwtSecret());
    const db   = getDb();
    const user = db.prepare(
      'SELECT id, account_id, property_id, name, role, is_active FROM users WHERE id = ?'
    ).get(payload.sub);

    if (!user || !user.is_active) {
      return res.status(401).json({ error: 'User not found or deactivated' });
    }

    // Superadmin bypasses all account/plan enforcement
    if (user.role !== 'superadmin' && user.account_id) {
      const account = db.prepare('SELECT plan, trial_ends_at, suspended_at FROM accounts WHERE id = ?').get(user.account_id);
      if (account) {
        if (account.suspended_at) {
          return res.status(403).json({ error: 'Account suspended. Contact support.' });
        }
        if (account.plan === 'trial' && account.trial_ends_at < new Date().toISOString()) {
          return res.status(403).json({ error: 'Trial expired. Contact support to continue.' });
        }
      }
    }

    req.user = {
      id:          user.id,
      account_id:  user.account_id,
      property_id: user.property_id,
      name:        user.name,
      role:        user.role,
    };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    // Superadmin passes every role check
    if (req.user.role === 'superadmin') return next();
    const userRank = ROLE_RANK[req.user.role] || 0;
    const minRank  = ROLE_RANK[minRole]  || 99;
    if (userRank < minRank) {
      return res.status(403).json({ error: `Access denied. Requires: ${minRole} or above` });
    }
    next();
  };
}

function requireSuperAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
  if (req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Super-admin access required' });
  }
  next();
}

function sameProperty(req, res, next) {
  // Superadmin has no property — skip this check
  if (req.user.role === 'superadmin') return next();

  const resourcePropertyId =
    req.params.propertyId || req.body?.property_id || req.query?.property_id;
  if (resourcePropertyId && resourcePropertyId !== req.user.property_id) {
    return res.status(403).json({ error: 'Cross-property access denied' });
  }
  req.property_id = req.user.property_id;
  next();
}

function assertOwnsResource(table, paramName = 'id') {
  const ALLOWED = new Set([
    'residents','payment_ledger','beds','users','expenses',
    'audit_log','booking_requests','addon_charges','receipts',
    'refund_deductions','cash_reconciliations','tenant_feedback',
  ]);
  if (!ALLOWED.has(table)) throw new Error(`assertOwnsResource: unknown table '${table}'`);
  return (req, res, next) => {
    // Superadmin bypasses ownership checks
    if (req.user.role === 'superadmin') return next();
    const db  = getDb();
    const row = db.prepare(`SELECT property_id FROM ${table} WHERE id = ?`).get(req.params[paramName]);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.property_id !== req.user.property_id) return res.status(403).json({ error: 'Access denied' });
    next();
  };
}

function stripFinancial(user, data) {
  if (!user || user.role !== 'reception') return data;
  const HIDDEN = ['total_income','total_expenses','net_profit','today_collection',
    'pending_amount','revenue','expenses','net','monthly_revenue',
    'monthly_expenses','net_income','collection','income'];
  function sanitize(obj) {
    if (Array.isArray(obj)) return obj.map(sanitize);
    if (obj && typeof obj === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        out[k] = HIDDEN.includes(k) ? '[restricted]' : sanitize(v);
      }
      return out;
    }
    return obj;
  }
  return sanitize(data);
}

module.exports = {
  authenticate, requireRole, requireSuperAdmin,
  sameProperty, assertOwnsResource, stripFinancial, ROLE_RANK, getJwtSecret,
};
