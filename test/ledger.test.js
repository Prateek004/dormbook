'use strict';
// Unit tests for the money ledger (in-memory SQLite, real schema).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { setDb } = require('../src/db/connection');
const L = require('../src/services/ledger');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();
const err = (code) => (e) => { assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`); return true; };

function freshDb(schemaFile = path.join(__dirname, '..', 'src', 'db', 'schema.sql')) {
  const db = new Database(':memory:');
  db.exec(fs.readFileSync(schemaFile, 'utf8'));
  setDb(db);
  db.exec(`INSERT INTO accounts (id, business_name, plan, trial_ends_at) VALUES ('a1','PG','trial','2099-01-01');
    INSERT INTO properties (id, account_id, name) VALUES ('p1','a1','PG One'), ('p2','a1','PG Two');
    INSERT INTO users (id, account_id, property_id, name, mobile, password_hash, role) VALUES ('u1','a1','p1','Owner','9000000000','x','owner');
    INSERT INTO floors (id, property_id, floor_number, label) VALUES ('f1','p1',0,'Ground');
    INSERT INTO rooms (id, floor_id, property_id, room_number) VALUES ('r1','f1','p1','101');
    INSERT INTO beds (id, room_id, property_id, bed_label, status) VALUES ('b1','r1','p1','A','occupied'),('b2','r1','p1','B','occupied');`);
  L.setupLedger(db);
  return db;
}
function addResident(db, id, o) {
  db.prepare(`INSERT INTO residents (id, property_id, bed_id, full_name, mobile, check_in_date, expected_checkout,
      rent_due_day, status, monthly_rent_paise, rate_type, rate_paise, deposit_paise, checkin_by)
    VALUES (@id, @property_id, @bed_id, @name, '9000000001', @check_in_date, @expected_checkout, @rent_due_day, 'active',
      @rate_paise, @rate_type, @rate_paise, 0, 'u1')`).run({ id, property_id: 'p1', bed_id: 'b1', name: id, rent_due_day: 1,
    rate_type: 'monthly', expected_checkout: addDays(TODAY, 400), ...o });
  return db.prepare('SELECT * FROM residents WHERE id = ?').get(id);
}
const rentRows = (db, id) => db.prepare(`SELECT period_start, period_end, amount_paise FROM ledger_entries
  WHERE resident_id = ? AND kind='CHARGE' AND category='rent' AND ${L.SQL.live} ORDER BY period_start`).all(id);

test('proration: exact, one function', () => {
  assert.equal(L.prorate({ plan: 'daily', ratePaise: 50000, start: '2026-09-01', end: '2026-09-04' }), 150000);
  assert.equal(L.prorate({ plan: 'weekly', ratePaise: 210000, start: '2026-09-01', end: '2026-09-11' }), 300000);
  assert.equal(L.prorate({ plan: 'monthly', ratePaise: 800000, start: '2026-01-31', end: '2026-02-28' }), 800000);
  // join on 15 Sep, rent due on the 1st: 16 of September's 30 days
  assert.equal(L.prorate({ plan: 'monthly', ratePaise: 900000, start: '2026-09-15', end: '2026-10-01', anchor: '2026-10-01' }), 480000);
  assert.throws(() => L.prorate({ plan: 'monthly', ratePaise: 1, start: '2026-09-10', end: '2026-09-10' }), err('BAD_PERIOD'));
  assert.throws(() => L.prorate({ plan: 'monthly', ratePaise: 1, start: '2026-02-30', end: '2026-03-10' }), err('BAD_DATE'));
});

test('billing: charges started cycles once, idempotent, respects due day and expected checkout', () => {
  const db = freshDb();
  // Monthly, joined 70 days ago, rent due on the 1st
  const ci = addDays(TODAY, -70);
  const r = addResident(db, 'm1', { check_in_date: ci, rate_paise: 900000 });
  L.billNow(r.id); L.billNow(r.id); L.runBilling({ db });
  const rows = rentRows(db, r.id);
  assert.equal(rows[0].period_start, ci);
  assert.equal(rows[0].period_end.slice(8), '01');                 // first stretch ends on the due day
  for (let i = 1; i < rows.length; i++) assert.equal(rows[i].period_start, rows[i - 1].period_end); // no gaps, no overlap
  assert.ok(rows.at(-1).period_start <= TODAY && rows.at(-1).period_end > TODAY);
  rows.slice(1).forEach((x) => assert.equal(x.amount_paise, 900000)); // full months after the first

  // Daily guest for 3 nights: charged 3 nights, never a month
  const d = addResident(db, 'd1', { check_in_date: addDays(TODAY, -2), expected_checkout: addDays(TODAY, 1),
    rate_type: 'daily', rate_paise: 60000, bed_id: 'b2' });
  L.billNow(d.id);
  assert.equal(L.balances(d.id).dues_paise, 180000);
  assert.deepEqual(L.integrityCheck('p1'), []);
});

test('checkout settles rent to the exact day and deposit to dues', () => {
  const db = freshDb();
  const ci = addDays(TODAY, -10);
  const r = addResident(db, 'c1', { check_in_date: ci, rate_type: 'monthly', rate_paise: 300000, rent_due_day: Number(ci.slice(8)) > 28 ? 1 : Number(ci.slice(8)) });
  L.depositIn({ propertyId: 'p1', residentId: r.id, amountPaise: 500000, mode: 'cash', userId: 'u1' });
  L.billNow(r.id);
  const before = L.balances(r.id).dues_paise;
  assert.ok(before > 0);
  L.settleRentAtCheckout(db.prepare('SELECT * FROM residents WHERE id=?').get(r.id), TODAY, 'u1');
  const rows = rentRows(db, r.id);
  assert.equal(rows.at(-1).period_end, TODAY);
  const rentOwed = rows.reduce((s, x) => s + x.amount_paise, 0);
  assert.ok(rentOwed < 300000 && rentOwed > 0, `10 days of a month: ${rentOwed}`);
  const out = L.settleDepositAtCheckout({ propertyId: 'p1', residentId: r.id, refundPaise: 100000, mode: 'cash', userId: 'u1' });
  assert.equal(out.refunded_paise, 100000);
  assert.equal(out.applied_paise, rentOwed);
  assert.equal(out.dues_after_paise, 0);
  assert.equal(out.deposit_left_paise, 500000 - 100000 - rentOwed);
  assert.throws(() => L.depositRefund({ propertyId: 'p1', residentId: r.id, amountPaise: 99999999, mode: 'cash' }), err('DEPOSIT_INSUFFICIENT'));
  assert.deepEqual(L.integrityCheck('p1'), []);
});

test('guards: immutability, isolation, bad input, waiver limits', () => {
  const db = freshDb();
  const r = addResident(db, 'g1', { check_in_date: TODAY, rate_paise: 100000 });
  const p = L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 1000, mode: 'cash' });
  assert.throws(() => db.prepare('UPDATE ledger_entries SET amount_paise = 1 WHERE id = ?').run(p.id), /LEDGER_IMMUTABLE/);
  assert.throws(() => db.prepare('DELETE FROM ledger_entries').run(), /LEDGER_IMMUTABLE/);
  assert.throws(() => L.payment({ propertyId: 'p2', residentId: r.id, amountPaise: 1, mode: 'cash' }), err('RESIDENT_NOT_FOUND'));
  assert.throws(() => L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 10.5, mode: 'cash' }), err('BAD_AMOUNT'));
  assert.throws(() => L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 100, mode: 'bitcoin' }), err('BAD_MODE'));
  assert.throws(() => L.waive({ propertyId: 'p1', residentId: r.id, amountPaise: 100 }), err('REASON_REQUIRED'));
  L.billNow(r.id);
  const dues = L.balances(r.id).dues_paise;
  assert.throws(() => L.waive({ propertyId: 'p1', residentId: r.id, amountPaise: dues + 1, reason: 'x' }), err('WAIVER_EXCEEDS_DUES'));
  assert.equal(L.balances(r.id).dues_paise, dues, 'failed waiver left no trace');
  L.reverse({ propertyId: 'p1', entryId: p.id, reason: 'typo' });
  assert.throws(() => L.reverse({ propertyId: 'p1', entryId: p.id, reason: 'again' }), err('ALREADY_REVERSED'));
});

test('cash close: expenses count, days lock, late entries roll to next day, skipped days included', () => {
  const db = freshDb();
  const r = addResident(db, 'k1', { check_in_date: addDays(TODAY, -5), rate_paise: 100000 });
  const y = addDays(TODAY, -1);
  L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 500000, mode: 'cash', bizDate: addDays(TODAY, -2) });
  L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 200000, mode: 'upi', bizDate: y });
  L.expense({ propertyId: 'p1', amountPaise: 30000, mode: 'cash', category: 'grocery', refDate: y });
  // closing yesterday covers the unclosed day before it too
  const c = L.closeDay({ propertyId: 'p1', date: y, countedPaise: 470000, openingPaise: 0 });
  assert.equal(c.expected_cash_paise, 470000);
  assert.equal(c.variance_paise, 0);
  // back-dating into a closed day is impossible; ledger moves it to the next open day
  const late = L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 1000, mode: 'cash', bizDate: addDays(TODAY, -2) });
  assert.equal(late.biz_date, TODAY);
  assert.throws(() => L.closeDay({ propertyId: 'p1', date: y, countedPaise: 0 }), err('ALREADY_CLOSED'));
  assert.throws(() => L.closeDay({ propertyId: 'p1', date: addDays(TODAY, 1), countedPaise: 0 }), err('FUTURE_DATE'));
  // close today: opening = yesterday's counted cash
  const c2 = L.closeDay({ propertyId: 'p1', date: TODAY, countedPaise: 470000 + 1000 - 5000 });
  assert.equal(c2.opening_cash_paise, 470000);
  assert.equal(c2.variance_paise, -5000);
  // after today's close, new money goes to tomorrow — never lost, never breaks a closed day
  const after = L.payment({ propertyId: 'p1', residentId: r.id, amountPaise: 700, mode: 'cash' });
  assert.equal(after.biz_date, addDays(TODAY, 1));
  assert.deepEqual(L.integrityCheck('p1'), []);
});

test('migration: old-schema database with history is copied into the ledger exactly once', () => {
  // schema.sql as it was before the 19-Sep refactor (what older production databases have)
  const oldSchema = fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-before-19sep.sql'), 'utf8');
  const db = new Database(':memory:');
  db.exec(oldSchema);
  setDb(db);
  const ci = addDays(TODAY, -40);
  db.exec(`INSERT INTO accounts (id, business_name, owner_name, owner_mobile, trial_ends_at) VALUES ('a1','PG','Amit','9','2099-01-01');
    INSERT INTO properties (id, account_id, name, owner_id) VALUES ('p1','a1','PG','u1');
    INSERT INTO users (id, account_id, property_id, name, mobile, password_hash, role) VALUES ('u1','a1','p1','O','9','x','owner');
    INSERT INTO residents (id, property_id, full_name, mobile, check_in_date, expected_checkout, status, monthly_rent_paise,
      rate_type, rate_paise, deposit_paise, checkin_by, rent_due_day)
      VALUES ('r1','p1','Ravi','9','${ci}','${addDays(TODAY, 300)}','active',600000,'monthly',600000,1000000,'u1',1);
    INSERT INTO payment_ledger (id, property_id, resident_id, amount_paise, direction, type, payment_mode, paid_at, recorded_by, created_at)
      VALUES ('pl1','p1','r1',1000000,'credit','deposit','cash','${ci}T05:00:00.000Z','u1','${ci}T05:00:00.000Z'),
             ('pl2','p1','r1',600000,'credit','advance','upi','${ci}T05:00:00.000Z','u1','${ci}T05:00:00.000Z'),
             ('pl0','p1','r1',0,'credit','rent','cash','${ci}T05:00:00.000Z','u1','${ci}T05:00:00.000Z');
    INSERT INTO expenses (id, property_id, category, amount_paise, expense_date, payment_mode, recorded_by)
      VALUES ('e1','p1','grocery',25000,'${addDays(TODAY, -3)}','cash','u1');`);
  L.setupLedger(db);
  L.setupLedger(db); // second boot: no duplicates
  const b = L.balances('r1');
  assert.equal(b.deposit_paise, 1000000);
  assert.ok(b.dues_paise > 0, 'rent since check-in minus advance');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE kind='EXPENSE'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger_entries WHERE source_id='pl2'").get().n, 1);
  assert.deepEqual(L.integrityCheck('p1'), []);
});
