'use strict';
// GST (inclusive / exclusive) on rent and items, GST register, guest bill, monthly summary.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { boot } = require('./helpers');
const { istDate, istMonth, addDays } = require('../src/util/time');
const { gstSplit } = require('../src/services/ledger');

const TODAY = istDate();

test('gstSplit maths', () => {
  assert.deepEqual(gstSplit(10000, 500, false), { gross: 10500, tax: 500, taxable: 10000 });
  assert.deepEqual(gstSplit(10500, 500, true), { gross: 10500, tax: 500, taxable: 10000 });
  assert.deepEqual(gstSplit(1000, 1800, false), { gross: 1180, tax: 180, taxable: 1000 });
  assert.deepEqual(gstSplit(999, 0, false), { gross: 999, tax: 0, taxable: 999 });
  const g = gstSplit(3333, 1800, true);           // odd paise still add up exactly
  assert.equal(g.taxable + g.tax, 3333);
  assert.throws(() => gstSplit(100, 700, true));   // 7% is not a GST rate
});

test('GST on rent and items, register, bill, monthly summary', async () => {
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dormbook-g-'));
  const s = await boot({ dbDir, port: 23000 + Math.floor(Math.random() * 1000) });
  const { call } = s;
  try {
    let r = await call('POST', '/auth/register', { business_name: 'A&P Infotech', owner_name: 'Amit', mobile: '9876500003',
      password: 'Passw0rd!23', pg_name: 'Sunrise Dorm', city: 'Delhi' });
    s.setToken(r.body.token);

    // GST needs a GSTIN
    r = await call('PATCH', '/properties/settings', { gst_enabled: true });
    assert.equal(r.status, 400, 'no GSTIN → cannot switch GST on');
    r = await call('PATCH', '/properties/settings', { gst_enabled: true, gstin: '07ABCDE1234F1Z5', rent_gst_rate_bp: 700 });
    assert.equal(r.status, 400, '7% is not allowed');
    r = await call('PATCH', '/properties/settings', { gst_enabled: true, gstin: '07ABCDE1234F1Z5', rent_gst_rate_bp: 500, rent_gst_inclusive: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await call('GET', '/properties/profile');
    assert.equal(r.body.gst_enabled, true); assert.equal(r.body.rent_gst_rate_bp, 500); assert.equal(r.body.rent_gst_inclusive, false);

    r = await call('POST', '/floors', { floor_number: 0, label: 'Ground' });
    await call('POST', `/floors/${r.body.id}/bunkers`, { bunkers: 2, beds_per_bunker: 2, daily_rate_paise: 100000 });
    const beds = (await call('GET', '/beds?status=available')).body;

    // Daily guest: ₹1,000/night + 5% on top → ₹1,050 billed for the first night
    r = await call('POST', '/residents', { full_name: 'Ravi', mobile: '9000000031', bed_id: beds[0].id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 3), id_consent: true, id_type: 'passport', id_number: 'K1234567', rate_type: 'daily', rate_paise: 100000 });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const ravi = r.body.resident.id;
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.balance.dues_paise, 105000, 'rent + 5% GST');

    // Monthly guest: ₹30,000 + 5%; leaves after 1 day → month reversed, 1 day re-billed with GST
    r = await call('POST', '/residents', { full_name: 'Neha', mobile: '9000000032', bed_id: beds[1].id, check_in_date: TODAY,
      expected_checkout: addDays(TODAY, 60), id_consent: true, id_type: 'passport', id_number: 'K7654321', rate_type: 'monthly', rate_paise: 3000000 });
    const neha = r.body.resident.id;
    r = await call('GET', `/residents/${neha}`);
    const nehaFirst = r.body.balance.dues_paise;   // first stretch till rent-due day, + 5%
    assert.ok(nehaFirst > 0);

    // Items: Tea ₹10 + 18% on top; Water ₹21 with 5% included
    r = await call('POST', '/addons/catalog', { name: 'Tea', category: 'Food & drinks', default_price_paise: 1000, gst_rate_bp: 1800, gst_inclusive: false });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const tea = r.body;
    assert.equal(tea.gst_rate_bp, 1800); assert.equal(tea.gst_inclusive, 0);
    r = await call('POST', '/addons/catalog', { name: 'Water', default_price_paise: 2100, gst_rate_bp: 500 });
    const water = r.body;
    r = await call('POST', '/addons/catalog', { name: 'Juice', default_price_paise: 2100, gst_rate_bp: 300 });
    assert.equal(r.status, 400, 'bad GST rate on an item');

    r = await call('POST', `/residents/${ravi}/addons`, { items: [{ catalog_item_id: tea.id, quantity: 2 }, { catalog_item_id: water.id, quantity: 1 }], billing_mode: 'monthly_bill' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.total_paise, 2360 + 2100);
    assert.equal(r.body.gst_paise, 360 + 100);
    r = await call('GET', `/residents/${ravi}`);
    assert.equal(r.body.balance.dues_paise, 105000 + 2360 + 2100);

    // Checkout Neha after one day
    r = await call('POST', `/residents/${neha}/checkout`, { checkout_date: addDays(TODAY, 1) });
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));

    // GST register adds up: taxable + CGST + SGST = total, and reversals cancel
    r = await call('GET', `/reports/registers/gst?from=${TODAY}&to=${addDays(TODAY, 1)}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const t = r.body.totals;
    assert.equal(t.taxable + t.cgst + t.sgst, t.amount);
    const nehaRows = r.body.rows.filter((x) => x.guest === 'Neha');
    const nehaTotal = nehaRows.reduce((a, x) => a + x.amount, 0);
    const nehaGst = nehaRows.reduce((a, x) => a + x.cgst + x.sgst, 0);
    assert.ok(nehaTotal > 0 && nehaTotal <= nehaFirst, 'only one day stays billed');
    assert.equal(nehaGst, Math.round((nehaTotal - nehaGst) * 0.05), '5% on the one day that stayed');

    // Guest bill
    r = await call('GET', `/residents/${ravi}/bill`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.title, 'Tax Invoice');
    assert.match(r.body.bill_no, /^B-\d{5}$/);
    assert.equal(r.body.totals.amount, 105000 + 2360 + 2100);
    assert.equal(r.body.totals.gst, 5000 + 360 + 100);
    assert.equal(r.body.totals.cgst + r.body.totals.sgst, r.body.totals.gst);
    assert.equal(r.body.balance, 105000 + 2360 + 2100);
    r = await call('GET', `/residents/${neha}/bill`);
    assert.equal(r.body.lines.filter((l) => l.description.startsWith('Room rent')).length, 1, 'reversed month hidden, one day shown');

    // Items bought while GST is OFF carry no GST
    r = await call('PATCH', '/properties/settings', { gst_enabled: false });
    assert.equal(r.status, 200);
    r = await call('POST', `/residents/${ravi}/addons`, { items: [{ catalog_item_id: tea.id, quantity: 1 }], billing_mode: 'monthly_bill' });
    assert.equal(r.body.total_paise, 1000); assert.equal(r.body.gst_paise, 0);

    // Monthly summary
    r = await call('GET', `/reports/monthly?month=${istMonth()}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.trend.length, 6);
    assert.ok(r.body.kpis.billed > 0);
    assert.ok(r.body.kpis.gst_billed > 0);
    r = await call('GET', '/reports/monthly?month=2026-13');
    assert.equal(r.status, 400);
  } finally {
    s.stop();
  }
});
