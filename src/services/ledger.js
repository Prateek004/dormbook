'use strict';
/**
 * DormBook Ledger — the single source of truth for money.
 *
 * Every rupee is one row in `ledger_entries`: rent charged, payment received,
 * deposit held/refunded, discount, expense. Dues, deposits held, cash in the
 * drawer, income and every report are SUMs over this table.
 *
 * Guarantees (enforced by the DATABASE, not just this file):
 *   - money is integer paise; originals > 0, reversals < 0
 *   - rows are never UPDATEd or DELETEd  → mistakes are fixed by a reversal row
 *   - nothing can be posted into a day that has been cash-closed
 *   - a row can be reversed at most once, and only by its exact negative
 *   - same idem_key twice = same row (double-click / retry safe)
 *
 * payment_ledger / expenses stay as they are (receipts, approvals, UI lists use
 * them). Every write to them ALSO posts here in the same DB transaction, so the
 * two can never disagree; integrityCheck() proves it.
 */
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/connection');
const { istDate, isValidDate, addDays, daysBetween } = require('../util/time');

class LedgerError extends Error {
  constructor(code, message, status = 400) {
    super(message || code);
    this.code = code;
    this.status = status;
    this.isLedgerError = true;
  }
}

const MODES = ['cash', 'upi', 'card', 'bank_transfer'];
const KINDS = ['CHARGE', 'PAYMENT', 'WAIVER', 'DEPOSIT_IN', 'DEPOSIT_APPLY', 'DEPOSIT_REFUND', 'EXPENSE',
  'BANK_DEPOSIT', 'OPENING_DUES', 'OPENING_DEPOSIT', 'CREDIT_REFUND'];
const PLANS = ['daily', 'weekly', 'monthly'];

// Signed sums — reversals are negative rows, so they net out automatically.
const SQL = {
  // CREDIT_REFUND = advance rent paid back to the resident (their credit goes down)
  dues: `COALESCE(SUM(CASE WHEN kind IN ('CHARGE','OPENING_DUES','CREDIT_REFUND') THEN amount_paise
                           WHEN kind IN ('PAYMENT','WAIVER','DEPOSIT_APPLY') THEN -amount_paise
                           ELSE 0 END),0)`,
  deposit: `COALESCE(SUM(CASE WHEN kind IN ('DEPOSIT_IN','OPENING_DEPOSIT') THEN amount_paise
                              WHEN kind IN ('DEPOSIT_APPLY','DEPOSIT_REFUND') THEN -amount_paise
                              ELSE 0 END),0)`,
  cashIn: `COALESCE(SUM(CASE WHEN kind IN ('PAYMENT','DEPOSIT_IN') AND mode='cash' THEN amount_paise ELSE 0 END),0)`,
  cashOut: `COALESCE(SUM(CASE WHEN kind IN ('EXPENSE','DEPOSIT_REFUND','CREDIT_REFUND') AND mode='cash' THEN amount_paise
                              WHEN kind = 'BANK_DEPOSIT' THEN amount_paise ELSE 0 END),0)`,
  // rows that are not reversed and are not reversals
  live: `reversal_of IS NULL AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of = ledger_entries.id)`,
};

// ─────────────────────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────────────────────
const SCHEMA = `
CREATE TABLE IF NOT EXISTS ledger_entries (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL,
  resident_id   TEXT,
  biz_date      TEXT NOT NULL CHECK (biz_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  ref_date      TEXT NOT NULL CHECK (ref_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  created_at    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('CHARGE','PAYMENT','WAIVER','DEPOSIT_IN','DEPOSIT_APPLY',
                  'DEPOSIT_REFUND','EXPENSE','BANK_DEPOSIT','OPENING_DUES','OPENING_DEPOSIT','CREDIT_REFUND')),
  category      TEXT,
  mode          TEXT CHECK (mode IS NULL OR mode IN ('cash','upi','card','bank_transfer')),
  amount_paise  INTEGER NOT NULL CHECK (typeof(amount_paise) = 'integer' AND amount_paise <> 0),
  period_start  TEXT,
  period_end    TEXT,
  plan          TEXT,
  rate_paise    INTEGER,
  reversal_of   TEXT UNIQUE REFERENCES ledger_entries(id),
  idem_key      TEXT UNIQUE,
  source_table  TEXT,
  source_id     TEXT,
  origin        TEXT NOT NULL DEFAULT 'app' CHECK (origin IN ('app','billing','migration')),
  reason        TEXT,
  user_id       TEXT,
  CHECK ((reversal_of IS NULL AND amount_paise > 0) OR (reversal_of IS NOT NULL AND amount_paise < 0)),
  CHECK (kind NOT IN ('PAYMENT','DEPOSIT_IN','DEPOSIT_REFUND','EXPENSE','CREDIT_REFUND') OR mode IS NOT NULL),
  CHECK (kind IN ('EXPENSE','BANK_DEPOSIT') OR resident_id IS NOT NULL),
  CHECK (kind NOT IN ('EXPENSE','BANK_DEPOSIT') OR resident_id IS NULL),
  CHECK (kind NOT IN ('WAIVER','DEPOSIT_APPLY') OR length(trim(coalesce(reason,''))) > 0),
  CHECK (reversal_of IS NULL OR length(trim(coalesce(reason,''))) > 0)
);
CREATE INDEX IF NOT EXISTS ix_le_prop_date   ON ledger_entries(property_id, biz_date);
CREATE INDEX IF NOT EXISTS ix_le_resident    ON ledger_entries(resident_id, kind);
CREATE INDEX IF NOT EXISTS ix_le_source      ON ledger_entries(source_table, source_id);
CREATE INDEX IF NOT EXISTS ix_le_prop_ref    ON ledger_entries(property_id, ref_date);

CREATE TABLE IF NOT EXISTS day_closes (
  property_id         TEXT NOT NULL,
  biz_date            TEXT NOT NULL,
  from_date           TEXT NOT NULL,
  opening_cash_paise  INTEGER NOT NULL,
  cash_in_paise       INTEGER NOT NULL,
  cash_out_paise      INTEGER NOT NULL,
  expected_cash_paise INTEGER NOT NULL,
  counted_cash_paise  INTEGER NOT NULL CHECK (counted_cash_paise >= 0),
  variance_paise      INTEGER NOT NULL,
  reconciliation_id   TEXT,
  closed_by           TEXT,
  closed_at           TEXT NOT NULL,
  PRIMARY KEY (property_id, biz_date),
  CHECK (expected_cash_paise = opening_cash_paise + cash_in_paise - cash_out_paise),
  CHECK (variance_paise = counted_cash_paise - expected_cash_paise)
);

CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);

CREATE TRIGGER IF NOT EXISTS trg_le_no_update BEFORE UPDATE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_le_no_delete BEFORE DELETE ON ledger_entries
BEGIN SELECT RAISE(ABORT, 'LEDGER_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_le_day_closed BEFORE INSERT ON ledger_entries
WHEN EXISTS (SELECT 1 FROM day_closes d WHERE d.property_id = NEW.property_id AND d.biz_date >= NEW.biz_date)
BEGIN SELECT RAISE(ABORT, 'DAY_CLOSED'); END;
CREATE TRIGGER IF NOT EXISTS trg_le_reversal_valid BEFORE INSERT ON ledger_entries
WHEN NEW.reversal_of IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM ledger_entries o WHERE o.id = NEW.reversal_of AND o.reversal_of IS NULL
    AND o.amount_paise = -NEW.amount_paise AND o.kind = NEW.kind AND o.property_id = NEW.property_id
    AND o.resident_id IS NEW.resident_id AND o.mode IS NEW.mode)
BEGIN SELECT RAISE(ABORT, 'BAD_REVERSAL'); END;
CREATE TRIGGER IF NOT EXISTS trg_dc_no_update BEFORE UPDATE ON day_closes
BEGIN SELECT RAISE(ABORT, 'DAY_CLOSE_IMMUTABLE'); END;
CREATE TRIGGER IF NOT EXISTS trg_dc_no_delete BEFORE DELETE ON day_closes
BEGIN SELECT RAISE(ABORT, 'DAY_CLOSE_IMMUTABLE'); END;
`;

const PROTECTION_TRIGGERS = ['trg_le_no_update', 'trg_le_no_delete', 'trg_le_day_closed', 'trg_le_reversal_valid',
  'trg_dc_no_update', 'trg_dc_no_delete'];

// ─────────────────────────────────────────────────────────────────────────────
// Rent proration — the ONE place rent for a period is calculated
// ─────────────────────────────────────────────────────────────────────────────
function daysInMonth(y, m0) { return new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate(); }

/** Add n months keeping the anchor day, clamped to month end (Jan 31 → Feb 28 → Mar 31). */
function addMonthsAnchored(anchor, n) {
  const [y, m, d] = anchor.split('-').map(Number);
  const total = (m - 1) + n;
  const ty = y + Math.floor(total / 12);
  const tm0 = ((total % 12) + 12) % 12;
  const day = Math.min(d, daysInMonth(ty, tm0));
  return `${ty}-${String(tm0 + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** First cycle boundary strictly after `from`, for a resident anchored on `anchor` (check-in date). */
function nextCycleStart(plan, from, anchor) {
  if (plan === 'daily') return addDays(from, 1);
  if (plan === 'weekly') {
    const off = ((daysBetween(anchor, from) % 7) + 7) % 7;
    return addDays(from, 7 - off);
  }
  let n = 0;
  while (addMonthsAnchored(anchor, n) <= from) n++;
  return addMonthsAnchored(anchor, n);
}

/**
 * Rent for [start, end) (end EXCLUSIVE — the checkout / next-cycle date).
 *  daily  : days × rate
 *  weekly : full weeks × rate + leftover days × rate/7
 *  monthly: full anniversary months × rate + leftover days × rate/(days in that cycle)
 * Rounded once, to the nearest paisa.
 */
function prorate({ plan, ratePaise, start, end, anchor = start }) {
  if (!PLANS.includes(plan)) throw new LedgerError('BAD_PLAN', `rate type must be one of ${PLANS.join(', ')}`);
  if (!Number.isSafeInteger(ratePaise) || ratePaise <= 0) throw new LedgerError('BAD_AMOUNT', 'rate must be a positive amount');
  if (!isValidDate(start) || !isValidDate(end)) throw new LedgerError('BAD_DATE', 'invalid period dates');
  const days = daysBetween(start, end);
  if (days <= 0) throw new LedgerError('BAD_PERIOD', 'period end must be after start');
  if (plan === 'daily') return days * ratePaise;
  if (plan === 'weekly') return Math.floor(days / 7) * ratePaise + Math.round(((days % 7) * ratePaise) / 7);
  // monthly — walk the anchor's anniversary cycles; a full cycle = exactly one month's rent,
  // a part cycle = days used / days in THAT cycle (so Feb and Mar are both fair).
  let fullCycles = 0;
  let partial = 0; // fractional paise, rounded once at the end
  let cur = start;
  for (let guard = 0; cur < end && guard < 500; guard++) {
    let n = 0;
    while (addMonthsAnchored(anchor, n + 1) <= cur) n++;
    while (addMonthsAnchored(anchor, n) > cur) n--;
    const cycleStart = addMonthsAnchored(anchor, n);
    const cycleEnd = addMonthsAnchored(anchor, n + 1);
    const segEnd = end < cycleEnd ? end : cycleEnd;
    if (cur === cycleStart && segEnd === cycleEnd) fullCycles++;
    else partial += (daysBetween(cur, segEnd) * ratePaise) / daysBetween(cycleStart, cycleEnd);
    cur = segEnd;
  }
  return fullCycles * ratePaise + Math.round(partial);
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup + one-time migration of existing data
// ─────────────────────────────────────────────────────────────────────────────
/**
 * v2: adds the CREDIT_REFUND kind. SQLite can't change a CHECK constraint, so a
 * ledger created by v1 is rebuilt once: copy every row into a new table with the
 * new rule, swap the tables, recreate indexes/triggers. All in one transaction;
 * row count is verified before commit.
 */
function upgradeLedgerTable(db) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='ledger_entries'").get();
  if (!row || row.sql.includes('CREDIT_REFUND')) return;
  const createSql = SCHEMA.slice(SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ledger_entries'), SCHEMA.indexOf(');', SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS ledger_entries')) + 2)
    .replace('CREATE TABLE IF NOT EXISTS ledger_entries', 'CREATE TABLE ledger_entries_v2');
  const fk = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      const before = db.prepare('SELECT COUNT(*) n FROM ledger_entries').get().n;
      db.exec(createSql);
      db.exec(`INSERT INTO ledger_entries_v2 (${COLS.join(',')}) SELECT ${COLS.join(',')} FROM ledger_entries ORDER BY rowid`);
      const after = db.prepare('SELECT COUNT(*) n FROM ledger_entries_v2').get().n;
      if (after !== before) throw new Error(`ledger upgrade copied ${after} of ${before} rows`);
      db.exec('DROP TABLE ledger_entries');
      db.exec('ALTER TABLE ledger_entries_v2 RENAME TO ledger_entries');
      db.exec(SCHEMA); // indexes + triggers (IF NOT EXISTS)
      console.log(`[LEDGER] Upgraded ledger table (v2), ${after} rows kept`);
    })();
  } finally {
    db.pragma(`foreign_keys = ${fk ? 'ON' : 'OFF'}`);
  }
}

function setupLedger(db = getDb()) {
  db.exec(SCHEMA);
  upgradeLedgerTable(db);
  try {
    backfillOnce(db);
  } catch (e) {
    // Never block boot. The integrity endpoint will show that backfill is missing.
    console.error('[LEDGER] Backfill failed (app keeps running, will retry next boot):', e.stack || e.message);
  }
}

function metaGet(db, key) {
  const r = db.prepare('SELECT value FROM ledger_meta WHERE key = ?').get(key);
  return r ? r.value : null;
}
function metaSet(db, key, value) {
  db.prepare(`INSERT INTO ledger_meta (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), new Date().toISOString());
}

function tableExists(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

/**
 * Copies history into the ledger exactly once:
 *  payment_ledger → payments / deposits / refunds / extra charges
 *  expenses       → expenses
 *  addon_charges (monthly_bill) and refund_deductions → charges
 *  residents      → rent charges from check-in to today (or checkout)
 */
function backfillOnce(db) {
  if (metaGet(db, 'backfill_v1')) return;
  const tx = db.transaction(() => {
    if (metaGet(db, 'backfill_v1')) return { skipped: true };
    const counts = { payments: 0, expenses: 0, charges: 0, rent_residents: 0 };
    const now = new Date().toISOString();
    const ins = (row) => {
      insertRow(db, { created_at: now, origin: 'migration', ...row });
    };

    if (tableExists(db, 'payment_ledger')) {
      const rows = db.prepare('SELECT * FROM payment_ledger ORDER BY created_at, rowid').all();
      const refundAt = new Map();
      rows.filter((r) => r.type === 'deposit_refund').forEach((r) => refundAt.set(`${r.resident_id}|${r.created_at}`, true));
      for (const p of rows) {
        const amount = Number(p.amount_paise);
        if (!Number.isSafeInteger(amount) || amount <= 0) continue; // skip ₹0/garbage rows
        const d = istDate(p.paid_at || p.created_at) || istDate();
        const mode = MODES.includes(p.payment_mode) ? p.payment_mode : 'cash';
        const base = { property_id: p.property_id, resident_id: p.resident_id, biz_date: d, ref_date: d,
          source_table: 'payment_ledger', source_id: p.id, user_id: p.recorded_by };
        if (p.direction === 'credit' && (p.type === 'rent' || p.type === 'advance')) {
          ins({ ...base, kind: 'PAYMENT', category: 'rent', mode, amount_paise: amount }); counts.payments++;
        } else if (p.direction === 'credit' && p.type === 'deposit') {
          ins({ ...base, kind: 'DEPOSIT_IN', mode, amount_paise: amount }); counts.payments++;
        } else if (p.direction === 'credit' && p.type === 'extra_charge') {
          // Checkout extra charges were deducted from the deposit (no money received):
          // they were written in the same transaction as the refund, or with the checkout note.
          const atCheckout = refundAt.has(`${p.resident_id}|${p.created_at}`) || p.notes === 'Extra charges at checkout';
          ins({ ...base, kind: 'CHARGE', category: atCheckout ? 'damage' : 'other', amount_paise: amount,
            reason: p.notes || 'Extra charge (migrated)' });
          if (!atCheckout) ins({ ...base, kind: 'PAYMENT', category: 'other', mode, amount_paise: amount });
          counts.charges++;
        } else if (p.direction === 'debit' && p.type === 'deposit_refund'
                   && ['approved', 'not_required'].includes(p.approval_status)) {
          const rd = istDate(p.approved_at || p.paid_at || p.created_at) || d;
          ins({ ...base, biz_date: rd, ref_date: rd, kind: 'DEPOSIT_REFUND', mode, amount_paise: amount });
          counts.payments++;
        }
      }
    }

    if (tableExists(db, 'expenses')) {
      for (const e of db.prepare('SELECT * FROM expenses ORDER BY created_at, rowid').all()) {
        const amount = Number(e.amount_paise);
        if (!Number.isSafeInteger(amount) || amount <= 0) continue;
        const d = isValidDate(e.expense_date) ? e.expense_date : istDate(e.created_at) || istDate();
        ins({ property_id: e.property_id, biz_date: d, ref_date: d, kind: 'EXPENSE',
          category: String(e.category || 'other').slice(0, 40), amount_paise: amount,
          mode: MODES.includes(e.payment_mode) ? e.payment_mode : 'cash', reason: e.description || null,
          source_table: 'expenses', source_id: e.id, user_id: e.recorded_by });
        counts.expenses++;
      }
    }

    if (tableExists(db, 'addon_charges')) {
      for (const a of db.prepare("SELECT * FROM addon_charges WHERE billing_mode = 'monthly_bill'").all()) {
        const amount = Number(a.amount_paise);
        if (!Number.isSafeInteger(amount) || amount <= 0) continue;
        const d = istDate(a.created_at) || istDate();
        ins({ property_id: a.property_id, resident_id: a.resident_id, biz_date: d, ref_date: d, kind: 'CHARGE',
          category: 'addon', amount_paise: amount, reason: `Add-on: ${a.name}`, source_table: 'addon_charges',
          source_id: a.id, user_id: a.recorded_by });
        counts.charges++;
      }
    }

    if (tableExists(db, 'refund_deductions')) {
      const q = db.prepare('SELECT property_id FROM residents WHERE id = ?');
      for (const r of db.prepare('SELECT * FROM refund_deductions').all()) {
        const res = q.get(r.resident_id);
        const amount = Number(r.amount_paise);
        if (!res || !Number.isSafeInteger(amount) || amount <= 0) continue;
        const d = istDate(r.created_at) || istDate();
        ins({ property_id: res.property_id, resident_id: r.resident_id, biz_date: d, ref_date: d, kind: 'CHARGE',
          category: 'damage', amount_paise: amount, reason: r.reason || 'Deduction', source_table: 'refund_deductions',
          source_id: r.id, user_id: r.logged_by });
        counts.charges++;
      }
    }

    // Rent: bill every stay from check-in, exactly as the live billing job will from now on.
    const residents = db.prepare('SELECT * FROM residents').all();
    for (const r of residents) {
      const until = r.status === 'checked_out' ? r.actual_checkout : null;
      const n = billResident(db, r, { asOf: istDate(), until, origin: 'migration' });
      if (n) counts.rent_residents++;
    }

    metaSet(db, 'backfill_v1', JSON.stringify({ at: now, ...counts }));
    return counts;
  });
  const res = tx.immediate();
  if (res && !res.skipped) console.log('[LEDGER] Backfill complete', res);
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level write
// ─────────────────────────────────────────────────────────────────────────────
const COLS = ['id', 'property_id', 'resident_id', 'biz_date', 'ref_date', 'created_at', 'kind', 'category', 'mode',
  'amount_paise', 'period_start', 'period_end', 'plan', 'rate_paise', 'reversal_of', 'idem_key', 'source_table',
  'source_id', 'origin', 'reason', 'user_id'];
let _insertSql = null;

function insertRow(db, row) {
  const full = {};
  for (const c of COLS) full[c] = row[c] === undefined ? null : row[c];
  full.id = full.id || uuidv4();
  full.created_at = full.created_at || new Date().toISOString();
  full.origin = full.origin || 'app';
  if (full.reason != null) full.reason = String(full.reason).trim().slice(0, 500) || null;
  if (!_insertSql) _insertSql = `INSERT INTO ledger_entries (${COLS.join(',')}) VALUES (${COLS.map((c) => '@' + c).join(',')})`;
  try {
    db.prepare(_insertSql).run(full);
  } catch (e) {
    throw mapSqliteError(e);
  }
  return full;
}

function mapSqliteError(e) {
  const msg = String((e && e.message) || e);
  if (msg.includes('DAY_CLOSED')) return new LedgerError('DAY_CLOSED', 'That day is already cash-closed. Record it with today\'s date.', 409);
  if (msg.includes('BAD_REVERSAL')) return new LedgerError('BAD_REVERSAL', 'Invalid reversal', 409);
  if (msg.includes('LEDGER_IMMUTABLE')) return new LedgerError('LEDGER_IMMUTABLE', 'Money entries cannot be edited — reverse them instead', 409);
  if (msg.includes('ledger_entries.reversal_of')) return new LedgerError('ALREADY_REVERSED', 'This entry is already reversed', 409);
  if (msg.includes('ledger_entries.idem_key')) return new LedgerError('DUPLICATE', 'Duplicate request', 409);
  if (msg.includes('CHECK constraint failed')) return new LedgerError('INVALID_ENTRY', 'Entry failed a safety check', 400);
  return e;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function lastClosedDate(db, propertyId) {
  const r = db.prepare('SELECT MAX(biz_date) d FROM day_closes WHERE property_id = ?').get(propertyId);
  return r && r.d ? r.d : null;
}

/** Business day to post on: the requested day, moved forward past any closed day. */
function openBizDate(db, propertyId, wanted) {
  let d = wanted || istDate();
  if (!isValidDate(d)) throw new LedgerError('BAD_DATE', 'Date must be YYYY-MM-DD');
  const closed = lastClosedDate(db, propertyId);
  if (closed && d <= closed) d = addDays(closed, 1);
  return d;
}

function assertPaise(v, field = 'amount') {
  if (!Number.isSafeInteger(v) || v <= 0) throw new LedgerError('BAD_AMOUNT', `${field} must be a positive whole number of paise`);
  if (v > 100000000000) throw new LedgerError('BAD_AMOUNT', `${field} is unrealistically large`);
  return v;
}

function getResident(db, propertyId, residentId) {
  const r = db.prepare('SELECT * FROM residents WHERE id = ? AND property_id = ?').get(residentId, propertyId);
  if (!r) throw new LedgerError('RESIDENT_NOT_FOUND', 'Resident not found', 404);
  return r;
}

function balances(db, residentId) {
  return db.prepare(`SELECT ${SQL.dues} AS dues_paise, ${SQL.deposit} AS deposit_paise
                     FROM ledger_entries WHERE resident_id = ?`).get(residentId);
}

function assertDepositNotNegative(db, residentId) {
  if (balances(db, residentId).deposit_paise < 0) {
    throw new LedgerError('DEPOSIT_INSUFFICIENT', 'That is more than the deposit this resident has with you', 409);
  }
}

function tx(db, fn) {
  // Joins the caller's transaction if there is one (savepoint), else opens one.
  return db.inTransaction ? db.transaction(fn)() : db.transaction(fn).immediate();
}

// ─────────────────────────────────────────────────────────────────────────────
// Rent billing
// ─────────────────────────────────────────────────────────────────────────────
function lastRentEnd(db, residentId) {
  const r = db.prepare(`SELECT MAX(period_end) e FROM ledger_entries
    WHERE resident_id = ? AND kind = 'CHARGE' AND category = 'rent' AND ${SQL.live}`).get(residentId);
  return r && r.e ? r.e : null;
}

/**
 * The date rent cycles repeat from.
 *  monthly: the resident's "rent due day" (1–28) on/after check-in — the first
 *           stretch from check-in to that day is charged pro-rata;
 *  daily/weekly: the check-in date.
 */
function billingAnchor(r, plan) {
  if (plan !== 'monthly') return r.check_in_date;
  const dueDay = Number(r.rent_due_day);
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 28) return r.check_in_date;
  const [y, m] = r.check_in_date.split('-').map(Number);
  const sameMonth = `${y}-${String(m).padStart(2, '0')}-${String(dueDay).padStart(2, '0')}`;
  return sameMonth >= r.check_in_date ? sameMonth : addMonthsAnchored(sameMonth, 1);
}

/**
 * Charge every rent cycle that has started (cycle start <= asOf) and not been charged yet.
 * Cycles are anchored on the check-in date; a cycle is cut short at expected_checkout
 * (or `until` for a finished stay). Idempotent: running it twice charges nothing new.
 * Returns the number of charges posted.
 */
function billResident(db, r, { asOf = istDate(), until = null, origin = 'billing', userId = null } = {}) {
  const plan = PLANS.includes(r.rate_type) ? r.rate_type : 'monthly';
  const rate = Number(r.rate_paise) > 0 ? Number(r.rate_paise) : Number(r.monthly_rent_paise) > 0 && plan === 'monthly' ? Number(r.monthly_rent_paise) : 0;
  if (!rate || !isValidDate(r.check_in_date)) return 0;
  const anchor = billingAnchor(r, plan);
  let cursor = lastRentEnd(db, r.id) || r.check_in_date;
  let posted = 0;
  const hardStop = until && isValidDate(until) ? (until > r.check_in_date ? until : addDays(r.check_in_date, 1)) : null;
  for (let guard = 0; guard < 2000; guard++) {
    if (cursor > asOf) break;
    if (hardStop && cursor >= hardStop) break;
    let end = nextCycleStart(plan, cursor, anchor);
    if (isValidDate(r.expected_checkout) && r.expected_checkout > cursor && r.expected_checkout < end) end = r.expected_checkout;
    if (hardStop && hardStop < end) end = hardStop;
    const amount = prorate({ plan, ratePaise: rate, start: cursor, end, anchor });
    if (amount > 0) {
      insertRow(db, {
        property_id: r.property_id, resident_id: r.id, biz_date: openBizDate(db, r.property_id, cursor), ref_date: cursor,
        kind: 'CHARGE', category: 'rent', amount_paise: amount, period_start: cursor, period_end: end, plan,
        rate_paise: rate, idem_key: `rent:${r.id}:${cursor}:${end}:${origin === 'migration' ? 'm' : 'b'}${lastReversalCount(db, r.id, cursor)}`,
        origin, user_id: userId, reason: `${plan} rent ${cursor} → ${end}`,
      });
      posted++;
    }
    cursor = end;
  }
  return posted;
}
function lastReversalCount(db, residentId, start) {
  // lets a period be re-billed after its charge was reversed (e.g. rate correction)
  return db.prepare(`SELECT COUNT(*) n FROM ledger_entries WHERE resident_id = ? AND kind='CHARGE'
    AND category='rent' AND period_start = ? AND reversal_of IS NOT NULL`).get(residentId, start).n;
}

/** Daily job: bill all active residents (optionally one property). Safe to run any number of times. */
function runBilling({ db = getDb(), propertyId = null, residentId = null, asOf = istDate() } = {}) {
  let sql = "SELECT * FROM residents WHERE status = 'active'";
  const params = [];
  if (propertyId) { sql += ' AND property_id = ?'; params.push(propertyId); }
  if (residentId) { sql += ' AND id = ?'; params.push(residentId); }
  let posted = 0, failed = 0;
  for (const r of db.prepare(sql).all(...params)) {
    try {
      posted += tx(db, () => billResident(db, r, { asOf }));
    } catch (e) {
      failed++;
      console.error(`[LEDGER] Billing failed for resident ${r.id}:`, e.message);
    }
  }
  return { posted, failed };
}

/**
 * Checkout: make rent cover exactly [check-in, checkout). Bills any unbilled cycles
 * before the checkout date, then shortens/removes cycles that run past it.
 */
function settleRentAtCheckout(db, resident, checkoutDate, userId) {
  if (!isValidDate(checkoutDate)) throw new LedgerError('BAD_DATE', 'checkout_date must be YYYY-MM-DD');
  const stayEnd = checkoutDate > resident.check_in_date ? checkoutDate : addDays(resident.check_in_date, 1); // min 1 day
  billResident(db, { ...resident, expected_checkout: stayEnd }, { asOf: addDays(stayEnd, -1), until: stayEnd, userId });
  const beyond = db.prepare(`SELECT * FROM ledger_entries WHERE resident_id = ? AND kind='CHARGE' AND category='rent'
      AND ${SQL.live} AND period_end > ? ORDER BY period_start`).all(resident.id, stayEnd);
  for (const c of beyond) {
    reverseEntry(db, c, `Checkout on ${checkoutDate}`, userId);
    if (c.period_start < stayEnd) {
      const plan = c.plan || 'monthly';
      const amount = prorate({ plan, ratePaise: c.rate_paise || c.amount_paise, start: c.period_start,
        end: stayEnd, anchor: billingAnchor(resident, plan) });
      insertRow(db, {
        property_id: c.property_id, resident_id: c.resident_id, biz_date: openBizDate(db, c.property_id), ref_date: c.period_start,
        kind: 'CHARGE', category: 'rent', amount_paise: amount, period_start: c.period_start, period_end: stayEnd,
        plan: c.plan, rate_paise: c.rate_paise, origin: 'app', user_id: userId,
        reason: `${c.plan} rent ${c.period_start} → ${stayEnd} (checkout)`,
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Public posting API (call inside the controller's transaction)
// ─────────────────────────────────────────────────────────────────────────────
function tenantRow(db, p, kind) {
  const r = getResident(db, p.propertyId, p.residentId);
  const biz = openBizDate(db, p.propertyId, p.bizDate);
  return {
    property_id: p.propertyId, resident_id: r.id, kind, biz_date: biz, ref_date: p.refDate || biz,
    amount_paise: assertPaise(p.amountPaise), idem_key: p.idemKey || null, reason: p.reason || null,
    user_id: p.userId || null, source_table: p.sourceTable || null, source_id: p.sourceId || null,
  };
}
function modeOf(m) {
  if (!MODES.includes(m)) throw new LedgerError('BAD_MODE', `payment mode must be one of: ${MODES.join(', ')}`);
  return m;
}

const api = {
  /** Something the resident owes (food, electricity, damage, add-on, ...). Not rent — rent comes from billing. */
  charge(p, db = getDb()) {
    const row = tenantRow(db, p, 'CHARGE');
    row.category = String(p.category || 'other').slice(0, 40);
    if (row.category === 'rent') throw new LedgerError('USE_BILLING', 'Rent is charged automatically by billing');
    return insertRow(db, row);
  },

  /** Money received from a resident. Overpayment becomes advance credit. */
  payment(p, db = getDb()) {
    const row = tenantRow(db, p, 'PAYMENT');
    row.mode = modeOf(p.mode);
    row.category = p.category || 'rent';
    return insertRow(db, row);
  },

  /** Discount / write-off. Reason required. Cannot exceed dues. */
  waive(p, db = getDb()) {
    if (!p.reason || !String(p.reason).trim()) throw new LedgerError('REASON_REQUIRED', 'A discount needs a reason');
    const row = tenantRow(db, p, 'WAIVER');
    row.category = String(p.category || 'rent').slice(0, 40);
    return tx(db, () => {
      insertRow(db, row);
      if (balances(db, row.resident_id).dues_paise < 0) {
        throw new LedgerError('WAIVER_EXCEEDS_DUES', 'Discount is more than what the resident owes', 409);
      }
      return row;
    });
  },

  depositIn(p, db = getDb()) {
    const row = tenantRow(db, p, 'DEPOSIT_IN');
    row.mode = modeOf(p.mode);
    return insertRow(db, row);
  },

  /** Use part of the deposit to clear dues. Never more than the dues or the deposit. */
  depositApply(p, db = getDb()) {
    const row = tenantRow(db, p, 'DEPOSIT_APPLY');
    row.reason = row.reason || 'Adjusted against deposit';
    return tx(db, () => {
      insertRow(db, row);
      assertDepositNotNegative(db, row.resident_id);
      if (balances(db, row.resident_id).dues_paise < 0) {
        throw new LedgerError('APPLY_EXCEEDS_DUES', 'Deduction is more than what the resident owes', 409);
      }
      return row;
    });
  },

  depositRefund(p, db = getDb()) {
    const row = tenantRow(db, p, 'DEPOSIT_REFUND');
    row.mode = modeOf(p.mode);
    return tx(db, () => {
      insertRow(db, row);
      assertDepositNotNegative(db, row.resident_id);
      return row;
    });
  },

  expense(p, db = getDb()) {
    const ref = p.refDate && isValidDate(p.refDate) ? p.refDate : istDate();
    return insertRow(db, {
      property_id: p.propertyId, kind: 'EXPENSE', biz_date: openBizDate(db, p.propertyId, ref), ref_date: ref,
      amount_paise: assertPaise(p.amountPaise), mode: modeOf(p.mode), category: String(p.category || 'other').slice(0, 40),
      reason: p.reason || null, user_id: p.userId || null, source_table: p.sourceTable || null, source_id: p.sourceId || null,
    });
  },

  /** Reverse one entry (dated today / next open day). */
  reverse({ propertyId, entryId, reason, userId }, db = getDb()) {
    if (!reason || !String(reason).trim()) throw new LedgerError('REASON_REQUIRED', 'A reversal needs a reason');
    const o = db.prepare('SELECT * FROM ledger_entries WHERE id = ? AND property_id = ?').get(entryId, propertyId);
    if (!o) throw new LedgerError('ENTRY_NOT_FOUND', 'Entry not found', 404);
    return tx(db, () => reverseEntry(db, o, reason, userId));
  },

  /** Reverse every live ledger row created from a source record (e.g. a deleted expense). */
  reverseSource(sourceTable, sourceId, reason, userId, db = getDb()) {
    const rows = db.prepare(`SELECT * FROM ledger_entries WHERE source_table = ? AND source_id = ? AND ${SQL.live}`)
      .all(sourceTable, sourceId);
    return tx(db, () => rows.map((o) => reverseEntry(db, o, reason, userId)));
  },

  balances(residentId, db = getDb()) { return balances(db, residentId); },

  /** Bills unbilled cycles for one resident right now (used at check-in and before showing dues). */
  billNow(residentId, db = getDb()) {
    const r = db.prepare("SELECT * FROM residents WHERE id = ? AND status = 'active'").get(residentId);
    if (!r) return 0;
    return tx(db, () => billResident(db, r, { asOf: istDate() }));
  },

  settleRentAtCheckout(resident, checkoutDate, userId, db = getDb()) {
    return tx(db, () => settleRentAtCheckout(db, resident, checkoutDate, userId));
  },

  /**
   * After a checkout completes:
   *  1. use the deposit to clear anything the resident still owes;
   *  2. pay back `refundPaise`: first from the deposit left, then any advance
   *     rent they over-paid (credit). Refusing more than both together.
   */
  settleDepositAtCheckout({ propertyId, residentId, refundPaise, mode, userId, sourceId }, db = getDb()) {
    return tx(db, () => {
      const out = { applied_paise: 0, refunded_paise: 0, deposit_refunded_paise: 0, credit_refunded_paise: 0 };
      let b = balances(db, residentId);
      const apply = Math.min(b.deposit_paise, Math.max(0, b.dues_paise));
      if (apply > 0) {
        api.depositApply({ propertyId, residentId, amountPaise: apply, userId, reason: 'Deposit adjusted against dues at checkout' }, db);
        out.applied_paise = apply;
        b = balances(db, residentId);
      }
      const refundable = b.deposit_paise + Math.max(0, -b.dues_paise);
      if (refundPaise > refundable) {
        throw new LedgerError('REFUND_TOO_HIGH', `Refund is more than what the resident is owed (₹${(refundable / 100).toFixed(2)})`, 409);
      }
      const fromDeposit = Math.min(refundPaise, b.deposit_paise);
      const fromCredit = refundPaise - fromDeposit;
      const src = sourceId ? { sourceTable: 'payment_ledger', sourceId } : {};
      if (fromDeposit > 0) {
        api.depositRefund({ propertyId, residentId, amountPaise: fromDeposit, mode, userId, ...src }, db);
      }
      if (fromCredit > 0) {
        const r = getResident(db, propertyId, residentId);
        insertRow(db, { property_id: propertyId, resident_id: r.id, kind: 'CREDIT_REFUND', biz_date: openBizDate(db, propertyId),
          ref_date: openBizDate(db, propertyId), amount_paise: fromCredit, mode: modeOf(mode), category: 'rent',
          reason: 'Advance rent refunded at checkout', user_id: userId || null,
          source_table: src.sourceTable || null, source_id: src.sourceId || null });
      }
      out.deposit_refunded_paise = fromDeposit;
      out.credit_refunded_paise = fromCredit;
      out.refunded_paise = refundPaise;
      const after = balances(db, residentId);
      out.dues_after_paise = after.dues_paise;
      out.deposit_left_paise = after.deposit_paise;
      return out;
    });
  },

  /** Cash in the drawer for the unclosed period ending on `date`. */
  cashPosition(propertyId, date, db = getDb()) {
    if (!isValidDate(date)) throw new LedgerError('BAD_DATE', 'date must be YYYY-MM-DD');
    const last = db.prepare('SELECT * FROM day_closes WHERE property_id = ? ORDER BY biz_date DESC LIMIT 1').get(propertyId);
    const closedThrough = last ? last.biz_date : null;
    const from = closedThrough ? addDays(closedThrough, 1) : '0000-01-01';
    const sums = db.prepare(`SELECT ${SQL.cashIn} AS cash_in, ${SQL.cashOut} AS cash_out FROM ledger_entries
      WHERE property_id = ? AND biz_date >= ? AND biz_date <= ?`).get(propertyId, from, date);
    return {
      closed_through: closedThrough,
      is_closed: !!(closedThrough && date <= closedThrough),
      from_date: closedThrough ? from : null,
      opening_cash_paise: last ? last.counted_cash_paise : null,
      cash_in_paise: sums.cash_in,
      cash_out_paise: sums.cash_out,
      expected_cash_paise: (last ? last.counted_cash_paise : 0) + sums.cash_in - sums.cash_out,
    };
  },

  /**
   * Close the cash drawer for `date`. Covers every unclosed day up to and including it,
   * so a skipped day is never lost. After this, nothing can be posted on or before `date`.
   */
  closeDay({ propertyId, date, countedPaise, openingPaise, userId, reconciliationId }, db = getDb()) {
    if (!isValidDate(date)) throw new LedgerError('BAD_DATE', 'date must be YYYY-MM-DD');
    if (date > istDate()) throw new LedgerError('FUTURE_DATE', 'You cannot close a future day', 400);
    if (!Number.isSafeInteger(countedPaise) || countedPaise < 0) throw new LedgerError('BAD_AMOUNT', 'Drawer amount must be 0 or more');
    return tx(db, () => {
      const pos = api.cashPosition(propertyId, date, db);
      if (pos.is_closed) throw new LedgerError('ALREADY_CLOSED', `Cash is already closed up to ${pos.closed_through}`, 409);
      let opening = pos.opening_cash_paise;
      if (opening == null) {
        opening = openingPaise == null ? 0 : openingPaise;
        if (!Number.isSafeInteger(opening) || opening < 0) throw new LedgerError('BAD_AMOUNT', 'Opening cash must be 0 or more');
      }
      const expected = opening + pos.cash_in_paise - pos.cash_out_paise;
      // first close ever covers everything recorded up to `date`
      const first = pos.from_date ? null
        : db.prepare('SELECT MIN(biz_date) d FROM ledger_entries WHERE property_id = ? AND biz_date <= ?').get(propertyId, date).d;
      const rec = {
        property_id: propertyId, biz_date: date, from_date: pos.from_date || (first && first < date ? first : date), opening_cash_paise: opening,
        cash_in_paise: pos.cash_in_paise, cash_out_paise: pos.cash_out_paise, expected_cash_paise: expected,
        counted_cash_paise: countedPaise, variance_paise: countedPaise - expected, reconciliation_id: reconciliationId || null,
        closed_by: userId || null, closed_at: new Date().toISOString(),
      };
      db.prepare(`INSERT INTO day_closes (property_id, biz_date, from_date, opening_cash_paise, cash_in_paise,
        cash_out_paise, expected_cash_paise, counted_cash_paise, variance_paise, reconciliation_id, closed_by, closed_at)
        VALUES (@property_id, @biz_date, @from_date, @opening_cash_paise, @cash_in_paise, @cash_out_paise,
        @expected_cash_paise, @counted_cash_paise, @variance_paise, @reconciliation_id, @closed_by, @closed_at)`).run(rec);
      return rec;
    });
  },

  /**
   * Self-check. [] means everything ties out.
   * Run by the nightly job and shown on the owner dashboard.
   */
  integrityCheck(propertyId, db = getDb()) {
    const problems = [];
    if (!metaGet(db, 'backfill_v1')) problems.push({ check: 'history_not_migrated' });

    db.prepare(`SELECT resident_id, ${SQL.deposit} AS dep FROM ledger_entries WHERE property_id = ? AND resident_id IS NOT NULL
      GROUP BY resident_id HAVING dep < 0`).all(propertyId)
      .forEach((r) => problems.push({ check: 'deposit_negative', resident_id: r.resident_id, deposit_paise: r.dep }));

    const closes = db.prepare('SELECT * FROM day_closes WHERE property_id = ? ORDER BY biz_date').all(propertyId);
    let prev = null;
    for (const c of closes) {
      const s = db.prepare(`SELECT ${SQL.cashIn} ci, ${SQL.cashOut} co FROM ledger_entries
        WHERE property_id = ? AND biz_date >= ? AND biz_date <= ?`).get(propertyId, c.from_date, c.biz_date);
      if (s.ci !== c.cash_in_paise || s.co !== c.cash_out_paise) {
        problems.push({ check: 'closed_day_changed', date: c.biz_date });
      }
      if (prev && c.opening_cash_paise !== prev.counted_cash_paise) problems.push({ check: 'cash_chain_broken', date: c.biz_date });
      prev = c;
    }

    db.prepare(`SELECT a.id a, b.id b, a.resident_id FROM ledger_entries a JOIN ledger_entries b
        ON a.resident_id = b.resident_id AND a.rowid < b.rowid
      WHERE a.property_id = ? AND a.kind='CHARGE' AND b.kind='CHARGE' AND a.category='rent' AND b.category='rent'
        AND a.reversal_of IS NULL AND b.reversal_of IS NULL
        AND a.period_start < b.period_end AND a.period_end > b.period_start
        AND NOT EXISTS (SELECT 1 FROM ledger_entries r WHERE r.reversal_of IN (a.id, b.id))`).all(propertyId)
      .forEach((r) => problems.push({ check: 'rent_billed_twice', resident_id: r.resident_id, entries: [r.a, r.b] }));

    // Every payment_ledger money row must have its ledger twin (and vice versa).
    if (tableExists(db, 'payment_ledger')) {
      db.prepare(`SELECT p.id, p.type FROM payment_ledger p WHERE p.property_id = ? AND p.amount_paise > 0
          AND NOT (p.direction = 'debit' AND p.approval_status IN ('pending','rejected'))
          AND NOT EXISTS (SELECT 1 FROM ledger_entries e WHERE e.source_table = 'payment_ledger' AND e.source_id = p.id)`)
        .all(propertyId).forEach((r) => problems.push({ check: 'payment_missing_in_ledger', payment_id: r.id, type: r.type }));
    }
    if (tableExists(db, 'expenses')) {
      const mism = db.prepare(`SELECT x.id FROM expenses x WHERE x.property_id = ? AND
          (SELECT COALESCE(SUM(amount_paise),0) FROM ledger_entries e WHERE e.source_table='expenses' AND e.source_id = x.id)
          <> x.amount_paise`).all(propertyId);
      mism.forEach((r) => problems.push({ check: 'expense_mismatch', expense_id: r.id }));
    }

    const trig = db.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name IN (${PROTECTION_TRIGGERS.map(() => '?').join(',')})`)
      .get(...PROTECTION_TRIGGERS);
    if (trig.n !== PROTECTION_TRIGGERS.length) problems.push({ check: 'protection_triggers_missing', found: trig.n });

    db.prepare(`SELECT id, full_name FROM residents WHERE property_id = ? AND status = 'active'
        AND COALESCE(rate_paise,0) <= 0 AND COALESCE(monthly_rent_paise,0) <= 0`).all(propertyId)
      .forEach((r) => problems.push({ check: 'active_resident_without_rate', resident_id: r.id, name: r.full_name }));
    return problems;
  },
};

function reverseEntry(db, o, reason, userId) {
  if (o.reversal_of) throw new LedgerError('CANNOT_REVERSE_REVERSAL', 'This entry is itself a reversal', 409);
  if (db.prepare('SELECT 1 FROM ledger_entries WHERE reversal_of = ?').get(o.id)) {
    throw new LedgerError('ALREADY_REVERSED', 'This entry is already reversed', 409);
  }
  const row = insertRow(db, {
    property_id: o.property_id, resident_id: o.resident_id, biz_date: openBizDate(db, o.property_id), ref_date: o.ref_date,
    kind: o.kind, category: o.category, mode: o.mode, amount_paise: -o.amount_paise, period_start: o.period_start,
    period_end: o.period_end, plan: o.plan, rate_paise: o.rate_paise, reversal_of: o.id,
    source_table: o.source_table, source_id: o.source_id, origin: 'app', user_id: userId || null,
    reason: `Reversal: ${String(reason).trim()}`,
  });
  if (o.resident_id) assertDepositNotNegative(db, o.resident_id);
  return row;
}

module.exports = {
  ...api, setupLedger, runBilling, prorate, billingAnchor, nextCycleStart, addMonthsAnchored, openBizDate,
  LedgerError, SQL, MODES, KINDS, PLANS,
};
