'use strict';

const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_DIR  = process.env.DB_DIR  || '/data';
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'dormbook.db');

function initDb() {
  try {
    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
  } catch (err) {
    const fallback = path.join(__dirname, '..', '..', 'data');
    console.warn(`[DB] Cannot write to ${DB_DIR} (${err.message}), falling back to ${fallback}`);
    if (!fs.existsSync(fallback)) fs.mkdirSync(fallback, { recursive: true });
    return openDb(path.join(fallback, 'dormbook.db'));
  }
  return openDb(DB_PATH);
}

function openDb(dbPath) {
  console.log(`[DB] Opening database at: ${dbPath}`);
  const db     = new Database(dbPath);
  // Safety copy of existing data BEFORE any schema change or migration.
  require('./backup').backupDb(db, dbPath, 'boot');
  module.exports.dbPath = dbPath;
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  runMigrations(db);
  return db;
}

function runMigrations(db) {
  function getColumns(table) {
    try {
      return db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all().map(c => c.name);
    } catch (e) {
      return [];
    }
  }

  const bedCols = getColumns('beds');
  if (!bedCols.includes('base_rate_paise')) {
    db.exec("ALTER TABLE beds ADD COLUMN base_rate_paise INTEGER NOT NULL DEFAULT 0");
    console.log('[MIGRATION] Added beds.base_rate_paise');
  }
  if (!bedCols.includes('daily_rate_paise')) {
    db.exec("ALTER TABLE beds ADD COLUMN daily_rate_paise INTEGER NOT NULL DEFAULT 0");
    console.log('[MIGRATION] Added beds.daily_rate_paise');
  }

  const resCols = getColumns('residents');
  if (!resCols.includes('rate_type')) {
    db.exec("ALTER TABLE residents ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'monthly'");
    console.log('[MIGRATION] Added residents.rate_type');
  }
  if (!resCols.includes('rate_paise')) {
    db.exec("ALTER TABLE residents ADD COLUMN rate_paise INTEGER NOT NULL DEFAULT 0");
    db.exec("UPDATE residents SET rate_paise = monthly_rent_paise WHERE rate_paise = 0 AND monthly_rent_paise > 0");
    console.log('[MIGRATION] Added residents.rate_paise (backfilled from monthly_rent_paise)');
  }

  db.exec("UPDATE beds SET daily_rate_paise = base_rate_paise WHERE daily_rate_paise = 0 AND base_rate_paise > 0");

  const propCols = getColumns('properties');
  if (!propCols.includes('account_id')) {
    db.exec("ALTER TABLE properties ADD COLUMN account_id TEXT REFERENCES accounts(id)");
    console.log('[MIGRATION] Added properties.account_id');
  }

  const userCols = getColumns('users');
  if (!userCols.includes('account_id')) {
    try {
      db.exec("ALTER TABLE users ADD COLUMN account_id TEXT");
      console.log('[MIGRATION] Added users.account_id');
    } catch(e) { /* already exists */ }
  }

  // Older databases named this column suspend_reason; adminController uses
  // suspension_reason. Add it (and carry old values over) so suspend/activate
  // can't crash with "no such column".
  const accCols = getColumns('accounts');
  if (accCols.length && !accCols.includes('suspension_reason')) {
    db.exec("ALTER TABLE accounts ADD COLUMN suspension_reason TEXT");
    if (accCols.includes('suspend_reason')) {
      db.exec("UPDATE accounts SET suspension_reason = suspend_reason WHERE suspension_reason IS NULL");
    }
    console.log('[MIGRATION] Added accounts.suspension_reason');
  }

  // Per-user permissions (JSON array; NULL = role defaults)
  if (!getColumns('users').includes('permissions')) {
    db.exec('ALTER TABLE users ADD COLUMN permissions TEXT');
    console.log('[MIGRATION] Added users.permissions');
  }
  // Any government ID (not only Aadhaar)
  const resCols2 = getColumns('residents');
  for (const [col, type] of [['id_type', 'TEXT'], ['id_number_encrypted', 'TEXT'], ['id_last4', 'TEXT']]) {
    if (!resCols2.includes(col)) {
      db.exec(`ALTER TABLE residents ADD COLUMN ${col} ${type}`);
      console.log(`[MIGRATION] Added residents.${col}`);
    }
  }
  // Existing Aadhaar-only residents become id_type = 'aadhaar'
  db.exec(`UPDATE residents SET id_type = 'aadhaar', id_number_encrypted = aadhaar_number_encrypted, id_last4 = aadhaar_last4
           WHERE id_type IS NULL AND aadhaar_number_encrypted IS NOT NULL`);
  // Letterhead details for reports
  const propCols2 = getColumns('properties');
  for (const col of ['contact_phone', 'contact_email', 'gstin']) {
    if (!propCols2.includes(col)) {
      db.exec(`ALTER TABLE properties ADD COLUMN ${col} TEXT`);
      console.log(`[MIGRATION] Added properties.${col}`);
    }
  }

  // GST (off by default). Rates are basis points: 500 = 5%.
  const gstCols = {
    properties:    [['gst_enabled', 'INTEGER NOT NULL DEFAULT 0'], ['rent_gst_rate_bp', 'INTEGER NOT NULL DEFAULT 0'], ['rent_gst_inclusive', 'INTEGER NOT NULL DEFAULT 1']],
    residents:     [['gst_rate_bp', 'INTEGER NOT NULL DEFAULT 0'], ['gst_inclusive', 'INTEGER NOT NULL DEFAULT 1']],
    addon_catalog: [['gst_rate_bp', 'INTEGER NOT NULL DEFAULT 0'], ['gst_inclusive', 'INTEGER NOT NULL DEFAULT 1']],
    addon_charges: [['taxable_paise', 'INTEGER'], ['gst_paise', 'INTEGER'], ['gst_rate_bp', 'INTEGER']],
    // Removed floors / bunkers / beds that have past guests are hidden, not deleted (history stays correct).
    beds:   [['removed_at', 'TEXT']],
    rooms:  [['removed_at', 'TEXT']],
    floors: [['removed_at', 'TEXT']],
  };
  for (const [table, list] of Object.entries(gstCols)) {
    const have = getColumns(table);
    if (!have.length) continue;
    for (const [col, type] of list) {
      if (!have.includes(col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        console.log(`[MIGRATION] Added ${table}.${col}`);
      }
    }
  }

  // Staff sign-in with mobile + MPIN, login lockout, sessions ended on password change,
  // owner's bank / UPI details for bills. All additive: existing rows keep working as before.
  const accessCols = {
    users: [['mpin_hash', 'TEXT'], ['mpin_set_at', 'TEXT'], ['pwd_changed_at', 'TEXT'],
      ['failed_logins', 'INTEGER NOT NULL DEFAULT 0'], ['locked_until', 'TEXT']],
    otp_store: [['attempts', 'INTEGER NOT NULL DEFAULT 0']],
    properties: [['upi_id', 'TEXT'], ['upi_name', 'TEXT'], ['upi_uri', 'TEXT'], ['bank_holder', 'TEXT'], ['bank_name', 'TEXT'],
      ['bank_account_enc', 'TEXT'], ['bank_account_last4', 'TEXT'], ['bank_ifsc', 'TEXT'], ['bank_branch', 'TEXT'],
      ['show_pay_on_bill', 'INTEGER NOT NULL DEFAULT 1']],
  };
  for (const [table, list] of Object.entries(accessCols)) {
    const have = getColumns(table);
    if (!have.length) continue;
    for (const [col, type] of list) {
      if (!have.includes(col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
        console.log(`[MIGRATION] Added ${table}.${col}`);
      }
    }
  }
  // One-time login codes (6 digits, stored hashed). No FKs: a code row can never block anything.
  db.exec(`CREATE TABLE IF NOT EXISTS login_codes (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, code_hash TEXT NOT NULL, purpose TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, expires_at TEXT NOT NULL, used_at TEXT, created_by TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_login_codes_user ON login_codes(user_id, created_at)');
  // Private bill links sent to guests on WhatsApp (only a hash of the link is stored).
  db.exec(`CREATE TABLE IF NOT EXISTS bill_links (
    id TEXT PRIMARY KEY, property_id TEXT NOT NULL, resident_id TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    created_by TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL,
    revoked_at TEXT, views INTEGER NOT NULL DEFAULT 0, last_viewed_at TEXT)`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_bill_links_resident ON bill_links(resident_id)');

  // Ledger + reports (additive, idempotent). Loaded lazily so a problem in the
  // ledger can never stop the rest of the app from booting.
  try {
    require('../services/ledger').setupLedger(db);
  } catch (e) {
    console.error('[MIGRATION] Ledger setup failed — money reports disabled until fixed:', e.stack || e.message);
  }

  console.log('[DB] Migrations complete');
}

module.exports = { initDb, DB_PATH };
