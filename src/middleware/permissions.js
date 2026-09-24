'use strict';
/**
 * Per-user permissions.
 *
 * Every staff user has a role (manager / reception) that gives a default set of
 * permissions. The owner can override that set per user (users.permissions =
 * JSON array). Owner and superadmin always have everything.
 */
const { getDb } = require('../db/connection');

const PERMISSIONS = {
  checkin:         'Check in residents',
  checkout:        'Check out residents',
  payments:        'Record payments',
  addons:          'Add-on charges',
  bookings:        'Bookings / bed hold',
  cash_close:      'Cash close',
  expenses:        'Expenses',
  reports_daily:   'Daily reports (occupancy, movements, cash book)',
  reports_finance: 'Financial reports (dues, P&L, collections)',
  discounts:       'Give discounts',
  approvals:       'Approve refunds',
  residents_edit:  'Extend stay / change rent',
  view_id_docs:    'View ID documents',
  beds_setup:      'Set up floors, bunkers, beds & rates',
  staff:           'Manage users & permissions',
  settings:        'Property settings',
  audit:           'Audit log',
};
const ALL = Object.keys(PERMISSIONS);

const ROLE_DEFAULTS = {
  reception: ['checkin', 'checkout', 'payments', 'addons', 'bookings', 'cash_close', 'reports_daily'],
  manager: ['checkin', 'checkout', 'payments', 'addons', 'bookings', 'cash_close', 'reports_daily',
    'reports_finance', 'expenses', 'discounts', 'approvals', 'residents_edit', 'view_id_docs', 'beds_setup'],
  owner: ALL,
  superadmin: ALL,
};

/** Clean a list from the client: known keys only, no duplicates. */
function sanitizePermissions(list) {
  if (!Array.isArray(list)) return null;
  return [...new Set(list.filter((p) => typeof p === 'string' && PERMISSIONS[p]))];
}

function effectivePermissions(user) {
  if (!user) return [];
  if (user.role === 'owner' || user.role === 'superadmin') return ALL.slice();
  if (user.permissions) {
    try {
      const parsed = sanitizePermissions(JSON.parse(user.permissions));
      if (parsed) return parsed;
    } catch (_) { /* fall back to role defaults */ }
  }
  return (ROLE_DEFAULTS[user.role] || []).slice();
}

let _hasCol = null;
function loadUserPermissions(userId) {
  const db = getDb();
  if (_hasCol === null) {
    _hasCol = db.prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = 'permissions'").get() != null;
  }
  if (!_hasCol) return null;
  const r = db.prepare('SELECT permissions FROM users WHERE id = ?').get(userId);
  return r ? r.permissions : null;
}

/** Route guard: the signed-in user must have ANY of the given permissions. */
function can(...perms) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (req.user.permissions === undefined) {
      req.user.permissions = effectivePermissions({ ...req.user, permissions: loadUserPermissions(req.user.id) });
    }
    if (perms.some((p) => req.user.permissions.includes(p))) return next();
    return res.status(403).json({
      error: `You don't have permission for this (${perms.map((p) => PERMISSIONS[p] || p).join(' / ')}). Ask the owner to give you access.`,
      code: 'NO_PERMISSION',
    });
  };
}

function hasPermission(req, perm) {
  if (!req.user) return false;
  if (req.user.permissions === undefined) {
    req.user.permissions = effectivePermissions({ ...req.user, permissions: loadUserPermissions(req.user.id) });
  }
  return req.user.permissions.includes(perm);
}

module.exports = { PERMISSIONS, ALL, ROLE_DEFAULTS, can, hasPermission, effectivePermissions, sanitizePermissions };
