'use strict';
// End-to-end: boots the REAL server (src/server.js) on a fresh temp database and
// drives it over HTTP like the app does.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { istDate, addDays } = require('../src/util/time');

const TODAY = istDate();

const { boot } = require('./helpers');

test('full day of operations over HTTP on a fresh database', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-'));
  const s = await boot({ dbDir, port: 18000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    // signup
    let r = await call('POST', '/auth/register', { business_name: 'Test PG', owner_name: 'Amit', mobile: '9876543210',
      email: 'a@t.in', password: 'Passw0rd!23', pg_name: 'Test PG', city: '' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    s.setToken(r.body.token);
    const ownerToken = r.body.token;
    assert.ok(r.body.user.permissions.includes('staff'), 'owner has every permission');

    // every feature that used to 500 on a fresh DB now works
    for (const p of ['/reconciliation/cash', '/addons/catalog', '/bookings', '/feedback', '/dashboard/summary',
      '/reports/daily/snapshot', '/reports/daily/dues', '/reports/daily/cash-book', '/reports/daily/bed-map',
      '/reports/daily/movements', '/ledger/integrity', '/reports/summary']) {
      r = await call('GET', p);
      assert.equal(r.status, 200, `${p} -> ${r.status} ${JSON.stringify(r.body)}`);
    }

    // setup: floor, room, 2 beds
    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const floorId = r.body.id;
    r = await call('POST', '/rooms', { floor_id: floorId, room_number: '101' }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const roomId = r.body.id;
    r = await call('POST', '/beds', { room_id: roomId, bed_label: 'A', daily_rate_paise: 30000 }); assert.equal(r.status, 201, JSON.stringify(r.body));
    const bedA = r.body.id;
    r = await call('POST', '/beds', { room_id: roomId, bed_label: 'B', daily_rate_paise: 30000 });
    const bedB = r.body.id;

    // check-in: monthly ₹9,000, deposit ₹10,000 cash, advance ₹4,000 UPI
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000001', bed_id: bedA, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 200), id_consent: true, id_type: 'driving_licence', id_number: 'DL-0420110149646', rate_type: 'monthly', rate_paise: 900000,
      deposit_paise: 1000000, amount_paid_paise: 400000, payment_mode: 'cash',
      rent_due_day: Number(TODAY.slice(8)) <= 28 ? Number(TODAY.slice(8)) : 1 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;

    r = await call('GET', `/residents/${ravi}`);
    const firstRent = r.body.balance.dues_paise + 400000;
    assert.ok(firstRent > 0 && firstRent <= 900000, `first (pro-rata) rent charged at check-in: ${firstRent}`);
    assert.equal(r.body.balance.deposit_paise, 1000000);

    // daily guest, 2 nights at ₹600
    r = await call('POST', '/residents', { full_name: 'Guest', mobile: '9000000002', bed_id: bedB, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 2), id_consent: true, id_type: 'passport', id_number: 'k1234567', rate_type: 'daily', rate_paise: 60000 });
    const guest = r.body.resident.id;

    // payment + double-click guard + retry with same key
    const key = 'k-' + Date.now();
    r = await call('POST', '/payments', { resident_id: ravi, amount_paise: 100000, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': key });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/payments', { resident_id: ravi, amount_paise: 100000, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': key });
    assert.equal(r.status, 200); assert.equal(r.body.duplicate, true);
    r = await call('POST', '/payments', { resident_id: ravi, amount_paise: 100000, type: 'rent', payment_mode: 'cash' }, { 'Idempotency-Key': key + 'x' });
    assert.equal(r.status, 409); assert.equal(r.body.code, 'POSSIBLE_DUPLICATE');
    r = await call('POST', '/payments', { resident_id: ravi, amount_paise: '12abc', type: 'rent', payment_mode: 'cash' });
    assert.equal(r.status, 400);

    // add-on billed to next bill → shows in dues, no cash
    r = await call('POST', `/residents/${ravi}/addons`, { name: 'Laundry', amount_paise: 20000, billing_mode: 'monthly_bill' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', `/residents/${ravi}/addons`, { name: 'x', amount_paise: 1, billing_mode: 'weird' });
    assert.equal(r.status, 400);

    // cash expense
    r = await call('POST', '/expenses', { category: 'grocery', amount_paise: 50000, expense_date: TODAY, payment_mode: 'cash' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/expenses', { category: 'grocery', amount_paise: 100, expense_date: '2026-02-30', payment_mode: 'cash' });
    assert.equal(r.status, 400);

    // dashboard: revenue excludes the deposit
    r = await call('GET', '/dashboard/summary');
    assert.equal(r.body.today_collection_paise, 1000000 + 400000 + 100000);
    assert.equal(r.body.monthly_revenue_paise, 400000 + 100000);
    assert.equal(r.body.deposits_held_paise, 1000000);

    // cash close: expected = deposit 10k + advance 4k + payment 1k (cash) − grocery 500
    r = await call('GET', `/reconciliation/cash/preview?date=${TODAY}`);
    assert.equal(r.body.expected_cash_paise, 1000000 + 400000 + 100000 - 50000);
    r = await call('POST', '/reconciliation/cash', { date: TODAY, drawer_amount_paise: 1450000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.delta_paise, 0); assert.equal(r.body.is_discrepancy, false);
    r = await call('POST', '/reconciliation/cash', { date: TODAY, drawer_amount_paise: 1450000 });
    assert.equal(r.status, 409);

    // a payment after the close lands on tomorrow, not in the closed day
    r = await call('POST', '/payments', { resident_id: guest, amount_paise: 120000, type: 'rent', payment_mode: 'upi' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('GET', `/reports/daily/cash-book?date=${addDays(TODAY, 1)}`);
    assert.equal(r.body.entries.length, 1);

    // expense edit/delete keep the ledger in step
    const exp = (await call('GET', `/expenses?from=${TODAY}`)).body[0];
    r = await call('PATCH', `/expenses/${exp.id}`, { amount_paise: 60000 }); assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('DELETE', `/expenses/${exp.id}`); assert.equal(r.status, 200);

    // dues report + statement + discount
    const expectedDues = firstRent - 400000 - 100000 + 20000;
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.balance.dues_paise, expectedDues);
    r = await call('GET', '/reports/daily/dues');
    const raviDue = r.body.rows.find((x) => x.resident_id === ravi);
    if (expectedDues > 0) {
      assert.ok(raviDue && raviDue.dues_paise === expectedDues, JSON.stringify(r.body));
      assert.equal(raviDue.days_overdue, 0);
      r = await call('POST', `/residents/${ravi}/discount`, { amount_paise: 10000, reason: 'Fan broken' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    } else {
      assert.ok(!raviDue);
    }
    r = await call('POST', `/residents/${ravi}/discount`, { amount_paise: 99999999, reason: 'too much' });
    assert.equal(r.status, 409);
    r = await call('GET', `/residents/${ravi}/statement`);
    assert.equal(r.body.entries.at(-1).dues_after_paise, r.body.balance.dues_paise);

    // checkout guest: 1 night charged (₹600), 2 nights paid (₹1200) → ₹600 advance to refund
    r = await call('GET', `/residents/${guest}/checkout-preview?date=${addDays(TODAY, 1)}`);
    assert.equal(r.body.refund_paise, 60000, JSON.stringify(r.body));
    assert.equal(r.body.to_collect_paise, 0);
    r = await call('POST', `/residents/${guest}/checkout`, { checkout_date: addDays(TODAY, 1), deposit_refund_paise: 60001 });
    assert.equal(r.status, 409, 'cannot refund more than owed');
    r = await call('POST', `/residents/${guest}/checkout`, { checkout_date: addDays(TODAY, 1), deposit_refund_paise: 60000 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settlement.credit_refunded_paise, 60000);
    assert.equal(r.body.settlement.dues_after_paise, 0);

    // a reception user with limited permissions
    r = await call('POST', '/staff', { name: 'Sita', mobile: '9111111111', role: 'reception', password: 'Recept!on123',
      permissions: ['checkin', 'checkout', 'payments', 'cash_close', 'reports_daily'] });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    r = await call('POST', '/auth/login', { mobile: '9111111111', password: 'Recept!on123' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.user.permissions.sort(), ['cash_close', 'checkin', 'checkout', 'payments', 'reports_daily']);
    s.setToken(r.body.token);
    for (const [m, p, b] of [['GET', '/reports/registers/pnl'], ['POST', '/expenses', { category: 'x', amount_paise: 100, expense_date: TODAY }],
      ['GET', '/staff'], ['POST', '/floors', { floor_number: 5, label: 'Five' }], ['GET', '/properties/settings']]) {
      r = await call(m, p, b);
      assert.equal(r.status, 403, `${m} ${p} should be forbidden, got ${r.status}`);
      assert.equal(r.body.code, 'NO_PERMISSION');
    }
    r = await call('GET', '/reports/registers');
    assert.deepEqual(r.body.map((x) => x.id).sort(), ['cash', 'guests', 'occupancy']);
    r = await call('POST', '/staff', { name: 'X', mobile: '9222222222', role: 'reception', password: 'Passw0rd!23' });
    assert.equal(r.status, 403, 'reception cannot add users');

    // checkout preview == real checkout (reception: refund needs owner approval)
    r = await call('GET', `/residents/${ravi}/checkout-preview?date=${addDays(TODAY, 1)}&extra_paise=30000`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pv = r.body;
    assert.equal(pv.needs_approval, pv.refund_paise > 0);
    r = await call('POST', `/residents/${ravi}/checkout`, { checkout_date: addDays(TODAY, 1), deposit_refund_paise: pv.refund_paise,
      extra_charges_paise: 30000, extra_charges_note: 'Broken chair', collect_paise: pv.to_collect_paise });
    assert.equal(r.status, pv.needs_approval ? 202 : 200, JSON.stringify(r.body));

    s.setToken(ownerToken);
    if (pv.needs_approval) {
      r = await call('GET', '/payments/pending-approvals');
      const pend = r.body.find((p) => p.resident_id === ravi);
      r = await call('POST', `/payments/${pend.id}/approve`, { decision: 'approved' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      r = await call('POST', `/payments/${pend.id}/approve`, { decision: 'approved' });
      assert.equal(r.status, 404);
    }
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.status, 'checked_out', 'approving the refund completes the checkout');
    assert.deepEqual(r.body.balance, { dues_paise: 0, deposit_paise: 0 }, 'preview numbers settle the account exactly');
    assert.equal(r.body.id_display, 'Driving Licence ••••9646');

    // everything ties out
    r = await call('GET', '/ledger/integrity');
    assert.deepEqual(r.body, { ok: true, problems: [] });
    r = await call('GET', '/reports/summary');
    assert.equal(r.status, 200);
    assert.ok(!r.body.revenue_by_type.find((x) => x.type === 'deposit'), 'deposits are not revenue');
    r = await call('GET', '/reports/export?format=csv'); assert.equal(r.status, 200);

    // the server never threw an unexpected error, and never logged a password
    const all = s.logs.join('');
    assert.ok(!/\[ERROR\]|UNCAUGHT|UNHANDLED/.test(all), all.slice(-2000));
    assert.ok(!all.includes('Sup3r!secret'), 'password must not be logged');
  } finally {
    s.stop();
  }
});

test('boots on a database created by the old (pre-19-Sep) schema and signup works', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-old-'));
  const db = new Database(path.join(dbDir, 'dormbook.db'));
  db.exec(fs.readFileSync(path.join(__dirname, 'fixtures', 'schema-before-19sep.sql'), 'utf8'));
  db.close();
  const s = await boot({ dbDir, port: 19000 + Math.floor(Math.random() * 1000) });
  try {
    const r = await s.call('POST', '/auth/register', { business_name: 'Old PG', owner_name: 'Amit', mobile: '9876500000',
      password: 'Passw0rd!23', pg_name: 'Old PG' });
    assert.equal(r.status, 201, JSON.stringify(r.body) + s.logs.join(''));
    s.setToken(r.body.token);
    for (const p of ['/dashboard/summary', '/reports/daily/snapshot', '/ledger/integrity']) {
      const x = await s.call('GET', p);
      assert.equal(x.status, 200, p + JSON.stringify(x.body));
    }
    assert.ok(!/\[ERROR\]|UNCAUGHT/.test(s.logs.join('')), s.logs.join(''));
  } finally {
    s.stop();
  }
});
